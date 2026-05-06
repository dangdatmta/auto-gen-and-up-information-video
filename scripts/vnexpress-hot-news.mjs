import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { uploadToPlatforms, writeCaption } from "./upload-platforms.mjs";

const RSS_URL = "https://vnexpress.net/rss/tin-noi-bat.rss";
// Đọc từ env var, fallback về assets/background01.mp3 trong thư mục repo
const BACKGROUND_AUDIO =
  process.env.BACKGROUND_AUDIO_PATH ||
  path.resolve("assets", "background01.mp3");
const WATERMARK = "@tintucchatluong";
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MIN_NEWS_COUNT = 3;
const MAX_NEWS_COUNT = 5;
const CANDIDATE_COUNT = 12;
const TOP_STORY_SECONDS = 10;
const STORY_SECONDS = 7;
const SHORT_STORY_SECONDS = 5;
const OUTRO_SECONDS = 2;
const DEDUPE_STATE = process.env.VNEXPRESS_DEDUPE_STATE || path.resolve(".vnexpress-state", "seen-news.json");

const args = new Set(process.argv.slice(2));
const slotArg = valueAfter("--slot");
const skipRender = args.has("--skip-render");
const uploadRequested = args.has("--upload");
const dryRunUpload = args.has("--dry-run-upload");

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function bangkokParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function currentSlot() {
  if (slotArg) return slotArg;
  const now = bangkokParts();
  return `${String(now.hour).padStart(2, "0")}00`;
}

/**
 * Trả về khoảng thời gian [from, to] (ms epoch) mà bài viết phải có pubDate nằm trong đó.
 * Với lịch chạy 2 giờ/lần, mỗi slot HHMM bao phủ đúng 2 giờ trước mốc slot đó.
 * Nếu slot không khớp HHMM thì trả về null (không lọc).
 */
function slotTimeWindow(slot) {
  const nowMs = Date.now();
  // Lấy mốc đầu ngày Bangkok theo UTC offset +7
  const bangkokOffset = 7 * 60 * 60 * 1000;
  const todayMidnightBangkok = new Date(
    Math.floor((nowMs + bangkokOffset) / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000) - bangkokOffset
  );

  const h = (hours, minutes = 0) => todayMidnightBangkok.getTime() + (hours * 60 + minutes) * 60 * 1000;

  const match = String(slot || "").match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const to = h(hour, minute);
  return { from: to - 2 * 60 * 60 * 1000, to };
}

function decodeEntities(value = "") {
  return value
    .replaceAll("<![CDATA[", "")
    .replaceAll("]]>", "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDedupeKey(value = "") {
  return stripHtml(value)
    .toLowerCase()
    .normalize("NFC")
    .replace(/^https?:\/\/(www\.)?/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/[^\p{L}\p{N}./-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readDedupeState(statePath, date) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const day = parsed.days?.[date] || {};
    return {
      version: 1,
      days: {
        [date]: {
          links: Array.isArray(day.links) ? day.links : [],
          titles: Array.isArray(day.titles) ? day.titles : [],
          items: Array.isArray(day.items) ? day.items : []
        }
      }
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[dedupe] Không đọc được state ${statePath}: ${error.message}. Tạo state mới.`);
    }
    return { version: 1, days: { [date]: { links: [], titles: [], items: [] } } };
  }
}

function filterSeenItems(items, state, date) {
  const day = state.days?.[date] || {};
  const seenLinks = new Set((day.links || []).map(normalizeDedupeKey).filter(Boolean));
  const seenTitles = new Set((day.titles || []).map(normalizeDedupeKey).filter(Boolean));
  const fresh = items.filter((item) => {
    const linkKey = normalizeDedupeKey(item.link);
    const titleKey = normalizeDedupeKey(item.title || item.hook);
    return !(linkKey && seenLinks.has(linkKey)) && !(titleKey && seenTitles.has(titleKey));
  });
  return fresh.map((item, index) => ({ ...item, index: index + 1 }));
}

async function writeDedupeState(statePath, date, slot, selectedItems) {
  const state = await readDedupeState(statePath, date);
  const day = state.days[date] || { links: [], titles: [], items: [] };
  const links = new Set((day.links || []).map(normalizeDedupeKey).filter(Boolean));
  const titles = new Set((day.titles || []).map(normalizeDedupeKey).filter(Boolean));
  const existingItems = Array.isArray(day.items) ? day.items : [];
  const addedItems = [];

  for (const item of selectedItems) {
    const linkKey = normalizeDedupeKey(item.link);
    const titleKey = normalizeDedupeKey(item.title || item.hook);
    if (linkKey) links.add(linkKey);
    if (titleKey) titles.add(titleKey);
    addedItems.push({
      slot,
      link: item.link,
      title: item.title,
      savedAt: new Date().toISOString()
    });
  }

  const nextState = {
    version: 1,
    updatedAt: new Date().toISOString(),
    days: {
      [date]: {
        links: [...links],
        titles: [...titles],
        items: [...existingItems, ...addedItems]
      }
    }
  };

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(nextState, null, 2), "utf8");
  console.log(`[dedupe] Đã lưu ${selectedItems.length} tin vào ${statePath} cho ngày ${date}.`);
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return decodeEntities(match?.[1] ?? "");
}

function attrTag(block, name, attr) {
  const match = block.match(new RegExp(`<${name}[^>]*\\s${attr}=["']([^"']+)["'][^>]*\\/?>`, "i"));
  return decodeEntities(match?.[1] ?? "");
}

function extractImageFromHtml(html = "") {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og?.[1]) return decodeEntities(og[1]);
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return img?.[1] ? decodeEntities(img[1]) : "";
}

function extractFirstHtml(html = "", patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return stripHtml(match[1]);
  }
  return "";
}

function extractArticleDetails(html = "") {
  const title = extractFirstHtml(html, [
    /<h1[^>]*class=["'][^"']*title-detail[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
  ]);
  const lead = extractFirstHtml(html, [
    /<p[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<p[^>]*class=["'][^"']*lead[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<h2[^>]*class=["'][^"']*sapo[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
  ]);
  return { title, lead, imageUrl: extractImageFromHtml(html) };
}

/**
 * Parse RSS XML và lọc theo khoảng pubDate của slot.
 * @param {string} xml
 * @param {{ from: number, to: number } | null} window - epoch ms, hoặc null để không lọc
 */
function parseItems(xml, window = null) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const seen = new Set();
  const allItems = [];

  for (const block of blocks) {
    const link = tag(block, "link");
    if (!link || seen.has(link)) continue;
    seen.add(link);

    const pubDateStr = tag(block, "pubDate");
    const pubMs = pubDateStr ? new Date(pubDateStr).getTime() : NaN;

    const descriptionRaw = tag(block, "description");
    const image =
      attrTag(block, "media:content", "url")
      || attrTag(block, "enclosure", "url")
      || extractImageFromHtml(descriptionRaw);

    const title = stripHtml(tag(block, "title"));
    allItems.push({
      index: allItems.length + 1,
      title,
      link,
      pubDate: pubDateStr,
      pubMs,
      category: stripHtml(tag(block, "category")),
      summary: stripHtml(descriptionRaw),
      imageUrl: image
    });
  }

  // Lọc theo khoảng thời gian nếu có
  let filtered = allItems;
  if (window) {
    filtered = allItems.filter((item) => {
      if (Number.isNaN(item.pubMs)) return false; // bỏ qua nếu không parse được pubDate
      return item.pubMs >= window.from && item.pubMs <= window.to;
    });

    // Nếu không đủ tin mới để chấm điểm → fallback: lấy thêm từ đầu danh sách (tin mới nhất)
    if (filtered.length < CANDIDATE_COUNT) {
      const filteredLinks = new Set(filtered.map((i) => i.link));
      const extras = allItems.filter((i) => !filteredLinks.has(i.link));
      const needed = CANDIDATE_COUNT - filtered.length;
      console.warn(
        `[slot ${slotArg ?? "auto"}] Chỉ có ${filtered.length} tin trong khung giờ. ` +
        `Bổ sung thêm ${Math.min(needed, extras.length)} tin gần nhất.`
      );
      filtered = [...filtered, ...extras.slice(0, needed)];
    }
  }

  // Giới hạn & đánh lại index
  return filtered.slice(0, CANDIDATE_COUNT).map((item, i) => ({ ...item, index: i + 1 }));
}

function limitWords(value, maxWords) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const limited = words.length <= maxWords ? words : words.slice(0, maxWords);
  return cleanHookTail(limited.join(" "));
}

function cleanHookTail(value = "") {
  let clean = String(value || "")
    .replace(/\s+([:,.!?])/g, "$1")
    .replace(/[,:;'"“”‘’]+$/g, "")
    .trim();
  const commaIndex = clean.lastIndexOf(",");
  if (commaIndex > 0) {
    const beforeComma = clean.slice(0, commaIndex).trim();
    const afterComma = clean.slice(commaIndex + 1).trim();
    if (beforeComma.split(/\s+/).length >= 4 && afterComma.split(/\s+/).filter(Boolean).length <= 2) {
      clean = beforeComma;
    }
  }
  clean = clean
    .replace(/\s+(và|hoặc|với|của|ở|tại|để|khi|sau|trước|như|về|từ|đến|trên|dưới|cho)$/i, "")
    .trim();
  const singleQuotes = (clean.match(/'/g) || []).length;
  if (singleQuotes % 2 === 1) {
    clean = clean.replace(/\s*'[^']*$/, "").trim();
  }
  return clean;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Codex VnExpress video automation)",
      "accept": "text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  return response.text();
}

async function enrichArticles(items) {
  return Promise.all(items.map(async (item) => {
    try {
      const html = await fetchText(item.link);
      const article = extractArticleDetails(html);
      return {
        ...item,
        title: article.title || item.title,
        hook: article.title || item.title,
        summary: article.lead || item.summary,
        imageUrl: item.imageUrl || article.imageUrl
      };
    } catch {
      return {
        ...item,
        hook: item.title,
        summary: item.summary
      };
    }
  }));
}

function normalizeText(...values) {
  return values.join(" ").toLowerCase();
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function recencyScore(pubMs) {
  if (!Number.isFinite(pubMs)) return 0;
  const ageHours = Math.max(0, (Date.now() - pubMs) / 36e5);
  if (ageHours <= 2) return 16;
  if (ageHours <= 6) return 12;
  if (ageHours <= 12) return 8;
  if (ageHours <= 24) return 4;
  return 0;
}

function viralScore(item) {
  const text = normalizeText(item.title, item.hook, item.summary, item.category);
  let score = recencyScore(item.pubMs);
  score += countMatches(text, [/\d+[\d.,]*\s*(tỷ|triệu|nghìn|đồng|usd|euro|%)/i, /\d+[\d.,]*\s*(người|ca|năm|tháng|giờ|km|m2)/i]) * 12;
  score += countMatches(text, [/phạt|bắt|khởi tố|điều tra|truy tố|xét xử|tử vong|cháy|tai nạn|sập|lừa đảo/i]) * 10;
  score += countMatches(text, [/điện|xăng|lương|thuế|bảo hiểm|giá vàng|giá nhà|học phí|ngân hàng|lãi suất/i]) * 9;
  score += countMatches(text, [/arsenal|man utd|manchester|real madrid|barca|champions league|v-league|u23|world cup|olympic/i]) * 8;
  score += countMatches(text, [/ceo|tổng thống|thủ tướng|bộ trưởng|nghệ sĩ|ca sĩ|hoa hậu|tỷ phú|elon musk|trump|putin/i]) * 7;
  score += countMatches(text, [/đề xuất|dự thảo|quy định|chính sách|cấm|bắt buộc|tăng|giảm|miễn/i]) * 6;
  score += item.imageUrl ? 4 : 0;
  score += Math.max(0, 6 - Math.floor((item.index - 1) / 2));
  return score;
}

function compactHook(value = "") {
  const clean = stripHtml(value).replace(/\s+/g, " ").trim();
  const number = clean.match(/\d+[\d.,]*\s*(tỷ|triệu|nghìn|đồng|usd|euro|%|người|năm)?/i)?.[0]?.trim();
  if (number && clean.length > 42) {
    return `${number}: ${limitWords(clean, 8)}`;
  }
  return limitWords(clean, 10);
}

function frameHook(value = "") {
  const clean = stripHtml(value)
    .replace(/\s+/g, " ")
    .replace(/\s+[-–—]\s+/g, ": ")
    .trim();
  const number = clean.match(/\d+[\d.,]*\s*(tỷ|triệu|nghìn|đồng|usd|euro|%|người|năm|tháng|giờ)?/i)?.[0]?.trim();
  const words = limitWords(clean, number ? 7 : 8);
  if (number && !words.toLowerCase().includes(number.toLowerCase())) return `${number}: ${words}`;
  return words;
}

function visualLabel(item) {
  const text = normalizeText(item.title, item.hook, item.summary, item.category);
  if (/arsenal|man utd|manchester|real madrid|barca|champions league|bóng đá|v-league|u\d+|world cup|olympic|thể thao/i.test(text)) return "THỂ THAO";
  if (/vn-index|giá vàng|lãi suất|ngân hàng|thuế|kinh doanh|xăng|điện|bất động sản|chứng khoán|kinh tế/i.test(text)) return "KINH TẾ";
  if (/tổng thống|trump|putin|ukraine|nga|mỹ|trung quốc|châu âu/i.test(text)) return "THẾ GIỚI";
  if (/pháp luật|luật|bắt|khởi tố|xét xử|điều tra|truy tố|tòa|án/i.test(text)) return "PHÁP LUẬT";
  if (/giáo dục|học sinh|đại học|thi|trường học/i.test(text)) return "GIÁO DỤC";
  if (/sức khỏe|bệnh viện|bác sĩ|thuốc|dịch|ca bệnh/i.test(text)) return "SỨC KHỎE";
  if (/du lịch|đời sống|gia đình|thời tiết|mưa|nắng|giao thông/i.test(text)) return "ĐỜI SỐNG";
  return "TIN MỚI";
}

function visualKeyword(item) {
  const title = stripHtml(item.title || item.hook || "");
  const text = normalizeText(item.title, item.hook, item.summary, item.category);
  const number = title.match(/\d+[\d.,]*\s*(tỷ|triệu|nghìn|đồng|usd|euro|%|người|ca|năm|tháng|giờ|km|m2)?/i)?.[0]?.trim();
  if (number) return number;
  const moneyOrPolicy = title.match(/\b(giá vàng|lãi suất|thuế|xăng|điện|bảo hiểm|học phí|chính sách|dự thảo|quy định|đề xuất)\b/i)?.[0];
  if (moneyOrPolicy) return moneyOrPolicy;
  const legal = title.match(/\b(phạt|bắt|khởi tố|điều tra|xét xử|truy tố|lừa đảo|tai nạn|cháy)\b/i)?.[0];
  if (legal) return legal;
  const sport = title.match(/\b(Arsenal|Man Utd|Manchester|Real Madrid|Barca|Champions League|V-League|U23|World Cup|Olympic)\b/i)?.[0];
  if (sport) return sport;
  const person = title.match(/\b([A-ZĐ][\p{L}\d]+(?:\s+[A-ZĐ][\p{L}\d]+){1,3})\b/u)?.[0];
  if (person && !/VnExpress|Tin Nóng|Cập Nhật/i.test(person)) return person;
  const fallback = title
    .split(/\s+/)
    .find((word) => word.length >= 5 && !/^(trong|ngoài|những|người|được|theo|khiến|cùng|trước|sau|đến|với)$/i.test(word));
  return fallback || (text.includes("tin") ? "Tin mới" : "Cập nhật");
}

function buildHashtags(item) {
  const text = normalizeText(item.title, item.summary, item.category);
  const tags = ["#Shorts", "#VnExpress", "#TinTuc"];
  if (/arsenal|man utd|champions league|bóng đá|u23|v-league/i.test(text)) tags.push("#TheThao");
  else if (/giá vàng|lãi suất|ngân hàng|thuế|kinh doanh|xăng/i.test(text)) tags.push("#KinhTe");
  else if (/pháp luật|bắt|khởi tố|xét xử|điều tra/i.test(text)) tags.push("#PhapLuat");
  else if (/giáo dục|học sinh|đại học|thi/i.test(text)) tags.push("#GiaoDuc");
  else tags.push("#ThoiSu");
  return [...new Set(tags)].slice(0, 5);
}

function buildVariants(items, slot) {
  const lead = items[0];
  const leadHook = compactHook(lead.viralHook || lead.hook || lead.title);
  const hashtags = buildHashtags(lead);
  const slotLabel = slot === "0700" ? "sáng" : slot === "1200" ? "trưa" : slot === "2000" ? "tối" : "mới";
  const titleVariants = [
    `${leadHook} | Tin nổi bật ${slotLabel} #Shorts`,
    `${leadHook} - Cập nhật VnExpress #Shorts`,
    `Tin nóng: ${leadHook} #Shorts`
  ].map((title) => title.slice(0, 96));
  const captionVariants = [
    `${leadHook}\n\nNguồn: VnExpress\n${hashtags.join(" ")}`,
    `Điểm nhanh ${items.length} tin đáng chú ý: ${items.map((item) => compactHook(item.title)).join("; ")}.\n\nNguồn: VnExpress\n${hashtags.join(" ")}`,
    `Bạn cần biết: ${leadHook}. Theo dõi để cập nhật các tin mới trong ngày.\n\nNguồn: VnExpress\n${hashtags.join(" ")}`
  ];
  return { titleVariants, captionVariants, hashtags };
}

function selectStories(items, slot) {
  const scored = items.map((item) => ({
    ...item,
    viralScore: viralScore(item)
  })).sort((a, b) => b.viralScore - a.viralScore || b.pubMs - a.pubMs);
  const count = Math.min(MAX_NEWS_COUNT, Math.max(MIN_NEWS_COUNT, scored.length));
  const selected = scored.slice(0, count);
  const { titleVariants, captionVariants, hashtags } = buildVariants(selected, slot);
  let start = 0;
  return selected.map((item, index) => {
    const durationSeconds = index === 0 ? TOP_STORY_SECONDS : index >= 3 ? SHORT_STORY_SECONDS : STORY_SECONDS;
    const hook = compactHook(item.hook || item.title);
    const shortHook = frameHook(item.hook || item.title);
    const withTiming = {
      ...item,
      index: index + 1,
      startSeconds: start,
      durationSeconds,
      viralHook: hook,
      frameHook: shortHook,
      visualKeyword: visualKeyword(item),
      visualLabel: visualLabel(item),
      titleVariant: titleVariants[index % titleVariants.length],
      captionVariant: captionVariants[index % captionVariants.length],
      titleVariants,
      captionVariants,
      hashtags
    };
    start += durationSeconds;
    return withTiming;
  });
}

function extensionFrom(url, contentType) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg")) return ".jpg";
  const pathname = new URL(url).pathname.toLowerCase();
  const ext = path.extname(pathname);
  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
}

async function downloadImages(items, imageDir) {
  await mkdir(imageDir, { recursive: true });
  const hydrated = [];
  for (const item of items) {
    if (!item.imageUrl) {
      hydrated.push({ ...item, localImage: "" });
      continue;
    }
    try {
      const response = await fetch(item.imageUrl, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Codex VnExpress video automation)" }
      });
      if (!response.ok) throw new Error(`Image fetch failed ${response.status}`);
      const ext = extensionFrom(item.imageUrl, response.headers.get("content-type"));
      const filename = `news-${String(item.index).padStart(2, "0")}${ext}`;
      const filePath = path.join(imageDir, filename);
      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(filePath, buffer);
      hydrated.push({ ...item, localImage: `assets/${filename}` });
    } catch {
      hydrated.push({ ...item, localImage: "" });
    }
  }
  return hydrated;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayText(value = "") {
  return stripHtml(value)
    .replace(/\.{3,}|…/g, "")
    .replace(/\s+([:,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFontSize(title = "", layout = "") {
  const length = [...title].length;
  const narrow = layout.includes("layout-split");
  const panel = layout.includes("layout-panel");
  if (narrow) {
    if (length <= 30) return 92;
    if (length <= 44) return 82;
    if (length <= 58) return 72;
    if (length <= 76) return 62;
    return 54;
  }
  if (panel) {
    if (length <= 30) return 94;
    if (length <= 44) return 84;
    if (length <= 58) return 74;
    if (length <= 76) return 64;
    return 56;
  }
  if (length <= 30) return 104;
  if (length <= 44) return 94;
  if (length <= 58) return 82;
  if (length <= 76) return 70;
  return 60;
}

function summaryFontSize(summary = "") {
  const length = [...summary].length;
  if (length <= 110) return 44;
  if (length <= 160) return 40;
  if (length <= 230) return 36;
  if (length <= 310) return 32;
  return 29;
}

function keywordMatches(word, keyword) {
  const cleanWord = String(word).toLowerCase().replace(/[^\p{L}\p{N}%.,]/gu, "");
  const cleanKeyword = String(keyword).toLowerCase().replace(/[^\p{L}\p{N}%.,\s]/gu, " ").trim();
  if (!cleanWord || !cleanKeyword) return false;
  return cleanKeyword.split(/\s+/).some((part) => part.length > 1 && cleanWord.includes(part));
}

function wordSpans(value = "", keyword = "") {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span${keywordMatches(word, keyword) ? ` class="hot-word"` : ""}>${escapeHtml(word)}</span>`)
    .join(" ");
}

function renderComposition(items, totalSeconds) {
  const tickerText = items
    .map((item) => displayText(`${item.visualLabel || "TIN MỚI"}: ${item.frameHook || item.viralHook || item.title}`))
    .join("   /   ");
  const segmentHtml = items
    .map((item) => `<span class="segment" data-scene="${item.index}"><i></i></span>`)
    .join("");
  const sceneHtml = items.map((item, i) => {
    const start = item.startSeconds;
    const duration = item.durationSeconds;
    const hasImage = Boolean(item.localImage);
    const layout = i === 0 ? "layout-hero is-lead" : i % 3 === 1 ? "layout-split" : i % 3 === 2 ? "layout-panel" : "layout-stack";
    const hook = displayText(item.frameHook || item.viralHook || item.hook || item.title);
    const titleSize = titleFontSize(hook, layout);
    const summaryText = displayText(item.summary || item.title);
    const leadSize = summaryFontSize(summaryText);
    const updateLabel = i === 0 ? "TIN NÓNG" : "CẬP NHẬT";
    return `
      <section id="scene-${String(item.index).padStart(2, "0")}" class="clip scene breaking-scene ${layout} ${hasImage ? "has-image" : "no-image"}" data-start="${start}" data-duration="${duration}" data-track-index="${i + 1}" style="--i:${i}; --scene-duration:${duration}s;">
        <div class="photo-wrap">
          ${hasImage ? `<img class="bg-photo" src="${escapeHtml(item.localImage)}" alt="" />` : ""}
          <div class="fallback-bg"></div>
        </div>
        <div class="photo-vignette"></div>
        <div class="grid-lines"></div>
        <div class="red-flash"></div>
        <div class="red-wipe"></div>
        <div class="top-bar">
          <span class="breaking-label">${updateLabel}</span>
          <span class="source-label">VnExpress</span>
          <span class="time-label">${escapeHtml(formatPubDate(item.pubDate))}</span>
        </div>
        <div class="scene-progress">${segmentHtml}</div>
        <div class="scene-content">
          <div class="category-badge">${escapeHtml(item.visualLabel || "TIN MỚI")}</div>
          <h1 class="hook-title" style="font-size:${titleSize}px">${wordSpans(hook, item.visualKeyword)}</h1>
          <p class="lead" style="font-size:${leadSize}px">${escapeHtml(summaryText)}</p>
        </div>
        <div class="scene-count">${String(item.index).padStart(2, "0")} / ${items.length}</div>
        <div class="ticker"><div class="ticker-track">${escapeHtml(tickerText)}   /   ${escapeHtml(tickerText)}</div></div>
      </section>`;
  }).join("\n");
  const outroStart = Math.max(0, totalSeconds - OUTRO_SECONDS);

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VnExpress Hot News</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #050505; font-family: Arial, "Helvetica Neue", sans-serif; }
    #stage { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #050505; }
    .scene { position: absolute; inset: 0; overflow: hidden; opacity: 0; transform: translateY(0) scale(1); background: #050505; }
    .scene.is-lead { opacity: 1; }
    .photo-wrap { position: absolute; inset: 0; overflow: hidden; background: #111; }
    .bg-photo { position: absolute; inset: -2%; width: 104%; height: 104%; object-fit: cover; filter: saturate(1.12) contrast(1.12) brightness(.92); opacity: 1; transform: scale(1.01); will-change: transform; }
    .fallback-bg { position: absolute; inset: 0; background: repeating-linear-gradient(135deg, #1a1a1a 0 18px, #101010 18px 36px), linear-gradient(180deg, #252525, #050505); }
    .has-image .fallback-bg { opacity: .05; mix-blend-mode: multiply; }
    .photo-vignette { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.46) 0%, rgba(0,0,0,.18) 34%, rgba(0,0,0,.62) 100%), linear-gradient(90deg, rgba(0,0,0,.58) 0%, rgba(0,0,0,.12) 48%, rgba(0,0,0,.48) 100%); }
    .grid-lines { position: absolute; inset: 0; opacity: .09; background-image: linear-gradient(rgba(255,255,255,.16) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.12) 1px, transparent 1px); background-size: 90px 90px; mask-image: linear-gradient(180deg, transparent, #000 18%, #000 80%, transparent); }
    .red-flash { position: absolute; inset: 0; z-index: 30; pointer-events: none; background: #e30613; opacity: 0; mix-blend-mode: screen; }
    .red-wipe { position: absolute; inset: 0; z-index: 31; pointer-events: none; background: #e30613; transform: translateX(-105%); }
    .top-bar { position: absolute; z-index: 12; top: 46px; left: 46px; right: 46px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px; height: 70px; color: #fff; font-weight: 950; letter-spacing: 0; }
    .breaking-label { align-self: stretch; display: inline-flex; align-items: center; padding: 0 26px; background: #e30613; color: #fff; font-size: 34px; box-shadow: 10px 10px 0 rgba(0,0,0,.64); }
    .source-label { align-self: stretch; display: inline-flex; align-items: center; padding: 0 18px; background: rgba(0,0,0,.72); border: 2px solid rgba(255,255,255,.35); font-size: 28px; text-transform: uppercase; }
    .time-label { align-self: stretch; display: inline-flex; align-items: center; justify-content: center; min-width: 176px; padding: 0 16px; background: #fff; color: #060606; font-size: 26px; }
    .scene-progress { position: absolute; z-index: 13; left: 46px; right: 46px; top: 132px; display: grid; grid-template-columns: repeat(${items.length}, 1fr); gap: 8px; height: 10px; }
    .segment { display: block; overflow: hidden; background: rgba(255,255,255,.24); }
    .segment i { display: block; width: 0; height: 100%; background: #e30613; }
    .scene-content { position: relative; z-index: 10; width: 100%; height: 100%; padding: 176px 52px 228px; display: grid; grid-template-rows: auto auto auto auto; align-content: center; justify-items: center; text-align: center; gap: 18px; }
    .category-badge { width: max-content; max-width: 100%; padding: 12px 18px; background: #fff; color: #070707; font-size: 28px; font-weight: 950; text-transform: uppercase; box-shadow: 8px 8px 0 #e30613; }
    .hook-title { justify-self: center; margin: 0; color: #fff; line-height: .94; font-weight: 950; letter-spacing: 0; text-wrap: balance; text-transform: uppercase; text-align: center; text-shadow: 0 11px 36px rgba(0,0,0,.86); max-width: 960px; max-height: none; overflow: visible; overflow-wrap: anywhere; }
    .hook-title span { display: inline-block; transform-origin: 50% 80%; }
    .hook-title .hot-word { color: #ffdd2d; text-shadow: 0 8px 30px rgba(0,0,0,.9), 0 0 24px rgba(227,6,19,.75); }
    .lead { justify-self: center; margin: 0; color: rgba(255,255,255,.94); line-height: 1.16; font-weight: 860; width: 100%; max-width: 960px; overflow: visible; display: block; text-align: center; text-wrap: pretty; text-shadow: 0 6px 24px rgba(0,0,0,.82); }
    .scene-count { position: absolute; right: 52px; bottom: 158px; z-index: 14; color: rgba(255,255,255,.9); font-weight: 950; font-size: 30px; text-shadow: 0 6px 24px rgba(0,0,0,.82); }
    .ticker { position: absolute; left: 0; right: 0; bottom: 76px; z-index: 16; height: 58px; overflow: hidden; background: #e30613; border-top: 4px solid #fff; border-bottom: 4px solid #fff; color: #fff; white-space: nowrap; }
    .ticker-track { display: inline-block; padding-left: 100%; font-size: 28px; line-height: 50px; font-weight: 950; text-transform: uppercase; will-change: transform; }
    .layout-split .photo-wrap { left: 500px; clip-path: polygon(10% 0, 100% 0, 100% 100%, 0 100%); }
    .layout-split .photo-vignette { background: linear-gradient(90deg, rgba(0,0,0,.76) 0%, rgba(0,0,0,.58) 44%, rgba(0,0,0,.16) 100%), linear-gradient(180deg, rgba(0,0,0,.44), rgba(0,0,0,.62)); }
    .layout-split .scene-content { padding-right: 220px; padding-top: 176px; padding-bottom: 228px; align-content: center; gap: 16px; }
    .layout-split .hook-title { max-width: 810px; }
    .layout-split .lead { max-width: 810px; }
    .layout-panel .scene-content { align-content: center; padding-top: 176px; padding-bottom: 228px; gap: 18px; }
    .layout-panel .hook-title, .layout-panel .lead { background: rgba(0,0,0,.72); padding: 22px 26px; border-left: 12px solid #e30613; }
    .layout-stack .scene-content { align-content: center; padding-top: 176px; padding-bottom: 228px; }
    .is-lead .photo-wrap { inset: -4%; }
    .is-lead .scene-content { padding-top: 176px; padding-bottom: 228px; align-content: center; gap: 18px; }
    .is-lead .hook-title { font-size: 104px; max-height: none; }
    .outro { position: absolute; inset: 0; opacity: 0; overflow: hidden; background: linear-gradient(135deg, #050505 0%, #151515 48%, #e30613 49%, #e30613 58%, #050505 59%); }
    .outro::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.18), rgba(0,0,0,.72)); }
    .outro-inner { position: absolute; left: 52px; right: 52px; top: 50%; transform: translateY(-50%); display: grid; justify-items: center; align-content: center; text-align: center; gap: 44px; min-height: 980px; }
    .subscribe-icon { width: 178px; height: 178px; display: grid; place-items: center; background: #e30613; box-shadow: 16px 16px 0 rgba(0,0,0,.62); color: #fff; font-size: 88px; font-weight: 950; line-height: 1; padding-left: 10px; }
    .outro h2 { margin: 0; color: #fff; font-size: 94px; line-height: .96; font-weight: 950; text-shadow: 0 8px 34px rgba(0,0,0,.7); text-transform: uppercase; max-width: 930px; text-wrap: balance; }
    .outro p { margin: 0; color: #fff; font-size: 54px; line-height: 1.1; font-weight: 950; max-width: 900px; text-wrap: balance; text-shadow: 0 6px 28px rgba(0,0,0,.72); }
    .subscribe-pill { margin-top: 4px; display: inline-flex; align-items: center; justify-content: center; min-width: 640px; max-width: 900px; min-height: 104px; padding: 0 48px; background: #fff; color: #101217; font-size: 48px; font-weight: 950; box-shadow: 14px 14px 0 #e30613; overflow-wrap: anywhere; }
    .watermark { position: absolute; right: 52px; bottom: 26px; z-index: 100; color: rgba(255,255,255,.86); font-size: 28px; font-weight: 900; text-shadow: 0 4px 22px rgba(0,0,0,.8); }
    .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; background: rgba(255,255,255,.18); overflow: hidden; z-index: 101; }
    .progress-inner { height: 100%; width: 0%; background: #e30613; }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="root" data-start="0" data-duration="${totalSeconds}" data-width="${WIDTH}" data-height="${HEIGHT}">
    ${sceneHtml}
    <section id="outro-subscribe" class="clip outro" data-start="${outroStart}" data-duration="${OUTRO_SECONDS}">
      <div class="accent accent-a"></div>
      <div class="accent accent-b"></div>
      <div class="outro-inner">
        <div class="subscribe-icon">▶</div>
        <h2>Theo dõi tin tức chất lượng</h2>
        <p>Cập nhật nhanh các tin nổi bật mỗi sáng và tối</p>
        <div class="subscribe-pill">${escapeHtml(WATERMARK)}</div>
      </div>
    </section>
    <div class="watermark">${escapeHtml(WATERMARK)}</div>
    <div class="progress"><div class="progress-inner"></div></div>
    <audio id="background-music" data-start="0" data-duration="${totalSeconds}" data-track-index="10" data-volume="0.42" src="assets/background01.mp3"></audio>
  </div>
  <script>
    window.__hfDuration = ${totalSeconds};
    window.__hfFps = ${FPS};
    const sceneTimings = ${JSON.stringify(items.map((item) => ({ start: item.startSeconds, duration: item.durationSeconds })))};
    const scenes = [...document.querySelectorAll(".scene")];
    const outro = document.querySelector(".outro");
    const progress = document.querySelector(".progress-inner");
    let seek;

    if (window.gsap) {
      const master = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
      scenes.forEach((scene, index) => {
        const start = sceneTimings[index].start;
        const duration = sceneTimings[index].duration;
        const photo = scene.querySelector(".bg-photo");
        const topBar = scene.querySelector(".top-bar");
        const flash = scene.querySelector(".red-flash");
        const wipe = scene.querySelector(".red-wipe");
        const badge = scene.querySelector(".category-badge");
        const title = scene.querySelector(".hook-title");
        const titleWords = scene.querySelectorAll(".hook-title span");
        const hotWords = scene.querySelectorAll(".hot-word");
        const summary = scene.querySelector(".lead");
        const ticker = scene.querySelector(".ticker-track");
        master.set(scene, { opacity: 1, y: 0, scale: 1 }, start);
        master.fromTo(flash, { opacity: index === 0 ? .72 : .5 }, { opacity: 0, duration: .15, ease: "power1.out" }, start);
        master.fromTo(wipe, { xPercent: -105 }, { xPercent: 105, duration: .34, ease: "power4.inOut" }, start + Math.max(0, duration - .44));
        master.fromTo(topBar, { y: -38, opacity: .65 }, { y: 0, opacity: 1, duration: .28 }, start + .02);
        master.fromTo(badge, { x: -46, opacity: 0 }, { x: 0, opacity: 1, duration: .28 }, start + .1);
        master.fromTo(title, { y: 76, scale: .86, opacity: .78 }, { y: 0, scale: 1, opacity: 1, duration: .5, ease: "back.out(1.45)" }, start + .06);
        master.fromTo(titleWords, { y: 44, opacity: .4, scale: .94 }, { y: 0, opacity: 1, scale: 1, stagger: .018, duration: .38, ease: "power3.out" }, start + .14);
        master.fromTo(summary, { y: 32, opacity: 0 }, { y: 0, opacity: 1, duration: .38 }, start + 1.05);
        if (hotWords.length) {
          master.to(hotWords, {
            scale: 1.08,
            x: () => gsap.utils.random(-3, 3, 1),
            y: () => gsap.utils.random(-2, 2, 1),
            opacity: .78,
            duration: .12,
            repeat: Math.max(0, Math.floor(duration / .24) - 1),
            yoyo: true,
            repeatRefresh: true,
            stagger: .035,
            ease: "power1.inOut"
          }, start + .72);
          master.to(hotWords, {
            color: "#fff46b",
            textShadow: "0 8px 30px rgba(0,0,0,.9), 0 0 34px rgba(255,221,45,.9), 0 0 22px rgba(227,6,19,.75)",
            duration: .18,
            repeat: Math.max(0, Math.floor(duration / .36) - 1),
            yoyo: true,
            stagger: .04,
            ease: "sine.inOut"
          }, start + .72);
        }
        master.to(scene.querySelectorAll(".segment i"), { width: (segmentIndex) => segmentIndex < index ? "100%" : segmentIndex === index ? "100%" : "0%", duration: segmentIndex => segmentIndex === index ? duration : .01, ease: "none" }, start);
        if (ticker) master.fromTo(ticker, { xPercent: 0 }, { xPercent: -54, duration, ease: "none" }, start);
        if (photo) master.to(photo, { scale: index === 0 ? 1.045 : 1.03, x: index % 2 ? 14 : -12, y: index % 3 ? -9 : 7, duration, ease: "none" }, start);
        master.to(scene, { opacity: 0, scale: 1.03, duration: .18, ease: "power2.in" }, start + duration - .18);
      });
      const outroInner = outro.querySelector(".outro-inner");
      master.to(outro, { opacity: 1, duration: .28, ease: "power3.out" }, ${outroStart});
      master.fromTo(outroInner.children, { y: 44, opacity: 0, scale: .94 }, { y: 0, opacity: 1, scale: 1, stagger: .08, duration: .44, ease: "back.out(1.45)" }, ${outroStart} + .08);
      master.to(outro.querySelector(".subscribe-icon"), { scale: 1.08, repeat: 3, yoyo: true, duration: .3, ease: "sine.inOut" }, ${outroStart} + .78);
      master.to(outro, { opacity: 0, duration: .25, ease: "power2.in" }, ${totalSeconds} - .25);
      master.to(progress, { width: "100%", duration: ${totalSeconds}, ease: "none" }, 0);
      seek = (t) => master.time(Math.max(0, Math.min(${totalSeconds}, t)));
    } else {
      const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
      const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
      const easeIn = (t) => Math.pow(clamp(t), 3);
      const set = (el, opacity, y = 0, scale = 1) => {
        if (!el) return;
        el.style.opacity = String(clamp(opacity));
        el.style.transform = "translateY(" + y + "px) scale(" + scale + ")";
      };
      seek = (time) => {
        const t = clamp(time, 0, ${totalSeconds});
        progress.style.width = (t / ${totalSeconds} * 100) + "%";
        scenes.forEach((scene, index) => {
          const duration = sceneTimings[index].duration;
          const local = t - sceneTimings[index].start;
          const visible = local >= 0 && local <= duration;
          let opacity = visible ? 1 : 0;
          let scale = 1;
          if (visible && local > duration - 0.34) {
            const p = easeIn((local - (duration - 0.34)) / .34);
            opacity = 1 - p; scale = 1 + .03 * p;
          }
          set(scene, opacity, 0, scale);
          const flash = scene.querySelector(".red-flash");
          const wipe = scene.querySelector(".red-wipe");
          if (flash) flash.style.opacity = String(visible ? .72 * (1 - clamp(local / .15)) : 0);
          if (wipe) wipe.style.transform = "translateX(" + (-105 + 210 * easeOut((local - (duration - .44)) / .34)) + "%)";
          set(scene.querySelector(".top-bar"), Math.max(.65, easeOut((local - .02) / .28)), -38 * (1 - easeOut((local - .02) / .28)), 1);
          set(scene.querySelector(".category-badge"), easeOut((local - .1) / .28), 0, 1);
          const titleP = Math.max(.78, easeOut((local - .06) / .5));
          set(scene.querySelector(".hook-title"), titleP, 76 * (1 - titleP), .86 + .14 * titleP);
          scene.querySelectorAll(".hook-title span").forEach((word, wordIndex) => {
            const p = Math.max(.4, easeOut((local - .14 - wordIndex * .018) / .38));
            word.style.opacity = String(p);
            word.style.transform = "translateY(" + (44 * (1 - p)) + "px) scale(" + (.94 + .06 * p) + ")";
          });
          const leadP = easeOut((local - 1.05) / .38);
          set(scene.querySelector(".lead"), leadP, 32 * (1 - leadP), 1);
          scene.querySelectorAll(".hot-word").forEach((word, hotIndex) => {
            const active = local > .72 && local < duration - .2;
            if (!active) return;
            const pulse = Math.sin((local * 18) + hotIndex) > 0 ? 1 : 0;
            const shake = pulse ? (hotIndex % 2 ? 2 : -2) : 0;
            word.style.opacity = pulse ? ".82" : "1";
            word.style.transform = "translate(" + shake + "px," + (pulse ? -1 : 1) + "px) scale(" + (pulse ? 1.06 : 1) + ")";
            word.style.textShadow = pulse
              ? "0 8px 30px rgba(0,0,0,.9), 0 0 34px rgba(255,221,45,.9), 0 0 22px rgba(227,6,19,.75)"
              : "0 8px 30px rgba(0,0,0,.9), 0 0 24px rgba(227,6,19,.75)";
          });
          scene.querySelectorAll(".segment i").forEach((segment, segmentIndex) => {
            segment.style.width = segmentIndex < index ? "100%" : segmentIndex === index ? (clamp(local / duration) * 100) + "%" : "0%";
          });
          const ticker = scene.querySelector(".ticker-track");
          if (ticker) ticker.style.transform = "translateX(" + (-54 * clamp(local / duration)) + "%)";
          const photo = scene.querySelector(".bg-photo");
          if (photo) {
            const p = clamp(local / duration);
            const x = (index % 2 ? 48 : -42) * p;
            const py = (index % 3 ? -30 : 24) * p;
            photo.style.transform = "translate(" + x + "px," + py + "px) scale(" + (1.01 + (index === 0 ? .035 : .02) * p) + ")";
          }
        });
        const outroLocal = t - ${outroStart};
        const outroVisible = outroLocal >= 0 && outroLocal <= ${OUTRO_SECONDS};
        outro.style.opacity = String(outroVisible ? 1 : 0);
        [...outro.querySelector(".outro-inner").children].forEach((child, index) => {
          const p = easeOut((outroLocal - .08 - index * .08) / .44);
          child.style.opacity = String(p);
          child.style.transform = "translateY(" + (44 * (1 - p)) + "px) scale(" + (.94 + .06 * p) + ")";
        });
      };
    }

    window.__hyperframes = { duration: ${totalSeconds}, fps: ${FPS}, seek };
    window.__timelines = window.__timelines || {};
    window.__timelines.root = { duration: ${totalSeconds}, seek };
    window.addEventListener("hf-seek", (event) => seek(event.detail?.time ?? 0));
    seek(0);
  </script>
</body>
</html>`;
}

function formatPubDate(pubDate) {
  if (!pubDate) return "Tin noi bat";
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return "Tin noi bat";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function commandExists(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function renderWithHyperframes(outDir) {
  if (!commandExists("npx")) {
    throw new Error("Cannot render: npx is not available. Install Node.js/npm or run `npm install -g hyperframes`.");
  }
  if (!commandExists("ffmpeg") || !commandExists("ffprobe")) {
    throw new Error("Cannot render: ffmpeg and ffprobe must be on PATH for HyperFrames rendering.");
  }
  const output = path.join(outDir, "final.mp4");
  // HYPERFRAMES_QUALITY: "high" (mặc định) hoặc "standard"/"draft" cho môi trường CI ít RAM
  const quality = process.env.HYPERFRAMES_QUALITY || "high";
  console.log(`[render] quality=${quality}, output=${output}`);
  const result = spawnSync("npx", ["hyperframes", "render", "--output", output, "--fps", String(FPS), "--quality", quality], {
    cwd: outDir,
    stdio: "inherit",
    shell: true
  });
  if (result.status !== 0) throw new Error(`HyperFrames render failed with exit code ${result.status}`);
  verifyOutput(output);
  return output;
}


function verifyOutput(output) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration",
    "-of", "json",
    output
  ], { encoding: "utf8", shell: true });
  if (result.status !== 0) throw new Error("ffprobe verification failed.");
  const stream = JSON.parse(result.stdout).streams?.[0];
  if (!stream || Number(stream.width) !== WIDTH || Number(stream.height) !== HEIGHT) {
    throw new Error(`Unexpected output size: ${stream?.width}x${stream?.height}`);
  }
}

async function main() {
  const now = bangkokParts();
  const slot = currentSlot();
  const window = slotTimeWindow(slot);
  const outDir = path.resolve("outputs", "vnexpress", now.date, slot);
  const imageDir = path.join(outDir, "assets");
  await mkdir(outDir, { recursive: true });

  if (window) {
    const fromStr = new Date(window.from).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
    const toStr   = new Date(window.to).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" });
    console.log(`[slot ${slot}] Lọc tin từ ${fromStr} → ${toStr}`);
  }

  const xml = await fetchText(RSS_URL);
  let items = parseItems(xml, window);
  if (items.length === 0) throw new Error("RSS returned no items; aborting render.");
  items = await enrichArticles(items);
  const dedupeState = await readDedupeState(DEDUPE_STATE, now.date);
  const beforeDedupeCount = items.length;
  items = filterSeenItems(items, dedupeState, now.date);
  const skippedCount = beforeDedupeCount - items.length;
  console.log(`[dedupe] Bỏ qua ${skippedCount} tin đã dùng trong ngày ${now.date}. Còn ${items.length} tin mới.`);
  if (items.length < MIN_NEWS_COUNT) {
    const message = `Không đủ tin mới không trùng trong ngày ${now.date}: cần ${MIN_NEWS_COUNT}, còn ${items.length}. Skip render/upload.`;
    console.log(`[dedupe] ${message}`);
    await writeFile(path.join(outDir, "skip.json"), JSON.stringify({
      source: RSS_URL,
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Bangkok",
      slot,
      reason: "not_enough_unique_news",
      required: MIN_NEWS_COUNT,
      available: items.length,
      skippedDuplicateCount: skippedCount
    }, null, 2), "utf8");
    return;
  }
  items = selectStories(items, slot);
  items = await downloadImages(items, imageDir);
  const storySeconds = items.reduce((sum, item) => sum + item.durationSeconds, 0);
  const totalSeconds = storySeconds + OUTRO_SECONDS;
  const primary = items[0];
  const experiment = {
    generatedAt: new Date().toISOString(),
    slot,
    format: "youtube_shorts_retention_v1",
    visualStyle: "breaking_news",
    topStory: primary ? {
      title: primary.title,
      link: primary.link,
      viralScore: primary.viralScore,
      viralHook: primary.viralHook,
      frameHook: primary.frameHook,
      visualKeyword: primary.visualKeyword,
      visualLabel: primary.visualLabel
    } : null,
    hookVariant: primary?.viralHook || "",
    frameHook: primary?.frameHook || "",
    visualKeyword: primary?.visualKeyword || "",
    visualLabel: primary?.visualLabel || "",
    titleVariant: primary?.titleVariant || "",
    captionVariant: primary?.captionVariant || "",
    titleVariants: primary?.titleVariants || [],
    captionVariants: primary?.captionVariants || [],
    hashtags: primary?.hashtags || [],
    storyCount: items.length,
    durationSeconds: totalSeconds,
    targetMetrics: {
      averageViewDurationRatio: 0.6,
      evaluateAfterHours: [24, 48],
      primaryMetric: "engaged_views"
    }
  };

  const html = renderComposition(items, totalSeconds);
  await writeFile(path.join(outDir, "index.html"), html, "utf8");
  await writeFile(path.join(outDir, "news.json"), JSON.stringify({
    source: RSS_URL,
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    slot,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSeconds: totalSeconds,
    backgroundAudio: BACKGROUND_AUDIO,
    watermark: WATERMARK,
    experiment,
    items
  }, null, 2), "utf8");
  await writeFile(path.join(outDir, "video-experiment.json"), JSON.stringify(experiment, null, 2), "utf8");

  if (!existsSync(BACKGROUND_AUDIO)) {
    throw new Error(`Background audio does not exist: ${BACKGROUND_AUDIO}`);
  }
  await copyFile(BACKGROUND_AUDIO, path.join(imageDir, "background01.mp3"));

  await writeCaption(outDir);

  let output = path.join(outDir, "final.mp4");
  if (!skipRender) output = renderWithHyperframes(outDir);

  if (uploadRequested || dryRunUpload) {
    if (skipRender && !existsSync(output)) {
      throw new Error(`Cannot upload because final.mp4 does not exist: ${output}`);
    }
    await uploadToPlatforms({ outDir, videoPath: output, dryRun: dryRunUpload });
  }

  if (dryRunUpload) {
    console.log("[dedupe] Dry-run upload: không lưu state chống trùng tin.");
  } else {
    await writeDedupeState(DEDUPE_STATE, now.date, slot, items);
  }

  console.log(`Generated VnExpress package: ${outDir}`);
  if (skipRender) console.log("Render skipped. Run without --skip-render after HyperFrames, npx, ffmpeg, and ffprobe are available.");
}

main().catch(async (error) => {
  const now = bangkokParts();
  const slot = currentSlot();
  const outDir = path.resolve("outputs", "vnexpress", now.date, slot);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "error.log"), `${new Date().toISOString()}\n${error.stack || error.message}\n`, "utf8");
  console.error(error.message);
  process.exit(1);
});

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { uploadToPlatforms, writeCaption } from "./upload-platforms.mjs";

const RSS_URL = "https://vnexpress.net/rss/tin-noi-bat.rss";
const BACKGROUND_AUDIO = "E:\\20.tainguyen\\background01.mp3";
const WATERMARK = "@tintucchatluong";
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const SCENE_SECONDS = 8;
const NEWS_COUNT = 10;
const OUTRO_SECONDS = 3;
const NEWS_SECONDS = NEWS_COUNT * SCENE_SECONDS;
const TOTAL_SECONDS = NEWS_SECONDS + OUTRO_SECONDS;

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
  return now.hour < 12 ? "0700" : "1900";
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

function parseItems(xml) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const seen = new Set();
  const items = [];
  for (const block of blocks) {
    const link = tag(block, "link");
    if (!link || seen.has(link)) continue;
    seen.add(link);

    const descriptionRaw = tag(block, "description");
    const image =
      attrTag(block, "media:content", "url")
      || attrTag(block, "enclosure", "url")
      || extractImageFromHtml(descriptionRaw);

    const title = stripHtml(tag(block, "title"));
    items.push({
      index: items.length + 1,
      title,
      link,
      pubDate: tag(block, "pubDate"),
      category: stripHtml(tag(block, "category")),
      summary: stripHtml(descriptionRaw),
      imageUrl: image
    });
    if (items.length >= NEWS_COUNT) break;
  }
  return items;
}

function limitWords(value, maxWords) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
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

function titleFontSize(title = "") {
  const length = [...title].length;
  if (length <= 58) return 70;
  if (length <= 82) return 60;
  if (length <= 108) return 52;
  return 46;
}

function summaryFontSize(summary = "") {
  const length = [...summary].length;
  if (length <= 110) return 46;
  if (length <= 160) return 41;
  if (length <= 220) return 36;
  return 32;
}

function wordSpans(value = "") {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `<span>${escapeHtml(word)}</span>`)
    .join(" ");
}

function renderComposition(items) {
  const sceneHtml = items.map((item, i) => {
    const start = i * SCENE_SECONDS;
    const hasImage = Boolean(item.localImage);
    const titleSize = titleFontSize(item.hook || item.title);
    const leadSize = summaryFontSize(item.summary);
    return `
      <section id="scene-${String(item.index).padStart(2, "0")}" class="clip scene ${hasImage ? "has-image" : "no-image"}" data-start="${start}" data-duration="${SCENE_SECONDS}" style="--i:${i};">
        ${hasImage ? `<img class="bg-photo" src="${escapeHtml(item.localImage)}" alt="" />` : ""}
        <div class="fallback-bg"></div>
        <div class="photo-vignette"></div>
        <div class="accent accent-a"></div>
        <div class="accent accent-b"></div>
        <div class="scene-count">${String(item.index).padStart(2, "0")} / ${NEWS_COUNT}</div>
        <div class="content">
          <div class="source-row"><span>VnExpress</span><span>${escapeHtml(formatPubDate(item.pubDate))}</span></div>
          <h1 class="hook-title" style="font-size:${titleSize}px">${wordSpans(item.hook || item.title)}</h1>
          <p class="lead" style="font-size:${leadSize}px">${escapeHtml(item.summary || item.title)}</p>
        </div>
      </section>`;
  }).join("\n");
  const outroStart = NEWS_SECONDS;

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
    body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #080b10; font-family: Arial, "Helvetica Neue", sans-serif; }
    #stage { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #080b10; }
    .scene { position: absolute; inset: 0; overflow: hidden; opacity: 0; transform: translateY(70px) scale(0.985); }
    .bg-photo { position: absolute; inset: -5%; width: 110%; height: 110%; object-fit: cover; filter: saturate(1.12) contrast(1.08) brightness(.86); opacity: .96; transform: scale(1.03); }
    .fallback-bg { position: absolute; inset: 0; background: radial-gradient(circle at 18% 18%, rgba(255, 78, 40, .42), transparent 30%), radial-gradient(circle at 82% 68%, rgba(0, 174, 255, .34), transparent 34%), linear-gradient(150deg, #081018, #17191f 44%, #080b10); }
    .has-image .fallback-bg { opacity: .1; mix-blend-mode: screen; }
    .photo-vignette { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.7), rgba(0,0,0,.34) 34%, rgba(0,0,0,.72) 100%), linear-gradient(90deg, rgba(0,0,0,.72), rgba(0,0,0,.18), rgba(0,0,0,.52)); }
    .accent { position: absolute; border-radius: 999px; filter: blur(.4px); opacity: .85; }
    .accent-a { width: 300px; height: 300px; right: -90px; top: 210px; border: 3px solid rgba(255,255,255,.2); }
    .accent-b { width: 14px; height: 780px; left: 54px; top: 210px; background: linear-gradient(#ff4e28, #ffd166, #00aeff); transform: rotate(8deg); }
    .scene-count { position: absolute; top: 78px; left: 74px; color: rgba(255,255,255,.9); font-weight: 900; font-size: 32px; letter-spacing: 0; text-shadow: 0 6px 24px rgba(0,0,0,.62); }
    .content { position: absolute; left: 74px; right: 74px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 32px; max-height: 1280px; }
    .source-row { display: flex; justify-content: space-between; gap: 20px; width: 100%; color: rgba(255,255,255,.9); font-size: 28px; line-height: 1; font-weight: 900; text-shadow: 0 5px 22px rgba(0,0,0,.7); }
    .source-row span:first-child { padding: 13px 18px; background: #ff4e28; border-radius: 8px; color: #fff; }
    .source-row span:last-child { padding-top: 13px; }
    .hook-title { margin: 0; color: #fff7df; line-height: 1.08; font-weight: 950; letter-spacing: 0; text-wrap: balance; text-shadow: 0 9px 34px rgba(0,0,0,.78), 0 0 28px rgba(255,78,40,.28); max-height: 620px; overflow: hidden; }
    .hook-title span { display: inline-block; transform-origin: 50% 80%; }
    .lead { margin: 0; color: #9ee7ff; line-height: 1.28; font-weight: 820; max-width: 925px; max-height: 470px; overflow: hidden; text-shadow: 0 6px 26px rgba(0,0,0,.78), 0 0 22px rgba(0,174,255,.24); border-left: 9px solid #00aeff; padding-left: 24px; }
    .outro { position: absolute; inset: 0; opacity: 0; overflow: hidden; background: radial-gradient(circle at 20% 20%, rgba(255,78,40,.5), transparent 32%), radial-gradient(circle at 80% 72%, rgba(0,174,255,.45), transparent 36%), linear-gradient(145deg, #070a0f, #17191f 46%, #070a0f); }
    .outro::before { content: ""; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.25), rgba(0,0,0,.68)); }
    .outro-inner { position: absolute; left: 74px; right: 74px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; text-align: center; gap: 34px; }
    .subscribe-icon { width: 160px; height: 160px; border-radius: 999px; display: grid; place-items: center; background: #ff2f24; box-shadow: 0 22px 70px rgba(0,0,0,.45), 0 0 48px rgba(255,47,36,.45); color: #fff; font-size: 72px; font-weight: 950; line-height: 1; padding-left: 8px; }
    .outro h2 { margin: 0; color: #fff7df; font-size: 74px; line-height: 1.02; font-weight: 950; text-shadow: 0 8px 34px rgba(0,0,0,.7); }
    .outro p { margin: 0; color: #9ee7ff; font-size: 40px; line-height: 1.24; font-weight: 850; max-width: 800px; text-shadow: 0 6px 28px rgba(0,0,0,.72); }
    .subscribe-pill { margin-top: 8px; display: inline-flex; align-items: center; justify-content: center; min-width: 520px; height: 92px; padding: 0 42px; border-radius: 999px; background: #fff; color: #101217; font-size: 38px; font-weight: 950; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
    .watermark { position: absolute; right: 52px; bottom: 58px; z-index: 100; color: rgba(255,255,255,.82); font-size: 30px; font-weight: 800; text-shadow: 0 4px 22px rgba(0,0,0,.7); }
    .progress { position: absolute; left: 52px; right: 52px; bottom: 38px; height: 8px; background: rgba(255,255,255,.16); overflow: hidden; border-radius: 8px; z-index: 101; }
    .progress-inner { height: 100%; width: 0%; background: linear-gradient(90deg, #ff4e28, #ffd166, #00aeff); border-radius: inherit; }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="root" data-start="0" data-duration="${TOTAL_SECONDS}" data-width="${WIDTH}" data-height="${HEIGHT}">
    ${sceneHtml}
    <section id="outro-subscribe" class="clip outro" data-start="${outroStart}" data-duration="${OUTRO_SECONDS}">
      <div class="accent accent-a"></div>
      <div class="accent accent-b"></div>
      <div class="outro-inner">
        <div class="subscribe-icon">▶</div>
        <h2>Theo dõi tin tức mới nhất</h2>
        <p>Cập nhật nhanh các tin nổi bật mỗi sáng và tối</p>
        <div class="subscribe-pill">${escapeHtml(WATERMARK)}</div>
      </div>
    </section>
    <div class="watermark">${escapeHtml(WATERMARK)}</div>
    <div class="progress"><div class="progress-inner"></div></div>
    <audio id="background-music" data-start="0" data-duration="${TOTAL_SECONDS}" data-track-index="10" data-volume="0.42" src="assets/background01.mp3"></audio>
  </div>
  <script>
    window.__hfDuration = ${TOTAL_SECONDS};
    window.__hfFps = ${FPS};
    const scenes = [...document.querySelectorAll(".scene")];
    const outro = document.querySelector(".outro");
    const progress = document.querySelector(".progress-inner");
    let seek;

    if (window.gsap) {
      const master = gsap.timeline({ paused: true });
      scenes.forEach((scene, index) => {
        const start = index * ${SCENE_SECONDS};
        const photo = scene.querySelector(".bg-photo");
        const source = scene.querySelector(".source-row");
        const title = scene.querySelector(".hook-title");
        const titleWords = scene.querySelectorAll(".hook-title span");
        const summary = scene.querySelector(".lead");
        master.to(scene, { opacity: 1, y: 0, scale: 1, duration: 0.28, ease: "power3.out" }, start);
        master.fromTo(source, { y: -24, opacity: 0 }, { y: 0, opacity: 1, duration: .35, ease: "power3.out" }, start + .05);
        master.fromTo(title, { y: 44, opacity: 0 }, { y: 0, opacity: 1, duration: .35, ease: "power3.out" }, start + .22);
        master.fromTo(titleWords, { y: 46, rotateX: -52, opacity: 0, scale: .92 }, { y: 0, rotateX: 0, opacity: 1, scale: 1, stagger: .018, duration: .46, ease: "back.out(1.55)" }, start + .28);
        master.fromTo(summary, { y: 46, opacity: 0, clipPath: "inset(0 0 100% 0)" }, { y: 0, opacity: 1, clipPath: "inset(0 0 0% 0)", duration: .56, ease: "power3.out" }, start + 1.05);
        master.to(scene.querySelector(".accent-a"), { rotate: 22, scale: 1.12, duration: ${SCENE_SECONDS}, ease: "none" }, start);
        master.to(scene.querySelector(".accent-b"), { y: -80, duration: ${SCENE_SECONDS}, ease: "sine.inOut" }, start);
        if (photo) master.to(photo, { scale: 1.12, x: index % 2 ? 32 : -32, y: index % 3 ? -18 : 18, duration: ${SCENE_SECONDS}, ease: "none" }, start);
        master.to(scene, { opacity: 0, y: -80, scale: 1.02, duration: .34, ease: "power3.in" }, start + ${SCENE_SECONDS - 0.34});
      });
      const outroInner = outro.querySelector(".outro-inner");
      master.to(outro, { opacity: 1, duration: .28, ease: "power3.out" }, ${outroStart});
      master.fromTo(outroInner.children, { y: 54, opacity: 0, scale: .92 }, { y: 0, opacity: 1, scale: 1, stagger: .14, duration: .58, ease: "back.out(1.6)" }, ${outroStart} + .15);
      master.to(outro.querySelector(".subscribe-icon"), { scale: 1.08, repeat: 3, yoyo: true, duration: .32, ease: "sine.inOut" }, ${outroStart} + 1.1);
      master.to(outro, { opacity: 0, duration: .25, ease: "power2.in" }, ${TOTAL_SECONDS} - .25);
      master.to(progress, { width: "100%", duration: ${TOTAL_SECONDS}, ease: "none" }, 0);
      seek = (t) => master.time(Math.max(0, Math.min(${TOTAL_SECONDS}, t)));
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
        const t = clamp(time, 0, ${TOTAL_SECONDS});
        progress.style.width = (t / ${TOTAL_SECONDS} * 100) + "%";
        scenes.forEach((scene, index) => {
          const local = t - index * ${SCENE_SECONDS};
          const visible = local >= 0 && local <= ${SCENE_SECONDS};
          let opacity = visible ? 1 : 0;
          let y = 0;
          let scale = 1;
          if (visible && local < .28) {
            const p = easeOut(local / .28);
            opacity = p; y = 70 * (1 - p); scale = .985 + .015 * p;
          }
          if (visible && local > ${SCENE_SECONDS - 0.34}) {
            const p = easeIn((local - ${SCENE_SECONDS - 0.34}) / .34);
            opacity = 1 - p; y = -80 * p; scale = 1 + .02 * p;
          }
          set(scene, opacity, y, scale);
          set(scene.querySelector(".source-row"), easeOut((local - .05) / .35), -24 * (1 - easeOut((local - .05) / .35)), 1);
          set(scene.querySelector(".hook-title"), easeOut((local - .22) / .35), 44 * (1 - easeOut((local - .22) / .35)), 1);
          scene.querySelectorAll(".hook-title span").forEach((word, wordIndex) => {
            const p = easeOut((local - .28 - wordIndex * .018) / .46);
            word.style.opacity = String(p);
            word.style.transform = "translateY(" + (46 * (1 - p)) + "px) scale(" + (.92 + .08 * p) + ")";
          });
          const leadP = easeOut((local - 1.05) / .56);
          set(scene.querySelector(".lead"), leadP, 46 * (1 - leadP), 1);
          const photo = scene.querySelector(".bg-photo");
          if (photo) {
            const p = clamp(local / ${SCENE_SECONDS});
            const x = (index % 2 ? 32 : -32) * p;
            const py = (index % 3 ? -18 : 18) * p;
            photo.style.transform = "translate(" + x + "px," + py + "px) scale(" + (1.03 + .09 * p) + ")";
          }
          const accentA = scene.querySelector(".accent-a");
          const accentB = scene.querySelector(".accent-b");
          if (accentA) accentA.style.transform = "rotate(" + (22 * clamp(local / ${SCENE_SECONDS})) + "deg) scale(" + (1 + .12 * clamp(local / ${SCENE_SECONDS})) + ")";
          if (accentB) accentB.style.transform = "translateY(" + (-80 * clamp(local / ${SCENE_SECONDS})) + "px) rotate(8deg)";
        });
        const outroLocal = t - ${outroStart};
        const outroVisible = outroLocal >= 0 && outroLocal <= ${OUTRO_SECONDS};
        outro.style.opacity = String(outroVisible ? 1 : 0);
        [...outro.querySelector(".outro-inner").children].forEach((child, index) => {
          const p = easeOut((outroLocal - .15 - index * .14) / .58);
          child.style.opacity = String(p);
          child.style.transform = "translateY(" + (54 * (1 - p)) + "px) scale(" + (.92 + .08 * p) + ")";
        });
      };
    }

    window.__hyperframes = { duration: ${TOTAL_SECONDS}, fps: ${FPS}, seek };
    window.__timelines = window.__timelines || {};
    window.__timelines.root = { duration: ${TOTAL_SECONDS}, seek };
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
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `Get-Command ${command} -ErrorAction SilentlyContinue`], { encoding: "utf8" });
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
  const result = spawnSync("npx", ["hyperframes", "render", "--output", output, "--fps", String(FPS), "--quality", "high"], {
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
  const outDir = path.resolve("outputs", "vnexpress", now.date, slot);
  const imageDir = path.join(outDir, "assets");
  await mkdir(outDir, { recursive: true });

  const xml = await fetchText(RSS_URL);
  let items = parseItems(xml);
  if (items.length === 0) throw new Error("RSS returned no items; aborting render.");
  items = await enrichArticles(items);
  items = items.slice(0, NEWS_COUNT).map((item, index) => ({
    ...item,
    index: index + 1,
    hook: item.hook || item.title
  }));
  items = await downloadImages(items, imageDir);

  const html = renderComposition(items);
  await writeFile(path.join(outDir, "index.html"), html, "utf8");
  await writeFile(path.join(outDir, "news.json"), JSON.stringify({
    source: RSS_URL,
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Bangkok",
    slot,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSeconds: TOTAL_SECONDS,
    backgroundAudio: BACKGROUND_AUDIO,
    watermark: WATERMARK,
    items
  }, null, 2), "utf8");

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

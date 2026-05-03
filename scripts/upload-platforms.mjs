import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const GRAPH_VERSION = "v23.0";
const CAPTION =
  "10 tin nổi bật hôm nay. Theo dõi @tintucchatluong để cập nhật tin tức nhanh mỗi sáng và tối. #tintuc #vnexpress #tintucchatluong";

export async function writeCaption(outDir) {
  const captionPath = path.join(outDir, "caption.txt");
  await writeFile(captionPath, CAPTION, "utf8");
  return CAPTION;
}

export async function uploadToPlatforms({ outDir, videoPath, dryRun = false }) {
  const env = await loadEnv();
  const caption = await writeCaption(outDir);
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    caption,
    videoPath,
    platforms: {}
  };
  const errors = {};

  if (!dryRun && String(env.UPLOAD_ENABLED || "").toLowerCase() !== "true") {
    for (const platform of ["facebook", "youtube", "tiktok"]) {
      report.platforms[platform] = skipped("UPLOAD_ENABLED is not true");
    }
    await writeJson(path.join(outDir, "upload-report.json"), report);
    return report;
  }

  const jobs = [
    ["facebook", uploadFacebookReel],
    ["youtube", uploadYoutubeShort],
    ["tiktok", uploadTikTok]
  ];

  for (const [platform, upload] of jobs) {
    try {
      report.platforms[platform] = await upload({ env, caption, videoPath, dryRun });
    } catch (error) {
      report.platforms[platform] = { status: "failed", error: error.message };
      errors[platform] = {
        message: error.message,
        stack: error.stack
      };
    }
  }

  await writeJson(path.join(outDir, "upload-report.json"), report);
  if (Object.keys(errors).length > 0) {
    await writeJson(path.join(outDir, "upload-errors.json"), errors);
  }
  return report;
}

async function loadEnv() {
  const env = { ...process.env };
  const envPath = path.resolve(".env");
  try {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    // .env is optional; missing credentials become skipped platform statuses.
  }
  return env;
}

function missing(env, keys) {
  return keys.filter((key) => !env[key]);
}

function skipped(reason, missingKeys = []) {
  return { status: "skipped", reason, missing: missingKeys };
}

async function uploadFacebookReel({ env, caption, videoPath, dryRun }) {
  const missingKeys = missing(env, ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"]);
  if (missingKeys.length) return skipped("missing_facebook_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const pageId = env.FACEBOOK_PAGE_ID;
  const accessToken = env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const videoSize = (await stat(videoPath)).size;

  const start = await graphPost(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    access_token: accessToken,
    upload_phase: "start"
  });
  const videoId = start.video_id;
  if (!videoId) throw new Error(`Facebook did not return video_id: ${JSON.stringify(start)}`);

  const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH_VERSION}/${videoId}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      offset: "0",
      file_size: String(videoSize),
      "Content-Type": "application/octet-stream"
    },
    body: createReadStream(videoPath),
    duplex: "half"
  });
  await requireOk(uploadResponse, "Facebook reel binary upload failed");

  const finish = await graphPost(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    access_token: accessToken,
    upload_phase: "finish",
    video_id: videoId,
    video_state: "PUBLISHED",
    description: caption,
    title: "10 tin nổi bật hôm nay"
  });

  return {
    status: "published",
    videoId,
    response: finish
  };
}

async function uploadYoutubeShort({ env, caption, videoPath, dryRun }) {
  const missingKeys = missing(env, ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]);
  if (missingKeys.length) return skipped("missing_youtube_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const accessToken = await refreshYoutubeAccessToken(env);
  const boundary = `codex_vnexpress_${Date.now()}`;
  const metadata = {
    snippet: {
      title: "10 tin nổi bật hôm nay #Shorts",
      description: caption,
      categoryId: "25",
      tags: ["tin tức", "vnexpress", "tintucchatluong", "shorts"]
    },
    status: {
      privacyStatus: "private",
      selfDeclaredMadeForKids: false
    }
  };
  const video = await readFile(videoPath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    video,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length)
    },
    body
  });
  const json = await requireJsonOk(response, "YouTube upload failed");
  return {
    status: "uploaded",
    privacyStatus: "private",
    videoId: json.id,
    url: json.id ? `https://www.youtube.com/watch?v=${json.id}` : undefined,
    response: json
  };
}

async function uploadTikTok({ env, caption, videoPath, dryRun }) {
  const missingKeys = missing(env, ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"]);
  if (missingKeys.length) return skipped("missing_tiktok_credentials", missingKeys);
  if (dryRun) return { status: "skipped", reason: "dry_run" };

  const accessToken = await refreshTikTokAccessToken(env);
  const creator = await tiktokPost("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", accessToken, {});
  const options = creator.data?.privacy_level_options || [];
  if (!options.includes("SELF_ONLY")) {
    throw new Error(`TikTok creator privacy options do not include SELF_ONLY: ${JSON.stringify(options)}`);
  }

  const videoSize = (await stat(videoPath)).size;
  const init = await tiktokPost("https://open.tiktokapis.com/v2/post/publish/video/init/", accessToken, {
    post_info: {
      title: caption,
      privacy_level: "SELF_ONLY",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
      brand_content_toggle: false,
      brand_organic_toggle: false
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: videoSize,
      total_chunk_count: 1
    }
  });

  const uploadUrl = init.data?.upload_url;
  const publishId = init.data?.publish_id;
  if (!uploadUrl || !publishId) throw new Error(`TikTok did not return upload_url/publish_id: ${JSON.stringify(init)}`);

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(videoSize),
      "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`
    },
    body: createReadStream(videoPath),
    duplex: "half"
  });
  await requireOk(uploadResponse, "TikTok binary upload failed");

  return {
    status: "uploaded",
    privacyStatus: "SELF_ONLY",
    publishId
  };
}

async function refreshYoutubeAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await requireJsonOk(response, "YouTube token refresh failed");
  return json.access_token;
}

async function refreshTikTokAccessToken(env) {
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    refresh_token: env.TIKTOK_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const json = await requireJsonOk(response, "TikTok token refresh failed");
  return json.access_token;
}

async function tiktokPost(url, accessToken, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body)
  });
  const json = await requireJsonOk(response, `TikTok request failed: ${url}`);
  if (json.error && json.error.code !== "ok") {
    throw new Error(`TikTok API error ${json.error.code}: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json;
}

async function graphPost(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    body: new URLSearchParams(fields)
  });
  return requireJsonOk(response, `Facebook Graph request failed: ${url}`);
}

async function requireOk(response, label) {
  if (response.ok) return;
  const text = await response.text();
  throw new Error(`${label}: HTTP ${response.status} ${text}`);
}

async function requireJsonOk(response, label) {
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}: HTTP ${response.status} non-json response ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

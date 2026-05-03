# VnExpress Hot News Video Automation

This workspace builds a vertical MP4 from VnExpress "Tin noi bat" RSS and can upload it to Facebook Reels, YouTube Shorts, and TikTok.

## What It Produces

- `1080x1920`, `30fps`, about `83s`
- 10 news scenes, 8 seconds each
- a short subscribe/follow end screen
- background music from `E:\20.tainguyen\background01.mp3`
- article images as animated full-screen backgrounds when available
- watermark: `@tintucchatluong`
- outputs under `outputs/vnexpress/YYYY-MM-DD/0700/` or `outputs/vnexpress/YYYY-MM-DD/1900/`

Each run writes:

- `index.html` - HyperFrames HTML composition
- `news.json` - source metadata, article title hooks, leads, and downloaded image paths
- `caption.txt` - fixed social caption
- `upload-report.json` - per-platform upload result when upload is requested
- `upload-errors.json` - per-platform upload errors when any API call fails
- `final.mp4` - rendered video, when HyperFrames/FFmpeg are available
- `error.log` - written on failure

## Requirements

- Node.js 22 or newer
- `npx`
- FFmpeg and FFprobe on PATH
- HyperFrames runnable with `npx hyperframes`
- background music file at `E:\20.tainguyen\background01.mp3`
- `.env` copied from `.env.example` with OAuth/API credentials and `UPLOAD_ENABLED=true`

HyperFrames environment check:

```powershell
npx hyperframes doctor
```

## Commands

Generate metadata and composition only:

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 0700 -SkipRender
```

Generate and render the morning video:

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 0700
```

Generate and render the evening video:

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 1900
```

Generate, render, and upload the morning video:

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 0700 -Upload
```

Validate upload configuration without calling platform APIs:

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 0700 -SkipRender -DryRunUpload
```

Equivalent package scripts are available when `node` and `npm` are both on PATH:

```powershell
npm run vnexpress:morning
npm run vnexpress:evening
npm run vnexpress:morning:upload
npm run vnexpress:evening:upload
```

## Upload Status

- Facebook Page Reels publishes public immediately.
- YouTube uploads with `privacyStatus=private`.
- TikTok uses `SELF_ONLY` and fails TikTok only if the creator account does not expose that privacy option.
- If one platform fails, the other platforms continue and the error is written to `upload-errors.json`.

## Notes

The script opens each VnExpress article and uses the article `h1` as the hook and the lead paragraph as the summary. If a feed item has no image, it tries the article `og:image`; if that also fails, the scene uses an animated fallback background. Article photos are used directly with motion and overlays, not blurred.

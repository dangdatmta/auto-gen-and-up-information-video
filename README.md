# VnExpress Hot News Video Automation

Tự động tạo video dọc MP4 từ RSS VnExpress "Tin nổi bật" và upload lên Facebook Reels, YouTube Shorts, TikTok.

## What It Produces

- `1080x1920`, `30fps`, khoảng `25-45s` cho YouTube Shorts
- 3-5 cảnh tin tức, xếp theo `viralScore`; tin mạnh nhất mở ngay frame đầu
- Màn hình subscribe/follow cuối video
- Nhạc nền từ `assets/background01.mp3` (hoặc cấu hình qua `BACKGROUND_AUDIO_PATH`)
- Có thể bật giọng đọc hook/title cho từng cảnh bằng VieNeu-TTS qua `HOOK_TTS_ENABLED=true`
- Ảnh bài báo làm background động toàn màn hình khi có
- Watermark: `@tintucchatluong`
- Output tại `outputs/vnexpress/YYYY-MM-DD/0700/`, `outputs/vnexpress/YYYY-MM-DD/1200/`, hoặc `outputs/vnexpress/YYYY-MM-DD/2000/`
- Lọc tin theo `pubDate` từng khung giờ để tránh trùng lặp: 0700 (20:02→07:00), 1200 (07:02→12:00), 2000 (12:02→20:00)

Mỗi lần chạy tạo ra:

- `index.html` — HyperFrames HTML composition
- `news.json` — metadata, hook, lead, đường dẫn ảnh đã tải
- `caption.txt` — caption sinh theo tin dẫn đầu, nguồn và hashtag
- `video-experiment.json` — hook/title/caption variant, tin dẫn đầu, duration, hashtag, slot
- `upload-report.json` — kết quả upload từng nền tảng
- `upload-errors.json` — lỗi upload (nếu có)
- `final.mp4` — video đã render (khi HyperFrames/FFmpeg sẵn sàng)
- `error.log` — ghi khi thất bại

## Requirements

- Node.js 22 hoặc mới hơn
- `npx`
- FFmpeg và FFprobe trên PATH
- HyperFrames: `npx hyperframes`
- File nhạc nền (xem phần cấu hình bên dưới)
- Tuỳ chọn: Python env có VieNeu-TTS SDK nếu bật `HOOK_TTS_ENABLED=true`
- `.env` copy từ `.env.example` với credentials OAuth/API và `UPLOAD_ENABLED=true`

Kiểm tra HyperFrames:

```bash
npx hyperframes doctor
```

### Cài đặt trên macOS

```bash
# Node.js >= 22
brew install node

# FFmpeg
brew install ffmpeg

# Kiểm tra
node --version    # v22+
ffmpeg -version
npx hyperframes doctor
```

### Cài đặt trên Windows

```powershell
# Node.js >= 22: tải từ https://nodejs.org hoặc winget
winget install OpenJS.NodeJS.LTS

# FFmpeg: tải từ https://ffmpeg.org/download.html, thêm vào PATH
```

## Cấu hình nhạc nền

Có 2 cách cấu hình file nhạc nền `background01.mp3`:

**Cách 1 (khuyến nghị):** Đặt file vào `assets/background01.mp3` trong thư mục repo
```
auto-gen-and-up-information-video/
└── assets/
    └── background01.mp3   ← đặt file nhạc vào đây
```

**Cách 2:** Dùng biến môi trường trong `.env`
```env
# macOS/Linux
BACKGROUND_AUDIO_PATH=/Users/yourname/music/background01.mp3

# Windows
BACKGROUND_AUDIO_PATH=E:\20.tainguyen\background01.mp3
```

## Cấu hình giọng đọc hook

Local mặc định tắt TTS. Bật trong `.env` khi muốn tạo file voice cho từng cảnh:

```env
HOOK_TTS_ENABLED=true
HOOK_TTS_PROVIDER=vieneu
HOOK_TTS_PYTHON=/path/to/python-with-vieneu
HOOK_TTS_START_OFFSET=0.45
HOOK_TTS_MAX_SECONDS=6.8
HOOK_TTS_VOLUME=1.0
BACKGROUND_VOLUME=0.42
BACKGROUND_VOLUME_WITH_TTS=0.25
VIENEU_MODE=standard
VIENEU_EMOTION=natural
VIENEU_VOICE_ID=
VIENEU_API_BASE=
VIENEU_MODEL_NAME=pnnbao-ump/VieNeu-TTS-v2
```

Ví dụ tạo Python env riêng:

```bash
python3 -m venv .venv-vieneu
.venv-vieneu/bin/python -m pip install --upgrade pip
.venv-vieneu/bin/python -m pip install vieneu
HOOK_TTS_ENABLED=true HOOK_TTS_PYTHON=.venv-vieneu/bin/python ./run.sh --slot 0700 --skip-render
```

Không commit `.venv-vieneu/` hoặc `.vnexpress-state/`. Khi bật TTS, `news.json` sẽ có block `hookTts`, từng item có `hookAudio`, và `index.html` sẽ có các `<audio class="hook-audio">` bắt đầu theo `item.startSeconds + HOOK_TTS_START_OFFSET`.

## Commands

### macOS / Linux

Generate metadata (không render):

```bash
./run.sh --slot 0700 --skip-render
```

Generate và render video buổi sáng:

```bash
./run.sh --slot 0700
```

Generate và render video buổi trưa:

```bash
./run.sh --slot 1200
```

Generate và render video buổi tối:

```bash
./run.sh --slot 2000
```

Generate, render và upload buổi sáng:

```bash
./run.sh --slot 0700 --upload
```

Validate upload config (không gọi API thật):

```bash
./run.sh --slot 0700 --skip-render --dry-run-upload
```

### Windows (PowerShell)

```powershell
.\Run-VnExpressHotNews.ps1 -Slot 0700
.\Run-VnExpressHotNews.ps1 -Slot 1200 -Upload
.\Run-VnExpressHotNews.ps1 -Slot 2000 -Upload
.\Run-VnExpressHotNews.ps1 -Slot 0700 -SkipRender -DryRunUpload
```

### npm scripts (đa nền tảng)

```bash
npm run vnexpress:morning         # slot 07:00
npm run vnexpress:noon            # slot 12:00
npm run vnexpress:evening         # slot 20:00
npm run vnexpress:morning:upload
npm run vnexpress:noon:upload
npm run vnexpress:evening:upload
npm run vnexpress:upload:dry-run
```

## Docker (đa nền tảng)

Đặt `background01.mp3` vào thư mục `assets/`, copy `.env.example` thành `.env`:

```bash
cp .env.example .env
mkdir -p assets outputs
# copy file nhạc nền vào assets/background01.mp3
```

Build image:

```bash
docker compose build
```

Chạy:

```bash
# Buổi sáng (generate + render + upload)
docker compose run --rm vnexpress-morning

# Buổi trưa
docker compose run --rm vnexpress-noon

# Buổi tối
docker compose run --rm vnexpress-evening

# Chỉ generate, không render (test nhanh)
docker compose run --rm vnexpress-generate

# Dry-run upload
docker compose run --rm vnexpress-dry-run
```

Hoặc dùng `docker run` trực tiếp:

```bash
docker compose run --rm vnexpress-morning --slot 0700 --skip-render
```

## Upload Status

- **Facebook Page Reels**: publish public ngay lập tức.
- **YouTube**: upload Shorts public với metadata sinh theo tin dẫn đầu.
- **TikTok**: dùng `SELF_ONLY`; thất bại nếu tài khoản creator không hỗ trợ privacy option đó.
- Nếu một nền tảng lỗi, các nền tảng còn lại vẫn tiếp tục; lỗi được ghi vào `upload-errors.json`.

## GitHub Actions Video 5s

Workflow `.github/workflows/video-5s.yml` chạy trên nhánh `feature/video-5s`, dùng secrets prefix riêng `VIDEO5S_*` cho cả upload và TTS. TTS bật mặc định trên CI bằng `VIDEO5S_HOOK_TTS_ENABLED` fallback `true`; có thể tắt bằng secret `VIDEO5S_HOOK_TTS_ENABLED=false`.

Các secret TTS chính: `VIDEO5S_HOOK_TTS_PROVIDER`, `VIDEO5S_HOOK_TTS_START_OFFSET`, `VIDEO5S_HOOK_TTS_MAX_SECONDS`, `VIDEO5S_HOOK_TTS_VOLUME`, `VIDEO5S_BACKGROUND_VOLUME`, `VIDEO5S_BACKGROUND_VOLUME_WITH_TTS`, `VIDEO5S_VIENEU_MODE`, `VIDEO5S_VIENEU_EMOTION`, `VIDEO5S_VIENEU_VOICE_ID`, `VIDEO5S_VIENEU_API_BASE`, `VIDEO5S_VIENEU_MODEL_NAME`, `VIDEO5S_HF_TOKEN`.

## Notes

Script mở từng bài báo VnExpress, lấy `h1` làm hook và đoạn lead làm summary, rồi chấm `viralScore` theo độ mới, con số lớn, tiền/phạt/chính sách, thể thao nóng và tác động đời sống. Nếu feed item không có ảnh, thử `og:image` của bài báo; nếu vẫn không có, dùng background animated fallback. Ảnh bài báo được dùng trực tiếp với motion và overlay, không blur.

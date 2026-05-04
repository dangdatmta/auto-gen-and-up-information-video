# syntax=docker/dockerfile:1
FROM node:22-slim

LABEL maintainer="tintucchatluong" \
      description="VnExpress Hot News Video Automation"

# Cài FFmpeg + các font CJK/Việt cho Chromium (dùng bởi HyperFrames/Puppeteer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    fonts-noto-cjk \
    fonts-noto \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Báo cho Puppeteer/HyperFrames biết dùng Chromium hệ thống, không tự download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_FLAGS="--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage"

WORKDIR /app

# Copy package.json trước để tận dụng Docker layer cache
COPY package.json ./
RUN npm install --ignore-scripts 2>/dev/null || true

# Copy source scripts
COPY scripts/ ./scripts/
COPY .env.example ./

# assets/ — nơi đặt background01.mp3 (mount từ host)
# outputs/ — video output (mount từ host)
VOLUME ["/app/assets", "/app/outputs"]

ENTRYPOINT ["node", "scripts/vnexpress-hot-news.mjs"]
CMD ["--slot", "0700"]

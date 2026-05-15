#!/usr/bin/env bash
# run.sh — Tương đương Run-VnExpressHotNews.ps1 cho macOS/Linux
# Cách dùng:
#   ./run.sh --slot 0700
#   ./run.sh --slot 0900 --upload
#   ./run.sh --upload
#   ./run.sh --slot 0700 --skip-render
#   ./run.sh --slot 0700 --skip-render --dry-run-upload
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$ROOT/scripts/vnexpress-hot-news.mjs"

SLOT=""
SKIP_RENDER=""
UPLOAD=""
DRY_RUN=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --slot)
      SLOT="$2"
      shift 2
      ;;
    --skip-render)
      SKIP_RENDER="--skip-render"
      shift
      ;;
    --upload)
      UPLOAD="--upload"
      shift
      ;;
    --dry-run-upload)
      DRY_RUN="--dry-run-upload"
      shift
      ;;
    -h|--help)
      echo "Usage: ./run.sh [--slot HHMM] [--skip-render] [--upload] [--dry-run-upload]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: ./run.sh [--slot HHMM] [--skip-render] [--upload] [--dry-run-upload]"
      exit 1
      ;;
  esac
done

# Kiểm tra Node.js
if ! command -v node &>/dev/null; then
  echo "❌  Node.js không tìm thấy. Hãy cài Node.js >= 22 trước khi chạy script này."
  echo "    macOS: brew install node  hoặc  https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_VERSION" -lt 22 ]]; then
  echo "❌  Cần Node.js >= 22, đang dùng v$(node --version). Hãy nâng cấp."
  exit 1
fi

ARGS=("$SCRIPT")
[[ -n "$SLOT" ]]        && ARGS+=(--slot "$SLOT")
[[ -n "$SKIP_RENDER" ]] && ARGS+=("$SKIP_RENDER")
[[ -n "$UPLOAD" ]]      && ARGS+=("$UPLOAD")
[[ -n "$DRY_RUN" ]]     && ARGS+=("$DRY_RUN")

cd "$ROOT"
node "${ARGS[@]}"

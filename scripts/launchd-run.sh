#!/bin/bash
# launchd(LaunchAgent) 전용 백그라운드 런처.
# ~/Library/LaunchAgents/com.selltkey.scrapper.plist 가 이 스크립트를 호출한다.
# - 로그인/재부팅 시 자동 시작, 크래시/종료 시 launchd 가 자동 재시작(KeepAlive).
# - 터미널 창 없이 상시 가동. 대시보드는 http://localhost:${SCRAPPER_PORT:-4478}
# 사전: AdsPower 앱 실행+로그인+Local API on (별도 로그인 항목 등록 필요).

set -euo pipefail

# 이 스크립트 위치(scripts/) 기준으로 프로젝트 루트 이동
cd "$(dirname "$0")/.."

# launchd 환경은 PATH 가 최소라 bun/brew 경로를 명시적으로 보장
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun not found in PATH: $PATH" >&2
  exit 127
fi

# 디스플레이/시스템 sleep 방지 + UI 빌드 + 서버 상주(foreground → launchd 가 감시)
exec caffeinate -s bun run start

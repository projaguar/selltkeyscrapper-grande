#!/bin/bash
# scrapper 실행 런처 (더블클릭). 이 파일 위치를 기준으로 프로젝트를 찾는다.
# 사용: 바탕화면에 이 파일의 "가명(alias)"을 만들어 두고 더블클릭.
#   - 이 터미널 창이 곧 "돌고 있음" 표시 + 실시간 로그. 창을 닫으면 종료됨.
#   - 사전: AdsPower 실행+로그인+Local API on, bun 설치, (최초 1회) bun install.

set -e
cd "$(dirname "$0")"

# bun 경로 보장 (더블클릭 시 PATH 가 제한적일 수 있음)
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "❌ bun 이 설치되어 있지 않습니다. https://bun.sh 에서 설치 후 다시 실행하세요."
  echo "   설치: curl -fsSL https://bun.sh/install | bash"
  read -r -p "엔터를 누르면 창을 닫습니다..." _
  exit 1
fi

PORT="${SCRAPPER_PORT:-4478}"

echo "▶ scrapper 시작 — 대시보드: http://localhost:${PORT}"
echo "   (이 창을 닫으면 크롤링도 멈춥니다. 상시 가동하려면 창을 열어두세요.)"

# 서버 뜨면 대시보드를 Chrome 앱 창으로 자동 오픈 (백그라운드)
(
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:${PORT}/"; then break; fi
    sleep 1
  done
  open -na "Google Chrome" --args --app="http://localhost:${PORT}" 2>/dev/null \
    || open "http://localhost:${PORT}"
) &

# 디스플레이 sleep 방지 + UI 빌드 + 서버 상주 (foreground)
exec caffeinate -s bun run start

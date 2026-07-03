# AdsPower Scrapper

AdsPower 안티디텍트 브라우저로 네이버를 크롤링하는 자동화 도구.
**Bun 데몬 + 웹 대시보드** 구조(구 Electron → 마이그레이션 완료).

## 기술 스택

- **Bun** — 런타임 + 서버(`Bun.serve`) + 패키지 매니저 + `bun:sqlite`
- **React 19 + Vite 7 + TailwindCSS 4** — 웹 대시보드(정적 빌드)
- **puppeteer-core** — CDP 브라우저 자동화
- **Zustand** — 상태 관리
- **TypeScript**

## 구조

```
src/
├── server.ts            # Bun.serve — 정적 UI + /api/rpc + /ws (구 Electron main 대체)
├── data-dir.ts          # 데이터 경로 (기존 userData DB 재사용)
├── renderer/            # React 대시보드
│   ├── main.tsx         # 진입점 (web-api 설치)
│   ├── web-api.ts       # window.electronAPI 어댑터 (fetch + WebSocket)
│   └── App.tsx
├── components/          # Dashboard / ProxyManager / Settings / ui
├── services/
│   ├── adspower.ts      # AdsPower Local API (그룹/프로필/브라우저)
│   └── api.ts           # 작업 URL 서버 API
├── lib/
│   ├── crawler.ts       # 크롤 메인 루프 (Producer-Consumer)
│   ├── crawler/
│   │   ├── profile-pool.ts    # 그룹 격리 프로필 풀 (자동 생성/흡수/재생성)
│   │   ├── browser-manager.ts # CrawlerBrowser 생명주기
│   │   ├── CrawlerBrowser.ts
│   │   └── ...
│   └── proxy-pool.ts    # 프록시 순환
└── database/sqlite.ts   # bun:sqlite
```

## AdsPower 공유 (한 머신에 여러 앱)

이 도구는 **전용 AdsPower 그룹**(기본 `scrapper`) 안에서만 프로필을 다룬다.
프로필은 사용자 개입 없이 자동으로 확보된다:

1. 그룹 내 기존 프로필 재사용
2. 부족하면 미분류(그룹 0) 레거시 프로필을 그룹으로 흡수(regroup)
3. 그래도 부족하면 데스크탑 지문으로 신규 생성
4. 블록 감지 시 삭제 → 그룹 내 재생성

덕분에 같은 머신·같은 AdsPower 계정을 쓰는 다른 앱(예: `prowler` 그룹)의
프로필과 절대 섞이지 않는다. 그룹 이름/동시 개수는 대시보드 **설정**에서 변경.

> AdsPower Local API 는 **초당 1회** 제한 → 모든 호출은 1.1s 간격 큐를 통과.
> 무료 계정은 프로필 총 2개 한도.

## 실행

사전: **AdsPower 데스크탑 앱 실행 + 로그인 + Local API on** (`http://localhost:50325`).

```bash
bun install

# 대시보드 UI 빌드 (dist/)
bun run build

# 서버 + 워커 상주 (대시보드: http://localhost:4478)
bun run start        # 또는 개발용: bun run dev (watch)
```

- UI 만 반복 수정할 땐 `bun run dev:ui`(Vite HMR, `/api`·`/ws` 는 서버로 프록시).
- 환경변수: `SCRAPPER_PORT`(기본 4478), `ADSPOWER_API_KEY`, `SCRAPPER_DATA_DIR`.
- 상시 가동은 `caffeinate -s bun run start` + 대시보드를 Chrome 앱 창으로 권장.

## 사용

1. **설정** — AdsPower API Key, 그룹 이름(`scrapper`), 동시 프로필 개수 저장 → 연결 테스트.
2. **Proxy 관리** — 프록시 대량 붙여넣기(그룹별). 상태/통계 확인.
3. **대시보드** — 브라우저 준비(그룹 풀 자동 확보) → 크롤링 시작 → 진행/로그 모니터링.

## 데이터

`bun:sqlite` DB — 기본 경로는 기존 앱과 동일(`~/Library/Application Support/selltkeyscrapper-grande/data.db`),
`SCRAPPER_DATA_DIR` 로 변경 가능. 프록시/설정을 보관한다.

# scrapper 배포 / 환경설정 핸드오프

> **이 문서를 읽는 세션(omp 등)에게**: 이 리포는 Electron → **Bun + 웹 대시보드**로 마이그레이션됐고,
> AdsPower 프로필을 **전용 그룹 안에서 완전 자동 관리**한다. 아래 "① 환경설정 런북"을 그대로 실행하면
> 대상 맥에서 구동된다. "④ 검증 체크리스트"로 정상 여부를 확인한다.
> 브랜치 `feat/adspower-group-and-bun-migration` (main 미병합 — 며칠 검증 후 병합 예정).

---

## 0. 무엇이 바뀌었나 (컨텍스트)

- **런타임**: Electron(main/preload) 제거 → `src/server.ts`(`Bun.serve`). UI는 Vite로 빌드한 정적 `dist/`를 서빙 + `/api/rpc`(fetch) + `/ws`(진행 이벤트). 워커(크롤러)는 이 서버 프로세스에 상주 → **대시보드 탭 닫아도 크롤링 지속**.
- **DB**: `better-sqlite3` → `bun:sqlite`. **기존 userData DB를 그대로 재사용**(프록시·설정 보존).
- **AdsPower 프로필**: 수동 관리 UI 제거. **전용 그룹(기본 `scrapper`) 안에서만** 필요 개수(기본 2)를 생성/재사용/블록 시 재생성. **기존/미분류 프로필·타 앱(prowler) 프로필은 절대 건드리지 않음**(흡수/이동 없음).
- **주요 수정**:
  - 주입 링크 클릭 `page.click()`(CDP 마우스) → **DOM 클릭**(`el.click()`). 일부 AdsPower SunBrowser 버전에서 CDP 클릭이 안 먹혀 링크 이동이 안 되던 문제 해결.
  - 네이버 캡차/차단 **즉시 감지 → 새 지문 프로필 + 새 프록시로 재생성** 경로로 라우팅(기존엔 30초 대기 후 프록시만 교체).
  - AdsPower 큐 간격 510ms → **1100ms**(로컬 API 초당 1회 한도).
  - 리뷰 반영: 프로필 부족분 표면화, createGroup 검증, 설정 저장 에러 알림, `start`가 dist 빌드 선행 등.
- **라이브 검증(사무실)**: 프로필 2개로 실크롤 완료 87건, prowler 2개와 동시 가동 시 **그룹 격리 유지·rate-limit 충돌 0·오류 0**.

---

## 1. 환경설정 런북 (omp가 순서대로 실행)

### 사전 조건 (대상 맥)
- macOS + **Bun** 설치 (`command -v bun`; 없으면 `curl -fsSL https://bun.sh/install | bash`).
- **AdsPower 데스크탑 앱 실행 + 로그인 + Local API on** (`http://localhost:50325`).
- 프록시 서비스에 **그 맥의 공인 IP를 화이트리스트 등록** (← 실크롤 유일한 필수 관문. 안 하면 전부 timeout).

### 절차
```bash
# 1. 브랜치 확보 (미병합 검증 브랜치)
cd <repo>
git fetch origin
git checkout feat/adspower-group-and-bun-migration
git pull

# 2. 의존성
bun install

# 3. AdsPower Local API 확인 (code:0 이어야 함)
curl -s http://localhost:50325/status    # → {"code":0,"msg":"success"}

# 4. UI 빌드 + 서버 기동 (둘 중 하나)
bun run start        # vite build + 서버 (권장, 상시 가동)
# 또는 비개발자: 파인더에서 start.command 더블클릭
```
- 대시보드: `http://localhost:4478` (포트 변경: `SCRAPPER_PORT`).

### API 키 / 설정
- AdsPower API 키: **대상 맥의 AdsPower 계정 키**여야 함.
  - 우선순위: 환경변수 `ADSPOWER_API_KEY` → (없으면) DB 저장값 → (없으면) `src/server.ts`의 하드코딩 기본값.
  - **다른 계정이면** 대시보드 "설정"에서 키 저장(또는 `ADSPOWER_API_KEY`로 실행). UI 저장 키는 재기동해도 유지됨(env가 있을 때만 덮어씀).
- 대시보드 "설정": **그룹 이름**(기본 `scrapper`) · **동시 프로필 개수**(기본 2) 조절.
- 프록시: DB에 이미 있으면 그대로 사용. 없으면 대시보드 "Proxy 관리"에서 **붙여넣기(`ip:port` 또는 `ip:port:user:pass`, 줄바꿈)**. (`bun run proxy:import`로 파일 일괄도 가능.)

---

## 2. 실행 (매번)
- **개발/직접**: `bun run start` (상시 가동은 `caffeinate -s bun run start`).
- **비개발자 운영자**: `start.command` 더블클릭 (바탕화면엔 이 파일의 **Finder 가명(alias)** 을 두고 클릭 — 복사 아님).
  - 뜨는 터미널 창 = "가동 중" 표시 + 실시간 로그. **창을 닫으면 종료**. 대시보드는 자동으로 Chrome 앱 창으로 열림.
- **UI만 개발**: `bun run dev:ui` (Vite HMR, `/api`·`/ws`는 서버로 프록시).

---

## 3. 사용 흐름 (대시보드)
1. **설정** — API 키·그룹명·개수 저장 → "연결 테스트".
2. **Proxy 관리** — 프록시 붙여넣기(그룹별), 상태 확인.
3. **대시보드** — "브라우저 준비"(그룹 풀 자동 확보) → "크롤링 시작" → 진행/로그 2초 폴링 모니터링.
   - "준비"는 프로필 확보+등록 단계(실패를 크롤 전에 표면화하려 분리 유지). 실제 브라우저 기동은 "시작" 시.

---

## 4. 검증 체크리스트 (omp가 확인)
```bash
B=http://localhost:4478
curl -s -o /dev/null -w "%{http_code}\n" $B/                                   # 200 (대시보드)
curl -s -X POST $B/api/rpc -H 'Content-Type: application/json' \
  -d '{"channel":"db-get-proxies","args":[]}'                                  # {"ok":true,"result":[...]}  프록시 존재
curl -s -X POST $B/api/rpc -H 'Content-Type: application/json' \
  -d '{"channel":"crawler-prepare-browsers","args":["<APIKEY>"]}'              # success:true, readyCount==설정개수
```
- **그룹 격리 확인** (AdsPower): `scrapper` 그룹에 설정 개수만큼 프로필 생성됨, **기타 그룹(prowler)·미분류 프로필 개수 불변**.
  ```bash
  curl -s "http://localhost:50325/api/v1/user/list?page=1&page_size=100" \
    -H "Authorization: Bearer <APIKEY>"   # group_name 별 개수 확인
  ```
- **정상 크롤**: 시작 후 `crawler-get-progress`의 `completedTasks` 증가, `skipBreakdown` 대부분 0.
  - 전부 `timeout`이면 → **프록시 IP 화이트리스트 미등록** 의심 (실크롤 유일 관문).
  - `browserStatuses`가 계속 `starting`이면 → AdsPower 커널 최초 설치 중이거나 Local API 문제.

---

## 5. 운영 상수 / 함정 (레퍼런스)
- **포트**: scrapper `4478` (prowler `4477`와 분리). 같은 맥 공존 OK.
- **AdsPower 초당 1회 한도** → 모든 호출 1.1s 큐 통과(`src/lib/crawler/adspower-queue.ts`). 두 앱 동시 가동해도 정상 크롤 빈도(작업당 30~60s)면 충돌 없음(실측 확인).
- **무료 AdsPower = 계정 프로필 총 2개 한도**. 블록 재생성은 "생성→삭제" 순서라 순간 +1개 → 무료 계정이면 재생성이 한도로 실패하고 프록시 교체로 폴백(지문 리셋 안 됨). **계정 한도 ≥ (풀 개수 + 1)** 이어야 지문-리셋 복구가 정상.
- **DB 경로**: 기본 `~/Library/Application Support/selltkeyscrapper-grande/data.db`(기존 앱과 동일 재사용). `SCRAPPER_DATA_DIR`로 변경.
- **프로필 잔존은 정상**: 크롤 정지해도 그룹의 프로필은 다음 실행 재사용 위해 남김(누수 아님). 삭제는 블록 재생성 시에만.
- **격리 불변식**: `src/lib/crawler/profile-pool.ts`는 그룹 내 조회+생성만. 기존/미분류/타 그룹 절대 미접근.

---

## 6. 알려진 리스크 (선택 개선 — 필수 아님)
- 반복 CAPTCHA 재생성에 서킷브레이커/백오프 없음 — 프록시 대역이 대량 플래그되면 프로필 churn(큐로 속도만 제한). 심한 차단 상황에서만 문제.
- 불량 프록시 격리 안 함 — 의도적(블록되면 큐 뒤로 보내 재사용해도 무방하다는 운영 방침). `markDead()`는 정의만 되고 미사용.
- 선존 `any` 잔재는 마이그레이션이 안 건드린 기존 파일(sqlite/adspower/session-manager 등)에만 있음. 신규 코드는 룰 준수.

---

## 7. 파일 맵
| 파일 | 역할 |
|---|---|
| `src/server.ts` | Bun.serve — 정적 dist + `/api/rpc` 디스패치 + `/ws` 브로드캐스트 (구 Electron main) |
| `src/renderer/web-api.ts` | `window.electronAPI` fetch+WS 어댑터 (구 preload) |
| `src/lib/crawler/profile-pool.ts` | 그룹 격리 프로필 풀(생성/재사용) |
| `src/services/adspower.ts` | AdsPower Local API (group/user/browser) |
| `src/lib/crawler.ts` | 크롤 메인 루프 · 블록 감지/재생성 · DOM 클릭 |
| `src/lib/crawler/adspower-queue.ts` | 1.1s rate-limit 큐 |
| `src/database/sqlite.ts` | bun:sqlite |
| `src/data-dir.ts` | DB/로그 경로 |
| `start.command` | 비개발자 더블클릭 런처 |

---

## 8. 머지 / 복구
- **계획**: 이 브랜치로 **며칠 운영 → 문제 없으면 `main` 머지**(현재 main 무손, fast-forward 가능).
- **복구 지점**: 태그 `backup-pre-migration-20260703-223404`, 브랜치 `backup/pre-migration-20260703-223404`, tarball `~/projects/scrapper-backups/`.
- 되돌리려면: `git checkout main` (마이그레이션 전 상태 그대로).

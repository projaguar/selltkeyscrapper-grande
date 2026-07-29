# AdsPower 관리 계층 재설계 — 365일 무인 운영

> 목표: **사람 개입 0으로 365일 연속 동작.** 모든 실패는 유한 시간 내 자기복구하거나
> 명시적으로 격리(`parked`)되고 관측 가능해야 한다. "조용한 실패"와 "무한 루프"는 설계상 불가능해야 한다.
>
> 근거: 2026-07-29 전면 감사(5슬라이스 병렬, 원시 발견 86건 → P0 20 / P1 25 / P2 15).
> 감사 원문: `agent://ProxyOwnershipAudit`, `BrokerLayerAudit`, `BrowserLifecycleAudit`,
> `ProfilePoolAudit`, `OrchestrationAudit`.

---

## 0. 왜 패치가 아니라 재설계인가

감사 결과 20개 P0는 서로 다른 버그가 아니라 **3개의 설계 층위 결함에서 파생된 증상**이다.

| # | 근본 결함 | 파생 증상 |
|---|---|---|
| **R1** | `acquire → assign`이 `await` 경계를 넘는 비원자 read-modify-write이고, 같은 브라우저를 **3개 컨트롤러**(워커복구 / IP교체 / clear·리셋)가 변경. 조율수단은 권고 불린 + 단방향 플래그뿐 | 사이클당 프록시 +1 영구 고아(실패로그 0), 한 IP 뒤 두 브라우저 |
| **R2** | `releaseProxy`가 **인증 없는 쓰기** (소유권 검증 전무) | 남의 살아있는 프록시 해제 → 이중 배정 |
| **R3** | **원격 확인 전에 로컬 상태를 먼저 기록** | `stop` 실패했는데 "stopped", `restart`가 아무것도 안 하고 "성공", IP교체가 무음 no-op이면서 "완료" |
| **R4** | 제어 루프에 **경계가 없음** (백오프·캡·데드라인·브레이커·워치독·드레인·로그 상한 전무) | 3초 무한 스핀 15.2시간, 82MB TSV + 270MB stdout, 정지 불가 좀비 |
| **R5** | 프로필 **수명주기 부재** (은퇴/리컨실 없음) | 사라진 프로필 영구 재시도 → 워커 1개 영구 손실, 고아 프로필 quota 침식 |

패치는 증상마다 상쇄를 덧붙이는 방식이라 상쇄끼리 새 결함을 만든다.
실제로 1차 완화책 `reconcileInUse`는 (a) 필요한 순간에 도달 불가(풀 고갈 시 fetcher 영구 블록),
(b) 획득-할당 사이 구간의 프록시를 회수해 **스스로 이중배정을 유발**했다.

---

## 1. 설계 원칙

| P | 원칙 | 제거되는 결함 |
|---|---|---|
| **P1** | **단일 원장.** 소유권의 유일한 진실은 DB. 메모리에 복제 금지 | R1 |
| **P2** | **원자적 획득.** 획득은 단일 SQL문. check-then-act 금지 | R1 |
| **P3** | **소유권 검증 쓰기.** 반납/회수는 owner 일치 시에만 유효 | R2 |
| **P4** | **대상당 단일 writer.** 모든 변경 연산은 profileId 단위 mutex 통과 | R1 |
| **P5** | **확인 후 기록.** 원격 상태를 확인한 뒤에만 원장/로컬에 반영. 실패는 성공으로 표면화될 수 없다 | R3 |
| **P6** | **모든 루프는 유한.** 백오프·캡·데드라인·브레이커·워치독 필수. 무한 재시도 금지 | R4 |
| **P7** | **격리는 검증한다.** 그룹 소속을 요청 시점이 아니라 **응답 시점에 재확인** | R5 |

---

## 2. Lease 기반 프록시 소유권 (R1·R2 제거)

### 2.1 스키마

```sql
ALTER TABLE proxies ADD COLUMN owner TEXT;        -- AdsPower profileId (user_id), NULL = 미보유
ALTER TABLE proxies ADD COLUMN leased_at INTEGER; -- epoch ms. 반납 시각으로도 사용(LRU 쿨다운)
```

- `owner`가 **유일한 소유권 진실**. `status`는 하위호환/가독용 파생값.
- `owner = profileId` — 안정 식별자. 브라우저 객체가 교체돼도 프로필이 같으면 소유권 승계 가능.
- `CrawlerBrowser`는 `Lease` 객체만 보유. 별도 `proxyId` 필드 없음(원장 파생).

### 2.2 획득 — 단일 원자 문장

```sql
UPDATE proxies SET status='in_use', owner=?1, leased_at=?2
WHERE id = (
  SELECT id FROM proxies
  WHERE group_id=?3 AND status='active' AND owner IS NULL
  ORDER BY leased_at IS NULL DESC, leased_at ASC, id ASC
  LIMIT 1
)
RETURNING id, ip, port, username, password
```

- **check-then-act 소멸** → 동시 획득 경쟁 구조적 불가.
- `ORDER BY`가 그대로 **쿨다운**: 미사용 → 가장 오래전 반납 순(LRU). 방금 차단된 IP의 즉시 재사용이 사라진다.
  (기존 positional index 방식은 `reload()`가 배열을 재구성해 방금 반납한 프록시가 몇 픅 안에 다시 뽑혔다.)
- 고갈 시 `null` 반환(예외 아님).

### 2.3 반납 — 소유권 검증

```sql
UPDATE proxies SET status='active', owner=NULL, leased_at=?2
WHERE id=?1 AND owner=?3
RETURNING id
```

- `null` 반환 = **소유권 불일치** → 반납하지 않고 `[ProxyPool] 소유권 불일치 반납 거부` 경고.
  남의 살아있는 프록시를 해제하는 경로가 사라진다.

### 2.4 회수(리컨실) — grace 필수

```sql
UPDATE proxies SET status='active', owner=NULL, leased_at=?1
WHERE status='in_use'
  AND leased_at < ?2                          -- now - GRACE_MS
  AND (owner IS NULL OR (owner, id) NOT IN (<live (owner,proxy) 쌍>))
```

- 회수 판정은 **(owner, proxyId) 쌍**으로 한다. `owner` 만 보면 "우리 프로필이 X를 소유"라고 기록된
  행을, 그 브라우저가 실제로는 Y를 들고 있어도 살아있는 것으로 오판한다(그게 곧 누수 행).
- `leased_at < now - GRACE` 는 방어 심층화(획득→적용 구간, 프로필 재생성, 프로세스 재기동 대비).
  `GRACE_MS = 120_000`.
- live 쌍 = 현재 holders **전체**(그룹 무관). 단일 그룹 스코프 버그 제거.
- **독립 타이머(60s)로 실행.** IP교체 경로 의존 제거 → 풀 고갈 상태에서도 self-heal 도달 가능.

### 2.5 부팅 복구

- `initializeProxies`의 무조건 전체 리셋 **폐기**. 대신 **단일 인스턴스 락**(pidfile/flock)을 잡고,
  락 획득에 성공한 프로세스만 `owner IS NOT NULL` 전부를 회수(이전 프로세스 잔재).
- 락 실패 = 다른 인스턴스 가동 중 → **기동 거부**. (두 인스턴스가 15 IP를 30 브라우저로 공유하던 경로 제거)
- `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`.

---

## 3. 대상당 단일 writer (R1 제거)

```
LifecycleLock: Map<profileId, Promise<unknown>>   // profileId 단위 직렬화 체인
withLock(profileId, fn, deadlineMs)
```

- **모든** 변경 연산이 통과: `start` / `stop` / `restart` / `applyNewProxy` / `recreate` / `keepalive` / `clear`.
- `isRestarting`, `ipChangeInProgress` **삭제**.
  - 큐잉이므로 "이미 재시작 중 → 조용한 성공 반환"이 **구조적으로 소멸**(근본원인 C1).
  - 단방향 플래그 붕괴(`startWithNewProxy`가 남의 가드를 해제)도 소멸.
- 락 대기 데드라인 초과 → `LockTimeoutError`(typed). 호출자는 **`finally`에서 lease 반납**.
- 락은 **profileId 기준**(브라우저 객체 기준 아님) → 객체 교체(재생성) 중에도 상호배제 유지.

---

## 4. 확인 후 기록 (R3 제거)

| 연산 | 규칙 |
|---|---|
| `stop()` | AdsPower stop 호출 후 `checkBrowserStatus`로 **Inactive 확인**(폴링, 상한). 확인 실패 → `StopUnconfirmedError`, **lease 반납 금지**(그 IP로 트래픽이 아직 나갈 수 있음), 브라우저는 `zombie`로 격리하고 재시도 큐에 등록 |
| `start()` 502/타임아웃 채택 | `checkBrowserStatus`가 `Active`이고 **egress IP가 방금 설정한 프록시와 일치**할 때만 채택. 불일치 → stop 후 재시도. (기존엔 증거 없이 채택 → 잘못된 IP로 크롤, `validateProxy:false`라 탐지 불가) |
| `applyNewProxy()` | lease 획득 후 `proxyApplied=false`로 시작, `updateProfile` 성공 시 `true`. **`proxyApplied=false`인 lease는 확인 없이 반납 금지** |
| 순서 | **acquire-then-release**: 새 lease 확보 성공 후에만 헌 lease 반납. (기존 release-before-acquire는 획득 실패 시 이미 해제한 id를 계속 소유 주장) |

---

## 5. 유한 제어 (R4 제거 — 365일의 핵심)

| 영역 | 설계 |
|---|---|
| **AdsPower 큐** | per-task 데드라인 **30s** → 초과 시 해당 task만 reject하고 **큐 헤드 전진**. head-of-line block 제거. 브로커 fetch 타임아웃 90s → **25s**. `processing` 플래그는 `try/finally`로 보장(무음 영구 동결 제거) |
| **서킷 브레이커** | fleet-wide. 연속 `BrokerError` N회 → `open`. open 동안 **프록시 로테이션 금지**(브로커 장애는 프록시로 고쳐지지 않음), half-open 단일 프로브로 복귀. 3중 중첩 재시도(3×10×5≈450 슬롯) 소멸 |
| **브라우저 백오프·캡** | 연속 복구 실패 → 지수 백오프(3s→5min). 캡(예 5) 도달 → **프로필 재생성 1회 에스컬레이션** → 그래도 실패면 `parked`(워커 루프 제외 + 대시보드 경보). 3초 무한 스핀 소멸 |
| **배치 워치독** | 완료 대기에 데드라인 `max(30min, tasks×p95)`. 초과 시 stuck 집합 로그 + `processing` 강제 실패 + 다음 사이클 진행. fetcher 영구 블록 소멸 |
| **리컨실 타이머** | 60s 독립 주기(프록시 + 프로필). IP교체 경로 의존 제거 |
| **run generation** | `runId` 토큰. 모든 루프 조건 `runId === currentRunId && !shouldStop()`. `stop`은 `Promise.allSettled` + 드레인 데드라인(20s) 후 완료. **좀비 워커 부활 불가** |
| **워커 예외 격리** | 워커 본문 전체 `try/catch` → 그 워커만 종료. `stopCrawler()`는 `isRunning()`과 **무관하게 항상** 동작(정지 불가 좀비 소멸) |
| **로그** | 동일 `(profile, category, msg)` 코얼레싱 + 1/min 플러시, 파일 크기 캡 + 로테이션, 비차단 append. `this.error`는 `ready` 진입 시 **클리어**(죽은 에러가 로그를 부풀리던 문제) |
| **분류 정정** | 카테고리는 **`errorMsg` 기준**으로만 판정. caller가 만든 이유 문자열로 분류하지 않음(`에러 복구`가 전부 `BROWSER_DEAD`로 뭉개지던 문제). `NO_PROXY` / `PROFILE_GONE` / `BROKER_DOWN` 카테고리 신설 |
| **수용 제어** | `effective = min(setting, floor((totalmem - RESERVE) / PER_BROWSER))`로 클램프 + 클램프 시 경고. `freemem`/`loadavg` 샘플링 → 압박 시 `getNext()` fleet-wide 일시정지 |

---

## 6. 프로필 수명주기 (R5 제거)

- **타입드 에러**: `AdsAppError{code,msg}` / `BrokerError{status}` / `ProfileGoneError` / `QuotaError` / `StopUnconfirmedError` / `LockTimeoutError`.
  (기존엔 앱 에러가 전부 `Error(문자열)`이라 `none exists`를 아무도 구분 못 했다)
- `ProfileGoneError` → **프록시 로테이션 금지**, 즉시 프로필 재생성 라우팅. 실패(quota) → `parked` + 경보.
- **그룹 리컨실**: 그룹 내 프로필 중 어떤 holder도 소유하지 않는 것을 삭제(고아 프로필 회수). 프록시 리컨실의 미러.
  스코프는 **그룹 id로 엄격 제한**하고, 응답에 `group_id`를 **재확인**(P7)한 뒤에만 삭제 대상에 넣는다.
- **재생성 순서**: 기존 `create → delete`는 free-tier에서 순간 N+1 quota를 요구. `stop 확인 → delete → create`로 변경하되,
  create 실패 시 즉시 재시도 + 실패 지속 시 `parked`. 생성된 id는 **첫 await 전에 기록**해 응답 유실 시에도 리컨실이 입양/삭제 가능.
- **페이지네이션**: `user/list`, `group/list` 전 페이지 순회(단일 페이지 100 가정 폐기).
- `createGroup`에 `nonIdempotent: true` + 생성 후 재조회하여 **최저 group_id 결정적 선택**(중복 `scrapper` 그룹 방지).
- `crawlProfileCount`: `env → DB → 기본`. 파싱 실패는 **에러**(조용히 2로 떨어지던 문제).

---

## 7. 삭제 대상 (사표면 축소)

| 대상 | 이유 |
|---|---|
| `SessionManager` + `session-*` RPC 4개 + `web-api.ts` 노출 | 레거시·UI 미사용. **전 인스턴스 프로필에 `updateProfile`** → prowler 프로필까지 덮어쓰는 P0 격리 위반. 별도 프록시 소유 경로로 리컨실과 충돌 |
| `proxypool-test`의 미반납 획득 | 클릭당 프록시 5개 영구 손실 → 비획득 조회로 교체 |
| `markDead` / `resetDeadProxies` | 도달 불가 죽은 코드(선택은 `active`만 수용). 쿨다운은 §2.2 LRU가 담당 |
| `getProfile` / `listApplicationCategories` | 호출부 0 |
| 전역 `state.taskQueue` | TaskQueueManager와 **이중 큐** → 완료 태스크 재서빙(중복 POST)·실패 태스크 무음 유실. 단일화 |
| `initializeProxies` 무조건 전체 리셋 | 인스턴스 정체성 없이 남의 lease 파괴 → §2.5로 대체 |

---

## 8. 불변식 (모델 검증 대상)

| I | 불변식 | 위반 시 실제 피해 |
|---|---|---|
| **I1** | **상호배제**: 임의 시점에 한 proxy의 owner는 최대 1 | 한 IP 뒤 두 브라우저 → 차단 상관 급증 |
| **I2** | **무누수**: `owner ∉ live` 인 lease는 GRACE 내 회수된다 | 풀 고갈 → 브라우저 1~2개 |
| **I3** | **트래픽 정합**: 브라우저가 트래픽을 내는 proxy는 그 브라우저가 lease 보유(`proxyApplied`) | 잘못된 IP로 크롤, 원장과 현실 불일치 |
| **I4** | **진행성**: 프록시 여유 ∧ 브로커 정상 ⇒ 모든 브라우저가 유한 시간 내 `ready` | 조용한 정지 |
| **I5** | **유한성**: 모든 실패 경로는 유한 단계 내 종료(`parked` 포함). 무한 재시도 없음 | 15.2시간 스핀, 로그 350MB |
| **I6** | **정지성**: stop 요청 시 드레인 데드라인 내 모든 루프 종료, 이후 부활 없음 | 좀비 워커 2세트 |
| **I7** | **격리**: 그룹 외 프로필은 읽기/쓰기/삭제 대상이 되지 않는다 | 타 앱(prowler) 손상 |

검증 방법: §9 실행 모델에서 **적대적 인터리빙 전수/무작위 탐색 + 결함 주입**으로 I1~I7 반증 시도.

---

## 9. 검증 계획 (모델)

모델은 프로덕션 코드가 아니라 **설계의 상태기계**를 그대로 옮긴 실행 가능 모델이다.
`model/` 아래 두 파일:

- `model/lifecycle-model.ts` — lease 원장 + per-profile 락 + 브라우저 상태기계 + 컨트롤러 3종
  (워커복구 / IP교체 / 리컨실 타이머)을 **결정적 스케줄러** 위에서 표현.
- `model/check.ts` — 스케줄 탐색기(전수 DFS + 무작위 스트레스) + 결함 주입
  (stop 실패, updateProfile 타임아웃, 브로커 5xx, 프로필 소멸, 락 타임아웃) + I1~I7 감시.

반증이 나오면 **설계를 수정하고 다시 돌린다**(문서 §2~§6 갱신). 모델이 통과한 뒤에만 구현에 들어간다.

---

## 10. 단계

1. **설계** — 본 문서. ✅
2. **모델 검증** — §9. I1~I7 통과까지 반복.
3. **구현** — §2~§7. 마이그레이션 포함.
4. **검증** — typecheck/lint/build + 라이브 브로커 스모크.
5. **모니터링** — 운영 투입 후 불변식 관측(리컨실 회수량, park 수, 브레이커 개폐, 프록시 잔고 추이).
6. **수정** — 모니터링이 드러낸 문제 반영 후 2로 회귀.

---

## 11. 모델 검증 결과 (§9 실행 기록)

`model/lifecycle-model.ts` + `model/check.ts`. 실행: `bun run model/check.ts`
(파라미터: `MODEL_PROFILES/PROXIES/GROUPS/STEPS/SEEDS/QUIESCE`, 변이: `MODEL_MUTATE`).

모델은 컨트롤러(워커복구 / IP교체 / 리컨실 / 재활 / 결함주입 / 프로세스사망)를 generator 로 표현하고
`await` 지점마다 yield 하여, 무작위 스케줄로 인터리빙을 대량 탐색한다. 워커는 실제 코드처럼
**건강할 때 개입하지 않고**, 브라우저 프로세스 사망은 **락과 무관하게** 주입된다.
검사는 안전성(I1·I3·I7 매 스텝) → 수렴단계(churn 정지 후 I4) → 드레인 후(I2·I5·I6) 순.

### 11.1 모델 타당성 — 과거 사고 재현

| 설계 | 결과 (2400 스케줄 = 결함 6종 × 시드 400) |
|---|---|
| `legacy` (사고 당시 원본) | **I1 175 / I2 2019 / I3 801** 스케줄에서 반증 |
| `patched` (현재 프로덕션: legacy + 사이클말 리컨실) | **I1 206 / I2 1421 / I3 863** 반증 |
| `redesign` | **I1~I7 전부 통과** |

`legacy`/`patched` 의 I2(누수)·I1(한 IP 두 브라우저)·I3(해제된 프록시로 트래픽)는
실제로 관측된 사고(프록시 소진, 브라우저 1~2개 잔존)와 일치한다 → 모델이 현실을 재현함을 확인.
`patched` 가 여전히 대량 반증되는 것은 사이클말 리컨실이 상쇄일 뿐 해결이 아님을 뒷받침한다.

### 11.2 기준선 — 구성별 전 불변식 통과

| 프로필 | 프록시 | 그룹 | 결과 |
|---|---|---|---|
| 4 | 8 | 2 | 통과 |
| 6 | 6 | 1 | 통과 (프록시 = 프로필, 극한 고갈) |
| 8 | 10 | 2 | 통과 |
| 3 | 20 | 1 | 통과 |

### 11.3 모델이 강제한 설계 수정 3건

검증 과정에서 초안 설계가 반증되어 다음을 수정했다. 세 건 모두 감사(정적 분석)에서는 드러나지 않았다.

1. **IP교체 2단계 구조 폐기** — 초안은 Phase 1(전체 정지) → Phase 2(재배정)를 유지했다.
   두 페이즈 사이에 워커가 락을 잡고 브라우저를 다시 start 할 수 있어, Phase 2 가
   **살아있는 브라우저의 프록시를 해제**했다(I3). → **정지 확인을 락 안의 브라우저별 시퀀스에 내재화**하고
   Phase 1 은 상태를 바꾸지 않는 best-effort 선행 정지로 격하.
2. **`parked` 는 종점이 아니다** — 브로커 일시 장애로 park 된 브라우저가 회복 후에도 영구 park 되어
   일시 장애가 **영구적 fleet 축소**로 굳었다(I4). → **재활 타이머** 도입(긴 백오프로 재시도, 조건이
   여전하면 다시 park). 365일 운영에서 가장 치명적이었던 발견.
3. **프록시 고갈은 브라우저의 결함이 아니다** — `acquire-then-release` 는 순간적으로 프록시 2개를
   요구하므로 풀이 조이면 전원이 획득 실패 → 전원 park → fleet 붕괴(I4). → 고갈 시
   **보유 중인 lease 로 재기동**(회전은 최적화일 뿐 필수 아님)하고, 고갈은 실패로 집계하지 않는다.
   추가로 동시 브라우저 수를 풀 크기로도 클램프한다(§5 수용 제어).

### 11.4 변이 분석 — 어느 설계 요소가 load-bearing 인가

각 설계 요소를 하나씩 무력화해 불변식이 실제로 깨지는지 확인했다(공허한 통과 방지).

| 변이 (무력화 대상) | 기본 구성 | 극한 고갈 | 판정 |
|---|---|---|---|
| `noLock` (§3 per-profile 락) | **I1, I3** | **I1, I3** | **필수** |
| `noConfirmStop` (§4 확인된 정지) | **I1, I3** | **I1, I3** | **필수** |
| `noRehab` (재활 경로) | **I4** | **I4** | **필수** |
| `unauthRelease` (§2.3 소유권 검증 반납) | 반증 없음 | **I1** | **필수**(고갈 시 노출) |
| `releaseBeforeAcquire` (§4 획득 후 반납 순서) | 반증 없음 | 반증 없음 | 최적화 — 필수 아님 |
| `phase1State` (Phase 1 무상태화) | 반증 없음 | 반증 없음 | 방어 심층화(재활이 가려줌) |

**중요한 해석**: 원래 사고의 원인은 "반납 순서"가 아니었다. 순서와 무관하게
**① 정지를 확인하기 전에 반납한 것**과 **② 반납에 소유권 검증이 없던 것**이 원인이다.
이 둘을 고치면 순서는 성능/여유 문제로 내려간다. 반대로 락·확인정지·재활·소유권검증은
어느 하나만 빠져도 즉시 불변식이 깨지는 **필수 요소**임이 확인되었다.

### 11.5 남은 한계

- 모델은 **무작위 스케줄 탐색**(구성별 2400~4800 스케줄)이며 전수 증명이 아니다. 반증 부재가
  부재의 증명은 아니다.
- 모델은 프록시/프로필 **소유권과 수명주기**를 다룬다. AdsPower 큐의 head-of-line,
  서킷 브레이커 임계값, 로그 상한, 메모리 클램프(§5)는 모델 대상이 아니며 구현 후 실측으로 검증한다.
- `I7`(격리)은 모델에서 "타 앱 프로필을 건드리지 않음"만 확인한다. 실제 그룹 스코프는
  구현 시 응답의 `group_id` 재확인(P7)으로 보장해야 한다.

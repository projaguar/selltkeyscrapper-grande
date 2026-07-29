/**
 * REDESIGN.md §9 — AdsPower 수명주기 실행 모델.
 *
 * 프로덕션 코드가 아니다. REDESIGH 설계의 "상태기계"만 옮겨, 적대적 인터리빙 아래에서
 * 불변식 I1~I7 을 반증 시도하기 위한 모델이다.
 *
 * 모든 컨트롤러는 generator 로 표현하고, 실제 코드에서 `await` 이 있는 지점마다 yield 한다.
 * 스케줄러가 어느 컨트롤러를 진행시킬지 고르므로 yield 지점이 곧 인터리빙 경계다.
 *
 * 세 가지 설계를 같은 모델로 검사한다:
 *  - 'legacy'   : 사고 당시 원본 (리컨실 없음)              → I2 반증 기대(누수 누적)
 *  - 'patched'  : legacy + reconcileInUse(그레이스 없음)     → I1/I3 반증 기대(회수가 이중배정 유발)
 *  - 'redesign' : REDESIGN.md §2~§6                          → 전 불변식 통과 기대
 */

export type DesignMode = "legacy" | "patched" | "redesign";
export type ProfileId = string;
export type ProxyId = number;

/**
 * 회수 그레이스 (모델 시간 단위, 실제 GRACE_MS 대응).
 * MODEL_GRACE=0 으로 변이(mutation) 테스트: 그레이스를 없애면 redesign 도 반드시 I1/I3 을
 * 위반해야 한다 — 검사기가 살아있고 그레이스가 load-bearing 임을 증명하는 용도.
 */
export const GRACE = Number(process.env.MODEL_GRACE ?? 25);
export const RECONCILE_INTERVAL = 10;
export const MAX_RECOVER_ATTEMPTS = 4;
export const FAILURE_CAP = 3;
/** 재활(보류 해제) 주기. 실제 구현의 긴 백오프에 대응 */
export const REHAB_INTERVAL = 15;


/**
 * 변이(mutation) 스위치 — 각 설계 요소가 정말 필요한지(load-bearing) 증명하기 위한 장치.
 * `MODEL_MUTATE=noLock,unauthRelease` 처럼 콤마로 지정한다.
 * 각 변이는 REDESIGN.md 의 특정 설계 결정 하나를 무력화하며, 그때 반드시 어떤 불변식이
 * 깨져야 한다. 깨지지 않으면 그 설계 요소는 근거가 없거나 검사가 공허하다는 뜻이다.
 */
const mutateRaw = (process.env.MODEL_MUTATE ?? "").split(",").filter((s) => s.length > 0);
export const MUT = {
  /** §2 P3 소유권 검증 반납 제거 */
  unauthRelease: mutateRaw.includes("unauthRelease"),
  /** §3 P4 per-profile 락 제거 */
  noLock: mutateRaw.includes("noLock"),
  /** §4 acquire-then-release 순서를 release-then-acquire 로 되돌림 */
  releaseBeforeAcquire: mutateRaw.includes("releaseBeforeAcquire"),
  /** §4 P5 확인된 정지 제거 (실패해도 정지된 것으로 간주) */
  noConfirmStop: mutateRaw.includes("noConfirmStop"),
  /** 재활 경로 제거 (parked 를 종점으로) */
  noRehab: mutateRaw.includes("noRehab"),
  /** IP교체 Phase 1 이 락 밖에서 상태를 변경 */
  phase1State: mutateRaw.includes("phase1State"),
} as const;

export const activeMutations = mutateRaw;

export interface Row {
  id: ProxyId;
  group: number;
  /** redesign: 소유자 profileId. legacy/patched: null 이지만 leased 플래그로 in_use 표현 */
  owner: ProfileId | null;
  leased: boolean;
  leasedAt: number | null;
}

export interface Lease {
  proxyId: ProxyId;
  /** updateProfile 성공 후에만 true. false 인 lease 는 확인 없이 반납 금지 (P5) */
  applied: boolean;
}

export type BrowserState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "zombie"
  | "parked";

export interface Browser {
  profileId: ProfileId;
  group: number;
  lease: Lease | null;
  state: BrowserState;
  /** AdsPower 프로세스가 실제로 살아있는지 */
  running: boolean;
  /** 트래픽이 실제로 나가는 프록시 (start 시점에 바인딩됨) */
  egress: ProxyId | null;
  failures: number;
  /** legacy 전용 단방향 가드 */
  isRestarting: boolean;
  gone: boolean;
}

export interface Faults {
  stopFails: boolean;
  updateTimesOut: boolean;
  brokerDown: boolean;
  profileVanishes: boolean;
}

export interface Violation {
  invariant: string;
  detail: string;
  clock: number;
}

export type Step = string;
export type Proc = Generator<Step, void, undefined>;

// ---------------------------------------------------------------- Ledger

export class Ledger {
  readonly rows: Row[] = [];
  private readonly mode: DesignMode;

  constructor(mode: DesignMode, count: number, groups: number) {
    this.mode = mode;
    for (let i = 1; i <= count; i++) {
      this.rows.push({
        id: i,
        group: 1 + (i % groups),
        owner: null,
        leased: false,
        leasedAt: null,
      });
    }
  }

  /**
   * 원자적 획득 (REDESIGN §2.2). 단일 SQL문에 대응하므로 모델에서도 중간 yield 없음.
   * LRU 순서: 미사용 → 가장 오래전 반납 순.
   */
  acquire(owner: ProfileId, group: number, now: number): Row | null {
    const candidates = this.rows
      .filter((r) => r.group === group && !r.leased)
      .sort((a, b) => {
        const aNull = a.leasedAt === null ? 0 : 1;
        const bNull = b.leasedAt === null ? 0 : 1;
        if (aNull !== bNull) return aNull - bNull;
        return (a.leasedAt ?? 0) - (b.leasedAt ?? 0) || a.id - b.id;
      });
    const row = candidates[0];
    if (!row) return null;
    row.leased = true;
    row.leasedAt = now;
    if (this.mode === "redesign") row.owner = owner;
    return row;
  }

  /** 반납. redesign 은 소유권 검증(P3), legacy/patched 는 무인증 쓰기(R2). */
  release(proxyId: ProxyId, owner: ProfileId, now: number): boolean {
    const row = this.rows.find((r) => r.id === proxyId);
    if (!row) return false;
    if (this.mode === "redesign" && !MUT.unauthRelease && row.owner !== owner) return false;
    row.leased = false;
    row.owner = null;
    row.leasedAt = now;
    return true;
  }

  /**
   * 고아 회수.
   * redesign (§2.4): 원장의 (owner, id) 쌍이 살아있는 브라우저의 보유 쌍과 일치하지 않고
   *   grace 를 지난 행만 회수. 소유권이 원장에 원자적으로 기록되므로 획득-할당 틈이 없다.
   * legacy/patched: owner 컬럼이 없어 proxyId 보유 여부로만 판단(+ grace 없음, 그룹 스코프 한정).
   */
  reclaim(
    heldPairs: ReadonlySet<string>,
    heldIds: ReadonlySet<ProxyId>,
    now: number,
    scopeGroup: number | undefined,
  ): ProxyId[] {
    const reclaimed: ProxyId[] = [];
    for (const row of this.rows) {
      if (!row.leased) continue;
      if (scopeGroup !== undefined && row.group !== scopeGroup) continue;
      if (this.mode === "redesign") {
        if (row.owner !== null && heldPairs.has(`${row.owner}#${row.id}`)) continue;
        if (row.leasedAt !== null && now - row.leasedAt < GRACE) continue;
      } else {
        if (heldIds.has(row.id)) continue;
      }
      row.leased = false;
      row.owner = null;
      row.leasedAt = now;
      reclaimed.push(row.id);
    }
    return reclaimed;
  }
}

// ---------------------------------------------------------------- Lock

/** REDESIGN §3 — profileId 단위 단일 writer. legacy 모드에서는 무력화된다. */
export class LifecycleLock {
  private readonly held = new Set<ProfileId>();
  private readonly enabled: boolean;

  constructor(mode: DesignMode) {
    this.enabled = mode === "redesign" && !MUT.noLock;
  }

  isHeld(profileId: ProfileId): boolean {
    return this.enabled && this.held.has(profileId);
  }

  tryTake(profileId: ProfileId): boolean {
    if (!this.enabled) return true;
    if (this.held.has(profileId)) return false;
    this.held.add(profileId);
    return true;
  }

  give(profileId: ProfileId): void {
    this.held.delete(profileId);
  }
}

// ---------------------------------------------------------------- World

export class World {
  readonly mode: DesignMode;
  readonly ledger: Ledger;
  readonly lock: LifecycleLock;
  readonly browsers: Browser[] = [];
  /** 우리 그룹이 아닌 타 앱 프로필 — I7 감시용. 어떤 연산도 이걸 건드리면 위반 */
  readonly foreignProfiles: ReadonlySet<ProfileId> = new Set(["prowler-1"]);
  readonly touchedForeign: ProfileId[] = [];
  clock = 0;
  stopRequested = false;
  drained = false;
  /** 수렴(quiescence) 단계 진입 플래그 — churn 주입을 멈춰 진행성을 측정한다 */
  churnStopped = false;
  faults: Faults;
  readonly violations: Violation[] = [];
  /** 무한 루프 감시: 컨트롤러별 진행 스텝 수 */
  work = 0;

  constructor(
    mode: DesignMode,
    profileCount: number,
    proxyCount: number,
    groups: number,
    faults: Faults,
  ) {
    this.mode = mode;
    this.ledger = new Ledger(mode, proxyCount, groups);
    this.lock = new LifecycleLock(mode);
    this.faults = faults;
    for (let i = 0; i < profileCount; i++) {
      this.browsers.push({
        profileId: `p${i}`,
        group: 1 + (i % groups),
        lease: null,
        state: "idle",
        running: false,
        egress: null,
        failures: 0,
        isRestarting: false,
        gone: false,
      });
    }
  }

  heldProxyIds(): Set<ProxyId> {
    const s = new Set<ProxyId>();
    for (const b of this.browsers) if (b.lease) s.add(b.lease.proxyId);
    return s;
  }

  /** 원장 소유권 대조용 (owner,proxyId) 쌍 집합 */
  heldPairs(): Set<string> {
    const s = new Set<string>();
    for (const b of this.browsers) {
      if (b.lease) s.add(`${b.profileId}#${b.lease.proxyId}`);
    }
    return s;
  }

  record(invariant: string, detail: string): void {
    if (this.violations.some((v) => v.invariant === invariant)) return;
    this.violations.push({ invariant, detail, clock: this.clock });
  }

  /** I1·I3·I7 은 매 스텝 후 검사 (안전성). I2·I4·I5·I6 은 종료 시 검사. */
  checkSafety(): void {
    // I1 상호배제 — 두 브라우저가 같은 프록시로 트래픽을 낼 수 없다
    const egressOwners = new Map<ProxyId, ProfileId>();
    for (const b of this.browsers) {
      if (!b.running || b.egress === null) continue;
      const prev = egressOwners.get(b.egress);
      if (prev !== undefined && prev !== b.profileId) {
        this.record(
          "I1",
          `proxy ${b.egress} 로 ${prev} 와 ${b.profileId} 가 동시에 트래픽`,
        );
      }
      egressOwners.set(b.egress, b.profileId);
    }

    // I3 트래픽 정합 — 트래픽을 내는 프록시는 그 브라우저가 lease 보유해야 한다
    for (const b of this.browsers) {
      if (!b.running || b.egress === null) continue;
      const holdsIt = b.lease?.proxyId === b.egress && b.lease.applied;
      if (!holdsIt) {
        const row = this.ledger.rows.find((r) => r.id === b.egress);
        // lease 를 놓쳤는데 원장에서도 풀려 다른 브라우저에 갈 수 있는 상태가 진짜 위반
        if (!row?.leased) {
          this.record(
            "I3",
            `${b.profileId} 가 proxy ${b.egress} 로 트래픽 중인데 원장은 해제 상태(재배정 가능)`,
          );
        }
      }
    }

    // I7 격리 — 타 앱 프로필 접촉 금지
    if (this.touchedForeign.length > 0) {
      this.record("I7", `타 앱 프로필 접촉: ${this.touchedForeign.join(",")}`);
    }
  }

  /**
   * I4 진행성 — churn 을 멈추고 수렴시킨 뒤에만 의미가 있다.
   * 결함이 없고 churn 이 멈췄으면 모든 브라우저가 가동 상태로 수렴해야 한다.
   */
  checkProgress(): void {
    const noFaults =
      !this.faults.brokerDown &&
      !this.faults.stopFails &&
      !this.faults.updateTimesOut &&
      !this.faults.profileVanishes;
    if (!noFaults || this.stopRequested || !this.churnStopped) return;
    const notRunning = this.browsers.filter((b) => b.state !== "ready" || !b.running);
    if (notRunning.length > 0) {
      this.record(
        "I4",
        `churn 정지·무결함인데 미수렴: ${notRunning
          .map((b) => `${b.profileId}:${b.state}${b.running ? "" : ",정지"}${b.lease ? "" : ",lease없음"}`)
          .join(" ")}`,
      );
    }
  }

  /** I2·I5·I6 — 드레인 완료 후 최종 검사. */
  checkFinal(): void {
    // I2 무누수 — 회수되지 않은 고아 lease 가 없어야 한다
    const held = this.heldProxyIds();
    const orphans = this.ledger.rows.filter((r) => r.leased && !held.has(r.id));
    const stale = orphans.filter(
      (r) => r.leasedAt === null || this.clock - r.leasedAt > GRACE + RECONCILE_INTERVAL * 2,
    );
    if (stale.length > 0) {
      this.record(
        "I2",
        `회수 안 된 고아 lease ${stale.length}개 (proxy ${stale.map((r) => r.id).join(",")})`,
      );
    }

    // I5 유한성 — 어떤 브라우저도 무한 재시도 상태로 남지 않는다 (parked 는 허용된 종료 상태)
    for (const b of this.browsers) {
      if (b.failures > FAILURE_CAP && b.state !== "parked") {
        this.record(
          "I5",
          `${b.profileId} 실패 ${b.failures}회인데 park 되지 않음 (state=${b.state})`,
        );
      }
    }

    // I6 정지성 — stop 요청 후 드레인되지 않았으면 위반
    if (this.stopRequested && !this.drained) {
      this.record("I6", "stop 요청 후 드레인 미완료 상태로 종료");
    }
  }
}

// ---------------------------------------------------------------- Controllers

/**
 * 워커 에러 복구 경로 (crawler.ts handleBrowserRestart 대응).
 * legacy/patched: release-before-acquire + restart() 조용한 성공 반환.
 * redesign: 락 + acquire-then-release + 확인 후 기록 + 백오프/캡.
 */
export function* workerRecover(w: World, b: Browser): Proc {
  if (b.state === "parked") return;

  if (w.mode === "redesign") {
    // 락을 못 잡으면 이번 턴은 양보 (큐잉 — 조용한 성공 없음)
    while (!w.lock.tryTake(b.profileId)) {
      yield `worker(${b.profileId}) 락 대기`;
      if (w.stopRequested) return;
    }
    try {
      for (let attempt = 1; attempt <= MAX_RECOVER_ATTEMPTS; attempt++) {
        if (w.stopRequested) return;

        // 브로커 장애면 프록시 로테이션 금지 (서킷 브레이커, §5)
        if (w.faults.brokerDown) {
          b.failures++;
          if (b.failures > FAILURE_CAP) b.state = "parked";
          yield `worker(${b.profileId}) 브레이커 open — 로테이션 금지`;
          return;
        }
        // 프로필 소멸이면 프록시 로테이션 금지 → 재생성 라우팅 (§6)
        if (b.gone) {
          b.failures++;
          if (b.failures > FAILURE_CAP) {
            b.state = "parked";
            yield `worker(${b.profileId}) 프로필 소멸 — park`;
            return;
          }
          b.gone = false; // 재생성 성공
          yield `worker(${b.profileId}) 프로필 재생성`;
          continue;
        }

        // 1) 확인된 정지: 성공 못하면 lease 반납 금지 (§4)
        if (b.running) {
          if (w.faults.stopFails && !MUT.noConfirmStop) {
            b.state = "zombie";
            b.failures++;
            if (b.failures > FAILURE_CAP) b.state = "parked";
            yield `worker(${b.profileId}) stop 미확인 — lease 유지, zombie`;
            return;
          }
          // noConfirmStop 변이: 실패해도 정지된 것으로 간주(= 기존 코드의 조용한 실패)
          if (!w.faults.stopFails) {
            b.running = false;
            b.egress = null;
          }
          yield `worker(${b.profileId}) stop`;
        }

        // 2) acquire-then-release (변이 시 순서 반전).
        //    프록시 고갈은 브라우저의 결함이 아니므로 park 하지 않는다(모델 검증에서 발견:
        //    acquire-then-release 는 순간적으로 프록시 2개를 요구해 풀이 조이면 전원이 park →
        //    fleet 붕괴 → I4 위반). 고갈 시 이미 보유한 lease 로 재기동한다 — 회전은 최적화다.
        const old = b.lease;
        if (MUT.releaseBeforeAcquire && old) {
          w.ledger.release(old.proxyId, b.profileId, w.clock);
          yield `worker(${b.profileId}) release(선행) ${old.proxyId}`;
        }
        const fresh = w.ledger.acquire(b.profileId, b.group, w.clock);
        const targetId: ProxyId | null = fresh
          ? fresh.id
          : MUT.releaseBeforeAcquire
            ? null
            : (old?.proxyId ?? null);
        if (targetId === null) {
          yield `worker(${b.profileId}) 프록시 고갈 — 백오프 대기(park 안 함)`;
          return;
        }
        b.lease = { proxyId: targetId, applied: false };
        yield `worker(${b.profileId}) ${fresh ? `acquire ${targetId}` : `기존 lease ${targetId} 재사용`}`;
        if (fresh && old && old.proxyId !== targetId) {
          w.ledger.release(old.proxyId, b.profileId, w.clock);
          yield `worker(${b.profileId}) release ${old.proxyId}`;
        }

        // 3) updateProfile → 성공 시에만 applied
        if (w.faults.updateTimesOut) {
          b.failures++;
          if (b.failures > FAILURE_CAP) {
            b.state = "parked";
            // park 시에는 lease 를 반납한다 (더 이상 트래픽 없음)
            w.ledger.release(b.lease.proxyId, b.profileId, w.clock);
            b.lease = null;
          }
          yield `worker(${b.profileId}) updateProfile 타임아웃`;
          return;
        }
        b.lease.applied = true;
        yield `worker(${b.profileId}) proxy 적용됨`;

        // 4) start
        b.running = true;
        b.egress = b.lease.proxyId;
        b.state = "ready";
        b.failures = 0;
        yield `worker(${b.profileId}) start 완료`;
        return;
      }
      b.state = "parked";
    } finally {
      w.lock.give(b.profileId);
    }
    return;
  }

  // ---- legacy / patched ----
  for (let attempt = 1; attempt <= MAX_RECOVER_ATTEMPTS; attempt++) {
    yield `worker(${b.profileId}) attempt ${attempt}`;
    const old = b.lease;
    if (old) w.ledger.release(old.proxyId, b.profileId, w.clock); // 무인증 해제
    const fresh = w.ledger.acquire(b.profileId, b.group, w.clock);
    if (!fresh) {
      b.state = "idle";
      b.failures++;
      yield `worker(${b.profileId}) 프록시 없음`;
      return;
    }
    yield `worker(${b.profileId}) restart(${fresh.id}) 진입`;

    // restart(): 중복 가드 — 조용한 성공 반환 (근본원인 C1)
    if (b.isRestarting) {
      yield `worker(${b.profileId}) 이미 재시작 중 — 폴링`;
      // 플래그가 풀리면 아무것도 적용하지 않고 성공 반환.
      // fresh 는 주인 없이 in_use 로 남는다 → 영구 고아.
      return;
    }
    b.isRestarting = true;
    yield `worker(${b.profileId}) stop`;
    if (!w.faults.stopFails) {
      b.running = false;
      b.egress = null;
    }
    b.lease = { proxyId: fresh.id, applied: true };
    yield `worker(${b.profileId}) updateProfile`;
    b.running = true;
    b.egress = fresh.id;
    b.state = "ready";
    b.isRestarting = false;
    return;
  }
}

/**
 * 워커 루프 — 실제 시스템처럼 정지 요청까지 반복 복구한다.
 * (1회만 돌면 IP교체 Phase2 와 겹칠 기회가 없어 실제 레이스를 재현하지 못한다)
 */
export function* workerLoop(w: World, b: Browser): Proc {
  while (!w.stopRequested) {
    yield `worker(${b.profileId}) 루프 진입`;
    // parked/zombie 는 종료가 아니라 '보류'다. 재활(rehabTimer)이 되살릴 수 있으므로
    // 워커는 루프를 유지한다 — 그래야 일시 장애 후 fleet 이 자동 복원된다.
    if (b.state === "parked" || b.state === "zombie") {
      yield `worker(${b.profileId}) 보류 상태 대기`;
      continue;
    }
    // 건강하면 개입하지 않는다 (실제 코드의 hasError 분기와 동일).
    // 무조건 재시작하면 fleet 이 영구 진동해 진행성(I4)을 측정할 수 없다.
    if (b.state === "ready" && b.running) {
      yield `worker(${b.profileId}) 정상 — 태스크 처리`;
      continue;
    }
    yield* workerRecover(w, b);
  }
}

/**
 * 브라우저 프로세스 사망 주입기 — 락과 무관하게 발생하는 실제 churn.
 * (AdsPower/SunBrowser 가 죽는 것은 우리 락을 존중하지 않는다)
 * lease 는 유지된다: 프로세스만 죽었고 프록시 소유권은 그대로다.
 */
export function* crashInjector(w: World, rng: () => number): Proc {
  while (!w.stopRequested) {
    yield "crash 대기";
    if (w.churnStopped) return;
    const b = w.browsers[Math.floor(rng() * w.browsers.length)];
    if (!b || !b.running || b.state !== "ready") continue;
    b.running = false;
    b.state = "idle";
    b.egress = null;
    yield `crash: ${b.profileId} 프로세스 사망`;
  }
}

/**
 * 재활 타이머 (모델 검증에서 발견된 I4 결함의 수정).
 * parked/zombie 는 종점이 아니어야 한다 — 브로커 일시 장애로 park 된 브라우저가
 * 회복 후에도 영구 park 되면 일시 장애가 영구적 fleet 축소로 굳는다(365일 운영 실패).
 * 긴 백오프로 재시도하고, 조건이 여전하면 다시 park 된다.
 */
export function* rehabTimer(w: World): Proc {
  if (MUT.noRehab) return; // 변이: 재활 경로 제거 → parked 가 종점이 된다
  while (!w.stopRequested) {
    for (let i = 0; i < REHAB_INTERVAL; i++) {
      yield "rehab 대기";
      if (w.stopRequested) return;
    }
    for (const b of w.browsers) {
      if (b.state !== "parked" && b.state !== "zombie") continue;
      if (!w.lock.tryTake(b.profileId)) continue;
      try {
        if (b.state === "zombie") {
          // 정지를 이제 확인할 수 있으면 lease 를 반납하고 복귀시킨다.
          if (w.faults.stopFails) continue;
          b.running = false;
          b.egress = null;
          if (b.lease) {
            w.ledger.release(b.lease.proxyId, b.profileId, w.clock);
            b.lease = null;
          }
        }
        b.state = "idle";
        b.failures = 0;
      } finally {
        w.lock.give(b.profileId);
      }
      yield `rehab ${b.profileId} 재활`;
    }
    yield "rehab 스윕";
  }
}

/** IP 일괄교체 (crawler.ts changeAllBrowserIPs 대응). */
export function* ipChange(w: World): Proc {
  // Phase 1 — best-effort 선행 정지.
  // redesign: 상태를 변경하지 않는다. 정지 확인은 Phase 2 가 락 안에서 수행한다.
  // (모델 검증에서 발견: Phase 1 이 락 밖에서 state 를 쓰면 parked 를 zombie 로 되돌려 I5 위반)
  for (const b of w.browsers) {
    if (w.mode !== "redesign") {
      // legacy: disconnectOnly 는 프로세스를 죽이지 않는다 (running 유지)
      yield `ipchange disconnect ${b.profileId}`;
      continue;
    }
    yield `ipchange phase1 stop요청 ${b.profileId}`;
  }
  if (w.mode !== "redesign" || MUT.phase1State) {
    for (const b of w.browsers) {
      if (w.faults.stopFails) {
        // legacy: 실패를 무시하고 stopped 로 간주 (R3)
        b.state = "stopping";
        yield `ipchange stop ${b.profileId} 실패(무시)`;
        continue;
      }
      b.running = false;
      b.egress = null;
      yield `ipchange stop ${b.profileId}`;
    }
  }

  // Phase 2 — 프록시 교체 + 재시작
  for (const b of w.browsers) {
    if (b.state === "parked") continue;
    if (w.mode === "redesign") {
      while (!w.lock.tryTake(b.profileId)) {
        yield `ipchange(${b.profileId}) 락 대기`;
        if (w.stopRequested) return;
      }
      try {
        if (b.state === "zombie") {
          // 정지 미확인 브라우저는 건드리지 않는다 (lease 유지)
          yield `ipchange(${b.profileId}) zombie 스킵`;
          continue;
        }

        // 락 안에서 정지를 재확인한다. Phase 1 의 정지에 의존하지 않는다.
        // (모델 검증에서 발견: 두 페이즈 사이에 워커가 브라우저를 다시 start 할 수 있어,
        //  Phase 2 가 살아있는 브라우저의 프록시를 해제하면 I3 위반 → 이중배정 위험)
        if (b.running) {
          if (w.faults.stopFails && !MUT.noConfirmStop) {
            b.state = "zombie";
            yield `ipchange(${b.profileId}) stop 미확인 — lease 유지`;
            continue;
          }
          if (!w.faults.stopFails) {
            b.running = false;
            b.egress = null;
          }
          yield `ipchange(${b.profileId}) stop`;
        }
        const freshIp = w.ledger.acquire(b.profileId, b.group, w.clock);
        const oldIp = b.lease;
        const targetIpId: ProxyId | null = freshIp
          ? freshIp.id
          : MUT.releaseBeforeAcquire
            ? null
            : (oldIp?.proxyId ?? null);
        if (targetIpId === null) {
          // 고갈은 실패가 아니다 — 다음 사이클에 재시도한다.
          yield `ipchange(${b.profileId}) 프록시 고갈 — 스킵(park 안 함)`;
          continue;
        }
        if (MUT.releaseBeforeAcquire && oldIp) {
          w.ledger.release(oldIp.proxyId, b.profileId, w.clock);
        }
        b.lease = { proxyId: targetIpId, applied: false };
        yield `ipchange(${b.profileId}) ${freshIp ? `acquire ${targetIpId}` : `기존 lease 재사용 ${targetIpId}`}`;
        if (freshIp && oldIp && oldIp.proxyId !== targetIpId) {
          w.ledger.release(oldIp.proxyId, b.profileId, w.clock);
        }
        if (w.faults.updateTimesOut) {
          b.failures++;
          if (b.failures > FAILURE_CAP) b.state = "parked";
          yield `ipchange(${b.profileId}) updateProfile 타임아웃`;
          continue;
        }
        b.lease.applied = true;
        b.running = true;
        b.egress = targetIpId;
        b.state = "ready";
        yield `ipchange(${b.profileId}) start`;
      } finally {
        w.lock.give(b.profileId);
      }
      continue;
    }

    // legacy / patched
    const old = b.lease;
    if (old) w.ledger.release(old.proxyId, b.profileId, w.clock);
    const fresh = w.ledger.acquire(b.profileId, b.group, w.clock);
    if (!fresh) {
      b.failures++;
      yield `ipchange(${b.profileId}) 프록시 없음`;
      continue;
    }
    yield `ipchange(${b.profileId}) startWithNewProxy ${fresh.id}`;
    b.isRestarting = true; // 검사 없이 설정 (단방향 가드 붕괴)
    yield `ipchange(${b.profileId}) updateProfile`;
    b.lease = { proxyId: fresh.id, applied: true };
    b.running = true;
    b.egress = fresh.id;
    b.state = "ready";
    b.isRestarting = false; // 남의 가드까지 해제
    yield `ipchange(${b.profileId}) start 완료`;
  }

  // patched: 사이클 끝에서만 리컨실 (그레이스 없음, holders[0] 그룹만)
  if (w.mode === "patched") {
    w.ledger.reclaim(w.heldPairs(), w.heldProxyIds(), w.clock, w.browsers[0]?.group);
    yield `ipchange 리컨실(패치)`;
  }
}

/** 독립 리컨실 타이머 (REDESIGN §2.4) — redesign 전용. */
export function* reconcileTimer(w: World): Proc {
  while (!w.stopRequested) {
    for (let i = 0; i < RECONCILE_INTERVAL; i++) {
      yield "reconcile 대기";
      if (w.stopRequested) return;
    }
    w.ledger.reclaim(w.heldPairs(), w.heldProxyIds(), w.clock, undefined);
    yield "reconcile 스윕";
  }
}

/** 결함 주입기 — 실행 중 프로필 소멸/브로커 복구 등을 무작위 시점에 발생시킨다. */
export function* faultInjector(w: World, targets: readonly number[]): Proc {
  for (const idx of targets) {
    yield "fault 대기";
    const b = w.browsers[idx];
    if (!b) continue;
    if (w.faults.profileVanishes) {
      b.gone = true;
      yield `fault: ${b.profileId} 프로필 소멸`;
    }
  }
  // 브로커가 회복되면 진행성이 복구되어야 한다
  if (w.faults.brokerDown) {
    yield "fault: 브로커 회복";
    w.faults.brokerDown = false;
  }
}

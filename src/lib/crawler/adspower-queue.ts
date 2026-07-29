/**
 * AdsPower API 작업 큐 매니저 (싱글톤)
 * - 초당 1회 rate limiting (1100ms 간격 — AdsPower 로컬 API 한도)
 * - 모든 AdsPower API 호출을 순차적으로 처리
 * - 브라우저 start/stop은 프로필 단위 중복 방지
 *
 * REDESIGN §5(유한 제어). 이 큐는 fleet 전체의 단일 직렬 지점이라 여기서 막히면 15 워커가
 * 통째로 멈춘다. 그래서 세 가지 경계가 필수다:
 *  1) `processing` 플래그를 try/finally 로 보장 — 예외 한 번에 큐가 영구 동결되던 무음 정지 제거
 *  2) per-task 데드라인 — 한 건이 큐 헤드를 붙잡는 head-of-line block 제거
 *  3) 서킷 브레이커 — 브로커 장애를 프록시 로테이션으로 "고치려" 드는 증폭 루프 차단
 */

import * as adspower from "../../services/adspower";
import { BrokerError, LockTimeoutError } from "../errors";

// task 실행 데드라인. 큐 대기 시간은 포함하지 않는다 — 15 워커의 정상 백로그만으로도
// 꼬리 task 가 30s 를 넘기므로, 대기까지 포함하면 멀쩡한 요청을 오탐 거절하게 된다.
const DEFAULT_TASK_DEADLINE_MS = 30_000;
// 같은 프로필의 start/stop 이 겹칠 때의 대기 상한. 무한 스핀 금지(P6).
const BROWSER_SLOT_WAIT_MS = 60_000;
const BROWSER_SLOT_POLL_MS = 250;
// 연속 BrokerError 5회면 브로커가 죽은 것으로 보고 개방한다.
const BREAKER_THRESHOLD = 5;
// 개방 유지 시간. 이후 첫 enqueue 가 half-open 단일 프로브가 된다.
const BREAKER_OPEN_MS = 30_000;

export type BreakerState = "closed" | "open" | "half-open";

export interface EnqueueOptions {
  /** 실행 데드라인(ms). 다중 페이지 조회처럼 본질적으로 긴 작업만 상향한다. */
  deadlineMs?: number;
}

interface QueueTask {
  label: string;
  /**
   * 실행 + 데드라인 + 자기 promise settle 까지 전담한다.
   * 프로세서에는 브레이커/레이트 회계에 필요한 사실만 돌려준다(절대 throw 하지 않는다).
   */
  run: () => Promise<{ brokerFailure: boolean }>;
}

const DEADLINE = Symbol("adspower-queue-deadline");

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * fn 을 데드라인 안에서 기다린다. 초과하면 BrokerError(status 0 = 결과 불명)로 던지고
 * 호출자를 풀어준다. 진행 중인 fetch 는 취소할 수 없으므로 뒤늦게 끝나도 결과는 버려진다.
 * (Promise.race 가 양쪽에 핸들러를 붙이므로 늦은 rejection 이 unhandled 로 새지 않는다)
 */
async function withDeadline<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: expired, resolve: expire } = Promise.withResolvers<typeof DEADLINE>();
  const timer = setTimeout(() => expire(DEADLINE), ms);
  try {
    const result = await Promise.race([fn(), expired]);
    if (result === DEADLINE) {
      throw new BrokerError(`AdsPower task 데드라인 초과 (${label}): ${ms}ms`, 0);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

class AdsPowerQueueManager {
  private static instance: AdsPowerQueueManager;
  private queue: QueueTask[] = [];
  private processing: boolean = false;
  private lastRequestTime: number = 0;
  private readonly MIN_INTERVAL_MS = 1100; // AdsPower 로컬 API = 초당 1회 → 1.1s 간격(실측 검증)

  // 현재 작업 중인 브라우저 추적 (start/stop 중복 방지)
  private activeBrowsers: Set<string> = new Set();

  // 서킷 브레이커 상태
  private breaker: BreakerState = "closed";
  private breakerOpenedAt: number = 0;
  private consecutiveBrokerFailures: number = 0;
  private probeInFlight: boolean = false;

  private constructor() {}

  static getInstance(): AdsPowerQueueManager {
    if (!AdsPowerQueueManager.instance) {
      AdsPowerQueueManager.instance = new AdsPowerQueueManager();
    }
    return AdsPowerQueueManager.instance;
  }

  /**
   * 브레이커 상태.
   * open 이더라도 쿨다운이 지났으면 "half-open"(= 프로브 허용)으로 보고한다.
   * 라우팅 판단자가 아무도 enqueue 하지 않는 동안 영구 open 으로 오해하지 않도록.
   */
  breakerState(): BreakerState {
    if (this.breaker === "open" && Date.now() - this.breakerOpenedAt >= BREAKER_OPEN_MS) {
      return "half-open";
    }
    return this.breaker;
  }

  /** 브레이커 게이트. 거절 사유가 있으면 그 에러를, 통과면 null 을 돌려준다. */
  private admit(label: string): BrokerError | null {
    if (this.breaker === "closed") return null;

    if (this.breaker === "open") {
      const elapsed = Date.now() - this.breakerOpenedAt;
      if (elapsed < BREAKER_OPEN_MS) {
        return new BrokerError(`AdsPower 브로커 서킷 open — 거절 (${label})`, 0);
      }
      this.breaker = "half-open";
      this.probeInFlight = true;
      console.log(`[AdsPowerQueue] 서킷 half-open — 단일 프로브 허용: ${label}`);
      return null;
    }

    if (this.probeInFlight) {
      return new BrokerError(`AdsPower 브로커 서킷 half-open(프로브 진행 중) — 거절 (${label})`, 0);
    }
    this.probeInFlight = true;
    return null;
  }

  /**
   * 브레이커 회계.
   * 앱 에러(AdsAppError 등)는 왕복이 성사됐다는 증거이므로 브로커 건강으로 친다 —
   * 그렇지 않으면 프로필 소멸 같은 앱 사유가 브로커를 억울하게 개방시킨다.
   */
  private recordOutcome(brokerFailure: boolean): void {
    if (!brokerFailure) {
      this.consecutiveBrokerFailures = 0;
      if (this.breaker !== "closed") {
        console.log(`[AdsPowerQueue] 서킷 closed 복귀`);
      }
      this.breaker = "closed";
      this.probeInFlight = false;
      return;
    }

    this.consecutiveBrokerFailures++;
    if (this.breaker === "half-open" || this.consecutiveBrokerFailures >= BREAKER_THRESHOLD) {
      if (this.breaker !== "open") {
        console.log(`[AdsPowerQueue] 서킷 open — 연속 브로커 실패 ${this.consecutiveBrokerFailures}회, ${BREAKER_OPEN_MS}ms 차단`);
      }
      this.breaker = "open";
      this.breakerOpenedAt = Date.now();
      this.probeInFlight = false;
    }
  }

  /**
   * 범용 API 호출 큐 (모든 AdsPower API 호출에 사용)
   */
  async enqueue<T>(label: string, fn: () => Promise<T>, options: EnqueueOptions = {}): Promise<T> {
    const rejection = this.admit(label);
    if (rejection) throw rejection;

    const deadlineMs = options.deadlineMs ?? DEFAULT_TASK_DEADLINE_MS;
    const { promise, resolve, reject } = Promise.withResolvers<T>();

    this.queue.push({
      label,
      run: async () => {
        try {
          resolve(await withDeadline(fn, deadlineMs, label));
          return { brokerFailure: false };
        } catch (e: unknown) {
          reject(e);
          return { brokerFailure: e instanceof BrokerError };
        }
      },
    });

    console.log(`[AdsPowerQueue] Queued: ${label} (queue size: ${this.queue.length})`);
    void this.processQueue();
    return promise;
  }

  /**
   * 같은 프로필의 선행 start/stop 이 끝날 때까지 상한을 두고 기다린다.
   * 상한 없는 스핀은 선행 작업이 영영 안 끝날 때 워커를 통째로 삼킨다.
   */
  private async awaitBrowserSlot(profileId: string): Promise<void> {
    if (!this.activeBrowsers.has(profileId)) return;

    console.log(`[AdsPowerQueue] Browser ${profileId} is already being processed, waiting...`);
    const startedAt = Date.now();
    while (this.activeBrowsers.has(profileId)) {
      const waited = Date.now() - startedAt;
      if (waited >= BROWSER_SLOT_WAIT_MS) {
        throw new LockTimeoutError(`adspower-queue:${profileId}`, waited);
      }
      await sleep(BROWSER_SLOT_POLL_MS);
    }
  }

  /**
   * 브라우저 시작 요청 (큐에 추가 + 중복 방지)
   */
  async startBrowser(apiKey: string, profileId: string, options: EnqueueOptions = {}) {
    await this.awaitBrowserSlot(profileId);
    this.activeBrowsers.add(profileId);
    try {
      return await this.enqueue(
        `start ${profileId}`,
        () => adspower.startBrowser(apiKey, profileId),
        options,
      );
    } finally {
      this.activeBrowsers.delete(profileId);
    }
  }

  /**
   * 브라우저 중지 요청 (큐에 추가 + 중복 방지)
   */
  async stopBrowser(apiKey: string, profileId: string, options: EnqueueOptions = {}) {
    await this.awaitBrowserSlot(profileId);
    this.activeBrowsers.add(profileId);
    try {
      return await this.enqueue(
        `stop ${profileId}`,
        () => adspower.stopBrowser(apiKey, profileId),
        options,
      );
    } finally {
      this.activeBrowsers.delete(profileId);
    }
  }

  /**
   * 큐 처리 (순차적, rate limiting 적용)
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      for (let task = this.queue.shift(); task; task = this.queue.shift()) {
        // Rate limiting: 마지막 요청 이후 최소 간격 대기
        const elapsed = Date.now() - this.lastRequestTime;
        if (elapsed < this.MIN_INTERVAL_MS) {
          await sleep(this.MIN_INTERVAL_MS - elapsed);
        }

        console.log(`[AdsPowerQueue] Processing: ${task.label}`);
        const outcome = await task.run();
        this.lastRequestTime = Date.now();
        this.recordOutcome(outcome.brokerFailure);
      }
    } finally {
      // 여기서 되돌리지 않으면 예외 한 번에 큐가 영구 동결되어 이후 모든 enqueue promise 가
      // 영원히 settle 되지 않는다 — 15 워커가 아무 로그 없이 멈추던 경로.
      this.processing = false;
      if (this.queue.length > 0) void this.processQueue();
    }
  }

  /**
   * 현재 큐 상태 조회
   */
  getStats() {
    return {
      queueSize: this.queue.length,
      activeBrowsers: Array.from(this.activeBrowsers),
      processing: this.processing,
      breaker: this.breakerState(),
      consecutiveBrokerFailures: this.consecutiveBrokerFailures,
    };
  }
}

// 싱글톤 인스턴스 export
export const adsPowerQueue = AdsPowerQueueManager.getInstance();

/**
 * REDESIGN.md §3 — 대상당 단일 writer 락 (P4).
 *
 * 기존에는 브라우저 수명주기를 세 컨트롤러(워커복구 / IP교체 / clear·리셋)가 동시에 변경하면서
 * 조율수단이 (a) 모듈 전역 `ipChangeInProgress` 불린과 (b) 브라우저별 `isRestarting` 플래그뿐이었다.
 * (a) 는 워커 루프 진입점에서만 검사되어 태스크 이후 복구 4경로가 전부 무방비였고,
 * (b) 는 `restart()` 가 검사하고 `startWithNewProxy()` 는 검사 없이 set/해제하는 단방향 가드였다.
 * 그 결과 "이미 재시작 중이면 아무것도 하지 않고 성공 반환"이 발생해, 호출자가 이미 획득한
 * 프록시가 주인 없이 남았다(사이클당 +1 영구 누수, 실패 로그 0건).
 *
 * 여기서는 profileId 단위로 실제 직렬화한다. 두 번째 진입자는 **큐잉되어 자기 작업을 수행**하므로
 * "조용한 성공"이 구조적으로 불가능하다. 모델 검증에서 이 락을 제거하면 즉시 I1·I3 이 깨진다.
 *
 * 키는 브라우저 객체가 아니라 **profileId** 다. 프로필 재생성으로 객체가 교체되어도 상호배제가 유지된다.
 */

import { LockTimeoutError } from "./errors";

/** 락 대기 상한. 초과 시 LockTimeoutError — 호출자는 획득한 lease 를 반납해야 한다. */
export const LOCK_DEADLINE_MS = 120_000;

export class LifecycleLock {
  /** profileId → 직렬화 체인의 꼬리 */
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * `key` 에 대해 `fn` 을 배타 실행한다.
   * 대기가 `deadlineMs` 를 넘으면 LockTimeoutError 를 던지되, 체인은 정상 진행시킨다
   * (자기 슬롯을 즉시 열어 후속 대기자를 막지 않는다).
   */
  async run<T>(key: string, fn: () => Promise<T>, deadlineMs: number = LOCK_DEADLINE_MS): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();
    const mine = previous.then(() => gate.promise);
    this.chains.set(key, mine);

    const expiry = Promise.withResolvers<never>();
    // race 에서 지면 이 rejection 은 소비되지 않으므로 미리 흡수해 둔다.
    expiry.promise.catch(() => undefined);
    const timer = setTimeout(() => expiry.reject(new LockTimeoutError(key, deadlineMs)), deadlineMs);

    try {
      await Promise.race([previous, expiry.promise]);
    } catch (error: unknown) {
      gate.resolve(); // 슬롯을 열어 체인이 막히지 않게 한다
      throw error;
    } finally {
      clearTimeout(timer);
    }

    try {
      return await fn();
    } finally {
      gate.resolve();
      if (this.chains.get(key) === mine) this.chains.delete(key);
    }
  }

  /** 진단용 — 현재 직렬화 체인이 걸려 있는 키 수 */
  pendingKeys(): number {
    return this.chains.size;
  }
}

let instance: LifecycleLock | null = null;

export function getLifecycleLock(): LifecycleLock {
  if (!instance) instance = new LifecycleLock();
  return instance;
}

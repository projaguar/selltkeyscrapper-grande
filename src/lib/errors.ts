/**
 * REDESIGN.md §6 — 타입드 에러.
 *
 * 기존에는 AdsPower 앱 에러가 전부 `Error(문자열)` 이라 `none exists`(프로필 소멸)를
 * 어느 호출자도 구분할 수 없었고, 그래서 "영구히 사라진 프로필"을 "일시적 프록시 문제"로
 * 오라우팅해 프록시 로테이션을 무한 반복했다(2026-07 인시던트 #2).
 *
 * 구분 축:
 *  - `BrokerError`  : 브로커/전송 계층 (HTTP 499/5xx, 네트워크/타임아웃 = status 0)
 *  - `AdsAppError`  : AdsPower 애플리케이션 계층 (HTTP 200 + {code:-1})
 *      - `ProfileGoneError` : 프로필이 상류에서 사라짐 → 프록시 로테이션 금지, 재생성 라우팅
 *      - `QuotaError`       : 프로필 한도 → 재생성 불가, park + 경보
 *  - `StopUnconfirmedError` : 정지를 확인하지 못함 → lease 반납 금지 (트래픽이 남아있을 수 있음)
 *  - `LockTimeoutError`     : 대상당 단일 writer 락 대기 초과
 */

/** 브로커/전송 계층 실패. `status` 0 = 네트워크/타임아웃. */
export class BrokerError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BrokerError";
    this.status = status;
  }
}

/** AdsPower 애플리케이션 실패 (HTTP 200 + code!==0). */
export class AdsAppError extends Error {
  readonly code: number;
  readonly rawMessage: string;

  constructor(code: number, rawMessage: string) {
    super(`AdsPower API error: ${rawMessage} (code: ${code})`);
    this.name = "AdsAppError";
    this.code = code;
    this.rawMessage = rawMessage;
  }
}

/** 프로필이 AdsPower 에 더 이상 없음. 프록시 로테이션으로 고칠 수 없다. */
export class ProfileGoneError extends AdsAppError {
  constructor(code: number, rawMessage: string) {
    super(code, rawMessage);
    this.name = "ProfileGoneError";
  }
}

/** 프로필 생성 한도 초과. 재생성 경로가 막힌다. */
export class QuotaError extends AdsAppError {
  constructor(code: number, rawMessage: string) {
    super(code, rawMessage);
    this.name = "QuotaError";
  }
}

/**
 * AdsPower 정지를 확인하지 못함.
 * 이 상태에서 프록시를 반납하면 아직 그 IP로 트래픽을 내는 브라우저가 남아
 * 다른 브라우저와 IP를 공유하게 된다(I1/I3 위반). 반납 금지.
 */
export class StopUnconfirmedError extends Error {
  readonly profileId: string;

  constructor(profileId: string, detail: string) {
    super(`정지 미확인 (${profileId}): ${detail}`);
    this.name = "StopUnconfirmedError";
    this.profileId = profileId;
  }
}

/** 대상당 단일 writer 락 대기 초과. 호출자는 획득한 lease 를 반납해야 한다. */
export class LockTimeoutError extends Error {
  readonly key: string;

  constructor(key: string, waitedMs: number) {
    super(`락 대기 초과 (${key}): ${waitedMs}ms`);
    this.name = "LockTimeoutError";
    this.key = key;
  }
}

/**
 * AdsPower 응답 메시지를 타입드 에러로 승격한다.
 * AdsPower Local API 는 상태를 code:-1 + msg 문자열로만 알려주므로 메시지 기반 분류가 불가피하다.
 */
export function classifyAdsError(code: number, rawMessage: string): AdsAppError {
  const msg = rawMessage.toLowerCase();
  if (
    msg.includes("none exists") ||
    msg.includes("not exist") ||
    msg.includes("not found") ||
    msg.includes("no such user")
  ) {
    return new ProfileGoneError(code, rawMessage);
  }
  if (msg.includes("limit") || msg.includes("quota") || msg.includes("exceed")) {
    return new QuotaError(code, rawMessage);
  }
  return new AdsAppError(code, rawMessage);
}

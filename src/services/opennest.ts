/**
 * OpenNest 게이트웨이(api.opennest.co.kr) 공통 인증 설정.
 *
 * 게이트웨이는 경로별 보호레벨(public/optional/required)을 런타임 토글한다.
 * 잠긴(required) 경로는 키 없는 요청을 401 로 거절하므로, api.opennest.co.kr 로 나가는
 * 모든 요청 헤더에 API 키를 선제 부착해 둔다(현재 대부분 public 이라 무해, flip 시 무중단).
 *
 * 전송 방식: `Authorization: Bearer sk_...` (X-API-Key 도 허용되나 Bearer 로 통일).
 * 키 형식: `sk_{company}_{random}` — 이 앱은 selltkey 소비자.
 * 사용법 근거: _my-wiki/wiki/guidelines/api-key-usage-guide.md
 *
 * 키는 env(OPENNEST_API_KEY)로 오버라이드하며, 없으면 발급된 기본 키로 폴백한다
 * (AdsPower 키의 HARDCODED_API_KEY 패턴과 동일 — 무인 실행 견고성 확보).
 */

const HARDCODED_OPENNEST_API_KEY = "sk_selltkey_Ih240ndmWi7KFBnwVjbG0F5e9hjvqjQAh5yJNl0yTo4";

export const OPENNEST_BASE_URL =
  process.env.OPENNEST_BASE_URL ?? "https://api.opennest.co.kr";

/** 현재 사용할 OpenNest API 키(env 우선, 없으면 기본 키). */
export function opennestApiKey(): string {
  const env = process.env.OPENNEST_API_KEY;
  return env && env.length > 0 ? env : HARDCODED_OPENNEST_API_KEY;
}

/**
 * api.opennest.co.kr 요청 헤더에 API 키(Authorization: Bearer)를 병합한다.
 * 기존 헤더는 유지하되, 호출자가 Authorization 을 직접 지정하지 않은 경우에만 주입한다.
 */
export function withOpennestAuth(
  headers: Record<string, string> = {},
): Record<string, string> {
  if (headers.Authorization || headers.authorization) return headers;
  return { ...headers, Authorization: `Bearer ${opennestApiKey()}` };
}

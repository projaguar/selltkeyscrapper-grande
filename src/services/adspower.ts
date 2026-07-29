import { BrokerError, classifyAdsError } from '../lib/errors';

// AdsPower base URL — env(ADSPOWER_BASE_URL)로 ads broker 경유. 미설정 시 브로커 기본값.
const ADSPOWER_API = process.env.ADSPOWER_BASE_URL ?? 'http://127.0.0.1:50326/ads';

// ads broker 통신 파라미터
// - 타임아웃 25s(REDESIGN §5): 90s 일 때 한 건이 큐 헤드를 최악 283s(3시도×90s+백오프) 붙잡아
//   AdsPower 트래픽 전체가 동결됐다. 브로커가 자체 재시도로 늘어지는 구간은 여기서 잘라내고
//   호출자가 상태 재확인으로 보상하는 편이 fleet 진행성(I4)에 유리하다.
const BROKER_TIMEOUT_MS = 25_000;
// - 5xx 재시도는 완만하게: 브로커가 이미 재시도/스페이싱하므로 공격적 재호출은 증폭 루프.
const BROKER_MAX_ATTEMPTS = 3;
const BROKER_BACKOFF_MS = 3_000;
const BROKER_BACKOFF_CAP_MS = 15_000;

// 목록 API 페이지네이션. 단일 페이지 100 가정은 그룹 프로필이 100 을 넘는 순간
// 소유 프로필을 "없는 것"으로 만들어 매 실행마다 중복 생성을 누적시켰다(P1, 무한 증가).
const LIST_PAGE_SIZE = 100;
// 브로커가 같은 페이지를 계속 채워 돌려주는 고장 모드에서도 루프는 유한해야 한다(P6).
const LIST_MAX_PAGES = 50;

/**
 * 셰딩 상태코드 — 업스트림이 실행되지 않은 것이 확실하다.
 * 그래서 비멱등 쓰기도 안전하게 재시도할 수 있다. 5xx/408 은 실행 여부가 불명이라 멱등 요청 전용.
 */
const SHED_STATUSES: ReadonlySet<number> = new Set([425, 429, 503]);

interface AdsRequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  // 재시도 완전 금지(1회만). 예: browser/start — GET 이라 브로커는 재시도하지만(멱등, 기존 ws 반환),
  // 앱은 별도 status 확인으로 대체하므로 여기선 재시도하지 않는다.
  noRetry?: boolean;
  // 비멱등 쓰기(user/create, group/create 등): 셰딩에서만 재시도하고 5xx/408/네트워크/타임아웃
  // (실행 여부 불명)에는 재시도하지 않는다 → 중복 생성 방지.
  nonIdempotent?: boolean;
  // liveness 프로브처럼 기본값보다 짧게 끊어야 하는 호출용.
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Retry-After(초 또는 HTTP-date)를 상한 안에서 존중한다. 없거나 해석 불가면 undefined. */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, BROKER_BACKOFF_CAP_MS);
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), BROKER_BACKOFF_CAP_MS);
}

/**
 * ads broker / AdsPower 공용 요청.
 * 브로커 상태코드(모두 body {code:-1,msg}):
 *  - 500/502/504 업스트림 실패, 408 요청 타임아웃 → 실행 여부 불명 → 멱등 요청만 재시도
 *  - 503/429/425 셰딩 → 미실행 확실 → 비멱등 쓰기도 재시도
 *  - 499 클라이언트 취소(앱 abort 시만) → 재시도 안 함
 * AdsPower 앱 에러는 HTTP 200 + {code:-1} 로 오므로 HTTP 상태코드로 브로커/앱 계층을 가른다.
 * 앱 에러는 `classifyAdsError` 로 승격한다 — 전부 문자열 Error 였을 때는 `none exists`(프로필 소멸)를
 * 아무도 구분하지 못해 영구 소멸을 일시적 프록시 문제로 오라우팅했고, 그 결과 프록시 로테이션이
 * 무한 반복되며 풀이 전멸했다(R5, 인시던트 #2).
 * API 키는 브로커가 Authorization 을 주입하므로 여기 Bearer 는 무시된다(호환용 유지).
 */
async function makeRequest(endpoint: string, apiKey: string, options: AdsRequestOptions = {}) {
  const url = `${ADSPOWER_API}${endpoint}`;
  const { noRetry, nonIdempotent, timeoutMs, headers: extraHeaders, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const maxAttempts = noRetry ? 1 : BROKER_MAX_ATTEMPTS;
  // 결과 불명(실행됐을 수도 있음)은 status 0 으로 통일한다 — 호출자의 보상 분기가 이 값을 본다.
  const noRetryOnUnknown = noRetry === true || nonIdempotent === true;

  // for(;;) — 종료 조건을 attempt 검사에 몰아둔다. 모든 경로가 return 또는 throw 로 끝나고
  // continue 는 attempt<maxAttempts 에서만 도달하므로 루프 밖 도달 불가 코드가 생기지 않는다.
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: AbortSignal.timeout(timeoutMs ?? BROKER_TIMEOUT_MS),
      });
    } catch (e: unknown) {
      const err = new BrokerError(`AdsPower broker 연결 실패: ${e instanceof Error ? e.message : String(e)}`, 0);
      if (noRetryOnUnknown || attempt >= maxAttempts) throw err;
      await sleep(Math.min(BROKER_BACKOFF_MS * attempt, BROKER_BACKOFF_CAP_MS));
      continue;
    }

    if (!response.ok) {
      // 비 2xx 는 전부 브로커/전송 계층. 앱 에러는 200 으로만 온다.
      const body = await response.text().catch(() => '');
      const err = new BrokerError(`AdsPower broker ${response.status}: ${body}`, response.status);
      const shed = SHED_STATUSES.has(response.status);
      // 499 는 우리가 끊은 것이라 재시도 의미가 없어 아래 조건에서 자연히 제외된다.
      const retryableStatus = response.status >= 500 || response.status === 408 || shed;
      const retryable = !noRetry && retryableStatus && (!nonIdempotent || shed);
      if (!retryable || attempt >= maxAttempts) throw err;
      const slow = response.status === 503 || response.status === 504;
      const backoff = retryAfterMs(response)
        ?? Math.min(BROKER_BACKOFF_MS * attempt + (slow ? 2_000 : 0), BROKER_BACKOFF_CAP_MS);
      console.log(`[AdsPower] 브로커 ${response.status} — ${backoff}ms 후 재시도(${attempt}/${maxAttempts}): ${endpoint}`);
      await sleep(backoff);
      continue;
    }

    // 2xx 인데 JSON 이 아니면 업스트림 실행 여부를 알 수 없다 → status 0 으로 분류해야 호출자의
    // 보상 분기(상태 재확인)가 열린다. status 200 으로 던지면 그 분기(status>=500||0)를 통과 못 했다.
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      const err = new BrokerError(`AdsPower broker ${response.status}: JSON 파싱 실패(결과 불명)`, 0);
      if (noRetryOnUnknown || attempt >= maxAttempts) throw err;
      await sleep(Math.min(BROKER_BACKOFF_MS * attempt, BROKER_BACKOFF_CAP_MS));
      continue;
    }
    if (!result || typeof result !== 'object') {
      throw new BrokerError(`AdsPower broker ${response.status}: 응답 본문이 객체가 아님(결과 불명)`, 0);
    }

    // AdsPower 성공 응답: { code: 0, msg: "success", data: {...} }
    const envelope = result as { code?: unknown; msg?: unknown }; // 브로커 경계 — 스키마 미보장 JSON
    if (envelope.code !== 0) {
      const code = typeof envelope.code === 'number' ? envelope.code : -1;
      throw classifyAdsError(code, typeof envelope.msg === 'string' ? envelope.msg : 'Unknown error');
    }
    return result;
  }
}

/** AdsPower 목록 응답 봉투에서 `data.list` 배열을 꺼낸다. 형태가 다르면 빈 배열. */
function extractList(result: unknown): unknown[] {
  if (!result || typeof result !== 'object' || !('data' in result)) return [];
  const data = result.data;
  if (!data || typeof data !== 'object' || !('list' in data)) return [];
  const list = data.list;
  return Array.isArray(list) ? list : [];
}

/** 짧은 페이지가 올 때까지 전 페이지를 순회해 합친다. 항목은 미검증 raw — 호출자가 타입가드한다. */
async function collectPages(apiKey: string, buildUrl: (page: number, pageSize: number) => string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page++) {
    const items = extractList(await makeRequest(buildUrl(page, LIST_PAGE_SIZE), apiKey));
    all.push(...items);
    if (items.length < LIST_PAGE_SIZE) return all;
  }
  console.warn(`[AdsPower] 페이지 상한(${LIST_MAX_PAGES}) 도달 — 목록이 잘렸을 수 있음: ${buildUrl(1, LIST_PAGE_SIZE)}`);
  return all;
}

/**
 * 프로필 목록 조회 (단일 페이지)
 * groupId 지정 시 해당 AdsPower 그룹으로 스코프 (미지정 = 전체 그룹)
 */
export async function listProfiles(apiKey: string, page = 1, pageSize = 100, groupId?: string) {
  const groupParam = groupId ? `&group_id=${groupId}` : '';
  return makeRequest(`/api/v1/user/list?page=${page}&page_size=${pageSize}${groupParam}`, apiKey);
}

/**
 * 프로필 전체 목록(전 페이지 병합). 반환 항목은 미검증 raw.
 * 풀 관리·리컨실은 반드시 이 함수를 써야 한다 — 1페이지만 보면 100번째 이후 소유 프로필이
 * 보이지 않아 매 실행마다 중복 생성이 쌓인다.
 */
export async function listAllProfiles(apiKey: string, groupId?: string): Promise<unknown[]> {
  const groupParam = groupId ? `&group_id=${groupId}` : '';
  return collectPages(apiKey, (page, size) => `/api/v1/user/list?page=${page}&page_size=${size}${groupParam}`);
}

/**
 * 프로필 생성
 */
export async function createProfile(apiKey: string, profileData: object) {
  console.log('[AdsPower] createProfile request:', JSON.stringify(profileData));
  const result = await makeRequest('/api/v1/user/create', apiKey, {
    method: 'POST',
    body: JSON.stringify(profileData),
    nonIdempotent: true, // 실행 여부 불명인 실패에 재시도하면 프로필이 중복 생성되어 quota 를 침식한다
  });
  console.log('[AdsPower] createProfile response:', JSON.stringify((result as { data?: unknown }).data));
  return result;
}

/**
 * 프로필 일괄 삭제
 */
export async function deleteProfiles(apiKey: string, profileIds: string[]) {
  return makeRequest('/api/v1/user/delete', apiKey, {
    method: 'POST',
    body: JSON.stringify({ user_ids: profileIds }),
  });
}

/**
 * 프로필 단건 삭제
 */
export async function deleteProfile(apiKey: string, profileId: string) {
  return deleteProfiles(apiKey, [profileId]);
}

/**
 * 브라우저 시작 (WebSocket URL 반환)
 */
export async function startBrowser(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/start?user_id=${profileId}&ip_tab=0`, apiKey, { noRetry: true });
}

/**
 * 브라우저 종료
 */
export async function stopBrowser(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/stop?user_id=${profileId}`, apiKey);
}

/**
 * 브라우저 활성 상태 확인
 */
export async function checkBrowserStatus(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/active?user_id=${profileId}`, apiKey);
}

/**
 * 프로필 업데이트 (프록시, 탭 설정 등)
 */
export async function updateProfile(apiKey: string, profileId: string, updateData: object) {
  return makeRequest('/api/v1/user/update', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      user_id: profileId,
      ...updateData,
    }),
  });
}

/**
 * 그룹 목록 조회 (단일 페이지)
 */
export async function listGroups(apiKey: string, page = 1, pageSize = 100) {
  return makeRequest(`/api/v1/group/list?page=${page}&page_size=${pageSize}`, apiKey);
}

/**
 * 그룹 전체 목록(전 페이지 병합). 반환 항목은 미검증 raw.
 * 그룹이 100 개를 넘으면 1페이지 조회는 기존 scrapper 그룹을 못 찾고 중복 생성한다.
 */
export async function listAllGroups(apiKey: string): Promise<unknown[]> {
  return collectPages(apiKey, (page, size) => `/api/v1/group/list?page=${page}&page_size=${size}`);
}

/**
 * 그룹 생성 → group_id 반환
 */
export async function createGroup(apiKey: string, groupName: string): Promise<string> {
  const result = await makeRequest('/api/v1/group/create', apiKey, {
    method: 'POST',
    body: JSON.stringify({ group_name: groupName }),
    // AdsPower 는 그룹 이름 유일성을 강제하지 않는다. 502/타임아웃에 재시도하면 같은 이름의
    // 그룹이 둘 생기고 격리 스코프가 두 group_id 로 쪼개진다(I7).
    nonIdempotent: true,
  });
  const gid = (result as { data?: { group_id?: unknown } }).data?.group_id; // 브로커 경계 — 스키마 미보장 JSON
  if (gid == null || gid === '') {
    throw new Error('AdsPower group/create 응답에 group_id 가 없습니다');
  }
  return String(gid);
}

/**
 * 브로커/AdsPower liveness 프로브.
 * 재시도 없이 짧게 끊고 boolean 만 돌려준다 — 기동 대기 루프가 긴 재시도 체인에 물려
 * 자기 예산을 무의미하게 만드는 일을 막는다. 실패는 던지지 않는다.
 */
export async function ping(apiKey: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    await makeRequest('/api/v1/group/list?page=1&page_size=1', apiKey, { noRetry: true, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// AdsPower base URL — env(ADSPOWER_BASE_URL)로 ads broker 경유. 미설정 시 브로커 기본값.
const ADSPOWER_API = process.env.ADSPOWER_BASE_URL ?? 'http://127.0.0.1:50326/ads';

// ads broker 통신 파라미터
// - 타임아웃 90s: 브로커 GET 최악 ≈66s + 슬롯 대기 여유. 70s 미만 금지(브로커 재시도 전 잘림).
const BROKER_TIMEOUT_MS = 90_000;
// - 502/503 재시도는 완만하게: 브로커가 이미 재시도/스페이싱하므로 공격적 재호출은 증폭 루프.
const BROKER_MAX_ATTEMPTS = 3;
const BROKER_BACKOFF_MS = 3_000;

interface AdsRequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  // browser/start 처럼 브로커가 재시도하지 않는 비멱등 호출 → 앱도 재시도 금지.
  noRetry?: boolean;
}

/** ads broker HTTP 상태코드를 담는 에러(502/503/499, 0=네트워크/타임아웃). */
export class BrokerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * ads broker / AdsPower 공용 요청.
 * 브로커 상태코드(모두 body {code:-1,msg}):
 *  - 502 업스트림 재시도 소진 → 완만 백오프 후 재시도
 *  - 503 과부하 셰딩 → 더 긴 백오프 후 재시도(즉시 재호출 금지)
 *  - 499 클라이언트 취소(앱 abort 시만) → 재시도 안 함
 * AdsPower 앱 에러는 HTTP 200 + {code:-1} 로 오므로 HTTP 상태코드로 브로커/앱을 구분한다.
 * API 키는 브로커가 Authorization 을 주입하므로 여기 Bearer 는 무시된다(호환용 유지).
 */
async function makeRequest(endpoint: string, apiKey: string, options: AdsRequestOptions = {}) {
  const url = `${ADSPOWER_API}${endpoint}`;
  const { noRetry, headers: extraHeaders, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const maxAttempts = noRetry ? 1 : BROKER_MAX_ATTEMPTS;

  let lastErr: BrokerError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        headers,
        signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
      });
    } catch (e: unknown) {
      // 네트워크/타임아웃 — 완만 재시도(비멱등은 noRetry 로 1회만)
      lastErr = new BrokerError(`AdsPower broker 연결 실패: ${e instanceof Error ? e.message : String(e)}`, 0);
      if (noRetry || attempt >= maxAttempts) throw lastErr;
      await sleep(BROKER_BACKOFF_MS * attempt);
      continue;
    }

    // 499: 클라이언트 취소(앱 abort 시만) — 재시도 안 함.
    if (response.status === 499) {
      throw new BrokerError('AdsPower broker 499: 클라이언트 취소', 499);
    }
    // 5xx: 브로커/업스트림 장애(502/503/504/500 등) — 완만 백오프 후 재시도.
    //  브로커가 이미 재시도/스페이싱하므로 공격적 재호출은 증폭 루프 → 백오프 필수.
    //  503(셰딩)/504(게이트웨이 타임아웃)은 더 길게 백오프.
    if (response.status >= 500) {
      const body = await response.text().catch(() => '');
      const slow = response.status === 503 || response.status === 504;
      lastErr = new BrokerError(`AdsPower broker ${response.status}: ${body}`, response.status);
      if (noRetry || attempt >= maxAttempts) throw lastErr;
      const backoff = BROKER_BACKOFF_MS * attempt + (slow ? 2_000 : 0);
      console.log(`[AdsPower] 브로커 ${response.status} — ${backoff}ms 후 재시도(${attempt}/${maxAttempts}): ${endpoint}`);
      await sleep(backoff);
      continue;
    }

    // 2xx/4xx: JSON 파싱(비 JSON body 방어). 파싱 실패는 상태코드를 담아 명확히 throw.
    const result = await response.json().catch(() => {
      throw new BrokerError(`AdsPower broker ${response.status}: JSON 파싱 실패`, response.status);
    });
    // AdsPower API returns { code: 0, msg: "success", data: {...} } on success
    if (result.code !== 0) {
      throw new Error(`AdsPower API error: ${result.msg || 'Unknown error'} (code: ${result.code})`);
    }
    return result;
  }
  throw lastErr ?? new BrokerError('AdsPower broker: 재시도 소진', 0);
}

/**
 * 프로필 목록 조회
 * groupId 지정 시 해당 AdsPower 그룹으로 스코프 (미지정 = 전체 그룹)
 */
export async function listProfiles(apiKey: string, page = 1, pageSize = 100, groupId?: string) {
  const groupParam = groupId ? `&group_id=${groupId}` : '';
  return makeRequest(`/api/v1/user/list?page=${page}&page_size=${pageSize}${groupParam}`, apiKey);
}

/**
 * 프로필 생성
 */
export async function createProfile(apiKey: string, profileData: any) {
  console.log('[AdsPower] createProfile request:', JSON.stringify(profileData));
  const result = await makeRequest('/api/v1/user/create', apiKey, {
    method: 'POST',
    body: JSON.stringify(profileData),
  });
  console.log('[AdsPower] createProfile response:', JSON.stringify(result.data));
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
export async function updateProfile(apiKey: string, profileId: string, updateData: any) {
  return makeRequest('/api/v1/user/update', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      user_id: profileId,
      ...updateData,
    }),
  });
}

/**
 * 프로필 상세 정보 조회
 */
export async function getProfile(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/user/detail?user_id=${profileId}`, apiKey);
}

/**
 * 어플리케이션 카테고리 목록 조회 (브라우저 타입: Chrome, Firefox, Android 등)
 */
export async function listApplicationCategories(apiKey: string, page = 1, pageSize = 100) {
  const result = await makeRequest(`/api/v1/application/list?page=${page}&page_size=${pageSize}`, apiKey);
  console.log('[AdsPower] App categories:', JSON.stringify(result.data?.list));
  return result;
}

/**
 * 그룹 목록 조회
 */
export async function listGroups(apiKey: string, page = 1, pageSize = 100) {
  return makeRequest(`/api/v1/group/list?page=${page}&page_size=${pageSize}`, apiKey);
}

/**
 * 그룹 생성 → group_id 반환
 */
export async function createGroup(apiKey: string, groupName: string): Promise<string> {
  const result = await makeRequest('/api/v1/group/create', apiKey, {
    method: 'POST',
    body: JSON.stringify({ group_name: groupName }),
  });
  const gid = result.data?.group_id;
  if (gid == null || gid === '') {
    throw new Error('AdsPower group/create 응답에 group_id 가 없습니다');
  }
  return String(gid);
}

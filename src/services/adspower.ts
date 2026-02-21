const ADSPOWER_API = 'http://local.adspower.net:50325';

async function makeRequest(endpoint: string, apiKey: string, options: any = {}) {
  const url = `${ADSPOWER_API}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const result = await response.json();

  // AdsPower API returns { code: 0, msg: "success", data: {...} } on success
  if (result.code !== 0) {
    throw new Error(`AdsPower API error: ${result.msg || 'Unknown error'} (code: ${result.code})`);
  }

  return result;
}

/**
 * 프로필 목록 조회
 */
export async function listProfiles(apiKey: string, page = 1, pageSize = 100) {
  return makeRequest(`/api/v1/user/list?page=${page}&page_size=${pageSize}`, apiKey);
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
  return makeRequest(`/api/v1/browser/start?user_id=${profileId}&ip_tab=0`, apiKey);
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

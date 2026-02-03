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

  return await response.json();
}

export async function listProfiles(apiKey: string, page = 1, pageSize = 100) {
  return makeRequest(`/api/v1/user/list?page=${page}&page_size=${pageSize}`, apiKey);
}

export async function createProfile(apiKey: string, profileData: any) {
  return makeRequest('/api/v1/user/create', apiKey, {
    method: 'POST',
    body: JSON.stringify(profileData),
  });
}

export async function deleteProfiles(apiKey: string, profileIds: string[]) {
  return makeRequest('/api/v1/user/delete', apiKey, {
    method: 'POST',
    body: JSON.stringify({ user_ids: profileIds }),
  });
}

export async function startBrowser(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/start?user_id=${profileId}`, apiKey);
}

export async function stopBrowser(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/stop?user_id=${profileId}`, apiKey);
}

export async function checkBrowserStatus(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/browser/active?user_id=${profileId}`, apiKey);
}

export async function updateProfile(apiKey: string, profileId: string, updateData: any) {
  return makeRequest(`/api/v1/user/update`, apiKey, {
    method: 'POST',
    body: JSON.stringify({
      user_id: profileId,
      ...updateData,
    }),
  });
}

/**
 * 프록시 IP 변경 (프록시 타입이 지원하는 경우)
 * AdsPower는 프로필의 프록시 IP를 교체할 수 있는 API 제공
 */
export async function changeProxyIp(apiKey: string, profileId: string) {
  console.log(`[AdsPower] Changing proxy IP for profile: ${profileId}`);
  const result = await makeRequest(`/api/v1/user/change-proxy-ip?user_ids=${profileId}`, apiKey);
  console.log(`[AdsPower] Proxy IP change result:`, JSON.stringify(result));
  return result;
}

/**
 * 프로필 상세 정보 조회 (프록시 설정 포함)
 */
export async function getProfile(apiKey: string, profileId: string) {
  return makeRequest(`/api/v1/user/detail?user_id=${profileId}`, apiKey);
}

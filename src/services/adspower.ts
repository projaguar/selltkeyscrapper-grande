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

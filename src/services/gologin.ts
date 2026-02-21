const GOLOGIN_API = 'https://api.gologin.com';

// REST API 직접 호출 (SDK에서 제공하지 않는 기능용)
async function makeRequest(endpoint: string, apiKey: string, options: any = {}) {
  const url = `${GOLOGIN_API}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }

  const text = await response.text();
  if (!text) return { success: true };
  return JSON.parse(text);
}

// GologinApi SDK 인스턴스 캐시
let glInstance: any = null;
let glToken: string = '';

async function getGologinApi(apiKey: string) {
  if (glInstance && glToken === apiKey) return glInstance;

  const { GologinApi } = await import('gologin');
  glInstance = GologinApi({ token: apiKey });
  glToken = apiKey;
  return glInstance;
}

// SDK 사용: 랜덤 fingerprint로 프로필 생성
export async function createProfile(apiKey: string, name: string) {
  const gl = await getGologinApi(apiKey);
  return await gl.createProfileRandomFingerprint(name);
}

// SDK 사용: 프로필 삭제 (단건)
export async function deleteProfile(apiKey: string, profileId: string) {
  const gl = await getGologinApi(apiKey);
  return await gl.deleteProfile(profileId);
}

// SDK 사용: 프록시 변경
export async function changeProfileProxy(apiKey: string, profileId: string, proxyData: any) {
  const gl = await getGologinApi(apiKey);
  return await gl.changeProfileProxy(profileId, proxyData);
}

// REST API: 프로필 목록 조회 (SDK 미제공)
export async function listProfiles(apiKey: string) {
  return makeRequest('/browser/v2', apiKey);
}

// REST API: 프로필 상세 조회
export async function getProfile(apiKey: string, profileId: string) {
  return makeRequest(`/browser/${profileId}`, apiKey);
}

// REST API: 프로필 수정
export async function updateProfile(apiKey: string, profileId: string, data: any) {
  return makeRequest(`/browser/${profileId}`, apiKey, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// REST API: 프로필 일괄 삭제 (SDK는 단건만 지원)
export async function deleteProfiles(apiKey: string, profileIds: string[]) {
  return makeRequest('/browser', apiKey, {
    method: 'DELETE',
    body: JSON.stringify({ profilesToDelete: profileIds }),
  });
}

// SDK: 브라우저 실행 (각 호출마다 새 인스턴스 생성 - SDK는 프로필별 상태 추적)
export async function launchBrowser(apiKey: string, profileId: string) {
  const { GologinApi } = await import('gologin');
  const gl = GologinApi({ token: apiKey });

  const launchParams: any = {
    profileId,
    // GoLogin 내부 프록시 체크(getTimeZone) 타임아웃: 기본 13초 → 30초
    proxyCheckTimeout: 30 * 1000,
    // 이전 세션 복원 비활성화 → startUrl(naver.com)로 시작
    restoreLastSession: false,
  };

  console.log(`[GoLogin] Launch params:`, JSON.stringify(launchParams));
  const { browser } = await gl.launch(launchParams);
  return { browser, glInstance: gl };
}

// SDK: 브라우저 종료
export async function exitBrowser(glInstance: any) {
  await glInstance.exit();
}

// 프로필 안티디텍션 설정 강화
// GoLogin quick 프로필의 기본 설정을 검사하고 최적화
export async function hardenProfile(apiKey: string, profileId: string): Promise<{ updated: boolean; changes: string[] }> {
  const profile = await getProfile(apiKey, profileId);
  const changes: string[] = [];
  let needsUpdate = false;

  // webRTC: 'alerted' 또는 'disabled' 권장 (real이면 실제 IP 노출)
  if (profile.webRTC) {
    if (profile.webRTC.mode === 'real' || !profile.webRTC.mode) {
      profile.webRTC.mode = 'alerted';
      profile.webRTC.enabled = true;
      profile.webRTC.customize = true;
      profile.webRTC.fillBasedOnIp = true;
      profile.webRTC.localIpMasking = true;
      changes.push('webRTC: real → alerted (IP 노출 방지)');
      needsUpdate = true;
    }
  } else {
    profile.webRTC = { mode: 'alerted', enabled: true, customize: true, fillBasedOnIp: true, localIpMasking: true };
    changes.push('webRTC: 설정 추가 (alerted)');
    needsUpdate = true;
  }

  // canvas: 'noise' 권장 (off면 핑거프린트 감지 가능)
  if (profile.canvas) {
    if (profile.canvas.mode === 'off' || !profile.canvas.mode) {
      profile.canvas.mode = 'noise';
      changes.push('canvas: off → noise');
      needsUpdate = true;
    }
  } else {
    profile.canvas = { mode: 'noise' };
    changes.push('canvas: 설정 추가 (noise)');
    needsUpdate = true;
  }

  // webGL - image noise
  if (profile.webGL) {
    if (profile.webGL.mode === 'off' || !profile.webGL.mode) {
      profile.webGL.mode = 'noise';
      changes.push('webGL: off → noise');
      needsUpdate = true;
    }
  } else {
    profile.webGL = { mode: 'noise' };
    changes.push('webGL: 설정 추가 (noise)');
    needsUpdate = true;
  }

  // webGLMetadata - vendor/renderer masking
  if (profile.webGLMetadata) {
    if (profile.webGLMetadata.mode === 'off' || !profile.webGLMetadata.mode) {
      profile.webGLMetadata.mode = 'mask';
      changes.push('webGLMetadata: off → mask');
      needsUpdate = true;
    }
  } else {
    profile.webGLMetadata = { mode: 'mask' };
    changes.push('webGLMetadata: 설정 추가 (mask)');
    needsUpdate = true;
  }

  // geolocation: prompt (사이트가 위치 요청 시 허용하되, 프록시 IP 기반으로 제공)
  if (profile.geolocation) {
    if (profile.geolocation.mode === 'block') {
      profile.geolocation.mode = 'prompt';
      changes.push('geolocation: block → prompt');
      needsUpdate = true;
    }
  }

  // fonts masking 활성화
  if (profile.fonts && !profile.fonts.enableMasking) {
    profile.fonts.enableMasking = true;
    changes.push('fonts: masking 활성화');
    needsUpdate = true;
  }

  // startUrl: 브라우저 시작 시 안전한 페이지로 열기 (이전 크롤링 페이지 복원 방지)
  if (profile.startUrl !== 'https://www.naver.com') {
    profile.startUrl = 'https://www.naver.com';
    changes.push('startUrl: naver.com 설정');
    needsUpdate = true;
  }

  if (needsUpdate) {
    await updateProfile(apiKey, profileId, profile);
    console.log(`[GoLogin] Profile ${profileId} hardened:`, changes.join(', '));
  } else {
    console.log(`[GoLogin] Profile ${profileId} fingerprint settings OK`);
  }

  return { updated: needsUpdate, changes };
}

// REST: 프록시 PATCH
export async function patchProxy(apiKey: string, profileId: string, proxyData: any) {
  return makeRequest(`/browser/${profileId}/proxy`, apiKey, {
    method: 'PATCH',
    body: JSON.stringify(proxyData),
  });
}

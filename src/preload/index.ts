import { contextBridge, ipcRenderer } from 'electron';

// Electron API를 React에 노출
contextBridge.exposeInMainWorld('electronAPI', {
  // 앱 경로 가져오기
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // GoLogin API 호출
  gologin: {
    listProfiles: (apiKey: string) => ipcRenderer.invoke('gologin-list-profiles', apiKey),
    createProfile: (apiKey: string, name: string) => ipcRenderer.invoke('gologin-create-profile', apiKey, name),
    getProfile: (apiKey: string, profileId: string) => ipcRenderer.invoke('gologin-get-profile', apiKey, profileId),
    updateProfile: (apiKey: string, profileId: string, data: any) => ipcRenderer.invoke('gologin-update-profile', apiKey, profileId, data),
    deleteProfiles: (apiKey: string, profileIds: string[]) => ipcRenderer.invoke('gologin-delete-profiles', apiKey, profileIds),
  },

  // SQLite 데이터베이스
  db: {
    // Proxy Groups
    getProxyGroups: () => ipcRenderer.invoke('db-get-proxy-groups'),
    getProxyGroupsWithCount: () => ipcRenderer.invoke('db-get-proxy-groups-with-count'),
    addProxyGroup: (name: string, maxBrowsers: number) => ipcRenderer.invoke('db-add-proxy-group', name, maxBrowsers),
    updateProxyGroup: (id: number, updates: any) => ipcRenderer.invoke('db-update-proxy-group', id, updates),
    deleteProxyGroup: (id: number) => ipcRenderer.invoke('db-delete-proxy-group', id),

    // Proxies
    getProxies: () => ipcRenderer.invoke('db-get-proxies'),
    getProxiesByGroup: (groupId: number) => ipcRenderer.invoke('db-get-proxies-by-group', groupId),
    addProxy: (proxy: any) => ipcRenderer.invoke('db-add-proxy', proxy),
    updateProxy: (id: number, updates: any) => ipcRenderer.invoke('db-update-proxy', id, updates),
    updateProxyGroupId: (proxyId: number, groupId: number) => ipcRenderer.invoke('db-update-proxy-group-id', proxyId, groupId),
    deleteProxy: (id: number) => ipcRenderer.invoke('db-delete-proxy', id),
    deleteAllProxies: () => ipcRenderer.invoke('db-delete-all-proxies'),
    deleteProxiesByGroup: (groupId: number) => ipcRenderer.invoke('db-delete-proxies-by-group', groupId),
    bulkAddProxies: (proxies: any[], groupId?: number) => ipcRenderer.invoke('db-bulk-add-proxies', proxies, groupId),
    importProxiesFromFile: (groupId?: number) => ipcRenderer.invoke('db-import-proxies-from-file', groupId),
  },

  // 설정 관리
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings-get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings-set', key, value),
    getAll: () => ipcRenderer.invoke('settings-get-all'),
  },

  // ProxyPool 테스트
  proxyPool: {
    test: () => ipcRenderer.invoke('proxypool-test'),
  },

  // SessionManager
  session: {
    assignProxyToProfile: (apiKey: string, profileId: string, profileName: string) =>
      ipcRenderer.invoke('session-assign-proxy-to-profile', apiKey, profileId, profileName),
    assignProxyToAll: (apiKey: string) =>
      ipcRenderer.invoke('session-assign-proxy-to-all', apiKey),
    getAll: (apiKey: string) =>
      ipcRenderer.invoke('session-get-all', apiKey),
    replaceProxy: (apiKey: string, profileId: string) =>
      ipcRenderer.invoke('session-replace-proxy', apiKey, profileId),
  },

  // Server API
  api: {
    getUrlList: () => ipcRenderer.invoke('api-get-url-list'),
  },

  // Crawler (DDD 패턴 - BrowserManager 사용)
  crawler: {
    // 브라우저 준비 (프로필 목록으로 CrawlerBrowser 인스턴스 생성)
    prepareBrowsers: (apiKey: string, profiles: Array<{ user_id: string; name: string }>) =>
      ipcRenderer.invoke('crawler-prepare-browsers', apiKey, profiles),

    // 준비 진행 상황 이벤트 리스너
    onPrepareProgress: (callback: (data: { current: number; total: number; result: any }) => void) => {
      const handler = (_event: any, data: { current: number; total: number; result: any }) => callback(data);
      ipcRenderer.on('crawler-prepare-progress', handler);
      // 리스너 제거 함수 반환
      return () => ipcRenderer.removeListener('crawler-prepare-progress', handler);
    },

    // 크롤링 시작 (준비된 브라우저 사용)
    startBatch: () => ipcRenderer.invoke('crawler-start-batch'),

    // 크롤러 중지
    stop: () => ipcRenderer.invoke('crawler-stop'),

    // 브라우저 정리 (크롤링 종료 시)
    clearBrowsers: () => ipcRenderer.invoke('crawler-clear-browsers'),

    // 크롤러 상태 조회
    getStatus: () => ipcRenderer.invoke('crawler-get-status'),

    // 크롤러 진행 상태 조회 (상세)
    getProgress: () => ipcRenderer.invoke('crawler-get-progress'),
  },
});

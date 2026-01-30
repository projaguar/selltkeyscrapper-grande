import { contextBridge, ipcRenderer } from 'electron';

// Electron API를 React에 노출
contextBridge.exposeInMainWorld('electronAPI', {
  // 앱 경로 가져오기
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // AdsPower API 호출
  adspower: {
    listProfiles: (apiKey: string) => ipcRenderer.invoke('adspower-list-profiles', apiKey),
    createProfile: (apiKey: string, data: any) => ipcRenderer.invoke('adspower-create-profile', apiKey, data),
    deleteProfiles: (apiKey: string, profileIds: string[]) => ipcRenderer.invoke('adspower-delete-profiles', apiKey, profileIds),
    startBrowser: (apiKey: string, profileId: string) => ipcRenderer.invoke('adspower-start-browser', apiKey, profileId),
    stopBrowser: (apiKey: string, profileId: string) => ipcRenderer.invoke('adspower-stop-browser', apiKey, profileId),
    puppeteerTest: (apiKey: string, profileId: string) => ipcRenderer.invoke('adspower-puppeteer-test', apiKey, profileId),
  },

  // SQLite 데이터베이스
  db: {
    getProxies: () => ipcRenderer.invoke('db-get-proxies'),
    addProxy: (proxy: any) => ipcRenderer.invoke('db-add-proxy', proxy),
    updateProxy: (id: number, updates: any) => ipcRenderer.invoke('db-update-proxy', id, updates),
    deleteProxy: (id: number) => ipcRenderer.invoke('db-delete-proxy', id),
    deleteAllProxies: () => ipcRenderer.invoke('db-delete-all-proxies'),
    bulkAddProxies: (proxies: any[]) => ipcRenderer.invoke('db-bulk-add-proxies', proxies),
    importProxiesFromFile: () => ipcRenderer.invoke('db-import-proxies-from-file'),
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

  // Browser Verification
  browser: {
    startAndVerify: (apiKey: string, profileId: string, profileName: string, maxRetries?: number) =>
      ipcRenderer.invoke('browser-start-and-verify', apiKey, profileId, profileName, maxRetries),
  },

  // Server API
  api: {
    getUrlList: () => ipcRenderer.invoke('api-get-url-list'),
  },

  // Crawler
  crawler: {
    startBatch: (apiKey: string, sessions: any[], insertUrl?: string) =>
      ipcRenderer.invoke('crawler-start-batch', apiKey, sessions, insertUrl),
    stop: () => ipcRenderer.invoke('crawler-stop'),
    getStatus: () => ipcRenderer.invoke('crawler-get-status'),
    getProgress: () => ipcRenderer.invoke('crawler-get-progress'),
  },
});

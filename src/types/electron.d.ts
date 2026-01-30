export interface ElectronAPI {
  getAppPath: () => Promise<string>;
  adspower: {
    listProfiles: (apiKey: string) => Promise<any>;
    createProfile: (apiKey: string, data: any) => Promise<any>;
    deleteProfiles: (apiKey: string, profileIds: string[]) => Promise<any>;
    startBrowser: (apiKey: string, profileId: string) => Promise<any>;
    stopBrowser: (apiKey: string, profileId: string) => Promise<any>;
    puppeteerTest: (apiKey: string, profileId: string) => Promise<any>;
  };
  db: {
    getProxies: () => Promise<any[]>;
    addProxy: (proxy: any) => Promise<any>;
    updateProxy: (id: number, updates: any) => Promise<any>;
    deleteProxy: (id: number) => Promise<any>;
    bulkAddProxies: (proxies: any[]) => Promise<any>;
  };
  settings: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<any>;
    getAll: () => Promise<any[]>;
  };
  proxyPool: {
    test: () => Promise<any>;
  };
  session: {
    assignProxyToProfile: (apiKey: string, profileId: string, profileName: string) => Promise<any>;
    assignProxyToAll: (apiKey: string) => Promise<any>;
    getAll: (apiKey: string) => Promise<any>;
    replaceProxy: (apiKey: string, profileId: string) => Promise<any>;
  };
  browser: {
    startAndVerify: (apiKey: string, profileId: string, profileName: string, maxRetries?: number) => Promise<any>;
  };
  api: {
    getUrlList: () => Promise<{ success: boolean; data?: any; error?: string }>;
  };
  crawler: {
    startBatch: (apiKey: string, sessions: any[], insertUrl?: string) => Promise<{ success: boolean; results?: any[]; error?: string }>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

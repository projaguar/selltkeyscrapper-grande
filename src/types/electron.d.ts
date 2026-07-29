export interface ElectronAPI {
  getAppPath: () => Promise<string>;
  adspower: {
    listProfiles: (apiKey: string) => Promise<unknown>;
  };
  db: {
    // Proxy Groups
    getProxyGroups: () => Promise<any[]>;
    getProxyGroupsWithCount: () => Promise<any[]>;
    addProxyGroup: (name: string, maxBrowsers: number) => Promise<any>;
    updateProxyGroup: (id: number, updates: any) => Promise<any>;
    deleteProxyGroup: (id: number) => Promise<any>;

    // Proxies
    getProxies: () => Promise<any[]>;
    getProxiesByGroup: (groupId: number) => Promise<any[]>;
    addProxy: (proxy: any) => Promise<any>;
    updateProxy: (id: number, updates: any) => Promise<any>;
    updateProxyGroupId: (proxyId: number, groupId: number) => Promise<any>;
    deleteProxy: (id: number) => Promise<any>;
    deleteAllProxies: () => Promise<any>;
    deleteProxiesByGroup: (groupId: number) => Promise<any>;
    bulkAddProxies: (proxies: any[], groupId?: number) => Promise<any>;
    importProxiesFromFile: (groupId?: number) => Promise<{ success: boolean; count?: number; message?: string }>;
  };
  settings: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<any>;
    getAll: () => Promise<any[]>;
  };
  proxyPool: {
    test: () => Promise<any>;
  };
  api: {
    getUrlList: () => Promise<{ success: boolean; data?: any; error?: string }>;
  };
  crawler: {
    // 브라우저 준비 (DDD 패턴)
    prepareBrowsers: (apiKey: string) => Promise<{
      success: boolean;
      results?: Array<{
        success: boolean;
        profileId: string;
        profileName: string;
        proxyGroupName?: string;
        proxyIp?: string;
        error?: string;
      }>;
      readyCount?: number;
      /** 실제로 시도한 목표치(메모리/프록시 풀 클램프 적용 후) */
      requestedCount?: number;
      /** env/DB 설정 원본값 */
      configuredCount?: number;
      warning?: string;
      error?: string;
    }>;

    // 준비 진행 상황 이벤트 리스너
    onPrepareProgress: (callback: (data: {
      current: number;
      total: number;
      result: {
        success: boolean;
        profileId: string;
        profileName: string;
        proxyGroupName?: string;
        proxyIp?: string;
        error?: string;
      };
    }) => void) => () => void;

    // 크롤링 시작 (준비된 브라우저 사용)
    startBatch: () => Promise<{ success: boolean; results?: any[]; error?: string }>;

    // 크롤러 중지
    stop: () => Promise<{ success: boolean; error?: string }>;

    // 브라우저 정리
    clearBrowsers: () => Promise<{ success: boolean; error?: string }>;

    // 크롤러 상태 조회
    getStatus: () => Promise<{ success: boolean; status?: any; error?: string }>;

    // 크롤러 진행 상태 조회 (상세)
    getProgress: () => Promise<{ success: boolean; progress?: unknown; readyBrowserCount?: number; error?: string }>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
  const __APP_VERSION__: string;
}

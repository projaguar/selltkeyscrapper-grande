import { create } from 'zustand';

interface Proxy {
  id: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
  status: 'active' | 'dead' | 'in_use';
  last_checked?: string;
  fail_count: number;
  success_count: number;
  created_at: string;
}

interface Profile {
  user_id: string;
  name: string;
  group_name?: string;
}

interface Session {
  id: string;
  profileId: string;
  profileName: string;
  currentUrl: string;
  status: string;
}

interface UrlItem {
  URLNUM: number;
  USERNUM: number;
  SPRICELIMIT: number;
  EPRICELIMIT: number;
  URLPLATFORMS: string;
  TARGETSTORENAME: string;
  TARGETURL: string;
  BESTYN: string;
  NEWYN: string;
}

interface Store {
  // 설정
  apiKey: string;
  setApiKey: (apiKey: string) => void;

  // 프록시 목록
  proxies: Proxy[];
  setProxies: (proxies: Proxy[]) => void;
  addProxy: (proxy: Proxy) => void;
  updateProxy: (id: number, updates: Partial<Proxy>) => void;
  deleteProxy: (id: number) => void;

  // AdsPower 프로필 목록
  profiles: Profile[];
  setProfiles: (profiles: Profile[]) => void;

  // 브라우저 세션 상태
  activeSessions: Session[];
  setActiveSessions: (sessions: Session[]) => void;

  // 크롤링 URL 목록
  urlList: UrlItem[];
  setUrlList: (urlList: UrlItem[]) => void;

  // 크롤링 데이터 전송 URL
  insertUrl: string;
  setInsertUrl: (insertUrl: string) => void;

  // 현재 탭
  currentTab: string;
  setCurrentTab: (tab: string) => void;

  // 로딩 상태
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

export const useStore = create<Store>((set) => ({
  // 설정
  apiKey: '',
  setApiKey: (apiKey) => set({ apiKey }),

  // 프록시 목록
  proxies: [],
  setProxies: (proxies) => set({ proxies }),
  addProxy: (proxy) => set((state) => ({ proxies: [...state.proxies, proxy] })),
  updateProxy: (id, updates) =>
    set((state) => ({
      proxies: state.proxies.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    })),
  deleteProxy: (id) =>
    set((state) => ({
      proxies: state.proxies.filter((p) => p.id !== id),
    })),

  // AdsPower 프로필 목록
  profiles: [],
  setProfiles: (profiles) => set({ profiles }),

  // 브라우저 세션 상태
  activeSessions: [],
  setActiveSessions: (sessions) => set({ activeSessions: sessions }),

  // 크롤링 URL 목록
  urlList: [],
  setUrlList: (urlList) => set({ urlList }),

  // 크롤링 데이터 전송 URL
  insertUrl: '',
  setInsertUrl: (insertUrl) => set({ insertUrl }),

  // 현재 탭
  currentTab: 'dashboard',
  setCurrentTab: (tab) => set({ currentTab: tab }),

  // 로딩 상태
  isLoading: false,
  setIsLoading: (loading) => set({ isLoading: loading }),
}));

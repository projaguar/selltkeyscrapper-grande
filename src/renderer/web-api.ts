/**
 * 웹 버전 electronAPI 어댑터.
 *
 * 구 Electron preload(contextBridge + ipcRenderer)를 대체:
 * - 요청/응답: POST /api/rpc (fetch)
 * - 크롤 준비 진행 이벤트: /ws (WebSocket 구독)
 *
 * 컴포넌트는 기존과 동일하게 window.electronAPI.* 를 호출한다(무변경).
 */

import type { ElectronAPI } from "../types/electron";

const RPC_URL = "/api/rpc";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const body: unknown = await res.json();
  if (body && typeof body === "object") {
    if ("ok" in body && body.ok === true) {
      return "result" in body ? body.result : undefined;
    }
    if ("error" in body && typeof body.error === "string") {
      throw new Error(body.error);
    }
  }
  throw new Error(`RPC ${channel} 실패`);
}

// ─── WebSocket: 크롤 준비 진행 이벤트 구독 ───
interface ProgressData {
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
}

const progressListeners = new Set<(data: ProgressData) => void>();
let ws: WebSocket | null = null;

function ensureWs(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (
      msg &&
      typeof msg === "object" &&
      "type" in msg &&
      msg.type === "crawler-prepare-progress" &&
      "data" in msg
    ) {
      // 서버가 보내는 진행 이벤트 (신뢰 경계 — 형태 고정)
      const data = msg.data as ProgressData;
      for (const cb of progressListeners) cb(data);
    }
  };
  ws.onclose = () => {
    ws = null;
  };
  ws.onerror = () => {
    /* 다음 구독 시 재연결 */
  };
}

const webApi = {
  getAppPath: () => invoke("get-app-path"),

  adspower: {
    listProfiles: (apiKey: string) => invoke("adspower-list-profiles", apiKey),
  },

  db: {
    getProxyGroups: () => invoke("db-get-proxy-groups"),
    getProxyGroupsWithCount: () => invoke("db-get-proxy-groups-with-count"),
    addProxyGroup: (name: string, maxBrowsers: number) => invoke("db-add-proxy-group", name, maxBrowsers),
    updateProxyGroup: (id: number, updates: unknown) => invoke("db-update-proxy-group", id, updates),
    deleteProxyGroup: (id: number) => invoke("db-delete-proxy-group", id),

    getProxies: () => invoke("db-get-proxies"),
    getProxiesByGroup: (groupId: number) => invoke("db-get-proxies-by-group", groupId),
    addProxy: (proxy: unknown) => invoke("db-add-proxy", proxy),
    updateProxy: (id: number, updates: unknown) => invoke("db-update-proxy", id, updates),
    updateProxyGroupId: (proxyId: number, groupId: number) =>
      invoke("db-update-proxy-group-id", proxyId, groupId),
    deleteProxy: (id: number) => invoke("db-delete-proxy", id),
    deleteAllProxies: () => invoke("db-delete-all-proxies"),
    deleteProxiesByGroup: (groupId: number) => invoke("db-delete-proxies-by-group", groupId),
    bulkAddProxies: (proxies: unknown[], groupId?: number) =>
      invoke("db-bulk-add-proxies", proxies, groupId),
    // 웹 버전은 네이티브 파일 다이얼로그가 없음 → 붙여넣기(bulkAddProxies) 사용
    importProxiesFromFile: () =>
      Promise.resolve({
        success: false,
        message: "웹 버전에서는 파일 선택 대신 붙여넣기를 사용하세요.",
      }),
  },

  settings: {
    get: (key: string) => invoke("settings-get", key),
    set: (key: string, value: string) => invoke("settings-set", key, value),
    getAll: () => invoke("settings-get-all"),
  },

  proxyPool: {
    test: () => invoke("proxypool-test"),
  },

  session: {
    assignProxyToProfile: (apiKey: string, profileId: string, profileName: string) =>
      invoke("session-assign-proxy-to-profile", apiKey, profileId, profileName),
    assignProxyToAll: (apiKey: string) => invoke("session-assign-proxy-to-all", apiKey),
    getAll: (apiKey: string) => invoke("session-get-all", apiKey),
    replaceProxy: (apiKey: string, profileId: string) =>
      invoke("session-replace-proxy", apiKey, profileId),
  },

  api: {
    getUrlList: () => invoke("api-get-url-list"),
  },

  crawler: {
    prepareBrowsers: (apiKey: string) => invoke("crawler-prepare-browsers", apiKey),
    onPrepareProgress: (callback: (data: ProgressData) => void) => {
      progressListeners.add(callback);
      ensureWs();
      return () => {
        progressListeners.delete(callback);
      };
    },
    startBatch: () => invoke("crawler-start-batch"),
    stop: () => invoke("crawler-stop"),
    clearBrowsers: () => invoke("crawler-clear-browsers"),
    getStatus: () => invoke("crawler-get-status"),
    getProgress: () => invoke("crawler-get-progress"),
  },
};

/** window.electronAPI 를 웹 어댑터로 설치 (앱 부팅 시 1회 호출). */
export function installWebApi(): void {
  // RPC/WS 와이어 경계 — 런타임 형태를 ElectronAPI 계약으로 단언.
  window.electronAPI = webApi as unknown as ElectronAPI;
}

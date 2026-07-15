/**
 * Bun.serve 서버 — 구 Electron main 프로세스를 대체.
 *
 * - 정적 UI(dist) 서빙 + SPA fallback
 * - POST /api/rpc: 구 ipcMain.handle 로직을 채널 디스패치로 재사용 (렌더러는 fetch)
 * - /ws: 크롤 준비 진행 이벤트 브로드캐스트 (구 webContents.send 대체)
 * - 워커(크롤러)는 이 프로세스에서 상주 → UI 탭을 닫아도 크롤링 지속
 */

import type { ServerWebSocket } from "bun";
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "./data-dir";
import * as db from "./database/sqlite";
import * as adspower from "./services/adspower";
import * as apiSvc from "./services/api";
import { getProxyPool } from "./lib/proxy-pool";
import { getSessionManager } from "./lib/session-manager";
import { startCrawling, stopCrawler, getCrawlerStatus, getCrawlerProgress } from "./lib/crawler";
import { getBrowserManager, type PreparationResult } from "./lib/crawler/browser-manager";
import { getProfilePool } from "./lib/crawler/profile-pool";

const PORT = Number(process.env.SCRAPPER_PORT ?? 4478); // prowler(4477)와 분리
const UI_DIR = `${import.meta.dir}/../dist`;
const HARDCODED_API_KEY = "268820ebcb76ffe2def2d28d04dfd4ae";
const DEFAULT_GROUP_NAME = "scrapper";
const DEFAULT_PROFILE_COUNT = 2;

// ─── 초기화 ───
mkdirSync(DATA_DIR, { recursive: true });
db.initDatabase(DATA_DIR);
// API 키: env 가 있으면 그것으로, 없고 DB 에도 없으면 하드코딩 시드 (UI 저장 키는 덮어쓰지 않음)
const envKey = process.env.ADSPOWER_API_KEY;
if (envKey) db.setSetting("adspowerApiKey", envKey);
else if (!db.getSetting("adspowerApiKey")) db.setSetting("adspowerApiKey", HARDCODED_API_KEY);
getProxyPool();
console.log(`[server] DB: ${DATA_DIR}/data.db`);
if (!(await Bun.file(`${UI_DIR}/index.html`).exists())) {
  console.warn("[server] ⚠️ dist 빌드가 없습니다 — 대시보드가 안 뜹니다. 'bun run build' 를 먼저 실행하세요.");
}

// ─── WebSocket 브로드캐스트 (UI 진행 이벤트) ───
const clients = new Set<ServerWebSocket<unknown>>();
function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      /* 닫히는 중 소켓 — 무시 */
    }
  }
}

// ─── RPC 경계 인자 강제 변환 ───
function s(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
function n(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asGroupUpdates(v: unknown): { name?: string; max_browsers?: number } {
  const out: { name?: string; max_browsers?: number } = {};
  if (v && typeof v === "object") {
    if ("name" in v && typeof v.name === "string") out.name = v.name;
    if ("max_browsers" in v && typeof v.max_browsers === "number") out.max_browsers = v.max_browsers;
  }
  return out;
}

function settingStr(key: string, fallback: string): string {
  const v: unknown = db.getSetting(key);
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function settingInt(key: string, fallback: number): number {
  const v: unknown = db.getSetting(key);
  const parsed = typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── crawler-prepare-browsers: 그룹 풀 확보 + 준비 (진행은 WS 브로드캐스트) ───
async function prepareBrowsers(apiKey: string) {
  try {
    const groupName = settingStr("scrapperGroupName", DEFAULT_GROUP_NAME);
    const count = settingInt("crawlProfileCount", DEFAULT_PROFILE_COUNT);
    const browserManager = getBrowserManager();
    browserManager.setApiKey(apiKey);

    const pool = getProfilePool(apiKey);
    const groupId = await pool.ensureGroupId(groupName);
    browserManager.setGroupId(groupId);
    db.setSetting("scrapperGroupId", groupId);

    const profiles = await pool.ensurePool(groupId, count);
    console.log(`[server] Pool ready: ${profiles.length}/${count} in group ${groupId}`);
    if (profiles.length === 0) {
      return { success: false, error: "AdsPower 프로필을 확보하지 못했습니다 (한도/연결 확인)" };
    }

    const onProgress = (index: number, total: number, result: PreparationResult) => {
      broadcast({ type: "crawler-prepare-progress", data: { current: index + 1, total, result } });
    };
    const results = await browserManager.prepareBrowsers(profiles, onProgress);
    const successCount = results.filter((r) => r.success).length;
    const warning =
      profiles.length < count
        ? `요청 ${count}개 중 ${profiles.length}개만 확보됨 (AdsPower 한도/rate-limit/연결 확인)`
        : undefined;
    if (warning) console.warn(`[server] ⚠️ ${warning}`);
    console.log(`[server] Preparation complete: ${successCount}/${profiles.length} ready`);
    return { success: true, results, readyCount: successCount, requestedCount: count, warning };
  } catch (e) {
    console.error("[server] prepareBrowsers failed:", errMsg(e));
    return { success: false, error: errMsg(e) };
  }
}

// ─── 채널 디스패치 테이블 (구 ipcMain.handle 로직) ───
const handlers: Record<string, (args: unknown[]) => unknown | Promise<unknown>> = {
  "get-app-path": () => DATA_DIR,

  // Proxy Groups
  "db-get-proxy-groups": () => db.getProxyGroups(),
  "db-get-proxy-groups-with-count": () => db.getProxyGroupWithCount(),
  "db-add-proxy-group": (a) => db.addProxyGroup(s(a[0]), n(a[1])),
  "db-update-proxy-group": (a) => db.updateProxyGroup(n(a[0]), asGroupUpdates(a[1])),
  "db-delete-proxy-group": (a) => db.deleteProxyGroup(n(a[0])),

  // Proxies
  "db-get-proxies": () => db.getProxies(),
  "db-get-proxies-by-group": (a) => db.getProxiesByGroup(n(a[0])),
  "db-add-proxy": (a) => db.addProxy(a[0]),
  "db-update-proxy": (a) => db.updateProxy(n(a[0]), a[1]),
  "db-update-proxy-group-id": (a) => db.updateProxyGroup_id(n(a[0]), n(a[1])),
  "db-delete-proxy": (a) => db.deleteProxy(n(a[0])),
  "db-delete-all-proxies": () => db.deleteAllProxies(),
  "db-delete-proxies-by-group": (a) => db.deleteProxiesByGroup(n(a[0])),
  "db-bulk-add-proxies": (a) => db.bulkAddProxies(arr(a[0]), a[1] == null ? 1 : n(a[1])),

  // Settings
  "settings-get": (a) => db.getSetting(s(a[0])),
  "settings-set": (a) => db.setSetting(s(a[0]), s(a[1])),
  "settings-get-all": () => db.getAllSettings(),

  // ProxyPool 테스트
  "proxypool-test": () => {
    try {
      const proxyPool = getProxyPool();
      const availableCount = proxyPool.getAvailableCount();
      const testResults: Array<{ round: number; proxyId: number; ip: string; port: string }> = [];
      for (let i = 0; i < 5; i++) {
        const proxy = proxyPool.getNextProxy();
        if (proxy) testResults.push({ round: i + 1, proxyId: proxy.id, ip: proxy.ip, port: proxy.port });
      }
      return { success: true, availableCount, testResults };
    } catch (e) {
      return { success: false, message: errMsg(e) };
    }
  },

  // SessionManager
  "session-assign-proxy-to-profile": async (a) => {
    try {
      const sm = getSessionManager(s(a[0]));
      const session = await sm.assignProxyToProfile(s(a[1]), s(a[2]));
      return { success: true, session };
    } catch (e) {
      return { success: false, message: errMsg(e) };
    }
  },
  "session-assign-proxy-to-all": async (a) => {
    try {
      const sm = getSessionManager(s(a[0]));
      const results = await sm.assignProxyToAllProfiles();
      return { success: true, results };
    } catch (e) {
      return { success: false, message: errMsg(e) };
    }
  },
  "session-get-all": async (a) => {
    try {
      const sm = getSessionManager(s(a[0]));
      const sessions = sm.getAllSessions().filter((session) => session.status === "running");
      return { success: true, sessions };
    } catch (e) {
      return { success: false, message: errMsg(e) };
    }
  },
  "session-replace-proxy": async (a) => {
    try {
      const sm = getSessionManager(s(a[0]));
      const session = await sm.replaceProxyForSession(s(a[1]));
      return { success: true, session };
    } catch (e) {
      return { success: false, message: errMsg(e) };
    }
  },

  // 서버 API
  "api-get-url-list": async () => {
    try {
      const response = await apiSvc.getUrlList();
      return { success: true, data: response };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },

  // AdsPower
  "adspower-list-profiles": (a) => adspower.listProfiles(s(a[0])),

  // Crawler
  "crawler-prepare-browsers": (a) => prepareBrowsers(s(a[0])),
  "crawler-start-batch": async () => {
    try {
      const results = await startCrawling();
      return { success: true, results };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },
  "crawler-stop": () => {
    try {
      stopCrawler();
      return { success: true };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },
  "crawler-clear-browsers": async () => {
    try {
      await getBrowserManager().clear();
      return { success: true };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },
  "crawler-get-status": () => {
    try {
      return { success: true, status: getCrawlerStatus() };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },
  "crawler-get-progress": () => {
    try {
      return {
        success: true,
        progress: getCrawlerProgress(),
        readyBrowserCount: getBrowserManager().getReadyCount(),
      };
    } catch (e) {
      return { success: false, error: errMsg(e) };
    }
  },
};

async function handleRpc(req: Request): Promise<Response> {
  let channel = "";
  let args: unknown[] = [];
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object" && "channel" in body) {
      channel = s(body.channel);
      if ("args" in body && Array.isArray(body.args)) args = body.args;
    }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const handler = handlers[channel];
  if (!handler) {
    return Response.json({ ok: false, error: `unknown channel: ${channel}` }, { status: 404 });
  }
  try {
    const result = await handler(args);
    return Response.json({ ok: true, result });
  } catch (e) {
    console.error(`[rpc] ${channel} failed:`, errMsg(e));
    return Response.json({ ok: false, error: errMsg(e) });
  }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // 장시간 크롤 RPC(startBatch) 유지 — 기본 0이지만 방어적으로 고정
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      return srv.upgrade(req) ? undefined : new Response("websocket upgrade 실패", { status: 400 });
    }
    if (url.pathname === "/api/rpc" && req.method === "POST") {
      return handleRpc(req);
    }

    // 정적 파일 + SPA fallback
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    if (rel.includes("..")) return new Response("not found", { status: 404 });
    const file = Bun.file(`${UI_DIR}/${rel}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(`${UI_DIR}/index.html`));
  },
  websocket: {
    open(ws) {
      clients.add(ws);
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {
      /* UI는 진행 이벤트 수신 전용 */
    },
  },
});

console.log(`[server] http://localhost:${server.port}  (대시보드)`);

// ─── graceful shutdown ───
async function shutdown(): Promise<void> {
  console.log("\n[server] shutting down — 크롤러 정지 + 브라우저 정리...");
  try {
    stopCrawler();
  } catch {
    /* ignore */
  }
  try {
    await getBrowserManager().clear();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── 부팅 시 자동 크롤 시작 (SCRAPPER_AUTOSTART=1 일 때만) ───
// UI 의 "브라우저 준비" → "크롤링 시작" 두 단계를 서버 기동 시 코드가 대신 수행.
// AdsPower 가 늦게 뜨는 경우를 대비해 Local API 가 응답할 때까지 대기 후 진행.
async function waitForAdsPower(apiKey: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await adspower.listGroups(apiKey); // code!==0 이면 throw
      return true;
    } catch {
      await Bun.sleep(3000); // API 아직 안 뜸 — 재시도
    }
  }
  return false;
}

async function autoStart(): Promise<void> {
  if (process.env.SCRAPPER_AUTOSTART !== "1") return;
  const apiKey = settingStr("adspowerApiKey", HARDCODED_API_KEY);
  console.log("[autostart] SCRAPPER_AUTOSTART=1 — AdsPower Local API 대기 중...");
  if (!(await waitForAdsPower(apiKey))) {
    console.error("[autostart] ❌ AdsPower Local API 미응답(120s) — 자동 시작 취소. 대시보드에서 수동 시작 가능.");
    return;
  }
  console.log("[autostart] AdsPower 준비됨 — 브라우저 준비 중...");
  const prep = await prepareBrowsers(apiKey);
  if (!prep.success) {
    console.error(`[autostart] ❌ 브라우저 준비 실패 — 자동 시작 취소: ${prep.error ?? ""}`);
    return;
  }
  console.log(`[autostart] 브라우저 준비 완료 (ready=${prep.readyCount ?? "?"}) — 크롤링 시작`);
  try {
    await startCrawling();
    console.log("[autostart] ✅ 크롤링 자동 시작/완료");
  } catch (e) {
    console.error(`[autostart] ❌ 크롤링 시작 실패: ${errMsg(e)}`);
  }
}

void autoStart();

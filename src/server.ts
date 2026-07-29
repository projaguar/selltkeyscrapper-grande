/**
 * Bun.serve 서버 — 구 Electron main 프로세스를 대체.
 *
 * - 정적 UI(dist) 서빙 + SPA fallback
 * - POST /api/rpc: 구 ipcMain.handle 로직을 채널 디스패치로 재사용 (렌더러는 fetch)
 * - /ws: 크롤 준비 진행 이벤트 브로드캐스트 (구 webContents.send 대체)
 * - 워커(크롤러)는 이 프로세스에서 상주 → UI 탭을 닫아도 크롤링 지속
 */

import type { ServerWebSocket } from "bun";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./data-dir";
import * as db from "./database/sqlite";
import * as adspower from "./services/adspower";
import * as apiSvc from "./services/api";
import { getProxyPool, type Proxy } from "./lib/proxy-pool";
import {
  startCrawling,
  stopCrawler,
  getCrawlerStatus,
  getCrawlerProgress,
  getCrawlerHealth,
} from "./lib/crawler";
import { getBrowserManager, type PreparationResult } from "./lib/crawler/browser-manager";
import { getProfilePool } from "./lib/crawler/profile-pool";

const PORT = Number(process.env.SCRAPPER_PORT ?? 4478); // prowler(4477)와 분리
const UI_DIR = `${import.meta.dir}/../dist`;
const HARDCODED_API_KEY = "268820ebcb76ffe2def2d28d04dfd4ae";
const DEFAULT_GROUP_NAME = "scrapper";
const DEFAULT_PROFILE_COUNT = 2;
const PID_FILE = join(DATA_DIR, "scrapper.pid");
/** OS + 이 프로세스에 남겨둘 여유. 이 밑으로 내려가면 스왑이 시작되고 loadavg 가 붕괴한다. */
const MEM_RESERVE_BYTES = 4 * 1024 ** 3;
/** 브라우저 1개의 실측 한계 비용. 16GB 맥에 20개를 띄웠을 때 여유 59MB / loadavg 89 였다. */
const PER_BROWSER_BYTES = 900 * 1024 ** 2;
// 거부 사유는 `message` 와 `error` 양쪽에 싣는다 — 대시보드는 실패를 `error` 로 읽어서,
// `message` 만 주면 조작자에게 "알 수 없는 오류"로 표시된다(거부가 조용한 실패로 보이면 안 된다).
const BUSY_REJECTION = "크롤링 중에는 실행할 수 없습니다. 먼저 중지하세요.";
const BUSY_WHILE_CRAWLING = { success: false, message: BUSY_REJECTION, error: BUSY_REJECTION } as const;
const PREPARING_REJECTION = "브라우저 준비 중에는 실행할 수 없습니다. 잠시 후 다시 시도하세요.";

// ─── 단일 인스턴스 락 (§2.5) ───
// 두 인스턴스가 같은 DB 를 공유하면 각자의 부팅 회수가 상대의 살아있는 lease 를 active 로
// 되돌린다. 그 결과가 관측된 사고 경로 "15 IP 를 30 브라우저가 공유" 다. 그래서 락 실패는
// 경고가 아니라 기동 거부여야 한다.

function readLockPid(): number | null {
  try {
    const parsed = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null; // 파일 없음/손상 → 락 없음으로 취급
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 시그널 0 = 존재 확인만
    return true;
  } catch (e) {
    // ESRCH 만 확실한 사망이다. EPERM(타 사용자 소유)이나 알 수 없는 오류는 살아있는 것으로
    // 본다 — 오판 비용이 비대칭적이다(기동 거부는 되돌릴 수 있고, lease 파괴는 아니다).
    const code = e instanceof Error && "code" in e ? String(e.code) : "";
    return code !== "ESRCH";
  }
}

function acquireInstanceLock(): void {
  const existing = readLockPid();
  if (existing !== null && existing !== process.pid) {
    if (isPidAlive(existing)) {
      console.error(
        `[server] ❌ 이미 인스턴스가 가동 중입니다 (pid=${existing}, ${PID_FILE}) — 기동을 거부합니다. ` +
          `해당 프로세스를 먼저 종료하세요.`,
      );
      process.exit(1);
    }
    console.warn(`[server] 죽은 인스턴스 락 인수 (pid=${existing})`);
  }
  writeFileSync(PID_FILE, String(process.pid));
}

function releaseInstanceLock(): void {
  try {
    if (readLockPid() === process.pid) unlinkSync(PID_FILE);
  } catch {
    /* 이미 지워짐 */
  }
}

// ─── 초기화 ───
mkdirSync(DATA_DIR, { recursive: true });
acquireInstanceLock();
db.initDatabase(DATA_DIR);
// API 키: env 가 있으면 그것으로, 없고 DB 에도 없으면 하드코딩 시드 (UI 저장 키는 덮어쓰지 않음)
const envKey = process.env.ADSPOWER_API_KEY;
if (envKey) db.setSetting("adspowerApiKey", envKey);
else if (!db.getSetting("adspowerApiKey")) db.setSetting("adspowerApiKey", HARDCODED_API_KEY);
// 락을 잡은 프로세스만 이전 세션 잔재를 회수한다. 락 없이 무조건 회수하던 구 initializeProxies
// 가 동시 가동 인스턴스의 lease 를 파괴했다.
getProxyPool().reclaimAllAtBoot();
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
/**
 * RPC 경계에서 들어온 프록시 입력을 강제 변환한다.
 * ip/port 가 없으면 INSERT 가 NOT NULL 로 터지므로 여기서 걸러 명확한 에러를 낸다.
 */
function asProxyInput(v: unknown): {
  group_id?: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
} {
  if (!v || typeof v !== "object") throw new Error("프록시 입력이 객체가 아닙니다");
  const ip = "ip" in v && typeof v.ip === "string" ? v.ip.trim() : "";
  const port = "port" in v ? String(v.port ?? "").trim() : "";
  if (ip.length === 0 || port.length === 0) throw new Error("프록시 ip/port 가 필요합니다");
  return {
    group_id: "group_id" in v && typeof v.group_id === "number" ? v.group_id : undefined,
    ip,
    port,
    username: "username" in v && typeof v.username === "string" ? v.username : undefined,
    password: "password" in v && typeof v.password === "string" ? v.password : undefined,
  };
}


function settingStr(key: string, fallback: string): string {
  const v: unknown = db.getSetting(key);
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * 동시 프로필 수 해석: env → DB → 기본값 (§6).
 * 파싱 실패를 조용히 기본값으로 흘리면, 15개를 기대한 운영자가 2개만 도는 것을 며칠 뒤에
 * 발견한다. 그래서 기본값 채택은 반드시 에러로 남긴다.
 */
function resolveProfileCount(): number {
  const raw = process.env.CRAWL_PROFILE_COUNT;
  if (raw !== undefined && raw.length > 0) {
    const fromEnv = Number.parseInt(raw, 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
    console.error(`[server] ❌ CRAWL_PROFILE_COUNT="${raw}" 해석 불가 — 기본값 ${DEFAULT_PROFILE_COUNT} 사용`);
    return DEFAULT_PROFILE_COUNT;
  }
  const stored: unknown = db.getSetting("crawlProfileCount");
  if (stored === null || stored === undefined) return DEFAULT_PROFILE_COUNT;
  const fromDb = typeof stored === "string" ? Number.parseInt(stored, 10) : NaN;
  if (Number.isInteger(fromDb) && fromDb > 0) return fromDb;
  console.error(
    `[server] ❌ 설정 crawlProfileCount=${JSON.stringify(stored)} 가 유효한 양수가 아닙니다 — ` +
      `기본값 ${DEFAULT_PROFILE_COUNT} 사용`,
  );
  return DEFAULT_PROFILE_COUNT;
}

/**
 * 수용 제어 (§5). `crawlProfileCount` 가 유일한 상한이고 검증이 없어서 20 으로 두면 16GB 맥이
 * 멈췄다(여유 59MB, loadavg 89). 메모리와 프록시 풀 두 축으로 클램프한다.
 */
function clampBrowserCount(requested: number): number {
  const mem = totalmem();
  const memCap = Math.floor((mem - MEM_RESERVE_BYTES) / PER_BROWSER_BYTES);
  const poolSize = getProxyPool().poolSize();
  // 회전(acquire-then-release)은 순간적으로 프록시 2개를 요구한다. 풀을 꽉 채우면 고갈 시
  // 전원이 획득 실패 → 전원 park → fleet 붕괴(모델 검증 §11.3-3). 한 칸을 비워 둔다.
  const poolCap = Math.max(1, poolSize - 1);
  const effective = Math.max(1, Math.min(requested, memCap, poolCap));
  if (effective < requested) {
    console.warn(
      `[server] ⚠️ 동시 브라우저 수 클램프: 요청 ${requested} → 실효 ${effective} ` +
        `(메모리 상한 ${memCap} = (총 ${Math.round(mem / 1024 ** 3)}GiB − 예약 4GiB) ÷ 900MiB, ` +
        `풀 상한 ${poolCap} = 프록시 ${poolSize}개 − 회전 여유 1)`,
    );
  }
  return effective;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── crawler-prepare-browsers: 그룹 풀 확보 + 준비 (진행은 WS 브로드캐스트) ───
interface PrepareOutcome {
  success: boolean;
  results?: PreparationResult[];
  readyCount?: number;
  /** 실제로 시도한 목표치(클램프 적용 후). UI 의 결손 판정 기준. */
  requestedCount?: number;
  /** env/DB 원본값. 클램프가 걸렸는지 보려면 requestedCount 와 비교한다. */
  configuredCount?: number;
  warning?: string;
  error?: string;
}

async function runPrepare(apiKey: string): Promise<PrepareOutcome> {
  try {
    const groupName = settingStr("scrapperGroupName", DEFAULT_GROUP_NAME);
    // AdsPower 왕복 전에 실효 동시성을 확정한다 — 그룹 확보가 실패해도 클램프 근거는 로그에 남는다.
    const requested = resolveProfileCount();
    const count = clampBrowserCount(requested);
    const browserManager = getBrowserManager();
    browserManager.setApiKey(apiKey);

    const pool = getProfilePool(apiKey);
    // AdsPower 프로필 그룹 id 는 문자열이며, `scrapperGroupId` 저장은 ensureGroupId 가 단독으로
    // 담당한다(그 값을 읽어 그룹 rename 을 견디는 앵커로 쓰므로 writer 가 둘이면 안 된다).
    const groupId = await pool.ensureGroupId(groupName);
    browserManager.setGroupId(groupId);

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
    // 클램프는 의도된 축소이고 결손은 사고다 — UI 가 둘을 같은 실패로 표시하지 않게 분리한다.
    const clampNote =
      count < requested
        ? `동시 브라우저 상한이 설정 ${requested} → ${count} 로 조정됨 (메모리/프록시 풀 여유)`
        : undefined;
    const shortfall =
      profiles.length < count
        ? `목표 ${count}개 중 ${profiles.length}개만 확보됨 (AdsPower 한도/rate-limit/연결 확인)`
        : undefined;
    if (shortfall) {
      // 목표의 80% 미만은 일시 결손이 아니라 고착된 fleet 축소의 신호다. 경고 레벨로 묻으면
      // 무인 운영에서 며칠간 방치된다.
      if (profiles.length < count * 0.8) console.error(`[server] ❌ ${shortfall}`);
      else console.warn(`[server] ⚠️ ${shortfall}`);
    }
    console.log(`[server] Preparation complete: ${successCount}/${profiles.length} ready`);
    const notes = [clampNote, shortfall].filter((m): m is string => m !== undefined);
    return {
      success: true,
      results,
      readyCount: successCount,
      requestedCount: count,
      configuredCount: requested,
      warning: notes.length > 0 ? notes.join(" / ") : undefined,
    };
  } catch (e) {
    console.error("[server] prepareBrowsers failed:", errMsg(e));
    return { success: false, error: errMsg(e) };
  }
}

// 동시 prepare 재진입 차단. `ensurePool` 은 내부 직렬화가 없어서 두 번 겹치면 그룹 프로필을
// 요청량의 2배로 만들고, 초과분은 어떤 holder 도 소유하지 않는 고아가 되어 quota 를 침식한다.
let preparing: Promise<PrepareOutcome> | null = null;

function prepareBrowsers(apiKey: string): Promise<PrepareOutcome> {
  if (preparing) {
    console.warn("[server] prepare 가 이미 진행 중 — 기존 작업에 합류합니다");
    return preparing;
  }
  const inFlight = runPrepare(apiKey).finally(() => {
    preparing = null;
  });
  preparing = inFlight;
  return inFlight;
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
  "db-add-proxy": (a) => db.addProxy(asProxyInput(a[0])),
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

  // ProxyPool 진단 — 조회 전용. 구 구현은 getNextProxy() 를 5회 호출하고 반납하지 않아
  // 버튼 클릭 1회마다 프록시 5개가 영구 in_use 로 묶였다(풀 고갈의 직접 원인 중 하나).
  "proxypool-test": () => {
    try {
      const pool = getProxyPool();
      // bun:sqlite `.all()` 은 타입 정보가 없다 — 스키마가 계약이므로 행 타입으로 단언.
      const rows = db.getProxies() as Proxy[];
      return {
        success: true,
        availableCount: pool.availableCount(),
        poolSize: pool.poolSize(),
        sample: rows.slice(0, 5).map((p) => ({
          proxyId: p.id,
          groupId: p.group_id,
          ip: p.ip,
          port: p.port,
          status: p.status,
          owner: p.owner ?? null,
        })),
      };
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
  // 크롤 중 prepare 는 BrowserManager.prepareBrowsers 내부의 clear() 를 타고 살아있는
  // 브라우저 전원의 lease 를 반납해 다음 획득자에게 이중 배정을 만든다(I1).
  "crawler-prepare-browsers": (a) =>
    getCrawlerStatus().isRunning ? BUSY_WHILE_CRAWLING : prepareBrowsers(s(a[0])),
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
    if (getCrawlerStatus().isRunning) return BUSY_WHILE_CRAWLING;
    // 준비 중 clear 는 방금 등록된 브라우저를 등록이 끝나기도 전에 회수한다.
    if (preparing) {
      return { success: false, message: PREPARING_REJECTION, error: PREPARING_REJECTION };
    }
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
  /**
   * 불변식 관측 (REDESIGN §10-5). 무인 운영에서 조용한 열화를 잡는 단일 창구다:
   * parked/zombie 증가, 브레이커 개방, lease 잔고 하락, 리컨실 회수 누적이 모두 여기 보인다.
   */
  "crawler-get-health": () => {
    try {
      return { success: true, health: getCrawlerHealth() };
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
  releaseInstanceLock();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── 부팅 시 자동 크롤 시작 (SCRAPPER_AUTOSTART=1 일 때만) ───
// UI 의 "브라우저 준비" → "크롤링 시작" 두 단계를 서버 기동 시 코드가 대신 수행.
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 3_000;
const ADSPOWER_WAIT_MS = 120_000;
const AUTOSTART_RETRY_MS = 300_000;

/**
 * 구 구현은 예산을 루프 top 에서만 검사하고 본문에서 `listGroups`(브로커 재시도 × 90s 타임아웃)를
 * 호출해 "120s 대기"가 실제로 5분 가까이 늘어났다. `ping` 은 단일 시도 + AbortSignal.timeout 이라
 * 호출 자체가 유한하고, 타임아웃을 잔여 예산으로 조여 총 대기가 예산을 넘지 않게 한다.
 */
async function waitForAdsPower(apiKey: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (await adspower.ping(apiKey, Math.min(PROBE_TIMEOUT_MS, remaining))) return true;
    if (Date.now() + PROBE_INTERVAL_MS >= deadline) return false;
    await Bun.sleep(PROBE_INTERVAL_MS);
  }
}

async function attemptAutoStart(apiKey: string): Promise<boolean> {
  if (getCrawlerStatus().isRunning) {
    console.log("[autostart] 이미 크롤링 중 — 자동 시작 생략");
    return true;
  }
  console.log(`[autostart] AdsPower Local API 대기 중 (최대 ${ADSPOWER_WAIT_MS / 1000}s)...`);
  if (!(await waitForAdsPower(apiKey, ADSPOWER_WAIT_MS))) {
    console.error(`[autostart] ❌ AdsPower Local API 미응답 (${ADSPOWER_WAIT_MS / 1000}s)`);
    return false;
  }
  console.log("[autostart] AdsPower 준비됨 — 브라우저 준비 중...");
  const prep = await prepareBrowsers(apiKey);
  if (!prep.success) {
    console.error(`[autostart] ❌ 브라우저 준비 실패: ${prep.error ?? "원인 불명"}`);
    return false;
  }
  console.log(`[autostart] 브라우저 준비 완료 (ready=${prep.readyCount ?? "?"}) — 크롤링 시작`);
  try {
    await startCrawling();
    console.log("[autostart] ✅ 크롤링 자동 시작/완료");
    return true;
  } catch (e) {
    console.error(`[autostart] ❌ 크롤링 시작 실패: ${errMsg(e)}`);
    return false;
  }
}

/**
 * 영구 포기 금지. 구 구현은 1회 실패 후 return 이라, AdsPower 가 늦게 뜨는 재부팅에서
 * "크롤러 없이 대시보드만 뜬 서버"로 굳었다 — 무인 운영에서는 진행성(I4) 위반이다.
 */
async function autoStart(): Promise<void> {
  if (process.env.SCRAPPER_AUTOSTART !== "1") return;
  const apiKey = settingStr("adspowerApiKey", HARDCODED_API_KEY);
  console.log("[autostart] SCRAPPER_AUTOSTART=1");
  for (let round = 1; ; round++) {
    if (await attemptAutoStart(apiKey)) return;
    console.warn(`[autostart] 라운드 ${round} 실패 — ${AUTOSTART_RETRY_MS / 1000}s 후 재시도 (상한 없음)`);
    await Bun.sleep(AUTOSTART_RETRY_MS);
  }
}

void autoStart();

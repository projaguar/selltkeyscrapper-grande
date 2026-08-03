/**
 * Crawler 메인 플로우 (Producer-Consumer Pattern with DDD)
 *
 * 새로운 아키텍처:
 * - BrowserManager: 브라우저 인스턴스 관리 (싱글톤)
 * - CrawlerBrowser: 도메인 객체 (브라우저/프로필 통합 관리)
 * - Producer: Task Fetcher가 백그라운드에서 Task Queue에 추가
 * - Consumer: 각 브라우저 Worker가 독립적으로 Queue에서 Task 가져와 처리
 */

import * as os from "node:os";
import { DATA_DIR } from "../data-dir";

// 타입
import type { CrawlTask, CrawlResult } from "./crawler/types";
export type { CrawlTask, CrawlResult, Session } from "./crawler/types";

// DDD: CrawlerBrowser 도메인 객체
import { CrawlerBrowser } from "./crawler/CrawlerBrowser";

// BrowserManager 싱글톤
import { getBrowserManager } from "./crawler/browser-manager";

// Task Queue Manager
import { TaskQueueManager } from "./crawler/task-queue";

// AdsPower 큐 (자기 프로필 개별 종료용 — 정적 import)
import { adsPowerQueue } from "./crawler/adspower-queue";

// 상태 관리 (UI용)
import {
  shouldStop,
  requestStop,
  isRunning,
  setRunning,
  resetProgress,
  setTotalTasks,
  incrementCompleted,
  incrementSkipped,
  registerBrowserStatusesGetter,
  unregisterBrowserStatusesGetter,
  setWaitState,
  clearWaitState,
} from "./crawler/state";

// 모듈
import {
  fetchTasks,
  removeCompletedTasks,
  handleTodayStopResults,
} from "./crawler/task-manager";
import { crawlNaver } from "./crawler/platforms/naver";
import { crawlAuction } from "./crawler/platforms/auction";
import { getProxyPool, type ProxyLease } from "./proxy-pool";
import { getLifecycleLock } from "./lifecycle-lock";
import { ProfileGoneError, QuotaError, StopUnconfirmedError } from "./errors";
import { verboseLogging } from "./log-budget";
import {
  initRestartLogger,
  logRestart,
  logBlocked,
  logSkipError,
  incrementStat,
  resetRestartStats,
} from "./crawler/restart-logger";

// 실제 오류로 분류할 키워드
const ERROR_KEYWORDS = [
  "ECONNREFUSED",
  "timeout",
  "Timeout",
  "ETIMEDOUT",
  "Navigation",
  "Protocol error",
  "Target closed",
  "Session closed",
  "net::ERR_",
  "Browser error",
];

/**
 * 크롤링 결과를 분류하여 상태와 메시지 결정
 */
function classifyResult(
  result: CrawlResult,
  collectedCount: number,
): { status: "success" | "warning" | "error"; message: string } {
  // 성공이고 상품이 있으면 success
  if (result.success && collectedCount > 0) {
    return {
      status: "success",
      message: result.message || `${collectedCount}개 수집`,
    };
  }

  // 성공이지만 상품이 0개면 warning
  if (result.success && collectedCount === 0) {
    return {
      status: "warning",
      message: "수집상품 없음",
    };
  }

  // 실패인 경우: 에러 메시지로 분류
  const errorMsg = result.error || "";

  // 실제 기술적 오류인지 확인
  const isRealError = ERROR_KEYWORDS.some((keyword) =>
    errorMsg.includes(keyword),
  );

  if (isRealError) {
    return {
      status: "error",
      message: errorMsg,
    };
  }

  // 비즈니스 로직 실패 (해외배송 아님, 상품 없음 등) → warning
  let friendlyMessage = errorMsg;
  if (errorMsg.includes("해외") || errorMsg.includes("overseas")) {
    friendlyMessage = "해외배송 아님";
  } else if (
    errorMsg.includes("상품") &&
    (errorMsg.includes("없") || errorMsg.includes("0"))
  ) {
    friendlyMessage = "수집상품 없음";
  } else if (errorMsg.includes("empty") || errorMsg.includes("Empty")) {
    friendlyMessage = "수집상품 없음";
  } else if (!errorMsg) {
    friendlyMessage = "수집상품 없음";
  }

  return {
    status: "warning",
    message: friendlyMessage,
  };
}

/**
 * Mutable wrapper: 프로필 재생성 시 새 CrawlerBrowser 로 교체된다.
 * 복구 상태(실패 횟수·보류·백오프)를 브라우저 객체가 아니라 holder 에 두는 이유:
 * 재생성으로 객체가 바뀌어도 그 슬롯의 이력이 유지되어야 무한 재시도를 캡할 수 있다.
 */
interface BrowserHolder {
  browser: CrawlerBrowser;
  /** 연속 복구 실패 횟수 */
  failures: number;
  /**
   * 보류 상태. `none` 이 아니면 워커가 이 슬롯을 건드리지 않는다.
   * `zombie` = 정지를 확인하지 못해 lease 를 반납할 수 없는 상태(트래픽 잔존 가능).
   * `parked` = 유한 재시도를 소진한 상태.
   * **둘 다 종점이 아니다** — 재활 타이머가 되살린다. 모델 검증에서 `parked` 를 종점으로 두면
   * 브로커 일시 장애가 영구적 fleet 축소로 굳어 I4(진행성)가 깨졌다.
   */
  suspended: "none" | "parked" | "zombie";
  /** 지수 백오프 — 이 시각 이전에는 복구를 시도하지 않는다 */
  nextAttemptAt: number;
  /** 재생성 에스컬레이션을 이미 소비했는지 */
  escalated: boolean;
}

/** 복구 백오프·캡. 무한 스핀(3초 간격 15시간, 로그 350MB)을 막는 경계값이다. */
const RECOVER_BACKOFF_BASE_MS = 3_000;
const RECOVER_BACKOFF_MAX_MS = 5 * 60_000;
const FAILURE_CAP = 5;
/** 보류 해제(재활) 주기 — parked/zombie 를 다시 시도한다 */
const REHAB_INTERVAL_MS = 10 * 60_000;
/** 정지 요청 후 루프 드레인 상한. 초과하면 남은 루프를 버리되, 세대 토큰이 부활을 막는다 */
const DRAIN_DEADLINE_MS = 20_000;

/**
 * 실행 세대. `startCrawling` 마다 증가하며 모든 루프가 자기 세대를 확인한다.
 * 이전 구현은 `setRunning(true)` 가 stop 플래그를 꺼서, 드레인되지 않은 구 세대 워커가
 * 되살아나 같은 브라우저를 두 세트가 구동했다.
 */
let currentRunId = 0;
/** 리컨실 주기. IP 교체 경로에 의존하지 않는 독립 타이머여야 고갈 상태에서도 self-heal 이 돈다 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * 불변식 관측 표면 (REDESIGN §10-5).
 *
 * 365일 무인 운영에서는 "지금 건강한가"를 로그 tail 없이 한 번에 볼 수 있어야 한다.
 * 특히 보류(parked/zombie) 수와 브레이커 상태, lease 잔고는 조용한 열화를 드러내는 신호다.
 * 누적 카운터는 프로세스 수명 동안 유지되어 추세를 보여준다.
 */
export interface CrawlerHealth {
  runId: number;
  isRunning: boolean;
  /**
   * `operational` = 브라우저 인스턴스가 살아있고 보류/에러가 아닌 슬롯.
   * 예전엔 `status === "ready"` 만 셌는데, 정상 가동 중인 fleet 은 대부분 `crawling`/`waiting`
   * 이어서 건강한 상태가 `0/13` 으로 보였다 — 무인 운영에서 상시 오경보를 내는 지표였다.
   */
  browsers: {
    total: number;
    operational: number;
    parked: number;
    zombie: number;
    error: number;
    byStatus: Record<string, number>;
  };
  breaker: "closed" | "open" | "half-open";
  lockPending: number;
  proxies: { total: number; available: number; leased: number };
  /**
   * 시스템 압박 — 참이면 태스크 인테이크가 일시정지된다.
   * 판정은 `load1 > loadThreshold` 로만 한다. `freeMb` 는 참고값이며 판정에 쓰지 않는다:
   * macOS 는 inactive/purgeable 를 캐시로 보유해 건강한 상태에서도 수백 MB 로 읽힌다.
   */
  system: {
    freeMb: number;
    load1: number;
    cores: number;
    loadThreshold: number;
    underPressure: boolean;
  };
  cumulative: {
    reclaimedLeases: number;
    reclaimedProfiles: number;
    parks: number;
    zombies: number;
    pressurePauses: number;
    /** 페인트 경로 정지 감지 / 리로드로 복구된 횟수. stuck 이 늘면 무증상 블랙아웃이 발생 중이다. */
    paintStuck: number;
    paintRecovered: number;
  };
}

let cumulativeReclaimedLeases = 0;
let cumulativeReclaimedProfiles = 0;
let cumulativeParks = 0;
let cumulativeZombies = 0;
let cumulativePressurePauses = 0;
/** 실행 중에만 등록된다. 미등록이면 브라우저 집계 없이 풀/브레이커만 보고한다. */
let holdersSnapshot: (() => readonly BrowserHolder[]) | null = null;

export function getCrawlerHealth(): CrawlerHealth {
  const pool = getProxyPool();
  const holders = holdersSnapshot?.() ?? [];
  let operational = 0;
  let parked = 0;
  let zombie = 0;
  let errored = 0;
  const byStatus: Record<string, number> = {};
  for (const holder of holders) {
    const status = holder.browser.getStatus().status;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (holder.suspended === "parked") parked++;
    else if (holder.suspended === "zombie") zombie++;
    else if (holder.browser.hasError()) errored++;
    else if (holder.browser.hasBrowser()) operational++;
  }
  return {
    runId: currentRunId,
    isRunning: isRunning(),
    browsers: { total: holders.length, operational, parked, zombie, error: errored, byStatus },
    breaker: adsPowerQueue.breakerState(),
    lockPending: getLifecycleLock().pendingKeys(),
    proxies: {
      total: pool.poolSize(),
      available: pool.availableCount(),
      leased: pool.leasedCount(),
    },
    system: {
      freeMb: Math.round(os.freemem() / 1024 / 1024),
      load1: Number((os.loadavg()[0] ?? 0).toFixed(1)),
      cores: os.cpus().length,
      loadThreshold: Number((os.cpus().length * PRESSURE_LOAD_PER_CORE).toFixed(1)),
      underPressure: underPressure,
    },
    cumulative: {
      reclaimedLeases: cumulativeReclaimedLeases,
      reclaimedProfiles: cumulativeReclaimedProfiles,
      parks: cumulativeParks,
      zombies: cumulativeZombies,
      pressurePauses: cumulativePressurePauses,
      paintStuck: holders.reduce((n, h) => n + h.browser.paintStats().stuck, 0),
      paintRecovered: holders.reduce((n, h) => n + h.browser.paintStats().recovered, 0),
    },
  };
}

/**
 * 런타임 압박 가드 (REDESIGN §5).
 *
 * 부팅 시 동시 브라우저 수 클램프만으로는 부족하다 — 실제 사용량은 페이지 내용에 따라 변하고,
 * 정지 실패로 고아 프로세스가 남으면 실효 동시성이 설정값을 넘는다. 메모리가 바닥나면
 * 스왑 스래싱이 시작되고 loadavg 가 붕괴해 머신이 멈췄다(3회 강제 리부팅, 당시 load 89/10코어).
 *
 * **판정에 `os.freemem()` 을 쓰지 않는다.** macOS 는 inactive/purgeable 페이지를 캐시로 보유하고
 * `os.freemem()` 은 그것들을 제외한 '순수 free' 만 반환하므로, 건강한 상태에서도 200~400MB 로
 * 읽힌다. 실측: freemem 281MB 인 시점에 실질 가용은 5,378MB(free+inactive+purgeable)이고
 * macOS 자체 압박 레벨은 1(정상), load 는 3.96/10 이었다. 이 값으로 판정했더니 정상 가동 중인
 * 프로덕션의 태스크 인테이크를 계속 막아 처리량을 떨어뜨렸다.
 *
 * 대신 **loadavg** 를 쓴다. 메모리 고갈 → 스왑 스래싱 → load 붕괴가 실제 실패 경로이고,
 * load 는 그 경로의 신뢰할 수 있는 신호다(정상 4~10 vs 사고 89). 포크 없이 읽을 수 있다.
 *
 * 압박이면 **새 태스크 인테이크만** 멈춘다. 브라우저를 죽이지 않으므로 회복 시 즉시 재개되고,
 * 배치는 워치독 상한 안에서 종료되므로 무한 정지가 되지 않는다.
 */
const PRESSURE_SAMPLE_MS = 5_000;
/** 코어당 부하 배수. 정상 0.4~1.0, 사고 시 8.9 였다. 2.5 는 그 사이의 명확한 분리점. */
const PRESSURE_LOAD_PER_CORE = 2.5;
let lastPressureSample = 0;
let underPressure = false;

function systemUnderPressure(): boolean {
  const now = Date.now();
  if (now - lastPressureSample < PRESSURE_SAMPLE_MS) return underPressure;
  lastPressureSample = now;

  const cores = os.cpus().length;
  const load1 = os.loadavg()[0] ?? 0;
  const next = load1 > cores * PRESSURE_LOAD_PER_CORE;
  if (next !== underPressure) {
    console.warn(
      `[Crawler] 시스템 압박 ${next ? "진입 — 태스크 인테이크 일시정지" : "해제 — 재개"} ` +
        `(load ${load1.toFixed(1)}/${cores}, 임계 ${(cores * PRESSURE_LOAD_PER_CORE).toFixed(0)})`,
    );
    if (next) cumulativePressurePauses++;
  }
  underPressure = next;
  return underPressure;
}

// 브라우저 죽음을 감지하는 에러 패턴
const DEAD_BROWSER_PATTERNS = [
  "Browser not available",
  "No pages available",
  "Browser not started",
  "Target closed",
  "Session closed",
  "Protocol error",
  "Browser process died",
  "Attempted to use",       // 장시간 idle 후 stale frame
  "detached Frame",         // CDP frame detached
  "Execution context was destroyed",  // frame context 무효화
];

/**
 * =====================================================
 * Browser Worker (Consumer)
 * =====================================================
 * 각 브라우저가 독립적으로 Task Queue에서 Task를 가져와 처리.
 * BrowserHolder 를 통해 프로필 재생성 시 새 인스턴스로 교체 가능.
 *
 * 워커 하나의 예외가 전체를 무너뜨리지 않도록 격리한다. 이전 구현은 예외가 `Promise.all` 을
 * reject 시켜 `startCrawling` 이 throw 하고, finally 가 running=false 로 만든 뒤에도
 * 나머지 14 워커·fetcher·keepalive 가 계속 돌아 정지 불가 좀비가 됐다.
 */
async function browserWorker(
  holder: BrowserHolder,
  workerIndex: number,
  taskQueue: TaskQueueManager,
): Promise<void> {
  try {
    await runBrowserWorker(holder, workerIndex, taskQueue);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[Worker ${workerIndex}] ${holder.browser.getProfileName()} 워커 종료(격리): ${detail}`,
    );
    holder.browser.updateStatus("error", `워커 예외: ${detail}`);
    // 이 슬롯만 보류시킨다 — 재활 타이머가 되살린다.
    suspendHolder(holder, "parked", `워커 예외: ${detail}`);
  }
}

async function runBrowserWorker(
  holder: BrowserHolder,
  workerIndex: number,
  taskQueue: TaskQueueManager,
): Promise<void> {
  // 시작 시 Random Delay (0~15초)
  const initialDelayMs = Math.floor(Math.random() * 15000);
  await delay(initialDelayMs);

  let consecutiveDeadErrors = 0;
  const MAX_DEAD_ERRORS = 2;

  while (!shouldStop()) {
    const browser = holder.browser;
    const profileName = browser.getProfileName();

    // 보류 슬롯은 재활 타이머가 되살릴 때까지 건드리지 않는다.
    // (이전 구현은 error 상태를 3초마다 무한 재시도해 스핀을 만들었다)
    if (holder.suspended !== "none") {
      await delay(3000);
      continue;
    }

    // 재시작/기동 중이면 대기 — 실제 상호배제는 profileId 락이 보장하고,
    // 이 검사는 불필요한 락 경합을 줄이는 최적화다.
    const currentStatus = browser.getStatus().status;
    if (currentStatus === "restarting" || currentStatus === "starting") {
      await delay(3000);
      continue;
    }

    // 브라우저 에러 시 자동 복구 시도 (백오프 준수)
    if (browser.hasError()) {
      if (Date.now() < holder.nextAttemptAt) {
        await delay(3000);
        continue;
      }
      const errorInfo = browser.getStatus().error || "unknown";
      const cat = logRestart({ profileName, workerIndex, reason: "브라우저 에러 복구", errorMsg: errorInfo });
      incrementStat(cat);
      if (!shouldStop()) {
        await recoverBrowser(holder, workerIndex, `브라우저 에러 복구 [${cat}]`);
      }
      consecutiveDeadErrors = 0;
      await delay(3000);
      continue;
    }

    // 시스템 압박이면 새 태스크를 집지 않는다. 브라우저는 유지하므로 회복 시 즉시 재개된다.
    if (systemUnderPressure()) {
      browser.updateStatus("waiting", "시스템 압박 — 인테이크 일시정지");
      await delay(5000);
      continue;
    }

    // Queue에서 Task 가져오기 (todayStop된 USERNUM 자동 스킵)
    const { task, skippedByTodayStop } = taskQueue.getNext();
    if (skippedByTodayStop > 0) {
      incrementSkipped(skippedByTodayStop, "blockedUser");
    }

    // Task 없으면 짧게 대기 후 재시도 (중지 신호 빠르게 반응)
    if (!task) {
      browser.updateStatus("waiting", "Task 대기 중...");
      for (let i = 0; i < 10 && !shouldStop(); i++) {
        await delay(1000);
      }
      continue;
    }

    // Task 처리 전 브라우저 연결 상태 검증 (stale frame 사전 감지)
    try {
      const page = await browser.getPage();
      await page.evaluate(() => 1);
    } catch (healthErr: any) {
      console.log(
        `[Worker ${workerIndex}] ${profileName} - 태스크 전 health check 실패: ${healthErr.message}`,
      );
      // Task를 큐에 반환하고 브라우저 에러 상태로 전환 → 다음 루프에서 자동 복구
      taskQueue.returnTask(task);
      browser.completeCrawling("error", healthErr.message);
      const cat = logRestart({ profileName, workerIndex, reason: "태스크 전 health check 실패", errorMsg: healthErr.message });
      incrementStat(cat);
      await recoverBrowser(holder, workerIndex, `health check 실패 [${cat}]`);
      continue;
    }

    // Task 처리 시작
    browser.startCrawling(task.TARGETSTORENAME, task.URLPLATFORMS);

    try {
      // Task 처리
      const result = await processSingleTask(browser, task);

      // 성공 → dead error 카운터 리셋
      consecutiveDeadErrors = 0;

      const collectedCount = result.urlcount || 0;
      const { status, message } = classifyResult(result, collectedCount);

      browser.completeCrawling(
        status,
        message,
        status === "success" ? collectedCount : undefined,
      );

      // Queue에 완료 표시
      taskQueue.markComplete(task, result);

      // 성공/실패 카운트 (서버 전송 성공 여부 기준)
      if (result.serverTransmitted) {
        incrementCompleted(1);
      } else {
        // CAPTCHA로 인한 중단과 순수 서버 전송 실패를 구분
        incrementSkipped(1, result.captchaDetected ? "captcha" : "serverTransmitFail");
      }

      // CAPTCHA 감지 시 프로필 재생성 (새 fingerprint + 새 proxy)
      if (result.captchaDetected && !shouldStop()) {
        logRestart({ profileName, workerIndex, reason: "CAPTCHA 감지", category: "CAPTCHA" });
        incrementStat("CAPTCHA");
        await recreateBrowserProfile(holder, workerIndex, "CAPTCHA 감지");
      }
    } catch (error: any) {
      // 예외 발생 시 실패 처리
      const errorMsg = error.message || "Unknown error";
      taskQueue.markFailed(task, errorMsg);
      browser.completeCrawling("error", errorMsg);

      // 브라우저 죽음 감지
      const isDeadBrowser = DEAD_BROWSER_PATTERNS.some((p) =>
        errorMsg.includes(p),
      );
      // 예외 사유 분류: Cloudflare 차단 > 브라우저 죽음 > 타임아웃 > 네트워크 > 기타
      const isCloudflareBlock = errorMsg.includes("Cloudflare");
      const isBlock = /캡차|차단|captcha|blocked/i.test(errorMsg);
      const isTimeout = /timeout|ETIMEDOUT|Timeout waiting/i.test(errorMsg);
      const isNetwork =
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|net::ERR_|페이지 로드 실패|이동 실패|socket hang up/i.test(
          errorMsg,
        );
      const skipReason = isCloudflareBlock
        ? "cloudflareBlock"
        : isBlock
          ? "captcha"
          : isDeadBrowser
            ? "deadBrowser"
            : isTimeout
              ? "timeout"
              : isNetwork
                ? "network"
                : "exception";
      incrementSkipped(1, skipReason);

      // 어떤 예외였는지 상세 로그 ('기타(exception)' 원인 추적용 - 메시지 + 스택)
      logSkipError({
        reason: skipReason,
        platform: task.URLPLATFORMS,
        workerIndex,
        profileName,
        urlnum: task.URLNUM,
        usernum: task.USERNUM,
        errorMsg,
        stack: error?.stack,
      });

      // 중지 요청 시 재시작 안 함
      if (shouldStop()) break;

      if (isDeadBrowser) {
        consecutiveDeadErrors++;
        console.log(
          `[Worker ${workerIndex}] ${profileName} - dead browser 감지 (${consecutiveDeadErrors}/${MAX_DEAD_ERRORS})`,
        );

        if (consecutiveDeadErrors >= MAX_DEAD_ERRORS) {
          consecutiveDeadErrors = 0;
          const cat = logRestart({ profileName, workerIndex, reason: "브라우저 프로세스 죽음", errorMsg });
          incrementStat(cat);
          await recoverBrowser(
            holder,
            workerIndex,
            `브라우저 프로세스 죽음 [${cat}]`,
          );
        }
        continue;
      }

      // 네트워크/차단 오류인지 확인
      const RESTART_ERROR_PATTERNS = [
        "ECONNREFUSED",
        "net::ERR_",
        "페이지 로드 실패",
        "이동 실패",
        "Navigation timeout",
        "Timeout waiting",
        "ETIMEDOUT",
        "Cloudflare block detected",
        "IP change needed",
        "차단",
        "캡차",
      ];

      const needsRestart = RESTART_ERROR_PATTERNS.some((pattern) =>
        errorMsg.includes(pattern),
      );

      // 재시작 필요 시 원인 분류 후 로그 기록
      if (needsRestart) {
        consecutiveDeadErrors = 0;
        const cat = logRestart({ profileName, workerIndex, reason: errorMsg, errorMsg });
        incrementStat(cat);

        // 프로필이 사라진 경우는 프록시 로테이션으로 고칠 수 없다 → 재생성.
        // (이전 구현은 이걸 구분하지 못해 10회 프록시 로테이션을 영구 반복했다 — 인시던트 #2)
        if (error instanceof ProfileGoneError) {
          await recreateBrowserProfile(holder, workerIndex, `프로필 소멸: ${error.rawMessage}`);
        } else if (cat === "BLOCKED" || cat === "CAPTCHA") {
          // 차단은 지문까지 바꿔야 한다 → 프로필 재생성
          await recreateBrowserProfile(holder, workerIndex, `${cat}: ${errorMsg}`);
        } else {
          await recoverBrowser(holder, workerIndex, `${cat}: ${errorMsg}`);
        }
      }
    }

    if (shouldStop()) break;

    // Random Delay (8~15초, 중지 신호에 빠르게 반응)
    holder.browser.updateStatus("waiting", `대기 중...`);
    const randomDelaySeconds = Math.floor(Math.random() * 7) + 8;
    for (let i = 0; i < randomDelaySeconds && !shouldStop(); i++) {
      await delay(1000);
    }
  }
}

/** 실패를 기록하고 지수 백오프를 건다. */
function noteFailure(holder: BrowserHolder, workerIndex: number, error: unknown, reason: string): void {
  holder.failures++;
  const wait = Math.min(
    RECOVER_BACKOFF_BASE_MS * 2 ** (holder.failures - 1),
    RECOVER_BACKOFF_MAX_MS,
  );
  holder.nextAttemptAt = Date.now() + wait;
  const detail = error instanceof Error ? error.message : String(error);
  console.log(
    `[Worker ${workerIndex}] ${holder.browser.getProfileName()} 복구 실패 ` +
      `${holder.failures}/${FAILURE_CAP} (${Math.round(wait / 1000)}s 후 재시도) [${reason}]: ${detail}`,
  );
}

/** 슬롯을 보류시킨다. 종점이 아니라 재활 대기 상태다. */
function suspendHolder(holder: BrowserHolder, kind: "parked" | "zombie", detail: string): void {
  if (holder.suspended !== kind) {
    if (kind === "parked") cumulativeParks++;
    else cumulativeZombies++;
  }
  holder.suspended = kind;
  holder.nextAttemptAt = Date.now() + REHAB_INTERVAL_MS;
  const label = kind === "zombie" ? "정지 미확인 격리" : "보류";
  holder.browser.updateStatus("error", `${label}: ${detail}`);
  console.warn(`[Crawler] ${holder.browser.getProfileName()} → ${kind} (${detail})`);
}

/**
 * 브라우저 복구 (프록시 교체 + 재기동).
 *
 * 이전 구현(handleBrowserRestart)의 결함을 모두 제거했다:
 *  - 호출자가 프록시를 먼저 획득하고 `browser.restart()` 가 "이미 재시작 중"이면 아무것도 하지 않고
 *    성공 반환해서, 획득한 프록시가 주인 없이 남았다(사이클당 +1 영구 누수). → profileId 락으로
 *    직렬화하므로 그런 경로가 없다.
 *  - 정지를 확인하지 않고 프록시를 반납했다. → 확인된 정지 후에만 반납한다.
 *  - 실패해도 10회 재시도를 무한 반복했다. → 백오프 + 캡 + 재생성 1회 에스컬레이션 + 보류.
 *  - 브로커 장애를 프록시 문제로 오인해 로테이션했다. → 브레이커가 열려 있으면 로테이션하지 않는다.
 */
async function recoverBrowser(
  holder: BrowserHolder,
  workerIndex: number,
  reason: string,
): Promise<void> {
  if (holder.suspended !== "none" || shouldStop()) return;
  if (Date.now() < holder.nextAttemptAt) return;

  // 브로커가 죽었으면 프록시를 바꿔도 낫지 않는다. 로테이션으로 프록시 대역만 태우지 않는다.
  if (adsPowerQueue.breakerState() === "open") {
    suspendHolder(holder, "parked", `브로커 차단(브레이커 open) — ${reason}`);
    return;
  }

  if (holder.failures >= FAILURE_CAP) {
    if (!holder.escalated) {
      holder.escalated = true;
      await recreateBrowserProfile(holder, workerIndex, `연속 복구 실패 ${holder.failures}회`);
      return;
    }
    suspendHolder(holder, "parked", `연속 복구 실패 ${holder.failures}회`);
    return;
  }

  const pool = getProxyPool();
  const profileId = holder.browser.getProfileId();

  try {
    await getLifecycleLock().run(profileId, async () => {
      const browser = holder.browser;
      const groupId = browser.getProxyGroupId();

      // 1) 확인된 정지. 확인 못하면 lease 를 반납하지 않고 격리한다.
      try {
        await browser.stop();
      } catch (error: unknown) {
        if (error instanceof StopUnconfirmedError) {
          suspendHolder(holder, "zombie", error.message);
          return;
        }
        throw error;
      }

      // 2) 새 lease 확보. 고갈은 브라우저의 결함이 아니므로 실패로 집계하지 않고,
      //    보유 중인 lease 가 있으면 그것으로 재기동한다(회전은 최적화일 뿐이다).
      const held = browser.getLease();
      const fresh = pool.acquire(profileId, groupId);
      const target = fresh ?? held;
      if (!target) {
        holder.nextAttemptAt = Date.now() + RECOVER_BACKOFF_BASE_MS;
        browser.updateStatus("waiting", "프록시 고갈 — 대기");
        return;
      }
      // 새 것을 확보한 뒤에만 헌 것을 반납한다.
      if (fresh && held && held.proxyId !== fresh.proxyId) pool.release(held);

      // 3) 적용 + 기동
      await browser.startWithLease(target);
      holder.failures = 0;
      holder.escalated = false;
      holder.nextAttemptAt = 0;
      console.log(
        `[Worker ${workerIndex}] ${browser.getProfileName()} ✓ 복구 완료 ${target.ip}:${target.port}`,
      );
    });
  } catch (error: unknown) {
    if (error instanceof ProfileGoneError) {
      await recreateBrowserProfile(holder, workerIndex, `프로필 소멸: ${error.rawMessage}`);
      return;
    }
    noteFailure(holder, workerIndex, error, reason);
  }
}

/**
 * 프로필 재생성 (새 지문 + 새 프록시).
 * 차단/캡차, 프로필 소멸, 복구 실패 캡 도달 시의 경로.
 *
 * 헌 브라우저의 lease 를 반드시 회수한다 — 이전 구현은 재생성 성공 경로에서 이걸 놓쳐
 * 재생성마다 프록시 1개가 영구 고아로 남았다.
 */
async function recreateBrowserProfile(
  holder: BrowserHolder,
  workerIndex: number,
  reason: string,
): Promise<void> {
  if (shouldStop()) return;
  const pool = getProxyPool();
  const manager = getBrowserManager();
  const oldProfileId = holder.browser.getProfileId();

  console.log(`[Worker ${workerIndex}] ${holder.browser.getProfileName()} - 프로필 재생성: ${reason}`);

  try {
    await getLifecycleLock().run(oldProfileId, async () => {
      const old = holder.browser;
      const groupId = old.getProxyGroupId();

      // recreateProfile 은 정지 확인 → 삭제 → 생성 순서다.
      // 정지를 확인하지 못하면 던지므로, 여기서 잡아 zombie 로 격리한다.
      const replacement = await manager.recreateProfile(old);

      // 정지가 확인된 뒤이므로 헌 lease 를 안전하게 반납할 수 있다.
      const stranded = old.takeLease();
      if (stranded) pool.release(stranded);

      holder.browser = replacement;

      const fresh = pool.acquire(replacement.getProfileId(), groupId);
      if (!fresh) {
        replacement.updateStatus("waiting", "프록시 고갈 — 대기");
        holder.nextAttemptAt = Date.now() + RECOVER_BACKOFF_BASE_MS;
        return;
      }
      await replacement.startWithLease(fresh);
      holder.failures = 0;
      holder.suspended = "none";
      holder.nextAttemptAt = 0;
      console.log(
        `[Worker ${workerIndex}] ${replacement.getProfileName()} ✓ 재생성 완료 ` +
          `(${replacement.getProfileId()}) ${fresh.ip}:${fresh.port}`,
      );
    });
  } catch (error: unknown) {
    if (error instanceof StopUnconfirmedError) {
      suspendHolder(holder, "zombie", error.message);
      return;
    }
    if (error instanceof QuotaError) {
      suspendHolder(holder, "parked", `프로필 한도: ${error.rawMessage}`);
      return;
    }
    noteFailure(holder, workerIndex, error, reason);
  }
}

/**
 * 재활 — 보류(parked/zombie) 슬롯을 되살린다.
 * 조건이 여전하면 복구 경로가 다시 보류시키므로, 일시 장애만 자동 회복된다.
 */
function rehabilitateHolders(holders: readonly BrowserHolder[]): void {
  if (adsPowerQueue.breakerState() === "open") return;
  const now = Date.now();
  for (const holder of holders) {
    if (holder.suspended === "none") continue;
    if (now < holder.nextAttemptAt) continue;
    console.log(
      `[Crawler] ${holder.browser.getProfileName()} 재활 시도 (이전 상태: ${holder.suspended})`,
    );
    holder.suspended = "none";
    holder.failures = 0;
    holder.escalated = false;
    holder.nextAttemptAt = 0;
    holder.browser.updateStatus("idle", "재활 — 복구 대기");
  }
}

/**
 * 리소스 리컨실 — 고아 lease 와 고아 프로필을 회수한다.
 * **독립 타이머에서 호출해야 한다.** 이전 완화책은 IP 교체 경로에서만 호출됐고,
 * 풀이 고갈되면 fetcher 가 영구 블록되어 정작 필요한 순간에 도달하지 못했다.
 */
async function reconcileResources(holders: readonly BrowserHolder[]): Promise<void> {
  const live: ProxyLease[] = [];
  for (const holder of holders) {
    const lease = holder.browser.getLease();
    if (lease) live.push(lease);
  }
  cumulativeReclaimedLeases += getProxyPool().reconcile(live);

  const owned = new Set(holders.map((h) => h.browser.getProfileId()));
  try {
    const deleted = await getBrowserManager().reconcileGroupProfiles(owned);
    cumulativeReclaimedProfiles += deleted;
    if (deleted > 0) console.warn(`[Crawler] 고아 프로필 ${deleted}개 삭제`);
  } catch (error: unknown) {
    console.warn(
      `[Crawler] 프로필 리컨실 실패(무시): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * =====================================================
 * Task Fetcher (Producer)
 * =====================================================
 * 새로운 정책:
 * 1. 브라우저 개수 x 50개 태스크 가져오기
 * 2. 진행 상태 리셋
 * 3. 모든 작업 완료 대기
 * 4. 1분 휴식 (브라우저 유지, 세션 보호)
 * 5. 태스크 조회 → 없으면 1분 휴식 반복
 * 6. 태스크 있으면 → 전체 브라우저 일괄 종료 + 새 프록시 IP 설정 → 5초 후 크롤링 시작
 */
async function taskFetcher(
  taskQueue: TaskQueueManager,
  _browserManager: ReturnType<typeof getBrowserManager>,
  holders: BrowserHolder[],
): Promise<void> {
  const browserCount = holders.length;
  const limit = browserCount * 100;
  const REST_DURATION = 1 * 60 * 1000; // 1분 휴식
  /**
   * 배치 완료 대기 상한. 이전 구현은 상한이 없어, 풀이 고갈되어 워커가 태스크를 못 집으면
   * `isAllCompleted()` 가 영원히 false 가 되고 fetcher 가 영구 블록됐다. 그러면 IP 교체도
   * 안 돌고 — 당시 리컨실이 그 경로에만 있었으므로 — self-heal 자체가 도달 불가였다.
   */
  const BATCH_DEADLINE_MS = 45 * 60 * 1000;

  while (!shouldStop()) {

    // 태스크 가져오기
    console.log(
      `[TaskFetcher] Fetching tasks (limit: ${limit}, env: ${process.env.NODE_ENV || "production"})...`,
    );
    const tasks = await fetchTasks(limit);

    if (tasks.length === 0) {
      console.log(`[TaskFetcher] No tasks available, waiting 1 minute...`);
      setWaitState(Date.now() + REST_DURATION, "Task 조회 대기 중...");
      for (let i = 0; i < 60 && !shouldStop(); i++) {
        await delay(1000);
      }
      clearWaitState();
      continue;
    }

    // 태스크 도착 → 전체 브라우저 IP 일괄 변경
    console.log(`[TaskFetcher] ${tasks.length} tasks received. Changing all browser IPs...`);
    setWaitState(Date.now() + 30 * 1000, "브라우저 IP 일괄 변경 중...");
    await rotateAllProxies(holders);
    clearWaitState();
    console.log(`[TaskFetcher] IP change completed. Starting in 5 seconds...`);

    // 5초 대기 후 크롤링 시작
    await delay(5000);

    // 진행 상태 완전 리셋 (큐, 처리중, 완료, 실패 모두 초기화)
    console.log(`[TaskFetcher] Resetting queue stats...`);
    taskQueue.reset();
    resetProgress();
    setTotalTasks(tasks.length);

    // 큐에 태스크 추가
    taskQueue.addTasks(tasks);
    console.log(`[TaskFetcher] Added ${tasks.length} tasks to queue`);

    // 모든 작업 완료 대기 — 반드시 상한을 둔다(워치독).
    console.log(`[TaskFetcher] Waiting for all tasks to complete...`);
    const batchDeadline = Date.now() + BATCH_DEADLINE_MS;
    while (!shouldStop() && !taskQueue.isAllCompleted()) {
      if (Date.now() > batchDeadline) {
        const stuck = holders
          .filter((h) => h.suspended !== "none" || h.browser.hasError())
          .map((h) => `${h.browser.getProfileName()}:${h.suspended}/${h.browser.getStatus().status}`);
        console.warn(
          `[TaskFetcher] 배치 데드라인 초과 — 강제 진행. 정체 슬롯: ${stuck.join(" ") || "(없음)"}`,
        );
        taskQueue.reset();
        break;
      }
      await delay(5000);
    }

    if (shouldStop()) {
      break;
    }

    // 태스크 완료 → 1분 휴식 (브라우저 유지, 세션 보호)
    console.log(`[TaskFetcher] All tasks completed. Resting 1 minute (browsers kept alive)...`);
    setWaitState(Date.now() + REST_DURATION, "다음 작업 대기 중...");
    for (let i = 0; i < 60 && !shouldStop(); i++) {
      await delay(1000);
    }
    clearWaitState();

    console.log(`[TaskFetcher] Rest finished. Fetching next batch...`);
  }
}

/**
 * 전체 브라우저 프록시 일괄 회전.
 *
 * 이전 구현(changeAllBrowserIPs)은 Phase 1 에서 전체를 정지시키고 Phase 2 에서 재배정했다.
 * 모델 검증에서 반증됨: 두 페이즈 사이에 워커가 브라우저를 다시 start 하면, Phase 2 는
 * "이미 정지됨"을 전제로 **살아있는 브라우저의 프록시를 해제**해 I3(트래픽 정합)이 깨졌다.
 * 따라서 페이즈 간 전제를 없애고, **브라우저별 락 안에서 정지 확인 → 재배정 → 기동**을
 * 자기완결적으로 수행한다. 회전 실패는 park 하지 않고 다음 사이클에 다시 시도한다.
 */
async function rotateAllProxies(holders: BrowserHolder[]): Promise<void> {
  const pool = getProxyPool();
  const CONCURRENCY = 5;

  console.log(`[Rotate] ${holders.length}개 브라우저 프록시 회전 시작`);

  for (let start = 0; start < holders.length; start += CONCURRENCY) {
    if (shouldStop()) return;
    const batch = holders.slice(start, start + CONCURRENCY);

    await Promise.allSettled(
      batch.map(async (holder) => {
        if (holder.suspended !== "none") return;
        const profileId = holder.browser.getProfileId();
        try {
          await getLifecycleLock().run(profileId, async () => {
            const browser = holder.browser;
            const groupId = browser.getProxyGroupId();

            try {
              await browser.stop();
            } catch (error: unknown) {
              if (error instanceof StopUnconfirmedError) {
                suspendHolder(holder, "zombie", error.message);
                return;
              }
              throw error;
            }

            const held = browser.getLease();
            const fresh = pool.acquire(profileId, groupId);
            const target = fresh ?? held;
            if (!target) {
              // 고갈은 실패가 아니다 — 회전을 건너뛰고 다음 사이클을 기다린다.
              browser.updateStatus("waiting", "프록시 고갈 — 회전 건너뜀");
              return;
            }
            if (fresh && held && held.proxyId !== fresh.proxyId) pool.release(held);

            await browser.startWithLease(target);
            console.log(`[Rotate] ${browser.getProfileName()} ✓ ${target.ip}:${target.port}`);
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          console.log(`[Rotate] ${holder.browser.getProfileName()} ✗ ${detail}`);
          holder.browser.updateStatus("error", `회전 실패: ${detail}`);
        }
      }),
    );
  }

  // `isReady()`(status==="ready")로 세면 곧바로 waiting/crawling 으로 넘어간 정상 브라우저가
  // 빠져 "1/15" 처럼 보인다. 가동 여부는 인스턴스 생존 + 보류/에러 아님으로 판정한다.
  const operational = holders.filter(
    (h) => h.suspended === "none" && !h.browser.hasError() && h.browser.hasBrowser(),
  ).length;
  console.log(`[Rotate] 완료: ${operational}/${holders.length} 가동`);
}

/**
 * =====================================================
 * Result Handler (백그라운드 결과 처리)
 * =====================================================
 * 완료된 Task들을 주기적으로 처리 (todayStop, cleanup 등)
 */
async function resultHandler(taskQueue: TaskQueueManager): Promise<void> {
  while (!shouldStop()) {
    // 10초마다 완료/실패 Task 처리
    await delay(10000);

    // 완료된 Tasks 가져오기
    const completedTasks = taskQueue.getCompletedTasks();
    if (completedTasks.length > 0) {
      const tasks = completedTasks.map((ct) => ct.task);
      const results = completedTasks.map((ct) => ct.result);

      removeCompletedTasks(tasks);
      handleTodayStopResults(results, tasks);
    }

    // 실패한 Tasks도 정리
    const failedTasks = taskQueue.getFailedTasks();
    if (failedTasks.length > 0) {
      const tasks = failedTasks.map((ft) => ft.task);
      removeCompletedTasks(tasks);
    }
  }
}

/**
 * =====================================================
 * 메인 크롤링 (Producer-Consumer Pattern with DDD)
 * - BrowserManager에서 준비된 브라우저 사용
 * =====================================================
 */
export async function startCrawling(): Promise<CrawlResult[]> {
  const browserManager = getBrowserManager();

  // 준비된 브라우저가 없으면 에러
  if (!browserManager.hasBrowsers()) {
    throw new Error("No browsers prepared. Run 'Prepare Browsers' first.");
  }

  // 이미 실행 중이면 에러
  if (isRunning()) {
    throw new Error("Crawler is already running. Stop it first.");
  }

  // 크롤러 상태 설정
  setRunning(true);
  resetProgress();
  resetRestartStats();
  // 이 실행의 세대 토큰. 모든 루프가 이 값을 확인하므로, 정지 후 재시작해도 이전 세대의
  // 좀비 루프가 부활해 같은 브라우저를 이중으로 구동하는 일이 없다.
  const runId = ++currentRunId;
  const alive = (): boolean => runId === currentRunId && !shouldStop();

  // 재시작 로거 초기화 (DATA_DIR/logs/restart-YYYY-MM-DD.tsv)
  initRestartLogger(DATA_DIR);

  const browsers = browserManager.getBrowsers();
  const batchSize = browsers.length;

  console.log(
    `\n[Crawler] Starting with ${batchSize} prepared browsers (DDD Pattern)\n`,
  );

  // BrowserHolder 배열 생성 (mutable wrapper — 프로필 재생성 시 참조 교체 가능)
  const holders: BrowserHolder[] = browsers.map((browser) => ({
    browser,
    failures: 0,
    suspended: "none",
    nextAttemptAt: 0,
    escalated: false,
  }));

  // ========================================
  // Step 1: Task Queue Manager 생성
  // ========================================
  const taskQueue = new TaskQueueManager();

  // ========================================
  // Step 2: 상태 조회 함수 등록 (UI용)
  // ========================================
  registerBrowserStatusesGetter(() =>
    holders.map((h) => h.browser.getStatus()),
  );
  holdersSnapshot = () => holders;

  try {
    // ========================================
    // Step 3: Workers 시작
    // ========================================

    // Task Fetcher (Producer) 시작
    const fetcherPromise = taskFetcher(taskQueue, browserManager, holders);

    // Result Handler 시작
    const handlerPromise = resultHandler(taskQueue);

    // Browser Workers (Consumers) 시작
    const workerPromises = holders.map((holder, index) =>
      browserWorker(holder, index, taskQueue),
    );

    // Keepalive 주기적으로 실행
    const keepalivePromise = (async () => {
      while (alive()) {
        await delay(60000); // 1분마다
        await browserManager.keepalive();
      }
    })();

    // 리컨실 타이머 — IP 회전 경로와 독립. 고아 lease/프로필을 주기적으로 회수한다.
    // 이 독립성이 핵심이다: 이전 완화책은 회전 경로에만 있어서 풀이 고갈되면 도달 불가였다.
    const reconcilePromise = (async () => {
      while (alive()) {
        await delay(RECONCILE_INTERVAL_MS);
        if (!alive()) break;
        await reconcileResources(holders);
      }
    })();

    // 재활 타이머 — parked/zombie 를 되살린다. 없으면 일시 장애가 영구적 fleet 축소로 굳는다.
    const rehabPromise = (async () => {
      while (alive()) {
        await delay(60_000);
        if (!alive()) break;
        rehabilitateHolders(holders);
      }
    })();

    const everything = [
      fetcherPromise,
      handlerPromise,
      ...workerPromises,
      keepalivePromise,
      reconcilePromise,
      rehabPromise,
    ];

    // 모든 Workers 대기
    console.log(`[Crawler] All workers started. Waiting for completion...\n`);
    const stopWatch = Promise.withResolvers<void>();
    const stopTimer = setInterval(() => {
      if (!alive()) stopWatch.resolve();
    }, 1000);
    try {
      await Promise.race([Promise.allSettled(everything), stopWatch.promise]);
    } finally {
      clearInterval(stopTimer);
    }

    // 실제 드레인 — 정지 신호 후 루프들이 끝날 때까지 데드라인 내에서 기다린다.
    // 이전 구현은 race 로 즉시 반환해 워커·fetcher 를 방치했고, 그 루프들이
    // 다음 start 의 setRunning(true) 로 stop 플래그가 꺼지면 되살아났다.
    const drainDeadline = Promise.withResolvers<void>();
    const drainTimer = setTimeout(() => drainDeadline.resolve(), DRAIN_DEADLINE_MS);
    try {
      await Promise.race([Promise.allSettled(everything), drainDeadline.promise]);
    } finally {
      clearTimeout(drainTimer);
    }
  } finally {
    // ========================================
    // Step 4: 정리
    // ========================================
    // 상태 조회 함수 해제
    unregisterBrowserStatusesGetter();
    holdersSnapshot = null;

    // 브라우저는 닫지 않음 (BrowserManager가 관리)
    setRunning(false);

    const stats = taskQueue.getStats();
    console.log(`\n[Crawler] Finished.`);
    console.log(`  Completed: ${stats.completedCount}`);
    console.log(`  Failed: ${stats.failedCount}`);
    console.log(`  Remaining in queue: ${stats.queueSize}\n`);
  }

  // 결과 반환 (빈 배열 - Worker 방식에서는 실시간 처리)
  return [];
}

/**
 * @deprecated Use startCrawling() instead. This function is kept for backward compatibility.
 */
export async function processBatch(
  _apiKey: string,
  _sessions: any[],
): Promise<CrawlResult[]> {
  console.warn(
    "[Crawler] processBatch() is deprecated. Use startCrawling() instead.",
  );
  return startCrawling();
}

/**
 * =====================================================
 * 단일 Task 처리 (DDD 패턴 적용)
 * =====================================================
 */
async function processSingleTask(
  browser: CrawlerBrowser,
  task: CrawlTask,
): Promise<CrawlResult> {
  const profileName = browser.getProfileName();

  if (!browser.hasBrowser()) {
    throw new Error("Browser not available");
  }

  // 플랫폼별 이미지 차단 설정 (실시간 적용, reload 불필요)
  if (task.URLPLATFORMS === "NAVER") {
    browser.setImageBlocking(true); // 네이버: 이미지 차단 (성능 최적화)
  } else if (task.URLPLATFORMS === "AUCTION") {
    browser.setImageBlocking(false); // 옥션: 이미지 필요 (상품 이미지 수집)
  }

  const page = await preparePage(browser, task);
  await navigateToTarget(page, task, profileName);

  if (task.URLPLATFORMS === "NAVER") {
    return await crawlNaver(page, task, profileName);
  } else if (task.URLPLATFORMS === "AUCTION") {
    return await crawlAuction(page, task, profileName);
  } else {
    return {
      success: true,
      urlNum: task.URLNUM,
      storeName: task.TARGETSTORENAME,
      message: "Crawl completed",
    };
  }
}

/**
 * =====================================================
 * 페이지 준비 (Base URL 이동)
 * =====================================================
 */
async function preparePage(
  browser: CrawlerBrowser,
  task: CrawlTask,
): Promise<any> {
  const page = await browser.getPage();
  const currentUrl = await browser.getCurrentUrl();
  const profileName = browser.getProfileName();

  // Base URL로 이동 (필요시)
  if (task.URLPLATFORMS === "NAVER") {
    const isNaverMain = isNaverMainUrl(currentUrl);

    if (!isNaverMain) {
      let backOk = false;

      // 이전 크롤링 결과 페이지(네이버 도메인)에서 history.back으로 메인 복귀 시도
      if (currentUrl.includes("naver.com")) {
        try {
          const backStart = Date.now();
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
            page.goBack(),
          ]);
          if (isNaverMainUrl(page.url())) {
            backOk = true;
            console.log(
              `[Navigate] ${profileName} - goBack to naver main: ${Date.now() - backStart}ms`,
            );
          } else {
            console.log(
              `[Navigate] ${profileName} - goBack landed on ${page.url()}, fallback to goto`,
            );
          }
        } catch (e: any) {
          console.log(
            `[Navigate] ${profileName} - goBack failed (${e.message}), fallback to goto`,
          );
        }
      }

      if (!backOk) {
        await page.goto("https://www.naver.com/", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        const afterGotoUrl = page.url();
        if (
          afterGotoUrl.startsWith("chrome-error://") ||
          afterGotoUrl === "about:blank"
        ) {
          throw new Error("naver.com 이동 실패 (네트워크/프록시 오류)");
        }
        if (!afterGotoUrl.includes("naver.com")) {
          throw new Error(`naver.com 이동 실패: ${afterGotoUrl}`);
        }
      }

      const randomDelay = Math.floor(Math.random() * 6000) + 2000;
      await delay(randomDelay);
    }
  } else if (
    task.URLPLATFORMS === "AUCTION" &&
    !currentUrl.includes("auction.co.kr")
  ) {
    await page.goto("https://www.auction.co.kr/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const afterGotoUrl = page.url();
    if (
      afterGotoUrl.startsWith("chrome-error://") ||
      afterGotoUrl === "about:blank"
    ) {
      throw new Error("auction.co.kr 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("auction.co.kr")) {
      throw new Error(`auction.co.kr 이동 실패: ${afterGotoUrl}`);
    }

    // DOM 파싱 완료 후 나머지 리소스 로딩 중단 (base URL 이동 목적만 달성)
    await page.evaluate(() => window.stop());

    const randomDelay = Math.floor(Math.random() * 6000) + 2000;
    await delay(randomDelay);
  }

  return page;
}

/**
 * =====================================================
 * 타겟 URL로 이동
 * =====================================================
 */
/**
 * 네비게이션 타임아웃/실패 시 원인 진단 정보 수집
 * - 시스템 리소스(CPU 부하/메모리)와 페이지 상태를 캡처하여 에러 메시지에 첨부
 * - 이걸로 "네트워크 / 리소스 부족 / 페이지 로딩(load 이벤트) 지연"을 구분
 */
async function collectNavDiagnostics(
  page: any,
  navStart: number,
): Promise<string> {
  const parts: string[] = [];

  // 1) 시스템 리소스 (이 머신이 과부하인지)
  try {
    const load1 = os.loadavg()[0]; // 최근 1분 평균 부하
    const cores = os.cpus().length;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const freeMb = Math.round(freeMem / 1024 / 1024);
    const usedPct = Math.round((1 - freeMem / totalMem) * 100);
    parts.push(`cpu=${load1.toFixed(1)}/${cores}`);
    parts.push(`memFree=${freeMb}MB(${usedPct}%used)`);
  } catch {
    parts.push("sys=?");
  }

  // 2) 페이지 상태 (3초 가드 — evaluate 자체가 멈추면 페이지/연결이 죽은 것)
  try {
    const pageState: any = await Promise.race([
      page.evaluate(() => ({
        url: location.href,
        readyState: document.readyState,
        hasPreloaded:
          typeof (window as any).__PRELOADED_STATE__ !== "undefined",
        resourceCount: performance.getEntriesByType("resource").length,
        // responseEnd === 0 → 아직 완료되지 않은 리소스
        pending: performance
          .getEntriesByType("resource")
          .filter((r: any) => !r.responseEnd).length,
      })),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("diag-eval-timeout")), 3000),
      ),
    ]);
    const shortUrl = String(pageState.url)
      .replace(/^https?:\/\//, "")
      .slice(0, 60);
    parts.push(`readyState=${pageState.readyState}`);
    parts.push(`preloaded=${pageState.hasPreloaded}`);
    parts.push(
      `res=${pageState.resourceCount}(pending ${pageState.pending})`,
    );
    parts.push(`url=${shortUrl}`);
  } catch (e: any) {
    // evaluate가 멈추거나 실패 → 페이지/렌더러/연결 이상 (네트워크 행 가능성)
    parts.push(`pageEval=FAIL(${e?.message || "?"})`);
    try {
      parts.push(
        `url=${String(page.url())
          .replace(/^https?:\/\//, "")
          .slice(0, 60)}`,
      );
    } catch {
      /* page.url()도 실패 */
    }
  }

  parts.push(`elapsed=${((Date.now() - navStart) / 1000).toFixed(1)}s`);
  return parts.join(", ");
}

async function navigateToTarget(
  page: any,
  task: CrawlTask,
  profileName: string,
): Promise<void> {
  // DOM에 링크 삽입
  const uniqueId = `crawler-link-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  const linkCreated = await page.evaluate(
    (url: string, linkId: string) => {
      try {
        // 기존 링크 제거
        const oldLinks = document.querySelectorAll(
          '[data-crawler-link="true"]',
        );
        oldLinks.forEach((link) => link.remove());

        // 새 링크 생성
        const link = document.createElement("a");
        link.id = linkId;
        link.href = url;
        link.textContent = "Navigation Link";
        link.setAttribute("data-crawler-link", "true");
        link.style.position = "fixed";
        link.style.top = "10px";
        link.style.right = "10px";
        link.style.padding = "10px 20px";
        link.style.backgroundColor = "#4CAF50";
        link.style.color = "white";
        link.style.zIndex = "999999";
        link.style.cursor = "pointer";

        document.body.appendChild(link);

        const addedLink = document.getElementById(linkId);
        return addedLink !== null && addedLink.getAttribute("href") === url;
      } catch {
        return false;
      }
    },
    task.TARGETURL,
    uniqueId,
  );

  if (!linkCreated) {
    throw new Error("Failed to create navigation link");
  }

  // 클릭 전 랜덤 대기 (0~3초)
  const preClickDelay = Math.floor(Math.random() * 3000);
  await delay(preClickDelay);

  // 클릭 및 네비게이션 대기 (Promise.all로 동시 await — unhandled rejection 방지)
  const navStart = Date.now();
  // 모든 플랫폼 domcontentloaded 기준.
  // (이전엔 NAVER만 "load" = 광고/트래커까지 전부 로딩 완료를 60초 대기 →
  //  광고 리소스 지연으로 타임아웃 다발. 필요한 데이터는 아래 waitForFunction으로 별도 확인하므로
  //  DOM 파싱 완료 시점에 진행해도 안전. 리소스는 window.stop() 안 하므로 백그라운드 계속 로딩됨)
  const waitCondition = "domcontentloaded";

  try {
    await Promise.all([
      page.waitForNavigation({
        waitUntil: waitCondition,
        timeout: 60000,
      }),
      // CDP 마우스 클릭(page.click)은 일부 AdsPower SunBrowser 버전에서 액추에이트 안 됨 →
      // 주입 앵커를 DOM 클릭(el.click())으로 직접 이동 (버전/좌표/오버레이 무관, prowler 검증)
      page.evaluate((id: string) => {
        document.getElementById(id)?.click();
      }, uniqueId),
    ]);
  } catch (navErr: any) {
    // 타임아웃/네비게이션 실패 → 원인 진단 정보를 에러에 첨부 (skip-error 로그로 전달됨)
    const diag = await collectNavDiagnostics(page, navStart);
    navErr.message = `${navErr.message || "navigation error"} [diag: ${diag}]`;
    throw navErr;
  }
  if (verboseLogging()) console.log(`[Navigate] ${profileName} - ${waitCondition}: ${Date.now() - navStart}ms`);

  // URL 검증
  const finalUrl = page.url();

  // Chrome 에러 페이지 체크
  if (finalUrl.startsWith("chrome-error://") || finalUrl === "about:blank") {
    throw new Error(`페이지 로드 실패 (네트워크/프록시 오류)`);
  }

  const expectedDomain =
    task.URLPLATFORMS === "NAVER" ? "naver.com" : "auction.co.kr";

  if (!finalUrl.includes(expectedDomain)) {
    throw new Error(
      `Wrong domain! Expected ${expectedDomain}, got: ${finalUrl}`,
    );
  }

  if (task.URLPLATFORMS === "AUCTION" && !finalUrl.includes("/n/search")) {
    throw new Error(`Wrong AUCTION URL pattern! Got: ${finalUrl}`);
  }

  // 플랫폼별 데이터 존재 확인 후 나머지 로딩 중단
  // (readyState === "complete" 대기 대신, 필요한 데이터만 확인하고 빠르게 진행)
  // Cloudflare 블록 페이지에는 데이터 요소가 없으므로 블록 지표도 함께 감시
  const dataWaitStart = Date.now();
  if (task.URLPLATFORMS === "AUCTION") {
    // Auction: #__NEXT_DATA__ OR Cloudflare 블록 지표 (스크립트 변수 + 텍스트)
    const waitResult = await page.waitForFunction(
      () => {
        const hasData = !!document.getElementById("__NEXT_DATA__");
        const hasBlock =
          !!(window as any)._cf_chl_opt ||
          document.title === "잠시만요..." ||
          document.title === "Just a moment..." ||
          (document.body?.textContent || "").includes("사용자 활동 검토 요청");
        if (hasData) return "data";
        if (hasBlock) return "blocked";
        return false;
      },
      { timeout: 30000 },
    );
    const result = await waitResult.jsonValue();
    if (verboseLogging()) console.log(`[Navigate] ${profileName} - data wait (${result}): ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`);
    if (result === "blocked") {
      logBlocked("AUCTION", profileName);
      throw new Error("Cloudflare block detected - IP change needed");
    }
  } else if (task.URLPLATFORMS === "NAVER") {
    // Naver: __PRELOADED_STATE__(데이터) OR 캡차/차단 지표를 함께 감시.
    // 차단 시 30초 대기 없이 즉시 감지 → 재생성(새 지문+새 프록시) 경로로 보낸다.
    let result: string;
    try {
      const waitResult = await page.waitForFunction(
        () => {
          const w = window as unknown as { __PRELOADED_STATE__?: unknown; _cf_chl_opt?: unknown };
          if (w.__PRELOADED_STATE__) return "data";
          const blocked =
            !!document.querySelector('script[src*="wtm_captcha.js"]') ||
            !!document.querySelector('iframe[src*="captcha"]') ||
            !!document.querySelector(".captcha_container") ||
            !!document.querySelector("#frmNIDLogin") ||
            !!w._cf_chl_opt ||
            document.title === "잠시만요..." ||
            document.title === "Just a moment...";
          return blocked ? "blocked" : false;
        },
        { timeout: 30000 },
      );
      result = String(await waitResult.jsonValue());
    } catch (waitErr: any) {
      // 데이터 대기 타임아웃 → 진단 정보 첨부
      const diag = await collectNavDiagnostics(page, navStart);
      waitErr.message = `Naver __PRELOADED_STATE__ wait timeout: ${waitErr.message || ""} [diag: ${diag}]`;
      throw waitErr;
    }
    if (verboseLogging()) console.log(`[Navigate] ${profileName} - data wait (${result}): ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`);
    if (result === "blocked") {
      logBlocked("NAVER_CAPTCHA", profileName);
      throw new Error("네이버 캡차/차단 감지 - 프로필 재생성 필요");
    }
  }

  // 나머지 리소스 로딩 중단 (이미지, 광고, 트래킹 등) - 네이버는 제외 (블록 방지)
  if (task.URLPLATFORMS !== "NAVER") {
    await page.evaluate(() => window.stop());
  }
}

/**
 * =====================================================
 * 유틸리티
 * =====================================================
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 현재 URL이 네이버 메인(www.naver.com/) 인지 판별
 */
function isNaverMainUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.naver.com" &&
      (u.pathname === "" || u.pathname === "/")
    );
  } catch {
    return false;
  }
}

/**
 * 크롤러 중지 요청.
 *
 * `isRunning()` 을 검사하지 않는다. 워커 예외로 `Promise.all` 이 reject 되면 finally 가
 * `running=false` 로 만들지만 나머지 루프는 계속 돌았고, 그 상태에서 이 함수가 early return 해서
 * **정지 불가 좀비 크롤러**가 됐다(SIGKILL 만 유효). 정지 요청은 항상 받아들인다.
 */
export function stopCrawler(): void {
  requestStop();
  // 세대 토큰을 올려 남아있는 구 세대 루프가 즉시 종료 조건을 만족하게 한다.
  currentRunId++;
  console.log("[Crawler] 정지 요청 — 모든 루프 종료 대기");
}

/**
 * 크롤러 현재 상태 조회
 */
export function getCrawlerStatus(): {
  isRunning: boolean;
} {
  return {
    isRunning: isRunning(),
  };
}

/**
 * 크롤러 진행 상태 조회 (상세)
 */
export { getCrawlerProgress } from "./crawler/state";

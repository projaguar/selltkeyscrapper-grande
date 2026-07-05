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
import { getProxyPool } from "./proxy-pool";
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

// Mutable wrapper: worker가 프로필 재생성 후 새 CrawlerBrowser를 사용할 수 있게 함
interface BrowserHolder {
  browser: CrawlerBrowser;
}

// IP 일괄 변경 중 플래그 (worker가 중복 재시작하지 않도록)
let ipChangeInProgress = false;

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
 * Browser Worker (Consumer) - DDD 패턴 적용
 * =====================================================
 * 각 브라우저가 독립적으로 Task Queue에서 Task를 가져와 처리
 * BrowserHolder를 통해 프로필 재생성 시 새 인스턴스로 교체 가능
 */
async function browserWorker(
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

    // IP 일괄 변경 중이면 대기 (taskFetcher가 changeAllBrowserIPs 수행 중)
    if (ipChangeInProgress) {
      await delay(3000);
      continue;
    }

    // 재시작 중이면 대기
    if (browser.getStatus().status === "restarting") {
      await delay(3000);
      continue;
    }

    // 브라우저 에러 시 자동 복구 시도
    if (browser.hasError()) {
      // IP 일괄 변경 직후 에러 상태면 무시 (changeAllBrowserIPs가 이미 처리)
      if (ipChangeInProgress) {
        await delay(3000);
        continue;
      }
      const errorInfo = browser.getStatus().error || "unknown";
      const cat = logRestart({ profileName, workerIndex, reason: "브라우저 에러 복구", errorMsg: errorInfo });
      incrementStat(cat);
      if (!shouldStop()) {
        await handleBrowserRestart(holder, workerIndex, `브라우저 에러 복구 [${cat}]`);
      }
      consecutiveDeadErrors = 0;
      // 복구 후 잠시 대기
      await delay(3000);
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
      await handleBrowserRestart(holder, workerIndex, `health check 실패 [${cat}]`);
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
        await handleBrowserRecreation(holder, workerIndex, "CAPTCHA 감지");
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
          await handleBrowserRestart(
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

        if (cat === "BLOCKED" || cat === "CAPTCHA") {
          // BLOCKED: 프로필 재생성 (새 fingerprint + 새 proxy)
          await handleBrowserRecreation(holder, workerIndex, `${cat}: ${errorMsg}`);
        } else {
          await handleBrowserRestart(holder, workerIndex, `${cat}: ${errorMsg}`);
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

/**
 * 브라우저 재시작 처리 (프록시만 교체)
 * - 새 프록시로 시작 시도 (그룹별)
 * - 실패하면 다른 프록시로 재시도 (최대 10회)
 * - 죽은 브라우저, 네트워크 오류, IP 변경 모두 이 함수로 복구
 */
async function handleBrowserRestart(
  holder: BrowserHolder,
  workerIndex: number,
  reason: string,
): Promise<void> {
  const maxProxyRetries = 10;
  const proxyPool = getProxyPool();
  const browser = holder.browser;
  const profileName = browser.getProfileName();
  const groupId = browser.getProxyGroupId();
  const groupName = browser.getProxyGroupName();

  for (let proxyAttempt = 1; proxyAttempt <= maxProxyRetries; proxyAttempt++) {
    // 중지 요청 시 즉시 종료
    if (shouldStop()) {
      console.log(
        `[Worker ${workerIndex}] ${profileName} - 중지 요청으로 재시작 취소`,
      );
      return;
    }

    browser.updateStatus(
      "restarting",
      `${reason} - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}...`,
    );

    try {
      // 기존 Proxy를 active로 복귀 (round-robin 순환으로 자연 쿨다운)
      const oldProxyId = browser.getProxyId();
      if (oldProxyId) {
        proxyPool.releaseProxy(oldProxyId, groupId);
      }

      // 그룹별 새 Proxy 할당
      const newProxy =
        groupId !== undefined
          ? proxyPool.getNextProxyByGroup(groupId)
          : proxyPool.getNextProxy();

      if (!newProxy) {
        console.log(
          `[Worker ${workerIndex}] ${profileName} [${groupName || "default"}] - 프록시 없음`,
        );
        browser.updateStatus(
          "error",
          `No available proxies in group ${groupName || "default"}`,
        );
        return;
      }

      console.log(
        `[Worker ${workerIndex}] ${profileName} [${groupName || "default"}] - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}: ${newProxy.ip}:${newProxy.port}`,
      );

      // 브라우저 재시작 (새 Proxy로, getNextProxy에서 이미 in_use로 마킹됨)
      await browser.restart(newProxy);

      console.log(
        `[Worker ${workerIndex}] ${profileName} [${groupName || "default"}] - ✓ 재시작 완료: ${newProxy.ip}:${newProxy.port}`,
      );
      return;
    } catch (error: any) {
      console.log(
        `[Worker ${workerIndex}] ${profileName} [${groupName || "default"}] - ✗ 프록시 시도 ${proxyAttempt} 실패: ${error.message}`,
      );

      // 재시작 전 잠시 대기 (1.5초)
      await delay(1500);
    }
  }

  // 모든 프록시 시도 실패
  console.log(
    `[Worker ${workerIndex}] ${profileName} [${groupName || "default"}] - ${maxProxyRetries}개 프록시 모두 실패`,
  );
  browser.updateStatus("error", `${maxProxyRetries}개 프록시 모두 실패`);
}

/**
 * CAPTCHA 차단 시 프로필 재생성 (새 fingerprint + 새 proxy = 완전한 새 identity)
 * 실패 시 폴백: 프록시만 변경하는 일반 재시작
 */
async function handleBrowserRecreation(
  holder: BrowserHolder,
  workerIndex: number,
  reason: string,
): Promise<void> {
  const browserManager = getBrowserManager();
  const proxyPool = getProxyPool();
  const oldBrowser = holder.browser;
  const profileName = oldBrowser.getProfileName();
  const groupId = oldBrowser.getProxyGroupId();
  const groupName = oldBrowser.getProxyGroupName();

  console.log(
    `[Worker ${workerIndex}] ${profileName} - ${reason}: 프로필 재생성 시작`,
  );
  oldBrowser.updateStatus("restarting", `${reason} - 프로필 재생성 중...`);

  try {
    // 1. 프로필 재생성 (AdsPower: 구 삭제 + 신 생성)
    const newBrowser = await browserManager.recreateProfile(oldBrowser);

    // 2. 새 프록시 할당
    const newProxy =
      groupId !== undefined
        ? proxyPool.getNextProxyByGroup(groupId)
        : proxyPool.getNextProxy();

    if (!newProxy) {
      console.log(`[Worker ${workerIndex}] ${profileName} - 새 프록시 없음`);
      newBrowser.updateStatus(
        "error",
        `No available proxies in group ${groupName || "default"}`,
      );
      holder.browser = newBrowser;
      return;
    }

    // 3. 프록시 설정 + 브라우저 시작 (getNextProxy에서 이미 in_use로 마킹됨)
    await newBrowser.updateProxySettings(newProxy);

    await newBrowser.start({
      validateProxy: false,
      validateConnection: false,
    });

    // 4. holder 참조 교체 (worker가 새 인스턴스 사용)
    holder.browser = newBrowser;

    console.log(
      `[Worker ${workerIndex}] ${profileName} - ✓ 프로필 재생성 완료 (${newBrowser.getProfileId()}) proxy: ${newProxy.ip}:${newProxy.port}`,
    );
  } catch (error: any) {
    console.log(
      `[Worker ${workerIndex}] ${profileName} - ✗ 프로필 재생성 실패: ${error.message}, 프록시만 변경으로 폴백`,
    );
    // 폴백: 기존 프로필로 프록시만 변경
    await handleBrowserRestart(
      holder,
      workerIndex,
      `${reason} (재생성 실패, 프록시 변경)`,
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
  const proxyPool = getProxyPool();
  const REST_DURATION = 1 * 60 * 1000; // 1분 휴식

  // 최초 시작 시 모든 프록시 활성화 (준비 단계에서 프록시 미할당)
  proxyPool.resetAllProxies();

  while (!shouldStop()) {
    // 매 루프 시작 시 dead 프록시만 복원 (in_use는 유지 — 현재 사용 중인 프록시 보호)
    proxyPool.resetDeadProxies();

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
    await changeAllBrowserIPs(holders);
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

    // 모든 작업 완료 대기 (큐 비어있고 처리중인 것도 없음)
    console.log(`[TaskFetcher] Waiting for all tasks to complete...`);
    while (!shouldStop() && !taskQueue.isAllCompleted()) {
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
 * 모든 브라우저의 IP를 일괄 변경 (병렬 처리, concurrency=10)
 * 죽은 브라우저도 이 과정에서 복구됨 (restart가 stop → start 수행)
 */
async function changeAllBrowserIPs(holders: BrowserHolder[]): Promise<void> {
  const proxyPool = getProxyPool();
  const BATCH_SIZE = 10;
  const maxRetries = 5;

  console.log(
    `[IPChange] Starting IP change for ${holders.length} browsers (batch size: ${BATCH_SIZE}, max retries: ${maxRetries})`,
  );

  // worker가 중복 재시작하지 않도록 플래그 설정
  ipChangeInProgress = true;

  // ===== Phase 1: 모든 브라우저 일괄 종료 =====
  // Puppeteer 연결 즉시 해제 (API 호출 없이)
  for (const holder of holders) {
    holder.browser.disconnectOnly();
  }

  // AdsPower 브라우저 종료 — 자기 프로필만 개별 종료(공유 AdsPower 에서 타 앱 브라우저 보호).
  //  ⚠️ 인스턴스 전체 stop-all(/api/v2/.../stop-all)은 prowler 등 다른 앱 브라우저까지 끄므로 사용 금지.
  const apiKey = holders[0]?.browser.getApiKey();
  if (apiKey) {
    await Promise.all(
      holders.map((h) =>
        adsPowerQueue
          .stopBrowser(apiKey, h.browser.getProfileId())
          .catch((e) =>
            console.log(`[IPChange] stop 실패 ${h.browser.getProfileId()} (무시): ${e instanceof Error ? e.message : String(e)}`),
          ),
      ),
    );
    console.log(`[IPChange] ${holders.length}개 브라우저 개별 종료 (자기 프로필만)`);
  }

  // 브라우저들이 완전히 종료될 때까지 잠시 대기
  await delay(2000);

  // ===== Phase 2: 프록시 변경 + 재시작 =====
  for (
    let batchStart = 0;
    batchStart < holders.length;
    batchStart += BATCH_SIZE
  ) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, holders.length);
    const batch = holders.slice(batchStart, batchEnd);

    if (batchStart > 0) {
      console.log(`[IPChange] Waiting 5s before next batch...`);
      await delay(5000);
    }

    console.log(
      `[IPChange] Processing batch ${batchStart + 1}-${batchEnd}/${holders.length}`,
    );

    await Promise.all(
      batch.map(async (holder) => {
        const browser = holder.browser;
        const groupId = browser.getProxyGroupId();
        const groupName = browser.getProxyGroupName();
        const profileName = browser.getProfileName();

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          if (shouldStop()) return;

          try {
            // 기존 Proxy를 active로 복귀 (round-robin 순환으로 자연 쿨다운)
            const oldProxyId = browser.getProxyId();
            if (oldProxyId) {
              proxyPool.releaseProxy(oldProxyId, groupId);
            }

            // 그룹별 새 Proxy 할당
            const newProxy =
              groupId !== undefined
                ? proxyPool.getNextProxyByGroup(groupId)
                : proxyPool.getNextProxy();

            if (!newProxy) {
              console.log(
                `[IPChange] ${profileName} [${groupName || "default"}] - No available proxies`,
              );
              browser.updateStatus(
                "error",
                `No available proxies in group ${groupName || "default"}`,
              );
              return;
            }

            console.log(
              `[IPChange] ${profileName} [${groupName || "default"}] - 프록시 시도 ${attempt}/${maxRetries}: ${newProxy.ip}:${newProxy.port}`,
            );

            // 프록시 설정 변경 + 브라우저 시작 (이미 종료된 상태이므로 stop 불필요)
            logRestart({ profileName, workerIndex: -1, reason: "IP 일괄 변경", category: "IP_CHANGE" });
            incrementStat("IP_CHANGE");
            await browser.startWithNewProxy(newProxy);

            console.log(
              `[IPChange] ${profileName} [${groupName || "default"}] - ✓ IP change completed: ${newProxy.ip}:${newProxy.port}`,
            );
            return; // 성공 시 루프 종료
          } catch (error: any) {
            console.log(
              `[IPChange] ${profileName} [${groupName || "default"}] - ✗ 시도 ${attempt}/${maxRetries} 실패: ${error.message}`,
            );

            if (attempt < maxRetries) {
              await delay(1500);
            }
          }
        }

        // 모든 재시도 실패
        console.log(
          `[IPChange] ${profileName} [${groupName || "default"}] - ${maxRetries}회 모두 실패`,
        );
        browser.updateStatus(
          "error",
          `IP change failed after ${maxRetries} retries`,
        );
      }),
    );
  }

  // 플래그 해제 — worker가 다시 에러 감지 및 복구 가능
  ipChangeInProgress = false;

  const successCount = holders.filter(
    (h) => h.browser.getStatus().status !== "error",
  ).length;
  console.log(
    `[IPChange] IP change completed: ${successCount}/${holders.length} browsers ready`,
  );
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
  ipChangeInProgress = false;

  // 재시작 로거 초기화 (DATA_DIR/logs/restart-YYYY-MM-DD.tsv)
  initRestartLogger(DATA_DIR);

  const browsers = browserManager.getBrowsers();
  const batchSize = browsers.length;

  console.log(
    `\n[Crawler] Starting with ${batchSize} prepared browsers (DDD Pattern)\n`,
  );

  // BrowserHolder 배열 생성 (mutable wrapper — 프로필 재생성 시 참조 교체 가능)
  const holders: BrowserHolder[] = browsers.map((browser) => ({ browser }));

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
      while (!shouldStop()) {
        await delay(60000); // 1분마다
        await browserManager.keepalive();
      }
    })();

    // 모든 Workers 대기
    console.log(`[Crawler] All workers started. Waiting for completion...\n`);
    await Promise.race([
      Promise.all([
        fetcherPromise,
        handlerPromise,
        ...workerPromises,
        keepalivePromise,
      ]),
      new Promise<void>((resolve) => {
        const checkStop = setInterval(() => {
          if (shouldStop()) {
            clearInterval(checkStop);
            resolve();
          }
        }, 1000);
      }),
    ]);
  } finally {
    // ========================================
    // Step 4: 정리
    // ========================================
    // 상태 조회 함수 해제
    unregisterBrowserStatusesGetter();

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
  console.log(
    `[Navigate] ${profileName} - ${waitCondition}: ${Date.now() - navStart}ms`,
  );

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
    console.log(
      `[Navigate] ${profileName} - data wait (${result}): ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`,
    );
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
    console.log(
      `[Navigate] ${profileName} - data wait (${result}): ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`,
    );
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
 * 크롤러 중지 요청
 */
export function stopCrawler(): void {
  if (!isRunning()) {
    console.log("[Crawler] Crawler is not running");
    return;
  }
  requestStop();
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

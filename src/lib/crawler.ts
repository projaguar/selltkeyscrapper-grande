/**
 * Crawler 메인 플로우 (Producer-Consumer Pattern with DDD)
 *
 * 새로운 아키텍처:
 * - BrowserManager: 브라우저 인스턴스 관리 (싱글톤)
 * - CrawlerBrowser: 도메인 객체 (브라우저/프로필 통합 관리)
 * - Producer: Task Fetcher가 백그라운드에서 Task Queue에 추가
 * - Consumer: 각 브라우저 Worker가 독립적으로 Queue에서 Task 가져와 처리
 */

// 타입
import type { CrawlTask, CrawlResult } from "./crawler/types";
export type { CrawlTask, CrawlResult, Session } from "./crawler/types";

// DDD: CrawlerBrowser 도메인 객체
import { CrawlerBrowser } from "./crawler/CrawlerBrowser";

// BrowserManager 싱글톤
import { getBrowserManager } from "./crawler/browser-manager";

// Task Queue Manager
import { TaskQueueManager } from "./crawler/task-queue";

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
  registerTaskQueueStatsGetter,
  unregisterTaskQueueStatsGetter,
  setWaitState,
  clearWaitState,
} from "./crawler/state";

// 모듈
import { fetchTasks, removeCompletedTasks, handleTodayStopResults } from "./crawler/task-manager";
import { crawlNaver } from "./crawler/platforms/naver";
import { crawlAuction } from "./crawler/platforms/auction";
import { getProxyPool } from "./proxy-pool";

// 실제 오류로 분류할 키워드
const ERROR_KEYWORDS = [
  'ECONNREFUSED',
  'timeout',
  'Timeout',
  'ETIMEDOUT',
  'Navigation',
  'Protocol error',
  'Target closed',
  'Session closed',
  'net::ERR_',
  'Browser error',
];

/**
 * 크롤링 결과를 분류하여 상태와 메시지 결정
 */
function classifyResult(
  result: CrawlResult,
  collectedCount: number
): { status: 'success' | 'warning' | 'error'; message: string } {
  // 성공이고 상품이 있으면 success
  if (result.success && collectedCount > 0) {
    return {
      status: 'success',
      message: result.message || `${collectedCount}개 수집`,
    };
  }

  // 성공이지만 상품이 0개면 warning
  if (result.success && collectedCount === 0) {
    return {
      status: 'warning',
      message: '수집상품 없음',
    };
  }

  // 실패인 경우: 에러 메시지로 분류
  const errorMsg = result.error || '';

  // 실제 기술적 오류인지 확인
  const isRealError = ERROR_KEYWORDS.some(keyword => errorMsg.includes(keyword));

  if (isRealError) {
    return {
      status: 'error',
      message: errorMsg,
    };
  }

  // 비즈니스 로직 실패 (해외배송 아님, 상품 없음 등) → warning
  let friendlyMessage = errorMsg;
  if (errorMsg.includes('해외') || errorMsg.includes('overseas')) {
    friendlyMessage = '해외배송 아님';
  } else if (errorMsg.includes('상품') && (errorMsg.includes('없') || errorMsg.includes('0'))) {
    friendlyMessage = '수집상품 없음';
  } else if (errorMsg.includes('empty') || errorMsg.includes('Empty')) {
    friendlyMessage = '수집상품 없음';
  } else if (!errorMsg) {
    friendlyMessage = '수집상품 없음';
  }

  return {
    status: 'warning',
    message: friendlyMessage,
  };
}

// Mutable wrapper: worker가 프로필 재생성 후 새 CrawlerBrowser를 사용할 수 있게 함
interface BrowserHolder {
  browser: CrawlerBrowser;
}

// 브라우저 죽음을 감지하는 에러 패턴
const DEAD_BROWSER_PATTERNS = [
  'Browser not available',
  'No pages available',
  'Browser not started',
  'Target closed',
  'Session closed',
  'Protocol error',
  'Browser process died',
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
  taskQueue: TaskQueueManager
): Promise<void> {
  // 시작 시 Random Delay (0~15초)
  const initialDelayMs = Math.floor(Math.random() * 15000);
  await delay(initialDelayMs);

  let consecutiveDeadErrors = 0;
  const MAX_DEAD_ERRORS = 2;

  while (!shouldStop()) {
    const browser = holder.browser;
    const profileName = browser.getProfileName();

    // 재시작 중이면 대기
    if (browser.getStatus().status === 'restarting') {
      await delay(3000);
      continue;
    }

    // 브라우저 에러 시 자동 복구 시도
    if (browser.hasError()) {
      console.log(`[Worker ${workerIndex}] ${profileName} - 에러 상태 감지, 자동 복구 시도`);
      if (!shouldStop()) {
        await handleBrowserRestart(holder, workerIndex, '브라우저 에러 복구');
      }
      consecutiveDeadErrors = 0;
      // 복구 후 잠시 대기
      await delay(3000);
      continue;
    }

    // Queue에서 Task 가져오기
    const task = taskQueue.getNext();

    // Task 없으면 짧게 대기 후 재시도 (중지 신호 빠르게 반응)
    if (!task) {
      browser.updateStatus('waiting', 'Task 대기 중...');
      for (let i = 0; i < 10 && !shouldStop(); i++) {
        await delay(1000);
      }
      continue;
    }

    // Task 처리 시작
    browser.startCrawling(task.TARGETSTORENAME);

    try {
      // Task 처리
      const result = await processSingleTask(browser, task);

      // 성공 → dead error 카운터 리셋
      consecutiveDeadErrors = 0;

      // 결과 분류 및 상태 업데이트
      const collectedCount = result.data?.list?.length || 0;
      const { status, message } = classifyResult(result, collectedCount);

      browser.completeCrawling(status, message, status === 'success' ? collectedCount : undefined);

      // Queue에 완료 표시
      taskQueue.markComplete(task, result);

      // 성공/실패 카운트 (서버 전송 성공 여부 기준)
      if (result.serverTransmitted) {
        incrementCompleted(1);
      } else {
        incrementSkipped(1);
      }

      // CAPTCHA 감지 시 프로필 재생성 (새 fingerprint + 새 proxy)
      if (result.captchaDetected && !shouldStop()) {
        await handleBrowserRecreation(holder, workerIndex, 'CAPTCHA 감지');
      }

    } catch (error: any) {
      // 예외 발생 시 실패 처리
      const errorMsg = error.message || 'Unknown error';
      taskQueue.markFailed(task, errorMsg);
      browser.completeCrawling('error', errorMsg);
      incrementSkipped(1);

      // 중지 요청 시 재시작 안 함
      if (shouldStop()) break;

      // 브라우저 죽음 감지
      const isDeadBrowser = DEAD_BROWSER_PATTERNS.some(p => errorMsg.includes(p));

      if (isDeadBrowser) {
        consecutiveDeadErrors++;
        console.log(`[Worker ${workerIndex}] ${profileName} - dead browser 감지 (${consecutiveDeadErrors}/${MAX_DEAD_ERRORS})`);

        if (consecutiveDeadErrors >= MAX_DEAD_ERRORS) {
          consecutiveDeadErrors = 0;
          await handleBrowserRestart(holder, workerIndex, '브라우저 프로세스 죽음');
        }
        continue;
      }

      // 네트워크 오류인지 확인
      const NETWORK_ERROR_PATTERNS = [
        "ECONNREFUSED", "net::ERR_", "페이지 로드 실패", "이동 실패",
        "Navigation timeout", "Timeout waiting", "ETIMEDOUT",
        "Cloudflare block detected", "IP change needed",
      ];

      const isNetworkError = NETWORK_ERROR_PATTERNS.some((pattern) =>
        errorMsg.includes(pattern)
      );

      // 네트워크 오류면 브라우저 재시작
      if (isNetworkError) {
        consecutiveDeadErrors = 0;
        await handleBrowserRestart(holder, workerIndex, '네트워크 오류');
      }
    }

    if (shouldStop()) break;

    // Random Delay (8~15초, 중지 신호에 빠르게 반응)
    holder.browser.updateStatus('waiting', `대기 중...`);
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
  reason: string
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
      console.log(`[Worker ${workerIndex}] ${profileName} - 중지 요청으로 재시작 취소`);
      return;
    }

    browser.updateStatus('restarting', `${reason} - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}...`);

    try {
      // 기존 Proxy를 dead로 표시
      const oldProxyId = browser.getProxyId();
      if (oldProxyId) {
        proxyPool.markDead(oldProxyId);
      }

      // 그룹별 새 Proxy 할당
      const newProxy = groupId !== undefined
        ? proxyPool.getNextProxyByGroup(groupId)
        : proxyPool.getNextProxy();

      if (!newProxy) {
        console.log(`[Worker ${workerIndex}] ${profileName} [${groupName || 'default'}] - 프록시 없음`);
        browser.updateStatus('error', `No available proxies in group ${groupName || 'default'}`);
        return;
      }

      console.log(`[Worker ${workerIndex}] ${profileName} [${groupName || 'default'}] - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}: ${newProxy.ip}:${newProxy.port}`);

      // 브라우저 재시작 (새 Proxy로)
      await browser.restart(newProxy);

      // Proxy를 in_use로 표시
      proxyPool.markInUse(newProxy.id);

      console.log(`[Worker ${workerIndex}] ${profileName} [${groupName || 'default'}] - ✓ 재시작 완료: ${newProxy.ip}:${newProxy.port}`);
      return;

    } catch (error: any) {
      console.log(`[Worker ${workerIndex}] ${profileName} [${groupName || 'default'}] - ✗ 프록시 시도 ${proxyAttempt} 실패: ${error.message}`);

      // 재시작 전 잠시 대기 (1.5초)
      await delay(1500);
    }
  }

  // 모든 프록시 시도 실패
  console.log(`[Worker ${workerIndex}] ${profileName} [${groupName || 'default'}] - ${maxProxyRetries}개 프록시 모두 실패`);
  browser.updateStatus('error', `${maxProxyRetries}개 프록시 모두 실패`);
}

/**
 * CAPTCHA 차단 시 프로필 재생성 (새 fingerprint + 새 proxy = 완전한 새 identity)
 * 실패 시 폴백: 프록시만 변경하는 일반 재시작
 */
async function handleBrowserRecreation(
  holder: BrowserHolder,
  workerIndex: number,
  reason: string
): Promise<void> {
  const browserManager = getBrowserManager();
  const proxyPool = getProxyPool();
  const oldBrowser = holder.browser;
  const profileName = oldBrowser.getProfileName();
  const groupId = oldBrowser.getProxyGroupId();
  const groupName = oldBrowser.getProxyGroupName();

  console.log(`[Worker ${workerIndex}] ${profileName} - ${reason}: 프로필 재생성 시작`);
  oldBrowser.updateStatus('restarting', `${reason} - 프로필 재생성 중...`);

  try {
    // 1. 프로필 재생성 (GoLogin: 구 삭제 + 신 생성)
    const newBrowser = await browserManager.recreateProfile(oldBrowser);

    // 2. 새 프록시 할당
    const newProxy = groupId !== undefined
      ? proxyPool.getNextProxyByGroup(groupId)
      : proxyPool.getNextProxy();

    if (!newProxy) {
      console.log(`[Worker ${workerIndex}] ${profileName} - 새 프록시 없음`);
      newBrowser.updateStatus('error', `No available proxies in group ${groupName || 'default'}`);
      holder.browser = newBrowser;
      return;
    }

    // 3. 프록시 설정 + 브라우저 시작
    await newBrowser.updateProxySettings(newProxy);
    proxyPool.markInUse(newProxy.id);

    await newBrowser.start({
      validateProxy: false,
      validateConnection: false,
    });

    // 4. holder 참조 교체 (worker가 새 인스턴스 사용)
    holder.browser = newBrowser;

    console.log(`[Worker ${workerIndex}] ${profileName} - ✓ 프로필 재생성 완료 (${newBrowser.getProfileId()}) proxy: ${newProxy.ip}:${newProxy.port}`);
  } catch (error: any) {
    console.log(`[Worker ${workerIndex}] ${profileName} - ✗ 프로필 재생성 실패: ${error.message}, 프록시만 변경으로 폴백`);
    // 폴백: 기존 프로필로 프록시만 변경
    await handleBrowserRestart(holder, workerIndex, `${reason} (재생성 실패, 프록시 변경)`);
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
 * 4. 5분 휴식 + 모든 브라우저 IP 일괄 변경
 * 5. 반복
 */
async function taskFetcher(
  taskQueue: TaskQueueManager,
  browserManager: ReturnType<typeof getBrowserManager>,
  holders: BrowserHolder[]
): Promise<void> {
  const browserCount = holders.length;

  // 개발 환경(bun run dev)이면 10개로 제한, 프로덕션은 브라우저 개수 × 100
  const limit = process.env.NODE_ENV === 'development'
    ? 10
    : browserCount * 100;

  const proxyPool = getProxyPool();

  while (!shouldStop()) {
    // 매 루프 시작 시 모든 프록시 활성화 (dead → active)
    proxyPool.resetAllProxies();
    console.log(`[TaskFetcher] All proxies reset to active`);

    // 태스크 가져오기
    console.log(`[TaskFetcher] Fetching tasks (limit: ${limit}, env: ${process.env.NODE_ENV || 'production'})...`);
    const tasks = await fetchTasks(limit);

    if (tasks.length === 0) {
      console.log(`[TaskFetcher] No tasks available, waiting 5 minutes...`);
      setWaitState(Date.now() + 5 * 60 * 1000, "Task 조회 대기 중...");
      // 1초 단위로 체크하여 중지 신호에 빠르게 반응
      for (let i = 0; i < 300 && !shouldStop(); i++) {
        await delay(1000);
      }
      clearWaitState();
      continue;
    }

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

    console.log(`[TaskFetcher] All tasks completed. Starting 5-minute break (including IP change)...`);

    const breakStartTime = Date.now();
    const BREAK_DURATION = 5 * 60 * 1000; // 5분
    setWaitState(breakStartTime + BREAK_DURATION, "IP 변경 및 대기 중...");

    // 모든 브라우저 IP 일괄 변경 (죽은 브라우저도 이 과정에서 복구)
    console.log(`[TaskFetcher] Changing IPs for all browsers...`);
    await changeAllBrowserIPs(holders);

    // IP 변경에 걸린 시간을 제외한 나머지 대기
    const ipChangeElapsed = Date.now() - breakStartTime;
    const remainingDelay = Math.max(60 * 1000, BREAK_DURATION - ipChangeElapsed);
    console.log(`[TaskFetcher] IP change took ${Math.round(ipChangeElapsed / 1000)}s. Remaining delay: ${Math.round(remainingDelay / 1000)}s`);

    // progress bar를 남은 대기 시간에 맞게 갱신
    setWaitState(Date.now() + remainingDelay, "다음 작업 대기 중...");
    const remainingSeconds = Math.ceil(remainingDelay / 1000);
    for (let i = 0; i < remainingSeconds && !shouldStop(); i++) {
      await delay(1000);
    }
    clearWaitState();

    console.log(`[TaskFetcher] Break finished. Fetching next batch...`);
  }
}

/**
 * 모든 브라우저의 IP를 일괄 변경 (병렬 처리, concurrency=10)
 * 죽은 브라우저도 이 과정에서 복구됨 (restart가 stop → start 수행)
 */
async function changeAllBrowserIPs(
  holders: BrowserHolder[]
): Promise<void> {
  const proxyPool = getProxyPool();
  const BATCH_SIZE = 10;
  const maxRetries = 5;

  console.log(`[IPChange] Starting IP change for ${holders.length} browsers (batch size: ${BATCH_SIZE}, max retries: ${maxRetries})`);

  for (let batchStart = 0; batchStart < holders.length; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, holders.length);
    const batch = holders.slice(batchStart, batchEnd);

    if (batchStart > 0) {
      console.log(`[IPChange] Waiting 5s before next batch...`);
      await delay(5000);
    }

    console.log(`[IPChange] Processing batch ${batchStart + 1}-${batchEnd}/${holders.length}`);

    await Promise.all(batch.map(async (holder) => {
      const browser = holder.browser;
      const groupId = browser.getProxyGroupId();
      const groupName = browser.getProxyGroupName();
      const profileName = browser.getProfileName();

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (shouldStop()) return;

        try {
          // 기존 Proxy를 dead로 표시
          const oldProxyId = browser.getProxyId();
          if (oldProxyId) {
            proxyPool.markDead(oldProxyId);
          }

          // 그룹별 새 Proxy 할당
          const newProxy = groupId !== undefined
            ? proxyPool.getNextProxyByGroup(groupId)
            : proxyPool.getNextProxy();

          if (!newProxy) {
            console.log(`[IPChange] ${profileName} [${groupName || 'default'}] - No available proxies`);
            browser.updateStatus('error', `No available proxies in group ${groupName || 'default'}`);
            return;
          }

          console.log(`[IPChange] ${profileName} [${groupName || 'default'}] - 프록시 시도 ${attempt}/${maxRetries}: ${newProxy.ip}:${newProxy.port}`);

          // 브라우저 재시작 (새 Proxy로 — 죽은 브라우저도 stop → start로 복구)
          await browser.restart(newProxy);

          // Proxy를 in_use로 표시
          proxyPool.markInUse(newProxy.id);

          console.log(`[IPChange] ${profileName} [${groupName || 'default'}] - ✓ IP change completed: ${newProxy.ip}:${newProxy.port}`);
          return; // 성공 시 루프 종료

        } catch (error: any) {
          console.log(`[IPChange] ${profileName} [${groupName || 'default'}] - ✗ 시도 ${attempt}/${maxRetries} 실패: ${error.message}`);

          if (attempt < maxRetries) {
            await delay(1500);
          }
        }
      }

      // 모든 재시도 실패
      console.log(`[IPChange] ${profileName} [${groupName || 'default'}] - ${maxRetries}회 모두 실패`);
      browser.updateStatus('error', `IP change failed after ${maxRetries} retries`);
    }));
  }

  const successCount = holders.filter(h => h.browser.getStatus().status !== 'error').length;
  console.log(`[IPChange] IP change completed: ${successCount}/${holders.length} browsers ready`);
}

/**
 * =====================================================
 * Result Handler (백그라운드 결과 처리)
 * =====================================================
 * 완료된 Task들을 주기적으로 처리 (todayStop, cleanup 등)
 */
async function resultHandler(
  taskQueue: TaskQueueManager
): Promise<void> {
  while (!shouldStop()) {
    // 10초마다 완료/실패 Task 처리
    await delay(10000);

    // 완료된 Tasks 가져오기
    const completedTasks = taskQueue.getCompletedTasks();
    if (completedTasks.length > 0) {
      const tasks = completedTasks.map(ct => ct.task);
      const results = completedTasks.map(ct => ct.result);

      removeCompletedTasks(tasks);
      handleTodayStopResults(results, tasks);
    }

    // 실패한 Tasks도 정리
    const failedTasks = taskQueue.getFailedTasks();
    if (failedTasks.length > 0) {
      const tasks = failedTasks.map(ft => ft.task);
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

  const browsers = browserManager.getBrowsers();
  const batchSize = browsers.length;

  console.log(`\n[Crawler] Starting with ${batchSize} prepared browsers (DDD Pattern)\n`);

  // BrowserHolder 배열 생성 (mutable wrapper — 프로필 재생성 시 참조 교체 가능)
  const holders: BrowserHolder[] = browsers.map(browser => ({ browser }));

  // ========================================
  // Step 1: Task Queue Manager 생성
  // ========================================
  const taskQueue = new TaskQueueManager();

  // ========================================
  // Step 2: 상태 조회 함수 등록 (UI용)
  // ========================================
  registerBrowserStatusesGetter(() =>
    holders.map(h => h.browser.getStatus())
  );
  registerTaskQueueStatsGetter(() => ({
    completedCount: taskQueue.completedCount(),
    failedCount: taskQueue.failedCount(),
  }));

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
      browserWorker(holder, index, taskQueue)
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
      Promise.all([fetcherPromise, handlerPromise, ...workerPromises, keepalivePromise]),
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
    unregisterTaskQueueStatsGetter();

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
  _sessions: any[]
): Promise<CrawlResult[]> {
  console.warn('[Crawler] processBatch() is deprecated. Use startCrawling() instead.');
  return startCrawling();
}

/**
 * =====================================================
 * 단일 Task 처리 (DDD 패턴 적용)
 * =====================================================
 */
async function processSingleTask(
  browser: CrawlerBrowser,
  task: CrawlTask
): Promise<CrawlResult> {
  const profileName = browser.getProfileName();

  if (!browser.hasBrowser()) {
    throw new Error("Browser not available");
  }

  // 플랫폼별 이미지 차단 설정 (실시간 적용, reload 불필요)
  if (task.URLPLATFORMS === "NAVER") {
    browser.setImageBlocking(true);  // 네이버: 이미지 차단 (성능 최적화)
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
  task: CrawlTask
): Promise<any> {
  const page = await browser.getPage();
  const currentUrl = await browser.getCurrentUrl();

  // Base URL로 이동 (필요시)
  if (task.URLPLATFORMS === "NAVER" && !currentUrl.includes("naver.com")) {
    await page.goto("https://www.naver.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
      throw new Error("naver.com 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("naver.com")) {
      throw new Error(`naver.com 이동 실패: ${afterGotoUrl}`);
    }

    // DOM 파싱 완료 후 나머지 리소스 로딩 중단
    await page.evaluate(() => window.stop());

    const randomDelay = Math.floor(Math.random() * 6000) + 2000;
    await delay(randomDelay);
  } else if (task.URLPLATFORMS === "AUCTION" && !currentUrl.includes("auction.co.kr")) {
    await page.goto("https://www.auction.co.kr/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
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
async function navigateToTarget(
  page: any,
  task: CrawlTask,
  profileName: string
): Promise<void> {

  // DOM에 링크 삽입
  const uniqueId = `crawler-link-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  const linkCreated = await page.evaluate(
    (url: string, linkId: string) => {
      try {
        // 기존 링크 제거
        const oldLinks = document.querySelectorAll('[data-crawler-link="true"]');
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
    uniqueId
  );

  if (!linkCreated) {
    throw new Error("Failed to create navigation link");
  }

  // 클릭 전 랜덤 대기 (0~3초)
  const preClickDelay = Math.floor(Math.random() * 3000);
  await delay(preClickDelay);

  // 클릭 및 네비게이션 대기
  const navStart = Date.now();
  const navigationPromise = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.click(`#${uniqueId}`, {
    delay: Math.floor(Math.random() * 50) + 30,
  });

  await navigationPromise;
  console.log(`[Navigate] ${profileName} - domcontentloaded: ${Date.now() - navStart}ms`);

  // URL 검증
  const finalUrl = page.url();

  // Chrome 에러 페이지 체크
  if (finalUrl.startsWith("chrome-error://") || finalUrl === "about:blank") {
    throw new Error(`페이지 로드 실패 (네트워크/프록시 오류)`);
  }

  const expectedDomain = task.URLPLATFORMS === "NAVER" ? "naver.com" : "auction.co.kr";

  if (!finalUrl.includes(expectedDomain)) {
    throw new Error(`Wrong domain! Expected ${expectedDomain}, got: ${finalUrl}`);
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
        const hasBlock = !!(window as any)._cf_chl_opt ||
          (document.title === "잠시만요..." || document.title === "Just a moment...") ||
          (document.body?.textContent || "").includes("사용자 활동 검토 요청");
        if (hasData) return "data";
        if (hasBlock) return "blocked";
        return false;
      },
      { timeout: 30000 }
    );
    const result = await waitResult.jsonValue();
    console.log(`[Navigate] ${profileName} - data wait (${result}): ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`);
    if (result === "blocked") {
      throw new Error("Cloudflare block detected - IP change needed");
    }
  } else if (task.URLPLATFORMS === "NAVER") {
    // Naver: window.__PRELOADED_STATE__ 존재 확인
    await page.waitForFunction(
      () => !!(window as any).__PRELOADED_STATE__,
      { timeout: 30000 }
    );
    console.log(`[Navigate] ${profileName} - data wait: ${Date.now() - dataWaitStart}ms | total: ${Date.now() - navStart}ms`);
  }

  // 나머지 리소스 로딩 중단 (이미지, 광고, 트래킹 등)
  await page.evaluate(() => window.stop());
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

/**
 * Crawler 메인 플로우 (Producer-Consumer Pattern with DDD)
 *
 * 새로운 아키텍처:
 * - CrawlerBrowser: 도메인 객체 (브라우저/프로필 통합 관리)
 * - Producer: Task Fetcher가 백그라운드에서 Task Queue에 추가
 * - Consumer: 각 브라우저 Worker가 독립적으로 Queue에서 Task 가져와 처리
 */

// 타입
import type { CrawlTask, CrawlResult, Session } from "./crawler/types";
export type { CrawlTask, CrawlResult, Session } from "./crawler/types";

// DDD: CrawlerBrowser 도메인 객체
import { CrawlerBrowser } from "./crawler/CrawlerBrowser";

// Task Queue Manager
import { TaskQueueManager } from "./crawler/task-queue";

// 상태 관리 (UI용)
import {
  shouldStop,
  requestStop,
  isRunning,
  setRunning,
  resetProgress,
  incrementCompleted,
  incrementSkipped,
  registerBrowserStatusesGetter,
  unregisterBrowserStatusesGetter,
} from "./crawler/state";

// 모듈
import { fetchTasks, removeCompletedTasks, handleTodayStopResults } from "./crawler/task-manager";
import { crawlNaver } from "./crawler/platforms/naver";
import { crawlAuction } from "./crawler/platforms/auction";
import { getProxyPool } from "./proxy-pool";

// 10분 대기 시간 (ms)
const EMPTY_QUEUE_DELAY = 10 * 60 * 1000;

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

/**
 * =====================================================
 * Browser Worker (Consumer) - DDD 패턴 적용
 * =====================================================
 * 각 브라우저가 독립적으로 Task Queue에서 Task를 가져와 처리
 */
async function browserWorker(
  browser: CrawlerBrowser,
  workerIndex: number,
  taskQueue: TaskQueueManager
): Promise<void> {
  const profileName = browser.getProfileName();

  // 시작 시 Random Delay (0~15초)
  const initialDelayMs = Math.floor(Math.random() * 15000);
  await delay(initialDelayMs);

  while (!shouldStop()) {
    // Queue에서 Task 가져오기
    const task = taskQueue.getNext();

    // Task 없으면 10초 대기 후 재시도
    if (!task) {
      browser.updateStatus('waiting', 'Task 대기 중...');
      await delay(10000);
      continue;
    }

    // 브라우저 에러 시 Task 실패 처리
    if (browser.hasError()) {
      const errorMsg = browser.getStatus().error || 'Browser error';
      taskQueue.markFailed(task, errorMsg);
      browser.updateStatus('error', errorMsg);
      continue;
    }

    // Task 처리 시작
    browser.startCrawling(task.TARGETSTORENAME);

    try {
      // Task 처리
      const result = await processSingleTask(browser, task);

      // 결과 분류 및 상태 업데이트
      const collectedCount = result.data?.list?.length || 0;
      const { status, message } = classifyResult(result, collectedCount);

      browser.completeCrawling(status, message, status === 'success' ? collectedCount : undefined);

      // Queue에 완료 표시
      taskQueue.markComplete(task, result);

      // 성공/실패 카운트
      if (result.success) {
        incrementCompleted(1);
      } else {
        incrementSkipped(1);
      }

      // CAPTCHA 감지 시 재시작
      if (result.captchaDetected) {
        await handleBrowserRestart(browser, workerIndex, 'CAPTCHA 감지');
      }

    } catch (error: any) {
      // 예외 발생 시 실패 처리
      const errorMsg = error.message || 'Unknown error';
      taskQueue.markFailed(task, errorMsg);
      browser.completeCrawling('error', errorMsg);
      incrementSkipped(1);

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
        await handleBrowserRestart(browser, workerIndex, '네트워크 오류');
      }
    }

    // Random Delay (8~15초)
    const randomDelayMs = Math.floor(Math.random() * 7000) + 8000;

    browser.updateStatus('waiting', `대기 중...`);
    await delay(randomDelayMs);
  }
}

/**
 * 브라우저 재시작 처리 (DDD 패턴)
 * - 새 프록시로 시작 시도
 * - 실패하면 다른 프록시로 재시도 (최대 10회 - 초기 시작과 동일)
 */
async function handleBrowserRestart(
  browser: CrawlerBrowser,
  workerIndex: number,
  reason: string
): Promise<void> {
  const maxProxyRetries = 10;
  const proxyPool = getProxyPool();
  const profileName = browser.getProfileName();

  for (let proxyAttempt = 1; proxyAttempt <= maxProxyRetries; proxyAttempt++) {
    browser.updateStatus('restarting', `${reason} - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}...`);

    try {
      // 기존 Proxy를 dead로 표시
      const oldProxyId = browser.getProxyId();
      if (oldProxyId) {
        proxyPool.markDead(oldProxyId);
      }

      // 새 Proxy 할당
      const newProxy = proxyPool.getNextProxy();
      if (!newProxy) {
        console.log(`[Worker ${workerIndex}] ${profileName} - 프록시 없음`);
        browser.updateStatus('error', 'No available proxies');
        return;
      }

      console.log(`[Worker ${workerIndex}] ${profileName} - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}: ${newProxy.ip}:${newProxy.port}`);

      // 브라우저 재시작 (새 Proxy로)
      await browser.restart(newProxy, 2);

      // Proxy를 in_use로 표시
      proxyPool.markInUse(newProxy.id);

      console.log(`[Worker ${workerIndex}] ${profileName} - ✓ 재시작 완료: ${newProxy.ip}:${newProxy.port}`);
      return;

    } catch (error: any) {
      console.log(`[Worker ${workerIndex}] ${profileName} - ✗ 프록시 시도 ${proxyAttempt} 실패: ${error.message}`);

      if (proxyAttempt < maxProxyRetries) {
        await delay(3000);
      }
    }
  }

  // 모든 프록시 시도 실패
  console.log(`[Worker ${workerIndex}] ${profileName} - ${maxProxyRetries}개 프록시 모두 실패`);
  browser.updateStatus('error', `${maxProxyRetries}개 프록시 모두 실패`);
}

/**
 * =====================================================
 * Task Fetcher (Producer)
 * =====================================================
 * 백그라운드에서 주기적으로 Task를 가져와 Queue에 추가
 */
async function taskFetcher(
  taskQueue: TaskQueueManager,
  batchSize: number
): Promise<void> {
  while (!shouldStop()) {
    // Queue에 충분한 Task가 있으면 대기
    if (taskQueue.size() >= batchSize) {
      await delay(5000);
      continue;
    }

    // Task 가져오기
    const tasks = await fetchTasks(batchSize);

    if (tasks.length === 0) {
      console.log(`[TaskFetcher] Task 없음, 10분 대기...`);
      await delay(EMPTY_QUEUE_DELAY);
      continue;
    }

    // Queue에 추가
    taskQueue.addTasks(tasks);
    await delay(2000);
  }
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
 * =====================================================
 */
export async function processBatch(
  apiKey: string,
  sessions: Session[]
): Promise<CrawlResult[]> {
  // 이미 실행 중이면 에러
  if (isRunning()) {
    throw new Error("Crawler is already running. Stop it first.");
  }

  // 크롤러 상태 설정
  setRunning(true);
  resetProgress();

  const batchSize = sessions.length;

  console.log(`\n[Crawler] Starting with ${batchSize} browser workers (DDD Pattern)\n`);

  // ========================================
  // Step 1: CrawlerBrowser 도메인 객체 생성
  // ========================================
  const browsers: CrawlerBrowser[] = [];
  const proxyPool = getProxyPool();

  for (const session of sessions) {
    const proxy = session.proxyId ? proxyPool.getProxyById(session.proxyId) : undefined;

    const browser = new CrawlerBrowser({
      profileId: session.profileId,
      profileName: session.profileName,
      apiKey,
      proxy,
    });

    browsers.push(browser);
  }

  // ========================================
  // Step 2: 모든 브라우저 시작 (새 프록시로 재시도)
  // ========================================
  console.log(`[Crawler] Starting ${browsers.length} browsers...\n`);

  const maxProxyRetries = 10;

  for (let i = 0; i < browsers.length; i++) {
    const browser = browsers[i];
    let started = false;

    for (let proxyAttempt = 1; proxyAttempt <= maxProxyRetries; proxyAttempt++) {
      try {
        // 실패 시 새 프록시 할당 (첫 시도 제외)
        if (proxyAttempt > 1) {
          const oldProxyId = browser.getProxyId();
          if (oldProxyId) {
            proxyPool.markDead(oldProxyId);
          }

          const newProxy = proxyPool.getNextProxy();
          if (!newProxy) {
            console.log(`[Crawler] Browser ${browser.getProfileName()} - No available proxies`);
            break;
          }

          await browser.updateProxySettings(newProxy);
          proxyPool.markInUse(newProxy.id);
        }

        console.log(`[Crawler] Browser ${i + 1}/${browsers.length} (${browser.getProfileName()}) - 프록시 시도 ${proxyAttempt}/${maxProxyRetries}`);

        await browser.start({ validateProxy: true, validateConnection: false });

        console.log(`[Crawler] Browser ${i + 1}/${browsers.length} ✓ ${browser.getProfileName()} 시작 완료`);
        started = true;
        break;
      } catch (error: any) {
        console.log(`[Crawler] Browser ${browser.getProfileName()} - 프록시 시도 ${proxyAttempt} 실패: ${error.message}`);

        // 브라우저 종료
        try {
          await browser.stop();
        } catch (stopErr) {
          // 무시
        }

        if (proxyAttempt < maxProxyRetries) {
          await delay(3000);
        }
      }
    }

    if (!started) {
      console.log(`[Crawler] Browser ${browser.getProfileName()} - ${maxProxyRetries}개 프록시 모두 실패`);
    }
  }

  // ========================================
  // Step 3: Task Queue Manager 생성
  // ========================================
  const taskQueue = new TaskQueueManager();

  // ========================================
  // Step 4: 브라우저 상태 조회 함수 등록 (UI용)
  // ========================================
  registerBrowserStatusesGetter(() => browsers.map(b => b.getStatus()));

  try {
    // ========================================
    // Step 5: Workers 시작
    // ========================================

    // Task Fetcher (Producer) 시작
    const fetcherPromise = taskFetcher(taskQueue, batchSize);

    // Result Handler 시작
    const handlerPromise = resultHandler(taskQueue);

    // Browser Workers (Consumers) 시작
    const workerPromises = browsers.map((browser, index) =>
      browserWorker(browser, index, taskQueue)
    );

    // Keepalive 주기적으로 실행
    const keepalivePromise = (async () => {
      while (!shouldStop()) {
        await delay(60000); // 1분마다
        for (const browser of browsers) {
          await browser.keepalive();
        }
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
    // Step 6: 정리
    // ========================================
    // 브라우저 상태 조회 함수 해제
    unregisterBrowserStatusesGetter();

    // 브라우저는 닫지 않음 (다음 준비 시 재연결 가능)
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
      timeout: 60000,
    });

    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
      throw new Error("naver.com 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("naver.com")) {
      throw new Error(`naver.com 이동 실패: ${afterGotoUrl}`);
    }

    const randomDelay = Math.floor(Math.random() * 6000) + 2000;
    await delay(randomDelay);
  } else if (task.URLPLATFORMS === "AUCTION" && !currentUrl.includes("auction.co.kr")) {
    await page.goto("https://www.auction.co.kr/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
      throw new Error("auction.co.kr 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("auction.co.kr")) {
      throw new Error(`auction.co.kr 이동 실패: ${afterGotoUrl}`);
    }

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

  // 클릭 전 랜덤 대기 (0~5초)
  const preClickDelay = Math.floor(Math.random() * 5000);
  await delay(preClickDelay);

  // 클릭 및 네비게이션 대기
  const navigationPromise = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.click(`#${uniqueId}`, {
    delay: Math.floor(Math.random() * 50) + 30,
  });

  await navigationPromise;

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

  // DOM 완전 로드 대기
  await page.waitForFunction(() => document.readyState === "complete", {
    timeout: 60000,
  });
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
 * Task 큐에 새로운 tasks 추가 (외부 API용)
 * @deprecated DDD 리팩토링 후 TaskFetcher가 자동으로 Task를 관리합니다.
 */
export function addTasks(_tasks: CrawlTask[]): void {
  // Note: DDD 리팩토링 후 TaskQueueManager 사용
  // Tasks are now managed internally by TaskFetcher
  console.warn('[Crawler] addTasks() is deprecated. Tasks are managed internally by TaskFetcher.');
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

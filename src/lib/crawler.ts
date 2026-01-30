/**
 * Crawler 메인 플로우
 *
 * workflow.txt 기반:
 * - Profile 갯수에 맞춰 Browser 준비
 * - Loop Start
 *   - Task List 가져오기 (n개)
 *   - Task 없으면 10분간 Delay → continue
 *   - Task 병렬 처리
 *   - delay (8~15초) - 페이지 로드 후 적용
 *   - 완료/실패 Task 처리
 *   - today stop user 처리
 *   - block 브라우저 처리
 * - Loop End
 */

import puppeteer from "puppeteer-core";

// 타입
import type { CrawlTask, CrawlResult, BrowserInfo, Session } from "./crawler/types";
export type { CrawlTask, CrawlResult, Session } from "./crawler/types";

// 상태 관리
import {
  shouldStop,
  requestStop,
  isRunning,
  setRunning,
  addTasksToQueue,
  getBlockedUserCount,
  getTaskQueueSize,
  resetProgress,
  incrementCompleted,
  incrementSkipped,
  setCurrentBatch,
  initBrowserStatuses,
  updateBrowserStatus,
  startBatchDelay,
  endBatchDelay,
} from "./crawler/state";

// 모듈
import { initializeBrowsers, keepaliveBrowsers } from "./crawler/browser-manager";
import { fetchTasks, removeCompletedTasks, handleTodayStopResults } from "./crawler/task-manager";
import { handleCaptchaDetected } from "./crawler/handlers/captcha";
import { handleDisconnected } from "./crawler/handlers/reconnect";
import { crawlNaver } from "./crawler/platforms/naver";
import { crawlAuction } from "./crawler/platforms/auction";

// 10분 대기 시간 (ms)
const EMPTY_QUEUE_DELAY = 10 * 60 * 1000;

// 실제 오류로 분류할 키워드 (이 키워드가 포함되면 error, 아니면 warning)
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
  // 메시지를 더 친절하게 변환
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
 * 메인 배치 크롤링
 * =====================================================
 */
export async function processBatch(
  apiKey: string,
  sessions: Session[],
  insertUrl?: string
): Promise<CrawlResult[]> {
  // 이미 실행 중이면 에러
  if (isRunning()) {
    throw new Error("Crawler is already running. Stop it first.");
  }

  // 크롤러 상태 설정
  setRunning(true);
  resetProgress(); // 진행 상태 초기화

  const batchSize = sessions.length;
  const results: CrawlResult[] = [];
  const insertUrlRef = { current: insertUrl || "" };

  console.log(`\n[Crawler] Starting with ${batchSize} browsers\n`);

  // ========================================
  // Step 1: 브라우저 준비
  // ========================================
  const browsers = await initializeBrowsers(apiKey, sessions);

  // 브라우저 상태 초기화
  initBrowserStatuses(
    sessions.map((s, index) => ({ index, profileName: s.profileName }))
  );

  try {
    // ========================================
    // Step 2: 메인 루프
    // ========================================
    let batchNumber = 0;

    while (!shouldStop()) {
      // Task List 가져오기
      const batchTasks = await fetchTasks(batchSize, insertUrlRef);

      // Task 없으면 10분 대기
      if (batchTasks.length === 0) {
        console.log(`[Crawler] No tasks available, waiting 10 minutes...`);
        await delay(EMPTY_QUEUE_DELAY);
        continue;
      }

      batchNumber++;
      setCurrentBatch(batchNumber);
      // Note: totalTasks는 task-manager.ts에서 서버 조회 시 이미 증가됨

      console.log(
        `[Crawler] Batch ${batchNumber}: ${batchTasks.length} tasks (queue: ${getTaskQueueSize()}, blocked: ${getBlockedUserCount()})`
      );

      // Task 병렬 처리
      const batchResults = await processTasksInParallel(
        apiKey,
        browsers,
        batchTasks,
        insertUrlRef.current
      );

      results.push(...batchResults);

      // 성공/실패 분류하여 카운트
      const successCount = batchResults.filter(r => r.success).length;
      const skippedCount = batchResults.length - successCount;
      incrementCompleted(successCount);
      incrementSkipped(skippedCount);

      // 배치 완료 후 8~15초 랜덤 대기 (봇 감지 회피)
      const batchDelayMs = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
      console.log(`[Crawler] Batch delay: ${(batchDelayMs / 1000).toFixed(1)}s`);
      startBatchDelay(batchDelayMs);
      await delay(batchDelayMs);
      endBatchDelay();

      // 완료된 Task 제거
      removeCompletedTasks(batchTasks);

      // todayStop 처리
      handleTodayStopResults(batchResults, batchTasks);

      // CAPTCHA 처리
      await handleCaptchaDetected(apiKey, batchResults, batchTasks, sessions, browsers);

      // 연결 끊김 복구
      await handleDisconnected(apiKey, batchResults, batchTasks, sessions, browsers);

      // WebSocket Keepalive
      await keepaliveBrowsers(browsers);

      console.log(`[Crawler] Batch ${batchNumber} completed\n`);
    }
  } finally {
    // ========================================
    // Step 3: 정리
    // ========================================
    // 브라우저는 닫지 않음 (다음 준비 시 재연결 가능)
    // await cleanupBrowsers(apiKey, browsers);
    setRunning(false);
    console.log(`\n[Crawler] Finished. Total results: ${results.length}\n`);
  }

  return results;
}

/**
 * =====================================================
 * Task 병렬 처리
 * =====================================================
 */
async function processTasksInParallel(
  _apiKey: string,
  browsers: BrowserInfo[],
  tasks: CrawlTask[],
  insertUrl: string
): Promise<CrawlResult[]> {
  const promises = tasks.map((task, index) => {
    const browserInfo = browsers[index];

    // 브라우저 에러 시 즉시 반환
    if (browserInfo.error) {
      updateBrowserStatus(index, {
        status: 'error',
        storeName: task.TARGETSTORENAME,
        message: `Browser error: ${browserInfo.error}`,
      });
      return Promise.resolve({
        success: false,
        urlNum: task.URLNUM,
        storeName: task.TARGETSTORENAME,
        error: `Browser error: ${browserInfo.error}`,
      } as CrawlResult);
    }

    // 크롤링 시작 상태 업데이트
    updateBrowserStatus(index, {
      status: 'crawling',
      storeName: task.TARGETSTORENAME,
      message: '크롤링 중...',
    });

    // 단일 Task 처리
    return processSingleTask(browserInfo, task, insertUrl)
      .then((result) => {
        // 결과에 따라 상태 업데이트
        const collectedCount = result.data?.list?.length || 0;
        const { status, message } = classifyResult(result, collectedCount);

        updateBrowserStatus(index, {
          status,
          storeName: task.TARGETSTORENAME,
          message,
          collectedCount: status === 'success' ? collectedCount : undefined,
        });
        return result;
      })
      .catch((error) => {
        // 실제 예외는 error로 표시
        updateBrowserStatus(index, {
          status: 'error',
          storeName: task.TARGETSTORENAME,
          message: error.message,
        });
        return {
          success: false,
          urlNum: task.URLNUM,
          storeName: task.TARGETSTORENAME,
          error: error.message,
        } as CrawlResult;
      });
  });

  return Promise.all(promises);
}

/**
 * =====================================================
 * 단일 Task 처리
 * =====================================================
 */
async function processSingleTask(
  browserInfo: BrowserInfo,
  task: CrawlTask,
  insertUrl: string
): Promise<CrawlResult> {
  const { session, browserData } = browserInfo;
  const profileName = session.profileName;

  console.log(
    `[Crawler] ${profileName} - Processing ${task.TARGETSTORENAME} (${task.URLPLATFORMS})`
  );

  // Puppeteer 연결
  const wsUrl = browserData?.ws?.puppeteer;
  if (!wsUrl) {
    throw new Error("WebSocket URL not found");
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: wsUrl,
    defaultViewport: null,
  });

  try {
    // 페이지 준비
    const page = await preparePage(browser, task, profileName);

    // 페이지 이동
    await navigateToTarget(page, task, profileName);

    // 플랫폼별 크롤링
    if (task.URLPLATFORMS === "NAVER") {
      return await crawlNaver(page, task, insertUrl, profileName);
    } else if (task.URLPLATFORMS === "AUCTION") {
      return await crawlAuction(page, task, insertUrl, profileName);
    } else {
      return {
        success: true,
        urlNum: task.URLNUM,
        storeName: task.TARGETSTORENAME,
        message: "Crawl completed",
      };
    }
  } finally {
    await browser.disconnect();
  }
}

/**
 * =====================================================
 * 페이지 준비 (탭 정리)
 * =====================================================
 */
async function preparePage(
  browser: any,
  task: CrawlTask,
  profileName: string
): Promise<any> {
  const pages = await browser.pages();

  if (pages.length === 0) {
    throw new Error("No pages available");
  }

  // 첫 번째 탭만 사용, 나머지 닫기
  if (pages.length > 1) {
    console.log(`[Crawler] ${profileName} - Closing ${pages.length - 1} extra tabs...`);
    for (let i = 1; i < pages.length; i++) {
      try {
        await pages[i].close();
      } catch {
        // 무시
      }
    }
  }

  const page = pages[0];
  const currentUrl = page.url();
  console.log(`[Crawler] ${profileName} - Current URL: ${currentUrl}`);

  // Base URL로 이동 (필요시)
  if (task.URLPLATFORMS === "NAVER" && !currentUrl.includes("naver.com")) {
    console.log(`[Crawler] ${profileName} - Navigating to naver.com...`);
    await page.goto("https://www.naver.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // goto 후 URL 검증
    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
      throw new Error("naver.com 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("naver.com")) {
      throw new Error(`naver.com 이동 실패: ${afterGotoUrl}`);
    }

    await delay(2000);
  } else if (task.URLPLATFORMS === "AUCTION" && !currentUrl.includes("auction.co.kr")) {
    console.log(`[Crawler] ${profileName} - Navigating to auction.co.kr...`);
    await page.goto("https://www.auction.co.kr/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // goto 후 URL 검증
    const afterGotoUrl = page.url();
    if (afterGotoUrl.startsWith("chrome-error://") || afterGotoUrl === "about:blank") {
      throw new Error("auction.co.kr 이동 실패 (네트워크/프록시 오류)");
    }
    if (!afterGotoUrl.includes("auction.co.kr")) {
      throw new Error(`auction.co.kr 이동 실패: ${afterGotoUrl}`);
    }

    await delay(2000);
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
  console.log(`[Crawler] ${profileName} - Navigating to: ${task.TARGETURL}`);

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

  // 클릭 전 랜덤 대기 (0~5초) - 모든 브라우저가 동시에 클릭하지 않도록 시차 분산
  const preClickDelay = Math.floor(Math.random() * 5000);
  await new Promise((resolve) => setTimeout(resolve, preClickDelay));

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

  // Chrome 에러 페이지 체크 (네트워크 에러, 프록시 실패 등)
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
    timeout: 30000,
  });

  console.log(`[Crawler] ${profileName} - Page loaded: ${finalUrl}`);
}

/**
 * =====================================================
 * 유틸리티
 * =====================================================
 */
function delay(ms: number): Promise<void> {
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
 * Task 큐에 새로운 tasks 추가
 */
export function addTasks(tasks: CrawlTask[]): void {
  addTasksToQueue(tasks);
}

/**
 * 크롤러 현재 상태 조회 (기본)
 */
export function getCrawlerStatus(): {
  isRunning: boolean;
  queueSize: number;
  blockedUserCount: number;
} {
  return {
    isRunning: isRunning(),
    queueSize: getTaskQueueSize(),
    blockedUserCount: getBlockedUserCount(),
  };
}

/**
 * 크롤러 진행 상태 조회 (상세)
 */
export { getCrawlerProgress } from "./crawler/state";

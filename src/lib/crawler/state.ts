/**
 * Crawler 상태 관리
 */

import type { CrawlTask } from "./types";

// 오늘 처리 횟수가 초과된 USERNUM 목록 (메모리 기반)
let blockedDate = new Date().toDateString();
const blockedUserNums = new Set<number>();

// 크롤러 제어를 위한 전역 변수
const taskQueue: CrawlTask[] = [];
let shouldStopCrawler = false;
let isCrawlerRunning = false;
let crawlerStartTime: number | null = null;

// 크롤링 진행 상태
let totalTasksCount = 0;
let completedTasksCount = 0;
let skippedTasksCount = 0;  // 오류/CAPTCHA로 스킵된 Task 수
let currentBatchNumber = 0;

// 브라우저별 상태 추적
export type BrowserStatus =
  | 'idle'           // 대기 중
  | 'crawling'       // 크롤링 중
  | 'success'        // 성공
  | 'warning'        // 경고 (상품 없음, 해외배송 아님 등)
  | 'error'          // 오류 (실제 예외)
  | 'waiting'        // 배치 대기
  | 'recreating'     // CAPTCHA로 프로필 재생성 중
  | 'reconnecting';  // 연결 끊김 복구 중

export interface BrowserStatusInfo {
  browserIndex: number;
  profileName: string;
  status: BrowserStatus;
  storeName?: string;
  message?: string;
  collectedCount?: number;
}

const browserStatuses: Map<number, BrowserStatusInfo> = new Map();

// 배치 대기 상태
let batchDelayInfo = {
  isDelaying: false,
  totalMs: 0,
  startTime: 0,
};

/**
 * 날짜가 바뀌었으면 블록 목록 초기화
 */
export function checkAndResetIfNewDay(): void {
  const today = new Date().toDateString();
  if (today !== blockedDate) {
    const previousSize = blockedUserNums.size;
    blockedUserNums.clear();
    blockedDate = today;
    console.log(
      `[Crawler] New day detected, cleared ${previousSize} blocked USERNUMs`
    );
  }
}

/**
 * 블록된 USERNUM 추가
 */
export function addBlockedUser(usernum: number): void {
  blockedUserNums.add(usernum);
  console.log(`[Crawler] USERNUM ${usernum} added to blocked list (todayStop)`);
}

/**
 * USERNUM이 블록되었는지 확인
 */
export function isUserBlocked(usernum: number): boolean {
  return blockedUserNums.has(usernum);
}

/**
 * 블록된 USERNUM 수 반환
 */
export function getBlockedUserCount(): number {
  return blockedUserNums.size;
}

/**
 * Task 큐 가져오기 (읽기 전용)
 */
export function getTaskQueue(): CrawlTask[] {
  return taskQueue;
}

/**
 * Task 큐 크기 반환
 */
export function getTaskQueueSize(): number {
  return taskQueue.length;
}

/**
 * Task 큐에 tasks 추가
 */
export function addTasksToQueue(tasks: CrawlTask[]): void {
  const beforeSize = taskQueue.length;
  taskQueue.push(...tasks);
  console.log(
    `[Crawler] Added ${tasks.length} tasks to queue (${beforeSize} → ${taskQueue.length})`
  );
}

/**
 * Task 큐 초기화
 */
export function clearTaskQueue(): void {
  taskQueue.length = 0;
}

/**
 * Task 큐에서 특정 task 제거
 */
export function removeTaskFromQueue(urlNum: number): void {
  const index = taskQueue.findIndex((t) => t.URLNUM === urlNum);
  if (index !== -1) {
    taskQueue.splice(index, 1);
  }
}

/**
 * 크롤러 중지 여부 확인
 */
export function shouldStop(): boolean {
  return shouldStopCrawler;
}

/**
 * 크롤러 중지 요청
 */
export function requestStop(): void {
  console.log("[Crawler] Stop requested, will stop after current batch...");
  shouldStopCrawler = true;
}

/**
 * 크롤러 실행 중 여부 확인
 */
export function isRunning(): boolean {
  return isCrawlerRunning;
}

/**
 * 크롤러 시작 상태 설정
 */
export function setRunning(running: boolean): void {
  isCrawlerRunning = running;
  if (running) {
    shouldStopCrawler = false;
    crawlerStartTime = Date.now();
  } else {
    crawlerStartTime = null;
  }
}

/**
 * 크롤러 시작 시간 반환
 */
export function getStartTime(): number | null {
  return crawlerStartTime;
}

/**
 * 경과 시간 반환 (ms)
 */
export function getElapsedTime(): number {
  return crawlerStartTime ? Date.now() - crawlerStartTime : 0;
}

// =====================================================
// 크롤링 진행 상태 관리
// =====================================================

/**
 * 진행 상태 초기화 (크롤링 시작 시)
 */
export function resetProgress(): void {
  totalTasksCount = 0;
  completedTasksCount = 0;
  skippedTasksCount = 0;
  currentBatchNumber = 0;
  browserStatuses.clear();
  batchDelayInfo = { isDelaying: false, totalMs: 0, startTime: 0 };
}

/**
 * 전체 Task 수 설정
 */
export function setTotalTasks(count: number): void {
  totalTasksCount = count;
}

/**
 * 전체 Task 수에 추가
 */
export function addToTotalTasks(count: number): void {
  totalTasksCount += count;
}

/**
 * 완료된 Task 수 증가
 */
export function incrementCompleted(count: number = 1): void {
  completedTasksCount += count;
}

/**
 * 스킵된 Task 수 증가 (오류/CAPTCHA 등)
 */
export function incrementSkipped(count: number = 1): void {
  skippedTasksCount += count;
}

/**
 * 현재 배치 번호 설정
 */
export function setCurrentBatch(batchNum: number): void {
  currentBatchNumber = batchNum;
}

/**
 * 크롤링 진행 상태 조회
 */
export interface CrawlerProgress {
  isRunning: boolean;
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;  // 오류/CAPTCHA로 스킵된 Task
  pendingTasks: number;
  todayStopCount: number;
  currentBatch: number;
  elapsedTime: number;
  browserStatuses: BrowserStatusInfo[];
  batchDelay: {
    isDelaying: boolean;
    totalMs: number;
    elapsedMs: number;
    remainingMs: number;
  };
}

export function getCrawlerProgress(): CrawlerProgress {
  return {
    isRunning: isCrawlerRunning,
    totalTasks: totalTasksCount,
    completedTasks: completedTasksCount,
    skippedTasks: skippedTasksCount,
    pendingTasks: taskQueue.length,
    todayStopCount: blockedUserNums.size,
    currentBatch: currentBatchNumber,
    elapsedTime: getElapsedTime(),
    browserStatuses: getAllBrowserStatuses(),
    batchDelay: getBatchDelayInfo(),
  };
}

// =====================================================
// 브라우저별 상태 관리
// =====================================================

/**
 * 브라우저 상태 초기화
 */
export function initBrowserStatuses(browsers: { index: number; profileName: string }[]): void {
  browserStatuses.clear();
  browsers.forEach(({ index, profileName }) => {
    browserStatuses.set(index, {
      browserIndex: index,
      profileName,
      status: 'idle',
    });
  });
}

/**
 * 브라우저 상태 업데이트
 */
export function updateBrowserStatus(
  browserIndex: number,
  update: Partial<BrowserStatusInfo>
): void {
  const current = browserStatuses.get(browserIndex);
  if (current) {
    browserStatuses.set(browserIndex, { ...current, ...update });
  }
}

/**
 * 모든 브라우저 상태 가져오기
 */
export function getAllBrowserStatuses(): BrowserStatusInfo[] {
  return Array.from(browserStatuses.values()).sort((a, b) => a.browserIndex - b.browserIndex);
}

/**
 * 브라우저 상태 초기화 (크롤링 종료 시)
 */
export function clearBrowserStatuses(): void {
  browserStatuses.clear();
}

// =====================================================
// 배치 대기 상태 관리
// =====================================================

/**
 * 배치 대기 시작
 */
export function startBatchDelay(totalMs: number): void {
  batchDelayInfo = {
    isDelaying: true,
    totalMs,
    startTime: Date.now(),
  };
}

/**
 * 배치 대기 종료
 */
export function endBatchDelay(): void {
  batchDelayInfo = {
    isDelaying: false,
    totalMs: 0,
    startTime: 0,
  };
}

/**
 * 배치 대기 정보 가져오기
 */
export function getBatchDelayInfo(): {
  isDelaying: boolean;
  totalMs: number;
  elapsedMs: number;
  remainingMs: number;
} {
  if (!batchDelayInfo.isDelaying) {
    return { isDelaying: false, totalMs: 0, elapsedMs: 0, remainingMs: 0 };
  }

  const elapsedMs = Date.now() - batchDelayInfo.startTime;
  const remainingMs = Math.max(0, batchDelayInfo.totalMs - elapsedMs);

  return {
    isDelaying: true,
    totalMs: batchDelayInfo.totalMs,
    elapsedMs,
    remainingMs,
  };
}

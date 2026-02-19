/**
 * Crawler 전역 상태 관리 (DDD 패턴 적용)
 *
 * 역할:
 * - 크롤러 실행 상태 (running, stop 요청 등)
 * - 진행 통계 (총 작업, 완료, 스킵 등)
 * - todayStop 관리
 *
 * 주의: 브라우저별 상태는 CrawlerBrowser 객체가 직접 관리
 */

import type { CrawlTask } from "./types";
import type { BrowserStatusInfo } from "./CrawlerBrowser";

// 오늘 처리 횟수가 초과된 USERNUM 목록 (메모리 기반)
let blockedDate = new Date().toDateString();
const blockedUserNums = new Set<number>();

// insertUrl 관리 (서버에서 받은 결과 전송 URL)
let currentInsertUrl = '';

// 크롤러 제어를 위한 전역 변수
const taskQueue: CrawlTask[] = [];
let shouldStopCrawler = false;
let isCrawlerRunning = false;
let crawlerStartTime: number | null = null;

// 크롤링 진행 상태
let totalTasksCount = 0;
let completedTasksCount = 0;
let skippedTasksCount = 0;
let currentBatchNumber = 0;

// 대기 상태 (5분 대기 progress bar 용)
let waitEndTime: number | null = null;
let waitReason = '';

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
  waitEndTime = null;
  waitReason = '';
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
 * 대기 상태 설정 (5분 대기 progress bar 용)
 */
export function setWaitState(endTime: number, reason: string): void {
  waitEndTime = endTime;
  waitReason = reason;
}

/**
 * 대기 상태 해제
 */
export function clearWaitState(): void {
  waitEndTime = null;
  waitReason = '';
}

/**
 * 크롤링 진행 상태 조회
 */
export interface CrawlerProgress {
  isRunning: boolean;
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;
  pendingTasks: number;
  todayStopCount: number;
  currentBatch: number;
  elapsedTime: number;
  browserStatuses: BrowserStatusInfo[];
  waitEndTime: number | null;
  waitReason: string;
}

// CrawlerBrowser 배열을 외부에서 주입받아 상태 조회
let browserStatusesGetter: (() => BrowserStatusInfo[]) | null = null;

// TaskQueueManager 참조 (정확한 completed/failed 카운트용)
let taskQueueStatsGetter: (() => { completedCount: number; failedCount: number }) | null = null;

/**
 * 브라우저 상태 조회 함수 등록 (crawler.ts에서 호출)
 */
export function registerBrowserStatusesGetter(getter: () => BrowserStatusInfo[]): void {
  browserStatusesGetter = getter;
}

/**
 * 브라우저 상태 조회 함수 해제
 */
export function unregisterBrowserStatusesGetter(): void {
  browserStatusesGetter = null;
}

/**
 * TaskQueue 통계 조회 함수 등록 (중복 카운트 방지)
 */
export function registerTaskQueueStatsGetter(getter: () => { completedCount: number; failedCount: number }): void {
  taskQueueStatsGetter = getter;
}

/**
 * TaskQueue 통계 조회 함수 해제
 */
export function unregisterTaskQueueStatsGetter(): void {
  taskQueueStatsGetter = null;
}

/**
 * 크롤링 진행 상태 조회 (DDD 패턴)
 * TaskQueueManager의 Map 기반 카운트 사용 (중복 방지)
 */
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
    browserStatuses: browserStatusesGetter ? browserStatusesGetter() : [],
    waitEndTime,
    waitReason,
  };
}

// ========================================
// insertUrl 관리
// ========================================

/**
 * insertUrl 설정
 */
export function setInsertUrl(url: string): void {
  currentInsertUrl = url;
  console.log(`[State] insertUrl updated: ${url}`);
}

/**
 * insertUrl 조회
 */
export function getInsertUrl(): string {
  return currentInsertUrl;
}

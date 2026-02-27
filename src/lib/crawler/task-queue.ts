/**
 * Task Queue Manager
 *
 * Producer-Consumer 패턴의 Task Queue 관리
 * - 생산자: fetchTasks()를 통해 서버에서 task 가져오기
 * - 소비자: 각 Worker(브라우저)가 독립적으로 task 가져가서 처리
 */

import type { CrawlTask, CrawlResult } from "./types";
import { isUserBlocked } from "./state";

interface TaskQueueStats {
  queueSize: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
}

export class TaskQueueManager {
  private queue: CrawlTask[] = [];
  private processing: Map<number, CrawlTask> = new Map();
  private completed: Map<number, { task: CrawlTask; result: CrawlResult }> = new Map();
  private failed: Map<number, { task: CrawlTask; error: string }> = new Map();

  /**
   * Queue에서 다음 Task 가져오기 (Worker용)
   */
  getNext(): { task: CrawlTask | null; skippedByTodayStop: number } {
    // todayStop된 USERNUM의 태스크는 스킵
    let skippedByTodayStop = 0;
    while (this.queue.length > 0 && isUserBlocked(this.queue[0].USERNUM)) {
      const skipped = this.queue.shift()!;
      console.log(`[TaskQueue] Task ${skipped.URLNUM} (${skipped.TARGETSTORENAME}) skipped (todayStop USERNUM: ${skipped.USERNUM})`);
      skippedByTodayStop++;
    }
    if (skippedByTodayStop > 0) {
      console.log(`[TaskQueue] Skipped ${skippedByTodayStop} tasks due to todayStop`);
    }

    const task = this.queue.shift() || null;
    if (task) {
      this.processing.set(task.URLNUM, task);
      console.log(`[TaskQueue] Task ${task.URLNUM} (${task.TARGETSTORENAME}) assigned`);
    }
    return { task, skippedByTodayStop };
  }

  /**
   * Task를 큐 맨 앞에 반환 (health check 실패 시 재처리용)
   */
  returnTask(task: CrawlTask): void {
    this.processing.delete(task.URLNUM);
    this.queue.unshift(task);
    console.log(`[TaskQueue] Task ${task.URLNUM} (${task.TARGETSTORENAME}) returned to queue`);
  }

  /**
   * Queue에 새로운 Tasks 추가 (Producer용)
   */
  addTasks(tasks: CrawlTask[]): void {
    this.queue.push(...tasks);
    console.log(`[TaskQueue] Added ${tasks.length} tasks (total queue: ${this.queue.length})`);
  }

  /**
   * Task 완료 처리
   */
  markComplete(task: CrawlTask, result: CrawlResult): void {
    this.processing.delete(task.URLNUM);
    this.completed.set(task.URLNUM, { task, result });
    console.log(`[TaskQueue] Task ${task.URLNUM} completed (${result.success ? 'success' : 'failed'})`);
  }

  /**
   * Task 실패 처리
   */
  markFailed(task: CrawlTask, error: string): void {
    this.processing.delete(task.URLNUM);
    this.failed.set(task.URLNUM, { task, error });
    console.log(`[TaskQueue] Task ${task.URLNUM} failed: ${error}`);
  }

  /**
   * Queue 크기 조회
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * 처리 중인 Task 개수
   */
  processingCount(): number {
    return this.processing.size;
  }

  /**
   * 완료된 Task 개수
   */
  completedCount(): number {
    return this.completed.size;
  }

  /**
   * 실패한 Task 개수
   */
  failedCount(): number {
    return this.failed.size;
  }

  /**
   * 통계 조회
   */
  getStats(): TaskQueueStats {
    return {
      queueSize: this.size(),
      processingCount: this.processingCount(),
      completedCount: this.completedCount(),
      failedCount: this.failedCount(),
    };
  }

  /**
   * 완료된 Tasks 가져오기 및 초기화
   */
  getCompletedTasks(): { task: CrawlTask; result: CrawlResult }[] {
    const tasks = Array.from(this.completed.values());
    this.completed.clear();
    return tasks;
  }

  /**
   * 실패한 Tasks 가져오기 및 초기화
   */
  getFailedTasks(): { task: CrawlTask; error: string }[] {
    const tasks = Array.from(this.failed.values());
    this.failed.clear();
    return tasks;
  }

  /**
   * 모든 결과 초기화
   */
  clearResults(): void {
    this.completed.clear();
    this.failed.clear();
  }

  /**
   * 모든 상태 완전 초기화 (진행 상태 포함)
   */
  reset(): void {
    this.queue = [];
    this.processing.clear();
    this.completed.clear();
    this.failed.clear();
  }

  /**
   * Queue가 비어있는지 확인
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * 모든 작업이 완료되었는지 확인 (Queue 비어있고 처리중인 것도 없음)
   */
  isAllCompleted(): boolean {
    return this.isEmpty() && this.processingCount() === 0;
  }
}

/**
 * Task 관리 모듈
 * - Task 큐 관리
 * - 서버에서 Task 조회
 * - 완료/실패 Task 처리
 */

import type { CrawlTask, CrawlResult } from "./types";
import {
  getTaskQueue,
  addTasksToQueue,
  removeTaskFromQueue,
  isUserBlocked,
  addBlockedUser,
  getBlockedUserCount,
  checkAndResetIfNewDay,
  clearTaskQueue,
  addToTotalTasks,
} from "./state";
import { getUrlList } from "../../services/api";

/**
 * Task 가져오기 (n개)
 * - 큐에서 블록되지 않은 tasks 가져오기
 * - 큐가 비어있으면 서버에서 조회
 */
export async function fetchTasks(
  n: number,
  insertUrlRef: { current: string }
): Promise<CrawlTask[]> {
  // 날짜가 바뀌었으면 블록 목록 초기화
  checkAndResetIfNewDay();

  const queue = getTaskQueue();

  // 큐에서 블록되지 않은 tasks 필터링
  let validTasks = queue.filter((task) => !isUserBlocked(task.USERNUM));

  // 유효한 tasks가 없으면 서버에서 조회
  if (validTasks.length === 0) {
    console.log("[TaskManager] Queue is empty, fetching from server...");

    try {
      const response = await getUrlList();
      const newTasks = response.item || [];
      const insertUrl = response.inserturl || "";

      if (newTasks.length > 0) {
        // 기존 큐 비우고 새 tasks 추가
        clearTaskQueue();
        addTasksToQueue(newTasks);

        // 전체 Task 수 업데이트 (진행률 표시용)
        addToTotalTasks(newTasks.length);

        // insertUrl 업데이트
        if (insertUrl) {
          insertUrlRef.current = insertUrl;
        }

        console.log(
          `[TaskManager] Fetched ${newTasks.length} tasks from server`
        );

        // 다시 필터링
        validTasks = getTaskQueue().filter(
          (task) => !isUserBlocked(task.USERNUM)
        );
      } else {
        console.log("[TaskManager] No tasks available from server");
      }
    } catch (error: any) {
      console.error(`[TaskManager] Failed to fetch tasks: ${error.message}`);
    }
  }

  // 최대 n개 반환
  const tasksToProcess = validTasks.slice(0, Math.min(n, validTasks.length));

  console.log(
    `[TaskManager] Returning ${tasksToProcess.length} tasks (queue: ${queue.length}, blocked users: ${getBlockedUserCount()})`
  );

  return tasksToProcess;
}

/**
 * 완료된 Tasks 큐에서 제거
 */
export function removeCompletedTasks(tasks: CrawlTask[]): void {
  for (const task of tasks) {
    removeTaskFromQueue(task.URLNUM);
  }
  console.log(`[TaskManager] Removed ${tasks.length} completed tasks from queue`);
}

/**
 * 실패한 Tasks 큐 끝으로 이동 (재시도)
 */
export function requeueTasks(tasks: CrawlTask[]): void {
  addTasksToQueue(tasks);
  console.log(`[TaskManager] Requeued ${tasks.length} tasks for retry`);
}

/**
 * todayStop 결과 처리
 * - todayStop된 USERNUM을 블록 목록에 추가
 */
export function handleTodayStopResults(
  results: CrawlResult[],
  tasks: CrawlTask[]
): void {
  const todayStopResults = results.filter((result) => result.todayStop === true);

  if (todayStopResults.length === 0) {
    return;
  }

  console.log(
    `\n[TaskManager] ${todayStopResults.length} results with todayStop detected\n`
  );

  for (const result of todayStopResults) {
    const taskIndex = results.indexOf(result);
    if (taskIndex !== -1 && taskIndex < tasks.length) {
      const blockedTask = tasks[taskIndex];
      addBlockedUser(blockedTask.USERNUM);
    }
  }

  console.log(`[TaskManager] Total blocked USERNUMs: ${getBlockedUserCount()}\n`);
}

/**
 * 크롤링 결과를 서버에 전송
 */
export async function postGoodsList(
  data: any,
  insertUrl: string
): Promise<boolean> {
  try {
    console.log(
      `[TaskManager] Sending ${data.platforms} data to: ${insertUrl}`
    );
    console.log(
      `[TaskManager] urlnum=${data.urlnum}, usernum=${data.usernum}, products=${data.result?.list?.length || 0}`
    );

    const response = await fetch(insertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const todayStop = result.todayStop || false;

    console.log(`[TaskManager] Server response: todayStop=${todayStop}`);
    return todayStop;
  } catch (error: any) {
    console.error(`[TaskManager] Failed to post data: ${error.message}`);
    return false;
  }
}

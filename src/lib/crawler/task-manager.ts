/**
 * Task 관리 모듈
 * - Task 큐 관리
 * - 서버에서 Task 조회
 * - 완료/실패 Task 처리
 */

import { gzipSync } from "node:zlib";
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
  setInsertUrl,
  getInsertUrl,
} from "./state";
import { getUrlList } from "../../services/api";

/**
 * Task 가져오기 (n개)
 * - 큐에서 블록되지 않은 tasks 가져오기
 * - 큐가 비어있으면 서버에서 조회
 */
export async function fetchTasks(n: number): Promise<CrawlTask[]> {
  // 날짜가 바뀌었으면 블록 목록 초기화
  checkAndResetIfNewDay();

  const queue = getTaskQueue();

  // 큐에서 블록되지 않은 tasks 필터링
  let validTasks = queue.filter((task) => !isUserBlocked(task.USERNUM));

  // 유효한 tasks가 없으면 서버에서 조회
  if (validTasks.length === 0) {
    console.log(`[TaskManager] Queue is empty, fetching from server (limit: ${n})...`);

    try {
      const response = await getUrlList(n);
      const newTasks = response.item || [];
      const insertUrl = response.inserturl || "";

      if (newTasks.length > 0) {
        // 기존 큐 비우고 새 tasks 추가
        clearTaskQueue();
        addTasksToQueue(newTasks);

        // insertUrl 업데이트
        if (insertUrl) {
          setInsertUrl(insertUrl);
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
}

/**
 * 실패한 Tasks 큐 끝으로 이동 (재시도)
 */
export function requeueTasks(tasks: CrawlTask[]): void {
  addTasksToQueue(tasks);
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

  for (const result of todayStopResults) {
    const taskIndex = results.indexOf(result);
    if (taskIndex !== -1 && taskIndex < tasks.length) {
      const blockedTask = tasks[taskIndex];
      addBlockedUser(blockedTask.USERNUM);
    }
  }
}

/**
 * 크롤링 결과를 relay API로 gzip 압축 전송
 * @returns {success: 전송 성공 여부, todayStop: 오늘 중단 여부}
 */
export async function postGoodsList(payload: any, platform: string): Promise<{success: boolean, todayStop: boolean, urlcount: number}> {
  try {
    const insertUrl = getInsertUrl();

    if (!insertUrl) {
      console.warn('[TaskManager] insertUrl not set, skipping post');
      return {success: false, todayStop: false, urlcount: 0};
    }

    // insertUrl을 context에 추가
    if (payload.context && !payload.context.inserturl) {
      payload.context.inserturl = insertUrl;
    }

    const url = `https://api.opennest.co.kr/selltkey/v1/product-collect/relay-${platform.toLowerCase()}-goods`;
    const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: compressed,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    return {success: true, todayStop: result.todayStop || false, urlcount: result.urlcount || 0};
  } catch (error: any) {
    console.error(`[TaskManager] 서버 전송 실패: ${error.message}`);
    return {success: false, todayStop: false, urlcount: 0};
  }
}

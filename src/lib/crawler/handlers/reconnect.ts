/**
 * 네트워크 오류 복구 핸들러
 * - 네트워크/프록시 관련 에러 감지 시 브라우저 재시작 및 Task requeue
 */

import type { CrawlTask, CrawlResult, BrowserInfo, Session } from "../types";
import { restartBrowser } from "../browser-manager";
import { getElapsedTime, updateBrowserStatus } from "../state";

// 네트워크 오류로 간주할 패턴 (브라우저 재시작 + Task requeue)
const NETWORK_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "net::ERR_",
  "페이지 로드 실패",
  "이동 실패",
  "Navigation timeout",
  "Timeout waiting",
  "ETIMEDOUT",
];

interface DisconnectedResult {
  result: CrawlResult;
  index: number;
  task: CrawlTask;
  session: Session;
}

/**
 * 네트워크 오류 감지된 브라우저 처리
 * - 브라우저 재시작 (프로파일 유지)
 * - 실패한 Task를 큐 끝으로 이동 (재시도)
 */
export async function handleDisconnected(
  apiKey: string,
  results: CrawlResult[],
  tasks: CrawlTask[],
  sessions: Session[],
  browsers: BrowserInfo[]
): Promise<void> {
  // 네트워크 오류 필터링
  const disconnectedResults: DisconnectedResult[] = results
    .map((result, index) => ({
      result,
      index,
      task: tasks[index],
      session: sessions[index],
    }))
    .filter((item) => {
      if (!item.result.error) return false;
      // CAPTCHA는 별도 핸들러에서 처리
      if (item.result.captchaDetected) return false;
      // 네트워크 오류 패턴 체크
      return NETWORK_ERROR_PATTERNS.some((pattern) =>
        item.result.error!.includes(pattern)
      );
    });

  if (disconnectedResults.length === 0) {
    return;
  }

  // 경과 시간 계산
  const elapsedTime = getElapsedTime();
  const elapsedMinutes = (elapsedTime / 1000 / 60).toFixed(1);
  const elapsedSeconds = (elapsedTime / 1000).toFixed(1);

  console.log(
    `\n[ReconnectHandler] ${disconnectedResults.length} network errors detected, restarting browsers...`
  );
  console.log(
    `[ReconnectHandler] Elapsed time: ${elapsedMinutes}min (${elapsedSeconds}s)`
  );
  console.log(
    `[ReconnectHandler] Errors: ${disconnectedResults.map((r) => r.result.error?.substring(0, 50)).join(", ")}\n`
  );

  // Note: requeue 제거됨 - 서버에서 다음 요청 시 실패한 Task 다시 전송
  // 각 끊긴 브라우저 재시작
  for (const { session, index } of disconnectedResults) {
    // 상태 업데이트: 재연결 중
    updateBrowserStatus(index, {
      status: 'reconnecting',
      message: '네트워크 오류 - 브라우저 재시작 중...',
    });

    console.log(
      `\n[ReconnectHandler] Restarting browser: ${session.profileName}`
    );

    const newBrowserInfo = await restartBrowser(apiKey, browsers[index]);
    browsers[index] = newBrowserInfo;

    // 상태 업데이트: 재연결 결과
    if (newBrowserInfo.error) {
      updateBrowserStatus(index, {
        status: 'error',
        message: `재연결 실패: ${newBrowserInfo.error}`,
      });
    } else {
      updateBrowserStatus(index, {
        status: 'idle',
        message: '브라우저 재시작 완료',
        storeName: undefined,
        collectedCount: undefined,
      });
    }

    // AdsPower API rate limiting 방지
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  console.log(
    `\n[ReconnectHandler] Completed: ${disconnectedResults.length} browsers restarted, tasks requeued\n`
  );
}

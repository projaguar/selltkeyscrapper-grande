/**
 * CAPTCHA 처리 핸들러
 * - CAPTCHA 감지 시 IP 변경 및 브라우저 재시작
 */

import type { CrawlTask, CrawlResult, BrowserInfo, Session } from "../types";
import { updateBrowserStatus } from "../state";
import { restartBrowser } from "../browser-manager";
import { getProxyPool } from "../../proxy-pool";

interface CaptchaResult {
  result: CrawlResult;
  index: number;
  task: CrawlTask;
  session: Session;
}

/**
 * CAPTCHA 감지된 세션 처리
 * - IP 변경 시도
 * - 브라우저 재시작
 */
export async function handleCaptchaDetected(
  apiKey: string,
  results: CrawlResult[],
  tasks: CrawlTask[],
  sessions: Session[],
  browsers: BrowserInfo[]
): Promise<void> {
  // CAPTCHA 감지된 결과 필터링
  const captchaResults: CaptchaResult[] = results
    .map((result, index) => ({
      result,
      index,
      task: tasks[index],
      session: sessions[index],
    }))
    .filter((item) => item.result.captchaDetected === true);

  if (captchaResults.length === 0) {
    return;
  }

  console.log(
    `\n[CaptchaHandler] ${captchaResults.length} sessions with CAPTCHA detected, changing proxy and restarting browsers...\n`
  );

  // Note: requeue 제거됨 - 서버에서 다음 요청 시 실패한 Task 다시 전송
  // 각 CAPTCHA 감지된 세션별로 처리
  const proxyPool = getProxyPool();

  for (const { session, index } of captchaResults) {
    console.log(`\n[CaptchaHandler] Processing: ${session.profileName}`);

    // 상태 업데이트: 재연결 중
    updateBrowserStatus(index, {
      status: 'reconnecting',
      message: 'CAPTCHA 감지 - 새 IP 할당 및 재시작 중...',
    });

    console.log(`[CaptchaHandler] ${session.profileName} - Restarting browser with new proxy...`);

    // restartBrowser()가 자동으로:
    // 1. 기존 proxy를 dead로 표시
    // 2. 새 proxy 할당
    // 3. 브라우저 재시작
    // 4. naver.com 검증
    const newBrowserInfo = await restartBrowser(apiKey, browsers[index]);
    browsers[index] = newBrowserInfo;

    // 상태 업데이트: 재연결 결과
    if (newBrowserInfo.error) {
      updateBrowserStatus(index, {
        status: 'error',
        message: `재연결 실패: ${newBrowserInfo.error}`,
      });
    } else {
      // 새 proxy 정보 가져오기
      const newProxy = session.proxyId ? proxyPool.getProxyById(session.proxyId) : undefined;
      const newProxyIp = newProxy ? `${newProxy.ip}:${newProxy.port}` : 'Unknown';

      updateBrowserStatus(index, {
        status: 'idle',
        message: '브라우저 재시작 완료',
        storeName: undefined,
        collectedCount: undefined,
        proxyIp: newProxyIp,
      });

      console.log(`[CaptchaHandler] ${session.profileName} - New proxy: ${newProxyIp}`);
    }

    console.log(
      `[CaptchaHandler] ${session.profileName} - Processing completed`
    );

    // AdsPower API rate limiting 방지
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  console.log(
    `\n[CaptchaHandler] Completed: ${captchaResults.length} browsers restarted\n`
  );
}

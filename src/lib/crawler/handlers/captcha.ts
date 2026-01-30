/**
 * CAPTCHA 처리 핸들러
 * - CAPTCHA 감지 시 프로파일 재생성
 */

import puppeteer from "puppeteer-core";
import * as adspower from "../../../services/adspower";
import { getProxyPool } from "../../proxy-pool";
import type { CrawlTask, CrawlResult, BrowserInfo, Session } from "../types";
import { updateBrowserStatus } from "../state";

interface CaptchaResult {
  result: CrawlResult;
  index: number;
  task: CrawlTask;
  session: Session;
}

/**
 * CAPTCHA 감지된 세션 처리
 * - 프로파일 삭제 후 재생성
 * - 새 Proxy 할당
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
    `\n[CaptchaHandler] ${captchaResults.length} sessions with CAPTCHA detected, recreating profiles...\n`
  );

  // Note: requeue 제거됨 - 서버에서 다음 요청 시 실패한 Task 다시 전송
  // 각 블록된 세션별로 처리
  for (const { session, index } of captchaResults) {
    console.log(`\n[CaptchaHandler] Processing: ${session.profileName}`);

    // 상태 업데이트: 재생성 중
    updateBrowserStatus(index, {
      status: 'recreating',
      message: 'CAPTCHA 감지 - 프로필 재생성 중...',
    });

    try {
      // 1. 기존 브라우저 연결 끊기
      if (browsers[index]?.browser) {
        try {
          await browsers[index].browser.disconnect();
        } catch (error) {
          console.log(`[CaptchaHandler] ${session.profileName} - Browser already disconnected`);
        }
      }

      // 2. 브라우저 중지
      try {
        await adspower.stopBrowser(apiKey, session.profileId);
      } catch (error) {
        console.log(`[CaptchaHandler] ${session.profileName} - Browser already stopped`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 3. 프로파일 삭제
      console.log(`[CaptchaHandler] ${session.profileName} - Deleting profile...`);
      await adspower.deleteProfiles(apiKey, [session.profileId]);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // 4. Proxy release
      if (session.proxyId) {
        console.log(`[CaptchaHandler] ${session.profileName} - Releasing proxy ${session.proxyId}...`);
        const proxyPool = getProxyPool();
        proxyPool.releaseProxy(session.proxyId);
      }

      // 5. 새 Proxy 할당
      console.log(`[CaptchaHandler] ${session.profileName} - Allocating new proxy...`);
      const proxyPool = getProxyPool();
      const newProxy = proxyPool.getNextProxy();

      if (!newProxy) {
        throw new Error("No available proxy for profile recreation");
      }

      proxyPool.markInUse(newProxy.id);
      console.log(
        `[CaptchaHandler] ${session.profileName} - New proxy: ${newProxy.ip}:${newProxy.port}`
      );

      // 6. 새 프로파일 생성
      console.log(`[CaptchaHandler] ${session.profileName} - Creating new profile...`);
      const profileData = {
        name: session.profileName,
        group_id: "0",
        user_proxy_config: {
          proxy_soft: "other",
          proxy_type: "http",
          proxy_host: newProxy.ip,
          proxy_port: newProxy.port,
          proxy_user: newProxy.username || "",
          proxy_password: newProxy.password || "",
        },
      };

      const createResult = await adspower.createProfile(apiKey, profileData);
      if (createResult.code !== 0) {
        throw new Error(`Failed to create profile: ${createResult.msg}`);
      }

      const newProfileId = createResult.data?.id;
      if (!newProfileId) {
        throw new Error("New profile ID not found in response");
      }

      console.log(
        `[CaptchaHandler] ${session.profileName} - New profile: ${newProfileId}`
      );

      // 7. 세션 정보 업데이트
      session.profileId = newProfileId;
      session.proxyId = newProxy.id;

      // 8. 새 브라우저 시작 및 Puppeteer 연결
      console.log(`[CaptchaHandler] ${session.profileName} - Starting new browser...`);
      const startResult = await adspower.startBrowser(apiKey, newProfileId);
      if (startResult.code !== 0) {
        throw new Error(`Failed to start browser: ${startResult.msg}`);
      }

      const wsUrl = startResult.data?.ws?.puppeteer;
      if (!wsUrl) {
        throw new Error("WebSocket URL not found");
      }

      // 9. Puppeteer 재연결
      const newBrowser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
      });

      // 10. browsers 배열 업데이트
      browsers[index] = {
        session,
        browser: newBrowser,
        browserData: startResult.data,
        error: null,
      };

      // 상태 업데이트: 재생성 완료
      updateBrowserStatus(index, {
        status: 'idle',
        message: '프로필 재생성 완료',
        storeName: undefined,
        collectedCount: undefined,
      });

      console.log(
        `[CaptchaHandler] ${session.profileName} - Profile recreated successfully`
      );
    } catch (error: any) {
      // 상태 업데이트: 재생성 실패
      updateBrowserStatus(index, {
        status: 'error',
        message: `재생성 실패: ${error.message}`,
      });

      console.error(
        `[CaptchaHandler] ${session.profileName} - Failed: ${error.message}`
      );

      // 실패 시 proxy release
      if (session.proxyId) {
        try {
          const proxyPool = getProxyPool();
          proxyPool.releaseProxy(session.proxyId);
        } catch (releaseError) {
          console.error(
            `[CaptchaHandler] ${session.profileName} - Failed to release proxy`
          );
        }
      }
    }
  }

  console.log(
    `\n[CaptchaHandler] Completed: ${captchaResults.length} sessions processed\n`
  );
}

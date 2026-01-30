/**
 * 브라우저 관리 모듈
 * - 브라우저 초기화/정리
 * - WebSocket Keepalive
 */

import puppeteer from "puppeteer-core";
import * as adspower from "../../services/adspower";
import type { Session, BrowserInfo } from "./types";

/**
 * 모든 브라우저 순차 시작 및 연결
 * (AdsPower API rate limit: 초당 2 요청)
 */
export async function initializeBrowsers(
  apiKey: string,
  sessions: Session[]
): Promise<BrowserInfo[]> {
  console.log(
    `[BrowserManager] Starting ${sessions.length} browsers sequentially...`
  );

  const browsers: BrowserInfo[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];

    try {
      const startResult = await adspower.startBrowser(apiKey, session.profileId);
      if (startResult.code !== 0) {
        throw new Error(`Failed to start browser: ${startResult.msg}`);
      }

      const wsUrl = startResult.data?.ws?.puppeteer;
      if (!wsUrl) {
        throw new Error("WebSocket URL not found");
      }

      // Puppeteer 연결
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
      });

      browsers.push({
        session,
        browser,
        browserData: startResult.data,
        error: null,
      });

      console.log(
        `[BrowserManager] Browser started for ${session.profileName} (${i + 1}/${sessions.length})`
      );
    } catch (error: any) {
      console.error(
        `[BrowserManager] Failed to start browser for ${session.profileName}: ${error.message}`
      );
      browsers.push({
        session,
        browser: null,
        error: error.message,
      });
    }

    // AdsPower API rate limiting 방지: 600ms 딜레이
    if (i < sessions.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  console.log(`[BrowserManager] All ${browsers.length} browsers ready\n`);
  return browsers;
}

/**
 * 모든 브라우저 정리
 */
export async function cleanupBrowsers(
  apiKey: string,
  browsers: BrowserInfo[]
): Promise<void> {
  console.log(`\n[BrowserManager] Cleaning up ${browsers.length} browsers...\n`);

  for (let i = 0; i < browsers.length; i++) {
    const browserInfo = browsers[i];
    if (!browserInfo) continue;

    // Puppeteer 연결 끊기
    if (browserInfo.browser) {
      try {
        await browserInfo.browser.disconnect();
        console.log(`[BrowserManager] Browser ${i + 1} disconnected`);
      } catch (error: any) {
        console.error(
          `[BrowserManager] Failed to disconnect browser ${i + 1}: ${error.message}`
        );
      }
    }

    // AdsPower 브라우저 중지
    try {
      await adspower.stopBrowser(apiKey, browserInfo.session.profileId);
      console.log(`[BrowserManager] Browser ${i + 1} stopped`);
    } catch (error: any) {
      console.error(
        `[BrowserManager] Failed to stop browser ${i + 1}: ${error.message}`
      );
    }
  }

  console.log(`\n[BrowserManager] Cleanup completed\n`);
}

/**
 * WebSocket Keepalive: 모든 브라우저에 간단한 작업 수행
 */
export async function keepaliveBrowsers(browsers: BrowserInfo[]): Promise<void> {
  console.log(
    `[BrowserManager] Performing WebSocket keepalive on ${browsers.length} browsers...`
  );

  for (let i = 0; i < browsers.length; i++) {
    const browserInfo = browsers[i];
    if (browserInfo.error || !browserInfo.browser) {
      continue;
    }

    try {
      // 페이지 목록 가져오기 (WebSocket 통신 발생)
      await browserInfo.browser.pages();
    } catch (error: any) {
      console.log(
        `[BrowserManager] Keepalive failed for browser ${i + 1} (${browserInfo.session.profileName}): ${error.message}`
      );
    }
  }

  console.log(`[BrowserManager] Keepalive completed\n`);
}

/**
 * 특정 브라우저 재시작 (프로파일 유지)
 */
export async function restartBrowser(
  apiKey: string,
  browserInfo: BrowserInfo
): Promise<BrowserInfo> {
  const { session } = browserInfo;
  console.log(`[BrowserManager] Restarting browser: ${session.profileName}`);

  try {
    // 기존 브라우저 정리
    if (browserInfo.browser) {
      try {
        await browserInfo.browser.disconnect();
      } catch {
        // 이미 끊겼으므로 무시
      }
    }

    // AdsPower 브라우저 중지 시도
    try {
      await adspower.stopBrowser(apiKey, session.profileId);
    } catch {
      console.log(`[BrowserManager] ${session.profileName} - Browser already stopped`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 브라우저 재시작
    const startResult = await adspower.startBrowser(apiKey, session.profileId);
    if (startResult.code !== 0) {
      throw new Error(`Failed to restart browser: ${startResult.msg}`);
    }

    const wsUrl = startResult.data?.ws?.puppeteer;
    if (!wsUrl) {
      throw new Error("WebSocket URL not found");
    }

    // Puppeteer 재연결
    const newBrowser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    console.log(`[BrowserManager] ${session.profileName} - Browser restarted successfully`);

    return {
      session,
      browser: newBrowser,
      browserData: startResult.data,
      error: null,
    };
  } catch (error: any) {
    console.error(
      `[BrowserManager] ${session.profileName} - Failed to restart: ${error.message}`
    );
    return {
      session,
      browser: null,
      browserData: null,
      error: `Restart failed: ${error.message}`,
    };
  }
}

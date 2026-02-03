/**
 * 브라우저 관리 모듈
 * - 브라우저 초기화/정리
 * - WebSocket Keepalive
 */

import puppeteer from "puppeteer-core";
import { adsPowerQueue } from "./adspower-queue";
import type { Session, BrowserInfo } from "./types";
import { getProxyPool } from "../proxy-pool";
import * as adspower from "../../services/adspower";

// 재시작 중인 브라우저 추적 (중복 방지)
const restartingBrowsers: Set<string> = new Set();

/**
 * 브라우저 시작 및 검증 (공통 로직)
 * - AdsPower 브라우저 시작
 * - Puppeteer 연결
 * - 탭 정리 (1개만 유지)
 * - naver.com 접속하여 IP 검증 (선택적)
 */
async function startAndValidateBrowser(
  apiKey: string,
  profileId: string,
  profileName: string,
  validateIp: boolean = false
): Promise<{ browser: any; browserData: any } | { error: string }> {
  try {
    // 1. AdsPower 브라우저 시작
    console.log(`[BrowserManager] ${profileName} - Starting browser...`);
    const startResult = await adsPowerQueue.startBrowser(apiKey, profileId);

    if (startResult.code !== 0) {
      throw new Error(`AdsPower API failed: ${startResult.msg} (code: ${startResult.code})`);
    }

    const wsUrl = startResult.data?.ws?.puppeteer;
    if (!wsUrl) {
      console.error(`[BrowserManager] ${profileName} - AdsPower response data:`, JSON.stringify(startResult.data, null, 2));
      throw new Error("WebSocket URL not found in response");
    }

    // 2. Puppeteer 연결
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    // 3. 브라우저 초기화 대기 및 탭 정리
    console.log(`[BrowserManager] ${profileName} - Waiting for browser initialization...`);
    await new Promise((resolve) => setTimeout(resolve, 2000)); // 브라우저 초기화 대기 (2초)

    const pages = await browser.pages();
    console.log(`[BrowserManager] ${profileName} - Found ${pages.length} tabs`);

    if (pages.length === 0) {
      throw new Error("No tabs found - browser may have closed unexpectedly");
    }

    let mainPage: any;

    if (pages.length > 1) {
      // 탭이 여러 개면 첫 번째만 남기고 나머지 닫기
      console.log(`[BrowserManager] ${profileName} - Closing ${pages.length - 1} extra tabs...`);

      const closePromises = pages.slice(1).map((page: any) =>
        page.close().catch((err: any) => {
          console.warn(`[BrowserManager] Failed to close tab: ${err.message}`);
        })
      );
      await Promise.all(closePromises);
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log(`[BrowserManager] ${profileName} - Kept first tab, closed ${pages.length - 1} extras`);

      mainPage = pages[0];
    } else {
      // 탭이 정확히 1개면 그대로 사용
      console.log(`[BrowserManager] ${profileName} - Using existing tab`);
      mainPage = pages[0];
    }

    // 4. naver.com 접속하여 IP 유효성 검증 (선택적)
    if (validateIp) {
      console.log(`[BrowserManager] ${profileName} - Navigating to naver.com for IP validation...`);

      await mainPage.goto('https://www.naver.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // 페이지 로드 안정화 대기
      await new Promise((resolve) => setTimeout(resolve, 2000));

      console.log(`[BrowserManager] ${profileName} - Successfully validated IP with naver.com`);
    } else {
      console.log(`[BrowserManager] ${profileName} - Skipping IP validation (will validate on first crawl)`);
    }

    return {
      browser,
      browserData: startResult.data,
    };
  } catch (error: any) {
    return {
      error: error.message,
    };
  }
}

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

    // 공통 로직: 브라우저 시작 (초기 시작 시에는 IP 검증 스킵 - preparePage에서 자동 검증)
    const result = await startAndValidateBrowser(apiKey, session.profileId, session.profileName, false);

    if ('error' in result) {
      console.error(
        `[BrowserManager] Failed to start browser for ${session.profileName}: ${result.error}`
      );
      browsers.push({
        session,
        browser: null,
        error: result.error,
      });
    } else {
      browsers.push({
        session,
        browser: result.browser,
        browserData: result.browserData,
        error: null,
      });

      console.log(
        `[BrowserManager] Browser started for ${session.profileName} (${i + 1}/${sessions.length})`
      );
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
      await adsPowerQueue.stopBrowser(apiKey, browserInfo.session.profileId);
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
 * - 최대 3회 재시도 (지수 백오프)
 * - 중복 재시작 방지 (이미 재시작 중이면 대기)
 * - ProxyPool에서 새로운 proxy 할당
 * - naver.com 접속하여 IP 유효성 검증
 */
export async function restartBrowser(
  apiKey: string,
  browserInfo: BrowserInfo
): Promise<BrowserInfo> {
  const { session } = browserInfo;
  const MAX_RETRIES = 3;

  // 이미 재시작 중인 브라우저면 대기
  if (restartingBrowsers.has(session.profileId)) {
    console.log(`[BrowserManager] ${session.profileName} is already restarting, waiting...`);

    // 최대 30초 대기
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!restartingBrowsers.has(session.profileId)) {
        console.log(`[BrowserManager] ${session.profileName} restart completed by another worker`);
        return browserInfo; // 다른 Worker가 이미 재시작 완료
      }
    }

    console.warn(`[BrowserManager] ${session.profileName} restart timeout after 30s wait`);
    return browserInfo;
  }

  // 재시작 시작 표시
  restartingBrowsers.add(session.profileId);
  console.log(`[BrowserManager] Restarting browser: ${session.profileName}`);

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
    await adsPowerQueue.stopBrowser(apiKey, session.profileId);
    console.log(`[BrowserManager] ${session.profileName} - Browser stopped`);
  } catch {
    console.log(`[BrowserManager] ${session.profileName} - Browser already stopped`);
  }

  // 브라우저 완전 종료 대기
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // ========================================
  // ProxyPool에서 새로운 Proxy 할당
  // ========================================
  const proxyPool = getProxyPool();

  // 기존 proxy를 dead로 표시 (블록/네트워크 오류로 재시작하는 경우)
  if (session.proxyId) {
    proxyPool.markDead(session.proxyId);
    console.log(`[BrowserManager] ${session.profileName} - Marked old proxy ${session.proxyId} as dead`);
  }

  // 새 proxy 가져오기
  const newProxy = proxyPool.getNextProxy();
  if (!newProxy) {
    console.error(`[BrowserManager] ${session.profileName} - No available proxies!`);
    restartingBrowsers.delete(session.profileId);
    return {
      session,
      browser: null,
      browserData: null,
      error: "No available proxies in pool",
    };
  }

  console.log(`[BrowserManager] ${session.profileName} - Assigning new proxy: ${newProxy.ip}:${newProxy.port}`);

  // AdsPower 프로필에 새 proxy 설정 업데이트
  const updateData: any = {
    user_proxy_config: {
      proxy_soft: 'other',
      proxy_type: 'http',
      proxy_host: newProxy.ip,
      proxy_port: newProxy.port,
    },
    // 탭 설정 초기화 (빈 탭만 열림)
    domain_name: '',
    open_urls: [],
    tab_urls: [],
  };

  // username/password가 있으면 추가
  if (newProxy.username) {
    updateData.user_proxy_config.proxy_user = newProxy.username;
  }
  if (newProxy.password) {
    updateData.user_proxy_config.proxy_password = newProxy.password;
  }

  try {
    const updateResult = await adspower.updateProfile(apiKey, session.profileId, updateData);
    if (updateResult.code !== 0) {
      console.error(`[BrowserManager] ${session.profileName} - Failed to update proxy: ${updateResult.msg}`);
      proxyPool.releaseProxy(newProxy.id);
      restartingBrowsers.delete(session.profileId);
      return {
        session,
        browser: null,
        browserData: null,
        error: `Proxy update failed: ${updateResult.msg}`,
      };
    }
    console.log(`[BrowserManager] ${session.profileName} - Proxy updated successfully`);
  } catch (error: any) {
    console.error(`[BrowserManager] ${session.profileName} - Proxy update error: ${error.message}`);
    proxyPool.releaseProxy(newProxy.id);
    restartingBrowsers.delete(session.profileId);
    return {
      session,
      browser: null,
      browserData: null,
      error: `Proxy update error: ${error.message}`,
    };
  }

  // Proxy 적용 안정화 대기
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // 재시작 재시도 로직
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[BrowserManager] ${session.profileName} - Start attempt ${attempt}/${MAX_RETRIES}`);

    // 공통 로직: 브라우저 시작 및 IP 검증 (재시작 시에는 새 proxy 즉시 확인 필요)
    const result = await startAndValidateBrowser(apiKey, session.profileId, session.profileName, true);

    if ('error' in result) {
      console.error(
        `[BrowserManager] ${session.profileName} - Attempt ${attempt} failed: ${result.error}`
      );

      // 마지막 시도가 아니면 지수 백오프 대기
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.log(`[BrowserManager] ${session.profileName} - Waiting ${backoffMs}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } else {
        // 모든 재시도 실패
        console.error(
          `[BrowserManager] ${session.profileName} - All ${MAX_RETRIES} restart attempts failed`
        );

        // 할당받은 proxy 해제
        proxyPool.releaseProxy(newProxy.id);

        // 재시작 완료 표시 제거
        restartingBrowsers.delete(session.profileId);

        return {
          session,
          browser: null,
          browserData: null,
          error: `Restart failed after ${MAX_RETRIES} attempts: ${result.error}`,
        };
      }
    } else {
      // 성공
      console.log(`[BrowserManager] ${session.profileName} - Browser restarted successfully on attempt ${attempt}`);

      // Session에 새 proxy 정보 업데이트
      session.proxyId = newProxy.id;

      // 새 proxy를 in_use로 표시
      proxyPool.markInUse(newProxy.id);

      // 재시작 완료 표시 제거
      restartingBrowsers.delete(session.profileId);

      return {
        session,
        browser: result.browser,
        browserData: result.browserData,
        error: null,
      };
    }
  }

  // 이 코드에 도달하지 않지만 TypeScript를 위해
  // 재시작 완료 표시 제거
  restartingBrowsers.delete(session.profileId);

  // 할당받은 proxy 해제 (안전장치)
  proxyPool.releaseProxy(newProxy.id);

  return {
    session,
    browser: null,
    browserData: null,
    error: "Unknown restart failure",
  };
}

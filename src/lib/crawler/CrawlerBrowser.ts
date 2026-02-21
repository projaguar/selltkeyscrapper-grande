/**
 * CrawlerBrowser 도메인 객체 (DDD Pattern)
 *
 * 하나의 브라우저/프로필에 대한 모든 정보와 행위를 통합 관리
 * - Profile 정보 및 수정 기능
 * - Browser 제어 (start/stop/restart)
 * - Proxy 관리
 * - 상태 관리
 */

import * as adspower from "../../services/adspower";
import { adsPowerQueue } from "./adspower-queue";
import type { Proxy } from "../proxy-pool";

// puppeteer-core는 dynamic import로 사용 (Electron main process)
let puppeteer: any = null;
async function getPuppeteer() {
  if (!puppeteer) {
    puppeteer = await import("puppeteer-core");
  }
  return puppeteer;
}

// ========================================
// Types
// ========================================

export type BrowserStatus =
  | "idle" // 대기 중
  | "starting" // 브라우저 시작 중
  | "ready" // 준비 완료
  | "crawling" // 크롤링 중
  | "success" // 성공
  | "warning" // 경고 (상품 없음 등)
  | "error" // 오류
  | "waiting" // 다음 작업 대기
  | "restarting" // 재시작 중
  | "stopped"; // 중지됨

export interface BrowserStatusInfo {
  profileId: string;
  profileName: string;
  status: BrowserStatus;
  proxyGroupName?: string;
  proxyIp?: string;
  storeName?: string;
  message?: string;
  collectedCount?: number;
  error?: string;
}

export interface CrawlerBrowserConfig {
  profileId: string;
  profileName: string;
  apiKey: string;
  proxy?: Proxy;
  proxyGroupId?: number;
  proxyGroupName?: string;
}

// ========================================
// Domain Object: CrawlerBrowser
// ========================================

export class CrawlerBrowser {
  // ========================================
  // Properties (Private)
  // ========================================

  // Profile 정보
  private readonly profileId: string;
  private readonly profileName: string;

  // Proxy 정보
  private proxyId?: number;
  private proxyIp?: string;
  private proxyPort?: string;
  private proxyUsername?: string;
  private proxyPassword?: string;

  // Proxy Group 정보
  private proxyGroupId?: number;
  private proxyGroupName?: string;

  // Browser 인스턴스
  private browser?: any; // puppeteer.Browser

  // 상태 정보
  private status: BrowserStatus = "idle";
  private message?: string;
  private storeName?: string;
  private collectedCount?: number;
  private error?: string;

  // 의존성
  private readonly apiKey: string;

  // 재시작 중복 방지
  private isRestarting: boolean = false;

  // 이미지 차단 플래그 (실시간 제어 가능)
  private blockImages: boolean = false;
  private requestInterceptionSetup: boolean = false;


  // ========================================
  // Constructor
  // ========================================

  constructor(config: CrawlerBrowserConfig) {
    this.profileId = config.profileId;
    this.profileName = config.profileName;
    this.apiKey = config.apiKey;
    if (config.proxy) {
      this.assignProxy(config.proxy);
    }

    if (config.proxyGroupId !== undefined) {
      this.proxyGroupId = config.proxyGroupId;
    }
    if (config.proxyGroupName) {
      this.proxyGroupName = config.proxyGroupName;
    }
  }

  // ========================================
  // Profile 관리 (Proxy, Tabs)
  // ========================================

  /**
   * Proxy 할당 (메모리만 업데이트, AdsPower 업데이트는 updateProxySettings 호출 필요)
   */
  private assignProxy(proxy: Proxy): void {
    this.proxyId = proxy.id;
    this.proxyIp = proxy.ip;
    this.proxyPort = proxy.port;
    this.proxyUsername = proxy.username;
    this.proxyPassword = proxy.password;
  }

  /**
   * AdsPower 프로필에 Proxy 설정 + 탭 설정(open_urls) 업데이트
   */
  async updateProxySettings(proxy: Proxy): Promise<void> {
    const updateData: any = {
      user_proxy_config: {
        proxy_type: 'http',
        proxy_host: proxy.ip,
        proxy_port: proxy.port,
        proxy_user: proxy.username || '',
        proxy_password: proxy.password || '',
        proxy_soft: 'other',
      },
      open_urls: ['https://www.naver.com'],
    };

    // 큐를 통해 rate limit 준수
    await adsPowerQueue.enqueue(
      `updateProfile ${this.profileId}`,
      () => adspower.updateProfile(this.apiKey, this.profileId, updateData),
    );

    // 성공 시 메모리 업데이트
    this.assignProxy(proxy);
  }

  /**
   * 핑거프린트 설정 강화 (AdsPower는 내부 자동 처리이므로 no-op)
   */
  async hardenFingerprint(): Promise<void> {
    // AdsPower handles fingerprint internally - no action needed
  }

  /**
   * 탭 설정 초기화 (updateProxySettings에서 open_urls 설정하므로 no-op)
   */
  async clearTabSettings(): Promise<void> {
    // Tab settings are managed via updateProxySettings open_urls
  }

  // ========================================
  // Browser 제어 (Start/Stop/Restart)
  // ========================================

  /**
   * 브라우저 시작 (AdsPower API → puppeteer.connect)
   */
  async start(options?: {
    validateConnection?: boolean;
    validateProxy?: boolean;
  }): Promise<void> {
    const validateProxy = options?.validateProxy ?? false;
    const validateConnection = options?.validateConnection ?? false;

    this.updateStatus("starting", "브라우저 시작 중...");

    try {
      // 1. AdsPower API로 브라우저 시작 (큐를 통해 rate limit 준수)
      const result = await adsPowerQueue.startBrowser(this.apiKey, this.profileId);

      // AdsPower returns { code: 0, data: { ws: { puppeteer: "ws://..." }, ... } }
      const wsEndpoint = result.data?.ws?.puppeteer;
      if (!wsEndpoint) {
        throw new Error('AdsPower did not return WebSocket endpoint');
      }

      console.log(`[CrawlerBrowser] ${this.profileName} - Connecting to ${wsEndpoint}`);

      // 2. puppeteer.connect()로 브라우저에 연결
      const pptr = await getPuppeteer();
      this.browser = await pptr.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
      });

      // 3. 브라우저 초기화 대기 (open_urls로 네이버 자동 로드)
      await this.delay(1000);

      // 4. 탭 정리 (1개만 유지)
      await this.cleanupTabs();

      // 5. 리소스 차단 설정 (실시간 제어 가능)
      await this.setupResourceBlocking();

      // 6. 프록시 검증 (선택적)
      let proxyValidated = false;
      if (validateProxy) {
        const maxRetries = 2;
        let lastError = "";

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const validationResult = await this.validateProxy();

          if (validationResult.valid) {
            if (validationResult.actualIp) {
              this.proxyIp = validationResult.actualIp;
            }
            proxyValidated = true;
            break;
          }

          lastError = validationResult.error || "Unknown error";

          if (attempt < maxRetries) {
            await this.delay(2000);
          }
        }

        if (!proxyValidated) {
          throw new Error(`Proxy validation failed: ${lastError}`);
        }
      }

      // 7. 연결 테스트 (프록시 검증이 성공했으면 스킵)
      if (validateConnection && !proxyValidated) {
        await this.testConnection();
      }

      this.updateStatus("ready", "준비 완료");
    } catch (error: any) {
      this.error = error.message;
      this.updateStatus("error", error.message);
      throw error;
    }
  }

  /**
   * 브라우저 중지 (puppeteer disconnect + AdsPower API stop)
   * @param fireAndForget true면 stop API 응답을 기다리지 않음 (재시작 시 속도 최적화)
   */
  async stop(fireAndForget = false): Promise<void> {
    // puppeteer 연결 해제
    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        // 이미 연결이 끊어진 경우 무시
      }
      this.browser = undefined;
    }

    // 리소스 차단 설정 플래그 리셋 (재시작 시 다시 설정할 수 있도록)
    this.requestInterceptionSetup = false;

    // AdsPower API로 브라우저 종료
    if (fireAndForget) {
      // fire-and-forget: 응답 기다리지 않음 (재시작 시 속도 최적화)
      adsPowerQueue.stopBrowser(this.apiKey, this.profileId).catch((e: any) => {
        console.log(`[CrawlerBrowser] ${this.profileName} - AdsPower stop failed (무시): ${e.message}`);
      });
    } else {
      try {
        await adsPowerQueue.stopBrowser(this.apiKey, this.profileId);
      } catch (e: any) {
        console.log(`[CrawlerBrowser] ${this.profileName} - AdsPower stop failed (무시): ${e.message}`);
      }
    }

    this.updateStatus("stopped", "중지됨");
  }

  /**
   * 브라우저 재시작 (stop → 프록시 설정 → start, 단일 시도)
   * 재시도는 호출자(handleBrowserRestart)가 다른 프록시로 담당.
   */
  async restart(newProxy?: Proxy): Promise<void> {
    // 중복 재시작 방지
    if (this.isRestarting) {
      for (let i = 0; i < 30; i++) {
        await this.delay(1000);
        if (!this.isRestarting) {
          return;
        }
      }
      throw new Error("Restart timeout: already restarting by another process");
    }

    this.isRestarting = true;
    this.updateStatus("restarting", "재시작 중...");

    try {
      // stop API 응답을 기다리지 않고 즉시 진행 (fire-and-forget)
      await this.stop(true);
      await this.delay(500);

      if (newProxy) {
        await this.updateProxySettings(newProxy);
      }

      await this.start({ validateProxy: false, validateConnection: false });
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * 연결 테스트 (naver.com 접속)
   */
  async testConnection(): Promise<boolean> {
    if (!this.browser) {
      throw new Error("Browser not started");
    }

    const page = await this.getPage();
    await page.goto("https://www.naver.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const currentUrl = page.url();
    if (!currentUrl.includes("naver.com")) {
      throw new Error(`Connection test failed: unexpected URL ${currentUrl}`);
    }

    await this.delay(2000);
    return true;
  }

  /**
   * 프록시 검증 (프록시가 작동하는지 확인 - IP를 가져올 수 있는지만 체크)
   * IP는 UI 표시용으로만 사용
   * 전체 검증 과정에 10초 타임아웃 적용
   */
  async validateProxy(): Promise<{
    valid: boolean;
    actualIp?: string;
    error?: string;
  }> {
    if (!this.browser) {
      return { valid: false, error: "Browser not started" };
    }

    const TIMEOUT_MS = 10000; // 10초 타임아웃

    try {
      // 전체 검증 과정에 타임아웃 적용
      const result = await Promise.race([
        this.doValidateProxy(),
        new Promise<{ valid: false; error: string }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                valid: false,
                error: "Proxy validation timeout (10s)",
              }),
            TIMEOUT_MS,
          ),
        ),
      ]);

      return result;
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * 실제 프록시 검증 로직 (내부용)
   */
  private async doValidateProxy(): Promise<{
    valid: boolean;
    actualIp?: string;
    error?: string;
  }> {
    try {
      const page = await this.getPage();

      // 외부 IP 확인 API 호출 (여러 서비스 순차 시도)
      const ipServices = [
        "https://api.ipify.org?format=json",
        "https://api.my-ip.io/ip.json",
        "https://ipapi.co/json/",
      ];

      let actualIp: string | undefined;

      for (const serviceUrl of ipServices) {
        try {
          const response = await page.evaluate(async (url: string) => {
            const res = await fetch(url, { method: "GET" });
            return await res.json();
          }, serviceUrl);

          if (response.ip) {
            actualIp = response.ip;
            break;
          } else if (typeof response === "string") {
            actualIp = response;
            break;
          }
        } catch {
          // 다음 서비스 시도
        }
      }

      if (!actualIp) {
        return { valid: false, error: "Failed to retrieve IP" };
      }

      return { valid: true, actualIp };
    } catch (error: any) {
      return { valid: false, error: error.message };
    }
  }

  // ========================================
  // Browser 조작
  // ========================================

  /**
   * 첫 번째 페이지 가져오기 (탭이 1개만 있다고 가정)
   */
  async getPage(): Promise<any> {
    if (!this.browser) {
      throw new Error("Browser not started");
    }

    const pages = await this.browser.pages();
    if (pages.length === 0) {
      throw new Error("No pages available");
    }

    return pages[0];
  }

  /**
   * 현재 URL 가져오기
   */
  async getCurrentUrl(): Promise<string> {
    const page = await this.getPage();
    return page.url();
  }

  /**
   * 리소스 차단 설정 (실시간 제어 가능)
   * 브라우저 시작 시 한 번만 호출, 이후 setImageBlocking()으로 제어
   */
  async setupResourceBlocking(): Promise<void> {
    if (!this.browser || this.requestInterceptionSetup) return;

    const page = await this.getPage();

    await page.setRequestInterception(true);
    page.on("request", (request: any) => {
      const resourceType = request.resourceType();

      // 이미지 차단 (blockImages 플래그에 따라 동적 제어)
      if (this.blockImages && resourceType === "image") {
        request.abort();
      } else {
        request.continue();
      }
    });

    this.requestInterceptionSetup = true;
    console.log(`[CrawlerBrowser] ${this.profileName} - 리소스 차단 설정 완료`);
  }

  /**
   * 이미지 차단 설정 (실시간 변경 가능, 브라우저 reload 불필요)
   * @param block true: 이미지 차단, false: 이미지 허용
   */
  setImageBlocking(block: boolean): void {
    const changed = this.blockImages !== block;
    this.blockImages = block;
    if (changed) {
      console.log(
        `[CrawlerBrowser] ${this.profileName} - 이미지 차단: ${block ? "ON" : "OFF"}`,
      );
    }
  }

  /**
   * 현재 이미지 차단 상태 확인
   */
  isImageBlocked(): boolean {
    return this.blockImages;
  }

  // ========================================
  // 창 위치/크기 관리
  // ========================================

  /**
   * 탭 정리 (첫 번째 탭만 유지)
   */
  private async cleanupTabs(): Promise<void> {
    if (!this.browser) return;

    const pages = await this.browser.pages();

    if (pages.length > 1) {
      const closePromises = pages
        .slice(1)
        .map((page: any) => page.close().catch(() => {}));
      await Promise.all(closePromises);
      await this.delay(500);
    }
  }

  /**
   * 브라우저 프로세스가 살아있는지 확인
   */
  async isAlive(): Promise<boolean> {
    if (!this.browser) return false;
    try {
      await this.browser.pages();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Keepalive (WebSocket 연결 유지 + 죽음 감지)
   */
  async keepalive(): Promise<void> {
    if (!this.browser) return;

    try {
      await this.browser.pages();
    } catch {
      // 연결 실패 → 브라우저 죽음 감지 (restarting 중이면 무시)
      if (this.status !== 'error' && this.status !== 'restarting' && this.status !== 'stopped') {
        console.log(`[CrawlerBrowser] ${this.profileName} - keepalive 실패, 브라우저 죽음 감지`);
        this.browser = undefined;
        this.requestInterceptionSetup = false;
        this.updateStatus('error', 'Browser process died');
      }
    }
  }

  // ========================================
  // 상태 관리
  // ========================================

  /**
   * 상태 업데이트
   */
  updateStatus(status: BrowserStatus, message?: string): void {
    this.status = status;
    this.message = message;

    // error 상태면 error 필드도 업데이트
    if (status === "error" && message) {
      this.error = message;
    }

    // 상태 변경 시 일부 필드 초기화
    if (status === "ready" || status === "waiting") {
      this.storeName = undefined;
      this.collectedCount = undefined;
    }
  }

  /**
   * 크롤링 작업 시작
   */
  startCrawling(storeName: string): void {
    this.updateStatus("crawling", "크롤링 중...");
    this.storeName = storeName;
    this.collectedCount = undefined;
  }

  /**
   * 크롤링 작업 완료
   */
  completeCrawling(
    status: "success" | "warning" | "error",
    message: string,
    collectedCount?: number,
  ): void {
    this.updateStatus(status, message);
    this.collectedCount = collectedCount;
  }

  /**
   * 현재 상태 정보 반환 (읽기 전용)
   */
  getStatus(): BrowserStatusInfo {
    return {
      profileId: this.profileId,
      profileName: this.profileName,
      status: this.status,
      proxyGroupName: this.proxyGroupName,
      proxyIp: this.proxyIp ? `${this.proxyIp}:${this.proxyPort}` : undefined,
      storeName: this.storeName,
      message: this.message,
      collectedCount: this.collectedCount,
      error: this.error,
    };
  }

  /**
   * 브라우저가 준비되었는지 확인
   */
  isReady(): boolean {
    return this.status === "ready" && !!this.browser;
  }

  /**
   * 에러 상태인지 확인
   */
  hasError(): boolean {
    return this.status === "error";
  }

  /**
   * 브라우저 인스턴스가 있는지 확인
   */
  hasBrowser(): boolean {
    return !!this.browser;
  }

  // ========================================
  // Getters (읽기 전용 접근)
  // ========================================

  getProfileId(): string {
    return this.profileId;
  }

  getProfileName(): string {
    return this.profileName;
  }

  getProxyId(): number | undefined {
    return this.proxyId;
  }

  getProxyIp(): string | undefined {
    return this.proxyIp;
  }

  getProxyGroupId(): number | undefined {
    return this.proxyGroupId;
  }

  getProxyGroupName(): string | undefined {
    return this.proxyGroupName;
  }

  getBrowser(): any {
    return this.browser;
  }

  /**
   * Proxy Group 설정
   */
  setProxyGroup(groupId: number, groupName: string): void {
    this.proxyGroupId = groupId;
    this.proxyGroupName = groupName;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  // ========================================
  // Utils
  // ========================================

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

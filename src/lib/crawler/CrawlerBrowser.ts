/**
 * CrawlerBrowser 도메인 객체 (DDD Pattern)
 *
 * 하나의 브라우저/프로필에 대한 모든 정보와 행위를 통합 관리
 * - Profile 정보 및 수정 기능
 * - Browser 제어 (start/stop/restart)
 * - Proxy 관리
 * - 상태 관리
 */

import * as gologin from "../../services/gologin";
import type { Proxy } from "../proxy-pool";

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
  private glInstance?: any; // GologinApi instance (for exit)

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
   * Proxy 할당 (메모리만 업데이트, GoLogin 업데이트는 updateProxySettings 호출 필요)
   */
  private assignProxy(proxy: Proxy): void {
    this.proxyId = proxy.id;
    this.proxyIp = proxy.ip;
    this.proxyPort = proxy.port;
    this.proxyUsername = proxy.username;
    this.proxyPassword = proxy.password;
  }

  /**
   * GoLogin 프로필에 Proxy 설정 업데이트
   */
  async updateProxySettings(proxy: Proxy): Promise<void> {
    const proxyData = {
      mode: 'http',
      host: proxy.ip,
      port: parseInt(proxy.port, 10),
      username: proxy.username || '',
      password: proxy.password || '',
    };

    await gologin.changeProfileProxy(this.apiKey, this.profileId, proxyData);

    // 성공 시 메모리 업데이트
    this.assignProxy(proxy);
  }

  /**
   * 프로필 핑거프린트 설정 강화 (webRTC, canvas, webGL 등)
   */
  async hardenFingerprint(): Promise<void> {
    const { updated, changes } = await gologin.hardenProfile(this.apiKey, this.profileId);
    if (updated) {
      console.log(`[CrawlerBrowser] ${this.profileName} - 핑거프린트 강화: ${changes.join(', ')}`);
    }
  }

  /**
   * GoLogin은 항상 클린 브라우저를 실행하므로 탭 설정 초기화 불필요 (no-op)
   */
  async clearTabSettings(): Promise<void> {
    // GoLogin launches clean - no action needed
  }

  // ========================================
  // Browser 제어 (Start/Stop/Restart)
  // ========================================

  /**
   * 브라우저 시작 (GoLogin SDK)
   */
  async start(options?: {
    validateConnection?: boolean;
    validateProxy?: boolean;
  }): Promise<void> {
    const validateProxy = options?.validateProxy ?? false;
    const validateConnection = options?.validateConnection ?? false;

    this.updateStatus("starting", "브라우저 시작 중...");

    try {
      // 1. GoLogin SDK로 브라우저 실행 (SDK가 puppeteer Browser를 직접 반환)
      const { browser, glInstance } = await gologin.launchBrowser(
        this.apiKey,
        this.profileId,
      );

      this.browser = browser;
      this.glInstance = glInstance;

      // 2. 브라우저 초기화 대기
      await this.delay(2000);

      // 3. 탭 정리 (1개만 유지)
      await this.cleanupTabs();

      // 4. 리소스 차단 설정 (실시간 제어 가능)
      await this.setupResourceBlocking();

      // 6. 프록시 검증 (선택적)
      let proxyValidated = false;
      if (validateProxy) {
        const maxRetries = 2;
        let lastError = "";

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const result = await this.validateProxy();

          if (result.valid) {
            if (result.actualIp) {
              this.proxyIp = result.actualIp;
            }
            proxyValidated = true;
            break;
          }

          lastError = result.error || "Unknown error";

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
   * 브라우저 중지 (GoLogin SDK exit)
   */
  async stop(): Promise<void> {
    // 종료 전 안전한 페이지로 이동 (세션 복원 시 크롤링 페이지 대신 example.com 열리도록)
    if (this.browser) {
      try {
        const pages = await this.browser.pages();
        if (pages.length > 0) {
          await pages[0].evaluate(() => window.stop()).catch(() => {});
          await pages[0].goto('https://www.example.com', {
            waitUntil: 'domcontentloaded',
            timeout: 10000,
          });
          console.log(`[CrawlerBrowser] ${this.profileName} - 종료 전 example.com 이동 완료`);
        }
      } catch (e: any) {
        console.log(`[CrawlerBrowser] ${this.profileName} - 종료 전 example.com 이동 실패: ${e.message}`);
      }
    }

    // GoLogin SDK exit 호출 (내부적으로 browser.close() + stopLocal 수행)
    if (this.glInstance) {
      try {
        await gologin.exitBrowser(this.glInstance);
      } catch {
        // 종료 실패 시 puppeteer로 직접 종료 시도
        if (this.browser) {
          try {
            await this.browser.close();
          } catch {
            // 무시
          }
        }
      }
      this.glInstance = undefined;
    } else if (this.browser) {
      // glInstance 없으면 puppeteer로 직접 종료
      try {
        await this.browser.close();
      } catch {
        // 무시
      }
    }

    this.browser = undefined;

    // 리소스 차단 설정 플래그 리셋 (재시작 시 다시 설정할 수 있도록)
    this.requestInterceptionSetup = false;

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
      await this.stop();
      await this.delay(2000);

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
        this.glInstance = undefined;
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

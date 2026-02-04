/**
 * CrawlerBrowser 도메인 객체 (DDD Pattern)
 *
 * 하나의 브라우저/프로필에 대한 모든 정보와 행위를 통합 관리
 * - Profile 정보 및 수정 기능
 * - Browser 제어 (start/stop/restart)
 * - Proxy 관리
 * - 상태 관리
 */

import puppeteer from "puppeteer-core";
import { adsPowerQueue } from "./adspower-queue";
import * as adspower from "../../services/adspower";
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
  private browserData?: any; // AdsPower API response

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
   * AdsPower 프로필에 Proxy 설정 업데이트
   */
  async updateProxySettings(proxy: Proxy): Promise<void> {
    const updateData: any = {
      user_proxy_config: {
        proxy_soft: "other",
        proxy_type: "http",
        proxy_host: proxy.ip,
        proxy_port: proxy.port,
      },
    };

    if (proxy.username) {
      updateData.user_proxy_config.proxy_user = proxy.username;
    }
    if (proxy.password) {
      updateData.user_proxy_config.proxy_password = proxy.password;
    }

    const result = await adspower.updateProfile(
      this.apiKey,
      this.profileId,
      updateData,
    );

    if (result.code !== 0) {
      throw new Error(`Failed to update proxy: ${result.msg}`);
    }

    // 성공 시 메모리 업데이트
    this.assignProxy(proxy);
  }

  /**
   * AdsPower 프로필의 탭 설정 초기화 (빈 탭 1개만 열림)
   */
  async clearTabSettings(): Promise<void> {
    const updateData = {
      domain_name: "",
      open_urls: [],
      homepage: "",
      tab_urls: [],
    };

    const result = await adspower.updateProfile(
      this.apiKey,
      this.profileId,
      updateData,
    );

    if (result.code !== 0) {
      throw new Error(`Failed to clear tab settings: ${result.msg}`);
    }
  }

  // ========================================
  // Browser 제어 (Start/Stop/Restart)
  // ========================================

  /**
   * 브라우저 시작 (AdsPower + Puppeteer 연결)
   */
  async start(options?: {
    validateConnection?: boolean;
    validateProxy?: boolean;
  }): Promise<void> {
    const validateConnection = options?.validateConnection ?? false;
    const validateProxy = options?.validateProxy ?? false;

    this.updateStatus("starting", "브라우저 시작 중...");

    try {
      // 1. AdsPower 브라우저 시작
      const startResult = await adsPowerQueue.startBrowser(
        this.apiKey,
        this.profileId,
      );

      if (startResult.code !== 0) {
        throw new Error(
          `AdsPower API failed: ${startResult.msg} (code: ${startResult.code})`,
        );
      }

      const wsUrl = startResult.data?.ws?.puppeteer;
      if (!wsUrl) {
        throw new Error("WebSocket URL not found in AdsPower response");
      }

      // 2. Puppeteer 연결
      this.browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
      });
      this.browserData = startResult.data;

      // 3. 브라우저 초기화 대기
      await this.delay(2000);

      // 4. 탭 정리 (1개만 유지)
      await this.cleanupTabs();

      // 5. 이미지/미디어 차단 설정 (성능 최적화) - 비활성화
      // await this.setupResourceBlocking();

      // 6. AdsPower에 설정된 실제 프록시 정보 동기화
      try {
        const profileInfo = await this.getProfileInfo();
        if (profileInfo.user_proxy_config) {
          const proxyConfig = profileInfo.user_proxy_config;

          if (proxyConfig.proxy_soft === "luminati") {
            const host = proxyConfig.host || "";
            const ipMatch = host.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (ipMatch) {
              this.proxyIp = ipMatch[1];
            }
          } else if (proxyConfig.proxy_host) {
            this.proxyIp = proxyConfig.proxy_host;
            this.proxyPort = proxyConfig.proxy_port;
          }
        }
      } catch {
        // 프록시 정보 동기화 실패는 무시
      }

      // 7. 프록시 검증 (선택적)
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

      // 8. 연결 테스트 (프록시 검증이 성공했으면 스킵)
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
   * 브라우저 중지 (Puppeteer 연결 해제 + AdsPower 중지)
   */
  async stop(): Promise<void> {
    // Puppeteer 연결 해제
    if (this.browser) {
      try {
        await this.browser.disconnect();
      } catch {
        // 연결 해제 실패는 무시
      }
      this.browser = undefined;
    }

    // AdsPower 브라우저 중지
    try {
      await adsPowerQueue.stopBrowser(this.apiKey, this.profileId);
    } catch {
      // 중지 실패는 무시
    }

    this.updateStatus("stopped", "중지됨");
  }

  /**
   * 브라우저 재시작 (중복 방지)
   */
  async restart(newProxy?: Proxy, maxRetries: number = 3): Promise<void> {
    // 중복 재시작 방지
    if (this.isRestarting) {
      // 최대 30초 대기
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
      // 1. 기존 브라우저 중지
      await this.stop();
      await this.delay(2000);

      // 2. Proxy 업데이트 (새 Proxy가 제공된 경우)
      if (newProxy) {
        await this.updateProxySettings(newProxy);
        await this.delay(2000);
      }

      // 3. 브라우저 재시작 (재시도 로직)
      let lastError: Error | undefined;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.start({ validateProxy: true, validateConnection: false });
          return;
        } catch (error: any) {
          lastError = error;

          if (attempt < maxRetries) {
            const backoffMs = Math.min(Math.pow(2, attempt) * 1500, 30000);
            await this.delay(backoffMs);
          }
        }
      }

      // 모든 재시도 실패
      throw new Error(`Restart failed: ${lastError?.message}`);
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
          setTimeout(() => resolve({ valid: false, error: "Proxy validation timeout (10s)" }), TIMEOUT_MS)
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

  /**
   * 프로필 정보 조회 (AdsPower API)
   */
  async getProfileInfo(): Promise<any> {
    const result = await adspower.getProfile(this.apiKey, this.profileId);
    if (result.code !== 0) {
      throw new Error(`Failed to get profile info: ${result.msg}`);
    }
    return result.data;
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
   * 이미지/미디어 리소스 차단 설정 (성능 최적화)
   */
  private async setupResourceBlocking(): Promise<void> {
    if (!this.browser) return;

    const page = await this.getPage();

    await page.setRequestInterception(true);
    page.on("request", (request: any) => {
      const resourceType = request.resourceType();
      // 이미지, 스타일시트, 폰트, 미디어 차단
      if (["image", "stylesheet", "font", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });
  }

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
   * Keepalive (WebSocket 연결 유지)
   */
  async keepalive(): Promise<void> {
    if (!this.browser) return;

    try {
      await this.browser.pages();
    } catch {
      // Keepalive 실패는 무시
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

  // ========================================
  // Utils
  // ========================================

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

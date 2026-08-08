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
import type { ProxyLease } from "../proxy-pool";
import { ProfileGoneError, StopUnconfirmedError } from "../errors";

/** 정지 확인 폴링 — 확인되지 않으면 lease 를 반납하지 않는다(트래픽 잔존 위험) */
const STOP_CONFIRM_ATTEMPTS = 5;
const STOP_CONFIRM_INTERVAL_MS = 1_000;

/**
 * 페인트 경로 프로브. rAF 는 정상이면 1프레임(≈16ms) 안에 발화하므로 2.5s 면 충분히 관대하다.
 * 실측: 정상 즉시 PAINT_OK, wedge 는 무응답.
 */
const PAINT_PROBE_TIMEOUT_MS = 2_500;
const PAINT_RELOAD_TIMEOUT_MS = 20_000;
/** 연속 이 횟수만큼 rAF 가 무응답이어야 조치한다(keepalive 주기 60s → 실질 1분 지속 확인). */
const PAINT_FAIL_STREAK_TO_ACT = 2;

/**
 * puppeteer 는 dynamic import 라 타입을 직접 못 쓴다. 여기서 쓰는 표면만 최소로 선언한다.
 * (`any` 를 쓰지 않으면서 evaluate/reload 를 타입 안전하게 호출하기 위함)
 */
interface PuppeteerPage {
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  reload(options: { waitUntil: string; timeout: number }): Promise<unknown>;
}

/**
 * `{ data: { ws: { puppeteer } } }` 에서 ws 엔드포인트를 안전하게 꺼낸다.
 * 브로커는 게이트웨이 페이지·잘린 본문 등 무엇이든 돌려줄 수 있어 형태 가정이 불가하다.
 */
function extractWsEndpoint(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return undefined;
  const data = payload.data;
  if (!data || typeof data !== "object" || !("ws" in data)) return undefined;
  const ws = data.ws;
  if (!ws || typeof ws !== "object" || !("puppeteer" in ws)) return undefined;
  const endpoint = ws.puppeteer;
  return typeof endpoint === "string" && endpoint.length > 0 ? endpoint : undefined;
}

/**
 * `{ data: { status: "Active" } }` 인지 판별.
 * 형태를 알 수 없는 응답은 Active 로 보지 않는다 — 정지 확인 경로에서 이 판단이
 * 잘못되면 살아있는 브라우저를 정지했다고 믿고 프록시를 반납해 IP 를 공유하게 된다.
 */
function isActiveStatus(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return false;
  const data = payload.data;
  if (!data || typeof data !== "object" || !("status" in data)) return false;
  return data.status === "Active";
}

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
  platform?: string;
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
  lease?: ProxyLease;
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
  /**
   * 보유 중인 프록시 사용권. 소유권의 진실은 DB 이고 이건 그 사본이 아니라 '핸들'이다.
   * 반납은 반드시 이 lease 로 해야 하며(소유권 검증), 없으면 반납할 것이 없다.
   */
  private lease: ProxyLease | null = null;
  /** updateProfile 성공 여부. false 면 AdsPower 는 아직 이 프록시를 모른다 */
  private proxyApplied = false;
  /** 프록시 검증에서 관측된 실제 egress IP (표시용) */
  private observedIp?: string;

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
  private platform?: string;
  private error?: string;

  // 의존성
  private readonly apiKey: string;

  // 재시작 중복 방지


  // 이미지 차단 플래그 (실시간 제어 가능)
  private blockImages: boolean = false;
  private requestInterceptionSetup: boolean = false;
  /** 페인트 경로 정지 감지·복구 누적 (health 노출) */
  private paintStuckCount = 0;
  private paintRecoveredCount = 0;
  /** rAF 연속 무응답 횟수. 단발 스로틀을 wedge 로 오판하지 않기 위한 완충. */
  private paintFailStreak = 0;


  // ========================================
  // Constructor
  // ========================================

  constructor(config: CrawlerBrowserConfig) {
    this.profileId = config.profileId;
    this.profileName = config.profileName;
    this.apiKey = config.apiKey;
    this.proxyGroupId = config.proxyGroupId ?? 1;
    if (config.lease) this.lease = config.lease;


    if (config.proxyGroupName) {
      this.proxyGroupName = config.proxyGroupName;
    }
  }

  // ========================================
  // Profile 관리 (Proxy, Tabs)
  // ========================================

  /** 보유 lease 조회 */
  getLease(): ProxyLease | null {
    return this.lease;
  }

  /**
   * 보유 lease 를 떼어내 반환한다(소유권 이전).
   * 호출자가 반납 책임을 가져가므로, 이 브라우저는 더 이상 그 프록시를 자기 것으로 주장하지 않는다.
   */
  takeLease(): ProxyLease | null {
    const held = this.lease;
    this.lease = null;
    this.proxyApplied = false;
    return held;
  }

  isProxyApplied(): boolean {
    return this.proxyApplied;
  }

  /**
   * 새 lease 를 AdsPower 프로필에 적용하고 브라우저를 시작한다.
   *
   * `proxyApplied` 는 updateProfile 이 **성공한 뒤에만** true 가 된다. 이 플래그가 false 인 동안은
   * AdsPower 가 아직 이 프록시를 모르므로, 호출자는 "이 브라우저가 이 IP 로 트래픽을 낸다"고
   * 가정해선 안 된다(I3).
   */
  async startWithLease(lease: ProxyLease): Promise<void> {
    this.lease = lease;
    this.proxyApplied = false;
    this.observedIp = undefined;
    this.updateStatus("starting", `프록시 적용 중 ${lease.ip}:${lease.port}`);

    await adsPowerQueue.enqueue(`updateProfile ${this.profileId}`, () =>
      adspower.updateProfile(this.apiKey, this.profileId, {
        user_proxy_config: {
          proxy_type: "http",
          proxy_host: lease.ip,
          proxy_port: lease.port,
          proxy_user: lease.username ?? "",
          proxy_password: lease.password ?? "",
          proxy_soft: "other",
        },
        open_urls: ["https://www.naver.com"],
      }),
    );
    this.proxyApplied = true;

    await this.start();
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
      // browser/start 는 브로커가 재시도하지 않는다.
      //
      // 이전 구현은 브로커 5xx/타임아웃 시 checkBrowserStatus 로 "이미 돌고 있는 인스턴스"를
      // 채택했다. 그러나 그 인스턴스가 **우리가 방금 설정한 프록시로 기동됐다는 증거가 없다**
      // (AdsPower 는 프록시를 기동 시점에 바인딩한다). 정지 실패로 살아남은 구 인스턴스를
      // 채택하면 헌 IP 로 크롤하면서 성공을 보고하고, 그 프록시는 이미 반납돼 다른 브라우저에
      // 배정된다 → I1·I3 동시 위반. 게다가 모든 호출부가 validateProxy:false 라 탐지 불가였다.
      //
      // 따라서 채택하지 않는다. 결과 불명이면 **확인된 정지로 정리한 뒤 던진다** — 호출자가
      // 깨끗하게 재시도한다. 고아 프로세스도 이 정지로 함께 회수된다.
      const result = await adsPowerQueue
        .startBrowser(this.apiKey, this.profileId)
        .catch(async (error: unknown) => {
          await this.stop().catch(() => undefined);
          throw error;
        });

      // 브로커/AdsPower 응답은 검증되지 않은 외부 입력이므로 형태를 확인하고 꺼낸다.
      const wsEndpoint = extractWsEndpoint(result);
      if (!wsEndpoint) {
        throw new Error("AdsPower did not return WebSocket endpoint");
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
              this.observedIp = validationResult.actualIp;
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
    } catch (error: unknown) {
      // 연결 확립 후 후속 단계에서 던지면 CDP 연결이 새므로 반드시 끊는다.
      // (이전 구현은 this.browser 를 그대로 남겨 재시도마다 websocket 이 누적됐다)
      this.disconnect();
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus("error", message);
      throw error;
    }
  }

  /**
   * Puppeteer 연결만 해제 (AdsPower 호출 없음). 상태는 바꾸지 않는다 —
   * "연결이 끊겼다"와 "프로세스가 정지했다"는 다른 사실이고, 후자는 stop() 만 단정할 수 있다.
   */
  disconnect(): void {
    if (this.browser) {
      try {
        this.browser.disconnect();
      } catch {
        // 이미 연결이 끊어진 경우 무시
      }
      this.browser = undefined;
    }
    this.requestInterceptionSetup = false;
  }

  /**
   * 확인된 정지 (REDESIGN §4).
   *
   * 이전 구현은 AdsPower stop 실패를 로그만 남기고 무조건 status='stopped' 로 바꿨다.
   * 그러면 실제로는 살아있는 브라우저가 헌 프록시로 계속 트래픽을 내는데 호출자는 정지했다고
   * 믿고 그 프록시를 반납한다 → 다른 브라우저가 같은 IP 를 받는다(I1/I3). 고아 Chromium 이
   * 쌓여 메모리 고갈 사고로도 이어졌다.
   *
   * 여기서는 checkBrowserStatus 로 Inactive 를 **확인**하고, 확인하지 못하면 던진다.
   * 호출자는 이 경우 **lease 를 반납하지 말고** zombie 로 격리해야 한다.
   */
  async stop(): Promise<void> {
    this.disconnect();

    try {
      await adsPowerQueue.stopBrowser(this.apiKey, this.profileId);
    } catch (error: unknown) {
      // 프로필이 없으면 그 프로세스도 없다 → 정지로 간주한다.
      if (!(error instanceof ProfileGoneError)) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!(await this.confirmInactive())) {
          this.updateStatus("error", `정지 미확인: ${detail}`);
          throw new StopUnconfirmedError(this.profileId, detail);
        }
        this.updateStatus("stopped", "중지됨(확인)");
        return;
      }
    }

    if (!(await this.confirmInactive())) {
      this.updateStatus("error", "정지 미확인");
      throw new StopUnconfirmedError(this.profileId, "checkBrowserStatus 가 Active 를 계속 보고");
    }
    this.updateStatus("stopped", "중지됨");
  }

  /** AdsPower 가 이 프로필을 Inactive 로 보고할 때까지 유한 폴링 */
  private async confirmInactive(): Promise<boolean> {
    for (let attempt = 1; attempt <= STOP_CONFIRM_ATTEMPTS; attempt++) {
      try {
        const res = await adsPowerQueue.enqueue(`active ${this.profileId}`, () =>
          adspower.checkBrowserStatus(this.apiKey, this.profileId),
        );
        // 브로커 응답은 검증되지 않은 외부 입력이다. Active 라고 확실히 말하지 않는 응답은
        // "Active 아님"으로 보지 않고 재확인한다(정지 확인은 보수적으로 판단해야 안전하다).
        if (!isActiveStatus(res)) return true;
      } catch (error: unknown) {
        if (error instanceof ProfileGoneError) return true;
        // 브로커 장애로 확인 자체가 불가 — 남은 시도로 재확인한다.
      }
      if (attempt < STOP_CONFIRM_ATTEMPTS) await this.delay(STOP_CONFIRM_INTERVAL_MS);
    }
    return false;
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
   * ⚠️ 결함 있음 — 재가동 전 반드시 `KNOWN_ISSUES.md` §1 을 읽을 것.
   * 아래 rAF 프로브는 프로덕션에서 **대규모 오탐**을 냈다(정지확정 182 / 복구 1,
   * 13개 프로필에 균등 분포, 가동 슬롯 13→10). 부하 상태(loadavg 11~16)에서는 정상
   * 브라우저도 2.5초 안에 프레임이 스케줄되지 않기 때문이다. 이 상태로 기동하면
   * 멀쩡한 브라우저가 계속 재활용된다. **관측 전용으로 낮추거나 제거하고 쓸 것.**
   *
   * Keepalive — 연결 생존 + **페인트 경로 생존**까지 확인한다.
   *
   * JS 실행만 확인하면 "살아있는데 화면이 안 그려지는" 브라우저를 놓친다. 실측 사례:
   * 렌더러의 JS 스레드는 멀쩡해 `evaluate` 가 통과하고 CDP 도 URL/title 을 정상 응답하는데
   * 컴포지터만 wedge 되어 창이 검게 남았다(스크린샷은 타임아웃). 이 상태에서도 크롤은
   * `__PRELOADED_STATE__` 를 evaluate 로 읽어 계속 되므로 어떤 지표에도 잡히지 않았고,
   * health 는 `operational` 로 보고했다 — 무인 운영에서 며칠씩 방치될 수 있는 무증상 열화다.
   *
   * 탐지는 `requestAnimationFrame` 으로 한다. rAF 콜백은 컴포지터가 프레임을 스케줄해야
   * 실행되므로 페인트 경로가 막히면 발화하지 않는다(정상 PAINT_OK / wedge TIMEOUT 실측 확인).
   * 스크린샷 대비 비용이 거의 없다.
   *
   * 복구는 **강제 리로드 먼저** 시도한다. wedge 상태에서도 히스토리 네비게이션(goBack)은
   * 계속 성공하지만 컴포지터를 재사용해 페인트가 돌아오지 않았고, 리로드는 복구시켰다(실측).
   * 리로드로도 안 되면 error 로 전환해 기존 복구 경로가 브라우저를 재활용하게 한다.
   */
  async keepalive(): Promise<void> {
    if (!this.browser) return;
    // 'starting'/'crawling' 도 건드리지 않는다 — 다른 태스크가 그 브라우저를 조작 중이며,
    // 여기서 browser 를 비우면 그 태스크가 "Browser not started" 로 죽는다.
    if (
      this.status === "error" ||
      this.status === "restarting" ||
      this.status === "stopped" ||
      this.status === "starting" ||
      this.status === "crawling"
    ) {
      return;
    }

    let page: PuppeteerPage | undefined;
    try {
      const pages = await this.browser.pages();
      if (pages.length === 0) return;
      page = pages[0] as PuppeteerPage;
      // Frame 레벨 health check: 실제 JavaScript 실행 가능한지 확인
      await page.evaluate(() => 1);
    } catch {
      // 연결 실패 또는 frame stale → 브라우저 죽음 감지
      console.log(`[CrawlerBrowser] ${this.profileName} - keepalive 실패, 브라우저 죽음 감지`);
      this.browser = undefined;
      this.requestInterceptionSetup = false;
      this.updateStatus("error", "Browser process died");
      return;
    }

    if (await this.paintAlive(page)) {
      this.paintFailStreak = 0;
      return;
    }

    // 1회 실패로는 조치하지 않는다. Chromium 은 가려지거나 디스플레이가 잠든 창의 rAF 를
    // 스로틀할 수 있어, 단발 무응답을 wedge 로 단정하면 fleet 전체가 동시에 리로드될 수 있다.
    // (현 구성에서는 15개 전부 rAF 통과를 실측했지만, 환경 변화에 대비한 방어선이다)
    this.paintFailStreak++;
    if (this.paintFailStreak < PAINT_FAIL_STREAK_TO_ACT) {
      console.log(
        `[CrawlerBrowser] ${this.profileName} - rAF 무응답 ${this.paintFailStreak}회 (연속 ${PAINT_FAIL_STREAK_TO_ACT}회부터 조치)`,
      );
      return;
    }

    this.paintStuckCount++;
    console.warn(
      `[CrawlerBrowser] ${this.profileName} - 페인트 경로 정지 확정(rAF 연속 ${this.paintFailStreak}회 무응답) — 강제 리로드`,
    );
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: PAINT_RELOAD_TIMEOUT_MS });
    } catch (error: unknown) {
      console.warn(
        `[CrawlerBrowser] ${this.profileName} - 리로드 실패: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (await this.paintAlive(page)) {
      this.paintRecoveredCount++;
      this.paintFailStreak = 0;
      console.log(`[CrawlerBrowser] ${this.profileName} - ✓ 리로드로 페인트 복구`);
      return;
    }

    // 리로드로도 안 되면 브라우저 자체를 재활용해야 한다.
    console.warn(`[CrawlerBrowser] ${this.profileName} - 리로드 후에도 페인트 정지 — 재활용 대상으로 표시`);
    this.paintFailStreak = 0; // 재활용 경로로 넘기므로 카운터는 초기화
    this.updateStatus("error", "페인트 경로 정지(리로드 실패)");
  }

  /**
   * 페인트 경로 생존 확인. rAF 콜백은 컴포지터가 프레임을 스케줄해야만 실행된다.
   * 타임아웃/예외는 모두 "살아있지 않음"으로 본다(보수적 판정).
   */
  private async paintAlive(page: PuppeteerPage): Promise<boolean> {
    try {
      const probe = page.evaluate(
        () => new Promise<boolean>((resolve) => requestAnimationFrame(() => resolve(true))),
      );
      const timeout = Promise.withResolvers<boolean>();
      const timer = setTimeout(() => timeout.resolve(false), PAINT_PROBE_TIMEOUT_MS);
      try {
        return await Promise.race([probe, timeout.promise]);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  /** 페인트 정지 감지·복구 횟수 (health 노출용) */
  paintStats(): { stuck: number; recovered: number } {
    return { stuck: this.paintStuckCount, recovered: this.paintRecoveredCount };
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

    // ready 상태에서만 초기화 (waiting은 이전 작업 정보 유지)
    // ready 진입 시 직전 에러를 지운다. 남겨두면 회복된 브라우저의 상태·로그에 죽은 에러가
    // 계속 실려 나가 로그를 부풀리고 원인 추적을 방해한다.
    if (status === "ready") {
      this.storeName = undefined;
      this.platform = undefined;
      this.collectedCount = undefined;
      this.error = undefined;
    }
  }

  /**
   * 크롤링 작업 시작
   */
  startCrawling(storeName: string, platform?: string): void {
    this.updateStatus("crawling", "크롤링 중...");
    this.storeName = storeName;
    this.platform = platform;
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
      platform: this.platform,
      proxyGroupName: this.proxyGroupName,
      proxyIp: this.observedIp ?? (this.lease ? `${this.lease.ip}:${this.lease.port}` : undefined),
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

  getProxyGroupId(): number {
    return this.proxyGroupId ?? 1;
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
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }
}

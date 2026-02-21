/**
 * AdsPower API 작업 큐 매니저 (싱글톤)
 * - 초당 2회 rate limiting (600ms 간격)
 * - 모든 AdsPower API 호출을 순차적으로 처리
 * - 브라우저 start/stop은 중복 방지 기능 포함
 */

import * as adspower from "../../services/adspower";

interface QueueTask {
  label: string;
  fn: () => Promise<any>;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

class AdsPowerQueueManager {
  private static instance: AdsPowerQueueManager;
  private queue: QueueTask[] = [];
  private processing: boolean = false;
  private lastRequestTime: number = 0;
  private readonly MIN_INTERVAL_MS = 600; // 안전 마진 포함 (120 RPM = 500ms + 100ms 여유)

  // 현재 작업 중인 브라우저 추적 (start/stop 중복 방지)
  private activeBrowsers: Set<string> = new Set();

  private constructor() {}

  static getInstance(): AdsPowerQueueManager {
    if (!AdsPowerQueueManager.instance) {
      AdsPowerQueueManager.instance = new AdsPowerQueueManager();
    }
    return AdsPowerQueueManager.instance;
  }

  /**
   * 범용 API 호출 큐 (모든 AdsPower API 호출에 사용)
   */
  async enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        fn,
        resolve,
        reject,
      });

      console.log(`[AdsPowerQueue] Queued: ${label} (queue size: ${this.queue.length})`);
      this.processQueue();
    });
  }

  /**
   * 브라우저 시작 요청 (큐에 추가 + 중복 방지)
   */
  async startBrowser(apiKey: string, profileId: string): Promise<any> {
    // 이미 처리 중인 브라우저면 대기
    while (this.activeBrowsers.has(profileId)) {
      console.log(`[AdsPowerQueue] Browser ${profileId} is already being processed, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeBrowsers.add(profileId);

    try {
      const result = await this.enqueue(
        `start ${profileId}`,
        () => adspower.startBrowser(apiKey, profileId),
      );
      return result;
    } finally {
      this.activeBrowsers.delete(profileId);
    }
  }

  /**
   * 브라우저 중지 요청 (큐에 추가 + 중복 방지)
   */
  async stopBrowser(apiKey: string, profileId: string): Promise<any> {
    // 이미 처리 중인 브라우저면 대기
    while (this.activeBrowsers.has(profileId)) {
      console.log(`[AdsPowerQueue] Browser ${profileId} is already being processed, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeBrowsers.add(profileId);

    try {
      const result = await this.enqueue(
        `stop ${profileId}`,
        () => adspower.stopBrowser(apiKey, profileId),
      );
      return result;
    } finally {
      this.activeBrowsers.delete(profileId);
    }
  }

  /**
   * 큐 처리 (순차적, rate limiting 적용)
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;

      // Rate limiting: 마지막 요청 이후 최소 간격 대기
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.MIN_INTERVAL_MS) {
        const waitTime = this.MIN_INTERVAL_MS - elapsed;
        console.log(`[AdsPowerQueue] Rate limiting - waiting ${waitTime}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // API 호출
      try {
        console.log(`[AdsPowerQueue] Processing: ${task.label}`);
        const result = await task.fn();
        this.lastRequestTime = Date.now();
        task.resolve(result);
      } catch (error) {
        this.lastRequestTime = Date.now();
        task.reject(error);
      }
    }

    this.processing = false;
  }

  /**
   * 현재 큐 상태 조회
   */
  getStats() {
    return {
      queueSize: this.queue.length,
      activeBrowsers: Array.from(this.activeBrowsers),
      processing: this.processing,
    };
  }
}

// 싱글톤 인스턴스 export
export const adsPowerQueue = AdsPowerQueueManager.getInstance();

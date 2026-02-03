/**
 * AdsPower API 작업 큐 매니저 (싱글톤)
 * - 초당 2회 rate limiting
 * - 브라우저별 중복 작업 방지
 * - 순차적 처리 보장
 */

import * as adspower from "../../services/adspower";

interface AdsPowerTask {
  type: "start" | "stop";
  profileId: string;
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

class AdsPowerQueueManager {
  private static instance: AdsPowerQueueManager;
  private queue: AdsPowerTask[] = [];
  private processing: boolean = false;
  private lastRequestTime: number = 0;
  private readonly MIN_INTERVAL_MS = 500; // 초당 2회 = 500ms 간격

  // 현재 작업 중인 브라우저 추적 (중복 방지)
  private activeBrowsers: Set<string> = new Set();

  private constructor() {}

  static getInstance(): AdsPowerQueueManager {
    if (!AdsPowerQueueManager.instance) {
      AdsPowerQueueManager.instance = new AdsPowerQueueManager();
    }
    return AdsPowerQueueManager.instance;
  }

  /**
   * 브라우저 시작 요청 (큐에 추가)
   */
  async startBrowser(apiKey: string, profileId: string): Promise<any> {
    // 이미 처리 중인 브라우저면 대기
    while (this.activeBrowsers.has(profileId)) {
      console.log(`[AdsPowerQueue] Browser ${profileId} is already being processed, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeBrowsers.add(profileId);

    return new Promise((resolve, reject) => {
      this.queue.push({
        type: "start",
        profileId,
        resolve: (result) => {
          this.activeBrowsers.delete(profileId);
          resolve(result);
        },
        reject: (error) => {
          this.activeBrowsers.delete(profileId);
          reject(error);
        },
      });

      console.log(`[AdsPowerQueue] Start request queued for ${profileId} (queue size: ${this.queue.length})`);
      this.processQueue(apiKey);
    });
  }

  /**
   * 브라우저 중지 요청 (큐에 추가)
   */
  async stopBrowser(apiKey: string, profileId: string): Promise<any> {
    // 이미 처리 중인 브라우저면 대기
    while (this.activeBrowsers.has(profileId)) {
      console.log(`[AdsPowerQueue] Browser ${profileId} is already being processed, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    this.activeBrowsers.add(profileId);

    return new Promise((resolve, reject) => {
      this.queue.push({
        type: "stop",
        profileId,
        resolve: (result) => {
          this.activeBrowsers.delete(profileId);
          resolve(result);
        },
        reject: (error) => {
          this.activeBrowsers.delete(profileId);
          reject(error);
        },
      });

      console.log(`[AdsPowerQueue] Stop request queued for ${profileId} (queue size: ${this.queue.length})`);
      this.processQueue(apiKey);
    });
  }

  /**
   * 큐 처리 (순차적, rate limiting 적용)
   */
  private async processQueue(apiKey: string): Promise<void> {
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
        console.log(`[AdsPowerQueue] Processing ${task.type} request for ${task.profileId}`);
        let result;

        if (task.type === "start") {
          result = await adspower.startBrowser(apiKey, task.profileId);
        } else {
          result = await adspower.stopBrowser(apiKey, task.profileId);
        }

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

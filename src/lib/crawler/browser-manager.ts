/**
 * BrowserManager - CrawlerBrowser 인스턴스 관리 (싱글톤 - DDD 패턴)
 *
 * 역할:
 * - CrawlerBrowser 인스턴스들의 생명주기 관리
 * - 브라우저 준비 (그룹별 프록시 할당 + 테스트)
 * - 크롤링에서 재사용할 브라우저 제공
 */

import { CrawlerBrowser, type BrowserStatusInfo } from "./CrawlerBrowser";
import { adsPowerQueue } from "./adspower-queue";
import { getProxyPool } from "../proxy-pool";
import * as adspower from "../../services/adspower";
import * as db from "../../database/sqlite";

// 프로필 정보
interface Profile {
  user_id: string;
  name: string;
}

// 준비 결과
export interface PreparationResult {
  success: boolean;
  profileId: string;
  profileName: string;
  proxyGroupName?: string;
  proxyIp?: string;
  error?: string;
}

class BrowserManager {
  private browsers: Map<string, CrawlerBrowser> = new Map();
  private apiKey: string = "";
  /**
   * API Key 설정
   */
  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * API Key 가져오기
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * 모든 브라우저 준비 (그룹 할당 + 브라우저 실행 확인만)
   * 프록시 IP 할당은 크롤링 시작 시 changeAllBrowserIPs에서 수행
   */
  async prepareBrowsers(
    profiles: Profile[],
    onProgress?: (index: number, total: number, result: PreparationResult) => void
  ): Promise<PreparationResult[]> {
    const results: PreparationResult[] = [];

    // 기존 브라우저 정리
    await this.clear();

    // 프록시 그룹 목록 조회
    const proxyGroups = db.getProxyGroups() as { id: number; name: string; max_browsers: number }[];
    console.log(`[BrowserManager] Found ${proxyGroups.length} proxy groups`);

    if (proxyGroups.length === 0) {
      console.error("[BrowserManager] No proxy groups found!");
      return profiles.map((p) => ({
        success: false,
        profileId: p.user_id,
        profileName: p.name,
        error: "프록시 그룹이 없습니다",
      }));
    }

    // 그룹별 브라우저 할당 계산
    const groupAssignments: { groupId: number; groupName: string }[] = [];
    let remainingBrowsers = profiles.length;
    let groupIndex = 0;

    while (remainingBrowsers > 0 && groupIndex < proxyGroups.length) {
      const group = proxyGroups[groupIndex];
      const assignCount = Math.min(group.max_browsers, remainingBrowsers);

      for (let i = 0; i < assignCount; i++) {
        groupAssignments.push({
          groupId: group.id,
          groupName: group.name,
        });
      }

      remainingBrowsers -= assignCount;
      groupIndex++;
    }

    // 그룹 할당 수가 프로필 수보다 적으면 초과 프로필은 스킵
    if (remainingBrowsers > 0) {
      console.log(`[BrowserManager] ${remainingBrowsers} profiles exceed group capacity, will be skipped`);
    }

    console.log(`[BrowserManager] Group assignments: ${groupAssignments.map((g) => g.groupName).join(", ")} (${groupAssignments.length}/${profiles.length})`);

    // 할당된 프로필에 대해서만 브라우저 준비 (병렬, concurrency=10)
    const BATCH_SIZE = 10;
    for (let batchStart = 0; batchStart < groupAssignments.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, groupAssignments.length);
      const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);

      // 첫 배치가 아니면 짧은 대기 (API rate limit은 큐가 관리)
      if (batchStart > 0) {
        await this.delay(500);
      }

      console.log(`[BrowserManager] Processing batch ${batchStart + 1}-${batchEnd}/${groupAssignments.length}`);

      await Promise.all(batchIndices.map(async (i) => {
        const profile = profiles[i];
        const assignment = groupAssignments[i];

        console.log(`[BrowserManager] Preparing browser ${i + 1}/${groupAssignments.length}: ${profile.name} [${assignment.groupName}]`);

        // CrawlerBrowser 생성
        const browser = new CrawlerBrowser({
          profileId: profile.user_id,
          profileName: profile.name,
          apiKey: this.apiKey,
          proxyGroupId: assignment.groupId,
          proxyGroupName: assignment.groupName,
        });

        // 인스턴스 등록 (브라우저 실행은 크롤링 시작 시 changeAllBrowserIPs에서 수행)
        this.browsers.set(profile.user_id, browser);

        const result: PreparationResult = {
          success: true,
          profileId: profile.user_id,
          profileName: profile.name,
          proxyGroupName: assignment.groupName,
        };
        results.push(result);

        console.log(`[BrowserManager] ${profile.name} [${assignment.groupName}] - ✓ 등록 완료`);

        // 진행 상황 콜백
        if (onProgress) {
          onProgress(i, profiles.length, result);
        }
      }));
    }

    // 그룹 용량 초과로 할당되지 않은 프로필은 실패 처리
    for (let i = groupAssignments.length; i < profiles.length; i++) {
      const profile = profiles[i];
      const skipResult: PreparationResult = {
        success: false,
        profileId: profile.user_id,
        profileName: profile.name,
        error: '그룹 최대 브라우저 수 초과',
      };
      results.push(skipResult);

      if (onProgress) {
        onProgress(i, profiles.length, skipResult);
      }
    }

    const successCount = results.filter((r) => r.success).length;
    console.log(`[BrowserManager] Preparation complete: ${successCount}/${profiles.length} browsers ready`);

    return results;
  }

  /**
   * 준비된 브라우저 목록 반환
   */
  getBrowsers(): CrawlerBrowser[] {
    return Array.from(this.browsers.values());
  }

  /**
   * 특정 브라우저 조회
   */
  getBrowser(profileId: string): CrawlerBrowser | undefined {
    return this.browsers.get(profileId);
  }

  /**
   * 준비된 브라우저 수
   */
  getReadyCount(): number {
    return this.browsers.size;
  }

  /**
   * 브라우저 상태 목록 조회
   */
  getStatuses(): BrowserStatusInfo[] {
    return this.getBrowsers().map((b) => b.getStatus());
  }

  /**
   * 모든 브라우저 정리 (크롤링 종료 시)
   */
  async clear(): Promise<void> {
    console.log(`[BrowserManager] Clearing ${this.browsers.size} browsers...`);

    const proxyPool = getProxyPool();

    for (const browser of this.browsers.values()) {
      try {
        // 프록시 release (in_use → active)
        const proxyId = browser.getProxyId();
        const groupId = browser.getProxyGroupId();
        if (proxyId) {
          proxyPool.releaseProxy(proxyId, groupId);
        }
        await browser.stop();
      } catch {
        // 무시
      }
    }

    this.browsers.clear();
  }

  /**
   * 브라우저 존재 여부
   */
  hasBrowsers(): boolean {
    return this.browsers.size > 0;
  }

  /**
   * Keepalive: 모든 브라우저에 WebSocket 유지
   */
  async keepalive(): Promise<void> {
    for (const browser of this.browsers.values()) {
      try {
        await browser.keepalive();
      } catch {
        // 무시
      }
    }
  }

  /**
   * 브라우저 인스턴스 교체 (프로필 재생성 시 Map 키 변경)
   */
  replaceBrowser(oldProfileId: string, newBrowser: CrawlerBrowser): void {
    this.browsers.delete(oldProfileId);
    this.browsers.set(newBrowser.getProfileId(), newBrowser);
    console.log(`[BrowserManager] Browser replaced: ${oldProfileId} → ${newBrowser.getProfileId()}`);
  }

  /**
   * 프로필 재생성 (CAPTCHA 차단 시 완전한 새 identity)
   * 순서: 새 프로필 생성 → 핑거프린트 강화 → 새 CrawlerBrowser 반환 → 구 프로필 삭제
   */
  async recreateProfile(oldBrowser: CrawlerBrowser): Promise<CrawlerBrowser> {
    const oldProfileId = oldBrowser.getProfileId();
    const profileName = oldBrowser.getProfileName();
    const proxyGroupId = oldBrowser.getProxyGroupId();
    const proxyGroupName = oldBrowser.getProxyGroupName();

    console.log(`[BrowserManager] Recreating profile for ${profileName} (old: ${oldProfileId})`);

    // 1. 구 브라우저 종료
    try {
      await oldBrowser.stop();
    } catch {
      // 이미 죽어있을 수 있음
    }

    // 2. 새 프로필 생성 (AdsPower API - 큐를 통해 rate limit 준수)
    const createResult = await adsPowerQueue.enqueue(
      `createProfile ${profileName}`,
      () => adspower.createProfile(this.apiKey, {
        name: profileName,
        group_id: '0',
        fingerprint_config: {
          language: ['ko-KR', 'ko', 'en-US', 'en'],
          random_ua: {
            ua_browser: ['chrome'],
            ua_system_version: ['Windows 10', 'Windows 11', 'Mac OS X 12', 'Mac OS X 13'],
          },
        },
        user_proxy_config: {
          proxy_soft: 'no_proxy',
        },
      }),
    );
    const newProfileId = createResult.data?.id;
    if (!newProfileId) {
      throw new Error('AdsPower createProfile did not return profile id');
    }
    console.log(`[BrowserManager] New profile created: ${newProfileId} (name: ${profileName})`);

    // 3. 새 CrawlerBrowser 인스턴스 생성
    const newBrowser = new CrawlerBrowser({
      profileId: newProfileId,
      profileName,
      apiKey: this.apiKey,
      proxyGroupId,
      proxyGroupName,
    });

    // 4. Map 교체
    this.replaceBrowser(oldProfileId, newBrowser);

    // 5. 구 프로필 삭제 (안전하게 마지막에, 큐를 통해 rate limit 준수)
    try {
      await adsPowerQueue.enqueue(
        `deleteProfile ${oldProfileId}`,
        () => adspower.deleteProfile(this.apiKey, oldProfileId),
      );
      console.log(`[BrowserManager] Old profile deleted: ${oldProfileId}`);
    } catch (e: any) {
      console.log(`[BrowserManager] Old profile delete failed (무시): ${e.message}`);
    }

    return newBrowser;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// 싱글톤 인스턴스
let instance: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!instance) {
    instance = new BrowserManager();
  }
  return instance;
}

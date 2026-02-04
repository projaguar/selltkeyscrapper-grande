/**
 * BrowserManager - CrawlerBrowser 인스턴스 관리 (싱글톤 - DDD 패턴)
 *
 * 역할:
 * - CrawlerBrowser 인스턴스들의 생명주기 관리
 * - 브라우저 준비 (그룹별 프록시 할당 + 테스트)
 * - 크롤링에서 재사용할 브라우저 제공
 */

import { CrawlerBrowser, type BrowserStatusInfo } from "./CrawlerBrowser";
import { getProxyPool } from "../proxy-pool";
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
   * 모든 브라우저 준비 (그룹별 프록시 할당 + 테스트)
   */
  async prepareBrowsers(
    profiles: Profile[],
    onProgress?: (index: number, total: number, result: PreparationResult) => void
  ): Promise<PreparationResult[]> {
    const results: PreparationResult[] = [];
    const proxyPool = getProxyPool();

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

    // 남은 브라우저가 있으면 마지막 그룹에 할당
    if (remainingBrowsers > 0) {
      const lastGroup = proxyGroups[proxyGroups.length - 1];
      for (let i = 0; i < remainingBrowsers; i++) {
        groupAssignments.push({
          groupId: lastGroup.id,
          groupName: lastGroup.name,
        });
      }
    }

    console.log(`[BrowserManager] Group assignments: ${groupAssignments.map((g) => g.groupName).join(", ")}`);

    // 각 프로필에 대해 브라우저 준비
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const assignment = groupAssignments[i];

      console.log(`[BrowserManager] Preparing browser ${i + 1}/${profiles.length}: ${profile.name} [${assignment.groupName}]`);

      // CrawlerBrowser 생성
      const browser = new CrawlerBrowser({
        profileId: profile.user_id,
        profileName: profile.name,
        apiKey: this.apiKey,
        proxyGroupId: assignment.groupId,
        proxyGroupName: assignment.groupName,
      });

      // 프록시 할당 + 브라우저 시작 + 테스트 (최대 10회 재시도)
      const result = await this.prepareWithRetry(browser, assignment.groupId, assignment.groupName, proxyPool);

      results.push(result);

      // 성공 시 저장
      if (result.success) {
        this.browsers.set(profile.user_id, browser);
      }

      // 진행 상황 콜백
      if (onProgress) {
        onProgress(i, profiles.length, result);
      }
    }

    const successCount = results.filter((r) => r.success).length;
    console.log(`[BrowserManager] Preparation complete: ${successCount}/${profiles.length} browsers ready`);

    return results;
  }

  /**
   * 프록시 재시도 로직 포함 브라우저 준비
   */
  private async prepareWithRetry(
    browser: CrawlerBrowser,
    groupId: number,
    groupName: string,
    proxyPool: ReturnType<typeof getProxyPool>
  ): Promise<PreparationResult> {
    const maxRetries = 10;
    const profileName = browser.getProfileName();
    const profileId = browser.getProfileId();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 그룹에서 프록시 가져오기
        const proxy = proxyPool.getNextProxyByGroup(groupId);

        if (!proxy) {
          console.log(`[BrowserManager] ${profileName} - No available proxies in group ${groupName}`);
          return {
            success: false,
            profileId,
            profileName,
            proxyGroupName: groupName,
            error: `그룹 "${groupName}"에 사용 가능한 프록시가 없습니다`,
          };
        }

        console.log(`[BrowserManager] ${profileName} [${groupName}] - 프록시 시도 ${attempt}/${maxRetries}: ${proxy.ip}:${proxy.port}`);

        // 프록시 설정 업데이트
        await browser.updateProxySettings(proxy);

        // 프록시 in_use로 표시
        proxyPool.markInUse(proxy.id);

        // 탭 설정 초기화
        await browser.clearTabSettings();

        // 브라우저 시작 + 프록시 테스트
        await browser.start({ validateProxy: true, validateConnection: false });

        console.log(`[BrowserManager] ${profileName} [${groupName}] - ✓ 준비 완료: ${proxy.ip}:${proxy.port}`);

        return {
          success: true,
          profileId,
          profileName,
          proxyGroupName: groupName,
          proxyIp: `${proxy.ip}:${proxy.port}`,
        };
      } catch (error: any) {
        console.log(`[BrowserManager] ${profileName} [${groupName}] - ✗ 시도 ${attempt} 실패: ${error.message}`);

        // 기존 프록시 dead 처리
        const oldProxyId = browser.getProxyId();
        if (oldProxyId) {
          proxyPool.markDead(oldProxyId);
        }

        // 브라우저 종료
        try {
          await browser.stop();
        } catch {
          // 무시
        }

        // 대기 없이 바로 재시도
      }
    }

    return {
      success: false,
      profileId,
      profileName,
      proxyGroupName: groupName,
      error: `${maxRetries}개 프록시 모두 실패`,
    };
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

    for (const browser of this.browsers.values()) {
      try {
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

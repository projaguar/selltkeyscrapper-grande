/**
 * BrowserManager - CrawlerBrowser 인스턴스 관리 (싱글톤)
 *
 * 역할:
 * - CrawlerBrowser 인스턴스들의 생명주기 관리 (프록시 그룹 라운드로빈 배정 포함)
 * - 프로필 재생성(차단/소멸 시 새 identity) 과 그룹 리컨실(고아 프로필 회수)
 *
 * REDESIGN.md 대응:
 * - **P5**: 정지는 확인된 정지다. `stop()` 이 `StopUnconfirmedError` 를 던지면 프로필 삭제도,
 *   lease 반납도 하지 않는다. 확인 없이 삭제하면 어떤 API 로도 멈출 수 없는 좀비 프로세스가 남고,
 *   확인 없이 반납하면 그 IP 로 아직 트래픽을 내는 브라우저와 다른 브라우저가 IP 를 공유한다(I1/I3).
 * - **P6**: `clear()` 는 병렬 + 전체 데드라인이다. 순차 루프에서는 한 건의 정지 확인이 늘어지면
 *   나머지 전원의 lease 반납이 막혀 다음 사이클이 프록시 고갈로 시작됐다.
 * - **§6/R5**: `reconcileGroupProfiles` 는 프록시 리컨실의 미러다. 프로필 삭제 실패·크래시·
 *   추적 안 된 생성이 쌓이면 계정 quota 를 잠식하고, quota 에 걸린 순간 풀 확보가 조용히 미달한다.
 * - **P7/I7**: 삭제 대상은 응답의 `group_id` 재검증을 통과한 것뿐이다. 같은 AdsPower 인스턴스에
 *   prowler 프로필이 있으므로 그룹 밖/미분류 프로필은 어떤 경우에도 대상이 아니다.
 */

import { CrawlerBrowser, type BrowserStatusInfo } from "./CrawlerBrowser";
import { adsPowerQueue } from "./adspower-queue";
import { getProxyPool } from "../proxy-pool";
import { getLifecycleLock } from "../lifecycle-lock";
import { ProfileGoneError, StopUnconfirmedError } from "../errors";
import * as adspower from "../../services/adspower";
import {
  LIST_DEADLINE_MS,
  buildDesktopProfilePayload,
  extractProfileId,
  filterProfilesInGroup,
  gracedProfileIds,
  noteProfileCreated,
} from "./profile-pool";
import * as db from "../../database/sqlite";

/** clear 전체 상한. 한 브라우저의 정지 확인이 늘어져도 나머지 lease 반납을 막지 못하게 한다. */
const CLEAR_DEADLINE_MS = 45_000;
/** clear 의 per-profile 락 대기. 전체 데드라인보다 짧아야 데드라인이 실제로 의미를 갖는다. */
const CLEAR_LOCK_DEADLINE_MS = 30_000;
/** 준비 배치 크기 — API 간격은 큐가 관리하고, 여기서는 동시 시작 폭만 제한한다. */
const PREPARE_BATCH_SIZE = 10;
/** 고아 삭제 배치. 전량을 한 요청에 넣으면 부분 실패 시 어디까지 지워졌는지 알 수 없다. */
const ORPHAN_DELETE_BATCH = 10;

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

/** 데드라인 타이머. race 후 반드시 cancel 해 타이머가 이벤트 루프를 붙잡지 않게 한다. */
function deadline(ms: number): { expired: Promise<void>; cancel: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  return { expired: promise, cancel: () => clearTimeout(timer) };
}

class BrowserManager {
  private browsers: Map<string, CrawlerBrowser> = new Map();
  private apiKey: string = "";
  private groupId: string = "";

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
   * scrapper 전용 AdsPower 그룹 ID(문자열) 설정 — 프로필 생성/삭제 스코프의 유일한 경계.
   */
  setGroupId(groupId: string): void {
    this.groupId = groupId;
  }

  getGroupId(): string {
    return this.groupId;
  }

  /**
   * 모든 브라우저 준비 (인스턴스 등록 + 프록시 그룹 배정)
   * 프록시 lease 획득과 브라우저 실행은 크롤링 시작 시 수행한다.
   */
  async prepareBrowsers(
    profiles: Profile[],
    onProgress?: (index: number, total: number, result: PreparationResult) => void
  ): Promise<PreparationResult[]> {
    // 기존 브라우저 정리
    await this.clear();

    // bun:sqlite 는 행을 unknown 으로 돌려주고 스키마는 initDatabase 가 보장한다.
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

    // 각 프로필을 프록시 그룹에 라운드로빈 배정 — 개수 제한 없이 profileCount 그대로 사용.
    // (프록시 그룹 max_browsers 로 브라우저 수를 줄이지 않음: '동시 프로필 개수'가 유일한 상한)
    const groupAssignments = profiles.map((_, i) => {
      const group = proxyGroups[i % proxyGroups.length];
      return { groupId: group.id, groupName: group.name };
    });

    console.log(`[BrowserManager] Group assignments: ${groupAssignments.map((g) => g.groupName).join(", ")} (${groupAssignments.length}/${profiles.length})`);

    // 완료 순서가 아니라 프로필 순서로 채운다 — 호출자가 인덱스로 프로필과 대조한다.
    const results: PreparationResult[] = new Array(profiles.length);

    for (let batchStart = 0; batchStart < groupAssignments.length; batchStart += PREPARE_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + PREPARE_BATCH_SIZE, groupAssignments.length);
      const batchIndices = Array.from({ length: batchEnd - batchStart }, (_, k) => batchStart + k);

      // 첫 배치가 아니면 짧은 대기 (API rate limit은 큐가 관리)
      if (batchStart > 0) {
        await Bun.sleep(500);
      }

      console.log(`[BrowserManager] Processing batch ${batchStart + 1}-${batchEnd}/${groupAssignments.length}`);

      await Promise.all(batchIndices.map(async (i) => {
        const profile = profiles[i];
        const assignment = groupAssignments[i];

        console.log(`[BrowserManager] Preparing browser ${i + 1}/${groupAssignments.length}: ${profile.name} [${assignment.groupName}]`);

        // proxyGroupId 는 항상 정의된다(그룹이 없으면 위에서 조기 반환) — 미정의 프록시 그룹으로
        // lease 를 획득하려 하면 고갈과 구별되지 않는 무음 실패가 된다.
        const browser = new CrawlerBrowser({
          profileId: profile.user_id,
          profileName: profile.name,
          apiKey: this.apiKey,
          proxyGroupId: assignment.groupId,
          proxyGroupName: assignment.groupName,
        });

        this.browsers.set(profile.user_id, browser);

        const result: PreparationResult = {
          success: true,
          profileId: profile.user_id,
          profileName: profile.name,
          proxyGroupName: assignment.groupName,
        };
        results[i] = result;

        console.log(`[BrowserManager] ${profile.name} [${assignment.groupName}] - ✓ 등록 완료`);

        if (onProgress) {
          onProgress(i, profiles.length, result);
        }
      }));
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
   * 모든 브라우저 정리 (크롤링 종료 시).
   * 브라우저마다 **정지 확인 → lease 반납** 순서로, per-profile 락 안에서, 병렬로 수행한다.
   * 반대 순서(반납 후 정지)는 아직 그 IP 로 트래픽을 내는 브라우저의 프록시를 다른 브라우저가
   * 획득하게 만든다 — 모델 검증에서 이 순서를 뒤집으면 즉시 I1/I3 이 깨진다.
   */
  async clear(): Promise<void> {
    const browsers = Array.from(this.browsers.values());
    // 맵을 먼저 비운다: 정리 중인 인스턴스를 워커나 리컨실이 다시 집어 새 lease 를 붙이면
    // 반납 대상이 이동해 원장과 현실이 갈린다.
    this.browsers.clear();
    if (browsers.length === 0) return;

    console.log(`[BrowserManager] Clearing ${browsers.length} browsers...`);

    const proxyPool = getProxyPool();
    const lock = getLifecycleLock();
    const unfinished = new Set(browsers.map((b) => b.getProfileId()));

    const tasks = browsers.map(async (browser) => {
      const profileId = browser.getProfileId();
      try {
        await lock.run(
          profileId,
          async () => {
            await browser.stop();
            const lease = browser.takeLease();
            if (lease) proxyPool.release(lease);
          },
          CLEAR_LOCK_DEADLINE_MS,
        );
      } catch (e) {
        if (e instanceof StopUnconfirmedError) {
          console.warn(
            `[BrowserManager] ${profileId} 정지 미확인 — lease 반납 보류. 그 IP 로 트래픽이 남아 ` +
              `있을 수 있으므로 지금 반납하면 다른 브라우저와 IP 를 공유한다. 리컨실이 grace 후 회수한다`,
          );
        } else if (e instanceof ProfileGoneError) {
          // 프로필이 상류에서 사라졌으면 그 브라우저 프로세스도 없다 → 반납이 안전하고,
          // 보류하면 그 프록시가 grace 동안 통째로 유휴가 된다.
          const lease = browser.takeLease();
          if (lease) proxyPool.release(lease);
          console.warn(`[BrowserManager] ${profileId} 프로필 소멸 — lease 즉시 반납`);
        } else {
          console.error(
            `[BrowserManager] ${profileId} 정리 실패: ${e instanceof Error ? e.message : String(e)} ` +
              `— 정지를 확인하지 못했으므로 lease 반납 보류`,
          );
        }
      } finally {
        unfinished.delete(profileId);
      }
    });

    const limit = deadline(CLEAR_DEADLINE_MS);
    try {
      await Promise.race([Promise.allSettled(tasks), limit.expired]);
    } finally {
      limit.cancel();
    }

    if (unfinished.size > 0) {
      console.error(
        `[BrowserManager] clear 데드라인 ${CLEAR_DEADLINE_MS}ms 초과 — 미완료 ${unfinished.size}개 ` +
          `(${Array.from(unfinished).join(", ")}). 남은 lease 는 리컨실 타이머가 회수한다`,
      );
    }
  }

  /**
   * 브라우저 존재 여부
   */
  hasBrowsers(): boolean {
    return this.browsers.size > 0;
  }

  /**
   * Keepalive: 모든 브라우저에 WebSocket 유지.
   * 병렬로 수행한다 — 순차 루프에서는 응답 없는 한 건이 뒤쪽 전원의 keepalive 를 굶겼다.
   */
  async keepalive(): Promise<void> {
    await Promise.allSettled(this.getBrowsers().map((b) => b.keepalive()));
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
   * 프로필 재생성 (차단/소멸 시 완전한 새 identity).
   * 순서: **정지 확인 → 구 프로필 삭제 → 신규 생성**.
   *
   * - 정지를 확인하지 못하면 `StopUnconfirmedError` 를 그대로 던진다. 살아있는 브라우저의
   *   프로필을 삭제하면 그 프로세스는 어떤 API 로도 멈출 수 없는 좀비가 되어 메모리를 소진한다.
   *   호출자가 zombie 로 격리해야 한다.
   * - create-then-delete 는 순간 N+1 프로필을 요구한다. 무료 tier(계정 총 2개)에서는 재생성
   *   자체가 QuotaError 로 막히므로, 순간 N-1 을 감수하고 삭제를 먼저 한다.
   * - 생성 실패(QuotaError 등)는 그대로 전파한다 — 호출자가 park 한다.
   * - 헌 lease 는 건드리지 않는다. 반납은 호출자가 락 안에서 `old.takeLease()` 로 수행한다 —
   *   여기서 먼저 떼어내면 호출자의 반납이 조용히 no-op 이 되어 반납 책임이 두 곳으로 쪼개진다.
   */
  async recreateProfile(oldBrowser: CrawlerBrowser): Promise<CrawlerBrowser> {
    const oldProfileId = oldBrowser.getProfileId();
    const profileName = oldBrowser.getProfileName();
    const proxyGroupId = oldBrowser.getProxyGroupId();
    const proxyGroupName = oldBrowser.getProxyGroupName();

    if (!this.groupId) {
      // 그룹 없이 만들면 미분류 프로필이 되어 리컨실의 시야 밖에 영구히 남는다(I7).
      throw new Error("[BrowserManager] scrapper 그룹 id 가 없어 프로필 재생성 불가");
    }

    console.log(`[BrowserManager] Recreating profile for ${profileName} (old: ${oldProfileId})`);

    await oldBrowser.stop();

    try {
      await adsPowerQueue.enqueue(`deleteProfile ${oldProfileId}`, () =>
        adspower.deleteProfile(this.apiKey, oldProfileId),
      );
      console.log(`[BrowserManager] Old profile deleted: ${oldProfileId}`);
    } catch (e) {
      if (e instanceof ProfileGoneError) {
        console.log(`[BrowserManager] Old profile already gone: ${oldProfileId}`);
      } else {
        // 삭제 실패로 재생성을 포기하면 워커 하나가 영구히 죽는다. 남은 구 프로필은 그룹 내
        // 미소유 프로필이므로 reconcileGroupProfiles 가 회수한다.
        console.error(
          `[BrowserManager] Old profile delete failed (${oldProfileId}): ` +
            `${e instanceof Error ? e.message : String(e)} — 리컨실 회수 대상으로 넘기고 재생성 계속`,
        );
      }
    }

    const createRes = await adsPowerQueue.enqueue(`createProfile ${profileName}`, () =>
      adspower.createProfile(this.apiKey, buildDesktopProfilePayload(profileName, this.groupId)),
    );
    const newProfileId = extractProfileId(createRes);
    if (!newProfileId) {
      throw new Error(
        `[BrowserManager] createProfile 응답에서 id 를 읽지 못함 (요청 이름: ${profileName}) — ` +
          `프로필이 생성된 것으로 가정. reconcileGroupProfiles 가 그룹(${this.groupId}) 내 미소유 프로필로 회수한다`,
      );
    }
    // 어떤 await 보다 먼저 기록한다: 응답 유실이나 크래시가 뒤따라도 리컨실이 이 프로필을
    // 유예 대상으로 인식해야 갓 만든 프로필을 스스로 지우지 않는다.
    noteProfileCreated(newProfileId);
    console.log(`[BrowserManager] New profile created: ${newProfileId} (name: ${profileName})`);

    const newBrowser = new CrawlerBrowser({
      profileId: newProfileId,
      profileName,
      apiKey: this.apiKey,
      proxyGroupId,
      proxyGroupName,
    });
    this.replaceBrowser(oldProfileId, newBrowser);

    return newBrowser;
  }

  /**
   * 그룹 리컨실 (§6, R5) — 프록시 리컨실(§2.4)의 미러. 독립 타이머에서 호출한다.
   *
   * 그룹 내 프로필 중 어떤 holder 도 소유하지 않는 것을 삭제한다. 스코프는 `groupId` 로 엄격히
   * 제한되고, 응답의 `group_id` 재검증(P7)을 통과한 항목만 대상이다 — 그룹 밖/미분류 프로필은
   * 타 앱(prowler) 것일 수 있어 어떤 경우에도 삭제하지 않는다.
   *
   * @param ownedProfileIds 지금 살아있는 holder 들의 profileId 전체
   * @returns 삭제한 프로필 수
   */
  async reconcileGroupProfiles(ownedProfileIds: ReadonlySet<string>): Promise<number> {
    if (!this.apiKey || !this.groupId) {
      console.warn("[BrowserManager] 그룹 리컨실 생략: apiKey/그룹 id 미설정 — 삭제 스코프를 확정할 수 없음");
      return 0;
    }
    if (ownedProfileIds.size === 0) {
      // 빈 소유자 집합은 "아직 준비 전"과 "전부 고아"를 구별하지 못한다. 그대로 진행하면
      // 그룹 전체를 삭제해 다음 준비가 풀을 처음부터 다시 만들어야 한다.
      console.log("[BrowserManager] 그룹 리컨실 생략: 소유 프로필 집합이 비어 있음(준비 전/정리 후)");
      return 0;
    }

    const entries = await adsPowerQueue.enqueue(
      `listAllProfiles(group ${this.groupId})`,
      () => adspower.listAllProfiles(this.apiKey, this.groupId),
      { deadlineMs: LIST_DEADLINE_MS },
    );
    const inGroup = filterProfilesInGroup(entries, this.groupId, "reconcileGroupProfiles");
    const graced = gracedProfileIds();
    const orphans = inGroup.filter(
      (p) => !ownedProfileIds.has(p.user_id) && !graced.has(p.user_id),
    );
    if (orphans.length === 0) return 0;

    console.warn(
      `[BrowserManager] 그룹(${this.groupId}) 고아 프로필 ${orphans.length}개 회수: ` +
        `${orphans.map((p) => `${p.user_id}(${p.name})`).join(", ")} — ` +
        `그룹 ${inGroup.length}개 중 소유 ${ownedProfileIds.size}개, 유예 ${graced.size}개`,
    );

    let deleted = 0;
    for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_BATCH) {
      const ids = orphans.slice(i, i + ORPHAN_DELETE_BATCH).map((p) => p.user_id);
      try {
        await adsPowerQueue.enqueue(`deleteProfiles ${ids.length}`, () =>
          adspower.deleteProfiles(this.apiKey, ids),
        );
        deleted += ids.length;
      } catch (e) {
        if (e instanceof ProfileGoneError) {
          // 이미 없는 프로필 = 회수 완료.
          deleted += ids.length;
          continue;
        }
        // 브로커/앱 장애면 남은 배치도 같은 이유로 실패한다 — 다음 주기에 재시도한다.
        console.error(
          `[BrowserManager] 고아 프로필 삭제 실패 (${ids.join(", ")}): ` +
            `${e instanceof Error ? e.message : String(e)} — 남은 배치 중단, 다음 주기 재시도`,
        );
        break;
      }
    }

    console.warn(`[BrowserManager] 그룹 리컨실 완료: ${deleted}/${orphans.length}개 삭제`);
    return deleted;
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

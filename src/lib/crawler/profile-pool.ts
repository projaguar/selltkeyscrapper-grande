/**
 * ProfilePool - AdsPower 프로필 풀 자동 관리 (그룹 격리)
 *
 * 역할:
 * - scrapper 전용 AdsPower 그룹 안에서만 프로필을 관리하여 prowler 등 타 앱 프로필과 격리
 * - 목표 개수(count)에 맞춰 풀 유지:
 *   1) 그룹 내(=이 앱이 만든) 프로필 재사용
 *   2) 부족하면 데스크탑 지문으로 신규 생성
 * - ⚠️ 기존/미분류 프로필은 절대 건드리지 않는다(흡수/이동 없음). 오직 이 그룹 안에서만 생성/삭제.
 * - 블록 시 삭제 → 그룹 내 재생성 (browser-manager).
 *
 * 사용자 개입(수동 생성/삭제 UI) 없이 동작한다.
 */

import * as adspower from "../../services/adspower";
import { adsPowerQueue } from "./adspower-queue";


export interface PoolProfile {
  user_id: string;
  name: string;
  group_id?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPoolProfile(v: unknown): v is PoolProfile {
  if (!v || typeof v !== "object") return false;
  if (!("user_id" in v) || !("name" in v)) return false;
  return typeof v.user_id === "string" && typeof v.name === "string";
}

/** AdsPower user/list 응답에서 프로필 배열을 안전하게 추출 */
function extractProfiles(result: unknown): PoolProfile[] {
  if (!result || typeof result !== "object" || !("data" in result)) return [];
  const data = result.data;
  if (!data || typeof data !== "object" || !("list" in data)) return [];
  const list = data.list;
  if (!Array.isArray(list)) return [];
  return list.filter(isPoolProfile);
}

/** AdsPower user/create 응답에서 새 프로필 id 추출 */
function extractProfileId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("data" in result)) return undefined;
  const data = result.data;
  if (!data || typeof data !== "object" || !("id" in data)) return undefined;
  return typeof data.id === "string" ? data.id : undefined;
}

/** AdsPower group/list 응답에서 이름이 일치하는 group_id 추출 */
function findGroupId(result: unknown, name: string): string | undefined {
  if (!result || typeof result !== "object" || !("data" in result)) return undefined;
  const data = result.data;
  if (!data || typeof data !== "object" || !("list" in data)) return undefined;
  const list = data.list;
  if (!Array.isArray(list)) return undefined;
  for (const g of list) {
    if (g && typeof g === "object" && "group_name" in g && "group_id" in g && g.group_name === name) {
      return String(g.group_id);
    }
  }
  return undefined;
}

/**
 * 데스크탑 Chrome 지문 프로필 생성 payload.
 * BrowserManager.recreateProfile 과 동일한 지문(Windows/Mac, ko-KR, no_proxy)을 사용해
 * 풀 프로필과 재생성 프로필의 identity 를 일관되게 유지한다.
 */
export function buildDesktopProfilePayload(name: string, groupId: string) {
  return {
    name,
    group_id: groupId,
    fingerprint_config: {
      language: ["ko-KR", "ko", "en-US", "en"],
      random_ua: {
        ua_browser: ["chrome"],
        ua_system_version: ["Windows 10", "Windows 11", "Mac OS X 12", "Mac OS X 13"],
      },
    },
    user_proxy_config: {
      proxy_soft: "no_proxy",
    },
  };
}

export class ProfilePool {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * scrapper 전용 그룹을 보장하고 group_id 반환.
   */
  async ensureGroupId(groupName: string): Promise<string> {
    // listGroups → createGroup 을 각각 큐로 분리(초당 1회 한도 준수)
    const listRes = await adsPowerQueue.enqueue("listGroups", () =>
      adspower.listGroups(this.apiKey),
    );
    const existing = findGroupId(listRes, groupName);
    if (existing) {
      console.log(`[ProfilePool] 기존 그룹 재사용: ${groupName} (${existing})`);
      return existing;
    }
    const gid = await adsPowerQueue.enqueue(`createGroup ${groupName}`, () =>
      adspower.createGroup(this.apiKey, groupName),
    );
    console.log(`[ProfilePool] 그룹 생성: ${groupName} (${gid})`);
    return gid;
  }

  /**
   * 그룹 내 프로필 풀을 목표 개수(count)에 맞춰 보장한다.
   * 반환: 사용 가능한 프로필 목록(최대 count 개). 한도 초과 등으로 count 미달 시 있는 만큼 반환.
   */
  async ensurePool(groupId: string, count: number): Promise<PoolProfile[]> {
    // 그룹 내(이 앱이 만든) 기존 프로필
    const inGroupRes = await adsPowerQueue.enqueue("listProfiles(group)", () =>
      adspower.listProfiles(this.apiKey, 1, 100, groupId),
    );
    const inGroup = extractProfiles(inGroupRes);
    console.log(`[ProfilePool] 그룹(${groupId}) 내 프로필 ${inGroup.length}개 / 목표 ${count}`);

    if (inGroup.length >= count) {
      return inGroup.slice(0, count);
    }

    const pool: PoolProfile[] = [...inGroup];
    const need = count - inGroup.length;

    // 부족분만큼 신규 생성 (기존 프로필은 절대 건드리지 않음)
    for (let i = 0; i < need; i++) {
      const name = `scrapper-${Date.now()}-${i}`;
      try {
        const createRes = await adsPowerQueue.enqueue(`createProfile ${name}`, () =>
          adspower.createProfile(this.apiKey, buildDesktopProfilePayload(name, groupId)),
        );
        const id = extractProfileId(createRes);
        if (id) {
          pool.push({ user_id: id, name, group_id: groupId });
          console.log(`[ProfilePool] 새 프로필 생성: ${id} (${name})`);
        } else {
          console.warn(`[ProfilePool] createProfile 응답에 id 없음 (${name})`);
        }
      } catch (e) {
        console.error(
          `[ProfilePool] 프로필 생성 실패 (${name}): ${errMsg(e)} — 현재 ${pool.length}개로 진행`,
        );
        break; // 한도 초과 등: 확보된 만큼으로 진행
      }
    }

    return pool.slice(0, count);
  }
}

// 싱글톤 (apiKey 변경 시 재생성)
let instance: ProfilePool | null = null;

export function getProfilePool(apiKey: string): ProfilePool {
  if (!instance || instance.getApiKey() !== apiKey) {
    instance = new ProfilePool(apiKey);
  }
  return instance;
}

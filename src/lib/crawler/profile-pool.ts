/**
 * ProfilePool - AdsPower 프로필 풀 자동 관리 (그룹 격리)
 *
 * 역할:
 * - scrapper 전용 AdsPower 그룹 안에서만 프로필을 관리하여 prowler 등 타 앱 프로필과 격리
 * - 목표 개수(count)에 맞춰 풀 유지: 그룹 내 프로필 재사용 → 부족분만 데스크탑 지문으로 신규 생성
 *
 * REDESIGN.md 대응:
 * - **P7/I7**: 그룹 소속을 요청 파라미터가 아니라 **응답의 `group_id` 로 재검증**한다.
 *   같은 AdsPower 인스턴스에 prowler 프로필이 있고 재생성·리컨실 경로가 프로필을 *삭제*하므로,
 *   이 재검증이 빠지면 타 앱이 파괴된다. 요청에 group_id 를 실어보냈다는 사실은 증거가 아니다.
 * - **P1**: `user/list` / `group/list` 는 전 페이지를 순회한다. 1페이지(100건) 가정은 그룹이
 *   100 을 넘는 순간 소유 프로필을 안 보이게 만들고, 매 실행마다 중복 생성이 누적됐다.
 * - **§6**: 그룹 id 는 결정적으로 선택한다. 이름 중복이 허용되므로 이름만으로 찾으면 rename /
 *   페이지 누락 / 앞뒤 공백 하나로 중복 `scrapper` 그룹이 생기고, 이전 그룹의 프로필이 영구히
 *   보이지 않게 된다.
 */

import * as adspower from "../../services/adspower";
import { adsPowerQueue } from "./adspower-queue";
import * as db from "../../database/sqlite";

/**
 * 전 페이지 순회는 큐 슬롯 하나를 오래 점유한다(페이지당 rate limit 간격 + 브로커 지연).
 * 큐 기본 per-task 데드라인(30s)으로는 대형 그룹 열거가 잘려나가고, 잘린 목록은 곧
 * "소유 프로필이 안 보임" = 중복 생성이므로 별도 데드라인을 준다.
 */
export const LIST_DEADLINE_MS = 120_000;

/**
 * 갓 생성한 프로필의 리컨실 유예. §2.4 프록시 lease grace 의 미러.
 * 생성 응답을 받았지만 아직 holder 로 등록되지 않은 프로필은 리컨실 입장에서 고아와 구별되지
 * 않는다. 유예가 없으면 리컨실 타이머가 `ensurePool` 이 방금 만든 프로필을 지우고 다음 준비가
 * 다시 만드는 생성-삭제 루프가 되어 계정 quota 를 태운다.
 */
const CREATION_GRACE_MS = 300_000;
const createdAt = new Map<string, number>();

export interface PoolProfile {
  user_id: string;
  name: string;
  group_id: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 생성 직후 기록. **다음 `await` 전에** 호출해야 응답이 유실되거나 프로세스가 죽어도
 * 리컨실이 이 프로필을 유예 대상으로 인식한다.
 */
export function noteProfileCreated(profileId: string): void {
  const cutoff = Date.now() - CREATION_GRACE_MS;
  for (const [id, at] of createdAt) if (at <= cutoff) createdAt.delete(id);
  createdAt.set(profileId, Date.now());
}

/** 유예 중인(= 고아로 판정하면 안 되는) 프로필 id 집합. */
export function gracedProfileIds(): ReadonlySet<string> {
  const cutoff = Date.now() - CREATION_GRACE_MS;
  const live = new Set<string>();
  for (const [id, at] of createdAt) if (at > cutoff) live.add(id);
  return live;
}

/** `user/list` 항목의 최소 형태. group_id 는 빌드에 따라 string/number 로 온다. */
interface RawProfile {
  user_id: string;
  name: string;
  group_id?: string | number;
}

function isRawProfile(v: unknown): v is RawProfile {
  if (!v || typeof v !== "object") return false;
  if (!("user_id" in v) || !("name" in v)) return false;
  if (typeof v.user_id !== "string" || v.user_id.length === 0) return false;
  return typeof v.name === "string";
}

/**
 * 응답 시점 그룹 재검증 (P7/I7).
 * `group_id` 가 없거나 형식을 못 읽는 항목은 **소속 증명 실패**이므로 제외한다. 여기서 통과한
 * 항목만 삭제·수정 대상이 될 수 있다 — 이 필터가 prowler 프로필과 우리 프로필을 가르는 유일한 선이다.
 */
export function filterProfilesInGroup(
  entries: readonly unknown[],
  groupId: string,
  context: string,
): PoolProfile[] {
  const kept: PoolProfile[] = [];
  let excluded = 0;
  for (const entry of entries) {
    if (!isRawProfile(entry) || String(entry.group_id) !== groupId) {
      excluded++;
      continue;
    }
    kept.push({ user_id: entry.user_id, name: entry.name, group_id: groupId });
  }
  if (excluded > 0) {
    console.warn(
      `[ProfilePool] ${context}: 그룹(${groupId}) 소속을 증명하지 못한 항목 ${excluded}개 제외 — ` +
        `타 앱 프로필일 수 있으므로 읽기/쓰기/삭제 대상에서 배제(I7). ` +
        `그룹 스코프로 요청했는데도 걸러졌다면 브로커가 group_id 를 유실하는지 확인할 것`,
    );
  }
  return kept;
}

/**
 * `user/create` 응답에서 새 프로필 id 추출.
 * id 가 number 로 오는 응답을 놓치면 상류에는 프로필이 남고 우리는 그것을 모르는
 * **추적 불가 고아**가 된다(quota 잠식). string/number 모두 문자열로 정규화한다.
 */
export function extractProfileId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("data" in result)) return undefined;
  const data = result.data;
  if (!data || typeof data !== "object" || !("id" in data)) return undefined;
  const id = data.id;
  if (typeof id === "string") return id.length > 0 ? id : undefined;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return undefined;
}

/** `group/list` 항목의 최소 형태. */
interface RawGroup {
  group_id: string | number;
  group_name: string;
}

function isRawGroup(v: unknown): v is RawGroup {
  if (!v || typeof v !== "object") return false;
  if (!("group_id" in v) || !("group_name" in v)) return false;
  const idOk = typeof v.group_id === "string" || typeof v.group_id === "number";
  return idOk && typeof v.group_name === "string";
}

interface GroupRef {
  id: string;
  name: string;
}

function collectGroups(entries: readonly unknown[]): GroupRef[] {
  const groups: GroupRef[] = [];
  let excluded = 0;
  for (const entry of entries) {
    if (!isRawGroup(entry)) {
      excluded++;
      continue;
    }
    // 앞뒤 공백 하나로 이름 조회가 미스되면 중복 그룹이 생긴다 → 읽는 시점에 정규화한다.
    groups.push({ id: String(entry.group_id), name: entry.group_name.trim() });
  }
  if (excluded > 0) {
    console.warn(`[ProfilePool] group/list 항목 ${excluded}개를 해석하지 못해 제외`);
  }
  return groups;
}

/** group_id 는 숫자 문자열이지만 형식 보장이 없다 — 숫자로 읽히면 수치, 아니면 사전순으로 비교. */
function lowerGroupId(a: string, b: string): string {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? a : b;
  return a <= b ? a : b;
}

/**
 * 이름이 일치하는 그룹 중 **가장 낮은 group_id** 를 결정적으로 택한다.
 * AdsPower 는 동명 그룹을 허용하므로, 임의 선택은 두 프로세스(또는 재기동 전후)가 서로 다른
 * 그룹을 고르게 만들고 한쪽의 프로필이 영구히 보이지 않게 된다.
 */
function pickGroupByName(groups: readonly GroupRef[], name: string): string | undefined {
  const matches = groups.filter((g) => g.name === name);
  if (matches.length === 0) return undefined;
  let chosen = matches[0].id;
  for (const m of matches) chosen = lowerGroupId(chosen, m.id);
  if (matches.length > 1) {
    console.warn(
      `[ProfilePool] 이름 '${name}' 그룹이 ${matches.length}개 (${matches.map((m) => m.id).join(", ")}) — ` +
        `최저 id ${chosen} 를 결정적으로 사용. 나머지 그룹의 프로필은 보이지 않으므로 ` +
        `AdsPower 에서 중복 그룹을 정리할 것`,
    );
  }
  return chosen;
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
   * 확정된 id 는 DB 에 남겨 다음 기동의 1차 앵커로 쓴다 — 이 설정의 유일한 writer 다.
   */
  async ensureGroupId(groupName: string): Promise<string> {
    const wanted = groupName.trim();
    if (wanted.length === 0) {
      // 이름 없는 그룹을 만들면 격리 경계 자체가 사라진다.
      throw new Error("[ProfilePool] scrapper 그룹 이름이 비어 있어 격리를 보장할 수 없음");
    }
    const resolved = await this.resolveGroupId(wanted);
    db.setSetting("scrapperGroupId", resolved);
    return resolved;
  }

  /** 저장된 id 검증 → 이름 조회 → 생성 후 재조회. 각 단계는 결정적이어야 한다. */
  private async resolveGroupId(wanted: string): Promise<string> {
    const groups = collectGroups(
      await adsPowerQueue.enqueue("listAllGroups", () => adspower.listAllGroups(this.apiKey), {
        deadlineMs: LIST_DEADLINE_MS,
      }),
    );

    // 저장된 id 를 **먼저** 검증한다. 이름 조회를 앞세우면 그룹 rename 이 곧 미스가 되고,
    // 미스는 곧 새 그룹 생성 → 이전 그룹의 프로필 전량이 영구히 보이지 않게 된다.
    const saved: unknown = db.getSetting("scrapperGroupId");
    if (typeof saved === "string" && saved.length > 0) {
      const hit = groups.find((g) => g.id === saved);
      if (hit) {
        if (hit.name === wanted) {
          console.log(`[ProfilePool] 저장된 그룹 재사용: ${hit.name} (${saved})`);
        } else {
          console.warn(
            `[ProfilePool] 저장된 그룹 ${saved} 의 이름이 '${hit.name}' (기대: '${wanted}') — ` +
              `id 를 신뢰해 계속 사용(rename 복구)`,
          );
        }
        return saved;
      }
      console.warn(`[ProfilePool] 저장된 그룹 ${saved} 가 AdsPower 에 없음 — 이름 조회로 폴백`);
    }

    const byName = pickGroupByName(groups, wanted);
    if (byName) {
      console.log(`[ProfilePool] 기존 그룹 재사용: ${wanted} (${byName})`);
      return byName;
    }

    await adsPowerQueue.enqueue(`createGroup ${wanted}`, () =>
      adspower.createGroup(this.apiKey, wanted),
    );
    // 생성 응답의 id 를 그대로 믿지 않고 재조회한다. createGroup 은 nonIdempotent 라 전송 실패가
    // "결과 불명"(그룹은 생겼을 수 있음)이고, 동명 그룹도 허용된다 — 재조회 + 최저 id 만이
    // 모든 프로세스를 같은 그룹으로 수렴시킨다.
    const after = collectGroups(
      await adsPowerQueue.enqueue(
        "listAllGroups(after create)",
        () => adspower.listAllGroups(this.apiKey),
        { deadlineMs: LIST_DEADLINE_MS },
      ),
    );
    const created = pickGroupByName(after, wanted);
    if (!created) {
      throw new Error(
        `[ProfilePool] 그룹 '${wanted}' 생성 후에도 조회되지 않음 — 격리 경계를 확정할 수 없어 중단`,
      );
    }
    console.log(`[ProfilePool] 그룹 생성: ${wanted} (${created})`);
    return created;
  }

  /**
   * 그룹 내 프로필 풀을 목표 개수(count)에 맞춰 보장한다.
   * `count` 는 호출자가 클램프한 유효 동시성이며 이 함수의 유일한 목표치다(DB 설정을 다시 읽지 않는다).
   * 반환: 사용 가능한 프로필 목록(최대 count 개). 한도 초과 등으로 count 미달 시 있는 만큼 반환.
   */
  async ensurePool(groupId: string, count: number): Promise<PoolProfile[]> {
    const entries = await adsPowerQueue.enqueue(
      `listAllProfiles(group ${groupId})`,
      () => adspower.listAllProfiles(this.apiKey, groupId),
      { deadlineMs: LIST_DEADLINE_MS },
    );
    const inGroup = filterProfilesInGroup(entries, groupId, "ensurePool");
    console.log(`[ProfilePool] 그룹(${groupId}) 내 프로필 ${inGroup.length}개 / 목표 ${count}`);

    if (inGroup.length >= count) {
      return inGroup.slice(0, count);
    }

    const pool: PoolProfile[] = [...inGroup];

    // 부족분만큼 신규 생성 (그룹 밖/미분류 프로필은 절대 건드리지 않음)
    for (let i = inGroup.length; i < count; i++) {
      const name = `scrapper-${Date.now()}-${i}`;
      let createRes: unknown;
      try {
        createRes = await adsPowerQueue.enqueue(`createProfile ${name}`, () =>
          adspower.createProfile(this.apiKey, buildDesktopProfilePayload(name, groupId)),
        );
      } catch (e) {
        console.error(
          `[ProfilePool] 프로필 생성 실패 (${name}): ${errMsg(e)} — 확보된 ${pool.length}개로 진행`,
        );
        break;
      }

      const id = extractProfileId(createRes);
      if (!id) {
        // 응답을 못 읽었을 뿐, 상류에는 프로필이 실제로 생성됐다고 가정해야 한다. 계속 돌면
        // 추적 불가 고아가 요청 수만큼 곱해진다 → 즉시 중단하고 이름을 남겨 리컨실이 회수한다.
        console.error(
          `[ProfilePool] createProfile 응답에서 id 를 읽지 못함 (요청 이름: ${name}) — ` +
            `프로필이 생성된 것으로 가정하고 중단. reconcileGroupProfiles 가 그룹(${groupId}) 내 ` +
            `미소유 프로필로 회수한다`,
        );
        break;
      }

      noteProfileCreated(id);
      pool.push({ user_id: id, name, group_id: groupId });
      console.log(`[ProfilePool] 새 프로필 생성: ${id} (${name})`);
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

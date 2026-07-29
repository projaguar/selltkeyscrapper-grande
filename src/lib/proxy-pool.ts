/**
 * REDESIGN.md §2 — Lease 기반 프록시 소유권.
 *
 * 이전 구현의 구조적 결함:
 *  - 획득이 "DB 상태 읽기 → markInUse" 의 check-then-act 였고, 소유자를 어디에도 기록하지 않았다.
 *    소유권의 유일한 기록은 `CrawlerBrowser.proxyId` 라는 메모리 필드였고, 그 필드는 락 없이
 *    세 컨트롤러가 덮어썼다 → 획득했지만 주인이 없는 행(영구 in_use 고아)이 사이클마다 생겼다.
 *  - `releaseProxy(id)` 가 인증 없는 쓰기였다 → 남의 살아있는 프록시를 해제해 한 IP 뒤에 두
 *    브라우저가 붙었다.
 *  - round-robin 커서가 배열 위치 기반이었고 `releaseProxy` 가 배열을 재구성해서, 방금 차단된
 *    IP 가 몇 픅 안에 다시 뽑혔다(쿨다운 부재).
 *
 * 새 설계:
 *  - 소유권의 유일한 진실은 DB 의 `owner` 컬럼. 메모리 복제 없음(P1).
 *  - 획득은 단일 `UPDATE ... RETURNING` (P2). check-then-act 소멸.
 *  - 반납/회수는 owner 일치 시에만 유효(P3).
 *  - 쿨다운은 SQL `ORDER BY leased_at`(LRU)이 담당 — 별도 dead 격리 불필요.
 *
 * 모델 검증(REDESIGN §11.4): 소유권 검증 반납을 제거하면 고갈 상황에서 즉시 I1 이 깨진다.
 */

import * as db from '../database/sqlite';

export interface Proxy {
  id: number;
  group_id: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
  status: 'active' | 'dead' | 'in_use';
  fail_count: number;
  success_count: number;
  owner?: string | null;
  leased_at?: number | null;
}

/** 획득한 프록시 사용권. 브라우저는 이 객체를 보유하고, 반납 시 그대로 되돌려준다. */
export interface ProxyLease {
  proxyId: number;
  groupId: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
  /** 소유자 = AdsPower profileId. 원장과 대조되는 키. */
  owner: string;
  leasedAt: number;
}

/**
 * 회수 그레이스. 획득→적용 구간, 프로필 재생성 중 소유자 전환, 프로세스 재기동 잔재를 오회수하지
 * 않도록 하는 방어선. 이보다 오래 주인 없이 남은 lease 만 고아로 판정한다.
 */
export const RECONCILE_GRACE_MS = 120_000;

export class ProxyPool {
  /**
   * 원자적 획득 (§2.2). 고갈 시 null.
   * 고갈은 브라우저의 결함이 아니다 — 호출자는 이를 실패로 집계하지 말고, 보유 중인 lease 가
   * 있으면 그것으로 재기동해야 한다(모델 검증 §11.3-3).
   */
  acquire(owner: string, groupId: number): ProxyLease | null {
    const now = Date.now();
    const row = db.acquireProxyLease(owner, groupId, now);
    if (!row) {
      console.error(`[ProxyPool] 그룹 ${groupId} 가용 프록시 없음 (owner=${owner})`);
      return null;
    }
    const lease: ProxyLease = {
      proxyId: row.id,
      groupId: row.group_id,
      ip: row.ip,
      port: row.port,
      username: row.username ?? undefined,
      password: row.password ?? undefined,
      owner,
      leasedAt: now,
    };
    console.log(`[ProxyPool] lease 획득 ${lease.ip}:${lease.port} (id=${lease.proxyId}, owner=${owner})`);
    return lease;
  }

  /** 소유권 검증 반납 (§2.3). 불일치 시 아무것도 바꾸지 않고 false. */
  release(lease: ProxyLease): boolean {
    return this.releaseById(lease.proxyId, lease.owner);
  }

  releaseById(proxyId: number, owner: string): boolean {
    const ok = db.releaseProxyLease(proxyId, owner, Date.now());
    if (!ok) {
      console.warn(
        `[ProxyPool] 소유권 불일치 반납 거부: proxy=${proxyId} 요청자=${owner} ` +
          `(다른 소유자의 살아있는 lease 를 해제하려 했거나 이미 반납된 행)`,
      );
      return false;
    }
    console.log(`[ProxyPool] lease 반납 proxy=${proxyId} (owner=${owner})`);
    return true;
  }

  /**
   * 고아 lease 회수 (§2.4).
   * `live` = 지금 살아있는 브라우저들이 실제로 보유한 lease 전체(그룹 무관).
   * (owner, proxyId) **쌍**으로 대조한다 — owner 만 보면 "우리 프로필이 X 를 소유"로 기록된 행을,
   * 그 브라우저가 실제로는 Y 를 들고 있어도 살아있다고 오판한다(그게 곧 누수 행이다).
   * @returns 회수한 개수
   */
  reconcile(live: readonly ProxyLease[]): number {
    const livePairs = new Set(live.map((l) => `${l.owner}#${l.proxyId}`));
    const now = Date.now();
    const orphans: number[] = [];

    for (const row of db.getLeasedProxies()) {
      if (row.owner !== null && livePairs.has(`${row.owner}#${row.id}`)) continue;
      // 그레이스 이내면 아직 적용 중일 수 있으므로 건드리지 않는다.
      if (row.leased_at !== null && now - row.leased_at < RECONCILE_GRACE_MS) continue;
      orphans.push(row.id);
    }

    if (orphans.length === 0) return 0;
    const reclaimed = db.reclaimProxyLeases(orphans, now);
    console.warn(
      `[ProxyPool] 고아 lease ${reclaimed}개 회수 (proxy ${orphans.join(',')}) — ` +
        `live=${live.length}, 누수 경로가 있는지 확인 필요`,
    );
    return reclaimed;
  }

  /**
   * 부팅 시 이전 프로세스 잔재 회수 (§2.5).
   * **단일 인스턴스 락을 획득한 프로세스만** 호출해야 한다. 두 인스턴스가 같은 DB 를 쓰면
   * 살아있는 상대의 lease 를 파괴해 30 브라우저가 15 IP 를 공유하게 된다.
   */
  reclaimAllAtBoot(): number {
    const count = db.reclaimAllLeases(Date.now());
    if (count > 0) console.log(`[ProxyPool] 부팅 회수: 이전 세션 lease ${count}개 → active`);
    return count;
  }

  /** 즉시 획득 가능한 개수 (진단·수용제어용) */
  availableCount(groupId?: number): number {
    const rows = (groupId === undefined ? db.getProxies() : db.getProxiesByGroup(groupId)) as Proxy[];
    return rows.filter((p) => p.status === 'active' && (p.owner ?? null) === null).length;
  }

  /** 그룹(또는 전체) 프록시 총량 — 동시 브라우저 수 클램프에 사용 */
  poolSize(groupId?: number): number {
    const rows = (groupId === undefined ? db.getProxies() : db.getProxiesByGroup(groupId)) as Proxy[];
    return rows.filter((p) => p.status !== 'dead').length;
  }
}

let instance: ProxyPool | null = null;

export function getProxyPool(): ProxyPool {
  if (!instance) instance = new ProxyPool();
  return instance;
}

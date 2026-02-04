import * as db from '../database/sqlite';

export interface Proxy {
  id: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
  status: 'active' | 'dead' | 'in_use';
  fail_count: number;
  success_count: number;
}

/**
 * ProxyPool - Proxy 순환 할당 및 관리
 *
 * 기능:
 * - 2000개 proxy 중 사용 가능한 것 순환 할당
 * - Proxy 사용 상태 관리
 * - 블록된 proxy dead 처리
 */
export class ProxyPool {
  private currentIndex: number = 0;
  private proxies: Proxy[] = [];

  // 그룹별 프록시 관리
  private groupProxies: Map<number, Proxy[]> = new Map();
  private groupCurrentIndex: Map<number, number> = new Map();

  constructor() {
    // 앱 시작 시 이전 세션의 in_use 상태 정리
    this.initializeProxies();
    this.loadProxies();
    this.loadCurrentIndex();
  }

  /**
   * DB에서 사용 가능한 proxy 목록 로드
   */
  private loadProxies() {
    const allProxies = db.getProxies() as Proxy[];
    // active 상태의 proxy만 필터링 (in_use는 제외)
    this.proxies = allProxies.filter(p => p.status === 'active');
    console.log(`[ProxyPool] Loaded ${this.proxies.length} active proxies`);
  }

  /**
   * 마지막 사용했던 currentIndex 복원
   */
  private loadCurrentIndex() {
    const savedIndex = db.getSetting('proxy_pool_current_index');
    if (savedIndex) {
      this.currentIndex = parseInt(savedIndex, 10);
      // 배열 크기를 벗어나면 0으로 리셋
      if (this.currentIndex >= this.proxies.length) {
        this.currentIndex = 0;
      }
      console.log(`[ProxyPool] Restored currentIndex: ${this.currentIndex}`);
    }
  }

  /**
   * currentIndex를 DB에 저장
   */
  private saveCurrentIndex() {
    db.setSetting('proxy_pool_current_index', this.currentIndex.toString());
  }

  /**
   * 앱 시작 시 모든 in_use 상태를 active로 초기화
   * (이전 세션에서 남은 in_use 상태 정리)
   */
  initializeProxies() {
    const allProxies = db.getProxies() as Proxy[];
    let resetCount = 0;

    for (const proxy of allProxies) {
      if (proxy.status === 'in_use') {
        db.updateProxy(proxy.id, { status: 'active' });
        resetCount++;
      }
    }

    if (resetCount > 0) {
      console.log(`[ProxyPool] Reset ${resetCount} proxies from 'in_use' to 'active'`);
      this.reload();
    }
  }

  /**
   * 사용 가능한 proxy 목록 새로고침
   */
  reload() {
    this.loadProxies();
    // 배열 크기가 변경되었을 수 있으므로 currentIndex 범위 체크
    if (this.currentIndex >= this.proxies.length) {
      this.currentIndex = 0;
      this.saveCurrentIndex();
    }
  }

  /**
   * 다음 사용 가능한 proxy 반환 (Round-robin 방식)
   * DB에서 최신 상태를 확인하여 실제로 'active' 상태인 proxy만 선택
   */
  getNextProxy(): Proxy | null {
    if (this.proxies.length === 0) {
      console.error('[ProxyPool] No available proxies!');
      return null;
    }

    // 최대 전체 proxy 개수만큼 시도 (모두 in_use일 수 있음)
    const maxAttempts = this.proxies.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const candidateProxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      this.saveCurrentIndex(); // currentIndex 변경 시마다 저장
      attempts++;

      // DB에서 최신 상태 확인
      const allProxies = db.getProxies() as Proxy[];
      const currentProxy = allProxies.find(p => p.id === candidateProxy.id);

      // 실제로 'active' 상태인 경우에만 반환
      if (currentProxy && currentProxy.status === 'active') {
        console.log(`[ProxyPool] Assigned proxy ${currentProxy.ip}:${currentProxy.port} (attempt ${attempts}/${maxAttempts})`);
        return currentProxy;
      }

      console.log(`[ProxyPool] Skipping proxy ${candidateProxy.ip}:${candidateProxy.port} (status: ${currentProxy?.status || 'not found'})`);
    }

    // 모든 proxy가 사용 중이거나 사용 불가능한 경우
    console.error('[ProxyPool] No active proxies available after checking all candidates!');
    return null;
  }

  /**
   * Proxy를 사용 중 상태로 표시
   */
  markInUse(proxyId: number) {
    db.updateProxy(proxyId, { status: 'in_use' });
    console.log(`[ProxyPool] Proxy ${proxyId} marked as in_use`);
  }

  /**
   * Proxy 사용 해제 (active 상태로 복귀)
   */
  releaseProxy(proxyId: number, groupId?: number) {
    db.updateProxy(proxyId, { status: 'active' });
    console.log(`[ProxyPool] Proxy ${proxyId} released`);
    // 목록 새로고침
    this.reload();
    // 그룹 캐시도 갱신
    if (groupId !== undefined) {
      this.reloadGroup(groupId);
    }
  }

  /**
   * Proxy를 블록된 상태로 표시 (dead)
   */
  markDead(proxyId: number) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    if (proxy) {
      db.updateProxy(proxyId, {
        status: 'dead',
        fail_count: proxy.fail_count + 1,
        last_checked: new Date().toISOString()
      });
      console.log(`[ProxyPool] Proxy ${proxyId} marked as dead`);

      // 목록에서 제거
      this.proxies = this.proxies.filter(p => p.id !== proxyId);
      console.log(`[ProxyPool] Remaining active proxies: ${this.proxies.length}`);
    }
  }

  /**
   * Proxy 성공 카운트 증가
   */
  markSuccess(proxyId: number) {
    const proxy = this.proxies.find(p => p.id === proxyId);
    if (proxy) {
      db.updateProxy(proxyId, {
        success_count: proxy.success_count + 1,
        last_checked: new Date().toISOString()
      });
    }
  }

  /**
   * 현재 사용 가능한 proxy 개수
   */
  getAvailableCount(): number {
    return this.proxies.length;
  }

  /**
   * 모든 proxy 정보 반환
   */
  getAllProxies(): Proxy[] {
    return [...this.proxies];
  }

  /**
   * Proxy 정보 조회
   */
  getProxyById(proxyId: number): Proxy | undefined {
    return this.proxies.find(p => p.id === proxyId);
  }

  // ========================================
  // 그룹별 Proxy 관리 메서드
  // ========================================

  /**
   * 특정 그룹의 사용 가능한 proxy 목록 로드
   */
  loadProxiesByGroup(groupId: number): void {
    const groupProxies = db.getProxiesByGroup(groupId) as Proxy[];
    // active 상태의 proxy만 필터링
    const activeProxies = groupProxies.filter(p => p.status === 'active');
    this.groupProxies.set(groupId, activeProxies);

    // 인덱스 초기화 (이전 인덱스가 없으면 0)
    if (!this.groupCurrentIndex.has(groupId)) {
      this.groupCurrentIndex.set(groupId, 0);
    } else {
      // 인덱스가 범위를 벗어나면 리셋
      const currentIndex = this.groupCurrentIndex.get(groupId) || 0;
      if (currentIndex >= activeProxies.length) {
        this.groupCurrentIndex.set(groupId, 0);
      }
    }

    console.log(`[ProxyPool] Loaded ${activeProxies.length} active proxies for group ${groupId}`);
  }

  /**
   * 특정 그룹에서 다음 사용 가능한 proxy 반환 (Round-robin 방식)
   */
  getNextProxyByGroup(groupId: number): Proxy | null {
    // 해당 그룹의 프록시가 로드되지 않았으면 로드
    if (!this.groupProxies.has(groupId)) {
      this.loadProxiesByGroup(groupId);
    }

    const proxies = this.groupProxies.get(groupId) || [];
    if (proxies.length === 0) {
      console.error(`[ProxyPool] No available proxies for group ${groupId}!`);
      return null;
    }

    let currentIndex = this.groupCurrentIndex.get(groupId) || 0;
    const maxAttempts = proxies.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      const candidateProxy = proxies[currentIndex];
      currentIndex = (currentIndex + 1) % proxies.length;
      this.groupCurrentIndex.set(groupId, currentIndex);
      attempts++;

      // DB에서 최신 상태 확인
      const allProxies = db.getProxiesByGroup(groupId) as Proxy[];
      const currentProxy = allProxies.find(p => p.id === candidateProxy.id);

      // 실제로 'active' 상태인 경우에만 반환
      if (currentProxy && currentProxy.status === 'active') {
        console.log(`[ProxyPool] Assigned proxy ${currentProxy.ip}:${currentProxy.port} from group ${groupId} (attempt ${attempts}/${maxAttempts})`);
        return currentProxy;
      }

      console.log(`[ProxyPool] Skipping proxy ${candidateProxy.ip}:${candidateProxy.port} in group ${groupId} (status: ${currentProxy?.status || 'not found'})`);
    }

    console.error(`[ProxyPool] No active proxies available for group ${groupId} after checking all candidates!`);
    return null;
  }

  /**
   * 특정 그룹의 proxy 목록 새로고침
   */
  reloadGroup(groupId: number): void {
    this.loadProxiesByGroup(groupId);
  }

  /**
   * 특정 그룹의 사용 가능한 proxy 개수
   */
  getAvailableCountByGroup(groupId: number): number {
    if (!this.groupProxies.has(groupId)) {
      this.loadProxiesByGroup(groupId);
    }
    return this.groupProxies.get(groupId)?.length || 0;
  }

  /**
   * 모든 그룹 프록시 캐시 초기화
   */
  clearGroupCache(): void {
    this.groupProxies.clear();
    this.groupCurrentIndex.clear();
    console.log('[ProxyPool] Group cache cleared');
  }
}

// 싱글톤 인스턴스
let proxyPoolInstance: ProxyPool | null = null;

export function getProxyPool(): ProxyPool {
  if (!proxyPoolInstance) {
    proxyPoolInstance = new ProxyPool();
  }
  return proxyPoolInstance;
}

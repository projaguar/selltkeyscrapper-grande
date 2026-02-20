import { getProxyPool } from './proxy-pool';
import * as gologin from '../services/gologin';
import * as db from '../database/sqlite';

interface Session {
  sessionId: string;
  profileId: string;
  profileName: string;
  proxyId: number;
  proxyIp: string;
  proxyPort: string;
  status: 'idle' | 'starting' | 'running' | 'blocked' | 'error';
  createdAt: Date;
  lastChecked?: Date;
}

/**
 * SessionManager - Profile과 Proxy 매핑 관리
 *
 * 기능:
 * - Profile 조회 및 Proxy 순환 할당
 * - Profile에 Proxy 설정 업데이트
 * - 세션 상태 관리
 * - 블록된 세션 처리 (Profile 유지, Proxy만 교체)
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * 모든 Profile 조회
   */
  async loadProfiles() {
    const result = await gologin.listProfiles(this.apiKey);
    // GoLogin returns array directly or { profiles: [...] }
    if (Array.isArray(result)) {
      return result;
    }
    return result.profiles || result.data?.list || [];
  }

  /**
   * Profile에 Proxy 할당 및 업데이트
   */
  async assignProxyToProfile(profileId: string, profileName: string): Promise<Session> {
    const proxyPool = getProxyPool();
    const proxy = proxyPool.getNextProxy();

    if (!proxy) {
      throw new Error('No available proxies');
    }

    console.log(`[SessionManager] Assigning proxy ${proxy.ip}:${proxy.port} to profile ${profileName}`);

    // GoLogin Profile에 Proxy 설정 업데이트
    const proxyData = {
      mode: 'http',
      host: proxy.ip,
      port: parseInt(proxy.port, 10),
      username: proxy.username || '',
      password: proxy.password || '',
    };

    await gologin.changeProfileProxy(this.apiKey, profileId, proxyData);

    // 세션 생성
    const session: Session = {
      sessionId: `${profileId}_${Date.now()}`,
      profileId,
      profileName,
      proxyId: proxy.id,
      proxyIp: proxy.ip,
      proxyPort: proxy.port,
      status: 'idle',
      createdAt: new Date(),
    };

    this.sessions.set(profileId, session);

    // Proxy를 사용 중 상태로 표시
    proxyPool.markInUse(proxy.id);

    console.log(`✅ [SessionManager] Session created for ${profileName} with proxy ${proxy.ip}:${proxy.port}`);

    return session;
  }

  /**
   * 모든 Profile에 Proxy 할당
   */
  async assignProxyToAllProfiles() {
    const profiles = await this.loadProfiles();
    console.log(`[SessionManager] Loaded ${profiles.length} profiles from API`);

    // 기존 세션 중에서 현재 프로파일 목록에 없는 세션 제거
    const currentProfileIds = new Set(profiles.map(p => p.user_id));
    console.log(`[SessionManager] Current session count before cleanup: ${this.sessions.size}`);
    const sessionsToRemove: string[] = [];

    for (const [profileId] of this.sessions) {
      if (!currentProfileIds.has(profileId)) {
        sessionsToRemove.push(profileId);
      }
    }

    // 제거할 세션들 정리 (Proxy 해제)
    for (const profileId of sessionsToRemove) {
      console.log(`[SessionManager] Removing stale session for deleted profile: ${profileId}`);
      this.removeSession(profileId);
    }

    // Proxy 목록 새로고침 (해제된 Proxy를 다시 사용 가능하게)
    const proxyPool = getProxyPool();
    proxyPool.reload();
    console.log(`[SessionManager] ProxyPool reloaded, available proxies: ${proxyPool.getAvailableCount()}`)

    const results = [];

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      try {
        const session = await this.assignProxyToProfile(profile.user_id, profile.name);
        results.push({ success: true, session });
      } catch (error: any) {
        console.error(`❌ [SessionManager] Failed to assign proxy to ${profile.name}:`, error.message);
        results.push({ success: false, profileId: profile.user_id, error: error.message });
      }

      // GoLogin has 300 RPM - no delay needed between assignments
    }

    return results;
  }

  /**
   * 세션 조회
   */
  getSession(profileId: string): Session | undefined {
    return this.sessions.get(profileId);
  }

  /**
   * 모든 세션 조회
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * 세션 상태 업데이트
   */
  updateSessionStatus(profileId: string, status: Session['status']) {
    const session = this.sessions.get(profileId);
    if (session) {
      session.status = status;
      session.lastChecked = new Date();
      console.log(`[SessionManager] Session ${profileId} status updated to ${status}`);
    }
  }

  /**
   * 블록된 세션의 Proxy 교체
   * (Profile은 유지하고 Proxy만 교체)
   */
  async replaceProxyForSession(profileId: string): Promise<Session> {
    const oldSession = this.sessions.get(profileId);
    if (!oldSession) {
      throw new Error(`Session not found for profile ${profileId}`);
    }

    const proxyPool = getProxyPool();

    // 기존 Proxy를 dead로 표시
    proxyPool.markDead(oldSession.proxyId);
    console.log(`[SessionManager] Marked proxy ${oldSession.proxyId} as dead`);

    // 새 Proxy 할당
    const newSession = await this.assignProxyToProfile(oldSession.profileId, oldSession.profileName);

    console.log(`✅ [SessionManager] Replaced proxy for ${oldSession.profileName}: ${oldSession.proxyIp} → ${newSession.proxyIp}`);

    return newSession;
  }

  /**
   * 세션 삭제 (Proxy 해제)
   */
  removeSession(profileId: string) {
    const session = this.sessions.get(profileId);
    if (session) {
      const proxyPool = getProxyPool();
      proxyPool.releaseProxy(session.proxyId);
      this.sessions.delete(profileId);
      console.log(`[SessionManager] Session removed for profile ${profileId}`);
    }
  }

  /**
   * 모든 세션 삭제
   */
  clearAllSessions() {
    const proxyPool = getProxyPool();
    for (const session of this.sessions.values()) {
      proxyPool.releaseProxy(session.proxyId);
    }
    this.sessions.clear();
    console.log('[SessionManager] All sessions cleared');
  }
}

// 싱글톤 인스턴스
let sessionManagerInstance: SessionManager | null = null;

export function getSessionManager(apiKey: string): SessionManager {
  if (!sessionManagerInstance || sessionManagerInstance['apiKey'] !== apiKey) {
    sessionManagerInstance = new SessionManager(apiKey);
  }
  return sessionManagerInstance;
}

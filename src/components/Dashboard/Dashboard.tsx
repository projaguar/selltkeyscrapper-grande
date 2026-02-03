import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { Button } from '@/components/ui/button';

type BrowserStatus =
  | 'idle'           // 대기 중
  | 'crawling'       // 크롤링 중
  | 'success'        // 성공
  | 'warning'        // 경고 (상품 없음, 해외배송 아님 등)
  | 'error'          // 오류 (실제 예외)
  | 'waiting'        // 배치 대기
  | 'recreating'     // CAPTCHA로 프로필 재생성 중
  | 'reconnecting'   // 연결 끊김 복구 중
  | 'preparing';     // 브라우저 준비 중

interface BrowserStatusInfo {
  browserIndex: number;
  profileName: string;
  status: BrowserStatus;
  storeName?: string;
  message?: string;
  collectedCount?: number;
  proxyIp?: string;  // 현재 사용 중인 프록시 IP
}

interface CrawlerProgress {
  isRunning: boolean;
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;  // 오류/CAPTCHA로 스킵된 Task
  pendingTasks: number;
  todayStopCount: number;
  elapsedTime: number;
  browserStatuses: BrowserStatusInfo[];
}

interface Session {
  profileId: string;
  profileName: string;
  proxyId: number;
  proxyIp: string;
  proxyPort: number;
}

function Dashboard() {
  const { apiKey, proxies, profiles } = useStore();
  const [progress, setProgress] = useState<CrawlerProgress | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [preparingStatuses, setPreparingStatuses] = useState<BrowserStatusInfo[]>([]);

  // 크롤링 진행 상태 주기적 조회
  useEffect(() => {
    const fetchProgress = async () => {
      try {
        const result = await window.electronAPI.crawler.getProgress();
        if (result.success) {
          setProgress(result.progress);
        }
      } catch (error) {
        console.error('[Dashboard] Failed to fetch progress:', error);
      }
    };

    // 초기 조회
    fetchProgress();

    // 2초마다 조회
    const interval = setInterval(fetchProgress, 2000);

    return () => clearInterval(interval);
  }, []);

  // 크롤링 상태와 동기화
  useEffect(() => {
    if (progress) {
      // 크롤링이 중지되면 세션 정보 초기화
      // (브라우저가 닫혔으므로 세션이 더 이상 유효하지 않음)
      if (isCrawling && !progress.isRunning) {
        console.log('[Dashboard] Crawling stopped, clearing sessions...');
        setSessions([]);
      }
      setIsCrawling(progress.isRunning);
    }
  }, [progress?.isRunning, isCrawling]);

  // 세션 목록 로드
  const loadSessions = async () => {
    if (!apiKey) return;
    try {
      const result = await window.electronAPI.session.getAll(apiKey);
      if (result.success) {
        setSessions(result.sessions || []);
      }
    } catch (error) {
      console.error('[Dashboard] Failed to load sessions:', error);
    }
  };

  // 브라우저 준비 (Proxy 검증 + 브라우저 시작)
  const handlePrepareBrowsers = async () => {
    if (profiles.length === 0) {
      alert('⚠️ 시작할 프로필이 없습니다.');
      return;
    }

    setIsVerifying(true);

    // 초기 준비 상태 설정 (모든 프로필 대기 중)
    const initialStatuses: BrowserStatusInfo[] = profiles.map((profile, index) => ({
      browserIndex: index,
      profileName: profile.name,
      status: 'waiting' as BrowserStatus,
      message: '대기 중...',
    }));
    setPreparingStatuses(initialStatuses);

    try {
      // 1. 모든 프로필에 Proxy 할당
      console.log('\n🔗 Step 1: Assigning proxies to all profiles...');

      // 모든 프로필 상태를 "Proxy 할당 중"으로 업데이트
      setPreparingStatuses(prev => prev.map(s => ({
        ...s,
        status: 'preparing' as BrowserStatus,
        message: 'Proxy 할당 중...',
      })));

      const assignResult = await window.electronAPI.session.assignProxyToAll(apiKey);
      if (!assignResult.success) {
        setPreparingStatuses(prev => prev.map(s => ({
          ...s,
          status: 'error' as BrowserStatus,
          message: 'Proxy 할당 실패',
        })));
        alert(`❌ Proxy 할당 실패\n${assignResult.error || '알 수 없는 오류'}`);
        setIsVerifying(false);
        return;
      }

      // 2. 각 프로필 검증 및 시작
      console.log('\n🔍 Step 2: Verifying and starting browsers...');
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];

        // 현재 프로필 상태를 "브라우저 시작 중"으로 업데이트
        setPreparingStatuses(prev => prev.map((s, idx) =>
          idx === i
            ? { ...s, status: 'preparing' as BrowserStatus, message: '브라우저 시작 중...' }
            : s
        ));

        try {
          const result = await window.electronAPI.browser.startAndVerify(
            apiKey,
            profile.user_id,
            profile.name,
            3
          );
          if (result.success) {
            successCount++;
            // 성공 상태로 업데이트
            setPreparingStatuses(prev => prev.map((s, idx) =>
              idx === i
                ? { ...s, status: 'success' as BrowserStatus, message: '준비 완료' }
                : s
            ));
          } else {
            failCount++;
            // 실패 상태로 업데이트
            setPreparingStatuses(prev => prev.map((s, idx) =>
              idx === i
                ? { ...s, status: 'error' as BrowserStatus, message: result.error || '시작 실패' }
                : s
            ));
          }
        } catch (error: any) {
          failCount++;
          // 에러 상태로 업데이트
          setPreparingStatuses(prev => prev.map((s, idx) =>
            idx === i
              ? { ...s, status: 'error' as BrowserStatus, message: error.message || '오류 발생' }
              : s
          ));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // 세션 정보 로드
      await loadSessions();

      alert(
        `🎉 브라우저 준비 완료\n\n✅ 성공: ${successCount}개\n❌ 실패: ${failCount}개`
      );
    } catch (error: any) {
      alert(`❌ 오류 발생\n${error.message}`);
    } finally {
      setIsVerifying(false);
      // 준비 완료 후 상태 초기화 (크롤링 시작 후에는 progress.browserStatuses 사용)
      setTimeout(() => setPreparingStatuses([]), 3000);
    }
  };

  // 크롤링 시작
  const handleStartCrawling = async () => {
    if (sessions.length === 0) {
      alert('⚠️ 실행 중인 브라우저가 없습니다.\n먼저 "브라우저 준비" 버튼을 눌러주세요.');
      return;
    }

    setIsCrawling(true);

    try {
      console.log(`\n🚀 Starting crawling with ${sessions.length} browsers\n`);
      const result = await window.electronAPI.crawler.startBatch(apiKey, sessions);

      if (result.success) {
        const successCount = result.results?.filter((r: any) => r.success).length || 0;
        const failCount = result.results?.filter((r: any) => !r.success).length || 0;

        alert(
          `✅ 크롤링 완료\n\n` +
          `총 처리: ${result.results?.length || 0}개\n` +
          `성공: ${successCount}개\n` +
          `실패: ${failCount}개`
        );
      } else {
        alert(`❌ 크롤링 실패\n${result.error}`);
      }
    } catch (error: any) {
      alert(`❌ 크롤링 실패\n${error.message}`);
    } finally {
      setIsCrawling(false);
    }
  };

  // 크롤링 중지
  const handleStopCrawling = async () => {
    try {
      await window.electronAPI.crawler.stop();
      alert('🛑 크롤링 중지 요청됨');
    } catch (error: any) {
      alert(`❌ 중지 실패\n${error.message}`);
    }
  };

  // 경과 시간 포맷
  const formatElapsedTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}시간 ${minutes % 60}분`;
    } else if (minutes > 0) {
      return `${minutes}분 ${seconds % 60}초`;
    } else {
      return `${seconds}초`;
    }
  };

  // 전체 진행률 계산 (성공 + 스킵 = 처리된 총 수)
  const totalProcessed = (progress?.completedTasks || 0) + (progress?.skippedTasks || 0);
  const overallProgressPercent = progress && progress.totalTasks > 0
    ? Math.round((totalProcessed / progress.totalTasks) * 100)
    : 0;

  // 브라우저 상태 아이콘
  const getStatusIcon = (status: BrowserStatus) => {
    switch (status) {
      case 'crawling': return '🔄';
      case 'success': return '✅';
      case 'warning': return '⚠️';
      case 'error': return '❌';
      case 'waiting': return '⏳';
      case 'recreating': return '🔁';
      case 'reconnecting': return '🔌';
      case 'preparing': return '🔧';
      default: return '⬜';
    }
  };

  // 브라우저 상태 색상
  const getStatusColor = (status: BrowserStatus) => {
    switch (status) {
      case 'crawling': return 'bg-blue-50 border-blue-200';
      case 'success': return 'bg-green-50 border-green-200';
      case 'warning': return 'bg-amber-50 border-amber-200';
      case 'error': return 'bg-red-50 border-red-200';
      case 'waiting': return 'bg-yellow-50 border-yellow-200';
      case 'recreating': return 'bg-orange-50 border-orange-200';
      case 'reconnecting': return 'bg-purple-50 border-purple-200';
      case 'preparing': return 'bg-cyan-50 border-cyan-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold">대시보드</h2>
        <div className="flex gap-3">
          {/* 브라우저 준비 버튼 */}
          <Button
            onClick={handlePrepareBrowsers}
            disabled={isVerifying || isCrawling || profiles.length === 0}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6"
          >
            {isVerifying ? '⏳ 준비 중...' : '🔗 브라우저 준비'}
          </Button>

          {/* 크롤링 시작/중지 버튼 */}
          {!isCrawling ? (
            <Button
              onClick={handleStartCrawling}
              disabled={sessions.length === 0 || isVerifying}
              className="bg-green-600 hover:bg-green-700 text-white font-semibold px-6"
            >
              🚀 크롤링 시작
            </Button>
          ) : (
            <Button
              onClick={handleStopCrawling}
              variant="destructive"
              className="font-semibold px-6"
            >
              🛑 크롤링 중지
            </Button>
          )}
        </div>
      </div>

      {/* 세션 정보 표시 */}
      {sessions.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="text-sm text-green-800">
            ✅ {sessions.length}개 브라우저 준비됨
          </div>
        </div>
      )}

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-sm text-gray-500 mb-2">전체 프로필</div>
          <div className="text-3xl font-bold">{profiles.length}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-sm text-gray-500 mb-2">활성 프록시</div>
          <div className="text-3xl font-bold text-green-600">
            {proxies.filter((p) => p.status === 'active').length}
          </div>
        </div>
      </div>

      {/* 크롤링 진행 상태 */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold">크롤링 진행 상태</h3>
          {progress?.isRunning && (
            <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium animate-pulse">
              실행 중
            </span>
          )}
          {!progress?.isRunning && progress && progress.totalTasks > 0 && (
            <span className="px-3 py-1 bg-gray-100 text-gray-600 rounded-full text-sm font-medium">
              중지됨
            </span>
          )}
        </div>

        {!progress || (progress.totalTasks === 0 && !progress.isRunning) ? (
          <div className="text-center py-8 text-gray-500">
            크롤링을 시작하면 진행 상태가 표시됩니다.
          </div>
        ) : (
          <>
            {/* 전체 진행률 */}
            <div className="mb-6">
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-600">전체 진행률</span>
                <span className="font-semibold text-green-600">
                  {totalProcessed}/{progress.totalTasks} ({overallProgressPercent}%)
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all duration-500 ${
                    progress.isRunning ? 'bg-green-500' : 'bg-gray-400'
                  }`}
                  style={{ width: `${overallProgressPercent}%` }}
                />
              </div>
            </div>

            {/* 상세 통계 */}
            <div className="grid grid-cols-5 gap-4">
              <div className="text-center p-4 bg-gray-50 rounded-lg">
                <div className="text-2xl font-bold text-gray-800">{progress.totalTasks}</div>
                <div className="text-xs text-gray-500 mt-1">전체 Task</div>
              </div>
              <div className="text-center p-4 bg-green-50 rounded-lg">
                <div className="text-2xl font-bold text-green-600">{progress.completedTasks}</div>
                <div className="text-xs text-gray-500 mt-1">성공</div>
              </div>
              <div className="text-center p-4 bg-orange-50 rounded-lg">
                <div className="text-2xl font-bold text-orange-600">{progress.skippedTasks || 0}</div>
                <div className="text-xs text-gray-500 mt-1">스킵/오류</div>
              </div>
              <div className="text-center p-4 bg-yellow-50 rounded-lg">
                <div className="text-2xl font-bold text-yellow-600">{progress.pendingTasks}</div>
                <div className="text-xs text-gray-500 mt-1">대기 중</div>
              </div>
              <div className="text-center p-4 bg-red-50 rounded-lg">
                <div className="text-2xl font-bold text-red-600">{progress.todayStopCount}</div>
                <div className="text-xs text-gray-500 mt-1">todayStop</div>
              </div>
            </div>

            {/* 경과 시간 */}
            {progress.isRunning && progress.elapsedTime > 0 && (
              <div className="mt-4 text-center text-sm text-gray-500">
                경과 시간: <span className="font-medium">{formatElapsedTime(progress.elapsedTime)}</span>
              </div>
            )}

            {/* 브라우저 상태 목록 */}
            {progress.browserStatuses && progress.browserStatuses.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">브라우저 상태</h4>
                <div className="space-y-2">
                  {progress.browserStatuses.map((browser) => (
                    <div
                      key={browser.browserIndex}
                      className={`flex items-center justify-between p-3 rounded-lg border ${getStatusColor(browser.status)}`}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <span className="text-lg flex-shrink-0">{getStatusIcon(browser.status)}</span>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-800">
                            {browser.profileName}
                          </div>
                          {browser.proxyIp && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              🌐 {browser.proxyIp}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-sm text-right flex-shrink-0 ml-3">
                        {browser.storeName && (
                          <div className="font-medium text-gray-700">{browser.storeName}</div>
                        )}
                        <div className="text-gray-500">
                          {browser.message || (browser.status === 'idle' ? '대기 중' : '')}
                          {browser.collectedCount !== undefined && browser.collectedCount > 0 && (
                            <span className="ml-1 text-green-600 font-semibold">
                              ({browser.collectedCount}개)
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 브라우저 준비 상태 */}
      {preparingStatuses.length > 0 && (
        <div className="bg-white rounded-lg shadow-md p-6 mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold">브라우저 준비 상태</h3>
            {isVerifying && (
              <span className="px-3 py-1 bg-cyan-100 text-cyan-800 rounded-full text-sm font-medium animate-pulse">
                준비 중...
              </span>
            )}
            {!isVerifying && preparingStatuses.some(s => s.status === 'success') && (
              <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                완료
              </span>
            )}
          </div>

          {/* 준비 진행률 */}
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="text-gray-600">진행률</span>
              <span className="font-semibold">
                {preparingStatuses.filter(s => s.status === 'success' || s.status === 'error').length} / {preparingStatuses.length}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="h-2 rounded-full bg-cyan-500 transition-all duration-300"
                style={{
                  width: `${(preparingStatuses.filter(s => s.status === 'success' || s.status === 'error').length / preparingStatuses.length) * 100}%`
                }}
              />
            </div>
          </div>

          {/* 각 브라우저 상태 */}
          <div className="space-y-2">
            {preparingStatuses.map((browser) => (
              <div
                key={browser.browserIndex}
                className={`flex items-center justify-between p-3 rounded-lg border ${getStatusColor(browser.status)}`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{getStatusIcon(browser.status)}</span>
                  <span className="font-medium text-gray-800">
                    {browser.profileName}
                  </span>
                </div>
                <div className="text-sm text-gray-500">
                  {browser.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;

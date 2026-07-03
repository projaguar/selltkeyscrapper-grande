import { useState, useEffect, useRef } from 'react';
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
  | 'restarting'     // 재시작 중
  | 'preparing';     // 브라우저 준비 중

interface BrowserStatusInfo {
  profileName: string;
  status: BrowserStatus;
  platform?: string;
  storeName?: string;
  message?: string;
  collectedCount?: number;
  proxyGroupName?: string;
  proxyIp?: string;
  error?: string;
}

interface SkipBreakdown {
  blockedUser: number;
  serverTransmitFail: number;
  captcha: number;
  deadBrowser: number;
  cloudflareBlock: number;
  timeout: number;
  network: number;
  exception: number;
}

// 스킵 사유 표시 정의 (표시 순서대로)
const SKIP_REASONS: { key: keyof SkipBreakdown; label: string; icon: string }[] = [
  { key: 'blockedUser', label: '차단 사용자(todayStop)', icon: '🚫' },
  { key: 'serverTransmitFail', label: '서버 전송 실패', icon: '📡' },
  { key: 'captcha', label: 'CAPTCHA 감지', icon: '🤖' },
  { key: 'deadBrowser', label: '브라우저 죽음', icon: '💀' },
  { key: 'cloudflareBlock', label: 'Cloudflare 차단', icon: '🛡️' },
  { key: 'timeout', label: '타임아웃(로딩 지연)', icon: '⏱️' },
  { key: 'network', label: '네트워크/프록시 오류', icon: '🌐' },
  { key: 'exception', label: '기타 예외', icon: '⚠️' },
];

interface CrawlerProgress {
  isRunning: boolean;
  totalTasks: number;
  completedTasks: number;
  skippedTasks: number;  // 오류/CAPTCHA로 스킵된 Task
  skipBreakdown?: SkipBreakdown;  // 스킵 사유별 분류
  pendingTasks: number;
  todayStopCount: number;
  elapsedTime: number;
  browserStatuses: BrowserStatusInfo[];
  waitEndTime: number | null;
  waitReason: string;
}

interface PreparationResult {
  success: boolean;
  profileId: string;
  profileName: string;
  proxyGroupName?: string;
  proxyIp?: string;
  error?: string;
}

function Dashboard() {
  const { apiKey, proxies } = useStore();
  const [progress, setProgress] = useState<CrawlerProgress | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [readyBrowserCount, setReadyBrowserCount] = useState(0);
  const [preparingStatuses, setPreparingStatuses] = useState<BrowserStatusInfo[]>([]);
  const removeProgressListenerRef = useRef<(() => void) | null>(null);

  // 크롤링 진행 상태 주기적 조회
  useEffect(() => {
    let isFirstFetch = true;

    const fetchProgress = async () => {
      try {
        const result = await window.electronAPI.crawler.getProgress();
        if (result.success) {
          setProgress(result.progress);
          // 마운트 시 1회만 복원: 백엔드에 준비된 브라우저가 있으면 반영
          if (isFirstFetch && result.readyBrowserCount > 0) {
            setReadyBrowserCount(result.readyBrowserCount);
          }
          isFirstFetch = false;
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
      if (isCrawling && !progress.isRunning) {
        console.log('[Dashboard] Crawling stopped');
        setReadyBrowserCount(0);
      }
      setIsCrawling(progress.isRunning);
    }
  }, [progress?.isRunning, isCrawling]);

  // 컴포넌트 언마운트 시 이벤트 리스너 정리
  useEffect(() => {
    return () => {
      if (removeProgressListenerRef.current) {
        removeProgressListenerRef.current();
      }
    };
  }, []);

  // 브라우저 준비 (DDD 패턴 - BrowserManager 사용)
  const handlePrepareBrowsers = async () => {
    setIsPreparing(true);
    setPreparingStatuses([]);

    try {
      // 진행 상황 이벤트 리스너 등록 (총 개수는 진행 이벤트에서 전달됨)
      const removeListener = window.electronAPI.crawler.onPrepareProgress((data) => {
        const { current, total, result } = data;
        setPreparingStatuses((prev) => {
          const next =
            prev.length === total
              ? [...prev]
              : Array.from({ length: total }, (_, i) =>
                  prev[i] ?? {
                    profileName: `프로필 ${i + 1}`,
                    status: 'waiting' as BrowserStatus,
                    message: '대기 중...',
                  },
                );
          const index = current - 1;
          if (index >= 0 && index < next.length) {
            next[index] = {
              ...next[index],
              profileName: result.profileName || next[index].profileName,
              status: result.success ? 'success' : 'error',
              message: result.success
                ? `준비 완료 (${result.proxyIp ?? ''})`
                : result.error || '준비 실패',
              proxyGroupName: result.proxyGroupName,
              proxyIp: result.proxyIp,
            };
          }
          return next;
        });
      });
      removeProgressListenerRef.current = removeListener;

      // BrowserManager를 통해 그룹 풀에서 브라우저 자동 확보 + 준비
      console.log(`\n🔧 Preparing browsers with BrowserManager...`);
      const result = await window.electronAPI.crawler.prepareBrowsers(apiKey);

      removeListener();
      removeProgressListenerRef.current = null;

      if (result.success) {
        const successCount = result.readyCount || 0;
        setReadyBrowserCount(successCount);
        alert(`🎉 브라우저 준비 완료\n\n✅ 준비: ${successCount}개`);
      } else {
        alert(`❌ 브라우저 준비 실패\n${result.error || '알 수 없는 오류'}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      alert(`❌ 오류 발생\n${msg}`);
    } finally {
      setIsPreparing(false);
      setTimeout(() => setPreparingStatuses([]), 3000);
    }
  };

  // 크롤링 시작 (준비된 브라우저 사용)
  const handleStartCrawling = async () => {
    if (readyBrowserCount === 0) {
      alert('⚠️ 준비된 브라우저가 없습니다.\n먼저 "브라우저 준비" 버튼을 눌러주세요.');
      return;
    }

    setIsCrawling(true);

    try {
      console.log(`\n🚀 Starting crawling with ${readyBrowserCount} prepared browsers\n`);
      const result = await window.electronAPI.crawler.startBatch();

      if (result.success) {
        alert(`✅ 크롤링이 완료되었습니다.`);
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

  // 브라우저 정리
  const handleClearBrowsers = async () => {
    try {
      await window.electronAPI.crawler.clearBrowsers();
      setReadyBrowserCount(0);
      alert('🧹 브라우저가 정리되었습니다.');
    } catch (error: any) {
      alert(`❌ 정리 실패\n${error.message}`);
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
      case 'restarting': return '🔄';
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
      case 'restarting': return 'bg-orange-50 border-orange-200';
      case 'preparing': return 'bg-cyan-50 border-cyan-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold">대시보드</h2>
        <div className="flex gap-3 items-center">

          {/* 브라우저 준비 버튼 */}
          <Button
            onClick={handlePrepareBrowsers}
            disabled={isPreparing || isCrawling}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6"
          >
            {isPreparing ? '⏳ 준비 중...' : '🔗 브라우저 준비'}
          </Button>

          {/* 크롤링 시작/중지 버튼 */}
          {!isCrawling ? (
            <Button
              onClick={handleStartCrawling}
              disabled={readyBrowserCount === 0 || isPreparing}
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

          {/* 브라우저 정리 버튼 */}
          {readyBrowserCount > 0 && !isCrawling && (
            <Button
              onClick={handleClearBrowsers}
              variant="outline"
              className="font-semibold px-6"
            >
              🧹 브라우저 정리
            </Button>
          )}
        </div>
      </div>

      {/* 준비된 브라우저 정보 표시 */}
      {readyBrowserCount > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="text-sm text-green-800">
            ✅ {readyBrowserCount}개 브라우저 준비됨
          </div>
        </div>
      )}

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow-md">
          <div className="text-sm text-gray-500 mb-2">준비된 브라우저</div>
          <div className="text-3xl font-bold">{readyBrowserCount}</div>
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

            {/* 스킵/오류 사유 분류 */}
            {progress.skippedTasks > 0 && progress.skipBreakdown && (
              <div className="mt-4 p-4 bg-orange-50 rounded-lg border border-orange-100">
                <div className="text-xs font-semibold text-orange-700 mb-3">
                  스킵/오류 사유 분류 (총 {progress.skippedTasks}건)
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {SKIP_REASONS.map(({ key, label, icon }) => {
                    const count = progress.skipBreakdown?.[key] || 0;
                    return (
                      <div
                        key={key}
                        className={`flex items-center justify-between px-3 py-2 rounded border ${
                          count > 0
                            ? 'bg-white border-orange-200'
                            : 'bg-transparent border-transparent'
                        }`}
                      >
                        <span className={`text-xs ${count > 0 ? 'text-gray-700' : 'text-gray-400'}`}>
                          {icon} {label}
                        </span>
                        <span className={`text-sm font-bold ml-2 ${count > 0 ? 'text-orange-600' : 'text-gray-300'}`}>
                          {count}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 경과 시간 */}
            {progress.isRunning && progress.elapsedTime > 0 && (
              <div className="mt-4 text-center text-sm text-gray-500">
                경과 시간: <span className="font-medium">{formatElapsedTime(progress.elapsedTime)}</span>
              </div>
            )}

            {/* 대기 시간 Progress Bar */}
            {progress.isRunning && (() => {
              const isWaiting = progress.waitEndTime !== null && progress.waitEndTime > Date.now();
              const WAIT_DURATION = 5 * 60 * 1000;
              const remaining = isWaiting ? Math.max(0, progress.waitEndTime! - Date.now()) : 0;
              const elapsed = WAIT_DURATION - remaining;
              const percent = isWaiting ? Math.min(100, Math.round((elapsed / WAIT_DURATION) * 100)) : 0;
              const remainMin = Math.floor(remaining / 60000);
              const remainSec = Math.floor((remaining % 60000) / 1000);

              return (
                <div className={`mt-4 p-3 rounded-lg border ${isWaiting ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-200'}`}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className={isWaiting ? 'text-indigo-600 font-medium' : 'text-gray-400'}>
                      {isWaiting ? progress.waitReason : '대기 없음'}
                    </span>
                    <span className={isWaiting ? 'text-indigo-600 font-medium' : 'text-gray-400'}>
                      {isWaiting ? `${remainMin}분 ${remainSec}초 남음` : ''}
                    </span>
                  </div>
                  <div className={`w-full rounded-full h-2 ${isWaiting ? 'bg-indigo-100' : 'bg-gray-200'}`}>
                    <div
                      className={`h-2 rounded-full transition-all duration-1000 ${isWaiting ? 'bg-indigo-500' : 'bg-gray-300'}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })()}

            {/* 브라우저 상태 목록 (컴팩트 그리드) */}
            {progress.browserStatuses && progress.browserStatuses.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-semibold text-gray-700 mb-2">브라우저 상태</h4>
                <div className="grid grid-cols-5 gap-1">
                  {progress.browserStatuses.map((browser) => (
                    <div
                      key={browser.profileName}
                      className={`p-1.5 rounded border ${getStatusColor(browser.status)}`}
                    >
                      <div className="text-xs font-bold text-gray-800 truncate">
                        {browser.profileName}
                      </div>
                      {browser.storeName && (
                        <div className="text-xs text-gray-600 truncate">
                          {browser.platform === 'NAVER' && (
                            <span className="inline-block w-3.5 text-center font-bold text-green-700 mr-0.5">N</span>
                          )}
                          {browser.platform === 'AUCTION' && (
                            <span className="inline-block w-3.5 text-center font-bold text-red-700 mr-0.5">A</span>
                          )}
                          {browser.storeName}
                        </div>
                      )}
                      <div className="text-xs text-gray-500 truncate">
                        {(browser.status === 'idle' || browser.status === 'waiting')
                          ? '대기 중'
                          : (browser.message || '')}
                        {browser.collectedCount !== undefined && browser.collectedCount > 0 && (
                          <span className="ml-0.5 text-green-600 font-semibold">
                            ({browser.collectedCount}개)
                          </span>
                        )}
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
            {isPreparing && (
              <span className="px-3 py-1 bg-cyan-100 text-cyan-800 rounded-full text-sm font-medium animate-pulse">
                준비 중...
              </span>
            )}
            {!isPreparing && preparingStatuses.some(s => s.status === 'success') && (
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

          {/* 각 브라우저 상태 (컴팩트 그리드) */}
          <div className="grid grid-cols-5 gap-1">
            {preparingStatuses.map((browser) => (
              <div
                key={browser.profileName}
                className={`p-1.5 rounded border ${getStatusColor(browser.status)}`}
              >
                <div className="text-xs font-bold text-gray-800 truncate">
                  {browser.profileName}
                </div>
                <div className="text-xs text-gray-500 truncate">
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

import { useState, useEffect } from "react";
import { useStore } from "../../store";
import { Button } from "@/components/ui/button";

interface BrowserStatus {
  [profileId: string]: "idle" | "starting" | "running" | "stopping";
}

function AdsPowerTest() {
  const { apiKey, profiles, setProfiles, urlList, setUrlList, insertUrl, setInsertUrl } = useStore();
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus>({});
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [isBulkStarting, setIsBulkStarting] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [isAssigningProxy, setIsAssigningProxy] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResults, setVerificationResults] = useState<any[]>([]);
  const [isFetchingUrls, setIsFetchingUrls] = useState(false);
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlResults, setCrawlResults] = useState<any[]>([]);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    if (!apiKey) {
      return;
    }

    try {
      const result = await window.electronAPI.adspower.listProfiles(apiKey);
      if (result.code === 0) {
        setProfiles(result.data.list || []);
      }
    } catch (error) {
      console.error("Failed to load profiles:", error);
    }
  };

  const handleStartBrowser = async (profileId: string, profileName: string) => {
    setBrowserStatus((prev) => ({ ...prev, [profileId]: "starting" }));

    try {
      const result = await window.electronAPI.adspower.startBrowser(
        apiKey,
        profileId,
      );

      setDebugInfo({
        action: "start",
        profileId,
        profileName,
        result,
        timestamp: new Date().toISOString(),
      });

      if (result.code === 0) {
        setBrowserStatus((prev) => ({ ...prev, [profileId]: "running" }));
        alert(
          `✅ 브라우저 실행 성공\n프로필: ${profileName}\n\n"Puppeteer 테스트" 버튼을 눌러보세요!`,
        );
      } else {
        setBrowserStatus((prev) => ({ ...prev, [profileId]: "idle" }));
        alert(`❌ 브라우저 실행 실패\n${result.msg || "알 수 없는 오류"}`);
      }
    } catch (error: any) {
      setBrowserStatus((prev) => ({ ...prev, [profileId]: "idle" }));
      alert(`❌ 오류 발생\n${error.message}`);
    }
  };

  const handleStopBrowser = async (profileId: string, profileName: string) => {
    setBrowserStatus((prev) => ({ ...prev, [profileId]: "stopping" }));

    try {
      const result = await window.electronAPI.adspower.stopBrowser(
        apiKey,
        profileId,
      );

      setDebugInfo({
        action: "stop",
        profileId,
        profileName,
        result,
        timestamp: new Date().toISOString(),
      });

      if (result.code === 0) {
        setBrowserStatus((prev) => ({ ...prev, [profileId]: "idle" }));
        alert(`✅ 브라우저 종료 성공\n프로필: ${profileName}`);
      } else {
        setBrowserStatus((prev) => ({ ...prev, [profileId]: "running" }));
        alert(`❌ 브라우저 종료 실패\n${result.msg || "알 수 없는 오류"}`);
      }
    } catch (error: any) {
      setBrowserStatus((prev) => ({ ...prev, [profileId]: "running" }));
      alert(`❌ 오류 발생\n${error.message}`);
    }
  };

  const handlePuppeteerTest = async (
    profileId: string,
    profileName: string,
  ) => {
    try {
      const result = await window.electronAPI.adspower.puppeteerTest(
        apiKey,
        profileId,
      );

      // Debug 정보 업데이트 (콘솔 로그 포함)
      setDebugInfo({
        action: "puppeteer-test",
        profileId,
        profileName,
        result,
        consoleLogs: result.consoleLogs || [],
        timestamp: new Date().toISOString(),
      });

      if (result.success) {
        alert(
          `✅ Puppeteer 제어 성공!\n프로필: ${profileName}\n\n네이버 검색어 입력 및 검색 완료`,
        );
      } else {
        alert(`❌ Puppeteer 제어 실패\n${result.message}`);
      }
    } catch (error: any) {
      alert(`❌ Puppeteer 테스트 오류\n${error.message}`);
    }
  };

  const handleStartAllBrowsers = async () => {
    if (profiles.length === 0) {
      alert("⚠️ 시작할 프로필이 없습니다.");
      return;
    }

    setIsBulkStarting(true);
    let successCount = 0;
    let failCount = 0;

    for (const profile of profiles) {
      // 이미 실행 중인 브라우저는 건너뛰기
      if (browserStatus[profile.user_id] === "running") {
        console.log(`[Bulk Start] Skipping ${profile.name} - already running`);
        continue;
      }

      setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "starting" }));

      try {
        const result = await window.electronAPI.adspower.startBrowser(
          apiKey,
          profile.user_id,
        );

        if (result.code === 0) {
          setBrowserStatus((prev) => ({
            ...prev,
            [profile.user_id]: "running",
          }));
          successCount++;
          console.log(`✅ [Bulk Start] ${profile.name} started successfully`);
        } else {
          setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "idle" }));
          failCount++;
          console.error(`❌ [Bulk Start] ${profile.name} failed:`, result.msg);
        }
      } catch (error: any) {
        setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "idle" }));
        failCount++;
        console.error(`❌ [Bulk Start] ${profile.name} error:`, error.message);
      }

      // 각 브라우저 시작 사이에 500ms 딜레이 (부하 분산)
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    setIsBulkStarting(false);
    alert(
      `🎉 일괄 브라우저 시작 완료\n\n✅ 성공: ${successCount}개\n❌ 실패: ${failCount}개`,
    );
  };

  const handleStopAllBrowsers = async () => {
    const runningProfiles = profiles.filter(
      (p) => browserStatus[p.user_id] === "running",
    );

    if (runningProfiles.length === 0) {
      alert("⚠️ 실행 중인 브라우저가 없습니다.");
      return;
    }

    setIsBulkStarting(true);
    let successCount = 0;
    let failCount = 0;

    for (const profile of runningProfiles) {
      setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "stopping" }));

      try {
        const result = await window.electronAPI.adspower.stopBrowser(
          apiKey,
          profile.user_id,
        );

        if (result.code === 0) {
          setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "idle" }));
          successCount++;
          console.log(`✅ [Bulk Stop] ${profile.name} stopped successfully`);
        } else {
          setBrowserStatus((prev) => ({
            ...prev,
            [profile.user_id]: "running",
          }));
          failCount++;
          console.error(`❌ [Bulk Stop] ${profile.name} failed:`, result.msg);
        }
      } catch (error: any) {
        setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "running" }));
        failCount++;
        console.error(`❌ [Bulk Stop] ${profile.name} error:`, error.message);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    setIsBulkStarting(false);
    alert(
      `🎉 일괄 브라우저 종료 완료\n\n✅ 성공: ${successCount}개\n❌ 실패: ${failCount}개`,
    );
  };

  const handleAssignProxyToAll = async () => {
    if (!apiKey) {
      alert("⚠️ API Key가 설정되지 않았습니다.");
      return;
    }

    setIsAssigningProxy(true);

    try {
      const result = await window.electronAPI.session.assignProxyToAll(apiKey);

      if (result.success) {
        const successCount = result.results.filter(
          (r: any) => r.success,
        ).length;
        const failCount = result.results.filter((r: any) => !r.success).length;

        // 세션 목록 가져오기
        const sessionsResult = await window.electronAPI.session.getAll(apiKey);
        if (sessionsResult.success) {
          setSessions(sessionsResult.sessions);
        }

        alert(
          `🎉 Proxy 할당 완료\n\n✅ 성공: ${successCount}개\n❌ 실패: ${failCount}개`,
        );
      } else {
        alert(`❌ Proxy 할당 실패\n${result.message}`);
      }
    } catch (error: any) {
      alert(`❌ 오류 발생\n${error.message}`);
    } finally {
      setIsAssigningProxy(false);
    }
  };

  const handleLoadSessions = async () => {
    if (!apiKey) return;

    try {
      const result = await window.electronAPI.session.getAll(apiKey);
      if (result.success) {
        setSessions(result.sessions);
        console.log("[Sessions]", result.sessions);
      }
    } catch (error: any) {
      console.error("Failed to load sessions:", error);
    }
  };

  const handleVerifyAndStartAll = async () => {
    if (profiles.length === 0) {
      alert("⚠️ 시작할 프로필이 없습니다.");
      return;
    }

    setIsVerifying(true);

    // 1. 먼저 모든 프로필에 Proxy 할당 (SessionManager에 등록)
    console.log("\n🔗 Step 1: Assigning proxies to all profiles...");
    try {
      const assignResult = await window.electronAPI.session.assignProxyToAll(apiKey);
      if (!assignResult.success) {
        setIsVerifying(false);
        alert(`❌ Proxy 할당 실패\n${assignResult.error || '알 수 없는 오류'}`);
        return;
      }
      console.log("✅ Proxy assignment completed");
    } catch (error) {
      setIsVerifying(false);
      const errorMessage = error instanceof Error ? error.message : '알 수 없는 오류';
      alert(`❌ Proxy 할당 중 오류\n${errorMessage}`);
      return;
    }

    // 2. 각 프로필 검증 및 시작
    console.log("\n🔍 Step 2: Verifying and starting browsers...");
    const results: any[] = [];

    for (const profile of profiles) {
      console.log(`\n🔍 Verifying ${profile.name}...`);

      try {
        const result = await window.electronAPI.browser.startAndVerify(
          apiKey,
          profile.user_id,
          profile.name,
          3, // 최대 3번 재시도
        );

        results.push(result);

        if (result.success) {
          setBrowserStatus((prev) => ({
            ...prev,
            [profile.user_id]: "running",
          }));
          console.log(
            `✅ ${profile.name}: Success (${result.retryCount} attempts)`,
          );
        } else {
          setBrowserStatus((prev) => ({ ...prev, [profile.user_id]: "idle" }));
          console.error(
            `❌ ${profile.name}: Failed after ${result.retryCount} attempts`,
          );
        }
      } catch (error: any) {
        console.error(`❌ ${profile.name}: Error - ${error.message}`);
        results.push({
          success: false,
          profileId: profile.user_id,
          profileName: profile.name,
          message: error.message,
        });
      }

      // 각 브라우저 시작 사이에 1초 딜레이
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    setVerificationResults(results);
    setIsVerifying(false);

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    // 세션 정보 로드 (크롤링을 위해 필요)
    await handleLoadSessions();

    alert(
      `🎉 Proxy 검증 및 브라우저 시작 완료\n\n` +
        `✅ 성공: ${successCount}개\n` +
        `❌ 실패: ${failCount}개\n\n` +
        `실패한 프로필은 Proxy가 모두 차단되었을 수 있습니다.`,
    );
  };

  const handleStartCrawling = async () => {
    if (sessions.length === 0) {
      alert('실행 중인 브라우저가 없습니다. 먼저 "Proxy 검증 + 시작" 버튼을 눌러주세요.');
      return;
    }

    setIsCrawling(true);
    setCrawlResults([]);

    try {
      console.log(`\n🚀 Starting crawling with ${sessions.length} browsers\n`);

      const result = await window.electronAPI.crawler.startBatch(apiKey, sessions);

      if (result.success) {
        setCrawlResults(result.results || []);
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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "starting":
        return (
          <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-xs font-semibold">
            시작 중...
          </span>
        );
      case "running":
        return (
          <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-xs font-semibold">
            실행 중
          </span>
        );
      case "stopping":
        return (
          <span className="px-3 py-1 bg-orange-100 text-orange-800 rounded-full text-xs font-semibold">
            종료 중...
          </span>
        );
      default:
        return (
          <span className="px-3 py-1 bg-gray-100 text-gray-800 rounded-full text-xs font-semibold">
            대기
          </span>
        );
    }
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold">AdsPower 브라우저 테스트</h2>
        <div className="flex gap-2">
          {/* 1️⃣ Proxy 검증 + 브라우저 시작 */}
          <Button
            onClick={handleVerifyAndStartAll}
            disabled={isVerifying || profiles.length === 0}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
            size="sm"
          >
            {isVerifying ? "⏳ 검증 중..." : "1️⃣ Proxy 검증 + 시작"}
          </Button>
          {/* 2️⃣ 크롤링 시작 */}
          <Button
            onClick={handleStartCrawling}
            disabled={isCrawling || sessions.length === 0}
            className="bg-orange-600 hover:bg-orange-700 text-white font-semibold"
            size="sm"
          >
            {isCrawling ? "⏳ 크롤링 중..." : "2️⃣ 크롤링 시작"}
          </Button>
          {/* 구분선 */}
          <div className="border-l border-gray-300 mx-1"></div>
          {/* 기타 관리 버튼들 */}
          <Button
            onClick={handleAssignProxyToAll}
            disabled={isAssigningProxy || profiles.length === 0}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            size="sm"
          >
            {isAssigningProxy ? "⏳ 할당 중..." : "🔗 Proxy 할당"}
          </Button>
          <Button
            onClick={handleStartAllBrowsers}
            disabled={isBulkStarting || profiles.length === 0}
            className="bg-green-600 hover:bg-green-700 text-white"
            size="sm"
          >
            {isBulkStarting ? "⏳ 시작 중..." : "🚀 브라우저 열기"}
          </Button>
          <Button
            onClick={handleStopAllBrowsers}
            disabled={
              isBulkStarting ||
              Object.values(browserStatus).filter((s) => s === "running")
                .length === 0
            }
            variant="destructive"
            size="sm"
          >
            {isBulkStarting ? "⏳ 종료 중..." : "⏹️ 모든 브라우저 닫기"}
          </Button>
          <Button onClick={loadProfiles} variant="outline" size="sm">
            🔄 새로고침
          </Button>
        </div>
      </div>

      {!apiKey && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
          <p className="text-yellow-800">
            ⚠️ 설정에서 API Key를 먼저 입력해주세요.
          </p>
        </div>
      )}

      {/* 검증 결과 */}
      {verificationResults.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-4">
            🔍 Proxy 검증 결과 ({verificationResults.length}개)
          </h3>
          <div className="space-y-2">
            {verificationResults.map((result: any, index: number) => (
              <div
                key={index}
                className={`p-3 rounded border ${
                  result.success
                    ? "bg-green-50 border-green-200"
                    : "bg-red-50 border-red-200"
                }`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-semibold">{result.profileName}</span>
                    <span className="text-sm text-gray-500 ml-2">
                      ({result.retryCount}번 시도)
                    </span>
                  </div>
                  <div className="text-sm">
                    {result.success ? (
                      <span className="text-green-700 font-semibold">
                        ✅ 성공
                      </span>
                    ) : (
                      <span className="text-red-700 font-semibold">
                        ❌ 실패
                      </span>
                    )}
                  </div>
                </div>
                {result.message && (
                  <div className="text-xs text-gray-600 mt-1">
                    {result.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* URL 목록 */}
      {urlList.length > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-6 mb-6">
          <h3 className="text-lg font-semibold text-indigo-900 mb-4">
            📋 크롤링 URL 목록 ({urlList.length}개)
          </h3>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {urlList.map((item: any, index: number) => (
              <div
                key={item.URLNUM || index}
                className="p-3 bg-white rounded border border-indigo-200 text-sm"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-semibold text-indigo-900">{item.TARGETSTORENAME}</span>
                    <span className="text-xs text-gray-500 ml-2">({item.URLPLATFORMS})</span>
                  </div>
                  <div className="text-xs text-gray-600">
                    {item.BESTYN === 'Y' && <span className="bg-green-100 text-green-800 px-2 py-1 rounded">BEST</span>}
                    {item.NEWYN === 'Y' && <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded ml-1">NEW</span>}
                  </div>
                </div>
                <div className="font-mono text-xs text-indigo-600 mt-1">{item.TARGETURL}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 크롤링 결과 */}
      {crawlResults.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-6 mb-6">
          <h3 className="text-lg font-semibold text-orange-900 mb-4">
            🔥 크롤링 결과 ({crawlResults.length}개)
          </h3>
          <div className="max-h-64 overflow-y-auto space-y-2">
            {crawlResults.map((result: any, index: number) => (
              <div
                key={result.urlNum || index}
                className={`p-3 rounded border ${
                  result.success
                    ? "bg-green-50 border-green-200"
                    : "bg-red-50 border-red-200"
                }`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-semibold">{result.storeName}</span>
                  </div>
                  <div className="text-sm">
                    {result.success ? (
                      <span className="text-green-700 font-semibold">✅ 성공</span>
                    ) : (
                      <span className="text-red-700 font-semibold">❌ 실패</span>
                    )}
                  </div>
                </div>
                {result.message && (
                  <div className="text-xs text-gray-600 mt-1">{result.message}</div>
                )}
                {result.error && (
                  <div className="text-xs text-red-600 mt-1">{result.error}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 세션 정보 */}
      {sessions.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-green-900">
              🔗 Profile-Proxy 매핑 ({sessions.length}개)
            </h3>
            <Button
              onClick={handleLoadSessions}
              className="bg-green-600 hover:bg-green-700 text-white"
              size="xs"
            >
              새로고침
            </Button>
          </div>
          <div className="space-y-2">
            {sessions.map((session: any) => (
              <div
                key={session.sessionId}
                className="bg-white p-3 rounded border"
              >
                <div className="flex justify-between items-center">
                  <div>
                    <span className="font-semibold">{session.profileName}</span>
                    <span className="text-gray-500 text-sm ml-2">
                      ({session.profileId})
                    </span>
                  </div>
                  <div className="text-sm font-mono">
                    <span className="text-blue-600">
                      {session.proxyIp}:{session.proxyPort}
                    </span>
                    <span className="text-gray-400 ml-2">
                      Proxy #{session.proxyId}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 프로필 목록 */}
      <div className="bg-white rounded-lg shadow-md mb-6">
        <div className="p-6 border-b">
          <h3 className="text-xl font-semibold">
            프로필 목록 ({profiles.length}개)
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  이름
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  프로필 ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  상태
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  작업
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {profiles.map((profile) => {
                const status = browserStatus[profile.user_id] || "idle";
                const isRunning = status === "running";
                const isLoading =
                  status === "starting" || status === "stopping";

                return (
                  <tr key={profile.user_id}>
                    <td className="px-6 py-4 text-sm font-medium">
                      {profile.name}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 font-mono">
                      {profile.user_id}
                    </td>
                    <td className="px-6 py-4">{getStatusBadge(status)}</td>
                    <td className="px-6 py-4">
                      <div className="flex gap-2">
                        {!isRunning ? (
                          <Button
                            onClick={() =>
                              handleStartBrowser(profile.user_id, profile.name)
                            }
                            disabled={isLoading}
                            className="bg-green-600 hover:bg-green-700 text-white"
                            size="sm"
                          >
                            ▶️ 브라우저 열기
                          </Button>
                        ) : (
                          <>
                            <Button
                              onClick={() =>
                                handleStopBrowser(profile.user_id, profile.name)
                              }
                              disabled={isLoading}
                              variant="destructive"
                              size="sm"
                            >
                              ⏹️ 브라우저 닫기
                            </Button>
                            <Button
                              onClick={() =>
                                handlePuppeteerTest(
                                  profile.user_id,
                                  profile.name,
                                )
                              }
                              className="bg-purple-600 hover:bg-purple-700 text-white"
                              size="sm"
                            >
                              🤖 Puppeteer 테스트
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {profiles.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              프로필이 없습니다. 프로필 관리에서 먼저 프로필을 생성해주세요.
            </div>
          )}
        </div>
      </div>

      {/* Debug 정보 */}
      {debugInfo && (
        <div className="space-y-4">
          {/* 콘솔 로그 */}
          {debugInfo.consoleLogs && debugInfo.consoleLogs.length > 0 && (
            <div className="bg-gray-900 text-white rounded-lg p-6">
              <h3 className="text-lg font-semibold mb-3">
                🖥️ 브라우저 콘솔 로그 ({debugInfo.consoleLogs.length}개)
              </h3>
              <div className="space-y-2">
                {debugInfo.consoleLogs.map((log: any, index: number) => (
                  <div
                    key={index}
                    className={`text-sm font-mono p-2 rounded ${
                      log.type === "error"
                        ? "bg-red-900 text-red-200"
                        : log.type === "warning"
                          ? "bg-yellow-900 text-yellow-200"
                          : "bg-gray-800 text-gray-300"
                    }`}
                  >
                    <span className="text-gray-500 mr-2">[{log.type}]</span>
                    {log.text}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Debug 정보 */}
          <div className="bg-gray-900 text-white rounded-lg p-6">
            <h3 className="text-lg font-semibold mb-3">
              🐛 Debug Info (최근 작업)
            </h3>
            <pre className="text-sm overflow-x-auto">
              {JSON.stringify(debugInfo, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdsPowerTest;

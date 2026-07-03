import { useEffect, useState } from 'react';
import { useStore } from '../store';
import Settings from '../components/Settings/Settings';
import ProxyManager from '../components/ProxyManager/ProxyManager';
import Dashboard from '../components/Dashboard/Dashboard';

function App() {
  const { currentTab, setCurrentTab, setApiKey, setProxies } = useStore();
  const [isInitializing, setIsInitializing] = useState(true);
  const [initStatus, setInitStatus] = useState({ apiKey: false, proxies: false });

  // 앱 시작 시 자동으로 필요한 데이터 로드
  useEffect(() => {
    const initializeApp = async () => {
      setIsInitializing(true);

      try {
        // 1. AdsPower API Key 로드
        if (window.electronAPI) {
          const savedApiKey = await window.electronAPI.settings.get('adspowerApiKey');
          if (savedApiKey) {
            setApiKey(savedApiKey);
            setInitStatus(prev => ({ ...prev, apiKey: true }));

            // 2. 프록시 로드
            const proxiesData = await window.electronAPI.db.getProxies();
            setProxies(proxiesData);
            setInitStatus(prev => ({ ...prev, proxies: true }));

          }
        }
      } catch (error) {
        console.error('[App] Initialization error:', error);
      } finally {
        setIsInitializing(false);
      }
    };

    initializeApp();
  }, [setApiKey, setProxies]);

  const tabs = [
    { id: 'dashboard', label: '대시보드', icon: '📊' },
    { id: 'proxy', label: 'Proxy 관리', icon: '🌐' },
    { id: 'settings', label: '설정', icon: '⚙️' },
  ];

  return (
    <div className="flex h-screen bg-gray-100">
      {/* 사이드바 */}
      <div className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold">AdsPower</h1>
          <p className="text-sm text-gray-400 mt-1">Browser Automation</p>
        </div>

        <nav className="flex-1 px-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 mb-2 rounded-lg transition-colors ${
                currentTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              <span className="text-xl">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        {/* 초기화 상태 표시 */}
        <div className="p-4 border-t border-gray-800">
          {isInitializing ? (
            <div className="text-xs text-yellow-400">
              <div className="animate-pulse">초기화 중...</div>
            </div>
          ) : (
            <div className="text-xs space-y-1">
              <div className={initStatus.apiKey ? 'text-green-400' : 'text-red-400'}>
                {initStatus.apiKey ? '✓' : '✗'} API Key
              </div>
              <div className={initStatus.proxies ? 'text-green-400' : 'text-red-400'}>
                {initStatus.proxies ? '✓' : '✗'} Proxy
              </div>
            </div>
          )}
          <div className="text-xs text-gray-500 mt-2">v{__APP_VERSION__}</div>
        </div>
      </div>

      {/* 메인 컨텐츠 */}
      <div className="flex-1 overflow-auto relative">
        {/* 초기화 중 오버레이 */}
        {isInitializing && (
          <div className="absolute inset-0 bg-white bg-opacity-80 flex items-center justify-center z-50">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <div className="text-lg font-semibold text-gray-700">앱 초기화 중...</div>
              <div className="text-sm text-gray-500 mt-2">프록시 데이터를 불러오고 있습니다</div>
            </div>
          </div>
        )}

        {currentTab === 'settings' && <Settings />}
        {currentTab === 'proxy' && <ProxyManager />}
        {currentTab === 'dashboard' && <Dashboard />}
      </div>
    </div>
  );
}

export default App;

import { useState, useEffect } from 'react';
import { useStore } from '../../store';

const DEFAULT_GROUP_NAME = 'scrapper';
const DEFAULT_PROFILE_COUNT = 2;

function profileCountFromList(result: unknown): number {
  if (result && typeof result === 'object' && 'data' in result) {
    const data = result.data;
    if (data && typeof data === 'object' && 'list' in data && Array.isArray(data.list)) {
      return data.list.length;
    }
  }
  return 0;
}

function Settings() {
  const { setApiKey } = useStore();
  const [localApiKey, setLocalApiKey] = useState('');
  const [groupName, setGroupName] = useState(DEFAULT_GROUP_NAME);
  const [profileCount, setProfileCount] = useState(DEFAULT_PROFILE_COUNT);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.settings.get('adspowerApiKey').then((key) => {
      if (key) {
        setLocalApiKey(key);
        setApiKey(key);
      }
    });
    window.electronAPI.settings.get('scrapperGroupName').then((name) => {
      if (name) setGroupName(name);
    });
    window.electronAPI.settings.get('crawlProfileCount').then((count) => {
      const n = count ? parseInt(count, 10) : NaN;
      if (Number.isFinite(n) && n > 0) setProfileCount(n);
    });
  }, [setApiKey]);

  const handleSave = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.settings.set('adspowerApiKey', localApiKey);
      await window.electronAPI.settings.set('scrapperGroupName', groupName.trim() || DEFAULT_GROUP_NAME);
      await window.electronAPI.settings.set('crawlProfileCount', String(profileCount));
      setApiKey(localApiKey);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      alert(`설정 저장 실패\n${msg}`);
    }
  };

  const handleTest = async () => {
    if (!localApiKey.trim()) {
      alert('API Key를 입력해주세요.');
      return;
    }
    try {
      const result = await window.electronAPI.adspower.listProfiles(localApiKey);
      alert(`연결 성공!\n전체 프로필 수: ${profileCountFromList(result)}개`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      alert(`연결 실패\n${msg}`);
    }
  };

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold mb-6">설정</h2>

      <div className="bg-white rounded-lg shadow-md p-6 max-w-2xl">
        <h3 className="text-xl font-semibold mb-4">AdsPower API 설정</h3>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">API Key</label>
          <input
            type="password"
            value={localApiKey}
            onChange={(e) => setLocalApiKey(e.target.value)}
            placeholder="AdsPower API Key 입력"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-sm text-gray-500 mt-2">
            AdsPower 설정 &gt; API에서 Key를 확인하세요.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            저장
          </button>
          <button
            onClick={handleTest}
            className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
          >
            연결 테스트
          </button>
        </div>

        {saved && (
          <div className="mt-4 p-3 bg-green-100 text-green-800 rounded-lg">
            설정이 저장되었습니다.
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg shadow-md p-6 max-w-2xl mt-6">
        <h3 className="text-xl font-semibold mb-1">프로필 풀 설정</h3>
        <p className="text-sm text-gray-500 mb-4">
          프로필은 전용 그룹 안에서 자동으로 생성/삭제/재생성됩니다. 수동 관리는 필요 없습니다.
        </p>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">AdsPower 그룹 이름</label>
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder={DEFAULT_GROUP_NAME}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-sm text-gray-500 mt-2">
            이 이름의 그룹 안에서만 프로필을 다룹니다. 다른 앱(prowler 등)의 프로필과 섞이지 않습니다.
          </p>
        </div>

        <div className="mb-2">
          <label className="block text-sm font-medium text-gray-700 mb-2">동시 프로필 개수</label>
          <input
            type="number"
            min={1}
            max={100}
            value={profileCount}
            onChange={(e) => setProfileCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-32 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-sm text-gray-500 mt-2">
            크롤링에 사용할 프로필 수. 이 머신은 다른 앱과 AdsPower를 공유하므로 과도한 값은 피하세요.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            저장
          </button>
          {saved && (
            <span className="text-sm text-green-700">저장되었습니다.</span>
          )}
        </div>
      </div>

      <div className="max-w-2xl mt-6 p-4 bg-gray-50 rounded-lg">
        <h4 className="font-semibold mb-2">참고 사항</h4>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>- AdsPower 앱이 로컬에서 실행 중이어야 브라우저를 사용할 수 있습니다.</li>
          <li>- API 엔드포인트: http://local.adspower.net:50325</li>
          <li>- .env 파일에 ADSPOWER_API_KEY를 설정하면 자동으로 로드됩니다.</li>
        </ul>
      </div>
    </div>
  );
}

export default Settings;

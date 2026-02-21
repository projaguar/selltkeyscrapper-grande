import { useState, useEffect } from 'react';
import { useStore } from '../../store';

function Settings() {
  const { apiKey, setApiKey } = useStore();
  const [localApiKey, setLocalApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.settings.get('adspowerApiKey').then((key) => {
        if (key) {
          setLocalApiKey(key);
          setApiKey(key);
        }
      });
    }
  }, [setApiKey]);

  const handleSave = async () => {
    if (window.electronAPI) {
      await window.electronAPI.settings.set('adspowerApiKey', localApiKey);
      setApiKey(localApiKey);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  const handleTest = async () => {
    if (!localApiKey.trim()) {
      alert('API Key를 입력해주세요.');
      return;
    }

    try {
      const result = await window.electronAPI.adspower.listProfiles(localApiKey);
      // AdsPower returns { code: 0, data: { list: [...] } }
      const profiles = result.data?.list || [];
      alert(`연결 성공!\n프로필 수: ${profiles.length}개`);
    } catch (error: any) {
      alert(`연결 실패\n${error.message}`);
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
            API Key가 저장되었습니다.
          </div>
        )}

        <div className="mt-8 p-4 bg-gray-50 rounded-lg">
          <h4 className="font-semibold mb-2">참고 사항</h4>
          <ul className="text-sm text-gray-600 space-y-1">
            <li>- AdsPower 앱이 로컬에서 실행 중이어야 브라우저를 사용할 수 있습니다.</li>
            <li>- API 엔드포인트: http://local.adspower.net:50325</li>
            <li>- .env 파일에 ADSPOWER_API_KEY를 설정하면 자동으로 로드됩니다.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default Settings;

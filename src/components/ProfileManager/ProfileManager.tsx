import { useState, useEffect } from 'react';
import { useStore } from '../../store';

function ProfileManager() {
  const { apiKey, profiles, setProfiles, proxies } = useStore();
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [createCount, setCreateCount] = useState(10);
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

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
      console.error('Failed to load profiles:', error);
    }
  };

  const handleCreateProfiles = async () => {
    if (!apiKey) {
      alert('설정에서 API Key를 먼저 입력해주세요.');
      return;
    }

    if (createCount <= 0 || createCount > 1000) {
      alert('생성 개수는 1~1000 사이여야 합니다.');
      return;
    }

    const activeProxies = proxies.filter((p) => p.status === 'active');
    if (activeProxies.length === 0) {
      alert('활성 상태의 프록시가 없습니다. Proxy 관리 메뉴에서 먼저 프록시를 추가해주세요.');
      return;
    }

    if (activeProxies.length < createCount) {
      if (
        !confirm(
          `활성 프록시(${activeProxies.length}개)가 생성 개수(${createCount}개)보다 적습니다.\n프록시를 재사용하여 생성하시겠습니까?`
        )
      ) {
        return;
      }
    }

    setIsCreating(true);
    setProgress({ current: 0, total: createCount });

    try {
      const startIndex = profiles.length; // 기존 프로필 수부터 시작

      for (let i = 0; i < createCount; i++) {
        const proxyIndex = (startIndex + i) % activeProxies.length;
        const proxy = activeProxies[proxyIndex];
        const profileName = `Naver_Desktop_${String(startIndex + i + 1).padStart(4, '0')}`;

        const profileData = {
          name: profileName,
          group_id: '0',
          domain_name: '',  // 빈 문자열로 변경 (계정 플랫폼 미설정)
          open_urls: [],  // 빈 배열로 변경 (브라우저 시작 시 빈 탭만 열림)
          user_proxy_config: {
            proxy_soft: 'other',
            proxy_type: 'http',
            proxy_host: proxy.ip,
            proxy_port: proxy.port,
            proxy_user: proxy.username,
            proxy_password: proxy.password,
          },
          fingerprint_config: {
            automatic_timezone: '1',  // 문자열로 변경
            ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            language: ['ko-KR', 'ko'],
            screen_resolution: '1920_1080',
          },
        };

        const result = await window.electronAPI.adspower.createProfile(apiKey, profileData);

        if (result.code !== 0) {
          throw new Error(`프로필 생성 실패: ${result.msg || '알 수 없는 오류'}`);
        }

        setProgress({ current: i + 1, total: createCount });

        // API Rate Limit 방지
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      alert(`✅ ${createCount}개의 프로필이 생성되었습니다.`);
      await loadProfiles();
    } catch (error: any) {
      alert(`❌ 프로필 생성 실패\n${error.message}`);
    } finally {
      setIsCreating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedProfiles.length === 0) {
      alert('삭제할 프로필을 선택해주세요.');
      return;
    }

    if (!confirm(`선택한 ${selectedProfiles.length}개의 프로필을 삭제하시겠습니까?`)) {
      return;
    }

    setIsDeleting(true);

    try {
      const result = await window.electronAPI.adspower.deleteProfiles(apiKey, selectedProfiles);

      console.log('Delete API Response:', result);

      if (result.code === 0) {
        alert(`✅ ${selectedProfiles.length}개의 프로필이 삭제되었습니다.`);
        setSelectedProfiles([]);
        await loadProfiles();
      } else {
        alert(`❌ 프로필 삭제 실패\n${result.msg || '알 수 없는 오류'}`);
      }
    } catch (error: any) {
      alert(`❌ 프로필 삭제 실패\n${error.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteAll = async () => {
    if (profiles.length === 0) {
      alert('삭제할 프로필이 없습니다.');
      return;
    }

    if (
      !confirm(
        `⚠️ 모든 프로필(${profiles.length}개)을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`
      )
    ) {
      return;
    }

    setIsDeleting(true);

    try {
      const profileIds = profiles.map((p) => p.user_id);
      const result = await window.electronAPI.adspower.deleteProfiles(apiKey, profileIds);

      console.log('Delete API Response:', result);

      if (result.code === 0) {
        alert(`✅ 모든 프로필이 삭제되었습니다.`);
        await loadProfiles();
        setSelectedProfiles([]);
      } else {
        alert(`❌ 프로필 삭제 실패\n${result.msg || '알 수 없는 오류'}`);
      }
    } catch (error: any) {
      alert(`❌ 프로필 삭제 실패\n${error.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedProfiles.length === profiles.length) {
      setSelectedProfiles([]);
    } else {
      setSelectedProfiles(profiles.map((p) => p.user_id));
    }
  };

  const toggleSelect = (userId: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold mb-6">AdsPower 프로필 관리</h2>

      {/* 생성 섹션 */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h3 className="text-xl font-semibold mb-4">프로필 생성</h3>
        <div className="flex items-center gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">생성 개수</label>
            <input
              type="number"
              value={createCount}
              onChange={(e) => setCreateCount(parseInt(e.target.value) || 0)}
              min="1"
              max="1000"
              className="w-32 px-4 py-2 border rounded-lg"
              disabled={isCreating}
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-2">활성 프록시 수</label>
            <div className="text-2xl font-bold text-green-600">
              {proxies.filter((p) => p.status === 'active').length}개
            </div>
          </div>
          <button
            onClick={handleCreateProfiles}
            disabled={isCreating}
            className={`mt-6 px-6 py-2 rounded-lg text-white ${
              isCreating ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {isCreating ? '생성 중...' : `${createCount}개 생성`}
          </button>
        </div>

        {isCreating && (
          <div className="mt-4">
            <div className="flex justify-between text-sm mb-1">
              <span>진행 중...</span>
              <span>
                {progress.current} / {progress.total}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 프로필 목록 */}
      <div className="bg-white rounded-lg shadow-md">
        <div className="p-6 border-b flex justify-between items-center">
          <div className="flex items-center gap-4">
            <h3 className="text-xl font-semibold">프로필 목록</h3>
            <button
              onClick={loadProfiles}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300"
            >
              🔄 새로고침
            </button>
            <div className="text-sm text-gray-500">
              총 {profiles.length}개 | 선택 {selectedProfiles.length}개
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedProfiles.length === profiles.length && profiles.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  이름
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  프로필 ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  그룹
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {profiles.map((profile) => (
                <tr key={profile.user_id}>
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      checked={selectedProfiles.includes(profile.user_id)}
                      onChange={() => toggleSelect(profile.user_id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-6 py-4 text-sm font-medium">{profile.name}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{profile.user_id}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {profile.group_name || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {profiles.length === 0 && (
            <div className="text-center py-12 text-gray-500">프로필이 없습니다.</div>
          )}
        </div>

        {/* 하단 액션 버튼 */}
        {profiles.length > 0 && (
          <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
            <button
              onClick={handleDeleteSelected}
              disabled={isDeleting || selectedProfiles.length === 0}
              style={{
                backgroundColor: isDeleting || selectedProfiles.length === 0 ? '#D1D5DB' : '#DC2626',
                color: '#FFFFFF',
                fontWeight: '600',
                fontSize: '16px',
              }}
              className="px-6 py-3 rounded-lg shadow-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🗑️ 선택한 {selectedProfiles.length}개 삭제
            </button>
            <button
              onClick={handleDeleteAll}
              disabled={isDeleting}
              style={{
                backgroundColor: isDeleting ? '#D1D5DB' : '#B91C1C',
                color: '#FFFFFF',
                fontWeight: '600',
                fontSize: '16px',
              }}
              className="px-6 py-3 rounded-lg shadow-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              ⚠️ 전체 {profiles.length}개 삭제
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ProfileManager;

import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import type { GoLoginProfile } from '../../store';

function ProfileManager() {
  const { apiKey, goLoginProfiles, setGoLoginProfiles } = useStore();
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // 일괄 생성 상태
  const [createCount, setCreateCount] = useState(10);
  const [isCreating, setIsCreating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // 편집 모달 상태
  const [editingProfile, setEditingProfile] = useState<GoLoginProfile | null>(null);
  const [editName, setEditName] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    if (!apiKey) return;

    setIsLoading(true);
    try {
      const result = await window.electronAPI.gologin.listProfiles(apiKey);
      const profiles: GoLoginProfile[] = Array.isArray(result)
        ? result
        : result.profiles || result.data || [];
      setGoLoginProfiles(profiles);
    } catch (error) {
      console.error('GoLogin 프로필 로드 실패:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkCreate = async () => {
    if (!apiKey) {
      alert('설정에서 API Key를 먼저 입력해주세요.');
      return;
    }
    if (createCount <= 0 || createCount > 200) {
      alert('생성 개수는 1~200 사이여야 합니다.');
      return;
    }

    setIsCreating(true);
    setProgress({ current: 0, total: createCount });

    try {
      const startIndex = goLoginProfiles.length;

      for (let i = 0; i < createCount; i++) {
        const profileName = `gl-${String(startIndex + i + 1).padStart(3, '0')}`;

        const result = await window.electronAPI.gologin.createProfile(apiKey, profileName);

        if (result.error) {
          throw new Error(`프로필 생성 실패 (${i + 1}/${createCount}): ${result.error}`);
        }

        setProgress({ current: i + 1, total: createCount });

        // API Rate Limit 방지
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      alert(`${createCount}개의 프로필이 생성되었습니다.`);
      await loadProfiles();
    } catch (error: any) {
      alert(`프로필 생성 실패\n${error.message}`);
      await loadProfiles();
    } finally {
      setIsCreating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const openEditModal = (profile: GoLoginProfile) => {
    setEditingProfile(profile);
    setEditName(profile.name);
    setEditNotes(profile.notes || '');
  };

  const handleSaveEdit = async () => {
    if (!editingProfile || !apiKey) return;

    setIsSaving(true);
    try {
      const result = await window.electronAPI.gologin.updateProfile(apiKey, editingProfile.id, {
        name: editName.trim(),
        notes: editNotes,
      });

      if (result.error) {
        alert(`프로필 수정 실패: ${result.error}`);
        return;
      }

      alert('프로필이 수정되었습니다.');
      setEditingProfile(null);
      await loadProfiles();
    } catch (error: any) {
      alert(`프로필 수정 실패: ${error.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedProfiles.length === 0) {
      alert('삭제할 프로필을 선택해주세요.');
      return;
    }
    if (!confirm(`선택한 ${selectedProfiles.length}개의 프로필을 삭제하시겠습니까?`)) return;

    setIsDeleting(true);
    try {
      const result = await window.electronAPI.gologin.deleteProfiles(apiKey, selectedProfiles);
      if (result.error) {
        alert(`삭제 실패: ${result.error}`);
        return;
      }

      alert(`${selectedProfiles.length}개의 프로필이 삭제되었습니다.`);
      setSelectedProfiles([]);
      await loadProfiles();
    } catch (error: any) {
      alert(`삭제 실패: ${error.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedProfiles.length === goLoginProfiles.length) {
      setSelectedProfiles([]);
    } else {
      setSelectedProfiles(goLoginProfiles.map((p) => p.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(id) ? prev.filter((pid) => pid !== id) : [...prev, id]
    );
  };

  const getProxyDisplay = (profile: GoLoginProfile) => {
    if (!profile.proxy || profile.proxy.mode === 'none' || !profile.proxy.host) {
      return '-';
    }
    return `${profile.proxy.mode}://${profile.proxy.host}:${profile.proxy.port || ''}`;
  };

  const stripHtml = (html: string) => {
    return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  };

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold mb-6">GoLogin 프로필 관리</h2>

      {/* 일괄 생성 영역 */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h3 className="text-xl font-semibold mb-4">프로필 일괄 생성</h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">생성 개수</label>
            <input
              type="number"
              value={createCount}
              onChange={(e) => setCreateCount(Number(e.target.value))}
              min={1}
              max={200}
              disabled={isCreating}
              className="w-24 px-3 py-2 border rounded-lg text-center"
            />
            <span className="text-sm text-gray-500">개</span>
          </div>
          <button
            onClick={handleBulkCreate}
            disabled={isCreating}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {isCreating ? '생성 중...' : '일괄 생성'}
          </button>
          <span className="text-sm text-gray-400">
            이름: gl-{String(goLoginProfiles.length + 1).padStart(3, '0')} ~ gl-{String(goLoginProfiles.length + createCount).padStart(3, '0')}
          </span>
        </div>

        {/* 진행 바 */}
        {isCreating && (
          <div className="mt-4">
            <div className="flex justify-between text-sm text-gray-600 mb-1">
              <span>프로필 생성 중...</span>
              <span>{progress.current} / {progress.total}</span>
            </div>
            <div className="bg-gray-200 rounded-full h-3">
              <div
                className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
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
              disabled={isLoading}
              className="px-4 py-2 text-sm bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-50"
            >
              {isLoading ? '로딩 중...' : '새로고침'}
            </button>
            <div className="text-sm text-gray-500">
              총 {goLoginProfiles.length}개 | 선택 {selectedProfiles.length}개
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
                    checked={
                      selectedProfiles.length === goLoginProfiles.length &&
                      goLoginProfiles.length > 0
                    }
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  이름
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  OS
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  브라우저
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  프록시
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  메모
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase w-16">
                  작업
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {goLoginProfiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="px-6 py-4">
                    <input
                      type="checkbox"
                      checked={selectedProfiles.includes(profile.id)}
                      onChange={() => toggleSelect(profile.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-6 py-4 text-sm font-medium">{profile.name}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{profile.os || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{profile.browserType || '-'}</td>
                  <td className="px-6 py-4 text-sm text-gray-500">{getProxyDisplay(profile)}</td>
                  <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                    {profile.notes ? stripHtml(profile.notes) : '-'}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => openEditModal(profile)}
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      편집
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {goLoginProfiles.length === 0 && !isLoading && (
            <div className="text-center py-12 text-gray-500">프로필이 없습니다.</div>
          )}
          {isLoading && (
            <div className="text-center py-12 text-gray-500">프로필을 불러오는 중...</div>
          )}
        </div>

        {/* 하단 액션 버튼 */}
        {goLoginProfiles.length > 0 && (
          <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
            <button
              onClick={handleDeleteSelected}
              disabled={isDeleting || selectedProfiles.length === 0}
              className={`px-6 py-3 rounded-lg shadow-lg font-semibold text-white ${
                isDeleting || selectedProfiles.length === 0
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {isDeleting ? '삭제 중...' : `선택한 ${selectedProfiles.length}개 삭제`}
            </button>
          </div>
        )}
      </div>

      {/* 프로필 편집 모달 */}
      {editingProfile && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4">프로필 편집</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">프로필 이름</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-2 border rounded-lg resize-none"
                  placeholder="메모 입력 (선택)"
                />
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSaveEdit}
                  disabled={isSaving}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {isSaving ? '저장 중...' : '저장'}
                </button>
                <button
                  onClick={() => setEditingProfile(null)}
                  className="px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProfileManager;

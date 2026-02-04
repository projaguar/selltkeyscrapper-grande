import { useState, useEffect } from 'react';
import { useStore } from '../../store';

interface ProxyGroup {
  id: number;
  name: string;
  max_browsers: number;
  created_at: string;
  proxy_count?: number;
  active_count?: number;
  dead_count?: number;
  in_use_count?: number;
}

interface Proxy {
  id: number;
  group_id: number;
  ip: string;
  port: string;
  username?: string;
  password?: string;
  status: 'active' | 'dead' | 'in_use';
  last_checked?: string;
  fail_count: number;
  success_count: number;
  created_at: string;
}

function ProxyManager() {
  const { proxies, setProxies, deleteProxy, proxyGroups, setProxyGroups } = useStore();

  // 그룹 관련 상태
  const [selectedGroupId, setSelectedGroupId] = useState<number>(1);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ProxyGroup | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupMaxBrowsers, setNewGroupMaxBrowsers] = useState(5);

  // 프록시 관련 상태
  const [showAddModal, setShowAddModal] = useState(false);
  const [newProxy, setNewProxy] = useState({ ip: '', port: '', username: '', password: '' });
  const [bulkText, setBulkText] = useState('');
  const [filter, setFilter] = useState('all');
  const [isBulkMode, setIsBulkMode] = useState(false);

  useEffect(() => {
    loadProxyGroups();
    loadProxies();
  }, []);

  const loadProxyGroups = async () => {
    if (window.electronAPI) {
      const data = await window.electronAPI.db.getProxyGroupsWithCount();
      setProxyGroups(data);
    }
  };

  const loadProxies = async () => {
    if (window.electronAPI) {
      const data = await window.electronAPI.db.getProxies();
      setProxies(data);
    }
  };

  // 그룹 관련 핸들러
  const handleAddGroup = async () => {
    if (!newGroupName.trim()) {
      alert('그룹 이름을 입력해주세요.');
      return;
    }

    if (window.electronAPI) {
      try {
        await window.electronAPI.db.addProxyGroup(newGroupName.trim(), newGroupMaxBrowsers);
        await loadProxyGroups();
        setNewGroupName('');
        setNewGroupMaxBrowsers(5);
        setShowGroupModal(false);
      } catch (error: any) {
        alert(`그룹 추가 실패: ${error.message}`);
      }
    }
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup) return;

    if (window.electronAPI) {
      try {
        await window.electronAPI.db.updateProxyGroup(editingGroup.id, {
          name: newGroupName.trim(),
          max_browsers: newGroupMaxBrowsers,
        });
        await loadProxyGroups();
        setEditingGroup(null);
        setNewGroupName('');
        setNewGroupMaxBrowsers(5);
        setShowGroupModal(false);
      } catch (error: any) {
        alert(`그룹 수정 실패: ${error.message}`);
      }
    }
  };

  const handleDeleteGroup = async (groupId: number) => {
    if (groupId === 1) {
      alert('기본 그룹은 삭제할 수 없습니다.');
      return;
    }

    if (!confirm('정말 이 그룹을 삭제하시겠습니까?\n그룹 내 프록시들은 기본 그룹으로 이동됩니다.')) {
      return;
    }

    if (window.electronAPI) {
      try {
        await window.electronAPI.db.deleteProxyGroup(groupId);
        await loadProxyGroups();
        await loadProxies();
        if (selectedGroupId === groupId) {
          setSelectedGroupId(1);
        }
      } catch (error: any) {
        alert(`그룹 삭제 실패: ${error.message}`);
      }
    }
  };

  const openEditGroupModal = (group: ProxyGroup) => {
    setEditingGroup(group);
    setNewGroupName(group.name);
    setNewGroupMaxBrowsers(group.max_browsers);
    setShowGroupModal(true);
  };

  const openAddGroupModal = () => {
    setEditingGroup(null);
    setNewGroupName('');
    setNewGroupMaxBrowsers(5);
    setShowGroupModal(true);
  };

  // 프록시 관련 핸들러
  const handleAddProxy = async () => {
    if (!newProxy.ip || !newProxy.port) {
      alert('IP와 Port는 필수입니다.');
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.addProxy({
        ...newProxy,
        group_id: selectedGroupId,
      });
      await loadProxies();
      await loadProxyGroups();
      setNewProxy({ ip: '', port: '', username: '', password: '' });
      setShowAddModal(false);
    }
  };

  const handleBulkAdd = async () => {
    const lines = bulkText.trim().split('\n');
    const proxiesToAdd = lines
      .map((line) => {
        const parts = line.trim().split(':');
        if (parts.length >= 2) {
          return {
            ip: parts[0],
            port: parts[1],
            username: parts[2] || '',
            password: parts[3] || '',
          };
        }
        return null;
      })
      .filter(Boolean);

    if (proxiesToAdd.length === 0) {
      alert('올바른 형식의 프록시 정보를 입력해주세요.\n예: 123.45.67.89:8080:user:pass');
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.bulkAddProxies(proxiesToAdd, selectedGroupId);
      await loadProxies();
      await loadProxyGroups();
      setBulkText('');
      setShowAddModal(false);
      alert(`${proxiesToAdd.length}개의 프록시가 추가되었습니다.`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm('정말 삭제하시겠습니까?')) {
      if (window.electronAPI) {
        await window.electronAPI.db.deleteProxy(id);
        deleteProxy(id);
        await loadProxyGroups();
      }
    }
  };

  const handleUpdateStatus = async (id: number, status: string) => {
    if (window.electronAPI) {
      await window.electronAPI.db.updateProxy(id, { status });
      await loadProxies();
      await loadProxyGroups();
    }
  };

  const handleDeleteAllInGroup = async () => {
    const groupProxies = proxies.filter((p) => p.group_id === selectedGroupId);
    if (groupProxies.length === 0) {
      alert('삭제할 프록시가 없습니다.');
      return;
    }

    const selectedGroup = proxyGroups.find((g) => g.id === selectedGroupId);
    if (!confirm(`정말로 "${selectedGroup?.name}" 그룹의 모든 프록시(${groupProxies.length}개)를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.deleteProxiesByGroup(selectedGroupId);
      await loadProxies();
      await loadProxyGroups();
      alert('프록시가 삭제되었습니다.');
    }
  };

  const handleImportFromFile = async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.db.importProxiesFromFile(selectedGroupId);

      if (result.success) {
        await loadProxies();
        await loadProxyGroups();
        alert(`${result.count}개의 프록시를 가져왔습니다.`);
      } else {
        alert(`오류: ${result.message}`);
      }
    }
  };

  // 선택된 그룹의 프록시만 필터링
  const groupProxies = proxies.filter((p) => p.group_id === selectedGroupId);
  const filteredProxies = groupProxies.filter((p) => {
    if (filter === 'all') return true;
    return p.status === filter;
  });

  const selectedGroup = proxyGroups.find((g) => g.id === selectedGroupId);

  const statusColors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    dead: 'bg-red-100 text-red-800',
    in_use: 'bg-blue-100 text-blue-800',
  };

  return (
    <div className="p-8">
      <h2 className="text-3xl font-bold mb-6">Proxy IP 관리</h2>

      {/* 그룹 목록 */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold">프록시 그룹</h3>
          <button
            onClick={openAddGroupModal}
            className="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 text-sm"
          >
            + 그룹 추가
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {proxyGroups.map((group) => (
            <div
              key={group.id}
              className={`relative group cursor-pointer rounded-lg border-2 transition-all ${
                selectedGroupId === group.id
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div
                className="px-4 py-3 min-w-[180px]"
                onClick={() => setSelectedGroupId(group.id)}
              >
                <div className="font-semibold text-sm">{group.name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  브라우저: {group.max_browsers}개
                </div>
                <div className="flex gap-2 mt-2 text-xs">
                  <span className="text-green-600">{group.active_count || 0} 활성</span>
                  <span className="text-blue-600">{group.in_use_count || 0} 사용중</span>
                  <span className="text-red-600">{group.dead_count || 0} 죽음</span>
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  총 {group.proxy_count || 0}개
                </div>
              </div>

              {/* 그룹 편집/삭제 버튼 */}
              <div className="absolute top-1 right-1 hidden group-hover:flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditGroupModal(group);
                  }}
                  className="p-1 text-gray-400 hover:text-blue-600"
                  title="편집"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                {group.id !== 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteGroup(group.id);
                    }}
                    className="p-1 text-gray-400 hover:text-red-600"
                    title="삭제"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 선택된 그룹 프록시 관리 */}
      {selectedGroup && (
        <>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-xl font-semibold">
              {selectedGroup.name} <span className="text-gray-400 text-sm">({groupProxies.length}개)</span>
            </h3>
            <div className="flex gap-2">
              <button
                onClick={handleImportFromFile}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 text-sm"
              >
                파일에서 가져오기
              </button>
              <button
                onClick={handleDeleteAllInGroup}
                disabled={groupProxies.length === 0}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
              >
                전체 삭제
              </button>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
              >
                + 추가
              </button>
            </div>
          </div>

          {/* 필터 */}
          <div className="mb-4 flex gap-2">
            {['all', 'active', 'dead', 'in_use'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-lg text-sm ${
                  filter === f ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 border'
                }`}
              >
                {f === 'all' ? '전체' : f === 'active' ? '활성' : f === 'dead' ? '죽음' : '사용중'} (
                {groupProxies.filter((p) => f === 'all' || p.status === f).length})
              </button>
            ))}
          </div>

          {/* 프록시 목록 */}
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">IP</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Port</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Username</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">상태</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredProxies.map((proxy) => (
                  <tr key={proxy.id}>
                    <td className="px-6 py-4 text-sm">{proxy.ip}</td>
                    <td className="px-6 py-4 text-sm">{proxy.port}</td>
                    <td className="px-6 py-4 text-sm">{proxy.username || '-'}</td>
                    <td className="px-6 py-4">
                      <select
                        value={proxy.status}
                        onChange={(e) => handleUpdateStatus(proxy.id, e.target.value)}
                        className={`px-3 py-1 rounded-full text-xs font-semibold ${statusColors[proxy.status]}`}
                      >
                        <option value="active">활성</option>
                        <option value="dead">죽음</option>
                        <option value="in_use">사용중</option>
                      </select>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleDelete(proxy.id)}
                        className="text-red-600 hover:text-red-800 text-sm"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredProxies.length === 0 && (
              <div className="text-center py-12 text-gray-500">프록시 정보가 없습니다.</div>
            )}
          </div>
        </>
      )}

      {/* 그룹 추가/편집 모달 */}
      {showGroupModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4">
              {editingGroup ? '그룹 수정' : '그룹 추가'}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">그룹 이름</label>
                <input
                  type="text"
                  placeholder="그룹 이름"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">최대 브라우저 수</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={newGroupMaxBrowsers}
                  onChange={(e) => setNewGroupMaxBrowsers(parseInt(e.target.value) || 5)}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <p className="text-xs text-gray-500 mt-1">이 그룹의 프록시를 동시에 사용할 수 있는 최대 브라우저 수</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={editingGroup ? handleUpdateGroup : handleAddGroup}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  {editingGroup ? '수정' : '추가'}
                </button>
                <button
                  onClick={() => {
                    setShowGroupModal(false);
                    setEditingGroup(null);
                  }}
                  className="px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 프록시 추가 모달 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl">
            <h3 className="text-xl font-bold mb-4">
              Proxy 추가 - {selectedGroup?.name}
            </h3>

            <div className="flex gap-4 mb-4 border-b">
              <button
                onClick={() => setIsBulkMode(false)}
                className={`px-4 py-2 ${!isBulkMode ? 'border-b-2 border-blue-600 font-semibold' : ''}`}
              >
                개별 추가
              </button>
              <button
                onClick={() => setIsBulkMode(true)}
                className={`px-4 py-2 ${isBulkMode ? 'border-b-2 border-blue-600 font-semibold' : ''}`}
              >
                대량 추가
              </button>
            </div>

            {!isBulkMode ? (
              <div className="space-y-4">
                <input
                  type="text"
                  placeholder="IP 주소"
                  value={newProxy.ip}
                  onChange={(e) => setNewProxy({ ...newProxy, ip: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <input
                  type="text"
                  placeholder="Port"
                  value={newProxy.port}
                  onChange={(e) => setNewProxy({ ...newProxy, port: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <input
                  type="text"
                  placeholder="Username (선택)"
                  value={newProxy.username}
                  onChange={(e) => setNewProxy({ ...newProxy, username: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <input
                  type="password"
                  placeholder="Password (선택)"
                  value={newProxy.password}
                  onChange={(e) => setNewProxy({ ...newProxy, password: e.target.value })}
                  className="w-full px-4 py-2 border rounded-lg"
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleAddProxy}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    추가
                  </button>
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <textarea
                  placeholder={'한 줄에 하나씩 입력\n형식: ip:port:username:password\n예: 123.45.67.89:8080:user:pass'}
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  className="w-full px-4 py-2 border rounded-lg h-64 font-mono text-sm"
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleBulkAdd}
                    className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                  >
                    대량 추가
                  </button>
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="px-4 py-2 bg-gray-300 rounded-lg hover:bg-gray-400"
                  >
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProxyManager;

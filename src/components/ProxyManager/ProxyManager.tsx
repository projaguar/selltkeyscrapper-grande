import { useState, useEffect } from 'react';
import { useStore } from '../../store';

function ProxyManager() {
  const { proxies, setProxies, deleteProxy } = useStore();
  const [showAddModal, setShowAddModal] = useState(false);
  const [newProxy, setNewProxy] = useState({ ip: '', port: '', username: '', password: '' });
  const [bulkText, setBulkText] = useState('');
  const [filter, setFilter] = useState('all');
  const [isBulkMode, setIsBulkMode] = useState(false);

  useEffect(() => {
    loadProxies();
  }, []);

  const loadProxies = async () => {
    if (window.electronAPI) {
      const data = await window.electronAPI.db.getProxies();
      setProxies(data);
    }
  };

  const handleAddProxy = async () => {
    if (!newProxy.ip || !newProxy.port) {
      alert('IP와 Port는 필수입니다.');
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.addProxy(newProxy);
      await loadProxies();
      setNewProxy({ ip: '', port: '', username: '', password: '' });
      setShowAddModal(false);
    }
  };

  const handleBulkAdd = async () => {
    const lines = bulkText.trim().split('\n');
    const proxies = lines
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

    if (proxies.length === 0) {
      alert('올바른 형식의 프록시 정보를 입력해주세요.\n예: 123.45.67.89:8080:user:pass');
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.bulkAddProxies(proxies);
      await loadProxies();
      setBulkText('');
      setShowAddModal(false);
      alert(`✅ ${proxies.length}개의 프록시가 추가되었습니다.`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm('정말 삭제하시겠습니까?')) {
      if (window.electronAPI) {
        await window.electronAPI.db.deleteProxy(id);
        deleteProxy(id);
      }
    }
  };

  const handleUpdateStatus = async (id: number, status: string) => {
    if (window.electronAPI) {
      await window.electronAPI.db.updateProxy(id, { status });
      await loadProxies();
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm(`⚠️ 정말로 모든 프록시(${proxies.length}개)를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
      return;
    }

    if (window.electronAPI) {
      await window.electronAPI.db.deleteAllProxies();
      await loadProxies();
      alert('✅ 모든 프록시가 삭제되었습니다.');
    }
  };

  const handleImportFromFile = async () => {
    if (window.electronAPI) {
      const result = await window.electronAPI.db.importProxiesFromFile();

      if (result.success) {
        await loadProxies();
        alert(`✅ ${result.count}개의 프록시를 가져왔습니다.`);
      } else {
        alert(`❌ 오류: ${result.message}`);
      }
    }
  };

  const filteredProxies = proxies.filter((p) => {
    if (filter === 'all') return true;
    return p.status === filter;
  });

  const statusColors: any = {
    active: 'bg-green-100 text-green-800',
    dead: 'bg-red-100 text-red-800',
    in_use: 'bg-blue-100 text-blue-800',
  };

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-3xl font-bold">Proxy IP 관리</h2>
        <div className="flex gap-2">
          <button
            onClick={handleImportFromFile}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2"
          >
            📁 파일에서 가져오기
          </button>
          <button
            onClick={handleDeleteAll}
            disabled={proxies.length === 0}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
          >
            🗑️ 전체 삭제
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
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
            className={`px-4 py-2 rounded-lg ${
              filter === f ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'
            }`}
          >
            {f === 'all' ? '전체' : f === 'active' ? '활성' : f === 'dead' ? '죽음' : '사용중'} (
            {proxies.filter((p) => f === 'all' || p.status === f).length})
          </button>
        ))}
      </div>

      {/* 통계 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-500">전체</div>
          <div className="text-2xl font-bold">{proxies.length}</div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-500">활성</div>
          <div className="text-2xl font-bold text-green-600">
            {proxies.filter((p) => p.status === 'active').length}
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-500">죽음</div>
          <div className="text-2xl font-bold text-red-600">
            {proxies.filter((p) => p.status === 'dead').length}
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="text-sm text-gray-500">사용중</div>
          <div className="text-2xl font-bold text-blue-600">
            {proxies.filter((p) => p.status === 'in_use').length}
          </div>
        </div>
      </div>

      {/* 프록시 목록 */}
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                IP
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Port
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Username
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
            {filteredProxies.map((proxy) => (
              <tr key={proxy.id}>
                <td className="px-6 py-4 text-sm">{proxy.ip}</td>
                <td className="px-6 py-4 text-sm">{proxy.port}</td>
                <td className="px-6 py-4 text-sm">{proxy.username || '-'}</td>
                <td className="px-6 py-4">
                  <select
                    value={proxy.status}
                    onChange={(e) => handleUpdateStatus(proxy.id, e.target.value)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold ${
                      statusColors[proxy.status]
                    }`}
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

      {/* 추가 모달 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl">
            <h3 className="text-xl font-bold mb-4">Proxy 추가</h3>

            <div className="flex gap-4 mb-4 border-b">
              <button
                onClick={() => setIsBulkMode(false)}
                className={`px-4 py-2 ${
                  !isBulkMode ? 'border-b-2 border-blue-600 font-semibold' : ''
                }`}
              >
                개별 추가
              </button>
              <button
                onClick={() => setIsBulkMode(true)}
                className={`px-4 py-2 ${
                  isBulkMode ? 'border-b-2 border-blue-600 font-semibold' : ''
                }`}
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

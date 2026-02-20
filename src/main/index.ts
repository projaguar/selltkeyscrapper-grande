import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import * as db from '../database/sqlite';
import * as gologin from '../services/gologin';
import * as api from '../services/api';
import { getProxyPool } from '../lib/proxy-pool';
import { getSessionManager } from '../lib/session-manager';
import { startCrawling, stopCrawler, getCrawlerStatus, getCrawlerProgress } from '../lib/crawler';
import { getBrowserManager, type PreparationResult } from '../lib/crawler/browser-manager';

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.gologin.scrapper');
  }

  // 데이터베이스 초기화
  const userDataPath = app.getPath('userData');
  db.initDatabase(userDataPath);

  // .env에서 GOLOGIN_API_KEY 로드
  const envPaths = [
    join(app.getAppPath(), '.env'),
    join(process.cwd(), '.env'),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      const match = content.match(/^GOLOGIN_API_KEY=(.+)$/m);
      if (match) {
        db.setSetting('gologinApiKey', match[1].trim());
        console.log('[App] GOLOGIN_API_KEY loaded from', envPath);
        break;
      }
    }
  }

  // ProxyPool 초기화 (앱 시작 시 'in_use' 상태 정리)
  console.log('[App] Initializing ProxyPool...');
  getProxyPool();
  console.log('[App] ProxyPool initialized');

  createWindow();

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

// IPC Handlers - App
ipcMain.handle('get-app-path', () => {
  return app.getPath('userData');
});

// IPC Handlers - Database: Proxy Groups
ipcMain.handle('db-get-proxy-groups', () => {
  return db.getProxyGroups();
});

ipcMain.handle('db-get-proxy-groups-with-count', () => {
  return db.getProxyGroupWithCount();
});

ipcMain.handle('db-add-proxy-group', (_event, name, maxBrowsers) => {
  return db.addProxyGroup(name, maxBrowsers);
});

ipcMain.handle('db-update-proxy-group', (_event, id, updates) => {
  return db.updateProxyGroup(id, updates);
});

ipcMain.handle('db-delete-proxy-group', (_event, id) => {
  return db.deleteProxyGroup(id);
});

// IPC Handlers - Database: Proxies
ipcMain.handle('db-get-proxies', () => {
  return db.getProxies();
});

ipcMain.handle('db-get-proxies-by-group', (_event, groupId) => {
  return db.getProxiesByGroup(groupId);
});

ipcMain.handle('db-add-proxy', (_event, proxy) => {
  return db.addProxy(proxy);
});

ipcMain.handle('db-update-proxy', (_event, id, updates) => {
  return db.updateProxy(id, updates);
});

ipcMain.handle('db-update-proxy-group-id', (_event, proxyId, groupId) => {
  return db.updateProxyGroup_id(proxyId, groupId);
});

ipcMain.handle('db-delete-proxy', (_event, id) => {
  return db.deleteProxy(id);
});

ipcMain.handle('db-delete-all-proxies', () => {
  return db.deleteAllProxies();
});

ipcMain.handle('db-delete-proxies-by-group', (_event, groupId) => {
  return db.deleteProxiesByGroup(groupId);
});

ipcMain.handle('db-bulk-add-proxies', (_event, proxies, groupId) => {
  return db.bulkAddProxies(proxies, groupId || 1);
});

ipcMain.handle('db-import-proxies-from-file', async (_event, groupId?: number) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, message: '파일이 선택되지 않았습니다.' };
  }

  try {
    const filePath = result.filePaths[0];
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const proxies = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(':');
      if (parts.length >= 2) {
        proxies.push({
          ip: parts[0],
          port: parts[1],
          username: parts[2] || '',
          password: parts[3] || ''
        });
      }
    }

    if (proxies.length === 0) {
      return { success: false, message: '유효한 프록시 정보가 없습니다.' };
    }

    db.bulkAddProxies(proxies, groupId || 1);
    return { success: true, count: proxies.length };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});

// IPC Handlers - Settings
ipcMain.handle('settings-get', (_event, key) => {
  return db.getSetting(key);
});

ipcMain.handle('settings-set', (_event, key, value) => {
  return db.setSetting(key, value);
});

ipcMain.handle('settings-get-all', () => {
  return db.getAllSettings();
});


// IPC Handlers - ProxyPool Test
ipcMain.handle('proxypool-test', async () => {
  try {
    const proxyPool = getProxyPool();

    const availableCount = proxyPool.getAvailableCount();
    console.log(`[Test] Available proxies: ${availableCount}`);

    // 5개 proxy 순환 할당 테스트
    const testResults = [];
    for (let i = 0; i < 5; i++) {
      const proxy = proxyPool.getNextProxy();
      if (proxy) {
        testResults.push({
          round: i + 1,
          proxyId: proxy.id,
          ip: proxy.ip,
          port: proxy.port
        });
      }
    }

    return {
      success: true,
      availableCount,
      testResults
    };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});

// IPC Handlers - SessionManager
ipcMain.handle('session-assign-proxy-to-profile', async (_event, apiKey, profileId, profileName) => {
  try {
    const sessionManager = getSessionManager(apiKey);
    const session = await sessionManager.assignProxyToProfile(profileId, profileName);
    return { success: true, session };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('session-assign-proxy-to-all', async (_event, apiKey) => {
  try {
    const sessionManager = getSessionManager(apiKey);
    const results = await sessionManager.assignProxyToAllProfiles();
    return { success: true, results };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('session-get-all', async (_event, apiKey) => {
  try {
    const sessionManager = getSessionManager(apiKey);
    const sessions = sessionManager.getAllSessions();
    // running 상태인 세션만 필터링
    const runningSessions = sessions.filter(s => s.status === 'running');
    console.log(`[session-get-all] Total: ${sessions.length}, Running: ${runningSessions.length}`);
    return { success: true, sessions: runningSessions };
  } catch (error: any) {
    console.error('[session-get-all] Error:', error.message);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('session-replace-proxy', async (_event, apiKey, profileId) => {
  try {
    const sessionManager = getSessionManager(apiKey);
    const newSession = await sessionManager.replaceProxyForSession(profileId);
    return { success: true, session: newSession };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
});


// IPC Handlers - Server API
ipcMain.handle('api-get-url-list', async () => {
  try {
    console.log('[API] Fetching URL list from server...');
    const response = await api.getUrlList();
    console.log(`[API] URL list fetched successfully: ${response.item.length} items, inserturl: ${response.inserturl}`);
    return { success: true, data: response };
  } catch (error: any) {
    console.error('[API] Failed to fetch URL list:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handlers - Crawler

// 브라우저 준비 (DDD 패턴 - BrowserManager 사용)
ipcMain.handle('crawler-prepare-browsers', async (
  _event,
  apiKey: string,
  profiles: Array<{ user_id: string; name: string }>
) => {
  try {
    console.log(`[Crawler] Preparing browsers with BrowserManager...`);
    console.log(`[Crawler] Profiles count: ${profiles.length}`);

    const browserManager = getBrowserManager();
    browserManager.setApiKey(apiKey);

    // 진행 상황을 렌더러에 전달하기 위한 콜백
    const onProgress = (index: number, total: number, result: PreparationResult) => {
      if (mainWindow) {
        mainWindow.webContents.send('crawler-prepare-progress', {
          current: index + 1,
          total,
          result,
        });
      }
    };

    const results = await browserManager.prepareBrowsers(profiles, onProgress);

    const successCount = results.filter(r => r.success).length;
    console.log(`[Crawler] Browser preparation complete: ${successCount}/${profiles.length} ready`);

    return {
      success: true,
      results,
      readyCount: successCount,
    };
  } catch (error: any) {
    console.error('[Crawler] Failed to prepare browsers:', error);
    return { success: false, error: error.message };
  }
});

// 크롤링 시작 (준비된 브라우저 사용)
ipcMain.handle('crawler-start-batch', async (_event) => {
  try {
    console.log('[Crawler] Starting crawling with prepared browsers...');
    const results = await startCrawling();
    console.log('[Crawler] Crawling stopped');
    return { success: true, results };
  } catch (error: any) {
    console.error('[Crawler] Crawling failed:', error);
    return { success: false, error: error.message };
  }
});

// 크롤러 중지
ipcMain.handle('crawler-stop', async () => {
  try {
    stopCrawler();
    return { success: true };
  } catch (error: any) {
    console.error('[Crawler] Failed to stop crawler:', error);
    return { success: false, error: error.message };
  }
});

// 브라우저 정리 (크롤링 종료 시)
ipcMain.handle('crawler-clear-browsers', async () => {
  try {
    const browserManager = getBrowserManager();
    await browserManager.clear();
    console.log('[Crawler] All browsers cleared');
    return { success: true };
  } catch (error: any) {
    console.error('[Crawler] Failed to clear browsers:', error);
    return { success: false, error: error.message };
  }
});

// 크롤러 상태 조회
ipcMain.handle('crawler-get-status', async () => {
  try {
    const status = getCrawlerStatus();
    return { success: true, status };
  } catch (error: any) {
    console.error('[Crawler] Failed to get status:', error);
    return { success: false, error: error.message };
  }
});

// 크롤러 진행 상태 조회 (상세)
ipcMain.handle('crawler-get-progress', async () => {
  try {
    const progress = getCrawlerProgress();
    const browserManager = getBrowserManager();
    return { success: true, progress, readyBrowserCount: browserManager.getReadyCount() };
  } catch (error: any) {
    console.error('[Crawler] Failed to get progress:', error);
    return { success: false, error: error.message };
  }
});

// IPC Handlers - GoLogin API
ipcMain.handle('gologin-list-profiles', async (_event, apiKey) => {
  try {
    return await gologin.listProfiles(apiKey);
  } catch (error: any) {
    return { error: error.message };
  }
});

ipcMain.handle('gologin-create-profile', async (_event, apiKey, name) => {
  try {
    return await gologin.createProfile(apiKey, name);
  } catch (error: any) {
    return { error: error.message };
  }
});

ipcMain.handle('gologin-get-profile', async (_event, apiKey, profileId) => {
  try {
    return await gologin.getProfile(apiKey, profileId);
  } catch (error: any) {
    return { error: error.message };
  }
});

ipcMain.handle('gologin-update-profile', async (_event, apiKey, profileId, data) => {
  try {
    return await gologin.updateProfile(apiKey, profileId, data);
  } catch (error: any) {
    return { error: error.message };
  }
});

ipcMain.handle('gologin-delete-profiles', async (_event, apiKey, profileIds) => {
  try {
    return await gologin.deleteProfiles(apiKey, profileIds);
  } catch (error: any) {
    return { error: error.message };
  }
});

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as db from '../database/sqlite';
import * as adspower from '../services/adspower';
import * as api from '../services/api';
import puppeteer from 'puppeteer-core';
import { getProxyPool } from '../lib/proxy-pool';
import { getSessionManager } from '../lib/session-manager';
import { processBatch, stopCrawler, addTasks, getCrawlerStatus, getCrawlerProgress } from '../lib/crawler';

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
    app.setAppUserModelId('com.adspower.scrapper');
  }

  // 데이터베이스 초기화
  const userDataPath = app.getPath('userData');
  db.initDatabase(userDataPath);

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

// IPC Handlers - Database
ipcMain.handle('db-get-proxies', () => {
  return db.getProxies();
});

ipcMain.handle('db-add-proxy', (_event, proxy) => {
  return db.addProxy(proxy);
});

ipcMain.handle('db-update-proxy', (_event, id, updates) => {
  return db.updateProxy(id, updates);
});

ipcMain.handle('db-delete-proxy', (_event, id) => {
  return db.deleteProxy(id);
});

ipcMain.handle('db-delete-all-proxies', () => {
  return db.deleteAllProxies();
});

ipcMain.handle('db-bulk-add-proxies', (_event, proxies) => {
  return db.bulkAddProxies(proxies);
});

ipcMain.handle('db-import-proxies-from-file', async () => {
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

    db.bulkAddProxies(proxies);
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

// IPC Handlers - AdsPower API
ipcMain.handle('adspower-list-profiles', async (_event, apiKey) => {
  try {
    return await adspower.listProfiles(apiKey);
  } catch (error: any) {
    return { code: -1, msg: error.message };
  }
});

ipcMain.handle('adspower-create-profile', async (_event, apiKey, profileData) => {
  try {
    return await adspower.createProfile(apiKey, profileData);
  } catch (error: any) {
    return { code: -1, msg: error.message };
  }
});

ipcMain.handle('adspower-delete-profiles', async (_event, apiKey, profileIds) => {
  try {
    return await adspower.deleteProfiles(apiKey, profileIds);
  } catch (error: any) {
    return { code: -1, msg: error.message };
  }
});

ipcMain.handle('adspower-start-browser', async (_event, apiKey, profileId) => {
  try {
    return await adspower.startBrowser(apiKey, profileId);
  } catch (error: any) {
    return { code: -1, msg: error.message };
  }
});

ipcMain.handle('adspower-stop-browser', async (_event, apiKey, profileId) => {
  try {
    return await adspower.stopBrowser(apiKey, profileId);
  } catch (error: any) {
    return { code: -1, msg: error.message };
  }
});

ipcMain.handle('adspower-puppeteer-test', async (_event, apiKey, profileId) => {
  try {
    // 브라우저 상태 확인
    const statusCheck = await adspower.checkBrowserStatus(apiKey, profileId);
    let wsUrl: string | undefined;

    if (statusCheck.code === 0 && statusCheck.data?.status === 'Active') {
      // 이미 실행 중이면 기존 WebSocket 사용
      wsUrl = statusCheck.data?.ws?.puppeteer;
      console.log('Browser already running, using existing connection');
    } else {
      // 브라우저가 실행 중이 아니면 시작
      const browserInfo = await adspower.startBrowser(apiKey, profileId);
      if (browserInfo.code !== 0) {
        return { success: false, message: '브라우저가 실행되지 않았습니다.' };
      }
      wsUrl = browserInfo.data?.ws?.puppeteer;
    }

    if (!wsUrl) {
      return { success: false, message: 'WebSocket URL을 찾을 수 없습니다.' };
    }

    // Puppeteer 연결
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
    });

    const pages = await browser.pages();
    if (pages.length === 0) {
      await browser.disconnect();
      return { success: false, message: '열린 페이지가 없습니다.' };
    }

    const page = pages[0];

    // 콘솔 로그 캡처
    const consoleLogs: Array<{ type: string; text: string }> = [];
    page.on('console', (msg) => {
      const logEntry = { type: msg.type(), text: msg.text() };
      consoleLogs.push(logEntry);
      console.log(`[Browser Console - ${msg.type()}]:`, msg.text());
    });

    // 네이버 검색 테스트
    console.log('Total pages:', pages.length);

    // 브라우저 시작 후 안정화 대기
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 현재 URL 확인
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);

    // m.naver.com으로 무조건 이동 (새로고침 효과)
    console.log('Navigating to m.naver.com...');
    await page.goto('https://m.naver.com', { waitUntil: 'load', timeout: 30000 });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const afterGotoUrl = page.url();
    console.log('After goto URL:', afterGotoUrl);

    // 여러 셀렉터 시도 (모바일/데스크톱 모두 대응)
    const selectors = [
      'input[type="search"]',
      'input.search_input',
      'input[name="query"]',
      '#query',
      'input.input_text',
      'input[placeholder*="검색"]'
    ];

    let searchInput = null;
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        searchInput = await page.$(selector);
        if (searchInput) {
          console.log(`Found search input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (searchInput) {
      // 검색창에 포커스
      await searchInput.focus();
      await new Promise(resolve => setTimeout(resolve, 500));

      // 기존 텍스트 모두 선택 후 삭제 (macOS는 Meta(Command), Windows/Linux는 Control)
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.down(modifier);
      await page.keyboard.press('KeyA');
      await page.keyboard.up(modifier);
      await page.keyboard.press('Backspace');
      await new Promise(resolve => setTimeout(resolve, 300));

      // 텍스트 입력
      await page.keyboard.type('Puppeteer 테스트', { delay: 100 });
      await new Promise(resolve => setTimeout(resolve, 500));

      // Enter 키 입력
      console.log('Pressing Enter...');
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const finalUrl = page.url();
      console.log('Final URL after search:', finalUrl);

      await browser.disconnect();
      return {
        success: true,
        message: `테스트 완료\n\n최종 URL: ${finalUrl}`,
        consoleLogs: consoleLogs
      };
    } else {
      await browser.disconnect();
      return { success: false, message: '검색창을 찾을 수 없습니다.', consoleLogs: consoleLogs };
    }
  } catch (error: any) {
    return { success: false, message: error.message };
  }
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

// IPC Handlers - Proxy 검증
ipcMain.handle('browser-start-and-verify', async (_event, apiKey, profileId, profileName, maxRetries = 3) => {
  let retryCount = 0;
  const sessionManager = getSessionManager(apiKey);

  while (retryCount < maxRetries) {
    try {
      console.log(`\n[Verify] Attempt ${retryCount + 1}/${maxRetries} for ${profileName}`);

      // 1. 브라우저 시작
      console.log(`[Verify] Starting browser for ${profileName}...`);
      const startResult = await adspower.startBrowser(apiKey, profileId);

      if (startResult.code !== 0) {
        throw new Error(`Failed to start browser: ${startResult.msg}`);
      }

      const wsUrl = startResult.data?.ws?.puppeteer;
      if (!wsUrl) {
        throw new Error('WebSocket URL not found');
      }

      // 2. Puppeteer 연결
      console.log(`[Verify] Connecting to Puppeteer...`);
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
      });

      // 3초 대기 (브라우저 안정화)
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 3. 첫 번째 탭 재사용 (추가 탭들은 닫기)
      console.log(`[Verify] Reusing first tab...`);
      const allPages = await browser.pages();

      if (allPages.length === 0) {
        throw new Error('No pages available in browser');
      }

      const page = allPages[0];  // 첫 번째 탭 사용

      // 추가 탭들 모두 닫기 (index 1 이상)
      for (let i = 1; i < allPages.length; i++) {
        try {
          await allPages[i].close();
        } catch (e) {
          // 닫기 실패해도 무시
        }
      }

      // 4. IP 확인 API로 Proxy 검증 (naver.com 이동 스킵)
      console.log(`[Verify] Validating proxy using IP check API...`);
      let actualIp: string | undefined;

      // 여러 IP 확인 서비스 순차 시도
      const ipServices = [
        'https://api.ipify.org?format=json',
        'https://api.my-ip.io/ip.json',
        'https://ipapi.co/json/',
      ];

      for (const serviceUrl of ipServices) {
        try {
          const response = await page.evaluate(async (url: string) => {
            const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
            return await res.json();
          }, serviceUrl);

          // 응답 형식에 따라 IP 추출
          if (response.ip) {
            actualIp = response.ip;
            break;
          } else if (typeof response === 'string') {
            actualIp = response;
            break;
          }
        } catch (error: any) {
          console.warn(`[Verify] Failed to get IP from ${serviceUrl}: ${error.message}`);
          // 다음 서비스 시도
        }
      }

      if (!actualIp) {
        throw new Error('Failed to retrieve actual IP from all services');
      }

      console.log(`✅ [Verify] ${profileName} - Proxy validated! IP: ${actualIp}`);

      // 5. 성공!
      console.log(`✅ [Verify] ${profileName} - Browser started and proxy verified successfully!`);
      await browser.disconnect();

      // 세션 상태 업데이트
      sessionManager.updateSessionStatus(profileId, 'running');

      return {
        success: true,
        profileId,
        profileName,
        proxyIp: actualIp,
        retryCount: retryCount + 1,
        message: 'Browser started successfully'
      };

    } catch (error: any) {
      console.error(`❌ [Verify] Attempt ${retryCount + 1} failed:`, error.message);

      // 브라우저 종료
      try {
        await adspower.stopBrowser(apiKey, profileId);
      } catch (stopError) {
        console.error('[Verify] Failed to stop browser:', stopError);
      }

      retryCount++;

      // 재시도가 남아있으면 Proxy 교체
      if (retryCount < maxRetries) {
        console.log(`[Verify] Replacing proxy for ${profileName}...`);
        try {
          const newSession = await sessionManager.replaceProxyForSession(profileId);
          console.log(`[Verify] New proxy assigned: ${newSession.proxyIp}:${newSession.proxyPort}`);

          // 잠깐 대기 후 재시도
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (replaceError: any) {
          console.error('[Verify] Failed to replace proxy:', replaceError.message);
          return {
            success: false,
            profileId,
            profileName,
            message: `Failed to replace proxy: ${replaceError.message}`,
            retryCount
          };
        }
      }
    }
  }

  // 모든 재시도 실패
  sessionManager.updateSessionStatus(profileId, 'error');
  return {
    success: false,
    profileId,
    profileName,
    message: `All ${maxRetries} attempts failed`,
    retryCount: maxRetries
  };
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
ipcMain.handle('crawler-start-batch', async (_event, apiKey, sessions, insertUrl?) => {
  try {
    console.log('[Crawler] Starting continuous batch crawling...');
    console.log(`[Crawler] Insert URL: ${insertUrl || "(will fetch from server)"}`);
    const results = await processBatch(apiKey, sessions, insertUrl);
    console.log('[Crawler] Batch crawling stopped');
    return { success: true, results };
  } catch (error: any) {
    console.error('[Crawler] Batch crawling failed:', error);
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

// Task 큐에 추가
ipcMain.handle('crawler-add-tasks', async (_event, tasks) => {
  try {
    addTasks(tasks);
    return { success: true };
  } catch (error: any) {
    console.error('[Crawler] Failed to add tasks:', error);
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
    return { success: true, progress };
  } catch (error: any) {
    console.error('[Crawler] Failed to get progress:', error);
    return { success: false, error: error.message };
  }
});

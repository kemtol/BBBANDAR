const { app, BrowserWindow, BrowserView, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// --- CORE MODULES ---
const ipotParser = require('./core/adapters/ipot_parser');
const stockbitParser = require('./core/adapters/stockbit_parser');
const strategyManager = require('./core/strategies/manager');
const riskManager = require('./core/risk/risk_controller');
const tapeStream = require('./core/tns/stream');
const whaleTracker = require('./core/features/whale');
const tokenEngine = require('./core/engine/token-engine');
const featuresChannel = require('./core/channel/features');
const liveTradeStream = require('./core/channel/livetrade');

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png'); // Adjust path if needed

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Algo-One Trading Agent',
    icon: nativeImage.createFromPath(iconPath),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#000000'
  });

  const LEFT_PANE_WIDTH = 420; // Forced mobile width
  let hasShownMainWindow = false;

  // Pane Kiri (Web Sekuritas - Mobile Mode)
  const leftView = new BrowserView({
    webPreferences: {
      partition: 'persist:broker',
      preload: path.join(__dirname, 'preload.js') // Register sniffer bridge
    }
  });
  win.addBrowserView(leftView); // Use addBrowserView instead of setBrowserView

  // Force Mobile User Agent
  const mobileUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  leftView.webContents.setUserAgent(mobileUA);

  leftView.setAutoResize({ width: false, height: false });

  // Warm-up flag tracking
  let didWarmupReady = false;

  // Load initial URL
  console.log("[MAIN] Initializing market URL...");
  leftView.webContents.loadURL('https://indopremier.com/#ipot/app/marketlive').catch(err => {
    console.error(`[MAIN] Initial load failed: ${err.message}`);
  });

  // Helpers: features cache freshness check
  const FEATURES_PATH = path.join(__dirname, 'data', 'features-emiten.json');
  function isFeaturesFresh(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      const stat = fs.statSync(FEATURES_PATH);
      if (stat.size < 64) {
        return false; // empty or truncated file
      }
      const raw = fs.readFileSync(FEATURES_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.generatedAt) {
        return false;
      }
      const generatedAt = new Date(parsed.generatedAt);
      if (Number.isNaN(generatedAt.getTime())) {
        return false;
      }
      const now = new Date();
      const sameDay = generatedAt.getFullYear() === now.getFullYear()
        && generatedAt.getMonth() === now.getMonth()
        && generatedAt.getDate() === now.getDate();
      if (!sameDay) {
        return false;
      }
      return (Date.now() - stat.mtimeMs) < maxAgeMs;
    } catch {
      return false;
    }
  }

  // Auto Token Check on page load
  leftView.webContents.on('did-finish-load', async () => {
    if (!hasShownMainWindow) {
      hasShownMainWindow = true;
      win.maximize();
      applyViewLayout('after-maximize-request');
      win.show();
    }

    const sendLog = (msg) => {
      console.log(msg);
      try {
        const views = win.getBrowserViews();
        if (views[1] && !views[1].webContents.isDestroyed()) {
          views[1].webContents.send('system-log', msg);
        }
      } catch (_) { }
    };

    sendLog('🔑 Get public token...');

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitDurations = [3000, 5000, 7000];
    let token = null;
    let attemptsUsed = 0;

    for (let attemptIndex = 0; attemptIndex < waitDurations.length; attemptIndex++) {
      const waitMs = waitDurations[attemptIndex];
      const attemptLabel = `${attemptIndex + 1}/${waitDurations.length}`;
      const seconds = waitMs % 1000 === 0 ? (waitMs / 1000).toString() : (waitMs / 1000).toFixed(1);

      sendLog(`⏳ Menunggu ${seconds}s sebelum ambil public token (percobaan ${attemptLabel})...`);
      await wait(waitMs);

      token = await tokenEngine.extractPublicToken(leftView.webContents);
      if (token) {
        attemptsUsed = attemptIndex + 1;
        break;
      }

      if (attemptIndex < waitDurations.length - 1) {
        sendLog('⚠️ Public token belum ditemukan, akan retry...');
      }
    }

    if (token) {
      const attemptSuffix = attemptsUsed > 1 ? ` (percobaan ${attemptsUsed})` : '';
      sendLog(`✅ Public token ready${attemptSuffix}`);
      sendLog(`🔑 Public token is ${tokenEngine.mask(token)}`);

      // Auto-connect Live Trade stream with public token
      if (!liveTradeStream.connected) {
        liveTradeStream.connect(token, sendLog);

        // Forward trades to dashboard as they come in
        liveTradeStream.on('trade', (trade) => {
          try {
            const views = win.getBrowserViews();
            if (views[1] && !views[1].webContents.isDestroyed()) {
              views[1].webContents.send('live-trade', trade);
            }
          } catch (_) { }
        });
      }

      // Prefetch today's features (once) if cache not fresh
      if (!global.__didPrefetchFeatures) {
        if (!isFeaturesFresh()) {
          global.__didPrefetchFeatures = true;
          sendLog('[FEATURES] Auto-fetch start (init)');
          const t0 = Date.now();
          try {
            const results = await featuresChannel.connectAndFetch(token, sendLog);
            const secs = Math.round((Date.now() - t0) / 1000);
            sendLog(`[FEATURES] Prefetch done in ${secs}s. ${Object.keys(results).length} emitens`);
            sendLog('💾 Data saved to data/features-emiten.json');
          } catch (err) {
            sendLog(`[FEATURES] Prefetch error: ${err.message}`);
          }
        } else {
          global.__didPrefetchFeatures = true;
          sendLog('[FEATURES] Cache is fresh. Skip prefetch.');
        }
      }

      if (!didWarmupReady && liveTradeStream.connected) {
        didWarmupReady = true;
        try {
          leftView.webContents.send('warmup-ready', { broker: 'ipot' });
          console.log('[WARMUP] Warmup ready dispatched to left view');
        } catch (err) {
          console.warn('[WARMUP] Failed to send warmup-ready:', err.message);
        }
      }
    } else {
      sendLog('⚠️ Public token NOT found. Halaman belum terbuka sempurna.');
    }
  });

  ipcMain.on('broker-login-state', (event, payload) => {
    const { broker, loggedIn } = payload || {};
    console.log(`[LOGIN] Broker=${broker} loggedIn=${loggedIn}`);

    global.brokerLoginState = {
      ...(global.brokerLoginState || {}),
      [broker || 'unknown']: {
        loggedIn: Boolean(loggedIn),
        ts: Date.now()
      }
    };

    try {
      const views = win.getBrowserViews();
      if (views[1] && !views[1].webContents.isDestroyed()) {
        views[1].webContents.send('broker-login-state', payload);
      }
    } catch (err) {
      console.warn('[LOGIN] Failed forwarding login state:', err.message);
    }
  });

  // Pane Kanan (Signal Dashboard)
  const rightView = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  });
  win.addBrowserView(rightView);
  rightView.setAutoResize({ width: false, height: false });

  const applyViewLayout = (source = 'resize') => {
    const [contentWidth, contentHeight] = win.getContentSize();
    const rightPaneWidth = Math.max(contentWidth - LEFT_PANE_WIDTH, 0);

    leftView.setBounds({
      x: 0,
      y: 0,
      width: LEFT_PANE_WIDTH,
      height: contentHeight
    });

    rightView.setBounds({
      x: LEFT_PANE_WIDTH,
      y: 0,
      width: rightPaneWidth,
      height: contentHeight
    });

    const leftBounds = leftView.getBounds();
    const rightBounds = rightView.getBounds();
    console.log(`[LAYOUT:${source}] content=${contentWidth}x${contentHeight} left=${JSON.stringify(leftBounds)} right=${JSON.stringify(rightBounds)}`);
  };

  applyViewLayout('init');

  console.log("[MAIN] Loading dashboard (index.html)...");
  const indexPath = path.join(__dirname, 'index.html');
  console.log(`[MAIN] Absolute path: ${indexPath}`);
  rightView.webContents.loadFile(indexPath).catch(err => {
    console.error(`[MAIN] Failed to load index.html: ${err.message}`);
  });

  // Logic Switch Broker
  ipcMain.on('switch-broker', (event, broker) => {
    console.log(`[MAIN] Received switch-broker request: ${broker}`);
    global.activeBroker = broker;
    let url = '';
    if (broker === 'ipot') {
      url = 'https://indopremier.com/#ipot/app/marketlive';
    } else if (broker === 'stockbit') {
      url = 'https://stockbit.com/login';
    } else if (broker === 'ajaib') {
      url = 'https://ajaib.co.id/';
    } else if (broker === 'mirae') {
      url = 'https://invest.miraeasset.co.id/';
    }

    if (url) {
      console.log(`[MAIN] Loading URL: ${url}`);
      leftView.webContents.loadURL(url).catch(err => {
        console.error(`[MAIN] Failed to load URL: ${err.message}`);
      });
    }
  });

  // RAW DATA SNIFFER (From Preload)
  ipcMain.on('raw-data', (event, { type, payload }) => {
    // 1. Normalisasi Data
    const parser = global.activeBroker === 'ipot' ? ipotParser : stockbitParser;
    const cleanData = parser.parse(payload);

    if (cleanData) {
      // 2. Kirim ke Strategy Engine
      const signal = strategyManager.evaluate(global.currentStrategy, cleanData);

      // 3. Eksekusi jika ada Sinyal
      if (signal === 'BUY_SIGNAL') {
        riskManager.executeEntry(cleanData.symbol);
      }
    }
  });

  // HANDLER AGENT CONTROL
  ipcMain.on('agent-control', (event, payload) => {
    const action = typeof payload === 'string' ? payload : payload.action;
    console.log('⚡ AGENT ACTION:', action);

    if (action === 'START') {
      const strategy = payload.strategy || 'manual';
      global.currentStrategy = strategy;
      console.log(`[MAIN] Starting Agent with strategy: ${strategy}`);
    }

    if (action === 'FLATTEN') {
      riskManager.flattenAll();
    }

    // Forwarding logic to UI/Broker Pane
    const allViews = win.getBrowserViews();
    if (allViews.length > 0) {
      const leftPane = allViews[0];

      if (action === 'FLATTEN') {
        leftPane.webContents.send('execute-flatten');
      } else if (action === 'START') {
        leftPane.webContents.send('agent-status', 'ACTIVE');
      } else if (action === 'STOP' || action === 'FLATTEN') {
        leftPane.webContents.send('agent-status', 'IDLE');
      }
    }
  });

  ipcMain.on('log-to-terminal', (event, msg) => {
    console.log(`[UI] ${msg}`);
  });

  // FEATURES FETCH HANDLER (Target Price averages)
  ipcMain.handle('fetch-features', async (event) => {
    try {
      // Use cached public token, or re-extract
      let token = tokenEngine.getPublicToken();

      if (!token) {
        const allViews = win.getBrowserViews();
        const leftPane = allViews[0];
        if (leftPane) {
          token = await tokenEngine.extractPublicToken(leftPane.webContents);
        }
      }

      if (!token) {
        return { success: false, error: 'No public token available. Buka halaman market dulu.' };
      }

      // Log function to send updates to dashboard
      const logFn = (msg) => {
        console.log(msg);
        const views = win.getBrowserViews();
        if (views[1]) {
          views[1].webContents.send('system-log', msg);

        }
      };

      // Fetch features using public token
      const results = await featuresChannel.connectAndFetch(token, logFn);
      return {
        success: true,
        totalEmitens: Object.keys(results).length,
        message: `Fetched features (target price averages) for ${Object.keys(results).length} emitens.`
      };
    } catch (err) {
      console.error('[MAIN] Error fetching features:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Handle window resize to keep panes aligned
  const resizeEvents = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'];
  resizeEvents.forEach((evt) => {
    win.on(evt, () => applyViewLayout(evt));
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

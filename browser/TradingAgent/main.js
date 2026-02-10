const { app, BrowserWindow, BrowserView, ipcMain, nativeImage } = require('electron');
const path = require('path');

// --- CORE MODULES ---
const ipotParser = require('./core/adapters/ipot_parser');
const stockbitParser = require('./core/adapters/stockbit_parser');
const strategyManager = require('./core/strategies/manager');
const riskManager = require('./core/risk/risk_controller');
const tapeStream = require('./core/tns/stream');
const whaleTracker = require('./core/features/whale');
const tokenEngine = require('./core/engine/token-engine');
const targetPrice = require('./core/channel/target-price');
const liveTradeStream = require('./core/channel/livetrade');

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png');
  console.log(`[MAIN] Using window icon: ${iconPath}`);

  // Global strategy state
  global.currentStrategy = 'manual';
  global.activeBroker = 'ipot';

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Algo-One Trading Agent",
    icon: nativeImage.createFromPath(iconPath),
    autoHideMenuBar: true
  });

  const LEFT_PANE_WIDTH = 420; // Forced mobile width

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

  leftView.setBounds({ x: 0, y: 30, width: LEFT_PANE_WIDTH, height: 870 });
  leftView.setAutoResize({ width: false, height: true });

  // Load initial URL
  console.log("[MAIN] Initializing IPOT URL...");
  leftView.webContents.loadURL('https://indopremier.com/#ipot/app/marketlive').catch(err => {
    console.error(`[MAIN] Initial load failed: ${err.message}`);
  });

  // Auto Token Check on page load
  leftView.webContents.on('did-finish-load', async () => {
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

    // Small delay to let IPOT JS fully initialize
    await new Promise(r => setTimeout(r, 2000));

    const token = await tokenEngine.extractPublicToken(leftView.webContents);
    if (token) {
      sendLog('✅ Public token ready');
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
    } else {
      sendLog('⚠️ Public token NOT found. Halaman IPOT belum terbuka sempurna.');
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
  rightView.setBounds({ x: LEFT_PANE_WIDTH, y: 30, width: 1400 - LEFT_PANE_WIDTH, height: 870 });
  rightView.setAutoResize({ width: true, height: true });

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
    console.log("⚡ AGENT ACTION:", action);

    if (action === 'START') {
      const strategy = payload.strategy || 'manual';
      global.currentStrategy = strategy;
      log(`[MAIN] Starting Agent with strategy: ${strategy}`);
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

  // TARGET PRICE FETCH HANDLER
  ipcMain.handle('fetch-target-prices', async (event) => {
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
        return { success: false, error: 'No public token available. Buka halaman IPOT dulu.' };
      }

      // Log function to send updates to dashboard
      const logFn = (msg) => {
        console.log(msg);
        const views = win.getBrowserViews();
        if (views[1]) {
          views[1].webContents.send('system-log', msg);
        }
      };

      // Fetch target prices using public token
      const results = await targetPrice.connectAndFetch(token, logFn);
      return {
        success: true,
        totalEmitens: Object.keys(results).length,
        message: `Fetched target prices for ${Object.keys(results).length} emitens.`
      };
    } catch (err) {
      console.error('[MAIN] Error fetching target prices:', err.message);
      return { success: false, error: err.message };
    }
  });

  // Handle window resize to keep panes aligned
  win.on('resize', () => {
    const { width, height } = win.getBounds();
    leftView.setBounds({ x: 0, y: 30, width: LEFT_PANE_WIDTH, height: height - 30 });
    rightView.setBounds({ x: LEFT_PANE_WIDTH, y: 30, width: width - LEFT_PANE_WIDTH, height: height - 30 });
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

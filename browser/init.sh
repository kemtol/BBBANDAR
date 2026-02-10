#!/bin/bash

# 1. Setup Folder & Project
PROJECT_NAME="TradingAgent"
mkdir $PROJECT_NAME
cd $PROJECT_NAME

echo "🛠️ Memulai Scaffolding Aplikasi: $PROJECT_NAME"

# 2. Init Package & Install Dependensi (Electron + Builder)
# electron-builder adalah standar industri untuk membuat file .exe / .deb / AppImage
npm init -y
npm install electron --save-dev
npm install electron-builder --save-dev

# 3. Tambahkan konfigurasi build di package.json
# Menggunakan node untuk memanipulasi JSON secara aman
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json'));
pkg.main = 'main.js';
pkg.scripts = {
  start: 'electron .',
  dist: 'electron-builder'
};
pkg.build = {
  appId: 'com.kemal.tradingagent',
  linux: { target: ['dir'] }, // Kita buat format direktori agar cepat (bisa diganti 'AppImage' nanti)
  win: { target: 'portable' }
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"

# 4. Buat file main.js (Main App Logic)
cat <<EOF > main.js
const { app, BrowserWindow, BrowserView } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 800,
    title: "Trading Agent Beta v1.0",
    autoHideMenuBar: true
  });

  // Pane Kiri (Web Sekuritas)
  const leftView = new BrowserView();
  win.setBrowserView(leftView);
  leftView.setBounds({ x: 0, y: 0, width: 700, height: 800 });
  leftView.setAutoResize({ width: true, height: true });
  leftView.webContents.loadURL('https://www.google.com/search?q=IDX+Stock+Chart');

  // Pane Kanan (Signal Dashboard)
  const rightView = new BrowserView({
    webPreferences: { nodeIntegration: true }
  });
  win.addBrowserView(rightView);
  rightView.setBounds({ x: 700, y: 0, width: 700, height: 800 });
  rightView.setAutoResize({ width: true, height: true });
  rightView.webContents.loadFile('index.html');
}

app.whenReady().then(createWindow);
EOF

# 5. Buat file Dashboard Sederhana (index.html)
cat <<EOF > index.html
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #38bdf8; padding: 40px; }
        .box { border: 2px solid #1e293b; padding: 20px; border-radius: 12px; background: #1e293b; }
        .status { color: #4ade80; font-weight: bold; }
    </style>
</head>
<body>
    <h1>📟 Agent Console</h1>
    <div class="box">
        <p>Status: <span class="status">CONNECTED TO DOM</span></p>
        <hr border="0.5">
        <h3>Sinyal Terdeteksi:</h3>
        <p>BBCA - Accumulation (Gold Cherry)</p>
    </div>
</body>
</html>
EOF

# 6. PROSES PACKAGING (Membangun Aplikasi)
echo "📦 Mengemas aplikasi menjadi file Executable..."
npm run dist

echo "--------------------------------------------------"
echo "✅ BERHASIL!"
echo "--------------------------------------------------"
echo "Aplikasi Anda ada di folder: $(pwd)/dist/linux-unpacked/"
echo "Double click file 'tradingagent' di folder tersebut untuk mencoba."
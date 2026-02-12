const cron = require('node-cron');
const { ipcMain } = require('electron');

/**
 * Menginisialisasi semua jadwal otomatis
 * @param {BrowserWindow} mainWindow - Referensi ke window utama untuk kirim log ke UI
 */
function init(mainWindow) {
    console.log("⏰ Scheduler Module Loaded (WIB Timezone)");

    // --- JOB 1: MORNING RESET (08:50 WIB, Senin-Jumat) ---
    cron.schedule('50 8 * * 1-5', () => {
        console.log("☀️ MORNING RESET TRIGGERED");
        const views = mainWindow.getBrowserViews();

        // Kirim notifikasi ke Pane Kanan (Log)
        if (views[1]) {
            views[1].webContents.send('system-log', '☀️ MARKET OPEN SOON: System Reset.');
            // views[1].webContents.send('reset-ui'); // Jika ada logic reset UI
        }
    });

    // --- JOB 2: FORCE FLATTEN (15:48 WIB - Anti Nyangkut) ---
    cron.schedule('48 15 * * 1-5', () => {
        console.log("⚠️ MARKET CLOSING: FORCE FLATTEN TRIGGERED");

        // 1. Kirim Perintah ke Pane Kiri (Web Broker)
        const views = mainWindow.getBrowserViews();
        if (views[0]) {
            views[0].webContents.send('execute-command', { action: 'FLATTEN' });
        }

        // 2. Kirim Log ke Pane Kanan
        if (views[1]) {
            views[1].webContents.send('system-log', '⚠️ CRON JOB: Auto-Flatten Executed!');
        }
    });

    // --- JOB 3: HEARTBEAT (Opsional - Cek System Hidup) ---
    cron.schedule('*/5 * * * *', () => {
        // console.log(`💓 System Alive: ${new Date().toLocaleTimeString()}`);
    });
}

module.exports = { init };
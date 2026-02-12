const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Emiten Updater
 * Mengambil data dari Cloudflare D1 (via Wrangler) dan menyimpannya ke master-emiten.js
 */

async function updateEmiten() {
    console.log("🚀 Starting Emiten Update from D1...");

    try {
        // Asumsi: Wrangler sudah terinstall dan terautentikasi
        // Query ke tabel 'emiten'
        const command = `wrangler d1 execute sssaham-db --remote --command "SELECT ticker, sector, industry FROM emiten WHERE status = 'ACTIVE'" --json`;

        console.log("📡 Remote query to D1...");
        const result = execSync(command, { encoding: 'utf8' });
        const data = JSON.parse(result);

        // Wrangler returns an array of objects for each query, usually inside another array if multiple queries
        // Format: [ { "results": [...] } ] or just [...] depending on wrangler version
        const rows = data[0].results || data;

        if (!rows || rows.length === 0) {
            console.error("❌ No data received from D1.");
            return;
        }

        console.log(`✅ Received ${rows.length} emiten records.`);

        // 1. Save to data/master-emiten.json (Raw JSON)
        const dataPath = path.join(__dirname, '../../data/master-emiten.json');
        fs.writeFileSync(dataPath, JSON.stringify(rows, null, 2));
        console.log(`💾 Saved to ${dataPath}`);

        // 2. Save to core/updater/master-emiten.js (ES Module for internal use)
        const jsPath = path.join(__dirname, 'master-emiten.js');
        const jsContent = `/**
 * AUTO-GENERATED MASTER EMITEN DATA
 * Generated on: ${new Date().toISOString()}
 */
module.exports = ${JSON.stringify(rows, null, 2)};
`;
        fs.writeFileSync(jsPath, jsContent);
        console.log(`💾 Saved to ${jsPath}`);

    } catch (error) {
        console.error("❌ Error updating emiten:", error.message);
    }
}

// Jalankan jika dipanggil langsung
if (require.main === module) {
    updateEmiten();
}

module.exports = updateEmiten;

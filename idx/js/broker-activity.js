/**
 * broker-activity.js — Broker Activity Scanner
 *
 * Data flow:
 *   1. Cron (17:00 WIB) → broksum-scrapper/scrapeIpotBrokerActivity() → R2: BYBROKER_{CODE}/{YYYY}/{MM}/{DD}.json
 *   2. Frontend → api-saham GET /broker-activity?broker=MG&days=1 → reads R2, aggregates, returns JSON
 *
 * R2 key: raw-broksum/BYBROKER_{CODE}/{YYYY}/{MM}/{DD}.json
 * JSON per day per broker:
 * {
 *   ok: true, broker: "MG", broker_type: "Asing", date: "2026-03-04",
 *   breadth: 25,
 *   summary: { total_buy_val, total_sell_val, total_net_val, ... },
 *   stocks: [
 *     { stock_code: "BUMI", buy_val: "161266801800", buy_vol: "674540700", buy_freq: "3807",
 *       sell_val: "251482025400", sell_vol: "1030668500", sell_freq: "10530",
 *       net_val: "-90215223600", net_vol: "-356127800", total_val: "412748827200", total_vol: "1705209200" },
 *     ...
 *   ]
 * }
 */

'use strict';

// ── Config ──
const BROKER_PAGE_SIZE = 50;
const API_BASE = 'https://api-saham.mkemalw.workers.dev';

// Known broker codes by category
const BROKER_CATEGORIES = {
    foreign: new Set(['ZP', 'YU', 'KZ', 'RX', 'BK', 'AK', 'CS', 'CG', 'DB', 'ML', 'CC', 'DX',
        'MS', 'UB', 'FS', 'GR', 'JP', 'YP', 'LG', 'DP', 'KK', 'SK', 'BW', 'FG',
        'MG', 'AD', 'OD', 'BB', 'PT', 'SQ']),
    local: new Set(['NI', 'EP', 'IF', 'PD', 'AI', 'DR', 'KI', 'TP', 'BZ', 'DH',
        'AZ', 'XA', 'IB', 'GI', 'MA', 'BS', 'KS', 'LP', 'AG', 'PS',
        'PO', 'HG', 'EL', 'SA', 'RF', 'MR', 'BI', 'BJ', 'IS']),
    retail: new Set(['YO', 'PG', 'AP', 'GL', 'SH', 'CP', 'FZ', 'IP', 'OD', 'DN',
        'HD', 'PP', 'NC', 'WH', 'SP'])
};

// Default broker list to scan
const DEFAULT_BROKER_LIST = [
    'ZP', 'YU', 'KZ', 'RX', 'ML', 'CC', 'CS', 'DB', 'MS', 'YP', 'MG', 'LG', 'BK', 'AK', 'CG', 'DX',
    'NI', 'EP', 'IF', 'PD', 'AI', 'DR', 'KI', 'TP', 'BZ', 'DH', 'AZ', 'XA', 'IB', 'GI',
    'YO', 'PG', 'AP', 'GL', 'SH', 'CP'
];

// ── State ──
let allRows = [];          // flat: { broker, stock_code, buy_val, sell_val, net_val, total_val, ... }
let filteredRows = [];
let currentPage = 1;
let sortState = { key: 'net_val', desc: true };
let activeDays = 5;
let activePreset = 'all';
let isLoading = false;

// ── Helpers ──
function getBrokerCategory(code) {
    if (BROKER_CATEGORIES.foreign.has(code)) return 'foreign';
    if (BROKER_CATEGORIES.local.has(code)) return 'local';
    if (BROKER_CATEGORIES.retail.has(code)) return 'retail';
    return 'unknown';
}

function fmtValue(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1) + 'T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
    return v.toLocaleString('id-ID');
}

function fmtVol(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(0) + 'K';
    return v.toLocaleString('id-ID');
}

function netClass(v) {
    if (v > 0) return 'text-success';
    if (v < 0) return 'text-danger';
    return 'text-muted';
}

function catBadge(cat) {
    const map = {
        foreign: '<span class="cat-badge cat-foreign">F</span>',
        local: '<span class="cat-badge cat-local">L</span>',
        retail: '<span class="cat-badge cat-retail">R</span>',
    };
    return map[cat] || '<span class="cat-badge">?</span>';
}

function brokerLogo(code) {
    return `<img src="${API_BASE}/broker/logo/${code}" alt="${code}" class="broker-logo" loading="lazy" onerror="this.style.display='none'">`;
}

// ── Z-Score & Conviction Helpers ──

function fmtZ(z, minCount) {
    if (minCount !== undefined && minCount < 3) return '<span class="text-muted">—</span>';
    if (!Number.isFinite(z)) return '<span class="text-muted">—</span>';
    const cls = z >= 2 ? 'text-success fw-bold'
              : z >= 1 ? 'text-success'
              : z <= -2 ? 'text-danger fw-bold'
              : z <= -1 ? 'text-danger'
              : 'text-muted';
    return `<span class="${cls}">${z >= 0 ? '+' : ''}${z.toFixed(2)}</span>`;
}

function fmtPct(c) {
    if (!Number.isFinite(c) || c === 0) return '<span class="text-muted">—</span>';
    const pct = (c * 100).toFixed(0);
    const cls = c >= 0.7 ? 'text-success fw-bold' : c >= 0.4 ? 'text-warning' : 'text-muted';
    return `<span class="${cls}">${pct}%</span>`;
}

/**
 * Compute z-scores and conviction for all loaded rows.
 *
 * Columns added to each row:
 *   conviction  – |net_val| / total_val  (0..1, how directional the position is)
 *   z_net       – cross-sectional within broker's portfolio
 *                 (how extreme is this stock vs the broker's other positions)
 *   z_ind       – cross-broker for same stock
 *                 (how extreme is this broker vs industry average for this stock)
 *   n_brokers_stock – how many brokers are active in this stock (for z_ind validity)
 */
function computeZScores() {
    if (allRows.length === 0) return;

    // 1. Conviction: |net| / total
    for (const r of allRows) {
        r.conviction = r.total_val > 0 ? Math.abs(r.net_val) / r.total_val : 0;
    }

    // 2. Z-Net: within broker's own portfolio
    //    "Is this stock an outlier in what this broker is doing?"
    const byBroker = {};
    for (const r of allRows) {
        (byBroker[r.broker] ||= []).push(r);
    }
    for (const rows of Object.values(byBroker)) {
        const nets = rows.map(r => r.net_val);
        const n = nets.length;
        if (n < 2) { rows.forEach(r => { r.z_net = 0; }); continue; }
        const mean = nets.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(nets.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
        rows.forEach(r => { r.z_net = std > 0 ? (r.net_val - mean) / std : 0; });
    }

    // 3. Z-Ind: across brokers for the same stock
    //    "Is this broker's activity unusual vs what other brokers are doing in this stock?"
    const byStock = {};
    for (const r of allRows) {
        (byStock[r.stock_code] ||= []).push(r);
    }
    for (const rows of Object.values(byStock)) {
        const nets = rows.map(r => r.net_val);
        const n = nets.length;
        rows.forEach(r => { r.n_brokers_stock = n; });
        if (n < 3) { rows.forEach(r => { r.z_ind = 0; }); continue; }
        const mean = nets.reduce((a, b) => a + b, 0) / n;
        const std = Math.sqrt(nets.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
        rows.forEach(r => { r.z_ind = std > 0 ? (r.net_val - mean) / std : 0; });
    }

    console.log(`[broker-activity] Z-scores computed for ${allRows.length} rows`);
}

// ══════════════════════════════════════════════
// API CALLS
// ══════════════════════════════════════════════

/**
 * Fetch broker activity for a single broker.
 * GET /broker-activity?broker=MG&days=1
 * Returns: { ok, broker, days, dates_loaded, breadth, stocks: [...] }
 */
async function fetchBrokerActivity(brokerCode, days) {
    const url = `${API_BASE}/broker-activity?broker=${brokerCode}&days=${days}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
}

/**
 * Fetch available broker list.
 * GET /broker-activity?days=1
 * Returns: { ok, date, brokers: ["MG","ZP",...], count }
 */
async function fetchBrokerList() {
    const url = `${API_BASE}/broker-activity?days=1`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
}

// ══════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════

const CVD_WINDOWS = [2, 5, 10, 20];

async function loadAllBrokers() {
    if (isLoading) return;
    isLoading = true;

    const brokers = activePreset === 'all'
        ? DEFAULT_BROKER_LIST
        : DEFAULT_BROKER_LIST.filter(b => getBrokerCategory(b) === activePreset);

    showLoading(`Memuat ${brokers.length} broker (${activeDays}D + CVD)...`);
    allRows = [];

    let loaded = 0;
    let failed = 0;

    // For each broker: fetch activeDays for main columns + 4 CVD windows for net_vol
    const batchSize = 4;
    for (let i = 0; i < brokers.length; i += batchSize) {
        const batch = brokers.slice(i, i + batchSize);

        const results = await Promise.allSettled(
            batch.map(async (code) => {
                // Fetch all windows in parallel per broker
                const windowsToFetch = [...new Set([activeDays, ...CVD_WINDOWS])];
                const fetches = await Promise.allSettled(
                    windowsToFetch.map(d => fetchBrokerActivity(code, d))
                );
                const dataByDays = {};
                windowsToFetch.forEach((d, idx) => {
                    if (fetches[idx].status === 'fulfilled' && fetches[idx].value.ok) {
                        dataByDays[d] = fetches[idx].value;
                    }
                });
                return { code, dataByDays };
            })
        );

        results.forEach((result) => {
            if (result.status !== 'fulfilled') { failed++; return; }
            const { code, dataByDays } = result.value;
            const mainData = dataByDays[activeDays];
            if (!mainData) { failed++; return; }

            // Build CVD lookup: stock → { cvd_2d, cvd_5d, cvd_10d, cvd_20d }
            const cvdMap = {};
            for (const w of CVD_WINDOWS) {
                const wd = dataByDays[w];
                if (!wd) continue;
                for (const s of (wd.stocks || [])) {
                    if (!cvdMap[s.stock_code]) cvdMap[s.stock_code] = {};
                    cvdMap[s.stock_code][`cvd_${w}d`] = Number(s.net_vol) || 0;
                }
            }

            for (const s of (mainData.stocks || [])) {
                const cvd = cvdMap[s.stock_code] || {};
                allRows.push({
                    broker: code,
                    stock_code: s.stock_code,
                    buy_val: Number(s.buy_val) || 0,
                    sell_val: Number(s.sell_val) || 0,
                    net_val: Number(s.net_val) || 0,
                    total_val: Number(s.total_val) || 0,
                    buy_vol: Number(s.buy_vol) || 0,
                    sell_vol: Number(s.sell_vol) || 0,
                    net_vol: Number(s.net_vol) || 0,
                    buy_freq: Number(s.buy_freq) || 0,
                    sell_freq: Number(s.sell_freq) || 0,
                    cvd_2d: cvd.cvd_2d || 0,
                    cvd_5d: cvd.cvd_5d || 0,
                    cvd_10d: cvd.cvd_10d || 0,
                    cvd_20d: cvd.cvd_20d || 0,
                });
            }
            loaded++;
        });

        showLoading(`Memuat broker... ${loaded}/${brokers.length} (${failed} gagal)`);
    }

    isLoading = false;
    hideLoading();
    computeZScores();
    applyFilters();
    console.log(`[broker-activity] Loaded ${allRows.length} rows from ${loaded} brokers (${failed} failed)`);
}

// ══════════════════════════════════════════════
// FILTER + RENDER
// ══════════════════════════════════════════════

function applyFilters() {
    const search = ($('#broker-search').val() || '').toUpperCase().trim();
    filteredRows = allRows.filter(r => {
        if (activePreset !== 'all') {
            const cat = getBrokerCategory(r.broker);
            if (cat !== activePreset) return false;
        }
        if (search) {
            if (!r.broker.includes(search) && !r.stock_code.includes(search)) return false;
        }
        return true;
    });

    const key = sortState.key;
    const dir = sortState.desc ? -1 : 1;
    filteredRows.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (typeof av === 'string') return dir * av.localeCompare(bv);
        return dir * ((av || 0) - (bv || 0));
    });
    currentPage = 1;
    renderTable();
}

function renderTable() {
    const $tbody = $('#tbody-broker');
    const total = filteredRows.length;
    const start = (currentPage - 1) * BROKER_PAGE_SIZE;
    const page = filteredRows.slice(start, start + BROKER_PAGE_SIZE);

    if (total === 0 && !isLoading) {
        $tbody.html(
            '<tr><td colspan="17" class="text-center text-muted py-4">' +
            '<i class="fa-solid fa-inbox me-2"></i>Tidak ada data. Pastikan data sudah di-scrape terlebih dahulu.' +
            '</td></tr>'
        );
    } else if (page.length === 0) {
        $tbody.html(
            '<tr><td colspan="17" class="text-center text-muted py-4">' +
            '<i class="fa-solid fa-filter me-2"></i>Tidak ada data sesuai filter.' +
            '</td></tr>'
        );
    } else {
        let html = '';
        page.forEach((r, i) => {
            const cat = getBrokerCategory(r.broker);
            html += `<tr>
                <td class="text-center sticky-col sticky-col-no">${start + i + 1}</td>
                <td class="sticky-col sticky-col-code fw-semibold">
                    ${brokerLogo(r.broker)} ${r.broker}
                </td>
                <td class="fw-semibold">
                    <a href="/idx/emiten/detail.html?code=${r.stock_code}" class="text-decoration-none"
                       style="color:var(--text)">${r.stock_code}</a>
                </td>
                <td class="text-end ${netClass(r.net_val)}">${fmtValue(r.net_val)}</td>
                <td class="text-end">${fmtValue(r.buy_val)}</td>
                <td class="text-end">${fmtValue(r.sell_val)}</td>
                <td class="text-end">${fmtValue(r.total_val)}</td>
                <td class="text-end hide-mobile ${netClass(r.net_vol)}">${fmtVol(r.net_vol)}</td>
                <td class="text-center hide-mobile">${r.buy_freq.toLocaleString('id-ID')}</td>
                <td class="text-center hide-mobile">${r.sell_freq.toLocaleString('id-ID')}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_2d)}">${fmtVol(r.cvd_2d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_5d)}">${fmtVol(r.cvd_5d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_10d)}">${fmtVol(r.cvd_10d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_20d)}">${fmtVol(r.cvd_20d)}</td>
                <td class="text-center hide-mobile">${fmtPct(r.conviction)}</td>
                <td class="text-center hide-mobile">${fmtZ(r.z_net)}</td>
                <td class="text-center hide-mobile">${fmtZ(r.z_ind, r.n_brokers_stock)}</td>
            </tr>`;
        });
        $tbody.html(html);
    }

    // Pagination
    $('#page-range').text(`${total > 0 ? start + 1 : 0}-${Math.min(start + BROKER_PAGE_SIZE, total)}`);
    $('#total-items').text(total);
    $('#prev-page').toggleClass('disabled', currentPage <= 1);
    const maxPage = Math.max(1, Math.ceil(total / BROKER_PAGE_SIZE));
    $('#next-page').toggleClass('disabled', currentPage >= maxPage);
    $('#pagination-nav .page-item.active .page-link').text(currentPage);

    // Broker count
    const uniqueBrokers = new Set(filteredRows.map(r => r.broker)).size;
    $('#broker-count').text(`${uniqueBrokers} broker · ${total} rows`);
}

function showLoading(msg) {
    $('#broker-bubble-loading').html(
        `<div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
         <span class="small text-muted">${msg || 'Memuat...'}</span>`
    ).show();
    $('#broker-bubble-container').hide();
}

function hideLoading() {
    $('#broker-bubble-loading').hide();
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════

$(function () {
    $('#loading-indicator').hide();
    $('#app').show();

    // Initial placeholder
    $('#tbody-broker').html(
        '<tr><td colspan="17" class="text-center text-muted py-4">' +
        '<i class="fa-solid fa-spinner fa-spin me-2"></i>Memuat data broker activity...' +
        '</td></tr>'
    );

    $('#broker-bubble-loading').html(
        '<p class="small text-muted mb-0">' +
        '<i class="fa-solid fa-chart-scatter me-1"></i> ' +
        'Broker bubble chart akan muncul setelah data tersedia' +
        '</p>'
    );

    // ── Preset selector ──
    $('#preset-selector a').on('click', function (e) {
        e.preventDefault();
        $('#preset-selector a').removeClass('active');
        $(this).addClass('active');
        activePreset = $(this).data('preset');
        // If data already loaded, just re-filter. If different preset needs different brokers, reload.
        if (allRows.length > 0) {
            applyFilters();
        } else {
            loadAllBrokers();
        }
    });

    // ── Filter dropdowns ──
    $(document).on('click', '[data-filter]', function (e) {
        e.preventDefault();
        const filter = $(this).data('filter');
        const val = $(this).data('val');
        $(`#dd-${filter}`).text(
            `${filter.charAt(0).toUpperCase() + filter.slice(1)}: ${val === 'any' ? 'Any' : val}`
        );
        applyFilters();
    });

    // ── Timeframe selector ──
    $('#broker-range-selector a').on('click', function (e) {
        e.preventDefault();
        $('#broker-range-selector a').removeClass('active');
        $(this).addClass('active');
        activeDays = parseInt($(this).data('days')) || 1;
        loadAllBrokers();
    });

    // ── Search ──
    let searchTimer = null;
    $('#broker-search').on('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => applyFilters(), 300);
    });

    // ── Table sort ──
    $('#broker-table thead th[data-sort]').on('click', function () {
        const key = $(this).data('sort');
        if (sortState.key === key) {
            sortState.desc = !sortState.desc;
        } else {
            sortState = { key, desc: true };
        }
        $('#broker-table thead th[data-sort] i').attr('class', 'fa-solid fa-sort small text-muted');
        $(this).find('i').attr('class',
            sortState.desc ? 'fa-solid fa-sort-down small' : 'fa-solid fa-sort-up small'
        );
        applyFilters();
    });

    // ── Pagination ──
    $('#prev-page').on('click', function (e) {
        e.preventDefault();
        if (currentPage > 1) { currentPage--; renderTable(); }
    });
    $('#next-page').on('click', function (e) {
        e.preventDefault();
        const maxPage = Math.max(1, Math.ceil(filteredRows.length / BROKER_PAGE_SIZE));
        if (currentPage < maxPage) { currentPage++; renderTable(); }
    });

    // ── Reset filters ──
    $('#btn-reset-filters').on('click', function (e) {
        e.preventDefault();
        activePreset = 'all';
        $('#preset-selector a').removeClass('active');
        $('#preset-selector a[data-preset="all"]').addClass('active');
        $('#broker-search').val('');
        $('#filter-row .dropdown-toggle').each(function () {
            const filter = $(this).attr('id').replace('dd-', '');
            $(this).text(`${filter.charAt(0).toUpperCase() + filter.slice(1)}: Any`);
        });
        applyFilters();
    });

    // ── Auto-load on page open ──
    loadAllBrokers();

    console.log('[broker-activity] Initialized. Fetching broker data from API...');
});

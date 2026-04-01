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

// Broker classification from D1 database (cached in localStorage, TTL 30 days)
const BROKERS_CACHE_KEY = 'brokers_category_cache';
const BROKERS_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
let brokersMap = {};       // { code: { code, name, category, ... } }
let brokersLoaded = false; // flag: true once /brokers data is ready

function loadBrokersFromCache() {
    try {
        const raw = localStorage.getItem(BROKERS_CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts > BROKERS_CACHE_TTL) {
            localStorage.removeItem(BROKERS_CACHE_KEY);
            return null;
        }
        return cached.brokers; // array of broker objects
    } catch (e) {
        localStorage.removeItem(BROKERS_CACHE_KEY);
        return null;
    }
}

function saveBrokersToCache(brokers) {
    try {
        localStorage.setItem(BROKERS_CACHE_KEY, JSON.stringify({
            ts: Date.now(),
            brokers
        }));
    } catch (e) {
        console.warn('[broker-activity] Failed to cache brokers:', e);
    }
}

async function loadBrokersFromDB() {
    // 1) Try localStorage cache first
    const cached = loadBrokersFromCache();
    if (cached && cached.length > 0) {
        cached.forEach(b => { brokersMap[b.code] = b; });
        brokersLoaded = true;
        console.log(`[broker-activity] Brokers loaded from cache (${cached.length} brokers)`);
        return;
    }
    // 2) Fetch from API
    try {
        const res = await fetch(API_BASE + '/brokers');
        const data = await res.json();
        if (data.brokers && Array.isArray(data.brokers)) {
            data.brokers.forEach(b => { brokersMap[b.code] = b; });
            saveBrokersToCache(data.brokers);
            brokersLoaded = true;
            console.log(`[broker-activity] Loaded ${data.brokers.length} brokers from D1 (cached for 30 days)`);
        }
    } catch (e) {
        console.warn('[broker-activity] Failed to load brokers from D1:', e);
    }
}

// Default broker list to scan
const DEFAULT_BROKER_LIST = [
    'ZP', 'YU', 'KZ', 'RX', 'ML', 'CC', 'CS', 'DB', 'MS', 'YP', 'MG', 'LG', 'BK', 'AK', 'CG', 'DX', 'HP',
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
let forceRebuild = false;
// ── Filter State ──
let activeFilteredBrokers = new Set(); // empty = all; affects both chart AND table
let filterNetDir = 'any';              // 'any' | 'buy' | 'sell'
let filterBreadthMin = 0;
let filterTotalValMin = 0;
let filterQuadrant = 'any';            // 'any' | 'Q1' | 'Q2' | 'Q3' | 'Q4'
let activeCvdTrend = 'any';            // 'any' | 'up2' | 'up1' | 'neutral' | 'down1' | 'down2'

// ── Cache ──
const CACHE_PREFIX = 'broker_activity_';

function getTodayJakarta() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

function getCacheKey() {
    return `${CACHE_PREFIX}${activeDays}`;
}

function getCache() {
    try {
        const raw = localStorage.getItem(getCacheKey());
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (cached.date !== getTodayJakarta()) {
            localStorage.removeItem(getCacheKey());
            return null;
        }
        return cached;
    } catch (e) {
        console.warn('[broker-activity] Cache read error:', e);
        return null;
    }
}

function setCache(rows, dailyData) {
    try {
        const payload = {
            ts: Date.now(),
            date: getTodayJakarta(),
            activeDays,
            allRows: rows,
            brokerDailyData: dailyData,
        };
        localStorage.setItem(getCacheKey(), JSON.stringify(payload));
        console.log(`[broker-activity] Cache saved: ${getCacheKey()} (${rows.length} rows)`);
    } catch (e) {
        console.warn('[broker-activity] Cache save failed:', e);
    }
}

function clearAllCaches() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    console.log(`[broker-activity] Cleared ${keys.length} caches`);
}

function updateCacheStatus(fromCache, ts) {
    const $el = $('#cache-status');
    if (!$el.length) return;
    if (fromCache) {
        const ago = Math.round((Date.now() - ts) / 60000);
        $el.html(`<i class="fa-solid fa-database me-1"></i>Cache · ${ago}m ago`)
           .removeClass('text-warning').addClass('text-info').show();
    } else {
        $el.html(`<i class="fa-solid fa-cloud-arrow-down me-1"></i>Live`)
           .removeClass('text-info').addClass('text-warning').show();
    }
}

// ══════════════════════════════════════════════
// URL PARAMETER PERSISTENCE
// ══════════════════════════════════════════════
function pushUrlParams() {
    const params = new URLSearchParams();
    if (activeDays !== 5) params.set('days', activeDays);
    if (activePreset !== 'all') params.set('preset', activePreset);
    if (activeFilteredBrokers.size > 0) params.set('brokers', [...activeFilteredBrokers].join(','));
    if (sortState.key !== 'net_val' || !sortState.desc) params.set('sort', `${sortState.key}:${sortState.desc ? 'd' : 'a'}`);
    if (activeCvdTrend !== 'any') params.set('cvd', activeCvdTrend);
    if (filterNetDir !== 'any') params.set('netdir', filterNetDir);
    if (filterBreadthMin > 0) params.set('breadth', filterBreadthMin);
    if (filterTotalValMin > 0) params.set('val', filterTotalValMin);
    if (filterQuadrant !== 'any') params.set('quad', filterQuadrant);
    const search = ($('#broker-search').val() || '').trim();
    if (search) params.set('q', search);
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
}

function readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('cache') === 'rebuild') return;
    if (params.has('days')) activeDays = parseInt(params.get('days')) || 5;
    if (params.has('preset')) activePreset = params.get('preset') || 'all';
    if (params.has('brokers')) {
        const b = params.get('brokers').split(',').filter(Boolean);
        activeFilteredBrokers = new Set(b);
    }
    if (params.has('sort')) {
        const parts = params.get('sort').split(':');
        if (parts.length === 2) sortState = { key: parts[0], desc: parts[1] !== 'a' };
    }
    if (params.has('cvd'))    activeCvdTrend   = params.get('cvd');
    if (params.has('netdir')) filterNetDir     = params.get('netdir');
    if (params.has('breadth')) filterBreadthMin = parseFloat(params.get('breadth')) || 0;
    if (params.has('val'))    filterTotalValMin = parseFloat(params.get('val')) || 0;
    if (params.has('quad'))   filterQuadrant   = params.get('quad');
}

function syncDomToState() {
    // Timeframe
    $('#broker-range-selector a').removeClass('active');
    $(`#broker-range-selector a[data-days="${activeDays}"]`).addClass('active');
    // Preset
    $('#preset-selector a').removeClass('active');
    $(`#preset-selector a[data-preset="${activePreset}"]`).addClass('active');
    // Sort icon
    if (sortState.key !== 'net_val' || !sortState.desc) {
        $('#broker-table thead th[data-sort] i').attr('class', 'fa-solid fa-sort small text-muted');
        $(`#broker-table thead th[data-sort="${sortState.key}"]`).find('i').attr('class',
            sortState.desc ? 'fa-solid fa-sort-down small' : 'fa-solid fa-sort-up small');
    }
    // Dropdown labels
    const cvdLabels = { up2: '▲▲ Accum', up1: '▲ Accum', neutral: '─ Neutral', down1: '▼ Distrib', down2: '▼▼ Distrib' };
    const netLabels = { buy: 'Net Buy', sell: 'Net Sell' };
    if (filterNetDir !== 'any')    $('#dd-netdir').text(`Net: ${netLabels[filterNetDir] || filterNetDir}`);
    if (filterBreadthMin > 0)  { $('#dd-breadth').text(`Breadth: ≥${filterBreadthMin}`); $('[data-nf="breadth_min"]').val(filterBreadthMin); }
    if (filterTotalValMin > 0) { $('#dd-totalval').text(`Value: ≥${filterTotalValMin}B`); $('[data-nf="totalval_min"]').val(filterTotalValMin); }
    if (filterQuadrant !== 'any')  $('#dd-quadrant').text(`Quadrant: ${filterQuadrant}`);
    if (activeCvdTrend !== 'any')  $('#dd-cvdtrend').text(`CVD: ${cvdLabels[activeCvdTrend] || activeCvdTrend}`);
    // Search
    const qParam = new URLSearchParams(window.location.search).get('q');
    if (qParam) $('#broker-search').val(qParam);
}

// ── Helpers ──
function getBrokerCategory(code) {
    const broker = brokersMap[code];
    if (broker && broker.category) {
        const cat = broker.category.toLowerCase();
        if (cat.includes('foreign') || cat.includes('asing')) return 'foreign';
        if (cat.includes('local') || cat.includes('lokal')) return 'local';
        if (cat.includes('retail')) return 'retail';
        return cat;
    }
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

function fmtValueShort(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
    const sign = v < 0 ? '-' : '';
    const abs = Math.abs(v);
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(0) + 'T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(0) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(0) + 'M';
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
    return `<img src="${API_BASE}/broker/logo/${code}" alt="${code}" class="broker-logo" loading="lazy" onerror="this.style.display='none'"> `;
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
 * CVD Trend score: apakah broker akselerasi akumulasi?
 *
 * Logika:
 *   1. Normalize per hari: avg2 = cvd_2d/2, avg5 = cvd_5d/5, ...
 *   2. Bandingkan window pendek vs panjang (3 pairs): +1 jika pendek > panjang, -1 sebaliknya
 *   3. Arah terkini: cvd_2d > 0 → +1, < 0 → -1
 *   Score range: -4 (strong distrib) to +4 (strong accum)
 *
 * Display:
 *   ≥3  = ▲▲ Strong Accum (hijau bold)
 *   1-2 = ▲  Accum (hijau)
 *   0   = ─  Neutral (abu)
 *  -1–2 = ▼  Distrib (merah)
 *  ≤-3  = ▼▼ Strong Distrib (merah bold)
 */
function computeCvdTrend(r) {
    const avg2  = r.cvd_2d  / 2;
    const avg5  = r.cvd_5d  / 5;
    const avg10 = r.cvd_10d / 10;
    const avg20 = r.cvd_20d / 20;
    let score = 0;
    score += (avg2 > avg5)   ? 1 : (avg2 < avg5)   ? -1 : 0;
    score += (avg5 > avg10)  ? 1 : (avg5 < avg10)  ? -1 : 0;
    score += (avg10 > avg20) ? 1 : (avg10 < avg20) ? -1 : 0;
    score += r.cvd_2d > 0 ? 1 : r.cvd_2d < 0 ? -1 : 0;
    return score;
}

function fmtCvdTrend(score) {
    if (score >= 3)  return '<span class="text-success fw-bold">▲▲</span>';
    if (score >= 1)  return '<span class="text-success">▲</span>';
    if (score === 0) return '<span class="text-muted">─</span>';
    if (score >= -2) return '<span class="text-danger">▼</span>';
    return '<span class="text-danger fw-bold">▼▼</span>';
}

function fmtPrice(v) {
    if (!Number.isFinite(v) || v <= 0) return '<span class="text-muted">—</span>';
    return v.toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

function fmtStreak(s) {
    if (!s || s === 0) return '<span class="text-muted">—</span>';
    const abs = Math.abs(s);
    if (s > 0) {
        const cls = abs >= 5 ? 'text-success fw-bold' : 'text-success';
        return `<span class="${cls}">▲${abs}D</span>`;
    } else {
        const cls = abs >= 5 ? 'text-danger fw-bold' : 'text-danger';
        return `<span class="${cls}">▼${abs}D</span>`;
    }
}

// ── Interbroker Accumulation Formatters ──

function fmtCR(cr) {
    if (!Number.isFinite(cr) || cr === 0) return '<span class="text-muted">—</span>';
    const pct = (cr * 100).toFixed(0);
    const cls = cr >= 0.4 ? 'text-warning fw-bold' : cr >= 0.2 ? 'text-warning' : 'text-muted';
    return `<span class="${cls}">${pct}%</span>`;
}

function fmtPersist(p, streak) {
    if (!Number.isFinite(p) || p === 0) return '<span class="text-muted">—</span>';
    const pct = (p * 100).toFixed(0);
    const isDistrib = (streak || 0) < 0;
    const hi = isDistrib ? 'text-danger fw-bold' : 'text-success fw-bold';
    const md = isDistrib ? 'text-danger' : 'text-success';
    const cls = p >= 0.7 ? hi : p >= 0.4 ? md : 'text-muted';
    return `<span class="${cls}">${pct}%</span>`;
}

function fmtHerd(h, n) {
    if (!Number.isFinite(h) || h === 0 || n < 2) return '<span class="text-muted">—</span>';
    const pct = (h * 100).toFixed(0);
    const cls = h >= 0.7 ? 'text-success fw-bold' : h >= 0.5 ? 'text-success' : h <= 0.3 ? 'text-danger' : 'text-muted';
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

    // 4. CVD Trend: momentum across CVD windows
    for (const r of allRows) {
        r.cvd_trend = computeCvdTrend(r);
    }

    // 5. Concentration Ratio (CR%): |net_val_broker| / Σ|net_val_all| per stock
    //    "How dominant is this broker's flow in this stock?"
    for (const rows of Object.values(byStock)) {
        const totalAbsNet = rows.reduce((s, r) => s + Math.abs(r.net_val), 0);
        rows.forEach(r => {
            r.cr_pct = totalAbsNet > 0 ? Math.abs(r.net_val) / totalAbsNet : 0;
        });
    }

    // 6. Persistence Score: |streak| / activeDays
    //    "How consistently has this broker been buying/selling this stock?"
    for (const r of allRows) {
        r.persistence = activeDays > 0 ? Math.abs(r.streak || 0) / activeDays : 0;
    }

    // 7. Herding %: proportion of brokers moving same direction on this stock
    //    "Are other brokers doing the same thing?"
    for (const rows of Object.values(byStock)) {
        const n = rows.length;
        const nBuy = rows.filter(r => r.net_val > 0).length;
        const nSell = rows.filter(r => r.net_val < 0).length;
        rows.forEach(r => {
            if (n < 2 || r.net_val === 0) { r.herd_pct = 0; return; }
            // How many brokers are on the same side as this broker?
            const sameDir = r.net_val > 0 ? nBuy : nSell;
            r.herd_pct = sameDir / n;
        });
    }

    console.log(`[broker-activity] Z-scores + CVD trends + interbroker metrics computed for ${allRows.length} rows`);
}

// ══════════════════════════════════════════════
// API CALLS
// ══════════════════════════════════════════════

/**
 * Fetch broker activity for a single broker.
 * GET /broker-activity?broker=MG&days=1&nocache=true
 * Returns: { ok, broker, days, dates_loaded, breadth, stocks: [...] }
 */
async function fetchBrokerActivity(brokerCode, days) {
    const url = `${API_BASE}/broker-activity?broker=${brokerCode}&days=${days}&nocache=true`;
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

/**
 * Fetch per-day breakdown for a single broker.
 * GET /broker-activity?broker=MG&days=10&breakdown=daily
 * Returns: { ok, broker, days, daily: [{ date, net_val, total_val, breadth, buy_val, sell_val, buy_freq, sell_freq }] }
 */
async function fetchBrokerDaily(brokerCode, days) {
    const url = `${API_BASE}/broker-activity?broker=${brokerCode}&days=${days}&breakdown=daily`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
}

// ══════════════════════════════════════════════
// DATA LOADING
// ══════════════════════════════════════════════

const CVD_WINDOWS = [2, 5, 10, 20];
let brokerDailyData = {}; // { "MG": [{date, net_val, total_val, breadth}, ...], ... }

async function loadAllBrokers() {
    if (isLoading) return;

    // ── Load broker classification from D1 (if not loaded yet) ──
    if (!brokersLoaded) await loadBrokersFromDB();

    // ── Cache check ──
    if (!forceRebuild) {
        const cached = getCache();
        if (cached) {
            allRows = cached.allRows || [];
            brokerDailyData = cached.brokerDailyData || {};
            hideLoading();
            computeZScores();
            renderMeteorBubble();
            applyFilters();
            updateCacheStatus(true, cached.ts);
            console.log(`[broker-activity] Loaded from cache: ${allRows.length} rows`);
            return;
        }
    }
    forceRebuild = false;
    isLoading = true;

    // Always fetch all brokers; preset filtering done in applyFilters()
    const brokers = DEFAULT_BROKER_LIST;

    showLoading(`Memuat ${brokers.length} broker (${activeDays}D + CVD)...`);
    allRows = [];
    brokerDailyData = {};

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

            // Build CVD lookup: stock → { cvd_2d, cvd_5d, cvd_10d, cvd_20d, streak }
            const cvdMap = {};
            for (const w of CVD_WINDOWS) {
                const wd = dataByDays[w];
                if (!wd) continue;
                for (const s of (wd.stocks || [])) {
                    if (!cvdMap[s.stock_code]) cvdMap[s.stock_code] = {};
                    cvdMap[s.stock_code][`cvd_${w}d`] = Number(s.net_vol) || 0;
                    // Use streak from longest window (20D) for best coverage
                    if (w === 20 && s.streak !== undefined) {
                        cvdMap[s.stock_code].streak = Number(s.streak) || 0;
                    }
                }
            }

            for (const s of (mainData.stocks || [])) {
                const cvd = cvdMap[s.stock_code] || {};
                const bv = Number(s.buy_val) || 0;
                const sv = Number(s.sell_val) || 0;
                const bvol = Number(s.buy_vol) || 0;
                const svol = Number(s.sell_vol) || 0;
                allRows.push({
                    broker: code,
                    stock_code: s.stock_code,
                    buy_val: bv,
                    sell_val: sv,
                    net_val: Number(s.net_val) || 0,
                    total_val: Number(s.total_val) || 0,
                    buy_vol: bvol,
                    sell_vol: svol,
                    net_vol: Number(s.net_vol) || 0,
                    buy_freq: Number(s.buy_freq) || 0,
                    sell_freq: Number(s.sell_freq) || 0,
                    avg_buy: bvol > 0 ? bv / bvol : 0,
                    avg_sell: svol > 0 ? sv / svol : 0,
                    cvd_2d: cvd.cvd_2d || 0,
                    cvd_5d: cvd.cvd_5d || 0,
                    cvd_10d: cvd.cvd_10d || 0,
                    cvd_20d: cvd.cvd_20d || 0,
                    streak: cvd.streak || Number(s.streak) || 0,
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

    // Load per-day data for meteor chart (async, after table renders)
    await loadMeteorData();
    setCache(allRows, brokerDailyData);
    updateCacheStatus(false);
}

// ══════════════════════════════════════════════
// FILTER + RENDER
// ══════════════════════════════════════════════

function applyFilters() {
    const search = ($('#broker-search').val() || '').toUpperCase().trim();

    // Pre-compute broker-level quadrant if needed
    let brokerQuadrantMap = {};
    if (filterQuadrant !== 'any') {
        const aggMap = {};
        for (const r of allRows) {
            if (!aggMap[r.broker]) aggMap[r.broker] = { net_val: 0, stocks: new Set() };
            aggMap[r.broker].net_val += r.net_val;
            aggMap[r.broker].stocks.add(r.stock_code);
        }
        const bvals = Object.values(aggMap).map(b => b.stocks.size).sort((a, b) => a - b);
        const medB = bvals[Math.floor(bvals.length / 2)] || 1;
        for (const [code, agg] of Object.entries(aggMap)) {
            brokerQuadrantMap[code] = getBubbleQuadrant(agg.net_val, agg.stocks.size, medB);
        }
    }

    // Pre-compute broker breadths if needed
    let brokerBreadthMap = {};
    if (filterBreadthMin > 0) {
        for (const r of allRows) {
            (brokerBreadthMap[r.broker] ||= new Set()).add(r.stock_code);
        }
    }

    filteredRows = allRows.filter(r => {
        // Category / Preset
        if (activePreset !== 'all' && getBrokerCategory(r.broker) !== activePreset) return false;
        // Broker filter (affects chart AND table)
        if (activeFilteredBrokers.size > 0 && !activeFilteredBrokers.has(r.broker)) return false;
        // Search
        if (search && !r.broker.includes(search) && !r.stock_code.includes(search)) return false;
        // Net direction
        if (filterNetDir === 'buy'  && r.net_val <= 0) return false;
        if (filterNetDir === 'sell' && r.net_val >= 0) return false;
        // Breadth (broker-level: total stocks traded by this broker)
        if (filterBreadthMin > 0 && (brokerBreadthMap[r.broker]?.size || 0) < filterBreadthMin) return false;
        // Total value (per stock-broker row)
        if (filterTotalValMin > 0 && r.total_val < filterTotalValMin * 1e9) return false;
        // Quadrant (broker-level)
        if (filterQuadrant !== 'any' && brokerQuadrantMap[r.broker] !== filterQuadrant) return false;
        // CVD Trend (per stock-broker row)
        if (activeCvdTrend !== 'any') {
            const s = r.cvd_trend || 0;
            if (activeCvdTrend === 'up2'     && s < 3)              return false;
            if (activeCvdTrend === 'up1'     && (s < 1 || s >= 3)) return false;
            if (activeCvdTrend === 'neutral' && s !== 0)            return false;
            if (activeCvdTrend === 'down1'   && (s > -1 || s <= -3)) return false;
            if (activeCvdTrend === 'down2'   && s > -3)             return false;
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
            '<tr><td colspan="24" class="text-center text-muted py-4">' +
            '<i class="fa-solid fa-inbox me-2"></i>Tidak ada data. Pastikan data sudah di-scrape terlebih dahulu.' +
            '</td></tr>'
        );
    } else if (page.length === 0) {
        $tbody.html(
            '<tr><td colspan="24" class="text-center text-muted py-4">' +
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
                    <a href="/idx/broker/detail.html?kode=${r.broker}" class="text-decoration-none">${brokerLogo(r.broker)} ${r.broker}</a>
                </td>
                <td class="sticky-col sticky-col-emiten fw-semibold">
                    <a href="/idx/emiten/broker-summary.html?kode=${r.stock_code}" class="text-decoration-none">${r.stock_code}</a>
                </td>
                <td class="text-end hide-mobile" style="color:${r.avg_sell > r.avg_buy && r.avg_buy > 0 ? '#22c55e' : r.avg_buy > r.avg_sell && r.avg_sell > 0 ? '#ef4444' : ''}">${fmtPrice(r.avg_buy)}</td>
                <td class="text-end hide-mobile" style="color:${r.avg_sell > r.avg_buy && r.avg_buy > 0 ? '#22c55e' : r.avg_buy > r.avg_sell && r.avg_sell > 0 ? '#ef4444' : ''}">${fmtPrice(r.avg_sell)}</td>
                <td class="text-end ${netClass(r.net_val)}">${fmtValue(r.net_val)}</td>
                <td class="text-end col-bval">${fmtValue(r.buy_val)}</td>
                <td class="text-end col-sval">${fmtValue(r.sell_val)}</td>
                <td class="text-end">${fmtValue(r.total_val)}</td>
                <td class="text-end hide-mobile ${netClass(r.net_vol)}">${fmtVol(r.net_vol)}</td>
                <td class="text-center hide-mobile">${r.buy_freq.toLocaleString('id-ID')}</td>
                <td class="text-center hide-mobile">${r.sell_freq.toLocaleString('id-ID')}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_2d)}">${fmtVol(r.cvd_2d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_5d)}">${fmtVol(r.cvd_5d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_10d)}">${fmtVol(r.cvd_10d)}</td>
                <td class="text-end hide-mobile ${netClass(r.cvd_20d)}">${fmtVol(r.cvd_20d)}</td>
                <td class="text-center hide-mobile">${fmtCvdTrend(r.cvd_trend)}</td>
                <td class="text-center hide-mobile">${fmtStreak(r.streak)}</td>
                <td class="text-center hide-mobile">${fmtPct(r.conviction)}</td>
                <td class="text-center hide-mobile">${fmtZ(r.z_net)}</td>
                <td class="text-center hide-mobile">${fmtZ(r.z_ind, r.n_brokers_stock)}</td>
                <td class="text-center hide-mobile">${fmtCR(r.cr_pct)}</td>
                <td class="text-center hide-mobile">${fmtPersist(r.persistence, r.streak)}</td>
                <td class="text-center hide-mobile">${fmtHerd(r.herd_pct, r.n_brokers_stock)}</td>
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
    $('#total-pages').text(`/ ${maxPage}`);

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
// BUBBLE CHART: BROKER ACTIVITY MATRIX
// ══════════════════════════════════════════════

let brokerBubbleChart = null;

/**
 * Aggregate allRows (broker×stock) into per-broker summaries for bubble chart.
 * Returns: [{ broker, net_val, total_val, breadth }]
 */
function aggregateBrokersForBubble() {
    const map = {};
    for (const r of allRows) {
        if (!map[r.broker]) {
            map[r.broker] = { broker: r.broker, net_val: 0, total_val: 0, stocks: new Set() };
        }
        const b = map[r.broker];
        b.net_val += r.net_val;
        b.total_val += r.total_val;
        b.stocks.add(r.stock_code);
    }
    return Object.values(map).map(b => ({
        broker: b.broker,
        net_val: b.net_val,
        total_val: b.total_val,
        breadth: b.stocks.size,
    }));
}

/**
 * Quadrant assignment for broker bubble:
 *   Q1 (net≥0, breadth≥median) = Aggressive Accum
 *   Q2 (net<0, breadth≥median) = Aggressive Distrib
 *   Q3 (net<0, breadth<median) = Quiet Exit
 *   Q4 (net≥0, breadth<median) = Stealth Accum
 */
function getBubbleQuadrant(netVal, breadth, medianBreadth) {
    if (netVal >= 0 && breadth >= medianBreadth) return 'Q1';
    if (netVal < 0 && breadth >= medianBreadth)  return 'Q2';
    if (netVal < 0 && breadth < medianBreadth)   return 'Q3';
    return 'Q4';
}

function quadrantColor(q, alpha) {
    const a = alpha || 0.75;
    switch (q) {
        case 'Q1': return `rgba(34,197,94,${a})`;    // green
        case 'Q2': return `rgba(239,68,68,${a})`;     // red
        case 'Q3': return `rgba(245,158,11,${a})`;    // amber
        case 'Q4': return `rgba(59,130,246,${a})`;    // blue
        default:   return `rgba(150,150,150,${a})`;
    }
}

function renderBrokerBubble() {
    const brokers = aggregateBrokersForBubble();

    if (brokers.length === 0) {
        $('#broker-bubble-loading').html(
            '<p class="small text-muted mb-0">' +
            '<i class="fa-solid fa-circle-info me-1"></i>Tidak ada data untuk bubble chart</p>'
        ).show();
        $('#broker-bubble-container').hide();
        return;
    }

    // Median breadth → quadrant threshold (horizontal crosshair)
    const breadths = brokers.map(b => b.breadth).sort((a, b) => a - b);
    const medianBreadth = breadths[Math.floor(breadths.length / 2)];

    // Log-scale radius normalization
    const logMax = Math.log(Math.max(...brokers.map(b => b.total_val).filter(v => v > 0), 1) + 1);
    const minR = 8, maxR = 32;

    const points = brokers.map(b => {
        const q = getBubbleQuadrant(b.net_val, b.breadth, medianBreadth);
        const norm = b.total_val > 0 ? Math.log(b.total_val + 1) / logMax : 0;
        return {
            x: b.net_val,
            y: b.breadth,
            r: minR + norm * (maxR - minR),
            broker: b.broker,
            quadrant: q,
            total_val: b.total_val,
            category: getBrokerCategory(b.broker),
        };
    });

    // Theme-aware colors
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textCol  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    const gridCol  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    const zeroCol  = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    const labelCol = isDark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.72)';

    // Destroy previous chart
    if (brokerBubbleChart) { brokerBubbleChart.destroy(); brokerBubbleChart = null; }

    $('#broker-bubble-loading').hide();
    $('#broker-bubble-container').show();

    const ctx = document.getElementById('broker-bubble-chart').getContext('2d');

    // Plugin: draw broker code labels above each bubble
    const labelPlugin = {
        id: 'brokerBubbleLabels',
        afterDatasetsDraw(chart) {
            const c = chart.ctx;
            const meta = chart.getDatasetMeta(0);
            c.save();
            c.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            c.textAlign = 'center';
            c.textBaseline = 'bottom';
            c.fillStyle = labelCol;
            meta.data.forEach((pt, i) => {
                const raw = chart.data.datasets[0].data[i];
                c.fillText(raw.broker, pt.x, pt.y - pt.options.radius - 3);
            });
            c.restore();
        }
    };

    // Plugin: draw crosshair lines at x=0 (vertical) and y=medianBreadth (horizontal)
    const crosshairPlugin = {
        id: 'brokerBubbleCrosshair',
        afterDraw(chart) {
            const { ctx: c, chartArea: { left, right, top, bottom } } = chart;
            c.save();
            c.strokeStyle = zeroCol;
            c.lineWidth = 1;
            c.setLineDash([4, 4]);

            // Vertical line at x=0
            const xZero = chart.scales.x.getPixelForValue(0);
            if (xZero >= left && xZero <= right) {
                c.beginPath(); c.moveTo(xZero, top); c.lineTo(xZero, bottom); c.stroke();
            }
            // Horizontal line at median breadth
            const yMedian = chart.scales.y.getPixelForValue(medianBreadth);
            if (yMedian >= top && yMedian <= bottom) {
                c.beginPath(); c.moveTo(left, yMedian); c.lineTo(right, yMedian); c.stroke();
            }
            c.restore();
        }
    };

    brokerBubbleChart = new Chart(ctx, {
        type: 'bubble',
        data: {
            datasets: [{
                data: points,
                backgroundColor: points.map(p => quadrantColor(p.quadrant, 0.6)),
                borderColor: points.map(p => quadrantColor(p.quadrant, 0.9)),
                borderWidth: 1.5,
                hoverBorderWidth: 2.5,
            }]
        },
        plugins: [labelPlugin, crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 20 } },
            scales: {
                x: {
                    title: { display: window.innerWidth >= 768, text: 'Net Value (IDR)', color: textCol, font: { size: 11 } },
                    grid: {
                        color: (c) => c.tick && c.tick.value === 0 ? zeroCol : gridCol,
                    },
                    ticks: { callback: v => fmtValue(v), color: textCol, font: { size: 10 } },
                },
                y: {
                    title: { display: window.innerWidth >= 768, text: 'Breadth (Jumlah Saham)', color: textCol, font: { size: 11 } },
                    grid: { color: gridCol },
                    ticks: { color: textCol, font: { size: 10 } },
                    beginAtZero: true,
                }
            },
            plugins: {
                legend: { display: false },
                datalabels: false,
                tooltip: {
                    backgroundColor: isDark ? 'rgba(23,28,36,0.95)' : 'rgba(255,255,255,0.95)',
                    titleColor: isDark ? '#fff' : '#111',
                    bodyColor: isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.75)',
                    borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        title: (items) => {
                            const d = items[0].raw;
                            const catLabel = { foreign: 'Foreign', local: 'Local Fund', retail: 'Retail' };
                            return `${d.broker} (${catLabel[d.category] || 'Unknown'})`;
                        },
                        label: (item) => {
                            const d = item.raw;
                            const qLabel = {
                                Q1: 'Aggressive Accum', Q2: 'Aggressive Distrib',
                                Q3: 'Quiet Exit', Q4: 'Stealth Accum'
                            };
                            return [
                                `${d.quadrant} · ${qLabel[d.quadrant]}`,
                                `Net Value: ${fmtValue(d.x)}`,
                                `Breadth: ${d.y} saham`,
                                `Total Value: ${fmtValue(d.total_val)}`,
                            ];
                        }
                    }
                },
            },
            onClick: (_evt, elems) => {
                if (elems.length > 0) {
                    const idx = elems[0].index;
                    const broker = points[idx].broker;
                    $('#broker-search').val(broker).trigger('input');
                    document.getElementById('broker-table').scrollIntoView({ behavior: 'smooth' });
                }
            },
        }
    });

    console.log(`[broker-activity] Bubble chart: ${brokers.length} brokers, median breadth=${medianBreadth}`);
}

// ══════════════════════════════════════════════
// METEOR TRAIL: PER-DAY BROKER PRESSURE
// ══════════════════════════════════════════════

let meteorBubbleChart = null;

/**
 * Load per-day breakdown for top 15 brokers (by |net_val|).
 * Calls GET /broker-activity?broker=XX&days=N&breakdown=daily
 * Stores in brokerDailyData[broker] = [{date, net_val, total_val, breadth, ...}]
 */
async function loadMeteorData() {
    // Determine top 15 brokers from allRows aggregate
    const aggMap = {};
    for (const r of allRows) {
        if (!aggMap[r.broker]) aggMap[r.broker] = { net_val: 0, total_val: 0 };
        aggMap[r.broker].net_val += r.net_val;
        aggMap[r.broker].total_val += r.total_val;
    }
    const topBrokers = Object.entries(aggMap)
        .sort((a, b) => Math.abs(b[1].net_val) - Math.abs(a[1].net_val))
        .slice(0, 15)
        .map(([code]) => code);

    if (topBrokers.length === 0) {
        renderMeteorBubble();
        return;
    }

    showLoading(`Memuat meteor trail (${topBrokers.length} broker)...`);

    const batchSize = 5;
    for (let i = 0; i < topBrokers.length; i += batchSize) {
        const batch = topBrokers.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(code => fetchBrokerDaily(code, activeDays))
        );
        results.forEach((res, idx) => {
            if (res.status === 'fulfilled' && res.value.ok) {
                brokerDailyData[batch[idx]] = res.value.daily || [];
            }
        });
    }

    hideLoading();
    renderMeteorBubble();
    console.log(`[broker-activity] Meteor daily data loaded for ${topBrokers.length} brokers`);
}

/**
 * Populate broker filter button row (like PRESET). All active by default.
 * Clicking isolates that broker; clicking the only active one clears all (back to all).
 */
function populateBrokerButtonRow(allBrokers) {
    const $group = $('#broker-btn-group');
    if ($group.find('a[data-broker]').length > 0) {
        syncBrokerButtonState();
        return;
    }
    const catBtnClass = (code) => {
        const c = getBrokerCategory(code);
        if (c === 'foreign') return 'btn-outline-primary';
        if (c === 'local')   return 'btn-outline-success';
        if (c === 'retail')  return 'btn-outline-warning';
        return 'btn-outline-secondary';
    };
    const html = allBrokers.map(b =>
        `<a href="#" class="btn ${catBtnClass(b)} btn-sm active" data-broker="${b}"
            style="font-size:0.82rem;border-radius:0;padding:2px 10px;">${b}</a>`
    ).join('');
    $group.html(html);
    syncBrokerButtonState();

    $group.find('a[data-broker]').on('click', function (e) {
        e.preventDefault();
        const broker = $(this).data('broker');
        if (activeFilteredBrokers.size === 0) {
            // All showing → isolate this one
            activeFilteredBrokers = new Set([broker]);
        } else if (activeFilteredBrokers.has(broker) && activeFilteredBrokers.size === 1) {
            // Only this one → deselect all (back to all)
            activeFilteredBrokers.clear();
        } else {
            // Toggle this broker
            if (activeFilteredBrokers.has(broker)) activeFilteredBrokers.delete(broker);
            else activeFilteredBrokers.add(broker);
        }
        syncBrokerButtonState();
        renderMeteorBubble();
        applyFilters();
        pushUrlParams();
    });
}

/** Sync button active states to match activeFilteredBrokers set AND activePreset category. */
function syncBrokerButtonState() {
    const allActive = activeFilteredBrokers.size === 0;
    $('#broker-btn-group a[data-broker]').each(function () {
        const code = $(this).data('broker');
        const cat = getBrokerCategory(code);
        // If a category preset is active, only highlight brokers of that category
        const matchesPreset = activePreset === 'all' || cat === activePreset;
        const isActive = allActive ? matchesPreset : activeFilteredBrokers.has(code);
        $(this).toggleClass('active', isActive);
        // Dim non-matching brokers when a preset is active
        $(this).css('opacity', isActive ? '1' : '0.35');
    });
}

/**
 * Render meteor/trail bubble chart with per-day data.
 * Each bubble = one day's activity for a broker.
 * X = daily net_val (pressure), Y = daily breadth.
 * Trail: oldest → newest. Head = most recent day (largest bubble).
 */
function renderMeteorBubble() {
    const brokerCodes = Object.keys(brokerDailyData).filter(b => brokerDailyData[b].length >= 2);

    if (brokerCodes.length === 0) {
        $('#meteor-bubble-loading').html(
            '<p class="small text-muted mb-0"><i class="fa-solid fa-circle-info me-1"></i>Tidak ada data untuk meteor chart</p>'
        ).show();
        $('#meteor-bubble-container').hide();
        return;
    }

    // Rank by absolute net_val of most recent day → top 15
    const ranked = brokerCodes
        .map(b => {
            const daily = brokerDailyData[b];
            const newest = daily[0]; // API returns newest first
            return { broker: b, absNet: Math.abs(newest?.net_val || 0) };
        })
        .sort((a, b) => b.absNet - a.absNet)
        .slice(0, 15);
    let topBrokers = ranked.map(r => r.broker);

    // Populate broker button row (all ranked brokers before filter)
    populateBrokerButtonRow(ranked.map(r => r.broker));

    // Filter by selected brokers (if any selected, show only those; otherwise show all)
    if (activeFilteredBrokers.size > 0) {
        topBrokers = topBrokers.filter(b => activeFilteredBrokers.has(b));
    }

    if (topBrokers.length === 0) {
        $('#meteor-bubble-loading').html(
            '<p class="small text-muted mb-0"><i class="fa-solid fa-circle-info me-1"></i>Tidak ada data broker</p>'
        ).show();
        $('#meteor-bubble-container').hide();
        return;
    }

    // Collect all breadths from newest day for median threshold
    const newestBreadths = topBrokers
        .map(b => (brokerDailyData[b][0] || {}).breadth || 0)
        .sort((a, b) => a - b);
    const medianBreadth = newestBreadths[Math.floor(newestBreadths.length / 2)] || 1;

    // Theme colors
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textCol  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
    const zeroCol  = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    const labelCol = isDark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.72)';

    // Build datasets — one per broker
    const datasets = [];

    for (const broker of topBrokers) {
        // daily is newest-first from API, reverse so trail goes oldest→newest
        const daily = [...brokerDailyData[broker]].reverse();
        if (daily.length < 2) continue;

        const totalDays = daily.length;
        const head = daily[totalDays - 1]; // newest day = head

        // Quadrant based on head day
        const q = getBubbleQuadrant(head.net_val, head.breadth, medianBreadth);

        const trail = daily.map((d, i) => {
            const isHead = (i === totalDays - 1);
            // Scale radius: tail small, head large
            const progress = i / Math.max(totalDays - 1, 1);
            return {
                x: d.net_val,
                y: d.breadth,
                r: isHead ? 14 : 4 + progress * 8,
                date: d.date,
                broker: broker,
                isHead: isHead,
                total_val: d.total_val,
                buy_val: d.buy_val || 0,
                sell_val: d.sell_val || 0,
                dayIndex: i + 1,       // 1-based
                totalDays: totalDays,
            };
        });

        datasets.push({
            label: broker,
            data: trail,
            backgroundColor: trail.map((p, i) => {
                const alpha = p.isHead ? 0.75 : 0.15 + (i / totalDays) * 0.40;
                return quadrantColor(q, alpha);
            }),
            borderColor: 'transparent',
            borderWidth: 0,
            _quadrant: q,
            _broker: broker,
        });
    }

    // Destroy previous
    if (meteorBubbleChart) { meteorBubbleChart.destroy(); meteorBubbleChart = null; }
    $('#meteor-bubble-loading').hide();
    $('#meteor-bubble-container').show();

    const ctx = document.getElementById('meteor-bubble-chart').getContext('2d');

    // ── Plugin: trail lines with mid-segment arrows ──
    const trailLinePlugin = {
        id: 'meteorTrailLines',
        afterDatasetsDraw(chart) {
            const c = chart.ctx;
            c.save();
            for (let dsIdx = 0; dsIdx < chart.data.datasets.length; dsIdx++) {
                const meta = chart.getDatasetMeta(dsIdx);
                const ds = chart.data.datasets[dsIdx];
                if (!meta.visible || meta.data.length < 2) continue;

                // Use the head bubble's bg color for the trail
                const trailColor = Array.isArray(ds.backgroundColor)
                    ? ds.backgroundColor[ds.backgroundColor.length - 1]
                    : ds.backgroundColor;

                // Draw trail line
                c.beginPath();
                c.strokeStyle = trailColor;
                c.lineWidth = 2;
                c.globalAlpha = 0.55;
                c.setLineDash([]);
                meta.data.forEach((pt, i) => {
                    if (i === 0) c.moveTo(pt.x, pt.y);
                    else c.lineTo(pt.x, pt.y);
                });
                c.stroke();

                // Draw mid-segment arrow on each segment
                c.globalAlpha = 0.7;
                c.fillStyle = trailColor;
                const arrowLen = 5;
                for (let i = 0; i < meta.data.length - 1; i++) {
                    const from = meta.data[i];
                    const to   = meta.data[i + 1];
                    const mx = (from.x + to.x) / 2;
                    const my = (from.y + to.y) / 2;
                    const angle = Math.atan2(to.y - from.y, to.x - from.x);
                    c.beginPath();
                    c.moveTo(
                        mx + arrowLen * Math.cos(angle),
                        my + arrowLen * Math.sin(angle)
                    );
                    c.lineTo(
                        mx - arrowLen * Math.cos(angle - Math.PI / 5),
                        my - arrowLen * Math.sin(angle - Math.PI / 5)
                    );
                    c.lineTo(
                        mx - arrowLen * Math.cos(angle + Math.PI / 5),
                        my - arrowLen * Math.sin(angle + Math.PI / 5)
                    );
                    c.closePath();
                    c.fill();
                }
                c.globalAlpha = 1;
            }
            c.restore();
        }
    };

    // ── Plugin: labels on all bubbles + head broker ──
    const meteorLabelPlugin = {
        id: 'meteorLabels',
        afterDatasetsDraw(chart) {
            const c = chart.ctx;
            c.save();
            c.textAlign = 'center';
            c.fillStyle = labelCol;
            
            for (let dsIdx = 0; dsIdx < chart.data.datasets.length; dsIdx++) {
                const meta = chart.getDatasetMeta(dsIdx);
                const ds = chart.data.datasets[dsIdx];
                if (!meta.visible || meta.data.length === 0) continue;
                
                for (let i = 0; i < meta.data.length; i++) {
                    const pt = meta.data[i];
                    const raw = ds.data[i];
                    if (!pt || !raw) continue;
                    
                    const r = pt.options?.radius || raw.r || 4;
                    
                    // Above bubble: net_val (shortened)
                    c.font = '500 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                    c.textBaseline = 'bottom';
                    c.fillText(fmtValueShort(raw.x), pt.x, pt.y - r - 6);
                    
                    // Below bubble: date
                    c.font = '400 8px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                    c.textBaseline = 'top';
                    c.fillText(raw.date, pt.x, pt.y + r + 4);
                    
                    // Head bubble: show broker name above net_val
                    if (raw.isHead) {
                        c.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                        c.textBaseline = 'bottom';
                        c.fillText(raw.broker, pt.x, pt.y - r - 18);
                    }
                }
            }
            c.restore();
        }
    };

    // ── Plugin: crosshair at x=0 and y=medianBreadth ──
    const crosshairPlugin = {
        id: 'meteorCrosshair',
        afterDraw(chart) {
            const { ctx: c, chartArea: { left, right, top, bottom } } = chart;
            c.save();
            c.strokeStyle = zeroCol;
            c.lineWidth = 1;
            c.setLineDash([4, 4]);
            const xZero = chart.scales.x.getPixelForValue(0);
            if (xZero >= left && xZero <= right) {
                c.beginPath(); c.moveTo(xZero, top); c.lineTo(xZero, bottom); c.stroke();
            }
            const yMedian = chart.scales.y.getPixelForValue(medianBreadth);
            if (yMedian >= top && yMedian <= bottom) {
                c.beginPath(); c.moveTo(left, yMedian); c.lineTo(right, yMedian); c.stroke();
            }
            c.restore();
        }
    };

    // Compute Y-axis range from data to avoid wasted space
    let yMin = Infinity, yMax = -Infinity;
    for (const ds of datasets) {
        for (const pt of ds.data) {
            if (pt.y < yMin) yMin = pt.y;
            if (pt.y > yMax) yMax = pt.y;
        }
    }
    if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
    const yPad = Math.max((yMax - yMin) * 0.2, 5);
    const yAxisMin = Math.max(0, Math.floor(yMin - yPad));
    const yAxisMax = Math.ceil(yMax + yPad);

    meteorBubbleChart = new Chart(ctx, {
        type: 'bubble',
        data: { datasets },
        plugins: [trailLinePlugin, meteorLabelPlugin, crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 20, bottom: 10 } },
            scales: {
                x: {
                    title: { display: window.innerWidth >= 768, text: 'Daily Net Value (IDR)', color: textCol, font: { size: 11 } },
                    grid: { display: false },
                    border: { display: false },
                    ticks: { callback: v => fmtValue(v), color: textCol, font: { size: 10 } },
                },
                y: {
                    title: { display: window.innerWidth >= 768, text: 'Daily Breadth (Saham)', color: textCol, font: { size: 11 } },
                    grid: { display: false },
                    border: { display: false },
                    ticks: { color: textCol, font: { size: 10 } },
                    min: yAxisMin,
                    max: yAxisMax,
                }
            },
            plugins: {
                legend: { display: false },
                datalabels: false,
                tooltip: { enabled: false },
            },
            onClick: (_evt, elems) => {
                if (elems.length > 0) {
                    const dsIdx = elems[0].datasetIndex;
                    const broker = datasets[dsIdx]._broker;
                    $('#broker-search').val(broker).trigger('input');
                    document.getElementById('broker-table').scrollIntoView({ behavior: 'smooth' });
                }
            },
        }
    });

    console.log(`[broker-activity] Meteor chart: ${topBrokers.length} brokers, ${activeDays}D per-day trail`);
}

// ══════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════

$(function () {
    // ── Parse ?cache=rebuild ──
    const urlCacheParam = new URLSearchParams(window.location.search);
    if (urlCacheParam.get('cache') === 'rebuild') {
        forceRebuild = true;
        clearAllCaches();
        localStorage.removeItem(BROKERS_CACHE_KEY); // also refresh broker categories
        window.history.replaceState({}, '', window.location.pathname);
    }

    // ── Restore state from URL params ──
    readUrlParams();

    $('#loading-indicator').hide();
    $('#app').show();

    // ── Sync DOM to restored state ──
    syncDomToState();

    // Initial placeholder
    $('#tbody-broker').html(
        '<tr><td colspan="24" class="text-center text-muted py-4">' +
        '<i class="fa-solid fa-spinner fa-spin me-2"></i>Memuat data broker activity...' +
        '</td></tr>'
    );

    // ── Preset selector ──
    $('#preset-selector a').on('click', function (e) {
        e.preventDefault();
        $('#preset-selector a').removeClass('active');
        $(this).addClass('active');
        activePreset = $(this).data('preset');
        // Also sync category dropdown label
        $('#dd-category').text(`Category: ${activePreset === 'all' ? 'Any' : activePreset}`);
        // Clear individual broker selection so preset takes effect visually
        activeFilteredBrokers.clear();
        syncBrokerButtonState();
        if (allRows.length > 0) {
            applyFilters();
            pushUrlParams();
        } else {
            loadAllBrokers();
        }
    });

    // ── Filter dropdowns ──
    $(document).on('click', '[data-filter]', function (e) {
        e.preventDefault();
        const filter = $(this).data('filter');
        const val = $(this).data('val');
        const cvdLabels = { any: 'Any', up2: '▲▲ Accum', up1: '▲ Accum', neutral: '─ Neutral', down1: '▼ Distrib', down2: '▼▼ Distrib' };
        const netLabels = { any: 'Any', buy: 'Net Buy', sell: 'Net Sell' };
        // Update button label
        if      (filter === 'netdir')   $('#dd-netdir').text(`Net: ${netLabels[val] || val}`);
        else if (filter === 'quadrant') $('#dd-quadrant').text(`Quadrant: ${val === 'any' ? 'Any' : val}`);
        else if (filter === 'cvdtrend') $('#dd-cvdtrend').text(`CVD: ${cvdLabels[val] || val}`);
        else if (filter === 'category') {
            $('#dd-category').text(`Category: ${val === 'any' ? 'Any' : val}`);
            activePreset = val === 'any' ? 'all' : val;
            $('#preset-selector a').removeClass('active');
            $(`#preset-selector a[data-preset="${activePreset}"]`).addClass('active');
            activeFilteredBrokers.clear();
            syncBrokerButtonState();
        } else {
            $(`#dd-${filter}`).text(`${filter.charAt(0).toUpperCase() + filter.slice(1)}: ${val === 'any' ? 'Any' : val}`);
        }
        // Update state
        if (filter === 'netdir')   filterNetDir   = val;
        if (filter === 'quadrant') filterQuadrant = val;
        if (filter === 'cvdtrend') activeCvdTrend = val;
        applyFilters();
        pushUrlParams();
    });

    // ── Numeric filters (breadth, total value) ──
    $(document).on('input change', '.num-filter-input', function () {
        const nf = $(this).data('nf');
        const v = parseFloat($(this).val()) || 0;
        if (nf === 'breadth_min') {
            filterBreadthMin = v;
            $('#dd-breadth').text(v > 0 ? `Breadth: ≥${v}` : 'Breadth: Any');
        } else if (nf === 'totalval_min') {
            filterTotalValMin = v;
            $('#dd-totalval').text(v > 0 ? `Value: ≥${v}B` : 'Value: Any');
        }
        applyFilters();
        pushUrlParams();
    });

    // ── Timeframe selector ──
    $('#broker-range-selector a').on('click', function (e) {
        e.preventDefault();
        $('#broker-range-selector a').removeClass('active');
        $(this).addClass('active');
        activeDays = parseInt($(this).data('days')) || 1;
        // Reset broker filter when switching timeframe (different top brokers)
        activeFilteredBrokers.clear();
        $('#broker-btn-group').empty();
        loadAllBrokers();
        pushUrlParams();
    });

    // ── Search ──
    let searchTimer = null;
    $('#broker-search').on('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { applyFilters(); pushUrlParams(); }, 300);
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
        pushUrlParams();
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

    // ── Reset ALL filters (incl. broker + CVD trend) ──
    $('#btn-reset-filters').on('click', function (e) {
        e.preventDefault();
        activePreset      = 'all';
        filterNetDir      = 'any';
        filterBreadthMin  = 0;
        filterTotalValMin = 0;
        filterQuadrant    = 'any';
        activeCvdTrend    = 'any';
        activeFilteredBrokers.clear();
        $('#preset-selector a').removeClass('active');
        $('#preset-selector a[data-preset="all"]').addClass('active');
        $('#broker-search').val('');
        $('#dd-category').text('Category: Any');
        $('#dd-netdir').text('Net: Any');
        $('#dd-breadth').text('Breadth: Any');
        $('#dd-totalval').text('Value: Any');
        $('#dd-quadrant').text('Quadrant: Any');
        $('#dd-cvdtrend').text('CVD: Any');
        $('[data-nf]').val('');
        syncBrokerButtonState();
        applyFilters();
        pushUrlParams();
    });

    // ── Auto-load on page open ──
    loadAllBrokers();

    console.log('[broker-activity] v12 Initialized.');
});

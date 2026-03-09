/**
 * broker-detail.js — Broker Detail / Inventory Trailing Page
 * v7 — 2026-03-08
 *
 * Features:
 *   1. Cumulative net value trailing line chart (top N stocks)
 *   2. Accumulation Momentum Score (AMS) horizontal bar chart
 *   3. Holdings table with sort, avg buy/sell per transaction
 *   4. Persistent filters via URL params (survives refresh)
 *   5. Custom range filters for Net/Buy/Sell values
 *   6. Calendar-based accumulation streak
 *   7. Tooltips on all table headers
 *
 * Data source:
 *   GET /broker-activity/trailing?broker={code}&days=N
 *   GET /brokers  (broker name + category)
 */

'use strict';

// ── Config ──
const API_BASE = 'https://api-saham.mkemalw.workers.dev';

const LINE_COLORS = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
    '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
    '#d946ef', '#eab308', '#64748b', '#fb923c', '#2dd4bf'
];

if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ── State ──
let brokerCode = '';
let brokerInfo = null;
let currentDays = 10;
let currentTopN = 10;
let apiData = null;
let trailingChart = null;
let momentumChart = null;
let tableSortKey = 'total_net';
let tableSortDir = -1;
let focusStock = '';  // From ?stock= param — scroll+highlight this stock in the table

// Filters — persisted to URL params
const activeFilters = {
    net: 'any',          // any | buy | sell | custom
    net_min: null,       // in billions (only when net=custom)
    net_max: null,
    buyval: 'any',       // any | buy_only | custom
    buyval_min: null,
    buyval_max: null,
    sellval: 'any',      // any | sell_only | custom
    sellval_min: null,
    sellval_max: null,
    streak: 'any',       // any | acc2 | acc3 | dist2 | dist3
    ams: 'any',          // any | strong_acc | acc | dist | strong_dist
    days: 'any',         // any | 3 | 5
};

// ── Format Helpers ──
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

function fmtStreak(s) {
    if (!s || s === 0) return '<span class="text-muted">—</span>';
    const abs = Math.abs(s);
    const cls = s > 0 ? 'text-success' : 'text-danger';
    const icon = s > 0 ? '▲' : '▼';
    return `<span class="${cls}">${icon}${abs}d</span>`;
}

function stockLogo(code) {
    return `<img src="${API_BASE}/logo?ticker=${code}" alt="${code}" class="stock-logo" loading="lazy" onerror="this.style.display='none'"> `;
}

/**
 * Accumulation Momentum Score (AMS)
 *
 * Combines:
 *   1. MFI (Money Flow Index) — buy/sell pressure [0,100] → rescaled [-100,+100]
 *   2. EMA-weighted conviction — recent-biased daily conviction
 *   3. ROC acceleration — recent vs older period momentum change
 *
 * Final: 40% MFI + 40% EMA + 20% ROC → [-100, +100]
 */
function computeMomentumScore(series) {
    if (!series || series.length === 0) return 0;
    const n = series.length;

    let totalBuy = 0, totalSell = 0;
    for (const pt of series) {
        totalBuy += pt.buy_val;
        totalSell += pt.sell_val;
    }
    const mfRatio = totalSell > 0 ? totalBuy / totalSell : (totalBuy > 0 ? 10 : 1);
    const mfi = 100 - 100 / (1 + mfRatio);
    const mfiScore = (mfi - 50) * 2;

    const dailyConv = series.map(pt => {
        const total = pt.buy_val + pt.sell_val;
        return total > 0 ? pt.net_val / total : 0;
    });
    const alpha = 2 / (n + 1);
    let ema = dailyConv[0];
    for (let i = 1; i < n; i++) {
        ema = alpha * dailyConv[i] + (1 - alpha) * ema;
    }
    const emaScore = ema * 100;

    let roc = 0;
    if (n >= 3) {
        const third = Math.max(1, Math.floor(n / 3));
        const olderSlice = dailyConv.slice(0, third);
        const recentSlice = dailyConv.slice(n - third);
        const avgOlder = olderSlice.reduce((a, b) => a + b, 0) / olderSlice.length;
        const avgRecent = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
        roc = avgRecent - avgOlder;
    }
    const rocScore = Math.max(-100, Math.min(100, roc * 100));

    const composite = mfiScore * 0.4 + emaScore * 0.4 + rocScore * 0.2;
    return Math.max(-100, Math.min(100, composite));
}

/**
 * Accumulation Streak (calendar-day based)
 *
 * Counts consecutive recent TRADING days where the broker is actively
 * accumulating (net_val > 0) or distributing (net_val < 0).
 *
 * Uses the full dates array (calendar of all trading days in the period).
 * If the broker has no activity on a trading day → streak breaks.
 * "Bertahan" (just holding without new activity) does NOT count as streak.
 *
 * Returns: positive = accumulation streak, negative = distribution streak
 */
function computeStreak(series, dates) {
    if (!series || series.length === 0 || !dates || dates.length === 0) return 0;

    const dateNetMap = {};
    for (const pt of series) {
        dateNetMap[pt.date] = pt.net_val;
    }

    let streak = 0;
    let dir = 0;

    for (let i = dates.length - 1; i >= 0; i--) {
        const netVal = dateNetMap[dates[i]] || 0;

        if (netVal === 0) {
            if (streak === 0) continue; // Skip trailing inactive days to find first active
            break; // Active streak broken by inactivity
        }

        const d = netVal > 0 ? 1 : -1;

        if (streak === 0) {
            dir = d;
            streak = d;
        } else if (d === dir) {
            streak += dir;
        } else {
            break;
        }
    }

    return streak;
}

// ── URL State Persistence ──
function saveFiltersToURL() {
    const url = new URL(window.location);
    url.searchParams.set('kode', brokerCode);
    url.searchParams.set('days', currentDays);
    url.searchParams.set('topn', currentTopN);
    if (focusStock) url.searchParams.set('stock', focusStock);

    // Enum filters
    ['net', 'buyval', 'sellval', 'streak', 'ams', 'days'].forEach(k => {
        if (activeFilters[k] !== 'any') url.searchParams.set(`f_${k}`, activeFilters[k]);
        else url.searchParams.delete(`f_${k}`);
    });

    // Range filters (stored in billions)
    ['net_min', 'net_max', 'buyval_min', 'buyval_max', 'sellval_min', 'sellval_max'].forEach(k => {
        if (activeFilters[k] != null) url.searchParams.set(`f_${k}`, activeFilters[k]);
        else url.searchParams.delete(`f_${k}`);
    });

    history.replaceState(null, '', url.toString());
}

function restoreFiltersFromURL(params) {
    ['net', 'buyval', 'sellval', 'streak', 'ams', 'days'].forEach(k => {
        const v = params.get(`f_${k}`);
        if (v) activeFilters[k] = v;
    });

    ['net_min', 'net_max', 'buyval_min', 'buyval_max', 'sellval_min', 'sellval_max'].forEach(k => {
        const v = params.get(`f_${k}`);
        if (v != null && v !== '') activeFilters[k] = parseFloat(v);
    });
}

function restoreRangeInputs() {
    ['net', 'buyval', 'sellval'].forEach(key => {
        const minVal = activeFilters[`${key}_min`];
        const maxVal = activeFilters[`${key}_max`];
        if (minVal != null) $(`.range-input[data-rf="${key}_min"]`).val(minVal.toString());
        if (maxVal != null) $(`.range-input[data-rf="${key}_max"]`).val(maxVal.toString());
    });
}

// ── Init ──
$(document).ready(async function () {
    const params = new URLSearchParams(window.location.search);
    brokerCode = (params.get('kode') || params.get('broker') || '').toUpperCase();

    if (!brokerCode) {
        $('#loading-indicator').html('<p class="text-danger text-center mt-5">Broker code not provided. Use ?kode=XX</p>');
        return;
    }

    // Restore persisted state
    if (params.get('days')) currentDays = Math.max(1, Math.min(30, parseInt(params.get('days')) || 10));
    if (params.get('topn')) currentTopN = parseInt(params.get('topn')) || 10;
    focusStock = (params.get('stock') || '').toUpperCase();
    restoreFiltersFromURL(params);

    // Set header
    $('#header-title').text(brokerCode);
    document.title = `SSSAHAM - Broker ${brokerCode}`;

    // Fetch broker info
    try {
        const resp = await fetch(`${API_BASE}/brokers`);
        if (resp.ok) {
            const data = await resp.json();
            brokerInfo = (data.brokers || []).find(b => b.code === brokerCode) || null;
        }
    } catch (_) { }

    if (brokerInfo?.name) {
        const shortName = brokerInfo.name.replace(/ Sekuritas.*$/i, '').replace(/ Securities.*$/i, '');
        $('#header-title').text(`${brokerCode}: ${shortName}`);
        document.title = `SSSAHAM - ${brokerCode} ${shortName}`;
    }

    // Category badge
    const cat = (brokerInfo?.category || '').toLowerCase();
    const catMap = {
        'foreign': { text: 'Foreign', cls: 'bg-primary' },
        'local fund': { text: 'Local Fund', cls: 'bg-success' },
        'retail': { text: 'Retail', cls: 'bg-warning text-dark' },
    };
    const badge = catMap[cat] || { text: brokerInfo?.category || 'Unknown', cls: 'bg-secondary' };
    $('#broker-category-badge').text(badge.text).addClass(badge.cls);

    // Activate UI controls
    $(`#trailing-range-selector a`).removeClass('active');
    $(`#trailing-range-selector a[data-days="${currentDays}"]`).addClass('active');
    $(`#topn-selector a`).removeClass('active');
    $(`#topn-selector a[data-topn="${currentTopN}"]`).addClass('active');

    // Restore filter UI
    updateFilterButtons();
    restoreRangeInputs();

    // ── Event handlers ──

    // Timeframe selector
    $('#trailing-range-selector a').on('click', function (e) {
        e.preventDefault();
        const days = parseInt($(this).data('days'));
        if (days === currentDays) return;
        currentDays = days;
        $('#trailing-range-selector a').removeClass('active');
        $(this).addClass('active');
        saveFiltersToURL();
        loadData();
    });

    // TopN selector
    $('#topn-selector a').on('click', function (e) {
        e.preventDefault();
        const topn = parseInt($(this).data('topn'));
        if (topn === currentTopN) return;
        currentTopN = topn;
        $('#topn-selector a').removeClass('active');
        $(this).addClass('active');
        saveFiltersToURL();
        renderCharts();
    });

    // Table sorting
    $('#holdings-table thead th[data-sort]').on('click', function () {
        const key = $(this).data('sort');
        if (tableSortKey === key) tableSortDir *= -1;
        else { tableSortKey = key; tableSortDir = -1; }
        renderCharts();
        renderTable();
    });

    // Filter dropdown items (presets)
    $(document).on('click', '#filter-row .dropdown-item[data-filter]', function (e) {
        e.preventDefault();
        const key = $(this).data('filter');
        const val = $(this).data('val');
        activeFilters[key] = val;

        // Clear custom range if selecting a preset
        if (['net', 'buyval', 'sellval'].includes(key)) {
            activeFilters[`${key}_min`] = null;
            activeFilters[`${key}_max`] = null;
            $(`.range-input[data-rf="${key}_min"]`).val('');
            $(`.range-input[data-rf="${key}_max"]`).val('');
        }

        // Close dropdown manually (needed with data-bs-auto-close="outside")
        $(this).closest('.dropdown-menu').parent().find('.dropdown-toggle').dropdown('hide');

        updateFilterButtons();
        saveFiltersToURL();
        renderCharts();
        renderTable();
    });

    // Range filter apply
    $(document).on('click', '.range-apply', function () {
        const key = $(this).data('rf-key');
        const minInput = $(`.range-input[data-rf="${key}_min"]`).val().trim();
        const maxInput = $(`.range-input[data-rf="${key}_max"]`).val().trim();

        const minVal = minInput !== '' ? parseFloat(minInput) : null;
        const maxVal = maxInput !== '' ? parseFloat(maxInput) : null;

        if (minVal == null && maxVal == null) return;

        activeFilters[key] = 'custom';
        activeFilters[`${key}_min`] = minVal;
        activeFilters[`${key}_max`] = maxVal;

        updateFilterButtons();
        saveFiltersToURL();
        renderCharts();
        renderTable();

        $(this).closest('.dropdown-menu').parent().find('.dropdown-toggle').dropdown('hide');
    });

    // Enter key in range inputs
    $(document).on('keydown', '.range-input', function (e) {
        if (e.key === 'Enter') {
            $(this).closest('.dropdown-menu').find('.range-apply').click();
        }
    });

    // Reset all filters
    $('#btn-filter-reset').on('click', function () {
        Object.keys(activeFilters).forEach(k => {
            if (k.endsWith('_min') || k.endsWith('_max')) activeFilters[k] = null;
            else activeFilters[k] = 'any';
        });
        $('.range-input').val('');
        updateFilterButtons();
        saveFiltersToURL();
        renderCharts();
        renderTable();
    });

    loadData();
});

// ── Filter UI ──
function updateFilterButtons() {
    const labelMap = {
        net:     { any: 'Net: Any', buy: 'Net: Buy', sell: 'Net: Sell' },
        buyval:  { any: 'Buy: Any', buy_only: 'Buy Only (0 Sell)' },
        sellval: { any: 'Sell: Any', sell_only: 'Sell Only (0 Buy)' },
        streak:  { any: 'Streak: Any', acc2: 'Streak: Acc≥2d', acc3: 'Streak: Acc≥3d', dist2: 'Streak: Dist≥2d', dist3: 'Streak: Dist≥3d' },
        ams:     { any: 'AMS: Any', strong_acc: 'AMS: Strong Acc', acc: 'AMS: Acc', dist: 'AMS: Dist', strong_dist: 'AMS: Strong Dist' },
        days:    { any: 'Active: Any', '3': 'Active: ≥3', '5': 'Active: ≥5' },
    };

    Object.keys(labelMap).forEach(key => {
        const val = activeFilters[key];
        const btn = $(`#dd-${key}`);
        if (!btn.length) return;

        if (val === 'custom') {
            const minV = activeFilters[`${key}_min`];
            const maxV = activeFilters[`${key}_max`];
            const base = key === 'net' ? 'Net' : key === 'buyval' ? 'Buy' : 'Sell';
            if (minV != null && maxV != null) {
                btn.text(`${base}: ${fmtValue(minV * 1e9)}–${fmtValue(maxV * 1e9)}`);
            } else if (minV != null) {
                btn.text(`${base}: ≥${fmtValue(minV * 1e9)}`);
            } else if (maxV != null) {
                btn.text(`${base}: ≤${fmtValue(maxV * 1e9)}`);
            }
        } else {
            btn.text((labelMap[key] || {})[val] || `${key}: ${val}`);
        }

        btn.toggleClass('active-filter', val !== 'any');
    });

    const hasActive = Object.keys(activeFilters).some(k => {
        if (k.endsWith('_min') || k.endsWith('_max')) return activeFilters[k] != null;
        return activeFilters[k] !== 'any';
    });
    $('#btn-filter-reset').toggle(hasActive);
}

function applyFilters(stocks) {
    return stocks.filter(s => {
        // Net
        if (activeFilters.net === 'buy' && s.total_net <= 0) return false;
        if (activeFilters.net === 'sell' && s.total_net >= 0) return false;
        if (activeFilters.net === 'custom') {
            if (activeFilters.net_min != null && s.total_net < activeFilters.net_min * 1e9) return false;
            if (activeFilters.net_max != null && s.total_net > activeFilters.net_max * 1e9) return false;
        }

        // Buy Val
        if (activeFilters.buyval === 'buy_only' && (s.total_buy <= 0 || s.total_sell > 0)) return false;
        if (activeFilters.buyval === 'custom') {
            if (activeFilters.buyval_min != null && s.total_buy < activeFilters.buyval_min * 1e9) return false;
            if (activeFilters.buyval_max != null && s.total_buy > activeFilters.buyval_max * 1e9) return false;
        }

        // Sell Val
        if (activeFilters.sellval === 'sell_only' && (s.total_sell <= 0 || s.total_buy > 0)) return false;
        if (activeFilters.sellval === 'custom') {
            if (activeFilters.sellval_min != null && s.total_sell < activeFilters.sellval_min * 1e9) return false;
            if (activeFilters.sellval_max != null && s.total_sell > activeFilters.sellval_max * 1e9) return false;
        }

        // Streak
        const sf = activeFilters.streak;
        if (sf === 'acc2' && s.streak < 2) return false;
        if (sf === 'acc3' && s.streak < 3) return false;
        if (sf === 'dist2' && s.streak > -2) return false;
        if (sf === 'dist3' && s.streak > -3) return false;

        // AMS
        const af = activeFilters.ams;
        if (af === 'strong_acc' && s.momentum < 30) return false;
        if (af === 'acc' && s.momentum < 10) return false;
        if (af === 'dist' && s.momentum > -10) return false;
        if (af === 'strong_dist' && s.momentum > -30) return false;

        // Days active
        const df = activeFilters.days;
        if (df === '3' && s.days_active < 3) return false;
        if (df === '5' && s.days_active < 5) return false;

        return true;
    });
}

// ── Data Loading ──
async function loadData() {
    $('#loading-indicator').show();
    $('#app').hide();
    $('#trailing-chart-loading').show();
    $('#trailing-chart-container').hide();

    try {
        const resp = await fetch(`${API_BASE}/broker-activity/trailing?broker=${brokerCode}&days=${currentDays}`);
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        apiData = await resp.json();
        if (!apiData.ok) throw new Error(apiData.error || 'API error');
    } catch (err) {
        console.error('Load error:', err);
        $('#loading-indicator').html(`<p class="text-danger text-center mt-5">Error: ${err.message}</p>`);
        return;
    }

    $('#loading-indicator').hide();
    $('#app').show();

    renderSummary();
    renderCharts();
    renderTable();
}

// ── Summary ──
function renderSummary() {
    if (!apiData) return;
    const summary = apiData.stock_summary || [];
    let netVal = 0, buyVal = 0, sellVal = 0;
    for (const s of summary) {
        netVal += s.total_net;
        buyVal += s.total_buy;
        sellVal += s.total_sell;
    }

    $('#stat-net-val').text(fmtValue(netVal)).removeClass('text-success text-danger').addClass(netClass(netVal));
    $('#stat-buy-val').text(fmtValue(buyVal)).addClass('text-success');
    $('#stat-sell-val').text(fmtValue(sellVal)).addClass('text-danger');
    $('#stat-breadth').text(summary.length);
    $('#stat-days').text(apiData.dates?.length || 0);
    $('#stat-total-val').text(fmtValue(buyVal + sellVal));
}

// ── Charts ──
function renderCharts() {
    renderTrailingChart();
    renderMomentumChart();
}

function getTopStocks(n) {
    if (!apiData?.stock_summary) return [];
    const dates = apiData.dates || [];

    const enriched = apiData.stock_summary.map(s => {
        const series = apiData.series[s.stock_code] || [];

        // Accumulation streak (calendar-day based)
        const streak = computeStreak(series, dates);

        // Momentum score
        const momentum = computeMomentumScore(series);

        // Average per transaction
        let totalBuyFreq = 0, totalSellFreq = 0;
        for (const pt of series) {
            totalBuyFreq += pt.buy_freq || 0;
            totalSellFreq += pt.sell_freq || 0;
        }
        const avg_buy_tx = totalBuyFreq > 0 ? s.total_buy / totalBuyFreq : 0;
        const avg_sell_tx = totalSellFreq > 0 ? s.total_sell / totalSellFreq : 0;

        return { ...s, streak, momentum, avg_buy_tx, avg_sell_tx };
    });

    // Sort
    enriched.sort((a, b) => {
        let va = a[tableSortKey], vb = b[tableSortKey];
        if (tableSortKey === 'stock_code') return tableSortDir * va.localeCompare(vb);
        if (tableSortKey === 'total_net') return tableSortDir * (Math.abs(vb) - Math.abs(va)) || (vb - va);
        return tableSortDir * ((vb || 0) - (va || 0));
    });

    const filtered = applyFilters(enriched);
    if (n <= 0 || n >= filtered.length) return filtered;
    return filtered.slice(0, n);
}

function renderTrailingChart() {
    const topStocks = getTopStocks(currentTopN);
    const dates = apiData?.dates || [];

    if (topStocks.length === 0 || dates.length === 0) {
        $('#trailing-chart-loading').html('<span class="small text-muted">No data available</span>').show();
        $('#trailing-chart-container').hide();
        return;
    }

    $('#trailing-chart-loading').hide();
    $('#trailing-chart-container').show();

    const datasets = topStocks.map((stock, idx) => {
        const series = apiData.series[stock.stock_code] || [];
        const dateMap = {};
        for (const pt of series) dateMap[pt.date] = pt.cumulative_net;
        const data = [];
        let lastVal = 0;
        for (const d of dates) {
            if (dateMap[d] !== undefined) lastVal = dateMap[d];
            data.push(lastVal);
        }
        const color = LINE_COLORS[idx % LINE_COLORS.length];
        return {
            label: stock.stock_code,
            data,
            borderColor: color,
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: color,
            tension: 0,
            fill: false,
        };
    });

    const labels = dates.map(d => {
        const p = d.split('-');
        return `${p[1]}/${p[2]}`;
    });

    const isMobile = window.innerWidth < 768;
    const lastIdx = dates.length - 1;

    if (trailingChart) trailingChart.destroy();
    const ctx = document.getElementById('trailing-chart').getContext('2d');
    trailingChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            layout: { padding: { right: isMobile ? 40 : 60 } },
            plugins: {
                legend: { display: false },
                datalabels: {
                    display: true,
                    color: function (ctx) { return ctx.dataset.borderColor; },
                    font: { size: isMobile ? 8 : 10, weight: '600' },
                    anchor: function (ctx) {
                        return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'end' : 'start';
                    },
                    align: function (ctx) {
                        return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'top' : 'bottom';
                    },
                    clip: false,
                    formatter: function (value, ctx) {
                        const label = fmtValueShort(value);
                        return ctx.dataIndex === lastIdx ? ctx.dataset.label + ' ' + label : label;
                    },
                },
                tooltip: { enabled: false },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#94a3b8',
                        font: { size: isMobile ? 9 : 11 },
                        maxRotation: 45,
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: {
                        color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#94a3b8',
                        font: { size: isMobile ? 9 : 11 },
                        callback: function (v) { return fmtValueShort(v); },
                    },
                    title: {
                        display: !isMobile,
                        text: 'Cumulative Net Value',
                        color: '#94a3b8',
                        font: { size: 11 },
                    }
                }
            }
        }
    });
}

function renderMomentumChart() {
    const topStocks = getTopStocks(currentTopN);
    if (topStocks.length === 0) return;

    const scored = topStocks.map(s => {
        const series = apiData.series[s.stock_code] || [];
        return { ...s, momentum: computeMomentumScore(series) };
    });
    scored.sort((a, b) => b.momentum - a.momentum);

    const labels = scored.map(s => s.stock_code);
    const values = scored.map(s => s.momentum);

    function scoreColor(v, alpha) {
        if (v >= 0) {
            const t = Math.min(v / 60, 1);
            return `rgba(34,${Math.round(140 + t * 57)},94,${alpha})`;
        }
        const t = Math.min(Math.abs(v) / 60, 1);
        return `rgba(${Math.round(200 + t * 39)},68,68,${alpha})`;
    }

    const isMobile = window.innerWidth < 768;
    const barHeight = isMobile ? 24 : 30;
    $('#diverging-chart-container').css('height', Math.max(200, scored.length * barHeight + 60) + 'px');

    if (momentumChart) momentumChart.destroy();
    const ctx = document.getElementById('diverging-chart').getContext('2d');
    momentumChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: values.map(v => scoreColor(v, 0.75)),
                borderColor: values.map(v => scoreColor(v, 1)),
                borderWidth: 1,
                borderRadius: 3,
                barThickness: isMobile ? 18 : 24,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: {
                    display: true,
                    anchor: function (ctx) {
                        return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'end' : 'start';
                    },
                    align: function (ctx) {
                        return ctx.dataset.data[ctx.dataIndex] >= 0 ? 'right' : 'left';
                    },
                    color: function (ctx) {
                        return ctx.dataset.data[ctx.dataIndex] >= 0 ? '#22c55e' : '#ef4444';
                    },
                    font: { size: isMobile ? 9 : 11, weight: '600' },
                    formatter: function (v) {
                        const sign = v >= 0 ? '+' : '';
                        return Math.abs(v) >= 1 ? sign + v.toFixed(0) : sign + v.toFixed(1);
                    },
                    clip: false,
                },
                tooltip: {
                    callbacks: {
                        title: function (ctx) { return ctx[0]?.label || ''; },
                        label: function (ctx) {
                            const s = scored[ctx.dataIndex];
                            const x = parseFloat(ctx.parsed.x.toFixed(2));
                            return [
                                `Momentum: ${x >= 0 ? '+' : ''}${x}`,
                                `Net: ${fmtValue(s.total_net)}`,
                                `Buy: ${fmtValue(s.total_buy)}  Sell: ${fmtValue(s.total_sell)}`,
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: isMobile ? 9 : 11 },
                        callback: function (v) {
                            const r = parseFloat(v.toFixed(2));
                            return (r >= 0 ? '+' : '') + r;
                        },
                    },
                    title: {
                        display: !isMobile,
                        text: 'Accumulation Momentum Score',
                        color: '#94a3b8',
                        font: { size: 11 },
                    }
                },
                y: {
                    grid: { display: false },
                    ticks: {
                        color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e2e8f0',
                        font: { size: isMobile ? 10 : 12, weight: '600' },
                    }
                }
            }
        }
    });
}

// ── Holdings Table ──
function renderTable() {
    if (!apiData?.stock_summary) return;

    const enriched = getTopStocks(0);

    function fmtMomentum(m) {
        if (!Number.isFinite(m) || m === 0) return '<span class="text-muted">—</span>';
        const sign = m >= 0 ? '+' : '';
        const cls = m >= 30 ? 'text-success fw-bold' : m >= 10 ? 'text-success'
                  : m <= -30 ? 'text-danger fw-bold' : m <= -10 ? 'text-danger' : 'text-muted';
        return `<span class="${cls}">${sign}${m.toFixed(0)}</span>`;
    }

    let html = '';
    enriched.forEach((s, i) => {
        const isFocused = focusStock && s.stock_code === focusStock;
        html += `<tr data-stock="${s.stock_code}" ${isFocused ? 'class="table-active"' : ''}>
            <td class="text-center">${i + 1}</td>
            <td class="fw-semibold">
                ${stockLogo(s.stock_code)}
                <a href="/idx/emiten/broker-summary.html?kode=${s.stock_code}" class="text-decoration-none">${s.stock_code}</a>
            </td>
            <td class="text-end ${netClass(s.total_net)}">${fmtValue(s.total_net)}</td>
            <td class="text-end">${fmtValue(s.total_buy)}</td>
            <td class="text-end">${fmtValue(s.total_sell)}</td>
            <td class="text-end hide-mobile">${fmtValue(s.avg_buy_tx)}</td>
            <td class="text-end hide-mobile">${fmtValue(s.avg_sell_tx)}</td>
            <td class="text-center hide-mobile">${s.days_active}</td>
            <td class="text-center hide-mobile">${fmtStreak(s.streak)}</td>
            <td class="text-center hide-mobile">${fmtMomentum(s.momentum)}</td>
        </tr>`;
    });

    $('#tbody-holdings').html(html);
    $('#holdings-count').text(`${enriched.length} stocks`);

    // Auto-scroll to focused stock (from ?stock= param)
    if (focusStock) {
        const $focusRow = $(`#tbody-holdings tr[data-stock="${focusStock}"]`);
        if ($focusRow.length) {
            setTimeout(() => {
                $focusRow[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Pulse animation
                $focusRow.css({
                    'animation': 'focusPulse 2s ease-out',
                    'box-shadow': '0 0 0 2px rgba(13, 202, 240, 0.6)'
                });
                setTimeout(() => {
                    $focusRow.css({ 'animation': '', 'box-shadow': '' });
                }, 2500);
            }, 300);
        }
    }
}

/**
 * broker-detail.js — Broker Detail / Inventory Trailing Page
 * v2 — 2026-03-08
 *
 * Shows:
 *   1. Cumulative net value trailing line chart (top N stocks, value at each node, name at endpoint)
 *   2. Accumulation Momentum Score horizontal bar chart
 *   3. Holdings table with sort
 *
 * Data source:
 *   GET /broker-activity/trailing?broker={code}&days=N
 *   GET /brokers  (for broker name + category)
 */

'use strict';

// ── Config ──
const API_BASE = 'https://api-saham.mkemalw.workers.dev';

// Chart color palette for line chart (distinct, readable on dark bg)
const LINE_COLORS = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
    '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
    '#d946ef', '#eab308', '#64748b', '#fb923c', '#2dd4bf'
];

// Register chartjs-plugin-datalabels globally
if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

// ── State ──
let brokerCode = '';
let brokerInfo = null;       // { code, name, category, character } from /brokers
let currentDays = 10;
let currentTopN = 10;
let apiData = null;          // raw API response
let trailingChart = null;
let momentumChart = null;
let tableSortKey = 'total_net';
let tableSortDir = -1;       // -1 = desc

// Active filters
const activeFilters = {
    net: 'any',     // any | buy | sell
    streak: 'any',  // any | buy2 | buy3 | sell2 | sell3
    ams: 'any',     // any | strong_acc | acc | dist | strong_dist
    days: 'any',    // any | 3 | 5
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

/**
 * Accumulation Momentum Score (AMS)
 *
 * Industry-standard approach combining:
 *   1. Money Flow Index (MFI) — volume-weighted buy/sell pressure → [0, 100]
 *      Adapted: MFI = 100 - 100/(1 + MoneyFlowRatio)
 *      where MoneyFlowRatio = Σ(buy_val) / Σ(sell_val)
 *      Rescaled to [-100, +100]: AMS_base = (MFI - 50) * 2
 *
 *   2. EMA-weighted direction — exponential moving average gives
 *      more weight to recent data (decay factor α = 2/(n+1))
 *
 *   3. Rate of Change (ROC) acceleration — compares recent vs older
 *      period conviction to detect momentum buildup
 *
 * Final score: [-100, +100]
 *   > 0  = accumulation pressure (green)
 *   < 0  = distribution pressure (red)
 */
function computeMomentumScore(series) {
    if (!series || series.length === 0) return 0;
    const n = series.length;

    // ── 1. Volume-weighted Money Flow Index (MFI) ──
    let totalBuy = 0, totalSell = 0;
    for (const pt of series) {
        totalBuy += pt.buy_val;
        totalSell += pt.sell_val;
    }
    // MFI: 0..100, then rescale to -100..+100
    const mfRatio = totalSell > 0 ? totalBuy / totalSell : (totalBuy > 0 ? 10 : 1);
    const mfi = 100 - 100 / (1 + mfRatio); // 0..100
    const mfiScore = (mfi - 50) * 2;        // -100..+100

    // ── 2. EMA-weighted daily conviction ──
    // Daily conviction: net / total, range [-1, 1]
    const dailyConv = series.map(pt => {
        const total = pt.buy_val + pt.sell_val;
        return total > 0 ? pt.net_val / total : 0;
    });
    // EMA with α = 2/(n+1)
    const alpha = 2 / (n + 1);
    let ema = dailyConv[0];
    for (let i = 1; i < n; i++) {
        ema = alpha * dailyConv[i] + (1 - alpha) * ema;
    }
    const emaScore = ema * 100; // -100..+100

    // ── 3. Rate of Change (ROC) acceleration ──
    // Compare EMA of recent third vs older third
    let roc = 0;
    if (n >= 3) {
        const third = Math.max(1, Math.floor(n / 3));
        const olderSlice = dailyConv.slice(0, third);
        const recentSlice = dailyConv.slice(n - third);
        const avgOlder = olderSlice.reduce((a, b) => a + b, 0) / olderSlice.length;
        const avgRecent = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
        roc = (avgRecent - avgOlder); // -2..+2 range
    }
    const rocScore = Math.max(-100, Math.min(100, roc * 100));

    // ── Composite: 40% MFI + 40% EMA + 20% ROC ──
    const composite = mfiScore * 0.4 + emaScore * 0.4 + rocScore * 0.2;
    return Math.max(-100, Math.min(100, composite));
}

function fmtStreak(s) {
    if (!s || s === 0) return '<span class="text-muted">—</span>';
    const abs = Math.abs(s);
    const cls = s > 0 ? 'text-success' : 'text-danger';
    const icon = s > 0 ? '▲' : '▼';
    return `<span class="${cls}">${icon}${abs}</span>`;
}

function stockLogo(code) {
    return `<img src="${API_BASE}/logo?ticker=${code}" alt="${code}" class="stock-logo" loading="lazy" onerror="this.style.display='none'"> `;
}

// ── Init ──
$(document).ready(async function () {
    const params = new URLSearchParams(window.location.search);
    brokerCode = (params.get('kode') || params.get('broker') || '').toUpperCase();

    if (!brokerCode) {
        $('#loading-indicator').html('<p class="text-danger text-center mt-5">Broker code not provided. Use ?kode=XX</p>');
        return;
    }

    // Set initial header (code only, name will be updated after API call)
    $('#broker-code').text(brokerCode);
    $('#header-title').text(brokerCode);
    document.title = `SSSAHAM - Broker ${brokerCode}`;
    $('#broker-logo').attr('src', `${API_BASE}/broker/logo/${brokerCode}`);

    // Fetch broker info (name + category) from /brokers API
    try {
        const resp = await fetch(`${API_BASE}/brokers`);
        if (resp.ok) {
            const data = await resp.json();
            const list = data.brokers || [];
            brokerInfo = list.find(b => b.code === brokerCode) || null;
        }
    } catch (_) { /* non-critical */ }

    // Update header with broker name
    if (brokerInfo?.name) {
        const shortName = brokerInfo.name.replace(/ Sekuritas.*$/i, '').replace(/ Securities.*$/i, '');
        $('#broker-code').text(brokerCode);
        $('#broker-name').text(shortName);
        $('#header-title').text(`${brokerCode}: ${shortName}`);
        document.title = `SSSAHAM - ${brokerCode} ${shortName}`;
    }

    // Category badge from API data
    const cat = (brokerInfo?.category || '').toLowerCase();
    const catMap = {
        'foreign': { text: 'Foreign', cls: 'bg-primary' },
        'local fund': { text: 'Local Fund', cls: 'bg-success' },
        'retail': { text: 'Retail', cls: 'bg-warning text-dark' },
    };
    const badge = catMap[cat] || { text: brokerInfo?.category || 'Unknown', cls: 'bg-secondary' };
    $('#broker-category-badge').text(badge.text).addClass(badge.cls);

    // Parse URL state
    if (params.get('days')) currentDays = Math.max(1, Math.min(30, parseInt(params.get('days')) || 10));
    if (params.get('topn')) currentTopN = parseInt(params.get('topn')) || 5;

    // Activate correct timeframe button
    $(`#trailing-range-selector a`).removeClass('active');
    $(`#trailing-range-selector a[data-days="${currentDays}"]`).addClass('active');

    // Activate correct TopN button
    $(`#topn-selector a`).removeClass('active');
    $(`#topn-selector a[data-topn="${currentTopN}"]`).addClass('active');

    // Timeframe selector
    $('#trailing-range-selector a').on('click', function (e) {
        e.preventDefault();
        const days = parseInt($(this).data('days'));
        if (days === currentDays) return;
        currentDays = days;
        $('#trailing-range-selector a').removeClass('active');
        $(this).addClass('active');
        updateURL();
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
        updateURL();
        renderCharts();
    });

    // Table sorting — also re-renders charts to stay in sync
    $('#holdings-table thead th[data-sort]').on('click', function () {
        const key = $(this).data('sort');
        if (tableSortKey === key) tableSortDir *= -1;
        else { tableSortKey = key; tableSortDir = -1; }
        renderCharts();
        renderTable();
    });

    // ── Filter handlers ──
    $(document).on('click', '#filter-row .dropdown-item[data-filter]', function (e) {
        e.preventDefault();
        const key = $(this).data('filter');
        const val = $(this).data('val');
        activeFilters[key] = val;
        updateFilterButtons();
        renderCharts();
        renderTable();
    });

    $('#btn-filter-reset').on('click', function () {
        Object.keys(activeFilters).forEach(k => activeFilters[k] = 'any');
        updateFilterButtons();
        renderCharts();
        renderTable();
    });

    loadData();
});

function updateURL() {
    const url = new URL(window.location);
    url.searchParams.set('kode', brokerCode);
    url.searchParams.set('days', currentDays);
    url.searchParams.set('topn', currentTopN);
    history.replaceState(null, '', url.toString());
}

// ── Filter UI ──
function updateFilterButtons() {
    const labelMap = {
        net: { any: 'Net: Any', buy: 'Net: Buy', sell: 'Net: Sell' },
        streak: { any: 'Streak: Any', buy2: 'Streak: Buy≥2', buy3: 'Streak: Buy≥3', sell2: 'Streak: Sell≥2', sell3: 'Streak: Sell≥3' },
        ams: { any: 'AMS: Any', strong_acc: 'AMS: Strong Acc', acc: 'AMS: Acc', dist: 'AMS: Dist', strong_dist: 'AMS: Strong Dist' },
        days: { any: 'Days: Any', '3': 'Days: ≥3', '5': 'Days: ≥5' },
    };
    Object.keys(activeFilters).forEach(key => {
        const val = activeFilters[key];
        const btn = $(`#dd-${key === 'days' ? 'days' : key}`);
        const map = labelMap[key] || {};
        btn.text(map[val] || `${key}: ${val}`);
        btn.toggleClass('active-filter', val !== 'any');
    });
    // Show/hide reset button
    const hasActive = Object.values(activeFilters).some(v => v !== 'any');
    $('#btn-filter-reset').toggle(hasActive);
}

function applyFilters(stocks) {
    return stocks.filter(s => {
        // Net direction
        if (activeFilters.net === 'buy' && s.total_net <= 0) return false;
        if (activeFilters.net === 'sell' && s.total_net >= 0) return false;

        // Streak
        const sf = activeFilters.streak;
        if (sf === 'buy2' && s.streak < 2) return false;
        if (sf === 'buy3' && s.streak < 3) return false;
        if (sf === 'sell2' && s.streak > -2) return false;
        if (sf === 'sell3' && s.streak > -3) return false;

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

// ── Summary Stats ──
function renderSummary() {
    if (!apiData) return;
    const summary = apiData.stock_summary || [];
    let netVal = 0, buyVal = 0, sellVal = 0;
    for (const s of summary) {
        netVal += s.total_net;
        buyVal += s.total_buy;
        sellVal += s.total_sell;
    }
    const totalVal = buyVal + sellVal;

    $('#stat-net-val').text(fmtValue(netVal)).removeClass('text-success text-danger').addClass(netClass(netVal));
    $('#stat-buy-val').text(fmtValue(buyVal)).addClass('text-success');
    $('#stat-sell-val').text(fmtValue(sellVal)).addClass('text-danger');
    $('#stat-breadth').text(summary.length);
    $('#stat-days').text(apiData.dates?.length || 0);
    $('#stat-total-val').text(fmtValue(totalVal));
}

// ── Charts ──
function renderCharts() {
    renderTrailingChart();
    renderMomentumChart();
}

function getTopStocks(n) {
    if (!apiData?.stock_summary) return [];
    // Enrich with momentum + streak so we can sort by any key
    const enriched = apiData.stock_summary.map(s => {
        const series = apiData.series[s.stock_code] || [];
        let streak = 0;
        if (series.length > 0) {
            const last = series[series.length - 1];
            const dir = last.net_val > 0 ? 1 : last.net_val < 0 ? -1 : 0;
            if (dir !== 0) {
                streak = dir;
                for (let i = series.length - 2; i >= 0; i--) {
                    const d = series[i].net_val > 0 ? 1 : series[i].net_val < 0 ? -1 : 0;
                    if (d === dir) streak += dir;
                    else break;
                }
            }
        }
        const momentum = computeMomentumScore(series);
        return { ...s, streak, momentum };
    });
    // Sort using same key/direction as table
    enriched.sort((a, b) => {
        let va = a[tableSortKey], vb = b[tableSortKey];
        if (tableSortKey === 'stock_code') {
            return tableSortDir * va.localeCompare(vb);
        }
        if (tableSortKey === 'total_net') {
            return tableSortDir * (Math.abs(vb) - Math.abs(va)) || (vb - va);
        }
        return tableSortDir * ((vb || 0) - (va || 0));
    });
    // Apply active filters
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
        // Build a map: date → cumulative_net
        const dateMap = {};
        for (const pt of series) {
            dateMap[pt.date] = pt.cumulative_net;
        }
        // Fill in gaps with last known value
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

    // Format dates for labels: "03/04" style
    const labels = dates.map(d => {
        const parts = d.split('-');
        return `${parts[1]}/${parts[2]}`;
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
            interaction: {
                mode: 'index',
                intersect: false,
            },
            layout: {
                padding: { right: isMobile ? 40 : 60 }
            },
            plugins: {
                legend: {
                    display: false,  // legend off — stock name shown at end of line
                },
                datalabels: {
                    display: true,
                    color: function (ctx) {
                        return ctx.dataset.borderColor;
                    },
                    font: { size: isMobile ? 8 : 10, weight: '600' },
                    anchor: function (ctx) {
                        const val = ctx.dataset.data[ctx.dataIndex];
                        return val >= 0 ? 'end' : 'start';
                    },
                    align: function (ctx) {
                        const val = ctx.dataset.data[ctx.dataIndex];
                        return val >= 0 ? 'top' : 'bottom';
                    },
                    clip: false,
                    formatter: function (value, ctx) {
                        const isLast = ctx.dataIndex === lastIdx;
                        const label = fmtValueShort(value);
                        if (isLast) {
                            return ctx.dataset.label + ' ' + label;
                        }
                        return label;
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
                        callback: v => fmtValueShort(v),
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

/**
 * Momentum Score Bar Chart
 *
 * Sorted by Accumulation Momentum Score (AMS) — highest accumulation at top.
 * Color gradient: green (accumulating) → red (distributing)
 * Score considers: conviction + recency-weighted acceleration + volume intensity
 */
function renderMomentumChart() {
    const topStocks = getTopStocks(currentTopN);
    if (topStocks.length === 0) return;

    // Compute momentum score for each stock
    const scored = topStocks.map(s => {
        const series = apiData.series[s.stock_code] || [];
        const score = computeMomentumScore(series);
        return { ...s, momentum: score };
    });

    // Sort by momentum score descending (highest accumulation at top)
    scored.sort((a, b) => b.momentum - a.momentum);

    const labels = scored.map(s => s.stock_code);
    const values = scored.map(s => s.momentum);

    // Color gradient: interpolate green↔red based on score
    function scoreColor(v, alpha) {
        if (v >= 0) {
            const t = Math.min(v / 60, 1); // 0..1 for green intensity
            const g = Math.round(140 + t * 57);  // 140..197
            return `rgba(34,${g},94,${alpha})`;
        } else {
            const t = Math.min(Math.abs(v) / 60, 1);
            const r = Math.round(200 + t * 39);  // 200..239
            return `rgba(${r},68,68,${alpha})`;
        }
    }
    const bgColors = values.map(v => scoreColor(v, 0.75));
    const borderColors = values.map(v => scoreColor(v, 1));

    const isMobile = window.innerWidth < 768;

    // Dynamic height
    const barHeight = isMobile ? 24 : 30;
    const minHeight = 200;
    const chartHeight = Math.max(minHeight, scored.length * barHeight + 60);
    $('#diverging-chart-container').css('height', chartHeight + 'px');

    if (momentumChart) momentumChart.destroy();
    const ctx = document.getElementById('diverging-chart').getContext('2d');
    momentumChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: borderColors,
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
                        if (Math.abs(v) >= 1) return sign + v.toFixed(0);
                        return sign + v.toFixed(1);
                    },
                    clip: false,
                },
                tooltip: {
                    callbacks: {
                        title: ctx => ctx[0]?.label || '',
                        label: function (ctx) {
                            const idx = ctx.dataIndex;
                            const s = scored[idx];
                            const xVal = parseFloat(ctx.parsed.x.toFixed(2));
                            return [
                                `Momentum: ${xVal >= 0 ? '+' : ''}${xVal}`,
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

    // Use getTopStocks(0) to get ALL stocks, already enriched + sorted
    const enriched = getTopStocks(0);

    function fmtMomentum(m) {
        if (!Number.isFinite(m) || m === 0) return '<span class="text-muted">—</span>';
        const sign = m >= 0 ? '+' : '';
        const cls = m >= 30 ? 'text-success fw-bold' : m >= 10 ? 'text-success'
                  : m <= -30 ? 'text-danger fw-bold' : m <= -10 ? 'text-danger'
                  : 'text-muted';
        return `<span class="${cls}">${sign}${m.toFixed(0)}</span>`;
    }

    let html = '';
    enriched.forEach((s, i) => {
        html += `<tr>
            <td class="text-center">${i + 1}</td>
            <td class="fw-semibold">
                ${stockLogo(s.stock_code)}
                <a href="/idx/emiten/broker-summary.html?kode=${s.stock_code}" class="text-decoration-none">${s.stock_code}</a>
            </td>
            <td class="text-end ${netClass(s.total_net)}">${fmtValue(s.total_net)}</td>
            <td class="text-end">${fmtValue(s.total_buy)}</td>
            <td class="text-end">${fmtValue(s.total_sell)}</td>
            <td class="text-center hide-mobile">${s.days_active}</td>
            <td class="text-center hide-mobile">${fmtStreak(s.streak)}</td>
            <td class="text-center hide-mobile">${fmtMomentum(s.momentum)}</td>
        </tr>`;
    });

    $('#tbody-holdings').html(html);
    $('#holdings-count').text(`${enriched.length} stocks`);
}

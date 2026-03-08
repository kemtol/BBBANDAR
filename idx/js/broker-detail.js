/**
 * broker-detail.js — Broker Detail / Inventory Trailing Page
 * v1 — 2026-03-08
 *
 * Shows:
 *   1. Cumulative net value trailing line chart (top N stocks)
 *   2. Diverging horizontal bar chart (net buy vs net sell)
 *   3. Holdings table with sort
 *
 * Data source: GET /broker-activity/trailing?broker={code}&days=N
 */

'use strict';

// ── Config ──
const API_BASE = 'https://api-saham.mkemalw.workers.dev';

// Broker categories (same as broker-activity.js)
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

// Chart color palette for line chart (distinct, readable on dark bg)
const LINE_COLORS = [
    '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1',
    '#84cc16', '#e11d48', '#0ea5e9', '#a855f7', '#10b981',
    '#d946ef', '#eab308', '#64748b', '#fb923c', '#2dd4bf'
];

// ── State ──
let brokerCode = '';
let currentDays = 10;
let currentTopN = 5;
let apiData = null;          // raw API response
let trailingChart = null;
let divergingChart = null;
let tableSortKey = 'total_net';
let tableSortDir = -1;       // -1 = desc

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

function getBrokerCategory(code) {
    if (BROKER_CATEGORIES.foreign.has(code)) return 'foreign';
    if (BROKER_CATEGORIES.local.has(code)) return 'local';
    if (BROKER_CATEGORIES.retail.has(code)) return 'retail';
    return 'unknown';
}

function fmtStreak(s) {
    if (!s || s === 0) return '<span class="text-muted">—</span>';
    const abs = Math.abs(s);
    const cls = s > 0 ? 'text-success' : 'text-danger';
    const icon = s > 0 ? '▲' : '▼';
    return `<span class="${cls}">${icon}${abs}</span>`;
}

function fmtPct(c) {
    if (!Number.isFinite(c) || c === 0) return '<span class="text-muted">—</span>';
    const pct = (c * 100).toFixed(0);
    const cls = c >= 0.7 ? 'text-success fw-bold' : c >= 0.4 ? 'text-warning' : 'text-muted';
    return `<span class="${cls}">${pct}%</span>`;
}

function stockLogo(code) {
    return `<img src="${API_BASE}/logo?ticker=${code}" alt="${code}" class="stock-logo" loading="lazy" onerror="this.style.display='none'"> `;
}

// ── Init ──
$(document).ready(function () {
    const params = new URLSearchParams(window.location.search);
    brokerCode = (params.get('kode') || params.get('broker') || '').toUpperCase();

    if (!brokerCode) {
        $('#loading-indicator').html('<p class="text-danger text-center mt-5">Broker code not provided. Use ?kode=XX</p>');
        return;
    }

    // Set header
    $('#broker-code').text(brokerCode);
    $('#header-title').text(`Broker: ${brokerCode}`);
    document.title = `SSSAHAM - Broker ${brokerCode}`;
    $('#broker-logo').attr('src', `${API_BASE}/broker/logo/${brokerCode}`);

    // Category badge
    const cat = getBrokerCategory(brokerCode);
    const catMap = {
        foreign: { text: 'Foreign', cls: 'bg-primary' },
        local: { text: 'Local Fund', cls: 'bg-success' },
        retail: { text: 'Retail', cls: 'bg-warning text-dark' },
    };
    const badge = catMap[cat] || { text: 'Unknown', cls: 'bg-secondary' };
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

    // Table sorting
    $('#holdings-table thead th[data-sort]').on('click', function () {
        const key = $(this).data('sort');
        if (tableSortKey === key) tableSortDir *= -1;
        else { tableSortKey = key; tableSortDir = -1; }
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
    const conviction = totalVal > 0 ? Math.abs(netVal) / totalVal : 0;

    $('#stat-net-val').text(fmtValue(netVal)).removeClass('text-success text-danger').addClass(netClass(netVal));
    $('#stat-buy-val').text(fmtValue(buyVal)).addClass('text-success');
    $('#stat-sell-val').text(fmtValue(sellVal)).addClass('text-danger');
    $('#stat-breadth').text(summary.length);
    $('#stat-days').text(apiData.dates?.length || 0);
    $('#stat-conviction').text(conviction > 0 ? (conviction * 100).toFixed(0) + '%' : '—');
}

// ── Charts ──
function renderCharts() {
    renderTrailingChart();
    renderDivergingChart();
}

function getTopStocks(n) {
    if (!apiData?.stock_summary) return [];
    const sorted = [...apiData.stock_summary].sort((a, b) => Math.abs(b.total_net) - Math.abs(a.total_net));
    if (n <= 0 || n >= sorted.length) return sorted;
    return sorted.slice(0, n);
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
            backgroundColor: color + '20',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.3,
            fill: false,
        };
    });

    // Format dates for labels: "03/04" style
    const labels = dates.map(d => {
        const parts = d.split('-');
        return `${parts[1]}/${parts[2]}`;
    });

    const isMobile = window.innerWidth < 768;

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
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: 8,
                        font: { size: isMobile ? 10 : 12 },
                        color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e2e8f0',
                    }
                },
                datalabels: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${fmtValue(ctx.parsed.y)}`,
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: {
                        color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#94a3b8',
                        font: { size: isMobile ? 9 : 11 },
                        maxRotation: 45,
                    }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
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

function renderDivergingChart() {
    const topStocks = getTopStocks(currentTopN);
    if (topStocks.length === 0) return;

    // Sort by total_net (positive to negative)
    const sorted = [...topStocks].sort((a, b) => b.total_net - a.total_net);

    const labels = sorted.map(s => s.stock_code);
    const values = sorted.map(s => s.total_net);
    const bgColors = values.map(v => v >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)');
    const borderColors = values.map(v => v >= 0 ? '#22c55e' : '#ef4444');

    const isMobile = window.innerWidth < 768;

    // Dynamic height based on number of bars
    const barHeight = isMobile ? 22 : 28;
    const minHeight = 200;
    const chartHeight = Math.max(minHeight, sorted.length * barHeight + 60);
    $('#diverging-chart-container').css('height', chartHeight + 'px');

    if (divergingChart) divergingChart.destroy();
    const ctx = document.getElementById('diverging-chart').getContext('2d');
    divergingChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: bgColors,
                borderColor: borderColors,
                borderWidth: 1,
                borderRadius: 3,
                barThickness: isMobile ? 16 : 22,
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
                    anchor: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? 'end' : 'start',
                    align: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? 'right' : 'left',
                    color: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? '#22c55e' : '#ef4444',
                    font: { size: isMobile ? 9 : 11, weight: '600' },
                    formatter: v => fmtValueShort(v),
                    clip: false,
                },
                tooltip: {
                    callbacks: {
                        label: ctx => `Net: ${fmtValue(ctx.parsed.x)}`,
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: {
                        color: '#94a3b8',
                        font: { size: isMobile ? 9 : 11 },
                        callback: v => fmtValueShort(v),
                    },
                    title: {
                        display: !isMobile,
                        text: 'Net Value',
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

    // Enrich with streak + conviction
    const enriched = apiData.stock_summary.map(s => {
        const series = apiData.series[s.stock_code] || [];
        // Compute streak from series (chronological order — last entry is most recent)
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
        const totalTrade = s.total_buy + s.total_sell;
        const conviction = totalTrade > 0 ? Math.abs(s.total_net) / totalTrade : 0;
        return { ...s, streak, conviction };
    });

    // Sort
    enriched.sort((a, b) => {
        let va = a[tableSortKey], vb = b[tableSortKey];
        if (tableSortKey === 'stock_code') {
            return tableSortDir * va.localeCompare(vb);
        }
        // For total_net, sort by absolute value when descending
        if (tableSortKey === 'total_net') {
            return tableSortDir * (Math.abs(vb) - Math.abs(va)) || (vb - va);
        }
        return tableSortDir * ((vb || 0) - (va || 0));
    });

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
            <td class="text-center hide-mobile">${fmtPct(s.conviction)}</td>
        </tr>`;
    });

    $('#tbody-holdings').html(html);
    $('#holdings-count').text(`${enriched.length} stocks`);
}

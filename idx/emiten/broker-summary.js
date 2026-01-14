const WORKER_BASE_URL = "https://broksum-scrapper.mkemalw.workers.dev";
const urlParams = new URLSearchParams(window.location.search);
const emitenParam = urlParams.get('emiten');
const startParam = urlParams.get('start');
const endParam = urlParams.get('end');
const netParam = urlParams.get('net'); // 'true' or 'false'
let brokersMap = {};

$(document).ready(function () {
    // Fetch Brokers Mapping
    fetch(`${WORKER_BASE_URL}/brokers`)
        .then(r => r.json())
        .then(d => {
            if (d.brokers) brokersMap = d.brokers;
        })
        .catch(e => console.error("Error fetching brokers:", e))
        .finally(() => {
            // Initialize after fetch attempt (or parallel, but we want tooltips to work)
            if (emitenParam) {
                initDetailMode(emitenParam);
            } else {
                initIndexMode();
            }
        });
    // Search Logic Initialization
    initSearch();
});

// =========================================
// SEARCH FUNCTIONALITY
// =========================================
function toggleSearch() {
    const panel = document.getElementById('search-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
        document.getElementById('search-input').focus();
        loadSearchHistory();
    }
}

function initSearch() {
    const input = document.getElementById('search-input');
    input.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            const symbol = this.value.toUpperCase().trim();
            if (symbol) {
                saveSearchHistory(symbol);
                window.location.href = `?emiten=${symbol}`;
            }
        }
    });
}

function saveSearchHistory(symbol) {
    let history = JSON.parse(localStorage.getItem('search_history') || '[]');
    // Remove if exists
    history = history.filter(h => h !== symbol);
    // Add to top
    history.unshift(symbol);
    // Limit to 10
    if (history.length > 10) history.pop();
    localStorage.setItem('search_history', JSON.stringify(history));
}

function loadSearchHistory() {
    const history = JSON.parse(localStorage.getItem('search_history') || '[]');
    const list = document.getElementById('search-history-list');
    list.innerHTML = '';

    if (history.length === 0) {
        list.innerHTML = '<p class="small opacity-50 fst-italic">Belum ada riwayat.</p>';
        return;
    }

    history.forEach(sym => {
        const div = document.createElement('div');
        div.className = 'search-history-item';
        div.innerHTML = `
    <span class="fw-bold">${sym}</span>
    <i class="fa-solid fa-chevron-right small opacity-50"></i>
    `;
        div.onclick = () => {
            saveSearchHistory(sym); // update timestamp/order
            window.location.href = `?emiten=${sym}`;
        };
        list.appendChild(div);
    });
}

// =========================================
// SMART STICKY HEADER & PULL TO REFRESH
// =========================================
let lastScrollY = 0;
let ticking = false;
const navbar = document.querySelector('.navbar');
const viewportHeight = window.innerHeight;

window.addEventListener('scroll', () => {
    if (!ticking) {
        window.requestAnimationFrame(() => {
            const currentScrollY = window.scrollY;
            const scrollDirection = currentScrollY > lastScrollY ? 'down' : 'up';

            // Only apply smart behavior after 25% of total scroll height
            const threshold = document.documentElement.scrollHeight * 0.25;

            if (currentScrollY > threshold) {
                if (scrollDirection === 'down') {
                    navbar.classList.add('hidden');
                } else {
                    navbar.classList.remove('hidden');
                }
            } else {
                // Always show when near top (0-10%)
                navbar.classList.remove('hidden');
            }

            lastScrollY = currentScrollY;
            ticking = false;
        });
        ticking = true;
    }
});

// Pull to Refresh
let touchStartY = 0;
let isPulling = false;
const pullIndicator = document.getElementById('pull-indicator');
const pullText = document.getElementById('pull-text');
const PULL_THRESHOLD = 80;

document.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0) {
        touchStartY = e.touches[0].clientY;
        isPulling = true;
    }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    if (!isPulling || window.scrollY > 0) return;

    const touchY = e.touches[0].clientY;
    const pullDistance = touchY - touchStartY;

    if (pullDistance > 0 && pullDistance < 150) {
        pullIndicator.classList.add('pulling'); if (pullDistance >
            PULL_THRESHOLD) {
            pullIndicator.classList.add('ready');
            pullText.textContent = 'Lepas untuk refresh';
        } else {
            pullIndicator.classList.remove('ready');
            pullText.textContent = 'Tarik untuk refresh';
        }
    }
}, { passive: true });

document.addEventListener('touchend', () => {
    if (isPulling && pullIndicator.classList.contains('ready')) {
        // Trigger refresh
        pullText.textContent = 'Refreshing...';
        setTimeout(() => {
            window.location.reload();
        }, 300);
    } else {
        pullIndicator.classList.remove('pulling', 'ready');
    }
    isPulling = false;
});

// =========================================
// INDEX MODE (SCREENER) - WORKER POWERED
// =========================================
async function initIndexMode() {
    $('#index-view').show();
    $('#detail-view').hide();
    $('.nav-title').text('Smart Money Screener');

    // Add Control Panel
    if ($('#screener-controls').length === 0) {
        const controls = `
        <div id="screener-controls" class="d-flex justify-content-between align-items-center mb-3 px-2">
            <small class="text-muted" id="screener-meta">Loading...</small>
            <button class="btn btn-sm btn-outline-primary" onclick="triggerScreener()">
                <i class="bi bi-play-fill"></i> Run Analysis (Background)
            </button>
        </div>
        `;
        $('#index-view .card-swing').before(controls); // Insert before table card
    }

    loadScreenerData();
}

async function loadScreenerData() {
    try {
        $('#loading-indicator').show();
        const response = await fetch(`${WORKER_BASE_URL}/screener`);
        const data = await response.json();

        if (data && data.candidates) {
            renderScreenerTable(data.candidates);

            if (data.generated_at) {
                const date = new Date(data.generated_at);
                $('#screener-meta').text(`Last Updated: ${date.toLocaleString()}`);
            }
        } else {
            $('#tbody-index').html('<tr><td colspan="6" class="text-center text-muted">No analysis data found. Click "Run Analysis" to start.</td></tr>');
        }

    } catch (error) {
        console.error(error);
        $('#tbody-index').html('<tr><td colspan="6" class="text-center text-danger">Error loading screener data</td></tr>');
    } finally {
        $('#loading-indicator').hide();
        $('#app').fadeIn();
    }
}

async function triggerScreener() {
    if (!confirm('Run background analysis for all stocks? This may take a minute.')) return;

    try {
        await fetch(`${WORKER_BASE_URL}/trigger-screener`);
        alert('Analysis started in background. Please refresh in a minute.');
    } catch (e) {
        alert('Failed to trigger analysis');
    }
}

function renderScreenerTable(candidates) {
    const tbody = $('#tbody-index');
    tbody.empty();

    // sort by score desc (Worker already sorted but just in case)
    // candidates.sort((a, b) => b.score - a.score);

    // Build Table Header
    const thead = $('.table-orderflow thead tr');
    thead.html(`
        <th>Emiten</th>
        <th class="text-center">Effort</th>
        <th class="text-center">Price Response</th>
        <th class="text-center">Net Quality</th>
        <th class="text-center">Elasticity</th>
        <th class="text-center">State</th>
        `);

    // Helpers for labels/colors
    const getEffortLabel = (z) => {
        if (z > 1.0) return '<span class="badge bg-danger">Extreme</span>';
        if (z > 0.5) return '<span class="badge bg-warning text-dark">High</span>';
        if (z < -0.5) return '<span class="badge bg-secondary">Low</span>';
        return '<span class="badge bg-light text-dark border">Normal</span>';
    };

    const getResultLabel = (z) => {
        if (z > 1.0) return '<span class="text-danger fw-bold">Volatile</span>';
        if (z < -0.5) return '<span class="text-muted">Quiet</span>';
        return '<span class="text-dark">Normal</span>';
    };

    const getNGRLabel = (ngr) => {
        if (ngr < 0.15) return '<span class="text-muted">Noise</span>';
        return '<span class="text-success fw-bold">Valid</span>';
    };

    const getElasticityLabel = (elas) => {
        // Rough benchmarks
        if (elas > 0.05) return '<span class="text-success fw-bold">High</span>';
        if (elas < 0.01) return '<span class="text-danger">Low</span>';
        return '<span class="text-muted">Avg</span>';
    };

    const getStateBadge = (state) => {
        const colors = {
            'READY_MARKUP': 'bg-warning text-dark',
            'TRANSITION': 'bg-primary',
            'ACCUMULATION': 'bg-success',
            'DISTRIBUTION': 'bg-danger',
            'NEUTRAL': 'bg-secondary'
        };
        return `<span class="badge ${colors[state] || 'bg-secondary'}">${state.replace('_', ' ')}</span>`;
    };

    candidates.forEach(item => {
        const m = item.metrics;
        const row = `
            <tr onclick="window.location.href='?emiten=${item.symbol}'" style="cursor:pointer;">
                <td class="fw-bold">${item.symbol}</td>
                <td class="text-center">${getEffortLabel(m.effortZ)}</td>
                <td class="text-center">${getResultLabel(m.resultZ)}</td>
                <td class="text-center">${getNGRLabel(m.ngr)}</td>
                <td class="text-center">${getElasticityLabel(m.elasticity)}</td>
                <td class="text-center">${getStateBadge(item.state)}</td>
            </tr>
        `;
        tbody.append(row);
    });

    if (candidates.length === 0) {
        tbody.html('<tr><td colspan="6" class="text-center text-muted">No candidates found.</td></tr>');
    }
}
// =========================================
// DETAIL MODE
// =========================================
async function initDetailMode(symbol) {
    $('#index-view').hide();
    $('#detail-view').show();
    $('#header-title').text(symbol); // Just show symbol in header

    // Set Date Range Picker defaults
    let endDate = endParam ? new Date(endParam) : new Date();
    let startDate = startParam ? new Date(startParam) : new Date();
    if (!startParam) startDate.setDate(endDate.getDate() - 30); // Default 30 days

    $('#date-from').val(startDate.toISOString().split('T')[0]);
    $('#date-to').val(endDate.toISOString().split('T')[0]);

    // Fetch Data
    await loadDetailData(symbol, startDate, endDate);

    // Apply Filter Button
    $('#btn-apply-range').on('click', () => {
        const newFrom = $('#date-from').val();
        const newTo = $('#date-to').val();
        window.location.href = `?emiten=${symbol}&start=${newFrom}&end=${newTo}`;
    });
}

async function loadDetailData(symbol, start, end) {
    $('#loading-indicator').show();
    const fromDate = start.toISOString().split('T')[0];
    const toDate = end.toISOString().split('T')[0];

    try {
        const reloadParam = urlParams.get('cache-reload') === 'true' ? '&cache-reload=true' : '';
        const url =
            `${WORKER_BASE_URL}/chart-data?symbol=${symbol}&from=${fromDate}&to=${toDate}${reloadParam}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error("Failed to fetch data");

        const result = await response.json();

        $('#loading-indicator').hide();
        $('#app').fadeIn();

        // Handle both old array format (fallback) and new object format
        let history = [];
        let summary = null;

        if (Array.isArray(result)) {
            history = result;
        } else if (result.history) {
            history = result.history;
            summary = result.summary;
        }

        if (!history || history.length === 0) {
            alert('Data tidak ditemukan untuk rentang tanggal ini.');
            return;
        }

        processAndRenderDetail(history, summary);

    } catch (error) {
        console.error(error);
        $('#loading-indicator').hide();
        $('#app').fadeIn(); // Show app even on error to see alert
        alert('Terjadi kesalahan saat memuat data.');
    }
}

function processAndRenderDetail(history, brokerSummary) {
    // 1. CHART LOGIC
    // 1. CHART LOGIC
    // Filter out empty days (holidays/no transaction)
    history = history.filter(h => {
        if (!h.data) return false;
        const f = h.data.foreign?.net_val || 0;
        const r = h.data.retail?.net_val || 0;
        const l = h.data.local?.net_val || 0;
        // Keep if ANY sector has non-zero value
        return (f !== 0 || r !== 0 || l !== 0);
    });

    // Sort ascending by date
    history.sort((a, b) => new Date(a.date) - new Date(b.date));

    renderChart(history);

    // 2. AUDIT TRAIL LOGIC (Reverse Chronological)
    renderAuditTrail([...history].reverse());

    // 3. BROKER SUMMARY LOGIC
    // ... rest of function
}

let myChart = null;

function renderChart(history) {
    const ctx = document.getElementById('detailChart').getContext('2d');
    if (myChart) myChart.destroy();

    const labels = history.map(h => {
        const d = new Date(h.date);
        return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    // Validasi data null
    const getVal = (h, key) => h.data?.[key]?.net_val || 0;

    // Daily Net Flow (Not Cumulative, matching remote code)
    const foreignFlow = history.map(h => getVal(h, 'foreign'));
    const retailFlow = history.map(h => getVal(h, 'retail'));
    const localFlow = history.map(h => getVal(h, 'local'));

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Foreign Fund',
                    data: foreignFlow,
                    borderColor: '#198754', // Success Green
                    backgroundColor: 'rgba(25, 135, 84, 0.1)',
                    borderWidth: 2,
                    tension: 0.4, // Smooth curves
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: false
                },
                {
                    label: 'Retail',
                    data: retailFlow,
                    borderColor: '#dc3545', // Danger Red
                    backgroundColor: 'rgba(220, 53, 69, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: false
                },
                {
                    label: 'Local Fund',
                    data: localFlow,
                    borderColor: '#0d6efd', // Primary Blue
                    backgroundColor: 'rgba(13, 110, 253, 0.1)',
                    borderWidth: 2,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                const val = context.parsed.y;
                                if (Math.abs(val) >= 1e9) label += (val / 1e9).toFixed(1) + 'B';
                                else if (Math.abs(val) >= 1e6) label += (val / 1e6).toFixed(1) + 'M';
                                else label += val.toLocaleString();
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: 10
                        },
                        maxTicksLimit: 8
                    }
                },
                y: {
                    border: {
                        display: false
                    },
                    grid: {
                        color: '#f0f0f0'
                    },
                    ticks: {
                        font: {
                            size: 10
                        },
                        callback: function (value) {
                            if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(1) + 'B';
                            if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(1) + 'M';
                            return value;
                        }
                    }
                }
            }
        }
    });
}

function renderAuditTrail(history) {
    const fmt = (num) => {
        if (!num) return "-";
        const abs = Math.abs(num);
        if (abs >= 1e9) return (num / 1e9).toFixed(1) + "B";
        if (abs >= 1e6) return (num / 1e6).toFixed(1) + "M";
        return num.toLocaleString();
    };

    let html = '<div class="table-responsive"><table class="table table-sm small">';
    html += `<thead>
        <tr class="text-muted">
            <th>Date</th>
            <th class="text-end">Foreign Buy</th>
            <th class="text-end">Foreign Sell</th>
            <th class="text-end">Net</th>
        </tr>
    </thead>`;
    html += '<tbody>';

    history.forEach(h => {
        const f = h.data?.foreign || {};
        const net = f.net_val || 0;
        const netClass = net >= 0 ? 'text-success' : 'text-danger';
        html += `
            <tr>
                <td>${h.date}</td>
                <td class="text-end text-success">${fmt(f.buy_val)}</td>
                <td class="text-end text-danger">${fmt(f.sell_val)}</td>
                <td class="text-end fw-bold ${netClass}">${fmt(net)}</td>
            </tr>
        `;
    });

    html += '</tbody></table></div>';
    $('#audit-trail-list').html(html);
}

function renderBrokerTable(summary, isNet = true) {
    const fmt = (num) => {
        if (!num) return "-";
        const abs = Math.abs(num);
        if (abs >= 1e9) return (num / 1e9).toFixed(1) + "B";
        if (abs >= 1e6) return (num / 1e6).toFixed(1) + "M";
        return num.toLocaleString();
    };

    // Theme Colors
    const COLOR_BUY_BG = 'rgba(13, 202, 240, 0.15)'; // Cyan bg
    const COLOR_SELL_BG = 'rgba(253, 126, 20, 0.15)'; // Orange bg
    const BORDER_BUY = '#0aa2c0'; // Darker Cyan
    const BORDER_SELL = '#c66210'; // Darker Orange
    const STYLE_BUY_TEXT = 'color: #0dcaf0;';
    const STYLE_SELL_TEXT = 'color: #fd7e14;';

    const formatAvg = (num) => num ? Math.round(num).toLocaleString() : "-";

    // Get text color based on category
    const getTextClass = (code) => {
        const broker = brokersMap[code];
        if (!broker) return 'text-secondary'; // Unknown
        const cat = (broker.category || '').toLowerCase();
        if (cat.includes('foreign')) return 'text-success'; // Foreign = Green
        if (cat.includes('retail')) return 'text-danger'; // Retail = Red
        return 'text-primary'; // Local = Blue
    };

    // Get border color for visual bar
    const getBorderColor = (code) => {
        const broker = brokersMap[code];
        if (!broker) return '#6c757d'; // gray
        const cat = (broker.category || '').toLowerCase();
        if (cat.includes('foreign')) return '#198754'; // Green
        if (cat.includes('retail')) return '#dc3545'; // Red
        return '#0d6efd'; // Blue
    };

    // Get broker display name (first word only)
    const getBrokerLabel = (code) => {
        const broker = brokersMap[code];
        if (!broker) return code;
        // Short name: take first word only
        const shortName = broker.name.split(' ')[0];
        return `${code} - ${shortName}`;
    };

    // Mobile condensed label: Buy Side "(10B) Maybank - ZP"
    const getBuySideLabel = (code, net) => {
        const broker = brokersMap[code];
        const shortName = broker ? broker.name.split(' ')[0] : '';
        return `(${fmt(net)}) ${shortName} - ${code}`;
    };

    // Mobile condensed label: Sell Side "YP - Mirae (-5.3B)"
    const getSellSideLabel = (code, net) => {
        const broker = brokersMap[code];
        const shortName = broker ? broker.name.split(' ')[0] : '';
        return `${code} - ${shortName} (${fmt(net)})`;
    };

    let html = '';

    if (isNet && summary.top_net_buyers) {
        // Calculate max for bar scaling (GLOBAL for both tables)
        const maxNet = Math.max(...(summary.top_net_buyers || []).map(b => Math.abs(b.net)));
        const maxNetSell = Math.max(...(summary.top_net_sellers || []).map(s => Math.abs(s.net)));
        const globalMax = Math.max(maxNet, maxNetSell);

        // NET VIEW: Two columns (Top Net Buyer | Top Net Seller)
        html = `
        <div class="row">
            <div class="col-6">
                <table class="table table-sm table-borderless small broker-table-mobile">
                    <thead>
                        <tr class="text-muted">
                            <th class="text-end hide-mobile">Net</th>
                            <th class="text-end hide-mobile">Avg</th>
                            <th class="text-end hide-mobile">Buy</th>
                            <th class="text-end hide-mobile">Sell</th>
                            <th class="text-end">Buy Side Broker</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(summary.top_net_buyers || []).map((b, i) => {
            const ratio = globalMax > 0 ? Math.abs(b.net) / globalMax : 0;
            const percentage = Math.round(ratio * 95);
            // Proportional Height: Max 100px, Min 35px
            const rowHeight = Math.max(35, Math.round(ratio * 100));
            // Dynamic Border Width: 1px to 5px based heavily on ratio
            const barWidth = Math.max(1, Math.round(ratio * 5));

            const rowStyle = `height: ${rowHeight}px; vertical-align: middle;`;

            // Calculate Avg Price (Buy Avg for Net Buyers)
            const avg = b.bvol ? Math.round(b.bval / b.bvol) : 0;

            // BUY SIDE: Bar anchors RIGHT
            const barHtml = `<div style="position: absolute; top: 0; bottom: 0; right: 0; width: ${percentage}%; background-color: rgba(13, 202, 240, 0.25); border-right: ${barWidth}px solid #0aa2c0; z-index: 0;"></div>`;

            return `<tr style="${rowStyle}">
                            <td class="text-end fw-bold hide-mobile" style="${STYLE_BUY_TEXT}">${fmt(b.net)}</td>
                            <td class="text-end hide-mobile text-muted">${fmt(avg)}</td>
                            <td class="text-end hide-mobile" style="${STYLE_BUY_TEXT}">${fmt(b.bval)}</td>
                            <td class="text-end hide-mobile" style="${STYLE_SELL_TEXT}">${fmt(b.sval)}</td>
                            <td class="text-end" style="position: relative; padding-right: 8px;">
                                ${barHtml}
                                <span class="fw-bold ${getTextClass(b.code)} d-none d-md-inline" style="position: relative; z-index: 1;">${getBrokerLabel(b.code)}</span>
                                <span class="fw-bold ${getTextClass(b.code)} d-inline d-md-none" style="position: relative; z-index: 1;">${getBuySideLabel(b.code, b.net)}</span>
                            </td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="col-6">
                <table class="table table-sm table-borderless small broker-table-mobile">
                    <thead>
                        <tr class="text-muted">
                            <th>Sell Side Broker</th>
                            <th class="text-start hide-mobile">Buy</th>
                            <th class="text-start hide-mobile">Sell</th>
                            <th class="text-start hide-mobile">Avg</th>
                            <th class="text-start hide-mobile">Net</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(summary.top_net_sellers || []).map((s, i) => {
            const ratio = globalMax > 0 ? Math.abs(s.net) / globalMax : 0;
            const percentage = Math.round(ratio * 95);
            // Proportional Height: Max 100px, Min 35px
            const rowHeight = Math.max(35, Math.round(ratio * 100));
            // Dynamic Border Width: 1px to 5px based heavily on ratio
            const barWidth = Math.max(1, Math.round(ratio * 5));

            const rowStyle = `height: ${rowHeight}px; vertical-align: middle;`;

            // Calculate Avg Price (Sell Avg for Net Sellers)
            const avg = s.svol ? Math.round(s.sval / s.svol) : 0;

            // SELL SIDE: Bar anchors LEFT
            const barHtml = `<div style="position: absolute; top: 0; bottom: 0; left: 0; width: ${percentage}%; background-color: rgba(253, 126, 20, 0.25); border-left: ${barWidth}px solid #c66210; z-index: 0;"></div>`;

            return `<tr style="${rowStyle}">
                            <td style="position: relative; padding-left: 8px;">
                                ${barHtml}
                                <span class="fw-bold ${getTextClass(s.code)} d-none d-md-inline" style="position: relative; z-index: 1;">${getBrokerLabel(s.code)}</span>
                                <span class="fw-bold ${getTextClass(s.code)} d-inline d-md-none" style="position: relative; z-index: 1;">${getSellSideLabel(s.code, s.net)}</span>
                            </td>
                            <td class="text-start hide-mobile" style="${STYLE_BUY_TEXT}">${fmt(s.bval)}</td>
                            <td class="text-start hide-mobile" style="${STYLE_SELL_TEXT}">${fmt(s.sval)}</td>
                            <td class="text-start hide-mobile text-muted">${fmt(avg)}</td>
                            <td class="text-start fw-bold hide-mobile" style="${STYLE_SELL_TEXT}">${fmt(s.net)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    } else {
        // Calculate max for bar scaling
        const maxBuy = Math.max(...(summary.top_buyers || []).map(b => b.val));
        const maxSell = Math.max(...(summary.top_sellers || []).map(s => s.val));

        // GROSS VIEW: Two columns (Top Buyer | Top Seller)
        html = `
        <div class="row">
            <div class="col-md-6">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th>Buy Side Broker</th>
                            <th class="text-end">Value</th>
                            <th class="text-end">Avg</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${summary.top_buyers.map((b, i) => {
            const ratio = maxBuy > 0 ? b.val / maxBuy : 0;
            const percentage = Math.round(ratio * 95);
            const barWidth = maxBuy > 0 ? (b.val / maxBuy) * 5 : 1;
            const avg = b.vol ? Math.round(b.val / b.vol) : 0;
            const rowStyle = `background: linear-gradient(90deg, rgba(13, 202, 240, 0.25) ${percentage}%, transparent ${percentage}%) !important; vertical-align: middle;`;
            const borderStyle = `border-left: ${barWidth}px solid #0aa2c0; padding-left: 8px;`;

            return `<tr style="${rowStyle}">
                            <td style="${borderStyle}"><span class="fw-bold ${getTextClass(b.code)}">${getBrokerLabel(b.code)}</span></td>
                            <td class="text-end fw-bold" style="${STYLE_BUY_TEXT}">${fmt(b.val)}</td>
                            <td class="text-end text-muted">${fmt(avg)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="col-md-6 border-start">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th>Sell Side Broker</th>
                            <th class="text-end">Value</th>
                            <th class="text-end">Avg</th>
                        </tr>
                    </thead>
                    <tbody>
                         ${summary.top_sellers.map((s, i) => {
            const ratio = maxSell > 0 ? s.val / maxSell : 0;
            const percentage = Math.round(ratio * 95);
            const barWidth = maxSell > 0 ? (s.val / maxSell) * 5 : 1;
            const avg = s.vol ? Math.round(s.val / s.vol) : 0;
            const rowStyle = `background: linear-gradient(90deg, rgba(253, 126, 20, 0.25) ${percentage}%, transparent ${percentage}%) !important; vertical-align: middle;`;
            const borderStyle = `border-left: ${barWidth}px solid #c66210; padding-left: 8px;`;

            return `<tr style="${rowStyle}">
                            <td style="${borderStyle}"><span class="fw-bold ${getTextClass(s.code)}">${getBrokerLabel(s.code)}</span></td>
                            <td class="text-end fw-bold" style="${STYLE_SELL_TEXT}">${fmt(s.val)}</td>
                            <td class="text-end text-muted">${fmt(avg)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    $('#broker-table-container').html(html);
}

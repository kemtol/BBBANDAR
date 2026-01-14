const WORKER_BASE_URL = "https://api-saham.mkemalw.workers.dev";
const urlParams = new URLSearchParams(window.location.search);
const emitenParam = urlParams.get('emiten');
const startParam = urlParams.get('start');
const endParam = urlParams.get('end');
const nettParam = urlParams.get('nett');
let brokersMap = {};
let currentBrokerSummary = null;

$(document).ready(function () {
    // 1. Fetch Brokers Mapping (from API-Saham which proxies D1 or we can skip if not needed for index)
    // Actually api-saham doesn't expose /brokers. broksum-scrapper did.
    // I should add /brokers to api-saham index.js? 
    // Or just fetch from where? 
    // Let's assume we can fetch it or lazy load. 
    // For now, let's skip /brokers fetch for index mode, only for Detail.

    if (emitenParam) {
        initDetailMode(emitenParam);
    } else {
        initIndexMode();
    }

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
    history = history.filter(h => h !== symbol);
    history.unshift(symbol);
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
        div.innerHTML = `<span class="fw-bold">${sym}</span><i class="fa-solid fa-chevron-right small opacity-50"></i>`;
        div.onclick = () => {
            saveSearchHistory(sym);
            window.location.href = `?emiten=${sym}`;
        };
        list.appendChild(div);
    });
}

// =========================================
// SMART STICKY HEADER
// =========================================
let lastScrollY = 0;
const navbar = document.querySelector('.navbar');
window.addEventListener('scroll', () => {
    const currentScrollY = window.scrollY;
    if (currentScrollY > 100) {
        if (currentScrollY > lastScrollY) navbar.classList.add('hidden');
        else navbar.classList.remove('hidden');
    } else {
        navbar.classList.remove('hidden');
    }
    lastScrollY = currentScrollY;
});


// =========================================
// INDEX MODE (SCREENER)
// =========================================
async function initIndexMode() {
    $('#index-view').show();
    $('#detail-view').hide();
    $('.nav-title').text('Smart Money Screener');
    loadScreenerData();
}

async function loadScreenerData() {
    try {
        $('#loading-indicator').show();
        const response = await fetch(`${WORKER_BASE_URL}/screener`);
        const data = await response.json();

        // Data shape: { date: "...", items: [ { t: "BBRI", s: "RM", sc: 2.5, z: { "20": {e,r,n} } } ] }
        if (data && data.items) {
            const candidates = data.items.map(i => ({
                symbol: i.t,
                state: mapState(i.s),
                score: i.sc,
                // Use 20-day window metrics or fallback
                metrics: {
                    effortZ: i.z["20"]?.e || 0,
                    resultZ: i.z["20"]?.r || 0,
                    ngr: i.z["20"]?.n || 0,
                    elasticity: 0 // Elas might be missing in minified json if I excluded it? I included it in logic but excluded in aggregate?
                    // In features-service aggregate: "Elas omitted". 
                    // So we put 0 or re-include it. For now 0.
                }
            }));

            // Sort by Score Desc
            candidates.sort((a, b) => b.score - a.score);

            renderScreenerTable(candidates);

            if (data.date) {
                $('#index-view h5').html(`Smart Money Screener <small class='text-muted ms-2' style='font-size:0.7rem'>${data.date}</small>`);
            }
        } else {
            $('#tbody-index').html('<tr><td colspan="7" class="text-center text-muted">No data available.</td></tr>');
        }

    } catch (error) {
        console.error(error);
        $('#tbody-index').html('<tr><td colspan="7" class="text-center text-danger">Error loading screener data</td></tr>');
    } finally {
        $('#loading-indicator').hide();
        $('#app').fadeIn();
    }
}

function mapState(s) {
    const map = {
        'RM': 'READY_MARKUP',
        'TR': 'TRANSITION', // If i used TR shortcode
        'AC': 'ACCUMULATION',
        'DI': 'DISTRIBUTION',
        'NE': 'NEUTRAL'
    };
    // If full string, return it
    if (s.length > 2) return s;
    return map[s] || s;
}

function renderScreenerTable(candidates) {
    const tbody = $('#tbody-index');
    tbody.empty();

    const getBadge = (val, type) => {
        if (type === 'effort') {
            if (val > 1.0) return '<span class="badge bg-danger">Extreme</span>';
            if (val > 0.5) return '<span class="badge bg-warning text-dark">High</span>';
            if (val < -0.5) return '<span class="badge bg-secondary">Low</span>';
            return '<span class="badge bg-light text-dark border">Normal</span>';
        }
        if (type === 'result') {
            if (val > 1.0) return '<span class="text-danger fw-bold">Volatile</span>';
            if (val < -0.5) return '<span class="text-muted">Quiet</span>';
            return '<span class="text-dark">Normal</span>';
        }
        if (type === 'ngr') {
            if (val < 0.15) return '<span class="text-muted">Noise</span>';
            return '<span class="text-success fw-bold">Valid</span>';
        }
        return val;
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

    candidates.forEach((item, idx) => {
        const m = item.metrics;
        const row = `
            <tr onclick="window.location.href='?emiten=${item.symbol}'" style="cursor:pointer;">
                <td class="text-center text-muted small">${idx + 1}</td>
                <td class="fw-bold">${item.symbol}</td>
                <td class="text-center">${getBadge(m.effortZ, 'effort')}</td>
                <td class="text-center">${getBadge(m.resultZ, 'result')}</td>
                <td class="text-center">${getBadge(m.ngr, 'ngr')}</td>
                <td class="text-center">-</td> <!-- Elas hidden for now -->
                <td class="text-center">${getStateBadge(item.state)}</td>
            </tr>
        `;
        tbody.append(row);
    });
}

// =========================================
// DETAIL MODE
// =========================================
async function initDetailMode(symbol) {
    $('#index-view').hide();
    $('#detail-view').show();
    $('#header-title').text(symbol);

    let endDate = endParam ? new Date(endParam) : new Date();
    let startDate = startParam ? new Date(startParam) : new Date();
    if (!startParam) startDate.setDate(endDate.getDate() - 30);

    $('#date-from').val(startDate.toISOString().split('T')[0]);
    $('#date-to').val(endDate.toISOString().split('T')[0]);

    // Tab Handler
    $('#audit-tab').on('click', () => loadAuditTrail(symbol));

    await loadDetailData(symbol, startDate, endDate);

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
        const url = `${WORKER_BASE_URL}/cache-summary?symbol=${symbol}&from=${fromDate}&to=${toDate}`;
        const response = await fetch(url);
        const result = await response.json();

        $('#loading-indicator').hide();
        $('#app').fadeIn();

        // Chart Data (History of Flows)
        if (result.history) {
            renderChart(result.history);
        } else {
            alert('No Chart Data');
        }

    } catch (e) {
        console.error(e);
        $('#loading-indicator').hide();
        alert('Failed to load chart data');
    }
}

async function loadAuditTrail(symbol) {
    const container = $('#audit-trail-list');
    container.html('<div class="text-center my-3"><div class="spinner-border spinner-border-sm text-primary"></div> Loading...</div>');

    try {
        const res = await fetch(`${WORKER_BASE_URL}/features/history?symbol=${symbol}`);
        const data = await res.json();

        if (data.history) {
            // New Z-Score Audit Trail
            let html = '<div class="table-responsive"><table class="table table-sm small table-bordered">';
            html += `<thead class="table-light"><tr>
                <th>Date</th>
                <th>State</th>
                <th class="text-end">Effort (20)</th>
                <th class="text-end">Result (20)</th>
                <th class="text-end">NGR (20)</th>
            </tr></thead><tbody>`;

            // Reverse order
            const rev = [...data.history].reverse();
            rev.forEach(h => {
                const z20 = h.z_scores?.["20"] || {};
                html += `<tr>
                    <td>${h.date}</td>
                    <td>${h.state}</td>
                    <td class="text-end">${z20.effort?.toFixed(2) || '-'}</td>
                    <td class="text-end">${z20.result?.toFixed(2) || '-'}</td>
                    <td class="text-end">${z20.ngr?.toFixed(2) || '-'}</td>
                </tr>`;
            });
            html += '</tbody></table></div>';
            container.html(html);
        } else {
            container.html('<p>No audit trail data found.</p>');
        }
    } catch (e) {
        container.html('<p class="text-danger">Failed to load audit trail.</p>');
    }
}

let myChart = null;
function renderChart(history) {
    const ctx = document.getElementById('detailChart').getContext('2d');
    if (myChart) myChart.destroy();

    // Sort Date Asc
    history.sort((a, b) => new Date(a.date) - new Date(b.date));

    const labels = history.map(h => {
        const d = new Date(h.date);
        return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    // Cumulative Calculation
    let accF = 0, accR = 0, accL = 0;
    const fData = history.map(h => { accF += (h.data.foreign?.net_val || 0); return accF; });
    const rData = history.map(h => { accR += (h.data.retail?.net_val || 0); return accR; });
    const lData = history.map(h => { accL += (h.data.local?.net_val || 0); return accL; });

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Foreign', data: fData, borderColor: '#198754', tension: 0.1, borderWidth: 2, pointRadius: 0 },
                { label: 'Retail', data: rData, borderColor: '#dc3545', tension: 0.1, borderWidth: 2, pointRadius: 0 },
                { label: 'Local', data: lData, borderColor: '#0d6efd', tension: 0.1, borderWidth: 2, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: true } },
            interaction: { mode: 'index', intersect: false }
        }
    });
}

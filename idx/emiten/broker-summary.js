const WORKER_BASE_URL = "https://api-saham.mkemalw.workers.dev";
const urlParams = new URLSearchParams(window.location.search);
const kodeParam = urlParams.get('kode');
const startParam = urlParams.get('start');
const endParam = urlParams.get('end');
const nettParam = urlParams.get('nett');
let brokersMap = {};
let currentBrokerSummary = null;

$(document).ready(function () {
    // 1. Fetch Brokers Mapping
    fetch(`${WORKER_BASE_URL}/brokers`)
        .then(r => r.json())
        .then(d => {
            // Map array to object: { 'YP': { ... } }
            if (d.brokers && Array.isArray(d.brokers)) {
                d.brokers.forEach(b => brokersMap[b.code] = b);
            }
        })
        .catch(e => console.error("Error fetching brokers:", e))
        .finally(() => {
            if (kodeParam) {
                initDetailMode(kodeParam);
            } else {
                initIndexMode();
            }
        });

    // Pull to Refresh Logic
    let startY = 0;
    let pulling = false;
    const pullIndicator = document.getElementById('pull-indicator');
    const pullText = document.getElementById('pull-text');
    const threshold = 80;

    document.addEventListener('touchstart', function (e) {
        if (window.scrollY === 0) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
        if (!pulling) return;
        const currentY = e.touches[0].clientY;
        const diff = currentY - startY;

        if (diff > 0 && diff < threshold * 2) {
            pullIndicator.classList.add('visible');
            if (diff > threshold) {
                pullIndicator.classList.add('ready');
                pullText.textContent = 'Lepas untuk refresh';
            } else {
                pullIndicator.classList.remove('ready');
                pullText.textContent = 'Tarik untuk refresh';
            }
        }
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
        if (!pulling) return;
        pulling = false;

        if (pullIndicator.classList.contains('ready')) {
            pullText.textContent = 'Memuat ulang data...';
            setTimeout(() => {
                if (kodeParam) {
                    // Detail Mode: Force fetch new data (bypass cache)
                    const fromDateVal = $('#date-from').val();
                    const toDateVal = $('#date-to').val();
                    const s = new Date(fromDateVal);
                    const e = new Date(toDateVal);

                    loadDetailData(kodeParam, s, e, true) // reload=true
                        .then(() => {
                            pullIndicator.classList.remove('visible');
                        });
                } else {
                    // Index Mode: Regular reload
                    window.location.reload();
                }
            }, 300);
        } else {
            pullIndicator.classList.remove('visible');
        }
    }, { passive: true });

    // Search now in component.js
});

// =========================================
// INDEX MODE (SCREENER)
// =========================================
async function initIndexMode() {
    $('#index-view').show();
    $('#detail-view').hide();
    $('.nav-title').text('Dashboard');
    $('#nav-back').addClass('d-none'); // Hide back button in Screen Mode
    loadScreenerData();
}

// Global state for sorting
let currentCandidates = [];
let sortState = { key: 'score', desc: true };

async function loadScreenerData() {
    try {
        $('#loading-indicator').show();
        const response = await fetch(`${WORKER_BASE_URL}/screener`);
        const data = await response.json();

        if (data && data.items) {
            currentCandidates = data.items.map(i => ({
                symbol: i.t,
                state: mapState(i.s),
                score: i.sc,
                metrics: {
                    effortZ: i.z["20"]?.e || 0,
                    resultZ: i.z["20"]?.r || 0,
                    ngr: i.z["20"]?.n || 0,
                    elasticity: i.z["20"]?.el || 0 // Mapped (default 0 if backend older)
                }
            }));

            // Initial sort by Score DESC
            sortCandidates('score', true);

            // Calculate & Render Market Breadth
            renderMarketBreadth(currentCandidates, data.date);

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

function calculateMarketBreadth(candidates) {
    const total = candidates.length;
    if (total === 0) return { accum: 0, dist: 0, neut: 0, sentiment: 'Neutral' };

    const accum = candidates.filter(c => c.state === 'OFF_THE_LOW' || c.state === 'ACCUMULATION' || c.state === 'READY_MARKUP').length;
    const dist = candidates.filter(c => c.state === 'POTENTIAL_TOP' || c.state === 'DISTRIBUTION').length;
    const neut = total - accum - dist;

    // Determine Sentiment
    let sentiment = 'Neutral';
    if (accum > dist * 1.5) sentiment = 'Bullish';
    if (dist > accum * 1.5) sentiment = 'Bearish';

    return { accum, dist, neut, sentiment, total };
}

function renderMarketBreadth(candidates, dateStr) {
    const stats = calculateMarketBreadth(candidates);

    // Show Widget
    $('#market-breadth-widget').removeClass('d-none');

    // Update Text
    $('#market-sentiment-text').text(stats.sentiment);
    if (stats.sentiment === 'Bullish') $('#market-sentiment-text').addClass('text-success').removeClass('text-danger text-dark');
    else if (stats.sentiment === 'Bearish') $('#market-sentiment-text').addClass('text-danger').removeClass('text-success text-dark');
    else $('#market-sentiment-text').addClass('text-dark').removeClass('text-success text-danger');

    $('#market-date').text(dateStr || 'Today');

    // Update Bars
    const pAccum = (stats.accum / stats.total) * 100;
    const pDist = (stats.dist / stats.total) * 100;
    const pNeut = (stats.neut / stats.total) * 100;

    $('#bar-accum').css('width', `${pAccum}%`).text(stats.accum > 0 ? stats.accum : '');
    $('#bar-dist').css('width', `${pDist}%`).text(stats.dist > 0 ? stats.dist : '');
    $('#bar-neut').css('width', `${pNeut}%`).text(stats.neut > 0 ? stats.neut : '');

    // Counts
    $('#count-accum').text(`${stats.accum} Stocks`);
    $('#count-dist').text(`${stats.dist} Stocks`);
}

function sortCandidates(key, desc) {
    currentCandidates.sort((a, b) => {
        let valA, valB;

        // Extract values based on key
        if (key === 'symbol') { valA = a.symbol; valB = b.symbol; }
        else if (key === 'state') { valA = a.state; valB = b.state; } // String comparison for state
        else if (key === 'score') { valA = a.score; valB = b.score; }
        else if (key === 'effort') { valA = a.metrics.effortZ; valB = b.metrics.effortZ; }
        else if (key === 'response') { valA = a.metrics.resultZ; valB = b.metrics.resultZ; }
        else if (key === 'quality') { valA = a.metrics.ngr; valB = b.metrics.ngr; }
        else if (key === 'elasticity') { valA = a.metrics.elasticity; valB = b.metrics.elasticity; }
        else { valA = 0; valB = 0; }

        if (typeof valA === 'string') {
            return desc ? valB.localeCompare(valA) : valA.localeCompare(valB);
        }
        return desc ? valB - valA : valA - valB;
    });

    renderScreenerTable(currentCandidates);
    updateSortIcons(key, desc);
}

function updateSortIcons(activeKey, desc) {
    $('th[data-sort] i').attr('class', 'fa-solid fa-sort small text-muted opacity-50'); // Reset all
    const activeHeader = $(`th[data-sort="${activeKey}"]`);
    const icon = activeHeader.find('i');
    icon.removeClass('opacity-50 fa-sort').addClass(desc ? 'fa-sort-down' : 'fa-sort-up');
}

// Attach Sort Handlers
$(document).on('click', 'th[data-sort]', function () {
    const key = $(this).data('sort');
    if (sortState.key === key) {
        sortState.desc = !sortState.desc; // Toggle
    } else {
        sortState.key = key;
        sortState.desc = true; // Default DESC for new column
    }
    sortCandidates(sortState.key, sortState.desc);
});


function mapState(s) {
    const map = {
        'RM': 'READY_MARKUP',
        'TR': 'TRANSITION', // If i used TR shortcode
        'AC': 'ACCUMULATION',
        'DI': 'DISTRIBUTION',
        'NE': 'NEUTRAL'
    };
    if (s.length > 2) return s;
    return map[s] || s;
}

// Global badge helper function (used by both screener table and detail view)
function getBadge(val, type) {
    const score = `<span class="small text-muted ms-1">(${val.toFixed(2)})</span>`;
    if (type === 'effort') {
        if (val > 1.0) return `<span class="badge bg-danger">Extreme</span>${score}`;
        if (val > 0.5) return `<span class="badge bg-warning text-dark">High</span>${score}`;
        if (val < -0.5) return `<span class="badge bg-secondary">Low</span>${score}`;
        return `<span class="badge bg-light text-dark border">Normal</span>${score}`;
    }
    if (type === 'result') {
        if (val > 1.0) return `<span class="text-danger fw-bold">Volatile</span>${score}`;
        if (val < -0.5) return `<span class="text-muted">Quiet</span>${score}`;
        return `<span class="text-dark">Normal</span>${score}`;
    }
    if (type === 'ngr') {
        if (val < 0.15) return `<span class="text-muted">Noise</span>${score}`;
        return `<span class="text-success fw-bold">Valid</span>${score}`;
    }
    if (type === 'elasticity') {
        if (val === 0) return `<span class="text-muted">-</span>${score}`;
        if (val > 1.5) return `<span class="badge bg-success">Elastic</span>${score}`;
        if (val < 0.5) return `<span class="badge bg-danger">Rigid</span>${score}`;
        return `<span class="text-dark small">Normal</span>${score}`;
    }
    return val;
}

function renderScreenerTable(candidates) {
    const tbody = $('#tbody-index');
    tbody.empty();

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
        const logoUrl = `https://api-saham.mkemalw.workers.dev/logo?symbol=${item.symbol}`;
        const row = `
            <tr onclick="window.location.href='?kode=${item.symbol}'" style="cursor:pointer;">
                <td class="text-center text-muted small">${idx + 1}</td>
                <td class="fw-bold">
                    <img src="${logoUrl}" alt="" style="height: 20px; width: auto; margin-right: 6px; vertical-align: middle; border-radius: 3px;" onerror="this.style.display='none'">
                    <a href="?kode=${item.symbol}">${item.symbol}</a>
                </td>
                <td class="text-center">${getBadge(m.effortZ, 'effort')}</td>
                <td class="text-center">${getBadge(m.resultZ, 'result')}</td>
                <td class="text-center">${getBadge(m.ngr, 'ngr')}</td>
                <td class="text-center">${getBadge(m.elasticity, 'elasticity')}</td>
                <td class="text-center">${getStateBadge(item.state)}</td>
            </tr>
        `;
        tbody.append(row);
    });
}

// =========================================
// Z-SCORE FEATURES (For Detail View)
// =========================================
async function loadZScoreFeatures(symbol) {
    console.log(`[ZScore] Loading features for ${symbol}...`);
    
    try {
        // Try screener first (has z-score detail from cron job)
        const screenerResp = await fetch(`${WORKER_BASE_URL}/screener`);
        const screenerData = await screenerResp.json();
        if (screenerData && screenerData.items) {
            const item = screenerData.items.find(i => i.t === symbol);
            if (item && item.z && item.z["20"]) {
                console.log(`[ZScore] Found in screener`);
                const z = item.z["20"];
                const state = mapState(item.s);
                $('#feat-effort').html(getBadge(z.e || 0, 'effort'));
                $('#feat-response').html(getBadge(z.r || 0, 'result'));
                $('#feat-quality').html(getBadge(z.n || 0, 'ngr'));
                $('#feat-elasticity').html(getBadge(z.el || 0, 'elasticity'));
                $('#feat-state').html(getStateBadgeSimple(state));
                $('#zscore-features-card').removeClass('d-none');
                return;
            }
        }
        
        // Not in screener - calculate on-demand from cache-summary data
        console.log(`[ZScore] ${symbol} not in screener, calculating from broker data...`);
        
        // Fetch cache-summary (30 days of data)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        
        const cacheUrl = `${WORKER_BASE_URL}/cache-summary?symbol=${symbol}&from=${startDate.toISOString().split('T')[0]}&to=${endDate.toISOString().split('T')[0]}`;
        console.log(`[ZScore] Fetching: ${cacheUrl}`);
        
        const cacheResp = await fetch(cacheUrl);
        const cacheData = await cacheResp.json();
        
        console.log(`[ZScore] Got history: ${cacheData.history?.length || 0} days`);
        
        if (cacheData && cacheData.history && cacheData.history.length >= 5) {
            const features = calculateFeaturesFromHistory(cacheData.history);
            console.log(`[ZScore] Calculated features:`, features);
            
            $('#feat-effort').html(getBadge(features.effort, 'effort'));
            $('#feat-response').html(getBadge(features.response, 'result'));
            $('#feat-quality').html(getBadge(features.quality, 'ngr'));
            $('#feat-elasticity').html(getBadge(features.elasticity, 'elasticity'));
            $('#feat-state').html(getStateBadgeSimple(features.state));
            $('#zscore-features-card').removeClass('d-none');
            return;
        }
        
        // No data available - hide card
        console.log(`[ZScore] No data, hiding card`);
        $('#zscore-features-card').addClass('d-none');
        
    } catch (error) {
        console.error('[ZScore] Error:', error);
        $('#zscore-features-card').addClass('d-none');
    }
}

function calculateFeaturesFromHistory(history) {
    // Filter valid days (has trading activity)
    const days = history.filter(h => h.data && h.data.price > 0)
                        .sort((a, b) => new Date(a.date) - new Date(b.date));
    
    if (days.length < 5) {
        return { effort: 0, response: 0, quality: 0, elasticity: 0, state: 'NEUTRAL' };
    }
    
    const n = days.length;
    
    // Effort: Average trading value
    const avgValue = days.reduce((s, d) => s + (parseFloat(d.data?.detector?.value) || 0), 0) / n;
    
    // Response: Price change from first to last
    const firstPrice = days[0].data?.price || 0;
    const lastPrice = days[n-1].data?.price || 0;
    const priceChange = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
    
    // Quality: Net smart money flow consistency
    const smartMoneyFlow = days.map(d => 
        (d.data?.foreign?.net_val || 0) + (d.data?.local?.net_val || 0)
    );
    const avgFlow = smartMoneyFlow.reduce((s, v) => s + v, 0) / n;
    const maxFlow = Math.max(...smartMoneyFlow.map(Math.abs)) || 1;
    
    // Elasticity: Price response per unit of smart money flow
    const totalFlow = smartMoneyFlow.reduce((s, v) => s + v, 0);
    const elasticity = totalFlow !== 0 ? priceChange / (totalFlow / 1000000) : 0;
    
    // Determine state from recent vs early activity
    const recentFlow = smartMoneyFlow.slice(-5).reduce((s, v) => s + v, 0);
    const earlyFlow = smartMoneyFlow.slice(0, 5).reduce((s, v) => s + v, 0);
    
    let state = 'NEUTRAL';
    if (recentFlow > 0 && recentFlow > earlyFlow * 1.2) state = 'ACCUMULATION';
    else if (recentFlow < 0 && recentFlow < earlyFlow * 0.8) state = 'DISTRIBUTION';
    else if (recentFlow > 0 && priceChange > 3) state = 'READY_MARKUP';
    else if (recentFlow < 0 && priceChange < -3) state = 'POTENTIAL_TOP';
    
    // Normalize to z-score-like range (-3 to +3)
    const normalize = (val, range) => Math.max(-3, Math.min(3, val / (range || 1) * 3));
    
    return {
        effort: normalize(avgValue, 5000000000), // 5B as reference
        response: normalize(priceChange, 10), // 10% as max
        quality: normalize(avgFlow, maxFlow),
        elasticity: normalize(elasticity, 5),
        state: state
    };
}

function getSignalBadge(signal) {
    const colors = {
        'STRONG_BUY': 'bg-success',
        'BUY': 'bg-primary',
        'WATCH_ACCUM': 'bg-info',
        'NEUTRAL': 'bg-secondary',
        'TRAP_WARNING': 'bg-warning text-dark',
        'STRONG_SELL': 'bg-danger'
    };
    return `<span class="badge ${colors[signal] || 'bg-secondary'}">${signal || '-'}</span>`;
}

function getStateBadgeSimple(state) {
    const colors = {
        'OFF_THE_LOW': 'bg-success',
        'ACCUMULATION': 'bg-primary',
        'READY_MARKUP': 'bg-info',
        'POTENTIAL_TOP': 'bg-warning text-dark',
        'DISTRIBUTION': 'bg-danger',
        'NEUTRAL': 'bg-secondary'
    };
    return `<span class="badge ${colors[state] || 'bg-secondary'}">${state ? state.replace('_', ' ') : '-'}</span>`;
}

// =========================================
// DETAIL MODE
// =========================================
async function initDetailMode(symbol) {
    $('#index-view').hide();
    $('#detail-view').show();

    // Set header with logo + symbol anchor
    const logoUrl = `https://api-saham.mkemalw.workers.dev/logo?symbol=${symbol}`;
    $('.nav-title').html(`
        <a href="?kode=${symbol}" style="color: inherit; text-decoration: none;">${symbol}</a>
    `);
    $('#nav-back').removeClass('d-none').attr('href', '?'); // Show back button, link to index

    // Load Z-Score Features for this symbol
    loadZScoreFeatures(symbol);

    let endDate = endParam ? new Date(endParam) : new Date();
    let startDate = startParam ? new Date(startParam) : new Date();
    if (!startParam) startDate.setDate(endDate.getDate() - 14); // Default 14 days per user request

    $('#date-from').val(startDate.toISOString().split('T')[0]);
    $('#date-to').val(endDate.toISOString().split('T')[0]);

    // Set toggle state from URL param: nett=false means Gross (unchecked), default is Net (checked)
    if (nettParam === 'false') {
        $('#toggleNet').prop('checked', false);
    } else {
        $('#toggleNet').prop('checked', true); // Default: Net
    }

    // Tab Handler
    $('#audit-tab').on('click', () => loadAuditTrail(symbol));

    // Set Intraday link to preserve emiten parameter
    $('#intraday-link').attr('href', `detail.html?kode=${symbol}`);

    await loadDetailData(symbol, startDate, endDate);

    // Handle URL hash for auto-tab switching
    if (window.location.hash === '#audit') {
        setTimeout(() => {
            $('#audit-tab').click();
        }, 100);
    }

    $('#btn-apply-range').on('click', () => {
        const newFrom = $('#date-from').val();
        const newTo = $('#date-to').val();
        // Keep net param if exists
        const netPart = nettParam ? `&nett=${nettParam}` : '';
        window.location.href = `?kode=${symbol}&start=${newFrom}&end=${newTo}${netPart}`;
    });
}

// Enhanced Load Data with Retry Limit and Partial Data Support
async function loadDetailData(symbol, start, end, reload = false, retryCount = 0) {
    const MAX_RETRIES = 60; // Increased to 60 retries (approx 10 minutes) upon user request

    $('#loading-indicator').show();
    const fromDate = start.toISOString().split('T')[0];
    const toDate = end.toISOString().split('T')[0];

    try {
        let url = `${WORKER_BASE_URL}/cache-summary?symbol=${symbol}&from=${fromDate}&to=${toDate}`;
        if (reload) url += '&reload=true';

        console.log(`[API] Fetching: ${url}`);
        const response = await fetch(url);
        const result = await response.json();

        // DEBUG: Log entire response
        console.log(`[API] Response for ${symbol}:`, result);
        console.log(`[API] backfill_active: ${result.backfill_active}`);
        console.log(`[API] history length: ${result.history ? result.history.length : 0}`);

        // 1. COMPLETENESS & BACKFILL CHECK (BEFORE RENDERING)
        // Calculate expected trading days (rough estimate: 70% of days)
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const expectedDays = Math.floor(diffDays * 0.7);
        const actualDays = result.history ? result.history.length : 0;

        const completeness = expectedDays > 0 ? actualDays / expectedDays : 0;

        // Conditions: 
        // A. Explicit backfill flag from backend
        // B. Empty data
        // C. Partial data (< 70% complete)
        const isBackfillActive = result.backfill_active === true;
        const hasMinimalData = !result.history || result.history.length === 0 || completeness < 0.7;

        console.log(`[DATA COMPLETENESS] Expected: ${expectedDays}, Actual: ${actualDays}, Completeness: ${(completeness * 100).toFixed(1)}%`);
        console.log(`[BACKFILL CHECK] hasMinimalData: ${hasMinimalData}, isBackfillActive: ${isBackfillActive}`);

        if (isBackfillActive || hasMinimalData) {

            // CHECK RETRY LIMIT
            if (retryCount >= MAX_RETRIES) {
                console.error(`[BACKFILL] Max retries (${MAX_RETRIES}) reached for ${symbol}`);
                $('#broker-table-container').html(`
                    <div class="alert alert-warning text-center">
                        <i class="fa-solid fa-triangle-exclamation fa-2x mb-2"></i>
                        <div><strong>⏱️ Backfill Masih Berjalan</strong></div>
                        <div class="small text-muted mt-2">
                            Server masih memproses data untuk <strong>${symbol}</strong>.<br>
                            Proses ini dapat memakan waktu 2-3 menit untuk data 90 hari.
                        </div>
                        <button class="btn btn-sm btn-primary mt-3" onclick="location.reload()">
                            <i class="fa-solid fa-rotate-right me-1"></i> Coba Lagi
                        </button>
                    </div>
                `);
                $('#loading-indicator').hide(); // Hide loading indicator if max retries reached
                $('#app').fadeIn(); // Ensure app is visible
                return; // STOP RETRYING
            }

            console.log(`[BACKFILL] Active for ${symbol}. Retry ${retryCount + 1}/${MAX_RETRIES} in 5s...`);

            // Progress Text
            const progressText = actualDays > 0
                ? `Progres: ${actualDays} / ~${expectedDays} hari (${(completeness * 100).toFixed(0)}%)`
                : 'Memulai proses backfill...';

            $('#loading-indicator').addClass('d-none'); // Force hide using Bootstrap class
            $('#loading-indicator').hide(); // Standard jQuery hide

            $('#app').show(); // Force app container to show
            $('#broker-table-container').show(); // Force table container to show

            // HIDE Chart Container during backfill to prevent whitespace/gap
            $('.chart-container-responsive').hide();

            $('#broker-table-container').html(`
                <div class="text-center py-5">
                    <div class="spinner-border text-primary mb-3" role="status"></div>
                    <h5 class="fw-bold text-dark">Data Sedang Di-Backfill</h5>
                    <p class="text-muted small mb-1">Server sedang mengambil data historis untuk <strong>${symbol}</strong></p>
                    <p class="text-primary fw-bold mb-3 small">${progressText}</p>
                    
                    <div class="progress mx-auto" style="height: 6px; max-width: 400px;">
                        <div class="progress-bar progress-bar-striped progress-bar-animated bg-primary" role="progressbar" style="width: ${(completeness * 100).toFixed(0)}%"></div>
                    </div>
                </div>
            `);

            // Retry Logic (No countdown UI)
            setTimeout(() => {
                console.log(`[BACKFILL] Retrying fetch for ${symbol} (Attempt ${retryCount + 1})...`);
                loadDetailData(symbol, start, end, true, retryCount + 1); // Retry with reload=true & increment count
            }, 5000);
            return;
        }

        // If we reach here, data is considered sufficient or backfill is not active.
        $('#loading-indicator').hide();
        $('#app').fadeIn();
        $('.chart-container-responsive').show(); // Show chart again

        // 2. RENDER CHART (Only if passed checks)
        if (result.history && result.history.length > 0) {
            renderChart(result.history);
        } else {
            console.warn('No Chart Data');
        }

        if (result.summary) {
            renderDetailSummary(result.summary);
            renderProportionalBar(result.summary);
        } else {
            $('#broker-table-container').html('<p class="text-center text-muted">No summary data available.</p>');
        }

    } catch (e) {
        console.error(e);
        $('#loading-indicator').hide();
        $('#broker-table-container').html('<p class="text-center text-danger">Failed to load data. Please try again.</p>');
    }
}

async function loadAuditTrail(symbol) {
    const container = $('#audit-trail-list');
    container.html('<p class="text-muted small">Loading audit trail...</p>');

    try {
        const response = await fetch(`${WORKER_BASE_URL}/audit-trail?symbol=${symbol}&limit=100`);
        const data = await response.json();

        if (!data.ok || !data.entries || data.entries.length === 0) {
            container.html('<p class="text-muted small">No audit trail entries found for this symbol.</p>');
            return;
        }

        let html = '<div class="table-responsive"><table class="table table-sm small">';
        html += `<thead>
            <tr class="text-muted">
                <th>Timestamp</th>
                <th>Action</th>
                <th>Data Date</th>
                <th class="d-none d-md-table-cell">Status</th>
            </tr>
        </thead>`;
        html += '<tbody>';

        // Action badge colors
        const getActionBadge = (action) => {
            const colors = {
                'SCRAPE_BROKSUM': 'bg-primary',
                'CALCULATE_SCORE': 'bg-info',
                'BACKFILL': 'bg-warning text-dark',
                'MANUAL_SCRAPE': 'bg-success'
            };
            const color = colors[action] || 'bg-secondary';
            const label = action ? action.replace(/_/g, ' ') : 'UNKNOWN';
            return `<span class="badge ${color}">${label}</span>`;
        };

        for (const entry of data.entries) {
            const timestamp = new Date(entry.timestamp);
            const localTime = timestamp.toLocaleString('id-ID', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            const statusIcon = entry.status === 'SUCCESS' ? '✅' : '❌';

            html += `
                <tr>
                    <td class="text-muted">${localTime}</td>
                    <td>${getActionBadge(entry.action)}</td>
                    <td class="fw-bold">${entry.data_date || '-'}</td>
                    <td class="d-none d-md-table-cell">${statusIcon}</td>
                </tr>
            `;
        }

        html += '</tbody></table></div>';
        html += `<p class="text-muted small mt-2">Showing ${data.count} entries</p>`;
        container.html(html);

    } catch (e) {
        console.error('Error loading audit trail:', e);
        container.html('<p class="text-danger small">Failed to load audit trail.</p>');
    }
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

    [...history].reverse().forEach(h => {
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


function renderDetailSummary(summary) {
    const container = $('#broker-table-container');
    container.empty();

    if (!summary || (!summary.top_buyers?.length && !summary.top_sellers?.length && !summary.top_net_buyers?.length)) {
        container.html('<p class="text-center text-muted">No broker data available for this range.</p>');
        return;
    }

    // Store summary for toggle re-render
    currentBrokerSummary = summary;

    // Use existing #toggleNet checkbox state (checked = Net, unchecked = Gross)
    const isNet = $('#toggleNet').is(':checked');
    renderBrokerTable(summary, isNet);

    // Wire up toggle event (only once)
    $('#toggleNet').off('change').on('change', function () {
        const container = $('#broker-table-container');
        container.empty();
        if (currentBrokerSummary) {
            renderBrokerTable(currentBrokerSummary, $(this).is(':checked'));
        }
    });
}

function renderProportionalBar(summary) {
    const container = $('#proportional-bar-container');
    container.empty();

    if (!summary || !summary.foreign || !summary.retail || !summary.local) {
        return; // No data to display
    }

    const fNet = Math.abs(summary.foreign.net_val || 0);
    const rNet = Math.abs(summary.retail.net_val || 0);
    const lNet = Math.abs(summary.local.net_val || 0);
    const total = fNet + rNet + lNet;

    if (total === 0) return;

    const fPct = (fNet / total) * 100;
    const lPct = (lNet / total) * 100;
    const rPct = (rNet / total) * 100;

    const fColor = '#198754'; // Foreign = Green (same as table text)
    const lColor = '#0d6efd'; // Local = Blue (same as table text)
    const rColor = '#dc3545'; // Retail = Red (same as table text)

    const fmt = (num) => {
        const abs = Math.abs(num);
        if (abs >= 1e9) return (num / 1e9).toFixed(1) + 'B';
        if (abs >= 1e6) return (num / 1e6).toFixed(1) + 'M';
        return num.toLocaleString();
    };

    const html = `
        <div class="d-flex w-100" style="height: 24px; border-radius: 4px; overflow: hidden;">
            <div style="width: ${fPct}%; background-color: ${fColor}; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                <span class="text-white small fw-bold" style="white-space: nowrap;">Foreign</span>
            </div>
            <div style="width: ${lPct}%; background-color: ${lColor}; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                <span class="text-white small fw-bold" style="white-space: nowrap;">Local</span>
            </div>
            <div style="width: ${rPct}%; background-color: ${rColor}; display: flex; align-items: center; justify-content: center; overflow: hidden;">
                <span class="text-white small fw-bold" style="white-space: nowrap;">Retail</span>
            </div>
        </div>
        <div class="d-flex justify-content-between small mt-1">
            <span class="fw-bold text-center" style="color: ${fColor};">${fmt(summary.foreign.net_val)} (${fPct.toFixed(0)}%)</span>
            <span class="fw-bold text-center" style="color: ${lColor};">${fmt(summary.local.net_val)} (${lPct.toFixed(0)}%)</span>
            <span class="fw-bold text-center" style="color: ${rColor};">${fmt(summary.retail.net_val)} (${rPct.toFixed(0)}%)</span>
        </div>
    `;

    container.html(html);
}

function renderBrokerTable(summary, isNet = true) {
    const fmt = (num) => {
        if (!num) return "-";
        const abs = Math.abs(num);
        if (abs >= 1e9) return (num / 1e9).toFixed(1) + "B";
        if (abs >= 1e6) return (num / 1e6).toFixed(1) + "M";
        return num.toLocaleString();
    };

    const STYLE_BUY_TEXT = 'color: #20f00dff;';
    const STYLE_SELL_TEXT = 'color: #ff3232ff;';

    const getTextClass = (code) => {
        const broker = brokersMap[code];
        if (!broker) return 'text-secondary';
        const cat = (broker.category || '').toLowerCase();
        if (cat.includes('foreign')) return 'text-success';
        if (cat.includes('retail')) return 'text-danger';
        return 'text-primary';
    };

    const getBrokerLabel = (code) => {
        const broker = brokersMap[code];
        if (!broker) return code;
        const shortName = broker.name.split(' ')[0];
        return `${code} - ${shortName}`;
    };

    const getBuySideLabel = (code, net) => {
        const broker = brokersMap[code];
        const shortName = broker ? broker.name.split(' ')[0] : '';
        return `(${fmt(net)}) ${shortName} - ${code}`;
    };

    const getSellSideLabel = (code, net) => {
        const broker = brokersMap[code];
        const shortName = broker ? broker.name.split(' ')[0] : '';
        return `${code} - ${shortName} (${fmt(net)})`;
    };

    let html = '';

    if (isNet && summary.top_net_buyers) {
        const maxNet = Math.max(...(summary.top_net_buyers || []).map(b => Math.abs(b.net)));
        const maxNetSell = Math.max(...(summary.top_net_sellers || []).map(s => Math.abs(s.net)));
        const globalMax = Math.max(maxNet, maxNetSell);

        html = `
        <div class="row">
            <div class="col-6">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th class="text-end d-none d-md-table-cell">Net</th>
                            <th class="text-end d-none d-md-table-cell">Avg</th>
                            <th class="text-end d-none d-md-table-cell">Buy</th>
                            <th class="text-end d-none d-md-table-cell">Sell</th>
                            <th class="text-end">Buy Side Broker</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(summary.top_net_buyers || []).map((b, i) => {
            const ratio = globalMax > 0 ? Math.abs(b.net) / globalMax : 0;
            const percentage = Math.round(ratio * 95);
            const rowHeight = Math.max(35, Math.round(ratio * 60));
            const barWidth = Math.max(1, Math.round(ratio * 5));
            const rowStyle = `height: ${rowHeight}px; vertical-align: middle;`;
            const avg = b.bvol ? Math.round(b.bval / b.bvol) : 0;
            const barHtml = `<div style="position: absolute; top: 0; bottom: 0; right: 0; width: ${percentage}%; background-color: rgba(13, 202, 240, 0.25); border-right: ${barWidth}px solid #0aa2c0; z-index: 0;"></div>`;

            return `<tr style="${rowStyle}">
                            <td class="text-end fw-bold d-none d-md-table-cell" style="${STYLE_BUY_TEXT}">${fmt(b.net)}</td>
                            <td class="text-end d-none d-md-table-cell text-muted">${fmt(avg)}</td>
                            <td class="text-end d-none d-md-table-cell" style="${STYLE_BUY_TEXT}">${fmt(b.bval)}</td>
                            <td class="text-end d-none d-md-table-cell" style="${STYLE_SELL_TEXT}">${fmt(b.sval)}</td>
                            <td class="text-end" style="position: relative; padding-right: 8px;">
                                ${barHtml}
                                <span class="fw-bold ${getTextClass(b.code)} d-none d-md-inline" style="position: relative; z-index: 2;">${getBrokerLabel(b.code)}</span>
                                <span class="fw-bold ${getTextClass(b.code)} d-inline d-md-none" style="position: relative; z-index: 2;">${getBuySideLabel(b.code, b.net)}</span>
                            </td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="col-6">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th>Sell Side Broker</th>
                            <th class="text-start d-none d-md-table-cell">Buy</th>
                            <th class="text-start d-none d-md-table-cell">Sell</th>
                            <th class="text-start d-none d-md-table-cell">Avg</th>
                            <th class="text-start d-none d-md-table-cell">Net</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(summary.top_net_sellers || []).map((s, i) => {
            const ratio = globalMax > 0 ? Math.abs(s.net) / globalMax : 0;
            const percentage = Math.round(ratio * 95);
            const rowHeight = Math.max(35, Math.round(ratio * 60));
            const barWidth = Math.max(1, Math.round(ratio * 5));
            const rowStyle = `height: ${rowHeight}px; vertical-align: middle;`;
            const avg = s.svol ? Math.round(s.sval / s.svol) : 0;
            const barHtml = `<div style="position: absolute; top: 0; bottom: 0; left: 0; width: ${percentage}%; background-color: rgba(253, 126, 20, 0.25); border-left: ${barWidth}px solid #c66210; z-index: 0;"></div>`;

            return `<tr style="${rowStyle}">
                            <td style="position: relative; padding-left: 8px;">
                                ${barHtml}
                                <span class="fw-bold ${getTextClass(s.code)} d-none d-md-inline" style="position: relative; z-index: 2;">${getBrokerLabel(s.code)}</span>
                                <span class="fw-bold ${getTextClass(s.code)} d-inline d-md-none" style="position: relative; z-index: 2;">${getSellSideLabel(s.code, s.net)}</span>
                            </td>
                            <td class="text-start d-none d-md-table-cell" style="${STYLE_BUY_TEXT}">${fmt(s.bval)}</td>
                            <td class="text-start d-none d-md-table-cell" style="${STYLE_SELL_TEXT}">${fmt(s.sval)}</td>
                            <td class="text-start d-none d-md-table-cell text-muted">${fmt(avg)}</td>
                            <td class="text-start fw-bold d-none d-md-table-cell" style="${STYLE_SELL_TEXT}">${fmt(s.net)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    } else {
        // GROSS VIEW - uses bval/sval instead of val
        const maxBuy = Math.max(...(summary.top_buyers || []).map(b => b.bval || 0));
        const maxSell = Math.max(...(summary.top_sellers || []).map(s => s.sval || 0));

        html = `
        <div class="row">
            <div class="col-6">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th>Buy Side Broker</th>
                            <th class="text-end">Value</th>
                            <th class="text-end d-none d-md-table-cell">Avg</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${(summary.top_buyers || []).map((b, i) => {
            const buyVal = b.bval || 0;
            const ratio = maxBuy > 0 ? buyVal / maxBuy : 0;
            const percentage = Math.round(ratio * 95);
            const barWidth = maxBuy > 0 ? (buyVal / maxBuy) * 5 : 1;
            const avg = b.bvol ? Math.round(buyVal / b.bvol) : 0;
            const rowStyle = `background: linear-gradient(90deg, rgba(13, 202, 240, 0.25) ${percentage}%, transparent ${percentage}%) !important; vertical-align: middle; height: 35px;`;
            const borderStyle = `border-left: ${barWidth}px solid #0aa2c0; padding-left: 8px;`;

            return `<tr style="${rowStyle}">
                            <td style="${borderStyle}"><span class="fw-bold ${getTextClass(b.code)}">${getBrokerLabel(b.code)}</span></td>
                            <td class="text-end fw-bold" style="${STYLE_BUY_TEXT}">${fmt(buyVal)}</td>
                            <td class="text-end text-muted d-none d-md-table-cell">${fmt(avg)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
            <div class="col-6">
                <table class="table table-sm table-borderless small">
                    <thead>
                        <tr class="text-muted">
                            <th>Sell Side Broker</th>
                            <th class="text-end">Value</th>
                            <th class="text-end d-none d-md-table-cell">Avg</th>
                        </tr>
                    </thead>
                    <tbody>
                         ${(summary.top_sellers || []).map((s, i) => {
            const sellVal = s.sval || 0;
            const ratio = maxSell > 0 ? sellVal / maxSell : 0;
            const percentage = Math.round(ratio * 95);
            const barWidth = maxSell > 0 ? (sellVal / maxSell) * 5 : 1;
            const avg = s.svol ? Math.round(sellVal / s.svol) : 0;
            const rowStyle = `background: linear-gradient(90deg, rgba(253, 126, 20, 0.25) ${percentage}%, transparent ${percentage}%) !important; vertical-align: middle; height: 35px;`;
            const borderStyle = `border-left: ${barWidth}px solid #c66210; padding-left: 8px;`;

            return `<tr style="${rowStyle}">
                            <td style="${borderStyle}"><span class="fw-bold ${getTextClass(s.code)}">${getBrokerLabel(s.code)}</span></td>
                            <td class="text-end fw-bold" style="${STYLE_SELL_TEXT}">${fmt(sellVal)}</td>
                            <td class="text-end text-muted d-none d-md-table-cell">${fmt(avg)}</td>
                        </tr>`;
        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    $('#broker-table-container').append(html);
}

function formatCompactNumber(number) {
    if (number === 0) return '0';
    const abs = Math.abs(number);
    if (abs >= 1e12) return (number / 1e12).toFixed(1) + 'T';
    if (abs >= 1e9) return (number / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (number / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return (number / 1e3).toFixed(1) + 'K';
    return number.toLocaleString();
}

let myChart = null;
function renderChart(history) {
    const ctx = document.getElementById('detailChart').getContext('2d');
    if (myChart) myChart.destroy();

    // Sort and filter out NA/holiday days (days with no actual trading activity)
    history.sort((a, b) => new Date(a.date) - new Date(b.date));
    const validHistory = history.filter(h => {
        if (!h.data) return false;
        // Check if there's actual trading activity in ANY category (foreign, retail, or local)
        const f = h.data.foreign || {};
        const r = h.data.retail || {};
        const l = h.data.local || {};
        const hasActivity = (f.buy_val > 0 || f.sell_val > 0) ||
                           (r.buy_val > 0 || r.sell_val > 0) ||
                           (l.buy_val > 0 || l.sell_val > 0);
        return hasActivity;
    });

    const labels = validHistory.map(h => {
        const d = new Date(h.date);
        return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    let accF = 0, accR = 0, accL = 0;
    const fData = validHistory.map(h => { accF += (h.data.foreign?.net_val || 0); return accF; });
    const rData = validHistory.map(h => { accR += (h.data.retail?.net_val || 0); return accR; });
    const lData = validHistory.map(h => { accL += (h.data.local?.net_val || 0); return accL; });

    // Price Data (Avg Price)
    const priceData = validHistory.map(h => h.data.price || null);

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Price (Avg)',
                    data: priceData,
                    borderColor: '#f59e0b', // Amber/Gold
                    backgroundColor: '#f59e0b',
                    borderWidth: 2,
                    pointRadius: 2, // Visible points
                    borderDash: [5, 5], // Dotted Line
                    yAxisID: 'y1',
                    tension: 0.1
                },
                { label: 'Foreign', data: fData, borderColor: '#198754', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                { label: 'Retail', data: rData, borderColor: '#dc3545', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                { label: 'Local', data: lData, borderColor: '#0d6efd', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
            },
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#9ca3af' },
                    border: { color: '#ffffff' }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    grid: { display: false },
                    ticks: {
                        color: '#9ca3af',
                        callback: function (value) {
                            return formatCompactNumber(value);
                        }
                    },
                    border: { color: '#ffffff' }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    grid: { display: false },
                    ticks: {
                        color: '#f59e0b', // Gold color for price ticks
                        callback: function (value) {
                            return value.toLocaleString();
                        }
                    },
                    border: { display: false } // No border line for clean look
                }
            }
        },
        plugins: [{
            id: 'zeroLine',
            afterDatasetsDraw: (chart) => {
                const ctx = chart.ctx;
                const yScale = chart.scales.y;
                const xScale = chart.scales.x;

                // Get y position for value 0
                const yPos = yScale.getPixelForValue(0);

                // Only draw if 0 is within the visible range
                if (yPos >= yScale.top && yPos <= yScale.bottom) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.setLineDash([5, 5]); // Dashed line
                    ctx.strokeStyle = '#9ca3af'; // Grey for visibility on white bg
                    ctx.lineWidth = 1.5;
                    ctx.moveTo(xScale.left, yPos);
                    ctx.lineTo(xScale.right, yPos);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }]
    });
}

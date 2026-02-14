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
    $('#nav-back').addClass('d-none');
    loadScreenerData();
}

// Global state for sorting and pagination
let currentCandidates = [];
let allCandidates = []; // Unfiltered cache
let sortState = { key: 'sm2', desc: true };
const SCREENER_PAGE_SIZE = 100;
let screenerPage = 1;
let accumFilter = 'all'; // legacy compat
// Active filter state
const activeFilters = {
    foreign: 'any',   // any | allPos | dominant
    smart:   'any',   // any | allPos | positive
    streak:  'any',   // any | s3 | trend5up | trend10up | trend20up
    zeffort: 'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    zngr:    'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    zvwap:   'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    effort:  'any',   // any | high | positive
    state:   'any',   // any | accum | markup
    horizon:  'any'    // any | 2 | 5 | 10 | 20
};
let activePreset = 'all';
const visibleHorizonCols = { "2": true, "5": true, "10": true, "20": true };

// Preset recipes
const PRESETS = {
    strict: { foreign:'allPos', smart:'allPos', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any' },
    smart:  { foreign:'any',    smart:'allPos', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any' },
    all:    { foreign:'any',    smart:'any',    streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any' }
};

const PRESET_DESC = {
    strict: 'Foreign & Smart Money positif tiap hari',
    smart:  'Smart Money positif tiap hari',
    all:    'Tanpa filter'
};

const FILTER_LABELS = {
    foreign: { any:'Any', allPos:'Positif tiap hari', dominant:'Kumulatif > 0' },
    smart:   { any:'Any', allPos:'Positif tiap hari', positive:'Kumulatif > 0' },
    streak:  { any:'Any', s3:'Streak ≥ 3 hari', trend5up:'Trend 5D Up', trend10up:'Trend 10D Up', trend20up:'Trend 20D Up' },
    zeffort: { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    zngr:    { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    zvwap:   { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    effort:  { any:'Any', high:'High (z > 1)', positive:'Positif (z > 0)' },
    state:   { any:'Any', accum:'Accumulation', markup:'Accum / Ready Markup' },
    horizon:  { any:'Any horizon', '2':'2D only', '5':'5D only', '10':'10D only', '20':'20D only' }
};

const PILL_COLORS = {
    foreign:'success', smart:'primary', streak:'warning', zeffort:'dark', zngr:'dark', zvwap:'dark', effort:'info', state:'danger', horizon:'secondary'
};

async function loadScreenerData() {
    try {
        $('#loading-indicator').show();
        $('#tbody-index').html('');

        const response = await fetch(`${WORKER_BASE_URL}/screener-accum`);
        if (!response.ok) {
            throw new Error(`screener-accum HTTP ${response.status}`);
        }
        const data = await response.json();

        if (!data || !Array.isArray(data.items) || data.items.length === 0) {
            $('#tbody-index').html('<tr><td colspan="19" class="text-center text-muted">Accum data not yet generated.</td></tr>');
            return;
        }

        // Map all items with all windows
        allCandidates = data.items.map(i => {
            const state = i.s ? mapState(i.s) : 'NEUTRAL';
            const effort2 = i.z?.["2"]?.e ?? i.z?.["5"]?.e ?? 0;
            const effort5 = i.z?.["5"]?.e ?? 0;
            const effort10 = i.z?.["10"]?.e ?? 0;
            const effort20 = i.z?.["20"]?.e ?? 0;

            const resultZ = i.z?.["20"]?.r || 0;
            const ngr20 = i.z?.["20"]?.n || 0;
            const ngr2 = i.z?.["2"]?.n ?? i.z?.["5"]?.n ?? ngr20;
            const ngr5 = i.z?.["5"]?.n ?? ngr20;
            const ngr10 = i.z?.["10"]?.n ?? ngr20;
            const elasticity = i.z?.["20"]?.el || 0;
            // Backend lama belum expose window "2" untuk z-score, fallback ke 5D agar kolom tidak kosong.
            const vwap2Raw = i.z?.["2"]?.v ?? i.z?.["5"]?.v;
            const vwap5Raw = i.z?.["5"]?.v;
            const vwap10Raw = i.z?.["10"]?.v;
            const vwap20Raw = i.z?.["20"]?.v;
            const vwap2 = (typeof vwap2Raw === 'number' && Number.isFinite(vwap2Raw)) ? vwap2Raw : null;
            const vwap5 = (typeof vwap5Raw === 'number' && Number.isFinite(vwap5Raw)) ? vwap5Raw : null;
            const vwap10 = (typeof vwap10Raw === 'number' && Number.isFinite(vwap10Raw)) ? vwap10Raw : null;
            const vwap20 = (typeof vwap20Raw === 'number' && Number.isFinite(vwap20Raw)) ? vwap20Raw : null;

            const stateBonus = (state === 'ACCUMULATION' || state === 'READY_MARKUP') ? 2
                : (state === 'TRANSITION') ? 1 : 0;
            const calcFlow = (eff, ngrVal) => {
                const effortBonus = eff > 0 ? Math.min(eff * 2, 4) : 0;
                const ngrBonus = ngrVal > 0 ? 1 : 0;
                return effortBonus + stateBonus + ngrBonus;
            };

            const flow2 = calcFlow(effort2, ngr2);
            const flow5 = calcFlow(effort5, ngr5);
            const flow10 = calcFlow(effort10, ngr10);
            const flow20 = calcFlow(effort20, ngr20);

            return {
                symbol: i.t,
                state,
                score: flow20,
                flow2,
                flow5,
                flow10,
                flow20,
                // Per-window accum data
                w2: i.accum?.["2"] || null,
                w5: i.accum?.["5"] || null,
                w10: i.accum?.["10"] || null,
                w20: i.accum?.["20"] || null,
                // Shortcut for sorting
                sm2:  i.accum?.["2"]?.sm || 0,
                sm5:  i.accum?.["5"]?.sm || 0,
                sm10: i.accum?.["10"]?.sm || 0,
                sm20: i.accum?.["20"]?.sm || 0,
                metrics: {
                    effort2, effort5, effort10, effort20,
                    ngr2, ngr5, ngr10, ngr20,
                    resultZ, ngr: ngr20, elasticity,
                    vwap2, vwap5, vwap10, vwap20
                },
                trend: {
                    // Use per-day averages to avoid bias from cumulative window length differences.
                    avg2:  (i.accum?.["2"]?.sm || 0) / 2,
                    avg5:  (i.accum?.["5"]?.sm || 0) / 5,
                    avg10: (i.accum?.["10"]?.sm || 0) / 10,
                    avg20: (i.accum?.["20"]?.sm || 0) / 20,
                    effortUp: effort2 >= effort5 && effort5 >= effort10 && effort10 >= effort20,
                    ngrUp: (ngr2 >= ngr5) && (ngr5 >= ngr10) && (ngr10 >= ngr20),
                    vwapUp: (vwap2 ?? -Infinity) >= (vwap5 ?? -Infinity) &&
                            (vwap5 ?? -Infinity) >= (vwap10 ?? -Infinity) &&
                            (vwap10 ?? -Infinity) >= (vwap20 ?? -Infinity)
                }
            };
        }).filter(Boolean);

        applyFilter();
        loadForeignSentiment();

    } catch (error) {
        console.error('[Brokerflow] loadScreenerData failed:', error);
        $('#tbody-index').html('<tr><td colspan="19" class="text-center text-danger">Error loading screener data</td></tr>');
    } finally {
        $('#loading-indicator').hide();
        $('#app').fadeIn();
    }
}

/**
 * Apply client-side filters and re-render.
 * Filters are checked per-window. If window selector is 'any', candidate passes if ANY window passes.
 * If a specific window is selected, only that window is checked.
 */
function applyFilter() {
    const wKey = activeFilters.horizon;

    currentCandidates = allCandidates.filter(c => {
        // Determine which windows to check
        const windowsToCheck = wKey === 'any'
            ? [c.w2, c.w5, c.w10, c.w20].filter(Boolean)
            : [c[`w${wKey}`]].filter(Boolean);

        if (windowsToCheck.length === 0) return false;

        // Each window must pass ALL active criteria for that window
        return windowsToCheck.some(w => {
            // Foreign filter
            if (activeFilters.foreign === 'allPos' && !w.foreignAllPos) return false;
            if (activeFilters.foreign === 'dominant' && !w.foreignDominant) return false;

            // Smart Money filter
            if (activeFilters.smart === 'allPos' && !w.allPos) return false;
            if (activeFilters.smart === 'positive' && (w.sm || 0) <= 0) return false;

            // Streak / Trend filter
            if (activeFilters.streak === 's3') {
                if ((w.streak || 0) < 3) return false;
            } else if (activeFilters.streak === 'trend5up') {
                if (!(c.trend.avg2 > c.trend.avg5)) return false;
            } else if (activeFilters.streak === 'trend10up') {
                if (!(c.trend.avg5 > c.trend.avg10)) return false;
            } else if (activeFilters.streak === 'trend20up') {
                if (!(c.trend.avg10 > c.trend.avg20)) return false;
            }

            return true;
        });
    });

    // Z-score relation filters (candidate-level, AND across selected dropdowns)
    currentCandidates = currentCandidates.filter(c => {
        if (!matchesZRelation(activeFilters.zeffort, c.metrics.effort2, c.metrics.effort5, c.metrics.effort10, c.metrics.effort20)) return false;
        if (!matchesZRelation(activeFilters.zngr, c.metrics.ngr2, c.metrics.ngr5, c.metrics.ngr10, c.metrics.ngr20)) return false;
        if (!matchesZRelation(activeFilters.zvwap, c.metrics.vwap2, c.metrics.vwap5, c.metrics.vwap10, c.metrics.vwap20)) return false;
        return true;
    });

    // Non-horizon filters (effort, state) — applied on candidate level
    if (activeFilters.effort !== 'any') {
        currentCandidates = currentCandidates.filter(c => {
            const ez = c.metrics.effort20;
            if (activeFilters.effort === 'high') return ez > 1;
            if (activeFilters.effort === 'positive') return ez > 0;
            return true;
        });
    }
    if (activeFilters.state !== 'any') {
        currentCandidates = currentCandidates.filter(c => {
            if (activeFilters.state === 'accum') return c.state === 'ACCUMULATION';
            if (activeFilters.state === 'markup') return c.state === 'ACCUMULATION' || c.state === 'READY_MARKUP';
            return true;
        });
    }

    $('#screener-count').text(`${currentCandidates.length} emiten`);
    renderFilterPills();
    sortCandidates(sortState.key, sortState.desc);
}

function matchesZRelation(mode, z2, z5, z10, z20) {
    if (!mode || mode === 'any') return true;
    if (![z2, z5, z10, z20].every(v => typeof v === 'number' && Number.isFinite(v))) return false;

    if (mode === '2gt5') return z2 > z5;
    if (mode === '2gt10') return z2 > z10;
    if (mode === '2gt20') return z2 > z20;
    if (mode === '5gt10') return z5 > z10;
    if (mode === '5gt20') return z5 > z20;
    if (mode === '10gt20') return z10 > z20;
    if (mode === 'ladderUp') return z2 >= z5 && z5 >= z10 && z10 >= z20;
    return true;
}

// Foreign Sentiment Chart - Cumulative of 10 MVP Stocks
let foreignSentimentChart = null;
let currentForeignDays = 7;

async function loadForeignSentiment(days = 7) {
    try {
        currentForeignDays = days;
        
        // Show loading, hide chart
        $('#foreign-chart-loading').show().html(`
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">Loading...</span>
            </div>
            <p class="small text-muted mt-2 mb-0">Memuat data foreign flow...</p>
        `);
        $('#foreign-chart-container').hide();
        
        const response = await fetch(`${WORKER_BASE_URL}/foreign-sentiment?days=${days}`);
        const data = await response.json();
        
        if (!data || !data.cumulative || !data.dates) {
            $('#foreign-chart-loading').html('<p class="small text-muted mb-0">Data tidak tersedia</p>');
            return;
        }
        
        // Hide loading, show chart
        $('#foreign-chart-loading').hide();
        $('#foreign-chart-container').show();
        
        const dates = data.dates;
        const cumulative = data.cumulative;
        
        // Prepare cumulative net values (in Billion)
        const netValues = cumulative.map(d => d.net / 1e9);
        
        const ctx = document.getElementById('foreign-sentiment-chart').getContext('2d');
        
        if (foreignSentimentChart) {
            foreignSentimentChart.destroy();
        }
        
        foreignSentimentChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: dates.map(d => {
                    const dt = new Date(d);
                    return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
                }),
                datasets: [{
                    label: 'Foreign Net Flow',
                    data: netValues,
                    borderColor: '#0d6efd',
                    backgroundColor: 'rgba(13, 110, 253, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    pointRadius: 4,
                    pointBackgroundColor: netValues.map(v => v >= 0 ? '#198754' : '#dc3545'),
                    pointBorderColor: netValues.map(v => v >= 0 ? '#198754' : '#dc3545'),
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(ctx) {
                                const val = ctx.parsed.y;
                                const status = val >= 0 ? '📈 Inflow' : '📉 Outflow';
                                return `${status}: Rp ${Math.abs(val).toFixed(1)} B`;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        title: {
                            display: true,
                            text: 'Net Flow (Rp B)',
                            font: { size: 10 }
                        },
                        ticks: { font: { size: 9 } },
                        grid: {
                            color: function(context) {
                                if (context.tick.value === 0) return '#6c757d';
                                return 'rgba(0,0,0,0.05)';
                            },
                            lineWidth: function(context) {
                                if (context.tick.value === 0) return 2;
                                return 1;
                            }
                        }
                    },
                    x: {
                        ticks: { font: { size: 9 } }
                    }
                }
            }
        });
        
        // Update widget title with total
        const totalNet = netValues.reduce((a, b) => a + b, 0);
        const trend = totalNet >= 0 ? 'text-success' : 'text-danger';
        const arrow = totalNet >= 0 ? '↑' : '↓';
        $('#foreign-sentiment-widget h6').html(`Foreign Flow 10 Saham Cap Terbesar<span class="d-block mb-3 mt-2 ${trend} fw-bold" style="font-size:2rem"><i style="font-weight:900">${arrow}</i> Rp ${Math.abs(totalNet).toFixed(1)} B</span>`);
        
    } catch (e) {
        console.error('Error loading foreign sentiment:', e);
        $('#foreign-chart-loading').html('<p class="small text-danger mb-0">Gagal memuat data</p>');
    }
}

// Foreign range selector click handler
$(document).on('click', '#foreign-range-selector a', function(e) {
    e.preventDefault();
    const days = $(this).data('days');
    $('#foreign-range-selector a').removeClass('active');
    $(this).addClass('active');
    loadForeignSentiment(days);
});

// ========== PRESET SELECTOR ==========
$(document).on('click', '#preset-selector a', function(e) {
    e.preventDefault();
    const preset = $(this).data('preset');
    applyPreset(preset);
});

function applyPreset(name) {
    const recipe = PRESETS[name];
    if (!recipe) return;
    activePreset = name;
    Object.assign(activeFilters, recipe);
    // Update preset buttons
    $('#preset-selector a').removeClass('active');
    $(`#preset-selector a[data-preset="${name}"]`).addClass('active');
    $('#preset-desc').text(PRESET_DESC[name] || '');
    syncFilterDropdowns();
    applyFilter();
}

// ========== INDIVIDUAL FILTER DROPDOWNS ==========
$(document).on('click', '[data-filter][data-val]', function(e) {
    e.preventDefault();
    const key = $(this).data('filter');
    const val = $(this).data('val').toString();
    activeFilters[key] = val;
    // Update button label
    syncFilterDropdowns();
    // Detect if current filters match a preset
    detectMatchingPreset();
    applyFilter();
});

function syncFilterDropdowns() {
    Object.keys(FILTER_LABELS).forEach(key => {
        const ddId = key === 'horizon' ? '#dd-horizon' : `#dd-${key}`;
        const label = FILTER_LABELS[key][activeFilters[key]] || 'Any';
        const prefix = key === 'foreign' ? 'Foreign'
            : key === 'smart' ? 'Smart'
            : key === 'streak' ? 'Trend'
            : key === 'zeffort' ? 'Effort Rel'
            : key === 'zngr' ? 'NGR Rel'
            : key === 'zvwap' ? 'VWAP Rel'
            : key === 'effort' ? 'Effort'
            : key === 'state' ? 'State'
            : key === 'horizon' ? 'Horizon'
            : '';
        if (key === 'horizon') {
            $(ddId).text(`Horizon: ${label}`);
        } else {
            $(ddId).text(`${prefix}: ${label}`);
        }
        // Highlight active dropdown when not 'any'
        if (activeFilters[key] !== 'any') {
            $(ddId).removeClass('btn-outline-secondary btn-outline-info').addClass(key === 'horizon' ? 'btn-info text-white' : `btn-${PILL_COLORS[key]} text-white`);
        } else {
            $(ddId).removeClass(`btn-${PILL_COLORS[key]} btn-info text-white`).addClass(key === 'horizon' ? 'btn-outline-info' : 'btn-outline-secondary');
        }
    });
}

function detectMatchingPreset() {
    for (const [name, recipe] of Object.entries(PRESETS)) {
        const match = Object.keys(recipe).every(k => activeFilters[k] === recipe[k]);
        if (match) {
            activePreset = name;
            $('#preset-selector a').removeClass('active');
            $(`#preset-selector a[data-preset="${name}"]`).addClass('active');
            $('#preset-desc').text(PRESET_DESC[name] || '');
            return;
        }
    }
    // No preset match — custom
    activePreset = 'custom';
    $('#preset-selector a').removeClass('active');
    $('#preset-desc').text('Custom filter');
}

function renderFilterPills() {
    const $pills = $('#active-pills');
    $pills.empty();
    Object.keys(FILTER_LABELS).forEach(key => {
        if (activeFilters[key] !== 'any') {
            const label = FILTER_LABELS[key][activeFilters[key]];
            const color = PILL_COLORS[key] || 'secondary';
            const prefix = key === 'foreign' ? 'Foreign'
                : key === 'smart' ? 'Smart'
                : key === 'streak' ? 'Trend'
                : key === 'zeffort' ? 'Effort Rel'
                : key === 'zngr' ? 'NGR Rel'
                : key === 'zvwap' ? 'VWAP Rel'
                : key === 'effort' ? 'Effort'
                : key === 'state' ? 'State'
                : key === 'horizon' ? 'Horizon'
                : key;
            $pills.append(`
                <span class="badge bg-${color} bg-opacity-10 text-${color}" style="cursor:pointer;" data-remove-filter="${key}">
                    ${prefix}: ${label} <i class="fa-solid fa-xmark ms-1"></i>
                </span>
            `);
        }
    });
}

// Click pill X to remove that individual filter
$(document).on('click', '[data-remove-filter]', function() {
    const key = $(this).data('remove-filter');
    activeFilters[key] = 'any';
    syncFilterDropdowns();
    detectMatchingPreset();
    applyFilter();
});

function sortCandidates(key, desc) {
    currentCandidates.sort((a, b) => {
        let valA, valB;

        // Extract values based on key
        if (key === 'symbol') { valA = a.symbol; valB = b.symbol; }
        else if (key === 'state') { valA = a.state; valB = b.state; }
        else if (key === 'score') { valA = a.score; valB = b.score; }
        else if (key === 'flow2') { valA = a.flow2 || 0; valB = b.flow2 || 0; }
        else if (key === 'flow5') { valA = a.flow5 || 0; valB = b.flow5 || 0; }
        else if (key === 'flow10') { valA = a.flow10 || 0; valB = b.flow10 || 0; }
        else if (key === 'flow20') { valA = a.flow20 || 0; valB = b.flow20 || 0; }
        else if (key === 'sm2')  { valA = a.sm2  || 0; valB = b.sm2  || 0; }
        else if (key === 'sm5')  { valA = a.sm5  || 0; valB = b.sm5  || 0; }
        else if (key === 'sm10') { valA = a.sm10 || 0; valB = b.sm10 || 0; }
        else if (key === 'sm20') { valA = a.sm20 || 0; valB = b.sm20 || 0; }
        else if (key === 'vwap2') {
            valA = (typeof a.metrics.vwap2 === 'number' && Number.isFinite(a.metrics.vwap2)) ? a.metrics.vwap2 : -Infinity;
            valB = (typeof b.metrics.vwap2 === 'number' && Number.isFinite(b.metrics.vwap2)) ? b.metrics.vwap2 : -Infinity;
        }
        else if (key === 'vwap5') {
            valA = (typeof a.metrics.vwap5 === 'number' && Number.isFinite(a.metrics.vwap5)) ? a.metrics.vwap5 : -Infinity;
            valB = (typeof b.metrics.vwap5 === 'number' && Number.isFinite(b.metrics.vwap5)) ? b.metrics.vwap5 : -Infinity;
        }
        else if (key === 'vwap10') {
            valA = (typeof a.metrics.vwap10 === 'number' && Number.isFinite(a.metrics.vwap10)) ? a.metrics.vwap10 : -Infinity;
            valB = (typeof b.metrics.vwap10 === 'number' && Number.isFinite(b.metrics.vwap10)) ? b.metrics.vwap10 : -Infinity;
        }
        else if (key === 'vwap20') {
            valA = (typeof a.metrics.vwap20 === 'number' && Number.isFinite(a.metrics.vwap20)) ? a.metrics.vwap20 : -Infinity;
            valB = (typeof b.metrics.vwap20 === 'number' && Number.isFinite(b.metrics.vwap20)) ? b.metrics.vwap20 : -Infinity;
        }
        else if (key === 'effort') { valA = a.metrics.effort20; valB = b.metrics.effort20; }
        else if (key === 'effort2') { valA = a.metrics.effort2; valB = b.metrics.effort2; }
        else if (key === 'effort5') { valA = a.metrics.effort5; valB = b.metrics.effort5; }
        else if (key === 'effort10') { valA = a.metrics.effort10; valB = b.metrics.effort10; }
        else if (key === 'effort20') { valA = a.metrics.effort20; valB = b.metrics.effort20; }
        else if (key === 'response') { valA = a.metrics.resultZ; valB = b.metrics.resultZ; }
        else if (key === 'quality') { valA = a.metrics.ngr; valB = b.metrics.ngr; }
        else if (key === 'elasticity') { valA = a.metrics.elasticity; valB = b.metrics.elasticity; }
        else { valA = 0; valB = 0; }

        if (typeof valA === 'string') {
            return desc ? valB.localeCompare(valA) : valA.localeCompare(valB);
        }
        return desc ? valB - valA : valA - valB;
    });

    screenerPage = 1; // Reset to first page
    updateScreenerDisplay();
    updateSortIcons(key, desc);
}

// Pagination functions
function updateScreenerDisplay() {
    const totalRows = currentCandidates.length;
    const totalPages = Math.ceil(totalRows / SCREENER_PAGE_SIZE);
    
    if (screenerPage < 1) screenerPage = 1;
    if (screenerPage > totalPages) screenerPage = totalPages;
    if (totalPages === 0) screenerPage = 1;
    
    const startIdx = (screenerPage - 1) * SCREENER_PAGE_SIZE;
    const endIdx = Math.min(startIdx + SCREENER_PAGE_SIZE, totalRows);
    const pageRows = currentCandidates.slice(startIdx, endIdx);
    
    renderScreenerTable(pageRows);
    
    // Update pagination UI
    $('#total-items').text(totalRows);
    $('#page-range').text(`${startIdx + 1}-${endIdx}`);
    $('#current-page-num').text(screenerPage);
    $('#total-pages').text(`/ ${totalPages}`);
    
    $('#prev-page').toggleClass('disabled', screenerPage <= 1);
    $('#next-page').toggleClass('disabled', screenerPage >= totalPages);
}

function changeScreenerPage(delta) {
    screenerPage += delta;
    updateScreenerDisplay();
    $('html, body').animate({ scrollTop: $('#market-breadth-widget').offset().top - 60 }, 200);
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
function getBadge(val, type, showScore = false) {
    const score = showScore ? ` <small class="text-muted">(${val.toFixed(2)})</small>` : '';
    if (type === 'effort') {
        if (typeof val !== 'number' || !Number.isFinite(val)) return `<span class="text-muted">-</span>`;
        const cls = val > 0 ? 'text-success' : (val < 0 ? 'text-danger' : 'text-secondary');
        return `<span class="${cls}">${val.toFixed(2)}</span>${score}`;
    }
    if (type === 'result') {
        if (val > 1.0) return `<span class="text-danger fw-bold">Volatile</span>${score}`;
        if (val < -0.5) return `<span class="text-muted">Quiet</span>${score}`;
        return `<span class="text-secondary">Normal</span>${score}`;
    }
    if (type === 'ngr') {
        if (val < 0.15) return `<span class="text-muted">Noise</span>${score}`;
        return `<span class="text-success fw-bold">Valid</span>${score}`;
    }
    if (type === 'elasticity') {
        if (val === 0) return `<span class="text-muted">-</span>`;
        if (val > 1.5) return `<span class="text-success fw-bold">Elastic</span>${score}`;
        if (val < 0.5) return `<span class="text-danger">Rigid</span>${score}`;
        return `<span class="text-secondary">Normal</span>${score}`;
    }
    if (type === 'vwap') {
        if (typeof val !== 'number' || !Number.isFinite(val)) return `<span class="text-muted">-</span>`;
        const cls = val > 0 ? 'text-success' : (val < 0 ? 'text-danger' : 'text-secondary');
        return `<span class="${cls}">${val.toFixed(2)}</span>`;
    }
    return val;
}

function renderScreenerTable(candidates) {
    const tbody = $('#tbody-index');
    tbody.empty();

    const getStateText = (state) => {
        const styles = {
            'READY_MARKUP': 'color:#fd7e14;font-weight:bold',
            'TRANSITION': 'color:#0d6efd',
            'ACCUMULATION': 'color:#198754;font-weight:bold',
            'DISTRIBUTION': 'color:#dc3545;font-weight:bold',
            'NEUTRAL': 'color:#6c757d'
        };
        const labels = {
            'READY_MARKUP': 'Ready',
            'TRANSITION': 'Trans',
            'ACCUMULATION': 'Accum',
            'DISTRIBUTION': 'Dist',
            'NEUTRAL': 'Neutral'
        };
        return `<span style="${styles[state] || 'color:#6c757d'}">${labels[state] || state}</span>`;
    };
    
    // Flow Score - simple number with color
    const getFlowScore = (score) => {
        if (score >= 5) return `<span class="text-success fw-bold">${score.toFixed(1)}</span>`;
        if (score >= 3) return `<span class="text-primary fw-bold">${score.toFixed(1)}</span>`;
        if (score >= 1) return `<span style="color:#fd7e14" class="fw-bold">${score.toFixed(1)}</span>`;
        return `<span class="text-muted">${score.toFixed(1)}</span>`;
    };

    // Format smart money value per window cell
    const fmtSm = (wData) => {
        if (!wData) return '<span class="text-muted">-</span>';
        const val = wData.sm || 0;
        const abs = Math.abs(val);
        let formatted;
        if (abs >= 1e12) formatted = (val / 1e12).toFixed(1) + 'T';
        else if (abs >= 1e9) formatted = (val / 1e9).toFixed(1) + 'B';
        else if (abs >= 1e6) formatted = (val / 1e6).toFixed(0) + 'M';
        else if (abs === 0) return '<span class="text-muted">0</span>';
        else formatted = (val / 1e6).toFixed(0) + 'M';

        const color = val > 0 ? 'text-success' : 'text-danger';
        // Indicator: ● green if foreignAllPos+allPos, ◐ blue if allPos only
        let indicator = '';
        if (wData.foreignAllPos && wData.allPos) indicator = '<span class="text-success" style="font-size:0.55rem;">●</span> ';
        else if (wData.allPos) indicator = '<span class="text-primary" style="font-size:0.55rem;">◐</span> ';
        const streak = wData.streak || 0;
        const streakBadge = streak >= 3 ? `<sup class="text-success" style="font-size:0.55rem;">${streak}🔥</sup>` : '';
        return `${indicator}<span class="${color} fw-bold" >${formatted}</span>${streakBadge}`;
    };

    candidates.forEach((item, idx) => {
        const m = item.metrics;
        const logoUrl = `https://api-saham.mkemalw.workers.dev/logo?symbol=${item.symbol}`;
        const row = `
            <tr onclick="window.location.href='?kode=${item.symbol}'" style="cursor:pointer;">
                <td class="text-center text-muted small">${idx + 1}</td>
                <td class="fw-bold">
                    <img src="${logoUrl}" alt="" style="height: 20px; width: auto; margin-right: 6px; vertical-align: middle; border-radius: 3px;" onerror="this.style.display='none'">
                    <a href="?kode=${item.symbol}" style="text-decoration:none;">${item.symbol}</a>
                </td>
                <td class="text-center col-h2">${fmtSm(item.w2)}</td>
                <td class="text-center col-h5">${fmtSm(item.w5)}</td>
                <td class="text-center hide-mobile col-h10">${fmtSm(item.w10)}</td>
                <td class="text-center hide-mobile col-h20">${fmtSm(item.w20)}</td>
                <td class="text-center hide-mobile col-h2">${getBadge(m.vwap2, 'vwap')}</td>
                <td class="text-center hide-mobile col-h5">${getBadge(m.vwap5, 'vwap')}</td>
                <td class="text-center hide-mobile col-h10">${getBadge(m.vwap10, 'vwap')}</td>
                <td class="text-center hide-mobile col-h20">${getBadge(m.vwap20, 'vwap')}</td>
                <td class="text-center col-h2">${getFlowScore(item.flow2)}</td>
                <td class="text-center col-h5">${getFlowScore(item.flow5)}</td>
                <td class="text-center hide-mobile col-h10">${getFlowScore(item.flow10)}</td>
                <td class="text-center hide-mobile col-h20">${getFlowScore(item.flow20)}</td>
                <td class="text-center col-h2">${getBadge(m.effort2, 'effort')}</td>
                <td class="text-center col-h5">${getBadge(m.effort5, 'effort')}</td>
                <td class="text-center hide-mobile col-h10">${getBadge(m.effort10, 'effort')}</td>
                <td class="text-center hide-mobile col-h20">${getBadge(m.effort20, 'effort')}</td>
                <td class="text-center">${getStateText(item.state)}</td>
            </tr>
        `;
        tbody.append(row);
    });

    applyColumnVisibility();
}

function applyColumnVisibility() {
    ['2', '5', '10', '20'].forEach(h => {
        const show = visibleHorizonCols[h] !== false;
        $(`.col-h${h}`).toggleClass('d-none', !show);
    });
}

$(document).on('change', '[data-view-horizon]', function() {
    const h = String($(this).data('view-horizon'));
    visibleHorizonCols[h] = $(this).is(':checked');

    const activeCount = Object.values(visibleHorizonCols).filter(Boolean).length;
    const suffix = activeCount === 4 ? 'All' : `${activeCount}/4`;
    $('#dd-view').html(`<i class="fa-solid fa-eye me-1"></i>View: ${suffix}`);

    applyColumnVisibility();
});

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
                $('#feat-vwap').html(getBadge(z.v ?? null, 'vwap'));
                $('#feat-elasticity').html(getBadge(z.el || 0, 'elasticity'));
                $('#feat-state').html(getStateBadgeSimple(state));
                $('#zscore-features-card').removeClass('d-none');
                // /screener only contains { t, s, sc, z }.
                // Fetch accum windows from /screener-accum so "Accum 2D/5D/10D/20D" is not blank.
                const accumItem = await fetchAccumItemBySymbol(symbol);
                const itemWithAccum = accumItem ? { ...item, accum: accumItem.accum } : item;
                renderHorizonMetricsFromScreener(itemWithAccum, state);
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
            $('#feat-vwap').html(getBadge(features.vwap ?? null, 'vwap'));
            $('#feat-elasticity').html(getBadge(features.elasticity, 'elasticity'));
            $('#feat-state').html(getStateBadgeSimple(features.state));
            $('#zscore-features-card').removeClass('d-none');
            $('#horizon-metrics-card').addClass('d-none');
            return;
        }
        
        // No data available - hide card
        console.log(`[ZScore] No data, hiding card`);
        $('#zscore-features-card').addClass('d-none');
        $('#horizon-metrics-card').addClass('d-none');
        
    } catch (error) {
        console.error('[ZScore] Error:', error);
        $('#zscore-features-card').addClass('d-none');
        $('#horizon-metrics-card').addClass('d-none');
    }
}

async function fetchAccumItemBySymbol(symbol) {
    try {
        const resp = await fetch(`${WORKER_BASE_URL}/screener-accum`);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || !Array.isArray(data.items)) return null;
        return data.items.find(i => i.t === symbol) || null;
    } catch (e) {
        console.warn(`[Accum] Failed to fetch screener-accum for ${symbol}:`, e);
        return null;
    }
}

function renderHorizonMetricsFromScreener(item, mappedState) {
    const windows = ["2", "5", "10", "20"];
    const z = item?.z || {};
    const accum = item?.accum || {};
    const stateBonus = (mappedState === 'ACCUMULATION' || mappedState === 'READY_MARKUP') ? 2
        : (mappedState === 'TRANSITION') ? 1 : 0;

    const getZVal = (w, key) => {
        if (typeof z?.[w]?.[key] === 'number' && Number.isFinite(z[w][key])) return z[w][key];
        if (w === "2" && typeof z?.["5"]?.[key] === 'number' && Number.isFinite(z["5"][key])) return z["5"][key];
        if (typeof z?.["20"]?.[key] === 'number' && Number.isFinite(z["20"][key])) return z["20"][key];
        return null;
    };

    const calcFlow = (eff, ngrVal) => {
        if (typeof eff !== 'number' || !Number.isFinite(eff) || typeof ngrVal !== 'number' || !Number.isFinite(ngrVal)) {
            return null;
        }
        const effortBonus = eff > 0 ? Math.min(eff * 2, 4) : 0;
        const ngrBonus = ngrVal > 0 ? 1 : 0;
        return effortBonus + stateBonus + ngrBonus;
    };

    const byWindow = {};
    windows.forEach(w => {
        const effort = getZVal(w, 'e');
        const ngr = getZVal(w, 'n');
        byWindow[w] = {
            smartMoney: accum?.[w]?.sm ?? null,
            vwap: getZVal(w, 'v'),
            effort,
            flow: calcFlow(effort, ngr)
        };
    });

    const fmtSmartMoney = (val) => {
        if (typeof val !== 'number' || !Number.isFinite(val)) return '<span class="text-muted">-</span>';
        const abs = Math.abs(val);
        let formatted;
        if (abs >= 1e12) formatted = (val / 1e12).toFixed(1) + 'T';
        else if (abs >= 1e9) formatted = (val / 1e9).toFixed(1) + 'B';
        else if (abs >= 1e6) formatted = (val / 1e6).toFixed(0) + 'M';
        else formatted = (val / 1e3).toFixed(0) + 'K';
        const cls = val > 0 ? 'text-success' : (val < 0 ? 'text-danger' : 'text-secondary');
        return `<span class="${cls} fw-bold">${formatted}</span>`;
    };

    const fmtFlow = (val) => {
        if (typeof val !== 'number' || !Number.isFinite(val)) return '<span class="text-muted">-</span>';
        if (val >= 5) return `<span class="text-success fw-bold">${val.toFixed(1)}</span>`;
        if (val >= 3) return `<span class="text-primary fw-bold">${val.toFixed(1)}</span>`;
        if (val >= 1) return `<span style="color:#fd7e14" class="fw-bold">${val.toFixed(1)}</span>`;
        return `<span class="text-muted">${val.toFixed(1)}</span>`;
    };

    const rows = [
        { label: 'Accum', key: 'smartMoney', formatter: fmtSmartMoney },
        { label: 'V-WAP', key: 'vwap', formatter: (v) => getBadge(v, 'vwap') },
        { label: 'Flow', key: 'flow', formatter: fmtFlow },
        { label: 'Effort', key: 'effort', formatter: (v) => getBadge(v, 'effort') }
    ];

    let html = '';
    rows.forEach(r => {
        html += `<tr>
            <td class="fw-semibold">${r.label}</td>
            <td class="text-center">${r.formatter(byWindow["2"][r.key])}</td>
            <td class="text-center">${r.formatter(byWindow["5"][r.key])}</td>
            <td class="text-center">${r.formatter(byWindow["10"][r.key])}</td>
            <td class="text-center">${r.formatter(byWindow["20"][r.key])}</td>
        </tr>`;
    });
    $('#horizon-metrics-tbody').html(html);
    $('#horizon-metrics-card').removeClass('d-none');
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
        'OFF_THE_LOW': 'text-success fw-bold',
        'ACCUMULATION': 'text-success fw-bold',
        'READY_MARKUP': 'text-info fw-bold',
        'POTENTIAL_TOP': 'text-warning fw-bold',
        'DISTRIBUTION': 'text-danger fw-bold',
        'NEUTRAL': 'text-muted'
    };
    const label = state ? state.replaceAll('_', ' ') : '-';
    return `<span class="${colors[state] || 'text-muted'}">${label}</span>`;
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

    // Show AI Analytics button
    $('#ai-analytics-bar').attr('style', '').addClass('d-flex');

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

    // Sort and include all days that have data object (from R2)
    // Even if buy/sell values are zero, we still show the date point on the chart
    // so the cumulative line doesn't skip trading days
    history.sort((a, b) => new Date(a.date) - new Date(b.date));
    const validHistory = history.filter(h => {
        if (!h.data) return false;
        return true; // Include all dates that have data from R2 (already filtered by API)
    });

    const labels = validHistory.map(h => {
        const d = new Date(h.date);
        return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    // === Cumulative Net Value (solid lines) ===
    let accF = 0, accR = 0, accL = 0;
    // === Daily Net Value (bar chart — always paired: inst vs retail) ===
    const fData = [], rData = [], lData = [];
    const barInstData = [], barRetData = [];

    validHistory.forEach((h) => {
        const netF = h.data?.foreign?.net_val || 0;
        const netR = h.data?.retail?.net_val || 0;
        const netL = h.data?.local?.net_val || 0;

        // Cumulative Net Value (position — solid lines)
        accF += netF; fData.push(accF);
        accR += netR; rData.push(accR);
        accL += netL; lData.push(accL);

        // Daily Net (bar chart — institution vs retail, always mirror)
        barInstData.push(netF + netL);  // Institution = Foreign + Local
        barRetData.push(netR);           // Retail (= -(F+L), always opposite)
    });

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
                // --- Cumulative Net Value (solid) ---
                { label: 'Foreign', data: fData, borderColor: '#198754', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                { label: 'Retail', data: rData, borderColor: '#dc3545', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                { label: 'Local', data: lData, borderColor: '#0d6efd', tension: 0.1, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                // --- Daily Net Value (paired bars: green=institution, red=retail) ---
                // Winner (positive) gets stronger opacity, loser (negative) gets lighter
                {
                    label: 'Institution',
                    type: 'bar',
                    data: barInstData,
                    backgroundColor: barInstData.map(v => v >= 0 ? 'rgba(25,135,84,0.45)' : 'rgba(25,135,84,0.12)'),
                    borderColor: barInstData.map(v => v >= 0 ? 'rgba(25,135,84,0.8)' : 'rgba(25,135,84,0.25)'),
                    borderWidth: 1,
                    yAxisID: 'y',
                    order: 10,
                    stack: 'daily',
                    barPercentage: 0.5,
                    categoryPercentage: 0.9
                },
                {
                    label: 'Retail Net',
                    type: 'bar',
                    data: barRetData,
                    backgroundColor: barRetData.map(v => v >= 0 ? 'rgba(220,53,69,0.45)' : 'rgba(220,53,69,0.12)'),
                    borderColor: barRetData.map(v => v >= 0 ? 'rgba(220,53,69,0.8)' : 'rgba(220,53,69,0.25)'),
                    borderWidth: 1,
                    yAxisID: 'y',
                    order: 11,
                    stack: 'daily',
                    barPercentage: 0.5,
                    categoryPercentage: 0.9
                }
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

// =========================================
// AI ANALYTICS: Multi-Screenshot + OpenAI Vision + Cache
// =========================================

/**
 * Capture a DOM element as JPEG blob
 */
async function captureElement(el) {
    const canvas = await html2canvas(el, {
        backgroundColor: '#ffffff',
        scale: 1,
        useCORS: true,
        logging: false,
        onclone: function(clonedDoc) {
            const origCanvases = el.querySelectorAll('canvas');
            const cloneCanvases = clonedDoc.getElementById(el.id)?.querySelectorAll('canvas') || [];
            origCanvases.forEach((oc, i) => {
                if (cloneCanvases[i]) {
                    const ctx = cloneCanvases[i].getContext('2d');
                    cloneCanvases[i].width = oc.width;
                    cloneCanvases[i].height = oc.height;
                    ctx.drawImage(oc, 0, 0);
                }
            });
        }
    });
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.75));
}

/**
 * Upload a blob to R2 and return {key, url}
 */
async function uploadScreenshot(blob, symbol, label) {
    const resp = await fetch(`${WORKER_BASE_URL}/ai/screenshot?symbol=${symbol}&label=${encodeURIComponent(label)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || `Upload ${label} failed`);
    return { key: result.key, url: result.url, label, size_kb: result.size_kb };
}

/**
 * Load broker summary data for a given range (for off-screen screenshot)
 */
async function fetchBrokerRange(symbol, days) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    const from = start.toISOString().split('T')[0];
    const to = end.toISOString().split('T')[0];
    const resp = await fetch(`${WORKER_BASE_URL}/cache-summary?symbol=${symbol}&from=${from}&to=${to}`);
    return resp.json();
}

/**
 * Main AI Analysis function — captures current view, uploads, sends to AI
 */
async function runAIAnalysis(forceRefresh = false) {
    const symbol = kodeParam;
    if (!symbol) return alert('Tidak ada emiten yang dipilih.');

    const btn = document.getElementById('btn-ai-analyze');
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('aiResultModal'));
    const thumbsContainer = document.getElementById('ai-thumbnails');
    const analysisContent = document.getElementById('ai-analysis-content');
    const tokenInfo = document.getElementById('ai-token-info');
    const refreshBtn = document.getElementById('btn-ai-refresh');

    // Set title
    document.getElementById('ai-modal-symbol').textContent = symbol;

    // Reset UI
    btn.classList.add('analyzing');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Capturing...';
    thumbsContainer.style.display = 'none';
    thumbsContainer.innerHTML = '';
    refreshBtn.style.display = 'none';
    tokenInfo.textContent = '';
    analysisContent.innerHTML = `
        <div class="text-center py-4">
            <div class="spinner-border text-warning" role="status"></div>
            <p class="small text-muted mt-2">Mengambil screenshot halaman...</p>
        </div>
    `;
    modal.show();

    try {
        // ── Step 1: Capture current summary pane ──
        console.log('[AI] Step 1: Capturing current summary pane...');
        const summaryPane = document.getElementById('summary-pane');
        const currentBlob = await captureElement(summaryPane);
        console.log(`[AI] Current view captured: ${(currentBlob.size / 1024).toFixed(0)} KB`);

        // ── Step 2: Upload screenshots ──
        analysisContent.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-warning" role="status"></div>
                <p class="small text-muted mt-2">Mengunggah screenshot...</p>
            </div>
        `;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Uploading...';

        // Determine label based on current date range
        const fromDate = $('#date-from').val();
        const toDate = $('#date-to').val();
        const daysDiff = Math.round((new Date(toDate) - new Date(fromDate)) / (1000*60*60*24));
        const rangeLabel = `brokerflow-${daysDiff}d`;

        const uploaded = await uploadScreenshot(currentBlob, symbol, rangeLabel);
        console.log(`[AI] Uploaded: ${uploaded.key} (${uploaded.size_kb} KB)`);

        // Show thumbnail
        thumbsContainer.style.display = '';
        thumbsContainer.classList.add('d-flex');
        thumbsContainer.innerHTML = `
            <div class="text-center">
                <img src="${uploaded.url}" alt="${uploaded.label}" title="${uploaded.label}" loading="lazy">
                <div class="thumb-label">${uploaded.label}</div>
            </div>
        `;

        // ── Step 3: Call AI analysis ──
        analysisContent.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-warning" role="status"></div>
                <p class="small text-muted mt-2">AI sedang menganalisis...<br>Bisa memakan waktu 15-30 detik.</p>
            </div>
        `;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Analyzing...';

        const response = await fetch(`${WORKER_BASE_URL}/ai/analyze-broksum`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol,
                image_keys: [{ key: uploaded.key, label: uploaded.label }],
                force: forceRefresh
            })
        });

        const result = await response.json();

        if (!result.ok) {
            const errorMessage = result.error || 'AI analysis failed';
            const parseHint = result.parse_error ? `<div class="small text-muted mt-1">${escapeHTML(result.parse_error)}</div>` : '';
            const rawOutput = result.raw_output ? `<details class="mt-3"><summary class="small text-muted">Output mentah</summary><pre class="bg-body-secondary small p-3 rounded">${escapeHTML(result.raw_output)}</pre></details>` : '';
            analysisContent.innerHTML = `
                <div class="alert alert-danger">
                    <i class="fa-solid fa-circle-exclamation me-1"></i>
                    <strong>Gagal menganalisis:</strong> ${escapeHTML(errorMessage)}
                    ${parseHint}
                </div>
                ${rawOutput}
            `;
            if (Array.isArray(result.screenshots) && result.screenshots.length) {
                thumbsContainer.style.display = '';
                thumbsContainer.classList.add('d-flex');
                thumbsContainer.innerHTML = result.screenshots.map(s => `
                    <div class="text-center">
                        <img src="${escapeHTML(s.url)}" alt="${escapeHTML(s.label)}" title="${escapeHTML(s.label)}" loading="lazy">
                        <div class="thumb-label">${escapeHTML(s.label)}</div>
                    </div>
                `).join('');
            }
            tokenInfo.textContent = '';
            refreshBtn.style.display = '';
            return;
        }

        console.log(`[AI] Analysis complete. Tokens: ${result.usage?.total_tokens || 'N/A'}, Cached: ${result.cached || false}`);

        if (Array.isArray(result.screenshots) && result.screenshots.length) {
            thumbsContainer.style.display = '';
            thumbsContainer.classList.add('d-flex');
                            thumbsContainer.innerHTML = result.screenshots.map(s => `
                    <div class="text-center">
                        <img src="${escapeHTML(s.url)}" alt="${escapeHTML(s.label)}" title="${escapeHTML(s.label)}" loading="lazy">
                        <div class="thumb-label">${escapeHTML(s.label)}</div>
                    </div>
                `).join('');

        }

        let analysisData = result.analysis;
        if (analysisData && typeof analysisData === 'string') {
            try {
                analysisData = JSON.parse(analysisData);
            } catch (_) {
                analysisData = null;
            }
        }

        if (analysisData && typeof analysisData === 'object') {
            analysisContent.innerHTML = renderAnalysisJSON(analysisData);
        } else {
            const rawOutput = result.analysis_raw || '';
            analysisContent.innerHTML = `
                <div class="alert alert-warning">
                    <i class="fa-solid fa-triangle-exclamation me-1"></i>
                    <strong>Analisis belum tersedia.</strong> Model tidak mengembalikan JSON valid.
                </div>
                ${rawOutput ? `<details class="mt-3"><summary class="small text-muted">Output mentah</summary><pre class="bg-body-secondary small p-3 rounded">${escapeHTML(rawOutput)}</pre></details>` : ''}
            `;
        }

        if (result.usage) {
            const cachedTag = result.cached ? ' | ♻️ CACHED' : '';
            const metaConfidence = analysisData && analysisData.meta && typeof analysisData.meta.confidence === 'number'
                ? ` | Confidence: ${(analysisData.meta.confidence * 100).toFixed(0)}%`
                : '';
            tokenInfo.textContent = `Model: ${result.model} | Tokens: ${result.usage.total_tokens?.toLocaleString() || 'N/A'}${cachedTag}${metaConfidence}`;
        }

        refreshBtn.style.display = '';

    } catch (error) {
        console.error('[AI] Analysis error:', error);
        analysisContent.innerHTML = `
            <div class="alert alert-danger">
                <i class="fa-solid fa-circle-exclamation me-1"></i>
                <strong>Gagal menganalisis:</strong> ${error.message}
            </div>
            <p class="text-muted small">Pastikan koneksi internet stabil dan coba lagi.</p>
        `;
    } finally {
        btn.classList.remove('analyzing');
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles me-1"></i> AI Analysis';
    }
}

function escapeHTML(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderListSection(title, items) {
    if (!Array.isArray(items)) return '';
    const filtered = items
        .map(item => (item === null || item === undefined ? '' : String(item).trim()))
        .filter(item => item && item.toLowerCase() !== 'unknown');
    if (!filtered.length) return '';

    const listMarkup = filtered.map(item => `<li>${escapeHTML(item)}</li>`).join('');
    if (!listMarkup) return '';

    return `
        <div class="mb-3">
            <div class="text-uppercase small text-muted fw-semibold mb-1">${escapeHTML(title)}</div>
            <ul class="mb-0 ps-3">${listMarkup}</ul>
        </div>
    `;
}

function renderMetaSection(meta) {
    const symbol = escapeHTML(meta.symbol || '-');
    const range = escapeHTML(meta.date_range || 'unknown');
    const confidence = typeof meta.confidence === 'number' && !Number.isNaN(meta.confidence)
        ? `${(meta.confidence * 100).toFixed(0)}%`
        : 'n/a';
    const screenshots = Array.isArray(meta.screenshots) && meta.screenshots.length
        ? escapeHTML(meta.screenshots.join(', '))
        : '-';

    return `
        <div class="mb-3">
            <div class="text-uppercase small text-muted fw-semibold mb-1">Metadata</div>
            <div class="d-flex flex-wrap gap-4">
                <div>
                    <div class="text-muted small">Symbol</div>
                    <div class="fw-bold">${symbol}</div>
                </div>
                <div>
                    <div class="text-muted small">Rentang Tanggal</div>
                    <div class="fw-bold">${range}</div>
                </div>
                <div>
                    <div class="text-muted small">Confidence</div>
                    <div class="fw-bold">${confidence}</div>
                </div>
                <div>
                    <div class="text-muted small">Screenshots</div>
                    <div class="fw-bold">${screenshots}</div>
                </div>
            </div>
        </div>
    `;
}

function renderFundFlowSection(section) {
    if (!section || typeof section !== 'object') return '';
    const items = [];
    if (section.foreign_trend && section.foreign_trend !== 'unknown') items.push(`Foreign: ${section.foreign_trend}`);
    if (section.local_trend && section.local_trend !== 'unknown') items.push(`Local: ${section.local_trend}`);
    if (section.retail_trend && section.retail_trend !== 'unknown') items.push(`Retail: ${section.retail_trend}`);
    if (section.dominant_side && section.dominant_side !== 'unknown') items.push(`Dominan: ${section.dominant_side}`);
    if (section.divergence && section.divergence !== 'unknown') items.push(`Divergensi: ${section.divergence}`);
    if (Array.isArray(section.notes)) {
        section.notes.filter(Boolean).forEach(note => items.push(note));
    }
    return renderListSection('Analisis Fund Flow', items);
}

function renderSmartMoneySection(section) {
    if (!section || typeof section !== 'object') return '';
    const items = [];
    if (section.state && section.state !== 'UNKNOWN') items.push(`State: ${section.state}`);
    if (section.assessment) items.push(section.assessment);
    if (section.scores && typeof section.scores === 'object') {
        const { effort, price_response, net_quality, vwap, elasticity } = section.scores;
        if (effort) items.push(`Effort: ${effort}`);
        if (price_response) items.push(`Price Response: ${price_response}`);
        if (net_quality) items.push(`Net Quality: ${net_quality}`);
        if (vwap) items.push(`VWAP: ${vwap}`);
        if (elasticity) items.push(`Elasticity: ${elasticity}`);
    }
    return renderListSection('Analisis Smart Money', items);
}

function renderBrokerSection(section) {
    if (!section || typeof section !== 'object') return '';
    const buyers = Array.isArray(section.top_net_buyers) ? section.top_net_buyers.slice(0, 5) : [];
    const sellers = Array.isArray(section.top_net_sellers) ? section.top_net_sellers.slice(0, 5) : [];

    const buyerMarkup = buyers.length ? `
        <div class="mb-2">
            <div class="small text-muted">Top Net Buyers</div>
            <ul class="mb-0 ps-3">
                ${buyers.map(b => `<li><strong>${escapeHTML(b.code || '-')}</strong> (${escapeHTML((b.type || 'unknown').toString())}) — ${escapeHTML(b.value || 'unknown')}${b.comment ? ` · ${escapeHTML(b.comment)}` : ''}</li>`).join('')}
            </ul>
        </div>` : '';

    const sellerMarkup = sellers.length ? `
        <div class="mb-2">
            <div class="small text-muted">Top Net Sellers</div>
            <ul class="mb-0 ps-3">
                ${sellers.map(s => `<li><strong>${escapeHTML(s.code || '-')}</strong> (${escapeHTML((s.type || 'unknown').toString())}) — ${escapeHTML(s.value || 'unknown')}${s.comment ? ` · ${escapeHTML(s.comment)}` : ''}</li>`).join('')}
            </ul>
        </div>` : '';

    const patternsMarkup = renderListSection('Pola Broker', Array.isArray(section.patterns) ? section.patterns : []);

    if (!buyerMarkup && !sellerMarkup && !patternsMarkup) return '';
    return `
        <div class="mb-3">
            <div class="text-uppercase small text-muted fw-semibold mb-1">Broker Kunci</div>
            ${buyerMarkup}
            ${sellerMarkup}
            ${patternsMarkup}
        </div>
    `;
}

function renderTechnicalSection(section) {
    if (!section || typeof section !== 'object') return '';
    const items = [];
    if (Array.isArray(section.supports) && section.supports.length) items.push(`Support: ${section.supports.join(', ')}`);
    if (Array.isArray(section.resistances) && section.resistances.length) items.push(`Resistance: ${section.resistances.join(', ')}`);
    if (Array.isArray(section.accumulation_zones) && section.accumulation_zones.length) items.push(`Zona akumulasi: ${section.accumulation_zones.join(', ')}`);
    if (Array.isArray(section.intraday_notes)) {
        section.intraday_notes.filter(Boolean).forEach(note => items.push(note));
    }
    return renderListSection('Level Teknikal', items);
}

function renderRecommendationSection(section) {
    if (!section || typeof section !== 'object') return '';
    const rows = [];
    if (section.phase) {
        rows.push(`<div><div class="text-muted small">Fase</div><div class="fw-bold">${escapeHTML(section.phase)}</div></div>`);
    }
    if (section.rating) {
        rows.push(`<div><div class="text-muted small">Rating</div><div class="fw-bold">${escapeHTML(section.rating)}</div></div>`);
    }
    const confidence = typeof section.confidence === 'number' && !Number.isNaN(section.confidence)
        ? `${(section.confidence * 100).toFixed(0)}%`
        : 'n/a';
    rows.push(`<div><div class="text-muted small">Confidence</div><div class="fw-bold">${confidence}</div></div>`);

    const rationale = renderListSection('Alasan', Array.isArray(section.rationale) ? section.rationale : []);
    const risks = renderListSection('Risiko', Array.isArray(section.risks) ? section.risks : []);

    return `
        <div class="mb-3">
            <div class="text-uppercase small text-muted fw-semibold mb-1">Kesimpulan & Rekomendasi</div>
            <div class="d-flex flex-wrap gap-4 mb-2">
                ${rows.join('')}
            </div>
            ${rationale}
            ${risks}
        </div>
    `;
}

function renderAnalysisJSON(data) {
    if (!data || typeof data !== 'object') {
        return '<p class="text-muted">Analisis tidak tersedia.</p>';
    }

    const sections = [];
    sections.push(renderMetaSection(data.meta || {}));
    sections.push(renderListSection('Ringkasan Eksekutif', Array.isArray(data.executive_summary) ? data.executive_summary : []));
    sections.push(renderFundFlowSection(data.fund_flow));
    sections.push(renderSmartMoneySection(data.smart_money));
    sections.push(renderBrokerSection(data.key_brokers));
    sections.push(renderTechnicalSection(data.technical_levels));
    sections.push(renderRecommendationSection(data.recommendation));

    const jsonDump = escapeHTML(JSON.stringify(data, null, 2));
    sections.push(`<details class="mt-3"><summary class="small text-muted">Lihat JSON mentah</summary><pre class="bg-body-secondary small p-3 rounded">${jsonDump}</pre></details>`);

    return sections.filter(Boolean).join('');
}

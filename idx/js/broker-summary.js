const WORKER_BASE_URL = "https://api-saham.mkemalw.workers.dev";
const SECTOR_SCRAPPER_BASE_URL = "https://sector-scrapper.mkemalw.workers.dev";

// Cache: symbol (uppercase) → digest { freq_tx, growth_pct, price_open, price_last, ... }
// Populated by prefillSectorDigest() on page load and refreshed every SECTOR_DIGEST_TTL_MS.
const sectorDigestCache = new Map();
let sectorDigestLoadedAt = 0;
const SECTOR_DIGEST_TTL_MS = 10 * 60 * 1000; // refresh every 10 min

const urlParams = new URLSearchParams(window.location.search);
const kodeParam = urlParams.get('kode');
const startParam = urlParams.get('start');
const endParam = urlParams.get('end');
const nettParam = urlParams.get('nett');
let brokersMap = {};
let currentBrokerSummary = null;

if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
}

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
    setupMarketChartCarousel();
    loadScreenerData();

    if (intradayRefreshTimer) clearInterval(intradayRefreshTimer);
    intradayRefreshTimer = setInterval(async () => {
        const totalRows = currentCandidates.length;
        if (!totalRows) return;
        const startIdx = (screenerPage - 1) * SCREENER_PAGE_SIZE;
        const endIdx = Math.min(startIdx + SCREENER_PAGE_SIZE, totalRows);
        const pageRows = currentCandidates.slice(startIdx, endIdx);
        // Footprint prefills non-core fields (CVD windows, RVOL) and seeds
        // core fields only for items not yet hydrated.
        // Hydration (/cache-summary) is authoritative and will always win.
        await prefillIntradayFromFootprintSummary(pageRows, { updateDom: true });
        hydrateOrderflowForVisibleRows(pageRows);
    }, 60 * 1000);
}

// Global state for sorting and pagination
let currentCandidates = [];
let allCandidates = []; // Unfiltered cache
let sortState = { key: 'sm2', desc: true };
const orderflowLiveCache = new Map();
const orderflowInFlight = new Set();
let probRefreshTimer = null;
let intradayRefreshTimer = null;
const SCREENER_PAGE_SIZE = 100;
const ORDERFLOW_CACHE_TTL_MS = 45 * 1000;
const TOM2_ORDERFLOW_MAX_AGE_MS = 15 * 60 * 1000;
const SWG_SCREENER_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const PROB_MISSING_SORT_VALUE = -1;
let screenerPage = 1;
let accumFilter = 'all'; // legacy compat
let lastScreenerGeneratedAtMs = 0;
let searchQuery = ''; // Emiten symbol search text
// Active filter state
const activeFilters = {
    foreign: 'any',   // any | allPos | dominant
    smart:   'any',   // any | allPos | positive
    local:   'any',   // any | allPos | positive
    streak:  'any',   // any | s3 | trend5up | trend10up | trend20up
    zeffort: 'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    zngr:    'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    zvwap:   'any',   // any | 2gt5 | 2gt10 | 2gt20 | 5gt10 | 5gt20 | 10gt20 | ladderUp
    effort:  'any',   // any | high | positive
    state:   'any',   // any | accum | markup
    horizon:  'any',   // any | 2 | 5 | 10 | 20
    quadrant: 'any'   // any | Q1 | Q2 | Q3 | Q4
};
// Numeric threshold filters (≥ value). NaN = inactive.
const numericFilters = {
    growth_min:  NaN,
    freq_min:    NaN,
    tom2_min:    NaN,
    swg5_min:    NaN,
    delta_min:   NaN,
    mom_min:     NaN,
    absorb_min:  NaN,
    cvd_min:     NaN,
    rvol_min:    NaN,
    value_min:   NaN
};
let activePreset = 'all';
const visibleHorizonCols = { "2": true, "5": true, "10": true, "20": true };
const columnGroupVisibility = { fflw: true, lflw: true, smny: true, cvdm: true, rvol: true, flow: true, eff: true, vwp: true };

// ===== URL STATE MANAGEMENT =====
// Persist filters/sort/page in URL for back/forward navigation
let _urlPushTimer = null;
let _suppressUrlPush = false; // Guard: prevent pushing URL during popstate restore
const URL_STATE_DEFAULTS = {
    activeFilters: { foreign:'any', smart:'any', local:'any', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any', quadrant:'any' },
    sortKey: 'sm2', sortDesc: true, page: 1
};

function pushUrlState(replace = false) {
    if (_suppressUrlPush) return;
    // Debounce to avoid flooding history on rapid changes
    clearTimeout(_urlPushTimer);
    _urlPushTimer = setTimeout(() => {
        const p = new URLSearchParams();
        // Preserve existing non-screener params (kode, start, end, etc.)
        const keep = ['kode', 'start', 'end', 'nett', 'ai'];
        const cur = new URLSearchParams(window.location.search);
        keep.forEach(k => { if (cur.has(k)) p.set(k, cur.get(k)); });

        // Only write non-default active filters
        Object.keys(activeFilters).forEach(k => {
            if (activeFilters[k] !== 'any') p.set(`f_${k}`, activeFilters[k]);
        });
        // Numeric filters
        Object.keys(numericFilters).forEach(k => {
            if (Number.isFinite(numericFilters[k])) p.set(`n_${k}`, numericFilters[k]);
        });
        // Sort
        if (sortState.key !== URL_STATE_DEFAULTS.sortKey || sortState.desc !== URL_STATE_DEFAULTS.sortDesc) {
            p.set('sort', sortState.key);
            p.set('dir', sortState.desc ? 'd' : 'a');
        }
        // Page
        if (screenerPage > 1) p.set('pg', screenerPage);
        // Search query
        if (searchQuery) p.set('q', searchQuery);
        // View columns (only if changed from default all-visible)
        const hiddenCols = Object.entries(visibleHorizonCols).filter(([, v]) => !v).map(([h]) => h);
        if (hiddenCols.length > 0) p.set('hide', hiddenCols.join(','));
        const hiddenGroups = Object.entries(columnGroupVisibility).filter(([, v]) => !v).map(([g]) => g);
        if (hiddenGroups.length > 0) p.set('ghide', hiddenGroups.join(','));

        const qs = p.toString();
        const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
        if (replace) {
            history.replaceState({ screenerState: true }, '', url);
        } else {
            history.pushState({ screenerState: true }, '', url);
        }
        // Persist filters to localStorage as fallback (for returning from detail page)
        try {
            localStorage.setItem('screener_filters', JSON.stringify({
                af: { ...activeFilters }, nf: { ...numericFilters },
                sk: sortState.key, sd: sortState.desc, q: searchQuery || ''
            }));
        } catch (e) { /* quota exceeded */ }
    }, replace ? 0 : 80);
}

function restoreFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const hasScreenerParams = [...p.keys()].some(k => k.startsWith('f_') || k.startsWith('n_') || k === 'sort' || k === 'dir' || k === 'pg' || k === 'q');

    if (hasScreenerParams) {
        // Restore from URL
        Object.keys(activeFilters).forEach(k => {
            const v = p.get(`f_${k}`);
            activeFilters[k] = v || 'any';
        });
        Object.keys(numericFilters).forEach(k => {
            const v = p.get(`n_${k}`);
            numericFilters[k] = (v !== null && v !== '') ? parseFloat(v) : NaN;
        });
        sortState.key = p.get('sort') || URL_STATE_DEFAULTS.sortKey;
        sortState.desc = p.has('dir') ? p.get('dir') === 'd' : URL_STATE_DEFAULTS.sortDesc;
        const pg = parseInt(p.get('pg'), 10);
        screenerPage = (Number.isFinite(pg) && pg > 0) ? pg : 1;
        searchQuery = p.get('q') || '';
    } else {
        // Fallback: restore last filters from localStorage
        try {
            const saved = JSON.parse(localStorage.getItem('screener_filters'));
            if (saved) {
                if (saved.af) Object.keys(activeFilters).forEach(k => { activeFilters[k] = saved.af[k] || 'any'; });
                if (saved.nf) Object.keys(numericFilters).forEach(k => { numericFilters[k] = Number.isFinite(saved.nf[k]) ? saved.nf[k] : NaN; });
                sortState.key = saved.sk || URL_STATE_DEFAULTS.sortKey;
                sortState.desc = saved.sd ?? URL_STATE_DEFAULTS.sortDesc;
                searchQuery = saved.q || '';
            }
        } catch (e) { /* ignore */ }
    }

    // View columns: URL overrides, else localStorage fallback
    const hide = p.get('hide');
    const ghide = p.get('ghide');
    if (hide || ghide) {
        ['2', '5', '10', '20'].forEach(h => visibleHorizonCols[h] = true);
        if (hide) hide.split(',').forEach(h => { if (visibleHorizonCols.hasOwnProperty(h)) visibleHorizonCols[h] = false; });
        Object.keys(columnGroupVisibility).forEach(g => columnGroupVisibility[g] = true);
        if (ghide) ghide.split(',').forEach(g => { if (columnGroupVisibility.hasOwnProperty(g)) columnGroupVisibility[g] = false; });
    } else {
        try {
            const sv = JSON.parse(localStorage.getItem('screener_view'));
            if (sv) {
                if (sv.h) Object.keys(visibleHorizonCols).forEach(k => { visibleHorizonCols[k] = sv.h[k] !== false; });
                if (sv.g) Object.keys(columnGroupVisibility).forEach(k => { columnGroupVisibility[k] = sv.g[k] !== false; });
            }
        } catch (e) { /* ignore */ }
    }

    // Sync numeric inputs
    Object.keys(numericFilters).forEach(k => {
        const $inp = $(`.num-filter-input[data-nf="${k}"]`);
        if ($inp.length) $inp.val(Number.isFinite(numericFilters[k]) ? numericFilters[k] : '');
    });
}

// Handle browser back/forward
window.addEventListener('popstate', () => {
    if (!allCandidates.length) return; // data not loaded yet
    _suppressUrlPush = true;
    restoreFromUrl();
    syncFilterDropdowns();
    syncNumericDropdowns();
    detectMatchingPreset();
    applyColumnVisibility();
    syncViewCheckboxes();
    $('#emiten-search').val(searchQuery);
    applyFilter();
    _suppressUrlPush = false;
});

function syncViewCheckboxes() {
    ['2', '5', '10', '20'].forEach(h => {
        $(`[data-view-horizon="${h}"]`).prop('checked', visibleHorizonCols[h] !== false);
    });
    Object.keys(columnGroupVisibility).forEach(g => {
        $(`[data-view-group="${g}"]`).prop('checked', columnGroupVisibility[g] !== false);
    });
    updateViewButtonLabel();
}

function updateViewButtonLabel() {
    const hHidden = Object.values(visibleHorizonCols).filter(v => !v).length;
    const gHidden = Object.values(columnGroupVisibility).filter(v => !v).length;
    const totalHidden = hHidden + gHidden;
    const label = totalHidden === 0 ? 'All' : `${totalHidden} hidden`;
    $('#dd-view').html(`<i class="fa-solid fa-eye me-1"></i><span class="d-none">View: ${label}</span>`);
}

// Preset recipes
const PRESETS = {
    strict:  { foreign:'allPos', smart:'allPos', local:'any', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any', quadrant:'any' },
    smart:   { foreign:'any',    smart:'allPos', local:'any', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any', quadrant:'any' },
    ara:     { foreign:'any',    smart:'positive', local:'any', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'positive', state:'any', horizon:'any', quadrant:'any' },
    all:     { foreign:'any',    smart:'any',    local:'any', streak:'any', zeffort:'any', zngr:'any', zvwap:'any', effort:'any', state:'any', horizon:'any', quadrant:'any' }
};

const PRESET_NUMERIC = {
    ara: { growth_min: NaN, freq_min: NaN, tom2_min: NaN, swg5_min: NaN, delta_min: 20, mom_min: NaN, absorb_min: NaN, cvd_min: NaN, rvol_min: 1.5, value_min: NaN }
};

const PRESET_DESC = {
    strict: 'Foreign & Smart Money positif tiap hari',
    smart:  'Smart Money positif tiap hari',
    ara:    'Saham ARA (Δ%≥20) + Smart Money + Effort positif + RVOL≥1.5',
    all:    'Tanpa filter'
};

const FILTER_LABELS = {
    foreign: { any:'Any', allPos:'Positif tiap hari', dominant:'Kumulatif > 0' },
    smart:   { any:'Any', allPos:'Positif tiap hari', positive:'Kumulatif > 0' },
    local:   { any:'Any', allPos:'Positif tiap hari', positive:'Kumulatif > 0' },
    streak:  { any:'Any', s3:'Streak ≥ 3 hari', trend5up:'Trend 5D Up', trend10up:'Trend 10D Up', trend20up:'Trend 20D Up' },
    zeffort: { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    zngr:    { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    zvwap:   { any:'Any', '2gt5':'2D > 5D', '2gt10':'2D > 10D', '2gt20':'2D > 20D', '5gt10':'5D > 10D', '5gt20':'5D > 20D', '10gt20':'10D > 20D', ladderUp:'2D ≥ 5D ≥ 10D ≥ 20D' },
    effort:  { any:'Any', high:'High (z > 1)', positive:'Positif (z > 0)' },
    state:   { any:'Any', accum:'Accumulation', markup:'Accum / Ready Markup' },
    horizon:  { any:'Any horizon', '2':'2D only', '5':'5D only', '10':'10D only', '20':'20D only' },
    quadrant: { any:'Any', Q1:'Q1 (Strong)', Q2:'Q2 (Caution)', Q3:'Q3 (Weak)', Q4:'Q4 (Recover)' }
};

const PILL_COLORS = {
    foreign:'success', smart:'primary', local:'success', streak:'warning', zeffort:'dark', zngr:'dark', zvwap:'dark', effort:'info', state:'danger', horizon:'secondary', quadrant:'info'
};

async function loadScreenerData() {
    try {
        $('#loading-indicator').show();
        $('#tbody-index').html('');

        const response = await fetch(`${WORKER_BASE_URL}/screener-accum?_ts=${Date.now()}`);
        if (!response.ok) {
            throw new Error(`screener-accum HTTP ${response.status}`);
        }
        const data = await response.json();
        const generatedAtRaw = data?.generated_at || data?.updated_at || data?.ts || null;
        const generatedAtMs = Date.parse(generatedAtRaw || '');
        lastScreenerGeneratedAtMs = Number.isFinite(generatedAtMs) ? generatedAtMs : Date.now();

        if (!data || !Array.isArray(data.items) || data.items.length === 0) {
            $('#tbody-index').html('<tr><td colspan="41" class="text-center text-muted">Accum data not yet generated.</td></tr>');
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

            const orderflow = i.orderflow || null;
            // When embedded orderflow is a stale fallback (yesterday's data),
            // block price/growth fields — let footprint/sector-digest provide today's values.
            // But KEEP delta/mom/absorb/cvd as useful seed (better than showing 0).
            const _ofStale = orderflow?.is_fallback_day === true;

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
                fn2:  i.accum?.["2"]?.fn || 0,
                fn5:  i.accum?.["5"]?.fn || 0,
                fn10: i.accum?.["10"]?.fn || 0,
                fn20: i.accum?.["20"]?.fn || 0,
                ln2:  i.accum?.["2"]?.ln || 0,
                ln5:  i.accum?.["5"]?.ln || 0,
                ln10: i.accum?.["10"]?.ln || 0,
                ln20: i.accum?.["20"]?.ln || 0,
                orderflow,
                // Price/growth: block stale fallback — sector-digest/footprint will fill today's
                order_open_price: (!_ofStale && typeof orderflow?.open_price === 'number') ? orderflow.open_price : null,
                order_recent_price: (!_ofStale && typeof orderflow?.recent_price === 'number')
                    ? orderflow.recent_price
                    : ((!_ofStale && typeof orderflow?.price === 'number') ? orderflow.price : null),
                order_growth_pct: (!_ofStale && typeof orderflow?.growth_pct === 'number')
                    ? orderflow.growth_pct
                    : ((!_ofStale && typeof orderflow?.open_price === 'number' && typeof orderflow?.recent_price === 'number' && orderflow.open_price > 0)
                        ? (((orderflow.recent_price - orderflow.open_price) / orderflow.open_price) * 100)
                        : null),
                // Keep freq blank until per-symbol hydration to avoid source-mismatch flipping.
                order_freq_tx: null,
                // Intraday metrics: allow stale seed (better than 0 from NO_INTRADAY footprint)
                order_delta_pct: (typeof orderflow?.delta_pct === 'number') ? orderflow.delta_pct : null,
                order_mom_pct: (typeof orderflow?.mom_pct === 'number') ? orderflow.mom_pct : null,
                order_absorb: (typeof orderflow?.absorb === 'number') ? orderflow.absorb : null,
                order_cvd: (typeof orderflow?.cvd === 'number') ? orderflow.cvd : null,
                order_net_value: (typeof orderflow?.net_value === 'number') ? orderflow.net_value : null,
                order_quadrant: orderflow?.quadrant || null,
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

        // Fast path: prefill intraday columns from bulk footprint summary.
        // This helps Δ%, Mom%, Absorb appear quickly before per-symbol hydration completes.
        await prefillIntradayFromFootprintSummary(allCandidates, { updateDom: false });
        // Sector digest provides authoritative closing price data with weekend fallback.
        await prefillSectorDigest(allCandidates);

        // Restore filter/sort/page from URL (or localStorage fallback)
        restoreFromUrl();
        syncFilterDropdowns();
        syncNumericDropdowns();
        detectMatchingPreset();
        applyColumnVisibility();
        syncViewCheckboxes();
        $('#emiten-search').val(searchQuery);

        applyFilter();
        // Replace (not push) initial state so first load doesn't create duplicate history entry
        pushUrlState(true);
        loadForeignSentiment();

        // Restore Claude scores from cache if available (instant, no animation)
        const cachedClaudeScores = loadClaudeScoresFromCache();
        if (cachedClaudeScores) {
            applyClaudeScores(cachedClaudeScores, false);
        }

    } catch (error) {
        console.error('[Brokerflow] loadScreenerData failed:', error);
        $('#tbody-index').html('<tr><td colspan="41" class="text-center text-danger">Error loading screener data</td></tr>');
    } finally {
        $('#loading-indicator').hide();
        $('#app').fadeIn();
    }
}

// =========================================
// Ranking Scores (TOM2 / SWG5)
// =========================================
function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

function buildPercentileMap(cands, getVal) {
    const arr = [];
    for (const c of cands) {
        const v = getVal(c);
        if (isNum(v)) arr.push({ s: c.symbol, v });
    }
    if (arr.length <= 1) {
        const only = arr[0]?.s;
        return only ? { [only]: 0.5 } : {};
    }
    arr.sort((a, b) => a.v - b.v);
    const out = {};
    const n = arr.length;
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && arr[j + 1].v === arr[i].v) j++;
        const avgRank = (i + j) / 2;
        const p = avgRank / (n - 1);
        for (let k = i; k <= j; k++) out[arr[k].s] = p;
        i = j + 1;
    }
    return out;
}

function centeredPct(p) {
    const cp = (p * 2) - 1;
    return Math.max(-1, Math.min(1, cp));
}

function signGate(raw, cp) {
    if (!isNum(raw)) return 0;
    if (raw <= 0) return Math.min(0, cp);
    return cp;
}

function smoothLiq(p) {
    if (!isNum(p)) return 0.2;
    const x = (p - 0.10) / 0.40;
    return Math.max(0, Math.min(1, x));
}

function clampVal(min, max, x) {
    return Math.max(min, Math.min(max, x));
}

function buildPercentiles(cands) {
    return {
        sm2: buildPercentileMap(cands, c => c.sm2),
        sm5: buildPercentileMap(cands, c => c.sm5),
        sm10: buildPercentileMap(cands, c => c.sm10),
        sm20: buildPercentileMap(cands, c => c.sm20),

        eff2: buildPercentileMap(cands, c => c.metrics?.effort2),
        eff5: buildPercentileMap(cands, c => c.metrics?.effort5),
        eff10: buildPercentileMap(cands, c => c.metrics?.effort10),

        flow5: buildPercentileMap(cands, c => c.flow5),
        flow10: buildPercentileMap(cands, c => c.flow10),

        vwap5: buildPercentileMap(cands, c => c.metrics?.vwap5),
        vwap10: buildPercentileMap(cands, c => c.metrics?.vwap10),

        mom: buildPercentileMap(cands, c => c.order_mom_pct),
        delta: buildPercentileMap(cands, c => c.order_delta_pct),
        absorb: buildPercentileMap(cands, c => c.order_absorb),
        cvd: buildPercentileMap(cands, c => c.order_cvd),
        cvd_2d:  buildPercentileMap(cands, c => c.cvd_pct_2d  ?? c.order_cvd_2d),
        cvd_5d:  buildPercentileMap(cands, c => c.cvd_pct_5d  ?? c.order_cvd_5d),
        cvd_10d: buildPercentileMap(cands, c => c.cvd_pct_10d ?? c.order_cvd_10d),
        cvd_20d: buildPercentileMap(cands, c => c.cvd_pct_20d ?? c.order_cvd_20d),
        netv: buildPercentileMap(cands, c => c.order_net_value),
    };
}

function getP(P, key, symbol, fallback = 0.35) {
    const m = P[key] || {};
    const p = m[symbol];
    return isNum(p) ? p : fallback;
}

function getOrderflowAgeMs(item) {
    if (!item) return Infinity;
    const snapAt = Date.parse(item?.orderflow?.snapshot_at || '');
    const fetchedAt = Number(item?._orderflowFetchedAt || 0);
    const tsCandidates = [];
    if (Number.isFinite(snapAt) && snapAt > 0) tsCandidates.push(snapAt);
    if (Number.isFinite(fetchedAt) && fetchedAt > 0) tsCandidates.push(fetchedAt);
    const ts = tsCandidates.length ? Math.max(...tsCandidates) : NaN;
    if (!Number.isFinite(ts)) return Infinity;
    return Date.now() - ts;
}

function hasFreshOrderflowForTom2(item) {
    if (!item) return false;
    const ageMs = getOrderflowAgeMs(item);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > TOM2_ORDERFLOW_MAX_AGE_MS) return false;
    const hasCore = isNum(item.order_mom_pct) && isNum(item.order_delta_pct);
    const hasAnyDepth = isNum(item.order_absorb) || isNum(item.order_cvd) || isNum(item.order_net_value);
    return hasCore && hasAnyDepth;
}

function hasFreshScreenerForSwing(item) {
    const ageMs = Date.now() - Number(lastScreenerGeneratedAtMs || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SWG_SCREENER_MAX_AGE_MS) return false;
    if (!item) return false;
    return isNum(item.sm5)
        && isNum(item.sm10)
        && isNum(item.sm20)
        && isNum(item.metrics?.effort5)
        && isNum(item.metrics?.effort10)
        && isNum(item.metrics?.vwap5)
        && isNum(item.metrics?.vwap10);
}

function stateBonus(state) {
    if (state === 'READY_MARKUP') return 0.10;
    if (state === 'ACCUMULATION') return 0.06;
    if (state === 'TRANSITION') return 0.02;
    return 0;
}

function calcTOM2(item, P) {
    if (!hasFreshOrderflowForTom2(item)) {
        return { score: null, raw: null, label: 'NA' };
    }
    if (item.state === 'DISTRIBUTION') {
        return { score: 5, raw: 0, label: 'DISQ' };
    }

    const s = item.symbol;
    const liq = smoothLiq(getP(P, 'netv', s, 0.5));

    const cpSm2 = signGate(item.sm2, centeredPct(getP(P, 'sm2', s, 0.5)));
    const cpSm5 = signGate(item.sm5, centeredPct(getP(P, 'sm5', s, 0.5)));
    const cpSm10 = signGate(item.sm10, centeredPct(getP(P, 'sm10', s, 0.5)));
    const SM = (0.7 * cpSm2) + (0.2 * cpSm5) + (0.1 * cpSm10);

    const cpEff2 = centeredPct(getP(P, 'eff2', s, 0.5));
    const cpEff5 = centeredPct(getP(P, 'eff5', s, 0.5));
    const EFF = (0.7 * cpEff2) + (0.3 * cpEff5);

    const cpMom = signGate(item.order_mom_pct, centeredPct(getP(P, 'mom', s, 0.5)));
    const cpDelta = signGate(item.order_delta_pct, centeredPct(getP(P, 'delta', s, 0.5)));
    const cpCvd = signGate(item.order_cvd, centeredPct(getP(P, 'cvd', s, 0.5)));
    const cpAbs = centeredPct(getP(P, 'absorb', s, 0.5));
    const OF = (cpMom + cpDelta + cpAbs + cpCvd) / 4;

    // Composite: liq * features + stateBonus (additive, not multiplied by liq)
    const composite = liq * (0.45 * SM + 0.35 * OF + 0.20 * EFF) + stateBonus(item.state);
    // Sigmoid mapping: steepness 4 for smoother gradation, less sensitive to noise
    const sigmoid = 1 / (1 + Math.exp(-4 * composite));
    const score = clampVal(5, 90, Math.round(5 + 85 * sigmoid));

    const label = score >= 70 ? 'HIGH'
        : score >= 50 ? 'MED'
            : score >= 35 ? 'LOW'
                : 'VLOW';
    return { score, raw: composite, label };
}

function calcSWG5(item, P) {
    if (!hasFreshScreenerForSwing(item)) {
        return { score: null, raw: null, label: 'NA' };
    }
    if (item.state === 'DISTRIBUTION') {
        return { score: 5, raw: 0, label: 'DISQ' };
    }

    const s = item.symbol;
    const liq = smoothLiq(getP(P, 'netv', s, 0.5));

    const cpSm5 = signGate(item.sm5, centeredPct(getP(P, 'sm5', s, 0.5)));
    const cpSm10 = signGate(item.sm10, centeredPct(getP(P, 'sm10', s, 0.5)));
    const cpSm20 = signGate(item.sm20, centeredPct(getP(P, 'sm20', s, 0.5)));
    const SM = (0.5 * cpSm5) + (0.3 * cpSm10) + (0.2 * cpSm20);

    const cpFlow5 = centeredPct(getP(P, 'flow5', s, 0.5));
    const cpFlow10 = centeredPct(getP(P, 'flow10', s, 0.5));
    const FLOW = (0.6 * cpFlow5) + (0.4 * cpFlow10);

    const cpEff5 = centeredPct(getP(P, 'eff5', s, 0.5));
    const cpEff10 = centeredPct(getP(P, 'eff10', s, 0.5));
    const EFF = (0.6 * cpEff5) + (0.4 * cpEff10);

    const cpVwap5 = centeredPct(getP(P, 'vwap5', s, 0.5));
    const cpVwap10 = centeredPct(getP(P, 'vwap10', s, 0.5));
    const VWAP = (0.7 * cpVwap5) + (0.3 * cpVwap10);

    // CVD multi-day momentum: confirms volume-delta trend over swing horizon
    const cpCvd5d = signGate(item.cvd_pct_5d ?? item.order_cvd_5d, centeredPct(getP(P, 'cvd_5d', s, 0.5)));
    const cpCvd10d = signGate(item.cvd_pct_10d ?? item.order_cvd_10d, centeredPct(getP(P, 'cvd_10d', s, 0.5)));
    const CVD_MOM = (0.6 * cpCvd5d) + (0.4 * cpCvd10d);

    const trendBonus = item.trend?.vwapUp ? 0.05 : 0;
    // Weights normalized to 1.00: SM 0.35 + FLOW 0.20 + EFF 0.15 + VWAP 0.15 + CVD 0.15
    const composite = liq * (0.35 * SM + 0.20 * FLOW + 0.15 * EFF + 0.15 * VWAP + 0.15 * CVD_MOM)
        + trendBonus + stateBonus(item.state);
    // Sigmoid mapping: steepness 4 for smoother gradation, less sensitive to noise
    const sigmoid = 1 / (1 + Math.exp(-4 * composite));
    const score = clampVal(5, 90, Math.round(5 + 85 * sigmoid));

    const label = score >= 70 ? 'HIGH'
        : score >= 50 ? 'MED'
            : score >= 35 ? 'LOW'
                : 'VLOW';
    return { score, raw: composite, label };
}

function recomputeProbColumns(cands) {
    if (!Array.isArray(cands) || !cands.length) return;
    // Always build percentiles from full universe to avoid filter-dependent score shifts
    const universe = (Array.isArray(allCandidates) && allCandidates.length > 0) ? allCandidates : cands;
    const P = buildPercentiles(universe);
    for (const item of cands) {
        item.tom2 = calcTOM2(item, P);
        item.swg5 = calcSWG5(item, P);
        item.tom2_prob = isNum(item.tom2?.score) ? item.tom2.score : PROB_MISSING_SORT_VALUE;
        item.swg5_prob = isNum(item.swg5?.score) ? item.swg5.score : PROB_MISSING_SORT_VALUE;
    }
}

function fmtProbCell(x) {
    const p = x?.score;
    if (!isNum(p)) return '<span class="text-muted">-</span>';
    const cls = p >= 70 ? 'text-success fw-bold'
        : p >= 50 ? 'text-primary fw-bold'
            : p >= 35 ? 'text-warning'
                : 'text-muted';
    return `<span class="${cls}">${p}</span>`;
}

function updateProbCells(symbol, item) {
    const $row = $(`#tbody-index tr[data-symbol="${symbol}"]`);
    if (!$row.length) return;
    $row.find('.tom2-cell').html(fmtProbCell(item.tom2));
    $row.find('.swg5-cell').html(fmtProbCell(item.swg5));
}

function updateVisibleProbCells() {
    const symbolToItem = new Map(currentCandidates.map(c => [String(c.symbol || '').toUpperCase(), c]));
    $('#tbody-index tr[data-symbol]').each(function () {
        const symbol = String($(this).data('symbol') || '').toUpperCase();
        const item = symbolToItem.get(symbol);
        if (!item) return;
        $(this).find('.tom2-cell').html(fmtProbCell(item.tom2));
        $(this).find('.swg5-cell').html(fmtProbCell(item.swg5));
    });
}

// ── Claude Score Helpers ──
function showToast(message, type = 'info') {
    // Create a lightweight Bootstrap-style toast
    const bgMap = { success: '#198754', danger: '#dc3545', warning: '#fd7e14', info: '#0d6efd' };
    const bg = bgMap[type] || bgMap.info;
    const $toast = $(`<div style="position:fixed;top:16px;right:16px;z-index:9999;padding:10px 18px;border-radius:8px;
        background:${bg};color:#fff;font-size:0.85rem;box-shadow:0 4px 12px rgba(0,0,0,0.3);
        opacity:0;transition:opacity 0.3s;">${message}</div>`);
    $('body').append($toast);
    requestAnimationFrame(() => $toast.css('opacity', 1));
    setTimeout(() => $toast.css('opacity', 0), 3000);
    setTimeout(() => $toast.remove(), 3500);
}

function fmtClaudeCell(score) {
    if (score == null || typeof score !== 'number') return '<span class="claude-score-badge text-muted"><i class="fa-solid fa-lock" style="font-size:0.7rem;opacity:0.35;"></i></span>';
    const cls = score >= 70 ? 'text-success fw-bold'
        : score >= 50 ? 'text-primary fw-bold'
            : score >= 35 ? 'text-warning'
                : 'text-muted';
    return `<span class="claude-score-badge ${cls}">${score}</span>`;
}

function updateVisibleClaudeCells(animate = false) {
    const symbolToItem = new Map(currentCandidates.map(c => [String(c.symbol || '').toUpperCase(), c]));
    let delay = 0;
    $('#tbody-index tr[data-symbol]').each(function () {
        const symbol = String($(this).data('symbol') || '').toUpperCase();
        const item = symbolToItem.get(symbol);
        if (!item) return;
        const $cell = $(this).find('.claude-cell');
        $cell.html(fmtClaudeCell(item.claude_score));
        if (typeof item.claude_score === 'number') {
            $cell.removeClass('claude-locked claude-revealed claude-revealed-instant');
            if (animate) {
                const d = delay;
                setTimeout(() => $cell.addClass('claude-revealed'), d);
                delay += 18; // stagger 18ms per row
            } else {
                $cell.addClass('claude-revealed-instant');
            }
        }
    });
}

function collectClaudeScoringData() {
    return currentCandidates.map(c => {
        const m = c.metrics || {};
        return {
            symbol: c.symbol,
            growth_pct: c.order_growth_pct ?? null,
            freq: c.order_freq_tx ?? null,
            sm: [c.sm2 || 0, c.sm5 || 0, c.sm10 || 0, c.sm20 || 0],
            fn: [c.fn2 || 0, c.fn5 || 0, c.fn10 || 0, c.fn20 || 0],
            ln: [c.ln2 || 0, c.ln5 || 0, c.ln10 || 0, c.ln20 || 0],
            flow: [c.flow2 || 0, c.flow5 || 0, c.flow10 || 0, c.flow20 || 0],
            effort: [m.effort2 || 0, m.effort5 || 0, m.effort10 || 0, m.effort20 || 0],
            vwap: [m.vwap2 ?? null, m.vwap5 ?? null, m.vwap10 ?? null, m.vwap20 ?? null],
            ngr: [m.ngr2 ?? null, m.ngr5 ?? null, m.ngr10 ?? null, m.ngr20 ?? null],
            rvol: [c.rvol_2d ?? null, c.rvol_5d ?? null, c.rvol_10d ?? null, c.rvol_20d ?? null],
            cvd_multi: [c.order_cvd_2d ?? null, c.order_cvd_5d ?? null, c.order_cvd_10d ?? null, c.order_cvd_20d ?? null],
            cvd_pct_multi: [c.cvd_pct_2d ?? null, c.cvd_pct_5d ?? null, c.cvd_pct_10d ?? null, c.cvd_pct_20d ?? null],
            orderflow: {
                delta_pct: c.order_delta_pct ?? null,
                mom_pct: c.order_mom_pct ?? null,
                absorb: c.order_absorb ?? null,
                cvd: c.order_cvd ?? null,
                net_value: c.order_net_value ?? null
            },
            quadrant: c.order_quadrant || null,
            state: c.state || 'NEUTRAL',
            trend: c.trend || {}
        };
    });
}

function getActiveFilterFingerprint() {
    // Build a stable string from active filters + sort + numeric filters
    const parts = [];
    for (const [k, v] of Object.entries(activeFilters)) {
        if (v !== 'any') parts.push(`${k}=${v}`);
    }
    for (const [k, v] of Object.entries(numericFilters)) {
        if (!isNaN(v)) parts.push(`${k}=${v}`);
    }
    parts.push(`sort=${sortState.key}`);
    parts.push(`dir=${sortState.desc ? 'd' : 'a'}`);
    if (searchQuery) parts.push(`q=${searchQuery}`);
    return parts.sort().join('&');
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function getClaudeCacheKey() {
    const today = new Date().toISOString().split('T')[0];
    const fp = getActiveFilterFingerprint();
    const hash = fp ? simpleHash(fp) : 'all';
    return `claude_scores_${today}_${hash}`;
}

function loadClaudeScoresFromCache() {
    try {
        const raw = localStorage.getItem(getClaudeCacheKey());
        if (!raw) return null;
        const data = JSON.parse(raw);
        const age = (Date.now() - (data.timestamp || 0)) / 60000;
        if (age > 30) { localStorage.removeItem(getClaudeCacheKey()); return null; }
        return data.scores;
    } catch { return null; }
}

function saveClaudeScoresToCache(scores, symbols) {
    try {
        localStorage.setItem(getClaudeCacheKey(), JSON.stringify({
            scores,
            symbols: symbols || Object.keys(scores),
            filter_fingerprint: getActiveFilterFingerprint(),
            timestamp: Date.now()
        }));
    } catch { /* ignore */ }
}

function applyClaudeScores(scores, animate = false) {
    if (!scores || typeof scores !== 'object') return;
    const scoreMap = scores;
    // Apply to allCandidates so scores persist across filter/sort changes
    (allCandidates || []).forEach(c => {
        const s = scoreMap[String(c.symbol).toUpperCase()];
        if (typeof s === 'number') c.claude_score = s;
    });
    (currentCandidates || []).forEach(c => {
        const s = scoreMap[String(c.symbol).toUpperCase()];
        if (typeof s === 'number') c.claude_score = s;
    });
    updateVisibleClaudeCells(animate);
}

async function handleClaudeScoreClick() {
    const $btn = $('#btn-claude-score');
    if ($btn.prop('disabled')) return;

    // Layer 1: In-memory check — scores already applied on candidates?
    if (currentCandidates && currentCandidates.length > 0) {
        const scored = currentCandidates.filter(c => typeof c.claude_score === 'number');
        if (scored.length >= Math.floor(currentCandidates.length * 0.8)) {
            // ≥80% already scored → just re-render, no API call
            updateVisibleClaudeCells(false);
            showToast('✓ Claude Score sudah tersedia', 'info');
            return;
        }
    }

    // Layer 2: localStorage cache (TTL 30 min)
    const cached = loadClaudeScoresFromCache();
    if (cached) {
        applyClaudeScores(cached, true); // animate reveal
        showToast('✓ Claude Score loaded from cache', 'success');
        return;
    }

    if (!currentCandidates || currentCandidates.length < 10) {
        showToast('⚠ Terlalu sedikit emiten untuk scoring (min 10)', 'warning');
        return;
    }

    // UI: loading state
    $btn.prop('disabled', true).addClass('loading');

    try {
        // Wait for data maturity: orderflow hydration may still be in-flight.
        // Check if key fields have settled for at least some visible rows.
        const maturityStart = Date.now();
        const MATURITY_MAX_WAIT = 5000; // max 5s
        const MATURITY_CHECK_INTERVAL = 500;
        while (Date.now() - maturityStart < MATURITY_MAX_WAIT) {
            const sample = currentCandidates.slice(0, 20);
            const hydratedCount = sample.filter(c =>
                c.order_delta_pct != null || c.order_freq_tx != null ||
                c.rvol_2d != null || c.order_cvd_2d != null
            ).length;
            if (hydratedCount >= Math.min(10, sample.length)) break; // enough data
            await new Promise(r => setTimeout(r, MATURITY_CHECK_INTERVAL));
        }

        const candidates = collectClaudeScoringData();
        const symbols = candidates.map(c => c.symbol);

        // Build filter_state from URL params for R2 keying
        const filterState = {};
        for (const [k, v] of Object.entries(activeFilters)) {
            if (v !== 'any') filterState[k] = v;
        }
        for (const [k, v] of Object.entries(numericFilters)) {
            if (!isNaN(v)) filterState[k] = v;
        }

        const payload = {
            timestamp: new Date().toISOString(),
            universe_size: candidates.length,
            symbols,
            filter_state: filterState,
            sort_key: sortState.key,
            sort_dir: sortState.desc ? 'desc' : 'asc',
            candidates
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000); // 90s timeout

        const resp = await fetch(`${WORKER_BASE_URL}/ai/claude-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        clearTimeout(timeout);

        const data = await resp.json();

        if (!data.ok) {
            throw new Error(data.error || 'Scoring failed');
        }

        // Apply scores with reveal animation
        applyClaudeScores(data.scores, true);
        saveClaudeScoresToCache(data.scores, data.symbols);

        const count = data.universe_size || Object.keys(data.scores).length;
        const src = data.source === 'r2_cache' ? ' (cached)' : '';
        const msg = `✓ Claude scored ${count} emiten${src}`;
        showToast(msg, 'success');

    } catch (err) {
        if (err.name === 'AbortError') {
            showToast('⚠ Scoring timeout, coba lagi', 'warning');
        } else {
            showToast(`✗ ${err.message}`, 'danger');
        }
        console.error('[Claude-Score]', err);
    } finally {
        $btn.prop('disabled', false).removeClass('loading');
    }
}

// ── Scenario Test: Verify R2 cache matches frontend ──
window.__verifyClaudeCache = async function () {
    console.log('[Claude-Verify] Starting verification...');

    // 1. Collect current frontend state
    const frontendSymbols = currentCandidates.map(c => String(c.symbol).toUpperCase());
    console.log(`[Claude-Verify] Frontend: ${frontendSymbols.length} candidates, filter: ${getActiveFilterFingerprint() || '(none)'}`);

    // 2. Check localStorage cache
    const cacheKey = getClaudeCacheKey();
    const localRaw = localStorage.getItem(cacheKey);
    if (!localRaw) {
        console.warn('[Claude-Verify] No localStorage cache found for key:', cacheKey);
    } else {
        const localData = JSON.parse(localRaw);
        const localSymbols = localData.symbols || Object.keys(localData.scores || {});
        const localScoreCount = Object.keys(localData.scores || {}).length;
        const ageMins = ((Date.now() - (localData.timestamp || 0)) / 60000).toFixed(1);
        console.log(`[Claude-Verify] localStorage: ${localScoreCount} scores, ${localSymbols.length} symbols, age=${ageMins}min, fingerprint=${localData.filter_fingerprint || '(none)'}`);

        // Check symbol match
        const frontendSet = new Set(frontendSymbols);
        const localSet = new Set(localSymbols.map(s => s.toUpperCase()));
        const missingInCache = frontendSymbols.filter(s => !localSet.has(s));
        const extraInCache = localSymbols.filter(s => !frontendSet.has(s.toUpperCase()));
        if (missingInCache.length) console.warn(`[Claude-Verify] localStorage missing ${missingInCache.length} frontend symbols:`, missingInCache.slice(0, 10));
        if (extraInCache.length) console.warn(`[Claude-Verify] localStorage has ${extraInCache.length} extra symbols:`, extraInCache.slice(0, 10));
        if (!missingInCache.length && !extraInCache.length) console.log('[Claude-Verify] ✓ localStorage symbols match frontend exactly');
    }

    // 3. Fetch latest R2 cache via verify endpoint
    try {
        const fp = getActiveFilterFingerprint();
        const hash = fp ? simpleHash(fp) : 'all';
        const today = new Date().toISOString().split('T')[0];
        const verifyUrl = `${WORKER_BASE_URL}/ai/claude-score/verify?date=${today}&hash=${hash}`;
        console.log(`[Claude-Verify] Fetching R2 verify: ${verifyUrl}`);
        const r2Resp = await fetch(verifyUrl);
        const r2Data = await r2Resp.json();
        if (r2Data.ok && r2Data.latest) {
            const r2 = r2Data.latest;
            console.log(`[Claude-Verify] R2 latest: ${r2.symbol_count} symbols, ${r2.score_count} scores, hash=${r2.filter_hash}, generated=${r2.generated_at}`);
            // Compare R2 symbols with frontend
            const r2Set = new Set((r2.symbols || []).map(s => s.toUpperCase()));
            const r2Missing = frontendSymbols.filter(s => !r2Set.has(s));
            const r2Extra = (r2.symbols || []).filter(s => !new Set(frontendSymbols).has(s.toUpperCase()));
            if (r2Missing.length) console.warn(`[Claude-Verify] R2 missing ${r2Missing.length} frontend symbols:`, r2Missing.slice(0, 10));
            if (r2Extra.length) console.warn(`[Claude-Verify] R2 has ${r2Extra.length} extra symbols:`, r2Extra.slice(0, 10));
            if (!r2Missing.length && !r2Extra.length) console.log('[Claude-Verify] ✓ R2 symbols match frontend exactly');
        } else {
            console.log(`[Claude-Verify] No R2 latest found for hash=${hash}. ${r2Data.artifact_count || 0} artifacts on ${today}.`);
        }
    } catch (e) {
        console.error('[Claude-Verify] R2 verify fetch failed:', e);
    }

    // 4. Compare scores on currently displayed rows
    const scoreMap = {};
    if (localRaw) {
        const localData = JSON.parse(localRaw);
        Object.assign(scoreMap, localData.scores);
    }
    let matched = 0, mismatched = 0, unscored = 0;
    currentCandidates.forEach(c => {
        const sym = String(c.symbol).toUpperCase();
        const frontendScore = c.claude_score;
        const cachedScore = scoreMap[sym];
        if (frontendScore == null && cachedScore == null) { unscored++; return; }
        if (frontendScore === cachedScore) { matched++; }
        else { mismatched++; if (mismatched <= 5) console.warn(`[Claude-Verify] Mismatch: ${sym} frontend=${frontendScore} cache=${cachedScore}`); }
    });
    console.log(`[Claude-Verify] Score comparison: ${matched} matched, ${mismatched} mismatched, ${unscored} unscored`);

    const passed = mismatched === 0 && matched > 0;
    console.log(`[Claude-Verify] Result: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
    return { passed, matched, mismatched, unscored, frontendCount: frontendSymbols.length };
};

function scheduleProbRefreshAfterOrderflow() {
    if (probRefreshTimer) clearTimeout(probRefreshTimer);
    probRefreshTimer = setTimeout(() => {
        probRefreshTimer = null;
        // Recompute for all candidates so percentiles stay stable, then update visible
        if (Array.isArray(allCandidates) && allCandidates.length > 0) {
            recomputeProbColumns(allCandidates);
        }
        if (!Array.isArray(currentCandidates) || !currentCandidates.length) return;
        if (sortState.key === 'tom2_prob' || sortState.key === 'swg5_prob') {
            sortCandidates(sortState.key, sortState.desc);
            return;
        }
        updateVisibleProbCells();
        loadOpportunityBubbleChart(currentCandidates);
    }, 180);
}

/**
 * Apply client-side filters and re-render.
 * Filters are checked per-window. If window selector is 'any', candidate passes if ANY window passes.
 * If a specific window is selected, only that window is checked.
 */
function applyFilter() {
    const wKey = activeFilters.horizon;

    // Text search filter
    let source = allCandidates;
    if (searchQuery) {
        const q = searchQuery.toUpperCase().trim();
        const terms = q.split(/[,\s]+/).filter(Boolean);
        source = allCandidates.filter(c => {
            const sym = (c.symbol || '').toUpperCase();
            return terms.some(t => sym.includes(t));
        });
    }

    currentCandidates = source.filter(c => {
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

            // Local flow filter
            if (activeFilters.local === 'allPos' && !w.localAllPos) return false;
            if (activeFilters.local === 'positive' && (w.ln || 0) <= 0) return false;

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
    // Quadrant filter
    if (activeFilters.quadrant !== 'any') {
        const qf = activeFilters.quadrant;
        currentCandidates = currentCandidates.filter(c => c.order_quadrant === qf);
    }
    // Numeric threshold filters (≥ value)
    currentCandidates = currentCandidates.filter(c => {
        if (Number.isFinite(numericFilters.growth_min)  && !((c.order_growth_pct ?? -Infinity) >= numericFilters.growth_min)) return false;
        if (Number.isFinite(numericFilters.freq_min)    && !((c.order_freq_tx ?? -Infinity) >= numericFilters.freq_min)) return false;
        if (Number.isFinite(numericFilters.tom2_min)    && !((c.tom2_prob ?? -1) >= numericFilters.tom2_min)) return false;
        if (Number.isFinite(numericFilters.swg5_min)    && !((c.swg5_prob ?? -1) >= numericFilters.swg5_min)) return false;
        if (Number.isFinite(numericFilters.delta_min)   && !((c.order_delta_pct ?? -Infinity) >= numericFilters.delta_min)) return false;
        if (Number.isFinite(numericFilters.mom_min)     && !((c.order_mom_pct ?? -Infinity) >= numericFilters.mom_min)) return false;
        if (Number.isFinite(numericFilters.absorb_min)  && !((c.order_absorb ?? -Infinity) >= numericFilters.absorb_min)) return false;
        if (Number.isFinite(numericFilters.cvd_min)     && !((c.order_cvd ?? -Infinity) >= numericFilters.cvd_min)) return false;
        if (Number.isFinite(numericFilters.rvol_min)    && !((c.rvol_2d ?? c.rvol_5d ?? -Infinity) >= numericFilters.rvol_min)) return false;
        if (Number.isFinite(numericFilters.value_min)   && !((c.order_net_value ?? -Infinity) >= numericFilters.value_min)) return false;
        return true;
    });

    $('#screener-count').text(`${currentCandidates.length} emiten`);
    renderFilterPills();
    recomputeProbColumns(currentCandidates);
    sortCandidates(sortState.key, sortState.desc);
    loadOpportunityBubbleChart(currentCandidates);
    pushUrlState();
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
let opportunityBubbleChart = null;
let bubbleChartAnimatedOnInitialLoad = false;
let foreignWidgetTitleHtml = 'Foreign Flow';

function refreshMarketWidgetHeader() {
    const activeChart = $('#market-chart-carousel .carousel-item.active').data('chart') || 'foreign';
    const $title = $('#market-widget-title');
    const $range = $('#foreign-range-selector');
    const $tabBar = $('#bubble-tab-bar');

    if (activeChart === 'bubble') {
        $title.html('Orderflow Bubble Opportunity <span class="d-block small mt-2 mb-3" style="font-weight:500">Top peluang intraday</span>');
        $range.addClass('d-none');
        $tabBar.removeClass('d-none');
        return;
    }

    $title.html(foreignWidgetTitleHtml);
    $range.removeClass('d-none');
    $tabBar.addClass('d-none');
}

function setupMarketChartCarousel() {
    const $carousel = $('#market-chart-carousel');
    if (!$carousel.length) return;

    $carousel.off('slid.bs.carousel.market').on('slid.bs.carousel.market', function () {
        refreshMarketWidgetHeader();

        const activeChart = $('#market-chart-carousel .carousel-item.active').data('chart') || 'foreign';
        if (activeChart === 'bubble' && opportunityBubbleChart) {
            opportunityBubbleChart.resize();
            opportunityBubbleChart.update('none');
        } else if (activeChart === 'foreign' && foreignSentimentChart) {
            foreignSentimentChart.resize();
            foreignSentimentChart.update('none');
        }
    });

    refreshMarketWidgetHeader();
}

function getQuadrantBubbleColor(q) {
    if (q === 'Q1') return { bg: 'rgba(34,197,94,0.75)', bd: 'rgba(21,128,61,0.9)' };
    if (q === 'Q2') return { bg: 'rgba(59,130,246,0.70)', bd: 'rgba(37,99,235,0.9)' };
    if (q === 'Q3') return { bg: 'rgba(239,68,68,0.72)', bd: 'rgba(185,28,28,0.9)' };
    if (q === 'Q4') return { bg: 'rgba(245,158,11,0.72)', bd: 'rgba(217,119,6,0.9)' };
    return { bg: 'rgba(148,163,184,0.60)', bd: 'rgba(100,116,139,0.9)' };
}

function buildBubblePointsFromCandidates(candidates, maxRows = 100) {
    if (!Array.isArray(candidates) || !candidates.length) return [];
    const scoped = candidates.slice(0, maxRows);

    return scoped.map(item => {
        const x = Number(item?.order_delta_pct);
        const y = Number(item?.order_mom_pct);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

        const q = item?.order_quadrant || inferOrderQuadrant(x, y);
        const sizeRef = Math.abs(Number(item?.order_net_value))
            || Math.abs(Number(item?.order_cvd))
            || Math.abs(Number(item?.sm2 || 0))
            || 1;

        return {
            kode: String(item?.symbol || '').toUpperCase(),
            emiten: String(item?.symbol || '').toUpperCase(),
            label: String(item?.symbol || '').toUpperCase(),
            x,
            y,
            q,
            sizeRef,
            r: 10
        };
    }).filter(Boolean);
}

function loadOpportunityBubbleChart(candidates = currentCandidates) {
    try {
        const isInitialRender = !opportunityBubbleChart;
        if (isInitialRender) {
            $('#bubble-chart-loading').show().html(`
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Loading...</span>
                </div>
                <p class="small text-muted mt-2 mb-0">Memuat bubble chart orderflow...</p>
            `);
            $('#bubble-chart-container').hide();
        }

        let points = buildBubblePointsFromCandidates(candidates, 100);

        if (!points.length) {
            if (opportunityBubbleChart) {
                opportunityBubbleChart.destroy();
                opportunityBubbleChart = null;
            }
            $('#bubble-chart-container').hide();
            // Check if market is open (09:00-16:30 WIB)
            const nowWIB = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            const hWIB = nowWIB.getHours(), mWIB = nowWIB.getMinutes();
            const isMarketHours = (hWIB > 9 || (hWIB === 9 && mWIB >= 0)) && (hWIB < 16 || (hWIB === 16 && mWIB <= 30));
            const msg = isMarketHours
                ? 'Data bubble tidak tersedia untuk filter aktif'
                : 'Market belum buka — data intraday belum tersedia';
            $('#bubble-chart-loading').show().html(`<p class="small text-muted mb-0">${msg}</p>`);
            return;
        }

        const sizeVals = points.map(p => Number(p.sizeRef) || 0).filter(v => Number.isFinite(v) && v > 0);
        const sizeMin = sizeVals.length ? Math.min(...sizeVals) : 1;
        const sizeMax = sizeVals.length ? Math.max(...sizeVals) : 1;
        const logMin = Math.log10(sizeMin + 1);
        const logMax = Math.log10(sizeMax + 1);
        const span = Math.max(1e-6, logMax - logMin);

        points = points.map(p => {
            const v = Math.max(0, Number(p.sizeRef) || 0);
            const t = (Math.log10(v + 1) - logMin) / span;
            const radius = 10 + (Math.max(0, Math.min(1, t)) * 24); // 10..34 px
            return { ...p, r: radius };
        });

        const xVals = points.map(p => p.x);
        const yVals = points.map(p => p.y);
        const maxR = points.reduce((m, p) => Math.max(m, Number(p.r) || 0), 0);
        const xMin = Math.min(...xVals);
        const xMax = Math.max(...xVals);
        const yMin = Math.min(...yVals);
        const yMax = Math.max(...yVals);
        const xRange = Math.max(1, xMax - xMin);
        const yRange = Math.max(1, yMax - yMin);
        const xPad = Math.max(2, xRange * 0.2);
        const yPad = Math.max(4, yRange * 0.2);
        // Overscan so large circles near bounds are not cut off
        const xOverscan = Math.max(2, (maxR / 34) * xRange * 0.08);
        const yOverscan = Math.max(3, (maxR / 34) * yRange * 0.12);

        const ctx = document.getElementById('opportunity-bubble-chart').getContext('2d');

        const bubbleTextLabelsPlugin = {
            id: 'bubbleTextLabels',
            afterDatasetsDraw(chart) {
                const dataset = chart?.data?.datasets?.[0];
                const meta = chart?.getDatasetMeta?.(0);
                if (!dataset || !meta || !Array.isArray(meta.data)) return;

                const { ctx, chartArea } = chart;
                ctx.save();
                ctx.font = '600 11px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.95)';
                ctx.textAlign = 'center';

                meta.data.forEach((el, i) => {
                    const raw = dataset.data?.[i] || {};
                    const label = raw.emiten || raw.kode || raw.label || '';
                    if (!label || !el) return;

                    const p = el.getProps(['x', 'y', 'options'], true);
                    const r = Number(p?.options?.radius ?? raw.r ?? 0);
                    const power = Number(raw.x) || 0;
                    const tx = p.x;
                    
                    let ty;
                    if (power >= 0) {
                        ctx.textBaseline = 'bottom';
                        ty = p.y - r - 4;
                    } else {
                        ctx.textBaseline = 'top';
                        ty = p.y + r + 4;
                    }

                    if (tx < chartArea.left - 40 || tx > chartArea.right + 40) return;
                    if (ty < chartArea.top - 20 || ty > chartArea.bottom + 20) return;

                    ctx.fillText(label, tx, ty);
                });

                ctx.restore();
            }
        };

        const shouldAnimateInitial = isInitialRender && !bubbleChartAnimatedOnInitialLoad;
        const bgColors = points.map(p => getQuadrantBubbleColor(p.q).bg);
        const bdColors = points.map(p => getQuadrantBubbleColor(p.q).bd);
        const baseDataset = {
            label: 'Opportunity',
            data: points,
            backgroundColor: bgColors,
            borderColor: bdColors,
            borderWidth: 1,
            hoverRadius: 0,
            hoverBorderWidth: 1,
            hoverBackgroundColor: bgColors,
            hoverBorderColor: bdColors,
            clip: false
        };

        if (isInitialRender) {
            opportunityBubbleChart = new Chart(ctx, {
                type: 'bubble',
                data: {
                    datasets: [baseDataset]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animations: shouldAnimateInitial
                        ? {
                            x: { duration: 0 },
                            y: { duration: 0 },
                            radius: {
                                from: 0,
                                duration: 320,
                                easing: 'easeOutBack'
                            }
                        }
                        : {
                            x: { duration: 0 },
                            y: { duration: 0 },
                            radius: { duration: 0 }
                        },
                    transitions: {
                        active: {
                            animation: {
                                duration: 0
                            }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        datalabels: { display: false },
                        tooltip: {
                            enabled: true,
                            displayColors: false,
                            animation: false,
                            callbacks: {
                                title: function () { return ''; },
                                label: function (ctx) {
                                    const p = ctx.raw || {};
                                    const name = p.emiten || p.kode || p.label || '-';
                                    const q = p.q || '-';
                                    return `${name} | ${q} | Δ ${Number(p.x || 0).toFixed(2)}% | Mom ${Number(p.y || 0).toFixed(2)}%`;
                                }
                            }
                        }
                    },
                    onHover: function(event, elements) {
                        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
                    },
                    onClick: function(event) {
                        const els = opportunityBubbleChart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false);
                        if (els.length) {
                            const pt = opportunityBubbleChart.data.datasets[0].data[els[0].index];
                            if (pt && pt.kode) {
                                window.location.href = '/idx/emiten/broker-summary.html?kode=' + pt.kode;
                            }
                        }
                    },
                    elements: {
                        point: {
                            hoverRadius: 0,
                            hoverBorderWidth: 1
                        }
                    },
                    interaction: { mode: 'nearest', intersect: true },
                    hover: { mode: 'nearest', intersect: true },
                    scales: {
                        x: {
                            title: { display: false },
                            min: xMin - xPad - xOverscan,
                            max: xMax + xPad + xOverscan,
                            ticks: { display: false },
                            grid: {
                                color: (ctx) => Math.abs(Number(ctx?.tick?.value || 0)) < 1e-9
                                    ? 'rgba(148,163,184,0.55)'
                                    : 'rgba(0,0,0,0)',
                                lineWidth: (ctx) => Math.abs(Number(ctx?.tick?.value || 0)) < 1e-9 ? 1.2 : 0,
                                drawBorder: false
                            },
                            border: { display: false }
                        },
                        y: {
                            title: { display: false },
                            min: yMin - yPad - yOverscan,
                            max: yMax + yPad + yOverscan,
                            ticks: { display: false },
                            grid: {
                                color: (ctx) => Math.abs(Number(ctx?.tick?.value || 0)) < 1e-9
                                    ? 'rgba(148,163,184,0.55)'
                                    : 'rgba(0,0,0,0)',
                                lineWidth: (ctx) => Math.abs(Number(ctx?.tick?.value || 0)) < 1e-9 ? 1.2 : 0,
                                drawBorder: false
                            },
                            border: { display: false }
                        }
                    }
                },
                plugins: [bubbleTextLabelsPlugin]
            });
            bubbleChartAnimatedOnInitialLoad = true;
            // Kill ALL animations after initial pop-in so hover never animates
            if (shouldAnimateInitial) {
                setTimeout(() => {
                    if (opportunityBubbleChart) {
                        opportunityBubbleChart.options.animation = false;
                        opportunityBubbleChart.options.animations = { radius: { duration: 0 } };
                    }
                }, 400);
            }
        } else {
            const ds = opportunityBubbleChart.data.datasets[0];
            ds.data = points;
            ds.backgroundColor = bgColors;
            ds.borderColor = bdColors;
            ds.hoverBackgroundColor = bgColors;
            ds.hoverBorderColor = bdColors;

            opportunityBubbleChart.options.scales.x.min = xMin - xPad - xOverscan;
            opportunityBubbleChart.options.scales.x.max = xMax + xPad + xOverscan;
            opportunityBubbleChart.options.scales.y.min = yMin - yPad - yOverscan;
            opportunityBubbleChart.options.scales.y.max = yMax + yPad + yOverscan;

            opportunityBubbleChart.update('none');
        }

        $('#bubble-chart-loading').hide();
        $('#bubble-chart-container').show();
    } catch (e) {
        console.error('Error loading bubble chart:', e);
        $('#bubble-chart-loading').html('<p class="small text-danger mb-0">Gagal memuat bubble chart</p>');
    }
}

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
        
        if (!data || !data.data || typeof data.data !== 'object') {
            $('#foreign-chart-loading').html('<p class="small text-muted mb-0">Data tidak tersedia</p>');
            return;
        }
        
        // Hide loading, show chart
        $('#foreign-chart-loading').hide();
        $('#foreign-chart-container').show();
        
        // Rebuild cross-ticker daily series from raw endpoint payload.
        // We intentionally skip dates where all tickers have buy=sell=0 (incomplete/stale ingest),
        // because those should not be rendered as valid 0-flow trading days.
        const dailyByDate = new Map();
        Object.values(data.data).forEach(rows => {
            if (!Array.isArray(rows)) return;
            rows.forEach(r => {
                const dt = r?.date;
                if (!dt) return;
                const buyRaw = r?.buy;
                const sellRaw = r?.sell;
                const netRaw = r?.net;
                const buy = (typeof buyRaw === 'number' && Number.isFinite(buyRaw)) ? buyRaw : null;
                const sell = (typeof sellRaw === 'number' && Number.isFinite(sellRaw)) ? sellRaw : null;
                const net = (typeof netRaw === 'number' && Number.isFinite(netRaw)) ? netRaw : null;
                const cur = dailyByDate.get(dt) || { buy: 0, sell: 0, net: 0 };
                if (buy !== null) cur.buy += buy;
                if (sell !== null) cur.sell += sell;
                if (net !== null) cur.net += net;
                dailyByDate.set(dt, cur);
            });
        });

        const validDaily = Array.from(dailyByDate.entries())
            .map(([date, v]) => ({ date, buy: v.buy, sell: v.sell, net: v.net }))
            .filter(d => (Math.abs(d.buy) + Math.abs(d.sell)) > 0)
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        if (!validDaily.length) {
            $('#foreign-chart-loading').html('<p class="small text-muted mb-0">Data tidak tersedia</p>');
            return;
        }

        const dates = validDaily.map(d => d.date);
        const netValues = [];
        let acc = 0;
        validDaily.forEach(d => {
            acc += d.net;
            netValues.push(acc / 1e9);
        });
        
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
                                const status = val >= 0 ? 'Inflow' : 'Outflow';
                                return `${status}: Rp ${Math.abs(val).toFixed(1)} B`;
                            }
                        }
                    },
                    datalabels: {
                        display: true,
                        color: 'rgba(255, 255, 255, 0.75)',
                        clamp: true,
                        clip: false,
                        font: {
                            size: 10,
                            weight: '600',
                            family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
                        },
                        align: function(ctx) {
                            const val = ctx.dataset.data[ctx.dataIndex];
                            const meta = ctx.chart.getDatasetMeta(ctx.datasetIndex);
                            const el = meta?.data?.[ctx.dataIndex];
                            const y = Number(el?.y);
                            const top = Number(ctx.chart?.chartArea?.top ?? 0);
                            const bottom = Number(ctx.chart?.chartArea?.bottom ?? 0);

                            if (val >= 0) {
                                if (Number.isFinite(y) && (y - top) < 14) return 'bottom';
                                return 'top';
                            }
                            if (Number.isFinite(y) && (bottom - y) < 14) return 'top';
                            return 'bottom';
                        },
                        anchor: 'center',
                        offset: 6,
                        formatter: function(value) {
                            return value.toFixed(1);
                        }
                    }
                },
                scales: {
                    y: {
                        title: { display: false },
                        ticks: { display: false },
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
        const totalNet = netValues[netValues.length - 1] || 0;
        const trend = totalNet >= 0 ? 'text-success' : 'text-danger';
        const arrow = totalNet >= 0 ? '↑' : '↓';
        foreignWidgetTitleHtml = `Foreign Flow 10 Saham Cap Terbesar<span class="d-block mb-3 mt-2 ${trend} fw-bold" style="font-size:2rem"><i style="font-weight:900">${arrow}</i> Rp ${Math.abs(totalNet).toFixed(1)} B</span>`;
        refreshMarketWidgetHeader();
        
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
    // Apply numeric presets if defined, else reset
    const numRecipe = PRESET_NUMERIC[name];
    if (numRecipe) {
        Object.keys(numericFilters).forEach(k => numericFilters[k] = numRecipe[k] ?? NaN);
    } else {
        Object.keys(numericFilters).forEach(k => numericFilters[k] = NaN);
    }
    // Sync numeric inputs to new values
    Object.keys(numericFilters).forEach(k => {
        const $inp = $(`.num-filter-input[data-nf="${k}"]`);
        if ($inp.length) $inp.val(Number.isFinite(numericFilters[k]) ? numericFilters[k] : '');
    });
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
            : key === 'local' ? 'Local'
            : key === 'streak' ? 'Trend'
            : key === 'zeffort' ? 'Effort Rel'
            : key === 'zngr' ? 'NGR Rel'
            : key === 'zvwap' ? 'VWAP Rel'
            : key === 'effort' ? 'Effort'
            : key === 'state' ? 'State'
            : key === 'horizon' ? 'Horizon'
            : key === 'quadrant' ? 'Quadrant'
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
        const filtersMatch = Object.keys(recipe).every(k => activeFilters[k] === recipe[k]);
        if (!filtersMatch) continue;
        // Also check numeric filters match the preset's numeric recipe (if any)
        const numRecipe = PRESET_NUMERIC[name];
        if (numRecipe) {
            const numMatch = Object.keys(numericFilters).every(k => {
                const expected = numRecipe[k] ?? NaN;
                const actual = numericFilters[k];
                return (Number.isNaN(expected) && Number.isNaN(actual)) || expected === actual;
            });
            if (!numMatch) continue;
        } else {
            // Non-numeric presets should have no numeric filters active
            const hasNumeric = Object.values(numericFilters).some(v => Number.isFinite(v));
            if (hasNumeric) continue;
        }
        activePreset = name;
        $('#preset-selector a').removeClass('active');
        $(`#preset-selector a[data-preset="${name}"]`).addClass('active');
        $('#preset-desc').text(PRESET_DESC[name] || '');
        return;
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
                : key === 'local' ? 'Local'
                : key === 'streak' ? 'Trend'
                : key === 'zeffort' ? 'Effort Rel'
                : key === 'zngr' ? 'NGR Rel'
                : key === 'zvwap' ? 'VWAP Rel'
                : key === 'effort' ? 'Effort'
                : key === 'state' ? 'State'
                : key === 'horizon' ? 'Horizon'
                : key === 'quadrant' ? 'Quadrant'
                : key;
            $pills.append(`
                <span class="badge bg-${color} bg-opacity-10 text-${color}" style="cursor:pointer;" data-remove-filter="${key}">
                    ${prefix}: ${label} <i class="fa-solid fa-xmark ms-1"></i>
                </span>
            `);
        }
    });
    // Numeric filter pills
    const numLabels = {
        growth_min: 'Growth', freq_min: 'Freq', tom2_min: 'TOM2', swg5_min: 'SWG5',
        delta_min: 'Δ%', mom_min: 'Mom%', absorb_min: 'Absorb', cvd_min: 'CVD',
        rvol_min: 'RVOL', value_min: 'Value'
    };
    Object.keys(numericFilters).forEach(nk => {
        if (Number.isFinite(numericFilters[nk])) {
            const lbl = numLabels[nk] || nk;
            $pills.append(`
                <span class="badge bg-secondary bg-opacity-10 text-secondary" style="cursor:pointer;" data-remove-numeric="${nk}">
                    ${lbl} ≥ ${numericFilters[nk]} <i class="fa-solid fa-xmark ms-1"></i>
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

// Click pill X to remove a numeric threshold filter
$(document).on('click', '[data-remove-numeric]', function() {
    const nk = $(this).data('remove-numeric');
    numericFilters[nk] = NaN;
    $(`.num-filter-input[data-nf="${nk}"]`).val('');
    syncNumericDropdowns();
    detectMatchingPreset();
    applyFilter();
});

// Numeric threshold input handler (debounced)
let _numFilterDebounce = null;
$(document).on('input', '.num-filter-input', function() {
    const nk = $(this).data('nf');
    const raw = $(this).val().trim();
    numericFilters[nk] = raw === '' ? NaN : parseFloat(raw);
    syncNumericDropdowns();
    clearTimeout(_numFilterDebounce);
    _numFilterDebounce = setTimeout(() => {
        detectMatchingPreset();
        applyFilter();
    }, 400);
});

const NUMERIC_DD_MAP = {
    growth_min: { id: '#dd-growth', prefix: 'Growth' },
    freq_min:   { id: '#dd-freq',   prefix: 'Freq' },
    tom2_min:   { id: '#dd-tom2',   prefix: 'TOM2' },
    swg5_min:   { id: '#dd-swg5',   prefix: 'SWG5' },
    delta_min:  { id: '#dd-delta',  prefix: 'Δ%' },
    mom_min:    { id: '#dd-mom',    prefix: 'Mom%' },
    absorb_min: { id: '#dd-absorb', prefix: 'Absorb' },
    cvd_min:    { id: '#dd-cvd',    prefix: 'CVD' },
    rvol_min:   { id: '#dd-rvol',   prefix: 'RVOL' },
    value_min:  { id: '#dd-value',  prefix: 'Value' }
};

function syncNumericDropdowns() {
    Object.entries(NUMERIC_DD_MAP).forEach(([nk, cfg]) => {
        const $btn = $(cfg.id);
        if (!$btn.length) return;
        const v = numericFilters[nk];
        if (Number.isFinite(v)) {
            $btn.text(`${cfg.prefix} ≥ ${v}`);
            $btn.removeClass('btn-outline-secondary').addClass('btn-secondary text-white');
        } else {
            $btn.text(`${cfg.prefix}: Any`);
            $btn.removeClass('btn-secondary text-white').addClass('btn-outline-secondary');
        }
    });
}

// Reset all filters button
$(document).on('click', '#btn-reset-filters', function(e) {
    e.preventDefault();
    Object.keys(activeFilters).forEach(k => activeFilters[k] = 'any');
    Object.keys(numericFilters).forEach(k => numericFilters[k] = NaN);
    $('.num-filter-input').val('');
    searchQuery = '';
    $('#emiten-search').val('');
    activePreset = 'all';
    syncFilterDropdowns();
    syncNumericDropdowns();
    $('#preset-selector a').removeClass('active');
    $('#preset-selector a[data-preset="all"]').addClass('active');
    $('#preset-desc').text(PRESET_DESC['all'] || '');
    applyFilter();
});

// Emiten symbol search (debounced)
let _searchDebounce = null;
$(document).on('input', '#emiten-search', function() {
    searchQuery = $(this).val().trim();
    screenerPage = 1;
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => applyFilter(), 200);
});
$(document).on('keydown', '#emiten-search', function(e) {
    if (e.key === 'Escape') {
        searchQuery = '';
        $(this).val('');
        applyFilter();
    }
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
        else if (key === 'fn2')  { valA = a.fn2  || 0; valB = b.fn2  || 0; }
        else if (key === 'fn5')  { valA = a.fn5  || 0; valB = b.fn5  || 0; }
        else if (key === 'fn10') { valA = a.fn10 || 0; valB = b.fn10 || 0; }
        else if (key === 'fn20') { valA = a.fn20 || 0; valB = b.fn20 || 0; }
        else if (key === 'ln2')  { valA = a.ln2  || 0; valB = b.ln2  || 0; }
        else if (key === 'ln5')  { valA = a.ln5  || 0; valB = b.ln5  || 0; }
        else if (key === 'ln10') { valA = a.ln10 || 0; valB = b.ln10 || 0; }
        else if (key === 'ln20') { valA = a.ln20 || 0; valB = b.ln20 || 0; }
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
        else if (key === 'order_delta_pct') { valA = (typeof a.order_delta_pct === 'number') ? a.order_delta_pct : -Infinity; valB = (typeof b.order_delta_pct === 'number') ? b.order_delta_pct : -Infinity; }
        else if (key === 'order_growth_pct') { valA = (typeof a.order_growth_pct === 'number') ? a.order_growth_pct : -Infinity; valB = (typeof b.order_growth_pct === 'number') ? b.order_growth_pct : -Infinity; }
        else if (key === 'order_freq_tx') { valA = (typeof a.order_freq_tx === 'number') ? a.order_freq_tx : -Infinity; valB = (typeof b.order_freq_tx === 'number') ? b.order_freq_tx : -Infinity; }
        else if (key === 'order_mom_pct') { valA = (typeof a.order_mom_pct === 'number') ? a.order_mom_pct : -Infinity; valB = (typeof b.order_mom_pct === 'number') ? b.order_mom_pct : -Infinity; }
        else if (key === 'order_absorb') { valA = (typeof a.order_absorb === 'number') ? a.order_absorb : -Infinity; valB = (typeof b.order_absorb === 'number') ? b.order_absorb : -Infinity; }
        else if (key === 'order_cvd') { valA = (typeof a.order_cvd === 'number') ? a.order_cvd : -Infinity; valB = (typeof b.order_cvd === 'number') ? b.order_cvd : -Infinity; }
        else if (key === 'order_cvd_2d')  { valA = (typeof a.cvd_pct_2d  === 'number') ? a.cvd_pct_2d  : (typeof a.order_cvd_2d  === 'number') ? a.order_cvd_2d  : -Infinity; valB = (typeof b.cvd_pct_2d  === 'number') ? b.cvd_pct_2d  : (typeof b.order_cvd_2d  === 'number') ? b.order_cvd_2d  : -Infinity; }
        else if (key === 'order_cvd_5d')  { valA = (typeof a.cvd_pct_5d  === 'number') ? a.cvd_pct_5d  : (typeof a.order_cvd_5d  === 'number') ? a.order_cvd_5d  : -Infinity; valB = (typeof b.cvd_pct_5d  === 'number') ? b.cvd_pct_5d  : (typeof b.order_cvd_5d  === 'number') ? b.order_cvd_5d  : -Infinity; }
        else if (key === 'order_cvd_10d') { valA = (typeof a.cvd_pct_10d === 'number') ? a.cvd_pct_10d : (typeof a.order_cvd_10d === 'number') ? a.order_cvd_10d : -Infinity; valB = (typeof b.cvd_pct_10d === 'number') ? b.cvd_pct_10d : (typeof b.order_cvd_10d === 'number') ? b.order_cvd_10d : -Infinity; }
        else if (key === 'order_cvd_20d') { valA = (typeof a.cvd_pct_20d === 'number') ? a.cvd_pct_20d : (typeof a.order_cvd_20d === 'number') ? a.order_cvd_20d : -Infinity; valB = (typeof b.cvd_pct_20d === 'number') ? b.cvd_pct_20d : (typeof b.order_cvd_20d === 'number') ? b.order_cvd_20d : -Infinity; }
        else if (key === 'rvol_2d')  { valA = (typeof a.rvol_2d  === 'number') ? a.rvol_2d  : -Infinity; valB = (typeof b.rvol_2d  === 'number') ? b.rvol_2d  : -Infinity; }
        else if (key === 'rvol_5d')  { valA = (typeof a.rvol_5d  === 'number') ? a.rvol_5d  : -Infinity; valB = (typeof b.rvol_5d  === 'number') ? b.rvol_5d  : -Infinity; }
        else if (key === 'rvol_10d') { valA = (typeof a.rvol_10d === 'number') ? a.rvol_10d : -Infinity; valB = (typeof b.rvol_10d === 'number') ? b.rvol_10d : -Infinity; }
        else if (key === 'rvol_20d') { valA = (typeof a.rvol_20d === 'number') ? a.rvol_20d : -Infinity; valB = (typeof b.rvol_20d === 'number') ? b.rvol_20d : -Infinity; }
        else if (key === 'order_net_value') { valA = (typeof a.order_net_value === 'number') ? a.order_net_value : -Infinity; valB = (typeof b.order_net_value === 'number') ? b.order_net_value : -Infinity; }
        else if (key === 'tom2_prob') {
            valA = isNum(a.tom2_prob) ? a.tom2_prob : PROB_MISSING_SORT_VALUE;
            valB = isNum(b.tom2_prob) ? b.tom2_prob : PROB_MISSING_SORT_VALUE;
        }
        else if (key === 'swg5_prob') {
            valA = isNum(a.swg5_prob) ? a.swg5_prob : PROB_MISSING_SORT_VALUE;
            valB = isNum(b.swg5_prob) ? b.swg5_prob : PROB_MISSING_SORT_VALUE;
        }
        else if (key === 'claude_score') {
            valA = (typeof a.claude_score === 'number') ? a.claude_score : -Infinity;
            valB = (typeof b.claude_score === 'number') ? b.claude_score : -Infinity;
        }
        else if (key === 'order_quadrant') {
            const qRank = (q) => q === 'Q1' ? 4 : q === 'Q2' ? 3 : q === 'Q4' ? 2 : q === 'Q3' ? 1 : -1;
            valA = qRank(a.order_quadrant);
            valB = qRank(b.order_quadrant);
        }
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
    pushUrlState();
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
    pushUrlState();
});

// Claude Score button handler
$(document).on('click', '#btn-claude-score', function (e) {
    e.preventDefault();
    e.stopPropagation();
    handleClaudeScoreClick();
});


function mapState(s) {
    if (!s) return 'NEUTRAL';
    const map = {
        'RM': 'READY_MARKUP',
        'TR': 'TRANSITION',
        'AC': 'ACCUMULATION',
        'DI': 'DISTRIBUTION',
        'NE': 'NEUTRAL',
        'OL': 'OFF_THE_LOW',
        'PT': 'POTENTIAL_TOP'
    };
    if (s.length > 2) return s;
    return map[s] || s;
}

// Global badge helper function (used by both screener table and detail view)
function getBadge(val, type, showScore = false) {
    if (typeof val !== 'number' || !Number.isFinite(val)) return `<span class="text-muted">-</span>`;
    const score = showScore ? ` <small class="text-muted">(${val.toFixed(2)})</small>` : '';
    if (type === 'effort') {
        const cls = val > 0 ? 'text-success' : (val < 0 ? 'text-danger' : 'text-secondary');
        return `<span class="${cls}">${val.toFixed(2)}</span>${score}`;
    }
    if (type === 'result') {
        if (val > 1.0) return `<span class="text-danger fw-bold">Volatile</span>${score}`;
        if (val < -0.5) return `<span class="text-muted">Quiet</span>${score}`;
        return `<span class="text-secondary">Normal</span>${score}`;
    }
    if (type === 'ngr') {
        // val is a z-score (-3 to +3). Positive z = above-average net quality.
        if (val > 0.5) return `<span class="text-success fw-bold">Valid</span>${score}`;
        if (val > -0.5) return `<span class="text-secondary">Normal</span>${score}`;
        return `<span class="text-muted">Noise</span>${score}`;
    }
    if (type === 'elasticity') {
        // val is a z-score (-3 to +3). Positive z = above-average price response per unit flow.
        if (val > 1.0) return `<span class="text-success fw-bold">Elastic</span>${score}`;
        if (val > -0.5) return `<span class="text-secondary">Normal</span>${score}`;
        return `<span class="text-danger">Rigid</span>${score}`;
    }
    if (type === 'vwap') {
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
            'OFF_THE_LOW': 'color:#198754;font-weight:bold',
            'READY_MARKUP': 'color:#fd7e14;font-weight:bold',
            'TRANSITION': 'color:#0d6efd',
            'ACCUMULATION': 'color:#198754;font-weight:bold',
            'POTENTIAL_TOP': 'color:#ffc107;font-weight:bold',
            'DISTRIBUTION': 'color:#dc3545;font-weight:bold',
            'NEUTRAL': 'color:#6c757d'
        };
        const labels = {
            'OFF_THE_LOW': 'OTL',
            'READY_MARKUP': 'Ready',
            'TRANSITION': 'Trans',
            'ACCUMULATION': 'Accum',
            'POTENTIAL_TOP': 'PTop',
            'DISTRIBUTION': 'Dist',
            'NEUTRAL': 'Neutral'
        };
        return `<span style="${styles[state] || 'color:#6c757d'}">${labels[state] || state}</span>`;
    };
    
    // Flow Score - simple number with color
    const getFlowScore = (score) => {
        if (score == null || !Number.isFinite(score)) return '<span class="text-muted">-</span>';
        if (score >= 5) return `<span class="text-success fw-bold">${score.toFixed(1)}</span>`;
        if (score >= 3) return `<span class="text-primary fw-bold">${score.toFixed(1)}</span>`;
        if (score >= 1) return `<span style="color:#fd7e14" class="fw-bold">${score.toFixed(1)}</span>`;
        return `<span class="text-muted">${score.toFixed(1)}</span>`;
    };

    // Generic flow value formatter (M/B/T with color)
    const fmtFlowVal = (val) => {
        if (typeof val !== 'number' || !Number.isFinite(val)) return '<span class="text-muted">-</span>';
        const abs = Math.abs(val);
        let formatted;
        if (abs >= 1e12) formatted = (val / 1e12).toFixed(1) + 'T';
        else if (abs >= 1e9) formatted = (val / 1e9).toFixed(1) + 'B';
        else if (abs >= 1e6) formatted = (val / 1e6).toFixed(0) + 'M';
        else if (abs === 0) return '<span class="text-muted">0</span>';
        else formatted = (val / 1e6).toFixed(0) + 'M';
        const color = val > 0 ? 'text-success' : 'text-danger';
        return `<span class="${color} fw-bold">${formatted}</span>`;
    };

    // FFLW: Foreign Flow only (w.fn)
    const fmtFflw = (wData) => {
        if (!wData) return '<span class="text-muted">-</span>';
        const val = wData.fn || 0;
        let ind = '';
        if (wData.foreignAllPos) ind = '<span class="text-success" style="font-size:0.55rem;">●</span> ';
        return ind + fmtFlowVal(val);
    };

    // LFLW: Local Fund Flow only (w.ln)
    const fmtLflw = (wData) => {
        if (!wData) return '<span class="text-muted">-</span>';
        return fmtFlowVal(wData.ln || 0);
    };

    // SMNY: Smart Money = Foreign + Local (w.sm)
    const fmtSmny = (wData) => {
        if (!wData) return '<span class="text-muted">-</span>';
        const val = wData.sm || 0;
        let ind = '';
        if (wData.foreignAllPos && wData.allPos) ind = '<span class="text-success" style="font-size:0.55rem;">●</span> ';
        else if (wData.allPos) ind = '<span class="text-primary" style="font-size:0.55rem;">◐</span> ';
        const streak = wData.streak || 0;
        const streakBadge = streak >= 3 ? `<sup class="text-success" style="font-size:0.55rem;">${streak}🔥</sup>` : '';
        return ind + fmtFlowVal(val) + streakBadge;
    };

    const trunc2 = (x) => Math.trunc(x * 100) / 100;

    const fmtPct = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const vv = trunc2(v);
        const cls = vv > 0 ? 'text-success fw-bold' : (vv < 0 ? 'text-danger fw-bold' : 'text-secondary');
        const sign = vv > 0 ? '+' : '';
        return `<span class="${cls}">${sign}${vv.toFixed(2)}%</span>`;
    };

    const fmtFreq = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        return `<span>${Math.round(v).toLocaleString('id-ID')}</span>`;
    };

    const fmtAbsorb = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const formatted = v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        if (v >= 5) return `<span class="text-success fw-bold">${formatted}</span>`;
        if (v >= 2) return `<span class="fw-bold" style="color:#fd7e14">${formatted}</span>`;
        if (v >= 0.5) return `<span>${formatted}</span>`;
        return `<span class="text-muted">${formatted}</span>`;
    };

    const fmtCvd = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const cls = v >= 0 ? 'text-success' : 'text-danger';
        return `<span class="${cls}">${v.toLocaleString('id-ID')}</span>`;
    };

    const fmtCvdPct = (pct, rawLots) => {
        if (typeof pct !== 'number' || !Number.isFinite(pct)) return '<span class="text-muted">-</span>';
        const cls = pct > 0 ? 'text-success fw-bold' : (pct < 0 ? 'text-danger fw-bold' : 'text-secondary');
        const sign = pct > 0 ? '+' : '';
        const tip = (typeof rawLots === 'number' && Number.isFinite(rawLots))
            ? ` title="Raw CVD: ${rawLots.toLocaleString('id-ID')} lot"` : '';
        return `<span class="${cls}"${tip}>${sign}${pct.toFixed(2)}%</span>`;
    };

    const fmtValue = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const cls = v > 0 ? 'text-success fw-bold' : v < 0 ? 'text-danger fw-bold' : 'fw-bold';
        return `<span class="${cls}">${formatCompactNumber(v)}</span>`;
    };

    const fmtQuadrant = (q) => {
        if (!q) return '<span class="text-muted">-</span>';
        const cls = q === 'Q1' ? 'bg-success text-white'
            : q === 'Q2' ? 'bg-info text-dark'
                : q === 'Q3' ? 'bg-danger text-white'
                    : q === 'Q4' ? 'bg-warning text-dark'
                        : 'bg-secondary text-white';
        return `<span class="badge ${cls}" style="font-size:0.7rem; min-width: 30px;">${q}</span>`;
    };

    const fmtRvol = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const formatted = v.toFixed(2);
        if (v >= 2.0) return `<span class="text-success fw-bold">${formatted}x</span>`;
        if (v >= 1.5) return `<span class="text-success">${formatted}x</span>`;
        if (v >= 0.8) return `<span>${formatted}x</span>`;
        if (v >= 0.5) return `<span class="text-muted">${formatted}x</span>`;
        return `<span class="text-danger">${formatted}x</span>`;
    };

    candidates.forEach((item, idx) => {
        const m = item.metrics;
        const logoUrl = `https://api-saham.mkemalw.workers.dev/logo?symbol=${item.symbol}`;
        const row = `
            <tr data-symbol="${item.symbol}" onclick="window.location.href='?kode=${item.symbol}'" style="cursor:pointer;">
                <td class="text-center text-muted small sticky-col sticky-col-no">${idx + 1}</td>
                <td class="fw-bold sticky-col sticky-col-symbol">
                    <img src="${logoUrl}" alt="" style="height: 20px; width: auto; margin-right: 6px; vertical-align: middle; border-radius: 3px;" onerror="this.style.display='none'">
                    <a href="?kode=${item.symbol}" style="text-decoration:none;">${item.symbol}</a>
                </td>
                <td class="text-center of-growth">${fmtPct(item.order_growth_pct)}</td>
                <td class="text-center of-freq">${fmtFreq(item.order_freq_tx)}</td>
                <td class="text-center tom2-cell d-none">${fmtProbCell(item.tom2)}</td>
                <td class="text-center swg5-cell d-none">${fmtProbCell(item.swg5)}</td>
                <td class="text-center claude-cell ${typeof item.claude_score === 'number' ? 'claude-revealed-instant' : 'claude-locked'}">${fmtClaudeCell(item.claude_score)}</td>
                <td class="text-center of-delta">${fmtPct(item.order_delta_pct)}</td>
                <td class="text-center of-mom">${fmtPct(item.order_mom_pct)}</td>
                <td class="text-center of-absorb">${fmtAbsorb(item.order_absorb)}</td>
                <td class="text-center of-cvd">${fmtCvd(item.order_cvd)}</td>
                <td class="text-center hide-mobile col-h2 col-cvdm of-cvd-2d">${fmtCvdPct(item.cvd_pct_2d, item.order_cvd_2d)}</td>
                <td class="text-center hide-mobile col-h5 col-cvdm of-cvd-5d">${fmtCvdPct(item.cvd_pct_5d, item.order_cvd_5d)}</td>
                <td class="text-center hide-mobile col-h10 col-cvdm of-cvd-10d">${fmtCvdPct(item.cvd_pct_10d, item.order_cvd_10d)}</td>
                <td class="text-center hide-mobile col-h20 col-cvdm of-cvd-20d">${fmtCvdPct(item.cvd_pct_20d, item.order_cvd_20d)}</td>
                <td class="text-center col-h2 col-fflw">${fmtFflw(item.w2)}</td>
                <td class="text-center col-h5 col-fflw">${fmtFflw(item.w5)}</td>
                <td class="text-center hide-mobile col-h10 col-fflw">${fmtFflw(item.w10)}</td>
                <td class="text-center hide-mobile col-h20 col-fflw">${fmtFflw(item.w20)}</td>
                <td class="text-center col-h2 col-lflw">${fmtLflw(item.w2)}</td>
                <td class="text-center col-h5 col-lflw">${fmtLflw(item.w5)}</td>
                <td class="text-center hide-mobile col-h10 col-lflw">${fmtLflw(item.w10)}</td>
                <td class="text-center hide-mobile col-h20 col-lflw">${fmtLflw(item.w20)}</td>
                <td class="text-center col-h2 col-smny">${fmtSmny(item.w2)}</td>
                <td class="text-center col-h5 col-smny">${fmtSmny(item.w5)}</td>
                <td class="text-center hide-mobile col-h10 col-smny">${fmtSmny(item.w10)}</td>
                <td class="text-center hide-mobile col-h20 col-smny">${fmtSmny(item.w20)}</td>
                <td class="text-center hide-mobile col-h2 col-rvol of-rvol-2d">${fmtRvol(item.rvol_2d)}</td>
                <td class="text-center hide-mobile col-h5 col-rvol of-rvol-5d">${fmtRvol(item.rvol_5d)}</td>
                <td class="text-center hide-mobile col-h10 col-rvol of-rvol-10d">${fmtRvol(item.rvol_10d)}</td>
                <td class="text-center hide-mobile col-h20 col-rvol of-rvol-20d">${fmtRvol(item.rvol_20d)}</td>
                <td class="text-center hide-mobile col-h2 col-vwp">${getBadge(m.vwap2, 'vwap')}</td>
                <td class="text-center hide-mobile col-h5 col-vwp">${getBadge(m.vwap5, 'vwap')}</td>
                <td class="text-center hide-mobile col-h10 col-vwp">${getBadge(m.vwap10, 'vwap')}</td>
                <td class="text-center hide-mobile col-h20 col-vwp">${getBadge(m.vwap20, 'vwap')}</td>
                <td class="text-center col-h2 col-flow">${getFlowScore(item.flow2)}</td>
                <td class="text-center col-h5 col-flow">${getFlowScore(item.flow5)}</td>
                <td class="text-center hide-mobile col-h10 col-flow">${getFlowScore(item.flow10)}</td>
                <td class="text-center hide-mobile col-h20 col-flow">${getFlowScore(item.flow20)}</td>
                <td class="text-center col-h2 col-eff">${getBadge(m.effort2, 'effort')}</td>
                <td class="text-center col-h5 col-eff">${getBadge(m.effort5, 'effort')}</td>
                <td class="text-center hide-mobile col-h10 col-eff">${getBadge(m.effort10, 'effort')}</td>
                <td class="text-center hide-mobile col-h20 col-eff">${getBadge(m.effort20, 'effort')}</td>
                <td class="text-center">${getStateText(item.state)}</td>
                <td class="text-center of-value">${fmtValue(item.order_net_value)}</td>
                <td class="text-center of-q">${fmtQuadrant(item.order_quadrant)}</td>
            </tr>
        `;
        tbody.append(row);
    });

    applyColumnVisibility();
    hydrateOrderflowForVisibleRows(candidates);
}

async function fetchOrderflowSnapshotForSymbol(symbol) {
    if (!symbol) return null;
    const key = String(symbol).toUpperCase();
    if (orderflowLiveCache.has(key)) {
        const cached = orderflowLiveCache.get(key);
        const ageMs = Date.now() - (cached?.ts || 0);
        if (ageMs >= 0 && ageMs < ORDERFLOW_CACHE_TTL_MS) {
            return cached?.snapshot ?? null;
        }
    }
    if (orderflowInFlight.has(key)) return null;

    orderflowInFlight.add(key);
    try {
        const today = _getLastTradingDayString();
        const url = `${WORKER_BASE_URL}/cache-summary?symbol=${encodeURIComponent(key)}&from=${today}&to=${today}&cache=default&_ts=${Date.now()}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            orderflowLiveCache.set(key, { snapshot: null, ts: Date.now() });
            return null;
        }
        const data = await resp.json();
        const snapshot = data?.orderflow || null;
        orderflowLiveCache.set(key, { snapshot, ts: Date.now() });
        return snapshot;
    } catch (e) {
        console.warn('[orderflow-hydrate] failed:', key, e);
        orderflowLiveCache.set(key, { snapshot: null, ts: Date.now() });
        return null;
    } finally {
        orderflowInFlight.delete(key);
    }
}

function applyOrderflowSnapshotToCandidate(item, snapshot) {
    if (!item || !snapshot) return;

    // When snapshot is a fallback-day (yesterday's stale data) and market is open,
    // do NOT overwrite intraday fields that may already have today's data from
    // footprint-summary or sector-digest. Still set _orderflowFetchedAt to prevent
    // re-fetching, but preserve fresher intraday values.
    const isStaleFallback = snapshot.is_fallback_day === true && _isMarketLikelyOpen();

    item.orderflow = snapshot;
    item._orderflowFetchedAt = Date.now();
    item._orderflowIsStaleFallback = isStaleFallback;

    if (!isStaleFallback) {
        // Fresh today's data — hydration is authoritative for ALL orderflow fields.
        item.order_open_price = typeof snapshot.open_price === 'number' ? snapshot.open_price : item.order_open_price;
        item.order_recent_price = typeof snapshot.recent_price === 'number'
            ? snapshot.recent_price
            : ((typeof snapshot.price === 'number') ? snapshot.price : item.order_recent_price);
        item.order_growth_pct = typeof snapshot.growth_pct === 'number'
            ? snapshot.growth_pct
            : ((typeof item.order_open_price === 'number' && typeof item.order_recent_price === 'number' && item.order_open_price > 0)
                ? (((item.order_recent_price - item.order_open_price) / item.order_open_price) * 100)
                : item.order_growth_pct);
        const snapshotFreq = (typeof snapshot.freq_tx === 'number' && Number.isFinite(snapshot.freq_tx)) ? snapshot.freq_tx : null;
        const currentFreq = (typeof item.order_freq_tx === 'number' && Number.isFinite(item.order_freq_tx)) ? item.order_freq_tx : null;
        if (snapshotFreq !== null) {
            item.order_freq_tx = currentFreq !== null ? Math.max(currentFreq, snapshotFreq) : snapshotFreq;
        }
        item.order_delta_pct = typeof snapshot.delta_pct === 'number' ? snapshot.delta_pct : item.order_delta_pct;
        item.order_mom_pct = typeof snapshot.mom_pct === 'number' ? snapshot.mom_pct : item.order_mom_pct;
        item.order_absorb = typeof snapshot.absorb === 'number' ? snapshot.absorb : item.order_absorb;
        item.order_cvd = typeof snapshot.cvd === 'number' ? snapshot.cvd : item.order_cvd;
        item.order_net_value = typeof snapshot.net_value === 'number' ? snapshot.net_value : item.order_net_value;
        item.order_quadrant = snapshot.quadrant || item.order_quadrant;
    } else {
        // Stale fallback — do NOT overwrite price/growth with yesterday's values.
        // Only fill price/growth if still null (as seed). 
        // Delta/mom/absorb/cvd: overwrite freely (stale is better than NO_INTRADAY zeros).
        if (item.order_open_price == null && typeof snapshot.open_price === 'number') item.order_open_price = snapshot.open_price;
        if (item.order_recent_price == null) {
            item.order_recent_price = typeof snapshot.recent_price === 'number'
                ? snapshot.recent_price
                : ((typeof snapshot.price === 'number') ? snapshot.price : null);
        }
        if (item.order_growth_pct == null && typeof snapshot.growth_pct === 'number') item.order_growth_pct = snapshot.growth_pct;
        if (item.order_freq_tx == null && typeof snapshot.freq_tx === 'number') item.order_freq_tx = snapshot.freq_tx;
        // Intraday metrics: stale data is more useful than 0 from NO_INTRADAY footprint
        if (typeof snapshot.delta_pct === 'number') item.order_delta_pct = snapshot.delta_pct;
        if (typeof snapshot.mom_pct === 'number') item.order_mom_pct = snapshot.mom_pct;
        if (typeof snapshot.absorb === 'number') item.order_absorb = snapshot.absorb;
        if (typeof snapshot.cvd === 'number') item.order_cvd = snapshot.cvd;
        if (typeof snapshot.net_value === 'number') item.order_net_value = snapshot.net_value;
        if (snapshot.quadrant) item.order_quadrant = snapshot.quadrant;
        console.log(`[orderflow-hydrate] ${item.symbol}: stale fallback (${snapshot.trading_date}) — kept price/growth, applied metrics`);
    }
    scheduleProbRefreshAfterOrderflow();
}

function inferOrderQuadrant(deltaPct, momPct) {
    const d = Number(deltaPct);
    const m = Number(momPct);
    if (!Number.isFinite(d) || !Number.isFinite(m)) return null;
    if (d >= 0 && m >= 0) return 'Q1';
    if (d < 0 && m >= 0) return 'Q2';
    if (d < 0 && m < 0) return 'Q3';
    return 'Q4';
}

function applyFootprintRowToCandidate(item, row, opts = {}) {
    if (!item || !row) return false;

    const numOrNaN = (v) => {
        if (v === null || v === undefined || v === '') return NaN;
        const n = Number(v);
        return Number.isFinite(n) ? n : NaN;
    };

    const d = numOrNaN(row.d);
    const p = numOrNaN(row.p);
    const div = numOrNaN(row.div);
    // B1: prefer net_delta (renamed), fallback to cvd (backward compat alias)
    const net_delta = numOrNaN(row.net_delta ?? row.cvd);
    // B2: prefer notional_val (renamed), fallback to nv (backward compat alias)
    const notional_val = numOrNaN(row.notional_val ?? row.nv);
    const open = numOrNaN(row.open_price ?? row.open);
    const recent = numOrNaN(row.recent_price ?? row.recent);
    const growth = numOrNaN(row.growth_pct);
    const freq = numOrNaN(row.freq_tx);
    // CVD multi-window
    const cvd_2d  = numOrNaN(row.cvd_2d);
    const cvd_5d  = numOrNaN(row.cvd_5d);
    const cvd_10d = numOrNaN(row.cvd_10d);
    const cvd_20d = numOrNaN(row.cvd_20d);

    // During market hours, if per-symbol hydration (/cache-summary) has already
    // populated this item recently with FRESH data, do NOT overwrite core orderflow fields.
    // But if hydration returned stale fallback data, allow footprint to overwrite.
    const perSymbolFresh = (typeof item._orderflowFetchedAt === 'number')
        && item._orderflowFetchedAt > 0
        && (Date.now() - item._orderflowFetchedAt) < ORDERFLOW_CACHE_TTL_MS
        && !item._orderflowIsStaleFallback;
    const skipCoreFields = perSymbolFresh && _isMarketLikelyOpen();

    // When footprint signal is NO_INTRADAY, d/p/div are placeholder zeros.
    // Don't overwrite existing values (from embedded orderflow seed) with meaningless 0.
    const hasIntradayData = row.sig !== 'NO_INTRADAY';

    let touched = false;
    if (!skipCoreFields) {
        if (hasIntradayData && Number.isFinite(d)) { item.order_delta_pct = d; touched = true; }
        if (hasIntradayData && Number.isFinite(p)) { item.order_mom_pct = p; touched = true; }
        if (hasIntradayData && Number.isFinite(div)) { item.order_absorb = div; touched = true; }
        if (hasIntradayData && Number.isFinite(net_delta)) { item.order_cvd = net_delta; touched = true; }
        if (hasIntradayData && Number.isFinite(notional_val)) { item.order_net_value = notional_val; touched = true; }
        if (Number.isFinite(open)) { item.order_open_price = open; touched = true; }
        if (Number.isFinite(recent)) { item.order_recent_price = recent; touched = true; }
        if (Number.isFinite(growth)) { item.order_growth_pct = growth; touched = true; }
        if (opts.applyFreq === true && Number.isFinite(freq)) { item.order_freq_tx = freq; touched = true; }
    }
    // CVD multi-window & RVOL: always apply (footprint-exclusive, no conflict)
    if (Number.isFinite(cvd_2d))  { item.order_cvd_2d  = cvd_2d;  touched = true; }
    if (Number.isFinite(cvd_5d))  { item.order_cvd_5d  = cvd_5d;  touched = true; }
    if (Number.isFinite(cvd_10d)) { item.order_cvd_10d = cvd_10d; touched = true; }
    if (Number.isFinite(cvd_20d)) { item.order_cvd_20d = cvd_20d; touched = true; }
    // CVD% (hybrid: footprint ratio × yfinance volume, normalised)
    const cvdp2  = numOrNaN(row.cvd_pct_2d);
    const cvdp5  = numOrNaN(row.cvd_pct_5d);
    const cvdp10 = numOrNaN(row.cvd_pct_10d);
    const cvdp20 = numOrNaN(row.cvd_pct_20d);
    if (Number.isFinite(cvdp2))  { item.cvd_pct_2d  = cvdp2;  touched = true; }
    if (Number.isFinite(cvdp5))  { item.cvd_pct_5d  = cvdp5;  touched = true; }
    if (Number.isFinite(cvdp10)) { item.cvd_pct_10d = cvdp10; touched = true; }
    if (Number.isFinite(cvdp20)) { item.cvd_pct_20d = cvdp20; touched = true; }
    // RVOL windows
    const rvol_2d  = numOrNaN(row.rvol_2d);
    const rvol_5d  = numOrNaN(row.rvol_5d);
    const rvol_10d = numOrNaN(row.rvol_10d);
    const rvol_20d = numOrNaN(row.rvol_20d);
    if (Number.isFinite(rvol_2d))  { item.rvol_2d  = rvol_2d;  touched = true; }
    if (Number.isFinite(rvol_5d))  { item.rvol_5d  = rvol_5d;  touched = true; }
    if (Number.isFinite(rvol_10d)) { item.rvol_10d = rvol_10d; touched = true; }
    if (Number.isFinite(rvol_20d)) { item.rvol_20d = rvol_20d; touched = true; }
    if (!skipCoreFields) {
        if (!Number.isFinite(growth) && Number.isFinite(item.order_open_price) && Number.isFinite(item.order_recent_price) && item.order_open_price > 0) {
            item.order_growth_pct = ((item.order_recent_price - item.order_open_price) / item.order_open_price) * 100;
            touched = true;
        }

        const q = inferOrderQuadrant(item.order_delta_pct, item.order_mom_pct);
        if (q) {
            item.order_quadrant = q;
            touched = true;
        }
    }

    if (touched) {
        item.orderflow = item.orderflow || {};
        // IMPORTANT: Do NOT stamp _orderflowFetchedAt here.
        // Only per-symbol hydration (/cache-summary) should set this timestamp.
        // Footprint bulk data is a fast prefill; it must never prevent hydration
        // from running by making the item look "fresh".
    }

    return touched;
}

/**
 * Prefill FREQ (from levels_sum) and GROWTH (first vs last snapshot price)
 * for all candidates using sector-scrapper /sector/digest/batch.
 *
 * Strategy:
 *   1. Fetch /sector/digest/batch for all 11 sectors in parallel.
 *   2. Merge all symbol→digest results into sectorDigestCache.
 *   3. Apply freq_tx + growth_pct to every matching candidate.
 *   4. Update DOM cells immediately.
 *
 * Cache TTL = 10 min; subsequent calls within TTL apply from cache only.
 */
async function prefillSectorDigest(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return;

    const now = Date.now();
    if ((now - sectorDigestLoadedAt) <= SECTOR_DIGEST_TTL_MS && sectorDigestCache.size > 0) {
        // Use cached data
        _applySectorDigestsToCandidates(candidates, { updateDom: true });
        return;
    }

    const ALL_SECTORS = [
        'IDXBASIC','IDXENERGY','IDXINDUST','IDXNONCYC','IDXCYCLIC',
        'IDXHEALTH','IDXFINANCE','IDXPROPERT','IDXTECHNO','IDXINFRA','IDXTRANS'
    ];

    // Try today first; if no data yet (pre-market / cron hasn't run), fallback to yesterday.
    const _fetchDate = async (dateStr) => {
        const res = await Promise.allSettled(
            ALL_SECTORS.map(sector =>
                fetch(`${SECTOR_SCRAPPER_BASE_URL}/sector/digest/batch?sector=${sector}&date=${dateStr}`)
                    .then(r => r.ok ? r.json() : null)
                    .catch(() => null)
            )
        );
        let count = 0;
        const map = new Map();
        res.forEach(r => {
            if (r.status !== 'fulfilled' || !r.value?.ok) return;
            for (const [sym, digest] of Object.entries(r.value.digests || {})) {
                map.set(sym.toUpperCase(), digest);
                count++;
            }
        });
        return { count, map };
    };

    // Start with the last trading day (skips weekends) to avoid empty results on Sat/Sun.
    const lastTradingDay = _getLastTradingDayString();
    const today = _getWibDateString();
    const tryDates = [lastTradingDay];
    // If lastTradingDay is the same as today, also try the previous trading day as fallback
    // (covers pre-market hours when cron hasn't run yet).
    if (lastTradingDay === today) {
        const prevMs = Date.now() - 86400000;
        const prevDay = _getWibDateString(new Date(prevMs));
        // Ensure we don't push the same date again
        if (prevDay !== lastTradingDay) tryDates.push(prevDay);
    } else {
        // lastTradingDay is already a fallback (e.g. Friday on a Saturday), but
        // also try the day before in case that sector cron didn't run.
        const prevMs = new Date(`${lastTradingDay}T00:00:00Z`).getTime() - 86400000;
        const prevDay = _getWibDateString(new Date(prevMs));
        if (prevDay !== lastTradingDay) tryDates.push(prevDay);
    }

    let newEntries = 0;
    let digestMap = new Map();
    let usedDate = lastTradingDay;

    for (const dateStr of tryDates) {
        const result = await _fetchDate(dateStr);
        if (result.count > 0) {
            digestMap  = result.map;
            newEntries = result.count;
            usedDate   = dateStr;
            break;
        }
    }

    for (const [sym, digest] of digestMap.entries()) {
        sectorDigestCache.set(sym, digest);
    }
    sectorDigestLoadedAt = now;
    console.log(`[sector-digest] loaded ${newEntries} symbol digests for ${usedDate}${usedDate !== today ? ' (yesterday fallback)' : ''}`);

    _applySectorDigestsToCandidates(candidates, { updateDom: true });
}

function _getWibDateString(d) {
    const now = d || new Date();
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return `${wib.getUTCFullYear()}-${String(wib.getUTCMonth()+1).padStart(2,'0')}-${String(wib.getUTCDate()).padStart(2,'0')}`;
}

/**
 * Returns the most recent trading day date string (YYYY-MM-DD) in WIB.
 * If today is Saturday → returns Friday.
 * If today is Sunday  → returns Friday.
 * Otherwise            → returns today.
 */
// IDX public holidays (weekday-only dates that are market-closed)
const IDX_HOLIDAYS = new Set([
    // 2025
    '2025-01-01','2025-01-27','2025-01-28','2025-03-28','2025-03-31',
    '2025-04-01','2025-04-18','2025-05-01','2025-05-12','2025-05-29',
    '2025-06-01','2025-06-06','2025-06-27','2025-09-05',
    '2025-12-25','2025-12-26',
    // 2026
    '2026-01-01','2026-02-16','2026-02-17','2026-03-11','2026-03-31',
    '2026-04-01','2026-04-02','2026-04-03','2026-04-10','2026-05-01',
    '2026-05-21','2026-06-01','2026-06-08','2026-06-29','2026-08-17',
    '2026-09-08','2026-12-25','2026-12-26'
]);

function _getLastTradingDayString() {
    const now = new Date();
    const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    // Walk back until we find a trading day (not weekend, not holiday)
    for (let i = 0; i < 14; i++) {
        const dayOfWeek = wib.getUTCDay();
        const dateStr = `${wib.getUTCFullYear()}-${String(wib.getUTCMonth()+1).padStart(2,'0')}-${String(wib.getUTCDate()).padStart(2,'0')}`;
        if (dayOfWeek !== 0 && dayOfWeek !== 6 && !IDX_HOLIDAYS.has(dateStr)) {
            return dateStr;
        }
        wib.setUTCDate(wib.getUTCDate() - 1);
    }
    // Fallback: return current date
    return `${wib.getUTCFullYear()}-${String(wib.getUTCMonth()+1).padStart(2,'0')}-${String(wib.getUTCDate()).padStart(2,'0')}`;
}

/**
 * Returns true if IDX market is likely open right now (weekday, 09:00-16:30 WIB, not a holiday).
 * Used to decide whether to force per-symbol live hydration or trust bulk summary data.
 */
function _isMarketLikelyOpen() {
    const now = new Date();
    const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const dayOfWeek = wib.getDay(); // 0=Sun, 6=Sat
    if (dayOfWeek === 0 || dayOfWeek === 6) return false;
    const dateStr = `${wib.getFullYear()}-${String(wib.getMonth()+1).padStart(2,'0')}-${String(wib.getDate()).padStart(2,'0')}`;
    if (IDX_HOLIDAYS.has(dateStr)) return false;
    const hour = wib.getHours();
    const min = wib.getMinutes();
    const timeMinutes = hour * 60 + min;
    // IDX trading hours: 09:00 - 16:30 WIB (with some buffer: 08:55 - 16:35)
    return timeMinutes >= 535 && timeMinutes <= 995;
}

/**
 * Apply cached sector digests to candidates array.
 * Overwrites order_freq_tx and order_growth_pct (sector data is authoritative).
 */
function _applySectorDigestsToCandidates(candidates, opts = {}) {
    if (!sectorDigestCache.size) return 0;
    const applyTs = Date.now();
    let changed = 0;
    for (const item of candidates) {
        const sym = String(item?.symbol || '').toUpperCase();
        if (!sym) continue;
        const digest = sectorDigestCache.get(sym);
        if (!digest) continue;

        // Hydration (/cache-summary) is the authoritative source.
        // If hydration has already populated this item with FRESH data, do NOT overwrite.
        // But if hydration returned stale fallback data, allow sector-digest to overwrite.
        const hydratedRecently = (typeof item._orderflowFetchedAt === 'number')
            && item._orderflowFetchedAt > 0
            && (Date.now() - item._orderflowFetchedAt) < ORDERFLOW_CACHE_TTL_MS
            && !item._orderflowIsStaleFallback;

        if (!hydratedRecently) {
            // FREQ: levels_sum is the most accurate source when no hydration
            if (typeof digest.freq_tx === 'number' && Number.isFinite(digest.freq_tx)) {
                item.order_freq_tx = digest.freq_tx;
            }
            // GROWTH: sector-digest as seed before hydration
            if (typeof digest.growth_pct === 'number' && Number.isFinite(digest.growth_pct)) {
                item.order_growth_pct = digest.growth_pct;
            }
            // Propagate open/last prices for downstream TOM2 calculations
            if (typeof digest.price_open === 'number' && digest.price_open > 0) {
                item.order_open_price = digest.price_open;
            }
            if (typeof digest.price_last === 'number' && digest.price_last > 0) {
                item.order_recent_price = digest.price_last;
            }
        }

        item._sectorDigestFetchedAt = applyTs;
        changed++;
        if (opts.updateDom) updateOrderflowCells(sym, item);
    }
    if (changed > 0) scheduleProbRefreshAfterOrderflow();
    return changed;
}

async function prefillIntradayFromFootprintSummary(candidates, options = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return;

    try {
        const resp = await fetch(`${WORKER_BASE_URL}/footprint/summary?_ts=${Date.now()}`);
        if (!resp.ok) return;
        const payload = await resp.json();
        const items = Array.isArray(payload?.items) ? payload.items : [];
        if (!items.length) return;

        const map = new Map(items.map(it => [String(it?.t || '').toUpperCase(), it]));
        let changed = 0;
        for (const item of candidates) {
            const symbol = String(item?.symbol || '').toUpperCase();
            if (!symbol) continue;
            const row = map.get(symbol);
            if (!row) continue;
            if (applyFootprintRowToCandidate(item, row, { applyFreq: true })) {
                changed += 1;
                if (options.updateDom) updateOrderflowCells(symbol, item);
            }
        }

        if (changed > 0) {
            scheduleProbRefreshAfterOrderflow();
        }
    } catch (e) {
        console.warn('[orderflow-prefill] failed:', e);
    }
}

function updateOrderflowCells(symbol, item) {
    const $row = $(`#tbody-index tr[data-symbol="${symbol}"]`);
    if (!$row.length) return;

    const trunc2 = (x) => Math.trunc(x * 100) / 100;

    const pct = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const vv = trunc2(v);
        const cls = vv > 0 ? 'text-success fw-bold' : (vv < 0 ? 'text-danger fw-bold' : 'text-secondary');
        const sign = vv > 0 ? '+' : '';
        return `<span class="${cls}">${sign}${vv.toFixed(2)}%</span>`;
    };
    const absorb = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const formatted = v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        if (v >= 5) return `<span class="text-success fw-bold">${formatted}</span>`;
        if (v >= 2) return `<span class="fw-bold" style="color:#fd7e14">${formatted}</span>`;
        if (v >= 0.5) return `<span>${formatted}</span>`;
        return `<span class="text-muted">${formatted}</span>`;
    };
    const growth = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const vv = trunc2(v);
        const cls = vv > 0 ? 'text-success fw-bold' : (vv < 0 ? 'text-danger fw-bold' : 'text-secondary');
        const sign = vv > 0 ? '+' : '';
        return `<span class="${cls}">${sign}${vv.toFixed(2)}%</span>`;
    };
    const freq = (v) => (typeof v === 'number' && Number.isFinite(v))
        ? `<span>${Math.round(v).toLocaleString('id-ID')}</span>`
        : '<span class="text-muted">-</span>';
    const cvd = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const cls = v >= 0 ? 'text-success' : 'text-danger';
        return `<span class="${cls}">${v.toLocaleString('id-ID')}</span>`;
    };
    const value = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const cls = v > 0 ? 'text-success fw-bold' : v < 0 ? 'text-danger fw-bold' : 'fw-bold';
        return `<span class="${cls}">${formatCompactNumber(v)}</span>`;
    };
    const quadrant = (q) => {
        if (!q) return '<span class="text-muted">-</span>';
        const cls = q === 'Q1' ? 'bg-success text-white'
            : q === 'Q2' ? 'bg-info text-dark'
                : q === 'Q3' ? 'bg-danger text-white'
                    : q === 'Q4' ? 'bg-warning text-dark'
                        : 'bg-secondary text-white';
        return `<span class="badge ${cls}" style="font-size:0.7rem; min-width: 30px;">${q}</span>`;
    };

    $row.find('.of-growth').html(growth(item.order_growth_pct));
    $row.find('.of-freq').html(freq(item.order_freq_tx));
    $row.find('.of-delta').html(pct(item.order_delta_pct));
    $row.find('.of-mom').html(pct(item.order_mom_pct));
    $row.find('.of-absorb').html(absorb(item.order_absorb));
    $row.find('.of-cvd').html(cvd(item.order_cvd));
    const cvdPctCell = (pctVal, rawVal) => {
        if (typeof pctVal !== 'number' || !Number.isFinite(pctVal)) return cvd(rawVal);
        const cls = pctVal > 0 ? 'text-success fw-bold' : (pctVal < 0 ? 'text-danger fw-bold' : 'text-secondary');
        const sign = pctVal > 0 ? '+' : '';
        const tip = (typeof rawVal === 'number' && Number.isFinite(rawVal))
            ? ` title="Raw CVD: ${rawVal.toLocaleString('id-ID')} lot"` : '';
        return `<span class="${cls}"${tip}>${sign}${pctVal.toFixed(2)}%</span>`;
    };
    $row.find('.of-cvd-2d').html(cvdPctCell(item.cvd_pct_2d, item.order_cvd_2d));
    $row.find('.of-cvd-5d').html(cvdPctCell(item.cvd_pct_5d, item.order_cvd_5d));
    $row.find('.of-cvd-10d').html(cvdPctCell(item.cvd_pct_10d, item.order_cvd_10d));
    $row.find('.of-cvd-20d').html(cvdPctCell(item.cvd_pct_20d, item.order_cvd_20d));
    // RVOL
    const rvol = (v) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return '<span class="text-muted">-</span>';
        const formatted = v.toFixed(2);
        if (v >= 2.0) return `<span class="text-success fw-bold">${formatted}x</span>`;
        if (v >= 1.5) return `<span class="text-success">${formatted}x</span>`;
        if (v >= 0.8) return `<span>${formatted}x</span>`;
        if (v >= 0.5) return `<span class="text-muted">${formatted}x</span>`;
        return `<span class="text-danger">${formatted}x</span>`;
    };
    $row.find('.of-rvol-2d').html(rvol(item.rvol_2d));
    $row.find('.of-rvol-5d').html(rvol(item.rvol_5d));
    $row.find('.of-rvol-10d').html(rvol(item.rvol_10d));
    $row.find('.of-rvol-20d').html(rvol(item.rvol_20d));
    $row.find('.of-value').html(value(item.order_net_value));
    $row.find('.of-q').html(quadrant(item.order_quadrant));
    updateProbCells(symbol, item);
}

async function hydrateOrderflowForVisibleRows(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return;

    const now = Date.now();
    const targets = candidates.filter(c => {
        if (!c || !c.symbol) return false;
        if (c.orderflow == null) return true;
        const fetchedAt = Number(c._orderflowFetchedAt || 0);
        return !fetchedAt || (now - fetchedAt) > ORDERFLOW_CACHE_TTL_MS;
    });
    if (!targets.length) return;

    const concurrency = 6;
    let cursor = 0;

    const worker = async () => {
        while (cursor < targets.length) {
            const i = cursor++;
            const item = targets[i];
            const symbol = String(item.symbol || '').toUpperCase();
            if (!symbol) continue;

            const snapshot = await fetchOrderflowSnapshotForSymbol(symbol);
            if (!snapshot) continue;

            applyOrderflowSnapshotToCandidate(item, snapshot);
            updateOrderflowCells(symbol, item);
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
}

function applyColumnVisibility() {
    // Horizon columns
    ['2', '5', '10', '20'].forEach(h => {
        $(`.col-h${h}`).toggleClass('d-none', visibleHorizonCols[h] === false);
    });
    // Column group visibility (additive hide on top of horizon)
    Object.entries(columnGroupVisibility).forEach(([g, vis]) => {
        if (!vis) $(`.col-${g}`).addClass('d-none');
    });
}

function saveViewToLocalStorage() {
    try {
        localStorage.setItem('screener_view', JSON.stringify({
            h: { ...visibleHorizonCols }, g: { ...columnGroupVisibility }
        }));
    } catch (e) { /* quota */ }
}

$(document).on('change', '[data-view-horizon]', function() {
    const h = String($(this).data('view-horizon'));
    visibleHorizonCols[h] = $(this).is(':checked');
    applyColumnVisibility();
    updateViewButtonLabel();
    saveViewToLocalStorage();
    pushUrlState();
});

$(document).on('change', '[data-view-group]', function() {
    const g = String($(this).data('view-group'));
    columnGroupVisibility[g] = $(this).is(':checked');
    applyColumnVisibility();
    updateViewButtonLabel();
    saveViewToLocalStorage();
    pushUrlState();
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
                $('#feat-effort').html(getBadge(z.e ?? null, 'effort'));
                $('#feat-response').html(getBadge(z.r ?? null, 'result'));
                $('#feat-quality').html(getBadge(z.n ?? null, 'ngr'));
                $('#feat-vwap').html(getBadge(z.v ?? null, 'vwap'));
                $('#feat-elasticity').html(getBadge(z.el ?? null, 'elasticity'));
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
    
    // VWAP deviation: compare latest price to volume-weighted average
    const prices = days.map(d => d.data?.price || 0).filter(p => p > 0);
    const avgPrice = prices.length > 0 ? prices.reduce((s, p) => s + p, 0) / prices.length : 0;
    const vwapDev = avgPrice > 0 && lastPrice > 0 ? ((lastPrice - avgPrice) / avgPrice) : 0;

    return {
        effort: normalize(avgValue, 5000000000), // 5B as reference
        response: normalize(priceChange, 10), // 10% as max
        quality: normalize(avgFlow, maxFlow),
        vwap: normalize(vwapDev * 100, 5), // scale % deviation to z-score-like range
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
        'TRANSITION': 'text-primary fw-bold',
        'POTENTIAL_TOP': 'text-warning fw-bold',
        'DISTRIBUTION': 'text-danger fw-bold',
        'NEUTRAL': 'text-muted'
    };
    const labels = {
        'OFF_THE_LOW': 'OFF THE LOW',
        'ACCUMULATION': 'ACCUMULATION',
        'READY_MARKUP': 'READY MARKUP',
        'TRANSITION': 'TRANSITION',
        'POTENTIAL_TOP': 'POTENTIAL TOP',
        'DISTRIBUTION': 'DISTRIBUTION',
        'NEUTRAL': 'NEUTRAL'
    };
    const label = labels[state] || (state ? state.replaceAll('_', ' ') : '-');
    return `<span class="${colors[state] || 'text-muted'}">${label}</span>`;
}

// =========================================
// DETAIL MODE
// =========================================
async function initDetailMode(symbol) {
    $('#index-view').hide();
    $('#detail-view').show();

    // Reset broker flow state for fresh detail view
    resetBrokerFlowState();

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
    if (!startParam) startDate.setDate(endDate.getDate() - 20); // Default 20 days

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
        // B. Empty data with no active backfill → IPO / new ticker (show static message, no retry)
        // C. Backfill active → show spinner + retry loop
        const isBackfillActive = result.backfill_active === true;
        const isEmptyData = !result.history || result.history.length === 0;
        const hasMinimalData = isEmptyData || completeness < 0.7;

        console.log(`[DATA COMPLETENESS] Expected: ${expectedDays}, Actual: ${actualDays}, Completeness: ${(completeness * 100).toFixed(1)}%`);
        console.log(`[BACKFILL CHECK] isEmptyData: ${isEmptyData}, hasMinimalData: ${hasMinimalData}, isBackfillActive: ${isBackfillActive}`);

        // CASE: Empty data + backfill NOT active → IPO or new ticker with no history yet
        if (isEmptyData && !isBackfillActive) {
            console.log(`[NO DATA] ${symbol} has no history and backfill is not active. Treating as IPO/new ticker.`);
            $('#loading-indicator').hide();
            $('#app').fadeIn();
            $('.chart-container-responsive').hide();
            $('#broker-table-container').html(`
                <div class="alert alert-secondary text-center py-4">
                    <i class="fa-solid fa-circle-info fa-2x mb-2 text-secondary"></i>
                    <div class="fw-bold mt-1">Belum Ada Data Broker</div>
                    <div class="small text-muted mt-2">
                        Data broker summary untuk <strong>${symbol}</strong> belum tersedia.<br>
                        Emiten ini kemungkinan baru IPO atau belum pernah diperdagangkan.
                    </div>
                </div>
            `);
            return;
        }

        // CASE: Backfill is actively running → show spinner + retry loop
        if (isBackfillActive) {
            // STALE BACKFILL: backend says active but zero progress after N retries →
            // treat as IPO/no-data to prevent infinite loop
            const MAX_EMPTY_RETRIES = 6; // ~30 seconds with no progress
            if (isEmptyData && retryCount >= MAX_EMPTY_RETRIES) {
                console.warn(`[BACKFILL] Stale backfill detected for ${symbol} after ${retryCount} retries with 0 days. Treating as no-data.`);
                $('#loading-indicator').hide();
                $('#app').fadeIn();
                $('.chart-container-responsive').hide();
                $('#broker-table-container').html(`
                    <div class="alert text-center py-4">
                        <i class="fa-solid fa-circle-info fa-2x mb-2 text-secondary"></i>
                        <div class="fw-bold mt-1">Belum Ada Data Broker</div>
                        <div class="small text-muted mt-2">
                            Data broker summary untuk <strong>${symbol}</strong> belum tersedia.<br>
                            Emiten ini kemungkinan baru IPO atau data sedang dalam antrian proses.
                        </div>
                        <button class="btn btn-sm btn-outline-secondary mt-3" onclick="location.reload()">
                            <i class="fa-solid fa-rotate-right me-1"></i> Coba Lagi Nanti
                        </button>
                    </div>
                `);
                return;
            }

            // CHECK RETRY LIMIT (for partial data that never completes)
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

        // If we reach here: data exists and backfill is not active → render normally (even if partial).
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
                datalabels: { display: false },
                tooltip: { enabled: false }
            },
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#9ca3af' },
                    border: { color: 'transparent' }
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
                    border: { color: 'transparent' }
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
                    ctx.setLineDash([2, 3]); // Dotted line
                    ctx.strokeStyle = '#9ca3af'; // Grey for visibility on white bg
                    ctx.lineWidth = 1.5;
                    ctx.moveTo(xScale.left, yPos);
                    ctx.lineTo(xScale.right, yPos);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }, {
            // Draw value labels on cumulative line data points (Foreign, Retail, Local)
            id: 'smartMoneyNodeLabels',
            afterDatasetsDraw: (chart) => {
                const ctx = chart.ctx;
                const numPoints = chart.data.labels.length;

                // Only label cumulative line datasets (0=Price, 1=Foreign, 2=Retail, 3=Local)
                [0, 1, 2, 3].forEach(dsIdx => {
                    const ds = chart.data.datasets[dsIdx];
                    if (!ds || ds.hidden) return;
                    const meta = chart.getDatasetMeta(dsIdx);
                    if (!meta.visible) return;

                    for (let p = 0; p < numPoints; p++) {
                        const pt = meta.data[p];
                        if (!pt) continue;
                        const val = ds.data[p];
                        if (val === null || val === undefined) continue;

                        ctx.save();
                        ctx.font = '8px sans-serif';
                        ctx.fillStyle = ds.borderColor;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.fillText(formatCompactNumber(val), pt.x, pt.y - 5);
                        ctx.restore();
                    }
                });
            }
        }]
    });
}

// =========================================
// BROKER FLOW CHART (Per-Broker Cumulative)
// =========================================
let brokerFlowChart = null;
let brokerFlowData = null; // Cached response from /cache-summary/broker-daily
let brokerFlowInitialized = false;
let currentTopN = 9;

// Color shades per category — matched to SmartMoney Flow chart
// Foreign = green, Local = blue, Retail = red
const BROKER_COLORS = {
    foreign: ['#16a34a', '#22c55e', '#4ade80', '#86efac'],
    local:   ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd'],
    retail:  ['#dc2626', '#ef4444', '#f87171', '#fca5a5']
};

// Sub-tab toggle handler
$(document).on('click', '#chart-subtab-group .btn', function () {
    const tab = $(this).data('chart-tab');
    $('#chart-subtab-group .btn').removeClass('active');
    $(this).addClass('active');

    if (tab === 'smartmoney') {
        $('#smartmoney-chart-panel').show();
        $('#broker-flow-chart-panel').hide();
        $('#broker-topn-group').css('display', 'none').addClass('d-none');
    } else if (tab === 'brokerflow') {
        $('#smartmoney-chart-panel').hide();
        $('#broker-flow-chart-panel').show();
        $('#broker-topn-group').css('display', '').removeClass('d-none').addClass('d-flex');
        // Lazy-init: fetch & render on first click
        if (!brokerFlowInitialized && kodeParam) {
            const fromDate = $('#date-from').val();
            const toDate = $('#date-to').val();
            fetchAndRenderBrokerFlow(kodeParam, fromDate, toDate);
        }
    }
});

// Top N toggle handler
$(document).on('click', '#broker-topn-group .broker-topn-link', function (e) {
    e.preventDefault();
    const n = parseInt($(this).data('topn'), 10);
    if (!n || n === currentTopN) return;
    currentTopN = n;
    $('#broker-topn-group .broker-topn-link').removeClass('active');
    $(this).addClass('active');
    if (brokerFlowData) {
        applyBrokerTopNFilter(n);
    }
});

async function fetchAndRenderBrokerFlow(symbol, from, to) {
    const panel = $('#broker-flow-chart-panel');
    const canvas = document.getElementById('brokerFlowChart');
    if (!canvas) return;

    // Show loading state
    $('#broker-flow-legend').html('<span class="text-muted small">Memuat data broker flow...</span>');

    try {
        const url = `${WORKER_BASE_URL}/cache-summary/broker-daily?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (!data || !data.brokers || !data.brokers.length || !data.dates || !data.dates.length) {
            $('#broker-flow-legend').html('<span class="text-muted small">Belum ada data broker flow untuk range ini.</span>');
            brokerFlowInitialized = true;
            return;
        }

        brokerFlowData = data;
        brokerFlowInitialized = true;
        renderBrokerFlowChart(data);
    } catch (e) {
        console.error('[BrokerFlow] Fetch failed:', e);
        $('#broker-flow-legend').html('<span class="text-danger small">Gagal memuat data broker flow.</span>');
    }
}

function renderBrokerFlowChart(data) {
    const ctx = document.getElementById('brokerFlowChart').getContext('2d');
    if (brokerFlowChart) brokerFlowChart.destroy();

    const { brokers, dates, series } = data;

    // Labels (DD/MM)
    const labels = dates.map(dateStr => {
        const d = new Date(dateStr);
        return `${d.getDate()}/${d.getMonth() + 1}`;
    });

    // ── Rank ALL brokers by absolute total net (across categories) ──
    const ranked = brokers.map(broker => {
        const dailyNets = series[broker.code] || [];
        const totalNet = dailyNets.reduce((s, v) => s + v, 0);
        return { ...broker, totalAbsNet: Math.abs(totalNet), totalNet };
    }).sort((a, b) => b.totalAbsNet - a.totalAbsNet);

    // Build cumulative datasets
    const datasets = [];
    // Track color index per category so shades don't collide
    const catColorIdx = { foreign: 0, local: 0, retail: 0 };

    ranked.forEach((broker, globalRank) => {
        const cat = broker.type; // 'foreign' | 'local' | 'retail'
        const colorIdx = catColorIdx[cat] || 0;
        catColorIdx[cat] = colorIdx + 1;

        const colorPalette = BROKER_COLORS[cat] || BROKER_COLORS.local;
        const color = colorPalette[Math.min(colorIdx, colorPalette.length - 1)];

        const dailyNets = series[broker.code] || [];
        const cumData = [];
        let acc = 0;
        for (let i = 0; i < dates.length; i++) {
            acc += (dailyNets[i] || 0);
            cumData.push(acc);
        }

        datasets.push({
            label: `${broker.code} - ${broker.name.split(' ')[0]}`,
            data: cumData,
            borderColor: color,
            backgroundColor: color,
            borderWidth: globalRank < 3 ? 2.5 : (globalRank < 6 ? 2 : 1.5),
            pointRadius: 3,
            pointBackgroundColor: color,
            pointBorderColor: color,
            pointBorderWidth: 0,
            tension: 0.15,
            yAxisID: 'y',
            _brokerCode: broker.code,
            _brokerType: cat,
            _globalRank: globalRank, // 0-based absolute rank
            hidden: globalRank >= currentTopN
        });
    });

    brokerFlowChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { right: 60 } },
            plugins: {
                legend: { display: false },
                datalabels: { display: false },
                tooltip: { enabled: false }
            },
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#9ca3af' },
                    border: { color: 'transparent' }
                },
                y: {
                    type: 'linear',
                    display: false, // Hide Y axis — values shown on node labels
                    position: 'left',
                    grid: { display: false },
                    border: { display: false }
                }
            }
        },
        plugins: [{
            // Dashed zero line
            id: 'zeroLineBroker',
            afterDatasetsDraw: (chart) => {
                const ctx2 = chart.ctx;
                const yScale = chart.scales.y;
                const xScale = chart.scales.x;
                const yPos = yScale.getPixelForValue(0);
                if (yPos >= yScale.top && yPos <= yScale.bottom) {
                    ctx2.save();
                    ctx2.beginPath();
                    ctx2.setLineDash([2, 3]);
                    ctx2.strokeStyle = '#9ca3af';
                    ctx2.lineWidth = 1;
                    ctx2.moveTo(xScale.left, yPos);
                    ctx2.lineTo(xScale.right, yPos);
                    ctx2.stroke();
                    ctx2.restore();
                }
            }
        }, {
            // Draw "CODE value" label on every data point
            id: 'brokerNodeLabels',
            afterDatasetsDraw: (chart) => {
                const ctx2 = chart.ctx;
                const datasets = chart.data.datasets;
                const numPoints = chart.data.labels.length;

                datasets.forEach((ds, i) => {
                    if (ds.hidden) return;
                    const meta = chart.getDatasetMeta(i);
                    if (!meta.visible) return;

                    for (let p = 0; p < numPoints; p++) {
                        const pt = meta.data[p];
                        if (!pt) continue;

                        const x = pt.x;
                        const y = pt.y;
                        const val = ds.data[p] || 0;
                        const code = ds._brokerCode || '';

                        // Always show "CODE value" on every node
                        const text = `${code} ${formatCompactNumber(val)}`;

                        ctx2.save();
                        ctx2.font = p === numPoints - 1 ? 'bold 9px sans-serif' : '8px sans-serif';
                        ctx2.fillStyle = ds.borderColor;
                        ctx2.textAlign = p === numPoints - 1 ? 'left' : 'center';
                        ctx2.textBaseline = 'bottom';
                        ctx2.fillText(text, p === numPoints - 1 ? x + 8 : x, y - 6);
                        ctx2.restore();
                    }
                });
            }
        }]
    });

    // Render legend — use ranked order
    renderBrokerFlowLegend(ranked);
}

function renderBrokerFlowLegend(rankedBrokers) {
    const container = $('#broker-flow-legend');
    const catColorIdx = { foreign: 0, local: 0, retail: 0 };
    const catLabel = { foreign: 'F', local: 'L', retail: 'R' };
    let html = '';

    rankedBrokers.forEach(b => {
        const cat = b.type;
        const idx = catColorIdx[cat] || 0;
        catColorIdx[cat] = idx + 1;
        const colorPalette = BROKER_COLORS[cat] || BROKER_COLORS.local;
        const color = colorPalette[Math.min(idx, colorPalette.length - 1)];
        const shortName = b.name.split(' ')[0];
        html += `<span class="broker-legend-item"><span class="broker-dot" style="background:${color}"></span>${b.code} - ${shortName} <span class="text-muted">(${catLabel[cat]})</span></span>`;
    });

    container.html(html);
}

function applyBrokerTopNFilter(topN) {
    if (!brokerFlowChart) return;
    brokerFlowChart.data.datasets.forEach(ds => {
        ds.hidden = (ds._globalRank ?? 0) >= topN;
    });
    brokerFlowChart.update();
}

// Reset broker flow state when detail view changes
function resetBrokerFlowState() {
    brokerFlowInitialized = false;
    brokerFlowData = null;
    currentTopN = 9;
    if (brokerFlowChart) {
        brokerFlowChart.destroy();
        brokerFlowChart = null;
    }
    $('#broker-flow-legend').empty();
    // Reset sub-tab to SmartMoney
    $('#chart-subtab-group .btn').removeClass('active');
    $('#chart-subtab-group .btn[data-chart-tab="smartmoney"]').addClass('active');
    $('#smartmoney-chart-panel').show();
    $('#broker-flow-chart-panel').hide();
    // Hide & reset Top N
    currentTopN = 9;
    $('#broker-topn-group').css('display', 'none').removeClass('d-flex').addClass('d-none');
    $('#broker-topn-group .broker-topn-link').removeClass('active');
    $('#broker-topn-group .broker-topn-link[data-topn="9"]').addClass('active');
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
    const analysisContent = document.getElementById('ai-analysis-content');
    const tokenInfo = document.getElementById('ai-token-info');
    const refreshBtn = document.getElementById('btn-ai-refresh');

    // Set title
    document.getElementById('ai-modal-symbol').textContent = symbol;

    // Reset UI
    btn.classList.add('analyzing');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Capturing...';
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
        // ── Step 1: Capture screenshots from DOM ──
        console.log('[AI] Step 1: Capturing screenshots...');
        const summaryPane = document.getElementById('summary-pane');

        // Determine label based on current date range
        const fromDate = $('#date-from').val();
        const toDate = $('#date-to').val();
        const daysDiff = Math.round((new Date(toDate) - new Date(fromDate)) / (1000*60*60*24));
        const rangeLabel = `brokerflow-${daysDiff}d`;

        // Capture both brokerflow (range chart) and intraday (current full pane) from DOM
        // intraday = same element, just labelled differently so Claude gets both contexts
        const [brokerflowBlob, intradayBlob] = await Promise.all([
            captureElement(summaryPane),
            captureElement(summaryPane)
        ]);
        console.log(`[AI] Captured brokerflow: ${(brokerflowBlob.size/1024).toFixed(0)}KB, intraday: ${(intradayBlob.size/1024).toFixed(0)}KB`);

        // ── Step 2: Upload screenshots ──
        analysisContent.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-warning" role="status"></div>
                <p class="small text-muted mt-2">Mengunggah screenshot...</p>
            </div>
        `;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Uploading...';

        const [uploaded, uploadedIntraday] = await Promise.all([
            uploadScreenshot(brokerflowBlob, symbol, rangeLabel),
            uploadScreenshot(intradayBlob, symbol, 'intraday')
        ]);
        console.log(`[AI] Uploaded: ${uploaded.key} (${uploaded.size_kb}KB), ${uploadedIntraday.key} (${uploadedIntraday.size_kb}KB)`);

        // ── Step 3: Call AI analysis ──
        analysisContent.innerHTML = `
            <div class="text-center py-4">
                <div class="spinner-border text-warning" role="status"></div>
                <p class="small text-muted mt-2">AI sedang menganalisis...<br>Bisa memakan waktu 15-30 detik.</p>
            </div>
        `;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin me-1"></i> Analyzing...';

        // Check ?ai=rebuild in URL to force cache rebuild
        const aiRebuild = new URLSearchParams(window.location.search).get('ai') === 'rebuild';
        const forceAI = forceRefresh || aiRebuild;

        const response = await fetch(`${WORKER_BASE_URL}/ai/analyze-broksum`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol,
                image_keys: [
                    { key: uploaded.key, label: uploaded.label },
                    { key: uploadedIntraday.key, label: uploadedIntraday.label }
                ],
                from: fromDate,
                to: toDate,
                force: forceAI
            })
        });

        const result = await response.json();

        if (!result.ok) {
            const errorMessage = result.error || 'AI analysis failed';
            const providerErrors = [result.openai, result.grok, result.claude].filter(Boolean);
            const providerDetail = providerErrors.length
                ? `<div class="small text-muted mt-1">${providerErrors.map(e => escapeHTML(e)).join(' → ')}</div>`
                : '';
            const parseHint = result.parse_error ? `<div class="small text-muted mt-1">${escapeHTML(result.parse_error)}</div>` : '';
            const rawOutput = result.raw_output ? `<details class="mt-3"><summary class="small text-muted">Output mentah</summary><pre class="small p-3 rounded">${escapeHTML(result.raw_output)}</pre></details>` : '';
            analysisContent.innerHTML = `
                <div class="alert alert-danger">
                    <i class="fa-solid fa-circle-exclamation me-1"></i>
                    <strong>Gagal menganalisis:</strong> ${escapeHTML(errorMessage)}
                    ${providerDetail}
                    ${parseHint}
                </div>
                ${rawOutput}
            `;
            tokenInfo.textContent = '';
            refreshBtn.style.display = '';
            return;
        }

console.log(`[AI] Analysis complete. Tokens: ${result.usage?.total_tokens || 'N/A'}, Cached: ${result.cached || false}, Provider: ${result.provider || 'OpenAI'}`);

        // Update UI with provider
        const aiProviderBadge = document.getElementById('aiProvider');
        if (aiProviderBadge) {
            aiProviderBadge.textContent = result.provider === 'grok' ? 'Grok (fallback)' : 'ChatGPT';
            aiProviderBadge.classList.toggle('bg-warning', result.provider === 'grok');
        }

        let analysisData = result.analysis;
        if (analysisData && typeof analysisData === 'string') {
            try {
                analysisData = JSON.parse(analysisData);
            } catch (_) {
                analysisData = null;
            }
        }

        console.log('[AI] analysisData keys:', analysisData ? Object.keys(analysisData) : 'null');
        console.log('[AI] analysisData sample:', JSON.stringify(analysisData).slice(0, 400));

        if (analysisData && typeof analysisData === 'object') {
            analysisContent.innerHTML = renderAnalysisJSON(analysisData, result.screenshots);
        } else {
            const rawOutput = result.analysis_raw || '';
            analysisContent.innerHTML = `
                <div class="alert alert-warning">
                    <i class="fa-solid fa-triangle-exclamation me-1"></i>
                    <strong>Analisis belum tersedia.</strong> Model tidak mengembalikan JSON valid.
                </div>
                ${rawOutput ? `<details class="mt-3"><summary class="small text-muted">Output mentah</summary><pre class="small p-3 rounded">${escapeHTML(rawOutput)}</pre></details>` : ''}
            `;
        }

        if (result.usage) {
            const cachedTag = result.cached ? '' : '';
            // Cari confidence dari recommendation (EN atau ID) atau meta
            const _recData = analysisData?.recommendation || analysisData?.kesimpulan_rekomendasi || {};
            const rawC = _recData.confidence ?? _recData.tingkat_keyakinan ?? analysisData?.meta?.confidence ?? null;
            let confStr = '';
            if (rawC != null) {
                if (typeof rawC === 'number' && !isNaN(rawC) && rawC > 0) {
                    confStr = ` | Confidence: ${(rawC > 1 ? rawC : rawC * 100).toFixed(0)}%`;
                } else if (typeof rawC === 'string') {
                    const pct = parseFloat(rawC.replace('%', ''));
                    confStr = !isNaN(pct) && pct > 0
                        ? ` | Confidence: ${(pct > 1 ? pct : pct * 100).toFixed(0)}%`
                        : rawC ? ` | Confidence: ${rawC}` : '';
                }
            }
            tokenInfo.textContent = `Model: ${result.model} | Tokens: ${result.usage.total_tokens?.toLocaleString() || 'N/A'}${cachedTag}${confStr}`;
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
            <div class="text-uppercase text-muted fw-semibold mb-2">${escapeHTML(title)}</div>
            <ul class="mb-2 ps-3">${listMarkup}</ul>
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
    // Fallback: _summaryText injected from Indonesian field
    if (!items.length && section._summaryText) items.push(section._summaryText);
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
    const buyers  = Array.isArray(section.top_net_buyers)  ? section.top_net_buyers.slice(0, 5)  : [];
    const sellers = Array.isArray(section.top_net_sellers) ? section.top_net_sellers.slice(0, 5) : [];

    // Normalize item: supports both object {code,type,value,comment} and plain string "CODE: desc"
    const normalizeItem = (item) => {
        if (typeof item === 'string') {
            const colonIdx = item.indexOf(':');
            if (colonIdx > 0) {
                return { code: item.slice(0, colonIdx).trim(), desc: item.slice(colonIdx + 1).trim() };
            }
            return { code: item.trim(), desc: '' };
        }
        // object shape
        const code = item.code || item.nama || item.broker || '-';
        const parts = [
            item.type  && item.type  !== 'unknown' ? item.type  : null,
            item.value && item.value !== 'unknown' ? item.value : null,
            item.comment || null,
        ].filter(Boolean);
        return { code, desc: parts.join(' · ') };
    };

    const renderItems = (items) => items
        .map(normalizeItem)
        .map(({ code, desc }) =>
            `<li><strong>${escapeHTML(code)}</strong>${desc ? ` — <span class="">${escapeHTML(desc)}</span>` : ''}</li>`
        ).join('');

    const buyerMarkup = buyers.length ? `
        <div class="mb-2">
            <div class="small text-muted">Top Net Buyers</div>
            <ul class="mb-2 ps-3">${renderItems(buyers)}</ul>
        </div>` : '';

    const sellerMarkup = sellers.length ? `
        <div class="mb-2">
            <div class="small text-muted">Top Net Sellers</div>
            <ul class="mb-2 ps-3">${renderItems(sellers)}</ul>
        </div>` : '';

    const patternsMarkup = renderListSection('Pola Broker', Array.isArray(section.patterns) ? section.patterns : []);

    if (!buyerMarkup && !sellerMarkup && !patternsMarkup) return '';
    return `
        <div class="mb-3">
            <div class="text-uppercase text-muted fw-semibold mb-2">Broker Kunci</div>
            ${buyerMarkup}
            ${sellerMarkup}
            ${patternsMarkup}
        </div>
    `;
}

function renderTechnicalSection(section) {
    if (!section || typeof section !== 'object') return '';

    // Parse level entries: string "1,425: Level dimana..." → show as "1,425 — Level dimana..."
    // Or string "1,410-1,415: Zona" → "1,410-1,415 — Zona"
    const parseLevelItem = (s) => {
        if (typeof s !== 'string') return escapeHTML(String(s));
        const m = s.match(/^([\d,.\-\s]+)(?::(.*))?$/);
        if (m) {
            const price = m[1].trim();
            const desc  = m[2] ? m[2].trim() : '';
            return desc
                ? `<strong>${escapeHTML(price)}</strong> <span class="text-muted">— ${escapeHTML(desc)}</span>`
                : `<strong>${escapeHTML(price)}</strong>`;
        }
        return escapeHTML(s);
    };

    const renderLevels = (label, arr) => {
        if (!Array.isArray(arr) || !arr.length) return '';
        const items = arr.map(s => `<li>${parseLevelItem(s)}</li>`).join('');
        return `
            <div class="mb-2">
                <div class="small text-muted">${escapeHTML(label)}</div>
                <ul class="mb-1 ps-3">${items}</ul>
            </div>`;
    };

    const html = [
        renderLevels('Support', section.supports),
        renderLevels('Resistance', section.resistances),
        renderLevels('Zona Akumulasi', section.accumulation_zones),
        renderListSection('Catatan Intraday', Array.isArray(section.intraday_notes) ? section.intraday_notes.filter(Boolean) : []),
    ].filter(Boolean).join('');

    if (!html) return '';
    return `
        <div class="mb-3">
            <div class="text-uppercase text-muted fw-semibold mb-2">Level Teknikal</div>
            ${html}
        </div>
    `;
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
    const rawConf = section.confidence ?? section.tingkat_keyakinan ?? null;
    let confidence = null;
    if (rawConf != null && rawConf !== 0) {
        if (typeof rawConf === 'number' && !isNaN(rawConf)) {
            confidence = `${(rawConf > 1 ? rawConf : rawConf * 100).toFixed(0)}%`;
        } else if (typeof rawConf === 'string') {
            const pct = parseFloat(rawConf.replace('%', ''));
            confidence = !isNaN(pct) && pct > 0 ? `${(pct > 1 ? pct : pct * 100).toFixed(0)}%` : rawConf;
        }
    }
    if (!confidence && section.rating) {
        const u = (section.rating || '').toUpperCase();
        const alasanArr = Array.isArray(section.alasan_rating) ? section.alasan_rating
            : Array.isArray(section.rationale) ? section.rationale
            : Array.isArray(section.alasan) ? section.alasan : [];
        let base = 50;
        if (/STRONG BUY|STRONG SELL/.test(u)) base = 85;
        else if (/BUY|SELL|AKUMULASI|DISTRIBUSI|MARKDOWN/.test(u)) base = 75;
        else if (/HOLD|NETRAL|WAIT/.test(u)) base = 60;
        confidence = `${Math.min(95, base + alasanArr.length * 3)}%`;
    }
    if (confidence) {
        rows.push(`<div><div class="text-muted small">Confidence</div><div class="fw-bold">${escapeHTML(confidence)}</div></div>`);
    }

    const rationale = renderListSection('Alasan', Array.isArray(section.rationale) ? section.rationale : []);
    const risks = renderListSection('Risiko', Array.isArray(section.risks) ? section.risks : []);

    return `
        <div class="mb-3">
            <div class="text-uppercase text-muted fw-semibold mb-2">Kesimpulan & Rekomendasi</div>
            <div class="d-flex flex-wrap gap-4 mb-2">
                ${rows.join('')}
            </div>
            ${rationale}
            ${risks}
        </div>
    `;
}

function renderSummaryTable(data) {
    // Smart text extractor: string → as-is, array → join first items, object → first string leaf values
    function pickText(v, maxLen) {
        maxLen = maxLen || 200;
        if (!v && v !== 0) return null;
        if (typeof v === 'string') return v.trim().slice(0, maxLen) || null;
        if (typeof v === 'number') return String(v);
        if (Array.isArray(v)) {
            return v
                .map(x => typeof x === 'string' ? x.trim()
                        : typeof x === 'object'  ? pickText(x, 80)
                        : String(x))
                .filter(Boolean).slice(0, 3).join(' · ').slice(0, maxLen) || null;
        }
        if (typeof v === 'object') {
            return Object.values(v).map(x => pickText(x, 100)).filter(Boolean).slice(0, 2).join(' · ').slice(0, maxLen) || null;
        }
        return null;
    }

    // Normalize: support both English and Indonesian field names
    const execSum  = data.executive_summary       || data.ringkasan_eksekutif      || null;
    const rec      = data.recommendation          || data.kesimpulan_rekomendasi   || {};
    const ff       = data.fund_flow               || data.analisis_fund_flow       || {};
    const sm       = data.smart_money             || data.analisis_smart_money     || {};
    const tl       = data.technical_levels        || data.level_teknikal           || {};
    const kb       = data.key_brokers             || data.identifikasi_broker_kunci || {};

    const rows = [];

    // 1. Ringkasan eksekutif (string or array)
    const execText = pickText(execSum, 280);
    if (execText) rows.push(['Ringkasan', execText]);

    // 2. Fase & Rating dari rekomendasi
    const phase  = rec.phase  || rec.fase_saham   || rec.fase  || null;
    const rating = rec.rating || rec.rekomendasi  || null;

    // Derive confidence: cek semua kemungkinan field, lalu hitung otomatis dari rating+alasan
    let conf = null;
    const rawConf = rec.confidence ?? rec.tingkat_keyakinan ?? null;
    if (rawConf != null && rawConf !== 0) {
        if (typeof rawConf === 'number') {
            conf = `${(rawConf > 1 ? rawConf : rawConf * 100).toFixed(0)}%`;
        } else if (typeof rawConf === 'string') {
            const pct = parseFloat(rawConf.replace('%', ''));
            conf = !isNaN(pct) && pct > 0 ? `${(pct > 1 ? pct : pct * 100).toFixed(0)}%` : rawConf;
        }
    }
    if (!conf && rating) {
        // Auto-derive dari kekuatan rating + jumlah alasan
        const u = rating.toUpperCase();
        const alasanArr = Array.isArray(rec.alasan_rating) ? rec.alasan_rating
            : Array.isArray(rec.rationale) ? rec.rationale
            : Array.isArray(rec.alasan) ? rec.alasan : [];
        let base = 50;
        if (/STRONG BUY|STRONG SELL/.test(u)) base = 85;
        else if (/BUY|SELL|AKUMULASI|DISTRIBUSI|MARKDOWN/.test(u)) base = 75;
        else if (/HOLD|NETRAL|WAIT/.test(u)) base = 60;
        conf = `${Math.min(95, base + alasanArr.length * 3)}%`;
    }

    if (phase)  rows.push(['Fase Pasar', phase]);
    if (rating) rows.push(['Rating',    rating]);
    if (conf)   rows.push(['Confidence', conf]);

    // 3. Fund Flow — coba field spesifik dulu, fallback ke text pertama dari objek
    const ffParts = [
        ff.foreign_trend  || ff.tren_asing    || null,
        ff.local_trend    || ff.tren_lokal    || null,
        ff.dominant_side  || ff.sisi_dominan  || null,
        ff.divergence     || ff.divergensi    || null,
    ].filter(x => x && x !== 'unknown');
    const ffText = ffParts.length ? ffParts.join(' · ') : pickText(ff, 200);
    if (ffText) rows.push(['Fund Flow', ffText]);

    // 4. Smart Money
    const smState = sm.state || sm.kondisi || sm.status || null;
    const smText  = sm.assessment || sm.kualitas_akumulasi || sm.penilaian
        || (!smState ? pickText(sm, 180) : null);
    if (smState && smState !== 'UNKNOWN') rows.push(['Smart Money', smState]);
    if (smText)  rows.push([(smState ? 'Penilaian' : 'Smart Money'), smText]);

    // 5. Technical — extract angka saja (sebelum titik dua)
    const cleanLvl = s => typeof s === 'string' ? s.split(':')[0].trim() : String(s);
    const sup = (Array.isArray(tl.supports)         ? tl.supports
              :  Array.isArray(tl.support_levels)   ? tl.support_levels : []).slice(0, 4);
    const res = (Array.isArray(tl.resistances)      ? tl.resistances
              :  Array.isArray(tl.resistance_levels) ? tl.resistance_levels : []).slice(0, 4);
    if (sup.length) rows.push(['Support',    sup.map(cleanLvl).join(', ')]);
    if (res.length) rows.push(['Resistance', res.map(cleanLvl).join(', ')]);

    // 6. Broker — extract kode (sebelum titik dua / tanda hubung)
    const extractCode = x => {
        if (typeof x === 'string') return x.split(':')[0].split(' - ')[0].trim();
        return x.code || x.nama || '';
    };
    const buyers  = (Array.isArray(kb.top_net_buyers)   ? kb.top_net_buyers
                   : Array.isArray(kb.broker_utama_beli) ? kb.broker_utama_beli : []).slice(0, 5).map(extractCode).filter(Boolean);
    const sellers = (Array.isArray(kb.top_net_sellers)  ? kb.top_net_sellers
                   : Array.isArray(kb.broker_utama_jual) ? kb.broker_utama_jual : []).slice(0, 5).map(extractCode).filter(Boolean);
    if (buyers.length)  rows.push(['Top Buyers',  buyers.join(', ')]);
    if (sellers.length) rows.push(['Top Sellers', sellers.join(', ')]);

    // 7. Alasan & Risiko
    const rationale = Array.isArray(rec.rationale) ? rec.rationale : Array.isArray(rec.alasan) ? rec.alasan : [];
    const risks     = Array.isArray(rec.risks)     ? rec.risks     : Array.isArray(rec.risiko)  ? rec.risiko  : [];
    rationale.filter(Boolean).slice(0, 2).forEach((s, i) => rows.push([i === 0 ? 'Alasan' : '', String(s)]));
    risks.filter(Boolean).slice(0, 2).forEach((s, i)     => rows.push([i === 0 ? 'Risiko' : '', String(s)]));

    if (!rows.length) return '';

    const ratingClass = (v) => {
        const u = (v || '').toUpperCase();
        if (/BUY|AKUMULASI|STRONG BUY/.test(u))             return 'text-success fw-bold';
        if (/SELL|DISTRIBUSI|AVOID|JUAL|MARKDOWN/.test(u))  return 'text-danger fw-bold';
        if (/HOLD|NETRAL|WAIT/.test(u))                     return 'text-warning fw-bold';
        return 'fw-bold';
    };

    const tableRows = rows.map(([k, v]) => {
        if (!v) return '';
        const isHighlight = k === 'Rating' || k === 'Fase Pasar';
        const valClass = isHighlight ? ratingClass(v) : '';
        const keyHtml = k
            ? `<td class="text-muted text-nowrap pe-3" style="width:28%;vertical-align:top">${escapeHTML(k)}</td>`
            : `<td class="pe-3" style="width:28%"></td>`;
        return `<tr>${keyHtml}<td class="${valClass}">${escapeHTML(String(v))}</td></tr>`;
    }).filter(Boolean).join('');

    if (!tableRows) return '';

    return `
        <div class="mb-3 p-2" style="background:var(--bs-body-bg,#fff);border:0px solid var(--bs-border-color,#dee2e6)">
            <table class="table table-sm table-borderless mb-0">
                <tbody>${tableRows}</tbody>
            </table>
        </div>
    `;
}

function renderAnalysisJSON(data, screenshots) {
    if (!data || typeof data !== 'object') {
        return '<p class="text-muted">Analisis tidak tersedia.</p>';
    }

    // ── Normalize field names (support both English and Indonesian from Claude) ──
    const _execSum = data.executive_summary     || data.ringkasan_eksekutif       || null;
    const _ff      = data.fund_flow             || data.analisis_fund_flow        || {};
    const _sm      = data.smart_money           || data.analisis_smart_money      || {};
    const _kb      = data.key_brokers           || data.identifikasi_broker_kunci || {};
    const _tl      = data.technical_levels      || data.level_teknikal            || {};
    const _rec     = data.recommendation        || data.kesimpulan_rekomendasi    || {};

    // Normalize Indonesian-keyed subfields into English shape for section renderers
    if (!_ff.foreign_trend && _ff.tren_akumulasi)  _ff._summaryText = _ff.tren_akumulasi;
    if (!_sm.state         && _sm.kondisi)         _sm.state        = _sm.kondisi;
    if (!_sm.assessment    && _sm.kualitas_akumulasi) _sm.assessment = _sm.kualitas_akumulasi;
    // Technical levels — support both EN and ID field names
    if (!_tl.supports     && _tl.support_levels)   _tl.supports     = _tl.support_levels;
    if (!_tl.resistances  && _tl.resistance_levels) _tl.resistances = _tl.resistance_levels;
    // Also handle object format: { support_levels: {"*1,425": "desc", ...} } → array of "price: desc"
    for (const key of ['supports', 'resistances']) {
        if (_tl[key] && !Array.isArray(_tl[key]) && typeof _tl[key] === 'object') {
            _tl[key] = Object.entries(_tl[key]).map(([k, v]) => v ? `${k.replace(/^\*/, '')}: ${v}` : k.replace(/^\*/, ''));
        }
    }
    if (!_rec.phase    && _rec.fase_saham)  _rec.phase    = _rec.fase_saham;
    if (!_rec.rating   && _rec.rekomendasi) _rec.rating   = _rec.rekomendasi;
    if (!_rec.rationale && _rec.alasan)     _rec.rationale = _rec.alasan;
    if (!_rec.risks    && _rec.risiko)      _rec.risks     = _rec.risiko;
    // Normalize confidence: tingkat_keyakinan bisa berupa 0.85, 85, "85%", "HIGH"
    if (_rec.confidence == null && _rec.tingkat_keyakinan != null) {
        const raw = _rec.tingkat_keyakinan;
        if (typeof raw === 'number') {
            _rec.confidence = raw > 1 ? raw / 100 : raw; // 85 → 0.85, 0.85 → 0.85
        } else if (typeof raw === 'string') {
            const pct = parseFloat(raw.replace('%', ''));
            _rec.confidence = !isNaN(pct) ? (pct > 1 ? pct / 100 : pct) : raw; // keep string "HIGH"
        }
    }
    // Broker: pass strings as-is — renderBrokerSection.normalizeItem handles "CODE: desc" strings
    if (!_kb.top_net_buyers  && _kb.broker_utama_beli)  _kb.top_net_buyers  = _kb.broker_utama_beli;
    if (!_kb.top_net_sellers && _kb.broker_utama_jual)  _kb.top_net_sellers = _kb.broker_utama_jual;

    // ── Narasi utama (always open) ──
    const summaryTable = renderSummaryTable(data);
    const execSumArr = Array.isArray(_execSum) ? _execSum : (_execSum ? [_execSum] : []);
    const naratif = [
        renderListSection('Ringkasan Eksekutif', execSumArr),
        renderFundFlowSection(_ff),
        renderSmartMoneySection(_sm),
        renderBrokerSection(_kb),
        renderTechnicalSection(_tl),
        renderRecommendationSection(_rec),
    ].filter(Boolean).join('');

    // ── Thumbnails ──
    let thumbsHtml = '';
    if (Array.isArray(screenshots) && screenshots.length) {
        const thumbs = screenshots.map(s => `
            <div class="text-center">
                <img src="${escapeHTML(s.url)}" alt="${escapeHTML(s.label)}" title="${escapeHTML(s.label)}" loading="lazy"
                    style="max-width:120px;max-height:90px;border-radius:4px;border:1px solid #ccc;object-fit:cover;cursor:pointer"
                    onclick="this.closest('details').querySelector('.img-fullview') && this.closest('details').querySelector('.img-fullview').remove(); const f=document.createElement('img'); f.src=this.src; f.className='img-fullview'; f.style='width:100%;margin-top:8px;border-radius:4px'; this.closest('details').appendChild(f)">
                <div class="thumb-label small text-muted mt-1">${escapeHTML(s.label)}</div>
            </div>`).join('');
        thumbsHtml = `<div class="d-flex gap-2 flex-wrap mb-2">${thumbs}</div>`;
    }

    // ── Metadata ──
    const metaHtml = renderMetaSection(data.meta || {});

    // ── JSON mentah ──
    const jsonDump = escapeHTML(JSON.stringify(data, null, 2));
    const jsonHtml = `<pre class="small p-2 rounded" style="background:#1a1a1a;color:#ccc;max-height:300px;overflow:auto">${jsonDump}</pre>`;

    return `
        ${summaryTable}
        ${naratif}
        <details class="mt-3">
            <summary class="small text-muted" style="cursor:pointer">Lihat Screenshot</summary>
            <div class="mt-2">${thumbsHtml || '<span class="small text-muted">Tidak ada screenshot.</span>'}</div>
        </details>
        <details class="mt-2">
            <summary class="small text-muted" style="cursor:pointer">Lihat Metadata</summary>
            <div class="mt-2">${metaHtml}</div>
        </details>
        <details class="mt-2">
            <summary class="small text-muted" style="cursor:pointer">Lihat JSON Mentah</summary>
            ${jsonHtml}
        </details>
    `;
}

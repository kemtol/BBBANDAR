<!DOCTYPE html>
<html lang="id">

<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0b0b0e" />

    <script>
        (function () {
            const STORAGE_KEY = 'ui:theme';
            const root = document.documentElement;
            try {
                const saved = window.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
                const theme = saved || 'dark';
                root.setAttribute('data-theme', theme);
                root.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
            } catch (error) {
                root.setAttribute('data-theme', 'dark');
                root.style.colorScheme = 'dark';
            }
        })();
    </script>

    <title>SSSAHAM - Orderflow Scanner</title>

    <!-- (opsional) samain dengan index.html -->
    <link rel="manifest" href="/site.webmanifest" />
    <link rel="apple-touch-icon" sizes="180x180" href="../img/apple-touch-icon.png">
    <link rel="icon" type="image/png" sizes="32x32" href="../img/favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="../img/favicon-16x16.png">

    <!-- Bootstrap & Font Awesome -->
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css" rel="stylesheet" />
    <link rel="stylesheet" href="../../theme.css" />
    <link href="component.css" rel="stylesheet" />

    <style>
        :root {
            --table-header-text: var(--muted);
            --table-hover-bg: #f1f5f9;
            --card-divider: rgba(148, 163, 184, 0.35);
            --card-radius: 12px;
            --quad-badge-bg: var(--surface-alt);
        }

        :root[data-theme="dark"] {
            --table-hover-bg: rgba(255, 255, 255, 0.05);
            --card-divider: rgba(82, 94, 106, 0.55);
            --quad-badge-bg: rgba(242, 169, 0, 0.25);
        }

        body {
            background: var(--bg);
            color: var(--text);
            transition: background-color 0.3s ease, color 0.3s ease;
        }

        body,
        .card,
        .navbar,
        .dropdown-menu,
        .form-control,
        .modal-content {
            transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
        }

        .card-swing {
            border-radius: var(--card-radius);
            border: 1px solid var(--card-divider);
            background: var(--surface);
            color: var(--text);
            box-shadow: none;
        }

        .card-swing-header,
        .card-header {
            background: transparent;
            border-bottom: 1px solid var(--card-divider);
            border-radius: var(--card-radius) var(--card-radius) 0 0;
        }

        .card-body,
        .card-header {
            color: var(--text);
        }

        .table-orderflow {
            font-size: 0.9rem;
            white-space: nowrap;
            color: var(--text);
        }

        .table-orderflow > :not(caption) > * > * {
            background-color: transparent !important;
            color: var(--text);
            border-color: var(--border);
        }

        .table-orderflow thead th {
            text-transform: uppercase;
            font-size: 0.9rem;
            color: var(--table-header-text);
            border-bottom-color: var(--border);
        }

        .table-orderflow tbody tr {
            cursor: pointer;
            transition: background-color 0.2s ease;
        }

        .table-orderflow tbody tr:hover {
            background-color: var(--table-hover-bg);
        }

        .table-orderflow thead th.sortable {
            position: relative;
            padding-right: 14px;
        }

        .sort-icon {
            position: absolute;
            right: 2px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--table-header-text);
        }

        .sort-icon.active {
            opacity: 1;
        }

        .quadrant-badge {
            width: 18px;
            text-align: center;
            border-radius: 999px;
            font-size: 0.7rem;
            display: block;
            height: 18px;
            position: relative;
            left: 5px;
            background: var(--quad-badge-bg);
            color: var(--text);
        }

        .stat-pill {
            font-size: 0.7rem;
            border-radius: 999px;
            padding: 2px 8px;
        }

        .quad-legend,
        .filter-section .text-muted,
        .text-muted {
            color: var(--text-muted) !important;
        }

        .heartbeat-pulse {
            width: 8px;
            height: 8px;
            background-color: #22c55e;
            border-radius: 50%;
            display: inline-block;
            animation: pulse-animation 2s infinite;
        }

        @keyframes pulse-animation {
            0% {
                transform: scale(0.95);
                box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7);
            }

            70% {
                transform: scale(1);
                box-shadow: 0 0 0 10px rgba(34, 197, 94, 0);
            }

            100% {
                transform: scale(0.95);
                box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
            }
        }

        .filter-section {
            background: transparent;
        }

        .filter-pill {
            background: var(--surface-alt);
            color: var(--text);
        }

        .filter-pill.active {
            background: var(--primary);
            color: var(--text-inverse);
        }

        .timeline-card {
            color: var(--text);
            border: 1px solid var(--card-divider);
            background: var(--surface);
        }

        .timeline .timeline-time {
            color: var(--text-muted);
        }

        #stat-count {
            transition: background-color 0.3s ease, color 0.3s ease;
        }

        :root[data-theme="light"] #stat-count {
            background-color: var(--surface-alt);
            color: var(--text);
        }

        :root:not([data-theme="dark"]) #stat-count {
            background-color: var(--surface-alt);
            color: var(--text);
        }

        :root[data-theme="dark"] #stat-count,
        html[data-theme="dark"] #stat-count {
            background-color: var(--primary);
            color: var(--text-inverse);
        }

        .pagination .page-link {
            background-color: var(--surface-alt);
            border-color: var(--border);
            color: var(--text);
        }

        .pagination .page-item.active .page-link {
            background-color: var(--primary);
            border-color: var(--primary);
            color: var(--text-inverse);
        }

        html[data-theme="dark"] .pagination .page-link {
            background-color: var(--surface-alt);
            border-color: var(--border);
            color: var(--text);
        }

        html[data-theme="dark"] .pagination .page-item.active .page-link {
            background-color: var(--primary);
            border-color: var(--primary);
            color: var(--text-inverse);
        }
    </style>
</head>

<body>
    <nav class="navbar sticky-top py-3">
        <div class="container d-flex align-items-center" style="max-width: 1200px; position: relative;">
            <div style="width:72px;" class="d-flex align-items-center">
                <i class="fa-solid fa-circle-half-stroke" id="theme-toggle-icon" title="Toggle theme (Shift + D)"></i>
            </div>
            <div class="flex-grow-1 text-center">
                <span class="nav-title">Dashboard</span>
            </div>
            <div style="width:72px;" class="text-end">
                <i class="fa-solid fa-magnifying-glass" style="cursor: pointer;" onclick="toggleSearch()"></i>
            </div>
        </div>
    </nav>

    <div id="loading-indicator" class="text-center my-5">
        <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
        <p class="small text-muted mt-2">Memuat data orderflow...</p>
    </div>

    <div id="app" class="container mb-3">
        <!-- NAVIGATION TABS -->
        <ul class="nav nav-tabs mb-3" role="tablist">
            <li class="nav-item" role="presentation">
                <a class="nav-link" href="../index.html">Feed</a>
            </li>
            <li class="nav-item" role="presentation">
                <span class="nav-link active">Orderflow</span>
            </li>
            <li class="nav-item" role="presentation">
                <a class="nav-link" href="broker-summary.html">Brokerflow</a>
            </li>
        </ul>

        <!-- INFO BANNER -->
        <div class="alert alert-light border small mb-3 d-none">
            <strong>Swing Orderflow Scanner (Skeleton).</strong><br />
            Halaman ini membaca snapshot dari livetrade-taping untuk mode <em>swing</em>.
            Nanti dihubungkan ke Worker: <code>/summary?mode=swing</code> dan <code>/symbol</code>.
        </div>

        <!-- 4-QUADRANT HEATMAP (Chart.js) -->
        <div class="mb-3">
            <div style="height:50vh;">
                <canvas id="quadChart"></canvas>
            </div>
        </div>

        <!-- HEADER + FILTER -->
        <div id="filter-row" class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
            <div>
                <div class="h5 fw-bold">Orderflow Scanner</div>
                <div class="text-muted small mb-4">Market Participant Analysis</div>
            </div>

                            <div class="d-flex flex-wrap gap-2 align-items-center">
                    <div id="heartbeat-indicator" class="text-muted small d-flex align-items-center gap-1"
                        title="Automated heartbeat check">
                        <div class="heartbeat-pulse"></div>
                        <span id="last-updated">Updating...</span>
                    </div>
                    <span id="stat-count" class="badge">0 items</span>
                </div>

        </div>


        <!-- TABLE CARD -->
        <div class="card card-swing mb-5">
            <div class="card-body p-0">
                <div class="table-responsive">
                    <table class="table table-hover mb-0 table-orderflow align-middle">
                        <thead>
                            <tr>
                                <th class="text-center">#</th>

                                <th class="sortable" data-sort="kode">
                                    Kode <span class="sort-icon">↕</span>
                                </th>
                                <!-- Close/High/Low Removed -->
                                <th class="text-end sortable" data-sort="vol">
                                    Vol <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="net_vol">
                                    Net Vol <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="haka_pct">
                                    % Haka <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="range">
                                    Range <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="fluktuasi">
                                    Volatilitas <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="div">
                                    ABS(CVD) <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-center sortable" data-sort="score">
                                    Accum Score <span class="sort-icon">↕</span>
                                </th>
                                <th class="text-end sortable" data-sort="score">
                                    Prediksi <span class="sort-icon">↕</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody id="tbody-swing">
                            <!-- rows via jQuery -->
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- PAGINATION -->
        <nav id="pagination-nav" class="d-flex justify-content-between align-items-center my-3">
            <div class="text-muted small">
                Showing <span id="page-range">1-100</span> of <span id="total-items">0</span>
            </div>
            <ul class="pagination pagination-sm mb-0">
                <li class="page-item" id="prev-page">
                    <a class="page-link" href="#" onclick="changePage(-1); return false;">«</a>
                </li>
                <li class="page-item active">
                    <span class="page-link" id="current-page-num">1</span>
                </li>
                <li class="page-item disabled">
                    <span class="page-link" id="total-pages">/ 1</span>
                </li>
                <li class="page-item" id="next-page">
                    <a class="page-link" href="#" onclick="changePage(1); return false;">»</a>
                </li>
            </ul>
        </nav>

        <!-- DETAIL PANEL -->
        <div class="card card-swing mb-4" id="detail-card" style="display:none;">
            <div class="card-body">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <div>
                        <div class="text-muted small">Detail Emiten</div>
                        <div class="h6 mb-0" id="detail-kode">-</div>
                    </div>
                    <span id="detail-quadrant" class="quadrant-badge bg-secondary text-white">-</span>
                </div>
                <div id="detail-body" class="small text-muted">
                    <!-- detail text -->
                </div>
            </div>
        </div>
    </div>

    <!-- SCRIPTS -->
    <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0"></script>
    <script src="component.js"></script>

    <script>
        Chart.register(ChartDataLabels);
        const isLocal = false; // Force remote for now
        const API_BASE = isLocal
            ? "http://127.0.0.1:8787"
            : "https://api-saham.mkemalw.workers.dev"; // Fixed worker URL

        const DEBUG = new URLSearchParams(window.location.search).has('debug');
        function dbg(...args) { if (DEBUG) console.log('%c[OF-DEBUG]', 'color:#2563eb;font-weight:bold', ...args); }
        function dbgWarn(...args) { if (DEBUG) console.warn('%c[OF-DEBUG]', 'color:#f59e0b;font-weight:bold', ...args); }
        function dbgTable(label, data) { if (DEBUG) { console.groupCollapsed(`%c[OF-DEBUG] ${label}`, 'color:#2563eb;font-weight:bold'); console.table(data); console.groupEnd(); } }

        $(function () {

            // --- HELPERS ---

            function formatNum(n) {
                if (n === null || n === undefined || isNaN(n)) return "-";
                return n.toLocaleString("id-ID");
            }

            function formatRangeLabel(range) {
                if (!range) return "-";
                return `${range.from.replace("T", " ")} → ${range.to.replace("T", " ")}`;
            }

            function initRecentBubbleRange() {
                // Heartbeat placeholder
            }

            // Init Date Inputs
            initRecentBubbleRange();

            // --- FOOTPRINT QUADRANT LOGIC ---

            let currentRows = [];
            let currentSort = { key: 'score', dir: 'desc' };
            let quadChartInstance = null;
            
            // Pagination state
            const PAGE_SIZE = 100;
            let currentPage = 1;

            // Quadrant Lines Plugin
            const quadrantLinesPlugin = {
                id: 'quadrantLines',
                beforeDraw: (chart) => {
                    const { ctx, chartArea, scales: { x, y } } = chart;
                    const { left, right, top, bottom } = chartArea;
                    // Zero lines
                    const x0 = x.getPixelForValue(0);
                    const y0 = y.getPixelForValue(0);

                    ctx.save();
                    ctx.beginPath();
                    ctx.strokeStyle = '#2563eb'; // Solid Blue
                    ctx.lineWidth = 2;
                    // Removed setLineDash for solid lines

                    // Vertical
                    if (x0 >= left && x0 <= right) {
                        ctx.moveTo(x0, top);
                        ctx.lineTo(x0, bottom);
                    }
                    // Horizontal
                    if (y0 >= top && y0 <= bottom) {
                        ctx.moveTo(left, y0);
                        ctx.lineTo(right, y0);
                    }
                    ctx.stroke();
                    ctx.restore();
                }
            };

            function computeQuadrantStandard(x, y) {
                if (x >= 0 && y >= 0) return 1;
                if (x < 0 && y >= 0) return 2;
                if (x < 0 && y < 0) return 3;
                return 4;
            }

            function loadData(retry = 0) {
                const url = `${API_BASE}/footprint/summary?_ts=${Date.now()}`;
                // Keep loading indicator visible during retries
                if (retry === 0) $("#loading-indicator").show();

                $.ajax({
                    url: url,
                    dataType: "json",
                    cache: false, // Disable jQuery cache
                    timeout: 20000, // 20s timeout for Cold Start
                    success: function (resp) {
                        const rawItems = resp.items || [];
                        const generatedAt = resp.generated_at;
                        const status = resp.status;
                        const reason = resp.reason;

                        // --- DEBUG LOGGING ---
                        dbg('API Response:', {
                            status, reason,
                            version: resp.version,
                            date: resp.date,
                            count: resp.count,
                            generated_at: generatedAt,
                            items_received: rawItems.length
                        });
                        if (status === 'FALLBACK' || status === 'WEEKEND_FALLBACK') {
                            dbgWarn(`⚠️ FALLBACK aktif: ${reason || 'unknown'}. Data bukan hari ini.`);
                        }
                        if (status === 'NO_DATA') {
                            dbgWarn('❌ NO_DATA: API tidak punya data sama sekali.');
                        }
                        if (status === 'DEGRADED') {
                            dbgWarn('⚠️ DEGRADED: Data ada tapi tidak lengkap (footprint rows kosong).');
                        }
                        if (rawItems.length > 0) {
                            const signals = {};
                            rawItems.forEach(i => { signals[i.sig] = (signals[i.sig] || 0) + 1; });
                            dbg('Signal distribution:', signals);
                            dbg('Sample item [0]:', rawItems[0]);
                            const noCtx = rawItems.filter(i => !i.ctx_found && i.ctx_found !== undefined);
                            if (noCtx.length > 0) dbgWarn(`${noCtx.length} items tanpa konteks historical (ctx_found=false)`);
                        }
                        // --- END DEBUG ---

                        // Show fallback banner if applicable
                        $("#fallback-banner").remove();
                        if (status === "FALLBACK" || status === "WEEKEND_FALLBACK") {
                            $(`<div id="fallback-banner" class="small py-2 mb-2 d-flex align-items-center gap-2">
                                <i class="fa-solid fa-clock-rotate-left"></i>
                                <span>Data historis: <strong>${reason || resp.date}</strong></span>
                            </div>`).insertBefore("#filter-row");
                        }

                        currentRows = rawItems
                            .filter(item => item.t && item.t.length <= 4 && (item.src === 'ZSCORE' || (item.v || 0) >= 1000)) // Filter warrants & illiquid (<1000 lots), keep ZSCORE items
                            .map((item, idx) => {
                                const deltaPct = item.d || 0;
                                const priceChg = item.p || 0;
                                const vol = item.v || 0;

                                const netVol = (deltaPct * vol) / 100;
                                const hakaPct = (deltaPct + 100) / 2;
                                const quadrant = computeQuadrantStandard(deltaPct, priceChg);

                                return {
                                    _index: idx,
                                    kode: item.t,
                                    close: item.c || 0,
                                    high: item.h || item.c || 0,
                                    low: item.l || item.c || 0,
                                    vol: vol,
                                    net_vol: netVol,
                                    haka_pct: hakaPct,
                                    range: item.r || 0,
                                    fluktuasi: item.f || 0,
                                    div: item.div || 0,

                                    money: deltaPct,
                                    momentum: priceChg,
                                    quadrant: quadrant,

                                    score: item.sc || 0,
                                    score_raw: item.sc_raw || item.sc || 0,  // Raw score before divergence
                                    signal: item.sig || '-',
                                    ctx_st: item.ctx_st || '-',
                                    ctx_net: item.ctx_net || 0,
                                    
                                    // Divergence fields
                                    div_factor: item.div_factor || 1.0,
                                    div_warn: item.div_warn || false,
                                    div_type: item.div_type || null,
                                    
                                    // Data source (NEW)
                                    src: item.src || 'FULL'  // 'FULL' or 'ZSCORE'
                                };
                            });

                        currentRows.sort((a, b) => b.score - a.score);
                        currentPage = 1; // Reset to first page on data load

                        dbg(`Filtered: ${rawItems.length} → ${currentRows.length} rows (removed warrants & vol<1000)`);
                        if (currentRows.length > 0) {
                            dbgTable('Top 10 by Score', currentRows.slice(0, 10).map(r => ({
                                kode: r.kode, score: r.score, signal: r.signal,
                                delta: r.money, price: r.momentum, div: r.div,
                                vol: r.vol, ctx: r.ctx_st
                            })));
                        }

                        updateDisplay(); // Render with current limit
                        $("#loading-indicator").hide();
                        /* Error Banner cleanup */
                        $("#error-banner").remove();

                        if (generatedAt) {
                            $("#last-updated").text("Last update: " + new Date(generatedAt).toLocaleTimeString());
                        }
                    },
                    error: function (xhr, status, error) {
                        console.error("Failed load footprint summary:", status, error, "Retry:", retry);
                        dbgWarn(`❌ AJAX Error: ${status} — ${error}`, {
                            httpStatus: xhr.status,
                            responseText: xhr.responseText?.substring(0, 200),
                            timeout: status === 'timeout',
                            retry
                        });

                        // Auto-retry once for Cold Starts (Timeout or 500)
                        if (retry < 1) {
                            dbg('🔄 Auto-retry in 2s (cold start handling)...');
                            setTimeout(() => loadData(retry + 1), 2000);
                            return;
                        }

                        $("#loading-indicator").hide();
                        $("#stat-count").text("Error");

                        // Final Error State
                        const msg = status === 'timeout' ? "Connection Timeout (Cold Start)" : "Failed to load data";
                        if ($("#error-banner").length === 0) {
                            // Insert error banner before the filters
                            $(`<div id="error-banner" class="alert alert-warning my-3 text-center">
                                ${msg}. <br>
                                <button class="btn btn-sm btn-outline-dark mt-2" onclick="loadData(0)">Try Again</button>
                               </div>`).insertBefore("#filter-row");
                        }
                    }
                });
            }

            function renderTable(rows) {
                dbg(`📋 renderTable: ${rows.length} rows`);
                const $tbody = $("#tbody-swing");
                $tbody.empty();

                rows.forEach((s, idx) => {
                    const netClass = s.net_vol > 0 ? "text-success" : s.net_vol < 0 ? "text-danger" : "text-muted";
                    const score = s.score.toFixed(2);
                    let sigClass = "badge bg-secondary";

                    // Signal badge styling (updated with new signals)
                    if (s.signal === 'CONFIRMED_ACCUM') sigClass = "badge bg-success";
                    else if (s.signal === 'STRONG_BUY') sigClass = "badge bg-success";
                    else if (s.signal === 'BUY') sigClass = "badge bg-primary";
                    else if (s.signal === 'WATCH') sigClass = "badge bg-info text-dark";
                    else if (s.signal === 'WATCH_ACCUM') sigClass = "badge bg-info text-dark";
                    else if (s.signal === 'STRONG_SELL') sigClass = "badge bg-danger";
                    else if (s.signal === 'TRAP_WARNING') sigClass = "badge bg-warning text-dark";
                    else if (s.signal === 'RETAIL_TRAP') sigClass = "badge bg-danger";
                    else if (s.signal === 'SM_DIVERGENCE') sigClass = "badge bg-warning text-dark";
                    else if (s.signal === 'HIDDEN_ACCUM') sigClass = "badge bg-info text-dark";
                    else if (s.signal === 'NO_INTRADAY') sigClass = "badge bg-secondary";
                    else if (s.signal === 'SELL') sigClass = "badge bg-danger";

                    // Source indicator (ZSCORE = no intraday trading data)
                    const srcBadge = s.src === 'ZSCORE' ? 
                        `<span class="badge bg-secondary ms-1" style="font-size:9px" title="Z-Score only (no intraday)">Z</span>` : '';

                    // Divergence warning icon
                    const divWarnIcon = s.div_warn ? 
                        `<i class="fas fa-exclamation-triangle text-warning ms-1" title="Divergence: ${s.div_type || 'Warning'}"></i>` : '';
                    
                    // Row background for divergence warnings or zscore-only
                    let rowClass = '';
                    if (s.div_type === 'RETAIL_TRAP') rowClass = 'table-danger';
                    else if (s.div_type === 'SM_DIVERGENCE') rowClass = 'table-warning';
                    else if (s.src === 'ZSCORE') rowClass = 'table-light';

                    const $tr = $(`
                        <tr data-kode="${s.kode}" class="${rowClass}">
                            <td class="text-center text-muted">${idx + 1}</td>
                            <td>
                                <div class="d-flex align-items-center">
                                    <img src="${API_BASE}/logo?symbol=${s.kode}" 
                                         style="width: 24px; height: 24px; object-fit: contain; margin-right: 8px; border-radius: 50%; background: #fff;" 
                                         onerror="this.style.display='none'">
                                    <a href="detail.html?kode=${encodeURIComponent(s.kode)}&mode=footprint" class="text-decoration-none fw-bold">${s.kode}</a>
                                    ${srcBadge}
                                    ${divWarnIcon}
                                </div>
                            </td>
                            <!-- High/Low Removed -->
                            <td class="text-end">${s.vol > 0 ? s.vol.toLocaleString() : '-'}</td>
                            <td class="text-end ${netClass}">${s.vol > 0 ? Math.round(s.net_vol).toLocaleString() : '-'}</td>
                            <td class="text-end">${s.vol > 0 ? s.haka_pct.toFixed(0) + '%' : '-'}</td>
                            <td class="text-end">${s.range > 0 ? s.range.toLocaleString() : '-'}</td>
                            <td class="text-end fw-bold text-primary">
                                ${s.fluktuasi > 0 ? s.fluktuasi.toFixed(2) + '%' : '-'}
                            </td>
                            <td class="text-end fw-bold">${s.div > 0 ? s.div.toFixed(1) : '-'}</td>
                            <td class="text-center">
                                <div class="fw-bold" style="color: ${score >= 0.7 ? '#16a34a' : score >= 0.5 ? '#2563eb' : '#64748b'};">
                                    ${score}
                                    ${s.div_factor < 1 ? `<small class="text-danger">(×${s.div_factor})</small>` : ''}
                                </div>
                                <div style="font-size:10px; color:#94a3b8;">${s.signal.replace('_', ' ')}</div>
                            </td>
                            <td class="text-end fw-bold">
                                ${(() => {
                            const pct = (s.score * 100).toFixed(0);
                            let label = '';
                            let color = '#64748b';

                            // Check for zscore-only items first
                            if (s.src === 'ZSCORE') {
                                if (s.ctx_st === 'ACCUMULATION') {
                                    label = '📊 ACCUM';
                                    color = '#16a34a'; // Green
                                } else if (s.ctx_st === 'DISTRIBUTION') {
                                    label = '📊 DISTRIB';
                                    color = '#dc2626'; // Red
                                } else {
                                    label = '📊 Z-SCORE';
                                    color = '#64748b'; // Gray
                                }
                            }
                            // Check for divergence signals
                            else if (s.signal === 'RETAIL_TRAP') {
                                label = '⚠️ TRAP';
                                color = '#dc2626'; // Red
                            } else if (s.signal === 'SM_DIVERGENCE') {
                                label = '⚠️ DIVERGE';
                                color = '#f59e0b'; // Amber
                            } else if (s.signal === 'CONFIRMED_ACCUM') {
                                label = '✅ CONFIRMED';
                                color = '#059669'; // Emerald
                            } else if (s.div > 5 && s.money > 2 && s.momentum >= -3) {
                                label = 'BREAKOUT';
                                color = '#16a34a'; // Green
                            } else if (s.momentum < -5) {
                                label = 'FALLING';
                                color = '#ef4444'; // Red
                            } else if (s.div > 5 && s.money < -2) {
                                label = 'HEAVY SELL';
                                color = '#dc2626'; // Red
                            } else if (s.div > 3 && s.momentum >= -3) {
                                label = 'WATCHING';
                                color = '#2563eb'; // Blue
                            } else {
                                label = s.signal.replace('_', ' ');
                            }

                            return `<span style="color: ${color}">${pct}% ${label}</span>`;
                        })()}
                            </td>
                        </tr>
                    `);
                    $tbody.append($tr);
                });

                $("#stat-count").text(rows.length);
            }

            function renderQuadrantChart(points) {
                const canvas = document.getElementById("quadChart");
                if (!canvas) return;

                // OPPORTUNITY FILTER: Only show positive-conviction items (net buying / high absorption)
                const filtered = points.filter(p => p.money > 0.5 || p.div > 5);
                dbg(`📊 renderQuadrantChart: ${points.length} input → ${filtered.length} after opportunity filter (delta>0.5 or div>5)`);

                const xVals = filtered.map(p => p.money);
                const yVals = filtered.map(p => p.div);

                // Add padding for largest bubble (25px radius ~ 3 units on typical scale)
                const bubblePadding = 3;
                const xMax = xVals.length ? Math.max(10, Math.max(...xVals) + bubblePadding) : 10;
                const xMin = xVals.length ? Math.min(0, Math.min(...xVals) - 1) : 0;
                const yMax = yVals.length ? Math.max(10, Math.max(...yVals) + bubblePadding) : 10;

                const colorByContext = (p) => {
                    const delta = p.money;
                    const ctx = p.ctx_st;

                    if (delta > 5) {
                        // Strong Power — confirmed accumulation = dark green, else bright green
                        if (ctx === 'ACCUMULATION' || ctx === 'WATCH_ACCUM') return "rgba(21, 128, 61, 0.9)";
                        return "rgba(34, 197, 94, 0.85)";
                    }
                    if (delta > 2) {
                        // Moderate Power
                        if (ctx === 'ACCUMULATION' || ctx === 'WATCH_ACCUM') return "rgba(21, 128, 61, 0.75)";
                        return "rgba(34, 197, 94, 0.65)";
                    }
                    if (delta > 0.5) {
                        // Mild positive — light green
                        return "rgba(134, 239, 172, 0.6)";
                    }
                    // Neutral / low delta but high absorption → blue-ish (watching)
                    return "rgba(96, 165, 250, 0.5)";
                };

                const data = {
                    datasets: [{
                        label: "Emiten",
                        data: filtered.map(p => ({
                            x: p.money,
                            y: p.div,
                            r: Math.min(Math.max(5, Math.sqrt(Math.abs(p.net_vol)) / 5), 25),
                            ...p
                        })),
                        backgroundColor: filtered.map(p => colorByContext(p)),


                        borderWidth: 0
                    }]
                };

                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

                const options = {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => {
                                    const d = ctx.raw;
                                    return [
                                        `${d.kode} (${d.ctx_st})`,
                                        `Score: ${d.score.toFixed(2)} · Delta: ${d.money.toFixed(1)}%`,
                                        `Absorption: ${d.div.toFixed(2)}`,
                                        `Context Net: ${d.ctx_net}`
                                    ];
                                }
                            }
                        },
                        datalabels: {
                            align: "top",
                            anchor: "end",
                            color: "#475569",
                            font: { size: 10, weight: "600" },
                            formatter: (v) => v.kode,
                            offset: 2,
                            clip: false
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: "Power (Net Delta %)" },
                            min: xMin, max: xMax,

                            grid: {
                                display: !isDark,
                                color: isDark ? 'transparent' : 'rgba(241,245,249,1)'
                            },
                            border: {
                                display: !isDark,
                                color: isDark ? 'transparent' : 'rgba(226,232,240,1)'
                            },
                            ticks: {
                                color: isDark ? '#94a3b8' : '#475569'
                            }
                        },
                        y: {
                            title: { display: true, text: "Absorption Score (ABS(CVD))" },
                            min: 0, max: yMax,

                            grid: {
                                display: !isDark,
                                color: isDark ? 'transparent' : 'rgba(241,245,249,1)'
                            },
                            border: {
                                display: !isDark,
                                color: isDark ? 'transparent' : 'rgba(226,232,240,1)'
                            },
                            ticks: {
                                color: isDark ? '#94a3b8' : '#475569'
                            }
                        }
                    }
                };

                if (quadChartInstance) quadChartInstance.destroy();
                // canvas defined at top of function

                quadChartInstance = new Chart(canvas, {
                    type: "bubble",
                    data,
                    options,
                    plugins: [quadrantLinesPlugin]
                });
            }

            function sortRows(key) {
                if (key === 'score') {
                    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
                    currentRows.sort((a, b) => currentSort.dir === 'asc' ? a.score - b.score : b.score - a.score);
                } else {
                    currentSort.key = key;
                    currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
                    const factor = currentSort.dir === 'asc' ? 1 : -1;

                    currentRows.sort((a, b) => {
                        let va = a[key]; let vb = b[key];
                        if (typeof va === 'string') return va.localeCompare(vb) * factor;
                        return (va - vb) * factor;
                    });
                }
                currentPage = 1; // Reset to first page on sort
                updateDisplay();
            }

            $(".sortable").on("click", function () {
                const key = $(this).data("sort");
                sortRows(key);
            });

            $("#tbody-swing").on("click", "tr", function () {
                const kode = $(this).data("kode");
                window.location.href = `detail.html?kode=${kode}&mode=footprint`;
            });


            function updateDisplay() {
                const totalRows = currentRows.length;
                const totalPages = Math.ceil(totalRows / PAGE_SIZE);
                
                // Clamp current page
                if (currentPage < 1) currentPage = 1;
                if (currentPage > totalPages) currentPage = totalPages;
                if (totalPages === 0) currentPage = 1;
                
                const startIdx = (currentPage - 1) * PAGE_SIZE;
                const endIdx = Math.min(startIdx + PAGE_SIZE, totalRows);
                const pageRows = currentRows.slice(startIdx, endIdx);
                
                dbg(`🔄 updateDisplay: page ${currentPage}/${totalPages}, showing ${pageRows.length}/${totalRows} rows`);

                renderTable(pageRows);
                
                // Only show top items in chart (from current page or top overall)
                const chartRows = currentRows.slice(0, 100); // Always top 100 for chart
                renderQuadrantChart(chartRows);

                // Update pagination UI
                $("#stat-count").text(`${totalRows} items`);
                $("#total-items").text(totalRows);
                $("#page-range").text(`${startIdx + 1}-${endIdx}`);
                $("#current-page-num").text(currentPage);
                $("#total-pages").text(`/ ${totalPages}`);
                
                // Enable/disable prev/next
                $("#prev-page").toggleClass("disabled", currentPage <= 1);
                $("#next-page").toggleClass("disabled", currentPage >= totalPages);
            }

            function changePage(delta) {
                currentPage += delta;
                updateDisplay();
                // Scroll to table
                $("html, body").animate({ scrollTop: $("#filter-row").offset().top - 60 }, 200);
            }

            // Heartbeat Logic
            let lastDataTime = null;
            setInterval(() => {
                dbg('⏰ Auto-refresh triggered (60s interval)');
                loadData();
            }, 60000); // Check every 1 minute

            // Init
            dbg('🚀 Orderflow Scanner init', { API_BASE, timestamp: new Date().toISOString() });
            if (DEBUG) console.log('%c[OF-DEBUG] Debug mode ON — tambahkan ?debug ke URL untuk aktifkan', 'color:#2563eb;font-weight:bold;font-size:14px');
            loadData();
        });
    </script>

    <div id="search-panel">
        <div class="mb-4">
            <input type="text" id="search-input" class="search-input p-2" placeholder="Masukkan Kode (e.g. BBRI)"
                autocomplete="off">
        </div>

        <div>
            <p class="small opacity-75 mb-2 fw-bold">RIWAYAT PENCARIAN</p>
            <div id="search-history-list">
                <!-- Populated by JS -->
            </div>
        </div>
    </div>
</body>

</html>

$(function () {

    // 1) Helper: panggil loadReko kalau sedang di home
    function triggerRekoIfHome() {
        if (location.hash.slice(1) === 'home-page') {
            const slot = $('#reko-slot-select').val() || 'any';
            loadReko(slot);
        }
    }

    // ——————————————————————
    // 1) Navigasi & history
    // ——————————————————————
    function showPageNoHistory(id) {
        $('section').hide();
        $('#' + id).fadeIn();
    }
    function navigate(id) {
        if (location.hash !== '#' + id) {
            location.hash = id; // push history -> akan diproses di 'hashchange'
        } else {
            showPageNoHistory(id);
        }
    }
    // expose global (agar bisa dipanggil dari handler lain)
    window.showPageNoHistory = showPageNoHistory;
    window.navigate = navigate;

    $(window).on('hashchange', function () {
        const page = location.hash.slice(1);
        // stop kamera kalau meninggalkan liveness
        if (page !== 'liveness-check') {
            try {
                if (window.mediaStream && mediaStream.getTracks) {
                    mediaStream.getTracks().forEach(function (t) { t.stop(); });
                }
                $('#liveness-preview').prop('srcObject', null);
            } catch (e) { }
        }
        if ($('#' + page).length) showPageNoHistory(page);
    });

    // Inisialisasi halaman pertama
    const first = location.hash.slice(1);
    if (first && $('#' + first).length) {
        showPageNoHistory(first);
    } else {
        navigate('splash-page');
    }

    // Hook tombol navigasi (delegated supaya aman)
    $(document).on('click', '#start-onboard', function () { navigate('liveness-page'); });
    $(document).on('click', '#logout-button', function () { navigate('login-page'); });
    // LOGIN di SPLASH → langsung ke HOME
    $(document).on('submit', '#splash-page #login-form', function (e) {
        e.preventDefault();
        navigate('home-page');
        setTimeout(triggerRekoIfHome, 0);
    });

    // REGISTER → langsung ke LIVENESS
    $(document).on('submit', '#register-form', function (e) {
        e.preventDefault();
        navigate('liveness-check');
    });

    $(document).on('hashchange', function () {
        triggerRekoIfHome();
    });

    // Kalau app dibuka langsung ke #home-page (refresh/deeplink)
    if (location.hash.slice(1) === 'home-page') {
        triggerRekoIfHome();
    }


    // ——————————————————————
    // 2) Liveness check
    // ——————————————————————
    let mediaStream = null, mediaRecorder = null, recordedChunks = [];

    async function initCamera() {
        // secure context check (HTTPS/localhost)
        const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (location.protocol !== 'https:' && !isLocalhost) {
            $('#liveness-result').html('Harus diakses via <b>HTTPS</b> atau <b>localhost</b>.');
            throw new Error('insecure_context');
        }
        const tries = [
            { video: { facingMode: { ideal: 'user' } }, audio: false },
            { video: true, audio: false }
        ];
        let lastErr;
        for (const c of tries) {
            try {
                mediaStream = await navigator.mediaDevices.getUserMedia(c);
                $('#liveness-preview')[0].srcObject = mediaStream;
                return;
            } catch (e) { lastErr = e; }
        }
        let hint = '';
        if (lastErr && lastErr.name === 'NotAllowedError') hint = 'Izin ditolak. Klik ikon gembok → Allow camera.';
        else if (lastErr && lastErr.name === 'NotFoundError') hint = 'Kamera tidak terdeteksi.';
        else if (lastErr && lastErr.name === 'NotReadableError') hint = 'Kamera sedang dipakai aplikasi lain.';
        else if (lastErr && lastErr.name === 'OverconstrainedError') hint = 'Constraint kamera terlalu ketat.';
        $('#liveness-result').text('Gagal akses kamera: ' + (lastErr?.name || 'Error') + (hint ? ' — ' + hint : ''));
        throw lastErr;
    }

    function pickMimeType() {
        const cand = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
            for (const t of cand) if (MediaRecorder.isTypeSupported(t)) return { mimeType: t };
        }
        return {}; // biarkan browser pilih default
    }

    function setupRecorder() {
        recordedChunks = [];
        const opts = pickMimeType();
        try { mediaRecorder = new MediaRecorder(mediaStream, opts); }
        catch (e) { mediaRecorder = new MediaRecorder(mediaStream); }

        mediaRecorder.ondataavailable = function (e) { if (e.data.size) recordedChunks.push(e.data); };
        mediaRecorder.onstop = async function () {
            $('#stop-record').prop('disabled', true);
            $('#start-record').prop('disabled', false);
            $('#liveness-result').text('Mengirim ke server…');

            const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
            const form = new FormData();
            form.append('video', blob, 'liveness.webm');

            try {
                const res = await fetch('/api/liveness', { method: 'POST', body: form });
                const data = await res.json();
                $('#liveness-result').html('Liveness score: <strong>' + (data.score ?? '-') + '</strong>');
            } catch (err) {
                $('#liveness-result').text('Gagal kirim: ' + err.message);
            } finally {
                try { mediaStream?.getTracks()?.forEach(function (t) { t.stop(); }); } catch (e) { }
                $('#liveness-preview').prop('srcObject', null);
            }

            navigate('home-page');
        };
    }

    $(document).on('click', '#start-record', async function () {
        try {
            if (!mediaStream) await initCamera();
            setupRecorder();
        } catch (e) { return; }

        const instr = $('#liveness-instruction');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));

        // hitung mundur 3–1
        for (let i = 3; i >= 1; i--) {
            instr.text(i);
            await wait(1000);
        }

        // mulai rekam
        recordedChunks = [];
        mediaRecorder.start();

        // langkah-langkah
        instr.text('Buka mulut');
        await wait(3000);

        instr.text('Tengok kanan');
        await wait(3000);

        instr.text('Tengok kiri');
        await wait(3000);

        // selesai -> stop & kirim
        instr.text('Selesai');
        mediaRecorder.stop();
    });

    // ——————————————————————
    // 2b) Tombol BYPASS (Testing)
    // ——————————————————————
    // Atur visibilitas tombol (ganti ke false untuk produksi)
    var allowBypass = true; // atau: /[?&]dev=1/.test(location.search) || localStorage.getItem('allow_bypass') === '1';
    if (allowBypass) { $('#skip-record').show(); } else { $('#skip-record').hide(); }

    $(document).on('click', '#skip-record', function (e) {
        e.preventDefault();
        try {
            if (window.mediaStream && mediaStream.getTracks) {
                mediaStream.getTracks().forEach(function (t) { t.stop(); });
            }
            $('#liveness-preview').prop('srcObject', null);
        } catch (err) { }
        localStorage.setItem('liveness_status', 'bypass_ok');
        localStorage.setItem('liveness_bypass_at', new Date().toISOString());
        $('#liveness-result').html('✅ Liveness <em>di-bypass</em> (testing mode).');
        navigate('home-page');
    });

    // ——————————————————————
    // 3) Countdown timer (contoh)
    // ——————————————————————
    /*(function startCountdown() {
        // target: besok 09:00 WIB
        function nextTarget() {
            const now = new Date();
            const tzNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            const target = new Date(tzNow);
            target.setDate(target.getDate() + 1);
            target.setHours(9, 0, 0, 0);
            return target;
        }
        const target = nextTarget();
        function upd() {
            const now = new Date();
            const diff = target - now;
            if (diff <= 0) return $('#countdown').text('Voting ditutup!');
            const h = String(Math.floor((diff / 36e5) % 24)).padStart(2, '0');
            const m = String(Math.floor((diff / 6e4) % 60)).padStart(2, '0');
            const s = String(Math.floor((diff / 1e3) % 60)).padStart(2, '0');
            $('#countdown').text(h + ' : ' + m + ' : ' + s);
        }
        upd();
        setInterval(upd, 1000);
    })();*/

    // Countdown berbasis string "YYYY-MM-DD HH:mm:ss" WIB dari backend
    function initCountdown(targetStr) {
        // targetStr contoh: "2025-08-22 09:30:00"
        if (!targetStr) return;
        const target = new Date(targetStr.replace(' ', 'T') + '+07:00'); // WIB
        const $el = $('#countdown');

        function tick() {
            const s = Math.max(0, Math.floor((target - new Date()) / 1000));
            const h = String(Math.floor(s / 3600)).padStart(2, '0');
            const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
            const sec = String(s % 60).padStart(2, '0');
            if (s > 0) {
                $el.text(`${h} : ${m} : ${sec}`);
            } else {
                $el.text('SECARA SERENTAK');
                clearInterval(timer);
            }
        }
        const timer = setInterval(tick, 1000);
        tick();
    }



    // ================== Reko from KV (Cloudflare Worker) ==================
    const WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev";
    const SLOT_LABEL = { "0930": "09:30", "1130": "11:30", "1415": "14:15", "1550": "15:50" };

    function slotToLabel(s) { return SLOT_LABEL[s] || s; }
    function fmtPct(v) { return Number.isFinite(v) ? (v * 100).toFixed(2) + "%" : "—"; }
    function fmtX(v) { return Number.isFinite(v) ? v.toFixed(2) + "x" : "—"; }
    function fmtF3(v) { return Number.isFinite(v) ? v.toFixed(3) : "—"; }
    function fmtN(v) { return Number.isFinite(v) ? v.toLocaleString("id-ID") : "—"; }

    // ====== MODIFIKASI: hanya 5 kolom (#, Ticker, Score, Return, Pace) ======
    function buildHead() {
        const html = `
            <tr>
                <th class="text-muted" style="width:52px">#</th>
                <th>Ticker</th>
                <th class="text-end">Score</th>
                <th class="text-end">Return</th>
                <th class="text-end">Pace</th>
                <th class="text-end">Buy Below</th>
            </tr>`;
        $("#reko-thead").html(html);
    }

    function renderRows(rows) {
        const $tb = $("#reko-tbody").empty();
        rows.forEach((r, i) => {
            const ret = Number(r.daily_return);
            const pace = Number(r.vol_pace);
            const score = Number(r.score);
            const cut = Number(r.price_at_cutoff);   // <— ambil field ini

            const retHTML = Number.isFinite(ret)
                ? `<span class="${ret >= 0 ? 'reko-pos' : 'reko-neg'}">${fmtPct(ret)}</span>`
                : "—";

            $tb.append(`
            <tr>
                <td class="text-muted">${i + 1}</td>
                <td><strong>${(r.ticker || "-")}</strong></td>
                <td class="reko-right">${fmtF3(score)}</td>
                <td class="reko-right">${retHTML}</td>
                <td class="reko-right">${fmtX(pace)}</td>
                <td class="reko-right">${fmtN(cut)}</td>   <!-- kolom baru -->
            </tr>
        `);
        });
    }


    async function fetchRekoJSON(slot) {
        // slot = "any" → pakai latest-any, selain itu latest?slot=XXXX
        const url = slot === "any"
            ? `${WORKER_BASE}/api/reko/latest-any`
            : `${WORKER_BASE}/api/reko/latest?slot=${slot}`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
    }

    async function loadReko(slot) {
        // loading state (colspan disesuaikan ke 5)
        $("#reko-tbody").html(`<tr><td colspan="6"><div class="reko-shimmer"></div></td></tr>`);
        $("#reko-meta").text("Memuat…");
        $("#reko-slot-badge").text("--:--");

        try {
            const data = await fetchRekoJSON(slot);
            const rows = data?.rows || [];
            const date = data?.date || "-";
            const slotStr = String(data?.slot ?? (slot === "any" ? "any" : slot)).padStart(4, "0");

            $("#reko-meta").text(`Tanggal ${date} • ${rows.length} entri`);
            $("#reko-slot-badge").text(slotStr === "any" ? "Terbaru" : slotToLabel(slotStr));

            if (!rows.length) {
                $("#reko-tbody").html(`<tr><td colspan="6" class="text-center text-muted py-3">Tidak ada data.</td></tr>`); $("#reko-thead").empty();
                return;
            }

            buildHead();
            renderRows(rows);
        } catch (e) {
            $("#reko-meta").text("Gagal memuat.");
            $("#reko-tbody").html(`<tr><td colspan="6" class="text-danger">Error: ${e.message || e}</td></tr>`);
            $("#reko-thead").empty();
        }
    }

    // event: saat masuk ke home-page pertama kali → muat “Terbaru”
    $(document).on("hashchange", function () {
        const page = location.hash.slice(1);
        if (page === "home-page") {
            const slot = $("#reko-slot-select").val() || "any";
            loadReko(slot);
        }
    });
    // kalau home-page sudah tampil saat load awal
    if (location.hash.slice(1) === "home-page") {
        loadReko($("#reko-slot-select").val() || "any");
    }

    // event: user ganti slot pada select
    $(document).on("change", "#reko-slot-select", function () {
        loadReko($(this).val() || "any");
    });

    // auto-refresh tiap 60 detik saat berada di home-page
    setInterval(function () {
        if (location.hash.slice(1) === "home-page") {
            const slot = $("#reko-slot-select").val() || "any";
            loadReko(slot);
        }
    }, 60000);




    // >>> REPLACE fungsi lama dgn ini <<<
    async function renderTopPicks() {
        const WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev"; // ganti kalau beda
        try {
            const res = await fetch(`${WORKER_BASE}/api/candidates`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            // 1) sinkronkan tombol vote sesuai urutan top picks
            const $wrap = $('#emiten-list').empty();
            (data.tickers || []).forEach(tkr => {
                $('<a/>', {
                    class: 'btn btn-lg btn-outline-primary',
                    text: tkr,
                    href: '#',
                    click: (e) => { e.preventDefault(); handleVote?.(tkr); }
                }).appendTo($wrap);
            });

            // 2) render kartu top picks
            const $grid = $('#top-picks').empty();
            (data.detail || []).forEach(item => {
                const score = typeof item.score === 'number' ? item.score : null;
                const pct = Math.max(0, Math.min(100, Math.round(((score ?? 0) / 10) * 100)));

                const $card = $('<div/>', { class: 'pick-card' });
                const $head = $(`
        <div class="pick-head">
          <span class="pick-badge"><i class="fa-solid fa-arrow-trend-up"></i> Top Pick</span>
          <h3 class="pick-ticker mb-0">${item.ticker}.JK</h3>
        </div>
      `);
                const $score = $(`<div class="pick-score">Score: ${score !== null ? score.toFixed(1) : '--'} / 10</div>`);
                const $rail = $('<div class="score-rail"><div class="score-fill"></div></div>');
                $rail.find('.score-fill').css('width', pct + '%');

                const $ul = $('<ul class="pick-bullets"></ul>');
                (item.reasons || []).slice(0, 3).forEach(txt => $ul.append(`<li>${txt}</li>`));
                if (!(item.reasons || []).length) $ul.addClass('d-none');

                const $cta = $('<button class="btn btn-primary pick-cta">VOTE SAHAM INI</button>')
                    .on('click', () => handleVote?.(item.ticker));

                $card.append($head, $score, $rail, $ul, $cta);
                $grid.append($card);
            });

            // 3) countdown pakai announce_at dari backend (kalau ada)
            if (data.announce_at) initCountdown(data.announce_at);

        } catch (err) {
            console.error('top-picks error', err);
            $('#top-picks').html('<em class="text-muted">Gagal memuat Top Picks.</em>');
        }
    }
    // panggil setelah DOM siap
    $(function () { renderTopPicks(); });


    // ——————————————————————
    // 4) Notif stacking (opsional)
    // ——————————————————————
    function showNotif(text) {
        const container = document.getElementById('notif-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = 'notif';
        el.textContent = text;
        container.appendChild(el);
        if (container.children.length > 5) {
            container.removeChild(container.firstElementChild);
        }
        setTimeout(function () {
            if (container.contains(el)) container.removeChild(el);
        }, 9000);
    }
    // simulasi (hapus di produksi)
    setInterval(function () {
        const phone = '08' + Math.floor(10000000 + Math.random() * 90000000);
        const stocks = ['BRPT', 'BREN', 'CUAN', 'TLKM'];
        const stock = stocks[Math.floor(Math.random() * stocks.length)];
        showNotif(phone + ' vote ' + stock);
    }, 3000);
});


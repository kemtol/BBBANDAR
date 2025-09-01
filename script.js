/* =========================================================
 * Quant App – Frontend Script (FINAL, drop-in)
 * Source of truth: Cloudflare Worker (KV)
 * - Top Picks: /api/reko/latest-summary  → fallback  /api/reko/latest-any
 * - Feed:     5 hari terakhir (per slot = satu tabel mini, dikelompok per TANGGAL)
 *
 * KOMPONEN HALAMAN (ID yang dipakai script ini):
 * - Splash/Login form:    #splash-page  (form id: #login-form)
 * - Register form:        #register-form → menuju liveness
 * - Halaman liveness:     #liveness-check, video#liveness-preview,
 *                         #start-record, #stop-record, #skip-record, #liveness-result
 * - Halaman utama:        #home-page
 * - Top picks container:  #top-picks, #markov-updated
 * - Feed tabel:           #reko-thead, #reko-tbody, #reko-meta, #reko-slot-badge
 * - Tentang kami (opsi):  iframe#about-us-embed
 * - Notif demo (opsi):    #notif-container
 *
 * CATATAN TEKNIS:
 * - Ditulis konservatif: tanpa optional chaining (?.) dan nullish coalescing (??).
 * - Hindari nested template-literal. Mayoritas string HTML dirakit via konkatenasi.
 * - Bergantung pada jQuery (pastikan <script src="jquery..."> sudah dimuat).
 * =======================================================*/

(function () {
  /* =========================
   * 1) KONFIGURASI
   * =======================*/
  var WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev";   // endpoint Worker Anda
  var SLOT_LABEL = { "0930": "09:30", "1130": "11:30", "1415": "14:15", "1550": "15:50" };
  var SLOTS = ["0930", "1130", "1415", "1550"];

  // Tampilkan dua tabel: non-Markov dan Markov, sekaligus
  window.DUAL_MARKOV = true;


  // Toggle feed Markov vs Non-Markov (feed historis 5 hari). Default: non-Markov.
  // Ubah ke true bila ingin feed 5 hari yang Markov (akan menambahkan ?markov=1 pada GET).
  window.FEED_MARKOV = true;

  /* =========================
   * 2) STATE (kamera / liveness) – opsional
   * =======================*/
  var mediaStream = null, mediaRecorder = null, recordedChunks = [];
  window.mediaStream = null; // untuk inspeksi manual di console

  /* =========================
   * 3) NAVIGASI & HISTORY
   * =======================*/
  function showPageNoHistory(id) {
    $("section").hide();
    $("#" + id).fadeIn();
  }
  function navigate(id) {
    if (location.hash !== "#" + id) {
      location.hash = id;
    } else {
      showPageNoHistory(id);
      triggerIfHome();
    }
  }
  window.navigate = navigate;

  $(window).on("hashchange", function () {
    var page = location.hash.slice(1);

    // Stop kamera saat keluar dari liveness
    if (page !== "liveness-check") {
      try {
        if (window.mediaStream && typeof window.mediaStream.getTracks === "function") {
          var tracks = window.mediaStream.getTracks();
          for (var i = 0; i < tracks.length; i++) tracks[i].stop();
        }
        $("#liveness-preview").prop("srcObject", null);
        window.mediaStream = mediaStream = null;
      } catch (e) { }
    }

    if ($("#" + page).length) showPageNoHistory(page);
    triggerIfHome();
  });

  // Inisialisasi halaman pertama
  var first = location.hash.slice(1);
  if (first && $("#" + first).length) {
    showPageNoHistory(first);
  } else {
    navigate("splash-page");
  }

  /* =========================
   * 4) LIVENESS CHECK (opsional, aman diabaikan jika tak dipakai)
   * =======================*/
  function initCamera() {
    return new Promise(function (resolve, reject) {
      var isLocalhost = (location.hostname === "localhost" || location.hostname === "127.0.0.1");
      if (location.protocol !== "https:" && !isLocalhost) {
        $("#liveness-result").html("Harus diakses via <b>HTTPS</b> atau <b>localhost</b>.");
        reject(new Error("insecure_context"));
        return;
      }
      var tries = [
        { video: { facingMode: { ideal: "user" } }, audio: false },
        { video: true, audio: false }
      ];
      var i = 0, lastErr = null;
      function tryNext() {
        if (i >= tries.length) {
          var hint = "";
          if (lastErr && lastErr.name === "NotAllowedError") hint = "Izin ditolak. Klik ikon gembok → Allow camera.";
          else if (lastErr && lastErr.name === "NotFoundError") hint = "Kamera tidak terdeteksi.";
          else if (lastErr && lastErr.name === "NotReadableError") hint = "Kamera sedang dipakai aplikasi lain.";
          else if (lastErr && lastErr.name === "OverconstrainedError") hint = "Constraint kamera terlalu ketat.";
          $("#liveness-result").text("Gagal akses kamera: " + (lastErr ? lastErr.name : "Error") + (hint ? " — " + hint : ""));
          reject(lastErr || new Error("getUserMedia failed"));
          return;
        }
        navigator.mediaDevices.getUserMedia(tries[i]).then(function (ms) {
          mediaStream = ms;
          window.mediaStream = mediaStream;
          var video = $("#liveness-preview")[0];
          if (video) video.srcObject = mediaStream;
          resolve();
        }).catch(function (e) { lastErr = e; i++; tryNext(); });
      }
      tryNext();
    });
  }

  function pickMimeType() {
    var cand = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === "function") {
      for (var i = 0; i < cand.length; i++) if (MediaRecorder.isTypeSupported(cand[i])) return { mimeType: cand[i] };
    }
    return {};
  }

  function setupRecorder() {
    recordedChunks = [];
    var opts = pickMimeType();
    try { mediaRecorder = new MediaRecorder(mediaStream, opts); }
    catch (e) { mediaRecorder = new MediaRecorder(mediaStream); }

    mediaRecorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) recordedChunks.push(ev.data);
    };
    mediaRecorder.onstop = function () {
      $("#stop-record").prop("disabled", true);
      $("#start-record").prop("disabled", false);
      $("#liveness-result").text("Mengirim ke server…");

      var blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
      var form = new FormData();
      form.append("video", blob, "liveness.webm");

      fetch("/api/liveness", { method: "POST", body: form })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          $("#liveness-result").html("Liveness score: <strong>" + (data && data.score != null ? data.score : "-") + "</strong>");
        })
        .catch(function (err) { $("#liveness-result").text("Gagal kirim: " + err.message); })
        .finally(function () {
          try {
            if (window.mediaStream && typeof window.mediaStream.getTracks === "function") {
              var tracks = window.mediaStream.getTracks();
              for (var i = 0; i < tracks.length; i++) tracks[i].stop();
            }
          } catch (e) { }
          $("#liveness-preview").prop("srcObject", null);
          window.mediaStream = mediaStream = null;
          navigate("home-page");
        });
    };
  }

  $(document).on("click", "#start-record", function () {
    if (!window.mediaStream) {
      initCamera().then(function () { setupRecorder(); startSteps(); }).catch(function () { });
    } else {
      setupRecorder(); startSteps();
    }
    function wait(ms, cb) { setTimeout(cb, ms); }
    function startSteps() {
      var instr = $("#liveness-instruction");
      var i = 3;
      function countdown() {
        if (i === 0) return startRec();
        instr.text(i); i--; wait(1000, countdown);
      }
      function startRec() {
        recordedChunks = [];
        mediaRecorder.start();
        instr.text("Buka mulut");
        wait(3000, function () {
          instr.text("Tengok kanan");
          wait(3000, function () {
            instr.text("Tengok kiri");
            wait(3000, function () {
              instr.text("Selesai");
              mediaRecorder.stop();
            });
          });
        });
      }
      countdown();
    }
  });

  // BYPASS (testing)
  var allowBypass = true;
  $("#skip-record").toggle(!!allowBypass);
  $(document).on("click", "#skip-record", function (e) {
    e.preventDefault();
    try {
      if (window.mediaStream && typeof window.mediaStream.getTracks === "function") {
        var tracks = window.mediaStream.getTracks();
        for (var i = 0; i < tracks.length; i++) tracks[i].stop();
      }
    } catch (err) { }
    $("#liveness-preview").prop("srcObject", null);
    window.mediaStream = mediaStream = null;
    try { localStorage.setItem("liveness_status", "bypass_ok"); } catch (e) { }
    try { localStorage.setItem("liveness_bypass_at", new Date().toISOString()); } catch (e) { }
    $("#liveness-result").html("✅ Liveness <em>di-bypass</em> (testing mode).");
    navigate("home-page");
  });

  /* =========================
   * 5) COUNTDOWN DEMO (opsional)
   * =======================*/
  (function startCountdown() {
    function nextTarget() {
      var now = new Date();
      var tzNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
      var target = new Date(tzNow);
      target.setDate(target.getDate() + 1);
      target.setHours(9, 0, 0, 0);
      return target;
    }
    var target = nextTarget();
    function upd() {
      var now = new Date();
      var diff = target - now;
      if (diff <= 0) { $("#countdown").text("Voting ditutup!"); return; }
      var h = String(Math.floor((diff / 36e5) % 24)); if (h.length < 2) h = "0" + h;
      var m = String(Math.floor((diff / 6e4) % 60)); if (m.length < 2) m = "0" + m;
      var s = String(Math.floor((diff / 1e3) % 60)); if (s.length < 2) s = "0" + s;
      $("#countdown").text(h + " : " + m + " : " + s);
    }
    upd(); setInterval(upd, 1000);
  })();

  /* =========================
   * 6) UTIL WAKTU & FORMAT
   * =======================*/
  function slotToLabel(s) { return SLOT_LABEL[s] || s; }
  function fmtPct(v) { return isFinite(Number(v)) ? (Number(v) * 100).toFixed(2) + "%" : "—"; }
  function fmtX(v) { return isFinite(Number(v)) ? Number(v).toFixed(2) + "x" : "—"; }
  function fmtF3(v) { return isFinite(Number(v)) ? Number(v).toFixed(3) : "—"; }

  function getNowWIB() {
    var now = new Date();
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    var parts = fmt.formatToParts(now);
    var map = {};
    for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
    return { dateYMD: map.year + "-" + map.month + "-" + map.day, hour: Number(map.hour), minute: Number(map.minute) };
  }

  function inferPayloadDateYMD(payload) {
    var meta = payload && payload.meta ? payload.meta : null;
    var cand = null;
    if (meta) cand = meta.slot_date || meta.date || meta.asof || null;
    if (!cand && payload && payload.rows && payload.rows[0]) {
      var r0 = payload.rows[0];
      cand = r0.slot_date || r0.date || r0.asof || null;
    }
    if (!cand) return null;
    var s = String(cand).slice(0, 10).replace(/\//g, "-");
    return s;
  }
  function inferPayloadTimeHHMM(payload, fallback) {
    fallback = fallback || "15:00";
    var t = (payload && payload.cutoff) ? payload.cutoff :
      (payload && payload.meta && payload.meta.time) ? payload.meta.time :
        (payload && payload.meta && payload.meta.slot_time) ? payload.meta.slot_time : "";
    t = String(t);
    return t ? t.slice(0, 5) : fallback;
  }
  function setMarkovUpdatedFromPayload(payload, fallbackTime) {
    var ymd = inferPayloadDateYMD(payload) || getNowWIB().dateYMD;
    var hhmm = inferPayloadTimeHHMM(payload, fallbackTime || "15:00");
    var $u = $("#markov-updated");
    if ($u.length) $u.text("Updated in " + ymd + " " + hhmm);
  }

  /* =========================
   * 7) NORMALISASI SCORE & WARNA BAR
   * =======================*/
  function getScoreMax(payload, rows) {
    var metaMax = (payload && payload.meta && isFinite(Number(payload.meta.score_max))) ? Number(payload.meta.score_max) : NaN;
    var calcMax = 0;
    for (var i = 0; i < rows.length; i++) calcMax = Math.max(calcMax, Number(rows[i] && rows[i].score) || 0);
    var m = (isFinite(metaMax) && metaMax > 0) ? metaMax : (calcMax > 0 ? calcMax : 200);
    return Math.max(m, 10);
  }
  function toBarPct(score, max) {
    if (!isFinite(Number(score)) || !isFinite(Number(max)) || max <= 0) return 0;
    var pct = (Number(score) / Number(max)) * 100;
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    return pct;
  }
  function toScore10(score, max) {
    if (!isFinite(Number(score)) || !isFinite(Number(max)) || max <= 0) return NaN;
    return (Number(score) / Number(max)) * 10;
  }
  function getBarColor(pct) {
    if (!isFinite(Number(pct))) return "#d0d0d0";
    var p = Number(pct);
    if (p <= 25) return "#FB8C00";   // orange 600
    if (p < 75) return "#FFC107";   // amber 500
    return "#43A047";                // green 600
  }

  /* ======================================================
 * 8) FEED 5 HARI — 1 SLOT = 1 TABEL MINI (divider per tanggal)
 * =====================================================*/
  function fetchDates() {
    return fetch(WORKER_BASE + "/api/reko/dates", { cache: "no-store" })
      .then(function (r) { if (!r.ok) return []; return r.json(); })
      .then(function (j) { return (j && j.dates && j.dates.slice) ? j.dates : []; })
      .catch(function () { return []; });
  }

  // Versi dengan parameter isMk eksplisit (untuk dual-render)
  function fetchBatchByDateVariant(date, slot, isMk) {
    var mk = isMk ? "&mk=1" : "";
    return fetch(WORKER_BASE + "/api/reko/by-date?date=" + date + "&slot=" + slot + mk, { cache: "no-store" })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .then(function (d) {
        if (!d || !d.rows || !d.rows.length) return null;
        return { date: d.date || date, slot: d.slot || slot, rows: d.rows };
      })
      .catch(function () { return null; });
  }

  function fetchBatchByDate(date, slot) {
    var mk = window.FEED_MARKOV ? "&mk=1" : "";
    return fetch(WORKER_BASE + "/api/reko/by-date?date=" + date + "&slot=" + slot + mk, { cache: "no-store" })
      .then(function (r) { if (!r.ok) return null; return r.json(); })
      .then(function (d) {
        if (!d || !d.rows || !d.rows.length) return null;
        return { date: d.date || date, slot: d.slot || slot, rows: d.rows };
      })
      .catch(function () { return null; });
  }

  function slotMinutes(slot) {
    var m = String(slot).match(/^(\d{2})(\d{2})$/);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : -1;
  }

  function fetchRecentBatches(days) {
    days = days || 5;
    return fetchDates().then(function (dates) {
      var lastN = dates.slice(-days);
      var jobs = [];
      for (var i = 0; i < lastN.length; i++) {
        for (var j = 0; j < SLOTS.length; j++) {
          jobs.push(fetchBatchByDate(lastN[i], SLOTS[j]));
        }
      }
      return Promise.all(jobs).then(function (arr) {
        var batches = [];
        for (var k = 0; k < arr.length; k++) if (arr[k]) batches.push(arr[k]);
        batches.sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;  // tanggal desc
          return slotMinutes(b.slot) - slotMinutes(a.slot);        // slot desc
        });
        return batches;
      });
    });
  }

  // ============================================================
  // RENDER: 1 blok tabel untuk 1 batch (tanggal+slot)
  // ============================================================
  // ==== GANTIKAN renderSlotTableBlock & renderFeedBySlot LAMA ====

  // — helper: deteksi & normalisasi baris Markov → schema non-MK —
  function isMarkovBatch(batch) {
    try {
      var r0 = batch && batch.rows && batch.rows[0];
      return !!(r0 && (r0["Kode Saham"] != null || r0["Skor Sistem"] != null));
    } catch (_) { return false; }
  }
  function normalizeRowsForTable(batch, isMk) {
    // output: { ticker, score, daily_return, vol_pace, price_at_cutoff/last }
    var out = [];
    var rows = (batch && batch.rows) ? batch.rows : [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (isMk) {
        out.push({
          ticker: (r["Kode Saham"] != null ? String(r["Kode Saham"]).toUpperCase() : "-"),
          score: Number(r["Skor Sistem"]),
          daily_return: Number(r["Peluang Naik ≥3% Besok Pagi"]),    // ← ganti kalau mau pakai metrik lain
          vol_pace: Number(r["Kecepatan Volume"]),
          price_at_cutoff: null,   // tidak ada padanan → tampil “—”
          last: null
        });
      } else {
        out.push({
          ticker: (r.ticker ? String(r.ticker).toUpperCase() : "-"),
          score: Number(r.score),
          daily_return: Number(r.daily_return),
          vol_pace: Number(r.vol_pace),
          price_at_cutoff: (r.price_at_cutoff != null ? Number(r.price_at_cutoff) : null),
          last: (r.last != null ? Number(r.last) : null)
        });
      }
    }
    return out;
  }

  // — formatter kecil (reuse milikmu bila sudah ada) —
  function slotToLabel(slot) { return String(slot).slice(0, 2) + ":" + String(slot).slice(2); }
  function fmtF3(n) { return (isFinite(n) ? Number(n).toFixed(3) : "—"); }
  function fmtPct(x) { return (isFinite(x) ? (x * 100).toFixed(2) + "%" : "—"); }
  function fmtX(x) { return (isFinite(x) ? Number(x).toFixed(2) + "x" : "—"); }

  // ============== REPLACEMENT 1 ==============
  function renderSlotTableBlock(batch, isMk /*optional: akan di-auto deteksi*/) {
    // auto-detect jika flag tidak disuplai
    if (typeof isMk === "undefined") isMk = isMarkovBatch(batch);

    var date = batch && batch.date ? batch.date : "";
    var slot = batch && batch.slot ? batch.slot : "";
    var rowsNorm = normalizeRowsForTable(batch, isMk);
    var idx = 1;

    var trs = rowsNorm.map(function (r) {
      var retHTML = isFinite(r.daily_return)
        ? `<span class="${r.daily_return >= 0 ? "reko-pos" : "reko-neg"}">${fmtPct(r.daily_return)}</span>`
        : "—";
      var cutSrc = (r.price_at_cutoff != null) ? r.price_at_cutoff : (r.last != null ? r.last : null);
      var cut = Number(cutSrc);
      return `
      <tr>
        <td class="text-muted">${idx++}</td>
        <td><strong>${r.ticker || "-"}</strong></td>
        <td class="text-end">${fmtF3(r.score)}</td>
        <td class="text-end">${retHTML}</td>
        <td class="text-end">${fmtX(r.vol_pace)}</td>
        <td class="text-end">${isFinite(cut) ? cut.toLocaleString("id-ID") : "—"}</td>
      </tr>`;
    }).join("");

    var markBadge = isMk
      ? `<span class="badge" style="background:#6f42c1;color:#fff">MARKOV</span>`
      : `<span class="badge text-dark">NON-MARKOV</span>`;

    return `
    <div class="reko-block my-4">
      <div class="d-flex align-items-center gap-2 mb-2">
        <span class="d-block badge text-dark" style="background:#cef4ff">${date}</span>
        <span class="d-block badge text-dark">Slot ${slotToLabel(slot)}</span>
        <span class="d-block text-muted small">• ${rowsNorm.length} entri</span>
        ${markBadge}
      </div>
      <table class="table table-sm reko-subtable">
        <thead style="background-color:#ddd">
          <tr>
            <th style="width:44px">#</th>
            <th>Ticker</th>
            <th class="text-end">Score</th>
            <th class="text-end">Return</th>
            <th class="text-end">Pace</th>
            <th class="text-end">Buy Below</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
  }

  // helper sort slot (desc)
  function _slotMinutes(slot) {
    var m = String(slot || "").match(/^(\d{2})(\d{2})$/);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : -1;
  }

  // ============== REPLACEMENT 2 ==============
  function renderFeedBySlot(batches /*campur MK & non-MK*/) {
    // ekspektasi: array batches berisi kombinasi hasil fetch MK & NON dengan pasangan (date,slot)
    // kita group per tanggal, lalu per slot, render MARKOV → NON-MARKOV

    var $thead = $("#reko-thead"), $tbody = $("#reko-tbody");
    $thead.empty(); $tbody.empty();

    if (!batches || !batches.length) {
      $("#reko-meta").text("Tidak ada data.");
      $tbody.html('<tr><td><div class="text-center text-muted py-3">Tidak ada data.</div></td></tr>');
      $("#reko-slot-badge").text("Feed");
      return;
    }

    // 1) group by date
    var byDate = {};
    for (var i = 0; i < batches.length; i++) {
      var b = batches[i];
      if (!b || !b.date) continue;
      (byDate[b.date] = byDate[b.date] || []).push(b);
    }

    // 2) urutkan tanggal desc
    var dates = Object.keys(byDate).sort(function (a, b) { return a < b ? 1 : -1; });

    // 3) build HTML: per tanggal → urut slot desc → MK lalu NON
    var html = "", prevDate = null;
    for (var di = 0; di < dates.length; di++) {
      var d = dates[di];
      var list = byDate[d].slice();

      // group per slot
      var bySlot = {};
      for (var k = 0; k < list.length; k++) {
        var it = list[k];
        (bySlot[it.slot] = bySlot[it.slot] || []).push(it);
      }

      // slot desc
      var slots = Object.keys(bySlot).sort(function (a, b) {
        return _slotMinutes(b) - _slotMinutes(a);
      });

      // garis EOD antar tanggal (skip di awal)
      if (prevDate && prevDate !== d) {
        html += ''
          + '<tr><td style="position:relative">'
          + '<hr class="my-3 reko-hr">'
          + '<div class="d-flex justify-content-center align-items-center"'
          + ' style="position:absolute;left:0;top:0;right:0;bottom:0">'
          + '<small class="p-2" style="background:#fff">EOD of ' + prevDate + '</small>'
          + '</div>'
          + '</td></tr>';
      }
      prevDate = d;

      // render tiap slot: MK lalu NON (kalau ada salah satunya saja, tampil yang ada)
      for (var si = 0; si < slots.length; si++) {
        var s = slots[si];
        var arr = bySlot[s];

        // pisah MK / NON
        var mk = arr.find(function (x) { return isMarkovBatch(x); });
        var non = arr.find(function (x) { return !isMarkovBatch(x); });

        if (mk) {
          html += '<tr><td>' + renderSlotTableBlock(mk, true) + '</td></tr>';
        }
        if (non) {
          html += '<tr><td>' + renderSlotTableBlock(non, false) + '</td></tr>';
        }
      }
    }

    $tbody.html(html);

    // meta kecil di header
    var newest = dates[0], oldest = dates[dates.length - 1];
    $("#reko-meta").text('Feed 5 hari terakhir • ' + oldest + ' → ' + newest);
    $("#reko-slot-badge").text('Feed (MK + Non-MK)');
  }


  function loadRekoFeed5dPerSlot() {
    $("#reko-tbody").html('<tr><td><div class="reko-shimmer"></div></td></tr>');
    $("#reko-meta").text("Memuat…");
    $("#reko-slot-badge").text("…");
    fetchRecentBatches(5)
      .then(function (batches) { renderFeedBySlot(batches); })
      .catch(function (e) {
        console.error("[reko-feed-per-slot] load error:", e);
        $("#reko-meta").text("Gagal memuat.");
        $("#reko-thead").empty();
        $("#reko-tbody").html('<tr><td><div class="text-danger">Error: ' + (e && e.message ? e.message : e) + '</div></td></tr>');
      });
  };





  // === DUMP START (drop-in inside an existing function) ===
  var NUM_DATES = 3;                              // berapa tanggal terbaru
  var DUMP_SLOTS = ["0930", "1415", "1550"];        // slot yang mau ditampilkan
  var MK_PARAM = "mk=1";                          // param untuk markov
  var dump = document.getElementById("dump-wrap");
  if (!dump) { /* container ga ada, skip */ } else {
    dump.innerHTML = ""; // bersihkan

    function labelSlot(s) { return String(s).slice(0, 2) + ":" + String(s).slice(2); }
    function looksMkShape(j) {
      return j && j.rows && j.rows.length &&
        (j.rows[0]["Kode Saham"] != null ||
          j.rows[0]["Skor Sistem"] != null ||
          j.rows[0]["Peluang Bertahan sampai Tutup"] != null);
    }
    function addDateHeader(dateStr) {
      var dd = (String(dateStr).match(/^\d{4}-\d{2}-(\d{2})$/) || [, '??'])[1];
      var div = document.createElement("div");
      div.style.cssText = "font-weight:700;margin:8px 0 6px";
      div.textContent = "• tgl " + dd + "  (" + dateStr + ")";
      dump.appendChild(div);
    }
    function addBlock(mark, label, json) {
      var pre = document.createElement("pre");
      pre.style.cssText = "background:#fff;border:1px solid #ddd;padding:8px;margin:0 0 10px;white-space:pre-wrap;word-break:break-word;overflow:visible";
      var badge = mark === "MK" ? "[MARKOV]" : "[NON-MARKOV]";
      var warn = "";
      if (mark === "MK" && json && json.rows && json.rows.length && !looksMkShape(json)) warn = "  ⚠ server returned NON-MK schema";
      if (mark === "NON" && json && json.rows && json.rows.length && looksMkShape(json)) warn = "  ⚠ looks like MK schema";
      pre.textContent = badge + " " + label + warn + "\n" + JSON.stringify(json, null, 2);
      dump.appendChild(pre);
    }

    // Ambil daftar tanggal
    fetch(WORKER_BASE + "/api/reko/dates", { cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.dates) ? j.dates : []; })
      .then(function (dates) {
        if (!dates.length) {
          dump.textContent = "Tidak ada tanggal dari /api/reko/dates";
          return;
        }
        var wanted = dates.slice(0, NUM_DATES);

        // Rantai promise agar urutan output rapi: per tanggal → per slot → MK & NON
        var seq = Promise.resolve();
        for (var i = 0; i < wanted.length; i++) {
          (function (date) {
            seq = seq.then(function () {
              addDateHeader(date);

              var inner = Promise.resolve();
              for (var s = 0; s < DUMP_SLOTS.length; s++) {
                (function (slot) {
                  inner = inner.then(function () {
                    var urlMk = WORKER_BASE + "/api/reko/by-date?date=" + date + "&slot=" + slot + "&" + MK_PARAM;
                    var urlNon = WORKER_BASE + "/api/reko/by-date?date=" + date + "&slot=" + slot;
                    return Promise.all([
                      // … semua fetch MK / NON untuk beberapa tanggal & slot …
                    ]).then(function (results) {
                      var batches = results.filter(Boolean); // hasil campur MK & NON
                      renderFeedBySlot(batches);             // ← ini yang baru
                    });
                  });
                })(DUMP_SLOTS[s]);
              }
              return inner;
            });
          })(wanted[i]);
        }
        return seq;
      })
      .catch(function (err) {
        try { console.error("[dump]", err); } catch (_) { }
        dump.textContent = "Gagal memuat dump.";
      });
  }
  // === DUMP END ===






  /* =========================
   * 9) TOP PICKS (Summary → fallback latest-any)
   * =======================*/
  function loadTop3FromKV(limit, opt) {
    limit = limit || 9;
    opt = opt || { dimStale: true };
    var $wrap = $("#top-picks"); if (!$wrap.length) return;

    function applyStaleClass(payload) {
      var now = getNowWIB();
      var ymd = inferPayloadDateYMD(payload);
      var isStale = (opt.dimStale && ymd && ymd !== now.dateYMD && now.hour < 15);
      $wrap.toggleClass("is-stale", !!isStale);
    }

    // SUMMARY card
    function buildCardSummary(it, scoreMax) {
      var tkr = String(it && it.ticker ? it.ticker : "-").toUpperCase();
      var raw = Number(it && it.score != null ? it.score : NaN);
      var barPct = toBarPct(raw, scoreMax);
      var score10 = toScore10(raw, scoreMax);
      var barClr = getBarColor(barPct);

      var bullets = [];
      if (isFinite(Number(it && it.p_close))) bullets.push("Bertahan sampai tutup <b>" + (Number(it.p_close) * 100).toFixed(1) + "%</b>");
      if (isFinite(Number(it && it.p_am))) bullets.push("Naik ≥3% besok pagi <b>" + (Number(it.p_am) * 100).toFixed(1) + "%</b>");
      if (isFinite(Number(it && it.p_next))) bullets.push("Lanjut naik lusa <b>" + (Number(it.p_next) * 100).toFixed(1) + "%</b>");
      if (isFinite(Number(it && it.p_chain))) bullets.push("Total berantai <b>" + (Number(it.p_chain) * 100).toFixed(1) + "%</b>");
      var bulletsHtml = "";
      for (var i = 0; i < bullets.length; i++) bulletsHtml += "<li>" + bullets[i] + "</li>";

      return ''
        + '<div class="pick-card">'
        + '<div class="pick-head">'
        + '<span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>'
        + '<h4 class="pick-ticker">' + tkr + '</h4>'
        + '</div>'
        + '<div class="pick-score">Score: <b>' + (isFinite(score10) ? score10.toFixed(1) : "—") + '</b> / 10</div>'
        + '<div class="score-rail"><div class="score-fill" style="width:' + barPct + '%;background:' + barClr + '"></div></div>'
        + '<ul class="pick-bullets">'
        + '<li><strong>' + (it && it.rekom ? it.rekom : "-") + '</strong></li>'
        + bulletsHtml
        + '</ul>'
        + '<button class="d-none btn btn-primary pick-cta">VOTE SAHAM INI</button>'
        + '</div>';
    }

    // latest-any card
    function buildCardFallback(it, scoreMax) {
      var tkr = String((it && it.ticker) ? it.ticker : "-").toUpperCase();
      var raw = Number((it && it.score != null) ? it.score : NaN);
      var barPct = toBarPct(raw, scoreMax);
      var score10 = toScore10(raw, scoreMax);
      var barClr = getBarColor(barPct);

      var ret = Number(it && it.daily_return);
      var pace = Number(it && it.vol_pace);
      var csSrc = (it && it.closing_strength != null) ? it.closing_strength : (it ? it.cs : null);
      var cs = Number(csSrc);

      var bullets = [];
      if (isFinite(ret)) bullets.push(`Return Hari Ini <b>${(ret * 100).toFixed(1)}%</b>`);
      if (isFinite(pace)) bullets.push(`Volume pace <b>${pace.toFixed(0)}x</b> rata-rata`);
      if (isFinite(cs)) bullets.push(`Closing strength <b>${(cs * 100).toFixed(1)}%</b>`);
      var bulletsHtml = bullets.length ? bullets.map(function (b) { return `<li>${b}</li>`; }).join("") : "<li>-</li>";

      return `
    <div class="pick-card">
      <div class="pick-head">
        <span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>
        <h4 class="pick-ticker">${tkr}</h4>
      </div>
      <div class="pick-score">Score: <b>${isFinite(score10) ? score10.toFixed(1) : "—"}</b> / 10</div>
      <div class="score-rail"><div class="score-fill" style="width:${barPct}%;background:${barClr}"></div></div>
      <ul class="pick-bullets">${bulletsHtml}</ul>
      <button class="btn btn-primary pick-cta">VOTE SAHAM INI</button>
    </div>`;
    }


    // 1) Summary (utama)
    fetch(WORKER_BASE + "/api/reko/latest-summary", { cache: "no-store" })
      .then(function (rs) {
        if (!rs.ok) throw new Error("no-summary");
        return rs.json();
      })
      .then(function (sum) {
        setMarkovUpdatedFromPayload(sum);
        applyStaleClass(sum);
        var rows = (sum && sum.rows && sum.rows.slice) ? sum.rows.slice() : [];
        rows.sort(function (a, b) { return (Number(b.score) || 0) - (Number(a.score) || 0); });
        var scoreMax = getScoreMax(sum, rows);
        rows = rows.slice(0, limit);
        if (!rows.length) throw new Error("empty-summary");
        var html = '';
        for (var i = 0; i < rows.length; i++) html += buildCardSummary(rows[i], scoreMax);
        $("#top-picks").html(html);
      })
      .catch(function () {
        // 2) Fallback: latest-any (non-Markov)
        fetch(WORKER_BASE + "/api/reko/latest-any", { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
          .then(function (data) {
            setMarkovUpdatedFromPayload(data);
            applyStaleClass(data);
            var rows = (data && data.rows && data.rows.slice) ? data.rows.slice() : [];
            rows.sort(function (a, b) { return (Number(b.score) || 0) - (Number(a.score) || 0); });
            var scoreMax = getScoreMax(data, rows);
            rows = rows.slice(0, limit);
            var html = '';
            for (var i = 0; i < rows.length; i++) html += buildCardFallback(rows[i], scoreMax);
            $("#top-picks").html(html);
          })
          .catch(function (e) {
            console.error("[top-picks] load error:", e);
            $("#top-picks").empty();
          });
      });
  }

  /* =========================
   * 10) TRIGGER & AUTO-REFRESH
   * =======================*/
  function triggerIfHome() {
    if (location.hash.slice(1) === "home-page") {
      loadRekoFeed5dPerSlot();
      loadTop3FromKV(9, { dimStale: true }); // tampilkan 9 kartu (3×3)
    }
  }

  // Splash login → home
  $(document).on("submit", "#splash-page #login-form", function (e) {
    e.preventDefault();
    navigate("home-page");
    setTimeout(function () { setTimeout(triggerIfHome, 0); }, 0);
  });

  // Register → liveness
  $(document).on("submit", "#register-form", function (e) {
    e.preventDefault();
    navigate("liveness-check");
  });

  // Initial trigger bila sudah di home saat load
  if (location.hash.slice(1) === "home-page") {
    setTimeout(triggerIfHome, 0);
  }

  // (opsional) kalau ada dropdown slot → panggil feed yang sama
  $(document).on("change", "#reko-slot-select", function () { loadRekoFeed5dPerSlot(); });

  // Auto-refresh tiap 60 detik (hanya saat di home)
  setInterval(function () {
    if (location.hash.slice(1) === "home-page") triggerIfHome();
  }, 60000);

  /* =========================
   * 11) Resize About Us iframe (opsional)
   * =======================*/
  var aboutUsEmbed = document.getElementById("about-us-embed");
  function resizeAboutEmbed() {
    if (!aboutUsEmbed) return;
    try {
      var h = aboutUsEmbed.contentWindow.document.body.scrollHeight;
      aboutUsEmbed.style.height = (h + 35) + "px";
    } catch (e) { /* ignore cross-origin errors */ }
  }
  if (aboutUsEmbed) {
    aboutUsEmbed.addEventListener("load", resizeAboutEmbed);
    window.addEventListener("resize", resizeAboutEmbed);
  }

  /* =========================
   * 12) NOTIF DEMO (opsional)
   * =======================*/
  function showNotif(text) {
    var container = document.getElementById("notif-container");
    if (!container) return;
    var el = document.createElement("div");
    el.className = "notif";
    el.textContent = text;
    container.appendChild(el);
    if (container.children.length > 5) container.removeChild(container.firstElementChild);
    setTimeout(function () { if (container.contains(el)) container.removeChild(el); }, 9000);
  }
  setInterval(function () {
    var phone = "08" + Math.floor(10000000 + Math.random() * 90000000);
    var stocks = ["BRPT", "BREN", "CUAN", "TLKM"];
    var stock = stocks[Math.floor(Math.random() * stocks.length)];
    showNotif(phone + " vote " + stock);
  }, 3000);
})();
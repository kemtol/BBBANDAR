/* =========================================================
 * Quant App – Frontend Script (FINAL)
 * Data source: Cloudflare Worker (KV)
 * - Top Picks: /api/reko/latest-summary → fallback /api/reko/latest-any
 * - Feed: 5 hari terakhir (per slot = satu tabel mini, dibagi per TANGGAL)
 * UX notes:
 * - #markov-updated (di bawah judul) akan diisi: "Updated in YYYY-MM-DD HH:MM"
 * - #top-picks diberi class .is-stale (diredupkan) jika payload = hari kemarin & sekarang < 15:00 WIB
 * =======================================================*/

$(function () {
  /* =========================
   * 1) KONFIGURASI
   * =======================*/
  const WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev";
  const SLOT_LABEL = { "0930": "09:30", "1130": "11:30", "1415": "14:15", "1550": "15:50" };
  const SLOTS = Object.keys(SLOT_LABEL);

  /* =========================
   * 2) STATE (kamera / liveness)
   * =======================*/
  let mediaStream = null, mediaRecorder = null, recordedChunks = [];
  window.mediaStream = null; // agar mudah diinspeksi

  /* =========================
   * 3) NAVIGASI & HISTORY
   * =======================*/
  function showPageNoHistory(id) {
    $("section").hide();
    $("#" + id).fadeIn();
  }
  function navigate(id) {
    if (location.hash !== "#" + id) {
      location.hash = id; // diproses di 'hashchange'
    } else {
      showPageNoHistory(id);
      triggerIfHome();
    }
  }
  window.navigate = navigate;

  $(window).on("hashchange", function () {
    const page = location.hash.slice(1);

    // Stop kamera saat keluar dari liveness
    if (page !== "liveness-check") {
      try {
        window.mediaStream?.getTracks?.().forEach((t) => t.stop());
        $("#liveness-preview").prop("srcObject", null);
        window.mediaStream = mediaStream = null;
      } catch {}
    }

    if ($("#" + page).length) showPageNoHistory(page);
    triggerIfHome();
  });

  // Inisialisasi halaman pertama
  const first = location.hash.slice(1);
  if (first && $("#" + first).length) {
    showPageNoHistory(first);
  } else {
    navigate("splash-page");
  }

  /* =========================
   * 4) LIVENESS CHECK (opsional)
   * =======================*/
  async function initCamera() {
    const isLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
    if (location.protocol !== "https:" && !isLocalhost) {
      $("#liveness-result").html("Harus diakses via <b>HTTPS</b> atau <b>localhost</b>.");
      throw new Error("insecure_context");
    }
    const tries = [
      { video: { facingMode: { ideal: "user" } }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr;
    for (const c of tries) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(c);
        window.mediaStream = mediaStream;
        $("#liveness-preview")[0].srcObject = mediaStream;
        return;
      } catch (e) { lastErr = e; }
    }
    let hint = "";
    if (lastErr?.name === "NotAllowedError") hint = "Izin ditolak. Klik ikon gembok → Allow camera.";
    else if (lastErr?.name === "NotFoundError") hint = "Kamera tidak terdeteksi.";
    else if (lastErr?.name === "NotReadableError") hint = "Kamera sedang dipakai aplikasi lain.";
    else if (lastErr?.name === "OverconstrainedError") hint = "Constraint kamera terlalu ketat.";
    $("#liveness-result").text(`Gagal akses kamera: ${lastErr?.name || "Error"}${hint ? " — " + hint : ""}`);
    throw lastErr;
  }
  function pickMimeType() {
    const cand = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    if (window.MediaRecorder?.isTypeSupported) {
      for (const t of cand) if (MediaRecorder.isTypeSupported(t)) return { mimeType: t };
    }
    return {};
  }
  function setupRecorder() {
    recordedChunks = [];
    const opts = pickMimeType();
    try { mediaRecorder = new MediaRecorder(mediaStream, opts); }
    catch { mediaRecorder = new MediaRecorder(mediaStream); }

    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async function () {
      $("#stop-record").prop("disabled", true);
      $("#start-record").prop("disabled", false);
      $("#liveness-result").text("Mengirim ke server…");

      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" });
      const form = new FormData();
      form.append("video", blob, "liveness.webm");

      try {
        const res = await fetch("/api/liveness", { method: "POST", body: form });
        const data = await res.json();
        $("#liveness-result").html(`Liveness score: <strong>${data.score ?? "-"}</strong>`);
      } catch (err) {
        $("#liveness-result").text("Gagal kirim: " + err.message);
      } finally {
        try { window.mediaStream?.getTracks?.().forEach((t) => t.stop()); } catch {}
        $("#liveness-preview").prop("srcObject", null);
        window.mediaStream = mediaStream = null;
      }
      navigate("home-page");
    };
  }
  $(document).on("click", "#start-record", async function () {
    try {
      if (!window.mediaStream) await initCamera();
      setupRecorder();
    } catch { return; }

    const instr = $("#liveness-instruction");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 3; i >= 1; i--) { instr.text(i); await wait(1000); }

    recordedChunks = [];
    mediaRecorder.start();

    instr.text("Buka mulut"); await wait(3000);
    instr.text("Tengok kanan"); await wait(3000);
    instr.text("Tengok kiri"); await wait(3000);

    instr.text("Selesai");
    mediaRecorder.stop();
  });

  // BYPASS (testing)
  const allowBypass = true;
  $("#skip-record").toggle(!!allowBypass);
  $(document).on("click", "#skip-record", function (e) {
    e.preventDefault();
    try { window.mediaStream?.getTracks?.().forEach((t) => t.stop()); } catch {}
    $("#liveness-preview").prop("srcObject", null);
    window.mediaStream = mediaStream = null;
    localStorage.setItem("liveness_status", "bypass_ok");
    localStorage.setItem("liveness_bypass_at", new Date().toISOString());
    $("#liveness-result").html("✅ Liveness <em>di-bypass</em> (testing mode).");
    navigate("home-page");
  });

  /* =========================
   * 5) COUNTDOWN DEMO (opsional)
   * =======================*/
  (function startCountdown() {
    function nextTarget() {
      const now = new Date();
      const tzNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
      const target = new Date(tzNow);
      target.setDate(target.getDate() + 1);
      target.setHours(9, 0, 0, 0);
      return target;
    }
    const target = nextTarget();
    function upd() {
      const now = new Date();
      const diff = target - now;
      if (diff <= 0) return $("#countdown").text("Voting ditutup!");
      const h = String(Math.floor((diff / 36e5) % 24)).padStart(2, "0");
      const m = String(Math.floor((diff / 6e4) % 60)).padStart(2, "0");
      const s = String(Math.floor((diff / 1e3) % 60)).padStart(2, "0");
      $("#countdown").text(`${h} : ${m} : ${s}`);
    }
    upd(); setInterval(upd, 1000);
  })();

  /* =========================
   * 6) UTIL WAKTU & FORMAT
   * =======================*/
  const slotToLabel = (s) => SLOT_LABEL[s] || s;
  const fmtPct  = (v) => Number.isFinite(+v) ? ((+v) * 100).toFixed(2) + "%" : "—";
  const fmtX    = (v) => Number.isFinite(+v) ? (+v).toFixed(2) + "x" : "—";
  const fmtF3   = (v) => Number.isFinite(+v) ? (+v).toFixed(3) : "—";

  function getNowWIB() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
    return { dateYMD: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
  }
  function inferPayloadDateYMD(payload) {
    const meta = payload?.meta || payload;
    const cand = meta?.slot_date || meta?.date || meta?.asof
      || payload?.rows?.[0]?.slot_date || payload?.rows?.[0]?.date || payload?.rows?.[0]?.asof;
    return cand ? String(cand).slice(0, 10).replaceAll('/', '-') : null;
  }
  function setMarkovUpdatedFromPayload(payload, fallbackTime = "15:00") {
    const ymd = inferPayloadDateYMD(payload) || getNowWIB().dateYMD;
    const slotTime = payload?.meta?.slot_time || payload?.meta?.time || fallbackTime;
    const $u = $("#markov-updated");
    if ($u.length) $u.text(`Updated in ${ymd} ${slotTime}`);
  }

  /* =========================
   * 7) NORMALISASI SCORE & WARNA BAR
   * =======================*/
  function getScoreMax(payload, rows) {
    const metaMax = Number(payload?.meta?.score_max);
    const calcMax = Math.max(0, ...rows.map(r => Number(r?.score) || 0));
    const m = Number.isFinite(metaMax) && metaMax > 0 ? metaMax : (calcMax > 0 ? calcMax : 200);
    return Math.max(m, 10); // jaga jangan terlalu kecil
  }
  function toBarPct(score, max) {
    if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return 0;
    return Math.max(0, Math.min(100, (score / max) * 100));
  }
  function toScore10(score, max) {
    if (!Number.isFinite(score) || !Number.isFinite(max) || max <= 0) return NaN;
    return (score / max) * 10;
  }
  // Pewarnaan diskret: ≤25% oranye, 25–75% kuning, ≥75% hijau
  function getBarColor(pct) {
    if (!Number.isFinite(pct)) return "#d0d0d0";
    if (pct <= 25) return "#FB8C00";   // orange 600
    if (pct <  75) return "#FFC107";   // amber 500
    return "#43A047";                  // green 600
  }

  /* ======================================================
   * 8) FEED 5 HARI — 1 SLOT = 1 TABEL MINI (divider per tanggal)
   * =====================================================*/
  async function fetchDates() {
    try {
      const r = await fetch(`${WORKER_BASE}/api/reko/dates`, { cache: "no-store" });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.dates) ? j.dates : [];
    } catch { return []; }
  }
  async function fetchBatchByDate(date, slot) {
    try {
      const r = await fetch(`${WORKER_BASE}/api/reko/by-date?date=${date}&slot=${slot}`, { cache: "no-store" });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d?.rows?.length) return null;
      return { date: d.date || date, slot: d.slot || slot, rows: d.rows };
    } catch { return null; }
  }
  function slotMinutes(slot) {
    const m = String(slot).match(/^(\d{2})(\d{2})$/);
    return m ? (+m[1]) * 60 + (+m[2]) : -1;
  }
  async function fetchRecentBatches(days = 5) {
    const dates = await fetchDates();
    const lastN = dates.slice(-days);
    const jobs = [];
    for (const d of lastN) for (const s of SLOTS) jobs.push(fetchBatchByDate(d, s));
    const batches = (await Promise.all(jobs)).filter(Boolean);
    batches.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;  // tanggal desc
      return slotMinutes(b.slot) - slotMinutes(a.slot);        // slot desc
    });
    return batches;
  }
  function renderSlotTableBlock(batch) {
    const { date, slot, rows } = batch; let idx = 1;
    const trs = rows.map(r => {
      const ret = +r.daily_return, pace = +r.vol_pace, scr = +r.score, cut = +(r.price_at_cutoff ?? r.last);
      const retHTML = Number.isFinite(ret)
        ? `<span class="${ret >= 0 ? "reko-pos" : "reko-neg"}">${fmtPct(ret)}</span>` : "—";
      return `<tr>
          <td class="text-muted">${idx++}</td>
          <td><strong>${r.ticker || "-"}</strong></td>
          <td class="text-end">${fmtF3(scr)}</td>
          <td class="text-end">${retHTML}</td>
          <td class="text-end">${fmtX(pace)}</td>
          <td class="text-end">${Number.isFinite(cut) ? cut.toLocaleString("id-ID") : "—"}</td>
        </tr>`;
    }).join("");
    return `
      <div class="reko-block my-4">
        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="d-block badge text-dark" style="background:#cef4ff">${date}</span>
          <span class="d-block badge text-dark">Slot ${slotToLabel(slot)}</span>
          <span class="d-block text-muted small">• ${rows.length} entri</span>
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
  function renderFeedBySlot(batches) {
    const $thead = $("#reko-thead"), $tbody = $("#reko-tbody");
    $thead.empty(); $tbody.empty();

    if (!batches.length) {
      $("#reko-meta").text("Tidak ada data.");
      $tbody.html(`<tr><td><div class="text-center text-muted py-3">Tidak ada data.</div></td></tr>`);
      $("#reko-slot-badge").text("Feed");
      return;
    }

    let html = "", prevDate = null;
    for (const b of batches) {
      if (prevDate && prevDate !== b.date) {
        html += `<tr><td style="position:relative"><hr class="my-3 reko-hr"><div class="d-flex justify-content-center align-items-center" style="position:absolute;left:0px;top:0;right:0;bottom:0"><small class="p-2" style="background:#fff">EOD of ${prevDate}</small></div></td></tr>`;
      }
      prevDate = b.date;
      html += `<tr><td>${renderSlotTableBlock(b)}</td></tr>`;
    }
    $tbody.html(html);

    const newest = batches[0], oldest = batches[batches.length - 1];
    $("#reko-meta").text(`Feed 5 hari terakhir • ${oldest.date} → ${newest.date}`);
    $("#reko-slot-badge").text("Feed");
  }
  async function loadRekoFeed5dPerSlot() {
    $("#reko-tbody").html(`<tr><td><div class="reko-shimmer"></div></td></tr>`);
    $("#reko-meta").text("Memuat…");
    $("#reko-slot-badge").text("…");
    try {
      const batches = await fetchRecentBatches(5);
      renderFeedBySlot(batches);
    } catch (e) {
      console.error("[reko-feed-per-slot] load error:", e);
      $("#reko-meta").text("Gagal memuat.");
      $("#reko-thead").empty();
      $("#reko-tbody").html(`<tr><td><div class="text-danger">Error: ${e?.message || e}</div></td></tr>`);
    }
  }

  /* =========================
   * 9) TOP PICKS (Markov summary → fallback latest-any)
   * =======================*/
  async function loadTop3FromKV(limit = 9, { dimStale = true } = {}) {
    const $wrap = $("#top-picks"); if (!$wrap.length) return;

    // Redupkan kartu jika payload ≠ hari ini & sekarang < 15:00 WIB
    const applyStaleClass = (payload) => {
      const now = getNowWIB();
      const ymd = inferPayloadDateYMD(payload);
      const isStale = dimStale && ymd && ymd !== now.dateYMD && now.hour < 15;
      $wrap.toggleClass("is-stale", !!isStale);
    };

    // Builder kartu — SUMMARY (probability)
    const buildCardSummary = (it, scoreMax) => {
      const tkr = String(it.ticker || "-").toUpperCase();
      const raw = Number(it.score);
      const barPct  = toBarPct(raw, scoreMax);
      const score10 = toScore10(raw, scoreMax);
      const barClr  = getBarColor(barPct);
      const bullets = [];
      if (Number.isFinite(+it.p_close)) bullets.push(`Bertahan sampai tutup <b>${(+it.p_close * 100).toFixed(1)}%</b>`);
      if (Number.isFinite(+it.p_am))    bullets.push(`Naik ≥3% besok pagi <b>${(+it.p_am * 100).toFixed(1)}%</b>`);
      if (Number.isFinite(+it.p_next))  bullets.push(`Lanjut naik lusa <b>${(+it.p_next * 100).toFixed(1)}%</b>`);
      if (Number.isFinite(+it.p_chain)) bullets.push(`Total berantai <b>${(+it.p_chain * 100).toFixed(1)}%</b>`);
      return `
        <div class="pick-card">
          <div class="pick-head">
            <span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>
            <h4 class="pick-ticker">${tkr}</h4>
          </div>
          <div class="pick-score">Score: <b>${Number.isFinite(score10) ? score10.toFixed(1) : "—"}</b> / 10</div>
          <div class="score-rail"><div class="score-fill" style="width:${barPct}%;background:${barClr}"></div></div>
          <ul class="pick-bullets">
            <li><strong>${it.rekom || "-"}</strong></li>
            ${bullets.map(b => `<li>${b}</li>`).join("")}
          </ul>
          <button class="d-none btn btn-primary pick-cta">VOTE SAHAM INI</button>
        </div>`;
    };

    // Builder kartu — FALLBACK (statistik)
    const buildCardFallback = (it, scoreMax) => {
      const tkr = String(it.ticker || "-").toUpperCase();
      const raw = Number(it.score);
      const barPct  = toBarPct(raw, scoreMax);
      const score10 = toScore10(raw, scoreMax);
      const barClr  = getBarColor(barPct);
      const ret = Number(it.daily_return), pace = Number(it.vol_pace), cs = Number(it.closing_strength ?? it.cs);
      const bullets = [];
      if (Number.isFinite(ret))  bullets.push(`Return Hari Ini <b>${(ret * 100).toFixed(1)}%</b>`);
      if (Number.isFinite(pace)) bullets.push(`Volume pace <b>${pace.toFixed(0)}x</b> rata-rata`);
      if (Number.isFinite(cs))   bullets.push(`Closing strength <b>${(cs * 100).toFixed(1)}%</b>`);
      return `
        <div class="pick-card">
          <div class="pick-head">
            <span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>
            <h4 class="pick-ticker">${tkr}</h4>
          </div>
          <div class="pick-score">Score: <b>${Number.isFinite(score10) ? score10.toFixed(1) : "—"}</b> / 10</div>
          <div class="score-rail"><div class="score-fill" style="width:${barPct}%;background:${barClr}"></div></div>
          <ul class="pick-bullets">${bullets.length ? bullets.map(b => `<li>${b}</li>`).join("") : "<li>-</li>"}</ul>
          <button class="btn btn-primary pick-cta">VOTE SAHAM INI</button>
        </div>`;
    };

    // 1) Summary (utama)
    try {
      const rs = await fetch(`${WORKER_BASE}/api/reko/latest-summary`, { cache: "no-store" });
      if (rs.ok) {
        const sum = await rs.json();
        setMarkovUpdatedFromPayload(sum);
        applyStaleClass(sum);

        let rows = Array.isArray(sum?.rows) ? sum.rows.slice() : [];
        rows.sort((a,b)=> (Number(b.score)||0) - (Number(a.score)||0));
        const scoreMax = getScoreMax(sum, rows);
        rows = rows.slice(0, limit);

        if (!rows.length) throw new Error("Empty summary rows");
        $("#top-picks").html(rows.map(r => buildCardSummary(r, scoreMax)).join(""));
        return;
      }
    } catch (e) {
      console.warn("[top-picks] summary fallback:", e);
    }

    // 2) Fallback: latest-any
    try {
      const r = await fetch(`${WORKER_BASE}/api/reko/latest-any`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setMarkovUpdatedFromPayload(data);
      applyStaleClass(data);

      let rows = Array.isArray(data?.rows) ? data.rows.slice() : [];
      rows.sort((a,b)=> (Number(b.score)||0) - (Number(a.score)||0));
      const scoreMax = getScoreMax(data, rows);
      rows = rows.slice(0, limit);

      $("#top-picks").html(rows.map(r => buildCardFallback(r, scoreMax)).join(""));
    } catch (e) {
      console.error("[top-picks] load error:", e);
      $("#top-picks").empty();
    }
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
    requestAnimationFrame(() => requestAnimationFrame(triggerIfHome));
  });

  // Register → liveness
  $(document).on("submit", "#register-form", function (e) {
    e.preventDefault();
    navigate("liveness-check");
  });

  // Initial trigger bila sudah di home saat load
  if (location.hash.slice(1) === "home-page") {
    requestAnimationFrame(triggerIfHome);
  }

  // (opsional) kalau ada dropdown slot → panggil feed yang sama
  $(document).on("change", "#reko-slot-select", function () { loadRekoFeed5dPerSlot(); });

  // Auto-refresh tiap 60 detik (hanya saat di home)
  setInterval(function () {
    if (location.hash.slice(1) === "home-page") triggerIfHome();
  }, 3600000);


  // Resize About Us iframe to match its content
  const aboutUsEmbed = document.getElementById("about-us-embed");
  function resizeAboutEmbed() {
    if (!aboutUsEmbed) return;
    try {
      aboutUsEmbed.style.height =
        aboutUsEmbed.contentWindow.document.body.scrollHeight + 35 + "px";
    } catch (e) {
      /* ignore cross-origin errors */
    }
  }
  if (aboutUsEmbed) {
    aboutUsEmbed.addEventListener("load", resizeAboutEmbed);
    window.addEventListener("resize", resizeAboutEmbed);
  }

  /* =========================
   * 11) NOTIF DEMO (opsional)
   * =======================*/
  function showNotif(text) {
    const container = document.getElementById("notif-container");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "notif";
    el.textContent = text;
    container.appendChild(el);
    if (container.children.length > 5) container.removeChild(container.firstElementChild);
    setTimeout(function () { if (container.contains(el)) container.removeChild(el); }, 9000);
  }
  setInterval(function () {
    const phone = "08" + Math.floor(10000000 + Math.random() * 90000000);
    const stocks = ["BRPT", "BREN", "CUAN", "TLKM"];
    const stock = stocks[Math.floor(Math.random() * stocks.length)];
    showNotif(phone + " vote " + stock);
  }, 3000);
});

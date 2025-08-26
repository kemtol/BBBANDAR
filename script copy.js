/* =========================================================
 * Quant App – Frontend Script (final)
 * - Source: KV Cloudflare
 * - Top 3: /api/reko/latest-summary (probability) → fallback /api/reko/latest-any
 * - Tabel: /api/reko/latest?slot=... atau latest-any
 * =======================================================*/

$(function () {
  // =========================
  // KONFIG
  // =========================
  const WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev";
  const SLOT_LABEL = { "0930": "09:30", "1130": "11:30", "1415": "14:15", "1550": "15:50" };

  // =========================
  // STATE (kamera; aman dari TDZ)
  // =========================
  let mediaStream = null, mediaRecorder = null, recordedChunks = [];
  window.mediaStream = null;

  // =========================
  // NAVIGASI & HISTORY
  // =========================
  function showPageNoHistory(id) {
    $("section").hide();
    $("#" + id).fadeIn();
  }
  function navigate(id) {
    if (location.hash !== "#" + id) {
      location.hash = id; // akan diproses di 'hashchange'
    } else {
      showPageNoHistory(id);
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
  });

  // Inisialisasi halaman pertama
  const first = location.hash.slice(1);
  if (first && $("#" + first).length) {
    showPageNoHistory(first);
  } else {
    navigate("splash-page");
  }

  // =========================
  // LIVENESS CHECK
  // =========================
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

  // =========================
  // COUNTDOWN (contoh)
  // =========================
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
    upd();
    setInterval(upd, 1000);
  })();

  // =========================
  // UTIL FORMAT
  // =========================
  const slotToLabel = (s) => SLOT_LABEL[s] || s;
  const fmtPct = (v) => Number.isFinite(+v) ? ((+v) * 100).toFixed(2) + "%" : "—";
  const fmtX = (v) => Number.isFinite(+v) ? (+v).toFixed(2) + "x" : "—";
  const fmtF3 = (v) => Number.isFinite(+v) ? (+v).toFixed(3) : "—";

  // =========================
  // TABEL “REKOMENDASI TERBARU”
  // =========================
  function buildHead() {
    $("#reko-thead").html(`
      <tr>
        <th class="text-muted" style="width:52px">#</th>
        <th>Ticker</th>
        <th class="text-end">Score</th>
        <th class="text-end">Return</th>
        <th class="text-end">Pace</th>
      </tr>
    `);
  }

  function renderRows(rows) {
    const $tb = $("#reko-tbody"); if (!$tb.length) return;
    $tb.empty();
    rows.forEach((r, i) => {
      const ret = Number(r.daily_return);
      const pace = Number(r.vol_pace);
      const score = Number(r.score);
      const retHTML = Number.isFinite(ret)
        ? `<span class="${ret >= 0 ? "reko-pos" : "reko-neg"}">${fmtPct(ret)}</span>`
        : "—";
      $tb.append(`
        <tr>
          <td class="text-muted">${i + 1}</td>
          <td><strong>${(r.ticker || "-")}</strong></td>
          <td class="reko-right text-end">${fmtF3(score)}</td>
          <td class="reko-right text-end">${retHTML}</td>
          <td class="reko-right text-end">${fmtX(pace)}</td>
        </tr>
      `);
    });
  }

  async function fetchRekoJSON(slot) {
    const url = (slot === "any")
      ? `${WORKER_BASE}/api/reko/latest-any`
      : `${WORKER_BASE}/api/reko/latest?slot=${slot}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadReko(slot) {
    $("#reko-tbody").html(`<tr><td colspan="5"><div class="reko-shimmer"></div></td></tr>`);
    $("#reko-meta").text("Memuat…");
    $("#reko-slot-badge").text("--:--");

    try {
      const data = await fetchRekoJSON(slot);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const date = data?.date || "-";
      const slotStr = String(data?.slot ?? (slot === "any" ? "any" : slot)).padStart(4, "0");

      $("#reko-meta").text(`Tanggal ${date} • ${rows.length} entri`);
      $("#reko-slot-badge").text(slotStr === "any" ? "Terbaru" : slotToLabel(slotStr));

      if (!rows.length) {
        $("#reko-thead").empty();
        $("#reko-tbody").html(`<tr><td colspan="5" class="text-center text-muted py-3">Tidak ada data.</td></tr>`);
        return;
      }
      buildHead();
      renderRows(rows);
    } catch (e) {
      console.error("[reko] load error:", e);
      $("#reko-meta").text("Gagal memuat.");
      $("#reko-thead").empty();
      $("#reko-tbody").html(`<tr><td colspan="5" class="text-danger">Error: ${e?.message || e}</td></tr>`);
    }
  }

  // =========================
  // TOP 3 (summary → fallback latest-any)
  // =========================
  async function loadTop3FromKV() {
    const $wrap = $("#top-picks"); if (!$wrap.length) return;

    // 1) Summary (probability)
    try {
      const rs = await fetch(`${WORKER_BASE}/api/reko/latest-summary`, { cache: "no-store" });
      if (rs.ok) {
        const sum = await rs.json();
        const rows = (sum?.rows || [])
          .slice()
          .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
          .slice(0, 3);

        const cards = rows.map((it) => {
          const tkr = (it.ticker || "-").toUpperCase();
          const score = Number(it.score);
          const bar = Math.max(0, Math.min(100, (score || 0) * 10));
          const bullets = [];
          if (Number.isFinite(it.p_close)) bullets.push(`Bertahan sampai tutup <b>${(it.p_close * 100).toFixed(1)}%</b>`);
          if (Number.isFinite(it.p_am))    bullets.push(`Naik ≥3% besok pagi <b>${(it.p_am * 100).toFixed(1)}%</b>`);
          if (Number.isFinite(it.p_next))  bullets.push(`Lanjut naik lusa <b>${(it.p_next * 100).toFixed(1)}%</b>`);
          if (Number.isFinite(it.p_chain)) bullets.push(`Total berantai <b>${(it.p_chain * 100).toFixed(1)}%</b>`);

          return `
            <div class="pick-card">
              <div class="pick-head">
                <span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>
                <h4 class="pick-ticker">${tkr}</h4>
              </div>
              <div class="pick-score">Score: <b>${Number.isFinite(score) ? score.toFixed(1) : "—"}</b> / 10</div>
              <div class="score-rail"><div class="score-fill" style="width:${bar}%"></div></div>
              <ul class="pick-bullets">
                <li><i>${it.rekom || "-"}</i></li>
                ${bullets.map(b => `<li>${b}</li>`).join("")}
              </ul>
              <button class="btn btn-primary pick-cta">VOTE SAHAM INI</button>
            </div>
          `;
        });
        $wrap.html(cards.join(""));
        return; // selesai jika summary ada
      }
    } catch (e) {
      console.warn("[top3] summary not available:", e);
    }

    // 2) Fallback: latest-any (statistik)
    try {
      const r = await fetch(`${WORKER_BASE}/api/reko/latest-any`, { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      const rows = (data?.rows || [])
        .slice()
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
        .slice(0, 3);

      const cards = rows.map((it) => {
        const tkr = (it.ticker || "-").toUpperCase();
        const score = Number(it.score);
        const bar = Math.max(0, Math.min(100, (score || 0) * 10));
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
            <div class="pick-score">Score: <b>${Number.isFinite(score) ? score.toFixed(1) : "—"}</b> / 10</div>
            <div class="score-rail"><div class="score-fill" style="width:${bar}%"></div></div>
            <ul class="pick-bullets">${bullets.length ? bullets.map(b => `<li>${b}</li>`).join("") : "<li>-</li>"}</ul>
            <button class="btn btn-primary pick-cta">VOTE SAHAM INI</button>
          </div>
        `;
      });
      $wrap.html(cards.join(""));
    } catch (e) {
      console.error("[top3] load error:", e);
      $wrap.empty();
    }
  }

  // =========================
  // TRIGGER DI HOME
  // =========================
  function triggerIfHome() {
    if (location.hash.slice(1) === "home-page") {
      const slot = $("#reko-slot-select").val() || "any";
      loadReko(slot);
      loadTop3FromKV();
    }
  }

  // Splash login → home (pastikan DOM home sudah render)
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

  // Hashchange & initial
  $(document).on("hashchange", function () { triggerIfHome(); });
  if (location.hash.slice(1) === "home-page") { requestAnimationFrame(triggerIfHome); }

  // Ganti slot
  $(document).on("change", "#reko-slot-select", function () { triggerIfHome(); });

  // Auto-refresh tiap 60 detik (hanya saat di home)
  setInterval(function () {
    if (location.hash.slice(1) === "home-page") triggerIfHome();
  }, 60000);

  // =========================
  // NOTIF DEMO (opsional)
  // =========================
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

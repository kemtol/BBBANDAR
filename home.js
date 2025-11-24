/* =========================================================
 * home.js — STANDALONE HOMEPAGE (tanpa SPA)
 * =========================================================*/
(function () {
  const WORKER_BASE = "https://bpjs-reko.mkemalw.workers.dev";
  const SLOTS = ["0930","1130","1415","1550"];
  const SLOT_LABEL = { "0930":"09:30", "1130":"11:30", "1415":"14:15", "1550":"15:50" };


function showGlobalError(msg) {
    const sec  = document.getElementById("error-page");
    const home = document.getElementById("home-page");
    const p    = document.getElementById("error-text");

    if (p && msg) p.textContent = msg;
    if (home) home.style.opacity = "0.3";   // optional: diblur/didim aja
    if (sec)  sec.style.display = "block";
  }
  /* =========================================================
   * UTIL
   * =========================================================*/
  function slotMinutes(slot){
    const m = String(slot).match(/^(\d{2})(\d{2})$/);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : -1;
  }
  function fmtPct(v){ return isFinite(v)?(v*100).toFixed(2)+"%":"—"; }
  function fmtF3(v){ return isFinite(v)?Number(v).toFixed(3):"—"; }
  function fmtX(v){ return isFinite(v)?Number(v).toFixed(2)+"x":"—"; }
  function slotToLabel(s){ return SLOT_LABEL[s]||s; }

  /* =========================================================
   * FETCH API HELPERS
   * =========================================================*/
  function fetchDates(){
    return fetch(WORKER_BASE+"/api/reko/dates",{cache:"no-store"})
      .then(r=>r.ok?r.json():{dates:[]})
      .then(j => Array.isArray(j.dates)?j.dates:[])
      .catch(()=>[]);
  }

  function fetchBatch(date,slot,isMk){
    const mk = isMk ? "&markov=1" : "";
    return fetch(`${WORKER_BASE}/api/reko/by-date?date=${date}&slot=${slot}${mk}`,{cache:"no-store"})
      .then(r=>r.ok?r.json():null)
      .then(d => (d && d.rows && d.rows.length) ? {date,slot,rows:d.rows,isMk} : null)
      .catch(()=>null);
  }

  function fetchRecentBatches(days=5){
    return fetchDates().then(dates => {
      const lastN = dates.slice(-days);
      const jobs=[];
      lastN.forEach(dt=>{
        SLOTS.forEach(sl=>{
          jobs.push(fetchBatch(dt,sl,true));
          jobs.push(fetchBatch(dt,sl,false));
        })
      });
      return Promise.all(jobs).then(arr => arr.filter(Boolean).sort((a,b)=>{
        if(a.date!==b.date) return a.date < b.date ? 1 : -1;
        return slotMinutes(b.slot)-slotMinutes(a.slot);
      }));
    });
  }

  /* =========================================================
   * RENDER FEED (per-slot table)
   * =========================================================*/
  function renderSlotTable(batch){
    const {rows,isMk,date,slot}=batch;
    let idx=1;

    const trs = rows.map(r=>{
      const tkr = isMk ? r["Kode Saham"] : r.ticker;
      const score = isMk ? r["Skor Sistem"] : r.score;
      const ret = isMk ? r["Peluang Naik ≥3% Besok Pagi"] : r.daily_return;
      const pace = isMk ? r["Kecepatan Volume"] : r.vol_pace;
      const price = isMk ? null : (r.price_at_cutoff ?? r.last);

      return `
        <tr>
          <td class="text-muted">${idx++}</td>
          <td><strong>${String(tkr).replace(/.JK$/,"")}</strong></td>
          <td class="text-end">${fmtF3(score)}</td>
          <td class="text-end"><span class="${ret>=0?"reko-pos":"reko-neg"}">${fmtPct(ret)}</span></td>
          <td class="text-end">${fmtX(pace)}</td>
          <td class="text-end">${isFinite(price)?Number(price).toLocaleString("id-ID"):"—"}</td>
        </tr>
      `;
    }).join("");

    return `
      <div class="reko-block my-4">
        <div class="d-flex gap-2 mb-2 align-items-center">
          <span class="badge text-dark" style="background:#cef4ff">${date}</span>
          <span class="badge text-dark">Slot ${slotToLabel(slot)}</span>
          <span class="small text-muted">• ${rows.length} entri</span>
          ${isMk ? `<span class="badge" style="background:#6f42c1;color:#fff">MARKOV</span>` : `<span class="badge text-dark">NON-MARKOV</span>`}
        </div>
        <table class="table table-sm reko-subtable">
          <thead style="background:#ddd">
            <tr>
              <th style="width:40px">#</th>
              <th>Ticker</th>
              <th class="text-end">Score</th>
              <th class="text-end">${isMk?"Peluang Naik":"Return"}</th>
              <th class="text-end">Pace</th>
              <th class="text-end">Buy Below</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    `;
  }

  function renderFeed(batches){
    const tbody = document.getElementById("reko-tbody");
    if(!tbody) return;

    if(!batches.length){
      tbody.innerHTML = `<tr><td><div class="text-center py-3 text-muted">Tidak ada data.</div></td></tr>`;
      return;
    }

    let grouped={};
    batches.forEach(b=>{
      (grouped[b.date]=grouped[b.date]||[]).push(b);
    });

    const dates = Object.keys(grouped).sort((a,b)=>a<b?1:-1);
    let html="";
    let prev=null;

    dates.forEach(date=>{
      if(prev){
        html += `
          <tr><td style="position:relative">
            <hr class="my-3 reko-hr">
            <div class="d-flex justify-content-center" style="position:absolute;left:0;right:0;top:0;bottom:0">
              <small class="p-2 bg-white">EOD of ${prev}</small>
            </div>
          </td></tr>`;
      }
      prev = date;

      grouped[date].sort((a,b)=>slotMinutes(b.slot)-slotMinutes(a.slot));
      grouped[date].forEach(batch=>{
        html += `<tr><td>${renderSlotTable(batch)}</td></tr>`;
      });
    });

    tbody.innerHTML = html;
  }

  function loadFeed(){
    $("#reko-tbody").html(`<tr><td><div class="reko-shimmer"></div></td></tr>`);
    fetchRecentBatches(5)
      .then(renderFeed)
      .catch(err=>{
        console.error("Feed error:", err);
        $("#reko-tbody").html(
          `<tr><td><div class="text-danger py-3">Gagal memuat feed.</div></td></tr>`
        );
        showGlobalError("Network / worker error saat memuat feed rekomendasi.");
      });
  }


/* =========================================================
 *  TOP PICKS (FINAL VERSION)
 * =========================================================*/
function normalizeSummaryRow(r) {
  return {
    ticker: (r.ticker || "-").toUpperCase(),
    score: Number(r.score),
    daily_return: Number(r.daily_return),
    vol_pace: Number(r.vol_pace),
    vwap_delta_pct: Number(r.vwap_delta_pct),
    flags: r.flags || ""
  };
}

function buildTopPickCard(r, maxScore) {
  const score10 = (r.score / maxScore) * 10;
  const barPct = (score10 / 10) * 100;

  return `
  <div class="pick-card">
    <div class="pick-head">
      <span class="pick-badge"><i class="fa-solid fa-chart-line"></i> Top Pick</span>
      <h4 class="pick-ticker">${r.ticker.replace(".JK","")}</h4>
    </div>

    <div class="pick-score">Score: <b>${score10.toFixed(1)}</b> / 10</div>
    <div class="score-rail">
      <div class="score-fill" style="width:${barPct}%;background:#43A047"></div>
    </div>

    <ul class="pick-bullets">
      <li>Return today: <b>${(r.daily_return*100).toFixed(1)}%</b></li>
      <li>Volume pace: <b>${r.vol_pace.toFixed(1)}x</b></li>
      <li>VWAP Δ: <b>${r.vwap_delta_pct.toFixed(2)}%</b></li>
      <li>Flags: <b>${r.flags}</b></li>
    </ul>
  </div>`;
}

function loadTopPicks() {
  const tgt = $("#top-picks");
  tgt.html(`<div class="text-center text-muted py-4">Loading…</div>`);

  fetch(`${WORKER_BASE}/api/reko/latest-summary`, { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!j || !j.rows) throw "no rows";

      const norm = j.rows.map(normalizeSummaryRow);
      const maxScore = Math.max(...norm.map(r => r.score));

      tgt.html(norm.slice(0, 9)
        .map(r => buildTopPickCard(r, maxScore))
        .join(""));

      $("#markov-updated").text("Updated in " + j.date);
    })
      .catch(err=>{
        console.error("TopPicks error:", err);
        tgt.html(`<div class="text-muted text-center py-4">No top picks</div>`);

        // contoh: hanya tunjukkan global error kalau benar-benar network / worker
        if (err instanceof TypeError || /Worker error/.test(err.message)) {
          showGlobalError("Gagal memuat data dari server. Coba beberapa saat lagi.");
        }
      });
}


  /* =========================================================
   * MARKOV DAILY
   * =========================================================*/
  function loadMarkovDaily(){
    const wrap = document.getElementById("dump-wrap");
    if(!wrap) return;

    wrap.innerHTML = "<em>Loading latest Markov daily…</em>";

    // tanggal terbaru
    fetchDates().then(dates=>{
      const last = dates[dates.length-1];
      return fetch(`${WORKER_BASE}/api/reko/daily?date=${last}&markov=1`,{cache:"no-store"});
    })
    .then(r=>r.ok?r.json():null)
    .then(daily=>{
      if(!daily || !daily.slots){ wrap.innerHTML="No data"; return; }

      let html = `<div class="text-center mb-4 text-muted small">${daily.date}</div>`;

      daily.slots.slice().reverse().forEach(slot=>{
        const rows = daily.data[slot]?.rows || [];
        html += `<div><strong>Slot ${slot}</strong>`;
        if(!rows.length){
          html += `<div>(no data)</div>`;
        }else{
          html += `<table class="table table-sm reko-subtable"><thead><tr>`;
          Object.keys(rows[0]).forEach(k=>html+=`<th>${k}</th>`);
          html += `</tr></thead><tbody>`;
          rows.forEach(r=>{
            html += `<tr>`;
            Object.keys(r).forEach(k=>html+=`<td>${r[k]}</td>`);
            html += `</tr>`;
          });
          html += `</tbody></table>`;
        }
        html += `</div>`;
      });
      wrap.innerHTML = html;
    })
    .catch(err=>{
      console.error("MarkovDaily error:", err);
      wrap.innerHTML = `<span style="color:red">Failed: ${err.message || err}</span>`;
      showGlobalError("Gagal memuat Markov daily dari server.");
    });
  }

  /* =========================================================
   * INITIAL EXECUTION
   * =========================================================*/
  document.addEventListener("DOMContentLoaded", function(){

    loadTopPicks();
    loadFeed();
    loadMarkovDaily();

    // auto-refresh 60s
    setInterval(()=>{
      loadTopPicks();
      loadFeed();
    },60000);

  });

})();

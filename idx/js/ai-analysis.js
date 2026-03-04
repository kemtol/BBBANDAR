/**
 * ai-analysis.js — Shared AI Analysis functions
 *
 * Provides: captureElement, uploadScreenshot, escapeHTML,
 *           renderListSection, renderMetaSection, renderFundFlowSection,
 *           renderSmartMoneySection, renderBrokerSection, renderTechnicalSection,
 *           renderRecommendationSection, renderSummaryTable, renderAnalysisJSON
 *
 * Requires:
 *   - html2canvas (loaded before this script)
 *   - WORKER_BASE_URL global (or API_BASE aliased as WORKER_BASE_URL by the host page)
 */

/* ──────────────────────────────────────────────────────────
   DOM CAPTURE & UPLOAD
   ────────────────────────────────────────────────────────── */

/**
 * Capture a DOM element as JPEG blob via html2canvas
 */
async function captureElement(el) {
    const canvas = await html2canvas(el, {
        backgroundColor: '#ffffff',
        scale: 1,
        useCORS: true,
        logging: false,
        onclone: function (clonedDoc) {
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
 * Upload a blob to R2 and return {key, url, label, size_kb}
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

/* ──────────────────────────────────────────────────────────
   HTML UTILITIES
   ────────────────────────────────────────────────────────── */

function escapeHTML(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* ──────────────────────────────────────────────────────────
   SECTION RENDERERS
   ────────────────────────────────────────────────────────── */

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

    const normalizeItem = (item) => {
        if (typeof item === 'string') {
            const colonIdx = item.indexOf(':');
            if (colonIdx > 0) {
                return { code: item.slice(0, colonIdx).trim(), desc: item.slice(colonIdx + 1).trim() };
            }
            return { code: item.trim(), desc: '' };
        }
        const code = item.code || item.nama || item.broker || '-';
        const parts = [
            item.type    && item.type    !== 'unknown' ? item.type    : null,
            item.value   && item.value   !== 'unknown' ? item.value   : null,
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

/* ──────────────────────────────────────────────────────────
   SUMMARY TABLE
   ────────────────────────────────────────────────────────── */

function renderSummaryTable(data) {
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

    const execSum  = data.executive_summary       || data.ringkasan_eksekutif      || null;
    const rec      = data.recommendation          || data.kesimpulan_rekomendasi   || {};
    const ff       = data.fund_flow               || data.analisis_fund_flow       || {};
    const sm       = data.smart_money             || data.analisis_smart_money     || {};
    const tl       = data.technical_levels        || data.level_teknikal           || {};
    const kb       = data.key_brokers             || data.identifikasi_broker_kunci || {};

    const rows = [];

    const execText = pickText(execSum, 280);
    if (execText) rows.push(['Ringkasan', execText]);

    const phase  = rec.phase  || rec.fase_saham   || rec.fase  || null;
    const rating = rec.rating || rec.rekomendasi  || null;

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

    const ffParts = [
        ff.foreign_trend  || ff.tren_asing    || null,
        ff.local_trend    || ff.tren_lokal    || null,
        ff.dominant_side  || ff.sisi_dominan  || null,
        ff.divergence     || ff.divergensi    || null,
    ].filter(x => x && x !== 'unknown');
    const ffText = ffParts.length ? ffParts.join(' · ') : pickText(ff, 200);
    if (ffText) rows.push(['Fund Flow', ffText]);

    const smState = sm.state || sm.kondisi || sm.status || null;
    const smText  = sm.assessment || sm.kualitas_akumulasi || sm.penilaian
        || (!smState ? pickText(sm, 180) : null);
    if (smState && smState !== 'UNKNOWN') rows.push(['Smart Money', smState]);
    if (smText)  rows.push([(smState ? 'Penilaian' : 'Smart Money'), smText]);

    const cleanLvl = s => typeof s === 'string' ? s.split(':')[0].trim() : String(s);
    const sup = (Array.isArray(tl.supports)          ? tl.supports
              :  Array.isArray(tl.support_levels)    ? tl.support_levels : []).slice(0, 4);
    const res = (Array.isArray(tl.resistances)       ? tl.resistances
              :  Array.isArray(tl.resistance_levels) ? tl.resistance_levels : []).slice(0, 4);
    if (sup.length) rows.push(['Support',    sup.map(cleanLvl).join(', ')]);
    if (res.length) rows.push(['Resistance', res.map(cleanLvl).join(', ')]);

    const extractCode = x => {
        if (typeof x === 'string') return x.split(':')[0].split(' - ')[0].trim();
        return x.code || x.nama || '';
    };
    const buyers  = (Array.isArray(kb.top_net_buyers)    ? kb.top_net_buyers
                   : Array.isArray(kb.broker_utama_beli)  ? kb.broker_utama_beli  : []).slice(0, 5).map(extractCode).filter(Boolean);
    const sellers = (Array.isArray(kb.top_net_sellers)   ? kb.top_net_sellers
                   : Array.isArray(kb.broker_utama_jual)  ? kb.broker_utama_jual  : []).slice(0, 5).map(extractCode).filter(Boolean);
    if (buyers.length)  rows.push(['Top Buyers',  buyers.join(', ')]);
    if (sellers.length) rows.push(['Top Sellers', sellers.join(', ')]);

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

/* ──────────────────────────────────────────────────────────
   MAIN RENDER ENTRY POINT
   ────────────────────────────────────────────────────────── */

function renderAnalysisJSON(data, screenshots) {
    if (!data || typeof data !== 'object') {
        return '<p class="text-muted">Analisis tidak tersedia.</p>';
    }

    // Normalize field names (support both English and Indonesian from Claude)
    const _execSum = data.executive_summary     || data.ringkasan_eksekutif       || null;
    const _ff      = data.fund_flow             || data.analisis_fund_flow        || {};
    const _sm      = data.smart_money           || data.analisis_smart_money      || {};
    const _kb      = data.key_brokers           || data.identifikasi_broker_kunci || {};
    const _tl      = data.technical_levels      || data.level_teknikal            || {};
    const _rec     = data.recommendation        || data.kesimpulan_rekomendasi    || {};

    if (!_ff.foreign_trend && _ff.tren_akumulasi)     _ff._summaryText  = _ff.tren_akumulasi;
    if (!_sm.state         && _sm.kondisi)            _sm.state         = _sm.kondisi;
    if (!_sm.assessment    && _sm.kualitas_akumulasi) _sm.assessment    = _sm.kualitas_akumulasi;
    if (!_tl.supports      && _tl.support_levels)     _tl.supports      = _tl.support_levels;
    if (!_tl.resistances   && _tl.resistance_levels)  _tl.resistances   = _tl.resistance_levels;
    for (const key of ['supports', 'resistances']) {
        if (_tl[key] && !Array.isArray(_tl[key]) && typeof _tl[key] === 'object') {
            _tl[key] = Object.entries(_tl[key]).map(([k, v]) => v ? `${k.replace(/^\*/, '')}: ${v}` : k.replace(/^\*/, ''));
        }
    }
    if (!_rec.phase    && _rec.fase_saham)  _rec.phase    = _rec.fase_saham;
    if (!_rec.rating   && _rec.rekomendasi) _rec.rating   = _rec.rekomendasi;
    if (!_rec.rationale && _rec.alasan)     _rec.rationale = _rec.alasan;
    if (!_rec.risks    && _rec.risiko)      _rec.risks     = _rec.risiko;
    if (_rec.confidence == null && _rec.tingkat_keyakinan != null) {
        const raw = _rec.tingkat_keyakinan;
        if (typeof raw === 'number') {
            _rec.confidence = raw > 1 ? raw / 100 : raw;
        } else if (typeof raw === 'string') {
            const pct = parseFloat(raw.replace('%', ''));
            _rec.confidence = !isNaN(pct) ? (pct > 1 ? pct / 100 : pct) : raw;
        }
    }
    if (!_kb.top_net_buyers  && _kb.broker_utama_beli)  _kb.top_net_buyers  = _kb.broker_utama_beli;
    if (!_kb.top_net_sellers && _kb.broker_utama_jual)  _kb.top_net_sellers = _kb.broker_utama_jual;

    // Narasi
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

    // Thumbnails
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

    const metaHtml = renderMetaSection(data.meta || {});
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

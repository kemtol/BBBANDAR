// Debug helper: hitung vol & delta per menit dari file raw_lt JSONL
// Usage:
//   node workers/tools/debug_cvd_from_raw.js path/to/raw.jsonl BUMI
//
// File berisi banyak baris JSON:
//   {"v":2,"fmt":"pipe","src":"ipot_ws","raw":"B|090002|0|BUMI|RG|074358|290|100|--|-|--|-|292|00|639321|-2|0|291|0|1", ...}

const fs = require('fs');
const path = require('path');

function normalizeTradeFromRawLine(line, targetTicker) {
  line = (line || '').trim();
  if (!line) return null;

  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const rawStr = obj.raw;
  if (!rawStr || typeof rawStr !== 'string') return null;

  const parts = rawStr.split('|');
  if (parts.length < 8) return null;

  const jenis = parts[0];      // 'B'
  const timeRaw = parts[1];    // '090002'
  const kode = parts[3];       // 'BUMI'
  const papan = parts[4];      // 'RG'
  const harga = Number(parts[6]);
  const vol = Number(parts[7]);

  if (jenis !== 'B') return null;
  if (papan !== 'RG') return null;
  if (kode !== targetTicker) return null;
  if (!Number.isFinite(harga) || !Number.isFinite(vol) || vol <= 0) return null;

  const t = String(timeRaw).padStart(6, '0');
  const hh = t.slice(0, 2);
  const mm = t.slice(2, 4);
  const ss = t.slice(4, 6);
  const minuteKey = `${hh}:${mm}`;   // contoh: "09:00"

  return {
    timeRaw,
    hh,
    mm,
    ss,
    minuteKey,
    kode,
    papan,
    harga,
    vol
  };
}

function main() {
  const [, , filePath, ticker] = process.argv;
  if (!filePath || !ticker) {
    console.error('Usage: node workers/tools/debug_cvd_from_raw.js <raw_file.jsonl> <TICKER>');
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');

  const perMinute = new Map(); // minuteKey -> bucket

  for (const line of lines) {
    const t = normalizeTradeFromRawLine(line, ticker.toUpperCase());
    if (!t) continue;

    let bucket = perMinute.get(t.minuteKey);
    if (!bucket) {
      bucket = {
        o: t.harga,
        h: t.harga,
        l: t.harga,
        c: t.harga,
        vol: 0,
        netVol: 0
      };
      perMinute.set(t.minuteKey, bucket);
    }

    // Update OHLC
    bucket.h = Math.max(bucket.h, t.harga);
    bucket.l = Math.min(bucket.l, t.harga);
    bucket.c = t.harga;

    // Total volume
    bucket.vol += t.vol;

    // Delta vs OPEN menit (proxy yang sama dengan aggregator)
    if (t.harga > bucket.o) bucket.netVol += t.vol;
    else if (t.harga < bucket.o) bucket.netVol -= t.vol;
    // kalau sama dengan open -> tidak mengubah netVol
  }

  const keys = Array.from(perMinute.keys()).sort();
  let cumDelta = 0;

  console.log(`Ticker: ${ticker.toUpperCase()}`);
  console.log('minute,open,high,low,close,vol,delta,deltaPct,cumDelta');

  for (const k of keys) {
    const b = perMinute.get(k);
    if (!b || b.vol <= 0) continue;

    cumDelta += b.netVol;
    const deltaPct = (b.netVol / b.vol) * 100;

    console.log([
      k,
      b.o,
      b.h,
      b.l,
      b.c,
      b.vol,
      b.netVol,
      deltaPct.toFixed(2),
      cumDelta
    ].join(','));
  }
}

if (require.main === module) {
  main();
}

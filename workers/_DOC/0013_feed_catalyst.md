Ambil Data catalyst dari IPOT https://indopremier.com/#ipot/app/calendar

request:
{"event":"cmd","data":{"cmdid":76,"param":{"service":"midata","cmd":"query","param":{"args":["<>","2026-03-01","2026-04-04"],"index":"CALCA","source":"common"}}},"cid":78}

response:
{"event":"record","data":{"event":"record","cmdid":76,"recno":1,"data":"CA|D|6721|1772384400|2026|2|2|XCID|XCID|F|cum|Cum"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":2,"data":"RUPS|RUPS|15090|1772384400|2026|2|2|CLAY|CLAY|F|end|Jam 10:00:00"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":3,"data":"CA|D|6719|1772470800|2026|2|3|BOLT|BOLT|C|start|Distribution"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":4,"data":"CA|D|6721|1772470800|2026|2|3|XCID|XCID|F|ex|Ex"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":5,"data":"RUPS|RUPS|15093|1772470800|2026|2|3|PTMR,PTMP,YOII|PTMR|F|end|Jam 13:00:00"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":6,"data":"CA|D|6721|1772557200|2026|2|4|XCID|XCID|F|rec|Recording"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":7,"data":"RUPS|RUPS|15096|1772557200|2026|2|4|PPGL|PPGL|F|end|Jam 10:00:00"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":8,"data":"CA|R|6716|1772643600|2026|2|5|IRSX|IRSX|T|cum|Cum"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":9,"data":"CA|W|6715|1772643600|2026|2|5|IRSX|IRSX|T|cum|Cum"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":10,"data":"RUPS|RUPS|15095|1772643600|2026|2|5|MDRN,BSWD|MDRN|F|end|Jam 14:00:00"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":11,"data":"CA|R|6716|1772730000|2026|2|6|IRSX|IRSX|T|ex|Ex"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":12,"data":"CA|W|6715|1772730000|2026|2|6|IRSX|IRSX|T|ex|Ex"}}
{"event":"record","data":{"event":"record","cmdid":76,"recno":13,"data":"RUPS|RUPS|15102|1772730000|2026|2|6|KUAS|KUAS|F|end|Jam 15:00:00"}}

======

request:
{"event":"cmd","data":{"cmdid":77,"param":{"cmd":"query","service":"mi","param":{"source":"jsx","index":"sector","args":{"code":["XCID","CLAY","PTMR","PTMP","YOII","PPGL","IRSX","MDRN","BSWD","KUAS","FUJI","BBNI","HAIS","DSSA","PGUN","BBCA","CASH","FASW","BBKP","FITT","BABP","PNGO","WSBP","SBMA","GDYR","WGSH","UDNG","MORA","ATIC","DCII","MPPA","WOMF","HAJJ"]}}}},"cid":79}

response:
{"event":"record","data":{"event":"record","cmdid":77,"recno":0,"data":{"code":"XCID","data":"FINANCE"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":1,"data":{"code":"CLAY","data":"TRADE"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":2,"data":{"code":"PTMR"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":3,"data":{"code":"PTMP"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":4,"data":{"code":"YOII"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":5,"data":{"code":"PPGL","data":"INFRASTRUC"}}}
{"event":"record","data":{"event":"record","cmdid":77,"recno":6,"data":{"code":"IRSX"}}}

====

sent request:
{"event":"cmd","data":{"cmdid":122,"param":{"cmd":"query","service":"midata","param":{"source":"research","index":"enQB_0_1_DescriptionCA","args":["6683"],"info":{"cache_allow":true}}}},"cid":124}


response:
{"event":"record","data":{"event":"record","cmdid":122,"recno":0,"data":{"seq":"6683","description":"<p>Jadwal Pelaksanaan Pembagian saham bonus atas saham Jaya Sukses Makmur Sentosa Tbk, PT (RISE)</p><p>Dengan ini kami beritahukan bahwa Emiten diatas bermaksud untuk melakukan pembagian saham bonus dengan rasio saham bonus 25 saham lama akan mendapatkan bonus 12 saham baru</p><p>Adapun jadwal pembagian saham bonus adalah sebagai berikut :<ul><li>Tanggal perdagangan bursa yang memuat saham bonus (Cum Dividen) di Pasar Reguler dan Pasar Negosiasi : 19 Jan 26</li><li>Tanggal perdagangan bursa tidak memuat saham bonus (Ex Dividen) di Pasar Reguler dan Pasar Negosiasi : 20 Jan 26</li><li>Tanggal perdagangan bursa yang memuat saham bonus (Cum Dividen) di Pasar Tunai : 21 Jan 26</li><li>Tanggal perdagangan bursa tidak memuat saham bonus (Ex Dividen) di Pasar Tunai : 22 Jan 26</li><li>Tanggal Penentuan Pemegang Saham yang berhak mendapat saham bonus di dalam rekening Efek (Recording Date): 21 Jan 26</li><li>Tanggal Pembayaran saham bonus : 9 Feb 26</li></ul></p>","act_type":"B","sec":"RISE","amount":"0.00","ratio1":25,"ratio2":12,"cum_date":"2026-01-18T17:00:00.000Z","ex_date":"2026-01-19T17:00:00.000Z","rec_date":"2026-01-20T17:00:00.000Z","start_dist_date":"2026-02-08T17:00:00.000Z","end_dist_date":"2026-02-08T17:00:00.000Z","url":"","status":"F"}}}

---

# PRD 0013 — Feed Catalyst Scraper (IPOT Calendar)

## 1) Ringkasan
Bangun pipeline scraper catalyst dari IPOT Calendar (CALCA) dengan enrichment sektor (`jsx/sector`) dan deskripsi CA (`enQB_0_1_DescriptionCA`) agar endpoint `dashboard/catalyst` menampilkan data yang lebih kaya, stabil, dan siap dipakai frontend Feed.

Target: data catalyst ter-update otomatis, bisa di-refresh terjadwal, punya fallback/repair, dan tetap kompatibel dengan UI Feed/Catalyst yang sudah ada.

---

## 2) Objective
1. Ingest event catalyst dari CALCA (RUPS + Corporate Action) berbasis websocket handshake.
2. Enrich symbol dengan sektor.
3. Enrich event CA dengan detail deskripsi berdasarkan `seq`.
4. Simpan normalized event ke D1 (dan raw snapshot ke R2 untuk audit).
5. Sajikan API frontend yang ringan dan konsisten.

Non-objective v1:
- Tidak melakukan sentiment NLP lanjutan pada dokumen deskripsi.
- Tidak melakukan prediksi harga.

---

## 3) Worker Capabilities yang Dipilih (Paling Cocok)

### 3.1 Durable Object (DO) — `CatalystScraperDO`
Dipakai untuk koneksi websocket long-lived ke IPOT karena:
- butuh stateful `cid/cmdid` monotonic,
- butuh reconnect/backoff,
- butuh lock agar tidak ada scraper ganda di waktu sama.

### 3.2 Cron Trigger
Menjalankan pull terjadwal (mis. tiap 5 menit) untuk jendela tanggal aktif.

### 3.3 Queue (opsional tapi direkomendasikan)
Untuk fan-out enrichment detail CA (`seq`) agar tidak memblok pull utama.

### 3.4 D1
Penyimpanan normalized event + sektor + detail description.

### 3.5 R2
Penyimpanan raw websocket payload (audit/replay/debug).

### 3.6 Service Binding ke `api-saham`
Expose endpoint konsumsi frontend melalui worker API utama agar integrasi tetap satu pintu.

---

## 4) Parsing & Normalization Rules

## 4.1 CALCA pipe format (v1 asumsi operasional)
Format sample:
`type|subtype|seq|epoch|year|month|day|symbols_csv|primary_symbol|status|phase|label`

Mapping:
- `type`: `CA` / `RUPS`
- `subtype`: `D`, `R`, `W`, `RUPS`, dll
- `seq`: ID event sumber
- `epoch`: unix detik event
- `symbols_csv`: bisa multi symbol (comma separated)
- `primary_symbol`: symbol utama
- `status`: status event (`F`, `C`, `T`, ...)
- `phase`: `cum`, `ex`, `rec`, `start`, `end`
- `label`: label short (`Cum`, `Ex`, `Recording`, `Jam 10:00:00`)

Jika field kurang dari 12, parser tetap toleran dengan default `null`.

### 4.2 Normalized output per event
Field minimum:
- `source = "ipot_calca"`
- `event_type` (`CA` / `RUPS`)
- `event_subtype`
- `seq`
- `event_ts`
- `event_date` (WIB)
- `event_time_wib` (opsional)
- `symbols` (array)
- `symbol_primary`
- `status`
- `phase`
- `label`
- `sector_primary` (hasil enrichment)
- `description_html` (untuk CA jika ada)
- `description_text` (html-stripped)

### 4.3 Dedupe key
Gunakan kunci:
`source + event_type + seq + event_ts + symbol_primary + phase`

---

## 5) Pipeline End-to-End (Kontrak WebSocket Disisipkan)

### 5.1 Stage A — Pull CALCA (master event)
1. Cron trigger memanggil `CatalystScraperDO/sync`.
2. DO buka websocket IPOT + auth/session reuse.
3. DO kirim query CALCA untuk window tanggal (`today-7` s/d `today+30`).

Kontrak request:
```json
{"event":"cmd","data":{"cmdid":76,"param":{"service":"midata","cmd":"query","param":{"args":["<>","2026-03-01","2026-04-04"],"index":"CALCA","source":"common"}}},"cid":78}
```

Kontrak response (stream record):
```json
{"event":"record","data":{"event":"record","cmdid":76,"recno":1,"data":"CA|D|6721|1772384400|2026|2|2|XCID|XCID|F|cum|Cum"}}
```

4. Parser normalisasi record CALCA ke model internal.

### 5.2 Stage B — Enrichment sektor symbol
5. Kumpulkan symbol unik dari hasil CALCA.
6. Query sektor batch (chunk mis. 100 symbol/request).

Kontrak request:
```json
{"event":"cmd","data":{"cmdid":77,"param":{"cmd":"query","service":"mi","param":{"source":"jsx","index":"sector","args":{"code":["XCID","CLAY"]}}}},"cid":79}
```

Kontrak response:
```json
{"event":"record","data":{"event":"record","cmdid":77,"recno":0,"data":{"code":"XCID","data":"FINANCE"}}}
```

7. Merge hasil sektor ke `sector_primary`.

### 5.3 Stage C — Enrichment detail CA by `seq`
8. Untuk event `CA`, enqueue detail `seq` yang belum ada/expired.
9. Worker detail-consumer pull detail description per `seq`.

Kontrak request:
```json
{"event":"cmd","data":{"cmdid":122,"param":{"cmd":"query","service":"midata","param":{"source":"research","index":"enQB_0_1_DescriptionCA","args":["6683"],"info":{"cache_allow":true}}}},"cid":124}
```

Kontrak response:
```json
{"event":"record","data":{"event":"record","cmdid":122,"recno":0,"data":{"seq":"6683","description":"<p>...</p>","act_type":"B","sec":"RISE"}}}
```

10. Upsert D1 normalized tables.
11. Tulis raw payload ke R2 (partition by date/hour).
12. API `dashboard/catalyst` baca dari D1 dan kirim ke frontend.

---

## 6) Storage Schema (D1)

### 7.1 `catalyst_events`
- `id` INTEGER PK
- `source` TEXT
- `event_type` TEXT
- `event_subtype` TEXT
- `seq` TEXT
- `event_ts` INTEGER
- `event_date` TEXT
- `event_time_wib` TEXT
- `symbol_primary` TEXT
- `symbols_json` TEXT
- `status` TEXT
- `phase` TEXT
- `label` TEXT
- `sector_primary` TEXT
- `created_at` TEXT
- `updated_at` TEXT
- UNIQUE(`source`,`event_type`,`seq`,`event_ts`,`symbol_primary`,`phase`)

### 7.2 `catalyst_ca_detail`
- `seq` TEXT PK
- `sec` TEXT
- `act_type` TEXT
- `description_html` TEXT
- `description_text` TEXT
- `amount` REAL
- `ratio1` REAL
- `ratio2` REAL
- `cum_date` TEXT
- `ex_date` TEXT
- `rec_date` TEXT
- `start_dist_date` TEXT
- `end_dist_date` TEXT
- `status` TEXT
- `fetched_at` TEXT

### 7.3 `catalyst_sector_cache`
- `symbol` TEXT PK
- `sector` TEXT
- `fetched_at` TEXT

---

## 7) Raw Snapshot Schema (R2)

Path:
- `catalyst/raw/v1/date=YYYY-MM-DD/hour=HH/cmdid=76/cid=NNN.ndjson.gz`
- `catalyst/raw/v1/date=YYYY-MM-DD/hour=HH/cmdid=77/cid=NNN.ndjson.gz`
- `catalyst/raw/v1/date=YYYY-MM-DD/hour=HH/cmdid=122/seq=XXXX.ndjson.gz`

Tujuan:
- audit,
- replay parser,
- backfill/smart repair.

---

## 8) API Contract untuk Frontend

Endpoint utama (tetap):
- `GET /dashboard/catalyst?limit=30&from=YYYY-MM-DD&to=YYYY-MM-DD`

Response item minimal:
```json
{
	"id": "ca-6719-1772470800-BOLT-ex",
	"type": "ca",
	"symbol": "BOLT",
	"symbols": ["BOLT"],
	"title": "Corporate Action BOLT",
	"subtitle": "Ex Date",
	"description": "Distribution",
	"phase": "ex",
	"status": "F",
	"sector": "INFRASTRUC",
	"event_date": "2026-03-03",
	"event_time_wib": null,
	"created_at": "2026-03-01T02:31:00.000Z"
}
```

Endpoint detail (baru):
- `GET /dashboard/catalyst/detail?seq=6719`

Response detail:
```json
{
	"ok": true,
	"seq": "6719",
	"sec": "BOLT",
	"act_type": "B",
	"description_html": "<p>...</p>",
	"description_text": "...",
	"ratio1": 25,
	"ratio2": 12,
	"cum_date": "2026-01-18T17:00:00.000Z",
	"ex_date": "2026-01-19T17:00:00.000Z"
}
```

---

## 9) Integrasi Frontend (Feed Page)

Frontend tetap memanggil:
- `GET /dashboard/catalyst?limit=30`

Penyesuaian render:
1. Prioritaskan `phase` untuk subtitle (`Cum`, `Ex`, `Recording`, `Distribution`).
2. Tampilkan `sector` jika ada.
3. Untuk item CA yang punya `seq`, klik card bisa buka detail modal (opsional v1.1).
4. Tetap tampilkan loading state per panel (sudah ada).

---

## 10) Scheduling Strategy

- Market hours (WIB): setiap 5 menit.
- Non-market hours: setiap 30 menit.
- Midnight maintenance: full resync window `today-14` s/d `today+45`.

---

## 11) Error Handling & Repair

1. Jika query CALCA gagal: retry 3x (exponential backoff).
2. Jika sektor gagal: lanjut insert event, isi sektor `null`, enqueue retry sector.
3. Jika detail seq gagal: tandai `detail_pending=true`, retry async.
4. Jika parser error: simpan raw ke R2 + log reason + skip record bermasalah.

---

## 12) Observability

Metrics minimum:
- `catalyst_sync_success_rate`
- `catalyst_records_ingested`
- `catalyst_sector_enriched_rate`
- `catalyst_detail_enriched_rate`
- `catalyst_sync_latency_ms`

Structured log keys:
- `batch_id`, `cmdid`, `cid`, `window_from`, `window_to`, `records_total`, `records_ok`, `records_failed`.

---

## 13) Security & Compliance

- Jangan simpan cookie/token sensitif ke D1/R2.
- Redact header/session sebelum persist raw.
- Batasi akses endpoint internal sync via secret.

---

## 14) Acceptance Criteria

1. Data CALCA masuk ke D1 minimal tiap 5 menit saat jam pasar.
2. >= 95% event memiliki `symbol_primary` dan `event_date` valid.
3. >= 90% symbol pada event memiliki sektor (setelah retry).
4. >= 80% event CA punya detail `description_text` dalam 15 menit.
5. Endpoint `GET /dashboard/catalyst` menampilkan data terbaru tanpa mengubah kontrak lama frontend.
6. Jika upstream gagal sementara, frontend tetap menerima data terakhir (graceful stale).

---

## 15) Rencana Implementasi

### Phase A (MVP, 2–3 hari)
- DO websocket scraper CALCA.
- Upsert `catalyst_events`.
- Integrasi endpoint `dashboard/catalyst` dari tabel baru.

### Phase B (Enrichment, 2 hari)
- Sektor batch query + cache.
- Detail CA by `seq` + endpoint detail.

### Phase C (Hardening, 1–2 hari)
- R2 raw snapshot + repair job.
- Metric + alert.

---

## 16) Open Questions

1. Window default API frontend: 30 hari ke depan saja, atau campur history 7 hari?
2. Untuk RUPS multi-symbol (`PTMR,PTMP,YOII`), apakah semua harus ditampilkan sebagai item terpisah?
3. Detail CA di frontend: inline expand atau modal detail?
# ELSA — Skills & Capabilities

## Core Pipeline

```
SCRAPE → CLEAN → CHUNK → EMBED → STORE
```

---

## Skill 1: Web Scraping

### Tools
- **Playwright** — untuk halaman JS-heavy (SPA, infinite scroll, login-required)
- **httpx + BeautifulSoup** — halaman static, cepat dan ringan
- **Scrapy** — crawler skala besar dengan built-in throttling

### Source Tiers

| Tier | Sumber | Prioritas | Frekuensi |
|------|--------|-----------|-----------|
| **S** | IDX (idx.co.id), Federal Reserve, Bank Indonesia (bi.go.id), BPS | Kritikal | 15 menit – Harian |
| **A** | Yahoo Finance, Investing.com, Reuters RSS, Bloomberg Headlines, TradingEconomics | Tinggi | 15 menit – Harian |
| **B** | Stockbit, RTI Business, Twitter/X keuangan, Telegram channel trading, Reddit r/investing | Sedang | 30 menit – Harian |

### Anti-Detection
- Rotate user-agent dari pool
- Random delay antara request (0.5–3 detik)
- Respect `robots.txt` untuk tier A dan S
- Exponential backoff saat rate limit (ikuti `Retry-After` header)

---

## Skill 2: Data Cleaning

- Strip HTML tags, normalize whitespace, handle encoding (UTF-8 enforced)
- **Language detection** otomatis → tag `id` atau `en` per dokumen
- **Deduplication**: SHA-256 hash dari konten → cek Redis sebelum proses. Kalau hash sudah ada → skip.
- **Entity extraction** sederhana: ticker symbols, tanggal, angka, nama bank sentral
- **Timestamp normalization**: semua disimpan sebagai UTC ISO-8601
- Hapus dokumen jika: konten < 50 karakter, tidak ada tanggal publikasi, 100% berisi iklan

---

## Skill 3: Chunking Strategy

| Tipe Dokumen | Strategi | Max Token per Chunk | Overlap |
|--------------|----------|---------------------|---------|
| Berita / artikel | Paragraf-based | 512 | 50 |
| PDF (laporan keuangan) | Page-based + table detection | 1024 | 100 |
| Data terstruktur (JSON/CSV) | Row-based + metadata injection | 256 | 0 |
| Social media post | Post-level, grouping by thread | 256 | 0 |
| Research paper | Section-based (abstract, intro, result, conclusion) | 1024 | 128 |

---

## Skill 4: Embedding

- **Primary**: `text-embedding-3-small` (OpenAI) — dimensi 1536, biaya rendah untuk volume tinggi
- **Fallback (local)**: `sentence-transformers/all-MiniLM-L6-v2` — dimensi 384, zero cost, fully offline
- Semua embedding disimpan dengan field `embed_model` untuk tracking versi

---

## Skill 5: Qdrant Collections

| Koleksi | Konten | Update Frekuensi | Prioritas |
|---------|--------|-----------------|-----------|
| `news_global` | Berita internasional (Reuters, Bloomberg, AP) | Setiap 15 menit | KRITIKAL |
| `news_indonesia` | Berita saham & makro Indonesia (IDX, Kontan, Bisnis) | Setiap 15 menit | KRITIKAL |
| `economic_calendar` | FOMC, CPI, NFP, GDP, BI Rate, data makro global | Harian (+ real-time saat event) | KRITIKAL |
| `idx_disclosures` | Laporan keuangan kuartalan, corporate action, keterbukaan IDX | Harian | TINGGI |
| `macro_data` | Time-series makro: DXY, yield curve, inflasi, commodity Index | Harian | TINGGI |
| `research_papers` | Academic papers tentang strategi trading & market microstructure | Mingguan | SEDANG |
| `strategy_corpus` | Dokumen strategi dari NEWTON (spec, backtest summary, approval log) | On-demand | SEDANG |
| `sentiment_feed` | Sentimen retail dari Stockbit, social media | Setiap 30 menit | RENDAH |

---

## Skill 6: PostgreSQL Metadata Store

```sql
TABLE scrape_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  source_name     TEXT,
  source_tier     CHAR(1),          -- 'S', 'A', 'B'
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ,
  content_hash    CHAR(64),         -- SHA-256, untuk dedup
  chunk_count     INT DEFAULT 0,
  embed_status    TEXT DEFAULT 'pending',  -- pending | done | failed
  qdrant_collection TEXT,
  asset_tags      TEXT[],           -- ['XAUUSD', 'IDR', 'IHSG']
  language        CHAR(2),          -- 'en', 'id'
  confidence      TEXT DEFAULT 'high',  -- high | medium | low
  error_msg       TEXT              -- isi kalau embed_status = 'failed'
);
```

---

## Skill 7: Activity Schedule

| Timeframe | Aktivitas |
|-----------|-----------|
| Setiap 1 menit | Heartbeat — cek health Qdrant, Redis, embed_queue size |
| Setiap 15 menit | Scrape `news_global` + `news_indonesia` |
| Setiap 30 menit | Update `sentiment_feed` dari Stockbit & social |
| Setiap 1 jam | Scrape `economic_calendar`, flag event dalam 24 jam ke ARIA |
| Harian 07:00 WIB | Full scrape `idx_disclosures`, update `macro_data` |
| Mingguan Senin 06:00 WIB | Hunt & embed `research_papers`, audit semua Qdrant collections |
| On-demand | Respond ke request NEWTON untuk corpus spesifik |

---

## Skill 8: Error Handling & Resilience

- Scraping gagal → retry max 3x dengan exponential backoff (1s, 4s, 16s)
- Embedding gagal → push ke `embed_queue` Redis, retry setiap 10 menit
- Qdrant down → buffer dokumen ke PostgreSQL (`embed_status = 'pending'`), flush otomatis saat Qdrant recover
- Source 404/410 permanen → flag ke `source_health` table, lapor ke ARIA
- Rate limit → respek `Retry-After`, jangan bypass

---

## Skill 9: Reports Output

| Report | Frekuensi | Penerima |
|--------|-----------|---------|
| Daily Library Digest | Harian 08:00 WIB | ARIA |
| Source Health Alert | Real-time (saat sumber mulai gagal 3x berturut) | ARIA |
| Coverage Alert | Real-time (event penting dalam 24 jam belum ada di DB) | ARIA + NEWTON |
| NEWTON Request Log | Mingguan | ARIA |
| Qdrant Storage Report | Mingguan | ARIA |

### Format Daily Library Digest:
```
📚 ELSA Daily Digest — {tanggal}

New docs indexed:
 - news_global: +{n} dokumen
 - news_indonesia: +{n} dokumen
 - idx_disclosures: +{n} dokumen
 - economic_calendar: +{n} events
 - sentiment_feed: +{n} entries

Health:
 - Embed queue: {n} pending
 - Failed embeds (24h): {n}
 - Qdrant storage: {n} GB used

Upcoming events (24h): {list FOMC/NFP/dll}
```

---

## Skill 10: NEWTON Interface

ELSA merespons query dari NEWTON dengan format terstruktur:

```python
# NEWTON query ke ELSA (via Redis pub/sub channel: elsa.query)
{
  "request_id": "uuid",
  "collection": "news_global",
  "query": "XAUUSD sentiment post-FOMC",
  "filters": {
    "asset_tags": ["XAUUSD"],
    "language": "en",
    "from": "2026-03-01T00:00:00Z"
  },
  "top_k": 20
}

# ELSA response (channel: elsa.response)
{
  "request_id": "uuid",
  "results": [...],  # Qdrant search results
  "meta": {
    "collection": "news_global",
    "result_count": 20,
    "query_time_ms": 45
  }
}
```

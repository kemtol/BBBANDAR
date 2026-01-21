-- Migration 0001: Create backfill_stats table
CREATE TABLE IF NOT EXISTS backfill_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    date TEXT,
    hour TEXT,
    status TEXT,
    batch_index INTEGER,
    files_processed INTEGER,
    elapsed_sec REAL,
    engine TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_date_hour ON backfill_stats(date, hour);

-- Migration: Create Footprint Aggregation Tables

-- 1. Main Footprint Table (Renamed to temp_footprint_consolidate)
CREATE TABLE IF NOT EXISTS temp_footprint_consolidate (
    ticker TEXT NOT NULL,       -- e.g., 'BBCA'
    date TEXT NOT NULL,         -- '2026-02-04' (Partition Key)
    time_key INTEGER NOT NULL,  -- Unix Timestamp (e.g., 1770170400000 for 09:00:00)
    
    -- OHLCV Data
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    vol REAL,
    delta REAL,                 -- Net Volume (Buy Vol - Sell Vol)
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticker, time_key)
);

CREATE INDEX IF NOT EXISTS idx_temp_footprint_date_ticker ON temp_footprint_consolidate(date, ticker);

-- Drop old table if exists
DROP TABLE IF EXISTS footprint_1m;

-- 2. Job Checkpoint Table (For Cron/Queue Coordination)
CREATE TABLE IF NOT EXISTS job_checkpoint (
    job_id TEXT PRIMARY KEY,    -- e.g., 'agg_hour_2026-02-04_09'
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    total_tickers INTEGER DEFAULT 0,
    processed_tickers INTEGER DEFAULT 0,
    status TEXT DEFAULT 'PENDING', -- PENDING, PROCESSING, COMPLETED
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

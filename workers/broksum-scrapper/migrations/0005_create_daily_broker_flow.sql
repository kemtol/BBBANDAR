-- Migration: Create daily_broker_flow table
-- Stores pre-aggregated foreign/local/retail net flow per ticker per day.
-- Written by queue consumer after each successful scrape.
-- Read by accum-preprocessor cron to build screener-accum artifacts.

CREATE TABLE IF NOT EXISTS daily_broker_flow (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    foreign_buy REAL DEFAULT 0,
    foreign_sell REAL DEFAULT 0,
    foreign_net REAL DEFAULT 0,
    local_buy REAL DEFAULT 0,
    local_sell REAL DEFAULT 0,
    local_net REAL DEFAULT 0,
    retail_buy REAL DEFAULT 0,
    retail_sell REAL DEFAULT 0,
    retail_net REAL DEFAULT 0,
    smart_net REAL DEFAULT 0,          -- foreign_net + local_net (precomputed)
    price INTEGER DEFAULT 0,
    total_value TEXT DEFAULT '0',
    broker_buy_count INTEGER DEFAULT 0,
    broker_sell_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (date, ticker)
);

-- Index for timeframe queries (last N trading days per ticker)
CREATE INDEX IF NOT EXISTS idx_dbf_ticker_date ON daily_broker_flow (ticker, date DESC);

-- Index for date-based batch reads (accum preprocessor)
CREATE INDEX IF NOT EXISTS idx_dbf_date ON daily_broker_flow (date);

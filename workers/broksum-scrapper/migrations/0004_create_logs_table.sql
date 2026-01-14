-- Create table scraping_logs
CREATE TABLE IF NOT EXISTS scraping_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    symbol TEXT,
    date TEXT,
    status TEXT,
    duration_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Check valid indexes?
CREATE INDEX IF NOT EXISTS idx_logs_date ON scraping_logs(date);
CREATE INDEX IF NOT EXISTS idx_logs_status ON scraping_logs(status);

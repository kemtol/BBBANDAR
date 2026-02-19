-- Track per-ticker IDX sync timestamps
CREATE TABLE IF NOT EXISTS emiten_sync_status (
    ticker TEXT PRIMARY KEY,
    last_synced_at TEXT NOT NULL,
    last_action TEXT,
    last_status TEXT,
    last_source TEXT,
    last_sector TEXT,
    last_industry TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

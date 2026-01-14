-- Create table emiten
CREATE TABLE IF NOT EXISTS emiten (
    ticker TEXT PRIMARY KEY,
    sector TEXT,
    industry TEXT,
    status TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

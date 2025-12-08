-- auth-uid/migrations/0001_init_auth.sql
-- Migration number: 0001 	 2025-11-15T14:07:28.680Z
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  password_hash TEXT,
  createdAt INTEGER DEFAULT (strftime('%s','now'))
);


-- auth-uid/migrations/0002_add_user_id.sql
-- Migration number: 0002

ALTER TABLE users ADD COLUMN user_id TEXT;

-- Optional tapi bagus: index unik kalau nanti semua user sudah punya user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

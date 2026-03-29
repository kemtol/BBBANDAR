-- auth-uid/migrations/0004_add_tg_fields.sql
-- Migration number: 0004

-- Store plaintext temp OTP so Telegram bot can retrieve and send it to user
-- Cleared automatically when /verify-temp succeeds
ALTER TABLE users ADD COLUMN temp_password_plain TEXT;

-- Store Telegram chat_id for sending invites after OTP verification
-- Set by tg-bot via /tg/store-chat endpoint
ALTER TABLE users ADD COLUMN telegram_chat_id TEXT;

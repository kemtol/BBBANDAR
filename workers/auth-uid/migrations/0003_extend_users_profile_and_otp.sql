-- auth-uid/migrations/0003_extend_users_profile_and_otp.sql
-- Migration number: 0003

-- Email optional, kalau nanti tidak dipakai juga tidak apa-apa
ALTER TABLE users ADD COLUMN email TEXT;

-- Untuk paksa user lengkapi profil (name + password baru)
ALTER TABLE users ADD COLUMN must_update_profile INTEGER DEFAULT 0;

-- Untuk temp password (OTP 6 digit) + expiry (timestamp ms)
ALTER TABLE users ADD COLUMN temp_password_hash TEXT;
ALTER TABLE users ADD COLUMN temp_password_expires_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_ci_idx ON users (lower(referral_code));

-- ============================================================================
-- DEPRECATED — NOT USED AT RUNTIME.
--
-- This file is never mounted or executed: docker-compose.yml does not
-- reference it. The actual schema is created at runtime by:
--   * cloud-src/api (table creation in api/src/main.rs, e.g. `app_users`
--     with tier CHECK (tier IN ('free', 'pro', 'max')))
--   * Better Auth migrations (cloud-src/auth, applied via entrypoint.sh)
--
-- Note: the `tier` CHECK below lacks 'max' and does not match the live
-- schema. Kept for historical reference only — do not deploy from this file.
-- ============================================================================

-- Users table for tracking Google OAuth users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    picture_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tier VARCHAR(50) DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
    subscription_id VARCHAR(255),
    subscription_status VARCHAR(50),
    subscription_end_date TIMESTAMP WITH TIME ZONE
);

-- Index for faster lookups by Google ID
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Index for faster lookups by email
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Merge duplicate app_users rows: one person, two ids.
--
-- Why there are duplicates: the web app signs people in through Better Auth
-- (a random id), the desktop app through Google directly (Google's numeric
-- id). Until the fix in the same commit as this file, each made its own
-- app_users row, so a plan set on one row didn't show in the other app.
--
-- What this does, for each email that has more than one row:
--   1. keeps one row: the one Stripe knows (subscription, then customer),
--      then the one with the most requests, then the oldest
--   2. copies onto it what only the other rows have (best plan, admin plan,
--      coupon, Stripe ids, earliest created_at)
--   3. moves requests, desktop tokens and codes, and web chats to it
--   4. records each dropped id in app_user_aliases, so signing in with it, a
--      Stripe event carrying it, or an old audit entry still finds the person
--   5. deletes the dropped rows
-- Then it pins plans an admin set by hand that are still in place (so a
-- Stripe renewal can't undo them) and adds the one-row-per-email index.
-- admin_audit_log is left as it is: history, read through the aliases.
--
-- Run it AFTER the API with the fix is live (the old API would make a new
-- duplicate on the next desktop sign-in, and fails once the index exists).
--
-- By default it is a DRY RUN: it prints the plan, does the work, checks it,
-- and rolls back. Even the dry run takes row locks for a moment, so it needs
-- the same go-ahead as the real run. From ~/cloud on the VM:
--   sudo docker compose exec -T postgres psql -U zwork -d zwork_db -v ON_ERROR_STOP=1 < merge.sql
--   sudo docker compose exec -T postgres psql -U zwork -d zwork_db -v ON_ERROR_STOP=1 -v commit=1 < merge.sql

\set ON_ERROR_STOP 1
BEGIN;

-- The API creates these at startup; repeated here so the file stands alone.
ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS admin_tier TEXT CHECK (admin_tier IN ('free', 'pro', 'max'));
CREATE TABLE IF NOT EXISTS app_user_aliases (
    alias_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every row, ranked within its email. rank 1 is kept.
CREATE TEMP TABLE merge_rank ON COMMIT DROP AS
SELECT
    u.user_id,
    lower(trim(u.email)) AS email_key,
    row_number() OVER (
        PARTITION BY lower(trim(u.email))
        ORDER BY (u.subscription_id IS NOT NULL) DESC,
                 (u.stripe_customer_id IS NOT NULL) DESC,
                 COALESCE(r.requests, 0) DESC,
                 u.created_at ASC,
                 u.user_id ASC
    ) AS rank,
    COALESCE(r.requests, 0) AS requests
FROM app_users u
LEFT JOIN (
    SELECT user_id, count(*) AS requests FROM gateway_requests GROUP BY user_id
) r ON r.user_id = u.user_id
WHERE trim(u.email) <> ''
  AND lower(trim(u.email)) IN (
      SELECT lower(trim(email)) FROM app_users
      WHERE trim(email) <> ''
      GROUP BY 1 HAVING count(*) > 1
  );

CREATE TEMP TABLE merge_map ON COMMIT DROP AS
SELECT d.user_id AS old_id, k.user_id AS keep_id
FROM merge_rank d
JOIN merge_rank k ON k.email_key = d.email_key AND k.rank = 1
WHERE d.rank > 1;

\echo '== Plan: rows kept (rank 1) and merged into them'
SELECT md5(r.email_key) AS email_hash, r.rank, r.user_id, u.tier, u.admin_tier,
       u.stripe_customer_id IS NOT NULL AS has_customer,
       u.subscription_id IS NOT NULL AS has_subscription,
       r.requests, u.created_at::date AS created
FROM merge_rank r JOIN app_users u USING (user_id)
ORDER BY 1, 2;

\echo '== Stripe customers on merged rows that differ from the kept row (kept as aliases only; check in Stripe)'
SELECT m.keep_id, m.old_id, o.stripe_customer_id AS dropped_customer
FROM merge_map m
JOIN app_users o ON o.user_id = m.old_id
JOIN app_users k ON k.user_id = m.keep_id
WHERE o.stripe_customer_id IS NOT NULL
  AND k.stripe_customer_id IS NOT NULL
  AND o.stripe_customer_id <> k.stripe_customer_id;

-- 2. Copy onto the kept row what only the others have.
WITH grp AS (
    SELECT m.keep_id,
           max(CASE o.tier WHEN 'max' THEN 3 WHEN 'pro' THEN 2 ELSE 1 END) AS best_tier,
           max(CASE o.admin_tier WHEN 'max' THEN 3 WHEN 'pro' THEN 2 WHEN 'free' THEN 1 END) AS best_admin_tier,
           min(o.created_at) AS first_created,
           min(o.subscription_started_at) AS first_started,
           (array_agg(o.coupon_code) FILTER (WHERE o.coupon_code IS NOT NULL))[1] AS coupon_code,
           (array_agg(o.stripe_customer_id ORDER BY o.updated_at DESC) FILTER (WHERE o.stripe_customer_id IS NOT NULL))[1] AS stripe_customer_id
    FROM merge_map m JOIN app_users o ON o.user_id = m.old_id
    GROUP BY m.keep_id
)
UPDATE app_users k
SET tier = (ARRAY['free', 'pro', 'max'])[GREATEST(
               CASE k.tier WHEN 'max' THEN 3 WHEN 'pro' THEN 2 ELSE 1 END, grp.best_tier)],
    admin_tier = COALESCE(k.admin_tier, (ARRAY['free', 'pro', 'max'])[grp.best_admin_tier]),
    created_at = LEAST(k.created_at, grp.first_created),
    subscription_started_at = LEAST(k.subscription_started_at, grp.first_started),
    coupon_code = COALESCE(k.coupon_code, grp.coupon_code),
    stripe_customer_id = COALESCE(k.stripe_customer_id, grp.stripe_customer_id),
    updated_at = NOW()
FROM grp
WHERE k.user_id = grp.keep_id;

-- 3. Move everything that points at a dropped id.
UPDATE gateway_requests t SET user_id = m.keep_id FROM merge_map m WHERE t.user_id = m.old_id;
UPDATE desktop_access_tokens t SET user_id = m.keep_id FROM merge_map m WHERE t.user_id = m.old_id;
UPDATE desktop_auth_codes t SET user_id = m.keep_id FROM merge_map m WHERE t.user_id = m.old_id;
UPDATE web_chats t SET user_id = m.keep_id FROM merge_map m WHERE t.user_id = m.old_id;

-- 4. Aliases: dropped ids, and any alias that pointed at a dropped id.
UPDATE app_user_aliases a SET user_id = m.keep_id FROM merge_map m WHERE a.user_id = m.old_id;
INSERT INTO app_user_aliases (alias_id, user_id)
SELECT old_id, keep_id FROM merge_map
ON CONFLICT (alias_id) DO UPDATE SET user_id = EXCLUDED.user_id;

-- 5. Drop the merged rows.
DELETE FROM app_users u USING merge_map m WHERE u.user_id = m.old_id;

-- 6. Pin plans an admin set by hand that are still in place. A plan the
-- webhook already undid (tier no longer matches the admin's last choice) is
-- listed, not changed: set it again in the admin page after this runs.
CREATE TEMP TABLE last_admin_choice ON COMMIT DROP AS
SELECT DISTINCT ON (target)
       target, metadata->>'to' AS tier, created_at
FROM (
    SELECT COALESCE(a.user_id, l.target_user_id) AS target, l.metadata, l.created_at
    FROM admin_audit_log l
    LEFT JOIN app_user_aliases a ON a.alias_id = l.target_user_id
    WHERE l.action = 'tier_change'
      AND COALESCE(l.actor_email, '') <> 'stripe_webhook'
      AND l.metadata->>'to' IN ('free', 'pro', 'max')
) x
ORDER BY target, created_at DESC;

\echo '== Admin plan choices that were later undone (not changed here; set again in the admin page)'
SELECT c.target AS user_id, c.tier AS admin_chose, u.tier AS now, c.created_at AS chosen_at
FROM last_admin_choice c JOIN app_users u ON u.user_id = c.target
WHERE u.admin_tier IS NULL AND u.tier <> c.tier;

UPDATE app_users u
SET admin_tier = c.tier
FROM last_admin_choice c
WHERE u.user_id = c.target AND u.admin_tier IS NULL AND u.tier = c.tier;

-- 7. One row per email from now on.
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_key
    ON app_users (lower(email)) WHERE email <> '';

-- Checks: stop (and roll back) if anything is off.
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT 1 FROM app_users WHERE trim(email) <> ''
        GROUP BY lower(trim(email)) HAVING count(*) > 1) d;
    IF n > 0 THEN RAISE EXCEPTION 'still % duplicate emails', n; END IF;

    SELECT count(*) INTO n FROM gateway_requests g
    JOIN app_user_aliases a ON a.alias_id = g.user_id;
    IF n > 0 THEN RAISE EXCEPTION '% requests still point at a merged id', n; END IF;

    SELECT count(*) INTO n FROM app_user_aliases a
    JOIN app_users u ON u.user_id = a.alias_id;
    IF n > 0 THEN RAISE EXCEPTION '% aliases are also app_users rows', n; END IF;
END $$;

\echo '== After'
SELECT (SELECT count(*) FROM app_users) AS app_users,
       (SELECT count(*) FROM app_user_aliases) AS aliases,
       (SELECT count(*) FROM app_users WHERE admin_tier IS NOT NULL) AS pinned_plans;

\if :{?commit}
COMMIT;
\echo '== Committed.'
\else
ROLLBACK;
\echo '== Dry run: rolled back. Run again with -v commit=1 to keep it.'
\endif

ALTER TABLE master_user
  ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT CURRENT_TIMESTAMP;

UPDATE master_user
SET
  is_active = COALESCE(is_active, TRUE),
  is_admin = COALESCE(is_admin, FALSE),
  created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
  updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP);

UPDATE master_user
SET is_admin = TRUE
WHERE LOWER(user_name) IN ('admin', 'administrator', 'dileep');

WITH first_user AS (
  SELECT user_name
  FROM master_user
  ORDER BY user_name ASC
  LIMIT 1
)
UPDATE master_user
SET is_admin = TRUE
WHERE user_name = (SELECT user_name FROM first_user)
  AND NOT EXISTS (
    SELECT 1
    FROM master_user
    WHERE is_admin = TRUE
  );

CREATE TABLE IF NOT EXISTS master_user_rights (
  user_name varchar(50) NOT NULL REFERENCES master_user(user_name) ON DELETE CASCADE,
  screen_id varchar(80) NOT NULL,
  can_access boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_name, screen_id)
);

DO $$
BEGIN
  IF to_regclass('tran_userlog') IS NULL
    AND to_regclass('user_login_log') IS NOT NULL THEN
    ALTER TABLE user_login_log RENAME TO tran_userlog;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tran_userlog (
  id bigserial PRIMARY KEY,
  user_name varchar(50) NOT NULL,
  login_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  location_text varchar(255),
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  ip_address varchar(80),
  user_agent text
);

ALTER TABLE tran_userlog
  ADD COLUMN IF NOT EXISTS location_text varchar(500),
  ADD COLUMN IF NOT EXISTS latitude numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude numeric(10, 7),
  ADD COLUMN IF NOT EXISTS ip_address varchar(80),
  ADD COLUMN IF NOT EXISTS user_agent text;

ALTER TABLE tran_userlog
  ALTER COLUMN location_text TYPE varchar(500);

UPDATE tran_userlog
SET location_text = 'https://www.google.com/maps?q=' || latitude || ',' || longitude
WHERE latitude IS NOT NULL
  AND longitude IS NOT NULL
  AND (
    location_text IS NULL
    OR location_text = ''
    OR location_text !~* '^https?://'
  );

UPDATE tran_userlog
SET location_text = 'https://www.google.com/maps/search/?api=1&query=' || REPLACE(location_text, ' ', '%20')
WHERE latitude IS NULL
  AND longitude IS NULL
  AND location_text IS NOT NULL
  AND location_text <> ''
  AND location_text !~* '^https?://';

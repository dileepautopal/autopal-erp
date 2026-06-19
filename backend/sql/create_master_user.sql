CREATE TABLE IF NOT EXISTS master_user (
  user_name varchar(50) PRIMARY KEY
);

ALTER TABLE master_user
  ADD COLUMN IF NOT EXISTS pw varchar(255);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'master_user'
      AND column_name = 'Password'
  ) THEN
    UPDATE master_user
    SET pw = "Password"
    WHERE pw IS NULL;

    ALTER TABLE master_user
      DROP COLUMN "Password";
  END IF;
END $$;

UPDATE master_user
SET pw = ''
WHERE pw IS NULL;

ALTER TABLE master_user
  ALTER COLUMN pw TYPE varchar(255);

ALTER TABLE master_user
  ALTER COLUMN pw SET NOT NULL;

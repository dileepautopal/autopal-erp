BEGIN;

DO $$
DECLARE
  duplicate_group_count integer;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_group_count
  FROM (
    SELECT 1
    FROM master_customer
    GROUP BY
      LOWER(BTRIM(cust_name)),
      LOWER(BTRIM(corr_address)),
      corr_city_code
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_group_count > 0 THEN
    RAISE EXCEPTION
      'master_customer has % duplicate name/address/city group(s). Resolve those duplicates before creating the unique key.',
      duplicate_group_count;
  END IF;
END $$;

ALTER TABLE master_customer DROP CONSTRAINT IF EXISTS master_customer_cust_name_key;
ALTER TABLE master_customer DROP CONSTRAINT IF EXISTS uq_cust_name_city;
ALTER TABLE master_customer DROP CONSTRAINT IF EXISTS uq_customer_name_city;
ALTER TABLE master_customer DROP CONSTRAINT IF EXISTS uq_customer_name;

DELETE FROM pg_depend
WHERE classid = 'pg_class'::regclass
  AND objid = to_regclass('uq_customer_name')
  AND refclassid = 'pg_constraint'::regclass
  AND to_regclass('uq_customer_name') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE oid = pg_depend.refobjid
  );

DROP INDEX IF EXISTS uq_customer_name;

UPDATE master_customer
SET credit_days = 0
WHERE credit_days IS NULL;

ALTER TABLE master_customer
ALTER COLUMN credit_days SET DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS master_customer_name_address_city_uidx
ON master_customer (
  LOWER(BTRIM(cust_name)),
  LOWER(BTRIM(corr_address)),
  corr_city_code
);

COMMIT;

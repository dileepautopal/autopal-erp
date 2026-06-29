BEGIN;

ALTER TABLE master_trading_product_rate
ALTER COLUMN plant_name TYPE varchar(50);

UPDATE master_trading_product_rate rate
SET
  comp_code = CASE LOWER(BTRIM(product.category))
    WHEN 'head lamp' THEN 2
    WHEN 'halogen bulbs' THEN 1
    ELSE rate.comp_code
  END,
  family = COALESCE(NULLIF(product.category, ''), rate.family),
  unit_name = COALESCE(NULLIF(product.unit, ''), rate.unit_name),
  cat_desc = COALESCE(NULLIF(product.category, ''), rate.cat_desc)
FROM master_products product
WHERE LOWER(product.code) = LOWER(rate.product_code);

UPDATE master_trading_product_rate rate
SET plant_name = company.company_id
FROM master_company company
WHERE company.comp_code = rate.comp_code
  AND company.is_active = TRUE;

COMMIT;

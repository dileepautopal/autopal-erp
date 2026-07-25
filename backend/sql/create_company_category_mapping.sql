CREATE TABLE IF NOT EXISTS master_company_category_mapping (
  mapping_id bigserial PRIMARY KEY,
  category_key varchar(120) NOT NULL UNIQUE,
  category_name varchar(120) NOT NULL,
  comp_code smallint NOT NULL REFERENCES master_company(comp_code),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_master_company_category_mapping_comp_code
ON master_company_category_mapping (comp_code);

INSERT INTO master_company_category_mapping (
  category_key,
  category_name,
  comp_code,
  notes
)
SELECT
  'HEAD LAMP',
  'HEAD LAMP',
  company.comp_code,
  'WhatsApp Draft PI company selection'
FROM master_company company
WHERE company.is_active = TRUE
  AND REGEXP_REPLACE(UPPER(REPLACE(company.legal_name, 'M/s ', '')), '[^A-Z0-9]+', ' ', 'g')
    = 'AUTOLITE MANUFACTURING LIMITED'
ON CONFLICT (category_key) DO UPDATE
SET
  category_name = EXCLUDED.category_name,
  comp_code = EXCLUDED.comp_code,
  notes = EXCLUDED.notes,
  is_active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO master_company_category_mapping (
  category_key,
  category_name,
  comp_code,
  notes
)
SELECT
  'HALOGEN BULBS',
  'HALOGEN BULBS',
  company.comp_code,
  'WhatsApp Draft PI company selection'
FROM master_company company
WHERE company.is_active = TRUE
  AND REGEXP_REPLACE(UPPER(REPLACE(company.legal_name, 'M/s ', '')), '[^A-Z0-9]+', ' ', 'g')
    = 'AUTOLITE INDIA LIMITED'
ON CONFLICT (category_key) DO UPDATE
SET
  category_name = EXCLUDED.category_name,
  comp_code = EXCLUDED.comp_code,
  notes = EXCLUDED.notes,
  is_active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

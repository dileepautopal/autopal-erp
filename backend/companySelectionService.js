const DEFAULT_MAPPING_TABLE_NAME = 'master_company_category_mapping'

const toText = (value) => String(value ?? '').trim()

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const normalizeCategoryKey = (value) =>
  toText(value)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const getMappingTableName = (tableNames = {}) =>
  tableNames.companyCategoryMapping || DEFAULT_MAPPING_TABLE_NAME

const ensureCompanyCategoryMappingSchema = async (pool, tableNames = {}) => {
  const mappingTable = getMappingTableName(tableNames)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${mappingTable} (
      mapping_id bigserial PRIMARY KEY,
      category_key varchar(120) NOT NULL UNIQUE,
      category_name varchar(120) NOT NULL,
      comp_code smallint NOT NULL,
      notes text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_${mappingTable}_comp_code
    ON ${mappingTable} (comp_code)
  `)
}

const getCompanyDisplayName = (company) =>
  toText(company?.legal_name || company?.company_name)

const mapCompanyRow = (row) => ({
  compCode: toNumberValue(row.comp_code),
  companyId: row.company_id ?? '',
  companyName: row.company_name ?? '',
  legalName: row.legal_name ?? row.company_name ?? '',
  piPrefix: row.pi_prefix ?? '',
  stateCode: row.state_code ?? '',
})

const selectCompanyForProductCategories = async ({
  categories = [],
  pool,
  tableNames = {},
} = {}) => {
  const companyTable = tableNames.company
  const mappingTable = getMappingTableName(tableNames)
  const categoryKeys = Array.from(
    new Set(categories.map(normalizeCategoryKey).filter(Boolean)),
  )

  if (categoryKeys.length === 0) {
    return {
      errors: ['No matched product category was available for company selection.'],
      options: [],
      reason: 'No product category was available after product matching.',
      selectedCompany: null,
      status: 'NO_PRODUCTS',
      warnings: [],
    }
  }

  await ensureCompanyCategoryMappingSchema(pool, tableNames)

  const result = await pool.query(
    `
      SELECT
        mapping.category_key,
        mapping.category_name,
        company.comp_code,
        company.company_id,
        company.company_name,
        company.legal_name,
        company.pi_prefix,
        company.state_code
      FROM ${mappingTable} mapping
      INNER JOIN ${companyTable} company
        ON company.comp_code = mapping.comp_code
      WHERE mapping.is_active = TRUE
        AND company.is_active = TRUE
        AND mapping.category_key = ANY($1::text[])
      ORDER BY mapping.category_key ASC, company.comp_code ASC
    `,
    [categoryKeys],
  )
  const mappings = result.rows.map((row) => ({
    categoryKey: row.category_key,
    categoryName: row.category_name,
    company: mapCompanyRow(row),
  }))
  const foundKeys = new Set(mappings.map((mapping) => mapping.categoryKey))
  const missingKeys = categoryKeys.filter((categoryKey) => !foundKeys.has(categoryKey))

  if (missingKeys.length > 0) {
    return {
      errors: [
        `No company category mapping found for: ${missingKeys.join(', ')}.`,
      ],
      missingCategories: missingKeys,
      options: mappings,
      reason: 'Product category is not mapped to any active company.',
      selectedCompany: null,
      status: 'MAPPING_NOT_FOUND',
      warnings: [],
    }
  }

  const companiesByCode = new Map()

  for (const mapping of mappings) {
    const compCode = mapping.company.compCode

    if (!companiesByCode.has(compCode)) {
      companiesByCode.set(compCode, {
        categories: [],
        company: mapping.company,
      })
    }

    companiesByCode.get(compCode).categories.push(mapping.categoryName)
  }

  const companyOptions = Array.from(companiesByCode.values()).map((entry) => ({
    categories: entry.categories,
    company: entry.company,
  }))

  if (companyOptions.length > 1) {
    return {
      errors: [
        'This WhatsApp Order contains products belonging to multiple companies. Please split the order automatically or send for manual review.',
      ],
      options: companyOptions,
      reason: 'Matched product categories map to more than one company.',
      selectedCompany: null,
      splitOptions: [
        'Option 1: Automatically split into separate Draft PIs by company.',
        'Option 2: Manual Review.',
      ],
      status: 'MULTI_COMPANY_ORDER',
      warnings: ['Default action: Manual Review. Automatic split is not enabled in this milestone.'],
    }
  }

  const selected = companyOptions[0]

  return {
    errors: [],
    options: companyOptions,
    reason: `All matched categories map to ${getCompanyDisplayName(selected.company)}.`,
    selectedCompany: {
      comp_code: selected.company.compCode,
      company_id: selected.company.companyId,
      company_name: selected.company.companyName,
      legal_name: selected.company.legalName,
      pi_prefix: selected.company.piPrefix,
      state_code: selected.company.stateCode,
    },
    status: 'SELECTED',
    warnings: [],
  }
}

const selectCompanyForLineItems = async ({
  lineItems = [],
  pool,
  tableNames = {},
} = {}) =>
  selectCompanyForProductCategories({
    categories: lineItems.map((line) => line.productCategory || line.category),
    pool,
    tableNames,
  })

export {
  DEFAULT_MAPPING_TABLE_NAME,
  ensureCompanyCategoryMappingSchema,
  normalizeCategoryKey,
  selectCompanyForLineItems,
  selectCompanyForProductCategories,
}

import {
  clampLimit,
  escapeLikePattern,
  getSafeCompanyExpression,
  getSafeCustomerExpression,
  getStatusExpression,
  mapStatusFilter,
  normalizeTables,
  runReadOnlyQuery,
  toNumber,
  toText,
  validateDateRange,
} from './piIntelligenceUtils.js'

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50
const MAX_SEARCH_TEXT_LENGTH = 120

const normalizePINumber = (value) => {
  const text = toText(value).toUpperCase().replace(/\s+/g, '')
  const match = text.match(/^([A-Z]+-?)(\d{1,8})$/)

  if (!match) {
    return text
  }

  return `${match[1]}${String(Number(match[2])).padStart(4, '0')}`
}

const hasDateCriteria = (startDate, endDate) => Boolean(startDate || endDate)

const hasSearchCriteria = ({ company, customer, endDate, q, startDate, status }) =>
  Boolean(toText(q) || toText(company) || toText(customer) || toText(status) || hasDateCriteria(startDate, endDate))

const addLikeFilter = ({ fieldSql, filters, value, values }) => {
  const search = escapeLikePattern(value)

  values.push(`%${search}%`)
  filters.push(`${fieldSql} ILIKE $${values.length} ESCAPE '\\'`)
}

const addStatusFilter = ({ filters, status, values }) => {
  const mappedStatus = mapStatusFilter(status)

  if (!mappedStatus) {
    return {
      ok: false,
      message: 'Status must be open, pending, draft, final or closed.',
    }
  }

  values.push(mappedStatus)
  filters.push(`${getStatusExpression('m')} = $${values.length}`)

  return { ok: true }
}

const mapSearchRow = (row) => ({
  companyName: row.company_name ?? '',
  customerName: row.customer_name ?? '',
  grandTotal: toNumber(row.grand_total),
  piDate: row.pi_date ?? '',
  piNumber: row.pi_number ?? '',
  status: row.status ?? '',
})

export const searchPIs = async ({
  company = '',
  customer = '',
  endDate = '',
  limit = DEFAULT_SEARCH_LIMIT,
  q = '',
  queryable,
  startDate = '',
  status = '',
  tableNames,
}) => {
  const trimmedQuery = toText(q)

  if (!hasSearchCriteria({ company, customer, endDate, q, startDate, status })) {
    return {
      error: 'Please enter a PI number, customer, company, status or date range.',
      statusCode: 400,
    }
  }

  if (trimmedQuery.length > MAX_SEARCH_TEXT_LENGTH) {
    return {
      error: `Search text cannot exceed ${MAX_SEARCH_TEXT_LENGTH} characters.`,
      statusCode: 400,
    }
  }

  if (hasDateCriteria(startDate, endDate)) {
    const validation = validateDateRange({ endDate, startDate })

    if (!validation.ok) {
      return {
        error: validation.message,
        statusCode: 400,
      }
    }
  }

  if (trimmedQuery && trimmedQuery.length < 2) {
    return {
      error: 'Search text must be at least 2 characters.',
      statusCode: 400,
    }
  }

  const tables = normalizeTables(tableNames)
  const filters = ['m.is_active = TRUE']
  const values = []
  const companyExpression = getSafeCompanyExpression('c')
  const customerExpression = getSafeCustomerExpression('m')
  const statusExpression = getStatusExpression('m')

  if (trimmedQuery) {
    const normalizedPINumber = normalizePINumber(trimmedQuery)
    const likeQuery = escapeLikePattern(trimmedQuery)
    const likePINumber = escapeLikePattern(normalizedPINumber)

    values.push(normalizedPINumber, `%${likeQuery}%`, `%${likePINumber}%`)
    filters.push(`(
      UPPER(m.pi_series || LPAD(m.pi_no::text, 4, '0')) = UPPER($${values.length - 2})
      OR ${customerExpression} ILIKE $${values.length - 1} ESCAPE '\\'
      OR ${companyExpression} ILIKE $${values.length} ESCAPE '\\'
      OR m.pi_series || LPAD(m.pi_no::text, 4, '0') ILIKE $${values.length} ESCAPE '\\'
    )`)
  }

  if (customer) {
    addLikeFilter({
      fieldSql: customerExpression,
      filters,
      value: customer,
      values,
    })
  }

  if (company) {
    addLikeFilter({
      fieldSql: companyExpression,
      filters,
      value: company,
      values,
    })
  }

  if (status) {
    const statusResult = addStatusFilter({
      filters,
      status,
      values,
    })

    if (!statusResult.ok) {
      return {
        error: statusResult.message,
        statusCode: 400,
      }
    }
  }

  if (hasDateCriteria(startDate, endDate)) {
    values.push(startDate, endDate)
    filters.push(`m.pi_date::date BETWEEN $${values.length - 1}::date AND $${values.length}::date`)
  }

  const safeLimit = clampLimit(limit, {
    defaultLimit: DEFAULT_SEARCH_LIMIT,
    maxLimit: MAX_SEARCH_LIMIT,
  })

  values.push(safeLimit)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        ${customerExpression} AS customer_name,
        ${companyExpression} AS company_name,
        ${statusExpression} AS status,
        COALESCE(m.grand_total, 0)::numeric AS grand_total
      FROM ${tables.piMaster} m
      LEFT JOIN ${tables.company} c
        ON c.comp_code = m.comp_code
      WHERE ${filters.join('\n        AND ')}
      ORDER BY m.pi_date DESC, m.created_at DESC, m.pi_no DESC
      LIMIT $${values.length}
    `,
    values,
  )

  return {
    limit: safeLimit,
    q: trimmedQuery,
    rows: result.rows.map(mapSearchRow),
    success: true,
  }
}

const mapDetailMaster = (row) => ({
  companyName: row.company_name ?? '',
  customerName: row.customer_name ?? '',
  grandTotal: toNumber(row.grand_total),
  piDate: row.pi_date ?? '',
  piNumber: row.pi_number ?? '',
  status: row.status ?? '',
})

const mapDetailLine = (row) => ({
  amount: toNumber(row.amount),
  productCode: row.product_code ?? '',
  productDescription: '',
  quantity: toNumber(row.quantity),
  rate: toNumber(row.rate),
})

export const getSafePIDetail = async ({
  piNumber,
  queryable,
  tableNames,
}) => {
  const normalizedPINumber = normalizePINumber(piNumber)

  if (!normalizedPINumber || normalizedPINumber.length < 3) {
    return {
      error: 'PI number is required.',
      statusCode: 400,
    }
  }

  const tables = normalizeTables(tableNames)
  const companyExpression = getSafeCompanyExpression('c')
  const customerExpression = getSafeCustomerExpression('m')
  const statusExpression = getStatusExpression('m')
  const masterResult = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        m.pi_no,
        m.pi_series,
        m.comp_code,
        m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        ${customerExpression} AS customer_name,
        ${companyExpression} AS company_name,
        ${statusExpression} AS status,
        COALESCE(m.grand_total, 0)::numeric AS grand_total
      FROM ${tables.piMaster} m
      LEFT JOIN ${tables.company} c
        ON c.comp_code = m.comp_code
      WHERE m.is_active = TRUE
        AND UPPER(m.pi_series || LPAD(m.pi_no::text, 4, '0')) = UPPER($1)
      ORDER BY m.pi_date DESC, m.created_at DESC, m.pi_no DESC
      LIMIT 2
    `,
    [normalizedPINumber],
  )

  if (masterResult.rows.length === 0) {
    return {
      error: 'PI number not found.',
      statusCode: 404,
    }
  }

  if (masterResult.rows.length > 1) {
    return {
      error: 'Multiple PIs matched this number. Please search with company context.',
      statusCode: 422,
    }
  }

  const master = masterResult.rows[0]
  const lineResult = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        t.product_code,
        COALESCE(t.quantity, 0)::numeric AS quantity,
        COALESCE(t.rate, 0)::numeric AS rate,
        COALESCE(t.amount, 0)::numeric AS amount
      FROM ${tables.piTran} t
      WHERE t.is_active = TRUE
        AND t.pi_no = $1
        AND t.pi_series = $2
        AND t.comp_code = $3
      ORDER BY t.product_code ASC
    `,
    [master.pi_no, master.pi_series, master.comp_code],
  )

  return {
    ...mapDetailMaster(master),
    lines: lineResult.rows.map(mapDetailLine),
    success: true,
  }
}

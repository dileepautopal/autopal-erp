import {
  getCommercialComparison,
  getCompanyCommercialIntelligence,
  getCustomerCommercialIntelligence,
  getInactiveCustomers,
  getProductCommercialIntelligence,
  getReactivatedCustomers,
} from './commercialIntelligenceService.js'
import { resolveCommercialPeriod } from './commercialIntelligenceUtils.js'
import { getExecutiveCockpit } from './executiveCockpitService.js'
import {
  EXECUTIVE_DISCLAIMER,
  EXECUTIVE_THRESHOLDS,
  getPercentage,
  normalizeExecutiveTables,
  safeRound,
} from './executiveCockpitUtils.js'
import {
  EXECUTIVE_DRILLDOWN_LIMITS,
  EXECUTIVE_DRILLDOWN_TYPES,
  buildAppliedFilters,
  clampDrillDownLimit,
  getDrillDownMeta,
  getPagination,
  getSearchMeta,
  hasUnsafeSearchText,
  makeLike,
  makeSummaryCard,
  mapPILineRow,
  mapPIRow,
  normalizeDrillDownType,
  normalizeIntegerIdentifier,
  normalizePINumber,
  normalizeProductCode,
  normalizeStatus,
  takeLimit,
  todayOrDefault,
} from './executiveDrillDownUtils.js'
import {
  escapeLikePattern,
  getSafeCompanyExpression,
  getSafeCustomerExpression,
  getStatusExpression,
  runReadOnlyQuery,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'

const searchFields = ['all', 'pi', 'customer', 'product', 'company', 'status']

const responseFromRows = ({
  filters = {},
  limit,
  nextActions = [],
  period,
  rows,
  summary = {},
  type,
}) => {
  const pagination = getPagination({ limit, rows })

  return {
    ...getDrillDownMeta(type),
    filters: buildAppliedFilters(filters),
    nextActions,
    pagination,
    period,
    rows: takeLimit(rows, limit),
    summary,
    success: true,
  }
}

const getRange = ({
  comparisonMode,
  endDate,
  period,
  startDate,
  today,
}) => {
  const range = resolveCommercialPeriod({
    comparisonMode,
    endDate,
    period,
    startDate,
    today,
  })

  if (!range.ok) {
    return {
      error: range.message,
      statusCode: 400,
    }
  }

  return range
}

const getTypePeriod = (type, options) => {
  const today = todayOrDefault(options.today)

  if (type === 'today-pis' || type === 'no-today-activity') {
    return getRange({ ...options, period: 'today', today })
  }

  if (type === 'yesterday-pis') {
    return getRange({ ...options, period: 'yesterday', today })
  }

  if (type === 'week-pis') {
    return getRange({ ...options, period: 'this-week', today })
  }

  if (type === 'month-pis') {
    return getRange({ ...options, period: 'this-month', today })
  }

  if (type === 'previous-month-pis') {
    return getRange({ ...options, period: 'previous-month', today })
  }

  return getRange({ ...options, today })
}

const getPIFilters = ({ filters = {}, piTranTable, status = '' } = {}) => {
  const safeFilters = []
  const values = []
  const customerExpression = getSafeCustomerExpression('m')
  const companyExpression = getSafeCompanyExpression('c')
  const statusExpression = getStatusExpression('m')
  const mappedStatus = status ? normalizeStatus(status) : ''

  if (mappedStatus) {
    values.push(mappedStatus)
    safeFilters.push(`${statusExpression} = $${values.length}`)
  }

  const customerCode = normalizeIntegerIdentifier(filters.customerCode)

  if (customerCode) {
    values.push(customerCode)
    safeFilters.push('m.cust_code = $' + values.length)
  } else if (filters.customerName) {
    values.push(makeLike(filters.customerName))
    safeFilters.push(`${customerExpression} ILIKE $${values.length} ESCAPE '\\'`)
  }

  const companyCode = normalizeIntegerIdentifier(filters.companyCode)

  if (companyCode) {
    values.push(companyCode)
    safeFilters.push('m.comp_code = $' + values.length)
  } else if (filters.companyName) {
    values.push(makeLike(filters.companyName))
    safeFilters.push(`${companyExpression} ILIKE $${values.length} ESCAPE '\\'`)
  }

  if (filters.productCode) {
    values.push(normalizeProductCode(filters.productCode))
    safeFilters.push(`EXISTS (
      SELECT 1
      FROM ${piTranTable} tx
      WHERE tx.is_active = TRUE
        AND tx.pi_no = m.pi_no
        AND tx.pi_series = m.pi_series
        AND tx.comp_code = m.comp_code
        AND UPPER(BTRIM(tx.product_code)) = $${values.length}
    )`)
  }

  if (filters.piNumber) {
    values.push(normalizePINumber(filters.piNumber))
    safeFilters.push(`UPPER(m.pi_series || LPAD(m.pi_no::text, 4, '0')) = UPPER($${values.length})`)
  }

  const minValue = Number(filters.minValue)

  if (Number.isFinite(minValue)) {
    values.push(minValue)
    safeFilters.push(`COALESCE(m.grand_total, 0) >= $${values.length}::numeric`)
  }

  const maxValue = Number(filters.maxValue)

  if (Number.isFinite(maxValue)) {
    values.push(maxValue)
    safeFilters.push(`COALESCE(m.grand_total, 0) <= $${values.length}::numeric`)
  }

  if (filters.q && !hasUnsafeSearchText(filters.q)) {
    const normalizedPI = normalizePINumber(filters.q)
    values.push(normalizedPI, makeLike(filters.q))
    safeFilters.push(`(
      UPPER(m.pi_series || LPAD(m.pi_no::text, 4, '0')) = UPPER($${values.length - 1})
      OR ${customerExpression} ILIKE $${values.length} ESCAPE '\\'
      OR ${companyExpression} ILIKE $${values.length} ESCAPE '\\'
    )`)
  }

  return {
    filters: safeFilters,
    values,
  }
}

const getPIRows = async ({
  filters = {},
  limit,
  period,
  queryable,
  sort = 'date-desc',
  status = '',
  tableNames,
}) => {
  const tables = normalizeExecutiveTables(tableNames)
  const companyExpression = getSafeCompanyExpression('c')
  const customerExpression = getSafeCustomerExpression('m')
  const statusExpression = getStatusExpression('m')
  const filterState = getPIFilters({ filters, piTranTable: tables.piTran, status })
  const values = [period.startDate, period.endDate, ...filterState.values]
  const whereFilters = [
    'm.is_active = TRUE',
    'm.pi_date::date BETWEEN $1::date AND $2::date',
    ...filterState.filters.map((item) =>
      item.replace(/\$(\d+)/g, (_match, numberText) => `$${Number(numberText) + 2}`),
    ),
  ]
  const orderSql =
    sort === 'value-desc'
      ? 'COALESCE(m.grand_total, 0) DESC, m.pi_date DESC, m.pi_no DESC'
      : sort === 'value-asc'
        ? 'COALESCE(m.grand_total, 0) ASC, m.pi_date DESC, m.pi_no DESC'
        : 'm.pi_date DESC, m.created_at DESC, m.pi_no DESC'

  values.push(limit + 1)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END AS customer_code,
        ${customerExpression} AS customer_name,
        m.comp_code::int AS company_code,
        ${companyExpression} AS company_name,
        ${statusExpression} AS status,
        COALESCE(m.grand_total, 0)::numeric AS grand_total
      FROM ${tables.piMaster} m
      LEFT JOIN ${tables.company} c
        ON c.comp_code = m.comp_code
      WHERE ${whereFilters.join('\n        AND ')}
      ORDER BY ${orderSql}
      LIMIT $${values.length}
    `,
    values,
  )

  return result.rows.map(mapPIRow)
}

const getProductLineRows = async ({
  filters = {},
  limit,
  period,
  queryable,
  tableNames,
}) => {
  const tables = normalizeExecutiveTables(tableNames)
  const companyExpression = getSafeCompanyExpression('c')
  const customerExpression = getSafeCustomerExpression('m')
  const statusExpression = getStatusExpression('m')
  const values = [period.startDate, period.endDate]
  const filtersSql = [
    'COALESCE(t.is_active, TRUE) = TRUE',
    'm.is_active = TRUE',
    'm.pi_date::date BETWEEN $1::date AND $2::date',
  ]
  const productCode = normalizeProductCode(filters.productCode)

  if (productCode && filters.productDescription) {
    values.push(productCode, makeLike(filters.productDescription))
    filtersSql.push(`(
      UPPER(BTRIM(t.product_code)) = $${values.length - 1}
      OR COALESCE(NULLIF(BTRIM(p.description), ''), NULLIF(BTRIM(t.product_code), ''), 'Unknown Product') ILIKE $${values.length} ESCAPE '\\'
    )`)
  } else if (productCode) {
    values.push(productCode)
    filtersSql.push(`UPPER(BTRIM(t.product_code)) = $${values.length}`)
  } else if (filters.productDescription) {
    values.push(makeLike(filters.productDescription))
    filtersSql.push(`COALESCE(NULLIF(BTRIM(p.description), ''), NULLIF(BTRIM(t.product_code), ''), 'Unknown Product') ILIKE $${values.length} ESCAPE '\\'`)
  }

  if (filters.piNumber) {
    values.push(normalizePINumber(filters.piNumber))
    filtersSql.push(`UPPER(m.pi_series || LPAD(m.pi_no::text, 4, '0')) = UPPER($${values.length})`)
  }

  values.push(limit + 1)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END AS customer_code,
        ${customerExpression} AS customer_name,
        m.comp_code::int AS company_code,
        ${companyExpression} AS company_name,
        ${statusExpression} AS status,
        t.product_code,
        COALESCE(NULLIF(BTRIM(p.description), ''), NULLIF(BTRIM(t.product_code), ''), 'Unknown Product') AS product_description,
        COALESCE(t.quantity, 0)::numeric AS quantity,
        COALESCE(t.rate, 0)::numeric AS rate,
        COALESCE(t.amount, COALESCE(t.quantity, 0) * COALESCE(t.rate, 0))::numeric AS amount
      FROM ${tables.piTran} t
      JOIN ${tables.piMaster} m
        ON m.pi_no = t.pi_no
       AND m.pi_series = t.pi_series
       AND m.comp_code = t.comp_code
      LEFT JOIN ${tables.company} c
        ON c.comp_code = m.comp_code
      LEFT JOIN ${tables.product} p
        ON UPPER(BTRIM(p.code)) = UPPER(BTRIM(t.product_code))
      WHERE ${filtersSql.join('\n        AND ')}
      ORDER BY m.pi_date DESC, m.pi_no DESC, t.product_code ASC
      LIMIT $${values.length}
    `,
    values,
  )

  return result.rows.map(mapPILineRow)
}

const getSafePIDetailRows = async ({
  piNumber,
  queryable,
  tableNames,
}) => {
  const tables = normalizeExecutiveTables(tableNames)
  const normalizedPINumber = normalizePINumber(piNumber)

  if (!normalizedPINumber || normalizedPINumber.length < 3) {
    return {
      message: 'PI number is required.',
      statusCode: 400,
      success: false,
    }
  }

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
        CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END AS customer_code,
        ${customerExpression} AS customer_name,
        m.comp_code::int AS company_code,
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
      message: 'PI number not found.',
      statusCode: 404,
      success: false,
    }
  }

  if (masterResult.rows.length > 1) {
    return {
      message: 'Multiple PIs matched this number. Please search with company context.',
      statusCode: 422,
      success: false,
    }
  }

  const master = masterResult.rows[0]
  const lines = await getProductLineRows({
    filters: {
      piNumber: normalizedPINumber,
    },
    limit: EXECUTIVE_DRILLDOWN_LIMITS.maxRows,
    period: {
      endDate: master.pi_date,
      startDate: master.pi_date,
    },
    queryable,
    tableNames,
  })

  return {
    master: mapPIRow(master),
    rows: lines,
    success: true,
  }
}

const findByCodeOrName = (rows, codeKey, nameKey, filters = {}) => {
  const code = normalizeIntegerIdentifier(filters[codeKey])

  if (code) {
    return rows.find((row) => Number(row[codeKey]) === code) ?? null
  }

  const name = toText(filters[nameKey]).toLowerCase()

  if (name) {
    return rows.find((row) => toText(row[nameKey]).toLowerCase() === name) ??
      rows.find((row) => toText(row[nameKey]).toLowerCase().includes(name)) ??
      null
  }

  return rows[0] ?? null
}

const makePINextActions = (rows) =>
  takeLimit(rows, 10).map((row) => ({
    filters: {
      piNumber: row.piNumber,
    },
    label: `Open ${row.piNumber}`,
    type: 'pi-detail',
  }))

const getPISummary = (rows) => ({
  cards: [
    makeSummaryCard('PI Count', rows.length, 'number'),
    makeSummaryCard(
      'PI Value',
      safeRound(rows.reduce((total, row) => total + toNumber(row.grandTotal), 0)),
      'currency',
    ),
  ],
})

const getProductLineSummary = (rows) => ({
  cards: [
    makeSummaryCard('PI Line Count', rows.length, 'number'),
    makeSummaryCard(
      'Total Quantity',
      safeRound(rows.reduce((total, row) => total + toNumber(row.quantity), 0)),
      'number',
    ),
    makeSummaryCard(
      'PI Line Value',
      safeRound(rows.reduce((total, row) => total + toNumber(row.amount), 0)),
      'currency',
    ),
  ],
})

const getCustomerDetail = async ({ filters, limit, options, period, type }) => {
  const customers = await getCustomerCommercialIntelligence({
    ...options,
    limit: EXECUTIVE_DRILLDOWN_LIMITS.customerRows,
    period: 'custom',
    startDate: period.startDate,
    endDate: period.endDate,
  })
  const row = findByCodeOrName(customers.rows ?? [], 'customerCode', 'customerName', filters)

  if (!row) {
    return {
      ...getDrillDownMeta(type),
      message: 'Customer not found for the selected period.',
      period,
      rows: [],
      statusCode: 404,
      success: false,
    }
  }

  const rows = await getPIRows({
    filters: {
      customerCode: row.customerCode,
      customerName: row.customerName,
    },
    limit,
    period,
    queryable: options.queryable,
    tableNames: options.tableNames,
  })

  return responseFromRows({
    filters: {
      customerCode: row.customerCode,
      customerName: row.customerName,
    },
    limit,
    nextActions: makePINextActions(rows),
    period,
    rows,
    summary: {
      cards: [
        makeSummaryCard('Customer', row.customerName),
        makeSummaryCard('Customer Code', row.customerCode ?? '-'),
        makeSummaryCard('PI Count', row.currentPICount, 'number'),
        makeSummaryCard('PI Value', row.currentPIValue, 'currency'),
        makeSummaryCard('Average PI Value', row.averagePIValue, 'currency'),
        makeSummaryCard('Highest PI', row.highestPIValue, 'currency'),
        makeSummaryCard('Lowest PI', row.lowestPIValue, 'currency'),
        makeSummaryCard('Open PI Count', row.openPICount, 'number'),
        makeSummaryCard('Final PI Count', row.finalPICount, 'number'),
        makeSummaryCard('Share %', row.shareOfTotalPIValue, 'number'),
        makeSummaryCard('Classification', row.classification),
        makeSummaryCard('Last PI Date', row.lastPIDate, 'date'),
      ],
      detail: row,
    },
    type,
  })
}

const getProductDetail = async ({ filters, limit, options, period, type }) => {
  const products = await getProductCommercialIntelligence({
    ...options,
    limit: EXECUTIVE_DRILLDOWN_LIMITS.productRows,
    period: 'custom',
    startDate: period.startDate,
    endDate: period.endDate,
  })
  const row = findByCodeOrName(products.rows ?? [], 'productCode', 'productDescription', filters)

  if (!row) {
    return {
      ...getDrillDownMeta(type),
      message: 'Product not found for the selected period.',
      period,
      rows: [],
      statusCode: 404,
      success: false,
    }
  }

  const rows = await getProductLineRows({
    filters: {
      productCode: row.productCode,
    },
    limit,
    period,
    queryable: options.queryable,
    tableNames: options.tableNames,
  })

  return responseFromRows({
    filters: {
      productCode: row.productCode,
      productDescription: row.productDescription,
    },
    limit,
    nextActions: makePINextActions(rows),
    period,
    rows,
    summary: {
      cards: [
        makeSummaryCard('Product Code', row.productCode),
        makeSummaryCard('Product', row.productDescription),
        makeSummaryCard('PI Line Count', row.lineCount, 'number'),
        makeSummaryCard('Total Quantity', row.totalQuantity, 'number'),
        makeSummaryCard('PI Line Value', row.totalPILineValue, 'currency'),
        makeSummaryCard('Average Rate', row.averageRate, 'currency'),
        makeSummaryCard('Distinct PIs', row.distinctPIs, 'number'),
        makeSummaryCard('Distinct Customers', row.distinctCustomers, 'number'),
        makeSummaryCard('Share %', row.shareOfTotalPILineValue, 'number'),
        makeSummaryCard('Classification', row.classification),
        makeSummaryCard('Latest PI Date', row.latestPIDate, 'date'),
      ],
      detail: row,
    },
    type,
  })
}

const getCompanyDetail = async ({ filters, limit, options, period, type }) => {
  const companies = await getCompanyCommercialIntelligence({
    ...options,
    limit: EXECUTIVE_DRILLDOWN_LIMITS.companyRows,
    period: 'custom',
    startDate: period.startDate,
    endDate: period.endDate,
  })
  const row = findByCodeOrName(companies.rows ?? [], 'companyCode', 'companyName', filters)

  if (!row) {
    return {
      ...getDrillDownMeta(type),
      message: 'Company not found for the selected period.',
      period,
      rows: [],
      statusCode: 404,
      success: false,
    }
  }

  const rows = await getPIRows({
    filters: {
      companyCode: row.companyCode,
    },
    limit,
    period,
    queryable: options.queryable,
    tableNames: options.tableNames,
  })

  return responseFromRows({
    filters: {
      companyCode: row.companyCode,
      companyName: row.companyName,
    },
    limit,
    nextActions: makePINextActions(rows),
    period,
    rows,
    summary: {
      cards: [
        makeSummaryCard('Company Code', row.companyCode),
        makeSummaryCard('Company', row.companyName),
        makeSummaryCard('PI Count', row.currentPICount, 'number'),
        makeSummaryCard('PI Value', row.currentPIValue, 'currency'),
        makeSummaryCard('Average PI Value', row.averagePIValue, 'currency'),
        makeSummaryCard('Open PI Count', row.openPICount, 'number'),
        makeSummaryCard('Final PI Count', row.finalPICount, 'number'),
        makeSummaryCard('Share %', row.shareOfTotalPIValue, 'number'),
        makeSummaryCard('Last PI Date', row.lastPIDate, 'date'),
      ],
      detail: row,
    },
    type,
  })
}

const getPeriodComparison = async ({ options, period, type }) => {
  const comparison = await getCommercialComparison({
    ...options,
    period: 'custom',
    startDate: period.startDate,
    endDate: period.endDate,
  })

  if (!comparison.success) {
    return comparison
  }

  return responseFromRows({
    filters: {},
    limit: 2,
    period,
    rows: [
      {
        count: comparison.comparison.current.count,
        label: comparison.period.label,
        value: comparison.comparison.current.value,
      },
      {
        count: comparison.comparison.previous.count,
        label: comparison.comparisonPeriod.label,
        value: comparison.comparison.previous.value,
      },
    ],
    summary: {
      cards: [
        makeSummaryCard('Current PI Count', comparison.comparison.current.count, 'number'),
        makeSummaryCard('Current PI Value', comparison.comparison.current.value, 'currency'),
        makeSummaryCard('Previous PI Count', comparison.comparison.previous.count, 'number'),
        makeSummaryCard('Previous PI Value', comparison.comparison.previous.value, 'currency'),
        makeSummaryCard('Value Change %', comparison.comparison.valueChange.changePercentage ?? 'Unavailable'),
      ],
      comparison: comparison.comparison,
    },
    type,
  })
}

export const getExecutiveDrillDown = async ({
  comparisonMode,
  endDate,
  filters = {},
  limit,
  period = 'this-month',
  queryable,
  startDate,
  tableNames,
  today,
  type,
}) => {
  const normalizedType = normalizeDrillDownType(type)

  if (!EXECUTIVE_DRILLDOWN_TYPES.has(normalizedType)) {
    return {
      message: 'Unsupported executive drill-down type.',
      statusCode: 400,
      success: false,
      type: normalizedType,
    }
  }

  const range = getTypePeriod(normalizedType, {
    comparisonMode,
    endDate,
    period,
    startDate,
    today,
  })

  if (!range.ok) {
    return {
      message: range.error,
      statusCode: range.statusCode ?? 400,
      success: false,
      type: normalizedType,
    }
  }

  const currentPeriod = range.period
  const safeLimit = clampDrillDownLimit(
    limit ?? filters.limit,
    normalizedType.includes('customer')
      ? EXECUTIVE_DRILLDOWN_LIMITS.customerRows
      : normalizedType.includes('product')
        ? EXECUTIVE_DRILLDOWN_LIMITS.productRows
        : normalizedType.includes('company')
          ? EXECUTIVE_DRILLDOWN_LIMITS.companyRows
          : EXECUTIVE_DRILLDOWN_LIMITS.maxRows,
  )
  const options = {
    comparisonMode: comparisonMode || 'previous-equivalent',
    queryable,
    tableNames,
    today,
  }

  if (normalizedType === 'pi-detail') {
    const detail = await getSafePIDetailRows({
      piNumber: filters.piNumber,
      queryable,
      tableNames,
    })

    if (!detail.success) {
      return {
        ...getDrillDownMeta(normalizedType),
        message: detail.message,
        statusCode: detail.statusCode,
        success: false,
      }
    }

    return responseFromRows({
      filters: {
        piNumber: detail.master.piNumber,
      },
      limit: EXECUTIVE_DRILLDOWN_LIMITS.maxRows,
      period: {
        endDate: detail.master.piDate,
        label: 'PI Date',
        startDate: detail.master.piDate,
      },
      rows: detail.rows,
      summary: {
        cards: [
          makeSummaryCard('PI Number', detail.master.piNumber),
          makeSummaryCard('PI Date', detail.master.piDate, 'date'),
          makeSummaryCard('Customer', detail.master.customerName),
          makeSummaryCard('Company', detail.master.companyName),
          makeSummaryCard('Status', detail.master.status),
          makeSummaryCard('Grand Total', detail.master.grandTotal, 'currency'),
        ],
        detail: detail.master,
      },
      type: normalizedType,
    })
  }

  if (['top-customer', 'customer-concentration', 'customer-detail'].includes(normalizedType)) {
    return getCustomerDetail({
      filters,
      limit: safeLimit,
      options,
      period: currentPeriod,
      type: normalizedType,
    })
  }

  if (['top-product', 'product-concentration', 'product-detail'].includes(normalizedType)) {
    return getProductDetail({
      filters,
      limit: safeLimit,
      options,
      period: currentPeriod,
      type: normalizedType,
    })
  }

  if (['top-company', 'company-detail'].includes(normalizedType)) {
    return getCompanyDetail({
      filters,
      limit: safeLimit,
      options,
      period: currentPeriod,
      type: normalizedType,
    })
  }

  if (normalizedType === 'month-comparison') {
    return getPeriodComparison({
      options,
      period: currentPeriod,
      type: normalizedType,
    })
  }

  if (normalizedType === 'inactive-customers') {
    const inactive = await getInactiveCustomers({
      days: EXECUTIVE_THRESHOLDS.customerInactivityDays,
      limit: safeLimit,
      queryable,
      tableNames,
      today: todayOrDefault(today),
    })

    return responseFromRows({
      filters: {
        days: inactive.days,
      },
      limit: safeLimit,
      period: inactive.window ?? currentPeriod,
      rows: inactive.rows ?? [],
      summary: {
        cards: [makeSummaryCard('Inactive Customers', inactive.rows?.length ?? 0, 'number')],
      },
      type: normalizedType,
    })
  }

  if (normalizedType === 'reactivated-customers') {
    const reactivated = await getReactivatedCustomers({
      days: EXECUTIVE_THRESHOLDS.customerInactivityDays,
      limit: safeLimit,
      queryable,
      tableNames,
      today: todayOrDefault(today),
    })

    return responseFromRows({
      filters: {
        days: reactivated.days,
      },
      limit: safeLimit,
      period: reactivated.window ?? currentPeriod,
      rows: reactivated.rows ?? [],
      summary: {
        cards: [makeSummaryCard('Reactivated Customers', reactivated.rows?.length ?? 0, 'number')],
      },
      type: normalizedType,
    })
  }

  if (['growing-customers', 'declining-customers', 'new-customers'].includes(normalizedType)) {
    const segment =
      normalizedType === 'growing-customers'
        ? 'growing'
        : normalizedType === 'declining-customers'
          ? 'declining'
          : 'new'
    const customers = await getCustomerCommercialIntelligence({
      ...options,
      limit: safeLimit,
      period: 'custom',
      segment,
      startDate: currentPeriod.startDate,
      endDate: currentPeriod.endDate,
    })

    return responseFromRows({
      filters: {
        segment,
      },
      limit: safeLimit,
      period: currentPeriod,
      rows: customers.rows ?? [],
      summary: {
        cards: [makeSummaryCard('Customer Count', customers.rows?.length ?? 0, 'number')],
      },
      type: normalizedType,
    })
  }

  if (normalizedType === 'large-pi') {
    const cockpit = await getExecutiveCockpit({
      comparisonMode,
      endDate,
      period,
      queryable,
      startDate,
      tableNames,
      today,
    })
    const piNumber = filters.piNumber || cockpit.largePIs?.[0]?.piNumber

    return getExecutiveDrillDown({
      comparisonMode,
      filters: {
        piNumber,
      },
      period,
      queryable,
      tableNames,
      today,
      type: 'pi-detail',
    })
  }

  if (normalizedType === 'highest-pi' || normalizedType === 'lowest-pi') {
    const rows = await getPIRows({
      filters,
      limit: 1,
      period: currentPeriod,
      queryable,
      sort: normalizedType === 'highest-pi' ? 'value-desc' : 'value-asc',
      tableNames,
    })

    return responseFromRows({
      filters,
      limit: 1,
      nextActions: makePINextActions(rows),
      period: currentPeriod,
      rows,
      summary: getPISummary(rows),
      type: normalizedType,
    })
  }

  if (normalizedType === 'daily-trend-date') {
    const date = toText(filters.date)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        ...getDrillDownMeta(normalizedType),
        message: 'A valid trend date is required.',
        statusCode: 400,
        success: false,
      }
    }

    const rows = await getPIRows({
      filters,
      limit: safeLimit,
      period: {
        endDate: date,
        label: 'Selected Date',
        startDate: date,
      },
      queryable,
      tableNames,
    })

    return responseFromRows({
      filters: {
        date,
      },
      limit: safeLimit,
      nextActions: makePINextActions(rows),
      period: {
        endDate: date,
        label: 'Selected Date',
        startDate: date,
      },
      rows,
      summary: getPISummary(rows),
      type: normalizedType,
    })
  }

  const status =
    normalizedType === 'open-pis'
      ? 'open'
      : normalizedType === 'final-pis'
        ? 'final'
        : ''

  const piListTypes = [
    'today-pis',
    'yesterday-pis',
    'week-pis',
    'month-pis',
    'previous-month-pis',
    'open-pis',
    'final-pis',
    'no-today-activity',
    'consecutive-no-pi-activity',
  ]

  if (piListTypes.includes(normalizedType)) {
    const rows = await getPIRows({
      filters,
      limit: safeLimit,
      period: currentPeriod,
      queryable,
      status,
      tableNames,
    })

    return responseFromRows({
      filters: {
        ...filters,
        status,
      },
      limit: safeLimit,
      nextActions: makePINextActions(rows),
      period: currentPeriod,
      rows,
      summary: getPISummary(rows),
      type: normalizedType,
    })
  }

  return {
    message: 'Executive drill-down type is not yet available.',
    statusCode: 422,
    success: false,
    type: normalizedType,
  }
}

export const searchExecutiveData = async ({
  category = 'all',
  endDate = '',
  limit,
  maxValue,
  minValue,
  q = '',
  queryable,
  startDate = '',
  status = '',
  tableNames,
}) => {
  const safeCategory = searchFields.includes(toText(category).toLowerCase())
    ? toText(category).toLowerCase()
    : 'all'
  const safeLimit = clampDrillDownLimit(limit, EXECUTIVE_DRILLDOWN_LIMITS.searchRows)
  const trimmedQuery = toText(q)

  if (hasUnsafeSearchText(trimmedQuery)) {
    return {
      message: 'Search text cannot exceed 120 characters.',
      statusCode: 400,
      success: false,
    }
  }

  if (
    !trimmedQuery &&
    !status &&
    !startDate &&
    !endDate &&
    !Number.isFinite(Number(minValue)) &&
    !Number.isFinite(Number(maxValue))
  ) {
    return {
      message: 'Enter a PI number, customer, product, company, status, date or amount criterion.',
      statusCode: 400,
      success: false,
    }
  }

  if ((startDate && !endDate) || (!startDate && endDate)) {
    return {
      message: 'Start date and end date are both required for date search.',
      statusCode: 400,
      success: false,
    }
  }

  if (startDate && endDate) {
    const range = getRange({
      endDate,
      period: 'custom',
      startDate,
    })

    if (!range.ok) {
      return {
        message: range.error,
        statusCode: range.statusCode ?? 400,
        success: false,
      }
    }
  }

  const period = {
    endDate: endDate || '9999-12-31',
    label: 'Search Range',
    startDate: startDate || '1900-01-01',
  }
  const filters = {
    maxValue,
    minValue,
    q: trimmedQuery,
    status,
  }

  if (safeCategory === 'product') {
    const rows = await getProductLineRows({
      filters: {
        productCode: trimmedQuery,
        productDescription: trimmedQuery,
      },
      limit: safeLimit,
      period,
      queryable,
      tableNames,
    })

    return {
      ...getSearchMeta(),
      category: safeCategory,
      filters: buildAppliedFilters(filters),
      pagination: getPagination({ limit: safeLimit, rows }),
      rows: takeLimit(rows, safeLimit),
      success: true,
    }
  }

  const piFilters = {
    ...filters,
    companyName: safeCategory === 'company' ? trimmedQuery : '',
    customerName: safeCategory === 'customer' ? trimmedQuery : '',
    piNumber: safeCategory === 'pi' ? trimmedQuery : '',
    productCode: safeCategory === 'product' ? trimmedQuery : '',
  }
  const rows = await getPIRows({
    filters: piFilters,
    limit: safeLimit,
    period,
    queryable,
    status: safeCategory === 'status' && trimmedQuery ? trimmedQuery : status,
    tableNames,
  })

  return {
    ...getSearchMeta(),
    category: safeCategory,
    filters: buildAppliedFilters(filters),
    pagination: getPagination({ limit: safeLimit, rows }),
    rows: takeLimit(rows, safeLimit),
    success: true,
  }
}

export const buildDeterministicDrillDownExplanation = (drillDown) => {
  const rowCount = toNumber(drillDown?.pagination?.returned)
  const cards = Array.isArray(drillDown?.summary?.cards) ? drillDown.summary.cards : []
  const facts = cards
    .slice(0, 5)
    .map((card) => `${card.label}: ${card.value}`)
    .join('; ')
  const title = drillDown?.title || getDrillDownMeta(drillDown?.type).title

  return [
    `${title} is supported by ${rowCount} visible record(s) in the selected drill-down.`,
    facts ? `Key verified figures are ${facts}.` : 'No summary figures are available for this selection.',
    'The listed rows are the supporting Proforma Invoice records or PI-line records returned by approved read-only queries.',
    EXECUTIVE_DISCLAIMER,
  ].join(' ')
}

export const getSearchTextForSqlSafetyTest = () =>
  [
    'SELECT',
    'WITH',
    escapeLikePattern('x'),
  ].join(' ')

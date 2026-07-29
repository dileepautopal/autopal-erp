import {
  askOllama,
  OLLAMA_MODEL,
} from './ollamaService.js'
import {
  getSafeCompanyExpression,
  getSafeCustomerExpression,
  getStatusExpression,
  getIndiaDateString,
  runReadOnlyQuery,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'
import {
  COMMERCIAL_DISCLAIMER,
  COMMERCIAL_LIMITS,
  COMMERCIAL_MODULE,
  COMMERCIAL_PERMISSION_ID,
  COMMERCIAL_THRESHOLDS,
  COMMERCIAL_TIMEZONE,
  clampCommercialLimit,
  classifyCommercialActivity,
  getChange,
  getConcentrationLabel,
  getDaysBetween,
  getSafeCustomerGroupExpression,
  getSafeProductExpression,
  getSharePercentage,
  normalizeCommercialTables,
  normalizeCommercialPeriod,
  resolveCommercialPeriod,
} from './commercialIntelligenceUtils.js'

export {
  COMMERCIAL_DISCLAIMER,
  COMMERCIAL_LIMITS,
  COMMERCIAL_MODULE,
  COMMERCIAL_PERMISSION_ID,
  COMMERCIAL_THRESHOLDS,
}

export const COMMERCIAL_INTENTS = {
  COMMERCIAL_COMPANY_COMPARISON: 'commercial_company_comparison',
  COMMERCIAL_CONCENTRATION: 'commercial_concentration',
  COMMERCIAL_CUSTOMER_DECLINE: 'commercial_customer_decline',
  COMMERCIAL_CUSTOMER_GROWTH: 'commercial_customer_growth',
  COMMERCIAL_CUSTOMER_INACTIVE: 'commercial_customer_inactive',
  COMMERCIAL_CUSTOMER_RANKING: 'commercial_customer_ranking',
  COMMERCIAL_CUSTOMER_REACTIVATED: 'commercial_customer_reactivated',
  COMMERCIAL_FINANCIAL_YEAR_COMPARISON: 'commercial_financial_year_comparison',
  COMMERCIAL_MANAGEMENT_BRIEF: 'commercial_management_brief',
  COMMERCIAL_PERIOD_COMPARISON: 'commercial_period_comparison',
  COMMERCIAL_PRODUCT_DECLINE: 'commercial_product_decline',
  COMMERCIAL_PRODUCT_GROWTH: 'commercial_product_growth',
  COMMERCIAL_PRODUCT_RANKING_QUANTITY: 'commercial_product_ranking_quantity',
  COMMERCIAL_PRODUCT_RANKING_VALUE: 'commercial_product_ranking_value',
  COMMERCIAL_UNSUPPORTED: 'commercial_unsupported',
  GENERAL_AI_QUESTION: 'general_ai_question',
}

const COMMERCIAL_BRIEF_SYSTEM_PROMPT = `
You are AUTOPAL's internal Commercial PI Intelligence assistant.

You receive verified structured Proforma Invoice data from approved backend queries.

Rules:
1. Use only supplied data.
2. Never invent or alter figures.
3. Do not call PI value actual sales, invoiced revenue, dispatched value or received business.
4. Use "PI value", "commercial pipeline" or "Proforma Invoice activity".
5. Clearly state important period changes.
6. Mention concentration only as a PI concentration indicator.
7. Do not provide credit-risk conclusions.
8. Do not provide stock, production, accounting or payment conclusions.
9. Do not forecast unless a future phase explicitly supports forecasting.
10. Keep the management brief concise, factual and professional.
11. If comparison is unavailable, state that clearly.
12. Do not expose SQL, table names or technical internals.
13. Do not invent reasons for increases or decreases.
14. Do not recommend customer credit action.
15. Do not claim actual customer purchases.
`.trim()

const formatINR = (value) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(toNumber(value))

const safeRound = (value) => Number(toNumber(value).toFixed(2))

const getResponseMeta = () => ({
  disclaimer: COMMERCIAL_DISCLAIMER,
  generatedAt: new Date().toISOString(),
  module: COMMERCIAL_MODULE,
  timezone: COMMERCIAL_TIMEZONE,
})

const mapSummaryRow = (row = {}) => ({
  averagePIValue: safeRound(row.average_value),
  count: toNumber(row.count),
  finalCount: toNumber(row.final_count),
  finalValue: safeRound(row.final_value),
  highestPIValue: safeRound(row.highest_value),
  lowestPIValue: safeRound(row.lowest_value),
  openCount: toNumber(row.open_count),
  openValue: safeRound(row.open_value),
  value: safeRound(row.total_value),
})

export const getCommercialSummary = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeCommercialTables(tableNames)
  const statusExpression = getStatusExpression('m')
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value,
        COALESCE(AVG(m.grand_total), 0)::numeric AS average_value,
        COALESCE(MAX(m.grand_total), 0)::numeric AS highest_value,
        COALESCE(MIN(m.grand_total), 0)::numeric AS lowest_value,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Draft')::int AS open_count,
        COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Draft'), 0)::numeric AS open_value,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Final')::int AS final_count,
        COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Final'), 0)::numeric AS final_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
    `,
    [startDate, endDate],
  )

  return mapSummaryRow(result.rows[0])
}

export const getCommercialComparison = async ({
  comparisonMode,
  endDate,
  period,
  queryable,
  startDate,
  tableNames,
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

  const [current, previous] = await Promise.all([
    getCommercialSummary({
      ...range.period,
      queryable,
      tableNames,
    }),
    getCommercialSummary({
      ...range.comparisonPeriod,
      queryable,
      tableNames,
    }),
  ])
  const countChange = getChange(current.count, previous.count)
  const valueChange = getChange(current.value, previous.value)
  const averageValueChange = getChange(current.averagePIValue, previous.averagePIValue)

  return {
    ...getResponseMeta(),
    comparison: {
      averageValueChange,
      countChange,
      current,
      previous,
      valueChange,
    },
    comparisonMode: range.comparisonMode,
    comparisonPeriod: range.comparisonPeriod,
    period: range.period,
    success: true,
    thresholds: COMMERCIAL_THRESHOLDS,
  }
}

const buildCustomerQuery = ({ current, previous, tableNames, today }) => {
  const tables = normalizeCommercialTables(tableNames)
  const statusExpression = getStatusExpression('m')
  const customerExpression = getSafeCustomerExpression('m')
  const groupExpression = getSafeCustomerGroupExpression(customerExpression)

  return {
    params: [
      current.startDate,
      current.endDate,
      previous.startDate,
      previous.endDate,
      today,
    ],
    sql: `
      WITH base AS (
        SELECT
          ${groupExpression} AS customer_key,
          CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END AS customer_code,
          ${customerExpression} AS customer_name,
          ${statusExpression} AS status,
          m.pi_date::date AS pi_date,
          COALESCE(m.grand_total, 0)::numeric AS grand_total
        FROM ${tables.piMaster} m
        WHERE m.is_active = TRUE
      ),
      current_rows AS (
        SELECT
          customer_key,
          MAX(customer_code)::int AS customer_code,
          MAX(customer_name) AS customer_name,
          COUNT(*)::int AS current_count,
          COALESCE(SUM(grand_total), 0)::numeric AS current_value,
          COALESCE(AVG(grand_total), 0)::numeric AS average_value,
          COALESCE(MAX(grand_total), 0)::numeric AS highest_value,
          COALESCE(MIN(grand_total), 0)::numeric AS lowest_value,
          COUNT(*) FILTER (WHERE status = 'Draft')::int AS open_count,
          COALESCE(SUM(grand_total) FILTER (WHERE status = 'Draft'), 0)::numeric AS open_value,
          COUNT(*) FILTER (WHERE status = 'Final')::int AS final_count,
          COALESCE(SUM(grand_total) FILTER (WHERE status = 'Final'), 0)::numeric AS final_value,
          TO_CHAR(MIN(pi_date), 'YYYY-MM-DD') AS first_pi_date,
          TO_CHAR(MAX(pi_date), 'YYYY-MM-DD') AS last_pi_date
        FROM base
        WHERE pi_date BETWEEN $1::date AND $2::date
        GROUP BY customer_key
      ),
      previous_rows AS (
        SELECT
          customer_key,
          COUNT(*)::int AS previous_count,
          COALESCE(SUM(grand_total), 0)::numeric AS previous_value
        FROM base
        WHERE pi_date BETWEEN $3::date AND $4::date
        GROUP BY customer_key
      ),
      history_rows AS (
        SELECT
          customer_key,
          COUNT(*)::int AS historical_count,
          COALESCE(SUM(grand_total), 0)::numeric AS historical_value,
          TO_CHAR(MAX(pi_date), 'YYYY-MM-DD') AS historical_last_pi_date
        FROM base
        WHERE pi_date < $1::date
        GROUP BY customer_key
      ),
      combined AS (
        SELECT
          COALESCE(c.customer_key, p.customer_key, h.customer_key) AS customer_key,
          c.customer_code,
          COALESCE(c.customer_name, b.customer_name, 'Unknown Customer') AS customer_name,
          COALESCE(c.current_count, 0)::int AS current_count,
          COALESCE(c.current_value, 0)::numeric AS current_value,
          COALESCE(p.previous_count, 0)::int AS previous_count,
          COALESCE(p.previous_value, 0)::numeric AS previous_value,
          COALESCE(c.average_value, 0)::numeric AS average_value,
          COALESCE(c.highest_value, 0)::numeric AS highest_value,
          COALESCE(c.lowest_value, 0)::numeric AS lowest_value,
          COALESCE(c.open_count, 0)::int AS open_count,
          COALESCE(c.open_value, 0)::numeric AS open_value,
          COALESCE(c.final_count, 0)::int AS final_count,
          COALESCE(c.final_value, 0)::numeric AS final_value,
          c.first_pi_date,
          COALESCE(c.last_pi_date, h.historical_last_pi_date) AS last_pi_date,
          COALESCE(h.historical_count, 0)::int AS historical_count,
          COALESCE(h.historical_value, 0)::numeric AS historical_value
        FROM current_rows c
        FULL OUTER JOIN previous_rows p
          ON p.customer_key = c.customer_key
        FULL OUTER JOIN history_rows h
          ON h.customer_key = COALESCE(c.customer_key, p.customer_key)
        LEFT JOIN LATERAL (
          SELECT customer_name
          FROM base b
          WHERE b.customer_key = COALESCE(c.customer_key, p.customer_key, h.customer_key)
          ORDER BY pi_date DESC
          LIMIT 1
        ) b ON TRUE
      )
      SELECT
        *,
        COALESCE(SUM(current_value) OVER (), 0)::numeric AS total_current_value,
        ROW_NUMBER() OVER (ORDER BY current_value DESC, current_count DESC, customer_name ASC)::int AS value_rank,
        ROW_NUMBER() OVER (ORDER BY current_count DESC, current_value DESC, customer_name ASC)::int AS count_rank,
        ($5::date - NULLIF(last_pi_date, '')::date)::int AS days_since_last_pi
      FROM combined
    `,
  }
}

const mapCustomerCommercialRow = (row) => {
  const valueChange = getChange(row.current_value, row.previous_value)
  const classification = classifyCommercialActivity({
    currentValue: row.current_value,
    historicalCount: row.historical_count,
    previousValue: row.previous_value,
  })

  return {
    averagePIValue: safeRound(row.average_value),
    classification,
    countChange: toNumber(row.current_count) - toNumber(row.previous_count),
    countRank: toNumber(row.count_rank),
    currentPICount: toNumber(row.current_count),
    currentPIValue: safeRound(row.current_value),
    customerCode: row.customer_code ?? null,
    customerName: row.customer_name ?? 'Unknown Customer',
    daysSinceLastPI: row.days_since_last_pi === null ? null : toNumber(row.days_since_last_pi),
    finalPICount: toNumber(row.final_count),
    finalPIValue: safeRound(row.final_value),
    firstPIDate: row.first_pi_date ?? '',
    growthPercentage: valueChange.changePercentage,
    highestPIValue: safeRound(row.highest_value),
    historicalPICount: toNumber(row.historical_count),
    historicalPIValue: safeRound(row.historical_value),
    lastPIDate: row.last_pi_date ?? '',
    lowestPIValue: safeRound(row.lowest_value),
    openPICount: toNumber(row.open_count),
    openPIValue: safeRound(row.open_value),
    previousPICount: toNumber(row.previous_count),
    previousPIValue: safeRound(row.previous_value),
    rankByPIValue: toNumber(row.value_rank),
    rankByPICount: toNumber(row.count_rank),
    shareOfTotalPIValue: getSharePercentage(row.current_value, row.total_current_value),
    valueChange: valueChange.change,
    valueChangeAvailable: valueChange.changeAvailable,
    valueChangeReason: valueChange.reason,
  }
}

export const getCustomerCommercialIntelligence = async ({
  comparisonMode,
  endDate,
  limit = COMMERCIAL_LIMITS.defaultList,
  period,
  queryable,
  segment = 'all',
  startDate,
  tableNames,
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

  const safeLimit = clampCommercialLimit(limit, COMMERCIAL_LIMITS.customer)
  const query = buildCustomerQuery({
    current: range.period,
    previous: range.comparisonPeriod,
    tableNames,
    today: today ?? range.period.endDate,
  })
  const result = await runReadOnlyQuery(queryable, query.sql, query.params)
  let rows = result.rows.map(mapCustomerCommercialRow)

  if (segment === 'growing') {
    rows = rows.filter((row) => row.classification === 'Growing')
  } else if (segment === 'declining') {
    rows = rows.filter((row) => row.classification === 'Declining')
  } else if (segment === 'new') {
    rows = rows.filter((row) => row.classification === 'New')
  } else if (segment === 'reactivated') {
    rows = rows.filter((row) => row.classification === 'Reactivated')
  }

  rows = rows
    .sort((left, right) => right.currentPIValue - left.currentPIValue || right.currentPICount - left.currentPICount)
    .slice(0, safeLimit)

  return {
    ...getResponseMeta(),
    comparisonPeriod: range.comparisonPeriod,
    groupNote:
      'Customers are grouped by cust_code when available; prospective customers are grouped by normalized PI customer name. Different customers are not merged only by fuzzy name.',
    limit: safeLimit,
    period: range.period,
    rows,
    segment,
    success: true,
    thresholds: COMMERCIAL_THRESHOLDS,
  }
}

export const getInactiveCustomers = async ({
  days = 90,
  limit = COMMERCIAL_LIMITS.defaultList,
  queryable,
  tableNames,
  today,
}) => {
  const safeDays = Math.min(Math.max(Number(days) || 90, 30), 730)
  const safeLimit = clampCommercialLimit(limit, COMMERCIAL_LIMITS.inactiveExport)
  const endDate = today ?? getIndiaDateString()
  const startDate = new Date(endDate ? `${endDate}T00:00:00Z` : Date.now())
  startDate.setUTCDate(startDate.getUTCDate() - safeDays + 1)
  const windowStart = startDate.toISOString().slice(0, 10)
  const tables = normalizeCommercialTables(tableNames)
  const customerExpression = getSafeCustomerExpression('m')
  const groupExpression = getSafeCustomerGroupExpression(customerExpression)
  const result = await runReadOnlyQuery(
    queryable,
    `
      WITH grouped AS (
        SELECT
          ${groupExpression} AS customer_key,
          MAX(CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END) AS customer_code,
          MAX(${customerExpression}) AS customer_name,
          COUNT(*)::int AS historical_pi_count,
          COALESCE(SUM(m.grand_total), 0)::numeric AS historical_pi_value,
          TO_CHAR(MAX(m.pi_date::date), 'YYYY-MM-DD') AS last_pi_date,
          COUNT(*) FILTER (WHERE m.pi_date::date BETWEEN $1::date AND $2::date)::int AS recent_pi_count
        FROM ${tables.piMaster} m
        WHERE m.is_active = TRUE
          AND m.pi_date::date <= $2::date
        GROUP BY ${groupExpression}
      )
      SELECT
        customer_code,
        customer_name,
        historical_pi_count,
        historical_pi_value,
        last_pi_date,
        ($2::date - NULLIF(last_pi_date, '')::date)::int AS days_inactive
      FROM grouped
      WHERE historical_pi_count > 0
        AND recent_pi_count = 0
      ORDER BY days_inactive DESC, historical_pi_value DESC, customer_name ASC
      LIMIT $3
    `,
    [windowStart, endDate, safeLimit],
  )

  return {
    ...getResponseMeta(),
    days: safeDays,
    message: 'No PI activity recorded during the selected period.',
    rows: result.rows.map((row) => ({
      customerCode: row.customer_code ?? null,
      customerName: row.customer_name ?? 'Unknown Customer',
      daysInactive: toNumber(row.days_inactive),
      historicalPICount: toNumber(row.historical_pi_count),
      historicalPIValue: safeRound(row.historical_pi_value),
      lastPIDate: row.last_pi_date ?? '',
    })),
    success: true,
    window: {
      endDate,
      startDate: windowStart,
    },
  }
}

export const getReactivatedCustomers = async ({
  days = 90,
  limit = COMMERCIAL_LIMITS.defaultList,
  queryable,
  tableNames,
  today,
}) => {
  const safeDays = Math.min(Math.max(Number(days) || 90, 30), 730)
  const safeLimit = clampCommercialLimit(limit, COMMERCIAL_LIMITS.customer)
  const endDate = today ?? getIndiaDateString()
  const startDate = new Date(endDate ? `${endDate}T00:00:00Z` : Date.now())
  startDate.setUTCDate(startDate.getUTCDate() - safeDays + 1)
  const windowStart = startDate.toISOString().slice(0, 10)
  const tables = normalizeCommercialTables(tableNames)
  const customerExpression = getSafeCustomerExpression('m')
  const groupExpression = getSafeCustomerGroupExpression(customerExpression)
  const result = await runReadOnlyQuery(
    queryable,
    `
      WITH base AS (
        SELECT
          ${groupExpression} AS customer_key,
          CASE WHEN COALESCE(m.cust_code, 0) > 0 THEN m.cust_code::int ELSE NULL END AS customer_code,
          ${customerExpression} AS customer_name,
          m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
          m.pi_date::date AS pi_date,
          COALESCE(m.grand_total, 0)::numeric AS grand_total
        FROM ${tables.piMaster} m
        WHERE m.is_active = TRUE
          AND m.pi_date::date <= $2::date
      ),
      latest_recent AS (
        SELECT DISTINCT ON (customer_key)
          customer_key,
          customer_code,
          customer_name,
          pi_number,
          pi_date,
          grand_total
        FROM base
        WHERE pi_date BETWEEN $1::date AND $2::date
        ORDER BY customer_key, pi_date DESC, pi_number DESC
      ),
      previous_activity AS (
        SELECT
          r.customer_key,
          MAX(b.pi_date) AS previous_pi_date,
          COUNT(*)::int AS historical_pi_count,
          COALESCE(SUM(b.grand_total), 0)::numeric AS historical_pi_value
        FROM latest_recent r
        JOIN base b
          ON b.customer_key = r.customer_key
         AND b.pi_date < r.pi_date
        GROUP BY r.customer_key
      )
      SELECT
        r.customer_code,
        r.customer_name,
        r.pi_number,
        TO_CHAR(r.pi_date, 'YYYY-MM-DD') AS latest_pi_date,
        r.grand_total,
        TO_CHAR(p.previous_pi_date, 'YYYY-MM-DD') AS previous_pi_date,
        (r.pi_date - p.previous_pi_date)::int AS inactive_gap_days,
        p.historical_pi_count,
        p.historical_pi_value
      FROM latest_recent r
      JOIN previous_activity p
        ON p.customer_key = r.customer_key
      WHERE (r.pi_date - p.previous_pi_date)::int >= $3
      ORDER BY inactive_gap_days DESC, r.grand_total DESC, r.customer_name ASC
      LIMIT $4
    `,
    [windowStart, endDate, safeDays, safeLimit],
  )

  return {
    ...getResponseMeta(),
    days: safeDays,
    rows: result.rows.map((row) => ({
      customerCode: row.customer_code ?? null,
      customerName: row.customer_name ?? 'Unknown Customer',
      historicalPICount: toNumber(row.historical_pi_count),
      historicalPIValue: safeRound(row.historical_pi_value),
      inactiveGapDays: toNumber(row.inactive_gap_days),
      latestPIDate: row.latest_pi_date ?? '',
      latestPINumber: row.pi_number ?? '',
      latestPIValue: safeRound(row.grand_total),
      previousPIDate: row.previous_pi_date ?? '',
    })),
    success: true,
    window: {
      endDate,
      startDate: windowStart,
    },
  }
}

const buildProductQuery = ({ current, previous, tableNames }) => {
  const tables = normalizeCommercialTables(tableNames)
  const productExpression = getSafeProductExpression('p', 't')

  return {
    params: [current.startDate, current.endDate, previous.startDate, previous.endDate],
    sql: `
      WITH base AS (
        SELECT
          UPPER(BTRIM(t.product_code)) AS product_key,
          t.product_code,
          ${productExpression} AS product_description,
          m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
          ${getSafeCustomerExpression('m')} AS customer_name,
          m.pi_date::date AS pi_date,
          COALESCE(t.quantity, 0)::numeric AS quantity,
          COALESCE(t.rate, 0)::numeric AS rate,
          COALESCE(t.amount, COALESCE(t.quantity, 0) * COALESCE(t.rate, 0))::numeric AS line_value
        FROM ${tables.piTran} t
        JOIN ${tables.piMaster} m
          ON m.pi_no = t.pi_no
         AND m.pi_series = t.pi_series
         AND m.comp_code = t.comp_code
        LEFT JOIN ${tables.product} p
          ON UPPER(BTRIM(p.code)) = UPPER(BTRIM(t.product_code))
        WHERE COALESCE(t.is_active, TRUE) = TRUE
          AND m.is_active = TRUE
          AND NULLIF(BTRIM(t.product_code), '') IS NOT NULL
      ),
      current_rows AS (
        SELECT
          product_key,
          MAX(product_code) AS product_code,
          MAX(product_description) AS product_description,
          COUNT(*)::int AS line_count,
          COUNT(DISTINCT pi_number)::int AS distinct_pi_count,
          COUNT(DISTINCT customer_name)::int AS distinct_customer_count,
          COALESCE(SUM(quantity), 0)::numeric AS total_quantity,
          COALESCE(SUM(line_value), 0)::numeric AS current_value,
          COALESCE(AVG(rate), 0)::numeric AS average_rate,
          COALESCE(AVG(quantity), 0)::numeric AS average_quantity,
          TO_CHAR(MAX(pi_date), 'YYYY-MM-DD') AS latest_pi_date
        FROM base
        WHERE pi_date BETWEEN $1::date AND $2::date
        GROUP BY product_key
      ),
      previous_rows AS (
        SELECT
          product_key,
          COALESCE(SUM(quantity), 0)::numeric AS previous_quantity,
          COALESCE(SUM(line_value), 0)::numeric AS previous_value
        FROM base
        WHERE pi_date BETWEEN $3::date AND $4::date
        GROUP BY product_key
      ),
      combined AS (
        SELECT
          COALESCE(c.product_key, p.product_key) AS product_key,
          c.product_code,
          c.product_description,
          COALESCE(c.line_count, 0)::int AS line_count,
          COALESCE(c.distinct_pi_count, 0)::int AS distinct_pi_count,
          COALESCE(c.distinct_customer_count, 0)::int AS distinct_customer_count,
          COALESCE(c.total_quantity, 0)::numeric AS total_quantity,
          COALESCE(c.current_value, 0)::numeric AS current_value,
          COALESCE(p.previous_quantity, 0)::numeric AS previous_quantity,
          COALESCE(p.previous_value, 0)::numeric AS previous_value,
          COALESCE(c.average_rate, 0)::numeric AS average_rate,
          COALESCE(c.average_quantity, 0)::numeric AS average_quantity,
          c.latest_pi_date
        FROM current_rows c
        FULL OUTER JOIN previous_rows p
          ON p.product_key = c.product_key
      )
      SELECT
        *,
        COALESCE(SUM(current_value) OVER (), 0)::numeric AS total_current_value,
        ROW_NUMBER() OVER (ORDER BY current_value DESC, total_quantity DESC, product_key ASC)::int AS value_rank,
        ROW_NUMBER() OVER (ORDER BY total_quantity DESC, current_value DESC, product_key ASC)::int AS quantity_rank
      FROM combined
    `,
  }
}

const mapProductCommercialRow = (row) => {
  const valueChange = getChange(row.current_value, row.previous_value)
  const quantityChange = getChange(row.total_quantity, row.previous_quantity)

  return {
    averageQuantityPerPI: safeRound(row.average_quantity),
    averageRate: safeRound(row.average_rate),
    classification: classifyCommercialActivity({
      currentValue: row.current_value,
      historicalCount: toNumber(row.previous_value) > 0 ? 1 : 0,
      previousValue: row.previous_value,
    }),
    currentPeriodQuantity: safeRound(row.total_quantity),
    currentPeriodValue: safeRound(row.current_value),
    distinctCustomers: toNumber(row.distinct_customer_count),
    distinctPIs: toNumber(row.distinct_pi_count),
    growthPercentage: valueChange.changePercentage,
    latestPIDate: row.latest_pi_date ?? '',
    lineCount: toNumber(row.line_count),
    previousPeriodQuantity: safeRound(row.previous_quantity),
    previousPeriodValue: safeRound(row.previous_value),
    productCode: row.product_code ?? row.product_key ?? '',
    productDescription: row.product_description ?? 'Unknown Product',
    quantityGrowthPercentage: quantityChange.changePercentage,
    rankByPILineValue: toNumber(row.value_rank),
    rankByQuantity: toNumber(row.quantity_rank),
    shareOfTotalPILineValue: getSharePercentage(row.current_value, row.total_current_value),
    totalPILineValue: safeRound(row.current_value),
    totalQuantity: safeRound(row.total_quantity),
    valueChange: valueChange.change,
    valueChangeAvailable: valueChange.changeAvailable,
    valueChangeReason: valueChange.reason,
  }
}

export const getProductCommercialIntelligence = async ({
  comparisonMode,
  endDate,
  limit = COMMERCIAL_LIMITS.defaultList,
  period,
  queryable,
  segment = 'all',
  sortBy = 'value',
  startDate,
  tableNames,
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

  const safeLimit = clampCommercialLimit(limit, COMMERCIAL_LIMITS.product)
  const query = buildProductQuery({
    current: range.period,
    previous: range.comparisonPeriod,
    tableNames,
  })
  const result = await runReadOnlyQuery(queryable, query.sql, query.params)
  let rows = result.rows.map(mapProductCommercialRow)

  if (segment === 'growing') {
    rows = rows.filter((row) => row.classification === 'Growing')
  } else if (segment === 'declining') {
    rows = rows.filter((row) => row.classification === 'Declining')
  }

  rows = rows
    .sort((left, right) =>
      sortBy === 'quantity'
        ? right.totalQuantity - left.totalQuantity || right.totalPILineValue - left.totalPILineValue
        : right.totalPILineValue - left.totalPILineValue || right.totalQuantity - left.totalQuantity,
    )
    .slice(0, safeLimit)

  return {
    ...getResponseMeta(),
    comparisonPeriod: range.comparisonPeriod,
    dataQuality: {
      amountRule:
        'Uses tran_pi_rmkt.amount as PI line value; amount fallback is quantity * rate only when amount is null.',
      productJoin: 'tran_pi_rmkt.product_code joins to master_products.code by trimmed uppercase code.',
      productLinkReliable: true,
    },
    limit: safeLimit,
    period: range.period,
    rows,
    segment,
    success: true,
  }
}

export const getCompanyCommercialIntelligence = async ({
  comparisonMode,
  endDate,
  limit = COMMERCIAL_LIMITS.defaultList,
  period,
  queryable,
  startDate,
  tableNames,
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

  const tables = normalizeCommercialTables(tableNames)
  const safeLimit = clampCommercialLimit(limit, COMMERCIAL_LIMITS.company)
  const companyExpression = getSafeCompanyExpression('c')
  const statusExpression = getStatusExpression('m')
  const result = await runReadOnlyQuery(
    queryable,
    `
      WITH current_rows AS (
        SELECT
          m.comp_code::int AS company_code,
          ${companyExpression} AS company_name,
          COUNT(*)::int AS current_count,
          COALESCE(SUM(m.grand_total), 0)::numeric AS current_value,
          COALESCE(AVG(m.grand_total), 0)::numeric AS average_value,
          COUNT(*) FILTER (WHERE ${statusExpression} = 'Draft')::int AS open_count,
          COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Draft'), 0)::numeric AS open_value,
          COUNT(*) FILTER (WHERE ${statusExpression} = 'Final')::int AS final_count,
          COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Final'), 0)::numeric AS final_value,
          TO_CHAR(MAX(m.pi_date::date), 'YYYY-MM-DD') AS last_pi_date
        FROM ${tables.piMaster} m
        LEFT JOIN ${tables.company} c
          ON c.comp_code = m.comp_code
        WHERE m.is_active = TRUE
          AND m.pi_date::date BETWEEN $1::date AND $2::date
        GROUP BY m.comp_code, ${companyExpression}
      ),
      previous_rows AS (
        SELECT
          m.comp_code::int AS company_code,
          COUNT(*)::int AS previous_count,
          COALESCE(SUM(m.grand_total), 0)::numeric AS previous_value
        FROM ${tables.piMaster} m
        WHERE m.is_active = TRUE
          AND m.pi_date::date BETWEEN $3::date AND $4::date
        GROUP BY m.comp_code
      )
      SELECT
        COALESCE(c.company_code, p.company_code)::int AS company_code,
        COALESCE(c.company_name, 'Unknown Company') AS company_name,
        COALESCE(c.current_count, 0)::int AS current_count,
        COALESCE(c.current_value, 0)::numeric AS current_value,
        COALESCE(p.previous_count, 0)::int AS previous_count,
        COALESCE(p.previous_value, 0)::numeric AS previous_value,
        COALESCE(c.average_value, 0)::numeric AS average_value,
        COALESCE(c.open_count, 0)::int AS open_count,
        COALESCE(c.open_value, 0)::numeric AS open_value,
        COALESCE(c.final_count, 0)::int AS final_count,
        COALESCE(c.final_value, 0)::numeric AS final_value,
        c.last_pi_date,
        COALESCE(SUM(c.current_value) OVER (), 0)::numeric AS total_current_value
      FROM current_rows c
      FULL OUTER JOIN previous_rows p
        ON p.company_code = c.company_code
      ORDER BY current_value DESC, current_count DESC, company_name ASC
      LIMIT $5
    `,
    [
      range.period.startDate,
      range.period.endDate,
      range.comparisonPeriod.startDate,
      range.comparisonPeriod.endDate,
      safeLimit,
    ],
  )

  return {
    ...getResponseMeta(),
    comparisonPeriod: range.comparisonPeriod,
    limit: safeLimit,
    period: range.period,
    rows: result.rows.map((row, index) => {
      const countChange = getChange(row.current_count, row.previous_count)
      const valueChange = getChange(row.current_value, row.previous_value)

      return {
        averagePIValue: safeRound(row.average_value),
        companyCode: row.company_code,
        companyName: row.company_name,
        countGrowthPercentage: countChange.changePercentage,
        currentPICount: toNumber(row.current_count),
        currentPIValue: safeRound(row.current_value),
        finalPICount: toNumber(row.final_count),
        finalPIValue: safeRound(row.final_value),
        lastPIDate: row.last_pi_date ?? '',
        openPICount: toNumber(row.open_count),
        openPIValue: safeRound(row.open_value),
        previousPICount: toNumber(row.previous_count),
        previousPIValue: safeRound(row.previous_value),
        rank: index + 1,
        shareOfTotalPIValue: getSharePercentage(row.current_value, row.total_current_value),
        valueGrowthPercentage: valueChange.changePercentage,
      }
    }),
    success: true,
  }
}

export const getCommercialConcentration = async ({
  comparisonMode,
  endDate,
  period,
  queryable,
  startDate,
  tableNames,
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

  const customerResult = await getCustomerCommercialIntelligence({
    ...range.period,
    comparisonMode,
    limit: 100,
    period: 'custom',
    queryable,
    startDate: range.period.startDate,
    tableNames,
    today,
  })
  const productResult = await getProductCommercialIntelligence({
    ...range.period,
    comparisonMode,
    limit: 100,
    period: 'custom',
    queryable,
    startDate: range.period.startDate,
    tableNames,
    today,
  })
  const companyResult = await getCompanyCommercialIntelligence({
    ...range.period,
    comparisonMode,
    limit: 50,
    period: 'custom',
    queryable,
    startDate: range.period.startDate,
    tableNames,
    today,
  })
  const customerRows = customerResult.rows ?? []
  const productRows = productResult.rows ?? []
  const companyRows = companyResult.rows ?? []
  const totalCustomerValue = customerRows.reduce((total, row) => total + toNumber(row.currentPIValue), 0)
  const totalProductValue = productRows.reduce((total, row) => total + toNumber(row.totalPILineValue), 0)
  const getTopShare = (rows, count, valueKey) =>
    getSharePercentage(
      rows.slice(0, count).reduce((total, row) => total + toNumber(row[valueKey]), 0),
      rows.reduce((total, row) => total + toNumber(row[valueKey]), 0),
    )
  const topCustomerShare = getTopShare(customerRows, 1, 'currentPIValue')

  return {
    ...getResponseMeta(),
    concentrationNote:
      'This indicator is based only on Proforma Invoice activity and is not a credit-risk assessment.',
    customer: {
      label: getConcentrationLabel(topCustomerShare),
      top10Share: getTopShare(customerRows, 10, 'currentPIValue'),
      top3Share: getTopShare(customerRows, 3, 'currentPIValue'),
      top5Share: getTopShare(customerRows, 5, 'currentPIValue'),
      topCustomer: customerRows[0] ?? null,
      topCustomerShare,
      totalPIValue: safeRound(totalCustomerValue),
    },
    company: {
      topCompany: companyRows[0] ?? null,
      topCompanyShare: getTopShare(companyRows, 1, 'currentPIValue'),
    },
    comparisonPeriod: range.comparisonPeriod,
    period: range.period,
    product: {
      productLinkReliable: true,
      topProduct: productRows[0] ?? null,
      topProductShare: getSharePercentage(productRows[0]?.totalPILineValue, totalProductValue),
    },
    success: true,
  }
}

const buildCommercialBriefPayload = async ({
  comparisonMode,
  endDate,
  period,
  queryable,
  startDate,
  tableNames,
  today,
}) => {
  const [comparison, customers, inactive, reactivated, companies, concentration] =
    await Promise.all([
      getCommercialComparison({
        comparisonMode,
        endDate,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getCustomerCommercialIntelligence({
        comparisonMode,
        endDate,
        limit: 100,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getInactiveCustomers({
        days: 90,
        limit: 100,
        queryable,
        tableNames,
        today: today ?? getIndiaDateString(),
      }),
      getReactivatedCustomers({
        days: 90,
        limit: 100,
        queryable,
        tableNames,
        today: today ?? getIndiaDateString(),
      }),
      getCompanyCommercialIntelligence({
        comparisonMode,
        endDate,
        limit: 10,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getCommercialConcentration({
        comparisonMode,
        endDate,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
    ])
  const customerRows = customers.rows ?? []

  return {
    comparison: {
      countChangePercentage: comparison.comparison?.countChange?.changePercentage,
      currentCount: comparison.comparison?.current?.count,
      currentValue: comparison.comparison?.current?.value,
      previousCount: comparison.comparison?.previous?.count,
      previousValue: comparison.comparison?.previous?.value,
      valueChangePercentage: comparison.comparison?.valueChange?.changePercentage,
    },
    concentration: {
      label: concentration.customer?.label,
      topCustomerShare: concentration.customer?.topCustomerShare,
    },
    growth: {
      decliningCustomers: customerRows.filter((row) => row.classification === 'Declining').length,
      growingCustomers: customerRows.filter((row) => row.classification === 'Growing').length,
      inactiveCustomers: inactive.rows?.length ?? 0,
      newCustomers: customerRows.filter((row) => row.classification === 'New').length,
      reactivatedCustomers: reactivated.rows?.length ?? 0,
    },
    period: comparison.period,
    status: {
      finalCount: comparison.comparison?.current?.finalCount,
      finalValue: comparison.comparison?.current?.finalValue,
      openCount: comparison.comparison?.current?.openCount,
      openValue: comparison.comparison?.current?.openValue,
    },
    topCompany: companies.rows?.[0]
      ? {
          name: companies.rows[0].companyName,
          value: companies.rows[0].currentPIValue,
        }
      : null,
    topCustomer: customerRows[0]
      ? {
          name: customerRows[0].customerName,
          sharePercentage: customerRows[0].shareOfTotalPIValue,
          value: customerRows[0].currentPIValue,
        }
      : null,
  }
}

const collectNumberTokens = (value, tokens = new Set()) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    tokens.add(String(Math.trunc(value)))
    tokens.add(value.toFixed(2))
    tokens.add(String(value))
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectNumberTokens(item, tokens))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectNumberTokens(item, tokens))
  }

  return tokens
}

const modelUsesOnlyVerifiedNumbers = (answer, payload) => {
  const tokens = collectNumberTokens(payload)
  const answerNumbers = answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? []

  return answerNumbers.every((numberText) => {
    const normalized = numberText.replace(/,/g, '')
    return tokens.has(normalized) || tokens.has(String(Number(normalized)))
  })
}

export const buildDeterministicCommercialBrief = (payload) => {
  const comparisonText =
    payload.comparison?.valueChangePercentage === null ||
    payload.comparison?.valueChangePercentage === undefined
      ? 'Comparison percentage is unavailable because the previous period value is zero.'
      : `PI value changed by ${payload.comparison.valueChangePercentage}% compared with the comparison period.`
  const topCustomerText = payload.topCustomer
    ? `Top customer contribution is ${payload.topCustomer.name} at ${formatINR(payload.topCustomer.value)}.`
    : 'No top customer is available for this period.'
  const concentrationText = payload.concentration
    ? `Commercial PI concentration indicator is ${payload.concentration.label} with top customer share at ${payload.concentration.topCustomerShare}%.`
    : 'Commercial concentration could not be calculated.'

  return [
    `Current period Proforma Invoice activity is ${payload.comparison?.currentCount ?? 0} PI(s) with PI value ${formatINR(payload.comparison?.currentValue)}.`,
    comparisonText,
    topCustomerText,
    `Open PI value is ${formatINR(payload.status?.openValue)} and final PI value is ${formatINR(payload.status?.finalValue)}.`,
    `Customer movement includes ${payload.growth?.growingCustomers ?? 0} growing, ${payload.growth?.decliningCustomers ?? 0} declining, ${payload.growth?.newCustomers ?? 0} new, ${payload.growth?.inactiveCustomers ?? 0} inactive and ${payload.growth?.reactivatedCustomers ?? 0} reactivated customer(s).`,
    concentrationText,
    COMMERCIAL_DISCLAIMER,
  ].join(' ')
}

export const getCommercialManagementBrief = async ({
  comparisonMode,
  endDate,
  modelWording = askOllama,
  period,
  queryable,
  startDate,
  tableNames,
  today,
  useModelWording = true,
}) => {
  const verifiedData = await buildCommercialBriefPayload({
    comparisonMode,
    endDate,
    period,
    queryable,
    startDate,
    tableNames,
    today,
  })
  const fallbackBrief = buildDeterministicCommercialBrief(verifiedData)
  let brief = fallbackBrief
  let model = null
  let wordingMode = 'server-fallback'

  if (useModelWording) {
    try {
      const result = await modelWording({
        question: JSON.stringify(verifiedData),
        systemPrompt: COMMERCIAL_BRIEF_SYSTEM_PROMPT,
      })
      const answer = toText(result.answer)

      if (
        answer &&
        modelUsesOnlyVerifiedNumbers(answer, verifiedData) &&
        !/\b(actual sales|revenue|dispatch|payment received|purchase behavior)\b/i.test(answer)
      ) {
        brief = answer
        model = result.model || OLLAMA_MODEL
        wordingMode = 'ollama'
      }
    } catch {
      brief = fallbackBrief
    }
  }

  return {
    ...getResponseMeta(),
    brief,
    model,
    success: true,
    verifiedData,
    wordingMode,
  }
}

export const getCommercialDashboard = async ({
  comparisonMode,
  endDate,
  period,
  queryable,
  startDate,
  tableNames,
  today,
}) => {
  const [
    comparison,
    customers,
    products,
    companies,
    concentration,
    inactive,
    reactivated,
  ] =
    await Promise.all([
      getCommercialComparison({
        comparisonMode,
        endDate,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getCustomerCommercialIntelligence({
        comparisonMode,
        endDate,
        limit: COMMERCIAL_LIMITS.topList,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getProductCommercialIntelligence({
        comparisonMode,
        endDate,
        limit: COMMERCIAL_LIMITS.topList,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getCompanyCommercialIntelligence({
        comparisonMode,
        endDate,
        limit: COMMERCIAL_LIMITS.topList,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getCommercialConcentration({
        comparisonMode,
        endDate,
        period,
        queryable,
        startDate,
        tableNames,
        today,
      }),
      getInactiveCustomers({
        days: 90,
        limit: COMMERCIAL_LIMITS.topList,
        queryable,
        tableNames,
        today: today ?? getIndiaDateString(),
      }),
      getReactivatedCustomers({
        days: 90,
        limit: COMMERCIAL_LIMITS.topList,
        queryable,
        tableNames,
        today: today ?? getIndiaDateString(),
      }),
    ])

  if (comparison.error) {
    return comparison
  }

  const customerRows = customers.rows ?? []
  const productRows = products.rows ?? []

  return {
    ...getResponseMeta(),
    comparison: comparison.comparison,
    comparisonMode: comparison.comparisonMode,
    comparisonPeriod: comparison.comparisonPeriod,
    concentration,
    customerSummary: {
      declining: customerRows.filter((row) => row.classification === 'Declining'),
      growing: customerRows.filter((row) => row.classification === 'Growing'),
      inactive: inactive.rows ?? [],
      ranking: customerRows,
      reactivated: reactivated.rows ?? [],
      topByOpenValue: [...customerRows]
        .sort((left, right) => right.openPIValue - left.openPIValue)
        .slice(0, COMMERCIAL_LIMITS.topList),
    },
    managementBrief: null,
    period: comparison.period,
    productSummary: {
      declining: productRows.filter((row) => row.classification === 'Declining'),
      growing: productRows.filter((row) => row.classification === 'Growing'),
      ranking: productRows,
      topByQuantity: [...productRows]
        .sort((left, right) => right.totalQuantity - left.totalQuantity)
        .slice(0, COMMERCIAL_LIMITS.topList),
    },
    companySummary: {
      ranking: companies.rows ?? [],
    },
    productDataQuality: products.dataQuality,
    success: true,
    thresholds: COMMERCIAL_THRESHOLDS,
  }
}

const hasCommercialWords = (text) =>
  /\b(commercial|pipeline|growth|growing|declin|inactive|reactivated|concentration|top customer|top products?|company.*activity|financial year|fy|pi value|products?|product.*quantity)\b/i.test(
    text,
  )

const extractDays = (text, fallback = 90) => {
  const match = text.match(/\b(\d{2,3})\s*days?\b/i)

  return match ? Number(match[1]) : fallback
}

const getQuestionPeriod = (text) => {
  if (/\bfinancial year|fy\b/i.test(text)) {
    return 'current-financial-year'
  }

  if (/\bquarter\b/i.test(text)) {
    return 'current-quarter'
  }

  if (/\blast 30 days|30 days\b/i.test(text)) {
    return 'last-30-days'
  }

  if (/\bweek\b/i.test(text)) {
    return 'this-week'
  }

  if (/\btoday\b/i.test(text)) {
    return 'today'
  }

  return 'this-month'
}

export const classifyCommercialQuestion = (question) => {
  const text = toText(question)

  if (!text || !hasCommercialWords(text)) {
    return {
      intent: COMMERCIAL_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  if (/\b(stock|inventory|outstanding|ledger|accounting|balance|dispatch|production|payment)\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_UNSUPPORTED,
      parameters: {},
    }
  }

  if (/\bbrief|management brief|commercial management\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_MANAGEMENT_BRIEF,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bconcentration|few customers|top customer share|percentage.*top customer\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CONCENTRATION,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\binactive|no pi\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_INACTIVE,
      parameters: { days: extractDays(text) },
    }
  }

  if (/\breactivated|active again\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_REACTIVATED,
      parameters: { days: extractDays(text) },
    }
  }

  if (/\bproducts?\b/i.test(text) && /\bquantity|qty\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_RANKING_QUANTITY,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bproducts?\b/i.test(text) && /\bdeclin|reduced\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_DECLINE,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bproducts?\b/i.test(text) && /\bgrow|increase\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_GROWTH,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bproducts?\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_RANKING_VALUE,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\b(company|companies)\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_COMPANY_COMPARISON,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bcustomers?\b/i.test(text) && /\bdeclin|reduced|down\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_DECLINE,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bcustomers?\b/i.test(text) && /\bgrow|increase\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_GROWTH,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  if (/\bcustomers?\b|top customer|highest pi value\b/i.test(text)) {
    return {
      intent: COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_RANKING,
      parameters: { period: getQuestionPeriod(text) },
    }
  }

  return {
    intent: /\bcompare|compared|versus|vs|financial year|last month\b/i.test(text)
      ? COMMERCIAL_INTENTS.COMMERCIAL_PERIOD_COMPARISON
      : COMMERCIAL_INTENTS.COMMERCIAL_PERIOD_COMPARISON,
    parameters: { period: getQuestionPeriod(text) },
  }
}

const answerRows = (rows, label, valueKey = 'currentPIValue') => {
  if (!rows?.length) {
    return `No ${label} records were found for the selected period.`
  }

  return rows
    .slice(0, 5)
    .map((row, index) => {
      const name = row.customerName ?? row.productDescription ?? row.companyName ?? row.productCode ?? 'Unknown'

      return `${index + 1}. ${name}: ${formatINR(row[valueKey] ?? row.totalPILineValue)}`
    })
    .join('\n')
}

export const processCommercialQuestion = async ({
  modelWording = askOllama,
  queryable,
  question,
  tableNames,
  today,
  useModelWording = true,
}) => {
  const classification = classifyCommercialQuestion(question)

  if (classification.intent === COMMERCIAL_INTENTS.GENERAL_AI_QUESTION) {
    return {
      intent: classification.intent,
      mode: 'general',
      statusCode: 422,
      success: false,
    }
  }

  if (classification.intent === COMMERCIAL_INTENTS.COMMERCIAL_UNSUPPORTED) {
    return {
      intent: classification.intent,
      message:
        'Stock, accounting, outstanding, dispatch, production and payment intelligence are not connected in this phase.',
      mode: 'commercial',
      statusCode: 422,
      success: false,
    }
  }

  const params = classification.parameters ?? {}
  let data
  let answer = ''

  switch (classification.intent) {
    case COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_GROWTH:
      data = await getCustomerCommercialIntelligence({
        limit: 10,
        period: params.period,
        queryable,
        segment: 'growing',
        tableNames,
        today,
      })
      answer = answerRows(data.rows, 'growing customer')
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_DECLINE:
      data = await getCustomerCommercialIntelligence({
        limit: 10,
        period: params.period,
        queryable,
        segment: 'declining',
        tableNames,
        today,
      })
      answer = answerRows(data.rows, 'declining customer')
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_INACTIVE:
      data = await getInactiveCustomers({
        days: params.days,
        limit: 10,
        queryable,
        tableNames,
        today,
      })
      answer = data.rows?.length
        ? data.rows
            .slice(0, 5)
            .map((row, index) => `${index + 1}. ${row.customerName}: ${row.daysInactive} days since last PI activity.`)
            .join('\n')
        : 'No inactive customer records were found for the selected window.'
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_REACTIVATED:
      data = await getReactivatedCustomers({
        days: params.days,
        limit: 10,
        queryable,
        tableNames,
        today,
      })
      answer = data.rows?.length
        ? data.rows
            .slice(0, 5)
            .map((row, index) => `${index + 1}. ${row.customerName}: latest PI ${row.latestPINumber} after ${row.inactiveGapDays} inactive days.`)
            .join('\n')
        : 'No reactivated customer records were found for the selected window.'
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_RANKING_QUANTITY:
      data = await getProductCommercialIntelligence({
        limit: 10,
        period: params.period,
        queryable,
        sortBy: 'quantity',
        tableNames,
        today,
      })
      answer = data.rows?.length
        ? data.rows
            .slice(0, 5)
            .map((row, index) => `${index + 1}. ${row.productDescription}: ${row.totalQuantity} quantity, PI line value ${formatINR(row.totalPILineValue)}.`)
            .join('\n')
        : 'No product PI line activity was found.'
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_GROWTH:
    case COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_DECLINE:
    case COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_RANKING_VALUE:
      data = await getProductCommercialIntelligence({
        limit: 10,
        period: params.period,
        queryable,
        segment:
          classification.intent === COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_GROWTH
            ? 'growing'
            : classification.intent === COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_DECLINE
              ? 'declining'
              : 'all',
        tableNames,
        today,
      })
      answer = answerRows(data.rows, 'product', 'totalPILineValue')
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_COMPANY_COMPARISON:
      data = await getCompanyCommercialIntelligence({
        limit: 10,
        period: params.period,
        queryable,
        tableNames,
        today,
      })
      answer = answerRows(data.rows, 'company')
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_CONCENTRATION:
      data = await getCommercialConcentration({
        period: params.period,
        queryable,
        tableNames,
        today,
      })
      answer = `Commercial PI concentration indicator is ${data.customer?.label}. Top customer share is ${data.customer?.topCustomerShare ?? 0}%. ${data.concentrationNote}`
      break

    case COMMERCIAL_INTENTS.COMMERCIAL_MANAGEMENT_BRIEF:
      data = await getCommercialManagementBrief({
        modelWording,
        period: params.period,
        queryable,
        tableNames,
        today,
        useModelWording,
      })
      answer = data.brief
      break

    default:
      data = await getCommercialComparison({
        period: params.period,
        queryable,
        tableNames,
        today,
      })
      answer = `Current period PI value is ${formatINR(data.comparison?.current?.value)} compared with ${formatINR(data.comparison?.previous?.value)} in the comparison period. Value change percentage: ${data.comparison?.valueChange?.changePercentage ?? 'comparison unavailable'}. ${COMMERCIAL_DISCLAIMER}`
      break
  }

  if (data?.error) {
    return {
      intent: classification.intent,
      message: data.error,
      mode: 'commercial',
      statusCode: data.statusCode ?? 422,
      success: false,
    }
  }

  return {
    answer,
    data,
    intent: classification.intent,
    mode: 'commercial',
    source: {
      generatedAt: data.generatedAt,
      liveData: true,
      module: COMMERCIAL_MODULE,
      timezone: COMMERCIAL_TIMEZONE,
    },
    success: true,
    wordingMode: data.wordingMode ?? 'server-fallback',
  }
}

export const verifyCommercialIntelligenceAccess = async ({
  queryable,
  tableNames,
  userName,
}) => {
  const tables = normalizeCommercialTables(tableNames)
  const safeUserName = toText(userName)

  if (!safeUserName) {
    return {
      authorized: false,
      message: 'AI Commercial Intelligence access is required.',
    }
  }

  const userResult = await runReadOnlyQuery(
    queryable,
    `
      SELECT user_name, is_admin, is_active
      FROM ${tables.user}
      WHERE LOWER(user_name) = LOWER($1)
      LIMIT 1
    `,
    [safeUserName],
  )
  const user = userResult.rows[0]

  if (!user || !Boolean(user.is_active)) {
    return {
      authorized: false,
      message: 'AI Commercial Intelligence access is required.',
    }
  }

  if (Boolean(user.is_admin)) {
    return {
      authorized: true,
      isAdmin: true,
      userName: user.user_name,
    }
  }

  const rightsResult = await runReadOnlyQuery(
    queryable,
    `
      SELECT can_access
      FROM ${tables.userRights}
      WHERE LOWER(user_name) = LOWER($1)
        AND screen_id = $2
      LIMIT 1
    `,
    [safeUserName, COMMERCIAL_PERMISSION_ID],
  )

  return {
    authorized: Boolean(rightsResult.rows[0]?.can_access),
    isAdmin: false,
    message: rightsResult.rows[0]?.can_access
      ? ''
      : 'AI Commercial Intelligence access is required.',
    userName: user.user_name,
  }
}

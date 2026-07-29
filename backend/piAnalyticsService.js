import {
  INDIA_TIME_ZONE,
  addDays,
  clampLimit,
  getIndiaDateString,
  getLastDaysRange,
  getMonthRange,
  getRangeDays,
  getSafeCompanyExpression,
  getSafeCustomerExpression,
  getStatusExpression,
  getTodayRange,
  getWeekRange,
  getYesterdayRange,
  normalizeQuestionText,
  normalizeSearchText,
  normalizeTables,
  resolvePeriodRange,
  runReadOnlyQuery,
  toNumber,
  toText,
  validateDateRange,
} from './piIntelligenceUtils.js'

export const PI_PRO_MODULE = 'PI Intelligence Pro'

export const PI_PRO_INTENTS = {
  PI_AVERAGE_DAILY_COUNT: 'pi_average_daily_count',
  PI_AVERAGE_DAILY_VALUE: 'pi_average_daily_value',
  PI_AVERAGE_VALUE_MONTH: 'pi_average_value_month',
  PI_AVERAGE_VALUE_TODAY: 'pi_average_value_today',
  PI_BEST_DAY_COUNT: 'pi_best_day_count',
  PI_BEST_DAY_VALUE: 'pi_best_day_value',
  PI_COMPANY_RANKING: 'pi_company_ranking',
  PI_COMPANY_STATUS_RANKING: 'pi_company_status_ranking',
  PI_CUSTOMER_STATUS_RANKING: 'pi_customer_status_ranking',
  PI_FINAL_PERCENTAGE: 'pi_final_percentage',
  PI_HIGHEST_VALUE_MONTH: 'pi_highest_value_month',
  PI_LOWEST_VALUE_MONTH: 'pi_lowest_value_month',
  PI_MANAGEMENT_INSIGHT: 'pi_management_insight',
  PI_OPEN_PERCENTAGE: 'pi_open_percentage',
  PI_SMART_SEARCH: 'pi_smart_search',
  PI_TOP_COMPANY_VALUE: 'pi_top_company_value',
  PI_TOP_CUSTOMERS_COUNT: 'pi_top_customers_count',
  PI_TOP_CUSTOMERS_VALUE: 'pi_top_customers_value',
  PI_TREND_30_DAYS: 'pi_trend_30_days',
  PI_TREND_7_DAYS: 'pi_trend_7_days',
  PI_TREND_MONTH: 'pi_trend_month',
}

const DEFAULT_RANKING_LIMIT = 10
const MAX_RANKING_LIMIT = 20
const DEFAULT_TREND_LIMIT = 30

const hasPIWords = (text) => /\b(pi|pis|invoice|invoices|proforma)\b/i.test(text)

const includesAny = (text, words) => words.some((word) => text.includes(word))

const getIntentPeriod = (text, today) => {
  if (/\btoday\b/i.test(text)) {
    return getTodayRange(today)
  }

  if (/\byesterday\b/i.test(text)) {
    return getYesterdayRange(today)
  }

  if (/\b(this week|current week|week)\b/i.test(text)) {
    return getWeekRange(today)
  }

  if (/\b(last 7 days|last seven days)\b/i.test(text)) {
    return getLastDaysRange(today, 7)
  }

  if (/\b(last 30 days|last thirty days)\b/i.test(text)) {
    return getLastDaysRange(today, 30)
  }

  return getMonthRange(today)
}

const extractLimit = (text, fallback = DEFAULT_RANKING_LIMIT) => {
  const match = text.match(/\btop\s+(\d{1,2})\b/i)

  if (!match) {
    return fallback
  }

  return clampLimit(match[1], {
    defaultLimit: fallback,
    maxLimit: MAX_RANKING_LIMIT,
  })
}

const extractSearchQuery = (question) =>
  normalizeQuestionText(question)
    .replace(/\b(search|find|show|pi|proforma invoice|number|no\.?|details?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const classifyPIAnalyticsQuestion = (question, options = {}) => {
  const today = options.today ?? getIndiaDateString()
  const originalQuestion = normalizeQuestionText(question)
  const text = normalizeSearchText(originalQuestion)

  if (!text) {
    return null
  }

  const mentionsManagementInsight = /\b(management insight|business insight|pi insight|insight)\b/i.test(text)
  const mentionsSearch = /\b(search|find)\b/i.test(text) && /\bpi\b/i.test(text)

  if (!hasPIWords(text) && !mentionsManagementInsight && !mentionsSearch) {
    return null
  }

  const periodRange = getIntentPeriod(text, today)

  if (mentionsManagementInsight) {
    return {
      intent: PI_PRO_INTENTS.PI_MANAGEMENT_INSIGHT,
      parameters: periodRange,
    }
  }

  if (mentionsSearch) {
    return {
      intent: PI_PRO_INTENTS.PI_SMART_SEARCH,
      parameters: {
        q: extractSearchQuery(originalQuestion),
      },
    }
  }

  if (/\b(customers? wise|customers?-wise)\b/i.test(text) && /\b(open|final|closed|status)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_CUSTOMER_STATUS_RANKING,
      parameters: {
        ...periodRange,
        limit: DEFAULT_RANKING_LIMIT,
      },
    }
  }

  if (/\b(company wise|company-wise)\b/i.test(text) && /\b(open|final|closed|status)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_COMPANY_STATUS_RANKING,
      parameters: {
        ...periodRange,
        limit: MAX_RANKING_LIMIT,
      },
    }
  }

  if (/\btop\b/i.test(text) && /\bcustomers?\b/i.test(text) && /\bcount\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_TOP_CUSTOMERS_COUNT,
      parameters: {
        ...periodRange,
        limit: extractLimit(text),
      },
    }
  }

  if (
    (/\btop\b/i.test(text) && /\bcustomers?\b/i.test(text)) ||
    (/\bcustomers?\b/i.test(text) && /\b(highest|maximum|max)\b/i.test(text))
  ) {
    return {
      intent: PI_PRO_INTENTS.PI_TOP_CUSTOMERS_VALUE,
      parameters: {
        ...periodRange,
        limit: /\b(highest|maximum|max)\b/i.test(text) ? 1 : extractLimit(text),
      },
    }
  }

  if (
    /\bcompany\b/i.test(text) &&
    /\b(highest|maximum|max|top)\b/i.test(text) &&
    /\bvalue|amount|total\b/i.test(text)
  ) {
    return {
      intent: PI_PRO_INTENTS.PI_TOP_COMPANY_VALUE,
      parameters: {
        ...periodRange,
        limit: 1,
      },
    }
  }

  if (/\b(company wise|company-wise|company summary|company-wise summary|company ranking)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_COMPANY_RANKING,
      parameters: {
        ...periodRange,
        limit: MAX_RANKING_LIMIT,
      },
    }
  }

  if (/\baverage daily\b/i.test(text) && /\bcount\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_AVERAGE_DAILY_COUNT,
      parameters: periodRange,
    }
  }

  if (/\baverage daily\b/i.test(text) && /\b(value|amount|total)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_AVERAGE_DAILY_VALUE,
      parameters: periodRange,
    }
  }

  if (/\baverage\b/i.test(text) && /\btoday\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_AVERAGE_VALUE_TODAY,
      parameters: getTodayRange(today),
    }
  }

  if (/\baverage\b/i.test(text) && /\b(value|amount|total)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_AVERAGE_VALUE_MONTH,
      parameters: periodRange,
    }
  }

  if (/\b(highest|maximum|max)\b/i.test(text) && /\bday\b/i.test(text) && /\bcount\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_BEST_DAY_COUNT,
      parameters: periodRange,
    }
  }

  if (/\b(highest|maximum|max)\b/i.test(text) && /\bday\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_BEST_DAY_VALUE,
      parameters: periodRange,
    }
  }

  if (/\b(highest|maximum|max)\b/i.test(text) && /\b(value|amount|total)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_HIGHEST_VALUE_MONTH,
      parameters: periodRange,
    }
  }

  if (/\b(lowest|minimum|min)\b/i.test(text) && /\b(value|amount|total)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_LOWEST_VALUE_MONTH,
      parameters: periodRange,
    }
  }

  if (/\btrend\b/i.test(text) && /\b(last 7 days|last seven days)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_TREND_7_DAYS,
      parameters: getLastDaysRange(today, 7),
    }
  }

  if (/\btrend\b/i.test(text) && /\b(last 30 days|last thirty days)\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_TREND_30_DAYS,
      parameters: getLastDaysRange(today, 30),
    }
  }

  if (/\btrend\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_TREND_MONTH,
      parameters: periodRange,
    }
  }

  if (/\bpercentage|percent|%\b/i.test(text) && /\bopen|pending|draft\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_OPEN_PERCENTAGE,
      parameters: periodRange,
    }
  }

  if (/\bpercentage|percent|%\b/i.test(text) && /\bfinal|closed\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_FINAL_PERCENTAGE,
      parameters: periodRange,
    }
  }

  if (includesAny(text, ['ranking', 'top']) && /\bcompany\b/i.test(text)) {
    return {
      intent: PI_PRO_INTENTS.PI_COMPANY_RANKING,
      parameters: {
        ...periodRange,
        limit: MAX_RANKING_LIMIT,
      },
    }
  }

  return null
}

const buildDateFilter = ({ endDate, startDate }, values) => {
  values.push(startDate, endDate)
  return `m.pi_date::date BETWEEN $${values.length - 1}::date AND $${values.length}::date`
}

const mapSummaryRow = (row, range = {}) => ({
  averageValue: toNumber(row?.average_value),
  count: toNumber(row?.count),
  endDate: range.endDate ?? '',
  highestValue: toNumber(row?.highest_value),
  lowestValue: toNumber(row?.lowest_value),
  startDate: range.startDate ?? '',
  value: toNumber(row?.total_value),
})

export const getPISummaryMetrics = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value,
        COALESCE(AVG(m.grand_total), 0)::numeric AS average_value,
        COALESCE(MAX(m.grand_total), 0)::numeric AS highest_value,
        COALESCE(MIN(m.grand_total), 0)::numeric AS lowest_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
    `,
    [startDate, endDate],
  )

  return mapSummaryRow(result.rows[0], { endDate, startDate })
}

export const getPIStatusMetrics = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const statusExpression = getStatusExpression('m')
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        ${statusExpression} AS status,
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
      GROUP BY ${statusExpression}
      ORDER BY status ASC
    `,
    [startDate, endDate],
  )

  const rows = result.rows.map((row) => ({
    count: toNumber(row.count),
    status: row.status ?? '',
    value: toNumber(row.total_value),
  }))
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0)
  const totalValue = rows.reduce((sum, row) => sum + row.value, 0)
  const getStatus = (status) => {
    const row = rows.find((item) => item.status === status) ?? {
      count: 0,
      value: 0,
    }

    return {
      count: row.count,
      percentage: totalCount > 0 ? Number(((row.count / totalCount) * 100).toFixed(2)) : 0,
      value: row.value,
      valuePercentage:
        totalValue > 0 ? Number(((row.value / totalValue) * 100).toFixed(2)) : 0,
    }
  }

  return {
    final: getStatus('Final'),
    open: getStatus('Draft'),
    rows,
    totalCount,
    totalValue,
  }
}

const mapRankingRow = (row, index, type) => ({
  averagePIValue: toNumber(row.average_value),
  finalCount: toNumber(row.final_count),
  finalValue: toNumber(row.final_value),
  lastPIDate: row.last_pi_date ?? '',
  name: type === 'company' ? row.company_name ?? '' : row.customer_name ?? '',
  openCount: toNumber(row.open_count),
  openValue: toNumber(row.open_value),
  piCount: toNumber(row.pi_count),
  rank: index + 1,
  totalPIValue: toNumber(row.total_value),
})

export const getCustomerRanking = async ({
  endDate,
  limit = DEFAULT_RANKING_LIMIT,
  queryable,
  sortBy = 'value',
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const safeLimit = clampLimit(limit, {
    defaultLimit: DEFAULT_RANKING_LIMIT,
    maxLimit: MAX_RANKING_LIMIT,
  })
  const statusExpression = getStatusExpression('m')
  const customerExpression = getSafeCustomerExpression('m')
  const groupExpression = `
    CASE
      WHEN COALESCE(m.cust_code, 0) > 0 THEN 'C-' || m.cust_code::text
      ELSE 'P-' || UPPER(REGEXP_REPLACE(${customerExpression}, '\\s+', ' ', 'g'))
    END
  `
  const orderField = sortBy === 'count' ? 'pi_count' : 'total_value'
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        ${customerExpression} AS customer_name,
        COUNT(*)::int AS pi_count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value,
        COALESCE(AVG(m.grand_total), 0)::numeric AS average_value,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Draft')::int AS open_count,
        COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Draft'), 0)::numeric AS open_value,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Final')::int AS final_count,
        COALESCE(SUM(m.grand_total) FILTER (WHERE ${statusExpression} = 'Final'), 0)::numeric AS final_value,
        TO_CHAR(MAX(m.pi_date::date), 'YYYY-MM-DD') AS last_pi_date
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
      GROUP BY ${groupExpression}, ${customerExpression}
      ORDER BY ${orderField} DESC, pi_count DESC, customer_name ASC
      LIMIT $3
    `,
    [startDate, endDate, safeLimit],
  )

  return {
    endDate,
    groupNote:
      'Customer ranking groups regular customers by cust_code when available; prospective or blank customer names are grouped by normalized PI customer name.',
    limit: safeLimit,
    rows: result.rows.map((row, index) => mapRankingRow(row, index, 'customer')),
    sortBy,
    startDate,
  }
}

export const getCompanyRanking = async ({
  endDate,
  limit = MAX_RANKING_LIMIT,
  queryable,
  sortBy = 'value',
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const safeLimit = clampLimit(limit, {
    defaultLimit: MAX_RANKING_LIMIT,
    maxLimit: MAX_RANKING_LIMIT,
  })
  const statusExpression = getStatusExpression('m')
  const companyExpression = getSafeCompanyExpression('c')
  const orderField = sortBy === 'count' ? 'pi_count' : 'total_value'
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        ${companyExpression} AS company_name,
        COUNT(*)::int AS pi_count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value,
        COALESCE(AVG(m.grand_total), 0)::numeric AS average_value,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Draft')::int AS open_count,
        COUNT(*) FILTER (WHERE ${statusExpression} = 'Final')::int AS final_count,
        TO_CHAR(MAX(m.pi_date::date), 'YYYY-MM-DD') AS last_pi_date
      FROM ${tables.piMaster} m
      LEFT JOIN ${tables.company} c
        ON c.comp_code = m.comp_code
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
      GROUP BY m.comp_code, ${companyExpression}
      ORDER BY ${orderField} DESC, pi_count DESC, company_name ASC
      LIMIT $3
    `,
    [startDate, endDate, safeLimit],
  )

  return {
    endDate,
    limit: safeLimit,
    rows: result.rows.map((row, index) => mapRankingRow(row, index, 'company')),
    sortBy,
    startDate,
  }
}

export const getPITrend = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const rangeDays = getRangeDays(startDate, endDate)

  if (rangeDays > 366) {
    throw new Error('Trend period cannot exceed 366 days.')
  }

  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
      GROUP BY m.pi_date::date
      ORDER BY m.pi_date::date ASC
    `,
    [startDate, endDate],
  )

  return {
    endDate,
    rows: result.rows.map((row) => ({
      count: toNumber(row.count),
      date: row.date ?? '',
      value: toNumber(row.value),
    })),
    startDate,
  }
}

export const getBestDay = async ({
  endDate,
  metric = 'value',
  queryable,
  startDate,
  tableNames,
}) => {
  const trend = await getPITrend({
    endDate,
    queryable,
    startDate,
    tableNames,
  })
  const sortKey = metric === 'count' ? 'count' : 'value'
  const row = [...trend.rows].sort((left, right) => {
    const difference = right[sortKey] - left[sortKey]
    return difference === 0 ? left.date.localeCompare(right.date) : difference
  })[0]

  return row
    ? {
        ...row,
        metric,
      }
    : null
}

export const getLatestPIsForAnalytics = async ({
  limit = 10,
  queryable,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const safeLimit = clampLimit(limit, { defaultLimit: 10, maxLimit: 10 })
  const companyExpression = getSafeCompanyExpression('c')
  const statusExpression = getStatusExpression('m')
  const customerExpression = getSafeCustomerExpression('m')
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
      WHERE m.is_active = TRUE
      ORDER BY m.pi_date DESC, m.created_at DESC, m.pi_no DESC
      LIMIT $1
    `,
    [safeLimit],
  )

  return result.rows.map((row) => ({
    companyName: row.company_name ?? '',
    customerName: row.customer_name ?? '',
    grandTotal: toNumber(row.grand_total),
    piDate: row.pi_date ?? '',
    piNumber: row.pi_number ?? '',
    status: row.status ?? '',
  }))
}

const buildKPIGroup = (summary) => ({
  count: summary.count,
  value: summary.value,
})

export const getPIIntelligenceProDashboard = async ({
  queryable,
  tableNames,
  today = getIndiaDateString(),
}) => {
  const monthRange = getMonthRange(today)
  const todayRange = getTodayRange(today)
  const yesterdayRange = getYesterdayRange(today)
  const weekRange = getWeekRange(today)

  if (!monthRange || !weekRange) {
    throw new Error('Unable to calculate the Indian business reporting periods.')
  }

  const elapsedMonthDays = getRangeDays(monthRange.startDate, today)
  const [
    todaySummary,
    yesterdaySummary,
    weekSummary,
    monthSummary,
    statusMetrics,
    topCustomers,
    topCustomerResult,
    companyRanking,
    topCompanyResult,
    trend,
    bestDayByCount,
    bestDayByValue,
    latestPIs,
  ] = await Promise.all([
    getPISummaryMetrics({ ...todayRange, queryable, tableNames }),
    getPISummaryMetrics({ ...yesterdayRange, queryable, tableNames }),
    getPISummaryMetrics({ ...weekRange, queryable, tableNames }),
    getPISummaryMetrics({ ...monthRange, queryable, tableNames }),
    getPIStatusMetrics({ ...monthRange, queryable, tableNames }),
    getCustomerRanking({ ...monthRange, limit: DEFAULT_RANKING_LIMIT, queryable, tableNames }),
    getCustomerRanking({ ...monthRange, limit: 1, queryable, tableNames }),
    getCompanyRanking({ ...monthRange, limit: MAX_RANKING_LIMIT, queryable, tableNames }),
    getCompanyRanking({ ...monthRange, limit: 1, queryable, tableNames }),
    getPITrend({ ...monthRange, queryable, tableNames }),
    getBestDay({ ...monthRange, metric: 'count', queryable, tableNames }),
    getBestDay({ ...monthRange, metric: 'value', queryable, tableNames }),
    getLatestPIsForAnalytics({ limit: 10, queryable, tableNames }),
  ])

  return {
    bestDayByCount,
    bestDayByValue,
    companyRanking: companyRanking.rows,
    generatedAt: new Date().toISOString(),
    kpis: {
      averageDailyPICountMonth:
        elapsedMonthDays > 0
          ? Number((monthSummary.count / elapsedMonthDays).toFixed(2))
          : 0,
      averageDailyPIValueMonth:
        elapsedMonthDays > 0
          ? Number((monthSummary.value / elapsedMonthDays).toFixed(2))
          : 0,
      averagePIValueMonth: monthSummary.averageValue,
      final: statusMetrics.final,
      highestPIValueMonth: monthSummary.highestValue,
      lowestPIValueMonth: monthSummary.lowestValue,
      month: buildKPIGroup(monthSummary),
      open: statusMetrics.open,
      today: buildKPIGroup(todaySummary),
      week: buildKPIGroup(weekSummary),
      yesterday: buildKPIGroup(yesterdaySummary),
    },
    latestPIs,
    module: PI_PRO_MODULE,
    period: {
      monthEnd: monthRange.endDate,
      monthStart: monthRange.startDate,
      today,
      weekEnd: weekRange.endDate,
      weekStart: weekRange.startDate,
      yesterday: yesterdayRange.startDate,
    },
    success: true,
    timezone: INDIA_TIME_ZONE,
    topCompany: topCompanyResult.rows[0] ?? null,
    topCustomer: topCustomerResult.rows[0] ?? null,
    topCustomers: topCustomers.rows,
    trend: trend.rows,
  }
}

export const getPIAnalyticsForIntent = async ({
  classification,
  queryable,
  tableNames,
}) => {
  if (!Object.values(PI_PRO_INTENTS).includes(classification.intent)) {
    return null
  }

  const parameters = classification.parameters ?? {}
  const range = {
    endDate: parameters.endDate,
    startDate: parameters.startDate,
  }
  const validation = validateDateRange(range)

  if (!validation.ok && classification.intent !== PI_PRO_INTENTS.PI_SMART_SEARCH) {
    return {
      error: validation.message,
      statusCode: 400,
    }
  }

  switch (classification.intent) {
    case PI_PRO_INTENTS.PI_TOP_CUSTOMERS_VALUE:
      return getCustomerRanking({
        ...range,
        limit: parameters.limit,
        queryable,
        sortBy: 'value',
        tableNames,
      })

    case PI_PRO_INTENTS.PI_TOP_CUSTOMERS_COUNT:
      return getCustomerRanking({
        ...range,
        limit: parameters.limit,
        queryable,
        sortBy: 'count',
        tableNames,
      })

    case PI_PRO_INTENTS.PI_TOP_COMPANY_VALUE:
      return getCompanyRanking({
        ...range,
        limit: parameters.limit ?? 1,
        queryable,
        sortBy: 'value',
        tableNames,
      })

    case PI_PRO_INTENTS.PI_COMPANY_RANKING:
    case PI_PRO_INTENTS.PI_COMPANY_STATUS_RANKING:
      return getCompanyRanking({
        ...range,
        limit: parameters.limit ?? MAX_RANKING_LIMIT,
        queryable,
        sortBy: 'value',
        tableNames,
      })

    case PI_PRO_INTENTS.PI_CUSTOMER_STATUS_RANKING:
      return getCustomerRanking({
        ...range,
        limit: parameters.limit ?? DEFAULT_RANKING_LIMIT,
        queryable,
        sortBy: 'value',
        tableNames,
      })

    case PI_PRO_INTENTS.PI_AVERAGE_VALUE_TODAY:
    case PI_PRO_INTENTS.PI_AVERAGE_VALUE_MONTH:
    case PI_PRO_INTENTS.PI_HIGHEST_VALUE_MONTH:
    case PI_PRO_INTENTS.PI_LOWEST_VALUE_MONTH:
      return getPISummaryMetrics({
        ...range,
        queryable,
        tableNames,
      })

    case PI_PRO_INTENTS.PI_BEST_DAY_VALUE:
      return getBestDay({
        ...range,
        metric: 'value',
        queryable,
        tableNames,
      })

    case PI_PRO_INTENTS.PI_BEST_DAY_COUNT:
      return getBestDay({
        ...range,
        metric: 'count',
        queryable,
        tableNames,
      })

    case PI_PRO_INTENTS.PI_TREND_7_DAYS:
    case PI_PRO_INTENTS.PI_TREND_30_DAYS:
    case PI_PRO_INTENTS.PI_TREND_MONTH:
      return getPITrend({
        ...range,
        queryable,
        tableNames,
      })

    case PI_PRO_INTENTS.PI_OPEN_PERCENTAGE:
    case PI_PRO_INTENTS.PI_FINAL_PERCENTAGE:
      return getPIStatusMetrics({
        ...range,
        queryable,
        tableNames,
      })

    case PI_PRO_INTENTS.PI_AVERAGE_DAILY_COUNT:
    case PI_PRO_INTENTS.PI_AVERAGE_DAILY_VALUE: {
      const summary = await getPISummaryMetrics({
        ...range,
        queryable,
        tableNames,
      })
      const days = getRangeDays(range.startDate, range.endDate)

      return {
        ...summary,
        averageDailyCount: days > 0 ? Number((summary.count / days).toFixed(2)) : 0,
        averageDailyValue: days > 0 ? Number((summary.value / days).toFixed(2)) : 0,
        days,
      }
    }

    default:
      return null
  }
}

const formatINR = (value) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(toNumber(value))

const formatNumber = (value) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(toNumber(value))

export const buildPIAnalyticsAnswer = ({ data, intent }) => {
  if (!data) {
    return ''
  }

  switch (intent) {
    case PI_PRO_INTENTS.PI_TOP_CUSTOMERS_VALUE:
      return data.rows?.length
        ? `Top customer by PI value is ${data.rows[0].name} with ${formatINR(data.rows[0].totalPIValue)}.`
        : 'No customer PI value records were found.'

    case PI_PRO_INTENTS.PI_TOP_CUSTOMERS_COUNT:
      return data.rows?.length
        ? `Top customer by PI count is ${data.rows[0].name} with ${formatNumber(data.rows[0].piCount)} PI(s).`
        : 'No customer PI count records were found.'

    case PI_PRO_INTENTS.PI_TOP_COMPANY_VALUE:
      return data.rows?.length
        ? `Top company by PI value is ${data.rows[0].name} with ${formatINR(data.rows[0].totalPIValue)}.`
        : 'No company PI value records were found.'

    case PI_PRO_INTENTS.PI_COMPANY_RANKING:
    case PI_PRO_INTENTS.PI_COMPANY_STATUS_RANKING:
      return data.rows?.length
        ? `Company-wise PI summary is available for ${formatNumber(data.rows.length)} company record(s).`
        : 'No company PI records were found.'

    case PI_PRO_INTENTS.PI_CUSTOMER_STATUS_RANKING:
      return data.rows?.length
        ? `Customer-wise open and final PI summary is available for ${formatNumber(data.rows.length)} customer record(s).`
        : 'No customer PI status records were found.'

    case PI_PRO_INTENTS.PI_AVERAGE_VALUE_TODAY:
    case PI_PRO_INTENTS.PI_AVERAGE_VALUE_MONTH:
      return `Average PI value is ${formatINR(data.averageValue)}.`

    case PI_PRO_INTENTS.PI_HIGHEST_VALUE_MONTH:
      return `Highest PI value is ${formatINR(data.highestValue)}.`

    case PI_PRO_INTENTS.PI_LOWEST_VALUE_MONTH:
      return `Lowest PI value is ${formatINR(data.lowestValue)}.`

    case PI_PRO_INTENTS.PI_BEST_DAY_VALUE:
      return data
        ? `${data.date} had the highest PI value at ${formatINR(data.value)}.`
        : 'No daily PI value records were found.'

    case PI_PRO_INTENTS.PI_BEST_DAY_COUNT:
      return data
        ? `${data.date} had the highest PI count at ${formatNumber(data.count)} PI(s).`
        : 'No daily PI count records were found.'

    case PI_PRO_INTENTS.PI_TREND_7_DAYS:
    case PI_PRO_INTENTS.PI_TREND_30_DAYS:
    case PI_PRO_INTENTS.PI_TREND_MONTH:
      return data.rows?.length
        ? `PI trend is available for ${formatNumber(data.rows.length)} day(s).`
        : 'No PI trend records were found.'

    case PI_PRO_INTENTS.PI_OPEN_PERCENTAGE:
      return `Open PIs are ${formatNumber(data.open?.percentage)}% of PI count for the selected period.`

    case PI_PRO_INTENTS.PI_FINAL_PERCENTAGE:
      return `Final PIs are ${formatNumber(data.final?.percentage)}% of PI count for the selected period.`

    case PI_PRO_INTENTS.PI_AVERAGE_DAILY_COUNT:
      return `Average daily PI count is ${formatNumber(data.averageDailyCount)}.`

    case PI_PRO_INTENTS.PI_AVERAGE_DAILY_VALUE:
      return `Average daily PI value is ${formatINR(data.averageDailyValue)}.`

    default:
      return ''
  }
}

export const getRankingByPeriod = async ({
  endDate,
  limit,
  period,
  queryable,
  ranking,
  startDate,
  tableNames,
  today,
}) => {
  const range = resolvePeriodRange({
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

  if (ranking === 'company') {
    return getCompanyRanking({
      endDate: range.endDate,
      limit,
      queryable,
      startDate: range.startDate,
      tableNames,
    })
  }

  return getCustomerRanking({
    endDate: range.endDate,
    limit,
    queryable,
    startDate: range.startDate,
    tableNames,
  })
}

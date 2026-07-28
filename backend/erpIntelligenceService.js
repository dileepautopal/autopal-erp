import {
  askOllama,
  OLLAMA_MODEL,
} from './ollamaService.js'

export const ERP_INTELLIGENCE_SCREEN_ID = 'ai-erp-intelligence'

export const ERP_INTENTS = {
  GENERAL_AI_QUESTION: 'general_ai_question',
  PI_COMPANY_SUMMARY: 'pi_company_summary',
  PI_COUNT_MONTH: 'pi_count_month',
  PI_COUNT_TODAY: 'pi_count_today',
  PI_CUSTOMER_SUMMARY: 'pi_customer_summary',
  PI_DAILY_SUMMARY: 'pi_daily_summary',
  PI_DATE_RANGE_SUMMARY: 'pi_date_range_summary',
  PI_LATEST: 'pi_latest',
  PI_STATUS_SUMMARY: 'pi_status_summary',
  PI_VALUE_MONTH: 'pi_value_month',
  PI_VALUE_TODAY: 'pi_value_today',
  UNSUPPORTED_ERP_QUESTION: 'unsupported_erp_question',
}

const ERP_MODULE = 'PI Intelligence'
const INDIA_TIME_ZONE = 'Asia/Kolkata'
const MAX_QUESTION_LENGTH = 5_000
const MAX_RANGE_DAYS = 366
const MAX_LATEST_LIMIT = 20
const DEFAULT_LATEST_LIMIT = 10
const QUERY_TIMEOUT_MS = 15_000

const DEFAULT_TABLE_NAMES = {
  company: 'master_company',
  customer: 'master_customer',
  piMaster: 'master_pi_rmkt',
  user: 'master_user',
  userRights: 'master_user_rights',
}

const MONTHS = {
  apr: '04',
  april: '04',
  aug: '08',
  august: '08',
  dec: '12',
  december: '12',
  feb: '02',
  february: '02',
  jan: '01',
  january: '01',
  jul: '07',
  july: '07',
  jun: '06',
  june: '06',
  mar: '03',
  march: '03',
  may: '05',
  nov: '11',
  november: '11',
  oct: '10',
  october: '10',
  sep: '09',
  sept: '09',
  september: '09',
}

const ERP_WORDING_SYSTEM_PROMPT = `
You are AUTOPAL's internal ERP reporting assistant.

You will receive verified structured data produced by approved backend queries.

Rules:
1. Use only the supplied figures.
2. Never change, estimate or invent numbers.
3. Do not claim access beyond the supplied result.
4. Keep the answer concise and professional.
5. Use Indian number formatting for INR amounts.
6. If data is empty, state that no matching records were found.
7. Do not expose internal table names or SQL.
`.trim()

const toText = (value) => String(value ?? '').trim()

const normalizeQuestionText = (value) =>
  toText(value)
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const normalizeSearchText = (value) =>
  normalizeQuestionText(value)
    .toLowerCase()
    .replace(/\bproforma\s+invoice\b/g, 'pi')
    .replace(/\bp\.?\s*i\.?\b/g, 'pi')

const toNumber = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const toISODate = (date) => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

export const getIndiaDateString = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(date)
  const getPart = (type) => parts.find((part) => part.type === type)?.value ?? ''

  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`
}

const parseISODateToUTC = (value) => {
  const match = toText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return date
}

const addDays = (dateString, days) => {
  const date = parseISODateToUTC(dateString)

  if (!date) {
    return ''
  }

  date.setUTCDate(date.getUTCDate() + days)
  return toISODate(date)
}

const getMonthRange = (dateString) => {
  const date = parseISODateToUTC(dateString)

  if (!date) {
    return null
  }

  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))

  return {
    endDate: toISODate(endDate),
    startDate: toISODate(startDate),
  }
}

const getRangeDays = (startDate, endDate) => {
  const start = parseISODateToUTC(startDate)
  const end = parseISODateToUTC(endDate)

  if (!start || !end) {
    return Number.POSITIVE_INFINITY
  }

  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
}

const parseNaturalDate = (value) => {
  const text = toText(value)
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)

  if (match) {
    return normalizeDateParts(match[1], match[2], match[3])
  }

  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)

  if (match) {
    return normalizeDateParts(match[3], match[2], match[1])
  }

  match = text.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/)

  if (match && MONTHS[match[2]]) {
    return normalizeDateParts(match[3], MONTHS[match[2]], match[1])
  }

  return ''
}

const normalizeDateParts = (yearValue, monthValue, dayValue) => {
  const year = String(Number(yearValue)).padStart(4, '0')
  const month = String(Number(monthValue)).padStart(2, '0')
  const day = String(Number(dayValue)).padStart(2, '0')
  const dateText = `${year}-${month}-${day}`

  return parseISODateToUTC(dateText) ? dateText : ''
}

export const validateDateRange = ({ endDate, startDate }) => {
  if (!parseISODateToUTC(startDate) || !parseISODateToUTC(endDate)) {
    return {
      ok: false,
      message: 'Please provide valid dates in YYYY-MM-DD or DD/MM/YYYY format.',
    }
  }

  if (startDate > endDate) {
    return {
      ok: false,
      message: 'Start date must be before or equal to end date.',
    }
  }

  if (getRangeDays(startDate, endDate) > MAX_RANGE_DAYS) {
    return {
      ok: false,
      message: `Date range cannot exceed ${MAX_RANGE_DAYS} days.`,
    }
  }

  return { ok: true }
}

const extractExplicitDateRange = (text) => {
  const datePattern =
    '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}|\\d{1,2}\\s+[a-zA-Z]+\\s+\\d{4})'
  const rangeMatch = text.match(
    new RegExp(`(?:from|between)\\s+${datePattern}\\s+(?:to|and)\\s+${datePattern}`, 'i'),
  )

  if (!rangeMatch) {
    return null
  }

  return {
    endDate: parseNaturalDate(rangeMatch[2]),
    startDate: parseNaturalDate(rangeMatch[1]),
  }
}

const getTodayRange = (today) => ({
  endDate: today,
  startDate: today,
})

const getYesterdayRange = (today) => {
  const yesterday = addDays(today, -1)

  return {
    endDate: yesterday,
    startDate: yesterday,
  }
}

const extractEntityAfterKeyword = (question, keywords) => {
  const pattern = new RegExp(`\\b(?:${keywords.join('|')})\\b\\s+(.+)$`, 'i')
  const match = question.match(pattern)

  if (!match) {
    return ''
  }

  return match[1]
    .replace(/\b(?:pi|pis|proforma invoice|summary|count|value|amount|generated|for)\b/gi, ' ')
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const extractForEntity = (question) => {
  const match = question.match(/\bfor\s+(.+)$/i)

  if (!match) {
    return ''
  }

  const candidate = match[1]
    .replace(/\b(?:this month|current month|today|yesterday)\b/gi, ' ')
    .replace(/[?.!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  return candidate
}

const hasERPModuleWords = (text) =>
  /\b(pi|pis|invoice|invoices|proforma)\b/i.test(text)

const hasUnsupportedModuleWords = (text) =>
  /\b(stock|inventory|outstanding|ledger|accounting|balance|dispatch|production|purchase|payment due|receivable|payable)\b/i.test(
    text,
  )

const hasGeneralDraftingWords = (text) =>
  /\b(draft|write|rewrite|email|mail|whatsapp message|follow-up|follow up|explain|summari[sz]e)\b/i.test(
    text,
  )

export const classifyERPQuestion = (question, options = {}) => {
  const today = options.today ?? getIndiaDateString()
  const originalQuestion = normalizeQuestionText(question)
  const text = normalizeSearchText(originalQuestion)

  if (!text) {
    return {
      intent: ERP_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  if (hasUnsupportedModuleWords(text) && !hasERPModuleWords(text)) {
    return {
      intent: ERP_INTENTS.UNSUPPORTED_ERP_QUESTION,
      parameters: {
        module: getUnsupportedModuleName(text),
      },
    }
  }

  if (hasGeneralDraftingWords(text) && !/\b(count|value|amount|latest|recent|pending|open|closed|final|generated|summary by|by day|daily)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  if (!hasERPModuleWords(text)) {
    return {
      intent: ERP_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  const explicitRange = extractExplicitDateRange(originalQuestion)
  const monthRange = getMonthRange(today)

  if (/\b(latest|recent|last)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_LATEST,
      parameters: {
        limit: DEFAULT_LATEST_LIMIT,
      },
    }
  }

  if (/\b(by day|daily|day wise|date wise)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_DAILY_SUMMARY,
      parameters: explicitRange ?? monthRange,
    }
  }

  if (/\b(company|comp code|company code)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_COMPANY_SUMMARY,
      parameters: {
        companyName: extractEntityAfterKeyword(originalQuestion, [
          'company',
          'comp code',
          'company code',
        ]),
      },
    }
  }

  if (/\bcustomer\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_CUSTOMER_SUMMARY,
      parameters: {
        customerName: extractEntityAfterKeyword(originalQuestion, ['customer']),
      },
    }
  }

  const forEntity = extractForEntity(originalQuestion)

  if (
    forEntity &&
    !/\b(this month|current month|today|yesterday)\b/i.test(text) &&
    !explicitRange
  ) {
    return {
      intent: ERP_INTENTS.PI_CUSTOMER_SUMMARY,
      parameters: {
        customerName: forEntity,
      },
    }
  }

  if (/\b(pending|open|closed|final|status)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_STATUS_SUMMARY,
      parameters: {
        status: getRequestedStatus(text),
      },
    }
  }

  if (explicitRange) {
    return {
      intent: ERP_INTENTS.PI_DATE_RANGE_SUMMARY,
      parameters: explicitRange,
    }
  }

  if (/\b(today)\b/i.test(text)) {
    if (/\b(value|amount|total)\b/i.test(text)) {
      return {
        intent: ERP_INTENTS.PI_VALUE_TODAY,
        parameters: getTodayRange(today),
      }
    }

    return {
      intent: ERP_INTENTS.PI_COUNT_TODAY,
      parameters: getTodayRange(today),
    }
  }

  if (/\b(yesterday)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_DATE_RANGE_SUMMARY,
      parameters: getYesterdayRange(today),
    }
  }

  if (/\b(this month|current month|monthly|month)\b/i.test(text)) {
    if (/\b(value|amount|total)\b/i.test(text)) {
      return {
        intent: ERP_INTENTS.PI_VALUE_MONTH,
        parameters: monthRange,
      }
    }

    if (/\b(summary)\b/i.test(text)) {
      return {
        intent: ERP_INTENTS.PI_DATE_RANGE_SUMMARY,
        parameters: monthRange,
      }
    }

    return {
      intent: ERP_INTENTS.PI_COUNT_MONTH,
      parameters: monthRange,
    }
  }

  if (/\b(value|amount|total|count|generated|summary)\b/i.test(text)) {
    return {
      intent: ERP_INTENTS.PI_DATE_RANGE_SUMMARY,
      parameters: monthRange,
    }
  }

  return {
    intent: ERP_INTENTS.UNSUPPORTED_ERP_QUESTION,
    parameters: {
      module: 'ERP intelligence',
    },
  }
}

const getUnsupportedModuleName = (text) => {
  if (/\b(stock|inventory)\b/i.test(text)) {
    return 'Inventory intelligence'
  }

  if (/\b(outstanding|ledger|accounting|balance|receivable|payable)\b/i.test(text)) {
    return 'Accounting or outstanding intelligence'
  }

  if (/\b(dispatch|production)\b/i.test(text)) {
    return 'Dispatch or production intelligence'
  }

  return 'ERP intelligence'
}

const getRequestedStatus = (text) => {
  if (/\b(closed|final)\b/i.test(text)) {
    return 'Final'
  }

  if (/\b(pending|open|draft)\b/i.test(text)) {
    return 'Draft'
  }

  return ''
}

const normalizeTables = (tableNames = {}) => ({
  ...DEFAULT_TABLE_NAMES,
  ...tableNames,
})

const ensureReadOnlySQL = (sql) => {
  const normalized = toText(sql)
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  if (!/^(SELECT|WITH)\b/.test(normalized)) {
    throw new Error('ERP Intelligence supports read-only SELECT queries only.')
  }

  if (/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|LOCK|GRANT|REVOKE)\b/.test(normalized)) {
    throw new Error('ERP Intelligence blocked a non-read-only query.')
  }
}

export const runReadOnlyQuery = async (queryable, sql, params = []) => {
  ensureReadOnlySQL(sql)

  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('ERP Intelligence query timed out.')),
      QUERY_TIMEOUT_MS,
    )
  })

  try {
    return await Promise.race([queryable.query(sql, params), timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

export const getPICountForDateRange = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT COUNT(*)::int AS count
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
    `,
    [startDate, endDate],
  )

  return {
    count: toNumber(result.rows[0]?.count),
    endDate,
    startDate,
  }
}

export const getPIValueForDateRange = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.pi_date::date BETWEEN $1::date AND $2::date
    `,
    [startDate, endDate],
  )

  return {
    endDate,
    startDate,
    totalValue: toNumber(result.rows[0]?.total_value),
  }
}

export const getPISummaryForDateRange = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const [countResult, valueResult] = await Promise.all([
    getPICountForDateRange({ endDate, queryable, startDate, tableNames }),
    getPIValueForDateRange({ endDate, queryable, startDate, tableNames }),
  ])

  return {
    count: countResult.count,
    endDate,
    startDate,
    totalValue: valueResult.totalValue,
  }
}

export const getPIStatusSummary = async ({
  endDate = '',
  queryable,
  startDate = '',
  status = '',
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const values = []
  const filters = ['m.is_active = TRUE']

  if (startDate && endDate) {
    values.push(startDate, endDate)
    filters.push(`m.pi_date::date BETWEEN $${values.length - 1}::date AND $${values.length}::date`)
  }

  if (status) {
    values.push(status)
    filters.push(`CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END = $${values.length}`)
  }

  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END AS status,
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
      FROM ${tables.piMaster} m
      WHERE ${filters.join('\n        AND ')}
      GROUP BY CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END
      ORDER BY status ASC
    `,
    values,
  )

  return {
    rows: result.rows.map((row) => ({
      count: toNumber(row.count),
      status: row.status ?? '',
      totalValue: toNumber(row.total_value),
    })),
    status,
  }
}

export const getLatestPIs = async ({
  limit = DEFAULT_LATEST_LIMIT,
  queryable,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LATEST_LIMIT, 1), MAX_LATEST_LIMIT)
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        m.pcust_name AS customer_name,
        COALESCE(NULLIF(c.legal_name, ''), c.company_name, '') AS company_name,
        CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END AS status,
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

  return {
    limit: safeLimit,
    rows: result.rows.map(mapPIListRow),
  }
}

export const getPIDailySummary = async ({
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
        TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
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
      date: row.pi_date ?? '',
      totalValue: toNumber(row.total_value),
    })),
    startDate,
  }
}

const mapPIListRow = (row) => ({
  companyName: row.company_name ?? '',
  customerName: row.customer_name ?? '',
  piDate: row.pi_date ?? '',
  piNumber: row.pi_number ?? '',
  status: row.status ?? '',
  value: toNumber(row.grand_total),
})

const getStatusSummaryRow = (rows, status) =>
  rows.find((row) => row.status === status) ?? {
    count: 0,
    status,
    totalValue: 0,
  }

const mapDashboardSummary = (summary) => ({
  count: toNumber(summary?.count),
  value: toNumber(summary?.totalValue),
})

const mapDashboardLatestPI = (row) => ({
  companyName: row.companyName ?? '',
  customerName: row.customerName ?? '',
  grandTotal: toNumber(row.value),
  piDate: row.piDate ?? '',
  piNumber: row.piNumber ?? '',
  status: row.status ?? '',
})

const mapDashboardDailySummary = (row) => ({
  count: toNumber(row.count),
  date: row.date ?? '',
  value: toNumber(row.totalValue),
})

const findCustomerMatches = async ({ customerName, queryable, tableNames }) => {
  const tables = normalizeTables(tableNames)
  const search = toText(customerName)

  if (!search) {
    return {
      error: 'Please specify a customer name.',
      matches: [],
      statusCode: 400,
    }
  }

  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT cust_code, cust_name
      FROM ${tables.customer}
      WHERE is_active = TRUE
        AND (
          LOWER(cust_name) = LOWER($1)
          OR LOWER(cust_name) LIKE LOWER($2)
        )
      ORDER BY
        CASE WHEN LOWER(cust_name) = LOWER($1) THEN 1 ELSE 2 END,
        cust_name ASC
      LIMIT 6
    `,
    [search, `%${search}%`],
  )

  return {
    matches: result.rows.map((row) => ({
      custCode: Number(row.cust_code),
      name: row.cust_name ?? '',
    })),
  }
}

const findCompanyMatches = async ({ companyName, queryable, tableNames }) => {
  const tables = normalizeTables(tableNames)
  const search = toText(companyName)

  if (!search) {
    return {
      error: 'Please specify a company name or company code.',
      matches: [],
      statusCode: 400,
    }
  }

  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT comp_code, company_id, company_name, legal_name
      FROM ${tables.company}
      WHERE is_active = TRUE
        AND (
          comp_code::text = $1
          OR LOWER(company_id) = LOWER($1)
          OR LOWER(company_name) = LOWER($1)
          OR LOWER(legal_name) = LOWER($1)
          OR LOWER(company_name) LIKE LOWER($2)
          OR LOWER(legal_name) LIKE LOWER($2)
        )
      ORDER BY
        CASE
          WHEN comp_code::text = $1 THEN 1
          WHEN LOWER(company_id) = LOWER($1) THEN 2
          WHEN LOWER(company_name) = LOWER($1) THEN 3
          WHEN LOWER(legal_name) = LOWER($1) THEN 4
          ELSE 5
        END,
        company_name ASC
      LIMIT 6
    `,
    [search, `%${search}%`],
  )

  return {
    matches: result.rows.map((row) => ({
      compCode: Number(row.comp_code),
      name: row.legal_name || row.company_name || row.company_id || '',
    })),
  }
}

export const getCustomerPISummary = async ({
  customerName,
  queryable,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const matchResult = await findCustomerMatches({ customerName, queryable, tableNames })

  if (matchResult.error) {
    return {
      error: matchResult.error,
      statusCode: matchResult.statusCode,
    }
  }

  if (matchResult.matches.length === 0) {
    return {
      error: 'Customer not found for PI Intelligence.',
      statusCode: 404,
    }
  }

  if (matchResult.matches.length > 1) {
    return {
      error: 'Multiple customers matched. Please ask again with the exact customer name.',
      matches: matchResult.matches.map((match) => match.name),
      statusCode: 422,
    }
  }

  const customer = matchResult.matches[0]
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.cust_code = $1
    `,
    [customer.custCode],
  )

  return {
    count: toNumber(result.rows[0]?.count),
    customerName: customer.name,
    totalValue: toNumber(result.rows[0]?.total_value),
  }
}

export const getCompanyPISummary = async ({
  companyName,
  queryable,
  tableNames,
}) => {
  const tables = normalizeTables(tableNames)
  const matchResult = await findCompanyMatches({ companyName, queryable, tableNames })

  if (matchResult.error) {
    return {
      error: matchResult.error,
      statusCode: matchResult.statusCode,
    }
  }

  if (matchResult.matches.length === 0) {
    return {
      error: 'Company not found for PI Intelligence.',
      statusCode: 404,
    }
  }

  if (matchResult.matches.length > 1) {
    return {
      error: 'Multiple companies matched. Please ask again with the exact company name or code.',
      matches: matchResult.matches.map((match) => match.name),
      statusCode: 422,
    }
  }

  const company = matchResult.matches[0]
  const result = await runReadOnlyQuery(
    queryable,
    `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(m.grand_total), 0)::numeric AS total_value
      FROM ${tables.piMaster} m
      WHERE m.is_active = TRUE
        AND m.comp_code = $1
    `,
    [company.compCode],
  )

  return {
    companyName: company.name,
    compCode: company.compCode,
    count: toNumber(result.rows[0]?.count),
    totalValue: toNumber(result.rows[0]?.total_value),
  }
}

const runApprovedERPFunction = async ({ classification, queryable, tableNames }) => {
  const parameters = classification.parameters ?? {}

  switch (classification.intent) {
    case ERP_INTENTS.PI_COUNT_TODAY:
    case ERP_INTENTS.PI_COUNT_MONTH:
      return getPICountForDateRange({
        endDate: parameters.endDate,
        queryable,
        startDate: parameters.startDate,
        tableNames,
      })

    case ERP_INTENTS.PI_VALUE_TODAY:
    case ERP_INTENTS.PI_VALUE_MONTH:
      return getPIValueForDateRange({
        endDate: parameters.endDate,
        queryable,
        startDate: parameters.startDate,
        tableNames,
      })

    case ERP_INTENTS.PI_DATE_RANGE_SUMMARY:
      return getPISummaryForDateRange({
        endDate: parameters.endDate,
        queryable,
        startDate: parameters.startDate,
        tableNames,
      })

    case ERP_INTENTS.PI_STATUS_SUMMARY:
      return getPIStatusSummary({
        queryable,
        status: parameters.status,
        tableNames,
      })

    case ERP_INTENTS.PI_LATEST:
      return getLatestPIs({
        limit: parameters.limit,
        queryable,
        tableNames,
      })

    case ERP_INTENTS.PI_CUSTOMER_SUMMARY:
      return getCustomerPISummary({
        customerName: parameters.customerName,
        queryable,
        tableNames,
      })

    case ERP_INTENTS.PI_COMPANY_SUMMARY:
      return getCompanyPISummary({
        companyName: parameters.companyName,
        queryable,
        tableNames,
      })

    case ERP_INTENTS.PI_DAILY_SUMMARY:
      return getPIDailySummary({
        endDate: parameters.endDate,
        queryable,
        startDate: parameters.startDate,
        tableNames,
      })

    default:
      return {
        error: 'This ERP question is not connected in the current Phase 4 implementation.',
        statusCode: 422,
      }
  }
}

const validateClassificationDates = (classification) => {
  const parameters = classification.parameters ?? {}

  if (!parameters.startDate && !parameters.endDate) {
    return { ok: true }
  }

  return validateDateRange({
    endDate: parameters.endDate,
    startDate: parameters.startDate,
  })
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

export const buildDeterministicERPAnswer = ({ data, intent }) => {
  switch (intent) {
    case ERP_INTENTS.PI_COUNT_TODAY:
      return `Today, ${formatNumber(data.count)} Proforma Invoices were generated.`

    case ERP_INTENTS.PI_COUNT_MONTH:
      return `This month, ${formatNumber(data.count)} Proforma Invoices were generated.`

    case ERP_INTENTS.PI_VALUE_TODAY:
      return `Today's total PI value is ${formatINR(data.totalValue)}.`

    case ERP_INTENTS.PI_VALUE_MONTH:
      return `This month's total PI value is ${formatINR(data.totalValue)}.`

    case ERP_INTENTS.PI_DATE_RANGE_SUMMARY:
      return `From ${data.startDate} to ${data.endDate}, ${formatNumber(data.count)} Proforma Invoices were generated with total value ${formatINR(data.totalValue)}.`

    case ERP_INTENTS.PI_STATUS_SUMMARY:
      if (!data.rows?.length) {
        return 'No matching PI status records were found.'
      }
      return data.rows
        .map(
          (row) =>
            `${row.status}: ${formatNumber(row.count)} PI(s), value ${formatINR(row.totalValue)}`,
        )
        .join('\n')

    case ERP_INTENTS.PI_LATEST:
      return data.rows?.length
        ? `Showing the latest ${formatNumber(data.rows.length)} Proforma Invoice(s).`
        : 'No latest PI records were found.'

    case ERP_INTENTS.PI_CUSTOMER_SUMMARY:
      return `${data.customerName}: ${formatNumber(data.count)} PI(s), total value ${formatINR(data.totalValue)}.`

    case ERP_INTENTS.PI_COMPANY_SUMMARY:
      return `${data.companyName}: ${formatNumber(data.count)} PI(s), total value ${formatINR(data.totalValue)}.`

    case ERP_INTENTS.PI_DAILY_SUMMARY:
      return data.rows?.length
        ? `Daily PI summary is available for ${data.startDate} to ${data.endDate}.`
        : `No PI records were found from ${data.startDate} to ${data.endDate}.`

    default:
      return 'The requested ERP intelligence result is available.'
  }
}

const collectPermittedNumberTokens = (value, tokens = new Set()) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    tokens.add(String(Math.trunc(value)))
    tokens.add(value.toFixed(2))
    tokens.add(formatNumber(value).replace(/,/g, ''))
  } else if (typeof value === 'string') {
    const matches = value.match(/\d+/g) ?? []
    matches.forEach((match) => tokens.add(String(Number(match))))
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectPermittedNumberTokens(item, tokens))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectPermittedNumberTokens(item, tokens))
  }

  return tokens
}

const collectRequiredNumberGroups = (value, groups = []) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    groups.push(
      new Set([
        String(Math.trunc(value)),
        value.toFixed(2),
        formatNumber(value).replace(/,/g, ''),
      ]),
    )
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectRequiredNumberGroups(item, groups))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectRequiredNumberGroups(item, groups))
  }

  return groups
}

const modelAnswerKeepsVerifiedNumbers = (answer, data) => {
  const permitted = collectPermittedNumberTokens(data)
  const answerNumbers = answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? []
  const normalizedAnswerNumbers = new Set(
    answerNumbers.map((numberText) => numberText.replace(/,/g, '')),
  )
  const requiredGroups = collectRequiredNumberGroups(data)
  const hasRequiredNumbers = requiredGroups.every((group) =>
    Array.from(group).some(
      (numberText) =>
        normalizedAnswerNumbers.has(numberText) ||
        normalizedAnswerNumbers.has(String(Number(numberText))),
    ),
  )

  return hasRequiredNumbers && answerNumbers.every((numberText) => {
    const normalized = numberText.replace(/,/g, '')
    return permitted.has(normalized) || permitted.has(String(Number(normalized)))
  })
}

const getModelERPAnswer = async ({ data, intent, modelWording = askOllama }) => {
  const result = await modelWording({
    question: JSON.stringify({
      intent,
      result: data,
    }),
    systemPrompt: ERP_WORDING_SYSTEM_PROMPT,
  })
  const answer = toText(result.answer)

  if (!answer || !modelAnswerKeepsVerifiedNumbers(answer, data)) {
    return null
  }

  return {
    answer,
    model: result.model || OLLAMA_MODEL,
  }
}

export const processERPQuestion = async ({
  modelWording = askOllama,
  queryable,
  question,
  tableNames,
  today = getIndiaDateString(),
  useModelWording = true,
}) => {
  const normalizedQuestion = normalizeQuestionText(question)

  if (!normalizedQuestion) {
    return {
      message: 'Question is required.',
      statusCode: 400,
      success: false,
    }
  }

  if (normalizedQuestion.length > MAX_QUESTION_LENGTH) {
    return {
      message: 'Question must be 5,000 characters or less.',
      statusCode: 400,
      success: false,
    }
  }

  const classification = classifyERPQuestion(normalizedQuestion, { today })

  if (classification.intent === ERP_INTENTS.GENERAL_AI_QUESTION) {
    return {
      intent: classification.intent,
      message: 'This is a general AI question, not an ERP Intelligence query.',
      mode: 'general',
      statusCode: 422,
      success: false,
    }
  }

  if (classification.intent === ERP_INTENTS.UNSUPPORTED_ERP_QUESTION) {
    const moduleName = classification.parameters?.module ?? 'ERP intelligence'

    return {
      intent: classification.intent,
      message: `${moduleName} is not connected in the current Phase 4 implementation.`,
      mode: 'erp',
      statusCode: 422,
      success: false,
    }
  }

  const dateValidation = validateClassificationDates(classification)

  if (!dateValidation.ok) {
    return {
      intent: classification.intent,
      message: dateValidation.message,
      mode: 'erp',
      statusCode: 400,
      success: false,
    }
  }

  const data = await runApprovedERPFunction({
    classification,
    queryable,
    tableNames,
  })

  if (data.error) {
    return {
      data: data.matches ? { matches: data.matches } : undefined,
      intent: classification.intent,
      message: data.error,
      mode: 'erp',
      source: buildERPSource(),
      statusCode: data.statusCode ?? 422,
      success: false,
    }
  }

  const fallbackAnswer = buildDeterministicERPAnswer({
    data,
    intent: classification.intent,
  })
  let answer = fallbackAnswer
  let model = null
  let wordingMode = 'server-fallback'

  if (useModelWording) {
    try {
      const modelResult = await getModelERPAnswer({
        data,
        intent: classification.intent,
        modelWording,
      })

      if (modelResult) {
        answer = modelResult.answer
        model = modelResult.model
        wordingMode = 'ollama'
      }
    } catch {
      answer = fallbackAnswer
      model = null
      wordingMode = 'server-fallback'
    }
  }

  return {
    answer,
    data,
    intent: classification.intent,
    mode: 'erp',
    model,
    source: buildERPSource(),
    statusCode: 200,
    success: true,
    wordingMode,
  }
}

const buildERPSource = () => ({
  generatedAt: new Date().toISOString(),
  liveData: true,
  module: ERP_MODULE,
  timezone: INDIA_TIME_ZONE,
})

export const getPIIntelligenceDashboard = async ({
  queryable,
  tableNames,
  today = getIndiaDateString(),
}) => {
  const todayRange = getTodayRange(today)
  const monthRange = getMonthRange(today)

  if (!monthRange) {
    throw new Error('Unable to calculate the current Indian business month.')
  }

  const [
    todaySummary,
    monthSummary,
    statusSummary,
    latestPIResult,
    dailySummary,
  ] = await Promise.all([
    getPISummaryForDateRange({
      endDate: todayRange.endDate,
      queryable,
      startDate: todayRange.startDate,
      tableNames,
    }),
    getPISummaryForDateRange({
      endDate: monthRange.endDate,
      queryable,
      startDate: monthRange.startDate,
      tableNames,
    }),
    getPIStatusSummary({
      queryable,
      tableNames,
    }),
    getLatestPIs({
      limit: DEFAULT_LATEST_LIMIT,
      queryable,
      tableNames,
    }),
    getPIDailySummary({
      endDate: monthRange.endDate,
      queryable,
      startDate: monthRange.startDate,
      tableNames,
    }),
  ])

  const openSummary = getStatusSummaryRow(statusSummary.rows, 'Draft')
  const finalSummary = getStatusSummaryRow(statusSummary.rows, 'Final')

  return {
    dailySummary: dailySummary.rows.map(mapDashboardDailySummary),
    generatedAt: new Date().toISOString(),
    latestPIs: latestPIResult.rows
      .slice(0, DEFAULT_LATEST_LIMIT)
      .map(mapDashboardLatestPI),
    module: ERP_MODULE,
    success: true,
    summary: {
      final: mapDashboardSummary(finalSummary),
      month: mapDashboardSummary(monthSummary),
      open: mapDashboardSummary(openSummary),
      today: mapDashboardSummary(todaySummary),
    },
    timezone: INDIA_TIME_ZONE,
  }
}

export const verifyERPIntelligenceAccess = async ({
  queryable,
  tableNames,
  userName,
}) => {
  const tables = normalizeTables(tableNames)
  const safeUserName = toText(userName)

  if (!safeUserName) {
    return {
      authorized: false,
      message: 'AI ERP Intelligence access is required.',
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
      message: 'AI ERP Intelligence access is required.',
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
    [safeUserName, ERP_INTELLIGENCE_SCREEN_ID],
  )

  return {
    authorized: Boolean(rightsResult.rows[0]?.can_access),
    isAdmin: false,
    message: rightsResult.rows[0]?.can_access
      ? ''
      : 'AI ERP Intelligence access is required.',
    userName: user.user_name,
  }
}

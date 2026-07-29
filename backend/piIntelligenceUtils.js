export const INDIA_TIME_ZONE = 'Asia/Kolkata'
export const MAX_RANGE_DAYS = 366
export const QUERY_TIMEOUT_MS = 15_000

export const DEFAULT_TABLE_NAMES = {
  company: 'master_company',
  customer: 'master_customer',
  piMaster: 'master_pi_rmkt',
  piTran: 'tran_pi_rmkt',
}

export const toText = (value) => String(value ?? '').trim()

export const normalizeQuestionText = (value) =>
  toText(value)
    .replace(/[â€™â€˜]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

export const normalizeSearchText = (value) =>
  normalizeQuestionText(value)
    .toLowerCase()
    .replace(/\bproforma\s+invoice\b/g, 'pi')
    .replace(/\bp\.?\s*i\.?\b/g, 'pi')

export const toNumber = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

export const normalizeTables = (tableNames = {}) => ({
  ...DEFAULT_TABLE_NAMES,
  ...tableNames,
})

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

export const parseISODateToUTC = (value) => {
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

export const addDays = (dateString, days) => {
  const date = parseISODateToUTC(dateString)

  if (!date) {
    return ''
  }

  date.setUTCDate(date.getUTCDate() + days)
  return toISODate(date)
}

export const getMonthRange = (dateString) => {
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

export const getTodayRange = (today) => ({
  endDate: today,
  startDate: today,
})

export const getYesterdayRange = (today) => {
  const yesterday = addDays(today, -1)

  return {
    endDate: yesterday,
    startDate: yesterday,
  }
}

export const getWeekRange = (today) => {
  const date = parseISODateToUTC(today)

  if (!date) {
    return null
  }

  const daysFromMonday = (date.getUTCDay() + 6) % 7

  return {
    endDate: today,
    startDate: addDays(today, -daysFromMonday),
  }
}

export const getLastDaysRange = (today, days) => ({
  endDate: today,
  startDate: addDays(today, -(Math.max(Number(days) || 1, 1) - 1)),
})

export const getRangeDays = (startDate, endDate) => {
  const start = parseISODateToUTC(startDate)
  const end = parseISODateToUTC(endDate)

  if (!start || !end) {
    return Number.POSITIVE_INFINITY
  }

  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1
}

export const validateDateRange = ({ endDate, startDate }) => {
  if (!parseISODateToUTC(startDate) || !parseISODateToUTC(endDate)) {
    return {
      ok: false,
      message: 'Please provide valid dates in YYYY-MM-DD format.',
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

export const resolvePeriodRange = ({
  endDate = '',
  period = 'month',
  startDate = '',
  today = getIndiaDateString(),
} = {}) => {
  const normalizedPeriod = toText(period).toLowerCase().replace(/[\s_]+/g, '-')
  let range

  if (startDate || endDate || normalizedPeriod === 'custom') {
    range = {
      endDate,
      startDate,
    }
  } else if (normalizedPeriod === 'today') {
    range = getTodayRange(today)
  } else if (normalizedPeriod === 'yesterday') {
    range = getYesterdayRange(today)
  } else if (normalizedPeriod === 'week' || normalizedPeriod === 'this-week') {
    range = getWeekRange(today)
  } else if (normalizedPeriod === 'last-7-days' || normalizedPeriod === 'last7') {
    range = getLastDaysRange(today, 7)
  } else if (
    normalizedPeriod === 'last-30-days' ||
    normalizedPeriod === 'last30'
  ) {
    range = getLastDaysRange(today, 30)
  } else {
    range = getMonthRange(today)
  }

  const validation = validateDateRange(range ?? {})

  return {
    ...(range ?? {}),
    ok: validation.ok,
    message: validation.message ?? '',
    period: normalizedPeriod,
  }
}

const ensureReadOnlySQL = (sql) => {
  const normalized = toText(sql)
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

  if (!/^(SELECT|WITH)\b/.test(normalized)) {
    throw new Error('PI Intelligence supports read-only SELECT queries only.')
  }

  if (/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|LOCK|GRANT|REVOKE)\b/.test(normalized)) {
    throw new Error('PI Intelligence blocked a non-read-only query.')
  }
}

export const runReadOnlyQuery = async (queryable, sql, params = []) => {
  ensureReadOnlySQL(sql)

  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('PI Intelligence query timed out.')),
      QUERY_TIMEOUT_MS,
    )
  })

  try {
    return await Promise.race([queryable.query(sql, params), timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

export const clampLimit = (limit, { defaultLimit = 10, maxLimit = 50 } = {}) =>
  Math.min(Math.max(Number(limit) || defaultLimit, 1), maxLimit)

export const escapeLikePattern = (value) =>
  toText(value).replace(/[\\%_]/g, (match) => `\\${match}`)

export const getStatusExpression = (alias = 'm') =>
  `CASE WHEN ${alias}.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END`

export const getSafeCompanyExpression = (alias = 'c') =>
  `COALESCE(NULLIF(BTRIM(REGEXP_REPLACE(BTRIM(${alias}.company_name), '\\s+', ' ', 'g')), ''), NULLIF(BTRIM(REGEXP_REPLACE(BTRIM(${alias}.legal_name), '\\s+', ' ', 'g')), ''), 'Unknown Company')`

export const getSafeCustomerExpression = (alias = 'm') =>
  `COALESCE(NULLIF(BTRIM(REGEXP_REPLACE(BTRIM(${alias}.pcust_name), '\\s+', ' ', 'g')), ''), 'Unknown Customer')`

export const mapStatusFilter = (value) => {
  const status = toText(value).toLowerCase()

  if (['open', 'pending', 'draft'].includes(status)) {
    return 'Draft'
  }

  if (['final', 'closed', 'close'].includes(status)) {
    return 'Final'
  }

  return ''
}

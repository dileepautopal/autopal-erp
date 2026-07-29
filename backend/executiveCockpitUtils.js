import {
  COMMERCIAL_LIMITS,
  COMMERCIAL_THRESHOLDS,
  normalizeCommercialTables,
} from './commercialIntelligenceUtils.js'
import {
  getIndiaDateString,
  getRangeDays,
  parseISODateToUTC,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'

export const EXECUTIVE_PERMISSION_ID = 'ai-executive-cockpit'
export const EXECUTIVE_MODULE = 'Executive AI Cockpit'
export const EXECUTIVE_TIMEZONE = 'Asia/Kolkata'
export const EXECUTIVE_DISCLAIMER =
  'This cockpit is based on Proforma Invoice activity and does not represent completed sales, invoiced revenue, dispatch or payment.'

export const EXECUTIVE_LIMITS = {
  alertList: 20,
  companyRows: 10,
  customerActivityRows: 20,
  customerRows: 10,
  productRows: 10,
  trendDays: 730,
}

export const EXECUTIVE_THRESHOLDS = {
  attentionDeclinePercentage: -10,
  customerInactivityDays: 90,
  highConcentrationPercentage: COMMERCIAL_THRESHOLDS.concentrationHigh,
  highDeclinePercentage: -20,
  largePIMultiple: 2,
  moderateConcentrationPercentage: COMMERCIAL_THRESHOLDS.concentrationModerate,
  productConcentrationPercentage: COMMERCIAL_THRESHOLDS.concentrationHigh,
}

export const EXECUTIVE_DEFAULT_PERIOD = 'this-month'
export const EXECUTIVE_DEFAULT_COMPARISON_MODE = 'previous-equivalent'

export const getExecutiveMeta = () => ({
  disclaimer: EXECUTIVE_DISCLAIMER,
  generatedAt: new Date().toISOString(),
  module: EXECUTIVE_MODULE,
  timezone: EXECUTIVE_TIMEZONE,
})

export const normalizeExecutiveTables = normalizeCommercialTables

export const safeRound = (value) => Number(toNumber(value).toFixed(2))

export const formatINR = (value) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(toNumber(value))

export const getPercentage = (part, total) => {
  const safeTotal = toNumber(total)

  if (safeTotal <= 0) {
    return 0
  }

  return Number(((toNumber(part) / safeTotal) * 100).toFixed(2))
}

export const getDirection = (percentage) => {
  if (percentage === null || percentage === undefined) {
    return 'unavailable'
  }

  if (percentage <= EXECUTIVE_THRESHOLDS.attentionDeclinePercentage) {
    return 'down'
  }

  if (percentage >= Math.abs(EXECUTIVE_THRESHOLDS.attentionDeclinePercentage)) {
    return 'up'
  }

  return 'stable'
}

export const clampExecutiveLimit = (value, maxLimit, defaultLimit) => {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return defaultLimit
  }

  return Math.min(Math.floor(number), maxLimit)
}

export const validateExecutivePeriod = ({ endDate, startDate }) => {
  const start = parseISODateToUTC(startDate)
  const end = parseISODateToUTC(endDate)

  if (!start || !end) {
    return {
      message: 'Start date and end date are required.',
      ok: false,
    }
  }

  if (start > end) {
    return {
      message: 'Start date cannot be after end date.',
      ok: false,
    }
  }

  const days = getRangeDays(startDate, endDate)

  if (days > EXECUTIVE_LIMITS.trendDays) {
    return {
      message: `Executive cockpit period cannot exceed ${EXECUTIVE_LIMITS.trendDays} days.`,
      ok: false,
    }
  }

  return {
    days,
    ok: true,
  }
}

export const getDaysWithoutPIAtPeriodEnd = (trendRows, periodEndDate) => {
  const endDate = periodEndDate || getIndiaDateString()
  const datesWithActivity = new Set(
    Array.isArray(trendRows)
      ? trendRows.filter((row) => toNumber(row.count) > 0).map((row) => row.date)
      : [],
  )
  let date = endDate
  let days = 0

  while (!datesWithActivity.has(date) && days < COMMERCIAL_LIMITS.rangeDays) {
    days += 1
    const parsedDate = parseISODateToUTC(date)

    if (!parsedDate) {
      break
    }

    parsedDate.setUTCDate(parsedDate.getUTCDate() - 1)
    date = parsedDate.toISOString().slice(0, 10)
  }

  return days
}

export const toSafeText = (value, fallback = '-') => {
  const text = toText(value)

  return text || fallback
}

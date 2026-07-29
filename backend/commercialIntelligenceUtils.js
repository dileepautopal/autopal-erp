import {
  addDays,
  clampLimit,
  getIndiaDateString,
  getRangeDays,
  parseISODateToUTC,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'

export const COMMERCIAL_PERMISSION_ID = 'ai-commercial-intelligence'
export const COMMERCIAL_MODULE = 'Commercial PI Intelligence'
export const COMMERCIAL_TIMEZONE = 'Asia/Kolkata'
export const COMMERCIAL_DISCLAIMER =
  'Commercial Intelligence is based on Proforma Invoice activity and does not represent completed sales, invoiced revenue, dispatch or payment.'

export const COMMERCIAL_LIMITS = {
  company: 50,
  customer: 100,
  defaultList: 10,
  inactiveExport: 500,
  product: 100,
  rangeDays: 730,
  topList: 10,
  trendDays: 730,
}

export const COMMERCIAL_THRESHOLDS = {
  concentrationHigh: 35,
  concentrationModerate: 20,
  growthPercentage: 10,
  reactivationDays: 90,
}

export const DEFAULT_COMMERCIAL_TABLE_NAMES = {
  company: 'master_company',
  customer: 'master_customer',
  piMaster: 'master_pi_rmkt',
  piTran: 'tran_pi_rmkt',
  product: 'master_products',
  user: 'master_user',
  userRights: 'master_user_rights',
}

export const normalizeCommercialTables = (tableNames = {}) => ({
  ...DEFAULT_COMMERCIAL_TABLE_NAMES,
  ...tableNames,
})

const toISODate = (date) => {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

const shiftYears = (dateString, years) => {
  const date = parseISODateToUTC(dateString)

  if (!date) {
    return ''
  }

  const month = date.getUTCMonth()
  date.setUTCFullYear(date.getUTCFullYear() + years)

  if (date.getUTCMonth() !== month) {
    date.setUTCDate(0)
  }

  return toISODate(date)
}

const previousEquivalentPeriod = ({ endDate, startDate }) => {
  const days = getRangeDays(startDate, endDate)
  const previousEndDate = addDays(startDate, -1)

  return {
    endDate: previousEndDate,
    startDate: addDays(previousEndDate, -(days - 1)),
  }
}

const samePeriodPreviousYear = ({ endDate, startDate }) => ({
  endDate: shiftYears(endDate, -1),
  startDate: shiftYears(startDate, -1),
})

const getQuarterRange = (today) => {
  const date = parseISODateToUTC(today)

  if (!date) {
    return null
  }

  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 1))
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth + 3, 0))

  return {
    endDate: toISODate(endDate),
    startDate: toISODate(startDate),
  }
}

const getQuarterToDateRange = (today) => {
  const range = getQuarterRange(today)

  return range
    ? {
        ...range,
        endDate: today,
      }
    : null
}

const getPreviousQuarterRange = (today) => {
  const date = parseISODateToUTC(today)

  if (!date) {
    return null
  }

  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth - 3, 1))
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), quarterStartMonth, 0))

  return {
    endDate: toISODate(endDate),
    startDate: toISODate(startDate),
  }
}

const clampRangeEnd = (startDate, days, maxEndDate) => {
  const endDate = addDays(startDate, days - 1)

  return endDate > maxEndDate ? maxEndDate : endDate
}

const getEquivalentRangeFromStart = (startDate, days, maxEndDate) => ({
  endDate: clampRangeEnd(startDate, days, maxEndDate),
  startDate,
})

const getFinancialYearRange = (today) => {
  const date = parseISODateToUTC(today)

  if (!date) {
    return null
  }

  const fiscalYearStartYear =
    date.getUTCMonth() + 1 >= 4 ? date.getUTCFullYear() : date.getUTCFullYear() - 1

  return {
    endDate: `${fiscalYearStartYear + 1}-03-31`,
    startDate: `${fiscalYearStartYear}-04-01`,
  }
}

const getFinancialYearToDateRange = (today) => {
  const range = getFinancialYearRange(today)

  return range
    ? {
        ...range,
        endDate: today,
      }
    : null
}

const getPreviousMonthRange = (today) => {
  const date = parseISODateToUTC(today)

  if (!date) {
    return null
  }

  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1))
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0))

  return {
    endDate: toISODate(endDate),
    startDate: toISODate(startDate),
  }
}

const getPreviousFinancialYearRange = (today) => {
  const current = getFinancialYearRange(today)

  return current ? samePeriodPreviousYear(current) : null
}

const validateCommercialDateRange = ({ endDate, startDate }) => {
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

  if (days > COMMERCIAL_LIMITS.rangeDays) {
    return {
      message: `Commercial date range cannot exceed ${COMMERCIAL_LIMITS.rangeDays} days.`,
      ok: false,
    }
  }

  return {
    days,
    ok: true,
  }
}

const periodDefinitions = {
  today: ({ today }) => ({
    comparisonLabel: 'Yesterday',
    label: 'Today',
    range: { endDate: today, startDate: today },
  }),
  yesterday: ({ today }) => {
    const yesterday = addDays(today, -1)

    return {
      comparisonLabel: 'Previous Day',
      label: 'Yesterday',
      range: { endDate: yesterday, startDate: yesterday },
    }
  },
  'this-week': ({ today }) => {
    const date = parseISODateToUTC(today)
    const daysFromMonday = date ? (date.getUTCDay() + 6) % 7 : 0
    const weekStart = addDays(today, -daysFromMonday)

    return {
      comparisonLabel: 'Previous Week',
      label: 'This Week',
      comparisonRange: {
        endDate: addDays(weekStart, -1),
        startDate: addDays(weekStart, -7),
      },
      range: {
        endDate: today,
        startDate: weekStart,
      },
    }
  },
  'previous-week': ({ today }) => {
    const currentWeek = periodDefinitions['this-week']({ today }).range
    const previous = {
      endDate: addDays(currentWeek.startDate, -1),
      startDate: addDays(currentWeek.startDate, -7),
    }

    return {
      comparisonLabel: 'Week Before Previous',
      label: 'Previous Week',
      comparisonRange: {
        endDate: addDays(previous.startDate, -1),
        startDate: addDays(previous.startDate, -7),
      },
      range: previous,
    }
  },
  'this-month': ({ today }) => {
    const date = parseISODateToUTC(today)

    if (!date) {
      return null
    }
    const monthStart = toISODate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)))
    const previous = getPreviousMonthRange(today)
    const days = getRangeDays(monthStart, today)

    return {
      comparisonLabel: 'Previous Month',
      label: 'This Month',
      comparisonRange: previous
        ? getEquivalentRangeFromStart(previous.startDate, days, previous.endDate)
        : null,
      range: {
        endDate: today,
        startDate: monthStart,
      },
    }
  },
  'previous-month': ({ today }) => {
    const previous = getPreviousMonthRange(today)

    return {
      comparisonLabel: 'Month Before Previous',
      label: 'Previous Month',
      comparisonRange: previous ? previousEquivalentPeriod(previous) : null,
      range: previous,
    }
  },
  'last-30-days': ({ today }) => ({
    comparisonLabel: 'Previous 30 Days',
    label: 'Last 30 Days',
    range: { endDate: today, startDate: addDays(today, -29) },
  }),
  'previous-30-days': ({ today }) => {
    const current = periodDefinitions['last-30-days']({ today }).range
    const previous = previousEquivalentPeriod(current)

    return {
      comparisonLabel: '30 Days Before Previous',
      label: 'Previous 30 Days',
      range: previous,
    }
  },
  'current-quarter': ({ today }) => ({
    comparisonLabel: 'Previous Quarter',
    label: 'Current Quarter',
    comparisonRange: (() => {
      const current = getQuarterToDateRange(today)
      const previous = getPreviousQuarterRange(today)

      return current && previous
        ? getEquivalentRangeFromStart(
            previous.startDate,
            getRangeDays(current.startDate, current.endDate),
            previous.endDate,
          )
        : null
    })(),
    range: getQuarterToDateRange(today),
  }),
  'previous-quarter': ({ today }) => {
    const previous = getPreviousQuarterRange(today)

    return {
      comparisonLabel: 'Quarter Before Previous',
      label: 'Previous Quarter',
      comparisonRange: previous ? previousEquivalentPeriod(previous) : null,
      range: previous,
    }
  },
  'current-financial-year': ({ today }) => ({
    comparisonLabel: 'Previous Financial Year',
    label: 'Current Financial Year',
    comparisonRange: (() => {
      const current = getFinancialYearToDateRange(today)
      const previous = getPreviousFinancialYearRange(today)

      return current && previous
        ? getEquivalentRangeFromStart(
            previous.startDate,
            getRangeDays(current.startDate, current.endDate),
            previous.endDate,
          )
        : null
    })(),
    range: getFinancialYearToDateRange(today),
  }),
  'previous-financial-year': ({ today }) => {
    const previous = getPreviousFinancialYearRange(today)

    return {
      comparisonLabel: 'Financial Year Before Previous',
      label: 'Previous Financial Year',
      comparisonRange: previous ? samePeriodPreviousYear(previous) : null,
      range: previous,
    }
  },
  ytd: ({ today }) => {
    const fy = getFinancialYearRange(today)

    return {
      comparisonLabel: 'Previous Year-to-Date',
      label: 'Year-to-Date',
      range: {
        endDate: today,
        startDate: fy?.startDate ?? today,
      },
    }
  },
}

export const normalizeCommercialPeriod = (period = 'this-month') =>
  toText(period).toLowerCase().replace(/[\s_]+/g, '-')

export const resolveCommercialPeriod = ({
  comparisonMode = 'previous-equivalent',
  endDate = '',
  period = 'this-month',
  startDate = '',
  today = getIndiaDateString(),
} = {}) => {
  const normalizedPeriod = normalizeCommercialPeriod(period)
  const isCustom = normalizedPeriod === 'custom' || startDate || endDate
  const definition = isCustom
    ? {
        comparisonLabel:
          comparisonMode === 'same-period-previous-year'
            ? 'Same Period Previous Year'
            : 'Previous Equivalent Period',
        label: 'Custom Period',
        range: { endDate, startDate },
      }
    : periodDefinitions[normalizedPeriod]?.({ today })

  if (!definition?.range) {
    return {
      ok: false,
      message: 'Unsupported commercial reporting period.',
    }
  }

  const validation = validateCommercialDateRange(definition.range)

  if (!validation.ok) {
    return {
      ok: false,
      message: validation.message,
    }
  }

  const comparisonRange =
    comparisonMode === 'same-period-previous-year'
      ? samePeriodPreviousYear(definition.range)
      : definition.comparisonRange ?? previousEquivalentPeriod(definition.range)
  const comparisonValidation = validateCommercialDateRange(comparisonRange)

  if (!comparisonValidation.ok) {
    return {
      ok: false,
      message: comparisonValidation.message,
    }
  }

  return {
    comparisonMode,
    comparisonPeriod: {
      ...comparisonRange,
      days: comparisonValidation.days,
      label: definition.comparisonLabel,
    },
    ok: true,
    period: {
      ...definition.range,
      days: validation.days,
      label: definition.label,
    },
  }
}

export const getChange = (currentValue, previousValue) => {
  const current = toNumber(currentValue)
  const previous = toNumber(previousValue)
  const change = Number((current - previous).toFixed(2))

  if (previous === 0) {
    return {
      change,
      changeAvailable: false,
      changePercentage: null,
      direction: current > 0 ? 'up' : 'unavailable',
      reason: 'Previous period value is zero.',
    }
  }

  const changePercentage = Number(((change / previous) * 100).toFixed(2))
  const threshold = COMMERCIAL_THRESHOLDS.growthPercentage
  const direction =
    Math.abs(changePercentage) < threshold
      ? 'stable'
      : changePercentage > 0
        ? 'up'
        : 'down'

  return {
    change,
    changeAvailable: true,
    changePercentage,
    direction,
    reason: '',
  }
}

export const classifyCommercialActivity = ({
  currentValue = 0,
  historicalCount = 0,
  previousValue = 0,
}) => {
  const current = toNumber(currentValue)
  const previous = toNumber(previousValue)
  const historical = toNumber(historicalCount)

  if (current > 0 && previous === 0 && historical <= 0) {
    return 'New'
  }

  if (current > 0 && previous === 0) {
    return 'Reactivated'
  }

  if (current === 0 && previous > 0) {
    return 'Inactive'
  }

  if (current === 0 && previous === 0) {
    return historical > 0 ? 'Inactive' : 'Insufficient history'
  }

  const change = getChange(current, previous)

  if (!change.changeAvailable) {
    return 'Insufficient history'
  }

  if (change.changePercentage >= COMMERCIAL_THRESHOLDS.growthPercentage) {
    return 'Growing'
  }

  if (change.changePercentage <= -COMMERCIAL_THRESHOLDS.growthPercentage) {
    return 'Declining'
  }

  return 'Stable'
}

export const getConcentrationLabel = (sharePercentage) => {
  const share = toNumber(sharePercentage)

  if (share >= COMMERCIAL_THRESHOLDS.concentrationHigh) {
    return 'High'
  }

  if (share >= COMMERCIAL_THRESHOLDS.concentrationModerate) {
    return 'Moderate'
  }

  return 'Low'
}

export const getSharePercentage = (value, total) => {
  const numericTotal = toNumber(total)

  if (numericTotal <= 0) {
    return 0
  }

  return Number(((toNumber(value) / numericTotal) * 100).toFixed(2))
}

export const getDaysBetween = (fromDate, toDate) => {
  const from = parseISODateToUTC(fromDate)
  const to = parseISODateToUTC(toDate)

  if (!from || !to) {
    return null
  }

  return Math.max(Math.floor((to.getTime() - from.getTime()) / 86_400_000), 0)
}

export const clampCommercialLimit = (limit, maxLimit) =>
  clampLimit(limit, {
    defaultLimit: COMMERCIAL_LIMITS.defaultList,
    maxLimit,
  })

export const getSafeCustomerGroupExpression = (customerExpression) => `
  CASE
    WHEN COALESCE(m.cust_code, 0) > 0 THEN 'C-' || m.cust_code::text
    ELSE 'P-' || UPPER(REGEXP_REPLACE(${customerExpression}, '\\s+', ' ', 'g'))
  END
`

export const getSafeProductExpression = (alias = 'p', lineAlias = 't') =>
  `COALESCE(NULLIF(BTRIM(${alias}.description), ''), NULLIF(BTRIM(${lineAlias}.product_code), ''), 'Unknown Product')`

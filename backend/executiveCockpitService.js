import {
  getCommercialDashboard,
  getCommercialSummary,
} from './commercialIntelligenceService.js'
import {
  COMMERCIAL_LIMITS,
  resolveCommercialPeriod,
} from './commercialIntelligenceUtils.js'
import { buildExecutiveAlerts } from './executiveAlertService.js'
import {
  EXECUTIVE_DEFAULT_COMPARISON_MODE,
  EXECUTIVE_DEFAULT_PERIOD,
  EXECUTIVE_DISCLAIMER,
  EXECUTIVE_LIMITS,
  EXECUTIVE_PERMISSION_ID,
  EXECUTIVE_THRESHOLDS,
  getExecutiveMeta,
  getPercentage,
  normalizeExecutiveTables,
  safeRound,
  validateExecutivePeriod,
} from './executiveCockpitUtils.js'
import {
  getPIIntelligenceProDashboard,
} from './piAnalyticsService.js'
import {
  getIndiaDateString,
  getSafeCompanyExpression,
  getSafeCustomerExpression,
  getStatusExpression,
  runReadOnlyQuery,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'

export { EXECUTIVE_PERMISSION_ID }

const getCurrentMonthComparison = async ({ queryable, tableNames, today }) =>
  getCommercialDashboard({
    comparisonMode: EXECUTIVE_DEFAULT_COMPARISON_MODE,
    period: EXECUTIVE_DEFAULT_PERIOD,
    queryable,
    tableNames,
    today,
  })

export const verifyExecutiveCockpitAccess = async ({
  queryable,
  tableNames,
  userName,
}) => {
  const tables = normalizeExecutiveTables(tableNames)
  const safeUserName = toText(userName)

  if (!safeUserName) {
    return {
      authorized: false,
      message: 'Executive AI Cockpit access is required.',
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
      message: 'Executive AI Cockpit access is required.',
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
    [safeUserName, EXECUTIVE_PERMISSION_ID],
  )

  return {
    authorized: Boolean(rightsResult.rows[0]?.can_access),
    isAdmin: false,
    message: rightsResult.rows[0]?.can_access
      ? ''
      : 'Executive AI Cockpit access is required.',
    userName: user.user_name,
  }
}

export const getExecutiveTrend = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const validation = validateExecutivePeriod({ endDate, startDate })

  if (!validation.ok) {
    return {
      error: validation.message,
      statusCode: 400,
    }
  }

  const tables = normalizeExecutiveTables(tableNames)
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
    days: validation.days,
    endDate,
    rows: result.rows.map((row) => ({
      count: toNumber(row.count),
      date: row.date ?? '',
      value: safeRound(row.value),
    })),
    startDate,
    success: true,
  }
}

export const getExecutiveLargePIs = async ({
  endDate,
  queryable,
  startDate,
  tableNames,
}) => {
  const validation = validateExecutivePeriod({ endDate, startDate })

  if (!validation.ok) {
    return {
      error: validation.message,
      statusCode: 400,
    }
  }

  const tables = normalizeExecutiveTables(tableNames)
  const companyExpression = getSafeCompanyExpression('c')
  const customerExpression = getSafeCustomerExpression('m')
  const statusExpression = getStatusExpression('m')
  const result = await runReadOnlyQuery(
    queryable,
    `
      WITH period_rows AS (
        SELECT
          m.pi_series || LPAD(m.pi_no::text, 4, '0') AS pi_number,
          TO_CHAR(m.pi_date::date, 'YYYY-MM-DD') AS pi_date,
          ${customerExpression} AS customer_name,
          ${companyExpression} AS company_name,
          ${statusExpression} AS status,
          COALESCE(m.grand_total, 0)::numeric AS grand_total,
          COALESCE(AVG(m.grand_total) OVER (), 0)::numeric AS average_value
        FROM ${tables.piMaster} m
        LEFT JOIN ${tables.company} c
          ON c.comp_code = m.comp_code
        WHERE m.is_active = TRUE
          AND m.pi_date::date BETWEEN $1::date AND $2::date
      )
      SELECT
        pi_number,
        pi_date,
        customer_name,
        company_name,
        status,
        grand_total,
        average_value
      FROM period_rows
      WHERE average_value > 0
        AND grand_total >= average_value * $3::numeric
      ORDER BY grand_total DESC, pi_date DESC, pi_number DESC
      LIMIT $4
    `,
    [
      startDate,
      endDate,
      EXECUTIVE_THRESHOLDS.largePIMultiple,
      EXECUTIVE_LIMITS.alertList,
    ],
  )

  return result.rows.map((row) => ({
    averagePIValue: safeRound(row.average_value),
    companyName: row.company_name ?? '',
    customerName: row.customer_name ?? '',
    grandTotal: safeRound(row.grand_total),
    piDate: row.pi_date ?? '',
    piNumber: row.pi_number ?? '',
    status: row.status ?? '',
  }))
}

const statusFromCommercialSummary = (summary) => ({
  final: {
    count: summary.finalCount,
    percentage: getPercentage(summary.finalCount, summary.count),
    value: summary.finalValue,
    valuePercentage: getPercentage(summary.finalValue, summary.value),
  },
  open: {
    count: summary.openCount,
    percentage: getPercentage(summary.openCount, summary.count),
    value: summary.openValue,
    valuePercentage: getPercentage(summary.openValue, summary.value),
  },
})

const getCustomerStatusCounts = (customerRows, inactiveRows, reactivatedRows) => {
  const counts = {
    declining: 0,
    growing: 0,
    inactive: Array.isArray(inactiveRows) ? inactiveRows.length : 0,
    insufficientHistory: 0,
    new: 0,
    reactivated: Array.isArray(reactivatedRows) ? reactivatedRows.length : 0,
    stable: 0,
  }

  customerRows.forEach((row) => {
    const classification = row.classification

    if (classification === 'Growing') {
      counts.growing += 1
    } else if (classification === 'Declining') {
      counts.declining += 1
    } else if (classification === 'New') {
      counts.new += 1
    } else if (classification === 'Reactivated') {
      counts.reactivated += 1
    } else if (classification === 'Stable') {
      counts.stable += 1
    } else {
      counts.insufficientHistory += 1
    }
  })

  return counts
}

const topProductName = (product) =>
  product ? `${product.productCode || '-'} - ${product.productDescription || '-'}` : ''

const buildKpis = ({
  commercialDashboard,
  monthCommercialDashboard,
  piDashboard,
  previousMonthSummary,
}) => {
  const current = commercialDashboard.comparison?.current ?? {}
  const monthCurrent = monthCommercialDashboard.comparison?.current ?? {}
  const monthPrevious = monthCommercialDashboard.comparison?.previous ?? previousMonthSummary
  const topCustomer = commercialDashboard.customerSummary?.ranking?.[0] ?? null
  const topProduct = commercialDashboard.productSummary?.ranking?.[0] ?? null
  const topCompany = commercialDashboard.companySummary?.ranking?.[0] ?? null

  return {
    averageDailyPICount: piDashboard.kpis?.averageDailyPICountMonth ?? 0,
    averageDailyPIValue: piDashboard.kpis?.averageDailyPIValueMonth ?? 0,
    averagePIValue: current.averagePIValue ?? 0,
    commercialConcentrationLabel:
      commercialDashboard.concentration?.customer?.label ?? 'Unavailable',
    finalPercentage: getPercentage(current.finalCount, current.count),
    finalPICount: current.finalCount ?? 0,
    finalPIValue: current.finalValue ?? 0,
    highestPIValue: current.highestPIValue ?? 0,
    lowestPIValue: current.lowestPIValue ?? 0,
    monthlyCountChangePercentage:
      monthCommercialDashboard.comparison?.countChange?.changePercentage ?? null,
    monthlyValueChangePercentage:
      monthCommercialDashboard.comparison?.valueChange?.changePercentage ?? null,
    openPercentage: getPercentage(current.openCount, current.count),
    openPICount: current.openCount ?? 0,
    openPIValue: current.openValue ?? 0,
    previousMonthPICount: monthPrevious?.count ?? 0,
    previousMonthPIValue: monthPrevious?.value ?? 0,
    thisMonthPICount: monthCurrent.count ?? piDashboard.kpis?.month?.count ?? 0,
    thisMonthPIValue: monthCurrent.value ?? piDashboard.kpis?.month?.value ?? 0,
    thisWeekPICount: piDashboard.kpis?.week?.count ?? 0,
    thisWeekPIValue: piDashboard.kpis?.week?.value ?? 0,
    todayPICount: piDashboard.kpis?.today?.count ?? 0,
    todayPIValue: piDashboard.kpis?.today?.value ?? 0,
    topCompany: topCompany?.companyName ?? piDashboard.topCompany?.name ?? '',
    topCompanyPIValue: topCompany?.currentPIValue ?? piDashboard.topCompany?.totalPIValue ?? 0,
    topCustomer: topCustomer?.customerName ?? piDashboard.topCustomer?.name ?? '',
    topCustomerPIValue: topCustomer?.currentPIValue ?? piDashboard.topCustomer?.totalPIValue ?? 0,
    topCustomerSharePercentage:
      commercialDashboard.concentration?.customer?.topCustomerShare ??
      topCustomer?.shareOfTotalPIValue ??
      0,
    topProduct: topProductName(topProduct),
    topProductPILineValue: topProduct?.totalPILineValue ?? 0,
    yesterdayPICount: piDashboard.kpis?.yesterday?.count ?? 0,
    yesterdayPIValue: piDashboard.kpis?.yesterday?.value ?? 0,
  }
}

const getGrowthHighlights = (commercialDashboard) => {
  const customerRows = commercialDashboard.customerSummary?.ranking ?? []
  const productRows = commercialDashboard.productSummary?.ranking ?? []
  const inactiveRows = commercialDashboard.customerSummary?.inactive ?? []
  const reactivatedRows = commercialDashboard.customerSummary?.reactivated ?? []

  return {
    customerStatusCounts: getCustomerStatusCounts(customerRows, inactiveRows, reactivatedRows),
    decliningCustomerCount: commercialDashboard.customerSummary?.declining?.length ?? 0,
    decliningCustomers: commercialDashboard.customerSummary?.declining ?? [],
    decliningProductCount: commercialDashboard.productSummary?.declining?.length ?? 0,
    decliningProducts: commercialDashboard.productSummary?.declining ?? [],
    growingCustomerCount: commercialDashboard.customerSummary?.growing?.length ?? 0,
    growingCustomers: commercialDashboard.customerSummary?.growing ?? [],
    growingProductCount: commercialDashboard.productSummary?.growing?.length ?? 0,
    growingProducts: commercialDashboard.productSummary?.growing ?? [],
    newCustomerCount: customerRows.filter((row) => row.classification === 'New').length,
    stableCustomerCount: customerRows.filter((row) => row.classification === 'Stable').length,
  }
}

export const getExecutiveCockpit = async ({
  comparisonMode = EXECUTIVE_DEFAULT_COMPARISON_MODE,
  endDate,
  period = EXECUTIVE_DEFAULT_PERIOD,
  queryable,
  startDate,
  tableNames,
  today = getIndiaDateString(),
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
      message: range.message,
      statusCode: 400,
      success: false,
    }
  }

  const [
    piDashboard,
    commercialDashboard,
    monthCommercialDashboard,
    previousMonthSummary,
    trend,
    largePIs,
  ] = await Promise.all([
    getPIIntelligenceProDashboard({ queryable, tableNames, today }),
    getCommercialDashboard({
      comparisonMode,
      endDate,
      period,
      queryable,
      startDate,
      tableNames,
      today,
    }),
    getCurrentMonthComparison({ queryable, tableNames, today }),
    getCommercialSummary({
      ...resolveCommercialPeriod({
        period: 'previous-month',
        today,
      }).period,
      queryable,
      tableNames,
    }),
    getExecutiveTrend({
      ...range.period,
      queryable,
      tableNames,
    }),
    getExecutiveLargePIs({
      ...range.period,
      queryable,
      tableNames,
    }),
  ])

  if (commercialDashboard.error || !commercialDashboard.success) {
    return {
      message: commercialDashboard.error || commercialDashboard.message,
      statusCode: commercialDashboard.statusCode ?? 422,
      success: false,
    }
  }

  if (trend.error) {
    return {
      message: trend.error,
      statusCode: trend.statusCode ?? 422,
      success: false,
    }
  }

  const kpis = buildKpis({
    commercialDashboard,
    monthCommercialDashboard,
    piDashboard,
    previousMonthSummary,
  })
  const status = statusFromCommercialSummary(commercialDashboard.comparison.current)
  const customerRows = (commercialDashboard.customerSummary?.ranking ?? []).slice(
    0,
    EXECUTIVE_LIMITS.customerRows,
  )
  const productRows = (commercialDashboard.productSummary?.ranking ?? []).slice(
    0,
    EXECUTIVE_LIMITS.productRows,
  )
  const companyRows = (commercialDashboard.companySummary?.ranking ?? []).slice(
    0,
    EXECUTIVE_LIMITS.companyRows,
  )
  const cockpit = {
    ...getExecutiveMeta(),
    activityHighlights: {
      inactiveCount: commercialDashboard.customerSummary?.inactive?.length ?? 0,
      inactiveCustomers: (commercialDashboard.customerSummary?.inactive ?? []).slice(
        0,
        EXECUTIVE_LIMITS.customerActivityRows,
      ),
      reactivatedCount: commercialDashboard.customerSummary?.reactivated?.length ?? 0,
      reactivatedCustomers: (commercialDashboard.customerSummary?.reactivated ?? []).slice(
        0,
        EXECUTIVE_LIMITS.customerActivityRows,
      ),
    },
    alerts: [],
    comparisonPeriod: commercialDashboard.comparisonPeriod,
    companyHighlights: {
      rows: companyRows,
      topCompany: companyRows[0] ?? null,
    },
    concentration: {
      ...commercialDashboard.concentration,
      thresholds: {
        high: EXECUTIVE_THRESHOLDS.highConcentrationPercentage,
        moderate: EXECUTIVE_THRESHOLDS.moderateConcentrationPercentage,
      },
    },
    customerHighlights: {
      rows: customerRows,
      topCustomer: customerRows[0] ?? null,
    },
    executiveBrief: null,
    growthHighlights: getGrowthHighlights(commercialDashboard),
    kpis,
    largePIs,
    period: commercialDashboard.period,
    productHighlights: {
      dataQuality: commercialDashboard.productDataQuality,
      rows: productRows,
      topProduct: productRows[0] ?? null,
    },
    source: {
      commercialDashboardGeneratedAt: commercialDashboard.generatedAt,
      liveData: true,
      piDashboardGeneratedAt: piDashboard.generatedAt,
    },
    status,
    success: true,
    thresholds: EXECUTIVE_THRESHOLDS,
    today,
    trend: trend.rows,
  }

  cockpit.alerts = buildExecutiveAlerts(cockpit)

  return cockpit
}

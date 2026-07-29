import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { buildExecutiveAlerts } from './executiveAlertService.js'
import {
  buildDeterministicExecutiveBrief,
  getExecutiveBrief,
} from './executiveBriefService.js'
import {
  EXECUTIVE_PERMISSION_ID,
  EXECUTIVE_THRESHOLDS,
  getDaysWithoutPIAtPeriodEnd,
  validateExecutivePeriod,
} from './executiveCockpitUtils.js'
import {
  getExecutiveCockpit,
  getExecutiveLargePIs,
  getExecutiveTrend,
  verifyExecutiveCockpitAccess,
} from './executiveCockpitService.js'
import {
  EXECUTIVE_INTENTS,
  classifyExecutiveQuestion,
  processExecutiveQuestion,
} from './executiveIntentService.js'

const createMockQueryable = (handler) => {
  const queries = []

  return {
    queries,
    async query(sql, params = []) {
      queries.push({ params, sql })
      return handler(sql, params)
    },
  }
}

const summaryRow = ({ count = 4, value = '10000' } = {}) => ({
  average_value: count > 0 ? String(Number(value) / count) : '0',
  count,
  final_count: count > 0 ? 1 : 0,
  final_value: count > 0 ? '2500' : '0',
  highest_value: count > 0 ? '5000' : '0',
  lowest_value: count > 0 ? '1000' : '0',
  open_count: count > 0 ? count - 1 : 0,
  open_value: count > 0 ? String(Number(value) - 2500) : '0',
  total_value: value,
})

const statusRows = [
  { count: 3, status: 'Draft', total_value: '7500' },
  { count: 1, status: 'Final', total_value: '2500' },
]

const trendRows = [
  { count: 1, date: '2026-07-27', value: '3000' },
  { count: 2, date: '2026-07-28', value: '4000' },
  { count: 1, date: '2026-07-29', value: '3000' },
]

const customerRows = [
  {
    average_value: '5000',
    count_rank: 1,
    current_count: 2,
    current_value: '10000',
    customer_code: 101,
    customer_name: 'Jalaram Enterprise',
    days_since_last_pi: 0,
    final_count: 1,
    final_value: '2500',
    first_pi_date: '2026-07-27',
    highest_value: '7000',
    historical_count: 1,
    historical_value: '5000',
    last_pi_date: '2026-07-29',
    lowest_value: '3000',
    open_count: 1,
    open_value: '7500',
    previous_count: 1,
    previous_value: '5000',
    total_current_value: '10000',
    value_rank: 1,
  },
]

const productRows = [
  {
    average_quantity: '100',
    average_rate: '50',
    current_value: '10000',
    distinct_customer_count: 1,
    distinct_pi_count: 2,
    latest_pi_date: '2026-07-29',
    line_count: 2,
    previous_quantity: '50',
    previous_value: '2000',
    product_code: 'SB102',
    product_description: 'SB 102 H4 P43T P LHT E',
    quantity_rank: 1,
    total_current_value: '10000',
    total_quantity: '200',
    value_rank: 1,
  },
]

const companyRow = {
  average_value: '10000',
  company_code: 2,
  company_name: 'Autolite Manufacturing Limited',
  current_count: 1,
  current_value: '10000',
  final_count: 1,
  final_value: '2500',
  last_pi_date: '2026-07-29',
  open_count: 3,
  open_value: '7500',
  pi_count: 4,
  previous_count: 1,
  previous_value: '5000',
  total_current_value: '10000',
  total_value: '10000',
}

const createExecutiveQueryable = ({ admin = true, canAccess = true } = {}) =>
  createMockQueryable((sql, params) => {
    assert.ok(Array.isArray(params))

    if (sql.includes('SELECT user_name, is_admin, is_active')) {
      return {
        rows: [
          {
            is_active: true,
            is_admin: admin,
            user_name: 'Dileep',
          },
        ],
      }
    }

    if (sql.includes('FROM master_user_rights')) {
      return { rows: [{ can_access: canAccess }] }
    }

    if (sql.includes('WITH period_rows')) {
      return {
        rows: [
          {
            average_value: '2500',
            company_name: 'Autolite Manufacturing Limited',
            customer_name: 'Jalaram Enterprise',
            grand_total: '6000',
            pi_date: '2026-07-29',
            pi_number: 'HAL-0101',
            status: 'Draft',
          },
        ],
      }
    }

    if (sql.includes('days_since_last_pi')) {
      return { rows: customerRows }
    }

    if (sql.includes('distinct_customer_count')) {
      return { rows: productRows }
    }

    if (sql.includes('days_inactive')) {
      return {
        rows: [
          {
            customer_code: 103,
            customer_name: 'Inactive Customer',
            days_inactive: 120,
            historical_pi_count: 5,
            historical_pi_value: '9000',
            last_pi_date: '2026-03-01',
          },
        ],
      }
    }

    if (sql.includes('inactive_gap_days')) {
      return {
        rows: [
          {
            customer_code: 104,
            customer_name: 'Reactivated Customer',
            grand_total: '1200',
            historical_pi_count: 2,
            historical_pi_value: '2500',
            inactive_gap_days: 110,
            latest_pi_date: '2026-07-20',
            pi_number: 'HAL-0104',
            previous_pi_date: '2026-03-31',
          },
        ],
      }
    }

    if (sql.includes('GROUP BY m.pi_date::date')) {
      return { rows: trendRows }
    }

    if (sql.includes("m.pi_series || LPAD") && sql.includes('ORDER BY m.pi_date DESC')) {
      return {
        rows: [
          {
            company_name: 'Autolite Manufacturing Limited',
            customer_name: 'Jalaram Enterprise',
            grand_total: '6000',
            pi_date: '2026-07-29',
            pi_number: 'HAL-0101',
            status: 'Draft',
          },
        ],
      }
    }

    if (sql.includes("GROUP BY CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END")) {
      return { rows: statusRows }
    }

    if (sql.includes('AS customer_name') && sql.includes('pi_count')) {
      return {
        rows: [
          {
            average_value: '5000',
            customer_name: 'Jalaram Enterprise',
            final_count: 1,
            final_value: '2500',
            last_pi_date: '2026-07-29',
            open_count: 3,
            open_value: '7500',
            pi_count: 4,
            total_value: '10000',
          },
        ],
      }
    }

    if (sql.includes('AS company_name') && sql.includes('pi_count')) {
      return { rows: [companyRow] }
    }

    if (sql.includes('company_name') && sql.includes('m.comp_code')) {
      return { rows: [companyRow] }
    }

    if (sql.includes('COUNT(*)::int AS count')) {
      const isPrevious = String(params[0]).startsWith('2026-06')
      const isYesterday = params[0] === '2026-07-28'
      const isToday = params[0] === '2026-07-29'

      if (isToday) {
        return { rows: [summaryRow({ count: 1, value: '3000' })] }
      }

      if (isYesterday) {
        return { rows: [summaryRow({ count: 2, value: '4000' })] }
      }

      return { rows: [isPrevious ? summaryRow({ count: 2, value: '5000' }) : summaryRow()] }
    }

    throw new Error(`Unexpected executive query: ${sql}`)
  })

test('executive cockpit returns KPI response shape from verified PI and commercial data', async () => {
  const result = await getExecutiveCockpit({
    period: 'this-month',
    queryable: createExecutiveQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.module, 'Executive AI Cockpit')
  assert.equal(result.kpis.todayPICount, 1)
  assert.equal(result.kpis.thisMonthPIValue, 10000)
  assert.equal(result.kpis.previousMonthPIValue, 5000)
  assert.equal(result.kpis.topCustomer, 'Jalaram Enterprise')
  assert.equal(result.kpis.topProductPILineValue, 10000)
  assert.equal(result.kpis.topCompany, 'Autolite Manufacturing Limited')
  assert.equal(result.status.open.percentage, 75)
  assert.ok(result.trend.length > 0)
})

test('executive trend allows 730 day maximum and rejects larger ranges', async () => {
  const queryable = createExecutiveQueryable()
  const trend = await getExecutiveTrend({
    endDate: '2026-07-29',
    queryable,
    startDate: '2024-07-30',
  })

  assert.equal(trend.success, true)

  const oversized = await getExecutiveTrend({
    endDate: '2026-07-29',
    queryable,
    startDate: '2024-07-29',
  })

  assert.equal(oversized.statusCode, 400)
})

test('large PI query returns safe fields only', async () => {
  const rows = await getExecutiveLargePIs({
    endDate: '2026-07-29',
    queryable: createExecutiveQueryable(),
    startDate: '2026-07-01',
  })

  assert.equal(rows[0].piNumber, 'HAL-0101')
  assert.equal(rows[0].grandTotal, 6000)
  assert.equal(Object.hasOwn(rows[0], 'gstin'), false)
})

test('executive alerts include concentration open final inactivity reactivation and large PI', async () => {
  const cockpit = await getExecutiveCockpit({
    period: 'this-month',
    queryable: createExecutiveQueryable(),
    today: '2026-07-29',
  })
  const alertTypes = cockpit.alerts.map((alert) => alert.type)

  assert.ok(alertTypes.includes('customer_concentration'))
  assert.ok(alertTypes.includes('inactive_customer_activity'))
  assert.ok(alertTypes.includes('reactivated_customer_activity'))
  assert.ok(alertTypes.includes('large_pi_value'))
  assert.ok(cockpit.alerts.every((alert) => ['high', 'attention', 'info'].includes(alert.severity)))
})

test('alert builder reports none when no thresholds are met', () => {
  const alerts = buildExecutiveAlerts({
    activityHighlights: {
      inactiveCount: 0,
      reactivatedCount: 0,
    },
    alerts: [],
    concentration: {
      customer: {
        topCustomerShare: 5,
      },
      product: {
        topProductShare: 5,
      },
    },
    customerHighlights: {},
    growthHighlights: {
      newCustomerCount: 0,
    },
    kpis: {
      averagePIValue: 1000,
      currentPeriodPICount: 1,
      monthlyCountChangePercentage: 0,
      monthlyValueChangePercentage: 0,
      todayPICount: 1,
    },
    largePIs: [],
    period: {
      endDate: '2026-07-29',
    },
    productHighlights: {},
    status: {
      final: { count: 1, percentage: 100, value: 1000 },
      open: { count: 0, percentage: 0, value: 0 },
    },
    trend: [{ count: 1, date: '2026-07-29', value: 1000 }],
  })

  assert.deepEqual(alerts, [])
})

test('days without PI at period end is deterministic', () => {
  assert.equal(
    getDaysWithoutPIAtPeriodEnd(
      [{ count: 1, date: '2026-07-27', value: 1000 }],
      '2026-07-29',
    ),
    2,
  )
})

test('executive brief falls back without Ollama and preserves PI wording', async () => {
  const result = await getExecutiveBrief({
    modelWording: async () => {
      throw new Error('Ollama unavailable')
    },
    period: 'this-month',
    queryable: createExecutiveQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.brief, /PI value/)
  assert.doesNotMatch(result.brief.toLowerCase(), /actual sales|actual revenue/)
})

test('deterministic executive brief includes disclaimer', () => {
  const brief = buildDeterministicExecutiveBrief({
    alerts: [],
    comparison: {
      currentMonthCount: 4,
      currentMonthValue: 10000,
      previousMonthCount: 2,
      previousMonthValue: 5000,
      valueChangePercentage: 100,
    },
    concentration: {
      label: 'High',
      topCustomerSharePercentage: 100,
    },
    customerActivity: {
      decliningCustomers: 0,
      growingCustomers: 1,
      inactiveCustomers: 1,
      newCustomers: 0,
      reactivatedCustomers: 1,
    },
    status: {
      finalValue: 2500,
      openValue: 7500,
    },
    today: {
      count: 1,
      value: 3000,
    },
    topCompany: {
      name: 'Autolite Manufacturing Limited',
      value: 10000,
    },
    topCustomer: {
      name: 'Jalaram Enterprise',
      sharePercentage: 100,
      value: 10000,
    },
    topProduct: {
      name: 'SB102',
      value: 10000,
    },
  })

  assert.match(brief, /Proforma Invoice activity/)
  assert.match(brief, /does not represent completed sales/)
})

test('executive classifier covers allowed intents and preserves general drafting', () => {
  assert.equal(
    classifyExecutiveQuestion('Give me today executive summary').intent,
    EXECUTIVE_INTENTS.EXECUTIVE_TODAY_SUMMARY,
  )
  assert.equal(
    classifyExecutiveQuestion('Compare this month with last month').intent,
    EXECUTIVE_INTENTS.EXECUTIVE_MONTH_COMPARISON,
  )
  assert.equal(
    classifyExecutiveQuestion('Which product contributes most PI line value?').intent,
    EXECUTIVE_INTENTS.EXECUTIVE_TOP_PRODUCT,
  )
  assert.equal(
    classifyExecutiveQuestion('Draft a PI confirmation email').intent,
    EXECUTIVE_INTENTS.GENERAL_AI_QUESTION,
  )
})

test('executive unsupported stock and outstanding question is rejected', async () => {
  const result = await processExecutiveQuestion({
    queryable: createExecutiveQueryable(),
    question: 'Executive stock of HL102',
    today: '2026-07-29',
  })

  assert.equal(result.success, false)
  assert.equal(result.intent, EXECUTIVE_INTENTS.EXECUTIVE_UNSUPPORTED)
  assert.match(result.message, /not connected/)
})

test('executive question returns top customer answer from verified data', async () => {
  const result = await processExecutiveQuestion({
    queryable: createExecutiveQueryable(),
    question: 'Which customer contributes the most PI value?',
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.intent, EXECUTIVE_INTENTS.EXECUTIVE_TOP_CUSTOMER)
  assert.match(result.answer, /Jalaram Enterprise/)
})

test('executive access allows admin and assigned permission only', async () => {
  const admin = await verifyExecutiveCockpitAccess({
    queryable: createExecutiveQueryable({ admin: true }),
    userName: 'Dileep',
  })
  const assigned = await verifyExecutiveCockpitAccess({
    queryable: createExecutiveQueryable({ admin: false, canAccess: true }),
    userName: 'user',
  })
  const denied = await verifyExecutiveCockpitAccess({
    queryable: createExecutiveQueryable({ admin: false, canAccess: false }),
    userName: 'user',
  })

  assert.equal(admin.authorized, true)
  assert.equal(assigned.authorized, true)
  assert.equal(denied.authorized, false)
})

test('executive date validation enforces maximum period', () => {
  assert.equal(
    validateExecutivePeriod({ endDate: '2026-07-29', startDate: '2024-07-30' }).ok,
    true,
  )
  assert.equal(
    validateExecutivePeriod({ endDate: '2026-07-29', startDate: '2024-07-29' }).ok,
    false,
  )
})

test('executive source files contain no mutation SQL statements', () => {
  const files = [
    './executiveAlertService.js',
    './executiveBriefService.js',
    './executiveCockpitService.js',
    './executiveCockpitUtils.js',
    './executiveIntentService.js',
  ]
  const mutationRegex = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/

  files.forEach((file) => {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.equal(mutationRegex.test(source), false, file)
  })
})

test('executive permission id is isolated from lower-level intelligence permissions', () => {
  assert.equal(EXECUTIVE_PERMISSION_ID, 'ai-executive-cockpit')
  assert.notEqual(EXECUTIVE_PERMISSION_ID, 'ai-commercial-intelligence')
  assert.equal(EXECUTIVE_THRESHOLDS.largePIMultiple, 2)
})

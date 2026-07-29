import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import {
  COMMERCIAL_DISCLAIMER,
  COMMERCIAL_LIMITS,
  COMMERCIAL_PERMISSION_ID,
  COMMERCIAL_THRESHOLDS,
  classifyCommercialActivity,
  clampCommercialLimit,
  getChange,
  getConcentrationLabel,
  getSharePercentage,
  resolveCommercialPeriod,
} from './commercialIntelligenceUtils.js'
import {
  COMMERCIAL_INTENTS,
  buildDeterministicCommercialBrief,
  classifyCommercialQuestion,
  getCommercialComparison,
  getCommercialConcentration,
  getCommercialDashboard,
  getCommercialManagementBrief,
  getCompanyCommercialIntelligence,
  getCustomerCommercialIntelligence,
  getInactiveCustomers,
  getProductCommercialIntelligence,
  getReactivatedCustomers,
  processCommercialQuestion,
  verifyCommercialIntelligenceAccess,
} from './commercialIntelligenceService.js'

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

const summaryRow = ({
  average = '1500',
  count = 2,
  finalCount = 1,
  finalValue = '1000',
  high = '2000',
  low = '1000',
  openCount = 1,
  openValue = '2000',
  value = '3000',
} = {}) => ({
  average_value: average,
  count,
  final_count: finalCount,
  final_value: finalValue,
  highest_value: high,
  lowest_value: low,
  open_count: openCount,
  open_value: openValue,
  total_value: value,
})

const customerRows = [
  {
    average_value: '1000',
    count_rank: 1,
    current_count: 3,
    current_value: '3300',
    customer_code: 101,
    customer_name: 'Jalaram Enterprise',
    days_since_last_pi: 4,
    final_count: 1,
    final_value: '1000',
    first_pi_date: '2026-07-01',
    highest_value: '2000',
    historical_count: 4,
    historical_value: '4200',
    last_pi_date: '2026-07-25',
    lowest_value: '300',
    open_count: 2,
    open_value: '2300',
    previous_count: 1,
    previous_value: '1000',
    total_current_value: '5000',
    value_rank: 1,
  },
  {
    average_value: '850',
    count_rank: 2,
    current_count: 2,
    current_value: '1700',
    customer_code: 102,
    customer_name: 'Decline Motors',
    days_since_last_pi: 10,
    final_count: 0,
    final_value: '0',
    first_pi_date: '2026-07-03',
    highest_value: '900',
    historical_count: 3,
    historical_value: '7000',
    last_pi_date: '2026-07-18',
    lowest_value: '800',
    open_count: 2,
    open_value: '1700',
    previous_count: 3,
    previous_value: '7000',
    total_current_value: '5000',
    value_rank: 2,
  },
]

const productRows = [
  {
    average_quantity: '500',
    average_rate: '44',
    current_value: '2200',
    distinct_customer_count: 2,
    distinct_pi_count: 2,
    latest_pi_date: '2026-07-25',
    line_count: 2,
    previous_quantity: '100',
    previous_value: '500',
    product_code: 'SB102',
    product_description: 'SB 102 H4 P43T P LHT E',
    quantity_rank: 1,
    total_current_value: '3000',
    total_quantity: '1000',
    value_rank: 1,
  },
  {
    average_quantity: '200',
    average_rate: '40',
    current_value: '800',
    distinct_customer_count: 1,
    distinct_pi_count: 1,
    latest_pi_date: '2026-07-20',
    line_count: 1,
    previous_quantity: '1000',
    previous_value: '4000',
    product_code: 'SB103',
    product_description: 'SB 103 Lamp',
    quantity_rank: 2,
    total_current_value: '3000',
    total_quantity: '200',
    value_rank: 2,
  },
]

const companyRows = [
  {
    average_value: '5000',
    company_code: 2,
    company_name: 'Autolite Manufacturing Limited',
    current_count: 3,
    current_value: '15000',
    final_count: 1,
    final_value: '5000',
    last_pi_date: '2026-07-25',
    open_count: 2,
    open_value: '10000',
    previous_count: 2,
    previous_value: '10000',
    total_current_value: '15000',
  },
]

const createCommercialQueryable = () =>
  createMockQueryable((sql, params) => {
    assert.ok(Array.isArray(params))

    if (sql.includes('SELECT user_name, is_admin, is_active')) {
      return {
        rows: [
          {
            is_active: true,
            is_admin: false,
            user_name: 'commercial-user',
          },
        ],
      }
    }

    if (sql.includes('FROM master_user_rights')) {
      return { rows: [{ can_access: true }] }
    }

    if (sql.includes('COUNT(*)::int AS count')) {
      return {
        rows: [
          params[0] === '2026-07-01'
            ? summaryRow({ count: 4, value: '10000' })
            : summaryRow({ count: 2, value: '5000' }),
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

    if (sql.includes('company_name') && sql.includes('m.comp_code')) {
      return { rows: companyRows }
    }

    throw new Error(`Unexpected commercial query: ${sql}`)
  })

test('resolves month versus previous month in India business date context', () => {
  const period = resolveCommercialPeriod({
    period: 'this-month',
    today: '2026-07-29',
  })

  assert.equal(period.ok, true)
  assert.equal(period.period.startDate, '2026-07-01')
  assert.equal(period.period.endDate, '2026-07-29')
  assert.equal(period.comparisonPeriod.startDate, '2026-06-01')
  assert.equal(period.comparisonPeriod.endDate, '2026-06-29')
})

test('resolves week versus previous week', () => {
  const period = resolveCommercialPeriod({
    period: 'this-week',
    today: '2026-07-29',
  })

  assert.equal(period.period.startDate, '2026-07-27')
  assert.equal(period.comparisonPeriod.startDate, '2026-07-20')
})

test('resolves quarter comparison', () => {
  const period = resolveCommercialPeriod({
    period: 'current-quarter',
    today: '2026-07-29',
  })

  assert.equal(period.period.startDate, '2026-07-01')
  assert.equal(period.comparisonPeriod.startDate, '2026-04-01')
})

test('resolves financial year comparison with India financial year boundary', () => {
  const period = resolveCommercialPeriod({
    period: 'current-financial-year',
    today: '2026-07-29',
  })

  assert.equal(period.period.startDate, '2026-04-01')
  assert.equal(period.comparisonPeriod.startDate, '2025-04-01')
})

test('resolves custom equivalent period', () => {
  const period = resolveCommercialPeriod({
    endDate: '2026-07-20',
    period: 'custom',
    startDate: '2026-07-11',
    today: '2026-07-29',
  })

  assert.equal(period.period.days, 10)
  assert.equal(period.comparisonPeriod.startDate, '2026-07-01')
  assert.equal(period.comparisonPeriod.endDate, '2026-07-10')
})

test('resolves same period previous year comparison', () => {
  const period = resolveCommercialPeriod({
    comparisonMode: 'same-period-previous-year',
    endDate: '2026-07-20',
    period: 'custom',
    startDate: '2026-07-11',
    today: '2026-07-29',
  })

  assert.equal(period.comparisonPeriod.startDate, '2025-07-11')
  assert.equal(period.comparisonPeriod.endDate, '2025-07-20')
})

test('rejects oversized custom period', () => {
  const period = resolveCommercialPeriod({
    endDate: '2026-07-20',
    period: 'custom',
    startDate: '2024-01-01',
    today: '2026-07-29',
  })

  assert.equal(period.ok, false)
  assert.match(period.message, /730 days/)
})

test('handles leap year custom date without throwing', () => {
  const period = resolveCommercialPeriod({
    comparisonMode: 'same-period-previous-year',
    endDate: '2024-02-29',
    period: 'custom',
    startDate: '2024-02-29',
    today: '2026-07-29',
  })

  assert.equal(period.ok, true)
  assert.ok(period.comparisonPeriod.startDate)
})

test('change calculation avoids divide by zero', () => {
  const change = getChange(100, 0)

  assert.equal(change.changeAvailable, false)
  assert.equal(change.changePercentage, null)
})

test('commercial classifications cover growth decline stable new and insufficient history', () => {
  assert.equal(
    classifyCommercialActivity({ currentValue: 120, historicalCount: 2, previousValue: 100 }),
    'Growing',
  )
  assert.equal(
    classifyCommercialActivity({ currentValue: 80, historicalCount: 2, previousValue: 100 }),
    'Declining',
  )
  assert.equal(
    classifyCommercialActivity({ currentValue: 105, historicalCount: 2, previousValue: 100 }),
    'Stable',
  )
  assert.equal(
    classifyCommercialActivity({ currentValue: 100, historicalCount: 0, previousValue: 0 }),
    'New',
  )
  assert.equal(
    classifyCommercialActivity({ currentValue: 0, historicalCount: 0, previousValue: 0 }),
    'Insufficient history',
  )
})

test('concentration helpers classify low moderate high and zero share', () => {
  assert.equal(getSharePercentage(0, 0), 0)
  assert.equal(getConcentrationLabel(10), 'Low')
  assert.equal(getConcentrationLabel(25), 'Moderate')
  assert.equal(getConcentrationLabel(40), 'High')
  assert.equal(COMMERCIAL_THRESHOLDS.growthPercentage, 10)
})

test('commercial limits clamp oversized requests', () => {
  assert.equal(clampCommercialLimit(999, COMMERCIAL_LIMITS.customer), 100)
  assert.equal(clampCommercialLimit(0, COMMERCIAL_LIMITS.customer), 10)
})

test('classifies commercial natural-language questions deterministically', () => {
  assert.equal(
    classifyCommercialQuestion('Which customers are growing?').intent,
    COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_GROWTH,
  )
  assert.equal(
    classifyCommercialQuestion('Show top products by PI line value').intent,
    COMMERCIAL_INTENTS.COMMERCIAL_PRODUCT_RANKING_VALUE,
  )
  assert.equal(
    classifyCommercialQuestion('Give me a commercial management brief').intent,
    COMMERCIAL_INTENTS.COMMERCIAL_MANAGEMENT_BRIEF,
  )
})

test('unsupported commercial stock question is rejected by the commercial classifier', () => {
  const result = classifyCommercialQuestion('Commercial stock position for HL102')

  assert.equal(result.intent, COMMERCIAL_INTENTS.COMMERCIAL_UNSUPPORTED)
})

test('period comparison returns controlled summary values and parameterised queries', async () => {
  const queryable = createCommercialQueryable()
  const result = await getCommercialComparison({
    period: 'this-month',
    queryable,
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.comparison.current.count, 4)
  assert.equal(result.comparison.previous.value, 5000)
  assert.equal(result.comparison.valueChange.changePercentage, 100)
  assert.ok(queryable.queries.every((query) => query.params.length > 0))
})

test('customer intelligence maps growth decline ranks and safe fields', async () => {
  const result = await getCustomerCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.rows[0].customerName, 'Jalaram Enterprise')
  assert.equal(result.rows[0].classification, 'Growing')
  assert.equal(result.rows[1].classification, 'Declining')
  assert.equal(result.rows[0].shareOfTotalPIValue, 66)
  assert.equal(result.rows[0].customerCode, 101)
  assert.equal(result.rows[0].daysSinceLastPI, 4)
})

test('customer growing and declining segments filter rows', async () => {
  const growing = await getCustomerCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    segment: 'growing',
    today: '2026-07-29',
  })
  const declining = await getCustomerCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    segment: 'declining',
    today: '2026-07-29',
  })

  assert.equal(growing.rows.length, 1)
  assert.equal(growing.rows[0].classification, 'Growing')
  assert.equal(declining.rows.length, 1)
  assert.equal(declining.rows[0].classification, 'Declining')
})

test('product intelligence maps PI line value quantity and description join', async () => {
  const result = await getProductCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.dataQuality.productLinkReliable, true)
  assert.equal(result.rows[0].productCode, 'SB102')
  assert.equal(result.rows[0].productDescription, 'SB 102 H4 P43T P LHT E')
  assert.equal(result.rows[0].distinctCustomers, 2)
  assert.equal(result.rows[0].classification, 'Growing')
  assert.equal(result.rows[1].classification, 'Declining')
})

test('product ranking by quantity uses quantity order', async () => {
  const result = await getProductCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    sortBy: 'quantity',
    today: '2026-07-29',
  })

  assert.equal(result.rows[0].productCode, 'SB102')
  assert.equal(result.rows[0].totalQuantity, 1000)
})

test('company intelligence maps company comparison without sensitive fields', async () => {
  const result = await getCompanyCommercialIntelligence({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.rows[0].companyName, 'Autolite Manufacturing Limited')
  assert.equal(result.rows[0].currentPIValue, 15000)
  assert.equal(result.rows[0].shareOfTotalPIValue, 100)
  assert.equal(Object.hasOwn(result.rows[0], 'gstin'), false)
  assert.equal(Object.hasOwn(result.rows[0], 'bankDetails'), false)
})

test('inactive customer logic returns safe activity fields', async () => {
  const result = await getInactiveCustomers({
    days: 90,
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.rows[0].customerName, 'Inactive Customer')
  assert.equal(result.rows[0].daysInactive, 120)
  assert.match(result.message, /No PI activity/)
})

test('reactivated customer logic returns latest PI after inactivity gap', async () => {
  const result = await getReactivatedCustomers({
    days: 90,
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.rows[0].customerName, 'Reactivated Customer')
  assert.equal(result.rows[0].latestPINumber, 'HAL-0104')
  assert.equal(result.rows[0].inactiveGapDays, 110)
})

test('commercial concentration calculates customer company and product indicators', async () => {
  const result = await getCommercialConcentration({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.customer.label, 'High')
  assert.equal(result.customer.topCustomerShare, 66)
  assert.equal(result.company.topCompanyShare, 100)
  assert.equal(result.product.productLinkReliable, true)
})

test('commercial dashboard returns combined response shape', async () => {
  const result = await getCommercialDashboard({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
  })

  assert.equal(result.success, true)
  assert.equal(result.module, 'Commercial PI Intelligence')
  assert.ok(result.customerSummary.ranking.length > 0)
  assert.ok(result.productSummary.ranking.length > 0)
  assert.ok(result.companySummary.ranking.length > 0)
  assert.ok(result.customerSummary.inactive.length > 0)
})

test('deterministic commercial brief preserves PI wording and disclaimer', () => {
  const brief = buildDeterministicCommercialBrief({
    comparison: {
      currentCount: 2,
      currentValue: 3000,
      valueChangePercentage: 50,
    },
    concentration: {
      label: 'High',
      topCustomerShare: 66,
    },
    growth: {
      decliningCustomers: 1,
      growingCustomers: 1,
      inactiveCustomers: 1,
      newCustomers: 0,
      reactivatedCustomers: 1,
    },
    status: {
      finalValue: 1000,
      openValue: 2000,
    },
    topCustomer: {
      name: 'Jalaram Enterprise',
      value: 2000,
    },
  })

  assert.match(brief, /PI value/)
  assert.match(brief, new RegExp(COMMERCIAL_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(brief.toLowerCase(), /actual sales|actual revenue/)
})

test('management brief falls back when Ollama is unavailable', async () => {
  const result = await getCommercialManagementBrief({
    modelWording: async () => {
      throw new Error('Ollama unavailable')
    },
    period: 'this-month',
    queryable: createCommercialQueryable(),
    today: '2026-07-29',
    useModelWording: true,
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.brief, /Proforma Invoice/)
})

test('processCommercialQuestion routes customer growth and returns live-data source', async () => {
  const result = await processCommercialQuestion({
    period: 'this-month',
    queryable: createCommercialQueryable(),
    question: 'Which customers are growing?',
    today: '2026-07-29',
    useModelWording: false,
  })

  assert.equal(result.success, true)
  assert.equal(result.mode, 'commercial')
  assert.equal(result.intent, COMMERCIAL_INTENTS.COMMERCIAL_CUSTOMER_GROWTH)
  assert.equal(result.source.liveData, true)
  assert.match(result.answer, /Jalaram Enterprise/)
})

test('processCommercialQuestion rejects unsupported stock and accounting modules', async () => {
  const result = await processCommercialQuestion({
    queryable: createCommercialQueryable(),
    question: 'Commercial stock position for HL102',
    today: '2026-07-29',
  })

  assert.equal(result.success, false)
  assert.equal(result.intent, COMMERCIAL_INTENTS.COMMERCIAL_UNSUPPORTED)
  assert.match(result.message, /not connected/)
})

test('commercial access rejects missing username', async () => {
  const result = await verifyCommercialIntelligenceAccess({
    queryable: createCommercialQueryable(),
    userName: '',
  })

  assert.equal(result.authorized, false)
})

test('commercial access allows assigned permission', async () => {
  const result = await verifyCommercialIntelligenceAccess({
    queryable: createCommercialQueryable(),
    userName: 'commercial-user',
  })

  assert.equal(result.authorized, true)
  assert.equal(result.userName, 'commercial-user')
})

test('commercial access allows admin without rights lookup', async () => {
  const queryable = createMockQueryable((sql) => {
    if (sql.includes('SELECT user_name, is_admin, is_active')) {
      return {
        rows: [
          {
            is_active: true,
            is_admin: true,
            user_name: 'Dileep',
          },
        ],
      }
    }

    throw new Error('Admin should not require rights lookup')
  })
  const result = await verifyCommercialIntelligenceAccess({
    queryable,
    userName: 'Dileep',
  })

  assert.equal(result.authorized, true)
  assert.equal(result.isAdmin, true)
})

test('service source does not contain mutation SQL statements for Phase 5', () => {
  const source = fs.readFileSync(new URL('./commercialIntelligenceService.js', import.meta.url), 'utf8')
  const mutationRegex = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/

  assert.equal(mutationRegex.test(source), false)
})

test('commercial permission id is isolated from normal PI intelligence permission', () => {
  assert.equal(COMMERCIAL_PERMISSION_ID, 'ai-commercial-intelligence')
  assert.notEqual(COMMERCIAL_PERMISSION_ID, 'ai-erp-intelligence')
})

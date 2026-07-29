import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PI_PRO_INTENTS,
  classifyPIAnalyticsQuestion,
  getBestDay,
  getCompanyRanking,
  getCustomerRanking,
  getPIAnalyticsForIntent,
  getPIIntelligenceProDashboard,
  getPISummaryMetrics,
  getPIStatusMetrics,
  getPITrend,
} from './piAnalyticsService.js'
import {
  resolvePeriodRange,
  runReadOnlyQuery,
  validateDateRange,
} from './piIntelligenceUtils.js'

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

const createAnalyticsQueryable = () =>
  createMockQueryable((sql, params) => {
    if (sql.includes("m.pi_series || LPAD")) {
      return {
        rows: [
          {
            company_name: 'Autolite Manufacturing Limited',
            customer_name: 'Jalaram Enterprise',
            grand_total: '1000',
            pi_date: '2026-07-28',
            pi_number: 'AML-0012',
            status: 'Draft',
          },
        ],
      }
    }

    if (sql.includes('AS customer_name')) {
      return {
        rows: [
          {
            average_value: '500',
            customer_name: 'Jalaram Enterprise',
            final_count: 1,
            final_value: '500',
            last_pi_date: '2026-07-28',
            open_count: 2,
            open_value: '1000',
            pi_count: 3,
            total_value: '1500',
          },
        ],
      }
    }

    if (sql.includes('AS company_name')) {
      return {
        rows: [
          {
            average_value: '1000',
            company_name: 'Autolite Manufacturing Limited',
            final_count: 1,
            last_pi_date: '2026-07-28',
            open_count: 3,
            pi_count: 4,
            total_value: '4000',
          },
        ],
      }
    }

    if (sql.includes('AVG(m.grand_total)')) {
      return {
        rows: [
          {
            average_value: '250',
            count: '4',
            highest_value: '500',
            lowest_value: '100',
            total_value: '1000',
          },
        ],
      }
    }

    if (sql.includes('GROUP BY CASE WHEN m.close_yn')) {
      return {
        rows: [
          { count: 3, status: 'Draft', total_value: '750' },
          { count: 1, status: 'Final', total_value: '250' },
        ],
      }
    }

    if (sql.includes('GROUP BY m.pi_date::date')) {
      return {
        rows: [
          { count: 1, date: '2026-07-27', value: '200' },
          { count: 3, date: '2026-07-28', value: '800' },
        ],
      }
    }

    throw new Error(`Unexpected query: ${sql}`)
  })

test('classifier detects top customers by value', () => {
  const result = classifyPIAnalyticsQuestion(
    'Show top 10 customers by PI value.',
    { today: '2026-07-28' },
  )

  assert.equal(result.intent, PI_PRO_INTENTS.PI_TOP_CUSTOMERS_VALUE)
  assert.equal(result.parameters.limit, 10)
})

test('classifier detects top customers by count', () => {
  const result = classifyPIAnalyticsQuestion(
    'Show the top 10 customers by PI count.',
    { today: '2026-07-28' },
  )

  assert.equal(result.intent, PI_PRO_INTENTS.PI_TOP_CUSTOMERS_COUNT)
})

test('classifier detects highest company value', () => {
  const result = classifyPIAnalyticsQuestion(
    'Which company has the highest PI value this month?',
    { today: '2026-07-28' },
  )

  assert.equal(result.intent, PI_PRO_INTENTS.PI_TOP_COMPANY_VALUE)
})

test('classifier detects company-wise PI summary', () => {
  const result = classifyPIAnalyticsQuestion('Show company-wise PI summary.', {
    today: '2026-07-28',
  })

  assert.equal(result.intent, PI_PRO_INTENTS.PI_COMPANY_RANKING)
})

test('classifier detects average PI value today', () => {
  const result = classifyPIAnalyticsQuestion('What is the average PI value today?', {
    today: '2026-07-28',
  })

  assert.equal(result.intent, PI_PRO_INTENTS.PI_AVERAGE_VALUE_TODAY)
})

test('classifier detects average PI value this month', () => {
  const result = classifyPIAnalyticsQuestion(
    'What is the average PI value this month?',
    { today: '2026-07-28' },
  )

  assert.equal(result.intent, PI_PRO_INTENTS.PI_AVERAGE_VALUE_MONTH)
})

test('classifier detects highest and lowest PI values', () => {
  assert.equal(
    classifyPIAnalyticsQuestion('What is the highest PI value this month?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_HIGHEST_VALUE_MONTH,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('What is the lowest PI value this month?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_LOWEST_VALUE_MONTH,
  )
})

test('classifier detects best day by value and count', () => {
  assert.equal(
    classifyPIAnalyticsQuestion('Which day had the highest PI value this month?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_BEST_DAY_VALUE,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('Which day had the highest PI count this month?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_BEST_DAY_COUNT,
  )
})

test('classifier detects PI trend periods', () => {
  assert.equal(
    classifyPIAnalyticsQuestion('Show PI trend for the last 7 days.', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_TREND_7_DAYS,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('Show PI trend for the last 30 days.', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_TREND_30_DAYS,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('Show PI trend for this month.', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_TREND_MONTH,
  )
})

test('classifier detects open and final percentages', () => {
  assert.equal(
    classifyPIAnalyticsQuestion('What percentage of PIs are open?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_OPEN_PERCENTAGE,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('What percentage of PIs are final?', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_FINAL_PERCENTAGE,
  )
})

test('classifier detects average daily count and value', () => {
  assert.equal(
    classifyPIAnalyticsQuestion('Show average daily PI count this month.', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_AVERAGE_DAILY_COUNT,
  )
  assert.equal(
    classifyPIAnalyticsQuestion('Show average daily PI value this month.', {
      today: '2026-07-28',
    }).intent,
    PI_PRO_INTENTS.PI_AVERAGE_DAILY_VALUE,
  )
})

test('date ranges support today yesterday week month last 7 and last 30', () => {
  assert.deepEqual(resolvePeriodRange({ period: 'today', today: '2026-07-29' }), {
    endDate: '2026-07-29',
    message: '',
    ok: true,
    period: 'today',
    startDate: '2026-07-29',
  })
  assert.equal(resolvePeriodRange({ period: 'yesterday', today: '2026-07-29' }).startDate, '2026-07-28')
  assert.equal(resolvePeriodRange({ period: 'week', today: '2026-07-29' }).startDate, '2026-07-27')
  assert.equal(resolvePeriodRange({ period: 'month', today: '2026-07-29' }).startDate, '2026-07-01')
  assert.equal(resolvePeriodRange({ period: 'last-7-days', today: '2026-07-29' }).startDate, '2026-07-23')
  assert.equal(resolvePeriodRange({ period: 'last-30-days', today: '2026-07-29' }).startDate, '2026-06-30')
})

test('custom date range validates invalid, reversed and above maximum ranges', () => {
  assert.equal(validateDateRange({ endDate: '2026-07-29', startDate: 'bad' }).ok, false)
  assert.equal(validateDateRange({ endDate: '2026-07-01', startDate: '2026-07-29' }).ok, false)
  assert.equal(validateDateRange({ endDate: '2027-08-01', startDate: '2026-07-01' }).ok, false)
})

test('summary metrics return average highest and lowest values', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getPISummaryMetrics({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.averageValue, 250)
  assert.equal(result.highestValue, 500)
  assert.equal(result.lowestValue, 100)
})

test('summary metrics convert null and empty totals to zero', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [
      {
        average_value: null,
        count: null,
        highest_value: null,
        lowest_value: null,
        total_value: null,
      },
    ],
  }))
  const result = await getPISummaryMetrics({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.count, 0)
  assert.equal(result.value, 0)
  assert.equal(result.averageValue, 0)
})

test('status metrics calculate open and final percentages', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getPIStatusMetrics({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.open.percentage, 75)
  assert.equal(result.final.percentage, 25)
})

test('status metrics handle division by zero', async () => {
  const queryable = createMockQueryable(() => ({ rows: [] }))
  const result = await getPIStatusMetrics({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.open.percentage, 0)
  assert.equal(result.final.percentage, 0)
})

test('customer ranking returns requested safe fields and caps limit', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getCustomerRanking({
    endDate: '2026-07-28',
    limit: 99,
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.limit, 20)
  assert.equal(result.rows[0].name, 'Jalaram Enterprise')
  assert.equal(result.rows[0].totalPIValue, 1500)
  assert.ok(result.groupNote.includes('prospective'))
})

test('company ranking returns requested safe fields and caps limit', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getCompanyRanking({
    endDate: '2026-07-28',
    limit: 99,
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.limit, 20)
  assert.equal(result.rows[0].name, 'Autolite Manufacturing Limited')
  assert.equal(result.rows[0].piCount, 4)
})

test('trend returns daily PI count and value rows', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getPITrend({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })

  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].count, 3)
  assert.equal(result.rows[1].value, 800)
})

test('best day by value and count are selected from trend rows', async () => {
  const queryable = createAnalyticsQueryable()

  assert.equal(
    (await getBestDay({
      endDate: '2026-07-28',
      metric: 'value',
      queryable,
      startDate: '2026-07-01',
    })).date,
    '2026-07-28',
  )
  assert.equal(
    (await getBestDay({
      endDate: '2026-07-28',
      metric: 'count',
      queryable,
      startDate: '2026-07-01',
    })).count,
    3,
  )
})

test('pro dashboard response shape includes KPIs rankings trend and latest PIs', async () => {
  const queryable = createAnalyticsQueryable()
  const result = await getPIIntelligenceProDashboard({
    queryable,
    today: '2026-07-28',
  })

  assert.equal(result.success, true)
  assert.equal(result.module, 'PI Intelligence Pro')
  assert.equal(result.kpis.month.value, 1000)
  assert.equal(result.kpis.averagePIValueMonth, 250)
  assert.equal(result.topCustomer.name, 'Jalaram Enterprise')
  assert.equal(result.topCompany.name, 'Autolite Manufacturing Limited')
  assert.equal(result.trend.length, 2)
  assert.equal(result.latestPIs[0].piNumber, 'AML-0012')
})

test('intent runner returns average daily count and value', async () => {
  const queryable = createAnalyticsQueryable()
  const countResult = await getPIAnalyticsForIntent({
    classification: {
      intent: PI_PRO_INTENTS.PI_AVERAGE_DAILY_COUNT,
      parameters: {
        endDate: '2026-07-04',
        startDate: '2026-07-01',
      },
    },
    queryable,
  })
  const valueResult = await getPIAnalyticsForIntent({
    classification: {
      intent: PI_PRO_INTENTS.PI_AVERAGE_DAILY_VALUE,
      parameters: {
        endDate: '2026-07-04',
        startDate: '2026-07-01',
      },
    },
    queryable,
  })

  assert.equal(countResult.averageDailyCount, 1)
  assert.equal(valueResult.averageDailyValue, 250)
})

test('non Phase 4.2 intent returns null from analytics runner', async () => {
  const result = await getPIAnalyticsForIntent({
    classification: {
      intent: 'pi_customer_summary',
      parameters: {},
    },
    queryable: createAnalyticsQueryable(),
  })

  assert.equal(result, null)
})

test('read-only guard blocks mutation SQL in pro utilities', async () => {
  const queryable = createMockQueryable(() => ({ rows: [] }))

  await assert.rejects(
    () => runReadOnlyQuery(queryable, 'UPDATE master_pi_rmkt SET grand_total = 0'),
    /read-only|blocked/,
  )
})

test('new analytics functions use no mutation SQL', async () => {
  const queryable = createAnalyticsQueryable()

  await getPIIntelligenceProDashboard({
    queryable,
    today: '2026-07-28',
  })

  queryable.queries.forEach((query) => {
    assert.doesNotMatch(
      query.sql,
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    )
  })
})

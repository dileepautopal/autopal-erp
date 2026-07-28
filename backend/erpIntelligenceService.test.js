import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyERPQuestion,
  ERP_INTELLIGENCE_SCREEN_ID,
  ERP_INTENTS,
  getPIIntelligenceDashboard,
  getLatestPIs,
  getPICountForDateRange,
  getPIValueForDateRange,
  processERPQuestion,
  runReadOnlyQuery,
  validateDateRange,
  verifyERPIntelligenceAccess,
} from './erpIntelligenceService.js'

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

const noModel = async () => {
  throw new Error('Ollama disabled in unit test')
}

const createDashboardMockQueryable = ({
  dailyRows = [],
  latestRows = [],
  monthCount = 0,
  monthValue = 0,
  statusRows = [],
  todayCount = 0,
  todayValue = 0,
} = {}) =>
  createMockQueryable((sql, params) => {
    if (sql.includes('GROUP BY m.pi_date::date')) {
      return { rows: dailyRows }
    }

    if (sql.includes("m.pi_series || LPAD")) {
      return { rows: latestRows }
    }

    if (sql.includes("CASE WHEN m.close_yn = 'Y' THEN 'Final' ELSE 'Draft' END")) {
      return { rows: statusRows }
    }

    if (sql.includes('COUNT(*)::int AS count')) {
      return {
        rows: [
          {
            count: params[0] === '2026-07-28' ? todayCount : monthCount,
          },
        ],
      }
    }

    if (sql.includes('COALESCE(SUM(m.grand_total), 0)::numeric AS total_value')) {
      return {
        rows: [
          {
            total_value: params[0] === '2026-07-28' ? todayValue : monthValue,
          },
        ],
      }
    }

    throw new Error(`Unexpected dashboard query: ${sql}`)
  })

test('PI count today query returns the verified count', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [{ count: 7 }],
  }))

  const result = await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: 'How many PIs were generated today?',
    today: '2026-07-28',
    useModelWording: false,
  })

  assert.equal(result.success, true)
  assert.equal(result.intent, ERP_INTENTS.PI_COUNT_TODAY)
  assert.equal(result.data.count, 7)
  assert.equal(result.data.startDate, '2026-07-28')
  assert.match(result.answer, /7/)
})

test('PI value date-range query returns numeric totals', async () => {
  const queryable = createMockQueryable((sql) => {
    if (sql.includes('COUNT(*)::int AS count')) {
      return { rows: [{ count: 4 }] }
    }

    return { rows: [{ total_value: '12345.67' }] }
  })

  const result = await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: 'Show PI summary from 1 July 2026 to 27 July 2026',
    useModelWording: false,
  })

  assert.equal(result.success, true)
  assert.equal(result.intent, ERP_INTENTS.PI_DATE_RANGE_SUMMARY)
  assert.equal(result.data.count, 4)
  assert.equal(result.data.totalValue, 12345.67)
  assert.equal(result.data.startDate, '2026-07-01')
  assert.equal(result.data.endDate, '2026-07-27')
})

test('null totals become zero', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [{ total_value: null }],
  }))

  const result = await getPIValueForDateRange({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-28',
  })

  assert.equal(result.totalValue, 0)
})

test('latest PI result limit is capped', async () => {
  const queryable = createMockQueryable((_sql, params) => {
    assert.equal(params[0], 20)

    return { rows: [] }
  })

  const result = await getLatestPIs({
    limit: 99,
    queryable,
  })

  assert.equal(result.limit, 20)
})

test('invalid date is rejected', () => {
  const result = validateDateRange({
    endDate: '2026-07-28',
    startDate: '2026-15-99',
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /valid dates/)
})

test('start date after end date is rejected', () => {
  const result = validateDateRange({
    endDate: '2026-07-01',
    startDate: '2026-07-28',
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /Start date/)
})

test('date range above maximum is rejected', () => {
  const result = validateDateRange({
    endDate: '2027-08-01',
    startDate: '2026-07-01',
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /cannot exceed/)
})

test('unsupported ERP question is safely rejected', async () => {
  const queryable = createMockQueryable(() => {
    throw new Error('Database should not be queried')
  })

  const result = await processERPQuestion({
    queryable,
    question: 'Tell me the stock of HL102',
  })

  assert.equal(result.success, false)
  assert.equal(result.intent, ERP_INTENTS.UNSUPPORTED_ERP_QUESTION)
  assert.match(result.message, /Inventory intelligence is not connected/)
  assert.equal(queryable.queries.length, 0)
})

test('general AI question is not treated as ERP', () => {
  const result = classifyERPQuestion('Draft a PI confirmation email.')

  assert.equal(result.intent, ERP_INTENTS.GENERAL_AI_QUESTION)
})

test('customer not found returns 404 result', async () => {
  const queryable = createMockQueryable((sql) => {
    assert.match(sql, /FROM master_customer/)
    return { rows: [] }
  })

  const result = await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: 'Show PI summary for customer Missing Customer',
    useModelWording: false,
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 404)
  assert.match(result.message, /Customer not found/)
})

test('ambiguous customer match asks for clarification', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [
      { cust_code: 1, cust_name: 'Tata Motors Jaipur' },
      { cust_code: 2, cust_name: 'Tata Motors Delhi' },
    ],
  }))

  const result = await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: 'Show PI summary for customer Tata Motors',
    useModelWording: false,
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 422)
  assert.deepEqual(result.data.matches, [
    'Tata Motors Jaipur',
    'Tata Motors Delhi',
  ])
})

test('unauthorised request is rejected', async () => {
  const queryable = createMockQueryable(() => {
    throw new Error('Database should not be queried without a user name')
  })

  const result = await verifyERPIntelligenceAccess({
    queryable,
    userName: '',
  })

  assert.equal(result.authorized, false)
})

test('authorised user with ERP right is accepted', async () => {
  const queryable = createMockQueryable((sql, params) => {
    if (sql.includes('FROM master_user\n')) {
      return {
        rows: [{ is_active: true, is_admin: false, user_name: 'dileep' }],
      }
    }

    assert.deepEqual(params, ['dileep', ERP_INTELLIGENCE_SCREEN_ID])
    return { rows: [{ can_access: true }] }
  })

  const result = await verifyERPIntelligenceAccess({
    queryable,
    userName: 'dileep',
  })

  assert.equal(result.authorized, true)
})

test('Ollama unavailable still returns deterministic ERP answer', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [{ count: 2 }],
  }))

  const result = await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: 'How many PIs were generated today?',
    today: '2026-07-28',
  })

  assert.equal(result.success, true)
  assert.equal(result.model, null)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.answer, /2/)
})

test('model output cannot alter verified numbers', async () => {
  const queryable = createMockQueryable(() => ({
    rows: [{ count: 2 }],
  }))

  const result = await processERPQuestion({
    modelWording: async () => ({
      answer: 'Today, 999 Proforma Invoices were generated.',
      model: 'fake-model',
    }),
    queryable,
    question: 'How many PIs were generated today?',
    today: '2026-07-28',
  })

  assert.equal(result.success, true)
  assert.equal(result.model, null)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.answer, /2/)
  assert.doesNotMatch(result.answer, /999/)
})

test('SQL injection-style customer input remains parameterized and safe', async () => {
  const queryable = createMockQueryable((sql) => {
    assert.doesNotMatch(sql, /DROP|DELETE|UPDATE|INSERT/i)
    return { rows: [] }
  })

  await processERPQuestion({
    modelWording: noModel,
    queryable,
    question: "Show PI summary for customer Tata'; DROP TABLE master_pi_rmkt; --",
    useModelWording: false,
  })

  assert.equal(queryable.queries.length, 1)
  assert.match(queryable.queries[0].params[0], /DROP TABLE/)
  assert.doesNotMatch(queryable.queries[0].sql, /DROP TABLE/)
})

test('read-only guard blocks mutation SQL', async () => {
  const queryable = createMockQueryable(() => ({ rows: [] }))

  await assert.rejects(
    () => runReadOnlyQuery(queryable, 'DELETE FROM master_pi_rmkt WHERE pi_no = $1', [1]),
    /read-only/,
  )
})

test('new PI count function uses no mutation SQL', async () => {
  const queryable = createMockQueryable(() => ({ rows: [{ count: 1 }] }))

  await getPICountForDateRange({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-28',
  })

  assert.equal(queryable.queries.length, 1)
  assert.doesNotMatch(
    queryable.queries[0].sql,
    /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
  )
})

test('dashboard response shape contains summary, latest PIs and daily summary', async () => {
  const queryable = createDashboardMockQueryable({
    dailyRows: [
      {
        count: 2,
        pi_date: '2026-07-28',
        total_value: '1500.50',
      },
    ],
    latestRows: [
      {
        company_name: 'Autolite Manufacturing Limited',
        customer_name: 'Jalaram Enterprise',
        grand_total: '99.25',
        pi_date: '2026-07-28',
        pi_number: 'AML-0012',
        status: 'Draft',
      },
    ],
    monthCount: 8,
    monthValue: '4500',
    statusRows: [
      { count: 6, status: 'Draft', total_value: '3000' },
      { count: 2, status: 'Final', total_value: '1500' },
    ],
    todayCount: 2,
    todayValue: '1500.50',
  })

  const result = await getPIIntelligenceDashboard({
    queryable,
    today: '2026-07-28',
  })

  assert.equal(result.success, true)
  assert.equal(result.module, 'PI Intelligence')
  assert.equal(result.timezone, 'Asia/Kolkata')
  assert.deepEqual(result.summary.today, {
    count: 2,
    value: 1500.5,
  })
  assert.deepEqual(result.summary.month, {
    count: 8,
    value: 4500,
  })
  assert.equal(result.latestPIs[0].piNumber, 'AML-0012')
  assert.equal(result.latestPIs[0].grandTotal, 99.25)
  assert.deepEqual(result.dailySummary[0], {
    count: 2,
    date: '2026-07-28',
    value: 1500.5,
  })
})

test('dashboard null totals become zero', async () => {
  const queryable = createDashboardMockQueryable({
    dailyRows: [
      {
        count: null,
        pi_date: '2026-07-28',
        total_value: null,
      },
    ],
    latestRows: [
      {
        company_name: null,
        customer_name: null,
        grand_total: null,
        pi_date: null,
        pi_number: null,
        status: null,
      },
    ],
    monthValue: null,
    statusRows: [{ count: null, status: 'Draft', total_value: null }],
    todayValue: null,
  })

  const result = await getPIIntelligenceDashboard({
    queryable,
    today: '2026-07-28',
  })

  assert.deepEqual(result.summary.today, {
    count: 0,
    value: 0,
  })
  assert.deepEqual(result.summary.month, {
    count: 0,
    value: 0,
  })
  assert.deepEqual(result.summary.open, {
    count: 0,
    value: 0,
  })
  assert.equal(result.summary.final.value, 0)
  assert.equal(result.latestPIs[0].grandTotal, 0)
  assert.equal(result.dailySummary[0].value, 0)
})

test('dashboard latest PI list is limited to 10 rows', async () => {
  const latestRows = Array.from({ length: 12 }, (_item, index) => ({
    company_name: 'Autolite Manufacturing Limited',
    customer_name: `Customer ${index + 1}`,
    grand_total: String(index + 1),
    pi_date: '2026-07-28',
    pi_number: `AML-${String(index + 1).padStart(4, '0')}`,
    status: 'Draft',
  }))
  const queryable = createDashboardMockQueryable({ latestRows })

  const result = await getPIIntelligenceDashboard({
    queryable,
    today: '2026-07-28',
  })
  const latestQuery = queryable.queries.find((query) =>
    query.sql.includes("m.pi_series || LPAD"),
  )

  assert.equal(result.latestPIs.length, 10)
  assert.equal(latestQuery.params[0], 10)
})

test('dashboard maps Draft status to open and Final status to final', async () => {
  const queryable = createDashboardMockQueryable({
    statusRows: [
      { count: 11, status: 'Draft', total_value: '25000' },
      { count: 3, status: 'Final', total_value: '9000' },
    ],
  })

  const result = await getPIIntelligenceDashboard({
    queryable,
    today: '2026-07-28',
  })

  assert.deepEqual(result.summary.open, {
    count: 11,
    value: 25000,
  })
  assert.deepEqual(result.summary.final, {
    count: 3,
    value: 9000,
  })
})

test('dashboard unauthorised request is rejected before reporting', async () => {
  const queryable = createMockQueryable(() => {
    throw new Error('Dashboard must not query data without a user name')
  })

  const result = await verifyERPIntelligenceAccess({
    queryable,
    userName: '',
  })

  assert.equal(result.authorized, false)
})

test('dashboard database errors are surfaced for route error handling', async () => {
  const queryable = createMockQueryable(() => {
    throw new Error('database unavailable')
  })

  await assert.rejects(
    () =>
      getPIIntelligenceDashboard({
        queryable,
        today: '2026-07-28',
      }),
    /database unavailable/,
  )
})

test('dashboard functions use fixed read-only SELECT queries', async () => {
  const queryable = createDashboardMockQueryable()

  await getPIIntelligenceDashboard({
    queryable,
    today: '2026-07-28',
  })

  assert.equal(queryable.queries.length, 7)
  queryable.queries.forEach((query) => {
    assert.match(query.sql.trim(), /^SELECT/i)
    assert.doesNotMatch(
      query.sql,
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    )
  })
})

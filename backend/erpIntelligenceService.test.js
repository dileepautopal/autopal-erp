import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyERPQuestion,
  ERP_INTELLIGENCE_SCREEN_ID,
  ERP_INTENTS,
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

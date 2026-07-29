import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDeterministicManagementInsight,
  getPIManagementInsight,
} from './piInsightService.js'

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

const createInsightQueryable = () =>
  createMockQueryable((sql) => {
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

test('deterministic management insight uses verified figures', () => {
  const insight = buildDeterministicManagementInsight({
    final: { percentage: 25 },
    month: { count: 4, value: 1000 },
    open: { percentage: 75 },
    today: { value: 800 },
    topCompany: { name: 'Autolite Manufacturing Limited', value: 4000 },
    topCustomer: { name: 'Jalaram Enterprise', value: 1500 },
    yesterday: { value: 200 },
  })

  assert.match(insight, /1,000/)
  assert.match(insight, /75/)
  assert.match(insight, /Jalaram Enterprise/)
})

test('management insight uses Ollama when numbers remain verified', async () => {
  const result = await getPIManagementInsight({
    modelWording: async () => ({
      answer: 'Current month PI value is 1000 and open PIs are 75%.',
      model: 'fake-model',
    }),
    queryable: createInsightQueryable(),
    today: '2026-07-28',
  })

  assert.equal(result.wordingMode, 'ollama')
  assert.equal(result.model, 'fake-model')
  assert.match(result.insight, /1000/)
})

test('management insight falls back when Ollama is unavailable', async () => {
  const result = await getPIManagementInsight({
    modelWording: async () => {
      const error = new Error('offline')
      error.statusCode = 503
      throw error
    },
    queryable: createInsightQueryable(),
    today: '2026-07-28',
  })

  assert.equal(result.wordingMode, 'server-fallback')
  assert.equal(result.model, null)
  assert.match(result.insight, /Current month/)
})

test('management insight rejects model output that invents numbers', async () => {
  const result = await getPIManagementInsight({
    modelWording: async () => ({
      answer: 'Current month PI value is 999999 and next month will grow.',
      model: 'fake-model',
    }),
    queryable: createInsightQueryable(),
    today: '2026-07-28',
  })

  assert.equal(result.wordingMode, 'server-fallback')
  assert.doesNotMatch(result.insight, /999999/)
})

test('empty-data management insight is safe', async () => {
  const queryable = createMockQueryable((sql) => {
    if (sql.includes('AVG(m.grand_total)')) {
      return {
        rows: [
          {
            average_value: null,
            count: null,
            highest_value: null,
            lowest_value: null,
            total_value: null,
          },
        ],
      }
    }

    return { rows: [] }
  })

  const result = await getPIManagementInsight({
    queryable,
    today: '2026-07-28',
    useModelWording: false,
  })

  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.insight, /0/)
})

test('management insight sends only safe verified data to model', async () => {
  let prompt = ''
  await getPIManagementInsight({
    modelWording: async ({ question }) => {
      prompt = question
      return {
        answer: 'Current month PI value is 1000.',
        model: 'fake-model',
      }
    },
    queryable: createInsightQueryable(),
    today: '2026-07-28',
  })

  assert.doesNotMatch(prompt, /gst|address|phone|email|bank|sql|table/i)
  assert.match(prompt, /topCustomer/)
})

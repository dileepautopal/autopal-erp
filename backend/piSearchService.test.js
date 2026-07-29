import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getSafePIDetail,
  searchPIs,
} from './piSearchService.js'

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

const searchRows = [
  {
    company_name: 'Autolite Manufacturing Limited',
    customer_name: 'Jalaram Enterprise',
    grand_total: '1000',
    pi_date: '2026-07-28',
    pi_number: 'AML-0012',
    status: 'Draft',
  },
]

test('PI search rejects missing criteria', async () => {
  const result = await searchPIs({
    queryable: createMockQueryable(() => ({ rows: [] })),
  })

  assert.equal(result.statusCode, 400)
  assert.match(result.error, /enter/)
})

test('PI search rejects one-character wildcard abuse', async () => {
  const result = await searchPIs({
    q: 'A',
    queryable: createMockQueryable(() => ({ rows: [] })),
  })

  assert.equal(result.statusCode, 400)
})

test('PI search supports exact PI series plus number', async () => {
  const queryable = createMockQueryable((_sql, params) => {
    assert.equal(params[0], 'AML-0012')
    return { rows: searchRows }
  })

  const result = await searchPIs({
    q: 'AML-12',
    queryable,
  })

  assert.equal(result.rows[0].piNumber, 'AML-0012')
})

test('PI search supports customer name search', async () => {
  const queryable = createMockQueryable((sql, params) => {
    assert.match(sql, /customer_name|pcust_name/i)
    assert.ok(params.some((param) => String(param).includes('Jalaram')))
    return { rows: searchRows }
  })

  const result = await searchPIs({
    customer: 'Jalaram',
    queryable,
  })

  assert.equal(result.rows.length, 1)
})

test('PI search supports company name search', async () => {
  const queryable = createMockQueryable((sql, params) => {
    assert.match(sql, /company_name/i)
    assert.ok(params.some((param) => String(param).includes('Autolite')))
    return { rows: searchRows }
  })

  const result = await searchPIs({
    company: 'Autolite',
    queryable,
  })

  assert.equal(result.rows[0].companyName, 'Autolite Manufacturing Limited')
})

test('PI search supports open and final status mapping', async () => {
  const openQueryable = createMockQueryable((_sql, params) => {
    assert.ok(params.includes('Draft'))
    return { rows: searchRows }
  })
  const finalQueryable = createMockQueryable((_sql, params) => {
    assert.ok(params.includes('Final'))
    return { rows: searchRows }
  })

  await searchPIs({ queryable: openQueryable, status: 'pending' })
  await searchPIs({ queryable: finalQueryable, status: 'closed' })
})

test('PI search rejects invalid status', async () => {
  const result = await searchPIs({
    queryable: createMockQueryable(() => ({ rows: [] })),
    status: 'cancelled',
  })

  assert.equal(result.statusCode, 400)
})

test('PI search supports date range and validates dates', async () => {
  const queryable = createMockQueryable((_sql, params) => {
    assert.ok(params.includes('2026-07-01'))
    assert.ok(params.includes('2026-07-28'))
    return { rows: searchRows }
  })

  const result = await searchPIs({
    endDate: '2026-07-28',
    queryable,
    startDate: '2026-07-01',
  })
  const invalid = await searchPIs({
    endDate: '2026-07-01',
    queryable,
    startDate: '2026-07-28',
  })

  assert.equal(result.rows.length, 1)
  assert.equal(invalid.statusCode, 400)
})

test('PI search limit defaults and caps at maximum', async () => {
  const queryable = createMockQueryable((_sql, params) => {
    assert.equal(params.at(-1), 50)
    return { rows: searchRows }
  })

  const result = await searchPIs({
    limit: 500,
    q: 'AML',
    queryable,
  })

  assert.equal(result.limit, 50)
})

test('PI search remains parameterized for SQL-injection-style input', async () => {
  const queryable = createMockQueryable((sql, params) => {
    assert.doesNotMatch(sql, /DROP TABLE/i)
    assert.ok(params.some((param) => String(param).includes('DROP TABLE')))
    return { rows: [] }
  })

  await searchPIs({
    q: "AML-0012'; DROP TABLE master_pi_rmkt; --",
    queryable,
  })
})

test('PI search escapes LIKE wildcards', async () => {
  const queryable = createMockQueryable((_sql, params) => {
    assert.ok(params.some((param) => String(param).includes('\\%')))
    assert.ok(params.some((param) => String(param).includes('\\_')))
    return { rows: [] }
  })

  await searchPIs({
    q: 'A%_',
    queryable,
  })
})

test('PI search result does not expose sensitive fields', async () => {
  const queryable = createMockQueryable(() => ({ rows: searchRows }))
  const result = await searchPIs({
    q: 'AML',
    queryable,
  })

  assert.deepEqual(Object.keys(result.rows[0]).sort(), [
    'companyName',
    'customerName',
    'grandTotal',
    'piDate',
    'piNumber',
    'status',
  ])
})

test('safe PI detail returns header and product lines only', async () => {
  const queryable = createMockQueryable((sql) => {
    if (sql.includes('FROM master_pi_rmkt')) {
      return {
        rows: [
          {
            company_name: 'Autolite Manufacturing Limited',
            comp_code: 2,
            customer_name: 'Jalaram Enterprise',
            grand_total: '1000',
            pi_date: '2026-07-28',
            pi_no: 12,
            pi_number: 'AML-0012',
            pi_series: 'AML-',
            status: 'Draft',
          },
        ],
      }
    }

    return {
      rows: [
        {
          amount: '1000',
          product_code: 'SB102',
          quantity: '10',
          rate: '100',
        },
      ],
    }
  })

  const result = await getSafePIDetail({
    piNumber: 'AML-12',
    queryable,
  })

  assert.equal(result.piNumber, 'AML-0012')
  assert.equal(result.lines[0].productCode, 'SB102')
  assert.equal(result.lines[0].productDescription, '')
})

test('safe PI detail handles not found and ambiguous numbers', async () => {
  const notFound = await getSafePIDetail({
    piNumber: 'AML-9999',
    queryable: createMockQueryable(() => ({ rows: [] })),
  })
  const ambiguous = await getSafePIDetail({
    piNumber: 'AML-0012',
    queryable: createMockQueryable(() => ({
      rows: [{ pi_no: 12 }, { pi_no: 12 }],
    })),
  })

  assert.equal(notFound.statusCode, 404)
  assert.equal(ambiguous.statusCode, 422)
})

test('new search service uses no mutation SQL', async () => {
  const queryable = createMockQueryable(() => ({ rows: searchRows }))

  await searchPIs({
    q: 'AML',
    queryable,
  })

  queryable.queries.forEach((query) => {
    assert.doesNotMatch(
      query.sql,
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i,
    )
  })
})

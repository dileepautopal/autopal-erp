import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  getExecutiveDrillDown,
  searchExecutiveData,
} from './executiveDrillDownService.js'

const tableNames = {
  company: 'master_company',
  customer: 'master_customer',
  piMaster: 'master_pi_rmkt',
  piTran: 'tran_pi_rmkt',
  product: 'master_products',
  user: 'master_user',
  userRights: 'master_user_rights',
}

const piRows = [
  {
    company_code: 2,
    company_name: 'Autolite Manufacturing Limited',
    customer_code: 1,
    customer_name: 'Jalaram Enterprise',
    grand_total: 209577,
    pi_date: '2026-07-29',
    pi_number: 'AML-0017',
    status: 'Draft',
  },
  {
    company_code: 2,
    company_name: 'Autolite Manufacturing Limited',
    customer_code: 1,
    customer_name: 'Jalaram Enterprise',
    grand_total: 10743,
    pi_date: '2026-07-24',
    pi_number: 'AML-0011',
    status: 'Final',
  },
]

const lineRows = [
  {
    amount: 449519.5,
    company_code: 2,
    company_name: 'Autolite Manufacturing Limited',
    customer_code: 1,
    customer_name: 'Jalaram Enterprise',
    pi_date: '2026-07-29',
    pi_number: 'AML-0017',
    product_code: '04-102-1411',
    product_description: 'SB 102 MSR - M P43T H4 WITHOUT BULB P LHT E',
    quantity: 3230,
    rate: 145.97,
    status: 'Draft',
  },
]

const customerRows = [
  {
    average_value: 74565.36,
    count_rank: 1,
    current_count: 11,
    current_value: 820219,
    customer_code: 1,
    customer_name: 'Jalaram Enterprise',
    days_since_last_pi: 0,
    final_count: 0,
    final_value: 0,
    first_pi_date: '2026-07-24',
    highest_value: 209577,
    historical_count: 1,
    historical_value: 0,
    last_pi_date: '2026-07-29',
    lowest_value: 10743,
    open_count: 11,
    open_value: 820219,
    previous_count: 1,
    previous_value: 0,
    total_current_value: 849926,
    value_rank: 1,
  },
]

const productRows = [
  {
    average_quantity: 269.17,
    average_rate: 145.97,
    current_value: 449519.5,
    distinct_customer_count: 2,
    distinct_pi_count: 12,
    latest_pi_date: '2026-07-29',
    line_count: 12,
    previous_quantity: 360,
    previous_value: 48654,
    product_code: '04-102-1411',
    product_description: 'SB 102 MSR - M P43T H4 WITHOUT BULB P LHT E',
    quantity_rank: 1,
    total_current_value: 738077.5,
    total_quantity: 3230,
    value_rank: 1,
  },
]

const companyRows = [
  {
    average_value: 70827.17,
    company_code: 2,
    company_name: 'Autolite Manufacturing Limited',
    current_count: 12,
    current_value: 849926,
    final_count: 0,
    final_value: 0,
    last_pi_date: '2026-07-29',
    open_count: 12,
    open_value: 849926,
    previous_count: 1,
    previous_value: 0,
    total_current_value: 849926,
  },
]

const makeQueryable = () => {
  const calls = []

  return {
    calls,
    async query(sql, params) {
      calls.push({ params, sql })

      if (sql.includes('LIMIT 2') && sql.includes('m.pi_no')) {
        return {
          rows: [
            {
              ...piRows[0],
              comp_code: 2,
              pi_no: 17,
              pi_series: 'AML-',
            },
          ],
        }
      }

      if (sql.includes('FROM tran_pi_rmkt t')) {
        return { rows: lineRows }
      }

      if (sql.includes('customer_key')) {
        return { rows: customerRows }
      }

      if (sql.includes('product_key')) {
        return { rows: productRows }
      }

      if (sql.includes('company_code') && sql.includes('current_rows')) {
        return { rows: companyRows }
      }

      if (sql.includes('COUNT(*)::int AS count')) {
        return {
          rows: [
            {
              average_value: 70827.17,
              count: 12,
              final_count: 0,
              final_value: 0,
              highest_value: 209577,
              lowest_value: 10743,
              open_count: 12,
              open_value: 849926,
              total_value: 849926,
            },
          ],
        }
      }

      return { rows: piRows }
    },
  }
}

const requestBase = (queryable) => ({
  period: 'this-month',
  queryable,
  tableNames,
  today: '2026-07-29',
})

test('today PI drill-down returns safe PI rows', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'today-pis',
  })

  assert.equal(result.success, true)
  assert.equal(result.type, 'today-pis')
  assert.equal(result.rows[0].piNumber, 'AML-0017')
  assert.equal(result.rows[0].grandTotal, 209577)
  assert.equal(result.rows[0].gstin, undefined)
  assert.equal(result.rows[0].phone, undefined)
})

test('open and final PI drill-downs apply status filters', async () => {
  const queryable = makeQueryable()
  const open = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'open-pis',
  })
  const final = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'final-pis',
  })

  assert.equal(open.success, true)
  assert.equal(final.success, true)
  assert.match(queryable.calls[0].sql, /Draft/)
  assert.match(queryable.calls[1].sql, /Final/)
})

test('highest and lowest PI drill-downs return one supporting row', async () => {
  const queryable = makeQueryable()
  const highest = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'highest-pi',
  })
  const lowest = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'lowest-pi',
  })

  assert.equal(highest.pagination.returned, 1)
  assert.equal(lowest.pagination.returned, 1)
  assert.equal(highest.nextActions[0].type, 'pi-detail')
})

test('top customer drill-down returns customer summary and matching PIs', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'top-customer',
  })

  assert.equal(result.success, true)
  assert.equal(result.summary.detail.customerName, 'Jalaram Enterprise')
  assert.equal(result.rows[0].customerName, 'Jalaram Enterprise')
})

test('top product drill-down returns product summary and PI-line rows', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'top-product',
  })

  assert.equal(result.success, true)
  assert.equal(result.summary.detail.productCode, '04-102-1411')
  assert.equal(result.rows[0].productDescription, 'SB 102 MSR - M P43T H4 WITHOUT BULB P LHT E')
})

test('top company drill-down returns company summary and PI rows', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'top-company',
  })

  assert.equal(result.success, true)
  assert.equal(result.summary.detail.companyCode, 2)
  assert.equal(result.rows[0].companyName, 'Autolite Manufacturing Limited')
})

test('PI detail drill-down returns safe product lines', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    filters: { piNumber: 'AML-0017' },
    type: 'pi-detail',
  })

  assert.equal(result.success, true)
  assert.equal(result.summary.detail.piNumber, 'AML-0017')
  assert.equal(result.rows[0].productCode, '04-102-1411')
  assert.equal(result.rows[0].bankName, undefined)
})

test('daily trend date validates required date', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'daily-trend-date',
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 400)
})

test('unsupported drill-down type is rejected', async () => {
  const queryable = makeQueryable()
  const result = await getExecutiveDrillDown({
    ...requestBase(queryable),
    type: 'stock-ledger',
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 400)
})

test('executive search rejects missing safe criteria', async () => {
  const result = await searchExecutiveData({
    queryable: makeQueryable(),
    tableNames,
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 400)
})

test('executive search supports product PI-line search', async () => {
  const result = await searchExecutiveData({
    category: 'product',
    q: '04-102-1411',
    queryable: makeQueryable(),
    tableNames,
  })

  assert.equal(result.success, true)
  assert.equal(result.rows[0].productCode, '04-102-1411')
})

test('executive search validates partial date ranges', async () => {
  const result = await searchExecutiveData({
    q: 'Jalaram',
    queryable: makeQueryable(),
    startDate: '2026-07-01',
    tableNames,
  })

  assert.equal(result.success, false)
  assert.equal(result.statusCode, 400)
})

test('executive drill-down source uses no mutation SQL statements', () => {
  const source = fs.readFileSync(new URL('./executiveDrillDownService.js', import.meta.url), 'utf8')
  const stringsOnly = source.match(/`[\s\S]*?`|'[^']*'|"[^"]*"/g)?.join('\n') ?? ''
  const mutationSql =
    /\b(INSERT\s+INTO|UPDATE\s+["\w.]+|DELETE\s+FROM|ALTER\s+(TABLE|INDEX|DATABASE|SCHEMA)|DROP\s+(TABLE|INDEX|DATABASE|SCHEMA)|TRUNCATE\s+(TABLE|SCHEMA)|LOCK\s+TABLE|GRANT\s+|REVOKE\s+)/i

  assert.doesNotMatch(stringsOnly, mutationSql)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { explainExecutiveDrillDown } from './executiveExplainService.js'

const sampleDrillDown = {
  filters: { customerCode: 1 },
  module: 'Executive Drill-Down',
  pagination: {
    hasMore: false,
    limit: 50,
    returned: 1,
  },
  period: {
    endDate: '2026-07-29',
    label: 'This Month',
    startDate: '2026-07-01',
  },
  rows: [
    {
      companyName: 'Autolite Manufacturing Limited',
      customerName: 'Jalaram Enterprise',
      grandTotal: 209577,
      piDate: '2026-07-29',
      piNumber: 'AML-0017',
      status: 'Draft',
    },
  ],
  success: true,
  summary: {
    cards: [
      { label: 'Customer', value: 'Jalaram Enterprise' },
      { label: 'PI Count', type: 'number', value: 1 },
      { label: 'PI Value', type: 'currency', value: 209577 },
    ],
  },
  title: 'Top Customer',
  type: 'top-customer',
}

test('explain falls back when Ollama is unavailable', async () => {
  const result = await explainExecutiveDrillDown({
    drillDown: sampleDrillDown,
    modelWording: async () => {
      throw new Error('Ollama unavailable')
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.match(result.explanation, /Top Customer/)
  assert.match(result.explanation, /Proforma Invoice activity/)
})

test('explain rejects forbidden actual-sales wording', async () => {
  const result = await explainExecutiveDrillDown({
    drillDown: sampleDrillDown,
    modelWording: async () => ({
      answer: 'Actual sales are 209577.',
      model: 'test',
    }),
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.doesNotMatch(result.explanation, /Actual sales/i)
})

test('explain rejects invented numbers', async () => {
  const result = await explainExecutiveDrillDown({
    drillDown: sampleDrillDown,
    modelWording: async () => ({
      answer: 'This drill-down has 999 records and PI value 209577.',
      model: 'test',
    }),
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'server-fallback')
  assert.doesNotMatch(result.explanation, /999/)
})

test('explain accepts concise model wording using verified numbers only', async () => {
  const result = await explainExecutiveDrillDown({
    drillDown: sampleDrillDown,
    modelWording: async () => ({
      answer:
        'Top Customer is supported by 1 visible PI record with PI value 209577. This is based on Proforma Invoice activity only.',
      model: 'test-model',
    }),
  })

  assert.equal(result.success, true)
  assert.equal(result.wordingMode, 'ollama')
  assert.equal(result.model, 'test-model')
})

test('executive explain source uses no mutation SQL statements', () => {
  const source = fs.readFileSync(new URL('./executiveExplainService.js', import.meta.url), 'utf8')
  const stringsOnly = source.match(/`[\s\S]*?`|'[^']*'|"[^"]*"/g)?.join('\n') ?? ''
  const mutationSql =
    /\b(INSERT\s+INTO|UPDATE\s+["\w.]+|DELETE\s+FROM|ALTER\s+(TABLE|INDEX|DATABASE|SCHEMA)|DROP\s+(TABLE|INDEX|DATABASE|SCHEMA)|TRUNCATE\s+(TABLE|SCHEMA)|LOCK\s+TABLE|GRANT\s+|REVOKE\s+)/i

  assert.doesNotMatch(stringsOnly, mutationSql)
})

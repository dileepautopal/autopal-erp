import assert from 'node:assert/strict'
import test from 'node:test'
import {
  processWhatsAppValidatedOrderInput,
  VALIDATED_ORDER_STATUSES,
  validateLines,
} from './whatsappValidatedOrderInputService.js'

const source = (overrides = {}) => ({
  candidate_type: 'media_excel_candidate',
  message_id: 'wamid.source',
  sheet_name: 'Order',
  source_row: 2,
  source_cells: { description: 'A2', quantity: 'B2', unit: 'C2' },
  ...overrides,
})

const line = (overrides = {}) => ({
  sequence: 1,
  description: 'HEAD LIGHT ASSY ACE MEGA',
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 18,
  raw_quantity: '18',
  unit: 'NOS',
  source: source(),
  warnings: [],
  ...overrides,
})

const input = (overrides = {}) => ({
  version: 1,
  source_type: 'EXCEL',
  primary_message_id: 'wamid.source',
  sender: '917733850017',
  lines: [line()],
  instructions: [],
  requires_review: false,
  warnings: [],
  ...overrides,
})

const row = (overrides = {}) => ({
  id: 1,
  message_id: 'wamid.validation',
  sender_phone: '917733850017',
  unified_order_status: 'UNIFIED_READY',
  unified_order_input: input(),
  validated_order_status: 'PENDING',
  validated_order_input: null,
  validated_order_processed_at: null,
  validated_order_error: null,
  media_order_candidate: { evidence: 'image' },
  media_excel_candidate: { evidence: 'excel' },
  media_word_candidate: { evidence: 'word' },
  media_mixed_context: { evidence: 'mixed' },
  pi_created: false,
  ...overrides,
})

const createPool = (initialRow, { failFinalOnce = false } = {}) => {
  const state = {
    businessCalls: 0,
    failFinalOnce,
    row: structuredClone(initialRow),
    updates: 0,
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) return { rowCount: 0, rows: [] }
      if (/SELECT[\s\S]+unified_order_status[\s\S]+WHERE message_id = \$1::varchar/i.test(sql)) {
        return { rowCount: 1, rows: [structuredClone(state.row)] }
      }
      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /validated_order_status/i.test(sql)) {
        if (state.failFinalOnce && !['VALIDATING', 'VALIDATION_FAILED'].includes(params[1])) {
          state.failFinalOnce = false
          throw new Error('simulated persistence failure')
        }
        state.updates += 1
        state.row.validated_order_status = params[1]
        if (params[1] !== 'VALIDATING') {
          state.row.validated_order_input = params[2] ? JSON.parse(params[2]) : null
          state.row.validated_order_processed_at = '2026-08-18T10:00:00.000Z'
        }
        state.row.validated_order_error = params[3]
        return { rowCount: 1, rows: [structuredClone(state.row)] }
      }
      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessCalls += 1
        throw new Error('Phase 2.9 must not perform business or outbound operations.')
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

const process = async (sourceRow, options) => {
  const pool = createPool(sourceRow, options)
  const result = await processWhatsAppValidatedOrderInput({
    messageId: sourceRow.message_id,
    pool,
  })
  return { pool, result }
}

test('clean Excel input keeps four lines and provenance and becomes ready', async () => {
  const lines = [1, 2, 3, 4].map((sequence) => line({
    sequence,
    description: `PRODUCT ${sequence}`,
    raw_description: `PRODUCT ${sequence}`,
    quantity: sequence * 10,
    raw_quantity: String(sequence * 10),
    source: source({ source_row: sequence + 1 }),
  }))
  const { result } = await process(row({ unified_order_input: input({ lines }) }))

  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_READY)
  assert.equal(result.input.lines.length, 4)
  assert.deepEqual(result.input.lines.map((item) => item.quantity), [10, 20, 30, 40])
  assert.equal(result.input.lines[0].source.sheet_name, 'Order')
  assert.equal(result.input.requires_review, false)
})

test('clean Word input becomes ready with Word provenance', async () => {
  const wordSource = {
    candidate_type: 'media_word_candidate', message_id: 'wamid.word',
    source_type: 'TABLE', source_table: 1, source_row: 2,
    source_cells: { description: 'table1:r2:c1', quantity: 'table1:r2:c2' },
  }
  const sourceInput = input({
    source_type: 'WORD',
    lines: [line({ source: wordSource })],
  })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_READY)
  assert.deepEqual(result.input.lines[0].source, wordSource)
})

test('clean image and PDF inputs become ready with extraction provenance', async (context) => {
  for (const sourceType of ['IMAGE', 'PDF']) {
    await context.test(sourceType, async () => {
      const mediaSource = {
        candidate_type: 'media_order_candidate', message_id: `wamid.${sourceType}`,
        source_text: 'HEAD LIGHT ASSY ACE MEGA 18 NOS', source_line_number: 3,
      }
      const { result } = await process(row({
        message_id: `wamid.${sourceType}.validation`,
        unified_order_input: input({ source_type: sourceType, lines: [line({ source: mediaSource })] }),
      }))
      assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_READY)
      assert.deepEqual(result.input.lines[0].source, mediaSource)
    })
  }
})

test('quantity 100000 remains numeric, valid, and unchanged', async () => {
  const { result } = await process(row({
    unified_order_input: input({ lines: [line({ quantity: 100000, raw_quantity: '100000' })] }),
  }))
  assert.equal(result.input.lines[0].quantity, 100000)
  assert.equal(result.input.lines[0].validation.valid, true)
})

test('quantity and description errors are deterministic', async (context) => {
  const cases = [
    ['null quantity', { quantity: null }, 'QUANTITY_MISSING'],
    ['zero quantity', { quantity: 0 }, 'QUANTITY_NON_POSITIVE'],
    ['negative quantity', { quantity: -4 }, 'QUANTITY_NON_POSITIVE'],
    ['non-numeric quantity', { quantity: '12' }, 'QUANTITY_INVALID'],
    ['blank description', { description: '  ', raw_description: '  ' }, 'DESCRIPTION_MISSING'],
  ]
  for (const [name, overrides, code] of cases) {
    await context.test(name, async () => {
      const sourceInput = input({ lines: [line(overrides), line({ sequence: 2 })] })
      const { result } = await process(row({ unified_order_input: sourceInput }))
      assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL)
      assert.equal(result.input.lines[0].validation.valid, false)
      assert.ok(result.input.lines[0].validation.errors.includes(code))
      assert.equal(result.input.requires_review, true)
    })
  }
})

test('missing unit is a non-blocking warning and canonical null', async () => {
  const { result } = await process(row({
    unified_order_input: input({ lines: [line({ unit: '  ' })] }),
  }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL)
  assert.equal(result.input.lines[0].unit, null)
  assert.equal(result.input.lines[0].validation.valid, true)
  assert.ok(result.input.lines[0].validation.warnings.includes('UNIT_MISSING'))
})

test('duplicates stay separate without quantity aggregation', async () => {
  const sourceInput = input({ lines: [
    line({ quantity: 15000, raw_quantity: '15000' }),
    line({ sequence: 2, quantity: 1000, raw_quantity: '1000', source: source({ source_row: 3 }) }),
  ] })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.equal(result.input.lines.length, 2)
  assert.deepEqual(result.input.lines.map((item) => item.quantity), [15000, 1000])
  assert.ok(result.input.lines.every((item) => item.validation.warnings.includes('DUPLICATE_DESCRIPTION')))
})

test('duplicate and missing sequences warn without deletion or reordering', async () => {
  const sourceInput = input({ lines: [
    line({ sequence: 4 }),
    line({ sequence: 4, source: source({ source_row: 3 }) }),
    line({ sequence: null, source: source({ source_row: 4 }) }),
  ] })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.deepEqual(result.input.lines.map((item) => item.validation_position), [1, 2, 3])
  assert.deepEqual(result.input.lines.map((item) => item.sequence), [4, 4, null])
  assert.ok(result.input.lines[0].validation.warnings.includes('SEQUENCE_DUPLICATE'))
  assert.ok(result.input.lines[2].validation.warnings.includes('SEQUENCE_MISSING'))
})

test('missing provenance remains usable but requires review', async () => {
  const { result } = await process(row({
    unified_order_input: input({ lines: [line({ source: { message_id: '' } })] }),
  }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL)
  assert.equal(result.input.lines[0].validation.valid, true)
  assert.ok(result.input.lines[0].validation.warnings.includes('SOURCE_PROVENANCE_MISSING'))
})

test('source warnings are preserved and represented by stable validation code', async () => {
  const sourceInput = input({
    lines: [line({ warnings: ['Source row was incomplete.'] })],
    warnings: ['Source candidate needs review.'],
  })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.deepEqual(result.input.source_warnings, ['Source candidate needs review.'])
  assert.deepEqual(result.input.lines[0].source_warnings, ['Source row was incomplete.'])
  assert.ok(result.input.warnings.includes('SOURCE_WARNING'))
  assert.ok(result.input.lines[0].validation.warnings.includes('SOURCE_WARNING'))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL)
})

test('unresolved instruction is copied unchanged and does not mutate quantities', async () => {
  const instruction = { message_id: 'wamid.followup', role: 'FOLLOWUP', text: 'Qty 10 each', resolved: false }
  const sourceInput = input({ instructions: [instruction], requires_review: true })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.equal(result.input.lines[0].quantity, 18)
  assert.deepEqual(result.input.instructions, [instruction])
  assert.ok(result.input.warnings.includes('UNRESOLVED_INSTRUCTION'))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL)
})

test('ambiguous input is blocked without selecting lines', async () => {
  const sourceInput = input({
    source_type: 'MIXED', primary_message_id: null, lines: [], requires_review: true,
    possible_primaries: [{ message_id: 'wamid.a', source_type: 'EXCEL' }],
    instructions: [{ message_id: 'wamid.followup', role: 'FOLLOWUP', text: 'Qty 10 each', resolved: false }],
  })
  const { result } = await process(row({
    unified_order_status: 'UNIFIED_AMBIGUOUS', unified_order_input: sourceInput,
  }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATION_BLOCKED_AMBIGUOUS)
  assert.deepEqual(result.input.lines, [])
  assert.deepEqual(result.input.possible_primaries, sourceInput.possible_primaries)
  assert.deepEqual(result.input.instructions, sourceInput.instructions)
  assert.ok(result.input.warnings.includes('UNRESOLVED_INSTRUCTION'))
  assert.equal(result.input.requires_review, true)
})

test('no input is a non-technical terminal outcome', async () => {
  const { result } = await process(row({
    unified_order_status: 'UNIFIED_NO_INPUT', unified_order_input: null,
  }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATION_NO_INPUT)
  assert.deepEqual(result.input.lines, [])
  assert.equal(result.error, '')
})

test('all invalid lines are preserved and rejected', async () => {
  const sourceInput = input({ lines: [
    line({ description: '', quantity: null }),
    line({ sequence: 2, quantity: -4, source: source({ source_row: 3 }) }),
  ] })
  const { result } = await process(row({ unified_order_input: sourceInput }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATION_REJECTED)
  assert.equal(result.input.lines.length, 2)
  assert.equal(result.input.requires_review, true)
})

test('UNIFIED_FAILED maps to a safe validation failure', async () => {
  const { result } = await process(row({ unified_order_status: 'UNIFIED_FAILED' }))
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATION_FAILED)
  assert.equal(result.error, 'Source unified order input is in UNIFIED_FAILED state.')
})

test('technical persistence exception is contained and earlier data is unchanged', async () => {
  const sourceRow = row()
  const before = JSON.stringify(sourceRow)
  const { pool, result } = await process(sourceRow, { failFinalOnce: true })
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATION_FAILED)
  assert.match(result.error, /simulated persistence failure/)
  assert.equal(pool.state.row.unified_order_status, sourceRow.unified_order_status)
  assert.deepEqual(pool.state.row.unified_order_input, sourceRow.unified_order_input)
  assert.equal(pool.state.row.pi_created, false)
  assert.notEqual(JSON.stringify(pool.state.row), before)
})

test('terminal validation is idempotent without a second rewrite', async () => {
  const pool = createPool(row())
  const first = await processWhatsAppValidatedOrderInput({ messageId: 'wamid.validation', pool })
  const updates = pool.state.updates
  const second = await processWhatsAppValidatedOrderInput({ messageId: 'wamid.validation', pool })
  assert.equal(first.status, VALIDATED_ORDER_STATUSES.VALIDATED_READY)
  assert.equal(second.duplicate, true)
  assert.equal(pool.state.updates, updates)
  assert.deepEqual(second.input, first.input)
})

test('pending Phase 2.8 is ineligible and remains untouched', async () => {
  const { pool, result } = await process(row({ unified_order_status: 'UNIFYING' }))
  assert.equal(result.skipped, true)
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.PENDING)
  assert.equal(pool.state.updates, 0)
})

test('Phase 2.8 input and every earlier candidate stay byte-equivalent', async () => {
  const sourceRow = row()
  const pool = createPool(sourceRow)
  const before = JSON.stringify({
    unified: pool.state.row.unified_order_input,
    order: pool.state.row.media_order_candidate,
    excel: pool.state.row.media_excel_candidate,
    word: pool.state.row.media_word_candidate,
    mixed: pool.state.row.media_mixed_context,
  })
  await processWhatsAppValidatedOrderInput({ messageId: sourceRow.message_id, pool })
  const after = JSON.stringify({
    unified: pool.state.row.unified_order_input,
    order: pool.state.row.media_order_candidate,
    excel: pool.state.row.media_excel_candidate,
    word: pool.state.row.media_word_candidate,
    mixed: pool.state.row.media_mixed_context,
  })
  assert.equal(after, before)
  assert.equal(pool.state.row.pi_created, false)
})

test('validation performs no business, PI, acknowledgement, or outbound query', async () => {
  const { pool, result } = await process(row())
  assert.equal(result.status, VALIDATED_ORDER_STATUSES.VALIDATED_READY)
  assert.equal(pool.state.businessCalls, 0)
})

test('non-finite quantities are invalid in the pure validator', () => {
  for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const [validated] = validateLines([line({ quantity })])
    assert.equal(validated.validation.valid, false)
    assert.ok(validated.validation.errors.includes('QUANTITY_INVALID'))
  }
})

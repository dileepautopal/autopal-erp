import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIDENCE_BANDS,
  ORDER_REVIEW_STATUSES,
  processWhatsAppOrderReviewAssessment,
} from './whatsappOrderReviewAssessmentService.js'

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
  validation_position: 1,
  description: 'HEAD LIGHT ASSY ACE MEGA',
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 18,
  raw_quantity: '18',
  unit: 'NOS',
  source: source(),
  warnings: [],
  source_warnings: [],
  validation: { valid: true, warnings: [], errors: [] },
  ...overrides,
})

const validatedInput = (overrides = {}) => ({
  version: 1,
  source_unified_message_id: 'wamid.review',
  source_type: 'EXCEL',
  primary_message_id: 'wamid.source',
  sender: '917733850017',
  validation_status: 'VALIDATED_READY',
  lines: [line()],
  instructions: [],
  possible_primaries: [],
  source_requires_review: false,
  source_warnings: [],
  requires_review: false,
  warnings: [],
  errors: [],
  ...overrides,
})

const row = (overrides = {}) => ({
  id: 1,
  message_id: 'wamid.review',
  sender_phone: '917733850017',
  validated_order_status: 'VALIDATED_READY',
  validated_order_input: validatedInput(),
  validated_order_processed_at: '2026-08-18T10:00:00.000Z',
  validated_order_error: null,
  review_status: 'PENDING',
  review_decision: null,
  review_processed_at: null,
  review_error: null,
  unified_order_status: 'UNIFIED_READY',
  unified_order_input: { evidence: 'unified' },
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
      if (/SELECT[\s\S]+validated_order_status[\s\S]+WHERE message_id = \$1::varchar/i.test(sql)) {
        return { rowCount: 1, rows: [structuredClone(state.row)] }
      }
      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /review_status/i.test(sql)) {
        if (state.failFinalOnce && !['ASSESSING', 'ASSESSMENT_FAILED'].includes(params[1])) {
          state.failFinalOnce = false
          throw new Error('simulated review persistence failure')
        }
        state.updates += 1
        state.row.review_status = params[1]
        if (params[1] !== 'ASSESSING') {
          state.row.review_decision = params[2] ? JSON.parse(params[2]) : null
          state.row.review_processed_at = '2026-08-18T10:05:00.000Z'
        }
        state.row.review_error = params[3]
        return { rowCount: 1, rows: [structuredClone(state.row)] }
      }
      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessCalls += 1
        throw new Error('Phase 2.10 must not perform business or outbound operations.')
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

const process = async (sourceRow, options) => {
  const pool = createPool(sourceRow, options)
  const result = await processWhatsAppOrderReviewAssessment({
    messageId: sourceRow.message_id,
    pool,
  })
  return { pool, result }
}

test('clean VALIDATED_READY with four valid lines becomes AUTO_READY at 100 HIGH', async () => {
  const lines = [1, 2, 3, 4].map((position) => line({
    sequence: position,
    validation_position: position,
    description: `PRODUCT ${position}`,
    raw_description: `PRODUCT ${position}`,
    quantity: position * 10,
    raw_quantity: String(position * 10),
    source: source({ source_row: position + 1 }),
  }))
  const { result } = await process(row({ validated_order_input: validatedInput({ lines }) }))

  assert.equal(result.status, ORDER_REVIEW_STATUSES.AUTO_READY)
  assert.equal(result.decision.score, 100)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.HIGH)
  assert.equal(result.decision.requires_manual_review, false)
  assert.deepEqual(result.decision.summary, {
    total_lines: 4, valid_lines: 4, invalid_lines: 0,
    instruction_count: 0, warning_count: 0, error_count: 0,
  })
})

test('clean Excel and Word validation both become AUTO_READY HIGH', async (context) => {
  for (const sourceType of ['EXCEL', 'WORD']) {
    await context.test(sourceType, async () => {
      const candidateType = sourceType === 'EXCEL'
        ? 'media_excel_candidate'
        : 'media_word_candidate'
      const { result } = await process(row({
        message_id: `wamid.${sourceType}`,
        validated_order_input: validatedInput({
          source_type: sourceType,
          source_unified_message_id: `wamid.${sourceType}`,
          lines: [line({ source: source({ candidate_type: candidateType }) })],
        }),
      }))
      assert.equal(result.status, ORDER_REVIEW_STATUSES.AUTO_READY)
      assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.HIGH)
    })
  }
})

test('unresolved instruction deducts 40 and remains unchanged', async () => {
  const instruction = {
    message_id: 'wamid.followup', role: 'FOLLOWUP', text: 'Qty 11 each', resolved: false,
  }
  const input = validatedInput({
    validation_status: 'VALIDATED_PARTIAL',
    instructions: [instruction],
    requires_review: true,
    warnings: ['UNRESOLVED_INSTRUCTION'],
  })
  const before = JSON.stringify(input)
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL', validated_order_input: input,
  }))

  assert.equal(result.status, ORDER_REVIEW_STATUSES.MANUAL_REVIEW)
  assert.equal(result.decision.score, 60)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.LOW)
  assert.ok(result.decision.reasons.includes('UNRESOLVED_INSTRUCTION'))
  assert.equal(result.decision.review_items[0].instruction_text, 'Qty 11 each')
  assert.equal(JSON.stringify(input), before)
  assert.equal(input.lines[0].quantity, 18)
})

test('missing unit deducts 15 and creates a referenced review item', async () => {
  const warnedLine = line({
    unit: null,
    validation: { valid: true, warnings: ['UNIT_MISSING'], errors: [] },
  })
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', lines: [warnedLine], requires_review: true,
    }),
  }))
  assert.equal(result.decision.score, 85)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.MEDIUM)
  assert.ok(result.decision.reasons.includes('UNIT_MISSING'))
  assert.deepEqual(result.decision.review_items[0], {
    code: 'UNIT_MISSING', severity: 'MEDIUM', validation_position: 1,
    sequence: 1, source_message_id: 'wamid.source',
  })
})

test('missing provenance deducts 20 and routes to manual review', async () => {
  const warnedLine = line({
    source: null,
    validation: { valid: true, warnings: ['SOURCE_PROVENANCE_MISSING'], errors: [] },
  })
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', lines: [warnedLine], requires_review: true,
    }),
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.MANUAL_REVIEW)
  assert.equal(result.decision.score, 80)
  assert.ok(result.decision.reasons.includes('SOURCE_PROVENANCE_MISSING'))
})

test('duplicate description and sequence warnings are deterministic and do not merge lines', async () => {
  const lines = [
    line({
      validation: { valid: true, warnings: ['DUPLICATE_DESCRIPTION', 'SEQUENCE_DUPLICATE'], errors: [] },
    }),
    line({
      validation_position: 2,
      quantity: 7,
      raw_quantity: '7',
      source: source({ source_row: 3 }),
      validation: { valid: true, warnings: ['DUPLICATE_DESCRIPTION', 'SEQUENCE_DUPLICATE'], errors: [] },
    }),
  ]
  const sourceInput = validatedInput({
    validation_status: 'VALIDATED_PARTIAL', lines, requires_review: true,
  })
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL', validated_order_input: sourceInput,
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.MANUAL_REVIEW)
  assert.equal(result.decision.score, 80)
  assert.deepEqual(sourceInput.lines.map((item) => item.quantity), [18, 7])
  assert.equal(result.decision.summary.total_lines, 2)
  assert.ok(result.decision.reasons.includes('DUPLICATE_DESCRIPTION'))
  assert.ok(result.decision.reasons.includes('SEQUENCE_DUPLICATE'))
})

test('one invalid line with valid lines deducts 30 without deleting evidence', async () => {
  const invalid = line({
    validation_position: 2,
    quantity: null,
    raw_quantity: '',
    validation: { valid: false, warnings: [], errors: ['QUANTITY_MISSING'] },
  })
  const sourceInput = validatedInput({
    validation_status: 'VALIDATED_PARTIAL',
    lines: [line(), invalid],
    requires_review: true,
  })
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL', validated_order_input: sourceInput,
  }))
  assert.equal(result.decision.score, 70)
  assert.equal(result.decision.summary.invalid_lines, 1)
  assert.equal(result.decision.summary.total_lines, 2)
  assert.ok(result.decision.reasons.includes('QUANTITY_MISSING'))
  assert.equal(result.decision.review_items[0].validation_position, 2)
})

test('multiple deductions accumulate deterministically and unknown warnings cap at 30', async () => {
  const lines = [
    line({ validation: { valid: true, warnings: ['UNIT_MISSING', 'SOURCE_PROVENANCE_MISSING', 'CUSTOM_A'], errors: [] } }),
    line({ validation_position: 2, validation: { valid: true, warnings: ['UNIT_MISSING', 'SEQUENCE_MISSING', 'CUSTOM_B', 'CUSTOM_C', 'CUSTOM_D'], errors: [] } }),
  ]
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', lines, requires_review: true,
    }),
  }))
  assert.equal(result.decision.score, 10)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.LOW)
})

test('deductions are clamped at zero', async () => {
  const instructions = [1, 2, 3].map((index) => ({
    message_id: `wamid.followup.${index}`, text: 'Unresolved', resolved: false,
  }))
  const invalidLines = [1, 2, 3].map((position) => line({
    validation_position: position,
    validation: { valid: false, warnings: ['UNIT_MISSING'], errors: ['QUANTITY_INVALID'] },
  }))
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', instructions,
      lines: [...invalidLines, line({ validation_position: 4 })], requires_review: true,
    }),
  }))
  assert.equal(result.decision.score, 0)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.NONE)
})

test('ambiguous validation is hard BLOCKED with possible-primary references', async () => {
  const possiblePrimaries = [{ message_id: 'wamid.a', source_type: 'EXCEL' }]
  const { result } = await process(row({
    validated_order_status: 'VALIDATION_BLOCKED_AMBIGUOUS',
    validated_order_input: validatedInput({ lines: [], possible_primaries: possiblePrimaries }),
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.BLOCKED)
  assert.equal(result.decision.score, 0)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.NONE)
  assert.equal(result.decision.requires_manual_review, true)
  assert.deepEqual(result.decision.reasons, ['AMBIGUOUS_INPUT'])
  assert.deepEqual(result.decision.possible_primaries, possiblePrimaries)
})

test('VALIDATION_REJECTED is hard BLOCKED even with good-looking lines', async () => {
  const { result } = await process(row({
    validated_order_status: 'VALIDATION_REJECTED',
    validated_order_input: validatedInput(),
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.BLOCKED)
  assert.equal(result.decision.score, 0)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.NONE)
  assert.ok(result.decision.reasons.includes('VALIDATION_REJECTED'))
})

test('VALIDATION_NO_INPUT is non-technical NO_INPUT', async () => {
  const { result } = await process(row({
    validated_order_status: 'VALIDATION_NO_INPUT',
    validated_order_input: validatedInput({ lines: [] }),
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.NO_INPUT)
  assert.equal(result.decision.score, 0)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.NONE)
  assert.equal(result.decision.requires_manual_review, false)
})

test('VALIDATION_FAILED becomes ASSESSMENT_FAILED without fake confidence', async () => {
  const { result } = await process(row({ validated_order_status: 'VALIDATION_FAILED' }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED)
  assert.equal(result.decision, null)
  assert.equal(result.error, 'Source validated order input is in VALIDATION_FAILED state.')
})

test('VALIDATED_PARTIAL can never become AUTO_READY even with score 100', async () => {
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', requires_review: false,
    }),
  }))
  assert.equal(result.status, ORDER_REVIEW_STATUSES.MANUAL_REVIEW)
  assert.equal(result.decision.score, 100)
  assert.equal(result.decision.confidence_band, CONFIDENCE_BANDS.HIGH)
})

test('validated input and all earlier sources remain byte-equivalent', async () => {
  const sourceRow = row()
  const pool = createPool(sourceRow)
  const before = JSON.stringify({
    validatedStatus: pool.state.row.validated_order_status,
    validated: pool.state.row.validated_order_input,
    unified: pool.state.row.unified_order_input,
    mixed: pool.state.row.media_mixed_context,
    word: pool.state.row.media_word_candidate,
    excel: pool.state.row.media_excel_candidate,
    order: pool.state.row.media_order_candidate,
  })
  await processWhatsAppOrderReviewAssessment({ messageId: sourceRow.message_id, pool })
  const after = JSON.stringify({
    validatedStatus: pool.state.row.validated_order_status,
    validated: pool.state.row.validated_order_input,
    unified: pool.state.row.unified_order_input,
    mixed: pool.state.row.media_mixed_context,
    word: pool.state.row.media_word_candidate,
    excel: pool.state.row.media_excel_candidate,
    order: pool.state.row.media_order_candidate,
  })
  assert.equal(after, before)
  assert.equal(pool.state.row.pi_created, false)
})

test('terminal assessment is idempotent without rewriting or duplicating items', async () => {
  const pool = createPool(row())
  const first = await processWhatsAppOrderReviewAssessment({ messageId: 'wamid.review', pool })
  const updates = pool.state.updates
  const second = await processWhatsAppOrderReviewAssessment({ messageId: 'wamid.review', pool })
  assert.equal(second.duplicate, true)
  assert.equal(pool.state.updates, updates)
  assert.deepEqual(second.decision, first.decision)
})

test('repeated warning reasons are deduplicated while line review items retain context', async () => {
  const lines = [1, 2].map((position) => line({
    sequence: position,
    validation_position: position,
    validation: { valid: true, warnings: ['UNIT_MISSING'], errors: [] },
  }))
  const { result } = await process(row({
    validated_order_status: 'VALIDATED_PARTIAL',
    validated_order_input: validatedInput({
      validation_status: 'VALIDATED_PARTIAL', lines, requires_review: true,
    }),
  }))
  assert.equal(result.decision.reasons.filter((code) => code === 'UNIT_MISSING').length, 1)
  assert.equal(result.decision.review_items.filter((item) => item.code === 'UNIT_MISSING').length, 2)
  assert.deepEqual(
    result.decision.review_items.map((item) => item.validation_position),
    [1, 2],
  )
})

test('PENDING and VALIDATING validation states are skipped', async (context) => {
  for (const status of ['PENDING', 'VALIDATING']) {
    await context.test(status, async () => {
      const { pool, result } = await process(row({ validated_order_status: status }))
      assert.equal(result.skipped, true)
      assert.equal(result.status, ORDER_REVIEW_STATUSES.PENDING)
      assert.equal(pool.state.updates, 0)
    })
  }
})

test('technical persistence failure is contained and source validation stays unchanged', async () => {
  const sourceRow = row()
  const { pool, result } = await process(sourceRow, { failFinalOnce: true })
  assert.equal(result.status, ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED)
  assert.match(result.error, /simulated review persistence failure/)
  assert.equal(pool.state.row.validated_order_status, sourceRow.validated_order_status)
  assert.deepEqual(pool.state.row.validated_order_input, sourceRow.validated_order_input)
  assert.equal(pool.state.row.pi_created, false)
})

test('assessment performs no business, PI, acknowledgement, or outbound query', async () => {
  const { pool, result } = await process(row())
  assert.equal(result.status, ORDER_REVIEW_STATUSES.AUTO_READY)
  assert.equal(pool.state.businessCalls, 0)
})

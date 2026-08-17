import assert from 'node:assert/strict'
import test from 'node:test'
import {
  processWhatsAppUnifiedOrderInput,
  UNIFIED_ORDER_STATUSES,
} from './whatsappUnifiedOrderInputService.js'

const mediaLine = (overrides = {}) => ({
  sequence: 1,
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 12,
  raw_quantity: '12',
  unit: 'NOS',
  source_text: 'HEAD LIGHT ASSY ACE MEGA 12 NOS',
  source_line_number: 4,
  warnings: [],
  ...overrides,
})

const excelLine = (overrides = {}) => ({
  sequence: 1,
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 12,
  raw_quantity: '12',
  unit: 'NOS',
  sheet_name: 'Order',
  source_row: 2,
  source_cells: { description: 'A2', quantity: 'B2', unit: 'C2' },
  warnings: [],
  ...overrides,
})

const wordTableLine = (overrides = {}) => ({
  sequence: 1,
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 12,
  raw_quantity: '12',
  unit: 'NOS',
  source_type: 'TABLE',
  source_table: 2,
  source_row: 3,
  source_cells: { description: 'table2:r3:c1', quantity: 'table2:r3:c2' },
  warnings: [],
  ...overrides,
})

const wordParagraphLine = (overrides = {}) => ({
  sequence: 1,
  raw_description: 'HEAD LIGHT ASSY ACE MEGA',
  quantity: 12,
  raw_quantity: '12',
  unit: 'NOS',
  source_type: 'PARAGRAPH',
  source_paragraph: 7,
  warnings: [],
  ...overrides,
})

const createRow = ({ id, messageId, sender = '917733850017', ...overrides }) => ({
  id,
  message_id: messageId,
  received_at: '2026-08-17T10:00:00.000Z',
  sender_phone: sender,
  message_type: 'document',
  source_type: 'document',
  media_mime_type: '',
  media_order_parse_status: 'PENDING',
  media_order_candidate: null,
  media_excel_status: 'PENDING',
  media_excel_candidate: null,
  media_word_status: 'PENDING',
  media_word_candidate: null,
  media_mixed_status: 'PENDING',
  media_mixed_context: null,
  unified_order_status: 'PENDING',
  unified_order_input: null,
  unified_order_processed_at: null,
  unified_order_error: null,
  pi_created: false,
  ...overrides,
})

const imageRow = (options = {}) => createRow({
  media_order_parse_status: 'PARSED',
  media_order_candidate: { version: 1, lines: [mediaLine()], warnings: [] },
  message_type: 'image',
  source_type: 'image',
  ...options,
})

const pdfRow = (options = {}) => createRow({
  media_mime_type: 'application/pdf',
  media_order_parse_status: 'PARSED',
  media_order_candidate: { version: 1, lines: [mediaLine()], warnings: [] },
  ...options,
})

const excelRow = (options = {}) => createRow({
  media_excel_status: 'EXCEL_PARSED',
  media_excel_candidate: {
    version: 1,
    selected_sheet: 'Order',
    lines: [excelLine()],
    warnings: [],
  },
  ...options,
})

const wordRow = (options = {}) => createRow({
  media_word_status: 'WORD_PARSED',
  media_word_candidate: {
    version: 1,
    extraction_method: 'WORD_TABLE',
    lines: [wordTableLine()],
    warnings: [],
  },
  ...options,
})

const createPool = (initialRows) => {
  const state = {
    businessCalls: 0,
    rows: structuredClone(initialRows),
    updates: 0,
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) return { rowCount: 0, rows: [] }

      if (/SELECT[\s\S]+FROM\s+tran_whatsapp_pi_messages[\s\S]+WHERE message_id = \$1::varchar/i.test(sql)) {
        const row = state.rows.find((candidate) => candidate.message_id === params[0])
        return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /unified_order_status/i.test(sql)) {
        const row = state.rows.find((candidate) => candidate.message_id === params[0])
        if (!row) return { rowCount: 0, rows: [] }
        state.updates += 1
        row.unified_order_status = params[1]
        row.unified_order_input = params[2] ? JSON.parse(params[2]) : null
        row.unified_order_error = params[3]
        if (params[1] !== 'UNIFYING') row.unified_order_processed_at = '2026-08-17T10:05:00.000Z'
        return { rowCount: 1, rows: [structuredClone(row)] }
      }

      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessCalls += 1
        throw new Error('Phase 2.8 must not perform business or outbound operations.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

test('clean image candidate becomes ready with OCR provenance preserved', async () => {
  const pool = createPool([imageRow({ id: 1, messageId: 'wamid.image' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.image', pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(result.input.source_type, 'IMAGE')
  assert.equal(result.input.lines[0].quantity, 12)
  assert.equal(result.input.lines[0].unit, 'NOS')
  assert.equal(result.input.lines[0].source.source_text, 'HEAD LIGHT ASSY ACE MEGA 12 NOS')
  assert.equal(result.input.lines[0].source.source_line_number, 4)
})

test('clean PDF candidate becomes ready with PDF provenance preserved', async () => {
  const pool = createPool([pdfRow({ id: 1, messageId: 'wamid.pdf' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.pdf', pool })
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(result.input.source_type, 'PDF')
  assert.equal(result.input.lines[0].quantity, 12)
  assert.equal(result.input.lines[0].source.message_id, 'wamid.pdf')
})

test('clean Excel candidate preserves sheet, row, and cell provenance', async () => {
  const pool = createPool([excelRow({ id: 1, messageId: 'wamid.excel' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.excel', pool })
  const source = result.input.lines[0].source

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(result.input.source_type, 'EXCEL')
  assert.equal(source.sheet_name, 'Order')
  assert.equal(source.source_row, 2)
  assert.deepEqual(source.source_cells, { description: 'A2', quantity: 'B2', unit: 'C2' })
})

test('clean Word table candidate preserves table provenance', async () => {
  const pool = createPool([wordRow({ id: 1, messageId: 'wamid.word-table' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.word-table', pool })
  const source = result.input.lines[0].source

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(source.source_type, 'TABLE')
  assert.equal(source.source_table, 2)
  assert.equal(source.source_row, 3)
  assert.deepEqual(source.source_cells, { description: 'table2:r3:c1', quantity: 'table2:r3:c2' })
})

test('clean Word paragraph candidate preserves paragraph provenance', async () => {
  const row = wordRow({ id: 1, messageId: 'wamid.word-paragraph' })
  row.media_word_candidate = {
    version: 1,
    extraction_method: 'WORD_PARAGRAPH',
    lines: [wordParagraphLine()],
    warnings: [],
  }
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(result.input.lines[0].source.source_type, 'PARAGRAPH')
  assert.equal(result.input.lines[0].source.source_paragraph, 7)
})

test('standalone Excel with MIXED_NO_CONTEXT still becomes ready', async () => {
  const pool = createPool([excelRow({
    id: 1,
    messageId: 'wamid.excel-no-context',
    media_mixed_status: 'MIXED_NO_CONTEXT',
  })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.excel-no-context', pool })
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
})

test('partial source remains usable and requires review', async () => {
  const pool = createPool([excelRow({
    id: 1,
    messageId: 'wamid.partial',
    media_excel_status: 'EXCEL_PARTIAL',
  })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.partial', pool })
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL)
  assert.equal(result.input.requires_review, true)
  assert.equal(result.input.lines.length, 1)
})

test('no-order-lines source becomes no-input rather than failed', async () => {
  const pool = createPool([createRow({
    id: 1,
    messageId: 'wamid.no-lines',
    media_excel_status: 'EXCEL_NO_ORDER_LINES',
    media_excel_candidate: { version: 1, lines: [], warnings: ['No lines.'] },
  })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.no-lines', pool })
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_NO_INPUT)
  assert.equal(result.error, undefined)
})

test('mixed grouped context maps exact primary and preserves ordinary text separately', async () => {
  const primary = excelRow({ id: 1, messageId: 'wamid.primary' })
  const trigger = createRow({
    id: 2,
    messageId: 'wamid.context',
    media_mixed_status: 'MIXED_GROUPED',
    media_mixed_context: {
      primary_message_id: 'wamid.primary',
      messages: [
        { message_id: 'wamid.primary', role: 'PRIMARY', type: 'EXCEL' },
        { message_id: 'wamid.context', role: 'FOLLOWUP', type: 'TEXT', text: 'Urgent please' },
      ],
      warnings: [],
    },
  })
  const pool = createPool([primary, trigger])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: trigger.message_id, pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL)
  assert.equal(result.input.primary_message_id, 'wamid.primary')
  assert.equal(result.input.lines[0].quantity, 12)
  assert.deepEqual(result.input.instructions, [{
    message_id: 'wamid.context', role: 'FOLLOWUP', text: 'Urgent please', resolved: false,
  }])
})

test('quantity instruction remains unresolved and does not mutate primary quantity', async () => {
  const primary = excelRow({ id: 1, messageId: 'wamid.primary' })
  const trigger = createRow({
    id: 2,
    messageId: 'wamid.qty',
    media_mixed_status: 'MIXED_GROUPED',
    media_mixed_context: {
      primary_message_id: 'wamid.primary',
      messages: [{ message_id: 'wamid.qty', role: 'FOLLOWUP', type: 'TEXT', text: 'Qty 10 each' }],
      warnings: [],
    },
  })
  const pool = createPool([primary, trigger])
  const before = JSON.stringify(pool.state.rows[0].media_excel_candidate)
  const result = await processWhatsAppUnifiedOrderInput({ messageId: trigger.message_id, pool })

  assert.equal(result.input.lines[0].quantity, 12)
  assert.equal(result.input.instructions[0].text, 'Qty 10 each')
  assert.equal(result.input.instructions[0].resolved, false)
  assert.equal(result.input.requires_review, true)
  assert.equal(JSON.stringify(pool.state.rows[0].media_excel_candidate), before)
})

test('mixed ambiguous preserves possible primaries without selecting or merging lines', async () => {
  const row = createRow({
    id: 3,
    messageId: 'wamid.ambiguous',
    media_mixed_status: 'MIXED_AMBIGUOUS',
    media_mixed_context: {
      primary_message_id: null,
      messages: [
        { message_id: 'wamid.a', role: 'POSSIBLE_PRIMARY', type: 'EXCEL' },
        { message_id: 'wamid.b', role: 'POSSIBLE_PRIMARY', type: 'WORD' },
        { message_id: 'wamid.ambiguous', role: 'FOLLOWUP', type: 'TEXT', text: 'Qty 10 each' },
      ],
      warnings: ['More than one eligible media parent is within the association window.'],
    },
  })
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS)
  assert.equal(result.input.primary_message_id, null)
  assert.deepEqual(result.input.possible_primaries.map((item) => item.message_id), ['wamid.a', 'wamid.b'])
  assert.deepEqual(result.input.lines, [])
  assert.equal(result.input.requires_review, true)
})

test('standalone source ambiguity does not choose or merge a source structure', async () => {
  const pool = createPool([createRow({
    id: 1,
    messageId: 'wamid.excel-ambiguous',
    media_excel_status: 'EXCEL_AMBIGUOUS',
    media_excel_candidate: { lines: [], warnings: ['Multiple Excel structures.'] },
  })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.excel-ambiguous', pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS)
  assert.equal(result.input.source_type, 'EXCEL')
  assert.deepEqual(result.input.lines, [])
  assert.equal(result.input.requires_review, true)
})

test('duplicate descriptions remain separate lines without aggregation', async () => {
  const row = excelRow({ id: 1, messageId: 'wamid.duplicates' })
  row.media_excel_candidate.lines = [
    excelLine({ quantity: 15000, raw_quantity: '15000', raw_description: 'SB 103' }),
    excelLine({ sequence: 2, quantity: 1000, raw_quantity: '1000', raw_description: 'SB 103', source_row: 3 }),
  ]
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })

  assert.equal(result.input.lines.length, 2)
  assert.deepEqual(result.input.lines.map((line) => line.quantity), [15000, 1000])
})

test('null quantity is preserved and requires review', async () => {
  const row = excelRow({ id: 1, messageId: 'wamid.null-qty' })
  row.media_excel_candidate.lines = [excelLine({ quantity: null, raw_quantity: '' })]
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })

  assert.equal(result.input.lines[0].quantity, null)
  assert.equal(result.input.requires_review, true)
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL)
})

test('blank unit remains blank', async () => {
  const row = excelRow({ id: 1, messageId: 'wamid.blank-unit' })
  row.media_excel_candidate.lines = [excelLine({ unit: '' })]
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })
  assert.equal(result.input.lines[0].unit, '')
})

test('candidate and line warnings propagate and require review', async () => {
  const row = imageRow({ id: 1, messageId: 'wamid.warnings', media_order_parse_status: 'PARSE_PARTIAL' })
  row.media_order_candidate.warnings = ['Candidate warning.']
  row.media_order_candidate.lines[0].warnings = ['Line warning.']
  const pool = createPool([row])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })

  assert.deepEqual(result.input.warnings, ['Candidate warning.'])
  assert.deepEqual(result.input.lines[0].warnings, ['Line warning.'])
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL)
})

test('successful terminal result is idempotent and is not rewritten', async () => {
  const pool = createPool([excelRow({ id: 1, messageId: 'wamid.idempotent' })])
  const first = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.idempotent', pool })
  const updateCount = pool.state.updates
  const second = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.idempotent', pool })

  assert.equal(first.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(second.duplicate, true)
  assert.equal(pool.state.updates, updateCount)
  assert.deepEqual(second.input, first.input)
})

test('missing mixed primary fails safely without choosing another candidate', async () => {
  const trigger = createRow({
    id: 1,
    messageId: 'wamid.missing-trigger',
    media_mixed_status: 'MIXED_GROUPED',
    media_mixed_context: { primary_message_id: 'wamid.missing', messages: [], warnings: [] },
  })
  const pool = createPool([trigger, excelRow({ id: 2, messageId: 'wamid.other' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: trigger.message_id, pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_FAILED)
  assert.match(result.error, /was not found/)
  assert.equal(result.input, null)
})

test('wrong-sender mixed primary is rejected', async () => {
  const primary = excelRow({ id: 1, messageId: 'wamid.primary', sender: 'A' })
  const trigger = createRow({
    id: 2,
    messageId: 'wamid.trigger',
    sender: 'B',
    media_mixed_status: 'MIXED_GROUPED',
    media_mixed_context: { primary_message_id: 'wamid.primary', messages: [], warnings: [] },
  })
  const pool = createPool([primary, trigger])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: trigger.message_id, pool })

  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_FAILED)
  assert.match(result.error, /sender does not match/)
})

test('all source candidates and mixed context remain byte-equivalent', async () => {
  const row = createRow({
    id: 1,
    messageId: 'wamid.immutable',
    media_order_parse_status: 'PARSED',
    media_order_candidate: { version: 1, lines: [mediaLine()], warnings: [] },
    media_excel_status: 'EXCEL_PARSED',
    media_excel_candidate: { version: 1, lines: [excelLine()], warnings: [] },
    media_word_status: 'WORD_PARSED',
    media_word_candidate: { version: 1, lines: [wordTableLine()], warnings: [] },
    media_mixed_status: 'MIXED_NO_CONTEXT',
    media_mixed_context: { version: 1, messages: [], warnings: [] },
  })
  const pool = createPool([row])
  const before = JSON.stringify({
    order: pool.state.rows[0].media_order_candidate,
    excel: pool.state.rows[0].media_excel_candidate,
    word: pool.state.rows[0].media_word_candidate,
    mixed: pool.state.rows[0].media_mixed_context,
  })
  await processWhatsAppUnifiedOrderInput({ messageId: row.message_id, pool })
  const after = JSON.stringify({
    order: pool.state.rows[0].media_order_candidate,
    excel: pool.state.rows[0].media_excel_candidate,
    word: pool.state.rows[0].media_word_candidate,
    mixed: pool.state.rows[0].media_mixed_context,
  })

  assert.equal(after, before)
  assert.equal(pool.state.rows[0].pi_created, false)
})

test('unification performs no business lookup, PI, acknowledgement, or outbound call', async () => {
  const pool = createPool([excelRow({ id: 1, messageId: 'wamid.isolated' })])
  const result = await processWhatsAppUnifiedOrderInput({ messageId: 'wamid.isolated', pool })
  assert.equal(result.status, UNIFIED_ORDER_STATUSES.UNIFIED_READY)
  assert.equal(pool.state.businessCalls, 0)
})

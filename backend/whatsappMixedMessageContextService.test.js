import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIXED_MESSAGE_ASSOCIATION_WINDOW_MINUTES,
  MIXED_MESSAGE_STATUSES,
  processWhatsAppMixedMessageContext,
} from './whatsappMixedMessageContextService.js'

const BASE_TIME = Date.parse('2026-08-17T10:00:00.000Z')

const createRow = ({
  caption = '',
  id,
  messageId,
  minutes = 0,
  sender = '917733850017',
  text = '',
  type = 'text',
  ...overrides
}) => ({
  id,
  message_id: messageId,
  received_at: new Date(BASE_TIME + minutes * 60_000).toISOString(),
  sender_phone: sender,
  message_type: type,
  source_type: type,
  media_mime_type: '',
  caption,
  message_text: text,
  raw_text: text,
  media_order_parse_status: 'PENDING',
  media_order_candidate: null,
  media_excel_status: 'PENDING',
  media_excel_candidate: null,
  media_word_status: 'PENDING',
  media_word_candidate: null,
  media_mixed_status: 'PENDING',
  media_mixed_context: null,
  media_mixed_processed_at: null,
  media_mixed_error: null,
  pi_created: false,
  ...overrides,
})

const imageRow = (options = {}) => createRow({
  type: 'image',
  media_order_parse_status: 'PARSED',
  media_order_candidate: { lines: [{ description: 'HEAD LAMP', quantity: 12 }] },
  ...options,
})

const pdfRow = (options = {}) => createRow({
  type: 'document',
  media_mime_type: 'application/pdf',
  media_order_parse_status: 'PARSED',
  media_order_candidate: { lines: [{ description: 'HEAD LAMP', quantity: 12 }] },
  ...options,
})

const excelRow = (options = {}) => createRow({
  type: 'document',
  media_mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  media_excel_status: 'EXCEL_PARSED',
  media_excel_candidate: { lines: [{ description: 'HEAD LAMP', quantity: 12 }] },
  ...options,
})

const wordRow = (options = {}) => createRow({
  type: 'document',
  media_mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  media_word_status: 'WORD_PARSED',
  media_word_candidate: { lines: [{ description: 'HEAD LAMP', quantity: 12 }] },
  ...options,
})

const createPool = (initialRows) => {
  const state = {
    businessAttempts: 0,
    rows: structuredClone(initialRows),
    updates: 0,
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) return { rowCount: 0, rows: [] }

      if (/SELECT[\s\S]+WHERE message_id = \$1::varchar[\s\S]+LIMIT 1/i.test(sql)) {
        const row = state.rows.find((candidate) => candidate.message_id === params[0])
        return { rowCount: row ? 1 : 0, rows: row ? [structuredClone(row)] : [] }
      }

      if (/SELECT[\s\S]+WHERE nearby\.sender_phone = \$1::varchar/i.test(sql)) {
        const center = new Date(params[1]).getTime()
        const windowMs = Number(params[2]) * 60_000
        const excludesConsumedTexts = /NOT EXISTS[\s\S]+media_mixed_status IN \('MIXED_GROUPED', 'MIXED_PARTIAL'\)/i.test(sql)
        const rows = state.rows
          .filter((row) => row.sender_phone === params[0])
          .filter((row) => row.message_id !== params[3])
          .filter((row) => Math.abs(new Date(row.received_at).getTime() - center) <= windowMs)
          .filter((row) => {
            if (!excludesConsumedTexts || row.source_type !== 'text') return true
            return !state.rows.some((contextRow) =>
              contextRow.sender_phone === row.sender_phone
              && ['MIXED_GROUPED', 'MIXED_PARTIAL'].includes(contextRow.media_mixed_status)
              && contextRow.media_mixed_context?.message_ids?.includes(row.message_id))
          })
          .sort((left, right) => new Date(left.received_at) - new Date(right.received_at) || left.id - right.id)
        return { rowCount: rows.length, rows: structuredClone(rows) }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /media_mixed_status/i.test(sql)) {
        const row = state.rows.find((candidate) => candidate.message_id === params[0])
        if (!row) return { rowCount: 0, rows: [] }
        state.updates += 1
        row.media_mixed_status = params[1]
        row.media_mixed_context = params[2] ? JSON.parse(params[2]) : null
        row.media_mixed_error = params[3]
        if (params[1] !== 'MIXED_PROCESSING') row.media_mixed_processed_at = '2026-08-17T10:10:00.000Z'
        return { rowCount: 1, rows: [structuredClone(row)] }
      }

      if (/master_customer|master_products|master_pi_rmkt|tran_pi_rmkt|trading_rate|whatsapp_send_log/i.test(sql)) {
        state.businessAttempts += 1
        throw new Error('Phase 2.7 must not access business processing.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

test('uses a fixed ten-minute association window', () => {
  assert.equal(MIXED_MESSAGE_ASSOCIATION_WINDOW_MINUTES, 10)
})

test('image plus text after groups both message IDs', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.image', minutes: 0 }),
    createRow({ id: 2, messageId: 'wamid.text', minutes: 2, text: 'Urgent order' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.text', pool })

  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(result.context.context_type, 'MEDIA_PLUS_TEXT_AFTER')
  assert.deepEqual(result.context.message_ids, ['wamid.image', 'wamid.text'])
  assert.equal(result.context.sender, '917733850017')
  assert.equal(pool.state.businessAttempts, 0)
})

test('quantity follow-up requires review and leaves image candidate byte-equivalent', async () => {
  const rows = [
    imageRow({ id: 1, messageId: 'wamid.image' }),
    createRow({ id: 2, messageId: 'wamid.qty', minutes: 1, text: 'Qty 10 each' }),
  ]
  const pool = createPool(rows)
  const before = JSON.stringify(pool.state.rows[0].media_order_candidate)
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.qty', pool })

  assert.equal(result.context.context_type, 'MEDIA_PLUS_FOLLOWUP')
  assert.equal(result.context.requires_review, true)
  assert.equal(result.context.messages[1].text, 'Qty 10 each')
  assert.equal(JSON.stringify(pool.state.rows[0].media_order_candidate), before)
  assert.equal(pool.state.rows[1].pi_created, false)
})

test('PDF caption is preserved without changing its candidate', async () => {
  const pool = createPool([pdfRow({ caption: 'Urgent order', id: 1, messageId: 'wamid.pdf' })])
  const before = structuredClone(pool.state.rows[0].media_order_candidate)
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.pdf', pool })

  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(result.context.context_type, 'MEDIA_WITH_CAPTION')
  assert.equal(result.context.messages[0].caption, 'Urgent order')
  assert.deepEqual(pool.state.rows[0].media_order_candidate, before)
})

test('Excel plus preceding text uses chronological order and preserves Excel candidate', async () => {
  const pool = createPool([
    createRow({ id: 8, messageId: 'wamid.before', text: 'Please process attached order' }),
    excelRow({ id: 3, messageId: 'wamid.excel', minutes: 1 }),
  ])
  const before = structuredClone(pool.state.rows[1].media_excel_candidate)
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.excel', pool })

  assert.equal(result.context.context_type, 'MEDIA_PLUS_TEXT_BEFORE')
  assert.deepEqual(result.context.message_ids, ['wamid.before', 'wamid.excel'])
  assert.deepEqual(pool.state.rows[1].media_excel_candidate, before)
})

test('Word plus following text groups and preserves Word candidate', async () => {
  const pool = createPool([
    wordRow({ id: 1, messageId: 'wamid.word' }),
    createRow({ id: 2, messageId: 'wamid.word-text', minutes: 1, text: 'Urgent please' }),
  ])
  const before = structuredClone(pool.state.rows[0].media_word_candidate)
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.word-text', pool })

  assert.equal(result.context.candidate_source, 'media_word_candidate')
  assert.equal(result.context.media_type, 'WORD')
  assert.deepEqual(pool.state.rows[0].media_word_candidate, before)
})

test('media completion can safely associate one text that arrived while the candidate was processing', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.delayed-media' }),
    createRow({ id: 2, messageId: 'wamid.early-followup', minutes: 1, text: 'Qty 10 each' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.delayed-media', pool })

  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(result.context.context_type, 'MEDIA_PLUS_FOLLOWUP')
  assert.deepEqual(result.context.message_ids, ['wamid.delayed-media', 'wamid.early-followup'])
})

test('a consumed follow-up cannot become text-before context for later media', async () => {
  const pool = createPool([
    excelRow({ id: 1, messageId: 'wamid.media-a' }),
    createRow({ id: 2, messageId: 'wamid.text-x', minutes: 1, text: 'Qty 10 each' }),
    excelRow({ id: 3, messageId: 'wamid.media-b', minutes: 5 }),
  ])

  const original = await processWhatsAppMixedMessageContext({ messageId: 'wamid.text-x', pool })
  const laterMedia = await processWhatsAppMixedMessageContext({ messageId: 'wamid.media-b', pool })

  assert.equal(original.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.deepEqual(original.context.message_ids, ['wamid.media-a', 'wamid.text-x'])
  assert.equal(laterMedia.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(laterMedia.context, null)
})

test('a consumed text cannot be reused by multiple later media messages', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.media-a' }),
    createRow({ id: 2, messageId: 'wamid.text-x', minutes: 1, text: 'Qty 10 each' }),
    excelRow({ id: 3, messageId: 'wamid.media-b', minutes: 5 }),
    wordRow({ id: 4, messageId: 'wamid.media-c', minutes: 6 }),
  ])

  await processWhatsAppMixedMessageContext({ messageId: 'wamid.text-x', pool })
  const mediaB = await processWhatsAppMixedMessageContext({ messageId: 'wamid.media-b', pool })
  const mediaC = await processWhatsAppMixedMessageContext({ messageId: 'wamid.media-c', pool })

  assert.equal(mediaB.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(mediaC.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(pool.state.rows[1].media_mixed_context.context_type, 'MEDIA_PLUS_FOLLOWUP')
})

test('consumed-text detection remains scoped to the same sender', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.sender-a-media', sender: 'A' }),
    createRow({ id: 2, messageId: 'wamid.sender-a-text', minutes: 1, sender: 'A', text: 'Qty 10 each' }),
    createRow({ id: 3, messageId: 'wamid.sender-b-text', minutes: 2, sender: 'B', text: 'Please process attached order' }),
    excelRow({ id: 4, messageId: 'wamid.sender-b-media', minutes: 3, sender: 'B' }),
  ])

  await processWhatsAppMixedMessageContext({ messageId: 'wamid.sender-a-text', pool })
  const senderB = await processWhatsAppMixedMessageContext({ messageId: 'wamid.sender-b-media', pool })

  assert.equal(senderB.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(senderB.context.context_type, 'MEDIA_PLUS_TEXT_BEFORE')
  assert.deepEqual(senderB.context.message_ids, ['wamid.sender-b-text', 'wamid.sender-b-media'])
})

test('an ambiguous context does not consume its text or possible media parents', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.media-a' }),
    excelRow({ id: 2, messageId: 'wamid.media-b', minutes: 1 }),
    createRow({ id: 3, messageId: 'wamid.text-x', minutes: 2, text: 'Qty 10 each' }),
    wordRow({ id: 4, messageId: 'wamid.media-c', minutes: 4 }),
  ])

  const ambiguous = await processWhatsAppMixedMessageContext({ messageId: 'wamid.text-x', pool })
  const laterMedia = await processWhatsAppMixedMessageContext({ messageId: 'wamid.media-c', pool })

  assert.equal(ambiguous.status, MIXED_MESSAGE_STATUSES.MIXED_AMBIGUOUS)
  assert.equal(ambiguous.context.primary_message_id, null)
  assert.equal(laterMedia.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(laterMedia.context.context_type, 'MEDIA_PLUS_TEXT_BEFORE')
  assert.equal(pool.state.rows[0].media_mixed_status, 'PENDING')
  assert.equal(pool.state.rows[1].media_mixed_status, 'PENDING')
})

test('a no-context text remains available for a later media association', async () => {
  const pool = createPool([
    createRow({ id: 1, messageId: 'wamid.text-x', text: 'Please process attached order' }),
    excelRow({ id: 2, messageId: 'wamid.media-a', minutes: 1 }),
  ])

  const noContext = await processWhatsAppMixedMessageContext({ messageId: 'wamid.text-x', pool })
  const media = await processWhatsAppMixedMessageContext({ messageId: 'wamid.media-a', pool })

  assert.equal(noContext.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(media.status, MIXED_MESSAGE_STATUSES.MIXED_GROUPED)
  assert.equal(media.context.context_type, 'MEDIA_PLUS_TEXT_BEFORE')
})

test('different senders never associate', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.sender-a', sender: 'A' }),
    createRow({ id: 2, messageId: 'wamid.sender-b', minutes: 1, sender: 'B', text: 'Qty 10 each' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.sender-b', pool })
  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(result.context, null)
})

test('messages outside the window do not associate', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.old' }),
    createRow({ id: 2, messageId: 'wamid.late', minutes: 11, text: 'Qty 10 each' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.late', pool })
  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
})

test('two eligible parents are ambiguous and neither candidate changes', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.a' }),
    imageRow({ id: 2, messageId: 'wamid.b', minutes: 1 }),
    createRow({ id: 3, messageId: 'wamid.followup', minutes: 2, text: 'Qty 10 each' }),
  ])
  const candidatesBefore = pool.state.rows.slice(0, 2).map((row) => structuredClone(row.media_order_candidate))
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.followup', pool })

  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_AMBIGUOUS)
  assert.equal(result.context.primary_message_id, null)
  assert.deepEqual(pool.state.rows.slice(0, 2).map((row) => row.media_order_candidate), candidatesBefore)
})

test('follow-up without a parent is a valid no-context result', async () => {
  const pool = createPool([createRow({ id: 1, messageId: 'wamid.none', text: 'Qty 20' })])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.none', pool })
  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
  assert.equal(result.error, undefined)
})

for (const [label, text] of [
  ['CONFIRM', 'CONFIRM AML-0028'],
  ['CHANGE', 'CHANGE AML-0028 please use 20 nos'],
]) {
  test(`${label} command is excluded without changing mixed status`, async () => {
    const pool = createPool([
      imageRow({ id: 1, messageId: `wamid.${label}.media` }),
      createRow({ id: 2, messageId: `wamid.${label}`, minutes: 1, text }),
    ])
    const result = await processWhatsAppMixedMessageContext({ messageId: `wamid.${label}`, pool })

    assert.equal(result.commandExcluded, true)
    assert.equal(result.status, MIXED_MESSAGE_STATUSES.PENDING)
    assert.equal(pool.state.updates, 0)
  })
}

test('duplicate wamid returns the stored context without appending membership', async () => {
  const pool = createPool([
    imageRow({ id: 1, messageId: 'wamid.image' }),
    createRow({ id: 2, messageId: 'wamid.duplicate', minutes: 1, text: 'Urgent order' }),
  ])
  const first = await processWhatsAppMixedMessageContext({ messageId: 'wamid.duplicate', pool })
  const updateCount = pool.state.updates
  const second = await processWhatsAppMixedMessageContext({ messageId: 'wamid.duplicate', pool })

  assert.equal(second.duplicate, true)
  assert.equal(pool.state.updates, updateCount)
  assert.deepEqual(second.context.message_ids, first.context.message_ids)
})

test('identical timestamps use database id as deterministic ordering tie-breaker', async () => {
  const pool = createPool([
    createRow({ id: 10, messageId: 'wamid.text', text: 'Please process attached order' }),
    excelRow({ id: 20, messageId: 'wamid.excel' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.excel', pool })
  assert.deepEqual(result.context.message_ids, ['wamid.text', 'wamid.excel'])
})

test('an in-progress or failed media row is not an eligible parent', async () => {
  const pool = createPool([
    imageRow({
      id: 1,
      messageId: 'wamid.processing',
      media_order_parse_status: 'PARSING',
    }),
    createRow({ id: 2, messageId: 'wamid.text', minutes: 1, text: 'Qty 10 each' }),
  ])
  const result = await processWhatsAppMixedMessageContext({ messageId: 'wamid.text', pool })
  assert.equal(result.status, MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT)
})

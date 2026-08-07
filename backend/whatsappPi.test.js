import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import {
  createWhatsappPIRouter,
  getCustomerConfirmationProcessingStatus,
  parseWhatsappPIItemLine,
  parseWhatsappPIText,
  processExistingCustomerConfirmationRow,
} from './whatsappPi.js'

const createExistingConfirmationPool = () => {
  const state = {
    incoming: {
      id: 100,
      message_id: 'wamid.confirm-100',
      sender_phone: '917733850017',
      message_type: 'text',
      source_type: 'text',
      message_text: 'CONFIRM AML-0025',
      raw_text: 'CONFIRM AML-0025',
      parse_status: 'RECEIVED',
      processing_status: 'RECEIVED',
      reply_status: 'NOT_SENT',
      customer_confirmation_status: 'PENDING',
    },
    masterUpdates: 0,
    pi: {
      basic_value: 1000,
      cd_amt: 0,
      cgst_amt: 0,
      cgst_per: 0,
      close_yn: 'N',
      comp_code: 1,
      company_legal_name: 'Autolite Manufacturing Limited',
      company_name: 'Autolite Manufacturing Limited',
      destination: 'Navagam',
      grand_total: 1000,
      igst_amt: 0,
      igst_per: 0,
      net_taxable_value: 1000,
      pcust_name: 'Jalaram Enterprise',
      pi_no: 25,
      pi_series: 'AML-',
      po_no: 'some-other-reference',
      round_off: 0,
      scheme_discount: 0,
      sgst_amt: 0,
      sgst_per: 0,
      spdis_amt: 0,
      tod_amt: 0,
    },
    sendLogs: [],
    source: {
      id: 95,
      message_id: 'wamid.original-25',
      sender_phone: '917733850017',
      draft_pi_no: 'AML-0025',
      acknowledgement_status: 'SENT',
      pi_summary_status: 'SENT',
      pi_summary_meta_message_id: 'wamid.summary-25',
      customer_confirmation_status: 'AWAITING_CONFIRMATION',
    },
  }

  return {
    state,
    async query(sql, params = []) {
      if (/CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && params.length === 0) {
        return { rowCount: 0, rows: [] }
      }

      if (/INSERT INTO\s+tran_whatsapp_webhook_events/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 1,
              received_at: new Date().toISOString(),
              method: params[0],
              url: params[1],
              remote_address: params[2],
              user_agent: params[3],
              query: params[4] ? JSON.parse(params[4]) : {},
              body: params[5] ? JSON.parse(params[5]) : null,
              message_count: params[6],
              response_status: params[7],
              note: params[8],
            },
          ],
        }
      }

      if (/INSERT INTO\s+tran_whatsapp_pi_messages/i.test(sql)) {
        state.incoming = {
          ...state.incoming,
          id: 100,
          message_id: params[0],
          received_at: params[1],
          sender_name: params[2],
          sender_phone: params[3],
          message_type: params[4],
          media_id: params[5],
          media_type: params[6],
          media_mime_type: params[7],
          media_sha256: params[8],
          media_voice: params[9],
          media_animated: params[10],
          file_name: params[11],
          caption: params[12],
          source_type: params[13],
          message_text: params[14],
          raw_text: params[14],
          raw_payload: params[15] ? JSON.parse(params[15]) : null,
          import_status: 'received',
          parse_status: 'RECEIVED',
          parse_warnings: [],
          parse_errors: [],
          pi_created: false,
          processing_status: 'RECEIVED',
        }

        return { rowCount: 1, rows: [state.incoming] }
      }

      if (/FROM\s+tran_whatsapp_pi_messages/i.test(sql) && /WHERE\s+id\s*=\s*\$1::bigint/i.test(sql)) {
        return { rowCount: 1, rows: [state.incoming] }
      }

      if (/FROM\s+master_pi_rmkt\s+pi/i.test(sql)) {
        return { rowCount: 1, rows: [state.pi] }
      }

      if (/FROM\s+tran_pi_rmkt\s+tran/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              amount: 1000,
              product_code: 'SB102',
              product_description: 'SB 102 H4 P43T P LHT E',
              product_unit: 'NOS',
              quantity: 1,
              rate: 1000,
              rbasic: 1000,
            },
          ],
        }
      }

      if (/SELECT\s+id,\s*message_id,\s*sender_phone/i.test(sql)) {
        return { rowCount: 1, rows: [state.source] }
      }

      if (/UPDATE\s+master_pi_rmkt/i.test(sql)) {
        state.masterUpdates += 1
        return { rowCount: 1, rows: [] }
      }

      if (
        /UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) &&
        /customer_confirmation_message_id\s*=\s*\$3/i.test(sql)
      ) {
        state.source.customer_confirmation_status = params[1]
        state.source.customer_confirmation_message_id = params[2]
        state.source.reply_status = params[1]
        return { rowCount: 1, rows: [] }
      }

      if (
        /UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) &&
        /parse_status\s*=\s*\$5/i.test(sql)
      ) {
        state.incoming = {
          ...state.incoming,
          customer_confirmation_status: params[20] ?? state.incoming.customer_confirmation_status,
          draft_pi_no: params[15] ?? state.incoming.draft_pi_no,
          parse_status: params[4],
          processing_status: params[17],
          reply_status: params[18],
        }

        return { rowCount: 1, rows: [state.incoming] }
      }

      if (/INSERT INTO\s+tran_whatsapp_pi_message_events/i.test(sql)) {
        return { rowCount: 1, rows: [] }
      }

      if (/SELECT\s+send_log_id,\s+meta_message_id/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/INSERT INTO\s+tran_whatsapp_send_log/i.test(sql)) {
        const sendLog = {
          attempt_status: params[13],
          message_purpose: params[5],
          meta_message_id: '',
          pi_number: params[2],
          send_log_id: state.sendLogs.length + 1,
          source_whatsapp_message_id: params[1],
        }
        state.sendLogs.push(sendLog)
        return { rowCount: 1, rows: [{ send_log_id: sendLog.send_log_id }] }
      }

      if (/UPDATE\s+tran_whatsapp_send_log/i.test(sql)) {
        const sendLog = state.sendLogs.find((log) => log.send_log_id === Number(params[0]))
        if (sendLog) {
          sendLog.attempt_status = params[1] ?? sendLog.attempt_status
          sendLog.meta_message_id = params[6] || sendLog.meta_message_id
        }
        return { rowCount: 1, rows: [] }
      }

      throw new Error(`Unexpected SQL in existing confirmation test: ${sql}`)
    },
  }
}

const createMediaCapturePool = () => {
  const state = {
    captureUpdates: 0,
    messageRows: [],
    piCreationAttempts: 0,
  }

  return {
    state,
    async query(sql, params = []) {
      if (/CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/INSERT INTO\s+tran_whatsapp_webhook_events/i.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 1,
              received_at: new Date().toISOString(),
              method: params[0],
              url: params[1],
              remote_address: params[2],
              user_agent: params[3],
              query: params[4] ? JSON.parse(params[4]) : {},
              body: params[5] ? JSON.parse(params[5]) : null,
              message_count: params[6],
              response_status: params[7],
              note: params[8],
            },
          ],
        }
      }

      if (/INSERT INTO\s+tran_whatsapp_pi_messages/i.test(sql)) {
        const row = {
          id: state.messageRows.length + 1,
          message_id: params[0],
          received_at: params[1],
          sender_name: params[2],
          sender_phone: params[3],
          message_type: params[4],
          media_id: params[5],
          media_type: params[6],
          media_mime_type: params[7],
          media_sha256: params[8],
          media_voice: params[9],
          media_animated: params[10],
          file_name: params[11],
          caption: params[12],
          source_type: params[13],
          message_text: params[14],
          raw_text: params[14],
          raw_payload: params[15] ? JSON.parse(params[15]) : null,
          import_status: 'received',
          parse_errors: [],
          parse_status: 'RECEIVED',
          parse_warnings: [],
          pi_created: false,
          processing_status: 'RECEIVED',
        }

        if (state.messageRows.some((messageRow) => messageRow.message_id === row.message_id)) {
          return { rowCount: 0, rows: [] }
        }

        state.messageRows.push(row)
        return { rowCount: 1, rows: [row] }
      }

      if (/FROM\s+tran_whatsapp_pi_messages/i.test(sql) && /WHERE\s+message_id\s*=\s*\$1/i.test(sql)) {
        const row = state.messageRows.find((messageRow) => messageRow.message_id === params[0])
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /media_capture_status/i.test(sql)) {
        state.captureUpdates += 1
        const row = state.messageRows.find((messageRow) => messageRow.message_id === params[0])

        if (!row) {
          return { rowCount: 0, rows: [] }
        }

        Object.assign(row, {
          media_id: params[1] || row.media_id,
          media_type: params[2] || row.media_type,
          media_mime_type: params[3] || row.media_mime_type,
          media_sha256: params[4] || row.media_sha256,
          media_voice: params[5],
          media_animated: params[6],
          file_name: params[7] || row.file_name,
          caption: params[8] ?? row.caption,
          message_text: params[8] ?? row.message_text,
          raw_payload: params[9] ? JSON.parse(params[9]) : row.raw_payload,
          processing_status: params[10],
          parse_status: params[10],
          parse_warnings: JSON.parse(params[11]),
          parse_errors: JSON.parse(params[12]),
          error_details: JSON.parse(params[13]),
          media_capture_status: params[14],
          media_capture_error: params[15] || null,
          pi_created: false,
        })

        return { rowCount: 1, rows: [row] }
      }

      if (/INSERT INTO\s+master_pi_rmkt|INSERT INTO\s+tran_pi_rmkt/i.test(sql)) {
        state.piCreationAttempts += 1
        throw new Error('Media webhook must not create a PI.')
      }

      throw new Error(`Unexpected SQL in media capture test: ${sql}`)
    },
  }
}

test('parses a WhatsApp PI product line', () => {
  assert.deepEqual(parseWhatsappPIItemLine('100/90 - 12V - PU37 - 500 NOS'), {
    size: '100/90',
    voltage: '12V',
    model: 'PU37',
    quantity: 500,
    unit: 'NOS',
    rawLine: '100/90 - 12V - PU37 - 500 NOS',
  })
})

test('parses the sample WhatsApp PI message', () => {
  const parsed = parseWhatsappPIText(`Date: 20/06/2026
M/s Milan Automobiles
Belgaum
100/90 - 12V - PU37 - 500 NOS
130/100 - 12V PU37 - 200 NOS
130/100 - 24V PU37 - 100 NOS`)

  assert.equal(parsed.date, '2026-06-20')
  assert.equal(parsed.partyName, 'Milan Automobiles')
  assert.equal(parsed.place, 'Belgaum')
  assert.deepEqual(
    parsed.items.map(({ size, voltage, model, quantity, unit }) => ({
      size,
      voltage,
      model,
      quantity,
      unit,
    })),
    [
      { size: '100/90', voltage: '12V', model: 'PU37', quantity: 500, unit: 'NOS' },
      { size: '130/100', voltage: '12V', model: 'PU37', quantity: 200, unit: 'NOS' },
      { size: '130/100', voltage: '24V', model: 'PU37', quantity: 100, unit: 'NOS' },
    ],
  )
})

test('parses OCR product-code quantity lines', () => {
  const examples = [
    'SB 102 H4 P43t P LHT E - 1000 Nos',
    'SB 102 H4 P43t P LHT E 1000 Nos',
    'SB102 H4 P43T P LHT E - 1000',
    'SB-102 H4 P43T P LHT E : 1000 PCS',
    'SB102 LEFT 1000',
    'SB102 LH x 1000',
    'SB102 — 1,000 Nos.',
  ]

  for (const example of examples) {
    const item = parseWhatsappPIItemLine(example)

    assert.equal(item?.productCode, 'SB102')
    assert.equal(item?.quantity, 1000)
    assert.ok(item?.unit === 'NOS' || item?.unit === 'PCS')
  }
})

test('parses the requested OCR-style order sample', () => {
  const parsed = parseWhatsappPIText(`Party: Jalaram Enterprises
Place: Navagam
Date: 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`)

  assert.equal(parsed.partyName, 'Jalaram Enterprises')
  assert.equal(parsed.place, 'Navagam')
  assert.equal(parsed.date, '2026-07-22')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].quantity, 1000)
  assert.equal(parsed.items[0].unit, 'NOS')
})

test('marks handled customer confirmation rows as processed', () => {
  assert.equal(
    getCustomerConfirmationProcessingStatus('CONFIRMED'),
    'CUSTOMER_CONFIRMATION_PROCESSED',
  )
  assert.equal(
    getCustomerConfirmationProcessingStatus('CHANGE_REQUESTED'),
    'CUSTOMER_CONFIRMATION_PROCESSED',
  )
  assert.equal(
    getCustomerConfirmationProcessingStatus('MANUAL_REVIEW'),
    'CUSTOMER_REPLY_MANUAL_REVIEW',
  )
})

test('processes an existing saved confirmation row before order parsing', async () => {
  const pool = createExistingConfirmationPool()
  let fetchCalls = 0
  const result = await processExistingCustomerConfirmationRow({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'test-token',
      WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017',
      WHATSAPP_AUTO_ACK_MODE: 'development',
      WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
    },
    fetch: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.confirmation-ack-100' }],
      }), { status: 200 })
    },
    pool,
    tableNames: {},
  }, {
    rowId: 100,
  })

  assert.equal(result.handled, true)
  assert.equal(result.status, 'CONFIRMED')
  assert.equal(result.piNumber, 'AML-0025')
  assert.equal(pool.state.source.customer_confirmation_status, 'CONFIRMED')
  assert.equal(pool.state.source.customer_confirmation_message_id, 'wamid.confirm-100')
  assert.equal(pool.state.incoming.parse_status, 'CONFIRMATION_COMMAND')
  assert.equal(pool.state.incoming.processing_status, 'CUSTOMER_CONFIRMATION_PROCESSED')
  assert.equal(pool.state.incoming.draft_pi_no, 'AML-0025')
  assert.equal(pool.state.incoming.customer_confirmation_status, 'CONFIRMED')
  assert.equal(pool.state.masterUpdates, 0)
  assert.equal(pool.state.pi.close_yn, 'N')
  assert.equal(pool.state.sendLogs[0].message_purpose, 'CUSTOMER_CONFIRMATION_ACK')
  assert.equal(pool.state.sendLogs[0].source_whatsapp_message_id, 'wamid.confirm-100')
  assert.equal(pool.state.sendLogs[0].meta_message_id, 'wamid.confirmation-ack-100')
  assert.equal(fetchCalls, 1)
})

test('live webhook routes CONFIRM command before the order parser', async (t) => {
  const pool = createExistingConfirmationPool()
  let fetchCalls = 0
  const app = express()

  app.use(express.json())
  app.use('/api/whatsapp-pi', createWhatsappPIRouter({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'test-token',
      WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017',
      WHATSAPP_AUTO_ACK_MODE: 'development',
      WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
    },
    fetch: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.confirmation-ack-webhook' }],
      }), { status: 200 })
    },
    pool,
    tableNames: {},
  }))

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => server.close())

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const response = await fetch(`http://127.0.0.1:${port}/api/whatsapp-pi/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [
                  {
                    profile: { name: 'Dileep' },
                    wa_id: '917733850017',
                  },
                ],
                messages: [
                  {
                    from: '917733850017',
                    id: 'wamid.confirm-webhook-100',
                    timestamp: '1785997800',
                    text: { body: 'CONFIRM AML-0025' },
                    type: 'text',
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.parse_status, 'CONFIRMATION_COMMAND')
  assert.equal(body.processing, false)
  assert.equal(pool.state.source.customer_confirmation_status, 'CONFIRMED')
  assert.equal(pool.state.source.customer_confirmation_message_id, 'wamid.confirm-webhook-100')
  assert.equal(pool.state.incoming.parse_status, 'CONFIRMATION_COMMAND')
  assert.equal(pool.state.incoming.processing_status, 'CUSTOMER_CONFIRMATION_PROCESSED')
  assert.equal(pool.state.incoming.draft_pi_no, 'AML-0025')
  assert.equal(pool.state.masterUpdates, 0)
  assert.equal(pool.state.pi.close_yn, 'N')
  assert.equal(pool.state.sendLogs[0].message_purpose, 'CUSTOMER_CONFIRMATION_ACK')
  assert.equal(pool.state.sendLogs[0].source_whatsapp_message_id, 'wamid.confirm-webhook-100')
  assert.equal(pool.state.sendLogs[0].meta_message_id, 'wamid.confirmation-ack-webhook')
  assert.equal(fetchCalls, 1)
})

test('live webhook captures image media without download, OCR, parser, or PI creation', async (t) => {
  const pool = createMediaCapturePool()
  let fetchCalls = 0
  const app = express()

  app.use(express.json())
  app.use('/api/whatsapp-pi', createWhatsappPIRouter({
    fetch: async () => {
      fetchCalls += 1
      throw new Error('Media capture must not call Meta or media download APIs.')
    },
    pool,
    tableNames: {},
  }))

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => server.close())

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [
                {
                  profile: { name: 'Media Customer' },
                  wa_id: '917733850017',
                },
              ],
              messages: [
                {
                  from: '917733850017',
                  id: 'wamid.media-image-1',
                  image: {
                    caption: 'Please check this image',
                    id: 'meta-image-id-1',
                    mime_type: 'image/jpeg',
                    sha256: 'image-sha',
                  },
                  timestamp: '1785997800',
                  type: 'image',
                },
              ],
            },
          },
        ],
      },
    ],
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/whatsapp-pi/webhook`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const body = await response.json()
  const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/whatsapp-pi/webhook`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const duplicateBody = await duplicateResponse.json()
  const row = pool.state.messageRows[0]

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.parse_status, 'MEDIA_RECEIVED')
  assert.equal(body.pi_created, false)
  assert.equal(duplicateResponse.status, 200)
  assert.equal(duplicateBody.ok, true)
  assert.equal(duplicateBody.duplicate, true)
  assert.equal(duplicateBody.saved, 1)
  assert.equal(duplicateBody.inserted, false)
  assert.equal(duplicateBody.parse_status, 'MEDIA_RECEIVED')
  assert.equal(duplicateBody.pi_created, false)
  assert.equal(pool.state.messageRows.length, 1)
  assert.equal(pool.state.captureUpdates, 1)
  assert.equal(pool.state.piCreationAttempts, 0)
  assert.equal(row.message_type, 'image')
  assert.equal(row.media_id, 'meta-image-id-1')
  assert.equal(row.media_type, 'image')
  assert.equal(row.media_mime_type, 'image/jpeg')
  assert.equal(row.media_sha256, 'image-sha')
  assert.equal(row.caption, 'Please check this image')
  assert.equal(row.processing_status, 'MEDIA_RECEIVED')
  assert.equal(row.media_capture_status, 'CAPTURED')
  assert.equal(row.pi_created, false)
  assert.equal(row.raw_payload.message.id, 'wamid.media-image-1')
  assert.equal(fetchCalls, 0)
})

test('live webhook captures PDF media and ignores duplicate replay', async (t) => {
  const pool = createMediaCapturePool()
  let fetchCalls = 0
  const app = express()

  app.use(express.json())
  app.use('/api/whatsapp-pi', createWhatsappPIRouter({
    fetch: async () => {
      fetchCalls += 1
      throw new Error('Media capture must not call Meta or media download APIs.')
    },
    pool,
    tableNames: {},
  }))

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => server.close())

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [
                {
                  profile: { name: 'PDF Customer' },
                  wa_id: '917733850017',
                },
              ],
              messages: [
                {
                  document: {
                    caption: 'Order PDF attached',
                    filename: 'order.pdf',
                    id: 'meta-pdf-id-1',
                    mime_type: 'application/pdf',
                    sha256: 'pdf-sha',
                  },
                  from: '917733850017',
                  id: 'wamid.media-pdf-1',
                  timestamp: '1785997801',
                  type: 'document',
                },
              ],
            },
          },
        ],
      },
    ],
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/whatsapp-pi/webhook`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const body = await response.json()
  const duplicateResponse = await fetch(`http://127.0.0.1:${port}/api/whatsapp-pi/webhook`, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const duplicateBody = await duplicateResponse.json()
  const row = pool.state.messageRows[0]

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.parse_status, 'MEDIA_RECEIVED')
  assert.equal(body.pi_created, false)
  assert.equal(duplicateResponse.status, 200)
  assert.equal(duplicateBody.ok, true)
  assert.equal(duplicateBody.duplicate, true)
  assert.equal(duplicateBody.inserted, false)
  assert.equal(duplicateBody.parse_status, 'MEDIA_RECEIVED')
  assert.equal(pool.state.messageRows.length, 1)
  assert.equal(pool.state.captureUpdates, 1)
  assert.equal(pool.state.piCreationAttempts, 0)
  assert.equal(row.message_type, 'document')
  assert.equal(row.media_id, 'meta-pdf-id-1')
  assert.equal(row.media_type, 'document')
  assert.equal(row.media_mime_type, 'application/pdf')
  assert.equal(row.media_sha256, 'pdf-sha')
  assert.equal(row.file_name, 'order.pdf')
  assert.equal(row.caption, 'Order PDF attached')
  assert.equal(row.processing_status, 'MEDIA_RECEIVED')
  assert.equal(row.media_capture_status, 'CAPTURED')
  assert.equal(row.pi_created, false)
  assert.equal(row.raw_payload.message.id, 'wamid.media-pdf-1')
  assert.equal(fetchCalls, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CUSTOMER_CONFIRMATION_STATUSES,
  PI_SUMMARY_STATUSES,
  buildPiSummaryMessage,
  detectCustomerCommand,
  handleCustomerConfirmationReply,
  parseCustomerConfirmationReply,
  sendPiSummary,
} from './piSummaryService.js'

const testPi = {
  basicValue: 611068,
  cdAmount: 0,
  cgstAmount: 0,
  cgstPercent: 0,
  companyName: 'Autolite Manufacturing Limited',
  customerName: 'Jalaram Enterprise',
  destination: 'Navagam',
  grandTotal: 611068,
  igstAmount: 109992.24,
  igstPercent: 18,
  isDraft: true,
  items: [
    {
      amount: 611068,
      productDescription: 'SB 102 H4 P43T P LHT E',
      quantity: 1000,
      rate: 611.068,
      unit: 'NOS',
    },
  ],
  netTaxableValue: 611068,
  piNumber: 'AML-0002',
  poNo: 'wamid.source',
  schemeDiscount: 0,
  sgstAmount: 0,
  sgstPercent: 0,
}

const testEnv = {
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017',
  WHATSAPP_AUTO_ACK_MODE: 'development',
  WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_PI_SUMMARY_ENABLED: 'true',
}

const createSummaryPool = ({
  pi = {},
  piLines = [],
  source = {},
  sendLogs = [],
} = {}) => {
  const state = {
    masterUpdates: 0,
    pi: {
      basic_value: 611068,
      cd_amt: 0,
      cgst_amt: 0,
      cgst_per: 0,
      close_yn: 'N',
      comp_code: 1,
      company_legal_name: 'Autolite Manufacturing Limited',
      company_name: 'Autolite Manufacturing Limited',
      destination: 'Navagam',
      grand_total: 611068,
      igst_amt: 109992.24,
      igst_per: 18,
      is_active: true,
      net_taxable_value: 611068,
      oth_dis_amt: 0,
      oth_spdis_amt: 0,
      pcust_name: 'Jalaram Enterprise',
      pi_no: 2,
      pi_series: 'AML-',
      po_no: '',
      round_off: 0,
      scheme_discount: 0,
      sgst_amt: 0,
      sgst_per: 0,
      spdis_amt: 0,
      tod_amt: 0,
      buy_fly_amt: 0,
      ...pi,
    },
    piLines: piLines.length > 0
      ? piLines
      : [
        {
          amount: 611068,
          damt: 0,
          description: 'SB 102 H4 P43T P LHT E',
          drate: 0,
          product_code: 'SB102',
          product_description: 'SB 102 H4 P43T P LHT E',
          product_unit: 'NOS',
          quantity: 1000,
          rate: 611.068,
          rbasic: 611068,
          unit: 'NOS',
        },
      ],
    sendLogs,
    source: {
      acknowledgement_status: 'SENT',
      customer_confirmation_status: null,
      draft_pi_no: 'AML-0002',
      id: 1,
      message_id: 'wamid.source',
      pi_summary_meta_message_id: '',
      pi_summary_status: 'PENDING',
      sender_phone: '917733850017',
      ...source,
    },
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE TABLE|CREATE (UNIQUE )?INDEX/.test(sql)) {
        return { rows: [] }
      }

      if (/SELECT\s+id,\s*message_id,\s*sender_phone/i.test(sql)) {
        return { rows: state.source ? [state.source] : [] }
      }

      if (/FROM\s+master_pi_rmkt\s+pi/i.test(sql)) {
        const piNo = Number(params[0])
        const piSeries = params[1]
        const sourceMessageId = params[2] || ''
        const matchesPi =
          state.pi &&
          Number(state.pi.pi_no) === piNo &&
          state.pi.pi_series === piSeries &&
          (sourceMessageId === '' || state.pi.po_no === sourceMessageId)

        return { rowCount: matchesPi ? 1 : 0, rows: matchesPi ? [state.pi] : [] }
      }

      if (/FROM\s+tran_pi_rmkt\s+tran/i.test(sql)) {
        return { rows: state.piLines }
      }

      if (/UPDATE\s+master_pi_rmkt/i.test(sql)) {
        state.masterUpdates += 1
        return { rows: [] }
      }

      if (
        /UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) &&
        /customer_confirmation_message_id\s*=\s*\$3/i.test(sql)
      ) {
        state.source = {
          ...state.source,
          customer_change_request:
            params[1] === CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED
              ? params[3]
              : state.source.customer_change_request,
          customer_confirmation_message_id: params[2],
          customer_confirmation_status: params[1],
          reply_status: params[1],
        }

        return { rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
        state.source = {
          ...state.source,
          customer_confirmation_status:
            params[1] === PI_SUMMARY_STATUSES.SENT
              ? CUSTOMER_CONFIRMATION_STATUSES.AWAITING_CONFIRMATION
              : state.source.customer_confirmation_status,
          pi_summary_error: params[5],
          pi_summary_message: params[2] ?? state.source.pi_summary_message,
          pi_summary_meta_message_id: params[4] ?? state.source.pi_summary_meta_message_id,
          pi_summary_sent_at: params[3] ?? state.source.pi_summary_sent_at,
          pi_summary_status: params[1],
        }

        return { rows: [] }
      }

      if (
        /SELECT\s+send_log_id,\s+meta_message_id/i.test(sql) &&
        /FROM\s+tran_whatsapp_send_log/i.test(sql)
      ) {
        const sent = state.sendLogs.find(
          (log) =>
            log.attempt_status === 'SENT' &&
            log.message_purpose === params[0] &&
            (log.source_whatsapp_message_id || '') === (params[1] || '') &&
            (log.pi_number || '') === (params[2] || ''),
        )

        return { rows: sent ? [sent] : [] }
      }

      if (/INSERT INTO\s+tran_whatsapp_send_log/i.test(sql)) {
        const sendLog = {
          attempt_number: params[12],
          attempt_status: params[13],
          destination_phone: params[4],
          failure_category: '',
          message_body: params[7],
          message_purpose: params[5],
          meta_message_id: '',
          pi_number: params[2],
          send_log_id: state.sendLogs.length + 1,
          source_whatsapp_message_id: params[1],
        }

        state.sendLogs.push(sendLog)

        return { rows: [{ send_log_id: sendLog.send_log_id }] }
      }

      if (/UPDATE\s+tran_whatsapp_send_log/i.test(sql)) {
        const sendLog = state.sendLogs.find((log) => log.send_log_id === Number(params[0]))

        if (sendLog) {
          if (/attempt_status = COALESCE/i.test(sql)) {
            sendLog.attempt_status = params[1] ?? sendLog.attempt_status
            sendLog.failure_category = params[2]
            sendLog.retryable = params[3] ?? sendLog.retryable
            sendLog.http_status = params[4]
            sendLog.meta_message_id = params[6] || sendLog.meta_message_id || ''
            sendLog.meta_response = params[7]
            sendLog.meta_error_message = params[11]
            sendLog.network_error_message = params[14]
            sendLog.duration_ms = params[17]
            sendLog.next_retry_at = params[18]
          } else if (/next_retry_at = \$2/i.test(sql)) {
            sendLog.next_retry_at = params[1]
            sendLog.parent_send_log_id = params[2]
          } else if (/attempt_status = \$2/i.test(sql)) {
            sendLog.attempt_status = params[1]
          }
        }

        return { rows: [] }
      }

      throw new Error(`Unexpected SQL in summary test: ${sql}`)
    },
  }
}

test('builds Draft PI summary with Indian currency and IGST', () => {
  const message = buildPiSummaryMessage(testPi)

  assert.match(message, /AUTOPAL Draft PI Summary/)
  assert.match(message, /PI No\.: AML-0002/)
  assert.match(message, /Rate: ₹611\.07/)
  assert.match(message, /Basic Value: ₹6,11,068\.00/)
  assert.match(message, /IGST @ 18%: ₹1,09,992\.24/)
  assert.match(message, /Grand Total: ₹6,11,068\.00/)
  assert.doesNotMatch(message, /PDF|approved|final approval received/i)
})

test('shows discount line only when applicable and CGST/SGST when present', () => {
  const message = buildPiSummaryMessage({
    ...testPi,
    cgstAmount: 27498.06,
    cgstPercent: 9,
    grandTotal: 360000,
    igstAmount: 0,
    netTaxableValue: 305534,
    schemeDiscount: 1000,
    sgstAmount: 27498.06,
    sgstPercent: 9,
  })

  assert.match(message, /Discount: ₹1,000\.00/)
  assert.match(message, /CGST @ 9%: ₹27,498\.06/)
  assert.match(message, /SGST @ 9%: ₹27,498\.06/)
  assert.doesNotMatch(message, /IGST @/)
})

test('parses CONFIRM and CHANGE replies with PI number', () => {
  const confirm = parseCustomerConfirmationReply('CONFIRM AML-0002')
  const change = parseCustomerConfirmationReply(
    'CHANGE AML-0002\nQuantity should be 3500 Nos.',
  )

  assert.equal(confirm.status, CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED)
  assert.equal(confirm.piNumber, 'AML-0002')
  assert.equal(change.status, CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED)
  assert.match(change.changeRequest, /3500/)
})

test('detects exact customer confirm command', () => {
  const detected = detectCustomerCommand('CONFIRM AML-0025')

  assert.equal(detected.handled, true)
  assert.equal(detected.command, 'CONFIRM')
  assert.equal(detected.piNumber, 'AML-0025')
  assert.equal(detected.status, CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED)
})

test('does not accept generic OK as final confirmation', () => {
  const result = parseCustomerConfirmationReply('OK', 'AML-0002')

  assert.equal(result.status, CUSTOMER_CONFIRMATION_STATUSES.INVALID_RESPONSE)
  assert.equal(result.piNumber, 'AML-0002')
})

test('disabled summary flag prevents Meta send', async () => {
  let fetchCalls = 0
  const pool = createSummaryPool()
  const result = await sendPiSummary({
    env: {
      ...testEnv,
      WHATSAPP_PI_SUMMARY_ENABLED: 'false',
    },
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    pi: testPi,
    pool,
    senderPhone: '917733850017',
    sourceMessageId: 'wamid.source',
  })

  assert.equal(result.status, PI_SUMMARY_STATUSES.DISABLED)
  assert.equal(fetchCalls, 0)
})

test('duplicate summary is blocked before Meta send', async () => {
  let fetchCalls = 0
  const pool = createSummaryPool({
    source: {
      pi_summary_meta_message_id: 'wamid.summary',
      pi_summary_status: PI_SUMMARY_STATUSES.SENT,
    },
  })
  const result = await sendPiSummary({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    pi: testPi,
    pool,
    senderPhone: '917733850017',
    sourceMessageId: 'wamid.source',
  })

  assert.equal(result.status, PI_SUMMARY_STATUSES.DUPLICATE_SKIPPED)
  assert.equal(fetchCalls, 0)
})

test('non-tester number is blocked in development mode', async () => {
  let fetchCalls = 0
  const pool = createSummaryPool()
  const result = await sendPiSummary({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    pi: testPi,
    pool,
    senderPhone: '918888888888',
    sourceMessageId: 'wamid.source',
  })

  assert.equal(result.status, PI_SUMMARY_STATUSES.PERMANENTLY_FAILED)
  assert.equal(result.failureCategory, 'TEST_NUMBER_NOT_ALLOWED')
  assert.equal(fetchCalls, 0)
  assert.equal(pool.state.sendLogs[0].failure_category, 'TEST_NUMBER_NOT_ALLOWED')
})

test('successful summary send stores Meta message ID and awaiting confirmation status', async () => {
  const pool = createSummaryPool()
  const result = await sendPiSummary({
    env: testEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        messages: [{ id: 'wamid.summary-sent' }],
      }), { status: 200 }),
    pi: testPi,
    pool,
    senderPhone: '917733850017',
    sourceMessageId: 'wamid.source',
  })

  assert.equal(result.status, PI_SUMMARY_STATUSES.SENT)
  assert.equal(result.metaMessageId, 'wamid.summary-sent')
  assert.equal(pool.state.source.pi_summary_meta_message_id, 'wamid.summary-sent')
  assert.equal(
    pool.state.source.customer_confirmation_status,
    CUSTOMER_CONFIRMATION_STATUSES.AWAITING_CONFIRMATION,
  )
})

test('CONFIRM AML-0023 updates original source row and sends customer confirmation ack', async () => {
  const confirmationMessageId =
    'wamid.HBgMOTE3NzMzODUwMDE3FQIAEhggQTVFMzkxQjQwQUExMzI2QzIwMTlCMTY3RTUzREVGMzEA'
  const originalMessageId = 'wamid.original-order'
  const pool = createSummaryPool({
    pi: {
      close_yn: 'N',
      pi_no: 23,
      pi_series: 'AML-',
      po_no: '',
    },
    source: {
      customer_confirmation_status: CUSTOMER_CONFIRMATION_STATUSES.AWAITING_CONFIRMATION,
      draft_pi_no: 'AML-0023',
      id: 96,
      message_id: originalMessageId,
      sender_phone: '917733850017',
    },
  })

  const result = await handleCustomerConfirmationReply({
    env: testEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        messages: [{ id: 'wamid.customer-confirmation-ack' }],
      }), { status: 200 }),
    messageId: confirmationMessageId,
    pool,
    replyText: 'CONFIRM AML-0023',
    sendResponse: true,
    senderPhone: '917733850017',
  })

  assert.equal(result.handled, true)
  assert.equal(result.status, CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED)
  assert.equal(result.pi.piNumber, 'AML-0023')
  assert.equal(result.pi.isDraft, true)
  assert.equal(pool.state.masterUpdates, 0)
  assert.equal(
    pool.state.source.customer_confirmation_status,
    CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED,
  )
  assert.equal(pool.state.source.customer_confirmation_message_id, confirmationMessageId)
  assert.equal(pool.state.sendLogs.length, 1)
  assert.equal(pool.state.sendLogs[0].message_purpose, 'CUSTOMER_CONFIRMATION_ACK')
  assert.equal(pool.state.sendLogs[0].source_whatsapp_message_id, confirmationMessageId)
})

test('duplicate CONFIRM command is idempotent when original row is already confirmed', async () => {
  const confirmationMessageId = 'wamid.duplicate-confirmation'
  const pool = createSummaryPool({
    pi: {
      close_yn: 'N',
      pi_no: 25,
      pi_series: 'AML-',
      po_no: '',
    },
    sendLogs: [
      {
        attempt_status: 'SENT',
        message_purpose: 'CUSTOMER_CONFIRMATION_ACK',
        pi_number: 'AML-0025',
        send_log_id: 8,
        source_whatsapp_message_id: confirmationMessageId,
      },
    ],
    source: {
      customer_confirmation_message_id: confirmationMessageId,
      customer_confirmation_status: CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED,
      draft_pi_no: 'AML-0025',
      id: 98,
      message_id: 'wamid.original-order-25',
      sender_phone: '917733850017',
    },
  })

  const result = await handleCustomerConfirmationReply({
    env: testEnv,
    fetchImpl: async () => {
      throw new Error('Meta should not be called for duplicate sent confirmation ack.')
    },
    messageId: confirmationMessageId,
    pool,
    replyText: 'CONFIRM AML-0025',
    sendResponse: true,
    senderPhone: '917733850017',
  })

  assert.equal(result.status, CUSTOMER_CONFIRMATION_STATUSES.ALREADY_CONFIRMED)
  assert.equal(pool.state.masterUpdates, 0)
  assert.equal(pool.state.source.customer_confirmation_status, CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED)
  assert.equal(pool.state.sendLogs.length, 2)
  assert.equal(pool.state.sendLogs.at(-1).attempt_status, 'SKIPPED')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CUSTOMER_CONFIRMATION_STATUSES,
  PI_SUMMARY_STATUSES,
  buildPiSummaryMessage,
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
  source = {},
} = {}) => {
  const state = {
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
      if (/ALTER TABLE|CREATE INDEX/.test(sql)) {
        return { rows: [] }
      }

      if (/SELECT\s+id,\s*message_id,\s*sender_phone/i.test(sql)) {
        return { rows: state.source ? [state.source] : [] }
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

  assert.equal(result.status, PI_SUMMARY_STATUSES.TEST_NUMBER_NOT_ALLOWED)
  assert.equal(fetchCalls, 0)
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

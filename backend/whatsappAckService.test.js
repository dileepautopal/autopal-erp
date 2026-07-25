import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACK_STATUSES,
  buildAcknowledgementMessage,
  getAcknowledgementConfig,
  isAllowedTesterNumber,
  sendAutomaticAcknowledgement,
  sendTextMessage,
  validateAcknowledgementPreconditions,
} from './whatsappAckService.js'

const testEnv = {
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_ACK_INCLUDE_PI_NUMBER: 'true',
  WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017, 919999999999',
  WHATSAPP_AUTO_ACK_ENABLED: 'true',
  WHATSAPP_AUTO_ACK_MODE: 'development',
  WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
}

const createAcknowledgementPool = ({
  incoming = {},
  outgoing = null,
} = {}) => {
  const state = {
    incoming: {
      acknowledgement_attempts: 0,
      acknowledgement_status: 'PENDING',
      acknowledgement_whatsapp_message_id: '',
      ...incoming,
    },
    outgoing,
    schemaQueries: 0,
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE TABLE|CREATE (UNIQUE )?INDEX/.test(sql)) {
        state.schemaQueries += 1

        return { rows: [] }
      }

      if (
        /SELECT\s+acknowledgement_status/i.test(sql) &&
        /FROM\s+tran_whatsapp_pi_messages/i.test(sql)
      ) {
        return { rows: [state.incoming] }
      }

      if (
        /SELECT\s+outgoing_id/i.test(sql) &&
        /FROM\s+tran_whatsapp_outgoing_messages/i.test(sql)
      ) {
        return { rows: state.outgoing ? [state.outgoing] : [] }
      }

      if (/INSERT INTO\s+tran_whatsapp_outgoing_messages/i.test(sql)) {
        state.outgoing = {
          attempt_count: 0,
          meta_message_id: '',
          outgoing_id: 101,
          send_status: params[6],
        }

        return { rows: [state.outgoing] }
      }

      if (/UPDATE\s+tran_whatsapp_outgoing_messages/i.test(sql)) {
        state.outgoing = {
          ...state.outgoing,
          attempt_count: params[6],
          error_code: params[4],
          error_message: params[5],
          meta_message_id: params[2] || state.outgoing?.meta_message_id || '',
          send_status: params[1],
        }

        return { rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
        state.incoming = {
          ...state.incoming,
          acknowledgement_attempts: params[6] ?? state.incoming.acknowledgement_attempts,
          acknowledgement_error: params[5],
          acknowledgement_message: params[2] ?? state.incoming.acknowledgement_message,
          acknowledgement_sent_at: params[3] ?? state.incoming.acknowledgement_sent_at,
          acknowledgement_status: params[1],
          acknowledgement_whatsapp_message_id:
            params[4] ?? state.incoming.acknowledgement_whatsapp_message_id,
        }

        return { rows: [] }
      }

      throw new Error(`Unexpected SQL in acknowledgement test: ${sql}`)
    },
  }
}

test('builds PI acknowledgement without promising order acceptance', () => {
  const message = buildAcknowledgementMessage({
    piNumber: 'HAL-0001',
    processingStatus: 'PI_CREATED',
  })

  assert.match(message, /Reference No\.: HAL-0001/)
  assert.match(message, /automated development test message/i)
  assert.doesNotMatch(message, /dispatch|accepted|approved/i)
})

test('builds generic acknowledgement for manual review', () => {
  const message = buildAcknowledgementMessage({
    processingStatus: 'MANUAL_REVIEW',
  })

  assert.match(message, /reviewing the details/i)
  assert.doesNotMatch(message, /Reference No\./)
})

test('auto acknowledgement is disabled by default', () => {
  const config = getAcknowledgementConfig({})

  assert.equal(config.autoAckEnabled, false)
})

test('development allow-list permits only registered tester numbers', () => {
  const config = getAcknowledgementConfig(testEnv)

  assert.equal(isAllowedTesterNumber('91 7733850017', config), true)
  assert.equal(isAllowedTesterNumber('918888888888', config), false)
})

test('preconditions block non-allow-listed numbers', () => {
  const config = getAcknowledgementConfig(testEnv)
  const result = validateAcknowledgementPreconditions({
    config,
    incomingMessageRecord: {
      messageType: 'text',
      senderPhone: '918888888888',
      sourceType: 'text',
    },
    processingStatus: 'MANUAL_REVIEW',
  })

  assert.equal(result.status, ACK_STATUSES.TEST_NUMBER_NOT_ALLOWED)
})

test('preconditions block missing sender phone', () => {
  const config = getAcknowledgementConfig(testEnv)
  const result = validateAcknowledgementPreconditions({
    config,
    incomingMessageRecord: {
      messageType: 'text',
      senderPhone: '',
      sourceType: 'text',
    },
    processingStatus: 'MANUAL_REVIEW',
  })

  assert.equal(result.status, ACK_STATUSES.FAILED)
})

test('sendTextMessage stores successful Meta message ID using mocked fetch', async () => {
  let capturedPayload = null
  const fetchImpl = async (_url, options) => {
    capturedPayload = JSON.parse(options.body)

    return new Response(JSON.stringify({
      messages: [{ id: 'wamid.test-success' }],
    }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  }

  const result = await sendTextMessage({
    body: 'hello',
    env: testEnv,
    fetchImpl,
    to: '917733850017',
  })

  assert.equal(result.ok, true)
  assert.equal(result.metaMessageId, 'wamid.test-success')
  assert.equal(capturedPayload.to, '917733850017')
  assert.equal(capturedPayload.text.preview_url, false)
})

test('sendTextMessage classifies expired token without retry', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      error: {
        code: 190,
        error_subcode: 463,
        message: 'Session has expired',
      },
    }), {
      headers: { 'content-type': 'application/json' },
      status: 400,
    })

  const result = await sendTextMessage({
    body: 'hello',
    env: testEnv,
    fetchImpl,
    to: '917733850017',
  })

  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
  assert.equal(result.status, ACK_STATUSES.TOKEN_EXPIRED)
})

test('automatic acknowledgement disabled flag prevents Meta send', async () => {
  let fetchCalls = 0
  const pool = createAcknowledgementPool()
  const result = await sendAutomaticAcknowledgement({
    env: {
      ...testEnv,
      WHATSAPP_AUTO_ACK_ENABLED: 'false',
    },
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    incomingMessageRecord: {
      messageId: 'wamid.disabled',
      messageType: 'text',
      senderPhone: '917733850017',
      sourceType: 'text',
    },
    pool,
    processingStatus: 'PI_CREATED',
  })

  assert.equal(result.status, ACK_STATUSES.DISABLED)
  assert.equal(fetchCalls, 0)
  assert.equal(pool.state.incoming.acknowledgement_status, ACK_STATUSES.DISABLED)
})

test('automatic acknowledgement skips an already sent incoming message', async () => {
  let fetchCalls = 0
  const pool = createAcknowledgementPool({
    incoming: {
      acknowledgement_status: ACK_STATUSES.SENT,
      acknowledgement_whatsapp_message_id: 'wamid.outgoing-existing',
    },
  })
  const result = await sendAutomaticAcknowledgement({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    incomingMessageRecord: {
      messageId: 'wamid.duplicate',
      messageType: 'text',
      senderPhone: '917733850017',
      sourceType: 'text',
    },
    pool,
    processingStatus: 'PI_CREATED',
  })

  assert.equal(result.status, ACK_STATUSES.DUPLICATE_SKIPPED)
  assert.equal(fetchCalls, 0)
  assert.equal(result.metaMessageId, 'wamid.outgoing-existing')
})

test('automatic acknowledgement retries temporary Meta failure and stores message ID', async () => {
  let fetchCalls = 0
  const pool = createAcknowledgementPool()
  const result = await sendAutomaticAcknowledgement({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      if (fetchCalls === 1) {
        return new Response(JSON.stringify({
          error: {
            code: 2,
            message: 'Temporary service issue',
          },
        }), { status: 500 })
      }

      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.sent-after-retry' }],
      }), { status: 200 })
    },
    incomingMessageRecord: {
      id: 55,
      messageId: 'wamid.retry',
      messageType: 'text',
      senderPhone: '917733850017',
      sourceType: 'text',
    },
    piNumber: 'HAL-0001',
    pool,
    processingStatus: 'PI_CREATED',
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, ACK_STATUSES.SENT)
  assert.equal(result.attempts, 2)
  assert.equal(fetchCalls, 2)
  assert.equal(result.metaMessageId, 'wamid.sent-after-retry')
  assert.equal(pool.state.outgoing.meta_message_id, 'wamid.sent-after-retry')
  assert.equal(pool.state.incoming.acknowledgement_status, ACK_STATUSES.SENT)
  assert.equal(pool.state.incoming.acknowledgement_attempts, 2)
})

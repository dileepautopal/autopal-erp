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
  failIncomingUpdate = false,
  incoming = {},
  outgoing = null,
  sendLogs = [],
} = {}) => {
  const state = {
    incoming: {
      acknowledgement_attempts: 0,
      acknowledgement_status: 'PENDING',
      acknowledgement_whatsapp_message_id: '',
      ...incoming,
    },
    outgoing,
    sendLogs,
    incomingUpdates: [],
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
          message_body: params[7],
          message_purpose: params[5],
          message_type: params[6],
          meta_message_id: '',
          pi_number: params[2],
          retry_batch_id: params[15],
          send_log_id: state.sendLogs.length + 1,
          source_message_record_id: params[0],
          source_whatsapp_message_id: params[1],
        }

        state.sendLogs.push(sendLog)

        return { rows: [{ send_log_id: sendLog.send_log_id }] }
      }

      if (/UPDATE\s+tran_whatsapp_send_log/i.test(sql)) {
        const targetId = Number(params[0])
        const sendLog = state.sendLogs.find((log) => log.send_log_id === targetId)

        if (sendLog) {
          if (/attempt_status = COALESCE/i.test(sql)) {
            sendLog.attempt_status = params[1] ?? sendLog.attempt_status
            sendLog.failure_category = params[2]
            sendLog.retryable = params[3] ?? sendLog.retryable
            sendLog.http_status = params[4]
            sendLog.http_status_text = params[5]
            sendLog.meta_message_id = params[6] || sendLog.meta_message_id || ''
            sendLog.meta_response = params[7]
            sendLog.meta_error_code = params[9]
            sendLog.meta_error_message = params[11]
            sendLog.network_error_code = params[13]
            sendLog.network_error_message = params[14]
            sendLog.duration_ms = params[17]
            sendLog.next_retry_at = params[18]
          } else if (/next_retry_at = \$2/i.test(sql)) {
            sendLog.next_retry_at = params[1]
            sendLog.parent_send_log_id = params[2]
          } else if (/parent_send_log_id = \$2/i.test(sql)) {
            sendLog.parent_send_log_id = params[1]
          } else if (/attempt_status = \$2/i.test(sql)) {
            sendLog.attempt_status = params[1]
          }
        }

        return { rows: [] }
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
        state.incomingUpdates.push({
          params,
          sql,
        })

        if (failIncomingUpdate) {
          const error = new Error('simulated source update failure')
          error.code = '42804'
          throw error
        }

        state.incoming = {
          ...state.incoming,
          acknowledgement_attempts: params[6] ?? state.incoming.acknowledgement_attempts,
          acknowledgement_error: params[5],
          acknowledgement_message: params[2] ?? state.incoming.acknowledgement_message,
          acknowledgement_sent_at: params[3] ?? state.incoming.acknowledgement_sent_at,
          acknowledgement_status: params[1],
          acknowledgement_whatsapp_message_id:
            params[4] ?? state.incoming.acknowledgement_whatsapp_message_id,
          reply_status: params[7] ?? state.incoming.reply_status,
        }

        return {
          rowCount: 1,
          rows: [{
            acknowledgement_status: state.incoming.acknowledgement_status,
            message_id: params[0],
            pi_summary_status: state.incoming.pi_summary_status,
            reply_status: state.incoming.reply_status,
          }],
        }
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

test('preconditions defer non-allow-listed numbers to sender diagnostics', () => {
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

  assert.equal(result.status, '')
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

test('automatic acknowledgement source update uses explicit typed placeholders and nulls', async () => {
  const pool = createAcknowledgementPool()
  let fetchCalls = 0
  const result = await sendAutomaticAcknowledgement({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1
      assert.equal(pool.state.sendLogs.length, 1)
      assert.equal(pool.state.sendLogs[0].attempt_status, 'SENDING')

      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.ack-sent' }],
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    },
    incomingMessageRecord: {
      id: 77,
      messageId: 'wamid.typed-source',
      messageType: 'text',
      senderPhone: '917733850017',
      sourceType: 'text',
    },
    piNumber: 'HAL-0099',
    pool,
    processingStatus: 'DRAFT_PI_CREATED',
  })

  const firstUpdate = pool.state.incomingUpdates[0]
  const finalUpdate = pool.state.incomingUpdates.at(-1)

  assert.equal(result.ok, true)
  assert.equal(result.status, ACK_STATUSES.SENT)
  assert.equal(fetchCalls, 1)
  assert.match(firstUpdate.sql, /acknowledgement_status = \$2::varchar/)
  assert.match(firstUpdate.sql, /acknowledgement_message = COALESCE\(\$3::text/)
  assert.match(firstUpdate.sql, /acknowledgement_sent_at = COALESCE\(\$4::timestamptz/)
  assert.match(firstUpdate.sql, /COALESCE\(\$5::varchar/)
  assert.match(firstUpdate.sql, /acknowledgement_attempts = COALESCE\(\$7::integer/)
  assert.match(firstUpdate.sql, /reply_status = COALESCE\(\$8::varchar/)
  assert.doesNotMatch(firstUpdate.sql, /reply_status = \$2\b/)
  assert.equal(firstUpdate.params[1], ACK_STATUSES.SENDING)
  assert.equal(firstUpdate.params[3], null)
  assert.equal(firstUpdate.params[4], null)
  assert.equal(firstUpdate.params[6], null)
  assert.equal(firstUpdate.params[7], ACK_STATUSES.SENDING)
  assert.equal(typeof firstUpdate.params[8], 'boolean')
  assert.equal(finalUpdate.params[1], ACK_STATUSES.SENT)
  assert.equal(finalUpdate.params[4], 'wamid.ack-sent')
  assert.equal(finalUpdate.params[6], 1)
  assert.equal(finalUpdate.params[7], ACK_STATUSES.SENT)
})

test('failed SENDING source update returns database error before shared sender', async () => {
  let fetchCalls = 0
  const pool = createAcknowledgementPool({
    failIncomingUpdate: true,
  })

  const result = await sendAutomaticAcknowledgement({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    incomingMessageRecord: {
      id: 78,
      messageId: 'wamid.source-update-fails',
      messageType: 'text',
      senderPhone: '917733850017',
      sourceType: 'text',
    },
    piNumber: 'HAL-0100',
    pool,
    processingStatus: 'DRAFT_PI_CREATED',
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, ACK_STATUSES.FAILED)
  assert.equal(result.failureCategory, 'DATABASE_ERROR')
  assert.equal(result.errorCode, '42804')
  assert.equal(fetchCalls, 0)
  assert.equal(pool.state.sendLogs.length, 0)
  assert.equal(pool.state.incomingUpdates.length, 1)
})

test('automatic acknowledgement schedules temporary Meta failure without blocking webhook', async () => {
  let fetchCalls = 0
  const pool = createAcknowledgementPool()
  const result = await sendAutomaticAcknowledgement({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response(JSON.stringify({
        error: {
          code: 2,
          message: 'Temporary service issue',
        },
      }), { status: 500 })
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

  assert.equal(result.ok, false)
  assert.equal(result.status, ACK_STATUSES.RETRY_SCHEDULED)
  assert.equal(result.attempts, 1)
  assert.equal(fetchCalls, 1)
  assert.equal(pool.state.outgoing.send_status, ACK_STATUSES.RETRY_SCHEDULED)
  assert.equal(pool.state.incoming.acknowledgement_status, ACK_STATUSES.RETRY_SCHEDULED)
  assert.equal(pool.state.incoming.acknowledgement_attempts, 1)
  assert.equal(pool.state.sendLogs.some((log) => log.attempt_status === 'RETRY_SCHEDULED'), true)
})

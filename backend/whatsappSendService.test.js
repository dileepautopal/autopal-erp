import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MESSAGE_PURPOSES,
  SEND_ATTEMPT_STATUSES,
  SEND_FAILURE_CATEGORIES,
  cancelScheduledRetry,
  claimRetryJobs,
  classifyMetaFailure,
  classifyNetworkError,
  createManualRetryFromLog,
  ensureWhatsAppSendLogSchema,
  isRetryableFailureCategory,
  markSendForManualReview,
  recoverStaleSendAttempts,
  sendLoggedWhatsAppTextMessage,
} from './whatsappSendService.js'
import { processRetryJob } from './whatsappSendRetryWorker.js'

const testEnv = {
  WHATSAPP_ACCESS_TOKEN: 'EAATESTSECRET_SHOULD_NOT_BE_LOGGED',
  WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017',
  WHATSAPP_AUTO_ACK_MODE: 'development',
  WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_SEND_MAX_ATTEMPTS: '4',
  WHATSAPP_SEND_RETRY_DELAY_SECONDS: '30',
  WHATSAPP_SEND_RETRY_ENABLED: 'true',
  WHATSAPP_SEND_RETRY_MAX_DELAY_SECONDS: '600',
}

const createSendPool = ({ logs = [], source = null } = {}) => {
  const state = {
    logs: logs.map((log, index) => ({
      attempt_number: 1,
      attempt_status: 'FAILED',
      created_at: new Date().toISOString(),
      destination_phone: '917733850017',
      message_body: 'Hello',
      message_purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
      message_type: 'text',
      pi_number: 'HAL-0001',
      retryable: false,
      send_log_id: index + 1,
      source_whatsapp_message_id: 'wamid.source',
      ...log,
    })),
    source,
  }

  const query = async (sql, params = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(sql).trim())) {
      return { rowCount: 0, rows: [] }
    }

    if (/CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX/.test(sql)) {
      return { rowCount: 0, rows: [] }
    }

    if (
      /SELECT\s+send_log_id,\s+meta_message_id/i.test(sql) &&
      /FROM\s+tran_whatsapp_send_log/i.test(sql)
    ) {
      const sent = state.logs.find(
        (log) =>
          log.attempt_status === 'SENT' &&
          log.message_purpose === params[0] &&
          (log.source_whatsapp_message_id || '') === (params[1] || '') &&
          (log.pi_number || '') === (params[2] || ''),
      )

      return { rowCount: sent ? 1 : 0, rows: sent ? [sent] : [] }
    }

    if (/INSERT INTO\s+tran_whatsapp_send_log/i.test(sql)) {
      const row = {
        attempt_number: params[12],
        attempt_status: params[13],
        created_at: new Date().toISOString(),
        customer_id: params[3],
        destination_phone: params[4],
        graph_api_version: params[10],
        message_body: params[7],
        message_purpose: params[5],
        message_type: params[6],
        phone_number_id: params[11],
        pi_number: params[2],
        request_payload: JSON.parse(params[8] || '{}'),
        request_started_at: params[14],
        request_url: params[9],
        retry_batch_id: params[15],
        retryable: false,
        send_log_id: state.logs.length + 1,
        source_message_record_id: params[0],
        source_whatsapp_message_id: params[1],
      }

      state.logs.push(row)

      return { rowCount: 1, rows: [{ send_log_id: row.send_log_id }] }
    }

    if (/WITH claim AS/i.test(sql)) {
      const limit = Number(params[0] ?? 5)
      const now = Date.now()
      const claimed = state.logs
        .filter(
          (log) =>
            log.attempt_status === 'RETRY_SCHEDULED' &&
            (!log.next_retry_at || new Date(log.next_retry_at).getTime() <= now),
        )
        .sort((a, b) => a.send_log_id - b.send_log_id)
        .slice(0, limit)

      claimed.forEach((log) => {
        log.attempt_status = 'RETRYING'
      })

      return { rowCount: claimed.length, rows: claimed }
    }

    if (/SELECT\s+\*\s+FROM\s+tran_whatsapp_send_log/i.test(sql)) {
      if (/WHERE send_log_id = \$1/i.test(sql)) {
        const row = state.logs.find((log) => log.send_log_id === Number(params[0]))

        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
      }

      const stale = state.logs.filter((log) =>
        ['SENDING', 'RETRYING'].includes(log.attempt_status),
      )

      return { rowCount: stale.length, rows: stale }
    }

    if (/UPDATE\s+tran_whatsapp_send_log/i.test(sql)) {
      const targetId = Number(params[0])
      const row = state.logs.find((log) => log.send_log_id === targetId)

      if (row) {
        if (/attempt_status = COALESCE/i.test(sql)) {
          row.attempt_status = params[1] ?? row.attempt_status
          row.failure_category = params[2]
          row.retryable = params[3] ?? row.retryable
          row.http_status = params[4]
          row.http_status_text = params[5]
          row.meta_message_id = params[6] || row.meta_message_id || ''
          row.meta_response = params[7] ? JSON.parse(params[7]) : row.meta_response
          row.meta_error_code = params[9]
          row.meta_error_message = params[11]
          row.network_error_code = params[13]
          row.network_error_message = params[14]
          row.request_completed_at = params[16]
          row.duration_ms = params[17]
          row.next_retry_at = params[18]
        } else if (/next_retry_at = \$2/i.test(sql)) {
          row.next_retry_at = params[1]
          row.parent_send_log_id = params[2]
        } else if (/attempt_status = 'CANCELLED'/i.test(sql)) {
          if (row.attempt_status !== 'RETRY_SCHEDULED') {
            return { rowCount: 0, rows: [] }
          }
          row.attempt_status = 'CANCELLED'
          row.retryable = false

          return { rowCount: 1, rows: [row] }
        } else if (/attempt_status = 'MANUAL_REVIEW'/i.test(sql)) {
          if (row.attempt_status === 'SENT') {
            return { rowCount: 0, rows: [] }
          }
          row.attempt_status = 'MANUAL_REVIEW'
          row.retryable = false

          return { rowCount: 1, rows: [row] }
        } else if (/attempt_status = \$2/i.test(sql)) {
          row.attempt_status = params[1]
        }
      }

      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] }
    }

    if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
      state.source = {
        ...(state.source ?? {}),
        lastParams: params,
      }

      return { rowCount: 1, rows: [] }
    }

    throw new Error(`Unexpected SQL in send service test: ${sql}`)
  }

  return {
    state,
    async connect() {
      return {
        query,
        release() {},
      }
    },
    query,
  }
}

test('successful send stores Meta message ID and safe response diagnostics', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: testEnv,
    fetchImpl: async (_url, options) => {
      assert.doesNotMatch(String(options.headers.Authorization), /\[REDACTED\]/)

      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.sent' }],
      }), { status: 200, statusText: 'OK' })
    },
    piNumber: 'HAL-0001',
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceWhatsappMessageId: 'wamid.source',
    to: '917733850017',
  })

  assert.equal(result.ok, true)
  assert.equal(result.metaMessageId, 'wamid.sent')
  assert.equal(pool.state.logs[0].attempt_status, 'SENT')
  assert.equal(pool.state.logs[0].meta_message_id, 'wamid.sent')
})

test('access token is absent from saved request payload and response', async () => {
  const pool = createSendPool()
  await sendLoggedWhatsAppTextMessage({
    body: 'Token EAATESTSECRET_SHOULD_NOT_BE_LOGGED should be redacted',
    env: testEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        access_token: 'EAATESTSECRET_SHOULD_NOT_BE_LOGGED',
        messages: [{ id: 'wamid.safe' }],
      }), { status: 200 }),
    piNumber: 'HAL-0001',
    pool,
    purpose: MESSAGE_PURPOSES.PI_SUMMARY,
    sourceWhatsappMessageId: 'wamid.source',
    to: '917733850017',
  })
  const serializedLog = JSON.stringify(pool.state.logs)

  assert.doesNotMatch(serializedLog, /EAATESTSECRET_SHOULD_NOT_BE_LOGGED/)
  assert.match(serializedLog, /\[REDACTED\]/)
})

test('HTTP error response is stored safely', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: { ...testEnv, WHATSAPP_SEND_RETRY_ENABLED: 'false' },
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: {
          code: 100,
          fbtrace_id: 'trace-1',
          message: 'Bad request',
          type: 'OAuthException',
        },
      }), { status: 400, statusText: 'Bad Request' }),
    pool,
    purpose: MESSAGE_PURPOSES.MANUAL_TEST,
    sourceWhatsappMessageId: 'wamid.http',
    to: '917733850017',
  })

  assert.equal(result.failureCategory, SEND_FAILURE_CATEGORIES.INVALID_REQUEST)
  assert.equal(pool.state.logs[0].http_status, 400)
  assert.equal(pool.state.logs[0].meta_error_message, 'Bad request')
})

test('Meta code 190 becomes TOKEN_EXPIRED', () => {
  assert.equal(
    classifyMetaFailure({ error: { code: '190' }, httpStatus: 400 }),
    SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED,
  )
})

test('non-allowed tester becomes TEST_NUMBER_NOT_ALLOWED', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: testEnv,
    fetchImpl: async () => new Response('{}', { status: 200 }),
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceWhatsappMessageId: 'wamid.notallowed',
    to: '918888888888',
  })

  assert.equal(result.failureCategory, SEND_FAILURE_CATEGORIES.TEST_NUMBER_NOT_ALLOWED)
  assert.equal(result.retryable, false)
  assert.equal(pool.state.logs[0].attempt_status, 'PERMANENTLY_FAILED')
})

test('network failure categories are normalized', () => {
  assert.equal(
    classifyNetworkError({ cause: { code: 'ENOTFOUND' }, message: 'fetch failed' }),
    SEND_FAILURE_CATEGORIES.NETWORK_DNS_ERROR,
  )
  assert.equal(
    classifyNetworkError({ cause: { code: 'ECONNRESET' }, message: 'fetch failed' }),
    SEND_FAILURE_CATEGORIES.NETWORK_CONNECTION_ERROR,
  )
  assert.equal(
    classifyNetworkError({ name: 'AbortError', message: 'This operation was aborted' }),
    SEND_FAILURE_CATEGORIES.NETWORK_TIMEOUT,
  )
  assert.equal(
    classifyNetworkError({ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
    SEND_FAILURE_CATEGORIES.TLS_ERROR,
  )
})

test('HTTP 429 and 500 classifications are retryable', () => {
  assert.equal(
    classifyMetaFailure({ error: {}, httpStatus: 429 }),
    SEND_FAILURE_CATEGORIES.RATE_LIMITED,
  )
  assert.equal(
    classifyMetaFailure({ error: {}, httpStatus: 500 }),
    SEND_FAILURE_CATEGORIES.META_SERVER_ERROR,
  )
  assert.equal(isRetryableFailureCategory(SEND_FAILURE_CATEGORIES.RATE_LIMITED), true)
  assert.equal(isRetryableFailureCategory(SEND_FAILURE_CATEGORIES.META_SERVER_ERROR), true)
})

test('transient Meta failure schedules retry', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: testEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: { code: 2, message: 'Temporary failure' },
      }), { status: 500 }),
    piNumber: 'HAL-0001',
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceWhatsappMessageId: 'wamid.retry',
    to: '917733850017',
  })

  assert.equal(result.status, SEND_ATTEMPT_STATUSES.RETRY_SCHEDULED)
  assert.equal(result.retryScheduled, true)
  assert.equal(pool.state.logs.length, 2)
  assert.equal(pool.state.logs[1].attempt_status, 'RETRY_SCHEDULED')
})

test('permanent failure does not schedule retry', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: testEnv,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        error: { code: 190, message: 'Expired' },
      }), { status: 400 }),
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceWhatsappMessageId: 'wamid.permanent',
    to: '917733850017',
  })

  assert.equal(result.failureCategory, SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED)
  assert.equal(result.retryScheduled, false)
  assert.equal(pool.state.logs.length, 1)
})

test('maximum attempts become permanently failed', async () => {
  const pool = createSendPool()
  const result = await sendLoggedWhatsAppTextMessage({
    attemptNumber: 4,
    body: 'Hello',
    env: testEnv,
    fetchImpl: async () => new Response('{}', { status: 500 }),
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceWhatsappMessageId: 'wamid.max',
    to: '917733850017',
  })

  assert.equal(result.status, SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED)
  assert.equal(pool.state.logs.length, 1)
})

test('duplicate successful logical send is skipped', async () => {
  const pool = createSendPool({
    logs: [{
      attempt_status: 'SENT',
      message_purpose: MESSAGE_PURPOSES.PI_SUMMARY,
      meta_message_id: 'wamid.existing',
      pi_number: 'HAL-0001',
      source_whatsapp_message_id: 'wamid.source',
    }],
  })
  let fetchCalls = 0
  const result = await sendLoggedWhatsAppTextMessage({
    body: 'Hello',
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response('{}', { status: 200 })
    },
    piNumber: 'HAL-0001',
    pool,
    purpose: MESSAGE_PURPOSES.PI_SUMMARY,
    sourceWhatsappMessageId: 'wamid.source',
    to: '917733850017',
  })

  assert.equal(result.status, SEND_FAILURE_CATEGORIES.DUPLICATE_SKIPPED)
  assert.equal(fetchCalls, 0)
})

test('retry worker claim prevents duplicate claims', async () => {
  const pool = createSendPool({
    logs: [{
      attempt_number: 2,
      attempt_status: 'RETRY_SCHEDULED',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    }],
  })

  await ensureWhatsAppSendLogSchema(pool)
  const firstClaim = await claimRetryJobs({ pool })
  const secondClaim = await claimRetryJobs({ pool })

  assert.equal(firstClaim.length, 1)
  assert.equal(firstClaim[0].attempt_status, 'RETRYING')
  assert.equal(secondClaim.length, 0)
})

test('stale sending attempt is recovered and scheduled', async () => {
  const pool = createSendPool({
    logs: [{
      attempt_number: 1,
      attempt_status: 'SENDING',
      request_started_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    }],
  })

  const recovered = await recoverStaleSendAttempts({ env: testEnv, pool })

  assert.deepEqual(recovered, [1])
  assert.equal(pool.state.logs[0].attempt_status, 'STALE')
  assert.equal(pool.state.logs.some((log) => log.attempt_status === 'RETRY_SCHEDULED'), true)
})

test('manual retry, cancel, and manual review preserve history', async () => {
  const pool = createSendPool({
    logs: [{
      attempt_number: 1,
      attempt_status: 'FAILED',
      retry_batch_id: '8a12a984-47b3-4a53-b71d-0678ad122222',
    }],
  })

  const manualRetry = await createManualRetryFromLog({ pool, sendLogId: 1 })

  assert.equal(manualRetry.success, true)
  assert.equal(pool.state.logs.length, 2)
  assert.equal(pool.state.logs[0].attempt_status, 'FAILED')

  const cancelled = await cancelScheduledRetry({ pool, sendLogId: 2 })

  assert.equal(cancelled.attemptStatus, 'CANCELLED')

  const manualReview = await markSendForManualReview({ pool, sendLogId: 1 })

  assert.equal(manualReview.attemptStatus, 'MANUAL_REVIEW')
})

test('scheduled PI summary retry succeeds without resending acknowledgement', async () => {
  const pool = createSendPool({
    logs: [{
      attempt_number: 2,
      attempt_status: 'RETRYING',
      message_purpose: MESSAGE_PURPOSES.PI_SUMMARY,
      pi_number: 'HAL-0001',
      send_log_id: 1,
      source_whatsapp_message_id: 'wamid.source',
    }],
    source: {},
  })
  let fetchCalls = 0
  const result = await processRetryJob({
    env: testEnv,
    fetchImpl: async () => {
      fetchCalls += 1

      return new Response(JSON.stringify({
        messages: [{ id: 'wamid.summary-retry-sent' }],
      }), { status: 200 })
    },
    job: pool.state.logs[0],
    pool,
  })

  assert.equal(fetchCalls, 1)
  assert.equal(result.status, SEND_ATTEMPT_STATUSES.SENT)
  assert.equal(pool.state.logs[0].attempt_status, SEND_ATTEMPT_STATUSES.SENT)
  assert.equal(pool.state.source.lastParams[1], SEND_ATTEMPT_STATUSES.SENT)
  assert.equal(pool.state.logs.length, 1)
})

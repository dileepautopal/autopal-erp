import crypto from 'node:crypto'
import {
  logWhatsAppOutgoingEarlyReturn,
  logWhatsAppOutgoingTrace,
} from './whatsappOutgoingTrace.js'

const SEND_LOG_TABLE_NAME = 'tran_whatsapp_send_log'
const INCOMING_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'

const MESSAGE_PURPOSES = {
  AUTO_ACKNOWLEDGEMENT: 'AUTO_ACKNOWLEDGEMENT',
  CHANGE_REQUEST_ACK: 'CHANGE_REQUEST_ACK',
  CLARIFICATION_REQUEST: 'CLARIFICATION_REQUEST',
  CUSTOMER_CONFIRMATION_ACK: 'CUSTOMER_CONFIRMATION_ACK',
  MANUAL_TEST: 'MANUAL_TEST',
  PI_PDF: 'PI_PDF',
  PI_SUMMARY: 'PI_SUMMARY',
}

const SEND_ATTEMPT_STATUSES = {
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  PENDING: 'PENDING',
  PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  RETRYING: 'RETRYING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  SKIPPED: 'SKIPPED',
  STALE: 'STALE',
}

const SEND_FAILURE_CATEGORIES = {
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  DUPLICATE_SKIPPED: 'DUPLICATE_SKIPPED',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  INVALID_REQUEST: 'INVALID_REQUEST',
  META_SERVER_ERROR: 'META_SERVER_ERROR',
  NETWORK_CONNECTION_ERROR: 'NETWORK_CONNECTION_ERROR',
  NETWORK_DNS_ERROR: 'NETWORK_DNS_ERROR',
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  PERMISSION_ERROR: 'PERMISSION_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SESSION_WINDOW_CLOSED: 'SESSION_WINDOW_CLOSED',
  SUCCESS: 'SUCCESS',
  TEST_NUMBER_NOT_ALLOWED: 'TEST_NUMBER_NOT_ALLOWED',
  TLS_ERROR: 'TLS_ERROR',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
}

const RETRYABLE_FAILURE_CATEGORIES = new Set([
  SEND_FAILURE_CATEGORIES.META_SERVER_ERROR,
  SEND_FAILURE_CATEGORIES.NETWORK_CONNECTION_ERROR,
  SEND_FAILURE_CATEGORIES.NETWORK_DNS_ERROR,
  SEND_FAILURE_CATEGORIES.NETWORK_TIMEOUT,
  SEND_FAILURE_CATEGORIES.RATE_LIMITED,
])

const DEFAULT_RETRY_DELAYS_SECONDS = [0, 30, 120, 600]
const SAFE_JSON_MAX_LENGTH = 12000
const SAFE_MESSAGE_MAX_LENGTH = 4000

const toText = (value) => String(value ?? '').trim()

const logWhatsAppSendDiagnostic = (event, details = {}) => {
  logWhatsAppOutgoingTrace(event, {
    currentFile: 'backend/whatsappSendService.js',
    currentFunction: details.currentFunction ?? 'whatsappSendService',
    ...sanitizeForLog(details),
  })
}

const logWhatsAppSendDatabaseError = (event, error) => {
  console.error(
    JSON.stringify({
      column: error?.column ?? '',
      constraint: error?.constraint ?? '',
      currentFile: 'backend/whatsappSendService.js',
      currentFunction: 'insertOrUpdateSendLog',
      detail: error?.detail ?? '',
      event,
      fullError: sanitizeForLog({
        code: error?.code,
        detail: error?.detail,
        message: error?.message,
        schema: error?.schema,
        severity: error?.severity,
        table: error?.table,
      }),
      message: error instanceof Error ? error.message : String(error),
      scope: 'whatsapp-outgoing',
      sqlstate: error?.code ?? '',
      table: error?.table ?? '',
      timestamp: new Date().toISOString(),
    }),
  )
}

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const toInteger = (value, fallback = 0) => {
  const number = Number.parseInt(String(value ?? ''), 10)

  return Number.isFinite(number) ? number : fallback
}

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y'].includes(toText(value).toLowerCase())
}

const normalizePhoneDigits = (value) => {
  const digits = toText(value).replace(/\D+/g, '')

  return digits.length > 10 ? digits.slice(-12) : digits
}

const getAllowedTesterNumbers = (env = process.env) =>
  toText(env.WHATSAPP_ALLOWED_TEST_NUMBERS)
    .split(',')
    .map(normalizePhoneDigits)
    .filter(Boolean)

const isAllowedTesterNumber = (phone, config = getWhatsAppSendConfig()) => {
  const normalizedPhone = normalizePhoneDigits(phone)

  if (!normalizedPhone) {
    return false
  }

  if (config.mode !== 'development') {
    return true
  }

  return config.allowedTesterNumbers.includes(normalizedPhone)
}

const normalizeGraphApiBase = (value) =>
  (toText(value) || 'https://graph.facebook.com/v20.0').replace(/\/+$/, '')

const getGraphApiVersion = (baseUrl) => {
  const match = toText(baseUrl).match(/\/(v\d+(?:\.\d+)?)\b/i)

  return match?.[1] ?? ''
}

const getWhatsAppSendConfig = (env = process.env) => {
  const graphApiBase = normalizeGraphApiBase(env.WHATSAPP_GRAPH_API_BASE)

  return {
    accessToken: toText(env.WHATSAPP_ACCESS_TOKEN),
    allowedTesterNumbers: getAllowedTesterNumbers(env),
    graphApiBase,
    graphApiVersion: getGraphApiVersion(graphApiBase),
    mode: toText(env.WHATSAPP_AUTO_ACK_MODE || 'development').toLowerCase(),
    phoneNumberId: toText(env.WHATSAPP_PHONE_NUMBER_ID),
  }
}

const getWhatsAppRetryPolicy = (env = process.env) => ({
  enabled: parseBooleanEnv(env.WHATSAPP_SEND_RETRY_ENABLED, true),
  maxAttempts: Math.max(toInteger(env.WHATSAPP_SEND_MAX_ATTEMPTS, 4), 1),
  maxDelaySeconds: Math.max(toInteger(env.WHATSAPP_SEND_RETRY_MAX_DELAY_SECONDS, 600), 1),
  requestTimeoutMs: Math.max(toInteger(env.WHATSAPP_SEND_REQUEST_TIMEOUT_MS, 15000), 1000),
  retentionDays: Math.max(toInteger(env.WHATSAPP_SEND_LOG_RETENTION_DAYS, 180), 1),
  retryDelaySeconds: Math.max(toInteger(env.WHATSAPP_SEND_RETRY_DELAY_SECONDS, 30), 1),
  staleAfterMinutes: Math.max(toInteger(env.WHATSAPP_SEND_STALE_AFTER_MINUTES, 5), 1),
})

const isRetryableFailureCategory = (category) =>
  RETRYABLE_FAILURE_CATEGORIES.has(toText(category).toUpperCase())

const getNextRetryDelaySeconds = (attemptNumber, policy = getWhatsAppRetryPolicy()) => {
  const configuredBase = Math.max(policy.retryDelaySeconds, 1)
  const configured = DEFAULT_RETRY_DELAYS_SECONDS[attemptNumber - 1]
  const exponential = configured ?? configuredBase * 2 ** Math.max(attemptNumber - 2, 0)

  return Math.min(exponential, policy.maxDelaySeconds)
}

const getNextRetryAt = (attemptNumber, policy = getWhatsAppRetryPolicy()) => {
  const delaySeconds = getNextRetryDelaySeconds(attemptNumber, policy)

  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}

const redactString = (value) => {
  const text = String(value ?? '')

  if (!text) {
    return text
  }

  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/EA[A-Za-z0-9._-]{12,}/g, '[REDACTED]')
    .slice(0, SAFE_MESSAGE_MAX_LENGTH)
}

const sanitizeForLog = (value, depth = 0) => {
  if (value === null || value === undefined) {
    return value
  }

  if (depth > 8) {
    return '[TRUNCATED]'
  }

  if (typeof value === 'string') {
    return redactString(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 60).map((item) => sanitizeForLog(item, depth + 1))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/authorization|cookie|password|secret|token/i.test(key))
        .map(([key, nestedValue]) => [key, sanitizeForLog(nestedValue, depth + 1)]),
    )
  }

  return redactString(value)
}

const jsonForDatabase = (value) => {
  if (value === null || value === undefined) {
    return null
  }

  const safeValue = sanitizeForLog(value)
  const serialized = JSON.stringify(safeValue)

  if (serialized.length <= SAFE_JSON_MAX_LENGTH) {
    return serialized
  }

  return JSON.stringify({
    truncated: true,
    preview: serialized.slice(0, SAFE_JSON_MAX_LENGTH),
  })
}

const readResponsePayload = async (response) => {
  const text = await response.text()

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

const extractMetaMessageId = (payload) =>
  toText(payload?.messages?.[0]?.id ?? payload?.message_id ?? '')

const getMetaError = (payload = {}) => {
  const error = payload?.error ?? {}

  return {
    code: toText(error.code),
    fbtraceId: toText(error.fbtrace_id),
    message: toText(error.message || payload.message),
    subcode: toText(error.error_subcode ?? error.subcode),
    type: toText(error.type),
  }
}

const getErrorCodeFromCause = (error = {}) =>
  toText(
    error.code ||
      error.errno ||
      error.cause?.code ||
      error.cause?.errno ||
      error.cause?.name,
  ).toUpperCase()

const getSafeNetworkError = (error = {}) => {
  const cause = error.cause ?? {}

  return {
    address: toText(cause.address),
    causeCode: toText(cause.code || cause.errno),
    causeMessage: redactString(cause.message || ''),
    code: toText(error.code || cause.code || cause.errno),
    hostname: toText(cause.hostname),
    message: redactString(error.message || cause.message || 'Network request failed.'),
    name: toText(error.name || cause.name || 'Error'),
    port: toText(cause.port),
    syscall: toText(cause.syscall),
  }
}

const classifyNetworkError = (error = {}) => {
  const code = getErrorCodeFromCause(error)
  const name = toText(error.name).toUpperCase()
  const message = toText(error.message).toUpperCase()

  if (name === 'ABORTERROR' || code === 'ABORT_ERR') {
    return SEND_FAILURE_CATEGORIES.NETWORK_TIMEOUT
  }

  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return SEND_FAILURE_CATEGORIES.NETWORK_DNS_ERROR
  }

  if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code)) {
    return SEND_FAILURE_CATEGORIES.NETWORK_CONNECTION_ERROR
  }

  if (
    ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(
      code,
    ) ||
    message.includes('TIMEOUT')
  ) {
    return SEND_FAILURE_CATEGORIES.NETWORK_TIMEOUT
  }

  if (
    code.includes('CERT') ||
    code.includes('TLS') ||
    code.includes('SIGNATURE') ||
    code.includes('VERIFY') ||
    code.includes('SSL') ||
    message.includes('CERTIFICATE')
  ) {
    return SEND_FAILURE_CATEGORIES.TLS_ERROR
  }

  return SEND_FAILURE_CATEGORIES.UNKNOWN_ERROR
}

const classifyMetaFailure = ({ error, httpStatus = 0 }) => {
  const code = toText(error?.code)
  const subcode = toText(error?.subcode)

  if (code === '190') {
    return SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED
  }

  if (code === '131047') {
    return SEND_FAILURE_CATEGORIES.SESSION_WINDOW_CLOSED
  }

  if (httpStatus === 429 || code === '4' || code === '17' || code === '613') {
    return SEND_FAILURE_CATEGORIES.RATE_LIMITED
  }

  if ([500, 502, 503, 504].includes(Number(httpStatus))) {
    return SEND_FAILURE_CATEGORIES.META_SERVER_ERROR
  }

  if (
    [401, 403].includes(Number(httpStatus)) ||
    ['10', '200', '201', '368'].includes(code) ||
    subcode === '33'
  ) {
    return SEND_FAILURE_CATEGORIES.PERMISSION_ERROR
  }

  if (['131026', '131030', '131031', '131052'].includes(code)) {
    return SEND_FAILURE_CATEGORIES.INVALID_RECIPIENT
  }

  if (Number(httpStatus) === 400) {
    return SEND_FAILURE_CATEGORIES.INVALID_REQUEST
  }

  return SEND_FAILURE_CATEGORIES.UNKNOWN_ERROR
}

const buildTextPayload = ({ body, contextMessageId = '', to }) => {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    text: {
      body: toText(body),
      preview_url: false,
    },
    to: normalizePhoneDigits(to),
    type: 'text',
  }

  if (contextMessageId) {
    payload.context = {
      message_id: contextMessageId,
    }
  }

  return payload
}

const buildRequestUrl = (config) =>
  `${config.graphApiBase}/${encodeURIComponent(config.phoneNumberId)}/messages`

let sendLogSchemaPromise

const ensureWhatsAppSendLogSchema = async (pool) => {
  if (!sendLogSchemaPromise) {
    sendLogSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SEND_LOG_TABLE_NAME} (
          send_log_id bigserial PRIMARY KEY,
          source_message_record_id bigint,
          source_whatsapp_message_id varchar(160),
          pi_number varchar(40),
          customer_id bigint,
          sender_phone varchar(50),
          destination_phone varchar(50),
          message_purpose varchar(80) NOT NULL,
          message_type varchar(40) NOT NULL DEFAULT 'text',
          message_body text,
          request_payload jsonb,
          request_url text,
          graph_api_version varchar(20),
          phone_number_id varchar(80),
          attempt_number integer NOT NULL DEFAULT 1,
          attempt_status varchar(40) NOT NULL DEFAULT 'PENDING',
          failure_category varchar(80),
          retryable boolean NOT NULL DEFAULT false,
          http_status integer,
          http_status_text text,
          meta_message_id varchar(160),
          meta_response jsonb,
          meta_error_type varchar(120),
          meta_error_code varchar(80),
          meta_error_subcode varchar(80),
          meta_error_message text,
          meta_fbtrace_id varchar(160),
          network_error_code varchar(120),
          network_error_message text,
          request_started_at timestamptz,
          request_completed_at timestamptz,
          duration_ms integer,
          next_retry_at timestamptz,
          retry_batch_id uuid,
          parent_send_log_id bigint REFERENCES ${SEND_LOG_TABLE_NAME}(send_log_id),
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await pool.query(`
        ALTER TABLE ${SEND_LOG_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS source_message_record_id bigint,
          ADD COLUMN IF NOT EXISTS source_whatsapp_message_id varchar(160),
          ADD COLUMN IF NOT EXISTS pi_number varchar(40),
          ADD COLUMN IF NOT EXISTS customer_id bigint,
          ADD COLUMN IF NOT EXISTS sender_phone varchar(50),
          ADD COLUMN IF NOT EXISTS destination_phone varchar(50),
          ADD COLUMN IF NOT EXISTS message_purpose varchar(80),
          ADD COLUMN IF NOT EXISTS message_type varchar(40) NOT NULL DEFAULT 'text',
          ADD COLUMN IF NOT EXISTS message_body text,
          ADD COLUMN IF NOT EXISTS request_payload jsonb,
          ADD COLUMN IF NOT EXISTS request_url text,
          ADD COLUMN IF NOT EXISTS graph_api_version varchar(20),
          ADD COLUMN IF NOT EXISTS phone_number_id varchar(80),
          ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS attempt_status varchar(40) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS failure_category varchar(80),
          ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS http_status integer,
          ADD COLUMN IF NOT EXISTS http_status_text text,
          ADD COLUMN IF NOT EXISTS meta_message_id varchar(160),
          ADD COLUMN IF NOT EXISTS meta_response jsonb,
          ADD COLUMN IF NOT EXISTS meta_error_type varchar(120),
          ADD COLUMN IF NOT EXISTS meta_error_code varchar(80),
          ADD COLUMN IF NOT EXISTS meta_error_subcode varchar(80),
          ADD COLUMN IF NOT EXISTS meta_error_message text,
          ADD COLUMN IF NOT EXISTS meta_fbtrace_id varchar(160),
          ADD COLUMN IF NOT EXISTS network_error_code varchar(120),
          ADD COLUMN IF NOT EXISTS network_error_message text,
          ADD COLUMN IF NOT EXISTS request_started_at timestamptz,
          ADD COLUMN IF NOT EXISTS request_completed_at timestamptz,
          ADD COLUMN IF NOT EXISTS duration_ms integer,
          ADD COLUMN IF NOT EXISTS next_retry_at timestamptz,
          ADD COLUMN IF NOT EXISTS retry_batch_id uuid,
          ADD COLUMN IF NOT EXISTS parent_send_log_id bigint,
          ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_source_message
        ON ${SEND_LOG_TABLE_NAME} (source_whatsapp_message_id)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_pi_number
        ON ${SEND_LOG_TABLE_NAME} (pi_number)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_destination
        ON ${SEND_LOG_TABLE_NAME} (destination_phone)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_purpose
        ON ${SEND_LOG_TABLE_NAME} (message_purpose)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_status_retry
        ON ${SEND_LOG_TABLE_NAME} (attempt_status, next_retry_at)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_created_at
        ON ${SEND_LOG_TABLE_NAME} (created_at DESC, send_log_id DESC)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_meta_message
        ON ${SEND_LOG_TABLE_NAME} (meta_message_id)
        WHERE meta_message_id IS NOT NULL
      `)
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_send_log_unique_success
        ON ${SEND_LOG_TABLE_NAME}
          (
            COALESCE(source_whatsapp_message_id, ''),
            COALESCE(pi_number, ''),
            message_purpose
          )
        WHERE attempt_status = 'SENT'
      `)
    })()
  }

  try {
    await sendLogSchemaPromise
  } catch (error) {
    sendLogSchemaPromise = undefined
    throw error
  }
}

const insertSendLog = async (
  pool,
  {
    attemptNumber,
    attemptStatus,
    body,
    customerId = null,
    destinationPhone,
    graphApiVersion,
    messageType = 'text',
    phoneNumberId,
    piNumber = '',
    purpose,
    requestPayload,
    requestStartedAt = null,
    requestUrl,
    retryBatchId,
    sourceMessageRecordId = null,
    sourceWhatsappMessageId = '',
  },
) => {
  const values = [
    sourceMessageRecordId ? Number(sourceMessageRecordId) : null,
    toText(sourceWhatsappMessageId) || null,
    toText(piNumber) || null,
    customerId ? Number(customerId) : null,
    normalizePhoneDigits(destinationPhone) || null,
    purpose,
    messageType,
    redactString(body),
    jsonForDatabase(requestPayload),
    requestUrl,
    graphApiVersion,
    phoneNumberId,
    Number(attemptNumber) || 1,
    attemptStatus,
    requestStartedAt,
    retryBatchId,
  ]

  logWhatsAppSendDiagnostic('Creating send log', {
    attemptNumber: Number(attemptNumber) || 1,
    attemptStatus,
    currentFunction: 'insertSendLog',
    destinationPhone: normalizePhoneDigits(destinationPhone),
    messagePurpose: purpose,
    piNumber,
    sendLogInsertStarts: true,
    sourceWhatsappMessageId,
  })

  try {
    const result = await pool.query(
      `
        INSERT INTO ${SEND_LOG_TABLE_NAME}
          (
            source_message_record_id,
            source_whatsapp_message_id,
            pi_number,
            customer_id,
            sender_phone,
            destination_phone,
            message_purpose,
            message_type,
            message_body,
            request_payload,
            request_url,
            graph_api_version,
            phone_number_id,
            attempt_number,
            attempt_status,
            request_started_at,
            retry_batch_id
          )
        VALUES
          (
            $1, $2, $3, $4, $5, $5, $6, $7, $8, $9::jsonb, $10,
            $11, $12, $13, $14, $15::timestamptz, $16::uuid
          )
        RETURNING send_log_id
      `,
      values,
    )
    const sendLogId = Number(result.rows[0]?.send_log_id ?? 0)

    logWhatsAppSendDiagnostic('Send log inserted', {
      currentFunction: 'insertSendLog',
      destinationPhone: normalizePhoneDigits(destinationPhone),
      messagePurpose: purpose,
      piNumber,
      sendLogInsertStarts: true,
      sendLogInsertSucceeds: true,
      sendLogId,
      sourceWhatsappMessageId,
    })

    return sendLogId
  } catch (error) {
    logWhatsAppSendDatabaseError('Send log insert failed', error)
    throw error
  }
}

const updateSendLog = async (pool, sendLogId, fields = {}) => {
  logWhatsAppSendDiagnostic('Updating send log', {
    attemptStatus: fields.attemptStatus,
    currentFunction: 'updateSendLog',
    destinationPhone: fields.destinationPhone,
    failureCategory: fields.failureCategory,
    messagePurpose: fields.messagePurpose,
    piNumber: fields.piNumber,
    sendLogId,
    sourceWhatsappMessageId: fields.sourceWhatsappMessageId,
  })

  try {
    await pool.query(
      `
        UPDATE ${SEND_LOG_TABLE_NAME}
        SET
          attempt_status = COALESCE($2, attempt_status),
          failure_category = $3,
          retryable = COALESCE($4::boolean, retryable),
          http_status = $5,
          http_status_text = $6,
          meta_message_id = COALESCE($7, meta_message_id),
          meta_response = COALESCE($8::jsonb, meta_response),
          meta_error_type = $9,
          meta_error_code = $10,
          meta_error_subcode = $11,
          meta_error_message = $12,
          meta_fbtrace_id = $13,
          network_error_code = $14,
          network_error_message = $15,
          request_started_at = COALESCE($16::timestamptz, request_started_at),
          request_completed_at = COALESCE($17::timestamptz, request_completed_at),
          duration_ms = $18,
          next_retry_at = $19::timestamptz,
          updated_at = CURRENT_TIMESTAMP
        WHERE send_log_id = $1
      `,
      [
        sendLogId,
        fields.attemptStatus ?? null,
        fields.failureCategory ?? null,
        fields.retryable ?? null,
        fields.httpStatus ?? null,
        fields.httpStatusText ?? null,
        fields.metaMessageId ?? null,
        jsonForDatabase(fields.metaResponse),
        fields.metaErrorType ?? null,
        fields.metaErrorCode ?? null,
        fields.metaErrorSubcode ?? null,
        fields.metaErrorMessage ?? null,
        fields.metaFbtraceId ?? null,
        fields.networkErrorCode ?? null,
        fields.networkErrorMessage ?? null,
        fields.requestStartedAt ?? null,
        fields.requestCompletedAt ?? null,
        fields.durationMs ?? null,
        fields.nextRetryAt ?? null,
      ],
    )
  } catch (error) {
    logWhatsAppSendDatabaseError('Send log update failed', error)
    throw error
  }
}

const findSuccessfulSend = async (
  pool,
  {
    purpose,
    piNumber = '',
    sourceWhatsappMessageId = '',
  },
) => {
  if (!sourceWhatsappMessageId && !piNumber) {
    return null
  }

  const result = await pool.query(
    `
      SELECT send_log_id, meta_message_id
      FROM ${SEND_LOG_TABLE_NAME}
      WHERE attempt_status = 'SENT'
        AND message_purpose = $1
        AND COALESCE(source_whatsapp_message_id, '') = COALESCE($2, '')
        AND COALESCE(pi_number, '') = COALESCE($3, '')
      ORDER BY send_log_id DESC
      LIMIT 1
    `,
    [purpose, toText(sourceWhatsappMessageId) || null, toText(piNumber) || null],
  )

  return result.rows[0] ?? null
}

const createScheduledRetry = async (
  pool,
  {
    failedSendLogId,
    nextAttemptNumber,
    nextRetryAt,
    retryBatchId,
    sendContext,
  },
) => {
  return insertSendLog(pool, {
    ...sendContext,
    attemptNumber: nextAttemptNumber,
    attemptStatus: SEND_ATTEMPT_STATUSES.RETRY_SCHEDULED,
    requestStartedAt: null,
    retryBatchId,
  }).then(async (sendLogId) => {
    await pool.query(
      `
        UPDATE ${SEND_LOG_TABLE_NAME}
        SET
          next_retry_at = $2::timestamptz,
          parent_send_log_id = COALESCE(parent_send_log_id, $3::bigint),
          updated_at = CURRENT_TIMESTAMP
        WHERE send_log_id = $1
      `,
      [sendLogId, nextRetryAt, failedSendLogId],
    )

    logWhatsAppSendDiagnostic('Retry scheduled', {
      currentFunction: 'createScheduledRetry',
      failedSendLogId,
      messagePurpose: sendContext.purpose,
      nextAttemptNumber,
      nextRetryAt,
      piNumber: sendContext.piNumber,
      scheduledSendLogId: sendLogId,
      sourceWhatsappMessageId: sendContext.sourceWhatsappMessageId,
    })

    return sendLogId
  })
}

const makeResult = ({
  attemptNumber,
  attemptStatus,
  durationMs = 0,
  errorCode = '',
  errorMessage = '',
  failureCategory,
  httpStatus = null,
  httpStatusText = '',
  messagePurpose = '',
  metaError = {},
  metaMessageId = '',
  metaResponse = null,
  networkError = {},
  nextRetryAt = null,
  ok,
  retryScheduled = false,
  retryable,
  scheduledSendLogId = null,
  sendLogId = null,
  sourceWhatsappMessageId = '',
  status,
}) => ({
  attemptNumber,
  attemptStatus,
  durationMs,
  errorCode,
  errorMessage,
  failureCategory,
  httpStatus,
  httpStatusText,
  messagePurpose,
  metaError,
  metaMessageId,
  metaResponse,
  networkError,
  nextRetryAt,
  ok,
  retryScheduled,
  retryable,
  scheduledSendLogId,
  sendLogId,
  sourceWhatsappMessageId,
  status,
})

const getSourceStatusForFailure = ({ failureCategory, purpose, retryable, retryScheduled }) => {
  if (retryScheduled && retryable) {
    return SEND_ATTEMPT_STATUSES.RETRY_SCHEDULED
  }

  if (purpose === MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT) {
    if (
      [
        SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
        SEND_FAILURE_CATEGORIES.PERMISSION_ERROR,
        SEND_FAILURE_CATEGORIES.TEST_NUMBER_NOT_ALLOWED,
        SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED,
      ].includes(failureCategory)
    ) {
      return failureCategory
    }
  }

  return SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED
}

const validateBeforeSend = ({ config, destinationPhone, env, payload }) => {
  if (!payload.text?.body) {
    return {
      category: SEND_FAILURE_CATEGORIES.INVALID_REQUEST,
      message: 'WhatsApp message body is required.',
    }
  }

  if (!config.accessToken) {
    return {
      category: SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
      code: 'WHATSAPP_ACCESS_TOKEN_MISSING',
      message: 'WHATSAPP_ACCESS_TOKEN is not configured.',
    }
  }

  if (!config.phoneNumberId) {
    return {
      category: SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
      code: 'WHATSAPP_PHONE_NUMBER_ID_MISSING',
      message: 'WHATSAPP_PHONE_NUMBER_ID is not configured.',
    }
  }

  if (!/^https?:\/\//i.test(config.graphApiBase)) {
    return {
      category: SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
      code: 'WHATSAPP_GRAPH_API_BASE_INVALID',
      message: 'WHATSAPP_GRAPH_API_BASE must be a valid URL.',
    }
  }

  if (!destinationPhone) {
    return {
      category: SEND_FAILURE_CATEGORIES.INVALID_RECIPIENT,
      code: 'MISSING_RECIPIENT',
      message: 'Recipient phone number is required.',
    }
  }

  if (
    config.mode === 'development' &&
    !isAllowedTesterNumber(destinationPhone, {
      ...config,
      allowedTesterNumbers: getAllowedTesterNumbers(env),
    })
  ) {
    return {
      category: SEND_FAILURE_CATEGORIES.TEST_NUMBER_NOT_ALLOWED,
      code: 'TEST_NUMBER_NOT_ALLOWED',
      message: 'Destination phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.',
    }
  }

  return null
}

const finishFailure = async ({
  attemptNumber,
  config,
  currentAttemptStatus,
  durationMs,
  errorCode = '',
  errorMessage,
  failureCategory,
  httpStatus = null,
  httpStatusText = '',
  metaError = {},
  metaResponse = null,
  networkError = {},
  pool,
  policy,
  requestCompletedAt,
  retryBatchId,
  sendContext,
  sendLogId,
}) => {
  const retryable = isRetryableFailureCategory(failureCategory)
  const canRetry = Boolean(policy.enabled && retryable && attemptNumber < policy.maxAttempts)
  const attemptStatus = canRetry
    ? currentAttemptStatus
    : SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED

  if (pool && sendLogId) {
    await updateSendLog(pool, sendLogId, {
      attemptStatus,
      destinationPhone: sendContext.destinationPhone,
      durationMs,
      failureCategory,
      httpStatus,
      httpStatusText,
      metaErrorCode: metaError.code || errorCode || null,
      metaErrorMessage: metaError.message || errorMessage || null,
      metaErrorSubcode: metaError.subcode || null,
      metaErrorType: metaError.type || null,
      metaFbtraceId: metaError.fbtraceId || null,
      metaResponse,
      networkErrorCode: networkError.code || networkError.causeCode || errorCode || null,
      networkErrorMessage: networkError.message || errorMessage || null,
      messagePurpose: sendContext.purpose,
      piNumber: sendContext.piNumber,
      requestCompletedAt,
      retryable,
      sourceWhatsappMessageId: sendContext.sourceWhatsappMessageId,
    })
  }

  let scheduledSendLogId = null
  let nextRetryAt = null

  if (pool && sendLogId && canRetry) {
    nextRetryAt = getNextRetryAt(attemptNumber + 1, policy)
    scheduledSendLogId = await createScheduledRetry(pool, {
      failedSendLogId: sendLogId,
      nextAttemptNumber: attemptNumber + 1,
      nextRetryAt,
      retryBatchId,
      sendContext: {
        ...sendContext,
        graphApiVersion: config.graphApiVersion,
        phoneNumberId: config.phoneNumberId,
        requestUrl: buildRequestUrl(config),
      },
    })
  }

  const status = getSourceStatusForFailure({
    failureCategory,
    purpose: sendContext.purpose,
    retryable,
    retryScheduled: Boolean(scheduledSendLogId),
  })

  logWhatsAppSendDiagnostic('Shared sender completed', {
    attemptStatus,
    currentFunction: 'finishFailure',
    destinationPhone: sendContext.destinationPhone,
    failureCategory,
    metaApiCalled: Boolean(httpStatus || networkError.code || networkError.message || metaResponse),
    messagePurpose: sendContext.purpose,
    metaApiReturned: Boolean(httpStatus),
    piNumber: sendContext.piNumber,
    retryScheduled: Boolean(scheduledSendLogId),
    sendLogId,
    sharedSenderCalled: true,
    sourceWhatsappMessageId: sendContext.sourceWhatsappMessageId,
    status,
  })

  return makeResult({
    attemptNumber,
    attemptStatus,
    durationMs,
    errorCode: errorCode || metaError.code || networkError.code || failureCategory,
    errorMessage,
    failureCategory,
    httpStatus,
    httpStatusText,
    metaError,
    metaResponse,
    messagePurpose: sendContext.purpose,
    networkError,
    nextRetryAt,
    ok: false,
    retryScheduled: Boolean(scheduledSendLogId),
    retryable,
    scheduledSendLogId,
    sendLogId,
    sourceWhatsappMessageId: sendContext.sourceWhatsappMessageId,
    status,
  })
}

const sendLoggedWhatsAppTextMessage = async ({
  attemptNumber = 1,
  body,
  contextMessageId = '',
  customerId = null,
  destinationPhone = '',
  env = process.env,
  existingSendLogId = null,
  fetchImpl = globalThis.fetch,
  messageType = 'text',
  parentSendLogId = null,
  piNumber = '',
  pool = null,
  purpose = MESSAGE_PURPOSES.MANUAL_TEST,
  retryBatchId = null,
  sourceMessageRecordId = null,
  sourceWhatsappMessageId = '',
  timeoutMs = null,
  to = '',
} = {}) => {
  const config = getWhatsAppSendConfig(env)
  const policy = getWhatsAppRetryPolicy(env)
  const resolvedTimeoutMs = Math.max(toNumberValue(timeoutMs, policy.requestTimeoutMs), 1000)
  const destination = normalizePhoneDigits(destinationPhone || to)
  const requestUrl = buildRequestUrl(config)
  const payload = buildTextPayload({
    body,
    contextMessageId,
    to: destination,
  })
  const batchId = retryBatchId || crypto.randomUUID()
  const sendContext = {
    attemptNumber: Number(attemptNumber) || 1,
    body,
    customerId,
    destinationPhone: destination,
    graphApiVersion: config.graphApiVersion,
    messageType,
    phoneNumberId: config.phoneNumberId,
    piNumber,
    purpose,
    requestPayload: payload,
    requestUrl,
    retryBatchId: batchId,
    sourceMessageRecordId,
    sourceWhatsappMessageId,
  }

  logWhatsAppSendDiagnostic('Shared send service entered', {
    attemptNumber: sendContext.attemptNumber,
    currentFunction: 'sendLoggedWhatsAppTextMessage',
    destinationPhone: destination,
    hasPool: Boolean(pool),
    messagePurpose: purpose,
    piNumber,
    sharedSenderCalled: true,
    sourceWhatsappMessageId,
  })

  if (pool) {
    await ensureWhatsAppSendLogSchema(pool)

    const successful = await findSuccessfulSend(pool, {
      piNumber,
      purpose,
      sourceWhatsappMessageId,
    })

    if (successful) {
      const skippedLogId = await insertSendLog(pool, {
        ...sendContext,
        attemptStatus: SEND_ATTEMPT_STATUSES.SKIPPED,
        requestStartedAt: new Date().toISOString(),
      })
      await updateSendLog(pool, skippedLogId, {
        attemptStatus: SEND_ATTEMPT_STATUSES.SKIPPED,
        destinationPhone: destination,
        failureCategory: SEND_FAILURE_CATEGORIES.DUPLICATE_SKIPPED,
        messagePurpose: purpose,
        metaMessageId: successful.meta_message_id ?? null,
        piNumber,
        requestCompletedAt: new Date().toISOString(),
        retryable: false,
        sourceWhatsappMessageId,
      })

      logWhatsAppOutgoingEarlyReturn({
        currentFile: 'backend/whatsappSendService.js',
        currentFunction: 'sendLoggedWhatsAppTextMessage',
        destinationPhone: destination,
        messageId: sourceWhatsappMessageId,
        messagePurpose: purpose,
        metaApiCalled: false,
        piNumber,
        reason: 'A successful send already exists for this message purpose.',
        sendLogInsertStarts: true,
        sendLogInsertSucceeds: true,
        sharedSenderCalled: true,
      })

      return makeResult({
        attemptNumber: sendContext.attemptNumber,
        attemptStatus: SEND_ATTEMPT_STATUSES.SKIPPED,
        errorCode: SEND_FAILURE_CATEGORIES.DUPLICATE_SKIPPED,
        errorMessage: 'A successful send already exists for this message purpose.',
        failureCategory: SEND_FAILURE_CATEGORIES.DUPLICATE_SKIPPED,
        messagePurpose: purpose,
        metaMessageId: successful.meta_message_id ?? '',
        ok: true,
        retryable: false,
        sendLogId: skippedLogId,
        sourceWhatsappMessageId,
        status: SEND_FAILURE_CATEGORIES.DUPLICATE_SKIPPED,
      })
    }
  } else {
    logWhatsAppSendDiagnostic('Send log insert skipped', {
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      destinationPhone: destination,
      messagePurpose: purpose,
      piNumber,
      reason: 'No PostgreSQL pool was supplied to shared send service.',
      sharedSenderCalled: true,
      sourceWhatsappMessageId,
    })
  }

  const requestStartedAt = new Date().toISOString()
  const startedMs = Date.now()
  let sendLogId = existingSendLogId ? Number(existingSendLogId) : null

  if (pool) {
    if (sendLogId) {
      logWhatsAppSendDiagnostic('Send log insert skipped', {
        currentFunction: 'sendLoggedWhatsAppTextMessage',
        destinationPhone: destination,
        messagePurpose: purpose,
        piNumber,
        reason: 'Existing send_log_id is being retried, so a new insert is not required.',
        sendLogId,
        sharedSenderCalled: true,
        sourceWhatsappMessageId,
      })
      await pool.query(
        `
          UPDATE ${SEND_LOG_TABLE_NAME}
          SET
            attempt_status = $2,
            request_payload = $3::jsonb,
            request_url = $4,
            graph_api_version = $5,
            phone_number_id = $6,
            request_started_at = $7::timestamptz,
            request_completed_at = NULL,
            duration_ms = NULL,
            next_retry_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE send_log_id = $1
        `,
        [
          sendLogId,
          SEND_ATTEMPT_STATUSES.SENDING,
          jsonForDatabase(payload),
          requestUrl,
          config.graphApiVersion,
          config.phoneNumberId,
          requestStartedAt,
        ],
      )
    } else {
      sendLogId = await insertSendLog(pool, {
        ...sendContext,
        attemptStatus:
          sendContext.attemptNumber > 1
            ? SEND_ATTEMPT_STATUSES.RETRYING
            : SEND_ATTEMPT_STATUSES.SENDING,
        requestStartedAt,
      })
      if (parentSendLogId) {
        await pool.query(
          `
            UPDATE ${SEND_LOG_TABLE_NAME}
            SET parent_send_log_id = $2::bigint
            WHERE send_log_id = $1
          `,
          [sendLogId, parentSendLogId],
        )
      }
    }
  }

  if (!fetchImpl) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappSendService.js',
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      destinationPhone: destination,
      messageId: sourceWhatsappMessageId,
      messagePurpose: purpose,
      metaApiCalled: false,
      piNumber,
      reason: 'Fetch API is not available, so Meta API cannot be called.',
      sharedSenderCalled: true,
    })
    return finishFailure({
      attemptNumber: sendContext.attemptNumber,
      config,
      currentAttemptStatus: SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED,
      durationMs: Date.now() - startedMs,
      errorCode: 'FETCH_UNAVAILABLE',
      errorMessage: 'Fetch API is not available.',
      failureCategory: SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
      pool,
      policy,
      requestCompletedAt: new Date().toISOString(),
      retryBatchId: batchId,
      sendContext,
      sendLogId,
    })
  }

  const validationFailure = validateBeforeSend({
    config,
    destinationPhone: destination,
    env,
    payload,
  })

  if (validationFailure) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappSendService.js',
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      destinationPhone: destination,
      messageId: sourceWhatsappMessageId,
      messagePurpose: purpose,
      metaApiCalled: false,
      piNumber,
      reason: validationFailure.message,
      sharedSenderCalled: true,
    })
    return finishFailure({
      attemptNumber: sendContext.attemptNumber,
      config,
      currentAttemptStatus: SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED,
      durationMs: Date.now() - startedMs,
      errorCode: validationFailure.code || validationFailure.category,
      errorMessage: validationFailure.message,
      failureCategory: validationFailure.category,
      pool,
      policy,
      requestCompletedAt: new Date().toISOString(),
      retryBatchId: batchId,
      sendContext,
      sendLogId,
    })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs)

  try {
    logWhatsAppSendDiagnostic('Calling Meta API', {
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      destinationPhone: destination,
      metaApiCalled: true,
      messagePurpose: purpose,
      piNumber,
      requestUrl,
      sendLogId,
      sharedSenderCalled: true,
      sourceWhatsappMessageId,
    })
    const response = await fetchImpl(requestUrl, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    })
    const responsePayload = await readResponsePayload(response)
    const metaResponse = sanitizeForLog(responsePayload)
    const requestCompletedAt = new Date().toISOString()
    const durationMs = Date.now() - startedMs

    logWhatsAppSendDiagnostic('Meta API response received', {
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      httpStatus: response.status,
      metaApiCalled: true,
      metaApiReturned: true,
      messagePurpose: purpose,
      piNumber,
      sendLogId,
      sharedSenderCalled: true,
      sourceWhatsappMessageId,
    })

    if (response.ok) {
      const metaMessageId = extractMetaMessageId(responsePayload)

      if (pool && sendLogId) {
        await updateSendLog(pool, sendLogId, {
          attemptStatus: SEND_ATTEMPT_STATUSES.SENT,
          destinationPhone: destination,
          durationMs,
          failureCategory: SEND_FAILURE_CATEGORIES.SUCCESS,
          httpStatus: response.status,
          httpStatusText: response.statusText,
          messagePurpose: purpose,
          metaMessageId,
          metaResponse,
          piNumber,
          requestCompletedAt,
          retryable: false,
          sourceWhatsappMessageId,
        })
      }

      logWhatsAppSendDiagnostic('Shared sender completed', {
        attemptStatus: SEND_ATTEMPT_STATUSES.SENT,
        currentFunction: 'sendLoggedWhatsAppTextMessage',
        destinationPhone: destination,
        metaApiCalled: true,
        messagePurpose: purpose,
        metaApiReturned: true,
        piNumber,
        sendLogId,
        sharedSenderCalled: true,
        sourceWhatsappMessageId,
        status: SEND_ATTEMPT_STATUSES.SENT,
      })

      return makeResult({
        attemptNumber: sendContext.attemptNumber,
        attemptStatus: SEND_ATTEMPT_STATUSES.SENT,
        durationMs,
        failureCategory: SEND_FAILURE_CATEGORIES.SUCCESS,
        httpStatus: response.status,
        httpStatusText: response.statusText,
        messagePurpose: purpose,
        metaMessageId,
        metaResponse,
        ok: true,
        retryable: false,
        sendLogId,
        sourceWhatsappMessageId,
        status: SEND_ATTEMPT_STATUSES.SENT,
      })
    }

    const metaError = getMetaError(responsePayload)
    const failureCategory = classifyMetaFailure({
      error: metaError,
      httpStatus: response.status,
    })

    return finishFailure({
      attemptNumber: sendContext.attemptNumber,
      config,
      currentAttemptStatus: SEND_ATTEMPT_STATUSES.FAILED,
      durationMs,
      errorCode: metaError.code || String(response.status),
      errorMessage: metaError.message || `Meta send failed with HTTP ${response.status}.`,
      failureCategory,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      metaError,
      metaResponse,
      pool,
      policy,
      requestCompletedAt,
      retryBatchId: batchId,
      sendContext,
      sendLogId,
    })
  } catch (error) {
    logWhatsAppSendDiagnostic('Meta API network error received', {
      currentFunction: 'sendLoggedWhatsAppTextMessage',
      errorMessage: error instanceof Error ? error.message : String(error),
      metaApiCalled: true,
      metaApiReturned: false,
      messagePurpose: purpose,
      piNumber,
      sendLogId,
      sharedSenderCalled: true,
      sourceWhatsappMessageId,
    })
    const networkError = getSafeNetworkError(error)
    const failureCategory = classifyNetworkError(error)

    return finishFailure({
      attemptNumber: sendContext.attemptNumber,
      config,
      currentAttemptStatus: SEND_ATTEMPT_STATUSES.FAILED,
      durationMs: Date.now() - startedMs,
      errorCode: networkError.code || failureCategory,
      errorMessage: networkError.message || 'Meta send failed.',
      failureCategory,
      networkError,
      pool,
      policy,
      requestCompletedAt: new Date().toISOString(),
      retryBatchId: batchId,
      sendContext,
      sendLogId,
    })
  } finally {
    clearTimeout(timeout)
  }
}

const createManualWhatsAppTestLog = async ({
  body = 'AUTOPAL WhatsApp diagnostic test log.',
  destinationPhone = '',
  env = process.env,
  piNumber = '',
  pool,
  sourceWhatsappMessageId = '',
} = {}) => {
  if (!pool) {
    logWhatsAppSendDiagnostic('Send log insert skipped', {
      currentFunction: 'createManualWhatsAppTestLog',
      messagePurpose: MESSAGE_PURPOSES.MANUAL_TEST,
      reason: 'No PostgreSQL pool was supplied to manual test log endpoint.',
      sourceWhatsappMessageId,
    })

    throw new Error('PostgreSQL pool is required to create a manual WhatsApp test log.')
  }

  await ensureWhatsAppSendLogSchema(pool)

  const config = getWhatsAppSendConfig(env)
  const destination = normalizePhoneDigits(destinationPhone)
  const requestUrl = buildRequestUrl(config)
  const payload = buildTextPayload({
    body,
    to: destination || 'MANUAL_TEST',
  })

  const sendLogId = await insertSendLog(pool, {
    attemptNumber: 1,
    attemptStatus: SEND_ATTEMPT_STATUSES.SKIPPED,
    body,
    destinationPhone: destination || 'MANUAL_TEST',
    graphApiVersion: config.graphApiVersion,
    messageType: 'text',
    phoneNumberId: config.phoneNumberId,
    piNumber,
    purpose: MESSAGE_PURPOSES.MANUAL_TEST,
    requestPayload: {
      ...payload,
      diagnosticOnly: true,
      metaCallSkipped: true,
    },
    requestStartedAt: new Date().toISOString(),
    requestUrl,
    retryBatchId: crypto.randomUUID(),
    sourceWhatsappMessageId: sourceWhatsappMessageId || `manual-test-${Date.now()}`,
  })

  logWhatsAppSendDiagnostic('Manual test send log inserted', {
    currentFunction: 'createManualWhatsAppTestLog',
    destinationPhone: destination,
    messagePurpose: MESSAGE_PURPOSES.MANUAL_TEST,
    piNumber,
    sendLogInsertStarts: true,
    sendLogInsertSucceeds: true,
    sendLogId,
    sourceWhatsappMessageId,
  })

  return {
    attemptStatus: SEND_ATTEMPT_STATUSES.SKIPPED,
    messagePurpose: MESSAGE_PURPOSES.MANUAL_TEST,
    sendLogId,
  }
}

const applyWhatsAppSendResultToSource = async ({
  pool,
  result,
  sourceWhatsappMessageId = '',
}) => {
  if (!pool || !sourceWhatsappMessageId || !result) {
    return
  }

  await ensureWhatsAppSendLogSchema(pool)

  const purpose = toText(result.messagePurpose || result.purpose)
  const status = toText(result.status)
  const isSent = status === SEND_ATTEMPT_STATUSES.SENT
  const sentAt = isSent ? new Date().toISOString() : null
  const safeError = result.errorMessage
    ? `${result.failureCategory || result.errorCode}: ${result.errorMessage}`
    : result.failureCategory || result.errorCode || null

  if (purpose === MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT) {
    logWhatsAppSendDiagnostic('Updating tran_whatsapp_pi_messages', {
      acknowledgementStatusUpdated: true,
      currentFunction: 'applyWhatsAppSendResultToSource',
      messagePurpose: purpose,
      sourceWhatsappMessageId,
      status,
    })
    await pool.query(
      `
        UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
        SET
          acknowledgement_status = $2,
          acknowledgement_sent_at = COALESCE($3::timestamptz, acknowledgement_sent_at),
          acknowledgement_whatsapp_message_id = COALESCE($4, acknowledgement_whatsapp_message_id),
          acknowledgement_error = $5,
          acknowledgement_attempts = GREATEST(acknowledgement_attempts, $6::integer),
          reply_status = CASE
            WHEN $2 = 'SENT' THEN 'ACKNOWLEDGEMENT_SENT'
            ELSE $2
          END,
          pi_summary_status = CASE
            WHEN $2 = 'RETRY_SCHEDULED'
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN 'WAITING_FOR_ACKNOWLEDGEMENT'
            WHEN $7::boolean = TRUE
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN 'BLOCKED_BY_ACKNOWLEDGEMENT'
            ELSE pi_summary_status
          END,
          pi_summary_error = CASE
            WHEN $7::boolean = TRUE
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN $5
            ELSE pi_summary_error
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE message_id = $1
      `,
      [
        sourceWhatsappMessageId,
        status,
        sentAt,
        result.metaMessageId || null,
        safeError,
        Number(result.attemptNumber) || 1,
        !result.ok && !result.retryScheduled,
      ],
    )
    return
  }

  if (purpose === MESSAGE_PURPOSES.PI_SUMMARY) {
    logWhatsAppSendDiagnostic('Updating tran_whatsapp_pi_messages', {
      currentFunction: 'applyWhatsAppSendResultToSource',
      messagePurpose: purpose,
      piSummaryStatusUpdated: true,
      sourceWhatsappMessageId,
      status,
    })
    await pool.query(
      `
        UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
        SET
          pi_summary_status = $2,
          pi_summary_sent_at = COALESCE($3::timestamptz, pi_summary_sent_at),
          pi_summary_meta_message_id = COALESCE($4, pi_summary_meta_message_id),
          pi_summary_error = $5,
          customer_confirmation_status = CASE
            WHEN $2 = 'SENT' THEN 'AWAITING_CONFIRMATION'
            ELSE customer_confirmation_status
          END,
          reply_status = CASE
            WHEN $2 = 'SENT' THEN 'SUMMARY_SENT'
            ELSE reply_status
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE message_id = $1
      `,
      [
        sourceWhatsappMessageId,
        isSent
          ? SEND_ATTEMPT_STATUSES.SENT
          : result.retryScheduled
            ? SEND_ATTEMPT_STATUSES.RETRY_SCHEDULED
            : SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED,
        sentAt,
        result.metaMessageId || null,
        safeError,
      ],
    )
  }
}

const claimRetryJobs = async ({ limit = 5, pool } = {}) => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')
    const result = await client.query(
      `
        WITH claim AS (
          SELECT send_log_id
          FROM ${SEND_LOG_TABLE_NAME}
          WHERE attempt_status = 'RETRY_SCHEDULED'
            AND next_retry_at <= CURRENT_TIMESTAMP
          ORDER BY next_retry_at ASC, send_log_id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ${SEND_LOG_TABLE_NAME} log
        SET
          attempt_status = 'RETRYING',
          updated_at = CURRENT_TIMESTAMP
        FROM claim
        WHERE log.send_log_id = claim.send_log_id
        RETURNING log.*
      `,
      [Math.max(Math.min(Number(limit) || 5, 25), 1)],
    )
    await client.query('COMMIT')

    return result.rows
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const getIncomingSourceForSendLog = async (pool, sourceWhatsappMessageId = '') => {
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        sender_phone,
        draft_pi_no,
        processing_status,
        parse_status,
        acknowledgement_status,
        pi_summary_status,
        pi_summary_meta_message_id
      FROM ${INCOMING_MESSAGE_TABLE_NAME}
      WHERE message_id = $1
      ORDER BY id DESC
      LIMIT 1
    `,
    [toText(sourceWhatsappMessageId)],
  )

  return result.rows[0] ?? null
}

const recoverStaleSendAttempts = async ({ env = process.env, pool } = {}) => {
  const policy = getWhatsAppRetryPolicy(env)
  const staleResult = await pool.query(
    `
      SELECT *
      FROM ${SEND_LOG_TABLE_NAME}
      WHERE attempt_status IN ('SENDING', 'RETRYING')
        AND request_started_at < CURRENT_TIMESTAMP - ($1::integer * INTERVAL '1 minute')
        AND meta_message_id IS NULL
      ORDER BY request_started_at ASC
      LIMIT 25
    `,
    [policy.staleAfterMinutes],
  )
  const recovered = []

  for (const row of staleResult.rows) {
    const attemptNumber = Number(row.attempt_number ?? 1)
    const retryable = attemptNumber < policy.maxAttempts
    const nextRetryAt = retryable ? getNextRetryAt(attemptNumber + 1, policy) : null

    await updateSendLog(pool, row.send_log_id, {
      attemptStatus: SEND_ATTEMPT_STATUSES.STALE,
      failureCategory: SEND_FAILURE_CATEGORIES.UNKNOWN_ERROR,
      networkErrorCode: 'STALE_ATTEMPT',
      networkErrorMessage: 'Send attempt was left in progress and was recovered after restart.',
      retryable,
    })

    if (retryable && policy.enabled) {
      await createScheduledRetry(pool, {
        failedSendLogId: row.send_log_id,
        nextAttemptNumber: attemptNumber + 1,
        nextRetryAt,
        retryBatchId: row.retry_batch_id || crypto.randomUUID(),
        sendContext: {
          attemptNumber: attemptNumber + 1,
          body: row.message_body,
          customerId: row.customer_id,
          destinationPhone: row.destination_phone,
          graphApiVersion: row.graph_api_version,
          messageType: row.message_type,
          phoneNumberId: row.phone_number_id,
          piNumber: row.pi_number,
          purpose: row.message_purpose,
          requestPayload: row.request_payload,
          requestUrl: row.request_url,
          retryBatchId: row.retry_batch_id || crypto.randomUUID(),
          sourceMessageRecordId: row.source_message_record_id,
          sourceWhatsappMessageId: row.source_whatsapp_message_id,
        },
      })
    }

    recovered.push(row.send_log_id)
  }

  return recovered
}

const getWhatsAppSendHealth = async ({ pool } = {}) => {
  await ensureWhatsAppSendLogSchema(pool)
  const result = await pool.query(`
    SELECT
      MAX(request_completed_at) FILTER (WHERE attempt_status = 'SENT') AS last_success_at,
      MAX(request_completed_at) FILTER (WHERE attempt_status IN ('FAILED', 'PERMANENTLY_FAILED')) AS last_failed_at,
      (
        SELECT failure_category
        FROM ${SEND_LOG_TABLE_NAME}
        WHERE attempt_status IN ('FAILED', 'PERMANENTLY_FAILED')
        ORDER BY request_completed_at DESC NULLS LAST, send_log_id DESC
        LIMIT 1
      ) AS last_failure_category,
      COUNT(*) FILTER (WHERE attempt_status = 'RETRY_SCHEDULED') AS pending_retry_count,
      MIN(next_retry_at) FILTER (WHERE attempt_status = 'RETRY_SCHEDULED') AS oldest_retry_at,
      COUNT(*) FILTER (WHERE failure_category IN ('TOKEN_EXPIRED', 'CONFIGURATION_ERROR')) AS critical_failures,
      COUNT(*) FILTER (WHERE attempt_status IN ('FAILED', 'PERMANENTLY_FAILED')) AS failed_count
    FROM ${SEND_LOG_TABLE_NAME}
    WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
  `)
  const row = result.rows[0] ?? {}
  const pendingRetryCount = Number(row.pending_retry_count ?? 0)
  const criticalFailures = Number(row.critical_failures ?? 0)
  const failedCount = Number(row.failed_count ?? 0)
  const color =
    criticalFailures > 0 || failedCount >= 10
      ? 'RED'
      : pendingRetryCount > 0 || failedCount > 0
        ? 'YELLOW'
        : 'GREEN'

  return {
    color,
    lastFailedSend: row.last_failed_at ?? null,
    lastFailureCategory: row.last_failure_category ?? '',
    lastSuccessfulSend: row.last_success_at ?? null,
    oldestPendingRetryAt: row.oldest_retry_at ?? null,
    pendingRetryCount,
  }
}

const getWhatsAppSendMonitorSummary = async ({ pool } = {}) => {
  await ensureWhatsAppSendLogSchema(pool)
  const [summaryResult, health] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE attempt_status = 'SENT' AND created_at >= CURRENT_DATE) AS sent_today,
        COUNT(*) FILTER (WHERE attempt_status = 'PENDING') AS pending,
        COUNT(*) FILTER (WHERE attempt_status = 'RETRY_SCHEDULED') AS retry_scheduled,
        COUNT(*) FILTER (WHERE attempt_status = 'RETRYING') AS retrying,
        COUNT(*) FILTER (WHERE attempt_status = 'PERMANENTLY_FAILED') AS permanently_failed,
        COUNT(*) FILTER (WHERE failure_category = 'TOKEN_EXPIRED') AS token_expired,
        COUNT(*) FILTER (WHERE failure_category = 'TEST_NUMBER_NOT_ALLOWED') AS test_number_blocked,
        COUNT(*) FILTER (WHERE failure_category LIKE 'NETWORK_%') AS network_failures,
        COUNT(*) FILTER (WHERE failure_category IN ('META_SERVER_ERROR', 'RATE_LIMITED')) AS meta_api_failures
      FROM ${SEND_LOG_TABLE_NAME}
    `),
    getWhatsAppSendHealth({ pool }),
  ])
  const row = summaryResult.rows[0] ?? {}

  return {
    health,
    summary: {
      metaApiFailures: Number(row.meta_api_failures ?? 0),
      networkFailures: Number(row.network_failures ?? 0),
      pending: Number(row.pending ?? 0),
      permanentlyFailed: Number(row.permanently_failed ?? 0),
      retryScheduled: Number(row.retry_scheduled ?? 0),
      retrying: Number(row.retrying ?? 0),
      sentToday: Number(row.sent_today ?? 0),
      testNumberBlocked: Number(row.test_number_blocked ?? 0),
      tokenExpired: Number(row.token_expired ?? 0),
    },
  }
}

const buildSendLogFilters = (filters = {}) => {
  const clauses = []
  const values = []
  const add = (clause, value) => {
    values.push(value)
    clauses.push(clause.replace('?', `$${values.length}`))
  }

  if (toText(filters.startDate)) {
    add('created_at >= ?::date', toText(filters.startDate))
  }

  if (toText(filters.endDate)) {
    add('created_at < (?::date + INTERVAL \'1 day\')', toText(filters.endDate))
  }

  if (toText(filters.destinationPhone)) {
    add('destination_phone LIKE ?', `%${normalizePhoneDigits(filters.destinationPhone)}%`)
  }

  if (toText(filters.piNumber)) {
    add('pi_number ILIKE ?', `%${toText(filters.piNumber).replace(/[%_]/g, '\\$&')}%`)
  }

  if (toText(filters.sourceWhatsappMessageId)) {
    add('source_whatsapp_message_id ILIKE ?', `%${toText(filters.sourceWhatsappMessageId).replace(/[%_]/g, '\\$&')}%`)
  }

  if (toText(filters.messagePurpose)) {
    add('message_purpose = ?', toText(filters.messagePurpose).toUpperCase())
  }

  if (toText(filters.attemptStatus)) {
    add('attempt_status = ?', toText(filters.attemptStatus).toUpperCase())
  }

  if (toText(filters.failureCategory)) {
    add('failure_category = ?', toText(filters.failureCategory).toUpperCase())
  }

  if (filters.retryable !== undefined && filters.retryable !== '') {
    add('retryable = ?::boolean', parseBooleanEnv(filters.retryable, false))
  }

  if (toText(filters.metaMessageId)) {
    add('meta_message_id ILIKE ?', `%${toText(filters.metaMessageId).replace(/[%_]/g, '\\$&')}%`)
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  }
}

const mapSendLogRow = (row = {}) => ({
  attemptNumber: Number(row.attempt_number ?? 0),
  attemptStatus: row.attempt_status ?? '',
  createdAt: row.created_at ?? null,
  destinationPhone: row.destination_phone ?? '',
  durationMs: row.duration_ms ?? null,
  failureCategory: row.failure_category ?? '',
  httpStatus: row.http_status ?? null,
  httpStatusText: row.http_status_text ?? '',
  messageBody: row.message_body ?? '',
  messagePurpose: row.message_purpose ?? '',
  messageType: row.message_type ?? '',
  metaErrorCode: row.meta_error_code ?? '',
  metaErrorMessage: row.meta_error_message ?? '',
  metaErrorSubcode: row.meta_error_subcode ?? '',
  metaErrorType: row.meta_error_type ?? '',
  metaFbtraceId: row.meta_fbtrace_id ?? '',
  metaMessageId: row.meta_message_id ?? '',
  metaResponse: row.meta_response ?? null,
  networkErrorCode: row.network_error_code ?? '',
  networkErrorMessage: row.network_error_message ?? '',
  nextRetryAt: row.next_retry_at ?? null,
  piNumber: row.pi_number ?? '',
  requestCompletedAt: row.request_completed_at ?? null,
  requestPayload: row.request_payload ?? null,
  requestStartedAt: row.request_started_at ?? null,
  requestUrl: row.request_url ?? '',
  retryBatchId: row.retry_batch_id ?? '',
  retryable: Boolean(row.retryable),
  sendLogId: Number(row.send_log_id ?? 0),
  sourceMessageRecordId: row.source_message_record_id ?? null,
  sourceWhatsappMessageId: row.source_whatsapp_message_id ?? '',
})

const getWhatsAppSendLogs = async ({ filters = {}, limit = 50, pool } = {}) => {
  await ensureWhatsAppSendLogSchema(pool)
  const filterState = buildSendLogFilters(filters)
  const safeLimit = Math.max(Math.min(Number(limit) || 50, 200), 1)
  const result = await pool.query(
    `
      SELECT
        send_log_id,
        source_message_record_id,
        source_whatsapp_message_id,
        pi_number,
        destination_phone,
        message_purpose,
        message_type,
        message_body,
        request_payload,
        request_url,
        attempt_number,
        attempt_status,
        failure_category,
        retryable,
        http_status,
        http_status_text,
        meta_message_id,
        meta_response,
        meta_error_type,
        meta_error_code,
        meta_error_subcode,
        meta_error_message,
        meta_fbtrace_id,
        network_error_code,
        network_error_message,
        request_started_at,
        request_completed_at,
        duration_ms,
        next_retry_at,
        retry_batch_id,
        created_at
      FROM ${SEND_LOG_TABLE_NAME}
      ${filterState.sql}
      ORDER BY created_at DESC, send_log_id DESC
      LIMIT $${filterState.values.length + 1}
    `,
    [...filterState.values, safeLimit],
  )

  return {
    logs: result.rows.map(mapSendLogRow),
    returned: result.rowCount,
  }
}

const getWhatsAppSourceTimeline = async ({ messageId = '', pool } = {}) => {
  await ensureWhatsAppSendLogSchema(pool)
  const source = toText(messageId)
  const [messageResult, eventResult, sendResult] = await Promise.all([
    pool.query(
      `
        SELECT
          message_id,
          received_at,
          draft_pi_no,
          pi_created,
          processing_status,
          acknowledgement_status,
          acknowledgement_sent_at,
          acknowledgement_error,
          pi_summary_status,
          pi_summary_sent_at,
          pi_summary_error,
          updated_at
        FROM ${INCOMING_MESSAGE_TABLE_NAME}
        WHERE message_id = $1
        LIMIT 1
      `,
      [source],
    ),
    pool.query(
      `
        SELECT processing_status, parse_status, details, created_at
        FROM tran_whatsapp_pi_message_events
        WHERE message_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [source],
    ),
    pool.query(
      `
        SELECT *
        FROM ${SEND_LOG_TABLE_NAME}
        WHERE source_whatsapp_message_id = $1
        ORDER BY created_at ASC, send_log_id ASC
      `,
      [source],
    ),
  ])
  const message = messageResult.rows[0] ?? null
  const timeline = []

  if (message) {
    timeline.push({
      detail: 'Incoming WhatsApp message saved.',
      status: 'RECEIVED',
      timestamp: message.received_at,
      title: 'Message Received',
    })

    if (message.pi_created || message.draft_pi_no) {
      timeline.push({
        detail: message.draft_pi_no ? `Draft PI ${message.draft_pi_no}` : 'Draft PI created.',
        status: 'PI_CREATED',
        timestamp: message.updated_at,
        title: 'PI Created',
      })
    }
  }

  for (const row of eventResult.rows) {
    timeline.push({
      detail: row.details ?? null,
      status: row.processing_status ?? row.parse_status ?? '',
      timestamp: row.created_at,
      title: row.processing_status || row.parse_status || 'Processing Event',
    })
  }

  for (const row of sendResult.rows) {
    timeline.push({
      detail:
        row.failure_category || row.meta_message_id
          ? {
              error: row.meta_error_message || row.network_error_message || '',
              failureCategory: row.failure_category,
              metaMessageId: row.meta_message_id,
              nextRetryAt: row.next_retry_at,
            }
          : null,
      status: row.attempt_status,
      timestamp: row.request_completed_at || row.created_at,
      title: `${row.message_purpose} Attempt ${row.attempt_number} ${row.attempt_status}`,
    })
  }

  return {
    message: message
      ? {
          acknowledgementError: message.acknowledgement_error ?? '',
          acknowledgementSentAt: message.acknowledgement_sent_at,
          acknowledgementStatus: message.acknowledgement_status ?? '',
          draftPiNo: message.draft_pi_no ?? '',
          messageId: message.message_id,
          piCreated: Boolean(message.pi_created),
          piSummaryError: message.pi_summary_error ?? '',
          piSummarySentAt: message.pi_summary_sent_at,
          piSummaryStatus: message.pi_summary_status ?? '',
          processingStatus: message.processing_status ?? '',
          receivedAt: message.received_at,
        }
      : null,
    timeline: timeline.sort(
      (a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime(),
    ),
  }
}

const getSendLogForManualAction = async (pool, sendLogId) => {
  await ensureWhatsAppSendLogSchema(pool)
  const result = await pool.query(
    `
      SELECT *
      FROM ${SEND_LOG_TABLE_NAME}
      WHERE send_log_id = $1
      LIMIT 1
    `,
    [Number(sendLogId) || 0],
  )

  return result.rows[0] ?? null
}

const cancelScheduledRetry = async ({ pool, sendLogId } = {}) => {
  const result = await pool.query(
    `
      UPDATE ${SEND_LOG_TABLE_NAME}
      SET
        attempt_status = 'CANCELLED',
        retryable = FALSE,
        updated_at = CURRENT_TIMESTAMP
      WHERE send_log_id = $1
        AND attempt_status = 'RETRY_SCHEDULED'
      RETURNING *
    `,
    [Number(sendLogId) || 0],
  )

  return result.rows[0] ? mapSendLogRow(result.rows[0]) : null
}

const markSendForManualReview = async ({ pool, sendLogId } = {}) => {
  const result = await pool.query(
    `
      UPDATE ${SEND_LOG_TABLE_NAME}
      SET
        attempt_status = 'MANUAL_REVIEW',
        retryable = FALSE,
        updated_at = CURRENT_TIMESTAMP
      WHERE send_log_id = $1
        AND attempt_status <> 'SENT'
      RETURNING *
    `,
    [Number(sendLogId) || 0],
  )

  return result.rows[0] ? mapSendLogRow(result.rows[0]) : null
}

const createManualRetryFromLog = async ({ pool, sendLogId } = {}) => {
  const row = await getSendLogForManualAction(pool, sendLogId)

  if (!row) {
    return {
      message: 'Send log was not found.',
      success: false,
      statusCode: 404,
    }
  }

  const successful = await findSuccessfulSend(pool, {
    piNumber: row.pi_number,
    purpose: row.message_purpose,
    sourceWhatsappMessageId: row.source_whatsapp_message_id,
  })

  if (successful) {
    return {
      message: 'This logical WhatsApp send is already SENT.',
      success: false,
      statusCode: 409,
    }
  }

  const nextAttemptNumber = Number(row.attempt_number ?? 1) + 1
  const retryBatchId = row.retry_batch_id || crypto.randomUUID()
  const retryLogId = await insertSendLog(pool, {
    attemptNumber: nextAttemptNumber,
    attemptStatus: SEND_ATTEMPT_STATUSES.RETRY_SCHEDULED,
    body: row.message_body,
    customerId: row.customer_id,
    destinationPhone: row.destination_phone,
    graphApiVersion: row.graph_api_version,
    messageType: row.message_type,
    phoneNumberId: row.phone_number_id,
    piNumber: row.pi_number,
    purpose: row.message_purpose,
    requestPayload: row.request_payload,
    requestUrl: row.request_url,
    retryBatchId,
    sourceMessageRecordId: row.source_message_record_id,
    sourceWhatsappMessageId: row.source_whatsapp_message_id,
  })
  await pool.query(
    `
      UPDATE ${SEND_LOG_TABLE_NAME}
      SET
        next_retry_at = CURRENT_TIMESTAMP,
        parent_send_log_id = $2::bigint,
        updated_at = CURRENT_TIMESTAMP
      WHERE send_log_id = $1
    `,
    [retryLogId, row.send_log_id],
  )

  return {
    retryLogId,
    success: true,
  }
}

export {
  INCOMING_MESSAGE_TABLE_NAME,
  MESSAGE_PURPOSES,
  SEND_ATTEMPT_STATUSES,
  SEND_FAILURE_CATEGORIES,
  SEND_LOG_TABLE_NAME,
  applyWhatsAppSendResultToSource,
  cancelScheduledRetry,
  claimRetryJobs,
  classifyMetaFailure,
  classifyNetworkError,
  createManualRetryFromLog,
  createManualWhatsAppTestLog,
  ensureWhatsAppSendLogSchema,
  getIncomingSourceForSendLog,
  getWhatsAppRetryPolicy,
  getWhatsAppSendConfig,
  getWhatsAppSendHealth,
  getWhatsAppSendLogs,
  getWhatsAppSendMonitorSummary,
  getWhatsAppSourceTimeline,
  isAllowedTesterNumber,
  isRetryableFailureCategory,
  markSendForManualReview,
  normalizePhoneDigits,
  parseBooleanEnv,
  recoverStaleSendAttempts,
  sanitizeForLog,
  sendLoggedWhatsAppTextMessage,
}

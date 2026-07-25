const INCOMING_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const OUTGOING_MESSAGE_TABLE_NAME = 'tran_whatsapp_outgoing_messages'
const ACK_PURPOSE = 'AUTO_ACKNOWLEDGEMENT'

const ACK_STATUSES = {
  DISABLED: 'DISABLED',
  DUPLICATE_SKIPPED: 'DUPLICATE_SKIPPED',
  FAILED: 'FAILED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  TEMPLATE_REQUIRED: 'TEMPLATE_REQUIRED',
  TEST_NUMBER_NOT_ALLOWED: 'TEST_NUMBER_NOT_ALLOWED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
}

const TERMINAL_PROCESSING_STATUSES = new Set([
  'CALCULATION_FAILED',
  'COMMERCIAL_DATA_PENDING',
  'CUSTOMER_NOT_FOUND',
  'DRAFT_PI_CREATED',
  'DISCOUNT_REVIEW',
  'FAILED',
  'MANUAL_REVIEW',
  'PARSE_FAILED',
  'PI_CREATED',
  'PI_FAILED',
  'PRODUCT_NOT_FOUND',
  'RATE_NOT_FOUND',
])

const SUPPORTED_INCOMING_SOURCE_TYPES = new Set(['text', 'image', 'document'])

const toText = (value) => String(value ?? '').trim()

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const normalizePhoneDigits = (value) => {
  const digits = toText(value).replace(/\D+/g, '')

  return digits.length > 10 ? digits.slice(-12) : digits
}

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(Number(durationMs) || 0, 0))
  })

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y'].includes(toText(value).toLowerCase())
}

const getAllowedTesterNumbers = (env = process.env) =>
  toText(env.WHATSAPP_ALLOWED_TEST_NUMBERS)
    .split(',')
    .map(normalizePhoneDigits)
    .filter(Boolean)

const getAcknowledgementConfig = (env = process.env) => ({
  accessToken: toText(env.WHATSAPP_ACCESS_TOKEN),
  allowedTesterNumbers: getAllowedTesterNumbers(env),
  autoAckEnabled: parseBooleanEnv(env.WHATSAPP_AUTO_ACK_ENABLED, false),
  businessPhoneNumber: normalizePhoneDigits(
    env.WHATSAPP_BUSINESS_PHONE_NUMBER ||
      env.WHATSAPP_BUSINESS_TEST_NUMBER ||
      env.WHATSAPP_TEST_NUMBER,
  ),
  graphApiBase: toText(env.WHATSAPP_GRAPH_API_BASE) || 'https://graph.facebook.com/v20.0',
  includePiNumber: parseBooleanEnv(env.WHATSAPP_ACK_INCLUDE_PI_NUMBER, true),
  initialDelayMs: Math.max(toNumberValue(env.WHATSAPP_ACK_DELAY_MS), 0),
  mode: toText(env.WHATSAPP_AUTO_ACK_MODE || 'development').toLowerCase(),
  phoneNumberId: toText(env.WHATSAPP_PHONE_NUMBER_ID),
})

const isAcknowledgementTerminalStatus = (status) =>
  TERMINAL_PROCESSING_STATUSES.has(toText(status).toUpperCase())

const isDraftPICreatedStatus = (processingStatus, piNumber = '') => {
  const status = toText(processingStatus).toUpperCase()

  return (
    status === 'PI_CREATED' ||
    status === 'DRAFT_PI_CREATED' ||
    (Boolean(toText(piNumber)) && status !== 'MANUAL_REVIEW')
  )
}

const isAllowedTesterNumber = (phone, config = getAcknowledgementConfig()) => {
  const normalizedPhone = normalizePhoneDigits(phone)

  if (!normalizedPhone) {
    return false
  }

  if (config.mode !== 'development') {
    return true
  }

  return config.allowedTesterNumbers.includes(normalizedPhone)
}

const buildAcknowledgementMessage = ({
  includePiNumber = true,
  piNumber = '',
  processingStatus = '',
} = {}) => {
  const normalizedPiNumber = toText(piNumber)
  const includeReference =
    includePiNumber &&
    normalizedPiNumber &&
    isDraftPICreatedStatus(processingStatus, normalizedPiNumber)

  if (includeReference) {
    return `Thank you for contacting AUTOPAL.

We have received your order/request successfully.

Reference No.: ${normalizedPiNumber}

Our team is processing your request.

This is an automated development test message.

AUTOPAL ERP
Autolite (India) Limited`
  }

  return `Thank you for contacting AUTOPAL.

We have received your message successfully.

Our team is reviewing the details and may contact you if any clarification is required.

This is an automated development test message.

AUTOPAL ERP
Autolite (India) Limited`
}

const sanitizeMetaResponse = (value) => {
  if (!value || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeMetaResponse)
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      /token|secret|authorization/i.test(key)
        ? '[REDACTED]'
        : sanitizeMetaResponse(nestedValue),
    ]),
  )
}

const extractMetaMessageId = (payload) =>
  toText(payload?.messages?.[0]?.id ?? payload?.message_id ?? '')

const getMetaError = (payload = {}) => {
  const error = payload?.error ?? {}

  return {
    code: toText(error.code),
    message: toText(error.message || payload.message),
    subcode: toText(error.error_subcode ?? error.subcode),
    type: toText(error.type),
  }
}

const classifyMetaSendFailure = ({ error, httpStatus = 0 }) => {
  if (error.code === '190' && error.subcode === '463') {
    return {
      retryable: false,
      status: ACK_STATUSES.TOKEN_EXPIRED,
    }
  }

  if (error.code === '190') {
    return {
      retryable: false,
      status: ACK_STATUSES.TOKEN_EXPIRED,
    }
  }

  if (error.code === '131047') {
    return {
      retryable: false,
      status: ACK_STATUSES.TEMPLATE_REQUIRED,
    }
  }

  return {
    retryable: httpStatus >= 500 || httpStatus === 0,
    status: ACK_STATUSES.FAILED,
  }
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

const sendTextMessage = async ({
  body,
  contextMessageId = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  to,
}) => {
  const config = getAcknowledgementConfig(env)
  const recipientPhone = normalizePhoneDigits(to)

  if (!fetchImpl) {
    return {
      errorCode: 'FETCH_UNAVAILABLE',
      errorMessage: 'Fetch API is not available.',
      ok: false,
      retryable: false,
      status: ACK_STATUSES.FAILED,
    }
  }

  if (!config.accessToken) {
    return {
      errorCode: 'WHATSAPP_ACCESS_TOKEN_MISSING',
      errorMessage: 'WHATSAPP_ACCESS_TOKEN is not configured.',
      ok: false,
      retryable: false,
      status: ACK_STATUSES.FAILED,
    }
  }

  if (!config.phoneNumberId) {
    return {
      errorCode: 'WHATSAPP_PHONE_NUMBER_ID_MISSING',
      errorMessage: 'WHATSAPP_PHONE_NUMBER_ID is not configured.',
      ok: false,
      retryable: false,
      status: ACK_STATUSES.FAILED,
    }
  }

  if (!recipientPhone) {
    return {
      errorCode: 'MISSING_RECIPIENT',
      errorMessage: 'Recipient phone number is required.',
      ok: false,
      retryable: false,
      status: ACK_STATUSES.FAILED,
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    text: {
      body,
      preview_url: false,
    },
    to: recipientPhone,
    type: 'text',
  }

  if (contextMessageId) {
    payload.context = {
      message_id: contextMessageId,
    }
  }

  try {
    const response = await fetchImpl(
      `${config.graphApiBase.replace(/\/+$/, '')}/${encodeURIComponent(config.phoneNumberId)}/messages`,
      {
        body: JSON.stringify(payload),
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      },
    )
    const responsePayload = await readResponsePayload(response)

    if (response.ok) {
      return {
        metaMessageId: extractMetaMessageId(responsePayload),
        metaResponse: sanitizeMetaResponse(responsePayload),
        ok: true,
        retryable: false,
        status: ACK_STATUSES.SENT,
      }
    }

    const error = getMetaError(responsePayload)
    const failure = classifyMetaSendFailure({
      error,
      httpStatus: response.status,
    })

    return {
      errorCode: error.code || String(response.status),
      errorMessage: error.message || `Meta send failed with HTTP ${response.status}.`,
      metaResponse: sanitizeMetaResponse(responsePayload),
      ok: false,
      retryable: failure.retryable,
      status: failure.status,
    }
  } catch (error) {
    return {
      errorCode: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      errorMessage: error instanceof Error ? error.message : 'Meta send failed.',
      ok: false,
      retryable: true,
      status: ACK_STATUSES.FAILED,
    }
  } finally {
    clearTimeout(timeout)
  }
}

let acknowledgementSchemaPromise

const ensureWhatsAppAcknowledgementSchema = async (pool) => {
  if (!acknowledgementSchemaPromise) {
    acknowledgementSchemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE ${INCOMING_MESSAGE_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS acknowledgement_status varchar(40) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS acknowledgement_message text,
          ADD COLUMN IF NOT EXISTS acknowledgement_sent_at timestamptz,
          ADD COLUMN IF NOT EXISTS acknowledgement_whatsapp_message_id varchar(160),
          ADD COLUMN IF NOT EXISTS acknowledgement_error text,
          ADD COLUMN IF NOT EXISTS acknowledgement_attempts integer NOT NULL DEFAULT 0
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${OUTGOING_MESSAGE_TABLE_NAME} (
          outgoing_id bigserial PRIMARY KEY,
          source_message_id bigint,
          source_whatsapp_message_id varchar(160),
          to_phone varchar(50) NOT NULL,
          message_type varchar(40) NOT NULL DEFAULT 'text',
          message_body text NOT NULL,
          purpose varchar(80) NOT NULL,
          pi_number varchar(40),
          send_status varchar(40) NOT NULL DEFAULT 'PENDING',
          meta_message_id varchar(160),
          meta_response jsonb,
          error_code varchar(80),
          error_message text,
          attempt_count integer NOT NULL DEFAULT 0,
          sent_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_outgoing_auto_ack_source
        ON ${OUTGOING_MESSAGE_TABLE_NAME} (source_whatsapp_message_id, purpose)
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_outgoing_created_at
        ON ${OUTGOING_MESSAGE_TABLE_NAME} (created_at DESC, outgoing_id DESC)
      `)
    })()
  }

  try {
    await acknowledgementSchemaPromise
  } catch (error) {
    acknowledgementSchemaPromise = undefined
    throw error
  }
}

const updateIncomingAcknowledgement = async (
  pool,
  messageId,
  {
    attempts = null,
    errorMessage = null,
    message = null,
    metaMessageId = null,
    sentAt = null,
    status,
  },
) => {
  await ensureWhatsAppAcknowledgementSchema(pool)
  await pool.query(
    `
      UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
      SET
        acknowledgement_status = $2,
        acknowledgement_message = COALESCE($3, acknowledgement_message),
        acknowledgement_sent_at = COALESCE($4::timestamptz, acknowledgement_sent_at),
        acknowledgement_whatsapp_message_id = COALESCE($5, acknowledgement_whatsapp_message_id),
        acknowledgement_error = $6,
        acknowledgement_attempts = COALESCE($7::integer, acknowledgement_attempts),
        reply_status = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1
    `,
    [
      toText(messageId),
      status,
      message,
      sentAt,
      metaMessageId,
      errorMessage,
      attempts,
    ],
  )
}

const getExistingAcknowledgementState = async (pool, messageId) => {
  await ensureWhatsAppAcknowledgementSchema(pool)
  const incomingResult = await pool.query(
    `
      SELECT
        acknowledgement_status,
        acknowledgement_whatsapp_message_id,
        acknowledgement_attempts
      FROM ${INCOMING_MESSAGE_TABLE_NAME}
      WHERE message_id = $1
      LIMIT 1
    `,
    [toText(messageId)],
  )
  const outgoingResult = await pool.query(
    `
      SELECT
        outgoing_id,
        send_status,
        meta_message_id,
        attempt_count
      FROM ${OUTGOING_MESSAGE_TABLE_NAME}
      WHERE source_whatsapp_message_id = $1
        AND purpose = $2
      ORDER BY created_at DESC, outgoing_id DESC
      LIMIT 1
    `,
    [toText(messageId), ACK_PURPOSE],
  )

  return {
    incoming: incomingResult.rows[0] ?? null,
    outgoing: outgoingResult.rows[0] ?? null,
  }
}

const createOutgoingAcknowledgement = async (
  pool,
  {
    incomingMessageRecord,
    messageBody,
    piNumber,
    status = ACK_STATUSES.PENDING,
  },
) => {
  await ensureWhatsAppAcknowledgementSchema(pool)
  const result = await pool.query(
    `
      INSERT INTO ${OUTGOING_MESSAGE_TABLE_NAME}
        (
          source_message_id,
          source_whatsapp_message_id,
          to_phone,
          message_type,
          message_body,
          purpose,
          pi_number,
          send_status,
          attempt_count
        )
      VALUES
        ($1, $2, $3, 'text', $4, $5, $6, $7, 0)
      ON CONFLICT (source_whatsapp_message_id, purpose)
      DO UPDATE SET
        message_body = EXCLUDED.message_body,
        pi_number = EXCLUDED.pi_number,
        send_status = CASE
          WHEN ${OUTGOING_MESSAGE_TABLE_NAME}.send_status = 'SENT'
            THEN ${OUTGOING_MESSAGE_TABLE_NAME}.send_status
          ELSE EXCLUDED.send_status
        END,
        updated_at = CURRENT_TIMESTAMP
      RETURNING outgoing_id, send_status, attempt_count, meta_message_id
    `,
    [
      incomingMessageRecord.id || null,
      incomingMessageRecord.messageId,
      normalizePhoneDigits(incomingMessageRecord.senderPhone),
      messageBody,
      ACK_PURPOSE,
      piNumber || null,
      status,
    ],
  )

  return result.rows[0] ?? null
}

const updateOutgoingAcknowledgement = async (
  pool,
  outgoingId,
  {
    attemptCount,
    errorCode = null,
    errorMessage = null,
    metaMessageId = null,
    metaResponse = null,
    sentAt = null,
    status,
  },
) => {
  await ensureWhatsAppAcknowledgementSchema(pool)
  await pool.query(
    `
      UPDATE ${OUTGOING_MESSAGE_TABLE_NAME}
      SET
        send_status = $2,
        meta_message_id = COALESCE($3, meta_message_id),
        meta_response = COALESCE($4::jsonb, meta_response),
        error_code = $5,
        error_message = $6,
        attempt_count = $7,
        sent_at = COALESCE($8::timestamptz, sent_at),
        updated_at = CURRENT_TIMESTAMP
      WHERE outgoing_id = $1
    `,
    [
      outgoingId,
      status,
      metaMessageId,
      metaResponse ? JSON.stringify(metaResponse) : null,
      errorCode,
      errorMessage,
      attemptCount,
      sentAt,
    ],
  )
}

const getIncomingMessageForAcknowledgement = async (
  pool,
  {
    id = null,
    messageId = '',
  } = {},
) => {
  await ensureWhatsAppAcknowledgementSchema(pool)
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        sender_name,
        sender_phone,
        message_type,
        source_type,
        parse_status,
        processing_status,
        draft_pi_no,
        pi_created,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts
      FROM ${INCOMING_MESSAGE_TABLE_NAME}
      WHERE ($1::bigint IS NOT NULL AND id = $1::bigint)
         OR ($2::text <> '' AND message_id = $2::text)
      ORDER BY id DESC
      LIMIT 1
    `,
    [id ? Number(id) : null, toText(messageId)],
  )
  const row = result.rows[0]

  if (!row) {
    return null
  }

  return {
    acknowledgementAttempts: Number(row.acknowledgement_attempts ?? 0),
    acknowledgementError: row.acknowledgement_error ?? '',
    acknowledgementMessage: row.acknowledgement_message ?? '',
    acknowledgementSentAt: row.acknowledgement_sent_at,
    acknowledgementStatus: row.acknowledgement_status ?? '',
    acknowledgementWhatsappMessageId: row.acknowledgement_whatsapp_message_id ?? '',
    draftPiNo: row.draft_pi_no ?? '',
    id: Number(row.id),
    messageId: row.message_id ?? '',
    messageType: row.message_type ?? '',
    parseStatus: row.parse_status ?? '',
    piCreated: Boolean(row.pi_created),
    processingStatus: row.processing_status ?? row.parse_status ?? '',
    senderName: row.sender_name ?? '',
    senderPhone: row.sender_phone ?? '',
    sourceType: row.source_type ?? row.message_type ?? '',
  }
}

const validateAcknowledgementPreconditions = ({
  config,
  incomingMessageRecord,
  processingStatus,
}) => {
  const senderPhone = normalizePhoneDigits(incomingMessageRecord?.senderPhone)
  const sourceType = toText(
    incomingMessageRecord?.sourceType || incomingMessageRecord?.messageType,
  ).toLowerCase()

  if (!isAcknowledgementTerminalStatus(processingStatus)) {
    return {
      errorMessage: 'Acknowledgement is not required for non-terminal processing status.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  if (!config.autoAckEnabled) {
    return {
      errorMessage: 'Automatic acknowledgement is disabled.',
      status: ACK_STATUSES.DISABLED,
    }
  }

  if (!senderPhone) {
    return {
      errorMessage: 'Sender phone number is missing.',
      status: ACK_STATUSES.FAILED,
    }
  }

  if (!SUPPORTED_INCOMING_SOURCE_TYPES.has(sourceType)) {
    return {
      errorMessage: 'Acknowledgement is not required for this WhatsApp event type.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  if (config.businessPhoneNumber && senderPhone === config.businessPhoneNumber) {
    return {
      errorMessage: 'Acknowledgement is not sent to the business/test number itself.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  if (config.mode === 'development' && !isAllowedTesterNumber(senderPhone, config)) {
    return {
      errorMessage: 'Sender phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.',
      status: ACK_STATUSES.TEST_NUMBER_NOT_ALLOWED,
    }
  }

  return {
    errorMessage: '',
    status: '',
  }
}

const sendWithRetry = async ({
  body,
  contextMessageId,
  env,
  fetchImpl,
  maxRetries = 2,
  to,
}) => {
  let attempts = 0
  let lastResult = null

  while (attempts <= maxRetries) {
    attempts += 1
    lastResult = await sendTextMessage({
      body,
      contextMessageId,
      env,
      fetchImpl,
      to,
    })

    if (lastResult.ok || !lastResult.retryable || attempts > maxRetries) {
      return {
        attempts,
        ...lastResult,
      }
    }

    await sleep(250 * 2 ** (attempts - 1))
  }

  return {
    attempts,
    ...lastResult,
  }
}

const sendAutomaticAcknowledgement = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  incomingMessageRecord,
  piNumber = '',
  pool,
  processingStatus = '',
  retry = false,
} = {}) => {
  await ensureWhatsAppAcknowledgementSchema(pool)

  const messageId = toText(incomingMessageRecord?.messageId)
  const config = getAcknowledgementConfig(env)
  const resolvedProcessingStatus =
    processingStatus ||
    incomingMessageRecord?.processingStatus ||
    incomingMessageRecord?.parseStatus ||
    ''
  const resolvedPiNumber = toText(piNumber || incomingMessageRecord?.draftPiNo)
  const messageBody = buildAcknowledgementMessage({
    includePiNumber: config.includePiNumber,
    piNumber: resolvedPiNumber,
    processingStatus: resolvedProcessingStatus,
  })

  if (!messageId) {
    return {
      errorMessage: 'Incoming WhatsApp message ID is required.',
      messageBody,
      ok: false,
      status: ACK_STATUSES.FAILED,
    }
  }

  const precondition = validateAcknowledgementPreconditions({
    config,
    incomingMessageRecord,
    processingStatus: resolvedProcessingStatus,
  })

  if (precondition.status) {
    await updateIncomingAcknowledgement(pool, messageId, {
      errorMessage: precondition.errorMessage,
      message: messageBody,
      status: precondition.status,
    })

    return {
      errorMessage: precondition.errorMessage,
      messageBody,
      ok: false,
      status: precondition.status,
    }
  }

  const existing = await getExistingAcknowledgementState(pool, messageId)

  if (
    existing.incoming?.acknowledgement_status === ACK_STATUSES.SENT ||
    existing.incoming?.acknowledgement_whatsapp_message_id ||
    existing.outgoing?.send_status === ACK_STATUSES.SENT ||
    existing.outgoing?.meta_message_id
  ) {
    return {
      errorMessage: 'Acknowledgement was already sent for this incoming message.',
      messageBody,
      metaMessageId:
        existing.incoming?.acknowledgement_whatsapp_message_id ||
        existing.outgoing?.meta_message_id ||
        '',
      ok: true,
      status: ACK_STATUSES.DUPLICATE_SKIPPED,
    }
  }

  if (
    !retry &&
    existing.outgoing &&
    existing.outgoing.send_status &&
    existing.outgoing.send_status !== ACK_STATUSES.FAILED
  ) {
    return {
      errorMessage: 'Acknowledgement send is already in progress or not retryable.',
      messageBody,
      ok: false,
      status: ACK_STATUSES.DUPLICATE_SKIPPED,
    }
  }

  const outgoing = await createOutgoingAcknowledgement(pool, {
    incomingMessageRecord,
    messageBody,
    piNumber: resolvedPiNumber,
    status: ACK_STATUSES.SENDING,
  })

  await updateIncomingAcknowledgement(pool, messageId, {
    errorMessage: null,
    message: messageBody,
    status: ACK_STATUSES.SENDING,
  })

  if (config.initialDelayMs > 0) {
    await sleep(config.initialDelayMs)
  }

  const sendResult = await sendWithRetry({
    body: messageBody,
    contextMessageId: messageId,
    env,
    fetchImpl,
    to: incomingMessageRecord.senderPhone,
  })
  const sentAt = sendResult.ok ? new Date().toISOString() : null

  await updateOutgoingAcknowledgement(pool, outgoing.outgoing_id, {
    attemptCount: sendResult.attempts,
    errorCode: sendResult.errorCode ?? null,
    errorMessage: sendResult.errorMessage ?? null,
    metaMessageId: sendResult.metaMessageId ?? null,
    metaResponse: sendResult.metaResponse ?? null,
    sentAt,
    status: sendResult.status,
  })
  await updateIncomingAcknowledgement(pool, messageId, {
    attempts: toNumberValue(existing.incoming?.acknowledgement_attempts) + sendResult.attempts,
    errorMessage: sendResult.errorMessage ?? null,
    message: messageBody,
    metaMessageId: sendResult.metaMessageId ?? null,
    sentAt,
    status: sendResult.status,
  })

  return {
    attempts: sendResult.attempts,
    errorCode: sendResult.errorCode ?? '',
    errorMessage: sendResult.errorMessage ?? '',
    messageBody,
    metaMessageId: sendResult.metaMessageId ?? '',
    metaResponse: sendResult.metaResponse ?? null,
    ok: sendResult.ok,
    status: sendResult.status,
  }
}

export {
  ACK_STATUSES,
  buildAcknowledgementMessage,
  ensureWhatsAppAcknowledgementSchema,
  getAcknowledgementConfig,
  getIncomingMessageForAcknowledgement,
  isAcknowledgementTerminalStatus,
  isAllowedTesterNumber,
  normalizePhoneDigits,
  sendAutomaticAcknowledgement,
  sendTextMessage,
  validateAcknowledgementPreconditions,
}

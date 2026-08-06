import {
  MESSAGE_PURPOSES,
  SEND_ATTEMPT_STATUSES,
  SEND_FAILURE_CATEGORIES,
  ensureWhatsAppSendLogSchema,
  sendLoggedWhatsAppTextMessage,
} from './whatsappSendService.js'
import {
  logWhatsAppOutgoingEarlyReturn,
  logWhatsAppOutgoingTrace,
} from './whatsappOutgoingTrace.js'

const INCOMING_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const OUTGOING_MESSAGE_TABLE_NAME = 'tran_whatsapp_outgoing_messages'
const ACK_PURPOSE = 'AUTO_ACKNOWLEDGEMENT'

const ACK_STATUSES = {
  DISABLED: 'DISABLED',
  DUPLICATE_SKIPPED: 'DUPLICATE_SKIPPED',
  FAILED: 'FAILED',
  PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
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

const logOutgoingPipeline = (event, details = {}) => {
  logWhatsAppOutgoingTrace(event, {
    currentFile: 'backend/whatsappAckService.js',
    currentFunction: details.currentFunction ?? 'whatsappAckService',
    messagePurpose: details.messagePurpose ?? ACK_PURPOSE,
    ...details,
  })
}

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y'].includes(toText(value).toLowerCase())
}

const normalizeNullableText = (value) => {
  if (value === undefined || value === null) {
    return null
  }

  return String(value)
}

const normalizeNullableInteger = (value) => {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const number = Number(value)

  return Number.isFinite(number) ? Math.trunc(number) : null
}

const getSqlParameterDiagnostics = (parameters) =>
  parameters.map(({ index, name, value }) => ({
    index,
    isNull: value === null,
    jsType: value === null ? 'null' : typeof value,
    name,
  }))

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

const sendTextMessage = async ({
  body,
  contextMessageId = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  pool = null,
  purpose = MESSAGE_PURPOSES.MANUAL_TEST,
  sourceMessageRecordId = null,
  sourceWhatsappMessageId = '',
  piNumber = '',
  attemptNumber = 1,
  existingSendLogId = null,
  timeoutMs = 15000,
  to,
}) => {
  logOutgoingPipeline('sendTextMessage wrapper entered', {
    currentFunction: 'sendTextMessage',
    destinationPhone: to,
    messageId: sourceWhatsappMessageId || contextMessageId,
    messagePurpose: purpose,
    piNumber,
    sharedSenderCalled: true,
  })
  const result = await sendLoggedWhatsAppTextMessage({
    attemptNumber,
    body,
    contextMessageId,
    existingSendLogId,
    fetchImpl,
    piNumber,
    pool,
    purpose,
    sourceMessageRecordId,
    sourceWhatsappMessageId,
    timeoutMs,
    to,
    env,
  })
  logOutgoingPipeline('sendTextMessage wrapper returned', {
    currentFunction: 'sendTextMessage',
    destinationPhone: to,
    messageId: sourceWhatsappMessageId || contextMessageId,
    messagePurpose: purpose,
    metaApiReturned: Boolean(result.httpStatus || result.metaMessageId),
    piNumber,
    sendLogId: result.sendLogId,
    sharedSenderCalled: true,
    status: result.status,
  })
  const legacyStatus =
    result.status === SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED &&
    [
      SEND_FAILURE_CATEGORIES.SESSION_WINDOW_CLOSED,
      SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED,
      SEND_FAILURE_CATEGORIES.TEST_NUMBER_NOT_ALLOWED,
    ].includes(result.failureCategory)
      ? result.failureCategory === SEND_FAILURE_CATEGORIES.SESSION_WINDOW_CLOSED
        ? ACK_STATUSES.TEMPLATE_REQUIRED
        : result.failureCategory
      : result.status

  return {
    attemptNumber: result.attemptNumber,
    attempts: result.attemptNumber,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    failureCategory: result.failureCategory,
    httpStatus: result.httpStatus,
    messagePurpose: result.messagePurpose || purpose,
    metaMessageId: result.metaMessageId,
    metaResponse: result.metaResponse,
    networkError: result.networkError,
    nextRetryAt: result.nextRetryAt,
    ok: result.ok,
    retryScheduled: result.retryScheduled,
    retryable: result.retryable,
    scheduledSendLogId: result.scheduledSendLogId,
    sendLogId: result.sendLogId,
    status: legacyStatus,
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
          ADD COLUMN IF NOT EXISTS acknowledgement_attempts integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS pi_summary_status varchar(40) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS pi_summary_error text
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
      await ensureWhatsAppSendLogSchema(pool)
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
  const messageIdParam = toText(messageId) || null
  const statusParam = toText(status) || ACK_STATUSES.FAILED
  const messageParam = normalizeNullableText(message)
  const sentAtParam = sentAt ?? null
  const metaMessageIdParam = normalizeNullableText(metaMessageId)
  const errorMessageParam = normalizeNullableText(errorMessage)
  const attemptsParam = normalizeNullableInteger(attempts)
  const replyStatusParam = statusParam
  const shouldBlockSummary = [
    ACK_STATUSES.PERMANENTLY_FAILED,
    ACK_STATUSES.TEST_NUMBER_NOT_ALLOWED,
    ACK_STATUSES.TOKEN_EXPIRED,
    SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
    SEND_FAILURE_CATEGORIES.INVALID_RECIPIENT,
    SEND_FAILURE_CATEGORIES.PERMISSION_ERROR,
  ].includes(statusParam)
  const queryParameters = [
    messageIdParam,
    statusParam,
    messageParam,
    sentAtParam,
    metaMessageIdParam,
    errorMessageParam,
    attemptsParam,
    replyStatusParam,
    shouldBlockSummary,
  ]
  const parameterDiagnostics = getSqlParameterDiagnostics([
    { index: 1, name: 'messageId', value: messageIdParam },
    { index: 2, name: 'status', value: statusParam },
    { index: 3, name: 'message', value: messageParam },
    { index: 4, name: 'sentAt', value: sentAtParam },
    { index: 5, name: 'metaMessageId', value: metaMessageIdParam },
    { index: 6, name: 'errorMessage', value: errorMessageParam },
    { index: 7, name: 'attempts', value: attemptsParam },
    { index: 8, name: 'replyStatus', value: replyStatusParam },
    { index: 9, name: 'shouldBlockSummary', value: shouldBlockSummary },
  ])

  logOutgoingPipeline('Updating source status to acknowledgement state', {
    acknowledgementStatusUpdated: false,
    currentFunction: 'updateIncomingAcknowledgement',
    messagePurpose: ACK_PURPOSE,
    messageId: messageIdParam,
    parameterDiagnostics,
    status: statusParam,
  })

  try {
    const result = await pool.query(
      `
        UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
        SET
          acknowledgement_status = $2::varchar,
          acknowledgement_message = COALESCE($3::text, acknowledgement_message),
          acknowledgement_sent_at = COALESCE($4::timestamptz, acknowledgement_sent_at),
          acknowledgement_whatsapp_message_id =
            COALESCE($5::varchar, acknowledgement_whatsapp_message_id),
          acknowledgement_error = $6::text,
          acknowledgement_attempts = COALESCE($7::integer, acknowledgement_attempts),
          reply_status = COALESCE($8::varchar, reply_status),
          pi_summary_status = CASE
            WHEN $2::varchar = 'RETRY_SCHEDULED'
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN 'WAITING_FOR_ACKNOWLEDGEMENT'
            WHEN $9::boolean = TRUE
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN 'BLOCKED_BY_ACKNOWLEDGEMENT'
            ELSE pi_summary_status
          END,
          pi_summary_error = CASE
            WHEN $9::boolean = TRUE
              AND COALESCE(draft_pi_no, '') <> ''
              AND COALESCE(pi_summary_status, 'PENDING') NOT IN ('SENT', 'DISABLED')
              THEN $6::text
            ELSE pi_summary_error
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE message_id = $1::varchar
        RETURNING
          message_id,
          acknowledgement_status,
          reply_status,
          pi_summary_status
      `,
      queryParameters,
    )

    logOutgoingPipeline('Source status update succeeded', {
      acknowledgementStatusUpdated: true,
      currentFunction: 'updateIncomingAcknowledgement',
      messagePurpose: ACK_PURPOSE,
      messageId: messageIdParam,
      rowCount: result.rowCount ?? result.rows?.length ?? 0,
      status: statusParam,
    })

    return result.rows?.[0] ?? null
  } catch (error) {
    logOutgoingPipeline('Source status update failed', {
      acknowledgementStatusUpdated: false,
      currentFunction: 'updateIncomingAcknowledgement',
      errorMessage: error instanceof Error ? error.message : String(error),
      messagePurpose: ACK_PURPOSE,
      messageId: messageIdParam,
      queryOperation: 'update acknowledgement source record',
      sqlstate: error?.code ?? '',
      status: statusParam,
    })
    throw error
  }
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
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'validateAcknowledgementPreconditions',
      destinationPhone: senderPhone,
      messageId: incomingMessageRecord?.messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: incomingMessageRecord?.draftPiNo,
      reason: 'Acknowledgement is not required for non-terminal processing status.',
      senderPhone,
    })
    return {
      errorMessage: 'Acknowledgement is not required for non-terminal processing status.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  if (!config.autoAckEnabled) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'validateAcknowledgementPreconditions',
      destinationPhone: senderPhone,
      messageId: incomingMessageRecord?.messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: incomingMessageRecord?.draftPiNo,
      reason: 'Automatic acknowledgement is disabled.',
      senderPhone,
    })
    return {
      errorMessage: 'Automatic acknowledgement is disabled.',
      status: ACK_STATUSES.DISABLED,
    }
  }

  if (!senderPhone) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'validateAcknowledgementPreconditions',
      messageId: incomingMessageRecord?.messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: incomingMessageRecord?.draftPiNo,
      reason: 'Sender phone number is missing.',
      senderPhone,
    })
    return {
      errorMessage: 'Sender phone number is missing.',
      status: ACK_STATUSES.FAILED,
    }
  }

  if (!SUPPORTED_INCOMING_SOURCE_TYPES.has(sourceType)) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'validateAcknowledgementPreconditions',
      destinationPhone: senderPhone,
      messageId: incomingMessageRecord?.messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: incomingMessageRecord?.draftPiNo,
      reason: 'Acknowledgement is not required for this WhatsApp event type.',
      senderPhone,
      sourceType,
    })
    return {
      errorMessage: 'Acknowledgement is not required for this WhatsApp event type.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  if (config.businessPhoneNumber && senderPhone === config.businessPhoneNumber) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'validateAcknowledgementPreconditions',
      destinationPhone: senderPhone,
      messageId: incomingMessageRecord?.messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: incomingMessageRecord?.draftPiNo,
      reason: 'Acknowledgement is not sent to the business/test number itself.',
      senderPhone,
    })
    return {
      errorMessage: 'Acknowledgement is not sent to the business/test number itself.',
      status: ACK_STATUSES.NOT_REQUIRED,
    }
  }

  return {
    errorMessage: '',
    status: '',
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

  logOutgoingPipeline('Acknowledgement function entered', {
    currentFunction: 'sendAutomaticAcknowledgement',
    destinationPhone: incomingMessageRecord?.senderPhone,
    messageId,
    piNumber: resolvedPiNumber,
    senderPhone: incomingMessageRecord?.senderPhone,
  })

  if (!messageId) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'sendAutomaticAcknowledgement',
      destinationPhone: incomingMessageRecord?.senderPhone,
      messagePurpose: ACK_PURPOSE,
      piNumber: resolvedPiNumber,
      reason: 'Incoming WhatsApp message ID is required.',
      senderPhone: incomingMessageRecord?.senderPhone,
    })
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
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'sendAutomaticAcknowledgement',
      destinationPhone: incomingMessageRecord?.senderPhone,
      messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: resolvedPiNumber,
      reason: precondition.errorMessage,
      senderPhone: incomingMessageRecord?.senderPhone,
      status: precondition.status,
    })
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
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'sendAutomaticAcknowledgement',
      destinationPhone: incomingMessageRecord?.senderPhone,
      messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: resolvedPiNumber,
      reason: 'Acknowledgement was already sent for this incoming message.',
      senderPhone: incomingMessageRecord?.senderPhone,
      status: ACK_STATUSES.DUPLICATE_SKIPPED,
    })
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
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'sendAutomaticAcknowledgement',
      destinationPhone: incomingMessageRecord?.senderPhone,
      existingStatus: existing.outgoing.send_status,
      messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: resolvedPiNumber,
      reason: 'Acknowledgement send is already in progress or not retryable.',
      senderPhone: incomingMessageRecord?.senderPhone,
      status: ACK_STATUSES.DUPLICATE_SKIPPED,
    })
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

  try {
    await updateIncomingAcknowledgement(pool, messageId, {
      errorMessage: null,
      message: messageBody,
      status: ACK_STATUSES.SENDING,
    })
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Unable to update acknowledgement source status before sending.'

    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappAckService.js',
      currentFunction: 'sendAutomaticAcknowledgement',
      destinationPhone: incomingMessageRecord.senderPhone,
      messageId,
      messagePurpose: ACK_PURPOSE,
      piNumber: resolvedPiNumber,
      reason: 'Source acknowledgement status update failed before shared sender.',
      senderPhone: incomingMessageRecord.senderPhone,
      sharedSenderCalled: false,
      sqlstate: error?.code ?? '',
      status: ACK_STATUSES.FAILED,
    })

    return {
      attempts: 0,
      errorCode: error?.code || 'SOURCE_ACKNOWLEDGEMENT_UPDATE_FAILED',
      errorMessage,
      failureCategory: 'DATABASE_ERROR',
      messageBody,
      metaMessageId: '',
      metaResponse: null,
      ok: false,
      retryScheduled: false,
      sendLogId: null,
      status: ACK_STATUSES.FAILED,
    }
  }

  if (config.initialDelayMs > 0) {
    await sleep(config.initialDelayMs)
  }

  logOutgoingPipeline('Acknowledgement requested', {
    currentFunction: 'sendAutomaticAcknowledgement',
    destinationPhone: incomingMessageRecord.senderPhone,
    messageId,
    piNumber: resolvedPiNumber,
    senderPhone: incomingMessageRecord.senderPhone,
    sharedSenderCalled: true,
  })
  const sendResult = await sendTextMessage({
    body: messageBody,
    contextMessageId: messageId,
    env,
    fetchImpl,
    piNumber: resolvedPiNumber,
    pool,
    purpose: MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT,
    sourceMessageRecordId: incomingMessageRecord.id || null,
    sourceWhatsappMessageId: messageId,
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

  logOutgoingPipeline('Acknowledgement function completed', {
    currentFunction: 'sendAutomaticAcknowledgement',
    destinationPhone: incomingMessageRecord.senderPhone,
    messageId,
    piNumber: resolvedPiNumber,
    senderPhone: incomingMessageRecord.senderPhone,
    sendLogId: sendResult.sendLogId,
    sharedSenderCalled: true,
    status: sendResult.status,
  })

  return {
    attempts: sendResult.attempts,
    errorCode: sendResult.errorCode ?? '',
    errorMessage: sendResult.errorMessage ?? '',
    failureCategory: sendResult.failureCategory ?? '',
    messageBody,
    metaMessageId: sendResult.metaMessageId ?? '',
    metaResponse: sendResult.metaResponse ?? null,
    nextRetryAt: sendResult.nextRetryAt ?? null,
    ok: sendResult.ok,
    retryScheduled: Boolean(sendResult.retryScheduled),
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

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'

const SUPPORTED_MEDIA_MESSAGE_TYPES = new Set([
  'audio',
  'document',
  'image',
  'sticker',
  'video',
])

const MEDIA_CAPTURE_STATUSES = {
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  PARTIAL: 'PARTIAL',
  UNSUPPORTED: 'UNSUPPORTED',
}

const MEDIA_PROCESSING_STATUSES = {
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  MEDIA_RECEIVED: 'MEDIA_RECEIVED',
}

const toText = (value) => String(value ?? '').trim()

const toNullableText = (value) => {
  const text = toText(value)

  return text || null
}

const getWhatsappReceivedAt = (message = {}) => {
  const timestamp = Number(message.timestamp ?? 0)

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }

  return new Date(timestamp * 1000).toISOString()
}

const getMediaPayload = (message = {}) => {
  const messageType = toText(message.type).toLowerCase()
  const payload = message?.[messageType]

  return payload && typeof payload === 'object' ? payload : {}
}

const isSupportedMediaMessageType = (messageType) =>
  SUPPORTED_MEDIA_MESSAGE_TYPES.has(toText(messageType).toLowerCase())

const isWhatsappMediaMessage = (message = {}) =>
  isSupportedMediaMessageType(message?.type)

const extractMediaEnvelope = (message = {}, contact = null) => {
  const messageType = toText(message.type).toLowerCase()
  const payload = getMediaPayload(message)
  const mediaType = isSupportedMediaMessageType(messageType) ? messageType : ''

  return {
    animated: mediaType === 'sticker' ? Boolean(payload.animated) : null,
    caption: toText(payload.caption),
    contact,
    fileName: mediaType === 'document' ? toText(payload.filename) : '',
    handled: isSupportedMediaMessageType(messageType),
    mediaId: toText(payload.id),
    mediaMimeType: toText(payload.mime_type),
    mediaSha256: toText(payload.sha256),
    mediaType,
    message,
    messageId: toText(message.id),
    messageType,
    rawPayload: { contact, message },
    receivedAt: getWhatsappReceivedAt(message),
    senderName: toText(contact?.profile?.name),
    senderPhone: toText(message.from || contact?.wa_id),
    voice: mediaType === 'audio' ? Boolean(payload.voice) : null,
  }
}

const classifyMediaMessage = (envelope = {}) => {
  const warnings = []
  const errors = []

  if (!envelope.handled) {
    errors.push(`Unsupported WhatsApp message type: ${toText(envelope.messageType) || 'unknown'}`)

    return {
      captureStatus: MEDIA_CAPTURE_STATUSES.UNSUPPORTED,
      errors,
      processingStatus: MEDIA_PROCESSING_STATUSES.MANUAL_REVIEW,
      warnings,
    }
  }

  if (!envelope.mediaId) {
    errors.push('Media ID is missing from the WhatsApp webhook payload.')

    return {
      captureStatus: MEDIA_CAPTURE_STATUSES.FAILED,
      errors,
      processingStatus: MEDIA_PROCESSING_STATUSES.MANUAL_REVIEW,
      warnings,
    }
  }

  if (!envelope.mediaMimeType) {
    warnings.push('Media MIME type is missing from the WhatsApp webhook payload.')
  }

  return {
    captureStatus: warnings.length > 0
      ? MEDIA_CAPTURE_STATUSES.PARTIAL
      : MEDIA_CAPTURE_STATUSES.CAPTURED,
    errors,
    processingStatus: MEDIA_PROCESSING_STATUSES.MEDIA_RECEIVED,
    warnings,
  }
}

const buildMediaCaptureResult = ({
  duplicate = false,
  envelope,
  sourceRecord = null,
} = {}) => {
  const classification = classifyMediaMessage(envelope)

  return {
    animated: envelope.animated,
    caption: envelope.caption,
    databaseRowId: sourceRecord?.id ?? null,
    duplicate,
    errors: classification.errors,
    fileName: envelope.fileName,
    mediaCaptureStatus: classification.captureStatus,
    mediaId: envelope.mediaId,
    mediaMimeType: envelope.mediaMimeType,
    mediaSha256: envelope.mediaSha256,
    mediaType: envelope.mediaType,
    messageId: envelope.messageId,
    messageType: envelope.messageType,
    processingStatus: classification.processingStatus,
    rawPayload: envelope.rawPayload,
    senderName: envelope.senderName,
    senderPhone: envelope.senderPhone,
    sourceRecord,
    voice: envelope.voice,
    warnings: classification.warnings,
  }
}

const getSafeMediaLogDetails = (result = {}) => ({
  captureStatus: result.mediaCaptureStatus,
  fileName: result.fileName || '',
  hasCaption: Boolean(result.caption),
  mediaId: result.mediaId || '',
  mediaType: result.mediaType || '',
  messageId: result.messageId || '',
  messageType: result.messageType || '',
  mimeType: result.mediaMimeType || '',
  senderPhone: result.senderPhone || '',
  sourceRecordId: result.databaseRowId ?? null,
})

const ensureWhatsAppMediaCaptureSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_mime_type varchar(255),
      ADD COLUMN IF NOT EXISTS media_sha256 varchar(255),
      ADD COLUMN IF NOT EXISTS media_voice boolean,
      ADD COLUMN IF NOT EXISTS media_animated boolean,
      ADD COLUMN IF NOT EXISTS media_capture_status varchar(50),
      ADD COLUMN IF NOT EXISTS media_capture_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_id
    ON ${tableName} (media_id)
    WHERE media_id IS NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_message_type
    ON ${tableName} (message_type)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_capture_status
    ON ${tableName} (media_capture_status)
  `)
}

const captureIncomingMedia = async ({
  contact = null,
  message,
  pool,
  sourceRecord = null,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp media capture.')
  }

  await ensureWhatsAppMediaCaptureSchema(pool, { tableName })

  const envelope = extractMediaEnvelope(message, contact)
  const result = buildMediaCaptureResult({ envelope, sourceRecord })

  if (!sourceRecord?.messageId && !sourceRecord?.message_id && !envelope.messageId) {
    result.errors.push('Source WhatsApp message ID is missing.')
    result.mediaCaptureStatus = MEDIA_CAPTURE_STATUSES.FAILED
    result.processingStatus = MEDIA_PROCESSING_STATUSES.MANUAL_REVIEW
    return result
  }

  const messageId = sourceRecord?.messageId || sourceRecord?.message_id || envelope.messageId
  const caption = envelope.caption || null
  const rawPayload = envelope.rawPayload ? JSON.stringify(envelope.rawPayload) : null
  const errorText = [...result.warnings, ...result.errors].join(' ')

  const updateResult = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_id = COALESCE(NULLIF($2::varchar, ''), media_id),
        media_type = COALESCE(NULLIF($3::varchar, ''), media_type),
        media_mime_type = COALESCE(NULLIF($4::varchar, ''), media_mime_type),
        media_sha256 = COALESCE(NULLIF($5::varchar, ''), media_sha256),
        media_voice = COALESCE($6::boolean, media_voice),
        media_animated = COALESCE($7::boolean, media_animated),
        file_name = COALESCE(NULLIF($8::text, ''), file_name),
        caption = COALESCE($9::text, caption),
        message_text = COALESCE($9::text, message_text),
        raw_payload = COALESCE($10::jsonb, raw_payload),
        processing_status = CASE
          WHEN media_capture_status = 'CAPTURED' THEN processing_status
          ELSE $11::varchar
        END,
        parse_status = CASE
          WHEN media_capture_status = 'CAPTURED' THEN parse_status
          ELSE $11::varchar
        END,
        parse_warnings = CASE
          WHEN media_capture_status = 'CAPTURED' THEN parse_warnings
          ELSE $12::jsonb
        END,
        parse_errors = CASE
          WHEN media_capture_status = 'CAPTURED' THEN parse_errors
          ELSE $13::jsonb
        END,
        error_details = CASE
          WHEN media_capture_status = 'CAPTURED' THEN error_details
          ELSE $14::jsonb
        END,
        media_capture_status = CASE
          WHEN media_capture_status = 'CAPTURED' THEN media_capture_status
          ELSE $15::varchar
        END,
        media_capture_error = CASE
          WHEN media_capture_status = 'CAPTURED' THEN media_capture_error
          ELSE NULLIF($16::text, '')
        END,
        pi_created = FALSE,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING
        id,
        message_id,
        message_type,
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        file_name,
        caption,
        processing_status,
        parse_status,
        raw_payload,
        pi_created,
        updated_at
    `,
    [
      messageId,
      envelope.mediaId,
      envelope.mediaType,
      envelope.mediaMimeType,
      envelope.mediaSha256,
      envelope.voice,
      envelope.animated,
      envelope.fileName,
      caption,
      rawPayload,
      result.processingStatus,
      JSON.stringify(result.warnings),
      JSON.stringify(result.errors),
      JSON.stringify({ errors: result.errors, warnings: result.warnings }),
      result.mediaCaptureStatus,
      errorText,
    ],
  )

  const row = updateResult.rows[0] ?? null

  return {
    ...result,
    databaseRowId: row?.id ? Number(row.id) : result.databaseRowId,
    sourceRecord: row,
  }
}

const buildMetaStyleMediaMessage = ({
  animated = false,
  caption = '',
  fileName = '',
  mediaId = '',
  mediaMimeType = '',
  mediaSha256 = '',
  messageId = '',
  messageType = 'image',
  senderPhone = '917733850017',
  timestamp = Math.floor(Date.now() / 1000).toString(),
  voice = false,
} = {}) => {
  const type = toText(messageType).toLowerCase()
  const payload = {
    id: mediaId || `test-${type}-media-id`,
    mime_type: mediaMimeType,
    sha256: mediaSha256,
  }

  if (caption && ['document', 'image', 'video'].includes(type)) {
    payload.caption = caption
  }

  if (fileName && type === 'document') {
    payload.filename = fileName
  }

  if (type === 'audio') {
    payload.voice = Boolean(voice)
  }

  if (type === 'sticker') {
    payload.animated = Boolean(animated)
  }

  return {
    from: senderPhone,
    id: messageId || `wamid.test-${type}-${Date.now()}`,
    timestamp,
    type,
    [type]: payload,
  }
}

export {
  buildMediaCaptureResult,
  buildMetaStyleMediaMessage,
  captureIncomingMedia,
  classifyMediaMessage,
  ensureWhatsAppMediaCaptureSchema,
  extractMediaEnvelope,
  getSafeMediaLogDetails,
  isSupportedMediaMessageType,
  isWhatsappMediaMessage,
  MEDIA_CAPTURE_STATUSES,
  MEDIA_PROCESSING_STATUSES,
  SUPPORTED_MEDIA_MESSAGE_TYPES,
}

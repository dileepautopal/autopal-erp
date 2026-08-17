import { detectCustomerCommand } from './piSummaryService.js'

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const MIXED_CONTEXT_VERSION = 1
const MIXED_MESSAGE_ASSOCIATION_WINDOW_MINUTES = 10

const MIXED_MESSAGE_STATUSES = {
  PENDING: 'PENDING',
  MIXED_PROCESSING: 'MIXED_PROCESSING',
  MIXED_GROUPED: 'MIXED_GROUPED',
  MIXED_PARTIAL: 'MIXED_PARTIAL',
  MIXED_AMBIGUOUS: 'MIXED_AMBIGUOUS',
  MIXED_NO_CONTEXT: 'MIXED_NO_CONTEXT',
  MIXED_FAILED: 'MIXED_FAILED',
}

const TERMINAL_MIXED_STATUSES = new Set([
  MIXED_MESSAGE_STATUSES.MIXED_GROUPED,
  MIXED_MESSAGE_STATUSES.MIXED_PARTIAL,
  MIXED_MESSAGE_STATUSES.MIXED_AMBIGUOUS,
  MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT,
  MIXED_MESSAGE_STATUSES.MIXED_FAILED,
])

const quoteIdentifier = (value) => {
  const identifier = String(value || DEFAULT_MESSAGE_TABLE_NAME)

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Invalid WhatsApp message table name.')
  }

  return identifier
}

const toISOString = (value) => {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

const getMessageText = (row) => String(row?.message_text ?? row?.raw_text ?? '')

const isTextMessage = (row) =>
  String(row?.source_type || row?.message_type || '').toLowerCase() === 'text'

const getMediaEligibility = (row) => {
  if (row?.media_excel_candidate && ['EXCEL_PARSED', 'EXCEL_PARTIAL'].includes(row.media_excel_status)) {
    return { candidateSource: 'media_excel_candidate', mediaType: 'EXCEL' }
  }

  if (row?.media_word_candidate && ['WORD_PARSED', 'WORD_PARTIAL'].includes(row.media_word_status)) {
    return { candidateSource: 'media_word_candidate', mediaType: 'WORD' }
  }

  if (
    row?.media_order_candidate
    && ['PARSED', 'PARSE_PARTIAL'].includes(row.media_order_parse_status)
  ) {
    const mimeType = String(row.media_mime_type || '').toLowerCase()
    const sourceType = String(row.source_type || row.message_type || '').toLowerCase()
    return {
      candidateSource: 'media_order_candidate',
      mediaType: mimeType === 'application/pdf' ? 'PDF' : sourceType === 'image' ? 'IMAGE' : 'PDF',
    }
  }

  return null
}

const requiresReviewForText = (text) =>
  /\b(?:qty|quantity|quantities|nos?|pcs?|pieces?|make|change|same\s+qty|each)\b/i.test(text)

const compareRows = (left, right) => {
  const timeDifference = new Date(left.received_at).getTime() - new Date(right.received_at).getTime()
  return timeDifference || Number(left.id) - Number(right.id)
}

const toContextMessage = (row, role, mediaType = '') => {
  const message = {
    message_id: row.message_id,
    role,
    timestamp: toISOString(row.received_at),
    type: mediaType || String(row.source_type || row.message_type || '').toUpperCase(),
  }

  if (isTextMessage(row)) message.text = getMessageText(row)
  if (!isTextMessage(row) && row.caption) message.caption = String(row.caption)

  return message
}

const ensureWhatsAppMixedMessageContextSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  const table = quoteIdentifier(tableName)
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS media_mixed_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_mixed_context jsonb,
      ADD COLUMN IF NOT EXISTS media_mixed_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_mixed_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_mixed_sender_time
    ON ${table} (sender_phone, received_at DESC, id DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_mixed_status
    ON ${table} (media_mixed_status)
  `)
}

const selectMessage = async (pool, table, messageId) => {
  const result = await pool.query(
    `
      SELECT
        id, message_id, received_at, sender_phone, message_type, source_type,
        media_mime_type, caption, message_text, raw_text,
        media_order_parse_status, media_order_candidate,
        media_excel_status, media_excel_candidate,
        media_word_status, media_word_candidate,
        media_mixed_status, media_mixed_context, media_mixed_processed_at, media_mixed_error,
        pi_created
      FROM ${table}
      WHERE message_id = $1::varchar
      LIMIT 1
    `,
    [messageId],
  )
  return result.rows[0] ?? null
}

const selectNearbyMessages = async (
  pool,
  table,
  row,
  { excludeConsumedTexts = false } = {},
) => {
  const consumedTextFilter = excludeConsumedTexts
    ? `
        AND (
          LOWER(COALESCE(nearby.source_type, nearby.message_type, '')) <> 'text'
          OR NOT EXISTS (
            SELECT 1
            FROM ${table} AS consumed
            WHERE consumed.sender_phone = nearby.sender_phone
              AND consumed.media_mixed_status IN ('MIXED_GROUPED', 'MIXED_PARTIAL')
              AND consumed.media_mixed_context IS NOT NULL
              AND (consumed.media_mixed_context -> 'message_ids') ? nearby.message_id
          )
        )
      `
    : ''
  const result = await pool.query(
    `
      SELECT
        id, message_id, received_at, sender_phone, message_type, source_type,
        media_mime_type, caption, message_text, raw_text,
        media_order_parse_status, media_order_candidate,
        media_excel_status, media_excel_candidate,
        media_word_status, media_word_candidate
      FROM ${table} AS nearby
      WHERE nearby.sender_phone = $1::varchar
        AND nearby.received_at BETWEEN
          $2::timestamptz - ($3::integer * INTERVAL '1 minute')
          AND $2::timestamptz + ($3::integer * INTERVAL '1 minute')
        AND nearby.message_id <> $4::varchar
        ${consumedTextFilter}
      ORDER BY nearby.received_at ASC, nearby.id ASC
    `,
    [row.sender_phone, row.received_at, MIXED_MESSAGE_ASSOCIATION_WINDOW_MINUTES, row.message_id],
  )
  return result.rows
}

const updateMixedResult = async (pool, table, messageId, { context = null, error = null, status }) => {
  const result = await pool.query(
    `
      UPDATE ${table}
      SET
        media_mixed_status = $2::varchar,
        media_mixed_context = $3::jsonb,
        media_mixed_processed_at = CASE
          WHEN $2::varchar = 'MIXED_PROCESSING' THEN media_mixed_processed_at
          ELSE CURRENT_TIMESTAMP
        END,
        media_mixed_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING media_mixed_status, media_mixed_context, media_mixed_processed_at, media_mixed_error
    `,
    [messageId, status, context ? JSON.stringify(context) : null, error],
  )
  return result.rows[0] ?? null
}

const buildContext = ({ candidateSource, contextType, mediaRow, messages, requiresReview, sender, warnings = [] }) => ({
  version: MIXED_CONTEXT_VERSION,
  sender,
  primary_message_id: mediaRow?.message_id ?? null,
  message_ids: messages.map((message) => message.message_id),
  context_type: contextType,
  candidate_source: candidateSource ?? null,
  media_type: mediaRow ? getMediaEligibility(mediaRow)?.mediaType ?? null : null,
  messages,
  requires_review: requiresReview,
  warnings,
})

const processWhatsAppMixedMessageContext = async ({
  messageId,
  pool,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool?.query) throw new Error('PostgreSQL pool is required for mixed-message association.')
  const table = quoteIdentifier(tableName)
  await ensureWhatsAppMixedMessageContextSchema(pool, { tableName: table })
  const row = await selectMessage(pool, table, messageId)

  if (!row) return { messageId, skipped: true, status: 'MESSAGE_NOT_FOUND' }
  if (TERMINAL_MIXED_STATUSES.has(row.media_mixed_status)) {
    return {
      context: row.media_mixed_context,
      duplicate: true,
      messageId,
      skipped: true,
      status: row.media_mixed_status,
    }
  }

  if (!row.sender_phone) {
    const status = MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT
    await updateMixedResult(pool, table, messageId, { status })
    return { context: null, messageId, status }
  }

  if (isTextMessage(row) && detectCustomerCommand(getMessageText(row)).handled) {
    return { commandExcluded: true, messageId, skipped: true, status: MIXED_MESSAGE_STATUSES.PENDING }
  }

  await updateMixedResult(pool, table, messageId, { status: MIXED_MESSAGE_STATUSES.MIXED_PROCESSING })

  try {
    const currentMedia = getMediaEligibility(row)
    const nearby = await selectNearbyMessages(pool, table, row, {
      excludeConsumedTexts: Boolean(currentMedia),
    })
    let context
    let status

    if (currentMedia) {
      const nearbyTexts = nearby
        .filter(isTextMessage)
        .filter((candidate) => !detectCustomerCommand(getMessageText(candidate)).handled)

      if (nearbyTexts.length > 1) {
        const messages = [...nearbyTexts, row].sort(compareRows).map((candidate) =>
          toContextMessage(
            candidate,
            candidate.message_id === row.message_id ? 'PRIMARY' : 'CONTEXT',
            candidate.message_id === row.message_id ? currentMedia.mediaType : '',
          ))
        context = buildContext({
          candidateSource: currentMedia.candidateSource,
          contextType: 'MIXED_AMBIGUOUS',
          mediaRow: row,
          messages,
          requiresReview: true,
          sender: row.sender_phone,
          warnings: ['More than one text message is within the association window.'],
        })
        status = MIXED_MESSAGE_STATUSES.MIXED_AMBIGUOUS
      } else if (nearbyTexts.length === 1) {
        const textRow = nearbyTexts[0]
        const textIsBefore = compareRows(textRow, row) < 0
        const reviewRequired = requiresReviewForText(getMessageText(textRow))
        const messages = [textRow, row].sort(compareRows).map((candidate) =>
          toContextMessage(
            candidate,
            candidate.message_id === row.message_id ? 'PRIMARY' : textIsBefore ? 'CONTEXT' : 'FOLLOWUP',
            candidate.message_id === row.message_id ? currentMedia.mediaType : '',
          ))
        context = buildContext({
          candidateSource: currentMedia.candidateSource,
          contextType: textIsBefore
            ? 'MEDIA_PLUS_TEXT_BEFORE'
            : reviewRequired
              ? 'MEDIA_PLUS_FOLLOWUP'
              : 'MEDIA_PLUS_TEXT_AFTER',
          mediaRow: row,
          messages,
          requiresReview: reviewRequired,
          sender: row.sender_phone,
        })
        status = MIXED_MESSAGE_STATUSES.MIXED_GROUPED
      } else if (row.caption) {
        context = buildContext({
          candidateSource: currentMedia.candidateSource,
          contextType: 'MEDIA_WITH_CAPTION',
          mediaRow: row,
          messages: [toContextMessage(row, 'PRIMARY', currentMedia.mediaType)],
          requiresReview: requiresReviewForText(row.caption),
          sender: row.sender_phone,
        })
        status = MIXED_MESSAGE_STATUSES.MIXED_GROUPED
      } else {
        status = MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT
      }
    } else if (isTextMessage(row)) {
      const parentRows = nearby
        .filter((candidate) => compareRows(candidate, row) < 0)
        .filter((candidate) => Boolean(getMediaEligibility(candidate)))

      if (parentRows.length === 1) {
        const mediaRow = parentRows[0]
        const media = getMediaEligibility(mediaRow)
        const messages = [mediaRow, row].sort(compareRows).map((candidate) =>
          toContextMessage(candidate, candidate.message_id === mediaRow.message_id ? 'PRIMARY' : 'FOLLOWUP', candidate.message_id === mediaRow.message_id ? media.mediaType : ''))
        context = buildContext({
          candidateSource: media.candidateSource,
          contextType: requiresReviewForText(getMessageText(row)) ? 'MEDIA_PLUS_FOLLOWUP' : 'MEDIA_PLUS_TEXT_AFTER',
          mediaRow,
          messages,
          requiresReview: requiresReviewForText(getMessageText(row)),
          sender: row.sender_phone,
        })
        status = MIXED_MESSAGE_STATUSES.MIXED_GROUPED
      } else if (parentRows.length > 1) {
        const messages = [...parentRows, row].sort(compareRows).map((candidate) => {
          const media = getMediaEligibility(candidate)
          return toContextMessage(candidate, candidate.message_id === row.message_id ? 'FOLLOWUP' : 'POSSIBLE_PRIMARY', media?.mediaType ?? '')
        })
        context = buildContext({
          candidateSource: null,
          contextType: 'MIXED_AMBIGUOUS',
          mediaRow: null,
          messages,
          requiresReview: true,
          sender: row.sender_phone,
          warnings: ['More than one eligible media parent is within the association window.'],
        })
        status = MIXED_MESSAGE_STATUSES.MIXED_AMBIGUOUS
      } else {
        status = MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT
      }
    } else {
      status = MIXED_MESSAGE_STATUSES.MIXED_NO_CONTEXT
    }

    const updated = await updateMixedResult(pool, table, messageId, { context, status })
    return { context: updated?.media_mixed_context ?? context ?? null, messageId, status }
  } catch (error) {
    const safeError = error instanceof Error ? error.message : String(error)
    await updateMixedResult(pool, table, messageId, {
      error: safeError,
      status: MIXED_MESSAGE_STATUSES.MIXED_FAILED,
    }).catch(() => {})
    return { error: safeError, messageId, status: MIXED_MESSAGE_STATUSES.MIXED_FAILED }
  }
}

const getSafeMixedMessageLogDetails = (result = {}) => ({
  contextType: result.context?.context_type ?? '',
  messageCount: result.context?.message_ids?.length ?? 0,
  messageId: result.messageId ?? '',
  status: result.status ?? '',
  warningCount: result.context?.warnings?.length ?? 0,
})

export {
  ensureWhatsAppMixedMessageContextSchema,
  getMediaEligibility,
  getSafeMixedMessageLogDetails,
  MIXED_MESSAGE_ASSOCIATION_WINDOW_MINUTES,
  MIXED_MESSAGE_STATUSES,
  processWhatsAppMixedMessageContext,
  requiresReviewForText,
}

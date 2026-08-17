const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const UNIFIED_ORDER_VERSION = 1

const UNIFIED_ORDER_STATUSES = {
  PENDING: 'PENDING',
  UNIFYING: 'UNIFYING',
  UNIFIED_READY: 'UNIFIED_READY',
  UNIFIED_PARTIAL: 'UNIFIED_PARTIAL',
  UNIFIED_AMBIGUOUS: 'UNIFIED_AMBIGUOUS',
  UNIFIED_NO_INPUT: 'UNIFIED_NO_INPUT',
  UNIFIED_FAILED: 'UNIFIED_FAILED',
}

const SUCCESSFUL_TERMINAL_STATUSES = new Set([
  UNIFIED_ORDER_STATUSES.UNIFIED_READY,
  UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL,
  UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS,
])

const quoteIdentifier = (value) => {
  const identifier = String(value || DEFAULT_MESSAGE_TABLE_NAME)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Invalid WhatsApp message table name.')
  }
  return identifier
}

const cloneList = (value) => Array.isArray(value) ? structuredClone(value) : []

const getSourceCandidate = (row) => {
  if (row?.media_excel_candidate && ['EXCEL_PARSED', 'EXCEL_PARTIAL'].includes(row.media_excel_status)) {
    return {
      candidate: row.media_excel_candidate,
      candidateType: 'media_excel_candidate',
      partial: row.media_excel_status === 'EXCEL_PARTIAL',
      sourceType: 'EXCEL',
    }
  }

  if (row?.media_word_candidate && ['WORD_PARSED', 'WORD_PARTIAL'].includes(row.media_word_status)) {
    return {
      candidate: row.media_word_candidate,
      candidateType: 'media_word_candidate',
      partial: row.media_word_status === 'WORD_PARTIAL',
      sourceType: 'WORD',
    }
  }

  if (
    row?.media_order_candidate
    && ['PARSED', 'PARSE_PARTIAL'].includes(row.media_order_parse_status)
  ) {
    const isPdf = String(row.media_mime_type || '').toLowerCase() === 'application/pdf'
    return {
      candidate: row.media_order_candidate,
      candidateType: 'media_order_candidate',
      partial: row.media_order_parse_status === 'PARSE_PARTIAL',
      sourceType: isPdf ? 'PDF' : 'IMAGE',
    }
  }

  return null
}

const getStandaloneSourceAmbiguity = (row) => {
  if (row?.media_excel_status === 'EXCEL_AMBIGUOUS' && row.media_excel_candidate) {
    return { candidate: row.media_excel_candidate, sourceType: 'EXCEL' }
  }
  if (row?.media_word_status === 'WORD_AMBIGUOUS' && row.media_word_candidate) {
    return { candidate: row.media_word_candidate, sourceType: 'WORD' }
  }
  return null
}

const buildLineSource = ({ candidateType, line, messageId, sourceType }) => {
  const source = {
    candidate_type: candidateType,
    message_id: messageId,
  }

  if (candidateType === 'media_order_candidate') {
    source.source_text = line.source_text ?? ''
    source.source_line_number = line.source_line_number ?? null
  } else if (candidateType === 'media_excel_candidate') {
    source.sheet_name = line.sheet_name ?? null
    source.source_row = line.source_row ?? null
    source.source_cells = structuredClone(line.source_cells ?? {})
  } else if (candidateType === 'media_word_candidate') {
    source.source_type = line.source_type ?? null
    source.source_table = line.source_table ?? null
    source.source_row = line.source_row ?? null
    source.source_paragraph = line.source_paragraph ?? null
    source.source_cells = structuredClone(line.source_cells ?? {})
  }

  if (line.raw_product_code !== undefined) source.raw_product_code = line.raw_product_code
  if (!source.source_type && sourceType === 'WORD') source.source_type = null
  return source
}

const mapCandidateLines = ({ candidateInfo, messageId }) =>
  cloneList(candidateInfo.candidate?.lines).map((line, index) => ({
    sequence: line.sequence ?? index + 1,
    description: line.description ?? line.raw_description ?? '',
    raw_description: line.raw_description ?? line.description ?? '',
    quantity: line.quantity ?? null,
    raw_quantity: line.raw_quantity ?? '',
    unit: line.unit ?? '',
    source: buildLineSource({
      candidateType: candidateInfo.candidateType,
      line,
      messageId,
      sourceType: candidateInfo.sourceType,
    }),
    warnings: cloneList(line.warnings),
  }))

const getInstructions = (context) => {
  const instructions = []

  for (const message of context?.messages ?? []) {
    if (message.text !== undefined && message.text !== '') {
      instructions.push({
        message_id: message.message_id ?? '',
        role: message.role ?? 'CONTEXT',
        text: String(message.text),
        resolved: false,
      })
    }
    if (message.caption !== undefined && message.caption !== '') {
      instructions.push({
        message_id: message.message_id ?? '',
        role: 'CAPTION',
        text: String(message.caption),
        resolved: false,
      })
    }
  }

  return instructions
}

const buildUnifiedInput = ({ candidateInfo, context = null, primaryRow }) => {
  const lines = mapCandidateLines({ candidateInfo, messageId: primaryRow.message_id })
  const instructions = getInstructions(context)
  const warnings = [
    ...cloneList(candidateInfo.candidate?.warnings),
    ...cloneList(context?.warnings),
  ]
  const hasLineWarnings = lines.some((line) => line.warnings.length > 0)
  const hasMissingQuantity = lines.some((line) => line.quantity === null)
  const requiresReview = candidateInfo.partial
    || warnings.length > 0
    || hasLineWarnings
    || hasMissingQuantity
    || instructions.length > 0

  return {
    input: {
      version: UNIFIED_ORDER_VERSION,
      source_type: candidateInfo.sourceType,
      primary_message_id: primaryRow.message_id,
      sender: primaryRow.sender_phone,
      lines,
      instructions,
      requires_review: requiresReview,
      warnings,
    },
    status: requiresReview
      ? UNIFIED_ORDER_STATUSES.UNIFIED_PARTIAL
      : UNIFIED_ORDER_STATUSES.UNIFIED_READY,
  }
}

const buildAmbiguousInput = (row) => {
  const context = row.media_mixed_context ?? {}
  const possiblePrimaries = (context.messages ?? [])
    .filter((message) => message.role === 'POSSIBLE_PRIMARY')
    .map((message) => ({
      message_id: message.message_id ?? '',
      source_type: message.type ?? null,
    }))

  return {
    version: UNIFIED_ORDER_VERSION,
    source_type: 'MIXED',
    primary_message_id: null,
    sender: row.sender_phone,
    possible_primaries: possiblePrimaries,
    lines: [],
    instructions: getInstructions(context),
    requires_review: true,
    warnings: cloneList(context.warnings),
  }
}

const ensureWhatsAppUnifiedOrderInputSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  const table = quoteIdentifier(tableName)
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS unified_order_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS unified_order_input jsonb,
      ADD COLUMN IF NOT EXISTS unified_order_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS unified_order_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_unified_order_status
    ON ${table} (unified_order_status)
  `)
}

const selectMessage = async (pool, table, messageId) => {
  const result = await pool.query(
    `
      SELECT
        id, message_id, received_at, sender_phone, message_type, source_type,
        media_mime_type,
        media_order_parse_status, media_order_candidate,
        media_excel_status, media_excel_candidate,
        media_word_status, media_word_candidate,
        media_mixed_status, media_mixed_context,
        unified_order_status, unified_order_input, unified_order_processed_at, unified_order_error,
        pi_created
      FROM ${table}
      WHERE message_id = $1::varchar
      LIMIT 1
    `,
    [messageId],
  )
  return result.rows[0] ?? null
}

const updateUnifiedResult = async (
  pool,
  table,
  messageId,
  { error = null, input = null, status },
) => {
  const result = await pool.query(
    `
      UPDATE ${table}
      SET
        unified_order_status = $2::varchar,
        unified_order_input = $3::jsonb,
        unified_order_processed_at = CASE
          WHEN $2::varchar = 'UNIFYING' THEN unified_order_processed_at
          ELSE CURRENT_TIMESTAMP
        END,
        unified_order_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING unified_order_status, unified_order_input,
        unified_order_processed_at, unified_order_error
    `,
    [messageId, status, input ? JSON.stringify(input) : null, error],
  )
  return result.rows[0] ?? null
}

const processWhatsAppUnifiedOrderInput = async ({
  messageId,
  pool,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool?.query) throw new Error('PostgreSQL pool is required for unified order input.')
  const table = quoteIdentifier(tableName)
  await ensureWhatsAppUnifiedOrderInputSchema(pool, { tableName: table })
  const row = await selectMessage(pool, table, messageId)

  if (!row) return { messageId, skipped: true, status: 'MESSAGE_NOT_FOUND' }
  if (SUCCESSFUL_TERMINAL_STATUSES.has(row.unified_order_status) && row.unified_order_input) {
    return {
      duplicate: true,
      input: row.unified_order_input,
      messageId,
      skipped: true,
      status: row.unified_order_status,
    }
  }

  await updateUnifiedResult(pool, table, messageId, {
    status: UNIFIED_ORDER_STATUSES.UNIFYING,
  })

  try {
    if (row.media_mixed_status === 'MIXED_AMBIGUOUS' && row.media_mixed_context) {
      const input = buildAmbiguousInput(row)
      await updateUnifiedResult(pool, table, messageId, {
        input,
        status: UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS,
      })
      return { input, messageId, status: UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS }
    }

    let primaryRow = row
    let context = null
    if (['MIXED_GROUPED', 'MIXED_PARTIAL'].includes(row.media_mixed_status) && row.media_mixed_context) {
      context = row.media_mixed_context
      const primaryMessageId = String(context.primary_message_id ?? '')
      if (!primaryMessageId) throw new Error('Mixed context does not contain a primary_message_id.')
      primaryRow = primaryMessageId === row.message_id
        ? row
        : await selectMessage(pool, table, primaryMessageId)
      if (!primaryRow) throw new Error(`Mixed primary message was not found: ${primaryMessageId}.`)
      if (primaryRow.sender_phone !== row.sender_phone) {
        throw new Error('Mixed primary sender does not match the context sender.')
      }
    }

    const candidateInfo = getSourceCandidate(primaryRow)
    if (!candidateInfo) {
      if (context) throw new Error('Mixed primary message does not contain a usable source candidate.')
      const sourceAmbiguity = getStandaloneSourceAmbiguity(primaryRow)
      if (sourceAmbiguity) {
        const input = {
          version: UNIFIED_ORDER_VERSION,
          source_type: sourceAmbiguity.sourceType,
          primary_message_id: primaryRow.message_id,
          sender: primaryRow.sender_phone,
          possible_primaries: [],
          lines: [],
          instructions: [],
          requires_review: true,
          warnings: cloneList(sourceAmbiguity.candidate.warnings),
        }
        await updateUnifiedResult(pool, table, messageId, {
          input,
          status: UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS,
        })
        return { input, messageId, status: UNIFIED_ORDER_STATUSES.UNIFIED_AMBIGUOUS }
      }
      await updateUnifiedResult(pool, table, messageId, {
        status: UNIFIED_ORDER_STATUSES.UNIFIED_NO_INPUT,
      })
      return { input: null, messageId, status: UNIFIED_ORDER_STATUSES.UNIFIED_NO_INPUT }
    }

    const unified = buildUnifiedInput({ candidateInfo, context, primaryRow })
    await updateUnifiedResult(pool, table, messageId, unified)
    return { input: unified.input, messageId, status: unified.status }
  } catch (error) {
    const safeError = error instanceof Error ? error.message : String(error)
    await updateUnifiedResult(pool, table, messageId, {
      error: safeError,
      status: UNIFIED_ORDER_STATUSES.UNIFIED_FAILED,
    }).catch(() => {})
    return {
      error: safeError,
      input: null,
      messageId,
      status: UNIFIED_ORDER_STATUSES.UNIFIED_FAILED,
    }
  }
}

const getSafeUnifiedOrderLogDetails = (result = {}) => ({
  candidateType: result.input?.lines?.[0]?.source?.candidate_type ?? '',
  instructionCount: result.input?.instructions?.length ?? 0,
  lineCount: result.input?.lines?.length ?? 0,
  messageId: result.messageId ?? '',
  sourceType: result.input?.source_type ?? '',
  status: result.status ?? '',
  warningCount: result.input?.warnings?.length ?? 0,
})

export {
  buildAmbiguousInput,
  buildUnifiedInput,
  ensureWhatsAppUnifiedOrderInputSchema,
  getSafeUnifiedOrderLogDetails,
  getSourceCandidate,
  getStandaloneSourceAmbiguity,
  processWhatsAppUnifiedOrderInput,
  UNIFIED_ORDER_STATUSES,
}

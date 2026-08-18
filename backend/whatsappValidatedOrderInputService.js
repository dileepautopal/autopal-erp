const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const VALIDATED_ORDER_VERSION = 1

const VALIDATED_ORDER_STATUSES = {
  PENDING: 'PENDING',
  VALIDATING: 'VALIDATING',
  VALIDATED_READY: 'VALIDATED_READY',
  VALIDATED_PARTIAL: 'VALIDATED_PARTIAL',
  VALIDATION_BLOCKED_AMBIGUOUS: 'VALIDATION_BLOCKED_AMBIGUOUS',
  VALIDATION_NO_INPUT: 'VALIDATION_NO_INPUT',
  VALIDATION_REJECTED: 'VALIDATION_REJECTED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
}

const ELIGIBLE_UNIFIED_STATUSES = new Set([
  'UNIFIED_READY',
  'UNIFIED_PARTIAL',
  'UNIFIED_AMBIGUOUS',
  'UNIFIED_NO_INPUT',
  'UNIFIED_FAILED',
])

const IDEMPOTENT_STATUSES = new Set([
  VALIDATED_ORDER_STATUSES.VALIDATED_READY,
  VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL,
  VALIDATED_ORDER_STATUSES.VALIDATION_BLOCKED_AMBIGUOUS,
  VALIDATED_ORDER_STATUSES.VALIDATION_NO_INPUT,
  VALIDATED_ORDER_STATUSES.VALIDATION_REJECTED,
])

const quoteIdentifier = (value) => {
  const identifier = String(value || DEFAULT_MESSAGE_TABLE_NAME)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Invalid WhatsApp message table name.')
  }
  return identifier
}

const clone = (value) => value === undefined ? undefined : structuredClone(value)
const cloneList = (value) => Array.isArray(value) ? clone(value) : []
const compactSpaces = (value) => String(value ?? '').trim().replace(/\s+/g, ' ')
const hasValue = (value) => value !== null && value !== undefined
const addUnique = (list, value) => {
  if (!list.includes(value)) list.push(value)
}

const ensureWhatsAppValidatedOrderInputSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  const table = quoteIdentifier(tableName)
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS validated_order_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS validated_order_input jsonb,
      ADD COLUMN IF NOT EXISTS validated_order_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS validated_order_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_validated_order_status
    ON ${table} (validated_order_status)
  `)
}

const selectMessage = async (pool, table, messageId) => {
  const result = await pool.query(
    `
      SELECT
        id, message_id, sender_phone, unified_order_status, unified_order_input,
        validated_order_status, validated_order_input,
        validated_order_processed_at, validated_order_error, pi_created
      FROM ${table}
      WHERE message_id = $1::varchar
      LIMIT 1
    `,
    [messageId],
  )
  return result.rows[0] ?? null
}

const updateValidatedResult = async (
  pool,
  table,
  messageId,
  { error = null, input = null, status },
) => {
  const result = await pool.query(
    `
      UPDATE ${table}
      SET
        validated_order_status = $2::varchar,
        validated_order_input = CASE
          WHEN $2::varchar = 'VALIDATING' THEN validated_order_input
          ELSE $3::jsonb
        END,
        validated_order_processed_at = CASE
          WHEN $2::varchar = 'VALIDATING' THEN validated_order_processed_at
          ELSE CURRENT_TIMESTAMP
        END,
        validated_order_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING validated_order_status, validated_order_input,
        validated_order_processed_at, validated_order_error
    `,
    [messageId, status, input === null ? null : JSON.stringify(input), error],
  )
  return result.rows[0] ?? null
}

const hasMinimumProvenance = (source) => Boolean(
  source
  && compactSpaces(source.message_id)
  && compactSpaces(source.candidate_type),
)

const validateLines = (sourceLines) => {
  const lines = cloneList(sourceLines).map((sourceLine, index) => {
    const line = sourceLine && typeof sourceLine === 'object' ? sourceLine : {}
    const warnings = []
    const errors = []
    const rawDescription = Object.hasOwn(line, 'raw_description')
      ? clone(line.raw_description)
      : line.description ?? null
    const description = compactSpaces(line.description ?? line.raw_description)
    const rawQuantity = line.raw_quantity ?? null
    const quantity = line.quantity ?? null
    const unit = compactSpaces(line.unit) || null
    const sourceWarnings = cloneList(line.warnings)

    if (!description) addUnique(errors, 'DESCRIPTION_MISSING')
    if (!hasValue(line.quantity)) {
      addUnique(errors, 'QUANTITY_MISSING')
    } else if (typeof line.quantity !== 'number' || !Number.isFinite(line.quantity)) {
      addUnique(errors, 'QUANTITY_INVALID')
    } else if (line.quantity <= 0) {
      addUnique(errors, 'QUANTITY_NON_POSITIVE')
    }
    if (!unit) addUnique(warnings, 'UNIT_MISSING')
    if (!hasValue(line.sequence)) addUnique(warnings, 'SEQUENCE_MISSING')
    if (!hasMinimumProvenance(line.source)) addUnique(warnings, 'SOURCE_PROVENANCE_MISSING')
    if (sourceWarnings.length > 0) addUnique(warnings, 'SOURCE_WARNING')

    return {
      sequence: line.sequence ?? null,
      validation_position: index + 1,
      description,
      raw_description: rawDescription,
      quantity,
      raw_quantity: rawQuantity,
      unit,
      source: clone(line.source ?? null),
      warnings: sourceWarnings,
      source_warnings: sourceWarnings,
      validation: {
        valid: errors.length === 0,
        warnings,
        errors,
      },
    }
  })

  const sequenceCounts = new Map()
  for (const line of lines) {
    if (hasValue(line.sequence)) {
      const key = `${typeof line.sequence}:${String(line.sequence)}`
      sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1)
    }
  }
  for (const line of lines) {
    const key = `${typeof line.sequence}:${String(line.sequence)}`
    if (hasValue(line.sequence) && sequenceCounts.get(key) > 1) {
      addUnique(line.validation.warnings, 'SEQUENCE_DUPLICATE')
    }
  }

  const descriptionCounts = new Map()
  for (const line of lines) {
    if (line.description) {
      descriptionCounts.set(line.description, (descriptionCounts.get(line.description) ?? 0) + 1)
    }
  }
  for (const line of lines) {
    if (line.description && descriptionCounts.get(line.description) > 1) {
      addUnique(line.validation.warnings, 'DUPLICATE_DESCRIPTION')
    }
  }

  return lines
}

const buildBaseInput = (sourceInput, row) => ({
  version: VALIDATED_ORDER_VERSION,
  source_unified_message_id: row.message_id,
  source_type: sourceInput?.source_type ?? null,
  primary_message_id: sourceInput?.primary_message_id ?? null,
  sender: sourceInput?.sender ?? row.sender_phone ?? null,
  validation_status: VALIDATED_ORDER_STATUSES.PENDING,
  lines: [],
  instructions: cloneList(sourceInput?.instructions),
  possible_primaries: cloneList(sourceInput?.possible_primaries),
  source_requires_review: Boolean(sourceInput?.requires_review),
  source_warnings: cloneList(sourceInput?.warnings),
  requires_review: false,
  warnings: [],
  errors: [],
})

const buildValidatedInput = (row) => {
  const sourceInput = row.unified_order_input
  const result = buildBaseInput(sourceInput, row)

  if (result.source_warnings.length > 0) addUnique(result.warnings, 'SOURCE_WARNING')
  if (result.instructions.some((instruction) => instruction?.resolved !== true)) {
    addUnique(result.warnings, 'UNRESOLVED_INSTRUCTION')
  }

  if (row.unified_order_status === 'UNIFIED_AMBIGUOUS') {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATION_BLOCKED_AMBIGUOUS
    result.requires_review = true
    return result
  }

  if (row.unified_order_status === 'UNIFIED_NO_INPUT' || !sourceInput) {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATION_NO_INPUT
    result.requires_review = Boolean(
      result.source_requires_review || result.warnings.length > 0,
    )
    return result
  }

  const sourceLines = Array.isArray(sourceInput.lines) ? sourceInput.lines : []
  if (sourceLines.length === 0) {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATION_NO_INPUT
    result.requires_review = Boolean(
      result.source_requires_review || result.warnings.length > 0,
    )
    return result
  }

  result.lines = validateLines(sourceLines)
  const validLineCount = result.lines.filter((line) => line.validation.valid).length
  const hasLineIssues = result.lines.some(
    (line) => line.validation.warnings.length > 0 || line.validation.errors.length > 0,
  )
  const requiresReview = Boolean(
    sourceInput.requires_review
    || result.warnings.length > 0
    || hasLineIssues,
  )

  if (validLineCount === 0) {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATION_REJECTED
    result.requires_review = true
  } else if (requiresReview) {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATED_PARTIAL
    result.requires_review = true
  } else {
    result.validation_status = VALIDATED_ORDER_STATUSES.VALIDATED_READY
  }

  return result
}

const safeErrorMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Order validation failed.'
}

const buildResult = ({ duplicate = false, error = '', input = null, messageId, skipped = false, status }) => {
  const lines = input?.lines ?? []
  return {
    duplicate,
    error,
    input,
    invalidLineCount: lines.filter((line) => !line.validation?.valid).length,
    messageId,
    skipped,
    status,
    validLineCount: lines.filter((line) => line.validation?.valid).length,
  }
}

const processWhatsAppValidatedOrderInput = async ({
  messageId,
  pool,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool?.query) throw new Error('PostgreSQL pool is required for validated order input.')
  const table = quoteIdentifier(tableName)
  const startedAt = Date.now()

  try {
    await ensureWhatsAppValidatedOrderInputSchema(pool, { tableName: table })
    const row = await selectMessage(pool, table, messageId)

    if (!row) {
      return { durationMs: Date.now() - startedAt, messageId, skipped: true, status: 'MESSAGE_NOT_FOUND' }
    }
    if (IDEMPOTENT_STATUSES.has(row.validated_order_status) && row.validated_order_input) {
      return {
        ...buildResult({
          duplicate: true,
          input: row.validated_order_input,
          messageId,
          skipped: true,
          status: row.validated_order_status,
        }),
        durationMs: Date.now() - startedAt,
      }
    }
    if (!ELIGIBLE_UNIFIED_STATUSES.has(row.unified_order_status)) {
      return {
        durationMs: Date.now() - startedAt,
        messageId,
        skipped: true,
        status: row.validated_order_status || VALIDATED_ORDER_STATUSES.PENDING,
      }
    }

    await updateValidatedResult(pool, table, messageId, {
      status: VALIDATED_ORDER_STATUSES.VALIDATING,
    })

    if (row.unified_order_status === 'UNIFIED_FAILED') {
      const error = 'Source unified order input is in UNIFIED_FAILED state.'
      await updateValidatedResult(pool, table, messageId, {
        error,
        status: VALIDATED_ORDER_STATUSES.VALIDATION_FAILED,
      })
      return {
        ...buildResult({ error, messageId, status: VALIDATED_ORDER_STATUSES.VALIDATION_FAILED }),
        durationMs: Date.now() - startedAt,
      }
    }

    const input = buildValidatedInput(row)
    await updateValidatedResult(pool, table, messageId, {
      input,
      status: input.validation_status,
    })
    return {
      ...buildResult({ input, messageId, status: input.validation_status }),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const safeError = safeErrorMessage(error)
    await updateValidatedResult(pool, table, messageId, {
      error: safeError,
      status: VALIDATED_ORDER_STATUSES.VALIDATION_FAILED,
    }).catch(() => {})
    return {
      ...buildResult({ error: safeError, messageId, status: VALIDATED_ORDER_STATUSES.VALIDATION_FAILED }),
      durationMs: Date.now() - startedAt,
    }
  }
}

const getSafeValidatedOrderLogDetails = (result = {}) => ({
  durationMs: Number(result.durationMs ?? 0),
  error: result.error || '',
  errorCount: (result.input?.errors?.length ?? 0)
    + (result.input?.lines ?? []).reduce(
      (count, line) => count + (line.validation?.errors?.length ?? 0),
      0,
    ),
  instructionCount: result.input?.instructions?.length ?? 0,
  invalidLineCount: Number(result.invalidLineCount ?? 0),
  lineCount: result.input?.lines?.length ?? 0,
  messageId: result.messageId ?? '',
  sender: result.input?.sender ?? '',
  sourceType: result.input?.source_type ?? '',
  status: result.status ?? '',
  validLineCount: Number(result.validLineCount ?? 0),
  warningCount: (result.input?.warnings?.length ?? 0)
    + (result.input?.lines ?? []).reduce(
      (count, line) => count + (line.validation?.warnings?.length ?? 0),
      0,
    ),
})

export {
  buildValidatedInput,
  ensureWhatsAppValidatedOrderInputSchema,
  getSafeValidatedOrderLogDetails,
  processWhatsAppValidatedOrderInput,
  VALIDATED_ORDER_STATUSES,
  validateLines,
}

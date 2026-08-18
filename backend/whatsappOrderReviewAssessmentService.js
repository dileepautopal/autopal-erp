const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const REVIEW_DECISION_VERSION = 1
const REVIEW_SCOPE = 'STRUCTURAL_ORDER_INPUT'

const ORDER_REVIEW_STATUSES = {
  PENDING: 'PENDING',
  ASSESSING: 'ASSESSING',
  AUTO_READY: 'AUTO_READY',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  BLOCKED: 'BLOCKED',
  NO_INPUT: 'NO_INPUT',
  ASSESSMENT_FAILED: 'ASSESSMENT_FAILED',
}

const CONFIDENCE_BANDS = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NONE: 'NONE',
}

const ELIGIBLE_VALIDATION_STATUSES = new Set([
  'VALIDATED_READY',
  'VALIDATED_PARTIAL',
  'VALIDATION_BLOCKED_AMBIGUOUS',
  'VALIDATION_NO_INPUT',
  'VALIDATION_REJECTED',
  'VALIDATION_FAILED',
])

const IDEMPOTENT_REVIEW_STATUSES = new Set([
  ORDER_REVIEW_STATUSES.AUTO_READY,
  ORDER_REVIEW_STATUSES.MANUAL_REVIEW,
  ORDER_REVIEW_STATUSES.BLOCKED,
  ORDER_REVIEW_STATUSES.NO_INPUT,
])

const SEVERITY_BY_CODE = {
  AMBIGUOUS_INPUT: 'BLOCKING',
  VALIDATION_REJECTED: 'BLOCKING',
  NO_USABLE_LINES: 'BLOCKING',
  NO_INPUT: 'INFO',
  UNRESOLVED_INSTRUCTION: 'HIGH',
  SOURCE_PROVENANCE_MISSING: 'HIGH',
  DESCRIPTION_MISSING: 'HIGH',
  QUANTITY_MISSING: 'HIGH',
  QUANTITY_INVALID: 'HIGH',
  QUANTITY_NON_POSITIVE: 'HIGH',
  UNIT_MISSING: 'MEDIUM',
  SEQUENCE_DUPLICATE: 'MEDIUM',
  DUPLICATE_DESCRIPTION: 'MEDIUM',
  SOURCE_WARNING: 'MEDIUM',
  SOURCE_REQUIRES_REVIEW: 'MEDIUM',
  SEQUENCE_MISSING: 'LOW',
}

const REASON_ORDER = [
  'AMBIGUOUS_INPUT',
  'VALIDATION_REJECTED',
  'NO_USABLE_LINES',
  'NO_INPUT',
  'UNRESOLVED_INSTRUCTION',
  'DESCRIPTION_MISSING',
  'QUANTITY_MISSING',
  'QUANTITY_INVALID',
  'QUANTITY_NON_POSITIVE',
  'SOURCE_PROVENANCE_MISSING',
  'UNIT_MISSING',
  'SEQUENCE_DUPLICATE',
  'SEQUENCE_MISSING',
  'DUPLICATE_DESCRIPTION',
  'SOURCE_WARNING',
  'SOURCE_REQUIRES_REVIEW',
]

const quoteIdentifier = (value) => {
  const identifier = String(value || DEFAULT_MESSAGE_TABLE_NAME)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Invalid WhatsApp message table name.')
  }
  return identifier
}

const clone = (value) => value === undefined ? undefined : structuredClone(value)
const cloneList = (value) => Array.isArray(value) ? clone(value) : []
const toCode = (value) => {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') return String(value.code ?? '').trim()
  return ''
}
const toCodes = (value) => cloneList(value).map(toCode).filter(Boolean)
const addReason = (reasons, code) => {
  if (code && !reasons.includes(code)) reasons.push(code)
}
const getSeverity = (code) => SEVERITY_BY_CODE[code] ?? 'MEDIUM'

const sortReasons = (reasons) => {
  const priorities = new Map(REASON_ORDER.map((code, index) => [code, index]))
  return [...reasons].sort((left, right) => {
    const leftPriority = priorities.get(left) ?? REASON_ORDER.length
    const rightPriority = priorities.get(right) ?? REASON_ORDER.length
    return leftPriority - rightPriority || left.localeCompare(right)
  })
}

const getConfidenceBand = (score) => {
  if (score >= 90) return CONFIDENCE_BANDS.HIGH
  if (score >= 70) return CONFIDENCE_BANDS.MEDIUM
  if (score > 0) return CONFIDENCE_BANDS.LOW
  return CONFIDENCE_BANDS.NONE
}

const ensureWhatsAppOrderReviewAssessmentSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  const table = quoteIdentifier(tableName)
  await pool.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS review_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS review_decision jsonb,
      ADD COLUMN IF NOT EXISTS review_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS review_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_review_status
    ON ${table} (review_status)
  `)
}

const selectMessage = async (pool, table, messageId) => {
  const result = await pool.query(
    `
      SELECT
        id, message_id, sender_phone,
        validated_order_status, validated_order_input,
        review_status, review_decision, review_processed_at, review_error,
        pi_created
      FROM ${table}
      WHERE message_id = $1::varchar
      LIMIT 1
    `,
    [messageId],
  )
  return result.rows[0] ?? null
}

const updateReviewResult = async (
  pool,
  table,
  messageId,
  { decision = null, error = null, status },
) => {
  const result = await pool.query(
    `
      UPDATE ${table}
      SET
        review_status = $2::varchar,
        review_decision = CASE
          WHEN $2::varchar = 'ASSESSING' THEN review_decision
          ELSE $3::jsonb
        END,
        review_processed_at = CASE
          WHEN $2::varchar = 'ASSESSING' THEN review_processed_at
          ELSE CURRENT_TIMESTAMP
        END,
        review_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING review_status, review_decision, review_processed_at, review_error
    `,
    [messageId, status, decision === null ? null : JSON.stringify(decision), error],
  )
  return result.rows[0] ?? null
}

const getEvidence = (validatedInput) => {
  const lines = cloneList(validatedInput?.lines)
  const instructions = cloneList(validatedInput?.instructions)
  const orderWarnings = toCodes(validatedInput?.warnings)
  const orderErrors = toCodes(validatedInput?.errors)
  const validLines = lines.filter((line) => line?.validation?.valid === true)
  const invalidLines = lines.filter((line) => line?.validation?.valid !== true)
  const unresolvedInstructions = instructions.filter(
    (instruction) => instruction?.resolved !== true,
  )
  const lineWarnings = lines.flatMap((line) => toCodes(line?.validation?.warnings))
  const lineErrors = lines.flatMap((line) => toCodes(line?.validation?.errors))

  return {
    instructions,
    invalidLines,
    lines,
    orderErrors,
    orderWarnings,
    summary: {
      total_lines: lines.length,
      valid_lines: validLines.length,
      invalid_lines: invalidLines.length,
      instruction_count: instructions.length,
      warning_count: orderWarnings.length + lineWarnings.length,
      error_count: orderErrors.length + lineErrors.length,
    },
    unresolvedInstructions,
    validLines,
    warningCodes: [...orderWarnings, ...lineWarnings],
  }
}

const createLineReviewItem = (code, line) => ({
  code,
  severity: getSeverity(code),
  validation_position: line?.validation_position ?? null,
  sequence: line?.sequence ?? null,
  source_message_id: line?.source?.message_id ?? null,
})

const collectReviewDetails = (validatedInput, evidence) => {
  const reasons = []
  const reviewItems = []

  evidence.unresolvedInstructions.forEach((instruction) => {
    addReason(reasons, 'UNRESOLVED_INSTRUCTION')
    reviewItems.push({
      code: 'UNRESOLVED_INSTRUCTION',
      severity: getSeverity('UNRESOLVED_INSTRUCTION'),
      source_message_id: instruction?.message_id ?? null,
      instruction_text: instruction?.text ?? '',
    })
  })

  for (const code of evidence.orderWarnings) {
    addReason(reasons, code)
    if (code !== 'UNRESOLVED_INSTRUCTION' || evidence.unresolvedInstructions.length === 0) {
      reviewItems.push({ code, severity: getSeverity(code) })
    }
  }
  for (const code of evidence.orderErrors) {
    addReason(reasons, code)
    reviewItems.push({ code, severity: getSeverity(code) })
  }

  for (const line of evidence.lines) {
    for (const code of toCodes(line?.validation?.warnings)) {
      addReason(reasons, code)
      reviewItems.push(createLineReviewItem(code, line))
    }
    for (const code of toCodes(line?.validation?.errors)) {
      addReason(reasons, code)
      reviewItems.push(createLineReviewItem(code, line))
    }
  }

  if (validatedInput?.source_requires_review) {
    addReason(reasons, 'SOURCE_REQUIRES_REVIEW')
    reviewItems.push({
      code: 'SOURCE_REQUIRES_REVIEW',
      severity: getSeverity('SOURCE_REQUIRES_REVIEW'),
    })
  }

  return { reasons: sortReasons(reasons), reviewItems }
}

const calculateDeterministicScore = (evidence) => {
  const warningCodes = evidence.warningCodes
  const warningSet = new Set(warningCodes)
  const unresolvedCount = Math.max(
    evidence.unresolvedInstructions.length,
    warningSet.has('UNRESOLVED_INSTRUCTION') ? 1 : 0,
  )
  const handledWarnings = new Set([
    'UNRESOLVED_INSTRUCTION',
    'SOURCE_PROVENANCE_MISSING',
    'UNIT_MISSING',
    'SEQUENCE_DUPLICATE',
    'SEQUENCE_MISSING',
    'DUPLICATE_DESCRIPTION',
    'SOURCE_WARNING',
  ])
  const unknownWarnings = [...warningSet].filter((code) => !handledWarnings.has(code))
  let deduction = 0

  deduction += Math.min(unresolvedCount * 40, 60)
  deduction += Math.min(evidence.invalidLines.length * 30, 60)
  if (warningSet.has('SOURCE_PROVENANCE_MISSING')) deduction += 20
  deduction += Math.min(
    warningCodes.filter((code) => code === 'UNIT_MISSING').length * 15,
    30,
  )
  if (warningSet.has('SEQUENCE_DUPLICATE')) deduction += 10
  if (warningSet.has('SEQUENCE_MISSING')) deduction += 10
  if (warningSet.has('DUPLICATE_DESCRIPTION')) deduction += 10
  if (warningSet.has('SOURCE_WARNING')) deduction += 10
  deduction += Math.min(unknownWarnings.length * 10, 30)

  return Math.max(0, Math.min(100, 100 - deduction))
}

const buildDecision = ({
  confidenceBand,
  decision,
  evidence,
  reasons,
  requiresManualReview,
  reviewItems,
  row,
  score,
} = {}) => ({
  version: REVIEW_DECISION_VERSION,
  scope: REVIEW_SCOPE,
  decision,
  confidence_band: confidenceBand,
  score,
  requires_manual_review: requiresManualReview,
  source_validation_status: row.validated_order_status,
  source_validation_message_id:
    row.validated_order_input?.source_unified_message_id ?? row.message_id,
  summary: evidence.summary,
  reasons,
  review_items: reviewItems,
})

const buildOrderReviewDecision = (row) => {
  const validatedInput = row.validated_order_input

  if (row.validated_order_status === 'VALIDATION_BLOCKED_AMBIGUOUS') {
    const evidence = getEvidence(validatedInput)
    const decision = buildDecision({
      confidenceBand: CONFIDENCE_BANDS.NONE,
      decision: ORDER_REVIEW_STATUSES.BLOCKED,
      evidence,
      reasons: ['AMBIGUOUS_INPUT'],
      requiresManualReview: true,
      reviewItems: [{ code: 'AMBIGUOUS_INPUT', severity: 'BLOCKING' }],
      row,
      score: 0,
    })
    decision.possible_primaries = cloneList(validatedInput?.possible_primaries)
    return decision
  }

  if (row.validated_order_status === 'VALIDATION_REJECTED') {
    const evidence = getEvidence(validatedInput)
    const details = collectReviewDetails(validatedInput, evidence)
    return buildDecision({
      confidenceBand: CONFIDENCE_BANDS.NONE,
      decision: ORDER_REVIEW_STATUSES.BLOCKED,
      evidence,
      reasons: sortReasons(['VALIDATION_REJECTED', ...details.reasons]),
      requiresManualReview: true,
      reviewItems: [
        { code: 'VALIDATION_REJECTED', severity: 'BLOCKING' },
        ...details.reviewItems,
      ],
      row,
      score: 0,
    })
  }

  if (row.validated_order_status === 'VALIDATION_NO_INPUT') {
    const evidence = getEvidence(validatedInput)
    return buildDecision({
      confidenceBand: CONFIDENCE_BANDS.NONE,
      decision: ORDER_REVIEW_STATUSES.NO_INPUT,
      evidence,
      reasons: ['NO_INPUT'],
      requiresManualReview: false,
      reviewItems: [],
      row,
      score: 0,
    })
  }

  if (!validatedInput || typeof validatedInput !== 'object') {
    throw new Error('Validated order input is missing for review assessment.')
  }

  const evidence = getEvidence(validatedInput)
  const details = collectReviewDetails(validatedInput, evidence)
  if (evidence.validLines.length === 0) {
    return buildDecision({
      confidenceBand: CONFIDENCE_BANDS.NONE,
      decision: ORDER_REVIEW_STATUSES.BLOCKED,
      evidence,
      reasons: sortReasons([...details.reasons, 'NO_USABLE_LINES']),
      requiresManualReview: true,
      reviewItems: [
        { code: 'NO_USABLE_LINES', severity: 'BLOCKING' },
        ...details.reviewItems,
      ],
      row,
      score: 0,
    })
  }

  const score = calculateDeterministicScore(evidence)
  const confidenceBand = getConfidenceBand(score)
  const cleanForAutomaticProgress = Boolean(
    row.validated_order_status === 'VALIDATED_READY'
    && validatedInput.requires_review === false
    && evidence.validLines.length > 0
    && evidence.invalidLines.length === 0
    && evidence.unresolvedInstructions.length === 0
    && evidence.summary.warning_count === 0
    && evidence.summary.error_count === 0
    && score >= 90,
  )

  return buildDecision({
    confidenceBand,
    decision: cleanForAutomaticProgress
      ? ORDER_REVIEW_STATUSES.AUTO_READY
      : ORDER_REVIEW_STATUSES.MANUAL_REVIEW,
    evidence,
    reasons: details.reasons,
    requiresManualReview: !cleanForAutomaticProgress,
    reviewItems: details.reviewItems,
    row,
    score,
  })
}

const safeErrorMessage = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Order review assessment failed.'
}

const buildResult = ({ decision = null, duplicate = false, error = '', messageId, sender = '', skipped = false, status }) => ({
  decision,
  duplicate,
  error,
  messageId,
  sender,
  skipped,
  status,
})

const processWhatsAppOrderReviewAssessment = async ({
  messageId,
  pool,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool?.query) throw new Error('PostgreSQL pool is required for order review assessment.')
  const table = quoteIdentifier(tableName)
  const startedAt = Date.now()

  try {
    await ensureWhatsAppOrderReviewAssessmentSchema(pool, { tableName: table })
    const row = await selectMessage(pool, table, messageId)

    if (!row) {
      return { durationMs: Date.now() - startedAt, messageId, skipped: true, status: 'MESSAGE_NOT_FOUND' }
    }
    if (IDEMPOTENT_REVIEW_STATUSES.has(row.review_status) && row.review_decision) {
      return {
        ...buildResult({
          decision: row.review_decision,
          duplicate: true,
          messageId,
          sender: row.sender_phone,
          skipped: true,
          status: row.review_status,
        }),
        durationMs: Date.now() - startedAt,
      }
    }
    if (!ELIGIBLE_VALIDATION_STATUSES.has(row.validated_order_status)) {
      return {
        durationMs: Date.now() - startedAt,
        messageId,
        skipped: true,
        status: row.review_status || ORDER_REVIEW_STATUSES.PENDING,
      }
    }

    await updateReviewResult(pool, table, messageId, {
      status: ORDER_REVIEW_STATUSES.ASSESSING,
    })

    if (row.validated_order_status === 'VALIDATION_FAILED') {
      const error = 'Source validated order input is in VALIDATION_FAILED state.'
      await updateReviewResult(pool, table, messageId, {
        error,
        status: ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED,
      })
      return {
        ...buildResult({ error, messageId, sender: row.sender_phone, status: ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED }),
        durationMs: Date.now() - startedAt,
      }
    }

    const decision = buildOrderReviewDecision(row)
    await updateReviewResult(pool, table, messageId, {
      decision,
      status: decision.decision,
    })
    return {
      ...buildResult({ decision, messageId, sender: row.sender_phone, status: decision.decision }),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const safeError = safeErrorMessage(error)
    await updateReviewResult(pool, table, messageId, {
      error: safeError,
      status: ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED,
    }).catch(() => {})
    return {
      ...buildResult({ error: safeError, messageId, status: ORDER_REVIEW_STATUSES.ASSESSMENT_FAILED }),
      durationMs: Date.now() - startedAt,
    }
  }
}

const getSafeOrderReviewLogDetails = (result = {}) => ({
  confidenceBand: result.decision?.confidence_band ?? '',
  decision: result.decision?.decision ?? '',
  durationMs: Number(result.durationMs ?? 0),
  instructionCount: result.decision?.summary?.instruction_count ?? 0,
  invalidLineCount: result.decision?.summary?.invalid_lines ?? 0,
  messageId: result.messageId ?? '',
  reasonCount: result.decision?.reasons?.length ?? 0,
  score: result.decision?.score ?? null,
  sender: result.sender ?? '',
  sourceValidationStatus: result.decision?.source_validation_status ?? '',
  status: result.status ?? '',
  totalLineCount: result.decision?.summary?.total_lines ?? 0,
  validLineCount: result.decision?.summary?.valid_lines ?? 0,
})

export {
  buildOrderReviewDecision,
  calculateDeterministicScore,
  CONFIDENCE_BANDS,
  ensureWhatsAppOrderReviewAssessmentSchema,
  getConfidenceBand,
  getSafeOrderReviewLogDetails,
  ORDER_REVIEW_STATUSES,
  processWhatsAppOrderReviewAssessment,
}

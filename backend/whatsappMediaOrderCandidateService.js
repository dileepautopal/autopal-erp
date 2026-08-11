const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'

const MEDIA_ORDER_PARSE_STATUSES = {
  NO_ORDER_LINES: 'NO_ORDER_LINES',
  PARSED: 'PARSED',
  PARSE_FAILED: 'PARSE_FAILED',
  PARSE_PARTIAL: 'PARSE_PARTIAL',
  PARSING: 'PARSING',
  PENDING: 'PENDING',
}

const UNIT_ALIASES = new Map([
  ['NO', 'NOS'],
  ['N0S', 'NOS'],
  ['NOG', 'NOS'],
  ['NOS', 'NOS'],
  ['NOX', 'NOS'],
  ['PC', 'PCS'],
  ['PCS', 'PCS'],
  ['PIECE', 'PCS'],
  ['PIECES', 'PCS'],
  ['SET', 'SET'],
  ['SETS', 'SET'],
  ['UNIT', 'UNIT'],
  ['UNITS', 'UNIT'],
])

const NOS_LIKE_UNIT_PATTERN = "NOS?\\.?(?:\\+[^A-Za-z0-9\\s]{1,6})?|NO[GX](?:\\.|['’]|â€™)?|N0S\\.?"
const UNIT_PATTERN = `${NOS_LIKE_UNIT_PATTERN}|PCS?\\.?|PIECES?|SETS?|UNITS?`
const UNIT_END_PATTERN = '(?=\\s|$|[,;|])'
const NOISE_PATTERNS = [
  /^amount(?:\s+chargeable)?\b/i,
  /^authori[sz]ed\s+signatory\b/i,
  /^date\b/i,
  /^debit\s+note\s+no\b/i,
  /^description(?:\s+of\s+goods)?\b/i,
  /^gst\s+debit\s+note\b/i,
  /^gstin\b/i,
  /^igst\b/i,
  /^invoice(?:\s+no|\s+number)?\b/i,
  /^round(?:ing)?\s+off\b/i,
  /^sub[ -]?total\b/i,
  /^tax(?:able)?\s+(?:amount|value)\b/i,
  /^total\b/i,
]

const toText = (value) => String(value ?? '').trim()
const compactSpaces = (value) => toText(value).replace(/[|]+/g, ' ').replace(/\s+/g, ' ')

const normalizeUnit = (value) => {
  const key = toText(value)
    .replace(/\+\S+$/g, '')
    .replace(/â€™|[.'’]/g, '')
    .toUpperCase()

  return UNIT_ALIASES.get(key) || key
}

const normalizeQuantity = (value) => {
  const normalized = toText(value).replace(/,/g, '')
  const quantity = Number(normalized)

  return Number.isFinite(quantity) && quantity >= 0 ? quantity : null
}

const isNoiseLine = (line) => {
  const value = compactSpaces(line)

  return !value || NOISE_PATTERNS.some((pattern) => pattern.test(value))
}

const hasReadableDescription = (value) => {
  const description = compactSpaces(value)
  const alphaNumericCount = description.match(/[A-Za-z0-9]/g)?.length ?? 0
  const letterCount = description.match(/[A-Za-z]/g)?.length ?? 0

  return description.length >= 3 && alphaNumericCount >= 3 && letterCount >= 2
}

const stripLeadingSequence = (value) => {
  const text = compactSpaces(value)
  const match = text.match(/^(\d{1,4})\s*[.)-]?\s+(.+)$/)

  if (!match) {
    return { description: text, sequence: null }
  }

  return {
    description: compactSpaces(match[2]),
    sequence: Number(match[1]),
  }
}

const parseCandidateSource = ({ sourceLineNumber, sourceText }, fallbackSequence) => {
  const normalizedSource = compactSpaces(sourceText)
  const labelledQuantityPattern = new RegExp(
    `^(?<before>.*?)\\bQTY\\s*[:.-]?\\s*(?<rawQuantity>\\d+(?:[.,]\\d+)?)(?:\\s*(?<unit>${UNIT_PATTERN})${UNIT_END_PATTERN})?(?<after>.*)$`,
    'i',
  )
  const quantityWithUnitPattern = new RegExp(
    `^(?<before>.*?)\\b(?<rawQuantity>\\d+(?:[.,]\\d+)?)\\s*(?<unit>${UNIT_PATTERN})${UNIT_END_PATTERN}(?<after>.*)$`,
    'i',
  )
  const match = normalizedSource.match(labelledQuantityPattern)
    || normalizedSource.match(quantityWithUnitPattern)

  if (match?.groups) {
    const stripped = stripLeadingSequence(match.groups.before)
    const description = stripped.description.replace(/[-:;,]+$/g, '').trim()

    if (!hasReadableDescription(description) || isNoiseLine(description)) {
      return null
    }

    const quantity = normalizeQuantity(match.groups.rawQuantity)
    const warnings = []

    if (quantity === null) {
      warnings.push('Quantity could not be normalized safely.')
    }

    return {
      line: {
        sequence: stripped.sequence ?? fallbackSequence,
        raw_description: description,
        quantity,
        raw_quantity: match.groups.rawQuantity,
        unit: match.groups.unit ? normalizeUnit(match.groups.unit) : '',
        source_text: sourceText,
        source_line_number: sourceLineNumber,
        warnings,
      },
      rawUnit: match.groups.unit || '',
      warning: null,
    }
  }

  const ambiguousUnitPattern = new RegExp(`^(?<before>.*?)\\s+[^A-Za-z0-9\\s]+\\s*(?<unit>${UNIT_PATTERN})${UNIT_END_PATTERN}`, 'i')
  const ambiguousMatch = normalizedSource.match(ambiguousUnitPattern)

  if (ambiguousMatch?.groups) {
    const stripped = stripLeadingSequence(ambiguousMatch.groups.before)

    if (hasReadableDescription(stripped.description) && !isNoiseLine(stripped.description)) {
      const warning = `Source line ${sourceLineNumber}: quantity is ambiguous and was not inferred.`

      return {
        line: {
          sequence: stripped.sequence ?? fallbackSequence,
          raw_description: stripped.description,
          quantity: null,
          raw_quantity: '',
          unit: normalizeUnit(ambiguousMatch.groups.unit),
          source_text: sourceText,
          source_line_number: sourceLineNumber,
          warnings: [warning],
        },
        rawUnit: ambiguousMatch.groups.unit,
        warning,
      }
    }
  }

  return null
}

const isQuantityContinuation = (line) =>
  new RegExp(`^(?:QTY\\s*[:.-]?\\s*)?\\d+(?:[.,]\\d+)?\\s*(?:${UNIT_PATTERN})${UNIT_END_PATTERN}`, 'i')
    .test(compactSpaces(line))

const parseStandaloneQuantity = (line) => {
  const match = compactSpaces(line).match(new RegExp(
    `^(?:QTY\\s*[:.-]?\\s*)?(?<rawQuantity>\\d+(?:[.,]\\d+)?)\\s*(?<unit>${UNIT_PATTERN})${UNIT_END_PATTERN}(?<after>.*)$`,
    'i',
  ))

  if (!match?.groups || compactSpaces(match.groups.after)) {
    return null
  }

  return {
    quantity: normalizeQuantity(match.groups.rawQuantity),
    rawQuantity: match.groups.rawQuantity,
    rawUnit: match.groups.unit,
    unit: normalizeUnit(match.groups.unit),
  }
}

const isNoisyNosUnit = (unit) =>
  normalizeUnit(unit) === 'NOS' && !/^NOS?\.?$/i.test(toText(unit))

const canAttachDelayedQuantity = ({
  candidateEndLineNumber,
  currentLineNumber,
  sourceLines,
}) => {
  const intervening = sourceLines.filter(({ lineNumber }) =>
    lineNumber > candidateEndLineNumber && lineNumber < currentLineNumber)

  return intervening.length <= 3
    && intervening.every(({ text }) => !/[A-Za-z]{2,}/.test(text))
}

const isLikelyWrappedDescription = (line) => {
  const stripped = stripLeadingSequence(line).description

  return hasReadableDescription(stripped) && !isNoiseLine(stripped) && !/\b(?:QTY|TOTAL|AMOUNT)\b/i.test(stripped)
}

const parseMediaOrderCandidateText = (text) => {
  const sourceLines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((value, index) => ({ lineNumber: index + 1, text: compactSpaces(value) }))
    .filter(({ text: value }) => value)
  const lines = []
  const candidateEndLineNumbers = []
  const candidateRawUnits = []
  const warnings = []

  for (let index = 0; index < sourceLines.length; index += 1) {
    const current = sourceLines[index]

    if (isNoiseLine(current.text)) {
      continue
    }

    let sourceText = current.text
    let consumedNextLine = false
    const next = sourceLines[index + 1]

    if (next && isLikelyWrappedDescription(current.text) && isQuantityContinuation(next.text)) {
      sourceText = `${current.text}\n${next.text}`
      consumedNextLine = true
    }

    const parsed = parseCandidateSource({
      sourceLineNumber: current.lineNumber,
      sourceText,
    }, lines.length + 1)

    if (parsed?.line) {
      lines.push(parsed.line)
      candidateEndLineNumbers.push(consumedNextLine ? next.lineNumber : current.lineNumber)
      candidateRawUnits.push(parsed.rawUnit)

      if (parsed.warning) {
        warnings.push(parsed.warning)
      }

      if (consumedNextLine) {
        index += 1
      }
    } else {
      const delayedQuantity = parseStandaloneQuantity(current.text)
      const candidateIndex = lines.length - 1
      const candidate = lines[candidateIndex]

      if (
        candidate
        && delayedQuantity?.quantity !== null
        && delayedQuantity?.unit === 'NOS'
        && isNoisyNosUnit(delayedQuantity.rawUnit)
        && !isNoisyNosUnit(candidateRawUnits[candidateIndex])
        && canAttachDelayedQuantity({
          candidateEndLineNumber: candidateEndLineNumbers[candidateIndex],
          currentLineNumber: current.lineNumber,
          sourceLines,
        })
      ) {
        candidate.quantity = delayedQuantity.quantity
        candidate.raw_quantity = delayedQuantity.rawQuantity
        candidate.unit = delayedQuantity.unit
        candidateRawUnits[candidateIndex] = delayedQuantity.rawUnit
        candidate.source_text = sourceLines
          .filter(({ lineNumber }) =>
            lineNumber >= candidate.source_line_number && lineNumber <= current.lineNumber)
          .map(({ text }) => text)
          .join('\n')
        candidateEndLineNumbers[candidateIndex] = current.lineNumber
      }
    }
  }

  if (lines.length === 0) {
    warnings.push(sourceLines.length === 0
      ? 'Extracted media text is empty.'
      : 'No conservative order-line candidates were found in extracted media text.')
  }

  const hasLineWarnings = lines.some((line) => line.warnings.length > 0)
  const status = lines.length === 0
    ? MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES
    : hasLineWarnings || warnings.length > 0
      ? MEDIA_ORDER_PARSE_STATUSES.PARSE_PARTIAL
      : MEDIA_ORDER_PARSE_STATUSES.PARSED

  return {
    candidate: {
      version: 1,
      lines,
      warnings,
    },
    status,
  }
}

const ensureWhatsAppMediaOrderCandidateSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_order_parse_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_order_candidate jsonb,
      ADD COLUMN IF NOT EXISTS media_order_parsed_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_order_parse_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_order_parse_status
    ON ${tableName} (media_order_parse_status)
  `)
}

const getExtractedMediaRow = async (pool, { messageId, tableName }) => {
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        media_extraction_status,
        media_extracted_text,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        pi_created
      FROM ${tableName}
      WHERE message_id = $1
      LIMIT 1
    `,
    [messageId],
  )

  return result.rows[0] ?? null
}

const updateMediaOrderParseStatus = async (
  pool,
  { candidate = null, error = null, messageId, status, tableName },
) => {
  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_order_parse_status = $2::varchar,
        media_order_candidate = CASE
          WHEN $3::jsonb IS NULL THEN media_order_candidate
          ELSE $3::jsonb
        END,
        media_order_parsed_at = CASE
          WHEN $2::varchar IN ('PARSED', 'PARSE_PARTIAL', 'NO_ORDER_LINES') THEN CURRENT_TIMESTAMP
          ELSE media_order_parsed_at
        END,
        media_order_parse_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING
        id,
        message_id,
        media_extraction_status,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        pi_created
    `,
    [messageId, status, candidate ? JSON.stringify(candidate) : null, error],
  )

  return result.rows[0] ?? null
}

const buildMediaOrderParseResult = ({
  candidate = null,
  error = '',
  messageId = '',
  skipped = false,
  status = MEDIA_ORDER_PARSE_STATUSES.PENDING,
} = {}) => ({
  candidate,
  error,
  lineCount: candidate?.lines?.length ?? 0,
  messageId,
  skipped,
  status,
})

const safeErrorMessage = (error) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000)

const parseExtractedWhatsAppMediaOrderCandidate = async ({
  messageId,
  pool,
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp media order candidate parsing.')
  }

  await ensureWhatsAppMediaOrderCandidateSchema(pool, { tableName })
  const row = await getExtractedMediaRow(pool, { messageId, tableName })

  if (!row) {
    throw new Error(`Extracted WhatsApp media row was not found for ${messageId}.`)
  }

  if (row.media_order_parse_status === MEDIA_ORDER_PARSE_STATUSES.PARSED && row.media_order_candidate) {
    return buildMediaOrderParseResult({
      candidate: row.media_order_candidate,
      messageId,
      skipped: true,
      status: MEDIA_ORDER_PARSE_STATUSES.PARSED,
    })
  }

  if (row.media_extraction_status !== 'EXTRACTED') {
    return buildMediaOrderParseResult({
      error: 'Media text extraction is not complete, so order candidate parsing was not started.',
      messageId,
      skipped: true,
      status: row.media_order_parse_status || MEDIA_ORDER_PARSE_STATUSES.PENDING,
    })
  }

  try {
    await updateMediaOrderParseStatus(pool, {
      messageId,
      status: MEDIA_ORDER_PARSE_STATUSES.PARSING,
      tableName,
    })
    const parsed = parseMediaOrderCandidateText(row.media_extracted_text)
    const updatedRow = await updateMediaOrderParseStatus(pool, {
      candidate: parsed.candidate,
      error: null,
      messageId,
      status: parsed.status,
      tableName,
    })

    return buildMediaOrderParseResult({
      candidate: updatedRow?.media_order_candidate ?? parsed.candidate,
      messageId,
      status: updatedRow?.media_order_parse_status ?? parsed.status,
    })
  } catch (error) {
    const errorMessage = safeErrorMessage(error)
    const updatedRow = await updateMediaOrderParseStatus(pool, {
      error: errorMessage,
      messageId,
      status: MEDIA_ORDER_PARSE_STATUSES.PARSE_FAILED,
      tableName,
    }).catch(() => null)

    return buildMediaOrderParseResult({
      error: errorMessage,
      messageId,
      status: updatedRow?.media_order_parse_status ?? MEDIA_ORDER_PARSE_STATUSES.PARSE_FAILED,
    })
  }
}

const getSafeMediaOrderParseLogDetails = (result = {}) => ({
  error: result.error || '',
  lineCount: Number(result.lineCount ?? 0),
  messageId: result.messageId || '',
  parseStatus: result.status || '',
  skipped: Boolean(result.skipped),
  warningCount: result.candidate?.warnings?.length ?? 0,
})

export {
  ensureWhatsAppMediaOrderCandidateSchema,
  getSafeMediaOrderParseLogDetails,
  MEDIA_ORDER_PARSE_STATUSES,
  normalizeUnit,
  parseExtractedWhatsAppMediaOrderCandidate,
  parseMediaOrderCandidateText,
}

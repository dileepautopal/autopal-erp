import fs from 'node:fs/promises'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import mammoth from 'mammoth'

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const DEFAULT_STORAGE_ROOT = 'storage/whatsapp-media'

const WORD_PROCESSING_LIMITS = {
  MAX_CANDIDATE_LINES: 1000,
  MAX_COLUMNS_PER_TABLE: 50,
  MAX_DOCUMENT_XML_BYTES: 10 * 1024 * 1024,
  MAX_DOCX_FILE_BYTES: 15 * 1024 * 1024,
  MAX_HEADER_SCAN_ROWS: 30,
  MAX_HTML_BYTES: 10 * 1024 * 1024,
  MAX_PARAGRAPHS: 5000,
  MAX_ROWS_PER_TABLE: 2000,
  MAX_TABLES: 50,
  MAX_TEXT_CHARACTERS: 2_000_000,
  MAX_UNCOMPRESSED_BYTES: 50 * 1024 * 1024,
  MAX_ZIP_ENTRIES: 2000,
}

const MEDIA_WORD_STATUSES = {
  PENDING: 'PENDING',
  WORD_AMBIGUOUS: 'WORD_AMBIGUOUS',
  WORD_FAILED: 'WORD_FAILED',
  WORD_NO_ORDER_LINES: 'WORD_NO_ORDER_LINES',
  WORD_PARSED: 'WORD_PARSED',
  WORD_PARTIAL: 'WORD_PARTIAL',
  WORD_PROCESSING: 'WORD_PROCESSING',
  WORD_UNSUPPORTED: 'WORD_UNSUPPORTED',
}

const WORD_MIME_TYPES = new Map([
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
])

const DESCRIPTION_HEADERS = new Set([
  'description',
  'description of goods',
  'item',
  'item description',
  'item name',
  'material',
  'material description',
  'material name',
  'part',
  'part description',
  'part name',
  'product',
  'product description',
  'product name',
])
const QUANTITY_HEADERS = new Set(['order qty', 'ordered qty', 'qty', 'quantity'])
const UNIT_HEADERS = new Set(['u m', 'u o m', 'unit', 'uom'])
const PRODUCT_CODE_HEADERS = new Set([
  'item code',
  'material code',
  'part no',
  'part number',
  'product code',
])
const FOOTER_PATTERNS = [
  /^amount\b/i,
  /^authori[sz]ed\s+signatory\b/i,
  /^c?gst\b/i,
  /^grand\s+total\b/i,
  /^igst\b/i,
  /^remarks?\b/i,
  /^round(?:ing)?\s+off\b/i,
  /^sgst\b/i,
  /^sub[ -]?total\b/i,
  /^total\b/i,
]
const PARAGRAPH_NOISE_PATTERNS = [
  /^address\b/i,
  /^amount\b/i,
  /^date\b/i,
  /^dispatch\b/i,
  /^gst\b/i,
  /^invoice\b/i,
  /^(?:order|po)\s*(?:no|number)\b/i,
  /^phone\b/i,
  /^reference\b/i,
  /^please\b/i,
  /^purchase order\b/i,
  /^remarks?\b/i,
  /^total\b/i,
]

class WordUnsupportedError extends Error {}
class WordLimitError extends WordUnsupportedError {}

const toText = (value) => String(value ?? '').trim()
const compactSpaces = (value) => toText(value).replace(/\s+/g, ' ')
const normalizeProjectRelativePath = (value) => toText(value).replace(/\\/g, '/')
const safeErrorMessage = (error) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000)

const normalizeHeader = (value) =>
  compactSpaces(value)
    .toLowerCase()
    .replace(/[._/\\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeWordUnit = (value) => {
  const text = compactSpaces(value)
  const key = text.replace(/\./g, '').toUpperCase()

  if (['NO', 'NOS'].includes(key)) {
    return 'NOS'
  }

  if (['PC', 'PCS', 'PIECE', 'PIECES'].includes(key)) {
    return 'PCS'
  }

  if (['SET', 'SETS'].includes(key)) {
    return 'SET'
  }

  return text
}

const parseWordQuantity = (value) => {
  const rawQuantity = compactSpaces(value)

  if (!rawQuantity) {
    return { embeddedUnit: '', quantity: null, rawQuantity: '' }
  }

  const match = rawQuantity.match(
    /^(?:(?:QTY|QUANTITY)\s*[:.-]?\s*)?(?<quantity>\d+(?:\.\d+)?)(?:\s*(?<unit>NOS?\.?|PCS?\.?|PIECES?|SETS?))?$/i,
  )

  if (!match?.groups) {
    return { embeddedUnit: '', quantity: null, rawQuantity }
  }

  const quantity = Number(match.groups.quantity)

  return {
    embeddedUnit: match.groups.unit ? normalizeWordUnit(match.groups.unit) : '',
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    rawQuantity,
  }
}

const getWordDocumentType = ({ mediaPath = '', mimeType = '' } = {}) => {
  const normalizedMimeType = toText(mimeType).toLowerCase()
  const mimeResult = WORD_MIME_TYPES.get(normalizedMimeType)

  if (mimeResult) {
    return mimeResult
  }

  if (normalizedMimeType) {
    return ''
  }

  const extension = path.extname(toText(mediaPath)).slice(1).toLowerCase()

  return ['doc', 'docx'].includes(extension) ? extension : ''
}

const isSupportedWordMedia = (input = {}) => Boolean(getWordDocumentType(input))

const getStorageRoot = ({
  env = process.env,
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) =>
  path.resolve(projectRoot, storageRoot || env.WHATSAPP_MEDIA_STORAGE_DIR || DEFAULT_STORAGE_ROOT)

const assertInsideDirectory = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved Word media path is outside the configured media storage directory.')
  }
}

const resolveStoredWordPath = ({
  env = process.env,
  mediaPath = '',
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) => {
  const normalizedMediaPath = normalizeProjectRelativePath(mediaPath)

  if (!normalizedMediaPath) {
    throw new Error('Downloaded Word media path is missing.')
  }

  if (normalizedMediaPath.includes('\u0000')) {
    throw new Error('Downloaded Word media path contains an invalid character.')
  }

  const absoluteStorageRoot = getStorageRoot({ env, projectRoot, storageRoot })
  const absolutePath = path.resolve(projectRoot, normalizedMediaPath)

  assertInsideDirectory(absolutePath, absoluteStorageRoot)

  return { absolutePath, relativePath: normalizedMediaPath }
}

const assertDocxSignature = (buffer) => {
  const isZip = buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04
  const oleSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  const isOle = buffer.length >= oleSignature.length
    && oleSignature.every((value, index) => buffer[index] === value)

  if (isOle) {
    throw new WordUnsupportedError('Password-protected or legacy Word documents are not supported.')
  }

  if (!isZip) {
    throw new WordUnsupportedError('File contents are not a valid DOCX document.')
  }
}

const getDeclaredUncompressedSize = (entry) =>
  Number(entry?._data?.uncompressedSize ?? entry?._data?.compressedContent?.length ?? 0)

const inspectDocxPackage = async (buffer) => {
  if (buffer.length > WORD_PROCESSING_LIMITS.MAX_DOCX_FILE_BYTES) {
    throw new WordLimitError(
      `DOCX file exceeds the ${WORD_PROCESSING_LIMITS.MAX_DOCX_FILE_BYTES}-byte file limit.`,
    )
  }

  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false })
  const entries = Object.values(archive.files)

  if (entries.length > WORD_PROCESSING_LIMITS.MAX_ZIP_ENTRIES) {
    throw new WordLimitError(
      `DOCX package exceeds the ${WORD_PROCESSING_LIMITS.MAX_ZIP_ENTRIES}-entry limit.`,
    )
  }

  const uncompressedBytes = entries.reduce(
    (total, entry) => total + getDeclaredUncompressedSize(entry),
    0,
  )

  if (uncompressedBytes > WORD_PROCESSING_LIMITS.MAX_UNCOMPRESSED_BYTES) {
    throw new WordLimitError(
      `DOCX package exceeds the ${WORD_PROCESSING_LIMITS.MAX_UNCOMPRESSED_BYTES}-byte expanded limit.`,
    )
  }

  const documentEntry = archive.file('word/document.xml')

  if (!documentEntry) {
    throw new WordUnsupportedError('DOCX package does not contain a Word document body.')
  }

  const documentXml = await documentEntry.async('uint8array')

  if (documentXml.byteLength > WORD_PROCESSING_LIMITS.MAX_DOCUMENT_XML_BYTES) {
    throw new WordLimitError(
      `DOCX document XML exceeds the ${WORD_PROCESSING_LIMITS.MAX_DOCUMENT_XML_BYTES}-byte limit.`,
    )
  }
}

const getNodeText = (node) => {
  let value = ''

  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child.nodeType === 3 || child.nodeType === 4) {
      value += child.nodeValue ?? ''
    } else if (String(child.nodeName).toLowerCase() === 'br') {
      value += ' '
    } else {
      value += getNodeText(child)
    }
  }

  return compactSpaces(value)
}

const closestAncestor = (node, nodeName) => {
  let current = node?.parentNode
  const target = nodeName.toLowerCase()

  while (current) {
    if (String(current.nodeName).toLowerCase() === target) {
      return current
    }
    current = current.parentNode
  }

  return null
}

const parseConvertedWordHtml = (html) => {
  if (Buffer.byteLength(html, 'utf8') > WORD_PROCESSING_LIMITS.MAX_HTML_BYTES) {
    throw new WordLimitError(
      `Converted Word content exceeds the ${WORD_PROCESSING_LIMITS.MAX_HTML_BYTES}-byte limit.`,
    )
  }

  const parserErrors = []
  const document = new DOMParser({
    errorHandler: {
      error: (message) => parserErrors.push(message),
      fatalError: (message) => parserErrors.push(message),
      warning: () => {},
    },
  }).parseFromString(`<word-root>${html}</word-root>`, 'application/xml')

  if (parserErrors.length > 0) {
    throw new Error('Converted DOCX structure could not be parsed safely.')
  }

  const tableNodes = Array.from(document.getElementsByTagName('table'))

  if (tableNodes.length > WORD_PROCESSING_LIMITS.MAX_TABLES) {
    throw new WordLimitError(
      `Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_TABLES}-table limit.`,
    )
  }

  let textCharacters = 0
  const tables = tableNodes.map((tableNode, tableIndex) => {
    const rowNodes = Array.from(tableNode.getElementsByTagName('tr'))
      .filter((rowNode) => closestAncestor(rowNode, 'table') === tableNode)

    if (rowNodes.length > WORD_PROCESSING_LIMITS.MAX_ROWS_PER_TABLE) {
      throw new WordLimitError(
        `Word table ${tableIndex + 1} exceeds the ${WORD_PROCESSING_LIMITS.MAX_ROWS_PER_TABLE}-row limit.`,
      )
    }

    const rows = rowNodes.map((rowNode) => {
      const cells = Array.from(rowNode.childNodes)
        .filter((node) => ['td', 'th'].includes(String(node.nodeName).toLowerCase()))

      if (cells.length > WORD_PROCESSING_LIMITS.MAX_COLUMNS_PER_TABLE) {
        throw new WordLimitError(
          `Word table ${tableIndex + 1} exceeds the ${WORD_PROCESSING_LIMITS.MAX_COLUMNS_PER_TABLE}-column limit.`,
        )
      }

      return cells.map((cell) => {
        const value = getNodeText(cell)
        textCharacters += value.length
        return value
      })
    })

    return { rows }
  })

  const paragraphNodes = Array.from(document.getElementsByTagName('p'))
    .filter((node) => !closestAncestor(node, 'table'))

  if (paragraphNodes.length > WORD_PROCESSING_LIMITS.MAX_PARAGRAPHS) {
    throw new WordLimitError(
      `Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_PARAGRAPHS}-paragraph limit.`,
    )
  }

  const paragraphs = paragraphNodes.map((node) => {
    const value = getNodeText(node)
    textCharacters += value.length
    return value
  })

  if (textCharacters > WORD_PROCESSING_LIMITS.MAX_TEXT_CHARACTERS) {
    throw new WordLimitError(
      `Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_TEXT_CHARACTERS}-character inspection limit.`,
    )
  }

  return { paragraphs, tables }
}

const readDocxSafely = async ({ buffer } = {}) => {
  assertDocxSignature(buffer)
  await inspectDocxPackage(buffer)

  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      externalFileAccess: false,
    },
  )

  return {
    ...parseConvertedWordHtml(result.value ?? ''),
    parserWarnings: (result.messages ?? [])
      .map((message) => compactSpaces(message.message))
      .filter(Boolean)
      .slice(0, 20),
  }
}

const detectHeaderColumns = (row = []) => {
  const columns = {}

  row.forEach((value, columnIndex) => {
    const header = normalizeHeader(value)

    if (columns.description === undefined && DESCRIPTION_HEADERS.has(header)) {
      columns.description = columnIndex
    } else if (columns.quantity === undefined && QUANTITY_HEADERS.has(header)) {
      columns.quantity = columnIndex
    } else if (columns.unit === undefined && UNIT_HEADERS.has(header)) {
      columns.unit = columnIndex
    } else if (columns.productCode === undefined && PRODUCT_CODE_HEADERS.has(header)) {
      columns.productCode = columnIndex
    }
  })

  return columns.description !== undefined && columns.quantity !== undefined ? columns : null
}

const isFooterDescription = (value) =>
  FOOTER_PATTERNS.some((pattern) => pattern.test(compactSpaces(value)))

const buildTableLines = ({ candidateBudget, columns, headerRowIndex, rows, tableIndex }) => {
  const lines = []
  const warnings = []
  let validQuantityCount = 0

  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? []
    const description = compactSpaces(row[columns.description])

    if (!description || isFooterDescription(description)) {
      continue
    }

    if (candidateBudget.remaining <= 0) {
      throw new WordLimitError(
        `Word candidate line limit of ${WORD_PROCESSING_LIMITS.MAX_CANDIDATE_LINES} was exceeded.`,
      )
    }
    candidateBudget.remaining -= 1

    const parsedQuantity = parseWordQuantity(row[columns.quantity])
    const rawUnit = columns.unit === undefined
      ? parsedQuantity.embeddedUnit
      : row[columns.unit]
    const lineWarnings = []

    if (parsedQuantity.quantity === null) {
      lineWarnings.push(`Table ${tableIndex + 1}, row ${rowIndex + 1}: quantity is missing or invalid and was not inferred.`)
      warnings.push(lineWarnings[0])
    } else {
      validQuantityCount += 1
    }

    const sourceCells = {
      description: `table${tableIndex + 1}:r${rowIndex + 1}:c${columns.description + 1}`,
      quantity: `table${tableIndex + 1}:r${rowIndex + 1}:c${columns.quantity + 1}`,
    }

    if (columns.unit !== undefined) {
      sourceCells.unit = `table${tableIndex + 1}:r${rowIndex + 1}:c${columns.unit + 1}`
    }
    if (columns.productCode !== undefined) {
      sourceCells.product_code = `table${tableIndex + 1}:r${rowIndex + 1}:c${columns.productCode + 1}`
    }

    const line = {
      quantity: parsedQuantity.quantity,
      raw_description: description,
      raw_quantity: parsedQuantity.rawQuantity,
      sequence: lines.length + 1,
      source_cells: sourceCells,
      source_row: rowIndex + 1,
      source_table: tableIndex + 1,
      source_type: 'TABLE',
      unit: normalizeWordUnit(rawUnit),
      warnings: lineWarnings,
    }

    if (columns.productCode !== undefined) {
      const rawProductCode = compactSpaces(row[columns.productCode])
      if (rawProductCode) {
        line.raw_product_code = rawProductCode
      }
    }

    lines.push(line)
  }

  return { lines, validQuantityCount, warnings }
}

const inspectTables = (tables, candidateBudget) => {
  const candidates = []

  tables.forEach((table, tableIndex) => {
    const rows = Array.isArray(table?.rows) ? table.rows : []
    const lastHeaderIndex = Math.min(rows.length, WORD_PROCESSING_LIMITS.MAX_HEADER_SCAN_ROWS)

    for (let rowIndex = 0; rowIndex < lastHeaderIndex; rowIndex += 1) {
      const columns = detectHeaderColumns(rows[rowIndex])
      if (!columns) {
        continue
      }

      const parsed = buildTableLines({
        candidateBudget,
        columns,
        headerRowIndex: rowIndex,
        rows,
        tableIndex,
      })

      if (parsed.validQuantityCount === 0) {
        continue
      }

      candidates.push({
        columns,
        headerRow: rowIndex + 1,
        lines: parsed.lines,
        score:
          100
          + Math.min(parsed.validQuantityCount, 25)
          + (columns.unit === undefined ? 0 : 5)
          + (columns.productCode === undefined ? 0 : 2),
        tableIndex: tableIndex + 1,
        warnings: parsed.warnings,
      })
    }
  })

  return candidates
}

const parseParagraphLine = (paragraph, paragraphIndex) => {
  const text = compactSpaces(paragraph)
  const match = text.match(
    /^(?<description>.+?)(?:\s*[-–—:]\s*|\s+(?:QTY|QUANTITY)\s*:?\s*)(?<quantity>\d+(?:\.\d+)?)(?:\s*(?<unit>NOS?\.?|PCS?\.?|PIECES?|SETS?))?$/i,
  )

  if (!match?.groups) {
    return null
  }

  const description = compactSpaces(match.groups.description)
  const rawQuantity = compactSpaces(
    `${match.groups.quantity}${match.groups.unit ? ` ${match.groups.unit}` : ''}`,
  )

  if (
    description.length < 3
    || !/[a-z]/i.test(description)
    || PARAGRAPH_NOISE_PATTERNS.some((pattern) => pattern.test(description))
  ) {
    return null
  }

  const parsedQuantity = parseWordQuantity(rawQuantity)
  if (parsedQuantity.quantity === null) {
    return null
  }

  return {
    quantity: parsedQuantity.quantity,
    raw_description: description,
    raw_quantity: parsedQuantity.rawQuantity,
    sequence: 0,
    source_paragraph: paragraphIndex + 1,
    source_type: 'PARAGRAPH',
    unit: normalizeWordUnit(parsedQuantity.embeddedUnit),
    warnings: [],
  }
}

const buildColumnMap = (columns) => {
  const result = {
    description: columns.description + 1,
    quantity: columns.quantity + 1,
  }
  if (columns.unit !== undefined) {
    result.unit = columns.unit + 1
  }
  if (columns.productCode !== undefined) {
    result.product_code = columns.productCode + 1
  }
  return result
}

const analyzeWordDocument = ({ document = {}, fileType = 'docx' } = {}) => {
  const tables = Array.isArray(document.tables) ? document.tables : []
  const paragraphs = Array.isArray(document.paragraphs) ? document.paragraphs : []

  if (tables.length > WORD_PROCESSING_LIMITS.MAX_TABLES) {
    throw new WordLimitError(`Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_TABLES}-table limit.`)
  }
  if (paragraphs.length > WORD_PROCESSING_LIMITS.MAX_PARAGRAPHS) {
    throw new WordLimitError(`Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_PARAGRAPHS}-paragraph limit.`)
  }

  let textCharacters = 0
  tables.forEach((table, tableIndex) => {
    const rows = Array.isArray(table?.rows) ? table.rows : []
    if (rows.length > WORD_PROCESSING_LIMITS.MAX_ROWS_PER_TABLE) {
      throw new WordLimitError(`Word table ${tableIndex + 1} exceeds the ${WORD_PROCESSING_LIMITS.MAX_ROWS_PER_TABLE}-row limit.`)
    }
    rows.forEach((row) => {
      if (row.length > WORD_PROCESSING_LIMITS.MAX_COLUMNS_PER_TABLE) {
        throw new WordLimitError(`Word table ${tableIndex + 1} exceeds the ${WORD_PROCESSING_LIMITS.MAX_COLUMNS_PER_TABLE}-column limit.`)
      }
      row.forEach((cell) => { textCharacters += toText(cell).length })
    })
  })
  paragraphs.forEach((paragraph) => { textCharacters += toText(paragraph).length })
  if (textCharacters > WORD_PROCESSING_LIMITS.MAX_TEXT_CHARACTERS) {
    throw new WordLimitError(`Word document exceeds the ${WORD_PROCESSING_LIMITS.MAX_TEXT_CHARACTERS}-character inspection limit.`)
  }

  const candidateBudget = { remaining: WORD_PROCESSING_LIMITS.MAX_CANDIDATE_LINES }
  const tableCandidates = inspectTables(tables, candidateBudget)

  if (tableCandidates.length > 0) {
    tableCandidates.sort((left, right) => right.score - left.score)
    const selected = tableCandidates[0]
    const equallyPlausible = tableCandidates.filter((candidate) => candidate.score === selected.score)

    if (equallyPlausible.length > 1) {
      const tableList = equallyPlausible.map((candidate) => candidate.tableIndex).join(', ')
      return {
        candidate: {
          columns: {},
          extraction_method: 'WORD_TABLE',
          file_type: fileType,
          header_row: null,
          lines: [],
          paragraph_count: paragraphs.length,
          selected_table: null,
          table_count: tables.length,
          version: 1,
          warnings: [`Multiple equally plausible Word order tables were found: ${tableList}.`],
        },
        status: MEDIA_WORD_STATUSES.WORD_AMBIGUOUS,
      }
    }

    return {
      candidate: {
        columns: buildColumnMap(selected.columns),
        extraction_method: 'WORD_TABLE',
        file_type: fileType,
        header_row: selected.headerRow,
        lines: selected.lines,
        paragraph_count: paragraphs.length,
        selected_table: selected.tableIndex,
        table_count: tables.length,
        version: 1,
        warnings: selected.warnings,
      },
      status: selected.warnings.length > 0
        ? MEDIA_WORD_STATUSES.WORD_PARTIAL
        : MEDIA_WORD_STATUSES.WORD_PARSED,
    }
  }

  const paragraphLines = paragraphs
    .map((paragraph, index) => parseParagraphLine(paragraph, index))
    .filter(Boolean)

  if (paragraphLines.length > WORD_PROCESSING_LIMITS.MAX_CANDIDATE_LINES) {
    throw new WordLimitError(
      `Word candidate line limit of ${WORD_PROCESSING_LIMITS.MAX_CANDIDATE_LINES} was exceeded.`,
    )
  }

  if (paragraphLines.length > 0) {
    paragraphLines.forEach((line, index) => { line.sequence = index + 1 })
    return {
      candidate: {
        columns: {},
        extraction_method: 'WORD_PARAGRAPH',
        file_type: fileType,
        header_row: null,
        lines: paragraphLines,
        paragraph_count: paragraphs.length,
        selected_table: null,
        table_count: tables.length,
        version: 1,
        warnings: [],
      },
      status: MEDIA_WORD_STATUSES.WORD_PARSED,
    }
  }

  return {
    candidate: {
      columns: {},
      extraction_method: 'NONE',
      file_type: fileType,
      header_row: null,
      lines: [],
      paragraph_count: paragraphs.length,
      selected_table: null,
      table_count: tables.length,
      version: 1,
      warnings: ['No credible Word order table or clear paragraph order lines were found.'],
    },
    status: MEDIA_WORD_STATUSES.WORD_NO_ORDER_LINES,
  }
}

const ensureWhatsAppWordProcessingSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_word_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_word_candidate jsonb,
      ADD COLUMN IF NOT EXISTS media_word_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_word_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_word_status
    ON ${tableName} (media_word_status)
  `)
}

const getDownloadedWordRow = async (pool, { messageId, tableName }) => {
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        media_id,
        media_mime_type,
        media_path,
        media_capture_status,
        media_download_status,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        pi_created
      FROM ${tableName}
      WHERE message_id = $1
      LIMIT 1
    `,
    [messageId],
  )
  return result.rows[0] ?? null
}

const updateWordStatus = async (
  pool,
  { candidate = null, error = null, messageId, status, tableName },
) => {
  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_word_status = $2::varchar,
        media_word_candidate = CASE
          WHEN $3::jsonb IS NULL THEN media_word_candidate
          ELSE $3::jsonb
        END,
        media_word_processed_at = CASE
          WHEN $2::varchar IN (
            'WORD_PARSED',
            'WORD_PARTIAL',
            'WORD_NO_ORDER_LINES',
            'WORD_AMBIGUOUS',
            'WORD_UNSUPPORTED',
            'WORD_FAILED'
          ) THEN CURRENT_TIMESTAMP
          ELSE media_word_processed_at
        END,
        media_word_error = $4::text,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING
        id,
        message_id,
        media_id,
        media_mime_type,
        media_path,
        media_capture_status,
        media_download_status,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        pi_created
    `,
    [messageId, status, candidate ? JSON.stringify(candidate) : null, error],
  )
  return result.rows[0] ?? null
}

const buildWordProcessingResult = ({
  candidate = null,
  documentType = '',
  durationMs = 0,
  error = '',
  mediaId = '',
  messageId = '',
  mimeType = '',
  skipped = false,
  status = MEDIA_WORD_STATUSES.PENDING,
} = {}) => ({
  candidate,
  documentType,
  durationMs,
  error,
  extractionMethod: candidate?.extraction_method ?? '',
  lineCount: candidate?.lines?.length ?? 0,
  mediaId,
  messageId,
  mimeType,
  paragraphCount: candidate?.paragraph_count ?? 0,
  selectedTable: candidate?.selected_table ?? null,
  skipped,
  status,
  tableCount: candidate?.table_count ?? 0,
  warningCount: candidate?.warnings?.length ?? 0,
})

const isEncryptedWordError = (error) =>
  /password|encrypted|encryption|protected document/i.test(safeErrorMessage(error))

const processDownloadedWhatsAppWord = async ({
  documentReader = readDocxSafely,
  env = process.env,
  messageId,
  pool,
  projectRoot = process.cwd(),
  storageRoot = '',
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp Word processing.')
  }

  const startedAt = Date.now()
  await ensureWhatsAppWordProcessingSchema(pool, { tableName })
  const row = await getDownloadedWordRow(pool, { messageId, tableName })

  if (!row) {
    throw new Error(`Downloaded WhatsApp Word row was not found for ${messageId}.`)
  }

  const documentType = getWordDocumentType({
    mediaPath: row.media_path,
    mimeType: row.media_mime_type,
  })

  if (row.media_word_status === MEDIA_WORD_STATUSES.WORD_PARSED && row.media_word_candidate) {
    return buildWordProcessingResult({
      candidate: row.media_word_candidate,
      documentType,
      durationMs: Date.now() - startedAt,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      skipped: true,
      status: MEDIA_WORD_STATUSES.WORD_PARSED,
    })
  }

  if (row.media_download_status !== 'DOWNLOADED') {
    return buildWordProcessingResult({
      documentType,
      durationMs: Date.now() - startedAt,
      error: 'Media download is not complete, so Word processing was not started.',
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      skipped: true,
      status: row.media_word_status || MEDIA_WORD_STATUSES.PENDING,
    })
  }

  if (!documentType) {
    const error = 'Media is not a supported Word document.'
    const updatedRow = await updateWordStatus(pool, {
      error,
      messageId,
      status: MEDIA_WORD_STATUSES.WORD_UNSUPPORTED,
      tableName,
    })
    return buildWordProcessingResult({
      durationMs: Date.now() - startedAt,
      error,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_word_status || MEDIA_WORD_STATUSES.WORD_UNSUPPORTED,
    })
  }

  if (documentType === 'doc') {
    const error = 'Legacy .doc Word format is not supported by the current safe parser.'
    const updatedRow = await updateWordStatus(pool, {
      error,
      messageId,
      status: MEDIA_WORD_STATUSES.WORD_UNSUPPORTED,
      tableName,
    })
    return buildWordProcessingResult({
      documentType,
      durationMs: Date.now() - startedAt,
      error,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_word_status || MEDIA_WORD_STATUSES.WORD_UNSUPPORTED,
    })
  }

  try {
    await updateWordStatus(pool, {
      messageId,
      status: MEDIA_WORD_STATUSES.WORD_PROCESSING,
      tableName,
    })
    const resolvedPath = resolveStoredWordPath({
      env,
      mediaPath: row.media_path,
      projectRoot,
      storageRoot,
    })
    const originalBuffer = await fs.readFile(resolvedPath.absolutePath)
    assertDocxSignature(originalBuffer)
    const document = await documentReader({ buffer: originalBuffer })
    const analyzed = analyzeWordDocument({ document, fileType: documentType })
    const updatedRow = await updateWordStatus(pool, {
      candidate: analyzed.candidate,
      error: null,
      messageId,
      status: analyzed.status,
      tableName,
    })

    return buildWordProcessingResult({
      candidate: updatedRow?.media_word_candidate ?? analyzed.candidate,
      documentType,
      durationMs: Date.now() - startedAt,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_word_status ?? analyzed.status,
    })
  } catch (error) {
    const encrypted = isEncryptedWordError(error)
    const unsupported = error instanceof WordUnsupportedError || encrypted
    const errorMessage = encrypted
      ? 'Password-protected Word documents are not supported.'
      : safeErrorMessage(error)
    const status = unsupported
      ? MEDIA_WORD_STATUSES.WORD_UNSUPPORTED
      : MEDIA_WORD_STATUSES.WORD_FAILED
    const updatedRow = await updateWordStatus(pool, {
      error: errorMessage,
      messageId,
      status,
      tableName,
    }).catch(() => null)

    return buildWordProcessingResult({
      documentType,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_word_status || status,
    })
  }
}

const getSafeWordProcessingLogDetails = (result = {}) => ({
  documentType: result.documentType || '',
  durationMs: Number(result.durationMs ?? 0),
  error: result.error || '',
  extractionMethod: result.extractionMethod || '',
  lineCount: Number(result.lineCount ?? 0),
  mediaId: result.mediaId || '',
  messageId: result.messageId || '',
  mimeType: result.mimeType || '',
  paragraphCount: Number(result.paragraphCount ?? 0),
  selectedTable: result.selectedTable ?? null,
  skipped: Boolean(result.skipped),
  status: result.status || '',
  tableCount: Number(result.tableCount ?? 0),
  warningCount: Number(result.warningCount ?? 0),
})

export {
  analyzeWordDocument,
  ensureWhatsAppWordProcessingSchema,
  getSafeWordProcessingLogDetails,
  getWordDocumentType,
  isSupportedWordMedia,
  MEDIA_WORD_STATUSES,
  normalizeWordUnit,
  parseConvertedWordHtml,
  parseWordQuantity,
  processDownloadedWhatsAppWord,
  readDocxSafely,
  resolveStoredWordPath,
  WORD_PROCESSING_LIMITS,
}

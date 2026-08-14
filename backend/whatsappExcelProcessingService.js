import fs from 'node:fs/promises'
import path from 'node:path'
import * as XLSX from 'xlsx'

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const DEFAULT_STORAGE_ROOT = 'storage/whatsapp-media'

const EXCEL_PROCESSING_LIMITS = {
  MAX_CANDIDATE_ROWS: 1000,
  MAX_COLUMNS_PER_SHEET: 100,
  MAX_HEADER_SCAN_ROWS: 50,
  MAX_ROWS_PER_SHEET: 5000,
  MAX_SHEETS: 20,
}

const MEDIA_EXCEL_STATUSES = {
  EXCEL_AMBIGUOUS: 'EXCEL_AMBIGUOUS',
  EXCEL_FAILED: 'EXCEL_FAILED',
  EXCEL_NO_ORDER_LINES: 'EXCEL_NO_ORDER_LINES',
  EXCEL_PARSED: 'EXCEL_PARSED',
  EXCEL_PARTIAL: 'EXCEL_PARTIAL',
  EXCEL_PROCESSING: 'EXCEL_PROCESSING',
  EXCEL_UNSUPPORTED: 'EXCEL_UNSUPPORTED',
  PENDING: 'PENDING',
}

const EXCEL_MIME_TYPES = new Map([
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
])

const DESCRIPTION_HEADERS = new Set([
  'description',
  'description of goods',
  'item',
  'item description',
  'material',
  'material description',
  'part',
  'part description',
  'product',
  'product description',
])
const QUANTITY_HEADERS = new Set([
  'order qty',
  'ordered qty',
  'qty',
  'quantity',
])
const UNIT_HEADERS = new Set(['u m', 'u o m', 'uom', 'unit'])
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

class ExcelUnsupportedError extends Error {}
class ExcelLimitError extends ExcelUnsupportedError {}

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

const normalizeExcelUnit = (value) => {
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

const parseExcelQuantity = (value) => {
  const rawQuantity = compactSpaces(value)

  if (!rawQuantity) {
    return { quantity: null, rawQuantity: '', embeddedUnit: '' }
  }

  const match = rawQuantity.match(
    /^(?:QTY\s*[:.-]?\s*)?(?<quantity>\d+(?:\.\d+)?)(?:\s*(?<unit>NOS?\.?|PCS?\.?|PIECES?|SETS?))?$/i,
  )

  if (!match?.groups) {
    return { quantity: null, rawQuantity, embeddedUnit: '' }
  }

  const quantity = Number(match.groups.quantity)

  return {
    embeddedUnit: match.groups.unit ? normalizeExcelUnit(match.groups.unit) : '',
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    rawQuantity,
  }
}

const getWorkbookType = ({ mediaPath = '', mimeType = '' } = {}) => {
  const normalizedMimeType = toText(mimeType).toLowerCase()
  const mimeTypeResult = EXCEL_MIME_TYPES.get(normalizedMimeType)

  if (mimeTypeResult) {
    return mimeTypeResult
  }

  if (normalizedMimeType) {
    return ''
  }

  const extension = path.extname(toText(mediaPath)).slice(1).toLowerCase()

  return ['xls', 'xlsx'].includes(extension) ? extension : ''
}

const isSupportedExcelMedia = (input = {}) => Boolean(getWorkbookType(input))

const getStorageRoot = ({
  env = process.env,
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) =>
  path.resolve(projectRoot, storageRoot || env.WHATSAPP_MEDIA_STORAGE_DIR || DEFAULT_STORAGE_ROOT)

const assertInsideDirectory = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved Excel media path is outside the configured media storage directory.')
  }
}

const resolveStoredExcelPath = ({
  env = process.env,
  mediaPath = '',
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) => {
  const normalizedMediaPath = normalizeProjectRelativePath(mediaPath)

  if (!normalizedMediaPath) {
    throw new Error('Downloaded Excel media path is missing.')
  }

  if (normalizedMediaPath.includes('\u0000')) {
    throw new Error('Downloaded Excel media path contains an invalid character.')
  }

  const absoluteStorageRoot = getStorageRoot({ env, projectRoot, storageRoot })
  const absolutePath = path.resolve(projectRoot, normalizedMediaPath)

  assertInsideDirectory(absolutePath, absoluteStorageRoot)

  return {
    absolutePath,
    relativePath: normalizedMediaPath,
  }
}

const assertWorkbookSignature = (buffer, fileType) => {
  const isXlsx = buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && buffer[2] === 0x03
    && buffer[3] === 0x04
  const xlsSignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
  const isXls = buffer.length >= xlsSignature.length
    && xlsSignature.every((value, index) => buffer[index] === value)

  if ((fileType === 'xlsx' && !isXlsx) || (fileType === 'xls' && !isXls)) {
    throw new ExcelUnsupportedError(`File contents are not a valid ${fileType.toUpperCase()} workbook.`)
  }
}

const readWorkbookSafely = ({ buffer } = {}) =>
  XLSX.read(buffer, {
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellText: true,
    dense: false,
    type: 'buffer',
    WTF: false,
  })

const getCellDisplayValue = (worksheet, rowIndex, columnIndex) => {
  const address = XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex })
  const cell = worksheet[address]

  if (!cell) {
    return ''
  }

  return cell.w ?? cell.v ?? ''
}

const getSheetBounds = (worksheet) => {
  if (!worksheet?.['!ref']) {
    return null
  }

  const range = XLSX.utils.decode_range(worksheet['!ref'])

  return {
    columnCount: range.e.c + 1,
    endColumn: range.e.c,
    endRow: range.e.r,
    rowCount: range.e.r + 1,
  }
}

const detectHeaderColumns = (worksheet, rowIndex, endColumn) => {
  const columns = {}

  for (let columnIndex = 0; columnIndex <= endColumn; columnIndex += 1) {
    const header = normalizeHeader(getCellDisplayValue(worksheet, rowIndex, columnIndex))

    if (!header) {
      continue
    }

    if (columns.description === undefined && DESCRIPTION_HEADERS.has(header)) {
      columns.description = columnIndex
    } else if (columns.quantity === undefined && QUANTITY_HEADERS.has(header)) {
      columns.quantity = columnIndex
    } else if (columns.unit === undefined && UNIT_HEADERS.has(header)) {
      columns.unit = columnIndex
    } else if (columns.productCode === undefined && PRODUCT_CODE_HEADERS.has(header)) {
      columns.productCode = columnIndex
    }
  }

  return columns.description !== undefined && columns.quantity !== undefined ? columns : null
}

const isFooterDescription = (value) => {
  const description = compactSpaces(value)

  return FOOTER_PATTERNS.some((pattern) => pattern.test(description))
}

const columnLetter = (columnIndex) => XLSX.utils.encode_col(columnIndex)

const buildSheetLines = ({
  candidateBudget,
  columns,
  endRow,
  headerRowIndex,
  sheetName,
  worksheet,
}) => {
  const lines = []
  const warnings = []
  let validQuantityCount = 0

  for (let rowIndex = headerRowIndex + 1; rowIndex <= endRow; rowIndex += 1) {
    const description = compactSpaces(getCellDisplayValue(worksheet, rowIndex, columns.description))

    if (!description || isFooterDescription(description)) {
      continue
    }

    if (candidateBudget.remaining <= 0) {
      throw new ExcelLimitError(
        `Excel total candidate row limit of ${EXCEL_PROCESSING_LIMITS.MAX_CANDIDATE_ROWS} was exceeded.`,
      )
    }

    candidateBudget.remaining -= 1

    const rawQuantityValue = getCellDisplayValue(worksheet, rowIndex, columns.quantity)
    const parsedQuantity = parseExcelQuantity(rawQuantityValue)
    const rawUnit = columns.unit === undefined
      ? parsedQuantity.embeddedUnit
      : getCellDisplayValue(worksheet, rowIndex, columns.unit)
    const lineWarnings = []

    if (parsedQuantity.quantity === null) {
      lineWarnings.push(`Row ${rowIndex + 1}: quantity is missing or invalid and was not inferred.`)
      warnings.push(lineWarnings[0])
    } else {
      validQuantityCount += 1
    }

    const sourceCells = {
      description: `${columnLetter(columns.description)}${rowIndex + 1}`,
      quantity: `${columnLetter(columns.quantity)}${rowIndex + 1}`,
    }

    if (columns.unit !== undefined) {
      sourceCells.unit = `${columnLetter(columns.unit)}${rowIndex + 1}`
    }

    if (columns.productCode !== undefined) {
      sourceCells.product_code = `${columnLetter(columns.productCode)}${rowIndex + 1}`
    }

    const line = {
      sequence: lines.length + 1,
      raw_description: description,
      quantity: parsedQuantity.quantity,
      raw_quantity: parsedQuantity.rawQuantity,
      unit: normalizeExcelUnit(rawUnit),
      sheet_name: sheetName,
      source_row: rowIndex + 1,
      source_cells: sourceCells,
      warnings: lineWarnings,
    }

    if (columns.productCode !== undefined) {
      const rawProductCode = compactSpaces(getCellDisplayValue(worksheet, rowIndex, columns.productCode))

      if (rawProductCode) {
        line.raw_product_code = rawProductCode
      }
    }

    lines.push(line)
  }

  return { lines, validQuantityCount, warnings }
}

const getSheetNameSignal = (sheetName) =>
  /\b(?:order|purchase order|po)\b/i.test(compactSpaces(sheetName)) ? 2 : 0

const inspectWorksheet = ({ candidateBudget, sheetName, worksheet }) => {
  const bounds = getSheetBounds(worksheet)

  if (!bounds) {
    return { candidates: [], sheetName }
  }

  if (bounds.rowCount > EXCEL_PROCESSING_LIMITS.MAX_ROWS_PER_SHEET) {
    throw new ExcelLimitError(
      `Worksheet ${sheetName} exceeds the ${EXCEL_PROCESSING_LIMITS.MAX_ROWS_PER_SHEET}-row inspection limit.`,
    )
  }

  if (bounds.columnCount > EXCEL_PROCESSING_LIMITS.MAX_COLUMNS_PER_SHEET) {
    throw new ExcelLimitError(
      `Worksheet ${sheetName} exceeds the ${EXCEL_PROCESSING_LIMITS.MAX_COLUMNS_PER_SHEET}-column inspection limit.`,
    )
  }

  const candidates = []
  const lastHeaderRow = Math.min(
    bounds.endRow,
    EXCEL_PROCESSING_LIMITS.MAX_HEADER_SCAN_ROWS - 1,
  )

  for (let rowIndex = 0; rowIndex <= lastHeaderRow; rowIndex += 1) {
    const columns = detectHeaderColumns(worksheet, rowIndex, bounds.endColumn)

    if (!columns) {
      continue
    }

      const parsedRows = buildSheetLines({
        candidateBudget,
        columns,
      endRow: bounds.endRow,
      headerRowIndex: rowIndex,
      sheetName,
      worksheet,
    })

    if (parsedRows.validQuantityCount === 0) {
      continue
    }

    candidates.push({
      columns,
      headerRow: rowIndex + 1,
      lines: parsedRows.lines,
      score:
        100
        + Math.min(parsedRows.validQuantityCount, 25)
        + (columns.unit === undefined ? 0 : 5)
        + (columns.productCode === undefined ? 0 : 2)
        + getSheetNameSignal(sheetName),
      sheetName,
      validQuantityCount: parsedRows.validQuantityCount,
      warnings: parsedRows.warnings,
    })
  }

  return { candidates, sheetName }
}

const buildColumnMap = (columns) => {
  const result = {
    description: columnLetter(columns.description),
    quantity: columnLetter(columns.quantity),
  }

  if (columns.unit !== undefined) {
    result.unit = columnLetter(columns.unit)
  }

  if (columns.productCode !== undefined) {
    result.product_code = columnLetter(columns.productCode)
  }

  return result
}

const analyzeExcelWorkbook = ({ fileType, workbook } = {}) => {
  const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : []

  if (sheetNames.length > EXCEL_PROCESSING_LIMITS.MAX_SHEETS) {
    throw new ExcelLimitError(
      `Workbook exceeds the ${EXCEL_PROCESSING_LIMITS.MAX_SHEETS}-sheet inspection limit.`,
    )
  }

  const candidateBudget = { remaining: EXCEL_PROCESSING_LIMITS.MAX_CANDIDATE_ROWS }
  const candidates = sheetNames.flatMap((sheetName) =>
    inspectWorksheet({
      candidateBudget,
      sheetName,
      worksheet: workbook.Sheets?.[sheetName],
    }).candidates)

  if (candidates.length === 0) {
    return {
      candidate: {
        version: 1,
        file_type: fileType,
        selected_sheet: null,
        sheet_count: sheetNames.length,
        header_row: null,
        columns: {},
        lines: [],
        warnings: ['No credible Excel order sheet with description and quantity columns was found.'],
      },
      status: MEDIA_EXCEL_STATUSES.EXCEL_NO_ORDER_LINES,
    }
  }

  candidates.sort((left, right) => right.score - left.score)
  const selected = candidates[0]
  const equallyPlausible = candidates.filter((candidate) => candidate.score === selected.score)

  if (equallyPlausible.length > 1) {
    const sheetList = equallyPlausible.map((candidate) => candidate.sheetName).join(', ')

    return {
      candidate: {
        version: 1,
        file_type: fileType,
        selected_sheet: null,
        sheet_count: sheetNames.length,
        header_row: null,
        columns: {},
        lines: [],
        warnings: [`Multiple equally plausible Excel order structures were found: ${sheetList}.`],
      },
      status: MEDIA_EXCEL_STATUSES.EXCEL_AMBIGUOUS,
    }
  }

  return {
    candidate: {
      version: 1,
      file_type: fileType,
      selected_sheet: selected.sheetName,
      sheet_count: sheetNames.length,
      header_row: selected.headerRow,
      columns: buildColumnMap(selected.columns),
      lines: selected.lines,
      warnings: selected.warnings,
    },
    status: selected.warnings.length > 0
      ? MEDIA_EXCEL_STATUSES.EXCEL_PARTIAL
      : MEDIA_EXCEL_STATUSES.EXCEL_PARSED,
  }
}

const ensureWhatsAppExcelProcessingSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_excel_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_excel_candidate jsonb,
      ADD COLUMN IF NOT EXISTS media_excel_processed_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_excel_error text
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_excel_status
    ON ${tableName} (media_excel_status)
  `)
}

const getDownloadedExcelRow = async (pool, { messageId, tableName }) => {
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
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        pi_created
      FROM ${tableName}
      WHERE message_id = $1
      LIMIT 1
    `,
    [messageId],
  )

  return result.rows[0] ?? null
}

const updateExcelStatus = async (
  pool,
  { candidate = null, error = null, messageId, status, tableName },
) => {
  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_excel_status = $2::varchar,
        media_excel_candidate = CASE
          WHEN $3::jsonb IS NULL THEN media_excel_candidate
          ELSE $3::jsonb
        END,
        media_excel_processed_at = CASE
          WHEN $2::varchar IN (
            'EXCEL_PARSED',
            'EXCEL_PARTIAL',
            'EXCEL_NO_ORDER_LINES',
            'EXCEL_AMBIGUOUS',
            'EXCEL_UNSUPPORTED'
          ) THEN CURRENT_TIMESTAMP
          ELSE media_excel_processed_at
        END,
        media_excel_error = $4::text,
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
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        pi_created
    `,
    [messageId, status, candidate ? JSON.stringify(candidate) : null, error],
  )

  return result.rows[0] ?? null
}

const buildExcelProcessingResult = ({
  candidate = null,
  durationMs = 0,
  error = '',
  fileType = '',
  mediaId = '',
  messageId = '',
  mimeType = '',
  skipped = false,
  status = MEDIA_EXCEL_STATUSES.PENDING,
} = {}) => ({
  candidate,
  durationMs,
  error,
  fileType,
  lineCount: candidate?.lines?.length ?? 0,
  mediaId,
  messageId,
  mimeType,
  selectedSheet: candidate?.selected_sheet ?? null,
  sheetCount: candidate?.sheet_count ?? 0,
  skipped,
  status,
  warningCount: candidate?.warnings?.length ?? 0,
})

const isEncryptedWorkbookError = (error) =>
  /password|encrypted|encryption|protected workbook/i.test(safeErrorMessage(error))

const processDownloadedWhatsAppExcel = async ({
  env = process.env,
  messageId,
  pool,
  projectRoot = process.cwd(),
  storageRoot = '',
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
  workbookReader = readWorkbookSafely,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp Excel processing.')
  }

  const startedAt = Date.now()
  await ensureWhatsAppExcelProcessingSchema(pool, { tableName })
  const row = await getDownloadedExcelRow(pool, { messageId, tableName })

  if (!row) {
    throw new Error(`Downloaded WhatsApp Excel row was not found for ${messageId}.`)
  }

  const fileType = getWorkbookType({
    mediaPath: row.media_path,
    mimeType: row.media_mime_type,
  })

  if (row.media_excel_status === MEDIA_EXCEL_STATUSES.EXCEL_PARSED && row.media_excel_candidate) {
    return buildExcelProcessingResult({
      candidate: row.media_excel_candidate,
      durationMs: Date.now() - startedAt,
      fileType,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      skipped: true,
      status: MEDIA_EXCEL_STATUSES.EXCEL_PARSED,
    })
  }

  if (row.media_download_status !== 'DOWNLOADED') {
    return buildExcelProcessingResult({
      durationMs: Date.now() - startedAt,
      error: 'Media download is not complete, so Excel processing was not started.',
      fileType,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      skipped: true,
      status: row.media_excel_status || MEDIA_EXCEL_STATUSES.PENDING,
    })
  }

  if (!fileType) {
    const error = 'Media is not a supported XLSX or XLS workbook.'
    const updatedRow = await updateExcelStatus(pool, {
      error,
      messageId,
      status: MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED,
      tableName,
    })

    return buildExcelProcessingResult({
      durationMs: Date.now() - startedAt,
      error,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_excel_status || MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED,
    })
  }

  try {
    await updateExcelStatus(pool, {
      messageId,
      status: MEDIA_EXCEL_STATUSES.EXCEL_PROCESSING,
      tableName,
    })
    const resolvedPath = resolveStoredExcelPath({
      env,
      mediaPath: row.media_path,
      projectRoot,
      storageRoot,
    })
    const originalBuffer = await fs.readFile(resolvedPath.absolutePath)

    assertWorkbookSignature(originalBuffer, fileType)
    const workbook = await workbookReader({
      buffer: originalBuffer,
      fileType,
    })
    const analyzed = analyzeExcelWorkbook({ fileType, workbook })
    const updatedRow = await updateExcelStatus(pool, {
      candidate: analyzed.candidate,
      error: null,
      messageId,
      status: analyzed.status,
      tableName,
    })

    return buildExcelProcessingResult({
      candidate: updatedRow?.media_excel_candidate ?? analyzed.candidate,
      durationMs: Date.now() - startedAt,
      fileType,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_excel_status ?? analyzed.status,
    })
  } catch (error) {
    const unsupported = error instanceof ExcelUnsupportedError || isEncryptedWorkbookError(error)
    const errorMessage = isEncryptedWorkbookError(error)
      ? 'Password-protected Excel workbook is not supported.'
      : safeErrorMessage(error)
    const status = unsupported
      ? MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED
      : MEDIA_EXCEL_STATUSES.EXCEL_FAILED
    const updatedRow = await updateExcelStatus(pool, {
      error: errorMessage,
      messageId,
      status,
      tableName,
    }).catch(() => null)

    return buildExcelProcessingResult({
      durationMs: Date.now() - startedAt,
      error: errorMessage,
      fileType,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: updatedRow?.media_excel_status || status,
    })
  }
}

const getSafeExcelProcessingLogDetails = (result = {}) => ({
  durationMs: Number(result.durationMs ?? 0),
  error: result.error || '',
  fileType: result.fileType || '',
  lineCount: Number(result.lineCount ?? 0),
  mediaId: result.mediaId || '',
  messageId: result.messageId || '',
  mimeType: result.mimeType || '',
  selectedSheet: result.selectedSheet || '',
  sheetCount: Number(result.sheetCount ?? 0),
  skipped: Boolean(result.skipped),
  status: result.status || '',
  warningCount: Number(result.warningCount ?? 0),
})

export {
  analyzeExcelWorkbook,
  ensureWhatsAppExcelProcessingSchema,
  EXCEL_PROCESSING_LIMITS,
  getSafeExcelProcessingLogDetails,
  getWorkbookType,
  isSupportedExcelMedia,
  MEDIA_EXCEL_STATUSES,
  normalizeExcelUnit,
  parseExcelQuantity,
  processDownloadedWhatsAppExcel,
  readWorkbookSafely,
  resolveStoredExcelPath,
}

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as XLSX from 'xlsx'
import {
  analyzeExcelWorkbook,
  EXCEL_PROCESSING_LIMITS,
  isSupportedExcelMedia,
  MEDIA_EXCEL_STATUSES,
  processDownloadedWhatsAppExcel,
  resolveStoredExcelPath,
} from './whatsappExcelProcessingService.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const XLS_MIME = 'application/vnd.ms-excel'

test('Excel MIME gate accepts only XLSX and XLS documents', () => {
  assert.equal(isSupportedExcelMedia({ mediaPath: 'order.xlsx', mimeType: XLSX_MIME }), true)
  assert.equal(isSupportedExcelMedia({ mediaPath: 'order.xls', mimeType: XLS_MIME }), true)
  assert.equal(isSupportedExcelMedia({ mediaPath: 'order.csv', mimeType: 'text/csv' }), false)
  assert.equal(isSupportedExcelMedia({ mediaPath: 'order.xlsx', mimeType: 'text/csv' }), false)
  assert.equal(isSupportedExcelMedia({ mediaPath: 'order.pdf', mimeType: 'application/pdf' }), false)
})

const createTempProject = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), 'autopal-excel-processing-'))

const createWorkbookBuffer = ({ bookType = 'xlsx', sheets = {} } = {}) => {
  const workbook = XLSX.utils.book_new()

  for (const [sheetName, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName)
  }

  if (workbook.SheetNames.length === 0) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), 'Sheet1')
  }

  return XLSX.write(workbook, {
    bookType,
    type: 'buffer',
  })
}

const writeWorkbook = async ({
  bookType = 'xlsx',
  projectRoot,
  relativePath,
  sheets,
} = {}) => {
  const absolutePath = path.join(projectRoot, relativePath)
  const buffer = createWorkbookBuffer({ bookType, sheets })

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, buffer)

  return { absolutePath, buffer }
}

const createPool = (initialRow = {}) => {
  const state = {
    businessLookupAttempts: 0,
    row: {
      id: 1,
      message_id: 'wamid.excel-test',
      media_id: 'meta-excel-1',
      media_mime_type: XLSX_MIME,
      media_path: 'storage/whatsapp-media/2026/08/14/order.xlsx',
      media_capture_status: 'CAPTURED',
      media_download_status: 'DOWNLOADED',
      media_excel_status: 'PENDING',
      media_excel_candidate: null,
      media_excel_processed_at: null,
      media_excel_error: null,
      pi_created: false,
      ...initialRow,
    },
    updates: [],
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/SELECT[\s\S]+FROM\s+tran_whatsapp_pi_messages/i.test(sql)) {
        return state.row ? { rowCount: 1, rows: [state.row] } : { rowCount: 0, rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /media_excel_status/i.test(sql)) {
        const candidate = params[2] ? JSON.parse(params[2]) : null
        state.updates.push({
          candidate,
          error: params[3],
          status: params[1],
        })
        state.row = {
          ...state.row,
          media_excel_candidate: candidate ?? state.row.media_excel_candidate,
          media_excel_error: params[3],
          media_excel_processed_at: params[1] === 'EXCEL_PROCESSING'
            ? state.row.media_excel_processed_at
            : '2026-08-14T10:00:00.000Z',
          media_excel_status: params[1],
        }

        return { rowCount: 1, rows: [state.row] }
      }

      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessLookupAttempts += 1
        throw new Error('Excel processing must not perform ERP lookups, PI creation, or sends.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

const cleanRows = [
  ['Description', 'Quantity', 'Unit'],
  ['HEAD LIGHT ASSY ACE MEGA', 12, 'Nos'],
  ['HL-228 S - H3 FOG LAMP SMALL', 54, 'Nos'],
  ['HL230S 100MM FOG LAMP', 36, 'Nos'],
  ['TT TAIL LAMP ASSY', 32, 'Nos'],
]

const processFixture = async ({
  bookType = 'xlsx',
  initialRow = {},
  sheets = { Order: cleanRows },
  workbookReader,
} = {}) => {
  const projectRoot = await createTempProject()
  const extension = bookType === 'biff8' ? 'xls' : 'xlsx'
  const mimeType = extension === 'xls' ? XLS_MIME : XLSX_MIME
  const relativePath = `storage/whatsapp-media/2026/08/14/order.${extension}`
  const pool = createPool({
    media_mime_type: mimeType,
    media_path: relativePath,
    ...initialRow,
  })
  const written = await writeWorkbook({
    bookType,
    projectRoot,
    relativePath,
    sheets,
  })
  const result = await processDownloadedWhatsAppExcel({
    messageId: pool.state.row.message_id,
    pool,
    projectRoot,
    ...(workbookReader ? { workbookReader } : {}),
  })

  return { pool, projectRoot, result, written }
}

test('clean XLSX produces four traced Excel candidate lines', async () => {
  const { pool, result } = await processFixture()

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.candidate.file_type, 'xlsx')
  assert.equal(result.candidate.selected_sheet, 'Order')
  assert.equal(result.candidate.header_row, 1)
  assert.deepEqual(result.candidate.columns, {
    description: 'A',
    quantity: 'B',
    unit: 'C',
  })
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
  assert.deepEqual(result.candidate.lines.map((line) => line.unit), ['NOS', 'NOS', 'NOS', 'NOS'])
  assert.deepEqual(result.candidate.lines[0].source_cells, {
    description: 'A2',
    quantity: 'B2',
    unit: 'C2',
  })
  assert.equal(pool.state.row.pi_created, false)
})

test('legacy XLS produces the same candidate without Excel automation', async () => {
  const { result } = await processFixture({ bookType: 'biff8' })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.candidate.file_type, 'xls')
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
})

test('header detection finds a description and quantity header on row 4', async () => {
  const { result } = await processFixture({
    sheets: {
      Sheet1: [
        ['ABC Distributor'],
        ['Purchase Order'],
        [],
        ['S.No', 'Description', 'Quantity', 'Unit'],
        [1, 'HEAD LAMP', 12, 'Nos'],
      ],
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.candidate.header_row, 4)
  assert.equal(result.candidate.lines[0].source_row, 5)
})

test('description and quantity columns work without inventing a unit', async () => {
  const { result } = await processFixture({
    sheets: {
      Order: [
        ['Item Description', 'Qty'],
        ['HEAD LAMP', '12'],
      ],
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.candidate.lines[0].quantity, 12)
  assert.equal(result.candidate.lines[0].unit, '')
  assert.equal('unit' in result.candidate.columns, false)
})

test('quantity cells accept numeric text, embedded units, and Qty labels', async () => {
  const { result } = await processFixture({
    sheets: {
      Order: [
        ['Description', 'Quantity'],
        ['HEAD LAMP', '12.00'],
        ['TAIL LAMP', '20 PCS'],
        ['FOG LAMP', 'Qty 5'],
      ],
    },
  })

  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 20, 5])
  assert.deepEqual(result.candidate.lines.map((line) => line.unit), ['', 'PCS', ''])
  assert.deepEqual(result.candidate.lines.map((line) => line.raw_quantity), ['12.00', '20 PCS', 'Qty 5'])
})

test('rate and amount columns are ignored and never become pricing fields', async () => {
  const { pool, result } = await processFixture({
    sheets: {
      Order: [
        ['Description', 'Qty', 'UOM', 'Rate', 'Amount'],
        ['HEAD LAMP', 12, 'PCS', 707, 8484],
      ],
    },
  })
  const line = result.candidate.lines[0]

  assert.equal(line.quantity, 12)
  assert.equal(line.unit, 'PCS')
  assert.equal('price' in line, false)
  assert.equal('rate' in line, false)
  assert.equal('amount' in line, false)
  assert.equal(pool.state.businessLookupAttempts, 0)
})

test('blank and footer rows are not emitted as Excel order lines', async () => {
  const { result } = await processFixture({
    sheets: {
      Order: [
        ['Description', 'Quantity', 'Unit'],
        ['', '', ''],
        ['HEAD LAMP', 12, 'Nos'],
        ['TOTAL', 12, 'Nos'],
        ['IGST', 18, '%'],
        ['ROUND OFF', 1, ''],
        ['AUTHORIZED SIGNATORY', '', ''],
      ],
    },
  })

  assert.deepEqual(result.candidate.lines.map((line) => line.raw_description), ['HEAD LAMP'])
})

test('missing quantity produces EXCEL_PARTIAL without inventing quantity one', async () => {
  const { result } = await processFixture({
    sheets: {
      Order: [
        ['Description', 'Quantity'],
        ['HEAD LAMP', 12],
        ['TAIL LAMP', 'unclear'],
      ],
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARTIAL)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, null])
  assert.ok(result.candidate.lines[1].warnings.length > 0)
})

test('one credible order sheet is selected over an irrelevant summary sheet', async () => {
  const { result } = await processFixture({
    sheets: {
      Summary: [['Metric', 'Value'], ['Total', 4]],
      Order: cleanRows,
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.candidate.selected_sheet, 'Order')
  assert.equal(result.candidate.sheet_count, 2)
})

test('equally plausible independent order sheets return EXCEL_AMBIGUOUS', async () => {
  const { result } = await processFixture({
    sheets: {
      Order1: cleanRows,
      Order2: cleanRows,
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_AMBIGUOUS)
  assert.equal(result.candidate.selected_sheet, null)
  assert.deepEqual(result.candidate.lines, [])
})

test('empty workbook returns EXCEL_NO_ORDER_LINES without crashing', async () => {
  const { result } = await processFixture({ sheets: {} })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_NO_ORDER_LINES)
  assert.deepEqual(result.candidate.lines, [])
})

test('corrupt workbook becomes EXCEL_FAILED and original file remains unchanged', async () => {
  const projectRoot = await createTempProject()
  const relativePath = 'storage/whatsapp-media/2026/08/14/corrupt.xlsx'
  const absolutePath = path.join(projectRoot, relativePath)
  const corrupt = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03])
  const pool = createPool({ media_path: relativePath })

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, corrupt)
  const result = await processDownloadedWhatsAppExcel({
    messageId: pool.state.row.message_id,
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_FAILED)
  assert.deepEqual(await fs.readFile(absolutePath), corrupt)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
})

test('password-protected workbook errors are classified safely as unsupported', async () => {
  const { result } = await processFixture({
    workbookReader: async () => {
      throw new Error('Encrypted workbook requires password secret-internal-detail')
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED)
  assert.equal(result.error, 'Password-protected Excel workbook is not supported.')
  assert.doesNotMatch(result.error, /secret-internal-detail/)
})

test('fake Excel MIME with invalid contents is safely unsupported', async () => {
  const projectRoot = await createTempProject()
  const relativePath = 'storage/whatsapp-media/2026/08/14/fake.xlsx'
  const absolutePath = path.join(projectRoot, relativePath)
  const pool = createPool({ media_path: relativePath })

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, 'not an excel workbook')
  const result = await processDownloadedWhatsAppExcel({
    messageId: pool.state.row.message_id,
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED)
  assert.match(result.error, /not a valid XLSX workbook/)
})

test('path traversal and Windows-style traversal are refused before workbook reading', async () => {
  for (const mediaPath of ['../../outside.xlsx', '..\\..\\outside.xlsx']) {
    const projectRoot = await createTempProject()
    const pool = createPool({ media_path: mediaPath })
    let readerCalls = 0
    const result = await processDownloadedWhatsAppExcel({
      messageId: pool.state.row.message_id,
      pool,
      projectRoot,
      workbookReader: async () => {
        readerCalls += 1
        return null
      },
    })

    assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_FAILED, mediaPath)
    assert.match(result.error, /outside the configured media storage directory/, mediaPath)
    assert.equal(readerCalls, 0, mediaPath)
  }
})

test('already parsed workbook is idempotent and preserves the existing candidate', async () => {
  const existingCandidate = {
    version: 1,
    file_type: 'xlsx',
    lines: [{ quantity: 12 }],
    warnings: [],
  }
  const pool = createPool({
    media_excel_candidate: existingCandidate,
    media_excel_status: 'EXCEL_PARSED',
  })
  let readerCalls = 0
  const result = await processDownloadedWhatsAppExcel({
    messageId: pool.state.row.message_id,
    pool,
    workbookReader: async () => {
      readerCalls += 1
      return null
    },
  })

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(result.skipped, true)
  assert.deepEqual(result.candidate, existingCandidate)
  assert.equal(readerCalls, 0)
  assert.equal(pool.state.updates.length, 0)
  assert.equal(pool.state.row.id, 1)
})

test('large workbook sheet, row, column, and candidate limits are enforced', async () => {
  const workbook = XLSX.utils.book_new()
  const oversizedRows = XLSX.utils.aoa_to_sheet([['Description', 'Quantity']])
  oversizedRows['!ref'] = `A1:A${EXCEL_PROCESSING_LIMITS.MAX_ROWS_PER_SHEET + 1}`
  XLSX.utils.book_append_sheet(workbook, oversizedRows, 'TooManyRows')

  assert.throws(
    () => analyzeExcelWorkbook({ fileType: 'xlsx', workbook }),
    /row inspection limit/,
  )

  const tooManySheets = { SheetNames: [], Sheets: {} }
  for (let index = 0; index <= EXCEL_PROCESSING_LIMITS.MAX_SHEETS; index += 1) {
    const name = `Sheet${index + 1}`
    tooManySheets.SheetNames.push(name)
    tooManySheets.Sheets[name] = XLSX.utils.aoa_to_sheet([])
  }
  assert.throws(
    () => analyzeExcelWorkbook({ fileType: 'xlsx', workbook: tooManySheets }),
    /sheet inspection limit/,
  )

  const tooManyColumns = XLSX.utils.book_new()
  const wideSheet = XLSX.utils.aoa_to_sheet([['Description', 'Quantity']])
  wideSheet['!ref'] = `A1:${XLSX.utils.encode_col(EXCEL_PROCESSING_LIMITS.MAX_COLUMNS_PER_SHEET)}1`
  XLSX.utils.book_append_sheet(tooManyColumns, wideSheet, 'Wide')
  assert.throws(
    () => analyzeExcelWorkbook({ fileType: 'xlsx', workbook: tooManyColumns }),
    /column inspection limit/,
  )

  const tooManyCandidates = XLSX.utils.book_new()
  const candidateRows = [['Description', 'Quantity']]
  for (let index = 0; index <= EXCEL_PROCESSING_LIMITS.MAX_CANDIDATE_ROWS; index += 1) {
    candidateRows.push([`ITEM ${index + 1}`, index + 1])
  }
  XLSX.utils.book_append_sheet(
    tooManyCandidates,
    XLSX.utils.aoa_to_sheet(candidateRows),
    'Candidates',
  )
  assert.throws(
    () => analyzeExcelWorkbook({ fileType: 'xlsx', workbook: tooManyCandidates }),
    /candidate row limit/,
  )
})

test('Excel processing performs no business lookups, PI creation, or outgoing sends', async () => {
  const { pool, result } = await processFixture()

  assert.equal(result.status, MEDIA_EXCEL_STATUSES.EXCEL_PARSED)
  assert.equal(pool.state.businessLookupAttempts, 0)
  assert.equal(pool.state.row.pi_created, false)
})

test('download must be complete before Excel processing starts', async () => {
  const pool = createPool({ media_download_status: 'DOWNLOADING' })
  const result = await processDownloadedWhatsAppExcel({
    messageId: pool.state.row.message_id,
    pool,
  })

  assert.equal(result.skipped, true)
  assert.equal(result.status, MEDIA_EXCEL_STATUSES.PENDING)
  assert.equal(pool.state.updates.length, 0)
})

test('path resolver accepts only files beneath configured media storage', () => {
  const projectRoot = path.resolve('C:/safe-project')
  const resolved = resolveStoredExcelPath({
    mediaPath: 'storage/whatsapp-media/order.xlsx',
    projectRoot,
  })

  assert.equal(resolved.absolutePath, path.resolve(projectRoot, 'storage/whatsapp-media/order.xlsx'))
  assert.throws(
    () => resolveStoredExcelPath({ mediaPath: '../../outside.xlsx', projectRoot }),
    /outside the configured media storage directory/,
  )
})

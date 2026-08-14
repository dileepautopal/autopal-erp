import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import {
  analyzeWordDocument,
  getWordDocumentType,
  isSupportedWordMedia,
  MEDIA_WORD_STATUSES,
  parseWordQuantity,
  processDownloadedWhatsAppWord,
  resolveStoredWordPath,
  WORD_PROCESSING_LIMITS,
} from './whatsappWordProcessingService.js'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const DOC_MIME = 'application/msword'

const xmlEscape = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const wordParagraphXml = (value) =>
  `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(value)}</w:t></w:r></w:p>`

const wordTableXml = (rows) =>
  `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${wordParagraphXml(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`

const createDocxBuffer = async ({ paragraphs = [], tables = [] } = {}) => {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.folder('_rels').file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  const body = [
    ...paragraphs.map(wordParagraphXml),
    ...tables.map(wordTableXml),
  ].join('')
  zip.folder('word').file(
    'document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ compression: 'DEFLATE', type: 'nodebuffer' })
}

const createTempProject = () => fs.mkdtemp(path.join(os.tmpdir(), 'autopal-word-processing-'))

const writeDocx = async ({ projectRoot, relativePath, ...document }) => {
  const absolutePath = path.join(projectRoot, relativePath)
  const buffer = await createDocxBuffer(document)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, buffer)
  return { absolutePath, buffer }
}

const createPool = (initialRow = {}) => {
  const state = {
    businessLookupAttempts: 0,
    row: {
      id: 1,
      media_capture_status: 'CAPTURED',
      media_download_status: 'DOWNLOADED',
      media_id: 'meta-word-1',
      media_mime_type: DOCX_MIME,
      media_path: 'storage/whatsapp-media/2026/08/14/order.docx',
      media_word_candidate: null,
      media_word_error: null,
      media_word_processed_at: null,
      media_word_status: 'PENDING',
      message_id: 'wamid.word-test',
      pi_created: false,
      ...initialRow,
    },
    updates: 0,
  }

  return {
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
        return { rows: [] }
      }
      if (/SELECT[\s\S]+FROM\s+tran_whatsapp_pi_messages/i.test(sql)) {
        return { rows: [{ ...state.row }] }
      }
      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /media_word_status/i.test(sql)) {
        state.updates += 1
        state.row = {
          ...state.row,
          media_word_status: params[1],
          media_word_candidate: params[2]
            ? JSON.parse(params[2])
            : state.row.media_word_candidate,
          media_word_error: params[3],
          media_word_processed_at: params[1] === 'WORD_PROCESSING'
            ? state.row.media_word_processed_at
            : new Date().toISOString(),
        }
        return { rows: [{ ...state.row }] }
      }
      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessLookupAttempts += 1
      }
      throw new Error(`Unexpected test query: ${sql}`)
    },
    state,
  }
}

const orderRows = [
  ['PRODUCT NAME', 'QTY', 'UNIT'],
  ['HEAD LIGHT ASSY ACE MEGA', '12', 'Nos'],
  ['HL-228 S - H3 FOG LAMP SMALL', '54', 'Nos'],
  ['HL230S 100MM FOG LAMP', '36', 'Nos'],
  ['TT TAIL LAMP ASSY', '32', 'Nos'],
]

const processFixture = async ({ initialRow = {}, paragraphs = [], tables = [] } = {}) => {
  const projectRoot = await createTempProject()
  const relativePath = initialRow.media_path ?? 'storage/whatsapp-media/2026/08/14/order.docx'
  const written = await writeDocx({ paragraphs, projectRoot, relativePath, tables })
  const pool = createPool({ media_path: relativePath, ...initialRow })
  const result = await processDownloadedWhatsAppWord({
    messageId: pool.state.row.message_id,
    pool,
    projectRoot,
  })
  return { ...written, pool, projectRoot, result }
}

test('Word MIME gate accepts DOCX and legacy DOC but rejects unrelated media', () => {
  assert.equal(isSupportedWordMedia({ mediaPath: 'order.docx', mimeType: DOCX_MIME }), true)
  assert.equal(isSupportedWordMedia({ mediaPath: 'order.doc', mimeType: DOC_MIME }), true)
  assert.equal(isSupportedWordMedia({ mediaPath: 'order.docx', mimeType: 'application/pdf' }), false)
  assert.equal(getWordDocumentType({ mediaPath: 'order.docx', mimeType: DOCX_MIME }), 'docx')
})

test('clean DOCX table produces four traced Word candidate lines', async () => {
  const { pool, result } = await processFixture({ tables: [orderRows] })
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_PARSED)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
  assert.deepEqual(result.candidate.lines.map((line) => line.unit), ['NOS', 'NOS', 'NOS', 'NOS'])
  assert.equal(result.candidate.lines[0].source_cells.description, 'table1:r2:c1')
  assert.equal(result.candidate.extraction_method, 'WORD_TABLE')
  assert.equal(pool.state.row.pi_created, false)
})

test('PRODUCT NAME is recognized as a generic description header', () => {
  const analyzed = analyzeWordDocument({ document: { paragraphs: [], tables: [{ rows: orderRows.slice(0, 2) }] } })
  assert.equal(analyzed.status, MEDIA_WORD_STATUSES.WORD_PARSED)
  assert.equal(analyzed.candidate.lines[0].raw_description, 'HEAD LIGHT ASSY ACE MEGA')
})

test('table header may occur after title and blank rows', () => {
  const rows = [['Purchase Order'], [''], ['S.No', 'PRODUCT NAME', 'QTY', 'UNIT'], ['1', 'HEAD LAMP', '12', 'NOS']]
  const analyzed = analyzeWordDocument({ document: { paragraphs: [], tables: [{ rows }] } })
  assert.equal(analyzed.candidate.header_row, 3)
  assert.equal(analyzed.candidate.lines[0].source_row, 4)
})

test('order table is selected when it is not the first Word table', () => {
  const analyzed = analyzeWordDocument({
    document: {
      paragraphs: [],
      tables: [{ rows: [['Customer', 'ABC'], ['Address', 'Delhi']] }, { rows: orderRows.slice(0, 2) }],
    },
  })
  assert.equal(analyzed.candidate.selected_table, 2)
})

test('description and quantity table works without inventing a unit', () => {
  const analyzed = analyzeWordDocument({
    document: { paragraphs: [], tables: [{ rows: [['Description', 'Quantity'], ['HEAD LAMP', '12']] }] },
  })
  assert.equal(analyzed.status, MEDIA_WORD_STATUSES.WORD_PARSED)
  assert.equal(analyzed.candidate.lines[0].unit, '')
})

test('quantity forms include decimal text, embedded unit, Qty, and Quantity labels', () => {
  assert.deepEqual(
    ['12.00', '12 Nos', 'Qty 12', 'Quantity: 12'].map((value) => parseWordQuantity(value).quantity),
    [12, 12, 12, 12],
  )
})

test('rate and amount columns are ignored and never become pricing fields', () => {
  const analyzed = analyzeWordDocument({
    document: {
      paragraphs: [],
      tables: [{ rows: [['Description', 'Qty', 'Unit', 'Rate', 'Amount'], ['HEAD LAMP', '12', 'NOS', '999', '11988']] }],
    },
  })
  const line = analyzed.candidate.lines[0]
  assert.equal(line.quantity, 12)
  assert.equal('price' in line, false)
  assert.equal('rate' in line, false)
  assert.equal('amount' in line, false)
})

test('blank and footer rows are not emitted as products', () => {
  const analyzed = analyzeWordDocument({
    document: {
      paragraphs: [],
      tables: [{ rows: [...orderRows.slice(0, 2), ['', '', ''], ['TOTAL', '12', ''], ['IGST', '2', ''], ['ROUND OFF', '1', ''], ['AUTHORIZED SIGNATORY', '1', '']] }],
    },
  })
  assert.deepEqual(analyzed.candidate.lines.map((line) => line.raw_description), ['HEAD LIGHT ASSY ACE MEGA'])
})

test('missing quantity produces WORD_PARTIAL and never defaults to one', () => {
  const analyzed = analyzeWordDocument({
    document: { paragraphs: [], tables: [{ rows: [...orderRows.slice(0, 2), ['FOG LAMP', 'invalid', 'NOS']] }] },
  })
  assert.equal(analyzed.status, MEDIA_WORD_STATUSES.WORD_PARTIAL)
  assert.equal(analyzed.candidate.lines[1].quantity, null)
})

test('clear paragraph order lines are parsed only after no credible table is found', () => {
  const analyzed = analyzeWordDocument({
    document: {
      paragraphs: ['HEAD LIGHT ASSY ACE MEGA - 12 Nos', 'HL230S 100MM FOG LAMP Qty 36 Nos'],
      tables: [{ rows: [['Customer', 'ABC']] }],
    },
  })
  assert.equal(analyzed.candidate.extraction_method, 'WORD_PARAGRAPH')
  assert.deepEqual(analyzed.candidate.lines.map((line) => line.quantity), [12, 36])
  assert.deepEqual(analyzed.candidate.lines.map((line) => line.source_paragraph), [1, 2])
})

test('vague dispatch paragraph is not treated as a product order', () => {
  const analyzed = analyzeWordDocument({
    document: { paragraphs: ['Please dispatch 12 urgently.', 'Order No: 12'], tables: [] },
  })
  assert.equal(analyzed.status, MEDIA_WORD_STATUSES.WORD_NO_ORDER_LINES)
})

test('ordinary Word letter becomes WORD_NO_ORDER_LINES', async () => {
  const { result } = await processFixture({ paragraphs: ['Dear Sir,', 'Please find our correspondence attached.', 'Regards'] })
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_NO_ORDER_LINES)
})

test('one credible order table is selected over customer and summary tables', () => {
  const analyzed = analyzeWordDocument({
    document: {
      paragraphs: [],
      tables: [
        { rows: [['Customer', 'ABC']] },
        { rows: orderRows.slice(0, 2) },
        { rows: [['Tax', 'Amount'], ['IGST', '100']] },
      ],
    },
  })
  assert.equal(analyzed.candidate.selected_table, 2)
})

test('two equally plausible order tables return WORD_AMBIGUOUS without merging', () => {
  const analyzed = analyzeWordDocument({
    document: { paragraphs: [], tables: [{ rows: orderRows.slice(0, 2) }, { rows: orderRows.slice(0, 2) }] },
  })
  assert.equal(analyzed.status, MEDIA_WORD_STATUSES.WORD_AMBIGUOUS)
  assert.deepEqual(analyzed.candidate.lines, [])
})

test('corrupt DOCX becomes WORD_FAILED and preserves the original file', async () => {
  const projectRoot = await createTempProject()
  const relativePath = 'storage/whatsapp-media/2026/08/14/corrupt.docx'
  const absolutePath = path.join(projectRoot, relativePath)
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, buffer)
  const before = crypto.createHash('sha256').update(buffer).digest('hex')
  const pool = createPool({ media_path: relativePath })
  const result = await processDownloadedWhatsAppWord({ messageId: pool.state.row.message_id, pool, projectRoot })
  const after = crypto.createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex')
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_FAILED)
  assert.equal(after, before)
})

test('password-protected parser error is safely classified as unsupported', async () => {
  const projectRoot = await createTempProject()
  const relativePath = 'storage/whatsapp-media/2026/08/14/encrypted.docx'
  await writeDocx({ projectRoot, relativePath, tables: [orderRows] })
  const pool = createPool({ media_path: relativePath })
  const result = await processDownloadedWhatsAppWord({
    documentReader: async () => { throw new Error('Encrypted password internal parser detail') },
    messageId: pool.state.row.message_id,
    pool,
    projectRoot,
  })
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_UNSUPPORTED)
  assert.equal(result.error, 'Password-protected Word documents are not supported.')
})

test('legacy DOC is honestly classified as WORD_UNSUPPORTED without conversion', async () => {
  const pool = createPool({ media_mime_type: DOC_MIME, media_path: 'storage/whatsapp-media/order.doc' })
  const result = await processDownloadedWhatsAppWord({ messageId: pool.state.row.message_id, pool })
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_UNSUPPORTED)
  assert.match(result.error, /Legacy \.doc/)
})

test('fake DOCX MIME with invalid contents is safely unsupported', async () => {
  const projectRoot = await createTempProject()
  const relativePath = 'storage/whatsapp-media/2026/08/14/fake.docx'
  const absolutePath = path.join(projectRoot, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, 'not a word file')
  const pool = createPool({ media_path: relativePath })
  const result = await processDownloadedWhatsAppWord({ messageId: pool.state.row.message_id, pool, projectRoot })
  assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_UNSUPPORTED)
})

test('Unix and Windows path traversal are refused before document reading', async () => {
  for (const mediaPath of ['../../outside.docx', '..\\..\\outside.docx']) {
    const pool = createPool({ media_path: mediaPath })
    let readerCalls = 0
    const result = await processDownloadedWhatsAppWord({
      documentReader: async () => { readerCalls += 1; return { paragraphs: [], tables: [] } },
      messageId: pool.state.row.message_id,
      pool,
      projectRoot: await createTempProject(),
    })
    assert.equal(result.status, MEDIA_WORD_STATUSES.WORD_FAILED)
    assert.equal(readerCalls, 0)
    assert.match(result.error, /outside the configured media storage directory/)
  }
})

test('already parsed Word row is idempotent and preserves its candidate', async () => {
  const existingCandidate = { extraction_method: 'WORD_TABLE', lines: [{ sequence: 1 }], warnings: [] }
  const pool = createPool({ media_word_candidate: existingCandidate, media_word_status: 'WORD_PARSED' })
  let readerCalls = 0
  const result = await processDownloadedWhatsAppWord({
    documentReader: async () => { readerCalls += 1; return { paragraphs: [], tables: [] } },
    messageId: pool.state.row.message_id,
    pool,
  })
  assert.equal(result.skipped, true)
  assert.equal(readerCalls, 0)
  assert.deepEqual(result.candidate, existingCandidate)
  assert.equal(pool.state.updates, 0)
})

test('document table, row, column, paragraph, text, and candidate bounds are enforced', () => {
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: [], tables: Array.from({ length: WORD_PROCESSING_LIMITS.MAX_TABLES + 1 }, () => ({ rows: [] })) } }), /table limit/)
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: [], tables: [{ rows: Array.from({ length: WORD_PROCESSING_LIMITS.MAX_ROWS_PER_TABLE + 1 }, () => []) }] } }), /row limit/)
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: [], tables: [{ rows: [Array(WORD_PROCESSING_LIMITS.MAX_COLUMNS_PER_TABLE + 1).fill('x')] }] } }), /column limit/)
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: Array(WORD_PROCESSING_LIMITS.MAX_PARAGRAPHS + 1).fill('x'), tables: [] } }), /paragraph limit/)
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: ['x'.repeat(WORD_PROCESSING_LIMITS.MAX_TEXT_CHARACTERS + 1)], tables: [] } }), /character inspection limit/)
  const rows = [['Description', 'Qty'], ...Array.from({ length: WORD_PROCESSING_LIMITS.MAX_CANDIDATE_LINES + 1 }, (_, index) => [`Part ${index}`, '1'])]
  assert.throws(() => analyzeWordDocument({ document: { paragraphs: [], tables: [{ rows }] } }), /candidate line limit/)
})

test('Word processing performs no business lookup, PI, acknowledgement, or send operation', async () => {
  const { pool } = await processFixture({ tables: [orderRows.slice(0, 2)] })
  assert.equal(pool.state.businessLookupAttempts, 0)
  assert.equal(pool.state.row.pi_created, false)
})

test('download must complete before Word processing starts', async () => {
  const pool = createPool({ media_download_status: 'PENDING' })
  let readerCalls = 0
  const result = await processDownloadedWhatsAppWord({
    documentReader: async () => { readerCalls += 1; return { paragraphs: [], tables: [] } },
    messageId: pool.state.row.message_id,
    pool,
  })
  assert.equal(result.skipped, true)
  assert.equal(result.status, MEDIA_WORD_STATUSES.PENDING)
  assert.equal(readerCalls, 0)
})

test('path resolver accepts only files beneath configured WhatsApp media storage', () => {
  const projectRoot = path.resolve('F:/autopal/autopal-erp')
  assert.equal(
    resolveStoredWordPath({ mediaPath: 'storage/whatsapp-media/order.docx', projectRoot }).absolutePath,
    path.resolve(projectRoot, 'storage/whatsapp-media/order.docx'),
  )
  assert.throws(
    () => resolveStoredWordPath({ mediaPath: '../outside.docx', projectRoot }),
    /outside the configured media storage directory/,
  )
})

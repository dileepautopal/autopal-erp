import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertExportAccess,
  createCsvReport,
  createPdfReportBuffer,
  createXlsxWorkbookBuffer,
  detectWriteSql,
  enforceExportLimit,
  escapeCsvCell,
  sanitizeReportFilename,
  sanitizeSheetName,
  stripConfidentialFields,
} from './piReportExportService.js'

const sampleSheet = {
  headers: ['Date', 'Customer', 'Total PI Value'],
  name: 'Customer Ranking',
  rows: [
    ['2026-07-29', 'Jalaram Enterprise', 402705],
    ['2026-07-30', 'ABC Traders', 12500],
  ],
  types: ['date', 'text', 'currency'],
  widths: [14, 28, 18],
}

const workbookText = () => createXlsxWorkbookBuffer([sampleSheet]).toString('utf8')

test('Excel workbook creation returns a ZIP package', () => {
  assert.equal(createXlsxWorkbookBuffer([sampleSheet]).subarray(0, 2).toString(), 'PK')
})

test('Excel workbook includes content types', () => {
  assert.match(workbookText(), /\[Content_Types\]\.xml/)
})

test('Excel workbook includes workbook XML', () => {
  assert.match(workbookText(), /xl\/workbook\.xml/)
})

test('Excel workbook includes worksheet XML', () => {
  assert.match(workbookText(), /xl\/worksheets\/sheet1\.xml/)
})

test('Excel workbook includes required sheet name', () => {
  assert.match(workbookText(), /Customer Ranking/)
})

test('Excel sheet-name sanitisation removes invalid characters', () => {
  assert.equal(sanitizeSheetName('PI/Search:*?[2026]'), 'PI Search 2026')
})

test('Excel sheet-name sanitisation limits length to 31', () => {
  assert.ok(sanitizeSheetName('A'.repeat(60)).length <= 31)
})

test('Excel currency cells remain numeric values', () => {
  assert.match(workbookText(), /<v>402705<\/v>/)
})

test('Excel date cells are written as serial values', () => {
  assert.match(workbookText(), /<c r="A2" s="2"><v>\d+<\/v><\/c>/)
})

test('Excel currency cells use currency style', () => {
  assert.match(workbookText(), /<c r="C2" s="1"><v>402705<\/v><\/c>/)
})

test('Excel header row uses header style', () => {
  assert.match(workbookText(), /<c r="A1" t="inlineStr" s="3">/)
})

test('Excel workbook supports empty datasets', () => {
  const text = createXlsxWorkbookBuffer([{ headers: ['A'], name: 'Empty', rows: [] }]).toString('utf8')

  assert.match(text, /Empty/)
})

test('CSV output starts with UTF-8 BOM', () => {
  assert.equal(createCsvReport([['A']]).charCodeAt(0), 0xfeff)
})

test('CSV output includes column headers', () => {
  assert.match(createCsvReport([['Date', 'Value'], ['2026-07-29', 10]]), /Date,Value/)
})

test('CSV comma escaping works', () => {
  assert.equal(escapeCsvCell('A,B'), '"A,B"')
})

test('CSV quote escaping works', () => {
  assert.equal(escapeCsvCell('A "B"'), '"A ""B"""')
})

test('CSV newline escaping works', () => {
  assert.equal(escapeCsvCell('A\nB'), '"A\nB"')
})

test('CSV numeric values remain plain numeric text', () => {
  assert.match(createCsvReport([['Value'], [402705]]), /\r\n402705\r\n/)
})

test('CSV empty dataset still produces a file body', () => {
  assert.equal(createCsvReport([]), '\uFEFF\r\n')
})

test('CSV exports filtered rows only when those rows are supplied', () => {
  const csv = createCsvReport([['Customer'], ['Jalaram Enterprise']])

  assert.match(csv, /Jalaram Enterprise/)
  assert.doesNotMatch(csv, /ABC Traders/)
})

test('PDF output is generated', () => {
  assert.equal(createPdfReportBuffer({ generatedBy: 'dileep', rows: [], title: 'Summary' }).subarray(0, 4).toString(), '%PDF')
})

test('PDF includes report title text', () => {
  assert.match(createPdfReportBuffer({ generatedBy: 'dileep', rows: [], title: 'Summary' }).toString(), /Summary/)
})

test('PDF includes generated-by user', () => {
  assert.match(createPdfReportBuffer({ generatedBy: 'dileep', rows: [], title: 'Summary' }).toString(), /dileep/)
})

test('PDF includes live ERP data label', () => {
  assert.match(createPdfReportBuffer({ generatedBy: 'dileep', rows: [], title: 'Summary' }).toString(), /Live ERP data/)
})

test('PDF includes summary values', () => {
  assert.match(
    createPdfReportBuffer({
      generatedBy: 'dileep',
      rows: [['This Month PI Value', 'INR 402705']],
      title: 'Summary',
    }).toString(),
    /402705/,
  )
})

test('PDF includes ranking table text', () => {
  assert.match(
    createPdfReportBuffer({
      generatedBy: 'dileep',
      rows: [['1', 'Jalaram Enterprise', '402705']],
      title: 'Customer Ranking',
    }).toString(),
    /Jalaram Enterprise/,
  )
})

test('PDF includes search table text', () => {
  assert.match(
    createPdfReportBuffer({
      generatedBy: 'dileep',
      rows: [['AML-0012', 'Jalaram Enterprise']],
      title: 'PI Search Results',
    }).toString(),
    /AML-0012/,
  )
})

test('PDF handles empty data', () => {
  assert.match(createPdfReportBuffer({ generatedBy: 'dileep', rows: [], title: 'Empty' }).toString(), /Empty/)
})

test('PDF safely normalises rupee symbol', () => {
  assert.match(
    createPdfReportBuffer({ generatedBy: 'dileep', rows: [['Value', '₹100']], title: 'Summary' }).toString(),
    /INR 100/,
  )
})

test('Authorised export is accepted', () => {
  assert.equal(
    assertExportAccess({
      authorized: true,
      permissions: ['ai-erp-intelligence'],
    }),
    true,
  )
})

test('Unauthorised export is rejected', () => {
  assert.throws(() => assertExportAccess({ authorized: false }), /Authentication/)
})

test('Missing permission is rejected', () => {
  assert.throws(
    () => assertExportAccess({ authorized: true, permissions: ['dashboard'] }),
    /permission/,
  )
})

test('Ranking export accepts maximum allowed rows', () => {
  assert.equal(enforceExportLimit('ranking', 100), true)
})

test('Ranking export rejects oversized rows', () => {
  assert.throws(() => enforceExportLimit('ranking', 101), /Maximum 100/)
})

test('PI search export accepts maximum allowed rows', () => {
  assert.equal(enforceExportLimit('search', 1_000), true)
})

test('PI search export rejects oversized rows', () => {
  assert.throws(() => enforceExportLimit('search', 1_001), /Maximum 1000/)
})

test('Trend export accepts 366 days', () => {
  assert.equal(enforceExportLimit('trend', 366), true)
})

test('Trend export rejects more than 366 days', () => {
  assert.throws(() => enforceExportLimit('trend', 367), /Maximum 366/)
})

test('Write SQL detector blocks INSERT', () => {
  assert.equal(detectWriteSql('insert into master_pi_rmkt values (1)'), true)
})

test('Write SQL detector blocks UPDATE', () => {
  assert.equal(detectWriteSql('update master_pi_rmkt set grand_total = 0'), true)
})

test('Write SQL detector blocks DELETE', () => {
  assert.equal(detectWriteSql('delete from master_pi_rmkt'), true)
})

test('Write SQL detector allows SELECT', () => {
  assert.equal(detectWriteSql('select pi_no from master_pi_rmkt'), false)
})

test('Filename sanitiser removes path separators', () => {
  assert.equal(sanitizeReportFilename('..\\bad/path', 'xlsx'), 'bad_path.xlsx')
})

test('Filename sanitiser preserves requested extension', () => {
  assert.match(sanitizeReportFilename('AUTOPAL Report', '.csv'), /\.csv$/)
})

test('Filename sanitiser limits length', () => {
  assert.ok(sanitizeReportFilename('A'.repeat(300), 'pdf').length <= 140)
})

test('Filename sanitiser prevents absolute path output', () => {
  assert.doesNotMatch(sanitizeReportFilename('C:\\secret\\report', 'pdf'), /[\\:]/)
})

test('Confidential GSTIN field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ gstin: 'X', piNumber: 'AML-0012' }), {
    piNumber: 'AML-0012',
  })
})

test('Confidential PAN field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ pan: 'X', customerName: 'A' }), {
    customerName: 'A',
  })
})

test('Confidential address field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ address: 'X', companyName: 'A' }), {
    companyName: 'A',
  })
})

test('Confidential phone field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ phone: 'X', status: 'Draft' }), {
    status: 'Draft',
  })
})

test('Confidential email field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ email: 'X', grandTotal: 10 }), {
    grandTotal: 10,
  })
})

test('Confidential bank fields are removed recursively', () => {
  assert.deepEqual(stripConfidentialFields({ pi: { bankAccount: 'X', piNumber: 'AML-0012' } }), {
    pi: { piNumber: 'AML-0012' },
  })
})

test('Product code is preserved as safe detail data', () => {
  assert.deepEqual(stripConfidentialFields({ productCode: '04-102-1411' }), {
    productCode: '04-102-1411',
  })
})

test('Product description is preserved as safe detail data', () => {
  assert.deepEqual(stripConfidentialFields({ productDescription: 'SB 102 H4' }), {
    productDescription: 'SB 102 H4',
  })
})

test('Database URL field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ DATABASE_URL: 'secret', piNumber: 'AML-0012' }), {
    piNumber: 'AML-0012',
  })
})

test('Access token field is removed', () => {
  assert.deepEqual(stripConfidentialFields({ accessToken: 'secret', status: 'Draft' }), {
    status: 'Draft',
  })
})

test('PDF excludes confidential fields after sanitising rows', () => {
  const safe = stripConfidentialFields({ gstin: 'SECRET', piNumber: 'AML-0012' })

  assert.doesNotMatch(
    createPdfReportBuffer({
      generatedBy: 'dileep',
      rows: Object.entries(safe),
      title: 'Detailed PI',
    }).toString(),
    /SECRET/,
  )
})

test('CSV excludes confidential fields after sanitising rows', () => {
  const safe = stripConfidentialFields({ email: 'secret@example.com', piNumber: 'AML-0012' })

  assert.doesNotMatch(createCsvReport([Object.keys(safe), Object.values(safe)]), /secret@example/)
})

test('Excel excludes confidential fields after sanitising rows', () => {
  const safe = stripConfidentialFields({ phone: 'SECRET', piNumber: 'AML-0012' })
  const text = createXlsxWorkbookBuffer([
    {
      headers: Object.keys(safe),
      name: 'Safe',
      rows: [Object.values(safe)],
    },
  ]).toString('utf8')

  assert.doesNotMatch(text, /SECRET/)
})

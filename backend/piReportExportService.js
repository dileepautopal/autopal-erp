const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

export const REPORT_LIMITS = {
  ranking: 100,
  search: 1_000,
  trend: 366,
}

export const toReportNumber = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

export const sanitizeReportFilename = (value, extension, maxLength = 140) => {
  const safeExtension = String(extension || 'txt')
    .replace(/^\.+/, '')
    .replace(INVALID_FILENAME_CHARS, '')
  const baseName = String(value || 'AUTOPAL_Report')
    .replace(/\.\.+/g, '.')
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, Math.max(maxLength - safeExtension.length - 1, 20))

  return `${baseName || 'AUTOPAL_Report'}.${safeExtension || 'txt'}`
}

export const escapeCsvCell = (value) => {
  const text = String(value ?? '')

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

export const createCsvReport = (rows) =>
  `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`

export const assertExportAccess = ({ authorized = false, permissions = [] } = {}) => {
  if (!authorized) {
    const error = new Error('Authentication is required for PI report export.')
    error.statusCode = 401
    throw error
  }

  if (!permissions.includes('ai-erp-intelligence')) {
    const error = new Error('AI ERP Intelligence permission is required.')
    error.statusCode = 403
    throw error
  }

  return true
}

export const enforceExportLimit = (kind, rowCount) => {
  const limit = REPORT_LIMITS[kind]

  if (!limit) {
    return true
  }

  if (rowCount > limit) {
    const error = new Error(`Export row limit exceeded. Maximum ${limit} ${kind} rows are allowed.`)
    error.statusCode = 413
    throw error
  }

  return true
}

export const detectWriteSql = (text) =>
  /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|LOCK|GRANT|REVOKE)\b/i.test(
    String(text ?? ''),
  )

const isConfidentialKey = (key) => {
  const normalized = String(key ?? '')
    .replace(/[_\s-]+/g, '')
    .toLowerCase()

  return (
    normalized.includes('gstin') ||
    normalized === 'pan' ||
    normalized.includes('panno') ||
    normalized.includes('address') ||
    normalized.includes('phone') ||
    normalized.includes('mobile') ||
    normalized.includes('email') ||
    normalized.includes('bank') ||
    normalized.includes('account') ||
    normalized.includes('ifsc') ||
    normalized.includes('password') ||
    normalized.includes('token') ||
    normalized.includes('databaseurl') ||
    normalized.includes('secret')
  )
}

export const stripConfidentialFields = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => stripConfidentialFields(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isConfidentialKey(key))
      .map(([key, fieldValue]) => [key, stripConfidentialFields(fieldValue)]),
  )
}

export const sanitizeSheetName = (value) =>
  String(value || 'Report')
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Report'

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const getColumnName = (index) => {
  let name = ''
  let value = index

  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - remainder) / 26)
  }

  return name
}

const dateSerial = (value) => {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return null
  }

  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))

  return Math.floor((date - Date.UTC(1899, 11, 30)) / 86_400_000)
}

const buildWorksheetXml = (sheet) => {
  const headers = sheet.headers ?? []
  const rows = sheet.rows ?? []
  const allRows = [headers, ...rows]
  const widths = sheet.widths ?? headers.map(() => 18)
  const columnsXml = `<cols>${widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')}</cols>`
  const rowsXml = allRows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1
      const cellsXml = row
        .map((cell, columnIndex) => {
          const columnNumber = columnIndex + 1
          const reference = `${getColumnName(columnNumber)}${rowNumber}`
          const type = sheet.types?.[columnIndex] ?? 'text'

          if (rowIndex > 0 && (type === 'number' || type === 'currency')) {
            return `<c r="${reference}" s="${type === 'currency' ? 1 : 0}"><v>${toReportNumber(cell)}</v></c>`
          }

          if (rowIndex > 0 && type === 'date') {
            const serial = dateSerial(cell)

            if (serial !== null) {
              return `<c r="${reference}" s="2"><v>${serial}</v></c>`
            }
          }

          return `<c r="${reference}" t="inlineStr" s="${rowIndex === 0 ? 3 : 0}"><is><t>${escapeXml(cell)}</t></is></c>`
        })
        .join('')

      return `<row r="${rowNumber}">${cellsXml}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${getColumnName(Math.max(headers.length, 1))}${Math.max(allRows.length, 1)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${columnsXml}<sheetData>${rowsXml}</sheetData></worksheet>`
}

const buildStylesXml = () =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;&#8377;&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD30A13"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }

  return value >>> 0
})

const crc32 = (buffer) => {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

const getDosDateTime = () => {
  const date = new Date()
  const year = Math.max(date.getFullYear(), 1980)

  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

const zipEntries = (entries) => {
  const chunks = []
  const centralChunks = []
  const { dosDate, dosTime } = getDosDateTime()
  let offset = 0

  entries.forEach((entry) => {
    const name = Buffer.from(entry.name)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)

    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, data)

    const central = Buffer.alloc(46)

    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, name)
    offset += local.length + name.length + data.length
  })

  const central = Buffer.concat(centralChunks)
  const end = Buffer.alloc(22)

  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, central, end])
}

export const createXlsxWorkbookBuffer = (sheets) => {
  const safeSheets = sheets.map((sheet) => ({
    ...sheet,
    name: sanitizeSheetName(sheet.name),
  }))
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safeSheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')}</sheets></workbook>`
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safeSheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')}<Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${safeSheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

  return zipEntries([
    { data: contentTypes, name: '[Content_Types].xml' },
    {
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      name: '_rels/.rels',
    },
    { data: workbookXml, name: 'xl/workbook.xml' },
    { data: workbookRels, name: 'xl/_rels/workbook.xml.rels' },
    { data: buildStylesXml(), name: 'xl/styles.xml' },
    ...safeSheets.map((sheet, index) => ({
      data: buildWorksheetXml(sheet),
      name: `xl/worksheets/sheet${index + 1}.xml`,
    })),
  ])
}

const escapePdfText = (value) =>
  String(value ?? '')
    .replace(/\u20b9/g, 'INR ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')

export const createPdfReportBuffer = ({ generatedBy, rows = [], title }) => {
  const lines = [
    'AUTOPAL',
    'PI Intelligence Report',
    title,
    `Generated by: ${generatedBy || 'AUTOPAL user'}`,
    'Live ERP data',
    ...rows.map((row) => row.join(' | ')),
  ]
  const commands = lines
    .map((line, index) => `BT /F1 11 Tf 1 0 0 1 40 ${790 - index * 16} Tm (${escapePdfText(line)}) Tj ET`)
    .join('\n')
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [5 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]

  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf)
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`

  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }

  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(pdf)
}

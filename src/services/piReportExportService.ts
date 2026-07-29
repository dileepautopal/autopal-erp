import type {
  PIDetailResponse,
  PIIntelligenceLatestPI,
  PIIntelligenceProDashboardResponse,
  PIIntelligenceRankingRow,
  PIIntelligenceTrendRow,
  PIManagementInsightResponse,
  PISearchFilters,
} from './aiService'
import {
  createCsvText,
  formatDateISO,
  formatINR,
  formatReportDate,
  formatReportDateTime,
  formatReportNumber,
  getIndiaTimestampStamp,
  sanitizeFilename,
  toFiniteNumber,
} from '../utils/exportUtils'

export type PIReportType =
  | 'current-tab'
  | 'complete'
  | 'summary'
  | 'trends'
  | 'customers'
  | 'companies'
  | 'search'
  | 'detail'
  | 'insight'

export type PIReportDashboardTab =
  | 'overview'
  | 'trends'
  | 'customers'
  | 'companies'
  | 'search'
  | 'insight'

export type PIReportContext = {
  activeTab: PIReportDashboardTab
  companyRows: PIIntelligenceRankingRow[]
  customerRows: PIIntelligenceRankingRow[]
  customEndDate?: string
  customStartDate?: string
  dashboard: PIIntelligenceProDashboardResponse | null
  generatedAt?: string
  generatedBy: string
  insight: PIManagementInsightResponse | null
  rankingLimit?: number
  rankingPeriod?: string
  searchFilters: PISearchFilters
  searchRows: PIIntelligenceLatestPI[]
  selectedDetail: PIDetailResponse | null
}

type CellType = 'currency' | 'date' | 'number' | 'text'

type WorkbookCell = {
  bold?: boolean
  type?: CellType
  value: Date | number | string | null | undefined
}

type WorkbookSheet = {
  freezeRows?: number
  headerRows?: number[]
  name: string
  rows: WorkbookCell[][]
  totalRows?: number[]
  widths?: number[]
}

type ReportTable = {
  headers: string[]
  rows: Array<Array<number | string>>
  title: string
  totalRow?: Array<number | string>
}

type ReportSection = {
  body?: string[]
  table?: ReportTable
  title: string
}

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF_CONTENT_TYPE = 'application/pdf'
const CSV_CONTENT_TYPE = 'text/csv;charset=utf-8'

const MAX_RANKING_EXPORT_ROWS = 100
const MAX_SEARCH_EXPORT_ROWS = 1_000
const MAX_TREND_EXPORT_ROWS = 366

const REPORT_TITLES: Record<Exclude<PIReportType, 'current-tab'>, string> = {
  companies: 'Company Ranking Report',
  complete: 'PI Intelligence Management Report',
  customers: 'Customer Ranking Report',
  detail: 'Detailed PI Report',
  insight: 'Management Insight Report',
  search: 'PI Search Results Report',
  summary: 'PI Management Summary',
  trends: 'PI Trend Report',
}

const workbookCell = (
  value: WorkbookCell['value'],
  type: CellType = 'text',
  bold = false,
): WorkbookCell => ({
  bold,
  type,
  value,
})

const textCell = (value: unknown, bold = false) =>
  workbookCell(String(value ?? ''), 'text', bold)

const numberCell = (value: unknown, bold = false) =>
  workbookCell(toFiniteNumber(value), 'number', bold)

const currencyCell = (value: unknown, bold = false) =>
  workbookCell(toFiniteNumber(value), 'currency', bold)

const asRows = <T,>(rows: T[] | undefined | null) =>
  Array.isArray(rows) ? rows : []

const limitRows = <T,>(rows: T[] | undefined | null, limit: number) =>
  asRows(rows).slice(0, limit)

export const resolvePIReportType = (
  reportType: PIReportType,
  activeTab: PIReportDashboardTab,
): Exclude<PIReportType, 'current-tab'> => {
  if (reportType !== 'current-tab') {
    return reportType
  }

  if (activeTab === 'overview') {
    return 'summary'
  }

  return activeTab
}

const buildGeneratedAt = (context: PIReportContext) =>
  context.generatedAt || new Date().toISOString()

export const getPIReportTitle = (
  reportType: PIReportType,
  context: PIReportContext,
  customTitle = '',
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)
  const title = customTitle.trim() || REPORT_TITLES[resolvedType]

  return title
}

const getPeriodLabel = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
) => {
  const period = context.dashboard?.period

  if (resolvedType === 'search') {
    const startDate = context.searchFilters.startDate
    const endDate = context.searchFilters.endDate

    if (startDate || endDate) {
      return `${formatDateISO(startDate) || 'Start'} to ${
        formatDateISO(endDate) || 'End'
      }`
    }
  }

  if (resolvedType === 'customers' || resolvedType === 'companies') {
    if (context.rankingPeriod === 'custom') {
      return `${formatDateISO(context.customStartDate) || 'Start'} to ${
        formatDateISO(context.customEndDate) || 'End'
      }`
    }

    return context.rankingPeriod || 'month'
  }

  if (period?.monthStart || period?.monthEnd) {
    return `${formatDateISO(period.monthStart)} to ${formatDateISO(period.monthEnd)}`
  }

  return 'Current loaded PI Intelligence period'
}

const getAppliedFilters = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
) => {
  const filters: string[] = []

  if (resolvedType === 'customers' || resolvedType === 'companies') {
    filters.push(`Ranking period: ${context.rankingPeriod || 'month'}`)
    filters.push(`Ranking limit: ${context.rankingLimit || 10}`)

    if (context.rankingPeriod === 'custom') {
      filters.push(`Start date: ${formatDateISO(context.customStartDate) || '-'}`)
      filters.push(`End date: ${formatDateISO(context.customEndDate) || '-'}`)
    }
  }

  if (resolvedType === 'search') {
    const search = context.searchFilters

    if (search.q) {
      filters.push(`Search: ${search.q}`)
    }

    if (search.status) {
      filters.push(`Status: ${search.status}`)
    }

    if (search.startDate || search.endDate) {
      filters.push(
        `Date range: ${formatDateISO(search.startDate) || '-'} to ${
          formatDateISO(search.endDate) || '-'
        }`,
      )
    }

    filters.push(`Limit: ${search.limit || 20}`)
  }

  if (resolvedType === 'detail') {
    filters.push(`PI number: ${context.selectedDetail?.piNumber || '-'}`)
  }

  return filters.length ? filters.join('; ') : 'None'
}

const getReportMetaRows = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
  title: string,
): WorkbookCell[][] => [
  [textCell('AUTOPAL PI Intelligence', true)],
  [textCell('Report Title', true), textCell(title)],
  [textCell('Generated At', true), textCell(formatReportDateTime(buildGeneratedAt(context)))],
  [textCell('Generated By', true), textCell(context.generatedBy || 'AUTOPAL user')],
  [textCell('Data Label', true), textCell('Live ERP data')],
  [textCell('Period', true), textCell(getPeriodLabel(context, resolvedType))],
  [textCell('Applied Filters', true), textCell(getAppliedFilters(context, resolvedType))],
  [],
]

const getCsvMetaRows = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
  title: string,
) => [
  ['AUTOPAL PI Intelligence'],
  ['Report Title', title],
  ['Generated At', formatReportDateTime(buildGeneratedAt(context))],
  ['Generated By', context.generatedBy || 'AUTOPAL user'],
  ['Data Label', 'Live ERP data'],
  ['Period', getPeriodLabel(context, resolvedType)],
  ['Applied Filters', getAppliedFilters(context, resolvedType)],
  [],
]

const getSummaryRows = (dashboard: PIIntelligenceProDashboardResponse | null) => {
  const kpis = dashboard?.kpis ?? {}

  return [
    ['Today PI Count', numberCell(kpis.today?.count)],
    ['Today PI Value', currencyCell(kpis.today?.value)],
    ['Yesterday PI Count', numberCell(kpis.yesterday?.count)],
    ['Yesterday PI Value', currencyCell(kpis.yesterday?.value)],
    ['This Week PI Count', numberCell(kpis.week?.count)],
    ['This Week PI Value', currencyCell(kpis.week?.value)],
    ['This Month PI Count', numberCell(kpis.month?.count)],
    ['This Month PI Value', currencyCell(kpis.month?.value)],
    ['Average PI Value', currencyCell(kpis.averagePIValueMonth)],
    ['Highest PI Value', currencyCell(kpis.highestPIValueMonth)],
    ['Lowest PI Value', currencyCell(kpis.lowestPIValueMonth)],
    ['Open PI Count', numberCell(kpis.open?.count)],
    ['Open PI Value', currencyCell(kpis.open?.value)],
    ['Open Percentage', numberCell(kpis.open?.percentage)],
    ['Final PI Count', numberCell(kpis.final?.count)],
    ['Final PI Value', currencyCell(kpis.final?.value)],
    ['Final Percentage', numberCell(kpis.final?.percentage)],
    ['Top Customer', textCell(dashboard?.topCustomer?.name || '-')],
    ['Top Customer PI Count', numberCell(dashboard?.topCustomer?.piCount)],
    ['Top Customer PI Value', currencyCell(dashboard?.topCustomer?.totalPIValue)],
    ['Top Company', textCell(dashboard?.topCompany?.name || '-')],
    ['Top Company PI Count', numberCell(dashboard?.topCompany?.piCount)],
    ['Top Company PI Value', currencyCell(dashboard?.topCompany?.totalPIValue)],
    [
      'Best Day by Count',
      textCell(
        dashboard?.bestDayByCount
          ? `${formatReportDate(dashboard.bestDayByCount.date)} (${formatReportNumber(
              dashboard.bestDayByCount.count,
              0,
            )} PI)`
          : '-',
      ),
    ],
    [
      'Best Day by Value',
      textCell(
        dashboard?.bestDayByValue
          ? `${formatReportDate(dashboard.bestDayByValue.date)} (${formatINR(
              dashboard.bestDayByValue.value,
            )})`
          : '-',
      ),
    ],
  ] satisfies Array<[string, WorkbookCell]>
}

const getSummaryPlainRows = (dashboard: PIIntelligenceProDashboardResponse | null) =>
  getSummaryRows(dashboard).map(([label, cell]) => [
    label,
    typeof cell.value === 'number' ? cell.value : String(cell.value ?? ''),
  ])

const getSummaryDisplayRows = (dashboard: PIIntelligenceProDashboardResponse | null) =>
  getSummaryRows(dashboard).map(([label, cell]) => [
    label,
    cell.type === 'currency'
      ? formatINR(cell.value)
      : cell.type === 'number'
        ? formatReportNumber(cell.value)
        : String(cell.value ?? ''),
  ])

const trendToPlainRows = (rows: PIIntelligenceTrendRow[]) =>
  rows.map((row) => [formatDateISO(row.date), row.count, row.value])

const getTrendTotalRow = (rows: PIIntelligenceTrendRow[]) => [
  'Total',
  rows.reduce((total, row) => total + toFiniteNumber(row.count), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.value), 0),
]

const rankingToPlainRows = (
  rows: PIIntelligenceRankingRow[],
  type: 'company' | 'customer',
) =>
  rows.map((row) =>
    type === 'customer'
      ? [
          toFiniteNumber(row.rank),
          row.name || 'Unknown',
          toFiniteNumber(row.piCount),
          toFiniteNumber(row.totalPIValue),
          toFiniteNumber(row.averagePIValue),
          toFiniteNumber(row.openCount),
          toFiniteNumber(row.openValue),
          toFiniteNumber(row.finalCount),
          toFiniteNumber(row.finalValue),
          formatDateISO(row.lastPIDate),
        ]
      : [
          toFiniteNumber(row.rank),
          row.name || 'Unknown',
          toFiniteNumber(row.piCount),
          toFiniteNumber(row.totalPIValue),
          toFiniteNumber(row.averagePIValue),
          toFiniteNumber(row.openCount),
          toFiniteNumber(row.finalCount),
          formatDateISO(row.lastPIDate),
        ],
  )

const getCustomerRankingTotalRow = (rows: PIIntelligenceRankingRow[]) => [
  '',
  'Total',
  rows.reduce((total, row) => total + toFiniteNumber(row.piCount), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.totalPIValue), 0),
  '',
  rows.reduce((total, row) => total + toFiniteNumber(row.openCount), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.openValue), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.finalCount), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.finalValue), 0),
  '',
]

const getCompanyRankingTotalRow = (rows: PIIntelligenceRankingRow[]) => [
  '',
  'Total',
  rows.reduce((total, row) => total + toFiniteNumber(row.piCount), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.totalPIValue), 0),
  '',
  rows.reduce((total, row) => total + toFiniteNumber(row.openCount), 0),
  rows.reduce((total, row) => total + toFiniteNumber(row.finalCount), 0),
  '',
]

const piRowsToPlainRows = (rows: PIIntelligenceLatestPI[]) =>
  rows.map((row) => [
    row.piNumber || '',
    formatDateISO(row.piDate),
    row.customerName || '',
    row.companyName || '',
    row.status || '',
    toFiniteNumber(row.grandTotal),
  ])

const getPITotalRow = (rows: PIIntelligenceLatestPI[]) => [
  '',
  '',
  '',
  '',
  'Total',
  rows.reduce((total, row) => total + toFiniteNumber(row.grandTotal), 0),
]

const detailLinesToPlainRows = (detail: PIDetailResponse | null) =>
  asRows(detail?.lines).map((line) => [
    line.productCode || '',
    line.productDescription || '',
    toFiniteNumber(line.quantity),
    toFiniteNumber(line.rate),
    toFiniteNumber(line.amount),
  ])

const getDetailLineTotalRow = (detail: PIDetailResponse | null) => [
  '',
  'Total',
  asRows(detail?.lines).reduce(
    (total, line) => total + toFiniteNumber(line.quantity),
    0,
  ),
  '',
  asRows(detail?.lines).reduce((total, line) => total + toFiniteNumber(line.amount), 0),
]

const makeSheet = ({
  context,
  name,
  resolvedType,
  rows,
  title,
  widths,
}: {
  context: PIReportContext
  name: string
  resolvedType: Exclude<PIReportType, 'current-tab'>
  rows: WorkbookCell[][]
  title: string
  widths?: number[]
}): WorkbookSheet => {
  const metaRows = getReportMetaRows(context, resolvedType, title)
  const headerRow = metaRows.length + 1
  const totalRows = rows
    .map((row, index) => (String(row[1]?.value ?? '').toLowerCase() === 'total' ? index : -1))
    .filter((index) => index >= 0)
    .map((index) => index + metaRows.length + 1)

  return {
    freezeRows: headerRow,
    headerRows: [headerRow],
    name,
    rows: [...metaRows, ...rows],
    totalRows,
    widths,
  }
}

const tableRowsToWorkbookCells = (
  headers: string[],
  rows: Array<Array<number | string>>,
  columnTypes: CellType[],
  totalRow?: Array<number | string>,
) => {
  const mapRow = (row: Array<number | string>, bold = false) =>
    row.map((value, index) => workbookCell(value, columnTypes[index] || 'text', bold))

  return [
    headers.map((header) => textCell(header, true)),
    ...rows.map((row) => mapRow(row)),
    ...(totalRow ? [mapRow(totalRow, true)] : []),
  ]
}

const getSummarySheet = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
  title: string,
) =>
  makeSheet({
    context,
    name: 'Summary',
    resolvedType,
    rows: [
      [textCell('Metric', true), textCell('Value', true)],
      ...getSummaryRows(context.dashboard).map(([label, value]) => [
        textCell(label),
        value,
      ]),
    ],
    title,
    widths: [32, 28],
  })

const getTrendTable = (context: PIReportContext): ReportTable => {
  const rows = limitRows(context.dashboard?.trend, MAX_TREND_EXPORT_ROWS)

  return {
    headers: ['Date', 'PI Count', 'PI Value'],
    rows: trendToPlainRows(rows),
    title: 'Daily Trend',
    totalRow: getTrendTotalRow(rows),
  }
}

const getCustomerTable = (context: PIReportContext): ReportTable => {
  const rows = limitRows(context.customerRows, MAX_RANKING_EXPORT_ROWS)

  return {
    headers: [
      'Rank',
      'Customer Name',
      'PI Count',
      'Total PI Value',
      'Average PI Value',
      'Open PI Count',
      'Open PI Value',
      'Final PI Count',
      'Final PI Value',
      'Last PI Date',
    ],
    rows: rankingToPlainRows(rows, 'customer'),
    title: 'Customer Ranking',
    totalRow: getCustomerRankingTotalRow(rows),
  }
}

const getCompanyTable = (context: PIReportContext): ReportTable => {
  const rows = limitRows(context.companyRows, MAX_RANKING_EXPORT_ROWS)

  return {
    headers: [
      'Rank',
      'Company Name',
      'PI Count',
      'Total PI Value',
      'Average PI Value',
      'Open PI Count',
      'Final PI Count',
      'Last PI Date',
    ],
    rows: rankingToPlainRows(rows, 'company'),
    title: 'Company Ranking',
    totalRow: getCompanyRankingTotalRow(rows),
  }
}

const getLatestPITable = (context: PIReportContext): ReportTable => {
  const rows = limitRows(context.dashboard?.latestPIs, 10)

  return {
    headers: ['PI Number', 'PI Date', 'Customer', 'Company', 'Status', 'Grand Total'],
    rows: piRowsToPlainRows(rows),
    title: 'Latest PIs',
    totalRow: getPITotalRow(rows),
  }
}

const getSearchTable = (context: PIReportContext): ReportTable => {
  const rows = limitRows(context.searchRows, MAX_SEARCH_EXPORT_ROWS)

  return {
    headers: ['PI Number', 'PI Date', 'Customer', 'Company', 'Status', 'Grand Total'],
    rows: piRowsToPlainRows(rows),
    title: 'PI Search Results',
    totalRow: getPITotalRow(rows),
  }
}

const getDetailHeaderTable = (context: PIReportContext): ReportTable => {
  const detail = context.selectedDetail

  return {
    headers: ['PI Number', 'PI Date', 'Customer', 'Company', 'Status', 'Grand Total'],
    rows: detail
      ? [
          [
            detail.piNumber || '',
            formatDateISO(detail.piDate),
            detail.customerName || '',
            detail.companyName || '',
            detail.status || '',
            toFiniteNumber(detail.grandTotal),
          ],
        ]
      : [],
    title: 'Detailed PI',
    totalRow: detail ? ['', '', '', '', 'Total', toFiniteNumber(detail.grandTotal)] : undefined,
  }
}

const getDetailLinesTable = (context: PIReportContext): ReportTable => ({
  headers: ['Product Code', 'Product Description', 'Quantity', 'Rate', 'Amount'],
  rows: detailLinesToPlainRows(context.selectedDetail),
  title: 'Safe Product Lines',
  totalRow: getDetailLineTotalRow(context.selectedDetail),
})

const getInsightSection = (context: PIReportContext): ReportSection => ({
  body: [
    context.insight?.insight || 'Management insight is not currently loaded.',
    'AI-assisted wording based on verified PI data.',
    `Wording mode: ${context.insight?.wordingMode || 'not available'}`,
    `Insight generated at: ${formatReportDateTime(context.insight?.generatedAt)}`,
  ],
  title: 'Management Insight',
})

const sheetFromTable = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
  title: string,
  table: ReportTable,
  columnTypes: CellType[],
  widths: number[],
) =>
  makeSheet({
    context,
    name: table.title,
    resolvedType,
    rows: tableRowsToWorkbookCells(table.headers, table.rows, columnTypes, table.totalRow),
    title,
    widths,
  })

export const buildPIReportSheets = (
  context: PIReportContext,
  reportType: PIReportType,
  customTitle = '',
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)
  const title = getPIReportTitle(reportType, context, customTitle)
  const sheets: WorkbookSheet[] = []
  const includeAll = resolvedType === 'complete'

  if (includeAll || resolvedType === 'summary') {
    sheets.push(getSummarySheet(context, resolvedType, title))
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getLatestPITable(context),
        ['text', 'date', 'text', 'text', 'text', 'currency'],
        [16, 14, 28, 28, 12, 16],
      ),
    )
  }

  if (includeAll || resolvedType === 'trends') {
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getTrendTable(context),
        ['date', 'number', 'currency'],
        [16, 14, 18],
      ),
    )
  }

  if (includeAll || resolvedType === 'customers') {
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getCustomerTable(context),
        [
          'number',
          'text',
          'number',
          'currency',
          'currency',
          'number',
          'currency',
          'number',
          'currency',
          'date',
        ],
        [8, 32, 12, 18, 18, 14, 18, 14, 18, 14],
      ),
    )
  }

  if (includeAll || resolvedType === 'companies') {
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getCompanyTable(context),
        ['number', 'text', 'number', 'currency', 'currency', 'number', 'number', 'date'],
        [8, 32, 12, 18, 18, 14, 14, 14],
      ),
    )
  }

  if (includeAll || resolvedType === 'search') {
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getSearchTable(context),
        ['text', 'date', 'text', 'text', 'text', 'currency'],
        [16, 14, 28, 28, 12, 16],
      ),
    )
  }

  if (resolvedType === 'detail') {
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getDetailHeaderTable(context),
        ['text', 'date', 'text', 'text', 'text', 'currency'],
        [16, 14, 28, 28, 12, 16],
      ),
    )
    sheets.push(
      sheetFromTable(
        context,
        resolvedType,
        title,
        getDetailLinesTable(context),
        ['text', 'text', 'number', 'currency', 'currency'],
        [18, 42, 12, 14, 16],
      ),
    )
  }

  if (includeAll || resolvedType === 'insight') {
    const insightRows = getInsightSection(context).body?.map((line) => [textCell(line)]) ?? []

    sheets.push(
      makeSheet({
        context,
        name: 'Management Insight',
        resolvedType,
        rows: [[textCell('Insight', true)], ...insightRows],
        title,
        widths: [96],
      }),
    )
  }

  return sheets
}

const escapeXml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const getColumnName = (index: number) => {
  let name = ''
  let value = index

  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - remainder) / 26)
  }

  return name
}

const parseDateSerial = (value: unknown) => {
  const text = formatDateISO(String(value ?? ''))
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)

  if (!match) {
    return null
  }

  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))

  return Math.floor((date - Date.UTC(1899, 11, 30)) / 86_400_000)
}

const getCellStyle = (
  cell: WorkbookCell,
  rowNumber: number,
  sheet: WorkbookSheet,
) => {
  if (rowNumber === 1) {
    return 4
  }

  if (sheet.headerRows?.includes(rowNumber)) {
    return 3
  }

  if (sheet.totalRows?.includes(rowNumber)) {
    return cell.type === 'currency' ? 5 : 6
  }

  if (cell.bold) {
    return 6
  }

  if (cell.type === 'currency') {
    return 1
  }

  if (cell.type === 'date') {
    return 2
  }

  return 0
}

const buildCellXml = (
  cell: WorkbookCell,
  rowNumber: number,
  columnNumber: number,
  sheet: WorkbookSheet,
) => {
  const reference = `${getColumnName(columnNumber)}${rowNumber}`
  const style = getCellStyle(cell, rowNumber, sheet)
  const styleAttribute = style > 0 ? ` s="${style}"` : ''

  if (cell.type === 'number' || cell.type === 'currency') {
    return `<c r="${reference}"${styleAttribute}><v>${toFiniteNumber(
      cell.value,
    )}</v></c>`
  }

  if (cell.type === 'date') {
    const serial = parseDateSerial(cell.value)

    if (serial !== null) {
      return `<c r="${reference}"${styleAttribute}><v>${serial}</v></c>`
    }
  }

  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t>${escapeXml(
    cell.value,
  )}</t></is></c>`
}

const sanitizeSheetName = (value: string) =>
  String(value || 'Report')
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Report'

const getSafeSheetNames = (sheets: WorkbookSheet[]) => {
  const usedNames = new Map<string, number>()

  return sheets.map((sheet) => {
    const baseName = sanitizeSheetName(sheet.name)
    const usedCount = usedNames.get(baseName) ?? 0
    usedNames.set(baseName, usedCount + 1)

    if (usedCount === 0) {
      return baseName
    }

    const suffix = ` ${usedCount + 1}`

    return `${baseName.slice(0, 31 - suffix.length)}${suffix}`
  })
}

const buildWorksheetXml = (sheet: WorkbookSheet) => {
  const maxColumns = sheet.rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    1,
  )
  const dimension = `A1:${getColumnName(maxColumns)}${Math.max(sheet.rows.length, 1)}`
  const columnsXml =
    sheet.widths && sheet.widths.length
      ? `<cols>${sheet.widths
          .map(
            (width, index) =>
              `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
          )
          .join('')}</cols>`
      : ''
  const freezeXml = sheet.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${
        sheet.freezeRows
      }" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  const rowsXml = sheet.rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1
      const cellsXml = row
        .map((cell, columnIndex) =>
          buildCellXml(cell, rowNumber, columnIndex + 1, sheet),
        )
        .join('')

      return `<row r="${rowNumber}">${cellsXml}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="${dimension}"/>
${freezeXml}
${columnsXml}
<sheetData>${rowsXml}</sheetData>
</worksheet>`
}

const buildWorkbookXml = (sheetNames: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetNames
  .map(
    (name, index) =>
      `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${
        index + 1
      }"/>`,
  )
  .join('')}</sheets>
</workbook>`

const buildWorkbookRelationshipsXml = (sheetCount: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${Array.from(
  { length: sheetCount },
  (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${
      index + 1
    }.xml"/>`,
).join('')}
<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const buildContentTypesXml = (sheetCount: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${Array.from(
  { length: sheetCount },
  (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${
      index + 1
    }.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const WORKBOOK_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="&quot;&#8377;&quot;#,##0.00"/>
<numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF9D0B12"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD30A13"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFE8C3C7"/></left><right style="thin"><color rgb="FFE8C3C7"/></right><top style="thin"><color rgb="FFE8C3C7"/></top><bottom style="thin"><color rgb="FFE8C3C7"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`

const ROOT_RELATIONSHIPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const buildCorePropertiesXml = (generatedAt: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>AUTOPAL PI Intelligence Report</dc:title>
<dc:creator>AUTOPAL ERP</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(generatedAt)}</dcterms:created>
</cp:coreProperties>`

const APP_PROPERTIES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>AUTOPAL ERP</Application>
</Properties>`

const encoder = new TextEncoder()

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }

  return value >>> 0
})

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff

  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

const writeUInt16 = (view: DataView, offset: number, value: number) => {
  view.setUint16(offset, value, true)
}

const writeUInt32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value, true)
}

const concatBytes = (chunks: Uint8Array[]) => {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }

  return output
}

const getDosDateTime = () => {
  const date = new Date()
  const year = Math.max(date.getFullYear(), 1980)
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()

  return { dosDate, dosTime }
}

const createZip = (entries: Array<{ data: Uint8Array; name: string }>) => {
  const fileChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  const { dosDate, dosTime } = getDosDateTime()
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const checksum = crc32(entry.data)
    const localHeader = new Uint8Array(30)
    const localView = new DataView(localHeader.buffer)

    writeUInt32(localView, 0, 0x04034b50)
    writeUInt16(localView, 4, 20)
    writeUInt16(localView, 6, 0x0800)
    writeUInt16(localView, 8, 0)
    writeUInt16(localView, 10, dosTime)
    writeUInt16(localView, 12, dosDate)
    writeUInt32(localView, 14, checksum)
    writeUInt32(localView, 18, entry.data.length)
    writeUInt32(localView, 22, entry.data.length)
    writeUInt16(localView, 26, nameBytes.length)
    writeUInt16(localView, 28, 0)

    fileChunks.push(localHeader, nameBytes, entry.data)

    const centralHeader = new Uint8Array(46)
    const centralView = new DataView(centralHeader.buffer)

    writeUInt32(centralView, 0, 0x02014b50)
    writeUInt16(centralView, 4, 20)
    writeUInt16(centralView, 6, 20)
    writeUInt16(centralView, 8, 0x0800)
    writeUInt16(centralView, 10, 0)
    writeUInt16(centralView, 12, dosTime)
    writeUInt16(centralView, 14, dosDate)
    writeUInt32(centralView, 16, checksum)
    writeUInt32(centralView, 20, entry.data.length)
    writeUInt32(centralView, 24, entry.data.length)
    writeUInt16(centralView, 28, nameBytes.length)
    writeUInt16(centralView, 30, 0)
    writeUInt16(centralView, 32, 0)
    writeUInt16(centralView, 34, 0)
    writeUInt16(centralView, 36, 0)
    writeUInt32(centralView, 38, 0)
    writeUInt32(centralView, 42, offset)

    centralChunks.push(centralHeader, nameBytes)
    offset += localHeader.length + nameBytes.length + entry.data.length
  }

  const centralDirectory = concatBytes(centralChunks)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)

  writeUInt32(endView, 0, 0x06054b50)
  writeUInt16(endView, 4, 0)
  writeUInt16(endView, 6, 0)
  writeUInt16(endView, 8, entries.length)
  writeUInt16(endView, 10, entries.length)
  writeUInt32(endView, 12, centralDirectory.length)
  writeUInt32(endView, 16, offset)
  writeUInt16(endView, 20, 0)

  return concatBytes([...fileChunks, centralDirectory, endRecord])
}

export const createXlsxWorkbookBytes = (
  sheets: WorkbookSheet[],
  generatedAt = new Date().toISOString(),
) => {
  const sheetNames = getSafeSheetNames(sheets)
  const entries = [
    { data: encoder.encode(buildContentTypesXml(sheets.length)), name: '[Content_Types].xml' },
    { data: encoder.encode(ROOT_RELATIONSHIPS_XML), name: '_rels/.rels' },
    { data: encoder.encode(buildWorkbookXml(sheetNames)), name: 'xl/workbook.xml' },
    {
      data: encoder.encode(buildWorkbookRelationshipsXml(sheets.length)),
      name: 'xl/_rels/workbook.xml.rels',
    },
    { data: encoder.encode(WORKBOOK_STYLES_XML), name: 'xl/styles.xml' },
    { data: encoder.encode(buildCorePropertiesXml(generatedAt)), name: 'docProps/core.xml' },
    { data: encoder.encode(APP_PROPERTIES_XML), name: 'docProps/app.xml' },
    ...sheets.map((sheet, index) => ({
      data: encoder.encode(buildWorksheetXml(sheet)),
      name: `xl/worksheets/sheet${index + 1}.xml`,
    })),
  ]

  return createZip(entries)
}

export const createPIReportXlsx = (
  context: PIReportContext,
  reportType: PIReportType,
  customTitle = '',
) => {
  const generatedAt = buildGeneratedAt(context)
  const sheets = buildPIReportSheets({ ...context, generatedAt }, reportType, customTitle)
  const bytes = createXlsxWorkbookBytes(sheets, generatedAt)

  return new Blob([bytes], { type: XLSX_CONTENT_TYPE })
}

const tableToCsvRows = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
  title: string,
  table: ReportTable,
) => [
  ...getCsvMetaRows(context, resolvedType, title),
  [table.title],
  table.headers,
  ...table.rows,
  ...(table.totalRow ? [table.totalRow] : []),
  [],
]

export const createPIReportCsv = (
  context: PIReportContext,
  reportType: PIReportType,
  customTitle = '',
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)
  const title = getPIReportTitle(reportType, context, customTitle)
  const tables: ReportTable[] = []

  if (resolvedType === 'summary') {
    tables.push({
      headers: ['Metric', 'Value'],
      rows: getSummaryPlainRows(context.dashboard),
      title: 'Summary',
    })
    tables.push(getLatestPITable(context))
  } else if (resolvedType === 'trends') {
    tables.push(getTrendTable(context))
  } else if (resolvedType === 'customers') {
    tables.push(getCustomerTable(context))
  } else if (resolvedType === 'companies') {
    tables.push(getCompanyTable(context))
  } else if (resolvedType === 'search') {
    tables.push(getSearchTable(context))
  } else if (resolvedType === 'detail') {
    tables.push(getDetailHeaderTable(context), getDetailLinesTable(context))
  } else if (resolvedType === 'insight') {
    tables.push({
      headers: ['Management Insight'],
      rows: getInsightSection(context).body?.map((line) => [line]) ?? [],
      title: 'Management Insight',
    })
  } else {
    tables.push(
      {
        headers: ['Metric', 'Value'],
        rows: getSummaryPlainRows(context.dashboard),
        title: 'Summary',
      },
      getTrendTable(context),
      getCustomerTable(context),
      getCompanyTable(context),
      getLatestPITable(context),
      getSearchTable(context),
    )
  }

  const rows = tables.flatMap((table) =>
    tableToCsvRows(context, resolvedType, title, table),
  )

  return new Blob([createCsvText(rows)], { type: CSV_CONTENT_TYPE })
}

const getReportTables = (
  context: PIReportContext,
  resolvedType: Exclude<PIReportType, 'current-tab'>,
) => {
  if (resolvedType === 'summary') {
    return [
      {
        headers: ['Metric', 'Value'],
        rows: getSummaryDisplayRows(context.dashboard),
        title: 'Summary',
      },
      getLatestPITable(context),
    ]
  }

  if (resolvedType === 'trends') {
    return [getTrendTable(context)]
  }

  if (resolvedType === 'customers') {
    return [getCustomerTable(context)]
  }

  if (resolvedType === 'companies') {
    return [getCompanyTable(context)]
  }

  if (resolvedType === 'search') {
    return [getSearchTable(context)]
  }

  if (resolvedType === 'detail') {
    return [getDetailHeaderTable(context), getDetailLinesTable(context)]
  }

  if (resolvedType === 'insight') {
    return []
  }

  return [
    {
      headers: ['Metric', 'Value'],
      rows: getSummaryDisplayRows(context.dashboard),
      title: 'Summary',
    },
    getTrendTable(context),
    getCustomerTable(context),
    getCompanyTable(context),
    getLatestPITable(context),
    getSearchTable(context),
  ]
}

const tableForDisplay = (table: ReportTable): ReportTable => ({
  ...table,
  rows: table.rows.map((row) =>
    row.map((value, index) => {
      const header = table.headers[index]?.toLowerCase() ?? ''

      if (header.includes('value') || header.includes('total') || header.includes('rate') || header.includes('amount')) {
        return typeof value === 'number' ? formatINR(value) : value
      }

      if (header.includes('date')) {
        return formatReportDate(String(value))
      }

      return value
    }),
  ),
  totalRow: table.totalRow?.map((value, index) => {
    const header = table.headers[index]?.toLowerCase() ?? ''

    if (header.includes('value') || header.includes('total') || header.includes('rate') || header.includes('amount')) {
      return typeof value === 'number' ? formatINR(value) : value
    }

    return value
  }),
})

const sanitizePdfText = (value: unknown) =>
  Array.from(
    String(value ?? '')
      .replace(/\u20b9/g, 'INR ')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'"),
  )
    .map((character) => {
      const code = character.charCodeAt(0)

      return code >= 32 && code <= 126 ? character : ' '
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

const escapePdfText = (value: unknown) =>
  sanitizePdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

const wrapPdfText = (value: unknown, width: number, fontSize: number) => {
  const text = sanitizePdfText(value)
  const maxChars = Math.max(8, Math.floor(width / (fontSize * 0.52)))
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word

    if (nextLine.length <= maxChars) {
      currentLine = nextLine
    } else {
      if (currentLine) {
        lines.push(currentLine)
      }

      currentLine = word.length > maxChars ? word.slice(0, maxChars) : word
    }
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines.length ? lines : ['']
}

const appendPdfText = (
  commands: string[],
  text: unknown,
  x: number,
  y: number,
  size: number,
  bold = false,
) => {
  commands.push(
    `BT /F${bold ? 2 : 1} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(
      2,
    )} Tm (${escapePdfText(text)}) Tj ET`,
  )
}

const isWideReport = (resolvedType: Exclude<PIReportType, 'current-tab'>) =>
  ['complete', 'customers', 'companies', 'search', 'detail'].includes(resolvedType)

const createPdfBytes = ({
  context,
  resolvedType,
  sections,
  title,
}: {
  context: PIReportContext
  resolvedType: Exclude<PIReportType, 'current-tab'>
  sections: ReportSection[]
  title: string
}) => {
  const landscape = isWideReport(resolvedType)
  const pageWidth = landscape ? 841.89 : 595.28
  const pageHeight = landscape ? 595.28 : 841.89
  const margin = 34
  const usableWidth = pageWidth - margin * 2
  const bottomMargin = 48
  const pages: string[][] = []
  let commands: string[] = []
  let y = pageHeight - margin

  const newPage = () => {
    commands = []
    pages.push(commands)
    y = pageHeight - margin
    appendPdfText(commands, 'AUTOPAL', margin, y, 18, true)
    appendPdfText(commands, 'PI Intelligence Report', margin, y - 18, 12, true)
    appendPdfText(commands, title, margin, y - 38, 14, true)
    appendPdfText(
      commands,
      `Generated: ${formatReportDateTime(buildGeneratedAt(context))} | Generated by: ${
        context.generatedBy || 'AUTOPAL user'
      } | Live ERP data`,
      margin,
      y - 56,
      9,
    )
    appendPdfText(
      commands,
      `Period: ${getPeriodLabel(context, resolvedType)} | Filters: ${getAppliedFilters(
        context,
        resolvedType,
      )}`,
      margin,
      y - 70,
      8,
    )
    commands.push(`${margin} ${(y - 82).toFixed(2)} m ${(pageWidth - margin).toFixed(2)} ${(y - 82).toFixed(2)} l S`)
    y -= 104
  }

  const ensureSpace = (height: number) => {
    if (y - height < bottomMargin) {
      newPage()
    }
  }

  const drawTable = (table: ReportTable) => {
    const displayTable = tableForDisplay(table)
    const columnCount = Math.max(displayTable.headers.length, 1)
    const columnWidth = usableWidth / columnCount
    const widths = Array.from({ length: columnCount }, () => columnWidth)

    const drawRow = (row: Array<number | string>, bold = false) => {
      const wrappedCells = row.map((cell, index) =>
        wrapPdfText(cell, widths[index] - 8, bold ? 8 : 7),
      )
      const lineCount = Math.max(...wrappedCells.map((lines) => lines.length), 1)
      const rowHeight = Math.max(20, lineCount * 9 + 8)

      ensureSpace(rowHeight + 4)

      const rowBottom = y - rowHeight
      commands.push(
        `0.5 w 0.72 0.56 0.56 RG ${margin.toFixed(2)} ${rowBottom.toFixed(
          2,
        )} ${usableWidth.toFixed(2)} ${rowHeight.toFixed(2)} re S`,
      )

      let x = margin + 4
      wrappedCells.forEach((lines, index) => {
        lines.forEach((line, lineIndex) => {
          appendPdfText(commands, line, x, y - 13 - lineIndex * 9, bold ? 8 : 7, bold)
        })
        x += widths[index]
      })
      y = rowBottom
    }

    ensureSpace(52)
    appendPdfText(commands, displayTable.title, margin, y, 12, true)
    y -= 20
    drawRow(displayTable.headers, true)
    displayTable.rows.forEach((row) => drawRow(row))

    if (displayTable.totalRow) {
      drawRow(displayTable.totalRow, true)
    }

    y -= 16
  }

  newPage()

  sections.forEach((section) => {
    ensureSpace(42)

    if (section.title && !section.table) {
      appendPdfText(commands, section.title, margin, y, 12, true)
      y -= 18
    }

    if (section.body) {
      section.body.forEach((paragraph) => {
        wrapPdfText(paragraph, usableWidth, 9).forEach((line) => {
          ensureSpace(14)
          appendPdfText(commands, line, margin, y, 9)
          y -= 12
        })
        y -= 8
      })
    }

    if (section.table) {
      drawTable(section.table)
    }
  })

  pages.forEach((pageCommands, pageIndex) => {
    appendPdfText(pageCommands, 'AUTOPAL PI Intelligence', margin, 26, 8, true)
    appendPdfText(pageCommands, 'Read-only ERP Report', margin + 130, 26, 8)
    appendPdfText(
      pageCommands,
      `Page ${pageIndex + 1} of ${pages.length}`,
      pageWidth - margin - 68,
      26,
      8,
    )
  })

  const objects: string[] = []

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'

  const pageRefs: number[] = []
  let nextObject = 5

  pages.forEach((pageCommands) => {
    const stream = pageCommands.join('\n')
    const contentObject = nextObject
    nextObject += 1
    const pageObject = nextObject
    nextObject += 1

    objects[contentObject] = `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(
      2,
    )} ${pageHeight.toFixed(
      2,
    )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObject} 0 R >>`
    pageRefs.push(pageObject)
  })

  objects[2] = `<< /Type /Pages /Kids [${pageRefs
    .map((reference) => `${reference} 0 R`)
    .join(' ')}] /Count ${pageRefs.length} >>`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]

  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = encoder.encode(pdf).length
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }

  const xrefOffset = encoder.encode(pdf).length
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`

  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }

  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return encoder.encode(pdf)
}

export const createPIReportPdf = (
  context: PIReportContext,
  reportType: PIReportType,
  customTitle = '',
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)
  const title = getPIReportTitle(reportType, context, customTitle)
  const tables = getReportTables(context, resolvedType)
  const sections: ReportSection[] = [
    ...tables.map((table) => ({ table, title: table.title })),
    ...(resolvedType === 'insight' || resolvedType === 'complete'
      ? [getInsightSection(context)]
      : []),
  ]

  if (sections.length === 0) {
    sections.push({ body: ['No report data is currently loaded.'], title: 'No Data' })
  }

  return new Blob([createPdfBytes({ context, resolvedType, sections, title })], {
    type: PDF_CONTENT_TYPE,
  })
}

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const tableToHtml = (table: ReportTable) => {
  const displayTable = tableForDisplay(table)

  return `<section class="print-section"><h2>${escapeHtml(displayTable.title)}</h2><table><thead><tr>${displayTable.headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join('')}</tr></thead><tbody>${displayTable.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
    )
    .join('')}${
    displayTable.totalRow
      ? `<tr class="total-row">${displayTable.totalRow
          .map((cell) => `<td>${escapeHtml(cell)}</td>`)
          .join('')}</tr>`
      : ''
  }</tbody></table></section>`
}

export const createPIReportPrintHtml = (
  context: PIReportContext,
  reportType: PIReportType,
  customTitle = '',
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)
  const title = getPIReportTitle(reportType, context, customTitle)
  const tables = getReportTables(context, resolvedType)
  const insight = getInsightSection(context)
  const orientation = isWideReport(resolvedType) ? 'landscape' : 'portrait'
  const insightHtml =
    resolvedType === 'complete' || resolvedType === 'insight'
      ? `<section class="print-section"><h2>${escapeHtml(insight.title)}</h2>${asRows(
          insight.body,
        )
          .map((line) => `<p>${escapeHtml(line)}</p>`)
          .join('')}</section>`
      : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4 ${orientation}; margin: 12mm; }
* { box-sizing: border-box; }
body { background: #fff; color: #111827; font-family: Arial, sans-serif; margin: 0; }
header { border-bottom: 2px solid #d30a13; margin-bottom: 12px; padding-bottom: 10px; }
h1 { color: #d30a13; font-size: 22px; margin: 0 0 4px; }
h2 { color: #9d0b12; font-size: 14px; margin: 16px 0 8px; }
p, li { font-size: 10px; line-height: 1.45; }
.meta { display: grid; gap: 4px; grid-template-columns: repeat(2, 1fr); margin-top: 8px; }
.meta span { font-size: 10px; }
table { border-collapse: collapse; margin-bottom: 10px; width: 100%; }
thead { display: table-header-group; }
th, td { border: 1px solid #d9b4b7; font-size: 8.5px; padding: 5px; text-align: left; vertical-align: top; }
th { background: #d30a13; color: #fff; }
.total-row td { font-weight: 700; }
.print-section { break-inside: avoid; page-break-inside: avoid; }
footer { border-top: 1px solid #d30a13; bottom: 0; color: #7f1d1d; font-size: 9px; left: 0; padding-top: 6px; position: fixed; right: 0; }
</style>
</head>
<body>
<header>
<h1>AUTOPAL PI Intelligence</h1>
<strong>${escapeHtml(title)}</strong>
<div class="meta">
<span>Generated: ${escapeHtml(formatReportDateTime(buildGeneratedAt(context)))}</span>
<span>Generated by: ${escapeHtml(context.generatedBy || 'AUTOPAL user')}</span>
<span>Period: ${escapeHtml(getPeriodLabel(context, resolvedType))}</span>
<span>Data: Live ERP data</span>
<span>Filters: ${escapeHtml(getAppliedFilters(context, resolvedType))}</span>
</div>
</header>
${tables.map(tableToHtml).join('')}
${insightHtml}
<footer>AUTOPAL PI Intelligence - Read-only Live ERP Report</footer>
</body>
</html>`
}

export const getPIReportFilename = (
  context: PIReportContext,
  reportType: PIReportType,
  extension: string,
  customTitle = '',
) => {
  const title = getPIReportTitle(reportType, context, customTitle)
    .replace(/\bReport\b/gi, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
  const stamp = getIndiaTimestampStamp()

  return sanitizeFilename(`AUTOPAL_${title}_${stamp}`, extension)
}

export const getPIReportRowCount = (
  context: PIReportContext,
  reportType: PIReportType,
) => {
  const resolvedType = resolvePIReportType(reportType, context.activeTab)

  if (resolvedType === 'trends') {
    return limitRows(context.dashboard?.trend, MAX_TREND_EXPORT_ROWS).length
  }

  if (resolvedType === 'customers') {
    return limitRows(context.customerRows, MAX_RANKING_EXPORT_ROWS).length
  }

  if (resolvedType === 'companies') {
    return limitRows(context.companyRows, MAX_RANKING_EXPORT_ROWS).length
  }

  if (resolvedType === 'search') {
    return limitRows(context.searchRows, MAX_SEARCH_EXPORT_ROWS).length
  }

  if (resolvedType === 'detail') {
    return asRows(context.selectedDetail?.lines).length
  }

  if (resolvedType === 'complete') {
    return (
      limitRows(context.dashboard?.trend, MAX_TREND_EXPORT_ROWS).length +
      limitRows(context.customerRows, MAX_RANKING_EXPORT_ROWS).length +
      limitRows(context.companyRows, MAX_RANKING_EXPORT_ROWS).length +
      limitRows(context.dashboard?.latestPIs, 10).length +
      limitRows(context.searchRows, MAX_SEARCH_EXPORT_ROWS).length
    )
  }

  return getSummaryRows(context.dashboard).length
}

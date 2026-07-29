import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import {
  getCommercialDashboard,
  getCommercialManagementBrief,
  type CommercialBriefResponse,
  type CommercialCompanyRow,
  type CommercialCustomerRow,
  type CommercialDashboardParams,
  type CommercialDashboardResponse,
  type CommercialInactiveCustomerRow,
  type CommercialProductRow,
  type CommercialReactivatedCustomerRow,
} from '../services/aiService'
import { createXlsxWorkbookBytes } from '../services/piReportExportService'
import {
  createCsvText,
  downloadBlob,
  formatINR,
  formatReportDate,
  formatReportDateTime,
  getIndiaTimestampStamp,
  sanitizeFilename,
} from '../utils/exportUtils'

type CommercialIntelligenceDashboardProps = {
  currentUserName: string
}

type TabId =
  | 'overview'
  | 'comparison'
  | 'customers'
  | 'products'
  | 'companies'
  | 'growth'
  | 'inactive'
  | 'concentration'
  | 'brief'

type ExportScope = 'complete' | 'current-tab'
type ExportCell = number | string
type ExportColumnType = 'currency' | 'date' | 'number' | 'text'
type ExportTable = {
  headers: string[]
  rows: ExportCell[][]
  title: string
  types: ExportColumnType[]
  widths?: number[]
}
type XlsxSheet = Parameters<typeof createXlsxWorkbookBytes>[0][number]
type XlsxCell = XlsxSheet['rows'][number][number]

const COMMERCIAL_DISCLAIMER =
  'Commercial Intelligence is based on Proforma Invoice activity and does not represent completed sales, invoiced revenue, dispatch or payment.'

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'comparison', label: 'Period Comparison' },
  { id: 'customers', label: 'Customer Intelligence' },
  { id: 'products', label: 'Product Intelligence' },
  { id: 'companies', label: 'Company Intelligence' },
  { id: 'growth', label: 'Growth and Decline' },
  { id: 'inactive', label: 'Inactive and Reactivated' },
  { id: 'concentration', label: 'Concentration' },
  { id: 'brief', label: 'Commercial Brief' },
]

const periodOptions = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this-week', 'This week'],
  ['previous-week', 'Previous week'],
  ['this-month', 'This month'],
  ['previous-month', 'Previous month'],
  ['last-30-days', 'Last 30 days'],
  ['previous-30-days', 'Previous 30 days'],
  ['current-quarter', 'Current quarter'],
  ['previous-quarter', 'Previous quarter'],
  ['current-financial-year', 'Current financial year'],
  ['previous-financial-year', 'Previous financial year'],
  ['ytd', 'Year to date'],
  ['custom', 'Custom period'],
] as const

const comparisonModeOptions = [
  ['previous-equivalent', 'Previous equivalent period'],
  ['same-period-previous-year', 'Same period previous year'],
] as const

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)

  return Number.isFinite(number) ? number : 0
}

const formatCount = (value?: number | null) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(toNumber(value))

const formatPercent = (value?: number | null) =>
  value === null || value === undefined ? 'Comparison unavailable' : `${formatCount(value)}%`

const formatDateRange = (startDate?: string, endDate?: string) => {
  if (!startDate && !endDate) {
    return '-'
  }

  return `${formatReportDate(startDate)} to ${formatReportDate(endDate)}`
}

const getRows = <TRow,>(rows?: TRow[]) => (Array.isArray(rows) ? rows : [])

const getRecordNumber = (record: Record<string, unknown> | undefined, key: string) =>
  toNumber(record?.[key])

const getRecordText = (record: Record<string, unknown> | undefined, key: string) =>
  String(record?.[key] ?? '')

const getTopCustomerName = (dashboard: CommercialDashboardResponse | null) =>
  getRows(dashboard?.customerSummary?.ranking)[0]?.customerName ?? '-'

const getTopCompanyName = (dashboard: CommercialDashboardResponse | null) =>
  getRows(dashboard?.companySummary?.ranking)[0]?.companyName ?? '-'

const getDisplayValue = (value: ExportCell, type: ExportColumnType) => {
  if (type === 'currency') {
    return formatINR(value)
  }

  if (type === 'number') {
    return formatCount(Number(value))
  }

  if (type === 'date') {
    return formatReportDate(String(value))
  }

  return String(value ?? '-')
}

const tableForDisplay = (table: ExportTable) => ({
  ...table,
  rows: table.rows.map((row) =>
    row.map((value, index) => getDisplayValue(value, table.types[index] ?? 'text')),
  ),
})

const customerTable = (
  title: string,
  rows: CommercialCustomerRow[],
): ExportTable => ({
  headers: [
    'Rank',
    'Customer',
    'Current PI Count',
    'Current PI Value',
    'Previous PI Value',
    'Growth %',
    'Classification',
    'Share %',
    'Open PI Value',
    'Last PI Date',
  ],
  rows: rows.map((row, index) => [
    row.rankByPIValue ?? index + 1,
    row.customerName || '-',
    row.currentPICount ?? 0,
    row.currentPIValue ?? 0,
    row.previousPIValue ?? 0,
    row.growthPercentage ?? '',
    row.classification ?? '-',
    row.shareOfTotalPIValue ?? 0,
    row.openPIValue ?? 0,
    row.lastPIDate || '',
  ]),
  title,
  types: [
    'number',
    'text',
    'number',
    'currency',
    'currency',
    'text',
    'text',
    'number',
    'currency',
    'date',
  ],
  widths: [8, 30, 16, 18, 18, 14, 18, 12, 18, 14],
})

const productTable = (
  title: string,
  rows: CommercialProductRow[],
): ExportTable => ({
  headers: [
    'Rank',
    'Product Code',
    'Product Description',
    'PI Line Value',
    'Quantity',
    'Distinct PIs',
    'Distinct Customers',
    'Growth %',
    'Classification',
    'Share %',
    'Latest PI Date',
  ],
  rows: rows.map((row, index) => [
    row.rankByPILineValue ?? index + 1,
    row.productCode || '-',
    row.productDescription || '-',
    row.totalPILineValue ?? 0,
    row.totalQuantity ?? 0,
    row.distinctPIs ?? 0,
    row.distinctCustomers ?? 0,
    row.growthPercentage ?? '',
    row.classification ?? '-',
    row.shareOfTotalPILineValue ?? 0,
    row.latestPIDate || '',
  ]),
  title,
  types: [
    'number',
    'text',
    'text',
    'currency',
    'number',
    'number',
    'number',
    'text',
    'text',
    'number',
    'date',
  ],
  widths: [8, 18, 42, 18, 14, 14, 18, 14, 18, 12, 14],
})

const companyTable = (rows: CommercialCompanyRow[]): ExportTable => ({
  headers: [
    'Rank',
    'Company',
    'Company Code',
    'Current PI Count',
    'Current PI Value',
    'Previous PI Value',
    'Value Growth %',
    'Open PI Value',
    'Final PI Value',
    'Share %',
    'Last PI Date',
  ],
  rows: rows.map((row, index) => [
    row.rank ?? index + 1,
    row.companyName || '-',
    row.companyCode ?? '',
    row.currentPICount ?? 0,
    row.currentPIValue ?? 0,
    row.previousPIValue ?? 0,
    row.valueGrowthPercentage ?? '',
    row.openPIValue ?? 0,
    row.finalPIValue ?? 0,
    row.shareOfTotalPIValue ?? 0,
    row.lastPIDate || '',
  ]),
  title: 'Company Commercial Intelligence',
  types: [
    'number',
    'text',
    'number',
    'number',
    'currency',
    'currency',
    'text',
    'currency',
    'currency',
    'number',
    'date',
  ],
  widths: [8, 30, 12, 16, 18, 18, 14, 18, 18, 12, 14],
})

const inactiveTable = (rows: CommercialInactiveCustomerRow[]): ExportTable => ({
  headers: [
    'Customer',
    'Customer Code',
    'Last PI Date',
    'Days Inactive',
    'Historical PI Count',
    'Historical PI Value',
  ],
  rows: rows.map((row) => [
    row.customerName || '-',
    row.customerCode ?? '',
    row.lastPIDate || '',
    row.daysInactive ?? 0,
    row.historicalPICount ?? 0,
    row.historicalPIValue ?? 0,
  ]),
  title: 'Inactive Customers',
  types: ['text', 'number', 'date', 'number', 'number', 'currency'],
  widths: [30, 14, 14, 14, 18, 18],
})

const reactivatedTable = (rows: CommercialReactivatedCustomerRow[]): ExportTable => ({
  headers: [
    'Customer',
    'Customer Code',
    'Latest PI Date',
    'Latest PI Number',
    'Inactive Gap Days',
    'Latest PI Value',
    'Historical PI Count',
  ],
  rows: rows.map((row) => [
    row.customerName || '-',
    row.customerCode ?? '',
    row.latestPIDate || '',
    row.latestPINumber || '',
    row.inactiveGapDays ?? 0,
    row.latestPIValue ?? 0,
    row.historicalPICount ?? 0,
  ]),
  title: 'Reactivated Customers',
  types: ['text', 'number', 'date', 'text', 'number', 'currency', 'number'],
  widths: [30, 14, 14, 18, 16, 18, 18],
})

const buildExportTables = (
  dashboard: CommercialDashboardResponse | null,
  brief: CommercialBriefResponse | null,
  activeTab: TabId,
  scope: ExportScope,
): ExportTable[] => {
  const include = (tab: TabId) => scope === 'complete' || activeTab === tab
  const comparison = dashboard?.comparison
  const current = comparison?.current
  const previous = comparison?.previous
  const customerRows = getRows(dashboard?.customerSummary?.ranking)
  const productRows = getRows(dashboard?.productSummary?.ranking)
  const companyRows = getRows(dashboard?.companySummary?.ranking)
  const tables: ExportTable[] = []

  if (include('overview') || include('comparison')) {
    tables.push({
      headers: ['Metric', 'Current Period', 'Previous Period', 'Change'],
      rows: [
        [
          'PI Count',
          formatCount(current?.count),
          formatCount(previous?.count),
          formatPercent(comparison?.countChange?.changePercentage),
        ],
        [
          'PI Value',
          formatINR(current?.value),
          formatINR(previous?.value),
          formatPercent(comparison?.valueChange?.changePercentage),
        ],
        [
          'Average PI Value',
          formatINR(current?.averagePIValue),
          formatINR(previous?.averagePIValue),
          '',
        ],
        ['Open PI Value', formatINR(current?.openValue), '', ''],
        ['Final PI Value', formatINR(current?.finalValue), '', ''],
        ['Top Customer', getTopCustomerName(dashboard), '', ''],
        ['Top Company', getTopCompanyName(dashboard), '', ''],
        [
          'Commercial Concentration Indicator',
          getRecordText(dashboard?.concentration?.customer, 'label') || '-',
          '',
          '',
        ],
      ],
      title: 'Commercial Summary',
      types: ['text', 'text', 'text', 'text'],
      widths: [32, 24, 24, 20],
    })
  }

  if (include('customers')) {
    tables.push(customerTable('Customer Commercial Intelligence', customerRows))
  }

  if (include('products')) {
    tables.push(productTable('Product Commercial Intelligence', productRows))
  }

  if (include('companies')) {
    tables.push(companyTable(companyRows))
  }

  if (include('growth')) {
    tables.push(
      customerTable('Growing Customers', getRows(dashboard?.customerSummary?.growing)),
      customerTable('Declining Customers', getRows(dashboard?.customerSummary?.declining)),
      productTable('Growing Products', getRows(dashboard?.productSummary?.growing)),
      productTable('Declining Products', getRows(dashboard?.productSummary?.declining)),
    )
  }

  if (include('inactive')) {
    tables.push(
      inactiveTable(getRows(dashboard?.customerSummary?.inactive)),
      reactivatedTable(getRows(dashboard?.customerSummary?.reactivated)),
    )
  }

  if (include('concentration')) {
    tables.push({
      headers: ['Indicator', 'Value'],
      rows: [
        ['Top customer share', getRecordNumber(dashboard?.concentration?.customer, 'topCustomerShare')],
        ['Top 3 customer share', getRecordNumber(dashboard?.concentration?.customer, 'top3Share')],
        ['Top 5 customer share', getRecordNumber(dashboard?.concentration?.customer, 'top5Share')],
        ['Top 10 customer share', getRecordNumber(dashboard?.concentration?.customer, 'top10Share')],
        ['Top company share', getRecordNumber(dashboard?.concentration?.company, 'topCompanyShare')],
        ['Top product share', getRecordNumber(dashboard?.concentration?.product, 'topProductShare')],
        [
          'Commercial PI concentration indicator',
          getRecordText(dashboard?.concentration?.customer, 'label') || '-',
        ],
      ],
      title: 'Commercial Concentration',
      types: ['text', 'text'],
      widths: [38, 18],
    })
  }

  if (include('brief')) {
    tables.push({
      headers: ['Commercial Brief'],
      rows: [[brief?.brief || 'Commercial brief has not been generated.']],
      title: 'Commercial Management Brief',
      types: ['text'],
      widths: [90],
    })
  }

  return tables.length > 0
    ? tables
    : [
        {
          headers: ['Message'],
          rows: [['No Commercial Intelligence data is currently loaded.']],
          title: 'No Data',
          types: ['text'],
          widths: [70],
        },
      ]
}

const cell = (
  value: XlsxCell['value'],
  type: XlsxCell['type'] = 'text',
  bold = false,
): XlsxCell => ({ bold, type, value })

const tableToXlsxSheet = (
  table: ExportTable,
  generatedAt: string,
  generatedBy: string,
  periodLabel: string,
): XlsxSheet => ({
  freezeRows: 6,
  headerRows: [6],
  name: table.title,
  rows: [
    [cell('AUTOPAL Commercial Intelligence', 'text', true)],
    [cell('Generated By', 'text', true), cell(generatedBy || 'AUTOPAL user')],
    [cell('Generated At', 'text', true), cell(formatReportDateTime(generatedAt))],
    [cell('Period', 'text', true), cell(periodLabel)],
    [cell('Disclaimer', 'text', true), cell(COMMERCIAL_DISCLAIMER)],
    table.headers.map((header) => cell(header, 'text', true)),
    ...table.rows.map((row) =>
      row.map((value, index) => cell(value, table.types[index] ?? 'text')),
    ),
  ],
  widths: table.widths,
})

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

function DataTable({ table }: { table: ExportTable }) {
  const displayTable = tableForDisplay(table)

  if (displayTable.rows.length === 0) {
    return (
      <div className="empty-state pi-intelligence-empty">
        <strong>No data</strong>
        <span>No safe Commercial Intelligence rows are available.</span>
      </div>
    )
  }

  return (
    <div className="pi-intelligence-table-wrap">
      <table className="pi-intelligence-table">
        <thead>
          <tr>
            {displayTable.headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayTable.rows.map((row, rowIndex) => (
            <tr key={`${displayTable.title}-${rowIndex}`}>
              {row.map((value, columnIndex) => (
                <td
                  className={
                    displayTable.types[columnIndex] === 'currency' ||
                    displayTable.types[columnIndex] === 'number'
                      ? 'numeric'
                      : ''
                  }
                  key={`${displayTable.title}-${rowIndex}-${columnIndex}`}
                >
                  {value || '-'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MetricCard({
  accent = 'red',
  detail,
  label,
  value,
}: {
  accent?: 'red' | 'saffron'
  detail?: string
  label: string
  value: string
}) {
  return (
    <div className={`metric-card pi-intelligence-metric accent-${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}

function ShareBars({
  label,
  rows,
  valueKey,
}: {
  label: string
  rows: Array<{ name: string; value: number }>
  valueKey: string
}) {
  const maxValue = Math.max(...rows.map((row) => row.value), 0)

  if (rows.length === 0) {
    return <p className="dashboard-chart-empty">No {label.toLowerCase()} data.</p>
  }

  return (
    <div className="pi-intelligence-daily-list" aria-label={label}>
      {rows.map((row) => (
        <div className="pi-intelligence-day-row" key={`${label}-${row.name}`}>
          <div className="pi-intelligence-day-meta">
            <span>{row.name}</span>
            <strong>
              {valueKey === 'value' ? formatINR(row.value) : formatCount(row.value)}
            </strong>
          </div>
          <span className="pi-intelligence-day-track">
            <i
              className="pi-intelligence-day-fill"
              style={{
                width: maxValue > 0 ? `${Math.max((row.value / maxValue) * 100, 3)}%` : '0%',
              }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

export function CommercialIntelligenceDashboard({
  currentUserName,
}: CommercialIntelligenceDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [period, setPeriod] = useState('this-month')
  const [comparisonMode, setComparisonMode] = useState('previous-equivalent')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [dashboard, setDashboard] = useState<CommercialDashboardResponse | null>(null)
  const [brief, setBrief] = useState<CommercialBriefResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [exportMessage, setExportMessage] = useState('')
  const [exportScope, setExportScope] = useState<ExportScope>('current-tab')
  const [isBriefLoading, setIsBriefLoading] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState('')

  const requestParams = useMemo<CommercialDashboardParams>(
    () => ({
      comparisonMode,
      endDate: period === 'custom' ? customEndDate : undefined,
      period,
      startDate: period === 'custom' ? customStartDate : undefined,
    }),
    [comparisonMode, customEndDate, customStartDate, period],
  )
  const periodLabel = `${dashboard?.period?.label ?? 'Selected period'}: ${formatDateRange(
    dashboard?.period?.startDate,
    dashboard?.period?.endDate,
  )}`
  const comparisonLabel = `${
    dashboard?.comparisonPeriod?.label ?? 'Comparison period'
  }: ${formatDateRange(
    dashboard?.comparisonPeriod?.startDate,
    dashboard?.comparisonPeriod?.endDate,
  )}`
  const current = dashboard?.comparison?.current
  const previous = dashboard?.comparison?.previous
  const customerRows = getRows(dashboard?.customerSummary?.ranking)
  const productRows = getRows(dashboard?.productSummary?.ranking)
  const companyRows = getRows(dashboard?.companySummary?.ranking)
  const concentrationLabel =
    getRecordText(dashboard?.concentration?.customer, 'label') || 'Unavailable'
  const exportTables = buildExportTables(dashboard, brief, activeTab, exportScope)

  const loadDashboard = useCallback(async () => {
    if (period === 'custom' && (!customStartDate || !customEndDate)) {
      setErrorMessage('Select both start date and end date for a custom period.')
      return
    }

    setIsLoading(true)
    setErrorMessage('')
    setExportMessage('')

    try {
      const response = await getCommercialDashboard(requestParams, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'Commercial Intelligence is unavailable.')
      }

      setDashboard(response)
      setLastRefreshedAt(response.generatedAt || new Date().toISOString())
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Commercial Intelligence is unavailable.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [currentUserName, customEndDate, customStartDate, period, requestParams])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadDashboard])

  const loadBrief = async () => {
    if (period === 'custom' && (!customStartDate || !customEndDate)) {
      setErrorMessage('Select both start date and end date for a custom period.')
      return
    }

    setIsBriefLoading(true)
    setErrorMessage('')

    try {
      const response = await getCommercialManagementBrief(requestParams, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'Commercial brief is unavailable.')
      }

      setBrief(response)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Commercial brief is unavailable.',
      )
    } finally {
      setIsBriefLoading(false)
    }
  }

  const exportCsv = () => {
    const rows = exportTables.flatMap((table) => [
      [table.title],
      table.headers,
      ...tableForDisplay(table).rows,
      [],
    ])
    const blob = new Blob([createCsvText(rows)], {
      type: 'text/csv;charset=utf-8',
    })
    const filename = sanitizeFilename(
      `AUTOPAL_Commercial_Intelligence_${exportScope}_${getIndiaTimestampStamp()}`,
      'csv',
    )

    downloadBlob(blob, filename)
    setExportMessage(`${filename} generated.`)
  }

  const exportXlsx = () => {
    const generatedAt = new Date().toISOString()
    const sheets = exportTables.map((table) =>
      tableToXlsxSheet(table, generatedAt, currentUserName, periodLabel),
    )
    const bytes = createXlsxWorkbookBytes(sheets, generatedAt)
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const filename = sanitizeFilename(
      `AUTOPAL_Commercial_Intelligence_${exportScope}_${getIndiaTimestampStamp()}`,
      'xlsx',
    )

    downloadBlob(blob, filename)
    setExportMessage(`${filename} generated.`)
  }

  const printReport = () => {
    const printWindow = window.open('', '_blank')

    if (!printWindow) {
      setExportMessage('Please allow pop-ups to open the print report.')
      return
    }

    const tableHtml = exportTables
      .map((table) => {
        const displayTable = tableForDisplay(table)

        return `<section class="print-section"><h2>${escapeHtml(
          displayTable.title,
        )}</h2><table><thead><tr>${displayTable.headers
          .map((header) => `<th>${escapeHtml(header)}</th>`)
          .join('')}</tr></thead><tbody>${displayTable.rows
          .map(
            (row) =>
              `<tr>${row
                .map((value) => `<td>${escapeHtml(value || '-')}</td>`)
                .join('')}</tr>`,
          )
          .join('')}</tbody></table></section>`
      })
      .join('')

    printWindow.opener = null
    printWindow.document.open()
    printWindow.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>AUTOPAL Commercial Intelligence</title>
<style>
body { color: #171016; font-family: Arial, sans-serif; margin: 24px; }
h1 { color: #b5121b; font-size: 24px; margin: 0 0 8px; }
h2 { color: #8f0d15; font-size: 16px; margin: 18px 0 8px; }
.meta { color: #5f555b; display: grid; font-size: 12px; gap: 4px; margin-bottom: 14px; }
.disclaimer { border: 1px solid #f0b35d; border-radius: 6px; color: #7c2d12; font-size: 12px; font-weight: 700; padding: 8px; }
table { border-collapse: collapse; margin-bottom: 14px; width: 100%; }
th, td { border: 1px solid #e8c9c9; font-size: 11px; padding: 6px; text-align: left; vertical-align: top; }
th { background: #d30b16; color: #fff; }
.print-section { break-inside: avoid; page-break-inside: avoid; }
@page { margin: 14mm; size: A4 landscape; }
</style>
</head>
<body>
<h1>AUTOPAL Commercial Intelligence</h1>
<div class="meta">
<span>Generated by: ${escapeHtml(currentUserName || 'AUTOPAL user')}</span>
<span>Generated at: ${escapeHtml(formatReportDateTime(new Date().toISOString()))}</span>
<span>${escapeHtml(periodLabel)}</span>
<span>${escapeHtml(comparisonLabel)}</span>
</div>
<p class="disclaimer">${escapeHtml(COMMERCIAL_DISCLAIMER)}</p>
${tableHtml}
</body>
</html>`)
    printWindow.document.close()
    printWindow.focus()
    window.setTimeout(() => printWindow.print(), 250)
    setExportMessage('Print report opened. Use the print dialog to save as PDF.')
  }

  const customerBarRows = customerRows.slice(0, 5).map((row) => ({
    name: row.customerName || '-',
    value: row.currentPIValue ?? 0,
  }))
  const productBarRows = productRows.slice(0, 5).map((row) => ({
    name: row.productCode || '-',
    value: row.totalPILineValue ?? 0,
  }))

  return (
    <div className="page pi-intelligence-page commercial-intelligence-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Commercial Intelligence</p>
          <h1>Commercial Intelligence Dashboard</h1>
          <p className="page-subtitle">
            Read-only commercial pipeline analysis from Proforma Invoice data for
            authorised AUTOPAL users.
          </p>
        </div>
        <div className="header-actions">
          <span className="ai-live-data-pill">Live ERP data</span>
          <span className="pi-intelligence-refresh-time">
            Last refreshed: {formatReportDateTime(lastRefreshedAt)}
          </span>
          <Button disabled={isLoading} onClick={() => void loadDashboard()}>
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </header>

      <section className="pi-intelligence-period commercial-intelligence-disclaimer">
        <strong>PI-based limitation</strong>
        <span>{dashboard?.disclaimer || COMMERCIAL_DISCLAIMER}</span>
      </section>

      <section className="panel pi-intelligence-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Filters</p>
            <h2>Commercial Period</h2>
          </div>
          <Button disabled={isLoading} onClick={() => void loadDashboard()}>
            Apply Filters
          </Button>
        </div>
        <div className="pi-intelligence-filter-grid">
          <label>
            <span>Period</span>
            <select onChange={(event) => setPeriod(event.target.value)} value={period}>
              {periodOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Comparison</span>
            <select
              onChange={(event) => setComparisonMode(event.target.value)}
              value={comparisonMode}
            >
              {comparisonModeOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Start Date</span>
            <input
              disabled={period !== 'custom'}
              onChange={(event) => setCustomStartDate(event.target.value)}
              type="date"
              value={customStartDate}
            />
          </label>
          <label>
            <span>End Date</span>
            <input
              disabled={period !== 'custom'}
              onChange={(event) => setCustomEndDate(event.target.value)}
              type="date"
              value={customEndDate}
            />
          </label>
        </div>
        <div className="pi-report-export-grid commercial-export-grid">
          <label>
            <span>Export Scope</span>
            <select
              onChange={(event) => setExportScope(event.target.value as ExportScope)}
              value={exportScope}
            >
              <option value="current-tab">Current tab</option>
              <option value="complete">Complete report</option>
            </select>
          </label>
          <div className="pi-report-export-meta">
            <span>{periodLabel}</span>
            <span>{comparisonLabel}</span>
          </div>
          <div className="pi-report-export-actions">
            <Button disabled={!dashboard} onClick={exportCsv} variant="secondary">
              Export CSV
            </Button>
            <Button disabled={!dashboard} onClick={exportXlsx} variant="secondary">
              Export Excel
            </Button>
            <Button disabled={!dashboard} onClick={printReport} variant="ghost">
              Print / PDF
            </Button>
          </div>
        </div>
        {exportMessage ? (
          <p className="pi-report-export-message">{exportMessage}</p>
        ) : null}
      </section>

      {errorMessage ? (
        <section className="pi-intelligence-error" role="alert">
          <strong>Commercial Intelligence unavailable</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      <nav className="pi-intelligence-tabs" aria-label="Commercial Intelligence sections">
        {tabs.map((tab) => (
          <button
            className={activeTab === tab.id ? 'active' : ''}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {isLoading ? (
        <section className="panel pi-intelligence-state">
          Loading Commercial Intelligence dashboard...
        </section>
      ) : null}

      {activeTab === 'overview' ? (
        <>
          <section className="dashboard-grid" aria-live="polite">
            <MetricCard
              label="Current Period PI Count"
              value={formatCount(current?.count)}
            />
            <MetricCard
              accent="saffron"
              label="Current Period PI Value"
              value={formatINR(current?.value)}
            />
            <MetricCard
              label="Previous Period PI Count"
              value={formatCount(previous?.count)}
            />
            <MetricCard
              accent="saffron"
              label="Previous Period PI Value"
              value={formatINR(previous?.value)}
            />
            <MetricCard
              label="Value Change %"
              value={formatPercent(dashboard?.comparison?.valueChange?.changePercentage)}
            />
            <MetricCard
              label="Count Change %"
              value={formatPercent(dashboard?.comparison?.countChange?.changePercentage)}
            />
            <MetricCard
              accent="saffron"
              label="Average PI Value"
              value={formatINR(current?.averagePIValue)}
            />
            <MetricCard
              accent="saffron"
              label="Open PI Value"
              value={formatINR(current?.openValue)}
            />
            <MetricCard
              accent="saffron"
              label="Final PI Value"
              value={formatINR(current?.finalValue)}
            />
            <MetricCard label="Top Customer" value={getTopCustomerName(dashboard)} />
            <MetricCard label="Top Company" value={getTopCompanyName(dashboard)} />
            <MetricCard
              label="Commercial Concentration Indicator"
              value={concentrationLabel}
            />
          </section>

          <section className="pi-intelligence-content-grid">
            <section className="panel pi-intelligence-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Customer Pipeline</p>
                  <h2>Top Customers by PI Value</h2>
                </div>
              </div>
              <ShareBars label="Top Customers" rows={customerBarRows} valueKey="value" />
            </section>
            <section className="panel pi-intelligence-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Product Pipeline</p>
                  <h2>Top Products by PI Line Value</h2>
                </div>
              </div>
              <ShareBars label="Top Products" rows={productBarRows} valueKey="value" />
            </section>
          </section>
        </>
      ) : null}

      {activeTab === 'comparison' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Period Comparison</p>
              <h2>{periodLabel}</h2>
            </div>
          </div>
          <DataTable table={buildExportTables(dashboard, brief, 'comparison', 'current-tab')[0]} />
        </section>
      ) : null}

      {activeTab === 'customers' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Customer Intelligence</p>
              <h2>Customer PI Activity</h2>
            </div>
            <span className="status-pill">{formatCount(customerRows.length)} rows</span>
          </div>
          <p className="pi-intelligence-note">
            Customers are grouped by customer code where available. Prospective
            customers are grouped by PI customer name and not merged using fuzzy
            matching.
          </p>
          <DataTable table={customerTable('Customer Commercial Intelligence', customerRows)} />
        </section>
      ) : null}

      {activeTab === 'products' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Product Intelligence</p>
              <h2>Product PI Line Activity</h2>
            </div>
            <span className="status-pill">{formatCount(productRows.length)} rows</span>
          </div>
          <p className="pi-intelligence-note">
            Product analytics use PI line value. The product link is based on
            matching PI product code to master product code.
          </p>
          <DataTable table={productTable('Product Commercial Intelligence', productRows)} />
        </section>
      ) : null}

      {activeTab === 'companies' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Company Intelligence</p>
              <h2>Company-wise PI Activity</h2>
            </div>
          </div>
          <DataTable table={companyTable(companyRows)} />
        </section>
      ) : null}

      {activeTab === 'growth' ? (
        <section className="dashboard-chart-grid pi-intelligence-chart-grid">
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Customers</p>
                <h2>Growing Customers</h2>
              </div>
            </div>
            <DataTable
              table={customerTable('Growing Customers', getRows(dashboard?.customerSummary?.growing))}
            />
          </section>
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Customers</p>
                <h2>Declining Customers</h2>
              </div>
            </div>
            <DataTable
              table={customerTable(
                'Declining Customers',
                getRows(dashboard?.customerSummary?.declining),
              )}
            />
          </section>
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Products</p>
                <h2>Growing Products</h2>
              </div>
            </div>
            <DataTable
              table={productTable('Growing Products', getRows(dashboard?.productSummary?.growing))}
            />
          </section>
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Products</p>
                <h2>Declining Products</h2>
              </div>
            </div>
            <DataTable
              table={productTable(
                'Declining Products',
                getRows(dashboard?.productSummary?.declining),
              )}
            />
          </section>
        </section>
      ) : null}

      {activeTab === 'inactive' ? (
        <section className="dashboard-chart-grid pi-intelligence-chart-grid">
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">90 Day Window</p>
                <h2>Inactive Customers</h2>
              </div>
            </div>
            <p className="pi-intelligence-note">
              No PI activity recorded during the selected period.
            </p>
            <DataTable table={inactiveTable(getRows(dashboard?.customerSummary?.inactive))} />
          </section>
          <section className="panel pi-intelligence-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">90 Day Window</p>
                <h2>Reactivated Customers</h2>
              </div>
            </div>
            <DataTable
              table={reactivatedTable(getRows(dashboard?.customerSummary?.reactivated))}
            />
          </section>
        </section>
      ) : null}

      {activeTab === 'concentration' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Indicator</p>
              <h2>Commercial PI Concentration</h2>
            </div>
          </div>
          <p className="pi-intelligence-note">
            This indicator is based only on Proforma Invoice activity and is not a
            credit-risk assessment.
          </p>
          <DataTable table={buildExportTables(dashboard, brief, 'concentration', 'current-tab')[0]} />
        </section>
      ) : null}

      {activeTab === 'brief' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Verified Brief</p>
              <h2>Commercial Management Brief</h2>
            </div>
            <Button disabled={isBriefLoading} onClick={() => void loadBrief()}>
              {isBriefLoading ? 'Creating...' : 'Generate Brief'}
            </Button>
          </div>
          <div className="ai-answer-content pi-intelligence-insight">
            {brief?.brief || 'Generate a commercial brief from verified PI data.'}
          </div>
          <div className="ai-erp-source">
            <span>
              {brief?.wordingMode === 'ollama' ? 'Ollama wording' : 'Server fallback ready'}
            </span>
            <span>{formatReportDateTime(brief?.generatedAt)}</span>
          </div>
        </section>
      ) : null}

      <section className="pi-intelligence-period commercial-intelligence-disclaimer">
        <strong>Data quality</strong>
        <span>
          {dashboard?.productDataQuality
            ? Object.values(dashboard.productDataQuality).join(' ')
            : 'Product data quality details will appear after the dashboard loads.'}
        </span>
      </section>

      <section className="pi-intelligence-note">
        Recommended indexes only, not created automatically: active PI date,
        customer code, company code, PI number and PI product code.
      </section>
    </div>
  )
}

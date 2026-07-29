import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Button } from '../components/ui/Button'
import {
  askExecutiveQuestion,
  getExecutiveBrief,
  getExecutiveCockpit,
  type CommercialCompanyRow,
  type CommercialCustomerRow,
  type CommercialDashboardParams,
  type CommercialInactiveCustomerRow,
  type CommercialProductRow,
  type CommercialReactivatedCustomerRow,
  type ExecutiveAlert,
  type ExecutiveBriefResponse,
  type ExecutiveCockpitResponse,
  type ExecutiveTrendRow,
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

type ExecutiveAICockpitProps = {
  currentUserName: string
}

type ExportScope = 'complete' | 'current-view'
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

type SpeechRecognitionEventLike = {
  results: {
    [index: number]: {
      [index: number]: {
        transcript?: string
      }
    }
    length: number
  }
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

const EXECUTIVE_DISCLAIMER =
  'Based on Proforma Invoice activity only; not completed sales, invoiced revenue, dispatch or payment.'

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
  ['custom', 'Custom period'],
] as const

const comparisonModeOptions = [
  ['previous-equivalent', 'Previous equivalent period'],
  ['same-period-previous-year', 'Same period previous year'],
] as const

const quickPrompts = [
  "Give me today's executive summary",
  'Compare this month with last month',
  'Which customer contributes the most PI value?',
  'Which product has the highest PI line value?',
  'Which company has the highest PI activity?',
  'Show important commercial alerts',
  'Show inactive customers',
  'Show reactivated customers',
  'Show current PI concentration',
  'Give me a management brief',
]

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)

  return Number.isFinite(number) ? number : 0
}

const formatCount = (value?: number | null) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(toNumber(value))

const formatPercent = (value?: number | null) =>
  value === null || value === undefined ? 'Unavailable' : `${formatCount(value)}%`

const formatDateRange = (startDate?: string, endDate?: string) => {
  if (!startDate && !endDate) {
    return '-'
  }

  return `${formatReportDate(startDate)} to ${formatReportDate(endDate)}`
}

const getRows = <TRow,>(rows?: TRow[]) => (Array.isArray(rows) ? rows : [])

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

const kpiTable = (cockpit: ExecutiveCockpitResponse | null): ExportTable => {
  const kpis = cockpit?.kpis ?? {}

  return {
    headers: ['KPI', 'Value'],
    rows: [
      ['Today PI Count', kpis.todayPICount ?? 0],
      ['Today PI Value', kpis.todayPIValue ?? 0],
      ['Yesterday PI Count', kpis.yesterdayPICount ?? 0],
      ['Yesterday PI Value', kpis.yesterdayPIValue ?? 0],
      ['This Week PI Count', kpis.thisWeekPICount ?? 0],
      ['This Week PI Value', kpis.thisWeekPIValue ?? 0],
      ['This Month PI Count', kpis.thisMonthPICount ?? 0],
      ['This Month PI Value', kpis.thisMonthPIValue ?? 0],
      ['Previous Month PI Count', kpis.previousMonthPICount ?? 0],
      ['Previous Month PI Value', kpis.previousMonthPIValue ?? 0],
      ['Monthly Count Change %', kpis.monthlyCountChangePercentage ?? 'Unavailable'],
      ['Monthly Value Change %', kpis.monthlyValueChangePercentage ?? 'Unavailable'],
      ['Average PI Value', kpis.averagePIValue ?? 0],
      ['Highest PI Value', kpis.highestPIValue ?? 0],
      ['Lowest PI Value', kpis.lowestPIValue ?? 0],
      ['Open PI Count', kpis.openPICount ?? 0],
      ['Open PI Value', kpis.openPIValue ?? 0],
      ['Final PI Count', kpis.finalPICount ?? 0],
      ['Final PI Value', kpis.finalPIValue ?? 0],
      ['Open Percentage', kpis.openPercentage ?? 0],
      ['Final Percentage', kpis.finalPercentage ?? 0],
      ['Average Daily PI Count', kpis.averageDailyPICount ?? 0],
      ['Average Daily PI Value', kpis.averageDailyPIValue ?? 0],
      ['Top Customer', kpis.topCustomer || '-'],
      ['Top Customer PI Value', kpis.topCustomerPIValue ?? 0],
      ['Top Customer Share %', kpis.topCustomerSharePercentage ?? 0],
      ['Top Product', kpis.topProduct || '-'],
      ['Top Product PI Line Value', kpis.topProductPILineValue ?? 0],
      ['Top Company', kpis.topCompany || '-'],
      ['Top Company PI Value', kpis.topCompanyPIValue ?? 0],
      ['Commercial Concentration Label', kpis.commercialConcentrationLabel || '-'],
    ],
    title: 'Executive KPI Detail',
    types: ['text', 'text'],
    widths: [36, 28],
  }
}

const trendTable = (rows: ExecutiveTrendRow[]): ExportTable => ({
  headers: ['Date', 'PI Count', 'PI Value'],
  rows: rows.map((row) => [row.date, row.count, row.value]),
  title: 'Daily PI Trend',
  types: ['date', 'number', 'currency'],
  widths: [16, 14, 18],
})

const customerTable = (rows: CommercialCustomerRow[]): ExportTable => ({
  headers: ['Rank', 'Customer', 'PI Count', 'PI Value', 'Share %', 'Classification'],
  rows: rows.map((row, index) => [
    row.rankByPIValue ?? index + 1,
    row.customerName || '-',
    row.currentPICount ?? 0,
    row.currentPIValue ?? 0,
    row.shareOfTotalPIValue ?? 0,
    row.classification ?? '-',
  ]),
  title: 'Customer Contribution',
  types: ['number', 'text', 'number', 'currency', 'number', 'text'],
  widths: [8, 32, 14, 18, 12, 18],
})

const productTable = (rows: CommercialProductRow[]): ExportTable => ({
  headers: ['Rank', 'Product Code', 'Product', 'PI Line Value', 'Quantity', 'Share %'],
  rows: rows.map((row, index) => [
    row.rankByPILineValue ?? index + 1,
    row.productCode || '-',
    row.productDescription || '-',
    row.totalPILineValue ?? 0,
    row.totalQuantity ?? 0,
    row.shareOfTotalPILineValue ?? 0,
  ]),
  title: 'Product Contribution',
  types: ['number', 'text', 'text', 'currency', 'number', 'number'],
  widths: [8, 18, 42, 18, 14, 12],
})

const companyTable = (rows: CommercialCompanyRow[]): ExportTable => ({
  headers: ['Rank', 'Company', 'PI Count', 'PI Value', 'Share %'],
  rows: rows.map((row, index) => [
    row.rank ?? index + 1,
    row.companyName || '-',
    row.currentPICount ?? 0,
    row.currentPIValue ?? 0,
    row.shareOfTotalPIValue ?? 0,
  ]),
  title: 'Company Contribution',
  types: ['number', 'text', 'number', 'currency', 'number'],
  widths: [8, 34, 14, 18, 12],
})

const alertsTable = (rows: ExecutiveAlert[]): ExportTable => ({
  headers: ['Severity', 'Type', 'Message'],
  rows: rows.map((row) => [row.severity, row.type, row.message]),
  title: 'Executive Alerts',
  types: ['text', 'text', 'text'],
  widths: [14, 28, 70],
})

const activityTable = (
  inactiveRows: CommercialInactiveCustomerRow[],
  reactivatedRows: CommercialReactivatedCustomerRow[],
): ExportTable => ({
  headers: ['Type', 'Customer', 'Days / Gap', 'Latest / Last PI Date', 'PI Value'],
  rows: [
    ...inactiveRows.map((row) => [
      'Inactive',
      row.customerName || '-',
      row.daysInactive ?? 0,
      row.lastPIDate || '',
      row.historicalPIValue ?? 0,
    ]),
    ...reactivatedRows.map((row) => [
      'Reactivated',
      row.customerName || '-',
      row.inactiveGapDays ?? 0,
      row.latestPIDate || '',
      row.latestPIValue ?? 0,
    ]),
  ],
  title: 'Customer Activity',
  types: ['text', 'text', 'number', 'date', 'currency'],
  widths: [16, 34, 14, 18, 18],
})

const briefTable = (brief: ExecutiveBriefResponse | null): ExportTable => ({
  headers: ['Executive Brief'],
  rows: [[brief?.brief || 'Executive brief has not been generated.']],
  title: 'Executive Brief',
  types: ['text'],
  widths: [100],
})

const buildExportTables = (
  cockpit: ExecutiveCockpitResponse | null,
  brief: ExecutiveBriefResponse | null,
): ExportTable[] => [
  kpiTable(cockpit),
  trendTable(getRows(cockpit?.trend)),
  customerTable(getRows(cockpit?.customerHighlights?.rows)),
  productTable(getRows(cockpit?.productHighlights?.rows)),
  companyTable(getRows(cockpit?.companyHighlights?.rows)),
  alertsTable(getRows(cockpit?.alerts)),
  activityTable(
    getRows(cockpit?.activityHighlights?.inactiveCustomers),
    getRows(cockpit?.activityHighlights?.reactivatedCustomers),
  ),
  briefTable(brief),
]

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
    [cell('AUTOPAL Executive AI Cockpit', 'text', true)],
    [cell('Generated By', 'text', true), cell(generatedBy || 'AUTOPAL user')],
    [cell('Generated At', 'text', true), cell(formatReportDateTime(generatedAt))],
    [cell('Period', 'text', true), cell(periodLabel)],
    [cell('Disclaimer', 'text', true), cell(EXECUTIVE_DISCLAIMER)],
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
        <span>No executive rows are available for this section.</span>
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

function KpiCard({
  label,
  tone = 'red',
  value,
}: {
  label: string
  tone?: 'red' | 'saffron'
  value: string
}) {
  return (
    <div className={`metric-card pi-intelligence-metric accent-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function BarList({
  currency = false,
  rows,
  title,
}: {
  currency?: boolean
  rows: Array<{ label: string; value: number }>
  title: string
}) {
  const maxValue = Math.max(...rows.map((row) => row.value), 0)

  if (rows.length === 0) {
    return <p className="dashboard-chart-empty">No {title.toLowerCase()} data.</p>
  }

  return (
    <div className="pi-intelligence-daily-list" aria-label={title}>
      {rows.map((row) => (
        <div className="pi-intelligence-day-row" key={`${title}-${row.label}`}>
          <div className="pi-intelligence-day-meta">
            <span>{row.label}</span>
            <strong>{currency ? formatINR(row.value) : formatCount(row.value)}</strong>
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

export function ExecutiveAICockpit({ currentUserName }: ExecutiveAICockpitProps) {
  const [period, setPeriod] = useState('this-month')
  const [comparisonMode, setComparisonMode] = useState('previous-equivalent')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [cockpit, setCockpit] = useState<ExecutiveCockpitResponse | null>(null)
  const [brief, setBrief] = useState<ExecutiveBriefResponse | null>(null)
  const [question, setQuestion] = useState('')
  const [questionAnswer, setQuestionAnswer] = useState('')
  const [voiceMessage, setVoiceMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [exportMessage, setExportMessage] = useState('')
  const [exportScope, setExportScope] = useState<ExportScope>('current-view')
  const [isBriefLoading, setIsBriefLoading] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isQuestionLoading, setIsQuestionLoading] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const SpeechRecognition =
    typeof window === 'undefined'
      ? undefined
      : window.SpeechRecognition ?? window.webkitSpeechRecognition
  const isVoiceSupported = Boolean(SpeechRecognition)
  const requestParams = useMemo<CommercialDashboardParams>(
    () => ({
      comparisonMode,
      endDate: period === 'custom' ? customEndDate : undefined,
      period,
      startDate: period === 'custom' ? customStartDate : undefined,
    }),
    [comparisonMode, customEndDate, customStartDate, period],
  )
  const periodLabel = `${cockpit?.period?.label ?? 'Selected period'}: ${formatDateRange(
    cockpit?.period?.startDate,
    cockpit?.period?.endDate,
  )}`
  const comparisonLabel = `${
    cockpit?.comparisonPeriod?.label ?? 'Comparison period'
  }: ${formatDateRange(
    cockpit?.comparisonPeriod?.startDate,
    cockpit?.comparisonPeriod?.endDate,
  )}`
  const kpis = cockpit?.kpis ?? {}
  const exportTables = buildExportTables(cockpit, brief)
  const visibleExportTables =
    exportScope === 'complete'
      ? exportTables
      : exportTables.filter((table) => table.title !== 'Executive Brief' || brief)
  const customerRows = getRows(cockpit?.customerHighlights?.rows)
  const productRows = getRows(cockpit?.productHighlights?.rows)
  const companyRows = getRows(cockpit?.companyHighlights?.rows)
  const trendRows = getRows(cockpit?.trend)
  const alerts = getRows(cockpit?.alerts)
  const customerStatusCounts = cockpit?.growthHighlights?.customerStatusCounts ?? {}

  const loadCockpit = useCallback(async () => {
    if (period === 'custom' && (!customStartDate || !customEndDate)) {
      setErrorMessage('Select both start date and end date for a custom period.')
      return
    }

    setIsLoading(true)
    setErrorMessage('')
    setExportMessage('')

    try {
      const response = await getExecutiveCockpit(requestParams, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'Executive AI Cockpit is unavailable.')
      }

      setCockpit(response)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Executive AI Cockpit is unavailable.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [currentUserName, customEndDate, customStartDate, period, requestParams])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCockpit()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadCockpit])

  useEffect(
    () => () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    },
    [],
  )

  const loadBrief = async () => {
    setIsBriefLoading(true)
    setErrorMessage('')

    try {
      const response = await getExecutiveBrief(requestParams, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'Executive brief is unavailable.')
      }

      setBrief(response)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Executive brief is unavailable.',
      )
    } finally {
      setIsBriefLoading(false)
    }
  }

  const askQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedQuestion = question.trim()

    if (!trimmedQuestion) {
      setQuestionAnswer('Enter an executive question or use a quick prompt.')
      return
    }

    setIsQuestionLoading(true)
    setQuestionAnswer('')
    setErrorMessage('')

    try {
      const response = await askExecutiveQuestion(trimmedQuestion, requestParams, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'Executive question could not be answered.')
      }

      setQuestionAnswer(response.answer || 'No answer text was returned.')
    } catch (error) {
      setQuestionAnswer(
        error instanceof Error
          ? error.message
          : 'Executive question could not be answered.',
      )
    } finally {
      setIsQuestionLoading(false)
    }
  }

  const startVoiceInput = () => {
    if (!SpeechRecognition || isListening) {
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-IN'
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length })
        .map((_, index) => event.results[index]?.[0]?.transcript ?? '')
        .join(' ')
        .trim()

      if (transcript) {
        setQuestion(transcript)
        setVoiceMessage('Voice text captured. Review it, then press Ask.')
      }
    }
    recognition.onerror = (event) => {
      setVoiceMessage(
        event.error
          ? `Voice input stopped: ${event.error}.`
          : 'Voice input could not be captured.',
      )
      setIsListening(false)
    }
    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    setIsListening(true)
    setVoiceMessage('Listening...')
    recognition.start()
  }

  const stopVoiceInput = () => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  const exportCsv = () => {
    const rows = visibleExportTables.flatMap((table) => [
      [table.title],
      table.headers,
      ...tableForDisplay(table).rows,
      [],
    ])
    const blob = new Blob([createCsvText(rows)], {
      type: 'text/csv;charset=utf-8',
    })
    const filename = sanitizeFilename(
      `AUTOPAL_Executive_Cockpit_${exportScope}_${getIndiaTimestampStamp()}`,
      'csv',
    )

    downloadBlob(blob, filename)
    setExportMessage(`${filename} generated.`)
  }

  const exportXlsx = () => {
    const generatedAt = new Date().toISOString()
    const sheets = visibleExportTables.map((table) =>
      tableToXlsxSheet(table, generatedAt, currentUserName, periodLabel),
    )
    const bytes = createXlsxWorkbookBytes(sheets, generatedAt)
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const filename = sanitizeFilename(
      `AUTOPAL_Executive_Cockpit_${exportScope}_${getIndiaTimestampStamp()}`,
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

    const tableHtml = visibleExportTables
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
<title>AUTOPAL Executive AI Cockpit</title>
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
<h1>AUTOPAL Executive AI Cockpit</h1>
<div class="meta">
<span>Generated by: ${escapeHtml(currentUserName || 'AUTOPAL user')}</span>
<span>Generated at: ${escapeHtml(formatReportDateTime(new Date().toISOString()))}</span>
<span>${escapeHtml(periodLabel)}</span>
<span>${escapeHtml(comparisonLabel)}</span>
<span>Live ERP data</span>
</div>
<p class="disclaimer">${escapeHtml(EXECUTIVE_DISCLAIMER)}</p>
${tableHtml}
</body>
</html>`)
    printWindow.document.close()
    printWindow.focus()
    window.setTimeout(() => printWindow.print(), 250)
    setExportMessage('Print report opened. Use the print dialog to save as PDF.')
  }

  return (
    <div className="page pi-intelligence-page executive-cockpit-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Executive AI Cockpit</p>
          <h1>AUTOPAL Executive AI Cockpit</h1>
          <p className="page-subtitle">
            Management-level read-only cockpit combining PI Intelligence and
            Commercial Intelligence.
          </p>
        </div>
        <div className="header-actions">
          <span className="ai-live-data-pill">Live ERP data</span>
          <span className="status-pill">
            AI {brief?.wordingMode === 'ollama' ? 'Ready' : brief ? 'Fallback' : 'Ready'}
          </span>
          <span className="pi-intelligence-refresh-time">
            Last refreshed: {formatReportDateTime(cockpit?.generatedAt)}
          </span>
          <Button disabled={isLoading} onClick={() => void loadCockpit()}>
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </header>

      <section className="pi-intelligence-period executive-disclaimer">
        <strong>PI-based limitation</strong>
        <span>{cockpit?.disclaimer || EXECUTIVE_DISCLAIMER}</span>
      </section>

      <section className="panel pi-intelligence-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Filters</p>
            <h2>Executive Reporting Period</h2>
          </div>
          <Button disabled={isLoading} onClick={() => void loadCockpit()}>
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
      </section>

      {errorMessage ? (
        <section className="pi-intelligence-error" role="alert">
          <strong>Executive Cockpit unavailable</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      {isLoading ? (
        <section className="panel pi-intelligence-state">
          Loading Executive AI Cockpit...
        </section>
      ) : null}

      <section className="dashboard-grid executive-kpi-grid">
        <KpiCard label="Today PI Count" value={formatCount(kpis.todayPICount)} />
        <KpiCard tone="saffron" label="Today PI Value" value={formatINR(kpis.todayPIValue)} />
        <KpiCard label="Yesterday PI Count" value={formatCount(kpis.yesterdayPICount)} />
        <KpiCard
          tone="saffron"
          label="Yesterday PI Value"
          value={formatINR(kpis.yesterdayPIValue)}
        />
        <KpiCard label="This Week PI Count" value={formatCount(kpis.thisWeekPICount)} />
        <KpiCard
          tone="saffron"
          label="This Week PI Value"
          value={formatINR(kpis.thisWeekPIValue)}
        />
        <KpiCard label="This Month PI Count" value={formatCount(kpis.thisMonthPICount)} />
        <KpiCard
          tone="saffron"
          label="This Month PI Value"
          value={formatINR(kpis.thisMonthPIValue)}
        />
        <KpiCard
          label="Previous Month PI Count"
          value={formatCount(kpis.previousMonthPICount)}
        />
        <KpiCard
          tone="saffron"
          label="Previous Month PI Value"
          value={formatINR(kpis.previousMonthPIValue)}
        />
        <KpiCard
          label="Monthly Count Change"
          value={formatPercent(kpis.monthlyCountChangePercentage)}
        />
        <KpiCard
          label="Monthly Value Change"
          value={formatPercent(kpis.monthlyValueChangePercentage)}
        />
        <KpiCard tone="saffron" label="Average PI Value" value={formatINR(kpis.averagePIValue)} />
        <KpiCard tone="saffron" label="Highest PI Value" value={formatINR(kpis.highestPIValue)} />
        <KpiCard tone="saffron" label="Lowest PI Value" value={formatINR(kpis.lowestPIValue)} />
        <KpiCard label="Open PI Count" value={formatCount(kpis.openPICount)} />
        <KpiCard tone="saffron" label="Open PI Value" value={formatINR(kpis.openPIValue)} />
        <KpiCard label="Final PI Count" value={formatCount(kpis.finalPICount)} />
        <KpiCard tone="saffron" label="Final PI Value" value={formatINR(kpis.finalPIValue)} />
        <KpiCard label="Open Percentage" value={formatPercent(kpis.openPercentage)} />
        <KpiCard label="Final Percentage" value={formatPercent(kpis.finalPercentage)} />
        <KpiCard
          label="Average Daily PI Count"
          value={formatCount(kpis.averageDailyPICount)}
        />
        <KpiCard
          tone="saffron"
          label="Average Daily PI Value"
          value={formatINR(kpis.averageDailyPIValue)}
        />
        <KpiCard label="Top Customer" value={kpis.topCustomer || '-'} />
        <KpiCard
          tone="saffron"
          label="Top Customer PI Value"
          value={formatINR(kpis.topCustomerPIValue)}
        />
        <KpiCard
          label="Top Customer Share"
          value={formatPercent(kpis.topCustomerSharePercentage)}
        />
        <KpiCard label="Top Product" value={kpis.topProduct || '-'} />
        <KpiCard
          tone="saffron"
          label="Top Product PI Line Value"
          value={formatINR(kpis.topProductPILineValue)}
        />
        <KpiCard label="Top Company" value={kpis.topCompany || '-'} />
        <KpiCard
          tone="saffron"
          label="Top Company PI Value"
          value={formatINR(kpis.topCompanyPIValue)}
        />
        <KpiCard
          label="Commercial Concentration"
          value={kpis.commercialConcentrationLabel || '-'}
        />
      </section>

      <section className="pi-intelligence-content-grid">
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Executive Brief</p>
              <h2>AI-generated Executive Summary</h2>
            </div>
            <Button disabled={isBriefLoading} onClick={() => void loadBrief()}>
              {isBriefLoading ? 'Creating...' : 'Generate Brief'}
            </Button>
          </div>
          <div className="ai-answer-content pi-intelligence-insight">
            {brief?.brief || 'Generate an executive brief from verified PI data.'}
          </div>
          <div className="ai-erp-source">
            <span>{brief?.wordingMode === 'ollama' ? 'AI Ready' : 'Server fallback'}</span>
            <span>{formatReportDateTime(brief?.generatedAt)}</span>
          </div>
        </section>

        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Alerts</p>
              <h2>Deterministic Alerts</h2>
            </div>
            <span className="status-pill">{formatCount(alerts.length)} alerts</span>
          </div>
          <div className="executive-alert-list">
            {alerts.length > 0 ? (
              alerts.map((alert, index) => (
                <div className={`executive-alert ${alert.severity}`} key={`${alert.type}-${index}`}>
                  <span>{alert.severity}</span>
                  <strong>{alert.message}</strong>
                </div>
              ))
            ) : (
              <p className="dashboard-chart-empty">
                No deterministic executive alerts are active.
              </p>
            )}
          </div>
        </section>
      </section>

      <section className="dashboard-chart-grid pi-intelligence-chart-grid">
        <section className="panel dashboard-chart-card">
          <div className="dashboard-chart-head">
            <h2>Daily PI Count Trend</h2>
          </div>
          <BarList
            rows={trendRows.map((row) => ({ label: formatReportDate(row.date), value: row.count }))}
            title="Daily PI Count Trend"
          />
        </section>
        <section className="panel dashboard-chart-card">
          <div className="dashboard-chart-head">
            <h2>Daily PI Value Trend</h2>
          </div>
          <BarList
            currency
            rows={trendRows.map((row) => ({ label: formatReportDate(row.date), value: row.value }))}
            title="Daily PI Value Trend"
          />
        </section>
        <section className="panel dashboard-chart-card">
          <div className="dashboard-chart-head">
            <h2>Current Month versus Previous Month</h2>
          </div>
          <BarList
            currency
            rows={[
              { label: 'This Month', value: kpis.thisMonthPIValue ?? 0 },
              { label: 'Previous Month', value: kpis.previousMonthPIValue ?? 0 },
            ]}
            title="Current Month versus Previous Month"
          />
        </section>
        <section className="panel dashboard-chart-card">
          <div className="dashboard-chart-head">
            <h2>Open versus Final</h2>
          </div>
          <BarList
            rows={[
              { label: 'Open', value: kpis.openPercentage ?? 0 },
              { label: 'Final', value: kpis.finalPercentage ?? 0 },
            ]}
            title="Open versus Final"
          />
        </section>
      </section>

      <section className="dashboard-chart-grid pi-intelligence-chart-grid">
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Customer Contribution</p>
              <h2>Top Customers by PI Value</h2>
            </div>
          </div>
          <DataTable table={customerTable(customerRows)} />
        </section>
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Product Contribution</p>
              <h2>Top Products by PI Line Value</h2>
            </div>
          </div>
          <DataTable table={productTable(productRows)} />
        </section>
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Company Contribution</p>
              <h2>Company-wise PI Value</h2>
            </div>
          </div>
          <DataTable table={companyTable(companyRows)} />
        </section>
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Customer Status</p>
              <h2>Growth and Activity</h2>
            </div>
          </div>
          <BarList
            rows={Object.entries(customerStatusCounts).map(([label, value]) => ({
              label,
              value: Number(value ?? 0),
            }))}
            title="Customer Status"
          />
        </section>
      </section>

      <section className="panel pi-intelligence-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Quick Executive Questions</p>
            <h2>Ask the Cockpit</h2>
          </div>
        </div>
        <div className="ai-suggested-prompts executive-prompt-list">
          {quickPrompts.map((prompt) => (
            <button
              disabled={isQuestionLoading}
              key={prompt}
              onClick={() => setQuestion(prompt)}
              type="button"
            >
              {prompt}
            </button>
          ))}
        </div>
        <form className="executive-question-form" onSubmit={askQuestion}>
          <textarea
            className="field-control textarea-control"
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask an approved executive cockpit question."
            rows={4}
            value={question}
          />
          <div className="pi-report-export-actions">
            <Button disabled={isQuestionLoading || !question.trim()} type="submit">
              {isQuestionLoading ? 'Asking...' : 'Ask'}
            </Button>
            {isVoiceSupported ? (
              <Button
                disabled={isQuestionLoading}
                onClick={isListening ? stopVoiceInput : startVoiceInput}
                variant="secondary"
              >
                {isListening ? 'Stop Voice' : 'Voice Input'}
              </Button>
            ) : (
              <Button disabled variant="secondary">
                Voice Unsupported
              </Button>
            )}
          </div>
        </form>
        {voiceMessage ? <p className="ai-voice-message">{voiceMessage}</p> : null}
        {questionAnswer ? (
          <div className="ai-answer-content executive-question-answer">
            {questionAnswer}
          </div>
        ) : null}
      </section>

      <section className="panel pi-intelligence-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Export and Print</p>
            <h2>Executive Report</h2>
          </div>
        </div>
        <div className="pi-report-export-grid executive-export-grid">
          <label>
            <span>Scope</span>
            <select
              onChange={(event) => setExportScope(event.target.value as ExportScope)}
              value={exportScope}
            >
              <option value="current-view">Current view</option>
              <option value="complete">Complete executive report</option>
            </select>
          </label>
          <div className="pi-report-export-meta">
            <span>{periodLabel}</span>
            <span>{comparisonLabel}</span>
          </div>
          <div className="pi-report-export-actions">
            <Button disabled={!cockpit} onClick={exportCsv} variant="secondary">
              Export CSV
            </Button>
            <Button disabled={!cockpit} onClick={exportXlsx} variant="secondary">
              Export Excel
            </Button>
            <Button disabled={!cockpit} onClick={printReport} variant="ghost">
              Print / PDF
            </Button>
          </div>
        </div>
        {exportMessage ? (
          <p className="pi-report-export-message">{exportMessage}</p>
        ) : null}
      </section>

      <section className="pi-intelligence-period executive-disclaimer">
        <strong>Data quality</strong>
        <span>
          Product contribution uses verified PI line product-code linkage where
          available. Recommended indexes are reporting-only suggestions and were
          not created automatically.
        </span>
      </section>
    </div>
  )
}

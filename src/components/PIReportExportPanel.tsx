import { useMemo, useState } from 'react'
import { createPIReportCsv, createPIReportPdf, createPIReportPrintHtml, createPIReportXlsx, getPIReportFilename, getPIReportRowCount, getPIReportTitle, type PIReportContext, type PIReportDashboardTab, type PIReportType } from '../services/piReportExportService'
import type {
  PIDetailResponse,
  PIIntelligenceLatestPI,
  PIIntelligenceProDashboardResponse,
  PIIntelligenceRankingRow,
  PIManagementInsightResponse,
  PISearchFilters,
} from '../services/aiService'
import { Button } from './ui/Button'
import { downloadBlob, formatReportDateTime } from '../utils/exportUtils'

type PIReportExportPanelProps = {
  activeTab: PIReportDashboardTab
  companyRows: PIIntelligenceRankingRow[]
  customerRows: PIIntelligenceRankingRow[]
  customEndDate?: string
  customStartDate?: string
  dashboard: PIIntelligenceProDashboardResponse | null
  generatedBy: string
  insight: PIManagementInsightResponse | null
  lastRefreshedAt?: string
  rankingLimit?: number
  rankingPeriod?: string
  searchFilters: PISearchFilters
  searchRows: PIIntelligenceLatestPI[]
  selectedDetail: PIDetailResponse | null
}

type ExportAction = 'csv' | 'pdf' | 'print' | 'xlsx'

const reportOptions: Array<{ label: string; value: PIReportType }> = [
  { label: 'Current Tab', value: 'current-tab' },
  { label: 'Complete Management Report', value: 'complete' },
  { label: 'Summary Only', value: 'summary' },
  { label: 'Trends', value: 'trends' },
  { label: 'Customer Ranking', value: 'customers' },
  { label: 'Company Ranking', value: 'companies' },
  { label: 'PI Search Results', value: 'search' },
  { label: 'Selected PI Detail', value: 'detail' },
  { label: 'Management Insight', value: 'insight' },
]

export function PIReportExportPanel({
  activeTab,
  companyRows,
  customerRows,
  customEndDate,
  customStartDate,
  dashboard,
  generatedBy,
  insight,
  lastRefreshedAt,
  rankingLimit,
  rankingPeriod,
  searchFilters,
  searchRows,
  selectedDetail,
}: PIReportExportPanelProps) {
  const [reportType, setReportType] = useState<PIReportType>('current-tab')
  const [reportTitle, setReportTitle] = useState('')
  const [activeExport, setActiveExport] = useState<ExportAction | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const context: PIReportContext = useMemo(
    () => ({
      activeTab,
      companyRows,
      customerRows,
      customEndDate,
      customStartDate,
      dashboard,
      generatedBy,
      insight,
      rankingLimit,
      rankingPeriod,
      searchFilters,
      searchRows,
      selectedDetail,
    }),
    [
      activeTab,
      companyRows,
      customerRows,
      customEndDate,
      customStartDate,
      dashboard,
      generatedBy,
      insight,
      rankingLimit,
      rankingPeriod,
      searchFilters,
      searchRows,
      selectedDetail,
    ],
  )
  const rowCount = getPIReportRowCount(context, reportType)
  const selectedTitle = getPIReportTitle(reportType, context, reportTitle)
  const isBusy = Boolean(activeExport)
  const isDetailUnavailable = reportType === 'detail' && !selectedDetail
  const isDisabled = isBusy || !dashboard || isDetailUnavailable

  const runExport = async (action: ExportAction) => {
    if (!dashboard) {
      setError('Load the PI Intelligence dashboard before exporting.')
      return
    }

    if (reportType === 'detail' && !selectedDetail) {
      setError('Select a PI from PI Search before exporting the detailed PI report.')
      return
    }

    setActiveExport(action)
    setError('')
    setMessage('Preparing report...')

    try {
      await Promise.resolve()

      if (action === 'print') {
        const printWindow = window.open('', '_blank')

        if (!printWindow) {
          throw new Error('Please allow pop-ups to open the print report.')
        }

        printWindow.opener = null
        printWindow.document.open()
        printWindow.document.write(createPIReportPrintHtml(context, reportType, reportTitle))
        printWindow.document.close()
        printWindow.focus()
        window.setTimeout(() => printWindow.print(), 250)
        setMessage('Print report opened.')
        return
      }

      const blob =
        action === 'xlsx'
          ? createPIReportXlsx(context, reportType, reportTitle)
          : action === 'csv'
            ? createPIReportCsv(context, reportType, reportTitle)
            : createPIReportPdf(context, reportType, reportTitle)
      const filename = getPIReportFilename(
        context,
        reportType,
        action === 'xlsx' ? 'xlsx' : action,
        reportTitle,
      )

      downloadBlob(blob, filename)
      setMessage(`${filename} generated.`)
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : 'Unable to generate the selected report.',
      )
      setMessage('')
    } finally {
      setActiveExport(null)
    }
  }

  return (
    <section className="panel pi-report-export-panel" aria-label="PI report export">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Export / Print</p>
          <h2>PI Reports</h2>
        </div>
        <span className="ai-live-data-pill">Read-only</span>
      </div>

      <div className="pi-report-export-grid">
        <label>
          <span>Report</span>
          <select
            disabled={isBusy}
            onChange={(event) => setReportType(event.target.value as PIReportType)}
            value={reportType}
          >
            {reportOptions.map((option) => (
              <option
                disabled={option.value === 'detail' && !selectedDetail}
                key={option.value}
                value={option.value}
              >
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Report Title</span>
          <input
            disabled={isBusy}
            onChange={(event) => setReportTitle(event.target.value)}
            placeholder={selectedTitle}
            value={reportTitle}
          />
        </label>
        <div className="pi-report-export-meta">
          <span>{rowCount} safe row(s)</span>
          <span>Last loaded: {formatReportDateTime(lastRefreshedAt)}</span>
        </div>
      </div>

      <div className="pi-report-export-actions">
        <Button disabled={isDisabled} onClick={() => void runExport('xlsx')}>
          {activeExport === 'xlsx' ? 'Preparing...' : 'Export Excel'}
        </Button>
        <Button disabled={isDisabled} onClick={() => void runExport('csv')} variant="secondary">
          {activeExport === 'csv' ? 'Preparing...' : 'Export CSV'}
        </Button>
        <Button disabled={isDisabled} onClick={() => void runExport('pdf')} variant="secondary">
          {activeExport === 'pdf' ? 'Preparing...' : 'Download PDF'}
        </Button>
        <Button disabled={isDisabled} onClick={() => void runExport('print')} variant="ghost">
          {activeExport === 'print' ? 'Opening...' : 'Print Report'}
        </Button>
      </div>

      {isDetailUnavailable ? (
        <p className="pi-report-export-hint">
          Selected PI Detail is available after opening a PI from the PI Search tab.
        </p>
      ) : null}
      {message ? <p className="pi-report-export-message">{message}</p> : null}
      {error ? (
        <p className="pi-report-export-message error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}

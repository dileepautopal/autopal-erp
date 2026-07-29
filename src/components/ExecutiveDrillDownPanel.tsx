import { useEffect } from 'react'
import { Button } from './ui/Button'
import { ExecutiveDrillDownTable } from './ExecutiveDrillDownTable'
import { ExecutiveExplainPanel } from './ExecutiveExplainPanel'
import {
  formatINR,
  formatReportDate,
  formatReportDateTime,
} from '../utils/exportUtils'
import type {
  ExecutiveDrillDownResponse,
  ExecutiveDrillDownRow,
  ExecutiveExplainResponse,
} from '../services/aiService'

type ExecutiveDrillDownPanelProps = {
  canGoBack?: boolean
  data: ExecutiveDrillDownResponse | null
  errorMessage?: string
  exportMessage?: string
  explainErrorMessage?: string
  explanation: ExecutiveExplainResponse | null
  isExplaining?: boolean
  isOpen: boolean
  isLoading?: boolean
  onBack?: () => void
  onClose: () => void
  onExplain?: () => void
  onExportCsv?: () => void
  onExportExcel?: () => void
  onPrint?: () => void
  onRowSelect?: (row: ExecutiveDrillDownRow) => void
}

const formatCardValue = (type: string | undefined, value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return '-'
  }

  if (type === 'currency') {
    return formatINR(Number(value))
  }

  if (type === 'date' && typeof value === 'string') {
    return formatReportDate(value)
  }

  if (type === 'number' && typeof value === 'number') {
    return new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2,
    }).format(value)
  }

  return String(value)
}

export function ExecutiveDrillDownPanel({
  canGoBack = false,
  data,
  errorMessage = '',
  exportMessage = '',
  explainErrorMessage = '',
  explanation,
  isExplaining = false,
  isLoading = false,
  isOpen,
  onBack,
  onClose,
  onExplain,
  onExportCsv,
  onExportExcel,
  onPrint,
  onRowSelect,
}: ExecutiveDrillDownPanelProps) {
  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const cards = data?.summary?.cards ?? []
  const rows = data?.rows ?? []

  return (
    <div className="executive-drilldown-backdrop" role="presentation">
      <aside
        aria-label="Executive drill-down"
        aria-modal="true"
        className="executive-drilldown-panel"
        role="dialog"
      >
        <header className="executive-drilldown-header">
          <div>
            <p className="eyebrow">Executive Cockpit</p>
            <h2>{data?.title || 'Executive Drill-Down'}</h2>
            <span>
              {data?.period?.label || 'Selected period'}:{' '}
              {data?.period?.startDate ? formatReportDate(data.period.startDate) : '-'} to{' '}
              {data?.period?.endDate ? formatReportDate(data.period.endDate) : '-'}
            </span>
          </div>
          <div className="executive-drilldown-actions">
            {canGoBack ? (
              <Button onClick={onBack} variant="secondary">
                Back
              </Button>
            ) : null}
            <Button onClick={onClose} variant="ghost">
              Close
            </Button>
          </div>
        </header>

        <section className="pi-intelligence-period executive-disclaimer">
          <strong>PI-based limitation</strong>
          <span>{data?.disclaimer}</span>
        </section>

        {isLoading ? (
          <section className="panel pi-intelligence-state">Loading drill-down...</section>
        ) : null}

        {errorMessage ? (
          <section className="pi-intelligence-error" role="alert">
            <strong>Drill-down unavailable</strong>
            <span>{errorMessage}</span>
          </section>
        ) : null}

        {data ? (
          <>
            <section className="executive-drilldown-meta">
              <span>Live ERP data</span>
              <span>Generated: {formatReportDateTime(data.generatedAt)}</span>
              <span>
                Rows: {data.pagination?.returned ?? rows.length}
                {data.pagination?.hasMore ? ` of first ${data.pagination.limit}` : ''}
              </span>
            </section>

            {cards.length ? (
              <section className="executive-drilldown-card-grid">
                {cards.map((card) => (
                  <div className="metric-card pi-intelligence-metric" key={card.label}>
                    <span>{card.label}</span>
                    <strong>{formatCardValue(card.type, card.value)}</strong>
                  </div>
                ))}
              </section>
            ) : null}

            <ExecutiveExplainPanel
              errorMessage={explainErrorMessage}
              explanation={explanation}
              isLoading={isExplaining}
            />

            <section className="executive-drilldown-toolbar">
              <Button disabled={isExplaining} onClick={onExplain} variant="secondary">
                Explain this
              </Button>
              <Button disabled={!rows.length} onClick={onExportCsv} variant="secondary">
                Export CSV
              </Button>
              <Button disabled={!rows.length} onClick={onExportExcel} variant="secondary">
                Export Excel
              </Button>
              <Button disabled={!rows.length} onClick={onPrint} variant="ghost">
                Print / PDF
              </Button>
            </section>
            {exportMessage ? (
              <p className="pi-report-export-message">{exportMessage}</p>
            ) : null}

            <ExecutiveDrillDownTable onRowSelect={onRowSelect} rows={rows} />
          </>
        ) : null}
      </aside>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import {
  getPIIntelligenceDashboard,
  type PIIntelligenceDashboardResponse,
  type PIIntelligenceDailySummary,
  type PIIntelligenceLatestPI,
  type PIIntelligenceMetric,
} from '../services/aiService'

type PIIntelligenceDashboardProps = {
  currentUserName: string
}

const emptyMetric: PIIntelligenceMetric = {
  count: 0,
  value: 0,
}

const formatCount = (value?: number) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0))

const formatCurrency = (value?: number) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(Number(value ?? 0))

const formatDate = (value?: string) => {
  if (!value) {
    return '-'
  }

  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

const formatDateTime = (value?: string) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

const getMetric = (
  dashboard: PIIntelligenceDashboardResponse | null,
  key: 'today' | 'month' | 'open' | 'final',
) => dashboard?.summary?.[key] ?? emptyMetric

const getDailyBarWidth = (
  row: PIIntelligenceDailySummary,
  maximumValue: number,
) => {
  if (maximumValue <= 0) {
    return '0%'
  }

  return `${Math.max((Number(row.value ?? 0) / maximumValue) * 100, 4)}%`
}

export function PIIntelligenceDashboard({
  currentUserName,
}: PIIntelligenceDashboardProps) {
  const [dashboard, setDashboard] =
    useState<PIIntelligenceDashboardResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [lastRefreshedAt, setLastRefreshedAt] = useState('')

  const latestPIs = Array.isArray(dashboard?.latestPIs)
    ? dashboard.latestPIs
    : []
  const dailySummary = Array.isArray(dashboard?.dailySummary)
    ? dashboard.dailySummary
    : []
  const dailyMaximumValue = dailySummary.reduce(
    (maximum, row) => Math.max(maximum, Number(row.value ?? 0)),
    0,
  )

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage('')

    try {
      const result = await getPIIntelligenceDashboard({
        userName: currentUserName,
      })

      if (!result.success) {
        throw new Error(result.message || 'Unable to load PI Intelligence.')
      }

      setDashboard(result)
      setLastRefreshedAt(new Date().toISOString())
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Unable to load PI Intelligence dashboard.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [currentUserName])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadDashboard])

  const renderMetricCard = (
    label: string,
    metric: PIIntelligenceMetric,
    accent: 'red' | 'saffron' = 'red',
    primary: 'count' | 'value' = 'count',
  ) => (
    <div className={`metric-card pi-intelligence-metric accent-${accent}`}>
      <span>{label}</span>
      <strong>
        {primary === 'value'
          ? formatCurrency(metric.value)
          : formatCount(metric.count)}
      </strong>
      <p>
        {primary === 'value'
          ? `${formatCount(metric.count)} PI`
          : formatCurrency(metric.value)}
      </p>
    </div>
  )

  return (
    <div className="page pi-intelligence-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PI Intelligence</p>
          <h1>PI Intelligence Dashboard</h1>
          <p className="page-subtitle">
            Read-only live PI reporting for counts, values, latest PIs and daily
            current month movement.
          </p>
        </div>
        <div className="header-actions">
          <span className="pi-intelligence-refresh-time">
            Last refreshed: {formatDateTime(lastRefreshedAt)}
          </span>
          <Button disabled={isLoading} onClick={() => void loadDashboard()}>
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </header>

      {errorMessage ? (
        <section className="pi-intelligence-error" role="alert">
          <strong>Dashboard unavailable</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      <section className="dashboard-grid" aria-live="polite">
        {renderMetricCard('Today PI Count', getMetric(dashboard, 'today'))}
        {renderMetricCard(
          'Today PI Value',
          getMetric(dashboard, 'today'),
          'saffron',
          'value',
        )}
        {renderMetricCard(
          'This Month PI Count',
          getMetric(dashboard, 'month'),
        )}
        {renderMetricCard(
          'This Month PI Value',
          getMetric(dashboard, 'month'),
          'saffron',
          'value',
        )}
        {renderMetricCard('Open PI Count', getMetric(dashboard, 'open'))}
        {renderMetricCard(
          'Open PI Value',
          getMetric(dashboard, 'open'),
          'saffron',
          'value',
        )}
        {renderMetricCard('Final PI Count', getMetric(dashboard, 'final'))}
        {renderMetricCard(
          'Final PI Value',
          getMetric(dashboard, 'final'),
          'saffron',
          'value',
        )}
      </section>

      {isLoading ? (
        <section className="panel pi-intelligence-state">Loading PI dashboard...</section>
      ) : null}

      <section className="pi-intelligence-content-grid">
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Latest</p>
              <h2>Latest 10 PIs</h2>
            </div>
            <span className="status-pill">
              {formatCount(latestPIs.length)} records
            </span>
          </div>

          {latestPIs.length > 0 ? (
            <div className="pi-intelligence-table-wrap">
              <table className="pi-intelligence-table">
                <thead>
                  <tr>
                    <th>PI Number</th>
                    <th>Date</th>
                    <th>Customer</th>
                    <th>Company</th>
                    <th>Status</th>
                    <th className="numeric">Grand Total</th>
                  </tr>
                </thead>
                <tbody>
                  {latestPIs.map((pi: PIIntelligenceLatestPI, index) => (
                    <tr key={`${pi.piNumber ?? 'pi'}-${index}`}>
                      <td>{pi.piNumber || '-'}</td>
                      <td>{formatDate(pi.piDate)}</td>
                      <td>{pi.customerName || '-'}</td>
                      <td>{pi.companyName || '-'}</td>
                      <td>
                        <span
                          className={`pi-status ${
                            pi.status === 'Final'
                              ? 'pi-status-final'
                              : 'pi-status-draft'
                          }`}
                        >
                          {pi.status || 'Draft'}
                        </span>
                      </td>
                      <td className="numeric">{formatCurrency(pi.grandTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state pi-intelligence-empty">
              <h2>No latest PI records</h2>
              <p>No active PI records are available for display.</p>
            </div>
          )}
        </section>

        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Current Month</p>
              <h2>Daily PI Summary</h2>
            </div>
            <span className="status-pill">
              {formatCount(dailySummary.length)} days
            </span>
          </div>

          {dailySummary.length > 0 ? (
            <div className="pi-intelligence-daily-list">
              {dailySummary.map((row) => (
                <div className="pi-intelligence-day-row" key={row.date}>
                  <div className="pi-intelligence-day-meta">
                    <span>{formatDate(row.date)}</span>
                    <strong>
                      {formatCount(row.count)} PI / {formatCurrency(row.value)}
                    </strong>
                  </div>
                  <span className="pi-intelligence-day-track">
                    <span
                      className="pi-intelligence-day-fill"
                      style={{ width: getDailyBarWidth(row, dailyMaximumValue) }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state pi-intelligence-empty">
              <h2>No daily records</h2>
              <p>No PI records are available for the current month.</p>
            </div>
          )}
        </section>
      </section>
    </div>
  )
}

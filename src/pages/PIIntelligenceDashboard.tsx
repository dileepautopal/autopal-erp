import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import {
  getPICompanyRanking,
  getPICustomerRanking,
  getPIDetail,
  getPIIntelligenceProDashboard,
  getPIManagementInsight,
  searchPIs,
  type PIDetailResponse,
  type PIIntelligenceLatestPI,
  type PIIntelligenceMetric,
  type PIIntelligenceProDashboardResponse,
  type PIIntelligenceRankingResponse,
  type PIIntelligenceRankingRow,
  type PIIntelligenceStatusMetric,
  type PIIntelligenceTrendRow,
  type PIManagementInsightResponse,
  type PISearchFilters,
  type PISearchResponse,
} from '../services/aiService'

type PIIntelligenceDashboardProps = {
  currentUserName: string
}

type TabId =
  | 'overview'
  | 'trends'
  | 'customers'
  | 'companies'
  | 'search'
  | 'insight'

const tabs: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'trends', label: 'Trends' },
  { id: 'customers', label: 'Customer Ranking' },
  { id: 'companies', label: 'Company Ranking' },
  { id: 'search', label: 'PI Search' },
  { id: 'insight', label: 'Management Insight' },
]

const emptyMetric: PIIntelligenceMetric = {
  count: 0,
  value: 0,
}

const emptyStatusMetric: PIIntelligenceStatusMetric = {
  count: 0,
  percentage: 0,
  value: 0,
}

const formatCount = (value?: number) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
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
  dashboard: PIIntelligenceProDashboardResponse | null,
  key: 'today' | 'yesterday' | 'week' | 'month',
) => dashboard?.kpis?.[key] ?? emptyMetric

const getStatusMetric = (
  dashboard: PIIntelligenceProDashboardResponse | null,
  key: 'open' | 'final',
) => dashboard?.kpis?.[key] ?? emptyStatusMetric

const getBarWidth = (value: number, maxValue: number) => {
  if (maxValue <= 0 || value <= 0) {
    return '0%'
  }

  return `${Math.max((value / maxValue) * 100, 4)}%`
}

const getRows = <T,>(rows?: T[]) => (Array.isArray(rows) ? rows : [])

function MetricCard({
  accent = 'red',
  label,
  metric,
  primary = 'count',
}: {
  accent?: 'red' | 'saffron'
  label: string
  metric: PIIntelligenceMetric
  primary?: 'count' | 'value'
}) {
  return (
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
}

function KPIValueCard({
  label,
  value,
}: {
  label: string
  value?: number
}) {
  return (
    <div className="metric-card pi-intelligence-metric accent-saffron">
      <span>{label}</span>
      <strong>{formatCurrency(value)}</strong>
    </div>
  )
}

function EmptyState({
  message,
  title,
}: {
  message: string
  title: string
}) {
  return (
    <div className="empty-state pi-intelligence-empty">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  )
}

function TrendBars({
  label,
  rows,
  valueKey,
}: {
  label: string
  rows: PIIntelligenceTrendRow[]
  valueKey: 'count' | 'value'
}) {
  const maxValue = rows.reduce(
    (maximum, row) => Math.max(maximum, Number(row[valueKey] ?? 0)),
    0,
  )

  if (rows.length === 0) {
    return <EmptyState message="No daily PI records are available." title={label} />
  }

  return (
    <div className="pi-intelligence-daily-list" aria-label={label}>
      {rows.map((row) => (
        <div className="pi-intelligence-day-row" key={`${label}-${row.date}`}>
          <div className="pi-intelligence-day-meta">
            <span>{formatDate(row.date)}</span>
            <strong>
              {valueKey === 'value'
                ? formatCurrency(row.value)
                : `${formatCount(row.count)} PI`}
            </strong>
          </div>
          <span className="pi-intelligence-day-track">
            <span
              className="pi-intelligence-day-fill"
              style={{ width: getBarWidth(Number(row[valueKey] ?? 0), maxValue) }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

function RankingBars({
  rows,
  title,
}: {
  rows: PIIntelligenceRankingRow[]
  title: string
}) {
  const maxValue = rows.reduce(
    (maximum, row) => Math.max(maximum, row.totalPIValue),
    0,
  )

  if (rows.length === 0) {
    return <EmptyState message="No ranking records are available." title={title} />
  }

  return (
    <div className="pi-intelligence-daily-list" aria-label={title}>
      {rows.slice(0, 10).map((row) => (
        <div className="pi-intelligence-day-row" key={`${title}-${row.rank}-${row.name}`}>
          <div className="pi-intelligence-day-meta">
            <span>{row.name || 'Unknown'}</span>
            <strong>{formatCurrency(row.totalPIValue)}</strong>
          </div>
          <span className="pi-intelligence-day-track">
            <span
              className="pi-intelligence-day-fill"
              style={{ width: getBarWidth(row.totalPIValue, maxValue) }}
            />
          </span>
        </div>
      ))}
    </div>
  )
}

function RankingTable({
  rows,
  type,
}: {
  rows: PIIntelligenceRankingRow[]
  type: 'company' | 'customer'
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        message={`No ${type} ranking records are available for the selected period.`}
        title={`No ${type} ranking`}
      />
    )
  }

  return (
    <div className="pi-intelligence-table-wrap">
      <table className="pi-intelligence-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>{type === 'company' ? 'Company' : 'Customer'}</th>
            <th className="numeric">PI Count</th>
            <th className="numeric">Total PI Value</th>
            <th className="numeric">Average PI Value</th>
            <th className="numeric">Open PI Count</th>
            {type === 'customer' ? <th className="numeric">Open PI Value</th> : null}
            <th className="numeric">Final PI Count</th>
            {type === 'customer' ? <th className="numeric">Final PI Value</th> : null}
            <th>Last PI Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${type}-${row.rank}-${row.name}`}>
              <td>{row.rank}</td>
              <td>{row.name || 'Unknown'}</td>
              <td className="numeric">{formatCount(row.piCount)}</td>
              <td className="numeric">{formatCurrency(row.totalPIValue)}</td>
              <td className="numeric">{formatCurrency(row.averagePIValue)}</td>
              <td className="numeric">{formatCount(row.openCount)}</td>
              {type === 'customer' ? (
                <td className="numeric">{formatCurrency(row.openValue)}</td>
              ) : null}
              <td className="numeric">{formatCount(row.finalCount)}</td>
              {type === 'customer' ? (
                <td className="numeric">{formatCurrency(row.finalValue)}</td>
              ) : null}
              <td>{formatDate(row.lastPIDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LatestPITable({
  onView,
  rows,
}: {
  onView?: (piNumber: string) => void
  rows: PIIntelligenceLatestPI[]
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        message="No active PI records are available for display."
        title="No latest PI records"
      />
    )
  }

  return (
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
            {onView ? <th>View</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((pi, index) => (
            <tr key={`${pi.piNumber ?? 'pi'}-${index}`}>
              <td>{pi.piNumber || '-'}</td>
              <td>{formatDate(pi.piDate)}</td>
              <td>{pi.customerName || '-'}</td>
              <td>{pi.companyName || '-'}</td>
              <td>
                <span
                  className={`pi-status ${
                    pi.status === 'Final' ? 'pi-status-final' : 'pi-status-draft'
                  }`}
                >
                  {pi.status || 'Draft'}
                </span>
              </td>
              <td className="numeric">{formatCurrency(pi.grandTotal)}</td>
              {onView ? (
                <td>
                  <Button
                    disabled={!pi.piNumber}
                    onClick={() => pi.piNumber && onView(pi.piNumber)}
                    variant="ghost"
                  >
                    View
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PIIntelligenceDashboard({
  currentUserName,
}: PIIntelligenceDashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [dashboard, setDashboard] =
    useState<PIIntelligenceProDashboardResponse | null>(null)
  const [insight, setInsight] = useState<PIManagementInsightResponse | null>(null)
  const [customerRanking, setCustomerRanking] =
    useState<PIIntelligenceRankingResponse | null>(null)
  const [companyRanking, setCompanyRanking] =
    useState<PIIntelligenceRankingResponse | null>(null)
  const [rankingPeriod, setRankingPeriod] = useState('month')
  const [rankingLimit, setRankingLimit] = useState(10)
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [searchFilters, setSearchFilters] = useState<PISearchFilters>({
    limit: 20,
    q: '',
    status: '',
  })
  const [searchResult, setSearchResult] = useState<PISearchResponse | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<PIDetailResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [searchError, setSearchError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isRankingLoading, setIsRankingLoading] = useState(false)
  const [isSearchLoading, setIsSearchLoading] = useState(false)
  const [isInsightLoading, setIsInsightLoading] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState('')

  const latestPIs = getRows(dashboard?.latestPIs)
  const trendRows = getRows(dashboard?.trend)
  const topCustomers = getRows(dashboard?.topCustomers)
  const companyRows = getRows(dashboard?.companyRanking)
  const customerRows = getRows(customerRanking?.rows).length
    ? getRows(customerRanking?.rows)
    : topCustomers
  const companyRankingRows = getRows(companyRanking?.rows).length
    ? getRows(companyRanking?.rows)
    : companyRows

  const loadInsight = useCallback(async () => {
    setIsInsightLoading(true)

    try {
      const result = await getPIManagementInsight({
        userName: currentUserName,
      })

      setInsight(result)
    } catch (error) {
      setInsight({
        insight:
          error instanceof Error
            ? error.message
            : 'Unable to create PI management insight.',
        success: false,
      })
    } finally {
      setIsInsightLoading(false)
    }
  }, [currentUserName])

  const loadDashboard = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage('')

    try {
      const result = await getPIIntelligenceProDashboard({
        userName: currentUserName,
      })

      if (!result.success) {
        throw new Error(result.message || 'Unable to load PI Intelligence.')
      }

      setDashboard(result)
      setLastRefreshedAt(new Date().toISOString())
      void loadInsight()
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Unable to load PI Intelligence dashboard.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [currentUserName, loadInsight])

  const loadRankings = useCallback(async () => {
    setIsRankingLoading(true)
    const params = {
      endDate: rankingPeriod === 'custom' ? customEndDate : undefined,
      limit: rankingLimit,
      period: rankingPeriod,
      startDate: rankingPeriod === 'custom' ? customStartDate : undefined,
    }

    try {
      const [customerResult, companyResult] = await Promise.all([
        getPICustomerRanking(params, { userName: currentUserName }),
        getPICompanyRanking(params, { userName: currentUserName }),
      ])

      setCustomerRanking(customerResult)
      setCompanyRanking(companyResult)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Unable to load PI rankings.',
      )
    } finally {
      setIsRankingLoading(false)
    }
  }, [
    currentUserName,
    customEndDate,
    customStartDate,
    rankingLimit,
    rankingPeriod,
  ])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDashboard()
      void loadRankings()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadDashboard, loadRankings])

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSearchLoading(true)
    setSearchError('')
    setSelectedDetail(null)

    try {
      const result = await searchPIs(searchFilters, {
        userName: currentUserName,
      })

      setSearchResult(result)
    } catch (error) {
      setSearchError(
        error instanceof Error ? error.message : 'Unable to search PIs.',
      )
      setSearchResult(null)
    } finally {
      setIsSearchLoading(false)
    }
  }

  const viewPIDetail = async (piNumber: string) => {
    setIsSearchLoading(true)
    setSearchError('')

    try {
      const detail = await getPIDetail(piNumber, {
        userName: currentUserName,
      })

      setSelectedDetail(detail)
    } catch (error) {
      setSearchError(
        error instanceof Error ? error.message : 'Unable to load PI detail.',
      )
      setSelectedDetail(null)
    } finally {
      setIsSearchLoading(false)
    }
  }

  const clearSearch = () => {
    setSearchFilters({
      limit: 20,
      q: '',
      status: '',
    })
    setSearchResult(null)
    setSelectedDetail(null)
    setSearchError('')
  }

  return (
    <div className="page pi-intelligence-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">PI Intelligence</p>
          <h1>PI Intelligence Dashboard</h1>
          <p className="page-subtitle">
            Live read-only PI analytics, ranking, trend, search and management
            insight for authorised AUTOPAL users.
          </p>
        </div>
        <div className="header-actions">
          <span className="ai-live-data-pill">Live ERP data</span>
          <span className="pi-intelligence-refresh-time">
            Last refreshed: {formatDateTime(lastRefreshedAt)}
          </span>
          <Button disabled={isLoading} onClick={() => void loadDashboard()}>
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </header>

      {dashboard?.period ? (
        <section className="pi-intelligence-period">
          <strong>Current period</strong>
          <span>
            Today {formatDate(dashboard.period.today)} / Month{' '}
            {formatDate(dashboard.period.monthStart)} to{' '}
            {formatDate(dashboard.period.monthEnd)}
          </span>
        </section>
      ) : null}

      {errorMessage ? (
        <section className="pi-intelligence-error" role="alert">
          <strong>Dashboard unavailable</strong>
          <span>{errorMessage}</span>
        </section>
      ) : null}

      <nav className="pi-intelligence-tabs" aria-label="PI Intelligence sections">
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
        <section className="panel pi-intelligence-state">Loading PI dashboard...</section>
      ) : null}

      {activeTab === 'overview' ? (
        <>
          <section className="dashboard-grid" aria-live="polite">
            <MetricCard label="Today PI Count" metric={getMetric(dashboard, 'today')} />
            <MetricCard
              accent="saffron"
              label="Today PI Value"
              metric={getMetric(dashboard, 'today')}
              primary="value"
            />
            <MetricCard label="Yesterday PI Count" metric={getMetric(dashboard, 'yesterday')} />
            <MetricCard
              accent="saffron"
              label="Yesterday PI Value"
              metric={getMetric(dashboard, 'yesterday')}
              primary="value"
            />
            <MetricCard label="This Week PI Count" metric={getMetric(dashboard, 'week')} />
            <MetricCard
              accent="saffron"
              label="This Week PI Value"
              metric={getMetric(dashboard, 'week')}
              primary="value"
            />
            <MetricCard label="This Month PI Count" metric={getMetric(dashboard, 'month')} />
            <MetricCard
              accent="saffron"
              label="This Month PI Value"
              metric={getMetric(dashboard, 'month')}
              primary="value"
            />
            <MetricCard label="Open PI Count" metric={getStatusMetric(dashboard, 'open')} />
            <MetricCard
              accent="saffron"
              label="Open PI Value"
              metric={getStatusMetric(dashboard, 'open')}
              primary="value"
            />
            <MetricCard label="Final PI Count" metric={getStatusMetric(dashboard, 'final')} />
            <MetricCard
              accent="saffron"
              label="Final PI Value"
              metric={getStatusMetric(dashboard, 'final')}
              primary="value"
            />
          </section>

          <section className="dashboard-grid">
            <KPIValueCard
              label="Average PI Value This Month"
              value={dashboard?.kpis?.averagePIValueMonth}
            />
            <KPIValueCard
              label="Highest PI Value This Month"
              value={dashboard?.kpis?.highestPIValueMonth}
            />
            <KPIValueCard
              label="Lowest PI Value This Month"
              value={dashboard?.kpis?.lowestPIValueMonth}
            />
            <div className="metric-card pi-intelligence-metric accent-red">
              <span>Open / Final Percentage</span>
              <strong>
                {formatCount(dashboard?.kpis?.open?.percentage)}% /{' '}
                {formatCount(dashboard?.kpis?.final?.percentage)}%
              </strong>
            </div>
          </section>

          <section className="pi-intelligence-content-grid">
            <section className="panel pi-intelligence-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Latest</p>
                  <h2>Latest 10 PIs</h2>
                </div>
                <span className="status-pill">{formatCount(latestPIs.length)} records</span>
              </div>
              <LatestPITable rows={latestPIs} />
            </section>

            <section className="panel pi-intelligence-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Leaders</p>
                  <h2>Current Month Highlights</h2>
                </div>
              </div>
              <div className="pi-intelligence-highlight-list">
                <div>
                  <span>Top Customer</span>
                  <strong>{dashboard?.topCustomer?.name ?? '-'}</strong>
                  <small>{formatCurrency(dashboard?.topCustomer?.totalPIValue)}</small>
                </div>
                <div>
                  <span>Top Company</span>
                  <strong>{dashboard?.topCompany?.name ?? '-'}</strong>
                  <small>{formatCurrency(dashboard?.topCompany?.totalPIValue)}</small>
                </div>
                <div>
                  <span>Best Day by Value</span>
                  <strong>{formatDate(dashboard?.bestDayByValue?.date)}</strong>
                  <small>{formatCurrency(dashboard?.bestDayByValue?.value)}</small>
                </div>
                <div>
                  <span>Best Day by Count</span>
                  <strong>{formatDate(dashboard?.bestDayByCount?.date)}</strong>
                  <small>{formatCount(dashboard?.bestDayByCount?.count)} PI</small>
                </div>
              </div>
            </section>
          </section>
        </>
      ) : null}

      {activeTab === 'trends' ? (
        <section className="dashboard-chart-grid pi-intelligence-chart-grid">
          <section className="panel dashboard-chart-card">
            <div className="dashboard-chart-head">
              <h2>Daily PI Count</h2>
            </div>
            <TrendBars label="Daily PI Count" rows={trendRows} valueKey="count" />
          </section>
          <section className="panel dashboard-chart-card">
            <div className="dashboard-chart-head">
              <h2>Daily PI Value</h2>
            </div>
            <TrendBars label="Daily PI Value" rows={trendRows} valueKey="value" />
          </section>
          <section className="panel dashboard-chart-card">
            <div className="dashboard-chart-head">
              <h2>Open vs Final</h2>
            </div>
            <div className="pi-intelligence-split-bars">
              <div>
                <span>Open</span>
                <strong>{formatCount(dashboard?.kpis?.open?.percentage)}%</strong>
                <i style={{ width: `${dashboard?.kpis?.open?.percentage ?? 0}%` }} />
              </div>
              <div>
                <span>Final</span>
                <strong>{formatCount(dashboard?.kpis?.final?.percentage)}%</strong>
                <i style={{ width: `${dashboard?.kpis?.final?.percentage ?? 0}%` }} />
              </div>
            </div>
          </section>
          <section className="panel dashboard-chart-card">
            <div className="dashboard-chart-head">
              <h2>Top Customers by Value</h2>
            </div>
            <RankingBars rows={topCustomers} title="Top Customers by Value" />
          </section>
          <section className="panel dashboard-chart-card pi-intelligence-wide-chart">
            <div className="dashboard-chart-head">
              <h2>Company-wise PI Value</h2>
            </div>
            <RankingBars rows={companyRows} title="Company-wise PI Value" />
          </section>
        </section>
      ) : null}

      {activeTab === 'customers' || activeTab === 'companies' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ranking Filters</p>
              <h2>{activeTab === 'customers' ? 'Customer Ranking' : 'Company Ranking'}</h2>
            </div>
            <Button disabled={isRankingLoading} onClick={() => void loadRankings()}>
              {isRankingLoading ? 'Loading' : 'Apply'}
            </Button>
          </div>
          <div className="pi-intelligence-filter-grid">
            <label>
              <span>Period</span>
              <select
                onChange={(event) => setRankingPeriod(event.target.value)}
                value={rankingPeriod}
              >
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="month">This month</option>
                <option value="last-30-days">Last 30 days</option>
                <option value="custom">Custom date range</option>
              </select>
            </label>
            <label>
              <span>Limit</span>
              <select
                onChange={(event) => setRankingLimit(Number(event.target.value))}
                value={rankingLimit}
              >
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
              </select>
            </label>
            <label>
              <span>Start Date</span>
              <input
                disabled={rankingPeriod !== 'custom'}
                onChange={(event) => setCustomStartDate(event.target.value)}
                type="date"
                value={customStartDate}
              />
            </label>
            <label>
              <span>End Date</span>
              <input
                disabled={rankingPeriod !== 'custom'}
                onChange={(event) => setCustomEndDate(event.target.value)}
                type="date"
                value={customEndDate}
              />
            </label>
          </div>
          {activeTab === 'customers' ? (
            <>
              {customerRanking?.groupNote ? (
                <p className="pi-intelligence-note">{customerRanking.groupNote}</p>
              ) : null}
              <RankingTable rows={customerRows} type="customer" />
            </>
          ) : (
            <RankingTable rows={companyRankingRows} type="company" />
          )}
        </section>
      ) : null}

      {activeTab === 'search' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Search</p>
              <h2>Smart PI Search</h2>
            </div>
          </div>
          <form className="pi-intelligence-search-form" onSubmit={handleSearch}>
            <label>
              <span>PI / Customer / Company</span>
              <input
                onChange={(event) =>
                  setSearchFilters((current) => ({
                    ...current,
                    q: event.target.value,
                  }))
                }
                placeholder="Example: AML-0012 or customer name"
                value={searchFilters.q ?? ''}
              />
            </label>
            <label>
              <span>Status</span>
              <select
                onChange={(event) =>
                  setSearchFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
                value={searchFilters.status ?? ''}
              >
                <option value="">Any status</option>
                <option value="draft">Open / Draft</option>
                <option value="final">Final / Closed</option>
              </select>
            </label>
            <label>
              <span>Start Date</span>
              <input
                onChange={(event) =>
                  setSearchFilters((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
                type="date"
                value={searchFilters.startDate ?? ''}
              />
            </label>
            <label>
              <span>End Date</span>
              <input
                onChange={(event) =>
                  setSearchFilters((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
                type="date"
                value={searchFilters.endDate ?? ''}
              />
            </label>
            <div className="pi-intelligence-search-actions">
              <Button disabled={isSearchLoading} type="submit">
                {isSearchLoading ? 'Searching' : 'Search'}
              </Button>
              <Button disabled={isSearchLoading} onClick={clearSearch} variant="ghost">
                Clear
              </Button>
            </div>
          </form>
          {searchError ? (
            <div className="pi-intelligence-error" role="alert">
              <strong>Search unavailable</strong>
              <span>{searchError}</span>
            </div>
          ) : null}
          <LatestPITable
            onView={(piNumber) => void viewPIDetail(piNumber)}
            rows={getRows(searchResult?.rows)}
          />
          {selectedDetail ? (
            <section className="pi-intelligence-detail">
              <h2>{selectedDetail.piNumber}</h2>
              <p>
                {selectedDetail.customerName} / {selectedDetail.companyName} /{' '}
                {formatCurrency(selectedDetail.grandTotal)}
              </p>
              {getRows(selectedDetail.lines).length > 0 ? (
                <div className="pi-intelligence-table-wrap">
                  <table className="pi-intelligence-table">
                    <thead>
                      <tr>
                        <th>Product Code</th>
                        <th>Product Description</th>
                        <th className="numeric">Quantity</th>
                        <th className="numeric">Rate</th>
                        <th className="numeric">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getRows(selectedDetail.lines).map((line) => (
                        <tr key={`${selectedDetail.piNumber}-${line.productCode}`}>
                          <td>{line.productCode || '-'}</td>
                          <td>{line.productDescription || '-'}</td>
                          <td className="numeric">{formatCount(line.quantity)}</td>
                          <td className="numeric">{formatCurrency(line.rate)}</td>
                          <td className="numeric">{formatCurrency(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="pi-intelligence-note">No safe product lines found.</p>
              )}
            </section>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'insight' ? (
        <section className="panel pi-intelligence-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Verified Insight</p>
              <h2>Management Insight</h2>
            </div>
            <Button disabled={isInsightLoading} onClick={() => void loadInsight()}>
              {isInsightLoading ? 'Creating' : 'Refresh Insight'}
            </Button>
          </div>
          <div className="ai-answer-content pi-intelligence-insight">
            {insight?.insight || 'Management insight will appear here.'}
          </div>
          <div className="ai-erp-source">
            <span>{insight?.wordingMode === 'ollama' ? 'Ollama wording' : 'Server fallback'}</span>
            <span>{formatDateTime(insight?.generatedAt)}</span>
          </div>
        </section>
      ) : null}
    </div>
  )
}

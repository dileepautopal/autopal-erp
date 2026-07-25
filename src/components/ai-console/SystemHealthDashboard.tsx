import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { apiUrl } from '../../config/api'

type HealthStatus = 'GREEN' | 'YELLOW' | 'RED' | 'GREY' | 'BLUE'

type HealthModule = {
  averageDurationMs?: number
  badge?: string
  durationMs?: number
  failedRuns?: number
  id: string
  lastChecked?: string
  lastSuccessfulRun?: string | null
  message?: string
  name: string
  status: HealthStatus
  statusLabel?: string
  successfulRuns?: number
  targetModule?: string
  tooltip?: string
  version?: string
}

type HealthHistoryItem = {
  completedAt?: string
  durationMs?: number
  success?: boolean
  testName?: string
  testRunId?: number
}

type HealthResponse = {
  healthScore?: number
  history?: {
    averageResponseTimeMs?: number
    greenPercent?: number
    last10HealthChecks?: HealthHistoryItem[]
    lastHealthCheck?: string | null
  }
  lastChecked?: string
  milestones?: Array<{
    label: string
    progress: number
  }>
  modules?: HealthModule[]
  overallStatus?: 'READY' | 'PARTIALLY_CONFIGURED' | 'SYSTEM_ERROR'
  summary?: {
    blue?: number
    green?: number
    grey?: number
    red?: number
    yellow?: number
  }
}

type SystemHealthDashboardProps = {
  currentUserName: string
  onModuleSelect: (moduleId: string) => void
}

const HEALTH_API_URL = apiUrl('/api/admin/ai-test-console/health')

const statusDisplay = {
  BLUE: {
    label: 'RUNNING',
    text: 'Currently running',
  },
  GREEN: {
    label: 'READY',
    text: 'Working',
  },
  GREY: {
    label: 'PENDING',
    text: 'Not implemented yet',
  },
  RED: {
    label: 'FAILED',
    text: 'Critical failure',
  },
  YELLOW: {
    label: 'WARNING',
    text: 'Attention required',
  },
}

const overallDisplay = {
  PARTIALLY_CONFIGURED: {
    className: 'yellow',
    label: 'PARTIALLY CONFIGURED',
    text: 'Some optional modules need attention.',
  },
  READY: {
    className: 'green',
    label: 'SYSTEM READY',
    text: 'All critical modules are working.',
  },
  SYSTEM_ERROR: {
    className: 'red',
    label: 'SYSTEM ERROR',
    text: 'A critical module failed.',
  },
}

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  return date.toLocaleString('en-IN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

const formatDuration = (value?: number) => {
  const number = Number(value ?? 0)

  return Number.isFinite(number) && number > 0 ? `${Math.round(number)} ms` : '-'
}

const getPieBackground = (summary: HealthResponse['summary']) => {
  const counts = [
    { color: '#16a34a', value: Number(summary?.green ?? 0) },
    { color: '#f59e0b', value: Number(summary?.yellow ?? 0) },
    { color: '#dc2626', value: Number(summary?.red ?? 0) },
    { color: '#9ca3af', value: Number(summary?.grey ?? 0) },
    { color: '#2563eb', value: Number(summary?.blue ?? 0) },
  ]
  const total = counts.reduce((sum, item) => sum + item.value, 0)

  if (total <= 0) {
    return '#e5e7eb'
  }

  let current = 0
  const segments = counts
    .filter((item) => item.value > 0)
    .map((item) => {
      const start = current
      const end = current + (item.value / total) * 360
      current = end

      return `${item.color} ${start}deg ${end}deg`
    })

  return `conic-gradient(${segments.join(', ')})`
}

export function SystemHealthDashboard({
  currentUserName,
  onModuleSelect,
}: SystemHealthDashboardProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const loadHealth = useCallback(async () => {
    setIsLoading(true)
    setErrorMessage('')

    try {
      const response = await fetch(HEALTH_API_URL, {
        headers: {
          'x-autopal-user': currentUserName,
        },
      })

      if (!response.ok) {
        throw new Error(`Health check failed with status ${response.status}`)
      }

      setHealth((await response.json()) as HealthResponse)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Health dashboard failed to load.',
      )
    } finally {
      setIsLoading(false)
    }
  }, [currentUserName])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void loadHealth()
    }, 0)
    const refreshTimer = window.setInterval(() => {
      void loadHealth()
    }, 30000)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(refreshTimer)
    }
  }, [loadHealth])

  const overall = isLoading && !health
    ? {
        className: 'blue',
        label: 'RUNNING',
        text: 'Health check is running.',
      }
    : overallDisplay[health?.overallStatus ?? 'SYSTEM_ERROR']
  const modules = health?.modules ?? []
  const historyItems = health?.history?.last10HealthChecks ?? []
  const pieBackground = useMemo(
    () => getPieBackground(health?.summary),
    [health?.summary],
  )

  return (
    <section className="system-health-dashboard">
      <div className="section-heading">
        <div>
          <p className="eyebrow">System Health Dashboard</p>
          <h2>Traffic Light Status</h2>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            Auto refresh 30 sec
          </span>
          <Button disabled={isLoading} onClick={() => void loadHealth()}>
            {isLoading ? 'Running' : 'Run Full Health Check'}
          </Button>
        </div>
      </div>

      <div className="health-overview-grid">
        <article className={`health-overall-card ${overall.className}`}>
          <span className="health-status-dot" />
          <div>
            <h3>{overall.label}</h3>
            <p>{overall.text}</p>
          </div>
          <strong>{Number(health?.healthScore ?? 0)}%</strong>
        </article>

        <article className="health-score-card">
          <span>Overall Health Score</span>
          <strong>{Number(health?.healthScore ?? 0)}%</strong>
          <p>Working modules divided by implemented modules.</p>
        </article>

        <article className="health-pie-card">
          <div
            aria-label="Working, warning, failed, and pending modules"
            className="health-pie-chart"
            style={{ background: pieBackground }}
          />
          <div className="health-pie-legend">
            <span><i className="green" /> Working {Number(health?.summary?.green ?? 0)}</span>
            <span><i className="yellow" /> Warning {Number(health?.summary?.yellow ?? 0)}</span>
            <span><i className="red" /> Failed {Number(health?.summary?.red ?? 0)}</span>
            <span><i className="grey" /> Pending {Number(health?.summary?.grey ?? 0)}</span>
          </div>
        </article>
      </div>

      {errorMessage && (
        <div className="health-error-banner">
          {errorMessage}
        </div>
      )}

      <div className="health-modules-grid">
        {modules.map((module) => (
          <button
            className={`health-module-card status-${module.status.toLowerCase()}`}
            key={module.id}
            onClick={() => onModuleSelect(module.targetModule ?? module.id)}
            title={module.tooltip ?? module.message ?? module.name}
            type="button"
          >
            <div className="health-module-title">
              <span className="health-status-dot" />
              <strong>{module.name}</strong>
              <em>{module.badge ?? statusDisplay[module.status].label}</em>
            </div>
            <p>{module.message ?? statusDisplay[module.status].text}</p>
            <dl>
              <div>
                <dt>Last checked</dt>
                <dd>{formatDateTime(module.lastChecked)}</dd>
              </div>
              <div>
                <dt>Last successful run</dt>
                <dd>{formatDateTime(module.lastSuccessfulRun)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{formatDuration(module.durationMs)}</dd>
              </div>
              <div>
                <dt>Avg time</dt>
                <dd>{formatDuration(module.averageDurationMs)}</dd>
              </div>
              <div>
                <dt>Success</dt>
                <dd>{Number(module.successfulRuns ?? 0)}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{Number(module.failedRuns ?? 0)}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{module.version ?? '1.0'}</dd>
              </div>
            </dl>
          </button>
        ))}
      </div>

      <div className="health-bottom-grid">
        <article className="health-history-card">
          <h3>Last Health Check</h3>
          <p>{formatDateTime(health?.history?.lastHealthCheck ?? health?.lastChecked)}</p>
          <div className="health-history-metrics">
            <span>GREEN {Number(health?.history?.greenPercent ?? 0)}%</span>
            <span>Average {formatDuration(health?.history?.averageResponseTimeMs)}</span>
          </div>
          <ol>
            {historyItems.length > 0 ? (
              historyItems.map((item) => (
                <li key={item.testRunId}>
                  <span>{item.testName}</span>
                  <strong>{item.success ? 'GREEN' : 'FAILED'}</strong>
                  <em>{formatDuration(item.durationMs)}</em>
                </li>
              ))
            ) : (
              <li>
                <span>No previous console runs</span>
                <strong>-</strong>
                <em>-</em>
              </li>
            )}
          </ol>
        </article>

        <article className="health-milestone-card">
          <h3>Milestone Progress</h3>
          {(health?.milestones ?? []).map((milestone) => (
            <div className="health-progress-row" key={milestone.label}>
              <div>
                <span>{milestone.label}</span>
                <strong>{milestone.progress}%</strong>
              </div>
              <progress max={100} value={milestone.progress} />
            </div>
          ))}
        </article>
      </div>
    </section>
  )
}

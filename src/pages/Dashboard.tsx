import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import { apiUrl } from '../config/api'
import { calculateDomesticInvoiceSummary, formatCurrency } from '../utils/calculations'
import type { LineItem, SavedPI, ScreenId } from '../types'

type DashboardProps = {
  savedPIs: SavedPI[]
  onNavigate: (screen: ScreenId) => void
}

type DashboardCounts = {
  customers: number
  products: number
}

type PIExtraFields = SavedPI & {
  cgstAmount?: number
  companyName?: string
  custName?: string
  grandTotal?: number
  igstAmount?: number
  netTaxableValue?: number
  sgstAmount?: number
}

type ChartDatum = {
  label: string
  value: number
}

type DateChartDatum = ChartDatum & {
  sortValue: number
}

type ChartMode = 'bar' | 'column' | 'line' | 'pie'
type ChartKey = 'customer' | 'date' | 'product' | 'state'
type DashboardTab = 'overview' | 'recent'

type LineValueItem = LineItem & {
  amount?: number
  basic?: number
  productDescription?: string
  taxableAmount?: number
}

const chartModes: Array<{ label: string; value: ChartMode }> = [
  { label: 'Column', value: 'column' },
  { label: 'Pie', value: 'pie' },
  { label: 'Line', value: 'line' },
  { label: 'Bar', value: 'bar' },
]

const chartColors = [
  '#b5121b',
  '#f59e0b',
  '#2563eb',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#0f766e',
  '#64748b',
]

const CUSTOMER_API_URL = apiUrl('/api/master-customers')
const PRODUCT_API_URL = apiUrl('/api/master-products')

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

const getPICustomerName = (pi: PIExtraFields) =>
  pi.prospectiveCustomerName || pi.custName || pi.customerId || 'Customer pending'

const getPIStateName = (pi: PIExtraFields) =>
  pi.customerState || pi.prospectiveState || 'State pending'

const addChartValue = (values: Map<string, number>, label: string, value: number) => {
  const cleanLabel = label.trim() || 'Pending'
  values.set(cleanLabel, (values.get(cleanLabel) ?? 0) + value)
}

const toTopChartData = (values: Map<string, number>, limit = 8): ChartDatum[] =>
  Array.from(values, ([label, value]) => ({ label, value }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value)
    .slice(0, limit)

const formatCompactCurrency = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 1,
    notation: 'compact',
    style: 'currency',
  }).format(value)

const getLineValue = (line: LineValueItem) => {
  const savedValue = toNumber(line.amount ?? line.basic ?? line.taxableAmount)

  if (savedValue > 0) {
    return savedValue
  }

  return toNumber(line.quantity) * toNumber(line.unitPrice)
}

const polarToCartesian = (
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) => {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  }
}

const describeArc = (
  centerX: number,
  centerY: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) => {
  const start = polarToCartesian(centerX, centerY, radius, endAngle)
  const end = polarToCartesian(centerX, centerY, radius, startAngle)
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1'

  return [
    `M ${centerX} ${centerY}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
    'Z',
  ].join(' ')
}

const BarChart = ({ data }: { data: ChartDatum[] }) => {
  const maxValue = Math.max(...data.map((item) => item.value), 0)

  return (
    <div className="dashboard-bars">
      {data.map((item, index) => (
        <div className="dashboard-bar-row" key={item.label}>
          <div className="dashboard-bar-meta">
            <span title={item.label}>{item.label}</span>
            <strong>{formatCompactCurrency(item.value)}</strong>
          </div>
          <div
            aria-label={`${item.label}: ${formatCurrency(item.value, 'INR')}`}
            className="dashboard-bar-track"
          >
            <span
              className="dashboard-bar-fill"
              style={{
                backgroundColor: chartColors[index % chartColors.length],
                width: `${Math.max(4, (item.value / maxValue) * 100)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

const ColumnChart = ({ data }: { data: ChartDatum[] }) => {
  const maxValue = Math.max(...data.map((item) => item.value), 0)

  return (
    <div className="dashboard-column-chart">
      {data.map((item, index) => (
        <div className="dashboard-column-item" key={item.label}>
          <strong>{formatCompactCurrency(item.value)}</strong>
          <div className="dashboard-column-track">
            <span
              className="dashboard-column-fill"
              style={{
                backgroundColor: chartColors[index % chartColors.length],
                height: `${Math.max(7, (item.value / maxValue) * 100)}%`,
              }}
            />
          </div>
          <span title={item.label}>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

const LineChart = ({ data }: { data: ChartDatum[] }) => {
  const width = 320
  const height = 150
  const padding = 24
  const maxValue = Math.max(...data.map((item) => item.value), 0)
  const points = data.map((item, index) => {
    const x =
      data.length === 1
        ? width / 2
        : padding + (index * (width - padding * 2)) / (data.length - 1)
    const y =
      height - padding - (item.value / maxValue) * (height - padding * 2)

    return { ...item, x, y }
  })

  return (
    <div className="dashboard-line-wrap">
      <svg
        aria-label="Line chart"
        className="dashboard-line-chart"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <line className="dashboard-line-axis" x1={padding} x2={width - padding} y1={height - padding} y2={height - padding} />
        <polyline
          className="dashboard-line-path"
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        />
        {points.map((point, index) => (
          <circle
            className="dashboard-line-point"
            cx={point.x}
            cy={point.y}
            key={point.label}
            r="4"
            style={{ fill: chartColors[index % chartColors.length] }}
          />
        ))}
      </svg>
      <div className="dashboard-chart-legend compact">
        {data.map((item) => (
          <span key={item.label} title={item.label}>
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}

const PieChart = ({ data }: { data: ChartDatum[] }) => {
  const total = data.reduce((sum, item) => sum + item.value, 0)
  let startAngle = 0

  return (
    <div className="dashboard-pie-wrap">
      <svg
        aria-label="Pie chart"
        className="dashboard-pie-chart"
        role="img"
        viewBox="0 0 140 140"
      >
        {data.length === 1 ? (
          <circle cx="70" cy="70" fill={chartColors[0]} r="54" />
        ) : (
          data.map((item, index) => {
            const endAngle = startAngle + (item.value / total) * 360
            const path = describeArc(70, 70, 54, startAngle, endAngle)
            startAngle = endAngle

            return (
              <path
                d={path}
                fill={chartColors[index % chartColors.length]}
                key={item.label}
              />
            )
          })
        )}
      </svg>
      <div className="dashboard-chart-legend">
        {data.map((item, index) => (
          <span key={item.label} title={item.label}>
            <b style={{ backgroundColor: chartColors[index % chartColors.length] }} />
            {item.label}
            <strong>{formatCompactCurrency(item.value)}</strong>
          </span>
        ))}
      </div>
    </div>
  )
}

const ValueChart = ({
  data,
  emptyMessage,
  mode,
  onModeChange,
  title,
}: {
  data: ChartDatum[]
  emptyMessage: string
  mode: ChartMode
  onModeChange: (mode: ChartMode) => void
  title: string
}) => {
  return (
    <section className="panel dashboard-chart-card">
      <div className="dashboard-chart-head">
        <h2>{title}</h2>
        <div aria-label={`${title} chart type`} className="chart-mode-control">
          {chartModes.map((item) => (
            <button
              aria-pressed={mode === item.value}
              className={mode === item.value ? 'active' : ''}
              key={item.value}
              onClick={() => onModeChange(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {data.length === 0 ? (
        <p className="dashboard-chart-empty">{emptyMessage}</p>
      ) : null}
      {data.length > 0 && mode === 'bar' ? <BarChart data={data} /> : null}
      {data.length > 0 && mode === 'column' ? <ColumnChart data={data} /> : null}
      {data.length > 0 && mode === 'line' ? <LineChart data={data} /> : null}
      {data.length > 0 && mode === 'pie' ? <PieChart data={data} /> : null}
    </section>
  )
}

const getPIValue = (pi: PIExtraFields) => {
  const storedGrandTotal = toNumber(pi.grandTotal)

  if (storedGrandTotal > 0) {
    return storedGrandTotal
  }

  const storedHeaderTotal =
    toNumber(pi.netTaxableValue) +
    toNumber(pi.igstAmount) +
    toNumber(pi.cgstAmount) +
    toNumber(pi.sgstAmount) +
    toNumber(pi.freight) +
    toNumber(pi.roundOff)

  if (storedHeaderTotal > 0) {
    return storedHeaderTotal
  }

  return calculateDomesticInvoiceSummary(pi.lineItems, pi.freight, undefined, undefined, {
    additionalDiscountPercent: pi.additionalDiscountPercent,
    buyNFlyPercent: pi.buyNFlyPercent,
    cdPercent: pi.cdPercent,
    cgstPercent: pi.cgstPercent,
    igstPercent: pi.igstPercent,
    otherDiscountPercent: pi.otherDiscountPercent,
    schemeDiscount: pi.schemeDiscount,
    sgstPercent: pi.sgstPercent,
    specialDiscountPercent: pi.specialDiscountPercent,
    todPercent: pi.todPercent,
  }).grandTotal
}

const formatDateTime = (value: string) => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function Dashboard({ savedPIs, onNavigate }: DashboardProps) {
  const [counts, setCounts] = useState<DashboardCounts>({
    customers: 0,
    products: 0,
  })
  const [statusMessage, setStatusMessage] = useState(
    'Loading dashboard',
  )
  const [chartModesByKey, setChartModesByKey] = useState<Record<ChartKey, ChartMode>>({
    customer: 'bar',
    date: 'line',
    product: 'column',
    state: 'pie',
  })
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')

  const updateChartMode = (chartKey: ChartKey, mode: ChartMode) => {
    setChartModesByKey((currentModes) => ({
      ...currentModes,
      [chartKey]: mode,
    }))
  }

  useEffect(() => {
    const loadDashboardCounts = async () => {
      try {
        const [customerResponse, productResponse] = await Promise.all([
          fetch(CUSTOMER_API_URL),
          fetch(PRODUCT_API_URL),
        ])

        if (!customerResponse.ok || !productResponse.ok) {
          throw new Error('Backend not connected')
        }

        const [customers, products] = await Promise.all([
          customerResponse.json(),
          productResponse.json(),
        ])

        setCounts({
          customers: Array.isArray(customers) ? customers.length : 0,
          products: Array.isArray(products) ? products.length : 0,
        })
        setStatusMessage('Dashboard ready')
      } catch (error) {
        setCounts({ customers: 0, products: 0 })
        setStatusMessage(
          error instanceof Error ? error.message : 'Backend not connected',
        )
      }
    }

    void loadDashboardCounts()
  }, [])

  const recentPIs = useMemo(
    () =>
      [...savedPIs]
        .sort((left, right) => {
          const leftTime = new Date(left.updatedAt || left.piDate).getTime()
          const rightTime = new Date(right.updatedAt || right.piDate).getTime()

          return rightTime - leftTime
        })
        .slice(0, 5),
    [savedPIs],
  )

  const totalPIValue = useMemo(
    () =>
      savedPIs.reduce(
        (total, pi) => total + getPIValue(pi as PIExtraFields),
        0,
      ),
    [savedPIs],
  )
  const chartData = useMemo(() => {
    const customerValues = new Map<string, number>()
    const productValues = new Map<string, number>()
    const stateValues = new Map<string, number>()
    const dateValues = new Map<string, DateChartDatum>()

    savedPIs.forEach((pi) => {
      const piRecord = pi as PIExtraFields
      const piValue = getPIValue(piRecord)
      const dateKey = (pi.piDate || pi.updatedAt || '').slice(0, 10)
      const dateLabel = dateKey ? formatDateTime(dateKey) : 'Date pending'
      const sortValue = Number.isFinite(new Date(`${dateKey}T00:00:00`).getTime())
        ? new Date(`${dateKey}T00:00:00`).getTime()
        : 0
      const existingDate = dateValues.get(dateKey || 'Date pending')

      addChartValue(customerValues, getPICustomerName(piRecord), piValue)
      addChartValue(stateValues, getPIStateName(piRecord), piValue)
      dateValues.set(dateKey || 'Date pending', {
        label: dateLabel,
        sortValue,
        value: (existingDate?.value ?? 0) + piValue,
      })

      pi.lineItems.forEach((line) => {
        const lineRecord = line as LineValueItem
        const productLabel =
          line.description ||
          lineRecord.productDescription ||
          line.productCode ||
          'Product pending'

        addChartValue(productValues, productLabel, getLineValue(lineRecord))
      })
    })

    return {
      customerValues: toTopChartData(customerValues),
      dateValues: Array.from(dateValues.values())
        .filter((item) => item.value > 0)
        .sort((left, right) => left.sortValue - right.sortValue)
        .slice(-8)
        .map(({ label, value }) => ({ label, value })),
      productValues: toTopChartData(productValues),
      stateValues: toTopChartData(stateValues),
    }
  }, [savedPIs])
  const draftCount = savedPIs.filter((pi) => pi.status === 'Draft').length

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">AUTOPAL</p>
          <h1>Dashboard</h1>
          <p className="page-subtitle">{statusMessage}</p>
        </div>
        <Button onClick={() => onNavigate('create-pi')}>
          <span className="btn-symbol">+</span>
          New PI
        </Button>
      </header>

      <section className="dashboard-tab-list" aria-label="Dashboard tabs">
        <button
          aria-pressed={activeTab === 'overview'}
          className={activeTab === 'overview' ? 'active' : ''}
          onClick={() => setActiveTab('overview')}
          type="button"
        >
          Dashboard
        </button>
        <button
          aria-pressed={activeTab === 'recent'}
          className={activeTab === 'recent' ? 'active' : ''}
          onClick={() => setActiveTab('recent')}
          type="button"
        >
          Recent Work
        </button>
      </section>

      {activeTab === 'overview' ? (
        <div className="dashboard-tab-panel">
          <section className="dashboard-grid">
            <div className="metric-card accent-red">
              <span>Total PI value</span>
              <strong>{formatCurrency(totalPIValue, 'INR')}</strong>
              <p>{savedPIs.length} saved PI records</p>
            </div>
            <div className="metric-card">
              <span>Customers</span>
              <strong>{counts.customers}</strong>
              <p>Active customer records</p>
            </div>
            <div className="metric-card">
              <span>Products</span>
              <strong>{counts.products}</strong>
              <p>Active product records</p>
            </div>
            <div className="metric-card accent-saffron">
              <span>Draft PIs</span>
              <strong>{draftCount}</strong>
              <p>Draft invoice records</p>
            </div>
          </section>

          <section className="dashboard-chart-grid" aria-label="Dashboard value charts">
            <ValueChart
              data={chartData.customerValues}
              emptyMessage="No customer PI value yet"
              mode={chartModesByKey.customer}
              onModeChange={(mode) => updateChartMode('customer', mode)}
              title="Customer Name + Total PI Value"
            />
            <ValueChart
              data={chartData.productValues}
              emptyMessage="No product value yet"
              mode={chartModesByKey.product}
              onModeChange={(mode) => updateChartMode('product', mode)}
              title="Product + Value"
            />
            <ValueChart
              data={chartData.dateValues}
              emptyMessage="No PI date value yet"
              mode={chartModesByKey.date}
              onModeChange={(mode) => updateChartMode('date', mode)}
              title="PI Date + PI Value"
            />
            <ValueChart
              data={chartData.stateValues}
              emptyMessage="No state PI value yet"
              mode={chartModesByKey.state}
              onModeChange={(mode) => updateChartMode('state', mode)}
              title="State + Value"
            />
          </section>
        </div>
      ) : (
        <section className="panel dashboard-tab-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Recent work</p>
            <h2>Proforma invoices</h2>
          </div>
          <Button onClick={() => onNavigate('pi-preview')} variant="ghost">
            Open preview
          </Button>
        </div>

        <div className="responsive-table">
          <table className="master-table">
            <thead>
              <tr>
                <th>PI number</th>
                <th>Customer</th>
                <th>Company</th>
                <th>PI Date</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentPIs.length === 0 ? (
                <tr>
                  <td colSpan={6}>No proforma invoices found.</td>
                </tr>
              ) : (
                recentPIs.map((pi) => {
                  const piRecord = pi as PIExtraFields

                  return (
                    <tr key={pi.id}>
                      <td>{pi.piNumber}</td>
                      <td>{getPICustomerName(piRecord)}</td>
                      <td>{piRecord.companyName || 'Company pending'}</td>
                      <td>{formatDateTime(pi.piDate)}</td>
                      <td>{formatCurrency(getPIValue(piRecord), pi.currency || 'INR')}</td>
                      <td>
                        <span
                          className={`table-status ${
                            pi.status === 'Final' ? 'saffron' : ''
                          }`}
                        >
                          {pi.status}
                        </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
      )}
    </div>
  )
}

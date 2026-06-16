import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import { apiUrl } from '../config/api'
import { calculateDomesticInvoiceSummary, formatCurrency } from '../utils/calculations'
import type { SavedPI, ScreenId } from '../types'

type DashboardProps = {
  savedPIs: SavedPI[]
  onNavigate: (screen: ScreenId) => void
}

type DashboardCounts = {
  customers: number
  products: number
}

type PIExtraFields = SavedPI & {
  companyName?: string
  custName?: string
  grandTotal?: number
}

const CUSTOMER_API_URL = apiUrl('/api/master-customers')
const PRODUCT_API_URL = apiUrl('/api/master-products')

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

const getPICustomerName = (pi: PIExtraFields) =>
  pi.prospectiveCustomerName || pi.custName || pi.customerId || 'Customer pending'

const getPIValue = (pi: PIExtraFields) => {
  const storedGrandTotal = toNumber(pi.grandTotal)

  if (storedGrandTotal > 0) {
    return storedGrandTotal
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
    'Loading dashboard from PostgreSQL',
  )

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
        setStatusMessage('Dashboard connected to PostgreSQL')
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

      <section className="dashboard-grid">
        <div className="metric-card accent-red">
          <span>Total PI value</span>
          <strong>{formatCurrency(totalPIValue, 'INR')}</strong>
          <p>{savedPIs.length} PostgreSQL PI records</p>
        </div>
        <div className="metric-card">
          <span>Customers</span>
          <strong>{counts.customers}</strong>
          <p>From master_customer</p>
        </div>
        <div className="metric-card">
          <span>Products</span>
          <strong>{counts.products}</strong>
          <p>From master_products</p>
        </div>
        <div className="metric-card accent-saffron">
          <span>Draft PIs</span>
          <strong>{draftCount}</strong>
          <p>From master_pi_rmkt</p>
        </div>
      </section>

      <section className="panel">
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
                  <td colSpan={6}>No proforma invoices found in PostgreSQL.</td>
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
    </div>
  )
}

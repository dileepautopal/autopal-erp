import { useMemo, useState } from 'react'
import { PIPreviewPanel } from '../components/pi/PIPreviewPanel'
import { Button } from '../components/ui/Button'
import type { Company, Customer, PIStatus, SavedPI } from '../types'
import {
  calculateDomesticInvoiceSummary,
  formatCurrency,
} from '../utils/calculations'

type PIListProps = {
  companies: Company[]
  savedPIs: SavedPI[]
  onDelete: (pi: SavedPI) => Promise<void> | void
  onEdit: (pi: SavedPI) => void
  onPreview: (pi: SavedPI) => Promise<SavedPI>
}

type StatusFilter = 'All' | PIStatus
type SortOrder = 'newest' | 'oldest'
type PIExtraFields = SavedPI & {
  companyName?: string
  compCode?: number
  custName?: string
  grandTotal?: number
  gstNo?: string
  stateCode?: number
  company?: Company
  customer?: Customer
}

const formatDate = (value: string) => {
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

const getPICustomerName = (pi: PIExtraFields) =>
  pi.prospectiveCustomerName || pi.custName || pi.customerId || 'Customer pending'

const getPICompany = (pi: PIExtraFields, companies: Company[]) => {
  const company = companies.find((item) => item.id === pi.companyId)
  return company ?? pi.company
}

const getPICompanyName = (pi: PIExtraFields, companies: Company[]) => {
  const company = getPICompany(pi, companies)
  return pi.companyName || company?.legalName || 'Company pending'
}

const toPreviewCustomer = (pi: PIExtraFields): Customer => ({
  id: pi.customerId,
  name: getPICustomerName(pi),
  country: pi.country,
  currency: pi.currency || 'INR',
  state: pi.customerState || pi.prospectiveState,
  stateCode: String(pi.stateCode ?? ''),
  contactPerson: pi.prospectiveCustomerName,
  email: '',
  phone: pi.prospectiveContactNo,
  address: pi.prospectiveAddress,
  placeOfSupply: [pi.customerCity, pi.customerState || pi.prospectiveState]
    .filter(Boolean)
    .join(', '),
  paymentTerms: pi.paymentTerms,
  dispatchTerms: pi.dispatchTerms,
  gstin: pi.prospectiveGstNo || pi.gstNo,
})

export function PIList({
  companies,
  savedPIs,
  onDelete,
  onEdit,
  onPreview,
}: PIListProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All')
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [previewPI, setPreviewPI] = useState<SavedPI | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)

  const enrichedPIs = useMemo(
    () =>
      savedPIs.map((pi) => {
        const piRecord = pi as PIExtraFields
        const company = getPICompany(piRecord, companies)
        const summary = calculateDomesticInvoiceSummary(
          pi.lineItems,
          pi.freight,
          company?.stateCode,
          String(piRecord.stateCode ?? ''),
          {
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
          },
        )
        const storedGrandTotal = Number(piRecord.grandTotal ?? 0)

        return {
          pi,
          companyName: getPICompanyName(piRecord, companies),
          customerName: getPICustomerName(piRecord),
          grandTotal:
            Number.isFinite(storedGrandTotal) && storedGrandTotal > 0
              ? storedGrandTotal
              : summary.grandTotal,
        }
      }),
    [companies, savedPIs],
  )

  const filteredPIs = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()

    return enrichedPIs
      .filter(({ customerName, pi }) => {
        const matchesSearch =
          !normalizedSearch ||
          pi.piNumber.toLowerCase().includes(normalizedSearch) ||
          customerName.toLowerCase().includes(normalizedSearch)
        const matchesStatus =
          statusFilter === 'All' || pi.status === statusFilter

        return matchesSearch && matchesStatus
      })
      .sort((left, right) => {
        const leftTime = new Date(`${left.pi.piDate}T00:00:00`).getTime()
        const rightTime = new Date(`${right.pi.piDate}T00:00:00`).getTime()

        return sortOrder === 'newest' ? rightTime - leftTime : leftTime - rightTime
      })
  }, [enrichedPIs, searchTerm, sortOrder, statusFilter])

  const deletePI = (pi: SavedPI) => {
    const confirmed = window.confirm(
      `Delete ${pi.piNumber}? This removes it from the PI list.`,
    )

    if (confirmed) {
      void onDelete(pi)
      if (previewPI?.id === pi.id) {
        setPreviewPI(null)
      }
    }
  }

  const openPreview = async (pi: SavedPI) => {
    setIsPreviewLoading(true)

    try {
      setPreviewPI(await onPreview(pi))
    } finally {
      setIsPreviewLoading(false)
    }
  }

  const previewCompany = previewPI
    ? getPICompany(previewPI as PIExtraFields, companies)
    : undefined
  const previewCustomer = previewPI
    ? (previewPI as PIExtraFields).customer ??
      toPreviewCustomer(previewPI as PIExtraFields)
    : undefined

  return (
    <div className="page pi-list-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Documents</p>
          <h1>Proforma Invoices</h1>
          <p className="page-subtitle">
            Search, review, edit, and manage saved AUTOPAL proforma invoices
            from your PI records.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            {savedPIs.length} saved {savedPIs.length === 1 ? 'PI' : 'PIs'}
          </span>
        </div>
      </header>

      <section className="panel pi-list-controls">
        <label className="field" htmlFor="pi-search">
          <span className="field-label">Search</span>
          <input
            className="field-control"
            id="pi-search"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by PI number or customer name"
            value={searchTerm}
          />
        </label>
        <label className="field" htmlFor="pi-status-filter">
          <span className="field-label">Status</span>
          <select
            className="field-control select-control"
            id="pi-status-filter"
            onChange={(event) =>
              setStatusFilter(event.target.value as StatusFilter)
            }
            value={statusFilter}
          >
            <option value="All">All status</option>
            <option value="Draft">Draft</option>
            <option value="Final">Final</option>
          </select>
        </label>
        <label className="field" htmlFor="pi-sort">
          <span className="field-label">Sort by date</span>
          <select
            className="field-control select-control"
            id="pi-sort"
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
            value={sortOrder}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </section>

      {savedPIs.length === 0 ? (
        <section className="empty-state panel">
          <p className="eyebrow">No records</p>
          <h2>No proforma invoices exist yet</h2>
          <p>
            Save a draft from Create PI and it will appear here for preview,
            edit, and delete actions.
          </p>
        </section>
      ) : filteredPIs.length === 0 ? (
        <section className="empty-state panel">
          <p className="eyebrow">No matches</p>
          <h2>No PI matches your search</h2>
          <p>Try a different PI number, customer name, or status filter.</p>
        </section>
      ) : (
        <section className="panel pi-data-grid-wrap" aria-label="Saved proforma invoices">
          <table className="pi-data-grid">
            <thead>
              <tr>
                <th>Company Name</th>
                <th>Customer Name</th>
                <th>PI No</th>
                <th>PI Date</th>
                <th>Grand Total</th>
                <th>Preview</th>
                <th>Edit</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {filteredPIs.map(({ companyName, customerName, grandTotal, pi }) => (
                <tr key={pi.id}>
                  <td>
                    <strong>{companyName}</strong>
                  </td>
                  <td>
                    <strong>{customerName}</strong>
                    <small>{pi.status}</small>
                  </td>
                  <td>{pi.piNumber}</td>
                  <td>{formatDate(pi.piDate)}</td>
                  <td className="pi-grid-total">
                    {formatCurrency(grandTotal, pi.currency)}
                  </td>
                  <td>
                    <Button
                      disabled={isPreviewLoading}
                      onClick={() => void openPreview(pi)}
                    >
                      Preview
                    </Button>
                  </td>
                  <td>
                    <Button onClick={() => onEdit(pi)} variant="secondary">
                      Edit
                    </Button>
                  </td>
                  <td>
                    <Button onClick={() => deletePI(pi)} variant="danger">
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {previewPI && (
        <div
          aria-label={`${previewPI.piNumber} preview`}
          aria-modal="true"
          className="preview-modal-backdrop"
          role="dialog"
        >
          <div className="preview-modal">
            <div className="preview-modal-header">
              <div>
                <p className="eyebrow">Preview</p>
                <h2>{previewPI.piNumber}</h2>
              </div>
              <div className="header-actions">
                <Button onClick={() => window.print()} variant="secondary">
                  Generate PDF
                </Button>
                <Button onClick={() => setPreviewPI(null)} variant="ghost">
                  Close
                </Button>
              </div>
            </div>
            <div className="preview-modal-body">
              <PIPreviewPanel
                company={previewCompany}
                customer={previewCustomer}
                form={previewPI}
                mode="full"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { PIPreviewPanel } from '../components/pi/PIPreviewPanel'
import { Button } from '../components/ui/Button'
import { calculatePITotals, formatCurrency } from '../utils/calculations'
import type { Company, Customer, PIFormState, ScreenId } from '../types'

type PIPreviewProps = {
  form: PIFormState
  onNavigate: (screen: ScreenId) => void
}

type PIPreviewForm = PIFormState & {
  cgstAmount?: number
  company?: Company
  companyName?: string
  customer?: Customer
  custName?: string
  grandTotal?: number
  gstNo?: string
  igstAmount?: number
  netTaxableValue?: number
  sgstAmount?: number
  stateCode?: number
}

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

export function PIPreview({ form, onNavigate }: PIPreviewProps) {
  const previewForm = form as PIPreviewForm
  const selectedCompany = previewForm.company
  const selectedCustomer =
    previewForm.customer ??
    ({
      id: form.customerId,
      name:
        form.prospectiveCustomerName ||
        previewForm.custName ||
        'Customer pending',
      country: form.country,
      currency: form.currency || 'INR',
      state: form.customerState || form.prospectiveState,
      stateCode: String(previewForm.stateCode ?? ''),
      contactPerson: form.prospectiveCustomerName,
      email: '',
      phone: form.prospectiveContactNo,
      address: form.prospectiveAddress,
      placeOfSupply: [form.customerCity, form.customerState || form.prospectiveState]
        .filter(Boolean)
        .join(', '),
      paymentTerms: form.paymentTerms,
      dispatchTerms: form.dispatchTerms,
      gstin: form.prospectiveGstNo || previewForm.gstNo,
    } satisfies Customer)
  const totals = calculatePITotals(form.lineItems, form.freight, form.discount)
  const storedHeaderTotal =
    toNumber(previewForm.grandTotal) ||
    toNumber(previewForm.netTaxableValue) +
      toNumber(previewForm.igstAmount) +
      toNumber(previewForm.cgstAmount) +
      toNumber(previewForm.sgstAmount) +
      toNumber(form.freight) +
      toNumber(form.roundOff)
  const grandTotal = storedHeaderTotal > 0 ? storedHeaderTotal : totals.grandTotal

  return (
    <div className="page preview-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Document</p>
          <h1>PI Preview</h1>
          <p className="page-subtitle">
            Review the domestic GST proforma invoice before PDF generation.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            {formatCurrency(grandTotal, form.currency || 'INR')}
          </span>
          <Button onClick={() => onNavigate('create-pi')} variant="secondary">
            Edit PI
          </Button>
          <Button onClick={() => window.print()}>Generate PDF</Button>
        </div>
      </header>

      <PIPreviewPanel
        company={selectedCompany}
        customer={selectedCustomer}
        form={form}
        mode="full"
      />
    </div>
  )
}

import { PIPreviewPanel } from '../components/pi/PIPreviewPanel'
import { Button } from '../components/ui/Button'
import { calculatePITotals, formatCurrency } from '../utils/calculations'
import type { Company, Customer, PIFormState, ScreenId } from '../types'

type PIPreviewProps = {
  form: PIFormState
  onNavigate: (screen: ScreenId) => void
}

type PIPreviewForm = PIFormState & {
  company?: Company
  companyName?: string
  customer?: Customer
  custName?: string
  gstNo?: string
  stateCode?: number
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
            {formatCurrency(totals.grandTotal, form.currency)}
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

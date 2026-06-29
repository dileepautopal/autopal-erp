import {
  calculateDomesticInvoiceSummary,
  calculateLines,
  formatAmountInWords,
} from '../../utils/calculations'
import type { Company, Customer, PIFormState } from '../../types'

type PIPreviewPanelProps = {
  company?: Company
  customer?: Customer
  form: PIFormState
  mode?: 'compact' | 'full'
}

type PIPreviewForm = PIFormState & {
  additionalDiscountAmount?: number
  amountAfterDiscount?: number
  basicValue?: number
  buyNFlyAmount?: number
  cdAmount?: number
  cgstAmount?: number
  companyName?: string
  grandTotal?: number
  igstAmount?: number
  netBasicValue?: number
  netTaxableValue?: number
  otherDiscountAmount?: number
  sgstAmount?: number
  specialDiscountAmount?: number
  todAmount?: number
}

type SummaryRow = {
  label: string
  sectionBreak?: boolean
  value?: number
  strong?: boolean
}

const moneyFormat = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const integerFormat = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
})

const formatDate = (value: string) => {
  if (!value) {
    return ''
  }

  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date).replace(/ /g, '-')
}

const amountWords = (value: number) =>
  formatAmountInWords(Math.round(value), 'INR').replace('Indian Rupees', 'Rupees')

const dashForZero = (value?: number) =>
  !value ? '-' : moneyFormat.format(value)

const percentLabel = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(value)

const roundSummaryMoney = (value: number) => Math.round(value * 100) / 100

const toSummaryNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

const getStateDisplay = (customer?: Customer) =>
  [customer?.state, customer?.stateCode ? `(${customer.stateCode})` : '']
    .filter(Boolean)
    .join(' ')

const getValidUntil = (form: PIFormState) =>
  form.validUntil || form.deliveryDate || form.piDate

const getTerms = (form: PIFormState) => {
  if (form.terms.trim()) {
    return form.terms
      .split('\n')
      .map((term) => term.trim())
      .filter(Boolean)
  }

  return [
    'Prices are firm and valid only up to the validity date mentioned above.',
    'Goods once sold will not be taken back or exchanged.',
    'No complaint will be entertained after 7 days from the date of delivery.',
    'Our responsibility ceases when goods are delivered to the party or transporter.',
    'Interest @ 18% p.a. will be charged on delayed payments.',
    'Subject to Jaipur Jurisdiction only.',
    'E. & O.E.',
  ]
}

const compactAddressLines = (value = '') =>
  value
    .split(',')
    .map((line) => line.trim())
    .filter(Boolean)

const formatCompanyTitle = (company: Company | undefined, form: PIPreviewForm) =>
  company?.legalName || form.companyName || company?.name || 'Company pending'

const footerPhoneNumber = '7733850017'

export function PIPreviewPanel({
  company,
  customer,
  form,
  mode = 'compact',
}: PIPreviewPanelProps) {
  const previewForm = form as PIPreviewForm
  const calculatedLines = calculateLines(form.lineItems)
  const visibleLines = calculatedLines.filter(
    (line) => line.productCode || line.description,
  )
  const calculatedSummary = calculateDomesticInvoiceSummary(
    form.lineItems,
    form.freight,
    company?.stateCode,
    customer?.stateCode,
    {
      additionalDiscountPercent: form.additionalDiscountPercent,
      buyNFlyPercent: form.buyNFlyPercent,
      cdPercent: form.cdPercent,
      cgstPercent: form.cgstPercent,
      igstPercent: form.igstPercent,
      otherDiscountPercent: form.otherDiscountPercent,
      schemeDiscount: form.schemeDiscount,
      sgstPercent: form.sgstPercent,
      specialDiscountPercent: form.specialDiscountPercent,
      todPercent: form.todPercent,
    },
  )
  const storedBasicValue = toSummaryNumber(previewForm.basicValue)
  const storedNetBasicValue = toSummaryNumber(previewForm.netBasicValue)
  const storedSpecialDiscount = toSummaryNumber(previewForm.specialDiscountAmount)
  const storedOtherDiscount = toSummaryNumber(previewForm.otherDiscountAmount)
  const storedAmountAfterDiscount = roundSummaryMoney(
    storedNetBasicValue - storedSpecialDiscount - storedOtherDiscount,
  )
  const storedNetTaxableValue = toSummaryNumber(previewForm.netTaxableValue)
  const storedIgst = toSummaryNumber(previewForm.igstAmount)
  const storedCgst = toSummaryNumber(previewForm.cgstAmount)
  const storedSgst = toSummaryNumber(previewForm.sgstAmount)
  const storedFreight = toSummaryNumber(form.freight)
  const storedRoundOff = toSummaryNumber(form.roundOff)
  const storedGrandTotal = toSummaryNumber(previewForm.grandTotal)
  const hasStoredSummary =
    storedGrandTotal > 0 || storedNetTaxableValue > 0 || storedBasicValue > 0
  const invoiceSummary = hasStoredSummary
    ? {
        ...calculatedSummary,
        additionalDiscount: toSummaryNumber(previewForm.additionalDiscountAmount),
        amountAfterDiscount:
          storedAmountAfterDiscount > 0
            ? storedAmountAfterDiscount
            : calculatedSummary.amountAfterDiscount,
        buyNFlyDiscount: toSummaryNumber(previewForm.buyNFlyAmount),
        cashDiscount: toSummaryNumber(previewForm.cdAmount),
        cgst: storedCgst,
        freight: storedFreight,
        grandTotal:
          storedGrandTotal > 0
            ? storedGrandTotal
            : roundSummaryMoney(
                storedNetTaxableValue +
                  storedIgst +
                  storedCgst +
                  storedSgst +
                  storedFreight +
                  storedRoundOff,
              ),
        igst: storedIgst,
        isIntraState: storedIgst <= 0 && (storedCgst > 0 || storedSgst > 0),
        netTaxableValue: storedNetTaxableValue || calculatedSummary.netTaxableValue,
        netTotal: storedNetBasicValue || calculatedSummary.netTotal,
        otherDiscount: storedOtherDiscount,
        roundOff: storedRoundOff,
        schemeDiscount: toSummaryNumber(form.schemeDiscount),
        sgst: storedSgst,
        specialDiscount: storedSpecialDiscount,
        taxTotal: storedIgst + storedCgst + storedSgst,
        todDiscount: toSummaryNumber(previewForm.todAmount),
        total: storedBasicValue || calculatedSummary.total,
      }
    : calculatedSummary
  const productRows = [
    ...visibleLines,
    ...Array.from({ length: Math.max(0, 10 - visibleLines.length) }, (_, index) => ({
      id: `blank-${index}`,
      productCode: '',
      description: '',
      hsnCode: '',
      quantity: 0,
      unit: '',
      unitPrice: 0,
      taxableAmount: 0,
    })),
  ].slice(0, 10)
  const companyAddressLines = compactAddressLines(company?.address)
  const terms = getTerms(form)
  const schemeDiscountPercent = invoiceSummary.total
    ? (invoiceSummary.schemeDiscount / invoiceSummary.total) * 100
    : 0
  const taxRows: SummaryRow[] =
    invoiceSummary.igst > 0
      ? [{ label: `IGST @ ${percentLabel(form.igstPercent)}%`, value: invoiceSummary.igst }]
      : invoiceSummary.cgst > 0 || invoiceSummary.sgst > 0
        ? [
            { label: `CGST @ ${percentLabel(form.cgstPercent)}%`, value: invoiceSummary.cgst },
            { label: `SGST @ ${percentLabel(form.sgstPercent)}%`, value: invoiceSummary.sgst },
          ]
        : []
  const summaryRows: SummaryRow[] = [
    { label: 'Total', value: invoiceSummary.total, strong: true },
    {
      label: `Scheme Dis. @ ${percentLabel(schemeDiscountPercent)}%`,
      value: invoiceSummary.schemeDiscount,
    },
    { label: 'Net Total', value: invoiceSummary.netTotal, strong: true },
    {
      label: `Spcl. Dis. @ ${percentLabel(form.specialDiscountPercent)}%`,
      value: invoiceSummary.specialDiscount,
    },
    {
      label: `Oth. Dis. @ ${percentLabel(form.otherDiscountPercent)}%`,
      value: invoiceSummary.otherDiscount,
    },
    {
      label: 'Amount After Discount',
      value: invoiceSummary.amountAfterDiscount,
      strong: true,
    },
    {
      label: `Cash Dis. @ ${percentLabel(form.cdPercent)}%`,
      value: invoiceSummary.cashDiscount,
    },
    {
      label: `TOD @ ${percentLabel(form.todPercent)}%`,
      value: invoiceSummary.todDiscount,
    },
    {
      label: `Buy & Fly Dis. @ ${percentLabel(form.buyNFlyPercent)}%`,
      value: invoiceSummary.buyNFlyDiscount,
    },
    {
      label: 'Taxable Value',
      sectionBreak: true,
      value: invoiceSummary.netTaxableValue,
      strong: true,
    },
    ...taxRows,
    { label: 'TCS @ 0%', value: invoiceSummary.tcs },
    { label: 'Freight Amount', sectionBreak: true, value: invoiceSummary.freight },
    { label: 'Other Charges', value: invoiceSummary.otherCharges },
    { label: 'Round Off (+/-)', value: invoiceSummary.roundOff },
  ]

  return (
    <aside className={`preview-panel ${mode === 'full' ? 'preview-full' : ''}`}>
      <div className="a4-preview-frame">
        <div className="invoice-paper ail-pi-sheet a4-invoice-sheet">
          <div className="ail-orange-ribbon ail-orange-ribbon-top" />
          <header className="ail-pi-header">
            <div className="ail-logo-panel">
              <img alt="AUTOPAL" className="ail-logo-image" src="/autopal-logo.png" />
            </div>

            <div className="ail-company-head">
              <h1>PROFORMA INVOICE</h1>
              <h2>{formatCompanyTitle(company, previewForm)}</h2>
              <p>{companyAddressLines.slice(0, 2).join(', ')}</p>
              <p>{companyAddressLines.slice(2).join(', ')}</p>
              <p className="ail-company-ids">
                <strong>CIN :</strong> {company?.cin || '-'}
                <b>|</b>
                <strong>GSTIN :</strong> {company?.gstin || '-'}
              </p>
            </div>

            <section className="ail-pi-details">
              <h3>PI DETAILS</h3>
              <dl>
                <div>
                  <dt>PI No.</dt>
                  <dd>{form.piNumber || '-'}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>{formatDate(form.piDate) || '-'}</dd>
                </div>
                <div>
                  <dt>Valid Upto</dt>
                  <dd>{formatDate(getValidUntil(form)) || '-'}</dd>
                </div>
                <div>
                  <dt>Place of Supply</dt>
                  <dd>{customer?.placeOfSupply || form.customerCity || '-'}</dd>
                </div>
                <div>
                  <dt>State Code</dt>
                  <dd>{customer?.stateCode || form.stateCode || '-'}</dd>
                </div>
                <div>
                  <dt>Reverse Charge</dt>
                  <dd>No</dd>
                </div>
                <div>
                  <dt>Currency</dt>
                  <dd>{form.currency || customer?.currency || 'INR'}</dd>
                </div>
              </dl>
            </section>
          </header>

          <section className="ail-party-grid">
            <div className="ail-box ail-billing-box">
              <h3>BILLING PARTY</h3>
              <div className="ail-box-content">
                <h4>{customer?.name || form.prospectiveCustomerName || 'Customer pending'}</h4>
                <p>{customer?.address || form.prospectiveAddress || '-'}</p>
                <p>GSTIN : {customer?.gstin || form.prospectiveGstNo || '-'}</p>
                <p>State : {getStateDisplay(customer) || form.customerState || '-'}</p>
              </div>
            </div>

            <div className="ail-box ail-dispatch-box">
              <h3>SHIPPING / DISPATCH DETAILS</h3>
              <div className="ail-dispatch-content">
                <dl>
                  <div>
                    <dt>Transporter</dt>
                    <dd>{form.transporter || ''}</dd>
                  </div>
                  <div>
                    <dt>Mode of Transport</dt>
                    <dd>{form.transportMode || form.dispatchTerms || 'BY ROAD'}</dd>
                  </div>
                  <div>
                    <dt>Destination</dt>
                    <dd>{form.destination || customer?.placeOfSupply || ''}</dd>
                  </div>
                  <div>
                    <dt>Vehicle Regn. No.</dt>
                    <dd></dd>
                  </div>
                  <div>
                    <dt>No. of Packages</dt>
                    <dd></dd>
                  </div>
                  <div>
                    <dt>GR No.</dt>
                    <dd></dd>
                  </div>
                  <div>
                    <dt>Challan No.</dt>
                    <dd></dd>
                  </div>
                </dl>
                <dl>
                  <div>
                    <dt>Vendor Code</dt>
                    <dd>{customer?.vendorCode || ''}</dd>
                  </div>
                  <div>
                    <dt>Party's PO No.</dt>
                    <dd>{form.custPoNo || customer?.partyPoNumber || ''}</dd>
                  </div>
                  <div>
                    <dt>E-mail</dt>
                    <dd>{customer?.email || ''}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>

          <table className="ail-products-table">
            <thead>
              <tr>
                <th>S. No.</th>
                <th>Product Code</th>
                <th>Description & Specification of Goods</th>
                <th>HSN Code</th>
                <th>Qty.</th>
                <th>Unit</th>
                <th>Rate (&#8377;)</th>
                <th>Amount (&#8377;)</th>
              </tr>
            </thead>
            <tbody>
              {productRows.map((line, index) => (
                <tr key={line.id}>
                  <td>{index + 1}</td>
                  <td>{line.productCode}</td>
                  <td>{line.description}</td>
                  <td>{line.hsnCode}</td>
                  <td>{line.quantity ? integerFormat.format(line.quantity) : ''}</td>
                  <td>{line.unit}</td>
                  <td>{line.unitPrice ? moneyFormat.format(line.unitPrice) : ''}</td>
                  <td>
                    {line.taxableAmount
                      ? moneyFormat.format(line.taxableAmount)
                      : '-'}
                  </td>
                </tr>
              ))}
              <tr className="ail-total-qty-row">
                <td colSpan={8}>
                  <div className="ail-total-qty-line">
                    <span className="ail-tax-note-cell">
                      NOTE : Taxes are round off to the nearest number.
                    </span>
                    <span className="ail-total-qty-group">
                      <span className="ail-total-label">Total Quantity</span>
                      <span className="ail-total-value">
                        {integerFormat.format(invoiceSummary.totalQuantity)}
                      </span>
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <section className="ail-lower-grid">
            <div className="ail-left-stack">
              <div className="ail-box ail-words-box">
                <h3>AMOUNT IN WORDS</h3>
                <p>{amountWords(invoiceSummary.grandTotal)}</p>
              </div>
              <div className="ail-box ail-terms-box">
                <h3>TERMS & CONDITIONS</h3>
                <ol>
                  {terms.map((term) => (
                    <li key={term}>{term}</li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="ail-box ail-bank-box">
              <h3>BANK DETAILS FOR PAYMENT</h3>
              <dl>
                <div>
                  <dt>Bank Name</dt>
                  <dd>{company?.bankDetails.bankName || '-'}</dd>
                </div>
                <div className="ail-bank-account-row">
                  <dt>Account Name</dt>
                  <dd className="ail-bank-account-name">
                    {company?.bankDetails.accountName || company?.legalName || '-'}
                  </dd>
                </div>
                <div className="ail-bank-account-number-row">
                  <dt>Account No.</dt>
                  <dd>{company?.bankDetails.accountNumber || '-'}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{company?.bankDetails.branch || '-'}</dd>
                </div>
                <div>
                  <dt>IFSC Code</dt>
                  <dd>{company?.bankDetails.ifsc || '-'}</dd>
                </div>
              </dl>
            </div>

            <div className="ail-summary-box">
              <table>
                <tbody>
                  {summaryRows.map((row) => (
                    <tr
                      className={[
                        row.strong ? 'ail-strong-row' : '',
                        row.sectionBreak ? 'ail-summary-break-row' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={row.label}
                    >
                      <td>{row.label}</td>
                      <td>{dashForZero(row.value)}</td>
                    </tr>
                  ))}
                  <tr className="ail-grand-total-row">
                    <td>GRAND TOTAL (&#8377;)</td>
                    <td>{moneyFormat.format(invoiceSummary.grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="ail-signature-grid">
            <div>
              <strong>PREPARED BY</strong>
              <span></span>
            </div>
            <div>
              <strong>CHECKED BY</strong>
              <span></span>
            </div>
            <div>
              <strong>For {company?.legalName || company?.name || 'Company'}</strong>
              <b>Authorized Signatory</b>
            </div>
          </section>

          <footer className="ail-footer">
            <div className="ail-footer-contact-row">
              <span className="ail-footer-contact-item">
                <svg
                  aria-hidden="true"
                  className="ail-footer-icon"
                  viewBox="0 0 24 24"
                >
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.32 1.77.59 2.61a2 2 0 0 1-.45 2.11L8 9.69a16 16 0 0 0 6.31 6.31l1.25-1.25a2 2 0 0 1 2.11-.45c.84.27 1.71.47 2.61.59A2 2 0 0 1 22 16.92z" />
                </svg>
                <strong>Phone :</strong>
                <span>{footerPhoneNumber}</span>
              </span>
              <span className="ail-footer-contact-separator"></span>
              <span className="ail-footer-contact-item">
                <svg
                  aria-hidden="true"
                  className="ail-footer-icon"
                  viewBox="0 0 24 24"
                >
                  <path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 3.2 8 5.3 8-5.3V6l-8 5.3L4 6v1.2z" />
                </svg>
                <strong>E-mail :</strong>
                <span>{company?.email || '-'}</span>
              </span>
            </div>
            <ul className="ail-footer-product-row">
              <li>HALOGEN BULBS</li>
              <li>HEAD LAMPS</li>
              <li>LED LIGHTING</li>
              <li>AUXILIARY LAMPS</li>
              <li>WORK LAMPS</li>
            </ul>
          </footer>
          <div className="ail-orange-ribbon ail-orange-ribbon-bottom" />
        </div>
      </div>
    </aside>
  )
}

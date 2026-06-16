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

type SummaryRow = {
  label: string
  value?: number
  strong?: boolean
}

const numberFormat = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
})

const integerFormat = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
})

const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

const amountWords = (value: number) =>
  formatAmountInWords(Math.round(value), 'INR').replace('Indian Rupees', 'Rupees')

export function PIPreviewPanel({
  company,
  customer,
  form,
  mode = 'compact',
}: PIPreviewPanelProps) {
  const calculatedLines = calculateLines(form.lineItems)
  const visibleLines = calculatedLines.filter(
    (line) => line.productCode || line.description,
  )
  const invoiceSummary = calculateDomesticInvoiceSummary(
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

  const summaryRows: SummaryRow[] = [
    { label: 'Total', value: invoiceSummary.total, strong: true },
    { label: 'Scheme Discount', value: invoiceSummary.schemeDiscount },
    { label: 'Net Total', value: invoiceSummary.netTotal, strong: true },
    {
      label: `Spcl. Dis. @ ${numberFormat.format(form.specialDiscountPercent)}%`,
      value: invoiceSummary.specialDiscount,
    },
    {
      label: `Oth. Dis. @ ${numberFormat.format(form.otherDiscountPercent)}%`,
      value: invoiceSummary.otherDiscount,
    },
    {
      label: 'Amount After Discount',
      value: invoiceSummary.amountAfterDiscount,
      strong: true,
    },
    {
      label: `TOD Dis. @ ${numberFormat.format(form.todPercent)}%`,
      value: invoiceSummary.todDiscount,
    },
    {
      label: `Cash Dis. @ ${numberFormat.format(form.cdPercent)}%`,
      value: invoiceSummary.cashDiscount,
    },
    {
      label: `Other Discount @ ${numberFormat.format(
        form.additionalDiscountPercent,
      )}%`,
      value: invoiceSummary.additionalDiscount,
    },
    {
      label: `Buy N Fly @ ${numberFormat.format(form.buyNFlyPercent)}%`,
      value: invoiceSummary.buyNFlyDiscount,
    },
    {
      label: 'Net Taxable Value',
      value: invoiceSummary.netTaxableValue,
      strong: true,
    },
    { label: `IGST @ ${numberFormat.format(form.igstPercent)}%`, value: invoiceSummary.igst },
    { label: `CGST @ ${numberFormat.format(form.cgstPercent)}%`, value: invoiceSummary.cgst },
    { label: `SGST @ ${numberFormat.format(form.sgstPercent)}%`, value: invoiceSummary.sgst },
    { label: 'TCS @ 0 %', value: invoiceSummary.tcs },
    { label: 'Freight Amount', value: invoiceSummary.freight },
    { label: 'Other Charges', value: invoiceSummary.otherCharges },
    { label: 'Round Off', value: invoiceSummary.roundOff },
    { label: 'Grand Total', value: invoiceSummary.grandTotal, strong: true },
  ]

  const fillerRows = Math.max(2, 8 - visibleLines.length)

  return (
    <aside className={`preview-panel ${mode === 'full' ? 'preview-full' : ''}`}>
      <div className="a4-preview-frame">
        <div className="invoice-paper excel-invoice a4-invoice-sheet">
          <table className="excel-pi-table">
            <colgroup>
              <col className="col-sno" />
              <col className="col-code" />
              <col className="col-description" />
              <col className="col-hsn" />
              <col className="col-qty" />
              <col className="col-unit" />
              <col className="col-rate" />
              <col className="col-amount" />
              <col className="col-summary-label" />
              <col className="col-summary-value" />
            </colgroup>
            <tbody>
            <tr className="excel-title-row">
              <td colSpan={3} rowSpan={2}>
                <div className="autopal-logo-block">
                  <div className="autopal-logo-mark">AUTOPAL</div>
                  <span>Excellence in Lighting</span>
                </div>
              </td>
              <td className="invoice-main-title" colSpan={5} rowSpan={2}>
                PROFORMA INVOICE
              </td>
              <td className="text-right bold" colSpan={2}>
                Original
              </td>
            </tr>
            <tr>
              <td colSpan={2}></td>
            </tr>

            <tr>
              <td className="bold" colSpan={5}>
                {company?.legalName ?? 'Company pending'}
              </td>
              <td className="bold" colSpan={5}>
                {customer?.name ?? 'Customer pending'}
              </td>
            </tr>
            <tr>
              <td colSpan={5}>{company?.address}</td>
              <td colSpan={5}>{customer?.address}</td>
            </tr>
            <tr>
              <td colSpan={5}>
                Phone&nbsp;&nbsp;:&nbsp;&nbsp; {company?.phone}
              </td>
              <td colSpan={5}>Phone&nbsp;:&nbsp;&nbsp; {customer?.phone}</td>
            </tr>
            <tr>
              <td colSpan={3}>E-mail&nbsp;:&nbsp;&nbsp; {company?.email}</td>
              <td colSpan={2}>Web&nbsp;:&nbsp; {company?.website}</td>
              <td colSpan={2}>State Code&nbsp;:&nbsp;&nbsp; {customer?.stateCode}</td>
              <td colSpan={3}>State&nbsp;:&nbsp;&nbsp; {customer?.state.toUpperCase()}</td>
            </tr>
            <tr>
              <td colSpan={5}>CIN&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:&nbsp;&nbsp; {company?.cin}</td>
              <td colSpan={5}>
                Place of Supply&nbsp;:&nbsp; {customer?.placeOfSupply}
              </td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                GSTIN NO :
              </td>
              <td className="bold" colSpan={3}>
                {company?.gstin}
              </td>
              <td className="center bold" colSpan={2} rowSpan={2}>
                PI NO.
                <br />
                {form.piNumber}
              </td>
              <td className="center bold" colSpan={3} rowSpan={2}>
                Date : {formatDate(form.piDate)}
              </td>
            </tr>
            <tr>
              <td className="bold" colSpan={5}>
                Tax is Payable On Reverse Charge (Yes/No): No
              </td>
            </tr>

            <tr>
              <td className="bold" colSpan={3}>
                Challan No. :
              </td>
              <td className="bold" colSpan={2}>
                Date :
              </td>
              <td className="bold" colSpan={3}>
                Party&apos;s GSTIN No. :
              </td>
              <td className="bold" colSpan={2}>
                {customer?.gstin ?? ''}
              </td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                Mode of Transport:
              </td>
              <td colSpan={3}>{form.dispatchTerms}</td>
              <td colSpan={3}>Party&apos;s PO No. :</td>
              <td colSpan={2}>{customer?.partyPoNumber ?? ''}</td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                Vehicle Regn. No. :
              </td>
              <td colSpan={3}></td>
              <td colSpan={3}>Vendor Code :</td>
              <td colSpan={2}>{customer?.vendorCode ?? ''}</td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                No. of Packages :
              </td>
              <td colSpan={3}></td>
              <td colSpan={3}>Email :</td>
              <td colSpan={2}>{customer?.email}</td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                Transporter :
              </td>
              <td colSpan={3}></td>
              <td colSpan={5} rowSpan={3}></td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                Destination :
              </td>
              <td colSpan={3}>{customer?.placeOfSupply}</td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                GR No. :
              </td>
              <td colSpan={3}></td>
            </tr>

            <tr className="product-header-row">
              <th>S. NO</th>
              <th>Product Code</th>
              <th>Description & Specification of Goods</th>
              <th>HSN Code</th>
              <th>Qty.</th>
              <th>Unit</th>
              <th>Rate</th>
              <th>Amount</th>
              <th colSpan={2}>Remarks</th>
            </tr>

            {visibleLines.map((line, index) => (
              <tr className="product-row" key={line.id}>
                <td className="center">{index + 1}</td>
                <td className="center">{line.productCode}</td>
                <td>{line.description}</td>
                <td className="center">{line.hsnCode}</td>
                <td className="number-cell">{integerFormat.format(line.quantity)}</td>
                <td className="center">{line.unit}</td>
                <td className="number-cell">{numberFormat.format(line.unitPrice)}</td>
                <td className="number-cell">
                  {numberFormat.format(line.taxableAmount)}
                </td>
                <td colSpan={2}></td>
              </tr>
            ))}

            {Array.from({ length: fillerRows }).map((_, index) => (
              <tr className="blank-product-row" key={`blank-${index}`}>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td colSpan={2}></td>
              </tr>
            ))}

            {summaryRows.map((row, index) => (
              <tr className="summary-row" key={row.label}>
                {index === 0 ? (
                  <>
                    <td colSpan={4}></td>
                    <td className="number-cell bold">
                      {integerFormat.format(invoiceSummary.totalQuantity)}
                    </td>
                    <td colSpan={3}></td>
                  </>
                ) : (
                  <td colSpan={8}></td>
                )}
                <td className={row.strong ? 'bold' : ''}>{row.label}</td>
                <td className={`number-cell ${row.strong ? 'bold' : ''}`}>
                  {row.value === undefined ? '' : numberFormat.format(row.value)}
                </td>
              </tr>
            ))}

            <tr>
              <td className="bold" colSpan={2}>
                Tax Value (INR) :
              </td>
              <td className="bold" colSpan={6}>
                {amountWords(invoiceSummary.taxTotal)}
              </td>
              <td colSpan={2}></td>
            </tr>
            <tr>
              <td className="bold" colSpan={2}>
                Inv. Value (INR) :
              </td>
              <td className="bold" colSpan={6}>
                {amountWords(invoiceSummary.grandTotal)}
              </td>
              <td colSpan={2}></td>
            </tr>
            <tr>
              <td colSpan={10}>
                Certified that particulars given above are true and correct and
                the amount indicated represents the price actually charged and
                that there is no additional consideration directly or indirectly
                from the buyer.
              </td>
            </tr>
            <tr>
              <td className="bold" colSpan={3}>
                Terms & Conditions :
              </td>
              <td className="center bold" colSpan={3}>
                E. & O.E
              </td>
              <td className="text-right bold" colSpan={4}>
                For {company?.legalName ?? 'Company pending'}
              </td>
            </tr>
            <tr>
              <td colSpan={10}>1. Subject to Jaipur Jurisdiction.</td>
            </tr>
            <tr>
              <td colSpan={10}>
                2. No complaints will be entertained after 7 days from the date
                of delivery of goods.
              </td>
            </tr>
            <tr>
              <td colSpan={10}>
                3. Our responsibility ceases when the goods are delivered to the
                party or the courier / transporter.
              </td>
            </tr>
            <tr className="signature-row">
              <td className="bold" colSpan={3}>
                Prepared by
              </td>
              <td className="center bold" colSpan={3}>
                Checked by
              </td>
              <td className="text-right bold" colSpan={4}>
                Authorised Signatory
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>
    </aside>
  )
}

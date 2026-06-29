import type { GSTBreakup, LineCalculation, LineItem, PITotals } from '../types'

const roundMoney = (value: number) => Math.round(value * 100) / 100

const cleanNumber = (value: number) => (Number.isFinite(value) ? value : 0)

type DomesticInvoiceSummaryOptions = {
  additionalDiscountPercent?: number
  buyNFlyPercent?: number
  cdPercent?: number
  cgstPercent?: number
  igstPercent?: number
  otherDiscountPercent?: number
  schemeDiscount?: number
  sgstPercent?: number
  specialDiscountPercent?: number
  todPercent?: number
}

export const calculateLine = (line: LineItem): LineCalculation => {
  const quantity = cleanNumber(line.quantity)
  const unitPrice = cleanNumber(line.unitPrice)
  const gstPercent = cleanNumber(line.gstPercent)
  const taxableAmount = roundMoney(quantity * unitPrice)
  const gstAmount = roundMoney((taxableAmount * gstPercent) / 100)

  return {
    ...line,
    taxableAmount,
    gstAmount,
    lineTotal: roundMoney(taxableAmount + gstAmount),
  }
}

export const calculateLines = (lineItems: LineItem[]) =>
  lineItems.map((line) => calculateLine(line))

export const calculatePITotals = (
  lineItems: LineItem[],
  freight: number,
  discount: number,
): PITotals => {
  const calculatedLines = calculateLines(lineItems)
  const subtotal = roundMoney(
    calculatedLines.reduce((sum, line) => sum + line.taxableAmount, 0),
  )
  const gstTotal = roundMoney(
    calculatedLines.reduce((sum, line) => sum + line.gstAmount, 0),
  )
  const freightTotal = roundMoney(cleanNumber(freight))
  const discountTotal = roundMoney(cleanNumber(discount))

  return {
    subtotal,
    gstTotal,
    freight: freightTotal,
    discount: discountTotal,
    grandTotal: roundMoney(subtotal + gstTotal + freightTotal - discountTotal),
  }
}

export const calculateGSTBreakup = (
  lineItems: LineItem[],
  sellerStateCode?: string,
  buyerStateCode?: string,
): GSTBreakup => {
  const totals = calculatePITotals(lineItems, 0, 0)
  const isIntraState =
    Boolean(sellerStateCode && buyerStateCode) &&
    sellerStateCode === buyerStateCode
  const halfGst = roundMoney(totals.gstTotal / 2)

  if (isIntraState) {
    return {
      taxType: 'intra-state',
      cgstTotal: halfGst,
      sgstTotal: roundMoney(totals.gstTotal - halfGst),
      igstTotal: 0,
      gstTotal: totals.gstTotal,
    }
  }

  return {
    taxType: 'inter-state',
    cgstTotal: 0,
    sgstTotal: 0,
    igstTotal: totals.gstTotal,
    gstTotal: totals.gstTotal,
  }
}

export const calculateDomesticInvoiceSummary = (
  lineItems: LineItem[],
  freight: number,
  sellerStateCode?: string,
  buyerStateCode?: string,
  options: DomesticInvoiceSummaryOptions = {},
) => {
  const calculatedLines = calculateLines(lineItems)
  const totalQuantity = calculatedLines.reduce(
    (sum, line) => sum + cleanNumber(line.quantity),
    0,
  )
  const total = roundMoney(
    calculatedLines.reduce((sum, line) => sum + line.taxableAmount, 0),
  )
  const lineDiscountTotal = roundMoney(
    calculatedLines.reduce(
      (sum, line) =>
        sum + (line.taxableAmount * cleanNumber(line.discountPercent)) / 100,
      0,
    ),
  )
  const schemeDiscount = roundMoney(
    options.schemeDiscount ?? lineDiscountTotal,
  )
  const netTotal = roundMoney(total - schemeDiscount)
  const specialDiscount = roundMoney(
    (netTotal * cleanNumber(options.specialDiscountPercent ?? 5)) / 100,
  )
  const otherDiscount = roundMoney(
    (netTotal * cleanNumber(options.otherDiscountPercent ?? 0)) / 100,
  )
  const amountAfterDiscount = roundMoney(
    netTotal - specialDiscount - otherDiscount,
  )
  const todDiscount = roundMoney(
    (amountAfterDiscount * cleanNumber(options.todPercent ?? 3)) / 100,
  )
  const cashDiscount = roundMoney(
    (amountAfterDiscount * cleanNumber(options.cdPercent ?? 4)) / 100,
  )
  const additionalDiscount = roundMoney(
    (amountAfterDiscount *
      cleanNumber(options.additionalDiscountPercent ?? 0)) /
      100,
  )
  const buyNFlyDiscount = roundMoney(
    (amountAfterDiscount * cleanNumber(options.buyNFlyPercent ?? 0)) / 100,
  )
  const netTaxableValue = Math.round(
    amountAfterDiscount -
      todDiscount -
      cashDiscount -
      additionalDiscount -
      buyNFlyDiscount,
  )
  const isIntraState =
    Boolean(sellerStateCode && buyerStateCode) &&
    sellerStateCode === buyerStateCode
  const igst = isIntraState
    ? 0
    : Math.round(
        (netTaxableValue * cleanNumber(options.igstPercent ?? 18)) / 100,
      )
  const cgst = isIntraState
    ? Math.round(
        (netTaxableValue * cleanNumber(options.cgstPercent ?? 9)) / 100,
      )
    : 0
  const sgst = isIntraState
    ? Math.round(
        (netTaxableValue * cleanNumber(options.sgstPercent ?? 9)) / 100,
      )
    : 0
  const tcs = 0
  const freightAmount = roundMoney(cleanNumber(freight))
  const otherCharges = 0
  const unroundedGrandTotal =
    netTaxableValue + igst + cgst + sgst + tcs + freightAmount + otherCharges
  const grandTotal = Math.round(unroundedGrandTotal)

  return {
    totalQuantity,
    total,
    schemeDiscount,
    netTotal,
    specialDiscount,
    otherDiscount,
    amountAfterDiscount,
    todDiscount,
    cashDiscount,
    additionalDiscount,
    buyNFlyDiscount,
    netTaxableValue,
    igst,
    cgst,
    sgst,
    tcs,
    freight: freightAmount,
    otherCharges,
    roundOff: roundMoney(grandTotal - unroundedGrandTotal),
    grandTotal,
    taxTotal: igst + cgst + sgst,
    isIntraState,
  }
}

export const formatCurrency = (value: number, currency: string) => {
  const safeValue = cleanNumber(value)

  if (!currency) {
    return numberFormatFallback(safeValue)
  }

  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(safeValue)
  } catch {
    return numberFormatFallback(safeValue)
  }
}

const numberFormatFallback = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value)

const ones = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
]

const tens = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
]

const belowHundredInWords = (value: number) => {
  if (value < 20) {
    return ones[value]
  }

  return [tens[Math.floor(value / 10)], ones[value % 10]]
    .filter(Boolean)
    .join(' ')
}

const belowThousandInWords = (value: number) => {
  const hundred = Math.floor(value / 100)
  const rest = value % 100

  return [
    hundred ? `${ones[hundred]} Hundred` : '',
    rest ? belowHundredInWords(rest) : '',
  ]
    .filter(Boolean)
    .join(' ')
}

const indianNumberInWords = (value: number): string => {
  if (value === 0) {
    return 'Zero'
  }

  const chunks = [
    { label: 'Crore', value: Math.floor(value / 10000000) },
    { label: 'Lakh', value: Math.floor((value % 10000000) / 100000) },
    { label: 'Thousand', value: Math.floor((value % 100000) / 1000) },
    { label: '', value: value % 1000 },
  ]

  return chunks
    .filter((chunk) => chunk.value > 0)
    .map((chunk) =>
      [belowThousandInWords(chunk.value), chunk.label].filter(Boolean).join(' '),
    )
    .join(' ')
}

export const formatAmountInWords = (value: number, currency: string) => {
  const amount = Math.abs(cleanNumber(value))
  const roundedPaise = Math.round((amount - Math.floor(amount)) * 100)
  const rupees = Math.floor(amount) + (roundedPaise === 100 ? 1 : 0)
  const paise = roundedPaise === 100 ? 0 : roundedPaise

  if (currency !== 'INR') {
    return `${currency} ${indianNumberInWords(Math.round(amount))} Only`
  }

  return [
    'Indian Rupees',
    indianNumberInWords(rupees),
    paise ? `and ${indianNumberInWords(paise)} Paise` : '',
    'Only',
  ]
    .filter(Boolean)
    .join(' ')
}

export const parseNumber = (value: string) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

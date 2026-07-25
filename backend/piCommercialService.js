const toText = (value) => String(value ?? '').trim()

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const roundMoney = (value) => Math.round(toNumberValue(value) * 100) / 100

const normalizePartyType = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const normalizeCategory = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const selectTradingRateValue = (rate, partyTypeName = '') => {
  if (!rate) {
    return 0
  }

  const partyType = normalizePartyType(partyTypeName)

  if (partyType.includes('intra') && partyType.includes('unit')) {
    return toNumberValue(rate.i_rate || rate.r_rate || rate.basic_rate || rate.w_rate)
  }

  if (partyType.includes('retailer')) {
    return toNumberValue(rate.r_rate || rate.basic_rate || rate.w_rate)
  }

  if (
    partyType.includes('exe distribut') ||
    partyType.includes('executive distribut') ||
    partyType.includes('exclusive distribut') ||
    partyType.includes('ex distribut')
  ) {
    return toNumberValue(rate.sw_rate || rate.w_rate || rate.r_rate)
  }

  if (partyType.includes('distribut')) {
    return toNumberValue(rate.w_rate || rate.sw_rate || rate.r_rate)
  }

  return toNumberValue(rate.r_rate || rate.basic_rate || rate.w_rate)
}

const getTradingRateMrp = (rate, partyTypeName = '') => {
  if (!rate) {
    return 0
  }

  return (
    toNumberValue(rate.mrp) ||
    toNumberValue(rate.disp_mrp) ||
    selectTradingRateValue(rate, partyTypeName)
  )
}

const getDiscountedRate = (mrp, discountPercent) =>
  roundMoney(toNumberValue(mrp) - (toNumberValue(mrp) * toNumberValue(discountPercent)) / 100)

const getCustomerDiscountPercent = (category, discount) => {
  if (!discount) {
    return 0
  }

  const normalizedCategory = normalizeCategory(category)

  if (normalizedCategory.includes('head lamp') || normalizedCategory.includes('headlamp')) {
    return toNumberValue(discount.hl_per)
  }

  if (
    normalizedCategory.includes('halogen bulb') ||
    normalizedCategory.includes('halogen bulbs')
  ) {
    return toNumberValue(discount.halo_per)
  }

  if (normalizedCategory.includes('incandescent') || normalizedCategory.includes('incd')) {
    return toNumberValue(discount.incd_per)
  }

  if (normalizedCategory.includes('wiper')) {
    return toNumberValue(discount.wiper_per)
  }

  return 0
}

const calculateLineRow = (line) => {
  const amount = roundMoney(toNumberValue(line.quantity) * toNumberValue(line.unitPrice ?? line.rate))
  const discountPercent = toNumberValue(line.discountPercent ?? line.discPercent)
  const discountAmount = roundMoney((amount * discountPercent) / 100)

  return {
    amount,
    basic: amount,
    discountAmount,
  }
}

const getTaxPercentForLines = (lineItems, customerDiscount) =>
  lineItems.reduce(
    (highest, line) => Math.max(highest, toNumberValue(line.gstPercent ?? line.gst_percent)),
    toNumberValue(customerDiscount?.gst_per),
  )

const resolveTaxPercentages = ({
  cgstPercent,
  companyStateCode,
  customerStateCode,
  customerDiscount,
  igstPercent,
  lineItems,
  sgstPercent,
}) => {
  const providedIgst = toNumberValue(igstPercent)
  const providedCgst = toNumberValue(cgstPercent)
  const providedSgst = toNumberValue(sgstPercent)

  if (providedIgst > 0 || providedCgst > 0 || providedSgst > 0) {
    return {
      cgstPercent: providedCgst,
      igstPercent: providedIgst,
      sgstPercent: providedSgst,
      taxMode: providedIgst > 0 ? 'IGST' : 'CGST_SGST',
    }
  }

  const gstPercent = getTaxPercentForLines(lineItems, customerDiscount)
  const companyState = toText(companyStateCode)
  const customerState = toText(customerStateCode)
  const hasComparableStates = companyState && customerState
  const isInterState = hasComparableStates && companyState !== customerState

  if (isInterState || !hasComparableStates) {
    return {
      cgstPercent: 0,
      igstPercent: gstPercent,
      sgstPercent: 0,
      taxMode: 'IGST',
    }
  }

  return {
    cgstPercent: roundMoney(gstPercent / 2),
    igstPercent: 0,
    sgstPercent: roundMoney(gstPercent / 2),
    taxMode: 'CGST_SGST',
  }
}

const findLatestTradingRate = async (
  pool,
  tableNames,
  productCode,
  compCode,
  { exactCompany = false } = {},
) => {
  const result = await pool.query(
    `
      SELECT
        id,
        TO_CHAR(eff_date, 'YYYY-MM-DD') AS eff_date,
        product_code,
        w_rate,
        sw_rate,
        r_rate,
        i_rate,
        oth1_rate,
        oth2_rate,
        dis_amt,
        unit_name,
        family,
        mrp,
        std_pkg,
        cpno,
        min_stk_qty,
        disp_mrp,
        basic_rate,
        plant_name,
        cat_desc,
        comp_code
      FROM ${tableNames.tradingRate}
      WHERE LOWER(product_code) = LOWER($1)
        AND ($3::boolean = FALSE OR comp_code = $2::smallint)
      ORDER BY
        CASE WHEN comp_code = $2::smallint THEN 1 ELSE 2 END,
        eff_date DESC
      LIMIT 1
    `,
    [productCode, Number(compCode || 0), Boolean(exactCompany)],
  )

  return result.rows[0] ?? null
}

const findLatestCustomerDiscount = async (
  pool,
  tableNames,
  custCode,
  compCode,
  { exactCompany = false } = {},
) => {
  if (!Number(custCode)) {
    return null
  }

  const result = await pool.query(
    `
      SELECT
        id,
        TO_CHAR(eff_date, 'YYYY-MM-DD') AS eff_date,
        cust_code,
        hl_per,
        halo_per,
        incd_per,
        wiper_per,
        gst_per,
        comp_code,
        is_active
      FROM ${tableNames.customerDiscount}
      WHERE cust_code = $1
        AND is_active = TRUE
        AND ($3::boolean = FALSE OR comp_code = $2::smallint)
      ORDER BY
        CASE WHEN comp_code = $2::smallint THEN 1 ELSE 2 END,
        eff_date DESC
      LIMIT 1
    `,
    [Number(custCode), Number(compCode || 0), Boolean(exactCompany)],
  )

  return result.rows[0] ?? null
}

const priceLineItemsForPI = async ({
  compCode,
  customerDiscount,
  custCode,
  lineItems,
  partyTypeName,
  pool,
  requireCustomerDiscount = false,
  requireExactCompany = false,
  tableNames,
}) => {
  const warnings = []
  const errors = []
  const rateLookups = []
  const suppliedCustomerDiscount =
    customerDiscount &&
    (!requireExactCompany ||
      Number(customerDiscount.comp_code) === Number(compCode || 0))
      ? customerDiscount
      : null
  const resolvedDiscount =
    suppliedCustomerDiscount ??
    (await findLatestCustomerDiscount(pool, tableNames, custCode, compCode, {
      exactCompany: requireExactCompany,
    }))
  const hasCustomer = Number(custCode) > 0
  const discountLookupStatus = hasCustomer
    ? resolvedDiscount
      ? 'FOUND'
      : requireCustomerDiscount
        ? 'DISCOUNT_NOT_FOUND'
        : 'MISSING_OPTIONAL'
    : 'CUSTOMER_NOT_AVAILABLE'

  if (hasCustomer && !resolvedDiscount) {
    if (requireCustomerDiscount) {
      warnings.push('COMMERCIAL_REVIEW_REQUIRED: customer discount master row is missing.')
      errors.push(
        `DISCOUNT_NOT_FOUND: No active customer discount row found for customer ${custCode} and company ${compCode}.`,
      )
    } else {
      warnings.push('No active customer discount row found; customer discount percent is treated as 0.')
    }
  }

  const pricedLineItems = []

  for (const [index, line] of lineItems.entries()) {
    const productCode = toText(line.productCode ?? line.product_code)
    const quantity = toNumberValue(line.quantity ?? line.qty)
    const rowLabel = `Product row ${index + 1}`

    if (!productCode) {
      errors.push(`${rowLabel}: product code is required for rate lookup.`)
      continue
    }

    const rateRow = await findLatestTradingRate(pool, tableNames, productCode, compCode, {
      exactCompany: requireExactCompany,
    })
    const selectedRate = selectTradingRateValue(rateRow, partyTypeName)
    const mrp = getTradingRateMrp(rateRow, partyTypeName)
    const category = toText(
      line.productCategory ??
        line.category ??
        rateRow?.cat_desc ??
        rateRow?.family,
    )
    const customerDiscountPercent = getCustomerDiscountPercent(category, resolvedDiscount)
    const unitPrice = getDiscountedRate(mrp, customerDiscountPercent)
    const discountPercent = toNumberValue(line.discountPercent ?? line.discPercent)
    const commercialLine = {
      ...line,
      amount: 0,
      basic: 0,
      customerDiscountPercent,
      discountAmount: 0,
      discountPercent,
      mrp,
      rate: unitPrice,
      rateSource: selectedRate > 0 ? 'Trading rate master' : '',
      unitPrice,
    }
    const lineCalculation = calculateLineRow(commercialLine)

    rateLookups.push({
      category,
      compCode: Number(rateRow?.comp_code ?? compCode ?? 0),
      customerDiscountPercent,
      discountCompCode: Number(resolvedDiscount?.comp_code ?? 0),
      discountId: resolvedDiscount?.id ?? null,
      discountLookupStatus,
      effectiveDate: rateRow?.eff_date ?? '',
      mrp,
      productCode,
      rateId: rateRow?.id ?? null,
      rateLookupStatus: rateRow ? 'FOUND' : 'RATE_NOT_FOUND',
      selectedRate,
      unitPrice,
    })

    if (!rateRow) {
      errors.push(`${rowLabel}: rate not found in trading product rate master for ${productCode}.`)
    } else if (selectedRate <= 0 && mrp <= 0) {
      errors.push(`${rowLabel}: rate master has no usable MRP/rate for ${productCode}.`)
    } else if (unitPrice <= 0) {
      errors.push(`${rowLabel}: calculated rate is zero for ${productCode}.`)
    }

    if (quantity <= 0) {
      errors.push(`${rowLabel}: quantity must be greater than 0.`)
    }

    pricedLineItems.push({
      ...commercialLine,
      amount: lineCalculation.amount,
      basic: lineCalculation.basic,
      discountAmount: lineCalculation.discountAmount,
    })
  }

  return {
    customerDiscount: resolvedDiscount,
    discountLookupStatus,
    errors,
    lineItems: pricedLineItems,
    rateLookups,
    warnings,
  }
}

const calculateCommercialTotals = (lineItems, options = {}) => {
  const schemeDiscount = roundMoney(
    lineItems.reduce((discountTotal, line) => {
      const lineCalculation = calculateLineRow(line)

      return discountTotal + lineCalculation.discountAmount
    }, 0),
  )
  const basicValue = roundMoney(
    lineItems.reduce((sum, line) => {
      const lineCalculation = calculateLineRow(line)

      return sum + lineCalculation.amount
    }, 0),
  )
  const taxPercentages = resolveTaxPercentages({
    cgstPercent: options.cgstPercent,
    companyStateCode: options.companyStateCode,
    customerDiscount: options.customerDiscount,
    customerStateCode: options.customerStateCode,
    igstPercent: options.igstPercent,
    lineItems,
    sgstPercent: options.sgstPercent,
  })
  const netBasicValue = roundMoney(basicValue - schemeDiscount)
  const specialDiscountAmount = roundMoney(
    (netBasicValue * toNumberValue(options.specialDiscountPercent)) / 100,
  )
  const otherDiscountAmount = roundMoney(
    (netBasicValue * toNumberValue(options.otherDiscountPercent)) / 100,
  )
  const amountAfterDiscount = roundMoney(
    netBasicValue - specialDiscountAmount - otherDiscountAmount,
  )
  const todAmount = roundMoney(
    (amountAfterDiscount * toNumberValue(options.todPercent)) / 100,
  )
  const cdAmount = roundMoney(
    (amountAfterDiscount * toNumberValue(options.cdPercent)) / 100,
  )
  const additionalDiscountAmount = roundMoney(
    (amountAfterDiscount * toNumberValue(options.additionalDiscountPercent)) / 100,
  )
  const buyNFlyAmount = roundMoney(
    (amountAfterDiscount * toNumberValue(options.buyNFlyPercent)) / 100,
  )
  const netTaxableValue = roundMoney(
    amountAfterDiscount -
      todAmount -
      cdAmount -
      additionalDiscountAmount -
      buyNFlyAmount,
  )
  const igstAmount = Math.round((netTaxableValue * taxPercentages.igstPercent) / 100)
  const cgstAmount = Math.round((netTaxableValue * taxPercentages.cgstPercent) / 100)
  const sgstAmount = Math.round((netTaxableValue * taxPercentages.sgstPercent) / 100)
  const grandTotalBeforeRoundOff = roundMoney(
    netTaxableValue +
      igstAmount +
      cgstAmount +
      sgstAmount +
      toNumberValue(options.freight),
  )
  const roundedGrandTotal = Math.ceil(grandTotalBeforeRoundOff)
  const roundOff = roundMoney(roundedGrandTotal - grandTotalBeforeRoundOff)
  const grandTotal = roundMoney(roundedGrandTotal)

  return {
    additionalDiscountAmount,
    amountAfterDiscount,
    basicValue,
    buyNFlyAmount,
    cdAmount,
    cgstAmount,
    cgstPercent: taxPercentages.cgstPercent,
    freight: toNumberValue(options.freight),
    grandTotal,
    igstAmount,
    igstPercent: taxPercentages.igstPercent,
    netBasicValue,
    netTaxableValue,
    otherDiscountAmount,
    roundOff,
    schemeDiscount,
    sgstAmount,
    sgstPercent: taxPercentages.sgstPercent,
    specialDiscountAmount,
    taxMode: taxPercentages.taxMode,
    todAmount,
  }
}

const validateCommercialPI = ({ lineItems, totals }) => {
  const errors = []
  const totalTaxPercent =
    toNumberValue(totals.igstPercent) +
    toNumberValue(totals.cgstPercent) +
    toNumberValue(totals.sgstPercent)

  if (lineItems.length === 0) {
    errors.push('No product rows are available for PI calculation.')
  }

  lineItems.forEach((line, index) => {
    const rowLabel = `Product row ${index + 1}`

    if (toNumberValue(line.rate ?? line.unitPrice) <= 0) {
      errors.push(`${rowLabel}: calculated rate must be greater than 0.`)
    }

    if (toNumberValue(line.amount) <= 0) {
      errors.push(`${rowLabel}: calculated amount must be greater than 0.`)
    }

    if (toNumberValue(line.gstPercent ?? line.gst_percent) <= 0) {
      errors.push(`${rowLabel}: product GST percent is missing.`)
    }
  })

  if (totalTaxPercent <= 0) {
    errors.push('GST percent is missing for PI tax calculation.')
  }

  if (toNumberValue(totals.grandTotal) <= 0) {
    errors.push('Grand total must be greater than 0.')
  }

  return errors
}

export {
  calculateCommercialTotals,
  calculateLineRow,
  findLatestCustomerDiscount,
  findLatestTradingRate,
  getCustomerDiscountPercent,
  getDiscountedRate,
  getTradingRateMrp,
  priceLineItemsForPI,
  roundMoney,
  selectTradingRateValue,
  toNumberValue,
  validateCommercialPI,
}

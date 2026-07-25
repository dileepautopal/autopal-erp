import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateCommercialTotals,
  priceLineItemsForPI,
} from './piCommercialService.js'

const TABLE_NAMES = {
  customerDiscount: 'master_cust_discount',
  tradingRate: 'master_trading_product_rate',
}

const createCommercialPool = ({ discounts = [], rates = [] } = {}) => {
  const queries = []
  const pool = {
    queries,
    async query(sql, params = []) {
      if (sql.includes(`FROM ${TABLE_NAMES.customerDiscount}`)) {
        const [custCode, compCode, exactCompany] = params
        const rows = discounts
          .filter((row) => Number(row.cust_code) === Number(custCode))
          .filter((row) => Boolean(row.is_active))
          .filter((row) => !exactCompany || Number(row.comp_code) === Number(compCode))
          .sort((first, second) => {
            const firstCompanyScore = Number(first.comp_code) === Number(compCode) ? 1 : 2
            const secondCompanyScore = Number(second.comp_code) === Number(compCode) ? 1 : 2

            if (firstCompanyScore !== secondCompanyScore) {
              return firstCompanyScore - secondCompanyScore
            }

            return String(second.eff_date).localeCompare(String(first.eff_date))
          })

        queries.push({ params, type: 'discount' })
        return { rows: rows.slice(0, 1) }
      }

      if (sql.includes(`FROM ${TABLE_NAMES.tradingRate}`)) {
        const [productCode, compCode, exactCompany] = params
        const rows = rates
          .filter(
            (row) =>
              String(row.product_code).toLowerCase() ===
              String(productCode).toLowerCase(),
          )
          .filter((row) => !exactCompany || Number(row.comp_code) === Number(compCode))
          .sort((first, second) => {
            const firstCompanyScore = Number(first.comp_code) === Number(compCode) ? 1 : 2
            const secondCompanyScore = Number(second.comp_code) === Number(compCode) ? 1 : 2

            if (firstCompanyScore !== secondCompanyScore) {
              return firstCompanyScore - secondCompanyScore
            }

            return String(second.eff_date).localeCompare(String(first.eff_date))
          })

        queries.push({ params, type: 'rate' })
        return { rows: rows.slice(0, 1) }
      }

      throw new Error(`Unexpected SQL in commercial test: ${sql}`)
    },
  }

  return pool
}

const baseRate = {
  basic_rate: 0,
  cat_desc: 'Head Lamp',
  comp_code: 2,
  disp_mrp: 0,
  eff_date: '2026-04-01',
  family: 'Head Lamp',
  i_rate: 0,
  id: 3,
  mrp: 230,
  oth1_rate: 0,
  oth2_rate: 0,
  product_code: '04-102-0030',
  r_rate: 0,
  sw_rate: 0,
  w_rate: 0,
}

const baseDiscount = {
  comp_code: 2,
  cust_code: 1,
  eff_date: '2026-06-23',
  gst_per: 18,
  halo_per: 0,
  hl_per: 49,
  id: 1,
  incd_per: 0,
  is_active: true,
  wiper_per: 0,
}

const baseLine = {
  discountPercent: 0,
  gstPercent: 18,
  productCategory: 'Head Lamp',
  productCode: '04-102-0030',
  quantity: 360,
  unit: 'NOS',
}

test('prices WhatsApp PI line using customer discount as reduced rate', async () => {
  const pool = createCommercialPool({
    discounts: [baseDiscount],
    rates: [baseRate],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [baseLine],
    partyTypeName: '',
    pool,
    requireCustomerDiscount: true,
    requireExactCompany: true,
    tableNames: TABLE_NAMES,
  })

  assert.deepEqual(pricing.errors, [])
  assert.equal(pricing.discountLookupStatus, 'FOUND')
  assert.equal(pool.queries.find((query) => query.type === 'discount').params[2], true)
  assert.equal(pool.queries.find((query) => query.type === 'rate').params[2], true)
  assert.equal(pricing.rateLookups[0].discountCompCode, 2)
  assert.equal(pricing.rateLookups[0].customerDiscountPercent, 49)
  assert.equal(pricing.lineItems[0].customerDiscountPercent, 49)
  assert.equal(pricing.lineItems[0].mrp, 230)
  assert.equal(pricing.lineItems[0].rate, 117.3)
  assert.equal(pricing.lineItems[0].amount, 42228)
  assert.equal(pricing.lineItems[0].discountPercent, 0)
  assert.equal(pricing.lineItems[0].discountAmount, 0)
})

test('calculates GST on discounted taxable value without double discount', async () => {
  const pool = createCommercialPool({
    discounts: [baseDiscount],
    rates: [baseRate],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [{ ...baseLine, discountPercent: 10 }],
    partyTypeName: '',
    pool,
    requireCustomerDiscount: true,
    requireExactCompany: true,
    tableNames: TABLE_NAMES,
  })
  const totals = calculateCommercialTotals(pricing.lineItems, {
    customerDiscount: pricing.customerDiscount,
    companyStateCode: '08',
    customerStateCode: '24',
  })

  assert.equal(pricing.lineItems[0].rate, 117.3)
  assert.equal(pricing.lineItems[0].amount, 42228)
  assert.equal(pricing.lineItems[0].discountAmount, 4222.8)
  assert.equal(totals.basicValue, 42228)
  assert.equal(totals.schemeDiscount, 4222.8)
  assert.equal(totals.netTaxableValue, 38005.2)
  assert.equal(totals.igstAmount, 6841)
  assert.equal(totals.grandTotal, 44847)
})

test('keeps zero-discount customer unchanged when master row exists', async () => {
  const pool = createCommercialPool({
    discounts: [{ ...baseDiscount, hl_per: 0 }],
    rates: [{ ...baseRate, mrp: 100 }],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [{ ...baseLine, quantity: 10 }],
    partyTypeName: '',
    pool,
    requireCustomerDiscount: true,
    requireExactCompany: true,
    tableNames: TABLE_NAMES,
  })

  assert.deepEqual(pricing.errors, [])
  assert.equal(pricing.lineItems[0].customerDiscountPercent, 0)
  assert.equal(pricing.lineItems[0].rate, 100)
  assert.equal(pricing.lineItems[0].amount, 1000)
})

test('missing required discount master row requires commercial review', async () => {
  const pool = createCommercialPool({
    discounts: [],
    rates: [baseRate],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [baseLine],
    partyTypeName: '',
    pool,
    requireCustomerDiscount: true,
    requireExactCompany: true,
    tableNames: TABLE_NAMES,
  })

  assert.equal(pricing.discountLookupStatus, 'DISCOUNT_NOT_FOUND')
  assert.match(pricing.warnings.join(' '), /COMMERCIAL_REVIEW_REQUIRED/)
  assert.match(pricing.errors.join(' '), /DISCOUNT_NOT_FOUND/)
})

test('does not use another company discount when exact company is required', async () => {
  const pool = createCommercialPool({
    discounts: [{ ...baseDiscount, comp_code: 1 }],
    rates: [baseRate],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [baseLine],
    partyTypeName: '',
    pool,
    requireCustomerDiscount: true,
    requireExactCompany: true,
    tableNames: TABLE_NAMES,
  })

  assert.equal(pricing.customerDiscount, null)
  assert.equal(pricing.discountLookupStatus, 'DISCOUNT_NOT_FOUND')
  assert.match(pricing.errors.join(' '), /company 2/)
})

test('manual-style optional lookup can still fall back to another company', async () => {
  const pool = createCommercialPool({
    discounts: [{ ...baseDiscount, comp_code: 1 }],
    rates: [baseRate],
  })

  const pricing = await priceLineItemsForPI({
    compCode: 2,
    custCode: 1,
    lineItems: [baseLine],
    partyTypeName: '',
    pool,
    tableNames: TABLE_NAMES,
  })

  assert.deepEqual(pricing.errors, [])
  assert.equal(pricing.customerDiscount.comp_code, 1)
  assert.equal(pricing.lineItems[0].rate, 117.3)
})

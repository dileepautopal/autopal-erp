import 'dotenv/config'
import pg from 'pg'
import {
  calculateCommercialTotals,
  priceLineItemsForPI,
  toNumberValue,
  validateCommercialPI,
} from '../backend/piCommercialService.js'

const { Pool } = pg

const TABLE_NAMES = {
  customerDiscount: 'master_cust_discount',
  tradingRate: 'master_trading_product_rate',
}

const parseArgs = () => {
  const args = process.argv.slice(2)
  const piNumber = String(
    args.find((arg) => arg.startsWith('--pi='))?.split('=').slice(1).join('=') ?? 'HAL-0001',
  ).trim()

  return {
    apply: args.includes('--apply'),
    piNumber,
  }
}

const parsePINumber = (piNumber) => {
  const match = String(piNumber).trim().match(/^(.+?)(\d+)$/)

  if (!match) {
    throw new Error('Use PI format like HAL-0001.')
  }

  return {
    piNo: Number(match[2]),
    piSeries: match[1],
  }
}

const loadDraftPI = async (pool, piNumber) => {
  const { piNo, piSeries } = parsePINumber(piNumber)
  const masterResult = await pool.query(
    `
      SELECT
        m.*,
        co.state_code AS company_state_code,
        customer.corr_state_code AS customer_state_code,
        party.party_type
      FROM master_pi_rmkt m
      LEFT JOIN master_company co
        ON co.comp_code = m.comp_code
      LEFT JOIN master_customer customer
        ON customer.cust_code = m.cust_code
      LEFT JOIN master_party_type party
        ON party.party_type_code = COALESCE(customer.party_type_code, m.party_type_code)
      WHERE m.pi_no = $1
        AND m.pi_series = $2
        AND m.is_active = TRUE
      ORDER BY m.comp_code ASC
      LIMIT 1
    `,
    [piNo, piSeries],
  )

  if (masterResult.rowCount === 0) {
    throw new Error(`PI ${piNumber} was not found.`)
  }

  const master = masterResult.rows[0]

  if (String(master.close_yn ?? 'N').toUpperCase() !== 'N') {
    throw new Error(`PI ${piNumber} is not Draft. Only Draft PIs can be repriced.`)
  }

  const lineResult = await pool.query(
    `
      SELECT
        t.product_code,
        t.quantity,
        t.uom_code,
        t.drate,
        p.id AS product_id,
        p.description,
        p.hsn_code,
        p.category,
        p.unit,
        p.gst_percent
      FROM tran_pi_rmkt t
      LEFT JOIN master_products p
        ON LOWER(p.code) = LOWER(t.product_code)
      WHERE t.pi_no = $1
        AND t.pi_series = $2
        AND t.comp_code = $3
        AND t.is_active = TRUE
      ORDER BY t.product_code ASC
    `,
    [Number(master.pi_no), master.pi_series, Number(master.comp_code)],
  )

  return {
    lineItems: lineResult.rows.map((line, index) => ({
      id: `existing-line-${index + 1}`,
      productCategory: line.category ?? '',
      productCode: line.product_code ?? '',
      productDescription: line.description ?? '',
      description: line.description ?? '',
      hsnCode: line.hsn_code ?? '',
      quantity: toNumberValue(line.quantity),
      unit: line.unit || 'NOS',
      uomCode: toNumberValue(line.uom_code),
      discountPercent: toNumberValue(line.drate),
      gstPercent: toNumberValue(line.gst_percent),
      productId: line.product_id === null || line.product_id === undefined
        ? ''
        : String(line.product_id),
    })),
    master,
  }
}

const buildReprice = async (pool, piNumber) => {
  const { lineItems, master } = await loadDraftPI(pool, piNumber)
  const pricing = await priceLineItemsForPI({
    compCode: Number(master.comp_code),
    custCode: Number(master.cust_code ?? 0),
    lineItems,
    partyTypeName: master.party_type ?? '',
    pool,
    tableNames: TABLE_NAMES,
  })
  const totals = calculateCommercialTotals(pricing.lineItems, {
    additionalDiscountPercent: master.oth_spdis_per,
    buyNFlyPercent: master.buy_fly_per,
    cdPercent: master.cd_per,
    customerDiscount: pricing.customerDiscount,
    companyStateCode: master.company_state_code,
    customerStateCode: master.state_code || master.customer_state_code,
    freight: master.frt_amount,
    otherDiscountPercent: master.oth_dis_per,
    specialDiscountPercent: master.spdis_per,
    todPercent: master.tod_per,
  })
  const errors = [
    ...pricing.errors,
    ...validateCommercialPI({
      lineItems: pricing.lineItems,
      totals,
    }),
  ]

  return {
    errors,
    lineItems: pricing.lineItems,
    master,
    rateLookups: pricing.rateLookups,
    totals,
    warnings: pricing.warnings,
  }
}

const applyReprice = async (pool, reprice) => {
  const client = await pool.connect()
  const { master, totals } = reprice

  try {
    await client.query('BEGIN')
    await client.query(
      `
        UPDATE master_pi_rmkt
        SET
          basic_value = $1,
          scheme_discount = $2,
          round_off = $3,
          grand_total = $4,
          spdis_amt = $5,
          net_basic_amount = $6,
          igst_per = $7,
          cgst_per = $8,
          sgst_per = $9,
          igst_amt = $10,
          cgst_amt = $11,
          sgst_amt = $12,
          oth_dis_amt = $13,
          tod_amt = $14,
          cd_amt = $15,
          net_taxable_value = $16,
          oth_spdis_amt = $17,
          buy_fly_amt = $18,
          updated_by = $19,
          updated_at = CURRENT_TIMESTAMP
        WHERE pi_no = $20
          AND pi_series = $21
          AND comp_code = $22
          AND close_yn = 'N'
          AND is_active = TRUE
      `,
      [
        totals.basicValue,
        totals.schemeDiscount,
        totals.roundOff,
        totals.grandTotal,
        totals.specialDiscountAmount,
        totals.netBasicValue,
        totals.igstPercent,
        totals.cgstPercent,
        totals.sgstPercent,
        totals.igstAmount,
        totals.cgstAmount,
        totals.sgstAmount,
        totals.otherDiscountAmount,
        totals.todAmount,
        totals.cdAmount,
        totals.netTaxableValue,
        totals.additionalDiscountAmount,
        totals.buyNFlyAmount,
        'Commercial Reprice',
        Number(master.pi_no),
        master.pi_series,
        Number(master.comp_code),
      ],
    )

    for (const line of reprice.lineItems) {
      await client.query(
        `
          UPDATE tran_pi_rmkt
          SET
            rate = $1,
            amount = $2,
            rbasic = $3,
            drate = $4,
            damt = $5,
            updated_by = $6,
            updated_at = CURRENT_TIMESTAMP
          WHERE pi_no = $7
            AND pi_series = $8
            AND comp_code = $9
            AND LOWER(product_code) = LOWER($10)
            AND is_active = TRUE
        `,
        [
          line.rate,
          line.amount,
          line.basic,
          line.discountPercent,
          line.discountAmount,
          'Commercial Reprice',
          Number(master.pi_no),
          master.pi_series,
          Number(master.comp_code),
          line.productCode,
        ],
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const main = async () => {
  const { apply, piNumber } = parseArgs()
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })

  try {
    const reprice = await buildReprice(pool, piNumber)

    if (reprice.errors.length > 0) {
      console.log(JSON.stringify({
        apply,
        errors: reprice.errors,
        ok: false,
        piNumber,
        rateLookups: reprice.rateLookups,
        warnings: reprice.warnings,
      }, null, 2))
      process.exitCode = 1
      return
    }

    if (apply) {
      await applyReprice(pool, reprice)
    }

    console.log(JSON.stringify({
      applied: apply,
      grandTotal: reprice.totals.grandTotal,
      lineItems: reprice.lineItems.map((line) => ({
        amount: line.amount,
        customerDiscountPercent: line.customerDiscountPercent,
        discountAmount: line.discountAmount,
        discountPercent: line.discountPercent,
        mrp: line.mrp,
        productCode: line.productCode,
        quantity: line.quantity,
        rate: line.rate,
      })),
      ok: true,
      piNumber,
      rateLookups: reprice.rateLookups,
      totals: reprice.totals,
      warnings: reprice.warnings,
    }, null, 2))
  } finally {
    await pool.end()
  }
}

await main()

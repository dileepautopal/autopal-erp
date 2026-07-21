import express from 'express'

const DEFAULT_TERMS =
  'PI created automatically from WhatsApp message. Please verify before final use.'
const WHATSAPP_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const WHATSAPP_WEBHOOK_EVENT_TABLE_NAME = 'tran_whatsapp_webhook_events'

const toText = (value) => String(value ?? '').trim()

const toLimitedText = (value, maxLength) => toText(value).slice(0, maxLength)

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? number : fallback
}

const compactSpaces = (value) => toText(value).replace(/\s+/g, ' ')

const normalizeText = (text) =>
  toText(text)
    .replace(/\r/g, '\n')
    .replace(/[–—]/g, '-')
    .replace(/[|]/g, '/')
    .replace(/\u00a0/g, ' ')

const normalizeLookupText = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/\bm\s*\/?\s*s\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const normalizeCompactLookupText = (value) =>
  normalizeLookupText(value).replace(/[^a-z0-9]+/g, '')

const toTitleCase = (value) =>
  compactSpaces(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())

const normalizeProductNeedle = (value) =>
  toText(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(\d+)v/g, '$1v')
    .replace(/(\d+\/\d+)w/g, '$1')

const normalizeUnit = (value) => {
  const unit = toText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

  if (!unit || unit === 'NO' || unit === 'N0S' || unit === 'NO8' || unit === 'NOS') {
    return 'NOS'
  }

  if (unit === 'PC' || unit === 'PCS' || unit === 'PIECES') {
    return 'PCS'
  }

  return unit
}

const normalizeModel = (value) =>
  toText(value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^PU3T$/, 'PU37')

const parseWhatsappDate = (text) => {
  const match = normalizeText(text).match(
    /\b(?:date\s*[:\-]?\s*)?(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})\b/i,
  )

  if (!match) {
    return ''
  }

  const day = Number(match[1])
  const month = Number(match[2])
  let year = Number(match[3])

  if (year < 100) {
    year += 2000
  }

  if (day < 1 || day > 31 || month < 1 || month > 12) {
    return ''
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export const parseWhatsappPIItemLine = (line) => {
  const cleaned = compactSpaces(
    normalizeText(line)
      .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
      .replace(/(\d)\s*[vV]\b/g, '$1V')
      .replace(/\bno8\b/gi, 'NOS')
      .replace(/\bn0s\b/gi, 'NOS'),
  )

  const match = cleaned.match(
    /(?:^|[^\d])(?<size>\d{2,3}\/\d{2,3})\s*[-: ]+\s*(?<voltage>\d{1,2})V\s*[-: ]*(?<model>[A-Za-z]{1,5}\s*[A-Za-z0-9]{1,5})\s*[-: ]+\s*(?<quantity>\d{1,6})\s*(?<unit>[A-Za-z0-9.]{0,8})/i,
  )

  if (!match?.groups) {
    return null
  }

  return {
    size: match.groups.size,
    voltage: `${Number(match.groups.voltage)}V`,
    model: normalizeModel(match.groups.model),
    quantity: Number(match.groups.quantity),
    unit: normalizeUnit(match.groups.unit),
    rawLine: line,
  }
}

export const parseWhatsappPIText = (text, source = {}) => {
  const normalized = normalizeText(text)
  const lines = normalized
    .split('\n')
    .map(compactSpaces)
    .filter(Boolean)

  const items = []
  const ignoredLines = []

  lines.forEach((line, index) => {
    const item = parseWhatsappPIItemLine(line)

    if (item) {
      items.push({
        ...item,
        lineNumber: index + 1,
      })
      return
    }

    if (/\d{2,3}\s*\/\s*\d{2,3}/.test(line) || /\b\d{1,2}\s*V\b/i.test(line)) {
      ignoredLines.push({ lineNumber: index + 1, text: line })
    }
  })

  const firstItemIndex = lines.findIndex((line) => parseWhatsappPIItemLine(line))
  const headerLines = lines
    .slice(0, firstItemIndex >= 0 ? firstItemIndex : lines.length)
    .filter((line) => !parseWhatsappPIItemLine(line))
    .filter((line) => !/^date\s*[:\-]?/i.test(line))

  const msIndex = headerLines.findIndex((line) => /\bm\s*\/?\s*s\b/i.test(line))
  let partyName = ''
  let place = ''

  if (msIndex >= 0) {
    partyName = toTitleCase(
      headerLines[msIndex].replace(/^.*?\bm\s*\/?\s*s\b\.?\s*/i, ''),
    )
    place = toTitleCase(headerLines[msIndex + 1] ?? '')
  }

  if (!partyName) {
    const likelyPartyLine = headerLines.find((line) =>
      /auto|mobile|trader|agency|motors|automobiles/i.test(line),
    )

    if (likelyPartyLine) {
      partyName = toTitleCase(likelyPartyLine.replace(/\bm\s*\/?\s*s\b\.?/i, ''))
      const partyIndex = headerLines.indexOf(likelyPartyLine)
      place = toTitleCase(headerLines[partyIndex + 1] ?? '')
    }
  }

  const warnings = []

  if (!partyName) {
    warnings.push('Customer name was not found in the WhatsApp message.')
  }

  if (items.length === 0) {
    warnings.push('No product rows were found in the WhatsApp message.')
  }

  return {
    date: parseWhatsappDate(normalized),
    partyName,
    place,
    items,
    ignoredLines,
    warnings,
    source: {
      channel: 'whatsapp',
      receivedAt: new Date().toISOString(),
      ...source,
    },
    rawText: normalized,
  }
}

const findDefaultCompany = async (pool, tableNames) => {
  const requestedCompCode = toNumberValue(process.env.WHATSAPP_PI_COMP_CODE)
  const requestedCompanyId = toText(process.env.WHATSAPP_PI_COMPANY_ID)

  const result = await pool.query(
    `
      SELECT comp_code, company_id, company_name, legal_name, pi_prefix
      FROM ${tableNames.company}
      WHERE is_active = TRUE
        AND (
          ($1::smallint > 0 AND comp_code = $1::smallint)
          OR ($2::text <> '' AND company_id = $2::text)
          OR ($1::smallint = 0 AND $2::text = '')
        )
      ORDER BY comp_code ASC
      LIMIT 1
    `,
    [requestedCompCode, requestedCompanyId],
  )

  if (result.rowCount === 0) {
    throw new Error('No active company found for WhatsApp PI import.')
  }

  return result.rows[0]
}

const getNextPINumber = async (pool, tableNames, company) => {
  const series = toLimitedText(
    process.env.WHATSAPP_PI_SERIES || company.pi_prefix || '',
    6,
  )
  const result = await pool.query(
    `
      SELECT COALESCE(MAX(pi_no), 0) + 1 AS next_pi_no
      FROM ${tableNames.piMaster}
      WHERE pi_series = $1
        AND comp_code = $2
    `,
    [series, Number(company.comp_code)],
  )
  const piNo = Number(result.rows[0]?.next_pi_no ?? 1)

  return {
    piNo,
    piSeries: series,
    piNumber: `${series}${String(piNo).padStart(4, '0')}`,
  }
}

const findCustomer = async (pool, tableNames, parsed) => {
  const partyName = toText(parsed.partyName)
  const compactPartyName = normalizeCompactLookupText(partyName)
  const place = normalizeLookupText(parsed.place)

  const result = await pool.query(
    `
      SELECT
        c.customer_id,
        c.cust_code,
        c.cust_name,
        c.corr_address,
        c.corr_city_code,
        corr_city.city_name AS corr_city_name,
        c.corr_state_code,
        corr_state.state_name AS corr_state_name,
        c.corr_country_code,
        corr_country.country_name AS corr_country_name,
        c.corr_tel,
        c.mobile_no,
        c.gstin_no,
        c.party_type_code,
        party.party_type
      FROM ${tableNames.customer} c
      LEFT JOIN ${tableNames.city} corr_city
        ON corr_city.city_id = c.corr_city_code
      LEFT JOIN ${tableNames.state} corr_state
        ON corr_state.state_id = c.corr_state_code
      LEFT JOIN ${tableNames.country} corr_country
        ON corr_country.country_id = c.corr_country_code
      LEFT JOIN ${tableNames.partyType} party
        ON party.party_type_code = c.party_type_code
      WHERE c.is_active = TRUE
        AND (
          LOWER(c.cust_name) = LOWER($1)
          OR REGEXP_REPLACE(LOWER(c.cust_name), '[^a-z0-9]+', '', 'g') = $2
          OR ($1::text <> '' AND LOWER(c.cust_name) LIKE LOWER($3))
        )
      ORDER BY
        CASE
          WHEN LOWER(c.cust_name) = LOWER($1) THEN 1
          WHEN $4::text <> '' AND LOWER(corr_city.city_name) = LOWER($4) THEN 2
          ELSE 3
        END
      LIMIT 1
    `,
    [partyName, compactPartyName, `%${partyName}%`, place],
  )

  return result.rows[0] ?? null
}

const findCity = async (pool, tableNames, place) => {
  const cityName = toText(place)

  if (!cityName) {
    return null
  }

  const result = await pool.query(
    `
      SELECT
        city.city_id,
        city.city_name,
        state.state_id,
        state.state_name,
        country.country_name
      FROM ${tableNames.city} city
      LEFT JOIN ${tableNames.state} state
        ON state.state_id = city.state_id
      LEFT JOIN ${tableNames.country} country
        ON country.country_id = state.country_id
      WHERE LOWER(city.city_name) = LOWER($1)
      LIMIT 1
    `,
    [cityName],
  )

  return result.rows[0] ?? null
}

const findLatestRate = async (pool, tableNames, productCode, compCode) => {
  const result = await pool.query(
    `
      SELECT
        w_rate,
        sw_rate,
        r_rate,
        i_rate,
        basic_rate,
        unit_name,
        comp_code
      FROM ${tableNames.tradingRate}
      WHERE LOWER(product_code) = LOWER($1)
        AND ($2::smallint = 0 OR comp_code = $2::smallint)
      ORDER BY
        CASE WHEN comp_code = $2::smallint THEN 1 ELSE 2 END,
        eff_date DESC
      LIMIT 1
    `,
    [productCode, Number(compCode || 0)],
  )

  return result.rows[0] ?? null
}

const selectRate = (rate, partyTypeName) => {
  if (!rate) {
    return 0
  }

  const partyType = normalizeLookupText(partyTypeName)

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

const findProductForItem = async (pool, tableNames, item) => {
  const sizeNeedle = normalizeProductNeedle(item.size)
  const voltageNeedle = normalizeProductNeedle(item.voltage)
  const result = await pool.query(
    `
      SELECT id, code, description, hsn_code, unit, gst_percent
      FROM ${tableNames.product}
      WHERE LOWER(REPLACE(REPLACE(description, ' ', ''), 'W', '')) LIKE $1
        AND LOWER(REPLACE(description, ' ', '')) LIKE $2
      ORDER BY code ASC
      LIMIT 1
    `,
    [`%${sizeNeedle}%`, `%${voltageNeedle}%`],
  )

  return result.rows[0] ?? null
}

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100

const buildLineItems = async (pool, tableNames, parsedItems, compCode, partyTypeName) => {
  const lines = []
  const warnings = []

  for (const [index, item] of parsedItems.entries()) {
    const product = await findProductForItem(pool, tableNames, item)

    if (!product) {
      warnings.push(
        `Product not found for row ${index + 1}: ${item.size} ${item.voltage} ${item.model}.`,
      )
      continue
    }

    const rateRow = await findLatestRate(pool, tableNames, product.code, compCode)
    const unitPrice = selectRate(rateRow, partyTypeName)
    const amount = roundMoney(item.quantity * unitPrice)

    lines.push({
      id: `whatsapp-line-${index + 1}`,
      productId: String(product.id ?? ''),
      productCode: product.code,
      productDescription: product.description,
      description: product.description,
      hsnCode: product.hsn_code ?? '',
      quantity: item.quantity,
      unit: product.unit || item.unit || 'NOS',
      uomCode: 0,
      rate: unitPrice,
      unitPrice,
      amount,
      basic: amount,
      discountPercent: 0,
      discountAmount: 0,
      gstPercent: toNumberValue(product.gst_percent),
      sourceItem: item,
    })
  }

  return { lines, warnings }
}

const calculateTotals = (lineItems) => {
  const basicValue = roundMoney(
    lineItems.reduce((total, line) => total + toNumberValue(line.basic), 0),
  )
  const igstPercent = toNumberValue(process.env.WHATSAPP_PI_IGST_PERCENT, 18)
  const igstAmount = roundMoney((basicValue * igstPercent) / 100)
  const grandTotalBeforeRoundOff = roundMoney(basicValue + igstAmount)
  const grandTotal = Math.ceil(grandTotalBeforeRoundOff)
  const roundOff = roundMoney(grandTotal - grandTotalBeforeRoundOff)

  return {
    basicValue,
    netBasicValue: basicValue,
    netTaxableValue: basicValue,
    igstPercent,
    igstAmount,
    cgstPercent: 0,
    cgstAmount: 0,
    sgstPercent: 0,
    sgstAmount: 0,
    grandTotal,
    roundOff,
  }
}

const findExistingPIForMessage = async (pool, tableNames, messageId) => {
  const sourceMessageId = toLimitedText(messageId, 50)

  if (!sourceMessageId) {
    return null
  }

  const result = await pool.query(
    `
      SELECT pi_no, pi_series, comp_code
      FROM ${tableNames.piMaster}
      WHERE po_no = $1
        AND is_active = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [sourceMessageId],
  )

  const row = result.rows[0]

  if (!row) {
    return null
  }

  return {
    compCode: Number(row.comp_code ?? 0),
    piNo: Number(row.pi_no ?? 0),
    piNumber: `${row.pi_series ?? ''}${String(Number(row.pi_no) || 0).padStart(4, '0')}`,
    piSeries: row.pi_series ?? '',
  }
}

const buildPIPayloadFromParsedMessage = async (parsed, dependencies) => {
  const { pool, tableNames } = dependencies
  const company = await findDefaultCompany(pool, tableNames)
  const piNumber = await getNextPINumber(pool, tableNames, company)
  const customer = await findCustomer(pool, tableNames, parsed)
  const city = customer ? null : await findCity(pool, tableNames, parsed.place)
  const partyTypeName = customer?.party_type ?? ''
  const lineResult = await buildLineItems(
    pool,
    tableNames,
    parsed.items,
    Number(company.comp_code),
    partyTypeName,
  )
  const totals = calculateTotals(lineResult.lines)
  const piDate = parsed.date || new Date().toISOString().slice(0, 10)
  const address = customer?.corr_address || toText(process.env.WHATSAPP_PI_DEFAULT_ADDRESS)
  const cityCode = Number(customer?.corr_city_code ?? city?.city_id ?? 0)
  const stateCode = Number(customer?.corr_state_code ?? city?.state_id ?? 0)
  const customerName = customer?.cust_name || parsed.partyName

  return {
    payload: {
      piNumber: piNumber.piNumber,
      piDate,
      deliveryDate: piDate,
      companyId: company.company_id,
      companyName: company.legal_name || company.company_name,
      compCode: Number(company.comp_code),
      customerId: customer?.customer_id ?? null,
      custCode: Number(customer?.cust_code ?? 0),
      custName: customerName,
      customerCity: customer?.corr_city_name ?? city?.city_name ?? parsed.place,
      customerState: customer?.corr_state_name ?? city?.state_name ?? '',
      country: customer?.corr_country_name ?? city?.country_name ?? 'India',
      currency: 'INR',
      prospectiveCustomerName: customerName,
      prospectiveAddress: address,
      prospectiveCity: customer?.corr_city_name ?? city?.city_name ?? parsed.place,
      prospectiveState: customer?.corr_state_name ?? city?.state_name ?? '',
      prospectiveContactNo: toLimitedText(
        customer?.mobile_no || customer?.corr_tel || process.env.WHATSAPP_PI_DEFAULT_CONTACT_NO,
        10,
      ),
      prospectiveDiscountPercent: 0,
      prospectiveGstNo: customer?.gstin_no ?? '',
      gstNo: customer?.gstin_no ?? '',
      partyTypeCode: Number(customer?.party_type_code ?? process.env.WHATSAPP_PI_DEFAULT_PARTY_TYPE_CODE ?? 0),
      partyTypeName,
      cityCode,
      stateCode,
      transportMode: process.env.WHATSAPP_PI_TRANSPORT_MODE || '',
      transporterCode: toNumberValue(process.env.WHATSAPP_PI_TRANSPORTER_CODE),
      transporter: process.env.WHATSAPP_PI_TRANSPORTER || '',
      destination: toLimitedText(parsed.place || customer?.corr_city_name || '', 25),
      materialGroup: 'HAL',
      custPoNo: toLimitedText(parsed.source.messageId || '', 50),
      underScheme: '',
      schemeCode: 0,
      proformaClose: 'No',
      schemeDiscount: 0,
      specialDiscountPercent: 0,
      specialDiscountAmount: 0,
      otherDiscountPercent: 0,
      otherDiscountAmount: 0,
      amountAfterDiscount: totals.basicValue,
      todPercent: 0,
      todAmount: 0,
      cdPercent: 0,
      cdAmount: 0,
      additionalDiscountPercent: 0,
      additionalDiscountAmount: 0,
      buyNFlyPercent: 0,
      buyNFlyAmount: 0,
      freight: 0,
      terms: DEFAULT_TERMS,
      remarks: `WhatsApp import: ${parsed.partyName || 'Unknown party'}`,
      createdBy: 'WhatsApp',
      updatedBy: 'WhatsApp',
      isActive: true,
      lineItems: lineResult.lines,
      ...totals,
    },
    warnings: [...parsed.warnings, ...lineResult.warnings],
    parsed,
  }
}

const collectWhatsappMessages = (payload) => {
  const messages = []

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {}
      const contacts = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact]))

      for (const message of value.messages || []) {
        messages.push({
          contact: contacts.get(message.from) || null,
          message,
        })
      }
    }
  }

  return messages
}

const getWhatsappReceivedAt = (message) => {
  const timestamp = Number(message?.timestamp ?? 0)

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null
  }

  return new Date(timestamp * 1000).toISOString()
}

const getInitialWhatsappMessageText = (message) => {
  if (message?.type === 'text') {
    return message.text?.body ?? ''
  }

  if (message?.type === 'image') {
    return message.image?.caption ?? ''
  }

  return ''
}

const getWhatsappMessageSource = (contact, message) => ({
  messageId:
    message.id || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  receivedAt: getWhatsappReceivedAt(message),
  senderName: contact?.profile?.name ?? '',
  senderPhone: message.from ?? contact?.wa_id ?? '',
  sourceType: message.type,
})

const logWhatsappWebhook = (event, details = {}) => {
  console.log(
    JSON.stringify({
      event,
      ...details,
    }),
  )
}

const createWebhookResult = ({
  duplicate = false,
  errors = [],
  inserted = false,
  messageId = '',
  parseStatus = 'RECEIVED',
  piCreated = false,
  saved = false,
  warnings = [],
} = {}) => ({
  duplicate,
  errors: normalizeJSONList(errors),
  inserted,
  message_id: messageId,
  ok: true,
  parse_status: parseStatus,
  pi_created: piCreated,
  received: true,
  saved,
  warnings: normalizeJSONList(warnings),
})

const getParsedPIValidationErrors = (parsed) => {
  const errors = []

  if (!parsed.partyName) {
    errors.push('Customer name was not found in the WhatsApp message.')
  }

  if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
    errors.push('No product rows were found in the WhatsApp message.')
  }

  return errors
}

let whatsappMessageSchemaPromise

const ensureWhatsappMessageSchema = async (pool) => {
  if (!whatsappMessageSchemaPromise) {
    whatsappMessageSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${WHATSAPP_MESSAGE_TABLE_NAME} (
          id bigserial PRIMARY KEY,
          message_id varchar(160) UNIQUE,
          received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sender_name varchar(160),
          sender_phone varchar(50),
          message_type varchar(40),
          message_text text NOT NULL DEFAULT '',
          raw_text text NOT NULL DEFAULT '',
          source_type varchar(40),
          import_status varchar(40) NOT NULL DEFAULT 'received',
          import_result jsonb,
          parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
          parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
          parsed_payload jsonb,
          pi_created boolean NOT NULL DEFAULT FALSE,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await pool.query(`
        ALTER TABLE ${WHATSAPP_MESSAGE_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS raw_text text NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS source_type varchar(40),
          ADD COLUMN IF NOT EXISTS parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          ADD COLUMN IF NOT EXISTS parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS parsed_payload jsonb,
          ADD COLUMN IF NOT EXISTS pi_created boolean NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      `)
      await pool.query(`
        UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
        SET raw_text = message_text
        WHERE raw_text = ''
          AND message_text <> ''
      `)
      await pool.query(`
        UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
        SET source_type = message_type
        WHERE (source_type IS NULL OR source_type = '')
          AND message_type IS NOT NULL
          AND message_type <> ''
      `)
      await pool.query(`
        UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
        SET parse_status =
          CASE
            WHEN LOWER(import_status) = 'imported' THEN 'PI_CREATED'
            WHEN LOWER(import_status) = 'duplicate' THEN 'DUPLICATE'
            WHEN LOWER(import_status) = 'error' THEN 'PI_FAILED'
            ELSE 'RECEIVED'
          END
        WHERE parse_status IS NULL
           OR parse_status = ''
           OR parse_status = 'RECEIVED'
      `)
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_message_id
        ON ${WHATSAPP_MESSAGE_TABLE_NAME} (message_id)
        WHERE message_id IS NOT NULL
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_received_at
        ON ${WHATSAPP_MESSAGE_TABLE_NAME} (received_at DESC, id DESC)
      `)
    })()
  }

  try {
    await whatsappMessageSchemaPromise
  } catch (error) {
    whatsappMessageSchemaPromise = undefined
    throw error
  }
}

let whatsappWebhookEventSchemaPromise

const ensureWhatsappWebhookEventSchema = async (pool) => {
  if (!whatsappWebhookEventSchemaPromise) {
    whatsappWebhookEventSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${WHATSAPP_WEBHOOK_EVENT_TABLE_NAME} (
          id bigserial PRIMARY KEY,
          received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          method varchar(10) NOT NULL,
          url text NOT NULL,
          remote_address varchar(120),
          user_agent text,
          query jsonb,
          body jsonb,
          message_count integer NOT NULL DEFAULT 0,
          response_status integer,
          note text
        )
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_webhook_events_received_at
        ON ${WHATSAPP_WEBHOOK_EVENT_TABLE_NAME} (received_at DESC, id DESC)
      `)
    })()
  }

  try {
    await whatsappWebhookEventSchemaPromise
  } catch (error) {
    whatsappWebhookEventSchemaPromise = undefined
    throw error
  }
}

const mapIncomingWhatsappMessageRow = (row) => ({
  id: Number(row.id),
  importStatus: row.import_status ?? '',
  messageId: row.message_id ?? '',
  messageText: row.message_text ?? '',
  messageType: row.message_type ?? '',
  parseErrors: row.parse_errors ?? [],
  parseStatus: row.parse_status ?? '',
  parseWarnings: row.parse_warnings ?? [],
  piCreated: Boolean(row.pi_created),
  rawText: row.raw_text ?? row.message_text ?? '',
  receivedAt:
    row.received_at instanceof Date
      ? row.received_at.toISOString()
      : row.received_at ?? '',
  senderName: row.sender_name ?? '',
  senderPhone: row.sender_phone ?? '',
})

const getIncomingWhatsappMessages = async (dependencies, requestedLimit = 10) => {
  await ensureWhatsappMessageSchema(dependencies.pool)
  const limit = Math.min(Math.max(toNumberValue(requestedLimit, 10), 1), 50)
  const result = await dependencies.pool.query(
    `
      SELECT
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        message_text,
        raw_text,
        import_status,
        parse_status,
        parse_warnings,
        parse_errors,
        pi_created
      FROM ${WHATSAPP_MESSAGE_TABLE_NAME}
      ORDER BY received_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  )

  return result.rows.map(mapIncomingWhatsappMessageRow)
}

const mapWebhookEventRow = (row) => ({
  body: row.body ?? null,
  id: Number(row.id),
  messageCount: Number(row.message_count ?? 0),
  method: row.method ?? '',
  note: row.note ?? '',
  query: row.query ?? null,
  receivedAt:
    row.received_at instanceof Date
      ? row.received_at.toISOString()
      : row.received_at ?? '',
  remoteAddress: row.remote_address ?? '',
  responseStatus: row.response_status ? Number(row.response_status) : null,
  url: row.url ?? '',
  userAgent: row.user_agent ?? '',
})

const getWebhookEvents = async (dependencies, requestedLimit = 20) => {
  await ensureWhatsappWebhookEventSchema(dependencies.pool)
  const limit = Math.min(Math.max(toNumberValue(requestedLimit, 20), 1), 100)
  const result = await dependencies.pool.query(
    `
      SELECT
        id,
        received_at,
        method,
        url,
        remote_address,
        user_agent,
        query,
        body,
        message_count,
        response_status,
        note
      FROM ${WHATSAPP_WEBHOOK_EVENT_TABLE_NAME}
      ORDER BY received_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  )

  return result.rows.map(mapWebhookEventRow)
}

const saveWebhookEvent = async (
  dependencies,
  request,
  { messageCount = 0, note = '', responseStatus = null } = {},
) => {
  await ensureWhatsappWebhookEventSchema(dependencies.pool)
  const result = await dependencies.pool.query(
    `
      INSERT INTO ${WHATSAPP_WEBHOOK_EVENT_TABLE_NAME}
        (
          method,
          url,
          remote_address,
          user_agent,
          query,
          body,
          message_count,
          response_status,
          note
        )
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      RETURNING
        id,
        received_at,
        method,
        url,
        remote_address,
        user_agent,
        query,
        body,
        message_count,
        response_status,
        note
    `,
    [
      request.method,
      request.originalUrl ?? request.url,
      request.ip ?? request.socket?.remoteAddress ?? '',
      request.get('user-agent') ?? '',
      JSON.stringify(request.query ?? {}),
      request.method === 'GET' ? null : JSON.stringify(request.body ?? {}),
      messageCount,
      responseStatus,
      note,
    ],
  )

  return mapWebhookEventRow(result.rows[0])
}

const mapParseStatusToImportStatus = (parseStatus) => {
  if (parseStatus === 'PI_CREATED') {
    return 'imported'
  }

  if (parseStatus === 'DUPLICATE') {
    return 'duplicate'
  }

  if (parseStatus === 'PARSE_FAILED' || parseStatus === 'PI_FAILED') {
    return 'error'
  }

  return 'received'
}

const normalizeJSONList = (value) => {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

const saveIncomingWhatsappMessage = async (
  dependencies,
  {
    messageId,
    messageText,
    messageType,
    receivedAt = null,
    senderName,
    senderPhone,
    sourceType,
  },
) => {
  await ensureWhatsappMessageSchema(dependencies.pool)

  const storedMessageId = toLimitedText(
    messageId || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    160,
  )
  const result = await dependencies.pool.query(
    `
      INSERT INTO ${WHATSAPP_MESSAGE_TABLE_NAME}
        (
          message_id,
          received_at,
          sender_name,
          sender_phone,
          message_type,
          source_type,
          message_text,
          raw_text,
          import_status,
          parse_status,
          parse_warnings,
          parse_errors,
          pi_created,
          created_at,
          updated_at
        )
      VALUES
        (
          $1,
          COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
          $3,
          $4,
          $5,
          $6,
          $7,
          $7,
          'received',
          'RECEIVED',
          '[]'::jsonb,
          '[]'::jsonb,
          FALSE,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      ON CONFLICT (message_id)
      DO NOTHING
      RETURNING
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        source_type,
        message_text,
        raw_text,
        import_status,
        parse_status,
        parse_warnings,
        parse_errors,
        pi_created
    `,
    [
      storedMessageId,
      receivedAt,
      toLimitedText(senderName, 160),
      toLimitedText(senderPhone, 50),
      toLimitedText(messageType, 40),
      toLimitedText(sourceType || messageType, 40),
      normalizeText(messageText),
    ],
  )

  if (result.rowCount > 0) {
    return {
      duplicate: false,
      inserted: true,
      row: mapIncomingWhatsappMessageRow(result.rows[0]),
    }
  }

  const existingResult = await dependencies.pool.query(
    `
      SELECT
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        source_type,
        message_text,
        raw_text,
        import_status,
        parse_status,
        parse_warnings,
        parse_errors,
        pi_created
      FROM ${WHATSAPP_MESSAGE_TABLE_NAME}
      WHERE message_id = $1
      LIMIT 1
    `,
    [storedMessageId],
  )

  return {
    duplicate: true,
    inserted: false,
    row: mapIncomingWhatsappMessageRow(existingResult.rows[0]),
  }
}

const updateIncomingWhatsappMessageProcessing = async (
  dependencies,
  {
    importResult = null,
    messageId,
    messageText,
    parsedPayload = null,
    parseErrors = [],
    parseStatus,
    parseWarnings = [],
    piCreated = false,
  },
) => {
  await ensureWhatsappMessageSchema(dependencies.pool)

  const result = await dependencies.pool.query(
    `
      UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
      SET
        message_text = $2,
        raw_text = $2,
        import_status = $3,
        import_result = $4::jsonb,
        parse_status = $5,
        parse_warnings = $6::jsonb,
        parse_errors = $7::jsonb,
        parsed_payload = $8::jsonb,
        pi_created = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1
      RETURNING
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        source_type,
        message_text,
        raw_text,
        import_status,
        parse_status,
        parse_warnings,
        parse_errors,
        pi_created
    `,
    [
      toLimitedText(messageId, 160),
      normalizeText(messageText),
      mapParseStatusToImportStatus(parseStatus),
      importResult ? JSON.stringify(importResult) : null,
      parseStatus,
      JSON.stringify(normalizeJSONList(parseWarnings)),
      JSON.stringify(normalizeJSONList(parseErrors)),
      parsedPayload ? JSON.stringify(parsedPayload) : null,
      piCreated,
    ],
  )

  return result.rowCount > 0 ? mapIncomingWhatsappMessageRow(result.rows[0]) : null
}

const downloadWhatsappMedia = async (mediaId) => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN

  if (!token) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is required for WhatsApp image imports.')
  }

  const baseUrl = process.env.WHATSAPP_GRAPH_API_BASE || 'https://graph.facebook.com/v20.0'
  const headers = { Authorization: `Bearer ${token}` }
  const metadataResponse = await fetch(`${baseUrl}/${encodeURIComponent(mediaId)}`, { headers })
  const metadata = await metadataResponse.json()

  if (!metadataResponse.ok || !metadata.url) {
    throw new Error(`WhatsApp media metadata failed: ${JSON.stringify(metadata)}`)
  }

  const mediaResponse = await fetch(metadata.url, { headers })

  if (!mediaResponse.ok) {
    throw new Error(`WhatsApp media download failed with ${mediaResponse.status}.`)
  }

  return {
    buffer: Buffer.from(await mediaResponse.arrayBuffer()),
    mimeType: mediaResponse.headers.get('content-type') || metadata.mime_type || 'image/jpeg',
  }
}

const extractTextFromImage = async (buffer, mimeType) => {
  const extractorUrl =
    process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_URL || process.env.PI_IMAGE_EXTRACTOR_URL

  if (!extractorUrl) {
    throw new Error(
      'Image message received, but no OCR service is configured. Set WHATSAPP_PI_IMAGE_EXTRACTOR_URL or send extracted text to /api/whatsapp-pi/import-text.',
    )
  }

  const headers = { 'Content-Type': 'application/json' }
  const token =
    process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_TOKEN || process.env.PI_IMAGE_EXTRACTOR_TOKEN

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(extractorUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      imageBase64: buffer.toString('base64'),
      mimeType,
    }),
  })
  const payload = await response.json()

  if (!response.ok || !payload.text) {
    throw new Error(`Image extractor failed: ${JSON.stringify(payload)}`)
  }

  return payload.text
}

const importParsedPI = async (parsed, dependencies) => {
  const existingPI = await findExistingPIForMessage(
    dependencies.pool,
    dependencies.tableNames,
    parsed.source.messageId,
  )

  if (existingPI) {
    return {
      duplicate: true,
      inserted: false,
      parsed,
      pi: existingPI,
      warnings: ['WhatsApp message was already imported.'],
    }
  }

  const built = await buildPIPayloadFromParsedMessage(parsed, dependencies)

  if (built.payload.lineItems.length === 0) {
    return {
      inserted: false,
      parsed: built.parsed,
      warnings: built.warnings,
      errors: ['No product rows could be matched to product master.'],
    }
  }

  const saveResult = await dependencies.saveRMarketPIRecord(built.payload)

  return {
    inserted: true,
    parsed: built.parsed,
    payload: built.payload,
    pi: saveResult.savedPI,
    statusCode: saveResult.statusCode,
    warnings: built.warnings,
  }
}

export const createWhatsappPIRouter = (dependencies) => {
  const router = express.Router()

  router.get('/status', (_request, response) => {
    response.json({
      ok: true,
      accessTokenConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
      graphApiBase: process.env.WHATSAPP_GRAPH_API_BASE || 'https://graph.facebook.com/v20.0',
      imageExtractorConfigured: Boolean(
        process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_URL || process.env.PI_IMAGE_EXTRACTOR_URL,
      ),
      verifyTokenConfigured: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    })
  })

  router.get('/messages', async (request, response, next) => {
    try {
      response.json({
        ok: true,
        messages: await getIncomingWhatsappMessages(
          dependencies,
          request.query.limit,
        ),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/webhook-events', async (request, response, next) => {
    try {
      response.json({
        events: await getWebhookEvents(dependencies, request.query.limit),
        ok: true,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/webhook', async (request, response, next) => {
    const mode = request.query['hub.mode']
    const token = request.query['hub.verify_token']
    const challenge = request.query['hub.challenge']

    try {
      if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        await saveWebhookEvent(dependencies, request, {
          note: 'verify ok',
          responseStatus: 200,
        })
        response.status(200).send(challenge)
        return
      }

      await saveWebhookEvent(dependencies, request, {
        note: 'verify failed',
        responseStatus: 403,
      })
      response.sendStatus(403)
    } catch (error) {
      next(error)
    }
  })

  router.post('/webhook', async (request, response, next) => {
    try {
      const messages = collectWhatsappMessages(request.body)
      const results = []
      logWhatsappWebhook('whatsapp_webhook_received', {
        messageCount: messages.length,
      })
      await saveWebhookEvent(dependencies, request, {
        messageCount: messages.length,
        note: messages.length > 0 ? 'message webhook' : 'no messages in payload',
        responseStatus: 200,
      })

      for (const { contact, message } of messages) {
        const messageSource = getWhatsappMessageSource(contact, message)
        let text = getInitialWhatsappMessageText(message)
        const savedMessage = await saveIncomingWhatsappMessage(dependencies, {
          ...messageSource,
          messageText: text,
          messageType: message.type,
        })

        if (savedMessage.duplicate) {
          logWhatsappWebhook('whatsapp_duplicate_message_detected', {
            messageId: messageSource.messageId,
            parseStatus: savedMessage.row?.parseStatus ?? 'DUPLICATE',
          })
          results.push(
            createWebhookResult({
              duplicate: true,
              errors: savedMessage.row?.parseErrors ?? [],
              inserted: false,
              messageId: messageSource.messageId,
              parseStatus: savedMessage.row?.parseStatus || 'DUPLICATE',
              piCreated: Boolean(savedMessage.row?.piCreated),
              saved: true,
              warnings: savedMessage.row?.parseWarnings ?? [],
            }),
          )
          continue
        }

        logWhatsappWebhook('whatsapp_raw_message_saved', {
          inserted: true,
          messageId: messageSource.messageId,
        })

        try {
          if (message.type === 'image' && !text) {
            const media = await downloadWhatsappMedia(message.image?.id)
            text = await extractTextFromImage(media.buffer, media.mimeType)
          }

          if (!['text', 'image'].includes(message.type)) {
            throw new Error(`Unsupported WhatsApp message type: ${message.type}`)
          }
        } catch (error) {
          const errors = [
            error instanceof Error
              ? error.message
              : 'Unable to read WhatsApp message text.',
          ]
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            importResult: {
              errors,
              inserted: false,
            },
            messageId: messageSource.messageId,
            messageText: text,
            parseErrors: errors,
            parseStatus: 'PARSE_FAILED',
          })
          logWhatsappWebhook('whatsapp_parsing_failed', {
            messageId: messageSource.messageId,
            parseStatus: 'PARSE_FAILED',
          })
          results.push(
            createWebhookResult({
              errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'PARSE_FAILED',
              saved: true,
            }),
          )
          continue
        }

        let parsed

        try {
          parsed = parseWhatsappPIText(text, {
            ...messageSource,
          })
        } catch (error) {
          const errors = [
            error instanceof Error
              ? error.message
              : 'Unable to parse WhatsApp message.',
          ]
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            importResult: {
              errors,
              inserted: false,
            },
            messageId: messageSource.messageId,
            messageText: text,
            parseErrors: errors,
            parseStatus: 'PARSE_FAILED',
          })
          logWhatsappWebhook('whatsapp_parsing_failed', {
            messageId: messageSource.messageId,
            parseStatus: 'PARSE_FAILED',
          })
          results.push(
            createWebhookResult({
              errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'PARSE_FAILED',
              saved: true,
            }),
          )
          continue
        }

        const parseErrors = getParsedPIValidationErrors(parsed)

        if (parseErrors.length > 0) {
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            importResult: {
              errors: parseErrors,
              inserted: false,
              parsed,
              warnings: parsed.warnings,
            },
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: parsed,
            parseErrors,
            parseStatus: 'PARSE_FAILED',
            parseWarnings: parsed.warnings,
          })
          logWhatsappWebhook('whatsapp_parsing_failed', {
            messageId: messageSource.messageId,
            parseStatus: 'PARSE_FAILED',
          })
          results.push(
            createWebhookResult({
              errors: parseErrors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'PARSE_FAILED',
              saved: true,
              warnings: parsed.warnings,
            }),
          )
          continue
        }

        await updateIncomingWhatsappMessageProcessing(dependencies, {
          importResult: {
            inserted: false,
            parsed,
            warnings: parsed.warnings,
          },
          messageId: messageSource.messageId,
          messageText: text,
          parsedPayload: parsed,
          parseStatus: 'PARSED',
          parseWarnings: parsed.warnings,
        })
        logWhatsappWebhook('whatsapp_parsing_succeeded', {
          messageId: messageSource.messageId,
          parseStatus: 'PARSED',
        })

        try {
          const importResult = await importParsedPI(parsed, dependencies)
          const importErrors = normalizeJSONList(importResult.errors)
          const parseStatus = importResult.inserted
            ? 'PI_CREATED'
            : importResult.duplicate
              ? 'DUPLICATE'
              : 'PI_FAILED'
          const piCreated = Boolean(importResult.inserted)

          await updateIncomingWhatsappMessageProcessing(dependencies, {
            importResult,
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: importResult.parsed ?? parsed,
            parseErrors: importErrors,
            parseStatus,
            parseWarnings: importResult.warnings ?? [],
            piCreated,
          })

          if (piCreated) {
            logWhatsappWebhook('whatsapp_pi_created', {
              messageId: messageSource.messageId,
              parseStatus,
            })
          } else {
            logWhatsappWebhook('whatsapp_pi_creation_failed', {
              messageId: messageSource.messageId,
              parseStatus,
            })
          }

          results.push(
            createWebhookResult({
              duplicate: Boolean(importResult.duplicate),
              errors: importErrors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus,
              piCreated,
              saved: true,
              warnings: importResult.warnings ?? [],
            }),
          )
        } catch (error) {
          const errors = [
            error instanceof Error
              ? error.message
              : 'Unable to create PI from WhatsApp message.',
          ]
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            importResult: {
              errors,
              inserted: false,
              parsed,
            },
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: parsed,
            parseErrors: errors,
            parseStatus: 'PI_FAILED',
            parseWarnings: parsed.warnings,
          })
          logWhatsappWebhook('whatsapp_pi_creation_failed', {
            messageId: messageSource.messageId,
            parseStatus: 'PI_FAILED',
          })
          results.push(
            createWebhookResult({
              errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'PI_FAILED',
              saved: true,
              warnings: parsed.warnings,
            }),
          )
        }
      }

      response.json({
        duplicate: results.some((result) => result.duplicate),
        errors: results.flatMap((result) => result.errors),
        inserted: results.some((result) => result.inserted),
        ok: true,
        parse_status: results.length === 1 ? results[0].parse_status : 'MULTIPLE_MESSAGES',
        pi_created: results.some((result) => result.pi_created),
        received: messages.length,
        results,
        saved: results.filter((result) => result.saved).length,
        warnings: results.flatMap((result) => result.warnings),
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/import-text', async (request, response, next) => {
    try {
      const parsed = parseWhatsappPIText(request.body.text ?? '', {
        channel: 'manual-whatsapp-text',
        messageId: request.body.messageId ?? `manual-${Date.now()}`,
        senderName: request.body.senderName ?? '',
        senderPhone: request.body.senderPhone ?? '',
        sourceType: 'text',
      })
      const result = await importParsedPI(parsed, dependencies)

      response.status(result.duplicate ? 200 : result.inserted ? result.statusCode : 422).json({
        ok: result.inserted || result.duplicate,
        ...result,
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/parse-text', (request, response) => {
    response.json({
      ok: true,
      parsed: parseWhatsappPIText(request.body.text ?? '', {
        channel: 'manual-whatsapp-text',
        messageId: request.body.messageId ?? `manual-${Date.now()}`,
        sourceType: 'text',
      }),
    })
  })

  return router
}

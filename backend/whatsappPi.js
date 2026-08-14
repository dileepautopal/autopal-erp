import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  compareCustomerNames,
  CUSTOMER_MATCH_THRESHOLD,
  getCustomerNameSearchTokens,
} from './customerFuzzyMatch.js'
import { selectCompanyForLineItems } from './companySelectionService.js'
import {
  calculateCommercialTotals,
  priceLineItemsForPI,
  validateCommercialPI,
} from './piCommercialService.js'
import {
  detectCustomerCommand,
  ensurePiSummarySchema,
  handleCustomerConfirmationReply,
  sendPiSummaryForMessage,
} from './piSummaryService.js'
import {
  ensureWhatsAppAcknowledgementSchema,
  isAcknowledgementTerminalStatus,
  sendAutomaticAcknowledgement,
} from './whatsappAckService.js'
import { processDueWhatsAppRetries } from './whatsappSendRetryWorker.js'
import {
  cancelScheduledRetry,
  createManualRetryFromLog,
  ensureWhatsAppSendLogSchema,
  getWhatsAppSendLogs,
  getWhatsAppSendMonitorSummary,
  getWhatsAppSourceTimeline,
  markSendForManualReview,
} from './whatsappSendService.js'
import {
  logWhatsAppOutgoingEarlyReturn,
  logWhatsAppOutgoingTrace,
} from './whatsappOutgoingTrace.js'
import {
  captureIncomingMedia,
  ensureWhatsAppMediaCaptureSchema,
  extractMediaEnvelope,
  getSafeMediaLogDetails,
  isWhatsappMediaMessage,
} from './whatsappMediaCaptureService.js'
import {
  downloadCapturedWhatsAppMedia,
  ensureWhatsAppMediaDownloadSchema,
  getSafeMediaDownloadLogDetails,
} from './whatsappMediaDownloadService.js'
import {
  ensureWhatsAppMediaTextExtractionSchema,
  extractDownloadedWhatsAppMediaText,
  getSafeMediaExtractionLogDetails,
  MEDIA_EXTRACTION_STATUSES,
} from './whatsappMediaTextExtractionService.js'
import {
  ensureWhatsAppMediaOrderCandidateSchema,
  getSafeMediaOrderParseLogDetails,
  MEDIA_ORDER_PARSE_STATUSES,
  parseExtractedWhatsAppMediaOrderCandidate,
} from './whatsappMediaOrderCandidateService.js'
import {
  ensureWhatsAppExcelProcessingSchema,
  getSafeExcelProcessingLogDetails,
  isSupportedExcelMedia,
  MEDIA_EXCEL_STATUSES,
  processDownloadedWhatsAppExcel,
} from './whatsappExcelProcessingService.js'
import {
  ensureWhatsAppWordProcessingSchema,
  getSafeWordProcessingLogDetails,
  isSupportedWordMedia,
  MEDIA_WORD_STATUSES,
  processDownloadedWhatsAppWord,
} from './whatsappWordProcessingService.js'

const DEFAULT_TERMS =
  'PI created automatically from WhatsApp message. Please verify before final use.'
const WHATSAPP_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const WHATSAPP_MESSAGE_EVENT_TABLE_NAME = 'tran_whatsapp_pi_message_events'
const CUSTOMER_CONFIRMATION_PROCESSED_STATUS = 'CUSTOMER_CONFIRMATION_PROCESSED'
const WHATSAPP_WEBHOOK_EVENT_TABLE_NAME = 'tran_whatsapp_webhook_events'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WHATSAPP_UPLOAD_ROOT = path.resolve(
  process.env.WHATSAPP_UPLOAD_DIR || path.join(__dirname, '../uploads/whatsapp'),
)
const UNREADABLE_IMAGE_MESSAGE = 'No readable text could be extracted from the image.'
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png'])
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  'csv',
  'doc',
  'docx',
  'jpeg',
  'jpg',
  'pdf',
  'png',
  'xls',
  'xlsx',
])
const MIME_EXTENSION_MAP = new Map([
  ['application/msword', 'doc'],
  ['application/pdf', 'pdf'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['text/csv', 'csv'],
])

const toText = (value) => String(value ?? '').trim()

const toLimitedText = (value, maxLength) => toText(value).slice(0, maxLength)

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? number : fallback
}

const compactSpaces = (value) => toText(value).replace(/\s+/g, ' ')

const toSafeFilePart = (value, fallback = 'file') => {
  const safeValue = toText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 140)

  return safeValue || fallback
}

const getExtensionFromName = (fileName) => {
  const extension = path.extname(toText(fileName)).replace('.', '').toLowerCase()

  return extension
}

const getExtensionFromMimeType = (mimeType) =>
  MIME_EXTENSION_MAP.get(toText(mimeType).toLowerCase()) || ''

const getMediaExtension = ({ fileName = '', mimeType = '', messageType = '' }) => {
  const extension =
    getExtensionFromName(fileName) ||
    getExtensionFromMimeType(mimeType) ||
    (messageType === 'image' ? 'jpg' : '')

  return extension.toLowerCase()
}

const getUploadRelativePath = (fileName) => {
  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')

  return path.join(year, month, day, fileName)
}

const normalizeText = (text) =>
  toText(text)
    .replace(/\r/g, '\n')
    .replace(/[–—−]/g, '-')
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

const normalizeProductMatchText = (value) =>
  normalizeText(value)
    .toUpperCase()
    .replace(/\bLEFT\b/g, 'LH')
    .replace(/\bRIGHT\b/g, 'RH')
    .replace(/\bLHS\b/g, 'LH')
    .replace(/\bRHS\b/g, 'RH')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const normalizeCompactProductMatchText = (value) =>
  normalizeProductMatchText(value).replace(/[^A-Z0-9]+/g, '')

const normalizePhoneDigits = (value) => {
  const digits = toText(value).replace(/\D+/g, '')

  return digits.length > 10 ? digits.slice(-10) : digits
}

const normalizeUnit = (value) => {
  const unit = toText(value).toUpperCase().replace(/[^A-Z0-9]/g, '')

  if (
    !unit ||
    unit === 'NO' ||
    unit === 'N0S' ||
    unit === 'NO8' ||
    unit === 'NOS' ||
    unit === 'UNIT' ||
    unit === 'UNITS' ||
    unit === 'QTY'
  ) {
    return 'NOS'
  }

  if (unit === 'PC' || unit === 'PCS' || unit === 'PIECE' || unit === 'PIECES') {
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

const extractWhatsappIdentifiers = (text) => {
  const normalized = normalizeText(text)
  const gstMatch = normalized
    .toUpperCase()
    .match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/)
  const emailMatch = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)
  const phoneMatch = normalized.match(/(?:\+?\d[\d\s().-]{8,}\d)/)

  return {
    contactPhone: normalizePhoneDigits(phoneMatch?.[0] ?? ''),
    email: toText(emailMatch?.[0]).toLowerCase(),
    gstNo: toText(gstMatch?.[0]).toUpperCase(),
  }
}

export const parseWhatsappPIItemLine = (line) => {
  const cleaned = compactSpaces(
    normalizeText(line)
      .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
      .replace(/(\d)\s*[vV]\b/g, '$1V')
      .replace(/[,](?=\d{3}\b)/g, '')
      .replace(/\bno8\b/gi, 'NOS')
      .replace(/\bn0s\b/gi, 'NOS'),
  )

  const classicMatch = cleaned.match(
    /(?:^|[^\d])(?<size>\d{2,3}\/\d{2,3})\s*[-: ]+\s*(?<voltage>\d{1,2})V\s*[-: ]*(?<model>[A-Za-z]{1,5}\s*[A-Za-z0-9]{1,5})\s*[-: ]+\s*(?<quantity>\d{1,6})\s*(?<unit>[A-Za-z0-9.]{0,8})/i,
  )

  if (classicMatch?.groups) {
    return {
      size: classicMatch.groups.size,
      voltage: `${Number(classicMatch.groups.voltage)}V`,
      model: normalizeModel(classicMatch.groups.model),
      quantity: Number(classicMatch.groups.quantity),
      unit: normalizeUnit(classicMatch.groups.unit),
      rawLine: line,
    }
  }

  const flexibleLine = normalizeText(line)
    .replace(/[,](?=\d{3}\b)/g, '')
    .replace(/[–—−:]/g, ' - ')
    .replace(/\bLEFT\b/gi, 'LH')
    .replace(/\bRIGHT\b/gi, 'RH')
    .replace(/\bLHS\b/gi, 'LH')
    .replace(/\bRHS\b/gi, 'RH')
    .replace(/\bx\b/gi, ' x ')
    .replace(/\s+/g, ' ')
    .trim()
  const productMatch = flexibleLine.match(
    /^(?<product>.+?)\s*(?:[-:]|\bx\b)?\s+(?<quantity>\d{1,7})\s*(?<unit>Nos?\.?|N0s\.?|No8\.?|PCS?\.?|Pieces?|Units?|Qty)?\.?$/i,
  )

  if (!productMatch?.groups) {
    return null
  }

  const productText = normalizeProductMatchText(productMatch.groups.product)
  const productCodeMatch = productText.match(/\b[A-Z]{1,12}\s*\d{1,8}[A-Z0-9]*\b/)

  if (!productCodeMatch) {
    return null
  }

  const productCode = normalizeCompactProductMatchText(productCodeMatch[0])

  return {
    model: productCode,
    productCode,
    productText,
    quantity: Number(productMatch.groups.quantity),
    unit: normalizeUnit(productMatch.groups.unit),
    rawLine: line,
  }
}

export const parseWhatsappPIText = (text, source = {}) => {
  const normalized = normalizeText(text)
  const identifiers = extractWhatsappIdentifiers(normalized)
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
  const partyLabelLine = headerLines.find((line) =>
    /^(party|customer|cust\.?|name)\s*[:\-]/i.test(line),
  )
  const placeLabelLine = headerLines.find((line) =>
    /^(place|city|destination)\s*[:\-]/i.test(line),
  )

  if (partyLabelLine) {
    partyName = toTitleCase(partyLabelLine.replace(/^(party|customer|cust\.?|name)\s*[:\-]\s*/i, ''))
  }

  if (placeLabelLine) {
    place = toTitleCase(placeLabelLine.replace(/^(place|city|destination)\s*[:\-]\s*/i, ''))
  }

  if (!partyName && msIndex >= 0) {
    partyName = toTitleCase(
      headerLines[msIndex].replace(/^.*?\bm\s*\/?\s*s\b\.?\s*/i, ''),
    )
    place = place || toTitleCase(headerLines[msIndex + 1] ?? '')
  }

  if (!partyName) {
    const likelyPartyLine = headerLines.find((line) =>
      /auto|mobile|trader|trading|agency|motors|automobiles|enterprise|industries|electrical|lighting/i.test(line),
    )

    if (likelyPartyLine) {
      partyName = toTitleCase(likelyPartyLine.replace(/\bm\s*\/?\s*s\b\.?/i, ''))
      const partyIndex = headerLines.indexOf(likelyPartyLine)
      place = place || toTitleCase(headerLines[partyIndex + 1] ?? '')
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
    contactPhone: identifiers.contactPhone,
    email: identifiers.email,
    gstNo: identifiers.gstNo,
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

const detectOrderType = (text, parsed) => {
  const normalizedText = normalizeLookupText(text)

  if (/\bwarranty\b|\bclaim\b/.test(normalizedText)) {
    return 'WARRANTY'
  }

  if (/\bcomplaint\b|\bnot working\b|\bdamage\b|\bdefect\b/.test(normalizedText)) {
    return 'COMPLAINT'
  }

  if (/\bcatalog\b|\bcatalogue\b|\bbrochure\b/.test(normalizedText)) {
    return 'CATALOG REQUEST'
  }

  if (/\bstock\b|\bavailable\b|\bavailability\b/.test(normalizedText)) {
    return 'STOCK ENQUIRY'
  }

  if (/\bprice\b|\brate\b|\bquotation\b|\bquote\b/.test(normalizedText)) {
    return 'PRICE ENQUIRY'
  }

  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    return 'ORDER'
  }

  if (normalizedText) {
    return 'ENQUIRY'
  }

  return 'OTHER'
}

const calculateUnderstandingConfidence = (text, parsed) => {
  let score = 0

  if (parsed.partyName) {
    score += 30
  }

  if (parsed.place) {
    score += 10
  }

  if (parsed.date) {
    score += 10
  }

  if (parsed.gstNo || parsed.contactPhone || parsed.email) {
    score += 10
  }

  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    score += 40
  }

  if (normalizeText(text).length > 10) {
    score += 5
  }

  return Math.min(score, 95)
}

const understandWhatsappMessage = (text, source = {}) => {
  const parsed = parseWhatsappPIText(text, source)
  const orderType = detectOrderType(text, parsed)
  const confidenceScore = calculateUnderstandingConfidence(text, parsed)

  return {
    ...parsed,
    aiProvider: 'rule-based',
    confidenceScore,
    orderType,
  }
}

const getNextPINumber = async (pool, tableNames, company) => {
  const series = toLimitedText(company.pi_prefix || '', 6)

  if (!series) {
    throw new Error('Selected company does not have a PI series configured.')
  }

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
  const contactPhone = normalizePhoneDigits(parsed.contactPhone)
  const email = toText(parsed.email).toLowerCase()
  const gstNo = toText(parsed.gstNo).toUpperCase()
  const partyName = toText(parsed.partyName)
  const compactPartyName = normalizeCompactLookupText(partyName)
  const place = normalizeLookupText(parsed.place)
  const nameSearchTokens = getCustomerNameSearchTokens(partyName)

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
        c.corr_email,
        c.ship_email,
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
          ($1::text <> '' AND UPPER(COALESCE(c.gstin_no, '')) = $1)
          OR (
            $2::text <> ''
            AND (
              REGEXP_REPLACE(COALESCE(c.mobile_no, ''), '[^0-9]+', '', 'g') LIKE '%' || $2
              OR REGEXP_REPLACE(COALESCE(c.corr_tel, ''), '[^0-9]+', '', 'g') LIKE '%' || $2
            )
          )
          OR (
            $3::text <> ''
            AND (
              LOWER(COALESCE(c.corr_email, '')) = $3
              OR LOWER(COALESCE(c.ship_email, '')) = $3
            )
          )
          OR LOWER(c.cust_name) = LOWER($4)
          OR REGEXP_REPLACE(LOWER(c.cust_name), '[^a-z0-9]+', '', 'g') = $5
          OR ($4::text <> '' AND LOWER(c.cust_name) LIKE LOWER($6))
          OR EXISTS (
            SELECT 1
            FROM unnest($8::text[]) AS name_token
            WHERE name_token <> ''
              AND REGEXP_REPLACE(UPPER(c.cust_name), '[^A-Z0-9]+', ' ', 'g')
                LIKE '%' || name_token || '%'
          )
        )
      ORDER BY
        CASE
          WHEN $1::text <> '' AND UPPER(COALESCE(c.gstin_no, '')) = $1 THEN 1
          WHEN $2::text <> '' AND REGEXP_REPLACE(COALESCE(c.mobile_no, ''), '[^0-9]+', '', 'g') LIKE '%' || $2 THEN 2
          WHEN $3::text <> '' AND LOWER(COALESCE(c.corr_email, '')) = $3 THEN 3
          WHEN LOWER(c.cust_name) = LOWER($4) THEN 4
          WHEN $7::text <> '' AND LOWER(corr_city.city_name) = LOWER($7) THEN 5
          ELSE 6
        END
      LIMIT 50
    `,
    [
      gstNo,
      contactPhone,
      email,
      partyName,
      compactPartyName,
      `%${partyName}%`,
      place,
      nameSearchTokens,
    ],
  )

  const scoredRows = result.rows
    .map((row) => {
      const reasons = []
      let confidence = 0

      if (gstNo && toText(row.gstin_no).toUpperCase() === gstNo) {
        confidence = 100
        reasons.push('GSTIN exact match')
      }

      if (
        contactPhone &&
        (normalizePhoneDigits(row.mobile_no).endsWith(contactPhone) ||
          normalizePhoneDigits(row.corr_tel).endsWith(contactPhone))
      ) {
        confidence = Math.max(confidence, 98)
        reasons.push('phone match')
      }

      if (
        email &&
        (toText(row.corr_email).toLowerCase() === email ||
          toText(row.ship_email).toLowerCase() === email)
      ) {
        confidence = Math.max(confidence, 98)
        reasons.push('email match')
      }

      const nameScore = compareCustomerNames(partyName, row.cust_name)

      if (nameScore.confidence > 0) {
        confidence = Math.max(confidence, nameScore.confidence)
        reasons.push(nameScore.matchReason)
      }

      if (
        place &&
        toText(row.corr_city_name).toLowerCase() === place &&
        confidence > 0
      ) {
        confidence = Math.min(confidence + 2, 100)
        reasons.push('city match')
      }

      return {
        confidence,
        matchReason: reasons.join(', '),
        row,
      }
    })
    .sort((left, right) => right.confidence - left.confidence)

  const bestMatch = scoredRows[0]

  if (!bestMatch || bestMatch.confidence < CUSTOMER_MATCH_THRESHOLD) {
    return null
  }

  return {
    ...bestMatch.row,
    customer_match_confidence: bestMatch.confidence,
    customer_match_reason: bestMatch.matchReason,
  }
}

const matchCustomerForParsedMessage = async (dependencies, parsed) => {
  const customer = await findCustomer(
    dependencies.pool,
    dependencies.tableNames,
    parsed,
  )

  if (!customer) {
    return {
      confidence: 0,
      customer: null,
    }
  }

  return {
    confidence: Number(customer.customer_match_confidence ?? (
      parsed.gstNo || parsed.contactPhone || parsed.email
        ? 95
        : parsed.partyName
          ? 90
          : 60
    )),
    customer,
  }
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

const scoreProductCandidate = (product, item) => {
  const productCode = normalizeCompactProductMatchText(product.code)
  const productDescription = normalizeCompactProductMatchText(product.description)
  const itemCode = normalizeCompactProductMatchText(item.productCode || item.model)
  const itemText = normalizeCompactProductMatchText(item.productText || item.rawLine)
  const itemTokens = normalizeProductMatchText(item.productText || item.rawLine)
    .split(' ')
    .filter((token) => token.length > 1 || token === 'E' || token === 'P')
    .filter((token) => !['NOS', 'PCS', 'QTY', 'UNIT', 'UNITS'].includes(token))
  let score = 0

  if (itemCode && productCode === itemCode) {
    score = Math.max(score, 100)
  } else if (itemCode && (productCode.includes(itemCode) || itemCode.includes(productCode))) {
    score = Math.max(score, 92)
  }

  if (itemText && productDescription.includes(itemText)) {
    score = Math.max(score, 96)
  } else if (itemCode && productDescription.includes(itemCode)) {
    score = Math.max(score, 88)
  }

  if (itemTokens.length > 0) {
    const matchedTokenCount = itemTokens.filter((token) =>
      productDescription.includes(token) || productCode.includes(token),
    ).length
    const tokenScore = Math.round((matchedTokenCount / itemTokens.length) * 25)
    score = Math.max(score, 65 + tokenScore)
  }

  return score
}

const findProductForItem = async (pool, tableNames, item) => {
  if (item.productCode || item.productText) {
    const itemCode = normalizeCompactProductMatchText(item.productCode || item.model)
    const itemText = normalizeCompactProductMatchText(item.productText || item.rawLine)

    if (!itemCode) {
      return {
        ambiguous: false,
        candidates: [],
        confidence: 0,
        product: null,
      }
    }

    const result = await pool.query(
      `
        SELECT id, code, description, hsn_code, category, unit, gst_percent
        FROM ${tableNames.product}
        WHERE REGEXP_REPLACE(UPPER(code), '[^A-Z0-9]+', '', 'g') LIKE $1
          OR REGEXP_REPLACE(UPPER(description), '[^A-Z0-9]+', '', 'g') LIKE $1
          OR ($2::text <> '' AND REGEXP_REPLACE(UPPER(description), '[^A-Z0-9]+', '', 'g') LIKE $2)
        ORDER BY code ASC
        LIMIT 25
      `,
      [`%${itemCode}%`, itemText ? `%${itemText}%` : ''],
    )
    const candidates = result.rows
      .map((product) => ({
        confidence: scoreProductCandidate(product, item),
        product,
      }))
      .filter((candidate) => candidate.confidence >= 70)
      .sort((left, right) => right.confidence - left.confidence)

    if (candidates.length === 0) {
      return {
        ambiguous: false,
        candidates: [],
        confidence: 0,
        product: null,
      }
    }

    const [best, second] = candidates
    const ambiguous =
      best.confidence < 85 ||
      (second && second.confidence >= best.confidence - 5)

    return {
      ambiguous,
      candidates: candidates.slice(0, 5),
      confidence: best.confidence,
      product: ambiguous ? null : best.product,
    }
  }

  const sizeNeedle = normalizeProductNeedle(item.size)
  const voltageNeedle = normalizeProductNeedle(item.voltage)
  const result = await pool.query(
    `
      SELECT id, code, description, hsn_code, category, unit, gst_percent
      FROM ${tableNames.product}
      WHERE LOWER(REPLACE(REPLACE(description, ' ', ''), 'W', '')) LIKE $1
        AND LOWER(REPLACE(description, ' ', '')) LIKE $2
      ORDER BY code ASC
      LIMIT 1
    `,
    [`%${sizeNeedle}%`, `%${voltageNeedle}%`],
  )

  return {
    ambiguous: false,
    candidates: result.rows.map((product) => ({ confidence: 90, product })).slice(0, 1),
    confidence: result.rowCount > 0 ? 90 : 0,
    product: result.rows[0] ?? null,
  }
}

const buildLineItems = async (pool, tableNames, parsedItems) => {
  const lines = []
  const warnings = []
  const errors = []
  const productCandidates = []

  for (const [index, item] of parsedItems.entries()) {
    const productMatch = await findProductForItem(pool, tableNames, item)
    const product = productMatch.product

    if (productMatch.candidates.length > 0) {
      productCandidates.push({
        lineNumber: item.lineNumber ?? index + 1,
        rawLine: item.rawLine,
        candidates: productMatch.candidates.map((candidate) => ({
          code: candidate.product.code,
          confidence: candidate.confidence,
          description: candidate.product.description,
        })),
      })
    }

    if (productMatch.ambiguous) {
      const candidateList = productMatch.candidates
        .map((candidate) => `${candidate.product.code} (${candidate.confidence}%)`)
        .join(', ')
      errors.push(
        `Ambiguous product match for row ${index + 1}: ${item.rawLine}. Candidates: ${candidateList}.`,
      )
      continue
    }

    if (!product) {
      const label = item.productText || `${item.size ?? ''} ${item.voltage ?? ''} ${item.model ?? ''}`
      errors.push(`Product not found for row ${index + 1}: ${compactSpaces(label)}.`)
      continue
    }

    lines.push({
      id: `whatsapp-line-${index + 1}`,
      productId: String(product.id ?? ''),
      productCode: product.code,
      productCategory: product.category ?? '',
      productDescription: product.description,
      description: product.description,
      hsnCode: product.hsn_code ?? '',
      quantity: item.quantity,
      unit: product.unit || item.unit || 'NOS',
      uomCode: 0,
      rate: 0,
      unitPrice: 0,
      amount: 0,
      basic: 0,
      discountPercent: 0,
      discountAmount: 0,
      gstPercent: toNumberValue(product.gst_percent),
      sourceItem: item,
    })
  }

  return {
    errors,
    lines,
    productCandidates,
    warnings,
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
  const customer = await findCustomer(pool, tableNames, parsed)
  const city = customer ? null : await findCity(pool, tableNames, parsed.place)
  const partyTypeName = customer?.party_type ?? ''
  const piDate = parsed.date || new Date().toISOString().slice(0, 10)
  const address = customer?.corr_address || toText(process.env.WHATSAPP_PI_DEFAULT_ADDRESS)
  const cityCode = Number(customer?.corr_city_code ?? city?.city_id ?? 0)
  const stateCode = Number(customer?.corr_state_code ?? city?.state_id ?? 0)
  const customerName = customer?.cust_name || parsed.partyName
  const lineResult = await buildLineItems(pool, tableNames, parsed.items)
  const companySelection = await selectCompanyForLineItems({
    lineItems: lineResult.lines,
    pool,
    tableNames,
  })
  const company = companySelection.selectedCompany
  const companySelectionErrors = companySelection.status === 'SELECTED'
    ? []
    : normalizeJSONList(companySelection.errors)
  const pricingResult = company
    ? await priceLineItemsForPI({
        compCode: Number(company.comp_code),
        custCode: Number(customer?.cust_code ?? 0),
        lineItems: lineResult.lines,
        partyTypeName,
        pool,
        requireCustomerDiscount: true,
        requireExactCompany: true,
        tableNames,
      })
    : {
        customerDiscount: null,
        errors: [],
        discountLookupStatus: 'COMPANY_NOT_SELECTED',
        lineItems: lineResult.lines,
        rateLookups: [],
        warnings: [],
      }
  const appliedCustomerDiscountPercent = Math.max(
    0,
    ...pricingResult.rateLookups.map((lookup) =>
      toNumberValue(lookup.customerDiscountPercent),
    ),
  )
  const totals = calculateCommercialTotals(pricingResult.lineItems, {
    customerDiscount: pricingResult.customerDiscount,
    companyStateCode: company?.state_code ?? '',
    customerStateCode: stateCode,
  })
  const piNumber = company
    ? await getNextPINumber(pool, tableNames, company)
    : {
        piNo: 0,
        piNumber: '',
        piSeries: '',
      }
  const commercialErrors = company
    ? validateCommercialPI({
        lineItems: pricingResult.lineItems,
        totals,
      })
    : []
  const errors = [
    ...lineResult.errors,
    ...companySelectionErrors,
    ...pricingResult.errors,
    ...commercialErrors,
  ]
  const warnings = [
    ...parsed.warnings,
    ...lineResult.warnings,
    ...normalizeJSONList(companySelection.warnings),
    ...pricingResult.warnings,
  ]
  const companySelectionErrorCode =
    companySelection.status === 'NO_PRODUCTS'
      ? 'PRODUCT_NOT_FOUND'
      : companySelection.status === 'SELECTED'
        ? ''
        : companySelection.status
  const commercialErrorCode =
    pricingResult.discountLookupStatus === 'DISCOUNT_NOT_FOUND'
      ? 'DISCOUNT_NOT_FOUND'
      : ''

  return {
    payload: {
      piNumber: piNumber.piNumber,
      piDate,
      deliveryDate: piDate,
      companyId: company?.company_id ?? '',
      companyName: company ? company.legal_name || company.company_name : '',
      compCode: Number(company?.comp_code ?? 0),
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
      prospectiveDiscountPercent: appliedCustomerDiscountPercent,
      prospectiveGstNo: customer?.gstin_no || parsed.gstNo || '',
      gstNo: customer?.gstin_no || parsed.gstNo || '',
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
      lineItems: pricingResult.lineItems,
      ...totals,
    },
    companySelection,
    customerDiscount: pricingResult.customerDiscount,
    errorCode: companySelectionErrorCode || commercialErrorCode,
    errors,
    rateLookups: pricingResult.rateLookups,
    taxCalculation: {
      cgstPercent: totals.cgstPercent,
      igstPercent: totals.igstPercent,
      sgstPercent: totals.sgstPercent,
      taxMode: totals.taxMode,
    },
    warnings,
    productCandidates: lineResult.productCandidates,
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

  if (message?.type === 'document') {
    return message.document?.caption ?? ''
  }

  if (message?.type === 'video') {
    return message.video?.caption ?? ''
  }

  return ''
}

const getWhatsappMediaInfo = (message) => {
  const mediaEnvelope = extractMediaEnvelope(message)

  return {
    caption: mediaEnvelope.caption,
    fileName: mediaEnvelope.fileName,
    mediaAnimated: mediaEnvelope.animated,
    mediaId: mediaEnvelope.mediaId,
    mediaMimeType: mediaEnvelope.mediaMimeType,
    mediaSha256: mediaEnvelope.mediaSha256,
    mediaType: mediaEnvelope.mediaType,
    mediaVoice: mediaEnvelope.voice,
  }
}

const getWhatsappMessageSource = (contact, message) => {
  const mediaInfo = getWhatsappMediaInfo(message)

  return {
    ...mediaInfo,
    messageId:
      message.id || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    rawPayload: {
      contact,
      message,
    },
    receivedAt: getWhatsappReceivedAt(message),
    senderName: contact?.profile?.name ?? '',
    senderPhone: message.from ?? contact?.wa_id ?? '',
    sourceType: message.type,
  }
}

const logWhatsappWebhook = (event, details = {}) => {
  console.log(
    JSON.stringify({
      event,
      scope: 'whatsapp-webhook',
      timestamp: new Date().toISOString(),
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

const getCustomerConfirmationProcessingStatus = (confirmationStatus) =>
  confirmationStatus === 'MANUAL_REVIEW'
    ? 'CUSTOMER_REPLY_MANUAL_REVIEW'
    : CUSTOMER_CONFIRMATION_PROCESSED_STATUS

class ManualReviewProcessingError extends Error {
  constructor(message, { parseStatus = 'MANUAL_REVIEW', processingStatus = 'MANUAL_REVIEW' } = {}) {
    super(message)
    this.name = 'ManualReviewProcessingError'
    this.parseStatus = parseStatus
    this.processingStatus = processingStatus
  }
}

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
          media_id varchar(160),
          media_type varchar(120),
          media_mime_type varchar(255),
          media_sha256 varchar(255),
          media_voice boolean,
          media_animated boolean,
          media_capture_status varchar(50),
          media_capture_error text,
          media_download_status varchar(50) NOT NULL DEFAULT 'PENDING',
          media_downloaded_at timestamptz,
          media_download_error text,
          media_file_size bigint,
          media_download_sha256 varchar(128),
          media_extraction_status varchar(50) NOT NULL DEFAULT 'PENDING',
          media_extracted_text text,
          media_extracted_at timestamptz,
          media_extraction_error text,
          media_extraction_method varchar(50),
          media_order_parse_status varchar(50) NOT NULL DEFAULT 'PENDING',
          media_order_candidate jsonb,
          media_order_parsed_at timestamptz,
          media_order_parse_error text,
          media_excel_status varchar(50) NOT NULL DEFAULT 'PENDING',
          media_excel_candidate jsonb,
          media_excel_processed_at timestamptz,
          media_excel_error text,
          media_word_status varchar(50) NOT NULL DEFAULT 'PENDING',
          media_word_candidate jsonb,
          media_word_processed_at timestamptz,
          media_word_error text,
          media_path text,
          file_name text,
          caption text,
          message_text text NOT NULL DEFAULT '',
          raw_text text NOT NULL DEFAULT '',
          raw_payload jsonb,
          source_type varchar(40),
          import_status varchar(40) NOT NULL DEFAULT 'received',
          import_result jsonb,
          ocr_text text,
          processing_text text,
          parsed_json jsonb,
          parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
          parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
          parsed_payload jsonb,
          customer_id bigint,
          product_count integer NOT NULL DEFAULT 0,
          confidence_score numeric(5, 2) NOT NULL DEFAULT 0,
          draft_pi_no varchar(40),
          final_pi_no varchar(40),
          processing_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          reply_status varchar(40) NOT NULL DEFAULT 'NOT_SENT',
          error_details jsonb,
          pi_created boolean NOT NULL DEFAULT FALSE,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await pool.query(`
        ALTER TABLE ${WHATSAPP_MESSAGE_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS media_id varchar(160),
          ADD COLUMN IF NOT EXISTS media_type varchar(120),
          ADD COLUMN IF NOT EXISTS media_mime_type varchar(255),
          ADD COLUMN IF NOT EXISTS media_sha256 varchar(255),
          ADD COLUMN IF NOT EXISTS media_voice boolean,
          ADD COLUMN IF NOT EXISTS media_animated boolean,
          ADD COLUMN IF NOT EXISTS media_capture_status varchar(50),
          ADD COLUMN IF NOT EXISTS media_capture_error text,
          ADD COLUMN IF NOT EXISTS media_download_status varchar(50) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS media_downloaded_at timestamptz,
          ADD COLUMN IF NOT EXISTS media_download_error text,
          ADD COLUMN IF NOT EXISTS media_file_size bigint,
          ADD COLUMN IF NOT EXISTS media_download_sha256 varchar(128),
          ADD COLUMN IF NOT EXISTS media_extraction_status varchar(50) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS media_extracted_text text,
          ADD COLUMN IF NOT EXISTS media_extracted_at timestamptz,
          ADD COLUMN IF NOT EXISTS media_extraction_error text,
          ADD COLUMN IF NOT EXISTS media_extraction_method varchar(50),
          ADD COLUMN IF NOT EXISTS media_order_parse_status varchar(50) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS media_order_candidate jsonb,
          ADD COLUMN IF NOT EXISTS media_order_parsed_at timestamptz,
          ADD COLUMN IF NOT EXISTS media_order_parse_error text,
          ADD COLUMN IF NOT EXISTS media_excel_status varchar(50) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS media_excel_candidate jsonb,
          ADD COLUMN IF NOT EXISTS media_excel_processed_at timestamptz,
          ADD COLUMN IF NOT EXISTS media_excel_error text,
          ADD COLUMN IF NOT EXISTS media_word_status varchar(50) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS media_word_candidate jsonb,
          ADD COLUMN IF NOT EXISTS media_word_processed_at timestamptz,
          ADD COLUMN IF NOT EXISTS media_word_error text,
          ADD COLUMN IF NOT EXISTS media_path text,
          ADD COLUMN IF NOT EXISTS file_name text,
          ADD COLUMN IF NOT EXISTS caption text,
          ADD COLUMN IF NOT EXISTS raw_text text NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS raw_payload jsonb,
          ADD COLUMN IF NOT EXISTS source_type varchar(40),
          ADD COLUMN IF NOT EXISTS ocr_text text,
          ADD COLUMN IF NOT EXISTS processing_text text,
          ADD COLUMN IF NOT EXISTS parsed_json jsonb,
          ADD COLUMN IF NOT EXISTS parse_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          ADD COLUMN IF NOT EXISTS parse_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS parse_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS parsed_payload jsonb,
          ADD COLUMN IF NOT EXISTS customer_id bigint,
          ADD COLUMN IF NOT EXISTS product_count integer NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS confidence_score numeric(5, 2) NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS draft_pi_no varchar(40),
          ADD COLUMN IF NOT EXISTS final_pi_no varchar(40),
          ADD COLUMN IF NOT EXISTS processing_status varchar(40) NOT NULL DEFAULT 'RECEIVED',
          ADD COLUMN IF NOT EXISTS reply_status varchar(40) NOT NULL DEFAULT 'NOT_SENT',
          ADD COLUMN IF NOT EXISTS error_details jsonb,
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
        SET processing_status = parse_status
        WHERE processing_status = 'RECEIVED'
          AND parse_status IS NOT NULL
          AND parse_status <> ''
          AND parse_status <> 'RECEIVED'
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
        UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
        SET processing_status = parse_status
        WHERE processing_status = 'RECEIVED'
          AND parse_status IS NOT NULL
          AND parse_status <> ''
          AND parse_status <> 'RECEIVED'
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
      await ensureWhatsAppMediaCaptureSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppMediaDownloadSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppMediaTextExtractionSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppMediaOrderCandidateSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppExcelProcessingSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppWordProcessingSchema(pool, { tableName: WHATSAPP_MESSAGE_TABLE_NAME })
      await ensureWhatsAppAcknowledgementSchema(pool)
      await ensurePiSummarySchema(pool)
      await ensureWhatsAppSendLogSchema(pool)
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

let whatsappMessageEventSchemaPromise

const ensureWhatsappMessageEventSchema = async (pool) => {
  if (!whatsappMessageEventSchemaPromise) {
    whatsappMessageEventSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${WHATSAPP_MESSAGE_EVENT_TABLE_NAME} (
          id bigserial PRIMARY KEY,
          message_id varchar(160) NOT NULL,
          processing_status varchar(40),
          parse_status varchar(40),
          details jsonb,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_message_events_message_id
        ON ${WHATSAPP_MESSAGE_EVENT_TABLE_NAME} (message_id, created_at DESC)
      `)
    })()
  }

  try {
    await whatsappMessageEventSchemaPromise
  } catch (error) {
    whatsappMessageEventSchemaPromise = undefined
    throw error
  }
}

const recordWhatsappMessageEvent = async (
  dependencies,
  {
    details = null,
    messageId,
    parseStatus = '',
    processingStatus = '',
  },
) => {
  await ensureWhatsappMessageEventSchema(dependencies.pool)
  await dependencies.pool.query(
    `
      INSERT INTO ${WHATSAPP_MESSAGE_EVENT_TABLE_NAME}
        (message_id, processing_status, parse_status, details)
      VALUES
        ($1, $2, $3, $4::jsonb)
    `,
    [
      toLimitedText(messageId, 160),
      toLimitedText(processingStatus, 40),
      toLimitedText(parseStatus, 40),
      details ? JSON.stringify(details) : null,
    ],
  )
}

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
  acknowledgementAttempts: Number(row.acknowledgement_attempts ?? 0),
  acknowledgementError: row.acknowledgement_error ?? '',
  acknowledgementMessage: row.acknowledgement_message ?? '',
  acknowledgementSentAt:
    row.acknowledgement_sent_at instanceof Date
      ? row.acknowledgement_sent_at.toISOString()
      : row.acknowledgement_sent_at ?? '',
  acknowledgementStatus: row.acknowledgement_status ?? '',
  acknowledgementWhatsappMessageId: row.acknowledgement_whatsapp_message_id ?? '',
  customerChangeRequest: row.customer_change_request ?? '',
  customerConfirmationAt:
    row.customer_confirmation_at instanceof Date
      ? row.customer_confirmation_at.toISOString()
      : row.customer_confirmation_at ?? '',
  customerConfirmationMessageId: row.customer_confirmation_message_id ?? '',
  customerConfirmationStatus: row.customer_confirmation_status ?? '',
  id: Number(row.id),
  caption: row.caption ?? '',
  confidenceScore: Number(row.confidence_score ?? 0),
  customerId: row.customer_id === null || row.customer_id === undefined
    ? null
    : Number(row.customer_id),
  draftPiNo: row.draft_pi_no ?? '',
  errorDetails: row.error_details ?? null,
  fileName: row.file_name ?? '',
  finalPiNo: row.final_pi_no ?? '',
  importStatus: row.import_status ?? '',
  mediaId: row.media_id ?? '',
  mediaMimeType: row.media_mime_type ?? '',
  mediaPath: row.media_path ?? '',
  mediaSha256: row.media_sha256 ?? '',
  mediaType: row.media_type ?? '',
  mediaVoice: row.media_voice === null || row.media_voice === undefined
    ? null
    : Boolean(row.media_voice),
  mediaAnimated: row.media_animated === null || row.media_animated === undefined
    ? null
    : Boolean(row.media_animated),
  mediaCaptureStatus: row.media_capture_status ?? '',
  mediaCaptureError: row.media_capture_error ?? '',
  mediaDownloadStatus: row.media_download_status ?? 'PENDING',
  mediaDownloadedAt: row.media_downloaded_at ?? null,
  mediaDownloadError: row.media_download_error ?? '',
  mediaFileSize: row.media_file_size === null || row.media_file_size === undefined
    ? null
    : Number(row.media_file_size),
  mediaDownloadSha256: row.media_download_sha256 ?? '',
  mediaExtractionStatus: row.media_extraction_status ?? 'PENDING',
  mediaExtractedText: row.media_extracted_text ?? '',
  mediaExtractedAt: row.media_extracted_at ?? null,
  mediaExtractionError: row.media_extraction_error ?? '',
  mediaExtractionMethod: row.media_extraction_method ?? '',
  mediaOrderParseStatus: row.media_order_parse_status ?? 'PENDING',
  mediaOrderCandidate: row.media_order_candidate ?? null,
  mediaOrderParsedAt: row.media_order_parsed_at ?? null,
  mediaOrderParseError: row.media_order_parse_error ?? '',
  mediaExcelStatus: row.media_excel_status ?? 'PENDING',
  mediaExcelCandidate: row.media_excel_candidate ?? null,
  mediaExcelProcessedAt: row.media_excel_processed_at ?? null,
  mediaExcelError: row.media_excel_error ?? '',
  mediaWordStatus: row.media_word_status ?? 'PENDING',
  mediaWordCandidate: row.media_word_candidate ?? null,
  mediaWordProcessedAt: row.media_word_processed_at ?? null,
  mediaWordError: row.media_word_error ?? '',
  messageId: row.message_id ?? '',
  messageText: row.message_text ?? '',
  messageType: row.message_type ?? '',
  ocrText: row.ocr_text ?? '',
  parseErrors: row.parse_errors ?? [],
  parseStatus: row.parse_status ?? '',
  parseWarnings: row.parse_warnings ?? [],
  processingText: row.processing_text ?? '',
  processingStatus: row.processing_status ?? row.parse_status ?? '',
  productCount: Number(row.product_count ?? 0),
  piCreated: Boolean(row.pi_created),
  piSummaryError: row.pi_summary_error ?? '',
  piSummaryMessage: row.pi_summary_message ?? '',
  piSummaryMetaMessageId: row.pi_summary_meta_message_id ?? '',
  piSummarySentAt:
    row.pi_summary_sent_at instanceof Date
      ? row.pi_summary_sent_at.toISOString()
      : row.pi_summary_sent_at ?? '',
  piSummaryStatus: row.pi_summary_status ?? '',
  rawPayload: row.raw_payload ?? null,
  rawText: row.raw_text ?? row.message_text ?? '',
  replyStatus: row.reply_status ?? '',
  receivedAt:
    row.received_at instanceof Date
      ? row.received_at.toISOString()
      : row.received_at ?? '',
  senderName: row.sender_name ?? '',
  senderPhone: row.sender_phone ?? '',
  sourceType: row.source_type ?? row.message_type ?? '',
  updatedAt:
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at ?? '',
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
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        media_path,
        file_name,
        caption,
        message_text,
        raw_text,
        raw_payload,
        import_status,
        ocr_text,
        processing_text,
        parse_status,
        parse_warnings,
        parse_errors,
        customer_id,
        product_count,
        confidence_score,
        draft_pi_no,
        final_pi_no,
        processing_status,
        reply_status,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts,
        pi_summary_status,
        pi_summary_message,
        pi_summary_sent_at,
        pi_summary_meta_message_id,
        pi_summary_error,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request,
        error_details,
        pi_created,
        updated_at
      FROM ${WHATSAPP_MESSAGE_TABLE_NAME}
      ORDER BY received_at DESC, id DESC
      LIMIT $1
    `,
    [limit],
  )

  return result.rows.map(mapIncomingWhatsappMessageRow)
}

const getIncomingWhatsappMessageByMessageId = async (dependencies, messageId) => {
  await ensureWhatsappMessageSchema(dependencies.pool)
  const result = await dependencies.pool.query(
    `
      SELECT
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        media_path,
        file_name,
        caption,
        source_type,
        message_text,
        raw_text,
        raw_payload,
        import_status,
        ocr_text,
        processing_text,
        parse_status,
        parse_warnings,
        parse_errors,
        customer_id,
        product_count,
        confidence_score,
        draft_pi_no,
        final_pi_no,
        processing_status,
        reply_status,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts,
        pi_summary_status,
        pi_summary_message,
        pi_summary_sent_at,
        pi_summary_meta_message_id,
        pi_summary_error,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request,
        error_details,
        pi_created,
        updated_at
      FROM ${WHATSAPP_MESSAGE_TABLE_NAME}
      WHERE message_id = $1
      LIMIT 1
    `,
    [toLimitedText(messageId, 160)],
  )

  return result.rows[0] ? mapIncomingWhatsappMessageRow(result.rows[0]) : null
}

const getIncomingWhatsappMessageById = async (dependencies, rowId) => {
  await ensureWhatsappMessageSchema(dependencies.pool)
  const result = await dependencies.pool.query(
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
        processing_text,
        caption,
        parse_status,
        processing_status,
        reply_status,
        draft_pi_no,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        updated_at
      FROM ${WHATSAPP_MESSAGE_TABLE_NAME}
      WHERE id = $1::bigint
      LIMIT 1
    `,
    [Number(rowId)],
  )

  return result.rows[0] ? mapIncomingWhatsappMessageRow(result.rows[0]) : null
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
  if (parseStatus === 'PI_CREATED' || parseStatus === 'DRAFT_PI_CREATED') {
    return 'imported'
  }

  if (parseStatus === 'DUPLICATE') {
    return 'duplicate'
  }

  if (
    parseStatus === 'CUSTOMER_NOT_FOUND' ||
    parseStatus === 'PRODUCT_NOT_FOUND' ||
    parseStatus === 'MANUAL_REVIEW' ||
    parseStatus === 'PARSE_FAILED' ||
    parseStatus === 'PI_FAILED' ||
    parseStatus === 'FAILED'
  ) {
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
    caption = '',
    fileName = '',
    mediaAnimated = null,
    mediaId = '',
    mediaMimeType = '',
    mediaSha256 = '',
    mediaType = '',
    mediaVoice = null,
    messageId,
    messageText,
    messageType,
    rawPayload = null,
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
          media_id,
          media_type,
          media_mime_type,
          media_sha256,
          media_voice,
          media_animated,
          file_name,
          caption,
          source_type,
          message_text,
          raw_text,
          raw_payload,
          import_status,
          processing_status,
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
          $8,
          $9,
          $10::boolean,
          $11::boolean,
          $12,
          $13,
          $14,
          $15,
          $15,
          $16::jsonb,
          'received',
          'RECEIVED',
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
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        media_path,
        file_name,
        caption,
        source_type,
        message_text,
        raw_text,
        raw_payload,
        import_status,
        ocr_text,
        processing_text,
        parse_status,
        parse_warnings,
        parse_errors,
        customer_id,
        product_count,
        confidence_score,
        draft_pi_no,
        final_pi_no,
        processing_status,
        reply_status,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts,
        pi_summary_status,
        pi_summary_message,
        pi_summary_sent_at,
        pi_summary_meta_message_id,
        pi_summary_error,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request,
        error_details,
        pi_created,
        updated_at
    `,
    [
      storedMessageId,
      receivedAt,
      toLimitedText(senderName, 160),
      toLimitedText(senderPhone, 50),
      toLimitedText(messageType, 40),
      toLimitedText(mediaId, 160),
      toLimitedText(mediaType, 120),
      toLimitedText(mediaMimeType, 255),
      toLimitedText(mediaSha256, 255),
      mediaVoice,
      mediaAnimated,
      toLimitedText(fileName, 250),
      toLimitedText(caption, 500),
      toLimitedText(sourceType || messageType, 40),
      normalizeText(messageText),
      rawPayload ? JSON.stringify(rawPayload) : null,
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
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        media_path,
        file_name,
        caption,
        source_type,
        message_text,
        raw_text,
        raw_payload,
        import_status,
        ocr_text,
        processing_text,
        parse_status,
        parse_warnings,
        parse_errors,
        customer_id,
        product_count,
        confidence_score,
        draft_pi_no,
        final_pi_no,
        processing_status,
        reply_status,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts,
        pi_summary_status,
        pi_summary_message,
        pi_summary_sent_at,
        pi_summary_meta_message_id,
        pi_summary_error,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request,
        error_details,
        pi_created,
        updated_at
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
    confidenceScore = null,
    customerId = null,
    draftPiNo = null,
    errorDetails = null,
    finalPiNo = null,
    importResult = null,
    mediaPath = null,
    messageId,
    messageText,
    ocrText = null,
    parsedPayload = null,
    parseErrors = [],
    parseStatus,
    parseWarnings = [],
    piCreated = false,
    processingText = null,
    processingStatus = null,
    customerConfirmationStatus = null,
    productCount = null,
    replyStatus = null,
  },
) => {
  await ensureWhatsappMessageSchema(dependencies.pool)

  const result = await dependencies.pool.query(
    `
      UPDATE ${WHATSAPP_MESSAGE_TABLE_NAME}
      SET
        message_text = COALESCE($2, message_text),
        import_status = $3,
        import_result = $4::jsonb,
        parse_status = $5,
        parse_warnings = $6::jsonb,
        parse_errors = $7::jsonb,
        parsed_payload = $8::jsonb,
        parsed_json = $8::jsonb,
        pi_created = $9,
        media_path = COALESCE($10, media_path),
        ocr_text = COALESCE($11, ocr_text),
        processing_text = COALESCE($12, processing_text),
        customer_id = COALESCE($13::bigint, customer_id),
        product_count = COALESCE($14::integer, product_count),
        confidence_score = COALESCE($15::numeric, confidence_score),
        draft_pi_no = COALESCE($16, draft_pi_no),
        final_pi_no = COALESCE($17, final_pi_no),
        processing_status = COALESCE($18, processing_status),
        reply_status = COALESCE($19, reply_status),
        error_details = COALESCE($20::jsonb, error_details),
        customer_confirmation_status = COALESCE($21::varchar, customer_confirmation_status),
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1
      RETURNING
        id,
        message_id,
        received_at,
        sender_name,
        sender_phone,
        message_type,
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_voice,
        media_animated,
        media_capture_status,
        media_capture_error,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        media_order_parse_status,
        media_order_candidate,
        media_order_parsed_at,
        media_order_parse_error,
        media_excel_status,
        media_excel_candidate,
        media_excel_processed_at,
        media_excel_error,
        media_word_status,
        media_word_candidate,
        media_word_processed_at,
        media_word_error,
        media_path,
        file_name,
        caption,
        source_type,
        message_text,
        raw_text,
        raw_payload,
        import_status,
        ocr_text,
        processing_text,
        parse_status,
        parse_warnings,
        parse_errors,
        customer_id,
        product_count,
        confidence_score,
        draft_pi_no,
        final_pi_no,
        processing_status,
        reply_status,
        acknowledgement_status,
        acknowledgement_message,
        acknowledgement_sent_at,
        acknowledgement_whatsapp_message_id,
        acknowledgement_error,
        acknowledgement_attempts,
        pi_summary_status,
        pi_summary_message,
        pi_summary_sent_at,
        pi_summary_meta_message_id,
        pi_summary_error,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request,
        error_details,
        pi_created,
        updated_at
    `,
    [
      toLimitedText(messageId, 160),
      messageText === null || messageText === undefined
        ? null
        : normalizeText(messageText),
      mapParseStatusToImportStatus(parseStatus),
      importResult ? JSON.stringify(importResult) : null,
      parseStatus,
      JSON.stringify(normalizeJSONList(parseWarnings)),
      JSON.stringify(normalizeJSONList(parseErrors)),
      parsedPayload ? JSON.stringify(parsedPayload) : null,
      piCreated,
      mediaPath,
      ocrText,
      processingText === null || processingText === undefined
        ? null
        : normalizeText(processingText),
      customerId,
      productCount,
      confidenceScore,
      draftPiNo,
      finalPiNo,
      processingStatus ?? parseStatus,
      replyStatus,
      errorDetails ? JSON.stringify(errorDetails) : null,
      customerConfirmationStatus,
    ],
  )

  if (result.rowCount === 0) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappPi.js',
      currentFunction: 'updateIncomingWhatsappMessageProcessing',
      messageId,
      messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
      piNumber: draftPiNo,
      reason: 'Incoming WhatsApp message row was not found, so acknowledgement cannot be triggered.',
    })
    return null
  }

  const mappedRow = mapIncomingWhatsappMessageRow(result.rows[0])
  await recordWhatsappMessageEvent(dependencies, {
    details: {
      errorCount: normalizeJSONList(parseErrors).length,
      hasMediaPath: Boolean(mediaPath),
      ocrCharacterCount: normalizeText(ocrText).length,
      processingTextCharacterCount: normalizeText(processingText).length,
      productCount,
      warningCount: normalizeJSONList(parseWarnings).length,
    },
    messageId,
    parseStatus,
    processingStatus: processingStatus ?? parseStatus,
  })

  const resolvedProcessingStatus = processingStatus ?? parseStatus

  logWhatsAppOutgoingTrace('Acknowledgement trigger check', {
    currentFile: 'backend/whatsappPi.js',
    currentFunction: 'updateIncomingWhatsappMessageProcessing',
    destinationPhone: mappedRow.senderPhone,
    messageId,
    messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
    piNumber: draftPiNo ?? mappedRow.draftPiNo,
    processingStatus: resolvedProcessingStatus,
    senderPhone: mappedRow.senderPhone,
  })

  if (isAcknowledgementTerminalStatus(resolvedProcessingStatus)) {
    try {
      logWhatsAppOutgoingTrace('Acknowledgement trigger', {
        currentFile: 'backend/whatsappPi.js',
        currentFunction: 'updateIncomingWhatsappMessageProcessing',
        destinationPhone: mappedRow.senderPhone,
        messageId,
        messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
        piNumber: draftPiNo ?? mappedRow.draftPiNo,
        senderPhone: mappedRow.senderPhone,
        sharedSenderCalled: false,
      })
      logWhatsappWebhook('Acknowledgement requested', {
        draftPiNo: draftPiNo ?? mappedRow.draftPiNo,
        messageId,
        processingStatus: resolvedProcessingStatus,
      })
      const acknowledgementResult = await sendAutomaticAcknowledgement({
        fetchImpl: dependencies.fetch,
        incomingMessageRecord: mappedRow,
        piNumber: draftPiNo ?? mappedRow.draftPiNo,
        pool: dependencies.pool,
        processingStatus: resolvedProcessingStatus,
      })
      await recordWhatsappMessageEvent(dependencies, {
        details: {
          acknowledgementStatus: acknowledgementResult.status,
          attempts: acknowledgementResult.attempts ?? 0,
          errorCode: acknowledgementResult.errorCode ?? '',
          hasMetaMessageId: Boolean(acknowledgementResult.metaMessageId),
        },
        messageId,
        parseStatus,
        processingStatus: 'ACKNOWLEDGEMENT',
      })
      logWhatsappWebhook('whatsapp_acknowledgement_processed', {
        acknowledgementStatus: acknowledgementResult.status,
        failureCategory: acknowledgementResult.failureCategory ?? '',
        messageId,
      })
      logWhatsAppOutgoingTrace('Acknowledgement result received', {
        acknowledgementStatus: acknowledgementResult.status,
        currentFile: 'backend/whatsappPi.js',
        currentFunction: 'updateIncomingWhatsappMessageProcessing',
        destinationPhone: mappedRow.senderPhone,
        messageId,
        messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
        piNumber: draftPiNo ?? mappedRow.draftPiNo,
        senderPhone: mappedRow.senderPhone,
        sendLogId: acknowledgementResult.sendLogId,
      })
      if (
        acknowledgementResult.status === 'SENT' &&
        ['DRAFT_PI_CREATED', 'PI_CREATED'].includes(resolvedProcessingStatus)
      ) {
        logWhatsAppOutgoingTrace('PI summary trigger', {
          currentFile: 'backend/whatsappPi.js',
          currentFunction: 'updateIncomingWhatsappMessageProcessing',
          destinationPhone: mappedRow.senderPhone,
          messageId,
          messagePurpose: 'PI_SUMMARY',
          piNumber: draftPiNo ?? mappedRow.draftPiNo,
          senderPhone: mappedRow.senderPhone,
          sharedSenderCalled: false,
        })
        logWhatsappWebhook('Starting PI summary', {
          draftPiNo: draftPiNo ?? mappedRow.draftPiNo,
          messageId,
        })
        const summaryResult = await sendPiSummaryForMessage({
          fetchImpl: dependencies.fetch,
          incomingMessageRecord: mappedRow,
          piNumber: draftPiNo ?? mappedRow.draftPiNo,
          pool: dependencies.pool,
          tableNames: dependencies.tableNames,
        })
        await recordWhatsappMessageEvent(dependencies, {
          details: {
            errorCode: summaryResult.errorCode ?? '',
            hasMetaMessageId: Boolean(summaryResult.metaMessageId),
            piSummaryStatus: summaryResult.status,
          },
          messageId,
          parseStatus,
          processingStatus: 'PI_SUMMARY',
        })
        logWhatsappWebhook('whatsapp_pi_summary_processed', {
          messageId,
          metaMessageId: summaryResult.metaMessageId ?? '',
          piSummaryStatus: summaryResult.status,
        })
      } else {
        const reason =
          acknowledgementResult.status !== 'SENT'
            ? `PI summary not triggered because acknowledgement status is ${acknowledgementResult.status}.`
            : `PI summary not triggered because processing status is ${resolvedProcessingStatus}.`
        logWhatsAppOutgoingEarlyReturn({
          currentFile: 'backend/whatsappPi.js',
          currentFunction: 'updateIncomingWhatsappMessageProcessing',
          destinationPhone: mappedRow.senderPhone,
          messageId,
          messagePurpose: 'PI_SUMMARY',
          piNumber: draftPiNo ?? mappedRow.draftPiNo,
          reason,
          senderPhone: mappedRow.senderPhone,
        })
      }
    } catch (error) {
      await recordWhatsappMessageEvent(dependencies, {
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
        messageId,
        parseStatus,
        processingStatus: 'ACKNOWLEDGEMENT_FAILED',
      })
      logWhatsappWebhook('whatsapp_acknowledgement_failed', {
        error: error instanceof Error ? error.message : String(error),
        messageId,
      })
    }
  } else {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/whatsappPi.js',
      currentFunction: 'updateIncomingWhatsappMessageProcessing',
      destinationPhone: mappedRow.senderPhone,
      messageId,
      messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
      piNumber: draftPiNo ?? mappedRow.draftPiNo,
      reason: 'Processing status is not terminal for acknowledgement.',
      processingStatus: resolvedProcessingStatus,
      senderPhone: mappedRow.senderPhone,
    })
    logWhatsappWebhook('Acknowledgement skipped', {
      messageId,
      reason: 'Processing status is not terminal for acknowledgement.',
      processingStatus: resolvedProcessingStatus,
    })
  }

  return mappedRow
}

const getCustomerCommandText = (messageRow, fallbackText = '') =>
  normalizeText(
    fallbackText ||
    messageRow?.processingText ||
    messageRow?.rawText ||
    messageRow?.messageText ||
    messageRow?.caption ||
    '',
  )

const processCustomerCommandForIncomingMessage = async (
  dependencies,
  {
    incomingMessage,
    messageText = '',
    senderPhone = '',
  },
) => {
  const commandText = getCustomerCommandText(incomingMessage, messageText)
  const detectedCommand = detectCustomerCommand(commandText)

  if (!detectedCommand.handled) {
    return {
      handled: false,
      status: detectedCommand.status,
    }
  }

  logWhatsappWebhook('CUSTOMER COMMAND DETECTED', {
    command: detectedCommand.command,
    messageId: incomingMessage.messageId,
    piNumber: detectedCommand.piNumber,
    senderPhone: senderPhone || incomingMessage.senderPhone,
  })
  logWhatsAppOutgoingTrace('CUSTOMER COMMAND DETECTED', {
    command: detectedCommand.command,
    currentFile: 'backend/whatsappPi.js',
    currentFunction: 'processCustomerCommandForIncomingMessage',
    destinationPhone: senderPhone || incomingMessage.senderPhone,
    messageId: incomingMessage.messageId,
    messagePurpose: 'CUSTOMER_CONFIRMATION_ACK',
    piNumber: detectedCommand.piNumber,
    senderPhone: senderPhone || incomingMessage.senderPhone,
  })

  try {
    const confirmationResult = await handleCustomerConfirmationReply({
      dryRun: false,
      env: dependencies.env ?? process.env,
      fetchImpl: dependencies.fetch,
      messageId: incomingMessage.messageId,
      pool: dependencies.pool,
      replyText: commandText,
      sendResponse: true,
      senderPhone: senderPhone || incomingMessage.senderPhone,
      tableNames: dependencies.tableNames,
    })
    const errors = normalizeJSONList(confirmationResult.errors)
    const warnings = confirmationResult.sendResult?.ok === false
      ? [confirmationResult.sendResult.errorMessage || 'Confirmation response was not sent.']
      : []
    const processingStatus = getCustomerConfirmationProcessingStatus(confirmationResult.status)
    const incomingUpdate = await updateIncomingWhatsappMessageProcessing(dependencies, {
      customerConfirmationStatus: confirmationResult.status,
      draftPiNo: confirmationResult.piNumber,
      errorDetails: errors.length > 0 ? { errors } : null,
      importResult: {
        command: confirmationResult.command ?? detectedCommand.command,
        errors,
        inserted: false,
        piNumber: confirmationResult.piNumber,
        responseMessage: confirmationResult.responseMessage,
        status: confirmationResult.status,
      },
      messageId: incomingMessage.messageId,
      messageText: commandText,
      parseErrors: errors,
      parseStatus: 'CONFIRMATION_COMMAND',
      parseWarnings: warnings,
      processingStatus,
      processingText: commandText,
      replyStatus: confirmationResult.status,
    })

    logWhatsappWebhook('Incoming row update result', {
      messageId: incomingMessage.messageId,
      piNumber: confirmationResult.piNumber,
      processingStatus,
      rowFound: Boolean(incomingUpdate),
      status: confirmationResult.status,
    })
    logWhatsAppOutgoingTrace('Incoming row update result', {
      currentFile: 'backend/whatsappPi.js',
      currentFunction: 'processCustomerCommandForIncomingMessage',
      destinationPhone: senderPhone || incomingMessage.senderPhone,
      messageId: incomingMessage.messageId,
      messagePurpose: 'CUSTOMER_CONFIRMATION_ACK',
      piNumber: confirmationResult.piNumber,
      senderPhone: senderPhone || incomingMessage.senderPhone,
      status: confirmationResult.status,
    })

    return {
      confirmationResult,
      errors,
      handled: true,
      incomingUpdate,
      parseStatus: 'CONFIRMATION_COMMAND',
      processingStatus,
      warnings,
    }
  } catch (error) {
    logWhatsappWebhook('customer_confirmation_handler_failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'UnknownError',
      messageId: incomingMessage.messageId,
      piNumber: detectedCommand.piNumber,
      sqlstate: error?.code ?? '',
      stack: error instanceof Error ? error.stack : '',
    })
    throw error
  }
}

const processExistingCustomerConfirmationRow = async (
  dependencies,
  {
    rowId,
  } = {},
) => {
  const incomingMessage = await getIncomingWhatsappMessageById(dependencies, rowId)

  if (!incomingMessage) {
    return {
      errors: [`Incoming WhatsApp row ${rowId} was not found.`],
      handled: false,
      status: 'ROW_NOT_FOUND',
    }
  }

  const commandText = getCustomerCommandText(incomingMessage)
  const detectedCommand = detectCustomerCommand(commandText)

  if (!detectedCommand.handled) {
    return {
      errors: ['Saved row does not contain a customer confirmation command.'],
      handled: false,
      incomingMessage,
      status: detectedCommand.status,
    }
  }

  const commandResult = await processCustomerCommandForIncomingMessage(dependencies, {
    incomingMessage,
    messageText: commandText,
    senderPhone: incomingMessage.senderPhone,
  })
  const updatedMessage = await getIncomingWhatsappMessageById(dependencies, rowId)

  return {
    ...commandResult,
    command: detectedCommand.command,
    incomingMessage: updatedMessage,
    piNumber: commandResult.confirmationResult?.piNumber ?? detectedCommand.piNumber,
    status: commandResult.confirmationResult?.status ?? commandResult.status,
  }
}

const captureSavedWhatsappMediaMessage = async (
  dependencies,
  {
    contact = null,
    duplicate = false,
    message,
    messageSource,
    savedMessage,
  } = {},
) => {
  const sourceRecord = savedMessage?.row ?? null
  const envelope = extractMediaEnvelope(message, contact)

  logWhatsappWebhook('whatsapp_media_capture_started', {
    mediaId: envelope.mediaId,
    mediaType: envelope.mediaType,
    messageId: messageSource?.messageId ?? envelope.messageId,
    messageType: envelope.messageType,
    senderPhone: messageSource?.senderPhone ?? envelope.senderPhone,
  })

  const captureResult = await captureIncomingMedia({
    contact,
    message,
    pool: dependencies.pool,
    sourceRecord,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeMediaLogDetails(captureResult)

  if (duplicate) {
    logWhatsappWebhook('whatsapp_media_duplicate', safeDetails)
  }

  if (captureResult.mediaCaptureStatus === 'PARTIAL') {
    logWhatsappWebhook('whatsapp_media_capture_partial', safeDetails)
  }

  if (captureResult.mediaCaptureStatus === 'FAILED') {
    logWhatsappWebhook('whatsapp_media_capture_failed', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_media_capture_saved', safeDetails)
  }

  return {
    captureResult,
    webhookResult: createWebhookResult({
      duplicate,
      errors: captureResult.errors,
      inserted: !duplicate,
      messageId: messageSource?.messageId ?? captureResult.messageId,
      parseStatus: captureResult.processingStatus,
      piCreated: false,
      saved: true,
      warnings: captureResult.warnings,
    }),
  }
}

const downloadCapturedWhatsappMediaMessage = async (
  dependencies,
  {
    messageId,
  } = {},
) => {
  logWhatsappWebhook('whatsapp_media_download_started', {
    messageId,
  })

  const downloadResult = await downloadCapturedWhatsAppMedia({
    env: process.env,
    fetchImpl: dependencies.fetch || globalThis.fetch,
    messageId,
    pool: dependencies.pool,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeMediaDownloadLogDetails(downloadResult)

  if (downloadResult.skipped) {
    logWhatsappWebhook('whatsapp_media_download_skipped_existing', safeDetails)
  } else if (downloadResult.status === 'DOWNLOADED') {
    logWhatsappWebhook('whatsapp_media_download_completed', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_media_download_failed', safeDetails)
  }

  if (downloadResult.status === 'DOWNLOADED') {
    if (isSupportedExcelMedia({
      mediaPath: downloadResult.mediaPath,
      mimeType: downloadResult.mimeType,
    })) {
      await processDownloadedWhatsappExcelMessage(dependencies, { messageId }).catch((error) => {
        logWhatsappWebhook('whatsapp_excel_processing_failed', {
          error: error instanceof Error ? error.message : String(error),
          messageId,
        })
      })
    } else if (isSupportedWordMedia({
      mediaPath: downloadResult.mediaPath,
      mimeType: downloadResult.mimeType,
    })) {
      await processDownloadedWhatsappWordMessage(dependencies, { messageId }).catch((error) => {
        logWhatsappWebhook('whatsapp_word_processing_failed', {
          error: error instanceof Error ? error.message : String(error),
          messageId,
        })
      })
    } else {
      await extractDownloadedWhatsappMediaMessage(dependencies, { messageId }).catch((error) => {
        logWhatsappWebhook('whatsapp_media_extraction_failed', {
          error: error instanceof Error ? error.message : String(error),
          messageId,
        })
      })
    }
  }

  return downloadResult
}

const processDownloadedWhatsappExcelMessage = async (
  dependencies,
  {
    messageId,
  } = {},
) => {
  logWhatsappWebhook('whatsapp_excel_processing_started', { messageId })

  const processingResult = await processDownloadedWhatsAppExcel({
    env: process.env,
    messageId,
    pool: dependencies.pool,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeExcelProcessingLogDetails(processingResult)

  if (processingResult.skipped) {
    logWhatsappWebhook('whatsapp_excel_processing_skipped_existing', safeDetails)
  } else if (processingResult.status === MEDIA_EXCEL_STATUSES.EXCEL_PARSED) {
    logWhatsappWebhook('whatsapp_excel_processing_completed', safeDetails)
  } else if (processingResult.status === MEDIA_EXCEL_STATUSES.EXCEL_PARTIAL) {
    logWhatsappWebhook('whatsapp_excel_processing_partial', safeDetails)
  } else if (processingResult.status === MEDIA_EXCEL_STATUSES.EXCEL_AMBIGUOUS) {
    logWhatsappWebhook('whatsapp_excel_processing_ambiguous', safeDetails)
  } else if (processingResult.status === MEDIA_EXCEL_STATUSES.EXCEL_NO_ORDER_LINES) {
    logWhatsappWebhook('whatsapp_excel_processing_no_lines', safeDetails)
  } else if (processingResult.status === MEDIA_EXCEL_STATUSES.EXCEL_UNSUPPORTED) {
    logWhatsappWebhook('whatsapp_excel_processing_unsupported', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_excel_processing_failed', safeDetails)
  }

  return processingResult
}

const processDownloadedWhatsappWordMessage = async (
  dependencies,
  {
    messageId,
  } = {},
) => {
  logWhatsappWebhook('whatsapp_word_processing_started', { messageId })

  const processingResult = await processDownloadedWhatsAppWord({
    env: process.env,
    messageId,
    pool: dependencies.pool,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeWordProcessingLogDetails(processingResult)

  if (processingResult.skipped) {
    logWhatsappWebhook('whatsapp_word_processing_skipped_existing', safeDetails)
  } else if (processingResult.status === MEDIA_WORD_STATUSES.WORD_PARSED) {
    logWhatsappWebhook('whatsapp_word_processing_completed', safeDetails)
  } else if (processingResult.status === MEDIA_WORD_STATUSES.WORD_PARTIAL) {
    logWhatsappWebhook('whatsapp_word_processing_partial', safeDetails)
  } else if (processingResult.status === MEDIA_WORD_STATUSES.WORD_AMBIGUOUS) {
    logWhatsappWebhook('whatsapp_word_processing_ambiguous', safeDetails)
  } else if (processingResult.status === MEDIA_WORD_STATUSES.WORD_NO_ORDER_LINES) {
    logWhatsappWebhook('whatsapp_word_processing_no_lines', safeDetails)
  } else if (processingResult.status === MEDIA_WORD_STATUSES.WORD_UNSUPPORTED) {
    logWhatsappWebhook('whatsapp_word_processing_unsupported', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_word_processing_failed', safeDetails)
  }

  return processingResult
}

const extractDownloadedWhatsappMediaMessage = async (
  dependencies,
  {
    messageId,
  } = {},
) => {
  logWhatsappWebhook('whatsapp_media_extraction_started', {
    messageId,
  })

  const extractionResult = await extractDownloadedWhatsAppMediaText({
    env: process.env,
    messageId,
    pool: dependencies.pool,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeMediaExtractionLogDetails(extractionResult)

  if (extractionResult.skipped) {
    logWhatsappWebhook('whatsapp_media_extraction_skipped_existing', safeDetails)
  } else if (extractionResult.status === MEDIA_EXTRACTION_STATUSES.EXTRACTED) {
    logWhatsappWebhook('whatsapp_media_extraction_completed', safeDetails)
  } else if (extractionResult.status === MEDIA_EXTRACTION_STATUSES.EXTRACTION_NOT_SUPPORTED) {
    logWhatsappWebhook('whatsapp_media_extraction_not_supported', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_media_extraction_failed', safeDetails)
  }

  if (extractionResult.status === MEDIA_EXTRACTION_STATUSES.EXTRACTED) {
    await parseExtractedWhatsappMediaOrderCandidate(dependencies, { messageId }).catch((error) => {
      logWhatsappWebhook('whatsapp_media_order_parse_failed', {
        error: error instanceof Error ? error.message : String(error),
        messageId,
      })
    })
  }

  return extractionResult
}

const parseExtractedWhatsappMediaOrderCandidate = async (
  dependencies,
  {
    messageId,
  } = {},
) => {
  logWhatsappWebhook('whatsapp_media_order_parse_started', { messageId })

  const parseResult = await parseExtractedWhatsAppMediaOrderCandidate({
    messageId,
    pool: dependencies.pool,
    tableName: WHATSAPP_MESSAGE_TABLE_NAME,
  })
  const safeDetails = getSafeMediaOrderParseLogDetails(parseResult)

  if (parseResult.skipped) {
    logWhatsappWebhook('whatsapp_media_order_parse_skipped', safeDetails)
  } else if (parseResult.status === MEDIA_ORDER_PARSE_STATUSES.PARSED) {
    logWhatsappWebhook('whatsapp_media_order_parse_completed', safeDetails)
  } else if (parseResult.status === MEDIA_ORDER_PARSE_STATUSES.PARSE_PARTIAL) {
    logWhatsappWebhook('whatsapp_media_order_parse_partial', safeDetails)
  } else if (parseResult.status === MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES) {
    logWhatsappWebhook('whatsapp_media_order_parse_no_lines', safeDetails)
  } else {
    logWhatsappWebhook('whatsapp_media_order_parse_failed', safeDetails)
  }

  return parseResult
}

const scheduleWhatsappMediaDownload = (
  dependencies,
  {
    messageId,
  } = {},
) => {
  setImmediate(() => {
    downloadCapturedWhatsappMediaMessage(dependencies, { messageId }).catch((error) => {
      logWhatsappWebhook('whatsapp_media_download_failed', {
        error: error instanceof Error ? error.message : String(error),
        messageId,
      })
    })
  })
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
    fileName: metadata.filename ?? '',
    mimeType: mediaResponse.headers.get('content-type') || metadata.mime_type || 'image/jpeg',
  }
}

const downloadAndStoreWhatsappMedia = async (messageSource, message) => {
  if (!messageSource.mediaId) {
    return null
  }

  const downloaded = await downloadWhatsappMedia(messageSource.mediaId)
  const mimeType = messageSource.mediaType || downloaded.mimeType
  const extension = getMediaExtension({
    fileName: messageSource.fileName || downloaded.fileName,
    messageType: message.type,
    mimeType,
  })

  if (!SUPPORTED_MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported WhatsApp media type: ${mimeType || extension || message.type}`)
  }

  const baseName = toSafeFilePart(
    path.basename(messageSource.fileName || downloaded.fileName || messageSource.messageId),
    toSafeFilePart(messageSource.messageId, 'whatsapp-media'),
  )
  const fileName = baseName.toLowerCase().endsWith(`.${extension}`)
    ? baseName
    : `${baseName}.${extension}`
  const relativePath = getUploadRelativePath(fileName)
  const absolutePath = path.join(WHATSAPP_UPLOAD_ROOT, relativePath)

  if (!absolutePath.toLowerCase().startsWith(WHATSAPP_UPLOAD_ROOT.toLowerCase())) {
    throw new Error('Invalid WhatsApp media storage path.')
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, downloaded.buffer)

  return {
    absolutePath,
    buffer: downloaded.buffer,
    extension,
    mediaPath: path.join('uploads/whatsapp', relativePath).replace(/\\/g, '/'),
    mimeType,
  }
}

const resolveStoredWhatsappMediaPath = (mediaPath) => {
  const storedPath = toText(mediaPath)

  if (!storedPath) {
    return ''
  }

  const relativePath = storedPath
    .replace(/^uploads[\\/]+whatsapp[\\/]*/i, '')
    .replace(/^[/\\]+/, '')
  const absolutePath = path.resolve(WHATSAPP_UPLOAD_ROOT, relativePath)

  if (!absolutePath.toLowerCase().startsWith(WHATSAPP_UPLOAD_ROOT.toLowerCase())) {
    throw new Error('Invalid WhatsApp media storage path.')
  }

  return absolutePath
}

const readStoredWhatsappMedia = async (messageRow) => {
  const absolutePath = resolveStoredWhatsappMediaPath(messageRow?.mediaPath)

  if (!absolutePath) {
    return null
  }

  try {
    const buffer = await fs.readFile(absolutePath)
    const extension = getExtensionFromName(absolutePath)

    return {
      absolutePath,
      buffer,
      extension,
      mediaPath: messageRow.mediaPath,
      mimeType: messageRow.mediaType || (IMAGE_EXTENSIONS.has(extension)
        ? `image/${extension === 'jpg' ? 'jpeg' : extension}`
        : ''),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

const extractTextFromImage = async (buffer, mimeType) => {
  const extractorUrl =
    process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_URL || process.env.PI_IMAGE_EXTRACTOR_URL
  const preprocessedBuffer = await preprocessImageForOCR(buffer)

  if (!extractorUrl) {
    return runLocalImageOCR(preprocessedBuffer)
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
      imageBase64: preprocessedBuffer.toString('base64'),
      mimeType: 'image/png',
      originalMimeType: mimeType,
    }),
  })
  const payload = await response.json()

  if (!response.ok || !payload.text) {
    throw new Error(`Image extractor failed: ${JSON.stringify(payload)}`)
  }

  return payload.text
}

const preprocessImageForOCR = async (buffer) => {
  const sharpModule = await import('sharp')
  const sharp = sharpModule.default
  const metadata = await sharp(buffer, { failOn: 'none' }).metadata()
  const width = Number(metadata.width ?? 0)
  let pipeline = sharp(buffer, { failOn: 'none' })
    .rotate()
    .grayscale()
    .normalise()
    .median(1)
    .sharpen()

  if (width > 0 && width < 1600) {
    pipeline = pipeline.resize({ width: 1600, withoutEnlargement: false })
  } else if (width > 2600) {
    pipeline = pipeline.resize({ width: 2600, withoutEnlargement: true })
  }

  return pipeline.png().toBuffer()
}

const runLocalImageOCR = async (buffer) => {
  const tesseract = await import('tesseract.js')
  const workerOptions = {}

  if (process.env.TESSERACT_LANG_PATH) {
    workerOptions.langPath = process.env.TESSERACT_LANG_PATH
  }

  if (process.env.TESSERACT_CACHE_PATH) {
    workerOptions.cachePath = process.env.TESSERACT_CACHE_PATH
  }

  const worker = await tesseract.createWorker(
    process.env.WHATSAPP_OCR_LANG || 'eng',
    1,
    workerOptions,
  )

  try {
    await worker.setParameters({
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: tesseract.PSM.AUTO,
    })
    const result = await worker.recognize(buffer)

    return normalizeText(result?.data?.text ?? '')
  } finally {
    await worker.terminate()
  }
}

const tryExtractImageText = async (buffer, mimeType) => {
  const extractorUrl =
    process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_URL || process.env.PI_IMAGE_EXTRACTOR_URL

  return {
    text: await extractTextFromImage(buffer, mimeType),
    warnings: extractorUrl ? [] : ['Local OCR was used for image text extraction.'],
  }
}

const extractTextFromPDF = async (buffer) => {
  const pdfModule = await import('pdf-parse')
  const parser = new pdfModule.PDFParse({ data: buffer })
  const result = await parser.getText()
  await parser.destroy?.()
  const text = normalizeText(result?.text ?? '')

  return {
    text,
    warnings: text
      ? []
      : ['No embedded PDF text was found. Scanned PDF OCR is required.'],
  }
}

const extractTextFromSpreadsheet = async (buffer) => {
  const excelModule = await import('read-excel-file/node')
  const readExcelFile = excelModule.default
  const sheets = await readExcelFile(buffer)
  const parts = []

  for (const sheet of sheets) {
    const rows = (sheet.data ?? [])
      .map((row) =>
        row
          .map((value) => {
            if (value === null || value === undefined) {
              return ''
            }

            if (value instanceof Date) {
              return value.toISOString().slice(0, 10)
            }

            return String(value)
          })
          .filter(Boolean)
          .join(','),
      )
      .filter((line) => line.trim())

    if (rows.length > 0) {
      parts.push(`Sheet: ${sheet.sheet}\n${rows.join('\n')}`)
    }
  }

  return {
    text: normalizeText(parts.join('\n\n')),
    warnings: parts.length === 0 ? ['No worksheet text was found.'] : [],
  }
}

const extractTextFromWord = async (buffer, extension) => {
  if (extension === 'doc') {
    return {
      text: '',
      warnings: ['Legacy .doc extraction is not available. Please send .docx or plain text.'],
    }
  }

  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })

  return {
    text: normalizeText(result.value ?? ''),
    warnings: (result.messages ?? []).map((message) => message.message).filter(Boolean),
  }
}

const extractTextFromStoredMedia = async ({ buffer, extension, mimeType }) => {
  if (extension === 'jpg' || extension === 'jpeg' || extension === 'png') {
    return tryExtractImageText(buffer, mimeType)
  }

  if (extension === 'pdf') {
    return extractTextFromPDF(buffer)
  }

  if (extension === 'xlsx') {
    return extractTextFromSpreadsheet(buffer)
  }

  if (extension === 'xls') {
    return {
      text: '',
      warnings: ['Legacy .xls extraction is not available. Please send .xlsx or .csv.'],
    }
  }

  if (extension === 'docx' || extension === 'doc') {
    return extractTextFromWord(buffer, extension)
  }

  if (extension === 'csv') {
    return {
      text: normalizeText(buffer.toString('utf8')),
      warnings: [],
    }
  }

  return {
    text: '',
    warnings: [`Unsupported file extension for extraction: ${extension || 'unknown'}.`],
  }
}

const prepareWhatsappMessageContent = async (
  dependencies,
  messageSource,
  message,
  initialText,
  { existingMessage = null } = {},
) => {
  const captionText = normalizeText(initialText)
  let processingText = captionText
  let mediaPath = null
  let ocrText = ''
  const warnings = []

  if (!messageSource.mediaId) {
    return {
      mediaPath,
      ocrText,
      processingText,
      warnings,
    }
  }

  await updateIncomingWhatsappMessageProcessing(dependencies, {
    messageId: messageSource.messageId,
    parseStatus: 'RECEIVED',
    processingStatus: 'MEDIA_DOWNLOADING',
  })

  const storedMedia =
    (await readStoredWhatsappMedia(existingMessage)) ||
    (await downloadAndStoreWhatsappMedia(messageSource, message))
  mediaPath = storedMedia.mediaPath
  await updateIncomingWhatsappMessageProcessing(dependencies, {
    mediaPath,
    messageId: messageSource.messageId,
    parseStatus: 'RECEIVED',
    processingStatus: 'MEDIA_DOWNLOADED',
  })
  logWhatsappWebhook('whatsapp_media_downloaded', {
    mediaId: messageSource.mediaId,
    mediaPath,
    messageId: messageSource.messageId,
    messageType: message.type,
  })

  const isImage = IMAGE_EXTENSIONS.has(storedMedia.extension)
  await updateIncomingWhatsappMessageProcessing(dependencies, {
    mediaPath,
    messageId: messageSource.messageId,
    parseStatus: 'RECEIVED',
    processingStatus: isImage ? 'OCR_PROCESSING' : 'MEDIA_DOWNLOADED',
  })

  const extraction = await extractTextFromStoredMedia(storedMedia)
  ocrText = extraction.text
  warnings.push(...(extraction.warnings ?? []))
  processingText = isImage
    ? normalizeText(ocrText)
    : [captionText, ocrText].filter((part) => normalizeText(part)).join('\n')

  if (!normalizeText(processingText)) {
    const errorMessage = isImage
      ? UNREADABLE_IMAGE_MESSAGE
      : 'No readable text could be extracted from the WhatsApp media.'

    await updateIncomingWhatsappMessageProcessing(dependencies, {
      errorDetails: { errors: [errorMessage] },
      importResult: {
        errors: [errorMessage],
        inserted: false,
        warnings,
      },
      mediaPath,
      messageId: messageSource.messageId,
      ocrText,
      parseErrors: [errorMessage],
      parseStatus: 'MANUAL_REVIEW',
      parseWarnings: warnings,
      processingStatus: 'MANUAL_REVIEW',
      processingText,
    })

    throw new ManualReviewProcessingError(errorMessage)
  }

  await updateIncomingWhatsappMessageProcessing(dependencies, {
    mediaPath,
    messageId: messageSource.messageId,
    messageText: processingText,
    ocrText,
    parseStatus: 'RECEIVED',
    parseWarnings: warnings,
    processingStatus: 'TEXT_EXTRACTED',
    processingText,
  })
  logWhatsappWebhook('whatsapp_content_extracted', {
    mediaId: messageSource.mediaId,
    mediaPath,
    messageId: messageSource.messageId,
    messageType: message.type,
    ocrCharacterCount: ocrText.length,
    processingTextCharacterCount: processingText.length,
  })

  return {
    mediaPath,
    ocrText,
    processingText,
    warnings,
  }
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

  if (built.errors.length > 0 || built.payload.lineItems.length === 0) {
    const errorCode =
      built.errorCode ||
      (built.payload.lineItems.length === 0
        ? 'PRODUCT_NOT_FOUND'
        : 'COMMERCIAL_DATA_PENDING')

    return {
      companySelection: built.companySelection,
      customerDiscount: built.customerDiscount,
      errorCode,
      inserted: false,
      parsed: built.parsed,
      productCandidates: built.productCandidates,
      rateLookups: built.rateLookups,
      taxCalculation: built.taxCalculation,
      warnings: built.warnings,
      errors: built.errors.length > 0
        ? built.errors
        : ['No product rows could be matched to product master.'],
    }
  }

  const saveResult = await dependencies.saveRMarketPIRecord(built.payload)

  return {
    companySelection: built.companySelection,
    inserted: true,
    parsed: built.parsed,
    payload: built.payload,
    pi: saveResult.savedPI,
    productCandidates: built.productCandidates,
    rateLookups: built.rateLookups,
    statusCode: saveResult.statusCode,
    taxCalculation: built.taxCalculation,
    warnings: built.warnings,
  }
}

const processSavedWhatsappMessage = async (
  dependencies,
  {
    existingMessage = null,
    initialText = '',
    message,
    messageSource,
  },
) => {
  if (isWhatsappMediaMessage(message)) {
    const mediaCapture = await captureSavedWhatsappMediaMessage(dependencies, {
      contact: messageSource?.rawPayload?.contact ?? existingMessage?.rawPayload?.contact ?? null,
      message,
      messageSource,
      savedMessage: { row: existingMessage },
    })

    return mediaCapture.webhookResult
  }

  let processingText = normalizeText(initialText)
  const mediaWarnings = []

  try {
    if (!['text', 'image', 'document'].includes(message.type)) {
      throw new ManualReviewProcessingError(
        `Unsupported WhatsApp message type: ${message.type}`,
        { parseStatus: 'FAILED', processingStatus: 'FAILED' },
      )
    }

    const preparedContent = await prepareWhatsappMessageContent(
      dependencies,
      messageSource,
      message,
      processingText,
      { existingMessage },
    )
    processingText = preparedContent.processingText
    mediaWarnings.push(...preparedContent.warnings)
  } catch (error) {
    const isManualReviewError = error instanceof ManualReviewProcessingError
    const errors = [
      error instanceof Error
        ? error.message
        : 'Unable to read WhatsApp message text.',
    ]
    const parseStatus = isManualReviewError ? error.parseStatus : 'FAILED'
    const processingStatus = isManualReviewError ? error.processingStatus : 'FAILED'

    await updateIncomingWhatsappMessageProcessing(dependencies, {
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parseErrors: errors,
      parseStatus,
      parseWarnings: mediaWarnings,
      processingStatus,
      processingText,
    })
    logWhatsappWebhook('whatsapp_processing_failed_before_parse', {
      mediaId: messageSource.mediaId,
      messageId: messageSource.messageId,
      messageType: message.type,
      processingStatus,
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus,
      saved: true,
      warnings: mediaWarnings,
    })
  }

  const commandResult = await processCustomerCommandForIncomingMessage(dependencies, {
    incomingMessage: existingMessage || {
      messageId: messageSource.messageId,
      senderPhone: messageSource.senderPhone,
    },
    messageText: processingText,
    senderPhone: messageSource.senderPhone,
  })

  if (commandResult.handled) {
    const confirmationResult = commandResult.confirmationResult

    logWhatsappWebhook('whatsapp_customer_confirmation_reply', {
      messageId: messageSource.messageId,
      piNumber: confirmationResult.piNumber,
      status: confirmationResult.status,
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: commandResult.parseStatus,
      saved: true,
      warnings: [...mediaWarnings, ...commandResult.warnings],
    })
  }

  if (!normalizeText(processingText)) {
    const errors = ['No usable text was available for WhatsApp parsing.']

    await updateIncomingWhatsappMessageProcessing(dependencies, {
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parseErrors: errors,
      parseStatus: 'MANUAL_REVIEW',
      parseWarnings: mediaWarnings,
      processingStatus: 'MANUAL_REVIEW',
      processingText,
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'MANUAL_REVIEW',
      saved: true,
      warnings: mediaWarnings,
    })
  }

  await updateIncomingWhatsappMessageProcessing(dependencies, {
    messageId: messageSource.messageId,
    messageText: processingText,
    parseStatus: 'RECEIVED',
    parseWarnings: mediaWarnings,
    processingStatus: 'PARSING',
    processingText,
  })

  let parsed

  try {
    parsed = understandWhatsappMessage(processingText, {
      ...messageSource,
    })
  } catch (error) {
    const errors = [
      error instanceof Error
        ? error.message
        : 'Unable to parse WhatsApp message.',
    ]
    await updateIncomingWhatsappMessageProcessing(dependencies, {
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parseErrors: errors,
      parseStatus: 'PARSE_FAILED',
      parseWarnings: mediaWarnings,
      processingStatus: 'MANUAL_REVIEW',
      processingText,
    })
    logWhatsappWebhook('whatsapp_parsing_failed', {
      messageId: messageSource.messageId,
      parseStatus: 'PARSE_FAILED',
      processingTextCharacterCount: processingText.length,
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'PARSE_FAILED',
      saved: true,
      warnings: mediaWarnings,
    })
  }

  const parseErrors = getParsedPIValidationErrors(parsed)

  if (parseErrors.length > 0) {
    await updateIncomingWhatsappMessageProcessing(dependencies, {
      confidenceScore: parsed.confidenceScore,
      errorDetails: { errors: parseErrors },
      importResult: {
        errors: parseErrors,
        inserted: false,
        parsed,
        warnings: [...mediaWarnings, ...parsed.warnings],
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parsedPayload: parsed,
      parseErrors,
      parseStatus: 'PARSE_FAILED',
      parseWarnings: [...mediaWarnings, ...parsed.warnings],
      processingStatus: 'MANUAL_REVIEW',
      processingText,
      productCount: parsed.items.length,
    })
    logWhatsappWebhook('whatsapp_parsing_failed', {
      detectedProductRows: parsed.items.length,
      messageId: messageSource.messageId,
      parseStatus: 'PARSE_FAILED',
      processingTextCharacterCount: processingText.length,
    })

    return createWebhookResult({
      errors: parseErrors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'PARSE_FAILED',
      saved: true,
      warnings: [...mediaWarnings, ...parsed.warnings],
    })
  }

  const customerMatch = await matchCustomerForParsedMessage(dependencies, parsed)

  if (!customerMatch.customer) {
    const errors = ['Customer could not be matched to master_customer.']
    await updateIncomingWhatsappMessageProcessing(dependencies, {
      confidenceScore: parsed.confidenceScore,
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
        parsed,
        warnings: [...mediaWarnings, ...parsed.warnings],
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parsedPayload: parsed,
      parseErrors: errors,
      parseStatus: 'CUSTOMER_NOT_FOUND',
      parseWarnings: [...mediaWarnings, ...parsed.warnings],
      processingStatus: 'CUSTOMER_NOT_FOUND',
      processingText,
      productCount: parsed.items.length,
    })
    logWhatsappWebhook('whatsapp_customer_not_found', {
      detectedProductRows: parsed.items.length,
      messageId: messageSource.messageId,
      parseStatus: 'CUSTOMER_NOT_FOUND',
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'CUSTOMER_NOT_FOUND',
      saved: true,
      warnings: [...mediaWarnings, ...parsed.warnings],
    })
  }

  if (parsed.confidenceScore < 90) {
    const errors = [
      `Message confidence ${parsed.confidenceScore}% is below the 90% auto-PI threshold.`,
    ]
    await updateIncomingWhatsappMessageProcessing(dependencies, {
      confidenceScore: parsed.confidenceScore,
      customerId: customerMatch.customer.customer_id,
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
        parsed,
        warnings: [...mediaWarnings, ...parsed.warnings],
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parsedPayload: parsed,
      parseErrors: errors,
      parseStatus: 'MANUAL_REVIEW',
      parseWarnings: [...mediaWarnings, ...parsed.warnings],
      processingStatus: 'MANUAL_REVIEW',
      processingText,
      productCount: parsed.items.length,
    })
    logWhatsappWebhook('whatsapp_manual_review_required', {
      confidenceScore: parsed.confidenceScore,
      detectedProductRows: parsed.items.length,
      messageId: messageSource.messageId,
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'MANUAL_REVIEW',
      saved: true,
      warnings: [...mediaWarnings, ...parsed.warnings],
    })
  }

  await updateIncomingWhatsappMessageProcessing(dependencies, {
    confidenceScore: parsed.confidenceScore,
    customerId: customerMatch.customer.customer_id,
    importResult: {
      inserted: false,
      parsed,
      warnings: [...mediaWarnings, ...parsed.warnings],
    },
    messageId: messageSource.messageId,
    messageText: processingText,
    parsedPayload: parsed,
    parseStatus: 'PARSED',
    parseWarnings: [...mediaWarnings, ...parsed.warnings],
    processingStatus: 'PARSED',
    processingText,
    productCount: parsed.items.length,
  })
  logWhatsappWebhook('whatsapp_parsing_succeeded', {
    detectedProductRows: parsed.items.length,
    messageId: messageSource.messageId,
    parseStatus: 'PARSED',
    processingTextCharacterCount: processingText.length,
  })

  try {
    const importResult = await importParsedPI(parsed, dependencies)
    const importErrors = normalizeJSONList(importResult.errors)
    const parseStatus = importResult.inserted
      ? 'DRAFT_PI_CREATED'
      : importResult.duplicate
        ? 'DUPLICATE'
        : importResult.errorCode === 'PRODUCT_NOT_FOUND'
          ? 'PRODUCT_NOT_FOUND'
          : importResult.errorCode === 'MULTI_COMPANY_ORDER'
            ? 'MULTI_COMPANY_ORDER'
            : (
                importResult.errorCode === 'COMMERCIAL_DATA_PENDING' ||
                importResult.errorCode === 'DISCOUNT_NOT_FOUND' ||
                importResult.errorCode === 'MAPPING_NOT_FOUND'
              )
              ? 'COMMERCIAL_DATA_PENDING'
              : 'FAILED'
    const piCreated = Boolean(importResult.inserted)
    const draftPiNo =
      importResult.pi?.piNumber ??
      importResult.payload?.piNumber ??
      ''

    await updateIncomingWhatsappMessageProcessing(dependencies, {
      confidenceScore: parsed.confidenceScore,
      customerId: customerMatch.customer.customer_id,
      draftPiNo: piCreated ? draftPiNo : null,
      errorDetails: importErrors.length > 0 ? { errors: importErrors } : null,
      importResult,
      messageId: messageSource.messageId,
      messageText: processingText,
      parsedPayload: importResult.parsed ?? parsed,
      parseErrors: importErrors,
      parseStatus,
      parseWarnings: [...mediaWarnings, ...(importResult.warnings ?? [])],
      piCreated,
      processingStatus: piCreated ? 'DRAFT_PI_CREATED' : parseStatus,
      processingText,
      productCount: parsed.items.length,
      replyStatus: piCreated ? 'WAITING_CONFIRMATION' : 'NOT_SENT',
    })

    if (piCreated) {
      logWhatsAppOutgoingTrace('Draft PI created', {
        currentFile: 'backend/whatsappPi.js',
        currentFunction: 'processSavedWhatsappMessage',
        destinationPhone: messageSource.senderPhone,
        messageId: messageSource.messageId,
        messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
        piNumber: draftPiNo,
        senderPhone: messageSource.senderPhone,
      })
      logWhatsappWebhook('Draft PI created', {
        draftPiNo,
        messageId: messageSource.messageId,
      })
    }

    logWhatsappWebhook(piCreated ? 'whatsapp_draft_pi_created' : 'whatsapp_pi_creation_failed', {
      finalProcessingStatus: piCreated ? 'DRAFT_PI_CREATED' : parseStatus,
      matchedProductRows: importResult.payload?.lineItems?.length ?? 0,
      messageId: messageSource.messageId,
      parseStatus,
    })

    return createWebhookResult({
      duplicate: Boolean(importResult.duplicate),
      errors: importErrors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus,
      piCreated,
      saved: true,
      warnings: [...mediaWarnings, ...(importResult.warnings ?? [])],
    })
  } catch (error) {
    const errors = [
      error instanceof Error
        ? error.message
        : 'Unable to create PI from WhatsApp message.',
    ]
    await updateIncomingWhatsappMessageProcessing(dependencies, {
      confidenceScore: parsed.confidenceScore,
      customerId: customerMatch.customer.customer_id,
      errorDetails: { errors },
      importResult: {
        errors,
        inserted: false,
        parsed,
      },
      messageId: messageSource.messageId,
      messageText: processingText,
      parsedPayload: parsed,
      parseErrors: errors,
      parseStatus: 'FAILED',
      parseWarnings: [...mediaWarnings, ...parsed.warnings],
      processingStatus: 'FAILED',
      processingText,
      productCount: parsed.items.length,
    })
    logWhatsappWebhook('whatsapp_pi_creation_failed', {
      finalProcessingStatus: 'FAILED',
      messageId: messageSource.messageId,
      parseStatus: 'FAILED',
    })

    return createWebhookResult({
      errors,
      inserted: true,
      messageId: messageSource.messageId,
      parseStatus: 'FAILED',
      saved: true,
      warnings: [...mediaWarnings, ...parsed.warnings],
    })
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
      orderUnderstandingProvider: 'rule-based',
      supportedMediaExtensions: Array.from(SUPPORTED_MEDIA_EXTENSIONS).sort(),
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

  router.get('/send-monitor/summary', async (_request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await getWhatsAppSendMonitorSummary({ pool: dependencies.pool })),
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/send-monitor/logs', async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await getWhatsAppSendLogs({
          filters: {
            attemptStatus: request.query.attemptStatus,
            destinationPhone: request.query.destinationPhone,
            endDate: request.query.endDate,
            failureCategory: request.query.failureCategory,
            messagePurpose: request.query.messagePurpose,
            metaMessageId: request.query.metaMessageId,
            piNumber: request.query.piNumber,
            retryable: request.query.retryable,
            sourceWhatsappMessageId: request.query.sourceMessageId,
            startDate: request.query.startDate,
          },
          limit: request.query.limit,
          pool: dependencies.pool,
        })),
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/send-monitor/:sendLogId/retry-now', async (request, response, next) => {
    try {
      if (request.body?.confirm !== true) {
        response.status(400).json({
          message: 'Manual retry requires confirm: true.',
          ok: false,
        })
        return
      }

      const created = await createManualRetryFromLog({
        pool: dependencies.pool,
        sendLogId: request.params.sendLogId,
      })

      if (!created.success) {
        response.status(created.statusCode ?? 422).json({
          message: created.message,
          ok: false,
        })
        return
      }

      const processed = await processDueWhatsAppRetries({
        fetchImpl: dependencies.fetch,
        limit: 3,
        pool: dependencies.pool,
        tableNames: dependencies.tableNames,
      })

      response.json({
        ok: true,
        processed,
        retryLogId: created.retryLogId,
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/send-monitor/:sendLogId/cancel', async (request, response, next) => {
    try {
      const log = await cancelScheduledRetry({
        pool: dependencies.pool,
        sendLogId: request.params.sendLogId,
      })

      if (!log) {
        response.status(422).json({
          message: 'Only RETRY_SCHEDULED sends can be cancelled.',
          ok: false,
        })
        return
      }

      response.json({
        log,
        ok: true,
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/send-monitor/:sendLogId/manual-review', async (request, response, next) => {
    try {
      const log = await markSendForManualReview({
        pool: dependencies.pool,
        sendLogId: request.params.sendLogId,
      })

      if (!log) {
        response.status(422).json({
          message: 'SENT messages cannot be marked for manual review.',
          ok: false,
        })
        return
      }

      response.json({
        log,
        ok: true,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/messages/:messageId/timeline', async (request, response, next) => {
    try {
      response.json({
        ok: true,
        ...(await getWhatsAppSourceTimeline({
          messageId: request.params.messageId,
          pool: dependencies.pool,
        })),
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
      const queuedProcessing = []
      logWhatsAppOutgoingTrace('Incoming request', {
        currentFile: 'backend/whatsappPi.js',
        currentFunction: 'router.post /webhook',
        messageCount: messages.length,
      })
      logWhatsappWebhook('Incoming request', {
        messageCount: messages.length,
        method: request.method,
        path: request.originalUrl ?? request.path,
      })
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
        logWhatsAppOutgoingTrace('Incoming WhatsApp message', {
          currentFile: 'backend/whatsappPi.js',
          currentFunction: 'router.post /webhook',
          destinationPhone: messageSource.senderPhone,
          messageId: messageSource.messageId,
          messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
          messageType: message.type,
          senderPhone: messageSource.senderPhone,
        })
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

          if (isWhatsappMediaMessage(message)) {
            const envelope = extractMediaEnvelope(message, contact)
            console.log(`Duplicate media webhook ignored: ${messageSource.messageId}`)
            logWhatsappWebhook('whatsapp_media_duplicate_ignored', {
              existingCaptureStatus: savedMessage.row?.mediaCaptureStatus ?? '',
              existingProcessingStatus: savedMessage.row?.processingStatus ?? '',
              mediaId: savedMessage.row?.mediaId || envelope.mediaId,
              mediaType: savedMessage.row?.mediaType || envelope.mediaType,
              messageId: messageSource.messageId,
              messageType: message.type,
              senderPhone: messageSource.senderPhone,
            })
            results.push(
              createWebhookResult({
                duplicate: true,
                errors: savedMessage.row?.parseErrors ?? [],
                inserted: false,
                messageId: messageSource.messageId,
                parseStatus:
                  savedMessage.row?.processingStatus ||
                  savedMessage.row?.parseStatus ||
                  'MEDIA_RECEIVED',
                piCreated: Boolean(savedMessage.row?.piCreated),
                saved: true,
                warnings: savedMessage.row?.parseWarnings ?? [],
              }),
            )
            continue
          }

          const duplicateCommand = detectCustomerCommand(getCustomerCommandText(savedMessage.row, text))

          if (duplicateCommand.handled) {
            const commandResult = await processCustomerCommandForIncomingMessage(dependencies, {
              incomingMessage: savedMessage.row,
              messageText: text,
              senderPhone: messageSource.senderPhone,
            })
            results.push(
              createWebhookResult({
                duplicate: true,
                errors: commandResult.errors,
                inserted: false,
                messageId: messageSource.messageId,
                parseStatus: commandResult.parseStatus,
                saved: true,
                warnings: commandResult.warnings,
              }),
            )
            continue
          }

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

        if (isWhatsappMediaMessage(message)) {
          const mediaEnvelope = extractMediaEnvelope(message, contact)
          logWhatsappWebhook('whatsapp_media_received', {
            hasCaption: Boolean(mediaEnvelope.caption),
            mediaId: mediaEnvelope.mediaId,
            mediaType: mediaEnvelope.mediaType,
            messageId: messageSource.messageId,
            messageType: message.type,
            mimeType: mediaEnvelope.mediaMimeType,
            senderPhone: messageSource.senderPhone,
          })
          const mediaCapture = await captureSavedWhatsappMediaMessage(dependencies, {
            contact,
            message,
            messageSource,
            savedMessage,
          })
          scheduleWhatsappMediaDownload(dependencies, {
            messageId: messageSource.messageId,
          })
          results.push(mediaCapture.webhookResult)
          continue
        }

        const savedCommand = detectCustomerCommand(getCustomerCommandText(savedMessage.row, text))

        if (savedCommand.handled) {
          const commandResult = await processCustomerCommandForIncomingMessage(dependencies, {
            incomingMessage: savedMessage.row,
            messageText: text,
            senderPhone: messageSource.senderPhone,
          })
          results.push(
            createWebhookResult({
              errors: commandResult.errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: commandResult.parseStatus,
              saved: true,
              warnings: commandResult.warnings,
            }),
          )
          continue
        }

        if (process.env.WHATSAPP_WEBHOOK_SYNC_PROCESSING !== 'true') {
          queuedProcessing.push({
            existingMessage: savedMessage.row,
            initialText: text,
            message,
            messageSource,
          })
          results.push(
            createWebhookResult({
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'RECEIVED',
              saved: true,
            }),
          )
          continue
        }

        const mediaWarnings = []

        try {
          if (!['text', 'image', 'document'].includes(message.type)) {
            throw new Error(`Unsupported WhatsApp message type: ${message.type}`)
          }

          const preparedContent = await prepareWhatsappMessageContent(
            dependencies,
            messageSource,
            message,
            text,
          )
          text = preparedContent.processingText
          mediaWarnings.push(...preparedContent.warnings)
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
            parseWarnings: mediaWarnings,
            processingStatus: 'MANUAL_REVIEW',
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
              warnings: mediaWarnings,
            }),
          )
          continue
        }

        let parsed

        try {
          parsed = understandWhatsappMessage(text, {
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
            parseWarnings: mediaWarnings,
            processingStatus: 'MANUAL_REVIEW',
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
              warnings: mediaWarnings,
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
              warnings: [...mediaWarnings, ...parsed.warnings],
            },
            confidenceScore: parsed.confidenceScore,
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: parsed,
            parseErrors,
            parseStatus: 'PARSE_FAILED',
            parseWarnings: [...mediaWarnings, ...parsed.warnings],
            processingStatus: 'MANUAL_REVIEW',
            productCount: parsed.items.length,
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
              warnings: [...mediaWarnings, ...parsed.warnings],
            }),
          )
          continue
        }

        const customerMatch = await matchCustomerForParsedMessage(dependencies, parsed)

        if (!customerMatch.customer) {
          const errors = ['Customer could not be matched to master_customer.']
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            confidenceScore: parsed.confidenceScore,
            errorDetails: { errors },
            importResult: {
              errors,
              inserted: false,
              parsed,
              warnings: [...mediaWarnings, ...parsed.warnings],
            },
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: parsed,
            parseErrors: errors,
            parseStatus: 'CUSTOMER_NOT_FOUND',
            parseWarnings: [...mediaWarnings, ...parsed.warnings],
            processingStatus: 'CUSTOMER_NOT_FOUND',
            productCount: parsed.items.length,
          })
          logWhatsappWebhook('whatsapp_customer_not_found', {
            messageId: messageSource.messageId,
            parseStatus: 'CUSTOMER_NOT_FOUND',
          })
          results.push(
            createWebhookResult({
              errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'CUSTOMER_NOT_FOUND',
              saved: true,
              warnings: [...mediaWarnings, ...parsed.warnings],
            }),
          )
          continue
        }

        if (parsed.confidenceScore < 90) {
          const errors = [
            `Message confidence ${parsed.confidenceScore}% is below the 90% auto-PI threshold.`,
          ]
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            confidenceScore: parsed.confidenceScore,
            customerId: customerMatch.customer.customer_id,
            errorDetails: { errors },
            importResult: {
              errors,
              inserted: false,
              parsed,
              warnings: [...mediaWarnings, ...parsed.warnings],
            },
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: parsed,
            parseErrors: errors,
            parseStatus: 'MANUAL_REVIEW',
            parseWarnings: [...mediaWarnings, ...parsed.warnings],
            processingStatus: 'MANUAL_REVIEW',
            productCount: parsed.items.length,
          })
          logWhatsappWebhook('whatsapp_manual_review_required', {
            confidenceScore: parsed.confidenceScore,
            messageId: messageSource.messageId,
          })
          results.push(
            createWebhookResult({
              errors,
              inserted: true,
              messageId: messageSource.messageId,
              parseStatus: 'MANUAL_REVIEW',
              saved: true,
              warnings: [...mediaWarnings, ...parsed.warnings],
            }),
          )
          continue
        }

        await updateIncomingWhatsappMessageProcessing(dependencies, {
          confidenceScore: parsed.confidenceScore,
          customerId: customerMatch.customer.customer_id,
          importResult: {
            inserted: false,
            parsed,
            warnings: [...mediaWarnings, ...parsed.warnings],
          },
          messageId: messageSource.messageId,
          messageText: text,
          parsedPayload: parsed,
          parseStatus: 'PARSED',
          parseWarnings: [...mediaWarnings, ...parsed.warnings],
          processingStatus: 'PARSED',
          productCount: parsed.items.length,
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
              : importResult.errorCode === 'PRODUCT_NOT_FOUND'
                ? 'PRODUCT_NOT_FOUND'
                : importResult.errorCode === 'COMMERCIAL_DATA_PENDING'
                  ? 'COMMERCIAL_DATA_PENDING'
                  : 'PI_FAILED'
          const piCreated = Boolean(importResult.inserted)
          const draftPiNo =
            importResult.pi?.piNumber ??
            importResult.payload?.piNumber ??
            ''

          await updateIncomingWhatsappMessageProcessing(dependencies, {
            confidenceScore: parsed.confidenceScore,
            customerId: customerMatch.customer.customer_id,
            draftPiNo: piCreated ? draftPiNo : null,
            errorDetails: importErrors.length > 0 ? { errors: importErrors } : null,
            importResult,
            messageId: messageSource.messageId,
            messageText: text,
            parsedPayload: importResult.parsed ?? parsed,
            parseErrors: importErrors,
            parseStatus,
            parseWarnings: [...mediaWarnings, ...(importResult.warnings ?? [])],
            piCreated,
            processingStatus: piCreated ? 'PI_CREATED' : 'MANUAL_REVIEW',
            productCount: parsed.items.length,
            replyStatus: piCreated ? 'WAITING_CONFIRMATION' : 'NOT_SENT',
          })

          if (piCreated) {
            logWhatsAppOutgoingTrace('Draft PI created', {
              currentFile: 'backend/whatsappPi.js',
              currentFunction: 'router.post /webhook',
              destinationPhone: messageSource.senderPhone,
              messageId: messageSource.messageId,
              messagePurpose: 'AUTO_ACKNOWLEDGEMENT',
              piNumber: draftPiNo,
              senderPhone: messageSource.senderPhone,
            })
            logWhatsappWebhook('Draft PI created', {
              draftPiNo,
              messageId: messageSource.messageId,
            })
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
              warnings: [...mediaWarnings, ...(importResult.warnings ?? [])],
            }),
          )
        } catch (error) {
          const errors = [
            error instanceof Error
              ? error.message
              : 'Unable to create PI from WhatsApp message.',
          ]
          await updateIncomingWhatsappMessageProcessing(dependencies, {
            confidenceScore: parsed.confidenceScore,
            customerId: customerMatch.customer.customer_id,
            errorDetails: { errors },
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
            parseWarnings: [...mediaWarnings, ...parsed.warnings],
            processingStatus: 'PI_FAILED',
            productCount: parsed.items.length,
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
              warnings: [...mediaWarnings, ...parsed.warnings],
            }),
          )
        }
      }

      for (const queuedMessage of queuedProcessing) {
        setImmediate(() => {
          processSavedWhatsappMessage(dependencies, queuedMessage).catch((error) => {
            logWhatsappWebhook('whatsapp_background_processing_failed', {
              messageId: queuedMessage.messageSource.messageId,
              messageType: queuedMessage.message.type,
              error: error instanceof Error ? error.message : String(error),
            })
          })
        })
      }

      response.json({
        duplicate: results.some((result) => result.duplicate),
        errors: results.flatMap((result) => result.errors),
        inserted: results.some((result) => result.inserted),
        ok: true,
        parse_status: results.length === 1 ? results[0].parse_status : 'MULTIPLE_MESSAGES',
        pi_created: results.some((result) => result.pi_created),
        processing: queuedProcessing.length > 0,
        received: messages.length,
        results,
        saved: results.filter((result) => result.saved).length,
        warnings: results.flatMap((result) => result.warnings),
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/messages/:messageId/reprocess', async (request, response, next) => {
    try {
      const existingMessage = await getIncomingWhatsappMessageByMessageId(
        dependencies,
        request.params.messageId,
      )

      if (!existingMessage) {
        response.status(404).json({ message: 'WhatsApp message not found.' })
        return
      }

      const rawPayload = existingMessage.rawPayload ?? {}
      const messageType = existingMessage.messageType || existingMessage.sourceType || 'text'
      const fallbackMediaPayload = {
        caption: existingMessage.caption,
        filename: existingMessage.fileName,
        id: existingMessage.mediaId,
        mime_type: existingMessage.mediaType,
      }
      const message = rawPayload.message ?? {
        from: existingMessage.senderPhone,
        id: existingMessage.messageId,
        [messageType]: messageType === 'text'
          ? { body: existingMessage.rawText || existingMessage.messageText }
          : fallbackMediaPayload,
        timestamp: String(Math.floor(new Date(existingMessage.receivedAt).getTime() / 1000)),
        type: messageType,
      }
      const contact = rawPayload.contact ?? {
        profile: { name: existingMessage.senderName },
        wa_id: existingMessage.senderPhone,
      }
      const messageSource = {
        ...getWhatsappMessageSource(contact, message),
        caption: existingMessage.caption,
        fileName: existingMessage.fileName,
        mediaId: existingMessage.mediaId,
        mediaType: existingMessage.mediaType,
        messageId: existingMessage.messageId,
        receivedAt: existingMessage.receivedAt,
        senderName: existingMessage.senderName,
        senderPhone: existingMessage.senderPhone,
        sourceType: messageType,
      }
      const initialText =
        getInitialWhatsappMessageText(message) ||
        existingMessage.rawText ||
        existingMessage.messageText ||
        existingMessage.caption ||
        ''

      await recordWhatsappMessageEvent(dependencies, {
        details: { requestedBy: 'api' },
        messageId: existingMessage.messageId,
        parseStatus: existingMessage.parseStatus,
        processingStatus: 'REPROCESS_REQUESTED',
      })

      const result = await processSavedWhatsappMessage(dependencies, {
        existingMessage,
        initialText,
        message,
        messageSource,
      })
      const updatedMessage = await getIncomingWhatsappMessageByMessageId(
        dependencies,
        existingMessage.messageId,
      )

      response.json({
        message: updatedMessage,
        ok: true,
        result,
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

export {
  buildPIPayloadFromParsedMessage,
  findCustomer,
  findProductForItem,
  getCustomerConfirmationProcessingStatus,
  getNextPINumber,
  matchCustomerForParsedMessage,
  normalizeProductMatchText,
  normalizeText,
  processExistingCustomerConfirmationRow,
  understandWhatsappMessage,
}

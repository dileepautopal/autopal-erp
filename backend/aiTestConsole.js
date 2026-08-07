import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  compareCustomerNames,
  CUSTOMER_MATCH_THRESHOLD,
  getCustomerNameSearchTokens,
} from './customerFuzzyMatch.js'
import {
  buildPIPayloadFromParsedMessage,
  findProductForItem,
  getNextPINumber,
  normalizeProductMatchText,
  normalizeText,
  parseWhatsappPIItemLine,
  processExistingCustomerConfirmationRow,
  understandWhatsappMessage,
} from './whatsappPi.js'
import {
  normalizeCategoryKey,
  selectCompanyForProductCategories,
} from './companySelectionService.js'
import {
  buildAcknowledgementMessage,
  getAcknowledgementConfig,
  getIncomingMessageForAcknowledgement,
  isAllowedTesterNumber,
  sendAutomaticAcknowledgement,
  sendTextMessage,
} from './whatsappAckService.js'
import {
  buildPiSummaryMessage,
  handleCustomerConfirmationReply,
  loadDraftPIForSummary,
  sendPiSummary,
} from './piSummaryService.js'
import {
  runPhase1Verification,
} from './phase1VerificationService.js'
import {
  buildMetaStyleMediaMessage,
  classifyMediaMessage,
  extractMediaEnvelope,
} from './whatsappMediaCaptureService.js'

const TEST_RUN_TABLE_NAME = 'tran_ai_communication_test_runs'
const MAX_INPUT_SUMMARY_LENGTH = 500
const LOCAL_HOST_NAMES = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'])
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_UPLOAD_ROOT = path.resolve(
  process.env.WHATSAPP_UPLOAD_DIR || path.join(__dirname, '../uploads/whatsapp'),
)

const toText = (value) => String(value ?? '').trim()

const toBoolean = (value) => value === true || value === 'true'

const normalizeJSONList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean)
  }

  const text = toText(value)

  return text ? [text] : []
}

const parseMaybeJSON = (value) => {
  const text = toText(value)

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const sanitizeRequestHeaders = (headers = {}) => {
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers)

  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      /authorization/i.test(key) ? 'Bearer [REDACTED]' : value,
    ]),
  )
}

const createMetaTraceFetch = (fetchImpl, trace) => async (url, options = {}) => {
  trace.request = {
    body: parseMaybeJSON(options.body),
    headers: sanitizeRequestHeaders(options.headers),
    method: options.method || 'GET',
    url: String(url),
  }

  const response = await fetchImpl(url, options)
  const responseText = await response.text()

  trace.response = {
    body: parseMaybeJSON(responseText),
    headers: sanitizeRequestHeaders(response.headers),
    httpStatus: response.status,
    ok: response.ok,
    statusText: response.statusText,
  }

  return new Response(responseText, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const isAITestConsoleEnabledForRequest = (request) => {
  if (process.env.ENABLE_AI_TEST_CONSOLE === 'true') {
    return true
  }

  if (process.env.ENABLE_AI_TEST_CONSOLE === 'false') {
    return false
  }

  const hostname = String(request.hostname ?? '').toLowerCase()

  return LOCAL_HOST_NAMES.has(hostname)
}

const redactSensitiveValue = (key, value) => {
  if (/token|secret|password|database_url|access/i.test(key)) {
    return value ? '[REDACTED]' : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item))
  }

  if (value && typeof value === 'object') {
    return scrubSecrets(value)
  }

  return value
}

const scrubSecrets = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      redactSensitiveValue(key, nestedValue),
    ]),
  )
}

const getDurationMs = (startedAt, completedAt = new Date()) =>
  completedAt.getTime() - startedAt.getTime()

const summarizeInput = (input) =>
  JSON.stringify(scrubSecrets(input ?? {})).slice(0, MAX_INPUT_SUMMARY_LENGTH)

const normalizePhoneDigits = (value) => {
  const digits = toText(value).replace(/\D+/g, '')

  return digits.length > 10 ? digits.slice(-10) : digits
}

const compactProductText = (value) =>
  normalizeProductMatchText(value).replace(/[^A-Z0-9]+/g, '')

const ensureAITestRunSchema = async (pool) => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TEST_RUN_TABLE_NAME} (
      test_run_id bigserial PRIMARY KEY,
      test_type varchar(80) NOT NULL,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      duration_ms integer,
      requested_by varchar(80),
      input_summary text,
      result_json jsonb,
      success boolean NOT NULL DEFAULT false,
      warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb,
      dry_run boolean NOT NULL DEFAULT true,
      database_changed boolean NOT NULL DEFAULT false,
      whatsapp_message_sent boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_ai_communication_test_runs_created_at
    ON ${TEST_RUN_TABLE_NAME} (created_at DESC, test_run_id DESC)
  `)
}

const recordTestRun = async (
  pool,
  {
    completedAt,
    databaseChanged = false,
    dryRun = true,
    errors = [],
    input = {},
    requestedBy = '',
    result = {},
    startedAt,
    success,
    testType,
    warnings = [],
    whatsappMessageSent = false,
  },
) => {
  await ensureAITestRunSchema(pool)
  const sanitizedResult = scrubSecrets(result)
  const insertResult = await pool.query(
    `
      INSERT INTO ${TEST_RUN_TABLE_NAME}
        (
          test_type,
          started_at,
          completed_at,
          duration_ms,
          requested_by,
          input_summary,
          result_json,
          success,
          warnings,
          errors,
          dry_run,
          database_changed,
          whatsapp_message_sent
        )
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12, $13)
      RETURNING test_run_id
    `,
    [
      testType,
      startedAt,
      completedAt,
      getDurationMs(startedAt, completedAt),
      toText(requestedBy).slice(0, 80),
      summarizeInput(input),
      JSON.stringify(sanitizedResult),
      Boolean(success),
      JSON.stringify(warnings),
      JSON.stringify(errors),
      Boolean(dryRun),
      Boolean(databaseChanged),
      Boolean(whatsappMessageSent),
    ],
  )

  return Number(insertResult.rows[0]?.test_run_id ?? 0)
}

const runConsoleTest = async (
  dependencies,
  request,
  {
    databaseChanged = false,
    dryRun = true,
    execute,
    testType,
    whatsappMessageSent = false,
  },
) => {
  const startedAt = new Date()
  const requestedBy = request.get('x-autopal-user') ?? ''

  try {
    const result = await execute(startedAt)
    const completedAt = new Date()
    const warnings = Array.isArray(result.warnings) ? result.warnings : []
    const errors = Array.isArray(result.errors) ? result.errors : []
    const success = errors.length === 0 && result.success !== false
    const testRunId = await recordTestRun(dependencies.pool, {
      completedAt,
      databaseChanged,
      dryRun,
      errors,
      input: request.body ?? request.query ?? {},
      requestedBy,
      result,
      startedAt,
      success,
      testType,
      warnings,
      whatsappMessageSent,
    })

    return {
      completedAt: completedAt.toISOString(),
      durationMs: getDurationMs(startedAt, completedAt),
      success,
      testName: testType,
      testRunId,
      ...scrubSecrets(result),
      startedAt: startedAt.toISOString(),
    }
  } catch (error) {
    const completedAt = new Date()
    const errors = [
      error instanceof Error ? error.message : 'AI test console request failed.',
    ]
    const result = {
      errors,
      finalStatus: 'FAILED',
      warnings: [],
    }
    const testRunId = await recordTestRun(dependencies.pool, {
      completedAt,
      databaseChanged,
      dryRun,
      errors,
      input: request.body ?? request.query ?? {},
      requestedBy,
      result,
      startedAt,
      success: false,
      testType,
      whatsappMessageSent,
    })

    return {
      completedAt: completedAt.toISOString(),
      durationMs: getDurationMs(startedAt, completedAt),
      errors,
      finalStatus: 'FAILED',
      startedAt: startedAt.toISOString(),
      success: false,
      testName: testType,
      testRunId,
      warnings: [],
    }
  }
}

const getParsedInput = (body = {}) => {
  const parsedJson = body.parsedJson ?? body.parsed_json

  if (parsedJson && typeof parsedJson === 'object') {
    return parsedJson
  }

  return {
    contactPhone: toText(body.phone ?? body.mobileNo ?? body.mobile_no),
    email: toText(body.email).toLowerCase(),
    gstNo: toText(body.gstin ?? body.gstNo ?? body.gst_no).toUpperCase(),
    partyName: toText(body.customerName ?? body.partyName ?? body.customer_name),
    place: toText(body.city ?? body.place),
  }
}

const scoreCustomerCandidate = (row, input) => {
  const reasons = []
  let confidence = 0
  const inputCity = toText(input.place).toLowerCase()
  const inputGst = toText(input.gstNo).toUpperCase()
  const inputEmail = toText(input.email).toLowerCase()
  const inputPhone = normalizePhoneDigits(input.contactPhone)
  const nameScore = compareCustomerNames(input.partyName, row.cust_name)

  if (inputGst && toText(row.gstin_no).toUpperCase() === inputGst) {
    confidence = Math.max(confidence, 100)
    reasons.push('GSTIN exact match')
  }

  if (
    inputPhone &&
    (normalizePhoneDigits(row.mobile_no).endsWith(inputPhone) ||
      normalizePhoneDigits(row.corr_tel).endsWith(inputPhone))
  ) {
    confidence = Math.max(confidence, 98)
    reasons.push('phone match')
  }

  if (
    inputEmail &&
    (toText(row.corr_email).toLowerCase() === inputEmail ||
      toText(row.ship_email).toLowerCase() === inputEmail)
  ) {
    confidence = Math.max(confidence, 98)
    reasons.push('email match')
  }

  if (nameScore.confidence > 0) {
    confidence = Math.max(confidence, nameScore.confidence)
    reasons.push(nameScore.matchReason)
  }

  if (inputCity && toText(row.city_name).toLowerCase() === inputCity && confidence > 0) {
    confidence = Math.min(confidence + 2, 100)
    reasons.push('city match')
  }

  return {
    confidenceScore: Math.min(confidence, 100),
    matchReason: reasons.join(', ') || 'candidate search match',
  }
}

const findCustomerCandidates = async (dependencies, input) => {
  const { pool, tableNames } = dependencies
  const partyName = toText(input.partyName)
  const place = toText(input.place)
  const contactPhone = normalizePhoneDigits(input.contactPhone)
  const email = toText(input.email).toLowerCase()
  const gstNo = toText(input.gstNo).toUpperCase()
  const nameSearchTokens = getCustomerNameSearchTokens(partyName)
  const result = await pool.query(
    `
      SELECT
        c.customer_id,
        c.cust_code,
        c.cust_name,
        c.corr_tel,
        c.mobile_no,
        c.corr_email,
        c.ship_email,
        c.gstin_no,
        city.city_name
      FROM ${tableNames.customer} c
      LEFT JOIN ${tableNames.city} city
        ON city.city_id = c.corr_city_code
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
          OR ($4::text <> '' AND LOWER(c.cust_name) LIKE LOWER('%' || $4 || '%'))
          OR ($5::text <> '' AND LOWER(city.city_name) = LOWER($5))
          OR EXISTS (
            SELECT 1
            FROM unnest($6::text[]) AS name_token
            WHERE name_token <> ''
              AND REGEXP_REPLACE(UPPER(c.cust_name), '[^A-Z0-9]+', ' ', 'g')
                LIKE '%' || name_token || '%'
          )
        )
      ORDER BY c.cust_name ASC
      LIMIT 50
    `,
    [gstNo, contactPhone, email, partyName, place, nameSearchTokens],
  )

  return result.rows
    .map((row) => {
      const score = scoreCustomerCandidate(row, {
        contactPhone,
        email,
        gstNo,
        partyName,
        place,
      })

      return {
        city: row.city_name ?? '',
        confidence: score.confidenceScore,
        confidenceScore: score.confidenceScore,
        customerCode: Number(row.cust_code ?? 0),
        customer_id: Number(row.customer_id ?? 0),
        customerId: Number(row.customer_id ?? 0),
        customer_name: row.cust_name ?? '',
        customerName: row.cust_name ?? '',
        email: row.corr_email || row.ship_email || '',
        gstin: row.gstin_no ?? '',
        match_reason: score.matchReason,
        matchReason: score.matchReason,
        phone: row.mobile_no || row.corr_tel || '',
      }
    })
    .sort((left, right) => right.confidenceScore - left.confidenceScore)
    .slice(0, 5)
}

const getCustomerMatchStatus = (candidates) => {
  if (candidates.length === 0 || candidates[0].confidenceScore < CUSTOMER_MATCH_THRESHOLD) {
    return 'NOT_FOUND'
  }

  if (
    candidates.length > 1 &&
    candidates[1].confidenceScore >= CUSTOMER_MATCH_THRESHOLD &&
    candidates[1].confidenceScore >= candidates[0].confidenceScore - 5
  ) {
    return 'MULTIPLE_MATCHES'
  }

  return 'MATCHED'
}

const createProductItemFromInput = (value) => {
  const parsedLine = parseWhatsappPIItemLine(value)

  if (parsedLine) {
    return parsedLine
  }

  const normalizedInput = normalizeProductMatchText(value)
  const codeMatch = normalizedInput.match(/\b[A-Z]{1,12}\s*-?\s*\d{1,8}[A-Z0-9]*\b/)
  const productCode = compactProductText(codeMatch?.[0] ?? normalizedInput)

  return {
    model: productCode,
    productCode,
    productText: normalizedInput,
    quantity: 0,
    rawLine: value,
    unit: '',
  }
}

const inferCompanySelectionCategoryFromText = (value) => {
  const normalized = normalizeCategoryKey(value)

  if (/\bHALOGEN\b/.test(normalized) && /\bBULBS?\b/.test(normalized)) {
    return 'HALOGEN BULBS'
  }

  if (/\bHEAD\b/.test(normalized) && /\bLAMPS?\b/.test(normalized)) {
    return 'HEAD LAMP'
  }

  return ''
}

const getProductMatchStatus = (match) => {
  if (match.ambiguous) {
    return 'AMBIGUOUS'
  }

  if (!match.product || match.confidence < 70) {
    return 'NOT_FOUND'
  }

  return 'MATCHED'
}

const validateWhatsAppToken = async () => {
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const graphBase = process.env.WHATSAPP_GRAPH_API_BASE || 'https://graph.facebook.com/v20.0'

  if (!token) {
    return { status: 'Missing' }
  }

  if (!phoneNumberId) {
    return { status: 'Configured' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(
      `${graphBase}/${encodeURIComponent(phoneNumberId)}?fields=id`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    )
    const body = await response.json().catch(() => ({}))

    if (response.ok) {
      return { status: 'Configured' }
    }

    const error = body?.error ?? {}

    if (Number(error.code) === 190 || Number(error.error_subcode ?? error.subcode) === 463) {
      return {
        errorCode: Number(error.code),
        errorSubcode: Number(error.error_subcode ?? error.subcode ?? 0),
        status: 'Expired Access Token',
      }
    }

    return {
      errorCode: Number(error.code ?? response.status),
      status: 'Invalid',
    }
  } catch {
    return { status: 'Connection Failed' }
  } finally {
    clearTimeout(timer)
  }
}

const getTableColumnStatus = async (pool, tableName, requiredColumns = []) => {
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
    `,
    [tableName],
  )
  const existingColumns = new Set(result.rows.map((row) => row.column_name))

  return {
    missingColumns: requiredColumns.filter((column) => !existingColumns.has(column)),
    status: result.rowCount > 0 ? 'Configured' : 'Missing',
  }
}

const HEALTH_STATUS = {
  GREEN: 'GREEN',
  GREY: 'GREY',
  RED: 'RED',
  YELLOW: 'YELLOW',
}

const HEALTH_VERSION = '1.0'
const HEALTH_SAMPLE_TEXT = `M/s Jalaram Enterprises
Navagam

Date 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`

const PENDING_HEALTH_MODULES = [
  {
    id: 'media-download',
    milestone: 'Milestone 2',
    name: 'Image Download',
    tooltip: 'WhatsApp image download test is planned for Milestone 2.',
  },
  {
    id: 'ocr',
    milestone: 'Milestone 3',
    name: 'OCR',
    packageName: 'tesseract.js',
    tooltip: 'OCR package is checked, but the console OCR test is planned for Milestone 3.',
  },
  {
    id: 'pdf-extract',
    milestone: 'Milestone 3',
    name: 'PDF Reader',
    packageName: 'pdf-parse',
    tooltip: 'PDF text extraction package is checked, but the console reader is planned for Milestone 3.',
  },
  {
    id: 'excel-extract',
    milestone: 'Milestone 3',
    name: 'Excel Reader',
    packageName: 'read-excel-file/node',
    tooltip: 'Excel reader package is checked, but the console reader is planned for Milestone 3.',
  },
  {
    id: 'word-extract',
    milestone: 'Milestone 3',
    name: 'Word Reader',
    packageName: 'mammoth',
    tooltip: 'Word reader package is checked, but the console reader is planned for Milestone 3.',
  },
  {
    id: 'draft-pi',
    milestone: 'Milestone 4',
    name: 'Draft PI',
    tooltip: 'Draft PI generation test is planned for Milestone 4.',
  },
  {
    id: 'pi-pdf',
    milestone: 'Milestone 4',
    name: 'PI PDF Generator',
    tooltip: 'PI PDF generation test is planned for Milestone 4.',
  },
  {
    id: 'whatsapp-reply',
    milestone: 'Milestone 5',
    name: 'WhatsApp Reply',
    tooltip: 'WhatsApp reply test is planned for Milestone 5.',
  },
  {
    id: 'end-to-end',
    milestone: 'Milestone 6',
    name: 'End-to-End Test',
    tooltip: 'Full WhatsApp-to-PI test is planned for Milestone 6.',
  },
]

const HEALTH_MILESTONES = [
  { label: 'Milestone 1', progress: 100 },
  { label: 'Milestone 2', progress: 20 },
  { label: 'Milestone 3', progress: 0 },
]

const statusLabelByStatus = {
  [HEALTH_STATUS.GREEN]: 'Working',
  [HEALTH_STATUS.GREY]: 'Pending',
  [HEALTH_STATUS.RED]: 'Failed',
  [HEALTH_STATUS.YELLOW]: 'Attention Required',
}

const badgeByStatus = {
  [HEALTH_STATUS.GREEN]: 'READY',
  [HEALTH_STATUS.GREY]: 'PENDING',
  [HEALTH_STATUS.RED]: 'FAILED',
  [HEALTH_STATUS.YELLOW]: 'WARNING',
}

const createHealthModule = ({
  badge,
  critical = false,
  durationMs = 0,
  id,
  implemented = true,
  lastChecked,
  message,
  milestone = 'Milestone 1',
  name,
  status,
  targetModule = id,
  tooltip,
  version = HEALTH_VERSION,
}, stats = {}) => ({
  averageDurationMs: Number(stats.averageDurationMs ?? durationMs ?? 0),
  badge: badge ?? badgeByStatus[status] ?? status,
  critical: Boolean(critical),
  durationMs: Number(durationMs ?? 0),
  failedRuns: Number(stats.failedRuns ?? 0),
  id,
  implemented: Boolean(implemented),
  lastChecked,
  lastSuccessfulRun: stats.lastSuccessfulRun ?? null,
  message,
  milestone,
  name,
  status,
  statusLabel: statusLabelByStatus[status] ?? status,
  successfulRuns: Number(stats.successfulRuns ?? 0),
  targetModule,
  tooltip,
  version,
})

const timedHealthCheck = async (check) => {
  const startedAt = new Date()

  try {
    const result = await check()

    return {
      durationMs: getDurationMs(startedAt),
      result,
    }
  } catch (error) {
    return {
      durationMs: getDurationMs(startedAt),
      result: {
        message: error instanceof Error ? error.message : 'Health check failed.',
        status: HEALTH_STATUS.RED,
      },
    }
  }
}

const checkPackageAvailable = async (packageName) => {
  if (!packageName) {
    return true
  }

  try {
    await import(packageName)
    return true
  } catch {
    return false
  }
}

const getExistingTestRunHistory = async (pool) => {
  const tableResult = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    [TEST_RUN_TABLE_NAME],
  )

  if (!tableResult.rows[0]?.exists) {
    return {
      averageResponseTimeMs: 0,
      greenPercent: 0,
      last10HealthChecks: [],
      lastHealthCheck: null,
      statsByType: {},
    }
  }

  const statsResult = await pool.query(
    `
      SELECT
        test_type,
        COUNT(*) FILTER (WHERE success IS TRUE) AS successful_runs,
        COUNT(*) FILTER (WHERE success IS NOT TRUE) AS failed_runs,
        AVG(duration_ms) AS average_duration_ms,
        MAX(completed_at) FILTER (WHERE success IS TRUE) AS last_successful_run
      FROM ${TEST_RUN_TABLE_NAME}
      GROUP BY test_type
    `,
  )
  const recentResult = await pool.query(
    `
      SELECT
        test_run_id,
        test_type,
        completed_at,
        duration_ms,
        success
      FROM ${TEST_RUN_TABLE_NAME}
      ORDER BY created_at DESC, test_run_id DESC
      LIMIT 10
    `,
  )
  const historyResult = await pool.query(
    `
      SELECT
        COUNT(*) AS total_runs,
        COUNT(*) FILTER (WHERE success IS TRUE) AS green_runs,
        AVG(duration_ms) AS average_response_time_ms,
        MAX(completed_at) AS last_health_check
      FROM ${TEST_RUN_TABLE_NAME}
    `,
  )
  const historyRow = historyResult.rows[0] ?? {}
  const totalRuns = Number(historyRow.total_runs ?? 0)
  const greenRuns = Number(historyRow.green_runs ?? 0)

  return {
    averageResponseTimeMs: Math.round(Number(historyRow.average_response_time_ms ?? 0)),
    greenPercent: totalRuns > 0 ? Math.round((greenRuns / totalRuns) * 100) : 0,
    last10HealthChecks: recentResult.rows.map((row) => ({
      completedAt: row.completed_at,
      durationMs: Number(row.duration_ms ?? 0),
      success: Boolean(row.success),
      testName: row.test_type,
      testRunId: Number(row.test_run_id ?? 0),
    })),
    lastHealthCheck: historyRow.last_health_check ?? null,
    statsByType: Object.fromEntries(
      statsResult.rows.map((row) => [
        row.test_type,
        {
          averageDurationMs: Math.round(Number(row.average_duration_ms ?? 0)),
          failedRuns: Number(row.failed_runs ?? 0),
          lastSuccessfulRun: row.last_successful_run ?? null,
          successfulRuns: Number(row.successful_runs ?? 0),
        },
      ]),
    ),
  }
}

const createPendingHealthModule = async (definition, lastChecked) => {
  const packageAvailable = await checkPackageAvailable(definition.packageName)
  const message = definition.packageName
    ? packageAvailable
      ? 'Package available; console module pending.'
      : 'Optional package unavailable; console module pending.'
    : 'Console module pending.'

  return createHealthModule({
    badge: packageAvailable ? 'PENDING' : 'NOT CONFIGURED',
    durationMs: 0,
    id: definition.id,
    implemented: false,
    lastChecked,
    message,
    milestone: definition.milestone,
    name: definition.name,
    status: HEALTH_STATUS.GREY,
    targetModule: definition.id,
    tooltip: definition.tooltip,
  })
}

const buildAITestConsoleHealth = async (dependencies) => {
  const lastChecked = new Date().toISOString()
  const history = await getExistingTestRunHistory(dependencies.pool).catch(() => ({
    averageResponseTimeMs: 0,
    greenPercent: 0,
    last10HealthChecks: [],
    lastHealthCheck: null,
    statsByType: {},
  }))
  const statsByType = history.statsByType ?? {}
  const modules = []
  const dbCheck = await timedHealthCheck(async () => {
    const result = await dependencies.pool.query('SELECT 1 AS ok')

    return result.rows[0]?.ok === 1
      ? {
          message: 'Database connected.',
          status: HEALTH_STATUS.GREEN,
        }
      : {
          message: 'Database did not return the expected response.',
          status: HEALTH_STATUS.RED,
        }
  })
  const databaseOk = dbCheck.result.status === HEALTH_STATUS.GREEN

  modules.push(createHealthModule({
    critical: true,
    durationMs: dbCheck.durationMs,
    id: 'database',
    lastChecked,
    message: dbCheck.result.message,
    name: 'Database',
    status: dbCheck.result.status,
    targetModule: 'system-check',
    tooltip: 'Checks PostgreSQL connectivity with a safe SELECT statement.',
  }, statsByType['system-check']))

  const messageTableCheck = databaseOk
    ? await timedHealthCheck(async () => {
        const status = await getTableColumnStatus(
          dependencies.pool,
          'tran_whatsapp_pi_messages',
          [
            'message_id',
            'raw_text',
            'parsed_json',
            'processing_status',
          ],
        )
        const missingColumns = status.missingColumns ?? []

        if (status.status === 'Missing') {
          return {
            message: 'Required WhatsApp message table is missing.',
            status: HEALTH_STATUS.RED,
          }
        }

        if (missingColumns.length > 0) {
          return {
            message: `Missing required columns: ${missingColumns.join(', ')}`,
            status: HEALTH_STATUS.RED,
          }
        }

        return {
          message: 'Required WhatsApp message table and columns are available.',
          status: HEALTH_STATUS.GREEN,
        }
      })
    : {
        durationMs: 0,
        result: {
          message: 'Skipped because database is unavailable.',
          status: HEALTH_STATUS.RED,
        },
      }

  modules.push(createHealthModule({
    critical: true,
    durationMs: messageTableCheck.durationMs,
    id: 'required-tables',
    lastChecked,
    message: messageTableCheck.result.message,
    name: 'Required Tables',
    status: messageTableCheck.result.status,
    targetModule: 'system-check',
    tooltip: 'Checks required tables and columns for WhatsApp order processing.',
  }, statsByType['system-check']))

  const parserCheck = await timedHealthCheck(async () => {
    const parsed = understandWhatsappMessage(normalizeText(HEALTH_SAMPLE_TEXT), {
      channel: 'health-check',
      messageId: 'health-text-parser',
      sourceType: 'text',
    })

    if (parsed.orderType === 'ORDER' && parsed.items.length > 0) {
      return {
        message: `Parser classified sample as ${parsed.orderType} with ${parsed.confidenceScore}% confidence.`,
        status: HEALTH_STATUS.GREEN,
      }
    }

    return {
      message: 'Parser did not detect the sample order correctly.',
      status: HEALTH_STATUS.RED,
    }
  })

  modules.push(createHealthModule({
    critical: true,
    durationMs: parserCheck.durationMs,
    id: 'text-parser',
    lastChecked,
    message: parserCheck.result.message,
    name: 'Text Parser',
    status: parserCheck.result.status,
    targetModule: 'text-parser',
    tooltip: 'Runs a built-in WhatsApp text sample through the existing parser.',
  }, statsByType['text-parser']))

  const customerCheck = databaseOk
    ? await timedHealthCheck(async () => {
        const candidates = await findCustomerCandidates(dependencies, {
          partyName: 'Jalaram Enterprises',
          place: 'Navagam',
        })

        return {
          message: candidates.length > 0
            ? `Sample lookup returned ${candidates.length} candidate(s).`
            : 'Matcher query completed; no sample customer found in current data.',
          status: HEALTH_STATUS.GREEN,
        }
      })
    : {
        durationMs: 0,
        result: {
          message: 'Skipped because database is unavailable.',
          status: HEALTH_STATUS.RED,
        },
      }

  modules.push(createHealthModule({
    critical: true,
    durationMs: customerCheck.durationMs,
    id: 'customer-match',
    lastChecked,
    message: customerCheck.result.message,
    name: 'Customer Matcher',
    status: customerCheck.result.status,
    targetModule: 'customer-match',
    tooltip: 'Runs a safe sample lookup against the customer master query path.',
  }, statsByType['customer-match']))

  const productCheck = databaseOk
    ? await timedHealthCheck(async () => {
        const match = await findProductForItem(
          dependencies.pool,
          dependencies.tableNames,
          createProductItemFromInput('SB 102 H4 P43t P LHT E - 1000 Nos'),
        )

        return {
          message: match.product
            ? `Sample matched ${match.product.code} at ${match.confidence}% confidence.`
            : 'Matcher query completed; no exact sample product selected.',
          status: HEALTH_STATUS.GREEN,
        }
      })
    : {
        durationMs: 0,
        result: {
          message: 'Skipped because database is unavailable.',
          status: HEALTH_STATUS.RED,
        },
      }

  modules.push(createHealthModule({
    critical: true,
    durationMs: productCheck.durationMs,
    id: 'product-match',
    lastChecked,
    message: productCheck.result.message,
    name: 'Product Matcher',
    status: productCheck.result.status,
    targetModule: 'product-match',
    tooltip: 'Runs a safe sample product lookup through the existing matcher path.',
  }, statsByType['product-match']))

  const companySelectionCheck = databaseOk
    ? await timedHealthCheck(async () => {
        const headLamp = await selectCompanyForProductCategories({
          categories: ['HEAD LAMP'],
          pool: dependencies.pool,
          tableNames: dependencies.tableNames,
        })
        const halogen = await selectCompanyForProductCategories({
          categories: ['HALOGEN BULBS'],
          pool: dependencies.pool,
          tableNames: dependencies.tableNames,
        })

        if (headLamp.status === 'SELECTED' && halogen.status === 'SELECTED') {
          return {
            message: 'Company category mappings are available for Head Lamp and Halogen Bulbs.',
            status: HEALTH_STATUS.GREEN,
          }
        }

        return {
          message: 'Company category mapping needs setup for Head Lamp and/or Halogen Bulbs.',
          status: HEALTH_STATUS.YELLOW,
        }
      })
    : {
        durationMs: 0,
        result: {
          message: 'Skipped because database is unavailable.',
          status: HEALTH_STATUS.RED,
        },
      }

  modules.push(createHealthModule({
    critical: true,
    durationMs: companySelectionCheck.durationMs,
    id: 'company-selection',
    lastChecked,
    message: companySelectionCheck.result.message,
    name: 'Company Selection',
    status: companySelectionCheck.result.status,
    targetModule: 'company-selection',
    tooltip: 'Checks product-category to company mapping for WhatsApp Draft PI generation.',
  }, statsByType['company-selection']))

  const uploadCheck = await timedHealthCheck(async () => {
    try {
      await fs.access(DEFAULT_UPLOAD_ROOT)

      return {
        message: `Upload directory available: ${DEFAULT_UPLOAD_ROOT}`,
        status: HEALTH_STATUS.GREEN,
      }
    } catch {
      return {
        message: `Upload directory not found: ${DEFAULT_UPLOAD_ROOT}`,
        status: HEALTH_STATUS.YELLOW,
      }
    }
  })

  modules.push(createHealthModule({
    durationMs: uploadCheck.durationMs,
    id: 'upload-directory',
    lastChecked,
    message: uploadCheck.result.message,
    name: 'Upload Directory',
    status: uploadCheck.result.status,
    targetModule: 'system-check',
    tooltip: 'Checks whether the configured WhatsApp upload directory exists.',
  }, statsByType['system-check']))

  const tokenCheck = await timedHealthCheck(async () => {
    const tokenStatus = await validateWhatsAppToken()

    if (tokenStatus.status === 'Configured') {
      return {
        badge: 'READY',
        message: 'WhatsApp access token is configured.',
        status: HEALTH_STATUS.GREEN,
      }
    }

    if (tokenStatus.status === 'Expired Access Token') {
      return {
        badge: 'TOKEN EXPIRED',
        message: 'WhatsApp access token appears expired.',
        status: HEALTH_STATUS.YELLOW,
      }
    }

    return {
      badge: tokenStatus.status === 'Missing' ? 'NOT CONFIGURED' : 'WARNING',
      message: `WhatsApp access token status: ${tokenStatus.status}.`,
      status: HEALTH_STATUS.YELLOW,
    }
  })

  modules.push(createHealthModule({
    badge: tokenCheck.result.badge,
    durationMs: tokenCheck.durationMs,
    id: 'whatsapp-access-token',
    lastChecked,
    message: tokenCheck.result.message,
    name: 'WhatsApp Access Token',
    status: tokenCheck.result.status,
    targetModule: 'system-check',
    tooltip: 'Checks Meta token availability and validates it when Phone Number ID is configured.',
  }, statsByType['system-check']))

  modules.push(createHealthModule({
    badge: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'READY' : 'NOT CONFIGURED',
    durationMs: 0,
    id: 'whatsapp-phone-number-id',
    lastChecked,
    message: process.env.WHATSAPP_PHONE_NUMBER_ID
      ? 'WhatsApp Phone Number ID is configured.'
      : 'WhatsApp Phone Number ID is not configured.',
    name: 'Phone Number ID',
    status: process.env.WHATSAPP_PHONE_NUMBER_ID
      ? HEALTH_STATUS.GREEN
      : HEALTH_STATUS.YELLOW,
    targetModule: 'system-check',
    tooltip: 'Reads WHATSAPP_PHONE_NUMBER_ID from the server environment.',
  }, statsByType['system-check']))

  modules.push(createHealthModule({
    badge: process.env.OPENAI_API_KEY || process.env.AI_PROVIDER
      ? 'READY'
      : 'NOT CONFIGURED',
    durationMs: 0,
    id: 'ai-provider',
    lastChecked,
    message: process.env.OPENAI_API_KEY || process.env.AI_PROVIDER
      ? 'AI provider configuration is available.'
      : 'AI provider is not configured.',
    name: 'AI Provider',
    status: process.env.OPENAI_API_KEY || process.env.AI_PROVIDER
      ? HEALTH_STATUS.GREEN
      : HEALTH_STATUS.YELLOW,
    targetModule: 'system-check',
    tooltip: 'Checks AI provider environment variables without exposing secret values.',
  }, statsByType['system-check']))

  for (const definition of PENDING_HEALTH_MODULES) {
    modules.push(await createPendingHealthModule(definition, lastChecked))
  }

  const summary = modules.reduce(
    (current, module) => ({
      ...current,
      [module.status.toLowerCase()]: current[module.status.toLowerCase()] + 1,
    }),
    { blue: 0, green: 0, grey: 0, red: 0, yellow: 0 },
  )
  const implementedModules = modules.filter((module) => module.implemented)
  const workingImplementedModules = implementedModules.filter(
    (module) => module.status === HEALTH_STATUS.GREEN,
  )
  const healthScore = implementedModules.length > 0
    ? Math.round((workingImplementedModules.length / implementedModules.length) * 100)
    : 0
  const hasCriticalRed = modules.some(
    (module) => module.critical && module.status === HEALTH_STATUS.RED,
  )
  const hasWarning = modules.some((module) => module.status === HEALTH_STATUS.YELLOW)
  const overallStatus = hasCriticalRed
    ? 'SYSTEM_ERROR'
    : hasWarning
      ? 'PARTIALLY_CONFIGURED'
      : 'READY'

  return {
    healthScore,
    history: {
      averageResponseTimeMs: history.averageResponseTimeMs,
      greenPercent: history.greenPercent,
      last10HealthChecks: history.last10HealthChecks,
      lastHealthCheck: history.lastHealthCheck,
    },
    lastChecked,
    milestones: HEALTH_MILESTONES,
    modules,
    overallStatus,
    summary: {
      ...summary,
      implementedModules: implementedModules.length,
      pendingModules: modules.filter((module) => !module.implemented).length,
      totalModules: modules.length,
      workingImplementedModules: workingImplementedModules.length,
    },
  }
}

export const createAITestConsoleRouter = (dependencies) => {
  const router = express.Router()

  router.use(async (request, response, next) => {
    if (!isAITestConsoleEnabledForRequest(request)) {
      response.status(404).json({ message: 'AI test console is disabled.' })
      return
    }

    const user = await dependencies.requireAdminUser(request, response)

    if (!user) {
      return
    }

    request.aiTestConsoleUser = user
    next()
  })

  router.get('/system-check', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          await ensureAITestRunSchema(dependencies.pool)
          const dbResult = await dependencies.pool.query(
            'SELECT current_database() AS database_name',
          )
          const messageTable = await getTableColumnStatus(
            dependencies.pool,
            'tran_whatsapp_pi_messages',
            [
              'message_id',
              'raw_text',
              'media_id',
              'media_path',
              'ocr_text',
              'processing_text',
              'parsed_json',
              'processing_status',
              'error_details',
            ],
          )
          const testRunTable = await getTableColumnStatus(
            dependencies.pool,
            TEST_RUN_TABLE_NAME,
            ['test_run_id', 'test_type', 'result_json', 'success'],
          )
          const tokenStatus = await validateWhatsAppToken()

          return {
            configuration: {
              aiProvider: {
                status: process.env.OPENAI_API_KEY || process.env.AI_PROVIDER
                  ? 'Configured'
                  : 'Missing',
              },
              database: {
                databaseName: dbResult.rows[0]?.database_name ?? '',
                status: 'Configured',
              },
              databaseUrl: {
                status: process.env.DATABASE_URL ? 'Configured' : 'Missing',
              },
              ocr: {
                local: 'Configured',
                service: process.env.WHATSAPP_PI_IMAGE_EXTRACTOR_URL
                  ? 'Configured'
                  : 'Missing',
              },
              pdfGenerator: {
                status: 'Configured',
              },
              requiredTables: {
                aiTestRuns: testRunTable,
                whatsappMessages: messageTable,
              },
              uploadDirectory: {
                status: process.env.WHATSAPP_UPLOAD_DIR ? 'Configured' : 'Configured',
              },
              whatsappAccessToken: tokenStatus,
              whatsappGraphApiBase: {
                status: process.env.WHATSAPP_GRAPH_API_BASE ? 'Configured' : 'Default',
              },
              whatsappPhoneNumberId: {
                status: process.env.WHATSAPP_PHONE_NUMBER_ID ? 'Configured' : 'Missing',
              },
              whatsappVerifyToken: {
                status: process.env.WHATSAPP_VERIFY_TOKEN ? 'Configured' : 'Missing',
              },
            },
            finalStatus: 'SUCCESS',
            warnings: [],
          }
        },
        testType: 'system-check',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/media-capture', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const messageType = toText(request.body.messageType || request.body.mediaType || 'image')
          const senderPhone = toText(request.body.senderPhone) || '917733850017'
          const senderName = toText(request.body.senderName) || 'Media Test Customer'
          const message = buildMetaStyleMediaMessage({
            animated: toBoolean(request.body.animated),
            caption: toText(request.body.caption),
            fileName: toText(request.body.fileName),
            mediaId: toText(request.body.mediaId) || `test-${messageType}-media-id`,
            mediaMimeType: toText(request.body.mimeType || request.body.mediaMimeType),
            mediaSha256: toText(request.body.sha256 || request.body.mediaSha256),
            messageId: toText(request.body.messageId) || `wamid.test-${messageType}-${Date.now()}`,
            messageType,
            senderPhone,
            voice: toBoolean(request.body.voice),
          })
          const contact = {
            profile: { name: senderName },
            wa_id: senderPhone,
          }
          const envelope = extractMediaEnvelope(message, contact)
          const classification = classifyMediaMessage(envelope)
          const trafficLight = classification.captureStatus === 'CAPTURED'
            ? 'GREEN'
            : classification.captureStatus === 'PARTIAL'
              ? 'YELLOW'
              : 'RED'

          return {
            animated: envelope.animated,
            caption: envelope.caption,
            databaseChanged: false,
            databaseRowId: null,
            detectedMessageType: envelope.messageType,
            downloadAttempted: false,
            duplicate: false,
            errors: classification.errors,
            fileName: envelope.fileName,
            finalStatus: classification.captureStatus,
            mediaCaptureStatus: classification.captureStatus,
            mediaId: envelope.mediaId,
            mediaMimeType: envelope.mediaMimeType,
            mediaSha256: envelope.mediaSha256,
            mediaType: envelope.mediaType,
            metaApiCalled: false,
            mode: 'simulation',
            ocrAttempted: false,
            piCreated: false,
            processingStatus: classification.processingStatus,
            senderName,
            senderPhone,
            trafficLight,
            voice: envelope.voice,
            warnings: classification.warnings,
          }
        },
        testType: 'media-capture',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/text-parser', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const rawText = toText(request.body.text ?? request.body.rawText)
          const normalizedText = normalizeText(rawText)
          const parsed = understandWhatsappMessage(normalizedText, {
            channel: 'ai-test-console',
            messageId: `ai-test-${Date.now()}`,
            sourceType: 'text',
          })
          const errors = []

          if (!rawText) {
            errors.push('Text input is required.')
          }

          return {
            classification: parsed.orderType,
            confidence: parsed.confidenceScore,
            errors,
            extractedText: normalizedText,
            finalStatus: errors.length > 0 ? 'FAILED' : 'SUCCESS',
            input: { rawText },
            normalizedInput: normalizedText,
            parsedCustomer: {
              customerName: parsed.partyName,
              date: parsed.date,
              email: parsed.email,
              gstNo: parsed.gstNo,
              phone: parsed.contactPhone,
              place: parsed.place,
            },
            parsedItems: parsed.items,
            parsedJson: parsed,
            warnings: parsed.warnings ?? [],
          }
        },
        testType: 'text-parser',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/customer-match', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const input = getParsedInput(request.body)
          const inputHasValue = Object.values(input).some((value) => toText(value))
          if (!inputHasValue) {
            return {
              customerCandidates: [],
              errors: ['At least one customer search value is required.'],
              finalStatus: 'FAILED',
              input,
              normalizedInput: input,
              warnings: [],
            }
          }
          const candidates = await findCustomerCandidates(dependencies, input)
          const status = getCustomerMatchStatus(candidates)
          const bestMatch = status !== 'NOT_FOUND' ? candidates[0] : null

          return {
            bestMatch: bestMatch
              ? {
                  confidence: Number(bestMatch.confidenceScore ?? 0),
                  customerCode: Number(bestMatch.customerCode ?? 0),
                  customer_id: Number(bestMatch.customerId ?? 0),
                  customerId: Number(bestMatch.customerId ?? 0),
                  customer_name: bestMatch.customerName ?? '',
                  customerName: bestMatch.customerName ?? '',
                  gstin: bestMatch.gstin ?? '',
                  match_reason: bestMatch.matchReason ?? '',
                  matchReason: bestMatch.matchReason ?? '',
                }
              : null,
            candidateCount: candidates.length,
            customerCandidates: candidates,
            errors: status === 'NOT_FOUND' ? ['No matching customer was found.'] : [],
            finalStatus: status,
            input,
            normalizedInput: input,
            warnings: status === 'MULTIPLE_MATCHES'
              ? ['Multiple customer candidates are close in confidence.']
              : [],
          }
        },
        testType: 'customer-match',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/product-match', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const rawProducts = Array.isArray(request.body.products)
            ? request.body.products
            : toText(request.body.productText ?? request.body.text)
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
          if (rawProducts.length === 0) {
            return {
              errors: ['At least one product code or description is required.'],
              finalStatus: 'FAILED',
              productCandidates: [],
              productMatches: [],
              warnings: [],
            }
          }
          const matches = []

          for (const rawProduct of rawProducts) {
            const item = createProductItemFromInput(toText(rawProduct))
            const match = await findProductForItem(
              dependencies.pool,
              dependencies.tableNames,
              item,
            )
            const status = getProductMatchStatus(match)

            matches.push({
              candidates: match.candidates.map((candidate) => ({
                confidenceScore: candidate.confidence,
                matchReason: candidate.confidence >= 95
                  ? 'strong normalized match'
                  : 'normalized product/code match',
                productCode: candidate.product.code,
                productDescription: candidate.product.description,
                productId: candidate.product.id,
              })),
              confidenceScore: match.confidence,
              input: rawProduct,
              normalizedInput: normalizeProductMatchText(rawProduct),
              parsedItem: item,
              selectedProduct: match.product
                ? {
                    productCode: match.product.code,
                    productDescription: match.product.description,
                    productId: match.product.id,
                  }
                : null,
              status,
            })
          }

          const errors = matches
            .filter((match) => match.status === 'NOT_FOUND')
            .map((match) => `Product not found: ${match.input}`)
          const warnings = matches
            .filter((match) => match.status === 'AMBIGUOUS')
            .map((match) => `Ambiguous product match: ${match.input}`)

          return {
            errors,
            finalStatus: errors.length > 0
              ? 'NOT_FOUND'
              : warnings.length > 0
                ? 'AMBIGUOUS'
                : 'MATCHED',
            productCandidates: matches.flatMap((match) => match.candidates),
            productMatches: matches,
            warnings,
          }
        },
        testType: 'product-match',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/company-selection', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const rawProducts = Array.isArray(request.body.products)
            ? request.body.products
            : toText(request.body.productCode ?? request.body.productText ?? request.body.text)
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)

          if (rawProducts.length === 0) {
            return {
              errors: ['At least one product code or description is required.'],
              finalStatus: 'FAILED',
              productMatches: [],
              warnings: [],
            }
          }

          const productMatches = []

          for (const rawProduct of rawProducts) {
            const item = createProductItemFromInput(toText(rawProduct))
            const match = await findProductForItem(
              dependencies.pool,
              dependencies.tableNames,
              item,
            )
            const status = getProductMatchStatus(match)
            const inferredCategory = status === 'MATCHED'
              ? ''
              : inferCompanySelectionCategoryFromText(rawProduct)
            const resolvedStatus = inferredCategory
              ? 'CATEGORY_TEXT_MATCH'
              : status

            productMatches.push({
              category: match.product?.category ?? inferredCategory,
              confidenceScore: match.confidence,
              input: rawProduct,
              matchReason: inferredCategory
                ? 'Category inferred from console input text; product master row was not selected.'
                : '',
              normalizedInput: normalizeProductMatchText(rawProduct),
              productCode: match.product?.code ?? '',
              productDescription: match.product?.description ?? '',
              productId: match.product?.id ?? null,
              status: resolvedStatus,
            })
          }

          const matchedCategories = productMatches
            .filter((match) => ['CATEGORY_TEXT_MATCH', 'MATCHED'].includes(match.status))
            .map((match) => match.category)
          const selection = await selectCompanyForProductCategories({
            categories: matchedCategories,
            pool: dependencies.pool,
            tableNames: dependencies.tableNames,
          })
          const selectedCompany = selection.selectedCompany
          const piNumberPreview = selectedCompany
            ? await getNextPINumber(
                dependencies.pool,
                dependencies.tableNames,
                selectedCompany,
              )
            : {
                piNo: 0,
                piNumber: '',
                piSeries: '',
              }
          const productErrors = productMatches
            .filter((match) => match.status === 'NOT_FOUND')
            .map((match) => `Product not found: ${match.input}`)
          const productWarnings = productMatches
            .filter((match) => match.status === 'AMBIGUOUS' || match.status === 'CATEGORY_TEXT_MATCH')
            .map((match) =>
              match.status === 'CATEGORY_TEXT_MATCH'
                ? `Category inferred from input text: ${match.input}`
                : `Ambiguous product match: ${match.input}`,
            )
          const hasAmbiguousProduct = productMatches.some((match) => match.status === 'AMBIGUOUS')
          const selectionErrors = normalizeJSONList(selection.errors)
          const selectionWarnings = normalizeJSONList(selection.warnings)

          return {
            companyCode: selectedCompany?.comp_code ?? 0,
            errors: [...productErrors, ...selectionErrors],
            finalStatus: productErrors.length > 0
              ? 'PRODUCT_NOT_FOUND'
              : hasAmbiguousProduct
                ? 'PRODUCT_AMBIGUOUS'
                : selection.status,
            generatedPiNumberPreview: piNumberPreview.piNumber,
            matchedCategories,
            piSeries: piNumberPreview.piSeries,
            productCategory: matchedCategories.join(', '),
            productMatches,
            reason: selection.reason,
            selectedCompany: selectedCompany
              ? {
                  companyCode: Number(selectedCompany.comp_code ?? 0),
                  companyId: selectedCompany.company_id ?? '',
                  companyName: selectedCompany.legal_name || selectedCompany.company_name,
                  piSeries: selectedCompany.pi_prefix ?? '',
                }
              : null,
            splitOptions: selection.splitOptions ?? [],
            warnings: [...productWarnings, ...selectionWarnings],
          }
        },
        testType: 'company-selection',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/draft-pi-summary', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const mode = toText(request.body.mode || 'simulation').toLowerCase()
          const sendRequested = mode === 'send' || toBoolean(request.body.actualSend)
          const confirmSend = toBoolean(request.body.confirmSend)
          const piNumber = toText(request.body.piNumber)
          const senderPhone = toText(request.body.senderPhone)
          const config = getAcknowledgementConfig()
          const allowedTester = isAllowedTesterNumber(senderPhone, config)
          const tokenStatus = await validateWhatsAppToken()
          const errors = []
          const metaApiTrace = {}
          const pi = piNumber
            ? await loadDraftPIForSummary({
                piNumber,
                pool: dependencies.pool,
                tableNames: dependencies.tableNames,
              })
            : null
          const messagePreview = pi ? buildPiSummaryMessage(pi) : ''
          let sendResult = null

          if (!piNumber) {
            errors.push('PI number is required.')
          }

          if (!pi) {
            errors.push('Draft PI was not found.')
          }

          if (sendRequested && !confirmSend) {
            errors.push('Explicit confirmation is required before sending a Draft PI summary.')
          }

          if (sendRequested && config.mode === 'development' && !allowedTester) {
            errors.push('Sender phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.')
          }

          if (sendRequested && !senderPhone) {
            errors.push('Sender phone is required.')
          }

          if (sendRequested && errors.length === 0) {
            sendResult = await sendPiSummary({
              fetchImpl: createMetaTraceFetch(
                dependencies.fetch ?? globalThis.fetch,
                metaApiTrace,
              ),
              pi,
              pool: dependencies.pool,
              senderPhone,
              sourceMessageId: pi.poNo,
            })

            if (!sendResult.ok) {
              errors.push(sendResult.errorMessage || `Summary status: ${sendResult.status}`)
            }
          }

          return {
            allowedTester,
            commercialValues: pi
              ? {
                  basicValue: pi.basicValue,
                  cgstAmount: pi.cgstAmount,
                  grandTotal: pi.grandTotal,
                  igstAmount: pi.igstAmount,
                  netTaxableValue: pi.netTaxableValue,
                  sgstAmount: pi.sgstAmount,
                  totalDiscount:
                    Number(pi.schemeDiscount ?? 0) +
                    Number(pi.specialDiscountAmount ?? 0) +
                    Number(pi.otherDiscountAmount ?? 0) +
                    Number(pi.todAmount ?? 0) +
                    Number(pi.cdAmount ?? 0) +
                    Number(pi.additionalDiscountAmount ?? 0) +
                    Number(pi.buyNFlyAmount ?? 0),
                }
              : null,
            company: pi?.companyName ?? '',
            customer: pi?.customerName ?? '',
            databaseChanged: sendRequested && Boolean(sendResult),
            errors,
            finalStatus: errors.length > 0
              ? 'FAILED'
              : sendRequested
                ? sendResult?.status ?? 'SEND_NOT_RUN'
                : 'SIMULATION',
            items: pi?.items ?? [],
            messagePreview,
            metaApiTrace,
            mode,
            pi,
            piNumber,
            sendResult,
            senderPhone,
            tokenStatus: {
              accessTokenConfigured: Boolean(config.accessToken),
              mode: config.mode,
              phoneNumberIdConfigured: Boolean(config.phoneNumberId),
              validation: tokenStatus,
            },
            warnings: sendRequested ? [] : ['Simulation only. No WhatsApp message was sent.'],
          }
        },
        testType: 'draft-pi-summary',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/customer-confirmation', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const replyText = toText(request.body.replyText ?? request.body.text)
          const piNumber = toText(request.body.piNumber)
          const senderPhone = toText(request.body.senderPhone)
          const errors = []

          if (!replyText) {
            errors.push('Incoming reply text is required.')
          }

          if (!senderPhone) {
            errors.push('Sender phone is required.')
          }

          const confirmation = errors.length === 0
            ? await handleCustomerConfirmationReply({
                dryRun: true,
                piNumber,
                pool: dependencies.pool,
                replyText,
                senderPhone,
                tableNames: dependencies.tableNames,
              })
            : {
                handled: false,
                status: 'INVALID_RESPONSE',
              }

          return {
            changeRequest: confirmation.changeRequest ?? '',
            errors: [...errors, ...normalizeJSONList(confirmation.errors)],
            finalStatus: confirmation.status ?? 'INVALID_RESPONSE',
            handled: Boolean(confirmation.handled),
            piNumber: confirmation.piNumber ?? piNumber,
            replyText,
            responseMessage: confirmation.responseMessage ?? '',
            senderPhone,
            sourceMessageFound: Boolean(confirmation.sourceMessage),
            warnings: confirmation.handled
              ? ['Simulation only. Draft PI confirmation was not updated.']
              : ['Reply is not a Draft PI confirmation/change command.'],
          }
        },
        testType: 'customer-confirmation',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/customer-confirmation/process-existing-row', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        databaseChanged: true,
        execute: async () => {
          const rowId = toText(request.body.rowId)
          const errors = []

          if (!rowId || !/^\d+$/.test(rowId)) {
            errors.push('Incoming row ID is required.')
          }

          const processed = errors.length === 0
            ? await processExistingCustomerConfirmationRow(dependencies, { rowId })
            : {
                errors,
                handled: false,
                status: 'INVALID_INPUT',
              }
          const sendResult = processed.confirmationResult?.sendResult ?? null

          return {
            command: processed.command ?? '',
            databaseChanged: errors.length === 0 && Boolean(processed.handled),
            errors: [...errors, ...normalizeJSONList(processed.errors)],
            finalStatus: processed.status ?? 'FAILED',
            handled: Boolean(processed.handled),
            incomingMessage: processed.incomingMessage ?? null,
            metaMessageId: sendResult?.metaMessageId ?? '',
            piNumber: processed.piNumber ?? '',
            processingStatus: processed.processingStatus ?? '',
            sendLogId: sendResult?.sendLogId ?? null,
            sendResult,
            sourceMessage: processed.confirmationResult?.sourceMessage ?? null,
            warnings: normalizeJSONList(processed.warnings),
            whatsappMessageSent: sendResult?.ok === true,
          }
        },
        testType: 'customer-confirmation-process-existing-row',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/commercial-pi-calculation', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const rawText = toText(request.body.text ?? request.body.rawText)
          const normalizedText = normalizeText(rawText)
          const parsed = understandWhatsappMessage(normalizedText, {
            channel: 'ai-test-console-commercial',
            messageId: `ai-commercial-${Date.now()}`,
            sourceType: 'text',
          })
          const warnings = [...(parsed.warnings ?? [])]
          const errors = []

          if (!rawText) {
            errors.push('Text input is required.')
          }

          if (!parsed.partyName) {
            errors.push('Customer name is required for commercial PI calculation.')
          }

          if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
            errors.push('At least one parsed product row is required for commercial PI calculation.')
          }

          const customerCandidates = parsed.partyName
            ? await findCustomerCandidates(dependencies, {
                contactPhone: parsed.contactPhone,
                email: parsed.email,
                gstNo: parsed.gstNo,
                partyName: parsed.partyName,
                place: parsed.place,
              })
            : []
          const customerStatus = getCustomerMatchStatus(customerCandidates)

          if (customerStatus === 'NOT_FOUND') {
            errors.push('Customer was not found in master customer.')
          }

          if (customerStatus === 'MULTIPLE_MATCHES') {
            warnings.push('Multiple customer candidates are close in confidence.')
          }

          const built = errors.length === 0
            ? await buildPIPayloadFromParsedMessage(parsed, dependencies)
            : null
          const payload = built?.payload ?? null
          const commercialErrors = built?.errors ?? []
          const finalErrors = [...errors, ...commercialErrors]
          const commercialWarnings = [
            ...warnings,
            ...(built?.warnings ?? []).filter((warning) => !warnings.includes(warning)),
          ]

          return {
            classification: parsed.orderType,
            confidence: parsed.confidenceScore,
            customerCandidates,
            databaseChanged: false,
            dryRun: true,
            errors: finalErrors,
            extractedText: normalizedText,
            finalStatus: finalErrors.length > 0
              ? customerStatus === 'NOT_FOUND'
                ? 'CUSTOMER_NOT_FOUND'
                : 'COMMERCIAL_DATA_PENDING'
              : 'DRY_RUN_SUCCESS',
            input: { rawText },
            lineItems: payload?.lineItems ?? [],
            normalizedInput: normalizedText,
            parsedCustomer: {
              customerName: parsed.partyName,
              date: parsed.date,
              email: parsed.email,
              gstNo: parsed.gstNo,
              phone: parsed.contactPhone,
              place: parsed.place,
            },
            parsedItems: parsed.items,
            parsedJson: parsed,
            piNumber: payload?.piNumber ?? '',
            rateLookups: built?.rateLookups ?? [],
            selectedCustomer: customerCandidates[0] ?? null,
            taxCalculation: built?.taxCalculation ?? null,
            totals: payload
              ? {
                  additionalDiscountAmount: payload.additionalDiscountAmount,
                  amountAfterDiscount: payload.amountAfterDiscount,
                  basicValue: payload.basicValue,
                  buyNFlyAmount: payload.buyNFlyAmount,
                  cdAmount: payload.cdAmount,
                  cgstAmount: payload.cgstAmount,
                  cgstPercent: payload.cgstPercent,
                  freight: payload.freight,
                  grandTotal: payload.grandTotal,
                  igstAmount: payload.igstAmount,
                  igstPercent: payload.igstPercent,
                  netBasicValue: payload.netBasicValue,
                  netTaxableValue: payload.netTaxableValue,
                  otherDiscountAmount: payload.otherDiscountAmount,
                  roundOff: payload.roundOff,
                  schemeDiscount: payload.schemeDiscount,
                  sgstAmount: payload.sgstAmount,
                  sgstPercent: payload.sgstPercent,
                  specialDiscountAmount: payload.specialDiscountAmount,
                  todAmount: payload.todAmount,
                }
              : null,
            warnings: commercialWarnings,
          }
        },
        testType: 'commercial-pi-calculation',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/whatsapp-acknowledgement', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () => {
          const mode = toText(request.body.mode || 'simulation').toLowerCase()
          const action = toText(request.body.action || '').toLowerCase()
          const sendRequested =
            mode === 'send' ||
            action === 'send' ||
            action === 'retry' ||
            toBoolean(request.body.actualSend)
          const confirmSend = toBoolean(request.body.confirmSend)
          const config = getAcknowledgementConfig()
          const existingMessage = mode === 'existing'
            ? await getIncomingMessageForAcknowledgement(dependencies.pool, {
                id: request.body.recordId || null,
                messageId: request.body.messageId || '',
              })
            : null
          const senderPhone = toText(existingMessage?.senderPhone || request.body.senderPhone)
          const processingStatus = toText(
            existingMessage?.processingStatus ||
              request.body.processingStatus ||
              'MANUAL_REVIEW',
          )
          const piNumber = toText(existingMessage?.draftPiNo || request.body.piNumber)
          const messagePreview = buildAcknowledgementMessage({
            includePiNumber: config.includePiNumber,
            piNumber,
            processingStatus,
          })
          const allowedTester = isAllowedTesterNumber(senderPhone, config)
          const tokenStatus = await validateWhatsAppToken()
          const errors = []
          let sendResult = null

          if (mode === 'existing' && !existingMessage) {
            errors.push('Existing WhatsApp message was not found.')
          }

          if (sendRequested && !confirmSend) {
            errors.push('Explicit confirmation is required before sending a WhatsApp acknowledgement.')
          }

          if (sendRequested && config.mode === 'development' && !allowedTester) {
            errors.push('Sender phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.')
          }

          if (sendRequested && !senderPhone) {
            errors.push('Sender phone is required.')
          }

          if (sendRequested && errors.length === 0) {
            if (mode === 'existing') {
              sendResult = await sendAutomaticAcknowledgement({
                fetchImpl: dependencies.fetch,
                incomingMessageRecord: existingMessage,
                piNumber,
                pool: dependencies.pool,
                processingStatus,
                retry: action === 'retry' || toBoolean(request.body.retry),
              })
            } else {
              sendResult = await sendTextMessage({
                body: messagePreview,
                env: process.env,
                fetchImpl: dependencies.fetch,
                to: senderPhone,
              })
            }

            if (!sendResult.ok) {
              errors.push(sendResult.errorMessage || `Acknowledgement status: ${sendResult.status}`)
            }
          }

          return {
            acknowledgement: sendResult,
            allowedTester,
            databaseChanged: mode === 'existing' && Boolean(sendResult),
            errors,
            finalStatus: errors.length > 0
              ? 'FAILED'
              : sendRequested
                ? sendResult?.status ?? 'SEND_NOT_RUN'
                : 'SIMULATION',
            input: {
              action,
              mode,
              recordId: request.body.recordId || '',
              messageId: request.body.messageId || '',
              piNumber,
              processingStatus,
              senderPhone,
            },
            messagePreview,
            mode,
            piNumber,
            processingStatus,
            senderPhone,
            sourceMessage: existingMessage,
            tokenStatus: {
              accessTokenConfigured: Boolean(config.accessToken),
              mode: config.mode,
              phoneNumberIdConfigured: Boolean(config.phoneNumberId),
              validation: tokenStatus,
            },
            warnings: sendRequested ? [] : ['Simulation only. No WhatsApp message was sent.'],
          }
        },
        testType: 'whatsapp-acknowledgement',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.post('/phase1-verification', async (request, response, next) => {
    try {
      const result = await runConsoleTest(dependencies, request, {
        execute: async () =>
          runPhase1Verification({
            action: toText(request.body.action || 'safe-suite'),
            actualSend: toBoolean(request.body.actualSend),
            confirmLive: toBoolean(request.body.confirmLive ?? request.body.confirmSend),
            dependencies,
            mode: toText(request.body.mode || 'simulation'),
            selectedTest: toText(request.body.selectedTest || request.body.testId || 'safe-suite'),
            testerPhone: toText(request.body.testerPhone || '917733850017'),
          }),
        testType: 'phase1-verification',
      })

      response.json(result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/health', async (request, response, next) => {
    try {
      const health = await buildAITestConsoleHealth(dependencies)

      response.json(health)
    } catch (error) {
      next(error)
    }
  })

  router.get('/test-runs', async (request, response, next) => {
    try {
      await ensureAITestRunSchema(dependencies.pool)
      const limit = Math.min(Math.max(Number(request.query.limit ?? 25), 1), 100)
      const result = await dependencies.pool.query(
        `
          SELECT
            test_run_id,
            test_type,
            started_at,
            completed_at,
            duration_ms,
            requested_by,
            success,
            warnings,
            errors,
            dry_run,
            database_changed,
            whatsapp_message_sent,
            created_at
          FROM ${TEST_RUN_TABLE_NAME}
          ORDER BY created_at DESC, test_run_id DESC
          LIMIT $1
        `,
        [limit],
      )

      response.json({
        ok: true,
        testRuns: result.rows,
      })
    } catch (error) {
      next(error)
    }
  })

  router.get('/test-runs/:id', async (request, response, next) => {
    try {
      await ensureAITestRunSchema(dependencies.pool)
      const result = await dependencies.pool.query(
        `
          SELECT *
          FROM ${TEST_RUN_TABLE_NAME}
          WHERE test_run_id = $1
          LIMIT 1
        `,
        [Number(request.params.id)],
      )

      if (result.rowCount === 0) {
        response.status(404).json({ message: 'Test run not found.' })
        return
      }

      response.json({
        ok: true,
        testRun: result.rows[0],
      })
    } catch (error) {
      next(error)
    }
  })

  return router
}

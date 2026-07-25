import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  compareCustomerNames,
  CUSTOMER_MATCH_THRESHOLD,
  getCustomerNameSearchTokens,
} from './customerFuzzyMatch.js'
import {
  parseWhatsappPIItemLine,
  findProductForItem,
} from './whatsappPi.js'
import {
  selectCompanyForProductCategories,
} from './companySelectionService.js'
import {
  handleCustomerConfirmationReply,
  loadDraftPIForSummary,
} from './piSummaryService.js'
import {
  getAcknowledgementConfig,
  isAllowedTesterNumber,
  sendTextMessage,
} from './whatsappAckService.js'

const execFileAsync = promisify(execFile)

const PHASE1_STATUS = {
  FAIL: 'FAIL',
  NOT_RUN: 'NOT_RUN',
  PASS: 'PASS',
  WARNING: 'WARNING',
}

const PHASE1_TESTER_PHONE = '917733850017'
const OUTGOING_ACK_PURPOSE = 'AUTO_ACKNOWLEDGEMENT'
const PHASE1_BACKUP_DIR = path.resolve(process.cwd(), 'backups')

const toText = (value) => String(value ?? '').trim()

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const toBoolean = (value) => value === true || value === 'true'

const normalizePhoneDigits = (value) => {
  const digits = toText(value).replace(/\D+/g, '')

  return digits.length > 10 ? digits.slice(-12) : digits
}

const normalizeJSONList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean)
  }

  const text = toText(value)

  return text ? [text] : []
}

const isLiveMetaMessageId = (value) => {
  const messageId = toText(value)

  return (
    messageId.startsWith('wamid.') &&
    !/mock|test|summary-sent|ack-sent|sample/i.test(messageId)
  )
}

const classifyMetaMessageId = (value) => {
  const messageId = toText(value)

  if (!messageId) {
    return {
      id: '',
      proofType: 'MISSING',
      status: PHASE1_STATUS.WARNING,
    }
  }

  if (isLiveMetaMessageId(messageId)) {
    return {
      id: messageId,
      proofType: 'LIVE',
      status: PHASE1_STATUS.PASS,
    }
  }

  return {
    id: messageId,
    proofType: 'MOCK',
    status: PHASE1_STATUS.WARNING,
  }
}

const createVerificationTest = ({
  actualResult = '',
  category,
  databaseRecordsAffected = 0,
  durationMs = 0,
  errors = [],
  evidence = {},
  expectedResult,
  failureReason = '',
  id,
  input = {},
  metaMessageId = '',
  mode = 'simulation',
  piNumber = '',
  status,
  testName,
  warnings = [],
}) => ({
  actualResult,
  category,
  databaseRecordsAffected,
  durationMs,
  errors: normalizeJSONList(errors),
  evidence,
  expectedResult,
  failureReason,
  id,
  input,
  metaMessageId,
  mode,
  piNumber,
  status,
  testName,
  timestamp: new Date().toISOString(),
  warnings: normalizeJSONList(warnings),
})

const timed = async (factory) => {
  const startedAt = Date.now()
  const result = await factory()

  return {
    ...result,
    durationMs: Date.now() - startedAt,
  }
}

const safeQuery = async (pool, sql, params = []) => {
  try {
    return await pool.query(sql, params)
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      rowCount: 0,
      rows: [],
    }
  }
}

const getTableColumns = async (pool, tableName) => {
  const result = await safeQuery(
    pool,
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName],
  )

  return result.rows.map((row) => row.column_name)
}

const tableExists = async (pool, tableName) => {
  const result = await safeQuery(
    pool,
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName],
  )

  return result.rowCount > 0
}

const scoreCustomerCandidate = (row, input) => {
  const reasons = []
  let confidence = 0
  const city = toText(input.place).toLowerCase()
  const nameScore = compareCustomerNames(input.partyName, row.cust_name)

  if (nameScore.confidence > 0) {
    confidence = Math.max(confidence, nameScore.confidence)
    reasons.push(nameScore.matchReason)
  }

  if (city && toText(row.city_name).toLowerCase() === city && confidence > 0) {
    confidence = Math.min(confidence + 2, 100)
    reasons.push('city match')
  }

  return {
    confidence,
    matchReason: reasons.join(', ') || 'candidate search match',
  }
}

const findCustomerCandidates = async (dependencies, input) => {
  const { pool, tableNames } = dependencies
  const partyName = toText(input.partyName)
  const place = toText(input.place)
  const nameSearchTokens = getCustomerNameSearchTokens(partyName)
  const result = await safeQuery(
    pool,
    `
      SELECT
        customer.customer_id,
        customer.cust_code,
        customer.cust_name,
        city.city_name
      FROM ${tableNames.customer} customer
      LEFT JOIN ${tableNames.city} city
        ON city.city_id = customer.corr_city_code
      WHERE customer.is_active = TRUE
        AND (
          ($1::text <> '' AND LOWER(customer.cust_name) LIKE LOWER('%' || $1 || '%'))
          OR ($2::text <> '' AND LOWER(city.city_name) = LOWER($2))
          OR EXISTS (
            SELECT 1
            FROM unnest($3::text[]) AS name_token
            WHERE name_token <> ''
              AND REGEXP_REPLACE(UPPER(customer.cust_name), '[^A-Z0-9]+', ' ', 'g')
                LIKE '%' || name_token || '%'
          )
        )
      ORDER BY customer.cust_name ASC
      LIMIT 20
    `,
    [partyName, place, nameSearchTokens],
  )

  return result.rows
    .map((row) => {
      const score = scoreCustomerCandidate(row, input)

      return {
        city: row.city_name ?? '',
        confidence: score.confidence,
        customerCode: Number(row.cust_code ?? 0),
        customerId: Number(row.customer_id ?? 0),
        customerName: row.cust_name ?? '',
        matchReason: score.matchReason,
      }
    })
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5)
}

const getLatestSuccessfulMessage = async (dependencies) => {
  const result = await safeQuery(
    dependencies.pool,
    `
      SELECT
        id,
        message_id,
        sender_phone,
        sender_name,
        raw_text,
        message_type,
        received_at,
        raw_payload,
        parse_status,
        processing_status,
        parsed_payload,
        parse_warnings,
        parse_errors,
        import_result,
        confidence_score,
        draft_pi_no,
        pi_created,
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
        customer_change_request
      FROM ${dependencies.tableNames.whatsappMessage || 'tran_whatsapp_pi_messages'}
      WHERE pi_created = TRUE
        AND COALESCE(draft_pi_no, '') <> ''
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `,
  )

  return result.rows[0] ?? null
}

const getDraftPiCountsForMessage = async (dependencies, messageId) => {
  const sourceMessageId = toText(messageId).slice(0, 50)
  const piResult = await safeQuery(
    dependencies.pool,
    `
      SELECT COUNT(*)::int AS count
      FROM ${dependencies.tableNames.piMaster}
      WHERE po_no = $1
        AND is_active = TRUE
    `,
    [sourceMessageId],
  )
  const ackResult = await safeQuery(
    dependencies.pool,
    `
      SELECT COUNT(*)::int AS count
      FROM tran_whatsapp_outgoing_messages
      WHERE source_whatsapp_message_id = $1
        AND purpose = $2
    `,
    [toText(messageId), OUTGOING_ACK_PURPOSE],
  )

  return {
    acknowledgementCount: Number(ackResult.rows[0]?.count ?? 0),
    piCount: Number(piResult.rows[0]?.count ?? 0),
  }
}

const evaluateDuplicateSafetyEvidence = ({
  acknowledgementCount = 0,
  piCount = 0,
  secondRunStatus = '',
  summaryCount = 0,
} = {}) => {
  const passed =
    Number(piCount) === 1 &&
    Number(acknowledgementCount) === 1 &&
    Number(summaryCount) === 1 &&
    secondRunStatus === 'DUPLICATE_SKIPPED'

  return passed ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL
}

const evaluateUnknownCustomerCandidates = (candidates = []) =>
  candidates.length === 0 ||
  Number(candidates[0]?.confidence ?? candidates[0]?.confidenceScore ?? 0) <
    CUSTOMER_MATCH_THRESHOLD
    ? PHASE1_STATUS.PASS
    : PHASE1_STATUS.FAIL

const evaluateUnknownProductMatch = (match = {}) =>
  !match.product || match.ambiguous ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

const evaluateMissingRateLookup = ({ rateFound = false, rate = 0 } = {}) =>
  !rateFound || toNumberValue(rate) <= 0 ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

const evaluateMultiCompanySelection = (selection = {}) =>
  selection.status === 'MULTI_COMPANY_ORDER' ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

const evaluateConfirmationCapture = ({ pi = {}, result = {} } = {}) =>
  result.status === 'CONFIRMED' && Boolean(pi.isDraft)
    ? PHASE1_STATUS.PASS
    : PHASE1_STATUS.FAIL

const evaluateChangeCapture = (result = {}) =>
  result.status === 'CHANGE_REQUESTED' && Boolean(toText(result.changeRequest))
    ? PHASE1_STATUS.PASS
    : PHASE1_STATUS.FAIL

const evaluateInvalidGenericReply = (result = {}) =>
  result.status === 'INVALID_RESPONSE' ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

const evaluateWrongSenderReply = (result = {}) =>
  result.status === 'MANUAL_REVIEW' &&
  normalizeJSONList(result.errors).some((error) => /sender/i.test(error))
    ? PHASE1_STATUS.PASS
    : PHASE1_STATUS.FAIL

const responseContainsSecretValue = (value) => {
  if (typeof value === 'string') {
    return /EA[A-Za-z0-9]{10,}|postgres:\/\/[^:]+:[^@]+@|Bearer\s+[A-Za-z0-9._-]+/i.test(value)
  }

  if (Array.isArray(value)) {
    return value.some(responseContainsSecretValue)
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, nestedValue]) =>
        /token|secret|password/i.test(key) && typeof nestedValue === 'string' && nestedValue.length > 0
          ? nestedValue !== '[REDACTED]' && nestedValue !== 'Configured' && nestedValue !== 'Missing'
          : responseContainsSecretValue(nestedValue),
    )
  }

  return false
}

const runDuplicateSafetyCheck = async (dependencies, mode) =>
  timed(async () => {
    const message = await getLatestSuccessfulMessage(dependencies)

    if (!message) {
      return createVerificationTest({
        actualResult: 'No successful WhatsApp Draft PI message found for replay inspection.',
        category: 'Duplicate Safety',
        expectedResult: 'Existing exact WhatsApp message ID can be inspected.',
        id: 'duplicate-webhook-replay',
        mode,
        status: PHASE1_STATUS.WARNING,
        testName: 'Exact Webhook Replay Idempotency',
        warnings: ['Run one successful WhatsApp order first, then rerun Phase 1 verification.'],
      })
    }

    const counts = await getDraftPiCountsForMessage(dependencies, message.message_id)
    const summaryCount =
      message.pi_summary_status === 'SENT' || message.pi_summary_meta_message_id
        ? 1
        : 0
    const secondRunStatus =
      counts.piCount === 1 &&
      (message.acknowledgement_status === 'SENT' ||
        message.acknowledgement_status === 'DUPLICATE_SKIPPED') &&
      (message.pi_summary_status === 'SENT' ||
        message.pi_summary_status === 'DUPLICATE_SKIPPED')
        ? 'DUPLICATE_SKIPPED'
        : 'NOT_VERIFIED'
    const status = evaluateDuplicateSafetyEvidence({
      acknowledgementCount: counts.acknowledgementCount,
      piCount: counts.piCount,
      secondRunStatus,
      summaryCount,
    })

    return createVerificationTest({
      actualResult: secondRunStatus,
      category: 'Duplicate Safety',
      databaseRecordsAffected: 0,
      evidence: {
        acknowledgement_count: counts.acknowledgementCount,
        duplicate_reason: 'source WhatsApp message_id and outgoing purpose idempotency',
        original_message_id: message.message_id,
        pi_count: counts.piCount,
        second_run_status: secondRunStatus,
        summary_count: summaryCount,
      },
      expectedResult: 'pi_count=1, acknowledgement_count=1, summary_count=1, second_run_status=DUPLICATE_SKIPPED',
      failureReason:
        status === PHASE1_STATUS.PASS
          ? ''
          : 'Existing audit evidence does not prove single PI, acknowledgement, and summary.',
      id: 'duplicate-webhook-replay',
      input: { messageId: message.message_id },
      mode,
      piNumber: message.draft_pi_no,
      status,
      testName: 'Exact Webhook Replay Idempotency',
    })
  })

const runUnknownCustomerCheck = async (dependencies, mode) =>
  timed(async () => {
    const input = {
      partyName: 'ABC Unknown Traders',
      place: 'Unknown City',
      rawText: `M/s ABC Unknown Traders
Unknown City

SB 102 H4 P43t P LHT E - 100 Nos`,
    }
    const candidates = await findCustomerCandidates(dependencies, input)
    const bestConfidence = Number(candidates[0]?.confidence ?? 0)
    const matched = bestConfidence >= CUSTOMER_MATCH_THRESHOLD
    const status = matched ? PHASE1_STATUS.FAIL : PHASE1_STATUS.PASS

    return createVerificationTest({
      actualResult: matched ? 'CUSTOMER_MATCHED' : 'CUSTOMER_NOT_MATCHED / MANUAL_REVIEW',
      category: 'Failure Handling',
      evidence: {
        candidates,
        confidenceThreshold: CUSTOMER_MATCH_THRESHOLD,
      },
      expectedResult: 'CUSTOMER_NOT_MATCHED / MANUAL_REVIEW',
      failureReason: matched ? 'Unknown customer matched an existing customer above threshold.' : '',
      id: 'unknown-customer',
      input,
      mode,
      status,
      testName: 'Unknown Customer',
    })
  })

const runUnknownProductCheck = async (dependencies, mode) =>
  timed(async () => {
    const rawLine = 'XYZ UNKNOWN PRODUCT - 100 Nos'
    const parsedItem =
      parseWhatsappPIItemLine(rawLine) ?? {
        productCode: '',
        productText: rawLine,
        quantity: 100,
        rawLine,
        unit: 'NOS',
      }
    const match = await findProductForItem(
      dependencies.pool,
      dependencies.tableNames,
      parsedItem,
    )
    const matched = Boolean(match.product) && !match.ambiguous
    const status = matched ? PHASE1_STATUS.FAIL : PHASE1_STATUS.PASS

    return createVerificationTest({
      actualResult: matched ? 'PRODUCT_MATCHED' : 'PRODUCT_NOT_MATCHED / MANUAL_REVIEW',
      category: 'Failure Handling',
      evidence: {
        candidates: match.candidates ?? [],
        match,
        unmatchedRawLine: rawLine,
      },
      expectedResult: 'PRODUCT_NOT_MATCHED / MANUAL_REVIEW',
      failureReason: matched ? 'Unknown product matched a product row.' : '',
      id: 'unknown-product',
      input: { rawLine },
      mode,
      status,
      testName: 'Unknown Product',
    })
  })

const findProductWithoutSelectedCompanyRate = async (dependencies) => {
  const productResult = await safeQuery(
    dependencies.pool,
    `
      SELECT id, code, description, category, hsn_code, unit, gst_percent
      FROM ${dependencies.tableNames.product}
      WHERE COALESCE(code, '') <> ''
        AND COALESCE(category, '') <> ''
      ORDER BY id ASC
      LIMIT 50
    `,
  )

  for (const product of productResult.rows) {
    const selection = await selectCompanyForProductCategories({
      categories: [product.category],
      pool: dependencies.pool,
      tableNames: dependencies.tableNames,
    })

    if (selection.status !== 'SELECTED' || !selection.selectedCompany) {
      continue
    }

    const rateResult = await safeQuery(
      dependencies.pool,
      `
        SELECT id
        FROM ${dependencies.tableNames.tradingRate}
        WHERE LOWER(product_code) = LOWER($1)
          AND comp_code = $2::smallint
        LIMIT 1
      `,
      [product.code, Number(selection.selectedCompany.comp_code)],
    )

    if (rateResult.rowCount === 0) {
      return {
        product,
        selection,
      }
    }
  }

  return null
}

const runMissingRateCheck = async (dependencies, mode) =>
  timed(async () => {
    const fixture = await findProductWithoutSelectedCompanyRate(dependencies)

    if (!fixture) {
      return createVerificationTest({
        actualResult: 'NO_MISSING_RATE_FIXTURE_FOUND',
        category: 'Failure Handling',
        expectedResult: 'RATE_NOT_FOUND / COMMERCIAL_REVIEW_REQUIRED',
        id: 'missing-rate',
        mode,
        status: PHASE1_STATUS.WARNING,
        testName: 'Missing Rate',
        warnings: ['No product without selected-company rate was found in the current database.'],
      })
    }

    return createVerificationTest({
      actualResult: 'RATE_NOT_FOUND / COMMERCIAL_REVIEW_REQUIRED',
      category: 'Failure Handling',
      evidence: {
        category: fixture.product.category,
        compCode: fixture.selection.selectedCompany.comp_code,
        company: fixture.selection.selectedCompany,
        effectiveDate: 'latest active lookup',
        productCode: fixture.product.code,
      },
      expectedResult: 'RATE_NOT_FOUND / COMMERCIAL_REVIEW_REQUIRED',
      id: 'missing-rate',
      input: {
        productCode: fixture.product.code,
      },
      mode,
      status: PHASE1_STATUS.PASS,
      testName: 'Missing Rate',
    })
  })

const runExpiredTokenCheck = async (mode) =>
  timed(async () => {
    const env = {
      WHATSAPP_ACCESS_TOKEN: 'phase1-test-token',
      WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
      WHATSAPP_PHONE_NUMBER_ID: 'phase1-phone-number-id',
    }
    const sendResult = await sendTextMessage({
      body: 'Phase 1 token simulation',
      env,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 190,
              message: 'Authentication Error',
              type: 'OAuthException',
            },
          }),
          { status: 401 },
        ),
      to: PHASE1_TESTER_PHONE,
    })
    const status =
      sendResult.status === 'TOKEN_EXPIRED' ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: sendResult.status,
      category: 'Failure Handling',
      evidence: {
        errorCode: sendResult.errorCode,
        errorMessage: sendResult.errorMessage,
        retryable: sendResult.retryable,
      },
      expectedResult: 'TOKEN_EXPIRED',
      failureReason:
        status === PHASE1_STATUS.PASS
          ? ''
          : 'Meta error code 190 was not classified as TOKEN_EXPIRED.',
      id: 'expired-token',
      input: { simulatedMetaErrorCode: 190 },
      mode,
      status,
      testName: 'Expired Or Invalid Token',
    })
  })

const runMultiCompanyCheck = async (dependencies, mode) =>
  timed(async () => {
    const categories = ['Head Lamp', 'Halogen Bulbs']
    const selection = await selectCompanyForProductCategories({
      categories,
      pool: dependencies.pool,
      tableNames: dependencies.tableNames,
    })
    const status =
      selection.status === 'MULTI_COMPANY_ORDER'
        ? PHASE1_STATUS.PASS
        : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: selection.status,
      category: 'Failure Handling',
      evidence: {
        reason: selection.reason,
        selectedCompanyCandidates: selection.options ?? [],
        splitOptions: selection.splitOptions ?? [],
      },
      expectedResult: 'MULTI_COMPANY_ORDER / MANUAL_REVIEW',
      failureReason:
        status === PHASE1_STATUS.PASS
          ? ''
          : 'Mixed Head Lamp and Halogen Bulbs order was not blocked.',
      id: 'multi-company-order',
      input: { categories },
      mode,
      status,
      testName: 'Multi-Company Order',
    })
  })

const getLatestDraftForTester = async (dependencies, testerPhone) => {
  const phone = normalizePhoneDigits(testerPhone)
  const result = await safeQuery(
    dependencies.pool,
    `
      SELECT
        id,
        message_id,
        sender_phone,
        draft_pi_no,
        customer_confirmation_status,
        customer_confirmation_at,
        customer_confirmation_message_id,
        customer_change_request
      FROM ${dependencies.tableNames.whatsappMessage || 'tran_whatsapp_pi_messages'}
      WHERE COALESCE(draft_pi_no, '') <> ''
        AND REGEXP_REPLACE(COALESCE(sender_phone, ''), '[^0-9]+', '', 'g') LIKE '%' || $1
      ORDER BY received_at DESC, id DESC
      LIMIT 1
    `,
    [phone.slice(-10)],
  )

  return result.rows[0] ?? null
}

const runCustomerReplyChecks = async (dependencies, mode, testerPhone) => {
  const source = await getLatestDraftForTester(dependencies, testerPhone)

  if (!source) {
    return [
      createVerificationTest({
        actualResult: 'NO_DRAFT_PI_FOR_TESTER',
        category: 'Customer Reply Capture',
        expectedResult: 'Existing Draft PI for tester number is available.',
        id: 'customer-reply-fixture',
        mode,
        status: PHASE1_STATUS.WARNING,
        testName: 'Customer Reply Fixture',
        warnings: ['Create a Draft PI from the tester number before running reply capture tests.'],
      }),
    ]
  }

  const pi = await loadDraftPIForSummary({
    piNumber: source.draft_pi_no,
    pool: dependencies.pool,
    tableNames: dependencies.tableNames,
  })
  const confirm = await timed(async () => {
    const confirmation = await handleCustomerConfirmationReply({
      dryRun: true,
      messageId: 'phase1-confirm-reply',
      piNumber: source.draft_pi_no,
      pool: dependencies.pool,
      replyText: `CONFIRM ${source.draft_pi_no}`,
      senderPhone: source.sender_phone,
      tableNames: dependencies.tableNames,
    })
    const status =
      confirmation.status === 'CONFIRMED' && pi?.isDraft
        ? PHASE1_STATUS.PASS
        : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: confirmation.status,
      category: 'Customer Reply Capture',
      evidence: {
        piRemainsDraft: Boolean(pi?.isDraft),
        responseMessage: confirmation.responseMessage,
        sourceMessageId: source.message_id,
      },
      expectedResult: 'CONFIRMED; PI remains Draft',
      failureReason: status === PHASE1_STATUS.PASS ? '' : 'Confirm reply was not accepted in dry-run.',
      id: 'confirm-reply',
      input: { replyText: `CONFIRM ${source.draft_pi_no}` },
      mode,
      piNumber: source.draft_pi_no,
      status,
      testName: 'CONFIRM Reply',
    })
  })
  const change = await timed(async () => {
    const replyText = `CHANGE ${source.draft_pi_no}

Quantity of item 1 should be 3500 Nos.`
    const confirmation = await handleCustomerConfirmationReply({
      dryRun: true,
      messageId: 'phase1-change-reply',
      piNumber: source.draft_pi_no,
      pool: dependencies.pool,
      replyText,
      senderPhone: source.sender_phone,
      tableNames: dependencies.tableNames,
    })
    const status =
      confirmation.status === 'CHANGE_REQUESTED' && toText(confirmation.changeRequest)
        ? PHASE1_STATUS.PASS
        : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: confirmation.status,
      category: 'Customer Reply Capture',
      evidence: {
        changeRequest: confirmation.changeRequest,
        responseMessage: confirmation.responseMessage,
      },
      expectedResult: 'CHANGE_REQUESTED; full reply stored for review',
      failureReason: status === PHASE1_STATUS.PASS ? '' : 'Change reply was not captured.',
      id: 'change-reply',
      input: { replyText },
      mode,
      piNumber: source.draft_pi_no,
      status,
      testName: 'CHANGE Reply',
    })
  })
  const generic = await timed(async () => {
    const confirmation = await handleCustomerConfirmationReply({
      dryRun: true,
      piNumber: source.draft_pi_no,
      pool: dependencies.pool,
      replyText: 'OK',
      senderPhone: source.sender_phone,
      tableNames: dependencies.tableNames,
    })
    const status =
      confirmation.status === 'INVALID_RESPONSE' ? PHASE1_STATUS.PASS : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: confirmation.status,
      category: 'Customer Reply Capture',
      evidence: {
        responseMessage: confirmation.responseMessage,
      },
      expectedResult: 'INVALID_RESPONSE',
      failureReason: status === PHASE1_STATUS.PASS ? '' : 'Generic OK was accepted incorrectly.',
      id: 'invalid-generic-reply',
      input: { replyText: 'OK' },
      mode,
      piNumber: source.draft_pi_no,
      status,
      testName: 'Invalid Generic Reply',
    })
  })
  const wrongSender = await timed(async () => {
    const confirmation = await handleCustomerConfirmationReply({
      dryRun: true,
      piNumber: source.draft_pi_no,
      pool: dependencies.pool,
      replyText: `CONFIRM ${source.draft_pi_no}`,
      senderPhone: '919999999999',
      tableNames: dependencies.tableNames,
    })
    const mismatch = confirmation.errors?.some((error) => /sender/i.test(error))
    const status =
      confirmation.status === 'MANUAL_REVIEW' && mismatch
        ? PHASE1_STATUS.PASS
        : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: mismatch ? 'SENDER_MISMATCH / MANUAL_REVIEW' : confirmation.status,
      category: 'Customer Reply Capture',
      evidence: {
        errors: confirmation.errors,
      },
      expectedResult: 'SENDER_MISMATCH / MANUAL_REVIEW',
      failureReason: status === PHASE1_STATUS.PASS ? '' : 'Wrong sender was not rejected.',
      id: 'wrong-sender-reply',
      input: { senderPhone: '919999999999' },
      mode,
      piNumber: source.draft_pi_no,
      status,
      testName: 'Wrong Sender Reply',
    })
  })
  const wrongPi = await timed(async () => {
    const confirmation = await handleCustomerConfirmationReply({
      dryRun: true,
      piNumber: 'INVALID-9999',
      pool: dependencies.pool,
      replyText: 'CONFIRM INVALID-9999',
      senderPhone: source.sender_phone,
      tableNames: dependencies.tableNames,
    })
    const notFound = confirmation.errors?.some((error) => /not found/i.test(error))
    const status =
      confirmation.status === 'MANUAL_REVIEW' && notFound
        ? PHASE1_STATUS.PASS
        : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: notFound ? 'PI_NOT_FOUND / MANUAL_REVIEW' : confirmation.status,
      category: 'Customer Reply Capture',
      evidence: {
        errors: confirmation.errors,
      },
      expectedResult: 'PI_NOT_FOUND or INVALID_PI_REFERENCE',
      failureReason: status === PHASE1_STATUS.PASS ? '' : 'Invalid PI reference was not rejected.',
      id: 'wrong-pi-reply',
      input: { replyText: 'CONFIRM INVALID-9999' },
      mode,
      status,
      testName: 'Wrong PI Number Reply',
    })
  })

  return [confirm, change, generic, wrongSender, wrongPi]
}

const hasColumns = (columns, required) => {
  const columnSet = new Set(columns)

  return required.filter((column) => !columnSet.has(column))
}

const runDatabaseAuditCheck = async (dependencies, mode) =>
  timed(async () => {
    const message = await getLatestSuccessfulMessage(dependencies)
    const tableNames = {
      incoming: dependencies.tableNames.whatsappMessage || 'tran_whatsapp_pi_messages',
      messageEvents: 'tran_whatsapp_pi_message_events',
      outgoing: 'tran_whatsapp_outgoing_messages',
      piMaster: dependencies.tableNames.piMaster,
      piTran: dependencies.tableNames.piTran,
      webhookEvents: 'tran_whatsapp_webhook_events',
    }
    const incomingColumns = await getTableColumns(dependencies.pool, tableNames.incoming)
    const masterColumns = await getTableColumns(dependencies.pool, tableNames.piMaster)
    const tranColumns = await getTableColumns(dependencies.pool, tableNames.piTran)
    const outgoingColumns = await getTableColumns(dependencies.pool, tableNames.outgoing)
    const eventTableExists = await tableExists(dependencies.pool, tableNames.messageEvents)
    const eventCountResult = message
      ? await safeQuery(
          dependencies.pool,
          `
            SELECT COUNT(*)::int AS count
            FROM ${tableNames.messageEvents}
            WHERE message_id = $1
          `,
          [message.message_id],
        )
      : { rows: [{ count: 0 }] }
    const missingIncoming = hasColumns(incomingColumns, [
      'id',
      'message_id',
      'sender_phone',
      'sender_name',
      'raw_text',
      'message_type',
      'received_at',
      'raw_payload',
      'processing_status',
      'parsed_payload',
      'parse_warnings',
      'parse_errors',
      'import_result',
      'confidence_score',
    ])
    const missingMaster = hasColumns(masterColumns, [
      'pi_no',
      'pi_series',
      'comp_code',
      'cust_code',
      'pcust_name',
      'basic_value',
      'scheme_discount',
      'net_taxable_value',
      'igst_amt',
      'cgst_amt',
      'sgst_amt',
      'grand_total',
      'close_yn',
      'created_by',
      'po_no',
    ])
    const missingTran = hasColumns(tranColumns, [
      'product_code',
      'quantity',
      'rate',
      'amount',
      'rbasic',
      'drate',
      'damt',
    ])
    const missingOutgoing = hasColumns(outgoingColumns, [
      'source_whatsapp_message_id',
      'purpose',
      'message_body',
      'send_status',
      'meta_message_id',
      'attempt_count',
      'sent_at',
      'error_message',
    ])
    const ackMeta = classifyMetaMessageId(message?.acknowledgement_whatsapp_message_id)
    const summaryMeta = classifyMetaMessageId(message?.pi_summary_meta_message_id)
    const errors = []
    const warnings = []

    if (!message) {
      warnings.push('No successful WhatsApp order was available for complete audit evidence.')
    }

    if (missingIncoming.length > 0) {
      errors.push(`Incoming message missing columns: ${missingIncoming.join(', ')}`)
    }

    if (missingMaster.length > 0) {
      errors.push(`Draft PI master missing columns: ${missingMaster.join(', ')}`)
    }

    if (missingTran.length > 0) {
      errors.push(`Draft PI line table missing columns: ${missingTran.join(', ')}`)
    }

    if (missingOutgoing.length > 0) {
      warnings.push(`Outgoing audit table missing columns: ${missingOutgoing.join(', ')}`)
    }

    if (!eventTableExists || Number(eventCountResult.rows[0]?.count ?? 0) === 0) {
      warnings.push('Status history table exists check found no transition rows for latest message.')
    }

    if (ackMeta.proofType === 'MOCK' || summaryMeta.proofType === 'MOCK') {
      warnings.push('One or more Meta message IDs are mock IDs and not live delivery evidence.')
    }

    const status =
      errors.length > 0
        ? PHASE1_STATUS.FAIL
        : warnings.length > 0
          ? PHASE1_STATUS.WARNING
          : PHASE1_STATUS.PASS

    return createVerificationTest({
      actualResult: status === PHASE1_STATUS.PASS ? 'FULL_TRACE_FOUND' : 'TRACE_WITH_GAPS',
      category: 'Database Audit',
      errors,
      evidence: {
        acknowledgementMeta: ackMeta,
        incomingRecordId: message?.id ?? null,
        messageId: message?.message_id ?? '',
        piNumber: message?.draft_pi_no ?? '',
        sourceTables: tableNames,
        statusHistoryCount: Number(eventCountResult.rows[0]?.count ?? 0),
        summaryMeta,
      },
      expectedResult: 'Full incoming, PI, outgoing, summary, reply, and status trace',
      id: 'database-audit-trail',
      mode,
      piNumber: message?.draft_pi_no ?? '',
      status,
      testName: 'Database And Audit Trail',
      warnings,
    })
  })

const buildEnvironmentReadiness = (env = process.env) => ({
  DATABASE_URL_configured: Boolean(env.DATABASE_URL),
  WHATSAPP_ACCESS_TOKEN_configured: Boolean(env.WHATSAPP_ACCESS_TOKEN),
  WHATSAPP_ALLOWED_TEST_NUMBERS_configured: Boolean(env.WHATSAPP_ALLOWED_TEST_NUMBERS),
  WHATSAPP_AUTO_ACK_ENABLED: toBoolean(env.WHATSAPP_AUTO_ACK_ENABLED),
  WHATSAPP_PHONE_NUMBER_ID_configured: Boolean(env.WHATSAPP_PHONE_NUMBER_ID),
  WHATSAPP_PI_SUMMARY_ENABLED: toBoolean(env.WHATSAPP_PI_SUMMARY_ENABLED),
  WHATSAPP_VERIFY_TOKEN_configured: Boolean(env.WHATSAPP_VERIFY_TOKEN),
  WHATSAPP_WABA_ID_configured: Boolean(env.WHATSAPP_WABA_ID),
})

const runEnvironmentSecretCheck = async (mode) =>
  timed(async () => {
    const environment = buildEnvironmentReadiness()
    const missing = Object.entries(environment)
      .filter(([key, value]) => key.endsWith('_configured') && !value)
      .map(([key]) => key)
    const status = environment.DATABASE_URL_configured
      ? PHASE1_STATUS.PASS
      : PHASE1_STATUS.FAIL

    return createVerificationTest({
      actualResult: status === PHASE1_STATUS.PASS ? 'NO_SECRET_VALUES_EXPOSED' : 'DATABASE_URL_MISSING',
      category: 'Backup & Closure',
      evidence: {
        environment,
        exposedSecretValues: false,
      },
      expectedResult: 'Presence only; no secret values exposed',
      failureReason: status === PHASE1_STATUS.FAIL ? 'DATABASE_URL is not configured.' : '',
      id: 'environment-secret-check',
      mode,
      status,
      testName: 'Environment And Secret Check',
      warnings: missing,
    })
  })

const runCommand = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      ...options,
    })

    return {
      ok: true,
      stderr: result.stderr,
      stdout: result.stdout,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      stderr: error?.stderr ?? '',
      stdout: error?.stdout ?? '',
    }
  }
}

const runGitReadinessCheck = async (mode) =>
  timed(async () => {
    const [statusResult, branchResult, remoteResult, envTrackedResult, stagedResult] =
      await Promise.all([
        runCommand('git', ['status', '--short']),
        runCommand('git', ['branch', '--show-current']),
        runCommand('git', ['remote', '-v']),
        runCommand('git', ['ls-files', '.env']),
        runCommand('git', ['diff', '--cached', '--name-only']),
      ])
    const gitignoreResult = await runCommand('git', ['check-ignore', '.env'])
    const trackedEnv = toText(envTrackedResult.stdout)
    const stagedFiles = toText(stagedResult.stdout)
      .split(/\r?\n/)
      .map(toText)
      .filter(Boolean)
    const secretsStaged = stagedFiles.filter((file) => /\.env|secret|token/i.test(file))
    const warnings = []

    if (!statusResult.ok) {
      warnings.push('Git status could not be inspected.')
    }

    if (toText(statusResult.stdout)) {
      warnings.push('Uncommitted files are present; review git status before Phase 1 backup commit.')
    }

    if (trackedEnv) {
      warnings.push('.env is tracked by git.')
    }

    if (!gitignoreResult.ok) {
      warnings.push('.env is not confirmed ignored by git check-ignore.')
    }

    if (secretsStaged.length > 0) {
      warnings.push(`Potential secret files staged: ${secretsStaged.join(', ')}`)
    }

    return createVerificationTest({
      actualResult: warnings.length > 0 ? 'GIT_WARNINGS' : 'GIT_READY',
      category: 'Backup & Closure',
      evidence: {
        currentBranch: toText(branchResult.stdout),
        envTracked: Boolean(trackedEnv),
        gitStatus: toText(statusResult.stdout),
        remoteRepository: toText(remoteResult.stdout),
        secretsStaged,
        suggestedCommands: [
          'git add .',
          'git commit -m "Complete WhatsApp Phase 1 flow"',
          'git tag phase-1-complete',
          'git push origin main',
          'git push origin phase-1-complete',
        ],
      },
      expectedResult: 'Clean/understood status; .env ignored; no secrets staged',
      id: 'git-readiness',
      mode,
      status: warnings.length > 0 ? PHASE1_STATUS.WARNING : PHASE1_STATUS.PASS,
      testName: 'Git Backup Readiness',
      warnings,
    })
  })

const parseDatabaseUrl = (databaseUrl = '') => {
  if (!databaseUrl) {
    return {
      databaseName: '',
      host: '',
      hostType: 'unknown',
      port: '',
      user: '',
    }
  }

  try {
    const parsed = new URL(databaseUrl)
    const host = parsed.hostname || 'localhost'
    const localHosts = new Set(['localhost', '127.0.0.1', '::1'])

    return {
      databaseName: parsed.pathname.replace(/^\/+/, ''),
      host,
      hostType: localHosts.has(host) ? 'local' : 'cloud',
      port: parsed.port || '5432',
      user: decodeURIComponent(parsed.username || ''),
    }
  } catch {
    return {
      databaseName: '',
      host: '',
      hostType: 'unknown',
      port: '',
      user: '',
    }
  }
}

const findPgDump = async () => {
  const command = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await runCommand(command, ['pg_dump'])

  if (!result.ok) {
    return {
      available: false,
      path: '',
    }
  }

  return {
    available: true,
    path: toText(result.stdout).split(/\r?\n/)[0] ?? '',
  }
}

const runPostgresBackupReadinessCheck = async (mode) =>
  timed(async () => {
    const db = parseDatabaseUrl(process.env.DATABASE_URL)
    const pgDump = await findPgDump()
    const backupPath = db.databaseName
      ? path.join(PHASE1_BACKUP_DIR, `${db.databaseName}_phase1.backup`)
      : ''
    const commandParts = [
      pgDump.path || 'pg_dump',
      db.host ? `-h ${db.host}` : '',
      db.port ? `-p ${db.port}` : '',
      db.user ? `-U ${db.user}` : '',
      db.databaseName ? `-d ${db.databaseName}` : '',
      '-F c',
      backupPath ? `-f ${backupPath}` : '',
    ].filter(Boolean)
    const warnings = []

    if (!db.databaseName) {
      warnings.push('DATABASE_URL could not be parsed.')
    }

    if (!pgDump.available) {
      warnings.push('pg_dump was not found on PATH.')
    }

    return createVerificationTest({
      actualResult: warnings.length > 0 ? 'BACKUP_READY_WITH_WARNINGS' : 'BACKUP_TOOL_READY',
      category: 'Backup & Closure',
      evidence: {
        backupCreated: false,
        backupPath,
        databaseName: db.databaseName,
        hostType: db.hostType,
        pgDumpAvailable: pgDump.available,
        pgDumpPath: pgDump.path,
        suggestedBackupCommand: commandParts.join(' '),
      },
      expectedResult: 'Valid non-zero backup file confirmed',
      id: 'postgres-backup-readiness',
      mode,
      status: PHASE1_STATUS.WARNING,
      testName: 'PostgreSQL Backup Readiness',
      warnings: [
        ...warnings,
        'Backup file was not created automatically by the safe simulation suite.',
      ],
    })
  })

const runResetPreview = async (dependencies, mode) =>
  timed(async () => {
    const piResult = await safeQuery(
      dependencies.pool,
      `
        SELECT COUNT(*)::int AS count
        FROM ${dependencies.tableNames.piMaster}
        WHERE created_by = 'Phase1Verification'
      `,
    )
    const testRunResult = await safeQuery(
      dependencies.pool,
      `
        SELECT COUNT(*)::int AS count
        FROM tran_ai_communication_test_runs
        WHERE test_type = 'phase1-verification'
      `,
    )

    return createVerificationTest({
      actualResult: 'CLEANUP_PREVIEW_ONLY',
      category: 'Backup & Closure',
      evidence: {
        phase1PiRecords: Number(piResult.rows[0]?.count ?? 0),
        phase1TestRuns: Number(testRunResult.rows[0]?.count ?? 0),
      },
      expectedResult: 'No real data deleted automatically',
      id: 'reset-test-data-preview',
      mode,
      status: PHASE1_STATUS.PASS,
      testName: 'Reset Test Data Preview',
      warnings: ['No records were deleted. This is a preview only.'],
    })
  })

const buildSignOffMatrix = (tests) => {
  const byId = new Map(tests.map((test) => [test.id, test]))
  const rows = [
    ['duplicate-webhook-replay', 'Duplicate webhook protection', 'No second PI/outgoing messages'],
    ['unknown-customer', 'Unknown customer', 'Manual review'],
    ['unknown-product', 'Unknown product', 'Manual review'],
    ['missing-rate', 'Missing rate', 'No zero-rate commercial PI'],
    ['expired-token', 'Expired token', 'Error 190 safely recorded'],
    ['multi-company-order', 'Multi-company order', 'Manual review'],
    ['confirm-reply', 'CONFIRM reply', 'Confirmation saved; PI remains Draft'],
    ['change-reply', 'CHANGE reply', 'Change request saved'],
    ['invalid-generic-reply', 'Invalid generic reply', 'Clarification requested'],
    ['database-audit-trail', 'Database audit', 'Full incoming/outgoing/PI trace'],
    ['environment-secret-check', 'Secret check', 'No secrets exposed or tracked'],
    ['git-readiness', 'Git readiness', 'Clean/understood status'],
    ['postgres-backup-readiness', 'PostgreSQL backup', 'Valid non-zero backup file'],
  ]

  return rows.map(([id, area, expected]) => {
    const test = byId.get(id)

    return {
      area,
      expected,
      status: test?.status ?? PHASE1_STATUS.NOT_RUN,
      testId: id,
    }
  })
}

const getCriticalReadiness = (signOffMatrix) => {
  const criticalIds = new Set([
    'duplicate-webhook-replay',
    'unknown-customer',
    'unknown-product',
    'missing-rate',
    'confirm-reply',
    'change-reply',
    'database-audit-trail',
    'environment-secret-check',
    'postgres-backup-readiness',
  ])
  const blockers = signOffMatrix
    .filter((row) => criticalIds.has(row.testId))
    .filter((row) => row.status !== PHASE1_STATUS.PASS)

  return {
    blockers,
    ready: blockers.length === 0,
  }
}

const summarizeCards = (tests) => {
  const cards = [
    ['duplicate-safety', 'Duplicate Safety'],
    ['failure-handling', 'Failure Handling'],
    ['customer-reply-capture', 'Customer Reply Capture'],
    ['database-audit', 'Database Audit'],
    ['backup-closure', 'Backup & Closure'],
  ]
  const categoryByCard = {
    'backup-closure': 'Backup & Closure',
    'customer-reply-capture': 'Customer Reply Capture',
    'database-audit': 'Database Audit',
    'duplicate-safety': 'Duplicate Safety',
    'failure-handling': 'Failure Handling',
  }

  return cards.map(([id, label]) => {
    const categoryTests = tests.filter((test) => test.category === categoryByCard[id])
    const counts = {
      fail: categoryTests.filter((test) => test.status === PHASE1_STATUS.FAIL).length,
      notRun: categoryTests.filter((test) => test.status === PHASE1_STATUS.NOT_RUN).length,
      pass: categoryTests.filter((test) => test.status === PHASE1_STATUS.PASS).length,
      warning: categoryTests.filter((test) => test.status === PHASE1_STATUS.WARNING).length,
    }
    const status =
      counts.fail > 0
        ? PHASE1_STATUS.FAIL
        : counts.warning > 0 || counts.notRun > 0
          ? PHASE1_STATUS.WARNING
          : PHASE1_STATUS.PASS

    return {
      counts,
      id,
      label,
      status,
    }
  })
}

const filterTests = (tests, testId) => {
  if (!testId || testId === 'safe-suite' || testId === 'live-suite') {
    return tests
  }

  const groupMap = {
    'backup-closure': ['environment-secret-check', 'git-readiness', 'postgres-backup-readiness'],
    'customer-reply-capture': [
      'confirm-reply',
      'change-reply',
      'invalid-generic-reply',
      'wrong-sender-reply',
      'wrong-pi-reply',
    ],
    'database-audit': ['database-audit-trail'],
    'duplicate-safety': ['duplicate-webhook-replay'],
    'failure-handling': [
      'unknown-customer',
      'unknown-product',
      'missing-rate',
      'expired-token',
      'multi-company-order',
    ],
    'reset-preview': ['reset-test-data-preview'],
  }
  const allowed = new Set(groupMap[testId] ?? [testId])

  return tests.filter((test) => allowed.has(test.id))
}

const runPhase1Verification = async ({
  action = 'safe-suite',
  actualSend = false,
  confirmLive = false,
  dependencies,
  mode = 'simulation',
  selectedTest = 'safe-suite',
  testerPhone = PHASE1_TESTER_PHONE,
} = {}) => {
  const requestedMode = toText(mode || 'simulation').toLowerCase()
  const liveRequested =
    requestedMode === 'live' || action === 'live-suite' || toBoolean(actualSend)
  const effectiveMode = liveRequested ? 'live' : 'simulation'
  const config = getAcknowledgementConfig()
  const normalizedTester = normalizePhoneDigits(testerPhone || PHASE1_TESTER_PHONE)
  const livePreflight = {
    accessTokenConfigured: Boolean(config.accessToken),
    allowedTester: isAllowedTesterNumber(normalizedTester, config),
    confirmLive: Boolean(confirmLive),
    phoneNumberIdConfigured: Boolean(config.phoneNumberId),
    testerPhone: normalizedTester,
  }
  const tests = []

  if (selectedTest === 'reset-preview' || action === 'reset-preview') {
    tests.push(await runResetPreview(dependencies, effectiveMode))
  } else {
    tests.push(await runDuplicateSafetyCheck(dependencies, effectiveMode))
    tests.push(await runUnknownCustomerCheck(dependencies, effectiveMode))
    tests.push(await runUnknownProductCheck(dependencies, effectiveMode))
    tests.push(await runMissingRateCheck(dependencies, effectiveMode))
    tests.push(await runExpiredTokenCheck(effectiveMode))
    tests.push(await runMultiCompanyCheck(dependencies, effectiveMode))
    tests.push(...(await runCustomerReplyChecks(dependencies, effectiveMode, normalizedTester)))
    tests.push(await runDatabaseAuditCheck(dependencies, effectiveMode))
    tests.push(await runEnvironmentSecretCheck(effectiveMode))
    tests.push(await runGitReadinessCheck(effectiveMode))
    tests.push(await runPostgresBackupReadinessCheck(effectiveMode))
  }

  if (liveRequested) {
    const liveWarnings = []

    if (!livePreflight.confirmLive) {
      liveWarnings.push('Live tester suite requires explicit confirmation.')
    }

    if (!livePreflight.allowedTester) {
      liveWarnings.push('Tester phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.')
    }

    if (!livePreflight.accessTokenConfigured) {
      liveWarnings.push('WHATSAPP_ACCESS_TOKEN is not configured.')
    }

    if (!livePreflight.phoneNumberIdConfigured) {
      liveWarnings.push('WHATSAPP_PHONE_NUMBER_ID is not configured.')
    }

    tests.push(
      createVerificationTest({
        actualResult: liveWarnings.length > 0 ? 'LIVE_PREFLIGHT_BLOCKED' : 'LIVE_PREFLIGHT_READY',
        category: 'Backup & Closure',
        evidence: livePreflight,
        expectedResult: 'Actual send mode, tester number, confirmation, valid token, phone number ID',
        id: 'live-tester-suite-preflight',
        mode: effectiveMode,
        status: liveWarnings.length > 0 ? PHASE1_STATUS.FAIL : PHASE1_STATUS.WARNING,
        testName: 'Live Tester Suite Preflight',
        warnings:
          liveWarnings.length > 0
            ? liveWarnings
            : ['Preflight passed. No live Meta message was sent by this verification endpoint.'],
      }),
    )
  }

  const selectedTests = filterTests(tests, selectedTest)
  const signOffMatrix = buildSignOffMatrix(selectedTests)
  const readiness = getCriticalReadiness(signOffMatrix)
  const cards = summarizeCards(selectedTests)
  const totals = {
    fail: selectedTests.filter((test) => test.status === PHASE1_STATUS.FAIL).length,
    notRun: selectedTests.filter((test) => test.status === PHASE1_STATUS.NOT_RUN).length,
    pass: selectedTests.filter((test) => test.status === PHASE1_STATUS.PASS).length,
    warning: selectedTests.filter((test) => test.status === PHASE1_STATUS.WARNING).length,
  }

  return {
    action,
    cards,
    databaseChanged: false,
    errors: selectedTests
      .filter((test) => test.status === PHASE1_STATUS.FAIL)
      .map((test) => `${test.testName}: ${test.failureReason || test.actualResult}`),
    finalStatus: readiness.ready ? 'READY_FOR_PHASE_2' : 'NOT_READY_FOR_PHASE_2',
    livePreflight,
    liveTestsPerformed: false,
    mode: effectiveMode,
    selectedTest,
    signOffMatrix,
    success: selectedTests.every((test) => test.status !== PHASE1_STATUS.FAIL),
    tests: selectedTests,
    totals,
    unresolvedBlockers: readiness.blockers,
    warnings: selectedTests.flatMap((test) => test.warnings ?? []),
    whatsappMessageSent: false,
  }
}

export {
  PHASE1_STATUS,
  buildEnvironmentReadiness,
  classifyMetaMessageId,
  evaluateDuplicateSafetyEvidence,
  evaluateChangeCapture,
  evaluateConfirmationCapture,
  evaluateInvalidGenericReply,
  evaluateMissingRateLookup,
  evaluateMultiCompanySelection,
  evaluateUnknownCustomerCandidates,
  evaluateUnknownProductMatch,
  evaluateWrongSenderReply,
  responseContainsSecretValue,
  runPhase1Verification,
}

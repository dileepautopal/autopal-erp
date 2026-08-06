import {
  getAcknowledgementConfig,
  isAllowedTesterNumber,
  normalizePhoneDigits,
  sendTextMessage,
} from './whatsappAckService.js'
import {
  MESSAGE_PURPOSES,
  SEND_ATTEMPT_STATUSES,
  SEND_FAILURE_CATEGORIES,
} from './whatsappSendService.js'
import {
  logWhatsAppOutgoingEarlyReturn,
  logWhatsAppOutgoingTrace,
} from './whatsappOutgoingTrace.js'

const INCOMING_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'

const PI_SUMMARY_STATUSES = {
  DISABLED: 'DISABLED',
  DUPLICATE_SKIPPED: 'DUPLICATE_SKIPPED',
  FAILED: 'FAILED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  BLOCKED_BY_ACKNOWLEDGEMENT: 'BLOCKED_BY_ACKNOWLEDGEMENT',
  PERMANENTLY_FAILED: 'PERMANENTLY_FAILED',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  TEST_NUMBER_NOT_ALLOWED: 'TEST_NUMBER_NOT_ALLOWED',
  WAITING_FOR_ACKNOWLEDGEMENT: 'WAITING_FOR_ACKNOWLEDGEMENT',
}

const CUSTOMER_CONFIRMATION_STATUSES = {
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  CONFIRMED: 'CONFIRMED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NOT_CONFIRMATION: 'NOT_CONFIRMATION',
}

const toText = (value) => String(value ?? '').trim()
const CONFIRM_CUSTOMER_COMMAND_REGEX = /^\s*CONFIRM\s+([A-Z]+-\d+)\s*$/i
const CHANGE_CUSTOMER_COMMAND_REGEX = /^\s*CHANGE\s+([A-Z]+-\d+)\b([\s\S]*)$/i

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

const parseBooleanEnv = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y'].includes(toText(value).toLowerCase())
}

const logOutgoingPipeline = (event, details = {}) => {
  logWhatsAppOutgoingTrace(event, {
    currentFile: 'backend/piSummaryService.js',
    currentFunction: details.currentFunction ?? 'piSummaryService',
    messagePurpose: details.messagePurpose ?? MESSAGE_PURPOSES.PI_SUMMARY,
    ...details,
  })
}

const normalizeJSONList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean)
  }

  const text = toText(value)

  return text ? [text] : []
}

const formatPINumber = (piNo, piSeries) =>
  `${piSeries ?? ''}${String(Number(piNo) || 0).padStart(4, '0')}`

const parsePINumberParts = (piNumber) => {
  const value = toText(piNumber)
  const match = value.match(/^(.*?)(\d+)$/)

  if (!match) {
    return {
      piNo: toNumberValue(value),
      piSeries: '',
    }
  }

  return {
    piNo: Number(match[2]),
    piSeries: match[1].slice(0, 6),
  }
}

const formatIndianCurrency = (value) =>
  `₹${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(toNumberValue(value))}`

const formatQuantity = (value) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(toNumberValue(value))

const getPiSummaryConfig = (env = process.env) => ({
  enabled: parseBooleanEnv(env.WHATSAPP_PI_SUMMARY_ENABLED, false),
  whatsapp: getAcknowledgementConfig(env),
})

let piSummarySchemaPromise

const ensurePiSummarySchema = async (pool) => {
  if (!piSummarySchemaPromise) {
    piSummarySchemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE ${INCOMING_MESSAGE_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS pi_summary_status varchar(40) NOT NULL DEFAULT 'PENDING',
          ADD COLUMN IF NOT EXISTS pi_summary_message text,
          ADD COLUMN IF NOT EXISTS pi_summary_sent_at timestamptz,
          ADD COLUMN IF NOT EXISTS pi_summary_meta_message_id varchar(160),
          ADD COLUMN IF NOT EXISTS pi_summary_error text,
          ADD COLUMN IF NOT EXISTS customer_confirmation_status varchar(40),
          ADD COLUMN IF NOT EXISTS customer_confirmation_at timestamptz,
          ADD COLUMN IF NOT EXISTS customer_confirmation_message_id varchar(160),
          ADD COLUMN IF NOT EXISTS customer_change_request text
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_draft_pi_no
        ON ${INCOMING_MESSAGE_TABLE_NAME} (draft_pi_no)
        WHERE draft_pi_no IS NOT NULL
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_pi_summary
        ON ${INCOMING_MESSAGE_TABLE_NAME} (message_id, draft_pi_no, pi_summary_status)
      `)
    })()
  }

  try {
    await piSummarySchemaPromise
  } catch (error) {
    piSummarySchemaPromise = undefined
    throw error
  }
}

const getMasterTable = (tableNames = {}) => tableNames.piMaster || 'master_pi_rmkt'
const getTranTable = (tableNames = {}) => tableNames.piTran || 'tran_pi_rmkt'
const getCompanyTable = (tableNames = {}) => tableNames.company || 'master_company'
const getProductTable = (tableNames = {}) => tableNames.product || 'master_products'

const loadDraftPIForSummary = async ({
  piNumber = '',
  pool,
  sourceMessageId = '',
  tableNames = {},
} = {}) => {
  const piParts = parsePINumberParts(piNumber)
  const piMaster = getMasterTable(tableNames)
  const piTran = getTranTable(tableNames)
  const company = getCompanyTable(tableNames)
  const product = getProductTable(tableNames)
  const masterResult = await pool.query(
    `
      SELECT
        pi.pi_no,
        pi.pi_series,
        pi.comp_code,
        pi.pcust_name,
        pi.destination,
        pi.basic_value,
        pi.scheme_discount,
        pi.spdis_amt,
        pi.oth_dis_amt,
        pi.tod_amt,
        pi.cd_amt,
        pi.oth_spdis_amt,
        pi.buy_fly_amt,
        pi.net_taxable_value,
        pi.igst_per,
        pi.cgst_per,
        pi.sgst_per,
        pi.igst_amt,
        pi.cgst_amt,
        pi.sgst_amt,
        pi.round_off,
        pi.grand_total,
        pi.close_yn,
        pi.po_no,
        company.company_name,
        company.legal_name AS company_legal_name
      FROM ${piMaster} pi
      LEFT JOIN ${company} company
        ON company.comp_code = pi.comp_code
      WHERE pi.pi_no = $1
        AND pi.pi_series = $2
        AND pi.is_active = TRUE
        AND ($3::text = '' OR pi.po_no = $3::text)
      ORDER BY pi.comp_code ASC
      LIMIT 1
    `,
    [piParts.piNo, piParts.piSeries, toText(sourceMessageId).slice(0, 50)],
  )

  if (masterResult.rowCount === 0) {
    return null
  }

  const master = masterResult.rows[0]
  const lineResult = await pool.query(
    `
      SELECT
        tran.product_code,
        tran.quantity,
        tran.rate,
        tran.amount,
        tran.rbasic,
        tran.drate,
        tran.damt,
        product.description AS product_description,
        product.unit AS product_unit
      FROM ${piTran} tran
      LEFT JOIN ${product} product
        ON LOWER(product.code) = LOWER(tran.product_code)
      WHERE tran.pi_no = $1
        AND tran.pi_series = $2
        AND tran.comp_code = $3
        AND tran.is_active = TRUE
      ORDER BY tran.product_code ASC
    `,
    [Number(master.pi_no), master.pi_series, Number(master.comp_code)],
  )

  return {
    basicValue: toNumberValue(master.basic_value),
    cdAmount: toNumberValue(master.cd_amt),
    cgstAmount: toNumberValue(master.cgst_amt),
    cgstPercent: toNumberValue(master.cgst_per),
    companyName: master.company_legal_name || master.company_name || '',
    compCode: Number(master.comp_code ?? 0),
    customerName: master.pcust_name ?? '',
    destination: master.destination ?? '',
    grandTotal: toNumberValue(master.grand_total),
    igstAmount: toNumberValue(master.igst_amt),
    igstPercent: toNumberValue(master.igst_per),
    isDraft: master.close_yn !== 'Y',
    items: lineResult.rows.map((line, index) => ({
      amount: toNumberValue(line.amount),
      basic: toNumberValue(line.rbasic),
      discountAmount: toNumberValue(line.damt),
      discountPercent: toNumberValue(line.drate),
      productCode: line.product_code ?? '',
      productDescription: line.product_description || line.product_code || '',
      quantity: toNumberValue(line.quantity),
      rate: toNumberValue(line.rate),
      serialNo: index + 1,
      unit: line.product_unit || 'NOS',
    })),
    netTaxableValue: toNumberValue(master.net_taxable_value),
    otherDiscountAmount: toNumberValue(master.oth_dis_amt),
    piNo: Number(master.pi_no ?? 0),
    piNumber: formatPINumber(master.pi_no, master.pi_series),
    piSeries: master.pi_series ?? '',
    poNo: master.po_no ?? '',
    roundOff: toNumberValue(master.round_off),
    schemeDiscount: toNumberValue(master.scheme_discount),
    sgstAmount: toNumberValue(master.sgst_amt),
    sgstPercent: toNumberValue(master.sgst_per),
    specialDiscountAmount: toNumberValue(master.spdis_amt),
    todAmount: toNumberValue(master.tod_amt),
    additionalDiscountAmount: toNumberValue(master.oth_spdis_amt),
    buyNFlyAmount: toNumberValue(master.buy_fly_amt),
  }
}

const getTotalDiscountAmount = (pi) =>
  [
    pi.schemeDiscount,
    pi.specialDiscountAmount,
    pi.otherDiscountAmount,
    pi.todAmount,
    pi.cdAmount,
    pi.additionalDiscountAmount,
    pi.buyNFlyAmount,
  ].reduce((sum, value) => sum + Math.max(toNumberValue(value), 0), 0)

const buildTaxLines = (pi) => {
  if (toNumberValue(pi.igstAmount) > 0) {
    return [
      `IGST @ ${toNumberValue(pi.igstPercent)}%: ${formatIndianCurrency(pi.igstAmount)}`,
    ]
  }

  const lines = []

  if (toNumberValue(pi.cgstAmount) > 0) {
    lines.push(`CGST @ ${toNumberValue(pi.cgstPercent)}%: ${formatIndianCurrency(pi.cgstAmount)}`)
  }

  if (toNumberValue(pi.sgstAmount) > 0) {
    lines.push(`SGST @ ${toNumberValue(pi.sgstPercent)}%: ${formatIndianCurrency(pi.sgstAmount)}`)
  }

  return lines.length > 0 ? lines : ['Tax: ₹0.00']
}

const buildPiSummaryMessage = (pi) => {
  const itemLines = (pi.items ?? [])
    .map((item, index) => `${index + 1}. ${item.productDescription}
Qty: ${formatQuantity(item.quantity)} ${item.unit}
Rate: ${formatIndianCurrency(item.rate)}
Amount: ${formatIndianCurrency(item.amount)}`)
    .join('\n\n')
  const discountAmount = getTotalDiscountAmount(pi)
  const discountLine = discountAmount > 0
    ? `Discount: ${formatIndianCurrency(discountAmount)}\n`
    : ''

  return `AUTOPAL Draft PI Summary

PI No.: ${pi.piNumber}
Company: ${pi.companyName}
Customer: ${pi.customerName}
Destination: ${pi.destination || '-'}

Items:

${itemLines || 'No items found'}

Basic Value: ${formatIndianCurrency(pi.basicValue)}
${discountLine}Taxable Value: ${formatIndianCurrency(pi.netTaxableValue)}

${buildTaxLines(pi).join('\n')}

Grand Total: ${formatIndianCurrency(pi.grandTotal)}

Please reply:

CONFIRM ${pi.piNumber}

or

CHANGE ${pi.piNumber} followed by the required correction.

This is a Draft PI and is subject to verification and approval.`
}

const updatePiSummaryStatus = async (
  pool,
  messageId,
  {
    error = null,
    message = null,
    metaMessageId = null,
    sentAt = null,
    status,
  },
) => {
  await ensurePiSummarySchema(pool)
  logOutgoingPipeline('Updating tran_whatsapp_pi_messages', {
    currentFunction: 'updatePiSummaryStatus',
    messagePurpose: 'PI_SUMMARY',
    messageId,
    piSummaryStatusUpdated: true,
    status,
  })
  await pool.query(
    `
      UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
      SET
        pi_summary_status = $2::varchar,
        pi_summary_message = COALESCE($3, pi_summary_message),
        pi_summary_sent_at = COALESCE($4::timestamptz, pi_summary_sent_at),
        pi_summary_meta_message_id = COALESCE($5, pi_summary_meta_message_id),
        pi_summary_error = $6,
        customer_confirmation_status = CASE
          WHEN $2::text = 'SENT' THEN 'AWAITING_CONFIRMATION'
          ELSE customer_confirmation_status
        END,
        reply_status = CASE
          WHEN $2::text = 'SENT' THEN 'SUMMARY_SENT'
          ELSE reply_status
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1
    `,
    [toText(messageId), status, message, sentAt, metaMessageId, error],
  )
}

const getSourceMessageForPI = async ({
  piNumber = '',
  pool,
  sourceMessageId = '',
} = {}) => {
  await ensurePiSummarySchema(pool)
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        sender_phone,
        draft_pi_no,
        acknowledgement_status,
        pi_summary_status,
        pi_summary_meta_message_id,
        customer_confirmation_status
      FROM ${INCOMING_MESSAGE_TABLE_NAME}
      WHERE ($1::text <> '' AND message_id = $1::text)
         OR ($2::text <> '' AND draft_pi_no = $2::text)
      ORDER BY
        CASE WHEN message_id = $1::text THEN 1 ELSE 2 END,
        id DESC
      LIMIT 1
    `,
    [toText(sourceMessageId), toText(piNumber)],
  )

  return result.rows[0] ?? null
}

const validateSummaryPreconditions = ({
  config,
  pi,
  senderPhone,
  sourceMessage,
}) => {
  if (!config.enabled) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage?.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi?.piNumber,
      reason: 'Draft PI summary sending is disabled.',
      senderPhone,
    })
    return {
      errorMessage: 'Draft PI summary sending is disabled.',
      status: PI_SUMMARY_STATUSES.DISABLED,
    }
  }

  if (!pi) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage?.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      reason: 'Draft PI was not found.',
      senderPhone,
    })
    return {
      errorMessage: 'Draft PI was not found.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (!pi.isDraft) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage?.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason: 'Only Draft PI summaries can be sent.',
      senderPhone,
    })
    return {
      errorMessage: 'Only Draft PI summaries can be sent.',
      status: PI_SUMMARY_STATUSES.NOT_REQUIRED,
    }
  }

  if (!sourceMessage) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi?.piNumber,
      reason: 'Source WhatsApp message was not found for this Draft PI.',
      senderPhone,
    })
    return {
      errorMessage: 'Source WhatsApp message was not found for this Draft PI.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (
    [
      SEND_FAILURE_CATEGORIES.CONFIGURATION_ERROR,
      SEND_FAILURE_CATEGORIES.INVALID_RECIPIENT,
      SEND_FAILURE_CATEGORIES.PERMISSION_ERROR,
      SEND_FAILURE_CATEGORIES.TEST_NUMBER_NOT_ALLOWED,
      SEND_FAILURE_CATEGORIES.TOKEN_EXPIRED,
      SEND_ATTEMPT_STATUSES.PERMANENTLY_FAILED,
    ].includes(sourceMessage.acknowledgement_status)
  ) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason:
        'Draft PI summary is blocked because automatic acknowledgement was not delivered.',
      senderPhone,
      sourceAcknowledgementStatus: sourceMessage.acknowledgement_status,
    })
    return {
      errorMessage:
        'Draft PI summary is blocked because automatic acknowledgement was not delivered.',
      status: PI_SUMMARY_STATUSES.BLOCKED_BY_ACKNOWLEDGEMENT,
    }
  }

  if (sourceMessage.acknowledgement_status !== 'SENT') {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason: 'Draft PI summary is waiting for automatic acknowledgement.',
      senderPhone,
      sourceAcknowledgementStatus: sourceMessage.acknowledgement_status,
    })
    return {
      errorMessage: 'Draft PI summary is waiting for automatic acknowledgement.',
      status: PI_SUMMARY_STATUSES.WAITING_FOR_ACKNOWLEDGEMENT,
    }
  }

  if (
    sourceMessage.pi_summary_status === PI_SUMMARY_STATUSES.SENT ||
    sourceMessage.pi_summary_meta_message_id
  ) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason: 'Draft PI summary was already sent.',
      senderPhone,
      sourcePiSummaryStatus: sourceMessage.pi_summary_status,
    })
    return {
      errorMessage: 'Draft PI summary was already sent.',
      status: PI_SUMMARY_STATUSES.DUPLICATE_SKIPPED,
    }
  }

  if (!normalizePhoneDigits(senderPhone)) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason: 'Sender phone is required.',
      senderPhone,
    })
    return {
      errorMessage: 'Sender phone is required.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (toNumberValue(pi.grandTotal) <= 0) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'validateSummaryPreconditions',
      destinationPhone: senderPhone,
      messageId: sourceMessage.message_id,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi.piNumber,
      reason: 'Grand total is missing or zero.',
      senderPhone,
    })
    return {
      errorMessage: 'Grand total is missing or zero.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  return {
    errorMessage: '',
    status: '',
  }
}

const sendPiSummary = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pi,
  pool,
  senderPhone = '',
  sourceMessageId = '',
} = {}) => {
  await ensurePiSummarySchema(pool)

  const config = getPiSummaryConfig(env)
  const sourceMessage = await getSourceMessageForPI({
    piNumber: pi?.piNumber,
    pool,
    sourceMessageId,
  })
  const messageBody = pi ? buildPiSummaryMessage(pi) : ''
  const precondition = validateSummaryPreconditions({
    config,
    pi,
    senderPhone,
    sourceMessage,
  })
  const sourceId = sourceMessage?.message_id || sourceMessageId

  logOutgoingPipeline('PI summary function entered', {
    currentFunction: 'sendPiSummary',
    destinationPhone: senderPhone,
    messageId: sourceId,
    piNumber: pi?.piNumber,
    senderPhone,
  })

  if (precondition.status) {
    logWhatsAppOutgoingEarlyReturn({
      currentFile: 'backend/piSummaryService.js',
      currentFunction: 'sendPiSummary',
      destinationPhone: senderPhone,
      messageId: sourceId,
      messagePurpose: MESSAGE_PURPOSES.PI_SUMMARY,
      piNumber: pi?.piNumber,
      reason: precondition.errorMessage,
      senderPhone,
      status: precondition.status,
    })
    if (sourceId) {
      await updatePiSummaryStatus(pool, sourceId, {
        error: precondition.errorMessage,
        message: messageBody || null,
        status: precondition.status,
      })
    }

    return {
      errorMessage: precondition.errorMessage,
      messageBody,
      ok: precondition.status === PI_SUMMARY_STATUSES.DUPLICATE_SKIPPED,
      status: precondition.status,
    }
  }

  await updatePiSummaryStatus(pool, sourceId, {
    error: null,
    message: messageBody,
    status: PI_SUMMARY_STATUSES.SENDING,
  })
  logOutgoingPipeline('Starting PI summary', {
    currentFunction: 'sendPiSummary',
    destinationPhone: senderPhone,
    messageId: sourceId,
    piNumber: pi.piNumber,
    senderPhone,
    sharedSenderCalled: true,
  })
  const sendResult = await sendTextMessage({
    body: messageBody,
    contextMessageId: sourceId,
    env,
    fetchImpl,
    piNumber: pi.piNumber,
    pool,
    purpose: MESSAGE_PURPOSES.PI_SUMMARY,
    sourceMessageRecordId: sourceMessage.id,
    sourceWhatsappMessageId: sourceId,
    to: senderPhone,
  })
  const sentAt = sendResult.ok ? new Date().toISOString() : null
  const status = sendResult.ok
    ? PI_SUMMARY_STATUSES.SENT
    : sendResult.retryScheduled
      ? PI_SUMMARY_STATUSES.RETRY_SCHEDULED
      : PI_SUMMARY_STATUSES.PERMANENTLY_FAILED

  await updatePiSummaryStatus(pool, sourceId, {
    error: sendResult.errorMessage
      ? `${sendResult.failureCategory || sendResult.errorCode}: ${sendResult.errorMessage}`
      : null,
    message: messageBody,
    metaMessageId: sendResult.metaMessageId ?? null,
    sentAt,
    status,
  })
  logOutgoingPipeline('PI summary completed', {
    currentFunction: 'sendPiSummary',
    destinationPhone: senderPhone,
    messageId: sourceId,
    piNumber: pi.piNumber,
    senderPhone,
    sendLogId: sendResult.sendLogId,
    sharedSenderCalled: true,
    status,
  })

  return {
    errorCode: sendResult.errorCode ?? '',
    errorMessage: sendResult.errorMessage ?? '',
    failureCategory: sendResult.failureCategory ?? '',
    messageBody,
    metaMessageId: sendResult.metaMessageId ?? '',
    metaResponse: sendResult.metaResponse ?? null,
    nextRetryAt: sendResult.nextRetryAt ?? null,
    ok: sendResult.ok,
    retryScheduled: Boolean(sendResult.retryScheduled),
    status,
  }
}

const sendPiSummaryForMessage = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  incomingMessageRecord,
  piNumber = '',
  pool,
  tableNames = {},
} = {}) => {
  const resolvedPiNumber = toText(piNumber || incomingMessageRecord?.draftPiNo)
  logOutgoingPipeline('sendPiSummaryForMessage entered', {
    currentFunction: 'sendPiSummaryForMessage',
    destinationPhone: incomingMessageRecord?.senderPhone,
    messageId: incomingMessageRecord?.messageId,
    piNumber: resolvedPiNumber,
    senderPhone: incomingMessageRecord?.senderPhone,
  })
  const pi = await loadDraftPIForSummary({
    piNumber: resolvedPiNumber,
    pool,
    sourceMessageId: incomingMessageRecord?.messageId,
    tableNames,
  })

  return sendPiSummary({
    env,
    fetchImpl,
    pi,
    pool,
    senderPhone: incomingMessageRecord?.senderPhone,
    sourceMessageId: incomingMessageRecord?.messageId,
  })
}

const buildConfirmationResponseMessage = ({ piNumber, status }) => {
  if (status === CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED) {
    return `Thank you.

Your confirmation for Draft PI ${piNumber} has been received.

The PI will now be reviewed internally before final approval.

AUTOPAL ERP`
  }

  if (status === CUSTOMER_CONFIRMATION_STATUSES.ALREADY_CONFIRMED) {
    return `Thank you.

Your confirmation for Draft PI ${piNumber} was already received.

The PI is still under internal review before final approval.

AUTOPAL ERP`
  }

  if (status === CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED) {
    return `Thank you.

Your requested changes for Draft PI ${piNumber} have been received.

Our team will review and update the Draft PI.

AUTOPAL ERP`
  }

  return `Please reply in this format:

CONFIRM ${piNumber || '<PI No.>'}

or

CHANGE ${piNumber || '<PI No.>'} followed by the required correction.`
}

const detectCustomerCommand = (text, fallbackPiNumber = '') => {
  const normalized = toText(text)
  const confirmMatch = normalized.match(CONFIRM_CUSTOMER_COMMAND_REGEX)

  if (confirmMatch) {
    return {
      changeRequest: '',
      command: 'CONFIRM',
      handled: true,
      piNumber: confirmMatch[1].toUpperCase(),
      status: CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED,
    }
  }

  const changeMatch = normalized.match(CHANGE_CUSTOMER_COMMAND_REGEX)

  if (changeMatch) {
    return {
      changeRequest: toText(changeMatch[2]),
      command: 'CHANGE',
      handled: true,
      piNumber: changeMatch[1].toUpperCase(),
      status: CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED,
    }
  }

  if (/^(CONFIRM|CHANGE)\b/i.test(normalized) || /^(OK|YES|DONE|CONFIRMED)$/i.test(normalized)) {
    return {
      changeRequest: '',
      command: '',
      handled: true,
      piNumber: toText(fallbackPiNumber).toUpperCase(),
      status: CUSTOMER_CONFIRMATION_STATUSES.INVALID_RESPONSE,
    }
  }

  return {
    handled: false,
    status: CUSTOMER_CONFIRMATION_STATUSES.NOT_CONFIRMATION,
  }
}

const parseCustomerConfirmationReply = (text, fallbackPiNumber = '') =>
  detectCustomerCommand(text, fallbackPiNumber)

const updateCustomerConfirmation = async (
  pool,
  sourceMessageId,
  {
    changeRequest = '',
    confirmationMessageId = '',
    status,
  },
) => {
  await ensurePiSummarySchema(pool)
  await pool.query(
    `
      UPDATE ${INCOMING_MESSAGE_TABLE_NAME}
      SET
        customer_confirmation_status = $2::varchar,
        customer_confirmation_at = CURRENT_TIMESTAMP,
        customer_confirmation_message_id = $3::varchar,
        customer_change_request = CASE
          WHEN $2::varchar = 'CHANGE_REQUESTED' THEN $4::text
          ELSE customer_change_request
        END,
        reply_status = $2::varchar,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
    `,
    [toText(sourceMessageId), status, toText(confirmationMessageId), changeRequest || null],
  )
}

const getSourceMessageByDraftPI = async ({ pi, pool } = {}) =>
  getSourceMessageForPI({
    piNumber: pi?.piNumber,
    pool,
    sourceMessageId: '',
  })

const handleCustomerConfirmationReply = async ({
  dryRun = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  messageId = '',
  piNumber = '',
  pool,
  replyText = '',
  sendResponse = false,
  senderPhone = '',
  tableNames = {},
} = {}) => {
  let parsed

  try {
    parsed = parseCustomerConfirmationReply(replyText, piNumber)

    logOutgoingPipeline('Handler entered', {
      command: parsed.command ?? '',
      currentFunction: 'handleCustomerConfirmationReply',
      messageId,
      messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
      piNumber: parsed.piNumber || piNumber,
      senderPhone,
    })

    if (!parsed.handled) {
      return parsed
    }

    const targetPiNumber = parsed.piNumber || toText(piNumber).toUpperCase()
    let pi = null
    const errors = []
    let sourceMessage = null
    let finalStatus = parsed.status

    if (!targetPiNumber) {
      errors.push('Draft PI number is required in the reply.')
      finalStatus = CUSTOMER_CONFIRMATION_STATUSES.INVALID_RESPONSE
    } else {
      logOutgoingPipeline('Original PI lookup started', {
        currentFunction: 'handleCustomerConfirmationReply',
        messageId,
        messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
        piNumber: targetPiNumber,
        senderPhone,
      })
      pi = await loadDraftPIForSummary({ piNumber: targetPiNumber, pool, tableNames })
      logOutgoingPipeline(pi ? 'Original PI found' : 'Original PI not found', {
        currentFunction: 'handleCustomerConfirmationReply',
        isDraft: Boolean(pi?.isDraft),
        messageId,
        messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
        piNumber: targetPiNumber,
        senderPhone,
      })
    }

    if (targetPiNumber && !pi) {
      errors.push(`Draft PI ${targetPiNumber} was not found.`)
      finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
    } else if (pi) {
      sourceMessage = await getSourceMessageByDraftPI({ pi, pool })
      logOutgoingPipeline(sourceMessage ? 'Original source row found' : 'Original source row not found', {
        currentFunction: 'handleCustomerConfirmationReply',
        messageId,
        messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
        piNumber: targetPiNumber,
        sourceMessageId: sourceMessage?.message_id ?? '',
      })

      if (!sourceMessage) {
        errors.push(`Source WhatsApp message for Draft PI ${targetPiNumber} was not found.`)
        finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
      } else {
        const senderMatches =
          normalizePhoneDigits(sourceMessage.sender_phone) === normalizePhoneDigits(senderPhone)
        logOutgoingPipeline('Sender comparison', {
          currentFunction: 'handleCustomerConfirmationReply',
          messageId,
          messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
          piNumber: targetPiNumber,
          senderMatches,
        })

        if (!senderMatches) {
          errors.push('Confirmation sender does not match the Draft PI source sender.')
          finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
        } else if (
          finalStatus === CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED &&
          sourceMessage.customer_confirmation_status === CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED
        ) {
          finalStatus = CUSTOMER_CONFIRMATION_STATUSES.ALREADY_CONFIRMED
        }
      }
    }

    if (
      finalStatus === CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED &&
      !toText(parsed.changeRequest)
    ) {
      errors.push('Change request details are required after CHANGE PI number.')
      finalStatus = CUSTOMER_CONFIRMATION_STATUSES.INVALID_RESPONSE
    }

    const responseMessage = buildConfirmationResponseMessage({
      piNumber: targetPiNumber,
      status: finalStatus,
    })
    let sendResult = null

    if (
      !dryRun &&
      sourceMessage &&
      errors.length === 0 &&
      finalStatus !== CUSTOMER_CONFIRMATION_STATUSES.ALREADY_CONFIRMED
    ) {
      await updateCustomerConfirmation(pool, sourceMessage.message_id, {
        changeRequest: parsed.changeRequest,
        confirmationMessageId: messageId,
        status: finalStatus,
      })
      logOutgoingPipeline('Original row update result', {
        currentFunction: 'handleCustomerConfirmationReply',
        messageId,
        messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
        piNumber: targetPiNumber,
        status: finalStatus,
      })
    }

    if (sendResponse && !dryRun && finalStatus !== CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW) {
      const config = getAcknowledgementConfig(env)
      const allowed = isAllowedTesterNumber(senderPhone, config)

      if (config.mode === 'development' && !allowed) {
        sendResult = {
          errorMessage: 'Sender phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.',
          ok: false,
          status: PI_SUMMARY_STATUSES.TEST_NUMBER_NOT_ALLOWED,
        }
      } else {
        sendResult = await sendTextMessage({
          body: responseMessage,
          contextMessageId: messageId,
          env,
          fetchImpl,
          piNumber: targetPiNumber,
          pool,
          purpose:
            finalStatus === CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED
              ? MESSAGE_PURPOSES.CHANGE_REQUEST_ACK
              : MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
          sourceMessageRecordId: sourceMessage?.id,
          sourceWhatsappMessageId: messageId,
          to: senderPhone,
        })
      }

      logOutgoingPipeline('Acknowledgement send result', {
        currentFunction: 'handleCustomerConfirmationReply',
        messageId,
        messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
        metaMessageId: sendResult?.metaMessageId ?? '',
        piNumber: targetPiNumber,
        sendLogId: sendResult?.sendLogId ?? null,
        status: sendResult?.status ?? '',
      })
    }

    return {
      changeRequest: parsed.changeRequest ?? '',
      command: parsed.command ?? '',
      errors,
      handled: true,
      pi,
      piNumber: targetPiNumber,
      responseMessage,
      sendResult,
      sourceMessage,
      status: finalStatus,
    }
  } catch (error) {
    logOutgoingPipeline('Customer confirmation handler failed', {
      currentFunction: 'handleCustomerConfirmationReply',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'UnknownError',
      messageId,
      messagePurpose: MESSAGE_PURPOSES.CUSTOMER_CONFIRMATION_ACK,
      piNumber: parsed?.piNumber || piNumber,
      sqlstate: error?.code ?? '',
      stack: error instanceof Error ? error.stack : '',
    })
    throw error
  }
}

export {
  CUSTOMER_CONFIRMATION_STATUSES,
  PI_SUMMARY_STATUSES,
  buildConfirmationResponseMessage,
  buildPiSummaryMessage,
  detectCustomerCommand,
  ensurePiSummarySchema,
  formatIndianCurrency,
  handleCustomerConfirmationReply,
  loadDraftPIForSummary,
  parseCustomerConfirmationReply,
  sendPiSummary,
  sendPiSummaryForMessage,
}

import {
  getAcknowledgementConfig,
  isAllowedTesterNumber,
  normalizePhoneDigits,
  sendTextMessage,
} from './whatsappAckService.js'

const INCOMING_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'

const PI_SUMMARY_STATUSES = {
  DISABLED: 'DISABLED',
  DUPLICATE_SKIPPED: 'DUPLICATE_SKIPPED',
  FAILED: 'FAILED',
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  TEST_NUMBER_NOT_ALLOWED: 'TEST_NUMBER_NOT_ALLOWED',
}

const CUSTOMER_CONFIRMATION_STATUSES = {
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  CHANGE_REQUESTED: 'CHANGE_REQUESTED',
  CONFIRMED: 'CONFIRMED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  NOT_CONFIRMATION: 'NOT_CONFIRMATION',
}

const toText = (value) => String(value ?? '').trim()

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
    return {
      errorMessage: 'Draft PI summary sending is disabled.',
      status: PI_SUMMARY_STATUSES.DISABLED,
    }
  }

  if (!pi) {
    return {
      errorMessage: 'Draft PI was not found.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (!pi.isDraft) {
    return {
      errorMessage: 'Only Draft PI summaries can be sent.',
      status: PI_SUMMARY_STATUSES.NOT_REQUIRED,
    }
  }

  if (!sourceMessage) {
    return {
      errorMessage: 'Source WhatsApp message was not found for this Draft PI.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (sourceMessage.acknowledgement_status !== 'SENT') {
    return {
      errorMessage: 'Automatic acknowledgement must be sent before Draft PI summary.',
      status: PI_SUMMARY_STATUSES.NOT_REQUIRED,
    }
  }

  if (
    sourceMessage.pi_summary_status === PI_SUMMARY_STATUSES.SENT ||
    sourceMessage.pi_summary_meta_message_id
  ) {
    return {
      errorMessage: 'Draft PI summary was already sent.',
      status: PI_SUMMARY_STATUSES.DUPLICATE_SKIPPED,
    }
  }

  if (!normalizePhoneDigits(senderPhone)) {
    return {
      errorMessage: 'Sender phone is required.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (toNumberValue(pi.grandTotal) <= 0) {
    return {
      errorMessage: 'Grand total is missing or zero.',
      status: PI_SUMMARY_STATUSES.FAILED,
    }
  }

  if (config.whatsapp.mode === 'development' && !isAllowedTesterNumber(senderPhone, config.whatsapp)) {
    return {
      errorMessage: 'Sender phone is not in WHATSAPP_ALLOWED_TEST_NUMBERS.',
      status: PI_SUMMARY_STATUSES.TEST_NUMBER_NOT_ALLOWED,
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

  if (precondition.status) {
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
  const sendResult = await sendTextMessage({
    body: messageBody,
    contextMessageId: sourceId,
    env,
    fetchImpl,
    to: senderPhone,
  })
  const sentAt = sendResult.ok ? new Date().toISOString() : null
  const status = sendResult.ok ? PI_SUMMARY_STATUSES.SENT : PI_SUMMARY_STATUSES.FAILED

  await updatePiSummaryStatus(pool, sourceId, {
    error: sendResult.errorMessage ?? null,
    message: messageBody,
    metaMessageId: sendResult.metaMessageId ?? null,
    sentAt,
    status,
  })

  return {
    errorCode: sendResult.errorCode ?? '',
    errorMessage: sendResult.errorMessage ?? '',
    messageBody,
    metaMessageId: sendResult.metaMessageId ?? '',
    metaResponse: sendResult.metaResponse ?? null,
    ok: sendResult.ok,
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

const parseCustomerConfirmationReply = (text, fallbackPiNumber = '') => {
  const normalized = toText(text)
  const commandMatch = normalized.match(/^(CONFIRM|CHANGE)\s+([A-Z0-9/-]*\d+)\b([\s\S]*)$/i)

  if (commandMatch) {
    return {
      changeRequest: toText(commandMatch[3]),
      command: commandMatch[1].toUpperCase(),
      handled: true,
      piNumber: commandMatch[2].toUpperCase(),
      status:
        commandMatch[1].toUpperCase() === 'CONFIRM'
          ? CUSTOMER_CONFIRMATION_STATUSES.CONFIRMED
          : CUSTOMER_CONFIRMATION_STATUSES.CHANGE_REQUESTED,
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
        customer_confirmation_status = $2,
        customer_confirmation_at = CURRENT_TIMESTAMP,
        customer_confirmation_message_id = $3,
        customer_change_request = CASE
          WHEN $2 = 'CHANGE_REQUESTED' THEN $4
          ELSE customer_change_request
        END,
        reply_status = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1
    `,
    [toText(sourceMessageId), status, toText(confirmationMessageId), changeRequest || null],
  )
}

const getSourceMessageByDraftPI = async ({ pi, pool } = {}) =>
  getSourceMessageForPI({
    piNumber: pi?.piNumber,
    pool,
    sourceMessageId: pi?.poNo,
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
  const parsed = parseCustomerConfirmationReply(replyText, piNumber)

  if (!parsed.handled) {
    return parsed
  }

  const targetPiNumber = parsed.piNumber || toText(piNumber).toUpperCase()
  const pi = targetPiNumber
    ? await loadDraftPIForSummary({ piNumber: targetPiNumber, pool, tableNames })
    : null
  const errors = []
  let sourceMessage = null
  let finalStatus = parsed.status

  if (!targetPiNumber) {
    errors.push('Draft PI number is required in the reply.')
    finalStatus = CUSTOMER_CONFIRMATION_STATUSES.INVALID_RESPONSE
  } else if (!pi) {
    errors.push(`Draft PI ${targetPiNumber} was not found.`)
    finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
  } else {
    sourceMessage = await getSourceMessageByDraftPI({ pi, pool })

    if (!sourceMessage) {
      errors.push(`Source WhatsApp message for Draft PI ${targetPiNumber} was not found.`)
      finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
    } else if (
      normalizePhoneDigits(sourceMessage.sender_phone) !== normalizePhoneDigits(senderPhone)
    ) {
      errors.push('Confirmation sender does not match the Draft PI source sender.')
      finalStatus = CUSTOMER_CONFIRMATION_STATUSES.MANUAL_REVIEW
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

  if (!dryRun && sourceMessage && errors.length === 0) {
    await updateCustomerConfirmation(pool, sourceMessage.message_id, {
      changeRequest: parsed.changeRequest,
      confirmationMessageId: messageId,
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
        to: senderPhone,
      })
    }
  }

  return {
    changeRequest: parsed.changeRequest ?? '',
    errors,
    handled: true,
    pi,
    piNumber: targetPiNumber,
    responseMessage,
    sendResult,
    sourceMessage,
    status: finalStatus,
  }
}

export {
  CUSTOMER_CONFIRMATION_STATUSES,
  PI_SUMMARY_STATUSES,
  buildConfirmationResponseMessage,
  buildPiSummaryMessage,
  ensurePiSummarySchema,
  formatIndianCurrency,
  handleCustomerConfirmationReply,
  loadDraftPIForSummary,
  parseCustomerConfirmationReply,
  sendPiSummary,
  sendPiSummaryForMessage,
}

import { sendPiSummaryForMessage } from './piSummaryService.js'
import {
  MESSAGE_PURPOSES,
  applyWhatsAppSendResultToSource,
  claimRetryJobs,
  ensureWhatsAppSendLogSchema,
  getIncomingSourceForSendLog,
  getWhatsAppRetryPolicy,
  recoverStaleSendAttempts,
  sendLoggedWhatsAppTextMessage,
} from './whatsappSendService.js'
import { logWhatsAppOutgoingTrace } from './whatsappOutgoingTrace.js'

const toText = (value) => String(value ?? '').trim()

const toBooleanEnv = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y'].includes(toText(value).toLowerCase())
}

const getWorkerIntervalMs = (env = process.env) =>
  Math.max(Number(env.WHATSAPP_SEND_RETRY_WORKER_INTERVAL_MS ?? 10000) || 10000, 1000)

const logRetryWorker = (event, details = {}) => {
  logWhatsAppOutgoingTrace(event, {
    currentFile: 'backend/whatsappSendRetryWorker.js',
    currentFunction: details.currentFunction ?? 'whatsappSendRetryWorker',
    ...details,
  })
}

const mapIncomingRecord = (row = {}) => ({
  acknowledgementStatus: row.acknowledgement_status ?? '',
  draftPiNo: row.draft_pi_no ?? '',
  id: Number(row.id ?? 0),
  messageId: row.message_id ?? '',
  parseStatus: row.parse_status ?? '',
  piSummaryMetaMessageId: row.pi_summary_meta_message_id ?? '',
  piSummaryStatus: row.pi_summary_status ?? '',
  processingStatus: row.processing_status ?? row.parse_status ?? '',
  senderPhone: row.sender_phone ?? '',
})

const processRetryJob = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  job,
  pool,
  tableNames = {},
} = {}) => {
  const sourceWhatsappMessageId = toText(job.source_whatsapp_message_id)
  logRetryWorker('Retry started', {
    attemptNumber: Number(job.attempt_number ?? 1),
    currentFunction: 'processRetryJob',
    destinationPhone: job.destination_phone,
    messagePurpose: job.message_purpose,
    piNumber: job.pi_number,
    sendLogId: job.send_log_id,
    sourceWhatsappMessageId,
  })
  const result = await sendLoggedWhatsAppTextMessage({
    attemptNumber: Number(job.attempt_number ?? 1),
    body: job.message_body,
    customerId: job.customer_id,
    destinationPhone: job.destination_phone,
    env,
    existingSendLogId: job.send_log_id,
    fetchImpl,
    messageType: job.message_type || 'text',
    piNumber: job.pi_number,
    pool,
    purpose: job.message_purpose,
    retryBatchId: job.retry_batch_id,
    sourceMessageRecordId: job.source_message_record_id,
    sourceWhatsappMessageId,
    to: job.destination_phone,
  })
  const resultWithPurpose = {
    ...result,
    messagePurpose: job.message_purpose,
  }

  await applyWhatsAppSendResultToSource({
    pool,
    result: resultWithPurpose,
    sourceWhatsappMessageId,
  })

  if (
    job.message_purpose === MESSAGE_PURPOSES.AUTO_ACKNOWLEDGEMENT &&
    result.status === 'SENT' &&
    sourceWhatsappMessageId
  ) {
    const source = await getIncomingSourceForSendLog(pool, sourceWhatsappMessageId)
    const incomingMessageRecord = mapIncomingRecord(source)

    if (
      incomingMessageRecord.draftPiNo &&
      !incomingMessageRecord.piSummaryMetaMessageId &&
      !['SENT', 'DISABLED'].includes(incomingMessageRecord.piSummaryStatus)
    ) {
      await sendPiSummaryForMessage({
        env,
        fetchImpl,
        incomingMessageRecord,
        piNumber: incomingMessageRecord.draftPiNo,
        pool,
        tableNames,
      })
    }
  }

  logRetryWorker('Retry completed', {
    currentFunction: 'processRetryJob',
    destinationPhone: job.destination_phone,
    messagePurpose: job.message_purpose,
    piNumber: job.pi_number,
    sendLogId: job.send_log_id,
    status: result.status,
    sourceWhatsappMessageId,
  })

  return resultWithPurpose
}

const processDueWhatsAppRetries = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  limit = 5,
  pool,
  tableNames = {},
} = {}) => {
  await ensureWhatsAppSendLogSchema(pool)
  await recoverStaleSendAttempts({ env, pool })
  const jobs = await claimRetryJobs({ limit, pool })
  const results = []

  for (const job of jobs) {
    try {
      results.push(
        await processRetryJob({
          env,
          fetchImpl,
          job,
          pool,
          tableNames,
        }),
      )
    } catch (error) {
      console.error('AUTOPAL WhatsApp retry job failed', {
        error: error instanceof Error ? error.message : String(error),
        sendLogId: job.send_log_id,
      })
      results.push({
        errorMessage: error instanceof Error ? error.message : String(error),
        ok: false,
        sendLogId: Number(job.send_log_id ?? 0),
        status: 'FAILED',
      })
    }
  }

  return {
    processed: jobs.length,
    results,
  }
}

const startWhatsAppSendRetryWorker = ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  pool,
  tableNames = {},
} = {}) => {
  const policy = getWhatsAppRetryPolicy(env)

  if (!policy.enabled || !toBooleanEnv(env.WHATSAPP_SEND_RETRY_ENABLED, true)) {
    return {
      enabled: false,
      stop: () => {},
    }
  }

  let running = false
  const runOnce = async () => {
    if (running) {
      return
    }

    running = true
    try {
      await processDueWhatsAppRetries({
        env,
        fetchImpl,
        pool,
        tableNames,
      })
    } catch (error) {
      console.error('AUTOPAL WhatsApp retry worker failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  const interval = setInterval(runOnce, getWorkerIntervalMs(env))

  if (typeof interval.unref === 'function') {
    interval.unref()
  }

  setImmediate(runOnce)

  return {
    enabled: true,
    stop: () => clearInterval(interval),
  }
}

export {
  processDueWhatsAppRetries,
  processRetryJob,
  startWhatsAppSendRetryWorker,
}

const TRACE_SCOPE = 'whatsapp-outgoing-trace'

const redactString = (value) =>
  String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/EA[A-Za-z0-9._-]{12,}/g, '[REDACTED]')

const sanitizeTraceValue = (value, depth = 0) => {
  if (value === null || value === undefined) {
    return value
  }

  if (depth > 5) {
    return '[TRUNCATED]'
  }

  if (typeof value === 'string') {
    return redactString(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeTraceValue(item, depth + 1))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        /token|secret|authorization|cookie/i.test(key)
          ? '[REDACTED]'
          : sanitizeTraceValue(nestedValue, depth + 1),
      ]),
    )
  }

  return redactString(value)
}

const normalizeTraceDetails = (details = {}) => {
  const normalized = {
    currentFile: details.currentFile ?? '',
    currentFunction: details.currentFunction ?? details.functionName ?? '',
    messagePurpose: details.messagePurpose ?? '',
    senderPhone: details.senderPhone ?? '',
    destinationPhone: details.destinationPhone ?? '',
    piNumber: details.piNumber ?? '',
    messageId: details.messageId ?? details.sourceWhatsappMessageId ?? '',
    sharedSenderCalled: details.sharedSenderCalled ?? false,
    sendLogInsertStarts: details.sendLogInsertStarts ?? false,
    sendLogInsertSucceeds: details.sendLogInsertSucceeds ?? false,
    metaApiCalled: details.metaApiCalled ?? false,
    metaApiReturned: details.metaApiReturned ?? false,
    acknowledgementStatusUpdated: details.acknowledgementStatusUpdated ?? false,
    piSummaryStatusUpdated: details.piSummaryStatusUpdated ?? false,
  }

  return {
    ...normalized,
    ...sanitizeTraceValue(details),
  }
}

const logWhatsAppOutgoingTrace = (step, details = {}) => {
  console.log(
    JSON.stringify({
      scope: TRACE_SCOPE,
      step,
      timestamp: new Date().toISOString(),
      ...normalizeTraceDetails(details),
    }),
  )
}

const logWhatsAppOutgoingEarlyReturn = (details = {}) => {
  logWhatsAppOutgoingTrace('EARLY RETURN', {
    earlyReturn: true,
    ...details,
  })
}

export {
  logWhatsAppOutgoingEarlyReturn,
  logWhatsAppOutgoingTrace,
}

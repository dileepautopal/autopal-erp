import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/ui/Button'
import { TextareaField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import type { ScreenId } from '../types'

type WhatsAppPIConnectProps = {
  onImported: () => Promise<void> | void
  onNavigate: (screen: ScreenId) => void
}

type WhatsAppStatus = {
  accessTokenConfigured: boolean
  graphApiBase: string
  imageExtractorConfigured: boolean
  ok: boolean
  verifyTokenConfigured: boolean
}

type ParsedItem = {
  lineNumber: number
  model: string
  quantity: number
  size: string
  unit: string
  voltage: string
}

type ParsedMessage = {
  date: string
  ignoredLines: Array<{ lineNumber: number; text: string }>
  items: ParsedItem[]
  partyName: string
  place: string
  warnings: string[]
}

type ImportResult = {
  duplicate?: boolean
  inserted: boolean
  parsed?: ParsedMessage
  pi?: {
    grandTotal?: number
    id?: string
    piNumber?: string
    prospectiveCustomerName?: string
  }
  warnings?: string[]
}

type IncomingWhatsappMessage = {
  confidenceScore?: number
  errorDetails?: { errors?: string[] } | null
  id: number
  importStatus: string
  mediaPath?: string
  messageId: string
  messageText: string
  messageType: string
  ocrText?: string
  parseErrors?: string[]
  parseStatus?: string
  parseWarnings?: string[]
  processingStatus?: string
  processingText?: string
  productCount?: number
  rawText?: string
  receivedAt: string
  senderName: string
  senderPhone: string
  updatedAt?: string
}

type SendMonitorSummary = {
  health?: {
    color?: string
    lastFailedSend?: string | null
    lastFailureCategory?: string
    lastSuccessfulSend?: string | null
    oldestPendingRetryAt?: string | null
    pendingRetryCount?: number
  }
  summary?: {
    metaApiFailures?: number
    networkFailures?: number
    pending?: number
    permanentlyFailed?: number
    retryScheduled?: number
    retrying?: number
    sentToday?: number
    testNumberBlocked?: number
    tokenExpired?: number
  }
}

type SendLog = {
  attemptNumber: number
  attemptStatus: string
  createdAt?: string
  destinationPhone?: string
  durationMs?: number | null
  failureCategory?: string
  httpStatus?: number | null
  messageBody?: string
  messagePurpose?: string
  metaErrorMessage?: string
  metaMessageId?: string
  metaResponse?: unknown
  networkErrorMessage?: string
  nextRetryAt?: string | null
  piNumber?: string
  requestPayload?: unknown
  requestStartedAt?: string | null
  retryable?: boolean
  sendLogId: number
  sourceWhatsappMessageId?: string
}

type SendTimelineEntry = {
  detail?: unknown
  status?: string
  timestamp?: string
  title?: string
}

type SendLogFilters = {
  attemptStatus: string
  destinationPhone: string
  endDate: string
  failureCategory: string
  messagePurpose: string
  metaMessageId: string
  piNumber: string
  retryable: string
  sourceMessageId: string
  startDate: string
}

type APIErrorBody = {
  detail?: string
  errors?: string[]
  message?: string
}

const STATUS_API_URL = apiUrl('/api/whatsapp-pi/status')
const PARSE_API_URL = apiUrl('/api/whatsapp-pi/parse-text')
const IMPORT_API_URL = apiUrl('/api/whatsapp-pi/import-text')
const MESSAGES_API_URL = apiUrl('/api/whatsapp-pi/messages?limit=10')
const SEND_MONITOR_SUMMARY_API_URL = apiUrl('/api/whatsapp-pi/send-monitor/summary')
const SEND_MONITOR_LOGS_API_URL = apiUrl('/api/whatsapp-pi/send-monitor/logs')
const reprocessMessageApiUrl = (messageId: string) =>
  apiUrl(`/api/whatsapp-pi/messages/${encodeURIComponent(messageId)}/reprocess`)
const sendMonitorActionApiUrl = (sendLogId: number, action: string) =>
  apiUrl(`/api/whatsapp-pi/send-monitor/${encodeURIComponent(sendLogId)}/${action}`)
const messageTimelineApiUrl = (messageId: string) =>
  apiUrl(`/api/whatsapp-pi/messages/${encodeURIComponent(messageId)}/timeline`)

const sampleMessage = [
  'Date: 20/06/2026',
  'M/s Milan Automobiles',
  'Belgaum',
  '100/90 - 12V - PU37 - 500 NOS',
  '130/100 - 12V PU37 - 200 NOS',
  '130/100 - 24V PU37 - 100 NOS',
].join('\n')

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as APIErrorBody

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.join(' ')
    }

    return body.detail || body.message || `Request failed with status ${response.status}`
  } catch {
    return `Request failed with status ${response.status}`
  }
}

const formatMoney = (value: number | undefined) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    style: 'currency',
  }).format(Number(value ?? 0))

const formatIncomingMessageTime = (value: string) => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(date)
}

const formatDateTime = (value?: string | null) =>
  value ? formatIncomingMessageTime(value) || value : '-'

const formatJsonPreview = (value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return 'No data'
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const defaultSendLogFilters: SendLogFilters = {
  attemptStatus: '',
  destinationPhone: '',
  endDate: '',
  failureCategory: '',
  messagePurpose: '',
  metaMessageId: '',
  piNumber: '',
  retryable: '',
  sourceMessageId: '',
  startDate: '',
}

const getIncomingMessageErrorText = (message: IncomingWhatsappMessage) => {
  if (message.parseErrors && message.parseErrors.length > 0) {
    return message.parseErrors.join(' ')
  }

  if (message.errorDetails?.errors && message.errorDetails.errors.length > 0) {
    return message.errorDetails.errors.join(' ')
  }

  if (message.parseWarnings && message.parseWarnings.length > 0) {
    return message.parseWarnings.join(' ')
  }

  return ''
}

export function WhatsAppPIConnect({
  onImported,
  onNavigate,
}: WhatsAppPIConnectProps) {
  const [messageText, setMessageText] = useState(sampleMessage)
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [parsedMessage, setParsedMessage] = useState<ParsedMessage | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [notice, setNotice] = useState('')
  const [noticeType, setNoticeType] = useState<'error' | 'success'>('success')
  const [isParsing, setIsParsing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [latestIncomingMessage, setLatestIncomingMessage] =
    useState<IncomingWhatsappMessage | null>(null)
  const [incomingMessages, setIncomingMessages] = useState<IncomingWhatsappMessage[]>([])
  const [reprocessingMessageId, setReprocessingMessageId] = useState('')
  const [sendMonitor, setSendMonitor] = useState<SendMonitorSummary | null>(null)
  const [sendLogs, setSendLogs] = useState<SendLog[]>([])
  const [sendLogFilters, setSendLogFilters] =
    useState<SendLogFilters>(defaultSendLogFilters)
  const [selectedSendLog, setSelectedSendLog] = useState<SendLog | null>(null)
  const [timelineMessageId, setTimelineMessageId] = useState('')
  const [timelineEntries, setTimelineEntries] = useState<SendTimelineEntry[]>([])
  const [isLoadingSendMonitor, setIsLoadingSendMonitor] = useState(false)
  const [sendMonitorError, setSendMonitorError] = useState('')
  const [sendActionLogId, setSendActionLogId] = useState<number | null>(null)
  const latestIncomingMessageKeyRef = useRef('')

  const loadSendMonitor = useCallback(async () => {
    setIsLoadingSendMonitor(true)
    setSendMonitorError('')

    try {
      const params = new URLSearchParams()
      Object.entries(sendLogFilters).forEach(([key, value]) => {
        if (value) {
          params.set(key, value)
        }
      })
      params.set('limit', '25')

      const [summaryResponse, logsResponse] = await Promise.all([
        fetch(SEND_MONITOR_SUMMARY_API_URL),
        fetch(`${SEND_MONITOR_LOGS_API_URL}?${params.toString()}`),
      ])

      if (!summaryResponse.ok) {
        throw new Error(await getApiErrorMessage(summaryResponse))
      }

      if (!logsResponse.ok) {
        throw new Error(await getApiErrorMessage(logsResponse))
      }

      setSendMonitor((await summaryResponse.json()) as SendMonitorSummary)
      const logsBody = (await logsResponse.json()) as { logs?: SendLog[] }
      setSendLogs(logsBody.logs ?? [])
    } catch (error) {
      setSendMonitorError(
        error instanceof Error ? error.message : 'Unable to load WhatsApp send monitor',
      )
    } finally {
      setIsLoadingSendMonitor(false)
    }
  }, [sendLogFilters])

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const response = await fetch(STATUS_API_URL)

        if (!response.ok) {
          return
        }

        setStatus((await response.json()) as WhatsAppStatus)
      } catch {
        setStatus(null)
      }
    }

    void loadStatus()
  }, [])

  useEffect(() => {
    const initialLoadId = window.setTimeout(() => {
      void loadSendMonitor()
    }, 0)
    const intervalId = window.setInterval(() => {
      void loadSendMonitor()
    }, 10000)

    return () => {
      window.clearInterval(intervalId)
      window.clearTimeout(initialLoadId)
    }
  }, [loadSendMonitor])

  useEffect(() => {
    let isActive = true

    const loadLatestMessage = async () => {
      try {
        const response = await fetch(MESSAGES_API_URL)

        if (!response.ok) {
          return
        }

        const body = (await response.json()) as {
          messages?: IncomingWhatsappMessage[]
        }
        const messages = body.messages ?? []
        const latestMessage = messages[0]

        if (!isActive) {
          return
        }

        setIncomingMessages(messages)

        if (!latestMessage) {
          return
        }

        const latestKey = String(
          latestMessage.id ||
            latestMessage.messageId ||
            latestMessage.receivedAt,
        ) + String(latestMessage.updatedAt || '')

        if (!latestKey || latestKey === latestIncomingMessageKeyRef.current) {
          return
        }

        const latestText =
          latestMessage.processingText ||
          latestMessage.messageText ||
          latestMessage.rawText ||
          ''

        latestIncomingMessageKeyRef.current = latestKey
        setLatestIncomingMessage(latestMessage)
        setMessageText(latestText)
        setParsedMessage(null)
        setImportResult(null)
        setNoticeType('success')
        setNotice(
          latestMessage.senderName
            ? `WhatsApp message received from ${latestMessage.senderName}`
            : 'WhatsApp message received',
        )
      } catch {
        // Keep the current message if polling fails.
      }
    }

    void loadLatestMessage()
    const intervalId = window.setInterval(() => {
      void loadLatestMessage()
    }, 5000)

    return () => {
      isActive = false
      window.clearInterval(intervalId)
    }
  }, [])

  const webhookUrl = useMemo(() => {
    return apiUrl('/api/whatsapp-pi/webhook')
  }, [])

  const parseMessage = async () => {
    setIsParsing(true)
    setNotice('')
    setNoticeType('success')
    setImportResult(null)

    try {
      const response = await fetch(PARSE_API_URL, {
        body: JSON.stringify({ text: messageText }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const body = (await response.json()) as { parsed: ParsedMessage }
      setParsedMessage(body.parsed)
      setNoticeType('success')
      setNotice('Message parsed')
    } catch (error) {
      setNoticeType('error')
      setNotice(error instanceof Error ? error.message : 'Unable to parse message')
      setParsedMessage(null)
    } finally {
      setIsParsing(false)
    }
  }

  const reprocessMessage = async (messageId: string) => {
    setReprocessingMessageId(messageId)
    setNotice('')
    setNoticeType('success')

    try {
      const response = await fetch(reprocessMessageApiUrl(messageId), {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const body = (await response.json()) as {
        message?: IncomingWhatsappMessage
      }
      const updatedMessage = body.message

      if (updatedMessage) {
        setIncomingMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.messageId === updatedMessage.messageId ? updatedMessage : message,
          ),
        )
        setLatestIncomingMessage(updatedMessage)
        setMessageText(
          updatedMessage.processingText ||
            updatedMessage.messageText ||
            updatedMessage.rawText ||
            '',
        )
      }

      setNoticeType('success')
      setNotice('Message reprocessed')
    } catch (error) {
      setNoticeType('error')
      setNotice(error instanceof Error ? error.message : 'Unable to reprocess message')
    } finally {
      setReprocessingMessageId('')
    }
  }

  const manualReviewMessages = incomingMessages.filter((message) =>
    ['CUSTOMER_NOT_FOUND', 'FAILED', 'MANUAL_REVIEW', 'PARSE_FAILED', 'PRODUCT_NOT_FOUND'].includes(
      message.processingStatus || message.parseStatus || '',
    ),
  )

  const loadTimeline = async (messageId: string) => {
    if (!messageId) {
      return
    }

    setTimelineMessageId(messageId)

    try {
      const response = await fetch(messageTimelineApiUrl(messageId))

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const body = (await response.json()) as { timeline?: SendTimelineEntry[] }
      setTimelineEntries(body.timeline ?? [])
    } catch (error) {
      setTimelineEntries([
        {
          detail: error instanceof Error ? error.message : 'Unable to load timeline',
          status: 'ERROR',
          title: 'Timeline unavailable',
        },
      ])
    }
  }

  const runSendLogAction = async (sendLogId: number, action: string) => {
    if (action === 'retry-now' && !window.confirm('Retry this WhatsApp send now?')) {
      return
    }

    setSendActionLogId(sendLogId)
    setSendMonitorError('')

    try {
      const response = await fetch(sendMonitorActionApiUrl(sendLogId, action), {
        body: JSON.stringify(action === 'retry-now' ? { confirm: true } : {}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      await loadSendMonitor()
      setNoticeType('success')
      setNotice('WhatsApp send monitor updated')
    } catch (error) {
      setSendMonitorError(
        error instanceof Error ? error.message : 'Unable to update send log',
      )
    } finally {
      setSendActionLogId(null)
    }
  }

  const importMessage = async () => {
    setIsImporting(true)
    setNotice('')
    setNoticeType('success')

    try {
      const response = await fetch(IMPORT_API_URL, {
        body: JSON.stringify({ text: messageText }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const body = (await response.json()) as ImportResult
      setImportResult(body)

      if (body.parsed) {
        setParsedMessage(body.parsed)
      }

      setNotice(body.duplicate ? 'Message already imported' : 'PI imported')
      setNoticeType('success')
      await onImported()
    } catch (error) {
      setNoticeType('error')
      setNotice(error instanceof Error ? error.message : 'Unable to import PI')
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div className="page whatsapp-pi-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">WhatsApp</p>
          <h1>WhatsApp Connect</h1>
          <p className="page-subtitle">
            Convert incoming WhatsApp PI messages into R.Market PI records.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">
            {status?.verifyTokenConfigured ? 'Webhook token set' : 'Webhook token pending'}
          </span>
          <Button onClick={() => onNavigate('pi-preview')} variant="secondary">
            PI List
          </Button>
        </div>
      </header>

      <section className="summary-strip whatsapp-status-strip">
        <div>
          <span>Webhook</span>
          <strong>{status?.verifyTokenConfigured ? 'Ready' : 'Pending'}</strong>
        </div>
        <div>
          <span>Media API</span>
          <strong>{status?.accessTokenConfigured ? 'Ready' : 'Pending'}</strong>
        </div>
        <div>
          <span>OCR</span>
          <strong>{status?.imageExtractorConfigured ? 'Ready' : 'Optional'}</strong>
        </div>
        <div>
          <span>Graph API</span>
          <strong>{status?.graphApiBase ? 'Configured' : 'Default'}</strong>
        </div>
      </section>

      <section className="panel whatsapp-webhook-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Webhook URL</p>
            <h2>WhatsApp Cloud API</h2>
          </div>
        </div>
        <div className="webhook-url-box">{webhookUrl}</div>
      </section>

      <section className="whatsapp-import-layout">
        <div className="panel whatsapp-compose-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Message</p>
              <h2>Incoming PI Text</h2>
            </div>
            <div className="header-actions">
              {latestIncomingMessage ? (
                <span className="status-pill">
                  {formatIncomingMessageTime(latestIncomingMessage.receivedAt) ||
                    'Received'}
                </span>
              ) : null}
              <Button disabled={isParsing || isImporting} onClick={parseMessage} variant="ghost">
                {isParsing ? 'Parsing' : 'Parse'}
              </Button>
              <Button disabled={isParsing || isImporting} onClick={importMessage}>
                {isImporting ? 'Importing' : 'Import PI'}
              </Button>
            </div>
          </div>
          <TextareaField
            className="whatsapp-message-input"
            label="WhatsApp Message"
            onChange={(event) => setMessageText(event.target.value)}
            value={messageText}
          />
          {notice ? (
            <div className={`login-message ${noticeType === 'success' ? 'success' : ''}`}>
              {notice}
            </div>
          ) : null}
        </div>

        <div className="panel whatsapp-result-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Result</p>
              <h2>Parsed Details</h2>
            </div>
          </div>

          {parsedMessage ? (
            <div className="whatsapp-result-stack">
              <div className="whatsapp-detail-grid">
                <div>
                  <span>Date</span>
                  <strong>{parsedMessage.date || 'Pending'}</strong>
                </div>
                <div>
                  <span>Customer</span>
                  <strong>{parsedMessage.partyName || 'Pending'}</strong>
                </div>
                <div>
                  <span>Place</span>
                  <strong>{parsedMessage.place || 'Pending'}</strong>
                </div>
              </div>

              {parsedMessage.warnings.length > 0 ? (
                <div className="login-message">
                  {parsedMessage.warnings.join(' ')}
                </div>
              ) : null}

              <div className="responsive-table">
                <table className="master-table whatsapp-item-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Size</th>
                      <th>Volt</th>
                      <th>Model</th>
                      <th>Qty</th>
                      <th>Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedMessage.items.map((item) => (
                      <tr key={`${item.lineNumber}-${item.size}-${item.voltage}`}>
                        <td>{item.lineNumber}</td>
                        <td>{item.size}</td>
                        <td>{item.voltage}</td>
                        <td>{item.model}</td>
                        <td>{item.quantity}</td>
                        <td>{item.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="empty-state whatsapp-empty-state">
              <h2>No parsed message</h2>
            </div>
          )}
        </div>
      </section>

      {importResult?.pi ? (
        <section className="panel whatsapp-created-pi">
          <div>
            <span>Created PI</span>
            <strong>{importResult.pi.piNumber || importResult.pi.id}</strong>
            <p>{importResult.pi.prospectiveCustomerName}</p>
          </div>
          <div>
            <span>Total</span>
            <strong>{formatMoney(importResult.pi.grandTotal)}</strong>
          </div>
        </section>
      ) : null}

      <section className="panel whatsapp-send-monitor-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Reliability</p>
            <h2>WhatsApp Send Monitor</h2>
          </div>
          <div className="header-actions">
            <span className={`status-pill health-${sendMonitor?.health?.color || 'GREEN'}`}>
              Health {sendMonitor?.health?.color || 'GREEN'}
            </span>
            <Button
              disabled={isLoadingSendMonitor}
              onClick={() => void loadSendMonitor()}
              variant="secondary"
            >
              {isLoadingSendMonitor ? 'Refreshing' : 'Refresh'}
            </Button>
          </div>
        </div>

        {sendMonitorError ? (
          <div className="login-message">{sendMonitorError}</div>
        ) : null}

        <div className="summary-strip whatsapp-send-summary-strip">
          <div>
            <span>Sent Today</span>
            <strong>{sendMonitor?.summary?.sentToday ?? 0}</strong>
          </div>
          <div>
            <span>Pending</span>
            <strong>{sendMonitor?.summary?.pending ?? 0}</strong>
          </div>
          <div>
            <span>Retry Scheduled</span>
            <strong>{sendMonitor?.summary?.retryScheduled ?? 0}</strong>
          </div>
          <div>
            <span>Retrying</span>
            <strong>{sendMonitor?.summary?.retrying ?? 0}</strong>
          </div>
          <div>
            <span>Permanent Failed</span>
            <strong>{sendMonitor?.summary?.permanentlyFailed ?? 0}</strong>
          </div>
          <div>
            <span>Token Expired</span>
            <strong>{sendMonitor?.summary?.tokenExpired ?? 0}</strong>
          </div>
          <div>
            <span>Test Blocked</span>
            <strong>{sendMonitor?.summary?.testNumberBlocked ?? 0}</strong>
          </div>
          <div>
            <span>Network Failures</span>
            <strong>{sendMonitor?.summary?.networkFailures ?? 0}</strong>
          </div>
          <div>
            <span>Meta Failures</span>
            <strong>{sendMonitor?.summary?.metaApiFailures ?? 0}</strong>
          </div>
        </div>

        <div className="whatsapp-send-health-grid">
          <div>
            <span>Last successful send</span>
            <strong>{formatDateTime(sendMonitor?.health?.lastSuccessfulSend)}</strong>
          </div>
          <div>
            <span>Last failed send</span>
            <strong>{formatDateTime(sendMonitor?.health?.lastFailedSend)}</strong>
          </div>
          <div>
            <span>Last failure</span>
            <strong>{sendMonitor?.health?.lastFailureCategory || '-'}</strong>
          </div>
          <div>
            <span>Oldest pending retry</span>
            <strong>{formatDateTime(sendMonitor?.health?.oldestPendingRetryAt)}</strong>
          </div>
        </div>

        <div className="whatsapp-send-filter-grid">
          {[
            ['startDate', 'Start Date', 'date'],
            ['endDate', 'End Date', 'date'],
            ['destinationPhone', 'Destination', 'text'],
            ['piNumber', 'PI Number', 'text'],
            ['sourceMessageId', 'Source Message', 'text'],
            ['metaMessageId', 'Meta Message ID', 'text'],
          ].map(([key, label, type]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                onChange={(event) =>
                  setSendLogFilters((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                type={type}
                value={sendLogFilters[key as keyof SendLogFilters]}
              />
            </label>
          ))}
          <label>
            <span>Purpose</span>
            <select
              onChange={(event) =>
                setSendLogFilters((current) => ({
                  ...current,
                  messagePurpose: event.target.value,
                }))
              }
              value={sendLogFilters.messagePurpose}
            >
              <option value="">All</option>
              <option value="AUTO_ACKNOWLEDGEMENT">Auto ACK</option>
              <option value="PI_SUMMARY">PI Summary</option>
              <option value="CUSTOMER_CONFIRMATION_ACK">Confirmation ACK</option>
              <option value="CHANGE_REQUEST_ACK">Change ACK</option>
              <option value="MANUAL_TEST">Manual Test</option>
            </select>
          </label>
          <label>
            <span>Status</span>
            <select
              onChange={(event) =>
                setSendLogFilters((current) => ({
                  ...current,
                  attemptStatus: event.target.value,
                }))
              }
              value={sendLogFilters.attemptStatus}
            >
              <option value="">All</option>
              <option value="SENT">Sent</option>
              <option value="FAILED">Failed</option>
              <option value="RETRY_SCHEDULED">Retry Scheduled</option>
              <option value="RETRYING">Retrying</option>
              <option value="PERMANENTLY_FAILED">Permanently Failed</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="MANUAL_REVIEW">Manual Review</option>
            </select>
          </label>
          <label>
            <span>Failure</span>
            <input
              onChange={(event) =>
                setSendLogFilters((current) => ({
                  ...current,
                  failureCategory: event.target.value,
                }))
              }
              placeholder="NETWORK_TIMEOUT"
              value={sendLogFilters.failureCategory}
            />
          </label>
          <label>
            <span>Retryable</span>
            <select
              onChange={(event) =>
                setSendLogFilters((current) => ({
                  ...current,
                  retryable: event.target.value,
                }))
              }
              value={sendLogFilters.retryable}
            >
              <option value="">All</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <div className="whatsapp-send-filter-actions">
            <Button onClick={() => void loadSendMonitor()} variant="secondary">
              Apply
            </Button>
            <Button
              onClick={() => setSendLogFilters(defaultSendLogFilters)}
              variant="ghost"
            >
              Clear
            </Button>
          </div>
        </div>

        {sendLogs.length > 0 ? (
          <div className="responsive-table">
            <table className="master-table whatsapp-send-log-table">
              <thead>
                <tr>
                  <th>Send Log ID</th>
                  <th>Purpose</th>
                  <th>PI Number</th>
                  <th>Destination</th>
                  <th>Attempt</th>
                  <th>Status</th>
                  <th>Failure Category</th>
                  <th>HTTP</th>
                  <th>Meta Message ID</th>
                  <th>Error</th>
                  <th>Started At</th>
                  <th>Duration</th>
                  <th>Next Retry At</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sendLogs.map((log) => (
                  <tr key={log.sendLogId}>
                    <td>{log.sendLogId}</td>
                    <td>{log.messagePurpose || '-'}</td>
                    <td>{log.piNumber || '-'}</td>
                    <td>{log.destinationPhone || '-'}</td>
                    <td>{log.attemptNumber}</td>
                    <td>{log.attemptStatus || '-'}</td>
                    <td>{log.failureCategory || '-'}</td>
                    <td>{log.httpStatus ?? '-'}</td>
                    <td>{log.metaMessageId || '-'}</td>
                    <td>{log.metaErrorMessage || log.networkErrorMessage || '-'}</td>
                    <td>{formatDateTime(log.requestStartedAt)}</td>
                    <td>{log.durationMs === null || log.durationMs === undefined ? '-' : `${log.durationMs} ms`}</td>
                    <td>{formatDateTime(log.nextRetryAt)}</td>
                    <td>
                      <div className="whatsapp-send-action-row">
                        <Button onClick={() => setSelectedSendLog(log)} variant="ghost">
                          Details
                        </Button>
                        <Button
                          disabled={sendActionLogId === log.sendLogId || log.attemptStatus === 'SENT'}
                          onClick={() => void runSendLogAction(log.sendLogId, 'retry-now')}
                          variant="secondary"
                        >
                          Retry Now
                        </Button>
                        <Button
                          disabled={sendActionLogId === log.sendLogId || log.attemptStatus !== 'RETRY_SCHEDULED'}
                          onClick={() => void runSendLogAction(log.sendLogId, 'cancel')}
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={sendActionLogId === log.sendLogId || log.attemptStatus === 'SENT'}
                          onClick={() => void runSendLogAction(log.sendLogId, 'manual-review')}
                          variant="ghost"
                        >
                          Manual Review
                        </Button>
                        {log.sourceWhatsappMessageId ? (
                          <Button
                            onClick={() => void loadTimeline(log.sourceWhatsappMessageId || '')}
                            variant="ghost"
                          >
                            Source
                          </Button>
                        ) : null}
                        {log.piNumber ? (
                          <Button onClick={() => onNavigate('pi-preview')} variant="ghost">
                            Open PI
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state whatsapp-empty-state">
            <h2>No WhatsApp send logs</h2>
          </div>
        )}

        {selectedSendLog ? (
          <div className="whatsapp-send-detail-grid">
            <div>
              <div className="section-heading compact">
                <h3>Safe Request</h3>
                <Button onClick={() => setSelectedSendLog(null)} variant="ghost">
                  Close
                </Button>
              </div>
              <pre>{formatJsonPreview(selectedSendLog.requestPayload)}</pre>
            </div>
            <div>
              <div className="section-heading compact">
                <h3>Safe Response</h3>
              </div>
              <pre>{formatJsonPreview(selectedSendLog.metaResponse)}</pre>
            </div>
          </div>
        ) : null}

        {timelineEntries.length > 0 ? (
          <div className="whatsapp-send-timeline">
            <div className="section-heading compact">
              <h3>Source Message Timeline</h3>
              <span className="status-pill">{timelineMessageId}</span>
            </div>
            <ol>
              {timelineEntries.map((entry, index) => (
                <li key={`${entry.title}-${entry.timestamp}-${index}`}>
                  <strong>{entry.title || entry.status || 'Event'}</strong>
                  <span>{formatDateTime(entry.timestamp)}</span>
                  <p>{typeof entry.detail === 'string' ? entry.detail : formatJsonPreview(entry.detail)}</p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>

      <section className="panel whatsapp-manual-review-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Review</p>
            <h2>Manual Review</h2>
          </div>
        </div>

        {manualReviewMessages.length > 0 ? (
          <div className="responsive-table">
            <table className="master-table whatsapp-review-table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Sender</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {manualReviewMessages.map((message) => (
                  <tr key={message.messageId}>
                    <td>{formatIncomingMessageTime(message.receivedAt) || 'Received'}</td>
                    <td>{message.senderName || message.senderPhone || '-'}</td>
                    <td>{message.messageType || '-'}</td>
                    <td>{message.processingStatus || message.parseStatus || '-'}</td>
                    <td>{getIncomingMessageErrorText(message) || '-'}</td>
                    <td>
                      <Button
                        disabled={reprocessingMessageId === message.messageId}
                        onClick={() => void reprocessMessage(message.messageId)}
                        variant="secondary"
                      >
                        {reprocessingMessageId === message.messageId ? 'Reprocessing' : 'Reprocess'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state whatsapp-empty-state">
            <h2>No manual review messages</h2>
          </div>
        )}
      </section>
    </div>
  )
}

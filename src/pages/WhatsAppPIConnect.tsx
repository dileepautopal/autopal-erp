import { useEffect, useMemo, useRef, useState } from 'react'
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

type APIErrorBody = {
  detail?: string
  errors?: string[]
  message?: string
}

const STATUS_API_URL = apiUrl('/api/whatsapp-pi/status')
const PARSE_API_URL = apiUrl('/api/whatsapp-pi/parse-text')
const IMPORT_API_URL = apiUrl('/api/whatsapp-pi/import-text')
const MESSAGES_API_URL = apiUrl('/api/whatsapp-pi/messages?limit=10')
const reprocessMessageApiUrl = (messageId: string) =>
  apiUrl(`/api/whatsapp-pi/messages/${encodeURIComponent(messageId)}/reprocess`)

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
  const latestIncomingMessageKeyRef = useRef('')

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

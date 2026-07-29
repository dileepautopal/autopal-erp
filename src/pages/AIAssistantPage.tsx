import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { Button } from '../components/ui/Button'
import { TextareaField } from '../components/ui/Field'
import {
  askAI,
  checkAIHealth,
  type AIChatResponse,
  type AIERPRow,
  type AIHealthResponse,
} from '../services/aiService'

const MAX_QUESTION_LENGTH = 5_000

const suggestedPrompts = [
  {
    label: 'Draft a PI confirmation email',
    text: 'Draft a professional email asking a customer to confirm the Proforma Invoice.',
  },
  {
    label: 'Write a payment reminder',
    text: 'Write a polite payment reminder for a customer whose payment is pending against a Proforma Invoice.',
  },
  {
    label: 'Explain a Proforma Invoice',
    text: 'Explain a Proforma Invoice in simple words.',
  },
  {
    label: 'Rewrite this message professionally',
    text: 'Rewrite this customer message professionally:\n\n',
  },
  {
    label: 'Draft a short WhatsApp follow-up',
    text: 'Draft a short WhatsApp follow-up asking the customer to confirm payment and dispatch details.',
  },
]

const suggestedERPPrompts = [
  'How many PIs were generated today?',
  "What is this month's PI value?",
  'Show pending PI summary',
  'Show the latest PIs',
  'Show PI summary for this month',
  'Which customer has the highest PI value this month?',
  'Show top 10 customers by PI value.',
  'What is the average PI value this month?',
  'Which day had the highest PI value?',
  'Show PI trend for the last 30 days.',
  'Show company-wise PI summary.',
  'Search PI number AML-0012.',
  'Give me a management PI insight.',
]

const suggestedCommercialPrompts = [
  'How is PI value this month compared with last month?',
  'Which customers are growing?',
  'Which customers have reduced PI activity?',
  'Show customers with no PI for 90 days.',
  'Which customers became active again?',
  'Show top products by PI line value.',
  'Which product had the highest PI quantity?',
  'Which company has the highest PI activity?',
  'What percentage of PI value comes from the top customer?',
  'Give me a commercial management brief.',
]

type HealthStatus = 'checking' | 'ready' | 'unavailable'

type SpeechRecognitionEventLike = {
  results: {
    [index: number]: {
      [index: number]: {
        transcript?: string
      }
    }
    length: number
  }
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

type AIAssistantPageProps = {
  canUseCommercialIntelligence: boolean
  canUseERPIntelligence: boolean
  currentUserName: string
}

const getHealthLabel = (status: HealthStatus) => {
  if (status === 'checking') {
    return 'Checking...'
  }

  if (status === 'ready') {
    return 'Local AI ready'
  }

  return 'Local AI unavailable'
}

const formatERPDateTime = (value?: string) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

const formatERPValue = (value?: number) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(Number(value ?? 0))

const getERPTableColumns = (rows: AIERPRow[]) => {
  if (rows.some((row) => row.piNumber)) {
    return [
      ['piNumber', 'PI Number'],
      ['piDate', 'Date'],
      ['customerName', 'Customer'],
      ['companyName', 'Company'],
      ['status', 'Status'],
      ['value', 'Value'],
    ] as const
  }

  if (rows.some((row) => row.productCode || row.productDescription)) {
    return [
      ['productCode', 'Product Code'],
      ['productDescription', 'Product'],
      ['classification', 'Classification'],
      ['totalPILineValue', 'PI Line Value'],
      ['currentPIValue', 'Current PI Value'],
      ['previousPIValue', 'Previous PI Value'],
    ] as const
  }

  if (rows.some((row) => row.customerName && row.currentPIValue !== undefined)) {
    return [
      ['customerName', 'Customer'],
      ['classification', 'Classification'],
      ['currentPIValue', 'Current PI Value'],
      ['previousPIValue', 'Previous PI Value'],
      ['openValue', 'Open PI Value'],
    ] as const
  }

  if (rows.some((row) => row.companyName && row.currentPIValue !== undefined)) {
    return [
      ['companyName', 'Company'],
      ['currentPIValue', 'Current PI Value'],
      ['previousPIValue', 'Previous PI Value'],
      ['openValue', 'Open PI Value'],
      ['finalValue', 'Final PI Value'],
    ] as const
  }

  if (rows.some((row) => row.date)) {
    return [
      ['date', 'Date'],
      ['count', 'PI Count'],
      ['totalValue', 'Value'],
    ] as const
  }

  return [
    ['status', 'Status'],
    ['count', 'PI Count'],
    ['totalValue', 'Value'],
  ] as const
}

const renderERPCell = (row: AIERPRow, key: keyof AIERPRow) => {
  if (
    key === 'currentPIValue' ||
    key === 'finalValue' ||
    key === 'openValue' ||
    key === 'previousPIValue' ||
    key === 'totalPILineValue' ||
    key === 'totalValue' ||
    key === 'value'
  ) {
    return formatERPValue(row[key])
  }

  if (key === 'count' || key === 'piCount') {
    return new Intl.NumberFormat('en-IN').format(Number(row[key] ?? 0))
  }

  return String(row[key] ?? '-')
}

export function AIAssistantPage({
  canUseCommercialIntelligence,
  canUseERPIntelligence,
  currentUserName,
}: AIAssistantPageProps) {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AIChatResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [health, setHealth] = useState<AIHealthResponse | null>(null)
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking')
  const [voiceMessage, setVoiceMessage] = useState('')
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const trimmedQuestion = question.trim()
  const charactersUsed = question.length
  const isQuestionTooLong = charactersUsed > MAX_QUESTION_LENGTH
  const canSubmit = Boolean(trimmedQuestion) && !isQuestionTooLong && !isLoading

  const answer = useMemo(() => String(result?.answer ?? '').trim(), [result])
  const erpRows = Array.isArray(result?.data?.rows) ? result.data.rows : []
  const erpColumns = getERPTableColumns(erpRows)
  const SpeechRecognition =
    typeof window === 'undefined'
      ? undefined
      : window.SpeechRecognition ?? window.webkitSpeechRecognition
  const isVoiceSupported = Boolean(SpeechRecognition)

  const loadHealth = useCallback(async () => {
    setHealthStatus('checking')
    const healthResult = await checkAIHealth()

    setHealth(healthResult)
    setHealthStatus(healthResult.running ? 'ready' : 'unavailable')
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadHealth()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadHealth])

  useEffect(
    () => () => {
      recognitionRef.current?.stop()
      recognitionRef.current = null
    },
    [],
  )

  const submitQuestion = async () => {
    if (!trimmedQuestion) {
      setErrorMessage('Please enter a question for the AI assistant.')
      return
    }

    if (isQuestionTooLong) {
      setErrorMessage('Question must be 5,000 characters or less.')
      return
    }

    if (isLoading) {
      return
    }

    setIsLoading(true)
    setErrorMessage('')
    setResult(null)

    try {
      const response = await askAI(trimmedQuestion, {
        userName: currentUserName,
      })

      if (!response.success) {
        throw new Error(response.message || 'The AI request could not be completed.')
      }

      setResult(response)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'The AI request could not be completed.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submitQuestion()
  }

  const handleQuestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submitQuestion()
    }
  }

  const selectSuggestedPrompt = (promptText: string) => {
    setQuestion(promptText)
    setErrorMessage('')
  }

  const clearAssistant = () => {
    setQuestion('')
    setResult(null)
    setErrorMessage('')
    setVoiceMessage('')
  }

  const startVoiceInput = () => {
    if (!SpeechRecognition || isListening) {
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-IN'
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length })
        .map((_, index) => event.results[index]?.[0]?.transcript ?? '')
        .join(' ')
        .trim()

      if (transcript) {
        setQuestion(transcript)
        setVoiceMessage('Voice text captured. Review it, then click Ask AI.')
        setErrorMessage('')
      }
    }
    recognition.onerror = (event) => {
      setVoiceMessage(
        event.error
          ? `Voice input stopped: ${event.error}.`
          : 'Voice input could not be captured.',
      )
      setIsListening(false)
    }
    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    setIsListening(true)
    setVoiceMessage('Listening...')
    recognition.start()
  }

  const stopVoiceInput = () => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  return (
    <div className="page ai-assistant-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Private Local AI</p>
          <h1>AUTOPAL AI Assistant</h1>
          <p className="page-subtitle">
            A private local AI assistant for drafting, explanations and business
            support.
          </p>
        </div>
        <div className="ai-assistant-health">
          <span className={`ai-health-pill ${healthStatus}`}>
            {getHealthLabel(healthStatus)}
          </span>
          <Button onClick={() => void loadHealth()} variant="secondary">
            Retry
          </Button>
        </div>
      </header>

      <section className="ai-assistant-notice">
        <strong>Phase 5 notice:</strong>
        <span>
          General AI drafting does not access live ERP data. Authorised PI
          Intelligence and Commercial Intelligence questions use limited read-only
          PI data only. PI value is not actual sales, revenue, dispatch or
          payment. Stock, balances and customer records are not connected. Review
          answers before use and do not enter passwords, bank details or highly
          sensitive personal data.
        </span>
      </section>

      <section className="ai-assistant-layout">
        <form className="panel ai-assistant-input-panel" onSubmit={handleSubmit}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ask</p>
              <h2>Business Assistant</h2>
            </div>
            <span
              className={`ai-character-counter ${
                isQuestionTooLong ? 'limit-exceeded' : ''
              }`}
            >
              {charactersUsed}/{MAX_QUESTION_LENGTH}
            </span>
          </div>

          <TextareaField
            className="ai-assistant-textarea"
            hint="Maximum 5,000 characters"
            label="Question or message"
            maxLength={MAX_QUESTION_LENGTH}
            onChange={(event) => {
              setQuestion(event.target.value)
              if (errorMessage) {
                setErrorMessage('')
              }
            }}
            onKeyDown={handleQuestionKeyDown}
            placeholder="Ask for a draft, explanation, summary or professional rewrite."
            rows={11}
            value={question}
          />

          <div className="ai-suggested-prompts" aria-label="Suggested prompts">
            {suggestedPrompts.map((prompt) => (
              <button
                disabled={isLoading}
                key={prompt.label}
                onClick={() => selectSuggestedPrompt(prompt.text)}
                type="button"
              >
                {prompt.label}
              </button>
            ))}
          </div>

          <div className="ai-erp-prompts" aria-label="ERP Intelligence prompts">
            <div>
              <strong>PI Intelligence</strong>
              <span>
                {canUseERPIntelligence
                  ? 'Live read-only PI reports'
                  : 'Ask admin to grant AI ERP Intelligence access'}
              </span>
            </div>
            {suggestedERPPrompts.map((prompt) => (
              <button
                disabled={isLoading || !canUseERPIntelligence}
                key={prompt}
                onClick={() => selectSuggestedPrompt(prompt)}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>

          <div className="ai-erp-prompts" aria-label="Commercial Intelligence prompts">
            <div>
              <strong>Commercial Intelligence</strong>
              <span>
                {canUseCommercialIntelligence
                  ? 'Live read-only commercial PI activity'
                  : 'Ask admin to grant AI Commercial Intelligence access'}
              </span>
            </div>
            {suggestedCommercialPrompts.map((prompt) => (
              <button
                disabled={isLoading || !canUseCommercialIntelligence}
                key={prompt}
                onClick={() => selectSuggestedPrompt(prompt)}
                type="button"
              >
                {prompt}
              </button>
            ))}
          </div>

          <div className="ai-assistant-actions">
            <Button disabled={!canSubmit} type="submit">
              {isLoading ? 'Thinking...' : 'Ask AI'}
            </Button>
            {isVoiceSupported ? (
              <Button
                disabled={isLoading}
                onClick={isListening ? stopVoiceInput : startVoiceInput}
                variant="secondary"
              >
                {isListening ? 'Stop Voice' : 'Voice Input'}
              </Button>
            ) : (
              <Button disabled variant="secondary">
                Voice Unsupported
              </Button>
            )}
            <Button disabled={isLoading} onClick={clearAssistant} variant="ghost">
              Clear
            </Button>
          </div>

          {voiceMessage ? (
            <p className="ai-voice-message">{voiceMessage}</p>
          ) : null}
        </form>

        <section className="panel ai-assistant-answer-panel" aria-live="polite">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Answer</p>
              <h2>AI Response</h2>
            </div>
            {result?.model ? (
              <span className="status-pill">{result.model}</span>
            ) : null}
            {result?.source?.liveData ? (
              <span className="ai-live-data-pill">Live ERP data</span>
            ) : null}
          </div>

          {isLoading ? (
            <div className="ai-answer-state">Thinking...</div>
          ) : null}

          {errorMessage ? (
            <div className="ai-error-message" role="alert">
              {errorMessage}
            </div>
          ) : null}

          {!isLoading && !errorMessage && !answer ? (
            <div className="ai-answer-empty">
              Ask a question or choose a suggested prompt.
            </div>
          ) : null}

          {answer ? <div className="ai-answer-content">{answer}</div> : null}

          {result?.source?.liveData ? (
            <div className="ai-erp-source">
              <span>{result.source.module ?? 'ERP Intelligence'}</span>
              <span>{formatERPDateTime(result.source.generatedAt)}</span>
            </div>
          ) : null}

          {erpRows.length > 0 ? (
            <div className="ai-erp-table-wrap">
              <table className="ai-erp-table">
                <thead>
                  <tr>
                    {erpColumns.map((column) => (
                      <th key={column[0]}>{column[1]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {erpRows.map((row, index) => (
                    <tr key={`${row.piNumber ?? row.date ?? row.status ?? 'row'}-${index}`}>
                      {erpColumns.map((column) => (
                        <td key={column[0]}>{renderERPCell(row, column[0])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {Array.isArray(result?.data?.matches) && result.data.matches.length > 0 ? (
            <div className="ai-erp-clarification">
              <strong>Matching names</strong>
              <ul>
                {result.data.matches.map((match) => (
                  <li key={match}>{match}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {result?.usage ? (
            <details className="ai-response-stats">
              <summary>Response details</summary>
              <dl>
                <div>
                  <dt>Prompt tokens</dt>
                  <dd>{result.usage.promptTokens ?? 0}</dd>
                </div>
                <div>
                  <dt>Response tokens</dt>
                  <dd>{result.usage.responseTokens ?? 0}</dd>
                </div>
              </dl>
            </details>
          ) : null}

          {health?.message && healthStatus !== 'ready' ? (
            <p className="ai-health-message">{health.message}</p>
          ) : null}
        </section>
      </section>
    </div>
  )
}

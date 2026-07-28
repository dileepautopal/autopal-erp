import {
  useCallback,
  useEffect,
  useMemo,
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

type HealthStatus = 'checking' | 'ready' | 'unavailable'

const getHealthLabel = (status: HealthStatus) => {
  if (status === 'checking') {
    return 'Checking...'
  }

  if (status === 'ready') {
    return 'Local AI ready'
  }

  return 'Local AI unavailable'
}

export function AIAssistantPage() {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AIChatResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [health, setHealth] = useState<AIHealthResponse | null>(null)
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking')

  const trimmedQuestion = question.trim()
  const charactersUsed = question.length
  const isQuestionTooLong = charactersUsed > MAX_QUESTION_LENGTH
  const canSubmit = Boolean(trimmedQuestion) && !isQuestionTooLong && !isLoading

  const answer = useMemo(() => String(result?.answer ?? '').trim(), [result])

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
      const response = await askAI(trimmedQuestion)

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
        <strong>Phase 3 notice:</strong>
        <span>
          This AI does not currently access live AUTOPAL ERP data, stock, prices,
          balances or customer records. Review answers before use and do not enter
          passwords, bank details or highly sensitive personal data.
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

          <div className="ai-assistant-actions">
            <Button disabled={!canSubmit} type="submit">
              {isLoading ? 'Thinking...' : 'Ask AI'}
            </Button>
            <Button disabled={isLoading} onClick={clearAssistant} variant="ghost">
              Clear
            </Button>
          </div>
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

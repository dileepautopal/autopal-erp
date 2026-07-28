import { apiUrl } from '../config/api'

const AI_ASK_URL = apiUrl('/api/ai/ask')
const AI_HEALTH_URL = apiUrl('/api/ai/health')
const REQUEST_TIMEOUT_MS = 150_000

export type AIChatResponse = {
  success: boolean
  mode?: 'general' | 'erp'
  intent?: string
  answer?: string
  data?: AIERPData
  model?: string
  source?: {
    generatedAt?: string
    liveData?: boolean
    module?: string
    timezone?: string
  }
  usage?: {
    promptTokens?: number
    responseTokens?: number
  }
  performance?: {
    totalDurationNanoseconds?: number
    loadDurationNanoseconds?: number
  }
  message?: string
  wordingMode?: string
}

export type AIERPRow = {
  companyName?: string
  count?: number
  customerName?: string
  date?: string
  piDate?: string
  piNumber?: string
  status?: string
  totalValue?: number
  value?: number
}

export type AIERPData = {
  companyName?: string
  count?: number
  customerName?: string
  endDate?: string
  limit?: number
  matches?: string[]
  rows?: AIERPRow[]
  startDate?: string
  status?: string
  totalValue?: number
}

type AskAIOptions = {
  userName?: string
}

export type AIHealthResponse = {
  success: boolean
  service?: string
  running?: boolean
  baseUrl?: string
  model?: string
  message?: string
}

const withTimeout = () => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  return {
    signal: controller.signal,
    clear: () => window.clearTimeout(timeoutId),
  }
}

const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  try {
    return (await response.json()) as T
  } catch {
    throw new Error('The AI service returned an unreadable response.')
  }
}

const getFriendlyErrorMessage = (status: number, message?: string) => {
  if (status === 400) {
    return message || 'Please enter a valid question.'
  }

  if (status === 503) {
    return 'Local AI is unavailable. Please confirm that Ollama is running.'
  }

  return message || 'The AI request could not be completed.'
}

export const askAI = async (
  question: string,
  options: AskAIOptions = {},
): Promise<AIChatResponse> => {
  const timeout = withTimeout()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (options.userName) {
    headers['x-autopal-user'] = options.userName
  }

  try {
    const response = await fetch(AI_ASK_URL, {
      body: JSON.stringify({ question }),
      headers,
      method: 'POST',
      signal: timeout.signal,
    })
    const body = await parseJsonResponse<AIChatResponse>(response)

    if (!response.ok) {
      throw new Error(getFriendlyErrorMessage(response.status, body.message))
    }

    return body
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Local AI took too long to respond. Please try again.', {
        cause: error,
      })
    }

    if (error instanceof TypeError) {
      throw new Error(
        'Local AI is unavailable. Please confirm that Ollama is running.',
        {
          cause: error,
        },
      )
    }

    throw error
  } finally {
    timeout.clear()
  }
}

export const checkAIHealth = async (): Promise<AIHealthResponse> => {
  const timeout = withTimeout()

  try {
    const response = await fetch(AI_HEALTH_URL, {
      method: 'GET',
      signal: timeout.signal,
    })
    const body = await parseJsonResponse<AIHealthResponse>(response)

    return {
      ...body,
      running: response.ok && Boolean(body.running),
      success: response.ok && Boolean(body.success),
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        success: false,
        running: false,
        message: 'Local AI health check timed out.',
      }
    }

    return {
      success: false,
      running: false,
      message: 'Local AI is unavailable. Please confirm that Ollama is running.',
    }
  } finally {
    timeout.clear()
  }
}

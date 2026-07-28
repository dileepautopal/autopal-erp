const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b'
const CHAT_TIMEOUT_MS = 120_000
const HEALTH_TIMEOUT_MS = 10_000
const MAX_QUESTION_LENGTH = 5_000

export const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL
export const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL

const stripTrailingSlash = (value) => value.replace(/\/+$/, '')

const getChatUrl = () => `${stripTrailingSlash(OLLAMA_BASE_URL)}/api/chat`

const createAbortSignal = (timeoutMs) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  }
}

const getErrorMessage = (error) => {
  if (error?.name === 'AbortError') {
    return 'Ollama request timed out.'
  }

  if (
    error?.cause?.code === 'ECONNREFUSED' ||
    error?.code === 'ECONNREFUSED'
  ) {
    return 'Ollama is not reachable at the configured local address.'
  }

  return 'Unable to connect to Ollama.'
}

const parseOllamaResponse = async (response) => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export const validateQuestion = (question) => {
  const normalizedQuestion = String(question ?? '').trim()

  if (!normalizedQuestion) {
    const error = new Error('Question is required.')
    error.statusCode = 400
    throw error
  }

  if (normalizedQuestion.length > MAX_QUESTION_LENGTH) {
    const error = new Error('Question must be 5,000 characters or less.')
    error.statusCode = 400
    throw error
  }

  return normalizedQuestion
}

export const askOllama = async ({ question, systemPrompt = '' } = {}) => {
  const normalizedQuestion = validateQuestion(question)
  const messages = []

  if (String(systemPrompt ?? '').trim()) {
    messages.push({
      role: 'system',
      content: String(systemPrompt).trim(),
    })
  }

  messages.push({
    role: 'user',
    content: normalizedQuestion,
  })

  const timeout = createAbortSignal(CHAT_TIMEOUT_MS)

  try {
    const response = await fetch(getChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 700,
        },
        keep_alive: '10m',
      }),
      signal: timeout.signal,
    })

    const data = await parseOllamaResponse(response)

    if (!response.ok) {
      const error = new Error(
        data?.error
          ? `Ollama returned HTTP ${response.status}: ${data.error}`
          : `Ollama returned HTTP ${response.status}.`,
      )
      error.statusCode = 503
      throw error
    }

    const answer = String(data?.message?.content ?? '').trim()

    if (!answer) {
      const error = new Error('Ollama returned an empty response.')
      error.statusCode = 503
      throw error
    }

    return {
      answer,
      model: data?.model || OLLAMA_MODEL,
      totalDuration: Number(data?.total_duration ?? 0),
      loadDuration: Number(data?.load_duration ?? 0),
      promptTokens: Number(data?.prompt_eval_count ?? 0),
      responseTokens: Number(data?.eval_count ?? 0),
    }
  } catch (error) {
    if (error.statusCode) {
      throw error
    }

    const serviceError = new Error(getErrorMessage(error))
    serviceError.statusCode = 503
    throw serviceError
  } finally {
    timeout.clear()
  }
}

export const checkOllamaHealth = async () => {
  const timeout = createAbortSignal(HEALTH_TIMEOUT_MS)

  try {
    const response = await fetch(getChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: 'user',
            content: 'Reply with OK.',
          },
        ],
        stream: false,
        options: {
          temperature: 0,
          num_predict: 8,
        },
        keep_alive: '10m',
      }),
      signal: timeout.signal,
    })

    if (!response.ok) {
      return {
        running: false,
        baseUrl: OLLAMA_BASE_URL,
        model: OLLAMA_MODEL,
        message: `Ollama returned HTTP ${response.status}.`,
      }
    }

    return {
      running: true,
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL,
      message: 'Ollama is running',
    }
  } catch (error) {
    return {
      running: false,
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL,
      message: getErrorMessage(error),
    }
  } finally {
    timeout.clear()
  }
}

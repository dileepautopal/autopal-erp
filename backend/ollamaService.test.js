import assert from 'node:assert/strict'
import {
  afterEach,
  test,
} from 'node:test'
import {
  askOllama,
  checkOllamaHealth,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
} from './ollamaService.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  })

test('askOllama returns a successful chat response', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `${OLLAMA_BASE_URL}/api/chat`)
    assert.equal(options.method, 'POST')

    const body = JSON.parse(options.body)

    assert.equal(body.model, OLLAMA_MODEL)
    assert.equal(body.stream, false)
    assert.equal(body.options.temperature, 0.2)
    assert.equal(body.options.num_predict, 700)
    assert.equal(body.keep_alive, '10m')
    assert.equal(body.messages.at(-1).content, 'Draft a confirmation email.')

    return jsonResponse({
      model: OLLAMA_MODEL,
      message: {
        content: 'Please confirm the Proforma Invoice.',
      },
      total_duration: 12,
      load_duration: 3,
      prompt_eval_count: 8,
      eval_count: 11,
    })
  }

  const result = await askOllama({
    question: 'Draft a confirmation email.',
    systemPrompt: 'You are a business assistant.',
  })

  assert.deepEqual(result, {
    answer: 'Please confirm the Proforma Invoice.',
    model: OLLAMA_MODEL,
    totalDuration: 12,
    loadDuration: 3,
    promptTokens: 8,
    responseTokens: 11,
  })
})

test('askOllama rejects an empty question', async () => {
  await assert.rejects(
    () => askOllama({ question: '   ' }),
    /Question is required\./,
  )
})

test('askOllama rejects a question longer than 5000 characters', async () => {
  await assert.rejects(
    () => askOllama({ question: 'A'.repeat(5_001) }),
    /Question must be 5,000 characters or less\./,
  )
})

test('askOllama handles non-200 Ollama responses', async () => {
  globalThis.fetch = async () =>
    jsonResponse(
      {
        error: 'model not found',
      },
      {
        status: 404,
      },
    )

  await assert.rejects(
    () => askOllama({ question: 'Hello' }),
    /Ollama returned HTTP 404: model not found/,
  )
})

test('askOllama handles empty AI answers', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      model: OLLAMA_MODEL,
      message: {
        content: '   ',
      },
    })

  await assert.rejects(
    () => askOllama({ question: 'Hello' }),
    /Ollama returned an empty response\./,
  )
})

test('checkOllamaHealth returns running true when Ollama responds', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, OLLAMA_BASE_URL)
    assert.equal(options.method, 'GET')

    return new Response('Ollama is running')
  }

  const result = await checkOllamaHealth()

  assert.deepEqual(result, {
    running: true,
    baseUrl: OLLAMA_BASE_URL,
    model: OLLAMA_MODEL,
    message: 'Ollama is running',
  })
})

test('checkOllamaHealth returns running false when Ollama fails', async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), {
      cause: {
        code: 'ECONNREFUSED',
      },
    })
  }

  const result = await checkOllamaHealth()

  assert.equal(result.running, false)
  assert.equal(result.baseUrl, OLLAMA_BASE_URL)
  assert.equal(result.model, OLLAMA_MODEL)
  assert.equal(
    result.message,
    'Ollama is not reachable at the configured local address.',
  )
})

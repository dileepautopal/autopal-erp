import {
  askOllama,
  OLLAMA_MODEL,
} from './ollamaService.js'
import {
  buildDeterministicDrillDownExplanation,
  getExecutiveDrillDown,
} from './executiveDrillDownService.js'
import {
  EXECUTIVE_EXPLAIN_MODULE,
  getExplainMeta,
} from './executiveDrillDownUtils.js'
import { toText } from './piIntelligenceUtils.js'

const EXECUTIVE_EXPLAIN_SYSTEM_PROMPT = `
You are AUTOPAL's Executive Drill-Down Explanation assistant.

You receive verified structured Proforma Invoice data.

Rules:
1. Use only supplied figures.
2. Never invent or alter values.
3. Do not call PI value actual sales or revenue.
4. Do not invent causes.
5. Do not make forecasts.
6. Do not provide stock, accounting, production, payment or credit conclusions.
7. Explain what the selected KPI or alert means.
8. Mention the records or factors supporting the result.
9. Keep the explanation concise.
10. Mention the PI-data limitation.
11. Do not expose SQL or technical internals.
`.trim()

const collectNumberTokens = (value, tokens = new Set()) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    tokens.add(String(value))
    tokens.add(String(Math.trunc(value)))
    tokens.add(value.toFixed(2))
    tokens.add(
      new Intl.NumberFormat('en-IN', {
        maximumFractionDigits: 2,
      })
        .format(value)
        .replace(/,/g, ''),
    )
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectNumberTokens(item, tokens))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectNumberTokens(item, tokens))
  }

  return tokens
}

const modelUsesOnlyVerifiedNumbers = (answer, payload) => {
  const permitted = collectNumberTokens(payload)
  const answerNumbers = answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? []

  return answerNumbers.every((numberText) => {
    const normalized = numberText.replace(/,/g, '')
    return permitted.has(normalized) || permitted.has(String(Number(normalized)))
  })
}

const hasForbiddenWording = (answer) =>
  /\b(actual sales|actual revenue|confirmed orders?|forecast|credit risk|stock|inventory|ledger|outstanding)\b/i.test(
    answer,
  )

const buildSafeExplainPayload = (drillDown) => ({
  filters: drillDown.filters ?? {},
  pagination: drillDown.pagination ?? {},
  period: drillDown.period ?? {},
  rows: Array.isArray(drillDown.rows) ? drillDown.rows.slice(0, 10) : [],
  summary: drillDown.summary ?? {},
  title: drillDown.title,
  type: drillDown.type,
})

export const explainExecutiveDrillDown = async ({
  comparisonMode,
  drillDown,
  endDate,
  filters,
  limit,
  modelWording = askOllama,
  period,
  queryable,
  startDate,
  tableNames,
  today,
  type,
  useModelWording = true,
}) => {
  const verifiedDrillDown =
    drillDown ??
    (await getExecutiveDrillDown({
      comparisonMode,
      endDate,
      filters,
      limit,
      period,
      queryable,
      startDate,
      tableNames,
      today,
      type,
    }))

  if (!verifiedDrillDown.success) {
    return verifiedDrillDown
  }

  const verifiedData = buildSafeExplainPayload(verifiedDrillDown)
  const fallbackExplanation = buildDeterministicDrillDownExplanation(verifiedDrillDown)
  let explanation = fallbackExplanation
  let model = null
  let wordingMode = 'server-fallback'

  if (useModelWording) {
    try {
      const result = await modelWording({
        question: JSON.stringify(verifiedData),
        systemPrompt: EXECUTIVE_EXPLAIN_SYSTEM_PROMPT,
      })
      const answer = toText(result.answer)

      if (
        answer &&
        modelUsesOnlyVerifiedNumbers(answer, verifiedData) &&
        !hasForbiddenWording(answer)
      ) {
        explanation = answer
        model = result.model || OLLAMA_MODEL
        wordingMode = 'ollama'
      }
    } catch {
      explanation = fallbackExplanation
      model = null
      wordingMode = 'server-fallback'
    }
  }

  return {
    ...getExplainMeta(),
    explanation,
    model,
    source: {
      module: verifiedDrillDown.module,
      type: verifiedDrillDown.type,
    },
    success: true,
    verifiedData,
    wordingMode,
  }
}

export { EXECUTIVE_EXPLAIN_MODULE }

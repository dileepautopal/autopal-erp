import {
  askOllama,
  OLLAMA_MODEL,
} from './ollamaService.js'
import {
  PI_PRO_MODULE,
  getPIIntelligenceProDashboard,
} from './piAnalyticsService.js'
import { INDIA_TIME_ZONE, toNumber } from './piIntelligenceUtils.js'

const PI_INSIGHT_SYSTEM_PROMPT = `
You are AUTOPAL's PI management reporting assistant.

You will receive verified structured PI data from approved backend queries.

Rules:
1. Use only the supplied figures.
2. Never estimate, change or invent a number.
3. Do not claim access to information not included.
4. Keep the management insight concise.
5. Mention important increases, decreases, open/final proportions and concentration risks only when directly supported by the supplied data.
6. Do not expose table names, SQL or technical internals.
7. Use professional management language.
8. If comparison data is insufficient, state that no comparison is available.
9. Do not make forecasts in this phase.
10. Do not make purchasing, credit or production recommendations.
`.trim()

const formatINR = (value) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(toNumber(value))

const buildSafeInsightPayload = (dashboard) => ({
  averagePIValueMonth: dashboard.kpis.averagePIValueMonth,
  bestDayByCount: dashboard.bestDayByCount
    ? {
        count: dashboard.bestDayByCount.count,
        date: dashboard.bestDayByCount.date,
        value: dashboard.bestDayByCount.value,
      }
    : null,
  bestDayByValue: dashboard.bestDayByValue
    ? {
        count: dashboard.bestDayByValue.count,
        date: dashboard.bestDayByValue.date,
        value: dashboard.bestDayByValue.value,
      }
    : null,
  final: dashboard.kpis.final,
  month: dashboard.kpis.month,
  open: dashboard.kpis.open,
  period: 'Current Month',
  today: dashboard.kpis.today,
  topCompany: dashboard.topCompany
    ? {
        count: dashboard.topCompany.piCount,
        name: dashboard.topCompany.name,
        value: dashboard.topCompany.totalPIValue,
      }
    : null,
  topCustomer: dashboard.topCustomer
    ? {
        count: dashboard.topCustomer.piCount,
        name: dashboard.topCustomer.name,
        value: dashboard.topCustomer.totalPIValue,
      }
    : null,
  yesterday: dashboard.kpis.yesterday,
})

const collectPermittedNumberTokens = (value, tokens = new Set()) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
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
    value.forEach((item) => collectPermittedNumberTokens(item, tokens))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectPermittedNumberTokens(item, tokens))
  }

  return tokens
}

const modelInsightUsesOnlyVerifiedNumbers = (answer, data) => {
  const permitted = collectPermittedNumberTokens(data)
  const answerNumbers = answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? []

  return answerNumbers.every((numberText) => {
    const normalized = numberText.replace(/,/g, '')
    return permitted.has(normalized) || permitted.has(String(Number(normalized)))
  })
}

export const buildDeterministicManagementInsight = (payload) => {
  const todayValue = toNumber(payload.today?.value)
  const yesterdayValue = toNumber(payload.yesterday?.value)
  const comparison =
    yesterdayValue > 0
      ? todayValue >= yesterdayValue
        ? `Today is higher than yesterday by ${formatINR(todayValue - yesterdayValue)}.`
        : `Today is lower than yesterday by ${formatINR(yesterdayValue - todayValue)}.`
      : 'Yesterday comparison is not available.'
  const topCustomerText = payload.topCustomer
    ? `Top customer contribution is ${payload.topCustomer.name} at ${formatINR(payload.topCustomer.value)}.`
    : 'No top customer is available for the current month.'
  const topCompanyText = payload.topCompany
    ? `Top company contribution is ${payload.topCompany.name} at ${formatINR(payload.topCompany.value)}.`
    : 'No top company is available for the current month.'

  return [
    `Current month PI value is ${formatINR(payload.month?.value)} across ${toNumber(payload.month?.count)} PI(s).`,
    `Open PIs are ${toNumber(payload.open?.percentage)}% and final PIs are ${toNumber(payload.final?.percentage)}% of PI count.`,
    comparison,
    topCustomerText,
    topCompanyText,
  ].join(' ')
}

export const getPIManagementInsight = async ({
  modelWording = askOllama,
  queryable,
  tableNames,
  today,
  useModelWording = true,
}) => {
  const dashboard = await getPIIntelligenceProDashboard({
    queryable,
    tableNames,
    today,
  })
  const verifiedData = buildSafeInsightPayload(dashboard)
  const fallbackInsight = buildDeterministicManagementInsight(verifiedData)
  let insight = fallbackInsight
  let model = null
  let wordingMode = 'server-fallback'

  if (useModelWording) {
    try {
      const result = await modelWording({
        question: JSON.stringify(verifiedData),
        systemPrompt: PI_INSIGHT_SYSTEM_PROMPT,
      })
      const answer = String(result.answer ?? '').trim()

      if (answer && modelInsightUsesOnlyVerifiedNumbers(answer, verifiedData)) {
        insight = answer
        model = result.model || OLLAMA_MODEL
        wordingMode = 'ollama'
      }
    } catch {
      insight = fallbackInsight
      model = null
      wordingMode = 'server-fallback'
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    insight,
    model,
    module: PI_PRO_MODULE,
    success: true,
    timezone: INDIA_TIME_ZONE,
    verifiedData,
    wordingMode,
  }
}

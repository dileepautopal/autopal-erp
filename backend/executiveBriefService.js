import {
  askOllama,
  OLLAMA_MODEL,
} from './ollamaService.js'
import { getExecutiveCockpit } from './executiveCockpitService.js'
import {
  EXECUTIVE_DISCLAIMER,
  EXECUTIVE_MODULE,
  EXECUTIVE_TIMEZONE,
  formatINR,
} from './executiveCockpitUtils.js'
import { toNumber, toText } from './piIntelligenceUtils.js'

const EXECUTIVE_BRIEF_SYSTEM_PROMPT = `
You are AUTOPAL's Executive PI and Commercial Intelligence assistant.

You receive verified structured data produced by approved read-only backend queries.

Rules:
1. Use only supplied figures.
2. Never invent, estimate or alter a number.
3. Do not call PI value actual sales, actual revenue, confirmed orders, dispatch or payment.
4. Use "PI value", "Proforma Invoice activity" or "commercial pipeline value".
5. Keep the executive brief concise and management-focused.
6. State important increases or decreases only when supported.
7. Mention concentration only as a PI concentration indicator.
8. Do not provide credit-risk conclusions.
9. Do not provide inventory, production, accounting or payment conclusions.
10. Do not forecast.
11. Do not invent reasons for changes.
12. Do not expose SQL, table names or technical internals.
13. Mention the PI-based limitation.
14. If comparison is unavailable, state that clearly.
15. Use professional management language.
`.trim()

const buildSafeExecutiveBriefPayload = (cockpit) => ({
  alerts: (cockpit.alerts ?? []).slice(0, 5).map((alert) => ({
    message: alert.message,
    severity: alert.severity,
    type: alert.type,
  })),
  comparison: {
    countChangePercentage: cockpit.kpis.monthlyCountChangePercentage,
    currentMonthCount: cockpit.kpis.thisMonthPICount,
    currentMonthValue: cockpit.kpis.thisMonthPIValue,
    previousMonthCount: cockpit.kpis.previousMonthPICount,
    previousMonthValue: cockpit.kpis.previousMonthPIValue,
    valueChangePercentage: cockpit.kpis.monthlyValueChangePercentage,
  },
  concentration: {
    label: cockpit.kpis.commercialConcentrationLabel,
    topCustomerSharePercentage: cockpit.kpis.topCustomerSharePercentage,
  },
  customerActivity: {
    decliningCustomers: cockpit.growthHighlights.decliningCustomerCount,
    growingCustomers: cockpit.growthHighlights.growingCustomerCount,
    inactiveCustomers: cockpit.activityHighlights.inactiveCount,
    newCustomers: cockpit.growthHighlights.newCustomerCount,
    reactivatedCustomers: cockpit.activityHighlights.reactivatedCount,
  },
  period: cockpit.period,
  status: {
    finalCount: cockpit.kpis.finalPICount,
    finalValue: cockpit.kpis.finalPIValue,
    openCount: cockpit.kpis.openPICount,
    openValue: cockpit.kpis.openPIValue,
  },
  today: {
    count: cockpit.kpis.todayPICount,
    value: cockpit.kpis.todayPIValue,
  },
  topCompany: {
    name: cockpit.kpis.topCompany,
    value: cockpit.kpis.topCompanyPIValue,
  },
  topCustomer: {
    name: cockpit.kpis.topCustomer,
    sharePercentage: cockpit.kpis.topCustomerSharePercentage,
    value: cockpit.kpis.topCustomerPIValue,
  },
  topProduct: {
    name: cockpit.kpis.topProduct,
    value: cockpit.kpis.topProductPILineValue,
  },
})

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

const hasForbiddenBusinessWording = (answer) =>
  /\b(actual sales|actual revenue|confirmed orders?|dispatched value|received payment|credit risk|forecast)\b/i.test(
    answer,
  )

export const buildDeterministicExecutiveBrief = (payload) => {
  const comparisonText =
    payload.comparison.valueChangePercentage === null ||
    payload.comparison.valueChangePercentage === undefined
      ? 'Month-on-month PI value percentage comparison is unavailable because the comparison value is zero.'
      : `Month-on-month PI value changed by ${payload.comparison.valueChangePercentage}%.`
  const topCustomerText = payload.topCustomer.name
    ? `Top customer is ${payload.topCustomer.name} with PI value ${formatINR(payload.topCustomer.value)} and share ${toNumber(payload.topCustomer.sharePercentage)}%.`
    : 'No top customer is available for the selected period.'
  const topProductText = payload.topProduct.name
    ? `Top product contribution is ${payload.topProduct.name} with PI line value ${formatINR(payload.topProduct.value)}.`
    : 'No top product is available for the selected period.'
  const topCompanyText = payload.topCompany.name
    ? `Top company is ${payload.topCompany.name} with PI value ${formatINR(payload.topCompany.value)}.`
    : 'No top company is available for the selected period.'

  return [
    `Today Proforma Invoice activity is ${toNumber(payload.today.count)} PI(s) with PI value ${formatINR(payload.today.value)}.`,
    `Current month PI value is ${formatINR(payload.comparison.currentMonthValue)} across ${toNumber(payload.comparison.currentMonthCount)} PI(s).`,
    comparisonText,
    topCustomerText,
    topProductText,
    topCompanyText,
    `Open PI value is ${formatINR(payload.status.openValue)} and final PI value is ${formatINR(payload.status.finalValue)}.`,
    `Customer activity includes ${toNumber(payload.customerActivity.growingCustomers)} growing, ${toNumber(payload.customerActivity.decliningCustomers)} declining, ${toNumber(payload.customerActivity.newCustomers)} new, ${toNumber(payload.customerActivity.inactiveCustomers)} inactive and ${toNumber(payload.customerActivity.reactivatedCustomers)} reactivated record(s).`,
    `Commercial PI concentration indicator is ${payload.concentration.label}.`,
    EXECUTIVE_DISCLAIMER,
  ].join(' ')
}

export const getExecutiveBrief = async ({
  comparisonMode,
  endDate,
  modelWording = askOllama,
  period,
  queryable,
  startDate,
  tableNames,
  today,
  useModelWording = true,
}) => {
  const cockpit = await getExecutiveCockpit({
    comparisonMode,
    endDate,
    period,
    queryable,
    startDate,
    tableNames,
    today,
  })

  if (!cockpit.success) {
    return cockpit
  }

  const verifiedData = buildSafeExecutiveBriefPayload(cockpit)
  const fallbackBrief = buildDeterministicExecutiveBrief(verifiedData)
  let brief = fallbackBrief
  let model = null
  let wordingMode = 'server-fallback'

  if (useModelWording) {
    try {
      const result = await modelWording({
        question: JSON.stringify(verifiedData),
        systemPrompt: EXECUTIVE_BRIEF_SYSTEM_PROMPT,
      })
      const answer = toText(result.answer).trim()

      if (
        answer &&
        modelUsesOnlyVerifiedNumbers(answer, verifiedData) &&
        !hasForbiddenBusinessWording(answer)
      ) {
        brief = answer
        model = result.model || OLLAMA_MODEL
        wordingMode = 'ollama'
      }
    } catch {
      brief = fallbackBrief
      model = null
      wordingMode = 'server-fallback'
    }
  }

  return {
    disclaimer: EXECUTIVE_DISCLAIMER,
    generatedAt: new Date().toISOString(),
    brief,
    model,
    module: EXECUTIVE_MODULE,
    success: true,
    timezone: EXECUTIVE_TIMEZONE,
    verifiedData,
    wordingMode,
  }
}

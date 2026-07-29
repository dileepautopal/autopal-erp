import { getExecutiveBrief } from './executiveBriefService.js'
import { getExecutiveCockpit } from './executiveCockpitService.js'
import {
  EXECUTIVE_DISCLAIMER,
  EXECUTIVE_MODULE,
  EXECUTIVE_TIMEZONE,
  formatINR,
} from './executiveCockpitUtils.js'
import { toNumber, toText } from './piIntelligenceUtils.js'

export const EXECUTIVE_INTENTS = {
  EXECUTIVE_ALERTS: 'executive_alerts',
  EXECUTIVE_CONCENTRATION: 'executive_concentration',
  EXECUTIVE_CUSTOMER_ACTIVITY: 'executive_customer_activity',
  EXECUTIVE_MANAGEMENT_BRIEF: 'executive_management_brief',
  EXECUTIVE_MONTH_COMPARISON: 'executive_month_comparison',
  EXECUTIVE_TODAY_SUMMARY: 'executive_today_summary',
  EXECUTIVE_TOP_COMPANY: 'executive_top_company',
  EXECUTIVE_TOP_CUSTOMER: 'executive_top_customer',
  EXECUTIVE_TOP_PRODUCT: 'executive_top_product',
  EXECUTIVE_UNSUPPORTED: 'executive_unsupported',
  GENERAL_AI_QUESTION: 'general_ai_question',
}

const normalizeQuestion = (question) =>
  toText(question)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const hasExecutiveWords = (text) =>
  /\b(executive|cockpit|commercial alerts?|important alerts?|top product|top customer|top company|customer.*pi value|product.*pi line value|company.*pi activity|customer activity|inactive customers?|reactivated customers?|current pi concentration|pi concentration|management brief|month with last month|this month with last month)\b/i.test(
    text,
  )

export const classifyExecutiveQuestion = (question) => {
  const text = normalizeQuestion(question)

  if (!text) {
    return {
      intent: EXECUTIVE_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  if (/\b(stock|inventory|outstanding|ledger|accounting|balance|dispatch|production|payment)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_UNSUPPORTED,
      parameters: {},
    }
  }

  if (!hasExecutiveWords(text)) {
    return {
      intent: EXECUTIVE_INTENTS.GENERAL_AI_QUESTION,
      parameters: {},
    }
  }

  if (/\b(brief|management brief)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_MANAGEMENT_BRIEF,
      parameters: {},
    }
  }

  if (/\b(today|today s)\b/i.test(text) && /\b(summary|executive)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_TODAY_SUMMARY,
      parameters: {},
    }
  }

  if (/\b(compare|comparison|month with last month|this month with last month)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_MONTH_COMPARISON,
      parameters: {},
    }
  }

  if (/\b(alert|alerts)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_ALERTS,
      parameters: {},
    }
  }

  if (/\b(inactive|reactivated|customer activity)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_CUSTOMER_ACTIVITY,
      parameters: {},
    }
  }

  if (/\b(concentration|few customers)\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_CONCENTRATION,
      parameters: {},
    }
  }

  if (/\bproduct\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_TOP_PRODUCT,
      parameters: {},
    }
  }

  if (/\bcompany\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_TOP_COMPANY,
      parameters: {},
    }
  }

  if (/\bcustomer\b/i.test(text)) {
    return {
      intent: EXECUTIVE_INTENTS.EXECUTIVE_TOP_CUSTOMER,
      parameters: {},
    }
  }

  return {
    intent: EXECUTIVE_INTENTS.EXECUTIVE_TODAY_SUMMARY,
    parameters: {},
  }
}

const rowAnswer = (rows, getLine, emptyMessage) =>
  rows?.length ? rows.slice(0, 5).map(getLine).join('\n') : emptyMessage

export const processExecutiveQuestion = async ({
  comparisonMode,
  endDate,
  modelWording,
  period,
  queryable,
  question,
  startDate,
  tableNames,
  today,
  useModelWording,
}) => {
  const classification = classifyExecutiveQuestion(question)

  if (classification.intent === EXECUTIVE_INTENTS.GENERAL_AI_QUESTION) {
    return {
      intent: classification.intent,
      mode: 'general',
      statusCode: 422,
      success: false,
    }
  }

  if (classification.intent === EXECUTIVE_INTENTS.EXECUTIVE_UNSUPPORTED) {
    return {
      intent: classification.intent,
      message:
        'Stock, accounting, outstanding, dispatch, production and payment intelligence are not connected in this phase.',
      mode: 'executive',
      statusCode: 422,
      success: false,
    }
  }

  if (classification.intent === EXECUTIVE_INTENTS.EXECUTIVE_MANAGEMENT_BRIEF) {
    const brief = await getExecutiveBrief({
      comparisonMode,
      endDate,
      modelWording,
      period,
      queryable,
      startDate,
      tableNames,
      today,
      useModelWording,
    })

    return {
      answer: brief.brief,
      data: brief,
      intent: classification.intent,
      mode: 'executive',
      source: {
        generatedAt: brief.generatedAt,
        liveData: true,
        module: EXECUTIVE_MODULE,
        timezone: EXECUTIVE_TIMEZONE,
      },
      success: brief.success,
      wordingMode: brief.wordingMode,
    }
  }

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
    return {
      intent: classification.intent,
      message: cockpit.message,
      mode: 'executive',
      statusCode: cockpit.statusCode ?? 422,
      success: false,
    }
  }

  let answer = ''

  switch (classification.intent) {
    case EXECUTIVE_INTENTS.EXECUTIVE_MONTH_COMPARISON:
      answer = `This month PI value is ${formatINR(cockpit.kpis.thisMonthPIValue)} against previous month PI value ${formatINR(cockpit.kpis.previousMonthPIValue)}. Value change percentage: ${cockpit.kpis.monthlyValueChangePercentage ?? 'comparison unavailable'}.`
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_TOP_CUSTOMER:
      answer = cockpit.kpis.topCustomer
        ? `Top customer is ${cockpit.kpis.topCustomer} with PI value ${formatINR(cockpit.kpis.topCustomerPIValue)} and share ${toNumber(cockpit.kpis.topCustomerSharePercentage)}%.`
        : 'No top customer is available for the selected period.'
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_TOP_PRODUCT:
      answer = cockpit.kpis.topProduct
        ? `Top product is ${cockpit.kpis.topProduct} with PI line value ${formatINR(cockpit.kpis.topProductPILineValue)}.`
        : 'No top product is available for the selected period.'
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_TOP_COMPANY:
      answer = cockpit.kpis.topCompany
        ? `Top company is ${cockpit.kpis.topCompany} with PI value ${formatINR(cockpit.kpis.topCompanyPIValue)}.`
        : 'No top company is available for the selected period.'
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_ALERTS:
      answer = rowAnswer(
        cockpit.alerts,
        (alert, index) => `${index + 1}. ${alert.severity.toUpperCase()}: ${alert.message}`,
        'No deterministic executive alerts are active for the selected period.',
      )
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_CUSTOMER_ACTIVITY:
      answer = [
        `Inactive customers: ${cockpit.activityHighlights.inactiveCount}.`,
        `Reactivated customers: ${cockpit.activityHighlights.reactivatedCount}.`,
        `New customer PI activity: ${cockpit.growthHighlights.newCustomerCount}.`,
      ].join(' ')
      break

    case EXECUTIVE_INTENTS.EXECUTIVE_CONCENTRATION:
      answer = `Commercial PI concentration indicator is ${cockpit.kpis.commercialConcentrationLabel}. Top customer share is ${toNumber(cockpit.kpis.topCustomerSharePercentage)}%.`
      break

    default:
      answer = `Today Proforma Invoice activity is ${toNumber(cockpit.kpis.todayPICount)} PI(s) with PI value ${formatINR(cockpit.kpis.todayPIValue)}. ${EXECUTIVE_DISCLAIMER}`
      break
  }

  return {
    answer,
    data: cockpit,
    intent: classification.intent,
    mode: 'executive',
    source: {
      generatedAt: cockpit.generatedAt,
      liveData: true,
      module: EXECUTIVE_MODULE,
      timezone: EXECUTIVE_TIMEZONE,
    },
    success: true,
    wordingMode: 'server-fallback',
  }
}

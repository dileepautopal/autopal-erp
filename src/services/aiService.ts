import { apiUrl } from '../config/api'

const AI_ASK_URL = apiUrl('/api/ai/ask')
const AI_ERP_DASHBOARD_URL = apiUrl('/api/ai/erp/dashboard')
const AI_ERP_PRO_DASHBOARD_URL = apiUrl('/api/ai/erp/dashboard/pro')
const AI_ERP_CUSTOMER_RANKING_URL = apiUrl('/api/ai/erp/rankings/customers')
const AI_ERP_COMPANY_RANKING_URL = apiUrl('/api/ai/erp/rankings/companies')
const AI_ERP_PI_SEARCH_URL = apiUrl('/api/ai/erp/pi-search')
const AI_ERP_PI_DETAIL_URL = apiUrl('/api/ai/erp/pi')
const AI_ERP_INSIGHT_URL = apiUrl('/api/ai/erp/insight')
const AI_COMMERCIAL_DASHBOARD_URL = apiUrl('/api/ai/commercial/dashboard')
const AI_COMMERCIAL_BRIEF_URL = apiUrl('/api/ai/commercial/brief')
const AI_HEALTH_URL = apiUrl('/api/ai/health')
const REQUEST_TIMEOUT_MS = 150_000

export type AIChatResponse = {
  success: boolean
  mode?: 'general' | 'erp' | 'commercial'
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
  averagePIValue?: number
  companyName?: string
  count?: number
  currentPIValue?: number
  customerName?: string
  date?: string
  classification?: string
  productCode?: string
  productDescription?: string
  totalPILineValue?: number
  finalCount?: number
  finalValue?: number
  grandTotal?: number
  lastPIDate?: string
  name?: string
  openCount?: number
  openValue?: number
  piDate?: string
  piCount?: number
  piNumber?: string
  previousPIValue?: number
  rank?: number
  status?: string
  totalValue?: number
  totalPIValue?: number
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

export type PIIntelligenceMetric = {
  count: number
  value: number
}

export type PIIntelligenceLatestPI = {
  companyName?: string
  customerName?: string
  grandTotal?: number
  piDate?: string
  piNumber?: string
  status?: string
}

export type PIIntelligenceDailySummary = {
  count: number
  date: string
  value: number
}

export type PIIntelligenceDashboardResponse = {
  success: boolean
  module?: string
  generatedAt?: string
  timezone?: string
  summary?: {
    today?: PIIntelligenceMetric
    month?: PIIntelligenceMetric
    open?: PIIntelligenceMetric
    final?: PIIntelligenceMetric
  }
  latestPIs?: PIIntelligenceLatestPI[]
  dailySummary?: PIIntelligenceDailySummary[]
  message?: string
}

export type PIIntelligenceStatusMetric = PIIntelligenceMetric & {
  percentage: number
  valuePercentage?: number
}

export type PIIntelligenceRankingRow = {
  averagePIValue: number
  finalCount: number
  finalValue?: number
  lastPIDate: string
  name: string
  openCount: number
  openValue?: number
  piCount: number
  rank: number
  totalPIValue: number
}

export type PIIntelligenceTrendRow = {
  count: number
  date: string
  value: number
}

export type PIIntelligenceProDashboardResponse = {
  success: boolean
  module?: string
  generatedAt?: string
  timezone?: string
  period?: {
    today?: string
    yesterday?: string
    weekStart?: string
    weekEnd?: string
    monthStart?: string
    monthEnd?: string
  }
  kpis?: {
    today?: PIIntelligenceMetric
    yesterday?: PIIntelligenceMetric
    week?: PIIntelligenceMetric
    month?: PIIntelligenceMetric
    averagePIValueMonth?: number
    highestPIValueMonth?: number
    lowestPIValueMonth?: number
    averageDailyPICountMonth?: number
    averageDailyPIValueMonth?: number
    open?: PIIntelligenceStatusMetric
    final?: PIIntelligenceStatusMetric
  }
  topCustomer?: PIIntelligenceRankingRow | null
  topCompany?: PIIntelligenceRankingRow | null
  bestDayByCount?: PIIntelligenceTrendRow | null
  bestDayByValue?: PIIntelligenceTrendRow | null
  trend?: PIIntelligenceTrendRow[]
  topCustomers?: PIIntelligenceRankingRow[]
  companyRanking?: PIIntelligenceRankingRow[]
  latestPIs?: PIIntelligenceLatestPI[]
  message?: string
}

export type PIIntelligenceRankingResponse = {
  success: boolean
  error?: string
  message?: string
  rows?: PIIntelligenceRankingRow[]
  groupNote?: string
  startDate?: string
  endDate?: string
  limit?: number
}

export type PISearchFilters = {
  company?: string
  customer?: string
  endDate?: string
  limit?: number
  q?: string
  startDate?: string
  status?: string
}

export type PISearchResponse = {
  success: boolean
  error?: string
  message?: string
  limit?: number
  q?: string
  rows?: PIIntelligenceLatestPI[]
}

export type PIDetailLine = {
  amount: number
  productCode: string
  productDescription: string
  quantity: number
  rate: number
}

export type PIDetailResponse = PIIntelligenceLatestPI & {
  success: boolean
  error?: string
  message?: string
  lines?: PIDetailLine[]
}

export type PIManagementInsightResponse = {
  success: boolean
  generatedAt?: string
  insight?: string
  message?: string
  model?: string | null
  module?: string
  timezone?: string
  verifiedData?: Record<string, unknown>
  wordingMode?: string
}

export type CommercialPeriod = {
  days?: number
  endDate?: string
  label?: string
  startDate?: string
}

export type CommercialChange = {
  absoluteChange?: number
  changePercentage?: number | null
  direction?: 'up' | 'down' | 'flat' | 'new' | string
}

export type CommercialMetric = {
  averagePIValue?: number
  count: number
  finalCount?: number
  finalValue?: number
  openCount?: number
  openValue?: number
  value: number
}

export type CommercialComparison = {
  countChange?: CommercialChange
  current?: CommercialMetric
  previous?: CommercialMetric
  valueChange?: CommercialChange
}

export type CommercialCustomerRow = {
  averagePIValue?: number
  classification?: string
  countChange?: number
  countRank?: number
  currentPICount?: number
  currentPIValue: number
  customerCode?: number
  customerName: string
  finalPICount?: number
  finalPIValue?: number
  firstPIDate?: string
  growthPercentage?: number | null
  highestPIValue?: number
  historicalPICount?: number
  historicalPIValue?: number
  lastPIDate?: string
  lowestPIValue?: number
  openPICount?: number
  openPIValue?: number
  previousPICount?: number
  previousPIValue?: number
  rankByPICount?: number
  rankByPIValue?: number
  shareOfTotalPIValue?: number
  valueChange?: number
  valueChangeAvailable?: boolean
  valueChangeReason?: string
}

export type CommercialInactiveCustomerRow = {
  customerCode?: number
  customerName: string
  daysInactive?: number
  historicalPICount?: number
  historicalPIValue?: number
  lastPIDate?: string
}

export type CommercialReactivatedCustomerRow = {
  customerCode?: number
  customerName: string
  historicalPICount?: number
  inactiveGapDays?: number
  latestPIDate?: string
  latestPINumber?: string
  latestPIValue?: number
}

export type CommercialProductRow = {
  averageQuantityPerPI?: number
  averageRate?: number
  classification?: string
  currentPeriodQuantity?: number
  currentPeriodValue?: number
  distinctCustomers?: number
  distinctPIs?: number
  growthPercentage?: number | null
  latestPIDate?: string
  lineCount?: number
  previousPeriodQuantity?: number
  previousPeriodValue?: number
  productCode: string
  productDescription: string
  quantityGrowthPercentage?: number | null
  rankByPILineValue?: number
  rankByQuantity?: number
  shareOfTotalPILineValue?: number
  totalPILineValue: number
  totalQuantity: number
  valueChange?: number
  valueChangeAvailable?: boolean
  valueChangeReason?: string
}

export type CommercialCompanyRow = {
  averagePIValue?: number
  companyCode?: number
  countGrowthPercentage?: number | null
  companyName: string
  currentPICount?: number
  currentPIValue: number
  finalPICount?: number
  finalPIValue?: number
  lastPIDate?: string
  openPICount?: number
  openPIValue?: number
  previousPICount?: number
  previousPIValue?: number
  rank: number
  shareOfTotalPIValue?: number
  valueGrowthPercentage?: number | null
}

export type CommercialDashboardParams = {
  comparisonMode?: string
  endDate?: string
  period?: string
  startDate?: string
}

export type CommercialDashboardResponse = {
  success: boolean
  comparison?: CommercialComparison
  comparisonMode?: string
  comparisonPeriod?: CommercialPeriod
  concentration?: {
    company?: Record<string, unknown>
    customer?: Record<string, unknown>
    product?: Record<string, unknown>
  }
  customerSummary?: {
    declining?: CommercialCustomerRow[]
    growing?: CommercialCustomerRow[]
    inactive?: CommercialInactiveCustomerRow[]
    ranking?: CommercialCustomerRow[]
    reactivated?: CommercialReactivatedCustomerRow[]
    topByOpenValue?: CommercialCustomerRow[]
  }
  productSummary?: {
    declining?: CommercialProductRow[]
    growing?: CommercialProductRow[]
    ranking?: CommercialProductRow[]
    topByQuantity?: CommercialProductRow[]
  }
  companySummary?: {
    ranking?: CommercialCompanyRow[]
  }
  disclaimer?: string
  generatedAt?: string
  message?: string
  module?: string
  period?: CommercialPeriod
  productDataQuality?: Record<string, unknown>
  managementBrief?: string | null
  thresholds?: Record<string, unknown>
  timezone?: string
}

export type CommercialBriefResponse = {
  success: boolean
  brief?: string
  disclaimer?: string
  generatedAt?: string
  message?: string
  model?: string | null
  module?: string
  timezone?: string
  verifiedData?: Record<string, unknown>
  wordingMode?: string
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

export const getPIIntelligenceDashboard = async (
  options: AskAIOptions = {},
): Promise<PIIntelligenceDashboardResponse> => {
  const timeout = withTimeout()
  const headers: Record<string, string> = {}

  if (options.userName) {
    headers['x-autopal-user'] = options.userName
  }

  try {
    const response = await fetch(AI_ERP_DASHBOARD_URL, {
      headers,
      method: 'GET',
      signal: timeout.signal,
    })
    const body = await parseJsonResponse<PIIntelligenceDashboardResponse>(
      response,
    )

    if (!response.ok) {
      throw new Error(body.message || 'Unable to load the PI Intelligence dashboard.')
    }

    return body
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('PI Intelligence dashboard request timed out.', {
        cause: error,
      })
    }

    if (error instanceof TypeError) {
      throw new Error('PI Intelligence dashboard is unavailable.', {
        cause: error,
      })
    }

    throw error
  } finally {
    timeout.clear()
  }
}

const buildQueryString = (params: Record<string, string | number | undefined>) => {
  const searchParams = new URLSearchParams()

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value))
    }
  })

  const queryString = searchParams.toString()

  return queryString ? `?${queryString}` : ''
}

const buildUserHeaders = (options: AskAIOptions = {}) => {
  const headers: Record<string, string> = {}

  if (options.userName) {
    headers['x-autopal-user'] = options.userName
  }

  return headers
}

const fetchERPJson = async <T>(
  url: string,
  options: AskAIOptions & RequestInit = {},
): Promise<T> => {
  const timeout = withTimeout()
  const headers = {
    ...buildUserHeaders(options),
    ...(options.headers as Record<string, string> | undefined),
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: timeout.signal,
    })
    const body = await parseJsonResponse<T & { message?: string; error?: string }>(
      response,
    )

    if (!response.ok) {
      throw new Error(
        body.message || body.error || 'The PI Intelligence request failed.',
      )
    }

    return body
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('PI Intelligence request timed out.', {
        cause: error,
      })
    }

    if (error instanceof TypeError) {
      throw new Error('PI Intelligence service is unavailable.', {
        cause: error,
      })
    }

    throw error
  } finally {
    timeout.clear()
  }
}

export const getPIIntelligenceProDashboard = (
  options: AskAIOptions = {},
): Promise<PIIntelligenceProDashboardResponse> =>
  fetchERPJson<PIIntelligenceProDashboardResponse>(AI_ERP_PRO_DASHBOARD_URL, {
    method: 'GET',
    ...options,
  })

export const getPICustomerRanking = (
  params: PISearchFilters & { period?: string } = {},
  options: AskAIOptions = {},
): Promise<PIIntelligenceRankingResponse> =>
  fetchERPJson<PIIntelligenceRankingResponse>(
    `${AI_ERP_CUSTOMER_RANKING_URL}${buildQueryString(params)}`,
    {
      method: 'GET',
      ...options,
    },
  )

export const getPICompanyRanking = (
  params: PISearchFilters & { period?: string } = {},
  options: AskAIOptions = {},
): Promise<PIIntelligenceRankingResponse> =>
  fetchERPJson<PIIntelligenceRankingResponse>(
    `${AI_ERP_COMPANY_RANKING_URL}${buildQueryString(params)}`,
    {
      method: 'GET',
      ...options,
    },
  )

export const searchPIs = (
  params: PISearchFilters,
  options: AskAIOptions = {},
): Promise<PISearchResponse> =>
  fetchERPJson<PISearchResponse>(
    `${AI_ERP_PI_SEARCH_URL}${buildQueryString(params)}`,
    {
      method: 'GET',
      ...options,
    },
  )

export const getPIDetail = (
  piNumber: string,
  options: AskAIOptions = {},
): Promise<PIDetailResponse> =>
  fetchERPJson<PIDetailResponse>(
    `${AI_ERP_PI_DETAIL_URL}/${encodeURIComponent(piNumber)}`,
    {
      method: 'GET',
      ...options,
    },
  )

export const getPIManagementInsight = (
  options: AskAIOptions = {},
): Promise<PIManagementInsightResponse> =>
  fetchERPJson<PIManagementInsightResponse>(AI_ERP_INSIGHT_URL, {
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
    ...options,
  })

export const getCommercialDashboard = (
  params: CommercialDashboardParams = {},
  options: AskAIOptions = {},
): Promise<CommercialDashboardResponse> =>
  fetchERPJson<CommercialDashboardResponse>(
    `${AI_COMMERCIAL_DASHBOARD_URL}${buildQueryString(params)}`,
    {
      method: 'GET',
      ...options,
    },
  )

export const getCommercialManagementBrief = (
  params: CommercialDashboardParams = {},
  options: AskAIOptions = {},
): Promise<CommercialBriefResponse> =>
  fetchERPJson<CommercialBriefResponse>(AI_COMMERCIAL_BRIEF_URL, {
    body: JSON.stringify(params),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
    ...options,
  })

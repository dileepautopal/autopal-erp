import {
  EXECUTIVE_DISCLAIMER,
  EXECUTIVE_TIMEZONE,
  clampExecutiveLimit,
  safeRound,
} from './executiveCockpitUtils.js'
import {
  escapeLikePattern,
  getIndiaDateString,
  mapStatusFilter,
  toNumber,
  toText,
} from './piIntelligenceUtils.js'

export const EXECUTIVE_DRILLDOWN_MODULE = 'Executive Drill-Down'
export const EXECUTIVE_SEARCH_MODULE = 'Executive Search'
export const EXECUTIVE_EXPLAIN_MODULE = 'Executive Drill-Down Explanation'

export const EXECUTIVE_DRILLDOWN_LIMITS = {
  companyRows: 50,
  customerRows: 100,
  defaultCompanyRows: 20,
  defaultRows: 50,
  defaultSearchRows: 20,
  maxRows: 200,
  productRows: 100,
  searchRows: 100,
}

export const EXECUTIVE_DRILLDOWN_TYPES = new Set([
  'today-pis',
  'yesterday-pis',
  'week-pis',
  'month-pis',
  'previous-month-pis',
  'open-pis',
  'final-pis',
  'highest-pi',
  'lowest-pi',
  'top-customer',
  'top-product',
  'top-company',
  'customer-concentration',
  'product-concentration',
  'daily-trend-date',
  'growing-customers',
  'declining-customers',
  'new-customers',
  'inactive-customers',
  'reactivated-customers',
  'large-pi',
  'no-today-activity',
  'consecutive-no-pi-activity',
  'month-comparison',
  'customer-detail',
  'product-detail',
  'company-detail',
  'pi-detail',
])

const TYPE_TITLES = {
  'consecutive-no-pi-activity': 'Consecutive No PI Activity',
  'customer-concentration': 'Customer Concentration',
  'customer-detail': 'Customer Detail',
  'daily-trend-date': 'Daily PI Activity',
  'declining-customers': 'Declining Customers',
  'final-pis': 'Final PIs',
  'growing-customers': 'Growing Customers',
  'highest-pi': 'Highest PI',
  'inactive-customers': 'Inactive Customers',
  'large-pi': 'Large PI',
  'lowest-pi': 'Lowest PI',
  'month-comparison': 'Month Comparison',
  'month-pis': 'This Month PIs',
  'new-customers': 'New Customers',
  'no-today-activity': 'No PI Activity Today',
  'open-pis': 'Open PIs',
  'pi-detail': 'PI Detail',
  'previous-month-pis': 'Previous Month PIs',
  'product-concentration': 'Product Concentration',
  'product-detail': 'Product Detail',
  'reactivated-customers': 'Reactivated Customers',
  'today-pis': 'Today PIs',
  'top-company': 'Top Company',
  'top-customer': 'Top Customer',
  'top-product': 'Top Product',
  'week-pis': 'This Week PIs',
  'yesterday-pis': 'Yesterday PIs',
}

export const getDrillDownTitle = (type) =>
  TYPE_TITLES[toText(type)] ?? 'Executive Drill-Down'

export const getDrillDownMeta = (type) => ({
  disclaimer: EXECUTIVE_DISCLAIMER,
  generatedAt: new Date().toISOString(),
  module: EXECUTIVE_DRILLDOWN_MODULE,
  title: getDrillDownTitle(type),
  timezone: EXECUTIVE_TIMEZONE,
  type,
})

export const getSearchMeta = () => ({
  disclaimer: EXECUTIVE_DISCLAIMER,
  generatedAt: new Date().toISOString(),
  module: EXECUTIVE_SEARCH_MODULE,
  timezone: EXECUTIVE_TIMEZONE,
})

export const getExplainMeta = () => ({
  disclaimer: EXECUTIVE_DISCLAIMER,
  generatedAt: new Date().toISOString(),
  module: EXECUTIVE_EXPLAIN_MODULE,
  timezone: EXECUTIVE_TIMEZONE,
})

export const normalizeDrillDownType = (type) =>
  toText(type).toLowerCase().replace(/[\s_]+/g, '-')

export const clampDrillDownLimit = (limit, maxLimit = EXECUTIVE_DRILLDOWN_LIMITS.maxRows) =>
  clampExecutiveLimit(limit, maxLimit, EXECUTIVE_DRILLDOWN_LIMITS.defaultRows)

export const getPagination = ({ limit, rows }) => ({
  hasMore: Array.isArray(rows) && rows.length > limit,
  limit,
  returned: Math.min(Array.isArray(rows) ? rows.length : 0, limit),
})

export const takeLimit = (rows, limit) => (Array.isArray(rows) ? rows.slice(0, limit) : [])

export const makeLike = (value) => `%${escapeLikePattern(value)}%`

export const normalizePINumber = (value) => {
  const text = toText(value).toUpperCase().replace(/\s+/g, '')
  const match = text.match(/^([A-Z]+-?)(\d{1,8})$/)

  if (!match) {
    return text
  }

  return `${match[1]}${String(Number(match[2])).padStart(4, '0')}`
}

export const normalizeProductCode = (value) => toText(value).toUpperCase()

export const normalizeIntegerIdentifier = (value) => {
  const number = Number(value)

  return Number.isInteger(number) && number > 0 ? number : null
}

export const normalizeStatus = (value) => mapStatusFilter(value)

export const hasUnsafeSearchText = (value) => toText(value).length > 120

export const buildAppliedFilters = (filters = {}) =>
  Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  )

export const mapPIRow = (row) => ({
  companyCode: row.company_code === null || row.company_code === undefined ? null : toNumber(row.company_code),
  companyName: row.company_name ?? '',
  customerCode: row.customer_code === null || row.customer_code === undefined ? null : toNumber(row.customer_code),
  customerName: row.customer_name ?? '',
  grandTotal: safeRound(row.grand_total),
  piDate: row.pi_date ?? '',
  piNumber: row.pi_number ?? '',
  status: row.status ?? '',
})

export const mapPILineRow = (row) => ({
  amount: safeRound(row.amount),
  companyCode: row.company_code === null || row.company_code === undefined ? null : toNumber(row.company_code),
  companyName: row.company_name ?? '',
  customerCode: row.customer_code === null || row.customer_code === undefined ? null : toNumber(row.customer_code),
  customerName: row.customer_name ?? '',
  piDate: row.pi_date ?? '',
  piNumber: row.pi_number ?? '',
  productCode: row.product_code ?? '',
  productDescription: row.product_description ?? '',
  quantity: safeRound(row.quantity),
  rate: safeRound(row.rate),
  status: row.status ?? '',
})

export const makeSummaryCard = (label, value, type = 'text') => ({
  label,
  type,
  value,
})

export const todayOrDefault = (today) => today || getIndiaDateString()

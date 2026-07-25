const BUSINESS_SUFFIX_CANONICAL = new Map([
  ['CO', 'COMPANY'],
  ['COMPANY', 'COMPANY'],
  ['CORP', 'CORPORATION'],
  ['CORPORATION', 'CORPORATION'],
  ['ENTERPRISE', 'ENTERPRISE'],
  ['ENTERPRISES', 'ENTERPRISE'],
  ['INDUSTRIES', 'INDUSTRY'],
  ['INDUSTRY', 'INDUSTRY'],
  ['LIMITED', 'LIMITED'],
  ['LLP', 'LLP'],
  ['LTD', 'LIMITED'],
  ['PRIVATE', 'PRIVATE'],
  ['PVT', 'PRIVATE'],
  ['TRADER', 'TRADER'],
  ['TRADERS', 'TRADER'],
])

const BUSINESS_SUFFIX_WORDS = new Set(BUSINESS_SUFFIX_CANONICAL.keys())

const PLURAL_VARIATION_LABELS = new Map([
  ['ENTERPRISE', 'Enterprise/Enterprises'],
  ['INDUSTRY', 'Industry/Industries'],
  ['TRADER', 'Trader/Traders'],
])

const toText = (value) => String(value ?? '').trim()

const compactSpaces = (value) => toText(value).replace(/\s+/g, ' ').trim()

const canonicalToken = (token) => BUSINESS_SUFFIX_CANONICAL.get(token) ?? token

export const normalizeCustomerNameForMatch = (value) => {
  const cleaned = compactSpaces(value)
    .toUpperCase()
    .replace(/\bM\s*\/?\s*S\b\.?/g, ' ')
    .replace(/\bMESSRS\b\.?/g, ' ')
    .replace(/&/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(/[^A-Z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const tokens = cleaned ? cleaned.split(' ') : []
  const canonicalTokens = tokens.map(canonicalToken)
  const significantTokens = tokens.filter((token) => !BUSINESS_SUFFIX_WORDS.has(token))
  const canonicalSignificantTokens = canonicalTokens.filter(
    (token, index) => !BUSINESS_SUFFIX_WORDS.has(tokens[index]),
  )
  const suffixTokens = tokens.filter((token) => BUSINESS_SUFFIX_WORDS.has(token))

  return {
    canonicalFull: canonicalTokens.join(' '),
    canonicalSignificant: canonicalSignificantTokens.join(' '),
    compactCanonicalFull: canonicalTokens.join(''),
    compactNormalized: tokens.join(''),
    compactSignificant: canonicalSignificantTokens.join(''),
    normalized: tokens.join(' '),
    significant: significantTokens.join(' '),
    significantTokens,
    suffixTokens,
    tokens,
  }
}

export const getCustomerNameSearchTokens = (value) => {
  const normalized = normalizeCustomerNameForMatch(value)
  const tokens = normalized.significantTokens.length > 0
    ? normalized.significantTokens
    : normalized.tokens

  return [...new Set(tokens.filter((token) => token.length >= 2))].slice(0, 5)
}

const levenshteinDistance = (left, right) => {
  if (left === right) {
    return 0
  }

  if (!left) {
    return right.length
  }

  if (!right) {
    return left.length
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array(right.length + 1)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      )
    }

    previous.splice(0, previous.length, ...current)
  }

  return previous[right.length]
}

const getStringSimilarity = (left, right) => {
  if (!left && !right) {
    return 0
  }

  if (left === right) {
    return 1
  }

  const maxLength = Math.max(left.length, right.length)

  return maxLength > 0
    ? Math.max(0, 1 - levenshteinDistance(left, right) / maxLength)
    : 0
}

const getTokenSimilarity = (leftTokens, rightTokens) => {
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0
  }

  const rightSet = new Set(rightTokens)
  const commonCount = leftTokens.filter((token) => rightSet.has(token)).length

  return (2 * commonCount) / (leftTokens.length + rightTokens.length)
}

const hasOnlyLowImportanceDifference = (left, right) =>
  left.compactSignificant &&
  left.compactSignificant === right.compactSignificant &&
  left.normalized !== right.normalized

const getPluralVariationReason = (left, right) => {
  const leftCanonicalSuffixes = new Set(left.suffixTokens.map(canonicalToken))
  const rightCanonicalSuffixes = new Set(right.suffixTokens.map(canonicalToken))
  const variation = [...leftCanonicalSuffixes].find((suffix) =>
    rightCanonicalSuffixes.has(suffix) && PLURAL_VARIATION_LABELS.has(suffix),
  )

  return variation ? `Plural variation (${PLURAL_VARIATION_LABELS.get(variation)})` : ''
}

const getConfidenceBandReason = (confidence) => {
  if (confidence === 100) {
    return 'Exact normalized customer name match'
  }

  if (confidence >= 95) {
    return 'Very strong fuzzy customer name match'
  }

  if (confidence >= 90) {
    return 'Strong fuzzy customer name match'
  }

  if (confidence >= 80) {
    return 'Possible fuzzy customer name match'
  }

  return 'Customer name below fuzzy match threshold'
}

export const compareCustomerNames = (inputName, candidateName) => {
  const input = normalizeCustomerNameForMatch(inputName)
  const candidate = normalizeCustomerNameForMatch(candidateName)

  if (!input.normalized || !candidate.normalized) {
    return {
      confidence: 0,
      matchReason: 'Customer name missing',
    }
  }

  if (
    input.normalized === candidate.normalized ||
    input.compactNormalized === candidate.compactNormalized
  ) {
    return {
      confidence: 100,
      matchReason: 'Exact normalized customer name match',
    }
  }

  if (input.canonicalFull === candidate.canonicalFull) {
    return {
      confidence: 99,
      matchReason:
        getPluralVariationReason(input, candidate) ||
        'Business suffix variation',
    }
  }

  if (hasOnlyLowImportanceDifference(input, candidate)) {
    return {
      confidence: 98,
      matchReason:
        getPluralVariationReason(input, candidate) ||
        'Business suffix ignored during customer match',
    }
  }

  const significantSimilarity = getStringSimilarity(
    input.canonicalSignificant || input.canonicalFull,
    candidate.canonicalSignificant || candidate.canonicalFull,
  )
  const fullSimilarity = getStringSimilarity(input.canonicalFull, candidate.canonicalFull)
  const tokenSimilarity = getTokenSimilarity(
    input.canonicalSignificant ? input.canonicalSignificant.split(' ') : input.tokens,
    candidate.canonicalSignificant
      ? candidate.canonicalSignificant.split(' ')
      : candidate.tokens,
  )
  const confidence = Math.round(
    Math.max(
      significantSimilarity * 0.7 + fullSimilarity * 0.3,
      tokenSimilarity * 0.9,
      fullSimilarity,
    ) * 100,
  )

  return {
    confidence,
    matchReason: getConfidenceBandReason(confidence),
  }
}

export const CUSTOMER_MATCH_THRESHOLD = 80

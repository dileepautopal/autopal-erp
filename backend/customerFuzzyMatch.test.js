import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareCustomerNames,
  CUSTOMER_MATCH_THRESHOLD,
  normalizeCustomerNameForMatch,
} from './customerFuzzyMatch.js'

const assertMatched = (inputName, databaseName, minimumConfidence = 95) => {
  const match = compareCustomerNames(inputName, databaseName)

  assert.ok(
    match.confidence >= minimumConfidence,
    `${inputName} vs ${databaseName} confidence ${match.confidence} should be >= ${minimumConfidence}`,
  )
  assert.ok(match.confidence >= CUSTOMER_MATCH_THRESHOLD)
  assert.ok(match.matchReason)

  return match
}

test('normalizes customer names before fuzzy matching', () => {
  const normalized = normalizeCustomerNameForMatch(' M/s. ABC & Traders, Pvt. Ltd. ')

  assert.equal(normalized.normalized, 'ABC TRADERS PVT LTD')
  assert.equal(normalized.significant, 'ABC')
})

test('matches singular and plural enterprise suffixes', () => {
  const match = assertMatched('Jalaram Enterprise', 'Jalaram Enterprises', 99)

  assert.equal(match.confidence, 99)
  assert.match(match.matchReason, /Plural variation/i)
})

test('matches M/s ABC Traders with ABC Trader', () => {
  const match = assertMatched('M/s ABC Traders', 'ABC Trader', 99)

  assert.equal(match.confidence, 99)
})

test('matches private limited suffix variation', () => {
  const match = assertMatched('XYZ Pvt Ltd', 'XYZ Limited', 95)

  assert.ok(match.confidence >= 95)
  assert.match(match.matchReason, /suffix/i)
})

test('matches singular and plural industry suffixes', () => {
  const match = assertMatched('Sharma Industries', 'Sharma Industry', 99)

  assert.equal(match.confidence, 99)
  assert.match(match.matchReason, /Plural variation/i)
})

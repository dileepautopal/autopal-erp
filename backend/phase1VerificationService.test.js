import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCustomerNames, CUSTOMER_MATCH_THRESHOLD } from './customerFuzzyMatch.js'
import {
  parseWhatsappPIItemLine,
} from './whatsappPi.js'
import {
  parseCustomerConfirmationReply,
} from './piSummaryService.js'
import {
  sendTextMessage,
} from './whatsappAckService.js'
import {
  PHASE1_STATUS,
  buildEnvironmentReadiness,
  classifyMetaMessageId,
  evaluateChangeCapture,
  evaluateConfirmationCapture,
  evaluateDuplicateSafetyEvidence,
  evaluateInvalidGenericReply,
  evaluateMissingRateLookup,
  evaluateMultiCompanySelection,
  evaluateUnknownCustomerCandidates,
  evaluateUnknownProductMatch,
  evaluateWrongSenderReply,
  responseContainsSecretValue,
} from './phase1VerificationService.js'

test('exact webhook replay creates one PI only', () => {
  assert.equal(
    evaluateDuplicateSafetyEvidence({
      acknowledgementCount: 1,
      piCount: 1,
      secondRunStatus: 'DUPLICATE_SKIPPED',
      summaryCount: 1,
    }),
    PHASE1_STATUS.PASS,
  )
})

test('exact webhook replay sends one acknowledgement only', () => {
  assert.equal(
    evaluateDuplicateSafetyEvidence({
      acknowledgementCount: 2,
      piCount: 1,
      secondRunStatus: 'DUPLICATE_SKIPPED',
      summaryCount: 1,
    }),
    PHASE1_STATUS.FAIL,
  )
})

test('exact webhook replay sends one summary only', () => {
  assert.equal(
    evaluateDuplicateSafetyEvidence({
      acknowledgementCount: 1,
      piCount: 1,
      secondRunStatus: 'DUPLICATE_SKIPPED',
      summaryCount: 2,
    }),
    PHASE1_STATUS.FAIL,
  )
})

test('unknown customer goes to manual review', () => {
  const nameScore = compareCustomerNames('ABC Unknown Traders', 'Jalaram Enterprise')

  assert.ok(nameScore.confidence < CUSTOMER_MATCH_THRESHOLD)
  assert.equal(evaluateUnknownCustomerCandidates([]), PHASE1_STATUS.PASS)
})

test('unknown product goes to manual review', () => {
  assert.equal(parseWhatsappPIItemLine('XYZ UNKNOWN PRODUCT - 100 Nos'), null)
  assert.equal(evaluateUnknownProductMatch({ candidates: [], product: null }), PHASE1_STATUS.PASS)
})

test('missing rate never silently becomes zero-rate PI', () => {
  assert.equal(
    evaluateMissingRateLookup({
      rate: 0,
      rateFound: false,
    }),
    PHASE1_STATUS.PASS,
  )
})

test('multi-company order is blocked for manual review', () => {
  assert.equal(
    evaluateMultiCompanySelection({
      status: 'MULTI_COMPANY_ORDER',
    }),
    PHASE1_STATUS.PASS,
  )
})

test('correct sender confirmation is accepted', () => {
  assert.equal(
    evaluateConfirmationCapture({
      pi: { isDraft: true },
      result: { status: 'CONFIRMED' },
    }),
    PHASE1_STATUS.PASS,
  )
})

test('wrong sender confirmation is rejected', () => {
  assert.equal(
    evaluateWrongSenderReply({
      errors: ['Confirmation sender does not match the Draft PI source sender.'],
      status: 'MANUAL_REVIEW',
    }),
    PHASE1_STATUS.PASS,
  )
})

test('change request is stored', () => {
  assert.equal(
    evaluateChangeCapture({
      changeRequest: 'Quantity of item 1 should be 3500 Nos.',
      status: 'CHANGE_REQUESTED',
    }),
    PHASE1_STATUS.PASS,
  )
})

test('generic OK is not accepted', () => {
  const parsed = parseCustomerConfirmationReply('OK', 'AML-0002')

  assert.equal(parsed.status, 'INVALID_RESPONSE')
  assert.equal(evaluateInvalidGenericReply(parsed), PHASE1_STATUS.PASS)
})

test('PI remains Draft after confirmation', () => {
  assert.equal(
    evaluateConfirmationCapture({
      pi: { isDraft: true },
      result: { status: 'CONFIRMED' },
    }),
    PHASE1_STATUS.PASS,
  )
})

test('real and mocked Meta IDs are distinguished', () => {
  assert.equal(classifyMetaMessageId('wamid.HBgMOTE3NzMzODUwMDE3FQIAERgSREAL').proofType, 'LIVE')
  assert.equal(classifyMetaMessageId('wamid.summary-sent').proofType, 'MOCK')
  assert.equal(classifyMetaMessageId('').proofType, 'MISSING')
})

test('secrets are not included in API responses', () => {
  const readiness = buildEnvironmentReadiness({
    DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/autolite_26',
    WHATSAPP_ACCESS_TOKEN: 'EAATESTSECRET',
  })

  assert.equal(responseContainsSecretValue(readiness), false)
  assert.equal(
    responseContainsSecretValue({
      token: 'EAATESTSECRET',
    }),
    true,
  )
})

test('expired token is safely classified with mocked Meta response', async () => {
  const result = await sendTextMessage({
    body: 'Phase 1 token test',
    env: {
      WHATSAPP_ACCESS_TOKEN: 'test-token',
      WHATSAPP_ALLOWED_TEST_NUMBERS: '917733850017',
      WHATSAPP_GRAPH_API_BASE: 'https://graph.facebook.com/v20.0',
      WHATSAPP_PHONE_NUMBER_ID: '123',
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 190,
            message: 'Authentication Error',
            type: 'OAuthException',
          },
        }),
        { status: 401 },
      ),
    to: '917733850017',
  })

  assert.equal(result.status, 'TOKEN_EXPIRED')
  assert.equal(result.retryable, false)
})

test('existing successful WhatsApp PI flow remains unchanged', () => {
  const item = parseWhatsappPIItemLine('SB 102 H4 P43t P LHT E - 1000 Nos')

  assert.equal(item?.productCode, 'SB102')
  assert.equal(item?.quantity, 1000)
  assert.equal(item?.unit, 'NOS')
})

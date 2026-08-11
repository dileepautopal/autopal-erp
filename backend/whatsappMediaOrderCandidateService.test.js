import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MEDIA_ORDER_PARSE_STATUSES,
  parseExtractedWhatsAppMediaOrderCandidate,
  parseMediaOrderCandidateText,
} from './whatsappMediaOrderCandidateService.js'

const createPool = (initialRow = {}) => {
  const state = {
    businessLookupAttempts: 0,
    parseUpdates: 0,
    row: {
      id: 1,
      message_id: 'wamid.candidate-test',
      media_extraction_status: 'EXTRACTED',
      media_extracted_text: 'HEAD LAMP RH QTY 10 NOS',
      media_order_parse_status: 'PENDING',
      media_order_candidate: null,
      media_order_parsed_at: null,
      media_order_parse_error: null,
      pi_created: false,
      ...initialRow,
    },
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/SELECT[\s\S]+FROM\s+tran_whatsapp_pi_messages/i.test(sql)) {
        return state.row ? { rowCount: 1, rows: [state.row] } : { rowCount: 0, rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql) && /media_order_parse_status/i.test(sql)) {
        state.parseUpdates += 1
        const candidate = params[2] ? JSON.parse(params[2]) : null
        state.row = {
          ...state.row,
          media_order_candidate: candidate ?? state.row.media_order_candidate,
          media_order_parse_error: params[3],
          media_order_parse_status: params[1],
          media_order_parsed_at: ['PARSED', 'PARSE_PARTIAL', 'NO_ORDER_LINES'].includes(params[1])
            ? '2026-08-11T10:00:00.000Z'
            : state.row.media_order_parsed_at,
        }
        return { rowCount: 1, rows: [state.row] }
      }

      if (/master_customer|master_products|company_category|trading_rate|master_pi_rmkt|tran_pi_rmkt|whatsapp_send_log/i.test(sql)) {
        state.businessLookupAttempts += 1
        throw new Error('Phase 2.4 must not perform ERP lookups, PI creation, or outgoing sends.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

test('simple single line extracts quantity and normalized unit', () => {
  const result = parseMediaOrderCandidateText('HEAD LAMP RH QTY 10 NOS')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].raw_description, 'HEAD LAMP RH')
  assert.equal(result.candidate.lines[0].quantity, 10)
  assert.equal(result.candidate.lines[0].raw_quantity, '10')
  assert.equal(result.candidate.lines[0].unit, 'NOS')
})

test('labelled quantity without a unit is retained without inventing a unit', () => {
  const result = parseMediaOrderCandidateText('HEAD LAMP RH Qty 12')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(result.candidate.lines[0].raw_description, 'HEAD LAMP RH')
  assert.equal(result.candidate.lines[0].quantity, 12)
  assert.equal(result.candidate.lines[0].unit, '')
})

test('multiple lines create multiple candidates', () => {
  const result = parseMediaOrderCandidateText('HEAD LAMP RH 10 NOS\nTAIL LAMP LH 20 NOS')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [10, 20])
  assert.deepEqual(result.candidate.lines.map((line) => line.raw_description), ['HEAD LAMP RH', 'TAIL LAMP LH'])
})

test('table-like OCR retains four descriptions and quantities without treating rates as prices', () => {
  const result = parseMediaOrderCandidateText([
    'HEAD LIGHT ASSY ACE MEGA 12.00 Nos 707.00',
    'HL-228 S - H3 FOG LAMP SMALL 54.00 Nos 82.49',
    'HL230S 100MM FOG LAMP 36.00 Nos 124.91',
    'TT TAIL LAMP ASSY 32.00 Nos 247.46',
  ].join('\n'))

  assert.equal(result.candidate.lines.length, 4)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
  assert.equal(result.candidate.lines.some((line) => 'price' in line || 'source_rate' in line), false)
})

test('multiline wrapped row joins description to the following quantity line', () => {
  const result = parseMediaOrderCandidateText('1 HEAD LIGHT ASSY ACE MEGA\n12.00 Nos 707.00')
  const line = result.candidate.lines[0]

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(line.sequence, 1)
  assert.equal(line.raw_description, 'HEAD LIGHT ASSY ACE MEGA')
  assert.equal(line.quantity, 12)
  assert.equal(line.source_line_number, 1)
  assert.equal(line.source_text, '1 HEAD LIGHT ASSY ACE MEGA\n12.00 Nos 707.00')
})

test('wrapped row keeps the first clean quantity when a later number also has NOS', () => {
  const result = parseMediaOrderCandidateText([
    'HEAD LIGHT ASSY ACE MEGA',
    '12.00 Nos',
    '707.00 Nos',
  ].join('\n'))

  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].quantity, 12)
})

test('attached OCR marks after NOS keep the first quantity before a later NOS value', () => {
  const noisySuffixes = ['Nos+\u201d', 'Nos+\u00e2\u20ac\u009d']

  for (const noisyUnit of noisySuffixes) {
    const quantityLine = `12.00 ${noisyUnit} 707.00 Nos`
    const result = parseMediaOrderCandidateText([
      'HEAD LIGHT ASSY ACE MEGA',
      quantityLine,
    ].join('\n'))
    const line = result.candidate.lines[0]

    assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED, noisyUnit)
    assert.equal(result.candidate.lines.length, 1, noisyUnit)
    assert.equal(line.raw_description, 'HEAD LIGHT ASSY ACE MEGA', noisyUnit)
    assert.equal(line.raw_quantity, '12.00', noisyUnit)
    assert.equal(line.quantity, 12, noisyUnit)
    assert.equal(line.unit, 'NOS', noisyUnit)
    assert.equal(line.source_text, `HEAD LIGHT ASSY ACE MEGA\n${quantityLine}`, noisyUnit)
  }
})

test('clean second product row keeps 54 before a later NOS value', () => {
  const result = parseMediaOrderCandidateText([
    'HL-228 S - H3 FOG LAMP SMALL',
    '54.00 Nos',
    '82.49 Nos',
  ].join('\n'))

  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].quantity, 54)
  assert.equal(result.candidate.lines[0].unit, 'NOS')
})

test('Nox apostrophe OCR unit keeps the earlier quantity instead of the later rate', () => {
  const result = parseMediaOrderCandidateText([
    'HL230S 100MM FOG LAMP',
    '36.00 Nox’',
    '124.91 Nos',
  ].join('\n'))
  const line = result.candidate.lines[0]

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(result.candidate.lines.length, 1)
  assert.equal(line.raw_description, 'HL230S 100MM FOG LAMP')
  assert.equal(line.quantity, 36)
  assert.equal(line.unit, 'NOS')
  assert.equal(line.source_text, 'HL230S 100MM FOG LAMP\n36.00 Nox’')
})

test('Nog period OCR unit keeps the earlier quantity instead of the later rate', () => {
  const result = parseMediaOrderCandidateText([
    'TT TAIL LAMP ASSY',
    '32.00 Nog.',
    '247.46 Nos',
  ].join('\n'))
  const line = result.candidate.lines[0]

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(result.candidate.lines.length, 1)
  assert.equal(line.raw_description, 'TT TAIL LAMP ASSY')
  assert.equal(line.quantity, 32)
  assert.equal(line.unit, 'NOS')
})

test('delayed live Nog quantity disambiguates an earlier clean NOS rate across numeric-only rows', () => {
  const result = parseMediaOrderCandidateText([
    '4 TT TAIL LAMP ASSY',
    '247.46 Nos',
    '7,918.72',
    '32.00 Nog.',
  ].join('\n'))
  const line = result.candidate.lines[0]

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(result.candidate.lines.length, 1)
  assert.equal(line.sequence, 4)
  assert.equal(line.raw_description, 'TT TAIL LAMP ASSY')
  assert.equal(line.raw_quantity, '32.00')
  assert.equal(line.quantity, 32)
  assert.equal(line.unit, 'NOS')
  assert.equal(line.source_line_number, 1)
  assert.equal(line.source_text, [
    '4 TT TAIL LAMP ASSY',
    '247.46 Nos',
    '7,918.72',
    '32.00 Nog.',
  ].join('\n'))
})

test('delayed noisy quantity cannot cross another readable description', () => {
  const result = parseMediaOrderCandidateText([
    '4 TT TAIL LAMP ASSY',
    '247.46 Nos',
    'UNRELATED READABLE DESCRIPTION',
    '32.00 Nog.',
  ].join('\n'))

  assert.equal(result.candidate.lines[0].quantity, 247.46)
})

test('supported NOS OCR variants normalize conservatively to NOS', () => {
  const variants = ['Nos', 'NOS', 'nos', 'NoS', 'Nox', "Nox'", 'Nox’', 'Noxâ€™', 'Nog', 'Nog.', 'N0s', 'N0S']

  for (const variant of variants) {
    const result = parseMediaOrderCandidateText(`HEAD LAMP 12 ${variant}`)

    assert.equal(result.candidate.lines.length, 1, variant)
    assert.equal(result.candidate.lines[0].quantity, 12, variant)
    assert.equal(result.candidate.lines[0].unit, 'NOS', variant)
  }
})

test('arbitrary word after a decimal is not accepted as a quantity unit', () => {
  const result = parseMediaOrderCandidateText('HEAD LAMP\n707.00 RATE')
  const arbitraryAttachedSuffix = parseMediaOrderCandidateText('HEAD LAMP\n12.00 Nos+RATE')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES)
  assert.deepEqual(result.candidate.lines, [])
  assert.equal(arbitraryAttachedSuffix.status, MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES)
  assert.deepEqual(arbitraryAttachedSuffix.candidate.lines, [])
})

test('later numeric fields cannot overwrite an earlier recognized noisy NOS quantity', () => {
  const result = parseMediaOrderCandidateText([
    'HEAD LAMP',
    '12.00 Nox',
    '707.00 Nos',
    '8484.00',
  ].join('\n'))

  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].quantity, 12)
  assert.equal(result.candidate.lines[0].unit, 'NOS')
})

test('live photographed invoice OCR sample retains quantities 12, 54, 36, and 32', () => {
  const result = parseMediaOrderCandidateText([
    '1 HEAD LIGHT ASSY ACE MEGA',
    '12.00 Nos+\u00e2\u20ac\u009d 707.00 Nos',
    '',
    '2 HL-228 S - H3 FOG LAMP SMALL',
    '54.00 Nos',
    '82.49 Nos',
    '',
    '3 HL230S 100MM FOG LAMP',
    '36.00 Nox’',
    '124.91 Nos',
    '',
    '4 TT TAIL LAMP ASSY',
    '247.46 Nos',
    '7,918.72',
    '32.00 Nog.',
  ].join('\n'))

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
  assert.deepEqual(result.candidate.lines.map((line) => line.unit), ['NOS', 'NOS', 'NOS', 'NOS'])
  assert.deepEqual(result.candidate.lines.map((line) => line.raw_description), [
    'HEAD LIGHT ASSY ACE MEGA',
    'HL-228 S - H3 FOG LAMP SMALL',
    'HL230S 100MM FOG LAMP',
    'TT TAIL LAMP ASSY',
  ])
})

test('real wrapped debit note sample produces four candidate lines', () => {
  const result = parseMediaOrderCandidateText([
    'GST Debit Note',
    '',
    'Description of Goods',
    '1 HEAD LIGHT ASSY ACE MEGA',
    '12.00 Nos 707.00',
    '',
    '2 HL-228 S - H3 FOG LAMP SMALL',
    '54.00 Nos 82.49',
    '',
    '3 HL230S 100MM FOG LAMP',
    '36.00 Nos 124.91',
    '',
    '4 TT TAIL LAMP ASSY',
    '32.00 Nos 247.46',
  ].join('\n'))

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.deepEqual(result.candidate.lines.map((line) => line.quantity), [12, 54, 36, 32])
  assert.deepEqual(result.candidate.lines.map((line) => line.raw_description), [
    'HEAD LIGHT ASSY ACE MEGA',
    'HL-228 S - H3 FOG LAMP SMALL',
    'HL230S 100MM FOG LAMP',
    'TT TAIL LAMP ASSY',
  ])
})

test('header and footer noise is not emitted as product candidates', () => {
  const result = parseMediaOrderCandidateText([
    'GSTIN 24ABCDE1234F1Z5',
    'Debit Note No 125',
    'HEAD LAMP RH 10 PCS',
    'IGST 18%',
    'Rounding Off 0.25',
    'Total 1000.00',
    'Authorised Signatory',
  ].join('\n'))

  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].raw_description, 'HEAD LAMP RH')
})

test('ambiguous quantity is null and records a warning instead of inventing one', () => {
  const result = parseMediaOrderCandidateText('HEAD LIGHT ASSY ACE MEGA ??? Nos')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSE_PARTIAL)
  assert.equal(result.candidate.lines.length, 1)
  assert.equal(result.candidate.lines[0].quantity, null)
  assert.ok(result.candidate.lines[0].warnings.length > 0)
  assert.ok(result.candidate.warnings.length > 0)
})

test('malformed OCR does not crash and returns a safe no-lines result', () => {
  const result = parseMediaOrderCandidateText('~~~ ||| ^^^\nHEAD ???')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES)
  assert.deepEqual(result.candidate.lines, [])
  assert.ok(result.candidate.warnings.length > 0)
})

test('empty extracted text returns NO_ORDER_LINES', () => {
  const result = parseMediaOrderCandidateText('')

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.NO_ORDER_LINES)
  assert.deepEqual(result.candidate.lines, [])
})

test('persistence does not run unless extraction is EXTRACTED', async () => {
  const pool = createPool({ media_extraction_status: 'EXTRACTING' })
  const result = await parseExtractedWhatsAppMediaOrderCandidate({
    messageId: 'wamid.candidate-test',
    pool,
  })

  assert.equal(result.skipped, true)
  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PENDING)
  assert.equal(pool.state.parseUpdates, 0)
})

test('successful persistence is idempotent on the same message row', async () => {
  const pool = createPool()
  const first = await parseExtractedWhatsAppMediaOrderCandidate({
    messageId: 'wamid.candidate-test',
    pool,
  })
  const updatesAfterFirstParse = pool.state.parseUpdates
  const second = await parseExtractedWhatsAppMediaOrderCandidate({
    messageId: 'wamid.candidate-test',
    pool,
  })

  assert.equal(first.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(second.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(second.skipped, true)
  assert.equal(pool.state.parseUpdates, updatesAfterFirstParse)
  assert.equal(pool.state.row.id, 1)
})

test('Phase 2.4 persistence performs no business lookups and never creates a PI', async () => {
  const pool = createPool()
  const result = await parseExtractedWhatsAppMediaOrderCandidate({
    messageId: 'wamid.candidate-test',
    pool,
  })

  assert.equal(result.status, MEDIA_ORDER_PARSE_STATUSES.PARSED)
  assert.equal(pool.state.businessLookupAttempts, 0)
  assert.equal(pool.state.row.pi_created, false)
})

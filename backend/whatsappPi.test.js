import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWhatsappPIItemLine, parseWhatsappPIText } from './whatsappPi.js'

test('parses a WhatsApp PI product line', () => {
  assert.deepEqual(parseWhatsappPIItemLine('100/90 - 12V - PU37 - 500 NOS'), {
    size: '100/90',
    voltage: '12V',
    model: 'PU37',
    quantity: 500,
    unit: 'NOS',
    rawLine: '100/90 - 12V - PU37 - 500 NOS',
  })
})

test('parses the sample WhatsApp PI message', () => {
  const parsed = parseWhatsappPIText(`Date: 20/06/2026
M/s Milan Automobiles
Belgaum
100/90 - 12V - PU37 - 500 NOS
130/100 - 12V PU37 - 200 NOS
130/100 - 24V PU37 - 100 NOS`)

  assert.equal(parsed.date, '2026-06-20')
  assert.equal(parsed.partyName, 'Milan Automobiles')
  assert.equal(parsed.place, 'Belgaum')
  assert.deepEqual(
    parsed.items.map(({ size, voltage, model, quantity, unit }) => ({
      size,
      voltage,
      model,
      quantity,
      unit,
    })),
    [
      { size: '100/90', voltage: '12V', model: 'PU37', quantity: 500, unit: 'NOS' },
      { size: '130/100', voltage: '12V', model: 'PU37', quantity: 200, unit: 'NOS' },
      { size: '130/100', voltage: '24V', model: 'PU37', quantity: 100, unit: 'NOS' },
    ],
  )
})

test('parses OCR product-code quantity lines', () => {
  const examples = [
    'SB 102 H4 P43t P LHT E - 1000 Nos',
    'SB 102 H4 P43t P LHT E 1000 Nos',
    'SB102 H4 P43T P LHT E - 1000',
    'SB-102 H4 P43T P LHT E : 1000 PCS',
    'SB102 LEFT 1000',
    'SB102 LH x 1000',
    'SB102 — 1,000 Nos.',
  ]

  for (const example of examples) {
    const item = parseWhatsappPIItemLine(example)

    assert.equal(item?.productCode, 'SB102')
    assert.equal(item?.quantity, 1000)
    assert.ok(item?.unit === 'NOS' || item?.unit === 'PCS')
  }
})

test('parses the requested OCR-style order sample', () => {
  const parsed = parseWhatsappPIText(`Party: Jalaram Enterprises
Place: Navagam
Date: 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`)

  assert.equal(parsed.partyName, 'Jalaram Enterprises')
  assert.equal(parsed.place, 'Navagam')
  assert.equal(parsed.date, '2026-07-22')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].quantity, 1000)
  assert.equal(parsed.items[0].unit, 'NOS')
})

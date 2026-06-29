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

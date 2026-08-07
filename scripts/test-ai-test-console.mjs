import 'dotenv/config'

const baseUrl =
  process.env.AI_TEST_CONSOLE_TEST_URL ??
  'http://127.0.0.1:5000/api/admin/ai-test-console'
const userName = process.env.AI_TEST_CONSOLE_TEST_USER ?? 'Dileep'
const piNumber = process.env.AI_TEST_CONSOLE_TEST_PI_NUMBER ?? 'AML-0002'

const request = async (label, path, { body, method = 'POST' } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      'x-autopal-user': userName,
    },
    method,
  })
  const responseText = await response.text()
  let payload

  try {
    payload = responseText ? JSON.parse(responseText) : {}
  } catch {
    payload = { text: responseText }
  }

  console.log(JSON.stringify({
    label,
    ok: response.ok,
    status: response.status,
    finalStatus: payload.finalStatus,
    success: payload.success,
    testRunId: payload.testRunId,
    errors: payload.errors,
  }, null, 2))

  if (!response.ok) {
    process.exitCode = 1
  }
}

await request('system check', '/system-check', { method: 'GET' })
await request('text parser', '/text-parser', {
  body: {
    text: `Party: Jalaram Enterprises
Place: Navagam
Date: 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`,
  },
})
await request('media capture simulation', '/media-capture', {
  body: {
    caption: 'Sample order image',
    mediaId: 'media-test-image-001',
    messageType: 'image',
    mimeType: 'image/jpeg',
    senderName: 'Dileep Test',
    senderPhone: '917733850017',
    sha256: 'sample-image-sha256',
  },
})
await request('customer matcher', '/customer-match', {
  body: {
    city: 'Navagam',
    customerName: 'Jalaram Enterprises',
  },
})
await request('product matcher', '/product-match', {
  body: {
    productText: 'SB102\nSB 102 H4 P43t P LHT E',
  },
})
await request('company selection head lamp', '/company-selection', {
  body: {
    productText: 'SB 102 H4 P43t',
  },
})
await request('company selection halogen', '/company-selection', {
  body: {
    productText: 'Halogen Bulb H4',
  },
})
await request('company selection mixed company', '/company-selection', {
  body: {
    productText: `SB 102 H4 P43t
Halogen Bulb H4`,
  },
})
await request('commercial pi calculation', '/commercial-pi-calculation', {
  body: {
    text: `Party: Jalaram Enterprises
Place: Navagam
Date: 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`,
  },
})
await request('draft pi summary simulation', '/draft-pi-summary', {
  body: {
    confirmSend: false,
    mode: 'simulation',
    piNumber,
    senderPhone: '917733850017',
  },
})
await request('customer confirmation simulation', '/customer-confirmation', {
  body: {
    piNumber,
    replyText: `CONFIRM ${piNumber}`,
    senderPhone: '917733850017',
  },
})
await request('whatsapp acknowledgement simulation', '/whatsapp-acknowledgement', {
  body: {
    confirmSend: false,
    mode: 'simulation',
    piNumber: 'HAL-0001',
    processingStatus: 'PI_CREATED',
    senderPhone: '917733850017',
  },
})

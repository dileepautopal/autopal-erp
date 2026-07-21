import { createHmac } from 'node:crypto'

const args = new Set(process.argv.slice(2))
const appSecret = String(process.env.META_APP_SECRET ?? '').trim()
const endpoint =
  process.env.META_DATA_DELETION_TEST_URL ??
  'http://127.0.0.1:5000/api/meta/data-deletion'
const userId =
  process.env.META_TEST_USER_ID ?? `dev-meta-user-${Date.now()}`

const toBase64URL = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

const signPayload = (payloadSegment) =>
  createHmac('sha256', appSecret)
    .update(payloadSegment)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')

if (args.has('--help')) {
  console.log(`
Usage:
  META_APP_SECRET=your_secret npm run test:meta-data-deletion
  META_APP_SECRET=your_secret npm run test:meta-data-deletion -- --invalid

Optional environment variables:
  META_DATA_DELETION_TEST_URL  Defaults to http://127.0.0.1:5000/api/meta/data-deletion
  META_TEST_USER_ID            Defaults to a generated development user ID
`)
  process.exit(0)
}

if (!appSecret) {
  console.error('META_APP_SECRET is required for this development test.')
  process.exit(1)
}

const payloadSegment = toBase64URL(
  JSON.stringify({
    algorithm: 'HMAC-SHA256',
    issued_at: Math.floor(Date.now() / 1000),
    user_id: userId,
  }),
)
const validSignature = signPayload(payloadSegment)
const signature = args.has('--invalid')
  ? `${validSignature.slice(0, -1)}x`
  : validSignature
const signedRequest = `${signature}.${payloadSegment}`
const response = await fetch(endpoint, {
  body: new URLSearchParams({ signed_request: signedRequest }),
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  method: 'POST',
})
const contentType = response.headers.get('content-type') ?? ''
const body = contentType.includes('application/json')
  ? await response.json()
  : await response.text()

console.log(JSON.stringify({
  endpoint,
  ok: response.ok,
  status: response.status,
  body,
}, null, 2))

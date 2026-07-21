import 'dotenv/config'
import pg from 'pg'

const endpoint =
  process.env.WHATSAPP_WEBHOOK_TEST_URL ??
  'http://127.0.0.1:5000/api/whatsapp-pi/webhook'
const runId = process.env.WHATSAPP_WEBHOOK_TEST_RUN_ID ?? `local-${Date.now()}`
const senderPhone = process.env.WHATSAPP_WEBHOOK_TEST_SENDER ?? '919999999999'
const senderName = process.env.WHATSAPP_WEBHOOK_TEST_NAME ?? 'Local Test'

const validMessageId = `wamid.${runId}.valid`
const invalidMessageId = `wamid.${runId}.invalid`
const timestamp = String(Math.floor(Date.now() / 1000))
const validText = [
  'Date: 20/06/2026',
  'M/s Milan Automobiles',
  'Belgaum',
  '100/90 - 12V - PU37 - 500 NOS',
  '130/100 - 12V PU37 - 200 NOS',
].join('\n')
const invalidText = 'Hello, this is not a PI message.'

const createWebhookPayload = ({ messageId, text }) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'local-test-waba',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '911234567890',
              phone_number_id: 'local-phone-number-id',
            },
            contacts: [
              {
                profile: { name: senderName },
                wa_id: senderPhone,
              },
            ],
            messages: [
              {
                from: senderPhone,
                id: messageId,
                text: { body: text },
                timestamp,
                type: 'text',
              },
            ],
          },
        },
      ],
    },
  ],
})

const postWebhook = async (label, payload) => {
  const response = await fetch(endpoint, {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const body = await response.json().catch(async () => ({
    text: await response.text(),
  }))

  console.log(JSON.stringify({
    label,
    ok: response.ok,
    status: response.status,
    body,
  }, null, 2))
}

await postWebhook(
  'valid PI-style message',
  createWebhookPayload({ messageId: validMessageId, text: validText }),
)
await postWebhook(
  'invalid plain-text message',
  createWebhookPayload({ messageId: invalidMessageId, text: invalidText }),
)
await postWebhook(
  'duplicate invalid message',
  createWebhookPayload({ messageId: invalidMessageId, text: invalidText }),
)

if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

  try {
    const result = await pool.query(
      `
        SELECT message_id, parse_status, pi_created, COUNT(*) OVER (PARTITION BY message_id) AS duplicate_count
        FROM tran_whatsapp_pi_messages
        WHERE message_id = ANY($1::text[])
        ORDER BY message_id
      `,
      [[validMessageId, invalidMessageId]],
    )

    console.log(JSON.stringify({
      databaseRows: result.rows.map((row) => ({
        duplicate_count: Number(row.duplicate_count),
        message_id: row.message_id,
        parse_status: row.parse_status,
        pi_created: row.pi_created,
      })),
    }, null, 2))
  } finally {
    await pool.end()
  }
}

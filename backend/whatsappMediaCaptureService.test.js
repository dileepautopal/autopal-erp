import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMetaStyleMediaMessage,
  captureIncomingMedia,
  classifyMediaMessage,
  extractMediaEnvelope,
  isWhatsappMediaMessage,
} from './whatsappMediaCaptureService.js'

const contact = {
  profile: { name: 'Media Test Customer' },
  wa_id: '917733850017',
}

const fixtures = [
  {
    caption: 'Image caption',
    label: 'JPEG image with caption',
    mediaMimeType: 'image/jpeg',
    messageType: 'image',
  },
  {
    label: 'JPEG image without caption',
    mediaMimeType: 'image/jpeg',
    messageType: 'image',
  },
  {
    label: 'PNG image',
    mediaMimeType: 'image/png',
    messageType: 'image',
  },
  {
    fileName: 'order.pdf',
    label: 'PDF document',
    mediaMimeType: 'application/pdf',
    messageType: 'document',
  },
  {
    fileName: 'order.xlsx',
    label: 'XLSX document',
    mediaMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    messageType: 'document',
  },
  {
    fileName: 'order.xls',
    label: 'XLS document',
    mediaMimeType: 'application/vnd.ms-excel',
    messageType: 'document',
  },
  {
    fileName: 'order.docx',
    label: 'DOCX document',
    mediaMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    messageType: 'document',
  },
  {
    fileName: 'order.doc',
    label: 'DOC document',
    mediaMimeType: 'application/msword',
    messageType: 'document',
  },
  {
    fileName: 'order.csv',
    label: 'CSV document',
    mediaMimeType: 'text/csv',
    messageType: 'document',
  },
  {
    label: 'Audio',
    mediaMimeType: 'audio/ogg',
    messageType: 'audio',
  },
  {
    label: 'Voice note',
    mediaMimeType: 'audio/ogg',
    messageType: 'audio',
    voice: true,
  },
  {
    caption: 'Video caption',
    label: 'Video with caption',
    mediaMimeType: 'video/mp4',
    messageType: 'video',
  },
  {
    animated: true,
    label: 'Sticker',
    mediaMimeType: 'image/webp',
    messageType: 'sticker',
  },
  {
    fileName: '',
    label: 'Missing filename',
    mediaMimeType: 'application/pdf',
    messageType: 'document',
  },
  {
    caption: '',
    label: 'Missing caption',
    mediaMimeType: 'image/jpeg',
    messageType: 'image',
  },
]

for (const fixture of fixtures) {
  test(`${fixture.label} metadata is captured`, () => {
    const message = buildMetaStyleMediaMessage({
      ...fixture,
      mediaId: `media-${fixture.label.toLowerCase().replace(/\W+/g, '-')}`,
      mediaSha256: 'fixture-sha256',
      senderPhone: '917733850017',
    })
    const envelope = extractMediaEnvelope(message, contact)
    const classification = classifyMediaMessage(envelope)

    assert.equal(isWhatsappMediaMessage(message), true)
    assert.equal(envelope.handled, true)
    assert.equal(envelope.mediaId.startsWith('media-'), true)
    assert.equal(envelope.mediaType, fixture.messageType)
    assert.equal(envelope.mediaMimeType, fixture.mediaMimeType)
    assert.equal(envelope.mediaSha256, 'fixture-sha256')
    assert.equal(classification.captureStatus, 'CAPTURED')
    assert.equal(classification.processingStatus, 'MEDIA_RECEIVED')
    assert.deepEqual(classification.errors, [])

    if (fixture.fileName) {
      assert.equal(envelope.fileName, fixture.fileName)
    }

    if (fixture.caption) {
      assert.equal(envelope.caption, fixture.caption)
    }

    if (fixture.voice) {
      assert.equal(envelope.voice, true)
    }

    if (fixture.animated) {
      assert.equal(envelope.animated, true)
    }
  })
}

test('missing MIME type becomes PARTIAL instead of crashing', () => {
  const message = buildMetaStyleMediaMessage({
    mediaId: 'media-missing-mime',
    mediaMimeType: '',
    messageType: 'image',
  })
  const classification = classifyMediaMessage(extractMediaEnvelope(message, contact))

  assert.equal(classification.captureStatus, 'PARTIAL')
  assert.equal(classification.processingStatus, 'MEDIA_RECEIVED')
  assert.match(classification.warnings[0], /MIME type/i)
  assert.deepEqual(classification.errors, [])
})

test('unsupported message type is preserved for manual review classification', () => {
  const message = {
    from: '917733850017',
    id: 'wamid.unsupported',
    timestamp: '1785997800',
    type: 'location',
    location: { latitude: 1, longitude: 2 },
  }
  const envelope = extractMediaEnvelope(message, contact)
  const classification = classifyMediaMessage(envelope)

  assert.equal(isWhatsappMediaMessage(message), false)
  assert.equal(envelope.handled, false)
  assert.equal(classification.captureStatus, 'UNSUPPORTED')
  assert.equal(classification.processingStatus, 'MANUAL_REVIEW')
  assert.match(classification.errors[0], /Unsupported/)
})

test('raw payload is preserved during database capture and no file path is created', async () => {
  const state = { row: { id: 10, message_id: 'wamid.media-db', media_path: '' } }
  const pool = {
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
        state.row = {
          ...state.row,
          caption: params[8],
          media_capture_error: params[15] || null,
          media_capture_status: params[14],
          media_id: params[1],
          media_mime_type: params[3],
          media_path: '',
          media_sha256: params[4],
          media_type: params[2],
          parse_errors: JSON.parse(params[12]),
          parse_status: params[10],
          parse_warnings: JSON.parse(params[11]),
          pi_created: false,
          processing_status: params[10],
          raw_payload: JSON.parse(params[9]),
        }

        return { rowCount: 1, rows: [state.row] }
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
  const message = buildMetaStyleMediaMessage({
    caption: 'Capture only',
    mediaId: 'media-db-id',
    mediaMimeType: 'image/jpeg',
    mediaSha256: 'db-sha',
    messageId: 'wamid.media-db',
    messageType: 'image',
  })
  const result = await captureIncomingMedia({
    contact,
    message,
    pool,
    sourceRecord: { id: 10, messageId: 'wamid.media-db' },
  })

  assert.equal(result.mediaCaptureStatus, 'CAPTURED')
  assert.equal(result.processingStatus, 'MEDIA_RECEIVED')
  assert.equal(result.databaseRowId, 10)
  assert.equal(state.row.raw_payload.message.id, 'wamid.media-db')
  assert.equal(state.row.media_path, '')
  assert.equal(state.row.pi_created, false)
})

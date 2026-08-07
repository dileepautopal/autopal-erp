import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  downloadCapturedWhatsAppMedia,
  getStoragePaths,
  MEDIA_DOWNLOAD_STATUSES,
  toSafeFilePart,
} from './whatsappMediaDownloadService.js'

const shaBase64 = (buffer) => crypto.createHash('sha256').update(buffer).digest('base64')

const createTempProject = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), 'autopal-media-download-'))

const createPool = (initialRow = {}) => {
  const state = {
    row: {
      id: 1,
      message_id: 'wamid.download-test',
      received_at: '2026-08-07T10:00:00.000Z',
      message_type: 'image',
      media_id: 'meta-media-1',
      media_type: 'image',
      media_mime_type: 'image/jpeg',
      media_sha256: '',
      media_path: '',
      file_name: '',
      caption: '',
      processing_status: 'MEDIA_RECEIVED',
      media_capture_status: 'CAPTURED',
      media_download_status: 'PENDING',
      media_downloaded_at: null,
      media_download_error: null,
      media_file_size: null,
      media_download_sha256: null,
      pi_created: false,
      ...initialRow,
    },
    updates: [],
  }

  return {
    state,
    async query(sql, params = []) {
      if (/ALTER TABLE|CREATE INDEX/i.test(sql)) {
        return { rowCount: 0, rows: [] }
      }

      if (/SELECT[\s\S]+FROM\s+tran_whatsapp_pi_messages/i.test(sql)) {
        return { rowCount: 1, rows: [state.row] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
        const update = {
          error: params[3],
          fileSize: params[4],
          mediaPath: params[1],
          sha256: params[5],
          status: params[2],
        }
        state.updates.push(update)
        state.row = {
          ...state.row,
          media_download_error: update.error,
          media_download_sha256: update.sha256 ?? state.row.media_download_sha256,
          media_download_status: update.status,
          media_downloaded_at: update.status === MEDIA_DOWNLOAD_STATUSES.DOWNLOADED
            ? '2026-08-07T10:01:00.000Z'
            : state.row.media_downloaded_at,
          media_file_size: update.fileSize ?? state.row.media_file_size,
          media_path: update.mediaPath ?? state.row.media_path,
        }

        return { rowCount: 1, rows: [state.row] }
      }

      if (/INSERT INTO\s+master_pi_rmkt|INSERT INTO\s+tran_pi_rmkt/i.test(sql)) {
        throw new Error('Phase 2.2 media download must not create a PI.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

const createFetch = ({
  binaryBody,
  binaryStatus = 200,
  binaryType = 'image/jpeg',
  lookupPayload = null,
  lookupStatus = 200,
} = {}) => {
  const calls = []

  return {
    calls,
    async fetch(url) {
      calls.push(url)

      if (String(url).includes('graph.facebook.com')) {
        return new Response(
          JSON.stringify(lookupPayload ?? {
            mime_type: binaryType,
            url: 'https://media.local/download-test',
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: lookupStatus,
          },
        )
      }

      return new Response(binaryBody ?? Buffer.from([1, 2, 3]), {
        headers: { 'content-type': binaryType },
        status: binaryStatus,
      })
    },
  }
}

test('JPEG media is downloaded, stored locally, and DB path/status are updated', async () => {
  const projectRoot = await createTempProject()
  const binary = Buffer.from([0xff, 0xd8, 0xff, 0x00])
  const pool = createPool({ media_sha256: shaBase64(binary) })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'image/jpeg' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, 'DOWNLOADED')
  assert.equal(result.mediaPath.startsWith('storage/whatsapp-media/2026/08/07/'), true)
  assert.equal(result.mediaPath.endsWith('.jpg'), true)
  assert.equal(result.fileSize, binary.length)
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
  assert.equal(pool.state.row.media_file_size, binary.length)
  assert.equal(pool.state.row.pi_created, false)

  const stored = await fs.readFile(path.join(projectRoot, result.mediaPath))
  assert.deepEqual(stored, binary)
})

test('PDF media is downloaded with pdf extension', async () => {
  const projectRoot = await createTempProject()
  const binary = Buffer.from('%PDF-1.4\n')
  const pool = createPool({
    file_name: 'order.pdf',
    media_mime_type: 'application/pdf',
    media_sha256: shaBase64(binary),
    media_type: 'document',
    message_type: 'document',
  })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'application/pdf' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, 'DOWNLOADED')
  assert.equal(result.mediaPath.endsWith('.pdf'), true)
  assert.equal((await fs.stat(path.join(projectRoot, result.mediaPath))).size, binary.length)
})

test('malicious original filename cannot escape storage directory', async () => {
  const projectRoot = await createTempProject()
  const binary = Buffer.from('safe-pdf')
  const pool = createPool({
    file_name: '..\\..\\evil.pdf',
    media_id: '..\\meta/evil',
    media_mime_type: 'application/pdf',
    media_sha256: shaBase64(binary),
    message_id: 'wamid.../../../evil',
  })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'application/pdf' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.../../../evil',
    pool,
    projectRoot,
  })
  const absoluteStorageRoot = path.resolve(projectRoot, 'storage/whatsapp-media')
  const absoluteStoredPath = path.resolve(projectRoot, result.mediaPath)
  const relative = path.relative(absoluteStorageRoot, absoluteStoredPath)

  assert.equal(result.status, 'DOWNLOADED')
  assert.equal(relative.startsWith('..'), false)
  assert.equal(path.isAbsolute(relative), false)
  assert.equal(path.basename(result.mediaPath).includes('evil.pdf'), false)
})

test('successful repeated invocation skips second Meta download and keeps one file', async () => {
  const projectRoot = await createTempProject()
  const binary = Buffer.from('one-copy')
  const pool = createPool({ media_sha256: shaBase64(binary) })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'image/jpeg' })

  const first = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })
  const second = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })
  const directory = path.dirname(path.join(projectRoot, first.mediaPath))
  const files = await fs.readdir(directory)

  assert.equal(first.status, 'DOWNLOADED')
  assert.equal(second.status, 'DOWNLOADED')
  assert.equal(second.skipped, true)
  assert.equal(fetchMock.calls.length, 2)
  assert.equal(files.length, 1)
})

test('Meta media URL lookup failure records DOWNLOAD_FAILED without deleting capture data', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  const fetchMock = createFetch({
    lookupPayload: { error: { code: 190, message: 'Invalid OAuth access token.' } },
    lookupStatus: 401,
  })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, 'DOWNLOAD_FAILED')
  assert.match(result.error, /Invalid OAuth access token/)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
  assert.equal(pool.state.row.processing_status, 'MEDIA_RECEIVED')
})

test('media binary download failure records DOWNLOAD_FAILED safely', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  const fetchMock = createFetch({
    binaryBody: Buffer.from('not found'),
    binaryStatus: 404,
    binaryType: 'application/pdf',
  })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, 'DOWNLOAD_FAILED')
  assert.match(result.error, /HTTP 404/)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
})

test('filesystem write failure records DOWNLOAD_FAILED', async () => {
  const projectRoot = await createTempProject()
  const blockedPath = path.join(projectRoot, 'blocked-storage')
  await fs.writeFile(blockedPath, 'not-a-directory')
  const binary = Buffer.from('content')
  const pool = createPool({ media_sha256: shaBase64(binary) })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'image/jpeg' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
    storageRoot: blockedPath,
  })

  assert.equal(result.status, 'DOWNLOAD_FAILED')
  assert.ok(result.error)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
})

test('unknown MIME type uses bin extension instead of crashing', async () => {
  const projectRoot = await createTempProject()
  const binary = Buffer.from('unknown')
  const pool = createPool({
    media_mime_type: 'application/x-unknown',
    media_sha256: shaBase64(binary),
  })
  const fetchMock = createFetch({ binaryBody: binary, binaryType: 'application/x-unknown' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, 'DOWNLOADED')
  assert.equal(result.mediaPath.endsWith('.bin'), true)
})

test('SHA-256 mismatch is detected and file is not stored', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({ media_sha256: shaBase64(Buffer.from('expected')) })
  const fetchMock = createFetch({ binaryBody: Buffer.from('actual'), binaryType: 'image/jpeg' })

  const result = await downloadCapturedWhatsAppMedia({
    env: { WHATSAPP_ACCESS_TOKEN: 'test-token' },
    fetchImpl: fetchMock.fetch,
    messageId: 'wamid.download-test',
    pool,
    projectRoot,
  })
  const expectedPath = getStoragePaths({
    mediaId: pool.state.row.media_id,
    messageId: pool.state.row.message_id,
    mimeType: pool.state.row.media_mime_type,
    projectRoot,
    receivedAt: pool.state.row.received_at,
  }).absolutePath

  assert.equal(result.status, 'DOWNLOAD_FAILED')
  assert.match(result.error, /SHA-256/)
  await assert.rejects(fs.stat(expectedPath))
})

test('safe file parts remove traversal characters', () => {
  assert.equal(toSafeFilePart('../../evil.pdf'), 'evil.pdf')
  assert.equal(toSafeFilePart('..\\..\\evil.pdf'), 'evil.pdf')
})

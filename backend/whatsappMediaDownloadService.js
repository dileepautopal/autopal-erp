import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const DEFAULT_STORAGE_ROOT = 'storage/whatsapp-media'
const DEFAULT_GRAPH_API_BASE = 'https://graph.facebook.com/v20.0'
const DEFAULT_TIMEOUT_MS = 30000

const MEDIA_DOWNLOAD_STATUSES = {
  DOWNLOADED: 'DOWNLOADED',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  PENDING: 'PENDING',
}

const MIME_EXTENSION_MAP = new Map([
  ['application/msword', 'doc'],
  ['application/pdf', 'pdf'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['audio/aac', 'aac'],
  ['audio/amr', 'amr'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/ogg', 'ogg'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['text/csv', 'csv'],
  ['video/3gpp', '3gp'],
  ['video/mp4', 'mp4'],
])

const toText = (value) => String(value ?? '').trim()

const toSafeFilePart = (value, fallback = 'media') => {
  const safeValue = toText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/^[a-zA-Z]:[\\/]+/, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80)

  return safeValue || fallback
}

const normalizeProjectRelativePath = (value) => toText(value).replace(/\\/g, '/')

const getExtensionFromMimeType = (mimeType) =>
  MIME_EXTENSION_MAP.get(toText(mimeType).toLowerCase()) || 'bin'

const getDateParts = (receivedAt = null) => {
  const date = receivedAt ? new Date(receivedAt) : new Date()
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date

  return {
    day: String(safeDate.getDate()).padStart(2, '0'),
    month: String(safeDate.getMonth() + 1).padStart(2, '0'),
    year: String(safeDate.getFullYear()),
  }
}

const getStorageRoot = ({
  env = process.env,
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) =>
  path.resolve(projectRoot, storageRoot || env.WHATSAPP_MEDIA_STORAGE_DIR || DEFAULT_STORAGE_ROOT)

const assertInsideDirectory = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved media storage path is outside the configured storage directory.')
  }
}

const getSafeStoredFileName = ({ mediaId = '', messageId = '', mimeType = '' } = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${messageId}:${mediaId}`)
    .digest('hex')
    .slice(0, 16)
  const safeMessageId = toSafeFilePart(messageId, 'wamid').slice(0, 64)
  const safeMediaId = toSafeFilePart(mediaId, 'media').slice(0, 40)
  const extension = getExtensionFromMimeType(mimeType)

  return `${safeMessageId}_${safeMediaId}_${hash}.${extension}`
}

const getStoragePaths = ({
  mediaId = '',
  messageId = '',
  mimeType = '',
  projectRoot = process.cwd(),
  receivedAt = null,
  storageRoot = '',
} = {}) => {
  const absoluteStorageRoot = getStorageRoot({ projectRoot, storageRoot })
  const { day, month, year } = getDateParts(receivedAt)
  const fileName = getSafeStoredFileName({ mediaId, messageId, mimeType })
  const absoluteDirectory = path.join(absoluteStorageRoot, year, month, day)
  const absolutePath = path.join(absoluteDirectory, fileName)

  assertInsideDirectory(absoluteDirectory, absoluteStorageRoot)
  assertInsideDirectory(absolutePath, absoluteStorageRoot)

  return {
    absoluteDirectory,
    absolutePath,
    relativePath: normalizeProjectRelativePath(path.relative(projectRoot, absolutePath)),
  }
}

const responseTextSafely = async (response) => {
  try {
    const text = await response.text()

    return text.slice(0, 1000)
  } catch {
    return ''
  }
}

const parseJsonSafely = async (response) => {
  try {
    return await response.json()
  } catch {
    return null
  }
}

const withTimeout = async (operation, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const getGraphApiBase = (env = process.env) =>
  toText(env.WHATSAPP_GRAPH_API_BASE) || DEFAULT_GRAPH_API_BASE

const getAccessToken = (env = process.env) => toText(env.WHATSAPP_ACCESS_TOKEN)

const getMediaMetadata = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  mediaId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  const accessToken = getAccessToken(env)

  if (!accessToken) {
    throw new Error('WHATSAPP_ACCESS_TOKEN is not configured.')
  }

  if (!fetchImpl) {
    throw new Error('Fetch API is not available for WhatsApp media download.')
  }

  const response = await withTimeout(
    (signal) =>
      fetchImpl(`${getGraphApiBase(env)}/${encodeURIComponent(mediaId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal,
      }),
    timeoutMs,
  )
  const payload = await parseJsonSafely(response)

  if (!response.ok || !payload?.url) {
    const message = payload?.error?.message || payload?.message || `Meta media URL lookup failed with HTTP ${response.status}.`
    const code = payload?.error?.code ? ` Meta code ${payload.error.code}.` : ''

    throw new Error(`${message}${code}`)
  }

  return payload
}

const getDownloadMimeType = (row, metadata, response) =>
  toText(row.media_mime_type) ||
  toText(metadata?.mime_type) ||
  toText(response.headers?.get?.('content-type')) ||
  'application/octet-stream'

const calculateShaVariants = (digest) => ({
  base64: digest.toString('base64'),
  base64url: digest.toString('base64url'),
  hex: digest.toString('hex'),
})

const isExpectedShaMatch = (expectedSha, variants) => {
  const expected = toText(expectedSha)

  if (!expected) {
    return true
  }

  return [variants.base64, variants.base64url, variants.hex].includes(expected)
}

const streamResponseToFile = async ({
  absolutePath,
  expectedSha = '',
  response,
} = {}) => {
  const hash = crypto.createHash('sha256')
  let fileHandle = null
  let fileSize = 0
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    fileHandle = await fs.open(temporaryPath, 'w')

    if (response.body?.getReader) {
      const reader = response.body.getReader()

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        const chunk = Buffer.from(value)
        fileSize += chunk.length
        hash.update(chunk)
        await fileHandle.write(chunk)
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer())
      fileSize = buffer.length
      hash.update(buffer)
      await fileHandle.write(buffer)
    }

    await fileHandle.close()
    fileHandle = null

    if (fileSize <= 0) {
      throw new Error('Downloaded media response was empty.')
    }

    const sha = calculateShaVariants(hash.digest())

    if (!isExpectedShaMatch(expectedSha, sha)) {
      throw new Error('Downloaded media SHA-256 does not match WhatsApp metadata.')
    }

    await fs.rename(temporaryPath, absolutePath)

    return {
      fileSize,
      sha256: sha.hex,
    }
  } catch (error) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {})
    }

    await fs.unlink(temporaryPath).catch(() => {})
    throw error
  }
}

const fileExists = async (absolutePath) => {
  try {
    const stat = await fs.stat(absolutePath)

    return stat.isFile()
  } catch {
    return false
  }
}

const ensureWhatsAppMediaDownloadSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_download_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_downloaded_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_download_error text,
      ADD COLUMN IF NOT EXISTS media_file_size bigint,
      ADD COLUMN IF NOT EXISTS media_download_sha256 varchar(128)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_download_status
    ON ${tableName} (media_download_status)
  `)
}

const getCapturedMediaRow = async (
  pool,
  {
    messageId,
    tableName = DEFAULT_MESSAGE_TABLE_NAME,
  } = {},
) => {
  const result = await pool.query(
    `
      SELECT
        id,
        message_id,
        received_at,
        message_type,
        media_id,
        media_type,
        media_mime_type,
        media_sha256,
        media_path,
        file_name,
        caption,
        processing_status,
        media_capture_status,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256,
        pi_created
      FROM ${tableName}
      WHERE message_id = $1
      LIMIT 1
    `,
    [messageId],
  )

  return result.rows[0] ?? null
}

const updateMediaDownloadStatus = async (
  pool,
  {
    error = null,
    fileSize = null,
    mediaPath = null,
    sha256 = null,
    status,
    tableName = DEFAULT_MESSAGE_TABLE_NAME,
    messageId,
  } = {},
) => {
  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_path = COALESCE($2::text, media_path),
        media_download_status = $3::varchar,
        media_downloaded_at = CASE
          WHEN $3::varchar = 'DOWNLOADED' THEN CURRENT_TIMESTAMP
          ELSE media_downloaded_at
        END,
        media_download_error = $4::text,
        media_file_size = COALESCE($5::bigint, media_file_size),
        media_download_sha256 = COALESCE($6::varchar, media_download_sha256),
        updated_at = CURRENT_TIMESTAMP
      WHERE message_id = $1::varchar
      RETURNING
        id,
        message_id,
        media_id,
        media_type,
        media_mime_type,
        media_path,
        media_download_status,
        media_downloaded_at,
        media_download_error,
        media_file_size,
        media_download_sha256
    `,
    [
      messageId,
      mediaPath,
      status,
      error,
      fileSize,
      sha256,
    ],
  )

  return result.rows[0] ?? null
}

const safeErrorMessage = (error) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000)

const buildMediaDownloadResult = ({
  error = '',
  fileSize = null,
  mediaId = '',
  mediaPath = '',
  messageId = '',
  mimeType = '',
  sha256 = '',
  skipped = false,
  status,
} = {}) => ({
  error,
  fileSize,
  mediaId,
  mediaPath,
  messageId,
  mimeType,
  sha256,
  skipped,
  status,
})

const downloadCapturedWhatsAppMedia = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  messageId,
  pool,
  projectRoot = process.cwd(),
  storageRoot = '',
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp media download.')
  }

  await ensureWhatsAppMediaDownloadSchema(pool, { tableName })

  const row = await getCapturedMediaRow(pool, { messageId, tableName })

  if (!row) {
    throw new Error(`Captured WhatsApp media row was not found for ${messageId}.`)
  }

  if (!toText(row.media_id)) {
    const error = 'Captured WhatsApp media row does not have a Meta media ID.'
    await updateMediaDownloadStatus(pool, {
      error,
      messageId,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOAD_FAILED,
      tableName,
    })

    return buildMediaDownloadResult({
      error,
      messageId,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOAD_FAILED,
    })
  }

  if (row.media_download_status === MEDIA_DOWNLOAD_STATUSES.DOWNLOADED && row.media_path) {
    const absoluteExistingPath = path.resolve(projectRoot, row.media_path)

    if (await fileExists(absoluteExistingPath)) {
      return buildMediaDownloadResult({
        fileSize: row.media_file_size ? Number(row.media_file_size) : null,
        mediaId: row.media_id,
        mediaPath: normalizeProjectRelativePath(row.media_path),
        messageId,
        mimeType: row.media_mime_type,
        sha256: row.media_download_sha256 || '',
        skipped: true,
        status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADED,
      })
    }
  }

  try {
    await updateMediaDownloadStatus(pool, {
      error: null,
      messageId,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADING,
      tableName,
    })

    const metadata = await getMediaMetadata({
      env,
      fetchImpl,
      mediaId: row.media_id,
      timeoutMs,
    })
    const accessToken = getAccessToken(env)
    const response = await withTimeout(
      (signal) =>
        fetchImpl(metadata.url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal,
        }),
      timeoutMs,
    )

    if (!response.ok) {
      const text = await responseTextSafely(response)
      throw new Error(`WhatsApp media binary download failed with HTTP ${response.status}.${text ? ` ${text}` : ''}`)
    }

    const mimeType = getDownloadMimeType(row, metadata, response)
    const storagePaths = getStoragePaths({
      mediaId: row.media_id,
      messageId,
      mimeType,
      projectRoot,
      receivedAt: row.received_at,
      storageRoot,
    })

    if (await fileExists(storagePaths.absolutePath)) {
      const stat = await fs.stat(storagePaths.absolutePath)
      const updatedRow = await updateMediaDownloadStatus(pool, {
        error: null,
        fileSize: stat.size,
        mediaPath: storagePaths.relativePath,
        messageId,
        status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADED,
        tableName,
      })

      return buildMediaDownloadResult({
        fileSize: Number(updatedRow?.media_file_size ?? stat.size),
        mediaId: row.media_id,
        mediaPath: storagePaths.relativePath,
        messageId,
        mimeType,
        sha256: updatedRow?.media_download_sha256 || '',
        skipped: true,
        status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADED,
      })
    }

    const stored = await streamResponseToFile({
      absolutePath: storagePaths.absolutePath,
      expectedSha: row.media_sha256,
      response,
    })
    const updatedRow = await updateMediaDownloadStatus(pool, {
      error: null,
      fileSize: stored.fileSize,
      mediaPath: storagePaths.relativePath,
      messageId,
      sha256: stored.sha256,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADED,
      tableName,
    })

    return buildMediaDownloadResult({
      fileSize: Number(updatedRow?.media_file_size ?? stored.fileSize),
      mediaId: row.media_id,
      mediaPath: updatedRow?.media_path || storagePaths.relativePath,
      messageId,
      mimeType,
      sha256: stored.sha256,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOADED,
    })
  } catch (error) {
    const errorMessage = safeErrorMessage(error)

    await updateMediaDownloadStatus(pool, {
      error: errorMessage,
      messageId,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOAD_FAILED,
      tableName,
    }).catch(() => null)

    return buildMediaDownloadResult({
      error: errorMessage,
      mediaId: row.media_id,
      messageId,
      mimeType: row.media_mime_type,
      status: MEDIA_DOWNLOAD_STATUSES.DOWNLOAD_FAILED,
    })
  }
}

const getSafeMediaDownloadLogDetails = (result = {}) => ({
  downloadStatus: result.status || '',
  fileSize: result.fileSize ?? null,
  mediaId: result.mediaId || '',
  mediaPath: result.mediaPath || '',
  messageId: result.messageId || '',
  mimeType: result.mimeType || '',
  skipped: Boolean(result.skipped),
})

export {
  buildMediaDownloadResult,
  downloadCapturedWhatsAppMedia,
  ensureWhatsAppMediaDownloadSchema,
  getSafeMediaDownloadLogDetails,
  getStoragePaths,
  MEDIA_DOWNLOAD_STATUSES,
  toSafeFilePart,
}

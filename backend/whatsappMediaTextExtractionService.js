import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_MESSAGE_TABLE_NAME = 'tran_whatsapp_pi_messages'
const DEFAULT_STORAGE_ROOT = 'storage/whatsapp-media'
const DEFAULT_OCR_LANG = 'eng'
const DEFAULT_PDF_OCR_MAX_PAGES = 3
const MAX_EXTRACTED_TEXT_CHARS = 500000
const IMAGE_OCR_TARGET_MIN_WIDTH = 1800
const IMAGE_OCR_TARGET_MAX_WIDTH = 3000
const IMAGE_OCR_PASS_LIMIT = 3
const IMAGE_OCR_PASS_PSM_MODES = [
  { fallback: 6, key: 'SINGLE_BLOCK' },
  { fallback: 4, key: 'SINGLE_COLUMN' },
  { fallback: 11, key: 'SPARSE_TEXT' },
]
const IMAGE_OCR_FALLBACK_PSM_MODE = { fallback: 3, key: 'AUTO' }

const MEDIA_EXTRACTION_STATUSES = {
  EXTRACTED: 'EXTRACTED',
  EXTRACTING: 'EXTRACTING',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  EXTRACTION_NOT_SUPPORTED: 'EXTRACTION_NOT_SUPPORTED',
  PENDING: 'PENDING',
}

const MEDIA_EXTRACTION_METHODS = {
  OCR_IMAGE: 'OCR_IMAGE',
  OCR_PDF: 'OCR_PDF',
  PDF_TEXT: 'PDF_TEXT',
}

const SUPPORTED_EXTRACTION_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
])

const EXTENSION_MIME_MAP = new Map([
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
])

const toText = (value) => String(value ?? '').trim()

const normalizeProjectRelativePath = (value) => toText(value).replace(/\\/g, '/')

const normalizeExtractedText = (value) =>
  String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

const limitExtractedTextForStorage = (value) => {
  const text = normalizeExtractedText(value)

  if (text.length <= MAX_EXTRACTED_TEXT_CHARS) {
    return text
  }

  return `${text.slice(0, MAX_EXTRACTED_TEXT_CHARS)}\n[Text truncated at ${MAX_EXTRACTED_TEXT_CHARS} characters by AUTOPAL ERP media extraction safety limit.]`
}

const isMeaningfulText = (value) =>
  normalizeExtractedText(value).replace(/\s/g, '').length >= 3

const getStorageRoot = ({
  env = process.env,
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) =>
  path.resolve(projectRoot, storageRoot || env.WHATSAPP_MEDIA_STORAGE_DIR || DEFAULT_STORAGE_ROOT)

const assertInsideDirectory = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved media extraction path is outside the configured media storage directory.')
  }
}

const resolveStoredMediaPath = ({
  env = process.env,
  mediaPath = '',
  projectRoot = process.cwd(),
  storageRoot = '',
} = {}) => {
  const normalizedMediaPath = normalizeProjectRelativePath(mediaPath)

  if (!normalizedMediaPath) {
    throw new Error('Downloaded media path is missing.')
  }

  if (normalizedMediaPath.includes('\u0000')) {
    throw new Error('Downloaded media path contains an invalid character.')
  }

  const absoluteStorageRoot = getStorageRoot({ env, projectRoot, storageRoot })
  const absolutePath = path.resolve(projectRoot, normalizedMediaPath)

  assertInsideDirectory(absolutePath, absoluteStorageRoot)

  return {
    absolutePath,
    absoluteStorageRoot,
    relativePath: normalizedMediaPath,
  }
}

const getMimeTypeFromPath = (mediaPath = '') =>
  EXTENSION_MIME_MAP.get(path.extname(toText(mediaPath)).replace('.', '').toLowerCase()) || ''

const getExtractionMimeType = (row = {}) =>
  toText(row.media_mime_type).toLowerCase() || getMimeTypeFromPath(row.media_path)

const isSupportedExtractionMimeType = (mimeType) =>
  SUPPORTED_EXTRACTION_MIME_TYPES.has(toText(mimeType).toLowerCase())

const safeErrorMessage = (error) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1000)

const countTextMatches = (value, pattern) => normalizeExtractedText(value).match(pattern)?.length ?? 0

const scoreOcrCandidate = ({
  confidence = 0,
  text = '',
} = {}) => {
  const normalizedText = normalizeExtractedText(text)

  if (!normalizedText) {
    return 0
  }

  const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0
  const printableCount = countTextMatches(normalizedText, /[\t\n\r -~]/g)
  const printableRatio = printableCount / Math.max(normalizedText.length, 1)
  const alphaNumericCount = countTextMatches(normalizedText, /[A-Za-z0-9]/g)
  const wordCount = countTextMatches(normalizedText, /\b[A-Za-z]{2,}\b/g)
  const numericTokenCount = countTextMatches(normalizedText, /\b\d+(?:[.,]\d+)?\b/g)
  const nonEmptyLineCount = normalizedText.split('\n').filter((line) => line.trim()).length
  const symbolNoiseCount = countTextMatches(normalizedText, /[~^`{}\[\]\\]/g)
  const repeatedNoiseCount = countTextMatches(normalizedText, /([^\w\s])\1{2,}/g)

  return (
    (safeConfidence * 2)
    + Math.min(alphaNumericCount, 450)
    + Math.min(wordCount * 6, 180)
    + Math.min(numericTokenCount * 12, 180)
    + Math.min(nonEmptyLineCount * 10, 100)
    + Math.round(printableRatio * 100)
    - (symbolNoiseCount * 8)
    - (repeatedNoiseCount * 25)
  )
}

const chooseBestOcrResult = (candidates = []) =>
  candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreOcrCandidate(candidate),
      text: candidate?.text ?? '',
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      return normalizeExtractedText(right.text).length - normalizeExtractedText(left.text).length
    })[0] ?? {
      confidence: 0,
      score: 0,
      text: '',
    }

const getImageOcrTargetWidth = (width) => {
  const numericWidth = Number(width)

  if (!Number.isFinite(numericWidth) || numericWidth <= 0) {
    return null
  }

  if (numericWidth < IMAGE_OCR_TARGET_MIN_WIDTH) {
    return IMAGE_OCR_TARGET_MIN_WIDTH
  }

  if (numericWidth > IMAGE_OCR_TARGET_MAX_WIDTH) {
    return IMAGE_OCR_TARGET_MAX_WIDTH
  }

  return Math.round(numericWidth)
}

const getSharpFactory = async (sharpImpl = null) => {
  if (sharpImpl) {
    return sharpImpl.default || sharpImpl
  }

  const sharpModule = await import('sharp')

  return sharpModule.default || sharpModule
}

const preprocessImageForOCR = async ({
  absolutePath = '',
  buffer = null,
  sharpImpl = null,
} = {}) => {
  const inputBuffer = Buffer.isBuffer(buffer) ? buffer : await fs.readFile(absolutePath)
  const sharp = await getSharpFactory(sharpImpl)
  const metadata = await sharp(inputBuffer, { failOn: 'none' }).metadata()
  const originalWidth = Number(metadata.width ?? 0)
  const targetWidth = getImageOcrTargetWidth(originalWidth)
  const steps = ['rotate']
  let pipeline = sharp(inputBuffer, { failOn: 'none' }).rotate()

  if (targetWidth && targetWidth !== originalWidth) {
    pipeline = pipeline.resize({
      width: targetWidth,
      withoutEnlargement: false,
    })
    steps.push(originalWidth < targetWidth ? 'resize-up' : 'resize-down')
  }

  pipeline = pipeline
    .grayscale()
    .normalise()
    .linear(1.15, -10)
    .sharpen({ sigma: 0.8 })
    .png()
  steps.push('grayscale', 'normalise', 'contrast', 'sharpen', 'png')

  return {
    buffer: await pipeline.toBuffer(),
    originalWidth: originalWidth || null,
    steps,
    targetWidth: targetWidth || null,
  }
}

const getTesseractPsmMode = (tesseract, mode) =>
  tesseract?.PSM?.[mode.key] ?? mode.fallback

const runTesseractOcrPass = async ({
  image,
  psmMode,
  worker,
} = {}) => {
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: String(psmMode),
    user_defined_dpi: '300',
  })
  const result = await worker.recognize(image)

  return {
    confidence: result?.data?.confidence ?? 0,
    psmMode,
    text: result?.data?.text ?? '',
  }
}

const ensureWhatsAppMediaTextExtractionSchema = async (
  pool,
  { tableName = DEFAULT_MESSAGE_TABLE_NAME } = {},
) => {
  await pool.query(`
    ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS media_extraction_status varchar(50) NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS media_extracted_text text,
      ADD COLUMN IF NOT EXISTS media_extracted_at timestamptz,
      ADD COLUMN IF NOT EXISTS media_extraction_error text,
      ADD COLUMN IF NOT EXISTS media_extraction_method varchar(50)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tran_whatsapp_pi_messages_media_extraction_status
    ON ${tableName} (media_extraction_status)
  `)
}

const getDownloadedMediaRow = async (
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
        media_path,
        processing_status,
        media_capture_status,
        media_download_status,
        media_downloaded_at,
        media_file_size,
        media_extraction_status,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        media_extraction_method,
        pi_created
      FROM ${tableName}
      WHERE message_id = $1
      LIMIT 1
    `,
    [messageId],
  )

  return result.rows[0] ?? null
}

const updateMediaExtractionStatus = async (
  pool,
  {
    error = null,
    method = null,
    status,
    tableName = DEFAULT_MESSAGE_TABLE_NAME,
    messageId,
    text = null,
  } = {},
) => {
  const result = await pool.query(
    `
      UPDATE ${tableName}
      SET
        media_extraction_status = $2::varchar,
        media_extracted_text = CASE
          WHEN $3::text IS NULL THEN media_extracted_text
          ELSE $3::text
        END,
        media_extracted_at = CASE
          WHEN $2::varchar = 'EXTRACTED' THEN CURRENT_TIMESTAMP
          ELSE media_extracted_at
        END,
        media_extraction_error = $4::text,
        media_extraction_method = CASE
          WHEN $5::varchar IS NULL THEN media_extraction_method
          ELSE $5::varchar
        END,
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
        media_extraction_status,
        media_extraction_method,
        media_extracted_text,
        media_extracted_at,
        media_extraction_error,
        pi_created
    `,
    [
      messageId,
      status,
      text,
      error,
      method,
    ],
  )

  return result.rows[0] ?? null
}

const buildMediaExtractionResult = ({
  error = '',
  mediaId = '',
  mediaPath = '',
  messageId = '',
  method = '',
  mimeType = '',
  skipped = false,
  status,
  text = '',
  textLength = 0,
} = {}) => ({
  error,
  mediaId,
  mediaPath,
  messageId,
  method,
  mimeType,
  skipped,
  status,
  text,
  textLength,
})

const runTesseractImageOCR = async ({
  absolutePath = '',
  buffer = null,
  env = process.env,
  imagePreprocessor = preprocessImageForOCR,
  sharpImpl = null,
  tesseractModule = null,
} = {}) => {
  const startedAt = Date.now()
  const tesseract = tesseractModule || await import('tesseract.js')
  const workerOptions = {}

  if (env.TESSERACT_LANG_PATH) {
    workerOptions.langPath = env.TESSERACT_LANG_PATH
  }

  if (env.TESSERACT_CACHE_PATH) {
    workerOptions.cachePath = env.TESSERACT_CACHE_PATH
  }

  const worker = await tesseract.createWorker(
    env.WHATSAPP_OCR_LANG || DEFAULT_OCR_LANG,
    1,
    workerOptions,
  )

  try {
    const candidates = []
    let preprocessingError = null
    let preprocessedImage = null

    try {
      preprocessedImage = await imagePreprocessor({
        absolutePath,
        buffer,
        env,
        sharpImpl,
      })
    } catch (error) {
      preprocessingError = error
    }

    if (preprocessedImage?.buffer) {
      const psmModes = IMAGE_OCR_PASS_PSM_MODES
        .slice(0, IMAGE_OCR_PASS_LIMIT)
        .map((mode) => getTesseractPsmMode(tesseract, mode))

      for (const psmMode of psmModes) {
        try {
          const passResult = await runTesseractOcrPass({
            image: preprocessedImage.buffer,
            psmMode,
            worker,
          })

          candidates.push({
            ...passResult,
            preprocessingSteps: preprocessedImage.steps,
            source: 'preprocessed',
          })
        } catch (error) {
          candidates.push({
            confidence: 0,
            error: safeErrorMessage(error),
            psmMode,
            source: 'preprocessed',
            text: '',
          })
        }
      }
    }

    if (!candidates.some((candidate) => isMeaningfulText(candidate.text))) {
      const fallbackResult = await runTesseractOcrPass({
        image: buffer || absolutePath,
        psmMode: getTesseractPsmMode(tesseract, IMAGE_OCR_FALLBACK_PSM_MODE),
        worker,
      })

      candidates.push({
        ...fallbackResult,
        preprocessingError: preprocessingError ? safeErrorMessage(preprocessingError) : '',
        source: 'original',
      })
    }

    const bestResult = chooseBestOcrResult(candidates)

    console.log(JSON.stringify({
      confidence: Number(bestResult.confidence ?? 0),
      durationMs: Date.now() - startedAt,
      event: 'whatsapp_image_ocr_completed',
      fallbackUsed: bestResult.source === 'original',
      preprocessingApplied: Boolean(preprocessedImage?.buffer),
      preprocessingSteps: preprocessedImage?.steps ?? [],
      psmMode: bestResult.psmMode ?? '',
      scope: 'whatsapp-media-extraction',
      score: Number(bestResult.score ?? 0),
      source: bestResult.source || '',
      textLength: normalizeExtractedText(bestResult.text).length,
    }))

    return bestResult.text ?? ''
  } finally {
    await worker.terminate()
  }
}

const extractPdfEmbeddedText = async ({ buffer } = {}) => {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })

  try {
    const result = await parser.getText({
      pageJoiner: '\n',
    })

    return result?.text ?? ''
  } finally {
    await parser.destroy?.()
  }
}

const getPdfOcrMaxPages = (env = process.env) => {
  const value = Number(env.WHATSAPP_MEDIA_OCR_PDF_MAX_PAGES ?? DEFAULT_PDF_OCR_MAX_PAGES)

  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_PDF_OCR_MAX_PAGES
  }

  return Math.min(Math.floor(value), 10)
}

const extractPdfTextWithOcrFallback = async ({
  buffer,
  env = process.env,
  imageOcrExtractor = runTesseractImageOCR,
} = {}) => {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: buffer })

  try {
    const screenshots = await parser.getScreenshot({
      first: getPdfOcrMaxPages(env),
      imageBuffer: true,
      imageDataUrl: false,
      scale: 2,
    })
    const textParts = []

    for (const page of screenshots.pages ?? []) {
      const pageBuffer = Buffer.from(page.data ?? [])
      const pageText = await imageOcrExtractor({
        buffer: pageBuffer,
        env,
        mimeType: 'image/png',
        pageNumber: page.pageNumber,
        source: 'pdf-screenshot',
      })

      if (normalizeExtractedText(pageText)) {
        textParts.push(normalizeExtractedText(pageText))
      }
    }

    return textParts.join('\n\n')
  } finally {
    await parser.destroy?.()
  }
}

const extractTextForMedia = async ({
  absolutePath,
  env = process.env,
  imageOcrExtractor = runTesseractImageOCR,
  mimeType,
  pdfOcrExtractor = extractPdfTextWithOcrFallback,
  pdfTextExtractor = extractPdfEmbeddedText,
} = {}) => {
  const normalizedMimeType = toText(mimeType).toLowerCase()

  if (normalizedMimeType === 'image/jpeg' || normalizedMimeType === 'image/jpg' || normalizedMimeType === 'image/png') {
    return {
      method: MEDIA_EXTRACTION_METHODS.OCR_IMAGE,
      text: await imageOcrExtractor({
        absolutePath,
        env,
        mimeType: normalizedMimeType,
        source: 'image',
      }),
    }
  }

  if (normalizedMimeType === 'application/pdf') {
    const buffer = await fs.readFile(absolutePath)
    const embeddedText = await pdfTextExtractor({
      absolutePath,
      buffer,
      env,
      mimeType: normalizedMimeType,
    })

    if (isMeaningfulText(embeddedText)) {
      return {
        method: MEDIA_EXTRACTION_METHODS.PDF_TEXT,
        text: embeddedText,
      }
    }

    return {
      method: MEDIA_EXTRACTION_METHODS.OCR_PDF,
      text: await pdfOcrExtractor({
        absolutePath,
        buffer,
        env,
        imageOcrExtractor,
        mimeType: normalizedMimeType,
      }),
    }
  }

  return {
    method: '',
    text: '',
  }
}

const extractDownloadedWhatsAppMediaText = async ({
  env = process.env,
  imageOcrExtractor = runTesseractImageOCR,
  messageId,
  pdfOcrExtractor = extractPdfTextWithOcrFallback,
  pdfTextExtractor = extractPdfEmbeddedText,
  pool,
  projectRoot = process.cwd(),
  storageRoot = '',
  tableName = DEFAULT_MESSAGE_TABLE_NAME,
} = {}) => {
  if (!pool) {
    throw new Error('PostgreSQL pool is required for WhatsApp media text extraction.')
  }

  await ensureWhatsAppMediaTextExtractionSchema(pool, { tableName })

  const row = await getDownloadedMediaRow(pool, { messageId, tableName })

  if (!row) {
    throw new Error(`Downloaded WhatsApp media row was not found for ${messageId}.`)
  }

  const mimeType = getExtractionMimeType(row)

  if (row.media_extraction_status === MEDIA_EXTRACTION_STATUSES.EXTRACTED && row.media_extracted_text !== null) {
    return buildMediaExtractionResult({
      mediaId: row.media_id,
      mediaPath: normalizeProjectRelativePath(row.media_path),
      messageId,
      method: row.media_extraction_method || '',
      mimeType,
      skipped: true,
      status: MEDIA_EXTRACTION_STATUSES.EXTRACTED,
      text: row.media_extracted_text || '',
      textLength: String(row.media_extracted_text || '').length,
    })
  }

  if (row.media_download_status !== 'DOWNLOADED') {
    return buildMediaExtractionResult({
      error: 'Media download is not complete, so text extraction was not started.',
      mediaId: row.media_id,
      mediaPath: normalizeProjectRelativePath(row.media_path),
      messageId,
      mimeType,
      skipped: true,
      status: row.media_extraction_status || MEDIA_EXTRACTION_STATUSES.PENDING,
    })
  }

  if (!isSupportedExtractionMimeType(mimeType)) {
    const error = `Text extraction is not supported for MIME type: ${mimeType || 'unknown'}.`
    const updatedRow = await updateMediaExtractionStatus(pool, {
      error,
      messageId,
      status: MEDIA_EXTRACTION_STATUSES.EXTRACTION_NOT_SUPPORTED,
      tableName,
    })

    return buildMediaExtractionResult({
      error,
      mediaId: row.media_id,
      mediaPath: normalizeProjectRelativePath(row.media_path),
      messageId,
      mimeType,
      status: updatedRow?.media_extraction_status || MEDIA_EXTRACTION_STATUSES.EXTRACTION_NOT_SUPPORTED,
    })
  }

  try {
    await updateMediaExtractionStatus(pool, {
      error: null,
      messageId,
      method: null,
      status: MEDIA_EXTRACTION_STATUSES.EXTRACTING,
      tableName,
      text: null,
    })

    const resolvedPath = resolveStoredMediaPath({
      env,
      mediaPath: row.media_path,
      projectRoot,
      storageRoot,
    })
    const stat = await fs.stat(resolvedPath.absolutePath)

    if (!stat.isFile()) {
      throw new Error('Downloaded media path is not a file.')
    }

    const extraction = await extractTextForMedia({
      absolutePath: resolvedPath.absolutePath,
      env,
      imageOcrExtractor,
      mimeType,
      pdfOcrExtractor,
      pdfTextExtractor,
    })
    const extractedText = limitExtractedTextForStorage(extraction.text)
    const updatedRow = await updateMediaExtractionStatus(pool, {
      error: null,
      messageId,
      method: extraction.method,
      status: MEDIA_EXTRACTION_STATUSES.EXTRACTED,
      tableName,
      text: extractedText,
    })

    return buildMediaExtractionResult({
      mediaId: row.media_id,
      mediaPath: normalizeProjectRelativePath(row.media_path),
      messageId,
      method: updatedRow?.media_extraction_method || extraction.method,
      mimeType,
      status: updatedRow?.media_extraction_status || MEDIA_EXTRACTION_STATUSES.EXTRACTED,
      text: updatedRow?.media_extracted_text ?? extractedText,
      textLength: String(updatedRow?.media_extracted_text ?? extractedText).length,
    })
  } catch (error) {
    const errorMessage = safeErrorMessage(error)
    const updatedRow = await updateMediaExtractionStatus(pool, {
      error: errorMessage,
      messageId,
      status: MEDIA_EXTRACTION_STATUSES.EXTRACTION_FAILED,
      tableName,
      text: null,
    }).catch(() => null)

    return buildMediaExtractionResult({
      error: errorMessage,
      mediaId: row.media_id,
      mediaPath: normalizeProjectRelativePath(row.media_path),
      messageId,
      mimeType,
      status: updatedRow?.media_extraction_status || MEDIA_EXTRACTION_STATUSES.EXTRACTION_FAILED,
    })
  }
}

const getSafeMediaExtractionLogDetails = (result = {}) => ({
  error: result.error || '',
  extractionMethod: result.method || '',
  extractionStatus: result.status || '',
  mediaId: result.mediaId || '',
  mediaPath: result.mediaPath || '',
  messageId: result.messageId || '',
  mimeType: result.mimeType || '',
  skipped: Boolean(result.skipped),
  textLength: Number(result.textLength ?? 0),
})

export {
  buildMediaExtractionResult,
  chooseBestOcrResult,
  ensureWhatsAppMediaTextExtractionSchema,
  extractDownloadedWhatsAppMediaText,
  getSafeMediaExtractionLogDetails,
  isSupportedExtractionMimeType,
  MEDIA_EXTRACTION_METHODS,
  MEDIA_EXTRACTION_STATUSES,
  normalizeExtractedText,
  preprocessImageForOCR,
  resolveStoredMediaPath,
  runTesseractImageOCR,
  scoreOcrCandidate,
}

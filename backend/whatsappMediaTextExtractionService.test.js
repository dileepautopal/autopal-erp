import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import {
  chooseBestOcrResult,
  extractDownloadedWhatsAppMediaText,
  MEDIA_EXTRACTION_METHODS,
  MEDIA_EXTRACTION_STATUSES,
  preprocessImageForOCR,
  runTesseractImageOCR,
  scoreOcrCandidate,
} from './whatsappMediaTextExtractionService.js'

const createTempProject = async () =>
  fs.mkdtemp(path.join(os.tmpdir(), 'autopal-media-extraction-'))

const writeMediaFile = async (projectRoot, relativePath, content = 'media') => {
  const absolutePath = path.join(projectRoot, relativePath)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, content)

  return absolutePath
}

const createImageBuffer = ({
  background = {
    b: 255,
    g: 255,
    r: 255,
  },
  height = 320,
  width = 640,
} = {}) =>
  sharp({
    create: {
      background,
      channels: 3,
      height,
      width,
    },
  })
    .jpeg()
    .toBuffer()

const createFakeTesseract = (responses = []) => {
  const state = {
    createWorkerArgs: null,
    parameters: [],
    recognizedImages: [],
    terminated: false,
  }
  const worker = {
    async recognize(image) {
      const response = responses[Math.min(state.recognizedImages.length, Math.max(responses.length - 1, 0))]

      state.recognizedImages.push(image)

      return {
        data: {
          confidence: response?.confidence ?? 0,
          text: response?.text ?? '',
        },
      }
    },
    async setParameters(parameters) {
      state.parameters.push(parameters)
    },
    async terminate() {
      state.terminated = true
    },
  }

  return {
    module: {
      PSM: {
        AUTO: 3,
        SINGLE_BLOCK: 6,
        SINGLE_COLUMN: 4,
        SPARSE_TEXT: 11,
      },
      async createWorker(...args) {
        state.createWorkerArgs = args

        return worker
      },
    },
    state,
  }
}

const countNumericTokens = (value) => String(value).match(/\b\d+(?:[.,]\d+)?\b/g)?.length ?? 0

const createPool = (initialRow = {}) => {
  const state = {
    row: {
      id: 1,
      message_id: 'wamid.extract-test',
      received_at: '2026-08-10T10:00:00.000Z',
      message_type: 'image',
      media_id: 'meta-media-1',
      media_type: 'image',
      media_mime_type: 'image/jpeg',
      media_path: 'storage/whatsapp-media/2026/08/10/test.jpg',
      processing_status: 'MEDIA_RECEIVED',
      media_capture_status: 'CAPTURED',
      media_download_status: 'DOWNLOADED',
      media_downloaded_at: '2026-08-10T10:01:00.000Z',
      media_file_size: 128,
      media_extraction_status: 'PENDING',
      media_extracted_text: null,
      media_extracted_at: null,
      media_extraction_error: null,
      media_extraction_method: null,
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
        return state.row ? { rowCount: 1, rows: [state.row] } : { rowCount: 0, rows: [] }
      }

      if (/UPDATE\s+tran_whatsapp_pi_messages/i.test(sql)) {
        const update = {
          error: params[3],
          method: params[4],
          status: params[1],
          text: params[2],
        }
        state.updates.push(update)
        state.row = {
          ...state.row,
          media_extracted_at: update.status === MEDIA_EXTRACTION_STATUSES.EXTRACTED
            ? '2026-08-10T10:02:00.000Z'
            : state.row.media_extracted_at,
          media_extracted_text: update.text === null ? state.row.media_extracted_text : update.text,
          media_extraction_error: update.error,
          media_extraction_method: update.method === null
            ? state.row.media_extraction_method
            : update.method,
          media_extraction_status: update.status,
        }

        return { rowCount: 1, rows: [state.row] }
      }

      if (/INSERT INTO\s+master_pi_rmkt|INSERT INTO\s+tran_pi_rmkt/i.test(sql)) {
        throw new Error('Phase 2.3 media extraction must not create a PI.')
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

test('JPEG OCR success stores extracted text without PI creation', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  const absolutePath = await writeMediaFile(projectRoot, pool.state.row.media_path, 'jpeg')
  let ocrCalls = 0

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async (input) => {
      ocrCalls += 1
      assert.equal(input.absolutePath, absolutePath)
      assert.equal(input.mimeType, 'image/jpeg')
      return 'M/s Jalaram Enterprises\nSB 102 - 1000 Nos'
    },
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(result.method, MEDIA_EXTRACTION_METHODS.OCR_IMAGE)
  assert.match(result.text, /Jalaram Enterprises/)
  assert.equal(pool.state.row.media_extraction_status, 'EXTRACTED')
  assert.equal(pool.state.row.media_extraction_method, 'OCR_IMAGE')
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
  assert.equal(pool.state.row.pi_created, false)
  assert.equal(ocrCalls, 1)
})

test('PNG OCR success records OCR_IMAGE method', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({
    media_mime_type: 'image/png',
    media_path: 'storage/whatsapp-media/2026/08/10/test.png',
  })
  await writeMediaFile(projectRoot, pool.state.row.media_path, 'png')

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => 'PNG visible text',
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(result.method, MEDIA_EXTRACTION_METHODS.OCR_IMAGE)
  assert.equal(pool.state.row.media_extracted_text, 'PNG visible text')
})

test('text-based PDF uses embedded PDF text and does not invoke OCR', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({
    media_mime_type: 'application/pdf',
    media_path: 'storage/whatsapp-media/2026/08/10/order.pdf',
    media_type: 'document',
    message_type: 'document',
  })
  await writeMediaFile(projectRoot, pool.state.row.media_path, '%PDF-1.4')
  let ocrCalls = 0

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => {
      ocrCalls += 1
      return 'should not be used'
    },
    messageId: 'wamid.extract-test',
    pdfTextExtractor: async () => 'Selectable PDF order text',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(result.method, MEDIA_EXTRACTION_METHODS.PDF_TEXT)
  assert.equal(result.text, 'Selectable PDF order text')
  assert.equal(ocrCalls, 0)
})

test('scanned PDF falls back to OCR_PDF when embedded text is empty', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({
    media_mime_type: 'application/pdf',
    media_path: 'storage/whatsapp-media/2026/08/10/scanned.pdf',
    media_type: 'document',
    message_type: 'document',
  })
  await writeMediaFile(projectRoot, pool.state.row.media_path, '%PDF-scanned')
  let pdfOcrCalls = 0

  const result = await extractDownloadedWhatsAppMediaText({
    messageId: 'wamid.extract-test',
    pdfOcrExtractor: async ({ buffer }) => {
      pdfOcrCalls += 1
      assert.equal(Buffer.isBuffer(buffer), true)
      return 'Scanned PDF OCR text'
    },
    pdfTextExtractor: async () => '   ',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(result.method, MEDIA_EXTRACTION_METHODS.OCR_PDF)
  assert.equal(result.text, 'Scanned PDF OCR text')
  assert.equal(pdfOcrCalls, 1)
})

test('extraction failure records error and leaves capture/download state intact', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  await writeMediaFile(projectRoot, pool.state.row.media_path, 'jpeg')

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => {
      throw new Error('OCR engine failed')
    },
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })
  const storedFile = await fs.readFile(path.join(projectRoot, pool.state.row.media_path), 'utf8')

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTION_FAILED)
  assert.match(result.error, /OCR engine failed/)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
  assert.equal(storedFile, 'jpeg')
})

test('missing local file becomes EXTRACTION_FAILED without crashing', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => 'not reached',
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTION_FAILED)
  assert.ok(result.error)
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
})

test('path traversal media_path is refused before extraction', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({
    media_mime_type: 'application/pdf',
    media_path: '../../outside.pdf',
  })
  let extractionCalls = 0

  const result = await extractDownloadedWhatsAppMediaText({
    messageId: 'wamid.extract-test',
    pdfTextExtractor: async () => {
      extractionCalls += 1
      return 'should not be reached'
    },
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTION_FAILED)
  assert.match(result.error, /outside the configured media storage directory/)
  assert.equal(extractionCalls, 0)
})

test('duplicate extraction invocation returns existing row without running OCR again', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  await writeMediaFile(projectRoot, pool.state.row.media_path, 'jpeg')
  let ocrCalls = 0

  const first = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => {
      ocrCalls += 1
      return 'First OCR text'
    },
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })
  const second = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => {
      ocrCalls += 1
      return 'Second OCR text'
    },
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(first.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(second.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(second.skipped, true)
  assert.equal(second.text, 'First OCR text')
  assert.equal(ocrCalls, 1)
})

test('unsupported media is marked EXTRACTION_NOT_SUPPORTED', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool({
    media_mime_type: 'audio/ogg',
    media_path: 'storage/whatsapp-media/2026/08/10/audio.ogg',
    media_type: 'audio',
    message_type: 'audio',
  })
  await writeMediaFile(projectRoot, pool.state.row.media_path, 'audio')

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => {
      throw new Error('unsupported media must not call OCR')
    },
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTION_NOT_SUPPORTED)
  assert.match(result.error, /not supported/)
  assert.equal(pool.state.row.media_capture_status, 'CAPTURED')
  assert.equal(pool.state.row.media_download_status, 'DOWNLOADED')
})

test('empty OCR result is stored as successful empty EXTRACTED text', async () => {
  const projectRoot = await createTempProject()
  const pool = createPool()
  await writeMediaFile(projectRoot, pool.state.row.media_path, 'blank')

  const result = await extractDownloadedWhatsAppMediaText({
    imageOcrExtractor: async () => '   \n   ',
    messageId: 'wamid.extract-test',
    pool,
    projectRoot,
  })

  assert.equal(result.status, MEDIA_EXTRACTION_STATUSES.EXTRACTED)
  assert.equal(result.method, MEDIA_EXTRACTION_METHODS.OCR_IMAGE)
  assert.equal(result.text, '')
  assert.equal(pool.state.row.media_extracted_text, '')
  assert.equal(pool.state.row.media_extraction_error, null)
})

test('image OCR preprocesses a copied image before Tesseract and leaves the original file unchanged', async () => {
  const projectRoot = await createTempProject()
  const imageBuffer = await createImageBuffer({ width: 640 })
  const absolutePath = await writeMediaFile(
    projectRoot,
    'storage/whatsapp-media/2026/08/10/photo.jpg',
    imageBuffer,
  )
  const originalBefore = await fs.readFile(absolutePath)
  const fakeTesseract = createFakeTesseract([
    {
      confidence: 20,
      text: '~~~~',
    },
    {
      confidence: 82,
      text: 'Visible values 12.00 54.00',
    },
    {
      confidence: 40,
      text: 'Visible',
    },
  ])

  const text = await runTesseractImageOCR({
    absolutePath,
    tesseractModule: fakeTesseract.module,
  })
  const originalAfter = await fs.readFile(absolutePath)

  assert.deepEqual(originalAfter, originalBefore)
  assert.equal(Buffer.isBuffer(fakeTesseract.state.recognizedImages[0]), true)
  assert.notEqual(Buffer.compare(fakeTesseract.state.recognizedImages[0], originalBefore), 0)
  assert.match(text, /12\.00 54\.00/)
  assert.equal(fakeTesseract.state.recognizedImages.length, 3)
  assert.equal(fakeTesseract.state.terminated, true)
})

test('image preprocessing upscales low-resolution images within the OCR bound', async () => {
  const imageBuffer = await createImageBuffer({
    height: 240,
    width: 500,
  })

  const processed = await preprocessImageForOCR({ buffer: imageBuffer })
  const metadata = await sharp(processed.buffer).metadata()

  assert.equal(processed.originalWidth, 500)
  assert.equal(processed.targetWidth, 1800)
  assert.equal(metadata.width, 1800)
  assert.ok(metadata.width <= 3000)
  assert.ok(processed.steps.includes('resize-up'))
})

test('image preprocessing applies grayscale contrast path and creates a PNG OCR copy', async () => {
  const imageBuffer = await createImageBuffer({
    background: {
      b: 32,
      g: 96,
      r: 190,
    },
    width: 1900,
  })

  const processed = await preprocessImageForOCR({ buffer: imageBuffer })
  const metadata = await sharp(processed.buffer).metadata()

  assert.equal(metadata.format, 'png')
  assert.ok(processed.steps.includes('grayscale'))
  assert.ok(processed.steps.includes('normalise'))
  assert.ok(processed.steps.includes('contrast'))
  assert.ok(processed.steps.includes('sharpen'))
  assert.equal(processed.targetWidth, 1900)
})

test('image OCR runs bounded configured Tesseract PSM passes and selects the best result', async () => {
  const imageBuffer = await createImageBuffer({ width: 900 })
  const fakeTesseract = createFakeTesseract([
    {
      confidence: 35,
      text: '|| || ||',
    },
    {
      confidence: 88,
      text: 'Clean readable OCR text 707.00',
    },
    {
      confidence: 55,
      text: 'Clean text',
    },
  ])

  const text = await runTesseractImageOCR({
    buffer: imageBuffer,
    tesseractModule: fakeTesseract.module,
  })

  assert.equal(text, 'Clean readable OCR text 707.00')
  assert.deepEqual(
    fakeTesseract.state.parameters.map((parameters) => parameters.tessedit_pageseg_mode),
    ['6', '4', '11'],
  )
  assert.equal(fakeTesseract.state.recognizedImages.length, 3)
})

test('image OCR falls back to original image OCR when preprocessing fails', async () => {
  const absolutePath = path.join(os.tmpdir(), 'autopal-original-fallback.jpg')
  const fakeTesseract = createFakeTesseract([
    {
      confidence: 79,
      text: 'Original image fallback text',
    },
  ])

  const text = await runTesseractImageOCR({
    absolutePath,
    imagePreprocessor: async () => {
      throw new Error('preprocessing failed')
    },
    tesseractModule: fakeTesseract.module,
  })

  assert.equal(text, 'Original image fallback text')
  assert.equal(fakeTesseract.state.recognizedImages[0], absolutePath)
  assert.deepEqual(
    fakeTesseract.state.parameters.map((parameters) => parameters.tessedit_pageseg_mode),
    ['3'],
  )
})

test('OCR candidate scoring rejects garbage when a readable result is available', () => {
  const garbage = {
    confidence: 92,
    text: '~~~~ ||| ^^^ ```',
  }
  const readable = {
    confidence: 65,
    text: 'Readable text with numbers 12.00 54.00 and words',
  }

  assert.ok(scoreOcrCandidate(readable) > scoreOcrCandidate(garbage))
  assert.equal(chooseBestOcrResult([garbage, readable]).text, readable.text)
})

test('OCR best-result selection preserves business-like numeric tokens without parsing them', () => {
  const oldBaseline = {
    confidence: 74,
    text: [
      'HEAD LIGHT ASSY ACE MEGA',
      'I2.OO Nos',
      '7O7.OO',
      'HL-228 S - H3 FOG LAMP SMALL',
      '54.OO Nos',
      '82.4g',
      'HL230S 100MM FOG LAMP',
      '36.OO Nos',
      'I24.9I',
      'TT TAIL LAMP ASSY',
      '32.OO Nos',
      '247.4G',
    ].join('\n'),
  }
  const improved = {
    confidence: 72,
    text: [
      'HEAD LIGHT ASSY ACE MEGA',
      '12.00 Nos',
      '707.00',
      'HL-228 S - H3 FOG LAMP SMALL',
      '54.00 Nos',
      '82.49',
      'HL230S 100MM FOG LAMP',
      '36.00 Nos',
      '124.91',
      'TT TAIL LAMP ASSY',
      '32.00 Nos',
      '247.46',
    ].join('\n'),
  }
  const best = chooseBestOcrResult([oldBaseline, improved])

  assert.equal(best.text, improved.text)
  assert.ok(countNumericTokens(best.text) > countNumericTokens(oldBaseline.text))
  for (const value of ['12.00', '54.00', '36.00', '32.00', '707.00', '82.49', '124.91', '247.46']) {
    assert.match(best.text, new RegExp(value.replace('.', '\\.')))
  }
})

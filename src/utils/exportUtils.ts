const INVALID_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

const replaceUnsafeFilenameChars = (value: string) =>
  Array.from(value)
    .map((character) =>
      character.charCodeAt(0) < 32 || INVALID_FILENAME_CHARS.has(character)
        ? ' '
        : character,
    )
    .join('')

export const toFiniteNumber = (value: unknown, fallback = 0) => {
  const number = Number(value ?? fallback)

  return Number.isFinite(number) ? number : fallback
}

export const getIndiaDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
  }).formatToParts(date)
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ''

  return {
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    month: getPart('month'),
    second: getPart('second'),
    year: getPart('year'),
  }
}

export const getIndiaDateStamp = (date = new Date()) => {
  const parts = getIndiaDateParts(date)

  return `${parts.year}-${parts.month}-${parts.day}`
}

export const getIndiaTimestampStamp = (date = new Date()) => {
  const parts = getIndiaDateParts(date)

  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`
}

export const formatDateISO = (value?: string) => {
  const text = String(value ?? '').trim()

  if (!text) {
    return ''
  }

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/)

  return match ? `${match[1]}-${match[2]}-${match[3]}` : text
}

export const formatReportDate = (value?: string) => {
  const isoDate = formatDateISO(value)

  if (!isoDate) {
    return '-'
  }

  const date = new Date(`${isoDate}T00:00:00Z`)

  if (Number.isNaN(date.getTime())) {
    return isoDate
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date)
}

export const formatReportDateTime = (value?: string) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
  }).format(date)
}

export const formatINR = (value: unknown) =>
  new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(toFiniteNumber(value))

export const formatReportNumber = (value: unknown, maximumFractionDigits = 2) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits,
  }).format(toFiniteNumber(value))

export const sanitizeFilename = (
  value: string,
  extension: string,
  maxLength = 140,
) => {
  const safeExtension = replaceUnsafeFilenameChars(extension.replace(/^\.+/, ''))
    .replace(/\s+/g, '')
  const baseName = replaceUnsafeFilenameChars(String(value || 'AUTOPAL_Report'))
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, Math.max(maxLength - safeExtension.length - 1, 20))
  const safeBaseName = baseName || 'AUTOPAL_Report'

  return `${safeBaseName}.${safeExtension}`
}

export const escapeCsvCell = (value: unknown) => {
  const text = String(value ?? '')

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }

  return text
}

export const createCsvText = (rows: unknown[][]) =>
  `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  window.setTimeout(() => window.URL.revokeObjectURL(url), 1_000)
}

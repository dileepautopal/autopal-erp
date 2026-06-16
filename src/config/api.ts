const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''
const isLocalDev =
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  ['127.0.0.1', 'localhost'].includes(window.location.hostname)

const apiBaseUrl = (
  configuredApiBaseUrl || (isLocalDev ? 'http://127.0.0.1:5000' : '')
).replace(/\/$/, '')

export const apiUrl = (path: string) =>
  `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`

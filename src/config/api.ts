const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? ''

const apiBaseUrl = (
  import.meta.env.DEV ? '' : configuredApiBaseUrl
).replace(/\/$/, '')

export const apiUrl = (path: string) =>
  `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`

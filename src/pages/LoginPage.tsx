import { useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { InputField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import type { ScreenId, UserSession } from '../types'

type LoginPageProps = {
  onLogin: (session: UserSession) => void
}

type LoginMode = 'login' | 'change-password'
type MessageTone = 'error' | 'success'

const LOGIN_API_URL = apiUrl('/api/login')
const CHANGE_PASSWORD_API_URL = apiUrl('/api/change-password')

type LoginLocation = {
  latitude?: number
  longitude?: number
  locationText: string
}

type IPLocationProvider = {
  mapLocation: (body: Record<string, unknown>) => LoginLocation | null
  url: string
}

const getMapsUrl = (latitude: number, longitude: number) =>
  `https://www.google.com/maps?q=${latitude},${longitude}`

const getLocationFromCoordinates = (
  latitudeValue: unknown,
  longitudeValue: unknown,
) => {
  const latitude = Number(latitudeValue)
  const longitude = Number(longitudeValue)

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null
  }

  return {
    latitude,
    locationText: getMapsUrl(latitude, longitude),
    longitude,
  }
}

const getTimezoneLocation = (): LoginLocation => ({
  locationText: Intl.DateTimeFormat().resolvedOptions().timeZone,
})

const getGrantedBrowserLocation = () =>
  new Promise<LoginLocation | null>((resolve) => {
    if (!navigator.geolocation || !navigator.permissions) {
      resolve(null)
      return
    }

    navigator.permissions
      .query({ name: 'geolocation' })
      .then((permissionStatus) => {
        if (permissionStatus.state !== 'granted') {
          resolve(null)
          return
        }

        navigator.geolocation.getCurrentPosition(
          (position) => {
            const latitude = position.coords.latitude
            const longitude = position.coords.longitude

            resolve({
              latitude,
              locationText: getMapsUrl(latitude, longitude),
              longitude,
            })
          },
          () => resolve(null),
          {
            enableHighAccuracy: false,
            maximumAge: 10 * 60 * 1000,
            timeout: 2500,
          },
        )
      })
      .catch(() => resolve(null))
  })

const ipLocationProviders: IPLocationProvider[] = [
  {
    mapLocation: (body) =>
      getLocationFromCoordinates(body.latitude, body.longitude),
    url: 'https://ipapi.co/json/',
  },
  {
    mapLocation: (body) =>
      body.success === false
        ? null
        : getLocationFromCoordinates(body.latitude, body.longitude),
    url: 'https://ipwho.is/',
  },
  {
    mapLocation: (body) =>
      getLocationFromCoordinates(body.latitude, body.longitude),
    url: 'https://get.geojs.io/v1/ip/geo.json',
  },
]

const fetchLocationJSON = async (url: string) => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 2500)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    window.clearTimeout(timeoutId)
  }
}

const getBrowserIPLocation = async () => {
  const locations = await Promise.all(
    ipLocationProviders.map(async (provider) => {
      const body = await fetchLocationJSON(provider.url)
      return body ? provider.mapLocation(body) : null
    }),
  )

  return locations.find(Boolean) ?? null
}

const getLoginLocation = async (): Promise<LoginLocation> =>
  (await getGrantedBrowserLocation()) ??
  (await getBrowserIPLocation()) ??
  getTimezoneLocation()

const getApiErrorMessage = async (
  response: Response,
  fallback = 'You are not authorised person.',
) => {
  try {
    const body = (await response.json()) as {
      message?: string
    }

    if (body.message) {
      return body.message
    }
  } catch {
    // Fall back to the status message below.
  }

  return fallback
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [mode, setMode] = useState<LoginMode>('login')
  const [userName, setUserName] = useState('')
  const [pw, setPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<MessageTone>('error')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isChangingPassword = mode === 'change-password'

  const showMessage = (nextMessage: string, tone: MessageTone = 'error') => {
    setMessage(nextMessage)
    setMessageTone(tone)
  }

  const switchMode = (nextMode: LoginMode) => {
    setMode(nextMode)
    setPw('')
    setNewPw('')
    setConfirmPw('')
    setMessage('')
    setMessageTone('error')
  }

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setMessageTone('error')
    setIsSubmitting(true)

    try {
      const location = await getLoginLocation()
      const response = await fetch(LOGIN_API_URL, {
        body: JSON.stringify({
          location,
          pw,
          userName,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const result = (await response.json()) as {
        authorized?: boolean
        isAdmin?: boolean
        rights?: ScreenId[]
        userName?: string
      }

      if (!result.authorized) {
        throw new Error('You are not authorised person.')
      }

      onLogin({
        isAdmin: Boolean(result.isAdmin),
        rights: Array.isArray(result.rights) ? result.rights : [],
        userName: result.userName || userName,
      })
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : 'You are not authorised person.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const submitPasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage('')
    setMessageTone('error')

    if (newPw !== confirmPw) {
      showMessage('New password and confirm password do not match.')
      return
    }

    setIsSubmitting(true)

    try {
      const response = await fetch(CHANGE_PASSWORD_API_URL, {
        body: JSON.stringify({
          newPw,
          oldPw: pw,
          userName,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(
          await getApiErrorMessage(
            response,
            'Password could not be changed. Please check details.',
          ),
        )
      }

      const result = (await response.json()) as {
        changed?: boolean
        message?: string
      }

      if (!result.changed) {
        throw new Error('Password could not be changed. Please check details.')
      }

      setMode('login')
      setPw('')
      setNewPw('')
      setConfirmPw('')
      showMessage(
        result.message || 'Password changed successfully. Please login.',
        'success',
      )
    } catch (error) {
      showMessage(
        error instanceof Error
          ? error.message
          : 'Password could not be changed. Please check details.',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-brand">
          <img
            alt="AUTOPAL logo"
            className="login-logo"
            src="/autopal-logo.png"
          />
          <div>
            <p className="eyebrow">AUTOPAL</p>
            <h1>{isChangingPassword ? 'Change Password' : 'PI System Login'}</h1>
          </div>
        </div>

        <form
          className="login-form"
          onSubmit={isChangingPassword ? submitPasswordChange : submitLogin}
        >
          <InputField
            autoComplete="username"
            label="User Name"
            onChange={(event) => setUserName(event.target.value)}
            required
            value={userName}
          />
          <InputField
            autoComplete="current-password"
            label={isChangingPassword ? 'Current Password' : 'Password'}
            onChange={(event) => setPw(event.target.value)}
            required
            type="password"
            value={pw}
          />
          {isChangingPassword ? (
            <>
              <InputField
                autoComplete="new-password"
                label="New Password"
                onChange={(event) => setNewPw(event.target.value)}
                required
                type="password"
                value={newPw}
              />
              <InputField
                autoComplete="new-password"
                label="Confirm Password"
                onChange={(event) => setConfirmPw(event.target.value)}
                required
                type="password"
                value={confirmPw}
              />
            </>
          ) : null}

          {message ? (
            <div
              className={`login-message ${
                messageTone === 'success' ? 'success' : ''
              }`.trim()}
            >
              {message}
            </div>
          ) : null}

          <Button disabled={isSubmitting} type="submit">
            {isSubmitting
              ? isChangingPassword
                ? 'Changing'
                : 'Checking'
              : isChangingPassword
                ? 'Change Password'
                : 'Login'}
          </Button>
          <div className="login-switch-row">
            <Button
              disabled={isSubmitting}
              onClick={() =>
                switchMode(isChangingPassword ? 'login' : 'change-password')
              }
              type="button"
              variant="ghost"
            >
              {isChangingPassword ? 'Back to Login' : 'Change Password'}
            </Button>
          </div>
        </form>
      </section>
    </main>
  )
}

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button } from '../components/ui/Button'
import { InputField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import { navItems } from '../data/mockData'
import type { ScreenId, UserAccess } from '../types'

type AdminPanelProps = {
  currentUserName: string
}

type UserFormState = {
  userName: string
  password: string
  isAdmin: boolean
  isActive: boolean
  rights: ScreenId[]
}

const ADMIN_USERS_API_URL = apiUrl('/api/admin/users')
const defaultRights = navItems
  .filter((item) => item.id !== 'admin-panel')
  .map((item) => item.id)

const emptyForm: UserFormState = {
  isActive: true,
  isAdmin: false,
  password: '',
  rights: defaultRights,
  userName: '',
}

const formatLoginDate = (value?: string) => {
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
    year: 'numeric',
  }).format(date)
}

const isWebLocation = (value?: string) =>
  Boolean(value && /^https?:\/\//i.test(value))

const getLocationUrl = (value?: string) => {
  if (!value) {
    return ''
  }

  if (isWebLocation(value)) {
    return value
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    value,
  )}`
}

const formatLocationLabel = (value?: string) => {
  if (!value) {
    return '-'
  }

  if (getLocationUrl(value)) {
    return 'Open Google Map'
  }

  return value
}

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as { message?: string }

    if (body.message) {
      return body.message
    }
  } catch {
    // Use the generic status message below.
  }

  return `Request failed with status ${response.status}`
}

export function AdminPanel({ currentUserName }: AdminPanelProps) {
  const [users, setUsers] = useState<UserAccess[]>([])
  const [form, setForm] = useState<UserFormState>(emptyForm)
  const [editingUserName, setEditingUserName] = useState('')
  const [message, setMessage] = useState('Loading users')
  const [isSaving, setIsSaving] = useState(false)

  const rightsSummary = useMemo(
    () =>
      form.isAdmin
        ? 'Admin users can access all menus.'
        : `${form.rights.length} menu rights selected`,
    [form.isAdmin, form.rights.length],
  )

  const requestHeaders = {
    'Content-Type': 'application/json',
    'x-autopal-user': currentUserName,
  }

  const loadUsers = async () => {
    try {
      const response = await fetch(ADMIN_USERS_API_URL, {
        headers: {
          'x-autopal-user': currentUserName,
        },
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const records = (await response.json()) as UserAccess[]
      setUsers(Array.isArray(records) ? records : [])
      setMessage('User rights ready')
    } catch (error) {
      setUsers([])
      setMessage(
        error instanceof Error
          ? error.message
          : 'Unable to load admin users',
      )
    }
  }

  useEffect(() => {
    void loadUsers()
  }, [currentUserName])

  const toggleRight = (screenId: ScreenId) => {
    setForm((currentForm) => {
      const hasRight = currentForm.rights.includes(screenId)

      return {
        ...currentForm,
        rights: hasRight
          ? currentForm.rights.filter((right) => right !== screenId)
          : [...currentForm.rights, screenId],
      }
    })
  }

  const editUser = (user: UserAccess) => {
    setEditingUserName(user.userName)
    setForm({
      isActive: user.isActive,
      isAdmin: user.isAdmin,
      password: '',
      rights:
        user.rights.length > 0
          ? user.rights.filter((right) => right !== 'admin-panel')
          : defaultRights,
      userName: user.userName,
    })
    setMessage(`Editing ${user.userName}`)
  }

  const resetForm = () => {
    setEditingUserName('')
    setForm(emptyForm)
    setMessage('Ready for new user')
  }

  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsSaving(true)

    try {
      const isEditing = Boolean(editingUserName)
      const response = await fetch(
        isEditing
          ? `${ADMIN_USERS_API_URL}/${encodeURIComponent(editingUserName)}/rights`
          : ADMIN_USERS_API_URL,
        {
          body: JSON.stringify({
            isActive: form.isActive,
            isAdmin: form.isAdmin,
            password: form.password,
            rights: form.isAdmin ? [] : form.rights,
            userName: form.userName,
          }),
          headers: requestHeaders,
          method: isEditing ? 'PUT' : 'POST',
        },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const records = (await response.json()) as UserAccess[]
      setUsers(Array.isArray(records) ? records : [])
      setMessage(`${form.userName} saved`)
      resetForm()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save user')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="page admin-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Admin Panel</h1>
          <p className="page-subtitle">
            Create users, manage menu access, and review login activity.
          </p>
        </div>
        <span className="status-pill">{message}</span>
      </header>

      <section className="admin-user-layout">
        <form className="panel admin-user-form" onSubmit={saveUser}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">{editingUserName ? 'Edit' : 'Create'}</p>
              <h2>{editingUserName || 'New user'}</h2>
            </div>
            <Button onClick={resetForm} type="button" variant="ghost">
              Clear
            </Button>
          </div>

          <div className="admin-user-fields">
            <InputField
              disabled={Boolean(editingUserName)}
              label="User Name"
              onChange={(event) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  userName: event.target.value,
                }))
              }
              required
              value={form.userName}
            />
            <InputField
              label={editingUserName ? 'New Password' : 'Password'}
              onChange={(event) =>
                setForm((currentForm) => ({
                  ...currentForm,
                  password: event.target.value,
                }))
              }
              required={!editingUserName}
              type="password"
              value={form.password}
            />
          </div>

          <div className="admin-switch-row">
            <label>
              <input
                checked={form.isActive}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    isActive: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              Active user
            </label>
            <label>
              <input
                checked={form.isAdmin}
                onChange={(event) =>
                  setForm((currentForm) => ({
                    ...currentForm,
                    isAdmin: event.target.checked,
                  }))
                }
                type="checkbox"
              />
              Admin user
            </label>
          </div>

          <div className="admin-rights-head">
            <strong>Menu Access</strong>
            <span>{rightsSummary}</span>
          </div>
          <div className="admin-rights-grid">
            {navItems
              .filter((item) => item.id !== 'admin-panel')
              .map((item) => (
                <label key={item.id}>
                  <input
                    checked={form.isAdmin || form.rights.includes(item.id)}
                    disabled={form.isAdmin}
                    onChange={() => toggleRight(item.id)}
                    type="checkbox"
                  />
                  <span>
                    {item.label}
                    <small>{item.meta}</small>
                  </span>
                </label>
              ))}
          </div>

          <div className="admin-form-actions">
            <Button disabled={isSaving} type="submit">
              {isSaving ? 'Saving' : 'Save User'}
            </Button>
          </div>
        </form>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Users</p>
              <h2>User Access List</h2>
            </div>
            <Button onClick={() => void loadUsers()} variant="secondary">
              Refresh
            </Button>
          </div>

          <div className="responsive-table">
            <table className="master-table admin-user-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Status</th>
                  <th>Rights</th>
                  <th>Last Login</th>
                  <th>Location</th>
                  <th>Edit</th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6}>No users found.</td>
                  </tr>
                ) : (
                  users.map((user) => {
                    const locationUrl = getLocationUrl(user.lastLoginLocation)

                    return (
                      <tr key={user.userName}>
                        <td>
                          <strong>{user.userName}</strong>
                        </td>
                        <td>
                          <span
                            className={`table-status ${
                              user.isActive ? 'saffron' : ''
                            }`}
                          >
                            {user.isActive ? 'Active' : 'Inactive'}
                          </span>
                          {user.isAdmin ? <small>Admin</small> : null}
                        </td>
                        <td>
                          {user.isAdmin
                            ? 'All menus'
                            : user.rights
                                .map(
                                  (right) =>
                                    navItems.find((item) => item.id === right)
                                      ?.label ?? right,
                                )
                                .join(', ') || '-'}
                        </td>
                        <td>{formatLoginDate(user.lastLoginAt)}</td>
                        <td>
                          {locationUrl ? (
                            <a
                              href={locationUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {formatLocationLabel(user.lastLoginLocation)}
                            </a>
                          ) : (
                            formatLocationLabel(user.lastLoginLocation)
                          )}
                        </td>
                        <td>
                          <Button
                            onClick={() => editUser(user)}
                            variant="secondary"
                          >
                            Edit
                          </Button>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </div>
  )
}

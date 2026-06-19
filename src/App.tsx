import { useCallback, useEffect, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { CreatePI } from './pages/CreatePI'
import { CustomerDiscountMaster } from './pages/CustomerDiscountMaster'
import { CustomerMaster } from './pages/CustomerMaster'
import { Dashboard } from './pages/Dashboard'
import { LoginPage } from './pages/LoginPage'
import { PIList } from './pages/PIList'
import { ProductMaster } from './pages/ProductMaster'
import { RMarketProductRateMaster } from './pages/RMarketProductRateMaster'
import { apiUrl } from './config/api'
import { initialPIForm } from './data/piDefaults'
import type { Company, PIFormState, SavedPI, ScreenId } from './types'

const COMPANY_API_URL = apiUrl('/api/master-companies')
const PI_RMKT_API_URL = apiUrl('/api/master-pi-rmkt')
const LOGIN_SESSION_KEY = 'autopal-login-user'

type APIRecord = Record<string, unknown>

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

const toText = (value: unknown) => String(value ?? '')

const getCompanyIdFromCompCode = (compCode: number, companies: Company[]) =>
  companies.find((company) => company.compCode === compCode)?.id ?? ''

const normalizeAPILineItem = (line: APIRecord, index: number) => ({
  id: toText(line.id) || `line-${index + 1}`,
  productId: toText(line.productId ?? line.product_id),
  productCode: toText(line.productCode ?? line.product_code),
  description: toText(
    line.description ?? line.productDescription ?? line.product_description,
  ),
  hsnCode: toText(line.hsnCode ?? line.hsn_code),
  unit: toText(line.unit ?? line.productUnit ?? line.product_unit ?? line.uom),
  quantity: toNumber(line.quantity ?? line.qty),
  unitPrice: toNumber(line.unitPrice ?? line.rate),
  gstPercent: toNumber(line.gstPercent ?? line.gst_percent),
  discountPercent: toNumber(
    line.discountPercent ?? line.discPercent ?? line.disc_percent,
  ),
})

const apiPIToSavedPI = (pi: APIRecord, companies: Company[] = []): SavedPI => {
  const compCode = toNumber(pi.compCode ?? pi.comp_code)
  const lineItems = Array.isArray(pi.lineItems)
    ? pi.lineItems.map((line, index) =>
        normalizeAPILineItem(line as APIRecord, index),
      )
    : initialPIForm.lineItems.map((line) => ({ ...line }))

  return {
    ...initialPIForm,
    ...pi,
    id: toText(pi.id) || toText(pi.piNumber) || `pi-${Date.now()}`,
    companyId:
      toText(pi.companyId ?? pi.company_id) ||
      getCompanyIdFromCompCode(compCode, companies),
    customerId: toText(pi.customerId ?? pi.customer_id),
    prospectiveGstNo: toText(
      pi.prospectiveGstNo ?? pi.prospective_gst_no ?? pi.gstNo ?? pi.gst_no,
    ),
    piNumber: toText(pi.piNumber),
    piDate: toText(pi.piDate),
    deliveryDate: toText(pi.deliveryDate),
    status: pi.status === 'Final' ? 'Final' : 'Draft',
    updatedAt: toText(pi.updatedAt ?? pi.updated_at) || new Date().toISOString(),
    lineItems,
  } as SavedPI
}

const savedPIToForm = (pi: SavedPI): PIFormState => ({
  ...initialPIForm,
  ...pi,
  lineItems: pi.lineItems.map((line) => ({
    ...line,
    discountPercent: line.discountPercent ?? 0,
  })),
})

const createSavedPI = (
  form: PIFormState,
  id: string,
  status: SavedPI['status'],
): SavedPI => ({
  ...form,
  id,
  status,
  updatedAt: new Date().toISOString(),
  lineItems: form.lineItems.map((line) => ({ ...line })),
})

const getPIPrefix = (companyId: string, companies: Company[]) => {
  const company = companies.find((item) => item.id === companyId)

  if (!company) {
    return ''
  }

  return company.piPrefix || ''
}

const getStoredLoginUser = () => {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.sessionStorage.getItem(LOGIN_SESSION_KEY) ?? ''
}

function App() {
  const [loggedInUser, setLoggedInUser] = useState(getStoredLoginUser)
  const [activeScreen, setActiveScreen] = useState<ScreenId>('create-pi')
  const [companies, setCompanies] = useState<Company[]>([])
  const [piForm, setPiForm] = useState<PIFormState>(initialPIForm)
  const [savedPIs, setSavedPIs] = useState<SavedPI[]>([])
  const [editingPIId, setEditingPIId] = useState<string | null>(null)

  const loadBackendPIs = useCallback(async () => {
    try {
      const response = await fetch(PI_RMKT_API_URL)

      if (!response.ok) {
        setSavedPIs([])
        return
      }

      const records = (await response.json()) as APIRecord[]
      const backendPIs = Array.isArray(records)
        ? records.map((record) => apiPIToSavedPI(record, companies))
        : []

      setSavedPIs(backendPIs)
    } catch {
      setSavedPIs([])
    }
  }, [companies])

  useEffect(() => {
    const syncLoginSession = () => {
      setLoggedInUser(getStoredLoginUser())
    }

    window.addEventListener('pageshow', syncLoginSession)
    window.addEventListener('popstate', syncLoginSession)
    window.addEventListener('focus', syncLoginSession)

    return () => {
      window.removeEventListener('pageshow', syncLoginSession)
      window.removeEventListener('popstate', syncLoginSession)
      window.removeEventListener('focus', syncLoginSession)
    }
  }, [])

  useEffect(() => {
    const loadCompanies = async () => {
      try {
        const response = await fetch(COMPANY_API_URL)

        if (!response.ok) {
          setCompanies([])
          return
        }

        const records = (await response.json()) as Company[]
        setCompanies(Array.isArray(records) ? records : [])
      } catch {
        setCompanies([])
      }
    }

    void loadCompanies()
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadBackendPIs()
    }, 0)

    return () => window.clearTimeout(timer)
  }, [loadBackendPIs])

  const openBlankPI = () => {
    setPiForm(initialPIForm)
    setEditingPIId(null)
    setActiveScreen('create-pi')
  }

  const navigate = (screen: ScreenId) => {
    if (screen === 'create-pi') {
      openBlankPI()
      return
    }

    setActiveScreen(screen)
  }

  const generatePINumber = (companyId: string) => {
    const prefix = getPIPrefix(companyId, companies)

    if (!prefix) {
      return ''
    }

    const nextNumber =
      savedPIs.reduce((maxNumber, pi) => {
        if (!pi.piNumber.startsWith(prefix)) {
          return maxNumber
        }

        const sequence = Number(pi.piNumber.replace(prefix, ''))
        return Number.isFinite(sequence) ? Math.max(maxNumber, sequence) : maxNumber
      }, 0) + 1

    return `${prefix}${String(nextNumber).padStart(4, '0')}`
  }

  const saveDraftPI = (form: PIFormState) => {
    const existingPI = savedPIs.find((pi) => pi.piNumber === form.piNumber)
    const targetId = editingPIId ?? existingPI?.id ?? `pi-${Date.now()}`
    const savedPI = createSavedPI(form, targetId, 'Draft')

    setSavedPIs((currentPIs) => {
      const existingIndex = currentPIs.findIndex((pi) => pi.id === targetId)

      if (existingIndex === -1) {
        return [savedPI, ...currentPIs]
      }

      return currentPIs.map((pi) => (pi.id === targetId ? savedPI : pi))
    })
    setEditingPIId(targetId)
    void loadBackendPIs()
  }

  const loadSavedPIDetail = async (pi: SavedPI) => {
    const piRecord = pi as unknown as APIRecord
    const compCode = toNumber(piRecord.compCode)
    const response = await fetch(
      `${PI_RMKT_API_URL}/${encodeURIComponent(pi.piNumber)}?compCode=${
        compCode > 0 ? compCode : 1
      }`,
    )

    if (!response.ok) {
      return pi
    }

    return apiPIToSavedPI((await response.json()) as APIRecord, companies)
  }

  const editSavedPI = async (pi: SavedPI) => {
    let targetPI = pi

    try {
      targetPI = await loadSavedPIDetail(pi)
    } catch {
      // Keep the row that is already visible if the detail endpoint is unavailable.
    }

    setPiForm(savedPIToForm(targetPI))
    setEditingPIId(targetPI.id)
    setActiveScreen('create-pi')
  }

  const deleteSavedPI = async (pi: SavedPI) => {
    const piRecord = pi as unknown as APIRecord
    const compCode = toNumber(piRecord.compCode)

    const response = await fetch(
      `${PI_RMKT_API_URL}/${encodeURIComponent(pi.piNumber)}?compCode=${
        compCode > 0 ? compCode : 1
      }`,
      { method: 'DELETE' },
    )

    if (!response.ok) {
      return
    }

    setSavedPIs((currentPIs) => currentPIs.filter((item) => item.id !== pi.id))

    if (editingPIId === pi.id) {
      setEditingPIId(null)
    }
  }

  const handleLogin = (userName: string) => {
    setLoggedInUser(userName)
    window.sessionStorage.setItem(LOGIN_SESSION_KEY, userName)
    window.history.replaceState(null, '', window.location.href)
  }

  const handleLogout = () => {
    window.sessionStorage.removeItem(LOGIN_SESSION_KEY)
    setLoggedInUser('')
    setActiveScreen('create-pi')
    setPiForm(initialPIForm)
    setEditingPIId(null)
    window.history.replaceState(null, '', window.location.href)
  }

  if (!loggedInUser) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <AppShell
      activeScreen={activeScreen}
      onLogout={handleLogout}
      onNavigate={navigate}
      userName={loggedInUser}
    >
      {activeScreen === 'dashboard' && (
        <Dashboard onNavigate={navigate} savedPIs={savedPIs} />
      )}
      {activeScreen === 'create-pi' && (
        <CreatePI
          form={piForm}
          companies={companies}
          generatePINumber={generatePINumber}
          onCancel={() => setActiveScreen('pi-preview')}
          onFormChange={setPiForm}
          onSaveDraft={saveDraftPI}
        />
      )}
      {activeScreen === 'pi-preview' && (
        <PIList
          companies={companies}
          onDelete={deleteSavedPI}
          onEdit={editSavedPI}
          onPreview={loadSavedPIDetail}
          savedPIs={savedPIs}
        />
      )}
      {activeScreen === 'customers' && <CustomerMaster />}
      {activeScreen === 'products' && <ProductMaster />}
      {activeScreen === 'r-market-rates' && <RMarketProductRateMaster />}
      {activeScreen === 'customer-discounts' && <CustomerDiscountMaster />}
    </AppShell>
  )
}

export default App

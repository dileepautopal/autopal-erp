import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from './components/layout/AppShell'
import { AdminPanel } from './pages/AdminPanel'
import { AICommunicationTestConsole } from './pages/AICommunicationTestConsole'
import { CreatePI } from './pages/CreatePI'
import { CustomerDiscountMaster } from './pages/CustomerDiscountMaster'
import { CustomerMaster } from './pages/CustomerMaster'
import { Dashboard } from './pages/Dashboard'
import {
  PublicNotFoundPage,
  isLegalPagePath,
} from './pages/LegalPage'
import type { LegalPagePath } from './pages/LegalPage'
import { LoginPage } from './pages/LoginPage'
import { PIList } from './pages/PIList'
import { ProductMaster } from './pages/ProductMaster'
import { RMarketProductRateMaster } from './pages/RMarketProductRateMaster'
import { WhatsAppPIConnect } from './pages/WhatsAppPIConnect'
import { apiUrl } from './config/api'
import { isAITestConsoleEnabled, navItems } from './data/mockData'
import { initialPIForm } from './data/piDefaults'
import type { Company, PIFormState, SavedPI, ScreenId, UserSession } from './types'

const COMPANY_API_URL = apiUrl('/api/master-companies')
const PI_RMKT_API_URL = apiUrl('/api/master-pi-rmkt')
const LOGIN_SESSION_KEY = 'autopal-login-user'
const STATIC_LEGAL_PAGE_PATHS: Record<LegalPagePath, string> = {
  '/privacy': '/privacy.html',
  '/terms': '/terms.html',
  '/data-deletion': '/data-deletion.html',
}
const AI_TEST_CONSOLE_PATH = '/admin/ai-communication-test-console'
const getDefaultRights = (isAdmin = false) =>
  navItems
    .filter((item) => isAdmin || item.id !== 'admin-panel')
    .map((item) => item.id)

type APIRecord = Record<string, unknown>

const toNumber = (value: unknown) => {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number : 0
}

const toText = (value: unknown) => String(value ?? '')

const getCompanyIdFromCompCode = (compCode: number, companies: Company[]) =>
  companies.find((company) => company.compCode === compCode)?.id ?? ''

const normalizeAPILineItem = (line: APIRecord, index: number) => {
  const quantity = toNumber(line.quantity ?? line.qty)
  const amount = toNumber(line.amount)
  const unitPrice = toNumber(line.unitPrice ?? line.rate)
  const mrp = quantity > 0 && amount > 0
    ? amount / quantity
    : toNumber(line.mrp ?? line.listPrice ?? line.list_price)

  return {
    id: toText(line.id) || `line-${index + 1}`,
    productId: toText(line.productId ?? line.product_id),
    productCode: toText(line.productCode ?? line.product_code),
    description: toText(
      line.description ?? line.productDescription ?? line.product_description,
    ),
    hsnCode: toText(line.hsnCode ?? line.hsn_code),
    unit: toText(line.unit ?? line.productUnit ?? line.product_unit ?? line.uom),
    quantity,
    mrp,
    unitPrice,
    gstPercent: toNumber(line.gstPercent ?? line.gst_percent),
    discountPercent: toNumber(
      line.discountPercent ?? line.discPercent ?? line.disc_percent,
    ),
  }
}

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
    additionalDiscountAmount: toNumber(
      pi.additionalDiscountAmount ?? pi.additional_discount_amount,
    ),
    amountAfterDiscount: toNumber(
      pi.amountAfterDiscount ?? pi.amount_after_discount,
    ),
    basicValue: toNumber(pi.basicValue ?? pi.basic_value),
    buyNFlyAmount: toNumber(pi.buyNFlyAmount ?? pi.buy_n_fly_amount),
    cdAmount: toNumber(pi.cdAmount ?? pi.cd_amount),
    cgstAmount: toNumber(pi.cgstAmount ?? pi.cgst_amount),
    grandTotal: toNumber(pi.grandTotal ?? pi.grand_total),
    id: toText(pi.id) || toText(pi.piNumber) || `pi-${Date.now()}`,
    igstAmount: toNumber(pi.igstAmount ?? pi.igst_amount),
    companyId:
      toText(pi.companyId ?? pi.company_id) ||
      getCompanyIdFromCompCode(compCode, companies),
    customerId: toText(pi.customerId ?? pi.customer_id),
    netBasicValue: toNumber(pi.netBasicValue ?? pi.net_basic_value),
    netTaxableValue: toNumber(pi.netTaxableValue ?? pi.net_taxable_value),
    otherDiscountAmount: toNumber(
      pi.otherDiscountAmount ?? pi.other_discount_amount,
    ),
    prospectiveGstNo: toText(
      pi.prospectiveGstNo ?? pi.prospective_gst_no ?? pi.gstNo ?? pi.gst_no,
    ),
    piNumber: toText(pi.piNumber),
    piDate: toText(pi.piDate),
    deliveryDate: toText(pi.deliveryDate),
    sgstAmount: toNumber(pi.sgstAmount ?? pi.sgst_amount),
    specialDiscountAmount: toNumber(
      pi.specialDiscountAmount ?? pi.special_discount_amount,
    ),
    status: pi.status === 'Final' ? 'Final' : 'Draft',
    todAmount: toNumber(pi.todAmount ?? pi.tod_amount),
    updatedAt: toText(pi.updatedAt ?? pi.updated_at) || new Date().toISOString(),
    lineItems,
  } as SavedPI
}

const hasProductLines = (pi: SavedPI) =>
  pi.lineItems.some((line) => line.productCode || line.description)

const loadPIDetailForListRow = async (
  pi: SavedPI,
  sourceRecord: APIRecord,
  companies: Company[],
) => {
  if (hasProductLines(pi) || !pi.piNumber) {
    return pi
  }

  const compCode = toNumber(
    sourceRecord.compCode ?? sourceRecord.comp_code ?? (pi as APIRecord).compCode,
  )

  try {
    const response = await fetch(
      `${PI_RMKT_API_URL}/${encodeURIComponent(pi.piNumber)}?compCode=${
        compCode > 0 ? compCode : 1
      }`,
    )

    if (!response.ok) {
      return pi
    }

    return apiPIToSavedPI((await response.json()) as APIRecord, companies)
  } catch {
    return pi
  }
}

const savedPIToForm = (pi: SavedPI): PIFormState => ({
  ...initialPIForm,
  ...pi,
  lineItems: pi.lineItems.map((line) => ({
    ...line,
    mrp: line.mrp ?? 0,
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

const normalizeSessionRights = (rights?: ScreenId[], isAdmin = false) => {
  if (isAdmin) {
    return getDefaultRights(true)
  }

  if (!Array.isArray(rights)) {
    return getDefaultRights(false)
  }

  const allowedRights = rights.filter(
    (right) =>
      navItems.some((item) => item.id === right) &&
      right !== 'admin-panel' &&
      right !== 'ai-test-console',
  )

  return allowedRights
}

const getStoredLoginSession = (): UserSession | null => {
  if (typeof window === 'undefined') {
    return null
  }

  const storedSession = window.sessionStorage.getItem(LOGIN_SESSION_KEY)

  if (!storedSession) {
    return null
  }

  try {
    const parsedSession = JSON.parse(storedSession) as Partial<UserSession> | string

    if (typeof parsedSession === 'string') {
      return {
        isAdmin: false,
        rights: getDefaultRights(false),
        userName: parsedSession,
      }
    }

    const isAdmin = Boolean(parsedSession.isAdmin)

    return {
      isAdmin,
      rights: normalizeSessionRights(parsedSession.rights, isAdmin),
      userName: String(parsedSession.userName ?? ''),
    }
  } catch {
    return {
      isAdmin: false,
      rights: getDefaultRights(false),
      userName: storedSession,
    }
  }
}

function AuthenticatedApp({ initialScreen = 'dashboard' }: { initialScreen?: ScreenId }) {
  const [loginSession, setLoginSession] = useState<UserSession | null>(
    getStoredLoginSession,
  )
  const [activeScreen, setActiveScreen] = useState<ScreenId>(initialScreen)
  const [companies, setCompanies] = useState<Company[]>([])
  const [piForm, setPiForm] = useState<PIFormState>(initialPIForm)
  const [savedPIs, setSavedPIs] = useState<SavedPI[]>([])
  const [editingPIId, setEditingPIId] = useState<string | null>(null)
  const visibleNavItems = useMemo(
    () =>
      navItems.filter((item) =>
        loginSession?.rights.includes(item.id) &&
        (item.id !== 'ai-test-console' || Boolean(loginSession?.isAdmin)),
      ),
    [loginSession],
  )
  const allowedScreenIds = useMemo(
    () => new Set(visibleNavItems.map((item) => item.id)),
    [visibleNavItems],
  )
  const firstAllowedScreen = visibleNavItems[0]?.id ?? 'dashboard'
  const loggedInUser = loginSession?.userName ?? ''

  const loadBackendPIs = useCallback(async () => {
    try {
      const response = await fetch(PI_RMKT_API_URL)

      if (!response.ok) {
        setSavedPIs([])
        return
      }

      const records = (await response.json()) as APIRecord[]
      const backendPIs = Array.isArray(records)
        ? await Promise.all(
            records.map(async (record) =>
              loadPIDetailForListRow(
                apiPIToSavedPI(record, companies),
                record,
                companies,
              ),
            ),
          )
        : []

      setSavedPIs(backendPIs)
    } catch {
      setSavedPIs([])
    }
  }, [companies])

  useEffect(() => {
    const syncLoginSession = () => {
      setLoginSession(getStoredLoginSession())
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
    if (!allowedScreenIds.has(screen)) {
      return
    }

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

  const handleLogin = (session: UserSession) => {
    const normalizedSession = {
      ...session,
      rights: normalizeSessionRights(session.rights, session.isAdmin),
    }
    const nextScreen = normalizedSession.rights.includes('dashboard')
      ? initialScreen === 'ai-test-console' && normalizedSession.isAdmin
        ? 'ai-test-console'
        : 'dashboard'
      : normalizedSession.rights[0] ?? 'dashboard'

    setLoginSession(normalizedSession)
    setActiveScreen(nextScreen)
    window.sessionStorage.setItem(
      LOGIN_SESSION_KEY,
      JSON.stringify(normalizedSession),
    )
    window.history.replaceState(null, '', window.location.href)
  }

  const handleLogout = () => {
    window.sessionStorage.removeItem(LOGIN_SESSION_KEY)
    setLoginSession(null)
    setActiveScreen('dashboard')
    setPiForm(initialPIForm)
    setEditingPIId(null)
    window.history.replaceState(null, '', window.location.href)
  }

  if (!loginSession) {
    return <LoginPage onLogin={handleLogin} />
  }

  const currentScreen = allowedScreenIds.has(activeScreen)
    ? activeScreen
    : firstAllowedScreen

  return (
    <AppShell
      activeScreen={currentScreen}
      navItems={visibleNavItems}
      onLogout={handleLogout}
      onNavigate={navigate}
      userName={loggedInUser}
    >
      {currentScreen === 'dashboard' && (
        <Dashboard onNavigate={navigate} savedPIs={savedPIs} />
      )}
      {currentScreen === 'create-pi' && (
        <CreatePI
          form={piForm}
          companies={companies}
          generatePINumber={generatePINumber}
          onCancel={() => setActiveScreen('pi-preview')}
          onFormChange={setPiForm}
          onSaveDraft={saveDraftPI}
        />
      )}
      {currentScreen === 'pi-preview' && (
        <PIList
          companies={companies}
          onDelete={deleteSavedPI}
          onEdit={editSavedPI}
          onPreview={loadSavedPIDetail}
          savedPIs={savedPIs}
        />
      )}
      {currentScreen === 'whatsapp-pi' && (
        <WhatsAppPIConnect onImported={loadBackendPIs} onNavigate={navigate} />
      )}
      {currentScreen === 'customers' && <CustomerMaster />}
      {currentScreen === 'products' && <ProductMaster />}
      {currentScreen === 'r-market-rates' && <RMarketProductRateMaster />}
      {currentScreen === 'customer-discounts' && <CustomerDiscountMaster />}
      {currentScreen === 'admin-panel' && (
        <AdminPanel currentUserName={loginSession.userName} />
      )}
      {currentScreen === 'ai-test-console' && (
        <AICommunicationTestConsole currentUserName={loginSession.userName} />
      )}
    </AppShell>
  )
}

function StaticLegalRedirect({ targetPath }: { targetPath: string }) {
  useEffect(() => {
    window.location.replace(targetPath)
  }, [targetPath])

  return null
}

function App() {
  const currentPath =
    typeof window === 'undefined' ? '' : window.location.pathname

  if (currentPath === '/') {
    return <AuthenticatedApp />
  }

  if (currentPath === AI_TEST_CONSOLE_PATH && isAITestConsoleEnabled) {
    return <AuthenticatedApp initialScreen="ai-test-console" />
  }

  if (isLegalPagePath(currentPath)) {
    return <StaticLegalRedirect targetPath={STATIC_LEGAL_PAGE_PATHS[currentPath]} />
  }

  return <PublicNotFoundPage />
}

export default App

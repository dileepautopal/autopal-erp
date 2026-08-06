import { useEffect, useMemo, useRef, useState } from 'react'
import { SystemHealthDashboard } from '../components/ai-console/SystemHealthDashboard'
import { Button } from '../components/ui/Button'
import { InputField, SelectField, TextareaField } from '../components/ui/Field'
import { apiUrl } from '../config/api'

type AICommunicationTestConsoleProps = {
  currentUserName: string
}

type TestModuleId =
  | 'system-check'
  | 'text-parser'
  | 'customer-match'
  | 'product-match'
  | 'company-selection'
  | 'commercial-pi-calculation'
  | 'draft-pi-summary'
  | 'customer-confirmation'
  | 'whatsapp-acknowledgement'
  | 'phase1-verification'
  | 'media-download'
  | 'ocr'
  | 'pdf-extract'
  | 'excel-extract'
  | 'word-extract'
  | 'draft-pi'
  | 'pi-pdf'
  | 'whatsapp-reply'
  | 'reprocess'
  | 'end-to-end'

type APIResult = Record<string, unknown>
type APIRecord = Record<string, unknown>

type SystemCheckRow = {
  message: string
  name: string
  status: string
}

type ResultSummaryItem = {
  label: string
  value: unknown
}

const API_BASE_URL = apiUrl('/api/admin/ai-test-console')

const sampleText = `Party: Jalaram Enterprises
Place: Navagam
Date: 22/07/2026

SB 102 H4 P43t P LHT E - 1000 Nos`

const samples = {
  incorrect: 'Hello, please send details.',
  multiple: `M/s Milan Automobiles
Belgaum
100/90 - 12V - PU37 - 500 NOS
130/100 - 12V PU37 - 200 NOS`,
  price: `Price enquiry
Party: Jalaram Enterprises
Place: Navagam
SB102 H4 P43t P LHT E`,
  single: sampleText,
  stock: `Stock available?
Party: Jalaram Enterprises
SB102 LH 1000`,
  unstructured: 'Jalaram Navagam need SB102 left 1,000 nos urgent delivery',
}

const modules: Array<{
  id: TestModuleId
  label: string
  milestone: string
  ready: boolean
}> = [
  { id: 'system-check', label: 'System Configuration Check', milestone: 'Milestone 1', ready: true },
  { id: 'text-parser', label: 'Text Parser', milestone: 'Milestone 1', ready: true },
  { id: 'customer-match', label: 'Customer Matcher', milestone: 'Milestone 1', ready: true },
  { id: 'product-match', label: 'Product Matcher', milestone: 'Milestone 1', ready: true },
  { id: 'company-selection', label: 'Company Selection Test', milestone: 'Milestone 1', ready: true },
  { id: 'commercial-pi-calculation', label: 'Commercial PI Calculation', milestone: 'Milestone 1', ready: true },
  { id: 'draft-pi-summary', label: 'Draft PI Summary Test', milestone: 'Milestone 1', ready: true },
  { id: 'customer-confirmation', label: 'Customer Confirmation Test', milestone: 'Milestone 1', ready: true },
  { id: 'whatsapp-acknowledgement', label: 'WhatsApp Acknowledgement Test', milestone: 'Milestone 1', ready: true },
  { id: 'phase1-verification', label: 'Phase 1 Verification & Closure', milestone: 'Milestone 1', ready: true },
  { id: 'media-download', label: 'Image Download', milestone: 'Milestone 2', ready: false },
  { id: 'ocr', label: 'OCR', milestone: 'Milestone 3', ready: false },
  { id: 'pdf-extract', label: 'PDF Reader', milestone: 'Milestone 3', ready: false },
  { id: 'excel-extract', label: 'Excel Reader', milestone: 'Milestone 3', ready: false },
  { id: 'word-extract', label: 'Word Reader', milestone: 'Milestone 3', ready: false },
  { id: 'draft-pi', label: 'Draft PI Generator', milestone: 'Milestone 4', ready: false },
  { id: 'pi-pdf', label: 'PI PDF Generator', milestone: 'Milestone 4', ready: false },
  { id: 'whatsapp-reply', label: 'WhatsApp Reply', milestone: 'Milestone 5', ready: false },
  { id: 'reprocess', label: 'Reprocess Existing Message', milestone: 'Milestone 2', ready: false },
  { id: 'end-to-end', label: 'End-to-End Test', milestone: 'Milestone 6', ready: false },
]

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as { message?: string; errors?: string[] }

    if (body.errors?.length) {
      return body.errors.join(' ')
    }

    return body.message || `Request failed with status ${response.status}`
  } catch {
    return `Request failed with status ${response.status}`
  }
}

const formatJSON = (value: unknown) => JSON.stringify(value, null, 2)

const isRecord = (value: unknown): value is APIRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const formatConfigLabel = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (character) => character.toUpperCase())

const getStatusText = (value: unknown) =>
  isRecord(value) ? String(value.status ?? '-') : String(value ?? '-')

const getConfigMessage = (value: unknown) => {
  if (!isRecord(value)) {
    return ''
  }

  const missingColumns = Array.isArray(value.missingColumns)
    ? value.missingColumns.filter(Boolean).join(', ')
    : ''

  if (missingColumns) {
    return `Missing columns: ${missingColumns}`
  }

  const details = [
    value.databaseName ? `Database: ${String(value.databaseName)}` : '',
    value.errorCode ? `Error code: ${String(value.errorCode)}` : '',
    value.errorSubcode ? `Subcode: ${String(value.errorSubcode)}` : '',
  ].filter(Boolean)

  return details.join(' | ')
}

const buildSystemCheckRows = (testResult: APIResult | null): SystemCheckRow[] => {
  if (!isRecord(testResult?.configuration)) {
    return []
  }

  return Object.entries(testResult.configuration).flatMap(([key, value]) => {
    if (key === 'requiredTables' && isRecord(value)) {
      return Object.entries(value).map(([tableKey, tableValue]) => ({
        message: getConfigMessage(tableValue),
        name: `Table: ${formatConfigLabel(tableKey)}`,
        status: getStatusText(tableValue),
      }))
    }

    return {
      message: getConfigMessage(value),
      name: formatConfigLabel(key),
      status: getStatusText(value),
    }
  })
}

const toDisplayValue = (value: unknown) => {
  if (value === null || typeof value === 'undefined' || value === '') {
    return '-'
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (Array.isArray(value) || isRecord(value)) {
    return formatJSON(value)
  }

  return String(value)
}

const getFirstValue = (record: APIRecord, keys: string[]) => {
  for (const key of keys) {
    const value = record[key]

    if (value !== null && typeof value !== 'undefined' && value !== '') {
      return value
    }
  }

  return ''
}

const getArray = (value: unknown) => Array.isArray(value) ? value : []

const getMessageArray = (value: unknown) =>
  getArray(value)
    .map((item) => isRecord(item) ? formatJSON(item) : String(item ?? '').trim())
    .filter(Boolean)

const formatConfidence = (value: unknown) => {
  if (value === null || typeof value === 'undefined' || value === '') {
    return '-'
  }

  return `${String(value)}%`
}

const formatDuration = (value: unknown) => {
  if (value === null || typeof value === 'undefined' || value === '') {
    return '-'
  }

  return `${String(value)} ms`
}

const getResultModuleId = (
  testResult: APIResult | null,
  fallbackModule: TestModuleId,
): TestModuleId => {
  const testName = String(testResult?.testName ?? '')

  if (testName === 'text-parser') {
    return 'text-parser'
  }

  if (testName === 'customer-match') {
    return 'customer-match'
  }

  if (testName === 'product-match') {
    return 'product-match'
  }

  if (testName === 'company-selection') {
    return 'company-selection'
  }

  if (testName === 'commercial-pi-calculation') {
    return 'commercial-pi-calculation'
  }

  if (testName === 'draft-pi-summary') {
    return 'draft-pi-summary'
  }

  if (testName === 'customer-confirmation') {
    return 'customer-confirmation'
  }

  if (testName === 'whatsapp-acknowledgement') {
    return 'whatsapp-acknowledgement'
  }

  if (testName === 'phase1-verification') {
    return 'phase1-verification'
  }

  if (testName === 'system-check') {
    return 'system-check'
  }

  return fallbackModule
}

export function AICommunicationTestConsole({
  currentUserName,
}: AICommunicationTestConsoleProps) {
  const [activeModule, setActiveModule] = useState<TestModuleId>('system-check')
  const [textInput, setTextInput] = useState(sampleText)
  const [customerInput, setCustomerInput] = useState({
    city: 'Navagam',
    customerName: 'Jalaram Enterprises',
    email: '',
    gstin: '',
    phone: '',
  })
  const [productInput, setProductInput] = useState('SB102\nSB 102 H4 P43t P LHT E')
  const [companySelectionInput, setCompanySelectionInput] = useState('SB 102 H4 P43t')
  const [summaryInput, setSummaryInput] = useState({
    confirmSend: false,
    mode: 'simulation',
    piNumber: '',
    senderPhone: '917733850017',
  })
  const [confirmationInput, setConfirmationInput] = useState({
    piNumber: '',
    replyText: 'CONFIRM ',
    senderPhone: '917733850017',
  })
  const [existingConfirmationInput, setExistingConfirmationInput] = useState({
    rowId: '100',
  })
  const [ackInput, setAckInput] = useState({
    action: 'preview',
    confirmSend: false,
    messageId: '',
    mode: 'simulation',
    piNumber: 'HAL-0001',
    processingStatus: 'PI_CREATED',
    recordId: '',
    senderPhone: '917733850017',
  })
  const [phase1Input, setPhase1Input] = useState({
    confirmLive: false,
    mode: 'simulation',
    selectedTest: 'safe-suite',
    testerPhone: '917733850017',
  })
  const [result, setResult] = useState<APIResult | null>(null)
  const [lastRun, setLastRun] = useState<(() => Promise<void>) | null>(null)
  const [statusMessage, setStatusMessage] = useState('Ready')
  const [isRunning, setIsRunning] = useState(false)
  const resultPanelRef = useRef<HTMLElement | null>(null)
  const systemCheckRows = useMemo(
    () => getResultModuleId(result, activeModule) === 'system-check'
      ? buildSystemCheckRows(result)
      : [],
    [activeModule, result],
  )
  const resultModule = getResultModuleId(result, activeModule)

  const activeModuleMeta = useMemo(
    () => modules.find((module) => module.id === activeModule) ?? modules[0],
    [activeModule],
  )

  useEffect(() => {
    if (result) {
      window.setTimeout(() => {
        resultPanelRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
      }, 0)
    }
  }, [result])

  const requestHeaders = {
    'Content-Type': 'application/json',
    'x-autopal-user': currentUserName,
  }

  const runRequest = async (
    label: string,
    endpoint: string,
    body?: Record<string, unknown>,
    method = 'POST',
  ) => {
    setIsRunning(true)
    setStatusMessage(`Running ${label}`)

    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        headers: requestHeaders,
        method,
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const payload = (await response.json()) as APIResult
      setResult(payload)
      setStatusMessage(`${label} completed`)
    } catch (error) {
      setResult({
        errors: [error instanceof Error ? error.message : `${label} failed`],
        finalStatus: 'FAILED',
        success: false,
        testName: label,
      })
      setStatusMessage(error instanceof Error ? error.message : `${label} failed`)
    } finally {
      setIsRunning(false)
    }
  }

  const runSystemCheck = async () => {
    await runRequest('System Configuration Check', '/system-check', undefined, 'GET')
  }

  const runTextParser = async () => {
    await runRequest('Text Parser', '/text-parser', { text: textInput })
  }

  const runCustomerMatch = async () => {
    await runRequest('Customer Matcher', '/customer-match', customerInput)
  }

  const runProductMatch = async () => {
    await runRequest('Product Matcher', '/product-match', { productText: productInput })
  }

  const runCompanySelection = async () => {
    await runRequest('Company Selection Test', '/company-selection', {
      productText: companySelectionInput,
    })
  }

  const runCommercialPICalculation = async () => {
    await runRequest('Commercial PI Calculation', '/commercial-pi-calculation', { text: textInput })
  }

  const runDraftPISummary = async () => {
    await runRequest('Draft PI Summary Test', '/draft-pi-summary', summaryInput)
  }

  const runCustomerConfirmation = async () => {
    await runRequest('Customer Confirmation Test', '/customer-confirmation', confirmationInput)
  }

  const runExistingConfirmationRow = async () => {
    await runRequest(
      'Process Existing Confirmation Row',
      '/customer-confirmation/process-existing-row',
      existingConfirmationInput,
    )
  }

  const runWhatsappAcknowledgement = async () => {
    await runRequest('WhatsApp Acknowledgement Test', '/whatsapp-acknowledgement', ackInput)
  }

  const runPhase1Verification = async (
    action = phase1Input.selectedTest || 'safe-suite',
  ) => {
    const isLiveSuite = action === 'live-suite'

    await runRequest('Phase 1 Verification & Closure', '/phase1-verification', {
      ...phase1Input,
      action,
      actualSend: isLiveSuite,
      mode: isLiveSuite ? 'live' : 'simulation',
      selectedTest:
        action === 'safe-suite' || action === 'live-suite' || action === 'reset-preview'
          ? action
          : phase1Input.selectedTest,
    })
  }

  const runActiveModule = async () => {
    if (!activeModuleMeta.ready) {
      setResult({
        finalStatus: 'PENDING_MILESTONE',
        success: false,
        testName: activeModuleMeta.label,
        warnings: [`${activeModuleMeta.label} is planned for ${activeModuleMeta.milestone}.`],
      })
      return
    }

    const runnerByModule: Record<string, () => Promise<void>> = {
      'company-selection': runCompanySelection,
      'customer-match': runCustomerMatch,
      'customer-confirmation': runCustomerConfirmation,
      'commercial-pi-calculation': runCommercialPICalculation,
      'draft-pi-summary': runDraftPISummary,
      'product-match': runProductMatch,
      'phase1-verification': () => runPhase1Verification(),
      'system-check': runSystemCheck,
      'text-parser': runTextParser,
      'whatsapp-acknowledgement': runWhatsappAcknowledgement,
    }
    const runner = runnerByModule[activeModule]

    setLastRun(() => runner)
    await runner()
  }

  const copyResult = async () => {
    if (!result) {
      return
    }

    await navigator.clipboard.writeText(formatJSON(result))
    setStatusMessage('Result copied')
  }

  const downloadResult = () => {
    if (!result) {
      return
    }

    const blob = new Blob([formatJSON(result)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ai-test-console-${activeModule}-${Date.now()}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const selectModuleFromHealth = (moduleId: string) => {
    const targetModule = modules.find((module) => module.id === moduleId)

    if (targetModule) {
      setActiveModule(targetModule.id)
    }
  }

  const renderInputPanel = () => {
    if (activeModule === 'system-check') {
      return (
        <div className="ai-console-help">
          <p>
            Checks safe backend configuration, database connectivity, required
            tables/columns, OCR availability, and WhatsApp token status without
            exposing secret values.
          </p>
        </div>
      )
    }

    if (activeModule === 'phase1-verification') {
      const phase1Cards = [
        { id: 'duplicate-safety', label: 'Duplicate Safety' },
        { id: 'failure-handling', label: 'Failure Handling' },
        { id: 'customer-reply-capture', label: 'Customer Reply Capture' },
        { id: 'database-audit', label: 'Database Audit' },
        { id: 'backup-closure', label: 'Backup & Closure' },
      ]

      return (
        <div className="ai-console-form-stack">
          <div className="ai-console-samples">
            {phase1Cards.map((card) => (
              <Button
                key={card.id}
                onClick={() =>
                  setPhase1Input((current) => ({
                    ...current,
                    selectedTest: card.id,
                  }))
                }
                variant={phase1Input.selectedTest === card.id ? 'primary' : 'secondary'}
              >
                {card.label}
              </Button>
            ))}
          </div>
          <div className="ai-console-grid">
            <SelectField
              label="Verification test"
              onChange={(event) =>
                setPhase1Input((current) => ({
                  ...current,
                  selectedTest: event.target.value,
                }))
              }
              options={[
                { label: 'Safe Simulation Suite', value: 'safe-suite' },
                { label: 'Duplicate Safety', value: 'duplicate-safety' },
                { label: 'Failure Handling', value: 'failure-handling' },
                { label: 'Customer Reply Capture', value: 'customer-reply-capture' },
                { label: 'Database Audit', value: 'database-audit' },
                { label: 'Backup & Closure', value: 'backup-closure' },
              ]}
              value={phase1Input.selectedTest}
            />
            <SelectField
              label="Mode"
              onChange={(event) =>
                setPhase1Input((current) => ({
                  ...current,
                  mode: event.target.value,
                }))
              }
              options={[
                { label: 'Simulation', value: 'simulation' },
                { label: 'Actual Send', value: 'live' },
              ]}
              value={phase1Input.mode}
            />
            <InputField
              label="Registered tester number"
              onChange={(event) =>
                setPhase1Input((current) => ({
                  ...current,
                  testerPhone: event.target.value,
                }))
              }
              value={phase1Input.testerPhone}
            />
          </div>
          <label className="checkbox-row">
            <input
              checked={phase1Input.confirmLive}
              onChange={(event) =>
                setPhase1Input((current) => ({
                  ...current,
                  confirmLive: event.target.checked,
                }))
              }
              type="checkbox"
            />
            <span>Confirm live tester suite preflight. No live send runs without this confirmation.</span>
          </label>
          <div className="header-actions">
            <Button disabled={isRunning} onClick={() => void runPhase1Verification(phase1Input.selectedTest)}>
              Run Selected Test
            </Button>
            <Button disabled={isRunning} onClick={() => void runPhase1Verification('safe-suite')} variant="secondary">
              Run Safe Simulation Suite
            </Button>
            <Button disabled={isRunning || !phase1Input.confirmLive} onClick={() => void runPhase1Verification('live-suite')} variant="secondary">
              Run Live Tester Suite
            </Button>
            <Button disabled={!result} onClick={downloadResult} variant="secondary">
              Download Verification Report
            </Button>
            <Button disabled={isRunning} onClick={() => void runPhase1Verification('reset-preview')} variant="ghost">
              Reset Test Data
            </Button>
          </div>
          <div className="ai-console-help">
            <p>
              Default mode is simulation. Reset Test Data shows a cleanup preview only;
              it does not delete real customers, products, PIs, or WhatsApp records.
            </p>
          </div>
        </div>
      )
    }

    if (activeModule === 'text-parser' || activeModule === 'commercial-pi-calculation') {
      return (
        <div className="ai-console-form-stack">
          <div className="ai-console-samples">
            <Button onClick={() => setTextInput(samples.single)} variant="secondary">Single Product</Button>
            <Button onClick={() => setTextInput(samples.multiple)} variant="secondary">Multiple Product</Button>
            <Button onClick={() => setTextInput(samples.price)} variant="secondary">Price Enquiry</Button>
            <Button onClick={() => setTextInput(samples.stock)} variant="secondary">Stock Enquiry</Button>
            <Button onClick={() => setTextInput(samples.unstructured)} variant="secondary">Unstructured</Button>
            <Button onClick={() => setTextInput(samples.incorrect)} variant="secondary">Incorrect</Button>
          </div>
          <TextareaField
            className="ai-console-textarea"
            label={
              activeModule === 'commercial-pi-calculation'
                ? 'WhatsApp order text for dry-run PI calculation'
                : 'WhatsApp order or enquiry text'
            }
            onChange={(event) => setTextInput(event.target.value)}
            value={textInput}
          />
        </div>
      )
    }

    if (activeModule === 'customer-match') {
      return (
        <div className="ai-console-grid">
          <InputField
            label="Customer name"
            onChange={(event) =>
              setCustomerInput((current) => ({ ...current, customerName: event.target.value }))
            }
            value={customerInput.customerName}
          />
          <InputField
            label="Phone"
            onChange={(event) =>
              setCustomerInput((current) => ({ ...current, phone: event.target.value }))
            }
            value={customerInput.phone}
          />
          <InputField
            label="GSTIN"
            onChange={(event) =>
              setCustomerInput((current) => ({ ...current, gstin: event.target.value }))
            }
            value={customerInput.gstin}
          />
          <InputField
            label="Email"
            onChange={(event) =>
              setCustomerInput((current) => ({ ...current, email: event.target.value }))
            }
            value={customerInput.email}
          />
          <InputField
            label="City"
            onChange={(event) =>
              setCustomerInput((current) => ({ ...current, city: event.target.value }))
            }
            value={customerInput.city}
          />
        </div>
      )
    }

    if (activeModule === 'product-match') {
      return (
        <TextareaField
          className="ai-console-textarea"
          label="Product descriptions or codes, one per line"
          onChange={(event) => setProductInput(event.target.value)}
          value={productInput}
        />
      )
    }

    if (activeModule === 'company-selection') {
      return (
        <TextareaField
          className="ai-console-textarea"
          label="Product code or description, one per line"
          onChange={(event) => setCompanySelectionInput(event.target.value)}
          value={companySelectionInput}
        />
      )
    }

    if (activeModule === 'draft-pi-summary') {
      return (
        <div className="ai-console-form-stack">
          <div className="ai-console-grid">
            <InputField
              label="PI number"
              onChange={(event) =>
                setSummaryInput((current) => ({ ...current, piNumber: event.target.value }))
              }
              value={summaryInput.piNumber}
            />
            <InputField
              label="Sender phone"
              onChange={(event) =>
                setSummaryInput((current) => ({ ...current, senderPhone: event.target.value }))
              }
              value={summaryInput.senderPhone}
            />
            <SelectField
              label="Mode"
              onChange={(event) =>
                setSummaryInput((current) => ({ ...current, mode: event.target.value }))
              }
              options={[
                { label: 'Simulation', value: 'simulation' },
                { label: 'Actual Send', value: 'send' },
              ]}
              value={summaryInput.mode}
            />
          </div>
          <label className="checkbox-row">
            <input
              checked={summaryInput.confirmSend}
              onChange={(event) =>
                setSummaryInput((current) => ({ ...current, confirmSend: event.target.checked }))
              }
              type="checkbox"
            />
            <span>Confirm actual Draft PI summary send to registered tester number</span>
          </label>
        </div>
      )
    }

    if (activeModule === 'customer-confirmation') {
      return (
        <div className="ai-console-form-stack">
          <div className="ai-console-grid">
            <InputField
              label="PI number"
              onChange={(event) =>
                setConfirmationInput((current) => ({ ...current, piNumber: event.target.value }))
              }
              value={confirmationInput.piNumber}
            />
            <InputField
              label="Sender phone"
              onChange={(event) =>
                setConfirmationInput((current) => ({ ...current, senderPhone: event.target.value }))
              }
              value={confirmationInput.senderPhone}
            />
          </div>
          <TextareaField
            className="ai-console-textarea"
            label="Incoming reply text"
            onChange={(event) =>
              setConfirmationInput((current) => ({ ...current, replyText: event.target.value }))
            }
            value={confirmationInput.replyText}
          />
          <div className="ai-console-grid">
            <InputField
              label="Existing incoming row ID"
              onChange={(event) =>
                setExistingConfirmationInput({ rowId: event.target.value })
              }
              value={existingConfirmationInput.rowId}
            />
            <div className="ai-console-field-action">
              <Button disabled={isRunning} onClick={() => void runExistingConfirmationRow()} variant="secondary">
                Process Existing Confirmation Row
              </Button>
            </div>
          </div>
        </div>
      )
    }

    if (activeModule === 'whatsapp-acknowledgement') {
      return (
        <div className="ai-console-form-stack">
          <div className="ai-console-grid">
            <SelectField
              label="Mode"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, mode: event.target.value }))
              }
              options={[
                { label: 'Simulation', value: 'simulation' },
                { label: 'Actual Send', value: 'send' },
                { label: 'Existing Message', value: 'existing' },
              ]}
              value={ackInput.mode}
            />
            <SelectField
              label="Action"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, action: event.target.value }))
              }
              options={[
                { label: 'Preview Only', value: 'preview' },
                { label: 'Send', value: 'send' },
                { label: 'Retry Failed', value: 'retry' },
              ]}
              value={ackInput.action}
            />
            <SelectField
              label="Processing Status"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, processingStatus: event.target.value }))
              }
              options={[
                { label: 'PI Created', value: 'PI_CREATED' },
                { label: 'Manual Review', value: 'MANUAL_REVIEW' },
                { label: 'Parse Failed', value: 'PARSE_FAILED' },
                { label: 'Commercial Pending', value: 'COMMERCIAL_DATA_PENDING' },
                { label: 'Product Not Found', value: 'PRODUCT_NOT_FOUND' },
              ]}
              value={ackInput.processingStatus}
            />
            <InputField
              label="Sender phone"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, senderPhone: event.target.value }))
              }
              value={ackInput.senderPhone}
            />
            <InputField
              label="Draft PI number"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, piNumber: event.target.value }))
              }
              value={ackInput.piNumber}
            />
            <InputField
              label="DB record ID"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, recordId: event.target.value }))
              }
              value={ackInput.recordId}
            />
            <InputField
              label="WhatsApp message ID"
              onChange={(event) =>
                setAckInput((current) => ({ ...current, messageId: event.target.value }))
              }
              value={ackInput.messageId}
            />
          </div>
          <label className="checkbox-row">
            <input
              checked={ackInput.confirmSend}
              onChange={(event) =>
                setAckInput((current) => ({ ...current, confirmSend: event.target.checked }))
              }
              type="checkbox"
            />
            <span>Confirm actual WhatsApp send to registered tester number</span>
          </label>
        </div>
      )
    }

    return (
      <div className="ai-console-help">
        <p>{activeModuleMeta.label} will be implemented in {activeModuleMeta.milestone}.</p>
      </div>
    )
  }

  const renderSummaryGrid = (items: ResultSummaryItem[]) => (
    <div className="ai-console-result-grid">
      {items.map((item) => (
        <div className="ai-console-result-cell" key={item.label}>
          <span>{item.label}</span>
          <strong>{toDisplayValue(item.value)}</strong>
        </div>
      ))}
    </div>
  )

  const renderMessageSection = (
    title: string,
    messages: string[],
    emptyMessage: string,
  ) => (
    <section className="ai-console-result-section">
      <h3>{title}</h3>
      {messages.length > 0 ? (
        <ul className="ai-console-message-list">
          {messages.map((message, index) => (
            <li key={`${title}-${index}`}>{message}</li>
          ))}
        </ul>
      ) : (
        <p className="ai-console-muted">{emptyMessage}</p>
      )}
    </section>
  )

  const renderJSONDetails = (title: string, value: unknown, open = false) => (
    <details className="ai-console-json-details" open={open}>
      <summary>{title}</summary>
      <pre className="ai-console-json-viewer">
        {formatJSON(value ?? {})}
      </pre>
    </details>
  )

  const renderInputInformation = (testResult: APIResult) => {
    const input = isRecord(testResult.input) ? testResult.input : {}
    const rows = [
      {
        label: 'Raw Text',
        value: getFirstValue(input, ['rawText', 'text']) || testResult.rawText,
      },
      {
        label: 'Normalized Input',
        value: testResult.normalizedInput,
      },
      {
        label: 'Extracted Text',
        value: testResult.extractedText,
      },
    ]

    return (
      <section className="ai-console-result-section">
        <h3>Input Information</h3>
        <div className="ai-console-text-blocks">
          {rows.map((row) => (
            <div className="ai-console-text-block" key={row.label}>
              <span>{row.label}</span>
              <pre>{toDisplayValue(row.value)}</pre>
            </div>
          ))}
        </div>
      </section>
    )
  }

  const renderTextParserResult = (testResult: APIResult) => {
    const parsedCustomer = isRecord(testResult.parsedCustomer)
      ? testResult.parsedCustomer
      : {}
    const parsedItems = getArray(testResult.parsedItems)
      .filter(isRecord)
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Classification', value: testResult.classification },
            { label: 'Confidence', value: formatConfidence(testResult.confidence) },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
            { label: 'Started At', value: testResult.startedAt },
            { label: 'Completed At', value: testResult.completedAt },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Parsed Customer</h3>
          {renderSummaryGrid([
            {
              label: 'Customer Name',
              value: getFirstValue(parsedCustomer, ['customerName', 'name', 'partyName']),
            },
            {
              label: 'Place',
              value: getFirstValue(parsedCustomer, ['place', 'city', 'location']),
            },
            {
              label: 'Date',
              value: getFirstValue(parsedCustomer, ['date', 'orderDate', 'piDate']),
            },
            {
              label: 'Phone',
              value: getFirstValue(parsedCustomer, ['phone', 'mobile', 'mobileNo']),
            },
            {
              label: 'Email',
              value: getFirstValue(parsedCustomer, ['email']),
            },
            {
              label: 'GST Number',
              value: getFirstValue(parsedCustomer, ['gstNo', 'gstNumber', 'gstin']),
            },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Parsed Items</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Line No.</th>
                  <th>Model</th>
                  <th>Product Code</th>
                  <th>Product Description</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Original Line</th>
                </tr>
              </thead>
              <tbody>
                {parsedItems.length > 0 ? (
                  parsedItems.map((item, index) => (
                    <tr key={`${String(getFirstValue(item, ['rawLine', 'originalLine', 'line']))}-${index}`}>
                      <td>{toDisplayValue(getFirstValue(item, ['lineNo', 'lineNumber']) || index + 1)}</td>
                      <td>{toDisplayValue(getFirstValue(item, ['model']))}</td>
                      <td>{toDisplayValue(getFirstValue(item, ['productCode', 'code']))}</td>
                      <td>
                        {toDisplayValue(
                          getFirstValue(item, [
                            'productDescription',
                            'productDesc',
                            'description',
                            'productText',
                            'normalizedProductText',
                            'product',
                          ]),
                        )}
                      </td>
                      <td>{toDisplayValue(getFirstValue(item, ['quantity', 'qty']))}</td>
                      <td>{toDisplayValue(getFirstValue(item, ['unit', 'uom']))}</td>
                      <td>{toDisplayValue(getFirstValue(item, ['originalLine', 'rawLine', 'line']))}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>No parsed items</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Parsed JSON', testResult.parsedJson, true)}
        {renderInputInformation(testResult)}
      </div>
    )
  }

  const renderCustomerMatcherResult = (testResult: APIResult) => {
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)
    const bestMatch = isRecord(testResult.bestMatch) ? testResult.bestMatch : null
    const candidates = getArray(testResult.customerCandidates).filter(isRecord)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Candidate Count', value: testResult.candidateCount },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Best Match</h3>
          {renderSummaryGrid([
            { label: 'Customer Name', value: bestMatch?.customerName },
            { label: 'Customer Code', value: bestMatch?.customerCode },
            { label: 'GSTIN', value: bestMatch?.gstin },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Customer Candidates</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Customer Name</th>
                  <th>Code</th>
                  <th>City</th>
                  <th>GSTIN</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length > 0 ? (
                  candidates.map((candidate, index) => (
                    <tr key={`${String(candidate.customerCode ?? candidate.customerId ?? index)}`}>
                      <td>{toDisplayValue(candidate.customerName)}</td>
                      <td>{toDisplayValue(candidate.customerCode ?? candidate.customerId)}</td>
                      <td>{toDisplayValue(candidate.city)}</td>
                      <td>{toDisplayValue(candidate.gstin)}</td>
                      <td>{formatConfidence(candidate.confidenceScore ?? candidate.confidence)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>No customer candidates</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderProductMatcherResult = (testResult: APIResult) => {
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)
    const matches = getArray(testResult.productMatches).filter(isRecord)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Product Matches</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Input</th>
                  <th>Status</th>
                  <th>Product Code</th>
                  <th>Product Description</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {matches.length > 0 ? (
                  matches.map((match, index) => {
                    const selectedProduct = isRecord(match.selectedProduct)
                      ? match.selectedProduct
                      : {}

                    return (
                      <tr key={`${String(match.input ?? index)}`}>
                        <td>{toDisplayValue(match.input)}</td>
                        <td>{toDisplayValue(match.status)}</td>
                        <td>{toDisplayValue(selectedProduct.productCode)}</td>
                        <td>{toDisplayValue(selectedProduct.productDescription)}</td>
                        <td>{formatConfidence(match.confidenceScore)}</td>
                      </tr>
                    )
                  })
                ) : (
                  <tr>
                    <td colSpan={5}>No product matches</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderCompanySelectionResult = (testResult: APIResult) => {
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)
    const matches = getArray(testResult.productMatches).filter(isRecord)
    const selectedCompany = isRecord(testResult.selectedCompany)
      ? testResult.selectedCompany
      : {}
    const splitOptions = getArray(testResult.splitOptions)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Selected Company</h3>
          {renderSummaryGrid([
            { label: 'Product Category', value: testResult.productCategory },
            { label: 'Company', value: selectedCompany.companyName },
            { label: 'Company Code', value: selectedCompany.companyCode ?? testResult.companyCode },
            { label: 'Company ID', value: selectedCompany.companyId },
            { label: 'PI Series', value: selectedCompany.piSeries ?? testResult.piSeries },
            { label: 'Generated PI Number Preview', value: testResult.generatedPiNumberPreview },
            { label: 'Reason', value: testResult.reason },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Product Categories</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Input</th>
                  <th>Status</th>
                  <th>Product Code</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {matches.length > 0 ? (
                  matches.map((match, index) => (
                    <tr key={`${String(match.input ?? index)}`}>
                      <td>{toDisplayValue(match.input)}</td>
                      <td>{toDisplayValue(match.status)}</td>
                      <td>{toDisplayValue(match.productCode)}</td>
                      <td>{toDisplayValue(match.productDescription)}</td>
                      <td>{toDisplayValue(match.category)}</td>
                      <td>{formatConfidence(match.confidenceScore)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>No product categories</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {splitOptions.length > 0 && (
          <section className="ai-console-result-section">
            <h3>Split Options</h3>
            <ul className="ai-console-message-list">
              {splitOptions.map((option, index) => (
                <li key={`${String(option)}-${index}`}>{toDisplayValue(option)}</li>
              ))}
            </ul>
          </section>
        )}

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderCommercialPIResult = (testResult: APIResult) => {
    const parsedCustomer = isRecord(testResult.parsedCustomer)
      ? testResult.parsedCustomer
      : {}
    const selectedCustomer = isRecord(testResult.selectedCustomer)
      ? testResult.selectedCustomer
      : {}
    const totals = isRecord(testResult.totals) ? testResult.totals : {}
    const taxCalculation = isRecord(testResult.taxCalculation)
      ? testResult.taxCalculation
      : {}
    const lineItems = getArray(testResult.lineItems).filter(isRecord)
    const rateLookups = getArray(testResult.rateLookups).filter(isRecord)
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Dry Run', value: testResult.dryRun },
            { label: 'Database Changed', value: testResult.databaseChanged },
            { label: 'PI Number', value: testResult.piNumber },
            { label: 'Classification', value: testResult.classification },
            { label: 'Confidence', value: formatConfidence(testResult.confidence) },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Customer</h3>
          {renderSummaryGrid([
            {
              label: 'Parsed Customer',
              value: getFirstValue(parsedCustomer, ['customerName', 'name', 'partyName']),
            },
            {
              label: 'Matched Customer',
              value: getFirstValue(selectedCustomer, ['customerName', 'customer_name']),
            },
            {
              label: 'Customer Code',
              value: getFirstValue(selectedCustomer, ['customerCode', 'customer_code']),
            },
            {
              label: 'Place',
              value: getFirstValue(parsedCustomer, ['place', 'city', 'location']),
            },
            {
              label: 'Date',
              value: getFirstValue(parsedCustomer, ['date', 'orderDate', 'piDate']),
            },
            {
              label: 'GST Number',
              value: getFirstValue(parsedCustomer, ['gstNo', 'gstNumber', 'gstin']),
            },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Line Calculation</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Product Code</th>
                  <th>Description</th>
                  <th>Qty.</th>
                  <th>MRP</th>
                  <th>Cust. Disc %</th>
                  <th>Rate</th>
                  <th>Amount</th>
                  <th>Scheme Disc %</th>
                  <th>Scheme Disc Amt</th>
                  <th>GST %</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.length > 0 ? (
                  lineItems.map((line, index) => (
                    <tr key={`${String(line.productCode ?? line.product_code ?? index)}`}>
                      <td>{toDisplayValue(line.productCode ?? line.product_code)}</td>
                      <td>{toDisplayValue(line.productDescription ?? line.description)}</td>
                      <td>{toDisplayValue(line.quantity ?? line.qty)}</td>
                      <td>{toDisplayValue(line.mrp)}</td>
                      <td>{toDisplayValue(line.customerDiscountPercent)}</td>
                      <td>{toDisplayValue(line.rate ?? line.unitPrice)}</td>
                      <td>{toDisplayValue(line.amount)}</td>
                      <td>{toDisplayValue(line.discountPercent)}</td>
                      <td>{toDisplayValue(line.discountAmount)}</td>
                      <td>{toDisplayValue(line.gstPercent ?? line.gst_percent)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={10}>No calculated product rows</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ai-console-result-section">
          <h3>Commercial Totals</h3>
          {renderSummaryGrid([
            { label: 'Basic Value', value: totals.basicValue },
            { label: 'Scheme Discount', value: totals.schemeDiscount },
            { label: 'Net Basic Value', value: totals.netBasicValue },
            { label: 'Amount After Discount', value: totals.amountAfterDiscount },
            { label: 'Taxable Value', value: totals.netTaxableValue },
            { label: 'Tax Mode', value: taxCalculation.taxMode },
            { label: 'IGST %', value: totals.igstPercent },
            { label: 'IGST Amount', value: totals.igstAmount },
            { label: 'CGST %', value: totals.cgstPercent },
            { label: 'CGST Amount', value: totals.cgstAmount },
            { label: 'SGST %', value: totals.sgstPercent },
            { label: 'SGST Amount', value: totals.sgstAmount },
            { label: 'Freight', value: totals.freight },
            { label: 'Round Off', value: totals.roundOff },
            { label: 'Grand Total', value: totals.grandTotal },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Rate Lookup</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Product Code</th>
                  <th>Category</th>
                  <th>Rate Date</th>
                  <th>MRP</th>
                  <th>Selected Rate</th>
                  <th>Customer Disc %</th>
                  <th>Final Rate</th>
                </tr>
              </thead>
              <tbody>
                {rateLookups.length > 0 ? (
                  rateLookups.map((rateLookup, index) => (
                    <tr key={`${String(rateLookup.productCode ?? index)}`}>
                      <td>{toDisplayValue(rateLookup.productCode)}</td>
                      <td>{toDisplayValue(rateLookup.category)}</td>
                      <td>{toDisplayValue(rateLookup.effectiveDate)}</td>
                      <td>{toDisplayValue(rateLookup.mrp)}</td>
                      <td>{toDisplayValue(rateLookup.selectedRate)}</td>
                      <td>{toDisplayValue(rateLookup.customerDiscountPercent)}</td>
                      <td>{toDisplayValue(rateLookup.unitPrice)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>No rate lookups</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
        {renderInputInformation(testResult)}
      </div>
    )
  }

  const renderDraftPISummaryResult = (testResult: APIResult) => {
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)
    const items = getArray(testResult.items).filter(isRecord)
    const commercialValues = isRecord(testResult.commercialValues)
      ? testResult.commercialValues
      : {}
    const sendResult = isRecord(testResult.sendResult) ? testResult.sendResult : {}
    const metaApiTrace = isRecord(testResult.metaApiTrace) ? testResult.metaApiTrace : {}
    const metaResponse = isRecord(metaApiTrace.response) ? metaApiTrace.response : {}
    const tokenStatus = isRecord(testResult.tokenStatus) ? testResult.tokenStatus : {}

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Mode', value: testResult.mode },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Draft PI</h3>
          {renderSummaryGrid([
            { label: 'PI Number', value: testResult.piNumber },
            { label: 'Company', value: testResult.company },
            { label: 'Customer', value: testResult.customer },
            { label: 'Sender Phone', value: testResult.senderPhone },
            { label: 'Allowed Tester', value: testResult.allowedTester },
            { label: 'Token Configured', value: tokenStatus.accessTokenConfigured },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Items</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Qty.</th>
                  <th>Unit</th>
                  <th>Rate</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.length > 0 ? (
                  items.map((item, index) => (
                    <tr key={`${String(item.productCode ?? index)}`}>
                      <td>{toDisplayValue(item.productDescription)}</td>
                      <td>{toDisplayValue(item.quantity)}</td>
                      <td>{toDisplayValue(item.unit)}</td>
                      <td>{toDisplayValue(item.rate)}</td>
                      <td>{toDisplayValue(item.amount)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5}>No PI items loaded</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ai-console-result-section">
          <h3>Commercial Values</h3>
          {renderSummaryGrid([
            { label: 'Basic Value', value: commercialValues.basicValue },
            { label: 'Discount', value: commercialValues.totalDiscount },
            { label: 'Taxable Value', value: commercialValues.netTaxableValue },
            { label: 'IGST', value: commercialValues.igstAmount },
            { label: 'CGST', value: commercialValues.cgstAmount },
            { label: 'SGST', value: commercialValues.sgstAmount },
            { label: 'Grand Total', value: commercialValues.grandTotal },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Message Preview</h3>
          <pre className="ai-console-json-viewer">{String(testResult.messagePreview ?? '')}</pre>
        </section>

        <section className="ai-console-result-section">
          <h3>Send Result</h3>
          {renderSummaryGrid([
            { label: 'Send Status', value: sendResult.status },
            { label: 'Meta Message ID', value: sendResult.metaMessageId },
            { label: 'HTTP Status', value: metaResponse.httpStatus },
            { label: 'Error Code', value: sendResult.errorCode },
            { label: 'Error Message', value: sendResult.errorMessage },
          ])}
        </section>

        {renderJSONDetails('Meta API Request', metaApiTrace.request, true)}
        {renderJSONDetails('Meta API Response', metaApiTrace.response, true)}
        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderCustomerConfirmationResult = (testResult: APIResult) => {
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Handled', value: testResult.handled },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Confirmation</h3>
          {renderSummaryGrid([
            { label: 'PI Number', value: testResult.piNumber },
            { label: 'Sender Phone', value: testResult.senderPhone },
            { label: 'Source Message Found', value: testResult.sourceMessageFound },
            { label: 'Change Request', value: testResult.changeRequest },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Incoming Reply</h3>
          <pre className="ai-console-json-viewer">{String(testResult.replyText ?? '')}</pre>
        </section>

        <section className="ai-console-result-section">
          <h3>Response Message</h3>
          <pre className="ai-console-json-viewer">{String(testResult.responseMessage ?? '')}</pre>
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderWhatsappAcknowledgementResult = (testResult: APIResult) => {
    const acknowledgement = isRecord(testResult.acknowledgement)
      ? testResult.acknowledgement
      : {}
    const tokenStatus = isRecord(testResult.tokenStatus) ? testResult.tokenStatus : {}
    const sourceMessage = isRecord(testResult.sourceMessage) ? testResult.sourceMessage : {}
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Test Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Name', value: testResult.testName },
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Success', value: testResult.success },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Mode', value: testResult.mode },
            { label: 'Duration', value: formatDuration(testResult.durationMs) },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Acknowledgement Context</h3>
          {renderSummaryGrid([
            { label: 'Source Message ID', value: sourceMessage.messageId ?? testResult.messageId },
            { label: 'Sender Phone', value: testResult.senderPhone },
            { label: 'PI Number', value: testResult.piNumber },
            { label: 'Processing Status', value: testResult.processingStatus },
            { label: 'Allowed Tester', value: testResult.allowedTester },
            { label: 'Token Configured', value: tokenStatus.accessTokenConfigured },
            { label: 'Phone Number ID Configured', value: tokenStatus.phoneNumberIdConfigured },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Message Preview</h3>
          <pre className="ai-console-json-viewer">
            {String(testResult.messagePreview ?? '')}
          </pre>
        </section>

        <section className="ai-console-result-section">
          <h3>Send Result</h3>
          {renderSummaryGrid([
            { label: 'Send Status', value: acknowledgement.status },
            { label: 'Meta Message ID', value: acknowledgement.metaMessageId },
            { label: 'Attempts', value: acknowledgement.attempts },
            { label: 'Error Code', value: acknowledgement.errorCode },
            { label: 'Error Message', value: acknowledgement.errorMessage },
          ])}
        </section>

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Full Result JSON', testResult)}
      </div>
    )
  }

  const renderPhase1VerificationResult = (testResult: APIResult) => {
    const cards = getArray(testResult.cards).filter(isRecord)
    const tests = getArray(testResult.tests).filter(isRecord)
    const signOffMatrix = getArray(testResult.signOffMatrix).filter(isRecord)
    const blockers = getArray(testResult.unresolvedBlockers).filter(isRecord)
    const totals = isRecord(testResult.totals) ? testResult.totals : {}
    const livePreflight = isRecord(testResult.livePreflight) ? testResult.livePreflight : {}
    const warnings = getMessageArray(testResult.warnings)
    const errors = getMessageArray(testResult.errors)

    return (
      <div className="ai-console-result-content">
        <section className="ai-console-result-section">
          <h3>Phase 1 Summary</h3>
          {renderSummaryGrid([
            { label: 'Test Run ID', value: testResult.testRunId },
            { label: 'Final Status', value: testResult.finalStatus },
            { label: 'Mode', value: testResult.mode },
            { label: 'Selected Test', value: testResult.selectedTest },
            { label: 'Live Tests Performed', value: testResult.liveTestsPerformed },
            { label: 'Pass', value: totals.pass },
            { label: 'Warning', value: totals.warning },
            { label: 'Fail', value: totals.fail },
            { label: 'Not Run', value: totals.notRun },
          ])}
        </section>

        <section className="ai-console-result-section">
          <h3>Verification Cards</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Status</th>
                  <th>Pass</th>
                  <th>Warning</th>
                  <th>Fail</th>
                  <th>Not Run</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => {
                  const counts = isRecord(card.counts) ? card.counts : {}

                  return (
                    <tr key={String(card.id)}>
                      <td>{toDisplayValue(card.label)}</td>
                      <td>{toDisplayValue(card.status)}</td>
                      <td>{toDisplayValue(counts.pass)}</td>
                      <td>{toDisplayValue(counts.warning)}</td>
                      <td>{toDisplayValue(counts.fail)}</td>
                      <td>{toDisplayValue(counts.notRun)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ai-console-result-section">
          <h3>Test Evidence</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Mode</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th>Status</th>
                  <th>PI No.</th>
                  <th>Meta ID</th>
                  <th>Duration</th>
                  <th>Failure Reason</th>
                </tr>
              </thead>
              <tbody>
                {tests.length > 0 ? (
                  tests.map((test) => (
                    <tr key={String(test.id)}>
                      <td>{toDisplayValue(test.testName)}</td>
                      <td>{toDisplayValue(test.mode)}</td>
                      <td>{toDisplayValue(test.expectedResult)}</td>
                      <td>{toDisplayValue(test.actualResult)}</td>
                      <td>{toDisplayValue(test.status)}</td>
                      <td>{toDisplayValue(test.piNumber)}</td>
                      <td>{toDisplayValue(test.metaMessageId)}</td>
                      <td>{formatDuration(test.durationMs)}</td>
                      <td>{toDisplayValue(test.failureReason)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9}>No Phase 1 verification tests returned.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ai-console-result-section">
          <h3>Sign-Off Matrix</h3>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Expected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {signOffMatrix.map((row) => (
                  <tr key={String(row.testId)}>
                    <td>{toDisplayValue(row.area)}</td>
                    <td>{toDisplayValue(row.expected)}</td>
                    <td>{toDisplayValue(row.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="ai-console-result-section">
          <h3>Live Tester Preflight</h3>
          {renderSummaryGrid([
            { label: 'Tester Phone', value: livePreflight.testerPhone },
            { label: 'Allowed Tester', value: livePreflight.allowedTester },
            { label: 'Confirmation Checked', value: livePreflight.confirmLive },
            { label: 'Token Configured', value: livePreflight.accessTokenConfigured },
            { label: 'Phone Number ID Configured', value: livePreflight.phoneNumberIdConfigured },
          ])}
        </section>

        {blockers.length > 0 ? (
          <section className="ai-console-result-section">
            <h3>Unresolved Blockers</h3>
            <ul className="ai-console-message-list">
              {blockers.map((blocker) => (
                <li key={String(blocker.testId)}>
                  {toDisplayValue(blocker.area)}: {toDisplayValue(blocker.status)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {renderMessageSection('Warnings', warnings, 'No warnings')}
        {renderMessageSection('Errors', errors, 'No errors')}
        {renderJSONDetails('Detailed Evidence JSON', testResult, true)}
      </div>
    )
  }

  const renderResultPanelContent = () => {
    if (!result) {
      return <p className="ai-console-empty-result">No test result yet.</p>
    }

    if (resultModule === 'system-check') {
      return (
        <>
          <div className="ai-console-table-wrap">
            <table className="ai-console-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {systemCheckRows.length > 0 ? (
                  systemCheckRows.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>
                        <span className={`ai-console-status ai-console-status-${row.status.toLowerCase().replace(/\s+/g, '-')}`}>
                          {row.status}
                        </span>
                      </td>
                      <td>{row.message || '-'}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3}>
                      Run System Configuration Check to show configuration rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {renderJSONDetails('Full Result JSON', result)}
        </>
      )
    }

    if (resultModule === 'text-parser') {
      return renderTextParserResult(result)
    }

    if (resultModule === 'customer-match') {
      return renderCustomerMatcherResult(result)
    }

    if (resultModule === 'product-match') {
      return renderProductMatcherResult(result)
    }

    if (resultModule === 'company-selection') {
      return renderCompanySelectionResult(result)
    }

    if (resultModule === 'commercial-pi-calculation') {
      return renderCommercialPIResult(result)
    }

    if (resultModule === 'draft-pi-summary') {
      return renderDraftPISummaryResult(result)
    }

    if (resultModule === 'customer-confirmation') {
      return renderCustomerConfirmationResult(result)
    }

    if (resultModule === 'whatsapp-acknowledgement') {
      return renderWhatsappAcknowledgementResult(result)
    }

    if (resultModule === 'phase1-verification') {
      return renderPhase1VerificationResult(result)
    }

    return (
      <div className="ai-console-result-content">
        {renderMessageSection(
          'Warnings',
          getMessageArray(result.warnings),
          'No warnings',
        )}
        {renderMessageSection('Errors', getMessageArray(result.errors), 'No errors')}
        {renderJSONDetails('Full Result JSON', result, true)}
      </div>
    )
  }

  return (
    <div className="page ai-console-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Developer Utility</p>
          <h1>AI Communication Test Console</h1>
          <p className="page-subtitle">
            Test each WhatsApp order-processing module independently. Dry-run
            behavior is enforced for this milestone.
          </p>
        </div>
        <span className="status-pill">{statusMessage}</span>
      </header>

      <SystemHealthDashboard
        currentUserName={currentUserName}
        onModuleSelect={selectModuleFromHealth}
      />

      <section className="ai-console-layout">
        <aside className="panel ai-console-module-list">
          {modules.map((module) => (
            <button
              className={`ai-console-module ${activeModule === module.id ? 'active' : ''}`}
              key={module.id}
              onClick={() => setActiveModule(module.id)}
              type="button"
            >
              <span>{module.label}</span>
              <small>{module.ready ? module.milestone : `${module.milestone} pending`}</small>
            </button>
          ))}
        </aside>

        <div className="panel ai-console-input-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{activeModuleMeta.milestone}</p>
              <h2>{activeModuleMeta.label}</h2>
            </div>
            <div className="header-actions">
              <span className="status-pill">{activeModuleMeta.ready ? 'DRY RUN' : 'PENDING'}</span>
              <Button disabled={isRunning} onClick={runActiveModule}>
                {isRunning ? 'Running' : 'Run Test'}
              </Button>
            </div>
          </div>
          {renderInputPanel()}
        </div>
      </section>

      <section className="panel ai-console-result-panel" ref={resultPanelRef}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">Result</p>
            <h2>Common Result Panel</h2>
          </div>
          <div className="header-actions">
            <Button disabled={!result} onClick={copyResult} variant="secondary">Copy Result</Button>
            <Button disabled={!result} onClick={downloadResult} variant="secondary">Download JSON</Button>
            <Button disabled={!lastRun || isRunning} onClick={() => void lastRun?.()} variant="secondary">
              Run Again
            </Button>
            <Button disabled={!result} onClick={() => setResult(null)} variant="ghost">Clear</Button>
          </div>
        </div>
        {renderResultPanelContent()}
      </section>
    </div>
  )
}

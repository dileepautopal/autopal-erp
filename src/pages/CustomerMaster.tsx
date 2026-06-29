import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Button } from '../components/ui/Button'
import { InputField, SelectField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import type {
  FieldOption,
  MasterCustomer,
  MasterCustomerLookups,
  MasterLookupOption,
} from '../types'
import { parseNumber } from '../utils/calculations'

const ALL_FILTER_VALUE = 'all'
const CUSTOMER_API_URL = apiUrl('/api/master-customers')
const CUSTOMER_LOOKUP_API_URL = apiUrl('/api/master-customer-lookups')
const CUSTOMER_COLUMN_WIDTHS_STORAGE_KEY =
  'autopal-customer-master-column-widths'

const emptyLookups: MasterCustomerLookups = {
  cities: [],
  countries: [],
  markets: [],
  partyTypes: [],
  states: [],
}

type CustomerTabId = 'basic' | 'tax' | 'contact' | 'credit'
type CustomerPopup =
  | {
      message: string
      mode: 'alert'
    }
  | {
      customerId: number
      message: string
      mode: 'confirm-delete'
    }

const customerTabs: Array<{ id: CustomerTabId; label: string }> = [
  { id: 'basic', label: 'Customer Details' },
  { id: 'tax', label: 'GST/PAN Details' },
  { id: 'contact', label: 'Contact Details' },
  { id: 'credit', label: 'Credit Details' },
]

const customerTableColumns = [
  { defaultWidth: 18, id: 'customer', label: 'Customer', minWidth: 10 },
  { defaultWidth: 24, id: 'location', label: 'Location', minWidth: 16 },
  { defaultWidth: 12, id: 'market', label: 'Market', minWidth: 8 },
  { defaultWidth: 12, id: 'partyType', label: 'Party Type', minWidth: 8 },
  { defaultWidth: 13, id: 'tax', label: 'GST / PAN', minWidth: 10 },
  { defaultWidth: 13, id: 'contact', label: 'Contact', minWidth: 10 },
  { defaultWidth: 8, id: 'actions', label: 'Actions', minWidth: 7 },
] as const

type CustomerTableColumnId = (typeof customerTableColumns)[number]['id']
type CustomerColumnWidths = Record<CustomerTableColumnId, number>
type CustomerColumnResize = {
  columnId: CustomerTableColumnId
  nextColumnId: CustomerTableColumnId
  nextStartWidth: number
  startWidth: number
  startX: number
  tableWidth: number
}

const getDefaultCustomerColumnWidths = () =>
  customerTableColumns.reduce(
    (widths, column) => ({
      ...widths,
      [column.id]: column.defaultWidth,
    }),
    {} as CustomerColumnWidths,
  )

const customerColumnMinWidths = customerTableColumns.reduce(
  (widths, column) => ({
    ...widths,
    [column.id]: column.minWidth,
  }),
  {} as CustomerColumnWidths,
)

const getStoredCustomerColumnWidths = () => {
  const defaultWidths = getDefaultCustomerColumnWidths()

  if (typeof window === 'undefined') {
    return defaultWidths
  }

  try {
    const storedValue = window.localStorage.getItem(
      CUSTOMER_COLUMN_WIDTHS_STORAGE_KEY,
    )

    if (!storedValue) {
      return defaultWidths
    }

    const parsedValue = JSON.parse(storedValue) as Partial<
      Record<CustomerTableColumnId, unknown>
    >
    const storedWidths = customerTableColumns.reduce(
      (widths, column) => ({
        ...widths,
        [column.id]: Number(parsedValue[column.id]),
      }),
      {} as CustomerColumnWidths,
    )
    const hasValidWidths = customerTableColumns.every(
      (column) =>
        Number.isFinite(storedWidths[column.id]) &&
        storedWidths[column.id] >= column.minWidth,
    )
    const totalWidth = customerTableColumns.reduce(
      (total, column) => total + storedWidths[column.id],
      0,
    )

    if (hasValidWidths && Math.abs(totalWidth - 100) < 0.5) {
      return storedWidths
    }
  } catch {
    // Ignore old or malformed stored layout preferences.
  }

  return defaultWidths
}

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as {
      errors?: string[]
      message?: string
    }

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.join(' ')
    }

    if (body.message) {
      return body.message
    }
  } catch {
    // Fall back to the HTTP status if the API does not return JSON.
  }

  return `Request failed with status ${response.status}`
}

const toOptions = (
  items: MasterLookupOption[],
  placeholder: string,
): FieldOption[] => [
  { value: '', label: placeholder },
  ...items.map((item) => ({
    value: String(item.code),
    label: item.name,
  })),
]

const getLookupName = (
  code: number,
  items: MasterLookupOption[],
  fallback = '-',
) => items.find((item) => item.code === code)?.name ?? fallback

const getNextCustomerCode = (customers: MasterCustomer[]) =>
  Math.min(
    customers.reduce(
      (highestCode, customer) => Math.max(highestCode, customer.custCode),
      0,
    ) + 1,
    32767,
  )

export function CustomerMaster() {
  const [customers, setCustomers] = useState<MasterCustomer[]>([])
  const [lookups, setLookups] =
    useState<MasterCustomerLookups>(emptyLookups)
  const [editingCustomerId, setEditingCustomerId] = useState<number | null>(
    null,
  )
  const [editingOriginalCustomer, setEditingOriginalCustomer] =
    useState<MasterCustomer | null>(null)
  const [activeTab, setActiveTab] = useState<CustomerTabId>('basic')
  const [statusMessage, setStatusMessage] = useState(
    'Loading customers from PostgreSQL',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [marketFilter, setMarketFilter] = useState(ALL_FILTER_VALUE)
  const [partyTypeFilter, setPartyTypeFilter] = useState(ALL_FILTER_VALUE)
  const [customerPopup, setCustomerPopup] = useState<CustomerPopup | null>(null)
  const [customerColumnWidths, setCustomerColumnWidths] = useState(
    getStoredCustomerColumnWidths,
  )
  const customerColumnResizeRef = useRef<CustomerColumnResize | null>(null)

  useEffect(() => {
    const loadCustomerMaster = async () => {
      setIsLoading(true)
      setErrorMessage('')

      try {
        const [lookupResponse, customerResponse] = await Promise.all([
          fetch(CUSTOMER_LOOKUP_API_URL),
          fetch(CUSTOMER_API_URL),
        ])

        if (!lookupResponse.ok) {
          throw new Error(await getApiErrorMessage(lookupResponse))
        }

        if (!customerResponse.ok) {
          throw new Error(await getApiErrorMessage(customerResponse))
        }

        const apiLookups =
          (await lookupResponse.json()) as MasterCustomerLookups
        const apiCustomers = (await customerResponse.json()) as MasterCustomer[]

        setLookups(apiLookups)
        setCustomers(apiCustomers)
        setStatusMessage(`${apiCustomers.length} customers loaded`)
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load Customer Master from backend.',
        )
        setLookups(emptyLookups)
        setCustomers([])
        setStatusMessage('Backend not connected')
      } finally {
        setIsLoading(false)
      }
    }

    void loadCustomerMaster()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(
      CUSTOMER_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(customerColumnWidths),
    )
  }, [customerColumnWidths])

  useEffect(() => {
    const stopColumnResize = () => {
      customerColumnResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const resizeColumn = (event: MouseEvent) => {
      const resize = customerColumnResizeRef.current

      if (!resize) {
        return
      }

      const deltaWidth =
        ((event.clientX - resize.startX) / resize.tableWidth) * 100
      const minDelta =
        customerColumnMinWidths[resize.columnId] - resize.startWidth
      const maxDelta =
        resize.nextStartWidth -
        customerColumnMinWidths[resize.nextColumnId]
      const boundedDelta = Math.min(
        Math.max(deltaWidth, minDelta),
        maxDelta,
      )

      setCustomerColumnWidths((currentWidths) => ({
        ...currentWidths,
        [resize.columnId]: Number(
          (resize.startWidth + boundedDelta).toFixed(2),
        ),
        [resize.nextColumnId]: Number(
          (resize.nextStartWidth - boundedDelta).toFixed(2),
        ),
      }))
    }

    document.addEventListener('mousemove', resizeColumn)
    document.addEventListener('mouseup', stopColumnResize)

    return () => {
      document.removeEventListener('mousemove', resizeColumn)
      document.removeEventListener('mouseup', stopColumnResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  const selectedCustomer = useMemo(
    () =>
      editingCustomerId === null
        ? null
        : customers.find((customer) => customer.customerId === editingCustomerId) ??
          null,
    [customers, editingCustomerId],
  )

  const countryOptions = useMemo(
    () => toOptions(lookups.countries, 'Select country'),
    [lookups.countries],
  )
  const cityOptions = useMemo(
    () => toOptions(lookups.cities, 'Select city'),
    [lookups.cities],
  )
  const marketOptions = useMemo(
    () => toOptions(lookups.markets, 'Select market'),
    [lookups.markets],
  )
  const partyTypeOptions = useMemo(
    () => toOptions(lookups.partyTypes, 'Select party type'),
    [lookups.partyTypes],
  )

  const marketFilterOptions = useMemo<FieldOption[]>(
    () => [
      { value: ALL_FILTER_VALUE, label: 'All markets' },
      ...lookups.markets.map((market) => ({
        value: String(market.code),
        label: market.name,
      })),
    ],
    [lookups.markets],
  )

  const partyTypeFilterOptions = useMemo<FieldOption[]>(
    () => [
      { value: ALL_FILTER_VALUE, label: 'All party types' },
      ...lookups.partyTypes.map((partyType) => ({
        value: String(partyType.code),
        label: partyType.name,
      })),
    ],
    [lookups.partyTypes],
  )

  const filteredCustomers = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()

    return customers.filter((customer) => {
      const marketName =
        customer.marketName ||
        getLookupName(customer.marketCode, lookups.markets, '')
      const partyTypeName =
        customer.partyTypeName ||
        getLookupName(customer.partyTypeCode, lookups.partyTypes, '')
      const cityName =
        customer.corrCityName ||
        getLookupName(customer.corrCityCode, lookups.cities, '')
      const stateName =
        customer.corrStateName ||
        getLookupName(customer.corrStateCode, lookups.states, '')
      const countryName =
        customer.corrCountryName ||
        getLookupName(customer.corrCountryCode, lookups.countries, '')

      const matchesSearch =
        !normalizedSearch ||
        [
          String(customer.custCode),
          customer.custName,
          customer.gstinNo,
          customer.panNo,
          customer.contactPerson,
          customer.mobileNo,
          customer.zone,
          marketName,
          partyTypeName,
          cityName,
          stateName,
          countryName,
        ].some((value) => value.toLowerCase().includes(normalizedSearch))
      const matchesMarket =
        marketFilter === ALL_FILTER_VALUE ||
        String(customer.marketCode) === marketFilter
      const matchesPartyType =
        partyTypeFilter === ALL_FILTER_VALUE ||
        String(customer.partyTypeCode) === partyTypeFilter

      return matchesSearch && matchesMarket && matchesPartyType
    })
  }, [customers, lookups, marketFilter, partyTypeFilter, searchTerm])

  const updateCustomer = <Key extends keyof MasterCustomer>(
    customerId: number,
    field: Key,
    value: MasterCustomer[Key],
  ) => {
    setCustomers((currentCustomers) =>
      currentCustomers.map((customer) =>
        customer.customerId === customerId
          ? { ...customer, [field]: value }
          : customer,
      ),
    )
  }

  const updateCustomerAndShipping = <Key extends keyof MasterCustomer>(
    customerId: number,
    field: Key,
    value: MasterCustomer[Key],
    shippingField?: keyof MasterCustomer,
  ) => {
    setCustomers((currentCustomers) =>
      currentCustomers.map((customer) =>
        customer.customerId === customerId
          ? {
              ...customer,
              [field]: value,
              ...(shippingField ? { [shippingField]: value } : {}),
            }
          : customer,
      ),
    )
  }

  const startCustomerColumnResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    const column = customerTableColumns[columnIndex]
    const nextColumn = customerTableColumns[columnIndex + 1]
    const table = event.currentTarget.closest('table')
    const tableWidth = table?.getBoundingClientRect().width ?? 0

    if (!column || !nextColumn || tableWidth <= 0) {
      return
    }

    customerColumnResizeRef.current = {
      columnId: column.id,
      nextColumnId: nextColumn.id,
      nextStartWidth: customerColumnWidths[nextColumn.id],
      startWidth: customerColumnWidths[column.id],
      startX: event.clientX,
      tableWidth,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    event.preventDefault()
  }

  const handleCustomerCityChange = (customerId: number, cityCode: string) => {
    const city = lookups.cities.find((item) => String(item.code) === cityCode)
    const state =
      city?.parentCode === undefined
        ? undefined
        : lookups.states.find((item) => item.code === city.parentCode)

    setCustomers((currentCustomers) =>
      currentCustomers.map((customer) =>
        customer.customerId === customerId
          ? {
              ...customer,
              corrCityCode: city?.code ?? 0,
              corrCityName: city?.name ?? '',
              corrStateCode: state?.code ?? 0,
              corrStateName: state?.name ?? '',
              shipCityCode: city?.code ?? 0,
              shipCityName: city?.name ?? '',
              shipStateCode: state?.code ?? 0,
              shipStateName: state?.name ?? '',
            }
          : customer,
      ),
    )
  }

  const addCustomer = () => {
    if (editingCustomerId) {
      setStatusMessage('Save or cancel the current customer first')
      return
    }

    const initialCity = lookups.cities[0]
    const initialState =
      (initialCity?.parentCode === undefined
        ? undefined
        : lookups.states.find(
            (state) => state.code === initialCity.parentCode,
          )) ?? lookups.states[0]
    const countryCode = lookups.countries[0]?.code ?? 0
    const stateCode = initialState?.code ?? 0
    const cityCode = initialCity?.code ?? 0
    const marketCode = lookups.markets[0]?.code ?? 0
    const partyTypeCode = lookups.partyTypes[0]?.code ?? 0

    const newCustomer: MasterCustomer = {
      customerId: -Date.now(),
      contactPerson: '',
      corrAddress: '',
      corrCityCode: cityCode,
      corrCityName: initialCity?.name ?? '',
      corrCountryCode: countryCode,
      corrCountryName: getLookupName(countryCode, lookups.countries, ''),
      corrEmail: '',
      corrFax: '',
      corrPinCode: 0,
      corrStateCode: stateCode,
      corrStateName: initialState?.name ?? '',
      corrTel: '',
      creditDays: 0,
      creditLimit: 0,
      custCode: getNextCustomerCode(customers),
      custName: '',
      gstDate: '',
      gstinNo: '',
      isActive: true,
      marketCode,
      marketName: getLookupName(marketCode, lookups.markets, ''),
      mobileNo: '',
      panNo: '',
      partyTypeCode,
      partyTypeName: getLookupName(partyTypeCode, lookups.partyTypes, ''),
      remarks: '',
      shipAddress: '',
      shipCityCode: cityCode,
      shipCityName: initialCity?.name ?? '',
      shipCountryCode: countryCode,
      shipCountryName: getLookupName(countryCode, lookups.countries, ''),
      shipEmail: '',
      shipFax: '',
      shipPinCode: 0,
      shipStateCode: stateCode,
      shipStateName: initialState?.name ?? '',
      shipTel: '',
      website: '',
      zone: '',
    }

    setCustomers((currentCustomers) => [newCustomer, ...currentCustomers])
    setSearchTerm('')
    setMarketFilter(ALL_FILTER_VALUE)
    setPartyTypeFilter(ALL_FILTER_VALUE)
    setEditingCustomerId(newCustomer.customerId)
    setEditingOriginalCustomer(null)
    setActiveTab('basic')
    setErrorMessage('')
    setStatusMessage('New customer form opened')
  }

  const editCustomer = (customerId: number) => {
    if (editingCustomerId && editingCustomerId !== customerId) {
      setStatusMessage('Save or cancel the current customer first')
      return
    }

    const customer = customers.find((item) => item.customerId === customerId)

    setEditingCustomerId(customerId)
    setEditingOriginalCustomer(customer ? { ...customer } : null)
    setActiveTab('basic')
    setErrorMessage('')
    setStatusMessage('Editing customer details')
  }

  const saveCustomer = async () => {
    if (!editingCustomerId) {
      return
    }

    const customer = customers.find(
      (item) => item.customerId === editingCustomerId,
    )

    if (!customer) {
      return
    }

    const isNewCustomer = !editingOriginalCustomer

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        isNewCustomer
          ? CUSTOMER_API_URL
          : `${CUSTOMER_API_URL}/${editingCustomerId}`,
        {
          body: JSON.stringify(customer),
          headers: {
            'Content-Type': 'application/json',
          },
          method: isNewCustomer ? 'POST' : 'PUT',
        },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const savedCustomer = (await response.json()) as MasterCustomer

      setCustomers((currentCustomers) =>
        isNewCustomer
          ? [
              savedCustomer,
              ...currentCustomers.filter(
                (item) => item.customerId !== customer.customerId,
              ),
            ]
          : currentCustomers.map((item) =>
              item.customerId === savedCustomer.customerId
                ? savedCustomer
                : item,
            ),
      )
      setEditingCustomerId(null)
      setEditingOriginalCustomer(null)
      const successMessage = isNewCustomer
        ? `Customer ${savedCustomer.custName} saved successfully.`
        : `Customer ${savedCustomer.custName} updated successfully.`

      setStatusMessage(
        isNewCustomer
          ? 'Customer saved to PostgreSQL'
          : 'Customer updated in PostgreSQL',
      )
      setCustomerPopup({ message: successMessage, mode: 'alert' })
    } catch (error) {
      const saveErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to save customer in backend.'

      setErrorMessage(saveErrorMessage)
      setStatusMessage('Save failed')
      setCustomerPopup({ message: saveErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const cancelCustomer = () => {
    if (!editingCustomerId) {
      return
    }

    if (editingOriginalCustomer) {
      setCustomers((currentCustomers) =>
        currentCustomers.map((customer) =>
          customer.customerId === editingOriginalCustomer.customerId
            ? editingOriginalCustomer
            : customer,
        ),
      )
    } else {
      setCustomers((currentCustomers) =>
        currentCustomers.filter(
          (customer) => customer.customerId !== editingCustomerId,
        ),
      )
    }

    setEditingCustomerId(null)
    setEditingOriginalCustomer(null)
    setActiveTab('basic')
    setErrorMessage('')
    setStatusMessage('Customer edit cancelled')
  }

  const confirmDeleteCustomer = (customerId: number) => {
    const customer = customers.find((item) => item.customerId === customerId)

    setCustomerPopup({
      customerId,
      message: `Delete customer ${customer?.custName || 'this row'}?`,
      mode: 'confirm-delete',
    })
  }

  const deleteCustomer = async (customerId: number) => {
    const customer = customers.find((item) => item.customerId === customerId)
    const customerName = customer?.custName || 'this row'

    if (customerId < 0) {
      setCustomers((currentCustomers) =>
        currentCustomers.filter((item) => item.customerId !== customerId),
      )
      setEditingCustomerId(null)
      setEditingOriginalCustomer(null)
      setActiveTab('basic')
      setStatusMessage('New customer row deleted')
      setCustomerPopup({
        message: `Customer ${customerName} deleted successfully.`,
        mode: 'alert',
      })
      return
    }

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(`${CUSTOMER_API_URL}/${customerId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      setCustomers((currentCustomers) =>
        currentCustomers.filter((item) => item.customerId !== customerId),
      )
      if (editingCustomerId === customerId) {
        setEditingCustomerId(null)
        setEditingOriginalCustomer(null)
        setActiveTab('basic')
      }
      setStatusMessage('Customer deleted from PostgreSQL')
      setCustomerPopup({
        message: `Customer ${customerName} deleted successfully.`,
        mode: 'alert',
      })
    } catch (error) {
      const deleteErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to delete customer from backend.'

      setErrorMessage(deleteErrorMessage)
      setStatusMessage('Delete failed')
      setCustomerPopup({ message: deleteErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const renderSelectedCustomerForm = () => {
    if (!selectedCustomer) {
      return null
    }

    return (
      <section className="panel customer-edit-panel">
        <div className="customer-tab-actions">
          <div>
            <p className="eyebrow">
              {editingOriginalCustomer ? 'Edit customer' : 'Add customer'}
            </p>
            <h2>{selectedCustomer.custName || 'New Customer'}</h2>
          </div>
          <div className="table-actions">
            <Button
              disabled={isSaving}
              onClick={saveCustomer}
              variant="secondary"
            >
              {isSaving ? 'Saving' : 'Save'}
            </Button>
            <Button disabled={isSaving} onClick={cancelCustomer} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => confirmDeleteCustomer(selectedCustomer.customerId)}
              variant="danger"
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="customer-tab-list" role="tablist">
          {customerTabs.map((tab) => (
            <button
              className={`customer-tab-button ${
                activeTab === tab.id ? 'active' : ''
              }`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="customer-tab-content">
          {activeTab === 'basic' ? (
            <div className="customer-form-grid">
              <label className="field">
                <span className="field-label">Customer Code</span>
                <input
                  className="field-control"
                  min="1"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'custCode',
                      parseNumber(event.target.value),
                    )
                  }
                  type="number"
                  value={selectedCustomer.custCode || ''}
                />
              </label>
              <label className="field">
                <span className="field-label">Customer Name</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'custName',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.custName}
                />
              </label>
              <label className="field customer-form-span-2">
                <span className="field-label">Address</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomerAndShipping(
                      selectedCustomer.customerId,
                      'corrAddress',
                      event.target.value,
                      'shipAddress',
                    )
                  }
                  value={selectedCustomer.corrAddress}
                />
              </label>
              <label className="field">
                <span className="field-label">City</span>
                <select
                  className="field-control select-control"
                  onChange={(event) =>
                    handleCustomerCityChange(
                      selectedCustomer.customerId,
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.corrCityCode || ''}
                >
                  {cityOptions.map((city) => (
                    <option key={city.value} value={city.value}>
                      {city.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">PIN</span>
                <input
                  className="field-control"
                  min="0"
                  onChange={(event) =>
                    updateCustomerAndShipping(
                      selectedCustomer.customerId,
                      'corrPinCode',
                      parseNumber(event.target.value),
                      'shipPinCode',
                    )
                  }
                  type="number"
                  value={selectedCustomer.corrPinCode || ''}
                />
              </label>
              <label className="field">
                <span className="field-label">State</span>
                <input
                  className="field-control"
                  readOnly
                  value={
                    selectedCustomer.corrStateName ||
                    getLookupName(
                      selectedCustomer.corrStateCode,
                      lookups.states,
                      '',
                    )
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">Country</span>
                <select
                  className="field-control select-control"
                  onChange={(event) =>
                    updateCustomerAndShipping(
                      selectedCustomer.customerId,
                      'corrCountryCode',
                      parseNumber(event.target.value),
                      'shipCountryCode',
                    )
                  }
                  value={selectedCustomer.corrCountryCode || ''}
                >
                  {countryOptions.map((country) => (
                    <option key={country.value} value={country.value}>
                      {country.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'corrEmail',
                      event.target.value,
                    )
                  }
                  type="email"
                  value={selectedCustomer.corrEmail}
                />
              </label>
              <label className="field">
                <span className="field-label">Market</span>
                <select
                  className="field-control select-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'marketCode',
                      parseNumber(event.target.value),
                    )
                  }
                  value={String(selectedCustomer.marketCode)}
                >
                  {marketOptions.map((market) => (
                    <option key={market.value} value={market.value}>
                      {market.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Zone</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'zone',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.zone}
                />
              </label>
              <label className="field">
                <span className="field-label">Party Type</span>
                <select
                  className="field-control select-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'partyTypeCode',
                      parseNumber(event.target.value),
                    )
                  }
                  value={String(selectedCustomer.partyTypeCode)}
                >
                  {partyTypeOptions.map((partyType) => (
                    <option key={partyType.value} value={partyType.value}>
                      {partyType.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          {activeTab === 'tax' ? (
            <div className="customer-form-grid">
              <label className="field">
                <span className="field-label">GSTIN No.</span>
                <input
                  className="field-control"
                  maxLength={15}
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'gstinNo',
                      event.target.value.toUpperCase(),
                    )
                  }
                  value={selectedCustomer.gstinNo}
                />
              </label>
              <label className="field">
                <span className="field-label">GST Date</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'gstDate',
                      event.target.value,
                    )
                  }
                  type="date"
                  value={selectedCustomer.gstDate}
                />
              </label>
              <label className="field">
                <span className="field-label">PAN No.</span>
                <input
                  className="field-control"
                  maxLength={10}
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'panNo',
                      event.target.value.toUpperCase(),
                    )
                  }
                  value={selectedCustomer.panNo}
                />
              </label>
            </div>
          ) : null}

          {activeTab === 'contact' ? (
            <div className="customer-form-grid">
              <label className="field">
                <span className="field-label">Contact Person</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'contactPerson',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.contactPerson}
                />
              </label>
              <label className="field">
                <span className="field-label">Mobile No.</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'mobileNo',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.mobileNo}
                />
              </label>
              <label className="field">
                <span className="field-label">Telephone</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomerAndShipping(
                      selectedCustomer.customerId,
                      'corrTel',
                      event.target.value,
                      'shipTel',
                    )
                  }
                  value={selectedCustomer.corrTel}
                />
              </label>
              <label className="field">
                <span className="field-label">Fax</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomerAndShipping(
                      selectedCustomer.customerId,
                      'corrFax',
                      event.target.value,
                      'shipFax',
                    )
                  }
                  value={selectedCustomer.corrFax}
                />
              </label>
              <label className="field">
                <span className="field-label">Website</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'website',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.website}
                />
              </label>
            </div>
          ) : null}

          {activeTab === 'credit' ? (
            <div className="customer-form-grid">
              <label className="field">
                <span className="field-label">Credit Days</span>
                <input
                  className="field-control"
                  min="0"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'creditDays',
                      parseNumber(event.target.value),
                    )
                  }
                  type="number"
                  value={selectedCustomer.creditDays}
                />
              </label>
              <label className="field">
                <span className="field-label">Credit Limit</span>
                <input
                  className="field-control"
                  min="0"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'creditLimit',
                      parseNumber(event.target.value),
                    )
                  }
                  type="number"
                  value={selectedCustomer.creditLimit || ''}
                />
              </label>
              <label className="field customer-form-span-2">
                <span className="field-label">Remarks</span>
                <input
                  className="field-control"
                  onChange={(event) =>
                    updateCustomer(
                      selectedCustomer.customerId,
                      'remarks',
                      event.target.value,
                    )
                  }
                  value={selectedCustomer.remarks}
                />
              </label>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <div className="page">
      {customerPopup ? (
        <div
          aria-labelledby="customer-popup-title"
          aria-modal="true"
          className="autopal-alert-backdrop"
          role="dialog"
        >
          <div className="autopal-alert">
            <h2 id="customer-popup-title">Autopal</h2>
            <p>{customerPopup.message}</p>
            <div className="autopal-alert-actions">
              {customerPopup.mode === 'confirm-delete' ? (
                <>
                  <Button
                    disabled={isSaving}
                    onClick={() => void deleteCustomer(customerPopup.customerId)}
                    variant="danger"
                  >
                    Yes
                  </Button>
                  <Button
                    disabled={isSaving}
                    onClick={() => setCustomerPopup(null)}
                    variant="ghost"
                  >
                    No
                  </Button>
                </>
              ) : (
                <Button onClick={() => setCustomerPopup(null)}>OK</Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <header className="page-header">
        <div>
          <p className="eyebrow">Master data</p>
          <h1>Customer Master</h1>
        </div>
        <div className="header-actions">
          <span className="status-pill">{statusMessage}</span>
          <Button disabled={isLoading || isSaving} onClick={addCustomer}>
            <span className="btn-symbol">+</span>
            Add
          </Button>
        </div>
      </header>

      {!selectedCustomer ? (
        <section className="panel customer-master-controls">
          <InputField
            label="Search Customer"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Name, code, GSTIN, market, city, zone"
            value={searchTerm}
          />
          <SelectField
            label="Market"
            onChange={(event) => setMarketFilter(event.target.value)}
            options={marketFilterOptions}
            value={marketFilter}
          />
          <SelectField
            label="Party Type"
            onChange={(event) => setPartyTypeFilter(event.target.value)}
            options={partyTypeFilterOptions}
            value={partyTypeFilter}
          />
        </section>
      ) : null}

      {renderSelectedCustomerForm()}

      {!selectedCustomer ? (
        <section className="panel">
          <div className="responsive-table">
            <table className="master-table customer-master-table">
              <colgroup>
                {customerTableColumns.map((column) => (
                  <col
                    key={column.id}
                    style={{ width: `${customerColumnWidths[column.id]}%` }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {customerTableColumns.map((column, index) => (
                    <th className="resizable-column-header" key={column.id}>
                      <span>{column.label}</span>
                      {index < customerTableColumns.length - 1 ? (
                        <button
                          aria-label={`Resize ${column.label} column`}
                          className="column-resize-handle"
                          onMouseDown={(event) =>
                            startCustomerColumnResize(event, index)
                          }
                          title="Drag to resize column"
                          type="button"
                        />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <p className="eyebrow">Customer API</p>
                        <h2>
                          {isLoading
                            ? 'Loading customers...'
                            : customers.length === 0
                              ? 'No customers found'
                              : 'No matching customers'}
                        </h2>
                        <p>
                          {isLoading
                            ? 'Fetching master_customer records from PostgreSQL.'
                            : customers.length === 0
                              ? errorMessage ||
                                'Click Add to create your first customer.'
                              : 'Change the search text or filters.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredCustomers.map((customer) => (
                    <tr key={customer.customerId}>
                      <td>
                        <strong>{customer.custName || '-'}</strong>
                        <small>Code: {customer.custCode}</small>
                        <small>{customer.corrEmail || 'Email not added'}</small>
                      </td>
                      <td>
                        <strong>
                          {customer.corrCityName ||
                            getLookupName(customer.corrCityCode, lookups.cities)}
                        </strong>
                        <small>
                          {customer.corrStateName ||
                            getLookupName(
                              customer.corrStateCode,
                              lookups.states,
                            )}
                          ,{' '}
                          {customer.corrCountryName ||
                            getLookupName(
                              customer.corrCountryCode,
                              lookups.countries,
                            )}
                        </small>
                        <small>
                          {customer.corrAddress || 'Address not added'}
                        </small>
                        {customer.zone ? (
                          <small>Zone: {customer.zone}</small>
                        ) : null}
                      </td>
                      <td>
                        <strong>
                          {customer.marketName ||
                            getLookupName(customer.marketCode, lookups.markets)}
                        </strong>
                        <small>Code: {customer.marketCode}</small>
                      </td>
                      <td>
                        {customer.partyTypeName ||
                          getLookupName(
                            customer.partyTypeCode,
                            lookups.partyTypes,
                          )}
                      </td>
                      <td>
                        <strong>{customer.gstinNo || '-'}</strong>
                        <small>PAN: {customer.panNo || '-'}</small>
                      </td>
                      <td>
                        <strong>{customer.contactPerson || '-'}</strong>
                        <small>{customer.mobileNo || 'Mobile not added'}</small>
                        <small>{customer.corrTel || 'Telephone not added'}</small>
                      </td>
                    <td>
                      <div className="table-actions">
                          <Button
                            disabled={isSaving}
                            onClick={() => editCustomer(customer.customerId)}
                            variant="ghost"
                          >
                            Edit
                          </Button>
                          <Button
                            disabled={isSaving}
                            onClick={() =>
                              confirmDeleteCustomer(customer.customerId)
                            }
                            variant="danger"
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {errorMessage && customers.length > 0 ? (
            <p className="form-helper">{errorMessage}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

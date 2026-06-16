import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import { InputField, SelectField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import type { CustomerDiscount, FieldOption, MasterCustomer } from '../types'
import { parseNumber } from '../utils/calculations'

const ALL_FILTER_VALUE = 'all'
const CUSTOMER_API_URL = apiUrl('/api/master-customers')
const CUSTOMER_DISCOUNT_API_URL = apiUrl('/api/master-cust-discounts')

type PercentDiscountField =
  | 'hlPer'
  | 'haloPer'
  | 'incdPer'
  | 'wiperPer'
  | 'gstPer'

type CustomerDiscountPopup =
  | {
      message: string
      mode: 'alert'
    }
  | {
      discountId: number
      message: string
      mode: 'confirm-delete'
    }

const compCodeOptions: FieldOption[] = [
  { value: ALL_FILTER_VALUE, label: 'All companies' },
  { value: '1', label: 'Company 1' },
  { value: '2', label: 'Company 2' },
]

const formatDate = (value: string) => {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

const formatPercent = (value: number) =>
  `${new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)}%`

const average = (values: number[]) => {
  const validValues = values.filter((value) => Number.isFinite(value))

  if (validValues.length === 0) {
    return 0
  }

  return validValues.reduce((sum, value) => sum + value, 0) / validValues.length
}

const parseOptionalNumber = (value: string) => {
  if (value.trim() === '') {
    return Number.NaN
  }

  return parseNumber(value)
}

const getNumberInputValue = (value: number) =>
  Number.isFinite(value) ? value : ''

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = await response.json()

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.join(' ')
    }

    if (body.message) {
      return body.message
    }
  } catch {
    // Fall back to the HTTP status below.
  }

  return `Request failed with status ${response.status}`
}

export function CustomerDiscountMaster() {
  const [discounts, setDiscounts] = useState<CustomerDiscount[]>([])
  const [customers, setCustomers] = useState<MasterCustomer[]>([])
  const [editingDiscountId, setEditingDiscountId] = useState<number | null>(
    null,
  )
  const [editingOriginalDiscount, setEditingOriginalDiscount] =
    useState<CustomerDiscount | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [compCodeFilter, setCompCodeFilter] = useState(ALL_FILTER_VALUE)
  const [statusMessage, setStatusMessage] = useState(
    'Loading customer discounts from PostgreSQL',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [discountPopup, setDiscountPopup] =
    useState<CustomerDiscountPopup | null>(null)

  useEffect(() => {
    let isCancelled = false

    const loadCustomerDiscounts = async () => {
      setIsLoading(true)
      setErrorMessage('')

      try {
        const [customerResponse, discountResponse] = await Promise.all([
          fetch(CUSTOMER_API_URL),
          fetch(CUSTOMER_DISCOUNT_API_URL),
        ])

        if (!customerResponse.ok) {
          throw new Error(await getApiErrorMessage(customerResponse))
        }

        if (!discountResponse.ok) {
          throw new Error(await getApiErrorMessage(discountResponse))
        }

        const customerRows =
          (await customerResponse.json()) as MasterCustomer[]
        const discountRows =
          (await discountResponse.json()) as CustomerDiscount[]

        if (isCancelled) {
          return
        }

        setCustomers(customerRows)
        setDiscounts(discountRows)
        setStatusMessage(`${discountRows.length} customer discounts loaded`)
      } catch (error) {
        if (isCancelled) {
          return
        }

        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load customer discounts from backend.',
        )
        setStatusMessage('Backend not connected')
      } finally {
        if (!isCancelled) {
          setIsLoading(false)
        }
      }
    }

    void loadCustomerDiscounts()

    return () => {
      isCancelled = true
    }
  }, [])

  const selectedDiscount = useMemo(
    () =>
      editingDiscountId === null
        ? null
        : discounts.find((discount) => discount.id === editingDiscountId) ??
          null,
    [discounts, editingDiscountId],
  )

  const customerOptions = useMemo<FieldOption[]>(
    () => [
      {
        value: '',
        label: customers.length === 0 ? 'No customers found' : 'Select customer',
      },
      ...customers.map((customer) => ({
        value: String(customer.custCode),
        label: `${customer.custCode} - ${customer.custName}`,
      })),
    ],
    [customers],
  )

  const customerNameByCode = useMemo(
    () =>
      discounts.reduce<Record<number, string>>((customerMap, discount) => {
        if (discount.customerName) {
          customerMap[discount.custCode] = discount.customerName
        }

        return customerMap
      }, customers.reduce<Record<number, string>>((customerMap, customer) => {
        customerMap[customer.custCode] = customer.custName
        return customerMap
      }, {})),
    [customers, discounts],
  )

  const filteredDiscounts = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()

    return discounts.filter((discount) => {
      const customerName = customerNameByCode[discount.custCode] ?? ''
      const matchesSearch =
        !normalizedSearch ||
        String(discount.custCode).includes(normalizedSearch) ||
        customerName.toLowerCase().includes(normalizedSearch)
      const matchesCompCode =
        compCodeFilter === ALL_FILTER_VALUE ||
        String(discount.compCode) === compCodeFilter

      return matchesSearch && matchesCompCode
    })
  }, [compCodeFilter, customerNameByCode, discounts, searchTerm])

  const addDiscount = () => {
    if (editingDiscountId !== null) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const newDiscount: CustomerDiscount = {
      id: -Date.now(),
      effDate: new Date().toISOString().slice(0, 10),
      custCode: 0,
      customerName: '',
      hlPer: Number.NaN,
      haloPer: Number.NaN,
      incdPer: Number.NaN,
      wiperPer: Number.NaN,
      gstPer: Number.NaN,
      compCode: Number.NaN,
      isActive: true,
      createdAt: '',
      updatedAt: '',
    }

    setDiscounts((currentDiscounts) => [newDiscount, ...currentDiscounts])
    setEditingDiscountId(newDiscount.id)
    setEditingOriginalDiscount(null)
    setErrorMessage('')
    setStatusMessage('New customer discount row added')
  }

  const updateDiscount = <Key extends keyof CustomerDiscount>(
    discountId: number,
    field: Key,
    value: CustomerDiscount[Key],
  ) => {
    setDiscounts((currentDiscounts) =>
      currentDiscounts.map((discount) =>
        discount.id === discountId
          ? { ...discount, [field]: value }
          : discount,
      ),
    )
  }

  const updateNumberField = (
    discountId: number,
    field: PercentDiscountField | 'compCode',
    value: string,
  ) => {
    updateDiscount(discountId, field, parseOptionalNumber(value))
  }

  const updateCustomerField = (discountId: number, value: string) => {
    const custCode = parseNumber(value)

    setDiscounts((currentDiscounts) =>
      currentDiscounts.map((discount) =>
        discount.id === discountId
          ? {
              ...discount,
              custCode,
              customerName: customerNameByCode[custCode] ?? '',
            }
          : discount,
      ),
    )
  }

  const editDiscount = (discountId: number) => {
    if (editingDiscountId !== null && editingDiscountId !== discountId) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const discount = discounts.find((item) => item.id === discountId)

    setEditingDiscountId(discountId)
    setEditingOriginalDiscount(discount ? { ...discount } : null)
    setErrorMessage('')
    setStatusMessage('Editing customer discount details')
  }

  const validateDiscountBeforeSave = (discount: CustomerDiscount) => {
    const percentageValues = [
      discount.hlPer,
      discount.haloPer,
      discount.incdPer,
      discount.wiperPer,
      discount.gstPer,
    ]

    if (!discount.effDate || !discount.custCode || !discount.compCode) {
      return 'Effective date, customer, and company code are required.'
    }

    if (
      percentageValues.some(
        (value) => !Number.isFinite(value) || value < 0 || value > 100,
      )
    ) {
      return 'Percentages must be between 0 and 100.'
    }

    return ''
  }

  const saveDiscount = async () => {
    if (editingDiscountId === null) {
      return
    }

    const discount = discounts.find((item) => item.id === editingDiscountId)

    if (!discount) {
      return
    }

    const validationError = validateDiscountBeforeSave(discount)

    if (validationError) {
      setErrorMessage(validationError)
      setStatusMessage('Save failed')
      setDiscountPopup({ message: validationError, mode: 'alert' })
      return
    }

    const isNewDiscount = editingOriginalDiscount === null || discount.id < 0

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        isNewDiscount
          ? CUSTOMER_DISCOUNT_API_URL
          : `${CUSTOMER_DISCOUNT_API_URL}/${discount.id}`,
        {
          body: JSON.stringify(discount),
          headers: { 'Content-Type': 'application/json' },
          method: isNewDiscount ? 'POST' : 'PUT',
        },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const savedDiscount = (await response.json()) as CustomerDiscount

      setDiscounts((currentDiscounts) =>
        isNewDiscount
          ? [
              savedDiscount,
              ...currentDiscounts.filter((item) => item.id !== discount.id),
            ]
          : currentDiscounts.map((currentDiscount) =>
              currentDiscount.id === savedDiscount.id
                ? savedDiscount
                : currentDiscount,
            ),
      )
      setEditingDiscountId(null)
      setEditingOriginalDiscount(null)

      const savedCustomerName =
        savedDiscount.customerName ||
        customerNameByCode[savedDiscount.custCode] ||
        `customer code ${savedDiscount.custCode}`
      const successMessage = isNewDiscount
        ? `Customer discount for ${savedCustomerName} saved successfully.`
        : `Customer discount for ${savedCustomerName} updated successfully.`

      setStatusMessage(
        isNewDiscount
          ? 'Customer discount saved to PostgreSQL'
          : 'Customer discount updated in PostgreSQL',
      )
      setDiscountPopup({ message: successMessage, mode: 'alert' })
    } catch (error) {
      const saveErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to save customer discount in backend.'

      setErrorMessage(saveErrorMessage)
      setStatusMessage('Save failed')
      setDiscountPopup({ message: saveErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const cancelDiscount = () => {
    if (editingDiscountId === null) {
      return
    }

    if (editingOriginalDiscount) {
      setDiscounts((currentDiscounts) =>
        currentDiscounts.map((discount) =>
          discount.id === editingOriginalDiscount.id
            ? editingOriginalDiscount
            : discount,
        ),
      )
    } else {
      setDiscounts((currentDiscounts) =>
        currentDiscounts.filter((discount) => discount.id !== editingDiscountId),
      )
    }

    setEditingDiscountId(null)
    setEditingOriginalDiscount(null)
    setErrorMessage('')
    setStatusMessage('Customer discount edit cancelled')
  }

  const confirmDeleteDiscount = (discountId: number) => {
    const discount = discounts.find((item) => item.id === discountId)
    const customerName = discount
      ? customerNameByCode[discount.custCode]
      : 'this row'

    setDiscountPopup({
      discountId,
      message: `Delete customer discount for ${customerName || 'this row'}?`,
      mode: 'confirm-delete',
    })
  }

  const deleteDiscount = async (discountId: number) => {
    const discount = discounts.find((item) => item.id === discountId)
    const customerName = discount
      ? customerNameByCode[discount.custCode] || `customer code ${discount.custCode}`
      : 'this row'

    if (discountId < 0) {
      setDiscounts((currentDiscounts) =>
        currentDiscounts.filter((discount) => discount.id !== discountId),
      )
      setEditingDiscountId(null)
      setEditingOriginalDiscount(null)
      setStatusMessage('New customer discount row deleted')
      setDiscountPopup({
        message: `Customer discount for ${customerName} deleted successfully.`,
        mode: 'alert',
      })
      return
    }

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        `${CUSTOMER_DISCOUNT_API_URL}/${discountId}`,
        { method: 'DELETE' },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      setDiscounts((currentDiscounts) =>
        currentDiscounts.filter((discount) => discount.id !== discountId),
      )
      if (editingDiscountId === discountId) {
        setEditingDiscountId(null)
        setEditingOriginalDiscount(null)
      }
      setStatusMessage('Customer discount deleted from PostgreSQL')
      setDiscountPopup({
        message: `Customer discount for ${customerName} deleted successfully.`,
        mode: 'alert',
      })
    } catch (error) {
      const deleteErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to delete customer discount from backend.'

      setErrorMessage(deleteErrorMessage)
      setStatusMessage('Delete failed')
      setDiscountPopup({ message: deleteErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const renderSelectedDiscountForm = () => {
    if (!selectedDiscount) {
      return null
    }

    const selectedCustomerName =
      customerNameByCode[selectedDiscount.custCode] || 'New Discount'
    const isEditingExistingDiscount = editingOriginalDiscount !== null

    return (
      <section className="panel customer-edit-panel discount-edit-panel">
        <div className="customer-tab-actions">
          <div>
            <p className="eyebrow">
              {editingOriginalDiscount ? 'Edit discount' : 'Add discount'}
            </p>
            <h2>{selectedCustomerName}</h2>
          </div>
          <div className="table-actions">
            <Button
              disabled={isSaving}
              onClick={saveDiscount}
              variant="secondary"
            >
              {isSaving ? 'Saving' : 'Save'}
            </Button>
            <Button disabled={isSaving} onClick={cancelDiscount} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => confirmDeleteDiscount(selectedDiscount.id)}
              variant="danger"
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="customer-form-grid discount-form-grid">
          <label className="field discount-field-date">
            <span className="field-label">Effective Date</span>
            <input
              className="field-control"
              disabled={isSaving || isEditingExistingDiscount}
              onChange={(event) =>
                updateDiscount(
                  selectedDiscount.id,
                  'effDate',
                  event.target.value,
                )
              }
              type="date"
              value={selectedDiscount.effDate}
            />
          </label>
          <label className="field discount-field-customer">
            <span className="field-label">Customer Name</span>
            <select
              className="field-control select-control"
              disabled={isSaving || isEditingExistingDiscount}
              onChange={(event) =>
                updateCustomerField(selectedDiscount.id, event.target.value)
              }
              value={
                selectedDiscount.custCode > 0
                  ? String(selectedDiscount.custCode)
                  : ''
              }
            >
              {customerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field discount-field-cust-code">
            <span className="field-label">Customer Code</span>
            <input
              className="field-control"
              readOnly
              value={selectedDiscount.custCode > 0 ? selectedDiscount.custCode : ''}
            />
          </label>
          <label className="field discount-field-hl">
            <span className="field-label">HL (%)</span>
            <input
              className="field-control"
              disabled={isSaving}
              max="100"
              min="0"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'hlPer',
                  event.target.value,
                )
              }
              step="0.01"
              type="number"
              value={getNumberInputValue(selectedDiscount.hlPer)}
            />
          </label>
          <label className="field discount-field-bulb">
            <span className="field-label">Bulb (%)</span>
            <input
              className="field-control"
              disabled={isSaving}
              max="100"
              min="0"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'haloPer',
                  event.target.value,
                )
              }
              step="0.01"
              type="number"
              value={getNumberInputValue(selectedDiscount.haloPer)}
            />
          </label>
          <label className="field discount-field-incd">
            <span className="field-label">Incd (%)</span>
            <input
              className="field-control"
              disabled={isSaving}
              max="100"
              min="0"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'incdPer',
                  event.target.value,
                )
              }
              step="0.01"
              type="number"
              value={getNumberInputValue(selectedDiscount.incdPer)}
            />
          </label>
          <label className="field discount-field-wiper">
            <span className="field-label">Wiper (%)</span>
            <input
              className="field-control"
              disabled={isSaving}
              max="100"
              min="0"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'wiperPer',
                  event.target.value,
                )
              }
              step="0.01"
              type="number"
              value={getNumberInputValue(selectedDiscount.wiperPer)}
            />
          </label>
          <label className="field discount-field-company">
            <span className="field-label">Company Code</span>
            <input
              className="field-control"
              disabled={isSaving || isEditingExistingDiscount}
              min="1"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'compCode',
                  event.target.value,
                )
              }
              step="1"
              type="number"
              value={getNumberInputValue(selectedDiscount.compCode)}
            />
          </label>
          <label className="field discount-field-gst">
            <span className="field-label">GST (%)</span>
            <input
              className="field-control"
              disabled={isSaving}
              max="100"
              min="0"
              onChange={(event) =>
                updateNumberField(
                  selectedDiscount.id,
                  'gstPer',
                  event.target.value,
                )
              }
              step="0.01"
              type="number"
              value={getNumberInputValue(selectedDiscount.gstPer)}
            />
          </label>
        </div>
      </section>
    )
  }

  const averageHlDiscount = average(discounts.map((discount) => discount.hlPer))
  const averageHaloDiscount = average(
    discounts.map((discount) => discount.haloPer),
  )
  const activeCustomers = new Set(
    discounts
      .map((discount) => discount.custCode)
      .filter((custCode) => Number.isInteger(custCode) && custCode > 0),
  )
  const activeCompanyCodes = new Set(
    discounts
      .map((discount) => discount.compCode)
      .filter((compCode) => Number.isInteger(compCode) && compCode > 0),
  )

  return (
    <div className="page">
      {discountPopup ? (
        <div
          aria-labelledby="discount-popup-title"
          aria-modal="true"
          className="autopal-alert-backdrop"
          role="dialog"
        >
          <div className="autopal-alert">
            <h2 id="discount-popup-title">Autopal</h2>
            <p>{discountPopup.message}</p>
            <div className="autopal-alert-actions">
              {discountPopup.mode === 'confirm-delete' ? (
                <>
                  <Button
                    disabled={isSaving}
                    onClick={() => void deleteDiscount(discountPopup.discountId)}
                    variant="danger"
                  >
                    Yes
                  </Button>
                  <Button
                    disabled={isSaving}
                    onClick={() => setDiscountPopup(null)}
                    variant="ghost"
                  >
                    No
                  </Button>
                </>
              ) : (
                <Button onClick={() => setDiscountPopup(null)}>OK</Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <header className="page-header">
        <div>
          <p className="eyebrow">Master data</p>
          <h1>Customer Discount Master</h1>
          <p className="page-subtitle">
            Customer-wise discount percentages for table master_cust_discount.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">{statusMessage}</span>
          <Button disabled={isLoading || isSaving} onClick={addDiscount}>
            <span className="btn-symbol">+</span>
            Add
          </Button>
        </div>
      </header>

      <section className="summary-strip discount-summary">
        <div>
          <span>Total records</span>
          <strong>{discounts.length}</strong>
        </div>
        <div>
          <span>Active customers</span>
          <strong>{activeCustomers.size}</strong>
        </div>
        <div>
          <span>Avg HL discount</span>
          <strong>{formatPercent(averageHlDiscount)}</strong>
        </div>
        <div>
          <span>Avg Bulb discount</span>
          <strong>{formatPercent(averageHaloDiscount)}</strong>
          <p>{activeCompanyCodes.size} company codes</p>
        </div>
      </section>

      {!selectedDiscount ? (
        <section className="panel discount-master-controls">
          <InputField
            label="Search"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Customer name or code"
            value={searchTerm}
          />
          <SelectField
            label="Company Code"
            onChange={(event) => setCompCodeFilter(event.target.value)}
            options={compCodeOptions}
            value={compCodeFilter}
          />
        </section>
      ) : null}

      {renderSelectedDiscountForm()}

      {!selectedDiscount ? (
        <section className="panel">
          <div className="responsive-table">
            <table className="master-table discount-master-table">
              <thead>
                <tr>
                  <th>EFF_DATE</th>
                  <th className="discount-six-digit-col">CUST_CODE</th>
                  <th>Customer Name</th>
                  <th className="discount-six-digit-col">HL (%)</th>
                  <th className="discount-six-digit-col">Bulb (%)</th>
                  <th className="discount-six-digit-col">Incd (%)</th>
                  <th className="discount-six-digit-col">Wiper (%)</th>
                  <th className="discount-six-digit-col">GST (%)</th>
                  <th className="discount-six-digit-col">COMP_CODE</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDiscounts.length === 0 ? (
                  <tr>
                    <td colSpan={10}>
                      <div className="empty-state">
                        <p className="eyebrow">Customer discounts</p>
                        <h2>
                          {isLoading
                            ? 'Loading discount records...'
                            : 'No discount records found'}
                        </h2>
                        <p>
                          {isLoading
                            ? 'Fetching master_cust_discount from PostgreSQL.'
                            : errorMessage ||
                              'Change the search or add a new discount row.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredDiscounts.map((discount) => (
                    <tr key={discount.id}>
                      <td>{formatDate(discount.effDate)}</td>
                      <td className="discount-six-digit-col">
                        <strong>{discount.custCode || '-'}</strong>
                      </td>
                      <td>
                        {customerNameByCode[discount.custCode] ||
                          'Customer not found'}
                      </td>
                      <td className="discount-six-digit-col">
                        {formatPercent(discount.hlPer)}
                      </td>
                      <td className="discount-six-digit-col">
                        {formatPercent(discount.haloPer)}
                      </td>
                      <td className="discount-six-digit-col">
                        {formatPercent(discount.incdPer)}
                      </td>
                      <td className="discount-six-digit-col">
                        {formatPercent(discount.wiperPer)}
                      </td>
                      <td className="discount-six-digit-col">
                        {formatPercent(discount.gstPer)}
                      </td>
                      <td className="discount-six-digit-col">
                        {Number.isFinite(discount.compCode)
                          ? discount.compCode
                          : '-'}
                      </td>
                      <td>
                        <div className="table-actions discount-table-actions">
                          <Button
                            disabled={isSaving}
                            onClick={() => editDiscount(discount.id)}
                            variant="ghost"
                          >
                            Edit
                          </Button>
                          <Button
                            disabled={isSaving}
                            onClick={() => confirmDeleteDiscount(discount.id)}
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
          {errorMessage && discounts.length > 0 ? (
            <p className="form-helper">{errorMessage}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import { InputField, SelectField } from '../components/ui/Field'
import {
  products as mockProducts,
  tradingProductRates as mockTradingProductRates,
} from '../data/mockData'
import { apiUrl } from '../config/api'
import type { FieldOption, Product, TradingProductRate } from '../types'
import { formatCurrency, parseNumber } from '../utils/calculations'

const ALL_FILTER_VALUE = 'all'
const PRODUCT_MASTER_API_URL = apiUrl('/api/master-products')
const TRADING_RATE_API_URL = apiUrl('/api/master-trading-product-rates')

type TextRateField =
  | 'effDate'
  | 'productCode'
  | 'unitName'
  | 'family'
  | 'cpno'
  | 'plantName'
  | 'catDesc'

type NumericRateField =
  | 'wRate'
  | 'swRate'
  | 'rRate'
  | 'iRate'
  | 'oth1Rate'
  | 'oth2Rate'
  | 'disAmt'
  | 'mrp'
  | 'stdPkg'
  | 'minStkQty'
  | 'dispMrp'
  | 'basicRate'
  | 'compCode'

type RatePopup =
  | {
      message: string
      mode: 'alert'
    }
  | {
      message: string
      mode: 'confirm-delete'
      rateId: TradingProductRate['id']
    }

const buildFilterOptions = (
  values: string[],
  allLabel: string,
): FieldOption[] => [
  { value: ALL_FILTER_VALUE, label: allLabel },
  ...Array.from(new Set(values.filter(Boolean)))
    .sort()
    .map((value) => ({ value, label: value })),
]

const formatDate = (value: string) => {
  if (!value) {
    return '-'
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

const formatNumber = (value: number) =>
  new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)

const average = (values: number[]) => {
  if (values.length === 0) {
    return 0
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const buildProductDescriptionMap = (products: Product[]) =>
  products.reduce<Record<string, string>>((descriptionMap, product) => {
    descriptionMap[product.code.toLowerCase()] = product.description
    return descriptionMap
  }, {})

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

export function RMarketProductRateMaster() {
  const [rates, setRates] = useState<TradingProductRate[]>([])
  const [productMasterProducts, setProductMasterProducts] =
    useState<Product[]>(mockProducts)
  const [productDescriptionByCode, setProductDescriptionByCode] = useState<
    Record<string, string>
  >(() => buildProductDescriptionMap(mockProducts))
  const [editingRateId, setEditingRateId] = useState<
    TradingProductRate['id'] | null
  >(null)
  const [editingOriginalRate, setEditingOriginalRate] =
    useState<TradingProductRate | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [plantFilter, setPlantFilter] = useState(ALL_FILTER_VALUE)
  const [familyFilter, setFamilyFilter] = useState(ALL_FILTER_VALUE)
  const [statusMessage, setStatusMessage] = useState(
    'Loading R.Market rates from PostgreSQL',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [ratePopup, setRatePopup] = useState<RatePopup | null>(null)

  useEffect(() => {
    const loadMasterData = async () => {
      let productDescriptionsLoaded = false

      setIsLoading(true)
      setErrorMessage('')

      try {
        const response = await fetch(PRODUCT_MASTER_API_URL)

        if (!response.ok) {
          throw new Error('Unable to fetch product descriptions')
        }

        const products = (await response.json()) as Product[]
        setProductMasterProducts(products)
        setProductDescriptionByCode(buildProductDescriptionMap(products))
        productDescriptionsLoaded = true
      } catch {
        setProductMasterProducts(mockProducts)
        setProductDescriptionByCode(buildProductDescriptionMap(mockProducts))
      }

      try {
        const response = await fetch(TRADING_RATE_API_URL)

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response))
        }

        const apiRates = (await response.json()) as TradingProductRate[]

        setRates(apiRates)
        setStatusMessage(
          productDescriptionsLoaded
            ? `${apiRates.length} R.Market rates loaded`
            : `${apiRates.length} R.Market rates loaded; mock descriptions`,
        )
      } catch (error) {
        setRates(mockTradingProductRates)
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load R.Market rates from backend.',
        )
        setStatusMessage('Using mock R.Market rates')
      } finally {
        setIsLoading(false)
      }
    }

    void loadMasterData()
  }, [])

  const plantOptions = useMemo(
    () => buildFilterOptions(rates.map((rate) => rate.plantName), 'All plants'),
    [rates],
  )
  const familyOptions = useMemo(
    () => buildFilterOptions(rates.map((rate) => rate.family), 'All families'),
    [rates],
  )
  const productCodeOptions = useMemo(() => {
    const productOptions = productMasterProducts.map((product) => ({
      value: product.code,
      label: `${product.code} - ${product.description}`,
    }))
    const optionCodes = new Set(productOptions.map((option) => option.value))
    const missingRateProductOptions = rates
      .filter((rate) => rate.productCode && !optionCodes.has(rate.productCode))
      .map((rate) => ({
        value: rate.productCode,
        label: `${rate.productCode} - not found in Product Master`,
      }))

    return [
      { value: '', label: 'Select product code' },
      ...productOptions,
      ...missingRateProductOptions,
    ]
  }, [productMasterProducts, rates])

  const filteredRates = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()

    return rates.filter((rate) => {
      const productDescription =
        productDescriptionByCode[rate.productCode.toLowerCase()] ?? ''
      const matchesSearch =
        !normalizedSearch ||
        [
          rate.productCode,
          productDescription,
          rate.cpno,
          rate.catDesc,
          rate.family,
          rate.plantName,
        ].some((value) => value.toLowerCase().includes(normalizedSearch))
      const matchesPlant =
        plantFilter === ALL_FILTER_VALUE || rate.plantName === plantFilter
      const matchesFamily =
        familyFilter === ALL_FILTER_VALUE || rate.family === familyFilter

      return matchesSearch && matchesPlant && matchesFamily
    })
  }, [familyFilter, plantFilter, productDescriptionByCode, rates, searchTerm])

  const selectedRate = useMemo(
    () =>
      editingRateId === null
        ? null
        : rates.find((rate) => rate.id === editingRateId) ?? null,
    [editingRateId, rates],
  )

  const addRate = () => {
    if (editingRateId) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const newRate: TradingProductRate = {
      id: -Date.now(),
      effDate: new Date().toISOString().slice(0, 10),
      productCode: '',
      wRate: 0,
      swRate: 0,
      rRate: 0,
      iRate: 0,
      oth1Rate: 0,
      oth2Rate: 0,
      disAmt: 0,
      unitName: 'NOS',
      family: '',
      mrp: 0,
      stdPkg: 0,
      cpno: '',
      minStkQty: 0,
      dispMrp: 0,
      basicRate: 0,
      plantName: '',
      catDesc: '',
      compCode: 1,
    }

    setRates((currentRates) => [newRate, ...currentRates])
    setEditingRateId(newRate.id)
    setEditingOriginalRate(null)
    setErrorMessage('')
    setStatusMessage('New R.Market rate row added')
  }

  const updateRate = <Key extends keyof TradingProductRate>(
    rateId: TradingProductRate['id'],
    field: Key,
    value: TradingProductRate[Key],
  ) => {
    setRates((currentRates) =>
      currentRates.map((rate) =>
        rate.id === rateId ? { ...rate, [field]: value } : rate,
      ),
    )
  }

  const updateTextField = (
    rateId: TradingProductRate['id'],
    field: TextRateField,
    value: string,
  ) => {
    updateRate(rateId, field, value)
  }

  const updateProductCode = (
    rateId: TradingProductRate['id'],
    productCode: string,
  ) => {
    const selectedProduct = productMasterProducts.find(
      (product) => product.code === productCode,
    )

    setRates((currentRates) =>
      currentRates.map((rate) =>
        rate.id === rateId
          ? {
              ...rate,
              productCode,
              catDesc: selectedProduct?.category ?? rate.catDesc,
              family: selectedProduct?.category ?? rate.family,
              unitName: selectedProduct?.unit ?? rate.unitName,
            }
          : rate,
      ),
    )
  }

  const updateNumberField = (
    rateId: TradingProductRate['id'],
    field: NumericRateField,
    value: string,
  ) => {
    updateRate(rateId, field, parseNumber(value))
  }

  const editRate = (rateId: TradingProductRate['id']) => {
    if (editingRateId && editingRateId !== rateId) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const rate = rates.find((item) => item.id === rateId)

    setEditingRateId(rateId)
    setEditingOriginalRate(rate ? { ...rate } : null)
    setErrorMessage('')
    setStatusMessage('Editing R.Market rate details')
  }

  const saveRate = async () => {
    if (!editingRateId) {
      return
    }

    const rate = rates.find((item) => item.id === editingRateId)

    if (!rate) {
      return
    }

    if (!rate.productCode || !rate.unitName || !rate.plantName || !rate.catDesc) {
      const validationMessage =
        'Product code, unit, plant, and category are required.'

      setErrorMessage(validationMessage)
      setStatusMessage('Save failed')
      setRatePopup({ message: validationMessage, mode: 'alert' })
      return
    }

    const isNewRate = rate.id < 0

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        isNewRate ? TRADING_RATE_API_URL : `${TRADING_RATE_API_URL}/${rate.id}`,
        {
          body: JSON.stringify(rate),
          headers: {
            'Content-Type': 'application/json',
          },
          method: isNewRate ? 'POST' : 'PUT',
        },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const savedRate = (await response.json()) as TradingProductRate

      setRates((currentRates) =>
        isNewRate
          ? [
              savedRate,
              ...currentRates.filter((rateItem) => rateItem.id !== rate.id),
            ]
          : currentRates.map((rateItem) =>
              rateItem.id === savedRate.id ? savedRate : rateItem,
            ),
      )
      setEditingRateId(null)
      setEditingOriginalRate(null)
      const rateLabel = savedRate.productCode || `rate ${savedRate.id}`
      const successMessage = isNewRate
        ? `R.Market rate ${rateLabel} saved successfully.`
        : `R.Market rate ${rateLabel} updated successfully.`

      setStatusMessage(
        isNewRate
          ? 'R.Market rate saved to PostgreSQL'
          : 'R.Market rate updated in PostgreSQL',
      )
      setRatePopup({ message: successMessage, mode: 'alert' })
    } catch (error) {
      const saveErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to save R.Market rate in backend.'

      setErrorMessage(saveErrorMessage)
      setStatusMessage('Save failed')
      setRatePopup({ message: saveErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const cancelRate = () => {
    if (!editingRateId) {
      return
    }

    if (editingOriginalRate) {
      setRates((currentRates) =>
        currentRates.map((rate) =>
          rate.id === editingOriginalRate.id ? editingOriginalRate : rate,
        ),
      )
    } else {
      setRates((currentRates) =>
        currentRates.filter((rate) => rate.id !== editingRateId),
      )
    }

    setEditingRateId(null)
    setEditingOriginalRate(null)
    setErrorMessage('')
    setStatusMessage('R.Market rate edit cancelled')
  }

  const confirmDeleteRate = (rateId: TradingProductRate['id']) => {
    const rate = rates.find((item) => item.id === rateId)

    setRatePopup({
      message: `Delete R.Market rate ${rate?.productCode || rateId}?`,
      mode: 'confirm-delete',
      rateId,
    })
  }

  const deleteRate = async (rateId: TradingProductRate['id']) => {
    const rate = rates.find((item) => item.id === rateId)
    const rateLabel = rate?.productCode || `rate ${rateId}`

    if (rateId < 0) {
      setRates((currentRates) =>
        currentRates.filter((rateItem) => rateItem.id !== rateId),
      )
      setEditingRateId(null)
      setEditingOriginalRate(null)
      setStatusMessage('New R.Market rate row deleted')
      setRatePopup({
        message: `R.Market rate ${rateLabel} deleted successfully.`,
        mode: 'alert',
      })
      return
    }

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(`${TRADING_RATE_API_URL}/${rateId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      setRates((currentRates) =>
        currentRates.filter((rateItem) => rateItem.id !== rateId),
      )
      if (editingRateId === rateId) {
        setEditingRateId(null)
        setEditingOriginalRate(null)
      }
      setStatusMessage('R.Market rate deleted from PostgreSQL')
      setRatePopup({
        message: `R.Market rate ${rateLabel} deleted successfully.`,
        mode: 'alert',
      })
    } catch (error) {
      const deleteErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to delete R.Market rate from backend.'

      setErrorMessage(deleteErrorMessage)
      setStatusMessage('Delete failed')
      setRatePopup({ message: deleteErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const getProductDescription = (productCode: string) =>
    productDescriptionByCode[productCode.toLowerCase()] ||
    'Description not found'

  const renderSelectedRateForm = () => {
    if (!selectedRate) {
      return null
    }

    const renderTextInput = (
      label: string,
      field: TextRateField,
      type = 'text',
      className = '',
    ) => (
      <label className={`field ${className}`.trim()}>
        <span className="field-label">{label}</span>
        <input
          className="field-control"
          onChange={(event) =>
            updateTextField(selectedRate.id, field, event.target.value)
          }
          type={type}
          value={selectedRate[field]}
        />
      </label>
    )

    const renderNumberInput = (
      label: string,
      field: NumericRateField,
      integer = false,
    ) => (
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          className="field-control"
          min="0"
          onChange={(event) =>
            updateNumberField(selectedRate.id, field, event.target.value)
          }
          step={integer ? '1' : '0.01'}
          type="number"
          value={selectedRate[field]}
        />
      </label>
    )

    return (
      <section className="panel customer-edit-panel rate-edit-panel">
        <div className="customer-tab-actions">
          <div>
            <p className="eyebrow">
              {editingOriginalRate ? 'Edit R.Market rate' : 'Add R.Market rate'}
            </p>
            <h2>{selectedRate.productCode || 'New R.Market Rate'}</h2>
          </div>
          <div className="table-actions">
            <Button disabled={isSaving} onClick={saveRate} variant="secondary">
              {isSaving ? 'Saving' : 'Save'}
            </Button>
            <Button disabled={isSaving} onClick={cancelRate} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => confirmDeleteRate(selectedRate.id)}
              variant="danger"
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="customer-form-grid rate-form-grid">
          {renderTextInput('Effective Date', 'effDate', 'date')}
          <label className="field rate-form-span-2">
            <span className="field-label">Product Code</span>
            <select
              className="field-control select-control"
              onChange={(event) =>
                updateProductCode(selectedRate.id, event.target.value)
              }
              value={selectedRate.productCode}
            >
              {productCodeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field rate-form-span-2">
            <span className="field-label">Product Description</span>
            <input
              className="field-control"
              readOnly
              value={getProductDescription(selectedRate.productCode)}
            />
          </label>
          {renderTextInput('Unit Name', 'unitName')}
          {renderTextInput('Family', 'family')}
          {renderTextInput('CPNO', 'cpno')}
          {renderTextInput('Plant Name', 'plantName')}
          {renderTextInput('Category Description', 'catDesc', 'text', 'rate-form-span-2')}
          {renderNumberInput('Company Code', 'compCode', true)}
          {renderNumberInput('W Rate', 'wRate')}
          {renderNumberInput('SW Rate', 'swRate')}
          {renderNumberInput('R Rate', 'rRate')}
          {renderNumberInput('I Rate', 'iRate')}
          {renderNumberInput('OTH1 Rate', 'oth1Rate')}
          {renderNumberInput('OTH2 Rate', 'oth2Rate')}
          {renderNumberInput('Discount Amount', 'disAmt')}
          {renderNumberInput('MRP', 'mrp')}
          {renderNumberInput('Standard Package', 'stdPkg', true)}
          {renderNumberInput('Minimum Stock Qty', 'minStkQty', true)}
          {renderNumberInput('Display MRP', 'dispMrp')}
          {renderNumberInput('Basic Rate', 'basicRate')}
        </div>
      </section>
    )
  }

  const activePlants = new Set(rates.map((rate) => rate.plantName).filter(Boolean))
  const averageMrp = average(rates.map((rate) => rate.mrp))
  const retailRates = rates.map((rate) => rate.rRate)
  const lowestRetailRate = retailRates.length ? Math.min(...retailRates) : 0
  const highestRetailRate = retailRates.length ? Math.max(...retailRates) : 0

  return (
    <div className="page">
      {ratePopup ? (
        <div
          aria-labelledby="rate-popup-title"
          aria-modal="true"
          className="autopal-alert-backdrop"
          role="dialog"
        >
          <div className="autopal-alert">
            <h2 id="rate-popup-title">Autopal</h2>
            <p>{ratePopup.message}</p>
            <div className="autopal-alert-actions">
              {ratePopup.mode === 'confirm-delete' ? (
                <>
                  <Button
                    disabled={isSaving}
                    onClick={() => void deleteRate(ratePopup.rateId)}
                    variant="danger"
                  >
                    Yes
                  </Button>
                  <Button
                    disabled={isSaving}
                    onClick={() => setRatePopup(null)}
                    variant="ghost"
                  >
                    No
                  </Button>
                </>
              ) : (
                <Button onClick={() => setRatePopup(null)}>OK</Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <header className="page-header">
        <div>
          <p className="eyebrow">Master data</p>
          <h1>R.Market Product Rate Master</h1>
          <p className="page-subtitle">
            Trading product rate records for table master_trading_product_rate.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">{statusMessage}</span>
          <Button disabled={isLoading || isSaving} onClick={addRate}>
            <span className="btn-symbol">+</span>
            Add
          </Button>
        </div>
      </header>

      <section className="summary-strip rate-summary">
        <div>
          <span>Total records</span>
          <strong>{rates.length}</strong>
        </div>
        <div>
          <span>Filtered records</span>
          <strong>{filteredRates.length}</strong>
        </div>
        <div>
          <span>Average MRP</span>
          <strong>{formatCurrency(averageMrp, 'INR')}</strong>
        </div>
        <div>
          <span>Retail range</span>
          <strong>
            {formatCurrency(lowestRetailRate, 'INR')} -{' '}
            {formatCurrency(highestRetailRate, 'INR')}
          </strong>
          <p>{activePlants.size} active plants</p>
        </div>
      </section>

      {!selectedRate ? (
        <section className="panel rate-master-controls">
          <InputField
            label="Search"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Product code, CPNO, category"
            value={searchTerm}
          />
          <SelectField
            label="Plant"
            onChange={(event) => setPlantFilter(event.target.value)}
            options={plantOptions}
            value={plantFilter}
          />
          <SelectField
            label="Family"
            onChange={(event) => setFamilyFilter(event.target.value)}
            options={familyOptions}
            value={familyFilter}
          />
        </section>
      ) : null}

      {renderSelectedRateForm()}

      {!selectedRate ? (
        <section className="panel">
          <div className="responsive-table">
            <table className="master-table rate-master-table">
              <thead>
                <tr>
                  <th>EFF_DATE</th>
                  <th>PRODUCT_CODE</th>
                  <th>PRODUCT_DESCRIPTION</th>
                  <th>W_RATE</th>
                  <th>SW_RATE</th>
                  <th>R_RATE</th>
                  <th>I_RATE</th>
                  <th>OTH1_RATE</th>
                  <th>OTH2_RATE</th>
                  <th>DIS_AMT</th>
                  <th>FAMILY</th>
                  <th>MRP</th>
                  <th>STD_PKG</th>
                  <th>CPNO</th>
                  <th>MIN_STK_QTY</th>
                  <th>disp_mrp</th>
                  <th>basic_rate</th>
                  <th>PLANT_NAME</th>
                  <th>CAT_DESC</th>
                  <th>comp_code</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRates.length === 0 ? (
                  <tr>
                    <td colSpan={21}>
                      <div className="empty-state">
                        <p className="eyebrow">R.Market rates</p>
                        <h2>
                          {isLoading
                            ? 'Loading rate records...'
                            : 'No rate records found'}
                        </h2>
                        <p>
                          {isLoading
                            ? 'Fetching master_trading_product_rate from PostgreSQL.'
                            : errorMessage ||
                              'Change the search or add a new product rate row.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredRates.map((rate) => (
                    <tr key={rate.id}>
                      <td>{formatDate(rate.effDate)}</td>
                      <td>
                        <strong>{rate.productCode || '-'}</strong>
                      </td>
                      <td>{getProductDescription(rate.productCode)}</td>
                      <td>{formatCurrency(rate.wRate, 'INR')}</td>
                      <td>{formatCurrency(rate.swRate, 'INR')}</td>
                      <td>{formatCurrency(rate.rRate, 'INR')}</td>
                      <td>{formatCurrency(rate.iRate, 'INR')}</td>
                      <td>{formatCurrency(rate.oth1Rate, 'INR')}</td>
                      <td>{formatCurrency(rate.oth2Rate, 'INR')}</td>
                      <td>{formatCurrency(rate.disAmt, 'INR')}</td>
                      <td>{rate.family || '-'}</td>
                      <td>{formatCurrency(rate.mrp, 'INR')}</td>
                      <td>{formatNumber(rate.stdPkg)}</td>
                      <td>{rate.cpno || '-'}</td>
                      <td>{formatNumber(rate.minStkQty)}</td>
                      <td>{formatCurrency(rate.dispMrp, 'INR')}</td>
                      <td>{formatCurrency(rate.basicRate, 'INR')}</td>
                      <td>{rate.plantName || '-'}</td>
                      <td>{rate.catDesc || '-'}</td>
                      <td>{formatNumber(rate.compCode)}</td>
                      <td>
                        <div className="table-actions rate-table-actions">
                          <Button
                            disabled={isSaving}
                            onClick={() => editRate(rate.id)}
                            variant="ghost"
                          >
                            Edit
                          </Button>
                          <Button
                            disabled={isSaving}
                            onClick={() => confirmDeleteRate(rate.id)}
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
          {errorMessage && rates.length > 0 ? (
            <p className="form-helper">{errorMessage}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

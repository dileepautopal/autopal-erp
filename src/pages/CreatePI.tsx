import { useEffect, useMemo, useState } from 'react'
import { PIPreviewPanel } from '../components/pi/PIPreviewPanel'
import { Button } from '../components/ui/Button'
import { InputField, SelectField } from '../components/ui/Field'
import { apiUrl } from '../config/api'
import { createEmptyLineItem } from '../data/piDefaults'
import { formatCurrency, parseNumber } from '../utils/calculations'
import type {
  Customer,
  CustomerDiscount,
  Company,
  FieldOption,
  LineItem,
  MasterCustomer,
  MasterCustomerLookups,
  MasterLookupOption,
  PIFormState,
  Product,
  TradingProductRate,
} from '../types'

type CreatePIProps = {
  companies: Company[]
  form: PIFormState
  generatePINumber?: (companyId: string) => string
  onCancel?: () => void
  onFormChange: (form: PIFormState) => void
  onSaveDraft?: (form: PIFormState) => Promise<void> | void
}

type CreatePITab = 'prospective' | 'proforma' | 'products' | 'commercial'

type LineRowCalculation = {
  amount: number
  basic: number
  discountAmount: number
}

const CUSTOMER_API_URL = apiUrl('/api/master-customers')
const CUSTOMER_LOOKUP_API_URL = apiUrl('/api/master-customer-lookups')
const PRODUCT_API_URL = apiUrl('/api/master-products')
const TRADING_RATE_API_URL = apiUrl('/api/master-trading-product-rates')
const CUSTOMER_DISCOUNT_API_URL = apiUrl('/api/master-cust-discounts')
const PI_RMKT_API_URL = apiUrl('/api/master-pi-rmkt')

const emptyLookups: MasterCustomerLookups = {
  cities: [],
  countries: [],
  markets: [],
  partyTypes: [],
  states: [],
}

const proformaCloseOptions: FieldOption[] = [
  { value: 'No', label: 'No' },
  { value: 'Yes', label: 'Yes' },
]

const createPITabs: Array<{ id: CreatePITab; label: string }> = [
  { id: 'prospective', label: 'Prospective Customer' },
  { id: 'proforma', label: 'Proforma Details' },
  { id: 'products', label: 'Product Details' },
  { id: 'commercial', label: 'Commercial Details' },
]

const getApiErrorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as {
      detail?: string
      errors?: string[]
      message?: string
    }

    if (Array.isArray(body.errors) && body.errors.length > 0) {
      return body.errors.join(' ')
    }

    if (body.detail) {
      return body.detail
    }

    if (body.message) {
      return body.message
    }
  } catch {
    // Fall back to the HTTP status below.
  }

  return `Request failed with status ${response.status}`
}

const roundMoney = (value: number) => Math.round(value * 100) / 100

const toLookupOptions = (
  items: MasterLookupOption[],
  placeholder: string,
): FieldOption[] => [
  { value: '', label: placeholder },
  ...items.map((item) => ({
    value: String(item.code),
    label: item.name,
  })),
]

const getRateDateValue = (value: string) => {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

const normalizePartyType = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')

const normalizeCategory = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ')

const getTradingRateValue = (
  rate?: TradingProductRate,
  partyTypeName = '',
) => {
  if (!rate) {
    return 0
  }

  const partyType = normalizePartyType(partyTypeName)

  if (partyType.includes('intra') && partyType.includes('unit')) {
    return rate.iRate || rate.rRate || rate.basicRate || rate.wRate || 0
  }

  if (partyType.includes('retailer')) {
    return rate.rRate || rate.basicRate || rate.wRate || 0
  }

  if (
    partyType.includes('exe distribut') ||
    partyType.includes('executive distribut') ||
    partyType.includes('exclusive distribut') ||
    partyType.includes('ex distribut')
  ) {
    return rate.swRate || rate.wRate || rate.rRate || 0
  }

  if (partyType.includes('distribut')) {
    return rate.wRate || rate.swRate || rate.rRate || 0
  }

  return rate.rRate || rate.basicRate || rate.wRate || 0
}

const calculateLineRow = (line: LineItem): LineRowCalculation => {
  const amount = roundMoney(line.quantity * line.unitPrice)
  const discountAmount = roundMoney((amount * line.discountPercent) / 100)

  return {
    amount,
    basic: amount,
    discountAmount,
  }
}

const getTradingRateMrp = (
  rate?: TradingProductRate,
  partyTypeName = '',
) => {
  if (!rate) {
    return 0
  }

  return rate.mrp || rate.dispMrp || getTradingRateValue(rate, partyTypeName)
}

const getDiscountedRate = (mrp: number, discountPercent: number) =>
  roundMoney(mrp - (mrp * discountPercent) / 100)

const getCustomerDiscountPercent = (
  category: string,
  discount?: CustomerDiscount,
) => {
  if (!discount) {
    return 0
  }

  const normalizedCategory = normalizeCategory(category)

  if (
    normalizedCategory.includes('head lamp') ||
    normalizedCategory.includes('headlamp')
  ) {
    return discount.hlPer
  }

  if (
    normalizedCategory.includes('halogen bulb') ||
    normalizedCategory.includes('halogen bulbs')
  ) {
    return discount.haloPer
  }

  if (
    normalizedCategory.includes('incandescent') ||
    normalizedCategory.includes('incd')
  ) {
    return discount.incdPer
  }

  if (normalizedCategory.includes('wiper')) {
    return discount.wiperPer
  }

  return 0
}

const getCustomerDiscountForMasterCustomer = (
  customer: MasterCustomer | undefined,
  discounts: CustomerDiscount[],
  companyCode: number,
) => {
  if (!customer) {
    return undefined
  }

  const matchingDiscounts = discounts
    .filter(
      (discount) =>
        discount.custCode === customer.custCode &&
        discount.isActive,
    )
    .sort(
      (firstDiscount, secondDiscount) =>
        getRateDateValue(secondDiscount.effDate) -
        getRateDateValue(firstDiscount.effDate),
    )

  return (
    matchingDiscounts.find(
      (discount) => discount.compCode === companyCode,
    ) ?? matchingDiscounts[0]
  )
}

const toCustomerPreview = (
  form: PIFormState,
  masterCustomer?: MasterCustomer,
): Customer | undefined => {
  if (masterCustomer) {
    return {
      id: String(masterCustomer.customerId),
      name: masterCustomer.custName,
      country: masterCustomer.corrCountryName,
      currency: form.currency || 'INR',
      state: masterCustomer.corrStateName,
      stateCode: String(masterCustomer.corrStateCode),
      contactPerson: masterCustomer.contactPerson,
      email: masterCustomer.corrEmail,
      phone: masterCustomer.mobileNo || masterCustomer.corrTel,
      address: masterCustomer.corrAddress,
      placeOfSupply: masterCustomer.corrStateName,
      paymentTerms: form.paymentTerms,
      dispatchTerms: form.dispatchTerms,
      gstin: masterCustomer.gstinNo,
      pan: masterCustomer.panNo,
    }
  }

  if (form.prospectiveCustomerName) {
    return {
      id: form.customerId,
      name: form.prospectiveCustomerName,
      country: form.country,
      currency: form.currency || 'INR',
      state: form.customerState || form.prospectiveState,
      stateCode: '',
      contactPerson: form.prospectiveCustomerName,
      email: '',
      phone: form.prospectiveContactNo,
      address: form.prospectiveAddress,
      placeOfSupply: form.customerState || form.prospectiveState,
      paymentTerms: form.paymentTerms,
      dispatchTerms: form.dispatchTerms,
      gstin: form.prospectiveGstNo,
    }
  }

  return undefined
}

export function CreatePI({
  companies,
  form,
  generatePINumber,
  onCancel,
  onFormChange,
  onSaveDraft,
}: CreatePIProps) {
  const [message, setMessage] = useState('Draft autosync is disabled')
  const [activeTab, setActiveTab] = useState<CreatePITab>('prospective')
  const [masterCustomers, setMasterCustomers] = useState<MasterCustomer[]>([])
  const [lookups, setLookups] = useState<MasterCustomerLookups>(emptyLookups)
  const [productRows, setProductRows] = useState<Product[]>([])
  const [tradingRates, setTradingRates] = useState<TradingProductRate[]>([])
  const [customerDiscountRows, setCustomerDiscountRows] =
    useState<CustomerDiscount[]>([])
  const [isSavingPI, setIsSavingPI] = useState(false)

  useEffect(() => {
    const loadMasterData = async () => {
      try {
        const [
          customerResponse,
          lookupResponse,
          productResponse,
          tradingRateResponse,
          customerDiscountResponse,
        ] =
          await Promise.all([
            fetch(CUSTOMER_API_URL),
            fetch(CUSTOMER_LOOKUP_API_URL),
            fetch(PRODUCT_API_URL),
            fetch(TRADING_RATE_API_URL),
            fetch(CUSTOMER_DISCOUNT_API_URL),
          ])

        if (!customerResponse.ok) {
          throw new Error(await getApiErrorMessage(customerResponse))
        }

        if (!lookupResponse.ok) {
          throw new Error(await getApiErrorMessage(lookupResponse))
        }

        if (!productResponse.ok) {
          throw new Error(await getApiErrorMessage(productResponse))
        }

        if (!tradingRateResponse.ok) {
          throw new Error(await getApiErrorMessage(tradingRateResponse))
        }

        if (!customerDiscountResponse.ok) {
          throw new Error(await getApiErrorMessage(customerDiscountResponse))
        }

        setMasterCustomers((await customerResponse.json()) as MasterCustomer[])
        setLookups((await lookupResponse.json()) as MasterCustomerLookups)
        setProductRows((await productResponse.json()) as Product[])
        setTradingRates(
          (await tradingRateResponse.json()) as TradingProductRate[],
        )
        setCustomerDiscountRows(
          (await customerDiscountResponse.json()) as CustomerDiscount[],
        )
      } catch (error) {
        setMessage(
          error instanceof Error
            ? `Master API error: ${error.message}`
            : 'Master API error: backend not connected',
        )
        setMasterCustomers([])
        setLookups(emptyLookups)
        setProductRows([])
        setTradingRates([])
        setCustomerDiscountRows([])
      }
    }

    void loadMasterData()
  }, [])

  const companySelectionOptions = useMemo<FieldOption[]>(
    () => [
      {
        value: '',
        label: companies.length > 0 ? 'Select company' : 'No companies loaded',
      },
      ...companies.map((company) => ({
        value: company.id,
        label: company.legalName,
      })),
    ],
    [companies],
  )
  const selectedCompany = companies.find((company) => company.id === form.companyId)
  const selectedMasterCustomer =
    masterCustomers.find(
      (customer) => String(customer.customerId) === form.customerId,
    ) ??
    masterCustomers.find(
      (customer) => form.custCode > 0 && customer.custCode === form.custCode,
    ) ??
    masterCustomers.find(
      (customer) =>
        form.prospectiveCustomerName.trim() !== '' &&
        customer.custName.trim().toLowerCase() ===
          form.prospectiveCustomerName.trim().toLowerCase(),
    )
  const selectedCustomer = toCustomerPreview(form, selectedMasterCustomer)
  const currency = form.currency || 'INR'
  const selectedCompanyCode = selectedCompany?.compCode ?? 0

  const selectedCustomerDiscount = useMemo(
    () =>
      getCustomerDiscountForMasterCustomer(
        selectedMasterCustomer,
        customerDiscountRows,
        selectedCompanyCode,
      ),
    [customerDiscountRows, selectedCompanyCode, selectedMasterCustomer],
  )

  const customerOptions = useMemo<FieldOption[]>(() => {
    return [
      {
        value: '',
        label: masterCustomers.length > 0 ? 'Select customer' : 'No customers loaded',
      },
      ...[...masterCustomers]
        .sort((firstCustomer, secondCustomer) =>
          firstCustomer.custName.localeCompare(secondCustomer.custName),
        )
        .map((customer) => ({
          value: String(customer.customerId),
          label: customer.custName,
        })),
    ]
  }, [masterCustomers])

  const partyTypeOptions = useMemo<FieldOption[]>(
    () => [
      { value: '', label: 'Select party type' },
      ...lookups.partyTypes.map((partyType) => ({
        value: String(partyType.code),
        label: partyType.name,
      })),
    ],
    [lookups.partyTypes],
  )

  const prospectiveCityOptions = useMemo(
    () => toLookupOptions(lookups.cities, 'Select city'),
    [lookups.cities],
  )

  const selectedProspectiveCity = useMemo(
    () =>
      lookups.cities.find((city) => city.name === form.prospectiveCity) ??
      lookups.cities.find((city) => city.code === form.cityCode),
    [form.cityCode, form.prospectiveCity, lookups.cities],
  )
  const selectedProspectiveCityCode =
    selectedProspectiveCity?.code ?? (form.cityCode > 0 ? form.cityCode : '')
  const selectedProspectiveStateCode =
    selectedProspectiveCity?.parentCode ?? form.stateCode

  const rateByProductCode = useMemo(() => {
    const rateMap = new Map<string, TradingProductRate>()

    tradingRates.forEach((rate) => {
      const productCode = rate.productCode.trim().toLowerCase()

      if (!productCode) {
        return
      }

      const existingRate = rateMap.get(productCode)

      if (
        !existingRate ||
        getRateDateValue(rate.effDate) >= getRateDateValue(existingRate.effDate)
      ) {
        rateMap.set(productCode, rate)
      }
    })

    return rateMap
  }, [tradingRates])

  useEffect(() => {
    if (productRows.length === 0) {
      return
    }

    let hasProductUpdates = false
    const hydratedLineItems = form.lineItems.map((lineItem) => {
      if (!lineItem.productCode) {
        return lineItem
      }

      const product = productRows.find(
        (item) =>
          item.code.trim().toLowerCase() ===
          lineItem.productCode.trim().toLowerCase(),
      )

      if (!product) {
        return lineItem
      }

      const nextLineItem = {
        ...lineItem,
        description: lineItem.description || product.description,
        gstPercent: lineItem.gstPercent || product.gstPercent,
        hsnCode: lineItem.hsnCode || product.hsnCode,
        productId: lineItem.productId || product.id,
        unit: !lineItem.unit || lineItem.unit === '0' ? product.unit : lineItem.unit,
      }

      hasProductUpdates =
        hasProductUpdates ||
        nextLineItem.description !== lineItem.description ||
        nextLineItem.gstPercent !== lineItem.gstPercent ||
        nextLineItem.hsnCode !== lineItem.hsnCode ||
        nextLineItem.productId !== lineItem.productId ||
        nextLineItem.unit !== lineItem.unit

      return nextLineItem
    })

    if (hasProductUpdates) {
      onFormChange({
        ...form,
        lineItems: hydratedLineItems,
      })
    }
  }, [form, onFormChange, productRows])

  const applyPartyTypeRates = (
    lineItems: LineItem[],
    partyTypeName: string,
    customerDiscount = selectedCustomerDiscount,
  ) =>
    lineItems.map((lineItem) => {
      if (!lineItem.productCode) {
        return lineItem
      }

      const product =
        productRows.find((item) => item.id === lineItem.productId) ??
        productRows.find(
          (item) =>
            item.code.trim().toLowerCase() ===
            lineItem.productCode.trim().toLowerCase(),
        )
      const tradingRate = rateByProductCode.get(
        lineItem.productCode.trim().toLowerCase(),
      )
      const category =
        product?.category ?? tradingRate?.catDesc ?? tradingRate?.family ?? ''
      const mrp =
        getTradingRateMrp(tradingRate, partyTypeName) ||
        lineItem.mrp ||
        lineItem.unitPrice
      const discountPercent = getCustomerDiscountPercent(
        category,
        customerDiscount,
      )

      return {
        ...lineItem,
        mrp,
        unitPrice: getDiscountedRate(mrp, discountPercent),
      }
    })

  const lineCalculations = useMemo(
    () => form.lineItems.map((line) => calculateLineRow(line)),
    [form.lineItems],
  )

  const schemeDiscount = useMemo(
    () =>
      roundMoney(
        lineCalculations.reduce(
          (discountTotal, line) => discountTotal + line.discountAmount,
          0,
        ),
      ),
    [lineCalculations],
  )

  const commercial = useMemo(() => {
    const basicValue = roundMoney(
      lineCalculations.reduce((sum, line) => sum + line.amount, 0),
    )
    const netBasicValue = roundMoney(basicValue - schemeDiscount)
    const specialDiscountAmount = roundMoney(
      (netBasicValue * form.specialDiscountPercent) / 100,
    )
    const otherDiscountAmount = roundMoney(
      (netBasicValue * form.otherDiscountPercent) / 100,
    )
    const amountAfterDiscount = roundMoney(
      netBasicValue - specialDiscountAmount - otherDiscountAmount,
    )
    const todAmount = roundMoney((amountAfterDiscount * form.todPercent) / 100)
    const cdAmount = roundMoney((amountAfterDiscount * form.cdPercent) / 100)
    const additionalDiscountAmount = roundMoney(
      (amountAfterDiscount * form.additionalDiscountPercent) / 100,
    )
    const buyNFlyAmount = roundMoney(
      (amountAfterDiscount * form.buyNFlyPercent) / 100,
    )
    const netTaxableValue = roundMoney(
      amountAfterDiscount -
        todAmount -
        cdAmount -
        additionalDiscountAmount -
        buyNFlyAmount,
    )
    const igstAmount = Math.round((netTaxableValue * form.igstPercent) / 100)
    const cgstAmount = Math.round((netTaxableValue * form.cgstPercent) / 100)
    const sgstAmount = Math.round((netTaxableValue * form.sgstPercent) / 100)
    const grandTotalBeforeRoundOff = roundMoney(
      netTaxableValue +
        igstAmount +
        cgstAmount +
        sgstAmount +
        form.freight,
    )
    const roundedGrandTotal = Math.ceil(grandTotalBeforeRoundOff)
    const roundOff = roundMoney(roundedGrandTotal - grandTotalBeforeRoundOff)
    const grandTotal = roundMoney(roundedGrandTotal)

    return {
      additionalDiscountAmount,
      amountAfterDiscount,
      basicValue,
      buyNFlyAmount,
      cdAmount,
      cgstAmount,
      grandTotal,
      igstAmount,
      netBasicValue,
      netTaxableValue,
      otherDiscountAmount,
      roundOff,
      schemeDiscount,
      sgstAmount,
      specialDiscountAmount,
      todAmount,
    }
  }, [
    form.additionalDiscountPercent,
    form.buyNFlyPercent,
    form.cdPercent,
    form.cgstPercent,
    form.freight,
    form.igstPercent,
    form.otherDiscountPercent,
    form.sgstPercent,
    form.specialDiscountPercent,
    form.todPercent,
    lineCalculations,
    schemeDiscount,
  ])

  const previewForm = useMemo(
    () => ({
      ...form,
      discount: schemeDiscount,
      roundOff: commercial.roundOff,
      schemeDiscount,
    }),
    [commercial.roundOff, form, schemeDiscount],
  )

  const updateForm = <Key extends keyof PIFormState>(
    key: Key,
    value: PIFormState[Key],
  ) => {
    onFormChange({ ...form, [key]: value })
  }

  const updateNumberForm = <Key extends keyof PIFormState>(
    key: Key,
    value: string,
  ) => {
    updateForm(key, parseNumber(value) as PIFormState[Key])
  }

  const handleCompanyChange = (companyId: string) => {
    const nextCompanyCode =
      companies.find((company) => company.id === companyId)?.compCode ?? 0
    const customerDiscount = getCustomerDiscountForMasterCustomer(
      selectedMasterCustomer,
      customerDiscountRows,
      nextCompanyCode,
    )

    onFormChange({
      ...form,
      companyId,
      piNumber: generatePINumber?.(companyId) ?? '',
      lineItems: applyPartyTypeRates(
        form.lineItems,
        form.partyTypeName,
        customerDiscount,
      ),
    })
  }

  const handleCustomerChange = (customerId: string) => {
    const masterCustomer = masterCustomers.find(
      (customer) => String(customer.customerId) === customerId,
    )

    if (masterCustomer) {
      const partyTypeName = masterCustomer.partyTypeName
      const customerDiscount = getCustomerDiscountForMasterCustomer(
        masterCustomer,
        customerDiscountRows,
        selectedCompanyCode,
      )

      onFormChange({
        ...form,
        customerId,
        custCode: masterCustomer.custCode,
        cityCode: masterCustomer.corrCityCode,
        stateCode: masterCustomer.corrStateCode,
        customerCity: masterCustomer.corrCityName,
        customerState: masterCustomer.corrStateName,
        country: masterCustomer.corrCountryName,
        currency: 'INR',
        prospectiveAddress: masterCustomer.corrAddress,
        prospectiveCity: masterCustomer.corrCityName,
        prospectiveContactNo: masterCustomer.mobileNo || masterCustomer.corrTel,
        prospectiveCustomerName: masterCustomer.custName,
        prospectiveGstNo: masterCustomer.gstinNo,
        prospectiveState: masterCustomer.corrStateName,
        partyTypeCode: String(masterCustomer.partyTypeCode || ''),
        partyTypeName,
        destination: masterCustomer.corrCityName,
        lineItems: applyPartyTypeRates(
          form.lineItems,
          partyTypeName,
          customerDiscount,
        ),
      })
      return
    }

    onFormChange({
      ...form,
      customerId,
      custCode: 0,
      cityCode: 0,
      stateCode: 0,
      customerCity: '',
      customerState: '',
      country: '',
      currency: 'INR',
      prospectiveAddress: '',
      prospectiveCity: '',
      prospectiveContactNo: '',
      prospectiveCustomerName: '',
      prospectiveGstNo: '',
      prospectiveState: '',
      partyTypeCode: '',
      partyTypeName: '',
      destination: '',
      lineItems: applyPartyTypeRates(form.lineItems, '', undefined),
    })
  }

  const updateLineItem = (id: string, updates: Partial<LineItem>) => {
    onFormChange({
      ...form,
      lineItems: form.lineItems.map((item) =>
        item.id === id ? { ...item, ...updates } : item,
      ),
    })
  }

  const handleLineDiscountChange = (id: string, value: string) => {
    const discountPercent = parseNumber(value)
    updateLineItem(id, { discountPercent })
  }

  const selectProduct = (rowId: string, productValue: string) => {
    const product = productRows.find(
      (item) => item.id === productValue || item.code === productValue,
    )

    if (!product) {
      updateLineItem(rowId, {
        description: '',
        discountPercent: 0,
        gstPercent: 0,
        hsnCode: '',
        mrp: 0,
        productCode: '',
        productId: '',
        unit: '',
        unitPrice: 0,
      })
      return
    }

    const tradingRate = rateByProductCode.get(product.code.trim().toLowerCase())
    const category =
      product.category ?? tradingRate?.catDesc ?? tradingRate?.family ?? ''
    const mrp = getTradingRateMrp(tradingRate, form.partyTypeName)
    const customerDiscountPercent = getCustomerDiscountPercent(
      category,
      selectedCustomerDiscount,
    )
    const existingLine = form.lineItems.find((line) => line.id === rowId)

    updateLineItem(rowId, {
      description: product.description,
      discountPercent: existingLine?.discountPercent ?? 0,
      gstPercent: product.gstPercent,
      hsnCode: product.hsnCode,
      mrp,
      productCode: product.code,
      productId: product.id,
      unit: product.unit,
      unitPrice: getDiscountedRate(mrp, customerDiscountPercent),
    })
  }

  const addLineItem = () => {
    const nextId = `line-${Date.now()}`
    onFormChange({
      ...form,
      lineItems: [...form.lineItems, createEmptyLineItem(nextId)],
    })
  }

  const removeLineItem = (id: string) => {
    if (form.lineItems.length === 1) {
      return
    }

    onFormChange({
      ...form,
      lineItems: form.lineItems.filter((item) => item.id !== id),
    })
  }

  const handlePartyTypeChange = (partyTypeCode: string) => {
    const partyTypeName =
      lookups.partyTypes.find((partyType) => String(partyType.code) === partyTypeCode)
        ?.name ?? ''

    onFormChange({
      ...form,
      partyTypeCode,
      partyTypeName,
      lineItems: applyPartyTypeRates(
        form.lineItems,
        partyTypeName,
        selectedCustomerDiscount,
      ),
    })
  }

  const handleProspectiveCityChange = (cityCode: string) => {
    const city = lookups.cities.find((item) => String(item.code) === cityCode)
    const state =
      city?.parentCode === undefined
        ? undefined
        : lookups.states.find((item) => item.code === city.parentCode)

    onFormChange({
      ...form,
      cityCode: city?.code ?? 0,
      stateCode: state?.code ?? 0,
      customerCity: city?.name ?? '',
      customerState: state?.name ?? '',
      prospectiveCity: city?.name ?? '',
      prospectiveState: state?.name ?? '',
    })
  }

  const buildSavePayload = (savedForm: PIFormState) => ({
    ...savedForm,
    additionalDiscountAmount: commercial.additionalDiscountAmount,
    amountAfterDiscount: commercial.amountAfterDiscount,
    basicValue: commercial.basicValue,
    buyNFlyAmount: commercial.buyNFlyAmount,
    cdAmount: commercial.cdAmount,
    cgstAmount: commercial.cgstAmount,
    cityCode:
      selectedMasterCustomer?.corrCityCode ??
      Number(selectedProspectiveCityCode || form.cityCode || 0),
    companyName: selectedCompany?.legalName ?? '',
    compCode: selectedCompanyCode,
    custCode: selectedMasterCustomer?.custCode ?? form.custCode ?? 0,
    custName:
      selectedCustomer?.name ??
      savedForm.prospectiveCustomerName ??
      savedForm.customerId,
    customerId: selectedMasterCustomer?.customerId ?? null,
    gstNo: savedForm.prospectiveGstNo,
    grandTotal: commercial.grandTotal,
    igstAmount: commercial.igstAmount,
    lineItems: savedForm.lineItems.map((line, index) => {
      const lineSummary = lineCalculations[index]

      return {
        ...line,
        amount: lineSummary.amount,
        basic: lineSummary.basic,
        discountAmount: lineSummary.discountAmount,
        discPercent: line.discountPercent,
        productDescription: line.description,
        qty: line.quantity,
        rate: line.unitPrice,
        srNo: index + 1,
        uom: line.unit,
      }
    }),
    netBasicValue: commercial.netBasicValue,
    netTaxableValue: commercial.netTaxableValue,
    otherDiscountAmount: commercial.otherDiscountAmount,
    sgstAmount: commercial.sgstAmount,
    specialDiscountAmount: commercial.specialDiscountAmount,
    stateCode:
      selectedMasterCustomer?.corrStateCode ??
      selectedProspectiveStateCode ??
      form.stateCode ??
      0,
    status: 'Draft',
    todAmount: commercial.todAmount,
    todPercent: savedForm.todPercent,
  })

  const saveDraft = async () => {
    const savedForm = {
      ...form,
      additionalDiscountAmount: commercial.additionalDiscountAmount,
      amountAfterDiscount: commercial.amountAfterDiscount,
      basicValue: commercial.basicValue,
      buyNFlyAmount: commercial.buyNFlyAmount,
      cdAmount: commercial.cdAmount,
      cgstAmount: commercial.cgstAmount,
      discount: commercial.schemeDiscount,
      grandTotal: commercial.grandTotal,
      igstAmount: commercial.igstAmount,
      netBasicValue: commercial.netBasicValue,
      netTaxableValue: commercial.netTaxableValue,
      otherDiscountAmount: commercial.otherDiscountAmount,
      roundOff: commercial.roundOff,
      schemeDiscount: commercial.schemeDiscount,
      sgstAmount: commercial.sgstAmount,
      specialDiscountAmount: commercial.specialDiscountAmount,
      todAmount: commercial.todAmount,
    }

    setIsSavingPI(true)

    try {
      const response = await fetch(PI_RMKT_API_URL, {
        body: JSON.stringify(buildSavePayload(savedForm)),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      await response.json()
      await onSaveDraft?.(savedForm)
      setMessage(`Draft saved to PostgreSQL for ${form.piNumber || 'new PI'}`)
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `Save failed: ${error.message}`
          : 'Save failed: backend not connected',
      )
    } finally {
      setIsSavingPI(false)
    }
  }

  const generatePDF = () => {
    setMessage('PDF preview opened through browser print')
    window.print()
  }

  const renderAmountField = (label: string, value: number) => (
    <InputField label={label} readOnly value={formatCurrency(value, currency)} />
  )

  return (
    <div className="page create-pi-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Commercial</p>
          <h1>Create Proforma Invoice</h1>
        </div>
        <div className="header-actions">
          <span className="status-pill">{message}</span>
          <Button
            disabled={isSavingPI}
            onClick={() => void saveDraft()}
            variant="secondary"
          >
            {isSavingPI ? 'Saving' : 'Save Draft'}
          </Button>
          <Button onClick={onCancel} variant="ghost">
            Cancel
          </Button>
          <Button onClick={generatePDF}>Generate PDF</Button>
        </div>
      </header>

      <section className="panel pi-header-panel">
        <div className="form-grid create-pi-header-grid">
          <InputField
            className="fit-value-control"
            hint="Generated after company selection"
            label="PI No"
            readOnly
            value={form.piNumber}
          />
          <InputField
            className="fit-date-control"
            label="PI Date"
            onChange={(event) => updateForm('piDate', event.target.value)}
            type="date"
            value={form.piDate}
          />
          <InputField
            className="fit-date-control"
            label="Delivery Date"
            onChange={(event) => updateForm('deliveryDate', event.target.value)}
            type="date"
            value={form.deliveryDate}
          />
          <SelectField
            label="Company"
            onChange={(event) => handleCompanyChange(event.target.value)}
            options={companySelectionOptions}
            value={form.companyId}
          />
          <SelectField
            label="Customer Name"
            onChange={(event) => handleCustomerChange(event.target.value)}
            options={customerOptions}
            value={
              form.customerId ||
              (selectedMasterCustomer
                ? String(selectedMasterCustomer.customerId)
                : '')
            }
          />
          <InputField
            label="City"
            readOnly
            value={form.customerCity}
          />
          <InputField
            label="State"
            readOnly
            value={form.customerState}
          />
        </div>
      </section>

      <section className="summary-strip">
        <div>
          <span>Basic Value</span>
          <strong>{formatCurrency(commercial.basicValue, currency)}</strong>
        </div>
        <div>
          <span>Net Taxable Value</span>
          <strong>{formatCurrency(commercial.netTaxableValue, currency)}</strong>
        </div>
        <div>
          <span>Tax Total</span>
          <strong>
            {formatCurrency(
              commercial.igstAmount + commercial.cgstAmount + commercial.sgstAmount,
              currency,
            )}
          </strong>
        </div>
        <div>
          <span>Grand Total</span>
          <strong>{formatCurrency(commercial.grandTotal, currency)}</strong>
        </div>
      </section>

      <section className="panel create-pi-workspace">
        <div className="customer-tab-list create-pi-tab-list" role="tablist">
          {createPITabs.map((tab) => (
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

        {activeTab === 'prospective' ? (
          <div className="create-pi-tab-panel">
            <div className="form-grid prospective-grid">
              <InputField
                label="Prospective Customer Name"
                onChange={(event) =>
                  updateForm('prospectiveCustomerName', event.target.value)
                }
                value={form.prospectiveCustomerName}
              />
              <InputField
                label="Address"
                onChange={(event) =>
                  updateForm('prospectiveAddress', event.target.value)
                }
                value={form.prospectiveAddress}
              />
              <SelectField
                label="City"
                onChange={(event) =>
                  handleProspectiveCityChange(event.target.value)
                }
                options={prospectiveCityOptions}
                value={String(selectedProspectiveCityCode)}
              />
              <InputField
                label="State"
                readOnly
                value={form.prospectiveState}
              />
              <InputField
                label="Contact No"
                onChange={(event) =>
                  updateForm('prospectiveContactNo', event.target.value)
                }
                value={form.prospectiveContactNo}
              />
              <InputField
                label="Discount % on MRP"
                min="0"
                onChange={(event) =>
                  updateNumberForm(
                    'prospectiveDiscountPercent',
                    event.target.value,
                  )
                }
                type="number"
                value={form.prospectiveDiscountPercent || ''}
              />
              <InputField
                label="GST No."
                onChange={(event) =>
                  updateForm('prospectiveGstNo', event.target.value.toUpperCase())
                }
                value={form.prospectiveGstNo}
              />
              <SelectField
                label="Party Type"
                onChange={(event) => handlePartyTypeChange(event.target.value)}
                options={partyTypeOptions}
                value={form.partyTypeCode}
              />
            </div>
          </div>
        ) : null}

        {activeTab === 'proforma' ? (
          <div className="create-pi-tab-panel">
            <div className="pi-detail-frame">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Tab 2</p>
                  <h2>Proforma Details</h2>
                </div>
              </div>
              <div className="form-grid proforma-detail-grid">
                <InputField
                  label="Transport Mode"
                  onChange={(event) =>
                    updateForm('transportMode', event.target.value)
                  }
                  value={form.transportMode}
                />
                <InputField
                  label="Transporter"
                  onChange={(event) => updateForm('transporter', event.target.value)}
                  value={form.transporter}
                />
                <InputField
                  label="Destination"
                  onChange={(event) => updateForm('destination', event.target.value)}
                  value={form.destination}
                />
                <InputField
                  label="Material Group"
                  onChange={(event) =>
                    updateForm('materialGroup', event.target.value)
                  }
                  value={form.materialGroup}
                />
                <InputField
                  label="Cust PO No"
                  onChange={(event) => updateForm('custPoNo', event.target.value)}
                  value={form.custPoNo}
                />
                <InputField
                  label="Under Scheme"
                  onChange={(event) => updateForm('underScheme', event.target.value)}
                  value={form.underScheme}
                />
                <SelectField
                  label="Proforma Close"
                  onChange={(event) =>
                    updateForm('proformaClose', event.target.value as 'Yes' | 'No')
                  }
                  options={proformaCloseOptions}
                  value={form.proformaClose}
                />
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'commercial' ? (
          <div className="create-pi-tab-panel">
            <div className="pi-detail-frame commercial-frame">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Tab 4</p>
                  <h2>Commercial Details</h2>
                </div>
              </div>
              <div className="form-grid commercial-grid">
                {renderAmountField('Basic Value', commercial.basicValue)}
                {renderAmountField('Scheme Discount', commercial.schemeDiscount)}
                {renderAmountField('Net Basic Value', commercial.netBasicValue)}
                <InputField
                  label="Sp Dis (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('specialDiscountPercent', event.target.value)
                  }
                  type="number"
                  value={form.specialDiscountPercent || ''}
                />
                {renderAmountField('Sp Discount Amount', commercial.specialDiscountAmount)}
                <InputField
                  label="Other Dis (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('otherDiscountPercent', event.target.value)
                  }
                  type="number"
                  value={form.otherDiscountPercent || ''}
                />
                {renderAmountField('Other Discount Amount', commercial.otherDiscountAmount)}
                {renderAmountField(
                  'Amount After Discount',
                  commercial.amountAfterDiscount,
                )}
                <InputField
                  label="TOD (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('todPercent', event.target.value)
                  }
                  type="number"
                  value={form.todPercent || ''}
                />
                {renderAmountField('TOD Amount', commercial.todAmount)}
                <InputField
                  label="CD % on PI"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('cdPercent', event.target.value)
                  }
                  type="number"
                  value={form.cdPercent || ''}
                />
                {renderAmountField('CD Amount', commercial.cdAmount)}
                <InputField
                  label="Other Discount (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm(
                      'additionalDiscountPercent',
                      event.target.value,
                    )
                  }
                  type="number"
                  value={form.additionalDiscountPercent || ''}
                />
                {renderAmountField(
                  'Other Discount Value',
                  commercial.additionalDiscountAmount,
                )}
                <InputField
                  label="Buy N Fly (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('buyNFlyPercent', event.target.value)
                  }
                  type="number"
                  value={form.buyNFlyPercent || ''}
                />
                {renderAmountField('Buy N Fly Amount', commercial.buyNFlyAmount)}
                {renderAmountField('Net Taxable Value', commercial.netTaxableValue)}
                <InputField
                  label="IGST (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('igstPercent', event.target.value)
                  }
                  type="number"
                  value={form.igstPercent || ''}
                />
                {renderAmountField('IGST Amount', commercial.igstAmount)}
                <InputField
                  label="CGST (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('cgstPercent', event.target.value)
                  }
                  type="number"
                  value={form.cgstPercent || ''}
                />
                {renderAmountField('CGST Amount', commercial.cgstAmount)}
                <InputField
                  label="SGST (%)"
                  min="0"
                  onChange={(event) =>
                    updateNumberForm('sgstPercent', event.target.value)
                  }
                  type="number"
                  value={form.sgstPercent || ''}
                />
                {renderAmountField('SGST Amount', commercial.sgstAmount)}
                <InputField
                  label="Freight / Other Amount"
                  min="0"
                  onChange={(event) => updateNumberForm('freight', event.target.value)}
                  type="number"
                  value={form.freight || ''}
                />
                {renderAmountField('Round Off', commercial.roundOff)}
                {renderAmountField('Grand Total', commercial.grandTotal)}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === 'products' ? (
          <div className="create-pi-tab-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Tab 3</p>
                <h2>Product Details</h2>
              </div>
              <Button onClick={addLineItem} variant="secondary">
                <span className="btn-symbol">+</span>
                Add Row
              </Button>
            </div>
            <div className="responsive-table">
              <table className="master-table pi-product-grid">
                <thead>
                  <tr>
                    <th>Sr.No.</th>
                    <th>Product Code</th>
                    <th>Product Description</th>
                    <th>Qty</th>
                    <th>UOM</th>
                    <th>Rate</th>
                    <th>Amount</th>
                    <th>Basic</th>
                    <th>Disc %</th>
                    <th>Discount Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {form.lineItems.map((line, index) => {
                    const lineSummary = lineCalculations[index]
                    const selectedProductOptionValue =
                      productRows.find(
                        (product) =>
                          product.id === line.productId ||
                          product.code === line.productCode,
                      )?.id ||
                      line.productId ||
                      line.productCode

                    return (
                      <tr key={line.id}>
                        <td>{index + 1}</td>
                        <td>
                          <input
                            className="table-control product-code-control"
                            readOnly
                            title="Loaded from selected product description"
                            value={line.productCode}
                          />
                        </td>
                        <td>
                          <select
                            className="table-control description-control"
                            onChange={(event) =>
                              selectProduct(line.id, event.target.value)
                            }
                            value={selectedProductOptionValue}
                          >
                            <option value="">Select product description</option>
                            {[...productRows]
                              .sort((firstProduct, secondProduct) =>
                                (firstProduct.description || firstProduct.code)
                                  .localeCompare(
                                    secondProduct.description ||
                                      secondProduct.code,
                                  ),
                              )
                              .map((product) => (
                                <option key={product.id} value={product.id}>
                                  {product.description || product.code}
                                </option>
                              ))}
                            {line.productCode &&
                            !productRows.some(
                              (product) => product.code === line.productCode,
                            ) ? (
                              <option value={line.productCode}>
                                {line.description || line.productCode}
                              </option>
                            ) : null}
                          </select>
                        </td>
                        <td>
                          <input
                            className="table-control number-control"
                            min="0"
                            onChange={(event) =>
                              updateLineItem(line.id, {
                                quantity: parseNumber(event.target.value),
                              })
                            }
                            type="number"
                            value={line.quantity || ''}
                          />
                        </td>
                        <td>
                          <input
                            className="table-control"
                            onChange={(event) =>
                              updateLineItem(line.id, { unit: event.target.value })
                            }
                            value={line.unit}
                          />
                        </td>
                        <td>
                          <input
                            className="table-control number-control"
                            min="0"
                            readOnly
                            title="Loaded from R.Market rate master"
                            type="number"
                            value={line.unitPrice || ''}
                          />
                        </td>
                        <td>{formatCurrency(lineSummary.amount, currency)}</td>
                        <td>{formatCurrency(lineSummary.basic, currency)}</td>
                        <td>
                          <input
                            className="table-control number-control"
                            min="0"
                            onChange={(event) =>
                              handleLineDiscountChange(
                                line.id,
                                event.target.value,
                              )
                            }
                            type="number"
                            value={line.discountPercent || ''}
                          />
                        </td>
                        <td>
                          {formatCurrency(lineSummary.discountAmount, currency)}
                        </td>
                        <td>
                          <button
                            aria-label="Remove product row"
                            className="icon-button"
                            disabled={form.lineItems.length === 1}
                            onClick={() => removeLineItem(line.id)}
                            type="button"
                          >
                            x
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </section>

      <div className="create-pi-print-preview">
        <PIPreviewPanel
          company={selectedCompany}
          customer={selectedCustomer}
          form={previewForm}
          mode="full"
        />
      </div>

      {selectedCompany || selectedCustomer ? (
        <section className="panel customer-mini-card">
          <span>Selected PI Context</span>
          <strong>{selectedCustomer?.name ?? 'No customer selected'}</strong>
          <p>{selectedCompany?.legalName ?? 'No company selected'}</p>
          <p>
            {[form.customerCity, form.customerState, form.country]
              .filter(Boolean)
              .join(', ') || 'Location pending'}
          </p>
        </section>
      ) : null}
    </div>
  )
}

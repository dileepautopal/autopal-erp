import type { ReactNode } from 'react'

export type ScreenId =
  | 'dashboard'
  | 'create-pi'
  | 'pi-preview'
  | 'whatsapp-pi'
  | 'customers'
  | 'products'
  | 'r-market-rates'
  | 'customer-discounts'
  | 'ai-assistant'
  | 'pi-intelligence'
  | 'commercial-intelligence'
  | 'ai-erp-intelligence'
  | 'ai-commercial-intelligence'
  | 'admin-panel'
  | 'ai-test-console'

export type NavItem = {
  id: ScreenId
  label: string
  meta: string
}

export type UserSession = {
  userName: string
  isAdmin: boolean
  rights: ScreenId[]
}

export type UserAccess = UserSession & {
  isActive: boolean
  lastLoginAt?: string
  lastLoginLocation?: string
}

export type Company = {
  compCode: number
  id: string
  name: string
  legalName: string
  address: string
  gstin: string
  pan: string
  state: string
  stateCode: string
  cin: string
  website: string
  iec: string
  phone: string
  email: string
  piPrefix: string
  bankDetails: BankDetails
}

export type Customer = {
  id: string
  name: string
  country: string
  currency: string
  state: string
  stateCode: string
  contactPerson: string
  email: string
  phone: string
  address: string
  placeOfSupply: string
  paymentTerms: string
  dispatchTerms: string
  gstin?: string
  pan?: string
  partyPoNumber?: string
  vendorCode?: string
}

export type MasterCustomer = {
  customerId: number
  custCode: number
  custName: string
  corrAddress: string
  corrCityCode: number
  corrCityName: string
  corrStateCode: number
  corrStateName: string
  corrCountryCode: number
  corrCountryName: string
  corrPinCode: number
  corrTel: string
  corrFax: string
  corrEmail: string
  shipAddress: string
  shipCityCode: number
  shipCityName: string
  shipStateCode: number
  shipStateName: string
  shipCountryCode: number
  shipCountryName: string
  shipPinCode: number
  shipTel: string
  shipFax: string
  shipEmail: string
  website: string
  marketCode: number
  marketName: string
  zone: string
  partyTypeCode: number
  partyTypeName: string
  gstinNo: string
  gstDate: string
  panNo: string
  contactPerson: string
  mobileNo: string
  creditDays: number
  creditLimit: number
  remarks: string
  isActive: boolean
}

export type MasterLookupOption = {
  code: number
  name: string
  parentCode?: number
}

export type MasterCustomerLookups = {
  cities: MasterLookupOption[]
  states: MasterLookupOption[]
  countries: MasterLookupOption[]
  markets: MasterLookupOption[]
  partyTypes: MasterLookupOption[]
}

export type BankDetails = {
  bankName: string
  branch: string
  accountName: string
  accountNumber: string
  ifsc: string
}

export type Product = {
  id: string
  code: string
  description: string
  hsnCode: string
  unit: string
  category: string
  market: number
  gstPercent: number
}

export type TradingProductRate = {
  id: number
  effDate: string
  productCode: string
  wRate: number
  swRate: number
  rRate: number
  iRate: number
  oth1Rate: number
  oth2Rate: number
  disAmt: number
  unitName: string
  family: string
  mrp: number
  stdPkg: number
  cpno: string
  minStkQty: number
  dispMrp: number
  basicRate: number
  plantName: string
  catDesc: string
  compCode: number
}

export type CustomerDiscount = {
  id: number
  effDate: string
  custCode: number
  customerName?: string
  hlPer: number
  haloPer: number
  incdPer: number
  wiperPer: number
  gstPer: number
  compCode: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export type PIFormState = {
  piNumber: string
  piDate: string
  deliveryDate: string
  validUntil: string
  companyId: string
  customerId: string
  custCode: number
  cityCode: number
  stateCode: number
  customerCity: string
  customerState: string
  country: string
  currency: string
  paymentTerms: string
  dispatchTerms: string
  prospectiveCustomerName: string
  prospectiveAddress: string
  prospectiveCity: string
  prospectiveState: string
  prospectiveContactNo: string
  prospectiveDiscountPercent: number
  prospectiveGstNo: string
  partyTypeCode: string
  partyTypeName: string
  transportMode: string
  transporter: string
  destination: string
  materialGroup: string
  custPoNo: string
  underScheme: string
  proformaClose: 'Yes' | 'No'
  schemeDiscount: number
  specialDiscountPercent: number
  otherDiscountPercent: number
  cdPercent: number
  todPercent: number
  additionalDiscountPercent: number
  buyNFlyPercent: number
  igstPercent: number
  cgstPercent: number
  sgstPercent: number
  roundOff: number
  freight: number
  discount: number
  terms: string
  lineItems: LineItem[]
}

export type PIStatus = 'Draft' | 'Final'

export type SavedPI = PIFormState & {
  id: string
  status: PIStatus
  updatedAt: string
}

export type LineItem = {
  id: string
  productId: string
  productCode: string
  description: string
  hsnCode: string
  unit: string
  quantity: number
  mrp?: number
  unitPrice: number
  gstPercent: number
  discountPercent: number
}

export type LineCalculation = LineItem & {
  taxableAmount: number
  gstAmount: number
  lineTotal: number
}

export type PITotals = {
  subtotal: number
  gstTotal: number
  freight: number
  discount: number
  grandTotal: number
}

export type GSTBreakup = {
  taxType: 'intra-state' | 'inter-state'
  cgstTotal: number
  sgstTotal: number
  igstTotal: number
  gstTotal: number
}

export type FieldOption = {
  value: string
  label: string
}

export type WithChildren = {
  children: ReactNode
}

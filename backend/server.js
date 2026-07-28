import 'dotenv/config'
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import pg from 'pg'
import { createAITestConsoleRouter } from './aiTestConsole.js'
import {
  classifyERPQuestion,
  ERP_INTELLIGENCE_SCREEN_ID,
  ERP_INTENTS,
  getPIIntelligenceDashboard,
  processERPQuestion,
  verifyERPIntelligenceAccess,
} from './erpIntelligenceService.js'
import {
  askOllama,
  checkOllamaHealth,
} from './ollamaService.js'
import { createWhatsappPIRouter } from './whatsappPi.js'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 5000)
const DIST_PATH = path.resolve(__dirname, '../dist')
const INDEX_HTML_PATH = path.join(DIST_PATH, 'index.html')
const ROBOTS_TXT_PATH = path.join(DIST_PATH, 'robots.txt')
const META_DATA_DELETION_TABLE_NAME = 'meta_data_deletion_requests'
const USER_TABLE_NAME = 'master_user'
const USER_RIGHTS_TABLE_NAME = 'master_user_rights'
const USER_LOGIN_LOG_TABLE_NAME = 'tran_userlog'
const COMPANY_TABLE_NAME = 'master_company'
const COMPANY_CATEGORY_MAPPING_TABLE_NAME = 'master_company_category_mapping'
const PRODUCT_TABLE_NAME = 'master_products'
const CUSTOMER_TABLE_NAME = 'master_customer'
const COUNTRY_TABLE_NAME = 'master_country'
const STATE_TABLE_NAME = 'master_state'
const CITY_TABLE_NAME = 'master_city'
const MARKET_TABLE_NAME = 'master_market'
const PARTY_TYPE_TABLE_NAME = 'master_party_type'
const TRADING_RATE_TABLE_NAME = 'master_trading_product_rate'
const CUSTOMER_DISCOUNT_TABLE_NAME = 'master_cust_discount'
const RMKT_PI_MASTER_TABLE_NAME = 'master_pi_rmkt'
const RMKT_PI_TRAN_TABLE_NAME = 'tran_pi_rmkt'
const ERP_INTELLIGENCE_TABLE_NAMES = {
  company: COMPANY_TABLE_NAME,
  customer: CUSTOMER_TABLE_NAME,
  piMaster: RMKT_PI_MASTER_TABLE_NAME,
  user: USER_TABLE_NAME,
  userRights: USER_RIGHTS_TABLE_NAME,
}
const CUSTOMER_DUPLICATE_MESSAGE =
  'Customer with same name, address, and city already exists.'
const AI_TEST_CONSOLE_ENABLED = process.env.ENABLE_AI_TEST_CONSOLE === 'true'
const AUTOPAL_AI_SYSTEM_PROMPT = `
You are AUTOPAL's internal AI business assistant.

Company context:
AUTOPAL is associated with automotive lighting, Proforma Invoices,
customer communication, inventory, sales and ERP activities.

Current Phase 2 limitations:
- You do not have access to the AUTOPAL database.
- You do not know current stock, prices, balances, invoice values or live company records.
- You must not claim that you accessed the ERP.
- You must not invent business figures.

Instructions:
1. Give clear and professional answers.
2. Draft business emails and WhatsApp messages when requested.
3. Explain ERP, PI, inventory and business concepts simply.
4. State clearly when actual ERP data is required.
5. Do not fabricate customer names, prices, tax rates, quantities or company records.
6. Keep ordinary answers concise unless details are requested.
`.trim()
const PUBLIC_REQUEST_LOG_PATHS = new Set([
  '/robots.txt',
  '/privacy.html',
  '/terms.html',
  '/data-deletion.html',
])
const MENU_SCREEN_IDS = [
  'dashboard',
  'create-pi',
  'pi-preview',
  'whatsapp-pi',
  'customers',
  'products',
  'r-market-rates',
  'customer-discounts',
  'ai-assistant',
  ERP_INTELLIGENCE_SCREEN_ID,
  'admin-panel',
  ...(AI_TEST_CONSOLE_ENABLED ? ['ai-test-console'] : []),
]
const USER_ASSIGNABLE_SCREEN_IDS = MENU_SCREEN_IDS.filter(
  (screenId) => screenId !== 'admin-panel' && screenId !== 'ai-test-console',
)
const DEFAULT_USER_SCREEN_IDS = MENU_SCREEN_IDS.filter(
  (screenId) =>
    screenId !== 'admin-panel' &&
    screenId !== 'ai-test-console' &&
    screenId !== ERP_INTELLIGENCE_SCREEN_ID,
)

const useDatabaseSSL =
  process.env.DATABASE_SSL === 'true' ||
  process.env.DATABASE_URL?.includes('sslmode=require')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useDatabaseSSL ? { rejectUnauthorized: false } : undefined,
})

const app = express()
app.set('trust proxy', true)

app.use((request, response, next) => {
  if (PUBLIC_REQUEST_LOG_PATHS.has(request.path)) {
    response.on('finish', () => {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          method: request.method,
          path: request.path,
          userAgent: request.get('user-agent') ?? '',
          status: response.statusCode,
        }),
      )
    })
  }

  next()
})

app.get('/robots.txt', (_request, response) => {
  response.type('text/plain')

  if (!fs.existsSync(ROBOTS_TXT_PATH)) {
    response.status(404).send('robots.txt not found')
    return
  }

  response.sendFile(ROBOTS_TXT_PATH)
})

if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH))
}

app.use(express.urlencoded({ extended: false }))
app.use(express.json())

app.use((request, response, next) => {
  const allowedOrigins = new Set(
    [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      ...(process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ],
  )
  const origin = request.headers.origin

  if (origin && allowedOrigins.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
  }

  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-autopal-user')

  if (request.method === 'OPTIONS') {
    response.sendStatus(204)
    return
  }

  next()
})

const toNumber = (value) => Number(value ?? 0)

const toNullableInteger = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  return Number(value)
}

const toNullableDecimal = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const toNullableDate = (value) => {
  if (!value) {
    return null
  }

  return String(value).trim().slice(0, 10)
}

const getRequestIPAddress = (request) => {
  const forwardedFor = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim()
  const rawAddress =
    forwardedFor ||
    request.ip ||
    request.socket?.remoteAddress ||
    ''

  return rawAddress.replace(/^::ffff:/, '')
}

const isPrivateIPAddress = (ipAddress) =>
  !ipAddress ||
  ipAddress === '::1' ||
  ipAddress === '127.0.0.1' ||
  ipAddress.startsWith('10.') ||
  ipAddress.startsWith('192.168.') ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipAddress)

const getGoogleMapsUrl = (latitude, longitude) =>
  latitude === null || longitude === null
    ? ''
    : `https://www.google.com/maps?q=${latitude},${longitude}`

const isWebLocation = (value) => /^https?:\/\//i.test(String(value ?? ''))

const getGoogleMapsSearchUrl = (value) => {
  const locationText = String(value ?? '').trim()

  if (!locationText) {
    return ''
  }

  if (isWebLocation(locationText)) {
    return locationText
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    locationText,
  )}`
}

const getLocationFromCoordinates = (
  latitudeValue,
  longitudeValue,
  ipAddress = '',
) => {
  const latitude = toNullableDecimal(latitudeValue)
  const longitude = toNullableDecimal(longitudeValue)

  if (latitude === null || longitude === null) {
    return null
  }

  return {
    ipAddress: String(ipAddress ?? ''),
    latitude,
    locationText: getGoogleMapsUrl(latitude, longitude),
    longitude,
  }
}

const fetchLocationJSON = async (url) => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3500),
    })

    if (!response.ok) {
      return null
    }

    return await response.json()
  } catch {
    return null
  }
}

const lookupIPLocation = async (ipAddress) => {
  const lookupTarget = isPrivateIPAddress(ipAddress) ? '' : encodeURIComponent(ipAddress)
  const lookupProviders = [
    {
      mapLocation: (result) =>
        getLocationFromCoordinates(
          result?.latitude,
          result?.longitude,
          result?.ip ?? ipAddress,
        ),
      url: lookupTarget
        ? `https://ipapi.co/${lookupTarget}/json/`
        : 'https://ipapi.co/json/',
    },
    {
      mapLocation: (result) =>
        result?.success === false
          ? null
          : getLocationFromCoordinates(
              result?.latitude,
              result?.longitude,
              result?.ip ?? ipAddress,
            ),
      url: lookupTarget ? `https://ipwho.is/${lookupTarget}` : 'https://ipwho.is/',
    },
    {
      mapLocation: (result) =>
        getLocationFromCoordinates(
          result?.latitude,
          result?.longitude,
          result?.ip ?? ipAddress,
        ),
      url: lookupTarget
        ? `https://get.geojs.io/v1/ip/geo/${lookupTarget}.json`
        : 'https://get.geojs.io/v1/ip/geo.json',
    },
    {
      mapLocation: (result) =>
        result?.status !== 'success'
          ? null
          : getLocationFromCoordinates(
              result?.lat,
              result?.lon,
              result?.query ?? ipAddress,
            ),
      url: `http://ip-api.com/json/${lookupTarget}?fields=status,message,lat,lon,city,regionName,country,query`,
    },
  ]

  for (const provider of lookupProviders) {
    const result = await fetchLocationJSON(provider.url)
    const location = result ? provider.mapLocation(result) : null

    if (location) {
      return location
    }
  }

  return null
}

let metaDataDeletionSchemaPromise

const ensureMetaDataDeletionSchema = async () => {
  if (!metaDataDeletionSchemaPromise) {
    metaDataDeletionSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS ${META_DATA_DELETION_TABLE_NAME} (
        id bigserial PRIMARY KEY,
        meta_user_id varchar(120) NOT NULL,
        confirmation_code varchar(80) NOT NULL UNIQUE,
        status varchar(40) NOT NULL DEFAULT 'requested',
        requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at timestamptz,
        notes text
      )
    `)
  }

  try {
    await metaDataDeletionSchemaPromise
  } catch (error) {
    metaDataDeletionSchemaPromise = undefined
    throw error
  }
}

const decodeBase64URL = (value) => {
  const encodedValue = String(value ?? '').trim()

  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encodedValue)) {
    throw new Error('Invalid base64url value.')
  }

  const base64Value = encodedValue
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encodedValue.length / 4) * 4, '=')

  return Buffer.from(base64Value, 'base64')
}

const verifyMetaSignedRequest = (signedRequest) => {
  const appSecret = String(process.env.META_APP_SECRET ?? '').trim()

  if (!appSecret) {
    return {
      errorStatus: 503,
      message: 'Meta data deletion callback is not configured.',
    }
  }

  const parts = String(signedRequest ?? '').split('.')

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { errorStatus: 400, message: 'Invalid signed request.' }
  }

  try {
    const signature = decodeBase64URL(parts[0])
    const payloadBuffer = decodeBase64URL(parts[1])
    const expectedSignature = createHmac('sha256', appSecret)
      .update(parts[1])
      .digest()

    if (
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(signature, expectedSignature)
    ) {
      return { errorStatus: 403, message: 'Invalid signed request signature.' }
    }

    const payload = JSON.parse(payloadBuffer.toString('utf8'))
    const algorithm = String(payload.algorithm ?? '').toUpperCase()

    if (algorithm && algorithm !== 'HMAC-SHA256') {
      return { errorStatus: 400, message: 'Unsupported signed request algorithm.' }
    }

    return { payload }
  } catch {
    return { errorStatus: 400, message: 'Invalid signed request payload.' }
  }
}

const getMetaUserIdFromPayload = (payload) =>
  String(
    payload?.user_id ??
      payload?.userID ??
      payload?.userId ??
      payload?.user?.id ??
      '',
  ).trim()

const createConfirmationCode = () => randomBytes(18).toString('base64url')

const createMetaDataDeletionRequest = async (metaUserId) => {
  await ensureMetaDataDeletionSchema()

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const confirmationCode = createConfirmationCode()

    try {
      const result = await pool.query(
        `
          INSERT INTO ${META_DATA_DELETION_TABLE_NAME}
            (meta_user_id, confirmation_code, status)
          VALUES
            ($1, $2, 'requested')
          RETURNING confirmation_code, status, requested_at, completed_at
        `,
        [metaUserId, confirmationCode],
      )

      return result.rows[0]
    } catch (error) {
      if (error?.code === '23505') {
        continue
      }

      throw error
    }
  }

  throw new Error('Unable to create a unique confirmation code.')
}

const getPublicBaseUrl = (request) => {
  const configuredBaseUrl = String(
    process.env.PUBLIC_APP_URL ?? process.env.APP_PUBLIC_URL ?? '',
  ).trim()

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '')
  }

  const forwardedProto = String(request.get('x-forwarded-proto') ?? '')
    .split(',')[0]
    .trim()
  const forwardedHost = String(request.get('x-forwarded-host') ?? '')
    .split(',')[0]
    .trim()
  const protocol = forwardedProto || request.protocol || 'https'
  const host = forwardedHost || request.get('host') || 'autopal-erp.onrender.com'

  return `${protocol}://${host}`
}

const mapMetaDataDeletionStatusRow = (row) => ({
  confirmation_code: row.confirmation_code,
  status: row.status,
  requested_at: row.requested_at
    ? new Date(row.requested_at).toISOString()
    : null,
  completed_at: row.completed_at
    ? new Date(row.completed_at).toISOString()
    : null,
})

let userAdministrationSchemaPromise

const ensureUserAdministrationSchema = async () => {
  if (!userAdministrationSchemaPromise) {
    userAdministrationSchemaPromise = (async () => {
      await pool.query(`
        ALTER TABLE ${USER_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
          ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT CURRENT_TIMESTAMP
      `)
      await pool.query(`
        UPDATE ${USER_TABLE_NAME}
        SET
          is_active = COALESCE(is_active, TRUE),
          is_admin = COALESCE(is_admin, FALSE),
          created_at = COALESCE(created_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
      `)
      await pool.query(`
        UPDATE ${USER_TABLE_NAME}
        SET is_admin = TRUE
        WHERE LOWER(user_name) IN ('admin', 'administrator', 'dileep')
      `)
      await pool.query(`
        WITH first_user AS (
          SELECT user_name
          FROM ${USER_TABLE_NAME}
          ORDER BY user_name ASC
          LIMIT 1
        )
        UPDATE ${USER_TABLE_NAME}
        SET is_admin = TRUE
        WHERE user_name = (SELECT user_name FROM first_user)
          AND NOT EXISTS (
            SELECT 1
            FROM ${USER_TABLE_NAME}
            WHERE is_admin = TRUE
          )
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${USER_RIGHTS_TABLE_NAME} (
          user_name varchar(50) NOT NULL REFERENCES ${USER_TABLE_NAME}(user_name) ON DELETE CASCADE,
          screen_id varchar(80) NOT NULL,
          can_access boolean NOT NULL DEFAULT TRUE,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_name, screen_id)
        )
      `)
      await pool.query(`
        DO $$
        BEGIN
          IF to_regclass('tran_userlog') IS NULL
            AND to_regclass('user_login_log') IS NOT NULL THEN
            ALTER TABLE user_login_log RENAME TO tran_userlog;
          END IF;
        END $$;
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${USER_LOGIN_LOG_TABLE_NAME} (
          id bigserial PRIMARY KEY,
          user_name varchar(50) NOT NULL,
          login_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          location_text varchar(255),
          latitude numeric(10, 7),
          longitude numeric(10, 7),
          ip_address varchar(80),
          user_agent text
        )
      `)
      await pool.query(`
        ALTER TABLE ${USER_LOGIN_LOG_TABLE_NAME}
          ADD COLUMN IF NOT EXISTS location_text varchar(500),
          ADD COLUMN IF NOT EXISTS latitude numeric(10, 7),
          ADD COLUMN IF NOT EXISTS longitude numeric(10, 7),
          ADD COLUMN IF NOT EXISTS ip_address varchar(80),
          ADD COLUMN IF NOT EXISTS user_agent text
      `)
      await pool.query(`
        ALTER TABLE ${USER_LOGIN_LOG_TABLE_NAME}
          ALTER COLUMN location_text TYPE varchar(500)
      `)
      await pool.query(`
        UPDATE ${USER_LOGIN_LOG_TABLE_NAME}
        SET location_text = 'https://www.google.com/maps?q=' || latitude || ',' || longitude
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND (
            location_text IS NULL
            OR location_text = ''
            OR location_text !~* '^https?://'
          )
      `)
      await pool.query(`
        UPDATE ${USER_LOGIN_LOG_TABLE_NAME}
        SET location_text = 'https://www.google.com/maps/search/?api=1&query=' || REPLACE(location_text, ' ', '%20')
        WHERE latitude IS NULL
          AND longitude IS NULL
          AND location_text IS NOT NULL
          AND location_text <> ''
          AND location_text !~* '^https?://'
      `)
    })()
  }

  try {
    await userAdministrationSchemaPromise
  } catch (error) {
    userAdministrationSchemaPromise = undefined
    throw error
  }
}

const sanitizeUserRights = (rights = []) =>
  Array.from(
    new Set(
      rights.filter(
        (right) => MENU_SCREEN_IDS.includes(right) && right !== 'admin-panel',
      ),
    ),
  )

const normalizeRights = (rights = [], isAdmin = false) => {
  if (isAdmin) {
    return [...MENU_SCREEN_IDS]
  }

  const allowedRights = sanitizeUserRights(rights)

  return allowedRights.length > 0 ? allowedRights : [...DEFAULT_USER_SCREEN_IDS]
}

const getUserRights = async (userName, isAdmin = false, queryable = pool) => {
  if (isAdmin) {
    return [...MENU_SCREEN_IDS]
  }

  const result = await queryable.query(
    `
      SELECT screen_id, can_access
      FROM ${USER_RIGHTS_TABLE_NAME}
      WHERE LOWER(user_name) = LOWER($1)
    `,
    [userName],
  )

  if (result.rowCount === 0) {
    return [...DEFAULT_USER_SCREEN_IDS]
  }

  return sanitizeUserRights(
    result.rows
      .filter((row) => Boolean(row.can_access))
      .map((row) => row.screen_id),
  )
}

const saveUserRights = async (userName, rights = [], queryable = pool) => {
  const requestedRights = new Set(sanitizeUserRights(rights))

  await queryable.query(
    `DELETE FROM ${USER_RIGHTS_TABLE_NAME} WHERE LOWER(user_name) = LOWER($1)`,
    [userName],
  )

  for (const screenId of USER_ASSIGNABLE_SCREEN_IDS) {
    await queryable.query(
      `
        INSERT INTO ${USER_RIGHTS_TABLE_NAME}
          (user_name, screen_id, can_access)
        VALUES
          ($1, $2, $3)
        ON CONFLICT (user_name, screen_id)
        DO UPDATE SET
          can_access = EXCLUDED.can_access,
          updated_at = CURRENT_TIMESTAMP
      `,
      [userName, screenId, requestedRights.has(screenId)],
    )
  }
}

const getAdminUser = async (request) => {
  const adminUserName = String(request.get('x-autopal-user') ?? '').trim()

  if (!adminUserName) {
    return null
  }

  const result = await pool.query(
    `
      SELECT user_name, is_admin, is_active
      FROM ${USER_TABLE_NAME}
      WHERE LOWER(user_name) = LOWER($1)
      LIMIT 1
    `,
    [adminUserName],
  )

  const user = result.rows[0]

  if (!user || !Boolean(user.is_active) || !Boolean(user.is_admin)) {
    return null
  }

  return user
}

const requireAdminUser = async (request, response) => {
  await ensureUserAdministrationSchema()
  const user = await getAdminUser(request)

  if (!user) {
    response.status(403).json({ message: 'Admin access is required.' })
    return null
  }

  return user
}

const productColumns = `
  id,
  code,
  description,
  hsn_code,
  category,
  market,
  unit,
  gst_percent,
  created_at,
  updated_at
`

const marketColumns = `
  market_code,
  market_name,
  is_active
`

const companyColumns = `
  comp_code,
  company_id,
  company_name,
  legal_name,
  address,
  gstin,
  pan,
  state_name,
  state_code,
  cin,
  website,
  iec,
  phone,
  email,
  bank_name,
  bank_branch,
  account_name,
  account_number,
  ifsc,
  pi_prefix,
  is_active
`

const mapProductRow = (row) => ({
  id: String(row.id),
  code: row.code,
  description: row.description,
  hsnCode: row.hsn_code,
  category: row.category,
  market: Number(row.market),
  unit: row.unit,
  gstPercent: Number(row.gst_percent),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapMarketRow = (row) => ({
  code: Number(row.market_code),
  name: row.market_name,
  isActive: Boolean(row.is_active),
})

const mapCompanyRow = (row) => ({
  compCode: Number(row.comp_code),
  id: row.company_id,
  name: row.company_name,
  legalName: row.legal_name,
  address: row.address,
  gstin: row.gstin,
  pan: row.pan,
  state: row.state_name,
  stateCode: row.state_code,
  cin: row.cin ?? '',
  website: row.website ?? '',
  iec: row.iec ?? '',
  phone: row.phone ?? '',
  email: row.email ?? '',
  piPrefix: row.pi_prefix,
  bankDetails: {
    bankName: row.bank_name ?? '',
    branch: row.bank_branch ?? '',
    accountName: row.account_name ?? '',
    accountNumber: row.account_number ?? '',
    ifsc: row.ifsc ?? '',
  },
  isActive: Boolean(row.is_active),
})

const customerSelectColumns = `
  c.customer_id,
  c.cust_code,
  c.cust_name,
  c.corr_address,
  c.corr_city_code,
  corr_city.city_name AS corr_city_name,
  c.corr_state_code,
  corr_state.state_name AS corr_state_name,
  c.corr_country_code,
  corr_country.country_name AS corr_country_name,
  c.corr_pin_code,
  c.corr_tel,
  c.corr_fax,
  c.corr_email,
  c.ship_address,
  c.ship_city_code,
  ship_city.city_name AS ship_city_name,
  c.ship_state_code,
  ship_state.state_name AS ship_state_name,
  c.ship_country_code,
  ship_country.country_name AS ship_country_name,
  c.ship_pin_code,
  c.ship_tel,
  c.ship_fax,
  c.ship_email,
  c.website,
  c.market_code,
  market.market_name,
  c.zone,
  c.party_type_code,
  party.party_type,
  c.gstin_no,
  TO_CHAR(c.gst_date, 'YYYY-MM-DD') AS gst_date,
  c.pan_no,
  c.contact_person,
  c.mobile_no,
  c.credit_days,
  c.credit_limit,
  c.remarks,
  c.is_active,
  c.created_at,
  c.updated_at
`

const customerJoinClause = `
  FROM ${CUSTOMER_TABLE_NAME} c
  LEFT JOIN ${CITY_TABLE_NAME} corr_city
    ON corr_city.city_id = c.corr_city_code
  LEFT JOIN ${STATE_TABLE_NAME} corr_state
    ON corr_state.state_id = c.corr_state_code
  LEFT JOIN ${COUNTRY_TABLE_NAME} corr_country
    ON corr_country.country_id = c.corr_country_code
  LEFT JOIN ${CITY_TABLE_NAME} ship_city
    ON ship_city.city_id = c.ship_city_code
  LEFT JOIN ${STATE_TABLE_NAME} ship_state
    ON ship_state.state_id = c.ship_state_code
  LEFT JOIN ${COUNTRY_TABLE_NAME} ship_country
    ON ship_country.country_id = c.ship_country_code
  LEFT JOIN ${MARKET_TABLE_NAME} market
    ON market.market_code = c.market_code
  LEFT JOIN ${PARTY_TYPE_TABLE_NAME} party
    ON party.party_type_code = c.party_type_code
`

const mapCustomerRow = (row) => ({
  customerId: Number(row.customer_id),
  custCode: Number(row.cust_code),
  custName: row.cust_name,
  corrAddress: row.corr_address,
  corrCityCode: Number(row.corr_city_code),
  corrCityName: row.corr_city_name ?? '',
  corrStateCode: Number(row.corr_state_code),
  corrStateName: row.corr_state_name ?? '',
  corrCountryCode: Number(row.corr_country_code),
  corrCountryName: row.corr_country_name ?? '',
  corrPinCode: Number(row.corr_pin_code ?? 0),
  corrTel: row.corr_tel ?? '',
  corrFax: row.corr_fax ?? '',
  corrEmail: row.corr_email ?? '',
  shipAddress: row.ship_address,
  shipCityCode: Number(row.ship_city_code),
  shipCityName: row.ship_city_name ?? '',
  shipStateCode: Number(row.ship_state_code),
  shipStateName: row.ship_state_name ?? '',
  shipCountryCode: Number(row.ship_country_code),
  shipCountryName: row.ship_country_name ?? '',
  shipPinCode: Number(row.ship_pin_code ?? 0),
  shipTel: row.ship_tel ?? '',
  shipFax: row.ship_fax ?? '',
  shipEmail: row.ship_email ?? '',
  website: row.website ?? '',
  marketCode: Number(row.market_code),
  marketName: row.market_name ?? '',
  zone: row.zone ?? '',
  partyTypeCode: Number(row.party_type_code),
  partyTypeName: row.party_type ?? '',
  gstinNo: row.gstin_no,
  gstDate: row.gst_date ?? '',
  panNo: row.pan_no ?? '',
  contactPerson: row.contact_person ?? '',
  mobileNo: row.mobile_no ?? '',
  creditDays: Number(row.credit_days ?? 0),
  creditLimit: Number(row.credit_limit ?? 0),
  remarks: row.remarks ?? '',
  isActive: Boolean(row.is_active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapLookupRow = (row) => ({
  code: Number(row.code),
  name: row.name,
  parentCode:
    row.parent_code === null || row.parent_code === undefined
      ? undefined
      : Number(row.parent_code),
})

const normalizeCustomerPayload = (payload) => {
  const corrCityCode = Number(
    payload.corrCityCode ?? payload.corr_city_code ?? 0,
  )
  const corrStateCode = Number(
    payload.corrStateCode ?? payload.corr_state_code ?? 0,
  )
  const corrCountryCode = Number(
    payload.corrCountryCode ?? payload.corr_country_code ?? 0,
  )
  const corrAddress = String(
    payload.corrAddress ?? payload.corr_address ?? '',
  ).trim()

  return {
    custCode: Number(payload.custCode ?? payload.cust_code ?? 0),
    custName: String(payload.custName ?? payload.cust_name ?? '').trim(),
    corrAddress,
    corrCityCode,
    corrStateCode,
    corrCountryCode,
    corrPinCode: toNullableInteger(
      payload.corrPinCode ?? payload.corr_pin_code,
    ),
    corrTel: String(payload.corrTel ?? payload.corr_tel ?? '').trim(),
    corrFax: String(payload.corrFax ?? payload.corr_fax ?? '').trim(),
    corrEmail: String(payload.corrEmail ?? payload.corr_email ?? '').trim(),
    shipAddress: String(
      payload.shipAddress ?? payload.ship_address ?? corrAddress,
    ).trim(),
    shipCityCode: Number(
      payload.shipCityCode ?? payload.ship_city_code ?? corrCityCode,
    ),
    shipStateCode: Number(
      payload.shipStateCode ?? payload.ship_state_code ?? corrStateCode,
    ),
    shipCountryCode: Number(
      payload.shipCountryCode ?? payload.ship_country_code ?? corrCountryCode,
    ),
    shipPinCode: toNullableInteger(
      payload.shipPinCode ?? payload.ship_pin_code ?? payload.corrPinCode,
    ),
    shipTel: String(
      payload.shipTel ?? payload.ship_tel ?? payload.corrTel ?? '',
    ).trim(),
    shipFax: String(
      payload.shipFax ?? payload.ship_fax ?? payload.corrFax ?? '',
    ).trim(),
    shipEmail: String(
      payload.shipEmail ?? payload.ship_email ?? payload.corrEmail ?? '',
    ).trim(),
    website: String(payload.website ?? '').trim(),
    marketCode: Number(payload.marketCode ?? payload.market_code ?? 0),
    zone: String(payload.zone ?? '').trim(),
    partyTypeCode: Number(
      payload.partyTypeCode ?? payload.party_type_code ?? 0,
    ),
    gstinNo: String(payload.gstinNo ?? payload.gstin_no ?? '').trim(),
    gstDate: toNullableDate(payload.gstDate ?? payload.gst_date),
    panNo: String(payload.panNo ?? payload.pan_no ?? '').trim(),
    contactPerson: String(
      payload.contactPerson ?? payload.contact_person ?? '',
    ).trim(),
    mobileNo: String(payload.mobileNo ?? payload.mobile_no ?? '').trim(),
    creditDays: Number(payload.creditDays ?? payload.credit_days ?? 0),
    creditLimit: Number(payload.creditLimit ?? payload.credit_limit ?? 0),
    remarks: String(payload.remarks ?? '').trim(),
    isActive: Boolean(payload.isActive ?? payload.is_active ?? true),
  }
}

const validateLookupCode = async (tableName, codeColumn, code) => {
  const result = await pool.query(
    `
      SELECT ${codeColumn}
      FROM ${tableName}
      WHERE ${codeColumn} = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [code],
  )

  return result.rowCount > 0
}

const validateCustomer = async (customer, existingCustomerId = null) => {
  const errors = []

  if (!Number.isInteger(customer.custCode) || customer.custCode <= 0) {
    errors.push('Customer code is required.')
  }

  if (!customer.custName) {
    errors.push('Customer name is required.')
  }

  if (!customer.corrAddress) {
    errors.push('Correspondence address is required.')
  }

  if (!customer.shipAddress) {
    errors.push('Shipping address is required.')
  }

  if (customer.gstinNo.length !== 15) {
    errors.push('GSTIN must be exactly 15 characters.')
  }

  if (customer.panNo && customer.panNo.length !== 10) {
    errors.push('PAN must be exactly 10 characters.')
  }

  if (!Number.isInteger(customer.creditDays) || customer.creditDays < 0) {
    errors.push('Credit days must be 0 or greater.')
  }

  const integerFields = [
    ['Correspondence city', customer.corrCityCode],
    ['Correspondence state', customer.corrStateCode],
    ['Correspondence country', customer.corrCountryCode],
    ['Shipping city', customer.shipCityCode],
    ['Shipping state', customer.shipStateCode],
    ['Shipping country', customer.shipCountryCode],
  ]

  integerFields.forEach(([label, value]) => {
    if (!Number.isInteger(value) || value < 1) {
      errors.push(`${label} is required.`)
    }
  })

  if (!Number.isFinite(customer.creditLimit) || customer.creditLimit < 0) {
    errors.push('Credit limit must be a valid positive number.')
  }

  if (customer.gstDate && Number.isNaN(Date.parse(customer.gstDate))) {
    errors.push('GST date must be a valid date.')
  }

  if (!Number.isInteger(customer.marketCode)) {
    errors.push('Market is required.')
  } else if (
    !(await validateLookupCode(
      MARKET_TABLE_NAME,
      'market_code',
      customer.marketCode,
    ))
  ) {
    errors.push('Select a valid market.')
  }

  if (!Number.isInteger(customer.partyTypeCode)) {
    errors.push('Party type is required.')
  } else if (
    !(await validateLookupCode(
      PARTY_TYPE_TABLE_NAME,
      'party_type_code',
      customer.partyTypeCode,
    ))
  ) {
    errors.push('Select a valid party type.')
  }

  const lookupChecks = [
    [CITY_TABLE_NAME, 'city_id', customer.corrCityCode, 'correspondence city'],
    [STATE_TABLE_NAME, 'state_id', customer.corrStateCode, 'correspondence state'],
    [
      COUNTRY_TABLE_NAME,
      'country_id',
      customer.corrCountryCode,
      'correspondence country',
    ],
    [CITY_TABLE_NAME, 'city_id', customer.shipCityCode, 'shipping city'],
    [STATE_TABLE_NAME, 'state_id', customer.shipStateCode, 'shipping state'],
    [
      COUNTRY_TABLE_NAME,
      'country_id',
      customer.shipCountryCode,
      'shipping country',
    ],
  ]

  for (const [tableName, codeColumn, code, label] of lookupChecks) {
    if (
      Number.isInteger(code) &&
      code > 0 &&
      !(await validateLookupCode(tableName, codeColumn, code))
    ) {
      errors.push(`Select a valid ${label}.`)
    }
  }

  if (customer.custCode > 32767) {
    errors.push('Customer code cannot exceed 32767.')
  }

  if (customer.custCode > 0) {
    const duplicateCodeResult = await pool.query(
      `
        SELECT customer_id
        FROM ${CUSTOMER_TABLE_NAME}
        WHERE cust_code = $1
          AND ($2::text IS NULL OR customer_id::text <> $2::text)
        LIMIT 1
      `,
      [customer.custCode, existingCustomerId],
    )

    if (duplicateCodeResult.rowCount > 0) {
      errors.push('Customer code already exists.')
    }
  }

  if (
    customer.custName &&
    customer.corrAddress &&
    Number.isInteger(customer.corrCityCode) &&
    customer.corrCityCode > 0
  ) {
    const duplicateCustomerResult = await pool.query(
      `
        SELECT customer_id
        FROM ${CUSTOMER_TABLE_NAME}
        WHERE LOWER(BTRIM(cust_name)) = LOWER(BTRIM($1::text))
          AND LOWER(BTRIM(corr_address)) = LOWER(BTRIM($2::text))
          AND corr_city_code = $3
          AND ($4::text IS NULL OR customer_id::text <> $4::text)
        LIMIT 1
      `,
      [
        customer.custName,
        customer.corrAddress,
        customer.corrCityCode,
        existingCustomerId,
      ],
    )

    if (duplicateCustomerResult.rowCount > 0) {
      errors.push(CUSTOMER_DUPLICATE_MESSAGE)
    }
  }

  return errors
}

const getCustomerValues = (customer) => [
  customer.custCode,
  customer.custName,
  customer.corrAddress,
  customer.corrCityCode,
  customer.corrStateCode,
  customer.corrCountryCode,
  customer.corrPinCode,
  customer.corrTel || null,
  customer.corrFax || null,
  customer.corrEmail || null,
  customer.shipAddress,
  customer.shipCityCode,
  customer.shipStateCode,
  customer.shipCountryCode,
  customer.shipPinCode,
  customer.shipTel || null,
  customer.shipFax || null,
  customer.shipEmail || null,
  customer.website || null,
  customer.marketCode,
  customer.zone || null,
  customer.partyTypeCode,
  customer.gstinNo,
  customer.gstDate,
  customer.panNo || null,
  customer.contactPerson || null,
  customer.mobileNo || null,
  customer.creditDays,
  customer.creditLimit,
  customer.remarks || null,
  customer.isActive,
]

const getCustomerById = async (customerId) => {
  const result = await pool.query(
    `
      SELECT ${customerSelectColumns}
      ${customerJoinClause}
      WHERE c.customer_id::text = $1
    `,
    [customerId],
  )

  return result.rows[0] ? mapCustomerRow(result.rows[0]) : null
}

const normalizeProductPayload = (payload) => ({
  code: String(payload.code ?? '').trim(),
  description: String(payload.description ?? '').trim(),
  hsnCode: String(payload.hsnCode ?? payload.hsn_code ?? '').trim(),
  category: String(payload.category ?? '').trim(),
  market: Number(payload.market ?? payload.MARKET ?? 0),
  unit: String(payload.unit ?? '').trim(),
  gstPercent: Number(payload.gstPercent ?? payload.gst_percent ?? 0),
})

const validateProduct = async (product, existingProductId = null) => {
  const errors = []

  if (!product.code) {
    errors.push('Product code is required.')
  }

  if (!product.description) {
    errors.push('Product description is required.')
  }

  if (!product.hsnCode) {
    errors.push('HSN code is required.')
  }

  if (!product.category) {
    errors.push('Category is required.')
  }

  if (!Number.isInteger(product.market)) {
    errors.push('Market is required.')
  } else {
    const marketResult = await pool.query(
      `
        SELECT market_code
        FROM ${MARKET_TABLE_NAME}
        WHERE market_code = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [product.market],
    )

    if (marketResult.rowCount === 0) {
      errors.push('Select a valid active market.')
    }
  }

  if (!product.unit) {
    errors.push('Unit is required.')
  }

  if (!Number.isFinite(product.gstPercent) || product.gstPercent < 0) {
    errors.push('GST percent must be a valid positive number.')
  }

  if (product.code) {
    const duplicateResult = await pool.query(
      `
        SELECT id
        FROM ${PRODUCT_TABLE_NAME}
        WHERE LOWER(code) = LOWER($1)
          AND ($2::text IS NULL OR id::text <> $2::text)
        LIMIT 1
      `,
      [product.code, existingProductId],
    )

    if (duplicateResult.rowCount > 0) {
      errors.push('Product code already exists.')
    }
  }

  return errors
}

const tradingRateColumns = `
  id,
  TO_CHAR(eff_date, 'YYYY-MM-DD') AS eff_date,
  product_code,
  w_rate,
  sw_rate,
  r_rate,
  i_rate,
  oth1_rate,
  oth2_rate,
  dis_amt,
  unit_name,
  family,
  mrp,
  std_pkg,
  cpno,
  min_stk_qty,
  disp_mrp,
  basic_rate,
  plant_name,
  cat_desc,
  comp_code
`

const mapTradingRateRow = (row) => ({
  id: Number(row.id),
  effDate: row.eff_date,
  productCode: row.product_code,
  wRate: Number(row.w_rate),
  swRate: Number(row.sw_rate),
  rRate: Number(row.r_rate),
  iRate: Number(row.i_rate),
  oth1Rate: Number(row.oth1_rate),
  oth2Rate: Number(row.oth2_rate),
  disAmt: Number(row.dis_amt),
  unitName: row.unit_name,
  family: row.family ?? '',
  mrp: Number(row.mrp),
  stdPkg: Number(row.std_pkg),
  cpno: row.cpno ?? '',
  minStkQty: Number(row.min_stk_qty),
  dispMrp: Number(row.disp_mrp),
  basicRate: Number(row.basic_rate),
  plantName: row.plant_name,
  catDesc: row.cat_desc,
  compCode: Number(row.comp_code),
})

const normalizeTradingRatePayload = (payload) => ({
  effDate: String(payload.effDate ?? payload.eff_date ?? payload.EFF_DATE ?? '')
    .trim()
    .slice(0, 10),
  productCode: String(
    payload.productCode ?? payload.product_code ?? payload.PRODUCT_CODE ?? '',
  ).trim(),
  wRate: toNumber(payload.wRate ?? payload.w_rate ?? payload.W_RATE),
  swRate: toNumber(payload.swRate ?? payload.sw_rate ?? payload.SW_RATE),
  rRate: toNumber(payload.rRate ?? payload.r_rate ?? payload.R_RATE),
  iRate: toNumber(payload.iRate ?? payload.i_rate ?? payload.I_RATE),
  oth1Rate: toNumber(payload.oth1Rate ?? payload.oth1_rate ?? payload.OTH1_RATE),
  oth2Rate: toNumber(payload.oth2Rate ?? payload.oth2_rate ?? payload.OTH2_RATE),
  disAmt: toNumber(payload.disAmt ?? payload.dis_amt ?? payload.DIS_AMT),
  unitName: String(
    payload.unitName ?? payload.unit_name ?? payload.UNIT_NAME ?? '',
  ).trim(),
  family: String(payload.family ?? payload.FAMILY ?? '').trim(),
  mrp: toNumber(payload.mrp ?? payload.MRP),
  stdPkg: toNumber(payload.stdPkg ?? payload.std_pkg ?? payload.STD_PKG),
  cpno: String(payload.cpno ?? payload.CPNO ?? '').trim(),
  minStkQty: toNumber(
    payload.minStkQty ?? payload.min_stk_qty ?? payload.MIN_STK_QTY,
  ),
  dispMrp: toNumber(payload.dispMrp ?? payload.disp_mrp),
  basicRate: toNumber(payload.basicRate ?? payload.basic_rate),
  plantName: String(
    payload.plantName ?? payload.plant_name ?? payload.PLANT_NAME ?? '',
  ).trim(),
  catDesc: String(
    payload.catDesc ?? payload.cat_desc ?? payload.CAT_DESC ?? '',
  ).trim(),
  compCode: toNumber(payload.compCode ?? payload.comp_code),
})

const getTradingRateCompanyCodeForCategory = (
  category,
  fallbackCompanyCode = 1,
) => {
  const normalizedCategory = String(category ?? '').trim().toLowerCase()

  if (normalizedCategory === 'head lamp') {
    return 2
  }

  if (normalizedCategory === 'halogen bulbs') {
    return 1
  }

  return fallbackCompanyCode
}

const enrichTradingRateFromMasterData = async (rate) => {
  if (!rate.productCode) {
    return rate
  }

  const productResult = await pool.query(
    `
      SELECT category, unit
      FROM ${PRODUCT_TABLE_NAME}
      WHERE LOWER(code) = LOWER($1)
      LIMIT 1
    `,
    [rate.productCode],
  )

  if (productResult.rowCount === 0) {
    return rate
  }

  const product = productResult.rows[0]
  const compCode = getTradingRateCompanyCodeForCategory(
    product.category,
    rate.compCode || 1,
  )
  const companyResult = await pool.query(
    `
      SELECT company_id
      FROM ${COMPANY_TABLE_NAME}
      WHERE comp_code = $1
        AND is_active = TRUE
      LIMIT 1
    `,
    [compCode],
  )

  return {
    ...rate,
    catDesc: product.category ?? rate.catDesc,
    compCode,
    family: product.category ?? rate.family,
    plantName: companyResult.rows[0]?.company_id ?? rate.plantName,
    unitName: product.unit ?? rate.unitName,
  }
}

const validateTradingRate = (rate) => {
  const errors = []
  const requiredTextFields = [
    ['Effective date', rate.effDate],
    ['Product code', rate.productCode],
    ['Unit name', rate.unitName],
    ['Plant name', rate.plantName],
    ['Category description', rate.catDesc],
  ]
  const numericFields = [
    ['W rate', rate.wRate],
    ['SW rate', rate.swRate],
    ['R rate', rate.rRate],
    ['I rate', rate.iRate],
    ['OTH1 rate', rate.oth1Rate],
    ['OTH2 rate', rate.oth2Rate],
    ['Discount amount', rate.disAmt],
    ['MRP', rate.mrp],
    ['Display MRP', rate.dispMrp],
    ['Basic rate', rate.basicRate],
  ]
  const integerFields = [
    ['Standard package', rate.stdPkg],
    ['Minimum stock quantity', rate.minStkQty],
    ['Company code', rate.compCode],
  ]

  requiredTextFields.forEach(([label, value]) => {
    if (!value) {
      errors.push(`${label} is required.`)
    }
  })

  if (rate.effDate && Number.isNaN(Date.parse(rate.effDate))) {
    errors.push('Effective date must be a valid date.')
  }

  if (rate.productCode.length > 16) {
    errors.push('Product code cannot exceed 16 characters.')
  }

  if (rate.unitName.length > 50) {
    errors.push('Unit name cannot exceed 50 characters.')
  }

  if (rate.family.length > 50) {
    errors.push('Family cannot exceed 50 characters.')
  }

  if (rate.cpno.length > 50) {
    errors.push('CPNO cannot exceed 50 characters.')
  }

  if (rate.plantName.length > 50) {
    errors.push('Plant name cannot exceed 50 characters.')
  }

  if (rate.catDesc.length > 100) {
    errors.push('Category description cannot exceed 100 characters.')
  }

  numericFields.forEach(([label, value]) => {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${label} must be a valid positive number.`)
    }
  })

  integerFields.forEach(([label, value]) => {
    if (!Number.isInteger(value) || value < 0) {
      errors.push(`${label} must be a valid positive integer.`)
    }
  })

  if (rate.compCode > 32767) {
    errors.push('Company code cannot exceed 32767.')
  }

  return errors
}

const getTradingRateValues = (rate) => [
  rate.effDate,
  rate.productCode,
  rate.wRate,
  rate.swRate,
  rate.rRate,
  rate.iRate,
  rate.oth1Rate,
  rate.oth2Rate,
  rate.disAmt,
  rate.unitName,
  rate.family || null,
  rate.mrp,
  rate.stdPkg,
  rate.cpno || null,
  rate.minStkQty,
  rate.dispMrp,
  rate.basicRate,
  rate.plantName,
  rate.catDesc,
  rate.compCode,
]

const customerDiscountSelectColumns = `
  cd.id,
  TO_CHAR(cd.eff_date, 'YYYY-MM-DD') AS eff_date,
  cd.cust_code,
  customer.cust_name AS customer_name,
  cd.hl_per,
  cd.halo_per,
  cd.incd_per,
  cd.wiper_per,
  cd.gst_per,
  cd.comp_code,
  cd.is_active,
  cd.created_at,
  cd.updated_at
`

const customerDiscountJoinClause = `
  FROM ${CUSTOMER_DISCOUNT_TABLE_NAME} cd
  LEFT JOIN ${CUSTOMER_TABLE_NAME} customer
    ON customer.cust_code = cd.cust_code
`

const toBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true'
  }

  return Boolean(value)
}

const mapCustomerDiscountRow = (row) => ({
  id: Number(row.id),
  effDate: row.eff_date,
  custCode: Number(row.cust_code),
  customerName: row.customer_name ?? '',
  hlPer: Number(row.hl_per),
  haloPer: Number(row.halo_per),
  incdPer: Number(row.incd_per),
  wiperPer: Number(row.wiper_per),
  gstPer: Number(row.gst_per),
  compCode: Number(row.comp_code),
  isActive: Boolean(row.is_active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const normalizeCustomerDiscountPayload = (payload) => ({
  effDate: String(payload.effDate ?? payload.eff_date ?? payload.EFF_DATE ?? '')
    .trim()
    .slice(0, 10),
  custCode: toNumber(payload.custCode ?? payload.cust_code ?? payload.CUST_CODE),
  hlPer: toNumber(payload.hlPer ?? payload.hl_per ?? payload.HL_PER),
  haloPer: toNumber(payload.haloPer ?? payload.halo_per ?? payload.HALO_PER),
  incdPer: toNumber(payload.incdPer ?? payload.incd_per ?? payload.INCD_PER),
  wiperPer: toNumber(payload.wiperPer ?? payload.wiper_per ?? payload.WIPER_PER),
  gstPer: toNumber(payload.gstPer ?? payload.gst_per ?? payload.GST_PER),
  compCode: toNumber(payload.compCode ?? payload.comp_code ?? payload.COMP_CODE),
  isActive: toBoolean(payload.isActive ?? payload.is_active, true),
})

const validateCustomerDiscount = async (discount) => {
  const errors = []
  const percentageFields = [
    ['HL discount', discount.hlPer],
    ['Bulb discount', discount.haloPer],
    ['Incd discount', discount.incdPer],
    ['Wiper discount', discount.wiperPer],
    ['GST percent', discount.gstPer],
  ]

  if (!discount.effDate) {
    errors.push('Effective date is required.')
  } else if (Number.isNaN(Date.parse(discount.effDate))) {
    errors.push('Effective date must be a valid date.')
  }

  if (!Number.isInteger(discount.custCode) || discount.custCode <= 0) {
    errors.push('Customer is required.')
  } else {
    const customerResult = await pool.query(
      `
        SELECT cust_code
        FROM ${CUSTOMER_TABLE_NAME}
        WHERE cust_code = $1
        LIMIT 1
      `,
      [discount.custCode],
    )

    if (customerResult.rowCount === 0) {
      errors.push('Select a valid customer from Customer Master.')
    }
  }

  percentageFields.forEach(([label, value]) => {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`${label} must be between 0 and 100.`)
    }
  })

  if (
    !Number.isInteger(discount.compCode) ||
    discount.compCode <= 0 ||
    discount.compCode > 32767
  ) {
    errors.push('Company code must be a valid positive integer.')
  }

  return errors
}

const getCustomerDiscountValues = (discount) => [
  discount.effDate,
  discount.custCode,
  discount.hlPer,
  discount.haloPer,
  discount.incdPer,
  discount.wiperPer,
  discount.gstPer,
  discount.compCode,
  discount.isActive,
]

const getCustomerDiscountById = async (discountId, queryable = pool) => {
  const result = await queryable.query(
    `
      SELECT ${customerDiscountSelectColumns}
      ${customerDiscountJoinClause}
      WHERE cd.id::text = $1
    `,
    [discountId],
  )

  return result.rows[0] ? mapCustomerDiscountRow(result.rows[0]) : null
}

const rMarketPIMasterColumns = `
  pi_no,
  TO_CHAR(pi_date, 'YYYY-MM-DD') AS pi_date,
  cust_code,
  pcust_name,
  address,
  city_code,
  state_code,
  contact_no,
  gst_no,
  party_type_code,
  mode_of_transport,
  transporter_code,
  destination,
  basic_value,
  frt_amount,
  scheme_discount,
  round_off,
  grand_total,
  printer_no,
  purch_head,
  pi_series,
  spdis_per,
  spdis_amt,
  net_basic_amount,
  TO_CHAR(del_date, 'YYYY-MM-DD') AS del_date,
  remarks,
  close_yn,
  po_no,
  sch_code,
  inv_type,
  igst_per,
  cgst_per,
  sgst_per,
  igst_amt,
  cgst_amt,
  sgst_amt,
  oth_dis_amt,
  oth_dis_per,
  TO_CHAR(close_date, 'YYYY-MM-DD') AS close_date,
  remark_footer,
  tod_per,
  tod_amt,
  cd_per,
  cd_amt,
  net_taxable_value,
  comp_code,
  (
    SELECT co.company_id
    FROM ${COMPANY_TABLE_NAME} co
    WHERE co.comp_code = ${RMKT_PI_MASTER_TABLE_NAME}.comp_code
    LIMIT 1
  ) AS company_id,
  (
    SELECT co.company_name
    FROM ${COMPANY_TABLE_NAME} co
    WHERE co.comp_code = ${RMKT_PI_MASTER_TABLE_NAME}.comp_code
    LIMIT 1
  ) AS company_name,
  (
    SELECT co.legal_name
    FROM ${COMPANY_TABLE_NAME} co
    WHERE co.comp_code = ${RMKT_PI_MASTER_TABLE_NAME}.comp_code
    LIMIT 1
  ) AS company_legal_name,
  (
    SELECT co.state_code
    FROM ${COMPANY_TABLE_NAME} co
    WHERE co.comp_code = ${RMKT_PI_MASTER_TABLE_NAME}.comp_code
    LIMIT 1
  ) AS company_state_code,
  (
    SELECT c.customer_id
    FROM ${CUSTOMER_TABLE_NAME} c
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_id,
  (
    SELECT c.cust_name
    FROM ${CUSTOMER_TABLE_NAME} c
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_name,
  (
    SELECT c.corr_email
    FROM ${CUSTOMER_TABLE_NAME} c
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_email,
  (
    SELECT c.corr_city_code
    FROM ${CUSTOMER_TABLE_NAME} c
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_city_code,
  (
    SELECT c.corr_state_code
    FROM ${CUSTOMER_TABLE_NAME} c
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_state_code,
  (
    SELECT city.city_name
    FROM ${CUSTOMER_TABLE_NAME} c
    LEFT JOIN ${CITY_TABLE_NAME} city
      ON city.city_id = c.corr_city_code
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_city_name,
  (
    SELECT state.state_name
    FROM ${CUSTOMER_TABLE_NAME} c
    LEFT JOIN ${STATE_TABLE_NAME} state
      ON state.state_id = c.corr_state_code
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS customer_state_name,
  (
    SELECT city.city_name
    FROM ${CITY_TABLE_NAME} city
    WHERE city.city_id = ${RMKT_PI_MASTER_TABLE_NAME}.city_code
    LIMIT 1
  ) AS pi_city_name,
  (
    SELECT state.state_name
    FROM ${STATE_TABLE_NAME} state
    WHERE state.state_id = ${RMKT_PI_MASTER_TABLE_NAME}.state_code
    LIMIT 1
  ) AS pi_state_name,
  (
    SELECT country.country_name
    FROM ${CUSTOMER_TABLE_NAME} c
    LEFT JOIN ${COUNTRY_TABLE_NAME} country
      ON country.country_id = c.corr_country_code
    WHERE c.cust_code = ${RMKT_PI_MASTER_TABLE_NAME}.cust_code
      OR LOWER(c.cust_name) = LOWER(${RMKT_PI_MASTER_TABLE_NAME}.pcust_name)
    LIMIT 1
  ) AS pi_country_name,
  oth_sp_disc,
  oth_spdis_per,
  oth_spdis_amt,
  buy_fly_per,
  buy_fly_amt,
  pcust_disc_per,
  is_active,
  created_by,
  TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
  updated_by,
  TO_CHAR(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at
`

const rMarketPITranColumns = `
  t.pi_no,
  t.product_code,
  t.quantity,
  t.uom_code,
  t.rate,
  t.amount,
  t.rbasic,
  t.drate,
  t.damt,
  t.pi_series,
  t.comp_code,
  t.is_active,
  t.created_by,
  TO_CHAR(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
  t.updated_by,
  TO_CHAR(t.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at,
  p.id AS product_id,
  p.description AS product_description,
  p.hsn_code,
  p.unit AS product_unit,
  p.gst_percent
`

const toText = (value) => String(value ?? '').trim()

const toLimitedText = (value, maxLength) =>
  toText(value).slice(0, maxLength)

const toNumberValue = (value, fallback = 0) => {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? number : fallback
}

const parsePINumberParts = (piNumber) => {
  const value = toText(piNumber)
  const match = value.match(/^(.*?)(\d+)$/)

  if (!match) {
    return {
      piNo: toNumberValue(value),
      piSeries: '',
    }
  }

  return {
    piNo: Number(match[2]),
    piSeries: match[1].slice(0, 6),
  }
}

const formatPINumber = (piNo, piSeries) =>
  `${piSeries ?? ''}${String(Number(piNo) || 0).padStart(4, '0')}`

const mapRMarketPIMasterRow = (row) => ({
  id: formatPINumber(row.pi_no, row.pi_series),
  piNo: Number(row.pi_no),
  piSeries: row.pi_series ?? '',
  piNumber: formatPINumber(row.pi_no, row.pi_series),
  piDate: row.pi_date ?? '',
  deliveryDate: row.del_date ?? '',
  companyId: row.company_id ?? '',
  companyName: row.company_legal_name ?? row.company_name ?? '',
  compCode: Number(row.comp_code ?? 0),
  cityCode: Number(row.city_code || row.customer_city_code || 0),
  stateCode: Number(row.state_code || row.customer_state_code || 0),
  customerId: row.customer_id === null || row.customer_id === undefined
    ? null
    : Number(row.customer_id),
  custCode: Number(row.cust_code ?? 0),
  custName: row.customer_name ?? row.pcust_name ?? '',
  customerCity: row.pi_city_name ?? row.customer_city_name ?? '',
  customerState: row.pi_state_name ?? row.customer_state_name ?? '',
  country: row.pi_country_name ?? '',
  currency: 'INR',
  prospectiveCustomerName: row.pcust_name ?? '',
  prospectiveAddress: row.address ?? '',
  prospectiveCity: row.pi_city_name ?? row.customer_city_name ?? '',
  prospectiveState: row.pi_state_name ?? row.customer_state_name ?? '',
  prospectiveContactNo: row.contact_no ?? '',
  prospectiveDiscountPercent: Number(row.pcust_disc_per ?? 0),
  gstNo: row.gst_no ?? '',
  partyTypeCode: String(row.party_type_code ?? ''),
  partyTypeName: '',
  transportMode: row.mode_of_transport ?? '',
  transporter: String(row.transporter_code ?? ''),
  destination: row.destination ?? '',
  materialGroup: row.purch_head ?? '',
  custPoNo: row.po_no ?? '',
  underScheme: String(row.sch_code ?? ''),
  proformaClose: row.close_yn === 'Y' ? 'Yes' : 'No',
  basicValue: Number(row.basic_value ?? 0),
  schemeDiscount: Number(row.scheme_discount ?? 0),
  netBasicValue: Number(row.net_basic_amount ?? 0),
  specialDiscountPercent: Number(row.spdis_per ?? 0),
  specialDiscountAmount: Number(row.spdis_amt ?? 0),
  otherDiscountPercent: Number(row.oth_dis_per ?? 0),
  otherDiscountAmount: Number(row.oth_dis_amt ?? 0),
  amountAfterDiscount: Number(row.net_basic_amount ?? 0),
  todPercent: Number(row.tod_per ?? 0),
  todAmount: Number(row.tod_amt ?? 0),
  cdPercent: Number(row.cd_per ?? 0),
  cdAmount: Number(row.cd_amt ?? 0),
  additionalDiscountPercent: Number(row.oth_spdis_per ?? 0),
  additionalDiscountAmount: Number(row.oth_spdis_amt ?? 0),
  buyNFlyPercent: Number(row.buy_fly_per ?? 0),
  buyNFlyAmount: Number(row.buy_fly_amt ?? 0),
  netTaxableValue: Number(row.net_taxable_value ?? 0),
  igstPercent: Number(row.igst_per ?? 0),
  igstAmount: Number(row.igst_amt ?? 0),
  cgstPercent: Number(row.cgst_per ?? 0),
  cgstAmount: Number(row.cgst_amt ?? 0),
  sgstPercent: Number(row.sgst_per ?? 0),
  sgstAmount: Number(row.sgst_amt ?? 0),
  freight: Number(row.frt_amount ?? 0),
  roundOff: Number(row.round_off ?? 0),
  grandTotal: Number(row.grand_total ?? 0),
  status: row.close_yn === 'Y' ? 'Final' : 'Draft',
  terms: row.remark_footer ?? '',
  company: {
    compCode: Number(row.comp_code ?? 0),
    id: row.company_id ?? '',
    name: row.company_name ?? '',
    legalName: row.company_legal_name ?? row.company_name ?? '',
    address: '',
    gstin: '',
    pan: '',
    state: '',
    stateCode: row.company_state_code ?? '',
    cin: '',
    website: '',
    iec: '',
    phone: '',
    email: '',
    piPrefix: '',
    bankDetails: {
      bankName: '',
      branch: '',
      accountName: '',
      accountNumber: '',
      ifsc: '',
    },
  },
  customer: {
    id: row.customer_id === null || row.customer_id === undefined
      ? ''
      : String(row.customer_id),
    name: row.customer_name ?? row.pcust_name ?? '',
    country: row.pi_country_name ?? '',
    currency: 'INR',
    state: row.pi_state_name ?? row.customer_state_name ?? '',
    stateCode: String(row.state_code || row.customer_state_code || ''),
    contactPerson: row.pcust_name ?? '',
    email: row.customer_email ?? '',
    phone: row.contact_no ?? '',
    address: row.address ?? '',
    placeOfSupply: [
      row.pi_city_name ?? row.customer_city_name,
      row.pi_state_name ?? row.customer_state_name,
    ]
      .filter(Boolean)
      .join(', '),
    paymentTerms: '',
    dispatchTerms: row.mode_of_transport ?? '',
    gstin: row.gst_no ?? '',
  },
  isActive: Boolean(row.is_active),
  createdBy: row.created_by ?? '',
  createdAt: row.created_at,
  updatedBy: row.updated_by ?? '',
  updatedAt: row.updated_at,
})

const mapRMarketPITranRow = (row) => ({
  id: `${row.pi_series}-${row.pi_no}-${row.product_code}`,
  piId: Number(row.pi_no),
  piNumber: formatPINumber(row.pi_no, row.pi_series),
  srNo: 0,
  productId: row.product_id === null || row.product_id === undefined
    ? ''
    : String(row.product_id),
  productCode: row.product_code ?? '',
  productDescription: row.product_description ?? '',
  hsnCode: row.hsn_code ?? '',
  quantity: Number(row.quantity ?? 0),
  unit: row.product_unit ?? String(row.uom_code ?? ''),
  rate: Number(row.rate ?? 0),
  amount: Number(row.amount ?? 0),
  basic: Number(row.rbasic ?? 0),
  discountPercent: Number(row.drate ?? 0),
  discountAmount: Number(row.damt ?? 0),
  gstPercent: Number(row.gst_percent ?? 0),
  isActive: Boolean(row.is_active),
  createdBy: row.created_by ?? '',
  createdAt: row.created_at,
  updatedBy: row.updated_by ?? '',
  updatedAt: row.updated_at,
})

const normalizeRMarketPILinePayload = (line, index) => {
  const quantity = toNumberValue(line.quantity ?? line.qty)
  const rate = toNumberValue(line.rate ?? line.unitPrice)
  const amount = toNumberValue(line.amount, quantity * rate)
  const discountPercent = toNumberValue(
    line.discountPercent ?? line.discPercent ?? line.disc_percent,
  )
  const discountAmount = toNumberValue(
    line.discountAmount ?? line.discount_amount,
    (amount * discountPercent) / 100,
  )

  return {
    srNo: toNumberValue(line.srNo ?? line.sr_no, index + 1),
    productId: toText(line.productId ?? line.product_id),
    productCode: toLimitedText(line.productCode ?? line.product_code, 16),
    productDescription: toText(
      line.productDescription ?? line.description ?? line.product_description,
    ),
    hsnCode: toText(line.hsnCode ?? line.hsn_code),
    quantity,
    unit: toText(line.unit ?? line.uom),
    uomCode: toNumberValue(line.uomCode ?? line.uom_code),
    rate,
    amount,
    basic: toNumberValue(line.basic, amount - discountAmount),
    discountPercent,
    discountAmount,
    gstPercent: toNumberValue(line.gstPercent ?? line.gst_percent),
  }
}

const normalizeRMarketPIPayload = (payload) => {
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : []
  const piParts = parsePINumberParts(payload.piNumber ?? payload.pi_no)
  const isClosed = toText(
    payload.proformaClose ?? payload.proforma_close,
  ).toLowerCase()

  return {
    piNumber: toText(payload.piNumber ?? payload.pi_no),
    piNo: piParts.piNo,
    piSeries: piParts.piSeries,
    piDate: toText(payload.piDate ?? payload.pi_date).slice(0, 10),
    deliveryDate:
      toNullableDate(payload.deliveryDate ?? payload.delivery_date) ??
      toText(payload.piDate ?? payload.pi_date).slice(0, 10),
    companyId: toText(payload.companyId ?? payload.company_id),
    companyName: toText(payload.companyName ?? payload.company_name),
    compCode: toNumberValue(payload.compCode ?? payload.comp_code),
    customerId: toNullableInteger(payload.customerId ?? payload.customer_id),
    custCode: toNumberValue(payload.custCode ?? payload.cust_code),
    custName: toLimitedText(payload.custName ?? payload.cust_name, 60),
    customerCity: toText(payload.customerCity ?? payload.customer_city),
    customerState: toText(payload.customerState ?? payload.customer_state),
    country: toText(payload.country),
    currency: toText(payload.currency || 'INR'),
    prospectiveCustomerName: toText(
      payload.prospectiveCustomerName ?? payload.prospective_customer_name,
    ),
    prospectiveAddress: toLimitedText(
      payload.prospectiveAddress ?? payload.prospective_address,
      300,
    ),
    cityCode: toNumberValue(payload.cityCode ?? payload.city_code),
    stateCode: toNumberValue(payload.stateCode ?? payload.state_code),
    prospectiveCity: toText(payload.prospectiveCity ?? payload.prospective_city),
    prospectiveState: toText(
      payload.prospectiveState ?? payload.prospective_state,
    ),
    prospectiveContactNo: toLimitedText(
      payload.prospectiveContactNo ?? payload.prospective_contact_no,
      10,
    ),
    prospectiveDiscountPercent: toNumberValue(
      payload.prospectiveDiscountPercent ??
        payload.prospective_discount_percent,
    ),
    gstNo: toLimitedText(
      payload.gstNo ?? payload.prospectiveGstNo ?? payload.gst_no,
      15,
    ),
    partyTypeCode: toNumberValue(payload.partyTypeCode ?? payload.party_type_code),
    partyTypeName: toText(payload.partyTypeName ?? payload.party_type),
    transportMode: toLimitedText(
      payload.transportMode ?? payload.transport_mode,
      25,
    ),
    transporter: toText(payload.transporter),
    transporterCode: toNumberValue(payload.transporterCode ?? payload.transporter_code),
    destination: toLimitedText(payload.destination, 25),
    materialGroup: toText(payload.materialGroup ?? payload.material_group),
    custPoNo: toLimitedText(payload.custPoNo ?? payload.cust_po_no, 50),
    underScheme: toText(payload.underScheme ?? payload.under_scheme),
    schemeCode: toNumberValue(payload.schemeCode ?? payload.sch_code),
    proformaClose: toText(
      payload.proformaClose ?? payload.proforma_close ?? 'No',
    ),
    closeYN: isClosed === 'yes' || isClosed === 'y' ? 'Y' : 'N',
    basicValue: toNumberValue(payload.basicValue ?? payload.basic_value),
    schemeDiscount: toNumberValue(
      payload.schemeDiscount ?? payload.scheme_discount,
    ),
    netBasicValue: toNumberValue(payload.netBasicValue ?? payload.net_basic_value),
    specialDiscountPercent: toNumberValue(
      payload.specialDiscountPercent ?? payload.special_discount_percent,
    ),
    specialDiscountAmount: toNumberValue(
      payload.specialDiscountAmount ?? payload.special_discount_amount,
    ),
    otherDiscountPercent: toNumberValue(
      payload.otherDiscountPercent ?? payload.other_discount_percent,
    ),
    otherDiscountAmount: toNumberValue(
      payload.otherDiscountAmount ?? payload.other_discount_amount,
    ),
    amountAfterDiscount: toNumberValue(
      payload.amountAfterDiscount ?? payload.amount_after_discount,
    ),
    todPercent: toNumberValue(payload.todPercent ?? payload.tod_per),
    todAmount: toNumberValue(payload.todAmount ?? payload.tod_amt),
    cdPercent: toNumberValue(payload.cdPercent ?? payload.cd_percent),
    cdAmount: toNumberValue(payload.cdAmount ?? payload.cd_amount),
    additionalDiscountPercent: toNumberValue(
      payload.additionalDiscountPercent ??
        payload.additional_discount_percent,
    ),
    additionalDiscountAmount: toNumberValue(
      payload.additionalDiscountAmount ?? payload.additional_discount_amount,
    ),
    buyNFlyPercent: toNumberValue(
      payload.buyNFlyPercent ?? payload.buy_n_fly_percent,
    ),
    buyNFlyAmount: toNumberValue(
      payload.buyNFlyAmount ?? payload.buy_n_fly_amount,
    ),
    netTaxableValue: toNumberValue(
      payload.netTaxableValue ?? payload.net_taxable_value,
    ),
    igstPercent: toNumberValue(payload.igstPercent ?? payload.igst_percent),
    igstAmount: toNumberValue(payload.igstAmount ?? payload.igst_amount),
    cgstPercent: toNumberValue(payload.cgstPercent ?? payload.cgst_percent),
    cgstAmount: toNumberValue(payload.cgstAmount ?? payload.cgst_amount),
    sgstPercent: toNumberValue(payload.sgstPercent ?? payload.sgst_percent),
    sgstAmount: toNumberValue(payload.sgstAmount ?? payload.sgst_amount),
    freight: toNumberValue(payload.freight),
    roundOff: toNumberValue(payload.roundOff ?? payload.round_off),
    grandTotal: toNumberValue(payload.grandTotal ?? payload.grand_total),
    status: toText(payload.status || 'Draft'),
    terms: toLimitedText(payload.terms, 250),
    remarks: toLimitedText(payload.remarks ?? payload.terms, 250),
    materialGroupCode: toLimitedText(payload.materialGroup ?? payload.purch_head, 3),
    otherSpecialDiscountName: toLimitedText(
      payload.otherSpecialDiscountName ?? payload.oth_sp_disc ?? 'Other Discount',
      16,
    ),
    printerNo: toNumberValue(payload.printerNo ?? payload.printer_no),
    invType: toNumberValue(payload.invType ?? payload.inv_type),
    isActive: toBoolean(payload.isActive ?? payload.is_active, true),
    createdBy: toLimitedText(
      payload.createdBy ?? payload.created_by ?? 'Autopal',
      50,
    ),
    updatedBy: toLimitedText(
      payload.updatedBy ?? payload.updated_by ?? 'Autopal',
      50,
    ),
    lineItems: lineItems.map(normalizeRMarketPILinePayload),
  }
}

const resolveRMarketPICustomerContext = async (pi, queryable = pool) => {
  const nameForLookup = toText(pi.custName || pi.prospectiveCustomerName)
  const result = await queryable.query(
    `
      SELECT
        c.customer_id,
        c.cust_code,
        c.cust_name,
        c.corr_address,
        c.corr_city_code,
        corr_city.city_name AS corr_city_name,
        c.corr_state_code,
        corr_state.state_name AS corr_state_name,
        c.corr_country_code,
        corr_country.country_name AS corr_country_name,
        c.corr_tel,
        c.mobile_no,
        c.gstin_no,
        c.party_type_code,
        party.party_type
      FROM ${CUSTOMER_TABLE_NAME} c
      LEFT JOIN ${CITY_TABLE_NAME} corr_city
        ON corr_city.city_id = c.corr_city_code
      LEFT JOIN ${STATE_TABLE_NAME} corr_state
        ON corr_state.state_id = c.corr_state_code
      LEFT JOIN ${COUNTRY_TABLE_NAME} corr_country
        ON corr_country.country_id = c.corr_country_code
      LEFT JOIN ${PARTY_TYPE_TABLE_NAME} party
        ON party.party_type_code = c.party_type_code
      WHERE c.is_active = TRUE
        AND (
          ($1::integer IS NOT NULL AND c.customer_id = $1::integer)
          OR ($2::integer > 0 AND c.cust_code = $2::integer)
          OR ($3::text <> '' AND LOWER(c.cust_name) = LOWER($3::text))
        )
      ORDER BY
        CASE
          WHEN $1::integer IS NOT NULL AND c.customer_id = $1::integer THEN 1
          WHEN $2::integer > 0 AND c.cust_code = $2::integer THEN 2
          ELSE 3
        END
      LIMIT 1
    `,
    [pi.customerId, pi.custCode, nameForLookup],
  )

  if (result.rowCount === 0) {
    return {
      ...pi,
      custCode: 0,
      customerId: null,
    }
  }

  const customer = result.rows[0]

  return {
    ...pi,
    customerId: Number(customer.customer_id),
    custCode: Number(customer.cust_code),
    custName: customer.cust_name ?? pi.custName,
    cityCode: Number(customer.corr_city_code ?? pi.cityCode),
    stateCode: Number(customer.corr_state_code ?? pi.stateCode),
    country: customer.corr_country_name ?? pi.country,
    customerCity: customer.corr_city_name ?? pi.customerCity,
    customerState: customer.corr_state_name ?? pi.customerState,
    gstNo: pi.gstNo || customer.gstin_no || '',
    partyTypeCode: pi.partyTypeCode || Number(customer.party_type_code ?? 0),
    partyTypeName: pi.partyTypeName || customer.party_type || '',
    prospectiveAddress: pi.prospectiveAddress || customer.corr_address || '',
    prospectiveCity: customer.corr_city_name ?? pi.prospectiveCity,
    prospectiveContactNo:
      pi.prospectiveContactNo ||
      customer.mobile_no ||
      customer.corr_tel ||
      '',
    prospectiveCustomerName:
      pi.prospectiveCustomerName || customer.cust_name || '',
    prospectiveGstNo: pi.prospectiveGstNo || customer.gstin_no || '',
    prospectiveState: customer.corr_state_name ?? pi.prospectiveState,
  }
}

const validateRMarketPI = (pi) => {
  const errors = []

  if (!Number.isInteger(pi.piNo) || pi.piNo <= 0) {
    errors.push('PI number is required.')
  }

  if (!pi.piDate) {
    errors.push('PI date is required.')
  } else if (Number.isNaN(Date.parse(pi.piDate))) {
    errors.push('PI date must be a valid date.')
  }

  if (!pi.companyId) {
    errors.push('Company is required.')
  }

  if (!pi.custName && !pi.prospectiveCustomerName) {
    errors.push('Customer name is required.')
  }

  if (!Number.isInteger(pi.cityCode) || pi.cityCode <= 0) {
    errors.push('City is required.')
  }

  if (!Number.isInteger(pi.stateCode) || pi.stateCode <= 0) {
    errors.push('State is required.')
  }

  if (pi.lineItems.length === 0) {
    errors.push('At least one product row is required.')
  }

  pi.lineItems.forEach((line, index) => {
    const rowLabel = `Product row ${index + 1}`

    if (!line.productCode) {
      errors.push(`${rowLabel}: product code is required.`)
    }

    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      errors.push(`${rowLabel}: quantity must be greater than 0.`)
    }

    if (!Number.isFinite(line.rate) || line.rate < 0) {
      errors.push(`${rowLabel}: rate must be valid.`)
    }
  })

  const productCodes = new Set()
  pi.lineItems.forEach((line) => {
    const productCode = line.productCode.toLowerCase()

    if (productCodes.has(productCode)) {
      errors.push(
        `Product ${line.productCode} is repeated. This PI table allows one row per product code.`,
      )
    }

    productCodes.add(productCode)
  })

  return errors
}

const getRMarketPIMasterValues = (pi) => [
  pi.piNo,
  pi.piDate,
  pi.custCode,
  pi.prospectiveCustomerName || pi.custName,
  pi.prospectiveAddress,
  pi.cityCode,
  pi.stateCode,
  pi.prospectiveContactNo,
  pi.gstNo,
  pi.partyTypeCode,
  pi.transportMode,
  pi.transporterCode,
  pi.destination,
  pi.basicValue,
  pi.freight,
  pi.schemeDiscount,
  pi.roundOff,
  pi.grandTotal,
  pi.printerNo,
  pi.materialGroupCode,
  pi.piSeries,
  pi.specialDiscountPercent,
  pi.specialDiscountAmount,
  pi.netBasicValue,
  pi.deliveryDate,
  pi.remarks,
  pi.closeYN,
  pi.custPoNo,
  pi.schemeCode,
  pi.invType,
  pi.igstPercent,
  pi.cgstPercent,
  pi.sgstPercent,
  pi.igstAmount,
  pi.cgstAmount,
  pi.sgstAmount,
  pi.otherDiscountAmount,
  pi.otherDiscountPercent,
  pi.closeYN === 'Y' ? pi.piDate : null,
  pi.terms,
  pi.todPercent,
  pi.todAmount,
  pi.cdPercent,
  pi.cdAmount,
  pi.netTaxableValue,
  pi.compCode,
  pi.otherSpecialDiscountName,
  pi.additionalDiscountPercent,
  pi.additionalDiscountAmount,
  pi.buyNFlyPercent,
  pi.buyNFlyAmount,
  pi.prospectiveDiscountPercent,
]

const getRMarketPILineValues = (pi, line) => [
  pi.piNo,
  line.productCode,
  line.quantity,
  line.uomCode,
  line.rate,
  line.amount,
  line.basic,
  line.discountPercent,
  line.discountAmount,
  pi.piSeries,
  pi.compCode,
]

const getRMarketPIByKey = async (piNo, piSeries, compCode, queryable = pool) => {
  const masterResult = await queryable.query(
    `
      SELECT ${rMarketPIMasterColumns}
      FROM ${RMKT_PI_MASTER_TABLE_NAME}
      WHERE pi_no = $1
        AND pi_series = $2
        AND comp_code = $3
        AND is_active = TRUE
    `,
    [piNo, piSeries, compCode],
  )

  if (masterResult.rowCount === 0) {
    return null
  }

  const tranResult = await queryable.query(
    `
      SELECT ${rMarketPITranColumns}
      FROM ${RMKT_PI_TRAN_TABLE_NAME} t
      LEFT JOIN ${PRODUCT_TABLE_NAME} p
        ON LOWER(p.code) = LOWER(t.product_code)
      WHERE t.pi_no = $1
        AND t.pi_series = $2
        AND t.comp_code = $3
        AND t.is_active = TRUE
      ORDER BY t.product_code ASC
    `,
    [piNo, piSeries, compCode],
  )

  return {
    ...mapRMarketPIMasterRow(masterResult.rows[0]),
    lineItems: tranResult.rows.map(mapRMarketPITranRow),
  }
}

const rMarketPIMasterValueColumns = [
  'pi_no',
  'pi_date',
  'cust_code',
  'pcust_name',
  'address',
  'city_code',
  'state_code',
  'contact_no',
  'gst_no',
  'party_type_code',
  'mode_of_transport',
  'transporter_code',
  'destination',
  'basic_value',
  'frt_amount',
  'scheme_discount',
  'round_off',
  'grand_total',
  'printer_no',
  'purch_head',
  'pi_series',
  'spdis_per',
  'spdis_amt',
  'net_basic_amount',
  'del_date',
  'remarks',
  'close_yn',
  'po_no',
  'sch_code',
  'inv_type',
  'igst_per',
  'cgst_per',
  'sgst_per',
  'igst_amt',
  'cgst_amt',
  'sgst_amt',
  'oth_dis_amt',
  'oth_dis_per',
  'close_date',
  'remark_footer',
  'tod_per',
  'tod_amt',
  'cd_per',
  'cd_amt',
  'net_taxable_value',
  'comp_code',
  'oth_sp_disc',
  'oth_spdis_per',
  'oth_spdis_amt',
  'buy_fly_per',
  'buy_fly_amt',
  'pcust_disc_per',
]

const rMarketPITranValueColumns = [
  'pi_no',
  'product_code',
  'quantity',
  'uom_code',
  'rate',
  'amount',
  'rbasic',
  'drate',
  'damt',
  'pi_series',
  'comp_code',
]

const getRMarketPIPlaceholder = (column, index) => {
  if (column === 'pi_date' || column === 'del_date' || column === 'close_date') {
    return `$${index}::timestamp`
  }

  return `$${index}`
}

const createValidationError = (errors) => {
  const error = new Error(errors.join(' '))
  error.statusCode = 400
  error.errors = errors
  return error
}

const saveRMarketPIRecord = async (payload) => {
  let client
  let hasTransaction = false

  try {
    let piPayload = normalizeRMarketPIPayload(payload)
    piPayload = await resolveRMarketPICustomerContext(piPayload)
    const errors = validateRMarketPI(piPayload)

    if (errors.length > 0) {
      throw createValidationError(errors)
    }

    client = await pool.connect()
    await client.query('BEGIN')
    hasTransaction = true
    await client.query(
      `LOCK TABLE ${RMKT_PI_MASTER_TABLE_NAME}, ${RMKT_PI_TRAN_TABLE_NAME} IN EXCLUSIVE MODE`,
    )

    const existingPIResult = await client.query(
      `
        SELECT pi_no
        FROM ${RMKT_PI_MASTER_TABLE_NAME}
        WHERE pi_no = $1
          AND pi_series = $2
          AND comp_code = $3
        LIMIT 1
      `,
      [piPayload.piNo, piPayload.piSeries, piPayload.compCode],
    )
    const masterValues = getRMarketPIMasterValues(piPayload)
    let statusCode = 201

    if (existingPIResult.rowCount > 0) {
      statusCode = 200
      const updateAssignments = rMarketPIMasterValueColumns
        .map(
          (column, index) =>
            `${column} = ${getRMarketPIPlaceholder(column, index + 1)}`,
        )
        .join(',\n          ')
      const isActiveParameter = `$${masterValues.length + 1}`
      const updatedByParameter = `$${masterValues.length + 2}`
      const piNoParameter = `$${masterValues.length + 3}`
      const piSeriesParameter = `$${masterValues.length + 4}`
      const compCodeParameter = `$${masterValues.length + 5}`

      await client.query(
        `
          UPDATE ${RMKT_PI_MASTER_TABLE_NAME}
          SET
            ${updateAssignments},
            is_active = ${isActiveParameter},
            updated_by = ${updatedByParameter},
            updated_at = CURRENT_TIMESTAMP
          WHERE pi_no = ${piNoParameter}
            AND pi_series = ${piSeriesParameter}
            AND comp_code = ${compCodeParameter}
        `,
        [
          ...masterValues,
          piPayload.isActive,
          piPayload.updatedBy,
          piPayload.piNo,
          piPayload.piSeries,
          piPayload.compCode,
        ],
      )
    } else {
      const insertColumns = [
        ...rMarketPIMasterValueColumns,
        'is_active',
        'created_by',
      ]
      const insertPlaceholders = [
        ...rMarketPIMasterValueColumns.map((column, index) =>
          getRMarketPIPlaceholder(column, index + 1),
        ),
        `$${masterValues.length + 1}`,
        `$${masterValues.length + 2}`,
      ].join(', ')

      await client.query(
        `
          INSERT INTO ${RMKT_PI_MASTER_TABLE_NAME}
            (
              ${insertColumns.join(',\n              ')}
            )
          VALUES
            (
              ${insertPlaceholders}
            )
        `,
        [...masterValues, piPayload.isActive, piPayload.createdBy],
      )
    }

    await client.query(
      `
        DELETE FROM ${RMKT_PI_TRAN_TABLE_NAME}
        WHERE pi_no = $1
          AND pi_series = $2
          AND comp_code = $3
      `,
      [piPayload.piNo, piPayload.piSeries, piPayload.compCode],
    )

    const tranInsertColumns = [
      ...rMarketPITranValueColumns,
      'is_active',
      'created_by',
    ]
    const tranPlaceholders = tranInsertColumns
      .map((_column, index) => `$${index + 1}`)
      .join(', ')

    for (const line of piPayload.lineItems) {
      await client.query(
        `
          INSERT INTO ${RMKT_PI_TRAN_TABLE_NAME}
            (
              ${tranInsertColumns.join(',\n              ')}
            )
          VALUES
            (
              ${tranPlaceholders}
            )
        `,
        [
          ...getRMarketPILineValues(piPayload, line),
          piPayload.isActive,
          piPayload.createdBy,
        ],
      )
    }

    const savedPI = await getRMarketPIByKey(
      piPayload.piNo,
      piPayload.piSeries,
      piPayload.compCode,
      client,
    )

    await client.query('COMMIT')
    hasTransaction = false

    return { savedPI, statusCode }
  } catch (error) {
    if (client && hasTransaction) {
      await client.query('ROLLBACK')
    }

    throw error
  } finally {
    client?.release()
  }
}

app.get('/api/health', async (_request, response, next) => {
  try {
    await pool.query('SELECT 1')
    response.json({
      database: 'connected',
      service: 'autopal-master-api',
      status: 'ok',
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ai/health', async (_request, response) => {
  const health = await checkOllamaHealth()

  response.status(health.running ? 200 : 503).json({
    success: health.running,
    service: 'AUTOPAL Local AI',
    running: health.running,
    baseUrl: health.baseUrl,
    model: health.model,
    message: health.message,
  })
})

app.post('/api/ai/chat', async (request, response) => {
  try {
    const result = await askOllama({
      question: request.body?.question,
      systemPrompt: AUTOPAL_AI_SYSTEM_PROMPT,
    })

    response.json({
      success: true,
      answer: result.answer,
      model: result.model,
      usage: {
        promptTokens: result.promptTokens,
        responseTokens: result.responseTokens,
      },
      performance: {
        totalDurationNanoseconds: result.totalDuration,
        loadDurationNanoseconds: result.loadDuration,
      },
    })
  } catch (error) {
    if (error.statusCode === 400) {
      response.status(400).json({
        success: false,
        message: error.message,
      })
      return
    }

    if (error.statusCode === 503) {
      response.status(503).json({
        success: false,
        message: error.message,
      })
      return
    }

    console.error('AUTOPAL Local AI chat failed', {
      message: error?.message,
    })

    response.status(500).json({
      success: false,
      message: 'Unable to process the AI request.',
    })
  }
})

const getERPRequestUserName = (request) =>
  String(request.get('x-autopal-user') ?? '').trim()

const requireERPIntelligenceUser = async (request, response) => {
  await ensureUserAdministrationSchema()
  const access = await verifyERPIntelligenceAccess({
    queryable: pool,
    tableNames: ERP_INTELLIGENCE_TABLE_NAMES,
    userName: getERPRequestUserName(request),
  })

  if (!access.authorized) {
    response.status(403).json({
      message: access.message || 'AI ERP Intelligence access is required.',
      mode: 'erp',
      success: false,
    })
    return null
  }

  return access
}

const sendERPIntelligenceResult = (response, result) => {
  response.status(result.statusCode ?? (result.success ? 200 : 422)).json({
    ...result,
    statusCode: undefined,
  })
}

const runERPIntelligenceRequest = async (request, response) => {
  const access = await requireERPIntelligenceUser(request, response)

  if (!access) {
    return
  }

  const result = await processERPQuestion({
    queryable: pool,
    question: request.body?.question,
    tableNames: ERP_INTELLIGENCE_TABLE_NAMES,
  })

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      module: 'PI Intelligence',
      intent: result.intent ?? '',
      success: Boolean(result.success),
      userName: access.userName,
    }),
  )

  sendERPIntelligenceResult(response, result)
}

app.post('/api/ai/erp', async (request, response) => {
  try {
    await runERPIntelligenceRequest(request, response)
  } catch (error) {
    console.error('AUTOPAL ERP Intelligence failed', {
      message: error?.message,
    })
    response.status(500).json({
      message: 'Unable to process the ERP Intelligence request.',
      mode: 'erp',
      success: false,
    })
  }
})

app.get('/api/ai/erp/dashboard', async (request, response) => {
  try {
    const access = await requireERPIntelligenceUser(request, response)

    if (!access) {
      return
    }

    const dashboard = await getPIIntelligenceDashboard({
      queryable: pool,
      tableNames: ERP_INTELLIGENCE_TABLE_NAMES,
    })

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        module: 'PI Intelligence',
        report: 'dashboard',
        success: true,
        userName: access.userName,
      }),
    )

    response.json(dashboard)
  } catch (error) {
    console.error('AUTOPAL ERP Intelligence dashboard failed', {
      message: error?.message,
    })
    response.status(500).json({
      message: 'Unable to load the PI Intelligence dashboard.',
      module: 'PI Intelligence',
      success: false,
    })
  }
})

app.post('/api/ai/ask', async (request, response) => {
  try {
    const classification = classifyERPQuestion(request.body?.question)

    if (classification.intent !== ERP_INTENTS.GENERAL_AI_QUESTION) {
      await runERPIntelligenceRequest(request, response)
      return
    }

    const result = await askOllama({
      question: request.body?.question,
      systemPrompt: AUTOPAL_AI_SYSTEM_PROMPT,
    })

    response.json({
      success: true,
      mode: 'general',
      answer: result.answer,
      model: result.model,
      usage: {
        promptTokens: result.promptTokens,
        responseTokens: result.responseTokens,
      },
      performance: {
        totalDurationNanoseconds: result.totalDuration,
        loadDurationNanoseconds: result.loadDuration,
      },
    })
  } catch (error) {
    if (error.statusCode === 400) {
      response.status(400).json({
        success: false,
        mode: 'general',
        message: error.message,
      })
      return
    }

    if (error.statusCode === 503) {
      response.status(503).json({
        success: false,
        mode: 'general',
        message: error.message,
      })
      return
    }

    console.error('AUTOPAL AI ask failed', {
      message: error?.message,
    })

    response.status(500).json({
      success: false,
      message: 'Unable to process the AI request.',
    })
  }
})

app.post('/api/meta/data-deletion', async (request, response, next) => {
  try {
    const signedRequest = request.body?.signed_request

    if (typeof signedRequest !== 'string' || !signedRequest.trim()) {
      response.status(400).json({ message: 'signed_request is required.' })
      return
    }

    const verification = verifyMetaSignedRequest(signedRequest)

    if (!verification.payload) {
      response.status(verification.errorStatus).json({
        message: verification.message,
      })
      return
    }

    const metaUserId = getMetaUserIdFromPayload(verification.payload)

    if (!metaUserId) {
      response.status(400).json({ message: 'Meta user ID is required.' })
      return
    }

    const deletionRequest = await createMetaDataDeletionRequest(metaUserId)
    const confirmationCode = deletionRequest.confirmation_code
    const statusUrl = `${getPublicBaseUrl(
      request,
    )}/data-deletion-status.html?code=${encodeURIComponent(confirmationCode)}`

    response.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/meta/data-deletion-status/:code', async (request, response, next) => {
  try {
    const confirmationCode = String(request.params.code ?? '').trim()

    if (!/^[A-Za-z0-9_-]{8,80}$/.test(confirmationCode)) {
      response.status(400).json({ message: 'Invalid confirmation code.' })
      return
    }

    await ensureMetaDataDeletionSchema()

    const result = await pool.query(
      `
        SELECT confirmation_code, status, requested_at, completed_at
        FROM ${META_DATA_DELETION_TABLE_NAME}
        WHERE confirmation_code = $1
        LIMIT 1
      `,
      [confirmationCode],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'Deletion request not found.' })
      return
    }

    response.json(mapMetaDataDeletionStatusRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

app.post('/api/login', async (request, response, next) => {
  try {
    await ensureUserAdministrationSchema()
    const userName = String(
      request.body.userName ?? request.body.user_name ?? '',
    ).trim()
    const pw = String(request.body.pw ?? '')
    const loginLocation = request.body.location ?? {}

    if (!userName || !pw) {
      response.status(401).json({
        authorized: false,
        message: 'You are not authorised person.',
      })
      return
    }

    const result = await pool.query(
      `
        SELECT user_name, is_admin, is_active
        FROM ${USER_TABLE_NAME}
        WHERE LOWER(user_name) = LOWER($1)
          AND pw = $2
          AND is_active = TRUE
        LIMIT 1
      `,
      [userName, pw],
    )

    if (result.rowCount === 0) {
      response.status(401).json({
        authorized: false,
        message: 'You are not authorised person.',
      })
      return
    }

    const user = result.rows[0]
    const rights = await getUserRights(user.user_name, Boolean(user.is_admin))
    const requestIPAddress = getRequestIPAddress(request)
    const ipLocation = await lookupIPLocation(requestIPAddress)
    const clientLatitude = toNullableDecimal(
      loginLocation.latitude ?? request.body.latitude,
    )
    const clientLongitude = toNullableDecimal(
      loginLocation.longitude ?? request.body.longitude,
    )
    const latitude = clientLatitude ?? ipLocation?.latitude ?? null
    const longitude = clientLongitude ?? ipLocation?.longitude ?? null
    const locationTextFallback = String(
      loginLocation.locationText ?? request.body.locationText ?? '',
    ).trim()
    const locationText =
      getGoogleMapsUrl(latitude, longitude) ||
      getGoogleMapsSearchUrl(locationTextFallback)

    await pool.query(
      `
        INSERT INTO ${USER_LOGIN_LOG_TABLE_NAME}
          (user_name, location_text, latitude, longitude, ip_address, user_agent)
        VALUES
          ($1, $2, $3, $4, $5, $6)
      `,
      [
        user.user_name,
        locationText,
        latitude,
        longitude,
        ipLocation?.ipAddress ?? requestIPAddress,
        request.get('user-agent') ?? '',
      ],
    )

    response.json({
      authorized: true,
      isAdmin: Boolean(user.is_admin),
      message: 'Login successful.',
      rights,
      userName: user.user_name,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/change-password', async (request, response, next) => {
  try {
    await ensureUserAdministrationSchema()
    const userName = String(
      request.body.userName ?? request.body.user_name ?? '',
    ).trim()
    const oldPw = String(
      request.body.oldPw ?? request.body.old_pw ?? request.body.currentPw ?? '',
    )
    const newPw = String(request.body.newPw ?? request.body.new_pw ?? '')

    if (!userName || !oldPw || !newPw) {
      response.status(400).json({
        changed: false,
        message: 'User name, current password, and new password are required.',
      })
      return
    }

    const existingUser = await pool.query(
      `
        SELECT user_name
        FROM ${USER_TABLE_NAME}
        WHERE LOWER(user_name) = LOWER($1)
          AND pw = $2
          AND is_active = TRUE
        LIMIT 1
      `,
      [userName, oldPw],
    )

    if (existingUser.rowCount === 0) {
      response.status(401).json({
        changed: false,
        message: 'You are not authorised person.',
      })
      return
    }

    await pool.query(
      `
        UPDATE ${USER_TABLE_NAME}
        SET pw = $2
        WHERE user_name = $1
      `,
      [existingUser.rows[0].user_name, newPw],
    )

    response.json({
      changed: true,
      message: 'Password changed successfully.',
      userName: existingUser.rows[0].user_name,
    })
  } catch (error) {
    next(error)
  }
})

const getAdminUserList = async () => {
  const [usersResult, rightsResult] = await Promise.all([
    pool.query(`
      SELECT
        u.user_name,
        u.is_admin,
        u.is_active,
        TO_CHAR(u.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS created_at,
        TO_CHAR(u.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS updated_at,
        (
          SELECT TO_CHAR(log.login_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS')
          FROM ${USER_LOGIN_LOG_TABLE_NAME} log
          WHERE LOWER(log.user_name) = LOWER(u.user_name)
          ORDER BY log.login_at DESC
          LIMIT 1
        ) AS last_login_at,
        (
          SELECT
            CASE
              WHEN log.latitude IS NOT NULL AND log.longitude IS NOT NULL THEN
                'https://www.google.com/maps?q=' || log.latitude || ',' || log.longitude
              ELSE COALESCE(NULLIF(log.location_text, ''), log.ip_address, '')
            END
          FROM ${USER_LOGIN_LOG_TABLE_NAME} log
          WHERE LOWER(log.user_name) = LOWER(u.user_name)
          ORDER BY log.login_at DESC
          LIMIT 1
        ) AS last_login_location
      FROM ${USER_TABLE_NAME} u
      ORDER BY u.user_name ASC
    `),
    pool.query(`
      SELECT user_name, screen_id, can_access
      FROM ${USER_RIGHTS_TABLE_NAME}
    `),
  ])
  const rightsByUser = new Map()

  rightsResult.rows.forEach((row) => {
    const key = String(row.user_name).toLowerCase()
    const existingRights = rightsByUser.get(key) ?? []

    if (Boolean(row.can_access)) {
      existingRights.push(row.screen_id)
    }

    rightsByUser.set(key, existingRights)
  })

  return usersResult.rows.map((row) => ({
    isActive: Boolean(row.is_active),
    isAdmin: Boolean(row.is_admin),
    lastLoginAt: row.last_login_at ?? '',
    lastLoginLocation: row.last_login_location ?? '',
    rights: Boolean(row.is_admin)
      ? [...MENU_SCREEN_IDS]
      : rightsByUser.has(String(row.user_name).toLowerCase())
        ? sanitizeUserRights(
            rightsByUser.get(String(row.user_name).toLowerCase()) ?? [],
          )
        : normalizeRights([], false),
    userName: row.user_name,
  }))
}

app.get('/api/admin/users', async (request, response, next) => {
  try {
    const adminUser = await requireAdminUser(request, response)

    if (!adminUser) {
      return
    }

    response.json(await getAdminUserList())
  } catch (error) {
    next(error)
  }
})

app.post('/api/admin/users', async (request, response, next) => {
  let client
  let hasTransaction = false

  try {
    const adminUser = await requireAdminUser(request, response)

    if (!adminUser) {
      return
    }

    const userName = String(
      request.body.userName ?? request.body.user_name ?? '',
    ).trim()
    const pw = String(request.body.pw ?? request.body.password ?? '')
    const isAdmin = Boolean(request.body.isAdmin ?? request.body.is_admin)
    const isActive = request.body.isActive ?? request.body.is_active ?? true
    const rights = Array.isArray(request.body.rights)
      ? request.body.rights.map((right) => String(right))
      : DEFAULT_USER_SCREEN_IDS

    if (!userName) {
      response.status(400).json({ message: 'User name is required.' })
      return
    }

    client = await pool.connect()
    await client.query('BEGIN')
    hasTransaction = true

    const existingUser = await client.query(
      `SELECT user_name FROM ${USER_TABLE_NAME} WHERE LOWER(user_name) = LOWER($1)`,
      [userName],
    )

    if (existingUser.rowCount === 0 && !pw) {
      response.status(400).json({ message: 'Password is required for new user.' })
      await client.query('ROLLBACK')
      hasTransaction = false
      return
    }

    await client.query(
      `
        INSERT INTO ${USER_TABLE_NAME}
          (user_name, pw, is_admin, is_active, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_name)
        DO UPDATE SET
          pw = CASE WHEN EXCLUDED.pw <> '' THEN EXCLUDED.pw ELSE ${USER_TABLE_NAME}.pw END,
          is_admin = EXCLUDED.is_admin,
          is_active = EXCLUDED.is_active,
          updated_at = CURRENT_TIMESTAMP
      `,
      [userName, pw, isAdmin, Boolean(isActive)],
    )

    if (isAdmin) {
      await client.query(
        `DELETE FROM ${USER_RIGHTS_TABLE_NAME} WHERE LOWER(user_name) = LOWER($1)`,
        [userName],
      )
    } else {
      await saveUserRights(userName, rights, client)
    }

    await client.query('COMMIT')
    hasTransaction = false
    response.json(await getAdminUserList())
  } catch (error) {
    if (hasTransaction) {
      await client?.query('ROLLBACK')
    }

    next(error)
  } finally {
    client?.release()
  }
})

app.put('/api/admin/users/:userName/rights', async (request, response, next) => {
  let client
  let hasTransaction = false

  try {
    const adminUser = await requireAdminUser(request, response)

    if (!adminUser) {
      return
    }

    const userName = String(request.params.userName ?? '').trim()
    const pw = String(request.body.pw ?? request.body.password ?? '')
    const isAdmin = Boolean(request.body.isAdmin ?? request.body.is_admin)
    const isActive = request.body.isActive ?? request.body.is_active ?? true
    const rights = Array.isArray(request.body.rights)
      ? request.body.rights.map((right) => String(right))
      : DEFAULT_USER_SCREEN_IDS

    client = await pool.connect()
    await client.query('BEGIN')
    hasTransaction = true

    const updateResult = await client.query(
      `
        UPDATE ${USER_TABLE_NAME}
        SET
          pw = CASE WHEN $2 <> '' THEN $2 ELSE pw END,
          is_admin = $3,
          is_active = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(user_name) = LOWER($1)
      `,
      [userName, pw, isAdmin, Boolean(isActive)],
    )

    if (updateResult.rowCount === 0) {
      response.status(404).json({ message: 'User not found.' })
      await client.query('ROLLBACK')
      hasTransaction = false
      return
    }

    if (isAdmin) {
      await client.query(
        `DELETE FROM ${USER_RIGHTS_TABLE_NAME} WHERE LOWER(user_name) = LOWER($1)`,
        [userName],
      )
    } else {
      await saveUserRights(userName, rights, client)
    }

    await client.query('COMMIT')
    hasTransaction = false
    response.json(await getAdminUserList())
  } catch (error) {
    if (hasTransaction) {
      await client?.query('ROLLBACK')
    }

    next(error)
  } finally {
    client?.release()
  }
})

app.use(
  '/api/admin/ai-test-console',
  createAITestConsoleRouter({
    pool,
    requireAdminUser,
    tableNames: {
      city: CITY_TABLE_NAME,
      company: COMPANY_TABLE_NAME,
      companyCategoryMapping: COMPANY_CATEGORY_MAPPING_TABLE_NAME,
      country: COUNTRY_TABLE_NAME,
      customer: CUSTOMER_TABLE_NAME,
      customerDiscount: CUSTOMER_DISCOUNT_TABLE_NAME,
      partyType: PARTY_TYPE_TABLE_NAME,
      piMaster: RMKT_PI_MASTER_TABLE_NAME,
      piTran: RMKT_PI_TRAN_TABLE_NAME,
      product: PRODUCT_TABLE_NAME,
      state: STATE_TABLE_NAME,
      tradingRate: TRADING_RATE_TABLE_NAME,
    },
  }),
)

app.get('/api/master-companies', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${companyColumns}
      FROM ${COMPANY_TABLE_NAME}
      WHERE is_active = TRUE
      ORDER BY comp_code ASC
    `)

    response.json(result.rows.map(mapCompanyRow))
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-customer-lookups', async (_request, response, next) => {
  try {
    const [countries, states, cities, markets, partyTypes] = await Promise.all([
      pool.query(`
        SELECT country_id AS code, country_name AS name, NULL AS parent_code
        FROM ${COUNTRY_TABLE_NAME}
        WHERE is_active = TRUE
        ORDER BY country_name ASC
      `),
      pool.query(`
        SELECT state_id AS code, state_name AS name, country_id AS parent_code
        FROM ${STATE_TABLE_NAME}
        WHERE is_active = TRUE
        ORDER BY state_name ASC
      `),
      pool.query(`
        SELECT city_id AS code, city_name AS name, state_id AS parent_code
        FROM ${CITY_TABLE_NAME}
        WHERE is_active = TRUE
        ORDER BY city_name ASC
      `),
      pool.query(`
        SELECT market_code AS code, market_name AS name, NULL AS parent_code
        FROM ${MARKET_TABLE_NAME}
        WHERE is_active = TRUE
        ORDER BY market_code ASC
      `),
      pool.query(`
        SELECT party_type_code AS code, party_type AS name, NULL AS parent_code
        FROM ${PARTY_TYPE_TABLE_NAME}
        WHERE is_active = TRUE
        ORDER BY party_type_code ASC
      `),
    ])

    response.json({
      cities: cities.rows.map(mapLookupRow),
      countries: countries.rows.map(mapLookupRow),
      markets: markets.rows.map(mapLookupRow),
      partyTypes: partyTypes.rows.map(mapLookupRow),
      states: states.rows.map(mapLookupRow),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-customers', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${customerSelectColumns}
      ${customerJoinClause}
      ORDER BY c.created_at DESC, c.cust_name ASC
    `)

    response.json(result.rows.map(mapCustomerRow))
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-customers/:id', async (request, response, next) => {
  try {
    const customer = await getCustomerById(request.params.id)

    if (!customer) {
      response.status(404).json({ message: 'Customer not found.' })
      return
    }

    response.json(customer)
  } catch (error) {
    next(error)
  }
})

app.post('/api/master-customers', async (request, response, next) => {
  try {
    const customerPayload = normalizeCustomerPayload(request.body)
    const errors = await validateCustomer(customerPayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        INSERT INTO ${CUSTOMER_TABLE_NAME}
          (
            cust_code,
            cust_name,
            corr_address,
            corr_city_code,
            corr_state_code,
            corr_country_code,
            corr_pin_code,
            corr_tel,
            corr_fax,
            corr_email,
            ship_address,
            ship_city_code,
            ship_state_code,
            ship_country_code,
            ship_pin_code,
            ship_tel,
            ship_fax,
            ship_email,
            website,
            market_code,
            zone,
            party_type_code,
            gstin_no,
            gst_date,
            pan_no,
            contact_person,
            mobile_no,
            credit_days,
            credit_limit,
            remarks,
            is_active
          )
        VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20,
            $21,
            $22,
            $23,
            $24::timestamp,
            $25,
            $26,
            $27,
            $28,
            $29,
            $30,
            $31
          )
        RETURNING customer_id
      `,
      getCustomerValues(customerPayload),
    )

    const savedCustomer = await getCustomerById(result.rows[0].customer_id)

    response.status(201).json(savedCustomer)
  } catch (error) {
    next(error)
  }
})

app.put('/api/master-customers/:id', async (request, response, next) => {
  try {
    const existingCustomerResult = await pool.query(
      `SELECT customer_id FROM ${CUSTOMER_TABLE_NAME} WHERE customer_id::text = $1`,
      [request.params.id],
    )

    if (existingCustomerResult.rowCount === 0) {
      response.status(404).json({ message: 'Customer not found.' })
      return
    }

    const customerPayload = normalizeCustomerPayload(request.body)
    const errors = await validateCustomer(customerPayload, request.params.id)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    await pool.query(
      `
        UPDATE ${CUSTOMER_TABLE_NAME}
        SET
          cust_code = $1,
          cust_name = $2,
          corr_address = $3,
          corr_city_code = $4,
          corr_state_code = $5,
          corr_country_code = $6,
          corr_pin_code = $7,
          corr_tel = $8,
          corr_fax = $9,
          corr_email = $10,
          ship_address = $11,
          ship_city_code = $12,
          ship_state_code = $13,
          ship_country_code = $14,
          ship_pin_code = $15,
          ship_tel = $16,
          ship_fax = $17,
          ship_email = $18,
          website = $19,
          market_code = $20,
          zone = $21,
          party_type_code = $22,
          gstin_no = $23,
          gst_date = $24::timestamp,
          pan_no = $25,
          contact_person = $26,
          mobile_no = $27,
          credit_days = $28,
          credit_limit = $29,
          remarks = $30,
          is_active = $31,
          updated_at = NOW()
        WHERE customer_id::text = $32
      `,
      [...getCustomerValues(customerPayload), request.params.id],
    )

    const savedCustomer = await getCustomerById(request.params.id)

    response.json(savedCustomer)
  } catch (error) {
    next(error)
  }
})

app.delete('/api/master-customers/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${CUSTOMER_TABLE_NAME} WHERE customer_id::text = $1`,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'Customer not found.' })
      return
    }

    response.sendStatus(204)
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-markets', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${marketColumns}
      FROM ${MARKET_TABLE_NAME}
      WHERE is_active = TRUE
      ORDER BY market_code ASC
    `)

    response.json(result.rows.map(mapMarketRow))
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-products', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${productColumns}
      FROM ${PRODUCT_TABLE_NAME}
      ORDER BY created_at DESC, code ASC
    `)

    response.json(result.rows.map(mapProductRow))
  } catch (error) {
    next(error)
  }
})

app.get('/api/master-products/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `
        SELECT ${productColumns}
        FROM ${PRODUCT_TABLE_NAME}
        WHERE id::text = $1
      `,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'Product not found.' })
      return
    }

    response.json(mapProductRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

app.post('/api/master-products', async (request, response, next) => {
  try {
    const productPayload = normalizeProductPayload(request.body)
    const errors = await validateProduct(productPayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        INSERT INTO ${PRODUCT_TABLE_NAME}
          (code, description, hsn_code, category, market, unit, gst_percent)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING ${productColumns}
      `,
      [
        productPayload.code,
        productPayload.description,
        productPayload.hsnCode,
        productPayload.category,
        productPayload.market,
        productPayload.unit,
        productPayload.gstPercent,
      ],
    )

    response.status(201).json(mapProductRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

app.put('/api/master-products/:id', async (request, response, next) => {
  try {
    const existingProductResult = await pool.query(
      `SELECT id FROM ${PRODUCT_TABLE_NAME} WHERE id::text = $1`,
      [request.params.id],
    )

    if (existingProductResult.rowCount === 0) {
      response.status(404).json({ message: 'Product not found.' })
      return
    }

    const productPayload = normalizeProductPayload(request.body)
    const errors = await validateProduct(productPayload, request.params.id)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        UPDATE ${PRODUCT_TABLE_NAME}
        SET
          code = $1,
          description = $2,
          hsn_code = $3,
          category = $4,
          market = $5,
          unit = $6,
          gst_percent = $7,
          updated_at = NOW()
        WHERE id::text = $8
        RETURNING ${productColumns}
      `,
      [
        productPayload.code,
        productPayload.description,
        productPayload.hsnCode,
        productPayload.category,
        productPayload.market,
        productPayload.unit,
        productPayload.gstPercent,
        request.params.id,
      ],
    )

    response.json(mapProductRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/master-products/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${PRODUCT_TABLE_NAME} WHERE id::text = $1`,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'Product not found.' })
      return
    }

    response.sendStatus(204)
  } catch (error) {
    next(error)
  }
})

const tradingRateRoutes = express.Router()

tradingRateRoutes.get('/', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${tradingRateColumns}
      FROM ${TRADING_RATE_TABLE_NAME}
      ORDER BY eff_date DESC, product_code ASC
    `)

    response.json(result.rows.map(mapTradingRateRow))
  } catch (error) {
    next(error)
  }
})

tradingRateRoutes.get('/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `
        SELECT ${tradingRateColumns}
        FROM ${TRADING_RATE_TABLE_NAME}
        WHERE id::text = $1
      `,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'R.Market rate not found.' })
      return
    }

    response.json(mapTradingRateRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

tradingRateRoutes.post('/', async (request, response, next) => {
  try {
    const ratePayload = await enrichTradingRateFromMasterData(
      normalizeTradingRatePayload(request.body),
    )
    const errors = validateTradingRate(ratePayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        INSERT INTO ${TRADING_RATE_TABLE_NAME}
          (
            eff_date,
            product_code,
            w_rate,
            sw_rate,
            r_rate,
            i_rate,
            oth1_rate,
            oth2_rate,
            dis_amt,
            unit_name,
            family,
            mrp,
            std_pkg,
            cpno,
            min_stk_qty,
            disp_mrp,
            basic_rate,
            plant_name,
            cat_desc,
            comp_code
          )
        VALUES
          (
            $1::timestamp,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20
          )
        RETURNING ${tradingRateColumns}
      `,
      getTradingRateValues(ratePayload),
    )

    response.status(201).json(mapTradingRateRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

tradingRateRoutes.put('/:id', async (request, response, next) => {
  try {
    const existingRateResult = await pool.query(
      `SELECT id FROM ${TRADING_RATE_TABLE_NAME} WHERE id::text = $1`,
      [request.params.id],
    )

    if (existingRateResult.rowCount === 0) {
      response.status(404).json({ message: 'R.Market rate not found.' })
      return
    }

    const ratePayload = await enrichTradingRateFromMasterData(
      normalizeTradingRatePayload(request.body),
    )
    const errors = validateTradingRate(ratePayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        UPDATE ${TRADING_RATE_TABLE_NAME}
        SET
          eff_date = $1::timestamp,
          product_code = $2,
          w_rate = $3,
          sw_rate = $4,
          r_rate = $5,
          i_rate = $6,
          oth1_rate = $7,
          oth2_rate = $8,
          dis_amt = $9,
          unit_name = $10,
          family = $11,
          mrp = $12,
          std_pkg = $13,
          cpno = $14,
          min_stk_qty = $15,
          disp_mrp = $16,
          basic_rate = $17,
          plant_name = $18,
          cat_desc = $19,
          comp_code = $20
        WHERE id::text = $21
        RETURNING ${tradingRateColumns}
      `,
      [...getTradingRateValues(ratePayload), request.params.id],
    )

    response.json(mapTradingRateRow(result.rows[0]))
  } catch (error) {
    next(error)
  }
})

tradingRateRoutes.delete('/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${TRADING_RATE_TABLE_NAME} WHERE id::text = $1`,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'R.Market rate not found.' })
      return
    }

    response.sendStatus(204)
  } catch (error) {
    next(error)
  }
})

const customerDiscountRoutes = express.Router()

customerDiscountRoutes.get('/', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${customerDiscountSelectColumns}
      ${customerDiscountJoinClause}
      ORDER BY cd.eff_date DESC, cd.cust_code ASC
    `)

    response.json(result.rows.map(mapCustomerDiscountRow))
  } catch (error) {
    next(error)
  }
})

customerDiscountRoutes.get('/:id', async (request, response, next) => {
  try {
    const discount = await getCustomerDiscountById(request.params.id)

    if (!discount) {
      response.status(404).json({ message: 'Customer discount not found.' })
      return
    }

    response.json(discount)
  } catch (error) {
    next(error)
  }
})

customerDiscountRoutes.post('/', async (request, response, next) => {
  let client
  let hasTransaction = false

  try {
    const discountPayload = normalizeCustomerDiscountPayload(request.body)
    const errors = await validateCustomerDiscount(discountPayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    client = await pool.connect()
    await client.query('BEGIN')
    hasTransaction = true
    await client.query(
      `LOCK TABLE ${CUSTOMER_DISCOUNT_TABLE_NAME} IN EXCLUSIVE MODE`,
    )

    const result = await client.query(
      `
        INSERT INTO ${CUSTOMER_DISCOUNT_TABLE_NAME}
          (
            id,
            eff_date,
            cust_code,
            hl_per,
            halo_per,
            incd_per,
            wiper_per,
            gst_per,
            comp_code,
            is_active
          )
        SELECT
          COALESCE(MAX(id), 0) + 1,
          $1::timestamp,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        FROM ${CUSTOMER_DISCOUNT_TABLE_NAME}
        RETURNING id
      `,
      getCustomerDiscountValues(discountPayload),
    )
    const savedDiscount = await getCustomerDiscountById(
      result.rows[0].id,
      client,
    )

    await client.query('COMMIT')

    response.status(201).json(savedDiscount)
  } catch (error) {
    if (client && hasTransaction) {
      await client.query('ROLLBACK')
    }

    next(error)
  } finally {
    client?.release()
  }
})

customerDiscountRoutes.put('/:id', async (request, response, next) => {
  try {
    const existingDiscount = await getCustomerDiscountById(request.params.id)

    if (!existingDiscount) {
      response.status(404).json({ message: 'Customer discount not found.' })
      return
    }

    const discountPayload = normalizeCustomerDiscountPayload(request.body)
    const errors = await validateCustomerDiscount(discountPayload)

    if (errors.length > 0) {
      response.status(400).json({ errors })
      return
    }

    const result = await pool.query(
      `
        UPDATE ${CUSTOMER_DISCOUNT_TABLE_NAME}
        SET
          eff_date = $1::timestamp,
          cust_code = $2,
          hl_per = $3,
          halo_per = $4,
          incd_per = $5,
          wiper_per = $6,
          gst_per = $7,
          comp_code = $8,
          is_active = $9,
          updated_at = NOW()
        WHERE id::text = $10
        RETURNING id
      `,
      [...getCustomerDiscountValues(discountPayload), request.params.id],
    )
    const savedDiscount = await getCustomerDiscountById(result.rows[0].id)

    response.json(savedDiscount)
  } catch (error) {
    next(error)
  }
})

customerDiscountRoutes.delete('/:id', async (request, response, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${CUSTOMER_DISCOUNT_TABLE_NAME} WHERE id::text = $1`,
      [request.params.id],
    )

    if (result.rowCount === 0) {
      response.status(404).json({ message: 'Customer discount not found.' })
      return
    }

    response.sendStatus(204)
  } catch (error) {
    next(error)
  }
})

const rMarketPIRoutes = express.Router()

rMarketPIRoutes.get('/', async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT ${rMarketPIMasterColumns}
      FROM ${RMKT_PI_MASTER_TABLE_NAME}
      WHERE is_active = TRUE
      ORDER BY pi_date DESC, pi_no DESC
    `)

    if (result.rowCount === 0) {
      response.json([])
      return
    }

    const tranResult = await pool.query(`
      SELECT ${rMarketPITranColumns}
      FROM ${RMKT_PI_TRAN_TABLE_NAME} t
      LEFT JOIN ${PRODUCT_TABLE_NAME} p
        ON LOWER(p.code) = LOWER(t.product_code)
      WHERE t.is_active = TRUE
        AND EXISTS (
          SELECT 1
          FROM ${RMKT_PI_MASTER_TABLE_NAME} m
          WHERE m.pi_no = t.pi_no
            AND m.pi_series = t.pi_series
            AND m.comp_code = t.comp_code
            AND m.is_active = TRUE
        )
      ORDER BY t.pi_series ASC, t.pi_no DESC, t.product_code ASC
    `)
    const linesByPIKey = new Map()

    tranResult.rows.forEach((row) => {
      const key = `${row.pi_series}-${row.pi_no}-${row.comp_code}`
      const existingLines = linesByPIKey.get(key) ?? []

      existingLines.push(mapRMarketPITranRow(row))
      linesByPIKey.set(key, existingLines)
    })

    response.json(
      result.rows.map((row) => {
        const key = `${row.pi_series}-${row.pi_no}-${row.comp_code}`

        return {
          ...mapRMarketPIMasterRow(row),
          lineItems: linesByPIKey.get(key) ?? [],
        }
      }),
    )
  } catch (error) {
    next(error)
  }
})

rMarketPIRoutes.get('/:id', async (request, response, next) => {
  try {
    const piParts = parsePINumberParts(request.params.id)
    const compCode = toNumberValue(request.query.compCode, 1)
    const pi = await getRMarketPIByKey(
      piParts.piNo,
      piParts.piSeries,
      compCode,
    )

    if (!pi) {
      response.status(404).json({ message: 'R.Market PI not found.' })
      return
    }

    response.json(pi)
  } catch (error) {
    next(error)
  }
})

rMarketPIRoutes.post('/', async (request, response, next) => {
  try {
    const { savedPI, statusCode } = await saveRMarketPIRecord(request.body)

    response.status(statusCode).json(savedPI)
  } catch (error) {
    if (error.statusCode === 400 && Array.isArray(error.errors)) {
      response.status(400).json({ errors: error.errors })
      return
    }

    next(error)
  }
})

rMarketPIRoutes.delete('/:id', async (request, response, next) => {
  let client
  let hasTransaction = false

  try {
    const piParts = parsePINumberParts(request.params.id)
    const compCode = toNumberValue(request.query.compCode, 1)
    const updatedBy = toLimitedText(request.query.updatedBy ?? 'Autopal', 50)

    client = await pool.connect()
    await client.query('BEGIN')
    hasTransaction = true

    const result = await client.query(
      `
        UPDATE ${RMKT_PI_MASTER_TABLE_NAME}
        SET
          is_active = FALSE,
          updated_by = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE pi_no = $1
          AND pi_series = $2
          AND comp_code = $3
          AND is_active = TRUE
      `,
      [piParts.piNo, piParts.piSeries, compCode, updatedBy],
    )

    if (result.rowCount === 0) {
      await client.query('ROLLBACK')
      hasTransaction = false
      response.status(404).json({ message: 'R.Market PI not found.' })
      return
    }

    await client.query(
      `
        UPDATE ${RMKT_PI_TRAN_TABLE_NAME}
        SET
          is_active = FALSE,
          updated_by = $4,
          updated_at = CURRENT_TIMESTAMP
        WHERE pi_no = $1
          AND pi_series = $2
          AND comp_code = $3
      `,
      [piParts.piNo, piParts.piSeries, compCode, updatedBy],
    )

    await client.query('COMMIT')
    hasTransaction = false

    response.sendStatus(204)
  } catch (error) {
    if (client && hasTransaction) {
      await client.query('ROLLBACK')
    }

    next(error)
  } finally {
    client?.release()
  }
})

app.use('/api/master-trading-product-rates', tradingRateRoutes)
app.use('/api/r-market-rates', tradingRateRoutes)
app.use('/api/master-cust-discounts', customerDiscountRoutes)
app.use('/api/master-cust-discount', customerDiscountRoutes)
app.use('/api/customer-discounts', customerDiscountRoutes)
app.use('/api/master-pi-rmkt', rMarketPIRoutes)
app.use('/api/r-market-pis', rMarketPIRoutes)
app.use(
  '/api/whatsapp-pi',
  createWhatsappPIRouter({
    pool,
    saveRMarketPIRecord,
    tableNames: {
      city: CITY_TABLE_NAME,
      company: COMPANY_TABLE_NAME,
      companyCategoryMapping: COMPANY_CATEGORY_MAPPING_TABLE_NAME,
      country: COUNTRY_TABLE_NAME,
      customer: CUSTOMER_TABLE_NAME,
      customerDiscount: CUSTOMER_DISCOUNT_TABLE_NAME,
      partyType: PARTY_TYPE_TABLE_NAME,
      piMaster: RMKT_PI_MASTER_TABLE_NAME,
      piTran: RMKT_PI_TRAN_TABLE_NAME,
      product: PRODUCT_TABLE_NAME,
      state: STATE_TABLE_NAME,
      tradingRate: TRADING_RATE_TABLE_NAME,
    },
  }),
)

app.get(/^(?!\/api).*/, (_request, response, next) => {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    next()
    return
  }

  response.sendFile(INDEX_HTML_PATH)
})

const getUniqueConstraintMessage = (error) => {
  if (error?.code !== '23505') {
    return ''
  }

  const constraint = String(error.constraint ?? '')
  const table = String(error.table ?? '')

  if (constraint.includes('master_customer_name_address_city')) {
    return CUSTOMER_DUPLICATE_MESSAGE
  }

  if (table === CUSTOMER_TABLE_NAME && constraint.includes('cust_name')) {
    return 'Customer name is still unique in PostgreSQL. Run the customer unique-key migration so duplicate checking uses name, address, and city.'
  }

  if (table === CUSTOMER_TABLE_NAME && constraint.includes('cust_code')) {
    return 'Customer code already exists.'
  }

  return 'Duplicate record already exists.'
}

app.use((error, _request, response, _next) => {
  console.error(error)
  const uniqueConstraintMessage = getUniqueConstraintMessage(error)

  if (uniqueConstraintMessage) {
    response.status(400).json({
      errors: [uniqueConstraintMessage],
      message: uniqueConstraintMessage,
    })
    return
  }

  response.status(500).json({
    message: 'Internal server error.',
    detail:
      process.env.NODE_ENV === 'production'
        ? undefined
        : error.message,
  })
})

app.listen(PORT, () => {
  console.log(`AUTOPAL Master API running at http://127.0.0.1:${PORT}`)
})

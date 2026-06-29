# AUTOPAL Master Backend

Node.js + Express API for AUTOPAL master tables using PostgreSQL.

## Environment

Create `.env` in the project root:

```env
PORT=5000
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/autopal_pi_system
```

The API reads/writes these PostgreSQL tables:

```text
master_products
master_customer
master_country
master_state
master_city
master_market
master_party_type
master_trading_product_rate
master_cust_discount
master_pi_rmkt
tran_pi_rmkt
```

Create the PI tables with:

```powershell
psql -U postgres -d autopal_pi_system -f backend/sql/create_pi_rmkt_tables.sql
```

## Run

Install dependencies:

```powershell
npm.cmd install
```

Start backend:

```powershell
npm.cmd run server
```

Development mode:

```powershell
npm.cmd run dev:server
```

API base URL:

```text
http://127.0.0.1:5000
```

## Endpoints

```text
GET    /api/health
GET    /api/master-customer-lookups
GET    /api/master-customers
GET    /api/master-customers/:id
POST   /api/master-customers
PUT    /api/master-customers/:id
DELETE /api/master-customers/:id

GET    /api/master-markets
GET    /api/master-products
GET    /api/master-products/:id
POST   /api/master-products
PUT    /api/master-products/:id
DELETE /api/master-products/:id

GET    /api/master-trading-product-rates
GET    /api/master-trading-product-rates/:id
POST   /api/master-trading-product-rates
PUT    /api/master-trading-product-rates/:id
DELETE /api/master-trading-product-rates/:id

GET    /api/master-cust-discounts
GET    /api/master-cust-discounts/:id
POST   /api/master-cust-discounts
PUT    /api/master-cust-discounts/:id
DELETE /api/master-cust-discounts/:id

Alias:
GET    /api/r-market-rates
GET    /api/r-market-rates/:id
POST   /api/r-market-rates
PUT    /api/r-market-rates/:id
DELETE /api/r-market-rates/:id

GET    /api/master-cust-discount
GET    /api/customer-discounts

GET    /api/master-pi-rmkt
GET    /api/master-pi-rmkt/:id
POST   /api/master-pi-rmkt

Alias:
GET    /api/r-market-pis
GET    /api/r-market-pis/:id
POST   /api/r-market-pis

WhatsApp PI import:
GET    /api/whatsapp-pi/webhook
POST   /api/whatsapp-pi/webhook
POST   /api/whatsapp-pi/parse-text
POST   /api/whatsapp-pi/import-text
```

## Product JSON Body

```json
{
  "code": "16-00-0024",
  "description": "HALB H4 24 V 100/90W P43t",
  "hsnCode": "85392120",
  "category": "Halogen Bulbs",
  "market": 4,
  "unit": "NOS",
  "gstPercent": 18
}
```

The API accepts camelCase names like `hsnCode` and `gstPercent`,
then stores them in SQL columns `hsn_code` and `gst_percent`.
Use `market` as the stored numeric code only. Product Master loads the
display names from `master_market` using `/api/master-markets`.

## Customer JSON Body

```json
{
  "custCode": 101,
  "custName": "ABC Auto Traders",
  "corrAddress": "Main Road, Jaipur",
  "corrCityCode": 1,
  "corrStateCode": 1,
  "corrCountryCode": 1,
  "corrPinCode": 302001,
  "corrTel": "0141-0000000",
  "corrEmail": "accounts@example.com",
  "marketCode": 4,
  "zone": "North",
  "partyTypeCode": 1,
  "gstinNo": "08ABCDE1234F1Z5",
  "gstDate": "2026-06-12",
  "panNo": "ABCDE1234F",
  "contactPerson": "Purchase Team",
  "mobileNo": "9000000000",
  "creditDays": 30,
  "creditLimit": 100000,
  "remarks": "Regular customer",
  "isActive": true
}
```

Customer Master loads city, state, country, market, and party type list boxes
from `/api/master-customer-lookups`. The `zone` field is manual text.

## R.Market Rate JSON Body

```json
{
  "effDate": "2026-06-01",
  "productCode": "16-00-0024",
  "wRate": 57,
  "swRate": 54,
  "rRate": 65,
  "iRate": 58,
  "oth1Rate": 56,
  "oth2Rate": 55,
  "disAmt": 3,
  "unitName": "NOS",
  "family": "Halogen Bulbs",
  "mrp": 95,
  "stdPkg": 10,
  "cpno": "H4-24V-100/90",
  "minStkQty": 200,
  "dispMrp": 95,
  "basicRate": 52,
  "plantName": "autopal-jaipur",
  "catDesc": "H4 Halogen Bulb",
  "compCode": 1
}
```

For R.Market rates, product category drives the company fields. `Head Lamp`
products use `compCode` 2 and `Halogen Bulbs` products use `compCode` 1.
`plantName` is stored from `master_company.company_id` for that company code.

## Customer Discount JSON Body

```json
{
  "effDate": "2026-06-12",
  "custCode": 101,
  "hlPer": 10,
  "haloPer": 8,
  "incdPer": 5,
  "wiperPer": 4,
  "gstPer": 18,
  "compCode": 1,
  "isActive": true
}
```

Customer Discount Master loads customer names from `/api/master-customers`,
then saves rows to `master_cust_discount`. The API generates `id` because the
current PostgreSQL table does not define an auto-increment default.

## R.Market PI JSON Body

Create PI saves a header row to `master_pi_rmkt` and product rows to
`tran_pi_rmkt` through `POST /api/master-pi-rmkt`. Posting the same `piNumber`
again updates the header and replaces the product rows.

## WhatsApp PI Import

The WhatsApp module parses order text like:

```text
Date: 20/06/2026
M/s Milan Automobiles
Belgaum
100/90 - 12V - PU37 - 500 NOS
130/100 - 12V PU37 - 200 NOS
130/100 - 24V PU37 - 100 NOS
```

It creates a regular R.Market PI by matching:

- customer name against `master_customer`
- item size and voltage against `master_products.description`
- product rates against `master_trading_product_rate`

Manual parse only:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:5000/api/whatsapp-pi/parse-text `
  -ContentType 'application/json' `
  -Body '{"text":"Date: 20/06/2026\nM/s Milan Automobiles\nBelgaum\n100/90 - 12V - PU37 - 500 NOS"}'
```

Manual parse and insert:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:5000/api/whatsapp-pi/import-text `
  -ContentType 'application/json' `
  -Body '{"text":"Date: 20/06/2026\nM/s Milan Automobiles\nBelgaum\n100/90 - 12V - PU37 - 500 NOS"}'
```

WhatsApp Cloud API webhook:

```text
Verify URL:  GET  /api/whatsapp-pi/webhook
Receive URL: POST /api/whatsapp-pi/webhook
```

Environment variables:

```env
WHATSAPP_VERIFY_TOKEN=your-webhook-verify-token
WHATSAPP_ACCESS_TOKEN=your-whatsapp-cloud-api-token
WHATSAPP_GRAPH_API_BASE=https://graph.facebook.com/v20.0

# Optional defaults
WHATSAPP_PI_COMP_CODE=1
WHATSAPP_PI_COMPANY_ID=autopal-jaipur
WHATSAPP_PI_SERIES=HAL-
WHATSAPP_PI_IGST_PERCENT=18
WHATSAPP_PI_DEFAULT_PARTY_TYPE_CODE=1
WHATSAPP_PI_DEFAULT_ADDRESS=
WHATSAPP_PI_DEFAULT_CONTACT_NO=
WHATSAPP_PI_TRANSPORT_MODE=
WHATSAPP_PI_TRANSPORTER_CODE=0
WHATSAPP_PI_TRANSPORTER=

# Required only for image messages without a caption.
# The service should accept { "imageBase64": "...", "mimeType": "image/jpeg" }
# and return { "text": "..." }.
WHATSAPP_PI_IMAGE_EXTRACTOR_URL=
WHATSAPP_PI_IMAGE_EXTRACTOR_TOKEN=
```

For image messages, the module first uses the WhatsApp image caption. If there
is no caption, it downloads the image and sends it to `WHATSAPP_PI_IMAGE_EXTRACTOR_URL`
for OCR/vision extraction.

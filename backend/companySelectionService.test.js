import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeCategoryKey,
  selectCompanyForProductCategories,
} from './companySelectionService.js'

const createPool = () => {
  const mappingRows = new Map([
    [
      'HEAD LAMP',
      {
        category_key: 'HEAD LAMP',
        category_name: 'HEAD LAMP',
        comp_code: 22,
        company_id: 'autolite-manufacturing',
        company_name: 'AUTOLITE',
        legal_name: 'Autolite Manufacturing Limited',
        pi_prefix: 'AML-',
        state_code: '08',
      },
    ],
    [
      'HALOGEN BULBS',
      {
        category_key: 'HALOGEN BULBS',
        category_name: 'HALOGEN BULBS',
        comp_code: 11,
        company_id: 'autopal-india',
        company_name: 'AUTOPAL',
        legal_name: 'Autolite (India) Limited',
        pi_prefix: 'HAL-',
        state_code: '08',
      },
    ],
  ])

  return {
    async query(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) {
        return { rows: [] }
      }

      if (/FROM\s+master_company_category_mapping/i.test(sql)) {
        const keys = params[0] ?? []

        return {
          rows: keys
            .map((key) => mappingRows.get(key))
            .filter(Boolean),
        }
      }

      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

const tableNames = {
  company: 'master_company',
  companyCategoryMapping: 'master_company_category_mapping',
}

test('normalizes product category keys', () => {
  assert.equal(normalizeCategoryKey(' Head   Lamp. '), 'HEAD LAMP')
  assert.equal(normalizeCategoryKey('Halogen Bulbs'), 'HALOGEN BULBS')
})

test('selects Autolite Manufacturing Limited for Head Lamp category', async () => {
  const result = await selectCompanyForProductCategories({
    categories: ['Head Lamp'],
    pool: createPool(),
    tableNames,
  })

  assert.equal(result.status, 'SELECTED')
  assert.equal(result.selectedCompany.legal_name, 'Autolite Manufacturing Limited')
  assert.equal(result.selectedCompany.comp_code, 22)
  assert.equal(result.selectedCompany.pi_prefix, 'AML-')
})

test('selects Autolite India Limited for Halogen Bulbs category', async () => {
  const result = await selectCompanyForProductCategories({
    categories: ['Halogen Bulbs'],
    pool: createPool(),
    tableNames,
  })

  assert.equal(result.status, 'SELECTED')
  assert.equal(result.selectedCompany.legal_name, 'Autolite (India) Limited')
  assert.equal(result.selectedCompany.comp_code, 11)
  assert.equal(result.selectedCompany.pi_prefix, 'HAL-')
})

test('returns MULTI_COMPANY_ORDER for categories mapped to different companies', async () => {
  const result = await selectCompanyForProductCategories({
    categories: ['Head Lamp', 'Halogen Bulbs'],
    pool: createPool(),
    tableNames,
  })

  assert.equal(result.status, 'MULTI_COMPANY_ORDER')
  assert.equal(result.selectedCompany, null)
  assert.equal(result.options.length, 2)
  assert.equal(result.splitOptions.length, 2)
})

test('returns MAPPING_NOT_FOUND when a category is not mapped', async () => {
  const result = await selectCompanyForProductCategories({
    categories: ['LED'],
    pool: createPool(),
    tableNames,
  })

  assert.equal(result.status, 'MAPPING_NOT_FOUND')
  assert.deepEqual(result.missingCategories, ['LED'])
})

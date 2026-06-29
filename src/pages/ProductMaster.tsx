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
import type { FieldOption, Product } from '../types'
import { parseNumber } from '../utils/calculations'

const ALL_FILTER_VALUE = 'all'
const PRODUCT_API_URL = apiUrl('/api/master-products')
const MARKET_API_URL = apiUrl('/api/master-markets')
const PRODUCT_COLUMN_WIDTHS_STORAGE_KEY =
  'autopal-product-master-column-widths'
const productCategoryOptions = ['Head Lamp', 'Halogen Bulbs']
const fallbackProductMarketOptions: FieldOption[] = [
  { value: '0', label: 'N.A.' },
  { value: '1', label: 'OEM' },
  { value: '2', label: 'BRANDING' },
  { value: '3', label: 'EXPORT' },
  { value: '4', label: 'R.MKT' },
  { value: '5', label: 'TRADING' },
  { value: '6', label: 'DND' },
]

type MarketApiItem = {
  code: number
  name: string
}

type ProductPopup =
  | {
      message: string
      mode: 'alert'
    }
  | {
      message: string
      mode: 'confirm-delete'
      productId: string
    }

const productTableColumns = [
  { defaultWidth: 14, id: 'code', label: 'Product code', minWidth: 10 },
  { defaultWidth: 30, id: 'description', label: 'Description', minWidth: 18 },
  { defaultWidth: 9, id: 'hsn', label: 'HSN', minWidth: 7 },
  { defaultWidth: 13, id: 'category', label: 'Category', minWidth: 9 },
  { defaultWidth: 12, id: 'market', label: 'Market', minWidth: 9 },
  { defaultWidth: 7, id: 'unit', label: 'Unit', minWidth: 5 },
  { defaultWidth: 6, id: 'gst', label: 'GST', minWidth: 5 },
  { defaultWidth: 9, id: 'actions', label: 'Actions', minWidth: 7 },
] as const

type ProductTableColumnId = (typeof productTableColumns)[number]['id']
type ProductColumnWidths = Record<ProductTableColumnId, number>
type ProductColumnResize = {
  columnId: ProductTableColumnId
  nextColumnId: ProductTableColumnId
  nextStartWidth: number
  startWidth: number
  startX: number
  tableWidth: number
}

const getDefaultProductColumnWidths = () =>
  productTableColumns.reduce(
    (widths, column) => ({
      ...widths,
      [column.id]: column.defaultWidth,
    }),
    {} as ProductColumnWidths,
  )

const productColumnMinWidths = productTableColumns.reduce(
  (widths, column) => ({
    ...widths,
    [column.id]: column.minWidth,
  }),
  {} as ProductColumnWidths,
)

const getStoredProductColumnWidths = () => {
  const defaultWidths = getDefaultProductColumnWidths()

  if (typeof window === 'undefined') {
    return defaultWidths
  }

  try {
    const storedValue = window.localStorage.getItem(
      PRODUCT_COLUMN_WIDTHS_STORAGE_KEY,
    )

    if (!storedValue) {
      return defaultWidths
    }

    const parsedValue = JSON.parse(storedValue) as Partial<
      Record<ProductTableColumnId, unknown>
    >
    const storedWidths = productTableColumns.reduce(
      (widths, column) => ({
        ...widths,
        [column.id]: Number(parsedValue[column.id]),
      }),
      {} as ProductColumnWidths,
    )
    const hasValidWidths = productTableColumns.every(
      (column) =>
        Number.isFinite(storedWidths[column.id]) &&
        storedWidths[column.id] >= column.minWidth,
    )
    const totalWidth = productTableColumns.reduce(
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

const getProductMarketLabel = (market: number, options: FieldOption[]) =>
  options.find((option) => option.value === String(market))
    ?.label ?? String(market)

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

export function ProductMaster() {
  const [products, setProducts] = useState<Product[]>([])
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [editingOriginalProduct, setEditingOriginalProduct] =
    useState<Product | null>(null)
  const [statusMessage, setStatusMessage] = useState(
    'Loading products from PostgreSQL',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(ALL_FILTER_VALUE)
  const [marketOptions, setMarketOptions] = useState<FieldOption[]>(
    fallbackProductMarketOptions,
  )
  const [productPopup, setProductPopup] = useState<ProductPopup | null>(null)
  const [productColumnWidths, setProductColumnWidths] = useState(
    getStoredProductColumnWidths,
  )
  const productColumnResizeRef = useRef<ProductColumnResize | null>(null)

  useEffect(() => {
    const loadProducts = async () => {
      setIsLoading(true)
      setErrorMessage('')

      try {
        const marketResponse = await fetch(MARKET_API_URL)

        if (!marketResponse.ok) {
          throw new Error(await getApiErrorMessage(marketResponse))
        }

        const apiMarkets = (await marketResponse.json()) as MarketApiItem[]
        const loadedMarketOptions = apiMarkets
          .map((market) => ({
            value: String(market.code),
            label: market.name,
          }))
          .filter((market) => market.value && market.label)

        if (loadedMarketOptions.length > 0) {
          setMarketOptions(loadedMarketOptions)
        }
      } catch (error) {
        setMarketOptions(fallbackProductMarketOptions)
        setErrorMessage(
          error instanceof Error
            ? `Market list API: ${error.message}`
            : 'Market list API is not connected.',
        )
      }

      try {
        const response = await fetch(PRODUCT_API_URL)

        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response))
        }

        const apiProducts = ((await response.json()) as Product[]).map(
          (product) => ({
            ...product,
            market: Number(product.market ?? 0),
          }),
        )

        setProducts(apiProducts)
        setStatusMessage(`${apiProducts.length} products loaded`)
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unable to load products from backend.',
        )
        setStatusMessage('Backend not connected')
      } finally {
        setIsLoading(false)
      }
    }

    void loadProducts()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(
      PRODUCT_COLUMN_WIDTHS_STORAGE_KEY,
      JSON.stringify(productColumnWidths),
    )
  }, [productColumnWidths])

  useEffect(() => {
    const stopColumnResize = () => {
      productColumnResizeRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    const resizeColumn = (event: MouseEvent) => {
      const resize = productColumnResizeRef.current

      if (!resize) {
        return
      }

      const deltaWidth =
        ((event.clientX - resize.startX) / resize.tableWidth) * 100
      const minDelta =
        productColumnMinWidths[resize.columnId] - resize.startWidth
      const maxDelta =
        resize.nextStartWidth - productColumnMinWidths[resize.nextColumnId]
      const boundedDelta = Math.min(
        Math.max(deltaWidth, minDelta),
        maxDelta,
      )

      setProductColumnWidths((currentWidths) => ({
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

  const categoryFilterOptions = useMemo<FieldOption[]>(() => {
    const categories = Array.from(
      new Set(
        [...productCategoryOptions, ...products.map((product) => product.category)]
          .filter(Boolean)
          .sort(),
      ),
    )

    return [
      { value: ALL_FILTER_VALUE, label: 'All categories' },
      ...categories.map((category) => ({
        value: category,
        label: category,
      })),
    ]
  }, [products])

  const filteredProducts = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase()

    return products.filter((product) => {
      const matchesSearch =
        !normalizedSearch ||
        [
          product.code,
          product.description,
          product.hsnCode,
          product.category,
          getProductMarketLabel(product.market, marketOptions),
          product.unit,
        ].some((value) => value.toLowerCase().includes(normalizedSearch))
      const matchesCategory =
        categoryFilter === ALL_FILTER_VALUE ||
        product.category === categoryFilter

      return matchesSearch && matchesCategory
    })
  }, [categoryFilter, marketOptions, products, searchTerm])

  const selectedProduct = useMemo(
    () =>
      editingProductId === null
        ? null
        : products.find((product) => product.id === editingProductId) ?? null,
    [editingProductId, products],
  )

  const addProduct = () => {
    if (editingProductId) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const newProduct: Product = {
      id: `temp-${Date.now()}`,
      code: '',
      description: '',
      hsnCode: '',
      unit: 'NOS',
      category: 'Halogen Bulbs',
      market: parseNumber(marketOptions[0]?.value ?? '0'),
      gstPercent: 18,
    }

    setProducts((currentProducts) => [newProduct, ...currentProducts])
    setSearchTerm('')
    setCategoryFilter(ALL_FILTER_VALUE)
    setEditingProductId(newProduct.id)
    setEditingOriginalProduct(null)
    setErrorMessage('')
    setStatusMessage('New product row added')
  }

  const updateProduct = <Key extends keyof Product>(
    productId: string,
    field: Key,
    value: Product[Key],
  ) => {
    setProducts((currentProducts) =>
      currentProducts.map((product) =>
        product.id === productId ? { ...product, [field]: value } : product,
      ),
    )
  }

  const startProductColumnResize = (
    event: ReactMouseEvent<HTMLButtonElement>,
    columnIndex: number,
  ) => {
    const column = productTableColumns[columnIndex]
    const nextColumn = productTableColumns[columnIndex + 1]
    const table = event.currentTarget.closest('table')
    const tableWidth = table?.getBoundingClientRect().width ?? 0

    if (!column || !nextColumn || tableWidth <= 0) {
      return
    }

    productColumnResizeRef.current = {
      columnId: column.id,
      nextColumnId: nextColumn.id,
      nextStartWidth: productColumnWidths[nextColumn.id],
      startWidth: productColumnWidths[column.id],
      startX: event.clientX,
      tableWidth,
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    event.preventDefault()
  }

  const editProduct = (productId: string) => {
    if (editingProductId && editingProductId !== productId) {
      setStatusMessage('Save or cancel the current row first')
      return
    }

    const product = products.find((item) => item.id === productId)

    setEditingProductId(productId)
    setEditingOriginalProduct(product ? { ...product } : null)
    setErrorMessage('')
    setStatusMessage('Editing product details')
  }

  const saveProduct = async () => {
    if (!editingProductId) {
      return
    }

    const product = products.find((item) => item.id === editingProductId)

    if (!product) {
      return
    }

    const isNewProduct = !editingOriginalProduct

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(
        isNewProduct
          ? PRODUCT_API_URL
          : `${PRODUCT_API_URL}/${editingProductId}`,
        {
          body: JSON.stringify(product),
          headers: {
            'Content-Type': 'application/json',
          },
          method: isNewProduct ? 'POST' : 'PUT',
        },
      )

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      const savedProduct = (await response.json()) as Product

      setProducts((currentProducts) =>
        isNewProduct
          ? [
              savedProduct,
              ...currentProducts.filter((item) => item.id !== product.id),
            ]
          : currentProducts.map((item) =>
              item.id === savedProduct.id ? savedProduct : item,
            ),
      )
      setEditingProductId(null)
      setEditingOriginalProduct(null)
      const productLabel =
        savedProduct.code || savedProduct.description || 'product'
      const successMessage = isNewProduct
        ? `Product ${productLabel} saved successfully.`
        : `Product ${productLabel} updated successfully.`

      setStatusMessage(
        isNewProduct
          ? 'Product saved to PostgreSQL'
          : 'Product updated in PostgreSQL',
      )
      setProductPopup({ message: successMessage, mode: 'alert' })
    } catch (error) {
      const saveErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to save product in backend.'

      setErrorMessage(saveErrorMessage)
      setStatusMessage('Save failed')
      setProductPopup({ message: saveErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const cancelProduct = () => {
    if (!editingProductId) {
      return
    }

    if (editingOriginalProduct) {
      setProducts((currentProducts) =>
        currentProducts.map((product) =>
          product.id === editingOriginalProduct.id
            ? editingOriginalProduct
            : product,
        ),
      )
    } else {
      setProducts((currentProducts) =>
        currentProducts.filter((product) => product.id !== editingProductId),
      )
    }

    setEditingProductId(null)
    setEditingOriginalProduct(null)
    setErrorMessage('')
    setStatusMessage('Product edit cancelled')
  }

  const confirmDeleteProduct = (productId: string) => {
    const product = products.find((item) => item.id === productId)

    setProductPopup({
      message: `Delete product ${product?.code || product?.description || 'this row'}?`,
      mode: 'confirm-delete',
      productId,
    })
  }

  const deleteProduct = async (productId: string) => {
    const product = products.find((item) => item.id === productId)
    const productLabel = product?.code || product?.description || 'this row'

    if (productId.startsWith('temp-')) {
      setProducts((currentProducts) =>
        currentProducts.filter((item) => item.id !== productId),
      )
      setEditingProductId(null)
      setEditingOriginalProduct(null)
      setStatusMessage('New product row deleted')
      setProductPopup({
        message: `Product ${productLabel} deleted successfully.`,
        mode: 'alert',
      })
      return
    }

    setIsSaving(true)
    setErrorMessage('')

    try {
      const response = await fetch(`${PRODUCT_API_URL}/${productId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }

      setProducts((currentProducts) =>
        currentProducts.filter((item) => item.id !== productId),
      )
      if (editingProductId === productId) {
        setEditingProductId(null)
        setEditingOriginalProduct(null)
      }
      setStatusMessage('Product deleted from PostgreSQL')
      setProductPopup({
        message: `Product ${productLabel} deleted successfully.`,
        mode: 'alert',
      })
    } catch (error) {
      const deleteErrorMessage =
        error instanceof Error
          ? error.message
          : 'Unable to delete product from backend.'

      setErrorMessage(deleteErrorMessage)
      setStatusMessage('Delete failed')
      setProductPopup({ message: deleteErrorMessage, mode: 'alert' })
    } finally {
      setIsSaving(false)
    }
  }

  const renderSelectedProductForm = () => {
    if (!selectedProduct) {
      return null
    }

    return (
      <section className="panel customer-edit-panel product-edit-panel">
        <div className="customer-tab-actions">
          <div>
            <p className="eyebrow">
              {editingOriginalProduct ? 'Edit product' : 'Add product'}
            </p>
            <h2>{selectedProduct.code || 'New Product'}</h2>
          </div>
          <div className="table-actions">
            <Button
              disabled={isSaving}
              onClick={saveProduct}
              variant="secondary"
            >
              {isSaving ? 'Saving' : 'Save'}
            </Button>
            <Button disabled={isSaving} onClick={cancelProduct} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={isSaving}
              onClick={() => confirmDeleteProduct(selectedProduct.id)}
              variant="danger"
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="customer-form-grid product-form-grid">
          <label className="field">
            <span className="field-label">Product Code</span>
            <input
              className="field-control"
              onChange={(event) =>
                updateProduct(selectedProduct.id, 'code', event.target.value)
              }
              value={selectedProduct.code}
            />
          </label>
          <label className="field customer-form-span-2">
            <span className="field-label">Description</span>
            <input
              className="field-control"
              onChange={(event) =>
                updateProduct(
                  selectedProduct.id,
                  'description',
                  event.target.value,
                )
              }
              value={selectedProduct.description}
            />
          </label>
          <label className="field">
            <span className="field-label">HSN</span>
            <input
              className="field-control"
              onChange={(event) =>
                updateProduct(selectedProduct.id, 'hsnCode', event.target.value)
              }
              value={selectedProduct.hsnCode}
            />
          </label>
          <label className="field">
            <span className="field-label">Category</span>
            <select
              className="field-control select-control"
              onChange={(event) =>
                updateProduct(selectedProduct.id, 'category', event.target.value)
              }
              value={selectedProduct.category}
            >
              {productCategoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Market</span>
            <select
              className="field-control select-control"
              onChange={(event) =>
                updateProduct(
                  selectedProduct.id,
                  'market',
                  parseNumber(event.target.value),
                )
              }
              value={String(selectedProduct.market)}
            >
              {marketOptions.map((market) => (
                <option key={market.value} value={market.value}>
                  {market.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Unit</span>
            <input
              className="field-control"
              onChange={(event) =>
                updateProduct(selectedProduct.id, 'unit', event.target.value)
              }
              value={selectedProduct.unit}
            />
          </label>
          <label className="field">
            <span className="field-label">GST (%)</span>
            <input
              className="field-control"
              min="0"
              onChange={(event) =>
                updateProduct(
                  selectedProduct.id,
                  'gstPercent',
                  parseNumber(event.target.value),
                )
              }
              type="number"
              value={selectedProduct.gstPercent}
            />
          </label>
        </div>
      </section>
    )
  }

  return (
    <div className="page">
      {productPopup ? (
        <div
          aria-labelledby="product-popup-title"
          aria-modal="true"
          className="autopal-alert-backdrop"
          role="dialog"
        >
          <div className="autopal-alert">
            <h2 id="product-popup-title">Autopal</h2>
            <p>{productPopup.message}</p>
            <div className="autopal-alert-actions">
              {productPopup.mode === 'confirm-delete' ? (
                <>
                  <Button
                    disabled={isSaving}
                    onClick={() => void deleteProduct(productPopup.productId)}
                    variant="danger"
                  >
                    Yes
                  </Button>
                  <Button
                    disabled={isSaving}
                    onClick={() => setProductPopup(null)}
                    variant="ghost"
                  >
                    No
                  </Button>
                </>
              ) : (
                <Button onClick={() => setProductPopup(null)}>OK</Button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <header className="page-header">
        <div>
          <p className="eyebrow">Master data</p>
          <h1>Product Master</h1>
          <p className="page-subtitle">
            AUTOPAL product catalog for PI line-item selection.
          </p>
        </div>
        <div className="header-actions">
          <span className="status-pill">{statusMessage}</span>
          <Button disabled={isLoading || isSaving} onClick={addProduct}>
            <span className="btn-symbol">+</span>
            Add
          </Button>
        </div>
      </header>

      {!selectedProduct ? (
        <section className="panel product-master-controls">
          <InputField
            label="Search Product"
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Code, description, HSN, category, market"
            value={searchTerm}
          />
          <SelectField
            label="Category"
            onChange={(event) => setCategoryFilter(event.target.value)}
            options={categoryFilterOptions}
            value={categoryFilter}
          />
        </section>
      ) : null}

      {renderSelectedProductForm()}

      {!selectedProduct ? (
        <section className="panel">
          <div className="responsive-table">
            <table className="master-table product-master-table">
              <colgroup>
                {productTableColumns.map((column) => (
                  <col
                    key={column.id}
                    style={{ width: `${productColumnWidths[column.id]}%` }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {productTableColumns.map((column, index) => (
                    <th className="resizable-column-header" key={column.id}>
                      <span>{column.label}</span>
                      {index < productTableColumns.length - 1 ? (
                        <button
                          aria-label={`Resize ${column.label} column`}
                          className="column-resize-handle"
                          onMouseDown={(event) =>
                            startProductColumnResize(event, index)
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
                {filteredProducts.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty-state">
                        <p className="eyebrow">Product API</p>
                        <h2>
                          {isLoading
                            ? 'Loading products...'
                            : products.length === 0
                              ? 'No products found'
                              : 'No matching products'}
                        </h2>
                        <p>
                          {isLoading
                            ? 'Fetching Product Master data from PostgreSQL.'
                            : products.length === 0
                              ? errorMessage ||
                                'Click Add to create your first product.'
                              : 'Change the search text or category filter.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredProducts.map((product) => (
                    <tr key={product.id}>
                      <td>
                        <strong>{product.code}</strong>
                      </td>
                      <td>{product.description}</td>
                      <td>{product.hsnCode}</td>
                      <td>{product.category}</td>
                      <td>{getProductMarketLabel(product.market, marketOptions)}</td>
                      <td>{product.unit}</td>
                      <td>{product.gstPercent}%</td>
                      <td>
                        <div className="table-actions">
                          <Button
                            disabled={isSaving}
                            onClick={() => editProduct(product.id)}
                            variant="ghost"
                          >
                            Edit
                          </Button>
                          <Button
                            disabled={isSaving}
                            onClick={() => confirmDeleteProduct(product.id)}
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
          {errorMessage && products.length > 0 ? (
            <p className="form-helper">{errorMessage}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

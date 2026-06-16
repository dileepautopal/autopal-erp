import { Button } from '../ui/Button'
import { calculateLine, formatCurrency, parseNumber } from '../../utils/calculations'
import type { LineItem, Product } from '../../types'

type LineItemsTableProps = {
  currency: string
  lineItems: LineItem[]
  products: Product[]
  onAddRow: () => void
  onRemoveRow: (id: string) => void
  onUpdateRow: (id: string, updates: Partial<LineItem>) => void
}

export function LineItemsTable({
  currency,
  lineItems,
  products,
  onAddRow,
  onRemoveRow,
  onUpdateRow,
}: LineItemsTableProps) {
  const selectProduct = (rowId: string, productId: string) => {
    const product = products.find((item) => item.id === productId)

    if (!product) {
      onUpdateRow(rowId, {
        productId: '',
        productCode: '',
        description: '',
        hsnCode: '',
        unit: '',
        unitPrice: 0,
        gstPercent: 0,
      })
      return
    }

    onUpdateRow(rowId, {
      productId: product.id,
      productCode: product.code,
      description: product.description,
      hsnCode: product.hsnCode,
      unit: product.unit,
      unitPrice: 0,
      gstPercent: product.gstPercent,
    })
  }

  return (
    <section className="panel line-items-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Line Items</p>
          <h2>Product details</h2>
        </div>
        <Button onClick={onAddRow} variant="secondary">
          <span className="btn-symbol">+</span>
          Add row
        </Button>
      </div>

      <div className="line-table-wrap">
        <table className="line-table">
          <thead>
            <tr>
              <th>Product code</th>
              <th>Description</th>
              <th>HSN</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Taxable value</th>
              <th>GST %</th>
              <th>Total</th>
              <th aria-label="Remove row"></th>
            </tr>
          </thead>
          <tbody>
            {lineItems.map((item) => {
              const calculatedLine = calculateLine(item)

              return (
                <tr key={item.id}>
                  <td>
                    <select
                      className="table-control product-code-control"
                      onChange={(event) =>
                        selectProduct(item.id, event.target.value)
                      }
                      value={item.productId}
                    >
                      <option value="">Select product</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="table-control description-control"
                      onChange={(event) =>
                        onUpdateRow(item.id, {
                          description: event.target.value,
                        })
                      }
                      value={item.description}
                    />
                  </td>
                  <td>
                    <input
                      className="table-control hsn-control"
                      onChange={(event) =>
                        onUpdateRow(item.id, { hsnCode: event.target.value })
                      }
                      value={item.hsnCode}
                    />
                  </td>
                  <td>
                    <input
                      className="table-control number-control"
                      min="0"
                      onChange={(event) =>
                        onUpdateRow(item.id, {
                          quantity: parseNumber(event.target.value),
                        })
                      }
                      type="number"
                      value={item.quantity || ''}
                    />
                  </td>
                  <td>
                    <input
                      className="table-control number-control"
                      min="0"
                      onChange={(event) =>
                        onUpdateRow(item.id, {
                          unitPrice: parseNumber(event.target.value),
                        })
                      }
                      type="number"
                      value={item.unitPrice || ''}
                    />
                  </td>
                  <td className="line-total">
                    {formatCurrency(calculatedLine.taxableAmount, currency)}
                  </td>
                  <td>
                    <input
                      className="table-control gst-control"
                      min="0"
                      onChange={(event) =>
                        onUpdateRow(item.id, {
                          gstPercent: parseNumber(event.target.value),
                        })
                      }
                      type="number"
                      value={item.gstPercent || ''}
                    />
                  </td>
                  <td className="line-total">
                    {formatCurrency(calculatedLine.lineTotal, currency)}
                  </td>
                  <td>
                    <button
                      aria-label="Remove product row"
                      className="icon-button"
                      disabled={lineItems.length === 1}
                      onClick={() => onRemoveRow(item.id)}
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
    </section>
  )
}

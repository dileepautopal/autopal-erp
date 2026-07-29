import {
  formatINR,
  formatReportDate,
} from '../utils/exportUtils'
import type { ExecutiveDrillDownRow } from '../services/aiService'

type ExecutiveDrillDownTableProps = {
  onRowSelect?: (row: ExecutiveDrillDownRow) => void
  rows: ExecutiveDrillDownRow[]
}

const preferredColumns = [
  'piNumber',
  'piDate',
  'customerName',
  'companyName',
  'status',
  'grandTotal',
  'productCode',
  'productDescription',
  'quantity',
  'rate',
  'amount',
  'currentPICount',
  'currentPIValue',
  'totalPILineValue',
  'shareOfTotalPIValue',
  'classification',
  'lastPIDate',
]

const labels: Record<string, string> = {
  amount: 'Amount',
  classification: 'Classification',
  companyCode: 'Company Code',
  companyName: 'Company',
  currentPICount: 'PI Count',
  currentPIValue: 'PI Value',
  customerCode: 'Customer Code',
  customerName: 'Customer',
  grandTotal: 'Grand Total',
  lastPIDate: 'Last PI Date',
  piDate: 'PI Date',
  piNumber: 'PI Number',
  productCode: 'Product Code',
  productDescription: 'Product',
  quantity: 'Quantity',
  rate: 'Rate',
  shareOfTotalPIValue: 'Share %',
  status: 'Status',
  totalPILineValue: 'PI Line Value',
}

const getColumns = (rows: ExecutiveDrillDownRow[]) => {
  const present = new Set(rows.flatMap((row) => Object.keys(row)))
  const ordered = preferredColumns.filter((column) => present.has(column))
  const extra = Array.from(present)
    .filter((column) => !ordered.includes(column))
    .filter((column) => !/gst|pan|address|phone|email|bank/i.test(column))
    .slice(0, 8)

  return [...ordered, ...extra]
}

const formatValue = (column: string, value: unknown) => {
  if (value === null || value === undefined || value === '') {
    return '-'
  }

  if (['amount', 'grandTotal', 'rate', 'currentPIValue', 'totalPILineValue'].includes(column)) {
    return formatINR(Number(value))
  }

  if (/date/i.test(column) && typeof value === 'string') {
    return formatReportDate(value)
  }

  if (typeof value === 'number') {
    return new Intl.NumberFormat('en-IN', {
      maximumFractionDigits: 2,
    }).format(value)
  }

  return String(value)
}

export function ExecutiveDrillDownTable({
  onRowSelect,
  rows,
}: ExecutiveDrillDownTableProps) {
  if (!rows.length) {
    return (
      <div className="empty-state pi-intelligence-empty">
        <strong>No supporting records</strong>
        <span>No rows were found for this drill-down.</span>
      </div>
    )
  }

  const columns = getColumns(rows)

  return (
    <div className="pi-intelligence-table-wrap executive-drilldown-table-wrap">
      <table className="pi-intelligence-table executive-drilldown-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{labels[column] ?? column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              className={onRowSelect ? 'executive-click-row' : ''}
              key={`${row.piNumber ?? row.productCode ?? row.customerName ?? 'row'}-${rowIndex}`}
              onClick={onRowSelect ? () => onRowSelect(row) : undefined}
              tabIndex={onRowSelect ? 0 : undefined}
              onKeyDown={
                onRowSelect
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onRowSelect(row)
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td
                  className={
                    ['amount', 'grandTotal', 'rate', 'quantity', 'currentPIValue', 'totalPILineValue'].includes(column)
                      ? 'numeric'
                      : ''
                  }
                  key={`${column}-${rowIndex}`}
                >
                  {formatValue(column, row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

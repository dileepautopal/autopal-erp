import { useState, type FormEvent } from 'react'
import { Button } from './ui/Button'
import type { ExecutiveSearchParams } from '../services/aiService'

type ExecutiveSearchBarProps = {
  disabled?: boolean
  onSearch: (params: ExecutiveSearchParams) => void
}

const categories = [
  ['all', 'All safe fields'],
  ['pi', 'PI number'],
  ['customer', 'Customer'],
  ['product', 'Product'],
  ['company', 'Company'],
  ['status', 'Status'],
] as const

export function ExecutiveSearchBar({
  disabled = false,
  onSearch,
}: ExecutiveSearchBarProps) {
  const [category, setCategory] = useState<ExecutiveSearchParams['category']>('all')
  const [endDate, setEndDate] = useState('')
  const [maxValue, setMaxValue] = useState('')
  const [minValue, setMinValue] = useState('')
  const [q, setQ] = useState('')
  const [startDate, setStartDate] = useState('')
  const [status, setStatus] = useState('')

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSearch({
      category,
      endDate,
      maxValue,
      minValue,
      q,
      startDate,
      status,
    })
  }

  return (
    <form className="executive-search-bar" onSubmit={submitSearch}>
      <label>
        <span>Search</span>
        <input
          onChange={(event) => setQ(event.target.value)}
          placeholder="PI number, customer, product, company"
          value={q}
        />
      </label>
      <label>
        <span>Category</span>
        <select
          onChange={(event) =>
            setCategory(event.target.value as ExecutiveSearchParams['category'])
          }
          value={category}
        >
          {categories.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Status</span>
        <select onChange={(event) => setStatus(event.target.value)} value={status}>
          <option value="">Any</option>
          <option value="open">Open</option>
          <option value="final">Final</option>
        </select>
      </label>
      <label>
        <span>Start Date</span>
        <input
          onChange={(event) => setStartDate(event.target.value)}
          type="date"
          value={startDate}
        />
      </label>
      <label>
        <span>End Date</span>
        <input
          onChange={(event) => setEndDate(event.target.value)}
          type="date"
          value={endDate}
        />
      </label>
      <label>
        <span>Min PI Value</span>
        <input
          min="0"
          onChange={(event) => setMinValue(event.target.value)}
          type="number"
          value={minValue}
        />
      </label>
      <label>
        <span>Max PI Value</span>
        <input
          min="0"
          onChange={(event) => setMaxValue(event.target.value)}
          type="number"
          value={maxValue}
        />
      </label>
      <div className="executive-search-actions">
        <Button disabled={disabled} type="submit">
          Search
        </Button>
      </div>
    </form>
  )
}

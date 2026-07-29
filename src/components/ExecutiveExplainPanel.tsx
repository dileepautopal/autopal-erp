import { formatReportDateTime } from '../utils/exportUtils'
import type { ExecutiveExplainResponse } from '../services/aiService'

type ExecutiveExplainPanelProps = {
  errorMessage?: string
  explanation: ExecutiveExplainResponse | null
  isLoading?: boolean
}

export function ExecutiveExplainPanel({
  errorMessage = '',
  explanation,
  isLoading = false,
}: ExecutiveExplainPanelProps) {
  if (isLoading) {
    return (
      <div className="executive-explain-panel">
        <strong>Explaining...</strong>
        <p>Preparing explanation from verified drill-down data.</p>
      </div>
    )
  }

  if (errorMessage) {
    return (
      <div className="executive-explain-panel executive-explain-error">
        <strong>Explain unavailable</strong>
        <p>{errorMessage}</p>
      </div>
    )
  }

  if (!explanation?.explanation) {
    return null
  }

  return (
    <div className="executive-explain-panel">
      <div>
        <strong>Explain this</strong>
        <span>{explanation.wordingMode === 'ollama' ? 'AI wording' : 'Server fallback'}</span>
      </div>
      <p>{explanation.explanation}</p>
      <small>{formatReportDateTime(explanation.generatedAt)}</small>
    </div>
  )
}

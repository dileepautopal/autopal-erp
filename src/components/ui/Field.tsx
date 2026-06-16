import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import type { FieldOption } from '../../types'

type FieldFrameProps = {
  children: ReactNode
  label: string
  htmlFor: string
  hint?: string
}

function FieldFrame({ children, label, htmlFor, hint }: FieldFrameProps) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

type InputFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
}

export function InputField({
  className = '',
  id,
  label,
  hint,
  ...props
}: InputFieldProps) {
  const fieldId = id ?? label.toLowerCase().replaceAll(' ', '-')

  return (
    <FieldFrame htmlFor={fieldId} label={label} hint={hint}>
      <input
        className={`field-control ${className}`.trim()}
        id={fieldId}
        {...props}
      />
    </FieldFrame>
  )
}

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
  options: FieldOption[]
  hint?: string
}

export function SelectField({
  className = '',
  id,
  label,
  options,
  hint,
  ...props
}: SelectFieldProps) {
  const fieldId = id ?? label.toLowerCase().replaceAll(' ', '-')

  return (
    <FieldFrame htmlFor={fieldId} label={label} hint={hint}>
      <select
        className={`field-control select-control ${className}`.trim()}
        id={fieldId}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  )
}

type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string
  hint?: string
}

export function TextareaField({
  className = '',
  id,
  label,
  hint,
  ...props
}: TextareaFieldProps) {
  const fieldId = id ?? label.toLowerCase().replaceAll(' ', '-')

  return (
    <FieldFrame htmlFor={fieldId} label={label} hint={hint}>
      <textarea
        className={`field-control textarea-control ${className}`.trim()}
        id={fieldId}
        {...props}
      />
    </FieldFrame>
  )
}

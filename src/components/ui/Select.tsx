import { forwardRef, type SelectHTMLAttributes } from 'react'
import clsx from 'clsx'
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { label?: string; options: { value: string; label: string }[]; placeholder?: string }
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, options, placeholder, className, id, ...props }, ref) {
  const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
  return <label className="block text-xs font-medium text-agni-ink" htmlFor={selectId}>{label && <span className="mb-1 block">{label}</span>}<select ref={ref} id={selectId} className={clsx('block w-full rounded-md border border-border-subtle bg-white px-3 py-2 text-sm outline-none focus:border-agni-orange', className)} {...props}>{placeholder && <option value="">{placeholder}</option>}{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
})

import { useEffect, useState } from 'react'
import { Badge, Button, Combobox, Input, Select } from '../components/ui'
import type { FieldDef, OptionValue } from '../lib/types'
import type { FilterValue } from './filters'

type FilterBarProps = {
  defs: FieldDef[]
  lists: Record<string, OptionValue[]>
  value: Record<string, FilterValue>
  onChange: (next: Record<string, FilterValue>) => void
}

function isActive(value: FilterValue | undefined) {
  if (value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.values(value).some((item) => item !== undefined && item !== '')
  return true
}

function filterValueLabel(value: FilterValue, options: OptionValue[]) {
  if (Array.isArray(value)) return value.map((item) => options.find((option) => option.value === item)?.label ?? item).join(', ')
  if (typeof value === 'object') {
    if ('min' in value || 'max' in value) return [value.min, value.max].filter((item) => item !== undefined).join(' to ')
    const range = value as { from?: string; to?: string }
    return [range.from, range.to].filter(Boolean).join(' to ')
  }
  return String(value)
}

export function FilterBar({ defs, lists, value, onChange }: FilterBarProps) {
  const filterableDefs = defs.filter((def) => def.filterable).sort((left, right) => left.sort_order - right.sort_order)
  const primaryDefs = filterableDefs.slice(0, 3)
  const moreDefs = filterableDefs.slice(3)
  const activeDefs = filterableDefs.filter((def) => isActive(value[def.key]))
  const [open, setOpen] = useState(activeDefs.length > 0)
  const [text, setText] = useState<Record<string, string>>({})

  useEffect(() => {
    setOpen(activeDefs.length > 0)
  }, [activeDefs.length])

  useEffect(() => {
    if (!Object.keys(text).length) return
    const timer = window.setTimeout(() => {
      const next = { ...value }
      for (const [key, item] of Object.entries(text)) next[key] = item
      setText({})
      onChange(next)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [text, value, onChange])

  const set = (key: string, item: FilterValue) => onChange({ ...value, [key]: item })
  const remove = (key: string) => {
    setText((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  const renderFilter = (def: FieldDef) => {
    const current = value[def.key]
    const options = (lists[def.options_list_key ?? ''] ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      inactive: !option.active,
    }))

    if (def.type === 'select' || def.type === 'person' || def.type === 'multiselect') {
      return <Combobox key={def.key} label={def.label} options={options} multiple value={Array.isArray(current) ? current : []} onChange={(next) => set(def.key, Array.isArray(next) ? next : [])} />
    }
    if (def.type === 'number' || def.type === 'integer') {
      const range = typeof current === 'object' && !Array.isArray(current) && current ? current as { min?: number; max?: number } : {}
      return <div key={def.key} className="grid grid-cols-2 gap-1"><Input aria-label={`${def.label} minimum`} placeholder={`${def.label} min`} unit={def.unit ?? undefined} type="number" value={range.min ?? ''} onChange={(event) => set(def.key, { ...range, min: event.target.value === '' ? undefined : Number(event.target.value) })} /><Input aria-label={`${def.label} maximum`} placeholder="max" unit={def.unit ?? undefined} type="number" value={range.max ?? ''} onChange={(event) => set(def.key, { ...range, max: event.target.value === '' ? undefined : Number(event.target.value) })} /></div>
    }
    if (def.type === 'date') {
      const range = typeof current === 'object' && !Array.isArray(current) && current ? current as { from?: string; to?: string } : {}
      return <div key={def.key} className="grid grid-cols-2 gap-1"><Input aria-label={`${def.label} from`} type="date" value={range.from ?? ''} onChange={(event) => set(def.key, { ...range, from: event.target.value || undefined })} /><Input aria-label={`${def.label} to`} type="date" value={range.to ?? ''} onChange={(event) => set(def.key, { ...range, to: event.target.value || undefined })} /></div>
    }
    if (def.type === 'bool') return <Select key={def.key} label={def.label} placeholder="Any" options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} value={typeof current === 'string' ? current : ''} onChange={(event) => set(def.key, event.target.value)} />
    return <Input key={def.key} label={def.label} value={text[def.key] ?? (typeof current === 'string' ? current : '')} onChange={(event) => setText((previous) => ({ ...previous, [def.key]: event.target.value }))} />
  }

  return <section aria-label="Filters" className="space-y-3 rounded-md border border-border-subtle bg-surface-2 p-3"><div className="flex flex-wrap items-center gap-2"><div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">{primaryDefs.map(renderFilter)}</div>{moreDefs.length > 0 && <Button type="button" size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? 'Fewer filters' : 'More filters'}</Button>}<Badge tone="blue">{activeDefs.length}</Badge><Button type="button" size="sm" variant="ghost" onClick={() => { setText({}); onChange({}) }}>Clear</Button></div>{activeDefs.length > 0 && <div aria-label="Active filters" className="flex flex-wrap gap-2">{activeDefs.map((def) => { const filter = value[def.key]!; const options = lists[def.options_list_key ?? ''] ?? []; return <span key={def.key} className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-agni-orange-tint px-2 py-1 text-xs text-agni-ink"><span>{def.label}: {filterValueLabel(filter, options)}</span><button type="button" aria-label={`Remove ${def.label} filter`} className="text-agni-orange hover:text-agni-orange-hover" onClick={() => remove(def.key)}>×</button></span>})}</div>}{open && moreDefs.length > 0 && <div className="grid gap-3 border-t border-border-subtle pt-3 sm:grid-cols-2 lg:grid-cols-3">{moreDefs.map(renderFilter)}</div>}</section>
}

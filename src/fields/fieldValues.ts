import type { FieldDef, MetaStatus, OptionValue, StackLayer } from '../lib/types'

type RowLike = { meta?: Record<string, unknown> } & Record<string, unknown>

export function getFieldValue(def: FieldDef, row: RowLike): unknown {
  return def.column_name ? row[def.column_name] : row.meta?.[def.key]
}

export function setFieldValue(def: FieldDef, draft: RowLike, value: unknown): void {
  if (def.column_name) draft[def.column_name] = value
  else {
    draft.meta ??= {}
    draft.meta[def.key] = value
  }
}

const empty = (raw: unknown) => raw === '' || raw === null || raw === undefined
const dateOk = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export function coerceValue(def: FieldDef, raw: unknown): { value: unknown; error?: string } {
  if (empty(raw)) return { value: null }
  if (def.type === 'text' || def.type === 'longtext') return { value: String(raw).trim() }
  if (def.type === 'number' || def.type === 'integer') {
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
    if (Number.isNaN(value) || (def.type === 'integer' && !Number.isInteger(value))) return { value: raw, error: `Must be a ${def.type}` }
    return { value }
  }
  if (def.type === 'date') return typeof raw === 'string' && dateOk(raw) ? { value: raw } : { value: raw, error: 'Must be a valid YYYY-MM-DD date' }
  if (def.type === 'bool') {
    if (typeof raw === 'boolean') return { value: raw }
    if (['true', '1'].includes(String(raw))) return { value: true }
    if (['false', '0'].includes(String(raw))) return { value: false }
    return { value: raw, error: 'Must be true or false' }
  }
  if (def.type === 'select' || def.type === 'person') return { value: String(raw) }
  if (def.type === 'multiselect') return { value: Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((item) => item.trim()).filter(Boolean) }
  if (def.type === 'layer_stack') {
    if (Array.isArray(raw)) return { value: raw }
    try { const value: unknown = JSON.parse(String(raw)); return Array.isArray(value) ? { value } : { value: raw, error: 'Must be an array of layers' } } catch { return { value: raw, error: 'Must be valid JSON' } }
  }
  if (def.type === 'json') {
    if (typeof raw !== 'string') return { value: raw }
    try { return { value: JSON.parse(raw) } } catch { return { value: raw, error: 'Must be valid JSON' } }
  }
  return { value: raw }
}

export function validateValue(def: FieldDef, value: unknown, lists?: Record<string, OptionValue[]>, currentValue?: unknown): string | null {
  if (def.required && (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0))) return 'Required'
  if (value === null || value === undefined || value === '') return null
  if ((def.type === 'number' || def.type === 'integer') && typeof value === 'number') {
    if (def.min !== null && value < def.min) return `Must be at least ${def.min}`
    if (def.max !== null && value > def.max) return `Must be at most ${def.max}`
  }
  if ((def.type === 'text' || def.type === 'longtext') && def.regex && typeof value === 'string' && !new RegExp(def.regex).test(value)) return 'Invalid format'
  const values = def.options_list_key ? lists?.[def.options_list_key] : undefined
  if (values && ['select', 'person', 'multiselect'].includes(def.type)) {
    const selected = Array.isArray(value) ? value : [value]
    const current = Array.isArray(currentValue) ? currentValue : [currentValue]
    for (const item of selected) {
      const option = values.find((optionValue) => optionValue.value === item)
      if (!option || (!option.active && !current.includes(item))) return 'Select a valid option'
    }
  }
  return null
}

export function validateEntity(defs: FieldDef[], row: RowLike, lists?: Record<string, OptionValue[]>): Record<string, string> {
  return defs.filter((def) => def.active).reduce<Record<string, string>>((errors, def) => {
    const value = getFieldValue(def, row); const error = validateValue(def, value, lists, value)
    if (error) errors[def.key] = error
    return errors
  }, {})
}

export function splitForWrite(defs: FieldDef[], values: Record<string, unknown>, statuses: Record<string, MetaStatus>) {
  const columns: Record<string, unknown> = {}; const meta: Record<string, unknown> = {}; const meta_status: Record<string, MetaStatus> = {}
  for (const def of defs) { const value = values[def.key]; if (def.column_name) columns[def.column_name] = value; else meta[def.key] = value; meta_status[def.key] = statuses[def.key] ?? 'confirmed' }
  return { columns, meta, meta_status }
}

export function formatValue(def: FieldDef, value: unknown, lists?: Record<string, OptionValue[]>): string {
  if (value === null || value === undefined || value === '') return ''
  if ((def.type === 'number' || def.type === 'integer') && typeof value === 'number') return `${Number(value.toPrecision(4))}${def.unit ? ` ${def.unit}` : ''}`
  if (def.type === 'date') return String(value)
  if (def.type === 'bool') return value ? 'yes' : 'no'
  if (def.type === 'select' || def.type === 'person') return lists?.[def.options_list_key ?? '']?.find((option) => option.value === value)?.label ?? String(value)
  if (def.type === 'multiselect') return (Array.isArray(value) ? value : []).map((item) => lists?.[def.options_list_key ?? '']?.find((option) => option.value === item)?.label ?? item).join(', ')
  if (def.type === 'layer_stack') return (Array.isArray(value) ? value as StackLayer[] : []).map((layer) => `${layer.material}${layer.t_nm === null || layer.t_nm === undefined ? '' : ` ${layer.t_nm}`}`).join(' / ')
  if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) return value.map((item) => (item === null ? '' : String(item))).join(', ')
  if (def.type === 'json') return JSON.stringify(value, null, 2)
  return String(value)
}

export function groupDefs(defs: FieldDef[]): { group: string; defs: FieldDef[] }[] {
  const groups = new Map<string, FieldDef[]>()
  for (const def of [...defs].sort((a, b) => a.sort_order - b.sort_order)) { const group = def.group_name ?? 'Other'; groups.set(group, [...(groups.get(group) ?? []), def]) }
  return [...groups].map(([group, grouped]) => ({ group, defs: grouped }))
}

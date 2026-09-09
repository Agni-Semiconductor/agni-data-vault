import type { Entity, FieldDef, OptionValue } from '../../lib/types'

export const KEY_RE = /^[a-z][a-z0-9_]*$/
export const SLUG_RE = /^[a-z0-9][a-z0-9_.-]*$/
export const COLUMN_WHITELIST: Record<Entity, string[]> = {
  sample: ['sample_id', 'label', 'family', 'owner', 'substrate', 'substrate_size', 'fab_location', 'fabricated_by', 'fabricated_on', 'stack', 'notes'],
  measurement: ['measured_on', 'kind', 'instrument', 'probe_station', 'measured_by', 'temperature_c', 'device_address', 'run_numbers', 'pad_shape', 'pad_dim_um', 'pad_area_override', 'notes'],
  file: ['kind'],
}

export function validateFieldDef(def: Partial<FieldDef>, existingKeys: string[]): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!def.label?.trim()) errors.label = 'Label is required.'
  if (!def.key?.trim()) errors.key = 'Key is required.'
  else if (!KEY_RE.test(def.key)) errors.key = 'Use lowercase letters, numbers, and underscores; start with a letter.'
  else if (existingKeys.includes(def.key)) errors.key = 'This key already exists for this entity.'
  if (!def.entity) errors.entity = 'Entity is required.'
  if (!def.type) errors.type = 'Type is required.'
  if (['select', 'multiselect', 'person'].includes(def.type ?? '') && !def.options_list_key) errors.options_list_key = 'An option list is required for this type.'
  if (def.column_name && def.entity && !COLUMN_WHITELIST[def.entity].includes(def.column_name)) errors.column_name = 'Choose a real column for this entity.'
  if (def.min != null && def.max != null && def.min > def.max) errors.max = 'Maximum must be at least the minimum.'
  if (def.regex) { try { new RegExp(def.regex) } catch { errors.regex = 'Enter a valid regular expression.' } }
  return errors
}

export function validateOptionValue(v: Partial<OptionValue>, existingValues: string[]): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!v.label?.trim()) errors.label = 'Label is required.'
  if (!v.value?.trim()) errors.value = 'Value is required.'
  else if (!SLUG_RE.test(v.value)) errors.value = 'Use lowercase letters, numbers, dots, hyphens, and underscores.'
  else if (existingValues.includes(v.value)) errors.value = 'This value already exists in this list.'
  return errors
}

export function slugify(label: string): string { return label.toLowerCase().replace(/[\s/]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '') }
export function nextSortOrder(items: { sort_order: number }[]): number { return items.length ? Math.max(...items.map((item) => item.sort_order)) + 10 : 10 }

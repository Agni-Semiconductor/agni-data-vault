// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { FilterBar } from '../src/fields/FilterBar'
import type { FieldDef, OptionValue } from '../src/lib/types'
import type { FilterValue } from '../src/fields/filters'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const option = (value: string, label: string): OptionValue => ({ id: value, list_key: 'status', value, label, sort_order: 0, active: true, meta: {} })
const field = (key: string, label: string, sort_order: number, filterable = true): FieldDef => ({ id: key, entity: 'sample', key, label, help: null, type: 'text', options_list_key: null, unit: null, required: false, sort_order, group_name: null, active: true, column_name: null, show_in_table: true, filterable, min: null, max: null, regex: null, default_value: null, created_at: '', updated_at: '' })

function render(defs: FieldDef[], value: Record<string, FilterValue> = {}, onChange = vi.fn()) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(<FilterBar defs={defs} lists={{ status: [option('active', 'Active')] }} value={value} onChange={onChange} />))
  return { container, onChange, unmount: () => act(() => root.unmount()) }
}

describe('FilterBar', () => {
  it('keeps every active filter visible as a removable chip while secondary filters are collapsed', () => {
    const view = render([field('owner', 'Owner', 10), field('project', 'Project', 20), field('lot', 'Lot', 30), field('status', 'Status', 40)], { owner: 'Ada', status: 'active' })
    act(() => (view.container.querySelector('[aria-expanded="true"]') as HTMLButtonElement).click())
    expect(view.container.querySelector('[aria-expanded="false"]')).not.toBeNull()
    expect(view.container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(2)
    expect(view.container.textContent).toContain('Owner: Ada')
    expect(view.container.textContent).toContain('Status: active')
    view.unmount()
  })

  it('removes only the filter represented by the chip', () => {
    const view = render([field('owner', 'Owner', 10), field('status', 'Status', 20)], { owner: 'Ada', status: 'active' })
    act(() => (view.container.querySelector('[aria-label="Remove Owner filter"]') as HTMLButtonElement).click())
    expect(view.onChange).toHaveBeenCalledWith({ status: 'active' })
    view.unmount()
  })

  it('uses filterable definitions and their sort order to choose the compact fields', () => {
    const defs = [field('later', 'Later', 30), field('excluded', 'Excluded', 1, false), field('first', 'First', 10), field('second', 'Second', 20), field('more', 'More', 40)]
    const view = render(defs)
    const labels = [...view.container.querySelectorAll('label')].map((label) => label.textContent?.trim())
    expect(labels).toEqual(['First', 'Second', 'Later'])
    expect(labels).not.toContain('Excluded')
    expect(labels).not.toContain('More')

    const reordered = render(defs.map((def) => def.key === 'more' ? { ...def, sort_order: 5 } : def))
    const reorderedLabels = [...reordered.container.querySelectorAll('label')].map((label) => label.textContent?.trim())
    expect(reorderedLabels).toEqual(['More', 'First', 'Second'])
    // Control: the low-order but non-filterable definition must never displace a primary field.
    expect(reorderedLabels).not.toContain('Excluded')
    view.unmount()
    reordered.unmount()
  })
})

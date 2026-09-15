import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { afterEach, describe, expect, it } from 'vitest'
import { Table } from '../src/components/ui/Table'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { name: string; value: number }
const columnHelper = createColumnHelper<Row>()
const columns = [
  columnHelper.accessor('name', { header: 'Name' }),
  columnHelper.accessor('value', { header: 'Value' }),
]
const rows = Array.from({ length: 40 }, (_, index) => ({ name: `Row ${index + 1}`, value: index + 1 }))

function RenderedTable() {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return <Table table={table} />
}

function headerClasses(element: Element): string {
  return element.getAttribute('class') ?? ''
}

function assertReadableHeader(className: string): void {
  expect(className).toMatch(/\bsticky\b/)
  expect(className).toMatch(/\btop-0\b/)
  expect(className).toMatch(/\bbg-[a-z0-9-]+\b/)
  expect(className).not.toMatch(/\bbg-\[/)
  expect(className).toMatch(/\bborder-b\b/)
  expect(className).toMatch(/\bshadow-[a-z0-9-]+\b/)
}

describe('sticky table header', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (container?.parentNode) container.parentNode.removeChild(container)
    container = null
  })

  it('renders an opaque, elevated sticky header over a scrollable table', async () => {
    const rootContainer = document.createElement('div')
    container = rootContainer
    document.body.appendChild(rootContainer)
    await act(async () => { createRoot(rootContainer).render(<RenderedTable />) })

    const headerCells = [...rootContainer.querySelectorAll('thead th')]
    expect(rootContainer.querySelectorAll('tbody tr')).toHaveLength(rows.length)
    expect(headerCells).toHaveLength(columns.length)
    headerCells.forEach((cell) => assertReadableHeader(headerClasses(cell)))
  })

  it('control: the readability assertion fails when the background is removed', () => {
    expect(() => assertReadableHeader('sticky top-0 border-b border-border-subtle shadow-card')).toThrow()
  })
})

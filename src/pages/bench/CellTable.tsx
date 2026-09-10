import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import clsx from 'clsx'
import { useSearchParams } from 'react-router-dom'
import { Button, Input, Select, Spinner } from '../../components/ui'
import { filtersFromSearchParams, filtersToSearchParams, type FilterValue } from '../../fields'
import { benchCaptureUrl, listBenchCells } from '../../lib/bench'
import type { BenchCell, FieldDef } from '../../lib/types'

const PAGE_SIZE = 100
const ROW_HEIGHT = 41
const FILTER_DEFS = [
  { key: 'measurement', type: 'text', filterable: true },
  { key: 'verdict', type: 'text', filterable: true },
  { key: 'status', type: 'text', filterable: true },
  { key: 'row', type: 'integer', filterable: true },
  { key: 'col', type: 'integer', filterable: true },
  { key: 'q', type: 'text', filterable: true },
] as FieldDef[]
const SORT_KEYS: Partial<Record<keyof BenchCell, keyof BenchCell>> = { grid_row: 'grid_row', grid_col: 'grid_col', measurement: 'measurement', status: 'status', verdict: 'verdict', capture_id: 'capture_id', ended_at: 'ended_at' }

export type BenchCellCoordinate = { row: number; col: number }
type SelectedCell = BenchCellCoordinate | readonly [row: number, col: number, ...rest: number[]] | null
export interface CellTableProps { dutId: string; runId: string; selectedCell?: SelectedCell; onSelectCell?: (cell: BenchCellCoordinate) => void }

const textFilter = (value: FilterValue | undefined) => Array.isArray(value) ? value[0] ?? '' : typeof value === 'string' ? value : ''
const rangeFilter = (value: FilterValue | undefined) => value && typeof value === 'object' && !Array.isArray(value) && ('min' in value || 'max' in value) ? value as { min?: number; max?: number } : {}
const coordinate = (cell: SelectedCell | undefined): BenchCellCoordinate | null => !cell ? null : Array.isArray(cell) ? { row: cell[0], col: cell[1] } : cell as BenchCellCoordinate
const formatNumber = (value: number | null, digits = 4) => value === null ? '-' : Number.isFinite(value) ? value.toPrecision(digits) : String(value)
const formatAmperes = (value: number | null) => value === null ? '-' : value === 0 ? '0' : value.toExponential(3)
const searchableText = (cell: BenchCell) => [cell.seq, cell.grid_row, cell.grid_col, cell.row_relay, cell.col_relay, cell.measurement, cell.status, cell.verdict, cell.cause, cell.capture_id, cell.i_max_a, cell.compliance_hit, cell.elapsed_s, cell.ended_at].join(' ').toLowerCase()

export default function CellTable({ dutId, runId, selectedCell, onSelectCell }: CellTableProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState(0)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'grid_row', desc: false }])
  const scrollElement = useRef<HTMLDivElement>(null)
  const filters = useMemo(() => filtersFromSearchParams(searchParams, FILTER_DEFS), [searchParams])
  const rowRange = rangeFilter(filters.row), colRange = rangeFilter(filters.col), query = textFilter(filters.q).trim().toLowerCase()
  const sort = sorting[0]
  const sortKey = sort ? SORT_KEYS[sort.id as keyof BenchCell] : undefined
  const result = useQuery({
    queryKey: ['bench-cells', dutId, runId, filters.measurement, filters.verdict, filters.status, rowRange.min, rowRange.max, colRange.min, colRange.max, sortKey, sort?.desc, page],
    queryFn: () => listBenchCells({ dutId, runId, measurement: textFilter(filters.measurement) || undefined, verdict: textFilter(filters.verdict) || undefined, status: textFilter(filters.status) || undefined, rowMin: rowRange.min, rowMax: rowRange.max, colMin: colRange.min, colMax: colRange.max, sort: sortKey, order: sort?.desc ? 'desc' : 'asc', limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  })
  const rows = useMemo(() => query ? (result.data?.items ?? []).filter((cell: BenchCell) => searchableText(cell).includes(query)) : result.data?.items ?? [], [query, result.data?.items])
  const selected = coordinate(selectedCell)
  const selectedRow = selected?.row, selectedCol = selected?.col
  const columns = useMemo<ColumnDef<BenchCell>[]>(() => [
    { accessorKey: 'seq', header: 'Seq', size: 70, enableSorting: false },
    { accessorKey: 'grid_row', header: 'Row', size: 70 },
    { accessorKey: 'grid_col', header: 'Col', size: 70 },
    { id: 'relays', header: 'Relays', size: 170, enableSorting: false, cell: ({ row }) => `${row.original.row_relay ?? '-'} / ${row.original.col_relay ?? '-'}` },
    { accessorKey: 'status', header: 'Status', size: 100 },
    { accessorKey: 'verdict', header: 'Verdict', size: 120, cell: ({ getValue }) => String(getValue() ?? '-') },
    { accessorKey: 'cause', header: 'Cause', size: 140, enableSorting: false, cell: ({ getValue }) => String(getValue() ?? '-') },
    { accessorKey: 'suspect', header: 'Suspect', size: 90, enableSorting: false, cell: ({ getValue }) => getValue() ? 'yes' : 'no' },
    { accessorKey: 'capture_id', header: 'Capture', size: 160, cell: ({ getValue }) => { const id = getValue<string | null>(); return id ? <a className="text-agni-orange underline hover:no-underline" href={benchCaptureUrl(id, dutId)} onClick={(event) => event.stopPropagation()}>{id}</a> : '-' } },
    { accessorKey: 'i_max_a', header: 'i_max (A)', size: 120, enableSorting: false, cell: ({ getValue }) => <span className="font-mono">{formatAmperes(getValue<number | null>())}</span> },
    { accessorKey: 'compliance_hit', header: 'Compliance', size: 120, enableSorting: false, cell: ({ getValue }) => getValue() === null ? '-' : getValue() ? 'yes' : 'no' },
    { accessorKey: 'elapsed_s', header: 'Elapsed (s)', size: 120, enableSorting: false, cell: ({ getValue }) => <span className="font-mono">{formatNumber(getValue<number | null>())}</span> },
    { accessorKey: 'ended_at', header: 'Ended at', size: 210, cell: ({ getValue }) => { const value = getValue<string | null>(); return value ? new Date(value).toLocaleString() : '-' } },
  ], [dutId])
  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: (updater) => { setSorting(updater); setPage(0) }, getCoreRowModel: getCoreRowModel(), manualSorting: true, enableMultiSort: false })
  const tableRows = table.getRowModel().rows
  const virtualizer = useVirtualizer({ count: tableRows.length, getScrollElement: () => scrollElement.current, estimateSize: () => ROW_HEIGHT, overscan: 8 })

  useEffect(() => { if (selectedRow === undefined || selectedCol === undefined) return; const index = tableRows.findIndex((row) => row.original.grid_row === selectedRow && row.original.grid_col === selectedCol); if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' }) }, [selectedRow, selectedCol, tableRows, virtualizer])

  const updateFilter = (key: string, value: FilterValue) => { const next = { ...filters, [key]: value }; setSearchParams(filtersToSearchParams(next), { replace: true }); setPage(0) }
  const updateRange = (key: 'row' | 'col', bound: 'min' | 'max', value: string) => updateFilter(key, { ...rangeFilter(filters[key]), ...(value === '' ? { [bound]: undefined } : { [bound]: Number(value) }) })
  const total = result.data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const emptyReason = total === 0 ? 'No cells match the selected server filters for this run.' : query && rows.length === 0 ? 'No cells on this server page match the free-text filter.' : 'This page contains no cells.'

  return <section className="space-y-3" aria-labelledby="bench-cell-table-heading">
    <div className="flex flex-wrap items-end gap-3">
      <div className="mr-auto"><h2 id="bench-cell-table-heading" className="text-lg font-semibold">Per-cell results</h2><p className="text-xs text-agni-slate">100 rows per server page; free text filters the loaded page.</p></div>
      <Input label="Free text" type="search" value={textFilter(filters.q)} onChange={(event) => updateFilter('q', event.target.value)} placeholder="Search this page" className="w-48" />
      <Input label="Measurement" value={textFilter(filters.measurement)} onChange={(event) => updateFilter('measurement', event.target.value)} placeholder="All" className="w-32" />
      <Select label="Verdict" value={textFilter(filters.verdict)} onChange={(event) => updateFilter('verdict', event.target.value)} placeholder="All" options={['normal', 'open', 'short', 'no_signal', 'indeterminate'].map((value) => ({ value, label: value }))} />
      <Select label="Status" value={textFilter(filters.status)} onChange={(event) => updateFilter('status', event.target.value)} placeholder="All" options={['measured', 'skipped', 'error'].map((value) => ({ value, label: value }))} />
      <Input label="Row min" type="number" min={0} max={127} value={rowRange.min ?? ''} onChange={(event) => updateRange('row', 'min', event.target.value)} className="w-20" />
      <Input label="Row max" type="number" min={0} max={127} value={rowRange.max ?? ''} onChange={(event) => updateRange('row', 'max', event.target.value)} className="w-20" />
      <Input label="Col min" type="number" min={0} max={127} value={colRange.min ?? ''} onChange={(event) => updateRange('col', 'min', event.target.value)} className="w-20" />
      <Input label="Col max" type="number" min={0} max={127} value={colRange.max ?? ''} onChange={(event) => updateRange('col', 'max', event.target.value)} className="w-20" />
    </div>
    <div ref={scrollElement} className="h-[32rem] overflow-auto rounded-lg border border-border-subtle shadow-card">
      <table className="relative grid min-w-[1550px] text-left text-sm">
        <thead className="sticky top-0 z-10 grid bg-agni-crimson text-xs uppercase tracking-[.08em] text-white">{table.getHeaderGroups().map((group) => <tr key={group.id} className="flex w-full">{group.headers.map((header) => { const sortable = header.column.getCanSort() && SORT_KEYS[header.column.id as keyof BenchCell] !== undefined; const sorted = header.column.getIsSorted(); return <th key={header.id} className="shrink-0 px-3 py-3 font-semibold" style={{ width: header.getSize() }}>{header.isPlaceholder ? null : <button type="button" className={clsx(!sortable && 'cursor-default')} onClick={sortable ? header.column.getToggleSortingHandler() : undefined}>{flexRender(header.column.columnDef.header, header.getContext())}{sorted === 'asc' ? ' ^' : sorted === 'desc' ? ' v' : sortable ? ' <>' : ''}</button>}</th> })}</tr>)}</thead>
        <tbody className="relative grid bg-white" style={{ height: `${virtualizer.getTotalSize()}px` }}>{virtualizer.getVirtualItems().map((virtualRow) => { const row = tableRows[virtualRow.index]; const isSelected = selectedRow === row.original.grid_row && selectedCol === row.original.grid_col; return <tr key={row.id} ref={virtualizer.measureElement} data-index={virtualRow.index} className={clsx('absolute flex w-full border-b border-border-subtle', onSelectCell && 'cursor-pointer hover:bg-surface-2', isSelected && 'bg-agni-orange-tint')} style={{ transform: `translateY(${virtualRow.start}px)` }} aria-selected={isSelected} onClick={() => onSelectCell?.({ row: row.original.grid_row, col: row.original.grid_col })}>{row.getVisibleCells().map((cell) => <td key={cell.id} className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2.5 text-agni-ink" style={{ width: cell.column.getSize() }}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr> })}</tbody>
      </table>
      {!result.isLoading && !result.error && rows.length === 0 && <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-agni-slate">{emptyReason}</div>}
      {result.isLoading && <div className="flex h-40 items-center justify-center"><Spinner /></div>}
      {result.error && <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-red-600">Cells could not be loaded: {result.error.message}</div>}
    </div>
    <div className="flex items-center justify-between gap-3 text-xs text-agni-slate"><span>Page {page + 1} of {pageCount}; {total.toLocaleString()} matching rows</span><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={page === 0 || result.isFetching} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={page + 1 >= pageCount || result.isFetching} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
  </section>
}

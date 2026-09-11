import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable, type ColumnDef, type OnChangeFn, type SortingState } from '@tanstack/react-table'
import { ArrowDownRight, ArrowRightLeft, ArrowUpRight } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button, Input, Select, Spinner, Table } from '../../components/ui'
import { listVerdictChanges , asVerdictSortKey, type VerdictSortKey } from '../../lib/devices'
import { TRACE_COLORS } from '../../plot/panelData'

const PAGE_SIZE = 200
const DIRECTIONS = ['degraded', 'recovered', 'changed'] as const
type VerdictChange = Awaited<ReturnType<typeof listVerdictChanges>>['items'][number]
// Narrowed through the SHARED allow-list, which a parity test pins against the server's.
// Falls back to started_at so a typo'd URL still renders a sensible table rather than an
// unsorted one -- but the key that reaches the API is always one the API accepts.
const asSortKey = (value: string | null): VerdictSortKey => asVerdictSortKey(value ?? undefined) ?? 'started_at'
const asDirection = (value: string | null) => DIRECTIONS.includes(value as typeof DIRECTIONS[number]) ? value as typeof DIRECTIONS[number] : ''
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not recorded'
const explicitDeviceId = (change: VerdictChange) => 'device_id' in change && typeof change.device_id === 'string' ? change.device_id : null

function Direction({ value }: { value: VerdictChange['direction'] }) {
  const detail = value === 'degraded' ? { Icon: ArrowDownRight, color: TRACE_COLORS[5] } : value === 'recovered' ? { Icon: ArrowUpRight, color: TRACE_COLORS[0] } : { Icon: ArrowRightLeft, color: TRACE_COLORS[2] }
  return <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ borderColor: detail.color, color: detail.color }}><detail.Icon aria-hidden="true" size={14} strokeWidth={2.5} />{value}</span>
}

export default function VerdictChanges() {
  const [params, setParams] = useSearchParams()
  const [dutInput, setDutInput] = useState(params.get('dut_id') ?? '')
  const dutId = params.get('dut_id') ?? '', direction = asDirection(params.get('direction')), from = params.get('from') ?? '', to = params.get('to') ?? ''
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)
  // Reject unknown URL sort keys here or the server fallback and the header indicator silently describe different orders.
  const [sorting, setSorting] = useState<SortingState>(() => [{ id: asSortKey(params.get('sort')), desc: params.get('order') !== 'asc' }])
  useEffect(() => { const timer = window.setTimeout(() => { const value = dutInput.trim(); setParams((current) => { const next = new URLSearchParams(current); if (value) next.set('dut_id', value); else next.delete('dut_id'); if ((current.get('dut_id') ?? '') !== value) next.delete('page'); return next }, { replace: true }) }, 300); return () => window.clearTimeout(timer) }, [dutInput, setParams])
  const updateFilter = (key: 'direction' | 'from' | 'to', value: string) => setParams((current) => { const next = new URLSearchParams(current); if (value) next.set(key, value); else next.delete(key); next.delete('page'); return next }, { replace: true })
  const clearFilters = () => { setDutInput(''); setParams((current) => { const next = new URLSearchParams(current); for (const key of ['dut_id', 'direction', 'from', 'to', 'page']) next.delete(key); return next }, { replace: true }) }
  const onSortingChange: OnChangeFn<SortingState> = (update) => setSorting((current) => { const next = typeof update === 'function' ? update(current) : update, sort = next[0]; setParams((value) => { const updated = new URLSearchParams(value); if (sort) { updated.set('sort', asSortKey(sort.id)); updated.set('order', sort.desc ? 'desc' : 'asc') } else { updated.delete('sort'); updated.delete('order') } updated.delete('page'); return updated }, { replace: true }); return next })
  const sort = sorting[0]
  const result = useQuery({ queryKey: ['verdict-changes', dutId, direction, from, to, sort?.id, sort?.desc, page], queryFn: () => listVerdictChanges({ dut_id: dutId || undefined, direction: direction || undefined, from: from || undefined, to: to || undefined, sort: asSortKey(sort?.id ?? null), order: sort?.desc ? 'desc' : 'asc', limit: PAGE_SIZE, offset: page * PAGE_SIZE }) })
  const columns = useMemo<ColumnDef<VerdictChange>[]>(() => [
    { accessorKey: 'device_address', header: 'Device address', enableSorting: true, cell: ({ row }) => { const id = explicitDeviceId(row.original); return id ? <Link className="font-mono font-medium text-agni-orange hover:underline" to={`/devices/${encodeURIComponent(id)}`} onClick={(event) => event.stopPropagation()}>{row.original.device_address}</Link> : <span className="font-mono">{row.original.device_address}</span> } },
    { accessorKey: 'prev_verdict', header: 'Previous verdict', enableSorting: true },
    { accessorKey: 'new_verdict', header: 'New verdict', enableSorting: true },
    { accessorKey: 'direction', header: 'Direction', enableSorting: true, cell: ({ row }) => <Direction value={row.original.direction} /> },
    { accessorKey: 'prev_run_id', header: 'Previous run', enableSorting: true, cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span> },
    { accessorKey: 'run_id', header: 'New run', enableSorting: true, cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span> },
    { accessorKey: 'started_at', header: 'When', enableSorting: true, cell: ({ getValue }) => formatDate(getValue<string | null>()) },
  ], [])
  const table = useReactTable({ data: result.data?.items ?? [], columns, state: { sorting }, onSortingChange, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true, enableMultiSort: false })
  const setPage = (nextPage: number) => setParams((current) => { const next = new URLSearchParams(current); if (nextPage) next.set('page', String(nextPage)); else next.delete('page'); return next }, { replace: true })
  const total = result.data?.total ?? 0, hasFilters = Boolean(dutId || direction || from || to)

  return <div className="space-y-4">
    <header><p className="label-caps text-agni-orange">Device evidence</p><h1 className="mt-1 text-xl font-semibold">Verdict changes</h1><p className="mt-2 max-w-3xl text-sm text-agni-slate">Cross-run changes for exact bench cells. Device links use only identities returned by the vault; addresses are never joined across schemes by prefix.</p></header>
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border-subtle bg-white p-4">
      <Input label="DUT ID" value={dutInput} onChange={(event) => setDutInput(event.target.value)} placeholder="All DUTs" className="w-48" />
      <Select label="Direction" value={direction} placeholder="All directions" options={[{ value: 'degraded', label: 'Degraded' }, { value: 'recovered', label: 'Recovered' }, { value: 'changed', label: 'Changed' }]} onChange={(event) => updateFilter('direction', event.target.value)} />
      <Input label="From" type="date" value={from} onChange={(event) => updateFilter('from', event.target.value)} />
      <Input label="To" type="date" value={to} onChange={(event) => updateFilter('to', event.target.value)} />
      <Button variant="ghost" size="sm" disabled={!hasFilters && !dutInput} onClick={clearFilters}>Clear filters</Button>
    </div>
    {result.isLoading ? <Spinner /> : result.error ? <p className="text-[#B3261E]">Verdict changes could not be loaded: {result.error.message}</p> : total === 0 && !hasFilters ? <section className="rounded-lg border bg-white px-6 py-10 text-center" style={{ borderColor: TRACE_COLORS[2] }}><p className="label-caps" style={{ color: TRACE_COLORS[2] }}>No changes recorded</p><h2 className="mt-2 text-lg font-semibold">No device verdicts changed between runs</h2><p className="mt-1 text-sm text-agni-slate">That is good news: the report has no cross-run verdict changes to investigate.</p></section> : <Table table={table} emptyText={total === 0 ? 'No verdict changes match these filters.' : 'No verdict changes exist on this page.'} />}
    {!result.isLoading && !result.error && (total > 0 || hasFilters) && <div className="flex items-center justify-between gap-3"><p className="text-sm text-agni-slate">{total ? `${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString()}` : '0 matching changes'}</p><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page === 0 || result.isFetching} onClick={() => setPage(page - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={(page + 1) * PAGE_SIZE >= total || result.isFetching} onClick={() => setPage(page + 1)}>Next</Button></div></div>}
  </div>
}

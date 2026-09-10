import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table'
import { Badge, Button, Select, Spinner, Table } from '../../components/ui'
import { filtersFromSearchParams, filtersToSearchParams, type FilterValue } from '../../fields'
import { listBenchCells, listBenchDuts, listBenchRuns } from '../../lib/bench'
import type { BenchRun, FieldDef } from '../../lib/types'

const pageSize = 50
const filterDefs = [{ key: 'status', label: 'Status', type: 'select', filterable: true }] as FieldDef[]
const statusOptions = ['running', 'completed', 'failed', 'aborted'].map((value) => ({ value, label: value.replace('_', ' ') }))
const toneForStatus = (status: string): 'gray' | 'green' | 'amber' | 'red' | 'blue' => status === 'completed' ? 'green' : status === 'running' ? 'blue' : status === 'failed' || status === 'aborted' ? 'red' : 'gray'
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not started'

function CampaignProgress({ run }: { run: BenchRun }) {
  const count = useQuery({ queryKey: ['bench-cell-count', run.dut_id, run.run_id], queryFn: () => listBenchCells({ dutId: run.dut_id, runId: run.run_id, limit: 1, offset: 0 }), refetchInterval: run.status === 'running' ? 5000 : false })
  if (count.isLoading) return <span className="text-agni-slate">Counting...</span>
  if (count.error) return <span className="text-[#B3261E]" title={count.error.message}>Count unavailable</span>
  const measured = count.data?.total ?? 0
  return <span className="font-mono" title="Counted from device tests, including live runs">{measured.toLocaleString()} / {run.n_planned?.toLocaleString() ?? 'unknown'}</span>
}

export default function BenchCampaigns() {
  const navigate = useNavigate(); const [params, setParams] = useSearchParams(); const filters = useMemo(() => filtersFromSearchParams(params, filterDefs), [params]); const dutId = params.get('dut_id') ?? ''; const page = Math.max(0, Number(params.get('page') ?? 0) || 0); const [sorting, setSorting] = useState<SortingState>([{ id: 'started_at', desc: true }])
  const statusValue = filters.status; const status = Array.isArray(statusValue) ? statusValue[0] : typeof statusValue === 'string' ? statusValue : undefined
  const duts = useQuery({ queryKey: ['bench-duts'], queryFn: listBenchDuts })
  useEffect(() => { if (!dutId && duts.data?.items[0]) { const next = filtersToSearchParams(filters); next.set('dut_id', duts.data.items[0].dut_id); setParams(next, { replace: true }) } }, [dutId, duts.data, filters, setParams])
  const runs = useQuery({ queryKey: ['bench-runs', dutId, filters, sorting, page], enabled: Boolean(dutId), queryFn: () => listBenchRuns({ dutId, status, limit: pageSize, offset: page * pageSize }) })
  const updateView = (nextFilters: Record<string, FilterValue>, nextDutId = dutId, nextPage = 0) => { const next = filtersToSearchParams(nextFilters); if (nextDutId) next.set('dut_id', nextDutId); if (nextPage) next.set('page', String(nextPage)); setParams(next, { replace: true }) }
  const columns = useMemo<ColumnDef<BenchRun>[]>(() => [
    { accessorKey: 'name', header: 'Campaign', enableSorting: false, cell: ({ row }) => <span className="font-medium">{row.original.name || row.original.run_id}</span> },
    { accessorKey: 'kind', header: 'Kind', enableSorting: false, cell: ({ getValue }) => String(getValue() ?? 'Unknown') },
    { accessorKey: 'status', header: 'Status', enableSorting: false, cell: ({ row }) => <Badge tone={toneForStatus(row.original.status)}>{row.original.status}</Badge> },
    { accessorKey: 'operator', header: 'Operator', enableSorting: false, cell: ({ getValue }) => String(getValue() ?? 'Unknown') },
    { accessorKey: 'started_at', header: 'Started', enableSorting: false, cell: ({ row }) => formatDate(row.original.started_at) },
    { id: 'progress', header: 'Measured / planned', enableSorting: false, cell: ({ row }) => <CampaignProgress run={row.original} /> },
  ], [])
  const table = useReactTable({ data: runs.data?.items ?? [], columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), manualSorting: true })
  if (duts.isLoading) return <Spinner />
  if (duts.error) return <p className="text-[#B3261E]">{duts.error.message}</p>
  if (!duts.data?.items.length) return <section className="rounded-lg border border-border-subtle bg-white p-6"><h1 className="text-xl font-semibold">Bench campaigns</h1><p className="mt-2 text-sm text-agni-slate">No campaigns can be shown because the bench database contains no DUTs.</p></section>
  const total = runs.data?.total ?? 0
  return <div className="space-y-4">
    <header><h1 className="text-xl font-semibold">Bench campaigns</h1><p className="mt-1 text-sm text-agni-slate">Read-only campaign history from the ferrodiode bench.</p></header>
    <div className="grid gap-3 rounded-lg border border-border-subtle bg-white p-4 sm:grid-cols-2">
      <Select label="DUT" value={dutId} options={duts.data.items.map((dut) => ({ value: dut.dut_id, label: dut.dut_id }))} onChange={(event) => updateView(filters, event.target.value)} />
      <Select label="Status" placeholder="All statuses" value={status ?? ''} options={statusOptions} onChange={(event) => updateView(event.target.value ? { ...filters, status: [event.target.value] } : { ...filters, status: [] })} />
    </div>
    {runs.isLoading ? <Spinner /> : runs.error ? <p className="text-[#B3261E]">{runs.error.message}</p> : <Table table={table} onRowClick={(run) => navigate(`/bench/runs/${encodeURIComponent(run.run_id)}?dut_id=${encodeURIComponent(run.dut_id)}`)} emptyText={`No campaign runs exist for DUT ${dutId}${status ? ` with status ${status}` : ''}.`} />}
    <div className="flex items-center justify-between"><p className="text-sm text-agni-slate">{total ? `${page * pageSize + 1}-${Math.min((page + 1) * pageSize, total)} of ${total}` : '0 runs'}</p><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page === 0} onClick={() => updateView(filters, dutId, page - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={(page + 1) * pageSize >= total} onClick={() => updateView(filters, dutId, page + 1)}>Next</Button></div></div>
  </div>
}

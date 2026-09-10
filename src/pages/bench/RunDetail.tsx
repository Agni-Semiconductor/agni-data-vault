import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CoverageMap, type CoverageCell } from '../../components/CoverageMap'
import { Badge, Spinner } from '../../components/ui'
import { Histograms } from './Histograms'
import { LineRates } from './LineRates'
import { getBenchCoverage, getBenchRun } from '../../lib/bench'

type SelectedCell = { row: number; col: number }
const toneForStatus = (status: string): 'gray' | 'green' | 'amber' | 'red' | 'blue' => status === 'completed' ? 'green' : status === 'running' ? 'blue' : status === 'failed' || status === 'aborted' ? 'red' : 'gray'
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value)) : 'Not recorded'
function Hash({ label, value }: { label: string; value: string | null }) { return <div className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-agni-slate">{label}</dt><dd className="mt-1 truncate font-mono text-xs" title={value ?? 'Not recorded'}>{value ?? 'Not recorded'}</dd></div> }

export default function BenchRunDetail() {
  const { runId = '' } = useParams(); const [search] = useSearchParams(); const dutId = search.get('dut_id') ?? ''; const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null); const cellTable = useRef<HTMLElement>(null)
  const detail = useQuery({ queryKey: ['bench-run', runId, dutId], enabled: Boolean(runId && dutId), queryFn: () => getBenchRun(runId, dutId) })
  const coverage = useQuery({ queryKey: ['bench-coverage', dutId, runId], enabled: Boolean(runId && dutId), queryFn: () => getBenchCoverage(dutId, runId) })
  useEffect(() => { if (detail.data?.run) document.title = `${detail.data.run.name || detail.data.run.run_id} · Bench · Agni Data Vault` }, [detail.data])
  const selectCell = (cell: CoverageCell | null) => { if (!cell) return; setSelectedCell({ row: cell[0], col: cell[1] }); window.requestAnimationFrame(() => cellTable.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
  if (!dutId) return <section className="space-y-3 rounded-lg border border-border-subtle bg-white p-6"><h1 className="text-xl font-semibold">Run cannot be loaded</h1><p className="text-sm text-agni-slate">The link does not identify a DUT. A run ID is only unique together with its DUT ID.</p><Link className="text-agni-orange underline" to="/bench">Back to campaigns</Link></section>
  if (detail.isLoading) return <Spinner />
  if (detail.error) return <p className="text-[#B3261E]">{detail.error.message}</p>
  const run = detail.data?.run
  if (!run) return <section className="space-y-3 rounded-lg border border-border-subtle bg-white p-6"><h1 className="text-xl font-semibold">Run not found</h1><p className="text-sm text-agni-slate">No campaign run named {runId} exists for DUT {dutId}.</p><Link className="text-agni-orange underline" to={`/bench?dut_id=${encodeURIComponent(dutId)}`}>Back to campaigns</Link></section>
  return <div className="space-y-6">
    <header className="space-y-4"><Link className="text-sm text-agni-orange underline" to={`/bench?dut_id=${encodeURIComponent(dutId)}`}>Back to campaigns</Link><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-mono text-xs text-agni-slate">{run.dut_id} / {run.run_id}</p><h1 className="mt-1 text-2xl font-semibold">{run.name || run.run_id}</h1><div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={toneForStatus(run.status)}>{run.status}</Badge><span className="text-sm text-agni-slate">{run.kind ?? 'Unknown kind'}</span><span className="text-sm text-agni-slate">Operator: {run.operator ?? 'Unknown'}</span><span className="text-sm text-agni-slate">Started: {formatDate(run.started_at)}</span></div></div></div>
      <dl className="grid gap-4 rounded-lg border border-border-subtle bg-white p-4 sm:grid-cols-3"><Hash label="Module SHA-256" value={run.module_sha256} /><Hash label="Config SHA-256" value={run.config_sha256} /><Hash label="Safety SHA-256" value={run.safety_sha256} /></dl>
    </header>
    <section className="space-y-3"><div><h2 className="text-lg font-semibold">Coverage</h2><p className="text-sm text-agni-slate">Latest attempted state for each visited cell. Untested cells remain blank.</p></div>{coverage.isLoading ? <Spinner /> : coverage.error ? <div className="rounded-lg border border-red-200 bg-red-50 p-4"><p className="font-medium text-red-900">Coverage unavailable</p><p className="mt-1 text-sm text-red-800">{coverage.error.message}</p></div> : coverage.data && coverage.data.cells.length ? <CoverageMap coverage={coverage.data} onCellClick={selectCell} /> : <div className="rounded-lg border border-border-subtle bg-white p-6"><p className="font-medium">No coverage to display</p><p className="mt-1 text-sm text-agni-slate">This run has no attempted cells, so the map is intentionally blank.</p></div>}</section>
    <section ref={cellTable} className="scroll-mt-6 space-y-3 rounded-lg border border-border-subtle bg-white p-4"><h2 className="text-lg font-semibold">Cells</h2><p className="text-sm text-agni-slate">{selectedCell ? `Selected row ${selectedCell.row}, column ${selectedCell.col}. The cell table component will focus this coordinate when integrated.` : 'Select a tested cell in the coverage map to focus it here. The cell table component is owned by the parallel bench-cells workstream.'}</p></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Analysis</h2>{detail.isLoading ? <Spinner /> : !detail.data ? <div className="rounded-lg border border-border-subtle bg-white p-6"><p className="font-medium">Analysis unavailable</p><p className="mt-1 text-sm text-agni-slate">The run could not be loaded, so whether an analysis exists is unknown.</p></div> : detail.data.analysis === null ? <div className="rounded-lg border border-border-subtle bg-white p-6"><p className="font-medium">No analysis ingested</p><p className="mt-1 text-sm text-agni-slate">The campaign exists, but no run analysis has been published for it yet. This is a normal ingest state.</p></div> : <div className="rounded-lg border border-border-subtle bg-white p-6"><p className="font-medium">Analysis available</p><p className="mt-1 text-sm text-agni-slate">Extractor {detail.data.analysis.extractor_version} was ingested {formatDate(detail.data.analysis.analysed_at)}. The distributions and per-line rates are below.</p></div>}</section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Distributions</h2><Histograms dutId={dutId} runId={runId} /></section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Line rates</h2><LineRates dutId={dutId} runId={runId} /></section>
  </div>
}

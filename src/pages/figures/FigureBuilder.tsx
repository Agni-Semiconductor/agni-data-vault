import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Input, Select, Spinner } from '../../components/ui'
import { FigurePanel } from '../../plot/FigurePanel'
import { downloadSvg, figureToSvg, type SvgPanel } from '../../plot/exportSvg'
import { detectKind, type PlotKind } from '../../plot/plotProfiles'
import { resolvePanel, type TraceInput } from '../../plot/resolveTraces'
import { parseInWorker } from '../../plot/useParsedFile'
import type { ParsedFile } from '../../plot/parseFile'
import { useKinds } from '../../fields/useKinds'
import { filenameFrom } from '../../lib/contentDisposition'
import { safeFilename } from '../../plot/exportPng'
import { createFigure, deleteFigure, getFigure, updateFigure, type Figure, type FigureSource, type FigureSpec, type PanelSpec, type TraceSpec } from '../../lib/figures'

const TRANSFORMS = ['abs', 'log10', 'normalize'] as const
const emptySpec = (): FigureSpec => ({ layout: '1x1', panels: [{ traces: [], y_scale: 'linear' }] })

// One trace's source, resolved to bytes and parsed. Keyed by file_id because that is what the
// spec stores; the sha256 would be a better cache key but the spec is not allowed to depend on
// a hash that changes when a file is re-registered.
type LoadedSource = { parsed?: ParsedFile; kind?: PlotKind; name?: string; error?: string; loading: boolean }


/**
 * Load and parse every distinct source a spec references.
 *
 * `useParsedFile` handles exactly one file and cannot be called in a loop, so this drives
 * `parseInWorker` directly -- its module-level cache is keyed, so a file appearing in four
 * panels is fetched and parsed ONCE. That matters more than it looks: these are Clarius
 * workbooks, and parsing one is seconds of main-thread work if the worker is unavailable.
 *
 * A source that fails to load is recorded with its reason rather than omitted. A figure that
 * silently drops a panel is indistinguishable from a figure that never had one.
 */
function useFigureSources(spec: FigureSpec) {
  const ids = useMemo(() => [...new Set(spec.panels.flatMap((panel) => (panel.traces ?? []).map((trace) => trace.src?.file_id).filter((id): id is string => Boolean(id))))].sort(), [spec])
  const [sources, setSources] = useState<Record<string, LoadedSource>>({})
  const key = ids.join(',')
  useEffect(() => {
    let live = true
    if (!ids.length) { setSources({}); return }
    setSources((current) => Object.fromEntries(ids.map((id) => [id, current[id]?.parsed ? current[id] : { loading: true }])))
    void Promise.all(ids.map(async (id) => {
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(id)}/content`, { credentials: 'include' })
        if (!response.ok) throw new Error(`file content returned ${response.status}`)
        // The filename comes from the response, not a second request. There is no
        // GET /api/files/:id route, and adding one just to learn a name would be a contract
        // change for something the router ALREADY sends: it sets
        // `content-disposition: attachment; filename*=UTF-8''<name>` on this very response. The
        // name matters because `detectKind` reads it -- a Clarius workbook and a board capture
        // are told apart partly by filename, and getting that wrong picks the wrong axes.
        const name = filenameFrom(response.headers.get('content-disposition')) ?? id
        const parsed = await parseInWorker(new Blob([await response.arrayBuffer()]), name, undefined, id)
        if (live) setSources((current) => ({ ...current, [id]: { parsed, kind: detectKind(parsed.headers, name), name, loading: false } }))
      } catch (reason: unknown) {
        if (live) setSources((current) => ({ ...current, [id]: { error: reason instanceof Error ? reason.message : String(reason), loading: false } }))
      }
    }))
    return () => { live = false }
    // `key` is the stable identity of `ids`; depending on the array itself refetches every render.
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return sources
}

export default function FigureBuilder() {
  const { id = '' } = useParams(); const isNew = id === 'new'
  const navigate = useNavigate(); const client = useQueryClient(); const { registry } = useKinds()
  const query = useQuery({ queryKey: ['figure', id], queryFn: () => getFigure(id), enabled: !isNew })
  const [draft, setDraft] = useState<{ title: string; description: string; slug: string; spec: FigureSpec }>({ title: '', description: '', slug: '', spec: emptySpec() })
  const [dirty, setDirty] = useState(false)

  useEffect(() => { const figure = query.data?.figure; if (figure && !dirty) setDraft({ title: figure.title, description: figure.description ?? '', slug: figure.slug ?? '', spec: figure.spec }) }, [query.data, dirty])

  const sources = useFigureSources(draft.spec)
  const edit = useCallback((update: (spec: FigureSpec) => FigureSpec) => { setDirty(true); setDraft((current) => ({ ...current, spec: update(current.spec) })) }, [])
  const editPanel = useCallback((index: number, update: (panel: PanelSpec) => PanelSpec) => edit((spec) => ({ ...spec, panels: spec.panels.map((panel, at) => at === index ? update(panel) : panel) })), [edit])
  const editTrace = useCallback((panelIndex: number, traceIndex: number, update: (trace: TraceSpec) => TraceSpec) => editPanel(panelIndex, (panel) => ({ ...panel, traces: (panel.traces ?? []).map((trace, at) => at === traceIndex ? update(trace) : trace) })), [editPanel])

  const save = useMutation({
    mutationFn: async () => {
      const payload = { title: draft.title.trim(), spec: draft.spec, description: draft.description.trim() || undefined, slug: draft.slug.trim() || undefined }
      return isNew ? createFigure(payload) : updateFigure(id, payload)
    },
    onSuccess: async (figure: Figure) => { setDirty(false); await client.invalidateQueries({ queryKey: ['figures'] }); await client.invalidateQueries({ queryKey: ['figure', id] }); if (isNew) navigate(`/figures/${figure.slug || figure.id}`, { replace: true }) },
  })
  const remove = useMutation({ mutationFn: () => deleteFigure(id), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['figures'] }); navigate('/figures') } })

  // Unresolved SPEC references, straight from vault.figure_sources. A jsonb trace cannot carry a
  // foreign key, so a deleted file leaves a reference that would otherwise render as a blank
  // panel and read as a plotting bug. Showing "3 of 4 resolved" is the whole reason the view
  // exists, so a saved figure never quietly draws less than it claims.
  const unresolved = (query.data?.sources ?? []).filter((source: FigureSource) => !source.source_exists)
  // Resolved ONCE, and the export reads the same array the screen does. Re-resolving for the
  // export is the obvious alternative and it is how the exported figure ends up drawing a
  // different set of traces than the one the author approved -- a second resolution can pick up
  // a source that finished loading in between, or miss one that failed.
  const resolvedPanels = useMemo(() => draft.spec.panels.map((panel) => {
    const inputs: TraceInput[] = (panel.traces ?? []).flatMap((spec) => { const source = spec.src?.file_id ? sources[spec.src.file_id] : undefined; return source?.parsed && source.kind ? [{ spec, parsed: source.parsed, kind: source.kind }] : [] })
    const loading = (panel.traces ?? []).some((spec) => spec.src?.file_id && sources[spec.src.file_id]?.loading)
    const failed = (panel.traces ?? []).flatMap((spec, at) => { const source = spec.src?.file_id ? sources[spec.src.file_id] : undefined; return source?.error ? [{ label: spec.label ?? `trace ${at + 1}`, reason: source.error }] : [] })
    const resolved = resolvePanel(inputs, { unit: panel.unit ?? null, y_scale: panel.y_scale }, registry)
    // A source that would not LOAD is shown next to a trace that was REFUSED on units. They are
    // different problems with the same symptom -- an absent curve -- so they must not be
    // collapsed into one message.
    return { loading, panel: { ...resolved, refusals: [...resolved.refusals, ...failed] } }
  }), [draft.spec.panels, registry, sources])

  const exportSvg = useCallback(() => {
    const panels: SvgPanel[] = resolvedPanels.map((entry, index) => ({ panel: entry.panel, title: `Panel ${index + 1}` }))
    const svg = figureToSvg(panels, { title: draft.title || 'Figure', subtitle: draft.description || new Date().toISOString().slice(0, 10), layout: draft.spec.layout })
    downloadSvg(svg, `${safeFilename(draft.title || 'figure')}.svg`)
  }, [draft.description, draft.spec.layout, draft.title, resolvedPanels])

  if (!isNew && query.isLoading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!isNew && query.error) return <p className="text-sm text-[#B3261E]">{(query.error as Error).message}</p>

  return <div className="space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block"><span className="label-caps mb-1 block">Title</span><Input value={draft.title} onChange={(event) => { setDirty(true); setDraft((c) => ({ ...c, title: event.target.value })) }} placeholder="Ec- versus FE thickness" className="w-72" /></label>
        <label className="block"><span className="label-caps mb-1 block">Slug</span><Input value={draft.slug} onChange={(event) => { setDirty(true); setDraft((c) => ({ ...c, slug: event.target.value })) }} placeholder="optional, shareable" className="w-56" /></label>
      </div>
      <div className="flex items-center gap-2">
        {dirty && <Badge tone="amber">unsaved</Badge>}
        <Button onClick={() => save.mutate()} disabled={!draft.title.trim() || save.isPending}>{save.isPending ? 'Saving…' : isNew ? 'Create figure' : 'Save'}</Button>
        {!isNew && <Button variant="ghost" onClick={() => { if (window.confirm('Delete this figure? Anyone holding its link will lose it.')) remove.mutate() }}>Delete</Button>}
        {/* Vector, rendered from the SAME resolved panels the screen is drawing -- not a
            second pass over the source files, which could quietly export a different
            figure than the one on screen. Disabled while any source is still loading,
            because a half-loaded figure exports as a real file with traces missing. */}
        <Button variant="ghost" onClick={exportSvg} disabled={resolvedPanels.some((entry) => entry.loading)} title="Vector export, drawn from the resolved traces on screen">Export SVG</Button>
      </div>
    </div>
    <label className="block"><span className="label-caps mb-1 block">Description</span><Input value={draft.description} onChange={(event) => { setDirty(true); setDraft((c) => ({ ...c, description: event.target.value })) }} className="w-full max-w-2xl" /></label>
    {save.error && <p className="text-sm text-[#B3261E]">{(save.error as Error).message}</p>}

    {unresolved.length > 0 && <div className="rounded border border-[#B3261E] bg-white p-3 text-sm">
      <p className="font-medium text-[#B3261E]">{(query.data?.sources ?? []).length - unresolved.length} of {(query.data?.sources ?? []).length} saved trace sources still exist</p>
      <ul className="mt-1 space-y-1 text-agni-slate">{unresolved.map((source) => <li key={`${source.panel_index}-${source.trace_index}`}>panel {source.panel_index + 1}, trace {source.trace_index + 1}{source.label ? ` (${source.label})` : ''}: {source.file_id ? `file ${source.file_id}` : source.capture_id ? `capture ${source.capture_id}` : 'no source'} no longer exists</li>)}</ul>
    </div>}

    <div className="space-y-8">
      {draft.spec.panels.map((panel, panelIndex) => {
        const { loading, panel: withFailures } = resolvedPanels[panelIndex]
        return <section key={panelIndex} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <span className="label-caps">Panel {panelIndex + 1}</span>
            <label className="block"><span className="label-caps mb-1 block">Unit</span><Input value={panel.unit ?? ''} onChange={(event) => editPanel(panelIndex, (p) => ({ ...p, unit: event.target.value || null }))} placeholder="adopt first trace" className="w-32" /></label>
            <Select label="Y scale" value={panel.y_scale ?? 'linear'} options={[{ value: 'linear', label: 'linear' }, { value: 'log', label: 'log' }]} onChange={(event) => editPanel(panelIndex, (p) => ({ ...p, y_scale: event.target.value as 'log' | 'linear' }))} className="w-28" />
            <Button variant="ghost" size="sm" onClick={() => edit((spec) => ({ ...spec, panels: spec.panels.filter((_, at) => at !== panelIndex) }))} disabled={draft.spec.panels.length === 1}>Remove panel</Button>
          </div>

          {loading ? <div className="flex justify-center py-8"><Spinner /></div> : <FigurePanel panel={withFailures} unit={panel.unit ?? undefined} />}

          <div className="space-y-2">
            {(panel.traces ?? []).map((trace, traceIndex) => {
              const source = trace.src?.file_id ? sources[trace.src.file_id] : undefined
              const columnOptions = (source?.parsed?.headers ?? []).map((header) => ({ value: header, label: header }))
              return <div key={traceIndex} className="flex flex-wrap items-end gap-2 rounded border border-border-subtle p-2">
                <label className="block"><span className="label-caps mb-1 block">File id</span><Input value={trace.src?.file_id ?? ''} onChange={(event) => editTrace(panelIndex, traceIndex, (t) => ({ ...t, src: { file_id: event.target.value } }))} className="w-64 font-mono text-xs" /></label>
                <span className="pb-2 text-xs text-agni-slate">{source?.loading ? 'loading…' : source?.error ? <span className="text-[#B3261E]">{source.error}</span> : source?.name}</span>
                <Select label="x" value={trace.x ?? ''} placeholder="kind default" options={columnOptions} onChange={(event) => editTrace(panelIndex, traceIndex, (t) => ({ ...t, x: event.target.value || undefined }))} className="w-36" />
                <Select label="y" value={trace.y ?? ''} placeholder="kind default" options={columnOptions} onChange={(event) => editTrace(panelIndex, traceIndex, (t) => ({ ...t, y: event.target.value || undefined }))} className="w-36" />
                <label className="block"><span className="label-caps mb-1 block">Label</span><Input value={trace.label ?? ''} onChange={(event) => editTrace(panelIndex, traceIndex, (t) => ({ ...t, label: event.target.value || undefined }))} className="w-40" /></label>
                <div className="flex flex-wrap items-center gap-2 pb-1">{TRANSFORMS.map((name) => { const on = (trace.transform ?? []).includes(name); return <label key={name} className="flex items-center gap-1 text-xs text-agni-ink"><input type="checkbox" checked={on} onChange={() => editTrace(panelIndex, traceIndex, (t) => ({ ...t, transform: on ? (t.transform ?? []).filter((entry) => entry !== name) : [...(t.transform ?? []), name] }))} />{name}</label> })}</div>
                <Button variant="ghost" size="sm" onClick={() => editPanel(panelIndex, (p) => ({ ...p, traces: (p.traces ?? []).filter((_, at) => at !== traceIndex) }))}>Remove</Button>
              </div>
            })}
            <Button variant="ghost" size="sm" onClick={() => editPanel(panelIndex, (p) => ({ ...p, traces: [...(p.traces ?? []), { src: {} }] }))}>Add trace</Button>
          </div>
        </section>
      })}
      <Button variant="ghost" onClick={() => edit((spec) => ({ ...spec, panels: [...spec.panels, { traces: [], y_scale: 'linear' }] }))}>Add panel</Button>
    </div>
  </div>
}

// Deliberately NOT built here: a browse-and-pick source selector. A trace's source is entered as
// a file id, which is honest but tedious. The right home for picking is the measurement page --
// "add this file to a figure", where the user is already looking at the file -- and that is an
// edit to MeasurementDetail.tsx, not to this one. Left as a follow-up rather than half-built,
// because a picker that only searched samples would miss bench captures entirely and the spec
// supports both kinds of source.

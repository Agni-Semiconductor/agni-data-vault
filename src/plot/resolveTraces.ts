import type { ParsedFile } from './parseFile'
import { PROFILES, buildUplotData, decimate, pickDcivChannel, type PlotKind, type ResolvedSeries } from './plotProfiles'
import { checkTrace, type UnitRegistry } from './units'

export type TraceSpec = { src: { file_id?: string; capture_id?: string }; x?: string; y?: string; transform?: string[]; label?: string }
export type TraceInput = { spec: TraceSpec; parsed: ParsedFile; kind: PlotKind }
export type ResolvedTrace = { x: number[]; y: (number | null)[]; label: string; unit: string; factor: number; points: number; decimated: boolean }
export type PanelSpec = { unit?: string | null; y_scale?: 'log' | 'linear' }
export type ResolvedPanel = { traces: ResolvedTrace[]; refusals: Array<{ label: string; reason: string }>; unit: string | null; xRange: [number, number]; yRange: [number, number]; log_y: boolean }

const indexOf = (headers: string[], candidate: string) => headers.findIndex((header) => header.toLowerCase() === candidate.toLowerCase())
const number = (value: unknown): number | null => { const result = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN; return Number.isFinite(result) ? result : null }
const choose = (headers: string[], given: string | undefined, choices: string[], fallback: number) => given ?? choices.map((choice) => headers[indexOf(headers, choice)]).find(Boolean) ?? headers[fallback] ?? ''
const transformError = (transforms: string[]) => transforms.find((transform) => transform !== 'abs' && transform !== 'log10' && transform !== 'normalize' && (!transform.startsWith('offset:') || !Number.isFinite(Number(transform.slice(7)))))

function transform(values: number[], transforms: string[]): (number | null)[] {
  let result: (number | null)[] = values
  for (const name of transforms) {
    if (name === 'abs') result = result.map((value) => value === null ? null : Math.abs(value))
    else if (name === 'log10') result = result.map((value) => value === null || value <= 0 ? null : Math.log10(value))
    // Folded, NOT `Math.max(...values)`. The spread passes every element as an argument and
    // blows the call stack somewhere above ~125k of them -- verified: 200,000 points throws
    // RangeError. This runs BEFORE decimation, on the full sweep, so a long PUND or a board
    // capture reaches it at full length and the figure dies with a stack overflow rather than
    // anything that points at normalize.
    else if (name === 'normalize') { let scale = 0; for (const value of result) if (value !== null) { const magnitude = Math.abs(value); if (magnitude > scale) scale = magnitude }; if (scale) result = result.map((value) => value === null ? null : value / scale) }
    else { const offset = Number(name.slice(7)); result = result.map((value) => value === null ? null : value + offset) }
  }
  return result
}

export function resolvePanel(inputs: TraceInput[], panel: PanelSpec, registry: UnitRegistry): ResolvedPanel {
  const log_y = panel.y_scale === 'log'; const traces: ResolvedTrace[] = []; const refusals: Array<{ label: string; reason: string }> = []; let unit = panel.unit ?? null
  for (const input of inputs) {
    const { parsed, kind, spec } = input; const profile = PROFILES[kind]; const yLabel = choose(parsed.headers, spec.y, kind === 'dciv' ? [pickDcivChannel(parsed)] : profile.y, 1); const xLabel = choose(parsed.headers, spec.x, profile.x, 0); const label = spec.label ?? yLabel; const invalid = transformError(spec.transform ?? [])
    // Reject before unit adoption: a malformed transform must not silently commit the panel axis.
    if (invalid) { refusals.push({ label, reason: `unknown transform ${invalid}` }); continue }
    // A column the SPEC NAMES EXPLICITLY and the file does not have is a refusal. `choose` falls
    // back to headers[0]/[1] by position, which is right for resolveSeries -- "plot this file,
    // best effort" -- and wrong here. A figure says "plot exactly this column", and a positional
    // fallback that happens to land on a registered column of the same unit plots a DIFFERENT
    // QUANTITY under the trace's label, passes every unit check, and is unfalsifiable from the
    // rendered figure. Only an explicit request is held to this; a kind's fallback list is
    // meant to be searched.
    const absent = ([['y', spec.y], ['x', spec.x]] as const).find(([, column]) => column && indexOf(parsed.headers, column) < 0)
    if (absent) { refusals.push({ label, reason: `${absent[0]} column ${absent[1]} is not in this file` }); continue }
    const checked = checkTrace(registry, { column: yLabel, kindAxisUnit: registry.kinds[kind.toLowerCase()]?.y_unit ?? null, panelUnit: unit })
    if ('reason' in checked) { refusals.push({ label, reason: checked.reason }); continue }
    const xi = indexOf(parsed.headers, xLabel); const yi = indexOf(parsed.headers, yLabel); const rawX: number[] = []; const rawY: number[] = []
    for (const row of parsed.rows) { const x = number(row[xi]); const y = number(row[yi]); if (x === null || y === null) continue; rawX.push(x); rawY.push(y * checked.factor) }
    const y = transform(rawY, spec.transform ?? []).map((value) => log_y && (value === null || value <= 0) ? null : value)
    const reduced = decimate(rawX, y); traces.push({ x: reduced.x, y: reduced.y, label, unit: checked.unit, factor: checked.factor, points: rawX.length, decimated: reduced.x.length < rawX.length }); unit = checked.unit
  }
  const allX = traces.flatMap((trace) => trace.x); const allY = traces.flatMap((trace) => trace.y); const series: ResolvedSeries = { x: allX, y: allY, labels: { x: '', y: '' }, log_y }; const { xRange, yRange } = buildUplotData(series)
  return { traces, refusals, unit, xRange, yRange, log_y }
}

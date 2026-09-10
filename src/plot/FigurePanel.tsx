import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Badge } from '../components/ui'
import { fmtNum, fmtSci } from './plotProfiles'
import type { ResolvedPanel, ResolvedTrace } from './resolveTraces'

// A palette that collapses under CVD makes distinct traces indistinguishable evidence.
export const TRACE_COLORS = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#000000']
export const refusalText = ({ label, reason }: ResolvedPanel['refusals'][number]) => `${label}: ${reason}`
export const decimationBadgeText = (trace: ResolvedTrace) => trace.decimated ? `decimated: ${trace.points} points` : null
const factorText = (factor: number) => { const [coefficient, exponent] = factor.toExponential().split('e'); return `${Number(coefficient)}e${Number(exponent)}` }
export const conversionBadgeText = (trace: ResolvedTrace) => trace.factor !== 1 ? `${trace.label} -> ${trace.unit}, x${factorText(trace.factor)}` : null
// CONCATENATED, not unioned-and-sorted. uPlot wants one shared x array for every series, and
// the obvious way to build it -- collect the distinct x values, sort them, and key each trace's
// y by x -- destroys the measurement this app exists to plot. A DC-IV sweep runs
// 0 -> +Vmax -> 0, so nearly every voltage appears TWICE with a different current: keying by x
// keeps only the last, and the hysteresis loop collapses to a single branch. Sorting throws away
// the traversal order on top of that, and `resolveSeries` deliberately preserves it --
// tests/plotProfiles.test.ts pins `expect(s.x).toEqual(volts)` on an unsorted sweep for exactly
// this reason.
//
// So each trace gets its own SLICE of the shared array: its real x values in its own order,
// duplicates intact, and null in every other trace's slice. With `spanGaps: false` each series
// draws only across its own slice. The combined x is non-monotonic, which uPlot tolerates --
// QuickPlot has always handed it unsorted x for the same loops.
export function buildPanelData(panel: ResolvedPanel): uPlot.AlignedData {
  const xs = panel.traces.flatMap((trace) => trace.x); let offset = 0
  const series = panel.traces.map((trace) => { const column = new Array<number | null>(xs.length).fill(null); for (let index = 0; index < trace.x.length; index += 1) column[offset + index] = trace.y[index] ?? null; offset += trace.x.length; return column })
  return [xs, ...series]
}

export function FigurePanel({ panel, title, unit }: { panel: ResolvedPanel; title?: string; unit?: string | null }) {
  const height = 320; const axisUnit = unit ?? panel.unit; const data = useMemo(() => buildPanelData(panel), [panel]); const host = useRef<HTMLDivElement>(null); const chart = useRef<uPlot | null>(null); const [hover, setHover] = useState<{ x: number; ys: (number | null)[] }>()
  useLayoutEffect(() => {
    const element = host.current; if (!element || !data[0].length) return
    const create = () => { const width = element.clientWidth; if (width <= 0) return; chart.current?.destroy(); chart.current = new uPlot({
      width, height, title: title ?? `Figure panel · ${panel.traces.length} traces`, legend: { show: false }, cursor: { show: true }, hooks: { setCursor: [(self: uPlot) => { const index = self.cursor.idx ?? -1; const next = index >= 0 ? { x: Number(self.data[0][index]), ys: panel.traces.map((_, traceIndex) => (self.data[traceIndex + 1]?.[index] ?? null) as number | null) } : undefined; setHover((previous) => previous?.x === next?.x && previous?.ys.every((value, traceIndex) => value === next?.ys[traceIndex]) ? previous : next) }] },
      scales: { x: { time: false, auto: false, range: () => panel.xRange }, y: { auto: false, distr: panel.log_y ? 3 : 1, ...(panel.log_y ? { log: 10 as const } : {}), range: () => panel.yRange } },
      axes: [{ stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: 'x', values: (_self: uPlot, ticks: number[]) => ticks.map(fmtNum) }, { stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: axisUnit ? `y (${axisUnit})${panel.log_y ? ', log' : ''}` : `y${panel.log_y ? ', log' : ''}`, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value, panel.log_y)) }],
      series: [{}, ...panel.traces.map((trace, index) => ({ label: trace.label, stroke: TRACE_COLORS[index % TRACE_COLORS.length], width: 1.5, points: { show: false }, paths: uPlot.paths.linear!(), spanGaps: false }))],
    }, data, element) }
    create(); const observer = new ResizeObserver(() => { const width = element.clientWidth; if (width <= 0) return; if (chart.current) chart.current.setSize({ width, height }); else create() }); observer.observe(element)
    return () => { observer.disconnect(); chart.current?.destroy(); chart.current = null }
  }, [axisUnit, data, height, panel, title])
  const hasData = data[0].length > 0
  return <section className="space-y-3 rounded-lg border border-border-subtle bg-white p-4 shadow-card">
    {title && <h3 className="text-base font-semibold text-agni-ink">{title}</h3>}
    {hasData ? <div ref={host} className="relative min-h-[176px] w-full overflow-hidden" style={{ height }} /> : <div className="min-h-[176px] rounded border border-dashed border-border-subtle p-4 text-sm text-agni-slate"><p className="font-medium text-agni-ink">No accepted traces with numeric points</p><p className="mt-1">This panel remains visible so missing data is not mistaken for a rendering failure.</p></div>}
    {panel.traces.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-agni-slate">{panel.traces.map((trace, index) => <div key={`${trace.label}-${index}`} className="flex flex-wrap items-center gap-1.5"><span className="flex items-center gap-1.5 text-agni-ink"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: TRACE_COLORS[index % TRACE_COLORS.length] }} />{trace.label}</span>{decimationBadgeText(trace) && <Badge tone="amber">{decimationBadgeText(trace)}</Badge>}{conversionBadgeText(trace) && <Badge tone="blue">{conversionBadgeText(trace)}</Badge>}</div>)}</div>}
    {hover && <div className="flex flex-wrap gap-3 text-xs text-agni-slate"><span>x {fmtSci(hover.x)}</span>{panel.traces.map((trace, index) => <span key={`${trace.label}-${index}`}>{trace.label} {hover.ys[index] === null ? '—' : fmtSci(hover.ys[index]!, panel.log_y)}</span>)}</div>}
    {panel.refusals.length > 0 && <div className="rounded border border-[#B3261E] bg-white p-3 text-sm"><p className="font-medium text-[#B3261E]">Refused traces</p><ul className="mt-1 space-y-1 text-agni-slate">{panel.refusals.map((refusal, index) => <li key={`${refusal.label}-${index}`}>{refusalText(refusal)}</li>)}</ul></div>}
  </section>
}

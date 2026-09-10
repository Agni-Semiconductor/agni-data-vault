import { useLayoutEffect, useMemo, useRef } from 'react'
import { TRACE_COLORS } from '../../plot/panelData'
import { fmtSci } from '../../plot/plotProfiles'
import { SMALL_N, count, isLedgerBalanced, isSmallCohort, label, nonConfirmed, orderCohortGroups, provenanceSummaryText, statistics, undrawableReason, type CohortGroup, type GroupKey, type MetricDefinition } from './cohortStats'
export type { CohortGroup, GroupKey, MetricDefinition } from './cohortStats'

function drawChart(canvas: HTMLCanvasElement, groups: CohortGroup[], metric: MetricDefinition) {
  const width = canvas.clientWidth; const height = 300; if (!width) return
  const dpr = window.devicePixelRatio || 1; canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); const context = canvas.getContext('2d'); if (!context) return
  context.scale(dpr, dpr); context.clearRect(0, 0, width, height); context.font = '11px IBM Plex Sans'; const left = 58; const right = 14; const top = 18; const bottom = 52; const plotWidth = width - left - right; const plotHeight = height - top - bottom
  const drawable = groups.filter((group) => statistics(group, metric.log_scale)); const values = drawable.flatMap((group) => [group.min_value!, group.max_value!]); const transformed = values.map((value) => metric.log_scale ? Math.log10(value) : value); let lo = Math.min(...transformed); let hi = Math.max(...transformed)
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1 } else if (lo === hi) { lo -= 1; hi += 1 } else { const pad = (hi - lo) * .06; lo -= pad; hi += pad }
  const y = (value: number) => top + (hi - (metric.log_scale ? Math.log10(value) : value)) / (hi - lo) * plotHeight
  context.strokeStyle = '#E8E8EC'; context.fillStyle = '#667085'; context.textAlign = 'right'
  for (let tick = 0; tick < 5; tick += 1) { const value = lo + (hi - lo) * tick / 4; const py = top + plotHeight - plotHeight * tick / 4; context.beginPath(); context.moveTo(left, py); context.lineTo(width - right, py); context.stroke(); context.fillText(fmtSci(metric.log_scale ? 10 ** value : value, metric.log_scale), left - 6, py + 4) }
  context.save(); context.translate(13, top + plotHeight / 2); context.rotate(-Math.PI / 2); context.textAlign = 'center'; context.fillStyle = '#344054'; context.fillText(`${metric.label} (${metric.unit || 'unitless'})${metric.log_scale ? ', log' : ''}`, 0, 0); context.restore()
  const step = plotWidth / Math.max(groups.length, 1); const boxWidth = Math.min(42, step * .58)
  groups.forEach((group, index) => {
    const x = left + step * (index + .5); const small = isSmallCohort(group); const questionable = nonConfirmed(group); const usable = statistics(group, metric.log_scale)
    context.strokeStyle = questionable ? TRACE_COLORS[1] : TRACE_COLORS[0]; context.fillStyle = questionable ? 'rgba(230,159,0,.18)' : 'rgba(0,114,178,.18)'; context.lineWidth = small ? 1 : 2
    if (usable) { const q1 = y(group.q1!); const q3 = y(group.q3!); const median = y(group.median!); context.fillRect(x - boxWidth / 2, q3, boxWidth, q1 - q3); context.strokeRect(x - boxWidth / 2, q3, boxWidth, q1 - q3); context.beginPath(); context.moveTo(x, y(group.min_value!)); context.lineTo(x, q3); context.moveTo(x, q1); context.lineTo(x, y(group.max_value!)); context.moveTo(x - boxWidth / 3, y(group.min_value!)); context.lineTo(x + boxWidth / 3, y(group.min_value!)); context.moveTo(x - boxWidth / 3, y(group.max_value!)); context.lineTo(x + boxWidth / 3, y(group.max_value!)); context.stroke(); context.strokeStyle = '#000000'; context.beginPath(); context.moveTo(x - boxWidth / 2, median); context.lineTo(x + boxWidth / 2, median); context.stroke() }
    else { context.setLineDash([3, 2]); context.strokeRect(x - boxWidth / 2, top + plotHeight / 2 - 10, boxWidth, 20); context.setLineDash([]); context.fillStyle = '#667085'; context.textAlign = 'center'; context.fillText(undrawableReason(group, metric.log_scale) ?? '', x, top + plotHeight / 2 + 4) }
    if (small && usable) { context.save(); context.beginPath(); context.rect(x - boxWidth / 2, y(group.q3!), boxWidth, y(group.q1!) - y(group.q3!)); context.clip(); context.strokeStyle = TRACE_COLORS[5]; context.lineWidth = 1; for (let hatch = x - boxWidth; hatch < x + boxWidth; hatch += 5) { context.beginPath(); context.moveTo(hatch, y(group.q1!)); context.lineTo(hatch + boxWidth, y(group.q3!)); context.stroke() } context.restore() }
    context.fillStyle = '#344054'; context.textAlign = 'center'; context.fillText(`n=${count(group.n_with_metric)}`, x, top + plotHeight + 16); context.fillText(questionable ? `${label(group)} !` : label(group), x, top + plotHeight + 31)
  })
}

export function CohortChart({ groups, metric, groupKey }: { groups: CohortGroup[]; metric: MetricDefinition; groupKey: GroupKey }) {
  // Memoised because it is an effect DEPENDENCY: orderCohortGroups returns a new array every
  // call, so an unmemoised value tore down and rebuilt the ResizeObserver on every render and
  // redrew the canvas with it.
  const canvas = useRef<HTMLCanvasElement>(null); const ordered = useMemo(() => orderCohortGroups(groups, groupKey.value_kind), [groups, groupKey.value_kind])
  useLayoutEffect(() => { const element = canvas.current; if (!element) return; const render = () => drawChart(element, ordered, metric); render(); const observer = new ResizeObserver(render); observer.observe(element); return () => observer.disconnect() }, [metric, ordered])
  return <section className="space-y-3 rounded-lg border border-border-subtle bg-white p-4 shadow-card">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3"><div><h3 className="text-base font-semibold text-agni-ink">{metric.label} by {groupKey.label}</h3><p className="text-sm text-agni-slate">Distribution from cohort quartiles. Y: {metric.unit || 'unitless'}{metric.log_scale ? ' (log scale)' : ''}.</p></div><span className="text-xs text-agni-slate">{ordered.length} groups</span></div>
    <canvas ref={canvas} className="h-[300px] w-full" aria-label={`${metric.label} distribution by ${groupKey.label}`} />
    <p className="text-xs text-agni-slate">Hatched boxes have n ≤ {SMALL_N}; their distribution is shown but deliberately does not read like a well-supported cohort. An amber ! marks a group where non-confirmed grouping-key provenance exceeds confirmed provenance.</p>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{ordered.map((group, index) => { const balanced = isLedgerBalanced(group); return <article key={`${group.group_value}-${index}`} className={`rounded border p-3 text-sm ${balanced ? 'border-border-subtle' : 'border-[#B3261E] bg-[#FFF7F6]'}`}><div className="flex items-baseline justify-between gap-2"><h4 className="font-medium text-agni-ink">{label(group)}</h4><span className="num text-agni-slate">n = {count(group.n_with_metric)}</span></div><p className="mt-1 text-xs text-agni-slate">Members {count(group.n_members)} · no metric row {count(group.n_no_metric_row)} · refused {count(group.n_refused)}</p>{undrawableReason(group, metric.log_scale) && <p className="mt-1 text-xs text-agni-slate">No box drawn: {undrawableReason(group, metric.log_scale)}.</p>}{balanced ? <p className="mt-1 text-xs text-agni-slate">Ledger balances.</p> : <p className="mt-1 text-xs font-medium text-[#B3261E]">Ledger does not balance: API/database disagreement. Distribution is not trustworthy.</p>}<p className={`mt-2 text-xs ${nonConfirmed(group) ? 'font-medium text-[#9A6700]' : 'text-agni-slate'}`}>Grouping-key provenance: {provenanceSummaryText(group)}</p></article> })}</div>
  </section>
}

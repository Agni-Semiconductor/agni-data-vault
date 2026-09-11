import { useLayoutEffect, useMemo, useRef } from 'react'
import { TRACE_COLORS } from '../../plot/panelData'
import { fmtSci } from '../../plot/plotProfiles'
import { bandHalfWidth, correlationR, exclusionNotes, fitBand, innerLedgerBalances, noFitReason, outerLedgerBalances, slopeText } from './fit'
import type { CorrelationResult, GroupKey, MetricDefinition } from '../../lib/cohorts'

/**
 * E5's continuous view: a metric against a continuous grouping key, with the fit the database
 * computed.
 *
 * THE FIT IS NOT RECOMPUTED HERE, and that is the point of the shape the API returns. The
 * scatter can be thinned to 2,000 marks; the fit is always over every member. Refitting on what
 * arrived would silently draw a different line than the slope printed beneath it.
 *
 * The y axis follows `metric.log_scale` and so does the fit, which is why `fit_space` is printed
 * on the chart rather than assumed: a slope of 0.1 means "a tenth of a decade per nm" in log
 * space and "0.1 volts per nm" in raw space, and nothing in the number itself says which.
 */
const GRID = '#E8E8EC'
const CONFIRMED = TRACE_COLORS[0]

function drawChart(canvas: HTMLCanvasElement, result: CorrelationResult, metric: MetricDefinition, groupKey: GroupKey) {
  const width = canvas.clientWidth; const height = 340; if (!width) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
  const ctx = canvas.getContext('2d'); if (!ctx) return
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height); ctx.font = '11px IBM Plex Sans'
  const left = 64, right = 16, top = 16, bottom = 46
  const plotW = width - left - right, plotH = height - top - bottom
  const log = metric.log_scale
  const points = result.points

  // The extent must cover the BAND as well as the points: a band that runs off the top of its own
  // axis looks like a tighter interval than it is.
  const xs = points.map((p) => p.x)
  let xLo = Math.min(...xs), xHi = Math.max(...xs)
  if (!Number.isFinite(xLo) || !Number.isFinite(xHi)) { xLo = 0; xHi = 1 } else if (xLo === xHi) { xLo -= 1; xHi += 1 }
  const band = fitBand(result, xLo, xHi)
  const toY = (v: number) => log ? Math.log10(v) : v
  const ys = [...points.map((p) => p.y), ...band.flatMap((b) => [b.lo, b.hi, b.y])]
    .filter((v) => Number.isFinite(v) && (!log || v > 0)).map(toY)
  let yLo = Math.min(...ys), yHi = Math.max(...ys)
  if (!Number.isFinite(yLo) || !Number.isFinite(yHi)) { yLo = 0; yHi = 1 } else if (yLo === yHi) { yLo -= 1; yHi += 1 }
  const padX = (xHi - xLo) * 0.05, padY = (yHi - yLo) * 0.08
  xLo -= padX; xHi += padX; yLo -= padY; yHi += padY
  const px = (v: number) => left + (v - xLo) / (xHi - xLo) * plotW
  const py = (v: number) => top + (yHi - toY(v)) / (yHi - yLo) * plotH

  ctx.strokeStyle = GRID; ctx.fillStyle = '#667085'; ctx.textAlign = 'right'
  for (let tick = 0; tick <= 4; tick += 1) {
    const t = yLo + (yHi - yLo) * tick / 4, y = top + plotH - plotH * tick / 4
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke()
    ctx.fillText(fmtSci(log ? 10 ** t : t, log), left - 6, y + 4)
  }
  ctx.textAlign = 'center'
  for (let tick = 0; tick <= 4; tick += 1) {
    const t = xLo + (xHi - xLo) * tick / 4, x = left + plotW * tick / 4
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotH); ctx.strokeStyle = GRID; ctx.stroke()
    ctx.fillText(fmtSci(t, false), x, top + plotH + 16)
  }
  ctx.fillStyle = '#344054'
  ctx.fillText(`${groupKey.label}${groupKey.unit ? ` (${groupKey.unit})` : ''}`, left + plotW / 2, top + plotH + 34)
  ctx.save(); ctx.translate(14, top + plotH / 2); ctx.rotate(-Math.PI / 2)
  ctx.fillText(`${metric.label} (${metric.unit || 'unitless'})${log ? ', log' : ''}`, 0, 0); ctx.restore()

  // Band first, so points and line sit ON it rather than under it.
  if (band.length) {
    ctx.beginPath()
    band.forEach((b, i) => { const x = px(b.x), y = py(b.hi); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
    for (let i = band.length - 1; i >= 0; i -= 1) ctx.lineTo(px(band[i].x), py(band[i].lo))
    ctx.closePath(); ctx.fillStyle = 'rgba(0,114,178,.12)'; ctx.fill()
    ctx.beginPath()
    band.forEach((b, i) => { const x = px(b.x), y = py(b.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
    ctx.strokeStyle = CONFIRMED; ctx.lineWidth = 2; ctx.stroke()
  }

  for (const point of points) {
    if (log && !(point.y > 0)) continue
    ctx.beginPath(); ctx.arc(px(point.x), py(point.y), 2.6, 0, Math.PI * 2)
    ctx.fillStyle = point.status === 'confirmed' ? 'rgba(0,114,178,.75)' : 'rgba(230,159,0,.8)'
    ctx.fill()
  }
}

export function CorrelationChart({ result, metric, groupKey }: {
  result: CorrelationResult
  metric: MetricDefinition
  groupKey: GroupKey
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const element = canvas.current; if (!element) return
    const render = () => drawChart(element, result, metric, groupKey)
    render(); const observer = new ResizeObserver(render); observer.observe(element)
    return () => observer.disconnect()
  }, [groupKey, metric, result])

  const notes = useMemo(() => exclusionNotes(result), [result])
  const reason = noFitReason(result)
  const ledger = result.ledger
  const balanced = outerLedgerBalances(ledger) && innerLedgerBalances(ledger)
  const r = result.fit ? correlationR(result.fit) : null
  // Reported at the mean of x, where it is narrowest -- and SAID to be, because quoting the
  // narrowest point of a band without saying where it was measured overstates the fit.
  const half = result.fit ? bandHalfWidth(result.fit, result.fit.avg_x) : Number.NaN

  return <section className="space-y-3 rounded-lg border border-border-subtle bg-white p-4 shadow-card">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <div>
        <h3 className="text-base font-semibold text-agni-ink">{metric.label} vs {groupKey.label}</h3>
        <p className="text-sm text-agni-slate">
          {result.fit
            ? <>Ordinary least squares on {result.fit_space === 'log10_y' ? <strong>log<sub>10</sub> of {metric.label}</strong> : <strong>raw values</strong>}, over n = {result.fit.n}. Shaded band is the 95% interval for the mean response.</>
            : <>No fit: {reason}.</>}
        </p>
      </div>
      {result.fit && <span className="num text-xs text-agni-slate">R² {result.fit.r2.toFixed(3)} · r {r!.toFixed(3)}</span>}
    </div>

    <canvas ref={canvas} className="h-[340px] w-full" aria-label={`${metric.label} against ${groupKey.label}, ${result.fit ? `${result.ledger.n_fit} points with a fitted line` : 'no fit'}`} />

    {result.fit && <p className="text-sm text-agni-ink">Slope {slopeText(result)}{Number.isFinite(half) && <span className="text-agni-slate"> · band half-width {half.toPrecision(2)} {result.fit_space === 'log10_y' ? 'decades' : result.y_unit || ''} at the mean x, widening towards both ends</span>}</p>}

    {/* The fit space is stated on the chart, not only in a tooltip: a slope read in the wrong
        space is wrong by orders of magnitude and looks entirely plausible. */}
    <p className="text-xs text-agni-slate">
      x is always fitted raw; only y is transformed, and only when the metric is declared log-scale.
      {result.points_sampled && <> The scatter shows {result.points_returned.toLocaleString()} of {Number(ledger.n_fit).toLocaleString()} fitted points, thinned evenly across the x range — <strong>the fit itself used all {Number(ledger.n_fit).toLocaleString()}</strong>.</>}
      {' '}Amber points are measurements whose <em>{groupKey.label}</em> was not confirmed.
    </p>

    {/* No p-value, and saying so is better than leaving a reader to wonder whether it was
        forgotten. A cohort is whatever matched a predicate, not a random sample. */}
    <p className="text-xs text-agni-slate">No p-value is reported: a cohort is whatever matched the predicate rather than a random sample, so a significance test over it would claim more than the data supports. Judge it from n, R² and the slope&rsquo;s standard error.</p>

    <div className={`rounded border p-3 text-sm ${balanced ? 'border-border-subtle' : 'border-[#B3261E] bg-[#FFF7F6]'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium text-agni-ink">Every member accounted for</h4>
        <span className="num text-xs text-agni-slate">{Number(ledger.n_members).toLocaleString()} matched · {Number(ledger.n_fit).toLocaleString()} fitted</span>
      </div>
      {notes.length > 0
        ? <ul className="mt-1 list-inside list-disc text-xs text-agni-slate">{notes.map((note) => <li key={note}>{note}</li>)}</ul>
        : <p className="mt-1 text-xs text-agni-slate">Nothing was excluded.</p>}
      {!balanced && <p className="mt-2 text-xs font-medium text-[#B3261E]">The ledger does not balance: the API and the database disagree about this population. Treat the fit as untrustworthy.</p>}
    </div>
  </section>
}

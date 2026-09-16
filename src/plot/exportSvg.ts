// Vector export for figures, rendered CLIENT-SIDE. Decision taken 2026-09-11.
//
// uPlot draws to a canvas, so a PNG is all it can give; a journal wants vector. The two ways to
// get one were a server-side matplotlib render (consistent with campaign_analysis.py, and it
// would also buy headless report generation) and this. Client-side was chosen, and the reason it
// is defensible is the one property matplotlib could not have given: THE SAME RESOLVED DATA
// DRAWS BOTH. `resolvePanel` has already applied the unit conversions, the transforms, the
// decimation and the refusals; this module receives that result and nothing else, so an exported
// figure cannot disagree with the screen about what was plotted, what was converted, or what was
// thrown away. A second renderer in a second language reading the source files again could.
//
// It is NOT a screenshot. Ticks are generated here rather than copied off the canvas, so tick
// PLACEMENT may differ from the screen; the axis ranges and every plotted point do not. That is
// the right trade for a publication export, where tick density is something you want to control
// rather than inherit from whatever width the browser window happened to be.
//
// WHAT MUST NOT BE LOST. A decimated trace and a refused trace are both facts about the figure,
// not UI chrome: a reader of the exported SVG has no badge to hover. Both are rendered into the
// figure's own footer, for the same reason campaign_analysis.py annotates its off-scale counts
// rather than clipping silently.
import type { ResolvedPanel, ResolvedTrace } from './resolveTraces'
import { TRACE_COLORS, conversionBadgeText, decimationBadgeText, refusalText } from './panelData'
import { fmtNum, fmtSci } from './plotProfiles'

export type SvgPanel = { panel: ResolvedPanel; title?: string; xLabel?: string; yLabel?: string }
export type SvgFigureOptions = {
  title?: string
  subtitle?: string
  /** Physical size of the exported file. A figure with no physical size is a figure someone has to rescale, and rescaling is where a 6pt font comes from. */
  widthMm?: number
  heightMm?: number
  /** Grid, as the figure spec writes it: '1x1', '2x2', '2x1' (rows x cols). */
  layout?: string
  fontFamily?: string
}

/** XML-escape. Trace labels are user text and a bare `&` makes the file unopenable. */
export const esc = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export function parseLayout(layout: string | undefined, panelCount: number): { rows: number; cols: number } {
  const match = /^(\d+)x(\d+)$/.exec((layout ?? '').trim())
  const rows = match ? Number(match[1]) : 0
  const cols = match ? Number(match[2]) : 0
  // A layout too small for its panels would DROP them, and a figure that silently loses a panel
  // is worse than one that looks slightly wrong. Grow the grid instead.
  if (rows > 0 && cols > 0 && rows * cols >= panelCount) return { rows, cols }
  const wide = Math.ceil(Math.sqrt(Math.max(1, panelCount)))
  return { rows: Math.ceil(Math.max(1, panelCount) / wide), cols: wide }
}

/**
 * "Nice" ticks: 1, 2, 2.5 or 5 times a power of ten, inside [lo, hi].
 *
 * Returned in DATA space. For a log axis the caller passes log10 bounds and gets decade ticks,
 * which is what a log axis should have -- an evenly spaced linear tick set on a log scale
 * produces labels like 1.7e-9 that nobody reads.
 */
export function niceTicks(lo: number, hi: number, target = 5, decadesOnly = false): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return []
  const raw = (hi - lo) / Math.max(1, target)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalised = raw / magnitude
  const stepBase = decadesOnly ? 1 : normalised > 5 ? 10 : normalised > 2.5 ? 5 : normalised > 2 ? 2.5 : normalised > 1 ? 2 : 1
  const step = Math.max(decadesOnly ? 1 : Number.MIN_VALUE, stepBase * magnitude)
  const out: number[] = []
  // Rounded at each step rather than accumulated: 0.1 added thirty times is 3.0000000000000004,
  // and that reaches a tick label.
  const first = Math.ceil(lo / step) * step
  for (let i = 0; first + i * step <= hi + step * 1e-9; i += 1) {
    const value = Number((first + i * step).toPrecision(12))
    if (value >= lo - step * 1e-9) out.push(value)
    if (out.length > 200) break
  }
  return out
}

const PLOT = { left: 62, right: 14, top: 26, bottom: 44 }

function panelSvg(item: SvgPanel, x0: number, y0: number, width: number, height: number, font: string): string {
  const { panel } = item
  const plotW = width - PLOT.left - PLOT.right
  const plotH = height - PLOT.top - PLOT.bottom
  const [xLo, xHi] = panel.xRange
  const log = panel.log_y
  // On a log axis the range is in LINEAR units and must be mapped through log10. A non-positive
  // bound there is not representable, and clamping it to something positive would move the axis
  // without saying so -- so the panel renders its frame and no line, which is visible.
  const yLo = log ? Math.log10(panel.yRange[0]) : panel.yRange[0]
  const yHi = log ? Math.log10(panel.yRange[1]) : panel.yRange[1]
  const drawable = Number.isFinite(xLo) && Number.isFinite(xHi) && xHi > xLo && Number.isFinite(yLo) && Number.isFinite(yHi) && yHi > yLo
  const px = (v: number) => x0 + PLOT.left + (v - xLo) / (xHi - xLo) * plotW
  const py = (v: number) => y0 + PLOT.top + (yHi - (log ? Math.log10(v) : v)) / (yHi - yLo) * plotH

  const parts: string[] = []
  parts.push(`<g font-family="${esc(font)}" font-size="10">`)
  if (item.title) parts.push(`<text x="${x0 + PLOT.left}" y="${y0 + 16}" font-size="12" font-weight="600" fill="#101828">${esc(item.title)}</text>`)

  if (drawable) {
    const xTicks = niceTicks(xLo, xHi, 5)
    const yTicks = niceTicks(yLo, yHi, 5, log)
    for (const tick of xTicks) {
      const x = px(tick)
      parts.push(`<line x1="${x.toFixed(2)}" y1="${y0 + PLOT.top}" x2="${x.toFixed(2)}" y2="${y0 + PLOT.top + plotH}" stroke="#E8E8EC" stroke-width="0.5"/>`)
      parts.push(`<text x="${x.toFixed(2)}" y="${y0 + PLOT.top + plotH + 14}" text-anchor="middle" fill="#667085">${esc(fmtNum(tick))}</text>`)
    }
    for (const tick of yTicks) {
      const value = log ? 10 ** tick : tick
      const y = py(value)
      parts.push(`<line x1="${x0 + PLOT.left}" y1="${y.toFixed(2)}" x2="${x0 + PLOT.left + plotW}" y2="${y.toFixed(2)}" stroke="#E8E8EC" stroke-width="0.5"/>`)
      parts.push(`<text x="${x0 + PLOT.left - 6}" y="${(y + 3.5).toFixed(2)}" text-anchor="end" fill="#667085">${esc(fmtSci(value, log))}</text>`)
    }
  }
  parts.push(`<rect x="${x0 + PLOT.left}" y="${y0 + PLOT.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#888894" stroke-width="0.8"/>`)

  if (drawable) {
    // Clipped to the frame. A trace whose range was pinned by another panel would otherwise draw
    // across the axis labels and out of the figure.
    const clipId = `clip-${Math.round(x0)}-${Math.round(y0)}`
    parts.push(`<clipPath id="${clipId}"><rect x="${x0 + PLOT.left}" y="${y0 + PLOT.top}" width="${plotW}" height="${plotH}"/></clipPath>`)
    parts.push(`<g clip-path="url(#${clipId})">`)
    panel.traces.forEach((trace, index) => {
      parts.push(`<path d="${pathFor(trace, px, py, log)}" fill="none" stroke="${TRACE_COLORS[index % TRACE_COLORS.length]}" stroke-width="1.2" stroke-linejoin="round"/>`)
    })
    parts.push('</g>')
  } else {
    // Stated, never blank. "A missing file is indistinguishable from a crash" is the rule the
    // bench viewer's empty-state panels already follow, and an exported figure has no console.
    parts.push(`<text x="${x0 + PLOT.left + plotW / 2}" y="${y0 + PLOT.top + plotH / 2}" text-anchor="middle" fill="#667085">no plottable points in range</text>`)
  }

  const axisUnit = panel.unit
  parts.push(`<text x="${x0 + PLOT.left + plotW / 2}" y="${y0 + height - 8}" text-anchor="middle" fill="#344054">${esc(item.xLabel ?? 'x')}</text>`)
  const yText = item.yLabel ?? (axisUnit ? `y (${axisUnit})${log ? ', log' : ''}` : `y${log ? ', log' : ''}`)
  parts.push(`<text transform="translate(${x0 + 14} ${y0 + PLOT.top + plotH / 2}) rotate(-90)" text-anchor="middle" fill="#344054">${esc(yText)}</text>`)

  // Legend inside the frame, top-right: a legend in a separate box gets cropped out when someone
  // places the figure in a document.
  panel.traces.forEach((trace, index) => {
    const ly = y0 + PLOT.top + 12 + index * 13
    const lx = x0 + PLOT.left + plotW - 8
    parts.push(`<rect x="${lx - 92}" y="${ly - 7}" width="9" height="9" fill="${TRACE_COLORS[index % TRACE_COLORS.length]}"/>`)
    parts.push(`<text x="${lx - 79}" y="${ly + 1}" fill="#344054">${esc(trace.label)}</text>`)
  })
  parts.push('</g>')
  return parts.join('\n')
}

/**
 * One `<path>` per trace, with nulls BREAKING it rather than being skipped over.
 *
 * `spanGaps: false` on screen; the same here. A null is a point the transform refused (a
 * non-positive value under log10, say) and bridging it draws a straight segment through a region
 * where nothing was measured — a line a reader will take as data.
 */
function pathFor(trace: ResolvedTrace, px: (v: number) => number, py: (v: number) => number, log: boolean): string {
  const out: string[] = []
  let pen = false
  for (let i = 0; i < trace.x.length; i += 1) {
    const y = trace.y[i]
    if (y === null || y === undefined || !Number.isFinite(y) || (log && y <= 0)) { pen = false; continue }
    const command = pen ? 'L' : 'M'
    out.push(`${command}${px(trace.x[i]).toFixed(2)},${py(y).toFixed(2)}`)
    pen = true
  }
  return out.join(' ')
}

/** Footnotes that must survive the export: what was converted, what was thinned, what was refused. */
export function figureNotes(panels: SvgPanel[]): string[] {
  const notes: string[] = []
  panels.forEach((item, index) => {
    const where = panels.length > 1 ? `Panel ${index + 1}: ` : ''
    for (const trace of item.panel.traces) {
      const conversion = conversionBadgeText(trace)
      if (conversion) notes.push(`${where}${conversion}`)
      const decimated = decimationBadgeText(trace)
      if (decimated) notes.push(`${where}${trace.label} ${decimated}`)
    }
    for (const refusal of item.panel.refusals) notes.push(`${where}refused — ${refusalText(refusal)}`)
  })
  return notes
}

export function figureToSvg(panels: SvgPanel[], options: SvgFigureOptions = {}): string {
  const font = options.fontFamily ?? 'IBM Plex Sans, Helvetica, Arial, sans-serif'
  const { rows, cols } = parseLayout(options.layout, panels.length)
  const cellW = 420, cellH = 300
  const headerH = options.title || options.subtitle ? 46 : 10
  const notes = figureNotes(panels)
  const footerH = 22 + notes.length * 12
  const width = cols * cellW
  const height = headerH + rows * cellH + footerH

  const body: string[] = []
  body.push(`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`)
  if (options.title) body.push(`<text x="16" y="24" font-family="${esc(font)}" font-size="16" font-weight="600" fill="#95001A">${esc(options.title)}</text>`)
  if (options.subtitle) body.push(`<text x="16" y="${options.title ? 40 : 24}" font-family="${esc(font)}" font-size="11" fill="#888894">${esc(options.subtitle)}</text>`)
  panels.forEach((item, index) => {
    body.push(panelSvg(item, (index % cols) * cellW, headerH + Math.floor(index / cols) * cellH, cellW, cellH, font))
  })
  const footerTop = headerH + rows * cellH + 14
  body.push(`<text x="16" y="${footerTop}" font-family="${esc(font)}" font-size="10" fill="#888894">Agni Data Vault</text>`)
  notes.forEach((note, index) => {
    body.push(`<text x="16" y="${footerTop + 12 * (index + 1)}" font-family="${esc(font)}" font-size="9" fill="#888894">${esc(note)}</text>`)
  })

  // A physical size, so the figure lands in a document at the size its author chose rather than
  // at whatever the importing application guesses. viewBox keeps it scalable regardless.
  const mmW = options.widthMm ?? Math.round(width / 4)
  const mmH = options.heightMm ?? Math.round(mmW * height / width)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mmW}mm" height="${mmH}mm" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${esc(options.title ?? 'Figure')}</title>`,
    ...body,
    '</svg>',
  ].join('\n')
}

export function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.download = filename; anchor.href = url; anchor.click()
  URL.revokeObjectURL(url)
}

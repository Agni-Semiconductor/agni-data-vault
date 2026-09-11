import { useCallback, useMemo, useRef, useState } from 'react'
import { XBAR, HIT_WIDTH, strokeFor, tooltipFor, type LineRamp, type LineStat } from './crossbarGeometry'

/**
 * The crossbar: the same lines as the rate bars, drawn where they physically cross.
 *
 * The coverage map answers "did this run measure that cell". This answers "where on the die is
 * the fault" — a bad word line is a stripe, a bad corner is a block, and a cell is visibly the
 * intersection of the two lines that made it. Neither replaces the other and both read the same
 * payload.
 *
 * Ported from fed_viewer's hand-built `createElementNS` version. That one diffed each node's
 * stroke and class by hand because it had to; React reconciles, so the same behaviour is a
 * memoised geometry pass plus className changes. The saving is real and it is only in the
 * plumbing — every decision below is the original's, and each one is load-bearing.
 */

type Selection = { family: 'wl' | 'bl'; line: number } | null

export function Crossbar({ rows, cols, ramp, dark = false, onSelect }: {
  rows: LineStat[]
  cols: LineStat[]
  ramp: LineRamp
  dark?: boolean
  onSelect?: (selection: Selection) => void
}) {
  const [selected, setSelected] = useState<Selection>(null)
  const [hovered, setHovered] = useState<Selection>(null)
  const host = useRef<SVGSVGElement>(null)
  const palette = dark ? ramp.dark : ramp.light

  // Geometry once per array size. The original rebuilt its nodes only when the run changed, for
  // the same reason: recomputing 256 wires on every hover is the difference between a chart and
  // a slideshow.
  const geometry = useMemo(() => {
    const nRows = rows.length || 128, nCols = cols.length || 128
    const w = Math.max(1, nCols - 1), h = Math.max(1, nRows - 1)
    const span = Math.max(w, h) || 1
    const edge = span * XBAR.margin + 1
    return { nRows, nCols, w, h, span, edge, tick: span * XBAR.tick, axis: span * XBAR.axis, ring: span * XBAR.ring,
      viewBox: [-edge, -edge, w + 2 * edge, h + 2 * edge].join(' ') }
  }, [rows.length, cols.length])

  const choose = useCallback((next: Selection) => {
    setSelected((current) => {
      const same = current && next && current.family === next.family && current.line === next.line
      const value = same ? null : next      // clicking the selected wire clears it
      onSelect?.(value)
      return value
    })
  }, [onSelect])

  const active = hovered ?? selected

  const wires = (family: 'wl' | 'bl', stats: LineStat[]) => stats.map((stat) => {
    const across = family === 'wl'
    const i = stat.line
    const x1 = across ? 0 : i, y1 = across ? i : 0
    const x2 = across ? geometry.w : i, y2 = across ? i : geometry.h
    const isActive = active?.family === family && active.line === i
    const isSelected = selected?.family === family && selected.line === i
    return (
      <g key={`${family}-${i}`}>
        <line x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={strokeFor(stat.rate, palette)}
          strokeWidth={isActive ? geometry.span * 0.006 : geometry.span * 0.0025}
          opacity={active && !isActive ? 0.45 : 1} />
        {/*
          A 2px wire is not a click target. An invisible line ONE FULL PITCH wide is, and it
          carries the tooltip, the hover, the click and the keyboard focus — so all four work
          without making the drawn wire fat enough to lie about how much of the die it covers.
          Stroke must be a real colour with pointer-events, not `none`; `transparent` is both.
        */}
        <line x1={x1} y1={y1} x2={x2} y2={y2}
          stroke="transparent" strokeWidth={HIT_WIDTH}
          tabIndex={0} role="button"
          aria-label={tooltipFor(family, stat)}
          aria-pressed={isSelected}
          className="cursor-pointer outline-none focus-visible:opacity-100"
          onMouseEnter={() => setHovered({ family, line: i })}
          onMouseLeave={() => setHovered(null)}
          onFocus={() => setHovered({ family, line: i })}
          onBlur={() => setHovered(null)}
          onClick={() => choose({ family, line: i })}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose({ family, line: i }) } }}>
          <title>{tooltipFor(family, stat)}</title>
        </line>
      </g>
    )
  })

  const label = active ? tooltipFor(active.family, (active.family === 'wl' ? rows : cols)[active.line]) : null

  return (
    <figure className="space-y-2">
      <svg ref={host} viewBox={geometry.viewBox} className="w-full" style={{ maxHeight: 520 }}
        role="img" aria-label={`Crossbar: ${geometry.nRows} word lines by ${geometry.nCols} bit lines, shaded by failure rate`}>
        <g>{wires('wl', rows)}</g>
        <g>{wires('bl', cols)}</g>

        {/*
          THE CROSSHAIR IS THE FINDING. A cell is the crossing of two lines, so selecting one wire
          and hovering the other shows you the cell they make — which is the whole reason this
          view exists alongside the rate bars, where the two families never meet.
        */}
        {selected && hovered && selected.family !== hovered.family && (() => {
          const wl = selected.family === 'wl' ? selected.line : hovered.line
          const bl = selected.family === 'bl' ? selected.line : hovered.line
          return <circle cx={bl} cy={wl} r={geometry.ring} fill="none" stroke="#F15A2A" strokeWidth={geometry.span * 0.004} />
        })()}

        <g fontSize={geometry.tick} fill="#888894" textAnchor="middle">
          {[0, Math.floor(geometry.nCols / 2), geometry.nCols - 1].map((c) => (
            <text key={`ct-${c}`} x={c} y={geometry.h + geometry.edge * 0.55}>{c}</text>
          ))}
          {[0, Math.floor(geometry.nRows / 2), geometry.nRows - 1].map((r) => (
            <text key={`rt-${r}`} x={-geometry.edge * 0.35} y={r + geometry.tick * 0.35} textAnchor="end">{r}</text>
          ))}
        </g>
        <g fontSize={geometry.axis} fill="#344054" textAnchor="middle">
          <text x={geometry.w / 2} y={geometry.h + geometry.edge * 0.95}>bit line</text>
          <text transform={`translate(${-geometry.edge * 0.8}, ${geometry.h / 2}) rotate(-90)`}>word line</text>
        </g>
      </svg>

      {/* The readout is always present, empty or not: a caption that appears and disappears
          under the cursor makes the figure jump, and a figure that jumps gets misread. */}
      <figcaption className="min-h-5 font-mono text-xs text-agni-slate">{label ?? 'Hover or focus a wire. Select one, then hover the other family to mark the cell they make.'}</figcaption>
    </figure>
  )
}

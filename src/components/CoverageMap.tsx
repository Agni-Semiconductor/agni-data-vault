import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'

export type CoverageTheme = 'light' | 'dark'
export type CoverageCell = readonly [row: number, col: number, code: number]
export interface CoveragePayload { dut_id: string; run_id: string; rows: number; cols: number; total: number; counts: Record<string, number>; cells: CoverageCell[]; legend: Record<string, string>; colors: Record<CoverageTheme, Record<string, string>>; verdict_codes: Record<string, number> }
export interface CoverageMapProps { coverage: CoveragePayload; onCellClick?: (cell: CoverageCell | null) => void; className?: string; theme?: CoverageTheme }
export interface ClientRect { left: number; top: number; width: number; height: number }

/** Produces the sparse-cell lookup key without conflating adjacent rows. */
export const cellIndex = (row: number, col: number) => row * 100000 + col
export const projectClientPoint = (clientX: number, clientY: number, rect: ClientRect, rows: number, cols: number): { row: number; col: number } | null => {
  if (rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientY < rect.top || clientX >= rect.left + rect.width || clientY >= rect.top + rect.height) return null
  return { row: Math.floor((clientY - rect.top) * rows / rect.height), col: Math.floor((clientX - rect.left) * cols / rect.width) }
}
export const colorForCode = (colors: CoveragePayload['colors'], legend: CoveragePayload['legend'], theme: CoverageTheme, code: number) => {
  const label = legend[String(code)]
  return label ? colors[theme]?.[label] : undefined
}

const cellDescription = (position: { row: number; col: number }, cells: Map<number, CoverageCell>, legend: CoveragePayload['legend']) => {
  const cell = cells.get(cellIndex(position.row, position.col))
  return `Row ${position.row}, column ${position.col}: ${cell ? (legend[String(cell[2])] ?? 'unknown') : 'untested'}`
}

export function CoverageMap({ coverage, onCellClick, className, theme: suppliedTheme }: CoverageMapProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [systemTheme, setSystemTheme] = useState<CoverageTheme>('light')
  const [hovered, setHovered] = useState<{ row: number; col: number } | null>(null)
  const [focused, setFocused] = useState({ row: 0, col: 0 })
  const theme = suppliedTheme ?? systemTheme
  const cells = useMemo(() => new Map(coverage.cells.map((cell) => [cellIndex(cell[0], cell[1]), cell])), [coverage.cells])

  useEffect(() => {
    if (suppliedTheme || typeof window === 'undefined') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const updateTheme = () => setSystemTheme(media.matches ? 'dark' : 'light')
    updateTheme(); media.addEventListener('change', updateTheme)
    return () => media.removeEventListener('change', updateTheme)
  }, [suppliedTheme])

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    element.width = coverage.cols; element.height = coverage.rows
    context.clearRect(0, 0, coverage.cols, coverage.rows)
    for (const [row, col, code] of coverage.cells) {
      const color = colorForCode(coverage.colors, coverage.legend, theme, code)
      if (!color) continue
      context.fillStyle = color; context.fillRect(col, row, 1, 1)
    }
  }, [coverage, theme])

  const positionFromEvent = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => projectClientPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), coverage.rows, coverage.cols)
  const select = (position: { row: number; col: number } | null) => onCellClick?.(position ? cells.get(cellIndex(position.row, position.col)) ?? null : null)
  const activePosition = hovered ?? focused
  const activeDescription = cellDescription(activePosition, cells, coverage.legend)
  const moveFocus = (row: number, col: number) => setFocused({ row: Math.max(0, Math.min(coverage.rows - 1, row)), col: Math.max(0, Math.min(coverage.cols - 1, col)) })

  return <div className={clsx('flex flex-col gap-4 sm:flex-row sm:items-start', className)}>
    <div className="min-w-0 flex-1">
      <canvas ref={canvas} width={coverage.cols} height={coverage.rows} tabIndex={0} aria-label={`Coverage map for DUT ${coverage.dut_id}, run ${coverage.run_id}: ${coverage.rows} by ${coverage.cols}; untested cells have no fill.`} className="block w-full cursor-crosshair border border-border-subtle [image-rendering:pixelated]" style={{ aspectRatio: `${coverage.cols} / ${coverage.rows}` }} onPointerMove={(event) => setHovered(positionFromEvent(event))} onPointerLeave={() => setHovered(null)} onClick={(event) => select(positionFromEvent(event))} onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(focused.row - 1, focused.col) }
        else if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(focused.row + 1, focused.col) }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(focused.row, focused.col - 1) }
        else if (event.key === 'ArrowRight') { event.preventDefault(); moveFocus(focused.row, focused.col + 1) }
        else if (event.key === 'Enter') { event.preventDefault(); select(focused) }
      }} />
      <p className="mt-2 text-xs text-agni-slate" aria-live="polite">{activeDescription}</p>
    </div>
    <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-1" aria-label="Coverage map legend">
      {Object.entries(coverage.legend).map(([code, label]) => { const color = colorForCode(coverage.colors, coverage.legend, theme, Number(code)); return <div key={code} className="flex items-center gap-2"><span className="inline-block h-3 w-3 shrink-0 border border-border-subtle" style={color ? { backgroundColor: color } : undefined} /><dt>{label}</dt><dd className="ml-auto font-mono text-agni-slate">{coverage.counts[label] ?? 0}</dd></div> })}
    </dl>
  </div>
}

export default CoverageMap

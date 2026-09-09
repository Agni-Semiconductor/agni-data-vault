import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Badge, Button, Select } from '../components/ui'
import type { ParsedFile, PlotKind } from './parseFile'
import { PROFILES, buildUplotData, decimate, fmtNum, fmtSci, resolveSeries } from './plotProfiles'
import type { ResolvedSeries } from './plotProfiles'

const Y_COLOR = '#F15A2A'
const Y2_COLOR = '#E0B400'
const xUnit = (name: string) => /^(t|time)$/i.test(name) ? 's' : /charge/i.test(name) ? 'C' : /v/i.test(name) ? 'V' : ''

export function QuickPlot({ parsed, kind: givenKind, height = 320, className }: { parsed: ParsedFile; kind?: PlotKind; height?: number; className?: string }) {
  const [kind, setKind] = useState<PlotKind>(givenKind ?? parsed.detected_kind ?? 'other'); const [x, setX] = useState<string>(); const [y, setY] = useState<string>(); const [y2, setY2] = useState<string>(); const [log, setLog] = useState(Boolean(PROFILES[kind].log_y)); const [hover, setHover] = useState<{ x: number; y: number | null }>(); const host = useRef<HTMLDivElement>(null); const chart = useRef<uPlot | null>(null)
  const series = useMemo(() => resolveSeries(parsed, kind, { x, y, y2, log }), [parsed, kind, x, y, y2, log])
  const built = useMemo(() => { const primary = decimate(series.x, series.y); const reduced: ResolvedSeries = series.y2 ? { ...series, x: primary.x, y: primary.y, y2: decimate(series.x, series.y2).y } : { ...series, x: primary.x, y: primary.y }; return buildUplotData(reduced) }, [series])
  const data = built.data
  const caption = log && series.log_y ? `|${series.labels.y}| (A), log` : `${series.labels.y} (A)`
  useEffect(() => { setLog(Boolean(PROFILES[kind].log_y)) }, [kind])
  useEffect(() => {
    const element = host.current
    if (!element || !data[0].length) return
    const unit = xUnit(series.labels.x)
    const create = () => {
      chart.current?.destroy()
      chart.current = new uPlot({
        width: element.clientWidth || 400, height, title: `${kind} · ${series.x.length} points`, legend: { show: false },
        hooks: { setCursor: [(self: uPlot) => { const idx = self.cursor.idx ?? -1; const next = idx >= 0 ? { x: Number(self.data[0][idx]), y: (self.data[1]?.[idx] ?? null) as number | null } : undefined; setHover((prev) => prev?.x === next?.x && prev?.y === next?.y ? prev : next) }] },
        scales: { x: { time: false, auto: false, range: () => built.xRange }, y: { auto: false, distr: log ? 3 : 1, ...(log ? { log: 10 as const } : {}), range: () => built.yRange }, ...(series.y2 ? { y2: { auto: true } } : {}) },
        axes: [
          { stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: unit ? `${series.labels.x} (${unit})` : series.labels.x, values: (_self: uPlot, ticks: number[]) => ticks.map(fmtNum) },
          { stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: caption, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value, log && series.log_y)) },
          ...(series.y2 ? [{ scale: 'y2', side: 1, stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: series.labels.y2, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value)) }] : []),
        ],
        series: [{}, { stroke: Y_COLOR, width: 1.5, points: { show: false }, paths: uPlot.paths.linear!(), spanGaps: false }, ...(series.y2 ? [{ scale: 'y2', stroke: Y2_COLOR, width: 1.5, points: { show: false }, paths: uPlot.paths.linear!(), spanGaps: false }] : [])],
      }, data, element)
    }
    create()
    const observer = new ResizeObserver(() => chart.current?.setSize({ width: element.clientWidth || 400, height }))
    observer.observe(element)
    return () => { observer.disconnect(); chart.current?.destroy(); chart.current = null }
  }, [built, caption, data, height, kind, log, series])
  useEffect(() => { const current = chart.current; if (!current || !data[0].length) return; current.setData(data) }, [data])
  if (!series.x.length) return <p className="text-sm text-agni-slate">No numeric series could be resolved from this file.</p>
  const options = parsed.headers.map((value) => ({ value, label: value }))
  return <div className={clsx('space-y-2', className)}>
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <Select label="Kind" value={kind} onChange={(event) => setKind(event.target.value as PlotKind)} options={Object.keys(PROFILES).map((value) => ({ value, label: value }))} />
      <Select label="X" value={series.labels.x} onChange={(event) => setX(event.target.value)} options={options} />
      <Select label="Y" value={series.labels.y} onChange={(event) => setY(event.target.value)} options={options} />
      {series.y2 && <Select label="Y2" value={series.labels.y2} onChange={(event) => setY2(event.target.value)} options={options} />}
      <Button type="button" variant="secondary" onClick={() => setLog((value) => !value)}>{log ? 'Log Y' : 'Linear Y'}</Button>
      <Badge tone={series.log_y && log ? 'amber' : 'blue'}>{caption}</Badge>
      {series.x.length > 5000 && <Badge tone="amber">decimated</Badge>}
    </div>
    <div ref={host} className="relative overflow-hidden" style={{ height }} />
    <div className="flex flex-wrap gap-4 text-xs text-agni-slate">
      <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: Y_COLOR }} />{series.labels.y}</span>
      {series.y2 && <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: Y2_COLOR }} />{series.labels.y2}</span>}
      <span>{caption}</span>
      {hover && Number.isFinite(hover.x) && <span>x {fmtSci(hover.x)} · y {hover.y === null ? '—' : fmtSci(hover.y, log && series.log_y)}</span>}
    </div>
  </div>
}

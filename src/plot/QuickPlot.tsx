import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Badge, Button, Select } from '../components/ui'
import type { ParsedFile, PlotKind } from './parseFile'
import { PROFILES, buildUplotData, decimate, fmtNum, fmtSci, resolveSeries } from './plotProfiles'
import type { ResolvedSeries } from './plotProfiles'
const Y_COLOR = '#F15A2A'; const Y2_COLOR = '#E0B400'
const xUnit = (name: string) => /^(t|time)$/i.test(name) ? 's' : /charge/i.test(name) ? 'C' : /v/i.test(name) ? 'V' : ''
export function QuickPlot({ parsed, kind: givenKind, height: givenHeight, className, compact = false }: { parsed: ParsedFile; kind?: PlotKind; height?: number; className?: string; compact?: boolean }) {
  const height = givenHeight ?? (compact ? 176 : 320)
  const [kind, setKind] = useState<PlotKind>(givenKind ?? parsed.detected_kind ?? 'other'); const [x, setX] = useState<string>(); const [y, setY] = useState<string>(); const [y2, setY2] = useState<string>(); const [log, setLog] = useState(Boolean(PROFILES[kind].log_y)); const [hover, setHover] = useState<{ x: number; y: number | null }>(); const host = useRef<HTMLDivElement>(null); const chart = useRef<uPlot | null>(null)
  const series = useMemo(() => resolveSeries(parsed, kind, { x, y, y2, log }), [parsed, kind, x, y, y2, log])
  const built = useMemo(() => { const primary = decimate(series.x, series.y); const reduced: ResolvedSeries = series.y2 ? { ...series, x: primary.x, y: primary.y, y2: decimate(series.x, series.y2).y } : { ...series, x: primary.x, y: primary.y }; return buildUplotData(reduced) }, [series])
  const data = built.data; const caption = log && series.log_y ? `|${series.labels.y}| (A), log` : `${series.labels.y} (A)`
  useEffect(() => { setLog(Boolean(PROFILES[kind].log_y)) }, [kind])
  useLayoutEffect(() => {
    const element = host.current; if (!element || !data[0].length) return
    const unit = xUnit(series.labels.x)
    const create = () => { const width = element.clientWidth; if (width <= 0) return; chart.current?.destroy(); chart.current = new uPlot({
      width, height, title: `${kind} · ${series.x.length} points`, legend: { show: false }, cursor: { show: !compact },
      ...(!compact ? { hooks: { setCursor: [(self: uPlot) => { const idx = self.cursor.idx ?? -1; const next = idx >= 0 ? { x: Number(self.data[0][idx]), y: (self.data[1]?.[idx] ?? null) as number | null } : undefined; setHover((previous) => previous?.x === next?.x && previous?.y === next?.y ? previous : next) }] } } : {}),
      scales: { x: { time: false, auto: false, range: () => built.xRange }, y: { auto: false, distr: log ? 3 : 1, ...(log ? { log: 10 as const } : {}), range: () => built.yRange }, ...(series.y2 ? { y2: { auto: true } } : {}) },
      axes: compact ? [
        { size: 26, stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '10px "IBM Plex Sans"', labelSize: 0, ticks: { size: 4 }, incrs: [1, 2, 5, 10, 20, 50, 100], values: (_self: uPlot, ticks: number[]) => ticks.map((value, index) => index % Math.max(1, Math.ceil(ticks.length / 5)) === 0 ? fmtNum(value) : '') },
        { size: 44, stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '10px "IBM Plex Sans"', labelSize: 0, ticks: { size: 4 }, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value, log && series.log_y)) },
        ...(series.y2 ? [{ scale: 'y2', side: 1, size: 44, stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '10px "IBM Plex Sans"', labelSize: 0, ticks: { size: 4 }, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value)) }] : []),
      ] : [
        { stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: unit ? `${series.labels.x} (${unit})` : series.labels.x, values: (_self: uPlot, ticks: number[]) => ticks.map(fmtNum) },
        { stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: caption, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value, log && series.log_y)) },
        ...(series.y2 ? [{ scale: 'y2', side: 1, stroke: '#888894', grid: { stroke: '#E8E8EC' }, font: '11px IBM Plex Sans', label: series.labels.y2, values: (_self: uPlot, ticks: number[]) => ticks.map((value) => fmtSci(value)) }] : []),
      ], padding: compact ? [6, 8, 0, 0] : undefined,
      series: [{}, { stroke: Y_COLOR, width: compact ? 1.25 : 1.5, points: { show: false }, paths: uPlot.paths.linear!(), spanGaps: false }, ...(series.y2 ? [{ scale: 'y2', stroke: Y2_COLOR, width: compact ? 1.25 : 1.5, points: { show: false }, paths: uPlot.paths.linear!(), spanGaps: false }] : [])],
    }, data, element) }
    create(); const observer = new ResizeObserver(() => { const width = element.clientWidth; if (width <= 0) return; if (chart.current) chart.current.setSize({ width, height }); else create() }); observer.observe(element)
    return () => { observer.disconnect(); chart.current?.destroy(); chart.current = null }
  }, [built, caption, compact, data, height, kind, log, series])
  useEffect(() => { const current = chart.current; if (current && data[0].length) current.setData(data) }, [data])
  if (!series.x.length) return <p className="text-sm text-agni-slate">No numeric series could be resolved from this file.</p>
  const options = parsed.headers.map((value) => ({ value, label: value })); const y2Options = [{ value: '', label: '— none —' }, ...options]
  const compactCaption = (kind === 'dciv' || kind === 'board_csv') ? `|${series.labels.y}| (A), log · ${series.x.length} pts` : kind === 'aciv' ? `Imeas vs Vforce · ${series.x.length} pts` : `${series.labels.y} vs ${series.labels.x} · ${series.x.length} pts`
  return <div className={clsx('space-y-2', className)}>
    {!compact && <div className="mb-2 flex flex-wrap items-center gap-2"><Select label="Kind" value={kind} onChange={(event) => setKind(event.target.value as PlotKind)} options={Object.keys(PROFILES).map((value) => ({ value, label: value }))} /><Select label="X" value={series.labels.x} onChange={(event) => setX(event.target.value)} options={options} /><Select label="Y" value={series.labels.y} onChange={(event) => setY(event.target.value)} options={options} /><Select label="Y2" value={series.labels.y2 ?? ''} onChange={(event) => setY2(event.target.value)} options={y2Options} /><Button type="button" variant="secondary" onClick={() => setLog((value) => !value)}>{log ? 'Log Y' : 'Linear Y'}</Button><Badge tone={series.log_y && log ? 'amber' : 'blue'}>{caption}</Badge>{series.x.length > 5000 && <Badge tone="amber">decimated</Badge>}</div>}
    <div ref={host} className="relative min-h-[176px] w-full overflow-hidden" style={{ height }} />
    {compact ? <div className="truncate text-[11px] leading-4 text-agni-slate">{compactCaption}</div> : <div className="flex flex-wrap gap-4 text-xs text-agni-slate"><span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: Y_COLOR }} />{series.labels.y}</span>{series.y2 && <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: Y2_COLOR }} />{series.labels.y2}</span>}<span>{caption}</span>{hover && Number.isFinite(hover.x) && <span>x {fmtSci(hover.x)} · y {hover.y === null ? '—' : fmtSci(hover.y, log && series.log_y)}</span>}</div>}
  </div>
}

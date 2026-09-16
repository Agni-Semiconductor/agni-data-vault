import { useLayoutEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import uPlot from 'uplot'
import { Crossbar } from '../../components/Crossbar'
import { getBenchLines } from '../../lib/bench'
import { themeColor, useTheme } from '../../theme/useTheme'

type Line = { line: number; measured: number; bad: number; rate: number | null; net?: string; pin?: string }
type LineData = { rows: Line[]; cols: Line[]; ramp: { light: string[]; dark: string[] } }

const fmtRate = (rate: number) => `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 2 : 1)}%`

function rateColor(rate: number | null, ramp: string[]) {
  if (rate === null) return 'transparent'
  return ramp[Math.min(ramp.length - 1, Math.floor(rate * ramp.length))] ?? ramp[ramp.length - 1]
}

function RateChart({ label, lines, ramp, onSelectLine, resolvedTheme }: {
  label: string
  lines: Line[]
  ramp: string[]
  onSelectLine?: (line: number) => void
  resolvedTheme: 'light' | 'dark'
}) {
  const host = useRef<HTMLDivElement>(null)
  const chart = useRef<uPlot | null>(null)
  const chartInk = themeColor('--chart-ink', '#344054')
  const chartMuted = themeColor('--chart-muted', '#667085')
  const chartGrid = themeColor('--chart-grid', '#E8E8EC')

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const data: [number[], Array<number | null>] = [
      lines.map(({ line }) => line),
      lines.map(({ rate }) => rate),
    ]
    const create = () => {
      const width = element.clientWidth
      if (!width) return
      chart.current?.destroy()
      chart.current = new uPlot({
        width,
        height: 210,
        legend: { show: false },
        cursor: {
          show: true,
          bind: {
            click: (self, _target, handler) => (event) => {
              if (onSelectLine) {
                const line = Math.round(self.posToVal(event.offsetX, 'x'))
                if (lines.some((item) => item.line === line && item.rate !== null)) onSelectLine(line)
              }
              return handler(event)
            },
          },
        },
        scales: { x: { time: false }, y: { auto: false, range: () => [0, 1] } },
        axes: [
          { stroke: chartInk, grid: { stroke: chartGrid }, font: '10px IBM Plex Sans', values: (_self, ticks) => ticks.map(String) },
          { stroke: chartMuted, grid: { stroke: chartGrid }, font: '10px IBM Plex Sans', values: (_self, ticks) => ticks.map(fmtRate) },
        ],
        series: [{}, {
          paths: uPlot.paths.bars!({
            gap: 1,
            disp: {
              fill: {
                unit: 3,
                kind: 2,
                values: (_self, _series, first, last) => lines.slice(first, last + 1).map(({ rate }) => rateColor(rate, ramp)),
              },
            },
          }),
        }],
      }, data, element)
    }
    create()
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth
      if (width) chart.current?.setSize({ width, height: 210 })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      chart.current?.destroy()
      chart.current = null
    }
  }, [chartGrid, chartInk, chartMuted, lines, onSelectLine, ramp, resolvedTheme])

  const measured = lines.filter((line) => line.rate !== null).length
  return (
    <section className="rounded-lg border border-border-subtle bg-white p-4 shadow-card">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-base text-agni-ink">{label}</h3>
        <span className="num text-xs text-agni-slate">{measured}/{lines.length} measured</span>
      </div>
      {!lines.length ? <p className="min-h-[210px] text-sm text-agni-slate">No {label.toLowerCase()} results are available for this run.</p> : !measured ? <p className="min-h-[210px] text-sm text-agni-slate">No {label.toLowerCase()} were measured for this run.</p> : <><RateChartLegend ramp={ramp} /><div className="mt-2 h-[210px] w-full" ref={host} /><p className="mt-2 text-xs text-agni-slate">Unmeasured lines are left blank. Click a bar to filter the cell table.</p></>}
    </section>
  )
}

function RateChartLegend({ ramp }: { ramp: string[] }) {
  return <div className="flex items-center gap-1 text-xs text-agni-slate"><span>failure rate</span>{ramp.map((color, index) => <span key={color} className="h-3 w-5" style={{ background: color }} aria-label={`rate step ${index + 1}`} />)}</div>
}

export function LineRates({ dutId, runId, onSelectLine }: { dutId: string; runId: string; onSelectLine?: (line: number) => void }) {
  const { resolved: resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const query = useQuery({ queryKey: ['bench', 'lines', dutId, runId], queryFn: () => getBenchLines(dutId, runId), enabled: Boolean(dutId && runId) })
  const data = query.data as LineData | undefined

  return <section className="space-y-3">
    <div><h2 className="text-lg">Line failure rates</h2><p className="text-sm text-agni-slate">Each bar is an independent physical wire; blank bars were never measured.</p></div>
    {query.isLoading ? <div className="grid gap-4 xl:grid-cols-2"><p className="min-h-[280px] rounded-lg border border-border-subtle p-4 text-sm text-agni-slate">Loading word-line rates.</p><p className="min-h-[280px] rounded-lg border border-border-subtle p-4 text-sm text-agni-slate">Loading bit-line rates.</p></div> : query.error ? <div className="grid gap-4 xl:grid-cols-2"><p className="min-h-[280px] rounded-lg border border-border-subtle p-4 text-sm text-danger">Could not load word-line rates: {query.error.message}</p><p className="min-h-[280px] rounded-lg border border-border-subtle p-4 text-sm text-danger">Could not load bit-line rates: {query.error.message}</p></div> : <div className="grid gap-4 xl:grid-cols-2"><RateChart label="Word lines" lines={data?.rows ?? []} ramp={data?.ramp[resolvedTheme] ?? []} onSelectLine={onSelectLine} resolvedTheme={resolvedTheme} /><RateChart label="Bit lines" lines={data?.cols ?? []} ramp={data?.ramp[resolvedTheme] ?? []} onSelectLine={onSelectLine} resolvedTheme={resolvedTheme} /></div>}
    {!query.isLoading && !query.error && (data?.rows?.length || data?.cols?.length) ? <section className="rounded-lg border border-border-subtle bg-white p-4 shadow-card"><div className="mb-2 flex items-baseline justify-between gap-3"><h3 className="text-base text-agni-ink">Crossbar</h3><span className="text-xs text-agni-slate">shaded by failure rate; unmeasured wires are grid</span></div><Crossbar rows={data?.rows ?? []} cols={data?.cols ?? []} ramp={data?.ramp ?? { light: [], dark: [] }} dark={dark} onSelect={(selection) => { if (selection && onSelectLine) onSelectLine(selection.line) }} /></section> : null}
  </section>
}

import type uPlot from 'uplot'
import type { ResolvedPanel, ResolvedTrace } from './resolveTraces'

// Pure helpers, in their own module rather than beside the component. Two reasons, and the
// second is the load-bearing one: react-refresh only works when a file exports components
// alone, and there is no testing-library in this repo -- so these functions ARE the test
// surface for FigurePanel, and they must be importable without pulling uPlot into a test.
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

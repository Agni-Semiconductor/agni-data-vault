// The crossbar's pure parts, in their own module rather than beside the component.
//
// Two reasons, the second load-bearing: react-refresh only works when a file exports components
// alone, and there is no testing-library in this repo -- so these ARE the test surface for
// Crossbar, and they must be importable without an SVG.
export type LineStat = { line: number; measured: number; bad: number; rate: number | null; net?: string; pin?: string }
export type LineRamp = { light: string[]; dark: string[] }

/**
 * Decoration is a FRACTION OF THE ARRAY, never a number of grid units.
 *
 * A tick label of "2.6 units" is 8px on a 128×128 viewBox and 50px on a 12-column one — which is
 * how a perfectly correct-looking figure becomes giant letters over a postage stamp the moment
 * somebody analyses a small run. These fractions render at a constant pixel size whatever the
 * array is, because the SVG is laid out at a fixed width either way.
 */
export const XBAR = { margin: 0.06, tick: 0.019, axis: 0.023, ring: 0.024 }
/** One full pitch. A 2px wire is not a click target; see `hit` below. */
export const HIT_WIDTH = 1

/** Grid colour for a line nobody measured. NOT the bottom of the ramp — see `strokeFor`. */
const UNMEASURED = '#E8E8EC'

export function strokeFor(rate: number | null, ramp: string[]): string {
  // An unmeasured line is GRID, not a rate of zero. "We did not look" and "we looked and it was
  // fine" are different statements, and a map that renders them alike turns the first into the
  // second — the same rule that keeps untested cells unpainted on the coverage map.
  if (rate === null || rate === undefined) return UNMEASURED
  const index = Math.min(ramp.length - 1, Math.max(0, Math.floor(rate * ramp.length)))
  return ramp[index] ?? ramp[ramp.length - 1]
}

/** What the tooltip says. Exported because it is the readable half of this component. */
export function tooltipFor(family: 'wl' | 'bl', stat: LineStat): string {
  const name = `${family.toUpperCase()} ${stat.line}`
  const wiring = stat.net || stat.pin ? ` · ${[stat.net, stat.pin && `pin ${stat.pin}`].filter(Boolean).join(' · ')}` : ''
  // "not measured" rather than "0 bad", for the same reason strokeFor uses grid.
  const counts = stat.measured ? ` · ${stat.bad}/${stat.measured} bad` : ' · not measured'
  return name + wiring + counts
}

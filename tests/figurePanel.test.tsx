import { describe, expect, it } from 'vitest'
import { buildPanelData, conversionBadgeText, decimationBadgeText, refusalText } from '../src/plot/panelData'
import type { ResolvedPanel, ResolvedTrace } from '../src/plot/resolveTraces'

const trace = (overrides: Partial<ResolvedTrace> = {}): ResolvedTrace => ({ x: [0, 2], y: [1, null], label: 'current_mA', unit: 'A', factor: 1e-3, points: 6000, decimated: true, ...overrides })
const panel = (overrides: Partial<ResolvedPanel> = {}): ResolvedPanel => ({ traces: [trace(), trace({ x: [1, 2], y: [3, 4], label: 'reference', factor: 1, decimated: false })], refusals: [], unit: 'A', xRange: [0, 2], yRange: [1, 4], log_y: false, ...overrides })

describe('FigurePanel helpers', () => {
  it('gives each trace its own slice of the shared x array', () => {
    // Not a distinct sorted x with y keyed by value. Each trace contributes its own x values in
    // its own order, and is null across every other trace's slice.
    expect(buildPanelData(panel())).toEqual([[0, 2, 1, 2], [1, null, null, null], [null, null, 3, 4]])
  })

  it('A HYSTERESIS LOOP SURVIVES: a repeated x keeps both of its y values', () => {
    // The bug this replaced. A DC-IV sweep runs 0 -> +Vmax -> 0, so almost every voltage appears
    // twice with a different current. Keying y by x in a Map keeps only the last, collapsing the
    // loop to one branch -- and it looks like a perfectly good plot of a device with no
    // hysteresis, which is the entire property being measured.
    const loop = trace({ x: [0, 1, 2, 1, 0], y: [0, 5, 9, 2, 0], label: 'loop', factor: 1, decimated: false })
    const [xs, ys] = buildPanelData({ ...panel(), traces: [loop] })
    expect(xs).toEqual([0, 1, 2, 1, 0])       // order and duplicates intact
    expect(ys).toEqual([0, 5, 9, 2, 0])       // the return leg keeps its own currents
    expect(new Set(xs as number[]).size).toBe(3)  // and it really is a repeated-x sweep
  })

  it('the sweep order is preserved rather than sorted', () => {
    // resolveSeries deliberately keeps unsorted x -- tests/plotProfiles.test.ts pins
    // `expect(s.x).toEqual(volts)` on [-16,-8,-1,0,1,9,18,5]. Sorting here would make the
    // multi-trace path disagree with the single-trace path about the same sweep.
    const volts = [-16, -8, -1, 0, 1, 9, 18, 5]
    const [xs] = buildPanelData({ ...panel(), traces: [trace({ x: volts, y: volts.map(() => 1), factor: 1, decimated: false })] })
    expect(xs).toEqual(volts)
  })

  it('a trace shorter than its x array does not bleed into the next slice', () => {
    const [, first, second] = buildPanelData({ ...panel(), traces: [trace({ x: [0, 1], y: [7], factor: 1, decimated: false }), trace({ x: [9], y: [8], label: 'b', factor: 1, decimated: false })] })
    expect(first).toEqual([7, null, null])
    expect(second).toEqual([null, null, 8])
  })
  it('discloses decimation with the original point count', () => expect(decimationBadgeText(trace())).toBe('decimated: 6000 points'))
  it('discloses conversion label, target and factor', () => expect(conversionBadgeText(trace())).toBe('current_mA -> A, x1e-3'))
  it('does not mark an unconverted trace as converted', () => expect(conversionBadgeText(trace({ factor: 1 }))).toBeNull())
  it('renders both label and reason in refusal text', () => expect(refusalText({ label: 'voltage', reason: 'V cannot convert to A' })).toBe('voltage: V cannot convert to A'))
})

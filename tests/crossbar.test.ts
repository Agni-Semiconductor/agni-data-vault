// The crossbar's two load-bearing rules, tested on the pure helpers (there is no testing-library
// in this repo, so those helpers ARE the test surface).
import { describe, expect, it } from 'vitest'
import { strokeFor, tooltipFor, type LineStat } from '../src/components/crossbarGeometry'

const RAMP = ['#EBE5F3', '#CAB8E1', '#AA8BCD', '#8B5FB9', '#6B339D']
const GRID = '#E8E8EC'
const line = (over: Partial<LineStat> = {}): LineStat => ({ line: 42, measured: 10, bad: 0, rate: 0, ...over })

describe('an unmeasured line is grid, NOT the bottom of the ramp', () => {
  it('null rate renders as grid', () => {
    // "We did not look" and "we looked and it was fine" are different statements. A map that
    // renders them alike turns the first into the second, and an unmeasured row reads as a
    // healthy one -- the same rule that keeps untested cells unpainted on the coverage map.
    expect(strokeFor(null, RAMP)).toBe(GRID)
    expect(strokeFor(null, RAMP)).not.toBe(RAMP[0])
  })

  it('a measured line with zero failures gets the LOWEST RAMP COLOUR, not grid', () => {
    // The other half of the same rule, and the one a naive `rate || grid` gets wrong: 0 is falsy.
    expect(strokeFor(0, RAMP)).toBe(RAMP[0])
    expect(strokeFor(0, RAMP)).not.toBe(GRID)
  })

  it('maps the rate across the whole ramp and clamps at both ends', () => {
    expect(strokeFor(0.1, RAMP)).toBe(RAMP[0])
    expect(strokeFor(0.5, RAMP)).toBe(RAMP[2])
    expect(strokeFor(1, RAMP)).toBe(RAMP[4])
    expect(strokeFor(1.5, RAMP)).toBe(RAMP[4])   // never indexes past the end
    expect(strokeFor(-0.2, RAMP)).toBe(RAMP[0])
  })
})

describe('the tooltip says what to physically probe', () => {
  it('names the line, its net and its package pin', () => {
    // A stripe at WL 42 is only actionable once you know which pin to touch.
    expect(tooltipFor('wl', line({ net: 'WL_ROW42', pin: 'J3-17', bad: 3 })))
      .toBe('WL 42 · WL_ROW42 · pin J3-17 · 3/10 bad')
  })

  it('omits wiring cleanly when the board has no pin map', () => {
    // The pin map is optional: a board nobody has wired up yet still renders.
    expect(tooltipFor('bl', line({ line: 7, bad: 1, measured: 4 }))).toBe('BL 7 · 1/4 bad')
  })

  it('says "not measured" rather than "0/0 bad"', () => {
    // 0/0 reads as a perfect score. It is the absence of a measurement.
    expect(tooltipFor('wl', line({ measured: 0, bad: 0, rate: null }))).toBe('WL 42 · not measured')
  })

  it('shows a net even when only one of net and pin is known', () => {
    expect(tooltipFor('wl', line({ net: 'WL_ROW42' }))).toBe('WL 42 · WL_ROW42 · 0/10 bad')
    expect(tooltipFor('wl', line({ pin: 'J3-17' }))).toBe('WL 42 · pin J3-17 · 0/10 bad')
  })
})

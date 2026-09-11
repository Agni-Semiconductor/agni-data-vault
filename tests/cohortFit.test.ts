// The fit helpers. These are the test surface for CorrelationChart -- there is no
// testing-library here -- and every expected number below comes from a standard table or from
// arithmetic done by hand, never from running the code and recording what it said.
import { describe, expect, it } from 'vitest'
import {
  bandHalfWidth, correlationR, exclusionNotes, fitBand, innerLedgerBalances, noFitReason,
  outerLedgerBalances, predict, residualSd, slopeStandardError, slopeText, tQuantile95,
} from '../src/pages/cohorts/fit'
import type { CorrelationFit, CorrelationResult } from '../src/lib/cohorts'

// The same four points 0117's own probe uses: x = 10,20,30,40 against log10 y = 1,2,3,4.
// avg_x 25, sxx 500, syy 5, sxy 50 -> slope 0.1, intercept 0, r2 1. An EXACT fit, chosen so a
// zero residual is exercised rather than avoided.
const exact: CorrelationFit = { slope: .1, intercept: 0, r2: 1, n: 4, avg_x: 25, avg_y: 2.5, sxx: 500, syy: 5, sxy: 50 }
// A scattered fit with hand-computable residuals: syy 5, slope*sxy = 0.09*50 = 4.5, so RSS = 0.5
// over df = 2 -> s^2 = 0.25, s = 0.5, se_slope = 0.5/sqrt(500).
const noisy: CorrelationFit = { slope: .09, intercept: .25, r2: .9, n: 4, avg_x: 25, avg_y: 2.5, sxx: 500, syy: 5, sxy: 50 }

const result = (over: Partial<CorrelationResult> = {}): CorrelationResult => ({
  metric: 'onoff', group_by: 'stack_fe_t_nm', fit_space: 'log10_y', x_unit: 'nm', y_unit: '',
  ledger: { n_members: 8, n_with_metric: 6, n_no_metric_row: 1, n_refused: 1, n_no_x: 1, n_nonpositive_y: 1, n_fit: 4 },
  fit: exact, points: [], points_returned: 4, points_sampled: false, ...over,
})

describe('the 95% t quantile', () => {
  it('matches the standard table for small df', () => {
    // A flat 1.96 is the shortcut, and at df = 1 it is off by a factor of SIX. Small cohorts are
    // exactly where the band must look wide, so this is the value that most needs to be right.
    expect(tQuantile95(1)).toBeCloseTo(12.706, 3)
    expect(tQuantile95(3)).toBeCloseTo(3.182, 3)
    expect(tQuantile95(10)).toBeCloseTo(2.228, 3)
    expect(tQuantile95(30)).toBeCloseTo(2.042, 3)
  })

  it('the approximation past the table agrees with the table it replaces', () => {
    // The seam between lookup and Cornish-Fisher is where an off-by-one hides: a discontinuity
    // at df 31 would widen or pinch every band on the far side of it.
    expect(tQuantile95(31)).toBeCloseTo(2.0395, 3)
    expect(tQuantile95(40)).toBeCloseTo(2.021, 3)
    expect(tQuantile95(120)).toBeCloseTo(1.980, 3)
    expect(tQuantile95(31)).toBeLessThan(tQuantile95(30))
    expect(tQuantile95(1e7)).toBeCloseTo(1.95996, 4)
  })

  it('refuses a degenerate df rather than returning a number', () => {
    expect(tQuantile95(0)).toBeNaN()
  })
})

describe('the fit statistics', () => {
  it('computes the residual sd and the slope standard error from the sums', () => {
    expect(residualSd(noisy)).toBeCloseTo(.5, 12)
    expect(slopeStandardError(noisy)).toBeCloseTo(.5 / Math.sqrt(500), 12)
  })

  it('a perfect fit has zero residual, not NaN', () => {
    // syy - slope*sxy is 0 here and floating point can push it fractionally NEGATIVE. A NaN band
    // on a perfect correlation reads as "could not be computed" rather than "there is no
    // scatter", which is the opposite of what happened.
    expect(residualSd(exact)).toBe(0)
    expect(bandHalfWidth(exact, 25)).toBe(0)
  })

  it('r carries the sign that R-squared throws away', () => {
    expect(correlationR(exact)).toBeCloseTo(1, 12)
    expect(correlationR({ ...exact, slope: -.1 })).toBeCloseTo(-1, 12)
  })

  it('the band is narrowest at the mean of x and widens both ways', () => {
    const centre = bandHalfWidth(noisy, 25)
    expect(centre).toBeCloseTo(tQuantile95(2) * .5 * Math.sqrt(1 / 4), 12)
    expect(bandHalfWidth(noisy, 10)).toBeGreaterThan(centre)
    expect(bandHalfWidth(noisy, 40)).toBeGreaterThan(centre)
    expect(bandHalfWidth(noisy, 10)).toBeCloseTo(bandHalfWidth(noisy, 40), 12)
  })

  it('refuses a band when there is nothing to fit', () => {
    expect(bandHalfWidth({ ...noisy, n: 2 }, 25)).toBeNaN()
    expect(bandHalfWidth({ ...noisy, sxx: 0 }, 25)).toBeNaN()
  })
})

describe('the band comes back in the axis own space', () => {
  it('a log fit is exponentiated per END, not as a symmetric width', () => {
    // THE TRAP. A band that is +/- h in log space is NOT +/- anything in linear space: at
    // y = 100 with h = 0.3 the ends are 50.1 and 199.5. Exponentiating a midpoint and adding a
    // symmetric width would put the line off-centre inside its own interval, and the error grows
    // with the width -- so it looks fine on the tight fits and lies on the loose ones.
    const band = fitBand(result({ fit: noisy }), 10, 40, 4)
    for (const point of band) {
      const half = bandHalfWidth(noisy, point.x)
      expect(point.lo).toBeCloseTo(10 ** (predict(noisy, point.x) - half), 9)
      expect(point.hi).toBeCloseTo(10 ** (predict(noisy, point.x) + half), 9)
      expect(point.hi - point.y).not.toBeCloseTo(point.y - point.lo, 6)
    }
  })

  it('a raw fit is not transformed at all', () => {
    const band = fitBand(result({ fit: noisy, fit_space: 'raw' }), 10, 40, 4)
    expect(band[0].y).toBeCloseTo(predict(noisy, 10), 12)
    expect(band[0].hi - band[0].y).toBeCloseTo(band[0].y - band[0].lo, 12)
  })

  it('returns nothing rather than a flat line when there is no fit', () => {
    expect(fitBand(result({ fit: null }), 10, 40)).toEqual([])
    expect(fitBand(result(), 40, 10)).toEqual([])
  })
})

describe('what the numbers are CALLED', () => {
  it('a log-space slope is decades per x unit, never the metric unit', () => {
    // Printing "0.1 A per nm" under a log10 fit is a units error in a caption, and a caption is
    // exactly where nobody re-derives it.
    expect(slopeText(result({ fit: noisy }))).toContain('decades per nm')
    expect(slopeText(result({ fit: noisy }))).not.toContain(' A ')
  })

  it('a raw-space slope carries the metric unit', () => {
    expect(slopeText(result({ fit: noisy, fit_space: 'raw', y_unit: 'V' }))).toContain('V per nm')
  })

  it('reports the slope standard error alongside it', () => {
    expect(slopeText(result({ fit: noisy }))).toContain('SE')
  })
})

describe('why there is no line, said accurately', () => {
  const led = (over: Partial<CorrelationResult['ledger']>) => result({
    fit: null, ledger: { n_members: 10, n_with_metric: 10, n_no_metric_row: 0, n_refused: 0, n_no_x: 0, n_nonpositive_y: 0, n_fit: 10, ...over },
  })

  it('distinguishes an empty cohort from an uncomputed metric from an all-excluded one', () => {
    // Three different findings. Flattening them into "no data" tells a user to widen a filter
    // when what they actually need to do is run the extractor.
    expect(noFitReason(led({ n_members: 0, n_with_metric: 0, n_fit: 0 }))).toContain('no measurement matches')
    expect(noFitReason(led({ n_with_metric: 0, n_no_metric_row: 10, n_fit: 0 }))).toContain('has this metric computed')
    expect(noFitReason(led({ n_no_x: 10, n_fit: 0 }))).toContain('excluded from the fit')
    expect(noFitReason(led({ n_fit: 2, n_no_x: 8 }))).toContain('needs at least 3')
  })

  it('says nothing when there IS a fit', () => {
    expect(noFitReason(result())).toBeNull()
  })
})

describe('the exclusions, named', () => {
  it('gives a non-positive y its own sentence, because it is real data', () => {
    // A dead device honestly reads 0 for on/off. Reporting it as "no metric" is a false
    // statement about the corpus -- the same distinction undrawableReason draws on the box plot.
    const notes = exclusionNotes(result())
    expect(notes).toHaveLength(4)
    expect(notes.some((note) => note.includes('real data, not missing data'))).toBe(true)
  })

  it('stays silent about buckets that are empty', () => {
    expect(exclusionNotes(result({ ledger: { n_members: 4, n_with_metric: 4, n_no_metric_row: 0, n_refused: 0, n_no_x: 0, n_nonpositive_y: 0, n_fit: 4 } }))).toEqual([])
  })
})

describe('both ledgers', () => {
  it('balance on a well-formed result', () => {
    expect(outerLedgerBalances(result().ledger)).toBe(true)
    expect(innerLedgerBalances(result().ledger)).toBe(true)
  })

  it('catch a disagreement in either ledger independently', () => {
    // They fail for different reasons: the outer one means the API and the database disagree
    // about the population, the inner one that a point left the fit without being counted.
    expect(outerLedgerBalances({ ...result().ledger, n_refused: 0 })).toBe(false)
    expect(innerLedgerBalances({ ...result().ledger, n_no_x: 0 })).toBe(false)
  })

  it('coerce, because a bigint column can arrive as a JSON string', () => {
    // Same trap cohortStats.ts already documents: "8" === "6"+"1"+"1" is "8" === "611".
    const wire = { n_members: '8', n_with_metric: '6', n_no_metric_row: '1', n_refused: '1', n_no_x: '1', n_nonpositive_y: '1', n_fit: '4' } as unknown as CorrelationResult['ledger']
    expect(outerLedgerBalances(wire)).toBe(true)
    expect(innerLedgerBalances(wire)).toBe(true)
  })
})

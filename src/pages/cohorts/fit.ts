// The fit, as pure functions. There is no testing-library in this repo, so these ARE the test
// surface for CorrelationChart -- and they must be importable without a canvas.
//
// THE COEFFICIENTS ARE NOT RECOMPUTED HERE. `vault.cohort_correlation` fits over every member;
// the scatter that arrives beside it may have been thinned. Refitting on what arrived would draw
// a line through the visible points that disagrees with the reported slope -- two definitions of
// one number, differing by however much the thinning happened to bias. What this module does is
// turn the regression SUMS into the things a chart needs: a band, a standard error, a line.
import type { CorrelationFit, CorrelationResult } from '../../lib/cohorts'

/**
 * Two-sided 95% t quantile.
 *
 * Table to df 30, Cornish-Fisher beyond. A flat 1.96 is the tempting shortcut and it is wrong
 * exactly where it matters: at df = 3 the true value is 3.182, so a band drawn with 1.96 is 38%
 * too narrow on the smallest cohorts -- the ones whose bands most need to look wide. Checked
 * against the standard table at df 1, 3, 10, 30, 31 and 40 in fit.test.ts.
 */
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179,
  2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060,
  2.056, 2.052, 2.048, 2.045, 2.042]
const Z95 = 1.959963985
export function tQuantile95(df: number): number {
  if (!Number.isFinite(df) || df < 1) return Number.NaN
  if (df <= T95.length) return T95[Math.floor(df) - 1]
  const z = Z95, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
}

/** Residual standard deviation in FIT SPACE. syy - slope*sxy is the residual sum of squares. */
export function residualSd(fit: CorrelationFit): number {
  const df = fit.n - 2
  if (df < 1) return Number.NaN
  // Floating point can drive an exact fit's residual sum fractionally below zero; a NaN band on a
  // perfect correlation would read as "could not be computed" rather than "there is no scatter".
  return Math.sqrt(Math.max(0, fit.syy - fit.slope * fit.sxy) / df)
}

export const slopeStandardError = (fit: CorrelationFit): number =>
  fit.sxx > 0 ? residualSd(fit) / Math.sqrt(fit.sxx) : Number.NaN

/** Pearson r. R^2 discards the sign, and the direction is half of what a reader wants. */
export const correlationR = (fit: CorrelationFit): number =>
  Math.sign(fit.slope) * Math.sqrt(Math.max(0, Math.min(1, fit.r2)))

export const predict = (fit: CorrelationFit, x: number): number => fit.intercept + fit.slope * x

/** Half-width of the 95% band for the MEAN response at x -- not a prediction interval. */
export function bandHalfWidth(fit: CorrelationFit, x: number): number {
  if (!(fit.sxx > 0) || fit.n < 3) return Number.NaN
  return tQuantile95(fit.n - 2) * residualSd(fit)
    * Math.sqrt(1 / fit.n + (x - fit.avg_x) ** 2 / fit.sxx)
}

export type FitBandPoint = { x: number; y: number; lo: number; hi: number }

/**
 * The line and its band, sampled across [xMin, xMax] and returned in the axis's OWN space.
 *
 * `fit_space` is honoured here and nowhere else: a log10_y fit produces y = 10^(mx+b), and the
 * band's ends are exponentiated individually rather than as +/- a symmetric width, because a
 * symmetric band in log space is an ASYMMETRIC one in linear space. Averaging the two ends -- or
 * computing the band after exponentiating -- puts the line off-centre in its own interval.
 */
export function fitBand(result: CorrelationResult, xMin: number, xMax: number, steps = 64): FitBandPoint[] {
  const fit = result.fit
  if (!fit || !(xMax > xMin) || !Number.isFinite(xMin) || !Number.isFinite(xMax)) return []
  const log = result.fit_space === 'log10_y'
  const out: FitBandPoint[] = []
  for (let i = 0; i <= steps; i += 1) {
    const x = xMin + (xMax - xMin) * (i / steps)
    const y = predict(fit, x)
    const half = bandHalfWidth(fit, x)
    const wide = Number.isFinite(half) ? half : 0
    out.push(log
      ? { x, y: 10 ** y, lo: 10 ** (y - wide), hi: 10 ** (y + wide) }
      : { x, y, lo: y - wide, hi: y + wide })
  }
  return out
}

/**
 * What the slope MEANS, in words, with its unit.
 *
 * In log10 space the slope is decades of y per unit of x, and calling it anything else -- "per
 * nm" with the metric's own unit attached -- would be a units error printed under a chart.
 */
export function slopeText(result: CorrelationResult): string | null {
  const fit = result.fit
  if (!fit) return null
  const per = result.x_unit ? ` per ${result.x_unit}` : ' per unit x'
  const se = slopeStandardError(fit)
  const value = result.fit_space === 'log10_y'
    ? `${fit.slope.toPrecision(3)} decades${per}`
    : `${fit.slope.toPrecision(3)} ${result.y_unit || ''}${per}`.replace(/\s+/g, ' ')
  return Number.isFinite(se) ? `${value} (SE ${se.toPrecision(2)})` : value
}

/**
 * Why there is no line, in words that are TRUE -- three different findings that a single "no
 * data" would flatten into one.
 */
export function noFitReason(result: CorrelationResult): string | null {
  if (result.fit) return null
  const l = result.ledger
  if (l.n_members === 0) return 'no measurement matches this predicate'
  if (l.n_fit === 0 && l.n_with_metric === 0) return 'no matched measurement has this metric computed'
  if (l.n_fit === 0) return 'every measurement with this metric was excluded from the fit — see the ledger below'
  if (l.n_fit < 3) return `only ${l.n_fit} point${l.n_fit === 1 ? '' : 's'} could be fitted; a line needs at least 3`
  return 'every fittable point shares one x value, so no slope is defined'
}

/** n_members = n_with_metric + n_no_metric_row + n_refused. */
export const outerLedgerBalances = (l: CorrelationResult['ledger']): boolean =>
  Number(l.n_members) === Number(l.n_with_metric) + Number(l.n_no_metric_row) + Number(l.n_refused)
/** n_with_metric = n_fit + n_no_x + n_nonpositive_y. */
export const innerLedgerBalances = (l: CorrelationResult['ledger']): boolean =>
  Number(l.n_with_metric) === Number(l.n_fit) + Number(l.n_no_x) + Number(l.n_nonpositive_y)

/**
 * The exclusions, named individually and only when non-zero.
 *
 * `n_nonpositive_y` gets its own sentence rather than joining a total, because it is the one
 * exclusion that is REAL DATA the axis cannot show: a dead device honestly reads 0 for on/off,
 * and reporting it as "no metric" is a false statement about the corpus. Same distinction
 * `undrawableReason` draws on the distribution chart.
 */
export function exclusionNotes(result: CorrelationResult): string[] {
  const l = result.ledger; const notes: string[] = []
  if (Number(l.n_no_metric_row) > 0) notes.push(`${l.n_no_metric_row} with no metric row`)
  if (Number(l.n_refused) > 0) notes.push(`${l.n_refused} whose extractor refused the sweep`)
  if (Number(l.n_no_x) > 0) notes.push(`${l.n_no_x} with no value for the grouping key`)
  if (Number(l.n_nonpositive_y) > 0) {
    notes.push(`${l.n_nonpositive_y} with a value of zero or less, which a log fit cannot take — real data, not missing data`)
  }
  return notes
}

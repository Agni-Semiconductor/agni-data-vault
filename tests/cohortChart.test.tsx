import { describe, expect, it } from 'vitest'
import { hasValues, isLedgerBalanced, isSmallCohort, orderCohortGroups, provenanceSummaryText, undrawableReason } from '../src/pages/cohorts/cohortStats'
import type { CohortGroup } from '../src/pages/cohorts/cohortStats'

const group = (overrides: Partial<CohortGroup> = {}): CohortGroup => ({ group_value: '20', n_members: 10, n_with_metric: 7, n_no_metric_row: 2, n_refused: 1, status_confirmed: 7, status_assumed: 1, status_unknown: 1, status_unspecified: 1, min_value: 1, q1: 2, median: 3, q3: 4, max_value: 5, mean: 3, stddev: 1.4, ...overrides })

describe('CohortChart helpers', () => {
  it('checks the exclusion ledger rather than allowing a plausible incomplete cohort', () => { expect(isLedgerBalanced(group())).toBe(true); expect(isLedgerBalanced(group({ n_refused: 2 }))).toBe(false) })
  it('marks small-n distributions for distinct treatment', () => { expect(isSmallCohort(group({ n_with_metric: 5 }))).toBe(true); expect(isSmallCohort(group({ n_with_metric: 6 }))).toBe(false) })
  it('keeps all four provenance buckets in its summary', () => expect(provenanceSummaryText(group())).toBe('confirmed 7 · assumed 1 · unknown 1 · unspecified 1'))
  it('orders continuous values numerically, never as API text', () => { const values = orderCohortGroups([group({ group_value: '100' }), group({ group_value: '20' }), group({ group_value: '45' })], 'continuous').map(({ group_value }) => group_value); expect(values).toEqual(['20', '45', '100']) })
  it('orders categorical values by metric evidence first', () => { const values = orderCohortGroups([group({ group_value: 'low', n_with_metric: 2 }), group({ group_value: 'high', n_with_metric: 9 }), group({ group_value: 'mid', n_with_metric: 5 })], 'categorical').map(({ group_value }) => group_value); expect(values).toEqual(['high', 'mid', 'low']) })
})

describe('why a group has no box, in words that are TRUE', () => {
  it('says "no metric" only when there really is no metric', () => {
    expect(undrawableReason(group({ n_with_metric: 0, min_value: null, q1: null, median: null, q3: null, max_value: null }), false)).toBe('no metric')
    expect(hasValues(group({ n_with_metric: 0, median: null }))).toBe(false)
  })

  it('does NOT say "no metric" for real data a log axis cannot show', () => {
    // `onoff` and `j_max_a_cm2` are log-scale metrics, and a dead device legitimately reads 0.
    // The earlier version called this "no metric", which is a false statement about the data on
    // a chart whose whole purpose is honesty about what it is showing.
    const dead = group({ n_with_metric: 6, min_value: 0, q1: 0, median: 2, q3: 5, max_value: 9 })
    expect(hasValues(dead)).toBe(true)
    expect(undrawableReason(dead, true)).toBe('not plottable on a log axis')
    expect(undrawableReason(dead, true)).not.toMatch(/no metric/)
  })

  it('the same group draws fine on a linear axis', () => {
    const dead = group({ n_with_metric: 6, min_value: 0, q1: 0, median: 2, q3: 5, max_value: 9 })
    expect(undrawableReason(dead, false)).toBeNull()
  })

  it('reports incomplete quartiles as such, not as missing data', () => {
    // n_with_metric of 1 gives a median but stddev/quartile edges can still be null upstream.
    const partial = group({ n_with_metric: 1, min_value: 3, q1: null, median: 3, q3: null, max_value: 3 })
    expect(undrawableReason(partial, false)).toBe('incomplete quartiles')
  })

  it('a drawable group has no reason at all', () => expect(undrawableReason(group(), false)).toBeNull())
})

describe('bigint columns arrive as strings and must still add up', () => {
  it('the ledger balances when the counts are JSON strings', () => {
    // n_members and friends are `count(*)` -- bigint. Depending on the driver they arrive as
    // strings, and then "10" === "7"+"2"+"1" is "10" === "721": the ledger would report a
    // database disagreement for every group in the cohort.
    const stringy = { n_members: '10', n_with_metric: '7', n_no_metric_row: '2', n_refused: '1' } as unknown as CohortGroup
    expect(isLedgerBalanced(stringy)).toBe(true)
  })

  it('small-n and provenance text survive stringy counts too', () => {
    expect(isSmallCohort({ n_with_metric: '3' } as unknown as CohortGroup)).toBe(true)
    expect(provenanceSummaryText({ status_confirmed: '7', status_assumed: '1', status_unknown: '1', status_unspecified: '1' } as unknown as CohortGroup))
      .toBe('confirmed 7 · assumed 1 · unknown 1 · unspecified 1')
  })
})

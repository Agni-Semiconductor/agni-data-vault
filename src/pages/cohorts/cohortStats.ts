// ONE definition of the wire types, imported from the client rather than restated here.
//
// These arrived as a second copy: src/lib/cohorts.ts already declared CohortGroup, GroupKey and
// MetricDefinition, and the copies had ALREADY diverged -- the client's CohortGroup carries
// `mean` and `stddev` and this one did not, so a chart could not have shown them and the
// compiler could not have noticed. Two declarations of one wire shape do not conflict; they just
// quietly describe different things. Same failure this repo already fixed in UploadFolder.
import type { CohortGroup, GroupKey } from '../../lib/cohorts'
export type { CohortGroup, GroupKey, MetricDefinition } from '../../lib/cohorts'

export const SMALL_N = 5
// Pure cohort statistics helpers, in their own module rather than beside the component.
//
// Two reasons, the second load-bearing: react-refresh only works when a file exports components
// alone, and there is no testing-library in this repo -- so these functions ARE the test surface
// for CohortChart, and they must be importable without a canvas.

// A bigint column can arrive as a JSON STRING depending on the driver, and then
// "10" === "7"+"2"+"1" is "10" === "721" -- the ledger would report a database disagreement for
// every group in the cohort. Coerce at every read rather than trusting the wire type.
export const count = (value: number) => Number(value)
export const isLedgerBalanced = (group: Pick<CohortGroup, 'n_members' | 'n_with_metric' | 'n_no_metric_row' | 'n_refused'>) => count(group.n_members) === count(group.n_with_metric) + count(group.n_no_metric_row) + count(group.n_refused)
export const isSmallCohort = (group: Pick<CohortGroup, 'n_with_metric'>) => count(group.n_with_metric) <= SMALL_N
export const provenanceSummaryText = (group: Pick<CohortGroup, 'status_confirmed' | 'status_assumed' | 'status_unknown' | 'status_unspecified'>) => `confirmed ${count(group.status_confirmed)} · assumed ${count(group.status_assumed)} · unknown ${count(group.status_unknown)} · unspecified ${count(group.status_unspecified)}`
export function orderCohortGroups(groups: CohortGroup[], valueKind: GroupKey['value_kind']): CohortGroup[] {
  return [...groups].sort((a, b) => {
    if (valueKind === 'categorical') return count(b.n_with_metric) - count(a.n_with_metric) || String(a.group_value ?? '').localeCompare(String(b.group_value ?? ''))
    const av = Number(a.group_value); const bv = Number(b.group_value); const aFinite = Number.isFinite(av); const bFinite = Number.isFinite(bv)
    return aFinite && bFinite ? av - bv : aFinite ? -1 : bFinite ? 1 : String(a.group_value ?? '').localeCompare(String(b.group_value ?? ''))
  })
}

/** Are there any values at all? Distinct from whether they can be DRAWN -- see below. */
export const hasValues = (group: Pick<CohortGroup, 'n_with_metric' | 'median'>) =>
  Number(group.n_with_metric) > 0 && typeof group.median === 'number' && Number.isFinite(group.median)
export const statistics = (group: CohortGroup, logScale: boolean) => [group.min_value, group.q1, group.median, group.q3, group.max_value].every((value) => typeof value === 'number' && Number.isFinite(value) && (!logScale || value > 0))
/**
 * Why a group has no box, in words that are TRUE.
 *
 * These are two different findings and the earlier version called both of them "no metric":
 * a group with n_with_metric = 0 genuinely has nothing, while a group whose min_value is 0 on a
 * LOG axis has real data that this axis cannot show -- and `onoff` and `j_max_a_cm2` are both
 * log-scale metrics where a dead device legitimately reads 0. Labelling that "no metric" is a
 * false statement about the data, on a chart whose entire purpose is to be honest about what it
 * is and is not showing.
 */
export const undrawableReason = (group: CohortGroup, logScale: boolean): string | null => {
  if (statistics(group, logScale)) return null
  if (!hasValues(group)) return 'no metric'
  return logScale ? 'not plottable on a log axis' : 'incomplete quartiles'
}
// "No value recorded" rather than "Unspecified": `status_unspecified` is a PROVENANCE bucket
// (nobody said how sure they were), while this is the grouping value itself being absent. Two
// different facts should not share a word on the same card.
export const label = (group: CohortGroup) => group.group_value === null || group.group_value === '' ? 'No value recorded' : group.group_value
export const nonConfirmed = (group: CohortGroup) => count(group.status_assumed) + count(group.status_unknown) + count(group.status_unspecified) > count(group.status_confirmed)


// @ts-nocheck
// A search term reaches PostgREST inside a FILTER STRING, not as a bound parameter.
//
// `or=(sample_id.ilike.*X*,label.ilike.*X*)` is parsed by PostgREST, so a comma or a paren
// inside X closes one condition and opens another: `?q=a,id.not.is.null` widens the OR to every
// row in the table. The blast radius is bounded — an OR can only widen a filter the caller could
// have omitted entirely, on a table they can already list, with no write and no join — and that
// is precisely why it would sit there unnoticed rather than showing up as a broken page.
//
// These tests inspect the filter string that was actually handed to supabase-js. Asserting that
// a search "returns results" would pass just as happily with the injection intact.
import { describe, expect, it, vi } from 'vitest'
import { applyEntityFilters, likeTerm } from '../api/_lib/query.js'

/** Records every filter string passed to `.or()` / `.ilike()` instead of talking to a database. */
function spy() {
  const calls: Array<[string, ...unknown[]]> = []
  const q: Record<string, unknown> = {}
  for (const op of ['or', 'ilike', 'gte', 'lte', 'eq', 'contains', 'order', 'range', 'select']) {
    q[op] = (...args: unknown[]) => { calls.push([op, ...args]); return q }
  }
  return { q, calls }
}
const filterStrings = (calls: Array<[string, ...unknown[]]>) =>
  calls.filter(([op]) => op === 'or' || op === 'ilike').map((c) => c.slice(1).join(' '))

describe('likeTerm strips what PostgREST treats as structure', () => {
  it.each([
    ['a,id.not.is.null', 'the comma that opens a second condition'],
    ['x)or(id.gt.0', 'parens that close and reopen the group'],
    ['a.b.c', 'dots, which separate column from operator from value'],
    ['role:admin', 'the colon PostgREST uses for casts'],
    ['*', 'a bare wildcard'],
    ['back\\slash', 'a backslash escape'],
  ])('%s — %s', (input) => {
    const term = likeTerm(input)
    for (const ch of [',', '(', ')', '.', ':', '*', '\\']) expect(term).not.toContain(ch)
  })

  it('keeps an ordinary search term usable', () => {
    // Stripping instead of rejecting is deliberate: someone searching for "20nm (batch 3)" typed
    // that paren innocently, and a 400 for a plausible term teaches people the search is broken.
    expect(likeTerm('AlScN 20nm')).toBe('AlScN 20nm')
    expect(likeTerm('20nm (batch 3)')).toBe('20nm  batch 3')
    expect(likeTerm('HfN-01_a~b')).toBe('HfN-01_a~b')
  })

  it('a term made ENTIRELY of structure collapses to empty, and empty must not filter', () => {
    // The dangerous middle case: if `likeTerm` returned '' and the caller still built
    // `ilike.**`, the search would silently match everything. Both callers guard on the empty
    // string for exactly that reason — which the next test proves at the call site.
    expect(likeTerm(',,,')).toBe('')
    expect(likeTerm('...')).toBe('')
  })
})

describe('applyEntityFilters', () => {
  it('an injected comma cannot add a condition to the sample search', () => {
    const { q, calls } = spy()
    applyEntityFilters(q, 'sample', { q: 'a,id.not.is.null' }, [])
    const filters = filterStrings(calls)
    expect(filters).toHaveLength(1)
    expect(filters[0]).toBe('sample_id.ilike.*a id not is null*,label.ilike.*a id not is null*')
    // The injected `id.not.is.null` must not survive as its own condition.
    expect(filters[0]).not.toMatch(/,\s*id\./)
  })

  it('a term of pure structure applies NO filter rather than matching everything', () => {
    const { q, calls } = spy()
    applyEntityFilters(q, 'sample', { q: '(),.' }, [])
    expect(filterStrings(calls)).toEqual([])
  })

  it('the measurement path is sanitised too, not just the sample one', () => {
    const { q, calls } = spy()
    applyEntityFilters(q, 'measurement', { q: 'D1,id.gt.0' }, [])
    expect(filterStrings(calls)).toEqual(['device_address *D1 id gt 0*'])
  })

  it('an ordinary search still reaches PostgREST unchanged', () => {
    const { q, calls } = spy()
    applyEntityFilters(q, 'sample', { q: 'AlScN' }, [])
    expect(filterStrings(calls)).toEqual(['sample_id.ilike.*AlScN*,label.ilike.*AlScN*'])
  })
})

describe('the figures search shares the same guard', () => {
  it('sanitises its three-column or() and skips it when nothing survives', async () => {
    const state: { calls: Array<[string, ...unknown[]]> } = { calls: [] }
    vi.doMock('../api/_lib/supabaseAdmin.js', () => ({
      supabaseAdmin: () => ({ from: () => { const s = spy(); state.calls = s.calls; Object.assign(s.q, { range: () => Promise.resolve({ data: [], error: null, count: 0 }) }); return s.q } }),
    }))
    const figures = await import('../api/_lib/resources/figures.js')

    await figures.list({ q: 'a,id.not.is.null' })
    expect(filterStrings(state.calls)[0]).not.toMatch(/,\s*id\./)

    await figures.list({ q: ',,,' })
    expect(filterStrings(state.calls)).toEqual([])
  })
})

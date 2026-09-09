import { describe, expect, it } from 'vitest'
import { MEASUREMENT_DEFS } from '../src/fields/fixtures'
import { applyFilters, filtersFromSearchParams, filtersToSearchParams } from '../src/fields/filters'
const defs = MEASUREMENT_DEFS
describe('filters', () => {
  it('round trips text', () => { const value={device_address:'d3'}; expect(filtersFromSearchParams(filtersToSearchParams(value),defs)).toEqual(value) })
  it('round trips multi-value selects', () => { const value={kind:['dciv','aciv']}; expect(filtersFromSearchParams(filtersToSearchParams(value),defs)).toEqual(value) })
  it('round trips ranges', () => { const value={temperature_c:{min:20,max:30}}; expect(filtersFromSearchParams(filtersToSearchParams(value),defs)).toEqual(value) })
  it('round trips dates', () => { const value={measured_on:{from:'2026-01-01',to:'2026-02-01'}}; expect(filtersFromSearchParams(filtersToSearchParams(value),defs)).toEqual(value) })
  it('filters numeric ranges', () => { const rows=[{temperature_c:20,meta:{}},{temperature_c:30,meta:{}}]; expect(applyFilters(rows,{temperature_c:{min:25}},defs)).toHaveLength(1) })
  it('filters any matching select', () => { const rows=[{kind:'dciv',meta:{}},{kind:'pund',meta:{}}]; expect(applyFilters(rows,{kind:['dciv','aciv']},defs)).toHaveLength(1) })
  it('filters text contains', () => { const rows=[{device_address:'D3',meta:{}},{device_address:'A1',meta:{}}]; expect(applyFilters(rows,{device_address:'d3'},defs)).toHaveLength(1) })
})

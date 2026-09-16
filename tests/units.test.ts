import { describe, expect, it } from 'vitest'
import { buildRegistry, checkTrace, columnUnit, convertTrace, resolveTraceUnit, unitFactor } from '../src/plot/units'

const registry = () => buildRegistry({
  items: [], units: [{ unit: 'A', quantity: 'current', si_factor: 1 }, { unit: 'mA', quantity: 'current', si_factor: 1e-3 }, { unit: 'V', quantity: 'voltage', si_factor: 1 }],
  column_units: [{ column_name: 'i_a', unit: 'A' }, { column_name: 'current_mA', unit: 'mA' }],
})
describe('units', () => {
  it('converts current through SI factors', () => { const reg = registry(); expect(unitFactor(reg, 'mA', 'A')).toBe(1e-3); expect(unitFactor(reg, 'A', 'mA')).toBe(1e3); expect(convertTrace(reg, [4.2], 'mA', 'A').values[0]).toBeCloseTo(.0042) })
  it('throws and refuses incompatible quantities while naming both units', () => { const reg = registry(); expect(() => unitFactor(reg, 'A', 'V')).toThrow(/A.*V/); const result = checkTrace(reg, { column: 'i_a', kindAxisUnit: 'A', panelUnit: 'V' }); expect(result).toMatchObject({ from: 'A', to: 'V' }); expect('reason' in result && result.reason).toMatch(/A.*V/) })
  it('refuses unregistered columns rather than applying the axis default', () => { const result = checkTrace(registry(), { column: 'unregistered', kindAxisUnit: 'A', panelUnit: 'A' }); expect(result).toMatchObject({ from: null, to: 'A' }); expect('reason' in result && result.reason).toMatch(/unregistered.*A/) })
  it('uses a registered column when the kind has no axis unit', () => expect(resolveTraceUnit(registry(), { column: 'current_mA', kindAxisUnit: null })).toEqual({ unit: 'mA', source: 'column' }))
  it('looks up columns case-insensitively', () => expect(columnUnit(registry(), 'CURRENT_ma')).toBe('mA'))
  it('keeps identity conversion exactly one', () => expect(unitFactor(registry(), 'A', 'a')).toBe(1))
})

describe('a panel with no unit yet adopts its first accepted trace', () => {
  const reg = registry()
  // A figure spec may leave `unit` off a panel entirely, so the panel cannot know its unit
  // before its first accepted trace. Without an adopt path the first trace can never be
  // checked, the panel never acquires a unit, and every trace is refused -- an empty figure
  // with no explanation. This is the seam that blocked the panel resolver.
  it('adopts a registered column unit at factor 1', () => {
    const accepted = checkTrace(reg, { column: 'current_mA', kindAxisUnit: null, panelUnit: null })
    expect(accepted).toEqual({ factor: 1, unit: 'mA' })
  })
  it('reports the unit it converted TO, so the panel can label its axis', () => {
    const accepted = checkTrace(reg, { column: 'current_mA', kindAxisUnit: null, panelUnit: 'A' })
    expect(accepted).toMatchObject({ unit: 'A' })
    expect((accepted as { factor: number }).factor).toBeCloseTo(1e-3, 12)
  })
  it('still REFUSES an unregistered column even with no panel unit to clash with', () => {
    // Adopting an unknown unit would make every later trace agree with nothing, which is worse
    // than refusing one: the panel would then silently accept genuinely mismatched traces.
    const result = checkTrace(reg, { column: 'mystery_col', kindAxisUnit: null, panelUnit: null })
    expect(result).toHaveProperty('reason')
    expect((result as { reason: string }).reason).toMatch(/unregistered/)
  })
})

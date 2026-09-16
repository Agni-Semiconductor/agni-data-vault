import { describe, expect, it } from 'vitest'
import { resolvePanel, type TraceInput } from '../src/plot/resolveTraces'
import { buildRegistry } from '../src/plot/units'
import type { ParsedFile } from '../src/plot/parseFile'

const registry = () => buildRegistry({ items: [{ kind: 'board_csv', label: 'Board', x_col: ['v_applied'], y_col: ['i_a', 'current_mA'], y2_col: null, x_unit: 'V', y_unit: null, y2_unit: null, abs_y: false, log_y: false, derivable: [], notes: null }], units: [{ unit: 'A', quantity: 'current', si_factor: 1 }, { unit: 'mA', quantity: 'current', si_factor: 1e-3 }, { unit: 'V', quantity: 'voltage', si_factor: 1 }], column_units: [{ column_name: 'i_a', unit: 'A' }, { column_name: 'current_mA', unit: 'mA' }, { column_name: 'volts', unit: 'V' }] })
const parsed = (headers: string[], rows: ParsedFile['rows']): ParsedFile => ({ headers, rows, n_rows: rows.length, detected_kind: null, source: 'csv' })
const trace = (headers: string[], rows: ParsedFile['rows'], y: string, label = y): TraceInput => ({ spec: { src: { file_id: label }, x: 'v_applied', y, label }, parsed: parsed(headers, rows), kind: 'board_csv' })

describe('resolvePanel', () => {
  it('merges compatible traces and spans both ranges', () => { const result = resolvePanel([trace(['v_applied', 'i_a'], [[0, 1], [1, 2]], 'i_a'), trace(['v_applied', 'i_a'], [[10, 3], [20, 4]], 'i_a', 'second')], { unit: 'A' }, registry()); expect(result.traces).toHaveLength(2); expect(result.xRange).toEqual([-.4, 20.4]); expect(result.yRange).toEqual([.94, 4.06]) })
  it('converts milliamps to amps and reports the factor', () => { const result = resolvePanel([trace(['v_applied', 'current_mA'], [[0, 2], [1, 4]], 'current_mA')], { unit: 'A' }, registry()); expect(result.traces[0]).toMatchObject({ unit: 'A', factor: 1e-3 }); expect(result.traces[0].y).toEqual([.002, .004]) })
  it('refuses incompatible units without stretching accepted ranges', () => { const result = resolvePanel([trace(['v_applied', 'i_a'], [[0, 1], [1, 2]], 'i_a'), trace(['v_applied', 'volts'], [[1000, 1000], [2000, 2000]], 'volts')], { unit: 'A' }, registry()); expect(result.traces).toHaveLength(1); expect(result.refusals[0].reason).toMatch(/V.*A/); expect(result.xRange).toEqual([-.02, 1.02]) })
  it('adopts the first accepted trace unit when the panel has none', () => { const result = resolvePanel([trace(['v_applied', 'current_mA'], [[0, 2]], 'current_mA')], {}, registry()); expect(result.unit).toBe('mA'); expect(result.traces[0].unit).toBe('mA') })
  it('refuses an unregistered y column', () => { const result = resolvePanel([trace(['v_applied', 'mystery'], [[0, 2]], 'mystery')], { unit: 'A' }, registry()); expect(result.traces).toHaveLength(0); expect(result.refusals[0].reason).toMatch(/unregistered/) })
  it('keeps log x/y alignment by nulling non-positive values', () => { const result = resolvePanel([trace(['v_applied', 'i_a'], [[0, -1], [1, 0], [2, 1]], 'i_a')], { unit: 'A', y_scale: 'log' }, registry()); expect(result.traces[0].x).toEqual([0, 1, 2]); expect(result.traces[0].y).toEqual([null, null, 1]) })
  it('refuses unknown transforms', () => { const input = trace(['v_applied', 'i_a'], [[0, 1]], 'i_a'); input.spec.transform = ['transfrom:abs']; const result = resolvePanel([input], { unit: 'A' }, registry()); expect(result.refusals[0].reason).toMatch(/unknown transform/) })
  it('returns a valid empty panel with all refusal reasons', () => { const badUnit = trace(['v_applied', 'volts'], [[0, 1]], 'volts'); const badColumn = trace(['v_applied', 'mystery'], [[0, 1]], 'mystery'); const result = resolvePanel([badUnit, badColumn], { unit: 'A' }, registry()); expect(result.traces).toEqual([]); expect(result.refusals).toHaveLength(2); expect(result.refusals.map((refusal) => refusal.reason).join(' ')).toMatch(/V.*A.*unregistered/); expect(result.xRange).toEqual([0, 1]); expect(result.yRange).toEqual([0, 1]) })
})

describe('the two defects found reviewing this file', () => {
  it('normalize survives a sweep too long to spread as arguments', () => {
    // `Math.max(...values)` passes every element as a separate argument and blows the call
    // stack somewhere above ~125k of them. This runs BEFORE decimation, on the full sweep, so a
    // long capture reached it at full length and the figure died with a RangeError that pointed
    // at nothing. 200k rows is the size that reproduced it.
    const rows = Array.from({ length: 200_000 }, (_, i) => [i, (i % 100) + 1])
    const input = trace(['v_applied', 'i_a'], rows, 'i_a')
    input.spec.transform = ['normalize']
    const result = resolvePanel([input], { unit: 'A' }, registry())
    expect(result.refusals).toEqual([])
    expect(result.traces[0].points).toBe(200_000)
    expect(result.traces[0].decimated).toBe(true)
    // Normalisation used the true maximum of 100: every value now sits in (0, 1] where the raw
    // data ran 1..100. Note the returned peak is 0.81, NOT 1 -- `decimate` keeps every 40th
    // point here and the true peak at index 99 is not a multiple of 40, so it is dropped. That
    // is inherent to every-nth-point decimation and is why `decimated` is reported: a figure
    // that downsampled silently would be one you could not cite.
    const kept = result.traces[0].y.filter((v): v is number => v !== null)
    expect(kept).toHaveLength(result.traces[0].y.length)
    let peak = 0; for (const v of kept) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThanOrEqual(1); if (v > peak) peak = v }
    expect(peak).toBeGreaterThan(0.5)   // scale was ~100, not 1: normalize genuinely ran
    expect(peak).toBeCloseTo(0.81, 12)  // and exactly which point survived is deterministic
  })

  it('an EXPLICITLY named column the file lacks is refused, not substituted by position', () => {
    // `choose` falls back to headers[1] by position. That is right for resolveSeries ("plot this
    // file, best effort") and wrong for a figure ("plot exactly this column"). Here the fallback
    // would land on `i_a` -- a registered column of the panel's own unit -- so it passes every
    // unit check and draws a different quantity under the requested label. Nothing in the
    // rendered figure could contradict it.
    const input = trace(['v_applied', 'i_a'], [[0, 1], [1, 2]], 'i_a')
    input.spec.y = 'current_mA'
    const result = resolvePanel([input], { unit: 'A' }, registry())
    expect(result.traces).toEqual([])
    expect(result.refusals[0].reason).toMatch(/current_mA is not in this file/)
  })

  it('a missing explicit x column is refused too', () => {
    const input = trace(['v_applied', 'i_a'], [[0, 1]], 'i_a')
    input.spec.x = 'time_s'
    const result = resolvePanel([input], { unit: 'A' }, registry())
    expect(result.traces).toEqual([])
    expect(result.refusals[0].reason).toMatch(/x column time_s is not in this file/)
  })

  it("but a KIND's fallback list is still searched, since that is what it is for", () => {
    // No explicit spec.y: board_csv's y_col is {i_a, current_mA} and the file has only the
    // legacy column, which must resolve and convert rather than refuse.
    const input: TraceInput = { spec: { src: { file_id: 'f' }, label: 'legacy' }, parsed: parsed(['v_applied', 'current_mA'], [[0, 2]]), kind: 'board_csv' }
    const result = resolvePanel([input], { unit: 'A' }, registry())
    expect(result.refusals).toEqual([])
    expect(result.traces[0]).toMatchObject({ unit: 'A', factor: 1e-3 })
    expect(result.traces[0].y).toEqual([.002])
  })
})

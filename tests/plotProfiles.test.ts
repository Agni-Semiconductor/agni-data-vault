import { describe, expect, it } from 'vitest'
import { decimate, detectKind, pickDcivChannel, resolveSeries } from '../src/plot/plotProfiles'
import { sniffSource, type ParsedFile } from '../src/plot/parseFile'
const parsed = (headers: string[], rows: ParsedFile['rows']): ParsedFile => ({ headers, rows, n_rows: rows.length, detected_kind: null, source: 'csv' })
describe('plot profiles', () => {
  it.each([['sample_dciv.csv', 'dciv'], ['AC-IV.xls', 'aciv'], ['PUND_Run.xlsx', 'pund'], ['foo C-V.txt', 'cv'], ['cap_camp_dcivfast_20260808T212159Z_0b9865_r000c002_dciv.csv', 'board_csv'], ['run_dciv.csv', 'dciv']] as const)('detects %s', (name, kind) => expect(detectKind([], name)).toBe(kind))
  it('detects board headers', () => expect(detectKind(['v_applied'], 'x')).toBe('board_csv'))
  it('detects PUND headers', () => expect(detectKind(['Psw', 'Qsw'], 'x')).toBe('pund'))
  it('detects AC headers', () => expect(detectKind(['Vforce', 'Imeas'], 'x')).toBe('aciv'))
  it('does not select Charge as the default AC-IV secondary series', () => {
    const s = resolveSeries(parsed(['Vforce', 'Imeas', 'Charge'], [[0, 1, 2]]), 'aciv')
    expect(s.y2).toBeUndefined()
  })
  it('detects pulse headers', () => expect(detectKind(['t', 'V', 'I'], 'x')).toBe('pulse'))
  it('uses absolute dciv current and drops invalid points', () => { const s = resolveSeries(parsed(['AV', 'AI', 'BI'], [[0, -2, 3], ['bad', 1, 2], [1, null, 2]]), 'dciv'); expect(s.x).toEqual([0]); expect(s.y).toEqual([2]) })
  it('picks lower noise DCIV channel', () => expect(pickDcivChannel(parsed(['AI', 'BI'], [[10, 1], [20, 1], [30, 1]])).toString()).toBe('BI'))
  it('decimates to max points', () => { const xs = Array.from({ length: 6001 }, (_, i) => i); expect(decimate(xs, xs, 5000).x.length).toBeLessThanOrEqual(5000) })
  it('supports an override', () => expect(resolveSeries(parsed(['a', 'b'], [[1, 2]]), 'other', { x: 'a', y: 'b' }).y).toEqual([2]))
  it('dciv keeps both voltage polarities in original order with |I| log y', () => { const volts = [-16, -8, -1, 0, 1, 9, 18, 5]; const amps = [-2e-9, -4e-9, 0, 5e-9, -6e-9, 7e-9, -8e-9, 0]; const s = resolveSeries(parsed(['AV', 'AI'], amps.map((amp, i) => [volts[i], amp])), 'dciv', { log: true }); expect(Math.min(...s.x)).toBeLessThan(0); expect(Math.max(...s.x)).toBeGreaterThan(0); expect(s.y.every((v) => v === null || v >= 0)).toBe(true); expect(s.y.filter((v, i) => v === null && amps[i] !== 0).length).toBe(0); expect(s.y.filter((v) => v === null).length).toBe(amps.filter((a) => a === 0).length); expect(s.x).toEqual(volts); expect(s.log_y).toBe(true) })
  it('dciv plots signed current when the log toggle is off', () => { const s = resolveSeries(parsed(['AV', 'AI'], [[-16, -3], [0, 0], [18, 4]]), 'dciv', { log: false }); expect(s.x).toEqual([-16, 0, 18]); expect(s.y).toEqual([-3, 0, 4]); expect(s.log_y).toBe(false) })
  it('board_csv covers both polarities with null gaps at zero', () => { const s = resolveSeries(parsed(['v_applied', 'i_a'], [[-5, -1e-9], [0, 0], [5, 2e-9]]), 'board_csv', { log: true }); expect(Math.min(...s.x)).toBeLessThan(0); expect(Math.max(...s.x)).toBeGreaterThan(0); expect(s.y).toEqual([1e-9, null, 2e-9]) })
  it('sniffSource rejects image magic bytes', () => { expect(() => sniffSource(new Uint8Array([0x42, 0x4d, 0, 0, 0]), 'a.bmp')).toThrow('image file — not tabular'); expect(() => sniffSource(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), 'a.png')).toThrow('image file — not tabular'); expect(() => sniffSource(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg')).toThrow('image file — not tabular'); expect(() => sniffSource(new Uint8Array([0x47, 0x49, 0x46, 0x38]), 'a.gif')).toThrow('image file — not tabular') })
})

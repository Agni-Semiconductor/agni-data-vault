import { describe, expect, it } from 'vitest'
import { decimate, detectKind, pickDcivChannel, resolveSeries } from '../src/plot/plotProfiles'
import type { ParsedFile } from '../src/plot/parseFile'
const parsed = (headers: string[], rows: ParsedFile['rows']): ParsedFile => ({ headers, rows, n_rows: rows.length, detected_kind: null, source: 'csv' })
describe('plot profiles', () => {
  it.each([['sample_dciv.csv', 'dciv'], ['AC-IV.xls', 'aciv'], ['PUND_Run.xlsx', 'pund'], ['foo C-V.txt', 'cv'], ['cap_camp_dcivfast_20260808T212159Z_0b9865_r000c002_dciv.csv', 'board_csv'], ['run_dciv.csv', 'dciv']] as const)('detects %s', (name, kind) => expect(detectKind([], name)).toBe(kind))
  it('detects board headers', () => expect(detectKind(['v_applied'], 'x')).toBe('board_csv'))
  it('detects PUND headers', () => expect(detectKind(['Psw', 'Qsw'], 'x')).toBe('pund'))
  it('detects AC headers', () => expect(detectKind(['Vforce', 'Imeas'], 'x')).toBe('aciv'))
  it('detects pulse headers', () => expect(detectKind(['t', 'V', 'I'], 'x')).toBe('pulse'))
  it('uses absolute dciv current and drops invalid points', () => { const s = resolveSeries(parsed(['AV', 'AI', 'BI'], [[0, -2, 3], ['bad', 1, 2], [1, null, 2]]), 'dciv'); expect(s.x).toEqual([0]); expect(s.y).toEqual([2]) })
  it('picks lower noise DCIV channel', () => expect(pickDcivChannel(parsed(['AI', 'BI'], [[10, 1], [20, 1], [30, 1]])).toString()).toBe('BI'))
  it('decimates to max points', () => { const xs = Array.from({ length: 6001 }, (_, i) => i); expect(decimate(xs, xs, 5000).x.length).toBeLessThanOrEqual(5000) })
  it('supports an override', () => expect(resolveSeries(parsed(['a', 'b'], [[1, 2]]), 'other', { x: 'a', y: 'b' }).y).toEqual([2]))
})

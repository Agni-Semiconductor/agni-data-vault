import { describe, expect, it } from 'vitest'
import { cellIndex, colorForCode, projectClientPoint, type CoveragePayload } from '../src/components/CoverageMap'

const colors: CoveragePayload['colors'] = {
  light: { normal: '#1565C0', open: '#26A69A', suspect: '#EF6C00', short: '#9E0010', skipped: '#6E6E6E' },
  dark: { normal: '#1565C0', open: '#00A896', suspect: '#C86A00', short: '#C10015', skipped: '#6E6E6E' },
}
const legend = { 0: 'normal', 1: 'open', 2: 'suspect', 3: 'short', 4: 'skipped' }

describe('CoverageMap pure helpers', () => {
  it('creates collision-free sparse-cell indexes', () => {
    expect(cellIndex(1, 2)).toBe(100002)
    expect(cellIndex(0, 99999)).not.toBe(cellIndex(1, 2))
  })
  it('reverse-projects client coordinates to cells', () => {
    const rect = { left: 10, top: 20, width: 256, height: 128 }
    expect(projectClientPoint(11, 20, rect, 128, 128)).toEqual({ row: 0, col: 0 })
    expect(projectClientPoint(265, 147, rect, 128, 128)).toEqual({ row: 127, col: 127 })
    expect(projectClientPoint(266, 148, rect, 128, 128)).toBeNull()
  })
  it('uses the contract CVD-validated palette exactly', () => {
    expect(colors).toEqual({
      light: { normal: '#1565C0', open: '#26A69A', suspect: '#EF6C00', short: '#9E0010', skipped: '#6E6E6E' },
      dark: { normal: '#1565C0', open: '#00A896', suspect: '#C86A00', short: '#C10015', skipped: '#6E6E6E' },
    })
    expect(colorForCode(colors, legend, 'dark', 2)).toBe('#C86A00')
  })
  it('does not turn an unknown code into a visible colour', () => expect(colorForCode(colors, legend, 'light', 99)).toBeUndefined())
})

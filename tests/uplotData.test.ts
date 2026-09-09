import { describe, expect, it } from 'vitest'
import { buildUplotData, decimate, fmtSci, type ResolvedSeries } from '../src/plot/plotProfiles'

const series: ResolvedSeries = { x: [-16, -8, 0, 1, 18], y: [1e-12, null, 1e-6, 2e-9, 1.8e-5], labels: { x: 'AV', y: '|BI|' }, log_y: true }

describe('buildUplotData', () => {
  it('feeds real x values in original order, never indices', () => {
    const built = buildUplotData(series)
    expect(built.data[0]).toEqual([-16, -8, 0, 1, 18])
    expect(built.data[1]).toEqual([1e-12, null, 1e-6, 2e-9, 1.8e-5])
  })
  it('pads xRange by 2%', () => {
    const built = buildUplotData(series)
    expect(built.xRange[0]).toBeCloseTo(-16.68, 10)
    expect(built.xRange[1]).toBeCloseTo(18.68, 10)
  })
  it('keeps log yRange positive with nulls present', () => {
    const built = buildUplotData(series)
    expect(built.yRange[0]).toBeGreaterThan(0)
    expect(built.yRange[0]).toBe(1e-12)
  })
  it('appends y2 as data[2]', () => {
    const built = buildUplotData({ ...series, y2: [1, 2, 3, 4, 5], labels: { ...series.labels, y2: 'Charge' } })
    expect(built.data[2]).toEqual([1, 2, 3, 4, 5])
  })
  it('pads linear yRange by 2%', () => {
    const built = buildUplotData({ ...series, y: [0, 100], log_y: false })
    expect(built.yRange[0]).toBeCloseTo(-2, 10)
    expect(built.yRange[1]).toBeCloseTo(102, 10)
  })
})

describe('decimate', () => {
  it('keeps x and y aligned with real x values', () => {
    const xs = [-4.5, -3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5, 4.5]
    const decimated = decimate(xs, xs.map(Math.abs), 5)
    expect(decimated.x).toEqual([-4.5, -2.5, -0.5, 1.5, 3.5])
    expect(decimated.y).toEqual([4.5, 2.5, 0.5, 1.5, 3.5])
  })
})

describe('fmtSci', () => {
  it('uses exponential for tiny and huge magnitudes', () => {
    expect(fmtSci(1e-9)).toBe('1e-9')
    expect(fmtSci(2e-9)).toBe('2e-9')
    expect(fmtSci(1e-6)).toBe('1e-6')
    expect(fmtSci(2e4)).toBe('2e+4')
  })
  it('uses plain fixed for mid-range', () => {
    expect(fmtSci(4.5)).toBe('4.5')
    expect(fmtSci(0)).toBe('0')
  })
  it('shows only decade ticks on log scales', () => {
    expect(fmtSci(1e-9, true)).toBe('1e-9')
    expect(fmtSci(2e-9, true)).toBe('')
    expect(fmtSci(0, true)).toBe('')
  })
})

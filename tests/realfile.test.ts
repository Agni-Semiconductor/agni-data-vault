import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseFile } from '../src/plot/parseFile'
import { buildUplotData, resolveSeries } from '../src/plot/plotProfiles'

const realPath = process.env.VAULT_REAL_XLSX
const suite = realPath && existsSync(realPath) ? describe : describe.skip

suite('real 20-DC-1 workbook', () => {
  const load = () => {
    const bytes = new Uint8Array(readFileSync(realPath!))
    const parsed = parseFile(bytes, '20-DC-1.xlsx', { sheet: 'Run9602' })
    const avIndex = parsed.headers.findIndex((header) => header.toLowerCase() === 'av')
    return { parsed, avIndex }
  }

  it('resolves the full AV vs |BI| sweep', () => {
    const { parsed } = load()
    const series = resolveSeries(parsed, 'dciv', { log: true })
    expect(series.x.length).toBe(361)
    expect(Math.min(...series.x)).toBe(-4.5)
    expect(Math.max(...series.x)).toBe(4.5)
    for (const value of series.y) expect(value === null || value > 0).toBe(true)
  })

  it('feeds uPlot real AV values, not indices', () => {
    const { parsed, avIndex } = load()
    expect(avIndex).toBeGreaterThanOrEqual(0)
    const series = resolveSeries(parsed, 'dciv', { log: true })
    const built = buildUplotData(series)
    expect(built.data[0][0]).toBe(parsed.rows[0][avIndex])
    expect(built.data[0].length).toBe(361)
    expect(Math.min(...built.data[0])).toBe(-4.5)
    expect(Math.max(...built.data[0])).toBe(4.5)
    expect(built.xRange[0]).toBeLessThan(-4.5)
    expect(built.xRange[1]).toBeGreaterThan(4.5)
    expect(built.yRange[0]).toBeGreaterThan(0)
  })
})

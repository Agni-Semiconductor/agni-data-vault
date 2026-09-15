import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')
const campaigns = read('src/pages/bench/index.tsx')
const detail = read('src/pages/bench/RunDetail.tsx')
const histograms = read('src/pages/bench/Histograms.tsx')

describe('bench page width', () => {
  it('constrains chrome without constraining a page root', () => {
    expect(campaigns).toMatch(/<header className="max-w-2xl"/)
    expect(campaigns).toMatch(/<div className="grid max-w-2xl/)
    expect(detail).toMatch(/<div className="max-w-3xl"/)
    expect(detail).toMatch(/max-w-xl[^>]*>.*No coverage to display/)
    expect(campaigns).not.toMatch(/return <(?:div|section) className="[^"]*max-w-/)
    expect(detail).not.toMatch(/return <(?:div|section) className="[^"]*max-w-/)
    expect(histograms).not.toMatch(/<section className="[^"]*max-w-/)
  })

  it('leaves the map, cell table, and charts wide', () => {
    expect(detail).toMatch(/<CoverageMap coverage=/)
    expect(detail).toMatch(/<section ref={cellTable} className="scroll-mt-6 space-y-3 rounded-lg/)
    expect(histograms).toMatch(/<div className="grid gap-4 xl:grid-cols-2">/)
  })

  it('records the safety reasons for sparse and empty data', () => {
    expect(detail).toMatch(/Untested cells remain blank/)
    expect(histograms).toMatch(/Null values are excluded from every distribution/)
    expect(campaigns).toMatch(/No campaign runs exist for DUT/)
  })
})

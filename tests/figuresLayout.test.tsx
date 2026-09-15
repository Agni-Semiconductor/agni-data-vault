import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const figureList = readFileSync(resolve(process.cwd(), 'src/pages/figures/FigureList.tsx'), 'utf8')
const figureBuilder = readFileSync(resolve(process.cwd(), 'src/pages/figures/FigureBuilder.tsx'), 'utf8')

describe('figure page layout', () => {
  it('keeps both page roots uncapped so they align with the wide shell', () => {
    expect(figureList).toMatch(/return <div className="space-y-4">/)
    expect(figureBuilder).toMatch(/return <div className="space-y-6">/)
  })

  it('caps the saved figure list instead of its page root', () => {
    expect(figureList).toMatch(/<div className="max-w-5xl space-y-4">/)
  })

  it('keeps builder controls bounded beside an unconstrained preview', () => {
    expect(figureBuilder).toMatch(/data-testid="figure-builder-controls" className="min-w-0 max-w-md space-y-3"/)
    expect(figureBuilder).toMatch(/data-testid="figure-builder-preview" className="min-w-0"/)
    expect(figureBuilder).toMatch(/lg:grid-cols-\[minmax\(0,28rem\)_minmax\(0,1fr\)\]/)
  })
})

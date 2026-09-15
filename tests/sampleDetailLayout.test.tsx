import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const page = readFileSync(resolve(process.cwd(), 'src/pages/SampleDetail.tsx'), 'utf8')
const source = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function rootClasses(input: string): string {
  return /return\s*(?:\(\s*)?<div className="([^"]*\bspace-y-6\b[^"]*)"/.exec(input)?.[1] ?? ''
}

function quickFactsClasses(input: string): string {
  return /<section className="([^"]*)"><h2 className="font-semibold">Quick facts/.exec(input)?.[1] ?? ''
}

function measurementGridClasses(input: string): string {
  return /<div className="([^"]*\[grid-template-columns:repeat\(auto-fill,minmax\(300px,1fr\)\)\][^"]*)">\{previewRows/.exec(input)?.[1] ?? ''
}

describe('sample detail reading measures', () => {
  it('keeps the page root width-neutral while constraining the facts component', () => {
    expect(rootClasses(source), 'SampleDetail root must be found').toMatch(/\bspace-y-6\b/)
    expect(rootClasses(source), 'the page root must not own the shell width').not.toMatch(/\bmax-w-/)
    expect(quickFactsClasses(source), 'Quick facts section must be found').toMatch(/\bmax-w-/)
  })

  it('fails the root-width check when given the page-level cap defect', () => {
    const defective = 'return (<div className="space-y-6 max-w-7xl">'
    expect(rootClasses(defective), 'control must contain the defect').toMatch(/\bmax-w-/)
  })

  it('keeps the measurement card grid available to the full shell width', () => {
    expect(measurementGridClasses(source), 'measurement grid must be found').toMatch(/repeat\(auto-fill,minmax\(300px,1fr\)\)/)
    expect(measurementGridClasses(source), 'measurement grid must not be capped').not.toMatch(/\bmax-w-/)
  })
})

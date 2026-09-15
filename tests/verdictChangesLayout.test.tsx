import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const verdictChanges = readFileSync(resolve(process.cwd(), 'src/pages/devices/VerdictChanges.tsx'), 'utf8')
const deviceDetail = readFileSync(resolve(process.cwd(), 'src/pages/devices/DeviceDetail.tsx'), 'utf8')

function rootClasses(page: string): string {
  return /return\s*(?:\(\s*)?<div className="([^"]*\bspace-y-[46]\b[^"]*)"/.exec(page)?.[1] ?? ''
}

describe('device page reading measures', () => {
  it('keeps both page roots width-neutral', () => {
    expect(rootClasses(verdictChanges), 'VerdictChanges root must be found').not.toMatch(/\bmax-w-/)
    expect(rootClasses(deviceDetail), 'DeviceDetail root must be found').not.toMatch(/\bmax-w-/)
  })

  it('constrains prose, summaries, filters, and the device timeline', () => {
    expect(verdictChanges).toMatch(/<header className="max-w-/)
    expect(verdictChanges).toMatch(/<div className="max-w-[^"]* flex flex-wrap[^>]*rounded-lg/)
    expect(deviceDetail).toMatch(/<div className="max-w-3xl">\s*<section className="space-y-3"><div><h2[^>]*>History/)
    expect(deviceDetail).toMatch(/<section className="max-w-3xl rounded-lg[^>]*>.*Address scheme/)
    expect(deviceDetail).toMatch(/<div className="max-w-3xl">/)
  })

  it('keeps the verdict table uncapped', () => {
    expect(verdictChanges).toMatch(/<Table table=\{table\}/)
    expect(verdictChanges).not.toMatch(/<Table[^>]*max-w-/)
  })

  it('fails the root-width control when given the page-level cap defect', () => {
    const defective = 'return (<div className="space-y-6 max-w-7xl">'
    expect(rootClasses(defective)).toMatch(/\bmax-w-/)
  })
})

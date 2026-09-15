import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const page = readFileSync(resolve(process.cwd(), 'src/pages/Dashboard.tsx'), 'utf8')
const source = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function rootClasses(input: string): string {
  return /return\s*\(\s*<div className="([^"]*)"/.exec(input)?.[1] ?? ''
}

function byKindClasses(input: string): string {
  return /<section className="([^"]*)">\s*<h2[^>]*>By kind/.exec(input)?.[1] ?? ''
}

describe('dashboard reading measures', () => {
  it('keeps the page root width-neutral while capping list components', () => {
    expect(rootClasses(source), 'Dashboard root must be found').toMatch(/\bspace-y-6\b/)
    expect(rootClasses(source), 'the page root must not own the shell width').not.toMatch(/\bmax-w-/)
    expect(byKindClasses(source), 'By kind section must be found').toMatch(/\bmax-w-/)
    expect(source).toMatch(/<div className="mt-1 h-2 max-w-[^"]* bg-surface-2">/)
    expect(source).toMatch(/<div[^>]*className="[^"]*\bmax-w-xs\b[^"]*rounded-lg/)
  })

  it('fails the root-width check when given the page-level cap defect', () => {
    const defective = 'return (<div className="space-y-6 max-w-7xl">'
    expect(rootClasses(defective), 'control must contain the defect').toMatch(/\bmax-w-/)
  })

  it('keeps the recent table usable when the available column is narrow', () => {
    expect(source).toMatch(/<div className="mt-3 overflow-x-auto">/)
    expect(source).toMatch(/<table className="min-w-\[[^\"]+\] w-full text-sm">/)
    expect(source).toMatch(/<th className="px-2 py-2 font-medium" scope="col">Sample key<\/th>/)
  })
})

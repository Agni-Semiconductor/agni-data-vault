import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const coverageMap = readFileSync(resolve(process.cwd(), 'src/components/CoverageMap.tsx'), 'utf8')
const lineRates = readFileSync(resolve(process.cwd(), 'src/pages/bench/LineRates.tsx'), 'utf8')

function directives(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function readsSystemTheme(source: string) {
  return /(?:window\.)?matchMedia\(\s*['"]\(prefers-color-scheme:\s*dark\)['"]\s*\)/.test(source)
}

function redrawDependencies(source: string, marker: string) {
  const effect = new RegExp(`use(?:Layout)?Effect\\(\\(\\) => \\{[\\s\\S]*?${marker}[\\s\\S]*?\\}, \\[([^\\]]*)\\]\\)`).exec(source)
  expect(effect, `expected a redraw effect containing ${marker}`).toBeTruthy()
  return effect![1]
}

function hasResolvedThemeDependency(dependencies: string) {
  return /\bresolvedTheme\b/.test(dependencies)
}

describe('chart theme integration', () => {
  it('does not let either chart read the OS preference directly', () => {
    for (const source of [coverageMap, lineRates]) expect(readsSystemTheme(directives(source))).toBe(false)

    // CONTROL: this predicate must recognize the original defect.
    expect(readsSystemTheme("window.matchMedia('(prefers-color-scheme: dark)')")).toBe(true)
  })

  it('gets its resolved colour scheme from the theme context', () => {
    for (const source of [coverageMap, lineRates]) {
      const code = directives(source)
      expect(code).toMatch(/\buseTheme\(\)/)
      expect(code).toMatch(/\bresolved\s*:\s*resolvedTheme\b/)
    }
  })

  it('redraws both charts when the resolved theme changes', () => {
    const coverageDependencies = redrawDependencies(directives(coverageMap), "getContext\\('2d'\\)")
    const lineDependencies = redrawDependencies(directives(lineRates), 'new uPlot')
    expect(hasResolvedThemeDependency(coverageDependencies)).toBe(true)
    expect(hasResolvedThemeDependency(lineDependencies)).toBe(true)

    // CONTROL: a dependency list without the resolved theme must fail this check.
    expect(hasResolvedThemeDependency('[coverage]')).toBe(false)
  })
})

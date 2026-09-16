// Dark mode is only correct if every colour in the app can change with the theme. A Tailwind
// palette class like `gray-700` or `green-800` is a FIXED value: it renders the same on the dark
// ground as it did on white, which makes body text unreadable and success text nearly invisible.
// An arbitrary hex in a className has the same problem and is harder to spot.
//
// 101 such call sites existed across 31 files before this check; the sweep that removed them is
// only durable if something notices the next one.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(process.cwd(), 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(tsx?|css)$/.test(entry)) out.push(path)
  }
  return out
}

/**
 * Where a raw colour is legitimate, and why.
 *
 * Each entry is a decision, not an exemption to be extended casually. A file added here without a
 * reason is how a check stops checking.
 */
const ALLOWED = new Map<string, string>([
  // The token layer itself: this is where the literals are SUPPOSED to live.
  ['src/index.css', 'defines the tokens; every literal here has a light and a dark value'],
  // Data colour, not interface colour. Computed colour-blind-safe values (Okabe-Ito), pinned by
  // tests in this repo and the testbench repo, and served by the API so the client cannot invent
  // them. These must NOT follow the theme -- a verdict that changes colour with the page is a lie.
  ['src/plot/panelData.ts', 'the Okabe-Ito data palette, which is deliberately theme-independent'],
  // Canvas and SVG cannot resolve a CSS variable in a fill; these read themeColor() and need
  // concrete fallbacks.
  ['src/plot/exportSvg.ts', 'SVG export needs concrete colours; it reads themeColor() with fallbacks'],
  ['src/components/crossbarGeometry.ts', 'canvas geometry with concrete fallbacks'],
])

const PALETTE = /\b(?:red|green|blue|gray|grey|slate|zinc|neutral|stone|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|orange)-(?:50|\d{3})\b/
const HEX_IN_CLASS = /className=(?:"|{`)[^"`]*\[#[0-9A-Fa-f]{3,8}\]/

describe('every colour in the app can follow the theme', () => {
  const files = sourceFiles(SRC)

  it('finds a real source tree to scan', () => {
    // A glob that silently matches nothing turns every assertion below into a pass.
    expect(files.length, 'expected to scan the src tree').toBeGreaterThan(30)
  })

  it('uses no fixed Tailwind palette colour', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = file.slice(resolve(process.cwd()).length + 1).replace(/\\/g, '/')
      if (ALLOWED.has(rel)) continue
      const text = readFileSync(file, 'utf8')
      for (const line of text.split('\n')) {
        const m = PALETTE.exec(line)
        if (m) offenders.push(`${rel}: ${m[0]}`)
      }
    }
    expect(offenders, 'these are fixed values and cannot change with the theme').toEqual([])
  })

  it('uses no arbitrary hex inside a className', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = file.slice(resolve(process.cwd()).length + 1).replace(/\\/g, '/')
      if (ALLOWED.has(rel)) continue
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = HEX_IN_CLASS.exec(line)
        if (m) offenders.push(`${rel}: ${m[0].slice(0, 60)}`)
      }
    }
    expect(offenders, 'a hex in a className cannot follow the theme').toEqual([])
  })

  it('both detectors actually fire', () => {
    // The control. Two checks that can only pass are worth nothing, and this file is the kind that
    // gets "tidied" by narrowing a regex until it matches nothing.
    expect(PALETTE.test('className="text-gray-700"'), 'palette detector').toBe(true)
    expect(PALETTE.test('className="bg-green-800 p-2"'), 'palette detector').toBe(true)
    expect(HEX_IN_CLASS.test('className="text-[#B3261E]"'), 'hex detector').toBe(true)
    // And must not fire on the legitimate forms.
    expect(PALETTE.test('className="text-agni-slate"'), 'token names are not palette colours').toBe(false)
    expect(PALETTE.test('grid-cols-3'), 'layout utilities are not colours').toBe(false)
    expect(HEX_IN_CLASS.test("const ink = '#344054'"), 'a hex outside a className is not flagged here').toBe(false)
  })

  it('keeps the allowlist honest', () => {
    // Every allowed file must exist and must carry a stated reason.
    for (const [rel, reason] of ALLOWED) {
      expect(reason.length, `${rel} needs a reason, not just an entry`).toBeGreaterThan(20)
      expect(() => readFileSync(resolve(process.cwd(), rel), 'utf8'), `${rel} is allowlisted but absent`).not.toThrow()
    }
  })
})

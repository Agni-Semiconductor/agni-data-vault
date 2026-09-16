// Dark mode fails in a specific, well-known way: a colour whose only definition lives inside a
// media query or a [data-theme] block is UNDEFINED in the third state -- the default, where the
// user has expressed no preference and nothing is stamped on <html>. The page then renders one
// theme's text on the other theme's ground, and only for the people who never touched the toggle.
//
// These tests read src/index.css as text because that is where the contract lives. jsdom does not
// evaluate @media or resolve var() chains, so asserting on a rendered page here would prove less,
// not more.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

/** The body of the first block whose selector matches, comments stripped. */
function block(selector: string): string {
  const index = css.indexOf(selector)
  expect(index, `src/index.css must contain a ${selector} block`).toBeGreaterThan(-1)
  const open = css.indexOf('{', index)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, '')
    }
  }
  throw new Error(`unbalanced braces after ${selector}`)
}

function declaredNames(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])
}

const rootBody = block(':root {')
const rootNames = new Set(declaredNames(rootBody))

describe('theme tokens', () => {
  it('defines every dark override on bare :root as well', () => {
    // THE BUG THIS PREVENTS. Adding a token to the dark block and forgetting the light one leaves
    // it undefined for every viewer on a light or un-stamped system.
    const dark = declaredNames(block(':root[data-theme="dark"]'))
    expect(dark.length, 'expected the dark block to override tokens').toBeGreaterThan(5)
    for (const name of dark) {
      if (name === '--color-scheme') continue
      expect(rootNames.has(name), `${name} is set for dark but never defined on :root`).toBe(true)
    }
  })

  it('keeps the explicit choice and the system preference in step', () => {
    // Two blocks describe dark: the media query for "system", and [data-theme="dark"] for an
    // explicit choice. A token added to one and not the other means the toggle and the OS produce
    // visibly different pages -- the kind of difference nobody reproduces on demand.
    const media = declaredNames(block('@media (prefers-color-scheme: dark)'))
    const explicit = declaredNames(block(':root[data-theme="dark"]'))
    expect(new Set(media)).toEqual(new Set(explicit))
  })

  it('guards the system block so an explicit light choice still wins', () => {
    // Without :not([data-theme="light"]) the media query beats the attribute, and choosing Light on
    // a dark machine does nothing -- a toggle that visibly fails to toggle.
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/)
  })

  it('resolves every utility colour through a variable rather than a literal', () => {
    // The @theme block generates the utility classes the app already uses by name. If a colour
    // there is a literal, that utility cannot follow the theme, and the ~200 existing call sites
    // would each need editing to support dark mode.
    const theme = block('@theme {')
    const literals = [...theme.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/g)].map((m) => `${m[1]}: ${m[2]}`)
    expect(literals, 'these utility colours are hard-coded and cannot change with the theme').toEqual([])
  })

  it('remaps white to the surface token', () => {
    // 66 places say `bg-white` meaning "the raised surface". A literal white card on a dark page is
    // the most visible way to get this wrong, so `white` is the surface here by decision.
    expect(block('@theme {')).toMatch(/--color-white:\s*var\(--surface-1\)/)
  })

  it('paints the body from a token', () => {
    // The page composites over whatever the host paints. A body with no explicit background borrows
    // it, and the result is text from one theme on a ground from the other.
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--surface-1\)/)
  })

  it('sets color-scheme in both directions so native controls follow', () => {
    // Date inputs, scrollbars and select popups are drawn by the browser, not by this stylesheet.
    // Without color-scheme they stay light on a dark page -- the filter panel is full of them.
    expect(rootBody).toMatch(/color-scheme:\s*light/)
    expect(block(':root[data-theme="dark"]')).toMatch(/color-scheme:\s*dark/)
  })
})

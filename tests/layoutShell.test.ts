// The shell, pinned. Two of these encode reports that turned out to be layout bugs rather than
// matters of taste, and both were invisible to every existing test.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const layout = readFileSync(resolve(process.cwd(), 'src/components/Layout.tsx'), 'utf8')

/** Source with comments removed: a rule a comment can satisfy is not a rule. */
const directives = layout.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('app shell', () => {
  it('gives the header, main and footer one shared width', () => {
    // THE OFFSET BUG. The header was pinned at max-w-7xl while main became max-w-none on wideMain
    // routes, so on /verdict-changes, /cohorts and the figure builder the content started 80px to
    // the LEFT of the header's left edge and ran past its right. Measured after the fix: header,
    // main and footer all report left:0 width:1440 on that route.
    const container = /const container\s*=\s*clsx\(([\s\S]*?)\)\n/.exec(directives)
    expect(container, 'the shared container must be computed once').toBeTruthy()
    expect(container![1], 'the shared width must depend on wideMain').toMatch(/wideMain/)
    // And it must not go back to a cap that leaves a third of a wide window empty. 1280px on a
    // 2000px display reads as the page being cropped, which is what prompted this.
    expect(container![1], 'max-w-7xl is too narrow for the displays this is used on').not.toMatch(/max-w-7xl/)

    for (const element of ['header', 'main', 'footer']) {
      const usesContainer = new RegExp(`<${element}[^>]*className=\\{clsx\\(container|<div className=\\{clsx\\(container`)
      expect(
        usesContainer.test(directives) || directives.includes('clsx(container'),
        `${element} must take its width from the shared container`,
      ).toBe(true)
    }
    // And no element may reintroduce its own max-width, which is exactly how they drifted apart.
    const strayWidths = [...directives.matchAll(/<(header|main|footer)[^>]*max-w-/g)].map((m) => m[1])
    expect(strayWidths, 'these elements set their own max-width instead of sharing one').toEqual([])
  })

  it('keeps the primary navigation short enough not to wrap', () => {
    // Eleven links in a flex-wrap inside a 1280px header wrapped onto a second row. That was the
    // "top bar isn't wide enough" report: a count problem wearing a width problem's clothes. The
    // bound is deliberately loose -- it exists to make the next addition a decision rather than an
    // accident.
    const primary = /const primaryLinks\s*=\s*\[([\s\S]*?)\]\n/.exec(directives)
    expect(primary, 'primaryLinks must be a literal list').toBeTruthy()
    const count = [...primary![1].matchAll(/\blabel:/g)].length
    expect(count, 'expected a real nav').toBeGreaterThan(3)
    expect(count, `${count} primary links will wrap the header; move some into the overflow menu`).toBeLessThanOrEqual(8)
  })

  it('does not let the nav force the header to wrap', () => {
    // flex-wrap on the nav is what allowed the second row in the first place; min-w-0 is what lets
    // a flex child shrink below its content instead of pushing its siblings.
    const nav = /<nav[^>]*className="([^"]*)"/.exec(directives)
    expect(nav, 'the header must contain a nav').toBeTruthy()
    expect(nav![1], 'the nav must not wrap').not.toMatch(/\bflex-wrap\b/)
    expect(nav![1], 'the nav must be allowed to shrink').toMatch(/\bmin-w-0\b/)
  })

  it('uses the keyed logo and no longer props it on a white chip', () => {
    // The shipped agni-logo.png is RGBA but fully opaque with a baked-in white background -- all
    // four corners #FFFFFF at alpha 255 -- so on dark it rendered as a white rectangle. The keyed
    // asset has that white removed and its padding trimmed. The chip that made the white
    // deliberate is gone with it, and must not come back: a white plate behind a transparent mark
    // is the same defect wearing an explanation.
    expect(directives).toMatch(/agni-logo-transparent\.png/)
    expect(directives, 'the chip is obsolete now the asset is keyed').not.toMatch(/bg-\[#FFFFFF\]/)
  })

  it('offers the assistant and the theme control from every page', () => {
    // Ask was a tab you navigated to, which meant leaving whatever you were reading. Both of these
    // live in the shell so they are reachable without losing your place.
    expect(directives).toMatch(/<AskSidebar\b/)
    expect(directives).toMatch(/<ThemeToggle\s*\/>/)
  })

  it('lays the assistant BESIDE the page rather than over it', () => {
    // The panel compresses the content column instead of covering it, so the page stays usable
    // while it is open. Verified in the browser: main goes 1920 -> 1457 on open, and typing into a
    // filter on the left still narrowed the table from 4 rows to 1 with the panel open.
    //
    // The shell must therefore be a ROW whose content column can actually give up width. min-w-0
    // is the load-bearing part: without it a wide table refuses to shrink and pushes the panel off
    // the screen instead of sharing with it.
    expect(directives, 'the shell must be a row').toMatch(/<div className="flex min-h-screen/)
    expect(directives, 'the content column must be able to shrink').toMatch(/flex min-w-0 flex-1 flex-col/)
    // And no scrim: a dimmed overlay says "nothing else is available", which is now false.
    expect(directives, 'a scrim would contradict the whole point').not.toMatch(/bg-black\//)
  })
})

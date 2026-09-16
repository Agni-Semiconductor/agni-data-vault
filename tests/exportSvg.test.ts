// Vector export. These are pure string functions on purpose -- an exported figure is a file
// somebody puts in a paper, and the properties below are the ones that make it wrong in ways
// nobody notices until it is printed.
import { describe, expect, it, vi } from 'vitest'
import { esc, figureNotes, figureToSvg, niceTicks, parseLayout, type SvgPanel } from '../src/plot/exportSvg'
import type { ResolvedPanel, ResolvedTrace } from '../src/plot/resolveTraces'

const trace = (over: Partial<ResolvedTrace> = {}): ResolvedTrace => ({
  x: [0, 1, 2, 3], y: [1, 2, 3, 4], label: 'I', unit: 'A', factor: 1, points: 4, decimated: false, ...over,
})
const panel = (over: Partial<ResolvedPanel> = {}): ResolvedPanel => ({
  traces: [trace()], refusals: [], unit: 'A', xRange: [0, 3], yRange: [1, 4], log_y: false, ...over,
})
const item = (over: Partial<SvgPanel> = {}): SvgPanel => ({ panel: panel(), ...over })

describe('the file is well-formed XML', () => {
  it('escapes label text rather than emitting it raw', () => {
    // A trace called "I<0 & noisy" makes the file unopenable, and the failure surfaces in
    // whatever application the author tried to place it in rather than here.
    const svg = figureToSvg([item({ panel: panel({ traces: [trace({ label: 'I<0 & "noisy"' })] }) })], { title: 'A & B' })
    expect(svg).not.toMatch(/>I<0 & /)
    expect(svg).toContain('I&lt;0 &amp; &quot;noisy&quot;')
    expect(svg).toContain('<title>A &amp; B</title>')
  })

  it('escapes every XML metacharacter', () => {
    expect(esc(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;')
    expect(esc(null)).toBe('')
  })

  it('parses in a real XML parser', () => {
    const svg = figureToSvg([item(), item()], { title: 'Two panels', subtitle: 'x vs y', layout: '1x2' })
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.tagName).toBe('svg')
  })
})

describe('a physical size, and a grid that cannot lose a panel', () => {
  it('carries millimetres as well as a viewBox', () => {
    // Without a physical size the importing application guesses, and a figure authored at 180mm
    // arrives at whatever width the guess produced -- which is where a 6pt axis label comes from.
    const svg = figureToSvg([item()], { widthMm: 180, heightMm: 120 })
    expect(svg).toContain('width="180mm"')
    expect(svg).toContain('height="120mm"')
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/)
  })

  it('grows a layout too small for its panels instead of dropping them', () => {
    // '1x1' with four panels is a spec someone edited halfway. Honouring it literally would
    // silently export one quarter of the figure.
    expect(parseLayout('1x1', 4)).toEqual({ rows: 2, cols: 2 })
    expect(parseLayout('2x2', 4)).toEqual({ rows: 2, cols: 2 })
    expect(parseLayout('2x3', 4)).toEqual({ rows: 2, cols: 3 })
    expect(parseLayout(undefined, 1)).toEqual({ rows: 1, cols: 1 })
    expect(parseLayout('nonsense', 3)).toEqual({ rows: 2, cols: 2 })
  })

  it('draws one path per trace across every panel', () => {
    const svg = figureToSvg([item({ panel: panel({ traces: [trace(), trace({ label: 'V' })] }) }), item()], { layout: '1x2' })
    expect(svg.match(/<path /g)).toHaveLength(3)
  })
})

describe('nulls break the line, they do not get bridged', () => {
  it('starts a new subpath after a gap', () => {
    // `spanGaps: false` on screen and here. A null is a point the transform REFUSED, and drawing
    // straight through it puts a line where nothing was measured -- which a reader takes as data.
    const svg = figureToSvg([item({ panel: panel({ traces: [trace({ x: [0, 1, 2, 3], y: [1, null, 3, 4] })] }) })])
    const d = /<path d="([^"]*)"/.exec(svg)![1]
    expect(d.match(/M/g)).toHaveLength(2)
    expect(d).not.toMatch(/M[\d.,]+ L[\d.,]+ L[\d.,]+ L[\d.,]+$/)
  })

  it('drops a non-positive point on a log axis rather than emitting NaN coordinates', () => {
    // Math.log10(0) is -Infinity, and an -Infinity in a path attribute makes the whole path
    // invalid -- the trace vanishes entirely rather than losing one point.
    const svg = figureToSvg([item({ panel: panel({ log_y: true, yRange: [1, 1000], traces: [trace({ x: [0, 1, 2], y: [10, 0, 100] })] }) })])
    const d = /<path d="([^"]*)"/.exec(svg)![1]
    expect(d).not.toContain('NaN')
    expect(d).not.toContain('Infinity')
    expect(d.match(/M/g)).toHaveLength(2)
  })
})

describe('a log axis is mapped through log10, not drawn linearly', () => {
  it('places a decade at the geometric midpoint, not the arithmetic one', () => {
    // The whole point of a log axis. Drawn linearly, 10 between 1 and 100 sits at 9% of the
    // height instead of 50% -- and the curve still looks like a curve, so nothing announces it.
    const svg = figureToSvg([item({ panel: panel({ log_y: true, yRange: [1, 100], traces: [trace({ x: [0], y: [10] })] }) })])
    const [, y] = /<path d="M[\d.]+,([\d.]+)"/.exec(svg)!
    const [, top, height] = /<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill="none"/.exec(svg)!
    expect(Number(y)).toBeCloseTo(Number(top) + Number(height) / 2, 1)
  })

  it('uses decade ticks on a log axis, never 1.7e-9', () => {
    expect(niceTicks(-9, -6, 5, true)).toEqual([-9, -8, -7, -6])
  })
})

describe('nice ticks', () => {
  it('lands on 1/2/2.5/5 times a power of ten, inside the range', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6000000000000001, 0.8, 1].map((v) => Number(v.toPrecision(12))))
    for (const tick of niceTicks(-4.5, 4.5, 5)) { expect(tick).toBeGreaterThanOrEqual(-4.5); expect(tick).toBeLessThanOrEqual(4.5) }
  })

  it('does not accumulate floating point error into a label', () => {
    // 0.1 added thirty times is 3.0000000000000004, and that reaches a tick label on the axis.
    for (const tick of niceTicks(0, 3, 30)) expect(String(tick).length).toBeLessThan(8)
  })

  it('returns nothing for a degenerate range rather than looping', () => {
    expect(niceTicks(1, 1)).toEqual([])
    expect(niceTicks(Number.NaN, 1)).toEqual([])
    expect(niceTicks(5, 1)).toEqual([])
  })
})

describe('what must survive the export', () => {
  it('records a decimated trace, a unit conversion and a refusal in the footer', () => {
    // A reader of an SVG has no badge to hover. A figure that quietly drops a refused trace and
    // silently thins another is a figure making claims its author can no longer check.
    const panels = [item({ panel: panel({
      traces: [trace({ decimated: true, points: 5000 }), trace({ label: 'legacy', factor: 0.001, unit: 'A' })],
      refusals: [{ label: 'board', reason: 'cannot convert V to A' }],
    }) })]
    const notes = figureNotes(panels)
    expect(notes.some((note) => note.includes('decimated'))).toBe(true)
    expect(notes.some((note) => note.includes('legacy -> A'))).toBe(true)
    expect(notes.some((note) => note.includes('refused'))).toBe(true)
    const svg = figureToSvg(panels)
    for (const note of notes) expect(svg).toContain(note.replace(/>/g, '&gt;'))
  })

  it('numbers the panel a note came from when there is more than one', () => {
    const notes = figureNotes([item(), item({ panel: panel({ refusals: [{ label: 'b', reason: 'no file' }] }) })])
    expect(notes[0]).toMatch(/^Panel 2: /)
  })

  it('says so on the figure when a panel has nothing plottable', () => {
    // Blank reads as a rendering failure. The bench viewer's empty-state rule, applied to a file
    // that will be looked at somewhere with no console.
    const svg = figureToSvg([item({ panel: panel({ xRange: [0, 0], yRange: [0, 0], traces: [] }) })])
    expect(svg).toContain('no plottable points in range')
    expect(svg).not.toContain('NaN')
  })

  it('never emits NaN into a coordinate from a degenerate range', () => {
    const svg = figureToSvg([item({ panel: panel({ log_y: true, yRange: [0, 100] }) })])
    expect(svg).not.toContain('NaN')
  })
})

describe('downloadSvg', () => {
  it('hands the browser an image/svg+xml blob under the given name', async () => {
    const { downloadSvg } = await import('../src/plot/exportSvg')
    let name = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download })
    const createObjectURL: (blob: Blob) => string = vi.fn(() => 'blob:svg')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    downloadSvg('<svg/>', 'figure.svg')
    expect(name).toBe('figure.svg')
    expect(vi.mocked(createObjectURL).mock.calls[0]![0].type).toBe('image/svg+xml;charset=utf-8')
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  })
})

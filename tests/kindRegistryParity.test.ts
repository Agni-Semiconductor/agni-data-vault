// The plot profiles in the frontend and the `measurement_kinds` registry in the database must
// describe the same axes. This test is the only thing that makes that true over time.
//
// WHY IT EXISTS. Until 0111 the canonical axis columns lived in code, in THREE places at once:
// `PROFILES` here, the bench's `campaign_log.COLUMN_UNITS`, and fed_viewer's own column lists.
// Three copies of one fact is how a unit mismatch happens. 0111/0112 made the database
// authoritative, but `PROFILES` is still a literal — it has to be, because `resolveSeries` is a
// pure synchronous function that a chart calls during render, and making it await a fetch would
// push async through QuickPlot, MeasurementCard and every test above them.
//
// So the literal stays and this test pins it to the migration. The failure it catches is the
// quiet one: someone adds a kind or changes an axis in SQL, the frontend keeps plotting the old
// columns, and the chart still renders — just of something else. A drifted axis does not throw.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROFILES, type PlotKind } from '../src/plot/plotProfiles'

// Resolved from the vitest root rather than `import.meta.url`: under the test transform that
// URL is not a file: URL, and `new URL('../x', it)` silently resolved to C:\supabase\... —
// a path that does not exist, which is a suite that fails for the wrong reason.
const sql = (name: string) => {
  const path = resolve(process.cwd(), 'supabase/migrations/selfhost', name)
  if (!existsSync(path)) throw new Error(`migration not found: ${path} — this test pins the frontend to it, so a rename must fail here loudly rather than skip`)
  return readFileSync(path, 'utf8')
}

type KindRow = { kind: string; x_col: string[]; y_col: string[]; y2_col: string[]; x_unit: string | null; y_unit: string | null; y2_unit: string | null; abs_y: boolean; log_y: boolean }

/** Parse the seed rows out of 0111's `insert into vault.measurement_kinds ... values (...)`. */
function parseKinds(text: string): KindRow[] {
  const start = text.indexOf('insert into vault.measurement_kinds')
  const body = text.slice(start, text.indexOf('on conflict (kind) do nothing', start))
  const arr = (raw: string) => raw === '{}' ? [] : raw.slice(1, -1).split(',').filter(Boolean)
  const lit = (raw: string) => raw === 'null' ? null : raw.slice(1, -1)
  const rows: KindRow[] = []
  // Each row opens at a line-leading `  ('<kind>',`. Anchoring on that rather than on every `(`
  // keeps the parens inside the notes text (e.g. "(0->+Vmax)") from splitting a row in half.
  const re = /^ {2}\('([a-z_0-9]+)',\s*'((?:[^']|'')*)',\s*('(?:\{[^}]*\})'|'\{\}'),\s*('(?:\{[^}]*\})'|'\{\}'),\s*('(?:\{[^}]*\})'|'\{\}'),\s*('[^']*'|null),\s*('[^']*'|null),\s*('[^']*'|null),\s*(true|false),\s*(true|false)/gm
  for (const m of body.matchAll(re)) {
    rows.push({
      kind: m[1], x_col: arr(m[3].slice(1, -1)), y_col: arr(m[4].slice(1, -1)), y2_col: arr(m[5].slice(1, -1)),
      x_unit: lit(m[6]), y_unit: lit(m[7]), y2_unit: lit(m[8]), abs_y: m[9] === 'true', log_y: m[10] === 'true',
    })
  }
  return rows
}

const kinds = parseKinds(sql('0111_metrics_and_kinds.sql'))
const units0112 = sql('0112_units_and_figures.sql')

describe('measurement_kinds ↔ PROFILES parity', () => {
  // A regex that silently matches nothing would make every assertion below pass over an empty
  // array. That is a vacuous green: the test would keep reporting success while pinning nothing
  // at all. Assert the parse worked BEFORE trusting anything it produced.
  it('parsed every seeded kind out of the migration', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(7)
    expect(kinds.map((k) => k.kind).sort()).toEqual(['aciv', 'board_csv', 'cv', 'dciv', 'pulse', 'pund', 'res2t'])
    for (const k of kinds) expect(k.y_col.length, `${k.kind} parsed with no y_col`).toBeGreaterThan(0)
  })

  it('every kind the database declares has a frontend profile', () => {
    // The reverse is allowed: `other` exists only in the frontend, as the fallback for a file
    // whose kind could not be detected at all. It is not a measurement kind and has no row.
    const missing = kinds.map((k) => k.kind).filter((k) => !(k in PROFILES))
    expect(missing, 'kinds in SQL with no PROFILES entry').toEqual([])
  })

  it.each(kinds.map((k) => [k.kind, k] as const))('%s plots the columns the registry declares', (_name, row) => {
    const profile = PROFILES[row.kind as PlotKind]
    expect(profile.x).toEqual(row.x_col)
    expect(profile.y).toEqual(row.y_col)
    expect(profile.y2 ?? []).toEqual(row.y2_col)
    expect(Boolean(profile.abs_y)).toBe(row.abs_y)
    expect(Boolean(profile.log_y)).toBe(row.log_y)
  })
})

describe('the unit facts these two files exist to keep straight', () => {
  it('board_csv has NO axis-level y_unit, because its y_col spans two units', () => {
    // This is the defect 0112 corrects. `y_col` is {i_a, current_mA} — amperes AND
    // milliamperes — so a single axis unit is a lie, and a capture carrying only the legacy
    // column would be labelled amperes: 1000x high, on a log axis, looking like real data.
    const board = kinds.find((k) => k.kind === 'board_csv')!
    expect(board.y_col).toEqual(['i_a', 'current_mA'])
    expect(units0112).toMatch(/update vault\.measurement_kinds\s+set y_unit = null/)
    expect(units0112.slice(units0112.indexOf('set y_unit = null'))).toMatch(/where kind = 'board_csv'/)
  })

  it('amperes-first ordering is preserved, since the fallback list IS the disambiguation', () => {
    // With no axis unit, the only thing standing between a reader and a 1000x error is that
    // `i_a` is tried before `current_mA`. Reversing this list would be a silent three-decade
    // shift on every board capture that has both columns.
    const board = kinds.find((k) => k.kind === 'board_csv')!
    expect(board.y_col.indexOf('i_a')).toBeLessThan(board.y_col.indexOf('current_mA'))
    expect(PROFILES.board_csv.y.indexOf('i_a')).toBeLessThan(PROFILES.board_csv.y.indexOf('current_mA'))
  })

  it('column_units records i_a and current_mA as DIFFERENT units', () => {
    // Seeded verbatim from the bench's COLUMN_UNITS, which calls current_mA "the cautionary
    // tale of a unit that lives only inside a column name".
    expect(units0112).toMatch(/\('i_a',\s*'A'/)
    expect(units0112).toMatch(/\('current_mA',\s*'mA'/)
  })
})

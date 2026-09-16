// The unified cluster must be a SUPERSET of the two databases it replaces, or metadata is lost on
// the way in and nobody finds out until someone goes looking for a field that used to be there.
//
// The vault half of that union is what this repo owns. The hosted vault lived in `public` on a
// Supabase project (supabase/migrations/000*.sql); the unified cluster puts the same tables in
// `vault` (supabase/migrations/selfhost/01*.sql), alongside the bench's `public`. Those two
// directories were written months apart, and the second is not a mechanical rewrite of the first
// -- it has been through twenty migrations that promoted columns out of `meta`, added a `bucket`,
// and hung a device and a bench run off `measurements`. Any one of those edits could have dropped
// a column from the original while every test still passed, because no test compared them.
//
// The direction that matters is one-way. A column in the new schema and not the old one is a
// feature. A column in the OLD schema and not the new one is data that has nowhere to land when
// the hosted rows are finally imported -- and the import is the moment it is discovered, which is
// the worst moment.
//
// The bench half of the union (public.* -- duts, captures, campaign_runs, device_tests, ...) lives
// in ferrodiode-pcb-testbench and cannot be read from here. It is checked the same way, in that
// repo; docs/SCHEMA_UNION.md records the result and the date.
//
// Parsing DDL with regexes is approximate, so every helper below is exported and tested against
// fixtures, and anything the column parser cannot classify is asserted to be empty rather than
// dropped -- an unparsed fragment is a column this test cannot see, which is exactly the blind
// spot it exists to close.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrations = resolve(root, 'supabase/migrations')

/** Removes SQL comments so prose naming a column cannot stand in for the column. */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '')
}

/**
 * Splits a CREATE TABLE body on the commas that separate its definitions.
 *
 * Newlines will not do: 0101_core.sql packs six columns onto one physical line, and splitting on
 * `\n` silently finds only the first of each six. Splitting on depth-0 commas keeps
 * `numeric(10, 2)` and `check (kind in ('a', 'b'))` in one piece.
 */
export function splitDefinitions(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''
  for (const ch of body) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

const TYPES = [
  'text\\[\\]', 'integer\\[\\]', 'uuid\\[\\]', 'double precision', 'timestamptz', 'timestamp',
  'bigserial', 'smallint', 'boolean', 'numeric', 'bigint', 'integer', 'citext', 'bytea', 'jsonb',
  'uuid', 'date', 'json', 'text', 'bool', 'real', 'int',
].join('|')
const COLUMN = new RegExp(`^([a-z_][a-z_0-9]*)\\s+(${TYPES})\\b`, 'i')
const QUOTED_COLUMN = new RegExp(`^"([a-z_][a-z_0-9]*)"\\s+(${TYPES})\\b`, 'i')
/** Table constraints share the comma-separated list with columns and are not columns. */
const CONSTRAINT = /^(primary\s+key|unique|foreign\s+key|constraint|check|exclude|like)\b/i

export type Schema = Map<string, Map<string, string>>

/** Every column this parser could not classify, so a blind spot cannot read as an absence. */
export const unparsed: string[] = []

export function parseTables(sql: string, defaultSchema: string): Schema {
  const tables: Schema = new Map()
  const create = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_0-9."]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi
  let match: RegExpExecArray | null
  while ((match = create.exec(sql)) !== null) {
    const name = qualify(match[1], defaultSchema)
    const columns = tables.get(name) ?? new Map<string, string>()
    tables.set(name, columns)
    for (const definition of splitDefinitions(match[2])) {
      if (CONSTRAINT.test(definition)) continue
      const column = COLUMN.exec(definition) ?? QUOTED_COLUMN.exec(definition)
      if (column) {
        if (!columns.has(column[1].toLowerCase())) columns.set(column[1].toLowerCase(), column[2].toLowerCase())
      } else {
        unparsed.push(`${name}: ${definition.slice(0, 70)}`)
      }
    }
  }
  // Columns added later are as real as columns created inline -- and ONE statement may add
  // several. 0108 adds `bench_dut_id` and `bench_run_id` in a single `alter table`, so a regex
  // anchored on `alter table ... add column` finds the first and silently loses the second. That
  // is precisely the shape of loss this file exists to detect, so it must not have it itself.
  const statement = /alter\s+table\s+(?:only\s+)?([a-z_0-9."]+)([\s\S]*?);/gi
  const clause = new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_0-9]+)\\s+(${TYPES})\\b`, 'gi')
  while ((match = statement.exec(sql)) !== null) {
    const name = qualify(match[1], defaultSchema)
    const body = match[2]
    let added: RegExpExecArray | null
    clause.lastIndex = 0
    while ((added = clause.exec(body)) !== null) {
      const columns = tables.get(name) ?? new Map<string, string>()
      tables.set(name, columns)
      if (!columns.has(added[1].toLowerCase())) columns.set(added[1].toLowerCase(), added[2].toLowerCase())
    }
  }
  return tables
}

function qualify(name: string, defaultSchema: string): string {
  const bare = name.replace(/"/g, '').toLowerCase()
  return bare.includes('.') ? bare : `${defaultSchema}.${bare}`
}

const read = (dir: string, file: string) => stripComments(readFileSync(resolve(dir, file), 'utf8'))
const sqlIn = (dir: string, pattern: RegExp) => readdirSync(dir).filter((f) => pattern.test(f)).sort()

const hostedDir = migrations
const selfhostDir = resolve(migrations, 'selfhost')
const hostedFiles = sqlIn(hostedDir, /^000\d_.*\.sql$/)
const selfhostFiles = sqlIn(selfhostDir, /^01\d\d_.*\.sql$/)

// The hosted vault's tables were unqualified in `public`; the same tables are `vault.*` now.
// Rewriting the schema name is what makes the two comparable at all, and it is the ONLY
// transformation applied -- a rename is not a redesign, and anything else would let this test
// paper over a real difference.
const hosted = parseTables(hostedFiles.map((f) => read(hostedDir, f)).join('\n').replace(/\bpublic\./g, 'vault.'), 'vault')
const selfhost = parseTables(selfhostFiles.map((f) => read(selfhostDir, f)).join('\n'), 'vault')

describe('the unified cluster is a superset of the hosted vault it replaces', () => {
  it('found both schemas to compare at all', () => {
    // Without this the two comparisons below iterate empty maps and pass while checking nothing:
    // a deleted migrations directory would read as a verified superset.
    expect(hostedFiles.length, 'expected the hosted vault migrations 0001 through 0006').toBe(6)
    expect(selfhostFiles.length, 'expected the self-hosted migrations 0100 onward').toBeGreaterThanOrEqual(20)
    expect(hosted.size, 'hosted vault tables').toBeGreaterThanOrEqual(8)
    expect(selfhost.size, 'self-hosted vault tables').toBeGreaterThan(hosted.size)
  })

  it('parses columns rather than merely finding table names', () => {
    // The failure this guards is a COLUMN regex that matches nothing: every table would exist with
    // zero columns, and "every hosted column exists" would hold vacuously.
    const total = [...hosted.values()].reduce((sum, columns) => sum + columns.size, 0)
    expect(total, 'hosted vault columns parsed').toBeGreaterThanOrEqual(80)
    expect(hosted.get('vault.samples')?.get('substrate_size')).toBe('text')
    expect(hosted.get('vault.measurements')?.get('meta')).toBe('jsonb')
    expect(hosted.get('vault.samples')?.has('a_column_that_never_existed')).toBe(false)
  })

  it('finds every column of a multi-column ALTER, not just the first', () => {
    // The bug this pins: `add column a text, add column b text` in one statement parsed as `a`
    // alone, which made `vault.measurements.bench_run_id` -- half the bench join key -- invisible.
    const fixture = parseTables(
      [
        'create table vault.t (',
        '  id uuid primary key,',
        '  kind text',
        ');',
        'alter table vault.t',
        '  add column if not exists first_added text,',
        '  add column if not exists second_added text;',
      ].join('\n'),
      'vault',
    )
    expect([...(fixture.get('vault.t')?.keys() ?? [])]).toEqual(['id', 'kind', 'first_added', 'second_added'])
  })

  it('parses every CREATE TABLE it is given, so an unmatched one cannot read as an absent table', () => {
    // The table regex is anchored on a closing paren at the start of a line, which is how every
    // migration here is written. A future migration written on ONE line would not match, the table
    // would be missing from BOTH maps, and "no table was lost" would hold because neither side
    // could see it. Counting the statements closes that.
    const statements = (sql: string) => (sql.match(/create\s+table\s/gi) ?? []).length
    const hostedSql = hostedFiles.map((f) => read(hostedDir, f)).join('\n')
    const selfhostSql = selfhostFiles.map((f) => read(selfhostDir, f)).join('\n')
    expect(hosted.size, 'hosted CREATE TABLE statements parsed').toBe(statements(hostedSql))
    expect(selfhost.size, 'self-hosted CREATE TABLE statements parsed').toBe(statements(selfhostSql))
  })

  it('classifies every definition, so no column is invisible to this test', () => {
    expect(unparsed, 'unparsed CREATE TABLE definitions').toEqual([])
  })

  it('keeps every table the hosted vault had', () => {
    const missing = [...hosted.keys()].filter((table) => !selfhost.has(table))
    expect(missing, 'hosted vault tables with no counterpart in the unified cluster').toEqual([])
  })

  it('keeps every column the hosted vault had', () => {
    const missing: string[] = []
    for (const [table, columns] of hosted) {
      for (const column of columns.keys()) {
        if (!selfhost.get(table)?.has(column)) missing.push(`${table}.${column}`)
      }
    }
    // A column here has hosted rows with nowhere to land. Add it to the schema; do not delete the
    // assertion.
    expect(missing, 'hosted vault columns absent from the unified cluster').toEqual([])
  })
})

describe('the union carries the joins that make both halves one dataset', () => {
  it('points measurements at the bench campaign that produced them', () => {
    // Without these two, a vault measurement and the bench run behind it are separate facts in
    // separate schemas, and the union is two databases sharing a socket.
    const measurements = selfhost.get('vault.measurements')
    expect(measurements?.has('bench_run_id')).toBe(true)
    expect(measurements?.has('bench_dut_id')).toBe(true)
  })

  it('lets a vault file reference bytes the bench owns instead of copying them', () => {
    expect(selfhost.get('vault.files')?.has('bucket')).toBe(true)
  })

  it('keeps the dut-to-sample mapping a declared table rather than a derivation', () => {
    // Bench `2kb-dut-01` and vault `HfN_20_0421` are unrelated namespaces. A guess here
    // misattributes real measurements to the wrong physical sample, which is worse than no link.
    const map = selfhost.get('vault.dut_sample_map')
    expect(map?.has('dut_id')).toBe(true)
    expect(map?.has('sample_id')).toBe(true)
  })
})

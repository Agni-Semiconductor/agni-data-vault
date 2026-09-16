// @ts-nocheck
// /api/schema must list every surface the router actually serves.
//
// The contract calls this "the self-describing document an agent needs", and `cli/vault.py`
// validates its flags against it. A route missing from it is a route a caller has no way to
// discover — as far as an agent is concerned the feature does not exist.
//
// This test exists because that is exactly what happened: seven whole surfaces (kinds, figures,
// cohorts, cohort-keys, devices, verdict-changes, search) were built, wired and tested while
// /api/schema listed none of them. Nothing failed. The API worked; it was simply undiscoverable.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => { throw new Error('not needed') } }))
const { buildSchemaDoc } = await import('../api/_lib/schemaDoc.js')

/** Every top-level segment the router branches on, read from its source. */
function routerSegments(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'api/_lib/router.js'), 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/a==='([a-z-]+)'/g)) found.add(match[1])
  return [...found].sort()
}

describe('/api/schema lists what the router serves', () => {
  it('found the router branches at all', () => {
    // A regex that matched nothing would make every assertion below iterate an empty list and
    // report green while checking nothing — the vacuous-green trap.
    const segments = routerSegments()
    expect(segments.length).toBeGreaterThan(10)
    expect(segments).toContain('samples')
  })

  it('every routed surface appears in the schema document', async () => {
    const doc = await buildSchemaDoc()
    const paths = doc.routes.map((r: { path: string }) => r.path)
    // `schema` documents itself by being the document; `me` is listed explicitly.
    const exempt = new Set(['schema'])
    const missing = routerSegments()
      .filter((segment) => !exempt.has(segment))
      .filter((segment) => !paths.some((path: string) => path === `/api/${segment}` || path.startsWith(`/api/${segment}/`)))
    expect(missing, 'routed but undiscoverable — add them to schemaDoc.js').toEqual([])
  })

  it('degrades to a warning rather than a crash when field definitions are unreachable', async () => {
    // /api/schema is what a CLI hits first. If it 500s when the database is briefly unavailable,
    // every client reports "the vault is broken" rather than "one lookup failed".
    const doc = await buildSchemaDoc()
    expect(doc.routes.length).toBeGreaterThan(40)
    expect(doc.warnings?.[0]).toMatch(/field_definitions unavailable/)
    expect(doc.entities).toEqual({})
  })

  it('names the flat views and the Part 2 tables an agent would query directly', async () => {
    const doc = await buildSchemaDoc()
    const surface = JSON.stringify(doc.query_surface)
    for (const view of ['vault.samples_flat', 'vault.device_history', 'vault.figure_sources'])
      expect(surface).toContain(view)
    for (const table of ['vault.measurement_metrics', 'vault.devices', 'vault.cohorts'])
      expect(surface).toContain(table)
  })
})

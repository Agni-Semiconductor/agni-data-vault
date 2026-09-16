// The dashboard's "Recent measurements" table rendered every link as `/samples/undefined` and
// `/measurements/undefined`, and its Sample key column was blank, because the page read `row.id`
// and `row.sample_key` while the server sends `measurement_id` and `sample_id`.
//
// Nothing caught it. The server matched docs/CONTRACT.md, the page compiled, and the client's own
// `Stats` type declared BOTH spellings -- with the two phantom fields non-optional -- so TypeScript
// was satisfied. `fetch` returns `any`, so the type was an assertion about data nobody verified.
//
// These tests tie the three together: the contract is the authority, the client type must not
// invent fields beyond it, and the page must not read a field the contract does not define.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** The `recent:[{...}]` key list, parsed out of the /stats row in docs/CONTRACT.md. */
function contractRecentKeys(): string[] {
  const contract = read('docs/CONTRACT.md')
  const row = contract.split('\n').find((l) => l.includes('`/stats`'))
  expect(row, 'docs/CONTRACT.md must document GET /stats').toBeTruthy()
  const recent = /recent:\[\{([^}]*)\}\]/.exec(row!)
  expect(recent, 'the /stats row must document the shape of `recent`').toBeTruthy()
  return recent![1]
    .split(',')
    .map((k) => k.trim().split(':')[0].trim())
    .filter(Boolean)
}

describe('GET /stats recent[] parity', () => {
  it('documents the fields the dashboard depends on', () => {
    // A control on the parser itself: if this stops finding real keys, the two checks below become
    // vacuous and would pass against anything.
    const keys = contractRecentKeys()
    expect(keys.length, 'expected the contract to list the recent[] fields').toBeGreaterThan(2)
    expect(keys).toContain('measurement_id')
    expect(keys).toContain('sample_id')
  })

  it('the server sends exactly the keys the contract names', () => {
    // Read the mapping the resource performs rather than running it: the shape is built in one
    // `.map()` and its returned object literal is the payload.
    const source = read('api/_lib/resources/stats.js')
    const mapped = /const recent\s*=[\s\S]*?return\s*\{([^}]*)\}/.exec(source)
    expect(mapped, 'stats.js must build recent[] from a returned object literal').toBeTruthy()
    const emitted = mapped![1]
      .split(',')
      .map((k) => k.trim().split(':')[0].trim())
      .filter(Boolean)
    for (const key of contractRecentKeys()) {
      expect(emitted, `the contract promises recent[].${key} but stats.js does not emit it`).toContain(key)
    }
  })

  it('the dashboard reads no recent[] field the contract does not define', () => {
    // THE CHECK THAT WOULD HAVE CAUGHT IT. Every `row.<field>` in the recent[] map must be a field
    // the contract defines; `row.id` and `row.sample_key` were neither documented nor sent.
    const page = read('src/pages/Dashboard.tsx')
    const allowed = new Set([...contractRecentKeys(), 'sample_uuid'])
    const block = /data\.recent\.map\(row=>([\s\S]*?)\)\}<\/tbody>/.exec(page)
    expect(block, 'Dashboard.tsx must render recent[] with a row callback').toBeTruthy()
    const used = new Set([...block![1].matchAll(/\brow\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))
    expect(used.size, 'expected the dashboard to read at least one field from each row').toBeGreaterThan(0)
    for (const field of used) {
      expect(
        allowed.has(field),
        `Dashboard reads row.${field}, which GET /stats does not send -- it renders as undefined`,
      ).toBe(true)
    }
  })

  it('the client Stats type invents no recent[] field beyond the contract', () => {
    // The type declaring `id` and `sample_key` is what let the page compile while reading fields
    // that never arrive. A type is only a safety net if it describes the payload.
    const api = read('src/lib/api.ts')
    const declared = /recent:Array<\{([^}]*)\}>/.exec(api)
    expect(declared, 'src/lib/api.ts must declare the shape of Stats.recent').toBeTruthy()
    const allowed = new Set([...contractRecentKeys(), 'sample_uuid'])
    for (const entry of declared![1].split(';')) {
      const name = entry.trim().split(/[?:]/)[0].trim()
      if (!name) continue
      expect(allowed.has(name), `Stats.recent declares ${name}, which the contract does not define`).toBe(true)
    }
  })
})

// Two environment variables that look parallel and are not, which cost a deployment round on
// 2026-09-11.
//
// VAULT_REST_URL is handed straight to supabase-js's `createClient()`, and that library APPENDS
// `/rest/v1` itself. Setting it to `http://host:8087/rest/v1` therefore produces
// `/rest/v1/rest/v1/<table>`; the nginx shim strips one prefix with its trailing-slash
// `proxy_pass` and PostgREST answers
//
//     {"code":"PGRST125","message":"Invalid path specified in request URL"}
//
// which names neither the variable, nor the duplication, nor the library that added it. It
// surfaced as a /healthz whose database check failed with a string nobody could map back to a
// config value.
//
// VAULT_STORAGE_URL is the exact opposite. `api/_lib/storage.js` consumes it directly -- it strips
// a trailing slash and appends object paths -- so that one MUST carry `/storage/v1`. Strip the
// prefix from that one and objects 404 instead.
//
// The asymmetry is not a mistake to fix; it follows from who builds the path. What was missing was
// anything to stop the two being written as though they matched.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** The value assigned to `name` in a KEY=value file, ignoring comment lines. */
export function assignedValue(text: string, name: string): string | null {
  // Split on /\r?\n/, not '\n'. .env.example is CRLF, and splitting on '\n' alone leaves a
  // trailing '\r' on every line -- which JS treats as a line terminator, so `.` will not match it
  // and `(.*)$` never reaches the end. The parser then returns null for every variable, and both
  // rules below pass vacuously while checking nothing. The `not.toBeNull()` guards are there
  // because that is exactly how this failed the first time.
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const m = new RegExp(`^\\s*${name}=(.*)$`).exec(line)
    if (m) return m[1].trim()
  }
  return null
}

describe('the two data-plane URLs carry the prefixes their consumers expect', () => {
  it('supabaseAdmin still passes VAULT_REST_URL straight to createClient', () => {
    // The whole reason VAULT_REST_URL must be a bare base. If this ever changes -- if someone
    // starts appending the prefix in our code -- then the rule below inverts, and this test should
    // fail rather than keep enforcing a stale one.
    const src = read('api/_lib/supabaseAdmin.js')
    expect(src, 'VAULT_REST_URL should be read here').toContain('VAULT_REST_URL')
    expect(src, 'it is handed to createClient unmodified, which is what appends /rest/v1').toMatch(
      /createClient\(\s*url\b/,
    )
    expect(src, 'our code must NOT add the prefix itself').not.toMatch(/VAULT_REST_URL[^\n]*\/rest\/v1/)
  })

  it('storage.js still uses VAULT_STORAGE_URL as a base it appends to', () => {
    const src = read('api/_lib/storage.js')
    expect(src, 'VAULT_STORAGE_URL should be read here').toContain('VAULT_STORAGE_URL')
    // It strips a trailing slash and appends paths; it never inserts /storage/v1.
    expect(src, 'our code must not add the storage prefix either').not.toMatch(
      /VAULT_STORAGE_URL[^\n]*\/storage\/v1/,
    )
  })

  it('.env.example gives VAULT_REST_URL with no /rest/v1 suffix', () => {
    const value = assignedValue(read('.env.example'), 'VAULT_REST_URL')
    expect(value, 'VAULT_REST_URL must be present in .env.example').not.toBeNull()
    expect(value, 'createClient appends /rest/v1; a suffix here yields PGRST125').not.toMatch(/\/rest\/v1\/?$/)
  })

  it('.env.example gives VAULT_STORAGE_URL WITH its /storage/v1 suffix', () => {
    const value = assignedValue(read('.env.example'), 'VAULT_STORAGE_URL')
    expect(value, 'VAULT_STORAGE_URL must be present in .env.example').not.toBeNull()
    expect(value, 'storage.js appends object paths to this and never adds the prefix').toMatch(/\/storage\/v1\/?$/)
  })

  it('the assigner ignores comments and reads real assignments', () => {
    // Both rules above are inverted from each other, so a parser that silently returned null would
    // make one of them vacuously pass. Pinned so the narrowing cannot hide either.
    const sample = '# VAULT_REST_URL=http://wrong/rest/v1\nVAULT_REST_URL=http://right\nOTHER=x\n'
    expect(assignedValue(sample, 'VAULT_REST_URL')).toBe('http://right')
    expect(assignedValue(sample, 'MISSING_VAR')).toBeNull()
  })
})

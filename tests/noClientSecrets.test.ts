// Nothing reaches the browser that should not.
//
// Vite inlines every `VITE_`-prefixed variable into the bundle at build time — literally, as a
// string, in a file served to anyone who can load the page. The v1 rule was "nothing SECRET
// starts with VITE_", which requires every future author to correctly classify their own
// variable. Contract v2 strengthens it to "nothing AT ALL starts with VITE_" except the one
// non-secret base path, because that version is checkable and this one does the checking.
//
// This matters more now than it did: the server holds a PostgREST service JWT that bypasses RLS,
// a Cloudflare Access audience, and an Anthropic API key. Any of those inlined into a public
// bundle is an incident, and the failure is silent — the app works perfectly.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ALLOWED = new Set(['VITE_API_BASE_URL'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(path)
  }
  return out
}

/**
 * Every `VITE_*` variable the front end actually USES or DECLARES.
 *
 * Matches the two mechanisms by which one enters the bundle or the type surface —
 * `import.meta.env.VITE_X` and a `readonly VITE_X:` declaration — rather than any mention of the
 * name. A bare-token scan flagged this repo's own comment explaining which variables had been
 * REMOVED, which is the failure mode where a check makes documenting a rule harder than breaking
 * it, and so gets the check deleted.
 */
function viteTokensIn(root: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:import\.meta\.env\.|readonly\s+)(VITE_[A-Z0-9_]+)/g)) {
      const token = match[1]
      const list = found.get(token) ?? []
      if (!list.includes(file)) list.push(file)
      found.set(token, list)
    }
  }
  return found
}

describe('no client-side secrets', () => {
  const src = resolve(process.cwd(), 'src')

  it('found source files to scan at all', () => {
    // A walk that returned nothing would make every assertion below pass over an empty set —
    // green while checking nothing.
    expect(walk(src).length).toBeGreaterThan(20)
  })

  it('src/ references no VITE_ variable except the base path', () => {
    const offenders = [...viteTokensIn(src).entries()].filter(([token]) => !ALLOWED.has(token))
    expect(offenders.map(([token, files]) => `${token} in ${files.join(', ')}`)).toEqual([])
  })

  it('.env.example declares no VITE_ variable except the base path', () => {
    const text = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8')
    const declared = [...text.matchAll(/^(VITE_[A-Z0-9_]+)=/gm)].map((m) => m[1])
    expect(declared.filter((token) => !ALLOWED.has(token))).toEqual([])
  })

  it('no server-side secret name appears in front-end source', () => {
    // Names, not values: a component reading `import.meta.env.VITE_ANTHROPIC_KEY` would be caught
    // by the test above, but a stray `process.env.ANTHROPIC_API_KEY` in a .tsx would not — and it
    // would quietly inline as `undefined`, which looks like a bug rather than a boundary
    // violation until someone "fixes" it by adding a VITE_ prefix.
    const secrets = ['ANTHROPIC_API_KEY', 'VAULT_SERVICE_JWT', 'VAULT_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PGRST_JWT_SECRET']
    const hits: string[] = []
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8')
      for (const secret of secrets) if (text.includes(secret)) hits.push(`${secret} in ${file}`)
    }
    expect(hits).toEqual([])
  })

  it('the Anthropic SDK is imported only under api/', () => {
    // It is a server-only dependency. An import from src/ would both ship the SDK to the browser
    // and strongly imply a key went with it.
    const hits = walk(src).filter((file) => readFileSync(file, 'utf8').includes('@anthropic-ai/sdk'))
    expect(hits).toEqual([])
  })
})

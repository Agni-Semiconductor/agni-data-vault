// Every environment variable the server reads must be documented, and every one documented must
// be read.
//
// This exists because the docs told operators to set `VAULT_IDENTITY_*` while the code reads
// `VAULT_ACCESS_TEAM_URL`, `VAULT_ACCESS_AUD` and `VAULT_EMAIL_DOMAIN`. Nothing failed at build
// time, nothing failed at test time, and the failure it produced at deploy time was
// `VAULT_ACCESS_TEAM_URL is not set` — which reads as a bug in the code rather than a wrong
// instruction in the checklist, and sends whoever is deploying to the wrong place.
//
// The direction that matters most is the second one: an undocumented variable is a gap someone
// will notice when the thing does not start. A DOCUMENTED variable that nothing reads is a
// silent failure — the operator sets it, believes the feature is configured, and it is not.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(js|mjs)$/.test(entry)) out.push(path)
  }
  return out
}

const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

/** Every `process.env.X` the server actually reads. */
function envVarsInCode(): Set<string> {
  const found = new Set<string>()
  for (const file of [...walk(resolve(root, 'api')), resolve(root, 'server/vault-api.mjs')]) {
    for (const m of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1])
  }
  return found
}

// Not ours to document: PORT is systemd's, NODE_ENV is the runtime's, and CI sets the rest.
const NOT_OURS = new Set(['PORT', 'NODE_ENV', 'CI'])
// Documented and deliberately absent from the server: these belong to the CLI, the client, or
// the test suite.
const CLIENT_OR_CLI = new Set(['VITE_API_BASE_URL', 'VAULT_API_URL', 'FED_PGRST_JWT_SECRET', 'VAULT_REAL_XLSX'])

/**
 * Only the forms that INSTRUCT an operator to set something.
 *
 * The first version of this matched every mention, which flagged the contract amendment written
 * specifically to record that `VAULT_IDENTITY_*` was wrong — a document explaining a mistake has
 * to be able to name it. The failure mode being guarded is narrower than "appears in a file": a
 * variable presented as one to SET, in a table row, a bullet, or an assignment.
 */
export function declaredVars(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^\s*(?:\|\s*`(VAULT_[A-Z0-9_]+)`\s*\||[-*]\s*`(VAULT_[A-Z0-9_]+)`\s*:|(VAULT_[A-Z0-9_]+)=)/.exec(line)
    const name = match?.[1] ?? match?.[2] ?? match?.[3]
    if (name) out.add(name)
  }
  return out
}

const DOCS = ['docs/CONTRACT.md', 'docs/API.md', 'docs/DEPLOY_CHECKLIST.md', 'deploy/README.md', '.env.example']

describe('environment variables: code and documentation agree', () => {
  it('found variables at all', () => {
    // Without this the two assertions below iterate empty sets and pass while checking nothing —
    // the vacuous green this repo has been bitten by more than once.
    const vars = envVarsInCode()
    expect(vars.size).toBeGreaterThan(5)
    expect(vars).toContain('VAULT_SERVICE_JWT')
  })

  it('every variable the server reads is documented somewhere an operator will look', () => {
    const docs = DOCS.map(read).join('\n')
    const undocumented = [...envVarsInCode()]
      .filter((name) => !NOT_OURS.has(name))
      .filter((name) => !docs.includes(name))
    expect(undocumented, 'read by the server but documented nowhere').toEqual([])
  })

  it('no document instructs an operator to set a variable the server never reads', () => {
    // The direction that fails silently. `VAULT_IDENTITY_*` was documented in three files and
    // read by none — an operator would set it, get no error from doing so, and find Access
    // verification broken for a reason the documentation actively pointed away from.
    const code = envVarsInCode()
    const ghosts = new Set<string>()
    for (const doc of DOCS) {
      for (const name of declaredVars(read(doc))) {
        if (!code.has(name) && !CLIENT_OR_CLI.has(name)) ghosts.add(`${name} (in ${doc})`)
      }
    }
    expect([...ghosts].sort(), 'documented but never read — an operator would set these for nothing').toEqual([])
  })

  it('the narrowing still catches a variable listed as one to set', () => {
    // Narrowing a check is how a check quietly stops checking. This pins that all three
    // instruction FORMS are still caught, so the VAULT_IDENTITY failure would be found again in
    // whichever of them somebody reintroduced it — while prose that merely names a variable is
    // left alone, which is what the narrowing was for.
    const found = declaredVars([
      '| `VAULT_GHOST_TABLE` | server | something |',
      '- `VAULT_GHOST_BULLET`: server, something',
      'VAULT_GHOST_ASSIGN=value',
      'prose mentioning VAULT_GHOST_PROSE, which must NOT be flagged',
    ].join('\n'))
    expect([...found].sort()).toEqual(['VAULT_GHOST_ASSIGN', 'VAULT_GHOST_BULLET', 'VAULT_GHOST_TABLE'])
  })

  it('the three Access variables are the ones accessJwt.js and identity.js actually use', () => {
    // Named explicitly rather than left to the general rule, because this is the specific pair
    // that drifted and the drift was invisible for as long as it existed.
    const access = read('api/_lib/accessJwt.js') + read('api/_lib/identity.js')
    for (const name of ['VAULT_ACCESS_TEAM_URL', 'VAULT_ACCESS_AUD', 'VAULT_EMAIL_DOMAIN']) {
      expect(access, `${name} should be read by the Access path`).toContain(name)
    }
    expect(access).not.toContain('VAULT_IDENTITY')
  })
})

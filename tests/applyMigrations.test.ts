import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'deploy/apply-migrations.sh')

/** Detect an executable grep that would miss psql's `psql:file:line: ERROR:` diagnostics. */
export function hasAnchoredErrorCheck(text: string): boolean {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .some((line) => /\bgrep\b[^\n]*['"]\^ERROR/i.test(line))
}

describe('deploy/apply-migrations.sh safeguards', () => {
  it('exists and is substantial enough for these checks to inspect a migration runner', () => {
    // An empty replacement would make every property below meaningless while misleading CI into
    // reporting that the migration runner was protected.
    expect(existsSync(scriptPath), 'deploy/apply-migrations.sh must exist').toBe(true)
    expect(readFileSync(scriptPath, 'utf8').split('\n').length, 'expected the migration runner, not a stub').toBeGreaterThan(50)
  })

  it('detects an anchored ERROR check in executable text', () => {
    // This control must fail for the defect it names; otherwise the next assertion could pass even
    // after `^ERROR` made a failed migration look clean.
    expect(hasAnchoredErrorCheck("out=$(psql -f migration.sql 2>&1)\nprintf '%s' \"$out\" | grep -q '^ERROR'"))
      .toBe(true)
  })

  it('does not anchor its psql error check at ERROR', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // psql prefixes diagnostics with the file and line, so `^ERROR` matches nothing and reports
    // a failed migration as clean.
    expect(hasAnchoredErrorCheck(script), 'an anchored ^ERROR grep misses psql-prefixed diagnostics').toBe(false)
  })

  it('uses the pinned PostgreSQL client instead of PATH', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // A bare client can resolve to the bundled Calibre psql, making the misleading symptom a
    // seemingly successful migration chain run by the wrong client.
    expect(script, 'the migration runner must pin /usr/pgsql-17/bin/psql').toContain('PSQL_CMD="/usr/pgsql-17/bin/psql"')
  })

  it('records sha256 values and refuses a changed applied migration', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // Without a digest ledger, an edited file is invisible and the misleading symptom is a
    // database that looks applied even though no version of the migration describes it.
    expect(script, 'the applied-migration ledger must record sha256').toMatch(/\bsha256\b/i)
    expect(script, 'an edited applied migration must stop unless explicitly allowed').toMatch(/if \[ "\$ALLOW_EDITED" -eq 0 \]; then/)
    expect(script, 'the refusal must identify the edited migration').toContain('EDITED SINCE IT WAS APPLIED')
  })

  it('captures psql stderr while applying each migration', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // psql writes diagnostics to stderr; omitting this redirect makes a failed file look like a
    // clean run because stdout contains no error to inspect.
    expect(script, 'the migration invocation must merge stderr into inspected output').toMatch(/-f "\$f" 2>&1/)
  })
})

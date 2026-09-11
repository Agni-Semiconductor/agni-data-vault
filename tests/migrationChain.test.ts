// Self-hosted migrations are a chain, not independent setup snippets: later files assume earlier
// ones applied. A missing number therefore applies cleanly while leaving a database nobody can
// describe. 0100 also once created two schemas before a missing extension failed; without a
// transaction, the ledger said the migration had not applied while the schemas already existed.
//
// `anon` and `authenticated` are Supabase-hosted roles, not roles a self-hosted cluster provides.
// Revoking from either makes psql stop under ON_ERROR_STOP=1, which reads as a migration failure
// rather than an invalid role name. Comments are stripped before matching because prose explaining
// `commit;` must not make a migration that never commits read as safe.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrations = resolve(root, 'supabase/migrations/selfhost')
const files = readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()

/** Removes SQL comments so an instruction written as prose cannot satisfy a statement check. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\r\n]*/g, '')
}

const expectedNumbers = Array.from({ length: 19 }, (_, index) => String(index + 100).padStart(4, '0'))
const numberIn = (file: string) => /^(\d{4})_/.exec(file)?.[1]
const read = (file: string) => stripSqlComments(readFileSync(resolve(migrations, file), 'utf8'))

describe('self-hosted migration chain remains applicable as a whole', () => {
  it('found migration files to scan at all', () => {
    // Without this, every scan below iterates an empty set and passes while checking nothing: the
    // vacuous green that makes a deleted migration directory read as a verified migration chain.
    expect(files.length, 'expected at least migrations 0100 through 0118').toBeGreaterThanOrEqual(19)
  })

  it('the comment stripper cannot turn prose into a commit', () => {
    // A stripper that leaves these behind makes the transaction check satisfiable by documentation
    // alone, so a file that rolls back at EOF reads as a correctly wrapped migration.
    const statements = stripSqlComments('-- commit;\nbegin;\n/* commit; */')
    expect(statements).toMatch(/begin;/i)
    expect(statements.trim()).not.toMatch(/commit;$/i)
  })

  it('numbers every migration continuously from 0100 through 0118', () => {
    const numbers = files.map(numberIn)
    expect(numbers, 'a missing or duplicate number breaks the ordered migration dependency chain').toEqual(expectedNumbers)
  })

  it('wraps every migration in one transaction', () => {
    const offenders = files.filter((file) => {
      const statements = read(file).trim()
      return !/(^|;)\s*begin\s*;/i.test(statements) || !/commit;$/i.test(statements)
    })
    expect(offenders, 'a partial failure leaves unrecorded schema changes that a re-run cannot describe').toEqual([])
  })

  it('does not revoke from Supabase-hosted roles absent self-hosted', () => {
    const offenders = files.filter((file) => /\brevoke\b[^;]*\bfrom\s+(?:anon|authenticated)\b/i.test(read(file)))
    expect(offenders, 'ON_ERROR_STOP aborts when anon or authenticated does not exist self-hosted').toEqual([])
  })
})

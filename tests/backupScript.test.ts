import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'deploy/backup-fedbench.sh')

/** Remove shell comments so documentation cannot impersonate an operator-visible warning. */
export function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

describe('deploy/backup-fedbench.sh safeguards', () => {
  it('exists and is substantial enough for these text checks to inspect a backup runner', () => {
    // A missing or stubbed script makes every search below vacuously green while CI claims the
    // backup has protections it never inspected.
    expect(existsSync(scriptPath), 'deploy/backup-fedbench.sh must exist').toBe(true)
    expect(readFileSync(scriptPath, 'utf8').split('\n').length, 'expected the backup runner, not a stub').toBeGreaterThan(100)
  })

  it('the comment stripper cannot let a comment satisfy an executable warning check', () => {
    // The distinction matters because a comment does not reach the operator whose false confidence
    // would otherwise make a same-host dump look like the required second physical copy.
    const onlyComment = '# NOT a second physical copy\narchive=backup.dump\n'
    expect(withoutCommentLines(onlyComment)).not.toMatch(/not a second physical copy/i)
    expect(withoutCommentLines("# old wording\nprintf '%s\\n' 'NOT a second physical copy'\n"))
      .toMatch(/printf[\s\S]*not a second physical copy/i)
  })

  it('never prunes retention unless both dump formats were published successfully', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // Pruning after a failed dump turns one bad night into loss of the good backups, while the
    // misleading symptom is a clean retention run with no usable current dump.
    expect(script, 'retention must be guarded by successful publication of both verified dumps')
      .toMatch(/if \[ "\$published" -eq 1 \] && \[ "\$fail" -eq 0 \]; then[\s\S]*?\brm -f "\$old_archive" "\$old_sql"/)
  })

  it('writes a custom archive and a gzip-compressed plain SQL twin', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // A custom archive alone needs its matching restore binary; without the SQL twin, an archive
    // can look retained while nobody can read it with future PostgreSQL tools or zgrep.
    expect(script, 'the custom archive must use pg_dump custom format').toMatch(/"\$PG_DUMP" -Fc -d "\$DB" -f "\$archive_tmp"/)
    expect(script, 'the human-readable SQL twin must be gzip-compressed').toMatch(/"\$PG_DUMP" -d "\$DB" \| gzip -c >"\$sql_tmp"/)
    expect(script).toContain('fedbench-$day.dump')
    expect(script).toContain('fedbench-$day.sql.gz')
  })

  it('verifies the custom dump is non-empty and readable before publishing success', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // A non-empty truncated archive otherwise looks backed up until the first restore, after the
    // source may already be gone; pg_restore --list must open it before it can count as success.
    expect(script, 'the dump must be non-empty before pg_restore validates it')
      .toMatch(/\[ -s "\$archive_tmp" \]; then[\s\S]*?"\$PG_RESTORE" --list "\$archive_tmp"/)
    expect(script, 'only both verified formats may be published').toMatch(/if \[ "\$archive_ok" -eq 1 \] && \[ "\$sql_ok" -eq 1 \]; then/)
  })

  it('prints that this is not a second physical copy on every run', () => {
    const executable = withoutCommentLines(readFileSync(scriptPath, 'utf8'))
    // Same-host storage does not clear the cutover gate; leaving this only in a comment produces
    // the misleading impression that a local dump is sufficient when the script runs unattended.
    expect(executable, 'an echo or printf must warn operators that this is not a second physical copy')
      .toMatch(/(?:^|\n)\s*(?:echo|printf)\b[\s\S]{0,300}?not a second physical copy/i)
  })

  it('pins PostgreSQL client paths instead of resolving a bare client from PATH', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // PATH selects the Siemens Calibre psql client on the server; using its sibling dump tools can
    // produce an ordinary-looking archive that is incompatible with the database being protected.
    expect(script, 'pg_dump must use the PostgreSQL 17 absolute path').toContain('PG_DUMP=/usr/pgsql-17/bin/pg_dump')
    expect(script, 'pg_restore must use the PostgreSQL 17 absolute path').toContain('PG_RESTORE=/usr/pgsql-17/bin/pg_restore')
    expect(script).not.toMatch(/(?:^|\n)\s*pg_dump\b/m)
    expect(script).not.toMatch(/(?:^|\n)\s*pg_restore\b/m)
  })
})

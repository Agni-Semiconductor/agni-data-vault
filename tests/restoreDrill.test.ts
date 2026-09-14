import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptPath = resolve(process.cwd(), 'deploy/restore-drill.sh')

/**
 * Shell text with whole-line comments removed.
 *
 * Every check below asks what the script DOES. Reading the raw text answers a different question:
 * the trap assertion here passed against a trap that had been commented out, because `# trap
 * cleanup EXIT` still contains the words. A check that a comment can satisfy is not a check.
 */
function directives(text: string): string {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
}

/** Ignore comments so an example command cannot certify the command the drill actually runs. */
export function hasExitOnError(text: string): boolean {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .some((line) => /(?:^|\s)(?:"?\$PG_RESTORE"?|\/usr\/pgsql-17\/bin\/pg_restore|pg_restore)\b[^\n]*\s--exit-on-error\b/.test(line))
}

describe('deploy/restore-drill.sh safeguards', () => {
  it('exists and is substantial enough for these checks to inspect a restore drill', () => {
    // A missing or stubbed script makes text searches vacuously green while CI claims a restore was
    // tested, producing false confidence in an unexercised recovery path.
    expect(existsSync(scriptPath), 'deploy/restore-drill.sh must exist').toBe(true)
    expect(readFileSync(scriptPath, 'utf8').split('\n').length, 'expected a restore drill, not a stub').toBeGreaterThan(75)
  })

  it('the --exit-on-error detector rejects a pg_restore command that omits it', () => {
    // This control must fail for the named defect; otherwise a partial restore can print warnings,
    // exit zero, and make the drill certify corrupt scratch data.
    expect(hasExitOnError('pg_restore --dbname="$SCRATCH_DB" "$archive"')).toBe(false)
  })

  it('passes --exit-on-error to pg_restore', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // pg_restore otherwise reports "WARNING: errors ignored on restore" and exits zero, leaving a
    // half-restored database behind while the drill misleadingly reports success.
    expect(hasExitOnError(script), 'pg_restore must fail the drill at its first restore error').toBe(true)
  })

  it('refuses to use fedbench itself as the scratch database before destructive commands run', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // A differently named variable is not a safety boundary: without a runtime equality guard, a
    // bad environment value can drop or restore over fedbench while the command looks like a drill.
    expect(script, 'the scratch database must be rejected when it resolves to fedbench')
      // PROPERTY, not phrasing. The first version required the literal
      // `if [ "$SCRATCH_DB" = "fedbench" ]`, which pinned a variable name invented by a different
      // worker running in parallel. Worse, it would have PASSED the bug that was actually there:
      // the guard was written `[ "$x" != prefix_* ]`, and `[` compares strings rather than
      // pattern-matching, so it was true for every name and refused every run. A drill that never
      // runs reports a refusal that reads as caution.
      //
      // What must hold: the scratch name is constructed in the script (never taken from an
      // argument), it is compared against the live database name, and a mismatching name prevents
      // creation. `case` is the construct that actually pattern-matches in POSIX shell.
      .toMatch(/case\s+"\$\w+"\s+in[\s\S]*?\$DB[\s\S]*?esac/)
    // AND the arm that accepts must require the disposable prefix. Widening it to a bare `*)`
    // leaves the case statement intact and the guard meaningless -- which the previous version of
    // this assertion could not tell apart.
    expect(directives(script), 'the accepting case arm must require the restore-drill prefix')
      .toMatch(/fedbench_restore_drill_\*\)/)
    expect(directives(script), 'a bare *) must not be what grants permission')
      .not.toMatch(/\n\s*\*\)\s*scratch_ok=1/)
    expect(script, 'dropdb must target the guarded scratch database, never fedbench literally')
      .not.toMatch(/\bdropdb\b[^\n]*\bfedbench\b/)
    expect(script, 'pg_restore must target the guarded scratch database, never fedbench literally')
      .not.toMatch(/\bpg_restore\b[^\n]*\bfedbench\b/)
  })

  it('queries the live source for count expectations instead of embedding stale fixture counts', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // Hardcoded counts silently rot as production changes, making matching obsolete numbers appear
    // valid even when the restore omitted current rows.
    // PROPERTY, not phrasing -- the fourth assertion in this file to pin a variable name invented
    // by a worker this test's author could not see. What must hold is that the expectations come
    // from the live database at run time: a count query against the live database name, and a
    // second against the scratch one, so the two can be compared.
    expect(script, 'counts must be read from the live database, not hardcoded').toMatch(
      /"\$PSQL"[^\n]*-d\s+"\$DB"[^\n]*count\(\*\)/i,
    )
    expect(script, 'and from the restored scratch database, so there is something to compare').toMatch(
      /"\$PSQL"[^\n]*-d\s+"\$SCRATCH"[^\n]*count\(\*\)/i,
    )
    // A literal expected count is the thing being ruled out: it rots the moment a migration seeds
    // another row, and then the drill either fails for the wrong reason or gets "fixed" by editing
    // the number.
    expect(script, 'no hardcoded expected row count').not.toMatch(/-eq\s+(?:32|77|7|11)\b/)
    expect(script, 'the drill must not use today\'s seeded counts as restore expectations')
      .not.toMatch(/(?:field_definitions\D{0,80}32|option_values\D{0,80}77|measurement_kinds\D{0,80}7|metric_definitions\D{0,80}11)/i)
  })

  it('fails a restored table whose count is zero', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // Equality alone accepts zero-to-zero when source data was never read; that makes a successful
    // empty restore look healthy instead of exposing that the drill proved no recoverable rows.
    expect(script, 'a zero count must increment failure status even if source and scratch agree')
      // A zero count must fail, however the script spells the variable. Schema without rows is
      // exactly what this system's RLS design produces elsewhere, and a backup is the worst place
      // to find it.
      .toMatch(/0\)\s*bad\s+"restored[^"]*zero rows/)
  })

  it('drops the scratch database through cleanup on both success and failure', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // Without an EXIT trap, the first failed assertion leaks a scratch database whose later reuse
    // can hide the original failure behind apparently valid leftover rows.
    expect(script, 'cleanup must run on every exit path').toMatch(/trap\s+['"]?cleanup['"]?\s+EXIT/)
    // The drop must go through the trap and must target the scratch variable, whatever it is
    // called -- a drill that leaves a database behind on failure is a drill people stop running.
    expect(directives(script), 'a trap must run the cleanup on every exit path -- a commented-out one reads identically in raw text')
      .toMatch(/trap\s+\w+\s+EXIT/)
    expect(script, 'cleanup must drop the scratch database, not a literal name')
      .toMatch(/dropdb|\$DROPDB|"\$DROPDB"/)
  })

  it('pins PostgreSQL 17 client binaries rather than resolving them from PATH', () => {
    const script = readFileSync(scriptPath, 'utf8')
    // PATH can select Siemens Calibre clients, producing ordinary-looking output from tools that do
    // not match PostgreSQL 17 and therefore do not prove the archive can be restored correctly.
    expect(script, 'pg_restore must use its PostgreSQL 17 absolute path').toContain('/usr/pgsql-17/bin/pg_restore')
    expect(script, 'psql must use its PostgreSQL 17 absolute path').toContain('/usr/pgsql-17/bin/psql')
  })
})

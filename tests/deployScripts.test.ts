// Two invisible characters, each of which produced an error that named something else entirely.
// Both cost a full debugging round against a live server on 2026-09-11, and neither is visible in
// review — which is the whole argument for pinning them here.
//
// CRLF: deploy/root-install.sh was written with CRLF and got away with it for days, because bash
// tolerates a trailing CR on most lines. It stopped being tolerable the moment a `for ... ; do`
// landed in the file, which fails as `syntax error near unexpected token $'do\r'`. The same class
// kills systemd units: systemd does NOT strip a trailing carriage return, so
// `ExecStart=... -m fed_storage\r` execs a module whose name ends in one, and the error names the
// module rather than the line ending.
//
// A literal backslash-n: a line was written as
//     if sudo -u postgres "$PSQL" -q -d fedbench \n       -c "alter role ..."
// with the two CHARACTERS backslash and n, not a line break. Bash reads that as an escaped `n`, so
// psql received a bare `n` as a positional argument, took it for the username, and failed with
// `FATAL: Peer authentication failed for user "n"` — a connection error naming a user that appears
// nowhere in the command. A SECOND instance of the same defect was found by this very test, on the
// line that verifies the authenticator password over TCP. That one had been reporting success:
// because the command passes both -d and -U explicitly, psql discarded the stray `n` as a surplus
// argument rather than treating it as a username, and the only trace was the word `n` printed on
// the end of an "ok" line. A test found it; reading the file twice had not.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/** Whether text contains the carriage return that Linux scripts and systemd units must never carry. */
export function containsCarriageReturn(text: string): boolean {
  return text.includes('\r')
}

/**
 * Lines carrying a literal `\n` that BASH will interpret — that is, one outside any quoting.
 *
 * The discriminating question is not "is this a printf". It is whether the backslash is quoted,
 * because that is precisely when bash stops treating it as an escape. `tr '\n' ' '` and
 * `printf '%s\n'` hand the two characters to another program that defines its own meaning for
 * them, and are correct. The same two characters sitting bare in a command line are the bug: bash
 * collapses them to the letter `n` and silently appends an argument.
 *
 * An earlier version of this allowed "anything inside a printf or echo format string", which is a
 * narrower fact that happens to be true of most legitimate uses — and it flagged `tr '\n' ' '`
 * immediately. Pinning the wrong rule is how a check ends up being loosened until it catches
 * nothing.
 */
export function unquotedBackslashN(text: string): string[] {
  const offenders: string[] = []

  for (const line of text.split('\n')) {
    let single = false
    let double = false

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]

      // A `#` at quote depth zero starts a comment: the rest of the line is prose, and prose has
      // to be able to NAME the defect it is describing. This file's own header would trip the
      // check otherwise, as would every comment in root-install.sh explaining the bug.
      if (ch === '#' && !single && !double && (i === 0 || /\s/.test(line[i - 1]))) break

      if (ch === "'" && !double) { single = !single; continue }
      if (ch === '"' && !single) { double = !double; continue }

      if (ch === '\\' && !single && !double) {
        // `\\` escapes the backslash itself; skip the pair so it is not read as a lone escape.
        if (line[i + 1] === '\\') { i++; continue }
        if (line[i + 1] === 'n') { offenders.push(line); break }
      }
    }
  }

  return offenders
}

/** Everything under deploy/ that is executed by bash or read by systemd. */
function deployFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    if (statSync(path).isDirectory()) deployFiles(path, out)
    // .timer belongs here as much as .service: it is the same parser and the same trailing-CR
    // failure, and leaving it out would be an exemption nobody chose.
    else if (/\.(?:sh|service|timer)$/.test(entry)) out.push(path)
  }
  return out
}

const root = process.cwd()
const deploy = resolve(root, 'deploy')
const files = deployFiles(deploy)
const shellScripts = files.filter((p) => p.endsWith('.sh'))
const show = (path: string) => relative(root, path).split(sep).join('/')

describe('deploy scripts carry no character that fails as something else', () => {
  it('found files to scan at all', () => {
    // Without this the scans below iterate an empty set and pass while checking nothing — the
    // vacuous green this repo has been bitten by more than once, most recently by a probe that
    // printed three FAILs and then reported ALL PASSED.
    expect(existsSync(deploy), 'deploy/ must exist').toBe(true)
    expect(files.length, 'expected .sh/.service/.timer files under deploy/').toBeGreaterThan(4)
    expect(shellScripts.length, 'expected shell scripts under deploy/').toBeGreaterThan(0)
  })

  it('the CR detector still catches a CR', () => {
    expect(containsCarriageReturn('for f in a b; do\r\n  :\ndone\n')).toBe(true)
    expect(containsCarriageReturn('for f in a b; do\n  :\ndone\n')).toBe(false)
  })

  it('the backslash-n detector still catches the real defect', () => {
    // The actual line, as it was written.
    const real = `if sudo -u postgres "$PSQL" -q -d fedbench \\n       -c "alter role x with login password 'y'"; then`
    expect(unquotedBackslashN(real)).toEqual([real])
    // And the second instance, which had been reporting success.
    expect(unquotedBackslashN(`"$PSQL" -c 'select 1' >/dev/null 2>&1 \\n      && ok "connected"`)).toHaveLength(1)
  })

  it('the backslash-n detector leaves the legitimate forms alone', () => {
    // Narrowing a check is how a check quietly stops checking, so the narrowing is pinned too.
    // Each of these is a real line from deploy/, and each is correct: the two characters are being
    // handed to a program that defines its own meaning for them.
    expect(unquotedBackslashN(`REQS=$(extra_reqs "$f" storage | tr '\\n' ' ')`)).toEqual([])
    expect(unquotedBackslashN(`printf 'PGRST_DB_URI=postgres://x\\n' "$PW" >> "$SECRETS"`)).toEqual([])
    expect(unquotedBackslashN(`printf "      \\033[33m%s\\n" "$denials"`)).toEqual([])
    expect(unquotedBackslashN('# the line read `-d fedbench \\n -c "..."`, which bash reads as an escaped n')).toEqual([])
  })

  it('no CR in any shell script, unit or timer under deploy/', () => {
    const offenders = files.filter((p) => containsCarriageReturn(readFileSync(p, 'utf8'))).map(show)
    expect(offenders, 'CRLF breaks bash on `do` and makes systemd exec a name ending in a CR').toEqual([])
  })

  it('no bash-interpreted literal backslash-n in any deploy script', () => {
    const offenders = shellScripts.flatMap((p) =>
      unquotedBackslashN(readFileSync(p, 'utf8')).map((line) => `${show(p)}: ${line.trim().slice(0, 110)}`),
    )
    expect(offenders, 'bash collapses a bare \\n to the letter n and appends it as an argument').toEqual([])
  })
})

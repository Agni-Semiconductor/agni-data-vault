// The alerting path is the one thing on this box whose failure is, by construction, silent: systemd
// discards an OnFailure handler's exit status, so nothing reacts when the alert itself cannot be
// sent. These tests RUN the scripts wherever bash is available, because the defect that started
// this work -- a backup failing three nights unnoticed -- was invisible to every source-text check
// anyone would have written.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const notifier = resolve(process.cwd(), 'deploy/fedbench-notify-failure.sh').replace(/\\/g, '/')
const deadman = resolve(process.cwd(), 'deploy/fedbench-deadman.sh').replace(/\\/g, '/')
const installer = resolve(process.cwd(), 'deploy/alerting-install.sh')
const alertUnit = resolve(process.cwd(), 'deploy/fedbench-alert@.service')

/** Shell text with whole-line comments removed: a check a comment can satisfy is not a check. */
function directives(text: string): string {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')
}

/**
 * Comment-stripped text with backslash continuations JOINED, so one shell command is one line.
 *
 * Every per-line check below was line-bound and therefore wrong: curl's invocation spans a
 * continuation, so `[^\n]*` could not reach its later arguments. A mutation that moved the bot
 * token into `-H "Authorization: ..."` on the second line went UNCAUGHT by a test written
 * specifically to forbid exactly that.
 */
function logicalLines(text: string): string {
  return directives(text).replace(/\\\n\s*/g, ' ')
}

function hasBash(): boolean {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const BASH = hasBash()

type Run = { status: number; stdout: string; stderr: string }
// spawnSync, NOT execFileSync: execFileSync returns only stdout, and these scripts deliberately
// log to stderr so their output lands in the journal rather than in a caller's pipeline. The first
// version of this helper dropped stderr on success and the payload assertion failed against a
// script that had printed it correctly.
function run(script: string, args: string[], env: Record<string, string>, pathPrefix?: string): Run {
  const r = spawnSync('bash', [script, ...args], {
    env: { ...process.env, ...env, ...(pathPrefix ? { PATH: `${pathPrefix}:${process.env.PATH}` } : {}) },
    encoding: 'utf8',
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// These suites spawn bash once or more per assertion. Under the full suite's parallelism that
// exceeds vitest's 5s default and the run fails on TIME, not on behaviour -- a red suite that
// says nothing about the code is worse than a slow one. Scoped here rather than raised
// globally, so a genuinely hanging test elsewhere still fails fast.
describe('deploy alerting scripts', { timeout: 30_000 }, () => {
  it.runIf(BASH)('escapes journal output through a real JSON encoder', () => {
    // Journal text from a failed DATABASE job contains quotes and backslashes as a matter of
    // course. Hand-built JSON breaks on the first one, and Slack answers 400 -- which reads as a
    // network problem, not a quoting problem, and would be debugged in the wrong place entirely.
    const dir = mkdtempSync(join(tmpdir(), 'fedalert-'))
    const shim = join(dir, 'shim')
    mkdirSync(shim)
    // A journal that is actively hostile to string concatenation.
    writeFileSync(
      join(shim, 'journalctl'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' \'ERROR: connection "host=x" failed\' \'a backslash \\ here\' \'tab\tand end\'\n',
    )
    chmodSync(join(shim, 'journalctl'), 0o755)

    const r = run(notifier, ['fedbench-backup.service'], { FEDBENCH_ALERT_DRY_RUN: '1' }, shim.replace(/\\/g, '/'))
    expect(r.status, `notifier exited ${r.status}: ${r.stderr}`).toBe(0)

    const line = (r.stderr + r.stdout).split('\n').find((l) => l.trimStart().startsWith('{'))
    expect(line, 'the dry run must print the payload it would send').toBeTruthy()

    // The real assertion: it PARSES. Nothing about the text it contains matters if it is not JSON.
    const parsed = JSON.parse(line!) as { text?: string }
    expect(typeof parsed.text).toBe('string')
    expect(parsed.text).toContain('fedbench-backup.service')
    expect(parsed.text, 'the journal tail must survive into the message').toContain('connection "host=x" failed')
    expect(parsed.text).toContain('a backslash \\ here')
  })

  it.runIf(BASH)('records a marker when it cannot deliver, because its exit status is discarded', () => {
    // systemd does not react to an OnFailure handler's exit code. Without a marker on disk, a
    // revoked webhook leaves every future failure silent while every unit still looks wired up --
    // the same shape as the bug this whole mechanism exists to fix, one level up.
    const dir = mkdtempSync(join(tmpdir(), 'fedalert-'))
    const r = run(notifier, ['fedbench-backup.service'], {
      FEDBENCH_ALERT_DRY_RUN: '0',
      FEDBENCH_ALERT_ENV: join(dir, 'does-not-exist.env').replace(/\\/g, '/'),
      FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'),
    })
    expect(r.status, 'an undeliverable alert must not report success').not.toBe(0)
    const marker = join(dir, 'alert-delivery-failed')
    expect(existsSync(marker), 'a failed delivery must leave evidence for the liveness check').toBe(true)
    expect(readFileSync(marker, 'utf8')).toMatch(/unit=fedbench-backup\.service/)
  })

  it.runIf(BASH)('the liveness check reports findings and exits non-zero when nothing has run', () => {
    // An empty backup directory and no drill stamp is exactly the state of a box where the timers
    // stopped firing. It must be loud.
    const dir = mkdtempSync(join(tmpdir(), 'feddead-'))
    const backups = join(dir, 'backups')
    mkdirSync(backups)
    const r = run(deadman, [], {
      FEDBENCH_BACKUPS: backups.replace(/\\/g, '/'),
      FEDBENCH_STATE_DIR: join(dir, 'state').replace(/\\/g, '/'),
      FEDBENCH_ALERT_ENV: join(dir, 'none.env').replace(/\\/g, '/'),
      FEDBENCH_REPO: join(dir, 'no-repo').replace(/\\/g, '/'),
    })
    expect(r.status, 'findings must fail the unit so OnFailure= posts them').toBe(1)
    expect(r.stdout, 'a missing backup is the headline finding').toMatch(/no \*\.dump exists/)
    expect(r.stdout).toMatch(/no successful restore drill has ever been recorded/)
  })

  /**
   * A curl that answers like Slack's Web API: HTTP 200, verdict in the BODY. The shim writes
   * whatever body the test asks for to the path curl was told to --output, and exits 0 -- exactly
   * what the real curl does when chat.postMessage rejects a message.
   */
  function curlShim(dir: string, body: string): string {
    const shim = join(dir, 'shim')
    mkdirSync(shim, { recursive: true })
    writeFileSync(
      join(shim, 'curl'),
      [
        '#!/usr/bin/env bash',
        'out=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--output" ]; then out=$a; fi; prev=$a; done',
        '[ -n "$out" ] && printf \'%s\' "$FEDBENCH_TEST_BODY" > "$out"',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shim, 'curl'), 0o755)
    void body
    return shim.replace(/\\/g, '/')
  }

  function apiEnvFile(dir: string): string {
    const envFile = join(dir, 'alert.env')
    writeFileSync(envFile, 'FEDBENCH_SLACK_TOKEN=xoxb-test-token\nFEDBENCH_SLACK_CHANNEL=#fedbench-alerts\n')
    return envFile.replace(/\\/g, '/')
  }

  it.runIf(BASH)('treats Slack ok:false as a failed delivery even though the HTTP status is 200', () => {
    // THE TRAP. chat.postMessage answers HTTP 200 for its OWN failures and puts the verdict in the
    // body: channel_not_found, invalid_auth, not_in_channel. `curl --fail` sees 200 and reports
    // success, so an expired token or a bot that was never invited would silence every future alert
    // while every unit still looked wired up -- the exact failure this alerter exists to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'fedapi-'))
    const shim = curlShim(dir, '')
    const r = run(
      notifier,
      ['fedbench-backup.service'],
      {
        FEDBENCH_ALERT_DRY_RUN: '0',
        FEDBENCH_ALERT_ENV: apiEnvFile(dir),
        FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'),
        FEDBENCH_TEST_BODY: '{"ok":false,"error":"channel_not_found"}',
      },
      shim,
    )
    expect(r.status, 'a rejected message must not report successful delivery').not.toBe(0)
    expect(existsSync(join(dir, 'alert-delivery-failed')), 'and it must leave evidence').toBe(true)
    expect(readFileSync(join(dir, 'alert-delivery-failed'), 'utf8')).toMatch(/channel_not_found/)
  })

  it.runIf(BASH)('accepts ok:true and clears any previous undelivered marker', () => {
    // The control for the assertion above: if this also failed, the ok check would merely be
    // rejecting everything, which passes the test for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'fedapi-'))
    const marker = join(dir, 'alert-delivery-failed')
    writeFileSync(marker, 'unit=stale\n')
    const r = run(
      notifier,
      ['fedbench-backup.service'],
      {
        FEDBENCH_ALERT_DRY_RUN: '0',
        FEDBENCH_ALERT_ENV: apiEnvFile(dir),
        FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'),
        FEDBENCH_TEST_BODY: '{"ok":true,"ts":"1789401006.000100"}',
      },
      curlShim(dir, ''),
    )
    expect(r.status, `a successful post must exit 0: ${r.stderr}`).toBe(0)
    expect(existsSync(marker), 'a successful delivery must clear the stale marker').toBe(false)
  })

  it.runIf(BASH)('reads the bench bot credentials from the testbench secrets file', () => {
    // The bench already has a Slack bot. Referencing its secrets.env keeps the token in ONE place,
    // so rotating it cannot leave a second stale copy quietly failing to deliver alerts nobody is
    // watching for -- which would be this mechanism failing in exactly the way it exists to catch.
    const dir = mkdtempSync(join(tmpdir(), 'fedcred-'))
    const secrets = join(dir, 'secrets.env')
    // Quoted values, as an EnvironmentFile may legitimately carry. A token that keeps its quotes
    // authenticates as nothing, and Slack answers invalid_auth -- which reads as a revoked token.
    writeFileSync(
      secrets,
      [
        '# the testbench secrets file',
        // BOTH quote styles, because an EnvironmentFile may carry either -- and a test that used
        // only one passed a mutation that deleted the other stripper.
        'FED_SLACK_BOT_TOKEN="xoxb-from-the-bench"',
        'FED_SLACK_CHANNEL="C0123ABCD"',
        'FED_SLACK_ENABLED=1',
        '',
      ].join('\n'),
    )
    const envFile = join(dir, 'alert.env')
    writeFileSync(envFile, `FEDBENCH_SLACK_CREDENTIAL_FILE=${secrets.replace(/\\/g, '/')}\n`)

    const r = run(notifier, ['fedbench-backup.service'], {
      FEDBENCH_ALERT_DRY_RUN: '1',
      FEDBENCH_ALERT_ENV: envFile.replace(/\\/g, '/'),
      FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'),
    })
    expect(r.status, `dry run failed: ${r.stderr}`).toBe(0)
    expect(r.stderr, 'the bot-token path must be selected').toMatch(/mode=api/)

    const line = (r.stderr + r.stdout).split('\n').find((l) => l.trimStart().startsWith('{'))
    const parsed = JSON.parse(line!) as { channel?: string }
    // The quotes must be gone. This is the assertion that would have caught shipping the raw value.
    expect(parsed.channel, 'a double-quoted channel must be unquoted').toBe('C0123ABCD')

    // The same again with single quotes: both strippers must exist, and deleting either must fail.
    writeFileSync(
      secrets,
      ["FED_SLACK_BOT_TOKEN='xoxb-from-the-bench'", "FED_SLACK_CHANNEL='C0123ABCD'", ''].join('\n'),
    )
    const r2 = run(notifier, ['fedbench-backup.service'], {
      FEDBENCH_ALERT_DRY_RUN: '1',
      FEDBENCH_ALERT_ENV: envFile.replace(/\\/g, '/'),
      FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'),
    })
    const line2 = (r2.stderr + r2.stdout).split('\n').find((l) => l.trimStart().startsWith('{'))
    expect((JSON.parse(line2!) as { channel?: string }).channel, 'a single-quoted channel too').toBe('C0123ABCD')
  })

  /**
   * Shims for systemd. journalctl answers differently depending on whether it was filtered by
   * invocation, which is exactly the distinction under test.
   */
  function systemdShim(dir: string): string {
    const shim = join(dir, 'shim')
    mkdirSync(shim, { recursive: true })
    writeFileSync(
      join(shim, 'journalctl'),
      [
        '#!/usr/bin/env bash',
        'for a in "$@"; do case "$a" in _SYSTEMD_INVOCATION_ID=*)',
        '  printf \'%s\\n\' "output of the failing run"; exit 0;; esac; done',
        'printf \'%s\\n\' "an OLDER failing run" "a LATER successful run"',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(shim, 'systemctl'),
      [
        '#!/usr/bin/env bash',
        'case "$*" in',
        '  *InvocationID*) echo abc123 ;;',
        '  *Result*) echo failed ;;',
        '  *ExecMainStatus*) echo 1 ;;',
        'esac',
        '',
      ].join('\n'),
    )
    chmodSync(join(shim, 'journalctl'), 0o755)
    chmodSync(join(shim, 'systemctl'), 0o755)
    return shim.replace(/\\/g, '/')
  }

  function dryRunPayload(dir: string, extraEnv: Record<string, string> = {}): { text: string } {
    const r = run(
      notifier,
      ['fedbench-backup.service'],
      { FEDBENCH_ALERT_DRY_RUN: '1', FEDBENCH_STATE_DIR: dir.replace(/\\/g, '/'), ...extraEnv },
      systemdShim(dir),
    )
    const line = (r.stderr + r.stdout).split('\n').find((l) => l.trimStart().startsWith('{'))
    expect(line, `no payload printed; stderr was: ${r.stderr}`).toBeTruthy()
    return JSON.parse(line!) as { text: string }
  }

  it.runIf(BASH)('quotes the failing run, not the last 20 lines the unit ever logged', () => {
    // `journalctl -u NAME -n 20` returns the unit's recent output, which for a nightly job splices
    // the failing run together with earlier successful ones. The first real message this alerter
    // sent did exactly that: a failure and a later success in one block under a heading that said
    // "failed". Worse than no detail, because it invites a conclusion about the wrong run.
    const dir = mkdtempSync(join(tmpdir(), 'fedinv-'))
    const parsed = dryRunPayload(dir)
    expect(parsed.text, 'the tail must come from the failing invocation').toContain('output of the failing run')
    expect(parsed.text, 'a LATER successful run must not appear in a failure alert').not.toContain(
      'a LATER successful run',
    )
    expect(parsed.text).not.toContain('an OLDER failing run')
  })

  it.runIf(BASH)('announces a test alert as a test', () => {
    // A test indistinguishable from a real alert teaches people to ignore the channel, which is the
    // only asset this mechanism has.
    const dir = mkdtempSync(join(tmpdir(), 'fedtest-'))
    const real = dryRunPayload(dir)
    const test = dryRunPayload(dir, { FEDBENCH_ALERT_TEST: '1' })
    expect(real.text, 'a real alert says a job failed').toMatch(/job failed/i)
    expect(test.text, 'a test alert must say so').toMatch(/TEST ALERT/)
    expect(test.text, 'and must not claim something failed').not.toMatch(/job failed/i)
    // Still a real delivery through the real credential: same unit, same detail.
    expect(test.text).toContain('fedbench-backup.service')
    expect(test.text).toContain('output of the failing run')
  })

  /** A backups directory holding dumps of the given sizes, newest last. */
  function backupsWith(dir: string, sizes: number[]): string {
    const backups = join(dir, 'backups')
    mkdirSync(backups, { recursive: true })
    const base = Date.now() - sizes.length * 86400000
    sizes.forEach((size, index) => {
      const file = join(backups, `fedbench-day${index}.dump`)
      writeFileSync(file, Buffer.alloc(size, 0x41))
      const when = new Date(base + index * 86400000)
      utimesSync(file, when, when)
    })
    return backups.replace(/\\/g, '/')
  }

  function deadmanOutput(dir: string, backups: string): string {
    const state = join(dir, 'state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'last-drill-success'), String(Math.floor(Date.now() / 1000)))
    const r = run(deadman, [], {
      FEDBENCH_BACKUPS: backups,
      FEDBENCH_STATE_DIR: state.replace(/\\/g, '/'),
      FEDBENCH_ALERT_ENV: join(dir, 'none.env').replace(/\\/g, '/'),
      FEDBENCH_REPO: join(dir, 'no-repo').replace(/\\/g, '/'),
    })
    return r.stdout
  }

  it.runIf(BASH)('does not alarm on a small dump that is simply a small database', () => {
    // The floor this check shipped with was 200000 bytes, chosen from nothing, with a comment
    // calling it "far below the seeded floor". The first healthy run produced 189723 bytes and it
    // alarmed -- which would have posted a false alarm the next morning. An alarm that fires on a
    // healthy system gets muted, and a muted alarm is worse than none because it still looks like
    // coverage. The real database is 10 MB of vocabulary today and will be several GB after the
    // bench data lands, so NO constant is right on both sides of that.
    const dir = mkdtempSync(join(tmpdir(), 'feddump-'))
    const out = deadmanOutput(dir, backupsWith(dir, [189_000, 189_723]))
    expect(out, 'a stable small dump is not a finding').not.toMatch(/FINDING:[^\n]*dump[^\n]*bytes/)
    expect(out, 'and the size is still reported').toMatch(/ok:[^\n]*189723 bytes/)
  })

  it.runIf(BASH)('alarms when a dump collapses against its predecessor', () => {
    // The failure an absolute floor cannot see and a relative one catches at any scale: an RLS
    // regression, a dropped schema, or a stray --schema-only leaves a dump that restores cleanly
    // and contains almost nothing.
    const dir = mkdtempSync(join(tmpdir(), 'feddump-'))
    const out = deadmanOutput(dir, backupsWith(dir, [4_000_000, 190_000]))
    expect(out, 'a collapse against yesterday must be a finding').toMatch(
      /FINDING:[^\n]*% of the previous one/,
    )
  })

  it.runIf(BASH)('does not alarm when a dump merely grows', () => {
    // The control. A check that flagged every change would be the same false alarm wearing a
    // different number.
    const dir = mkdtempSync(join(tmpdir(), 'feddump-'))
    const out = deadmanOutput(dir, backupsWith(dir, [190_000, 4_000_000]))
    expect(out, 'growth is not a finding').not.toMatch(/FINDING:[^\n]*% of the previous one/)
  })

  it('never passes the webhook as a command-line argument', () => {
    // ps is world-readable and this host has other human accounts on it (fedci, the shared EDA
    // users). A Slack webhook is a bearer credential: whoever reads it can post as this alerter.
    // logicalLines, NOT directives: curl's invocation spans a backslash continuation, and the
    // line-bound version of this check passed a mutation that put the token in -H on line two.
    const text = logicalLines(readFileSync(notifier, 'utf8'))
    expect(text, 'the webhook must not appear on a command line').not.toMatch(
      /\b(?:curl|wget)\b[^\n]*\$\{?(?:FEDBENCH_)?SLACK_WEBHOOK/,
    )
    expect(text, 'nor may the bot token, which is equally a bearer credential').not.toMatch(
      /\b(?:curl|wget)\b[^\n]*\$\{?(?:FEDBENCH_)?SLACK_TOKEN/,
    )
    // An Authorization header belongs in the config file curl reads, never in argv. Stated as its
    // own rule so the next credential added here inherits it instead of re-learning it.
    expect(text, 'no Authorization header may be passed as a curl argument').not.toMatch(
      /\b(?:curl|wget)\b[^\n]*(?:-H|--header)\s+["']?Authorization/i,
    )
    expect(text, 'it must be passed through a file curl reads instead').toMatch(/--config/)
  })

  it('makes curl treat an HTTP error as a failure', () => {
    // Without --fail curl exits 0 on 4xx and prints the body, so a revoked or rotated webhook
    // would report successful delivery forever -- alerting that is broken and says it is fine.
    expect(directives(readFileSync(notifier, 'utf8')), 'curl must fail the send on an HTTP error')
      .toMatch(/curl[^\n]*--fail\b/)
  })

  it('the liveness check watches the timers themselves, not only their output', () => {
    // The check OnFailure= structurally cannot perform. A disabled timer produces no failed unit,
    // no journal line and no output: it simply stops, and everything downstream still looks fine.
    const text = directives(readFileSync(deadman, 'utf8'))
    expect(text, 'it must ask whether the timers are still armed').toMatch(/is-enabled/)
    expect(text, 'and whether they are actually running').toMatch(/is-active/)
    expect(text, 'the backup timer must be one of them').toMatch(/fedbench-backup\.timer/)
    expect(text, 'and the drill timer too').toMatch(/fedbench-restore-drill\.timer/)
  })

  it('the alert template is triggered, never enabled', () => {
    // A completed oneshot with [Install] runs at every boot. For an alerter that means a Slack
    // message on every reboot, which trains everyone to ignore the channel.
    const text = directives(readFileSync(alertUnit, 'utf8'))
    expect(text, 'the template must have no [Install] section').not.toMatch(/\[Install\]/)
    expect(text, 'it must name the failing unit through the instance specifier').toMatch(/ExecStart=[^\n]*%i/)
  })

  it('the installer proves the drop-in is in effect rather than proving a file exists', () => {
    // `systemctl show` reads the MERGED configuration. Checking that the drop-in FILE exists passes
    // while systemd ignores it -- which is exactly how --check once passed against units that still
    // pointed at the wrong host.
    const text = directives(readFileSync(installer, 'utf8'))
    expect(text, 'the OnFailure assertion must read merged configuration').toMatch(
      /systemctl show -p OnFailure[^\n]*fedbench-backup\.service/,
    )
    expect(text, 'and it must require the alerter to be the target').toMatch(/fedbench-alert@/)
  })

  it('the installer never rewrites a credential it was not given', () => {
    // An installer that replaced a working webhook with a placeholder would disable alerting and
    // report success doing it.
    const text = directives(readFileSync(installer, 'utf8'))
    // PROPERTY, not spelling: the previous version required the webhook-only grep and failed
    // the moment bot-token support landed -- against an installer that preserves BOTH kinds.
    expect(text, 'an existing credential of either kind must be kept when none is passed').toMatch(
      /grep -q[A-Za-z]* [^\n]*FEDBENCH_SLACK_[^\n]*ENVFILE/,
    )
    expect(text, 'and it must say so rather than silently doing nothing').toMatch(/kept the existing/)
  })
})

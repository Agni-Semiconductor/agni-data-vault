// The alerting path is the one thing on this box whose failure is, by construction, silent: systemd
// discards an OnFailure handler's exit status, so nothing reacts when the alert itself cannot be
// sent. These tests RUN the scripts wherever bash is available, because the defect that started
// this work -- a backup failing three nights unnoticed -- was invisible to every source-text check
// anyone would have written.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
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

describe('deploy alerting scripts', () => {
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

  it('never passes the webhook as a command-line argument', () => {
    // ps is world-readable and this host has other human accounts on it (fedci, the shared EDA
    // users). A Slack webhook is a bearer credential: whoever reads it can post as this alerter.
    const text = directives(readFileSync(notifier, 'utf8'))
    expect(text, 'the webhook must not appear on a command line').not.toMatch(
      /\b(?:curl|wget)\b[^\n]*\$\{?FEDBENCH_SLACK_WEBHOOK/,
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
    expect(text, 'an existing webhook must be kept when none is passed').toMatch(
      /grep -q [^\n]*FEDBENCH_SLACK_WEBHOOK[^\n]*ENVFILE|kept the existing webhook/,
    )
  })
})

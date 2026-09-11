// Systemd reads these files only when the operator installs them as root. Catching a unit that
// cannot restart, enable, or execute then leaves a half-configured server and an outage whose
// symptom names systemd rather than the directive that caused it.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

function unitFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry)
    if (statSync(path).isDirectory()) unitFiles(path, out)
    else if (/\.(?:service|timer)$/.test(entry)) out.push(path)
  }
  return out
}

/** The lines systemd can act on; comments must be free to name the mistake they explain. */
export function directives(text: string): string[] {
  return text.split('\n').filter((line) => !/^\s*(?:#|;|$)/.test(line))
}

function section(lines: string[], name: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `[${name}]`)
  if (start === -1) return []
  const end = lines.findIndex((line, index) => index > start && /^\s*\[.+\]\s*$/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

const root = process.cwd()
const deploy = resolve(root, 'deploy')
const files = unitFiles(deploy)
const show = (path: string) => relative(root, path).split(sep).join('/')
const contents = (path: string) => directives(readFileSync(path, 'utf8'))

/**
 * A `Type=oneshot` service run by a timer, which is a different kind of unit and not an exception
 * grudgingly carved out. Three of the rules below are written for a LONG-RUNNING daemon and are
 * actively wrong for this shape:
 *
 *   User=      tailscale-cert.service writes into /etc/caddy/certs and calls `tailscale cert`.
 *              Both need root. Dropping privilege here would break the renewal, and a renewal
 *              that silently stops is an outage 90 days later with nothing in between.
 *   Restart=   `Restart=` on a oneshot restarts a task that has already finished. The timer IS
 *              the retry mechanism; systemd warns about the combination.
 *   [Install]  A timer-driven service must NOT carry its own WantedBy. The TIMER is what gets
 *              enabled. Giving the service an [Install] section makes it run on every boot --
 *              which for a certificate renewal is a spurious call on every reboot.
 *
 * So the rules are applied by unit shape, and the pairing below is asserted INSTEAD: a oneshot
 * with no [Install] must have a timer that has one, or nothing ever runs it and the absence looks
 * exactly like the correct configuration.
 */
const isOneshot = (path: string) =>
  section(contents(path), 'Service').some((line) => /^\s*Type=oneshot\s*$/.test(line))
const longRunningServices = files.filter((p) => p.endsWith('.service') && !isOneshot(p))

describe('deploy systemd units are safe before an operator installs them', () => {
  it('found unit files to scan at all', () => {
    // Without this, every check below can iterate an empty list and pass while checking nothing,
    // the vacuous green that leaves CI successful and a missing deployment unexamined.
    expect(existsSync(deploy), 'deploy/ must exist').toBe(true)
    expect(files.length, 'expected at least three .service/.timer files under deploy/').toBeGreaterThanOrEqual(3)
  })

  it('strips comment lines before looking for paths under /home', () => {
    // A text search would flag documentation of the rule, making the misleading symptom a CI
    // failure about a safe unit rather than the directive systemd will read.
    const unit = '# /home/operator/old-unit.service was unsafe\n[Service]\nExecStart=/srv/app/run\n'
    expect(directives(unit).join('\n')).not.toContain('/home/')
  })

  it('has no directive that resolves under /home', () => {
    const offenders = files.filter((path) => contents(path).some((line) => line.includes('/home/'))).map(show)
    expect(offenders, 'a home-directory directive can fail after an account or SELinux label changes, reading as a missing file').toEqual([])
  })

  it('runs every service as a non-root user', () => {
    // A missing User= defaults to root, so both forms are checked. A data-plane process with that
    // privilege turns an application compromise into a host compromise, while the symptom is an
    // apparently ordinary service process with no visible privilege boundary.
    const offenders = longRunningServices.flatMap((path) => {
      const users = section(contents(path), 'Service').filter((line) => /^\s*User=/.test(line))
      return users.length === 1 && users[0].replace(/^\s*User=/, '').trim() !== 'root' ? [] : [show(path)]
    })
    expect(offenders, 'every long-running service needs one User= other than root').toEqual([])
  })

  it('makes every service restart after a crash', () => {
    const offenders = longRunningServices
      .filter((path) => !section(contents(path), 'Service').some((line) => /^\s*Restart=/.test(line)))
      .map(show)
    expect(offenders, 'without Restart= a crashed service stays down until noticed, reading as an endpoint that was down all weekend').toEqual([])
  })

  it('makes every long-running unit and every timer enableable at boot', () => {
    const mustEnable = [...longRunningServices, ...files.filter((p) => p.endsWith('.timer'))]
    const offenders = mustEnable
      .filter((path) => !section(contents(path), 'Install').some((line) => /^\s*WantedBy=/.test(line)))
      .map(show)
    expect(offenders, 'without [Install] WantedBy= systemctl enable may enable nothing, reading as a service that disappeared after reboot').toEqual([])
  })

  it('pairs every timer-driven oneshot with a timer that IS enableable', () => {
    // The check that replaces the one above for oneshot units, and it is the stronger one. A
    // oneshot with no [Install] and no timer is never run by anything, and that is indisputably
    // correct-looking: no error, no failed unit, just a renewal that never happens.
    const offenders = files
      .filter((path) => path.endsWith('.service') && isOneshot(path))
      .filter((path) => !section(contents(path), 'Install').some((l) => /^\s*WantedBy=/.test(l)))
      .filter((path) => {
        const timer = path.replace(/\.service$/, '.timer')
        return !existsSync(timer) || !section(contents(timer), 'Install').some((l) => /^\s*WantedBy=/.test(l))
      })
      .map(show)
    expect(offenders, 'a oneshot with neither [Install] nor an enableable .timer is never run by anything').toEqual([])
  })

  it('uses absolute executable paths in ExecStart directives', () => {
    const offenders = files.flatMap((path) => contents(path)
      .filter((line) => /^\s*ExecStart=/.test(line))
      .filter((line) => !/^\s*ExecStart=[-+!@:\|]*\//.test(line))
      .map((line) => `${show(path)}: ${line.trim()}`))
    expect(offenders, 'a relative ExecStart path fails as 203/EXEC, which reads as a missing file').toEqual([])
  })
})

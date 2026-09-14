import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const probe = resolve(process.cwd(), 'deploy/fedbench-healthz.sh').replace(/\\/g, '/')

function hasBash(): boolean {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const BASH = hasBash()

type Run = { status: number; output: string }

function setup(): { state: string; shim: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fedhealthz-'))
  const shim = join(dir, 'shim')
  const state = join(dir, 'state')
  mkdirSync(shim)
  writeFileSync(join(shim, 'curl'), [
    '#!/usr/bin/env bash',
    'out=""; previous=""',
    'for argument in "$@"; do',
    '  if [ "$previous" = "--output" ]; then out=$argument; fi',
    '  previous=$argument',
    'done',
    'if [ -n "$out" ]; then printf "%s" "$FEDBENCH_TEST_BODY" > "$out"; fi',
    'exit "${FEDBENCH_TEST_CURL_STATUS:-0}"',
    '',
  ].join('\n'))
  chmodSync(join(shim, 'curl'), 0o755)
  return { state: state.replace(/\\/g, '/'), shim: shim.replace(/\\/g, '/') }
}

function run(state: string, shim: string, body: string, args: string[] = [], curlStatus = '0'): Run {
  const result = spawnSync('bash', [probe, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shim}:${process.env.PATH}`,
      FEDBENCH_STATE_DIR: state,
      FEDBENCH_TEST_BODY: body,
      FEDBENCH_TEST_CURL_STATUS: curlStatus,
    },
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// These suites spawn bash once or more per assertion. Under the full suite's parallelism that
// exceeds vitest's 5s default and the run fails on TIME, not on behaviour -- a red suite that
// says nothing about the code is worse than a slow one. Scoped here rather than raised
// globally, so a genuinely hanging test elsewhere still fails fast.
describe('deploy/fedbench-healthz.sh', { timeout: 30_000 }, () => {
  it.runIf(BASH)('accepts a healthy endpoint body', () => {
    const { state, shim } = setup()
    const result = run(state, shim, '{"ok":true,"checks":{"database":{"ok":true,"field_definitions":32}}}')
    expect(result.status, result.output).toBe(0)
  })

  it.runIf(BASH)('fails body-level and data-level health defects in --check mode', () => {
    const cases = [
      ['{"ok":false,"checks":{"database":{"ok":true,"field_definitions":32}}}', /ok:false/, '0'],
      ['not json', /not JSON/, '0'],
      ['{"ok":true,"checks":{}}', /missing the database check/, '0'],
      ['{"ok":true,"checks":{"database":{"ok":true,"field_definitions":0}}}', /zero database rows/, '0'],
      ['unread body', /curl could not fetch/, '22'],
    ] as const
    for (const [body, message, curlStatus] of cases) {
      const { state, shim } = setup()
      const result = run(state, shim, body, ['--check'], curlStatus)
      expect(result.status, result.output).toBe(1)
      expect(result.output).toMatch(message)
    }
  })

  it.runIf(BASH)('alerts only on the third consecutive failure, suppresses repeats, and reports recovery', () => {
    const { state, shim } = setup()
    const broken = '{"ok":false,"checks":{"database":{"ok":true,"field_definitions":32}}}'
    expect(run(state, shim, broken).status).toBe(0)
    expect(run(state, shim, broken).status).toBe(0)
    const alert = run(state, shim, broken)
    expect(alert.status, alert.output).toBe(1)

    const repeated = run(state, shim, broken)
    expect(repeated.status, repeated.output).toBe(0)
    expect(repeated.output).toMatch(/re-alert suppressed/)

    const recovery = run(state, shim, '{"ok":true,"checks":{"database":{"ok":true,"field_definitions":32}}}')
    expect(recovery.status, recovery.output).toBe(0)
    expect(recovery.output).toMatch(/RECOVERY/)
    const status = run(state, shim, '', ['--status'])
    expect(status.status, status.output).toBe(0)
    expect(status.output).toMatch(/streak=0/)
  })
})

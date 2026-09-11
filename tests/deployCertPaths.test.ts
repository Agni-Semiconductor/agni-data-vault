// The Caddyfile and renewal script describe the same destinations in different syntax. Keeping
// those descriptions aligned prevents a renewal from succeeding into files Caddy never loads,
// which reads as a healthy renewal until the old certificate expires months later.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const caddyfile = resolve(root, 'deploy/Caddyfile')
const renewalScript = resolve(root, 'deploy/tailscale-cert-renew.sh')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Convert the two files' existing placeholder forms into one comparable path contract. */
function caddyPaths(text: string): Set<string> {
  const match = /^\s*tls\s+(\S+)\s+(\S+)\s*$/m.exec(text)
  if (!match) return new Set()
  return new Set(match.slice(1).map((path) => path.replace(/^<|>$/g, '').toUpperCase()))
}

function renewalPaths(text: string): Set<string> {
  const paths = new Set<string>()
  for (const match of text.matchAll(/^\s*(?:CERT|KEY)="\$\{(TAILSCALE_(?:CERT|KEY)_PATH):/gm)) {
    paths.add(match[1])
  }
  return paths
}

describe('Caddy and certificate renewal paths agree', () => {
  it('the Caddyfile exists', () => {
    expect(existsSync(caddyfile), 'a missing Caddyfile reads as a path mismatch rather than a missing deploy input').toBe(true)
  })

  it('the renewal script exists', () => {
    expect(existsSync(renewalScript), 'a missing renewal script reads as a path mismatch rather than a missing deploy input').toBe(true)
  })

  it('the Caddyfile yields certificate and key paths', () => {
    const paths = caddyPaths(read(caddyfile))
    expect(paths.size, 'no paths extracted from deploy/Caddyfile; an empty set would make the parity check falsely green').toBeGreaterThan(0)
  })

  it('the renewal script yields certificate and key paths', () => {
    const paths = renewalPaths(read(renewalScript))
    expect(paths.size, 'no paths extracted from deploy/tailscale-cert-renew.sh; an empty set would make the parity check falsely green').toBeGreaterThan(0)
  })

  it('uses the same certificate and key paths in both files', () => {
    const caddy = caddyPaths(read(caddyfile))
    const renewal = renewalPaths(read(renewalScript))
    expect(
      caddy,
      `path mismatch: Caddyfile has [${[...caddy].sort().join(', ')}], renewal script has [${[...renewal].sort().join(', ')}]`,
    ).toEqual(renewal)
  })
})

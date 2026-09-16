// Step 8 of root-install.sh and verify-endpoint.sh both describe the live data-plane probe.
// Keeping them aligned matters because an installer can become stricter while the standalone
// verifier still reports healthy, which reads as a working deployment rather than drift.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const installer = resolve(root, 'deploy/root-install.sh')
const verifier = resolve(root, 'deploy/verify-endpoint.sh')
const scripts = [
  { name: 'deploy/root-install.sh', path: installer },
  { name: 'deploy/verify-endpoint.sh', path: verifier },
] as const

function contents(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('endpoint verification parity', () => {
  it('deploy/root-install.sh exists and is non-empty', () => {
    expect(existsSync(installer), 'missing deploy/root-install.sh; parity cannot be checked against the installer').toBe(true)
    expect(contents(installer).trim(), 'deploy/root-install.sh is empty; a blank installer reads as an endpoint mismatch rather than a missing verification').not.toBe('')
  })

  it('deploy/verify-endpoint.sh exists and is non-empty', () => {
    expect(existsSync(verifier), 'missing deploy/verify-endpoint.sh; parity cannot be checked against the standalone verifier').toBe(true)
    expect(contents(verifier).trim(), 'deploy/verify-endpoint.sh is empty; a blank verifier reads as endpoint agreement rather than a missing verification').not.toBe('')
  })

  it('uses connect.kinds as the row-returning probe, not connect.health', () => {
    // kinds is seeded by the migration chain and cannot legitimately be empty. health is all
    // zeros until vault data is migrated, so treating it as the row probe would report healthy
    // while a lost grant returns no rows: the misleading symptom is a healthy empty data plane.
    for (const script of scripts) {
      const text = contents(script.path)
      expect(text, `${script.name} must name connect.kinds as the row-returning probe`).toContain('connect.kinds')
      expect(text, `${script.name} must request the seeded kinds rows rather than use health counts`).toMatch(/rest\/v1\/kinds\?select=kind/)
    }
  })

  it('sends the connect profile header with the probes', () => {
    // Without this header PostgREST can query the wrong schema. The request may still return 200,
    // which reads as a reachable data plane rather than a probe against the connect surface.
    for (const script of scripts) {
      expect(contents(script.path), `${script.name} must select the connect schema`).toContain("Accept-Profile: connect")
    }
  })

  it('requires an unauthenticated kinds request to return 401', () => {
    // RLS with no policies can turn a grant mistake into [] and 200. Requiring 401 proves the
    // refusal is real; otherwise the misleading symptom is an apparently healthy anonymous read.
    for (const script of scripts) {
      const text = contents(script.path)
      expect(text, `${script.name} must make the unauthenticated kinds request`).toMatch(/rest\/v1\/kinds/)
      expect(text, `${script.name} must fail closed with 401, not accept an empty 200 response`).toMatch(/(?:code|\$code).*401|401.*(?:code|\$code)/s)
    }
  })

  it('checks fed_storage health directly on 127.0.0.1:3001', () => {
    // nginx preserves the /storage/v1/ prefix, so its shim cannot reach fed_storage's /health.
    // Going through nginx would make a bad routed path read as a dead storage service instead.
    for (const script of scripts) {
      expect(contents(script.path), `${script.name} must query fed_storage on its direct loopback health endpoint`).toContain('http://127.0.0.1:3001/health')
    }
  })
})

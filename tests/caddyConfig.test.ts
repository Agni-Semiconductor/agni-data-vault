// Caddy's prefix handling must agree with nginx: stripping /rest/v1 twice makes PostgREST return
// 404 for existing tables, which reads as a missing table rather than a doubled path strip.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const caddyfile = resolve(process.cwd(), 'deploy/Caddyfile')

function readCaddyfile(): string {
  return readFileSync(caddyfile, 'utf8')
}

function dataPlaneHandlePaths(text: string): string[] {
  return [...text.matchAll(/^\s*handle_path\s+\/(?:rest|storage)\/v1\/\*\s*\{/gm)].map((match) => match[0].trim())
}

function proxyUpstreams(text: string): string[] {
  return [...text.matchAll(/^\s*reverse_proxy\s+([^\s{]+)/gm)].map((match) => match[1])
}

describe('Caddy data-plane routing is safe', () => {
  it('the Caddyfile exists', () => {
    // Without this, a missing deploy input becomes a later read error that reads as a broken test
    // rather than the absent configuration an operator needs to install.
    expect(existsSync(caddyfile), 'deploy/Caddyfile must exist before its routing contract can be checked').toBe(true)
  })

  it('the Caddyfile is non-trivial', () => {
    // An empty replacement would make searches below find nothing and pass, reading as a safe proxy
    // while the server has no routes at all.
    expect(readCaddyfile().split('\n').length, 'deploy/Caddyfile must contain at least 10 lines').toBeGreaterThanOrEqual(10)
  })

  it('never uses handle_path for /rest/v1 or /storage/v1', () => {
    const offenders = dataPlaneHandlePaths(readCaddyfile())
    expect(offenders, 'handle_path strips these prefixes before nginx strips /rest/v1 again, causing a 404 that reads as a missing table').toEqual([])
  })

  it('detects handle_path on a data-plane route', () => {
    // This mutation proves the detector rejects the double-strip form instead of merely matching
    // the current file and passing when its expression is wrong.
    const unsafe = 'handle_path /rest/v1/* {\n  reverse_proxy 127.0.0.1:8087\n}\n'
    expect(dataPlaneHandlePaths(unsafe), 'the detector must identify the prefix-stripping form that makes existing tables 404').toHaveLength(1)
  })

  it('configures a request body size limit', () => {
    // Without max_size, Caddy rejects real measurement uploads with 413, which reads as a broken
    // client rather than the proxy's small default body limit.
    expect(readCaddyfile()).toMatch(/request_body\s*\{\s*max_size\s+\S+/s)
  })

  it('proxies every upstream through loopback', () => {
    const upstreams = proxyUpstreams(readCaddyfile())
    // An empty extraction would make all() below pass while checking no proxy, reading as an
    // airtight boundary even though a future syntax change escaped the test.
    expect(upstreams, 'expected reverse_proxy upstreams in deploy/Caddyfile').not.toEqual([])
    expect(upstreams.every((upstream) => /^127\.0\.0\.1(?::\d+)?$/.test(upstream)), `routable upstreams expose PostgREST outside Caddy: ${upstreams.join(', ')}`).toBe(true)
  })

  it('strips client-supplied Cloudflare Access identity headers', () => {
    // Forwarding this header lets a client present forged identity to the origin, which reads as
    // an authenticated request unless the application independently catches the forgery.
    expect(readCaddyfile()).toMatch(/^\s*request_header\s+-Cf-Access-Jwt-Assertion\s*$/m)
  })
})

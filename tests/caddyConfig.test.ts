// Caddy's prefix handling must agree with nginx: stripping /rest/v1 twice makes PostgREST return
// 404 for existing tables, which reads as a missing table rather than a doubled path strip.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const caddyfile = resolve(process.cwd(), 'deploy/Caddyfile')

function readCaddyfile(): string {
  return readFileSync(caddyfile, 'utf8')
}

/**
 * The Caddyfile with comment lines removed, for checks about what Caddy will DO.
 *
 * The `auto_https off` assertion below failed on its first run against the comment written to
 * explain why that setting is wrong -- a file documenting a rule has to be able to name the rule.
 * Same shape as the `testingboard` grep in root-install.sh and the VAULT_IDENTITY matcher in
 * tests/envVarParity.test.ts: match what is executed, not what is written about it.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function caddyDirectives(): string {
  return stripComments(readCaddyfile())
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

  it('never binds port 80', () => {
    // Caddy binds :80 by default to serve HTTP->HTTPS redirects. nginx already holds it on the
    // target host, so the unit dies with
    //     listening on :80: listen tcp :80: bind: address already in use
    // which names a port the Caddyfile never mentions and therefore reads as a conflict on 443.
    // Nothing this door serves is acceptable over plain HTTP, so the redirect is not worth a
    // listener. `disable_redirects` rather than `auto_https off`, which would also switch off
    // certificate management.
    expect(caddyDirectives(), 'a global auto_https disable_redirects is what keeps Caddy off :80')
      .toMatch(/auto_https\s+disable_redirects/)
    expect(caddyDirectives(), 'auto_https off would disable certificate management too').not.toMatch(/auto_https\s+off/)
  })

  it('binds only named addresses, never every interface', () => {
    // The target host is on three networks besides the tailnet. Without a bind directive Caddy
    // listens on 0.0.0.0:443 and publishes the data plane to all of them -- while every runbook
    // says "the tailnet door". The address itself is a per-host fact and stays a placeholder here;
    // what is pinned is that the directive exists and that nothing re-widens it.
    expect(caddyDirectives(), 'the site block must carry a bind directive').toMatch(/^\s*bind\s+\S+/m)
    expect(caddyDirectives(), 'binding 0.0.0.0 would defeat the point of the bind directive').not.toMatch(/bind\s+0\.0\.0\.0/)
  })

  it('comment stripping does not blind the directive checks', () => {
    // Narrowing a check is how a check quietly stops checking. A commented-out directive must not
    // satisfy it, and a real one must still be seen.
    // Exercises the SAME stripComments the assertions above use, not a second copy of the logic.
    expect(stripComments('# auto_https disable_redirects\n')).not.toMatch(/auto_https\s+disable_redirects/)
    expect(stripComments('\tauto_https disable_redirects\n')).toMatch(/auto_https\s+disable_redirects/)
    expect(stripComments('# bind 0.0.0.0\n\tbind 100.1.2.3\n')).not.toMatch(/bind\s+0\.0\.0\.0/)
  })
})

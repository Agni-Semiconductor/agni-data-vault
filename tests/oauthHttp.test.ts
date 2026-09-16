// The OAuth endpoints over real HTTP against a real vault-api process: discovery at the root, the
// 401 challenge that starts the flow, form-encoded bodies reaching the token endpoint, and the
// not-configured shape. The unit tests in oauthServer.test.ts prove the logic; this proves the
// wiring in server/vault-api.mjs, which the unit tests cannot see.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

const serverPath = resolve(process.cwd(), 'server/vault-api.mjs')

async function startServer(extraEnv: Record<string, string>, port: number): Promise<ChildProcess> {
  const env = {
    ...process.env,
    // Points at a closed port: nothing here needs the database, and a request that did would 503.
    VAULT_REST_URL: 'http://127.0.0.1:1',
    VAULT_SERVICE_JWT: 'test-token',
    VAULT_API_KEY: 'the-api-key',
    PORT: String(port),
    ...extraEnv,
  }
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (d) => { output += d })
  child.stderr?.on('data', (d) => { output += d })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${output}`)
    try {
      // /healthz answers 503 with the database unreachable, which is still "listening".
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.status === 200 || r.status === 503) return child
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  child.kill()
  throw new Error(`server did not start listening on ${port}: ${output}`)
}

const stop = (c: ChildProcess | undefined) => new Promise<void>((done) => { if (!c || c.exitCode !== null) return done(); c.once('exit', () => done()); c.kill() })

describe('OAuth over HTTP, configured', { timeout: 30_000 }, () => {
  const PORT = 18197
  const ORIGIN = 'https://vault.example.test'
  let child: ChildProcess | undefined
  beforeAll(async () => {
    child = await startServer({
      VAULT_PUBLIC_ORIGIN: ORIGIN,
      VAULT_OAUTH_GOOGLE_CLIENT_ID: 'google-id',
      VAULT_OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
      VAULT_EMAIL_DOMAIN: 'agnisemi.ai',
    }, PORT)
  })
  afterAll(() => stop(child))

  it('serves the protected-resource document at the root and at the path-specific location', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) {
      const r = await fetch(`http://127.0.0.1:${PORT}${path}`)
      expect(r.status, path).toBe(200)
      const body = await r.json()
      expect(body.resource).toBe(`${ORIGIN}/api/mcp`)
      expect(body.authorization_servers).toEqual([ORIGIN])
    }
  })

  it('serves the authorization-server metadata with URLs on the public origin, not the loopback one', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-authorization-server`)
    expect(r.status).toBe(200)
    const m = await r.json()
    expect(m.issuer).toBe(ORIGIN)
    expect(m.token_endpoint).toBe(`${ORIGIN}/oauth/token`)
    expect(m.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('answers an unauthenticated MCP call with a 401 that names the resource metadata', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`)
  })

  it('parses a form-encoded body at the token endpoint', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username: 'x' }).toString(),
    })
    expect(r.status).toBe(400)
    const body = await r.json()
    // unsupported_grant_type, not invalid_request: the body was read and its grant_type seen.
    expect(body.error).toBe('unsupported_grant_type')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses the wrong method on each endpoint', async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/oauth/register`)).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${PORT}/oauth/token`)).status).toBe(405)
    expect((await fetch(`http://127.0.0.1:${PORT}/oauth/authorize`, { method: 'POST' })).status).toBe(405)
  })

  it('fails closed on /oauth/authorize with no redirect when the client cannot be looked up', async () => {
    // This process has no database (VAULT_REST_URL points at a closed port), so the client lookup
    // itself fails. The property under test is the one that matters in that state too: an error,
    // and never a redirect to a redirect_uri nobody has verified. The 400-page shape for a merely
    // unknown client is covered with a memory store in oauthServer.test.ts.
    const r = await fetch(`http://127.0.0.1:${PORT}/api/oauth/authorize?client_id=nope&redirect_uri=https%3A%2F%2Fattacker.example%2F&response_type=code`, { redirect: 'manual' })
    expect([400, 500]).toContain(r.status)
    expect(r.headers.get('location')).toBeNull()
  })

  it('leaves the REST API exactly as it was: a key works, an OAuth-looking token does not', async () => {
    const withKey = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { authorization: 'Bearer the-api-key' } })
    expect(withKey.status).toBe(200)
    const withVlt = await fetch(`http://127.0.0.1:${PORT}/api/me`, { headers: { authorization: 'Bearer vlt_anything' } })
    expect(withVlt.status).toBe(401)
  })
})

describe('OAuth over HTTP, not configured', { timeout: 30_000 }, () => {
  const PORT = 18196
  let child: ChildProcess | undefined
  beforeAll(async () => { child = await startServer({ VAULT_PUBLIC_ORIGIN: '', VAULT_OAUTH_GOOGLE_CLIENT_ID: '', VAULT_OAUTH_GOOGLE_CLIENT_SECRET: '' }, PORT) })
  afterAll(() => stop(child))

  it('answers the discovery paths with 404 oauth_not_configured, and the MCP 401 carries no metadata pointer', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`)
    expect(r.status).toBe(404)
    expect((await r.json()).error).toBe('oauth_not_configured')
    const mcp = await fetch(`http://127.0.0.1:${PORT}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    expect(mcp.status).toBe(401)
    expect(mcp.headers.get('www-authenticate')).not.toContain('resource_metadata')
  })
})

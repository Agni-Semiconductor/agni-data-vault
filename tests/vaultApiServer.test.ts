// vault-api.mjs replaces Vercel's request adapter. These checks keep deployment-only failures
// visible in CI instead of presenting as a healthy process that corrupts uploads or returns 500.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const serverPath = resolve(root, 'server/vault-api.mjs')

function accumulatesRequestBodyAsString(text: string): boolean {
  // A string plus chunks coerces binary bytes and retains the whole upload; callers then see a
  // corrupt file while the misleading server symptom is merely increased memory use.
  return /\b(?:let|var)\s+(\w+)\s*=\s*(['"])\2\s*;?[\s\S]*?\b\1\s*(?:\+=|=)\s*(?:\1\s*\+\s*)?(?:chunk|data)\b/.test(text)
}

function streamsContentUploads(text: string): boolean {
  // The route condition and raw-stream handoff must stay together; either missing piece sends a
  // file through JSON parsing, whose misleading symptom is an ordinary 500 after a large upload.
  return /const isContentUpload\s*=\s*[\s\S]*?\/content/.test(text)
    && /if\s*\(isContentUpload\)\s*\{\s*req\.rawStream\s*=\s*req\s*;?\s*\}/.test(text)
}

function bindsLoopbackOnly(text: string): boolean {
  // A fixed loopback literal prevents a proxy-bypassing listener; the misleading symptom is a
  // working API that has silently become reachable with its service credentials.
  return /const host\s*=\s*['"]127\.0\.0\.1['"]\s*;/.test(text)
    && !/(?:\bhost\s*=\s*|listen\s*\([^)]*)['"]0\.0\.0\.0['"]/.test(text)
}

/**
 * Does the server actually refuse to start without its credentials?
 *
 * RUN IT, do not read it. The first version of this matched the source for
 * `if (...) throw new Error` before `server.listen(`, which is one way to write the guard and not
 * the only correct one -- it reported a missing guard against an implementation that refuses
 * correctly using `process.exit(1)`. Pinning an incidental form rather than the property is how a
 * check ends up failing working code and, worse, passing broken code written in the expected
 * shape.
 *
 * The property: with the credentials absent, the process must exit NON-ZERO and must not listen.
 * The failure being guarded is a server that starts cleanly, so systemd reports `active` and a
 * port monitor sees a listener, while every request returns 500 about the environment -- up and
 * broken at once, which is the hardest state to diagnose and the one a health check is least
 * likely to tell apart from a database outage.
 */
function startsWithoutCredentials(): { code: number | null; stderr: string } {
  const env = { ...process.env }
  delete env.VAULT_REST_URL
  delete env.VAULT_SERVICE_JWT
  // A port nothing else uses, so a regression that DOES listen cannot collide with a real service
  // and be mistaken for the refusal under test.
  env.PORT = '18199'
  const run = spawnSync(process.execPath, [serverPath], { env, encoding: 'utf8', timeout: 15_000 })
  return { code: run.status, stderr: `${run.stderr ?? ''}${run.stdout ?? ''}` }
}

describe('vault API server deployment boundary', () => {
  it('found a substantive server file before applying text checks', () => {
    // A missing or stub file makes later text searches vacuously green, misleading CI into saying
    // the deployed API was checked when there was no server implementation to inspect.
    expect(existsSync(serverPath), 'server/vault-api.mjs must exist').toBe(true)
    expect(readFileSync(serverPath, 'utf8').length, 'server/vault-api.mjs must not be an empty stub').toBeGreaterThan(1_000)
  })

  it('detects a missing or empty server file', () => {
    // This proves the size detector rejects the vacuous green produced by a file with no server.
    expect(''.length).not.toBeGreaterThan(1_000)
  })

  it('does not accumulate request chunks in a string', () => {
    expect(accumulatesRequestBodyAsString(readFileSync(serverPath, 'utf8'))).toBe(false)
  })

  it('detects string accumulation of request chunks', () => {
    // This is scripts/api-dev.mjs's bad form; binary uploads become text while memory rises.
    expect(accumulatesRequestBodyAsString("let raw = ''; for await (const chunk of req) raw += chunk")).toBe(true)
  })

  it('hands content uploads to the streaming path', () => {
    expect(streamsContentUploads(readFileSync(serverPath, 'utf8'))).toBe(true)
  })

  it('detects a content route without a streaming handoff', () => {
    // A route that only identifies /content still buffers it, misleading callers with late 500s.
    expect(streamsContentUploads("const isContentUpload = url.pathname.includes('/content')")).toBe(false)
  })

  it('binds the listener to loopback rather than a routable address', () => {
    expect(bindsLoopbackOnly(readFileSync(serverPath, 'utf8'))).toBe(true)
  })

  it('detects a routable listener bind', () => {
    // Binding all interfaces bypasses nginx and Caddy, while the misleading symptom is a normal API.
    expect(bindsLoopbackOnly("const host = '0.0.0.0'; server.listen(port, host)")).toBe(false)
  })

  it('refuses to start when its credentials are absent', () => {
    const { code, stderr } = startsWithoutCredentials()
    expect(code, 'a zero exit means it started without credentials and will 500 every request while systemd reports active').not.toBe(0)
    // The message has to name what is missing. "cannot start" without the variable names sends the
    // operator to the code, when the answer is a line in /etc/vault/vault-api.env.
    expect(stderr).toMatch(/VAULT_REST_URL/)
    expect(stderr).toMatch(/VAULT_SERVICE_JWT/)
  })

  it('starts when they are present', () => {
    // The other half, because a guard that rejects everything also passes the test above. Points at
    // a closed port: the check is that it reaches "listening", not that it can serve anything.
    const env = { ...process.env, VAULT_REST_URL: 'http://127.0.0.1:1/rest/v1', VAULT_SERVICE_JWT: 'test-token', PORT: '18198' }
    // ASSERT ON PROCESS STATE, NOT ON STDOUT. The first version matched the "listening" line, and
    // it was flaky: the server never exits on its own, so spawnSync's timeout kills it with
    // SIGTERM, and node does not reliably flush a piped stdout on the way out. It passed by luck
    // and then failed for a reason unrelated to the code under test -- a flaky test is worse than
    // no test, because it teaches people to re-run rather than read.
    //
    // The deterministic signals: a guard REJECTION exits immediately with status 1 and prints the
    // refusal. A successful start never exits, so the timeout kills it and status is null.
    const run = spawnSync(process.execPath, [serverPath], { env, encoding: 'utf8', timeout: 3_000 })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    expect(output, 'the guard must not reject a correctly configured start').not.toMatch(/refusing to start/i)
    expect(run.status, 'exiting at all means it refused; a correct start runs until the timeout kills it').not.toBe(1)
  }, 15_000)
})

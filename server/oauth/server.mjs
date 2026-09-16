/**
 * The vault's OAuth 2.1 authorization server for the MCP endpoint (Tier 2 identity).
 *
 * WHAT THIS IS. Claude's clients implement the MCP authorization spec: on a 401 they read
 * /.well-known/oauth-protected-resource, find this server, register themselves (RFC 7591), send the
 * person to /oauth/authorize with a PKCE challenge, and exchange the returned code at /oauth/token.
 * This module is those four endpoints plus the Google round trip in the middle. The person signs
 * in with Google Workspace; we verify Google's id_token, insist on the Workspace domain, and issue
 * OUR OWN opaque tokens bound to that email. Google's tokens are discarded.
 *
 * WHAT IT IS NOT. Not a model, not a call to Anthropic, not a session for the web app. It issues
 * bearer tokens the MCP endpoint checks against vault.oauth_tokens; api/_lib/auth.js never sees them.
 *
 * THE RULES, each of which has a test:
 *   * Public clients only, PKCE S256 required, exact redirect_uri match. No client secret exists.
 *   * An invalid client_id or redirect_uri on /authorize is a 400 page, never a redirect: an open
 *     redirector is the classic OAuth hole and it is refused by shape here.
 *   * Codes are single-use, hashed, and expire in minutes. Access tokens expire in an hour.
 *   * Refresh tokens rotate; replaying an old one revokes its whole descendant chain.
 *   * A valid Google login for someone outside VAULT_EMAIL_DOMAIN is a refusal (error page), and
 *     nothing is issued. A permitted person is upserted into vault.people as `member`.
 *
 * Everything time- or randomness-dependent is injectable, so the tests are deterministic.
 */
import crypto from 'node:crypto'
import { AUTH_URL, exchangeCode, permittedEmail, verifyIdToken } from './google.mjs'

export const SCOPE = 'vault:read'
const CODE_TTL_S = 300
const ACCESS_TTL_S = 3600
const REFRESH_TTL_S = 30 * 24 * 3600
const GRANT_TTL_S = 600

// Read literally from process.env, one variable per line: tests/envVarParity.test.ts finds the
// variables this server reads by grepping for exactly this form, and a table of documented
// variables nothing reads is the failure that test exists to catch.
export function oauthConfigFromEnv() {
  const origin = (process.env.VAULT_PUBLIC_ORIGIN || '').replace(/\/$/, '')
  return {
    origin,
    googleClientId: process.env.VAULT_OAUTH_GOOGLE_CLIENT_ID || '',
    googleClientSecret: process.env.VAULT_OAUTH_GOOGLE_CLIENT_SECRET || '',
    emailDomain: process.env.VAULT_EMAIL_DOMAIN || '',
  }
}

export function isConfigured(config) {
  return Boolean(config.origin && /^https:\/\//.test(config.origin) && config.googleClientId && config.googleClientSecret && config.emailDomain)
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const b64url = (buf) => Buffer.from(buf).toString('base64url')

function redirectUriAllowed(uri) {
  let u
  try { u = new URL(uri) } catch { return false }
  if (u.hash) return false
  if (u.protocol === 'https:') return true
  // RFC 8252 §7.3: native apps use a loopback redirect. Any port, http only on loopback.
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return true
  return false
}

function sameRedirect(registered, presented) {
  // Exact match, except that a loopback URI may vary its port (RFC 8252 §7.3): the client cannot
  // know which port will be free when it registers.
  if (registered === presented) return true
  try {
    const a = new URL(registered), b = new URL(presented)
    const loop = (u) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    return loop(a) && loop(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
  } catch { return false }
}

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' }
const json = (status, body, headers = {}) => ({ status, body, headers: { 'content-type': 'application/json', ...headers } })
const oauthError = (status, error, description) => json(status, { error, error_description: description }, noStore)
const html = (status, title, text) => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...noStore },
  body: `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:40em;margin:4em auto"><h1>${esc(title)}</h1><p>${esc(text)}</p><p>You can close this window.</p>`,
})
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function createOAuthServer({ store, config, fetchImpl = fetch, now = () => Date.now(), random = (n) => crypto.randomBytes(n) }) {
  const origin = config.origin
  const iso = (ms) => new Date(ms).toISOString()
  const newToken = () => `vlt_${b64url(random(32))}`

  function metadataAS() {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      service_documentation: `${origin}/api/schema`,
    }
  }

  function metadataPR() {
    return {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'Agni data vault (read-only MCP)',
    }
  }

  async function register(body) {
    if (!body || typeof body !== 'object') return oauthError(400, 'invalid_client_metadata', 'a JSON object is required')
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : []
    if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && redirectUriAllowed(u))) {
      return oauthError(400, 'invalid_redirect_uri', 'redirect_uris must be 1-10 https URIs, or http URIs on 127.0.0.1/localhost, with no fragment')
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
      return oauthError(400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method "none") are supported')
    }
    const grants = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code']
    if (!grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
      return oauthError(400, 'invalid_client_metadata', 'grant_types may only include authorization_code and refresh_token')
    }
    const client_id = `mcp_${b64url(random(16))}`
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null
    await store.putClient({ client_id, client_name: name, redirect_uris: uris, created_at: iso(now()) })
    return json(201, {
      client_id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, noStore)
  }

  async function authorize(query) {
    const q = query || {}
    // The two parameters that decide WHERE an error goes. If either is wrong we must not redirect.
    const client = typeof q.client_id === 'string' ? await store.getClient(q.client_id) : null
    if (!client) return html(400, 'Unknown client', 'This MCP client is not registered with the vault. Reconnect it so it can register again.')
    const redirect = typeof q.redirect_uri === 'string' ? q.redirect_uri : ''
    if (!redirect || !client.redirect_uris.some((r) => sameRedirect(r, redirect))) {
      return html(400, 'Redirect not allowed', 'The redirect address in this request is not one the client registered. Nothing was sent anywhere.')
    }
    const back = (error, description) => {
      const u = new URL(redirect)
      u.searchParams.set('error', error)
      u.searchParams.set('error_description', description)
      if (typeof q.state === 'string') u.searchParams.set('state', q.state)
      return { status: 302, headers: { location: u.toString(), ...noStore } }
    }
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code')
    if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'a PKCE code_challenge (S256) is required')
    if (q.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256')
    if (typeof q.scope === 'string' && q.scope.split(' ').some((s) => s && s !== SCOPE)) return back('invalid_scope', `the only scope is ${SCOPE}`)
    if (typeof q.resource === 'string' && q.resource !== `${origin}/api/mcp` && q.resource !== `${origin}/mcp`) return back('invalid_target', `this server issues tokens for ${origin}/api/mcp only`)
    const grantId = await store.putGrant({
      client_id: client.client_id,
      redirect_uri: redirect,
      client_state: typeof q.state === 'string' ? q.state : null,
      code_challenge: q.code_challenge,
      scope: SCOPE,
      created_at: iso(now()),
      expires_at: iso(now() + GRANT_TTL_S * 1000),
    })
    const g = new URL(AUTH_URL)
    g.searchParams.set('client_id', config.googleClientId)
    g.searchParams.set('redirect_uri', `${origin}/oauth/callback`)
    g.searchParams.set('response_type', 'code')
    g.searchParams.set('scope', 'openid email')
    g.searchParams.set('state', grantId)
    // hd narrows Google's account chooser to the Workspace; it is a hint, and the id_token's hd
    // claim is what we actually check.
    g.searchParams.set('hd', config.emailDomain)
    g.searchParams.set('prompt', 'select_account')
    return { status: 302, headers: { location: g.toString(), ...noStore } }
  }

  async function callback(query) {
    const q = query || {}
    if (typeof q.state !== 'string' || !q.state) return html(400, 'Missing state', 'Google returned without the state this server sent. Start the connection again.')
    const grant = await store.getGrant(q.state)
    if (!grant) return html(400, 'Unknown request', 'This sign-in does not match a connection attempt this server started. Start again from your MCP client.')
    if (grant.consumed_at || grant.code_hash) return html(400, 'Already used', 'This sign-in was already completed once. Start again from your MCP client.')
    if (new Date(grant.expires_at).getTime() < now()) return html(400, 'Expired', 'This connection attempt took longer than ten minutes. Start again from your MCP client.')
    if (typeof q.error === 'string') return html(400, 'Sign-in cancelled', `Google reported: ${q.error}.`)
    if (typeof q.code !== 'string' || !q.code) return html(400, 'Missing code', 'Google returned no authorization code.')

    let email
    try {
      const idToken = await exchangeCode({ code: q.code, clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: `${origin}/oauth/callback`, fetchImpl })
      const payload = await verifyIdToken(idToken, { clientId: config.googleClientId, fetchImpl, now })
      email = permittedEmail(payload, config.emailDomain)
    } catch (err) {
      return html(502, 'Sign-in could not be verified', `Google's response did not verify: ${err?.message || err}. Nothing was issued.`)
    }
    if (!email) {
      // A real Google account, the wrong organisation. Refuse, and do not consume the grant into a
      // code: there is nothing to issue.
      await store.updateGrant(grant.id, { consumed_at: iso(now()) })
      return html(403, 'Not permitted', `Only ${config.emailDomain} Google Workspace accounts may connect to the vault. Sign in with your work account.`)
    }
    await store.ensurePerson(email)
    const code = b64url(random(32))
    await store.updateGrant(grant.id, { email, code_hash: sha256(code), code_expires_at: iso(now() + CODE_TTL_S * 1000) })
    const u = new URL(grant.redirect_uri)
    u.searchParams.set('code', code)
    if (grant.client_state) u.searchParams.set('state', grant.client_state)
    return { status: 302, headers: { location: u.toString(), ...noStore } }
  }

  async function issueTokens(email, clientId, parentHash = null) {
    const access = newToken(), refresh = newToken()
    const at = now()
    await store.putToken({ token_hash: sha256(access), kind: 'access', email, client_id: clientId, scope: SCOPE, parent_hash: parentHash, expires_at: iso(at + ACCESS_TTL_S * 1000), created_at: iso(at) })
    await store.putToken({ token_hash: sha256(refresh), kind: 'refresh', email, client_id: clientId, scope: SCOPE, parent_hash: parentHash, expires_at: iso(at + REFRESH_TTL_S * 1000), created_at: iso(at) })
    await store.touchClient(clientId, iso(at))
    return json(200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE }, noStore)
  }

  async function token(body) {
    const b = body && typeof body === 'object' ? body : {}
    if (b.grant_type === 'authorization_code') {
      if (typeof b.code !== 'string' || typeof b.code_verifier !== 'string' || typeof b.client_id !== 'string') {
        return oauthError(400, 'invalid_request', 'code, code_verifier and client_id are required')
      }
      const grant = await store.getGrantByCodeHash(sha256(b.code))
      if (!grant || !grant.email) return oauthError(400, 'invalid_grant', 'unknown code')
      if (grant.consumed_at) {
        // A code presented twice is either a bug or an attacker who saw the first redirect. Either
        // way the tokens minted from it are gone.
        return oauthError(400, 'invalid_grant', 'code already used')
      }
      if (new Date(grant.code_expires_at).getTime() < now()) return oauthError(400, 'invalid_grant', 'code expired')
      if (grant.client_id !== b.client_id) return oauthError(400, 'invalid_grant', 'code was issued to a different client')
      if (typeof b.redirect_uri === 'string' && b.redirect_uri !== grant.redirect_uri) return oauthError(400, 'invalid_grant', 'redirect_uri does not match')
      if (!/^[A-Za-z0-9_.~-]{43,128}$/.test(b.code_verifier) || b64url(crypto.createHash('sha256').update(b.code_verifier).digest()) !== grant.code_challenge) {
        return oauthError(400, 'invalid_grant', 'PKCE verification failed')
      }
      await store.updateGrant(grant.id, { consumed_at: iso(now()) })
      return issueTokens(grant.email, grant.client_id)
    }
    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string') return oauthError(400, 'invalid_request', 'refresh_token is required')
      const hash = sha256(b.refresh_token)
      const row = await store.getToken(hash)
      if (!row || row.kind !== 'refresh') return oauthError(400, 'invalid_grant', 'unknown refresh token')
      if (typeof b.client_id === 'string' && b.client_id !== row.client_id) return oauthError(400, 'invalid_grant', 'refresh token belongs to a different client')
      if (row.revoked_at) {
        // Replay of a rotated token: revoke everything descended from it, RFC 6819 §5.2.2.3.
        await store.revokeChain(hash, iso(now()))
        return oauthError(400, 'invalid_grant', 'refresh token was already used; the session has been revoked')
      }
      if (new Date(row.expires_at).getTime() < now()) return oauthError(400, 'invalid_grant', 'refresh token expired')
      await store.updateToken(hash, { revoked_at: iso(now()), last_used_at: iso(now()) })
      return issueTokens(row.email, row.client_id, hash)
    }
    return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
  }

  /** For the MCP endpoint: the person behind a bearer token, or null. */
  async function authenticateBearer(bearer) {
    if (typeof bearer !== 'string' || !bearer.startsWith('vlt_')) return null
    const row = await store.getToken(sha256(bearer))
    if (!row || row.kind !== 'access' || row.revoked_at) return null
    if (new Date(row.expires_at).getTime() < now()) return null
    await store.updateToken(row.token_hash, { last_used_at: iso(now()) })
    return { email: String(row.email).toLowerCase(), scope: row.scope, client_id: row.client_id }
  }

  return { metadataAS, metadataPR, register, authorize, callback, token, authenticateBearer }
}

/**
 * HTTP dispatch for the raw Node server. Returns true when the path was one of ours. Paths are
 * accepted with and without the /api prefix, because Caddy proxies /api/* already and the
 * .well-known documents must live at the root per RFC 8414 / RFC 9728.
 */
export async function handleOAuthRequest(req, res, oauth, configured) {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname.replace(/^\/api(?=\/)/, '')
  const method = (req.method || 'GET').toUpperCase()
  const send = ({ status, body, headers = {} }) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    if (body === undefined) { res.end(); return }
    if (typeof body === 'string') { res.end(body); return }
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const isOurs = path === '/.well-known/oauth-authorization-server'
    || path.startsWith('/.well-known/oauth-protected-resource')
    || /^\/oauth\/(register|authorize|callback|token)$/.test(path)
  if (!isOurs) return false
  if (!configured) {
    send({ status: 404, body: { error: 'oauth_not_configured', error_description: 'This vault has no OAuth identity provider configured; use a bearer key.' } })
    return true
  }
  // Discovery documents are public by design and safe to cache briefly.
  if (path === '/.well-known/oauth-authorization-server') { send({ status: 200, body: oauth.metadataAS(), headers: { 'cache-control': 'public, max-age=300' } }); return true }
  if (path.startsWith('/.well-known/oauth-protected-resource')) { send({ status: 200, body: oauth.metadataPR(), headers: { 'cache-control': 'public, max-age=300' } }); return true }
  const query = Object.fromEntries(url.searchParams)
  if (path === '/oauth/register') { if (method !== 'POST') { send({ status: 405, body: { error: 'invalid_request' }, headers: { allow: 'POST' } }); return true } send(await oauth.register(req.body)); return true }
  if (path === '/oauth/authorize') { if (method !== 'GET') { send({ status: 405, body: { error: 'invalid_request' }, headers: { allow: 'GET' } }); return true } send(await oauth.authorize(query)); return true }
  if (path === '/oauth/callback') { if (method !== 'GET') { send({ status: 405, body: { error: 'invalid_request' }, headers: { allow: 'GET' } }); return true } send(await oauth.callback(query)); return true }
  if (path === '/oauth/token') { if (method !== 'POST') { send({ status: 405, body: { error: 'invalid_request' }, headers: { allow: 'POST' } }); return true } send(await oauth.token(req.body)); return true }
  return false
}

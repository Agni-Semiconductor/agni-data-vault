/**
 * Google as the identity provider: exchange the code, verify the id_token, return an email.
 *
 * Verified, never trusted -- the same rule as api/_lib/accessJwt.js and for the same reason. The
 * id_token is RS256 signed with a key from Google's JWKS; we check the signature, issuer, audience
 * (our client id), expiry, `email_verified`, and then the two domain rules the Access path already
 * enforces: `hd` must equal VAULT_EMAIL_DOMAIN and so must the email's own domain. `hd` is asserted
 * by Google about the account's Workspace and cannot be satisfied by a personal account with a
 * lookalike address.
 *
 * `fetch` is injectable so the whole flow is testable against a fake Google.
 */
import crypto from 'node:crypto'

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

const cacheTtlMs = 10 * 60 * 1000
let keyCache = null

function decodePart(part, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error(`invalid id_token ${name}`)
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { throw new Error(`invalid id_token ${name}`) }
}

async function getKeys(fetchImpl, refresh = false) {
  if (!refresh && keyCache && keyCache.expiresAt > Date.now()) return keyCache.keys
  const response = await fetchImpl(JWKS_URL)
  if (!response.ok) throw new Error('failed to fetch Google signing keys')
  const body = await response.json()
  if (!Array.isArray(body.keys)) throw new Error('invalid Google signing keys')
  keyCache = { keys: body.keys, expiresAt: Date.now() + cacheTtlMs }
  return keyCache.keys
}

export function resetKeyCache() { keyCache = null }

async function getKey(fetchImpl, kid) {
  let key = (await getKeys(fetchImpl)).find((k) => k.kid === kid)
  if (key) return key
  key = (await getKeys(fetchImpl, true)).find((k) => k.kid === kid)
  if (!key) throw new Error('unknown id_token signing key')
  return key
}

/** Verify a Google id_token and return its payload. Throws on anything short of a valid one. */
export async function verifyIdToken(token, { clientId, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (typeof token !== 'string') throw new Error('invalid id_token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('invalid id_token')
  const header = decodePart(parts[0], 'header')
  const payload = decodePart(parts[1], 'payload')
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid id_token header')
  const key = await getKey(fetchImpl, header.kid)
  if (key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') throw new Error('invalid id_token signing key')
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error('invalid id_token signature')
  let publicKey
  try { publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' }) } catch { throw new Error('invalid id_token signing key') }
  if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error('invalid id_token signature')
  const nowS = Math.floor(now() / 1000)
  const skew = 60
  if (!ISSUERS.has(payload.iss)) throw new Error('invalid id_token issuer')
  const aud = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : []
  if (!clientId || !aud.includes(clientId)) throw new Error('invalid id_token audience')
  if (typeof payload.exp !== 'number' || payload.exp < nowS - skew) throw new Error('expired id_token')
  if (typeof payload.iat !== 'number' || payload.iat > nowS + skew) throw new Error('invalid id_token issued-at time')
  return payload
}

/**
 * The identity decision. Returns a lowercased email, or null when Google vouched for someone who
 * is not permitted here. Null, not a throw: "valid token, wrong person" is a refusal, not an error.
 */
export function permittedEmail(payload, domain) {
  if (!domain) return null
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (payload.email_verified !== true) return null
  if (payload.hd !== domain) return null
  const at = email.split('@')
  if (at.length !== 2 || at[1] !== domain) return null
  return email
}

/** Exchange an authorization code at Google for an id_token. */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const body = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  const response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`)
  const json = await response.json()
  if (typeof json.id_token !== 'string') throw new Error('Google token response carried no id_token')
  return json.id_token
}

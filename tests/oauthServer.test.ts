// @ts-nocheck
// The OAuth authorization server for the MCP endpoint (contract v2.21), driven end to end against
// a memory store and a fake Google: register, authorize, the Google round trip, code exchange with
// PKCE, refresh rotation, and the bearer check the MCP endpoint performs. The clock and randomness
// are injected so every assertion is exact.
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOAuthServer, isConfigured, oauthConfigFromEnv, SCOPE } from '../server/oauth/server.mjs';
import { memoryStore } from '../server/oauth/store.mjs';
import { permittedEmail, resetKeyCache } from '../server/oauth/google.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = pair.publicKey.export({ format: 'jwk' });
const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const ORIGIN = 'https://vault.example.test';
const config = { origin: ORIGIN, googleClientId: 'google-client-id', googleClientSecret: 'google-secret', emailDomain: 'agnisemi.ai' };

let clock = Date.parse('2026-09-16T12:00:00Z');
const now = () => clock;
let counter = 0;
// Deterministic "randomness": distinct, but readable in failures.
const random = (n) => Buffer.from(String(++counter).padStart(n, '0').slice(0, n));

function idToken(overrides = {}, key = pair.privateKey, header = { alg: 'RS256', kid: 'g1', typ: 'JWT' }) {
  const payload = { iss: 'https://accounts.google.com', aud: 'google-client-id', exp: Math.floor(now() / 1000) + 300, iat: Math.floor(now() / 1000), email: 'owen@agnisemi.ai', email_verified: true, hd: 'agnisemi.ai', ...overrides };
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
  return `${input}.${sig}`;
}

/** A fake Google: JWKS, and a token endpoint that returns whatever id_token the test chose. */
function fakeGoogle(nextIdToken) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth2/v3/certs')) return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'g1', alg: 'RS256', use: 'sig' }] }), { status: 200 });
    if (String(url).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ id_token: typeof nextIdToken === 'function' ? nextIdToken() : nextIdToken, access_token: 'ignored' }), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, calls };
}

const verifier = 'v'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

async function registerClient(oauth, redirect = 'http://127.0.0.1:33445/callback') {
  const r = await oauth.register({ client_name: 'Claude Desktop', redirect_uris: [redirect] });
  expect(r.status).toBe(201);
  return r.body.client_id;
}

async function fullLogin(oauth, store, google, clientId, redirect = 'http://127.0.0.1:33445/callback') {
  const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state-1', scope: SCOPE });
  expect(a.status).toBe(302);
  const toGoogle = new URL(a.headers.location);
  const grantId = toGoogle.searchParams.get('state');
  const cb = await oauth.callback({ state: grantId, code: 'google-code' });
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location);
  return { grantId, code: back.searchParams.get('code'), state: back.searchParams.get('state'), back };
}

beforeEach(() => { clock = Date.parse('2026-09-16T12:00:00Z'); counter = 0; resetKeyCache(); });

describe('configuration', () => {
  const saved = {};
  const VARS = ['VAULT_PUBLIC_ORIGIN', 'VAULT_OAUTH_GOOGLE_CLIENT_ID', 'VAULT_OAUTH_GOOGLE_CLIENT_SECRET', 'VAULT_EMAIL_DOMAIN'];
  beforeEach(() => { for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; } });
  afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } });
  it('is configured only with all three values and an https origin', () => {
    expect(isConfigured(config)).toBe(true);
    expect(isConfigured({ ...config, origin: 'http://vault.example.test' })).toBe(false);
    expect(isConfigured({ ...config, googleClientSecret: '' })).toBe(false);
    expect(isConfigured(oauthConfigFromEnv()), 'nothing set').toBe(false);
  });
  it('reads the four variables from the environment and strips a trailing slash from the origin', () => {
    process.env.VAULT_PUBLIC_ORIGIN = 'https://x.test/';
    process.env.VAULT_OAUTH_GOOGLE_CLIENT_ID = 'id';
    process.env.VAULT_OAUTH_GOOGLE_CLIENT_SECRET = 'secret';
    process.env.VAULT_EMAIL_DOMAIN = 'agnisemi.ai';
    const c = oauthConfigFromEnv();
    expect(c).toEqual({ origin: 'https://x.test', googleClientId: 'id', googleClientSecret: 'secret', emailDomain: 'agnisemi.ai' });
    expect(isConfigured(c)).toBe(true);
  });
});

describe('discovery', () => {
  const oauth = createOAuthServer({ store: memoryStore(), config, now, random });
  it('names the MCP endpoint as the resource and this server as its authorization server', () => {
    expect(oauth.metadataPR()).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN], scopes_supported: [SCOPE] });
  });
  it('advertises PKCE S256, public clients, and both grant types', () => {
    const m = oauth.metadataAS();
    expect(m.issuer).toBe(ORIGIN);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  });
});

describe('dynamic registration', () => {
  let store, oauth;
  beforeEach(() => { store = memoryStore(); oauth = createOAuthServer({ store, config, now, random }); });
  it('registers a public client with https or loopback redirect URIs', async () => {
    const r = await oauth.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:1234/cb'] });
    expect(r.status).toBe(201);
    expect(r.body.token_endpoint_auth_method).toBe('none');
    expect(store.clients.get(r.body.client_id).redirect_uris).toHaveLength(2);
  });
  it.each([
    ['no URIs', { redirect_uris: [] }],
    ['plain http off loopback', { redirect_uris: ['http://evil.example/cb'] }],
    ['a fragment', { redirect_uris: ['https://ok.example/cb#frag'] }],
    ['a confidential client', { redirect_uris: ['https://ok.example/cb'], token_endpoint_auth_method: 'client_secret_basic' }],
    ['an unsupported grant', { redirect_uris: ['https://ok.example/cb'], grant_types: ['implicit'] }],
  ])('refuses %s', async (_name, body) => {
    const r = await oauth.register(body);
    expect(r.status).toBe(400);
    expect(store.clients.size).toBe(0);
  });
});

describe('authorize', () => {
  let store, oauth, clientId;
  beforeEach(async () => { store = memoryStore(); oauth = createOAuthServer({ store, config, now, random }); clientId = await registerClient(oauth); });
  it('sends the person to Google with the grant id as state and the Workspace hint', async () => {
    const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    expect(a.status).toBe(302);
    const u = new URL(a.headers.location);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('google-client-id');
    expect(u.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`);
    expect(u.searchParams.get('hd')).toBe('agnisemi.ai');
    expect(u.searchParams.get('scope')).toBe('openid email');
    const grant = store.grants.get(u.searchParams.get('state'));
    expect(grant).toMatchObject({ client_id: clientId, code_challenge: challenge, client_state: 's' });
  });
  it('never redirects on an unknown client or an unregistered redirect_uri', async () => {
    const unknown = await oauth.authorize({ response_type: 'code', client_id: 'nope', redirect_uri: 'https://attacker.example/', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
    const wrongUri = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'https://attacker.example/', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(wrongUri.status).toBe(400);
    expect(wrongUri.headers.location).toBeUndefined();
    expect(store.grants.size).toBe(0);
  });
  it('allows a loopback redirect on a different port than registered (RFC 8252)', async () => {
    const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:50001/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(a.status).toBe(302);
  });
  it.each([
    ['a missing PKCE challenge', { code_challenge: undefined }, 'invalid_request'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['an unknown scope', { scope: 'vault:write' }, 'invalid_scope'],
    ['a foreign resource', { resource: 'https://other.example/mcp' }, 'invalid_target'],
    ['a token response type', { response_type: 'token' }, 'unsupported_response_type'],
  ])('redirects back with an error for %s', async (_name, patch, error) => {
    const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', ...patch });
    expect(a.status).toBe(302);
    const u = new URL(a.headers.location);
    expect(u.origin).toBe('http://127.0.0.1:33445');
    expect(u.searchParams.get('error')).toBe(error);
    expect(u.searchParams.get('state')).toBe('st');
    expect(store.grants.size).toBe(0);
  });
});

describe('the Google round trip', () => {
  let store, oauth, clientId, google;
  beforeEach(async () => {
    store = memoryStore();
    google = fakeGoogle(() => idToken());
    oauth = createOAuthServer({ store, config, fetchImpl: google.fetchImpl, now, random });
    clientId = await registerClient(oauth);
  });
  it('verifies the id_token, provisions the person, and returns a single-use code with the client state', async () => {
    const { code, state, grantId } = await fullLogin(oauth, store, google, clientId);
    expect(code).toBeTruthy();
    expect(state).toBe('client-state-1');
    expect(store.people.get('owen@agnisemi.ai')).toEqual({ email: 'owen@agnisemi.ai', role: 'member' });
    const grant = store.grants.get(grantId);
    expect(grant.email).toBe('owen@agnisemi.ai');
    expect(grant.code_hash).toBe(crypto.createHash('sha256').update(code).digest('hex'));
    // Google's code was exchanged with our client credentials and our callback.
    const exchange = google.calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
    expect(new URLSearchParams(exchange.init.body).get('redirect_uri')).toBe(`${ORIGIN}/oauth/callback`);
  });
  it('refuses a Google account outside the Workspace domain, and issues nothing', async () => {
    google = fakeGoogle(() => idToken({ email: 'someone@gmail.com', hd: undefined }));
    oauth = createOAuthServer({ store, config, fetchImpl: google.fetchImpl, now, random });
    const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    const grantId = new URL(a.headers.location).searchParams.get('state');
    const cb = await oauth.callback({ state: grantId, code: 'google-code' });
    expect(cb.status).toBe(403);
    expect(store.grants.get(grantId).code_hash).toBeUndefined();
    expect(store.people.size).toBe(0);
  });
  it('refuses a lookalike: right hd claim, wrong email domain', () => {
    expect(permittedEmail({ email: 'owen@agnisemi.ai.evil.example', email_verified: true, hd: 'agnisemi.ai' }, 'agnisemi.ai')).toBeNull();
    expect(permittedEmail({ email: 'owen@agnisemi.ai', email_verified: false, hd: 'agnisemi.ai' }, 'agnisemi.ai')).toBeNull();
    expect(permittedEmail({ email: 'Owen@Agnisemi.ai', email_verified: true, hd: 'agnisemi.ai' }, 'agnisemi.ai')).toBe('owen@agnisemi.ai');
  });
  it('refuses an id_token with a wrong signature, wrong audience, or expired', async () => {
    for (const bad of [() => idToken({}, wrongPair.privateKey), () => idToken({ aud: 'other' }), () => idToken({ exp: Math.floor(now() / 1000) - 120 })]) {
      const g = fakeGoogle(bad);
      const o = createOAuthServer({ store, config, fetchImpl: g.fetchImpl, now, random });
      const a = await o.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback', code_challenge: challenge, code_challenge_method: 'S256' });
      const grantId = new URL(a.headers.location).searchParams.get('state');
      const cb = await o.callback({ state: grantId, code: 'google-code' });
      expect(cb.status).toBe(502);
      expect(store.grants.get(grantId).code_hash).toBeUndefined();
    }
  });
  it('rejects a callback with an unknown, reused, or expired state', async () => {
    expect((await oauth.callback({ state: 'nope', code: 'x' })).status).toBe(400);
    const { grantId } = await fullLogin(oauth, store, google, clientId);
    expect((await oauth.callback({ state: grantId, code: 'again' })).status).toBe(400);
    const a = await oauth.authorize({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback', code_challenge: challenge, code_challenge_method: 'S256' });
    const late = new URL(a.headers.location).searchParams.get('state');
    clock += 11 * 60 * 1000;
    expect((await oauth.callback({ state: late, code: 'x' })).status).toBe(400);
  });
});

describe('the token endpoint', () => {
  let store, oauth, clientId, google;
  beforeEach(async () => {
    store = memoryStore();
    google = fakeGoogle(() => idToken());
    oauth = createOAuthServer({ store, config, fetchImpl: google.fetchImpl, now, random });
    clientId = await registerClient(oauth);
  });
  it('exchanges a code with the right PKCE verifier for hashed, expiring tokens', async () => {
    const { code } = await fullLogin(oauth, store, google, clientId);
    const t = await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: 'http://127.0.0.1:33445/callback' });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: SCOPE });
    expect(t.body.access_token).toMatch(/^vlt_/);
    expect(t.headers['cache-control']).toBe('no-store');
    const hash = crypto.createHash('sha256').update(t.body.access_token).digest('hex');
    expect(store.tokens.get(hash)).toMatchObject({ kind: 'access', email: 'owen@agnisemi.ai', client_id: clientId });
    expect([...store.tokens.values()].some((r) => r.token_hash === t.body.access_token)).toBe(false);
  });
  it('refuses a wrong verifier, a second use, another client, and an expired code', async () => {
    const { code } = await fullLogin(oauth, store, google, clientId);
    const bad = await oauth.token({ grant_type: 'authorization_code', code, code_verifier: 'w'.repeat(43), client_id: clientId });
    expect(bad.status).toBe(400); expect(bad.body.error).toBe('invalid_grant');
    const other = await registerClient(oauth, 'https://other.example/cb');
    const wrongClient = await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other });
    expect(wrongClient.body.error).toBe('invalid_grant');
    const ok = await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(ok.status).toBe(200);
    const again = await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(again.body.error_description).toMatch(/already used/);
    const { code: late } = await fullLogin(oauth, store, google, clientId);
    clock += 6 * 60 * 1000;
    expect((await oauth.token({ grant_type: 'authorization_code', code: late, code_verifier: verifier, client_id: clientId })).body.error_description).toMatch(/expired/);
  });
  it('rotates refresh tokens and revokes the chain on replay', async () => {
    const { code } = await fullLogin(oauth, store, google, clientId);
    const first = (await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body;
    const second = await oauth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    // The new access token works, the rotated refresh token is spent.
    expect(await oauth.authenticateBearer(second.body.access_token)).toMatchObject({ email: 'owen@agnisemi.ai' });
    const replay = await oauth.token({ grant_type: 'refresh_token', refresh_token: first.refresh_token });
    expect(replay.status).toBe(400);
    expect(replay.body.error_description).toMatch(/revoked/);
    // ...and the replay revoked what descended from it.
    expect(await oauth.authenticateBearer(second.body.access_token)).toBeNull();
    expect((await oauth.token({ grant_type: 'refresh_token', refresh_token: second.body.refresh_token })).body.error).toBe('invalid_grant');
  });
  it('refuses unknown grant types and missing parameters', async () => {
    expect((await oauth.token({ grant_type: 'password', username: 'x' })).body.error).toBe('unsupported_grant_type');
    expect((await oauth.token({ grant_type: 'authorization_code' })).body.error).toBe('invalid_request');
    expect((await oauth.token(undefined)).status).toBe(400);
  });
});

describe('the bearer check the MCP endpoint performs', () => {
  it('accepts a live access token, and nothing else', async () => {
    const store = memoryStore();
    const google = fakeGoogle(() => idToken());
    const oauth = createOAuthServer({ store, config, fetchImpl: google.fetchImpl, now, random });
    const clientId = await registerClient(oauth);
    const { code } = await fullLogin(oauth, store, google, clientId);
    const t = (await oauth.token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId })).body;
    expect(await oauth.authenticateBearer(t.access_token)).toEqual({ email: 'owen@agnisemi.ai', scope: SCOPE, client_id: clientId });
    expect(await oauth.authenticateBearer(t.refresh_token), 'a refresh token is not a bearer').toBeNull();
    expect(await oauth.authenticateBearer('vlt_nope')).toBeNull();
    expect(await oauth.authenticateBearer('not-ours')).toBeNull();
    clock += 61 * 60 * 1000;
    expect(await oauth.authenticateBearer(t.access_token), 'expired after an hour').toBeNull();
  });
});

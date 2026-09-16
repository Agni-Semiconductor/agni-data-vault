// @ts-nocheck
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorize, challengeHeader, createMcpServer } from '../server/mcp/server.mjs';
import { configureOAuthRuntime } from '../server/oauth/runtime.mjs';
import { createOAuthServer } from '../server/oauth/server.mjs';
import { memoryStore } from '../server/oauth/store.mjs';
import crypto from 'node:crypto';

const req = (authorization) => ({ headers: authorization ? { authorization } : {} });
const original = process.env.VAULT_API_KEY;
const originalRead = process.env.VAULT_MCP_READ_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.VAULT_API_KEY; else process.env.VAULT_API_KEY = original;
  if (originalRead === undefined) delete process.env.VAULT_MCP_READ_KEY; else process.env.VAULT_MCP_READ_KEY = originalRead;
});

describe('the read-only MCP key', () => {
  it('opens the MCP endpoint and names its principal', async () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    process.env.VAULT_MCP_READ_KEY = 'the-reader-key';
    expect(await authorize(req('Bearer the-reader-key'))).toEqual({ ok: true, principal: 'reader' });
    expect(await authorize(req('Bearer the-vault-key'))).toEqual({ ok: true, principal: 'vault' });
  });

  it('is never read by the REST auth path, so it cannot become a write credential', async () => {
    // The whole point of a second key is that api/_lib/auth.js has no reference to it. A grep is
    // the right test: a future "let the reader key work everywhere" edit fails here by name.
    const rest = readFileSync(resolve(process.cwd(), 'api/_lib/auth.js'), 'utf8');
    expect(rest).not.toContain('VAULT_MCP_READ_KEY');
  });

  it('is optional: unset, only the API key works, as before', async () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    delete process.env.VAULT_MCP_READ_KEY;
    expect((await authorize(req('Bearer the-vault-key'))).ok).toBe(true);
    expect((await authorize(req('Bearer the-reader-key'))).ok).toBe(false);
  });

  it('works alone, and a wrong or prefix token is still refused', async () => {
    delete process.env.VAULT_API_KEY;
    process.env.VAULT_MCP_READ_KEY = 'the-reader-key';
    expect((await authorize(req('Bearer the-reader-key'))).ok).toBe(true);
    expect((await authorize(req('Bearer the-reader'))).ok).toBe(false);
    expect((await authorize(req('Bearer the-reader-key-and-more'))).status).toBe(401);
  });

  it('with neither key set the endpoint is a 500, never open', async () => {
    delete process.env.VAULT_API_KEY;
    delete process.env.VAULT_MCP_READ_KEY;
    expect((await authorize(req('Bearer anything'))).status).toBe(500);
  });
});

describe('who may call the MCP endpoint', () => {
  it('accepts the vault API key as a bearer token', async () => {
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    expect((await authorize(req('Bearer correct-horse-battery-staple'))).ok).toBe(true);
  });

  it('refuses a wrong key, a missing header and the wrong scheme', async () => {
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    for (const header of [undefined, '', 'Bearer wrong', 'Basic correct-horse-battery-staple', 'correct-horse-battery-staple']) {
      const result = (await authorize(req(header)));
      expect(result.ok, String(header)).toBe(false);
      expect(result.status, String(header)).toBe(401);
    }
  });

  it('refuses a prefix of the real key', async () => {
    // timingSafeEqual throws on unequal lengths, so the length check has to come first and has to
    // reject rather than fall through.
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    expect((await authorize(req('Bearer correct-horse'))).ok).toBe(false);
    expect((await authorize(req('Bearer correct-horse-battery-staple-and-more'))).ok).toBe(false);
  });

  it('fails closed, and as a server error, when no key is configured', async () => {
    // An unset key must never mean "no authentication required".
    delete process.env.VAULT_API_KEY;
    const result = (await authorize(req('Bearer anything')));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });
});

describe('the server declaration', () => {
  it('advertises tools and nothing else', async () => {
    const server = createMcpServer();
    expect(server).toBeTruthy();
    await server.close();
  });

  it('tells the client the schema is authoritative and free text is not instruction', async () => {
    const source = readFileSync(resolve(process.cwd(), 'server/mcp/server.mjs'), 'utf8');
    expect(source).toContain('Call vault_schema before filtering');
    expect(source).toContain('never instruction');
  });
});

describe('how it is mounted', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/vault-api.mjs'), 'utf8');

  it('intercepts /mcp before handler() sees it', async () => {
    // handler() applies requireAuth and then routes into the REST contract; a JSON-RPC body sent
    // through it would get a REST error envelope back.
    expect(source.indexOf("'/mcp'")).toBeGreaterThan(-1);
    expect(source.indexOf("'/mcp'")).toBeLessThan(source.indexOf('await handler(req, res)'));
  });

  it('is mounted after the JSON body parse, unlike /healthz', async () => {
    // The transport is handed the already-parsed body. Intercepting earlier would leave it to read
    // a stream this server has not consumed yet, and intercepting nowhere would hang on one that
    // has been.
    // The CALL sites, not the import and the function definition that both come earlier.
    expect(source.indexOf('await readJsonBody(req)')).toBeLessThan(source.indexOf('await handleMcpRequest'));
    expect(source.indexOf("'/healthz'")).toBeLessThan(source.indexOf('await readJsonBody(req)'));
  });
});

describe('an OAuth-issued bearer (Tier 2)', () => {
  const config = { origin: 'https://vault.example.test', googleClientId: 'g', googleClientSecret: 's', emailDomain: 'agnisemi.ai' };
  function runtimeWith(rows, configured = true) {
    const store = memoryStore();
    for (const r of rows) store.tokens.set(r.token_hash, r);
    configureOAuthRuntime({ configured, config, server: createOAuthServer({ store, config }) });
    return store;
  }
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const live = (t, patch = {}) => ({ token_hash: hash(t), kind: 'access', email: 'Owen@agnisemi.ai', client_id: 'c', scope: 'vault:read', expires_at: new Date(Date.now() + 60_000).toISOString(), ...patch });
  afterEach(() => configureOAuthRuntime(null));

  it('is accepted and names the person as the principal', async () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    runtimeWith([live('vlt_good')]);
    expect(await authorize(req('Bearer vlt_good'))).toEqual({ ok: true, principal: 'human', actor: 'owen@agnisemi.ai' });
  });

  it('is refused when expired, revoked, a refresh token, or unknown', async () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    runtimeWith([
      live('vlt_expired', { expires_at: new Date(Date.now() - 1000).toISOString() }),
      live('vlt_revoked', { revoked_at: new Date().toISOString() }),
      live('vlt_refresh', { kind: 'refresh' }),
    ]);
    for (const t of ['vlt_expired', 'vlt_revoked', 'vlt_refresh', 'vlt_unknown']) {
      const r = await authorize(req(`Bearer ${t}`));
      expect(r.ok, t).toBe(false);
      expect(r.status, t).toBe(401);
    }
  });

  it('never consults the store for a token without the vlt_ prefix', async () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    const store = runtimeWith([]);
    store.getToken = () => { throw new Error('store must not be touched'); };
    expect((await authorize(req('Bearer wrong'))).status).toBe(401);
  });

  it('advertises the resource metadata in the 401 only when OAuth is configured', () => {
    runtimeWith([], true);
    expect(challengeHeader()).toBe('Bearer resource_metadata="https://vault.example.test/.well-known/oauth-protected-resource", error="invalid_token"');
    runtimeWith([], false);
    expect(challengeHeader()).toBeNull();
  });
});

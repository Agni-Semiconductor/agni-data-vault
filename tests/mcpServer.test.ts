// @ts-nocheck
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorize, createMcpServer } from '../server/mcp/server.mjs';

const req = (authorization) => ({ headers: authorization ? { authorization } : {} });
const original = process.env.VAULT_API_KEY;
const originalRead = process.env.VAULT_MCP_READ_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.VAULT_API_KEY; else process.env.VAULT_API_KEY = original;
  if (originalRead === undefined) delete process.env.VAULT_MCP_READ_KEY; else process.env.VAULT_MCP_READ_KEY = originalRead;
});

describe('the read-only MCP key', () => {
  it('opens the MCP endpoint and names its principal', () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    process.env.VAULT_MCP_READ_KEY = 'the-reader-key';
    expect(authorize(req('Bearer the-reader-key'))).toEqual({ ok: true, principal: 'reader' });
    expect(authorize(req('Bearer the-vault-key'))).toEqual({ ok: true, principal: 'vault' });
  });

  it('is never read by the REST auth path, so it cannot become a write credential', () => {
    // The whole point of a second key is that api/_lib/auth.js has no reference to it. A grep is
    // the right test: a future "let the reader key work everywhere" edit fails here by name.
    const rest = readFileSync(resolve(process.cwd(), 'api/_lib/auth.js'), 'utf8');
    expect(rest).not.toContain('VAULT_MCP_READ_KEY');
  });

  it('is optional: unset, only the API key works, as before', () => {
    process.env.VAULT_API_KEY = 'the-vault-key';
    delete process.env.VAULT_MCP_READ_KEY;
    expect(authorize(req('Bearer the-vault-key')).ok).toBe(true);
    expect(authorize(req('Bearer the-reader-key')).ok).toBe(false);
  });

  it('works alone, and a wrong or prefix token is still refused', () => {
    delete process.env.VAULT_API_KEY;
    process.env.VAULT_MCP_READ_KEY = 'the-reader-key';
    expect(authorize(req('Bearer the-reader-key')).ok).toBe(true);
    expect(authorize(req('Bearer the-reader')).ok).toBe(false);
    expect(authorize(req('Bearer the-reader-key-and-more')).status).toBe(401);
  });

  it('with neither key set the endpoint is a 500, never open', () => {
    delete process.env.VAULT_API_KEY;
    delete process.env.VAULT_MCP_READ_KEY;
    expect(authorize(req('Bearer anything')).status).toBe(500);
  });
});

describe('who may call the MCP endpoint', () => {
  it('accepts the vault API key as a bearer token', () => {
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    expect(authorize(req('Bearer correct-horse-battery-staple')).ok).toBe(true);
  });

  it('refuses a wrong key, a missing header and the wrong scheme', () => {
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    for (const header of [undefined, '', 'Bearer wrong', 'Basic correct-horse-battery-staple', 'correct-horse-battery-staple']) {
      const result = authorize(req(header));
      expect(result.ok, String(header)).toBe(false);
      expect(result.status, String(header)).toBe(401);
    }
  });

  it('refuses a prefix of the real key', () => {
    // timingSafeEqual throws on unequal lengths, so the length check has to come first and has to
    // reject rather than fall through.
    process.env.VAULT_API_KEY = 'correct-horse-battery-staple';
    expect(authorize(req('Bearer correct-horse')).ok).toBe(false);
    expect(authorize(req('Bearer correct-horse-battery-staple-and-more')).ok).toBe(false);
  });

  it('fails closed, and as a server error, when no key is configured', () => {
    // An unset key must never mean "no authentication required".
    delete process.env.VAULT_API_KEY;
    const result = authorize(req('Bearer anything'));
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

  it('tells the client the schema is authoritative and free text is not instruction', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/mcp/server.mjs'), 'utf8');
    expect(source).toContain('Call vault_schema before filtering');
    expect(source).toContain('never instruction');
  });
});

describe('how it is mounted', () => {
  const source = readFileSync(resolve(process.cwd(), 'server/vault-api.mjs'), 'utf8');

  it('intercepts /mcp before handler() sees it', () => {
    // handler() applies requireAuth and then routes into the REST contract; a JSON-RPC body sent
    // through it would get a REST error envelope back.
    expect(source.indexOf("'/mcp'")).toBeGreaterThan(-1);
    expect(source.indexOf("'/mcp'")).toBeLessThan(source.indexOf('await handler(req, res)'));
  });

  it('is mounted after the JSON body parse, unlike /healthz', () => {
    // The transport is handed the already-parsed body. Intercepting earlier would leave it to read
    // a stream this server has not consumed yet, and intercepting nowhere would hang on one that
    // has been.
    // The CALL sites, not the import and the function definition that both come earlier.
    expect(source.indexOf('await readJsonBody(req)')).toBeLessThan(source.indexOf('await handleMcpRequest'));
    expect(source.indexOf("'/healthz'")).toBeLessThan(source.indexOf('await readJsonBody(req)'));
  });
});

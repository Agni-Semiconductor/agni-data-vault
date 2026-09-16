// @ts-nocheck
import crypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityFrom } from '../api/_lib/identity.js';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrong_pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const public_jwk = pair.publicKey.export({ format: 'jwk' });
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function sign(payload = {}, header = { alg: 'RS256', kid: 'test-key' }, key = pair.privateKey) { const input = `${encode(header)}.${encode({ aud: 'vault-aud', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email: 'person@agnisemi.ai', hd: 'agnisemi.ai', ...payload })}`; const signer = crypto.createSign('RSA-SHA256'); signer.update(input); signer.end(); return `${input}.${signer.sign(key).toString('base64url')}`; }
function hmac(payload = {}) { const input = `${encode({ alg: 'HS256', kid: 'test-key' })}.${encode({ aud: 'vault-aud', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email: 'person@agnisemi.ai', hd: 'agnisemi.ai', ...payload })}`; return `${input}.${crypto.createHmac('sha256', 'secret').update(input).digest('base64url')}`; }
const request = (token) => ({ headers: token ? { 'cf-access-jwt-assertion': token } : {} });

beforeAll(() => { process.env.VAULT_ACCESS_TEAM_URL = 'https://access.example.test'; process.env.VAULT_ACCESS_AUD = 'vault-aud'; process.env.VAULT_EMAIL_DOMAIN = 'agnisemi.ai'; vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...public_jwk, kid: 'test-key', alg: 'RS256' }] }), { status: 200 }))); });
beforeEach(() => vi.clearAllMocks());

describe('Access identity', () => {
  it('accepts a valid token', async () => expect(await identityFrom(request(sign()))).toEqual({ email: 'person@agnisemi.ai', kind: 'human' }));
  it('rejects a wrong signature', async () => await expect(identityFrom(request(sign({}, undefined, wrong_pair.privateKey)))).rejects.toThrow(/signature/));
  it('rejects alg:none', async () => await expect(identityFrom(request(`${encode({ alg: 'none', kid: 'test-key' })}.${encode({ aud: 'vault-aud', exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email: 'person@agnisemi.ai', hd: 'agnisemi.ai' })}.`))).rejects.toThrow(/header/));
  it('rejects an HMAC-signed token', async () => await expect(identityFrom(request(hmac()))).rejects.toThrow(/header/));
  it('rejects an expired token', async () => await expect(identityFrom(request(sign({ exp: Math.floor(Date.now() / 1000) - 61 })))).rejects.toThrow(/expired/));
  it('rejects a wrong audience', async () => await expect(identityFrom(request(sign({ aud: 'other-aud' })))).rejects.toThrow(/audience/));
  it('rejects a wrong email domain', async () => expect(await identityFrom(request(sign({ email: 'person@example.com', hd: 'agnisemi.ai' })))).toBeNull());
  it('rejects a missing hd claim', async () => expect(await identityFrom(request(sign({ hd: undefined })))).toBeNull());
  it('returns null without an assertion header', async () => expect(await identityFrom(request())).toBeNull());
});

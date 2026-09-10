// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStoragePath, deleteObject, getObject, headObject, kindFromExtension, parseFilename, putObject } from '../api/_lib/storage.js';

beforeEach(() => { process.env.VAULT_STORAGE_URL = 'https://storage.example.test/'; process.env.VAULT_SERVICE_JWT = 'service-jwt'; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env.VAULT_STORAGE_URL; delete process.env.VAULT_SERVICE_JWT; });
const response = (body = '{}', status = 200, headers = {}) => new Response(body, { status, headers });

describe('storage API client', () => {
  it('preserves path separators and percent-encodes each segment', async () => { const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch); await putObject('samples/sample id/1234/a #1.csv', Buffer.from('x'), 'text/csv'); expect(fetch).toHaveBeenCalledWith('https://storage.example.test/storage/v1/object/vault/samples/sample%20id/1234/a%20%231.csv', expect.any(Object)); });
  it('sends the bearer token on every object-store call', async () => { const fetch = vi.fn(async (_url, options) => options.method === 'GET' ? response('bytes', 200, { 'content-type': 'text/plain', 'content-length': '5' }) : response()); vi.stubGlobal('fetch', fetch); await putObject('a', Buffer.from('a'), 'text/plain'); await getObject('b'); await headObject('c'); await deleteObject('d'); expect(fetch).toHaveBeenCalledTimes(4); for (const [, options] of fetch.mock.calls) expect(options.headers).toMatchObject({ Authorization: 'Bearer service-jwt' }); });
  it('puts objects without upserting', async () => { const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch); await putObject('a.csv', Buffer.from('a'), 'text/csv'); expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer service-jwt', 'content-type': 'text/csv', 'x-upsert': 'false' } }); });
  it.each([[404, false], [200, true]])('headObject maps HTTP %i to %s', async (status, expected) => { vi.stubGlobal('fetch', vi.fn(async () => response('', status))); await expect(headObject('a.csv')).resolves.toBe(expected); });
  it('headObject throws on a server error', async () => { vi.stubGlobal('fetch', vi.fn(async () => response('broken', 500))); await expect(headObject('a.csv')).rejects.toMatchObject({ status: 500 }); });
  it('attaches the response status to non-2xx errors', async () => { vi.stubGlobal('fetch', vi.fn(async () => response('opaque conflict', 409))); await expect(putObject('a.csv', Buffer.from('a'), 'text/csv')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('opaque conflict') }); });
  it('refuses client-side deletes outside the vault bucket', async () => { const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await expect(deleteObject('a.csv', 'bench')).rejects.toThrow(/forbidden/i); expect(fetch).not.toHaveBeenCalled(); });
});

describe('storage path helpers', () => {
  it('builds the established sanitized storage path', () => expect(buildStoragePath('S 1', 'mid', 'bad<>.csv')).toBe('samples/S 1/mid/bad__.csv'));
  it('parses run, date, and dciv kind from established filenames', () => expect(parseFilename('Dhiren Site@1 capacitor DC-IV#1 Run4482 04-21-2026.xlsx')).toEqual({ run_number: 4482, file_date: '2026-04-21', detected_kind: 'dciv' }));
  it('preserves nulls when filename metadata is absent', () => expect(parseFilename('plain.csv')).toEqual({ run_number: null, file_date: null, detected_kind: null }));
});

// Moved here from tests/api-client.test.ts when parseFilenameClient and kindFromName were
// deleted. Those browser twins had DRIFTED from these server copies (Unicode vs ASCII
// filename cleaning, and the server additionally matches bare dc / ac / c-v), which
// is why the duplication was removed rather than kept in sync. The coverage moves with them.
describe('filename detection (formerly duplicated in the browser client)', () => {
  it('detects PUND', () => expect(parseFilename('20-PUND-3.xlsx').detected_kind).toBe('pund'));
  it('detects ACIV from hysteresis', () => expect(parseFilename('hysteresis Run2.xlsx').detected_kind).toBe('aciv'));
  it('detects CV', () => expect(parseFilename('device CV.csv').detected_kind).toBe('cv'));
  it('classifies xlsx case-insensitively', () => expect(kindFromExtension('raw.XLSX')).toBe('raw_xls'));
  it('classifies csv', () => expect(kindFromExtension('raw.csv')).toBe('raw_csv'));
  it('classifies plots', () => expect(kindFromExtension('plot.png')).toBe('plot_png'));
  it('classifies everything else as other', () => expect(kindFromExtension('readme.pdf')).toBe('other'));
});

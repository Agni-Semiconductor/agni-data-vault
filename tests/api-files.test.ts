// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { measurements: [], files: [], objects: [], calls: [], putError: null };
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => ({
  from(table) {
    const q = { table, filters: [], action: 'select', payload: null, select() { return this; }, eq(k, v) { this.filters.push([k, v]); return this; }, maybeSingle() { return this.run(true); }, single() { return this.run(true); }, insert(v) { this.action = 'insert'; this.payload = v; return this; }, update(v) { this.action = 'update'; this.payload = v; return this; }, delete() { this.action = 'delete'; return this; }, async run(single) {
      const rows = state[table]; const hit = () => rows.filter((x) => this.filters.every(([k, v]) => x[k] === v));
      if (this.action === 'select') { let data = hit(); if (table === 'measurements' && data[0]) data = [{ ...data[0], samples: { sample_id: 'S-1' } }]; return { data: single ? data[0] || null : data, error: null }; }
      if (this.action === 'insert') { const row = { id: `file-${state.files.length + 1}`, ...this.payload }; rows.push(row); return { data: row, error: null }; }
      if (this.action === 'update') { const row = hit()[0]; Object.assign(row, this.payload); return { data: row, error: null }; }
      const row = hit()[0]; state.files.splice(state.files.indexOf(row), 1); return { data: row, error: null };
    }, then(ok, bad) { return this.run(false).then(ok, bad); } }; return q;
  }
}) }));
vi.mock('../api/_lib/storage.js', () => ({
  buildStoragePath: (s, m, f) => `samples/${s}/${m}/${f}`,
  putObject: vi.fn(async (path, body, contentType, bucket) => { state.calls.push(['put', path, body, contentType, bucket]); if (state.putError) throw state.putError; }),
  getObject: vi.fn(async (path, bucket) => { state.calls.push(['get', path, bucket]); return { body: 'bytes', contentType: 'text/csv', size: 5 }; }),
  headObject: vi.fn(async (path, bucket) => { state.calls.push(['head', path, bucket]); return state.objects.includes(`${bucket}:${path}`); }),
  deleteObject: vi.fn(async (path, bucket) => { state.calls.push(['delete', path, bucket]); }),
  parseFilename: vi.fn(() => ({ run_number: 7, file_date: '2026-01-02', detected_kind: 'dciv' })),
  kindFromExtension: vi.fn(() => 'raw_xls')
}));
const ids = { measurement: '11111111-1111-4111-8111-111111111111', file: '22222222-2222-4222-8222-222222222222' };
const hash = 'a'.repeat(64);
const api = await import('../api/_lib/resources/files.js');
beforeEach(() => { state.measurements = [{ id: ids.measurement, sample_id: 'sample-db' }]; state.files = []; state.objects = []; state.calls = []; state.putError = null; vi.clearAllMocks(); });
const err = async (fn) => { try { await fn(); } catch (e) { return e; } };
describe('files API resource', () => {
  it('validates sha256 format', async () => { const e = await err(() => api.uploadUrl({ measurement_id: ids.measurement, filename: 'x.csv', size_bytes: 1, sha256: 'bad' })); expect(e.status).toBe(422); expect(e.code).toBe('validation_failed'); });
  it('returns 404 for unknown measurement', async () => { const e = await err(() => api.uploadUrl({ measurement_id: '33333333-3333-4333-8333-333333333333', filename: 'x.csv', size_bytes: 1, sha256: hash })); expect(e.status).toBe(404); });
  it('reports duplicate file details', async () => { state.files.push({ id: ids.file, measurement_id: ids.measurement, sha256: hash, original_name: 'old.csv' }); const e = await err(() => api.uploadUrl({ measurement_id: ids.measurement, filename: 'x.csv', size_bytes: 1, sha256: hash })); expect(e.status).toBe(409); expect(e.code).toBe('duplicate_file'); expect(e.details).toEqual({ file_id: ids.file, original_name: 'old.csv' }); });
  it('maps a storage 409 to duplicate_file without inspecting its message', async () => { state.files.push({ id: ids.file, measurement_id: ids.measurement, sha256: hash, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'vault', upload_state: 'pending' }); state.putError = Object.assign(new Error('opaque object-store failure'), { status: 409 }); const e = await err(() => api.putContent(ids.file, { headers: { 'content-type': 'text/csv' }, rawStream: 'bytes' })); expect(e).toMatchObject({ status: 409, code: 'duplicate_file' }); });
  it('suffixes a colliding vault path', async () => { state.files.push({ id: ids.file, bucket: 'vault', storage_path: `samples/S-1/${ids.measurement}/x.csv` }); const r = await api.uploadUrl({ measurement_id: ids.measurement, filename: 'x.csv', size_bytes: 1, sha256: hash }); expect(r.body.storage_path).toContain('x-2.csv'); });
  it('returns a relative upload URL without signed-url fields', async () => { const r = await api.uploadUrl({ measurement_id: ids.measurement, filename: 'x.csv', size_bytes: 1, sha256: hash }); expect(r.status).toBe(201); expect(r.body).toMatchObject({ file_id: 'file-1', upload_url: '/api/files/file-1/content', method: 'PUT' }); expect(r.body).not.toHaveProperty('signed_url'); expect(r.body).not.toHaveProperty('token'); });
  it('returns unknown-key warnings and rejects malformed registration values', async () => { const upload = await api.uploadUrl({ measurement_id: ids.measurement, filename: 'x.csv', size_bytes: 1, sha256: hash, extra: true }); expect(upload.body.warnings).toEqual(['unknown key "extra" ignored']); state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'vault', upload_state: 'pending' }); const e = await err(() => api.register(ids.file, { size_bytes: '1', parsed: [] })); expect(e.status).toBe(422); expect(e.code).toBe('validation_failed'); });
  it('registers an uploaded object using headObject', async () => { const path = 'samples/S/m/x.csv'; state.files.push({ id: ids.file, storage_path: path, original_name: 'x.csv', bucket: 'vault', upload_state: 'pending' }); state.objects.push(`vault:${path}`); const r = await api.register(ids.file, { parsed: { n_rows: 9, run_number: 99 } }); expect(r.body.file.upload_state).toBe('ready'); expect(r.body.file.parsed).toMatchObject({ n_rows: 9, run_number: 99, detected_kind: 'dciv' }); expect(state.calls).toContainEqual(['head', path, 'vault']); });
  it('register is idempotent once the file is ready', async () => { const file = { id: ids.file, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'vault', upload_state: 'ready' }; state.files.push(file); const r = await api.register(ids.file, {}); expect(r.body.file).toBe(file); expect(r.body.warnings).toContain('already registered'); expect(state.calls).toEqual([]); });
  it('fails registration when object is absent', async () => { state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'vault', upload_state: 'pending' }); const e = await err(() => api.register(ids.file, {})); expect(e.code).toBe('upload_missing'); expect(state.files[0].upload_state).toBe('failed'); });
  it('streams content from the row bucket', async () => { state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'bench', upload_state: 'ready', size_bytes: 5 }); const r = await api.getContent(ids.file); expect(r).toMatchObject({ stream: 'bytes', contentType: 'text/csv', filename: 'x.csv', size: 5 }); expect(state.calls).toContainEqual(['get', 'samples/S/m/x.csv', 'bench']); });
  it('returns the relative content URL for download', async () => { state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', original_name: 'x.csv', bucket: 'vault', upload_state: 'ready' }); const r = await api.download(ids.file); expect(r.body).toEqual({ url: `/api/files/${ids.file}/content`, expires_at: null }); });
  it('does not download a pending file', async () => { state.files.push({ id: ids.file, upload_state: 'pending' }); const e = await err(() => api.download(ids.file)); expect(e.code).toBe('not_ready'); });
  it('refuses to delete a bench object or row', async () => { state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', bucket: 'bench', upload_state: 'ready' }); const e = await err(() => api.remove(ids.file)); expect(e).toMatchObject({ status: 403 }); expect(state.files).toHaveLength(1); expect(state.calls).toEqual([]); });
  it('deletes a vault object and row', async () => { state.files.push({ id: ids.file, storage_path: 'samples/S/m/x.csv', bucket: 'vault', upload_state: 'ready' }); const r = await api.remove(ids.file); expect(r.body.deleted).toBe(true); expect(state.files).toHaveLength(0); expect(state.calls).toContainEqual(['delete', 'samples/S/m/x.csv', 'vault']); });
});

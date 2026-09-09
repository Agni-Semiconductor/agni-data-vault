// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as samples from '../api/_lib/resources/samples.js';
import * as measurements from '../api/_lib/resources/measurements.js';
import * as stats from '../api/_lib/resources/stats.js';

const state = vi.hoisted(() => ({ sb: null, defs: {}, removeObject: null, validate: null }));

vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));
vi.mock('../api/_lib/storage.js', () => ({ BUCKET: 'vault', removeObject: (...a) => state.removeObject(...a) }));
vi.mock('../api/_lib/fieldDefs.js', () => ({
  validateEntity: (...a) => state.validate(...a),
  loadDefs: async (entity) => state.defs[entity] || [],
  loadLists: async () => new Map(),
  bustCache: () => {},
}));

const UUID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const OK = { data: [], error: null, count: 0 };

function fakeSb(results) {
  const queue = results.slice();
  const sb = { calls: [], storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) } };
  sb.from = (table) => {
    const result = queue.length ? queue.shift() : OK;
    const ops = [];
    sb.calls.push({ table, ops });
    const q = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'contains', 'order', 'range', 'limit', 'single', 'maybeSingle']) q[m] = (...a) => { ops.push([m, ...a]); return q; };
    q.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return q;
  };
  return sb;
}

function expectOp(call, name, ...args) {
  const found = call.ops.find((o) => o[0] === name && (args.length === 0 || args.every((a, i) => JSON.stringify(o[i + 1]) === JSON.stringify(a))));
  expect(found, `expected op ${name} ${JSON.stringify(args)} in ${JSON.stringify(call.ops)}`).toBeDefined();
  return found;
}

beforeEach(() => {
  state.sb = fakeSb([]);
  state.defs = {};
  state.removeObject = vi.fn(async () => {});
  state.validate = vi.fn(async () => ({ columns: {}, meta: {}, meta_status: {}, warnings: [] }));
});

describe('samples resource', () => {
  it('list builds count query with filters, default sort and pagination, returns {items,total}', async () => {
    const rows = [{ id: 's1' }];
    state.sb = fakeSb([{ data: rows, error: null, count: 7 }]);
    const r = await samples.list({ q: 'hf', family: 'HfN_20', owner: 'dhiren', limit: '10', offset: '5' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: rows, total: 7 });
    const c = state.sb.calls[0];
    expect(c.table).toBe('samples');
    expectOp(c, 'select', '*', { count: 'exact' });
    expectOp(c, 'eq', 'family', 'HfN_20');
    expectOp(c, 'eq', 'owner', 'dhiren');
    expectOp(c, 'or', 'sample_id.ilike.*hf*,label.ilike.*hf*');
    expectOp(c, 'order', 'updated_at', { ascending: false, nullsFirst: false });
    expectOp(c, 'range', 5, 14);
  });

  it('list applies meta.<key> filters through the field defs', async () => {
    state.defs.sample = [{ key: 'sweep_v', type: 'number', column_name: null, active: true }];
    state.sb = fakeSb([OK]);
    await samples.list({ 'meta.sweep_v': '18' });
    expectOp(state.sb.calls[0], 'contains', 'meta', { sweep_v: 18 });
  });

  it('create requires sample_id with 422 before touching the db', async () => {
    await expect(samples.create({ label: 'x' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', details: [{ key: 'sample_id', message: 'required' }] });
    expect(state.sb.calls.length).toBe(0);
  });

  it('create inserts validated split with created_by default and returns 201 {sample, warnings}', async () => {
    state.validate = vi.fn(async () => ({ columns: { sample_id: 'HfN_20_0421', label: 'L' }, meta: { custom: 1 }, meta_status: { custom: 'assumed' }, warnings: ['unknown key "wat" ignored'] }));
    state.sb = fakeSb([{ data: { id: 'u1', sample_id: 'HfN_20_0421' }, error: null }]);
    const r = await samples.create({ sample_id: 'HfN_20_0421', label: 'L', wat: 1 });
    expect(r.status).toBe(201);
    expect(r.body.sample).toEqual({ id: 'u1', sample_id: 'HfN_20_0421' });
    expect(r.body.warnings).toEqual(['unknown key "wat" ignored']);
    const ins = expectOp(state.sb.calls[0], 'insert');
    expect(ins[1]).toEqual({ sample_id: 'HfN_20_0421', label: 'L', meta: { custom: 1 }, meta_status: { custom: 'assumed' }, created_by: 'api' });
  });

  it('create maps unique violation on sample_id to 409 conflict', async () => {
    state.validate = vi.fn(async () => ({ columns: { sample_id: 'HfN_20_0421' }, meta: {}, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: null, error: { code: '23505', message: 'duplicate key' } }]);
    await expect(samples.create({ sample_id: 'HfN_20_0421' })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'sample_id already exists' });
  });

  it('get by human sample_id filters on sample_id', async () => {
    state.sb = fakeSb([{ data: { id: 's1', sample_id: 'HfN_20_0421' }, error: null }]);
    const r = await samples.get('HfN_20_0421', {});
    expect(r.status).toBe(200);
    expect(r.body.sample.id).toBe('s1');
    expect(state.sb.calls.length).toBe(1);
    expectOp(state.sb.calls[0], 'eq', 'sample_id', 'HfN_20_0421');
  });

  it('get by uuid filters on id and include=measurements adds ordered measurements', async () => {
    state.sb = fakeSb([{ data: { id: 's1', sample_id: 'HfN_20_0421' }, error: null }, { data: [{ id: 'm1' }], error: null }]);
    const r = await samples.get(UUID, { include: 'measurements' });
    expectOp(state.sb.calls[0], 'eq', 'id', UUID);
    expect(state.sb.calls[1].table).toBe('measurements');
    expectOp(state.sb.calls[1], 'eq', 'sample_id', 's1');
    expectOp(state.sb.calls[1], 'order', 'measured_on', { ascending: false, nullsFirst: false });
    expectOp(state.sb.calls[1], 'limit', 500);
    expect(r.body.sample.measurements).toEqual([{ id: 'm1' }]);
  });

  it('get missing sample is 404 not_found', async () => {
    state.sb = fakeSb([{ data: null, error: { code: 'PGRST116', message: 'No rows' } }]);
    await expect(samples.get('nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('update merges meta and meta_status into existing jsonb and drops null keys', async () => {
    state.validate = vi.fn(async () => ({ columns: {}, meta: { sweep_v: 5, obsolete: null }, meta_status: { stack: 'confirmed' }, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 'u1', meta: { obsolete: 'old', keep: 1 }, meta_status: { stack: 'assumed' }, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }, { data: { id: 'u1' }, error: null }]);
    const r = await samples.update('HfN_20_0421', { meta: { sweep_v: 5, obsolete: null }, meta_status: { stack: 'confirmed' }, expected_updated_at: '2026-01-01T00:00:00.000Z' });
    expect(r.status).toBe(200);
    const upd = expectOp(state.sb.calls[1], 'update');
    expect(upd[1]).toEqual({ meta: { keep: 1, sweep_v: 5 }, meta_status: { stack: 'confirmed' } });
    expectOp(state.sb.calls[1], 'eq', 'id', 'u1');
    expectOp(state.sb.calls[1], 'eq', 'updated_at', '2026-01-01T00:00:00.000Z');
  });

  it('update with stale expected_updated_at is 409 conflict', async () => {
    state.validate = vi.fn(async () => ({ columns: { __expected_updated_at: '2020-01-01T00:00:00.000Z' }, meta: {}, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 'u1', meta: {}, meta_status: {}, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }]);
    await expect(samples.update('HfN_20_0421', { expected_updated_at: '2020-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'modified since expected_updated_at; re-read and retry' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('update with matching expected_updated_at and empty patch is 400 empty_patch', async () => {
    state.validate = vi.fn(async () => ({ columns: { __expected_updated_at: '2026-01-01T00:00:00.000Z' }, meta: {}, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 'u1', meta: {}, meta_status: {}, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }]);
    await expect(samples.update(UUID, { expected_updated_at: '2026-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 400, code: 'empty_patch' });
  });

  it('remove deletes by id and removes storage objects of all sample files', async () => {
    state.sb = fakeSb([{ data: { id: 's1', sample_id: 'HfN_20_0421' }, error: null }, { data: [{ id: 'm1' }, { id: 'm2' }], error: null }, { data: [{ storage_path: 'p1' }, { storage_path: 'p2' }], error: null }, OK]);
    const r = await samples.remove('HfN_20_0421');
    expect(r).toEqual({ status: 200, body: { deleted: true, id: 's1' } });
    expect(state.removeObject).toHaveBeenCalledTimes(2);
    expect(state.removeObject).toHaveBeenNthCalledWith(1, 'p1');
    expect(state.removeObject).toHaveBeenNthCalledWith(2, 'p2');
    const del = state.sb.calls[3];
    expect(del.table).toBe('samples');
    expectOp(del, 'delete');
    expectOp(del, 'eq', 'id', 's1');
  });

  it('remove collects warnings when storage removal fails', async () => {
    state.removeObject = vi.fn(async () => { throw new Error('boom'); });
    state.sb = fakeSb([{ data: { id: 's1' }, error: null }, { data: [{ id: 'm1' }], error: null }, { data: [{ storage_path: 'p1' }], error: null }, OK]);
    const r = await samples.remove(UUID);
    expect(r.body.deleted).toBe(true);
    expect(r.body.warnings).toEqual(['failed to remove storage object "p1"']);
  });
});

describe('measurements resource', () => {
  it('listForSample resolves the sample then applies filters and default double sort', async () => {
    state.sb = fakeSb([{ data: { id: 's1' }, error: null }, { data: [], error: null, count: 0 }]);
    const r = await measurements.listForSample('HfN_20_0421', { kind: 'dciv', from: '2026-01-01', to: '2026-12-31' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], total: 0 });
    expectOp(state.sb.calls[0], 'eq', 'sample_id', 'HfN_20_0421');
    expectOp(state.sb.calls[0], 'maybeSingle');
    const c = state.sb.calls[1];
    expect(c.table).toBe('measurements');
    expectOp(c, 'select', '*', { count: 'exact' });
    expectOp(c, 'eq', 'sample_id', 's1');
    expectOp(c, 'eq', 'kind', 'dciv');
    expectOp(c, 'gte', 'measured_on', '2026-01-01');
    expectOp(c, 'lte', 'measured_on', '2026-12-31');
    expectOp(c, 'order', 'measured_on', { ascending: false, nullsFirst: false });
    expectOp(c, 'order', 'created_at', { ascending: false });
    expectOp(c, 'range', 0, 49);
  });

  it('listForSample is 404 not_found when the sample does not exist', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(measurements.listForSample('HfN_20_0421', {})).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'No sample with that id' });
  });

  it('createForSample normalises run_numbers from a JSON string and keeps generated pad_area_um2', async () => {
    state.validate = vi.fn(async () => ({ columns: { run_numbers: '[4482]', measured_on: '2026-04-21', kind: 'dciv' }, meta: { sweep_v: 18 }, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 's1' }, error: null }, { data: { id: 'm1', pad_area_um2: 490.87 }, error: null }]);
    const r = await measurements.createForSample('HfN_20_0421', { measured_on: '2026-04-21', run_numbers: '[4482]' });
    expect(r.status).toBe(201);
    expect(r.body.measurement.pad_area_um2).toBe(490.87);
    const ins = expectOp(state.sb.calls[1], 'insert');
    expect(ins[1]).toMatchObject({ sample_id: 's1', measured_on: '2026-04-21', run_numbers: [4482], meta: { sweep_v: 18 }, created_by: 'api' });
  });

  it('createForSample rejects non-integer run_numbers with 422', async () => {
    state.validate = vi.fn(async () => ({ columns: { run_numbers: [1.5], measured_on: '2026-04-21' }, meta: {}, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 's1' }, error: null }]);
    await expect(measurements.createForSample('HfN_20_0421', { measured_on: '2026-04-21', run_numbers: [1.5] })).rejects.toMatchObject({ status: 422, details: [{ key: 'run_numbers', message: 'must be an array of integers' }] });
  });

  it('createForSample requires measured_on and rejects bad pad_shape', async () => {
    state.sb = fakeSb([{ data: { id: 's1' }, error: null }]);
    await expect(measurements.createForSample('HfN_20_0421', {})).rejects.toMatchObject({ status: 422, details: [{ key: 'measured_on', message: 'required' }] });
    await expect(measurements.createForSample('HfN_20_0421', { measured_on: '2026-04-21', pad_shape: 'triangle' })).rejects.toMatchObject({ status: 422, details: [{ key: 'pad_shape', message: 'must be circle or square' }] });
    expect(state.validate).not.toHaveBeenCalled();
  });

  it('get includes files ordered created_at asc with include=files', async () => {
    state.sb = fakeSb([{ data: { id: 'm1' }, error: null }, { data: [{ id: 'f1' }], error: null }]);
    const r = await measurements.get(UUID, { include: 'files' });
    expectOp(state.sb.calls[1], 'eq', 'measurement_id', 'm1');
    expectOp(state.sb.calls[1], 'order', 'created_at', { ascending: true });
    expect(r.body.measurement.files).toEqual([{ id: 'f1' }]);
  });

  it('update mirrors sample merge semantics and expected_updated_at conflict', async () => {
    state.validate = vi.fn(async () => ({ columns: { temperature_c: 25 }, meta: { sweep_v: 18, drop: null }, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([{ data: { id: 'm1', meta: { drop: 'x' }, meta_status: {}, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }]);
    await expect(measurements.update(UUID, { expected_updated_at: '1999-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    state.sb = fakeSb([{ data: { id: 'm1', meta: { drop: 'x' }, meta_status: {}, updated_at: '2026-01-01T00:00:00.000Z' }, error: null }, { data: { id: 'm1' }, error: null }]);
    const r = await measurements.update(UUID, { temperature_c: 25, meta: { sweep_v: 18, drop: null }, expected_updated_at: '2026-01-01T00:00:00.000Z' });
    expect(r.status).toBe(200);
    const upd = expectOp(state.sb.calls[1], 'update');
    expect(upd[1]).toEqual({ temperature_c: 25, meta: { sweep_v: 18 } });
    expectOp(state.sb.calls[1], 'eq', 'updated_at', '2026-01-01T00:00:00.000Z');
  });

  it('remove cleans the measurement files storage and returns {deleted:true,id}', async () => {
    state.sb = fakeSb([{ data: { id: 'm1' }, error: null }, { data: [{ storage_path: 'a/b.xlsx' }], error: null }, OK]);
    const r = await measurements.remove(UUID);
    expect(r).toEqual({ status: 200, body: { deleted: true, id: 'm1' } });
    expect(state.removeObject).toHaveBeenCalledWith('a/b.xlsx');
    expectOp(state.sb.calls[2], 'delete');
    expectOp(state.sb.calls[2], 'eq', 'id', 'm1');
  });

  it('listFiles returns {items,total} for an existing measurement', async () => {
    state.sb = fakeSb([{ data: { id: 'm1' }, error: null }, { data: [{ id: 'f1' }], error: null, count: 1 }]);
    const r = await measurements.listFiles(UUID, {});
    expect(r).toEqual({ status: 200, body: { items: [{ id: 'f1' }], total: 1 } });
    expectOp(state.sb.calls[1], 'eq', 'measurement_id', 'm1');
  });
});

describe('stats resource', () => {
  it('counts via head queries, reduces bytes and by_kind, maps recent rows', async () => {
    state.sb = fakeSb([
      { data: null, error: null, count: 2 },
      { data: null, error: null, count: 3 },
      { data: null, error: null, count: 2 },
      { data: [{ size_bytes: 100 }, { size_bytes: 23 }], error: null },
      { data: [{ kind: 'dciv' }, { kind: 'dciv' }, { kind: 'aciv' }], error: null },
      { data: [{ id: 'm9', sample_id: 's1', measured_on: '2026-04-21', kind: 'dciv', samples: { sample_id: 'HfN_20_0421' } }], error: null },
    ]);
    const r = await stats.get({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      samples: 2,
      measurements: 3,
      files: 2,
      bytes: 123,
      by_kind: { dciv: 2, aciv: 1 },
      recent: [{ measurement_id: 'm9', sample_id: 'HfN_20_0421', sample_uuid: 's1', measured_on: '2026-04-21', kind: 'dciv' }],
    });
    expectOp(state.sb.calls[0], 'select', 'id', { count: 'exact', head: true });
    expect(state.sb.calls.map((c) => c.table)).toEqual(['samples', 'measurements', 'files', 'files', 'measurements', 'measurements']);
    expectOp(state.sb.calls[5], 'order', 'created_at', { ascending: false });
    expectOp(state.sb.calls[5], 'select', 'id, sample_id, measured_on, kind, samples!inner(sample_id)');
    expectOp(state.sb.calls[5], 'limit', 10);
  });
});

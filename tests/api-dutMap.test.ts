// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from '../api/_lib/router.js';

const state = vi.hoisted(() => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));

const DUT_ID = '2kb-dut-01';
const PRINCIPAL = { kind: 'machine', actor: 'api' };
const MAPPING = { dut_id: DUT_ID, sample_id: 'HfN_20_0421', note: 'fab traveler T-42' };
const OK = { data: [], error: null, count: 0 };

function fakeSb(results) {
  const queue = results.slice(), calls = [];
  return {
    calls,
    from: (table) => {
      const result = queue.length ? queue.shift() : OK, ops = [], q = {};
      calls.push({ table, ops });
      for (const method of ['select', 'insert', 'update', 'eq', 'order', 'single', 'maybeSingle']) q[method] = (...args) => { ops.push([method, ...args]); return q; };
      q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
      return q;
    },
  };
}

beforeEach(() => { state.sb = fakeSb([]); });

describe('DUT map routes', () => {
  it('lists all mappings', async () => {
    state.sb = fakeSb([{ data: [MAPPING], error: null, count: 1 }]);
    await expect(route({ method: 'GET' }, ['bench', 'dut-map'], PRINCIPAL)).resolves.toEqual({ status: 200, body: { items: [MAPPING], total: 1 } });
    expect(state.sb.calls[0].ops).toContainEqual(['order', 'dut_id', { ascending: true }]);
  });

  it('gets one mapping', async () => {
    state.sb = fakeSb([{ data: MAPPING, error: null }]);
    await expect(route({ method: 'GET' }, ['bench', 'dut-map', DUT_ID], PRINCIPAL)).resolves.toEqual({ status: 200, body: { mapping: MAPPING } });
  });

  it('returns 404 for an unknown DUT', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(route({ method: 'GET' }, ['bench', 'dut-map', DUT_ID], PRINCIPAL)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('creates a mapping with its provenance note', async () => {
    state.sb = fakeSb([{ data: null, error: null }, { data: MAPPING, error: null }]);
    await expect(route({ method: 'PUT', body: { sample_id: MAPPING.sample_id, note: MAPPING.note } }, ['bench', 'dut-map', DUT_ID], PRINCIPAL)).resolves.toEqual({ status: 201, body: { mapping: MAPPING } });
    expect(state.sb.calls[1].ops).toContainEqual(['insert', MAPPING]);
  });

  it('refuses a remap without allow_remap', async () => {
    state.sb = fakeSb([{ data: MAPPING, error: null }]);
    await expect(route({ method: 'PUT', body: { sample_id: 'HfN_20_0999', note: MAPPING.note } }, ['bench', 'dut-map', DUT_ID], PRINCIPAL)).rejects.toMatchObject({ status: 409, code: 'remap_refused', message: expect.stringContaining('allow_remap: true') });
    expect(state.sb.calls).toHaveLength(1);
  });

  it('refuses a create without provenance', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(route({ method: 'PUT', body: { sample_id: MAPPING.sample_id } }, ['bench', 'dut-map', DUT_ID], PRINCIPAL)).rejects.toMatchObject({ status: 422, details: [{ key: 'note' }] });
    expect(state.sb.calls).toHaveLength(1);
  });
});

// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as review from '../api/_lib/resources/review.js';

const state = vi.hoisted(() => ({ sb: null, validate: null }));

vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));
vi.mock('../api/_lib/fieldDefs.js', () => ({ validateEntity: (...args) => state.validate(...args) }));

const ID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const ENTITY_ID = '7a3c8d1e-2b4f-4c6d-8e9f-1a2b3c4d5e6f';
const ACTOR = 'reviewer@agnisemi.ai';
const principal = { kind: 'human', actor: ACTOR };
const item = { id: ID, entity: 'measurement', entity_id: ENTITY_ID, field: 'temperature_c', candidate_value: 25, status: 'open' };
const row = { id: ENTITY_ID, temperature_c: null, meta: { keep: true, review_needed: true, evidence: { kind: { class: 'E2', source: 'dciv in filename' } } }, meta_status: { kind: 'confirmed' } };
const resolved = { ...item, status: 'accepted', resolved_by: ACTOR };

function fakeSb(results) {
  const queue = results.slice();
  const sb = { calls: [] };
  sb.from = (table) => {
    const result = queue.shift() ?? { data: [], error: null, count: 0 };
    const ops = [];
    sb.calls.push({ table, ops });
    const q = {};
    for (const method of ['select', 'update', 'eq', 'order', 'range', 'single', 'maybeSingle']) q[method] = (...args) => { ops.push([method, ...args]); return q; };
    q.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected);
    return q;
  };
  return sb;
}

function op(call, method) { return call.ops.find(([name]) => name === method); }

beforeEach(() => {
  state.sb = fakeSb([]);
  state.validate = vi.fn(async () => ({ columns: { temperature_c: 25 }, meta: {}, meta_status: {}, warnings: [] }));
});

describe('review resource', () => {
  it('lists filtered queue items with pagination and total', async () => {
    state.sb = fakeSb([{ data: [item], error: null, count: 4 }]);
    const result = await review.list({ status: 'open', entity: 'measurement', limit: '10', offset: '2' });
    expect(result).toEqual({ status: 200, body: { items: [item], total: 4 } });
    expect(state.sb.calls[0].ops).toContainEqual(['eq', 'status', 'open']);
    expect(state.sb.calls[0].ops).toContainEqual(['eq', 'entity', 'measurement']);
    expect(state.sb.calls[0].ops).toContainEqual(['range', 2, 11]);
  });

  it('accept writes the validated value with human evidence and preserves existing meta', async () => {
    state.sb = fakeSb([
      { data: item, error: null },
      { data: row, error: null },
      { data: resolved, error: null },
      { data: null, error: null, count: 1 },
      { data: null, error: null },
    ]);
    const result = await review.accept(ID, {}, principal);
    expect(result).toEqual({ status: 200, body: { item: resolved } });
    expect(state.validate).toHaveBeenCalledWith('measurement', { temperature_c: 25 }, { partial: true, current: row });
    const patch = op(state.sb.calls[4], 'update')[1];
    expect(patch.temperature_c).toBe(25);
    expect(patch.meta).toEqual({
      keep: true,
      review_needed: true,
      evidence: {
        kind: { class: 'E2', source: 'dciv in filename' },
        temperature_c: { class: 'human', source: `${ACTOR} via review queue ${ID}` },
      },
    });
    expect(patch.meta_status).toEqual({ kind: 'confirmed', temperature_c: 'confirmed' });
    expect(patch.updated_by).toBe(ACTOR);
  });

  it('accept validates an edited value and records that it was edited', async () => {
    state.validate = vi.fn(async () => ({ columns: { temperature_c: 30 }, meta: {}, meta_status: {}, warnings: [] }));
    state.sb = fakeSb([
      { data: item, error: null },
      { data: row, error: null },
      { data: resolved, error: null },
      { data: null, error: null, count: 1 },
      { data: null, error: null },
    ]);
    await review.accept(ID, { value: 30 }, principal);
    expect(state.validate).toHaveBeenCalledWith('measurement', { temperature_c: 30 }, { partial: true, current: row });
    const patch = op(state.sb.calls[4], 'update')[1];
    expect(patch.temperature_c).toBe(30);
    expect(patch.meta.evidence.temperature_c).toEqual({ class: 'human', source: `${ACTOR} edited via review queue ${ID}` });
  });

  it('reject closes the item but writes nothing to the entity while another item is open', async () => {
    const rejected = { ...item, status: 'rejected', resolved_by: ACTOR };
    state.sb = fakeSb([{ data: item, error: null }, { data: rejected, error: null }, { data: null, error: null, count: 1 }]);
    const result = await review.reject(ID, { note: 'not supported by the files' }, principal);
    expect(result).toEqual({ status: 200, body: { item: rejected } });
    expect(state.sb.calls.map((call) => call.table)).toEqual(['review_queue', 'review_queue', 'review_queue']);
    expect(op(state.sb.calls[1], 'update')[1]).toMatchObject({ status: 'rejected', resolved_by: ACTOR });
  });

  it('returns 409 before a second resolution can write', async () => {
    state.sb = fakeSb([{ data: { ...item, status: 'accepted' }, error: null }]);
    await expect(review.accept(ID, {}, principal)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(state.sb.calls).toHaveLength(1);
    expect(state.validate).not.toHaveBeenCalled();
  });

  it('clears review_needed only when the last open item is resolved', async () => {
    const rejected = { ...item, status: 'rejected', resolved_by: ACTOR };
    state.sb = fakeSb([
      { data: item, error: null },
      { data: rejected, error: null },
      { data: null, error: null, count: 0 },
      { data: { meta: { keep: true, review_needed: true } }, error: null },
      { data: null, error: null },
    ]);
    await review.reject(ID, {}, principal);
    expect(state.sb.calls.map((call) => call.table)).toEqual(['review_queue', 'review_queue', 'review_queue', 'measurements', 'measurements']);
    expect(op(state.sb.calls[4], 'update')[1]).toEqual({ meta: { keep: true, review_needed: false }, updated_by: ACTOR });
  });

  it('refuses accept and reject without a verified human actor', async () => {
    await expect(review.accept(ID, {}, { kind: 'machine', actor: 'api' })).rejects.toMatchObject({ status: 403, code: 'unauthorized' });
    await expect(review.reject(ID, {}, { kind: 'human' })).rejects.toMatchObject({ status: 403, code: 'unauthorized' });
    expect(state.sb.calls).toHaveLength(0);
  });
});

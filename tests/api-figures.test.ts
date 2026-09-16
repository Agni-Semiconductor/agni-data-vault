// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as figures from '../api/_lib/resources/figures.js';

const state = vi.hoisted(() => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));

const UUID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const SPEC = { layout: '1x1', panels: [{ traces: [{ src: { file_id: UUID }, x: 'AV', y: 'AI', future_trace_option: { mode: 'new' } }] }] };
const FIGURE = { id: UUID, slug: 'paper-iv', title: 'Paper IV', spec: SPEC, created_by: 'author@agnisemi.ai' };
const OK = { data: [], error: null, count: 0 };

function fakeSb(results) {
  const queue = results.slice(), calls = [];
  const sb = { calls, from: (table) => { const result = queue.length ? queue.shift() : OK, ops = [], q = {}; calls.push({ table, ops }); for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'order', 'range', 'single']) q[method] = (...args) => { ops.push([method, ...args]); return q; }; q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject); return q; } };
  return sb;
}
function op(call, method) { return call.ops.find(([name]) => name === method); }

beforeEach(() => { state.sb = fakeSb([]); });

describe('figures resource', () => {
  it('lists with search, creator, sort, order and pagination', async () => {
    state.sb = fakeSb([{ data: [FIGURE], error: null, count: 3 }]);
    const result = await figures.list({ q: 'paper', created_by: 'author@agnisemi.ai', sort: 'title', order: 'asc', limit: '10', offset: '2' });
    expect(result).toEqual({ status: 200, body: { items: [FIGURE], total: 3 } });
    expect(state.sb.calls[0].ops).toContainEqual(['eq', 'created_by', 'author@agnisemi.ai']);
    expect(state.sb.calls[0].ops).toContainEqual(['or', 'title.ilike.*paper*,description.ilike.*paper*,slug.ilike.*paper*']);
    expect(state.sb.calls[0].ops).toContainEqual(['order', 'title', { ascending: true, nullsFirst: false }]);
    expect(state.sb.calls[0].ops).toContainEqual(['range', 2, 11]);
  });

  it('creates with the principal actor and retains unknown trace keys', async () => {
    state.sb = fakeSb([{ data: FIGURE, error: null }]);
    const result = await figures.create({ title: 'Paper IV', slug: 'paper-iv', spec: SPEC, created_by: 'spoofed' }, { kind: 'human', actor: 'author@agnisemi.ai' });
    expect(result).toEqual({ status: 201, body: { figure: FIGURE } });
    const payload = op(state.sb.calls[0], 'insert')[1];
    expect(payload.created_by).toBe('author@agnisemi.ai');
    expect(payload).not.toHaveProperty('future_trace_option');
    expect(payload.spec.panels[0].traces[0].future_trace_option).toEqual({ mode: 'new' });
  });

  it('allows a machine principal to set created_by', async () => {
    state.sb = fakeSb([{ data: FIGURE, error: null }]);
    await figures.create({ title: 'Paper IV', spec: SPEC, created_by: 'backfill' }, { kind: 'machine', actor: 'api' });
    expect(op(state.sb.calls[0], 'insert')[1].created_by).toBe('backfill');
  });

  it('reads by uuid with ordered sources and preserves the spec round trip', async () => {
    const sources = [{ figure_id: UUID, panel_index: 0, trace_index: 0, file_id: UUID, source_exists: true }];
    state.sb = fakeSb([{ data: FIGURE, error: null }, { data: sources, error: null }]);
    const result = await figures.get(UUID);
    expect(state.sb.calls[0].ops).toContainEqual(['eq', 'id', UUID]);
    expect(state.sb.calls[1].table).toBe('figure_sources');
    expect(state.sb.calls[1].ops).toContainEqual(['eq', 'figure_id', UUID]);
    expect(result.body).toEqual({ figure: FIGURE, sources });
    expect(result.body.figure.spec.panels[0].traces[0].future_trace_option).toEqual({ mode: 'new' });
  });

  it('reads by slug and always includes an empty sources array', async () => {
    state.sb = fakeSb([{ data: FIGURE, error: null }, { data: null, error: null }]);
    const result = await figures.get('paper-iv');
    expect(state.sb.calls[0].ops).toContainEqual(['eq', 'slug', 'paper-iv']);
    expect(result.body.sources).toEqual([]);
  });

  it('patches partially and replaces spec wholesale', async () => {
    const replacement = { panels: [{ traces: [] }], future_panel_option: true }, updated = { ...FIGURE, spec: replacement };
    state.sb = fakeSb([{ data: FIGURE, error: null }, { data: updated, error: null }]);
    const result = await figures.update('paper-iv', { spec: replacement }, { kind: 'human', actor: 'editor@agnisemi.ai' });
    const patch = op(state.sb.calls[1], 'update')[1];
    expect(patch).toEqual({ spec: replacement, updated_by: 'editor@agnisemi.ai' });
    expect(patch.spec).not.toHaveProperty('layout');
    expect(result.body.figure).toEqual(updated);
  });

  it('deletes the resolved row with a real DELETE', async () => {
    state.sb = fakeSb([{ data: FIGURE, error: null }, OK]);
    const result = await figures.remove('paper-iv');
    expect(result).toEqual({ status: 200, body: { deleted: true } });
    expect(op(state.sb.calls[1], 'delete')).toBeDefined();
    expect(state.sb.calls[1].ops).toContainEqual(['eq', 'id', UUID]);
  });

  it('rejects a spec without panels as a 400 naming spec.panels', async () => {
    await expect(figures.create({ title: 'Broken', spec: { layout: '1x1' } })).rejects.toMatchObject({ status: 400, code: 'invalid_spec', details: [{ key: 'spec.panels', message: 'must be a non-empty array' }] });
    expect(state.sb.calls).toHaveLength(0);
  });

  it('maps a slug collision to a clear 409 conflict', async () => {
    state.sb = fakeSb([{ data: null, error: { code: '23505', message: 'duplicate key' } }]);
    await expect(figures.create({ title: 'Paper IV', slug: 'paper-iv', spec: SPEC })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'slug already exists' });
  });
});

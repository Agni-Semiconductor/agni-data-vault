// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cohorts from '../api/_lib/resources/cohorts.js';

type Result = { data: unknown; error: { code?: string; message?: string } | null; count?: number };
type Call = { table: string; ops: unknown[][] };
type State = { sb: ReturnType<typeof fakeSb> | null };

const state = vi.hoisted((): State => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));
vi.mock('../api/_lib/fieldDefs.js', () => ({ loadDefs: async () => [] }));

const UUID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const IDS = Array.from({ length: 1001 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const COHORT = { id: UUID, slug: 'thin-fe', name: 'Thin FE', predicate: { kind: 'pund' }, metric: 'onoff', group_by: 'stack_fe_t_nm', extractor_version: 'e5' };
const GROUPS = [
  { group_value: '10', n_members: 3, n_with_metric: 2, n_no_metric_row: 1, n_refused: 0, status_confirmed: 1, status_assumed: 1, status_unknown: 0, status_unspecified: 1, median: 12 },
  { group_value: '20', n_members: 4, n_with_metric: 1, n_no_metric_row: 1, n_refused: 2, status_confirmed: 0, status_assumed: 1, status_unknown: 2, status_unspecified: 1, median: 8 },
];
const OK: Result = { data: [], error: null, count: 0 };

function fakeSb(results: Result[]) {
  const queue = results.slice(), calls: Call[] = [], rpcCalls: Array<[string, unknown]> = [];
  const sb = {
    calls, rpcCalls,
    from: (table: string) => {
      const result = queue.length ? queue.shift()! : OK, ops: unknown[][] = [], q: Record<string, (...args: unknown[]) => unknown> = {};
      calls.push({ table, ops });
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'or', 'ilike', 'order', 'range', 'gt', 'single', 'maybeSingle']) q[method] = (...args: unknown[]) => { ops.push([method, ...args]); return q; };
      q.then = (resolve: unknown, reject: unknown) => Promise.resolve(result).then(resolve as (value: Result) => unknown, reject as ((reason: unknown) => unknown) | undefined);
      return q;
    },
    rpc: (name: string, args: unknown) => { rpcCalls.push([name, args]); return Promise.resolve(queue.length ? queue.shift()! : OK); },
  };
  return sb;
}
function op(call: Call, method: string) { return call.ops.find(([name]) => name === method); }
function registryResults(): Result[] { return [{ data: { metric: 'onoff' }, error: null }, { data: { key: 'stack_fe_t_nm' }, error: null }]; }

beforeEach(() => { state.sb = fakeSb([]); });

describe('cohorts resource', () => {
  it('returns both read-only registries without sql_expr', async () => {
    state.sb = fakeSb([{ data: [{ key: 'stack_fe_t_nm', label: 'FE thickness' }], error: null }, { data: [{ metric: 'onoff' }], error: null }]);
    const result = await cohorts.registry();
    expect(result.body).toEqual({ group_keys: [{ key: 'stack_fe_t_nm', label: 'FE thickness' }], metrics: [{ metric: 'onoff' }] });
    expect(result.body.group_keys[0]).not.toHaveProperty('sql_expr');
    expect(op(state.sb.calls[0], 'select')).toEqual(['select', 'key,label,entity,status_key,value_kind,unit,notes']);
    // SORTED: the export order is an implementation detail, but the export SET is the
    // read-only guarantee. A `createGroupKey` or `updateMetric` appearing here would mean a
    // route existed that could write a registry whose sql_expr is executable SQL.
    expect(Object.keys(cohorts).sort()).toEqual(['create', 'get', 'list', 'registry', 'remove', 'summary', 'update']);
  });

  it('rejects an unknown metric before reaching the RPC', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(cohorts.summary({ predicate: {}, metric: 'missing', group_by: 'stack_fe_t_nm' })).rejects.toMatchObject({ status: 422, details: [{ key: 'metric', message: 'unknown value' }] });
    expect(state.sb.rpcCalls).toEqual([]);
  });

  it('rejects an unknown group key before reaching the RPC', async () => {
    state.sb = fakeSb([{ data: { metric: 'onoff' }, error: null }, { data: null, error: null }]);
    await expect(cohorts.summary({ predicate: {}, metric: 'onoff', group_by: 'missing' })).rejects.toMatchObject({ status: 422, details: [{ key: 'group_by', message: 'unknown value' }] });
    expect(state.sb.rpcCalls).toEqual([]);
  });

  it('resolves every membership page, preserves provenance, and totals the ledger', async () => {
    state.sb = fakeSb([...registryResults(), { data: IDS.slice(0, 1000).map((id) => ({ id })), error: null }, { data: IDS.slice(1000).map((id) => ({ id })), error: null }, { data: GROUPS, error: null }]);
    const result = await cohorts.summary({ predicate: { q: 'D1' }, metric: 'onoff', group_by: 'stack_fe_t_nm', extractor_version: 'e5' });
    expect(state.sb.rpcCalls).toEqual([['cohort_summary', { p_measurement_ids: IDS, p_metric: 'onoff', p_group_by: 'stack_fe_t_nm', p_extractor_version: 'e5' }]]);
    expect(result.body).toEqual({ groups: GROUPS, total_members: 7, excluded: 4 });
    expect(result.body.groups[1]).toMatchObject({ status_confirmed: 0, status_assumed: 1, status_unknown: 2, status_unspecified: 1 });
    expect(state.sb.calls.filter((call) => call.table === 'measurements')).toHaveLength(2);
  });

  it('returns an empty population without calling the RPC', async () => {
    state.sb = fakeSb([...registryResults(), { data: [], error: null }]);
    await expect(cohorts.summary({ predicate: {}, metric: 'onoff', group_by: 'stack_fe_t_nm' })).resolves.toEqual({ status: 200, body: { groups: [], total_members: 0, excluded: 0 } });
    expect(state.sb.rpcCalls).toEqual([]);
  });

  it('creates, finds by slug, updates, and deletes cohorts', async () => {
    state.sb = fakeSb([{ data: COHORT, error: null }, { data: COHORT, error: null }, { data: COHORT, error: null }, { data: { ...COHORT, name: 'Updated' }, error: null }, { data: COHORT, error: null }, OK]);
    await expect(cohorts.create({ ...COHORT, created_by: 'spoofed' }, { kind: 'human', actor: 'author@agnisemi.ai' })).resolves.toEqual({ status: 201, body: { cohort: COHORT } });
    expect(op(state.sb.calls[0], 'insert')?.[1]).toMatchObject({ created_by: 'author@agnisemi.ai' });
    await expect(cohorts.get('thin-fe')).resolves.toEqual({ status: 200, body: { cohort: COHORT } });
    expect(state.sb.calls[1].ops).toContainEqual(['eq', 'slug', 'thin-fe']);
    await expect(cohorts.update('thin-fe', { name: 'Updated' }, { kind: 'human', actor: 'editor@agnisemi.ai' })).resolves.toEqual({ status: 200, body: { cohort: { ...COHORT, name: 'Updated' } } });
    expect(op(state.sb.calls[3], 'update')?.[1]).toEqual({ name: 'Updated', updated_by: 'editor@agnisemi.ai' });
    await expect(cohorts.remove('thin-fe')).resolves.toEqual({ status: 200, body: { deleted: true } });
    expect(op(state.sb.calls[5], 'delete')).toBeDefined();
  });
});

describe('an absurd population is refused, never truncated', () => {
  // Full resolution itself is already pinned by "resolves every membership page ..." above,
  // which asserts the RPC received all 1001 ids across two page queries. This covers the other
  // end: what happens when the population is too large to resolve at all.
  it('REFUSES an absurd population instead of clipping it', async () => {
    // A full page every time means the loop never terminates naturally; the cap must stop it,
    // and it must stop it with an error rather than by returning what it has so far.
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    const many = Array.from({ length: 60 }, (_, p) => ({
      data: page.map((_, i) => ({ id: `0000000${p}-0000-4000-8000-${String(i).padStart(12, '0')}` })), error: null,
    }));
    state.sb = fakeSb([...registryResults(), ...many]);
    await expect(cohorts.summary({ predicate: {}, metric: 'onoff', group_by: 'stack_fe_t_nm' }))
      .rejects.toMatchObject({ status: 422, code: 'cohort_too_large' });
    expect(state.sb!.rpcCalls, 'the RPC must not be called with a partial population').toEqual([]);
  });
});

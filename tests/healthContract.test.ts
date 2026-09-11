// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { health } from '../api/_lib/health.js';

const state = vi.hoisted(() => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));

function fakeSb(result) {
  const sb = { calls: [] };
  sb.from = (table) => {
    const call = { table, ops: [] };
    sb.calls.push(call);
    const query = {
      select: (...args) => { call.ops.push(['select', ...args]); return query; },
      limit: (...args) => { call.ops.push(['limit', ...args]); return Promise.resolve(result); },
    };
    return query;
  };
  return sb;
}

beforeEach(() => { state.sb = fakeSb({ data: [], error: null, count: 0 }); });

describe('health contract', () => {
  it('reads field_definitions and reports its count, so a connection-only ping cannot mask inaccessible vault data', async () => {
    state.sb = fakeSb({ data: [{ id: 'seeded-field' }], error: null, count: 26 });

    const result = await health();

    expect(state.sb.calls).toHaveLength(1);
    expect(state.sb.calls[0]).toEqual({
      table: 'field_definitions',
      ops: [['select', 'id', { count: 'exact', head: false }], ['limit', 1]],
    });
    expect(result.checks.database.field_definitions).toBe(26);
  });

  it('marks an empty field_definitions result not ok, because missing BYPASSRLS misleadingly looks like an empty database', async () => {
    const result = await health();

    expect(result.ok).toBe(false);
    expect(result.checks.database.ok).toBe(false);
  });

  it('marks a non-empty field_definitions result ok, so the empty-result guard cannot make every deployment fail', async () => {
    state.sb = fakeSb({ data: [{ id: 'seeded-field' }], error: null, count: 26 });

    const result = await health();

    expect(result.ok).toBe(true);
    expect(result.checks.database).toMatchObject({ ok: true, field_definitions: 26 });
  });

  it('reports a thrown client error as not ok, because an uncaught error misleadingly appears as a broken endpoint', async () => {
    state.sb = { from: () => { throw new Error('database unavailable'); } };

    await expect(health()).resolves.toMatchObject({
      ok: false,
      checks: { database: { ok: false, error: 'database unavailable' } },
    });
  });
});

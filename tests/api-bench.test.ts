// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bench from '../api/_lib/resources/bench.js';

const state = vi.hoisted(() => ({ sb: null, getObject: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));
vi.mock('../api/_lib/storage.js', () => ({ getObject: (...args) => state.getObject(...args) }));

const OK = { data: [], error: null, count: 0 };
function fakeSb(results) {
  const queue = results.slice(), calls = [];
  const scoped = { from: (table) => { const result = queue.length ? queue.shift() : OK, ops = [], q = {}; calls.push({ table, ops }); for (const method of ['select', 'eq', 'gte', 'lte', 'order', 'range', 'limit', 'maybeSingle']) q[method] = (...args) => { ops.push([method, ...args]); return q; }; q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject); return q; } };
  // The client exposes BOTH shapes because bench.js legitimately uses both: `.schema('public')`
  // for every bench table, and the bare default (which supabaseAdmin already scopes to `vault`)
  // for board_pin_map, the vault's own. Modelling only the first is what let a real
  // `public.board_pin_map does not exist` reach the integration check -- a mock that answers by
  // table name without caring which schema was asked for cannot catch that class of bug, so the
  // least it can do is not hide which schema was used.
  return { ...scoped, calls, schema: vi.fn((name) => { expect(name).toBe('public'); return scoped; }) };
}

beforeEach(() => { state.sb = fakeSb([]); state.getObject = vi.fn(); });

describe('bench resource', () => {
  it('packs coverage triples, includes the pinned palette, and leaves unattempted cells absent', async () => {
    state.sb = fakeSb([{ data: [{ grid_row: 0, grid_col: 1, verdict: 'normal', status: 'measured' }, { grid_row: 2, grid_col: 3, verdict: null, status: 'skipped' }], error: null }]);
    const result = await bench.coverage({ dut_id: 'dut-1', run_id: 'run-1' });
    expect(result.body.cells).toEqual([[0, 1, 0], [2, 3, 4]]);
    expect(result.body.total).toBe(2);
    expect(result.body.cells).not.toContainEqual([0, 0, expect.anything()]);
    expect(result.body.legend).toEqual({ 0: 'normal', 1: 'open', 2: 'suspect', 3: 'short', 4: 'skipped' });
    expect(result.body.colors).toEqual(bench.COVERAGE_COLORS);
    expect(result.body.verdict_codes).toEqual(bench.VERDICT_CODES);
  });

  it('reports null rather than zero for lines with no measured cells', async () => {
    state.sb = fakeSb([{ data: [{ grid_row: 1, grid_col: 2, verdict: 'normal', status: 'measured' }], error: null }]);
    const result = await bench.lines({ dut_id: 'dut-1', run_id: 'run-1' });
    expect(result.body.rows[0]).toEqual({ line: 0, measured: 0, bad: 0, rate: null });
    expect(result.body.cols[2]).toEqual({ line: 2, measured: 1, bad: 0, rate: 0 });
  });

  it('rejects a device_tests sort column outside the allow-list', async () => {
    await expect(bench.cells({ dut_id: 'dut-1', run_id: 'run-1', sort: 'drop table' })).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    expect(state.sb.calls).toHaveLength(0);
  });

  it('refuses an invalid dut_id before querying public', async () => {
    await expect(bench.coverage({ dut_id: 'bad/id', run_id: 'run-1' })).rejects.toMatchObject({ status: 400, code: 'invalid_id' });
    expect(state.sb.calls).toHaveLength(0);
  });
});

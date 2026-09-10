// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as kinds from '../api/_lib/resources/kinds.js';

const state = vi.hoisted(() => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));

const OK = { data: [], error: null };
function fakeSb(results) {
  const queue = results.slice(), calls = [];
  return { calls, from: (table) => { const result = queue.length ? queue.shift() : OK, ops = [], q = {}; calls.push({ table, ops }); q.select = (...args) => { ops.push(['select', ...args]); return q; }; q.order = (...args) => { ops.push(['order', ...args]); return q; }; q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject); return q; } };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => { state.sb = fakeSb([]); });

describe('kinds resource', () => {
  it('returns the three registries in one response before the first query settles', async () => {
    const first = deferred();
    state.sb = fakeSb([first.promise, { data: [{ unit: 'A' }], error: null }, { data: [{ column_name: 'i_a', unit: 'A' }], error: null }]);
    const pending = kinds.list();
    expect(state.sb.calls.map((call) => call.table)).toEqual(['measurement_kinds', 'units', 'column_units']);
    first.resolve({ data: [{ kind: 'board_csv', y_unit: null }], error: null });
    await expect(pending).resolves.toEqual({ status: 200, body: { items: [{ kind: 'board_csv', y_unit: null }], units: [{ unit: 'A' }], column_units: [{ column_name: 'i_a', unit: 'A' }] } });
  });

  it('orders each registry by its stable identifier', async () => {
    state.sb = fakeSb([OK, OK, OK]);
    await kinds.list();
    expect(state.sb.calls.map((call) => [call.table, call.ops.find((op) => op[0] === 'order')])).toEqual([
      ['measurement_kinds', ['order', 'kind']], ['units', ['order', 'unit']], ['column_units', ['order', 'column_name']],
    ]);
  });

  it('exports no mutation handler for the seeded registry', () => {
    expect(Object.keys(kinds)).toEqual(['list']);
  });
});

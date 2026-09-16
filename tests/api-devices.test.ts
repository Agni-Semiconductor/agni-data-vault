// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as devices from '../api/_lib/resources/devices.js';

const state = vi.hoisted(() => ({ sb: null }));
vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));

const UUID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const DEVICE = { id: UUID, sample_id: UUID, device_address: 'D116', address_scheme: 'vault_label' };
const OK = { data: [], error: null, count: 0 };

function fakeSb(results) {
  const queue = results.slice(), calls = [], rpcCalls = [];
  const sb = {
    calls, rpcCalls,
    from: (table) => { const result = queue.length ? queue.shift() : OK, ops = [], q = {}; calls.push({ table, ops }); for (const method of ['select', 'insert', 'delete', 'eq', 'gte', 'lte', 'or', 'order', 'range', 'single']) q[method] = (...args) => { ops.push([method, ...args]); return q; }; q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject); return q; },
    rpc: (name, args) => { rpcCalls.push([name, args]); return Promise.resolve(queue.length ? queue.shift() : OK); },
  };
  return sb;
}
function op(call, method) { return call.ops.find(([name]) => name === method); }

beforeEach(() => { state.sb = fakeSb([]); });

describe('devices resource', () => {
  it('refuses machine aliases before any database call', async () => {
    await expect(devices.createAlias(UUID, { alias_address: 'D116_116', alias_scheme: 'bench_grid', reason: 'looks alike' }, { kind: 'machine', actor: 'api' })).rejects.toMatchObject({ status: 422, details: [{ key: 'confirmed_by' }] });
    expect(state.sb.calls).toEqual([]); expect(state.sb.rpcCalls).toEqual([]);
  });

  it('records the human who confirmed an alias', async () => {
    const alias = { id: UUID, device_id: UUID, alias_address: 'D116_116', confirmed_by: 'scientist@agnisemi.ai' };
    state.sb = fakeSb([{ data: DEVICE, error: null }, { data: alias, error: null }]);
    await expect(devices.createAlias(UUID, { alias_address: 'D116_116', alias_scheme: 'bench_grid', reason: 'probe log confirmation' }, { kind: 'human', actor: 'scientist@agnisemi.ai' })).resolves.toEqual({ status: 201, body: { alias } });
    expect(op(state.sb.calls[1], 'insert')[1]).toMatchObject({ confirmed_by: 'scientist@agnisemi.ai' });
  });

  it('refuses geometry and scheme claims for a vault-label device', async () => {
    await expect(devices.create({ sample_id: UUID, device_address: 'D116', grid_row: 116 })).rejects.toMatchObject({ status: 422, details: [{ key: 'grid_row' }] });
    await expect(devices.create({ sample_id: UUID, device_address: 'D116', address_scheme: 'bench_grid' })).rejects.toMatchObject({ status: 422, details: [{ key: 'address_scheme' }] });
    expect(state.sb.calls).toEqual([]);
  });

  it('keeps history device-scoped and bounded', async () => {
    state.sb = fakeSb([{ data: DEVICE, error: null }, { data: [], error: null, count: 0 }]);
    await expect(devices.history(UUID, { limit: '999', offset: '3' })).resolves.toEqual({ status: 200, body: { items: [], total: 0 } });
    expect(state.sb.calls[1].table).toBe('device_history');
    expect(state.sb.calls[1].ops).toContainEqual(['eq', 'device_id', UUID]);
    expect(state.sb.calls[1].ops).toContainEqual(['range', 3, 502]);
  });

  it('turns an unmapped DUT RPC error into a dut_id validation error', async () => {
    state.sb = fakeSb([{ data: null, error: { code: '22023', message: 'dut x is not mapped', hint: 'add a row to vault.dut_sample_map first' } }]);
    await expect(devices.registerBench({ dut_id: '2kb-dut-01' }, { kind: 'machine', actor: 'api' })).rejects.toMatchObject({ status: 422, details: [{ key: 'dut_id', message: 'add a row to vault.dut_sample_map first' }] });
    expect(state.sb.rpcCalls).toEqual([['register_bench_devices', { p_dut_id: '2kb-dut-01', p_actor: 'api' }]]);
  });

  it('rejects an invalid verdict direction before querying the view', async () => {
    await expect(devices.verdictChanges({ direction: 'improved' })).rejects.toMatchObject({ status: 422, details: [{ key: 'direction' }] });
    expect(state.sb.calls).toEqual([]);
  });
});

describe('a vault_label device cannot be handed bench geometry', () => {
  it.each(['address_scheme', 'grid_row', 'grid_col', 'bench_dut_id'])('rejects %s in the body with a named 422', async (key) => {
    // These four say WHERE ON A BOARD a device sits, and that is knowable only from
    // device_tests. Accepting any of them from a request body would let a caller assert die
    // geometry with nothing behind it -- the same fabrication 0114 refuses when it declines to
    // merge D116 onto D116_116. The constraint would refuse three of them anyway, but as a
    // Postgres check violation, and a constraint name is not something a client can act on.
    state.sb = fakeSb([]);
    await expect(devices.create({ sample_id: UUID, device_address: 'D42', [key]: key === 'bench_dut_id' ? 'board-A' : 1 }, { kind: 'human', actor: 'scientist@agnisemi.ai' }))
      .rejects.toMatchObject({ status: 422, details: [{ key }] });
    expect(state.sb.calls, 'must be refused before touching the database').toEqual([]);
  });
});

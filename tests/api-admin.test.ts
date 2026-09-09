// @ts-nocheck
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fieldDefinitions from '../api/_lib/resources/fieldDefinitions.js';
import * as optionLists from '../api/_lib/resources/optionLists.js';

const state = vi.hoisted(() => ({ sb: null, bust: null }));

vi.mock('../api/_lib/supabaseAdmin.js', () => ({ supabaseAdmin: () => state.sb }));
vi.mock('../api/_lib/fieldDefs.js', () => ({ bustCache: (...a) => state.bust(...a) }));

const UUID = '3f2b8c6e-1a4d-4b5e-9c7f-2a6d8e0f1b2c';
const OK = { data: [], error: null, count: 0 };

function fakeSb(results) {
  const queue = results.slice();
  const sb = { calls: [] };
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

const noDelete = () => expect(state.sb.calls.some((c) => c.ops.some((o) => o[0] === 'delete'))).toBe(false);
const row = { id: UUID, entity: 'sample', key: 'sweep_v', label: 'Sweep voltage', type: 'text', options_list_key: null, column_name: null, active: true, sort_order: 10 };

beforeEach(() => {
  state.sb = fakeSb([]);
  state.bust = vi.fn();
});

describe('fieldDefinitions resource', () => {
  it('list filters entity and active by default and orders entity, sort_order, key', async () => {
    state.sb = fakeSb([{ data: [row], error: null, count: 1 }]);
    const r = await fieldDefinitions.list({ entity: 'sample' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [row], total: 1 });
    const c = state.sb.calls[0];
    expect(c.table).toBe('field_definitions');
    expectOp(c, 'select', '*', { count: 'exact' });
    expectOp(c, 'eq', 'entity', 'sample');
    expectOp(c, 'eq', 'active', true);
    expectOp(c, 'order', 'entity');
    expectOp(c, 'order', 'sort_order');
    expectOp(c, 'order', 'key');
  });

  it('list with include_inactive=1 skips the active filter; unknown entity is 400', async () => {
    state.sb = fakeSb([OK]);
    await fieldDefinitions.list({ include_inactive: '1' });
    expect(state.sb.calls[0].ops.some((o) => o[0] === 'eq' && o[1] === 'active')).toBe(false);
    await expect(fieldDefinitions.list({ entity: 'widgets' })).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('create rejects a bad key regex with 422 validation_failed details', async () => {
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'Sweep-V', label: 'X', type: 'text' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', details: [{ key: 'key', message: 'must match ^[a-z][a-z0-9_]*$' }] });
    expect(state.sb.calls.length).toBe(0);
  });

  it('create rejects select without options_list_key and missing required keys', async () => {
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'kind_x', label: 'K', type: 'select' })).rejects.toMatchObject({ status: 422, details: [{ key: 'options_list_key', message: 'is required for select, multiselect, and person fields' }] });
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'kind_x', type: 'text' })).rejects.toMatchObject({ status: 422, details: [{ key: 'label', message: 'required' }] });
    expect(state.sb.calls.length).toBe(0);
  });

  it('create rejects a column_name that is not a real column for the entity', async () => {
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'sweep_v', label: 'S', type: 'number', column_name: 'temperature_c' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', details: [{ key: 'column_name' }] });
    expect(state.sb.calls.length).toBe(0);
  });

  it('create accepts a meta field without column_name, inserts picked payload and busts cache', async () => {
    state.sb = fakeSb([{ data: { ...row, id: 'f1' }, error: null }]);
    const body = { ...row };
    delete body.id;
    const r = await fieldDefinitions.create({ ...body, wat: 1 });
    expect(r.status).toBe(201);
    expect(r.body.field_definition.id).toBe('f1');
    expect(r.body.warnings).toEqual(['unknown key "wat" ignored']);
    const ins = expectOp(state.sb.calls[0], 'insert');
    expect(ins[1]).toEqual({ entity: 'sample', key: 'sweep_v', label: 'Sweep voltage', type: 'text', options_list_key: null, column_name: null, active: true, sort_order: 10 });
    expect(state.bust).toHaveBeenCalledTimes(1);
  });

  it('create checks the referenced option list exists (422 invalid_reference)', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'owner2', label: 'O', type: 'select', options_list_key: 'ghosts' })).rejects.toMatchObject({ status: 422, code: 'invalid_reference', message: 'Option list "ghosts" does not exist' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('create maps unique violation to 409 conflict "field already exists for entity"', async () => {
    state.sb = fakeSb([{ data: null, error: { code: '23505', message: 'duplicate key' } }]);
    await expect(fieldDefinitions.create({ entity: 'sample', key: 'sweep_v', label: 'S', type: 'text' })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'field already exists for entity' });
  });

  it('update rejects changing key as immutable without issuing an update', async () => {
    state.sb = fakeSb([{ data: row, error: null }]);
    await expect(fieldDefinitions.update(UUID, { key: 'sweep_v2' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', message: 'entity and key are immutable; create a new field instead' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('update toggles active, patches by id and busts cache', async () => {
    state.sb = fakeSb([{ data: row, error: null }, { data: { ...row, active: false }, error: null }]);
    const r = await fieldDefinitions.update(UUID, { active: false });
    expect(r.status).toBe(200);
    expectOp(state.sb.calls[1], 'update', { active: false });
    expectOp(state.sb.calls[1], 'eq', 'id', UUID);
    expect(state.bust).toHaveBeenCalledTimes(1);
  });

  it('get is 404 not_found when the definition is missing', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(fieldDefinitions.get(UUID)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('remove soft-deletes via update active=false, never deletes, busts cache', async () => {
    state.sb = fakeSb([{ data: row, error: null }, { data: { ...row, active: false }, error: null }]);
    const r = await fieldDefinitions.remove(UUID);
    expect(r).toEqual({ status: 200, body: { deleted: true, id: UUID, soft: true } });
    expectOp(state.sb.calls[1], 'update', { active: false });
    noDelete();
    expect(state.bust).toHaveBeenCalledTimes(1);
  });
});

describe('optionLists resource', () => {
  it('list embeds active values under their lists with one query per table', async () => {
    const lists = [{ key: 'people', label: 'People', description: '' }, { key: 'kinds', label: 'Kinds', description: '' }];
    const values = [
      { id: 'v2', list_key: 'people', value: 'spencer_ware', label: 'Spencer Ware', sort_order: 10, active: true },
      { id: 'v3', list_key: 'kinds', value: 'dciv', label: 'DC-IV', sort_order: 0, active: true },
    ];
    state.sb = fakeSb([{ data: lists, error: null }, { data: values, error: null }]);
    const r = await optionLists.list({});
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.items[0]).toEqual({ key: 'people', label: 'People', description: '', values: [values[0]] });
    expect(r.body.items[1].values).toEqual([values[1]]);
    expect(state.sb.calls[0].table).toBe('option_lists');
    expect(state.sb.calls[1].table).toBe('option_values');
    expectOp(state.sb.calls[1], 'eq', 'active', true);
    expectOp(state.sb.calls[1], 'order', 'sort_order');
  });

  it('listValues is 404 not_found when the list does not exist', async () => {
    state.sb = fakeSb([{ data: null, error: null }]);
    await expect(optionLists.listValues('ghosts', {})).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('createValue rejects a non-slug value with 422 and never reaches insert', async () => {
    state.sb = fakeSb([{ data: { key: 'people' }, error: null }]);
    await expect(optionLists.createValue('people', { value: 'Bad Value!', label: 'B' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', details: [{ key: 'value', message: 'must be a slug matching ^[a-z0-9][a-z0-9_.-]*$' }] });
    expect(state.sb.calls.length).toBe(1);
  });

  it('createValue requires a label', async () => {
    state.sb = fakeSb([{ data: { key: 'people' }, error: null }]);
    await expect(optionLists.createValue('people', { value: 'new_guy' })).rejects.toMatchObject({ status: 422, details: [{ key: 'label', message: 'required' }] });
  });

  it('createValue defaults sort_order to max existing + 10, sets list_key and busts cache', async () => {
    state.sb = fakeSb([{ data: { key: 'people' }, error: null }, { data: { sort_order: 30 }, error: null }, { data: { id: 'v9', sort_order: 40 }, error: null }]);
    const r = await optionLists.createValue('people', { value: 'new_guy', label: 'New Guy' });
    expect(r.status).toBe(201);
    expect(r.body.option_value.sort_order).toBe(40);
    const max = state.sb.calls[1];
    expectOp(max, 'order', 'sort_order', { ascending: false });
    expectOp(max, 'limit', 1);
    const ins = expectOp(state.sb.calls[2], 'insert');
    expect(ins[1]).toEqual({ value: 'new_guy', label: 'New Guy', sort_order: 40, list_key: 'people' });
    expect(state.bust).toHaveBeenCalledTimes(1);
  });

  it('createValue honors an explicit sort_order and maps duplicate to 409', async () => {
    state.sb = fakeSb([{ data: { key: 'people' }, error: null }, { data: { id: 'v9' }, error: null }]);
    const r = await optionLists.createValue('people', { value: 'new_guy', label: 'N', sort_order: 5 });
    expect(r.status).toBe(201);
    expect(state.sb.calls.length).toBe(2);
    state.sb = fakeSb([{ data: { key: 'people' }, error: null }, { data: null, error: { code: '23505', message: 'duplicate key' } }]);
    await expect(optionLists.createValue('people', { value: 'new_guy', label: 'N', sort_order: 5 })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'value already exists in list' });
  });

  it('updateValue rejects changing value as immutable without issuing an update', async () => {
    state.sb = fakeSb([{ data: { id: 'v1', list_key: 'people', value: 'old', label: 'Old', active: true }, error: null }]);
    await expect(optionLists.updateValue('v1', { value: 'new' })).rejects.toMatchObject({ status: 422, code: 'validation_failed', message: 'value is immutable; retire it and create a new value instead' });
    expect(state.sb.calls.length).toBe(1);
  });

  it('updateValue patches label and busts cache', async () => {
    const cur = { id: 'v1', list_key: 'people', value: 'old', label: 'Old', active: true };
    state.sb = fakeSb([{ data: cur, error: null }, { data: { ...cur, label: 'Renamed' }, error: null }]);
    const r = await optionLists.updateValue('v1', { label: 'Renamed', nope: 1 });
    expect(r.status).toBe(200);
    expect(r.body.warnings).toEqual(['unknown key "nope" ignored']);
    expectOp(state.sb.calls[1], 'update', { label: 'Renamed' });
    expect(state.bust).toHaveBeenCalledTimes(1);
  });

  it('removeValue soft-deletes via update active=false, never deletes, busts cache', async () => {
    state.sb = fakeSb([{ data: { id: 'v1', active: false }, error: null }]);
    const r = await optionLists.removeValue('v1');
    expect(r).toEqual({ status: 200, body: { deleted: true, id: 'v1', soft: true } });
    expectOp(state.sb.calls[0], 'update', { active: false });
    noDelete();
    expect(state.bust).toHaveBeenCalledTimes(1);
  });
});

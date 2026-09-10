import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { pickAllowed } from '../validate.js';
import { bustCache } from '../fieldDefs.js';

const ENTITIES = ['sample', 'measurement', 'file'];
const TYPES = ['text', 'longtext', 'number', 'integer', 'date', 'bool', 'select', 'multiselect', 'person', 'layer_stack', 'json'];
const LIST_TYPES = ['select', 'multiselect', 'person'];
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const WRITABLE = ['entity', 'key', 'label', 'help', 'type', 'options_list_key', 'unit', 'required', 'sort_order', 'group_name', 'active', 'column_name', 'show_in_table', 'filterable', 'min', 'max', 'regex', 'default_value'];
const COLUMN_WHITELIST = {
  sample: ['sample_id', 'label', 'family', 'owner', 'substrate', 'substrate_size', 'fab_location', 'fabricated_by', 'fabricated_on', 'stack', 'notes'],
  measurement: ['measured_on', 'kind', 'instrument', 'probe_station', 'measured_by', 'temperature_c', 'device_address', 'run_numbers', 'pad_shape', 'pad_dim_um', 'pad_area_override', 'notes'],
  file: [],
};
async function assertAdmin(principal) { if (principal?.kind !== 'human') return; const { data, error } = await supabaseAdmin().from('people').select('role').eq('email', principal.actor).maybeSingle(); if (error) throw dbError(error); if (data?.role !== 'admin') throw new ApiError(403, 'unauthorized', 'Admin role required'); }

function defErrors(p, { isNew }) {
  const errors = [];
  if (isNew) for (const k of ['entity', 'key', 'label', 'type']) if (p[k] == null || p[k] === '') errors.push({ key: k, message: 'required' });
  if (p.entity != null && !ENTITIES.includes(p.entity)) errors.push({ key: 'entity', message: 'must be one of sample, measurement, file' });
  if (p.key != null && p.key !== '' && !KEY_RE.test(p.key)) errors.push({ key: 'key', message: 'must match ^[a-z][a-z0-9_]*$' });
  if (p.type != null && p.type !== '' && !TYPES.includes(p.type)) errors.push({ key: 'type', message: `must be one of ${TYPES.join(', ')}` });
  if (LIST_TYPES.includes(p.type) && !p.options_list_key) errors.push({ key: 'options_list_key', message: 'is required for select, multiselect, and person fields' });
  if (p.column_name != null && p.column_name !== '' && p.entity != null && !(COLUMN_WHITELIST[p.entity] || []).includes(p.column_name)) errors.push({ key: 'column_name', message: `is not a real column for entity "${p.entity}"` });
  return errors;
}

async function assertListExists(key) {
  const { data, error } = await supabaseAdmin().from('option_lists').select('key').eq('key', key).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(422, 'invalid_reference', `Option list "${key}" does not exist`);
}

async function fetchOne(id) {
  const { data, error } = await supabaseAdmin().from('field_definitions').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'Field definition not found');
  return data;
}

export async function list(query = {}) {
  if (query.entity != null && query.entity !== '' && !ENTITIES.includes(query.entity)) throw new ApiError(400, 'invalid_input', 'entity must be one of sample, measurement, file');
  let q = supabaseAdmin().from('field_definitions').select('*', { count: 'exact' });
  if (query.entity) q = q.eq('entity', query.entity);
  if (String(query.include_inactive) !== '1') q = q.eq('active', true);
  const { data, error, count } = await q.order('entity').order('sort_order').order('key');
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function create(body, principal) {
  await assertAdmin(principal);
  const warnings = [];
  const p = pickAllowed(body, WRITABLE, warnings);
  const errors = defErrors(p, { isNew: true });
  if (errors.length) throw new ApiError(422, 'validation_failed', 'Validation failed', errors);
  if (p.options_list_key) await assertListExists(p.options_list_key);
  const { data, error } = await supabaseAdmin().from('field_definitions').insert(p).select().single();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'conflict', 'field already exists for entity');
    throw dbError(error);
  }
  bustCache();
  return { status: 201, body: { field_definition: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function get(id) {
  return { status: 200, body: { field_definition: await fetchOne(id) } };
}

export async function update(id, body, principal) {
  await assertAdmin(principal);
  const row = await fetchOne(id);
  const warnings = [];
  const p = pickAllowed(body, WRITABLE, warnings);
  if ((p.entity !== undefined && p.entity !== row.entity) || (p.key !== undefined && p.key !== row.key)) throw new ApiError(422, 'validation_failed', 'entity and key are immutable; create a new field instead');
  if (!Object.keys(p).length) throw new ApiError(400, 'empty_patch', 'No fields to update');
  const errors = defErrors({ ...row, ...p }, { isNew: false });
  if (errors.length) throw new ApiError(422, 'validation_failed', 'Validation failed', errors);
  if (p.options_list_key) await assertListExists(p.options_list_key);
  const { data, error } = await supabaseAdmin().from('field_definitions').update(p).eq('id', row.id).select().single();
  if (error) throw dbError(error);
  bustCache();
  return { status: 200, body: { field_definition: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function remove(id, principal) {
  await assertAdmin(principal);
  const row = await fetchOne(id);
  const { data, error } = await supabaseAdmin().from('field_definitions').update({ active: false }).eq('id', row.id).select().single();
  if (error) throw dbError(error);
  bustCache();
  return { status: 200, body: { deleted: true, id: data.id, soft: true } };
}

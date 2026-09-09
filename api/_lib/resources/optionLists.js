import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { pickAllowed } from '../validate.js';
import { bustCache } from '../fieldDefs.js';

const VALUE_RE = /^[a-z0-9][a-z0-9_.-]*$/;

async function listExists(key) {
  const { data, error } = await supabaseAdmin().from('option_lists').select('key').eq('key', key).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'Option list not found');
}

export async function list(query = {}) {
  const { data: lists, error: e1 } = await supabaseAdmin().from('option_lists').select('*').order('key');
  if (e1) throw dbError(e1);
  let q = supabaseAdmin().from('option_values').select('*');
  if (String(query.include_inactive) !== '1') q = q.eq('active', true);
  const { data: values, error: e2 } = await q.order('sort_order').order('value');
  if (e2) throw dbError(e2);
  const byList = new Map();
  for (const v of values || []) { const a = byList.get(v.list_key) || []; a.push(v); byList.set(v.list_key, a); }
  const items = (lists || []).map((l) => ({ ...l, values: byList.get(l.key) || [] }));
  return { status: 200, body: { items, total: items.length } };
}

export async function listValues(key, query = {}) {
  await listExists(key);
  let q = supabaseAdmin().from('option_values').select('*', { count: 'exact' }).eq('list_key', key);
  if (String(query.include_inactive) !== '1') q = q.eq('active', true);
  const { data, error, count } = await q.order('sort_order').order('value');
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function createValue(key, body) {
  await listExists(key);
  const warnings = [];
  const p = pickAllowed(body, ['value', 'label', 'sort_order', 'meta'], warnings);
  const errors = [];
  if (typeof p.value !== 'string' || !p.value) errors.push({ key: 'value', message: 'required' });
  else if (!VALUE_RE.test(p.value)) errors.push({ key: 'value', message: 'must be a slug matching ^[a-z0-9][a-z0-9_.-]*$' });
  if (typeof p.label !== 'string' || !p.label.trim()) errors.push({ key: 'label', message: 'required' });
  if (errors.length) throw new ApiError(422, 'validation_failed', 'Validation failed', errors);
  if (p.sort_order == null) {
    const { data, error } = await supabaseAdmin().from('option_values').select('sort_order').eq('list_key', key).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(error);
    p.sort_order = ((data && data.sort_order) || 0) + 10;
  }
  const { data: row, error } = await supabaseAdmin().from('option_values').insert({ ...p, list_key: key }).select().single();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'conflict', 'value already exists in list');
    throw dbError(error);
  }
  bustCache();
  return { status: 201, body: { option_value: row, ...(warnings.length ? { warnings } : {}) } };
}

export async function updateValue(id, body) {
  const { data: row, error: e0 } = await supabaseAdmin().from('option_values').select('*').eq('id', id).maybeSingle();
  if (e0) throw dbError(e0);
  if (!row) throw new ApiError(404, 'not_found', 'Option value not found');
  const warnings = [];
  const p = pickAllowed(body, ['label', 'sort_order', 'active', 'meta'], warnings);
  if (body && body.value !== undefined && body.value !== row.value) throw new ApiError(422, 'validation_failed', 'value is immutable; retire it and create a new value instead');
  if (!Object.keys(p).length) throw new ApiError(400, 'empty_patch', 'No fields to update');
  const { data, error } = await supabaseAdmin().from('option_values').update(p).eq('id', row.id).select().single();
  if (error) throw dbError(error);
  bustCache();
  return { status: 200, body: { option_value: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function removeValue(id) {
  const { data, error } = await supabaseAdmin().from('option_values').update({ active: false }).eq('id', id).select().single();
  if (error) throw dbError(error);
  bustCache();
  return { status: 200, body: { deleted: true, id: data.id, soft: true } };
}

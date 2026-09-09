import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { isUuid, parsePagination, parseSort } from '../validate.js';
import { applyEntityFilters, applySort } from '../query.js';
import { validateEntity, loadDefs } from '../fieldDefs.js';
import { removeObject } from '../storage.js';

const SORT_KEYS = ['sample_id', 'label', 'family', 'owner', 'substrate', 'substrate_size', 'fab_location', 'fabricated_by', 'fabricated_on', 'created_at', 'updated_at'];
const EQ_FILTERS = ['family', 'substrate', 'fab_location', 'fabricated_by', 'owner'];
const DEFAULT_SORT = { column: 'updated_at', ascending: false };

async function resolveSample(idOrSampleId) {
  let q = supabaseAdmin().from('samples').select('*');
  q = isUuid(idOrSampleId) ? q.eq('id', idOrSampleId) : q.eq('sample_id', idOrSampleId);
  const { data, error } = await q.single();
  if (error) throw dbError(error);
  return data;
}

export async function list(query = {}) {
  const warnings = [];
  const defs = await loadDefs('sample');
  let q = supabaseAdmin().from('samples').select('*', { count: 'exact' });
  for (const key of EQ_FILTERS) if (query[key]) q = q.eq(key, query[key]);
  q = applyEntityFilters(q, 'sample', query, defs);
  q = applySort(q, parseSort(query, SORT_KEYS, defs) || DEFAULT_SORT, warnings);
  const { limit, offset } = parsePagination(query);
  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length, ...(warnings.length ? { warnings } : {}) } };
}

export async function create(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object');
  if (!body.sample_id || typeof body.sample_id !== 'string' || !body.sample_id.trim()) throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'sample_id', message: 'required' }]);
  const split = await validateEntity('sample', body);
  const { columns = {}, meta = {}, meta_status = {}, warnings = [] } = split || {};
  const payload = { ...columns, sample_id: columns.sample_id ?? body.sample_id, meta, meta_status, created_by: body.created_by ?? 'api' };
  const { data, error } = await supabaseAdmin().from('samples').insert(payload).select().single();
  if (error) {
    if (error.code === '23505') throw new ApiError(409, 'conflict', 'sample_id already exists');
    throw dbError(error);
  }
  return { status: 201, body: { sample: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function get(idOrSampleId, query = {}) {
  const sample = await resolveSample(idOrSampleId);
  if (query.include === 'measurements') {
    const { data, error } = await supabaseAdmin().from('measurements').select('*').eq('sample_id', sample.id).order('measured_on', { ascending: false, nullsFirst: false }).limit(500);
    if (error) throw dbError(error);
    sample.measurements = data || [];
  }
  return { status: 200, body: { sample } };
}

export async function update(idOrSampleId, body) {
  const row = await resolveSample(idOrSampleId);
  const split = await validateEntity('sample', body, { partial: true, current: row });
  const { columns = {}, meta = {}, meta_status = {}, warnings = [] } = split || {};
  const expected = columns.__expected_updated_at ?? body?.expected_updated_at;
  delete columns.__expected_updated_at;
  const patch = { ...columns };
  if (Object.keys(meta).length) {
    const merged = { ...(row.meta || {}), ...meta };
    for (const [k, v] of Object.entries(meta)) if (v === null) delete merged[k];
    patch.meta = merged;
  }
  if (Object.keys(meta_status).length) patch.meta_status = { ...(row.meta_status || {}), ...meta_status };
  if (expected != null && expected !== '' && String(expected) !== String(row.updated_at)) throw new ApiError(409, 'conflict', 'modified since expected_updated_at; re-read and retry');
  if (!Object.keys(patch).length) throw new ApiError(400, 'empty_patch', 'No fields to update');
  let query = supabaseAdmin().from('samples').update(patch).eq('id', row.id);
  if (expected != null && expected !== '') query = query.eq('updated_at', expected);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw dbError(error);
  if (!data && expected != null && expected !== '') throw new ApiError(409, 'conflict', 'modified since expected_updated_at; re-read and retry');
  return { status: 200, body: { sample: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function remove(idOrSampleId) {
  const row = await resolveSample(idOrSampleId);
  const warnings = [];
  const { data: ms, error: e1 } = await supabaseAdmin().from('measurements').select('id').eq('sample_id', row.id);
  if (e1) throw dbError(e1);
  const ids = (ms || []).map((m) => m.id);
  const { data: fs, error: e2 } = ids.length ? await supabaseAdmin().from('files').select('storage_path').in('measurement_id', ids) : { data: [], error: null };
  if (e2) throw dbError(e2);
  for (const f of fs || []) {
    try { await removeObject(f.storage_path); } catch { warnings.push(`failed to remove storage object "${f.storage_path}"`); }
  }
  const { error: e3 } = await supabaseAdmin().from('samples').delete().eq('id', row.id);
  if (e3) throw dbError(e3);
  return { status: 200, body: { deleted: true, id: row.id, ...(warnings.length ? { warnings } : {}) } };
}

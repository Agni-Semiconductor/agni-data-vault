import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { isUuid, parsePagination, parseSort, requireUuid } from '../validate.js';
import { applyEntityFilters, applySort } from '../query.js';
import { validateEntity, loadDefs } from '../fieldDefs.js';
import { deleteObject } from '../storage.js';

const SORT_KEYS = ['measured_on', 'kind', 'instrument', 'probe_station', 'measured_by', 'temperature_c', 'device_address', 'created_at', 'updated_at'];
const EQ_FILTERS = ['kind', 'measured_by', 'instrument', 'device_address'];
const DEFAULT_SORTS = [['measured_on', { ascending: false, nullsFirst: false }], ['created_at', { ascending: false }]];
const actorFor = (body, principal) => principal?.kind === 'human' ? principal.actor : body?.created_by ?? principal?.actor ?? 'api';
async function assertAdmin(principal) { if (principal?.kind !== 'human') return; const { data, error } = await supabaseAdmin().from('people').select('role').eq('email', principal.actor).maybeSingle(); if (error) throw dbError(error); if (data?.role !== 'admin') throw new ApiError(403, 'unauthorized', 'Admin role required'); }

async function resolveSample(sampleIdOrKey) {
  let q = supabaseAdmin().from('samples').select('id');
  q = isUuid(sampleIdOrKey) ? q.eq('id', sampleIdOrKey) : q.eq('sample_id', sampleIdOrKey);
  const { data, error } = await q.maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'No sample with that id');
  return data;
}

async function resolveMeasurement(id) {
  requireUuid(id);
  const { data, error } = await supabaseAdmin().from('measurements').select('*').eq('id', id).single();
  if (error) throw dbError(error);
  return data;
}

function validationError(key, message) {
  return new ApiError(422, 'validation_failed', 'Validation failed', [{ key, message }]);
}

function normalizeRunNumbers(raw) {
  if (raw == null || raw === '') return [];
  let arr = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { throw validationError('run_numbers', 'must be an array of integers'); }
  }
  if (!Array.isArray(arr)) throw validationError('run_numbers', 'must be an array of integers');
  const out = arr.map((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v));
  if (out.some((v) => !Number.isInteger(v))) throw validationError('run_numbers', 'must be an array of integers');
  return out;
}

export async function listForSample(sampleIdOrKey, query = {}) {
  const warnings = [];
  const sample = await resolveSample(sampleIdOrKey);
  const defs = await loadDefs('measurement');
  let q = supabaseAdmin().from('measurements').select('*', { count: 'exact' }).eq('sample_id', sample.id);
  for (const key of EQ_FILTERS) if (query[key]) q = q.eq(key, query[key]);
  q = applyEntityFilters(q, 'measurement', query, defs);
  const spec = parseSort(query, SORT_KEYS, defs);
  if (spec) q = applySort(q, spec, warnings);
  else for (const [column, opts] of DEFAULT_SORTS) q = q.order(column, opts);
  const { limit, offset } = parsePagination(query);
  const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length, ...(warnings.length ? { warnings } : {}) } };
}

export async function createForSample(sampleIdOrKey, body, principal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object');
  const sample = await resolveSample(sampleIdOrKey);
  if (!body.measured_on || typeof body.measured_on !== 'string' || !body.measured_on.trim()) throw validationError('measured_on', 'required');
  if (body.pad_shape != null && body.pad_shape !== '' && !['circle', 'square'].includes(body.pad_shape)) throw validationError('pad_shape', 'must be circle or square');
  const split = await validateEntity('measurement', body);
  const { columns = {}, meta = {}, meta_status = {}, warnings = [] } = split || {};
  const run_numbers = normalizeRunNumbers(columns.run_numbers ?? meta.run_numbers ?? body.run_numbers);
  delete columns.run_numbers;
  delete meta.run_numbers;
  const payload = { ...columns, sample_id: sample.id, measured_on: columns.measured_on ?? body.measured_on, run_numbers, meta, meta_status, created_by: actorFor(body, principal) };
  const { data, error } = await supabaseAdmin().from('measurements').insert(payload).select().single();
  if (error) throw dbError(error);
  return { status: 201, body: { measurement: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function get(id, query = {}) {
  const m = await resolveMeasurement(id);
  if (query.include === 'files') {
    const { data, error } = await supabaseAdmin().from('files').select('*').eq('measurement_id', m.id).order('created_at', { ascending: true });
    if (error) throw dbError(error);
    m.files = data || [];
  }
  return { status: 200, body: { measurement: m } };
}

export async function update(id, body, principal) {
  const row = await resolveMeasurement(id);
  const split = await validateEntity('measurement', body, { partial: true, current: row });
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
  if (!Object.keys(patch).length) throw new ApiError(400, 'empty_patch', 'No fields to update'); if (principal) patch.updated_by = actorFor(body, principal);
  let query = supabaseAdmin().from('measurements').update(patch).eq('id', row.id);
  if (expected != null && expected !== '') query = query.eq('updated_at', expected);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw dbError(error);
  if (!data && expected != null && expected !== '') throw new ApiError(409, 'conflict', 'modified since expected_updated_at; re-read and retry');
  return { status: 200, body: { measurement: data, ...(warnings.length ? { warnings } : {}) } };
}

export async function remove(id, principal) {
  await assertAdmin(principal);
  const row = await resolveMeasurement(id);
  const warnings = [];
  const { data: fs, error: e1 } = await supabaseAdmin().from('files').select('storage_path, bucket').eq('measurement_id', row.id);
  if (e1) throw dbError(e1);
  for (const f of fs || []) {
    try { await deleteObject(f.storage_path, f.bucket ?? 'vault'); } catch { warnings.push(`failed to remove storage object "${f.storage_path}"`); }
  }
  const { error: e2 } = await supabaseAdmin().from('measurements').delete().eq('id', row.id);
  if (e2) throw dbError(e2);
  return { status: 200, body: { deleted: true, id: row.id, ...(warnings.length ? { warnings } : {}) } };
}

export async function listFiles(id, query = {}) {
  const row = await resolveMeasurement(id);
  const { limit, offset } = parsePagination(query);
  const { data, error, count } = await supabaseAdmin().from('files').select('*', { count: 'exact' }).eq('measurement_id', row.id).order('created_at', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

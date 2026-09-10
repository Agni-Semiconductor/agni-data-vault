import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { parsePagination, requireUuid } from '../validate.js';
import { validateEntity } from '../fieldDefs.js';

const ENTITIES = ['sample', 'measurement'];
const tableFor = (entity) => entity === 'sample' ? 'samples' : 'measurements';

function requireHuman(principal) { if (principal?.kind !== 'human' || typeof principal.actor !== 'string' || !principal.actor.trim()) throw new ApiError(403, 'unauthorized', 'A verified human actor is required'); return principal.actor.trim(); }
function requireBody(body = {}) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object'); return body; }

async function resolveItem(id) {
  requireUuid(id);
  const { data, error } = await supabaseAdmin().from('review_queue').select('*').eq('id', id).single();
  if (error) throw dbError(error);
  if (!ENTITIES.includes(data.entity)) throw new ApiError(422, 'validation_failed', 'Review item has an invalid entity');
  if (data.status !== 'open') throw new ApiError(409, 'conflict', 'Review item has already been resolved');
  return data;
}

async function claim(item, status, actor) {
  const resolvedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin().from('review_queue').update({ status, resolved_by: actor, resolved_at: resolvedAt }).eq('id', item.id).eq('status', 'open').select().maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(409, 'conflict', 'Review item has already been resolved');
  return data;
}

async function hasOpenItems(item) {
  const { count, error } = await supabaseAdmin().from('review_queue').select('id', { count: 'exact', head: true }).eq('entity', item.entity).eq('entity_id', item.entity_id).eq('status', 'open');
  if (error) throw dbError(error);
  return (count ?? 0) > 0;
}

export async function list(query = {}) {
  let q = supabaseAdmin().from('review_queue').select('*', { count: 'exact' });
  if (query.status) q = q.eq('status', query.status);
  if (query.entity) q = q.eq('entity', query.entity);
  const { limit, offset } = parsePagination(query);
  const { data, error, count } = await q.order('created_at', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function accept(id, body = {}, principal) {
  const actor = requireHuman(principal);
  body = requireBody(body);
  const item = await resolveItem(id);
  const table = tableFor(item.entity);
  const { data: row, error: rowError } = await supabaseAdmin().from(table).select('*').eq('id', item.entity_id).single();
  if (rowError) throw dbError(rowError);
  const edited = Object.prototype.hasOwnProperty.call(body, 'value');
  const value = edited ? body.value : item.candidate_value;
  const split = await validateEntity(item.entity, { [item.field]: value }, { partial: true, current: row });
  const { columns = {}, meta = {} } = split || {};
  if (!Object.keys(columns).length && !Object.keys(meta).length) throw new ApiError(422, 'validation_failed', 'Review field is not defined', [{ key: item.field, message: 'unknown field' }]);
  const resolved = await claim(item, 'accepted', actor);
  const open = await hasOpenItems(item);
  const source = `${actor}${edited ? ' edited' : ''} via review queue ${item.id}`;
  const evidence = { ...((row.meta?.evidence && typeof row.meta.evidence === 'object' && !Array.isArray(row.meta.evidence)) ? row.meta.evidence : {}), [item.field]: { class: 'human', source } };
  const patch = { ...columns, meta: { ...(row.meta || {}), ...meta, evidence, ...(!open ? { review_needed: false } : {}) }, meta_status: { ...(row.meta_status || {}), [item.field]: 'confirmed' }, updated_by: actor };
  const { error } = await supabaseAdmin().from(table).update(patch).eq('id', item.entity_id);
  if (error) throw dbError(error);
  return { status: 200, body: { item: resolved } };
}

export async function reject(id, body = {}, principal) {
  const actor = requireHuman(principal);
  requireBody(body);
  const item = await resolveItem(id);
  const resolved = await claim(item, 'rejected', actor);
  if (!(await hasOpenItems(item))) {
    const table = tableFor(item.entity);
    const { data: row, error: rowError } = await supabaseAdmin().from(table).select('meta').eq('id', item.entity_id).single();
    if (rowError) throw dbError(rowError);
    const { error } = await supabaseAdmin().from(table).update({ meta: { ...(row.meta || {}), review_needed: false }, updated_by: actor }).eq('id', item.entity_id);
    if (error) throw dbError(error);
  }
  return { status: 200, body: { item: resolved } };
}

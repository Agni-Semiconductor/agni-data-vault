import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { isUuid, parsePagination, parseSort } from '../validate.js';
import { applySort } from '../query.js';

const SORT_KEYS = ['title', 'slug', 'created_by', 'created_at', 'updated_at'];
const WRITE_KEYS = ['title', 'spec', 'description', 'slug', 'pinned_extractor_version'];
const DEFAULT_SORT = { column: 'updated_at', ascending: false };
const SLUG = /^[A-Za-z0-9._~-]+$/;
const actorFor = (body, principal) => principal?.kind === 'human' ? principal.actor : body?.created_by ?? principal?.actor ?? 'api';

function requireBody(body) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object'); }
function validateSpec(spec) { if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Array.isArray(spec.panels) || !spec.panels.length) throw new ApiError(400, 'invalid_spec', 'spec.panels must be a non-empty array', [{ key: 'spec.panels', message: 'must be a non-empty array' }]); }
function validateSlug(slug) { if (slug != null && (typeof slug !== 'string' || !SLUG.test(slug))) throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'slug', message: 'must contain only URL-safe characters' }]); }
function picked(body) { const out = {}; for (const key of WRITE_KEYS) if (body[key] !== undefined) out[key] = body[key]; return out; }
function throwWriteError(error) { if (error?.code === '23505') throw new ApiError(409, 'conflict', 'slug already exists'); throw dbError(error); }

async function resolveFigure(idOrSlug) {
  let q = supabaseAdmin().from('figures').select('*');
  q = isUuid(idOrSlug) ? q.eq('id', idOrSlug) : q.eq('slug', idOrSlug);
  const { data, error } = await q.single();
  if (error) throw dbError(error);
  return data;
}

export async function list(query = {}) {
  let q = supabaseAdmin().from('figures').select('*', { count: 'exact' });
  if (query.created_by) q = q.eq('created_by', query.created_by);
  if (query.q) q = q.or(`title.ilike.*${query.q}*,description.ilike.*${query.q}*,slug.ilike.*${query.q}*`);
  q = applySort(q, parseSort(query, SORT_KEYS) || DEFAULT_SORT);
  const { limit, offset } = parsePagination(query); const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function create(body, principal) {
  requireBody(body);
  if (typeof body.title !== 'string' || !body.title.trim()) throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'title', message: 'required' }]);
  validateSpec(body.spec); validateSlug(body.slug);
  const payload = { ...picked(body), created_by: actorFor(body, principal) };
  const { data, error } = await supabaseAdmin().from('figures').insert(payload).select().single();
  if (error) throwWriteError(error);
  return { status: 201, body: { figure: data } };
}

export async function get(idOrSlug) {
  const figure = await resolveFigure(idOrSlug);
  const { data, error } = await supabaseAdmin().from('figure_sources').select('*').eq('figure_id', figure.id).order('panel_index').order('trace_index');
  if (error) throw dbError(error);
  return { status: 200, body: { figure, sources: data || [] } };
}

export async function update(idOrSlug, body, principal) {
  requireBody(body);
  const row = await resolveFigure(idOrSlug); const patch = picked(body);
  if (Object.hasOwn(patch, 'title') && (typeof patch.title !== 'string' || !patch.title.trim())) throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'title', message: 'must be a non-empty string' }]);
  if (Object.hasOwn(patch, 'spec')) validateSpec(patch.spec);
  if (Object.hasOwn(patch, 'slug')) validateSlug(patch.slug);
  if (!Object.keys(patch).length) throw new ApiError(400, 'empty_patch', 'No fields to update');
  if (principal) patch.updated_by = actorFor(body, principal);
  const { data, error } = await supabaseAdmin().from('figures').update(patch).eq('id', row.id).select().single();
  if (error) throwWriteError(error);
  return { status: 200, body: { figure: data } };
}

export async function remove(idOrSlug) {
  const row = await resolveFigure(idOrSlug);
  const { error } = await supabaseAdmin().from('figures').delete().eq('id', row.id);
  if (error) throw dbError(error);
  return { status: 200, body: { deleted: true } };
}

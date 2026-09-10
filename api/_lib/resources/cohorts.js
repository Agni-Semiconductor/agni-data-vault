import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { isUuid, parsePagination, parseSort } from '../validate.js';
import { applyEntityFilters, applySort, likeTerm } from '../query.js';
import { loadDefs } from '../fieldDefs.js';

const SORT_KEYS = ['name', 'slug', 'metric', 'group_by', 'created_by', 'created_at', 'updated_at'];
const WRITE_KEYS = ['name', 'description', 'predicate', 'metric', 'group_by', 'slug', 'extractor_version'];
const DEFAULT_SORT = { column: 'updated_at', ascending: false };
const SLUG = /^[A-Za-z0-9._~-]+$/;
const MEMBERSHIP_PAGE_SIZE = 1000;
// A cohort is a POPULATION, so membership is resolved in full rather than one page -- but "in
// full" needs a ceiling, because the ids then travel to Postgres in one RPC argument. The
// ceiling REFUSES rather than truncating: a median over a silently clipped population is the
// worst thing this endpoint could return, since it looks entirely normal. Far above anything
// real (the vault holds ~2,106 measurements), so hitting it means a predicate matched much more
// than its author expected -- which is itself worth being told.
const MEMBERSHIP_CAP = 50000;
const actorFor = (body, principal) => principal?.kind === 'human' ? principal.actor : body?.created_by ?? principal?.actor ?? 'api';

function validationError(key, message) { return new ApiError(422, 'validation_failed', 'Validation failed', [{ key, message }]); }
function requireBody(body) { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object'); }
function validateSlug(slug) { if (slug != null && (typeof slug !== 'string' || !SLUG.test(slug))) throw validationError('slug', 'must contain only URL-safe characters'); }
function validatePredicate(predicate) { if (!predicate || typeof predicate !== 'object' || Array.isArray(predicate)) throw validationError('predicate', 'must be an object'); }
function picked(body) { const out = {}; for (const key of WRITE_KEYS) if (body[key] !== undefined) out[key] = body[key]; return out; }
function throwWriteError(error) { if (error?.code === '23505') throw new ApiError(409, 'conflict', 'slug already exists'); throw dbError(error); }

async function resolveCohort(idOrSlug) {
  let q = supabaseAdmin().from('cohorts').select('*');
  q = isUuid(idOrSlug) ? q.eq('id', idOrSlug) : q.eq('slug', idOrSlug);
  const { data, error } = await q.single();
  if (error) throw dbError(error);
  return data;
}

async function requireRegistryValue(table, column, value, field) {
  if (typeof value !== 'string' || !value.trim()) throw validationError(field, 'required');
  const { data, error } = await supabaseAdmin().from(table).select(column).eq(column, value).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw validationError(field, 'unknown value');
}

async function resolveMembership(predicate) {
  const defs = await loadDefs('measurement'); const ids = []; let after;
  while (true) {
    let q = supabaseAdmin().from('measurements').select('id').order('id').range(0, MEMBERSHIP_PAGE_SIZE - 1);
    q = applyEntityFilters(q, 'measurement', predicate, defs);
    if (after) q = q.gt('id', after);
    const { data, error } = await q;
    if (error) throw dbError(error);
    const page = data || []; ids.push(...page.map((row) => row.id));
    if (page.length < MEMBERSHIP_PAGE_SIZE) return ids;
    if (ids.length >= MEMBERSHIP_CAP) throw new ApiError(422, 'cohort_too_large', `This predicate matches more than ${MEMBERSHIP_CAP} measurements. Narrow it: a summary over a population this size would have to be truncated, and a median over a truncated population looks exactly like a correct one.`);
    after = page[page.length - 1].id;
  }
}

export async function registry() {
  // sql_expr is executable SQL; returning it makes a read-only registry look like client input.
  const [groupKeys, metrics] = await Promise.all([
    supabaseAdmin().from('cohort_group_keys').select('key,label,entity,status_key,value_kind,unit,notes').order('key'),
    supabaseAdmin().from('metric_definitions').select('metric,label,unit,log_scale,notes').order('metric'),
  ]);
  if (groupKeys.error) throw dbError(groupKeys.error);
  if (metrics.error) throw dbError(metrics.error);
  return { status: 200, body: { group_keys: groupKeys.data || [], metrics: metrics.data || [] } };
}

export async function list(query = {}) {
  let q = supabaseAdmin().from('cohorts').select('*', { count: 'exact' });
  if (query.q) { const term = likeTerm(query.q); if (term) q = q.or(`name.ilike.*${term}*,description.ilike.*${term}*,slug.ilike.*${term}*`); }
  q = applySort(q, parseSort(query, SORT_KEYS) || DEFAULT_SORT);
  const { limit, offset } = parsePagination(query); const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function create(body, principal) {
  requireBody(body);
  if (typeof body.name !== 'string' || !body.name.trim()) throw validationError('name', 'required');
  validatePredicate(body.predicate); validateSlug(body.slug);
  const payload = { ...picked(body), created_by: actorFor(body, principal) };
  const { data, error } = await supabaseAdmin().from('cohorts').insert(payload).select().single();
  if (error) throwWriteError(error);
  return { status: 201, body: { cohort: data } };
}

export async function get(idOrSlug) { return { status: 200, body: { cohort: await resolveCohort(idOrSlug) } }; }

export async function update(idOrSlug, body, principal) {
  requireBody(body);
  const row = await resolveCohort(idOrSlug); const patch = picked(body);
  if (Object.hasOwn(patch, 'name') && (typeof patch.name !== 'string' || !patch.name.trim())) throw validationError('name', 'must be a non-empty string');
  if (Object.hasOwn(patch, 'predicate')) validatePredicate(patch.predicate);
  if (Object.hasOwn(patch, 'slug')) validateSlug(patch.slug);
  if (!Object.keys(patch).length) throw new ApiError(400, 'empty_patch', 'No fields to update');
  if (principal) patch.updated_by = actorFor(body, principal);
  const { data, error } = await supabaseAdmin().from('cohorts').update(patch).eq('id', row.id).select().single();
  if (error) throwWriteError(error);
  return { status: 200, body: { cohort: data } };
}

export async function remove(idOrSlug) {
  const row = await resolveCohort(idOrSlug);
  const { error } = await supabaseAdmin().from('cohorts').delete().eq('id', row.id);
  if (error) throw dbError(error);
  return { status: 200, body: { deleted: true } };
}

export async function summary(body) {
  requireBody(body);
  const saved = body.cohort_id == null ? null : await resolveCohort(body.cohort_id);
  const config = saved || body;
  validatePredicate(config.predicate);
  await requireRegistryValue('metric_definitions', 'metric', config.metric, 'metric');
  await requireRegistryValue('cohort_group_keys', 'key', config.group_by, 'group_by');
  const ids = await resolveMembership(config.predicate);
  if (!ids.length) return { status: 200, body: { groups: [], total_members: 0, excluded: 0 } };
  const { data, error } = await supabaseAdmin().rpc('cohort_summary', {
    p_measurement_ids: ids, p_metric: config.metric, p_group_by: config.group_by,
    p_extractor_version: config.extractor_version ?? null,
  });
  if (error) throw dbError(error);
  const groups = data || [];
  return { status: 200, body: {
    groups,
    total_members: groups.reduce((total, group) => total + Number(group.n_members), 0),
    excluded: groups.reduce((total, group) => total + Number(group.n_no_metric_row) + Number(group.n_refused), 0),
  } };
}

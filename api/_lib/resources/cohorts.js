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
// The scatter is capped because it travels to a browser and gets drawn; the FIT is never
// capped, which is why the regression sums come back separately. 2000 marks is already past the
// point where a scatter reads as a cloud rather than as points.
const MAX_SCATTER_POINTS = 2000;
// Same shape the RPC returns for a population it found nothing in, built here because the RPC is
// never called with an empty id array. A caller that has to branch on `null` versus a zeroed
// ledger will eventually forget to, and then "no members" renders as a blank panel with no
// explanation instead of as a stated finding.
const emptyCorrelation = (config) => ({
  metric: config.metric, group_by: config.group_by, fit_space: null, x_unit: null, y_unit: null,
  ledger: { n_members: 0, n_with_metric: 0, n_no_metric_row: 0, n_refused: 0, n_no_x: 0, n_nonpositive_y: 0, n_fit: 0 },
  fit: null, points: [], points_returned: 0, points_sampled: false,
});
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

// summary() and correlation() answer the same question in two shapes, so they resolve their
// configuration identically -- extracted rather than copied, because a predicate resolved two
// slightly different ways is two different cohorts wearing one name.
//
// Membership is NOT resolved here, deliberately. It is the expensive half (keyset paging over
// every matching measurement) and correlation() has one more request to refuse first.
async function resolveConfig(body) {
  requireBody(body);
  const saved = body.cohort_id == null ? null : await resolveCohort(body.cohort_id);
  const config = saved || body;
  validatePredicate(config.predicate);
  await requireRegistryValue('metric_definitions', 'metric', config.metric, 'metric');
  await requireRegistryValue('cohort_group_keys', 'key', config.group_by, 'group_by');
  return config;
}

export async function summary(body) {
  const config = await resolveConfig(body);
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

// E5's continuous view. The FIT SPACE is the database's decision, not this layer's and not the
// browser's: `cohort_correlation` reads metric_definitions.log_scale and returns `fit_space`
// alongside the coefficients, so a slope can never be read in the wrong space by a caller that
// guessed. This function's whole job is to refuse the requests SQL should not have to.
//
// A categorical group key is refused HERE as a 422 naming the field, rather than being allowed
// through to the RPC's own exception -- the database check stays as the backstop, but a user who
// picked "Fab location" from a dropdown deserves a validation error, not a 500.
export async function correlation(body) {
  const config = await resolveConfig(body);
  const maxPoints = config.max_points === undefined ? MAX_SCATTER_POINTS : Number(config.max_points);
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > MAX_SCATTER_POINTS) {
    throw validationError('max_points', `must be an integer between 1 and ${MAX_SCATTER_POINTS}`);
  }
  // BEFORE resolveMembership, which pages over every matching measurement. A request that cannot
  // be answered should not first cost a full population scan -- and the mocked test caught this
  // the other way round, with the membership query consuming the answer meant for this one.
  const { data: key, error: keyError } = await supabaseAdmin()
    .from('cohort_group_keys').select('key,value_kind').eq('key', config.group_by).maybeSingle();
  if (keyError) throw dbError(keyError);
  if (key?.value_kind !== 'continuous') {
    throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'group_by', message: 'a correlation needs a continuous grouping key; this one is categorical' }]);
  }
  const ids = await resolveMembership(config.predicate);
  if (!ids.length) return { status: 200, body: emptyCorrelation(config) };
  const { data, error } = await supabaseAdmin().rpc('cohort_correlation', {
    p_measurement_ids: ids, p_metric: config.metric, p_group_by: config.group_by,
    p_extractor_version: config.extractor_version ?? null, p_max_points: maxPoints,
  });
  if (error) throw dbError(error);
  return { status: 200, body: data };
}

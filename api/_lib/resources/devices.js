import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { parseSort, requireDate, requireString, requireUuid } from '../validate.js';
import { applySort, likeTerm } from '../query.js';

// Must match DEVICE_SORT_KEYS in src/lib/devices.ts exactly -- pinned by a parity test that reads
// this list from source. grid_row/grid_col are here because walking a board in grid order is the
// natural way to read it; without them the client offered two sorts that silently fell back to
// the default, showing a sort indicator on a column the server never sorted by.
// Must match VERDICT_SORT_KEYS in src/lib/devices.ts exactly -- pinned by a parity test.
// Every column the report displays, because a user clicking a header expects it to sort and a
// key that is not here silently falls back to the default while the header still shows an arrow.
const VERDICT_SORT_KEYS = ['started_at', 'device_address', 'dut_id', 'direction', 'new_verdict', 'prev_verdict', 'run_id', 'prev_run_id'];
const DEFAULT_VERDICT_SORT = { column: 'started_at', ascending: false };
const DEVICE_SORT_KEYS = ['device_address', 'address_scheme', 'grid_row', 'grid_col', 'created_at', 'updated_at'];
const HISTORY_KINDS = ['measurement', 'bench_cell'];
const DIRECTIONS = ['degraded', 'recovered', 'changed'];
const DEFAULT_DEVICE_SORT = { column: 'created_at', ascending: false };
const validationError = (key, message) => new ApiError(422, 'validation_failed', 'Validation failed', [{ key, message }]);
const requireBody = (body) => { if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object'); };
const pagination = (query = {}, fallback, cap) => {
  const number = (value, defaultValue) => value == null || value === '' ? defaultValue : Number(value);
  let limit = number(query.limit, fallback), offset = number(query.offset, 0);
  if (!Number.isInteger(limit) || limit < 1) limit = fallback;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit: Math.min(limit, cap), offset };
};

async function resolveDevice(id) {
  requireUuid(id);
  const { data, error } = await supabaseAdmin().from('devices').select('*').eq('id', id).single();
  if (error) throw dbError(error);
  return data;
}

export async function list(query = {}) {
  let q = supabaseAdmin().from('devices').select('*', { count: 'exact' });
  if (query.sample_id) q = q.eq('sample_id', query.sample_id);
  if (query.address_scheme) q = q.eq('address_scheme', query.address_scheme);
  if (query.q) { const term = likeTerm(query.q); if (term) q = q.or(`device_address.ilike.*${term}*,notes.ilike.*${term}*`); }
  q = applySort(q, parseSort(query, DEVICE_SORT_KEYS) || DEFAULT_DEVICE_SORT);
  const { limit, offset } = pagination(query, 50, 200); const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function get(id) {
  const device = await resolveDevice(id);
  const [aliases, measurements, benchCells] = await Promise.all([
    supabaseAdmin().from('device_aliases').select('*').eq('device_id', device.id).order('confirmed_at'),
    supabaseAdmin().from('measurements').select('id', { count: 'exact', head: true }).eq('device_id', device.id),
    supabaseAdmin().from('device_history').select('event_id', { count: 'exact', head: true }).eq('device_id', device.id).eq('event_kind', 'bench_cell'),
  ]);
  if (aliases.error) throw dbError(aliases.error);
  if (measurements.error) throw dbError(measurements.error);
  if (benchCells.error) throw dbError(benchCells.error);
  return { status: 200, body: { device, aliases: aliases.data || [], counts: { measurements: measurements.count ?? 0, bench_cells: benchCells.count ?? 0 } } };
}

export async function create(body, principal) {
  requireBody(body);
  // bench_dut_id belongs here with the geometry: it says which physical board a cell came from,
  // and it is knowable only from device_tests. Without it in this list the request still fails --
  // devices_vault_has_no_grid refuses it -- but as a Postgres check violation rather than a 422
  // naming the field, and a constraint name is not an error a client can act on.
  for (const key of ['address_scheme', 'grid_row', 'grid_col', 'bench_dut_id']) if (body[key] !== undefined) throw validationError(key, 'must not be supplied when creating a vault_label device');
  if (typeof body.sample_id !== 'string' || !body.sample_id.trim()) throw validationError('sample_id', 'required');
  if (typeof body.device_address !== 'string' || !body.device_address.trim()) throw validationError('device_address', 'required');
  if (body.notes !== undefined && typeof body.notes !== 'string') throw validationError('notes', 'must be a string');
  const created_by = principal?.kind === 'human' ? principal.actor : body.created_by ?? principal?.actor ?? 'api';
  const payload = { sample_id: body.sample_id, device_address: body.device_address, address_scheme: 'vault_label', created_by };
  if (body.notes !== undefined) payload.notes = body.notes;
  const { data, error } = await supabaseAdmin().from('devices').insert(payload).select().single();
  if (error) throw dbError(error);
  return { status: 201, body: { device: data } };
}

export async function history(id, query = {}) {
  await resolveDevice(id);
  if (query.event_kind && !HISTORY_KINDS.includes(query.event_kind)) throw validationError('event_kind', 'must be measurement or bench_cell');
  const from = requireDate(query.from, 'from'), to = requireDate(query.to, 'to');
  let q = supabaseAdmin().from('device_history').select('*', { count: 'exact' }).eq('device_id', id);
  if (from) q = q.gte('occurred_at', from); if (to) q = q.lte('occurred_at', to); if (query.event_kind) q = q.eq('event_kind', query.event_kind);
  const { limit, offset } = pagination(query, 200, 500); const { data, error, count } = await q.order('occurred_at').range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function createAlias(id, body, principal) {
  requireBody(body);
  // A machine-created alias turns an unverified address resemblance into permanent history.
  if (principal?.kind !== 'human') throw validationError('confirmed_by', 'requires a human principal');
  await resolveDevice(id);
  if (typeof body.alias_address !== 'string' || !body.alias_address.trim()) throw validationError('alias_address', 'required');
  if (!['bench_grid', 'vault_label'].includes(body.alias_scheme)) throw validationError('alias_scheme', 'must be bench_grid or vault_label');
  if (typeof body.reason !== 'string' || !body.reason.trim()) throw validationError('reason', 'required');
  const { data, error } = await supabaseAdmin().from('device_aliases').insert({ device_id: id, alias_address: body.alias_address, alias_scheme: body.alias_scheme, reason: body.reason, confirmed_by: principal.actor }).select().single();
  if (error) throw dbError(error);
  return { status: 201, body: { alias: data } };
}

export async function removeAlias(id, aliasId) {
  requireUuid(id); requireUuid(aliasId, 'aliasId');
  const { error } = await supabaseAdmin().from('device_aliases').delete().eq('id', aliasId).eq('device_id', id);
  if (error) throw dbError(error);
  return { status: 200, body: { deleted: true } };
}

export async function registerBench(body, principal) {
  requireBody(body); requireString(body.dut_id, 'dut_id');
  const actor = principal?.kind === 'human' ? principal.actor : body.created_by ?? principal?.actor ?? 'api';
  const { data, error } = await supabaseAdmin().rpc('register_bench_devices', { p_dut_id: body.dut_id, p_actor: actor });
  if (error?.code === '22023') throw validationError('dut_id', error.hint || error.message);
  if (error) throw dbError(error);
  return { status: 200, body: { created: data } };
}

export async function verdictChanges(query = {}) {
  if (query.direction && !DIRECTIONS.includes(query.direction)) throw validationError('direction', 'must be degraded, recovered or changed');
  const from = requireDate(query.from, 'from'), to = requireDate(query.to, 'to');
  let q = supabaseAdmin().from('device_verdict_changes').select('*', { count: 'exact' });
  if (query.dut_id) q = q.eq('dut_id', query.dut_id); if (query.direction) q = q.eq('direction', query.direction);
  if (from) q = q.gte('started_at', from); if (to) q = q.lte('started_at', to);
  // Sorting, like every other list route here, and DESCENDING by default: this is a "what
  // changed" report and the most recent change is the one being looked for. The previous
  // hardcoded ascending order put the oldest degradation on page one and the newest on page N.
  q = applySort(q, parseSort(query, VERDICT_SORT_KEYS) || DEFAULT_VERDICT_SORT);
  const { limit, offset } = pagination(query, 200, 500); const { data, error, count } = await q.range(offset, offset + limit - 1);
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { getObject } from '../storage.js';

export const COVERAGE_COLORS = {
  light: { normal: '#1565C0', open: '#26A69A', suspect: '#EF6C00', short: '#9E0010', skipped: '#6E6E6E' },
  dark: { normal: '#1565C0', open: '#00A896', suspect: '#C86A00', short: '#C10015', skipped: '#6E6E6E' },
};
export const LINE_RATE_RAMP = { light: ['#EBE5F3', '#CAB8E1', '#AA8BCD', '#8B5FB9', '#6B339D'], dark: ['#382E43', '#5D4676', '#8462AA', '#AD80DD', '#D0A9FE'] };
export const VERDICT_CODES = { normal: 0, open: 1, no_signal: 2, indeterminate: 2, short: 3, skipped: 4 };
export const CODE_LABELS = { 0: 'normal', 1: 'open', 2: 'suspect', 3: 'short', 4: 'skipped' };

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Real device_tests columns only. A name on this list that does not exist is worse than an
// omission: the caller is told it is allowed and then gets a database error.
const CELL_SORTS = ['grid_row', 'grid_col', 'seq', 'measurement', 'status', 'verdict', 'cause',
  'suspect', 'capture_id', 'i_max_a', 'elapsed_s', 'started_at', 'ended_at', 'created_at'];
const db = () => supabaseAdmin().schema('public');
const one = async (query) => { const { data, error } = await query; if (error) throw dbError(error); return data; };
const benchId = (value, name) => { if (typeof value !== 'string' || !ID.test(value)) throw new ApiError(400, 'invalid_id', `${name} must contain only letters, numbers, dots, underscores, or hyphens`); return value; };
// run_id is optional on the whole-DUT views: coverage and lines default to the latest state
// across every run, matching the bench's own coverage(dut, run_id=None). Validate it when
// present, treat absence as 'all runs' rather than as a bad request.
const optionalBenchId = (query, key) => { const value = query?.[key]; if (value == null || value === '') return null; benchId(value, key); return value; };
const required = (query, name) => benchId(query?.[name], name);
const pagination = (query = {}) => { const number = (value, fallback) => value == null || value === '' ? fallback : Number(value); const limit = number(query.limit, 100), offset = number(query.offset, 0); if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'invalid_input', 'limit must be a positive integer and offset must be a non-negative integer'); return { limit: Math.min(limit, 2000), offset }; };
const coordinate = (query, name) => { if (query[name] == null || query[name] === '') return null; const value = Number(query[name]); if (!Number.isInteger(value) || value < 0 || value > 127) throw new ApiError(400, 'invalid_input', `${name} must be an integer from 0 to 127`); return value; };
const coverageCode = (cell) => VERDICT_CODES[cell.verdict ?? cell.status];
const coverageRows = async (dutId, runId) => { let q = db().from('device_coverage').select('grid_row, grid_col, verdict, status').eq('dut_id', dutId); if (runId) q = q.eq('run_id', runId); const { data, error } = await q.limit(16384); if (error) throw dbError(error); return data || []; };

export async function duts(query = {}, principal) { const { data, error, count } = await db().from('duts').select('dut_id', { count: 'exact' }).order('dut_id', { ascending: true }); if (error) throw dbError(error); return { status: 200, body: { items: data || [], total: count ?? (data || []).length } }; }

export async function runs(query = {}, principal) { const { limit, offset } = pagination(query); let q = db().from('campaign_runs').select('*', { count: 'exact' }); if (query.dut_id != null && query.dut_id !== '') q = q.eq('dut_id', required(query, 'dut_id')); if (query.status != null && query.status !== '') q = q.eq('status', query.status); const { data, error, count } = await q.order('started_at', { ascending: false, nullsFirst: false }).range(offset, offset + limit - 1); if (error) throw dbError(error); return { status: 200, body: { items: data || [], total: count ?? (data || []).length } }; }

export async function run(runId, query = {}, principal) { benchId(runId, 'run_id'); const dutId = required(query, 'dut_id'); const runRow = await one(db().from('campaign_runs').select('*').eq('run_id', runId).eq('dut_id', dutId).maybeSingle()); if (!runRow) throw new ApiError(404, 'not_found', 'Campaign run not found'); const analysis = await one(db().from('run_analysis').select('*').eq('run_id', runId).eq('dut_id', dutId).order('extractor_version', { ascending: false }).limit(1).maybeSingle()); return { status: 200, body: { run: runRow, analysis: analysis || null } }; }

export async function coverage(query = {}, principal) { const dutId = required(query, 'dut_id'), runId = optionalBenchId(query, 'run_id'), source = await coverageRows(dutId, runId); const counts = Object.fromEntries(Object.values(CODE_LABELS).map((label) => [label, 0])); const cells = []; for (const cell of source) { const code = coverageCode(cell); if (code == null) continue; counts[CODE_LABELS[code]] += 1; cells.push([Number(cell.grid_row), Number(cell.grid_col), code]); } return { status: 200, body: { dut_id: dutId, run_id: runId, rows: 128, cols: 128, total: cells.length, counts, cells, legend: CODE_LABELS, colors: COVERAGE_COLORS, verdict_codes: VERDICT_CODES } }; }

export async function cells(query = {}, principal) { const dutId = required(query, 'dut_id'), runId = required(query, 'run_id'), { limit, offset } = pagination(query); if (query.sort != null && query.sort !== '' && !CELL_SORTS.includes(query.sort)) throw new ApiError(400, 'invalid_input', 'sort is not an allowed device_tests column'); let q = db().from('device_tests').select('*', { count: 'exact' }).eq('dut_id', dutId).eq('run_id', runId); for (const key of ['verdict', 'status', 'measurement']) if (query[key] != null && query[key] !== '') q = q.eq(key, query[key]); const rowMin = coordinate(query, 'row_min'), rowMax = coordinate(query, 'row_max'), colMin = coordinate(query, 'col_min'), colMax = coordinate(query, 'col_max'); if (rowMin != null) q = q.gte('grid_row', rowMin); if (rowMax != null) q = q.lte('grid_row', rowMax); if (colMin != null) q = q.gte('grid_col', colMin); if (colMax != null) q = q.lte('grid_col', colMax); const sort = query.sort || 'grid_row', ascending = query.order !== 'desc'; const { data, error, count } = await q.order(sort, { ascending, nullsFirst: false }).range(offset, offset + limit - 1); if (error) throw dbError(error); return { status: 200, body: { items: data || [], total: count ?? (data || []).length } }; }

export async function analysisCells(query = {}, principal) { const dutId = required(query, 'dut_id'), runId = required(query, 'run_id'), { limit, offset } = pagination(query); const { data, error, count } = await db().from('cell_analysis').select('*', { count: 'exact' }).eq('dut_id', dutId).eq('run_id', runId).range(offset, offset + limit - 1); if (error) throw dbError(error); return { status: 200, body: { items: data || [], total: count ?? (data || []).length } }; }

export async function lines(query = {}, principal) { const dutId = required(query, 'dut_id'), runId = optionalBenchId(query, 'run_id'), source = await coverageRows(dutId, runId); const aggregate = () => Array.from({ length: 128 }, () => ({ measured: 0, bad: 0 })); const rowCounts = aggregate(), colCounts = aggregate(); for (const cell of source) { const row = Number(cell.grid_row), col = Number(cell.grid_col); if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 127 || col < 0 || col > 127) continue; rowCounts[row].measured += 1; colCounts[col].measured += 1; if (cell.verdict !== 'normal') { rowCounts[row].bad += 1; colCounts[col].bad += 1; } } const format = (counts, pins) => counts.map((count, line) => ({ line, measured: count.measured, bad: count.bad, rate: count.measured ? count.bad / count.measured : null, ...(pins.get(line) ? { net: pins.get(line).net, pin: pins.get(line).pin } : {}) }));
  /* The pin map joins here rather than in a second round trip: a stripe at WL 42 is only
     actionable once you know which package pin to physically probe, so the answer and the way to
     act on it arrive together. It is OPTIONAL -- a board with no map still renders, the tooltip
     simply says nothing about pins, and an empty map is a board nobody has wired up yet rather
     than an error. */
  // vaultDb(), not db(). Every other query in this file reads a BENCH table and db() is therefore
  // scoped to `public`; board_pin_map is the vault's own, in `vault`. Using db() here asks
  // PostgREST for public.board_pin_map, which does not exist -- caught by the integration check
  // against real PostgREST, and invisible to a mocked test because a mock answers by table name
  // without caring which schema was asked for.
  const pinRows = await one(supabaseAdmin().from('board_pin_map').select('family, line, net, pin').eq('dut_id', dutId)) || [];
  const pinsFor = (family) => new Map((pinRows || []).filter((row) => row.family === family).map((row) => [Number(row.line), row]));
  return { status: 200, body: { rows: format(rowCounts, pinsFor('wl')), cols: format(colCounts, pinsFor('bl')), ramp: LINE_RATE_RAMP } }; }

export async function captureContent(captureId, query = {}, principal) { benchId(captureId, 'capture_id'); const dutId = required(query, 'dut_id'); const capture = await one(db().from('captures').select('storage_path, size_bytes').eq('capture_id', captureId).eq('dut_id', dutId).maybeSingle()); if (!capture) throw new ApiError(404, 'not_found', 'Capture not found'); try { const object = await getObject(capture.storage_path, 'bench'); return { status: 200, stream: object.body, headers: { 'content-type': object.contentType || 'application/octet-stream', ...(Number.isFinite(object.size ?? capture.size_bytes) ? { 'content-length': String(object.size ?? capture.size_bytes) } : {}) } }; } catch (error) { throw new ApiError(500, 'storage_error', error?.message || 'Could not download capture'); } }

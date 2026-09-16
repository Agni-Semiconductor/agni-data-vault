import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { requireString } from '../validate.js';

const DUT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function assertAdmin(principal) {
  if (principal?.kind !== 'human') return;
  const { data, error } = await supabaseAdmin().from('people').select('role').eq('email', principal.actor).maybeSingle();
  if (error) throw dbError(error);
  if (data?.role !== 'admin') throw new ApiError(403, 'unauthorized', 'Admin role required');
}

function requireDutId(value) {
  requireString(value, 'dutId');
  // This is the bench identifier grammar used by bench.js. Letting separators through would make
  // a malformed path look like an absent mapping, hiding a caller bug as a 404.
  if (!DUT_ID.test(value)) throw new ApiError(400, 'invalid_id', 'dutId must contain only letters, numbers, dots, underscores, or hyphens');
  return value;
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body', 'Request body must be a JSON object');
}

export async function list() {
  const { data, error, count } = await supabaseAdmin().from('dut_sample_map').select('*', { count: 'exact' }).order('dut_id', { ascending: true });
  if (error) throw dbError(error);
  return { status: 200, body: { items: data || [], total: count ?? (data || []).length } };
}

export async function get(dutId) {
  dutId = requireDutId(dutId);
  const { data, error } = await supabaseAdmin().from('dut_sample_map').select('*').eq('dut_id', dutId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new ApiError(404, 'not_found', 'DUT mapping not found');
  return { status: 200, body: { mapping: data } };
}

export async function put(dutId, body, principal) {
  dutId = requireDutId(dutId);
  await assertAdmin(principal);
  requireBody(body);
  requireString(body.sample_id, 'sample_id');
  if (body.note !== undefined) requireString(body.note, 'note');

  const { data: existing, error: existingError } = await supabaseAdmin().from('dut_sample_map').select('*').eq('dut_id', dutId).maybeSingle();
  if (existingError) throw dbError(existingError);
  // A remap changes the sample attributed to every measurement reached through this DUT. Refusing
  // without an explicit acknowledgement prevents that history rewrite from appearing as a routine edit.
  if (existing && existing.sample_id !== body.sample_id && body.allow_remap !== true) {
    throw new ApiError(409, 'remap_refused', `Refused to remap ${dutId} from ${existing.sample_id} to ${body.sample_id}; pass allow_remap: true to confirm re-attributing registered measurements`);
  }
  // `note` is the table's provenance field. A missing note on creation turns a guessed board link
  // into an apparently factual record, leaving later readers with no basis to audit it.
  if (!existing && (body.note === undefined || !body.note.trim())) throw new ApiError(422, 'validation_failed', 'Validation failed', [{ key: 'note', message: 'required on create as provenance' }]);

  const payload = { sample_id: body.sample_id };
  if (body.note !== undefined) payload.note = body.note;
  const query = existing
    ? supabaseAdmin().from('dut_sample_map').update(payload).eq('dut_id', dutId)
    : supabaseAdmin().from('dut_sample_map').insert({ dut_id: dutId, ...payload });
  const { data, error } = await query.select().single();
  if (error) throw dbError(error);
  return { status: existing ? 200 : 201, body: { mapping: data } };
}

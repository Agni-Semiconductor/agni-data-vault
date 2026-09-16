import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { validateEntity } from '../fieldDefs.js';
import { buildStoragePath, kindFromExtension } from '../storage.js';
import { extractFromPath, proposeGroups } from '../evidence.js';

const SHA256 = /^[0-9a-f]{64}$/i;
const db = () => supabaseAdmin();
const one = async (query) => { const { data, error } = await query; if (error) throw dbError(error); return data; };
const actorFor = (body, principal) => principal?.kind === 'human' ? principal.actor : body?.created_by ?? principal?.actor ?? 'api';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const valueEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const filenameFor = (path) => String(path).replace(/\\/g, '/').split('/').pop();

function invalid(details) { throw new ApiError(422, 'validation_failed', 'Validation failed', details); }
function ensureObject(value, key) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid([{ key, message: 'must be an object' }]); return value; }
function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length) invalid([{ key: 'files', message: 'must be a non-empty array' }]);
  return files.map((file, i) => {
    const value = typeof file === 'string' ? { path: file } : ensureObject(file, `files[${i}]`);
    if (typeof value.path !== 'string' || !value.path.trim()) invalid([{ key: `files[${i}].path`, message: 'must be a non-empty string' }]);
    if (!Number.isInteger(value.size_bytes) || value.size_bytes < 0) invalid([{ key: `files[${i}].size_bytes`, message: 'must be an integer >= 0' }]);
    if (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) invalid([{ key: `files[${i}].sha256`, message: 'must be 64 hexadecimal characters' }]);
    return { path: value.path, size_bytes: value.size_bytes, sha256: value.sha256 };
  });
}
function count(groups) { return groups.reduce((totals, group) => ({ files: totals.files + group.files.length, groups: totals.groups + 1, confirmed_fields: totals.confirmed_fields + Object.keys(group.confirmed || {}).length, queued_fields: totals.queued_fields + (group.queued || []).length }), { files: 0, groups: 0, confirmed_fields: 0, queued_fields: 0 }); }
function evidenceFor(files, field, claimed) {
  for (const file of files) {
    const found = extractFromPath(file.path).confirmed?.[field];
    if (found && valueEqual(found.value, claimed.value) && found.class === claimed.class && found.source === claimed.source) return found;
  }
  return null;
}
async function sampleFor(id) { const sample = await one(db().from('samples').select('id, sample_id').eq('id', id).maybeSingle()); if (!sample) throw new ApiError(404, 'not_found', 'Sample not found'); return sample; }
async function uniquePath(sample, measurementId, filename) {
  for (let n = 1; n <= 20; n += 1) {
    const adjusted = n === 1 ? filename : (() => { const i = filename.lastIndexOf('.'); return i > 0 ? `${filename.slice(0, i)}-${n}${filename.slice(i)}` : `${filename}-${n}`; })();
    const storagePath = buildStoragePath(sample.sample_id, measurementId, adjusted);
    const existing = await one(db().from('files').select('id').eq('bucket', 'vault').eq('storage_path', storagePath).maybeSingle()); if (!existing) return storagePath;
  }
  throw new ApiError(409, 'duplicate_file', 'Could not find a unique storage path');
}
function normalizeConfirmed(group, files) {
  const confirmed = ensureObject(group.confirmed || {}, 'confirmed'); const result = {};
  for (const [field, claimed] of Object.entries(confirmed)) {
    if (!claimed || typeof claimed !== 'object' || !own(claimed, 'value') || !['E2', 'E3'].includes(claimed.class) || typeof claimed.source !== 'string' || !claimed.source) invalid([{ key: `confirmed.${field}`, message: 'must include value, E2/E3 class, and source' }]);
    const verified = evidenceFor(files, field, claimed);
    if (!verified) throw new ApiError(422, 'evidence_not_verified', `Confirmed ${field} could not be re-derived from the submitted paths`);
    result[field] = verified;
  }
  return result;
}
function normalizeQueued(group) {
  if (group.queued == null) return []; if (!Array.isArray(group.queued)) invalid([{ key: 'queued', message: 'must be an array' }]);
  return group.queued.map((item, i) => {
    if (!item || typeof item !== 'object' || !own(item, 'field') || !own(item, 'candidate_value') || typeof item.reason !== 'string' || !own(item, 'evidence_seen')) invalid([{ key: `queued[${i}]`, message: 'must include field, candidate_value, reason, and evidence_seen' }]);
    return { field: item.field, candidate_value: item.candidate_value, reason: item.reason, evidence_seen: item.evidence_seen };
  });
}

export async function analyze(body) {
  const value = ensureObject(body, 'body');
  if (!Array.isArray(value.files)) invalid([{ key: 'files', message: 'must be an array' }]);
  const files = value.files.map((file, i) => { const item = ensureObject(file, `files[${i}]`); if (typeof item.path !== 'string' || !item.path.trim()) invalid([{ key: `files[${i}].path`, message: 'must be a non-empty string' }]); if (!Number.isInteger(item.size_bytes) || item.size_bytes < 0) invalid([{ key: `files[${i}].size_bytes`, message: 'must be an integer >= 0' }]); if (item.sha256 != null && (typeof item.sha256 !== 'string' || !SHA256.test(item.sha256))) invalid([{ key: `files[${i}].sha256`, message: 'must be 64 hexadecimal characters' }]); return { path: item.path, size_bytes: item.size_bytes, ...(item.sha256 ? { sha256: item.sha256 } : {}) }; });
  const groups = proposeGroups(files); return { status: 200, body: { groups, totals: count(groups), warnings: [] } };
}

export async function commit(body, principal) {
  const value = ensureObject(body, 'body');
  if (typeof value.sample_id !== 'string' || !value.sample_id.trim()) invalid([{ key: 'sample_id', message: 'must be a non-empty string' }]);
  if (!Array.isArray(value.groups) || !value.groups.length) invalid([{ key: 'groups', message: 'must be a non-empty array' }]);
  const sample = await sampleFor(value.sample_id); const measurements = []; let reviewQueued = 0;
  for (const group of value.groups) {
    ensureObject(group, 'group'); if (typeof group.key !== 'string' || !group.key) invalid([{ key: 'groups.key', message: 'must be a non-empty string' }]);
    const files = normalizeFiles(group.files); const confirmed = normalizeConfirmed(group, files); const queued = normalizeQueued(group);
    const fields = Object.fromEntries(Object.entries(confirmed).map(([field, evidence]) => [field, evidence.value]));
    const evidence = Object.fromEntries(Object.entries(confirmed).map(([field, item]) => [field, { class: item.class, source: item.source }]));
    const split = await validateEntity('measurement', { ...fields, evidence, ...(queued.length ? { review_needed: true } : {}), meta_status: Object.fromEntries(Object.keys(confirmed).map((field) => [field, 'confirmed'])) });
    if (!valueEqual(split.meta?.evidence, evidence)) invalid([{ key: 'evidence', message: 'must be a configured measurement metadata field' }]);
    if (queued.length && split.meta?.review_needed !== true) invalid([{ key: 'review_needed', message: 'must be a configured measurement metadata field' }]);
    const meta = { ...(split.meta || {}) };
    const metaStatus = { ...(split.meta_status || {}) };
    const payload = { ...(split.columns || {}), sample_id: sample.id, run_numbers: split.columns?.run_numbers ?? [], meta, meta_status: metaStatus, created_by: actorFor(value, principal) };
    delete payload.run_numbers; payload.run_numbers = split.columns?.run_numbers ?? [];
    const measurement = await one(db().from('measurements').insert(payload).select().single());
    if (queued.length) { const rows = queued.map((item) => ({ entity: 'measurement', entity_id: measurement.id, ...item, created_by: actorFor(value, principal) })); await one(db().from('review_queue').insert(rows).select()); reviewQueued += rows.length; }
    const uploads = [];
    for (const file of files) {
      const existing = await one(db().from('files').select('id').eq('measurement_id', measurement.id).eq('sha256', file.sha256).maybeSingle());
      if (existing) { uploads.push({ path: file.path, file_id: existing.id, upload_url: `/api/files/${existing.id}/content`, already_attached: true }); continue; }
      const storage_path = await uniquePath(sample, measurement.id, filenameFor(file.path));
      const row = { measurement_id: measurement.id, storage_path, bucket: 'vault', original_name: filenameFor(file.path), kind: kindFromExtension(file.path), size_bytes: file.size_bytes, sha256: file.sha256, parsed: {}, upload_state: 'pending', created_by: actorFor(value, principal) };
      let created;
      try { created = await one(db().from('files').insert(row).select().single()); } catch (error) { if (error?.code === '23505') { const duplicate = await one(db().from('files').select('id').eq('measurement_id', measurement.id).eq('sha256', file.sha256).maybeSingle()); if (duplicate) { uploads.push({ path: file.path, file_id: duplicate.id, upload_url: `/api/files/${duplicate.id}/content`, already_attached: true }); continue; } } throw error; }
      uploads.push({ path: file.path, file_id: created.id, upload_url: `/api/files/${created.id}/content` });
    }
    measurements.push({ key: group.key, measurement_id: measurement.id, uploads });
  }
  return { status: 201, body: { measurements, review_queued: reviewQueued, warnings: [] } };
}

import { createHash } from 'node:crypto';
import { supabaseAdmin } from '../supabaseAdmin.js';
import { ApiError, dbError } from '../respond.js';
import { pickAllowed, requireString, requireUuid } from '../validate.js';
import { buildStoragePath, deleteObject, getObject, headObject, kindFromExtension, parseFilename, putObject } from '../storage.js';

const SHA256 = /^[0-9a-f]{64}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const db = () => supabaseAdmin();
const one = async (query) => { const { data, error } = await query; if (error) throw dbError(error); return data; };
const duplicate = (file) => new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement', { file_id: file.id, original_name: file.original_name });
const actorFor = (body, principal) => principal?.kind === 'human' ? principal.actor : body?.created_by ?? principal?.actor ?? 'api';
async function assertAdmin(principal) { if (principal?.kind !== 'human') return; const { data, error } = await db().from('people').select('role').eq('email', principal.actor).maybeSingle(); if (error) throw dbError(error); if (data?.role !== 'admin') throw new ApiError(403, 'unauthorized', 'Admin role required'); }
const storageError = (error, message) => { if (error?.status === 409) throw new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement'); throw new ApiError(500, 'storage_error', error?.message || message); };

function validateUpload(body, { inline = false } = {}) {
  const allowed = inline ? ['measurement_id', 'filename', 'content_base64', 'kind', 'created_by'] : ['measurement_id', 'filename', 'size_bytes', 'sha256', 'kind', 'created_by'];
  const warnings = [];
  const value = pickAllowed(body, allowed, warnings);
  requireUuid(value.measurement_id, 'measurement_id'); requireString(value.filename, 'filename');
  const details = [];
  if (!inline && (!Number.isInteger(value.size_bytes) || value.size_bytes < 0)) details.push({ key: 'size_bytes', message: 'must be an integer >= 0' });
  if (!inline && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))) details.push({ key: 'sha256', message: 'must be 64 hexadecimal characters' });
  if (inline && (typeof value.content_base64 !== 'string' || !value.content_base64)) details.push({ key: 'content_base64', message: 'must be a non-empty base64 string' });
  if (details.length) throw new ApiError(422, 'validation_failed', 'Validation failed', details); return { value, warnings };
}
function validateRegister(body) {
  const warnings = [];
  const value = pickAllowed(body, ['size_bytes', 'sha256', 'parsed'], warnings);
  const details = [];
  if (Object.prototype.hasOwnProperty.call(value, 'size_bytes') && (!Number.isInteger(value.size_bytes) || value.size_bytes < 0)) details.push({ key: 'size_bytes', message: 'must be an integer >= 0' });
  if (Object.prototype.hasOwnProperty.call(value, 'sha256') && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256))) details.push({ key: 'sha256', message: 'must be 64 hexadecimal characters' });
  if (Object.prototype.hasOwnProperty.call(value, 'parsed') && (!value.parsed || typeof value.parsed !== 'object' || Array.isArray(value.parsed))) details.push({ key: 'parsed', message: 'must be an object' });
  if (details.length) throw new ApiError(422, 'validation_failed', 'Validation failed', details);
  return { value, warnings };
}
async function measurementWithSample(measurementId) {
  const { data, error } = await db().from('measurements').select('id, sample_id, samples!inner(sample_id)').eq('id', measurementId).maybeSingle();
  if (error) throw dbError(error); if (!data) throw new ApiError(404, 'not_found', 'Measurement not found');
  const sample = Array.isArray(data.samples) ? data.samples[0] : data.samples;
  if (!sample?.sample_id) throw new ApiError(404, 'not_found', 'Sample not found'); return { measurement: data, sample };
}
async function uniquePath(sampleId, measurementId, filename) {
  for (let n = 1; n <= 20; n += 1) {
    const adjusted = n === 1 ? filename : (() => { const i = filename.lastIndexOf('.'); return i > 0 ? `${filename.slice(0, i)}-${n}${filename.slice(i)}` : `${filename}-${n}`; })();
    const path = buildStoragePath(sampleId, measurementId, adjusted);
    const { data, error } = await db().from('files').select('id').eq('bucket', 'vault').eq('storage_path', path).maybeSingle(); if (error) throw dbError(error); if (!data) return path;
  } throw new ApiError(409, 'duplicate_file', 'Could not find a unique storage path');
}
async function prepareRow(value, sha256, sizeBytes, state, principal) {
  const { measurement, sample } = await measurementWithSample(value.measurement_id);
  const existing = await one(db().from('files').select('id, original_name').eq('measurement_id', measurement.id).eq('sha256', sha256).maybeSingle()); if (existing) throw duplicate(existing);
  const storage_path = await uniquePath(sample.sample_id, measurement.id, value.filename);
  return { row: { measurement_id: measurement.id, storage_path, bucket: 'vault', original_name: value.filename, kind: value.kind ?? kindFromExtension(value.filename), size_bytes: sizeBytes, sha256, parsed: state === 'ready' ? parseFilename(value.filename) : {}, upload_state: state, created_by: actorFor(value, principal) } };
}
const isUnique = (error) => error?.code === '23505' || (error?.status === 409 && error?.code === 'conflict');
const mimeFor = (filename) => ({ xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel', csv: 'text/csv', png: 'image/png' })[filename.toLowerCase().split('.').pop()] || 'application/octet-stream';

export async function uploadUrl(body, principal) {
  const { value, warnings } = validateUpload(body); const { row } = await prepareRow(value, value.sha256, value.size_bytes, 'pending', principal); let file;
  try { file = await one(db().from('files').insert(row).select().single()); } catch (error) { if (isUnique(error)) throw new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement'); throw error; }
  return { status: 201, body: { file_id: file.id, storage_path: file.storage_path, upload_url: `/api/files/${file.id}/content`, method: 'PUT', ...(warnings.length ? { warnings } : {}) } };
}
export async function putContent(id, req, principal) {
  requireUuid(id); const file = await one(db().from('files').select().eq('id', id).maybeSingle()); if (!file) throw new ApiError(404, 'not_found', 'File not found'); if (file.bucket === 'bench') throw new ApiError(403, 'unauthorized', 'Bench files are read-only');
  const contentType = Array.isArray(req?.headers?.['content-type']) ? req.headers['content-type'][0] : req?.headers?.['content-type'] || mimeFor(file.original_name);
  try { await putObject(file.storage_path, req?.rawStream, contentType, file.bucket ?? 'vault'); } catch (error) { storageError(error, 'Could not upload file'); }
  const changes = { upload_state: 'ready', parsed: parseFilename(file.original_name) }; if (principal) changes.updated_by = actorFor({}, principal); let updated; try { updated = await one(db().from('files').update(changes).eq('id', id).select().single()); } catch (error) { if (isUnique(error)) throw new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement'); throw error; }
  return { status: 200, body: { file: updated } };
}
export async function register(id, body = {}, principal) {
  requireUuid(id); const { value, warnings } = validateRegister(body); const file = await one(db().from('files').select().eq('id', id).maybeSingle()); if (!file) throw new ApiError(404, 'not_found', 'File not found');
  if (file.upload_state === 'ready') return { status: 200, body: { file, warnings: [...warnings, 'already registered'] } };
  let exists; try { exists = await headObject(file.storage_path, file.bucket ?? 'vault'); } catch (error) { storageError(error, 'Could not inspect upload'); }
  if (!exists) { const changes = { upload_state: 'failed' }; if (principal) changes.updated_by = actorFor({}, principal); await one(db().from('files').update(changes).eq('id', id).select().single()); throw new ApiError(422, 'upload_missing', 'no object at storage_path; PUT the bytes first'); }
  const parsed = value.parsed ?? {};
  const changes = { parsed: { ...parseFilename(file.original_name), ...parsed }, upload_state: 'ready' }; if (principal) changes.updated_by = actorFor({}, principal);
  if (Number.isInteger(value.size_bytes) && value.size_bytes >= 0) changes.size_bytes = value.size_bytes;
  if (typeof value.sha256 === 'string' && SHA256.test(value.sha256)) changes.sha256 = value.sha256;
  let updated; try { updated = await one(db().from('files').update(changes).eq('id', id).select().single()); } catch (error) { if (isUnique(error)) throw new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement'); throw error; }
  return { status: 200, body: { file: updated, ...(warnings.length ? { warnings } : {}) } };
}
export async function createInline(body, principal) {
  const { value, warnings } = validateUpload(body, { inline: true }); if (!BASE64.test(value.content_base64) || value.content_base64.length % 4 !== 0) throw new ApiError(422, 'invalid_input', 'content_base64 must be valid base64'); let bytes; try { bytes = Buffer.from(value.content_base64, 'base64'); } catch { throw new ApiError(422, 'invalid_input', 'content_base64 must be valid base64'); }
  if (bytes.length > 50 * 1024 * 1024) throw new ApiError(413, 'payload_too_large', 'Inline uploads are limited to 50 MB'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const { row } = await prepareRow(value, sha256, bytes.length, 'ready', principal);
  try { await putObject(row.storage_path, bytes, mimeFor(value.filename), row.bucket); } catch (error) { storageError(error, 'Could not upload file'); }
  try { const file = await one(db().from('files').insert(row).select().single()); return { status: 201, body: { file, ...(warnings.length ? { warnings } : {}) } }; } catch (error) { if (isUnique(error)) throw new ApiError(409, 'duplicate_file', 'A file with this sha256 already exists for this measurement'); throw error; }
}
export async function getContent(id) { requireUuid(id); const file = await one(db().from('files').select().eq('id', id).maybeSingle()); if (!file) throw new ApiError(404, 'not_found', 'File not found'); if (file.upload_state !== 'ready') throw new ApiError(409, 'not_ready', 'File upload is not ready'); try { const object = await getObject(file.storage_path, file.bucket ?? 'vault'); return { stream: object.body, contentType: object.contentType || mimeFor(file.original_name), filename: file.original_name, size: object.size ?? file.size_bytes }; } catch (error) { storageError(error, 'Could not download file'); } }
export async function download(id) { requireUuid(id); const file = await one(db().from('files').select().eq('id', id).maybeSingle()); if (!file) throw new ApiError(404, 'not_found', 'File not found'); if (file.upload_state !== 'ready') throw new ApiError(409, 'not_ready', 'File upload is not ready'); return { status: 200, body: { url: `/api/files/${id}/content`, expires_at: null } }; }
export async function remove(id, principal) { await assertAdmin(principal); requireUuid(id); const file = await one(db().from('files').select().eq('id', id).maybeSingle()); if (!file) throw new ApiError(404, 'not_found', 'File not found'); if (file.bucket === 'bench') throw new ApiError(403, 'unauthorized', 'Bench files are read-only'); const warnings = []; try { await deleteObject(file.storage_path, file.bucket ?? 'vault'); } catch (error) { if (error?.status !== 404) warnings.push(error?.message || 'Could not remove storage object'); } await one(db().from('files').delete().eq('id', id).select().single()); return { status: 200, body: { deleted: true, id, ...(warnings.length ? { warnings } : {}) } }; }

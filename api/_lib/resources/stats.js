import { supabaseAdmin } from '../supabaseAdmin.js';
import { dbError } from '../respond.js';

async function countRows(sb, table) {
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true });
  if (error) throw dbError(error);
  return count ?? 0;
}

export async function get(query = {}) {
  const sb = supabaseAdmin();
  const [samples, measurements, files] = await Promise.all([countRows(sb, 'samples'), countRows(sb, 'measurements'), countRows(sb, 'files')]);
  const { data: sizes, error: e1 } = await sb.from('files').select('size_bytes');
  if (e1) throw dbError(e1);
  const bytes = (sizes || []).reduce((a, r) => a + (Number(r.size_bytes) || 0), 0);
  const { data: kinds, error: e2 } = await sb.from('measurements').select('kind');
  if (e2) throw dbError(e2);
  const by_kind = (kinds || []).reduce((a, r) => { const k = r.kind || 'unknown'; a[k] = (a[k] || 0) + 1; return a; }, {});
  const { data: rows, error: e3 } = await sb.from('measurements').select('id, sample_id, measured_on, kind, samples!inner(sample_id)').order('created_at', { ascending: false }).limit(10);
  if (e3) throw dbError(e3);
  const recent = (rows || []).map(({ id, sample_id: sample_uuid, measured_on, kind, samples }) => { const sample = Array.isArray(samples) ? samples[0] : samples; return { measurement_id: id, sample_id: sample?.sample_id, sample_uuid, measured_on, kind }; });
  return { status: 200, body: { samples, measurements, files, bytes, by_kind, recent } };
}

// Keep numeric JSONB scalars as JSONB so PostgreSQL compares their numeric values, not extracted text.
export function applyEntityFilters(q, entity, query = {}, defs = []) {
  const by = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('meta.')) continue;
    const [, field, bound] = key.split('.'); const def = by.get(field); const numeric = ['number', 'integer'].includes(def?.type);
    if (!def) continue;
    if (def.column_name) q = bound === 'min' ? q.gte(def.column_name, value) : bound === 'max' ? q.lte(def.column_name, value) : q.eq(def.column_name, value);
    else if (bound === 'min') q = q.gte(`meta${numeric ? '->' : '->>'}${field}`, numeric ? Number(value) : value);
    else if (bound === 'max') q = q.lte(`meta${numeric ? '->' : '->>'}${field}`, numeric ? Number(value) : value);
    else { let coerced = value; if (numeric) coerced = Number(value); else if (def.type === 'bool') coerced = value === 'true'; q = q.contains('meta', { [field]: coerced }); }
  }
  if (query.q) q = entity === 'sample' ? q.or(`sample_id.ilike.*${query.q}*,label.ilike.*${query.q}*`) : q.ilike('device_address', `*${query.q}*`);
  if (query.from) q = q.gte('measured_on', query.from);
  if (query.to) q = q.lte('measured_on', query.to);
  return q;
}
export function applySort(q, spec, warnings = []) { if (!spec) return q; if (spec.metaKey && ['number', 'integer'].includes(spec.cast)) warnings.push('sorting a JSONB number sorts as text until the field is promoted'); return q.order(spec.column || `meta->>${spec.metaKey}`, { ascending: spec.ascending, nullsFirst: false }); }

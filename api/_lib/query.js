// Keep numeric JSONB scalars as JSONB so PostgreSQL compares their numeric values, not extracted text.
// A user search term goes into a PostgREST filter STRING, not a bound parameter, so its
// structural characters have to go. `or=(a.ilike.*X*,b.ilike.*X*)` is parsed by PostgREST, and a
// comma or paren inside X closes the condition and opens another: `?q=a,id.not.is.null` widens
// the OR to every row in the table. The blast radius is bounded -- an OR can only widen a filter
// the caller could have omitted entirely, on a table they can already list, with no write and no
// join -- which is exactly why it would sit unnoticed. Strip rather than reject: someone
// searching for "20nm (batch 3)" typed a paren innocently, and a 400 for a plausible search term
// teaches people the search is broken.
export const likeTerm = (value) => String(value).replace(/[,().:*\\]/g, ' ').trim();

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
  if (query.q) { const term = likeTerm(query.q); if (term) q = entity === 'sample' ? q.or(`sample_id.ilike.*${term}*,label.ilike.*${term}*`) : q.ilike('device_address', `*${term}*`); }
  if (query.from) q = q.gte('measured_on', query.from);
  if (query.to) q = q.lte('measured_on', query.to);
  return q;
}
export function applySort(q, spec, warnings = []) { if (!spec) return q; if (spec.metaKey && ['number', 'integer'].includes(spec.cast)) warnings.push('sorting a JSONB number sorts as text until the field is promoted'); return q.order(spec.column || `meta->>${spec.metaKey}`, { ascending: spec.ascending, nullsFirst: false }); }

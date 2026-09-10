import { supabaseAdmin } from '../supabaseAdmin.js';
import { dbError } from '../respond.js';

export async function list(query = {}, principal) {
  // These registries must arrive together: resolving against a partial registry silently
  // treats unknown columns as axis defaults, recreating the unit mismatch this route prevents.
  const [kinds, units, columnUnits] = await Promise.all([
    supabaseAdmin().from('measurement_kinds').select('*').order('kind'),
    supabaseAdmin().from('units').select('*').order('unit'),
    supabaseAdmin().from('column_units').select('*').order('column_name'),
  ]);
  if (kinds.error) throw dbError(kinds.error);
  if (units.error) throw dbError(units.error);
  if (columnUnits.error) throw dbError(columnUnits.error);
  return { status: 200, body: { items: kinds.data || [], units: units.data || [], column_units: columnUnits.data || [] } };
}

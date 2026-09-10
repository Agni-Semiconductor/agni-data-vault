import { supabaseAdmin } from './supabaseAdmin.js';

// A REAL health check, not a bare 200.
//
// The loudest silent failure in this stack is a service role provisioned without BYPASSRLS.
// Every `vault` table has RLS enabled with no policies, so without BYPASSRLS PostgREST
// returns an empty array for every table, this API reports success, and the vault looks
// EMPTY rather than looking unauthorised. Nothing errors anywhere. Verified against a real
// Postgres 17.10 on 2026-09-10: a role with full grants but no BYPASSRLS returns `[]` and no
// error at all.
//
// So the check reads a row it KNOWS exists. `field_definitions` is seeded with 26 rows by
// migration 0104 and is never legitimately empty in a working deployment, which makes "zero
// rows" a positive signal of the failure rather than an ambiguous one.
//
// Deliberately unauthenticated, and called BEFORE requireAuth: monitoring runs from the Pi
// and from GitHub Actions, neither of which should need the API key to answer "is it up".
// It therefore leaks only whether the service can see its own schema -- no row contents.
export async function health() {
  const started = Date.now();
  const checks = {};
  let ok = true;

  try {
    const { data, error, count } = await supabaseAdmin()
      .from('field_definitions')
      .select('id', { count: 'exact', head: false })
      .limit(1);
    if (error) { checks.database = { ok: false, error: error.message }; ok = false; }
    else if (!data || data.length === 0) {
      // The BYPASSRLS case, and the reason this endpoint exists at all.
      checks.database = { ok: false, error: 'field_definitions returned no rows; expected seeded data. Check that the service role has BYPASSRLS.' };
      ok = false;
    } else {
      checks.database = { ok: true, field_definitions: count ?? null };
    }
  } catch (err) {
    checks.database = { ok: false, error: err?.message || String(err) };
    ok = false;
  }

  checks.duration_ms = Date.now() - started;
  return { ok, checks };
}

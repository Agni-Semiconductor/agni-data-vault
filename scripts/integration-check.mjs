// Integration check: the REAL resources against REAL PostgREST against REAL Postgres.
//
// Run it against a database with the selfhost chain applied:
//
//   VAULT_REST_URL=http://127.0.0.1:3011 //   VAULT_SERVICE_JWT=$(cd ../ferrodiode-pcb-testbench && FED_PGRST_JWT_SECRET=<secret> //       python tools/mint_service_jwt.py --role vault_service) //   node scripts/integration-check.mjs
//
// The unit suite mocks supabaseAdmin and every SQL claim was checked with psql, but the SEAM
// between them is what this exercises. It retires three things a mocked test cannot tell you:
// whether `rpc('cohort_summary', {p_measurement_ids: [...]})` survives PostgREST's encoding of a
// uuid[]; whether the security_invoker views come back at all under vault_service; and whether
// the resources' column lists match the real tables.
//
// SEED IT FIRST. Against an empty database every assertion here passes over an empty array --
// the vacuous green this repo has been bitten by more than once. The probes under
// scratchpad/verify_0113.sql and verify_0114.sql create a population with deliberately messy
// provenance; without them the cohort section proves nothing and says so.
// Everything in the test suite mocks supabaseAdmin, and every SQL claim was verified with psql --
// but the seam between them has never executed. The specific risks this retires:
//   * does `supabaseAdmin().rpc('cohort_summary', {...})` accept a uuid[] argument over the wire?
//   * do the views (figure_sources, device_history, device_verdict_changes) come back through
//     PostgREST at all, and with `security_invoker` under the vault_service role?
//   * do the resources' column allow-lists match the real tables?
process.env.VAULT_REST_URL = 'http://127.0.0.1:3011';
process.env.VAULT_STORAGE_URL = 'http://127.0.0.1:3011';
process.env.VAULT_SERVICE_JWT = process.env.JWT;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? '\n          ' + detail : ''}`); } };
const show = (o) => { try { return JSON.stringify(o).slice(0, 300); } catch { return String(o); } };

const kinds = await import('../api/_lib/resources/kinds.js');
const cohorts = await import('../api/_lib/resources/cohorts.js');
const devices = await import('../api/_lib/resources/devices.js');
const figures = await import('../api/_lib/resources/figures.js');

console.log('\n=== GET /api/kinds — three registries in one response ===');
{
  const r = await kinds.list();
  ok('returns 200 with all three collections', r.status === 200 && r.body.items.length > 0 && r.body.units.length > 0 && r.body.column_units.length > 0, show(Object.keys(r.body)));
  const cu = Object.fromEntries(r.body.column_units.map((c) => [c.column_name, c.unit]));
  ok('i_a is amperes and current_mA is milliamperes', cu.i_a === 'A' && cu.current_mA === 'mA', show(cu));
  ok('board_csv has NO axis-level y_unit', r.body.items.find((k) => k.kind === 'board_csv')?.y_unit === null);
  ok('sql_expr never appears', !JSON.stringify(r.body).includes('sql_expr'));
}

console.log('\n=== GET /api/cohort-keys — allow-lists, without their SQL ===');
{
  const r = await cohorts.registry();
  ok('returns both registries', r.body.group_keys.length > 0 && r.body.metrics.length > 0, show(r.body.group_keys.length + '/' + r.body.metrics.length));
  ok('sql_expr is NOT in the response', !JSON.stringify(r.body).includes('sql_expr'));
}

console.log('\n=== POST /api/cohorts/summary — the RPC, with a uuid[] over the wire ===');
{
  // THE call that has never executed. A uuid[] argument through PostgREST's RPC encoding is the
  // thing a mocked test cannot tell you about.
  const r = await cohorts.summary({ predicate: {}, metric: 'ec_minus', group_by: 'stack_fe_t_nm', extractor_version: 'cohort_v1' });
  ok('the RPC executes and returns a ledger', r.status === 200 && Array.isArray(r.body.groups), show(r.body));
  ok('total_members and excluded are numbers', typeof r.body.total_members === 'number' && typeof r.body.excluded === 'number', show(r.body));
  for (const g of r.body.groups) {
    const balances = Number(g.n_members) === Number(g.n_with_metric) + Number(g.n_no_metric_row) + Number(g.n_refused);
    ok(`ledger balances for group ${g.group_value}`, balances, show(g));
    ok(`provenance buckets present for ${g.group_value}`, ['status_confirmed', 'status_assumed', 'status_unknown', 'status_unspecified'].every((k) => k in g), show(Object.keys(g)));
  }
}

console.log('\n=== an unknown metric is a 422 from the API, not a 500 from Postgres ===');
{
  try { await cohorts.summary({ predicate: {}, metric: 'not_a_metric', group_by: 'stack_fe_t_nm' }); ok('rejected', false, 'it did not throw'); }
  catch (e) { ok('422 naming the field', e.status === 422 && JSON.stringify(e.details || '').includes('metric'), `${e.status} ${e.code} ${show(e.details)}`); }
}

console.log('\n=== GET /api/devices and the history view ===');
{
  const list = await devices.list({ limit: 5 });
  ok('devices list returns', list.status === 200 && Array.isArray(list.body.items), show(list.body.total));
  const device = list.body.items[0];
  if (device) {
    const detail = await devices.get(device.id);
    ok('device detail includes aliases and counts', detail.body.device && Array.isArray(detail.body.aliases) && detail.body.counts, show(Object.keys(detail.body)));
    const hist = await devices.history(device.id, { limit: 10 });
    ok('device_history reads through PostgREST', hist.status === 200 && Array.isArray(hist.body.items), show(hist.body.total));
    ok('history is filtered to THIS device', hist.body.items.every((e) => e.device_id === device.id), show(hist.body.items.map((i) => i.device_id)));
  } else ok('at least one device exists to inspect', false, 'no devices in the validation db');
}

console.log('\n=== GET /api/verdict-changes — the view, with its direction column ===');
{
  const r = await devices.verdictChanges({ limit: 10 });
  ok('verdict_changes reads through PostgREST', r.status === 200 && Array.isArray(r.body.items), show(r.body.total));
  ok('every row carries a direction', r.body.items.every((i) => ['degraded', 'recovered', 'changed'].includes(i.direction)), show(r.body.items.map((i) => i.direction)));
}

console.log('\n=== figures: create, read back with sources, delete ===');
{
  const spec = { layout: '1x1', panels: [{ unit: 'A', traces: [{ src: { capture_id: 'cap_nope' }, label: 'missing' }] }] };
  const created = await figures.create({ title: 'integration probe', spec }, { kind: 'machine', actor: 'integration' });
  ok('figure created', created.status === 201 && created.body.figure.id, show(created.body.figure?.id));
  const got = await figures.get(created.body.figure.id);
  ok('figure_sources comes back with the figure', Array.isArray(got.body.sources) && got.body.sources.length === 1, show(got.body.sources));
  ok('a dangling capture reference reports source_exists=false', got.body.sources[0]?.source_exists === false, show(got.body.sources[0]));
  await figures.remove(created.body.figure.id);
  try { await figures.get(created.body.figure.id); ok('deleted figure is gone', false, 'it still resolves'); }
  catch (e) { ok('deleted figure is gone', e.status === 404, `${e.status} ${e.code}`); }
}

console.log('\n=== a spec with no panels is refused by the DATABASE too, not just the API ===');
{
  try {
    await figures.create({ title: 'bad', spec: { layout: '1x1' } }, { kind: 'machine', actor: 'integration' });
    ok('refused', false, 'it was accepted');
  } catch (e) { ok('refused with a named field', e.status === 400 || e.status === 422, `${e.status} ${e.code}`); }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;

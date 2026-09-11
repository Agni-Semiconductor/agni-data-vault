-- The `connect` schema: the read interface a SECOND PRODUCT consumes, and the only part of this
-- database that is promised to anybody outside this repo.
--
-- WHY A SCHEMA OF VIEWS RATHER THAN GRANTS ON `vault`.
-- A view is a contract; a table is an implementation. This schema has moved eighteen migrations
-- in a few weeks -- columns promoted out of `meta`, `files` gaining a `bucket`, `measurements`
-- gaining a device and a bench run. Handing another team `vault.measurements` makes every one of
-- those a breaking change for a codebase this repo cannot see and cannot test. Handing them
-- `connect.measurements` makes the same refactors free: the view absorbs them.
--
-- THIS IS THE ONE PLACE `security_invoker` IS DELIBERATELY OFF, and that needs saying loudly
-- because every other view here sets it ON. The reason the rest do is that a view running as its
-- owner punches through the RLS-enabled-no-policies invariant by accident. Here, running as the
-- owner is the ENTIRE POINT and it is the reviewed, intended act: it is what lets `connect_read`
-- hold **no grant on `vault` or `public` at all** and still read these seven objects. Get it
-- backwards -- security_invoker on -- and the only way to make this work is to grant a second
-- product SELECT across the vault's base tables, which is the thing this file exists to avoid.
--
-- Consequences worth being explicit about, because they are the ones that bite later:
--   * `connect_read` does NOT need BYPASSRLS. `vault_read` does -- RLS with no policies returns
--     zero rows to anything without it -- and that makes `vault_read` a poor thing to hand out.
--     A role that needs no bypass is a role whose blast radius is exactly this column list.
--   * The views are plain projections with no function calls, so running them as the owner does
--     not hand anyone an execution path. Keep them that way. A function call inside one of these
--     views runs with the owner's rights.
--   * `notes` is excluded everywhere. It is operator free text -- the PII surface, and the one
--     field the search agent's threat model already treats as untrusted content. A devops tool
--     tracking artefacts and checksums has no use for it.
--   * `created_by` / `updated_by` are excluded. They are audit fields carrying human identity.
--     `measured_by` IS exposed: it is a declared field with an option list, and attributing a
--     measurement to a person is the point of it.
--   * `vault.people`, `vault.allowlist`, `vault.audit_log` and `vault.agent_queries` are not
--     reachable from this schema by any path. That is deliberate and should stay true.
begin;
set local search_path = vault, extensions;

create schema if not exists connect;
comment on schema connect is
  'The read interface for other products on this cluster (agni-connect). Views only, no tables. '
  'Everything here is a promised shape; nothing in vault or public is. Columns may be ADDED '
  'without notice and are never removed or retyped without telling the consumer first.';

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------
-- Cluster-wide, like every role 0100 creates. NOLOGIN: PostgREST reaches it with SET ROLE from a
-- JWT `role` claim, never by connecting as it, so a password on this role would be a credential
-- that exists for no reason.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'connect_read') then
    create role connect_read nologin;
  end if;
end $$;

comment on role connect_read is
  'Read-only interface role for other products. Holds USAGE on schema connect and SELECT on its '
  'views, and NOTHING on vault or public -- verify with the probe in scratchpad/verify_0118.sql '
  'rather than by reading this comment.';

-- PostgREST switches to this role from the JWT, so the connecting role must be able to become it.
grant connect_read to authenticator;

-- ---------------------------------------------------------------------------
-- 2. The interface
-- ---------------------------------------------------------------------------
-- DROPPED AND RECREATED, not `create or replace`. Replace cannot rename or remove a column --
-- it fails with "cannot change name of view column" -- so a migration that only ever replaces
-- quietly stops being editable the moment an interface column needs a better name. Dropping
-- first is what keeps this file the description of the interface rather than a description of
-- the interface's first draft.
--
-- Reverse dependency order: health reads the other six.
drop view if exists connect.health;
drop view if exists connect.kinds;
drop view if exists connect.bench_runs;
drop view if exists connect.metrics;
drop view if exists connect.files;
drop view if exists connect.measurements;
drop view if exists connect.samples;


-- Samples. The registry key `sample_id` is the text humans and other systems use; `id` is the
-- uuid every foreign key uses. Both travel, because a consumer joining on the wrong one gets an
-- empty result rather than an error.
create or replace view connect.samples as
select s.id,
       s.sample_id,
       s.label,
       s.family,
       s.substrate,
       s.substrate_size,
       s.fab_location,
       s.fabricated_by,
       s.fabricated_on,
       s.stack,
       s.stack_fe_material,
       s.stack_fe_t_nm,
       s.meta_status,
       s.created_at,
       s.updated_at
  from vault.samples s;

-- Measurements. `meta_status` travels WHOLE rather than as a completeness score, because the
-- score is this repo's opinion and the raw {key: confirmed|assumed|unknown} map is the fact. A
-- consumer that wants to trust only confirmed values can then do so without asking us to add a
-- column.
create or replace view connect.measurements as
select m.id,
       m.sample_id,
       s.sample_id as sample_key,
       m.measured_on,
       m.kind,
       m.instrument,
       m.probe_station,
       m.measured_by,
       m.temperature_c,
       m.device_address,
       m.device_id,
       m.pad_shape,
       m.pad_dim_um,
       m.pad_area_um2,
       m.run_numbers,
       m.bench_dut_id,
       m.bench_run_id,
       m.meta_status,
       m.created_at,
       m.updated_at
  from vault.measurements m
  join vault.samples s on s.id = m.sample_id;

-- Files. THIS IS THE ONE agni-connect's spec actually describes: its MEAS records are a raw-data
-- path with a checksum and the rows derived from it. `sha256`, `bucket` and `storage_path` are
-- that record, and they are stable identifiers rather than URLs -- a URL would bake this
-- deployment's hostname into another product's database.
--
-- `upload_state` is exposed and matters: a row can exist in `pending` or `failed` from an
-- abandoned upload, and a consumer treating every row as a retrievable object will eventually
-- ask for bytes that were never stored.
create or replace view connect.files as
select f.id,
       f.measurement_id,
       f.original_name,
       f.kind,
       f.bucket,
       f.storage_path,
       f.sha256,
       f.size_bytes,
       f.upload_state,
       f.parsed,
       f.created_at
  from vault.files f;

-- Derived metrics. `extractor_version` and `skipped` travel because a metric without its version
-- is not reproducible and a refusal is not the same as an absence -- the distinction the cohort
-- ledger is built on.
create or replace view connect.metrics as
select mm.id,
       mm.measurement_id,
       mm.file_id,
       mm.kind,
       mm.extractor_version,
       mm.onoff,
       mm.vread,
       mm.ec_plus,
       mm.ec_minus,
       mm.pr_uc_cm2,
       mm.psw,
       mm.qsw,
       mm.i_max_a,
       mm.j_max_a_cm2,
       mm.r_low_bias_ohm,
       mm.noise_floor_a,
       mm.n_points,
       mm.n_cycles,
       mm.skipped,
       mm.computed_at
  from vault.measurement_metrics mm;

-- Bench campaigns. Cell counts are COUNTED from device_tests, never read from
-- campaign_runs.n_measured -- those roll-ups are written at the END of a run, so a live campaign
-- reports 0 with tens of thousands of child rows. tools/bench_source.py learned that the hard way
-- and a second product would learn it again.
create or replace view connect.bench_runs as
select r.run_id,
       r.dut_id,
       r.name,
       r.kind,
       r.status,
       r.operator,
       r.instrument,
       r.module_sha256,
       r.config_sha256,
       r.board_config,
       r.n_planned,
       (select count(*) from public.device_tests t where t.run_id = r.run_id) as n_cells_recorded,
       r.started_at,
       r.completed_at,
       r.created_at
  from public.campaign_runs r;

-- The kind registry, so a consumer labels an axis from data rather than from a constant it typed
-- out. `campaign_log.py` calls `current_mA` "the cautionary tale of a unit that lives only inside
-- a column name"; this is how a second product avoids writing the sequel.
create or replace view connect.kinds as
select k.kind,
       k.label,
       k.x_col,
       k.y_col,
       k.x_unit,
       k.y_unit,
       -- Renamed from `notes`. It is REGISTRY DOCUMENTATION ("Ec- is the median across drive
       -- cycles"), not the operator free text that `notes` means everywhere else in this
       -- database -- and a column called `notes` sitting in the interface invites a reader to
       -- conclude that operator text is exposed here. The probe bans the name outright so the
       -- rule needs no exception to remember.
       k.notes as description
  from vault.measurement_kinds k;

-- A liveness check that is a REAL check.
--
-- The loudest silent failure on this box is a role that cannot actually read: RLS is enabled with
-- no policies, so a grant mistake returns [] from every object and the consumer sees an empty
-- database rather than an error. A health endpoint answering 200 with `{"ok": true}` would report
-- perfect health in exactly that state. This counts rows THROUGH the same views the consumer
-- reads, so if the grants are wrong the numbers are zero and the wrongness is visible.
create or replace view connect.health as
select (select count(*) from connect.samples)      as n_samples,
       (select count(*) from connect.measurements) as n_measurements,
       (select count(*) from connect.files)        as n_files,
       (select count(*) from connect.metrics)      as n_metrics,
       (select count(*) from connect.bench_runs)   as n_bench_runs,
       now()                                       as observed_at;

-- ---------------------------------------------------------------------------
-- 3. Grants -- narrow, and then explicitly taken back
-- ---------------------------------------------------------------------------
-- 0102 runs `alter default privileges in schema vault ... to vault_service`, which is why a
-- narrow grant there is decorative and a REVOKE is required. That default applies to `vault`,
-- not to this schema, so it does not reach here -- but the same discipline does: state what is
-- taken away, do not rely on what was never given. A future `alter default privileges` aimed at
-- `connect` would otherwise silently make this interface writable.
revoke all on schema connect from public;
revoke all on all tables in schema connect from public;

grant usage on schema connect to connect_read, vault_service, vault_read;
grant select on all tables in schema connect to connect_read, vault_service, vault_read;

-- Views are not writable here and must not become so. A `create rule`/`instead of` trigger on any
-- of these would turn a read interface into a write path without touching a grant.
revoke insert, update, delete, truncate on all tables in schema connect from connect_read, vault_read, public;

-- No route out of the interface. connect_read holds nothing on the schemas the views read from,
-- which is what makes the view's column list the whole of its access rather than a suggestion.
revoke all on schema vault from connect_read;

-- `public` CANNOT be closed the same way, and writing `revoke ... from connect_read` here would
-- be a no-op dressed as protection -- the privilege arrives via the PUBLIC pseudo-role, which
-- Postgres grants USAGE on schema public to by default, so revoking from one role changes
-- nothing. Revoking it from PUBLIC would work and is NOT done here: that is a cluster-wide change
-- to the schema the BENCH lives in, and breaking the bench's own roles to tighten a second
-- product's is the wrong trade to make silently.
--
-- The control that actually holds is table-level: connect_read has no privilege on any table in
-- `public`, so schema usage buys it the ability to name objects it cannot read. The probe asserts
-- that dynamically over every table in both schemas rather than over a list, because a list stops
-- covering the tables added after it was written.
--
-- What this means for anyone adding a table to `public`: if you grant it to PUBLIC, connect_read
-- can read it. Grant to named roles.


commit;

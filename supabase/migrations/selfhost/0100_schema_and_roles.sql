-- WRAPPED IN A TRANSACTION, added 2026-09-11 after a real partial failure.
-- Applying this chain to edaserver stopped at `create extension pg_trgm` (contrib was not
-- installed). ON_ERROR_STOP aborted the file -- but without a transaction the statements BEFORE
-- the failure had already committed, so the database was left holding two schemas from a
-- migration the ledger correctly recorded as never applied. This file is idempotent, so that
-- particular case recovers on a re-run; the next file's failure might not. Postgres runs DDL
-- transactionally, so the fix costs nothing.
begin;

create schema if not exists vault;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is intentionally not installed.
do $$ begin create role vault_service nologin bypassrls; exception when duplicate_object then null; end $$;
-- vault_read gets BYPASSRLS too, and that is NOT a contradiction of 'read-only'.
--
-- Read-only-ness comes from the GRANTS: vault_read has select and nothing else (0102). RLS in
-- the vault schema is enabled with NO POLICIES, which is a fail-closed guard against a
-- mis-provisioned role rather than per-row filtering -- there are no per-row rules to enforce.
-- So a role with select grants and no BYPASSRLS lands in the worst middle state available: it
-- HAS permission and sees NOTHING, returning an empty array with no error. Verified on a real
-- PG 17.10 on 2026-09-10 -- vault_read could select from measurements_flat and got 0 rows
-- while vault_service got 10. That is precisely the silent failure 0102's own header warns
-- about, and it was built into this role until it was caught.
--
-- bench_read deliberately has NEITHER grants nor bypassrls: it is PGRST_DB_ANON_ROLE and is
-- meant to answer 'permission denied' rather than to read anything.
do $$ begin create role vault_read nologin bypassrls; exception when duplicate_object then null; end $$;
-- Re-runnable: the do-block above is skipped if the role already exists, so set it explicitly.
alter role vault_read bypassrls;

-- ORDERING DEPENDENCY: `authenticator` is created by the bench half of this cluster
-- (server/deploy/selfhost_schema.sql in ferrodiode-pcb-testbench), which is applied to
-- the `public` schema FIRST. Run these vault migrations against a cluster without it and
-- this grant fails with 'role "authenticator" does not exist'. Verified 2026-09-10 on a
-- real PG 17.10: the rest of this file is re-runnable, but this line is not standalone.
grant vault_service, vault_read to authenticator;
grant usage on schema vault, extensions to vault_service, vault_read;

commit;

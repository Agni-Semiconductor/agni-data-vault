create schema if not exists vault;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext with schema extensions;

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is intentionally not installed.
do $$ begin create role vault_service nologin bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role vault_read nologin; exception when duplicate_object then null; end $$;

-- ORDERING DEPENDENCY: `authenticator` is created by the bench half of this cluster
-- (server/deploy/selfhost_schema.sql in ferrodiode-pcb-testbench), which is applied to
-- the `public` schema FIRST. Run these vault migrations against a cluster without it and
-- this grant fails with 'role "authenticator" does not exist'. Verified 2026-09-10 on a
-- real PG 17.10: the rest of this file is re-runnable, but this line is not standalone.
grant vault_service, vault_read to authenticator;
grant usage on schema vault, extensions to vault_service, vault_read;

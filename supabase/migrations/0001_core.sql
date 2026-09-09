create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists citext;

create table public.option_lists (
  key text primary key, label text not null, description text
);
create table public.option_values (
  id uuid primary key default gen_random_uuid(), list_key text not null references public.option_lists(key) on delete cascade,
  value text not null, label text not null, sort_order int not null default 0, active boolean not null default true,
  meta jsonb not null default '{}', created_at timestamptz default now(), unique (list_key, value)
);
create table public.field_definitions (
  id uuid primary key default gen_random_uuid(), entity text not null check (entity in ('sample','measurement','file')),
  key text not null check (key ~ '^[a-z][a-z0-9_]*$'), label text not null, help text,
  type text not null check (type in ('text','longtext','number','integer','date','bool','select','multiselect','person','layer_stack','json')),
  options_list_key text references public.option_lists(key), unit text, required boolean not null default false,
  sort_order int not null default 0, group_name text, active boolean not null default true, column_name text,
  show_in_table boolean not null default false, filterable boolean not null default true, min numeric, max numeric,
  regex text, default_value jsonb, created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (entity, key), check (type not in ('select','multiselect','person') or options_list_key is not null)
);
create table public.samples (
  id uuid primary key default gen_random_uuid(), sample_id text not null unique check (sample_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'),
  label text, family text, owner text, substrate text, substrate_size text, fab_location text, fabricated_by text,
  fabricated_on date, stack jsonb not null default '[]', meta jsonb not null default '{}', meta_status jsonb not null default '{}',
  notes text, created_by text, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.measurements (
  id uuid primary key default gen_random_uuid(), sample_id uuid not null references public.samples(id) on delete cascade,
  measured_on date, kind text, instrument text, probe_station text, measured_by text, temperature_c numeric,
  device_address text, run_numbers integer[] not null default '{}', pad_shape text check (pad_shape in ('circle','square') or pad_shape is null),
  pad_dim_um numeric check (pad_dim_um > 0), pad_area_override numeric check (pad_area_override > 0),
  pad_area_um2 numeric generated always as (coalesce(pad_area_override, case when pad_shape = 'circle' then pi() * (pad_dim_um / 2)^2 when pad_shape = 'square' then pad_dim_um^2 end)) stored,
  meta jsonb not null default '{}', meta_status jsonb not null default '{}', notes text, created_by text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.files (
  id uuid primary key default gen_random_uuid(), measurement_id uuid not null references public.measurements(id) on delete cascade,
  storage_path text not null unique, original_name text not null, kind text not null default 'other', size_bytes bigint,
  sha256 text, parsed jsonb not null default '{}', upload_state text not null default 'pending' check (upload_state in ('pending','ready','failed')),
  created_by text, created_at timestamptz default now(), unique (measurement_id, sha256)
);
create table public.allowlist (
  email citext primary key, role text not null default 'member' check (role in ('member','admin')), added_at timestamptz default now()
);
create table public.audit_log (
  id bigserial primary key, entity text not null, entity_id uuid, action text not null, actor text, diff jsonb, at timestamptz default now()
);

create index samples_meta_idx on public.samples using gin (meta jsonb_path_ops);
create index measurements_meta_idx on public.measurements using gin (meta jsonb_path_ops);
create index measurements_sample_id_measured_on_idx on public.measurements (sample_id, measured_on desc);
create index measurements_kind_idx on public.measurements (kind);
create index measurements_device_address_idx on public.measurements (device_address);
create index measurements_measured_by_idx on public.measurements (measured_by);
create index files_measurement_id_idx on public.files (measurement_id);
create index files_sha256_idx on public.files (sha256);
create index samples_sample_id_trgm_idx on public.samples using gin (sample_id gin_trgm_ops);
create index samples_label_trgm_idx on public.samples using gin (label gin_trgm_ops);
create index option_values_list_active_sort_idx on public.option_values (list_key, active, sort_order);
create index field_definitions_entity_active_sort_idx on public.field_definitions (entity, active, sort_order);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger field_definitions_set_updated_at before update on public.field_definitions for each row execute function public.set_updated_at();
create trigger samples_set_updated_at before update on public.samples for each row execute function public.set_updated_at();
create trigger measurements_set_updated_at before update on public.measurements for each row execute function public.set_updated_at();

create or replace function public.current_email() returns text language sql stable security definer set search_path = public as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
$$;
create or replace function public.is_allowlisted() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowlist where email = public.current_email());
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowlist where email = public.current_email() and role = 'admin');
$$;
create or replace function public.audit_row() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (entity, entity_id, action, actor, diff)
  values (TG_TABLE_NAME, coalesce(new.id, old.id), TG_OP, public.current_email(), jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new)));
  return coalesce(new, old);
end;
$$;
create trigger samples_audit after insert or update or delete on public.samples for each row execute function public.audit_row();
create trigger measurements_audit after insert or update or delete on public.measurements for each row execute function public.audit_row();
create trigger files_audit after insert or update or delete on public.files for each row execute function public.audit_row();

create or replace function public.enforce_allowlist() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowlist where email = new.email) then
    raise exception 'email_not_allowlisted: %', new.email;
  end if;
  return new;
end;
$$;
do $$
begin
  if to_regclass('auth.users') is not null then
    execute 'create trigger enforce_allowlist_before_user_insert before insert on auth.users for each row execute function public.enforce_allowlist()';
  end if;
exception when insufficient_privilege or undefined_table or invalid_schema_name then null;
end;
$$;

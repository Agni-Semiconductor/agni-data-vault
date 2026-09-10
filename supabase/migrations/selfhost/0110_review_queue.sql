begin;
set local search_path = vault, extensions;

create table vault.review_queue (
  id uuid primary key default gen_random_uuid(),
  entity text not null check (entity in ('sample','measurement')),
  entity_id uuid not null,
  field text not null,
  candidate_value jsonb not null,
  reason text not null,
  evidence_seen jsonb not null,
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  resolved_by text,
  resolved_at timestamptz,
  created_by text,
  created_at timestamptz default now()
);

-- entity_id is polymorphic: it references samples or measurements according to entity, so a
-- single foreign key cannot express the relationship. Verify the target when the reference is
-- written; otherwise an unactionable queue item could remain open forever.
create function vault.check_review_queue_entity() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if new.entity = 'sample' then
    perform 1 from vault.samples where id = new.entity_id;
  elsif new.entity = 'measurement' then
    perform 1 from vault.measurements where id = new.entity_id;
  end if;

  if not found then
    raise foreign_key_violation using
      message = format('review_queue %s entity_id %s does not exist', new.entity, new.entity_id);
  end if;
  return new;
end;
$$;

create trigger review_queue_check_entity
  before insert or update of entity, entity_id on vault.review_queue
  for each row execute function vault.check_review_queue_entity();

create index review_queue_open_entity_idx on vault.review_queue (entity, created_at)
  where status = 'open';
create index review_queue_entity_id_idx on vault.review_queue (entity_id);
create unique index review_queue_one_open_field_idx on vault.review_queue (entity, entity_id, field)
  where status = 'open';

-- Every vault table has RLS enabled but no policies. This works only because vault_service has BYPASSRLS.
-- If that role is provisioned incorrectly, nothing raises an error: PostgREST returns empty arrays, the API reports success,
-- and the vault appears empty instead of unauthorized. The health check must read a row known to exist.
alter table vault.review_queue enable row level security;

grant select, insert, update, delete on vault.review_queue to vault_service;
grant select on vault.review_queue to vault_read;
revoke execute on function vault.check_review_queue_entity() from public, vault_read;

-- review_needed is metadata, not a real column. Seed it for both entities so rows requiring
-- review appear in tables and filters, then rebuild the generated flat views only if needed.
with inserted as (
  insert into vault.field_definitions
    (entity, key, label, help, type, sort_order, group_name, show_in_table, filterable)
  values
    ('sample', 'review_needed', 'Review needed', 'Whether this sample has unresolved review items.', 'bool', 190, 'Backfill', true, true),
    ('measurement', 'review_needed', 'Review needed', 'Whether this measurement has unresolved review items.', 'bool', 190, 'Backfill', true, true)
  on conflict (entity, key) do nothing
  returning 1
)
select vault.rebuild_flat_views() where exists (select 1 from inserted);

commit;

-- Which package pin drives which line. The crossbar's tooltip, and the answer to "where do I put
-- the probe".
--
-- WHAT THIS IS FOR. The coverage map answers "did this run measure that cell". The crossbar
-- answers "where on the die is the fault" -- a bad word line is a stripe, a bad corner is a
-- block. Neither tells you what to physically touch. A stripe at WL 42 is only actionable once
-- you know WL 42 is net `WL_ROW42` on package pin `J3-17`, and that mapping lives today in a
-- schematic and somebody's memory.
--
-- WHY IT IS IN `vault` AND NOT `public`. `public` is the bench's schema and a COPIED WIRE
-- CONTRACT -- selfhost_schema.sql says not to redesign it, and four restore tools dump
-- `--schema=public`. A new table there would ride along in every bench restore while the bench
-- repo knows nothing about it, which is how two systems end up disagreeing about what the bench
-- schema is. The vault owns this, reads it through its own API, and the bench never needs it.
--
-- WHY IT IS KEYED BY dut_id AND NOT BY A BOARD REVISION. Several boards very likely share a
-- design, and keying by a `board_rev` would let one 256-row map serve all of them. I do not know
-- which boards share a design, and inventing that taxonomy here would be the same class of error
-- as deciding `D116` and `D116_116` are the same device: a guess that reads as a fact forever.
-- Copying a verified map onto a second board is one INSERT ... SELECT, and doing it deliberately
-- leaves a trail; deriving it silently would not.
begin;
set local search_path = vault, extensions;

create table if not exists vault.board_pin_map (
  dut_id       text not null,
  family       text not null check (family in ('wl', 'bl')),
  line         integer not null check (line >= 0 and line <= 127),
  -- The schematic net, and the package pin a probe actually touches. Both are free text because
  -- both come off a schematic that this database has never seen.
  net          text,
  pin          text,

  -- HAND-ENTERED BOARD WIRING IS EXACTLY THE KIND OF THING THAT IS WRONG AND NOBODY NOTICES.
  -- A wrong pin sends someone to probe the wrong place and the measurement they take is real,
  -- just of something else -- so the map carries who said so and where they read it, the same
  -- rule device_aliases applies to identity.
  source       text not null,
  confirmed_by text not null,
  confirmed_at timestamptz not null default now(),
  notes        text,

  primary key (dut_id, family, line)
);

create index if not exists board_pin_map_dut_idx on vault.board_pin_map (dut_id);
create index if not exists board_pin_map_net_idx on vault.board_pin_map (net) where net is not null;

comment on table vault.board_pin_map is
  'Package pin and schematic net per (dut, family, line). Feeds the crossbar tooltip: a stripe at '
  'WL 42 is only actionable once you know which pin to probe. Hand-entered, so every row names '
  'its source and the person who confirmed it.';

comment on column vault.board_pin_map.source is
  'Where this came from -- a schematic revision, a netlist file, a photograph of the board. '
  '"I remember" is a valid answer only if it is written down as one.';

-- Copying a verified map onto a board that shares the design. Deliberate, and it records that
-- the copy happened rather than presenting itself as independent confirmation.
create or replace function vault.copy_pin_map(p_from text, p_to text, p_actor text)
returns integer language plpgsql as $fn$
declare copied integer;
begin
  if p_from = p_to then
    raise exception 'source and target dut are the same' using errcode = '22023';
  end if;
  if not exists (select 1 from vault.board_pin_map where dut_id = p_from) then
    raise exception 'dut % has no pin map to copy', p_from using errcode = '22023';
  end if;
  with inserted as (
    insert into vault.board_pin_map (dut_id, family, line, net, pin, source, confirmed_by, notes)
    select p_to, m.family, m.line, m.net, m.pin,
           -- The provenance says it is a COPY and names the origin. Presenting a copied row as if
           -- somebody had independently checked this board is how one schematic error becomes
           -- two boards' worth of wrong probing.
           'copied from ' || p_from || ' (' || m.source || ')',
           p_actor, m.notes
      from vault.board_pin_map m
     where m.dut_id = p_from
    on conflict (dut_id, family, line) do nothing
    returning 1
  )
  select count(*) into copied from inserted;
  return copied;
end $fn$;

alter table vault.board_pin_map enable row level security;
-- RLS enabled with NO POLICIES, as on every table here -- it works only because the service roles
-- hold BYPASSRLS. Get it wrong and nothing errors: PostgREST returns [] and the map looks empty.
grant select on vault.board_pin_map to vault_read, vault_service;
grant insert, update, delete on vault.board_pin_map to vault_service;
grant execute on function vault.copy_pin_map(text, text, text) to vault_service;

select vault.rebuild_flat_views();

commit;

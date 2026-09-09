-- The Supabase service-role key bypasses RLS. Browser requests use authenticated
-- sessions and are constrained below; no anon policies are intentionally granted.
alter table public.option_lists enable row level security;
alter table public.option_values enable row level security;
alter table public.field_definitions enable row level security;
alter table public.samples enable row level security;
alter table public.measurements enable row level security;
alter table public.files enable row level security;
alter table public.allowlist enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists option_lists_select on public.option_lists; drop policy if exists option_lists_insert on public.option_lists; drop policy if exists option_lists_update on public.option_lists; drop policy if exists option_lists_delete on public.option_lists;
drop policy if exists option_values_select on public.option_values; drop policy if exists option_values_insert on public.option_values; drop policy if exists option_values_update on public.option_values; drop policy if exists option_values_delete on public.option_values;
drop policy if exists field_definitions_select on public.field_definitions; drop policy if exists field_definitions_insert on public.field_definitions; drop policy if exists field_definitions_update on public.field_definitions; drop policy if exists field_definitions_delete on public.field_definitions;
drop policy if exists samples_select on public.samples; drop policy if exists samples_insert on public.samples; drop policy if exists samples_update on public.samples; drop policy if exists samples_delete on public.samples;
drop policy if exists measurements_select on public.measurements; drop policy if exists measurements_insert on public.measurements; drop policy if exists measurements_update on public.measurements; drop policy if exists measurements_delete on public.measurements;
drop policy if exists files_select on public.files; drop policy if exists files_insert on public.files; drop policy if exists files_update on public.files; drop policy if exists files_delete on public.files;
drop policy if exists allowlist_select on public.allowlist; drop policy if exists allowlist_insert on public.allowlist; drop policy if exists allowlist_update on public.allowlist; drop policy if exists allowlist_delete on public.allowlist;
drop policy if exists audit_log_select on public.audit_log;

create policy option_lists_select on public.option_lists for select to authenticated using (public.is_allowlisted());
create policy option_lists_insert on public.option_lists for insert to authenticated with check (public.is_allowlisted());
create policy option_lists_update on public.option_lists for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy option_lists_delete on public.option_lists for delete to authenticated using (public.is_admin());
create policy option_values_select on public.option_values for select to authenticated using (public.is_allowlisted());
create policy option_values_insert on public.option_values for insert to authenticated with check (public.is_allowlisted());
create policy option_values_update on public.option_values for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy option_values_delete on public.option_values for delete to authenticated using (public.is_admin());
create policy field_definitions_select on public.field_definitions for select to authenticated using (public.is_allowlisted());
create policy field_definitions_insert on public.field_definitions for insert to authenticated with check (public.is_allowlisted());
create policy field_definitions_update on public.field_definitions for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy field_definitions_delete on public.field_definitions for delete to authenticated using (public.is_admin());
create policy samples_select on public.samples for select to authenticated using (public.is_allowlisted());
create policy samples_insert on public.samples for insert to authenticated with check (public.is_allowlisted());
create policy samples_update on public.samples for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy samples_delete on public.samples for delete to authenticated using (public.is_admin());
create policy measurements_select on public.measurements for select to authenticated using (public.is_allowlisted());
create policy measurements_insert on public.measurements for insert to authenticated with check (public.is_allowlisted());
create policy measurements_update on public.measurements for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy measurements_delete on public.measurements for delete to authenticated using (public.is_admin());
create policy files_select on public.files for select to authenticated using (public.is_allowlisted());
create policy files_insert on public.files for insert to authenticated with check (public.is_allowlisted());
create policy files_update on public.files for update to authenticated using (public.is_allowlisted()) with check (public.is_allowlisted());
create policy files_delete on public.files for delete to authenticated using (public.is_admin());
create policy allowlist_select on public.allowlist for select to authenticated using (public.is_allowlisted());
create policy allowlist_insert on public.allowlist for insert to authenticated with check (public.is_admin());
create policy allowlist_update on public.allowlist for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy allowlist_delete on public.allowlist for delete to authenticated using (public.is_admin());
create policy audit_log_select on public.audit_log for select to authenticated using (public.is_admin());

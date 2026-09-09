insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault','vault', false, 52428800, null)
on conflict (id) do nothing;

drop policy if exists vault_select on storage.objects;
create policy vault_select on storage.objects for select to authenticated using (bucket_id = 'vault' and public.is_allowlisted());
drop policy if exists vault_insert on storage.objects;
create policy vault_insert on storage.objects for insert to authenticated with check (bucket_id = 'vault' and public.is_allowlisted());
drop policy if exists vault_update on storage.objects;
create policy vault_update on storage.objects for update to authenticated using (bucket_id = 'vault' and public.is_allowlisted()) with check (bucket_id = 'vault' and public.is_allowlisted());
drop policy if exists vault_delete on storage.objects;
create policy vault_delete on storage.objects for delete to authenticated using (bucket_id = 'vault' and public.is_admin());

-- Hardening from Supabase security advisors (2026-09-09).
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
alter extension citext set schema extensions;

alter function public.set_updated_at() set search_path = public;

-- Trigger-only and internal helpers: not callable over PostgREST RPC by any client role.
revoke execute on function public.audit_row() from public, anon, authenticated;
revoke execute on function public.enforce_allowlist() from public, anon, authenticated;
revoke execute on function public.current_email() from public, anon, authenticated;
-- Policy helpers stay executable by signed-in users (RLS evaluates them as the caller) but not by anon.
revoke execute on function public.is_allowlisted() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_allowlisted() to authenticated;
grant execute on function public.is_admin() to authenticated;

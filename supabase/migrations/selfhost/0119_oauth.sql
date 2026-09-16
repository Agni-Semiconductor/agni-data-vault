-- Tier 2 identity for the MCP endpoint: OAuth 2.1 with Google Workspace as the identity provider.
--
-- WHY. The MCP endpoint had two credentials, both shared: VAULT_API_KEY (also the REST write key)
-- and VAULT_MCP_READ_KEY (read-only, one for everyone). Shared means no audit by person, no
-- per-person revocation, and a key that leaks is everyone's key. Claude's clients implement the
-- MCP authorization spec: the person clicks Connect, a browser opens, they sign in with Google, and
-- the client receives a token bound to THEM. This file is the durable state that flow needs and
-- nothing else. The model still runs at Anthropic; nothing here calls anyone.
--
-- WHAT IS STORED, AND WHAT IS NOT.
--   * Registered clients (Claude desktop, claude.ai, Claude Code...) -- public clients, no secret.
--     Dynamic registration (RFC 7591) means a row per client install; that is expected.
--   * Grants in flight: one row per Connect attempt, carrying the client's PKCE challenge across
--     the round trip to Google. Its id is the `state` we hand Google, so a callback can only land
--     on a grant this server created.
--   * Tokens, HASHED. Only sha256(token) is stored; a dump of this table mints nothing.
--   * NOT stored: Google's tokens. The id_token is verified and discarded; we keep the email.
--
-- Google's `hd` claim must equal VAULT_EMAIL_DOMAIN, the same rule as the Access path: hd is
-- asserted by Google about the account's domain and a personal account with a lookalike address
-- cannot satisfy it. A person who passes is upserted into vault.people as `member` -- the
-- auto-provisioning docs/CONTRACT.md v2.3 described and nothing had implemented. Admin stays a
-- row somebody edits by hand.
begin;
set local search_path = vault, extensions;

create table if not exists vault.oauth_clients (
  client_id        text primary key,
  client_name      text,
  -- Exact-match redirect URIs, RFC 6749 §3.1.2.3. https, or loopback http for desktop clients.
  redirect_uris    text[] not null check (cardinality(redirect_uris) > 0),
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz
);
comment on table vault.oauth_clients is
  'MCP OAuth clients registered dynamically (RFC 7591). Public clients: no secret exists. One row '
  'per client installation is normal.';

create table if not exists vault.oauth_grants (
  -- Also the `state` sent to Google, so a callback can only complete a grant this server began.
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null references vault.oauth_clients(client_id) on delete cascade,
  redirect_uri     text not null,
  client_state     text,
  code_challenge   text not null,
  scope            text not null default 'vault:read',
  -- Filled in by the callback once Google has vouched for a person in the right domain.
  email            citext,
  -- sha256 of the authorization code, once issued. The code itself is never stored.
  code_hash        text unique,
  code_expires_at  timestamptz,
  consumed_at      timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '10 minutes'
);
comment on table vault.oauth_grants is
  'One row per Connect attempt. Carries the PKCE challenge across the Google round trip; the '
  'authorization code is stored only as a hash and is single-use.';
create index if not exists oauth_grants_expires_idx on vault.oauth_grants (expires_at);

create table if not exists vault.oauth_tokens (
  -- sha256 hex of the token. The token is `vlt_` + 43 chars of base64url; a table dump mints nothing.
  token_hash       text primary key,
  kind             text not null check (kind in ('access', 'refresh')),
  email            citext not null,
  client_id        text not null references vault.oauth_clients(client_id) on delete cascade,
  scope            text not null default 'vault:read',
  -- A refresh token is rotated on use; the replacement points back so a replayed old token can
  -- revoke the whole chain (RFC 6819 §5.2.2.3).
  parent_hash      text,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now()
);
comment on table vault.oauth_tokens is
  'Bearer tokens for the MCP endpoint, hashed. `email` is the principal every tool call is '
  'attributed to; that attribution is the entire reason Tier 2 exists.';
create index if not exists oauth_tokens_email_idx on vault.oauth_tokens (email);
create index if not exists oauth_tokens_expires_idx on vault.oauth_tokens (expires_at);

alter table vault.oauth_clients enable row level security;
alter table vault.oauth_grants  enable row level security;
alter table vault.oauth_tokens  enable row level security;
-- RLS enabled with NO POLICIES, as everywhere here -- it works only because vault_service holds
-- BYPASSRLS. Get it wrong and nothing errors: PostgREST returns [] and every login "succeeds"
-- into a token nobody can find again.

grant select, insert, update, delete on vault.oauth_clients to vault_service;
grant select, insert, update, delete on vault.oauth_grants  to vault_service;
grant select, insert, update, delete on vault.oauth_tokens  to vault_service;
-- DELETE is granted here, unlike the audit tables: expired grants and tokens are garbage, not
-- history. Attribution of what a token DID lives in audit_log via the actor, not in this table.

-- vault_read gets nothing. These are credentials by another name, and a read-only reporting role
-- has no business enumerating who holds a session. 0102's default privileges do not reach
-- vault_read, but say it rather than rely on it.
revoke all on vault.oauth_clients, vault.oauth_grants, vault.oauth_tokens from vault_read, public;

-- The interface role for agni-connect sees none of this either; connect is views only.
revoke all on vault.oauth_clients, vault.oauth_grants, vault.oauth_tokens from connect_read;

commit;

# The measurement data endpoint, for agni-connect

**Audience:** whoever is writing agni-connect. This is the whole of what you need to read
measurement data, and the whole of what is promised to you.

**Status: the schema is LIVE on edaserver** as of 2026-09-11. Database `fedbench` on the PGDG
17.10 cluster, all 19 migrations applied, `connect_read` created, and the interface verified in
place — `connect_read` reads the seven views with row counts identical to the owner's and is
refused on every base table in `vault` and `public`.

**The HTTP listener is not up yet.** PostgREST, `fed_storage`, nginx and Caddy are not installed
(that needs root and is a separate step), so you cannot reach it over the wire today. Nothing in
this document changes when it goes up.

---

## 1. The one-paragraph version

There is one Postgres cluster on `edaserver`. The measurement data lives in the `fedbench`
database. You read it over HTTP through PostgREST, from **your server**, using a schema called
`connect` that exists specifically for you. You get seven read-only views, a token, and a promise
that those views do not change shape without someone telling you. You do not get the vault's
tables, and your browser never touches any of this.

---

## 2. Your architecture is the same shape as ours

You said agni-connect is also going on Vercel. Then it wants the same topology, and the reasons
are worth having rather than copying:

```
  browser
    |
    v
  devops.agnisemi.ai            (Cloudflare; Access = Google Workspace SSO)
    |-- /        --> Vercel      your SPA. Static. No secrets, no VITE_ vars.
    '-- /api/*   --> Tunnel  --> edaserver 127.0.0.1:<your port>   your API server
                                        |
                                        v  loopback, never the network
                                 127.0.0.1:8087  nginx --> PostgREST :3000
                                                       --> fed_storage :3001
```

**Why the API cannot stay on Vercel.** Access's session cookie is only a first-party cookie if the
SPA and the API are the same origin — Safari blocks it otherwise. Cloudflare fronting one hostname
with two origins gives the browser one origin while Vercel still serves the SPA.

**Why that is also the security answer.** Your API server on `edaserver` reaches PostgREST over
**loopback**. The token never crosses a network, and the data plane (`/rest/v1`, `/storage/v1`) is
never published through a tunnel — only your own `/api` is. What goes public is an application
endpoint that authenticates every request, not a PostgREST origin holding a database credential.

**Three rules that are not negotiable, because breaking any one of them is an incident:**

1. **Nothing secret reaches the browser.** Vite inlines every `VITE_`-prefixed variable into the
   bundle as a literal string, served to anyone who can load the page. Our rule is *nothing at all*
   starts with `VITE_` except one non-secret base URL, and we have a CI test that greps for it —
   because "nothing *secret* starts with `VITE_`" requires every future author to correctly
   classify their own variable, and that version cannot be checked.
2. **Verify the Access assertion, don't trust it.** Cloudflare sets `Cf-Access-Jwt-Assertion`.
   Check its *signature* against your team's public keys and check `aud`. A proxy-injected header
   you trust is a header anyone who reaches the origin by another route can forge. Also strip any
   client-supplied `Cf-Access-*` on ingress, and bind your API to `127.0.0.1`.
3. **No path is protected by SSO alone.** Every path independently validates a credential. SSO is
   an *additional* gate on human paths, never the only one.

---

## 3. How you connect

| | |
|---|---|
| **Base URL** | `http://127.0.0.1:8087/rest/v1` — loopback, from your API server on `edaserver` |
| **Profile** | `Accept-Profile: connect` on every GET (`Content-Profile` for writes, which you have none of) |
| **Auth** | `Authorization: Bearer <jwt>`, HS256, claim `{"role": "connect_read"}` |
| **Database** | `fedbench` |

```bash
curl -s 'http://127.0.0.1:8087/rest/v1/measurements?kind=eq.pund&limit=5' \
  -H 'Accept-Profile: connect' \
  -H "Authorization: Bearer $CONNECT_JWT"
```

**Forget `Accept-Profile` and you get the bench schema**, because `public` is first in
`PGRST_DB_SCHEMAS` and is therefore the default profile. You will get a 404 for a table name that
plainly exists, which reads as "the endpoint is broken" rather than "you asked the wrong schema".
Set the header in your HTTP client once, centrally.

### The token

**You will be given a token. You will not be given the signing secret, and you should not ask for
it.** The data plane uses HS256, where the verification key and the signing key are the same
string — so anyone holding the secret can mint a token claiming `role: vault_service`, which holds
`BYPASSRLS` and write access to every table in the database. "Give agni-connect read access" and
"give agni-connect unrestricted write access to all measurement data" would be the same act.

Practically: the token goes in `/etc/agni-connect/api.env` (mode `0640`, owned `root:<your service
user>`), it is read at process start, and it never appears in a log line, a URL, or a client
bundle. If you need to re-mint one, ask — and if self-service minting turns out to be something you
genuinely need, say so, because that requires moving the data plane to asymmetric keys (RS256 with
a JWKS endpoint) so the signing key can stay in one place. That is a real change to PostgREST *and*
`fed_storage`, worth doing deliberately rather than discovering.

---

## 4. What you can read

Seven views. **This list is the contract.** Everything else in the database — `vault.*`,
`public.*` — is our implementation and will keep moving; the vault gained eighteen migrations in a
few weeks, promoting columns out of JSON, adding a storage bucket, adding a device dimension. If
you had been reading our tables, every one of those would have been your outage.

| View | What it is |
|---|---|
| `connect.samples` | The sample registry. `sample_id` is the human key, `id` the uuid every foreign key uses — **both travel**, because joining on the wrong one gives you an empty result rather than an error. |
| `connect.measurements` | One row per measurement. Carries `sample_key` so you can report without a join, plus the device address, pad geometry, and the bench run it came from. |
| `connect.files` | **This is the one your spec actually describes.** Raw-data path plus checksum: `bucket`, `storage_path`, `sha256`, `size_bytes`, `upload_state`. |
| `connect.metrics` | Derived numbers per measurement — on/off, Ec±, Pr, leakage — with `extractor_version` and `skipped`. |
| `connect.bench_runs` | Bench campaigns, with `n_cells_recorded` **counted from child rows**, not read from the run's own roll-up. |
| `connect.kinds` | The measurement-kind registry: canonical axis columns and their **units**. |
| `connect.health` | Row counts through the same views you read. See §6. |

### Four things about the data that will mislead you if nobody says them

**`upload_state` is not decoration.** A `files` row can sit in `pending` or `failed` from an
abandoned upload. Treat every row as retrievable bytes and you will eventually ask for an object
that was never stored.

**`meta_status` travels whole, and it matters.** It is a `{key: confirmed | assumed | unknown}` map
per row. A value being present does not mean anyone verified it. If you are computing anything that
gets acted on, filter to `confirmed`. There is also a fourth state — the key being *absent* — which
means nobody recorded a confidence at all; that is not the same as `unknown`, and folding them
together inflates how much of this corpus is trustworthy. We hand you the raw map rather than a
"completeness score" because the score would be our opinion and the map is the fact.

**`skipped` on a metric is a refusal, not an absence.** A measurement with no metric row was never
processed. A metric row with a null value and a `skipped` reason was processed and the extractor
declined — the sweep sat at compliance, there was no usable channel. Averaging over "rows that have
a number" silently drops both and reports a mean over an unstated subset.

**`n_cells_recorded`, never a run's own count.** `campaign_runs.n_measured` is written at the *end*
of a run, so a live 86-hour campaign reports `0` while tens of thousands of child rows exist. Our
own tooling learned this the hard way; the view does the counting so you cannot.

### Units

Read them from `connect.kinds`, don't type them into your code. The bench emits both `i_a` (amps)
and `current_mA` for the same quantity, and overlaying them without conversion is a 1000× error
that looks exactly like real data. One of our own migrations declared a single unit for an axis
whose column list had both, and a capture carrying only the legacy column would have been labelled
amperes. The registry exists so that mistake has one place to be made and be fixed.

---

## 5. What you cannot read, and why

`connect_read` holds `USAGE` on schema `connect`, `SELECT` on its seven views, and **nothing at all
on `vault` or `public`** — verified by a probe that enumerates every table in both schemas rather
than checking a list, so it keeps holding for migrations written after it.

Specifically unreachable by any path: `vault.people` and `vault.allowlist` (identities),
`vault.audit_log`, `vault.agent_queries` (free-text queries), and every `notes` column. Operator
free text is the PII surface and the one field our search agent's threat model already treats as
untrusted content; a tool tracking artefacts and checksums has no use for it.

`connect_read` also does **not** hold `BYPASSRLS`. Our `vault_read` does — RLS is enabled with no
policies, so anything without the flag reads zero rows — which is exactly why `vault_read` is a bad
thing to hand another team: with it, one wrong grant exposes everything instead of nothing.

**Read-only, and that is a decision rather than an oversight.** If agni-connect needs to write
something into the measurement database, that is a conversation about what it owns and where the
provenance comes from, not a grant. Your own devops tables belong in your own database.

---

## 6. Check that it works — properly

The loudest silent failure on this box: **a role that cannot read does not error, it returns
nothing.** RLS is enabled with no policies, so a grant mistake means every query answers `[]` and
your application shows an empty database rather than an access failure. A health check that returns
`200 {"ok": true}` reports perfect health in exactly that state.

So `connect.health` counts rows *through the views you read*:

```bash
curl -s 'http://127.0.0.1:8087/rest/v1/health' \
  -H 'Accept-Profile: connect' -H "Authorization: Bearer $CONNECT_JWT"
# {"n_samples":2106,"n_measurements":2106,"n_files":...,"observed_at":"..."}
```

**Alert on the numbers, not on the status code.** Zero where there should be thousands is the
failure mode you are actually exposed to.

---

## 7. Getting the bytes

`connect.files` gives you `bucket` + `storage_path` + `sha256`. Those are stable identifiers, not
URLs — deliberately, so this deployment's hostname never ends up baked into your database.

To fetch an object, go through `fed_storage` on the same loopback origin
(`/storage/v1/object/<bucket>/<path>`) with a token that has storage rights. If you need that, ask;
it is a different grant from the one above and it is worth deciding rather than defaulting.

Two buckets exist. `bench` holds the testbench's own captures and is **read-only to everyone
outside the bench** — an unused delete on the system of record turns a path-confinement bug from a
disclosure into data loss, so the absence is enforced rather than incidental.

---

## 8. What is not true yet

Honest status, so you can plan around it:

- **The host is not stood up.** No PostgREST, no `fed_storage`, no Caddy, no tunnel on `edaserver`
  yet. The schema, the role and the grants are built and verified against PostgreSQL 17.10 locally,
  including a negative test that the role cannot reach a single base table.
- **Your own database is not provisioned.** One cluster, a database per product — so agni-connect's
  own tables get their own database on the same cluster. Note that **PostgREST serves exactly one
  database**, so the instance you read `connect` from cannot also serve your tables. Either run your
  own PostgREST against your own database, or talk to it directly over libpq from your API. Worth
  deciding early; it does not affect anything in this document.
- **Ports and hostnames** for your side (`devops.agnisemi.ai`, your loopback port, your tunnel) are
  not allocated yet.

## 8a. Building the rest of agni-connect

`docs/PLATFORM_BLUEPRINT.md` describes the whole architecture this repo runs on — repo layout, the
one-handler-two-hosts trick that lets the same code run on Vercel and as a daemon, the Vercel
config, the systemd unit, the Cloudflare Access verification, the principal-based auth model, the
env-var conventions, the port map, and the RHEL 9 SELinux traps. **agni-connect gets its own
database on the shared cluster**; that document says exactly what is shared and what is not.

## 8b. agni-connect's OWN data

agni-connect is an issue tracker, so most of its data has nothing to do with measurements. Two
separate questions, and only the first one is about this document.

### Can a different structure share this endpoint? Yes, and it costs nothing

PostgREST exposes a **list** of schemas and `Accept-Profile` picks among them per request. So a
`devops` schema with a completely different shape is reachable at the *same* URL, port, JWT secret,
nginx shim and Caddy route — one migration, one line of config, one restart.

**Verified, not assumed** (2026-09-11, against PostgreSQL 17.10 and real PostgREST):

```
GET /rest/v1/health   Accept-Profile: connect   -> {"n_samples":10,"n_measurements":14,...}
GET /rest/v1/issues   Accept-Profile: devops    -> [{"number":1,"title":"Stand up PostgREST"...}]
POST /rest/v1/issues  Content-Profile: devops   -> 201, row returned
```

and the roles cannot cross:

```
connect_read -> devops.issues      403  permission denied for schema devops
devops_app   -> connect.samples    403  permission denied for schema connect
devops_app   -> vault.measurements 403  permission denied for schema vault
```

**403, not `[]`.** That matters more than it looks: a wrong grant here fails loudly rather than
returning an empty array that reads as "no data yet".

Operational note: adding a **table** to an already-exposed schema needs only
`NOTIFY pgrst, 'reload schema'`. Adding a **new schema** to `PGRST_DB_SCHEMAS` needs a PostgREST
restart, because that config comes from the unit's environment. The restart is seconds and the
bench's write path is an idempotent upsert retried on the next watcher tick, so it absorbs one.

### Should it share this database? Probably not — recommendation

Easy and advisable are different questions, and for a Linear clone I would put agni-connect's own
tables in **its own database** on the same cluster, not in a schema of `fedbench`:

- **Blast radius.** A product that iterates fast should not be running its migrations inside the
  database holding irreplaceable measurement data.
- **Recovery is different in kind.** An app bug wanting yesterday's issues back must never imply
  rolling measurement data back with it. Logical dump and restore are per-database; that
  separation is the one that matters. (Point-in-time recovery is cluster-wide either way, so it
  does not distinguish them — the logical path is the realistic one.)
- **PostgREST is the wrong write path for an issue tracker anyway.** It gives you one statement per
  request and no transaction spanning requests, so a state transition that also reorders a backlog
  and writes a notification has to become a trigger or an RPC. Your API server is already on
  `edaserver`; let it talk **libpq** to its own database, with its own migrations and its own ORM,
  and use this endpoint only for the measurement reads it is actually good at.

What you give up is a real foreign key from an issue to a measurement — `measurement_id` becomes a
plain uuid whose integrity you check on write against `connect.measurements`. That is an acceptable
trade: a dangling link in an issue tracker is a broken link, not corrupted science. And it is not a
one-way door; `postgres_fdw` makes cross-database joins possible later without moving anything.

If you do want your own data served over **this** endpoint as well — a read-only dashboard, say —
that is the `devops` schema above, and it is free. The two options are not exclusive.

## 9. If something here is wrong for you

Say so before building around it. Adding a column to a `connect` view is cheap and we will do it;
discovering six months in that you have been reading `vault.measurements` directly is the expensive
version of the same conversation.

Columns may be **added** to these views without notice. They are not removed or retyped without
telling you first.

# Agni Data Vault CLI

Install: `pip install -r cli/requirements.txt`.
Set `VAULT_API_URL` (for example `https://agni-data-vault.vercel.app`) and `VAULT_API_KEY`.

Examples:

- `python cli/vault.py schema`
- `python cli/vault.py fields --entity sample`
- `python cli/vault.py list samples --family HfN_20`
- `python cli/vault.py list measurements --sample HfN_20_0421`
- `python cli/vault.py get sample HfN_20_0421`
- `python cli/vault.py get measurement UUID --files`
- `python cli/vault.py add-sample --sample-id X --label "Test" --sweep-v 18`
- `python cli/vault.py add-measurement --sample X --measured-on 2026-04-21 --pad circle 25`
- `python cli/vault.py upload MEASUREMENT_ID "data/*.xlsx"`
- `python cli/import_samples_yaml.py samples.yaml`

Use `--dry-run` on `vault.py` to print the POST request without sending it. It can
use built-in field defaults if the service is unavailable. The YAML importer’s
`--dry-run` prints mapped sample bodies and makes no network calls; use `--only X,Y`
to restrict it.

Use `--json` with `vault.py` list commands for the raw API response. `--api-url`
and `--api-key` override environment values. Exit codes are 0 for success, 1 for an
API/HTTP error, and 2 for command usage or an unknown dynamic field.

`register_bench_runs.py` is **NOT FUNCTIONAL**. Every invocation exits 1 with
`failure=mapping_unavailable`, because no API route exposes `vault.dut_sample_map`. It refuses to
guess: a bench DUT id such as `2kb-dut-01` and a vault sample id (a registry key) are unrelated
namespaces. A derivation that works for today's names silently misattributes measurements when a
board is named differently; data that looks confirmed while attached to the wrong sample is worse
than absent data, because the mismatch reads as valid measurement history rather than a missing
mapping. The missing route must read the mapping, upsert keyed on `bench_run_id` plus
`bench_dut_id`, and set only `kind`, `measured_on`, `instrument`, and `measured_by`; otherwise
duplicate registrations or guessed fields can look like confirmed data.

Use `bash deploy/verify-endpoint.sh` to check that the endpoint is actually serving rows. The
script is read-only, but it needs the JWT secret: on the server that secret is in a `0600` file, so
run it with access to that file or set `PGRST_JWT_SECRET`.

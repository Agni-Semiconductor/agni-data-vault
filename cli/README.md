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

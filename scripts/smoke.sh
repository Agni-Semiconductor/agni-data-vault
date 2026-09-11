#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi
: "${VAULT_API_URL:?Set VAULT_API_URL (for example https://vault.agnisemi.ai)}"
: "${VAULT_API_KEY:?Set VAULT_API_KEY}"
API="${VAULT_API_URL%/}/api"
AUTH="Authorization: Bearer $VAULT_API_KEY"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
status() { local label=$1 output=$2 wanted=$3 code; shift 3; code=$(curl -sS -o "$output" -w '%{http_code}' "$@"); echo "$label -> $code"; [[ "$code" == "$wanted" ]]; }
json() { python3 -c "$1"; }

SCHEMA="$TMP/schema.json"
status 'GET /schema' "$SCHEMA" 200 -H "$AUTH" "$API/schema"
json 'import json,sys; d=json.load(open(sys.argv[1])); assert d["name"]=="agni-data-vault"; print("fields", {k:len(v["fields"]) for k,v in d.get("entities",{}).items()})' "$SCHEMA"

STAMP=$(date +%s); SAMPLE="SMOKE_$STAMP"; SAMPLE_JSON="$TMP/sample.json"
status 'POST /samples' "$SAMPLE_JSON" 201 -X POST -H "$AUTH" -H 'content-type: application/json' -d "{\"sample_id\":\"$SAMPLE\",\"label\":\"Smoke test\"}" "$API/samples"
SAMPLE_ID=$(json 'import json,sys; print(json.load(open(sys.argv[1]))["sample"]["id"])' "$SAMPLE_JSON")

MEAS_JSON="$TMP/measurement.json"; TODAY=$(date +%F)
status 'POST /samples/:id/measurements' "$MEAS_JSON" 201 -X POST -H "$AUTH" -H 'content-type: application/json' -d "{\"measured_on\":\"$TODAY\",\"kind\":\"dciv\",\"pad_shape\":\"circle\",\"pad_dim_um\":25}" "$API/samples/$SAMPLE_ID/measurements"
MEAS_ID=$(json 'import json,sys; print(json.load(open(sys.argv[1]))["measurement"]["id"])' "$MEAS_JSON")

CSV="$TMP/smoke.csv"; printf 'v,i\n0,0\n1,2\n' > "$CSV"
SIZE=$(wc -c < "$CSV" | tr -d ' '); SHA=$(sha256sum "$CSV" | awk '{print $1}'); UPLOAD_JSON="$TMP/upload.json"
status 'POST /files/upload-url' "$UPLOAD_JSON" 201 -X POST -H "$AUTH" -H 'content-type: application/json' -d "{\"measurement_id\":\"$MEAS_ID\",\"filename\":\"smoke.csv\",\"size_bytes\":$SIZE,\"sha256\":\"$SHA\"}" "$API/files/upload-url"
FILE_ID=$(json 'import json,sys; print(json.load(open(sys.argv[1]))["file_id"])' "$UPLOAD_JSON")
UPLOAD_PATH=$(json 'import json,sys; d=json.load(open(sys.argv[1])); assert d["method"]=="PUT"; print(d["upload_url"])' "$UPLOAD_JSON")
PUT_OUT="$TMP/put.json"; status 'PUT /files/:id/content' "$PUT_OUT" 200 -X PUT -H "$AUTH" -H 'content-type: application/octet-stream' --upload-file "$CSV" "${VAULT_API_URL%/}$UPLOAD_PATH"
json 'import json,sys; f=json.load(open(sys.argv[1]))["file"]; assert f["upload_state"]=="ready"' "$PUT_OUT"
REGISTER="$TMP/register.json"; status 'POST /files/:id/register' "$REGISTER" 200 -X POST -H "$AUTH" -H 'content-type: application/json' -d '{}' "$API/files/$FILE_ID/register"

GET_MEAS="$TMP/get-measurement.json"; status 'GET /measurements/:id?include=files' "$GET_MEAS" 200 -H "$AUTH" "$API/measurements/$MEAS_ID?include=files"
json 'import json,sys; f=json.load(open(sys.argv[1]))["measurement"]["files"]; assert len(f)==1 and f[0]["upload_state"]=="ready"' "$GET_MEAS"
DOWNLOAD="$TMP/download.json"; status 'GET /files/:id/download' "$DOWNLOAD" 200 -H "$AUTH" "$API/files/$FILE_ID/download"
DOWNLOAD_PATH=$(json 'import json,sys; d=json.load(open(sys.argv[1])); assert d["expires_at"] is None; print(d["url"])' "$DOWNLOAD")
DOWNLOADED="$TMP/downloaded.csv"; status 'GET /files/:id/content' "$DOWNLOADED" 200 -H "$AUTH" "${VAULT_API_URL%/}$DOWNLOAD_PATH"
cmp "$CSV" "$DOWNLOADED"
DELETE_OUT="$TMP/delete.json"; status 'DELETE /samples/:id' "$DELETE_OUT" 200 -X DELETE -H "$AUTH" "$API/samples/$SAMPLE_ID"
MISSING="$TMP/missing.json"; status 'GET deleted file download' "$MISSING" 404 -H "$AUTH" "$API/files/$FILE_ID/download"

# --- Part 2 surfaces -------------------------------------------------------
# Read-only and fast, but they catch the deployment failures that the write walk above cannot:
# a migration not applied, a role without BYPASSRLS (which returns [] rather than erroring), or a
# resource wired into the router but never deployed. A route that 404s here is a route nobody
# discovers until they need it.
KINDS="$TMP/kinds.json"; status 'GET /kinds' "$KINDS" 200 -H "$AUTH" "$API/kinds"
json 'import json,sys; d=json.load(open(sys.argv[1]))
assert d["items"], "measurement_kinds is empty -- 0111 not applied, or the role lacks BYPASSRLS"
assert d["column_units"], "column_units is empty -- 0112 not applied"
# The whole point of a per-column unit registry: these two are the same quantity in different
# units, and reading one as the other is a 1000x error that looks like data on a log axis.
u = {c["column_name"]: c["unit"] for c in d["column_units"]}
assert u.get("i_a") == "A" and u.get("current_mA") == "mA", u
assert not any(k.get("sql_expr") for k in d["items"]), "sql_expr must never leave the server"' "$KINDS"

CKEYS="$TMP/cohort-keys.json"; status 'GET /cohort-keys' "$CKEYS" 200 -H "$AUTH" "$API/cohort-keys"
json 'import json,sys; d=json.load(open(sys.argv[1]))
assert d["group_keys"] and d["metrics"], "0113 not applied, or the role lacks BYPASSRLS"
# sql_expr is interpolated into a query server-side. A client that could see it is a client
# tempted to send one back.
assert not any("sql_expr" in g for g in d["group_keys"]), "sql_expr leaked to the client"' "$CKEYS"

DEVICES="$TMP/devices.json"; status 'GET /devices' "$DEVICES" 200 -H "$AUTH" "$API/devices?limit=1"
VERDICTS="$TMP/verdicts.json"; status 'GET /verdict-changes' "$VERDICTS" 200 -H "$AUTH" "$API/verdict-changes?limit=1"
FIGURES="$TMP/figures.json"; status 'GET /figures' "$FIGURES" 200 -H "$AUTH" "$API/figures?limit=1"

# A vault_label device may not be handed bench geometry -- that is a claim about die position with
# nothing behind it, and the API must refuse it by name rather than let a check constraint do it.
BADDEV="$TMP/bad-device.json"; status 'POST /devices with grid_row (must be 422)' "$BADDEV" 422 -X POST -H "$AUTH" -H 'content-type: application/json' -d "{\"sample_id\":\"$SAMPLE_ID\",\"device_address\":\"D42\",\"grid_row\":3}" "$API/devices"

# The search agent is OPTIONAL. 200 means it is configured and answered; 503 agent_unavailable
# means no API key on this server, which is a valid deployment state -- so accept either and say
# which, rather than failing a deploy over a feature nobody enabled.
ASK="$TMP/ask.json"
ASK_CODE=$(curl -sS -o "$ASK" -w '%{http_code}' -X POST -H "$AUTH" -H 'content-type: application/json' -d '{"question":"which measurements were taken at 300 C"}' "$API/search/ask")
case "$ASK_CODE" in
  200) echo 'POST /search/ask -> 200 (agent configured)' ;;
  503) echo 'POST /search/ask -> 503 (agent not configured on this server; optional)' ;;
  *) echo "POST /search/ask -> $ASK_CODE"; cat "$ASK"; exit 1 ;;
esac

echo 'SMOKE OK'

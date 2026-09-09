#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi
: "${VAULT_API_URL:?Set VAULT_API_URL (for example https://<vercel-app>)}"
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
SIGNED=$(json 'import json,sys; print(json.load(open(sys.argv[1]))["signed_url"])' "$UPLOAD_JSON")
PUT_OUT="$TMP/put.out"; status 'PUT signed upload URL' "$PUT_OUT" 200 -X PUT --upload-file "$CSV" "$SIGNED"
REGISTER="$TMP/register.json"; status 'POST /files/:id/register' "$REGISTER" 200 -X POST -H "$AUTH" -H 'content-type: application/json' -d '{}' "$API/files/$FILE_ID/register"

GET_MEAS="$TMP/get-measurement.json"; status 'GET /measurements/:id?include=files' "$GET_MEAS" 200 -H "$AUTH" "$API/measurements/$MEAS_ID?include=files"
json 'import json,sys; f=json.load(open(sys.argv[1]))["measurement"]["files"]; assert len(f)==1 and f[0]["upload_state"]=="ready"' "$GET_MEAS"
DOWNLOAD="$TMP/download.json"; status 'GET /files/:id/download' "$DOWNLOAD" 200 -H "$AUTH" "$API/files/$FILE_ID/download"
DELETE_OUT="$TMP/delete.json"; status 'DELETE /samples/:id' "$DELETE_OUT" 200 -X DELETE -H "$AUTH" "$API/samples/$SAMPLE_ID"
MISSING="$TMP/missing.json"; status 'GET deleted file download' "$MISSING" 404 -H "$AUTH" "$API/files/$FILE_ID/download"
echo 'SMOKE OK'

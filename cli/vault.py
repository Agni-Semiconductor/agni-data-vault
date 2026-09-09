#!/usr/bin/env python3
"""Command-line client for the Agni Data Vault API."""
import argparse
import datetime as dt
import glob
import hashlib
import json
import os
import sys
from pathlib import Path

import requests

SAMPLE_COLUMNS = {"sample_id", "label", "family", "owner", "substrate", "substrate_size", "fab_location", "fabricated_by", "fabricated_on", "stack", "notes"}
MEASUREMENT_COLUMNS = {"measured_on", "kind", "instrument", "probe_station", "measured_by", "temperature_c", "device_address", "run_numbers", "pad_shape", "pad_dim_um", "pad_area_override", "notes"}
DEFAULT_FIELDS = {
    "sample": {key: {"key": key, "type": "layer_stack" if key == "stack" else "date" if key == "fabricated_on" else "text", "column_name": key} for key in SAMPLE_COLUMNS} | {"sweep_v": {"key": "sweep_v", "type": "number", "column_name": None}, "frequency_khz": {"key": "frequency_khz", "type": "number", "column_name": None}},
    "measurement": {key: {"key": key, "type": "integer" if key == "run_numbers" else "number" if key in {"temperature_c", "pad_dim_um", "pad_area_override"} else "date" if key == "measured_on" else "text", "column_name": key} for key in MEASUREMENT_COLUMNS} | {"sweep_v": {"key": "sweep_v", "type": "number", "column_name": None}, "frequency_khz": {"key": "frequency_khz", "type": "number", "column_name": None}},
}

class ApiError(Exception):
    def __init__(self, code, message): self.code, self.message = code, message

class VaultClient:
    def __init__(self, base_url, api_key, session=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session = session or requests.Session()
        self._schema = None
    def _request(self, method, path, **kwargs):
        headers = kwargs.pop("headers", {})
        headers = {"Authorization": "Bearer " + self.api_key, **headers}
        response = self.session.request(method, self.base_url + path, headers=headers, timeout=30, **kwargs)
        try: data = response.json()
        except ValueError: data = {}
        if not response.ok:
            error = data.get("error", {})
            raise ApiError(error.get("code", "http_error"), error.get("message", response.text or response.reason))
        return data
    def get(self, path, params=None): return self._request("GET", path, params=params)
    def post(self, path, body): return self._request("POST", path, json=body)
    def patch(self, path, body): return self._request("PATCH", path, json=body)
    def delete(self, path): return self._request("DELETE", path)
    def schema(self):
        if self._schema is None: self._schema = self.get("/api/schema")
        return self._schema
    def field_keys(self, entity):
        return {field["key"] for field in self.schema()["entities"][entity]["fields"] if field.get("active", True)}
    def upload_file(self, measurement_id, path):
        size = os.path.getsize(path); digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
        info = self.post("/api/files/upload-url", {"measurement_id": measurement_id, "filename": os.path.basename(path), "size_bytes": size, "sha256": digest.hexdigest()})
        headers = {"Content-Type": "application/octet-stream"}
        if info.get("token"): headers.update({"x-upsert": "false", "Authorization": "Bearer " + info["token"]})
        with open(path, "rb") as handle:
            response = self.session.put(info["signed_url"], data=handle, headers=headers, timeout=120)
        if not response.ok: raise ApiError("upload_failed", response.text or response.reason)
        return self.post("/api/files/" + info["file_id"] + "/register", {"size_bytes": size, "sha256": digest.hexdigest()})

def date_value(value):
    try: return dt.date.fromisoformat(value).isoformat()
    except ValueError: raise argparse.ArgumentTypeError("expected YYYY-MM-DD")

def coerce(value, field):
    kind = field.get("type", "text")
    if kind == "number": return float(value)
    if kind == "integer": return int(value)
    if kind == "bool":
        if value.lower() in {"true", "1"}: return True
        if value.lower() in {"false", "0"}: return False
        raise ValueError("expected true/false/1/0")
    if kind == "date": return date_value(value)
    if kind in {"json", "layer_stack"}: return json.loads(value)
    if kind == "multiselect": return value.split(",") if value else []
    return value

def dynamic_body(entity, remaining, fields, assumed):
    body, meta = {}, {}
    if len(remaining) % 2: raise UsageError("field flags require a value")
    for flag, raw in zip(remaining[::2], remaining[1::2]):
        if not flag.startswith("--"): raise UsageError("unexpected argument '" + flag + "'")
        key = flag[2:].replace("-", "_")
        if key not in fields: raise UsageError("unknown field '" + key + "' for " + entity + "; run: vault.py fields --entity " + entity)
        try: value = coerce(raw, fields[key])
        except (ValueError, json.JSONDecodeError, argparse.ArgumentTypeError) as exc: raise UsageError("invalid " + key + ": " + str(exc))
        (body if fields[key].get("column_name") is not None else meta)[key] = value
    body["meta"] = meta
    body["meta_status"] = {key: "assumed" for key in (assumed or "").split(",") if key}
    return body

class UsageError(Exception): pass

def print_table(items, columns):
    widths = [max(len(name), *(len(str(item.get(name, "") or "")) for item in items)) for name in columns]
    print("  ".join(name.ljust(width) for name, width in zip(columns, widths)))
    for item in items: print("  ".join(str(item.get(name, "") or "").ljust(width) for name, width in zip(columns, widths)))

def extract_globals(argv):
    parser = argparse.ArgumentParser(add_help=False); parser.add_argument("--json", action="store_true"); parser.add_argument("--dry-run", action="store_true"); parser.add_argument("--api-url"); parser.add_argument("--api-key")
    values, rest = parser.parse_known_args(argv)
    return values, rest

def build_parser():
    parser = argparse.ArgumentParser(prog="vault.py", description="Agni Data Vault CLI")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    parser.add_argument("--dry-run", action="store_true", help="print request without sending it")
    parser.add_argument("--api-url", help="override VAULT_API_URL")
    parser.add_argument("--api-key", help="override VAULT_API_KEY")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("schema")
    fields = sub.add_parser("fields"); fields.add_argument("--entity", choices=["sample", "measurement"])
    listing = sub.add_parser("list"); listing.add_argument("entity", choices=["samples", "measurements"]); listing.add_argument("--sample"); listing.add_argument("--q"); listing.add_argument("--family"); listing.add_argument("--substrate"); listing.add_argument("--limit", type=int); listing.add_argument("--offset", type=int)
    get = sub.add_parser("get"); get.add_argument("entity", choices=["sample", "measurement"]); get.add_argument("id"); get.add_argument("--files", action="store_true")
    sample = sub.add_parser("add-sample"); sample.add_argument("--sample-id", required=True); sample.add_argument("--assumed")
    measurement = sub.add_parser("add-measurement"); measurement.add_argument("--sample", required=True); measurement.add_argument("--measured-on", required=True, type=date_value); measurement.add_argument("--kind"); measurement.add_argument("--measured-by"); measurement.add_argument("--pad", nargs=2); measurement.add_argument("--area-um2", type=float); measurement.add_argument("--run", action="append", type=int); measurement.add_argument("--assumed")
    upload = sub.add_parser("upload"); upload.add_argument("measurement_id"); upload.add_argument("paths", nargs="+")
    return parser

def main(argv=None):
    globals_, rest = extract_globals(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try: args, unknown = parser.parse_known_args(rest)
    except SystemExit as exc: return exc.code
    client = VaultClient(globals_.api_url or os.getenv("VAULT_API_URL", ""), globals_.api_key or os.getenv("VAULT_API_KEY", ""))
    try:
        if args.command == "schema": result = client.schema(); print(json.dumps(result, indent=2)); return 0
        if args.command == "fields":
            schema = client.schema(); entities = [args.entity] if args.entity else ["sample", "measurement"]
            result = {entity: schema["entities"][entity]["fields"] for entity in entities}; print(json.dumps(result, indent=2)); return 0
        if args.command == "list":
            params = {key: value for key, value in vars(args).items() if key in {"q", "family", "substrate", "limit", "offset"} and value is not None}
            path = "/api/samples" if args.entity == "samples" else "/api/samples/" + args.sample + "/measurements"
            if args.entity == "measurements" and not args.sample: raise UsageError("list measurements requires --sample")
            result = client.get(path, params)
            if globals_.json: print(json.dumps(result))
            else: print_table(result["items"], ["sample_id", "label", "family", "substrate", "fabricated_on"] if args.entity == "samples" else ["id", "measured_on", "kind", "measured_by", "device_address", "pad_area_um2"])
            return 0
        if args.command == "get":
            result = client.get("/api/measurements/" + args.id, {"include": "files"} if args.files else None) if args.entity == "measurement" else client.get("/api/samples/" + args.id)
            print(json.dumps(result, indent=2)); return 0
        if args.command in {"add-sample", "add-measurement"}:
            entity = "sample" if args.command == "add-sample" else "measurement"
            try: fields = {f["key"]: f for f in client.schema()["entities"][entity]["fields"] if f.get("active", True)}
            except Exception:
                if not globals_.dry_run: raise
                fields = DEFAULT_FIELDS[entity]; print("schema unavailable, using built-in defaults", file=sys.stderr)
            body = dynamic_body(entity, unknown, fields, args.assumed)
            if entity == "sample": body = {"sample_id": args.sample_id, **body}; path = "/api/samples"
            else:
                body = {"measured_on": args.measured_on, **({"kind": args.kind} if args.kind else {}), **({"measured_by": args.measured_by} if args.measured_by else {}), **body}
                if args.pad: body.update({"pad_shape": args.pad[0], "pad_dim_um": float(args.pad[1])})
                if args.area_um2 is not None: body["pad_area_override"] = args.area_um2
                if args.run: body["run_numbers"] = args.run
                path = "/api/samples/" + args.sample + "/measurements"
            if globals_.dry_run: print(json.dumps({"method": "POST", "path": path, "body": body})); return 0
            print(json.dumps(client.post(path, body), indent=2)); return 0
        if args.command == "upload":
            for pattern in args.paths:
                for path in glob.glob(pattern):
                    try: print(json.dumps(client.upload_file(args.measurement_id, path)))
                    except ApiError as exc:
                        if exc.code == "duplicate_file": print("SKIP duplicate " + os.path.basename(path))
                        else: raise
            return 0
    except UsageError as exc: print(str(exc), file=sys.stderr); return 2
    except ApiError as exc: print("error " + exc.code + ": " + exc.message, file=sys.stderr); return 1

if __name__ == "__main__": sys.exit(main())

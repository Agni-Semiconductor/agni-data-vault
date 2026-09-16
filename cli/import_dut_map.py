#!/usr/bin/env python3
import argparse, json, os, sys

import yaml
from vault import ApiError, VaultClient


MAP_ROUTE = "vault.dut_sample_map"


def api(client, method, path, body=None):
    """Keep API use here so the unavailable map contract cannot be guessed elsewhere."""
    if path == MAP_ROUTE:
        # Calling an invented route would make an absent mapping look like an empty one.
        raise RuntimeError("vault API route for " + MAP_ROUTE + " is required to read and write the DUT-to-sample map")
    if method == "GET": return client.get(path)
    if method == "PUT": return client._request("PUT", path, json=body)
    raise ValueError("unsupported API method " + method)


def validate(entries, client):
    problems, dut_ids, sample_ids = [], set(), set()
    if not isinstance(entries, list): return ["YAML root must be a list of mappings"], []
    valid = []
    for index, entry in enumerate(entries, 1):
        if not isinstance(entry, dict):
            problems.append("entry " + str(index) + " must be a mapping")
            continue
        dut_id, sample_id = entry.get("dut_id"), entry.get("sample_id")
        if not isinstance(dut_id, str) or not dut_id.strip():
            problems.append("entry " + str(index) + " has an empty dut_id")
        elif dut_id in dut_ids:
            problems.append("entry " + str(index) + " repeats dut_id " + dut_id)
        else: dut_ids.add(dut_id)
        if not isinstance(sample_id, str) or not sample_id.strip():
            problems.append("entry " + str(index) + " has an empty sample_id")
        elif sample_id in sample_ids:
            problems.append("entry " + str(index) + " repeats sample_id " + sample_id)
        else: sample_ids.add(sample_id)
        # PROVENANCE IS REQUIRED, not optional-but-non-empty. A mapping with no stated basis --
        # a board label, a fab record, a notebook entry -- is a guess that will later be read as
        # fact, and this file is the only record of how anyone knew. The API route rejects a
        # create without it; validating here too means --dry-run cannot report success on a
        # file the server will refuse.
        note = entry.get("note")
        if note is None:
            problems.append("entry " + str(index) + " (" + str(dut_id) + ") has no note; provenance is required -- record how this mapping was established")
        elif not isinstance(note, str) or not note.strip():
            problems.append("entry " + str(index) + " has an empty note")
        if isinstance(dut_id, str) and dut_id.strip() and isinstance(sample_id, str) and sample_id.strip():
            valid.append({"dut_id": dut_id, "sample_id": sample_id, **({"note": entry["note"]} if entry.get("note") is not None else {})})
    for sample_id in sample_ids:
        try: api(client, "GET", "/api/samples/" + sample_id)
        except ApiError as exc:
            # Record lookup failures together; stopping here turns a bad file into one run per line.
            if exc.code == "not_found": problems.append("sample_id " + sample_id + " does not exist in the vault")
            else: problems.append("could not verify sample_id " + sample_id + ": " + exc.code + ": " + exc.message)
    return problems, valid


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run --dry-run first to inspect DUT-to-sample mapping changes.")
    parser.add_argument("path")
    parser.add_argument("--dry-run", action="store_true", help="print creates or changes without writing")
    parser.add_argument("--allow-remap", action="store_true", help="permit changing a DUT's mapped sample")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as handle: entries = yaml.safe_load(handle) or []
    client = VaultClient(os.getenv("VAULT_API_URL", ""), os.getenv("VAULT_API_KEY", ""))
    problems, desired = validate(entries, client)
    if problems:
        for problem in problems: print("error: " + problem, file=sys.stderr)
        return 1
    existing = api(client, "GET", MAP_ROUTE)
    existing_by_dut = {entry["dut_id"]: entry for entry in existing["items"]}
    creates = [entry for entry in desired if entry["dut_id"] not in existing_by_dut]
    remaps = [entry for entry in desired if entry["dut_id"] in existing_by_dut and existing_by_dut[entry["dut_id"]]["sample_id"] != entry["sample_id"]]
    note_updates = [entry for entry in desired if entry["dut_id"] in existing_by_dut and existing_by_dut[entry["dut_id"]]["sample_id"] == entry["sample_id"] and existing_by_dut[entry["dut_id"]].get("note") != entry.get("note")]
    if remaps and not args.allow_remap:
        for entry in remaps:
            print("REFUSE " + entry["dut_id"] + ": " + existing_by_dut[entry["dut_id"]]["sample_id"] + " -> " + entry["sample_id"] + "; re-pointing it silently re-attributes every measurement already registered through it. Pass --allow-remap if that is intended.", file=sys.stderr)
        return 1
    if not creates and not remaps and not note_updates:
        print("UNCHANGED: all DUT-to-sample mappings already match")
        return 0
    for entry in creates: print(("WOULD CREATE " if args.dry_run else "CREATE ") + json.dumps(entry, sort_keys=True))
    for entry in remaps + note_updates:
        # Include prior data so a changed provenance note cannot read as an unchanged confirmed link.
        print(("WOULD CHANGE " if args.dry_run else "CHANGE ") + json.dumps({"from": existing_by_dut[entry["dut_id"]], "to": entry}, sort_keys=True))
    if args.dry_run: return 0
    api(client, "PUT", MAP_ROUTE, {"items": desired})
    return 0


if __name__ == "__main__": sys.exit(main())

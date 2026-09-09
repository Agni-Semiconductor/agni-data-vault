#!/usr/bin/env python3
import argparse, json, os, sys
import yaml
from vault import VaultClient, ApiError

ROLES = ["substrate", "bottom_metal", "il_bot", "fe", "il_top", "top_metal"]
OWNERS = {"dhiren": "dhiren_pradhan", "spencer": "spencer_ware", "harsh": "harsh_yellai"}
def layer_notes(layer):
    if layer.get("origin"): return str(layer["origin"])
    dep = layer.get("deposition", {})
    if dep:
        parts = []
        if dep.get("method") is not None: parts.append(str(dep["method"]))
        if dep.get("power_W") is not None: parts.append(str(dep["power_W"]) + "W")
        if dep.get("T_C") is not None: parts.append(str(dep["T_C"]) + "C")
        return " ".join(parts)
    return ""
def map_entry(entry):
    stack_data, growth, pad = entry.get("stack", {}), entry.get("growth", {}), entry.get("pad", {})
    stack = []
    for role in ROLES:
        raw = stack_data.get(role)
        if role == "substrate" and isinstance(raw, str): raw = {"material": raw}
        if not isinstance(raw, dict) or raw.get("material") is None: continue
        stack.append({"role": role, "material": raw["material"], "t_nm": raw.get("t_nm"), "notes": layer_notes(raw)})
    body = {"sample_id": entry["id"], "label": entry.get("label", ""), "family": entry.get("family", ""), "owner": OWNERS.get(str(entry.get("owner", "")).lower(), str(entry.get("owner", "")).lower()), "stack": stack, "meta": {}, "meta_status": {}, "notes": entry.get("notes", "")}
    substrate = stack_data.get("substrate")
    if isinstance(substrate, str): body["substrate"] = substrate.lower()
    institution = str(growth.get("institution") or "")
    if "Penn" in institution: body["fab_location"] = "penn_jariwala_olsson_lab"
    elif "GE" in institution: body["fab_location"] = "ge_aerospace"
    elif "Ozark" in institution: body["fab_location"] = "ozark"
    elif institution: body["meta"]["fab_location_raw"] = institution
    date = growth.get("date")
    if date:
        date = str(date)
        body["fabricated_on"] = date + "-01" if len(date) == 7 else date
        if len(date) == 7: body["meta_status"]["fabricated_on"] = "assumed"
    extras = {"pad_diameter_um_default": pad.get("diameter_um_default"), "pad_shape_default": pad.get("shape"), "t_meas_c_default": entry.get("T_meas_C_default"), "folders": entry.get("folders"), "sc_frac": (stack_data.get("fe") or {}).get("sc_frac"), "paper": entry.get("paper"), "doi": entry.get("doi")}
    body["meta"].update({k:v for k,v in extras.items() if v is not None})
    for key, value in entry.get("status", {}).items():
        status = {"ASSUMED":"assumed", "UNKNOWN":"unknown"}.get(str(value).upper())
        if not status: continue
        target = "stack" if key.startswith("stack.") else "pad" if key.startswith("pad.") else "fab_location" if key == "growth.tool" else key.rsplit(".", 1)[-1]
        body["meta_status"][target] = status
    return body
def main(argv=None):
    parser = argparse.ArgumentParser(); parser.add_argument("path"); parser.add_argument("--dry-run", action="store_true"); parser.add_argument("--only")
    args = parser.parse_args(argv)
    with open(args.path, encoding="utf-8") as f: data = yaml.safe_load(f) or {}
    wanted = set(args.only.split(",")) if args.only else None
    bodies = [map_entry(e) for e in data.get("samples", []) if not wanted or e.get("id") in wanted]
    if args.dry_run: print(json.dumps(bodies)); return 0
    client = VaultClient(os.getenv("VAULT_API_URL", ""), os.getenv("VAULT_API_KEY", ""))
    for body in bodies:
        try: client.get("/api/samples/" + body["sample_id"]); print("SKIP " + body["sample_id"] + " exists")
        except ApiError as exc:
            if exc.code != "not_found": raise
            client.post("/api/samples", body); print("ADDED " + body["sample_id"])
    return 0
if __name__ == "__main__": sys.exit(main())

#!/usr/bin/env python3
"""Register finished bench campaigns as vault measurements."""
import argparse
import os
import sys

import requests


class ApiError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message


class VaultClient:
    def __init__(self, base_url=None, api_key=None, session=None):
        base_url = base_url or os.getenv("VAULT_API_URL", "")
        api_key = api_key or os.getenv("VAULT_API_KEY", "")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.session = session or requests.Session()

    def get(self, path, params=None):
        return self._request("GET", path, params=params)

    def post(self, path, body):
        return self._request("POST", path, json=body)

    def _request(self, method, path, **kwargs):
        headers = {"Authorization": "Bearer " + self.api_key}
        response = self.session.request(method, self.base_url + path, headers=headers, timeout=30, **kwargs)
        try:
            data = response.json()
        except ValueError:
            data = {}
        if not response.ok:
            error = data.get("error", {})
            raise ApiError(error.get("code", "http_error"), error.get("message", response.text or response.reason))
        return data


def extract_globals(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--api-url")
    parser.add_argument("--api-key")
    return parser.parse_known_args(argv)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="register_bench_runs.py",
        description="Register finished bench campaigns as vault measurements.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be created without writing; use this for a first run",
    )
    parser.add_argument("--api-url", help="override VAULT_API_URL")
    parser.add_argument("--api-key", help="override VAULT_API_KEY")
    return parser


def bench_runs(client):
    offset = 0
    while True:
        page = client.get("/api/bench/runs", {"limit": 100, "offset": offset})
        items = page.get("items", [])
        # Select campaign_runs where status <> 'running': this skips live campaigns and the
        # seven known zombie rows without maintaining a list that will go stale.
        for run in items:
            if run.get("status") != "running":
                yield run
        offset += len(items)
        if offset >= page.get("total", 0) or not items:
            return


def existing_measurement(client, sample_id, run_id, dut_id):
    # Both halves of the bench key are required: run IDs are unique only with their DUT, and
    # checking one half can report an unrelated board as already registered.
    page = client.get(
        "/api/samples/" + sample_id + "/measurements",
        {"meta.bench_run_id": run_id, "meta.bench_dut_id": dut_id, "limit": 1},
    )
    return bool(page.get("items", []))


def measurement_body(run):
    completed_at = run.get("completed_at")
    # measured_on is required by the measurement API. Taking the calendar date from the completed
    # timestamp preserves the recorded event date; using today's date would make an old run look new.
    if not isinstance(completed_at, str) or len(completed_at) < 10:
        return None
    body = {
        "measured_on": completed_at[:10],
        "bench_run_id": run.get("run_id"),
        "bench_dut_id": run.get("dut_id"),
    }
    # Set only kind, measured_on, instrument, and measured_by. Everything else stays `unknown`
    # for a human or a sure-only backfill -- a guessed value that looks confirmed is worse than an
    # absent one.
    for destination, source in (("kind", "kind"), ("instrument", "instrument"), ("measured_by", "operator")):
        if run.get(source) is not None:
            body[destination] = run[source]
    return body


def main(argv=None):
    globals_, rest = extract_globals(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        parser.parse_args(rest)
    except SystemExit as exc:
        return exc.code

    client = VaultClient(globals_.api_url, globals_.api_key)
    created = present = skipped = unmapped = 0
    try:
        runs = list(bench_runs(client))
        if not runs:
            print("created=0 already-present=0 skipped=0 unmapped=0")
            return 0

        # DUT identifiers and registry sample identifiers are unrelated namespaces. Deriving a
        # sample_id from a name that happens to match today silently misattributes a differently
        # named board later, so this must read vault.dut_sample_map explicitly.
        mappings = {mapping["dut_id"]: mapping["sample_id"] for mapping in client.get("/api/bench/dut-map").get("items", [])}
        for run in runs:
            dut_id, run_id = run.get("dut_id"), run.get("run_id")
            sample_id = mappings.get(dut_id)
            if not sample_id:
                # A missing map is reported and skipped, never derived: a plausible name-based
                # match silently attributes measurements to the wrong physical sample.
                unmapped += 1
                print("unmapped dut_id=%s run_id=%s" % (dut_id, run_id), file=sys.stderr)
                continue
            body = measurement_body(run)
            if not body or not run_id or not dut_id:
                # Do not manufacture a required date or a foreign-key pair; a fake value would
                # make malformed source data look like a valid completed campaign.
                skipped += 1
                print("skipped dut_id=%s run_id=%s reason=missing_required_run_fields" % (dut_id, run_id), file=sys.stderr)
                continue
            # Registration is idempotent, keyed on the bench run and DUT, so a 15-minute timer
            # cannot create duplicates. Checking first avoids using a conflict as routine control flow.
            if existing_measurement(client, sample_id, run_id, dut_id):
                present += 1
                continue
            if globals_.dry_run:
                # --dry-run writes nothing and is the documented first step.
                print("would-create dut_id=%s run_id=%s sample_id=%s" % (dut_id, run_id, sample_id))
                created += 1
                continue
            try:
                client.post("/api/samples/" + sample_id + "/measurements", body)
                created += 1
            except ApiError as exc:
                # The unique index is the final idempotency guard when two timer invocations
                # inspect before either inserts; reporting it as a failure would be misleading.
                if exc.code == "conflict" and existing_measurement(client, sample_id, run_id, dut_id):
                    present += 1
                else:
                    raise
    except ApiError as exc:
        # Do not use campaign_runs.n_measured as a proxy for child rows: it is written only at
        # the end of a run, so a live campaign with many device_tests misleadingly reports zero.
        # This script needs no count; a future implementation must count device_tests instead.
        print("created=%d already-present=%d skipped=%d unmapped=%d failure=%s" % (created, present, skipped, unmapped, exc.code))
        return 1
    except requests.RequestException:
        # A transport failure has no API error body; still print the counters so an unattended
        # timer does not look successful merely because its HTTP request never reached the vault.
        print("created=%d already-present=%d skipped=%d unmapped=%d failure=request_error" % (created, present, skipped, unmapped))
        return 1
    print("created=%d already-present=%d skipped=%d unmapped=%d" % (created, present, skipped, unmapped))
    return 0


if __name__ == "__main__":
    sys.exit(main())

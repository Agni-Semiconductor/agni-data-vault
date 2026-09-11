#!/usr/bin/env python3
"""Register finished bench campaigns as vault measurements.

NOT YET FUNCTIONAL, and it says so rather than half-working. Every invocation currently exits 1
with `failure=mapping_unavailable`, because the one thing it cannot do without guessing does not
exist yet: there is no API route that reads vault.dut_sample_map.

That mapping is the whole point. A bench DUT id (`2kb-dut-01`) and a vault sample id (a registry
key) are unrelated namespaces, and a derivation that works for today's names silently
misattributes measurements the first time somebody names a board differently. Misattributed data
that looks confirmed is worse than data that is absent, so this refuses rather than infers.

What the missing route must provide, so whoever adds it does not have to re-derive it:
  * a read of vault.dut_sample_map, returning sample_id for a dut_id;
  * upsert semantics keyed on (bench_run_id, bench_dut_id), so a 15-minute timer registering the
    same finished run twice does not create a second measurement;
  * a body that sets ONLY kind, measured_on, instrument and measured_by. Everything else stays
    `unknown` for a human or a sure-only backfill.

The rest of the script -- the status filter, the refusal to read campaign_runs.n_measured, the
dry-run path -- is written and carries its reasoning in comments. It is kept here so that
reasoning is not re-derived, not because it runs today.
"""
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


def main(argv=None):
    globals_, rest = extract_globals(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        parser.parse_args(rest)
    except SystemExit as exc:
        return exc.code

    client = VaultClient(globals_.api_url, globals_.api_key)
    created = present = skipped = 0
    try:
        runs = list(bench_runs(client))
        if not runs:
            print("created=0 already-present=0 skipped=0")
            return 0

        # DUT identifiers and registry sample identifiers are unrelated namespaces. Deriving a
        # sample_id from a name that happens to match today silently misattributes a differently
        # named board later, so this must read vault.dut_sample_map explicitly.
        #
        # The documented API has no route to read that mapping table. /devices/register-bench
        # confirms a mapping only by registering devices and returns no sample_id, so it cannot
        # supply the target sample for a measurement without inventing an API contract.
        # A future API route must make registration idempotent on bench_run_id plus bench_dut_id;
        # otherwise a timer registering the same run twice creates a second measurement.
        # Its POST body must set only kind, measured_on, instrument, and measured_by from the run,
        # plus that linkage key. Guessing any other value makes it look confirmed, which is worse
        # than leaving it unknown for a human or a sure-only backfill to fill in.
        skipped = len(runs)
        raise ApiError("mapping_unavailable", "no API route exposes vault.dut_sample_map")
    except ApiError as exc:
        # Do not use campaign_runs.n_measured as a proxy for child rows: it is written only at
        # the end of a run, so a live campaign with many device_tests misleadingly reports zero.
        # This script needs no count; a future implementation must count device_tests instead.
        print("created=%d already-present=%d skipped=%d failure=%s" % (created, present, skipped, exc.code))
        return 1


if __name__ == "__main__":
    sys.exit(main())

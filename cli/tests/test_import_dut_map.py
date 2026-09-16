import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import yaml

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import import_dut_map


class ImportDutMapTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "dut-map.yaml"

    def tearDown(self):
        self.tempdir.cleanup()

    def run_cli(self, entries, existing=None, args=()):
        self.path.write_text(yaml.safe_dump(entries), encoding="utf-8")
        writes = []

        def fake_api(_client, method, path, body=None):
            # The importer must query each sample without reaching the real vault in tests.
            if method == "GET" and path.startswith("/api/samples/"):
                return {"sample_id": path.rsplit("/", 1)[1]}
            if method == "GET" and path == import_dut_map.MAP_ROUTE:
                return {"items": existing or []}
            if method == "PUT" and path == import_dut_map.MAP_ROUTE:
                writes.append(body)
                return {"items": body["items"]}
            self.fail("unexpected API request: " + method + " " + path)

        out, err = io.StringIO(), io.StringIO()
        # Patch the importer's API seam so this test checks request intent, not HTTP transport.
        with patch.object(import_dut_map, "api", side_effect=fake_api):
            with redirect_stdout(out), redirect_stderr(err):
                code = import_dut_map.main([str(self.path), *args])
        return code, out.getvalue(), err.getvalue(), writes

    def test_validation_reports_all_entry_problems_and_exits_nonzero(self):
        code, _out, err, writes = self.run_cli([
            "not a mapping",
            {"dut_id": "dut-1", "sample_id": "sample-1", "note": "bench label"},
            {"dut_id": "dut-1", "sample_id": "sample-2", "note": "lab notebook"},
            {"dut_id": "dut-3", "sample_id": "sample-1", "note": "board photo"},
            {"dut_id": "", "sample_id": "", "note": "record"},
        ])
        self.assertNotEqual(code, 0)
        self.assertIn("entry 1 must be a mapping", err)
        self.assertIn("entry 3 repeats dut_id dut-1", err)
        self.assertIn("entry 4 repeats sample_id sample-1", err)
        self.assertIn("entry 5 has an empty dut_id", err)
        self.assertIn("entry 5 has an empty sample_id", err)
        self.assertEqual(writes, [])

    def test_provenance_note_is_required(self):
        code, _out, err, writes = self.run_cli([
            {"dut_id": "dut-1", "sample_id": "sample-1"},
        ])
        self.assertNotEqual(code, 0)
        self.assertIn("note", err)
        self.assertEqual(writes, [])

    def test_dry_run_does_not_write(self):
        code, out, _err, writes = self.run_cli([
            {"dut_id": "dut-1", "sample_id": "sample-1", "note": "bench label"},
        ], args=("--dry-run",))
        self.assertEqual(code, 0)
        self.assertIn("WOULD CREATE", out)
        self.assertEqual(writes, [])

    def test_unchanged_mapping_is_a_no_op(self):
        entries = [{"dut_id": "dut-1", "sample_id": "sample-1", "note": "bench label"}]
        code, out, _err, writes = self.run_cli(entries, existing=entries)
        self.assertEqual(code, 0)
        self.assertIn("UNCHANGED", out)
        self.assertEqual(writes, [])

    def test_remap_refusal_names_mapping_and_opt_in_flag(self):
        code, _out, err, writes = self.run_cli([
            {"dut_id": "dut-1", "sample_id": "sample-new", "note": "new evidence"},
        ], existing=[{"dut_id": "dut-1", "sample_id": "sample-old", "note": "old evidence"}])
        self.assertNotEqual(code, 0)
        self.assertIn("dut-1", err)
        self.assertIn("sample-old", err)
        self.assertIn("sample-new", err)
        self.assertIn("--allow-remap", err)
        self.assertEqual(writes, [])


if __name__ == "__main__": unittest.main()

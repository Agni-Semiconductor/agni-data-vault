import unittest

from cli.backfill import (
    executed_at_list,
    kind_agreement,
    kind_from_test_name,
    measured_on_from_runs,
    parse_filename,
    parse_folder,
    parse_settings_rows,
    resolve_kind,
    sample_queue_items,
)

SETTINGS_ROWS = [
    ["Run9602", None, None],
    ["Test Name", "dc-iv#1@1", None],
    ["Mode", "Line Sweep", None],
    ["Speed", "Fast", None],
    ["Last Executed", "08/27/2026 17:08:47", None],
    ["Clarius+ Version", "V1.13", None],
    ["Device Terminal", "B", "A"],
    ["Instrument", "SMU2", "SMU1"],
    ["Name", "BV", "AV"],
    ["Run9601", None, None],
    ["Test Name", "dc-iv#1@1", None],
    ["Mode", "Line Sweep", None],
    ["Last Executed", "08/27/2026 16:58:12", None],
    ["Clarius+ Version", "V1.13", None],
]


class FilenameTests(unittest.TestCase):
    def test_dc(self):
        info = parse_filename("20-DC-1.xlsx")
        self.assertEqual(info["pad_dim_um"], 20)
        self.assertEqual(info["kind"], "dciv")
        self.assertEqual(info["replicate"], 1)

    def test_pund(self):
        info = parse_filename("20-PUND-3.xlsx")
        self.assertEqual((info["pad_dim_um"], info["kind"], info["replicate"]), (20, "pund", 3))

    def test_break_suffix(self):
        info = parse_filename("20-DC-5-BREAK.xlsx")
        self.assertEqual((info["pad_dim_um"], info["kind"], info["replicate"]), (20, "dciv", 5))

    def test_double_xlsx(self):
        info = parse_filename("20-AC-2.xlsx.xlsx")
        self.assertEqual((info["pad_dim_um"], info["kind"], info["replicate"]), (20, "aciv", 2))

    def test_rejects(self):
        self.assertIsNone(parse_filename("foo.xlsx"))
        self.assertIsNone(parse_filename("20-DC-1.xls"))
        self.assertIsNone(parse_filename("screenshot.bmp"))


class FolderTests(unittest.TestCase):
    def test_300c(self):
        self.assertEqual(parse_folder("300C"), (300, None))

    def test_20c(self):
        self.assertEqual(parse_folder("20C"), (20, None))

    def test_check_after_400(self):
        self.assertEqual(parse_folder("20C-check-after400C to RT"), (20, "after 400C"))

    def test_check_after_600(self):
        self.assertEqual(parse_folder("20C check-after600C to RT"), (20, "after 600C"))

    def test_rt(self):
        self.assertEqual(parse_folder("RT"), (20, None))


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.runs = parse_settings_rows(SETTINGS_ROWS)

    def test_two_runs(self):
        self.assertEqual([r["run"] for r in self.runs], [9602, 9601])

    def test_earliest_date(self):
        self.assertEqual(measured_on_from_runs(self.runs), "2026-08-27")

    def test_executed_list(self):
        self.assertEqual(executed_at_list(self.runs),
                         ["2026-08-27T16:58:12", "2026-08-27T17:08:47"])

    def test_clarius_version(self):
        self.assertEqual(self.runs[0]["clarius_version"], "V1.13")

    def test_kind_from_test_name(self):
        self.assertEqual(kind_from_test_name("dc-iv#1@1"), "dciv")
        self.assertEqual(kind_from_test_name("hysteresis#2"), "aciv")
        self.assertEqual(kind_from_test_name("ac iv#1"), "aciv")
        self.assertEqual(kind_from_test_name("pund#1"), "pund")
        self.assertEqual(kind_from_test_name("c-v#1"), "cv")
        self.assertIsNone(kind_from_test_name("mystery"))


class KindAgreementTests(unittest.TestCase):
    def test_agree(self):
        kind, reason = kind_agreement("dciv", ["dc-iv#1@1"])
        self.assertEqual(kind, "dciv")
        self.assertIsNone(reason)

    def test_disagreement_queues(self):
        kind, reason = kind_agreement("dciv", ["pund#1"])
        self.assertIsNone(kind)
        self.assertIn("pund", reason)
        self.assertIn("dciv", reason)

    def test_missing_token_queues(self):
        kind, reason = kind_agreement(None, ["dc-iv#1@1"])
        self.assertIsNone(kind)
        self.assertIsNotNone(reason)


class ResolveKindTests(unittest.TestCase):
    def test_e1_module_agrees(self):
        kind, cls, _src, reason = resolve_kind("pund", [], ["pundasyTest"])
        self.assertEqual((kind, cls, reason), ("pund", "E1", None))

    def test_e2_token_only(self):
        kind, cls, _src, reason = resolve_kind("aciv", [], ["doubleSweepSeg"])
        self.assertEqual((kind, cls, reason), ("aciv", "E2", None))

    def test_conflict_queues(self):
        kind, cls, _src, reason = resolve_kind("cv", ["dc-iv#1@1"], [])
        self.assertIsNone(kind)
        self.assertIsNone(cls)
        self.assertIn("dciv", reason)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.items = sample_queue_items("HY_20nm_highT_0827", "26_08_27_20Hfcap_highT_HY")

    def test_pad_shape_queued_with_circle_candidate(self):
        pads = [i for i in self.items if i["field"] == "pad_shape"]
        self.assertEqual(len(pads), 1)
        self.assertEqual(pads[0]["candidate_value"], "circle")
        self.assertIn("45 nm", pads[0]["reason"])
        self.assertEqual(pads[0]["entity"], "sample")

    def test_stack_substrate_fab_queued(self):
        fields = {i["field"] for i in self.items}
        self.assertEqual(fields, {"stack", "substrate", "fab_location", "fabricated_on", "pad_shape"})
        stack = next(i for i in self.items if i["field"] == "stack")
        self.assertIn("20Hfcap", stack["candidate_value"])


if __name__ == "__main__":
    unittest.main()

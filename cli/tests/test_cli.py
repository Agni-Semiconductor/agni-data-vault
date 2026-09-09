import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout, redirect_stderr

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import vault
from import_samples_yaml import map_entry

class CliTests(unittest.TestCase):
    def run_cli(self, args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err): code = vault.main(args)
        return code, out.getvalue(), err.getvalue()
    def test_measurement_dry_run_body(self):
        code, out, _ = self.run_cli(["add-measurement", "--sample", "HfN_20_0421", "--measured-on", "2026-04-21", "--kind", "dciv", "--measured-by", "dhiren_pradhan", "--pad", "circle", "25", "--run", "4482", "--sweep-v", "18", "--dry-run"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["body"], {"measured_on":"2026-04-21", "kind":"dciv", "measured_by":"dhiren_pradhan", "pad_shape":"circle", "pad_dim_um":25.0, "run_numbers":[4482], "meta":{"sweep_v":18.0}, "meta_status":{}})
    def test_square_pad(self):
        code, out, _ = self.run_cli(["add-measurement", "--sample", "X", "--measured-on", "2026-04-21", "--pad", "square", "0.22", "--dry-run"])
        self.assertEqual(code, 0); self.assertEqual(json.loads(out)["body"]["pad_dim_um"], .22)
    def test_unknown_field(self):
        code, _, err = self.run_cli(["add-sample", "--sample-id", "X", "--not-a-field", "v", "--dry-run"])
        self.assertEqual(code, 2); self.assertIn("unknown field 'not_a_field'", err)
    def test_yaml_mapping(self):
        import yaml
        entry = yaml.safe_load('''
id: HfN_20_0421
family: HfN_20
label: test
owner: Dhiren
stack:
  top_metal: {material: Al, t_nm: null}
  il_top: {material: AlOx, t_nm: 1.5, origin: native}
  fe: {material: AlScN, t_nm: 20, sc_frac: 0.36}
  il_bot: {material: HfOx, t_nm: 3.0, origin: native-on-HfN}
  bottom_metal: {material: HfN, t_nm: 100, deposition: {method: reactive DC sputter, power_W: 300, T_C: 500}}
  substrate: Sapphire
pad: {shape: circle, diameter_um_default: 25}
growth: {institution: Penn (Jariwala/Olsson), date: 2026-04}
T_meas_C_default: 25
folders: [4_21_HfN]
status: {pad.diameter_um_default: ASSUMED, stack.il_top.t_nm: ASSUMED, growth.tool: UNKNOWN}
''')
        body = map_entry(entry)
        self.assertEqual(body["owner"], "dhiren_pradhan"); self.assertEqual(body["substrate"], "sapphire")
        self.assertEqual(body["fabricated_on"], "2026-04-01"); self.assertEqual(body["meta_status"], {"fabricated_on":"assumed", "pad":"assumed", "stack":"assumed", "fab_location":"unknown"})
        self.assertEqual(body["stack"][1]["notes"], "reactive DC sputter 300W 500C")

if __name__ == "__main__": unittest.main()

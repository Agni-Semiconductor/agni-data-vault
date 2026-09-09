# Integration notes — 2026-09-09

- `api/_lib/router.js`: removed the `PUT` aliases; item updates now accept PATCH only.
- `api/_lib/validate.js`: dates now round-trip through calendar components.
- `api/_lib/fieldDefs.js`: required values that coerce to null are rejected as required.
- `api/_lib/resources/samples.js`: conditional updates include `updated_at` and turn no matched row into conflict.
- `api/_lib/resources/measurements.js`: applied the same conditional update protection.
- `api/_lib/resources/files.js`: preserve unknown-key warnings, validate register fields, and reject malformed inline base64.
- `api/_lib/resources/stats.js`: recent rows include the human sample key and FK UUID.
- `src/main.tsx`: loads the uPlot stylesheet alongside the app stylesheet.
- `src/lib/api.ts`: aligns browser stats data with the API recent-row shape while retaining the page compatibility alias.
- `tests/api-core.test.ts`, `tests/api-files.test.ts`, and `tests/api-resources.test.ts`: cover the revised validation, warnings, conditional predicates, and stats shape.
- `tests/api-admin.test.ts`: removed the unused destructured `id` binding.

`node --check` passed for every API source file. No unresolved contract conflicts found.

# Backfill and labeling campaign — plan

> **Status (2026-09-11): the storage constraint that shaped this plan is gone, one of its two
> compromises is gone with it, and the replacement figure this header carried on 2026-09-10 was
> itself wrong.**
>
> This plan was written against a 1 GB hosted Supabase tier holding a 4,289 MB corpus, which is
> why it defers a Pro upgrade, excludes the 128×128 mega run, and calls the 16,821 campaign CSVs
> "pointer-only". That tier is no longer the target.
>
> **WRONG, and this header is what said it: "on `edaserver` there is a 1 TB allocation".** There
> is no single allocation. Read off the box on 2026-09-11 there are four volumes, and the way they
> differ is the part that matters:
>
> | Mount | Size | Used | Redundancy | What lives there |
> |---|---|---|---|---|
> | `/` | 888 G | 28 G | **RAID1**, two NVMe | PostgreSQL — `PGDATA=/var/lib/pgsql/17/data`, **861 G free** |
> | `/storage` | 3.8 T | 824 G | **RAID1**, two NVMe | — |
> | `/srv/nextcloud` | 7.3 T | 55 G | **single disk, no RAID** | the nightly `fedbench` archive |
> | `/mnt/nasbackup` | 11 T | 4.6 T (6 T free) | NFS → `10.10.10.50:/volume1/server-backups` | — |
>
> **No storage upgrade is needed for any phase and no phase is excluded for size** — the entire
> 4,289 MB corpus is half a percent of the 861 G free on the mirrored root — but "it all fits on
> one big disk" was never the reason and is not the reason now. Which volume a byte lands on is a
> separate question from whether there is room for it, and the volume this plan leans on for
> evidence, `/srv/nextcloud`, is the one with no redundancy.
>
> **Pointer-only turned out to be the right design rather than a budget compromise, and it is now
> implemented.** The storage-pressure half of the original argument is dead; the duplication half
> was always the load-bearing one and nothing above touches it. `vault.files.bucket` (migration
> `0108`) lets a vault `files` row point at `bucket='bench', storage_path='captures/…'`, and `GET /api/files/:id/content` serves it from the
> bench's own objects. Those bytes are already on the same disk — the nightly archive writes
> `<archive>/objects/bench/<storage_path>`, byte-for-byte the tree `fed_storage` serves — so
> copying them into a `vault/` bucket would make a *third* copy of bytes that are already there.
> Zero duplicate bytes for 16,821 files. `bucket='bench'` rows are read-only in the vault, enforced
> twice: `files.js::remove` returns 403, and `fed_storage`'s `DELETABLE_BUCKETS` refuses
> independently.
>
> **The mega run needs a determination, not a decision.** Compare `select content_sha256 from
> public.captures` against the archive's hashes for `Agni/data/August 1st 128 mega run`. If they
> match, they are the same bytes and pointers are correct — 2,328 MB saved and "pointer-only" was
> right all along, merely badly named. If they do not, it is a separate export and should be
> uploaded; 2,328 MB against 861 G free is nothing. **Either way the answer comes from the hashes,
> not from a storage budget**, which is the sentence this header exists to replace.
>
> **What that hash comparison reads, and what it does not prove.** The other side of the comparison
> is the nightly `fedbench` archive under `/srv/nextcloud`, and it is **healthy and current**: it
> last ran 2026-09-11 at 02:07:43 to watermark `captures.id <= 25794`, 51,671 rows across 11
> tables, an object tree of **904.0 MB in 25,786 files**, manifest written to
> `/srv/nextcloud/fedbench/manifests/`. Every `fedbench-*` timer fires on schedule, so the hashes
> are there to compare against today. But `fedbench-verify` has **never run once** —
> `ExecMainStartTimestamp` is empty, and it next fires 2026-10-01 — so **the archived bytes are
> provably intact and nobody has ever proved they come back as a working database**. A hash match
> proves the mega run's bytes are the same bytes; it proves nothing about restorability, and no
> part of this campaign should be read as having proved it.
>
> Two different things in this repo are called "the archive", and conflating them makes the
> comparison above look circular: the **corpus** is the 4,289 MB of source data this plan ingests,
> the **archive** is the 904.0 MB nightly pull of bench objects. Every size in §3 is the corpus.
>
> Everything below about evidence classes, the sure-only rule, the review queue and the hard rules
> for agents is **unchanged and still governs** — that is the part of this plan that was never
> about storage. The `meta.external` shape it describes now has a real implementation in
> `bench_dut_id`/`bench_run_id` and the `vault.measurement_bench_run` view; keep reading
> `meta.external` as a fallback, stop writing it.

Goal: get Agni's existing measurement archive into the Data Vault with labels an agent is **certain** of, and a review queue for everything else. Run as a model-manager delegation (`2026-09-10-backfill`), Fable managing, GLM 5.3 Flash doing most of the work, GPT Terra held for the harder reading and reviews because the OpenAI quota is close to its limit.

## 1. The rule: label only what the evidence proves

Every value written to the vault carries an evidence class in `meta.evidence[<field>] = {class, source}` and is marked `meta_status = confirmed`. Anything that does not meet one of these classes is **not written**; it goes to the review queue with the candidate value and the evidence, for Spencer to accept in the app.

| class | source | fields it may set | example |
|---|---|---|---|
| E1 | Instrument metadata inside the file (Clarius `Settings` sheet) | measured_on (from `Last Executed`), instrument (`k4200a_clarius`), kind (from test name / columns), meta.compliance_a, meta.current_range, frequency_khz | `Last Executed 2026-05-22T10:03:37` |
| E2 | Deterministic filename tokens | run_numbers (`Run2284`), measured_on (`05-22-2026`, must agree with E1 when both exist), kind (`DC-IV`, `AC IV`, `PUND`, `CV`, `res2t`), pad_dim_um (`20um`), device_address (`BE1 TE 1`, `D3`), sweep_v (`6.5 V`), frequency_khz (`10 kHz`), measured_by (prefix is exactly one known person: `Dhiren`, `Spencer`) | `Spencer Site@1 Basic Tests capacitor AC IV#1 BE1 TE 1 07-24-2026.xls` |
| E3 | Folder path tokens | temperature_c (`300C`, `RT`), pad_dim_um (`AC_20um`, `20-DC-3` → 20 µm), device_address (`Device 1`), meta.pulse_width (`10 us pulse`), the sample container (top-level folder) | `26_08_27_20Hfcap_highT_HY/300C/20-DC-3.xlsx` |
| E4 | Spencer's registry `Model/samples.yaml` | stack, substrate, fab_location, fabricated_on, pad default, T default — imported **with the registry's own status flags** (confirmed / assumed / unknown). These are Spencer's declarations, not agent guesses. | `HfN_20_0421: stack.fe.t_nm 20 (confirmed), pad 25 µm (ASSUMED)` |
| E5 | Text evidence in or referenced by the folder (`Notes.txt`, `README.md`, `REPORT.md`, `.pptx` slide text) that names the folder, date or sample explicitly and states the value verbatim | any sample or measurement field, always with a citation (`file, slide n, quoted line`) | `08-07 deck, slide 12: "HfN 100 nm / AlScN 5 nm / Al, d = 25 µm"` |

Hard rules for agents: never infer a stack from a folder name alone; never assign `measured_by` from a project prefix (`FeCap`, `MIM Yunfei Dhiren`) or from who owns the folder; never copy a value from one folder to a sibling; never upload a file twice (sha256); never delete or overwrite an existing vault row. If a field is uncertain, the agent writes nothing and files a queue item.

## 2. What already exists (reuse, do not rebuild)

- `Model/data/cache/inventory.csv` (2,107 rows): per Clarius file `path, sha1, kind, run, timestamp (Settings Last Executed), sample_id (registry rule), diameter_um, T_meas_C, v_max, v_min, channel, columns, test_name, compliance, current_range, f_Hz, map_reason`. Built by `python -m fedmodel.data.pipeline`; 2,102 parsed OK, 364 UNMAPPED, 8 byte-identical duplicates.
- `Model/data/cache/quality.csv`: derived metrics per file (on/off, Vc±, noise floor, clipped/short/open flags, Pr). These go into `files.parsed.metrics` as-is, labelled `source: fedmodel quality v4`.
- `Model/samples.yaml` (20 samples) and the vault importer `cli/import_samples_yaml.py` (already maps `status:` to `meta_status`).
- `cli/vault.py` (API client with signed-URL upload, sha256 dedupe) and `docs/API.md`.
- Vault field mechanism: new fields needed by the campaign are rows, not migrations.

Caveat on `inventory.csv`: `diameter_um` and `T_meas_C` there are registry defaults (often ASSUMED). The backfill tool recomputes pad and temperature from E2/E3 tokens and writes them only on a token hit; the registry default is attached as a queue suggestion instead.

## 3. Scope and storage

| corpus | files | bytes | plan |
|---|---|---|---|
| `Agni/data` Clarius exports (`.xls/.xlsx`) | 2,106 | see §3a | Phase A — upload bytes + full labels |
| `Agni/data/supabase campaigns` board CSVs | 16,821 | 1,012 MB | **not uploaded**; already in the `automated-testing` Supabase project. Phase C registers one measurement per campaign run with `meta.external = {project: yabtiaqddwurmurmowvk, table: captures, campaign_run_id}` and attaches only the derived summary CSVs (manifest, device_labels_v2, yield) |
| `Agni/data/August 1st 128 mega run` (128×128 board run, excluded from the registry inventory) | 4,398 | 2,328 MB | Phase C **determination, not a decision**: compare `public.captures.content_sha256` against the archive's hashes. Match → same bytes, so pointers; no match → a separate export, uploaded as one measurement per board run. It is 54% of the corpus, and that fraction now decides nothing — 2,328 MB against 861 G free is noise. **The hashes decide, not the size.** |
| other 8x8 / board / socket folders (`8x8 Board`, `7_27 full8x8test`, `8x8 Testing Board 7_13`, `7_24 D2P2 8x8 samples`, `8_4 HEATED Write disturb 8x8`, `8_26 Socket Testing`, `9_4 Board Testing`) | ~860 | ~110 MB | Phase A2 — same tool; sample container per board/chip, device_address from filename tokens; labels limited to E1–E3 |
| `Work Flows/Data Processing/FeD Electrical Data` | ~1,158 | not yet measured | Phase B — same tool, second root |
| `Model/data/raw` (literature + Han2026 crossbar) | ~408 | not yet measured | Phase B, tagged `meta.origin = literature` where the registry says so |
| images (`.png` 2,853 = 290 MB, `.bmp` 93 = 313 MB) | 2,946 | 603 MB | plots and screenshots; attach only when a filename ties them to a run (`DC-IV_Run4482.png`), as `kind: plot_png`; the 93 BMP microscope/scope screenshots wait for Phase B |
| decks/notes used as evidence (`.pptx` 8 files 23.5 MB, `.md`, `.txt`) | ~90 | 24 MB | not uploaded as measurement files; cited in `meta.evidence`; a deck is attached once to its sample as `kind: other` |

Whole corpus: 4,289 MB. **Wrong here too, by inheritance from the free tier: "everything beyond Phase A2 needs Pro or pointers."** No phase is bounded by capacity any more — corpus and archive together are under 1% of the 861 G free on `/`. What still bounds Phase C is **duplication**: the campaign CSVs are already objects in the `bench` bucket, so a copy under `vault/` would be a third copy of bytes on the same disk.

§3a Storage numbers (from `inventory.csv` sizes, 2026-09-09):

| kind | files | MB |
|---|---|---|
| dciv | 1,422 | 47.5 |
| pulse | 447 | 138.6 |
| aciv | 117 | 10.5 |
| pund | 75 | 42.2 |
| res2t | 29 | 0.3 |
| cv | 16 | 0.2 |
| **Phase A total** | **2,106** | **239.2** (avg 116 kB; 364 unmapped = 41.7 MB; 8 duplicates) |

**No Pro upgrade is scheduled before any phase; there is no tier to upgrade.** The Phase B caveat that sat beside that sentence is not a storage-capacity claim and still holds: the second roots' size is not yet measured because the OneDrive folders are partly cloud-only placeholders, so a byte scan over them stalls — the executor must expect on-demand hydration and read files sequentially. The 16,600 board-campaign CSVs are still never uploaded, now for the duplication reason rather than the budget one (Phase C is pointers only).

## 4. Architecture: deterministic first, agents second, humans last

```
inventory.csv + quality.csv + samples.yaml + folder walk
        │  (1) plan builder: cli/backfill.py plan   → backfill/plan.jsonl  (one line per file: sample, measurement, fields, evidence, queue items)
        ▼
folder dossiers (LLM, one per top-level folder)   → backfill/dossiers/<folder>.json  (E3/E5 evidence with citations, review notes)
        │  merged into plan by the plan builder (only E-class-qualified values are applied)
        ▼
        (2) checker: cli/backfill.py check        → every applied value has an evidence class; counts; sample of 30 for review
        ▼
        (3) executor: cli/backfill.py run --batch <id> [--limit N] → API calls, resumable, idempotent; writes backfill/state.sqlite
        ▼
        (4) queue: backfill/review_queue.csv + meta.review_needed=true on the affected rows → Spencer accepts/rejects in the app
```

Why this shape: 90% of the labels are mechanical and provable (E1/E2/E4). Agents are expensive and fallible at exactly the "is this the same sample?" question, so they only produce dossiers with citations, and the deterministic checker decides what gets written. A single `batch_id` on every row makes rollback one command (`cli/backfill.py rollback --batch <id>`).

Data model additions (all `field_definitions` rows, no migration): measurement `batch_id` (text, meta, filterable), `review_needed` (bool, meta, show_in_table), `evidence` (json, meta), `compliance_a` (number, meta), `pulse_width_us` (number, meta); sample `source_folder` (text, meta), `review_needed` (bool, meta), `evidence` (json, meta). Provisional sample containers for unmapped folders use `sample_id = F_<folder-slug>` (e.g. `F_7_30_MTV`), `label = <folder name>`, no stack, `review_needed = true`; they exist so files have a home, and Spencer can merge them into real samples later (a `merge-sample` CLI command is part of the tool).

Grouping rule: one vault measurement per Clarius run file (Run number + timestamp are unique per file). Multi-sheet PUND workbooks (one sheet per run) become one measurement per workbook with `run_numbers` = all sheet runs. Board campaigns: one measurement per campaign run.

## 5. Parts, routing and budgets (model-manager run `2026-09-10-backfill`)

OpenAI quota is near its cap, so Terra is limited to the parts that need careful reading; GLM 5.3 Flash (OpenRouter, ~$0.02 per part) takes the volume. No Zen free models (Agni-internal data). Sonnet/Opus only if GLM and Terra both fail a part.

| # | part | kind | model | est | deliverable |
|---|---|---|---|---|---|
| 0 | contract + specs | plan | Fable | 8k | `docs/BACKFILL_CONTRACT.md`: evidence classes, plan.jsonl schema, dossier.json schema, queue CSV columns |
| 1 | corpus scan | retrieve | GLM script | 10k | `backfill/scan.json` bytes/counts per corpus. **No storage decision rides on it any more** — it feeds the Phase C sha256 comparison and the coverage report |
| 2 | field definitions for the campaign | convert | GLM | 8k | SQL/API calls adding the rows in §4 (idempotent) |
| 3 | `cli/backfill.py plan` | draft-code | GLM (Terra review) | 40k | reads inventory/quality/registry, walks folders, emits plan.jsonl with evidence; dry-run report; unit tests on 20 real filenames |
| 4 | deck/notes text extraction | draft-code | GLM | 15k | `cli/extract_evidence.py`: python-pptx + md/txt → `backfill/evidence/<folder>/*.txt` with slide numbers (deterministic, no LLM) |
| 5 | folder dossiers, easy set | analyze (LLM) | GLM, 3 in parallel, one folder per dispatch | ~4k × ~45 folders | folders whose only evidence is names/notes: `dossiers/<folder>.json` with E3 values + citations + queue items |
| 6 | folder dossiers, deck set | analyze (LLM) | Terra, capped at ~15 dispatches | ~8k × ~15 | folders with pptx/README evidence (MINDS decks, high-T series, Ozark, GE): same schema, E5 citations mandatory |
| 7 | dossier checker | draft-code | GLM | 15k | `cli/backfill.py check`: schema validation, every value has class+source, citations resolve to real files/slides, cross-folder copy detection |
| 8 | executor + rollback | draft-code | Terra | 35k | `cli/backfill.py run|rollback|merge-sample`, resumable state, rate limit, batch_id |
| 9 | pilot | integrate | GLM runs it, Terra reads results | 20k | `--limit 100` on `05_22_HfN` and one unmapped folder; verify in the app; fix; then full Phase A |
| 10 | review sample | review | Terra read-only (30 random measurements vs source files) | 20k | verdict + false-positive rate; campaign proceeds only if 0 wrong confirmed values |
| 11 | coverage report | docs | GLM draft, Fable polish | 10k | `backfill/REPORT.md`: files uploaded, % fields confirmed by class, queue size by reason, folders needing Spencer |

Estimated pool use: GLM ~330k tokens (≈ $0.10), Terra ~250k (well under one Codex session of today's run), Fable ~25k (specs + verdicts). If the OpenAI limit trips mid-run, parts 6, 8 and 10 fall back to GLM with a stricter spec and a mandatory second GLM pass as reviewer.

## 6. Order of operations

1. Part 0–2 (one hour): contract, scan, field rows. Spencer confirms the provisional-sample naming; there is no longer a Pro upgrade to decide.
2. Parts 3, 4, 7 in parallel on GLM; part 5 dossiers start as soon as part 4's extracted text exists.
3. Part 6 on Terra while GLM works; part 8 on Terra after part 3's plan schema is frozen.
4. Part 9 pilot: 100 files, checked in the app (plots render, fields show provenance chips, queue items visible via the `review_needed` filter).
5. Full Phase A run (≈ 2,100 files; at ~1 file/s about 40 minutes), then part 10 review, then part 11 report.
6. Phase B (second roots) and Phase C (campaign pointers) reuse the same tool with new roots; each is its own batch_id.

## 7. What Spencer sees at the end

- Every Clarius file in the vault, attached to a measurement with instrument-proven date, kind, run number, and any pad/temperature/device tokens the names carried, plus the quality metrics from the model pipeline.
- Samples: the 20 registry samples with their real stacks and provenance flags, plus provisional `F_<folder>` containers for the rest, each flagged for review with a dossier of the evidence found.
- A review queue (CSV plus in-app filter) listing, per item: the field, the candidate value, the evidence, and why it fell short of "sure". Accepting an item is one click in the edit form (the provenance chip flips to confirmed).
- A coverage report and the delegation ledger.

## 8. Decisions needed from Spencer before part 3 starts

1. ~~Supabase Pro now, or Phase A on the free tier first (depends on §3a numbers).~~ **Answered by the box rather than by Spencer: there is no tier and no upgrade.** One real storage question outlives it, and it is not a budget: the archive this campaign would read its comparison hashes from sits on `/srv/nextcloud`, the **one volume with no redundancy**, and `fedbench-verify` has never run — so Phase C may depend on those hashes, but nothing here may be read as evidence that they are recoverable.
2. Provisional sample naming `F_<folder-slug>` acceptable? Alternative: leave unmapped files under a single `UNSORTED` sample.
3. OpenAI cap: hold Terra to ~15 dossier dispatches plus the executor and review, or push everything to GLM from the start.
4. Whether decks/notes may be uploaded to the vault as sample attachments (they are Agni-internal; storage cost is small).

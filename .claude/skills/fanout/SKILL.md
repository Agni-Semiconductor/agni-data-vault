---
name: fanout
description: Dispatch a batch of coding tasks in parallel to cheap OpenRouter models via the opencode CLI, each in its own git worktree. Use when work splits into several independent chunks that can run concurrently, or when the user asks to fan out, parallelise, or farm out tasks. Sizes the model to each task's difficulty.
---

# Fanout

Runs several headless `opencode` agents at once, each on its own OpenRouter
model in its own git worktree, then hands back a staged diff per task for
review. The script sits next to this file: [`fanout.sh`](fanout.sh).

```bash
bash .claude/skills/fanout/fanout.sh tasks.jsonl 4    # 4 workers in parallel
```

## Writing tasks.jsonl

One JSON object per line. `id` and `prompt` are required; `tier` defaults to
`standard`.

```json
{"id":"retry-logic","tier":"standard","prompt":"Add exponential backoff to the fetch helper in src/api.ts. Three retries, base 200ms."}
{"id":"rename-vars","tier":"trivial","prompt":"Rename the variable `d` to `elapsedMs` throughout src/timer.ts. Change nothing else."}
{"id":"cache-bug","tier":"hard","prompt":"Cache entries are occasionally served after eviction. Find the race in src/cache.ts and fix it."}
```

`id` becomes the worktree directory and branch name, so keep it filesystem-safe.

## Choosing a model

**Default to the account's ChatGPT subscription.** opencode holds it as an
`oauth` provider alongside the OpenRouter API key, so a subscription model is
billed to the plan rather than per token and the run reports `cost_usd` of 0.
Set it explicitly with `model`, which overrides `tier`:

```json
{ "id": "gnarly", "model": "openai/gpt-5.6-terra", "prompt": "..." }
```

Scale within the subscription by how much judgement the task needs:

| complexity | use for                                                                                 | model                      |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------- |
| light      | Mechanical work with one obvious right answer, or prose from a spec you already wrote.  | `openai/gpt-5.6-luna-fast` |
| standard   | Real code against a clear spec: one to three files, the solution shape already decided. | `openai/gpt-5.6-luna`      |
| complex    | Multi-file reasoning, tricky debugging, or a design decision the prompt leaves open.    | `openai/gpt-5.6-terra`     |

**Owner rule (2026-09-10): subscription workers use `gpt-5.6-terra` and
`gpt-5.6-luna` only.** Not `gpt-5.5`, not `gpt-5.6-sol`, not `gpt-6-astra`,
regardless of what `opencode models` lists. The luna/terra split above is a
working default, not a measurement; adjust it from results, not from names.

Run `opencode models | grep '^openai/'` before relying on a name -- the list
changes, and a wrong name fails the task at $0, which looks like every other $0
failure. `-fast` variants exist for most of these when latency matters more
than depth.

## Falling back to OpenRouter

The OpenRouter tiers stay useful for **large fan-outs and easy work**: a batch
of a dozen mechanical tasks costs cents, runs fully in parallel, and does not
consume subscription capacity. Use `tier` and let the script pick.

| tier       | use for                                                                                                                   | model                 | $/M in | $/M out |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------ | ------- |
| `trivial`  | Mechanical, one obvious right answer. Renames, boilerplate, moving text, generating a file from a spec you already wrote. | `openai/gpt-oss-20b`  | 0.030  | 0.130   |
| `standard` | Real code against a clear spec. One or two files, solution shape already decided. **Default when no model is set.**       | `openai/gpt-oss-120b` | 0.037  | 0.170   |
| `hard`     | Ambiguous spec, multi-file reasoning, tricky debugging, or a design decision the prompt doesn't settle.                   | `z-ai/glm-5.3-flash`  | 0.075  | 0.250   |

`glm-5.3-flash` is a hard ceiling on the OpenRouter side. **Do not reach for
the full `glm-5.3`.** Measured on four route- and test-writing tasks it cost
**$1.10 to produce one file**: three of the four burned ~35k reasoning tokens
and emitted no tool call at all, the same `reason: "length"` failure flash
gives on an oversized task. It is not more reliable, only dearer. The binding
constraint is task size, and no larger model fixes an oversized task.

When a task has failed twice, do not send it a third time at the same size.
Split it, move it up the subscription ladder, hand it to a Sonnet subagent via
the `Agent` tool (`model: "sonnet"`) if it needs to read widely first, or write
it yourself.

Every tier model above was verified on this account: it passes the OpenRouter
ZDR guardrail, actually calls tools, and wrote correct code that passed its own
generated pytest. The bottom two rungs are the same family (gpt-oss) so their
tool-calling behaviour is consistent; only the parameter count changes.

Re-verify before changing the table. Tool-calling reliability, not price, is
the binding constraint — several cheaper models are unusable here:

| model                                       | blended | why rejected                           |
| ------------------------------------------- | ------- | -------------------------------------- |
| `mistralai/mistral-nemo`                    | 0.022   | hung mid-run, never finished           |
| `ibm-granite/granite-4.0-h-micro`           | 0.041   | no endpoint supports tool use          |
| `mistralai/mistral-small-24b-instruct-2501` | 0.057   | no endpoint supports tool use          |
| `qwen/qwen3.7-flash`                        | 0.055   | ZDR-blocked (404 at $0 cost)           |
| `qwen/qwen3-30b-a3b-instruct-2507`          | 0.084   | works, but dominated by `gpt-oss-120b` |

## Reading the results

The summary table is a starting point, not a verdict:

```
id           tier      model                          cost_usd    diff_lines  status
retry-logic  standard  openrouter/openai/gpt-oss-120b  0.00063    18          ok
```

**`ok` only means the process exited 0.** A model can burn tokens, touch
nothing, and still report `ok` with `0` diff_lines — `qwen3-coder` did exactly
that during setup. Always read `.fanout/<stamp>/<id>.diff` before merging
anything. Treat `0` diff_lines on an `ok` row as a failure.

A task that fails at **$0 cost** has one of two causes, and they look
identical in the summary table. Check `<id>.stderr` first:

- `database is locked` — opencode's global SQLite state store, contended by
  simultaneous worker startups. The script staggers launches by
  `FANOUT_STAGGER_SECONDS` (default 5) to avoid it; raise it if you still see
  this.
- otherwise, check `<id>.events.jsonl` for "0 endpoints out of 1 requested are
  available" — that's the OpenRouter zero-data-retention guardrail rejecting
  the model.

## Sizing the task, not just the model

A worker that reports `ok` with a large **input** token count and a two-line
**output** count read the repository and then answered in prose instead of
calling the write tool. That is a task-size failure, not a model failure:
asking for twelve files in one prompt reliably triggers it on the gpt-oss
models. Keep a task to **one to three files**, and state the file paths as an
explicit numbered list. Adding "create each file with the write tool now; do
not summarise or ask" to the prompt also helps.

## Merging and cleanup

Worktrees live outside the repo at `../.fanout-worktrees/<stamp>/<id>`, each on
branch `fanout/<stamp>/<id>` with changes staged but uncommitted. Review, then
cherry-pick or copy out what you want. Artifacts land in `.fanout/<stamp>/`
(gitignored). Clean up with:

```bash
git worktree remove --force ../.fanout-worktrees/<stamp>/<id>
git worktree prune
```

On Windows `git worktree remove` fails with "Filename too long" now that every
worktree carries `node_modules`. `git worktree prune` still drops the
registration; delete the directory from PowerShell by mirroring an empty
directory onto it:

```powershell
robocopy $empty $target /MIR /XJ /XJD /XJF /NFL /NDL /NJH /NJS
Remove-Item $target -Recurse -Force
```

**`/XJ` is not optional.** pnpm's `node_modules/.pnpm/<pkg>/node_modules/*`
entries are junctions with absolute targets. A `/MIR` purge that follows them
deletes the target's contents -- on 2026-09-10 it emptied `typescript@5.9.3`
in the main tree's virtual store and ESLint stopped resolving `typescript`.
Repair, if it happens: `pnpm install --frozen-lockfile --offline --force`.

## Notes

- Each worker gets its own server port. Without `--port`, every `opencode run`
  attaches to one shared server and the prompts land in a single session, so
  workers trample each other's worktrees. Don't remove it.
- Each worker is launched with `</dev/null`. The dispatch loop's stdin is the
  tasks file, and a background child inherits that descriptor — opencode then
  reads from it and eats bytes the loop's own `read` was going to take. It does
  not crash: workers silently run **another task's prompt**, or a half-line
  arrives as a task with a garbage id. If you see a worker produce files that
  belong to a different task, this is why. Don't remove it either.
- Workers run with `--auto`, self-approving every tool call. The worktree is
  the only thing between them and the real tree.
- Default model for interactive opencode is set in `~/.config/opencode/opencode.jsonc`.

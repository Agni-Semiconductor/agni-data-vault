#!/usr/bin/env bash
# fanout.sh — dispatch a batch of coding tasks to OpenRouter models via opencode.
# Each task runs headless in its own git worktree, so parallel workers can't
# collide. Output per task: an NDJSON event log, a staged diff, and a cost figure.
#
# usage: ./fanout.sh tasks.jsonl [max_parallel]
#
# tasks.jsonl — one JSON object per line:
#   {"id":"retry-logic","tier":"standard","prompt":"..."}
#   {"id":"rename-vars","tier":"trivial","prompt":"..."}
#   {"id":"gen-tests","tier":"hard","prompt":"...","agent":"worker"}
#
# Pick the tier from how much JUDGEMENT the task needs, not how long it is:
#
#   trivial   Mechanical, one obvious correct answer. Renames, boilerplate,
#             moving text, generating a file from a spec you already wrote.
#   standard  Real code against a clear spec. One or two files, the shape of
#             the solution is already decided. This is the default.
#   hard      Needs judgement: ambiguous spec, multi-file reasoning, tricky
#             debugging, or a design decision the prompt does not settle.
#
# Ceiling is glm-5.3-flash ($0.075/$0.25 per M tokens) unless a task says
# otherwise. To go above it, set "model" explicitly — it overrides the tier:
#   {"id":"gnarly","model":"openrouter/z-ai/glm-5.3","prompt":"..."}
#
# Requires: opencode, jq, git. Credentials come from opencode's own auth store
# (~/.local/share/opencode/auth.json) or OPENROUTER_API_KEY in the environment.

set -euo pipefail

TASKS="${1:?usage: fanout.sh tasks.jsonl [max_parallel]}"
JOBS="${2:-4}"
BASE_PORT="${FANOUT_BASE_PORT:-14096}"
DEFAULT_TIER="${FANOUT_DEFAULT_TIER:-standard}"
# opencode opens a single global SQLite state database at startup. Four workers
# launching at once contend on it and one dies with "database is locked" before
# it reaches the model -- it lands in the summary at $0 cost, which looks exactly
# like the ZDR guardrail but is not. Staggering the launches avoids it.
STAGGER="${FANOUT_STAGGER_SECONDS:-5}"

# Tier -> model. Every entry was verified on this account: it passes the
# OpenRouter ZDR guardrail, actually calls tools, and produced correct, running
# code on a two-file smoke task. Prices are $/M tokens in/out.
#
# Verified and REJECTED — don't add back without re-testing:
#   qwen/qwen3.7-flash              ZDR-blocked (404 at $0 cost)
#   ibm-granite/granite-4.0-h-micro no endpoint supports tool use
#   mistral-small-24b-instruct-2501 no endpoint supports tool use
#   mistralai/mistral-nemo          hung mid-run, never finished
#   qwen/qwen3-coder                exited 0 having touched nothing
#
# Note qwen/qwen3-30b-a3b-instruct-2507 verifies fine but is strictly dominated
# by gpt-oss-120b, which is cheaper on both axes and larger. Don't use it.
tier_model() {
  case "$1" in
    # 20B — $0.030/$0.130. Cheapest verified that reliably writes files.
    trivial)  echo "openrouter/openai/gpt-oss-20b" ;;
    # 120B — $0.037/$0.170. Most capable-per-dollar of the verified set.
    standard) echo "openrouter/openai/gpt-oss-120b" ;;
    # $0.075/$0.250 — the ceiling. Best all-rounder, and least verbose in
    # practice, so often cheaper per task than its list price suggests.
    hard)     echo "openrouter/z-ai/glm-5.3-flash" ;;
    *)        return 1 ;;
  esac
}

command -v opencode >/dev/null || { echo "fanout: opencode not on PATH" >&2; exit 1; }
command -v jq       >/dev/null || { echo "fanout: jq not on PATH" >&2; exit 1; }

REPO="$(git rev-parse --show-toplevel)"
BASE="$(git rev-parse --abbrev-ref HEAD)"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN="$REPO/.fanout/$STAMP"
WT_ROOT="${FANOUT_WT_ROOT:-$REPO/../.fanout-worktrees/$STAMP}"

mkdir -p "$RUN" "$WT_ROOT"
: >"$RUN/summary.tsv"

# Everything a worker does happens inside its own worktree on its own branch.
run_one() {
  local task="$1" idx="$2"
  local id model tier prompt agent wt log port rc=0

  id="$(jq -r '.id' <<<"$task")"
  tier="$(jq -r '.tier // empty' <<<"$task")"
  model="$(jq -r '.model // empty' <<<"$task")"
  prompt="$(jq -r '.prompt' <<<"$task")"
  agent="$(jq -r '.agent // empty' <<<"$task")"

  # An explicit model wins; otherwise size the model to the task's tier.
  if [ -n "$model" ]; then
    tier="${tier:-explicit}"
  else
    tier="${tier:-$DEFAULT_TIER}"
    if ! model="$(tier_model "$tier")"; then
      echo "fanout: task '$id' has unknown tier '$tier' (want trivial|standard|hard)" >&2
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$tier" "-" 0 0 skipped >>"$RUN/summary.tsv"
      return 0
    fi
  fi

  wt="$WT_ROOT/$id"
  log="$RUN/$id"

  git -C "$REPO" worktree add -f -B "fanout/$STAMP/$id" "$wt" "$BASE" \
    >"$log.worktree.log" 2>&1

  # Give the worker a toolchain. A bare worktree has no node_modules, so a
  # worker there cannot run tsc, eslint, prettier or vitest and writes blind --
  # every type error it could have caught itself lands on the reviewer instead.
  #
  # THE PACKAGE MANAGER IS DETECTED, not assumed. The original hardcoded pnpm,
  # which is right for agni-connect and wrong here: this repo has only
  # package-lock.json, so `pnpm install --frozen-lockfile` fails, the fallback
  # fails too, and the run continues with a warning on stderr that is easy to
  # miss -- delivering exactly the blind worker the comment above says not to.
  #
  # --offline first so a worker never reaches the network for a package the
  # lockfile already resolved. Note `xlsx` resolves to a CDN tarball
  # (cdn.sheetjs.com), which a cold store cannot satisfy offline; the
  # prefer-offline fallback is what covers it.
  if [ -f "$wt/pnpm-lock.yaml" ]; then
    pm_try=(pnpm install --frozen-lockfile --offline --silent)
    pm_fallback=(pnpm install --frozen-lockfile --prefer-offline --silent)
  elif [ -f "$wt/package-lock.json" ]; then
    pm_try=(npm ci --prefer-offline --no-audit --no-fund --silent)
    pm_fallback=(npm ci --no-audit --no-fund --silent)
  elif [ -f "$wt/yarn.lock" ]; then
    pm_try=(yarn install --frozen-lockfile --silent)
    pm_fallback=(yarn install --silent)
  else
    pm_try=(true); pm_fallback=(true)
  fi
  if ! (cd "$wt" && "${pm_try[@]}") >"$log.install.log" 2>&1; then
    (cd "$wt" && "${pm_fallback[@]}") >>"$log.install.log" 2>&1 \
      || echo "fanout: install failed for '$id'; see $log.install.log" >&2
  fi

  # opencode is a native binary; on Git Bash it needs a Windows-style path.
  local wt_arg="$wt"
  command -v cygpath >/dev/null && wt_arg="$(cygpath -w "$wt")"

  # Each worker needs its OWN server. With no --port, every `opencode run`
  # attaches to the one server on the default port and all the prompts land in
  # a single shared session -- workers then trample each other's worktrees.
  port=$((BASE_PORT + idx))

  local -a args=(run --dir "$wt_arg" --model "$model" --format json
                 --port "$port" --auto)
  [ -n "$agent" ] && args+=(--agent "$agent")

  opencode "${args[@]}" "$prompt" >"$log.events.jsonl" 2>"$log.stderr" || rc=$?

  # Stage without committing: the lead agent reviews `git diff --cached`
  # and decides what, if anything, gets merged back.
  git -C "$wt" add -A
  git -C "$wt" diff --cached >"$log.diff"

  # opencode reports spend per step in step_finish events. Skip the non-JSON
  # preamble it sometimes prints (e.g. one-time DB migration notices).
  local cost
  cost="$(grep '^{' "$log.events.jsonl" 2>/dev/null \
          | jq -s '[.. | objects | select(has("cost")) | .cost] | add // 0' \
          2>/dev/null || echo 0)"

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$tier" "$model" "$cost" "$(wc -l <"$log.diff" | tr -d ' ')" \
    "$([ "$rc" -eq 0 ] && echo ok || echo "exit:$rc")" >>"$RUN/summary.tsv"
}

IDX=0
while IFS= read -r task || [ -n "$task" ]; do
  [ -z "${task// }" ] && continue
  # Portable concurrency cap (no `wait -n`, so this works on macOS bash 3.2).
  while [ "$(jobs -pr | wc -l)" -ge "$JOBS" ]; do sleep 0.5; done
  # `</dev/null` is not optional. This loop's stdin IS the tasks file, and a
  # background child inherits it -- opencode then reads from that same
  # descriptor, consuming bytes the loop's own `read` was going to take. The
  # visible symptom is not a crash: workers run somebody else's prompt, or a
  # half-line arrives as a task with a garbage id. Detach the child's stdin.
  run_one "$task" "$IDX" </dev/null &
  IDX=$((IDX + 1))
  # Let this worker get past opencode's startup before launching the next.
  [ "$IDX" -gt 0 ] && sleep "$STAGGER"
done <"$TASKS"
wait

{
  printf 'id\ttier\tmodel\tcost_usd\tdiff_lines\tstatus\n'
  sort "$RUN/summary.tsv"
  printf 'TOTAL\t\t\t%s\t\t\n' \
    "$(cut -f4 "$RUN/summary.tsv" | awk '{s+=$1} END {printf "%.4f", s}')"
} | { column -t -s "$(printf '\t')" 2>/dev/null || cat; }

echo
echo "worktrees: $WT_ROOT"
echo "artifacts: $RUN   (per task: .diff, .events.jsonl, .stderr)"
echo "clean up:  git -C $REPO worktree remove --force <path>  # per worktree"
echo
echo "REVIEW THE DIFFS. 'ok' only means the process exited 0 -- a model can"
echo "burn tokens, touch nothing, and still land here as ok with 0 diff_lines."

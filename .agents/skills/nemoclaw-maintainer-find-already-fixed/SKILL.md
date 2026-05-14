---
name: nemoclaw-maintainer-find-already-fixed
description: Scans open issues for already-fixed-on-main symptoms via 4 independent signals (GitHub's authoritative closed-by-PR GraphQL link, labels, code grep with bug-absent/fix-present sub-signals, merged-PR title overlap). Outputs a ranked close-list with evidence per issue and draft close comments — chains into `close-superseded-issues` via JSON sidecar. Use when auditing the open issue queue for noise, when an "open" issue count seems inflated, or when preparing a release and the backlog needs sanitizing. Local-only, read-only — never closes, never posts.
---

# Find Already-Fixed Issues

Proactively detect open issues that have been silently addressed by upstream PRs / refactors but were never closed. Reduces open issue queue noise so the team can focus on the truly-open backlog. **Pure-detection skill — no code changes, no PR opens. Only output is a ranked close-list and draft comments.**

## Why this matters

In the 2026-05-13 / 2026-05-14 maintainer session, the `issue-autopilot` skill surfaced 5+ open issues that were already-fixed: #3274 (Telegram groupPolicy via commit `7062d971a`), #3115 (`fixed-on-latest` label, code shipped), #3280 (5+ merged PRs), #1658 (pre-NVIDIA-org URL, docs replaced), #3418 (`nemoclaw/package.json` test script present). Each had been silently fixed but never closed, polluting the candidate pool for new work.

A standalone scanner that runs in O(minutes) catches them in batch.

## Invocation

```text
/nemoclaw-maintainer-find-already-fixed
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--top N` | `15` | Maximum candidates to surface |
| `--min-confidence` | `0.6` | Minimum confidence score (0-1) to include |
| `--labels-only` | `off` | Skip code-grep + merged-PR signals; only use label-based signal (fast) |
| `--draft-only` | `on` | Draft close comments but do NOT post or close — print to conversation only |

## Signals (any one triggers a candidate; combined raises confidence)

### Signal 0 — GitHub authoritative "closed by PR" link (confidence +0.7 for MERGED, **highest precedence**)

GitHub itself tracks the relationship when a PR body contains `Closes #N` / `Fixes #N` / `Resolves #N`. Exposed via the GraphQL field `closedByPullRequestsReferences`. This is the strongest signal because it's GitHub's own record — not heuristic inference — and survives renames, refactors, and stale paths.

**Important schema notes (verified live 2026-05-14):**

1. The gh CLI's `--json closedByPullRequestsReferences` shorthand returns a flat array directly — there's no `.nodes` wrapper. Fields available are only `id`, `number`, `repository { name, owner { login } }`, `url`. **It does NOT include `state` or `merged`.**
2. So you cannot tell from the CLI shorthand alone whether a linked PR is OPEN, CLOSED, or MERGED.
3. Use raw GraphQL via `gh api graphql` to get state + merged in one call.

**Working query (use this — verified live):**

```bash
gh api graphql -f query='
{
  repository(owner: "NVIDIA", name: "NemoClaw") {
    issue(number: '<N>') {
      closedByPullRequestsReferences(first: 20) {
        nodes { number state merged url }
      }
    }
  }
}' --jq '.data.repository.issue.closedByPullRequestsReferences.nodes[] | select(.merged == true) | {pr: .number, url}'
```

Batch form (still respects API quota — paginate the issue list, query GraphQL once per issue):

```bash
for n in $(gh issue list --repo NVIDIA/NemoClaw --state open --limit 200 --json number -q '.[].number'); do
  merged_count=$(gh api graphql -f query="
    { repository(owner:\"NVIDIA\", name:\"NemoClaw\") {
        issue(number: $n) {
          closedByPullRequestsReferences(first: 20) { nodes { merged } }
    } } }" --jq '[.data.repository.issue.closedByPullRequestsReferences.nodes[] | select(.merged == true)] | length')
  [ "$merged_count" -gt 0 ] && echo "#$n: $merged_count merged closing PR(s)"
done
```

**Confidence routing:**

- ≥1 **merged** linked PR → +0.7 (Signal 0 alone clears default threshold)
- ≥1 **OPEN** linked PR (`merged: false, state: OPEN`) → **does NOT fire Signal 0.** This case routes to `existing-pr-triage` in `issue-autopilot` Stage 2.4 instead — the issue is in flight, not already-fixed. Surface separately in the report so the maintainer knows the issue isn't dead, just under active development.

**Caveat:** GitHub only records the relationship when the linking PR uses one of the closing keywords in its body. A PR titled "fixes #1234" without the body trailer will NOT appear here — that case is still covered by Signal 3 (title/body grep). Don't drop Signal 3; Signal 0 is precision, Signal 3 is recall.

**Live validation (run on the open issue queue 2026-05-14):** Across 20 sampled open issues, 8 had Signal-0 linked PRs — all 8 PRs were in OPEN state (in flight), zero were merged. So in the steady state of an active repo, Signal 0 mostly surfaces "in flight" rather than "already shipped" — both useful, but routed differently.

### Signal 1 — Label-based (confidence +0.4)

Issue has any of: `fixed-on-latest`, `done`, `status: resolved`, `status: superseded`. Fastest signal — just label scan.

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --label fixed-on-latest --limit 200 --json number,title,labels,assignees
```

### Signal 2 — Code grep (confidence up to +0.6, split into two sub-signals)

Issues often state **both** the bug (a string that should not be there) and the fix (a string that should be there). These are **independent** evidence and score separately:

**Signal 2a — Bug-absence (+0.4):** For each "buggy string" the issue body quotes (config keys, file content, symbols), grep current `main` and check the string is ABSENT. Strong signal — if the literal bug pattern is gone, the bug is gone.

**Signal 2b — Fix-presence (+0.4):** For each "expected fix" the issue body proposes (suggested file path, suggested config value, suggested code change), grep current `main` and check it's PRESENT. Strong signal — if the proposed fix is already shipped, the issue is fixed.

When both sub-signals fire, cap the combined Signal 2 contribution at +0.6 (not +0.8) — they're not fully independent if they describe the same physical change.

**Examples from this session:**

- #3274: body quotes bug `"groupPolicy": "mentions"` → grep absent → 2a fires (+0.4). Body proposes mapping `"mentions"` → `"allowlist"` → grep shows `groupPolicy: "open"` with per-group `requireMention` (the better fix) → 2b fires (+0.4). Combined +0.6 → already past threshold.
- #3418: body says `nemoclaw/package.json has no test script` (bug = absence of test script; fix = adding it). Grep `"test":` in `nemoclaw/package.json` → present → 2b fires (+0.4). Combined with Signal 3 (no referencing PR — 0) → 0.4, **below threshold 0.6**. To fix this gap, run an *issue-age vs. file-modification-date* check — Signal 2c.

**Signal 2c — Stale-context bypass (+0.2):** For issues >90 days old (created date) where Signal 2b fires but Signal 3 doesn't, add a small confidence bonus. Old issues with the suggested fix now present are very likely already-fixed even without a directly-referencing PR (because the fix may have shipped as part of a refactor that didn't cite the issue number). Catches the #3418-shape gap and the #1658-shape "URL was reorganized" gap.

### Signal 3 — Merged-PR overlap (confidence +0.3)

For each open issue, search merged PRs in the last 60 days whose title or body references the issue number, OR has high token overlap with the issue title. Multiple merged PRs strongly suggest the issue was addressed in pieces.

```bash
gh pr list --repo NVIDIA/NemoClaw --state merged --search "#<issue#>" --limit 20 --json number,title,mergedAt
```

Plus `git log --all --grep="#<issue#>"` to catch commits referencing the issue.

Threshold: ≥1 merged PR explicitly referencing the issue, OR ≥3 merged PRs with high title-token overlap → +0.3.

### Combining signals

`confidence = min(signal_0 + signal_1 + signal_2 + signal_3, 1.0)` clamped to [0, 1].
Default `--min-confidence 0.6` means at least two signals must agree, OR Signal 0 alone (since it's GitHub's authoritative record).

## Workflow

1. **Pull open issue list.** Lightweight fetch — title, body, labels, assignees, comments count.
2. **Apply Signal 0 (run first, short-circuits the rest).** Batch-fetch `closedByPullRequestsReferences` per open issue; any issue with ≥1 merged in-repo PR linked goes straight to the candidate list at confidence 0.7 — record evidence and skip Signals 1-3 for it. This is the fast path; Signals 1-3 only run for issues that Signal 0 missed.
3. **Apply Signal 1.** Easy filter.
4. **Apply Signal 2.** For each issue body, extract quoted-string candidates, grep `main`. Use `git show main:<file>` for path-specific checks.
5. **Apply Signal 3.** Per-issue merged-PR search. Cache results across the run.
6. **Score + rank.** Combined confidence per issue. Sort descending.
7. **Per-candidate evidence packet.** Print: issue title, confidence, which signals fired, exact evidence (commit hash / file:line / merged-PR url).
8. **Draft close comments.** For each candidate above `--min-confidence`, draft a 3-5 line close comment with evidence inline. Same shape as the canonical evidence-bearing close comment.
9. **Stop.** Do NOT close, do NOT post — print drafts to conversation. User decides whether to bulk-close (e.g. via `nemoclaw-maintainer-close-superseded-issues`).

## JSON sidecar output

Every run writes a structured sidecar to `/tmp/nemoclaw-skill-output-find-already-fixed-<run_id>.json` alongside the markdown report. This enables chaining with `nemoclaw-maintainer-close-superseded-issues --from <path>`.

**Envelope (shared across the maintainer skill suite):**

```json
{
  "schema_version": 1,
  "skill": "nemoclaw-maintainer-find-already-fixed",
  "run_id": "<unix-ts>-<short-uuid>",
  "ts_start": "<iso8601>",
  "ts_end": "<iso8601>",
  "repo": "NVIDIA/NemoClaw",
  "args": { "--top": 15, "--min-confidence": 0.6 },
  "outcome": "OK" | "HALTED" | "ERROR",
  "halt_reason": null,
  "results": [ ... ],
  "next_skill_hint": { "skill": "nemoclaw-maintainer-close-superseded-issues", "args": "--from /tmp/nemoclaw-skill-output-find-already-fixed-<run_id>.json" }
}
```

**Per-result shape (this skill):**

```json
{
  "issue": 3274,
  "url": "https://github.com/NVIDIA/NemoClaw/issues/3274",
  "title": "...",
  "confidence": 0.7,
  "signals_fired": ["S0", "S2a"],
  "evidence": [
    { "kind": "merged_pr", "ref": "#3268", "url": "...", "via": "S0_authoritative" },
    { "kind": "code_grep", "ref": "src/lib/...", "via": "S2a_bug_absent" }
  ],
  "draft_close_comment": "..."
}
```

The companion `close-superseded-issues --from` reads only `results[].issue` + `results[].draft_close_comment`, so the format is stable across schema bumps as long as those fields exist.

## Per-signal calibration log (hardening — tune from real outcomes)

Every run appends one line per candidate to `/tmp/find-already-fixed-calibration.jsonl`:

```json
{"ts":"2026-05-14T...","run_id":"...","issue":3274,"confidence":0.7,"signals_fired":["S0","S2a"],"user_confirmed_close":null}
```

When the maintainer later confirms or rejects the close via `close-superseded-issues`, that skill's audit log (`~/.nemoclaw/close-audit.jsonl`) is the source of truth for `user_confirmed_close`. Periodically (e.g. monthly), join the two logs:

```bash
# Per-signal precision: how often did each signal lead to a confirmed close?
jq -s 'group_by(.signals_fired[]) | map({signal: .[0].signals_fired[0],
  total: length,
  confirmed: map(select(.user_confirmed_close == true)) | length})' \
  /tmp/find-already-fixed-calibration.jsonl
```

If a signal's precision drifts below 60%, **tune the threshold up** for that signal (e.g. Signal 2c's +0.2 bonus may be too generous). If a signal's precision is ≥90%, the threshold is solid and you can drop it slightly to gain recall.

The calibration log is local-only by default; never committed. If sharing with the team, anonymize issue numbers first.

## Output discipline

Single markdown table summary, then per-candidate detail block. Example:

```text
Top 5 already-fixed candidates (confidence ≥ 0.6):

| # | Confidence | Signals | Title |
|---|---|---|---|
| #3274 | 0.7 | code, merged-PR | Telegram groupPolicy invalid value |
| #3115 | 0.4 | label | nemoclaw onboard exits 0 when Docker not running |
| ... | | | |

─── #3274 evidence ───
Signal 2 (code): grep shows no `"mentions"` string in source as of HEAD a78ea16e7
Signal 3 (merged-PR): commit 7062d971a "fix(onboard): use per-group requireMention instead of invalid groupPolicy enum"

Draft close comment:
> Closing as already-fixed on main. Commit `7062d971a` ...
```

## Hard nos

- Read-only detection. Never closes, comments, labels, or opens PRs. Closing → `nemoclaw-maintainer-close-superseded-issues`.

## Regression sentinel

If a clean run misses any of {#3274, #3115, #3280, #1658, #3418} after they've been intentionally re-opened for testing, the skill has regressed. These five are the canonical positive examples — each fires a different signal pattern (#3274: S0+S2a, #3115: S1 alone, #3280: S3 only, #1658: S2c stale-context, #3418: S2b fix-present). Use them as a smoke test after any threshold-tuning.

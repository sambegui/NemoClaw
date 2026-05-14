---
name: nemoclaw-maintainer-pr-rebase-assist
description: Walks the maintainer through rebasing a stale PR in 3-5 min instead of 15-30 min of manual conflict resolution. Fetches the PR, attempts rebase against origin/main, surfaces each conflict as a structured 3-pane view (HEAD side / incoming side / recommended resolution drawn from diff context), validates with typecheck, then pushes with --force-with-lease to avoid clobbering concurrent author pushes. Use when `stale-pr-sweep` surfaces a NEEDS_REBASE PR, when a maintainer-authored PR drifts behind main, or when an author asks for help unblocking a rebase. Local-only, gated at every destructive step.
---

# PR Rebase Assist

A NEEDS_REBASE PR from `stale-pr-sweep` has no follow-through skill yet — the maintainer has to manually `git fetch` + `git rebase origin/main` + resolve conflicts + force-push. This skill walks that interactively, with a per-conflict recommended resolution drawn from the diff context.

## Why this matters

`stale-pr-sweep` identifies NEEDS_REBASE PRs but stops at "git rebase + force-push" as the recommended action. In practice this takes 15-30 min per stale PR — fetching, rebasing, hitting conflicts, opening conflict files, choosing sides, building/testing, pushing. Most maintainers batch-ignore these or pass them back to authors, which adds days of latency.

This skill turns each rebase into a 3-5 min interactive walkthrough: it fetches, attempts the rebase, surfaces conflicts in a structured format (HEAD side / incoming side / suggested resolution), and only after the maintainer confirms each file does it stage and continue. Final push is force-with-lease, gated.

## Invocation

```text
/nemoclaw-maintainer-pr-rebase-assist <PR-number>
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--base` | `origin/main` | Branch to rebase against |
| `--auto-stage-clean` | `on` | Auto-stage files that rebased without conflicts |
| `--push` | `off` | Auto-push after rebase completes (default off — confirm manually) |
| `--abort-on-test-fail` | `on` | Run `npm run typecheck:cli` after rebase; abort if it fails |

## Prerequisites (hard rules)

1. **Clean working tree.** `git status --porcelain` must be empty. Halt otherwise.
2. **Must be invoked on the maintainer's local checkout.** This skill modifies local git state. Refuse to run inside a worktree or detached HEAD.
3. **PR author must be checked.** If the PR is from a fork AND the maintainer doesn't have write access to the fork branch, surface that — the rebase can be done locally but pushing requires either the author's collaboration or maintainer admin override. Halt and ask.
4. **Identity check.** Same as `issue-autopilot` Stage 0 — verify `git var GIT_AUTHOR_IDENT` matches the running maintainer and commit signing is configured.

## Workflow

1. **Validate prerequisites.** Halt on any fail.

2. **Fetch the PR's branch into a local rebase branch.**

   ```bash
   PR=<PR-number>
   gh pr checkout "$PR" --repo NVIDIA/NemoClaw -b rebase-pr-"$PR"
   git fetch origin main
   ```

3. **Attempt the rebase.**

   ```bash
   git rebase origin/main || REBASE_HALTED=1
   ```

4. **If the rebase halted (conflicts), enumerate conflicted files.**

   ```bash
   git diff --name-only --diff-filter=U
   ```

5. **Per conflicted file, surface a structured 3-pane view:**

   ```text
   ─── conflict: src/lib/onboard.ts ───

   <<<<<<< HEAD (origin/main has)
   <main side ~15 lines context>
   =======
   <incoming PR side ~15 lines context>
   >>>>>>> rebase-pr-N

   ── Diff analysis ──
   - main's change: <one-line summary inferred from git log -1 origin/main -- src/lib/onboard.ts>
   - PR's change:   <one-line summary from `git log -1 rebase-pr-N -- src/lib/onboard.ts`>

   ── Recommended resolution ──
   <One of: keep-main / keep-pr / merge-both-with-edit / manual>
   <If merge-both-with-edit: the suggested merged block, with HUMAN-REVIEW markers around any unclear bits>

   ── Options ──
   [1] Apply recommended resolution
   [2] Open the file in $EDITOR for manual edit
   [3] Use main side (`git checkout --ours <file>`)
   [4] Use PR side (`git checkout --theirs <file>`)
   [5] Skip this file (keep conflict markers — for batch review)
   [6] Abort the rebase entirely
   ```

6. **Recommendation engine** — for each conflict file:

   - **If both sides only changed comments/docstrings** → recommend merge-both-with-edit (concatenate the two updates).
   - **If main's change adds a new field/parameter that PR's change doesn't reference** → recommend keep-pr but warn that the new field is undefined in this code path.
   - **If both sides changed the same function signature** → recommend manual; surface the two signatures side-by-side; halt for the maintainer's call.
   - **If main's change is a security-relevant fix (touches `nemoclaw-blueprint/policies/`, `credentials*`, `inference/*`)** → recommend keep-main (default), with a callout: "Security-relevant: don't override main's fix; instead, port the PR's change on top."

7. **After applying resolutions per file:**

   ```bash
   git add <resolved-files>
   git rebase --continue
   ```

   Loop steps 4-7 until the rebase completes or the maintainer aborts.

8. **Post-rebase validation.**

   ```bash
   npm run typecheck:cli
   ```

   If `--abort-on-test-fail on` and typecheck fails: halt, surface the errors, ask the maintainer whether to (a) fix in-place and recommit, (b) abort and `git rebase --abort`. Default to abort.

9. **Force-push gate (the only outbound destructive step).**
   - Show the maintainer: `git log --oneline origin/main..HEAD` (what's about to be pushed).
   - Show: `git diff origin/main..HEAD --stat`.
   - **Always force-with-lease, never force.** Use `git push --force-with-lease=origin/<branch>:<known-old-ref>` so a concurrent push by the author doesn't get clobbered.

   ```bash
   BRANCH=$(gh pr view "$PR" --repo NVIDIA/NemoClaw --json headRefName --jq .headRefName)
   OLD_REF=$(gh pr view "$PR" --repo NVIDIA/NemoClaw --json headRefOid --jq .headRefOid)
   # Confirm push
   git push --force-with-lease=origin/"$BRANCH":"$OLD_REF" origin HEAD:"$BRANCH"
   ```

   If the push fails with "stale info" → the author pushed concurrently; abort cleanly, leave the maintainer's local branch intact for inspection, surface "concurrent push detected; coordinate with the author before retrying."

10. **Post-push verification.**
    - `gh pr view <N> --repo NVIDIA/NemoClaw --json headRefOid` → confirm the new SHA.
    - `gh pr comments <N>` → optionally draft a "rebased onto main" comment for the maintainer to post.

11. **Cleanup.** Offer to delete the local `rebase-pr-<N>` branch (`git branch -D rebase-pr-<N>`). Confirm before doing so.

## Hard rules (each backed by a halt condition)

### Never force-push without `--force-with-lease`

The `--force` flag clobbers concurrent pushes. `--force-with-lease=<remote>/<branch>:<expected-old-ref>` is the safe equivalent — fails if anyone else pushed since you fetched.

### Never amend or squash commits unless the maintainer explicitly asks

The PR author's commit structure may be intentional (e.g. logical-step commits for reviewer benefit). Rebasing preserves the structure by default. If the maintainer wants to squash, that's a separate operation (`git rebase -i`), prompted explicitly.

### Never proceed past a failing typecheck unless `--abort-on-test-fail off`

If the rebase produces compiling-but-wrong code, the next person to review the PR has to discover that. Catch it here.

### Never rebase from a dirty tree

Stash or commit local work first. The skill refuses to start otherwise.

## JSON sidecar output

Writes `/tmp/nemoclaw-skill-output-pr-rebase-assist-<run_id>.json`. Shares the maintainer-suite envelope.

**Per-result shape (single object — one rebase per run):**

```json
{
  "pr": 3284,
  "url": "https://github.com/NVIDIA/NemoClaw/pull/3284",
  "base": "origin/main",
  "started_at": "<iso8601>",
  "ended_at": "<iso8601>",
  "outcome": "pushed" | "aborted_by_user" | "aborted_concurrent_push" | "aborted_typecheck_failed" | "aborted_prereq" | "error",
  "conflicts": [
    {
      "file": "src/lib/onboard.ts",
      "resolution": "merge-both-with-edit" | "keep-main" | "keep-pr" | "manual",
      "recommended": "merge-both-with-edit",
      "matched_recommendation": true
    }
  ],
  "old_head_sha": "<sha>",
  "new_head_sha": "<sha-or-null-if-not-pushed>",
  "comment_draft": "Rebased onto origin/main, resolved N conflicts; please review."
}
```

## Output discipline

- Per-conflict block: 3-pane structured view (above) — every conflict gets its own block, never collapsed.
- End-of-run summary: outcome + counts (`N conflicts resolved automatically, M manually, K aborted`) + the comment_draft for paste.

## Reference cases (the 4 conflict shapes)

These illustrate the conflict shapes the recommendation engine handles. PR numbers anonymized.

- **Comments-only conflict (auto-merge):** Both main and PR rewrote the same docstring. Engine recommends `merge-both-with-edit`, concatenating the two updates. Common on heavily-documented files.
- **New-field-not-referenced (keep PR):** Main added a new optional parameter `signal?: AbortSignal` to `createSandbox`; PR's diff doesn't reference it. Engine recommends `keep-pr` with a warning: "main's new `signal` parameter is undefined in this code path." Maintainer adds a default in a follow-up.
- **Same-signature change (manual):** Both sides changed `validatePolicy()` — main added a return type, PR added a parameter. Engine recommends `manual` and surfaces the two signatures side-by-side; halts for the maintainer's call.
- **Security-relevant on main (keep main):** Main landed a critical fix in `nemoclaw-blueprint/policies/egress.ts` (CVE-tagged). PR has unrelated changes in the same file. Engine recommends `keep-main` with the callout "Security-relevant: don't override main's fix; port the PR's change on top." Force-with-lease push fails because two authors push concurrently; halt cleanly per the concurrent-push branch.

## Halt conditions (the non-obvious ones)

- **Concurrent push detected on `force-with-lease`** → the PR author pushed since the maintainer started. Halt; leave the local rebase branch intact for inspection; coordinate with the author before retrying.
- **Typecheck fails post-rebase AND `--abort-on-test-fail on`** → likely the rebase produced semantically-broken-but-syntactically-valid code. Default behavior: abort rebase, restore local state. Override only after manual inspection.

## Hard nos

- No merge, no squash unless explicitly asked (PR author's commit structure may be intentional), no PR description edits, no remote-branch deletion on the fork.

## Why the structured 3-pane view matters

Surfaces a non-obvious case: sometimes main's recent change is the wrong one. The PR's rebase reveals it. When that happens, the right action is "fix main, then rebase," not "keep main, lose PR's work." The 3-pane view + diff analysis makes that visible; a default `git rebase` doesn't.

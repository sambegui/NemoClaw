---
name: nemoclaw-maintainer-verify-stale
description: Verify whether old NVIDIA/NemoClaw bug reports still reproduce against the latest tag. Picks candidate issues opened against older versions, runs the reproducer locally first when possible (Linux or macOS), otherwise reuses or provisions a Brev Linux box (CPU or GPU), detects behavior that was intentionally changed, scores confidence, and posts an evidence-backed comment with a label (fixed-on-latest, status: wont-fix, or verify-inconclusive). Tag-only — never auto-closes. Brev verification is Linux-only in v1; Windows and integration-token-dependent issues are skipped. Trigger keywords - verify stale, verify fixed, reproduce on latest, stale issue, old bug, fixed-on-latest, status: wont-fix, verify-inconclusive, drain backlog, brev verify.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Verify Stale Issues

Automates the manual loop of "spin up a Brev box, install latest NemoClaw, try to reproduce an old bug, comment with findings." Drains the bug backlog by surfacing issues that have been silently fixed.

This skill is the outbound counterpart to `nemoclaw-diagnosis` (which files issues from CI failures). Diagnosis fills the queue; this drains it.

---

## Step 1: Determine Mode

**Single-issue mode** — user provides an issue number:

```bash
gh issue view <number> --repo NVIDIA/NemoClaw \
  --json number,title,body,labels,url,author,createdAt,comments
```

**Batch mode** — user says "batch", "weekly", or provides no number. Cap at **15 issues** for *processing* per run, enforced as a slice after Step 3/4 filters narrow the pool. The cap exists because batch is sequential (Step 7 reuse-or-provision keeps it on 1–2 Brev boxes total) and the wallclock budget is ~2–3 hours per 15-issue run; running larger forces the maintainer to either drop the per-plan approval gate or spread the batch across multiple sessions.

The discovery query needs to see the entire open-bug pool — the per-run processing cap is downstream. Use `--limit 1000` so the skill doesn't silently drop issues beyond the page (the candidate triage run found 129 open bugs; an earlier `--limit 100` would have missed 29 of them).

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --limit 1000 \
  --label bug \
  --json number,title,body,labels,url,author,createdAt,comments
```

In batch mode, work through items one at a time. Present each verification plan and wait for approval before any Brev provisioning.

---

## Step 2: Detect the Latest NemoClaw Version

Try GitHub releases first; fall back to the highest semver tag from the GitHub API if no release is published. NemoClaw currently tags but does not publish releases, so the fallback is the load-bearing path today. Use `gh api` rather than `git ls-remote` so the skill works regardless of SSH key setup, and reuses the auth `gh` already has.

```bash
LATEST=$(gh release view --repo NVIDIA/NemoClaw --json tagName -q .tagName 2>/dev/null)

if [ -z "$LATEST" ]; then
  LATEST=$(gh api repos/NVIDIA/NemoClaw/tags --paginate --jq '.[].name' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -1)
fi

echo "Latest tag: $LATEST"
```

This is the version the skill will verify against. Record it — every comment must cite it.

---

## Step 3: Filter Candidates

Apply these rules in order. Drop any issue that fails a rule.

**Issue-type allowlist:** must have `bug` label.
**Issue-type skip:** drop if any label exactly matches `documentation`, `status: wont-fix`, `status: needs-info`, `security`, OR is `enhancement` / starts with the prefix `enhancement:` (the repo has 8 prefixed variants — `enhancement: feature`, `enhancement: MCP`, `enhancement: testing`, `enhancement: ui`, `enhancement: provider`, `enhancement: platform`, `enhancement: policy`, `enhancement: inference`, `enhancement: integration`, `enhancement: performance`, `enhancement: skill` — and exact-match misses them all; surfaced from #1752). Use the canonical repo label names — bare `wontfix` / `needs-info` are NOT the repo's labels (verified via `gh label list`); the actual labels carry a `status:` prefix and a hyphen.

**Platform skip (Brev-reproducible only in v1):** drop if any of `Platform: Windows/WSL`, `Platform: MacOS`, `Platform: macOS`, `Platform: Jetson AGX Thor/Orin`. Brev has no equivalent hardware for Jetson (embedded/edge ARM with integrated GPU is not in the Brev SKU catalog), so any Brev verification of a Jetson-only bug would produce a misleading "fixed-on-x86" verdict. Keep `Platform: Ubuntu`, `Platform: DGX Spark`, `Platform: GB10`, `Platform: All`, or no platform label. `Platform: DGX Spark` and `Platform: GB10` stay in scope but Step 10 requires a "Hardware substitution" caveat in the comment naming the Brev SKU we used as a substitute (Brev x86 GPU SKUs are not faithful to GB10 / Grace Hopper silicon for performance-shape or memory-architecture-shape bugs).

**TUI / interactive-UI skip:** drop if the issue title contains `TUI`, `dashboard UI`, `chat UI`, `keystroke`, or `key press`, OR if the body describes interactive UI behavior (key sequences, mouse interactions, browser-side UI state) without a non-interactive reproducer (no `NEMOCLAW_NON_INTERACTIVE=1` or equivalent env var pattern). `brev exec` does not allocate a real TTY by default, so TUI reproducers hang or silently fail at the first prompt; v1 documents this as out-of-scope rather than emitting a wrong verdict. v1.1 may add a `script(1)` / `expect` / `tmux send-keys` harness to lift this skip.

**Integration skip (deferred to v2):** drop if any of `Integration: Slack`, `Integration: Discord`, `Integration: Telegram`, `Integration: Hermes`, `Integration: OpenClaw`, `Integration: WeChat`. These need third-party credentials a fresh Brev box cannot provide.

**Component allowlist (must have at least one):** `NemoClaw CLI`, `Sandbox`, `OpenShell`, `Docker`, `Getting Started`, or any `Platform:` label that survived the platform skip.

**Idempotency:** drop if **either** of these is true:

- The issue carries a `fixed-on-latest` or `verify-inconclusive` label. (Cleared by the release sweep in `nemoclaw-maintainer-cut-release-tag` so the issue re-opens on each release.) The by-design path uses the existing repo `status: wont-fix` label, which is already covered by the issue-type skip rule above — no separate idempotency clause needed for that path.
- A comment matching `<!-- nemoclaw-verify-stale v\d+ YYYY-MM-DD -->` was posted **within the last 7 days**. The regex matches any marker version (`v1`, `v2`, …) so future skill versions can re-verify older-marked issues by tightening the regex (e.g. require a specific marker version). The marker carries a date so the candidate filter can apply a TTL — useful for the still-reproduces case (Step 9), where no label is applied and we want next week's run to re-verify rather than skip forever.

Implementation — match the marker against each comment's `createdAt`. Use `gh issue view --json comments` (single-issue mode already fetches this; batch mode's `gh issue list` also returns the comment array per issue):

```bash
# Cutoff for the 7-day TTL. macOS and Linux date(1) syntax differ; try both.
SEVEN_DAYS_AGO=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)

# Returns the timestamp of the most recent marker comment within the TTL, or empty.
RECENT_MARKER=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq --arg cutoff "$SEVEN_DAYS_AGO" '
    .comments[]
    | select(.body | test("<!-- nemoclaw-verify-stale v\\d+ \\d{4}-\\d{2}-\\d{2} -->"))
    | select(.createdAt > $cutoff)
    | .createdAt' \
  | head -1)

if [ -n "$RECENT_MARKER" ]; then
  echo "Skip: marker posted $RECENT_MARKER (within 7-day TTL)"
  # In single-issue mode: exit 0 with a friendly message.
  # In batch mode: continue to the next candidate.
fi
```

Run this check for every candidate that survived the label-based filters above; drop those whose `RECENT_MARKER` is non-empty.

**Unanswered-maintainer-question handling.** Find the most recent maintainer (`MEMBER`, `OWNER`, `COLLABORATOR`) comment that **looks like a question** (`?`, polite imperative like "please confirm/share/clarify", or starter like "could you / can you / do you") AND that the reporter has not replied to since. Pure triage acknowledgments (`"✨ Thanks for reporting…"`) are skipped. The age of the qualifying comment determines skip-or-proceed:

- **Within 7 days:** **skip the issue** — the discussion is active, the skill running on top would conflict with the maintainer's framing or confuse the reporter. Surfaced during pre-flight on #2757; running verify-stale on top of a fresh "let me clarify what you observed" question from @cjagwani would have stomped on that conversation.
- **Older than 7 days:** **proceed with verification, but use the unanswered-question comment variant.** After 7 days the maintainer's question has either been forgotten or the reporter has dropped the ball; an independent skill verdict becomes the *unsticking voice* rather than a clueless interruption. The comment leads with a markdown link to the maintainer's unanswered comment (shape shown in the Step 10 template below) and @-mentions BOTH the maintainer and the reporter, not just the reporter. Reuse `$SEVEN_DAYS_AGO` from the marker-TTL check above.

```bash
REPORTER=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json author --jq .author.login)

# Most recent unanswered maintainer comment that looks like a question — filters out triage acknowledgments (#1642 surfaced this).
UNANSWERED_MAINT=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq --arg reporter "$REPORTER" --arg cutoff "$SEVEN_DAYS_AGO" '
    (.comments
     | map(select((.authorAssociation == "MEMBER" or .authorAssociation == "OWNER" or .authorAssociation == "COLLABORATOR")
         and (.body | test("\\?|(?i)\\bplease (confirm|share|provide|clarify|tell|verify|check|let me know|let us know)|(?i)\\b(could|can|would) you\\b|(?i)\\bdo you (have|know|see|use)\\b"))))
     | sort_by(.createdAt) | last) as $maint
    | if $maint == null then null
      else
        ((.comments
          | map(select(.author.login == $reporter and .createdAt > $maint.createdAt))
          | length) as $replies
         | if $replies > 0 then null
           else {
             createdAt: $maint.createdAt,
             url: $maint.url,
             login: $maint.author.login,
             recent: ($maint.createdAt > $cutoff)
           }
           end)
      end')

if [ -n "$UNANSWERED_MAINT" ] && [ "$UNANSWERED_MAINT" != "null" ]; then
  MAINT_RECENT=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .recent)
  MAINT_DATE=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .createdAt)
  MAINT_LOGIN=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .login)
  MAINT_URL=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .url)

  if [ "$MAINT_RECENT" = "true" ]; then
    echo "Skip: active maintainer discussion (unanswered comment from @$MAINT_LOGIN at $MAINT_DATE, within 7 days)"
    # Single-issue mode: exit 0 with the message; batch mode: continue to next candidate.
  else
    echo "[verify-stale] proceeding with unanswered-question variant — @$MAINT_LOGIN's comment from $MAINT_DATE is older than 7 days"
    # Step 10's comment template will lead with the unanswered-question prefix and @-mention
    # both the maintainer and the reporter. Export these for the templater:
    export UNANSWERED_MAINT_LOGIN="$MAINT_LOGIN"
    export UNANSWERED_MAINT_URL="$MAINT_URL"
    export UNANSWERED_MAINT_DATE="$MAINT_DATE"
  fi
fi
```

When the unanswered-question variant fires (`UNANSWERED_MAINT_LOGIN` set), Step 10's comment template prepends a lead paragraph (exact shape lives with the templates in Step 10), and the closing @-mention block names BOTH the maintainer (acknowledging their question) and the reporter (asking for confirmation per the standard pattern), instead of just the reporter.

**Candidate rule:** keep the issue if **either**:

- The reported version (parsed from body or labels — see Step 4) is **at least 2 versions behind** `$LATEST` in the rightmost-incrementing component, **or**
- The issue is **older than 7 days** AND a specific version is parseable from its body or labels.

For NemoClaw's current `0.0.x` line, "rightmost-incrementing component" is the patch number — a v0.0.31 report against a v0.0.34 latest is 3 versions behind. Once NemoClaw moves to `0.1.x` or higher, the rule applies to the next-rightmost component instead. Pick whichever component is actively iterating.

---

## Step 4: Parse Reported Version

The regex is intentionally **release-line agnostic**. Today NemoClaw ships `v0.0.x`, but the same parser must keep working when it moves to `v0.1.x`, `v1.x.x`, or anything else. Don't hardcode the major/minor digits.

Sources, in order of trust:

1. **Labels.** Any label that exactly matches `^v\d+\.\d+\.\d+$` AND appears in the repo's tag list. Labels matching the regex but absent from tags (e.g. `v0.0.35` as a *release-target* milestone before that version ships) are roadmap markers, not "reported on" — drop them.
2. **Body.** Use a **proximity-anchored** regex: `(?i)nemoclaw[^a-z\n]{0,80}v?(\d+\.\d+\.\d+)`. This matches a version that follows `nemoclaw` within 80 non-letter, non-newline characters, capturing just the semver. The anchoring is load-bearing — without it the parser also picks up `openshell 0.0.4`, Node.js `v22.16.0`, IP addresses (`0.0.0.0:11434`, `127.0.0.1`), and other near-NemoClaw products that happen to share the `v0.0.x` line. (This was confirmed in the dry-run: a non-anchored parser produced 12 false-positive candidates whose smallest tag-valid version was actually OpenShell's, not NemoClaw's.)
3. **Comments by the original reporter** — same anchored regex as the body.

Collect every match from sources 2 and 3 (a single body may mention multiple versions — `0.0.6 and v0.0.10`). Then validate.

**Validate against the tag list.** A parsed version must exist as a real git tag, otherwise drop it. This single check kills four classes of error in one pass:

- Reporter typos that cite a non-existent version (`v0.1.0` when only `v0.0.x` is released — observed 3× in the live backlog).
- Calver mistakes (`2026.3.11` — observed 1×).
- Future roadmap labels that slipped past source 1.
- Versions parsed from prose that happen to look semver-ish but aren't releases.

```bash
gh api repos/NVIDIA/NemoClaw/tags --paginate --jq '.[].name' > /tmp/nemoclaw-tags.txt

# For each candidate version V:
grep -Fxq "$V" /tmp/nemoclaw-tags.txt || drop_version "$V"
```

After validation, **pick the smallest surviving version** as the reported version (most conservative — it maximizes versions-behind). This handles "this bug was first reported on v0.0.6 and still happens on v0.0.10" cleanly: we verify against latest, and if the bug is gone, both reports are addressed.

If no version survives, drop the issue from the candidate set — we cannot establish "previous version".

**Variable format for downstream steps.** Set `REPORTED_VERSION` to the **full tag string** (e.g., `REPORTED_VERSION="v0.0.32"`), not just the patch number. Step 8a's installer expects the full tag via the `NEMOCLAW_INSTALL_TAG` env var.

**Batch cap enforcement.** In batch mode, after Step 3 label filters and the Step 4 version+candidate-rule filters narrow the pool, sort surviving candidates by `(-versions_behind, -age_days)` so the most stale come first, then **slice to the top 15**:

```bash
# Each candidate has at minimum: number, reported, behind, age_days
SLICED=$(printf '%s' "$CANDIDATES_JSON" | jq '
  sort_by([-(.behind // 0), -(.age_days // 0)])
  | .[0:15]')
SLICED_COUNT=$(printf '%s' "$SLICED" | jq 'length')
TOTAL=$(printf '%s' "$CANDIDATES_JSON" | jq 'length')
echo "Batch run: processing $SLICED_COUNT of $TOTAL eligible candidates (cap: 15)."
[ "$TOTAL" -gt 15 ] && echo "  Spillover: $((TOTAL - 15)) candidates deferred to next run; the marker-comment TTL (Step 3) keeps them eligible."
```

The slice is the only enforcement of the cap — without it, "Cap at 15" is policy that nothing actually applies. Single-issue mode bypasses the cap entirely (the user explicitly named one issue).

**NVBugs cross-reference.** Many NV QA bugs include an NVBugs ticket footer like `[NVB#6100043]`. Extract it at the same time as the version so Step 8.5's comment template (and any other comment template that wants to mention it) can include the cross-reference:

```bash
NVBUGS_REF=$(printf '%s' "$BODY" | grep -oE '\[NVB#[0-9]+\]' | head -1)
```

Templates ignore this when empty. When present, the comment must note that closing the GitHub issue does not propagate to NVBugs and QA needs to update the ticket separately.

### Implementer note: regex-pipeline pitfalls

Three real failure modes surfaced during the v1 dry-run. Test each before trusting your implementation:

1. **Empty-match handling.** A naive pipeline like `[scan(regex)] | first | .[0] | tonumber // fallback` silently dropped 9 real candidates (e.g. #2861 with `NemoClaw 0.0.32`, #2604 with `NemoClaw: 0.0.28`). When `scan` returns no matches, `[]` flows in, `first` returns null, `null | .[0]` errors, and `//` does not propagate cleanly through the error. Bind each pass to a named variable, coalesce at the end:

   ```text
   primary  := first nemoclaw-anchored match in body  (or null)
   result   := primary ?? null
   ```

   Then explicitly test against a body with **no** version mention.

2. **Capture-group consistency.** A regex without a capture group (e.g. `\bv\d+\.\d+\.\d+\b`) makes `scan` emit raw strings; with a capture group (e.g. `\b(v\d+\.\d+\.\d+)\b`), `scan` emits arrays. Mixing the two within one pipeline (`first | .[0]?`) works for one and silently fails for the other. Use capture groups consistently across all branches.

3. **Variable scoping in `select(...)`.** A line like `select($tags | index(.))` rebinds `.` to `$tags` inside the parens, so `.` no longer refers to the surrounding label being checked. Bind first: `. as $lbl | select($tags | any(. == $lbl))`. Symptom in this dry-run: the future-release label `v0.0.35` passed validation that should have rejected it.

---

## Step 5: Classify the Verification Environment

**CPU vs GPU:** GPU if any of these signals are present, else CPU.

- Labels: `Platform: GB10`, `Platform: DGX Spark`.
- Body keywords (whole-word, case-insensitive): `nvidia-smi`, `cuda`, `H100`, `A100`, `L40S`, `L4`, `T4`, `GB10`, `DGX`, `vllm`, `tensorrt`. Match as whole words — `inference` and `model serving` are too noisy (e.g. `models.providers.inference.baseUrl` is a config path on CPU bugs, not a GPU need) and intentionally excluded.

CPU default keeps cost low. Only escalate to GPU when the reproducer needs one.

**Bug class classification.** In addition to CPU/GPU, classify the bug's verification shape so Step 8 routes to the right rubric. Classes are mutually exclusive — pick the first that matches:

| Class | Detection heuristic | Routes to |
|---|---|---|
| `performance` | Body or title mentions latency thresholds (`P50`, `P90`, `ms`, `seconds`, `slow`, `hangs`, `timeout` with a numeric value), or mentions `memory leak` / `over time` / `eventually` | Step 8e (multi-run distribution rubric) |
| `rebuild-cycle` | Body mentions `rebuild`, `recreate`, `restart`, `pod recreate`, `across rebuilds`, `after restart`, `survives a destroy` | Step 8f (run-rebuild-rerun harness) |
| `log-only` | Body's symptom is logs-not-stdout: `see lots of error in <X> log`, `os.networkInterfaces guard errors`, anything pointing at a specific log file rather than the reproducer's stdout/stderr | Step 8b's match rubric extended with log-scraping |
| `functional` (default) | Everything else — exit code + stdout/stderr matching | Step 8b standard rubric |

Most bugs are `functional`. The other three classes need verification harnesses that the standard rubric can't produce honestly — e.g., one clean run of a perf reproducer doesn't tell you the p50 budget was met; one onboard run doesn't tell you a config survives a rebuild. Set `BUG_CLASS=<class>` so downstream steps can branch.

**Provider classification.** Some bugs are tied to a specific inference provider (NVIDIA NIM, Gemini, Anthropic, OpenAI) and won't reproduce faithfully under Ollama substitution. Classify which provider the issue references so downstream steps either prompt for the right API key or accept the substitution penalty:

| Detection signal | Provider |
|---|---|
| `Provider: NVIDIA` label, body mentions `NVIDIA NIM`, `build.nvidia.com`, `nvapi-...`, `NVIDIA_API_KEY`, or `NEMOCLAW_PROVIDER=build` | `nim` |
| `Provider: Gemini` label, body mentions `Gemini`, `gemini-flash`, `gemini-pro`, `GEMINI_API_KEY` | `gemini` |
| `Provider: Anthropic` / `Provider: AWS` (Bedrock) labels or matching keywords | `anthropic`/`bedrock` |
| `Provider: Ollama`, body mentions `ollama` or `NEMOCLAW_PROVIDER=ollama`, or no provider mentioned at all | `ollama` (default) |

Set `BUG_PROVIDER=<provider>`.

**Required-API-key prompt.** When `BUG_PROVIDER` is anything other than `ollama` AND the bug's reproducer actually exercises inference (not pure CLI surface or sandbox build), the skill MUST stop here and prompt the maintainer interactively before any Brev cost is incurred:

```text
The reporter's reproducer uses the <provider> provider, which requires a real API key
to verify faithfully. Three options:

  1. Provide an API key via file (NEVER on the command line — keys in argv are
     visible in `ps -ef` to anyone with shell access on either machine). Write
     the key to a 600-perm file on your laptop:

       printf '%s' '<your-key>' > ~/.nvidia-api-key
       chmod 600 ~/.nvidia-api-key

     The skill copies the file to the Brev box via `brev copy` (encrypted SSH),
     reads it inside the box with `NVIDIA_API_KEY=$(cat ~/.nvidia-api-key)`,
     and never puts the value on a command line. Box deletion removes the file
     from the box; you should `rm ~/.nvidia-api-key` on your laptop after the
     run.

  2. Substitute Ollama and accept the -30 confidence penalty (per Step 8a.5). The
     verdict will be capped because we're not exercising the real provider's code
     path.

  3. Skip this issue. Mark `verify-inconclusive` with the reason "requires <provider>
     API key — not provided in this run."

Choose 1, 2, or 3:
```

This prompt blocks before Step 7 provisions a box. Don't burn cost on a verification path the maintainer hasn't agreed to.

**API-key propagation pattern (for option 1).** Argv exposure is a two-layer problem and the file-based pattern must extend to both layers.

**Layer 1 — local → Brev (surfaced #2604).** Passing the key as `NVIDIA_API_KEY=<value> brev exec ...` puts the literal value in the brev exec process's argv on the maintainer's laptop *and* on the Brev box (since brev exec serializes argv to the remote shell). Visible in `ps -ef` on both ends for the duration of the run. Use file-based copy:

```bash
# After Step 6.5 preconditions, copy the local key file to the Brev box.
[ -f ~/.nvidia-api-key ] && brev copy ~/.nvidia-api-key "$INSTANCE_NAME":~/.nvidia-api-key
brev exec "$INSTANCE_NAME" "chmod 600 ~/.nvidia-api-key 2>/dev/null || true"
```

**Layer 2 — on-box subshell (surfaced #2611).** Inside scripts running on the Brev box, the outer shell reads the key from `~/.nvidia-api-key` cleanly, but a *naive* inner subshell call leaks it back into argv:

```bash
# WRONG — the double-quoted outer heredoc interpolates $NVIDIA_API_KEY at
# script-eval time, so the literal nvapi- value lands in `sg docker -c "..."`'s
# argv and shows up in `ps -ef` on the box for the whole onboard window.
NVIDIA_API_KEY=$(cat ~/.nvidia-api-key)
sg docker -c "
  export NVIDIA_API_KEY='$NVIDIA_API_KEY'   # ← argv leak
  nemoclaw onboard ...
"

# RIGHT — escape the $ so the outer shell does not interpolate, and let the
# inner subshell read the file itself. Argv contains the command string
# `cat ~/.nvidia-api-key`, not the value.
sg docker -c "
  export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key)
  nemoclaw onboard ...
"
```

The same rule applies to any `bash -c "..."`, `bash -lc "..."`, `su -c "..."`, `ssh host "..."`, or other invocation that takes a command string as a single argv element: **never interpolate the key into the string at the outer shell's eval time**. Read the file inside the inner shell so the value lives in env-vars, never in argv.

Cleanup: when the trap fires `brev delete`, the box (and the key file on it) goes away. On the maintainer's laptop, the file persists until they `rm ~/.nvidia-api-key` — Step 12's session log should remind them. **If the key was previously propagated via cmdline (pre-fix at either layer), treat it as exposed and rotate.**

**Pure-CLI / pure-sandbox-build bugs are exempt** — those don't actually exercise inference, so the provider doesn't matter even if the issue body mentions one. Heuristic: if Step 6.7's local-first predicate would have fired (no sandbox state, no model server interaction), skip the prompt.

---

## Step 6: Extract the Reproducer

Extract whatever's available from the issue body. The decision about *whether the reproducer is good enough* lives in Step 8 (validate-on-baseline), not here.

NV QA files most bugs through an HTML form, so issue bodies are typically a mix of `<pre>...</pre>` blocks and tables — not markdown fenced code blocks. Extraction must handle both shapes.

1. **Verbatim:** the first markdown fence (```` ``` ```` or ```` ~~~ ````) **or** HTML `<pre>` block containing a `nemoclaw` invocation. Strip surrounding tags and unescape HTML entities before saving to `./reproducer.sh`. No confidence penalty (yet).
2. **No verbatim block found:** leave `./reproducer.sh` absent. Step 8b will synthesize from the issue body on demand and apply the **−30 synth penalty** at that point.

A robust extractor handles both shapes with the body fetched as JSON. The "anchor word" — what marks a block as a reproducer — must include `nemoclaw`, `openclaw`, AND `openshell`. Issue #2592 surfaced this gap: its reproducer was `openclaw channels add telegram` run inside the sandbox; a `nemoclaw`-only regex would have missed the verbatim block and forced the run through Step 8c synth-repro with a -30 penalty:

```bash
BODY=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json body -q .body)

REPRODUCER=$(printf '%s' "$BODY" | python3 -c '
import re, sys, html
b = sys.stdin.read()
# Anchor word: any of nemoclaw / openclaw / openshell. Issue bodies use whichever
# tool the reporter ran (host-side nemoclaw vs in-sandbox openclaw vs openshell CLI).
ANCHOR = r"(?:nemoclaw|openclaw|openshell)"
m = re.search(rf"```(?:bash|sh)?\n(.*?{ANCHOR}.*?)\n```", b, re.S)
if not m: m = re.search(rf"~~~(?:bash|sh)?\n(.*?{ANCHOR}.*?)\n~~~", b, re.S)
if not m: m = re.search(rf"<pre[^>]*>(.*?{ANCHOR}.*?)</pre>", b, re.S)
if m:
    text = re.sub(r"<[^>]+>", "", m.group(1))
    print(html.unescape(text).strip())
')

[ -n "$REPRODUCER" ] && printf '%s\n' "$REPRODUCER" > ./reproducer.sh
```

The "give up immediately" path is gone. Synthesis happens at validation time so it has the baseline transcript to react to, not just the issue body in isolation. The give-up decision now lands in Step 8c when synth fails to produce a script that actually exposes the bug.

---

## Step 6.5: Verify Preconditions

Confirm CLI dependencies are available, `brev` is authenticated, and the install URL resolves before paying any cost. Credentials live in `~/.brev/credentials.json` and are reused across shells under the same OS user, so once authenticated the auth check is a no-op until the token expires.

```bash
# CLI deps — fail fast if anything later in the skill needs them but they're missing.
for cmd in gh brev jq python3 curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: missing required dependency: $cmd"; exit 1; }
done

# gh identity — every comment posted by Step 10 lands under whatever account `gh` is currently
# authenticated as. Surface that explicitly so the maintainer notices before a public comment
# lands under the wrong handle (this matters when `gh` is multi-token, after a recent re-auth,
# or when running under a service-account hostname).
GH_IDENTITY=$(gh api user --jq .login 2>/dev/null)
if [ -z "$GH_IDENTITY" ]; then
  echo "ERROR: gh CLI is not authenticated. Run: gh auth login   # then re-run this skill"
  exit 1
fi
echo "gh identity: @$GH_IDENTITY — comments posted by this run will appear under this handle"

# gh 'project' scope — Step 10 moves fixed-on-latest issues to "Needs Review" on Project 199. Warn if missing.
gh auth status 2>&1 | grep -q "'project'" || echo "[verify-stale] WARN gh missing 'project' scope — Step 10 tracker move will skip. Fix: run 'gh auth refresh -h github.com -s project' in a real terminal."

# Brev auth — short-circuit only after the auth check, not before.
# When auth fails, give the user a directive recipe (the browser-flow path is
# what works from non-TTY harnesses like Claude Code, not the headless options).
brev ls --json >/dev/null 2>&1 || {
  cat <<'MSG'

ERROR: Brev not authenticated. ~/.brev/credentials.json is missing or the token expired.

What to do (works from any harness, including non-TTY agent contexts):

  1. Open a separate Terminal on your laptop.
  2. Run:   brev login
     A browser opens; complete the auth flow; the CLI exits on success.
  3. Come back here and re-run this skill. Credentials persist to
     ~/.brev/credentials.json and every subsequent `brev` call picks them up.

Headless / no-browser alternatives (when option 1 isn't available):
  - brev login --skip-browser            # prints a URL, paste into any browser
  - brev login --token "$BREV_API_TOKEN" # non-interactive; same env var used
                                         # by test/e2e/brev-e2e.test.ts

MSG
  exit 1
}

# Repo labels exist — Step 8.5 / Step 10 can't apply a label that doesn't exist. Check
# canonical label names against the live repo so a mismatch fails fast (issue #2168 hit this:
# spec called the label `wontfix`, but the actual repo label is `status: wont-fix`).
EXPECTED_LABELS=("fixed-on-latest" "verify-inconclusive" "status: wont-fix")
LIVE_LABELS=$(gh label list --repo NVIDIA/NemoClaw --limit 200 --json name --jq '.[].name')
for label in "${EXPECTED_LABELS[@]}"; do
  printf '%s\n' "$LIVE_LABELS" | grep -Fxq "$label" || {
    echo "ERROR: expected label not on repo: '$label'"
    echo "       create it with: gh label create '$label' --repo NVIDIA/NemoClaw"
    exit 1
  }
done

# Install URL reachable — fails fast instead of mid-Brev-run if the host is down or the URL changed.
# The default is the public Akamai-hosted entry (301-redirects to the actual installer). The
# `nemoclaw.nvidia.com` host that earlier drafts pointed to is NVIDIA-internal and does not
# resolve from Brev; surfaced during the #2007 e2e run.
INSTALL_URL=${NEMOCLAW_INSTALL_URL:-https://www.nvidia.com/nemoclaw.sh}
curl -fsI "$INSTALL_URL" >/dev/null 2>&1 || {
  echo "ERROR: install URL not reachable: $INSTALL_URL"
  echo "  - Check https://www.nvidia.com/nemoclaw.sh is up (the default Akamai-hosted entry)."
  echo "  - Override with NEMOCLAW_INSTALL_URL=<alternate-url> if your team mirrors the installer."
  echo "  - Then re-run this skill."
  exit 1
}
```

If invoked from an environment without a TTY (some agent harnesses), prefer `brev login --skip-browser` or `--token` over the default browser flow.

---

## Step 6.7: Try Local Reproduction First

For pure-CLI reproducers (no sandbox state, no GPU, no integration tokens), try locally before paying for a Brev box. The evidence is identical — `nemoclaw <args>` on a maintainer laptop produces the same exit code and stdout as on a fresh Brev VM, modulo platform differences — and the run is free.

**Predicate** — local-first applies if **all** of these hold:

- Reproducer is a sequence of `nemoclaw <args>` invocations only. No `docker`, `kubectl`, `curl`, `npm`, networking setup, or filesystem fixtures.
- Issue has no `Sandbox`-only or `Docker` label and no GPU signal from Step 5.
- `which nemoclaw` resolves on the maintainer's machine and `nemoclaw --version` reports a build at or past `$LATEST` (a build between `$LATEST` and `$LATEST+main` is fine — these only differ by unmerged WIP).
- Maintainer is on Linux or macOS. Windows local repros are out of scope (per Step 3 platform skip rules).

**If the predicate fires:**

```bash
LOCAL_VERSION=$(nemoclaw --version 2>&1)
LOCAL_TRANSCRIPT=$(mktemp)
{ time bash reproducer.sh; } >"$LOCAL_TRANSCRIPT" 2>&1
LOCAL_EXIT=$?
echo "Local: $LOCAL_VERSION, exit $LOCAL_EXIT"
```

Compare local result to the issue's "Actual Result" section using the same match rubric Step 8b applies on baseline:

- **Local matches the issue symptom exactly** (same exit code + same diagnostic output) AND the symptom is the post-fix expected output → skip Brev. Use the local transcript as the verified-on-latest evidence. Step 10's comment must say `Environment: local install (<version>) — Brev provisioning skipped, outcome deterministic from CLI surface alone`.
- **Local result differs from the reported "Actual Result"** → continue to Step 7 and run on Brev. The local environment may be a confound (different OS, dirty config, partial build); remote confirms.
- **Local repro errors out for environmental reasons** (`nemoclaw: command not found`, npm link broken) → continue to Step 7. Treat as inconclusive locally, not a verification failure.

**If the predicate does not fire:** proceed to Step 7 normally. Most sandbox-touching bugs need Brev.

---

## Steps 7–12 — Execution, Scoring, and Comment

Once a candidate has cleared Step 6.7's local-first short-circuit and a Brev run is committed to, the rest of the workflow lives in **[reference/execution-and-comment.md](reference/execution-and-comment.md)**:

- **Step 7** — Reuse or provision the Brev box (concurrency cap, runtime SKU pick, file-based API key copy).
- **Step 8** — Validate the reproducer on baseline, comprehensive reset, install latest, run again. Sub-steps cover dependency bootstrap, brev-exec quirks, synth-repro retry, architectural-drift check, performance and rebuild-cycle bug classes.
- **Step 8.5** — Detect "behavior changed by design" (three signals; short-circuits Brev cost on intentional removals).
- **Step 9** — Score confidence (+50 / +25 / +25 / −30 / −50; cap-at-84 when baseline didn't validate).
- **Step 10** — Compose and post the comment (redaction, 300-word ceiling, three templates, unanswered-question variant when Step 3 sets `UNANSWERED_MAINT_LOGIN`).
- **Step 11** — Infra failure handling (sandbox-build rot is the dominant failure for any version >5–7 patches behind).
- **Step 12** — Log to the activity file.
- **Cadence**, **Out of Scope (v1)**, and the **Companion Behavior** note (release-tag sweep) live there as well.

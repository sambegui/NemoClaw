---
name: nemoclaw-maintainer-scope-issues
description: Classifies open issues for non-fix close reasons. Builds a repo-scope model from CLAUDE.md, docs/, nemoclaw-blueprint/, and user skills, then routes each open issue into DUPLICATE / OUT_OF_SCOPE / UPSTREAMED / STALE_NO_REPRO / WONTFIX_BY_DESIGN with category-specific signals and confidence caps. Chains into `close-superseded-issues` via JSON sidecar. Use when companion `find-already-fixed` covers code-grounded closes and the queue still has noise — duplicates, out-of-scope requests, upstreamed bugs, stale-no-repro, or design-conflicts. Local-only, draft-only — never closes on its own.
---

# Scope Issues

Companion to `nemoclaw-maintainer-find-already-fixed`. Where `find-already-fixed` answers "is this issue already fixed in code?", this skill answers "should this issue be closed for a *non-fix* reason — duplicate, out-of-scope, upstreamed, stale, or wontfix?"

Different signals, different evidence shapes, same downstream action skill (`close-superseded-issues`).

## Why this matters

Open-issue noise comes from at least five distinct sources, and each has a different right-action:

- **Duplicates** clutter the queue and split discussion across multiple threads — closing them with a link to the canonical issue consolidates context.
- **Out-of-scope** asks (e.g., "support Windows", "add X to NemoClaw" when X belongs in OpenClaw upstream) sit forever because no one owns them — closing with scope-docs evidence signals to the reporter where to redirect.
- **Upstreamed** issues are NemoClaw-tagged but the root cause / fix lives in OpenClaw, OpenShell, or a dependency — closing with the upstream pointer is the right action.
- **Stale-no-repro** issues are reports where the reporter ghosted after a maintainer asked for more info — closing after a revival comment + 14d grace is the right action.
- **Wontfix-by-design** issues ask for something that conflicts with the documented security model or architecture — closing with the design-decision pointer ends the round-trip cleanly.

Lumping these into a generic "stale issue sweep" loses precision. This skill detects each category independently with category-specific signals.

## Invocation

```text
/nemoclaw-maintainer-scope-issues
```

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--top N` | `15` | Maximum candidates to surface |
| `--categories` | `DUPLICATE,OUT_OF_SCOPE,UPSTREAMED,STALE_NO_REPRO,WONTFIX_BY_DESIGN` | Comma-separated subset to run |
| `--min-confidence` | `0.6` | Required confidence to include a candidate |
| `--upstreams` | `OpenClaw,OpenShell,openshell-sdk` | Dependency names treated as upstream candidates |
| `--draft-only` | `on` | Draft close-comments only; never closes (closure is `close-superseded-issues`'s job) |

## Building the scope model (run once per invocation, cache to `/tmp/scope-model-<run_id>.json`)

The scope model is a structured snapshot of what NemoClaw documents itself to be. Re-built per run because docs evolve. **All inputs are read-only.**

| Source | What we extract | Used by classifier |
|---|---|---|
| `CLAUDE.md` § "Project Overview" | One-paragraph project statement | OUT_OF_SCOPE, WONTFIX_BY_DESIGN |
| `CLAUDE.md` § "Architecture" table | The complete list of in-scope paths/components | OUT_OF_SCOPE |
| `docs/` page index (`docs/index.md` + every `*.md`) | Documented features and workflows | OUT_OF_SCOPE |
| `nemoclaw-blueprint/` (YAML files) | Supported policies, agents, providers | OUT_OF_SCOPE (the runtime surface) |
| `.agents/skills/nemoclaw-user-*/SKILL.md` | Documented user workflows | OUT_OF_SCOPE (the user-facing surface) |
| `CONTRIBUTING.md` (if present) | Explicit non-goals, contribution boundaries | WONTFIX_BY_DESIGN |
| `SECURITY.md` (if present) | Security model invariants | WONTFIX_BY_DESIGN |
| `.github/ISSUE_TEMPLATE/*` (if present) | Required fields → what kinds of issues belong | (sanity check only) |
| `gh pr list --state merged --search "merged:>=$(date -v-90d +%Y-%m-%d)" --json title,body` | Last 90 days of `Closes #N` trailers | DUPLICATE (canonical issue resolution) |

**Build command (paste-able):**

```bash
RUN_ID=$(date +%s)-$(uuidgen | head -c 8)
SCOPE_MODEL=/tmp/scope-model-$RUN_ID.json
{
  echo '{'
  echo '"schema_version": 1,'
  echo '"built_at": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",'
  echo '"sources": {'
  echo '  "claude_md": '$(jq -Rs . < CLAUDE.md)','
  echo '  "docs_index": '$(jq -Rs . < docs/index.md 2>/dev/null || echo '""')','
  echo '  "user_skills_inventory": ['$(ls .agents/skills/nemoclaw-user-* 2>/dev/null | xargs -I {} basename {} | jq -R . | paste -sd, -)'],'
  echo '  "blueprint_yaml": '$(find nemoclaw-blueprint -name '*.yaml' 2>/dev/null | xargs -I {} basename {} .yaml | jq -R . | paste -sd, - | jq -s .)','
  echo '  "contributing": '$([ -f CONTRIBUTING.md ] && jq -Rs . < CONTRIBUTING.md || echo '""')
  echo '  }'
  echo '}'
} > $SCOPE_MODEL
```

## Classifiers (each issue passes through all enabled classifiers; can fire multiple)

### `DUPLICATE` (confidence: combined signals up to 0.9)

**Signal D1 — Title token overlap ≥80%** (+0.4) against any OTHER open issue OR closed issue from the last 180 days. Tokenize title (lowercase, strip stopwords, drop `<6 char`); compute Jaccard.

```bash
gh issue list --repo NVIDIA/NemoClaw --state all --limit 500 \
  --json number,title,state,createdAt -q '.[] | select(.state == "OPEN" or (.state == "CLOSED" and (.createdAt | fromdateiso8601 > (now - 15552000))))' \
  > /tmp/issue-pool.json
# Compute Jaccard per pair, surface pairs ≥ 0.80
```

**Signal D2 — Same `Closes #N` trailer** (+0.5) — a merged PR closed one issue with a trailer; another open issue has the same trailer or title-overlap ≥0.6 with the closed one. Strong duplicate signal.

**Signal D3 — Same reporter, similar body** (+0.3) — same `user.login`, body cosine similarity ≥0.7, filed within 30 days. Often "I forgot I filed this last month."

**Output:** Always link the canonical (oldest, or the one closed by PR) as the "kept" issue. Close the duplicate with `reason=completed` and a one-line comment: `Closing as duplicate of #<canonical> — discussion consolidated there.`

### `OUT_OF_SCOPE` (confidence: combined signals up to 0.8)

Asks for a feature/behavior that's absent from NemoClaw's documented surface AND adding it would expand the surface rather than deepen an existing area.

**Signal O1 — Title/body grep negative on scope model** (+0.4): extract the noun phrase from the issue's "Expected" or "Feature request" section, grep the scope model. If absent from CLAUDE.md, docs/, blueprint YAML, AND nemoclaw-user-skill names → +0.4.

**Signal O2 — Asks for a new platform/runtime** (+0.4): regex match against `windows|wsl1|raspberry pi|arm32|arm6|risc-v|freebsd` in title/body when CLAUDE.md's Architecture doesn't include them. Strong signal because platform expansion = surface expansion.

**Signal O3 — Asks for upstream-dependency feature** (+0.3): regex match against names in `--upstreams` (default `OpenClaw,OpenShell,openshell-sdk`); the body asks for a behavior change in one of those, not in NemoClaw's own code. (Overlaps with UPSTREAMED — that classifier owns the case once Signal O3 + an upstream-tracking-issue lookup both fire.)

**Confidence cap:** 0.8 — never 1.0. OUT_OF_SCOPE is judgment, not fact. **Always require user confirmation per issue before close.**

**Output draft comment template:**

```text
Closing as out-of-scope for NemoClaw. The documented project surface (CLAUDE.md § Architecture + docs/) covers <X, Y, Z>; <requested feature> would expand that surface rather than fix an existing capability.

If you'd like to pursue this, the right channel is <upstream / new project / RFC process>. Reopen if there's a documented in-scope angle I missed.
```

### `UPSTREAMED` (confidence: combined signals up to 0.9)

The root cause / fix belongs in a dependency, not in NemoClaw.

**Signal U1 — Body explicitly names upstream** (+0.5): body contains `openclaw#<N>` / `openshell#<N>` / a github.com/anthropic/openclaw URL / `bug in OpenClaw`. Strong.

**Signal U2 — Stack trace points to upstream module** (+0.4): code fence in body contains `at OpenClawAgent.` / `node_modules/openclaw-cli/` / similar. Strong.

**Signal U3 — Linked upstream issue/PR is closed** (+0.3): the upstream issue/PR named in U1/U2 is in CLOSED / MERGED state on the upstream repo, AND NemoClaw bumped its dependency since the close (check `package.json` or `pyproject.toml` history with `git log --oneline -- <manifest> | head -10`).

**Output draft comment template:**

```text
Closing — root cause is upstream in <upstream-repo>. The fix landed in <upstream-issue-or-pr-link>; NemoClaw inherits it via <dep-bump-PR or dep-version-tag>.

If you can reproduce on NemoClaw HEAD with the latest <upstream-name> dependency, reopen with a fresh trace.
```

### `STALE_NO_REPRO` (confidence: combined signals up to 0.8)

Reporter ghosted after a maintainer asked for more info.

**Signal S1 — Last maintainer comment is `needs-info`-shaped AND reporter has not replied** (+0.5): scan comments for `can you reproduce on`, `provide your <log/config/version>`, `does this still happen on main`. If the *latest* comment is from a maintainer (author_association MEMBER/OWNER/COLLABORATOR) and matches that pattern, AND the reporter hasn't commented since, +0.5.

**Signal S2 — Days since last reporter activity** (+0.3 if >60d, +0.5 if >180d): hard staleness signal. Use the larger of the two; do not stack.

**Signal S3 — `needs-info` / `awaiting-response` label present** (+0.2): explicit maintainer signal.

**Important rule:** even at confidence 1.0, this category requires a **revival-comment-then-wait** workflow, not an immediate close. Post the revival comment (via `close-superseded-issues` with a flag we add: `--revival-comment-only`), wait 14 days, close only if no reporter response. **For the first pass, the draft action is "post revival comment," not "close."**

**Output draft revival comment template:**

```text
@<reporter> — closing this in 14 days if there's no reply. We last asked for <X> on <date> and haven't heard back. If this is still a problem on NemoClaw HEAD, please reopen with a fresh repro.
```

### `WONTFIX_BY_DESIGN` (confidence: combined signals up to 0.7)

Asks for something that conflicts with NemoClaw's documented security model or architecture decisions.

**Signal W1 — Body request conflicts with `SECURITY.md` invariant** (+0.4): regex-based conflict detection — e.g., issue says "let agents access arbitrary egress" while SECURITY.md says "egress is whitelisted by policy"; or issue says "disable sandbox isolation" while SECURITY.md mandates sandbox.

**Signal W2 — Body request conflicts with CLAUDE.md Architecture decision** (+0.4): same idea against documented architectural decisions ("uses Sphinx", "OpenShell is the sandbox runtime", "policies live in YAML").

**Signal W3 — Similar past issue closed as wontfix** (+0.3): a past closed issue with title/body cosine ≥0.7 was closed with `state_reason: not_planned` AND closer's comment mentions design/security.

**Confidence cap:** 0.7 — always halt for user confirmation before close. WONTFIX is a high-status verdict and reporters take it personally; the maintainer must own the decision.

**Output draft comment template:**

```text
Closing as wontfix-by-design. <Requested behavior> conflicts with <documented invariant — link to SECURITY.md / CLAUDE.md / RFC>. The project's stance is <one-line summary>.

If the design itself should change, the right channel is an RFC, not an issue — open a discussion in <forum/repo>.
```

## Workflow

1. **Build scope model.** Cache to `/tmp/scope-model-<run_id>.json` once at start.
2. **Pull open issue list.** Lightweight fetch: `gh issue list --state open --limit 200 --json number,title,body,labels,author,createdAt,updatedAt,comments`.
3. **For each issue, run enabled classifiers in this order:** DUPLICATE → UPSTREAMED → OUT_OF_SCOPE → STALE_NO_REPRO → WONTFIX_BY_DESIGN.
   - First-match priority for *what to surface to the user first*; but ALL firing categories are recorded in the JSON sidecar, not just the first.
4. **Score and rank.** Sort by max-confidence-across-categories descending. Surface top `--top N`.
5. **Draft close comments.** One per (issue, category) — use the templates above, with evidence interpolated.
6. **Emit JSON sidecar.** See "JSON sidecar output" below.
7. **Stop.** Do NOT close. Print drafts to conversation; user reviews. To actually close, chain into `close-superseded-issues --from <sidecar-path>`.

## Reporter-history check (hardening — adjusts confidence on judgment-heavy categories)

OUT_OF_SCOPE and WONTFIX_BY_DESIGN are judgment calls. The cost of getting them wrong is highest when the reporter is a known returning user / external stakeholder; the cost is lowest when the reporter is a drive-by filer. Reporter history calibrates that.

For each candidate, before finalizing confidence on OUT_OF_SCOPE / WONTFIX_BY_DESIGN, look up the reporter's history:

```bash
REPORTER=$(gh issue view "$ISSUE" --repo NVIDIA/NemoClaw --json author --jq .author.login)
# Past issues authored on this repo (any state)
PAST_ISSUES=$(gh search issues --repo NVIDIA/NemoClaw --author "$REPORTER" --json number 2>/dev/null | jq 'length')
# Past PRs authored on this repo (any state)
PAST_PRS=$(gh search prs --repo NVIDIA/NemoClaw --author "$REPORTER" --json number 2>/dev/null | jq 'length')
# Has the maintainer team ever responded to this user constructively?
ENGAGEMENT=$(gh api "search/issues?q=commenter:NVIDIA/nemoclaw-maintainer+author:$REPORTER+repo:NVIDIA/NemoClaw" --jq '.total_count')
```

**Calibration rules:**

| Reporter profile | Adjustment | Why |
|---|---|---|
| `PAST_PRS > 0` (has contributed code) | OUT_OF_SCOPE confidence -0.2; require user confirm | Contributor's scope intuition is usually well-calibrated; don't close their issue without deliberation |
| `PAST_ISSUES ≥ 5` AND `ENGAGEMENT ≥ 3` (engaged returning reporter) | OUT_OF_SCOPE confidence -0.1; require user confirm | Returning user — closing without conversation costs goodwill |
| `PAST_ISSUES == 1` AND `ENGAGEMENT == 0` (drive-by filer) | No adjustment; default flow | Standard case |
| `PAST_ISSUES == 1` AND `author_association == NONE/FIRST_TIME_CONTRIBUTOR` | Add "welcome note" to draft comment | Soft-close for first-timers; explain the scope, invite them back |

Drop the result into the per-result JSON sidecar as a `reporter_profile` field so `close-superseded-issues` can surface it at confirmation time.

## JSON sidecar output

Writes `/tmp/nemoclaw-skill-output-scope-issues-<run_id>.json`. Shares the maintainer-suite envelope (see `find-already-fixed/SKILL.md` for the envelope spec).

**Per-result shape:**

```json
{
  "issue": 3456,
  "url": "https://github.com/NVIDIA/NemoClaw/issues/3456",
  "title": "...",
  "categories": [
    {
      "category": "DUPLICATE",
      "confidence": 0.85,
      "signals_fired": ["D1", "D2"],
      "evidence": { "canonical_issue": 3200, "title_jaccard": 0.91 },
      "draft_close_comment": "Closing as duplicate of #3200 ...",
      "suggested_close_reason": "completed"
    },
    {
      "category": "UPSTREAMED",
      "confidence": 0.6,
      "signals_fired": ["U1"],
      "evidence": { "upstream_ref": "openclaw#1234" },
      "draft_close_comment": "Closing — root cause is upstream ...",
      "suggested_close_reason": "not_planned"
    }
  ],
  "top_category": "DUPLICATE",
  "requires_user_confirm": true
}
```

`next_skill_hint` always points to:

```json
{"skill": "nemoclaw-maintainer-close-superseded-issues",
 "args": "--from /tmp/nemoclaw-skill-output-scope-issues-<run_id>.json"}
```

**Important contract for `close-superseded-issues` to honor when reading this sidecar:**

- If `top_category == "STALE_NO_REPRO"`, the action is "post revival comment, do NOT close" — `close-superseded-issues` must support `--revival-only` for these rows.
- If `top_category in {OUT_OF_SCOPE, WONTFIX_BY_DESIGN}` OR the issue has `priority: high` + `NV QA` labels, `requires_user_confirm: true` — `close-superseded-issues` must per-issue prompt (its default behavior already covers this).

## Output discipline

Markdown summary + per-candidate evidence block. Example:

```text
Top 5 scope-noise candidates (confidence ≥ 0.6):

| # | Conf | Category | Title |
|---|---|---|---|
| #3456 | 0.85 | DUPLICATE | "openclaw subcommand fails on first invocation" |
| #2105 | 0.80 | STALE_NO_REPRO | "feat(onboard): add Tavily" |
| #1234 | 0.75 | OUT_OF_SCOPE | "Windows support" |
| #4321 | 0.70 | UPSTREAMED | "openclaw deadlocks on shutdown" |
| #5555 | 0.65 | WONTFIX_BY_DESIGN | "disable network policy enforcement" |

─── #3456 evidence (DUPLICATE 0.85) ───
Canonical: #3200 "openclaw plugin: first-run uninstall residuals" (closed 2026-04-22 by PR #3247)
Title Jaccard: 0.91 ({"openclaw", "subcommand", "fails", "first", "invocation"} ∩ canonical)
Body cosine: 0.78

Draft close comment:
> Closing as duplicate of #3200 — discussion consolidated there.

To close all surfaced candidates after review:
  /nemoclaw-maintainer-close-superseded-issues --from /tmp/nemoclaw-skill-output-scope-issues-<run_id>.json
```

## Halt conditions (the non-obvious one)

- **More than 30% of candidates land in WONTFIX_BY_DESIGN** — almost always a false-positive cascade from too-broad regex matching. Pause and have the maintainer audit the regexes against the actual conflict claims before continuing.
- Scope model build fails (CLAUDE.md or docs/ missing) — likely wrong working directory; halt.

Generic halts (user-stop, API errors, `--top N` overflow) are assumed.

## Hard nos

- Read-only detection. No closing, no commenting, no label changes, no auto-filed upstream issues. `close-superseded-issues` is the action skill.

## Integration with the maintainer skill suite

```text
nemoclaw-maintainer-find-already-fixed  (code-grounded detection)
                  ↓ (JSON sidecar)
nemoclaw-maintainer-scope-issues       (doc-grounded detection)
                  ↓ (JSON sidecar)
nemoclaw-maintainer-close-superseded-issues  (generic action — closes any sidecar-shaped list)
```

Run both detectors in sequence, merge sidecars (`jq -s '.[0].results + .[1].results'`), feed to the action skill.

## Failure-mode reference (the calibration cases)

- **STALE_NO_REPRO false-positive shape:** issue is old AND reporter ghosted, BUT the maintainer team never asked for repro — that's not stale, that's *untriaged*. Signal S1 (needs-info shape from maintainer) must fire before STALE_NO_REPRO is valid; absence of S1 + >60d age = re-route to `fresh-issue-triage`, not close.
- **UPSTREAMED false-positive shape:** body mentions OpenClaw casually ("when I run nemoclaw, openclaw exits…"); that's NemoClaw's responsibility (NemoClaw spawns openclaw), not OpenClaw's. Signal U1 needs stronger phrasing — `bug in OpenClaw` or stack trace pointing to `node_modules/openclaw-cli/`, not just any mention.
- **OUT_OF_SCOPE precision-killer:** scope docs are incomplete by definition. If CLAUDE.md doesn't mention X, that doesn't always mean X is out-of-scope — it might be a documented gap. Always require user confirm for OUT_OF_SCOPE close; never auto-confirm even at 0.8.

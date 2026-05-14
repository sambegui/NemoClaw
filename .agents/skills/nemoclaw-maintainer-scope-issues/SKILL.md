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

## Classifiers

Each issue passes through five classifiers; multiple categories can fire per issue. Each has category-specific signals, confidence caps, and a draft close-comment template:

- **DUPLICATE** (confidence cap 0.9) — title token overlap, same `Closes #N` trailer, same reporter / similar body
- **OUT_OF_SCOPE** (cap 0.8) — request absent from scope model AND would expand the documented surface
- **UPSTREAMED** (cap 0.9) — root cause / fix belongs in a dependency (OpenClaw, OpenShell, etc.)
- **STALE_NO_REPRO** (cap 0.8) — reporter ghosted after maintainer asked for more info; revival workflow, not immediate close
- **WONTFIX_BY_DESIGN** (cap 0.7) — conflicts with documented security model or architecture decision

For the full signal lists, confidence weights, machine-checkable commands, and draft-comment templates, see [CLASSIFIERS.md](CLASSIFIERS.md).

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

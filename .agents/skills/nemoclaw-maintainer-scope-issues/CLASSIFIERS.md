# Scope-issues — Classifier reference

## `DUPLICATE` (confidence: combined signals up to 0.9)

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

## `OUT_OF_SCOPE` (confidence: combined signals up to 0.8)

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

## `UPSTREAMED` (confidence: combined signals up to 0.9)

The root cause / fix belongs in a dependency, not in NemoClaw.

**Signal U1 — Body explicitly names upstream** (+0.5): body contains `openclaw#<N>` / `openshell#<N>` / a github.com/anthropic/openclaw URL / `bug in OpenClaw`. Strong.

**Signal U2 — Stack trace points to upstream module** (+0.4): code fence in body contains `at OpenClawAgent.` / `node_modules/openclaw-cli/` / similar. Strong.

**Signal U3 — Linked upstream issue/PR is closed** (+0.3): the upstream issue/PR named in U1/U2 is in CLOSED / MERGED state on the upstream repo, AND NemoClaw bumped its dependency since the close (check `package.json` or `pyproject.toml` history with `git log --oneline -- <manifest> | head -10`).

**Output draft comment template:**

```text
Closing — root cause is upstream in <upstream-repo>. The fix landed in <upstream-issue-or-pr-link>; NemoClaw inherits it via <dep-bump-PR or dep-version-tag>.

If you can reproduce on NemoClaw HEAD with the latest <upstream-name> dependency, reopen with a fresh trace.
```

## `STALE_NO_REPRO` (confidence: combined signals up to 0.8)

Reporter ghosted after a maintainer asked for more info.

**Signal S1 — Last maintainer comment is `needs-info`-shaped AND reporter has not replied** (+0.5): scan comments for `can you reproduce on`, `provide your <log/config/version>`, `does this still happen on main`. If the *latest* comment is from a maintainer (author_association MEMBER/OWNER/COLLABORATOR) and matches that pattern, AND the reporter hasn't commented since, +0.5.

**Signal S2 — Days since last reporter activity** (+0.3 if >60d, +0.5 if >180d): hard staleness signal. Use the larger of the two; do not stack.

**Signal S3 — `needs-info` / `awaiting-response` label present** (+0.2): explicit maintainer signal.

**Important rule:** even at confidence 1.0, this category requires a **revival-comment-then-wait** workflow, not an immediate close. Post the revival comment (via `close-superseded-issues` with a flag we add: `--revival-comment-only`), wait 14 days, close only if no reporter response. **For the first pass, the draft action is "post revival comment," not "close."**

**Output draft revival comment template:**

```text
@<reporter> — closing this in 14 days if there's no reply. We last asked for <X> on <date> and haven't heard back. If this is still a problem on NemoClaw HEAD, please reopen with a fresh repro.
```

## `WONTFIX_BY_DESIGN` (confidence: combined signals up to 0.7)

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

---
name: nemoclaw-maintainer-verify-stale
description: Verify whether old NVIDIA/NemoClaw bug reports still reproduce against the latest tag. Picks candidate issues opened against older versions, runs the reproducer locally first when possible (Linux or macOS), otherwise reuses or provisions a Brev Linux box (CPU or GPU), detects behavior that was intentionally changed, scores confidence, and posts an evidence-backed comment with a label (fixed-on-latest, status wont-fix, or verify-inconclusive). Tag-only — never auto-closes. Brev verification is Linux-only in v1; Windows and integration-token-dependent issues are skipped. Trigger keywords - verify stale, verify fixed, reproduce on latest, stale issue, old bug, fixed-on-latest, status wont-fix, verify-inconclusive, drain backlog, brev verify.
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

**Batch mode** — user says "batch", "weekly", or provides no number. Cap at 20 issues per run.

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --limit 100 \
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
**Issue-type skip:** drop if any of `enhancement`, `documentation`, `status: wont-fix`, `status: needs-info`, `security`. Use the canonical repo label names — bare `wontfix` / `needs-info` are NOT the repo's labels (verified via `gh label list`); the actual labels carry a `status:` prefix and a hyphen.

**Platform skip (Linux-only in v1):** drop if any of `Platform: Windows/WSL`, `Platform: MacOS`, `Platform: macOS`. Keep `Platform: Ubuntu`, `Platform: DGX Spark`, `Platform: GB10`, `Platform: All`, or no platform label.

**Integration skip (deferred to v2):** drop if any of `Integration: Slack`, `Integration: Discord`, `Integration: Telegram`, `Integration: Hermes`, `Integration: OpenClaw`, `Integration: WeChat`. These need third-party credentials a fresh Brev box cannot provide.

**Component allowlist (must have at least one):** `NemoClaw CLI`, `Sandbox`, `OpenShell`, `Docker`, `Getting Started`, or any `Platform:` label that survived the platform skip.

**Idempotency:** drop if **either** of these is true:

- The issue carries a `fixed-on-latest` or `verify-inconclusive` label. (Cleared by the release sweep in `nemoclaw-maintainer-cut-release-tag` so the issue re-opens on each release.) The by-design path uses the existing repo `status: wont-fix` label, which is already covered by the issue-type skip rule above — no separate idempotency clause needed for that path.
- A comment matching `<!-- nemoclaw-verify-stale v\d+ YYYY-MM-DD -->` was posted **within the last 7 days**. The regex matches any marker version (`v1`, `v2`, …) so future skill versions can re-verify older-marked issues by tightening the regex (e.g. require a specific marker version). The marker carries a date so the candidate filter can apply a TTL — useful for the still-reproduces case (Step 9), where no label is applied and we want next week's run to re-verify rather than skip forever.

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

---

## Step 6: Extract the Reproducer

Extract whatever's available from the issue body. The decision about *whether the reproducer is good enough* lives in Step 8 (validate-on-baseline), not here.

NV QA files most bugs through an HTML form, so issue bodies are typically a mix of `<pre>...</pre>` blocks and tables — not markdown fenced code blocks. Extraction must handle both shapes.

1. **Verbatim:** the first markdown fence (```` ``` ```` or ```` ~~~ ````) **or** HTML `<pre>` block containing a `nemoclaw` invocation. Strip surrounding tags and unescape HTML entities before saving to `./reproducer.sh`. No confidence penalty (yet).
2. **No verbatim block found:** leave `./reproducer.sh` absent. Step 8b will synthesize from the issue body on demand and apply the **−30 synth penalty** at that point.

A robust extractor handles both shapes with the body fetched as JSON:

```bash
BODY=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json body -q .body)

REPRODUCER=$(printf '%s' "$BODY" | python3 -c '
import re, sys, html
b = sys.stdin.read()
m = re.search(r"```(?:bash|sh)?\n(.*?nemoclaw.*?)\n```", b, re.S)
if not m: m = re.search(r"~~~(?:bash|sh)?\n(.*?nemoclaw.*?)\n~~~", b, re.S)
if not m: m = re.search(r"<pre[^>]*>(.*?nemoclaw.*?)</pre>", b, re.S)
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

# Brev auth — short-circuit only after the auth check, not before.
brev ls --json >/dev/null 2>&1 || {
  echo "Brev not authenticated. Choose one:"
  echo "  1) brev login --skip-browser     # prints a URL, works from any shell"
  echo "  2) brev login                    # opens browser, run in a separate terminal if your shell lacks a TTY"
  echo "  3) brev login --token \"\$BREV_API_TOKEN\"  # non-interactive, same env var used by test/e2e/brev-e2e.test.ts"
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
INSTALL_URL=${NEMOCLAW_INSTALL_URL:-https://nemoclaw.nvidia.com/install.sh}
curl -fsI "$INSTALL_URL" >/dev/null 2>&1 || {
  echo "ERROR: install URL not reachable: $INSTALL_URL"
  echo "Set NEMOCLAW_INSTALL_URL or check https://nemoclaw.nvidia.com is up."
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

## Step 7: Reuse or Provision a Brev Box

The skill prefers reuse over provisioning. A pool of `verify-stale-*` boxes (CPU and GPU) can be kept warm; reuse the matching one if available, otherwise provision.

```bash
# Auth + install URL already verified by Step 6.5 — no need to re-check or auto-login here.

# Determine class from Step 5: "cpu" or "gpu"
INSTANCE_CLASS="cpu"   # or "gpu"

INSTANCES=$(brev ls --json)

# Look for an existing running verify-stale-* box matching the required class.
# CPU boxes have no .gpu field set; GPU boxes do.
EXISTING=$(echo "$INSTANCES" | jq -r --arg class "$INSTANCE_CLASS" '
  .[]?
  | select(.name | startswith("verify-stale-"))
  | select(.status == "RUNNING")
  | select(($class == "gpu" and (.gpu // "" != ""))
        or ($class == "cpu" and (.gpu // "" == "")))
  | .name' | head -1)

PROVISIONED_NEW=0

if [ -n "$EXISTING" ]; then
  INSTANCE_NAME="$EXISTING"
  echo "Reusing existing verification box: $INSTANCE_NAME"
else
  # Concurrency cap: refuse if 4+ verify-stale-* boxes are already running.
  RUNNING=$(echo "$INSTANCES" | jq '[.[]? | select(.name | startswith("verify-stale-"))] | length')
  if [ "$RUNNING" -ge 4 ]; then
    echo "ERROR: 4 verify-stale boxes already running. Wait for one to finish or reuse."
    exit 1
  fi

  INSTANCE_NAME="verify-stale-${ISSUE_NUMBER}-$(date +%s)"

  if [ "$INSTANCE_CLASS" = "gpu" ]; then
    # brev create auto-selects the cheapest GPU meeting the defaults
    # (>=20GB VRAM, >=500GB disk, compute >=8.0). Override with --type if needed.
    brev create "$INSTANCE_NAME"
  else
    # CPU case: pick the cheapest stoppable Linux SKU at runtime so the skill
    # doesn't rot when SKUs change. Override by exporting VERIFY_STALE_CPU_TYPE.
    CPU_TYPE=${VERIFY_STALE_CPU_TYPE:-$(brev search cpu --sort price --json \
      | jq -r '[.[] | select(.stoppable == true)] | .[0].type')}
    [ -n "$CPU_TYPE" ] || { echo "ERROR: no stoppable CPU SKU available"; exit 1; }
    brev create "$INSTANCE_NAME" --type "$CPU_TYPE"
  fi

  PROVISIONED_NEW=1
fi

# Cleanup runs on success, error, and SIGINT.
# Delete only what we provisioned. Reused boxes stay warm for next time.
# `brev delete` is non-interactive by default — there is no --yes flag, and passing one errors.
echo ">>> Brev instance: $INSTANCE_NAME (provisioned_new=$PROVISIONED_NEW; manual cleanup: brev delete $INSTANCE_NAME)"
trap '[ "$PROVISIONED_NEW" = "1" ] && brev delete "$INSTANCE_NAME" >/dev/null 2>&1 || true' EXIT
```

Wallclock cap per verification: **60 minutes** default. The cap accommodates two full install passes (baseline + latest), comprehensive resets between them, and any reproducer dependency bootstrapping (Step 8a.5) — most of which run sequentially against a single Brev box. Bugs that genuinely require more than an hour to manifest fall out of v1 scope; if a provisioned box isn't ready in time, abort and treat as an infra failure (Step 11).

The previous design had a 25-min default with a 60-min extension for time-sensitive bugs (`memory leak`, `over time`, etc.). That split optimised for the wrong constraint — most issues fit comfortably under 60 min, and the keyword-based extension forced re-runs whenever a real install or bootstrap took longer than the optimistic 25-min budget. Single 60-min cap removes that paper cut.

---

## Step 8: Validate on Baseline, Verify on Latest

Two-pass design.

- **Baseline pass (8a–8c):** install the **reported version**, run the reproducer, confirm it actually exposes the bug as described. This is the gate that proves the script is real.
- **Latest pass (8d):** install **latest**, run the validated reproducer. This is what the confidence score is built on.

Without the baseline gate, a clean run on latest is ambiguous: maybe the bug really got fixed, maybe the script was never capable of triggering it. The baseline disambiguates.

### Comprehensive reset (run before each install)

NemoClaw spawns OpenShell sandboxes (containers), runtime services, and listening processes. A naive `rm -rf ~/.nemoclaw` doesn't clean those — the latest install would inherit baseline state and contaminate the result. Use this fuller reset between installs:

```bash
RESET=$(cat <<'SCRIPT'
nemoclaw destroy --all --force 2>/dev/null || true
# Anchor pkill patterns to "/nemoclaw" / "/openshell" path components so the kill doesn't
# match unrelated processes that happen to mention these strings (including the agent
# harness running this skill if its working dir contains the word).
pkill -9 -f '/nemoclaw([[:space:]]|$)' 2>/dev/null || true
pkill -9 -f '/openshell([[:space:]]|$)' 2>/dev/null || true
docker ps -a --filter "name=openshell-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter "name=nemoclaw-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
# Sandbox state lives in ~/.openclaw (default-writable since #2227); ~/.nemoclaw holds CLI state.
# Wipe both so the latest install starts clean.
rm -rf ~/.nemoclaw ~/.openclaw 2>/dev/null
sudo -n rm -f /usr/local/bin/nemoclaw 2>/dev/null || true
sudo -n rm -rf /usr/local/lib/nemoclaw 2>/dev/null || true
for port in 8080 18789 9119; do fuser -k -n tcp $port 2>/dev/null || true; done
true
SCRIPT
)
```

Idempotent — fails silently when there's nothing to clean. Run via `brev exec "$INSTANCE_NAME" "$RESET"` before 8a's install and again before 8d's install.

**Sudo precondition.** All `sudo` invocations use `sudo -n` (non-interactive) so they fail fast instead of hanging on a password prompt. The skill assumes the Brev image's default user has passwordless sudo configured — Brev's stock images do; custom images may not. If `sudo -n` fails, the binary cleanup is best-effort and a stale `/usr/local/bin/nemoclaw` may persist. The user-local install path (`~/.nemoclaw`) is fully reset regardless.

### Step 8a: Install reported version

The installer accepts the target ref via the `NEMOCLAW_INSTALL_TAG` env var (verified against `install.sh` source — defaults to `latest` if unset). It is **not** a `--version` flag.

```bash
brev exec "$INSTANCE_NAME" "$RESET"

brev exec "$INSTANCE_NAME" "NEMOCLAW_INSTALL_TAG=$REPORTED_VERSION bash -c 'curl -fsSL $INSTALL_URL | bash'" \
  || BASELINE_INSTALL_FAILED=1
brev exec "$INSTANCE_NAME" "nemoclaw --version"
```

If install fails (old releases rot — installer URLs, deps, OS images all drift over time), set `BASELINE_INSTALL_FAILED=1` and **skip 8b/8c**, going straight to 8d. Note "baseline-install-skipped" in the final comment. Step 9's scoring rule handles the degraded mode.

### Step 8a.5: Bootstrap reproducer dependencies

Brev's stock CPU images ship with NemoClaw installable but not the broader ecosystem the reproducer may need — local model servers (Ollama, vLLM), inference providers, third-party CLIs. **Default to maximum faithfulness: install the actual dependency the reporter used rather than substituting a stub.** Substituting trades faithfulness for speed; that trade is rarely worth it on a 60-min budget, and it almost always introduces a confound that makes the verdict less trustworthy.

**When to bootstrap (not substitute):**

- The reproducer references a specific model/server runtime (`NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_PROVIDER=vllm`, etc.).
- The reproducer references a specific model name with a tag (`nemotron-3-nano:4b`, `llama3:8b`, etc.).
- The reporter's environment in the issue body shows a configured provider (e.g., `OpenShell CLI: 0.0.26` plus an Ollama running on host).

**When to substitute (with -30 penalty):**

- Provider requires an API key the skill cannot safely supply (NIM, OpenAI, Anthropic, etc.). Stubbing a key won't pass validation faithfully and a real key shouldn't sit in a verify-stale run. Apply the -30 penalty (treat as synth-repro per Step 8b) and document the substitution in the comment.
- The bug is *provably* independent of the dependency (e.g., a CLI argument-parsing bug that errors before any provider runs). Note this explicitly in the comment.

**Canonical bootstraps:**

```bash
# Ollama + a specific model.
# The Ollama installer registers a systemd service (`ollama.service`) so the
# daemon survives between brev exec calls.
brev exec "$INSTANCE_NAME" "curl -fsSL https://ollama.com/install.sh | sh"
brev exec "$INSTANCE_NAME" "sudo systemctl start ollama && sleep 3"
brev exec "$INSTANCE_NAME" "ollama pull <model>"
brev exec "$INSTANCE_NAME" "ollama list"   # confirm before continuing
```

```bash
# vLLM + a model (HuggingFace-hosted).
brev exec "$INSTANCE_NAME" "pip install --quiet vllm"
brev exec "$INSTANCE_NAME" "nohup python -m vllm.entrypoints.openai.api_server --model <model> --host 127.0.0.1 --port 8000 >/var/log/vllm.log 2>&1 &"
brev exec "$INSTANCE_NAME" "sleep 30 && curl -fsS http://127.0.0.1:8000/v1/models"
```

Bootstrap **once before Step 8b's baseline run** and reuse for Step 8d's latest run. Don't reset Ollama/vLLM state between baseline and latest in the comprehensive reset — model downloads are expensive and unrelated to the NemoClaw install. Adjust the reset script to skip these external services explicitly if needed.

**If bootstrap fails** (network issue pulling the model, service won't start, etc.), this is an infra failure — abort to Step 11. Do not silently substitute; the user opted into faithfulness for a reason.

---

### Step 8b: Run reproducer on baseline, compare to issue symptom

If `./reproducer.sh` exists (verbatim from Step 6), run it. Otherwise synth on demand from the issue body (apply −30 penalty now, locked in for the rest of the run).

**Interactive subcommand handling.** Many `nemoclaw onboard` / `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Auto-detect such subcommands in the script and apply, in order:

1. Add `--non-interactive` if the version supports it.
2. Add `--dangerously-skip-prompts` (issue #2168 confirmed this exists for at least some Jetson paths).
3. Pre-feed answers via stdin: `printf 'yes\n\n\n' | nemoclaw onboard ...`

If none work, route the script to Step 8c (synth-repro) so the LLM can rewrite it using non-interactive equivalents.

```bash
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./baseline-transcript.log
```

**Match rubric.** LLM compares `baseline-transcript.log` to the issue's "Actual result" / error description. Match criteria, in order:

1. **Exit code agrees** with what the issue describes (non-zero if issue describes a failure, zero if issue describes a wrong-output bug). Necessary but not sufficient.
2. **Symptom phrase match:** transcript contains a key error phrase from the issue (e.g., issue says `Permission denied on generate-openclaw-config.py`, transcript says `EACCES: permission denied, open '...generate-openclaw-config.py'` — semantic equivalence counts).
3. **Distinguish bug from infra noise:** generic network / DNS / auth errors don't count as a match unless the issue itself describes them. A bug about config parsing that fails at "could not resolve nvidia.com" is an infra failure, not a reproduction.

**Fallback for issues without an explicit "Actual result" section.** Many bug reports describe a *behavioral* problem rather than a runtime error — e.g., "should default to a stable released version" (#1242), "configuration is not persisted across rebuilds" (#3030). These have no comparable error string. In that case:

1. Use the issue's **full title + description** as the symptom signal.
2. Match if the reproducer's outcome **contradicts the issue's stated expected behavior** (or matches the stated wrong behavior). E.g., issue says "expected: stable release; actual: nightly", reproducer prints `nightly-build-2026.04.x` → that's a match.
3. If neither error string nor expected-behavior contradiction can be identified, route the script to Step 8c (synth-repro) — let the LLM produce a more diagnostic script that emits something testable.

- **Match** → reproducer validated. Proceed to 8d.
- **No match** (silent pass, wrong error, infra noise, or no testable outcome): script has gaps. Proceed to 8c.

### Step 8c: Synth-repro and retry on baseline

LLM rewrites `./reproducer.sh` using the full issue context (description, environment, symptoms) **plus the baseline transcript** so it can react to what actually happened. Apply **−30 confidence penalty** (or keep it if 8b already applied it for the missing-verbatim case).

```bash
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./baseline-transcript-2.log
```

- **Match:** validated (with −30 baked in). Proceed to 8d.
- **Still no match:** mark `verify-inconclusive`. Post a comment that includes both reproducer attempts and both baseline transcripts with the message "couldn't establish a working reproducer for this bug on `$REPORTED_VERSION`." **Skip 8d** — there's nothing to verify on latest.

### Step 8d: Install latest, run validated reproducer

```bash
brev exec "$INSTANCE_NAME" "$RESET"
brev exec "$INSTANCE_NAME" "curl -fsSL $INSTALL_URL | bash"
brev exec "$INSTANCE_NAME" "nemoclaw --version"

brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" "bash ~/reproducer.sh" 2>&1 | tee ./latest-transcript.log
```

If the install of **latest** fails (e.g. installer regression — see #3058 for a current example), this is an infra failure — see Step 11. Do not score or label the issue.

If install succeeds, `latest-transcript.log` is the input to Step 9 scoring.

For interactive debugging when something looks off:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 8.5: Detect "Behavior Changed by Design"

Before scoring, check whether the symptom is intentional. Some bugs are filed against behavior that was **deliberately changed or removed** in a merged PR — running the standard rubric on these produces misleading verdicts. The symptom "still reproduces" but the right answer is "won't fix, see PR #X." Issue #2791 is the prototype: `config set` was removed in PR #2227, the reporter tested a version that already had it gone, and a standard rubric run would have buried that context under a low-confidence `verify-inconclusive` label.

This step is split into substeps so the rigor is mechanical, not optional. Every claim in the final comment must be backed by a verifiable evidence block — a comment URL with quoted phrase, a commit SHA with diff range, or a grep command with its actual output. Hand-wavy claims fail Step 8.5d's self-verification pass and force a bail to `verify-inconclusive`.

### Step 8.5a: Run signal detection

Any single signal is sufficient to trigger the by-design branch.

**Signal 1 — Maintainer attribution in comments.** Any comment by an author with `authorAssociation` of `MEMBER`, `OWNER`, or `COLLABORATOR` matches `removed in #\d+`, `removed in [Pp][Rr] ?#\d+`, `by design`, `wontfix`, `won't fix`, `not a bug`, or `intentional`.

```bash
gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq '.comments[]
        | select(.authorAssociation == "MEMBER" or .authorAssociation == "OWNER" or .authorAssociation == "COLLABORATOR")
        | select(.body | test("removed in #\\d+|by design|wontfix|won.t fix|not a bug|intentional"; "i"))
        | {url, author: .author.login, body}'
```

Capture for evidence: comment URL + author login + the exact quoted phrase.

**Signal 2 — Removal commit in range.** A commit between the reported version and `$LATEST` deletes the symbol implicated by the reproducer (CLI subcommand, function, flag). The commit subject does NOT need to mention "remove" / "delete" — many removals ride into a `refactor(...)` or `feat(...)` commit (e.g. PR #2227 removed `--dangerously-skip-permissions` under a `refactor(sandbox): ...` subject). Use git's pickaxe to find the responsible commit by content:

```bash
# Pickaxe: list every commit whose diff changes the count of <symbol> occurrences.
# Reverse order so the earliest removal commit lands first in the list.
git log "$REPORTED_VERSION".."$LATEST" -S'<symbol>' --reverse --oneline -- src/ bin/ nemoclaw/src/

# Subject-keyword narrowing is only a SUPPLEMENTARY lookup — useful when the
# pickaxe returns many commits and you want to focus on the obviously-removal one.
git log "$REPORTED_VERSION".."$LATEST" --grep='remove\|delete\|drop\|deprecate' -i --oneline

# For each candidate, confirm the diff actually deletes the symbol (not just renames or moves it).
git log -p <candidate-sha> -- src/ bin/ nemoclaw/src/ | grep -nE '^-.*\b<symbol>\b'
```

Capture for evidence: commit SHA + each `file:line` block of deletions touching the symbol. Note the commit's actual subject — don't assume it says "remove."

**Signal 3 — Symbol absent in both reported version and latest.** The implicated symbol (e.g. `config set`) is not present in either tag's source tree — meaning the responsible change landed before the version the reporter tested. This is the #2791 case.

```bash
git grep -n "<symbol>" "$REPORTED_VERSION" -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only — see sub-case)
git grep -n "<symbol>" "$LATEST"            -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only)
```

Capture for evidence: both grep commands and their (empty) outputs.

**Sub-case for signals 2 and 3 — vestigial deprecation shims.** It's common for a removed symbol to survive in latest *only* as a deprecation message (e.g., a CLI subcommand that prints `"--<flag> was removed; use <X> instead"` and exits non-zero). When a grep returns matches in latest, inspect each `file:line`. If every match is a deprecation stub with no functional effect on the bug-as-filed, signal 2 or 3 still fires; record the shim locations and behavior as a separate evidence block. Do not silently treat shims as functional code, and do not silently treat them as absence.

### Step 8.5b: Pre-check related failure modes

A by-design verdict says "the bug *as filed* can't reproduce." It does NOT say "every bug shaped like this is fixed." Before drafting the comment, search latest's source for code paths that could still produce the issue's described **symptom** (not the literal removed flag/symbol — the symptom).

```bash
# Use the issue's symptom keywords, not the removed symbol.
git grep -nE "<symptom-keyword-1>|<symptom-keyword-2>" "$LATEST" -- src/ nemoclaw/src/
```

For #2168 the literal flag is `--dangerously-skip-permissions`, but the symptom is "sandbox created but not registered in CLI." Grepping for `register.*[Ss]andbox`, the readiness-gate / cleanup-failure path in `src/lib/onboard.ts` surfaces as a related-but-different way to produce an orphan sandbox.

If a related failure mode is found, the by-design comment MUST include a "What's not literally the same bug" section that names it with `file:line`. Don't suppress the call-out by claiming "the symptom is impossible" when the symptom can be reached via a different path.

### Step 8.5c: Check existing test coverage

Search the repo for tests that exercise the NEW intended workflow (the one that replaced the removed symbol). Citing them strengthens the comment from "trust me, it was removed" to "the new workflow is exercised by these tests."

```bash
git grep -lnE "<new-workflow-keyword>" -- test/ nemoclaw/src/ 2>/dev/null | head -5
```

Cite at most three concrete test paths. If none exist, omit the section — do not invent paths.

### Step 8.5d: Self-verification pass before posting

Two passes, both required.

**Evidence pass.** Re-run every grep / git / `gh` command cited in the evidence blocks. If any cited `file:line`, commit SHA, or quoted output doesn't reproduce on a fresh invocation, **stop and revise** — or bail to `verify-inconclusive` if the discrepancy can't be resolved.

**Link pass.** Resolve at least one rendered markdown link from each section that has them — `What's structurally fixed`, `Vestigial references`, `Existing CI coverage`. Use `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` (returns 200 + base64 content if the path exists at the tag, 404 otherwise) or `curl -fsI <blob-url>` (returns 200 if the blob renders). A broken link is worse than no link — it suggests verification work that didn't actually happen.

The cost of an incorrect "I checked and X is gone" claim in a public comment, or a 404 on a citation, is higher than spending a minute re-checking. This step exists because LLMs can confidently overstate and confidently invent paths; mechanical re-verification catches both.

### Step 8.5e: If any signal fires

- **Skip the Step 9 score table** entirely. The "exit 0 + expected output" axis doesn't apply when the expected output is no longer the contract.
- **Skip Brev provisioning** if the signal fires before Step 7 — a remote run would just confirm what static analysis already proved. (Signals 2 and 3 can run as soon as the reported version is parsed in Step 4.)
- **Apply label `status: wont-fix`** (the existing repo label — quote it on the CLI: `gh issue edit <num> --add-label "status: wont-fix"`). It's already in the Step 3 issue-type skip list, so a labelled issue is automatically excluded from future runs without needing a separate idempotency clause.
- **Use the by-design comment template below** instead of the standard Step 10 template.
- **@-mention the reporter** so they can object if the framing is wrong.
- **Never auto-close.** A maintainer pulls the trigger, same as the other label paths.

### By-design comment template

Mandatory sections in this order. Omit only the sections explicitly noted as omittable.

**Tag-anchoring + linking rule.** Every `file:line` citation, commit SHA, and test-path reference in the rendered comment MUST be a clickable markdown link to the verified-on tag (e.g., `v0.0.35`), not the maintainer's working `HEAD`. Lines drift between tags and main; tag-anchored links keep the citations reproducible by anyone reading the comment months later. Bare paths force the reader to navigate manually — that's a usability bug, not a stylistic preference.

Use these exact link formats:

- File only: `[src/lib/onboard.ts](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts)`
- File:line: `[src/lib/onboard.ts:4965](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts#L4965)`
- File:line-range: `[src/lib/commands/sandbox/connect.ts:25-31](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/commands/sandbox/connect.ts#L25-L31)`
- Commit SHA: `[5956a61](https://github.com/NVIDIA/NemoClaw/commit/5956a612e18047b9ab85b3a7e89f6b5dedb29190)` — short SHA as the link text, full SHA in the URL
- Test file: `[test/e2e/test-double-onboard.sh](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/test/e2e/test-double-onboard.sh)`
- PR/issue references: bare `#NNNN` works — GitHub auto-links these in comments on the same repo, no manual URL needed.

When greping for evidence, use `git grep -n "<symbol>" "$LATEST" -- ...` so the line numbers match the tagged blob. Then construct each link from `<file path> + verified-on tag + line number`.

The Step 8.5d self-verification pass MUST resolve at least one rendered link (e.g., `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=v0.0.35` or a `curl -fsI` to the blob URL) and confirm it returns the expected file. A broken link defeats the purpose of including the citation. If any link fails to resolve, fix it or bail to `verify-inconclusive`.

````markdown
## Stale-issue verification — behavior is by-design

**Reported on:** v0.0.<X>
**Verified on:** v0.0.<Y> (PR #<NNNN> first shipped in v0.0.<Z>)
**Verification mode:** static analysis at the verified-on tag — no runtime reproduction. Step 8.5 by-design short-circuits Brev provisioning because the responsible code change is already proven by the diff between `$REPORTED_VERSION` and `$LATEST`.
**Outcome:** symptom reproduces against the reproducer as filed, but the implicated behavior was intentionally changed.

### What's structurally fixed

- `<file:line>` — `<one-sentence summary of the change at that location>`
- `<file:line>` — `<…>`

The new workflow is `<one-sentence: how to do what the user was trying to do>`.

### Vestigial references

- `<file:line>` — `<deprecation behavior: e.g. "prints '--<flag> was removed; use <X> instead' and exits 1; no functional effect">`

(Omit this section entirely when the symbol is fully gone with no surviving stubs.)

### What's not literally the same bug

`<one-sentence acknowledgement of the related failure mode found in Step 8.5b, with file:line>` — OR — `None. The symptom requires the removed symbol; no related code path produces it on latest.`

### Existing CI coverage

- `<test/path/file>` — `<one-sentence: what this test demonstrates about the new workflow>`

(Omit when no direct test exists. Do not invent paths.)

### Recommendation

@<reporter> — please confirm the by-design framing is correct (the implicated `<symbol>` was intentionally removed, the original reproducer can no longer execute) and close as "won't fix / by design" if you agree. If a related symptom (e.g. `<related failure mode from above>`) is hitting you on ≥ v0.0.<Z>, please file a fresh issue with a v0.0.<Z>+ reproducer.

`<NVBugs cross-ref line — see below>`

<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->
````

**NVBugs cross-ref line.** If `NVBUGS_REF` was set in Step 4, append:

> NVBugs<NVBUGS_REF without brackets> will need a separate update; closing this GitHub issue won't propagate.

Otherwise omit the sentence.

**If no signal fires:** continue to Step 9 normally.

---

## Step 9: Score Confidence

Start at 0. Apply each rule that fires.

| Signal | Delta |
|---|---|
| Reproducer ran cleanly on **latest** (8d), exit 0, no bug symptom observed | +50 |
| Commits between reported version and `$LATEST` touch the implicated component (see "Path extraction" below) | +25 |
| A merged PR mentions this issue number or its symptom (see "PR search" below) | +25 |
| Reproducer was LLM-synthesized at any point (Step 8b synth or Step 8c retry) | −30 |
| Any partial error, warning, or flaky behavior in the latest run (8d) | −50 |

Total is clamped to `[0, 100]`.

### Path extraction (for the +25 commits signal)

The skill needs to know *which* path to `git log v<reported>..$LATEST -- <path>` against. Apply in order, stop at the first that yields a non-empty path:

1. **Stack trace / file path mentions in the issue body.** Grep the body for absolute paths under known install roots, then map to repo paths:
   - `/usr/local/lib/nemoclaw/<rel>` → `<rel>` in repo (e.g., `scripts/generate-openclaw-config.py`)
   - `/usr/local/bin/nemoclaw*` → `bin/`
   - `~/.nemoclaw/<rel>` → most often runtime state, drop unless the bug is config-related → `src/lib/config/`
   - In-repo paths (e.g., `bin/lib/policies.js` mentioned literally) → use as-is
2. **Component-label-to-directory map.** Pick the first match. Paths verified against the current repo layout — drop any path that doesn't exist on the tag at `$LATEST` rather than passing it to `git log`.
   - `NemoClaw CLI` → `bin/`, `src/lib/`, `nemoclaw/src/commands/`
   - `Sandbox` → `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`
   - `OpenShell` → cross-repo (lives at `github.com/NVIDIA/OpenShell`, not in this repo). Skip the +25 signal for OpenShell-only issues; cross-repo `git log` is out of v1 scope.
   - `Docker` → `Dockerfile`, `Dockerfile.base`, `scripts/install-openshell.sh`, `scripts/install.sh`
   - `Getting Started` → `docs/`, `scripts/install.sh`
   - `Integration: <X>` — no `src/lib/integrations/` exists in this repo. Skip the +25 signal for integration-component issues unless source 1 (file paths in body) yielded a path.
3. **Title keywords.** "policy" → `nemoclaw-blueprint/policies/`, `nemoclaw/src/blueprint/`. "inference" → `docs/inference/` is docs-only; skip the +25 signal unless source 1 surfaces actual code paths.

If none of the above produces a path, **skip the +25 signal entirely** rather than guessing. Floating the +25 on every issue would inflate scores meaninglessly.

### PR search (for the +25 PR signal)

```bash
# Direct issue-number reference (covers most cases — "fixes #2861" etc.)
DIRECT_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
  --search "$ISSUE_NUMBER" \
  --json number,title,mergedAt,body \
  -q "[.[] | select((.body + \" \" + .title) | test(\"#$ISSUE_NUMBER\\\\b\"))]")

# Symptom-phrase fallback (only if direct reference returns nothing)
if [ -z "$DIRECT_REF" ] || [ "$DIRECT_REF" = "[]" ]; then
  SYMPTOM=$(extract first key error/symptom phrase from issue body, ~3-6 words)
  SYMPTOM_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
    --search "\"$SYMPTOM\"" \
    --json number,title,mergedAt)
fi
```

Apply +25 if either query returns at least one PR with `mergedAt` strictly after the tag date of `$REPORTED_VERSION` (look up via `git log -1 --format=%cI v$REPORTED_VERSION`). PRs merged before the reporter even filed the issue can't have fixed it.

If neither query returns anything, **skip the +25 signal**.

**Baseline-validation gating.** The +50 weight assumes the reproducer was *validated* — i.e., it produced the bug symptom on baseline (Step 8b/8c match). If `BASELINE_INSTALL_FAILED=1` (Step 8a fall-through, baseline pass skipped), the +50 still applies but **cap the total at 84** unless commits-touched-area or merged-PR-mention also fires. Without baseline AND without corroborating evidence, the cleanest landing is the 60–84 band where the reporter is asked to confirm — we don't have enough on our own to claim ≥85.

**Action (when latest run was clean — bug not reproduced):**

| Score | Label | Comment |
|---|---|---|
| ≥85 | `fixed-on-latest` | Evidence-rich, no @-mention. |
| 60–84 | `fixed-on-latest` | Evidence-rich, **@-mention the original reporter** to confirm. |
| <60 | `verify-inconclusive` | Short, honest "couldn't verify" explanation. |

**Special case: latest output matches the issue symptom (bug still reproduces on latest).**

This is not a flake — the skill positively confirmed the bug is still live. Don't apply the +50 weight (the bug isn't fixed) and skip the score table entirely.

- Post a "still reproduces on latest" comment with both transcripts.
- Apply **no label**.
- Include the marker `<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->` with today's date so the candidate filter applies the 7-day TTL (Step 3 idempotency).
- Next weekly run picks the issue back up after the TTL — if the bug gets fixed in the meantime, that run catches it.

The skill **never closes issues** in any branch. A maintainer pulls that trigger after reviewing the label and comment.

---

## Step 10: Compose and Post the Comment

**Redaction pass before posting.** Run on **every** chunk of text quoted in the comment — issue body excerpts, baseline transcript, latest transcript, synth-repro scripts. Replace each match with `[REDACTED]`. The transcripts especially leak — they include full stdout/stderr from real installs and runs.

**HTML → text pre-pass for issue body excerpts.** NV QA bodies are HTML; tokens nested in `<pre>` tags or HTML attributes (e.g. `<a href="https://user:tok@host/...">`) slip past the regex patterns below if the input still has tags. Convert to plain text first, then redact:

```bash
TEXT=$(printf '%s' "$BODY_EXCERPT" | python3 -c '
import html, re, sys
b = sys.stdin.read()
b = re.sub(r"<br\s*/?>", "\n", b)
b = re.sub(r"</?(p|div|tr|td|th|li|pre)[^>]*>", "\n", b)
b = re.sub(r"<[^>]+>", "", b)
print(html.unescape(b))
')
# Now apply the regex table below to $TEXT.
```

Transcripts and synth-repro scripts are already plain text and skip the pre-pass.

**Order matters and the table below is in execution order.** Longest, most-specific patterns first; generic catchalls last. Otherwise the catchall masks specific matches and you lose track of what was actually redacted (JWT vs session blob vs random base64).

| # | Pattern | Targets |
|---|---|---|
| 1 | `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` | JWT tokens |
| 2 | `gh[pousr]_[A-Za-z0-9]{36,}` | GitHub PATs / install tokens |
| 3 | `(?i)nvapi-[A-Za-z0-9_-]{20,}` | NVIDIA API keys (NIM / build.nvidia.com) |
| 4 | `AKIA[0-9A-Z]{16}` | AWS access key IDs |
| 5 | `(?i)aws_secret_access_key\s*=\s*\S+` | AWS secret keys |
| 6 | `(?i)authorization:\s*\S+` | HTTP auth headers (often Bearer + JWT) |
| 7 | URLs containing `@` before the host (e.g., `https://user:pw@host/...`) | Basic-auth credentials in URLs |
| 8 | `(?i)(token\|secret\|password\|api[_-]?key\|bearer)[^\n]*[:=][^\n]*` | Inline credentials in env/config/log output |
| 9 | `\b\w+\.(nvidia\.internal\|nv-internal\.com\|nvidia\.dev)\b` | Internal hostnames (extend list per team) |
| 10 | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | Email addresses (PII) |
| 11 | `\b[A-Za-z0-9+/]{60,}={0,2}\b` | Long base64 blobs (likely keys/sessions; tune length to taste — too short hits legit data) |

**File paths under the reporter's home directory** (`/Users/<name>/`, `/home/<name>/`) → replace with `~/`. Run last; catches incidental username PII.

**Length target.** Default rendered comment to **400–500 words**. The evidence table (or by-design "What's structurally fixed" + "Vestigial references" sections) is the hero. Strip architectural prose "for QA reference," PR-attribution caveats beyond one sentence, and closing reopen-instructions boilerplate. If a comment runs past 500 words, cut everything that doesn't directly support the verdict — every section needs to either change a reader's mind about the verdict or be deleted.

**Mandatory closing block — reporter @-mention with confirmation language.** Every template below ends with an explicit @-mention of the original reporter using this exact shape:

> @\<reporter\> — please confirm the symptom is gone on a recent build (≥ v0.0.\<Z\>) and reopen with a fresh reproducer if you observe otherwise.

The skill cannot independently confirm a closed-as-fixed verdict — only the reporter knows whether their original symptom is gone in their environment. The @-mention is what converts a "skill says it's fixed" claim into actionable confirmation work for QA. Customize `<Z>` per case (the version that shipped the fix or `$LATEST`), but never omit the line.

**Comment template (fixed / inconclusive — bug not reproduced on latest):**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04 / <CUDA version if GPU>

### Baseline (reported version)

- Install: succeeded · skipped (install rotted)
- Reproducer: extracted verbatim · synthesized (−30 penalty)
- Result: bug symptom matched (validated) · could not validate (skipped Step 8c gate)

<details><summary>Baseline transcript</summary>

```text
<full baseline transcript>
```

</details>

### Latest

- Install: succeeded
- Result: not reproducible — clean run, no bug symptom observed

<details><summary>Latest transcript</summary>

```text
<full latest transcript>
```

</details>

### Verdict

**Confidence:** 88 / 100. Labelling `fixed-on-latest`.

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <commit subject>
- def5678 — refactor: <commit subject>

</details>

@<reporter> — please confirm the symptom is gone on a recent build (≥ v0.0.<Z>) and reopen with a fresh reproducer if you observe otherwise.

<!-- nemoclaw-verify-stale v1 2026-05-12 -->
````

**Comment template (still reproduces — Step 9 special case):**

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04

The skill ran the reported reproducer on v0.0.34 and observed the same bug symptom described in this issue. The bug is still live.

No label applied. Will re-verify automatically next weekly run; if a fix lands in the interim, the next pass catches it.

@<reporter> — please confirm the symptom still matches your observation on v0.0.<Y> and reopen with any updated reproducer or environment details if it has shifted.

<details><summary>Baseline transcript (validated reproducer)</summary>

```text
<baseline transcript>
```

</details>

<details><summary>Latest transcript (bug still observed)</summary>

```text
<latest transcript>
```

</details>

<!-- nemoclaw-verify-stale v1 2026-05-12 -->
````

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Always include today's date in `YYYY-MM-DD` format so the candidate filter can apply the 7-day TTL.

**Post the comment and apply the label:**

```bash
gh issue comment "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --body-file comment.md
gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "fixed-on-latest"
# or for <60:
# gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "verify-inconclusive"
```

---

## Step 11: Infra Failure Handling

Two different failure types, two different responses.

**Latest-install failure** (Step 8d) or reuse-check / provisioning / harness errors: hard infra failure.

- Print the error.
- Apply **no label** — infra failures must not pollute the verification record.
- Post a short comment **only if explicitly requested by the invoking user**. Default is silent move-on.
- Continue to the next candidate in batch mode.

The next weekly run retries naturally.

**Baseline-install failure** (Step 8a, reported version won't install on a modern image): not a hard failure — degraded mode.

- Set `BASELINE_INSTALL_FAILED=1`, skip 8b/8c, jump to 8d.
- Step 9 applies the score cap (max 84) unless corroborating evidence fires.
- Note "baseline-install-skipped" in the final comment so a reviewer knows the verification ran without the script-validation gate.

This degradation is expected — old releases rot. We still want to extract whatever signal we can from the latest run plus PR/commit evidence, just at a more conservative confidence ceiling.

**Keep-box-on-inconclusive.** When `verify-inconclusive` lands (Step 8c gave up, or Step 9 score < 60), **skip the cleanup trap** for this run if the box was provisioned by this run — set `PROVISIONED_NEW=0` before the trap fires so the EXIT handler is a no-op. Print the `brev shell "$INSTANCE_NAME"` command and an explicit `brev delete "$INSTANCE_NAME"` reminder in the run output so the maintainer can triage and clean up manually. Reused boxes stay regardless. Ship-failed verifications are the exact case where having an inspectable artifact pays for itself; an unbounded sleep-and-delete in the background isn't reliable across session ends, so we leave deletion explicit.

---

## Step 12: Log to Activity

After each issue (verified, inconclusive, by-design, or infra-failed), append to `${VERIFY_STALE_LOG_DIR:-$HOME/development/daily-rhythm/activity}/nemoclaw-verify-stale-log.md`. The default path matches the personal-organizer convention; export `VERIFY_STALE_LOG_DIR` to point elsewhere (CI, shared volume, etc.). Create the directory if missing — do not assume it exists.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Environment:** CPU | GPU (<instance type>)
**Box:** reused <name> | provisioned <name> | local (no Brev — Step 6.7 short-circuit)
**Baseline install:** succeeded | failed (degraded mode)
**Baseline match:** validated (verbatim) | validated (synth) | failed (verify-inconclusive) | skipped
**Latest install:** succeeded | failed (infra error)
**Latest result:** not-reproduced (clean) | still-reproduces | partial / flake | n/a (skipped 8d)
**Confidence:** 88 / 100 | n/a (still-reproduces)
**Label applied:** fixed-on-latest | verify-inconclusive | status: wont-fix | none (still-reproduces) | none (infra)
**Brev wall time (approx):** N min

---
```

Create the file if missing, with this header:

```markdown
# NemoClaw — Verify Stale Log

A running record of stale-issue verification runs on NVIDIA/NemoClaw.
Persisted via daily-rhythm to GitLab.

---
```

At end of a batch session, prepend a session summary:

```markdown
## YYYY-MM-DD — Verify Session
**Issues considered:** N
**Verified `fixed-on-latest`:** N
**Marked `status: wont-fix` (by-design path):** N
**Marked `verify-inconclusive`:** N
**Local-first short-circuits (no Brev cost):** N
**Skipped (Windows / macOS / integration / no version):** N
**Infra failures:** N
**Brev wall time:** N min · approx $X.XX

---
```

Never stage or commit the log to the NemoClaw repo.

---

## Cadence

- **Weekly cron** — Monday morning, batch mode, ≤20 issues.
- **Manual** — invoke with a single issue number anytime.

---

## Out of Scope (v1)

- Auto-closing issues. Always tag-only; a human pulls the trigger.
- macOS verification *via the Brev path*. Brev offers no macOS instances. The Step 6.7 local-first short-circuit *does* run on a maintainer's macOS laptop — so manual single-issue runs against pure-CLI bugs work on macOS. The weekly batch cron is Linux-only because that path always uses Brev.
- Issues requiring third-party integration credentials (Slack, Discord, Telegram, Hermes, OpenClaw, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Versioned labels. A single `fixed-on-latest` label is swept on each release cut.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` sweeps `fixed-on-latest` and `verify-inconclusive` from all open issues at release time. Without that sweep, "latest" drifts and verifications go stale silently. The by-design path uses the existing repo `status: wont-fix` label; that label is **not** swept (it's also applied for non-skill reasons such as scope or priority decisions, and clearing it would erase human triage work).

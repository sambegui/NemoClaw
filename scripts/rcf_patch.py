"""
Patch replaceConfigFile in OpenClaw dist to wrap the
tryWriteSingleTopLevelIncludeMutation/writeConfigFile block in a try/catch
that suppresses EACCES when running inside an OpenShell sandbox.

Uses a broad regex anchored on function-call names, not whitespace or object
property ordering, so minor formatting changes across OpenClaw versions don't
cause false misses (#2689). The match is scoped to the replaceConfigFile
function body to avoid patching unrelated blocks.

The patch is gated against a single constant (LAST_OPENCLAW_NEEDING_RCF_PATCH):
- If the installed OpenClaw version is above the sentinel, the patch is skipped
  entirely on the assumption that the upstream fix has landed (OpenClaw #72950).
- If the version is at or below the sentinel and the regex fails to match, the
  script soft-warns and exits 0 instead of failing the image build. Plugin code
  still loads via auto-discovery from extensions/; only plugin metadata
  persistence surfaces raw EACCES at runtime. The maintainer bumps the sentinel
  down when the upstream fix becomes available. See NemoClaw #2686 and #3497.
"""
import os
import re
import sys

# Bump this DOWN (not up) to the last OpenClaw version that still needs the
# rcf_patch when the upstream fix in openclaw/openclaw#72950 lands. Until then,
# the sentinel ensures every OpenClaw version still tries the patch.
LAST_OPENCLAW_NEEDING_RCF_PATCH = "9999.99.99"


def parse_version(value):
    if not value:
        return None
    try:
        return tuple(int(part) for part in value.strip().split("."))
    except ValueError:
        return None


p = sys.argv[1]

current = parse_version(os.environ.get("OPENCLAW_VERSION"))
ceiling = parse_version(LAST_OPENCLAW_NEEDING_RCF_PATCH)
if current is not None and ceiling is not None and current > ceiling:
    print(
        f"[nemoclaw] rcf_patch: OpenClaw {os.environ['OPENCLAW_VERSION']} is past the last "
        f"known-broken version ({LAST_OPENCLAW_NEEDING_RCF_PATCH}); skipping patch. "
        "Bump LAST_OPENCLAW_NEEDING_RCF_PATCH back up if this version still needs it."
    )
    sys.exit(0)

src = open(p).read()


def skip_quoted(text, i, quote):
    i += 1
    while i < len(text):
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == quote:
            return i + 1
        i += 1
    raise AssertionError("unterminated string while scanning replaceConfigFile")


def find_matching_brace(text, open_idx):
    depth = 0
    i = open_idx
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""

        if ch in ("'", '"', "`"):
            i = skip_quoted(text, i, ch)
            continue
        if ch == "/" and nxt == "/":
            newline = text.find("\n", i + 2)
            i = len(text) if newline == -1 else newline + 1
            continue
        if ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            assert end != -1, "unterminated block comment while scanning replaceConfigFile"
            i = end + 2
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
            assert depth > 0, "replaceConfigFile function body closed before it opened"
        i += 1

    raise AssertionError("replaceConfigFile function body not terminated")


def soft_skip(reason):
    print(
        f"[nemoclaw] rcf_patch: {reason}; skipping patch. "
        "Plugin metadata persistence will surface raw EACCES in the sandbox, "
        "but plugins still load via auto-discovery from extensions/. "
        "See openclaw/openclaw#72950 for the upstream fix and update "
        "LAST_OPENCLAW_NEEDING_RCF_PATCH once it lands.",
        file=sys.stderr,
    )
    sys.exit(0)


# Scope the search to the replaceConfigFile function body.
fn_start = src.find("async function replaceConfigFile(")
if fn_start == -1:
    soft_skip(f"replaceConfigFile function not found in {p}")
fn_body_start = src.index("{", fn_start)
fn_body_end = find_matching_brace(src, fn_body_start)
fn_src = src[fn_body_start : fn_body_end + 1]

# Match the tryWriteSingleTopLevelIncludeMutation / writeConfigFile block.
# - Tolerates any whitespace around !, await, (, {, }, commas, ;
# - Allows snapshot / nextConfig properties in either order
# - Allows optional semicolon at end
# - Uses DOTALL so \s matches newlines
pat = re.compile(
    r"(?P<pre>[ \t]*)if\s*\(\s*!\s*await\s+tryWriteSingleTopLevelIncludeMutation\s*\("
    r"\s*\{(?=[^}]*\bsnapshot\b)(?=[^}]*\bnextConfig\s*:\s*params\.nextConfig\b)[^}]*?\}\s*\)\s*\)"
    r"\s*await\s+writeConfigFile\s*\(\s*params\.nextConfig\s*,\s*\{[^}]*?\}\s*\)\s*;?",
    re.DOTALL,
)
m = pat.search(fn_src)
if not m:
    soft_skip(f"tryWriteSingleTopLevelIncludeMutation/writeConfigFile pattern not found in {p}")

indent = m.group("pre")
replacement = (
    indent + "try { if (!await tryWriteSingleTopLevelIncludeMutation({\n"
    + indent + "\tsnapshot,\n"
    + indent + "\tnextConfig: params.nextConfig\n"
    + indent + "})) await writeConfigFile(params.nextConfig, {\n"
    + indent + "\tbaseSnapshot: snapshot,\n"
    + indent + "\t...writeOptions,\n"
    + indent + "\t...params.writeOptions\n"
    + indent + '}); } catch(_rcfErr) { if (process.env.OPENSHELL_SANDBOX === "1" && _rcfErr.code === "EACCES") {'
    + ' console.error("[nemoclaw] Config is read-only in sandbox \\u2014 plugin metadata not persisted (plugins auto-load from extensions/)"); }'
    + " else { throw _rcfErr; } }"
)

# Reconstruct: everything before the fn body match, patched fn body, rest.
fn_offset = fn_body_start
patched_fn = fn_src[: m.start()] + replacement + fn_src[m.end() :]
out = src[:fn_offset] + patched_fn + src[fn_body_end + 1:]
open(p, "w").write(out)
print(f"[nemoclaw] rcf_patch applied to {p}")

# Multi-model test plan — find-already-fixed

## Models in scope

| Model | What we're checking |
|---|---|
| Claude Haiku 4.5 | Does the skill provide enough guidance for the smaller model to follow the 4-signal scoring without drifting? |
| Claude Sonnet 4.6 | Is the SKILL.md efficient — no wasted tokens — while still leading to correct verdicts? |
| Claude Opus 4.7 (1M) | Does the skill avoid over-explaining and trust Opus to do the heavy reasoning? |

## Pass criteria per eval

Run each of the 3 scenarios in `evals/` against each model. For each (model, eval) pair, pass means:

- The model selects this skill (description discovery works)
- The model produces a JSON sidecar matching the documented envelope schema
- For Signal 0 evals: the model uses `gh api graphql` (not the gh CLI shorthand), correctly filters by `merged: true`, and reports confidence 0.7+ when fired
- For Signal 2c evals: the model identifies issue age >90d and applies the +0.2 bonus only when Signal 2b fires but Signal 3 doesn't
- The model NEVER closes an issue directly; output is draft-only

## Known model-size risks

- Haiku may over-fire on Signal 1 (label-only) without cross-checking other signals. If observed, tighten the SKILL.md guidance to require ≥2 signals fire OR Signal 0 alone (currently documented).
- Sonnet may correctly identify candidates but skip writing the calibration log entry. If observed, hoist the "append to /tmp/find-already-fixed-calibration.jsonl" line earlier in the workflow section.
- Opus may over-explain in the surfaced candidate evidence packets. If observed, prune the "Per-candidate evidence packet" example in SKILL.md.

## How to run

```bash
# Per the docs, evals are user-supplied infrastructure; this is the suggested runner shape.
for model in claude-haiku-4-5 claude-sonnet-4-6 claude-opus-4-7; do
  for eval in .agents/skills/nemoclaw-maintainer-find-already-fixed/evals/*.json; do
    # Invoke Claude with the skill loaded + the eval's query;
    # compare the result against expected_behavior.
    echo "Running $eval against $model"
  done
done
```

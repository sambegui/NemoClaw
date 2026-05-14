# Multi-model test plan — scope-issues

## Models in scope

| Model | Check |
|---|---|
| Claude Haiku 4.5 | Are the classifier definitions explicit enough that Haiku doesn't conflate categories? |
| Claude Sonnet 4.6 | Does Sonnet correctly cap WONTFIX_BY_DESIGN confidence at 0.7 and require user confirm? |
| Claude Opus 4.7 (1M) | Does Opus avoid drifting into philosophical scope arguments instead of running the classifier? |

## Pass criteria per eval

For each (model, eval) pair, pass means:

- The model builds the scope model from the documented sources (CLAUDE.md, docs/, nemoclaw-blueprint/, user skills)
- Classifies into the correct category with category-specific signals
- For DUPLICATE: links to a real canonical issue with Jaccard ≥0.7
- For STALE_NO_REPRO: emits draft as a *revival* comment with `--revival-only`, NEVER a close
- For OUT_OF_SCOPE / WONTFIX_BY_DESIGN: sets `requires_user_confirm: true`
- JSON sidecar matches the documented envelope; chains into close-superseded-issues

## Known model-size risks

- Haiku may misclassify a true OUT_OF_SCOPE as UPSTREAMED if the issue body mentions any upstream name. Tighten Signal U1 wording to require explicit phrasings like `bug in OpenClaw` or a stack trace.
- Sonnet may correctly classify but skip the reporter-history check. Hoist the check earlier or make it Stage 1.5 instead of inside Step 4d.
- Opus may produce overly verbose draft comments. Cap the template length or pre-render a token budget.

## How to run

Same runner shape as find-already-fixed; iterate over evals/*.json per model.

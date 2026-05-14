# Multi-model test plan — pr-rebase-assist

## Models in scope

| Model | Check |
|---|---|
| Claude Haiku 4.5 | Does Haiku enforce ALL 4 prerequisites (clean tree, not in worktree, fork-access, identity check)? |
| Claude Sonnet 4.6 | Does Sonnet recommend the right resolution per conflict shape? |
| Claude Opus 4.7 (1M) | Does Opus correctly use --force-with-lease and abort on stale-info? |

## Pass criteria

- All 4 prerequisites checked before any modification
- Per-conflict 3-pane view rendered with diff analysis from git log
- Recommendation engine correctly identifies the 4 conflict shapes (comments-only, new-field, same-signature, security-relevant)
- Post-rebase typecheck runs unconditionally; abort on fail (default)
- Push always uses --force-with-lease=origin/<branch>:<old-ref> with the expected-old-ref captured BEFORE the rebase

## Known risks

- Haiku may skip the typecheck step if --abort-on-test-fail isn't in front of the workflow; promote it earlier.
- Sonnet may recommend keep-pr for security-relevant cases; enforce "keep-main when paths match security-sensitive patterns".
- Opus may try to do an interactive rebase + squash without being asked. Enforce "no squash unless explicitly asked".

## How to run

Use a sandbox git repo with engineered conflicts matching the 4 shapes; verify the recommendation engine and the force-with-lease semantics.

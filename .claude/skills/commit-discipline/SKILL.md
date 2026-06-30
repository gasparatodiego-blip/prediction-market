---
name: commit-discipline
description: Apply before staging or committing any change in the Edgeradar repo. Enforces atomic, narrowly-scoped commits and prevents secrets or junk from being committed.
---

# Commit Discipline

## Scope
- One logical change per commit. Never bundle unrelated edits.
- Stage ONLY the files relevant to the current task. Run `git status` and `git diff --staged` and review before committing.

## Never commit
- .env files or any file containing credentials, API keys, or tokens.
- Build artifacts, logs, node_modules, temp files, or unrelated junk.
- If a secret was accidentally staged, unstage it and stop to report before proceeding.

## Message
- Clear, imperative subject scoped to the single change (e.g. "funding: cap annualized ROC display at 200%").

## Stop gate
- Before `git commit`, print the exact list of staged files and the commit message, then STOP for Diego's confirmation unless he has pre-approved the commit in this session.

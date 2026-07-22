---
name: git-workflow
description: Apply before any git staging, committing, pushing, branch, or ref operation in Edgeradar. Encodes the repo's push/staging guardrails, secret-scan requirement, and protected backup refs so no unauthorized push, over-broad stage, or leaked secret ever happens. Complements commit-discipline.
---

# Git Workflow

Ground against the live `git status`, `git log`, and `CLAUDE.md` before acting — the guardrails below are what is actually enforced today.

## Push — explicit per-push approval only
- **NEVER `git push` without explicit approval in that exact session.** A prior push approval does **not** carry to a new commit. Per `CLAUDE.md`, `git push` and any deploy are never auto-approved on an auto-resume turn, and even on a live turn the standing instruction is to stop after the commit and report unless push was explicitly requested.
- Local, reversible work (build, test, edit, stage, local commit) is fine to do autonomously; the gate is specifically push/deploy.

## Staging — specific files only
- **NEVER `git add -A` or `git add .`** Stage explicit paths (`git add path/to/file`). Review `git diff --staged` before committing.
- `data/` runtime state must stay untracked/gitignored — verify against `.gitignore`, which excludes `.env*`, `data/history/`, `data/sports/`, `data/sport-raw/`, `data/*.json` runtime caches, `data/opportunities.db*`, etc. Never stage a `data/` runtime file.
- **Leave pre-existing untracked/dirty files unrelated to the task untouched.** Enforceable check: `git status --short` — e.g. at last read it showed unrelated `?? data/dn-lp-pools.json`, `?? data/funding-alert-state.json`, `?? data/funding-targeted-edge.txt`, `?? scripts/polymarket-conviction-cohort.js`. These are not yours; do not stage, move, or delete them.

## Atomic commits
- One logical change per commit (see [[commit-discipline]]).
- The commit message must state **what was actually measured/verified in this session**, not aspirational language. The repo convention is literal: e.g. `chore(venues): bybit liveVerified — trade-only accepted, withdraw-enabled refused, verified <DATE>` (`scripts/verify-venue-live.md:184`). If a fix wasn't verified end-to-end, don't claim it was — see [[verification-standard]].

## Secret scan before any push
There is no committed gitleaks/husky hook, so run the scan yourself over the **entire patch** (`git diff --cached` / the full range) before pushing. Concrete 4-pattern scan (the method used in prior sessions):
1. **Private keys / PEM:** `BEGIN (RSA|EC|OPENSSH|PGP|PRIVATE)`, `PRIVATE KEY`
2. **API keys / tokens:** `sk-[a-z0-9]{16,}`, `AKIA[0-9A-Z]{16}`, `ghp_[A-Za-z0-9]{20,}`, `xox[baprs]-`, `bearer [a-z0-9._-]{20,}`, `(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{12,}`
3. **High-entropy literals:** `['"][A-Fa-f0-9]{32,}['"]`, `['"][A-Za-z0-9+/]{40,}={0,2}['"]`
4. **Connection strings with creds:** `(postgres|mysql|mongodb|redis|https?)://[^ '"]*:[^ '"]*@`

If anything matches, unstage it and STOP to report — never push through a hit. (Note: 0x-prefixed on-chain contract/condition IDs are not secrets, but private KEYS are — never commit one; keys are passed by env only, never a file, per `scripts/verify-venue-live.md:22,193`.)

## Protected refs & files — never delete or force-overwrite
These exist as recovery baselines. Grep before any destructive ref/file op; found in this repo:
- **Branches:** `backup-before-merge-d4f1ae7`, `backup-before-rebase-cb9f5bb`
- **Tag:** `backup`
- **Backup files/dirs:** `scripts/nightly-backup.sh`, `scripts/backup.sh`, `app/page.tsx.backup`, `app/globals.css.backup`, `app/globals.css.backup_originale`, `app/dashboard/page.tsx.backup`, `app/dashboard/backup/`

Never `git branch -D`, force-push over, or `rm` any `backup-*` / `golden-*` / `*.backup` without an explicit human instruction in that session. Treat them as read-only.

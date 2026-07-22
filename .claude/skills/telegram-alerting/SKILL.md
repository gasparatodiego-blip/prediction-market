---
name: telegram-alerting
description: Apply before adding, changing, or reasoning about any Telegram alert path in Edgeradar. Encodes the one bot identity, the global mute switch and its exact gating semantics, which agents can actually send, the per-agent cooldown patterns, and the deliberate restraint that alerts are for honest-engine violations and uptime only — never marketing noise.
---

# Telegram Alerting

One bot, one admin chat, one global mute switch — but the switch's semantics are subtle and the "who can send" answer depends on the current `.env`. Ground every claim against the live `.env` values and the send-function guards, never against memory. Verify the flag's current value before repeating any "only X sends" statement.

## Bot identity + global mute switch
- **Bot token / chat** live in `.env` (gitignored): `TELEGRAM_BOT_TOKEN` (`.env:9`), `TELEGRAM_CHAT_ID` (`.env:10`, a single admin chat — read the value from `.env`, never inline it into code or docs). There is **no shared `lib/telegram*.js`** — each agent defines its own local `sendTelegram` (raw `https.request` / `httpPost` to `api.telegram.org/bot<token>/sendMessage`) and copy-pastes an inlined `.env`-loader block (pm2 doesn't auto-load `.env`); loader reads `.env.local` then `.env`, first-definition-wins (e.g. `agent26-landing-auditor.js:60-69`).
- **Global mute switch: `TELEGRAM_ALERTS_ENABLED`.** Checked as a string `=== 'false'` guard inside each MUTE-classified agent's send fn (e.g. `agents/agent9-telegram.js:46` — `if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return`). Same guard in agent-marketmaker `:72`, agent10-binance `:127`, agent-liquidity `:49`, agent22-funding-alerts `:68`, agent-master `:137`, agent14-rebalancer `:51`, agent32-paper-trader `:112`, agent21-copy-watcher `:375`.

## Exact gating semantics — the trap
Because the guard is `=== 'false'`, **the mute only bites when the flag is literally `false`.** As last grounded, `.env:15` reads `TELEGRAM_ALERTS_ENABLED=true`, so the global mute is **OFF** and every MUTE-classified agent currently passes the global gate. The `.env:12-14` comment ("agent26-landing-auditor and agent-monitor never check this flag, so they … are the only senders") is true **only when the flag is `false`**. **Always re-read `.env:15` before repeating the "only agent26 + agent-monitor send" claim** — it is a conditional, not a constant.

## Who can send (verify against current `.env`)
- **Guardians — bypass the global switch entirely** (no `TELEGRAM_ALERTS_ENABLED` check): `agent26-landing-auditor` (`sendTelegram` `:182`, only checks token/chat present) and `agent-monitor` (`:148`). These always send. `agent31-trader-auditor` is also a guardian (bypasses the global switch, `:115`) **but** has its own mute `TRADER_AUDITOR_TELEGRAM_MUTED` (`:127`, enforced `:490`); `.env:35` sets it `true`, so agent31 is currently **muted** (scans + writes `/tmp/trader-audit.json`, sends nothing).
- **Opt-in double-gated — currently silent** regardless of the global flag: `agent27-news-guard` needs `NEWS_GUARD_TELEGRAM_ENABLED=true` (`:105`, gate `:150`; `.env:21` = `false` → silent) and `agent29-verifier` needs `VERIFY_TELEGRAM_ENABLED=true` (`:62`, gate `:102`; `.env:28` = `false` → silent).
- **Positive-flag agents** (`=== 'true'` required): `agent30-trader-feed` (WS-unhealthy watchdog only, `:91`/`:531`) and `agent33-sport-recorder` (digest, `:488`).

Net right now (flag=true): the always-on senders are the **guardians agent26 + agent-monitor**; the MUTE agents and agents 30/33 can also send because the global mute is off; only agent27 + agent29 stay hard-silenced by their own opt-in flags; agent31 stays silenced by its own mute.

## Adding a new alerting agent safely
1. **Respect the global mute switch** — copy the `if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return` guard into the send fn. Only make it a guardian (bypassing the switch) if it is a genuine honest-engine/uptime guardian, and give it its own dedicated mute flag if so.
2. **Prefer a per-agent opt-in flag** (`X_TELEGRAM_ENABLED === 'true'`, default off) like agent27/agent29 so it ships silent and is enabled deliberately.
3. **Never spam** — add a cooldown/dedup, persisted to a `/tmp` state file so restarts don't re-fire. Real patterns to copy:
   - agent27 per-market cooldown `ALERT_COOLDOWN_MS = 6h` (`:133`), consumed only on a real send (`:551`), persisted in `/tmp/news-guard-state.json`.
   - agent26 6h violation-set hash dedup (`:77`, `lastAlertHash`/`lastAlertAt` `:763`).
   - agent-monitor 30-min per-target alert cooldown + 15-min recovery cooldown (`:116`,`:128`, `alertCooldown[name]` map `:375`).
4. Update the [[project-telegram-sender-mute-matrix]] memory when the sender inventory changes.

## Product reasoning — deliberate restraint
Telegram alerts exist for **honest-engine violations and uptime**, not promotion or marketing. That's why the fleet ships muted-by-default with only guardians bypassing the switch — it is a deliberate design choice, not an oversight. A new alert must clear the bar of "an operator needs to act on this now"; if it's informational or promotional, it belongs in the dashboard/data file, not a push. See [[honest-engine]].

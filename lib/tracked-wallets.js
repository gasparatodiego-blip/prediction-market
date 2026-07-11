// Shared single-source-of-truth for the "tracked trader universe" — the exact set
// of wallets the dashboard exposes trader detail pages for, and therefore the set
// agent30 (trader-feed) must backfill and agent31 (trader-auditor) must re-verify.
//
// WHY THIS EXISTS
//   leaderboard.json carries FOUR wallet-bearing sections, and the dashboard links
//   trader pages from ALL of them:
//     • categories    — directional leaderboard rows
//     • mmCategories   — market-maker leaderboard rows (a SEPARATE board; ~50 of its
//                        wallets never appear in categories/bots)
//     • bots           — bot/HFT board
//     • profiles       — the normalized per-trader map (keyed by wallet); every
//                        wallet with an enriched profile has a reachable detail page
//   agent30/agent31 previously built the set from categories+bots ONLY, so the
//   mmCategories board and every profiles-only wallet 404'd on their trader page
//   (feed never backfilled them) even though the public source has full fills/positions.
//   Defining the universe ONCE here guarantees the feed writer and the auditor can
//   never drift out of agreement about who is "tracked".
//
// HONEST-ENGINE: this only enumerates addresses that already exist in the leaderboard
// the dashboard renders — it invents nothing. Missing sections are skipped, not faked.

'use strict';

// Collect the complete tracked-wallet set (lowercased) from a parsed leaderboard.json.
// Union of categories + mmCategories + bots + profiles keys. Returns a Set<string>.
function collectTrackedWallets(raw) {
  const set = new Set();
  if (!raw || typeof raw !== 'object') return set;
  const addList = (list) => {
    for (const r of (list || [])) if (r && r.wallet) set.add(String(r.wallet).toLowerCase());
  };
  for (const cat of Object.values(raw.categories   || {})) addList(cat);
  for (const cat of Object.values(raw.mmCategories || {})) addList(cat);
  addList(raw.bots);
  for (const addr of Object.keys(raw.profiles || {})) if (addr) set.add(String(addr).toLowerCase());
  return set;
}

module.exports = { collectTrackedWallets };

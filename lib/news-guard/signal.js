'use strict';
// lib/news-guard/signal.js — the typed MarketMoveSignal and the SEVERITY POLICY.
//
// One market-move signal, from one or both detectors:
//   { marketId, severity, source, evidence, ts }
//     severity : 'low' | 'medium' | 'high' | 'unknown'
//     source   : 'book' | 'news' | 'book+news' | 'none'
//     evidence : measured fields only (rolling baselines, ratios, σ, article counts, sources)
//     ts       : caller-stamped epoch ms
//
// SEVERITY POLICY (book-primary, explicit and testable):
//   • book alone            → at most 'medium'  (elevated, watch — not "withdraw now")
//   • book AND news agreeing → 'high'           (real move + corroborating breaking news)
//   • news alone            → at most 'low'     (advisory: a headline w/o book movement is
//                                                usually already priced or irrelevant)
//   • neither               → 'low' (calm) when we had data to judge, else 'unknown' (—)
//
// This is the ONLY place the policy lives, so the UI pill, the action layer, and the shadow log
// can never disagree about what a severity means.

// News "agrees" (can corroborate a book move up to HIGH) only when the news detector is itself
// elevated. A 'low'/'unknown' news reading never lifts anything.
function newsAgrees(newsLevel) {
  return newsLevel === 'high' || newsLevel === 'medium';
}

/**
 * Combine the two detectors into one severity per the policy above.
 * @param {object|null} book  detectBookMove() result: { fired, severity, triggers, ... } | null
 * @param {object|null} news  news signal: { level:'low'|'medium'|'high'|'unknown', ... } | null
 * @returns {{ severity:string, source:string, hadData:boolean }}
 */
function combineSeverity(book, news) {
  const bookFired  = !!(book && book.fired);
  const newsLevel  = news && news.level ? news.level : null;
  const bookHadData = !!(book && book.reason !== 'insufficient-history');
  const newsHadData = !!(news && news.level && news.level !== 'unknown');
  const hadData = bookHadData || newsHadData;

  if (bookFired && newsAgrees(newsLevel)) return { severity: 'high',   source: 'book+news', hadData: true };
  if (bookFired)                          return { severity: 'medium', source: 'book',      hadData: true };
  if (newsAgrees(newsLevel))              return { severity: 'low',    source: 'news',      hadData: true }; // news alone → advisory low
  if (hadData)                            return { severity: 'low',    source: 'none',      hadData: true }; // calm, and we could tell
  return { severity: 'unknown', source: 'none', hadData: false };                                            // genuinely no signal → "—"
}

/**
 * Build the typed MarketMoveSignal + a human-readable evidence summary from measured fields only.
 * The summary is assembled from real numbers ("spread 3.1× baseline · mid +2.4σ · 2 sources"); it
 * never contains a value that wasn't measured, and shows nothing for a component that didn't fire.
 */
function buildSignal({ marketId, book, news, ts }) {
  const { severity, source } = combineSeverity(book, news);
  const parts = [];
  const triggers = (book && Array.isArray(book.triggers)) ? book.triggers : [];
  for (const t of triggers) {
    if (t.type === 'spread-widening' && t.ratio != null) parts.push(`spread ${t.ratio}× baseline`);
    else if (t.type === 'spread-widening' && t.sigmas != null) parts.push(`spread +${t.sigmas}σ`);
    else if (t.type === 'mid-jump') parts.push(`mid ${t.deltaMid >= 0 ? '+' : ''}${t.sigmas}σ (${(t.deltaMid * 100).toFixed(1)}¢)`);
    else if (t.type === 'one-sided-depth-collapse') parts.push(`depth ${Math.round((1 - t.fracOfBaseline) * 100)}% off`);
    else if (t.type === 'band-emptied') parts.push('band emptied');
    else if (t.type === 'structural-trap') parts.push('one side empty (TRAP)');
  }
  if (news && news.level && news.level !== 'unknown' && news.level !== 'low' && news.recent != null) {
    parts.push(`${news.recent} article${news.recent === 1 ? '' : 's'}/${news.recentH ?? 3}h`);
  }
  const sourceCount = (book && book.fired ? 1 : 0) + (news && newsAgrees(news.level) ? 1 : 0);

  return {
    marketId,
    severity,
    source,
    ts,
    evidence: {
      summary: parts.length ? parts.join(' · ') : (severity === 'unknown' ? null : 'calm'),
      sourceCount,
      book: book ? { fired: book.fired, severity: book.severity, triggers, window: book.window, reason: book.reason ?? null } : null,
      news: news ? { level: news.level, recent: news.recent ?? null, ratio: news.ratio ?? null, source: news.source ?? null, note: news.note ?? null } : null,
    },
  };
}

module.exports = { combineSeverity, buildSignal, newsAgrees };

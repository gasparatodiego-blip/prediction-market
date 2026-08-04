import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { fetchMarketByConditionId, rewardLabelFor, NO_REWARD_LABEL } from '@/lib/maker/market-search';
import { upsertMarket, readMarketCatalog } from '@/lib/maker/market-catalog';
import { readAutoRepriceConfig, setAutoReprice } from '@/lib/maker/auto-reprice-config';
import { isManualMarket, setManualMode } from '@/lib/maker/manual-mode';
import { setAutoClose, readAutoCloseConfig } from '@/lib/maker/auto-close-config';
import { resolveMarketWindow, minMinutesToClose } from '@/lib/maker/market-clock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/markets/enable — ADD (or remove) a market the operator picked by hand.
 *
 * TWO STEPS, AND THE FIRST ONE WRITES NOTHING. `preview:true` re-reads the market from the venue, computes
 * exactly what would change, and returns it — no file is touched. `preview:false` performs the same reads
 * and then writes. That is the same shape as the allocation's anteprima → conferma, and for the same
 * reason: a control that enables real orders on a new market at one click is a control that gets pressed
 * by accident exactly once.
 *
 * WHAT A CONFIRM WRITES — four durable, audited records, and nothing else:
 *   1. data/maker-manual-markets.json  the market's VENUE METADATA (tokens, tick, negRisk, reward pot,
 *      close date, book snapshot), so lib/maker/manual-order.resolveMarketRules can judge orders on a
 *      market the reward board has never heard of. (lib/maker/market-catalog.js — atomic + audit line.)
 *   1b. data/maker-auto-close.json     the per-market AUTO-CLOSE opt-in, written BEFORE the allowlist and
 *      a HARD STOP if it fails: a market that can receive orders must already have a way out. Added
 *      2026-08-04 — the guarantee existed in lib/maker/allocation-reset.js phase 3 (the RESET path) and
 *      was absent from this one, which is additive; a market enabled from here was born without an exit.
 *   2. data/maker-auto-reprice.json    the per-market opt-in, which IS cfg.enabledMarketIds — the list the
 *      adapter's live-min gate now checks instead of one pinned market. (setAutoReprice — atomic + audit
 *      line, the same write the panel's own switch uses. No second mechanism was invented for this.)
 *   3. data/maker-manual-mode.json     OPTIONAL (`takeManual`), the manual-ownership flag that stands
 *      agent35 off the market. Requested explicitly by the caller, audited like the rest.
 *
 * WHAT IT DOES NOT DO. It places nothing, arms nothing and raises no cap. A market on the allowlist still
 * has to pass manual ownership, the venue-rules guard, the per-order cap, the kill switch, the adapter's
 * whole chain and the exchange's own validateOrder() — and MANUAL_ORDER_PLACEMENT still decides whether
 * anything is sent at all. Enabling a market only makes it ELIGIBLE to be refused by the usual gates
 * instead of being refused for not existing.
 *
 * A MARKET WITH NO REWARD PROGRAMME IS ACCEPTED — deliberately — and labelled. What it is NOT is silently
 * equivalent: the response says `hasRewards:false`, carries the directional-trading warning, and states
 * that the reward-band guard will refuse orders on it until a band exists to judge them against.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
const bodySchema = z.object({
  marketId: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/, 'conditionId non valido (atteso 0x + 64 esadecimali)'),
  enabled: z.boolean().optional(),        // default true; false disables (always permitted)
  preview: z.boolean().optional(),        // default true — writing requires an explicit preview:false
  takeManual: z.boolean().optional(),     // also stand agent35 off this market
  capitalUsd: z.number().finite().nonnegative().optional(), // echoed into the confirmation summary + audit
  reason: z.string().max(500).optional(),
});

const BY = 'operator · allocation panel (aggiunta mercato manuale)';

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { marketId } = parsed.data;
  const enable = parsed.data.enabled !== false;
  const preview = parsed.data.preview !== false;
  const takeManual = parsed.data.takeManual === true;
  const capitalUsd = parsed.data.capitalUsd ?? null;
  const reason = parsed.data.reason ?? null;
  const id = marketId.toLowerCase();

  try {
    const cfgBefore = readAutoRepriceConfig();
    const catBefore = readMarketCatalog();
    const manualBefore = isManualMarket(id);
    const enabledBefore: string[] = cfgBefore.enabledMarketIds || [];

    // ── DISABLE. Always permitted, needs no venue read, and deliberately leaves the metadata in place:
    //    forgetting what a market IS would only make a later re-enable dumber. ──
    if (!enable) {
      if (preview) {
        return NextResponse.json({
          ok: true, preview: true, action: 'disable', marketId: id,
          enabledBefore, enabledAfter: enabledBefore.filter((m) => m !== id),
          note: 'Anteprima: il mercato verrebbe tolto dalla lista abilitata (cfg.enabledMarketIds). Nessun ordine a riposo viene cancellato da questa azione — usa «Cancella» per quelli.',
        });
      }
      const off = setAutoReprice({ scope: 'market', marketId: id, enabled: false, by: BY, reason });
      const cfgAfter = readAutoRepriceConfig();
      return NextResponse.json({
        ok: off.ok, preview: false, action: 'disable', marketId: id, write: off,
        enabledBefore, enabledAfter: cfgAfter.enabledMarketIds || [],
        note: 'Mercato tolto dalla lista abilitata: da adesso un ordine su questo mercato viene rifiutato dal gate live-min (live-min-market-mismatch). Gli ordini già a riposo NON sono stati toccati.',
      });
    }

    // ── ENABLE. The venue is re-read FIRST: the metadata that gets stored has to be the venue's current
    //    answer, not whatever a stale search result in a browser tab still says. ──
    const look = await fetchMarketByConditionId(id);
    if (!look.ok || !look.market) {
      return NextResponse.json({ ok: false, gate: 'market-not-found', marketId: id, error: look.error }, { status: 404 });
    }
    const m = look.market;

    const autoCloseCfg = readAutoCloseConfig();
    const minMinutes = minMinutesToClose();
    const endMs = m.endDate ? Date.parse(m.endDate) : NaN;
    // The window a hand order on this market would get if placed right now — computed with the same pure
    // function the placement path uses, so the preview cannot promise a window the placer would not give.
    const window = resolveMarketWindow({
      endMs: Number.isFinite(endMs) ? endMs : null,
      baseTtlSeconds: 1380, baseRefreshMarginSeconds: 180, minMinutes,
    });

    const warnings: string[] = [];
    if (!m.hasRewards) warnings.push(`${NO_REWARD_LABEL}: questo mercato non ha montepremi di liquidità, quindi qualunque ordine qui non produce reward.`);
    if (m.rewardsMaxSpreadCents == null || !(m.rewardsMaxSpreadCents > 0)) warnings.push('Il venue non pubblica una banda reward (max_spread) per questo mercato: il guard di banda condiviso rifiuterà gli ordini con RULES_UNREADABLE finché non esiste una banda contro cui giudicarli. Il mercato viene registrato lo stesso, ma sappilo prima di contarci.');
    if (window.tooClose) warnings.push(`Mancano ${window.minutesToClose == null ? '—' : window.minutesToClose.toFixed(1)} min alla chiusura (soglia ${minMinutes} min): finché resta sotto soglia ogni nuovo ordine viene rifiutato con ${window.gate}.`);
    if (m.closed) warnings.push('Il venue segnala questo mercato come CHIUSO.');
    if (!m.acceptingOrders) warnings.push('Il venue segnala che questo mercato NON accetta ordini in questo momento.');
    if (!cfgBefore.globalEnabled) warnings.push('Il master switch dell\'auto-riprezzo è SPENTO: il mercato risulterà opted-in ma NON entrerà in cfg.enabledMarketIds finché il master resta spento, quindi il gate live-min continuerà a rifiutare.');
    if (!manualBefore.manual && !takeManual) warnings.push('La modalità manuale NON è attiva su questo mercato: senza di essa il pannello rifiuta con manual-mode-inactive. Spuntala nella conferma, o attivala dal pannello ordini manuali.');
    if (m.mid == null) warnings.push('Book senza mid leggibile in questo momento (libro vuoto o senza quotazioni): un ordine verrebbe rifiutato con rules-unreadable finché non c\'è un mid.');
    // L'opt-in per mercato non serve a niente se il generale è spento: il mercato risulterebbe «con
    // uscita accesa» e nessuna uscita verrebbe mai tentata. Va detto PRIMA di confermare.
    if (!autoCloseCfg.readable) warnings.push('Lo stato dell\'uscita automatica non è leggibile: l\'abilitazione verrà rifiutata, perché non si può garantire una via d\'uscita su un mercato che sta per diventare piazzabile.');
    else if (!autoCloseCfg.globalEnabled) warnings.push('L\'interruttore GENERALE dell\'uscita automatica è SPENTO: l\'opt-in per questo mercato verrà scritto, ma finché il generale resta spento nessuna uscita viene tentata su nessun mercato — un fill resterebbe senza via d\'uscita.');

    const summary = {
      marketId: id,
      question: m.question,
      slug: m.slug,
      endDate: m.endDate,
      minutesToClose: m.minutesToClose,
      // The three facts the panel must show for every market it lists.
      rewardsDailyRate: m.rewardsDailyRate,
      hasRewards: m.hasRewards,
      rewardLabel: rewardLabelFor(m),
      spreadCents: m.spreadCents,
      tick: m.tick,
      // What the order would look like, and whether it could be placed at all right now.
      window: {
        ttlSeconds: window.ttlSeconds, refreshMarginSeconds: window.refreshMarginSeconds,
        closeKnown: window.closeKnown, minutesToClose: window.minutesToClose,
        minMinutes: window.minMinutes, tooClose: window.tooClose, gate: window.gate, reason: window.reason,
      },
      negRisk: m.negRisk, tokenIdYes: m.tokenIdYes, tokenIdNo: m.tokenIdNo,
      bestBid: m.bestBid, bestAsk: m.bestAsk, mid: m.mid,
      // The confirmation step's own numbers: capital in play and how many markets the plan would cover.
      capitalUsd,
      marketCountBefore: enabledBefore.length,
      marketCountAfter: enabledBefore.includes(id) ? enabledBefore.length : enabledBefore.length + 1,
      alreadyEnabled: enabledBefore.includes(id),
      // Se l'uscita automatica è GIÀ accesa qui, e se l'interruttore generale lo è. Il pannello deve
      // poter distinguere «gliela accendo io adesso» da «c'era già», e soprattutto deve mostrare il
      // generale: l'opt-in per mercato non serve a niente se il generale è spento.
      autoCloseBefore: autoCloseCfg.readable ? autoCloseCfg.enabledMarketIds.includes(id) : null,
      autoCloseGlobal: autoCloseCfg.readable ? autoCloseCfg.globalEnabled : null,
      alreadyCatalogued: Object.prototype.hasOwnProperty.call(catBefore.markets || {}, id),
      manualModeActive: manualBefore.manual === true,
      willTakeManual: takeManual,
      warnings,
    };

    if (preview) {
      return NextResponse.json({
        ok: true, preview: true, action: 'enable', marketId: id, summary,
        writes: [
          'data/maker-manual-markets.json — metadati di venue (token, tick, negRisk, reward, chiusura, snapshot del book)',
          'data/maker-auto-close.json — USCITA AUTOMATICA accesa su questo mercato, PRIMA della allowlist: se non si riesce ad accenderla il mercato non viene abilitato affatto',
          'data/maker-auto-reprice.json — opt-in per-mercato = cfg.enabledMarketIds (il gate live-min legge questa lista)',
          ...(takeManual ? ['data/maker-manual-mode.json — modalità manuale (agent35 si tiene fuori da questo mercato)'] : []),
        ],
        note: 'ANTEPRIMA: non è stato scritto nulla. Conferma per rendere il mercato ammissibile — restano in vigore modalità manuale, venue-rules, cap, kill-switch, validateOrder e MANUAL_ORDER_PLACEMENT.',
      });
    }

    // ── CONFIRM. Metadata first: a market on the allowlist whose rules cannot be read would be an
    //    allowlist entry that only ever produces 'rules-unreadable'. If this write fails, nothing is
    //    enabled — the market is left exactly as it was. ──
    const cat = upsertMarket({
      marketId: id,
      question: m.question, slug: m.slug, category: m.category,
      tokenIdYes: m.tokenIdYes, tokenIdNo: m.tokenIdNo, tick: m.tick, negRisk: m.negRisk,
      rewardsDailyRate: m.rewardsDailyRate, rewardsMaxSpreadCents: m.rewardsMaxSpreadCents, rewardsMinSize: m.rewardsMinSize,
      endDate: m.endDate, mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk, spreadCents: m.spreadCents,
      fetchedAt: m.fetchedAt,
    }, { by: BY, reason: reason || `aggiunto dalla tab Allocazione${capitalUsd != null ? ` · capitale ${capitalUsd}$` : ''}` });

    if (!cat.ok) {
      return NextResponse.json({ ok: false, gate: 'catalog-write-failed', marketId: id, error: cat.error, missing: cat.missing, summary }, { status: 409 });
    }

    // ── L'USCITA AUTOMATICA SI ACCENDE PRIMA DELLA ALLOWLIST, NON DOPO ────────────────────────────
    // È la stessa regola della fase 3 di lib/maker/allocation-reset.js, e la stessa ragione: fra il
    // momento in cui un mercato diventa piazzabile e il momento in cui ha una via d'uscita non deve
    // esistere un istante — perché è esattamente in quell'istante che un fill arriverebbe senza
    // nessuno pronto a chiuderlo.
    //
    // Fino al 4 agosto 2026 questa route non chiamava `setAutoClose` da nessuna parte. La garanzia
    // «ogni mercato che il bot gestisce ha una via d'uscita» era stata costruita nel percorso di
    // RESET e non in questo, che è additivo — e Spider-Man, abilitato da qui la sera del 4 agosto,
    // è nato con due gambe potenziali e nessuna uscita. Verificato sullo stato vero: l'uscita era
    // accesa su tre mercati, tutti vecchi, due dei quali finestre Bitcoin già chiuse.
    //
    // PERCHÉ PRIMA E NON DOPO. Se fallisse questa, non si abilita niente (fermo duro qui sotto) e non
    // c'è nulla da disfare. Se invece fallisse la allowlist DOPO che l'uscita è accesa, resterebbe
    // un'uscita accesa su un mercato non abilitato: innocua per costruzione — un interruttore di
    // chiusura su un mercato senza posizioni non fa niente, mentre il contrario abbandona capitale.
    const ac = setAutoClose({
      scope: 'market', marketId: id, enabled: true, by: BY,
      reason: reason || 'mercato aggiunto dalla tab Allocazione: la via d uscita esiste PRIMA che esistano ordini',
    });
    if (!ac.ok) {
      return NextResponse.json({
        ok: false, gate: 'auto-close-write-failed', marketId: id, error: ac.error, catalog: cat, summary,
        note: 'Il mercato NON è stato abilitato: non è stato possibile accendere l\'uscita automatica, e un mercato piazzabile senza via d\'uscita è peggio di un mercato in meno. Nulla è stato aggiunto alla allowlist.',
      }, { status: 409 });
    }

    const on = setAutoReprice({
      scope: 'market', marketId: id, enabled: true, by: BY,
      reason: reason || `mercato scelto a mano dalla tab Allocazione${m.hasRewards ? '' : ' — SENZA reward (trading direzionale)'}${capitalUsd != null ? ` · capitale ${capitalUsd}$` : ''}`,
    });
    if (!on.ok) {
      return NextResponse.json({ ok: false, gate: 'enable-write-failed', marketId: id, error: on.error, catalog: cat, autoClose: ac, summary }, { status: 409 });
    }

    let manual = null;
    if (takeManual && !manualBefore.manual) {
      manual = setManualMode({
        marketId: id, manual: true, by: BY,
        reason: reason || 'mercato aggiunto a mano dalla tab Allocazione — il motore automatico si tiene fuori',
      });
    }

    const cfgAfter = readAutoRepriceConfig();
    return NextResponse.json({
      ok: true, preview: false, action: 'enable', marketId: id, summary,
      catalog: cat, enable: on, manual,
      enabledBefore, enabledAfter: cfgAfter.enabledMarketIds || [],
      autoClose: ac,
      note: `Mercato registrato e abilitato, con USCITA AUTOMATICA accesa prima della allowlist. Da adesso il gate live-min accetta ordini su questo market_id (${(cfgAfter.enabledMarketIds || []).length} mercati abilitati in totale) — e continua a rifiutare qualunque market_id fuori lista. Nessun ordine è stato piazzato da questa azione.`,
      warnings,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message, marketId: id }, { status: 500 });
  }
}

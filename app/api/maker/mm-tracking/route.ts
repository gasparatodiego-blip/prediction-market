import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
// La directory di servizio, per UTENTE: v. lib/percorsi-runtime.js (migrazione root → bot).
import { fileRuntime } from '@/lib/percorsi-runtime';
import { z } from 'zod';
import { readTrackingConfig, setTracking, LIMITS, SIDES, activeSides } from '@/lib/maker/mm-tracking-config';
import { planQuotes } from '@/lib/maker/mm-quote-math';
import { resolveMarketRules, listManualOrders, cancelManualOrder } from '@/lib/maker/manual-order';
import { marketWindowFor } from '@/lib/maker/market-clock';
import { RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS } from '@/lib/maker/auto-reprice-config';

// La stessa soglia con cui il pannello smette di chiamare «live» un prezzo, e con cui il gate
// stale-book rifiuta un ordine. Una terza soglia diversa qui vorrebbe dire tre risposte alla stessa
// domanda: «questo prezzo e' ancora buono?».
const FRESH_MID_MAX_SEC = 30;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/mm-tracking — IL TOGGLE CHE AUTORIZZA IL MOTORE, e lo stato di cio' che sta facendo.
 *
 * QUESTO E' L'UNICO PUNTO IN CUI SI CONCEDE A UN AUTOMATISMO DI PIAZZARE ORDINI REALI SENZA UNA
 * CONFERMA PER ORDINE. Ovunque altro in questo progetto un ordine vero costa due tocchi espliciti; qui
 * i due tocchi comprano una DELEGA CONTINUATA su un mercato solo, e per questo:
 *   · il flusso resta a due passi (`preview:true` non scrive nulla, `preview:false` scrive);
 *   · ogni parametro e' obbligatorio — nessun default, perche' un default significherebbe quotare con
 *     numeri che l'operatore non ha scelto;
 *   · l'anteprima mostra DOVE finirebbero i due ordini adesso, coi prezzi veri del venue;
 *   · ogni accensione e spegnimento finisce in un audit append-only con chi e perche'.
 *
 * SPEGNERE E' SEMPRE PERMESSO, anche con lo stato illeggibile: e' la direzione sicura.
 *
 * GET  → chi e' in tracking, con la configurazione e lo stato vivo pubblicato dal motore.
 * POST → accende/spegne. Con `cancelOrders:true` allo spegnimento, cancella anche gli ordini a riposo.
 */

const STATE_FILE = fileRuntime('maker-mm-tracking-state.json');

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  preview: z.boolean().optional(),          // default true — scrivere richiede preview:false esplicito
  offsetCents: z.number().finite().optional(),
  minMoveCents: z.number().finite().optional(),
  sizeShares: z.number().finite().optional(),
  // QUALI LATI QUOTARE. Omesso ⇒ 'both', che e' il comportamento di sempre: un chiamante che non conosce
  // questo campo non puo' cambiare per sbaglio cosa fa il motore su un mercato.
  sides: z.enum(['both', 'yes', 'no']).optional(),
  // Allo spegnimento: cancellare gli ordini a riposo, oppure lasciarli scadere per GTD. Nessun default
  // nascosto — la route lo pretende esplicito e l'anteprima dice cosa succederebbe in entrambi i casi.
  cancelOrders: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
});

function readState(): unknown {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export async function GET() {
  const cfg = readTrackingConfig();
  return NextResponse.json({
    ok: true, at: new Date().toISOString(),
    readable: cfg.readable, error: cfg.error,
    limits: LIMITS,
    count: cfg.marketIds.length,
    markets: cfg.marketIds.map((id) => cfg.markets[id]),
    // Cosa il motore sta facendo ADESSO. `null` = agent40 non ha ancora pubblicato uno stato, il che
    // significa «non lo sappiamo», non «non sta facendo niente».
    engine: readState(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'corpo non JSON' }, { status: 400 }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  }
  const { marketId, enabled, offsetCents, minMoveCents, sizeShares, cancelOrders, reason } = parsed.data;
  const sides = parsed.data.sides ?? 'both';
  const preview = parsed.data.preview !== false;

  try {
    // ── SPEGNIMENTO ───────────────────────────────────────────────────────────────────────────────
    if (!enabled) {
      let resting: Array<{ orderId: string | null; price: number | null; size: number | null }> = [];
      try {
        const l = await listManualOrders({ marketId });
        if (l && l.ok) resting = (l.orders || []).map((o: { orderId: string | null; price: number | null; sizeRemaining: number | null }) => ({ orderId: o.orderId, price: o.price, size: o.sizeRemaining }));
      } catch { /* la lista non e' una precondizione dello spegnimento */ }

      if (preview) {
        return NextResponse.json({
          ok: true, preview: true, action: 'tracking-off', marketId,
          restingOrders: resting,
          note: resting.length
            ? `Il tracking verrebbe spento. Ci sono ${resting.length} ordini a riposo su questo mercato: scegli se cancellarli subito oppure lasciarli scadere per GTD (il venue li ritira comunque entro la finestra).`
            : 'Il tracking verrebbe spento. Non ci sono ordini a riposo su questo mercato.',
        });
      }

      const off = setTracking({ marketId, enabled: false, reason: reason ?? 'spento dall operatore' });
      if (!off.ok) return NextResponse.json({ ok: false, error: off.error }, { status: 500 });

      const cancelled: Array<{ orderId: string | null; ok: boolean; reason: string | null }> = [];
      if (cancelOrders === true) {
        for (const o of resting) {
          if (!o.orderId) continue;
          try {
            const c = await cancelManualOrder({ orderId: o.orderId, marketId }, 'mm-tracking');
            cancelled.push({ orderId: o.orderId, ok: c.ok !== false, reason: c.reason ?? null });
          } catch (e) { cancelled.push({ orderId: o.orderId, ok: false, reason: (e as Error).message }); }
        }
      }
      return NextResponse.json({
        ok: true, preview: false, action: 'tracking-off', marketId,
        cancelledOrders: cancelOrders === true, cancelled,
        note: cancelOrders === true
          ? `Tracking spento e ${cancelled.filter((c) => c.ok).length}/${cancelled.length} ordini cancellati sul venue.`
          : 'Tracking spento. Gli ordini a riposo NON sono stati toccati: scadranno da soli per GTD, perche nulla li rinnova piu.',
      });
    }

    // ── ACCENSIONE ────────────────────────────────────────────────────────────────────────────────
    if (offsetCents == null || minMoveCents == null || sizeShares == null) {
      return NextResponse.json({ ok: false, error: 'offsetCents, minMoveCents e sizeShares sono obbligatori per accendere: qui non esistono default' }, { status: 400 });
    }

    const rules = resolveMarketRules(marketId);
    if (!rules.readable) {
      return NextResponse.json({
        ok: false, error: `regole di venue non leggibili per questo mercato (mancano: ${rules.missing.join(', ')}) — non accendo un motore automatico su regole che non so leggere`,
      }, { status: 409 });
    }
    // ── GLI STESSI GATE DEL PIAZZAMENTO A MANO, sull'ATTIVAZIONE ─────────────────────────────────
    // Accendere il tracking e' piu' impegnativo che piazzare un ordine: autorizza N ordini futuri. Non
    // avrebbe senso che passasse controlli piu' deboli di quelli che un ordine solo deve superare.
    //   · il prezzo dev'essere vivo — accendere un motore che insegue il mid su un mid che non e' del
    //     book live significa inseguire un numero fermo;
    //   · il mercato non dev'essere a ridosso della chiusura — il motore li' non riprezzerebbe comunque
    //     (lo stesso gate a 3 minuti), quindi accendere produrrebbe solo una riga in pausa.
    const gates: string[] = [];
    if (rules.midSource !== 'live-book') {
      gates.push(`il prezzo di questo mercato viene da «${rules.midSource || 'fonte ignota'}», non dal book live: il motore inseguirebbe un mid che non e' quello vero. Apri il pannello e attendi che indichi «book live».`);
    } else if (Number.isFinite(rules.midAgeSec) && (rules.midAgeSec as number) > FRESH_MID_MAX_SEC) {
      gates.push(`il book live per questo mercato e' fermo da ${rules.midAgeSec}s: la sottoscrizione sembra caduta.`);
    }
    // ── QUANTA VITA OPERATIVA RESTA DAVVERO ───────────────────────────────────────────────────────
    // Il gate rifiuta solo quando il mercato e' GIA' sotto soglia. Ma fra «sopra soglia» e «utile» c'e'
    // di mezzo tutto: attivare il tracking con 7 minuti di vita su una soglia da 3 significa comprare
    // 4 minuti di motore, non un turno di lavoro. E' successo davvero — attivazione con 7.6 minuti
    // residui, tre ordini piazzati, motore fermo 2 minuti dopo — e dallo schermo non si vedeva.
    //
    // NON E' UN RIFIUTO, ed e' una scelta: su una finestra Bitcoin da 5 minuti quei pochi minuti sono
    // esattamente cio' che si vuole, e trasformare l'avviso in un divieto renderebbe il tracking
    // inutilizzabile proprio dove serve. Quindi si dice quanto durera', e si lascia decidere.
    const warnings: string[] = [];
    let runwayMin: number | null = null;
    try {
      const w = marketWindowFor({ marketId, baseTtlSeconds: RESTING_GTD_SECONDS, baseRefreshMarginSeconds: REFRESH_MARGIN_SECONDS });
      if (w && w.tooClose === true) gates.push(`${w.reason} — il motore non riprezzerebbe comunque su questo mercato.`);
      else if (w && Number.isFinite(w.minutesToClose) && Number.isFinite(w.minMinutes)) {
        runwayMin = +((w.minutesToClose as number) - (w.minMinutes as number)).toFixed(1);
        if (runwayMin < 3 * (w.minMinutes as number)) {
          warnings.push(
            `Vita operativa BREVE: il mercato chiude fra ${(w.minutesToClose as number).toFixed(1)} min e il motore smette di`
            + ` riprezzare sotto i ${w.minMinutes} min, quindi lavorera' per circa ${runwayMin} min.`
            + ' Dopo quel momento gli ordini a riposo vengono CANCELLATI, non lasciati fermi.',
          );
        }
      }
    } catch { /* finestra non calcolabile: non e' un motivo per rifiutare */ }

    const plan = planQuotes({ mid: rules.mid, offsetCents, tick: rules.tick, bandRadiusCents: rules.bandRadiusCents });
    const wanted = activeSides(sides);
    const retired = (['yes', 'no'] as const).filter((s) => !wanted.includes(s));

    // ── COSA RESTEREBBE INDIETRO CAMBIANDO I LATI ────────────────────────────────────────────────
    // Passare da «entrambi» a «solo YES» su un tracking gia' acceso lascia un ordine NO a riposo che
    // nessuno governa piu'. Si guarda il venue PRIMA, cosi' l'anteprima puo' dire quanti e quali, e la
    // conferma sa esattamente cosa cancellare.
    const orphans: Array<{ orderId: string | null; book: 'yes' | 'no'; price: number | null; size: number | null }> = [];
    if (retired.length) {
      try {
        const l = await listManualOrders({ marketId });
        if (l && l.ok) {
          for (const o of (l.orders || []) as Array<{ orderId: string | null; tokenId: string | null; price: number | null; sizeRemaining: number | null }>) {
            const book = String(o.tokenId) === String(rules.tokenIdNo) ? 'no' : String(o.tokenId) === String(rules.tokenId) ? 'yes' : null;
            // Un ordine il cui token non e' ne' YES ne' NO di questo mercato NON viene attribuito a un
            // lato e quindi non viene toccato: indovinare qui vorrebbe dire cancellare l'ordine di
            // qualcun altro.
            if (book && retired.includes(book)) orphans.push({ orderId: o.orderId, book, price: o.price, size: o.sizeRemaining });
          }
        }
      } catch { /* la lista non e' una precondizione: il paracadute nel motore ritira comunque */ }
    }

    if (preview) {
      return NextResponse.json({
        ok: true, preview: true, action: 'tracking-on', marketId,
        rules: { mid: rules.mid, tick: rules.tick, minSize: rules.minSize, bandRadiusCents: rules.bandRadiusCents, midSource: rules.midSource, midAgeSec: rules.midAgeSec },
        plan, sides, activeSides: wanted, ordersToRetire: orphans,
        blockers: gates, warnings, runwayMinutes: runwayMin,
        note: gates.length
          ? `Anteprima: NIENTE e stato scritto. Ma il tracking NON si puo attivare adesso — ${gates.join(' ')}`
          : `Anteprima: NIENTE e stato scritto e nessun ordine e stato piazzato. ${wanted.length === 2
            ? 'Questi sono i due livelli dove il motore quoterebbe con il mid di adesso.'
            : `Il motore quoterebbe SOLO il lato ${wanted[0].toUpperCase()}, a questo livello. Un lato solo NON matura reward: il punteggio prende il minimo fra i due lati.`}`
          + (orphans.length ? ` Ci sono ${orphans.length} ordini sul lato che verrebbe ritirato: alla conferma vengono CANCELLATI subito.` : '')
          + (warnings.length ? ` ${warnings.join(' ')}` : ''),
      });
    }

    if (gates.length) {
      return NextResponse.json({ ok: false, error: gates.join(' '), blockers: gates }, { status: 409 });
    }

    const on = setTracking({ marketId, enabled: true, offsetCents, minMoveCents, sizeShares, sides, by: 'operatore · pannello ordine', reason: reason ?? null });
    if (!on.ok) return NextResponse.json({ ok: false, error: on.error }, { status: 400 });

    // ── IL LATO RITIRATO SI CANCELLA SUBITO ──────────────────────────────────────────────────────
    // Non si aspetta la scadenza GTD: quell'ordine e' stato piazzato da un motore che da questo istante
    // non lo governa piu', e lasciarlo riposare 23 minuti significherebbe tenere esposizione che nessuno
    // sta piu' guardando. Si cancella DOPO aver scritto la configurazione, cosi' se la cancellazione
    // fallisce il motore vede comunque il lato come non-attivo e continua a riprovare a ritirarlo.
    const cancelled: Array<{ orderId: string | null; book: string; ok: boolean; reason: string | null }> = [];
    for (const o of orphans) {
      if (!o.orderId) continue;
      try {
        const c = await cancelManualOrder({ orderId: o.orderId, marketId }, 'mm-tracking');
        cancelled.push({ orderId: o.orderId, book: o.book, ok: c.ok !== false, reason: c.reason ?? null });
      } catch (e) { cancelled.push({ orderId: o.orderId, book: o.book, ok: false, reason: (e as Error).message }); }
    }
    const failed = cancelled.filter((c) => !c.ok).length;

    return NextResponse.json({
      ok: true, preview: false, action: 'tracking-on', marketId, record: on.record, plan,
      sides, activeSides: wanted, prevSides: on.prevSides ?? null, cancelled,
      warnings, runwayMinutes: runwayMin,
      note: `Tracking ATTIVO su ${wanted.length === 2 ? 'ENTRAMBI i lati' : `il solo lato ${wanted[0].toUpperCase()}`}.`
        + ' Da adesso il motore quota e insegue il mid quando si muove oltre la soglia, senza chiedere conferma ordine per ordine. Si spegne dallo stesso pulsante.'
        + (wanted.length === 1 ? ' ATTENZIONE: un lato solo NON matura reward — il punteggio del programma premi prende il minimo fra i due lati.' : '')
        + (warnings.length ? ` ${warnings.join(' ')}` : '')
        + (cancelled.length
          ? ` ${cancelled.length - failed}/${cancelled.length} ordini sul lato ritirato sono stati cancellati subito.${failed ? ' Quelli non cancellati restano in carico al motore, che continua a riprovare a ogni ciclo.' : ''}`
          : ''),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

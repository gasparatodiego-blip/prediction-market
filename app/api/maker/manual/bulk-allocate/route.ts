import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runBulkAllocation } from '@/lib/maker/bulk-allocate';
import { runAllocationReset } from '@/lib/maker/allocation-reset';
import { diagnoseExposure } from '@/lib/maker/manual-reset';
import { listManualOrders, cancelManualOrder } from '@/lib/maker/manual-order';
import { readAutoRepriceConfig, setAutoReprice } from '@/lib/maker/auto-reprice-config';
import { readTrackingConfig, setTracking } from '@/lib/maker/mm-tracking-config';
import { setManualMode } from '@/lib/maker/manual-mode';
// L'USCITA AUTOMATICA VALE ANCHE PER IL BOTTONE. La regola non e' «i mercati del riallocatore hanno una
// via d'uscita»: e' «ogni mercato che il bot gestisce ce l'ha». Due percorsi che piazzano gambe devono
// accenderla entrambi, altrimenti la protezione dipende da CHI ha premuto.
import { setAutoClose } from '@/lib/maker/auto-close-config';
import { fetchVenuePositions } from '@/lib/maker/manual-reset';
import { resolveMarketRules } from '@/lib/maker/manual-order';
import { appendMakerAudit } from '@/lib/venues/polymarket-clob-maker/audit';
// LA VERIFICA AL VENUE DEI MERCATI CHE STANNO PER RICEVERE ORDINI. Il riallocatore automatico ce
// l'aveva; questo percorso no, e il 4 agosto 2026 la traccia ha mostrato due mercati su cinque col
// montepremi crollato ($114/g → $11/g e $5/g → $2/g) che stavano per ricevere $192 di capitale.
import { verificaMercatiAlVenue, filtraRighe, leggiVenueClob } from '@/lib/maker/verifica-mercati-venue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/bulk-allocate — place every row of an allocation plan, in sequence.
 *
 * It is a loop over the SAME placeManualOrder every hand order uses: no second placement path, no extra
 * venue surface, and every order lands under the same watcher management afterwards (mid chase, band
 * ceiling, GTD renewal, reconciliation).
 *
 * WHAT IT ADDS is the CUMULATIVE cap. Ten orders each individually under the per-order cap can still add
 * up past the account's open-notional ceiling, and the per-order gate cannot see that. So the run tracks
 * its own running total — starting from exposure ALREADY open, not from zero — and STOPS cleanly the
 * moment the next row would cross it, rather than attempting it and letting a gate refuse mid-sequence.
 * It stops instead of skipping ahead to a smaller row that would still fit: silently reordering an
 * allocation makes it a different allocation from the one that was confirmed.
 *
 * `preview: true` runs the whole sequence WITHOUT placing anything — same cap arithmetic, same stop
 * point, nothing sent. That is what backs the confirmation summary.
 *
 * ─── DAL 3 AGOSTO 2026: È UN RESET, NON UNA SOMMA ───────────────────────────────────────────────────
 * Prima questa route faceva solo la fase di piazzamento, e il registro dei mercati abilitati è additivo
 * per costruzione: i mercati di sessioni passate restavano nell'allowlist per sempre. Misurato: sei
 * mercati abilitati, cinque dei quali finestre BTC da cinque minuti chiuse da un giorno, con l'operatore
 * convinto di averne zero.
 *
 * Adesso `preview:false` passa da lib/maker/allocation-reset.js, che porta lo stato finale a essere
 * ESATTAMENTE il piano: cancella gli ordini a riposo sui mercati gestiti, spegne tracking e allowlist,
 * riaccende solo i mercati del piano, poi piazza — con lo STESSO runBulkAllocation di prima, che resta
 * l'unica strada che invii ordini.
 *
 * `preview:true` continua a non toccare NULLA, e in più adesso dice anche cosa verrebbe cancellato e
 * spento: da quando il tap finale cancella ordini veri, l'anteprima deve mostrarlo prima del tap.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET).
 */
const rowSchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  book: z.enum(['yes', 'no']),
  side: z.enum(['BUY', 'SELL']).optional(),
  price: z.number().finite().gt(0).lt(1),
  size: z.number().finite().gt(0).max(100_000),
  title: z.string().max(300).optional(),
  // ── L'APPARTENENZA ALLA COPPIA DEVE SOPRAVVIVERE ALLA VALIDAZIONE ────────────────────────────
  // zod scarta le chiavi che non dichiara. Senza queste due righe `coppia` e `gamba` — che il
  // pannello manda da quando le gambe sono due — venivano tolte qui dentro, e runBulkAllocation
  // vedeva righe non accoppiate: niente cap sulla coppia, niente rate limit sulla coppia, niente
  // ripristino della gamba orfana. Tutte le protezioni c'erano e nessuna poteva scattare.
  coppia: z.string().trim().min(1).max(200).optional(),
  gamba: z.enum(['yes', 'no']).optional(),
});
const bodySchema = z.object({
  rows: z.array(rowSchema).min(1).max(50),
  preview: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // The running total starts from what is ALREADY open, read from the same source the cap gate uses.
    const diag = diagnoseExposure({});
    const preview = parsed.data.preview === true;

    // ── I MERCATI SONO ANCORA QUELLI SU CUI IL PIANO È STATO DECISO? ──────────────────────────────
    // Si chiede al VENUE, non alla cache locale da cui il piano è nato: è la cache che il 4 agosto
    // raccontava $114/g mentre il venue diceva $11/g. Vale sia in anteprima che in esecuzione, così
    // l'operatore VEDE l'esclusione prima di confermare invece di scoprirla dopo.
    //
    // Un mercato bocciato perde ENTRAMBE le gambe: mezza coppia sarebbe l'esposizione asimmetrica che
    // tutto questo percorso esiste per impedire. Un mercato ILLEGGIBILE ferma tutto — per un mercato
    // che sta per ricevere ordini veri la parte che non agisce è non piazzare.
    const verifica = await verificaMercatiAlVenue(
      { rows: parsed.data.rows, poolAlPiano: {}, nowMs: Date.now() },
      { readVenue: leggiVenueClob },
    );
    if (verifica.illeggibili.length) {
      return NextResponse.json({
        ok: false, gate: 'venue-illeggibile',
        error: `${verifica.illeggibili.length} mercato/i del piano non è leggibile dal venue: non si piazzano ordini veri su un mercato che non si è potuto confermare`,
        illeggibili: verifica.illeggibili, placed: 0, refused: 0, skipped: parsed.data.rows.length, results: [],
      }, { status: 409 });
    }
    const righe = filtraRighe(parsed.data.rows, verifica.bocciati);
    if (!righe.length) {
      return NextResponse.json({
        ok: false, gate: 'nessun-mercato-valido',
        error: `tutti i ${verifica.bocciati.length} mercati del piano sono stati bocciati dal venue: non resta niente da piazzare`,
        esclusiDalVenue: verifica.bocciati, placed: 0, refused: 0, skipped: parsed.data.rows.length, results: [],
      }, { status: 409 });
    }

    const reset = await runAllocationReset(
      { rows: righe, dryRunOnly: preview },
      {
        readEnabled: () => readAutoRepriceConfig({}).enabledMarketIds || [],
        readTracking: () => readTrackingConfig().marketIds || [],
        listOrders: ({ marketId }: { marketId: string }) => listManualOrders({ marketId }),
        // La corsia cancel-only: signer di solo indirizzo, strutturalmente incapace di piazzare.
        // La sorgente è `manual-ui` e non una nuova: è vero — è l'operatore che agisce col bottone — e
        // MANUAL_SOURCES è un'allowlist di sicurezza che non vale la pena allargare per un'etichetta.
        // L'attribuzione precisa c'è comunque: ogni cancellazione finisce nell'audit del reset con
        // `op:'allocation-reset'`, marketId, orderId, prezzo e size.
        cancelOrder: ({ orderId, marketId }: { orderId: string; marketId: string }) =>
          cancelManualOrder({ orderId, marketId }, 'manual-ui'),
        setTrackingOff: ({ marketId, reason }: { marketId: string; reason: string }) =>
          setTracking({ marketId, enabled: false, by: 'operatore · reset allocazione', reason }),
        setEnabled: ({ marketId, enabled, reason }: { marketId: string; enabled: boolean; reason: string }) =>
          setAutoReprice({ scope: 'market', marketId, enabled, by: 'operatore · reset allocazione', reason }),
        setManual: ({ marketId, manual, reason }: { marketId: string; manual: boolean; reason: string }) =>
          setManualMode({ marketId, manual, by: 'operatore · reset allocazione', reason }),
        setAutoClose: ({ marketId, enabled, reason }: { marketId: string; enabled: boolean; reason: string }) =>
          setAutoClose({ scope: 'market', marketId, enabled, by: 'operatore · reset allocazione', reason }),
        // Illeggibile ⇒ l'uscita resta ACCESA: non si abbandona una posizione per un dato mancante.
        posizioneAperta: async ({ marketId }: { marketId: string }) => {
          try {
            const rules = resolveMarketRules(marketId) as unknown as { tokenId?: string; tokenIdNo?: string };
            const pos = await fetchVenuePositions() as { ok?: boolean; positions?: unknown[]; reason?: string };
            if (!pos || pos.ok !== true || !Array.isArray(pos.positions)) {
              return { leggibile: false, aperta: null, error: (pos && pos.reason) || 'posizioni non leggibili' };
            }
            const token = new Set([rules?.tokenId, rules?.tokenIdNo].filter(Boolean).map(String));
            const aperta = pos.positions.some((p) => {
              const q = p as { tokenId?: string; asset?: string; size?: number };
              const t = String(q.tokenId ?? q.asset ?? '');
              return !!t && token.has(t) && Number(q.size) > 0;
            });
            return { leggibile: true, aperta };
          } catch (e) { return { leggibile: false, aperta: null, error: (e as Error).message }; }
        },
        // La fase 4 è il ciclo di piazzamento di SEMPRE: stesso cap cumulativo, stesso rate limit,
        // stessi gate per riga. Il reset non apre una seconda strada verso il venue.
        placeBulk: ({ rows, dryRunOnly }: { rows: unknown[]; dryRunOnly: boolean }) =>
          runBulkAllocation(
            { rows: rows as never, dryRunOnly },
            {
              openNotionalUsd: diag.readable ? (diag.openNotionalUsd || 0) : 0,
              // Il ritiro di una gamba rimasta sola quando la sua controparte viene rifiutata. Le righe
              // che il pannello manda oggi non sono accoppiate, quindi non scatta mai; è cablata lo
              // stesso perché il giorno in cui il pannello manderà coppie, l'assenza di questa riga
              // sarebbe un'esposizione asimmetrica invece di un ripristino.
              cancelOrder: ({ orderId, marketId }: { orderId: string; marketId: string }) =>
                cancelManualOrder({ orderId, marketId }, 'manual-ui'),
            },
          ),
        audit: (rec: Record<string, unknown>) => { try { appendMakerAudit(rec); } catch { /* l'audit non blocca */ } },
      },
    );

    // Il referto del piazzamento resta in cima alla risposta, perché è la forma che il pannello legge
    // già oggi (placed/refused/skipped/results). Il resto del reset viaggia accanto, non al posto suo.
    const place = reset.piazzamento || { ok: reset.ok, placed: 0, refused: 0, skipped: 0, results: [], totals: null };
    return NextResponse.json({
      ...place,
      // Le esclusioni decise dal venue viaggiano SEMPRE nel referto, anche quando sono zero: «il piano
      // che hai confermato non è quello che è stato eseguito» non deve poter essere una scoperta.
      esclusiDalVenue: verifica.bocciati,
      ok: reset.ok && place.ok !== false,
      reset: {
        stoppedBy: reset.stoppedBy, reason: reset.reason, preview: reset.preview,
        inventario: reset.inventario, cancellazione: reset.cancellazione,
        spegnimento: reset.spegnimento, accensione: reset.accensione,
        log: reset.log,
      },
      openBefore: diag.openNotionalUsd,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, at: new Date().toISOString(), results: [], reason: 'la sequenza è fallita prima di completarsi' },
      { status: 500 },
    );
  }
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runBulkAllocation } from '@/lib/maker/bulk-allocate';
import { diagnoseExposure } from '@/lib/maker/manual-reset';
import { cancelManualOrder } from '@/lib/maker/manual-order';
import { isManualMarket, setManualMode } from '@/lib/maker/manual-mode';
import { setAutoReprice } from '@/lib/maker/auto-reprice-config';
import { setAutoClose } from '@/lib/maker/auto-close-config';
import { appendMakerAudit } from '@/lib/venues/polymarket-clob-maker/audit';
import { verificaMercatiAlVenue, filtraRighe, leggiVenueClob } from '@/lib/maker/verifica-mercati-venue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/maker/manual/place-market — LE DUE GAMBE DI UN MERCATO, DA UN SOLO GESTO DELL'OPERATORE.
 *
 * ═══ PERCHÉ ESISTE, E PERCHÉ NON È bulk-allocate ═══════════════════════════════════════════════════
 * Il percorso di piazzamento della tab Ottimizza chiedeva quattro gesti per un mercato: «1 · Anteprima»,
 * «+ Metti in coda», poi la conferma della gamba YES e quella della gamba NO nel pannello ordine. Quattro
 * conferme per UNA decisione non sono quattro protezioni: sono una decisione presa una volta e ribadita
 * tre, e l'unico effetto misurabile è che la terza e la quarta si premono senza rileggere.
 *
 * Questa rotta piazza le DUE GAMBE DI UN MERCATO SOLO, da una singola conferma esplicita mostrata
 * nell'interfaccia (il dialog che elenca mercato, capitale totale e le due gambe con prezzo e size).
 *
 * NON si è usata `/api/maker/manual/bulk-allocate` per una ragione precisa e grave: quella rotta, con
 * `preview:false`, passa da `runAllocationReset`, che porta lo stato del sistema a essere ESATTAMENTE il
 * piano ricevuto — cancella gli ordini a riposo sui mercati gestiti e spegne tutto ciò che non è nel
 * piano. Mandarle le due righe di un mercato solo significherebbe cancellare ogni altro ordine a riposo
 * dell'operatore. È il percorso giusto per «conferma ed esegui il piano intero», ed è quello sbagliato
 * per «piazza questo mercato».
 *
 * ═══ IL PIAZZAMENTO È COMUNQUE QUELLO DI SEMPRE ════════════════════════════════════════════════════
 * Non si apre nessuna seconda strada verso il venue. Si chiama `runBulkAllocation` — lo stesso ciclo che
 * il reset usa nella sua fase 4 — con le due righe, e quindi si ereditano, senza riscriverle:
 *   · il cap cumulativo valutato sulla COPPIA INTERA (non entra mezza coppia);
 *   · il RITIRO della gamba già piazzata se la controparte viene rifiutata (`rolled-back`);
 *   · il referto per gamba, con `orphan` quando anche il ritiro fallisce — cioè l'unico caso in cui
 *     resta davvero un'esposizione asimmetrica, e va nominata per orderId invece che riassunta;
 *   · e sotto, per ogni singola gamba, la catena di gate di `placeManualOrder`: proprietà manuale,
 *     venue-rules, cap per ordine, kill switch globale, la catena dell'adapter e infine la
 *     validateOrder() dell'exchange.
 *
 * `MANUAL_ORDER_PLACEMENT` continua a governare tutto: qualunque valore diverso dalla stringa esatta
 * 'send' rende il percorso una prova a vuoto. Questa rotta non lo legge e non lo aggira.
 *
 * ═══ LE QUATTRO SCRITTURE CHE DEVONO PRECEDERE L'ORDINE ════════════════════════════════════════════
 * Un mercato che riceve ordini deve già essere: nel catalogo, in gestione manuale (altrimenti agent35
 * scrive sullo stesso libro), nella allowlist, e con l'USCITA AUTOMATICA accesa — «un mercato che può
 * ricevere ordini ha già una via d'uscita» è una garanzia del reset che questo percorso non può
 * perdere. La coda le faceva al momento dell'inserimento, chiamando `/api/maker/markets/enable`; qui
 * vengono fatte nello stesso gesto, subito prima del piazzamento, con gli STESSI setter.
 *
 * Se una di queste fallisce NON SI PIAZZA. Un mercato preparato a metà è un rifiuto rimandato al punto
 * in cui costa di più.
 *
 * `preview: true` non scrive niente e non piazza niente: verifica il venue, rilegge lo stato e riporta
 * cosa verrebbe scritto. È ciò che alimenta il riepilogo del dialog.
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
  coppia: z.string().trim().min(1).max(200).optional(),
  gamba: z.enum(['yes', 'no']).optional(),
  // ── `inCoda` VA DICHIARATO, ALTRIMENTI ZOD LO TOGLIE ────────────────────────────────────────────
  // `gambeDiUnaRiga` mette `inCoda: true` su ogni riga che produce: è la richiesta esplicita di NON
  // finire primi sul libro — `placeManualOrder` legge quel campo e sposta il prezzo un tick dietro al
  // miglior prezzo altrui (lib/maker/prezzo-in-coda.js), fermandosi al bordo della banda se i due
  // vincoli si contraddicono.
  //
  // zod scarta le chiavi che non dichiara. Non elencarlo qui vorrebbe dire ricevere una riga che
  // chiede di stare in coda e inoltrarla come se non lo avesse chiesto — cioè cambiare in silenzio il
  // prezzo a cui il capitale va a riposare. È esattamente il difetto che lo schema di bulk-allocate
  // documenta per `coppia`/`gamba`, e vale identico qui.
  inCoda: z.boolean().optional(),
});

const bodySchema = z.object({
  marketId: z.string().trim().min(1).max(200),
  // DUE gambe, non una e non tre. Una gamba sola non si piazza mai: fuori dal range [0,10–0,90] matura
  // zero e dentro un terzo, col capitale comunque impegnato. Il limite è nello schema perché un errore
  // di forma non deve poter diventare un'esposizione asimmetrica.
  rows: z.array(rowSchema).length(2),
  preview: z.boolean().optional(),
  /** Il montepremi che la card mostrava quando l'operatore ha deciso. Serve al guardiano del venue. */
  potAtPlan: z.number().finite().nonnegative().optional(),
  /** Da quale profilo viene la proposta. È SOLO un'etichetta d'audit: non cambia un gate né un gate. */
  profile: z.enum(['safe', 'risk']).optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, gate: 'invalid-body', detail: parsed.error.flatten() }, { status: 400 });
  }
  const { marketId, rows, potAtPlan } = parsed.data;
  const preview = parsed.data.preview === true;
  const profile = parsed.data.profile || 'safe';

  // Le due righe devono parlare dello STESSO mercato di `marketId`, e devono essere le due gambe opposte.
  const mid = marketId.trim().toLowerCase();
  if (!rows.every((r) => r.marketId.trim().toLowerCase() === mid)) {
    return NextResponse.json({ ok: false, gate: 'righe-di-un-altro-mercato', error: 'le righe non appartengono tutte al mercato indicato' }, { status: 400 });
  }
  const libri = new Set(rows.map((r) => r.book));
  if (libri.size !== 2) {
    return NextResponse.json({ ok: false, gate: 'gambe-non-opposte', error: 'servono esattamente una gamba sul libro YES e una sul libro NO' }, { status: 400 });
  }

  // L'APPARTENENZA ALLA COPPIA È OBBLIGATORIA QUI. È ciò che fa scattare, dentro runBulkAllocation, il
  // cap sulla coppia intera e il ritiro della gamba orfana. Senza, le protezioni ci sarebbero tutte e
  // nessuna potrebbe scattare — il difetto che lo schema di bulk-allocate documenta.
  const righe = rows.map((r) => ({ ...r, coppia: r.coppia || mid, gamba: r.gamba || r.book }));
  const capitaleTotaleUsd = +righe.reduce((s, r) => s + r.price * r.size, 0).toFixed(2);

  try {
    // ── 1. IL MERCATO È ANCORA QUELLO SU CUI LA PROPOSTA È STATA DECISA? ──────────────────────────
    // Si chiede al VENUE, non alla cache da cui la card è nata. Vale in anteprima e in esecuzione, così
    // l'esclusione si vede PRIMA di confermare invece di scoprirla dopo.
    const verifica = await verificaMercatiAlVenue(
      { rows: righe, poolAlPiano: potAtPlan != null ? { [mid]: potAtPlan } : {}, nowMs: Date.now() },
      { readVenue: leggiVenueClob },
    );
    if (verifica.illeggibili.length) {
      return NextResponse.json({
        ok: false, gate: 'venue-illeggibile',
        error: 'il mercato non è leggibile dal venue: non si piazzano ordini veri su un mercato che non si è potuto confermare',
        illeggibili: verifica.illeggibili, placed: 0, refused: 0, skipped: righe.length, results: [],
      }, { status: 409 });
    }
    if (!filtraRighe(righe, verifica.bocciati).length) {
      return NextResponse.json({
        ok: false, gate: 'bocciato-dal-venue',
        error: 'il venue ha bocciato questo mercato: la proposta non è più quella su cui è stata presa la decisione',
        esclusiDalVenue: verifica.bocciati, placed: 0, refused: 0, skipped: righe.length, results: [],
      }, { status: 409 });
    }

    // ── LA PROPRIETÀ MANUALE, LETTA COME LA LEGGE IL GATE ─────────────────────────────────────────
    // `isManualMarket` FALLISCE CHIUSO: se lo stato non è leggibile risponde `manual:true` con
    // `readable:false`, cioè «tratta ogni mercato come manuale» perché la proprietà non si è potuta
    // stabilire. Leggere solo `.manual` scambierebbe quel fallimento per «è già nostro» e si
    // proseguirebbe verso il piazzamento su una proprietà mai verificata. Quindi: non leggibile ⇒ non
    // si piazza, e lo si dice.
    const proprieta = isManualMarket(marketId);
    if (proprieta.readable !== true) {
      return NextResponse.json({
        ok: false, gate: 'proprieta-non-leggibile',
        error: `lo stato di gestione manuale non è leggibile (${proprieta.error || 'motivo non riportato'}): non si piazza su un mercato la cui proprietà non si è potuta stabilire`,
        placed: 0, refused: 0, skipped: righe.length, results: [],
      }, { status: 409 });
    }
    const giaManuale = proprieta.manual === true;

    // ── ANTEPRIMA: NIENTE SCRITTURE, NIENTE ORDINI ────────────────────────────────────────────────
    if (preview) {
      const diagP = diagnoseExposure({});
      return NextResponse.json({
        ok: true, preview: true, marketId, profile,
        capitaleTotaleUsd,
        gambe: righe.map((r) => ({ book: r.book, side: r.side || 'BUY', price: r.price, size: r.size, notionalUsd: +(r.price * r.size).toFixed(2) })),
        preparazione: {
          giaInGestioneManuale: giaManuale,
          scritture: giaManuale
            ? ['allowlist (riconferma)', 'uscita automatica (riconferma)']
            : ['gestione manuale', 'allowlist', 'uscita automatica'],
        },
        esclusiDalVenue: verifica.bocciati,
        openBefore: diagP.readable ? diagP.openNotionalUsd : null,
        placed: 0, refused: 0, skipped: 0, results: [],
      });
    }

    // ── 2. LA PREPARAZIONE. Se una fallisce, non si piazza. ───────────────────────────────────────
    const motivo = `conferma a un tocco dalla tab ${profile === 'risk' ? 'Risk' : 'Ottimizza'}: il mercato viene preparato nello stesso gesto che piazza`;
    const preparazione: Array<{ passo: string; ok: boolean; detail?: string }> = [];
    const passo = async (nome: string, fn: () => unknown) => {
      try { const r = await fn(); const ok = r !== false && !(r && typeof r === 'object' && (r as { ok?: boolean }).ok === false);
        preparazione.push({ passo: nome, ok }); return ok; }
      catch (e) { preparazione.push({ passo: nome, ok: false, detail: (e as Error).message }); return false; }
    };

    // L'USCITA PRIMA DELL'INGRESSO: un mercato che può ricevere ordini ha già una via d'uscita.
    let pronto = await passo('uscita automatica', () => setAutoClose({ scope: 'market', marketId, enabled: true, by: 'operatore · conferma a un tocco', reason: motivo }));
    if (pronto && !giaManuale) {
      pronto = await passo('gestione manuale', () => setManualMode({ marketId, manual: true, by: 'operatore · conferma a un tocco', reason: motivo }));
      // LA VERIFICA È SUL FATTO RILETTO, non sull'esito della scrittura: è lo stesso flag che il gate
      // leggerà fra un istante, e un ok:true senza il fatto vero non basta.
      if (pronto) pronto = await passo('gestione manuale · rilettura', () => {
        const v = isManualMarket(marketId);
        return v.readable === true && v.manual === true;
      });
    }
    if (pronto) pronto = await passo('allowlist', () => setAutoReprice({ scope: 'market', marketId, enabled: true, by: 'operatore · conferma a un tocco', reason: motivo }));

    if (!pronto) {
      try { appendMakerAudit({ op: 'place-market', esito: 'preparazione-fallita', marketId, profile, preparazione, at: new Date().toISOString() }); } catch { /* l'audit non blocca */ }
      return NextResponse.json({
        ok: false, gate: 'preparazione-fallita',
        error: 'il mercato non è stato preparato del tutto: NESSUN ordine è stato inviato. Un mercato preparato a metà è un rifiuto rimandato.',
        preparazione, placed: 0, refused: 0, skipped: righe.length, results: [],
      }, { status: 409 });
    }

    // ── 3. IL PIAZZAMENTO — il ciclo di sempre, con le due gambe come un'unità. ────────────────────
    const diag = diagnoseExposure({});
    // Il referto di runBulkAllocation, tipizzato qui perché il modulo è JS senza .d.ts e l'inferenza
    // perde `rolledBack`/`orphan` — che sono proprio i due esiti che questa rotta deve saper nominare.
    type EsitoBulk = {
      ok?: boolean; placed?: number; refused?: number; skipped?: number;
      rolledBack?: number; orphan?: number;
      results?: Array<Record<string, unknown>>;
      stoppedBy?: string | null; reason?: string | null;
    };
    const esito = (await runBulkAllocation(
      { rows: righe as never, dryRunOnly: false },
      {
        openNotionalUsd: diag.readable ? (diag.openNotionalUsd || 0) : 0,
        cancelOrder: ({ orderId, marketId: m }: { orderId: string; marketId: string }) => cancelManualOrder({ orderId, marketId: m }, 'manual-ui'),
      },
    )) as EsitoBulk;

    try {
      appendMakerAudit({
        op: 'place-market', marketId, profile, capitaleTotaleUsd,
        placed: esito.placed, refused: esito.refused, rolledBack: esito.rolledBack ?? 0, orphan: esito.orphan ?? 0,
        at: new Date().toISOString(),
      });
    } catch { /* l'audit non blocca */ }

    // ── IL REFERTO PER GAMBA, ESPLICITO ───────────────────────────────────────────────────────────
    // «Se una gamba fallisce dopo che l'altra è già passata, si deve vedere QUALE è andata e quale no».
    // I tre esiti che non sono «tutto bene» sono diversi fra loro e non vanno riassunti in uno:
    //   placed      sul libro
    //   rolled-back piazzata e poi RITIRATA perché la controparte è stata rifiutata: NON è esposizione
    //   orphan      piazzata, la controparte è stata rifiutata, e il ritiro NON è riuscito: esposizione
    //               asimmetrica VERA, da guardare a mano — l'orderId è nel referto
    const perGamba = (esito.results || []).map((r) => ({
      book: r.book ?? r.gamba ?? null,
      status: r.status,
      orderId: r.orderId ?? null,
      price: r.price ?? null,
      size: r.size ?? null,
      notionalUsd: r.notionalUsd ?? null,
      reason: r.reason ?? r.gate ?? null,
    }));
    const orfane = perGamba.filter((g: { status: unknown }) => g.status === 'orphan');

    return NextResponse.json({
      ...esito,
      marketId, profile, capitaleTotaleUsd,
      preparazione,
      perGamba,
      // La frase che l'interfaccia mostra senza doverla comporre: lo stato non deve essere una deduzione.
      statoLeggibile: orfane.length
        ? `ESPOSIZIONE ASIMMETRICA: ${orfane.length} gamba/e è rimasta sul libro da sola e il ritiro non è riuscito. Va cancellata a mano.`
        : esito.placed === 2 ? 'entrambe le gambe sono sul libro'
          : (esito.rolledBack ?? 0) > 0 ? 'una gamba è stata rifiutata: quella già piazzata è stata RITIRATA, non resta esposizione'
            : esito.placed === 0 ? 'nessuna gamba è stata piazzata'
              : `${esito.placed} gamba/e piazzata/e su 2`,
      esclusiDalVenue: verifica.bocciati,
      openBefore: diag.readable ? diag.openNotionalUsd : null,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false, error: (e as Error).message, at: new Date().toISOString(), results: [],
      reason: 'il piazzamento è fallito prima di completarsi: lo stato del mercato va verificato a mano',
    }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/freno-prova — agent41 sta piazzando davvero, o è in prova?
 *
 * SOLA LETTURA. Non importa nessuna superficie di piazzamento e non interroga il venue: legge il file
 * che agent41 scrive all'avvio (`data/freno-prova.json`).
 *
 * PERCHÉ UN FILE E NON L'AMBIENTE. Il freno vive in `REALLOC_SCHEDULER_DRY_RUN`, che sta
 * nell'ambiente del PROCESSO agent41. Il dashboard è un altro processo e quella variabile non ce
 * l'ha: leggere il PROPRIO `process.env` darebbe una risposta plausibile e sbagliata — esattamente il
 * genere di errore che questo pannello esiste per non fare più. Quindi la fonte è ciò che agent41 ha
 * dichiarato di sé.
 *
 * FAIL-CLOSED ANCHE QUI: file assente, illeggibile o malformato ⇒ si risponde «sconosciuto», mai
 * «freno disinserito». Fra i due errori possibili, dire «è in prova» quando piazza è quello che ha
 * già ingannato una persona per due giorni.
 */
export async function GET() {
  const file = path.join(process.cwd(), 'data', 'freno-prova.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const attivo = raw?.attivo === true;
    // ── IL TETTO IN VIGORE, E DA QUALE CAPITALE NASCE ──────────────────────────────────────────
    // Dal 12 agosto 2026 il tetto per mercato non e' piu' una costante: e' derivato dal capitale.
    // L'operatore deve poter vedere quale valore e' in vigore ADESSO senza leggere il codice, ed e'
    // la stessa domanda del freno — «in che regime sta girando agent41» — quindi sta nella stessa
    // risposta invece che in una rotta nuova.
    let tetto: Record<string, unknown> | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const CO = require('@/lib/rewards/concentration');
      const capRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'maker-allocated-capital.json'), 'utf8'));
      const capitale = Number(capRaw?.capital);
      const t = CO.capPerMarketUsd(Number.isFinite(capitale) ? capitale : null);
      const f = CO.finestraMid(Number.isFinite(capitale) ? capitale : null);
      tetto = {
        capitaleUsd: Number.isFinite(capitale) ? capitale : null,
        perMercatoUsd: t, perLatoUsd: +(t / 2).toFixed(2),
        perOrdineUsd: CO.liveMinOrderCapUsd(Number.isFinite(capitale) ? capitale : null),
        mercatiSostenibili: CO.mercatiSostenibili(Number.isFinite(capitale) ? capitale : null),
        fMinObiettivo: CO.F_MIN_OBIETTIVO, maxMercati: CO.MAX_MERCATI,
        finestraMid: [f.lo, f.hi],
        derivato: true,
      };
    } catch { tetto = null; }
    const etaMs = raw?.atIso ? Date.now() - Date.parse(raw.atIso) : null;
    return NextResponse.json({
      ok: true,
      conosciuto: typeof raw?.attivo === 'boolean',
      attivo,
      valore: raw?.valore ?? null,
      riconosciuto: raw?.riconosciuto === true,
      motivo: raw?.motivo ?? null,
      agente: raw?.agente ?? null,
      pid: raw?.pid ?? null,
      atIso: raw?.atIso ?? null,
      etaMs,
      // L'etichetta che il pannello mostra, decisa QUI: due componenti che se la inventano ciascuna
      // per conto suo sono due modi di dire cose diverse sullo stesso fatto.
      etichetta: attivo ? 'IN PROVA' : 'PIAZZA DAVVERO',
      tetto,
    });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      conosciuto: false,
      attivo: null,
      motivo: `stato del freno non leggibile (${(e as Error).message}): agent41 non l'ha ancora dichiarato`,
      etichetta: 'SCONOSCIUTO',
    });
  }
}

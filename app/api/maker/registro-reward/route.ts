import { NextResponse } from 'next/server';
// Modulo JS senza `.d.ts`: `allowJs` lo risolve da sé, e la vista è costruita interamente lì —
// qui non c'è logica da tipizzare.
import { costruisciRegistro } from '@/lib/maker/registro-reward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/registro-reward — QUANTO ABBIAMO DAVVERO INCASSATO.
 *
 * SOLA LETTURA, e non solo per convenzione: questa rotta non importa nessuna superficie di piazzamento
 * o di cancellazione. Legge `data/confronto-reward.json` — che è già il registro persistente, scritto
 * ogni notte da agent40 — e ne restituisce la vista con i totali e lo scarto stimato↔reale.
 *
 * NON RICALCOLA NIENTE e non interroga il venue: se una giornata non è consuntivata la riga lo dice con
 * il suo motivo, invece di andare a cercare il dato adesso. Il recupero a ritroso è un compito di
 * agent40, che ha l'orologio giusto per farlo; una rotta che lo facesse a ogni apertura del pannello
 * trasformerebbe una lettura in una chiamata di rete.
 */
export async function GET() {
  try {
    const r = costruisciRegistro({});
    return NextResponse.json({ ok: true, at: new Date().toISOString(), ...r });
  } catch (e) {
    // FAIL HONEST: un registro illeggibile si dichiara. Restituire zero sarebbe indistinguibile da
    // «non abbiamo incassato niente», che è la cosa peggiore da dire su questa specifica domanda.
    return NextResponse.json(
      { ok: false, error: (e as Error).message, giorni: [], totali: null },
      { status: 500 },
    );
  }
}

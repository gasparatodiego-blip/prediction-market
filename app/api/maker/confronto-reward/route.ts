import { NextResponse } from 'next/server';
import { leggiConfronto, ORA_STIMA, ORE_REALE, TENTATIVI_MAX } from '@/lib/maker/confronto-reward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/confronto-reward — la stima del bot contro il consuntivo del venue, giorno per giorno.
 *
 * ═══ COSA RISPONDE ═══════════════════════════════════════════════════════════════════════════════════
 * «La stima di $/giorno che il pannello mostra è vera?» Fino a oggi non c'era modo di saperlo senza
 * guardare il portafoglio a mano: una stima mai confrontata col consuntivo può restare sbagliata di un
 * ordine di grandezza per settimane.
 *
 * SOLA LETTURA. Legge il file che agent40 scrive ai suoi due controlli orari (23:55 e 00:20 UTC) e non
 * chiama nessun venue: la chiamata al venue la fa agent40, con le credenziali L2 e in sola lettura.
 * Questa rotta non ha credenziali e non ne ha bisogno.
 *
 * ═══ «NON DISPONIBILE» RESTA DISTINTO DA ZERO ════════════════════════════════════════════════════════
 * Una giornata in cui il venue non ha consolidato in tempo esce con `realeDisponibile: false` e il
 * motivo, MAI con `realeUsd: 0`. Lo scarto su quelle giornate è `null`, e la media di precisione le
 * esclude: una media che le contasse racconterebbe una precisione che non è stata misurata.
 *
 * Admin-gated by middleware (ADMIN_ACCESS_SECRET), come tutto /api/maker.
 */
export async function GET() {
  try {
    const c = leggiConfronto();
    return NextResponse.json({
      at: new Date().toISOString(),
      // Gli orari sono dichiarati perché chi legge sappia QUANDO le due cifre sono state prese: una
      // stima delle 23:55 e un consuntivo delle 00:20 descrivono la stessa giornata UTC.
      orari: {
        stimaUtc: `${String(ORA_STIMA.h).padStart(2, '0')}:${String(ORA_STIMA.m).padStart(2, '0')}`,
        realeUtc: ORE_REALE.map((o) => `${String(o.h).padStart(2, '0')}:${String(o.m).padStart(2, '0')}`),
        tentativiMax: TENTATIVI_MAX,
      },
      scartoMedioPct: c.scartoMedioPct,
      giorniConfrontabili: c.giorniConfrontabili,
      count: c.count,
      giorni: c.giorni,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, giorni: [], count: 0 },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

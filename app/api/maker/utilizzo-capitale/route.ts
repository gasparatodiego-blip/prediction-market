import { NextResponse } from 'next/server';
import { leggiSaldoUsd } from '@/lib/maker/saldo-cache';
import { listManualOrders } from '@/lib/maker/manual-order';
import { readVenuePositions } from '@/lib/safety/venue-positions-snapshot';
import { misuraUtilizzo, formattaUtilizzo, nozionaleARiposo, valorePosizioni, TARGET_UTILIZZO } from '@/lib/maker/utilizzo-capitale';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/utilizzo-capitale — QUANTO DEL CAPITALE STA DAVVERO LAVORANDO, ADESSO.
 *
 * PERCHE' ESISTE. Il bot ha sempre avuto tetti — 20% per mercato, 12% sulla coda lunga, un muro a 150
 * giorni — cioe' regole che dicono dove NON mettere il capitale. Non aveva la misura simmetrica: quanta
 * parte del capitale e' impegnata. Senza quel numero, «il conto e' rimasto fermo per ore» resta
 * un'impressione che nessuna soglia trasforma in un fatto. Questa rotta e' quel numero.
 *
 * LE TRE FONTI, E SONO LE STESSE CHE USA IL BOT — non una seconda lettura che possa dire un numero
 * diverso da quella su cui il trigger decide:
 *   · saldo pUSD          lib/maker/saldo-cache      (on-chain, cache 45 s)
 *   · ordini a riposo     listManualOrders           (il venue, sola lettura)
 *   · posizioni aperte    lo snapshot di agent40     (venue-positions-snapshot, scade a 180 s)
 * Lo snapshot e non una lettura fresca del data-api proprio perche' e' la fonte che legge anche
 * `agent41`: dashboard e audit devono poter mostrare lo stesso numero, non due stime dello stesso fatto.
 *
 * NON MISURABILE NON E' ZERO. Se una delle tre fonti non risponde, la rotta dichiara `leggibile:false`
 * con il motivo e NON pubblica una percentuale. Un saldo illeggibile trattato come zero direbbe
 * «utilizzo 100%» esattamente quando il capitale e' fermo e nessuno se ne accorge: e' il difetto
 * peggiore che una misura del genere possa avere, ed e' la ragione per cui questa rotta preferisce
 * tacere.
 *
 * SOLA LETTURA. Non piazza, non cancella, non arma, non scrive nessun file. Il target NON e' un
 * permesso e non compare in nessuna decisione di piazzamento: tutti i tetti restano davanti a lui.
 *
 * Admin-gated dal middleware (ADMIN_ACCESS_SECRET).
 */
export async function GET() {
  const at = new Date().toISOString();
  try {
    // Le tre letture in parallelo: sono indipendenti, e in serie la rotta costerebbe la loro somma.
    const [saldo, ordini, pos] = await Promise.all([
      leggiSaldoUsd().catch((e: unknown) => ({ usd: null, affidabile: false, errore: (e as Error).message })),
      listManualOrders({}).catch((e: unknown) => ({ ok: false, error: (e as Error).message, orders: [] })),
      Promise.resolve().then(() => readVenuePositions()).catch((e: unknown) => ({ readable: false, reason: (e as Error).message, positions: [] })),
    ]);

    const saldoUsd = saldo && (saldo as { affidabile?: boolean }).affidabile === true
      ? Number((saldo as { usd: number }).usd) : null;
    const ordiniOk = ordini && (ordini as { ok?: boolean }).ok !== false;
    const ordiniARiposoUsd = ordiniOk ? nozionaleARiposo((ordini as { orders?: unknown[] }).orders || []) : null;
    const posOk = pos && (pos as { readable?: boolean }).readable === true;
    const posizioniUsd = posOk ? valorePosizioni((pos as { positions?: unknown[] }).positions || []) : null;

    const u = misuraUtilizzo({ saldoUsd, ordiniARiposoUsd, posizioniUsd });

    return NextResponse.json({
      ok: true, at,
      utilizzo: u,
      riga: formattaUtilizzo(u),
      target: TARGET_UTILIZZO,
      // LE FONTI, CIASCUNA COL SUO STATO. Serve a rispondere a «perche' non e' misurabile» senza
      // dover aprire i log: una delle tre righe qui sotto dira' di no, e dira' perche'.
      fonti: {
        saldo: {
          leggibile: saldoUsd != null, usd: saldoUsd,
          motivo: saldoUsd != null ? null : ((saldo as { errore?: string }).errore || 'saldo non affidabile'),
        },
        ordiniARiposo: {
          leggibile: ordiniARiposoUsd != null, usd: ordiniARiposoUsd,
          conteggio: ordiniOk ? ((ordini as { orders?: unknown[] }).orders || []).length : null,
          motivo: ordiniARiposoUsd != null ? null
            : (ordiniOk ? 'un ordine ha prezzo o size illeggibili: il totale sarebbe una sottostima silenziosa'
              : ((ordini as { error?: string }).error || 'lettura degli ordini fallita')),
        },
        posizioni: {
          leggibile: posizioniUsd != null, usd: posizioniUsd,
          conteggio: posOk ? ((pos as { positions?: unknown[] }).positions || []).length : null,
          etaMs: (pos as { ageMs?: number }).ageMs ?? null,
          motivo: posizioniUsd != null ? null
            : (posOk ? 'una posizione è senza prezzo corrente: il totale resta ignoto'
              : `snapshot posizioni non leggibile (${(pos as { reason?: string }).reason || 'ignoto'}) — lo scrive agent40 a ogni ciclo`),
        },
      },
      nota: u.leggibile
        ? (u.raggiunto
          ? 'Obiettivo raggiunto. Il target non autorizza nulla: tutti i tetti (20% per mercato, 12% coda lunga, muro orizzonte, rampa) restano davanti a lui.'
          : 'Sotto obiettivo. Il deficit è quanto capitale si potrebbe ancora mettere al lavoro SE esistono mercati validi: quando non esistono, restare sotto è la risposta giusta, non un guasto.')
        : 'Non misurabile: una percentuale inventata su una fonte muta sarebbe peggio di nessuna percentuale.',
    });
  } catch (e) {
    return NextResponse.json({ ok: false, at, error: (e as Error).message, utilizzo: null }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/watch-21 — quello che i 21 maker del manuale v2 stanno facendo ADESSO.
 *
 * SOLA LETTURA, E DI SOLI FILE. Legge i quattro file che agent42-watch-makers scrive e non parla con
 * nessun venue, non tiene nessuna chiave, non costruisce nessun ordine. È l'unico consumatore di
 * quei file lato dashboard, e nessun processo che piazza ordini li legge: il segnale resta
 * informativo per costruzione, non per disciplina.
 *
 * Il giornale è append-only e cresce; questa route ne legge solo la CODA (ultimi TAIL_BYTES), perché
 * la domanda a cui risponde è «cosa è successo nelle ultime ore», non «tutto lo storico». Il
 * consuntivo completo sta in maker-21-statistiche.json, che l'agente rigenera dall'intero giornale.
 */

const DATA_DIR = path.join(process.cwd(), 'data');
const TAIL_BYTES = 512 * 1024;
const FINESTRA_INGRESSI_H = 24;   // «ultimi ingressi»
const FINESTRA_CONV_H = 12;       // «convergenze attive»: una convergenza di ieri non è più un invito

type Evento = Record<string, unknown> & { tipo?: string; ts?: number; tsMs?: number };

function leggiJson<T>(nome: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, nome), 'utf8')) as T; }
  catch { return fallback; }
}

/**
 * La coda del giornale. Si legge dal fondo un blocco fisso e si BUTTA la prima riga: leggendo da un
 * offset arbitrario quella riga è quasi sempre tagliata a metà, e una riga tagliata a metà è un
 * evento inventato. Meglio perderne una vera che pubblicarne una falsa.
 */
function codaEventi(): Evento[] {
  let fd: number | null = null;
  try {
    const p = path.join(DATA_DIR, 'maker-21-eventi.jsonl');
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, len, start);
    const righe = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) righe.shift();
    const out: Evento[] = [];
    for (const r of righe) { try { out.push(JSON.parse(r) as Evento); } catch { /* riga tronca */ } }
    return out;
  } catch {
    return [];
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignora */ } }
  }
}

export async function GET() {
  const oraS = Math.floor(Date.now() / 1000);
  const eventi = codaEventi();
  const stato = leggiJson<Record<string, unknown>>('maker-21-stato.json', {});
  const stats = leggiJson<Record<string, unknown>>('maker-21-statistiche.json', {});
  const roster = leggiJson<{ wallet?: Array<{ nome: string }> }>('maker-21-roster.json', {});

  const daFinestra = (e: Evento, ore: number) => typeof e.ts === 'number' && oraS - e.ts <= ore * 3600;

  const ingressi = eventi
    .filter((e) => e.tipo === 'ingresso' && daFinestra(e, FINESTRA_INGRESSI_H))
    .sort((a, b) => (b.ts as number) - (a.ts as number))
    .slice(0, 40);

  // Una convergenza si tiene per il suo `n` PIÙ ALTO: l'agente riemette quando arriva un partecipante
  // in più, e mostrare sia «n=2» sia «n=3» sullo stesso mercato sarebbe due volte la stessa notizia.
  const perMercato = new Map<string, Evento>();
  for (const e of eventi) {
    if (e.tipo !== 'convergenza' || !daFinestra(e, FINESTRA_CONV_H)) continue;
    const cid = String(e.conditionId ?? '');
    const gia = perMercato.get(cid);
    if (!gia || Number(e.n ?? 0) > Number(gia.n ?? 0)) perMercato.set(cid, e);
  }
  const convergenze = Array.from(perMercato.values())
    .sort((a, b) => Number(b.n ?? 0) - Number(a.n ?? 0) || (b.ts as number) - (a.ts as number));

  const ritiri = eventi
    .filter((e) => e.tipo === 'ritiro' && daFinestra(e, 48))
    .sort((a, b) => (b.ts as number) - (a.ts as number))
    .slice(0, 20);

  const buchi = eventi.filter((e) => e.tipo === 'buco' && daFinestra(e, 48));

  const ultimoGiroMs = Number(stato.ultimoGiroMs ?? 0) || null;

  return NextResponse.json({
    at: new Date().toISOString(),
    // ── SALUTE DEL MONITOR. Una sezione che mostra «0 ingressi» senza dire se il processo è vivo sta
    //    mentendo per omissione: zero-perché-calmo e zero-perché-morto si vedono identici.
    monitor: {
      attivo: ultimoGiroMs != null && Date.now() - ultimoGiroMs < 5 * 60_000,
      ultimoGiroMs,
      etaGiroSec: ultimoGiroMs ? Math.round((Date.now() - ultimoGiroMs) / 1000) : null,
      giri: stato.giri ?? null,
      durataGiroMs: stato.ultimoGiroDurataMs ?? null,
      latenzaGiroMedianaMs: stato.latenzaGiroMedianaMs ?? null,
      latenzaAttesaMedianaS: stato.latenzaAttesaMedianaS ?? null,
      retiFallite: stato.retiFallite ?? null,
      wallet: stato.wallet ?? roster.wallet?.length ?? null,
      avviatoMs: stato.avviatoMs ?? null,
      buchi: buchi.length,
      fonte: 'data-api /trades?user= · nessun ordine, nessuna firma, sola lettura',
    },
    finestre: { ingressiOre: FINESTRA_INGRESSI_H, convergenzeOre: FINESTRA_CONV_H },
    ingressi,
    convergenze,
    ritiri,
    buchi,
    statistiche: stats,
  });
}

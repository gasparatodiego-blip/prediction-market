import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
// Sola lettura. Questo modulo espone `fetchMarketByConditionId`, che fa una GET verso Gamma e basta:
// non costruisce, non firma e non piazza nulla. Nessun import qui raggiunge l'adattatore di piazzamento.
import { fetchMarketByConditionId, isConditionId } from '@/lib/maker/market-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/quote?marketId=0x… — LA QUOTAZIONE PIÙ FRESCA DISPONIBILE per UN mercato.
 *
 * PERCHÉ ESISTE. Il pannello di piazzamento mostrava mid/bid/ask ereditati dalla card che l'aveva
 * aperto, cioè uno snapshot preso quando quella lista era stata riempita. Per un mercato del board
 * reward voleva dire fino a 20 secondi di ritardo; per un mercato trovato con la ricerca — e i
 * «Bitcoin Up or Down» non hanno montepremi, quindi passano sempre da lì — voleva dire il valore
 * congelato all'istante della ricerca, che non veniva mai ripetuta. Due aperture a un minuto di
 * distanza mostravano lo stesso identico centesimo perché era letteralmente lo stesso numero.
 *
 * DUE FONTI, IN ORDINE DI FRESCHEZZA, E OGNUNA DICE IL PROPRIO NOME:
 *   1. il book live di agent34 (/tmp/clob-live-books.json) — websocket sul canale market del CLOB,
 *      età tipica in millisecondi. Copre i mercati del board reward più quelli abilitati
 *      dall'operatore: agent34 è sottoscritto a quelli, non a tutto Polymarket.
 *   2. Gamma /markets?condition_ids=… — una GET, per i mercati che agent34 non segue.
 *
 * La risposta porta SEMPRE `source` e `ageMs`, perché «quanto è vecchio questo prezzo» è parte del
 * prezzo: un mid di due minuti su un ciclo da cinque non è lo stesso fatto di un mid di 9 millisecondi,
 * e il pannello deve poterlo scrivere a schermo invece di far fidare l'operatore alla cieca.
 *
 * UN CAMPO CHE LA FONTE NON PUBBLICA TORNA `null`, MAI UN VALORE DI RIPIEGO. Il book live non porta il
 * tick (è una regola di venue, non un dato di mercato): da quel percorso `tick` è null, e sta al
 * chiamante tenersi quello che già conosce da una fonte che il tick lo pubblica. Un null qui significa
 * «questa fonte non lo dice», non «vale zero».
 *
 * Gated dal middleware come tutto /api/maker (ADMIN_ACCESS_SECRET).
 */

const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';

interface Side { live?: boolean; ageMs?: number | null; bestBid?: number | null; bestAsk?: number | null; adjustedMid?: number | null }
interface BookEntry {
  title?: string | null; live?: boolean; ageMs?: number | null;
  mid?: number | null; plainMid?: number | null; minSize?: number | null; maxSpread?: number | null;
  source?: string | null; yes?: Side; no?: Side;
}
interface BooksFile { generatedAt?: string; staleMs?: number; markets?: Record<string, BookEntry> }

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r3 = (x: number | null | undefined): number | null => (fin(x) ? Math.round(x * 1000) / 1000 : null);

function readBooks(): BooksFile | null {
  try { return JSON.parse(fs.readFileSync(LIVE_BOOKS_FILE, 'utf8')) as BooksFile; } catch { return null; }
}

/** Lo spread in centesimi dal tocco, calcolato solo se ENTRAMBI i lati esistono. */
function spreadFrom(bid: number | null, ask: number | null): number | null {
  if (!fin(bid) || !fin(ask)) return null;
  return Math.round((ask - bid) * 100 * 1000) / 1000;
}

export async function GET(req: NextRequest) {
  const marketId = (req.nextUrl.searchParams.get('marketId') || '').trim();
  const at = new Date().toISOString();
  if (!isConditionId(marketId)) {
    return NextResponse.json({ ok: false, at, error: 'marketId non valido (atteso 0x + 64 esadecimali)', quote: null }, { status: 400 });
  }

  // ── 1 · IL BOOK LIVE ─────────────────────────────────────────────────────────────────────────────
  const books = readBooks();
  const entry = books?.markets?.[marketId] ?? books?.markets?.[marketId.toLowerCase()] ?? null;
  if (entry) {
    // Il lato YES è il book su cui il pannello quota; `mid` sull'entry è già quello corretto che il
    // resto della pipeline usa per giudicare la banda, quindi è lo stesso numero — non un secondo
    // modello che potrebbe divergere da quello del board.
    const yes = entry.yes ?? {};
    const bid = fin(yes.bestBid) ? (yes.bestBid as number) : null;
    const ask = fin(yes.bestAsk) ? (yes.bestAsk as number) : null;
    const mid = fin(entry.mid) ? (entry.mid as number) : (fin(yes.adjustedMid) ? (yes.adjustedMid as number) : null);
    // L'età del LATO, non quella del file: il file si riscrive tutto insieme, il singolo book no.
    const ageMs = fin(yes.ageMs) ? (yes.ageMs as number) : (fin(entry.ageMs) ? (entry.ageMs as number) : null);
    // «live: false» sul lato vuol dire che agent34 ha il mercato in elenco ma il suo book non è
    // aggiornato adesso. Non si spaccia per fresco: si dichiara la fonte e si lascia decidere a chi
    // legge (il pannello scrive l'età accanto al mid).
    return NextResponse.json({
      ok: true, at, error: null,
      quote: {
        marketId, title: entry.title ?? null,
        mid: r3(mid), bestBid: r3(bid), bestAsk: r3(ask),
        spreadCents: spreadFrom(bid, ask),
        // Regole di venue che il book live pubblica; il tick no, e resta null di proposito.
        tick: null,
        minSize: fin(entry.minSize) ? (entry.minSize as number) : null,
        maxSpreadCents: fin(entry.maxSpread) ? (entry.maxSpread as number) : null,
        source: 'live-book',
        sourceNote: `agent34 · canale market del CLOB · ${entry.source ?? 'sottoscritto'}`,
        live: yes.live === true,
        ageMs,
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  // ── 2 · GAMMA, per i mercati che agent34 non segue ───────────────────────────────────────────────
  try {
    const r = await fetchMarketByConditionId(marketId, { nowMs: Date.now(), timeoutMs: 6000 });
    if (!r.ok || !r.market) {
      return NextResponse.json({ ok: false, at, error: r.error ?? 'mercato non trovato', quote: null }, { status: 502 });
    }
    const m = r.market;
    return NextResponse.json({
      ok: true, at, error: null,
      quote: {
        marketId, title: m.question ?? null,
        mid: r3(m.mid), bestBid: r3(m.bestBid), bestAsk: r3(m.bestAsk),
        // Gamma pubblica il proprio spread; se manca lo si ricava dal tocco, mai da un default.
        spreadCents: fin(m.spreadCents) ? (m.spreadCents as number) : spreadFrom(m.bestBid, m.bestAsk),
        tick: fin(m.tick) ? (m.tick as number) : null,
        minSize: fin(m.rewardsMinSize) ? (m.rewardsMinSize as number) : null,
        maxSpreadCents: fin(m.rewardsMaxSpreadCents) ? (m.rewardsMaxSpreadCents as number) : null,
        source: 'gamma',
        sourceNote: 'Gamma /markets — agent34 non è sottoscritto a questo mercato',
        // Una lettura REST appena fatta: l'età è quella della richiesta, non zero per convenzione.
        live: false,
        ageMs: 0,
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (e) {
    return NextResponse.json({ ok: false, at, error: (e as Error).message, quote: null }, { status: 500 });
  }
}

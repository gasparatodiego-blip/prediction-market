import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import fs from 'fs';
// Sola lettura. Questo modulo espone `fetchMarketByConditionId`, che fa una GET verso Gamma e basta:
// non costruisce, non firma e non piazza nulla. Nessun import qui raggiunge l'adattatore di piazzamento.
import { fetchMarketByConditionId, isConditionId } from '@/lib/maker/market-search';
// LA VISTA COERENTE. Mid, tocco e scala escono tutti dagli stessi livelli: è questa funzione che rende
// impossibile per costruzione il difetto «mid fuori da bid/ask» — vedi lib/maker/book-view.js.
import { bookView } from '@/lib/maker/book-view';
import type { BookView } from '@/lib/maker/book-view';
// La profondità per i mercati che agent34 non segue. Mai mescolata con il feed dentro una stessa vista.
import { fetchMarketBooks } from '@/lib/maker/clob-book-rest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/quote?marketId=0x…[&levels=5] — LA QUOTAZIONE PIÙ FRESCA DISPONIBILE per UN mercato,
 * con la PROFONDITÀ REALE del book su entrambi i lati.
 *
 * ═══ IL DIFETTO CHE QUESTA ROUTE ORA NON PUÒ PIÙ PRODURRE ══════════════════════════════════════════
 * Il pannello mostrava MID 20.0¢ accanto a BID 21.0¢ e ASK 22.0¢ — un mid più basso di entrambi. La
 * causa non era un arrotondamento: `mid` e `bestBid`/`bestAsk` erano DUE COSE DIVERSE servite come una
 * sola. `mid` era `adjustedMid`, il midpoint del book AL NETTO dei livelli sotto `min_incentive_size`
 * (il programma premi non li vede); `bestBid`/`bestAsk` erano il tocco GREZZO, briciole comprese. Su un
 * book spesso coincidono; su un ciclo da 15 minuti con un primo livello da 10 share il filtro sposta il
 * mid oltre il tocco e i tre numeri smettono di stare in fila.
 *
 * Adesso ogni lato passa da `bookView`, che calcola il mid dai LIVELLI CHE STA RESTITUENDO. `mid` è
 * `(bestBid + bestAsk) / 2` di quel preciso ladder: non può cadere fuori da bid/ask, perché è fatto di
 * bid e ask. `scoringMid` — il numero contro cui il VENUE giudica la banda premiante — viaggia accanto,
 * invariato, con `midDiffersFromScoring` e `scoringMidOutsideTouch` a dire quando i due divergono e
 * `midNotes` a spiegarlo a parole. Tre numeri coerenti più una nota, invece di tre numeri incoerenti.
 *
 * ═══ DUE FONTI, MAI MESCOLATE DENTRO UNA VISTA ═════════════════════════════════════════════════════
 *   1. book live di agent34 (/tmp/clob-live-books.json) — websocket sul canale market del CLOB, età
 *      tipica in millisecondi, 12 livelli per lato già nello snapshot. Mid, tocco e scala vengono dallo
 *      STESSO snapshot: un solo istante. Copre il board reward più i mercati abilitati dall'operatore.
 *   2. REST GET /book del CLOB — solo per i mercati che agent34 non segue. Anche qui mid, tocco e scala
 *      escono TUTTI dalla stessa singola risposta, quindi anche qui un solo istante. Gamma resta la
 *      fonte delle REGOLE (tick, banda, min size), mai dei prezzi mostrati accanto alla scala.
 *
 * La risposta porta SEMPRE `source` e `ageMs`, perché «quanto è vecchio questo prezzo» è parte del
 * prezzo: un mid di due minuti su un ciclo da cinque non è lo stesso fatto di un mid di 9 millisecondi.
 *
 * UN CAMPO CHE LA FONTE NON PUBBLICA TORNA `null`, MAI UN VALORE DI RIPIEGO. Il book live non porta il
 * tick (è una regola di venue, non un dato di mercato): da quel percorso `tick` è null, e sta al
 * chiamante tenersi quello che già conosce. Un null qui significa «questa fonte non lo dice», non «zero».
 *
 * Gated dal middleware come tutto /api/maker (ADMIN_ACCESS_SECRET).
 */

const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';
// Quanti livelli per lato. Il pannello ne chiede 5 (il requisito), il tetto è quello che agent34 scrive
// davvero nel suo snapshot: chiederne di più non li farebbe comparire, quindi non si finge di poterlo.
const DEFAULT_LEVELS = 5;
const MAX_LEVELS = 12;

interface RawLevel { price: number; size: number }
interface Side {
  live?: boolean; ageMs?: number | null; bestBid?: number | null; bestAsk?: number | null;
  adjustedMid?: number | null; plainMid?: number | null;
  levels?: { bids?: RawLevel[]; asks?: RawLevel[]; cap?: number; bidCount?: number; askCount?: number } | null;
}
interface BookEntry {
  title?: string | null; live?: boolean; ageMs?: number | null;
  mid?: number | null; plainMid?: number | null; minSize?: number | null; maxSpread?: number | null;
  source?: string | null; tokenId?: string | null; tokenIdNo?: string | null;
  yes?: Side; no?: Side;
}
interface BooksFile { generatedAt?: string; staleMs?: number; markets?: Record<string, BookEntry> }

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const r3 = (x: number | null | undefined): number | null => (fin(x) ? Math.round(x * 1000) / 1000 : null);

function readBooks(): BooksFile | null {
  try { return JSON.parse(fs.readFileSync(LIVE_BOOKS_FILE, 'utf8')) as BooksFile; } catch { return null; }
}

/**
 * IL MID DI SCORING DEL LATO NO. Il feed pubblica `adjustedMid` per ciascun book, calcolato sul book
 * NO reale — un CLOB indipendente, non lo specchio del book YES. Si usa quello quando c'è; il
 * complemento `1 − midYes` resta solo come ultima risorsa, ed è DICHIARATO come tale dal chiamante.
 */
function scoringMidFor(side: Side | undefined, fallback: number | null): number | null {
  if (side && fin(side.adjustedMid)) return side.adjustedMid;
  return fin(fallback) ? fallback : null;
}

/** La forma pubblica di un lato: la vista coerente più i dati di venue che valgono per entrambi. */
function sideOut(view: BookView, extra: Record<string, unknown>) {
  return { ...view, ...extra };
}

export async function GET(req: NextRequest) {
  const marketId = (req.nextUrl.searchParams.get('marketId') || '').trim();
  const levelsReq = Number(req.nextUrl.searchParams.get('levels') || DEFAULT_LEVELS);
  const levels = Number.isFinite(levelsReq) ? Math.min(MAX_LEVELS, Math.max(1, Math.round(levelsReq))) : DEFAULT_LEVELS;
  const at = new Date().toISOString();
  if (!isConditionId(marketId)) {
    return NextResponse.json({ ok: false, at, error: 'marketId non valido (atteso 0x + 64 esadecimali)', quote: null }, { status: 400 });
  }

  // ── 1 · IL BOOK LIVE ─────────────────────────────────────────────────────────────────────────────
  const books = readBooks();
  const entry = books?.markets?.[marketId] ?? books?.markets?.[marketId.toLowerCase()] ?? null;
  // Il feed conosce il mercato SOLO se ha davvero un book seminato su almeno un lato. Un'entry presente
  // con entrambi i lati a `no-snapshot` (mercato appena abilitato, o scaduto) non è una quotazione: è un
  // segnaposto. Prima veniva servita lo stesso, e il pannello mostrava i null del feed invece di
  // ripiegare sulla REST che il book ce l'ha. Si controlla il ladder, non la presenza della chiave.
  const seeded = !!entry && (
    (entry.yes?.levels?.bids?.length ?? 0) > 0 || (entry.yes?.levels?.asks?.length ?? 0) > 0
    || (entry.no?.levels?.bids?.length ?? 0) > 0 || (entry.no?.levels?.asks?.length ?? 0) > 0
  );

  if (entry && seeded) {
    const minSize = fin(entry.minSize) ? entry.minSize : null;
    const yesScoring = scoringMidFor(entry.yes, fin(entry.mid) ? entry.mid : null);
    // Il complemento serve solo se il feed non ha un adjustedMid proprio per il book NO.
    const noFallback = fin(yesScoring) ? +(1 - yesScoring).toFixed(6) : null;
    const noScoring = scoringMidFor(entry.no, noFallback);

    const mk = (side: Side | undefined, scoringMid: number | null): BookView => bookView({
      levels: side?.levels ?? null,
      bestBid: side?.bestBid ?? null,
      bestAsk: side?.bestAsk ?? null,
      scoringMid,
      minSize,
      live: side?.live === true,
      // L'età del LATO, non quella del file: il file si riscrive tutto insieme, il singolo book no.
      ageMs: fin(side?.ageMs) ? (side?.ageMs as number) : (fin(entry.ageMs) ? entry.ageMs : null),
      source: 'live-book',
      levelCap: fin(side?.levels?.cap) ? (side?.levels?.cap as number) : null,
    }, { levels });

    const yesView = mk(entry.yes, yesScoring);
    const noView = mk(entry.no, noScoring);
    const scoringNoteNo = entry.no && fin(entry.no.adjustedMid)
      ? null
      : 'Il mid di scoring del book NO non è pubblicato dal feed: qui è il complemento 1−mid(YES), non una lettura del book NO.';

    return NextResponse.json({
      ok: true, at, error: null,
      quote: {
        marketId, title: entry.title ?? null,
        // ── COMPATIBILITÀ ── i campi piatti restano, ma ora sono quelli COERENTI del book YES, non un
        // mid preso da un filtro diverso da quello del tocco che gli sta accanto.
        mid: r3(yesView.mid), bestBid: r3(yesView.bestBid), bestAsk: r3(yesView.bestAsk),
        spreadCents: yesView.spreadCents,
        midKind: yesView.midKind,
        scoringMid: r3(yesView.scoringMid),
        midDiffersFromScoring: yesView.midDiffersFromScoring,
        scoringMidOutsideTouch: yesView.scoringMidOutsideTouch,
        midNotes: yesView.midNotes,
        // Regole di venue che il book live pubblica; il tick no, e resta null di proposito.
        tick: null,
        minSize,
        maxSpreadCents: fin(entry.maxSpread) ? entry.maxSpread : null,
        source: 'live-book',
        sourceNote: `agent34 · canale market del CLOB · ${entry.source ?? 'sottoscritto'}`,
        depthSource: 'live-book',
        depthSourceNote: 'stessa istantanea websocket da cui escono mid e tocco — nessuna seconda lettura, nessun secondo istante',
        live: entry.yes?.live === true,
        ageMs: fin(entry.yes?.ageMs) ? (entry.yes?.ageMs as number) : (fin(entry.ageMs) ? entry.ageMs : null),
        // ── I DUE BOOK, ciascuno con la sua scala e il suo mid coerente ──
        books: {
          yes: sideOut(yesView, { tokenId: entry.tokenId ?? null, scoringMidNote: null }),
          no: sideOut(noView, { tokenId: entry.tokenIdNo ?? null, scoringMidNote: scoringNoteNo }),
        },
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  // ── 2 · GAMMA per le REGOLE + REST del CLOB per il BOOK ──────────────────────────────────────────
  // Gamma pubblica tick, banda e min size ma NON una profondità: il suo `bestBid`/`bestAsk` è un tocco e
  // basta. La scala viene dalla REST del CLOB, e da lì viene anche il mid mostrato — così mid, tocco e
  // livelli restano un solo istante anche su questo percorso.
  try {
    const r = await fetchMarketByConditionId(marketId, { nowMs: Date.now(), timeoutMs: 6000 });
    if (!r.ok || !r.market) {
      return NextResponse.json({ ok: false, at, error: r.error ?? 'mercato non trovato', quote: null }, { status: 502 });
    }
    const m = r.market;
    const minSize = fin(m.rewardsMinSize) ? m.rewardsMinSize : null;
    const rest = await fetchMarketBooks({ tokenIdYes: m.tokenIdYes, tokenIdNo: m.tokenIdNo }, { timeoutMs: 6000 });

    // `scoringMid` da questa fonte NON viene inventato: il filtro anti-polvere che produce l'adjusted mid
    // è calcolato da agent34 sul book live, e qui quel book non c'è. Si dichiara null, e il pannello
    // giudica la banda contro il midpoint reale dicendo da dove viene.
    const NO_SCORING = 'Nessun mid di scoring da questa fonte: il filtro min_incentive_size lo calcola agent34 sul book live, che qui non copre il mercato.';
    const mkRest = (
      side: { ok: boolean; error: string | null; book: null | { levels: { bids: unknown[]; asks: unknown[] }; tick: number | null; lastTradePrice: number | null } },
      touchBid: number | null, touchAsk: number | null,
    ): BookView => bookView({
      levels: side.ok && side.book ? (side.book.levels as { bids?: RawLevel[]; asks?: RawLevel[] }) : null,
      bestBid: touchBid, bestAsk: touchAsk,
      scoringMid: null,
      minSize,
      live: false,
      // Una lettura REST appena fatta: l'età è quella della richiesta, non zero per convenzione.
      ageMs: 0,
      source: side.ok ? 'clob-rest' : 'gamma',
      lastTradePrice: side.ok && side.book ? side.book.lastTradePrice : null,
      levelCap: null,
    }, { levels });

    // Il tocco di Gamma serve SOLO come rete quando la REST del book non ha risposto per quel lato.
    const yesView = mkRest(rest.yes, fin(m.bestBid) ? m.bestBid : null, fin(m.bestAsk) ? m.bestAsk : null);
    const noView = mkRest(rest.no, null, null);
    const tickFromBook = rest.yes.ok && rest.yes.book && fin(rest.yes.book.tick) ? rest.yes.book.tick : null;
    const depthOk = rest.yes.ok || rest.no.ok;

    return NextResponse.json({
      ok: true, at, error: null,
      quote: {
        marketId, title: m.question ?? null,
        mid: r3(yesView.mid), bestBid: r3(yesView.bestBid), bestAsk: r3(yesView.bestAsk),
        // Lo spread si ricava dal tocco che stiamo MOSTRANDO. Il campo `spread` di Gamma descrive un
        // altro istante e un'altra lettura: usarlo qui rimetterebbe due fonti nella stessa riga.
        spreadCents: yesView.spreadCents,
        midKind: yesView.midKind,
        scoringMid: null,
        midDiffersFromScoring: false,
        scoringMidOutsideTouch: false,
        midNotes: yesView.midNotes,
        tick: fin(m.tick) ? m.tick : tickFromBook,
        minSize,
        maxSpreadCents: fin(m.rewardsMaxSpreadCents) ? m.rewardsMaxSpreadCents : null,
        source: 'gamma',
        sourceNote: 'Gamma /markets per le regole — agent34 non è sottoscritto a questo mercato',
        depthSource: depthOk ? 'clob-rest' : null,
        depthSourceNote: depthOk
          ? 'REST GET /book del CLOB, una sola risposta per lato: mid, tocco e scala sono lo stesso istante'
          : `profondità non leggibile (${rest.yes.error ?? rest.no.error ?? 'errore ignoto'})`,
        live: false,
        ageMs: 0,
        books: {
          yes: sideOut(yesView, { tokenId: m.tokenIdYes ?? null, scoringMidNote: NO_SCORING }),
          no: sideOut(noView, { tokenId: m.tokenIdNo ?? null, scoringMidNote: NO_SCORING }),
        },
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (e) {
    return NextResponse.json({ ok: false, at, error: (e as Error).message, quote: null }, { status: 500 });
  }
}

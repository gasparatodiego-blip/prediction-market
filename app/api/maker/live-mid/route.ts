import { NextRequest } from 'next/server';
import fs from 'fs';
// Le due costanti che definiscono «mid stantio» vivono nel motore, e si leggono da lì: un pannello che
// mostra uno stato di pausa deve mostrare LA soglia del motore, non una sua copia che diverge al primo
// cambio. È lo stesso criterio di lib/maker/end-of-scale.js.
import { MID_STALE_PAUSE_SEC } from '@/lib/maker/mm-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/maker/live-mid — IL MID VIVO, IN PUSH, PER I MERCATI CON ORDINI A RIPOSO. SOLA LETTURA.
 *
 * ═══ PERCHÉ SSE E NON UN POLLING ═══════════════════════════════════════════════════════════════════
 * Il websocket del venue arriva in agent34, che è un processo separato: il browser non può agganciarsi
 * a quel socket. Il canale fra i due è lo snapshot che agent34 riscrive in modo atomico su
 * /tmp/clob-live-books.json. Qui si guarda QUELLA cartella con fs.watch — lo stesso identico meccanismo
 * che agent40 usa per svegliare il proprio ciclo — e si spinge un evento al browser nell'istante in cui
 * lo snapshot cambia. Il client non chiede niente a intervalli: apre una EventSource e ascolta.
 *
 * Si guarda la DIRECTORY e non il file: la scrittura atomica (tmp + rename) cambia l'inode, e un watch
 * sul percorso del file smette di ricevere eventi dopo la prima sostituzione (misurato: 1 risveglio su
 * 10). Filtrando per nome, ogni rename viene visto.
 *
 * ═══ IL FRENO, E DOVE STA ══════════════════════════════════════════════════════════════════════════
 * Lo snapshot può cambiare più spesso di quanto un occhio umano possa leggere. Il freno sta QUI, sul
 * server, non nel browser: al massimo un evento ogni THROTTLE_MS, e quando arrivano più cambi dentro la
 * finestra si manda l'ULTIMO stato, non la coda di quelli intermedi. Frenare sul client avrebbe
 * comunque pagato la serializzazione e il traffico di ogni evento scartato.
 *
 * ═══ COSA COSTA ════════════════════════════════════════════════════════════════════════════════════
 * Il mid è gratis: è un file locale già scritto da agent34. Gli ORDINI no — `listManualOrders` chiama il
 * venue — quindi la lista degli ordini si rinfresca sul suo orologio lento (ORDERS_REFRESH_MS), mentre
 * la DISTANZA dal mid si ricalcola a ogni push contro il mid nuovo. È la parte che cambia da un istante
 * all'altro, ed è quella che il pannello deve mostrare viva.
 *
 * ═══ NON PIAZZA E NON CANCELLA ═════════════════════════════════════════════════════════════════════
 * GET, nessun corpo, nessun parametro che scelga un'azione. Importa `listManualOrders` (lettura) e
 * niente altro dalla corsia manuale: non `placeManualOrder`, non `cancelManualOrder`, non l'adapter.
 * Un test lo verifica sul sorgente, perché «per ora non lo fa» non è una garanzia strutturale.
 */

const LIVE_BOOKS_DIR = '/tmp';
const LIVE_BOOKS_NAME = 'clob-live-books.json';
const LIVE_BOOKS = `${LIVE_BOOKS_DIR}/${LIVE_BOOKS_NAME}`;

const THROTTLE_MS = 250;          // ≤ 4 aggiornamenti al secondo verso il browser
const ORDERS_REFRESH_MS = 10_000; // gli ordini costano una chiamata al venue: orologio suo, lento
const HEARTBEAT_MS = 20_000;      // un commento SSE ogni 20s: tiene viva la connessione dietro i proxy

type Ordine = {
  orderId: string | null; marketId: string | null; side: string | null;
  price: number | null; size: number | null; sizeRemaining: number | null;
};

type RigaMercato = {
  marketId: string;
  title: string | null;
  mid: number | null;
  midAgeSec: number | null;
  live: boolean;
  /** true ⇒ il motore mette QUESTO mercato in pausa: il mid è più vecchio della soglia. */
  midStantio: boolean;
  sogliaStantioSec: number;
  ordini: Array<Ordine & { distanzaCents: number | null; latoDelMid: 'sotto' | 'sopra' | 'sul' | null }>;
};

function leggiBooks(): any {
  try { return JSON.parse(fs.readFileSync(LIVE_BOOKS, 'utf8')); } catch { return null; }
}

/** Compone lo stato: mid dal file locale, ordini dall'ultima lettura del venue. Nessun effetto. */
function componi(books: any, ordini: Ordine[]): { at: string; feedLetto: boolean; mercati: RigaMercato[] } {
  // La composizione vive in lib/maker/mid-vivo.js: una funzione dentro un file di rotta non si può
  // chiamare da un test senza montare Next, e questa è esattamente la parte che va provata.
  const { componiMidVivo } = require('@/lib/maker/mid-vivo');
  return { at: new Date().toISOString(), ...componiMidVivo(books, ordini, MID_STALE_PAUSE_SEC) };
}

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  let chiuso = false;
  let ordini: Ordine[] = [];
  let ordiniErrore: string | null = null;
  let ultimoInvio = 0;
  let timerFreno: NodeJS.Timeout | null = null;
  let timerOrdini: NodeJS.Timeout | null = null;
  let timerBattito: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const invia = (evento: string, dato: any) => {
        if (chiuso) return;
        try {
          controller.enqueue(encoder.encode(`event: ${evento}\ndata: ${JSON.stringify(dato)}\n\n`));
        } catch { /* connessione già chiusa dal client */ }
      };

      const inviaStato = () => {
        ultimoInvio = Date.now();
        invia('stato', { ...componi(leggiBooks(), ordini), ordiniErrore, sogliaFrenoMs: THROTTLE_MS });
      };

      // IL FRENO: al più un evento ogni THROTTLE_MS, e quello che parte è sempre lo stato PIÙ RECENTE.
      const inviaConFreno = () => {
        if (chiuso || timerFreno) return;
        const attesa = Math.max(0, THROTTLE_MS - (Date.now() - ultimoInvio));
        timerFreno = setTimeout(() => { timerFreno = null; inviaStato(); }, attesa);
      };

      const rileggiOrdini = async () => {
        try {
          const { listManualOrders } = await import('@/lib/maker/manual-order');
          const r: any = await listManualOrders({});
          ordini = Array.isArray(r && r.orders) ? r.orders : [];
          ordiniErrore = (r && r.ok === false) ? (r.error || 'lettura ordini non riuscita') : null;
        } catch (e: any) {
          ordiniErrore = e && e.message ? e.message : String(e);
        }
        inviaConFreno();
      };

      await rileggiOrdini();
      inviaStato();

      timerOrdini = setInterval(rileggiOrdini, ORDERS_REFRESH_MS);
      timerBattito = setInterval(() => { if (!chiuso) { try { controller.enqueue(encoder.encode(': battito\n\n')); } catch { /* chiusa */ } } }, HEARTBEAT_MS);

      try {
        watcher = fs.watch(LIVE_BOOKS_DIR, (_ev, name) => {
          if (name !== LIVE_BOOKS_NAME) return;
          inviaConFreno();
        });
      } catch {
        // Senza fs.watch resta il solo rinfresco degli ordini: il pannello lo dichiara invece di
        // fingere di essere in push.
        invia('degradato', { motivo: 'fs.watch non disponibile su questo host — niente push dal feed' });
      }
    },
    cancel() {
      chiuso = true;
      if (timerFreno) clearTimeout(timerFreno);
      if (timerOrdini) clearInterval(timerOrdini);
      if (timerBattito) clearInterval(timerBattito);
      if (watcher) { try { watcher.close(); } catch { /* già chiuso */ } }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

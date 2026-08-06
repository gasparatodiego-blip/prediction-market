import { NextResponse } from 'next/server';
import { resolveFunder, venueAccountAddress } from '@/lib/venues/polymarket-clob-maker/funder';
// LO SNAPSHOT DELLE POSIZIONI È UN INTERRUTTORE COME GLI ALTRI, e finora non compariva qui.
// `lib/safety/risk-limits.js` rifiuta OGNI piazzamento quando non è leggibile — quindi questa pagina
// poteva dire «PRONTO» mentre ogni ordine veniva respinto, e l'unico modo di scoprirlo era provare a
// piazzare. Il 5 agosto 2026 è successo esattamente questo.
import { readVenuePositions, MAX_AGE_MS } from '@/lib/safety/venue-positions-snapshot';
// I RESIDUI CHE MUOIONO SOTTO LA SOGLIA MINIMA. Un fill parziale può lasciare una size che non arriva più
// a `min_incentive_size`: quell'ordine non è rinnovabile, viene lasciato scadere — decisione giusta e
// invariata — ma finora scadeva in silenzio, e il capitale che portava tornava libero senza che nessuno
// lo sapesse. Qui l'avviso entra nella stessa lista «cosa manca» che si legge prima di piazzare.
import { readResiduiSottoSoglia } from '@/lib/maker/residui-sotto-soglia';
import { readScadenzeSenzaRinnovo } from '@/lib/maker/scadenze-senza-rinnovo';
// LE CANCELLAZIONI DEL MOTORE E LE GAMBE RIMASTE SOLE. Il 6 agosto 2026 una gamba e' stata cancellata
// correttamente e l'altra e' rimasta sola per due ore: nessuna delle due cose arrivava a una superficie.
import { readCancellazioni } from '@/lib/maker/cancellazioni-visibili';
import { leggiOrfaneTutte, ORPHAN_LEG_TOLERANCE_MIN, ORPHAN_LEG_TOLERANCE_MS } from '@/lib/maker/gamba-orfana';
// IL DEAD-MAN CHE SVUOTA IL LIBRO. La notte fra il 5 e il 6 agosto 2026 agent37 ha cancellato nove
// ordini reali su cinque mercati alle 00:16:03 e l'unica traccia leggibile era in un log di processo:
// il mattino dopo il pannello mostrava un libro vuoto e nessuna spiegazione. È l'evento più grosso che
// questo sistema possa produrre da solo, e finora era l'unico che non arrivava qui.
import { readCancellazioniDiEmergenza } from '@/lib/maker/cancellazione-di-emergenza';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/maker/wallet-status — «il sistema e' pronto a piazzare un ordine vero?»
 *
 * Legge lo stato ON-CHAIN, non una cache: saldo pUSD del proxy e le quattro autorizzazioni che il venue
 * pretende (ERC-20 sul collaterale e ERC-1155 sui token di esito, verso i due exchange). Poi mostra i due
 * interruttori software che stanno sopra: l'attestazione di finanziamento e lo switch di invio.
 *
 * PERCHE' ESISTE. Prima questa risposta viveva in un log di processo: «gate=funding-approval … Diego's
 * on-chain signatures required». Un operatore col telefono in mano non ha modo di sapere se quel
 * messaggio significa «devi firmare qualcosa» oppure «manca una riga in un file» — e sono due mondi
 * diversi. Qui i due mondi sono separati e ognuno dice cosa serve.
 *
 * SOLA LETTURA, E NON MANDA TRANSAZIONI. Fa `eth_call`, che non firma e non spende. Depositare o
 * concedere approvazioni resta un'azione dell'operatore dal suo wallet: questo endpoint dice se servono,
 * non le esegue.
 */

const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';        // collaterale (USDC.e su Polygon)
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';         // ConditionalTokens (ERC-1155)
const EXCHANGES: Array<{ name: string; address: string }> = [
  { name: 'CTF Exchange V2', address: '0xE111180000d2663C0091e4f400237545B87B996B' },
  { name: 'Neg-Risk CTF Exchange V2', address: '0xe2222d279d744050d28e00520010520000310F59' },
];
// Sotto questa cifra un ordine alla size minima tipica (50 share) non sarebbe coperto su entrambi i lati.
// Non e' una regola del venue: e' la soglia sotto cui questo pannello smette di dire «pronto».
const MIN_USEFUL_USD = 20;

const pad = (a: string) => '000000000000000000000000' + a.replace(/^0x/, '').toLowerCase();

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    cache: 'no-store',
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
  return j.result;
}

export async function GET() {
  const at = new Date().toISOString();
  const rpc = process.env.POLYGON_RPC_URL || process.env.POLYGON_RPC || process.env.RPC_URL || 'https://polygon-rpc.com';
  const placement = process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send' : 'dry-run';
  const fundingApproved = process.env.MAKER_FUNDING_APPROVED === 'true';

  let address: string | null = null;
  try { address = venueAccountAddress(resolveFunder(process.env), null); } catch { address = null; }
  if (!address) {
    return NextResponse.json({
      ok: false, at, error: 'proxy/funder non risolvibile dalla configurazione',
      chain: null, placement, fundingApproved, ready: false,
      todo: [{ who: 'sistema', what: 'la configurazione non nomina un proxy: nessuno stato on-chain da leggere' }],
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ── LO STATO ON-CHAIN ──────────────────────────────────────────────────────────────────────────
  // Una lettura fallita NON diventa «manca»: resta `null` col motivo. «Non l'ho letto» e «non c'e'» sono
  // due fatti diversi, e qui il secondo manderebbe l'operatore a firmare qualcosa che ha gia' firmato.
  let balanceUsd: number | null = null;
  let chainError: string | null = null;
  const approvals: Array<{ name: string; address: string; erc20: string | null; erc1155: boolean | null }> = [];
  try {
    const bal = BigInt(await ethCall(rpc, PUSD, '0x70a08231' + pad(address)));
    balanceUsd = Number(bal) / 1e6;
    for (const ex of EXCHANGES) {
      // Numeri, non BigInt: il target TypeScript di questo progetto non ammette i letterali BigInt, e
      // qui la precisione esatta non serve — un'allowance «illimitata» e' 2^256−1 e Number la rappresenta
      // come Infinity-ish, che e' esattamente il verdetto che ci interessa.
      const alRaw = await ethCall(rpc, PUSD, '0xdd62ed3e' + pad(address) + pad(ex.address));
      const apRaw = await ethCall(rpc, CTF, '0xe985e9c5' + pad(address) + pad(ex.address));
      const al = Number(BigInt(alRaw)) ;
      const ap = Number(BigInt(apRaw));
      approvals.push({
        name: ex.name, address: ex.address,
        erc20: al > 1e30 ? 'illimitata' : `${(al / 1e6).toFixed(2)} USDC`,
        erc1155: ap === 1,
      });
    }
  } catch (e) { chainError = (e as Error).message; }

  const funded = balanceUsd != null && balanceUsd >= MIN_USEFUL_USD;
  const approvalsOk = approvals.length === EXCHANGES.length
    && approvals.every((a) => a.erc1155 === true && a.erc20 !== null && a.erc20 !== '0.00 USDC');

  // ── COSA MANCA, E A CHI TOCCA ──────────────────────────────────────────────────────────────────
  // Diviso per ESECUTORE, che e' la distinzione che conta per chi legge: «devo firmare dal wallet» e
  // «manca una riga di configurazione» richiedono due azioni completamente diverse.
  const todo: Array<{ who: 'operatore' | 'sistema'; what: string; how?: string }> = [];
  if (chainError) {
    todo.push({ who: 'sistema', what: `stato on-chain NON letto (${chainError}) — non si puo' dire se manchi qualcosa`, how: 'riprova, oppure controlla l\'RPC Polygon' });
  } else {
    if (!funded) {
      todo.push({
        who: 'operatore',
        what: `deposita almeno ${(MIN_USEFUL_USD - (balanceUsd ?? 0)).toFixed(2)} USDC sul proxy (saldo attuale ${(balanceUsd ?? 0).toFixed(2)})`,
        how: 'dall\'app Polymarket: Deposit → invia USDC su Polygon all\'indirizzo del proxy qui sopra',
      });
    }
    for (const a of approvals) {
      if (a.erc1155 !== true) todo.push({ who: 'operatore', what: `manca l'approvazione ERC-1155 verso ${a.name}`, how: 'dall\'app Polymarket, la prima operazione su quel mercato la richiede e la concede' });
      if (a.erc20 === '0.00 USDC') todo.push({ who: 'operatore', what: `manca l'allowance ERC-20 del collaterale verso ${a.name}`, how: 'stessa operazione dall\'app Polymarket' });
    }
  }
  if (!fundingApproved) {
    todo.push({
      who: 'sistema',
      what: 'MAKER_FUNDING_APPROVED non e\' attestata: e\' un\'attestazione MANUALE, non un controllo automatico — il codice legge solo la variabile e non guarda la catena',
      how: funded && approvalsOk ? 'saldo e approvazioni on-chain risultano gia\' sufficienti: resta solo da attestarlo' : 'da attestare DOPO aver sistemato quanto sopra',
    });
  }
  if (placement !== 'send') {
    todo.push({ who: 'sistema', what: 'MANUAL_ORDER_PLACEMENT e\' su dry-run: gli ordini vengono costruiti, firmati e validati, poi scartati', how: 'passare a «send» e\' l\'ultimo interruttore, e va acceso di proposito' });
  }

  // ── LE POSIZIONI APERTE AL VENUE, LETTE COME LE LEGGE IL GATE ──────────────────────────────────
  // Stessa funzione, stesso file, stessa soglia: se qui risulta leggibile e il gate la rifiuta, allora
  // il difetto è nel gate — non in due letture che divergono.
  const snap = readVenuePositions();
  if (!snap.readable) {
    todo.push({
      who: 'sistema',
      what: `posizioni aperte al venue NON leggibili (${snap.reason}) — il gate limit-venue-positions-unreadable rifiutera' ogni ordine`,
      how: 'le scrive agent40-manual-reprice ogni 60s: se il file non si aggiorna, quel processo non sta girando o non riesce a leggere il venue',
    });
  }

  // ── I RESIDUI CONDANNATI, DETTI A PAROLE ───────────────────────────────────────────────────────
  // Vengono DOPO tutto il resto e non entrano in `blockedBy`: non impediscono di piazzare — nessun gate
  // li guarda — e spacciarli per un blocco farebbe leggere «bloccato dall'operatore» a un sistema che
  // funziona. Sono un avviso, e un avviso che si traveste da blocco è il modo più rapido per far
  // ignorare entrambi.
  const bloccantiCount = todo.length;
  const residui = readResiduiSottoSoglia();
  const latoTxt = (r: { book: string; side: string }) =>
    `${String(r.book).toLowerCase() === 'no' ? 'NO' : 'SÌ'}${r.side === 'SELL' ? ' (ordine di uscita)' : ''}`;
  const quandoTxt = (iso: string | null): string => {
    if (!iso) return 'senza scadenza dichiarata';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return 'senza scadenza leggibile';
    const d = ms - Date.now();
    const min = Math.round(Math.abs(d) / 60_000);
    if (d > 0) return d < 90_000 ? `fra meno di un minuto (${new Date(ms).toLocaleTimeString('it-IT')})` : `fra ${min} min (${new Date(ms).toLocaleTimeString('it-IT')})`;
    return min < 1 ? `ora (${new Date(ms).toLocaleTimeString('it-IT')})` : `${min} min fa (${new Date(ms).toLocaleTimeString('it-IT')})`;
  };
  // ── IL LIBRO SVUOTATO DAL DEAD-MAN, PRIMA DI TUTTI GLI ALTRI AVVISI ────────────────────────────
  // Viene per primo fra gli avvisi perché è l'unico che spiega un LIBRO INTERO vuoto: leggere «residuo
  // sotto soglia» su due gambe mentre ne mancano nove è una traccia che porta nella direzione sbagliata.
  // Non entra in `blockedBy` — nessun gate lo guarda, e non impedisce di ripiazzare adesso.
  const emergenze = readCancellazioniDiEmergenza();
  for (const c of emergenze.cancellazioni) {
    const capitale = c.capitaleUsd == null ? 'importo non leggibile' : `$${c.capitaleUsd.toFixed(2)}`;
    const quando = quandoTxt(c.at);
    // Un pelo sopra la soglia e un crollo sono due diagnosi diverse, e la differenza è un numero solo.
    const margine = c.oltreSogliaSec == null
      ? ''
      : c.oltreSogliaSec <= 10
        ? ` — appena ${c.oltreSogliaSec}s oltre la soglia, quindi è mancato pochissimo`
        : ` — ${c.oltreSogliaSec}s oltre la soglia`;
    // QUANTO LIBRO è sparito. Una corsia sola e il libro intero sono due mattine diverse, e il testo
    // deve dirlo nella prima riga — non lasciarlo dedurre da un conteggio.
    const mirata = c.ambito === 'corsie';
    const morti = (c.motoriMorti ?? []).map((m) => m.processo).filter(Boolean).join(', ') || 'il motore maker';
    const vivi = (c.motoriVivi ?? []).map((m) => m.processo).filter(Boolean).join(', ');
    // UNO SCATTO CHE NON HA TOLTO NIENTE NON È UNA PERDITA DI CAPITALE, ed è sbagliato raccontarlo come
    // tale: «0 ordini cancellati, $0.00 tornati liberi» in mezzo a «cosa manca» è precisamente la riga
    // che si impara a ignorare. Resta però un fatto che conta — un motore è morto — quindi la voce c'è,
    // dice quello, e non finge che ci sia capitale da rimettere in gioco.
    if (c.ordiniCancellati === 0 && !c.simulata) {
      todo.push({
        who: 'operatore',
        what: `Un motore si è fermato e il guardiano è scattato, ma non c'era niente da cancellare:`
          + ` ${morti} non batteva da ${c.stalenessSec ?? '?'}s contro una soglia di ${c.thresholdSec ?? '?'}s${margine}.`
          + (mirata && vivi ? ` ${vivi} stava lavorando regolarmente e il suo libro non è stato toccato.` : '')
          + (c.ordiniLasciati ? ` I ${c.ordiniLasciati} ordini a riposo sono ancora tutti sul book.` : ' Nessun ordine era a riposo in quel momento.'),
        how: `È successo ${quando}. Nessun capitale è tornato libero — non c'è niente da rimettere in gioco.`
          + ` Vale però la pena guardare perché ${morti} aveva smesso di battere: la prossima volta potrebbe succedere con il libro pieno.`,
      });
      continue;
    }
    todo.push({
      who: 'operatore',
      what: (c.simulata
        ? `Il guardiano SIMULA una cancellazione${mirata ? ' mirata' : ' totale'}`
        : mirata ? 'IL GUARDIANO HA CANCELLATO UNA CORSIA DEL LIBRO' : 'IL GUARDIANO HA CANCELLATO TUTTO IL LIBRO')
        + `: ${c.ordiniCancellati} ordini su ${c.mercatiToccati} mercati, e ${capitale} sono tornati liberi.`
        + (mirata && c.ordiniLasciati
          ? ` Gli altri ${c.ordiniLasciati} ordini a riposo NON sono stati toccati: appartengono a un motore ancora vivo.`
          : '')
        + ` Motivo: ${morti} non batteva da ${c.stalenessSec ?? '?'}s contro una soglia di ${c.thresholdSec ?? '?'}s${margine}.`
        + (mirata && vivi ? ` ${vivi} invece stava lavorando regolarmente, quindi il suo libro è stato lasciato dov'era.` : '')
        + (c.simulata ? ' Nessuna credenziale di cancellazione: gli ordini sono ancora sul libro.' : '')
        + (c.erroreVenue ? ` ATTENZIONE: il venue ha risposto con un errore (${c.erroreVenue}) — parte di quegli ordini potrebbe essere ancora a riposo.` : ''),
      how: `È successo ${quando}${c.heartbeatAt ? `; l'ultimo battito risale a ${new Date(c.heartbeatAt).toLocaleTimeString('it-IT')}` : ''}.`
        + ' Questa non è una scadenza né un fill: gli ordini sono stati tolti dal guardiano, quindi il capitale è libero'
        + ' e resta fermo finché non lo si rimette in gioco a mano.'
        + ` Prima di ripiazzare vale la pena guardare perché ${morti} aveva smesso di battere.`,
    });
  }

  for (const r of residui.residui) {
    const mercato = r.marketTitle || `mercato cid_${String(r.marketId).replace(/^0x/, '').slice(0, 10)}`;
    const capitale = r.notionalUsd == null ? 'importo non leggibile' : `$${r.notionalUsd.toFixed(2)}`;
    todo.push({
      who: 'operatore',
      what: `Residuo sotto soglia minima: non rinnovabile, capitale in attesa di riallocazione — «${mercato}», lato ${latoTxt(r)}:`
        + ` restano ${r.sizeRemaining} quote contro il minimo di ${r.minSize} richiesto per essere pagati, e ${capitale} restano fermi lì.`,
      how: r.scaduto
        ? `L'ordine si è spento ${quandoTxt(r.expiresAt)}: quel capitale adesso è libero e va rimesso in gioco. La posizione già comprata non c'entra e segue la sua uscita per conto suo.`
        : `L'ordine non viene rinnovato e si spegne da solo ${quandoTxt(r.expiresAt)}; da quel momento il capitale è libero e va rimesso in gioco. La posizione già comprata non c'entra e segue la sua uscita per conto suo.`,
    });
  }

  // ── GLI ORDINI MORTI DI SCADENZA, DETTI A PAROLE ───────────────────────────────────────────────
  // Accanto ai residui e per la stessa ragione: è un avviso, non un blocco, quindi viene DOPO
  // `bloccantiCount` e non entra in `blockedBy`. La differenza rispetto al residuo è il tempo verbale —
  // il residuo sta morendo, questo è già morto — e quindi il testo dice cos'è successo e cosa resta da
  // fare, non cosa succederà.
  const scadenze = readScadenzeSenzaRinnovo();
  const cancellazioni = readCancellazioni();
  const orfane = leggiOrfaneTutte();
  for (const s of scadenze.scadenze) {
    const mercato = s.marketTitle || `mercato cid_${String(s.marketId).replace(/^0x/, '').slice(0, 10)}`;
    const capitale = s.notionalUsd == null ? 'importo non leggibile' : `$${s.notionalUsd.toFixed(2)}`;
    // Il motivo tecnico tradotto una volta sola, qui. `null` non è «non lo sappiamo»: è «il rinnovo non è
    // mai stato nemmeno valutato», che è un'informazione diversa e va detta come tale.
    const perche = s.bloccoGate === 'hourly-cap'
      ? 'il rinnovo era dovuto ma il tetto orario di riprezzi lo ha fermato'
      : s.bloccoGate === 'refresh-invalid'
        ? 'il rinnovo era dovuto ma ripiazzare quella size non avrebbe passato i controlli del venue'
        : s.bloccoGate === 'rate-limited'
          ? 'il rinnovo era dovuto ma il limite minimo fra due mosse sulla stessa gamba lo ha fermato'
          : s.bloccoGate === 'mid-stale' || s.bloccoGate === 'mid-not-live'
            ? 'il rinnovo era dovuto ma il prezzo di mercato non era abbastanza fresco per agire'
            : s.bloccoGate
              ? `il rinnovo era dovuto ed è stato fermato dal controllo «${s.bloccoGate}»`
              : 'il rinnovo non è mai stato valutato prima della scadenza';
    todo.push({
      who: 'operatore',
      what: `Ordine spento dalla scadenza, senza rinnovo — «${mercato}», lato ${latoTxt(s)}:`
        + ` ${s.size} quote a ${(s.price * 100).toFixed(1)}¢ non sono più sul libro, e ${capitale} sono tornati liberi.`
        + ` Motivo: ${perche}.`,
      how: `Si è spento ${quandoTxt(s.expiresAt)} e non ha maturato premi da quel momento.`
        + ' Quel capitale va rimesso in gioco se quel mercato serve ancora.'
        + (s.sizeMatched ? ` Attenzione: ${s.sizeMatched} quote erano già state eseguite, e quella posizione segue la sua uscita per conto suo.` : ''),
    });
  }

  return NextResponse.json({
    ok: true, at, error: null,
    address, rpc: rpc.replace(/\/\/([^@]*@)?/, '//'),
    chain: { readable: chainError == null, error: chainError, balanceUsd, minUsefulUsd: MIN_USEFUL_USD, funded, approvals, approvalsOk },
    fundingApproved,
    placement,
    // Lo stato dello snapshot, con la sua eta' e la soglia contro cui viene giudicata: cosi' «non
    // leggibile» si distingue da «vecchio di 200 secondi», che hanno cause diverse.
    venuePositions: {
      readable: snap.readable,
      ageMs: snap.ageMs,
      ageSec: snap.ageMs == null ? null : Math.round(snap.ageMs / 1000),
      maxAgeSec: Math.round(MAX_AGE_MS / 1000),
      count: snap.positions.length,
      reason: snap.reason,
      writer: 'agent40-manual-reprice',
    },
    // PRONTO significa: nulla piu' da fare, ne' all'operatore ne' al sistema. Il pannello non dice
    // «pronto» finche' anche un solo interruttore manca — mezza verita' qui costa un ordine rifiutato.
    // LO SNAPSHOT E' UNO DI QUELLI: senza, il gate rifiuta, quindi «pronto» sarebbe falso.
    ready: funded && approvalsOk && fundingApproved && placement === 'send' && snap.readable,
    // Solo le voci che precedono gli avvisi sui residui: quelle sì impediscono di piazzare.
    blockedBy: bloccantiCount ? todo[0].who : null,
    todo,
    // Gli stessi fatti in forma strutturata, per la casella riassuntiva del pannello. Il testo qui sopra
    // resta la fonte di ciò che si legge: questo serve al conteggio e al totale, non a ridirlo.
    residuiSottoSoglia: {
      count: residui.count,
      capitaleUsd: residui.capitaleUsd,
      items: residui.residui.map((r) => ({
        marketId: r.marketId, marketTitle: r.marketTitle, orderId: r.orderId,
        book: r.book, side: r.side, price: r.price,
        sizeRemaining: r.sizeRemaining, minSize: r.minSize, notionalUsd: r.notionalUsd,
        expiresAt: r.expiresAt, scaduto: r.scaduto ?? null,
      })),
    },
    // Gli ordini che la scadenza GTD ha spento senza che nessuno li rinnovasse. Stessa forma del blocco
    // qui sopra: il testo in `todo` resta la fonte di ciò che si legge, questo serve al conteggio e al
    // totale del capitale tornato libero.
    // Le cancellazioni totali del dead-man nelle ultime 12 ore. Finestra più lunga delle altre due di
    // proposito: questo evento capita di notte (il 6 agosto: 00:16 UTC) e un avviso già scaduto quando
    // si apre il pannello la mattina non è un avviso.
    cancellazioniDiEmergenza: {
      count: emergenze.count,
      ordiniCancellati: emergenze.ordiniCancellati,
      capitaleUsd: emergenze.capitaleUsd,
      items: emergenze.cancellazioni.map((c) => ({
        id: c.id, at: c.at,
        stalenessSec: c.stalenessSec, thresholdSec: c.thresholdSec, oltreSogliaSec: c.oltreSogliaSec,
        heartbeatAt: c.heartbeatAt,
        ordiniCancellati: c.ordiniCancellati, mercatiToccati: c.mercatiToccati,
        capitaleUsd: c.capitaleUsd, simulata: c.simulata, erroreVenue: c.erroreVenue,
        ambito: c.ambito, ordiniLasciati: c.ordiniLasciati,
        motoriMorti: c.motoriMorti, motoriVivi: c.motoriVivi,
        venues: c.venues,
      })),
    },
    scadenzeSenzaRinnovo: {
      count: scadenze.count,
      capitaleUsd: scadenze.capitaleUsd,
      items: scadenze.scadenze.map((s) => ({
        marketId: s.marketId, marketTitle: s.marketTitle, orderId: s.orderId,
        book: s.book, side: s.side, price: s.price, size: s.size, sizeMatched: s.sizeMatched ?? null,
        notionalUsd: s.notionalUsd, expiresAt: s.expiresAt, at: s.at,
        bloccoGate: s.bloccoGate ?? null,
      })),
    },
    // ── LE CANCELLAZIONI DEL MOTORE, COL MOTIVO DISTINTO ──────────────────────────────────────────
    // «Ordine cancellato» non e' un avviso: e' una notifica. `mai-primo-sul-libro` e
    // `gamba-orfana-scaduta` chiedono due reazioni diverse, quindi restano due voci diverse.
    cancellazioniMotore: {
      count: cancellazioni.count,
      perMotivo: cancellazioni.perMotivo,
      items: (cancellazioni.cancellazioni as Array<Record<string, unknown>>).map((c) => ({
        marketId: c.marketId, marketTitle: c.marketTitle ?? null, orderId: c.orderId,
        book: c.book, price: c.price, size: c.size, notionalUsd: c.notionalUsd ?? null,
        motivo: c.motivo, motivoLeggibile: c.motivoLeggibile, dettaglio: c.dettaglio ?? null, at: c.at,
      })),
    },
    // ── LE GAMBE ANCORA SOLE, COL COUNTDOWN ───────────────────────────────────────────────────────
    // Il countdown e' la parte utile: e' l'unica cosa che permette di intervenire PRIMA che la
    // cancellazione automatica scatti. Un mercato in questo elenco sta maturando una frazione del
    // dovuto proprio adesso.
    gambeOrfane: {
      tolleranzaMin: ORPHAN_LEG_TOLERANCE_MIN,
      leggibile: orfane.leggibile,
      items: Object.entries(orfane.markets || {}).map(([marketId, r]) => {
        const rec = r as { orfanaDa?: number; bookSuperstite?: string };
        const scadeA = typeof rec.orfanaDa === 'number' ? rec.orfanaDa + ORPHAN_LEG_TOLERANCE_MS : null;
        const resta = scadeA != null ? Math.max(0, scadeA - Date.now()) : null;
        return {
          marketId,
          book: rec.bookSuperstite ?? null,
          orfanaDa: rec.orfanaDa ?? null,
          orfanaDaIso: typeof rec.orfanaDa === 'number' ? new Date(rec.orfanaDa).toISOString() : null,
          scadeAms: scadeA,
          restaSec: resta != null ? Math.ceil(resta / 1000) : null,
        };
      }),
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

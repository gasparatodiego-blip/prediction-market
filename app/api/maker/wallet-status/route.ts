import { NextResponse } from 'next/server';
import { resolveFunder, venueAccountAddress } from '@/lib/venues/polymarket-clob-maker/funder';
// LO SNAPSHOT DELLE POSIZIONI È UN INTERRUTTORE COME GLI ALTRI, e finora non compariva qui.
// `lib/safety/risk-limits.js` rifiuta OGNI piazzamento quando non è leggibile — quindi questa pagina
// poteva dire «PRONTO» mentre ogni ordine veniva respinto, e l'unico modo di scoprirlo era provare a
// piazzare. Il 5 agosto 2026 è successo esattamente questo.
import { readVenuePositions, MAX_AGE_MS } from '@/lib/safety/venue-positions-snapshot';

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
    blockedBy: todo.length ? todo[0].who : null,
    todo,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

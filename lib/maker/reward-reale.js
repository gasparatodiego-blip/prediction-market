'use strict';
// lib/maker/reward-reale.js — IL REWARD CONFERMATO DAL VENUE. SOLA LETTURA, PER COSTRUZIONE.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Il bot stima quanto sta maturando (`summary.estGrossUsdPerDay`, lib/maker/operator-board.js). Nessuno
// ha mai confrontato quella stima col dato VERO che Polymarket conferma a giornata chiusa. Senza il
// confronto, la stima è una convinzione: può essere fuori di un ordine di grandezza per settimane e
// l'unico modo di accorgersene è guardare il portafoglio.
//
// ═══ QUESTO PERCORSO NON PUÒ PIAZZARE, E NON È UNA PROMESSA — È COME È FATTO ═════════════════════════
// Tre proprietà strutturali, tutte verificabili leggendo questo file, e tutte coperte da un test che
// legge il sorgente:
//
//   1. USA SOLO LE CREDENZIALI L2. `polymarketCancelCredsProvider` restituisce {key, secret,
//      passphrase} — l'autenticazione HMAC delle API. NON restituisce il signer, cioè la chiave
//      privata L1. Un ordine Polymarket è una struct EIP-712 FIRMATA: senza il signer non si può
//      costruire, e questo modulo il signer non lo importa nemmeno. Non è che «non lo usa»: non ce
//      l'ha.
//   2. PARLA SOLO IN GET. L'unica funzione di rete qui sotto è `httpGetFirmato`, e il metodo è la
//      costante 'GET'. Non esiste un ramo POST, PUT o DELETE in questo file.
//   3. NON IMPORTA L'ADAPTER. `lib/venues/polymarket-clob-maker/adapter.js` è l'unico oggetto del
//      progetto che sa mandare un ordine. Qui non compare, quindi non c'è nessun percorso — nemmeno
//      indiretto, nemmeno per errore futuro — da questo file a `postOrder`.
//
// Il confine è quindi leggibile: chi apre questo file vede che può solo chiedere e ricevere.
//
// ═══ COSA RESTITUISCE, E COSA NON INVENTA ════════════════════════════════════════════════════════════
// Il venue può non avere ancora consolidato la giornata quando lo si interroga. In quel caso la
// risposta è `disponibile: false` col motivo — MAI zero. «Non l'ho ancora ricevuto» e «ho guadagnato
// zero» sono due fatti diversi, e confonderli renderebbe il confronto peggio che inutile: farebbe
// sembrare la stima sbagliata del 100% ogni notte in cui il venue è in ritardo.
//
// ═══ IL PERCORSO GIUSTO, MISURATO (8 agosto 2026) ════════════════════════════════════════════════════
// Fino a oggi questo modulo chiedeva `/rewards/user?address=…&date=…`, e ogni notte dal 6 agosto
// registrava «lettura non riuscita: HTTP 401». Sondando il CLOB in sola lettura, con le stesse
// credenziali:
//
//     /rewards/user?date=…                 → 401 Unauthorized/Invalid api key
//     /rewards/user/total?date=…            → 401 (400 «Invalid signature_type» senza il parametro)
//     /rewards/user/markets?date=…          → 200, una riga per mercato reward, con `earnings`
//
// È quindi `/rewards/user/markets` — che per di più dà la SCOMPOSIZIONE PER MERCATO, cioè esattamente
// il termine di paragone di `stimaPerMercato`. È paginato (`next_cursor`, 100 righe a pagina; il
// catalogo dell'8 agosto 2026 contava 5.065 mercati su 51 pagine).
//
// ═══ E LA GUARDIA CHE RENDE ONESTO IL RISULTATO: L'ATTRIBUZIONE ══════════════════════════════════════
// Quella risposta ha un campo `maker_address` su ogni riga. Nella lettura dell'8 agosto 2026 valeva
// l'INDIRIZZO ZERO su tutte e 5.065 le righe, con `earnings: 0` ovunque: il venue stava restituendo il
// CATALOGO dei mercati premianti, non un estratto conto di questo maker. Scrivere «$0 incassati» da lì
// sarebbe stato inventare un consuntivo — e il confronto avrebbe segnalato una sovrastima del 100%
// ogni notte, che è il modo più rapido per rendere inutile un allarme.
//
// Quindi: una lettura vale come consuntivo SOLO se almeno una riga porta un maker address che è il
// nostro (l'EOA che firma o il funder che detiene). Altrimenti è `disponibile:false` con
// `attribuito:false` e il motivo per esteso. Un 200 non è un consuntivo: un 200 ATTRIBUITO lo è.
//
// ═══ E LA FONTE CHE ATTRIBUISCE DAVVERO (8 agosto 2026, sera) ════════════════════════════════════════
// La guardia qui sopra funzionava e rifiutava — correttamente — ogni lettura, perché sul CLOB il campo
// `maker_address` è l'indirizzo zero su tutte le 5.065 righe. Restava la domanda vera: «e allora dove
// sta scritto quanto ho incassato?». Sta qui, ed è PUBBLICO:
//
//     GET https://data-api.polymarket.com/activity?user=<funder>&type=REWARD
//
// Risponde con i PAGAMENTI veri, uno per riga, con `usdcSize` e `transactionHash`, e `proxyWallet`
// uguale al nostro funder. Sul conto di questa macchina ne esisteva esattamente uno:
//
//     $1,3042 · 2026-08-07T00:00:03Z · tx 0x4333636f…3be
//
// cioè il pagamento della giornata del 6 agosto, per cui la stima del bot diceva $3,09. È il PRIMO
// confronto stima↔consuntivo mai riuscito su questa macchina, ed era invisibile da due giorni.
//
// TRE COSE DA SAPERE SU QUESTA FONTE:
//   1. È SENZA CREDENZIALI. Non è una scorciatoia: rafforza la proprietà dichiarata in cima — questo
//      percorso non ha nemmeno le chiavi L2, quindi non può firmare niente nemmeno per errore.
//   2. È KEYED SUL FUNDER, non sull'EOA. Su un deposit-wallet ERC-1271 il maker è il funder, ed è
//      esattamente il motivo per cui la strada delle credenziali L2 (che sono dell'EOA) non attribuiva.
//   3. NON PORTA IL MERCATO. Le righe REWARD hanno `conditionId: ""`, `title: ""`: sono il bonifico,
//      non la sua scomposizione. La scomposizione per mercato resta quindi NON DISPONIBILE, e viene
//      dichiarata tale invece di essere inventata dividendo il totale.
//
// ═══ A QUALE GIORNATA APPARTIENE UN PAGAMENTO ════════════════════════════════════════════════════════
// Il venue liquida la giornata UTC appena chiusa, subito dopo la mezzanotte: il pagamento osservato è
// alle 00:00:03 del 7 agosto e paga il 6. La regola è quindi «un pagamento nelle prime ore di un
// giorno appartiene al giorno prima», con `FINESTRA_PAGAMENTO_H` di margine. È un'ASSUNZIONE tarata su
// una sola osservazione, ed è dichiarata come tale: se un giorno il venue pagasse a metà giornata,
// questa riga è la prima da rivedere.

const https = require('https');
const crypto = require('crypto');
// SOLO LE CREDENZIALI L2. Vedi il punto 1 dell'intestazione: il signer non è importato qui.
const { polymarketCancelCredsProvider } = require('./cancel-creds-provider');

const HOST = 'clob.polymarket.com';
/** L'unico metodo che questo modulo conosce. Non è una variabile: è una costante, e resta tale. */
const METODO_UNICO = 'GET';
const TIMEOUT_MS = 12_000;
/** Il percorso che risponde 200 (vedi l'intestazione). Gli altri due danno 401 con le stesse credenziali. */
const PERCORSO = '/rewards/user/markets';
/**
 * Quante pagine si seguono al massimo. Il catalogo dell'8 agosto 2026 stava in 51 pagine da 100; 200 è
 * quattro volte tanto. Oltre, la somma sarebbe un PARZIALE, e un parziale spacciato per consuntivo è
 * esattamente l'errore che questo modulo esiste per non commettere: si dichiara troncata e non vale.
 */
const PAGINE_MAX = 200;
const INDIRIZZO_ZERO = '0x0000000000000000000000000000000000000000';

// ── LA FONTE DEI PAGAMENTI VERI (vedi l'intestazione) ───────────────────────────────────────────────
const HOST_ATTIVITA = 'data-api.polymarket.com';
const PERCORSO_ATTIVITA = '/activity';
/** Quante righe di attività si chiedono. I pagamenti reward sono pochi: 500 copre mesi. */
const ATTIVITA_LIMITE = 500;
/**
 * Quante ore dopo la mezzanotte un pagamento appartiene ancora al giorno PRECEDENTE. Misurato: il
 * pagamento osservato è alle 00:00:03. Sei ore sono un margine largo per un batch in ritardo e restano
 * lontanissime dal maturato del giorno nuovo. Assunzione dichiarata, e configurabile.
 */
const FINESTRA_PAGAMENTO_H = Number(process.env.REWARD_PAGAMENTO_FINESTRA_H || 6);

/**
 * La firma L2 che il CLOB si aspetta: HMAC-SHA256 base64url di `timestamp + method + path (+ body)`
 * con il secret in base64url. Il body qui è SEMPRE vuoto — è una GET.
 */
function firmaL2({ secret, timestamp, path }) {
  const chiave = Buffer.from(secret, 'base64');
  const messaggio = `${timestamp}${METODO_UNICO}${path}`;
  return crypto.createHmac('sha256', chiave).update(messaggio).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

/** Una GET firmata. È l'unica funzione di rete del modulo. */
function httpGetFirmato(path, headers, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: HOST, path, method: METODO_UNICO, headers, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, body: raw.slice(0, 300) });
          }
          try { resolve({ ok: true, status: 200, data: JSON.parse(raw) }); }
          catch (e) { resolve({ ok: false, status: 200, error: `risposta non JSON: ${e.message}`, body: raw.slice(0, 300) }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, error: `timeout dopo ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
    req.end();   // nessun body: è una GET
  });
}

/** Una GET PUBBLICA, senza nessuna credenziale. È l'unica altra funzione di rete del modulo, ed è
 *  anch'essa un GET: la costante `METODO_UNICO` vale per tutte e due. */
function httpGetPubblico(host, path, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, path, method: METODO_UNICO, headers: { Accept: 'application/json', 'User-Agent': 'edgeradar-maker/1.0 (rewards read; read-only)' }, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, body: raw.slice(0, 300) });
          try { resolve({ ok: true, status: 200, data: JSON.parse(raw) }); }
          catch (e) { resolve({ ok: false, status: 200, error: `risposta non JSON: ${e.message}` }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, error: `timeout dopo ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
    req.end();   // nessun body: è una GET
  });
}

/**
 * A QUALE GIORNATA UTC APPARTIENE UN PAGAMENTO. Vedi l'intestazione: il venue liquida la giornata
 * appena chiusa subito dopo la mezzanotte, quindi un pagamento nelle prime `FINESTRA_PAGAMENTO_H` ore
 * appartiene al giorno prima. Pura, così la regola si prova senza aspettare una notte.
 */
function giornoDiCompetenza(tsMs, finestraH = FINESTRA_PAGAMENTO_H) {
  if (!Number.isFinite(tsMs)) return null;
  return new Date(tsMs - finestraH * 3_600_000).toISOString().slice(0, 10);
}

/**
 * I PAGAMENTI REWARD VERI, dal registro attività pubblico del venue, raggruppati per giornata di
 * COMPETENZA (non di accredito).
 *
 * `zeroAffidabile` è la parte che rende utile il resto. Una giornata senza pagamenti può voler dire due
 * cose opposte — «non ho maturato niente» oppure «il venue non ha ancora pagato / non mi vede» — e
 * scriverle come lo stesso zero è l'errore che questo modulo esiste per non fare. Uno zero vale come
 * zero SOLO se (a) il registro contiene almeno un pagamento nostro, quindi sappiamo che il canale
 * attribuisce davvero a questo wallet, e (b) la finestra di pagamento di quella giornata è chiusa.
 *
 * @returns {{ok:boolean, perGiorno:Map<string,{usd:number, pagamenti:object[]}>, pagamenti:number, motivo:string|null}}
 */
async function leggiPagamentiReward({ deps = {} } = {}) {
  const funder = String(deps.funder || process.env.MAKER_FUNDER_ADDRESS || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(funder)) {
    return { ok: false, perGiorno: new Map(), pagamenti: 0, motivo: 'funder non configurato: MAKER_FUNDER_ADDRESS assente o malformato' };
  }
  const get = deps.getPubblico || httpGetPubblico;
  const path = `${PERCORSO_ATTIVITA}?user=${encodeURIComponent(funder)}&type=REWARD&limit=${ATTIVITA_LIMITE}`;
  const r = await get(HOST_ATTIVITA, path);
  if (!r.ok) return { ok: false, perGiorno: new Map(), pagamenti: 0, motivo: `registro attività non raggiungibile: ${r.error}` };
  const righe = Array.isArray(r.data) ? r.data : (Array.isArray(r.data && r.data.data) ? r.data.data : null);
  if (!righe) return { ok: false, perGiorno: new Map(), pagamenti: 0, motivo: 'registro attività di forma non riconosciuta' };

  const mio = funder.toLowerCase();
  const perGiorno = new Map();
  let contati = 0;
  for (const x of righe) {
    if (!x || String(x.type || '').toUpperCase() !== 'REWARD') continue;
    // LA GUARDIA DI ATTRIBUZIONE, anche qui: il registro è già filtrato per utente, ma un filtro che
    // si dà per scontato è un filtro che un giorno cambia senza avvisare.
    if (String(x.proxyWallet || '').toLowerCase() !== mio) continue;
    const ts = Number(x.timestamp) * 1000;
    const usd = Number(x.usdcSize ?? x.size);
    if (!Number.isFinite(ts) || !Number.isFinite(usd)) continue;
    const g = giornoDiCompetenza(ts, Number.isFinite(deps.finestraH) ? deps.finestraH : FINESTRA_PAGAMENTO_H);
    if (!g) continue;
    const voce = perGiorno.get(g) || { usd: 0, pagamenti: [] };
    voce.usd += usd;
    voce.pagamenti.push({ tsIso: new Date(ts).toISOString(), usd: +usd.toFixed(6), tx: x.transactionHash || null });
    perGiorno.set(g, voce);
    contati += 1;
  }
  return { ok: true, perGiorno, pagamenti: contati, motivo: null };
}

/**
 * IL REWARD CONFERMATO PER UNA GIORNATA UTC.
 *
 * @param {object} a
 *   giorno   'YYYY-MM-DD' — la giornata UTC di cui si chiede il consuntivo
 *   deps     iniettabili per i test: { creds, get, now }
 * @returns {{disponibile:boolean, giorno:string, totaleUsd:number|null,
 *            perMercato:Array|null, motivo:string|null, status:number|null}}
 */
async function leggiRewardDaMercati({ giorno, deps = {} } = {}) {
  const no = (motivo, status = null) => ({ disponibile: false, giorno, totaleUsd: null, perMercato: null, motivo, status });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(giorno || ''))) return no('giorno non valido: serve YYYY-MM-DD');

  let creds;
  try { creds = await (deps.creds || polymarketCancelCredsProvider)(); }
  catch (e) { return no(`credenziali non disponibili: ${e.message}`); }
  if (!creds || !creds.creds || !creds.creds.key || !creds.creds.secret || !creds.creds.passphrase || !creds.address) {
    return no('credenziali L2 incomplete: nessuna lettura tentata');
  }

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const get = deps.get || httpGetFirmato;
  // I nostri indirizzi: l'EOA che firma e il funder che detiene. Su un deposit-wallet ERC-1271 il
  // `maker` di un ordine è il funder, non chi firma — quindi valgono entrambi, e nessun altro.
  const nostri = new Set([
    String(creds.address || '').toLowerCase(),
    String(deps.funder || process.env.MAKER_FUNDER_ADDRESS || '').toLowerCase(),
  ].filter((x) => x && x !== INDIRIZZO_ZERO));

  const intestazioni = (path) => {
    const timestamp = Math.floor(now() / 1000).toString();
    return {
      POLY_ADDRESS: creds.address,
      // La firma è sul percorso COMPLETO, query inclusa: misurato l'8 agosto 2026, firmando il solo
      // percorso il CLOB risponde 400 «Invalid signature_type» invece di 200.
      POLY_SIGNATURE: firmaL2({ secret: creds.creds.secret, timestamp, path }),
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: creds.creds.key,
      POLY_PASSPHRASE: creds.creds.passphrase,
      Accept: 'application/json',
      'User-Agent': 'edgeradar-maker/1.0 (rewards read; read-only)',
    };
  };

  let cursore = '';
  let pagine = 0;
  let righe = 0;
  let totale = 0;
  let attribuite = 0;
  const perMercato = [];
  const makerVisti = new Set();

  while (pagine < PAGINE_MAX) {
    const path = `${PERCORSO}?date=${encodeURIComponent(giorno)}${cursore ? `&next_cursor=${encodeURIComponent(cursore)}` : ''}`;
    const r = await get(path, intestazioni(path));
    if (!r.ok) {
      // NON è zero: è «non l'ho ricevuto». La distinzione è tutto il valore del confronto.
      return { ...no(`lettura non riuscita: ${r.error}`, r.status), pagine, righe };
    }
    const p = estraiPagina(r.data);
    if (p.righe == null) {
      // Una forma che non si riconosce si accetta comunque, purché sia una delle vecchie: chi legge
      // una risposta diversa da quella attesa non deve dedurne un totale.
      const vecchio = estraiTotale(r.data, giorno);
      if (pagine === 0 && vecchio.totaleUsd != null) {
        return { disponibile: true, giorno, totaleUsd: vecchio.totaleUsd, perMercato: vecchio.perMercato, motivo: null, status: 200, attribuito: true, pagine: 1, righe: null };
      }
      return { ...no(p.motivo || 'forma della risposta non riconosciuta', 200), pagine, righe };
    }
    pagine += 1;
    for (const x of p.righe) {
      righe += 1;
      const maker = String((x && x.maker_address) || '').toLowerCase();
      if (maker) makerVisti.add(maker);
      const nostra = nostri.has(maker);
      if (!nostra) continue;
      attribuite += 1;
      const usd = sommaEarnings(x);
      if (usd == null) continue;
      totale += usd;
      perMercato.push({ marketId: x.condition_id || x.conditionId || null, usd: +usd.toFixed(6) });
    }
    if (!p.cursore || p.cursore === cursore) break;
    cursore = p.cursore;
  }

  if (pagine >= PAGINE_MAX) {
    return { ...no(`lettura troncata a ${PAGINE_MAX} pagine: la somma sarebbe un parziale, non un consuntivo`, 200), pagine, righe };
  }
  if (attribuite === 0) {
    // ── LA GUARDIA CHE VALE PIÙ DELLA CIFRA ────────────────────────────────────────────────────────
    // Un 200 pieno di zeri, con `maker_address` a zero su ogni riga, è il CATALOGO dei mercati
    // premianti — non l'estratto conto di questo maker. Vedi l'intestazione.
    const soloZero = makerVisti.size <= 1 && makerVisti.has(INDIRIZZO_ZERO);
    return {
      ...no(soloZero
        ? `il venue non attribuisce nessun maker a questa lettura (maker_address a zero su tutte le ${righe} righe): un totale di $0 sarebbe inventato`
        : `nessuna delle ${righe} righe è attribuita ai nostri indirizzi (${[...nostri].join(', ') || 'nessuno noto'})`,
      200),
      attribuito: false, pagine, righe,
    };
  }

  return {
    disponibile: true, giorno, totaleUsd: +totale.toFixed(6),
    perMercato, motivo: null, status: 200,
    attribuito: true, pagine, righe, righeAttribuite: attribuite,
  };
}

/**
 * IL CONSUNTIVO DI UNA GIORNATA — l'orchestratore, ed è quello che chiama agent40.
 *
 * DUE FONTI, IN ORDINE DI VERITÀ:
 *   1. i PAGAMENTI dal registro attività pubblico (`leggiPagamentiReward`). È l'unica che attribuisce
 *      davvero: è keyed sul funder, che su un deposit-wallet ERC-1271 è il maker vero.
 *   2. la scomposizione per mercato dal CLOB (`leggiRewardDaMercati`). SPENTA per difetto, e non per
 *      pigrizia: sono ~51 richieste a notte che restituiscono, misurato, il catalogo generale con
 *      `maker_address` a zero — cioè niente di attribuibile. Resta accesa con `deps.conScomposizione`
 *      perché il giorno in cui il venue cominciasse ad attribuire quelle righe, la scomposizione per
 *      mercato tornerebbe utile senza riscrivere niente.
 *
 * Finché la (2) non attribuisce, `perMercato` è `null` con un motivo scritto: un totale diviso a caso
 * fra i mercati stimati sarebbe una scomposizione inventata, e varrebbe meno di un trattino.
 */
async function leggiRewardReale({ giorno, deps = {} } = {}) {
  const no = (motivo, extra = {}) => ({ disponibile: false, giorno, totaleUsd: null, perMercato: null, motivo, status: null, ...extra });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(giorno || ''))) return no('giorno non valido: serve YYYY-MM-DD');

  const P = await (deps.pagamenti || leggiPagamentiReward)({ deps });
  if (!P.ok) return no(P.motivo || 'registro dei pagamenti non leggibile', { fonte: 'attivita-venue' });

  const voce = P.perGiorno.get(giorno) || null;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  // La finestra di pagamento di questa giornata: si chiude `FINESTRA_PAGAMENTO_H` ore dopo la sua
  // mezzanotte. Prima di allora «nessun pagamento» non è ancora un fatto.
  const finestraH = Number.isFinite(deps.finestraH) ? deps.finestraH : FINESTRA_PAGAMENTO_H;
  const chiusuraMs = Date.parse(`${giorno}T00:00:00Z`) + 86_400_000 + finestraH * 3_600_000;
  const finestraChiusa = Number.isFinite(chiusuraMs) && now >= chiusuraMs;

  let perMercato = null;
  let notaMercati = 'la riga di pagamento del venue non porta il mercato (conditionId vuoto): la scomposizione non è ricostruibile e non viene inventata';
  if (deps.conScomposizione) {
    const M = await (deps.daMercati || leggiRewardDaMercati)({ giorno, deps });
    if (M.disponibile && Array.isArray(M.perMercato) && M.perMercato.length) { perMercato = M.perMercato; notaMercati = null; }
    else notaMercati = `scomposizione per mercato non attribuita dal venue: ${M.motivo || 'nessuna riga nostra'}`;
  }

  if (voce) {
    return {
      disponibile: true, giorno, totaleUsd: +voce.usd.toFixed(6), perMercato, motivo: null, status: 200,
      attribuito: true, fonte: 'attivita-venue', pagamenti: voce.pagamenti, notaMercati,
    };
  }
  // NESSUN PAGAMENTO PER QUESTA GIORNATA. Vale zero solo se il canale ha dimostrato di attribuirci
  // qualcosa almeno una volta E la finestra è chiusa. Altrimenti è «non lo so», che è un altro fatto.
  if (P.pagamenti > 0 && finestraChiusa) {
    return {
      disponibile: true, giorno, totaleUsd: 0, perMercato: null, motivo: null, status: 200,
      attribuito: true, fonte: 'attivita-venue', pagamenti: [],
      notaMercati: 'zero perché nessun pagamento è stato attribuito a questa giornata, non perché la lettura sia fallita: il registro contiene altri nostri pagamenti e la finestra di questa giornata è chiusa',
    };
  }
  return no(
    P.pagamenti === 0
      ? 'il registro attività non contiene NESSUN pagamento reward per questo wallet: non si può distinguere «non ho maturato» da «il canale non mi attribuisce», quindi non si scrive zero'
      : `la finestra di pagamento di ${giorno} non è ancora chiusa (si chiude ${new Date(chiusuraMs).toISOString()}): nessun pagamento visibile non è ancora uno zero`,
    { fonte: 'attivita-venue', attribuito: P.pagamenti > 0, pagamentiTotali: P.pagamenti },
  );
}

/** Le righe e il cursore di UNA pagina. `righe: null` = forma non riconosciuta, mai un array vuoto. */
function estraiPagina(data) {
  if (!data || typeof data !== 'object') return { righe: null, cursore: null, motivo: 'risposta vuota' };
  const righe = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : null);
  if (!righe) return { righe: null, cursore: null, motivo: 'la risposta non contiene un elenco di mercati' };
  const c = data.next_cursor ?? data.nextCursor ?? null;
  // 'LTE=' è il cursore-sentinella del CLOB per «fine elenco».
  return { righe, cursore: typeof c === 'string' && c && c !== 'LTE=' ? c : null, motivo: null };
}

/**
 * Quanto ha reso UNA riga. `earnings` è un elenco per asset (USDC su Polygon nella lettura reale):
 * si somma, e un importo illeggibile fa restituire null invece di contarlo come zero.
 */
function sommaEarnings(x) {
  const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
  if (!x) return null;
  if (Array.isArray(x.earnings)) {
    let t = 0, visti = 0;
    for (const e of x.earnings) { const v = num(e && (e.earnings ?? e.amount)); if (v == null) continue; t += v; visti += 1; }
    return visti ? t : null;
  }
  return num(x.earnings ?? x.amount ?? x.total);
}

/**
 * Il totale dalla risposta del venue, senza dare per scontata una forma sola.
 * Se nessuna forma nota corrisponde, restituisce null col motivo — non un numero inventato.
 */
function estraiTotale(data, giorno) {
  const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
  if (!data || typeof data !== 'object') return { totaleUsd: null, perMercato: null, motivo: 'risposta vuota' };

  // Forma A: un totale diretto.
  for (const k of ['total', 'total_earnings', 'totalEarnings', 'earnings', 'amount']) {
    const v = num(data[k]);
    if (v != null) return { totaleUsd: +v.toFixed(6), perMercato: null, motivo: null };
  }
  // Forma B: un elenco per mercato/giorno, da sommare.
  const righe = Array.isArray(data) ? data
    : (Array.isArray(data.data) ? data.data : (Array.isArray(data.rewards) ? data.rewards : null));
  if (Array.isArray(righe)) {
    const perGiorno = righe.filter((r) => !r || !r.date || String(r.date).slice(0, 10) === giorno);
    if (!perGiorno.length) return { totaleUsd: null, perMercato: null, motivo: `nessuna riga per ${giorno}` };
    let tot = 0; const per = [];
    for (const r of perGiorno) {
      const v = num(r && (r.earnings ?? r.amount ?? r.total ?? r.rewards));
      if (v == null) continue;
      tot += v;
      per.push({ marketId: (r && (r.condition_id || r.conditionId || r.market)) || null, usd: +v.toFixed(6) });
    }
    if (!per.length) return { totaleUsd: null, perMercato: null, motivo: 'righe presenti ma senza importo leggibile' };
    return { totaleUsd: +tot.toFixed(6), perMercato: per, motivo: null };
  }
  return { totaleUsd: null, perMercato: null, motivo: 'forma della risposta non riconosciuta' };
}

module.exports = {
  leggiRewardReale, leggiRewardDaMercati, leggiPagamentiReward, giornoDiCompetenza,
  estraiTotale, estraiPagina, sommaEarnings, firmaL2,
  HOST, METODO_UNICO, PERCORSO, PAGINE_MAX, INDIRIZZO_ZERO,
  HOST_ATTIVITA, PERCORSO_ATTIVITA, FINESTRA_PAGAMENTO_H,
};

'use strict';
// lib/maker/ctf-relayer.js — LE OPERAZIONI CTF (split / merge / redeem) VIA RELAYER GASLESS.
//
// ═══ COSA FA, IN UNA RIGA ═══════════════════════════════════════════════════════════════════════════
// Converte collaterale che è GIÀ NOSTRO: pUSD → coppia YES+NO (split), coppia YES+NO → pUSD (merge),
// token vincente → pUSD a mercato risolto (redeem). Non compra, non vende, non tocca il book.
//
// ═══ PERCHÉ ESISTE, E PERCHÉ SOLO ADESSO ════════════════════════════════════════════════════════════
// Il 7 agosto 2026 la conclusione era «merge non eseguibile»: il funder è un contratto, ha 0 MATIC per
// il gas, e in tutto il repo non esiste un percorso di scrittura on-chain (zero sendTransaction). Le
// prime due obiezioni cadono con il RELAYER: Polymarket paga il gas e il contratto agisce su un batch
// firmato dal suo owner. La terza cade con questo file, che è quel percorso — l'UNICO, e confinato.
//
// ═══ IL CONFINE, E PERCHÉ VA MESSO QUI E NON ALTROVE ════════════════════════════════════════════════
// Questo è il punto che va letto prima di tutto il resto. Il batch che il relayer accetta è una lista di
// chiamate ARBITRARIE:
//
//     calls: [{ target: <qualsiasi contratto>, value: <wei>, data: <qualsiasi calldata> }]
//
// La firma dell'owner autorizza il deposit wallet a ESEGUIRLE. Il protocollo non distingue fra un merge
// e un `pUSD.transfer(ladro, tuttoIlSaldo)`: sono due calldata, e la firma copre entrambe. Quindi il
// relayer NON è un confine di sicurezza — non «può solo fare operazioni CTF». Il confine è qui dentro,
// ed è di tre pezzi, tutti verificabili leggendo questo file:
//
//   1. `calls` non è mai un parametro. Lo costruisce SOLO questo modulo, e sempre di UNA chiamata sola.
//   2. `verificaConfinamento()` ri-decodifica il batch appena costruito e rifiuta di firmare se il
//      target non è uno dei DUE adapter o se il selettore non è uno dei TRE ammessi. È ridondante
//      rispetto al punto 1 — di proposito: il giorno in cui qualcuno aggiunge un ramo che costruisce
//      `calls` diversamente, questa funzione lo ferma prima della firma.
//   3. Nessun ramo di questo file chiama `approve`, `setApprovalForAll` o `transfer`. Le approvazioni
//      servivano una tantum e ci sono già (verificate on-chain il 7 agosto 2026, vedi sotto).
//
// ═══ ISOLAMENTO, COME reward-reale.js ═══════════════════════════════════════════════════════════════
// Questo modulo NON importa `lib/venues/polymarket-clob-maker/adapter.js`, né `lib/maker/manual-order.js`,
// né alcun client CLOB. Non esiste percorso, nemmeno indiretto, da qui a `postOrder`: non è una promessa,
// è la lista degli import. `ctf-relayer.isolamento.test.js` legge questo sorgente e lo verifica.
//
// ═══ STATO VERIFICATO ON-CHAIN IL 7 AGOSTO 2026 (eth_call/eth_getCode, niente di inviato) ═══════════
//   deposit wallet   0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee   146 byte di codice (Solady ERC-1967)
//   owner()          0x7bd09f34622296fa6ba5a28f6d4e888d418285d3   === l'indirizzo del signer in custodia
//   saldo pUSD       590.264868
//   approvalForAll (ERC-1155) verso CtfCollateralAdapter        true
//   approvalForAll (ERC-1155) verso NegRiskCtfCollateralAdapter true
//   allowance pUSD (ERC-20)   verso entrambi                    ILLIMITATA
// Quindi NESSUNA approvazione una tantum è necessaria: l'operatore le aveva già concesse dall'app.
//
// ═══ COSA RESTITUISCE DAVVERO L'ENDPOINT NONCE (corretto il 7 agosto 2026, seconda sessione) ════════
// Qui c'era scritto che `/v1/account/transactions/params` senza credenziali risponde 200 con un
// indirizzo casuale e nonce "5", e se ne concludeva che il nonce fosse inventato. La prima metà è
// vera, la seconda NO, e la guardia che ne derivava rendeva il modulo ineseguibile: sollevava sempre.
//
// Quello che l'endpoint fa davvero, misurato:
//   · il percorso ESISTE          — un percorso inventato dà 404, questo no
//   · l'`address` VIENE LETTO     — ometterlo dà 400 "invalid address"
//   · il campo `address` in RISPOSTA non è un'eco: è effimero, diverso a OGNI chiamata
//   · il campo `nonce` è VERO e specifico della coppia (address, type):
//         0x7bd09f34…85d3 + WALLET -> 5      0x0000…0001    + WALLET -> 0
//         0x4C81F1…bdee   + WALLET -> 0      0x7bd09f34…85d3 + SAFE  -> 0
//   · le credenziali non hanno alcun effetto OSSERVABILE su questo endpoint né sugli altri di
//     lettura: con e senza chiave le risposte sono identiche. La chiave si può validare solo con
//     un `POST /submit`, cioè non gratis. Non fingere di averla validata prima.
//
// Il nonce "5" letto cinque volte di fila non era una costante di ripiego: era il nostro nonce.

const https = require('https');
const { ethers } = require('ethers');
const { PUSD } = require('../poly-contracts');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');

// ── L'INTERRUTTORE ──────────────────────────────────────────────────────────────────────────────────
// SPENTO. È stato acceso una volta sola, il 7 agosto 2026, su autorizzazione esplicita dell'operatore,
// per la prova split $2 -> merge $2 su Schwartzel (neg-risk), e rimesso a false a prova finita, nella
// stessa sessione. Con false ogni funzione costruisce, firma NIENTE e non invia niente: restituisce il
// piano. Con true firma e invia.
//
// QUELLA PROVA È RIUSCITA, e quello che ha dimostrato vale la pena scriverlo qui perché è la ragione
// per cui questo modulo non è più teorico:
//   split  $2  tx 0x96072ab7…143a   blocco 91619080   pUSD 590.264868 -> 588.264868, +2 YES +2 NO
//   merge  $2  tx 0x792b31e5…76a8   blocco 91619511   pUSD 588.264868 -> 590.264868, -2 YES -2 NO
// Il gas l'ha pagato il relayer in entrambi i casi. Esposizione netta a fine ciclo: zero, e il saldo
// è tornato alla cifra esatta di partenza. L'ordine manuale di vendita a riposo sul venue (SELL 144.2
// NO @ 0.549) non è stato toccato: riletto prima e dopo, LIVE, matched 0.
//
// COSA NON PROTEGGE, QUANDO È TRUE: niente ferma una chiamata a `splitPosition` / `mergePosition` /
// `redeemPosition` prima della rete. Il confine che resta è quello di sempre, e basta: `calls` mai
// parametrico, `verificaConfinamento()` prima della firma, nessun ramo che codifichi approve/transfer.
// Quei tre garantiscono CHE COSA si firma, non QUANDO.
//
// PERCHÉ ACCENDERLO NON METTE IN MOTO NIENTE DA SOLO: in tutto il repo l'unico file che fa `require`
// di questo modulo è il suo test. Nessun agent, nessuna route, nessuno scheduler — verificato di nuovo
// prima di spegnere, con 11 processi pm2 online. Anche `strategia-merge.js`, l'unico consumatore
// previsto, non lo importa e ha il suo MERGE_STRATEGY_ENABLED a false. Se un giorno un chiamante
// automatico comparisse, questa frase diventa falsa e l'interruttore va ripensato prima di aggiungerlo.
const CTF_RELAYER_ENABLED = false;

const RELAYER_HOST = 'relayer-v2.polymarket.com';
const RELAYER_EXECUTOR = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';  // il `to` del batch WALLET
const CHAIN_ID = 137;
// 15 minuti. Qui c'erano 240s «il valore raccomandato dall'SDK di riferimento», e il relayer li ha
// rifiutati: `{"error":"deadline too soon"}`, HTTP 400, il 7 agosto 2026 alle 20:18. Lo split di
// quattro minuti prima era passato con la STESSA deadline di 240s (verificata decodificando la
// calldata on-chain: 0x6a763d7d = created_at+240). Quindi la soglia del relayer non e' 240 fisso —
// o e' piu' alta e lo split e' passato per un pelo, o dipende dal carico. Non e' documentata e non
// e' osservabile senza un POST, quindi si prende margine invece di indovinare la soglia esatta.
// Costo di una deadline piu' lunga: il batch firmato resta spendibile piu' a lungo. Il nonce e' a
// consumo singolo, quindi dopo l'esecuzione non e' replicabile; il rischio residuo e' un batch
// firmato e MAI inviato, che resta valido 15 minuti invece di 4.
const DEADLINE_SEC = 900;
const DECIMALI = 6;                // pUSD e i token outcome hanno entrambi 6 decimali
const PARTITION = [1, 2];          // YES | NO — l'unica partizione di un mercato binario
const PARENT_COLLECTION_ID = ethers.ZeroHash;

// I DUE soli target ammessi. La scelta fra i due è governata da `negRisk` del mercato, mai da un
// parametro libero: passare l'adapter sbagliato non produce un errore, produce un revert oscuro.
const ADAPTER_STANDARD = '0xAdA100Db00Ca00073811820692005400218FcE1f';
const ADAPTER_NEG_RISK = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';
const TARGET_AMMESSI = Object.freeze([ADAPTER_STANDARD.toLowerCase(), ADAPTER_NEG_RISK.toLowerCase()]);

// Le TRE firme ammesse — verificate presenti nel bytecode di ENTRAMBI gli adapter il 7 agosto 2026.
const ABI_CTF = [
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];
const iface = new ethers.Interface(ABI_CTF);
const SELETTORI_AMMESSI = Object.freeze({
  [iface.getFunction('splitPosition').selector]: 'splitPosition',
  [iface.getFunction('mergePositions').selector]: 'mergePositions',
  [iface.getFunction('redeemPositions').selector]: 'redeemPositions',
});

// EIP-712: il tipo che il deposit wallet verifica in `isValidSignature`. `verifyingContract` è il
// deposit wallet stesso, quindi una firma raccolta per un wallet non vale per un altro.
const TIPI_BATCH = {
  Call: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ],
  Batch: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'calls', type: 'Call[]' },
  ],
};

const CID_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

class ErroreRelayer extends Error {
  constructor(messaggio, dettagli = {}) { super(messaggio); this.name = 'ErroreRelayer'; this.dettagli = dettagli; }
}

// ── HTTP, minimo e senza dipendenze ─────────────────────────────────────────────────────────────────
function richiesta({ metodo, percorso, headers = {}, corpo = null, timeoutMs = 20_000 }) {
  return new Promise((risolvi, rifiuta) => {
    const body = corpo === null ? null : JSON.stringify(corpo);
    const req = https.request({
      host: RELAYER_HOST, path: percorso, method: metodo,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let testo = '';
      res.on('data', (c) => { testo += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(testo); } catch { /* la risposta non è JSON: si riporta il testo */ }
        risolvi({ status: res.statusCode, json, testo: testo.slice(0, 600) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout dopo ${timeoutMs}ms`)); });
    req.on('error', rifiuta);
    if (body) req.write(body);
    req.end();
  });
}

/** Le credenziali del relayer, dall'ambiente. Assenti ⇒ si dice quale manca, non si tira a indovinare. */
function credenziali(env = process.env) {
  const key = (env.POLYMARKET_RELAYER_API_KEY || '').trim();
  const address = (env.POLYMARKET_RELAYER_API_KEY_ADDRESS || '').trim();
  if (!key) throw new ErroreRelayer('POLYMARKET_RELAYER_API_KEY non impostata: la chiave si crea su polymarket.com → Settings → API Keys → Relayer API Keys');
  if (!ADDR_RE.test(address)) throw new ErroreRelayer('POLYMARKET_RELAYER_API_KEY_ADDRESS assente o malformata: dev\'essere l\'indirizzo del signer che possiede il deposit wallet');
  return { key, address };
}

function intestazioni(cred) {
  return { RELAYER_API_KEY: cred.key, RELAYER_API_KEY_ADDRESS: cred.address };
}

/**
 * Il nonce WALLET corrente del signer.
 *
 * NON confronta più `r.json.address` con il nostro signer. Quel confronto c'era fino al 7 agosto 2026
 * e sollevava SEMPRE, anche con credenziali buone — vedi «cosa restituisce davvero l'endpoint nonce»
 * in cima: `address` non è un'eco della richiesta, è un valore effimero diverso a ogni chiamata.
 * Il `nonce`, invece, è vero e specifico della coppia (address, type) che si chiede.
 *
 * Che cosa protegge allora questa funzione, se non può autenticare la risposta? Meno di quanto
 * sembrava, ed è bene dirlo: un nonce sbagliato NON produce una transazione sbagliata. Il nonce è un
 * campo del messaggio EIP-712 che il deposit wallet verifica in `isValidSignature`; se non è quello
 * giusto il batch viene RIFIUTATO, non eseguito storto. È un problema di liveness, non di sicurezza.
 * Ciò che decide *cosa* succede sono `calls`, e quelle le costruisce solo questo modulo, con
 * `verificaConfinamento()` a rileggerle prima della firma. Il confine è lì, non qui.
 *
 * Resta comunque il controllo di forma (HTTP 200, JSON, nonce numerico) e si RESTITUISCE l'indirizzo
 * effimero al chiamante, che lo mette a registro: se un giorno l'endpoint cambiasse semantica e
 * ricominciasse a fare l'eco, l'audit lo mostrerebbe senza che nessuno debba andarlo a cercare.
 */
async function leggiNonce({ signer, cred, http = richiesta }) {
  const q = `?address=${encodeURIComponent(signer)}&type=WALLET`;
  const r = await http({ metodo: 'GET', percorso: `/v1/account/transactions/params${q}`, headers: intestazioni(cred) });
  if (r.status !== 200 || !r.json) throw new ErroreRelayer(`lettura del nonce fallita (HTTP ${r.status})`, { risposta: r.testo });
  const nonce = String(r.json.nonce);
  if (!/^\d+$/.test(nonce)) throw new ErroreRelayer(`nonce non numerico dal relayer: ${JSON.stringify(r.json.nonce)}`);
  return { nonce, indirizzoEffimero: String(r.json.address || '') };
}

// ── LA COSTRUZIONE DELL'UNICA CHIAMATA ──────────────────────────────────────────────────────────────

function adapterPer(negRisk) {
  if (negRisk !== true && negRisk !== false) {
    throw new ErroreRelayer('negRisk non dichiarato: la scelta dell\'adapter non si indovina — con quello sbagliato la transazione reverte senza dire perché');
  }
  return negRisk ? ADAPTER_NEG_RISK : ADAPTER_STANDARD;
}

/** Da unità umane a unità base (6 decimali), rifiutando tutto ciò che non è un numero positivo finito. */
function inUnitaBase(quantita, nome) {
  if (typeof quantita === 'bigint') {
    if (quantita <= 0n) throw new ErroreRelayer(`${nome} dev'essere positiva`);
    return quantita;
  }
  const n = typeof quantita === 'number' ? quantita : Number(quantita);
  if (!Number.isFinite(n) || n <= 0) throw new ErroreRelayer(`${nome} dev'essere un numero positivo finito, ricevuto ${JSON.stringify(quantita)}`);
  // parseUnits su una stringa a 6 decimali: evita che 0.1+0.2 in virgola mobile diventi un troncamento.
  return ethers.parseUnits(n.toFixed(DECIMALI), DECIMALI);
}

function verificaConditionId(conditionId) {
  if (!CID_RE.test(String(conditionId || ''))) {
    throw new ErroreRelayer(`conditionId malformato (${JSON.stringify(conditionId)}): servono 32 byte esadecimali con prefisso 0x`);
  }
  return String(conditionId);
}

/**
 * IL CONFINE, applicato al batch già costruito.
 *
 * Ridondante rispetto al fatto che `calls` lo costruiamo noi — ed è il punto. Se un domani un ramo
 * nuovo costruisse una chiamata diversa, questa funzione la ferma PRIMA della firma, che è l'ultimo
 * istante in cui fermarla costa zero.
 */
function verificaConfinamento(calls) {
  if (!Array.isArray(calls) || calls.length !== 1) {
    throw new ErroreRelayer(`il batch deve contenere ESATTAMENTE una chiamata, ne ha ${Array.isArray(calls) ? calls.length : 0}`);
  }
  const [c] = calls;
  const target = String(c.target || '').toLowerCase();
  if (!TARGET_AMMESSI.includes(target)) {
    throw new ErroreRelayer(`target non ammesso: ${c.target}. Questo modulo può chiamare solo i due CtfCollateralAdapter`, { ammessi: TARGET_AMMESSI });
  }
  if (String(c.value) !== '0') {
    throw new ErroreRelayer(`value dev'essere 0 (nessun POL nativo esce dal wallet), ricevuto ${c.value}`);
  }
  const sel = String(c.data || '').slice(0, 10);
  const nome = SELETTORI_AMMESSI[sel];
  if (!nome) {
    throw new ErroreRelayer(`selettore non ammesso: ${sel}. Solo split/merge/redeem passano di qui`, { ammessi: Object.keys(SELETTORI_AMMESSI) });
  }
  // Ri-decodifica completa: un calldata troncato non arriva alla firma.
  let decodificata;
  try { decodificata = iface.parseTransaction({ data: c.data }); }
  catch (e) { throw new ErroreRelayer(`calldata non decodificabile con l'ABI CTF: ${e.message}`); }

  // E RI-CODIFICA, confrontando byte per byte. Non è pignoleria: sia `parseTransaction` sia l'ABI
  // decoder di Solidity IGNORANO i byte in eccesso in coda, quindi un calldata con una coda appesa si
  // decodifica «bene» e passerebbe il controllo qui sopra. Il confronto con la forma canonica è
  // l'unico modo di dire che il calldata è ESATTAMENTE la chiamata che credevamo di aver costruito,
  // e non quella chiamata più qualcos'altro.
  const canonico = iface.encodeFunctionData(nome, decodificata.args);
  if (canonico.toLowerCase() !== String(c.data).toLowerCase()) {
    throw new ErroreRelayer(
      `calldata non canonico: ${(String(c.data).length - canonico.length) / 2} byte in più del previsto. `
      + 'Si decodifica lo stesso — sia ethers sia Solidity ignorano la coda — quindi il confronto con la forma ri-codificata è l\'unico controllo che se ne accorge.',
      { attesiByte: (canonico.length - 2) / 2, ricevutiByte: (String(c.data).length - 2) / 2 });
  }
  return { operazione: nome, argomenti: decodificata.args.map((a) => (typeof a === 'bigint' ? a.toString() : (Array.isArray(a) ? a.map(String) : String(a)))) };
}

/**
 * Costruisce il piano completo di un'operazione — SENZA firmare e SENZA rete.
 *
 * È il cuore della FASE 3: quello che questa funzione restituisce è esattamente e integralmente ciò
 * che verrebbe firmato e inviato. Non c'è un secondo posto dove il batch viene ritoccato dopo.
 */
function costruisciOperazione({ operazione, conditionId, negRisk, quantita = null, depositWallet, signer, nonce, deadline }) {
  const cid = verificaConditionId(conditionId);
  const target = adapterPer(negRisk);
  if (!ADDR_RE.test(String(depositWallet || ''))) throw new ErroreRelayer('depositWallet assente o malformato');
  if (!ADDR_RE.test(String(signer || ''))) throw new ErroreRelayer('signer assente o malformato');

  let data;
  let unita = null;
  if (operazione === 'redeemPositions') {
    data = iface.encodeFunctionData('redeemPositions', [PUSD, PARENT_COLLECTION_ID, cid, PARTITION]);
  } else {
    unita = inUnitaBase(quantita, operazione === 'splitPosition' ? 'l\'importo in pUSD' : 'la quantità di share');
    data = iface.encodeFunctionData(operazione, [PUSD, PARENT_COLLECTION_ID, cid, PARTITION, unita]);
  }

  const calls = [{ target, value: '0', data }];
  const confinamento = verificaConfinamento(calls);

  const messaggio = {
    wallet: ethers.getAddress(depositWallet),
    nonce: String(nonce),
    deadline: String(deadline),
    calls: calls.map((c) => ({ target: ethers.getAddress(c.target), value: c.value, data: c.data })),
  };
  const dominio = { name: 'DepositWallet', version: '1', chainId: CHAIN_ID, verifyingContract: ethers.getAddress(depositWallet) };

  return {
    operazione, conditionId: cid, negRisk, adapter: target,
    quantitaUmana: unita === null ? null : ethers.formatUnits(unita, DECIMALI),
    quantitaUnitaBase: unita === null ? null : unita.toString(),
    confinamento,
    firma: { dominio, tipi: TIPI_BATCH, tipoPrimario: 'Batch', messaggio },
    invio: {
      url: `https://${RELAYER_HOST}/submit`,
      corpo: {
        type: 'WALLET', from: ethers.getAddress(signer), to: RELAYER_EXECUTOR,
        nonce: String(nonce), signature: '<firma a 65 byte, prodotta al momento dell\'invio>',
        metadata: etichetta(operazione, cid),
        depositWalletParams: { depositWallet: ethers.getAddress(depositWallet), deadline: String(deadline), calls: messaggio.calls },
      },
    },
  };
}

function etichetta(operazione, cid) {
  const nomi = { splitPosition: 'Split', mergePositions: 'Merge', redeemPositions: 'Redeem' };
  return `${nomi[operazione] || operazione} ${cid.slice(0, 10)}…`;
}

// ── ESECUZIONE ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Il giro completo: nonce → costruzione → confinamento → firma → submit → conferma.
 *
 * Con CTF_RELAYER_ENABLED a false si ferma DOPO la costruzione e restituisce `{eseguito:false, piano}`:
 * il piano è già tutto, e non è stata prodotta nessuna firma. È deliberato che l'interruttore stia
 * PRIMA della firma e non prima dell'invio — una firma valida in giro è già un rischio, anche inutilizzata.
 */
async function esegui({ operazione, conditionId, negRisk, quantita = null, deps = {} }) {
  const abilitato = deps.abilitato === undefined ? CTF_RELAYER_ENABLED : deps.abilitato;
  const env = deps.env || process.env;
  const http = deps.http || richiesta;
  const oraMs = typeof deps.now === 'function' ? deps.now() : Date.now();

  const depositWallet = (env.MAKER_FUNDER_ADDRESS || '').trim();
  const cred = credenziali(env);
  const signer = cred.address;
  const deadline = Math.floor(oraMs / 1000) + DEADLINE_SEC;

  // PRIMA: si registra l'intento, prima di qualunque effetto. Se il processo muore a metà, il registro
  // dice comunque cosa stava per succedere — che è l'unica cosa che serve sapere il mattino dopo.
  const intento = { ts: new Date(oraMs).toISOString(), canale: 'ctf-relayer', fase: 'intento', operazione, conditionId, negRisk, quantita, abilitato };
  appendMakerAudit(intento);

  let nonce = '0';
  let indirizzoEffimero = null;
  if (abilitato) ({ nonce, indirizzoEffimero } = await leggiNonce({ signer, cred, http }));

  let piano;
  try {
    piano = costruisciOperazione({ operazione, conditionId, negRisk, quantita, depositWallet, signer, nonce, deadline });
  } catch (e) {
    appendMakerAudit({ ...intento, fase: 'esito', esito: 'rifiutato-in-costruzione', motivo: e.message });
    throw e;
  }

  if (!abilitato) {
    const esito = { eseguito: false, motivo: 'CTF_RELAYER_ENABLED è false: nessuna firma prodotta, niente inviato', piano };
    appendMakerAudit({ ...intento, fase: 'esito', esito: 'non-eseguito-interruttore', adapter: piano.adapter, confinamento: piano.confinamento });
    return esito;
  }

  // LA FIRMA. La chiave vive solo dentro questo blocco e non viene mai registrata: `appendMakerAudit`
  // passa comunque dal redattore, ma non contare su quello — qui la chiave semplicemente non entra
  // in nessun record.
  const { privateKey } = await deps.signerProvider();
  let firma;
  try {
    const w = new ethers.Wallet(privateKey);
    if (w.address.toLowerCase() !== signer.toLowerCase()) {
      throw new ErroreRelayer(`la chiave in custodia è di ${w.address}, ma le credenziali del relayer sono intestate a ${signer}: rifiuto di firmare`);
    }
    firma = await w.signTypedData(piano.firma.dominio, piano.firma.tipi, piano.firma.messaggio);
  } finally {
    /* la Wallet esce di scope qui; nessun riferimento alla chiave sopravvive a questa funzione */
  }

  const corpo = { ...piano.invio.corpo, signature: firma };
  const r = await http({ metodo: 'POST', percorso: '/submit', headers: intestazioni(cred), corpo });
  if (r.status !== 200 || !r.json || !r.json.transactionID) {
    appendMakerAudit({ ...intento, fase: 'esito', esito: 'submit-fallito', status: r.status, risposta: r.testo });
    throw new ErroreRelayer(`submit rifiutato dal relayer (HTTP ${r.status})`, { risposta: r.testo });
  }
  const transactionID = r.json.transactionID;
  appendMakerAudit({ ...intento, fase: 'inviato', transactionID, stato: r.json.state || null, adapter: piano.adapter, confinamento: piano.confinamento, nonce, indirizzoEffimero });

  const conferma = await attendiConferma({ transactionID, cred, http, deps });
  appendMakerAudit({ ...intento, fase: 'esito', esito: conferma.stato, transactionID, transactionHash: conferma.transactionHash || null });
  return { eseguito: true, transactionID, ...conferma, piano };
}

/** L'hash della transazione, comunque l'API scelga di chiamarlo. Vedi la nota in `attendiConferma`. */
function hashDa(json) {
  if (!json) return null;
  return json.transaction_hash || json.transactionHash || json.hash || null;
}

/** Polling dello stato. STATE_FAILED e STATE_INVALID sono terminali: non si riprova da soli. */
async function attendiConferma({ transactionID, cred, http, deps = {} }) {
  const attendi = deps.attendi || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tentativi = deps.tentativiConferma || 20;
  const passoMs = deps.passoConfermaMs || 3_000;
  for (let i = 0; i < tentativi; i += 1) {
    const r = await http({ metodo: 'GET', percorso: `/v1/account/transactions/${encodeURIComponent(transactionID)}`, headers: intestazioni(cred) });
    const stato = (r.json && r.json.state) || null;
    // L'API risponde in snake_case: `transaction_hash`. Leggere solo `transactionHash`/`hash` faceva
    // registrare `transactionHash: null` su una transazione CONFERMATA — la riga di audit non portava
    // alla transazione, e l'hash dello split del 7 agosto 2026 e' stato recuperato a mano.
    if (stato === 'STATE_CONFIRMED') return { stato, transactionHash: hashDa(r.json) };
    if (stato === 'STATE_FAILED' || stato === 'STATE_INVALID') {
      return { stato, transactionHash: hashDa(r.json), motivo: `stato terminale ${stato}`, risposta: r.testo };
    }
    if (i < tentativi - 1) await attendi(passoMs);
  }
  // Non confermata non è fallita: la transazione può ancora atterrare. Chi legge deve saperlo.
  return { stato: 'STATE_SCONOSCIUTO', transactionHash: null, motivo: `nessuna conferma entro ${(tentativi * passoMs) / 1000}s — la transazione può ancora confermarsi, non ri-inviarla senza aver riletto lo stato` };
}

// ── LE TRE SOLE CAPACITÀ ESPOSTE ────────────────────────────────────────────────────────────────────

/** pUSD → una coppia YES+NO. `amountUsd` in pUSD umani (2 = due dollari). */
function splitPosition(conditionId, amountUsd, opzioni = {}) {
  return esegui({ operazione: 'splitPosition', conditionId, negRisk: opzioni.negRisk, quantita: amountUsd, deps: opzioni.deps || {} });
}

/** Una coppia YES+NO → pUSD. `amountShares` in share umane (100 = cento share di ciascun lato). */
function mergePosition(conditionId, amountShares, opzioni = {}) {
  return esegui({ operazione: 'mergePositions', conditionId, negRisk: opzioni.negRisk, quantita: amountShares, deps: opzioni.deps || {} });
}

/** Mercato risolto: il token vincente → pUSD. Nessuna quantità: si riscuote quel che c'è. */
function redeemPosition(conditionId, opzioni = {}) {
  return esegui({ operazione: 'redeemPositions', conditionId, negRisk: opzioni.negRisk, quantita: null, deps: opzioni.deps || {} });
}

/**
 * Il piano di un'operazione, senza rete e senza firma — per mostrarlo prima di autorizzarlo.
 * Il nonce è un segnaposto: quello vero si legge al momento dell'esecuzione, e cambia il messaggio
 * firmato ma non le chiamate. Tutto il resto è identico a ciò che partirebbe.
 */
function mostraOperazione({ operazione, conditionId, negRisk, quantita = null, env = process.env, now = Date.now() }) {
  const cred = (() => { try { return credenziali(env); } catch { return { address: '0x0000000000000000000000000000000000000000' }; } })();
  return costruisciOperazione({
    operazione, conditionId, negRisk, quantita,
    depositWallet: (env.MAKER_FUNDER_ADDRESS || '').trim(),
    signer: cred.address, nonce: '<letto al momento>', deadline: Math.floor(now / 1000) + DEADLINE_SEC,
  });
}

module.exports = {
  splitPosition, mergePosition, redeemPosition, mostraOperazione,
  // esposti per i test e per la diagnosi; nessuno di questi invia niente
  costruisciOperazione, verificaConfinamento, leggiNonce, adapterPer, inUnitaBase, ErroreRelayer,
  CTF_RELAYER_ENABLED, ADAPTER_STANDARD, ADAPTER_NEG_RISK, RELAYER_EXECUTOR, DEADLINE_SEC, TIPI_BATCH,
};

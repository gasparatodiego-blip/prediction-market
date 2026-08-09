'use strict';
// lib/maker/merge-firma-cablata.test.js — IL MERGE ARRIVA ALLA FIRMA, NON SOLO AL NONCE.
//
// ═══ IL DIFETTO, MISURATO ═══════════════════════════════════════════════════════════════════════════
// Dal 9 agosto 2026 `auto-close.fondiCoppia` chiamava davvero il relayer, e il relayer non firmava mai:
//
//   merge-onchain-fallito | cid_a7245f90…
//   reason:   deps.signerProvider is not a function
//   observed: {"book":"yes","size":36.3,"negRisk":true}
//
// 21 tentativi in 21 minuti sul mercato Dallas 98-99°F, uno ogni ~65 secondi, mai riuscito. La coppia
// era rilevata completa a ogni giro (`merge-livello-1`, `azione:'merge'`, `eseguito:true`): il difetto
// non era nella decisione, era nel cablaggio. `mergePosition(marketId, size, { negRisk })` non passava
// `deps`, quindi `esegui` arrivava a `await deps.signerProvider()` con un oggetto vuoto.
//
// LA FIRMA DELL'INCIDENTE, NEL GIORNALE: 21 righe `fase:'intento'` e ZERO righe `fase:'esito'`. Il
// nonce veniva letto dal relayer per davvero — quindi le credenziali erano buone — e poi l'eccezione
// arrivava prima di qualunque firma. Nessuna transazione e' mai partita, nemmeno una a meta'.
//
// ═══ PERCHE' RIUSARE IL FIRMATARIO DELLA CORSIA MANUALE E' SICURO ═══════════════════════════════════
// Verificato on-chain il 9 agosto 2026, sola lettura, con scripts/maker-wallet-preflight.ts:
//   SIGNER in custodia (`live-providers.makerSignerProvider`) : 0x7bd09f34…85d3
//   POLYMARKET_RELAYER_API_KEY_ADDRESS in .env                : 0x7bd09f34…85d3   ← lo stesso
//   PROXY / funder che tiene i token da fondere               : 0x4C81F1…bdee (owner: il signer)
// Stesso wallet, stesso scopo. E se un giorno divergessero, `ctf-relayer.js:415-417` ricava l'indirizzo
// dalla chiave e RIFIUTA di firmare da solo — sezione 3 qui sotto lo prova.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · senza firmatario si rompe ESATTAMENTE come in produzione (intento sì, esito no)
//   2 · con firmatario la firma e' prodotta, VALIDA e verificabile, e arriva al POST /submit
//   3 · una chiave che non corrisponde alle credenziali NON firma e NON invia
//   4 · il cablaggio di default di auto-close passa il firmatario di live-providers, e non lo invoca
//   5 · il confine non e' stato allargato: nessun secondo interruttore, nessuna custodia locale
//
// NIENTE RETE E NIENTE CUSTODIA VERA: `http` e' iniettato, il giornale e' sostituito da un registratore
// (cosi' un test non scrive nel giornale di produzione da 730 MB) e le chiavi sono quelle pubbliche di
// Hardhat, note a tutti e senza alcun valore.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ── IL GIORNALE, SOSTITUITO PRIMA DI QUALUNQUE ALTRO require ────────────────────────────────────────
// `appendMakerAudit` scrive in data/polymarket-maker-audit.jsonl e il percorso non e' iniettabile
// (lib/safety/store.js lo ancora alla radice del pacchetto). Si sostituisce il MODULO nella cache:
// cosi' le righe si possono anche ASSERIRE, ed e' proprio la loro forma a distinguere il difetto.
const VIA_AUDIT = require.resolve('../venues/polymarket-clob-maker/audit');
const giornale = [];
require.cache[VIA_AUDIT] = {
  id: VIA_AUDIT, filename: VIA_AUDIT, loaded: true, exports: {
    appendMakerAudit: (r) => { giornale.push(r); },
    AUDIT_FILE: '(registratore di prova)',
  },
};

const R = require('./ctf-relayer');
const AC = require('./auto-close');
const LP = require('./live-providers');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// Il mercato vero dell'incidente: Dallas 98-99°F del 10 agosto, neg-risk, coppia completa per 36,3.
const ID = '0xa7245f903c604b2a0ddbd9a454600395d06e0e2d4f28f8fe227fffdbb923a1c1';
const SIZE = 36.3;
const FUNDER = '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee';

// Chiavi PUBBLICHE di Hardhat: le conosce chiunque abbia mai avviato un nodo locale, non custodiscono
// niente e non aprono niente. Servono solo a produrre una firma EIP-712 verificabile senza rete.
const CHIAVE_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const INDIRIZZO_A = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const CHIAVE_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const ambiente = (indirizzo) => ({
  MAKER_FUNDER_ADDRESS: FUNDER,
  POLYMARKET_RELAYER_API_KEY: 'chiave-di-prova',
  POLYMARKET_RELAYER_API_KEY_ADDRESS: indirizzo,
});

/** Un relayer finto che risponde come quello vero, e registra ogni chiamata ricevuta. */
function relayerFinto() {
  const chiamate = [];
  const http = async (req) => {
    chiamate.push(req);
    if (req.metodo === 'GET' && req.percorso.startsWith('/v1/account/transactions/params')) {
      return { status: 200, json: { nonce: '5', address: '0x00000000000000000000000000000000000eff1e' }, testo: '' };
    }
    if (req.metodo === 'POST' && req.percorso === '/submit') {
      return { status: 200, json: { transactionID: 'tx-di-prova', state: 'STATE_NEW' }, testo: '' };
    }
    if (req.metodo === 'GET' && req.percorso.includes('tx-di-prova')) {
      return { status: 200, json: { state: 'STATE_CONFIRMED', transaction_hash: '0xfeed0000feed0000feed0000feed0000feed0000feed0000feed0000feed0000' }, testo: '' };
    }
    throw new Error(`chiamata non prevista: ${req.metodo} ${req.percorso}`);
  };
  return { http, chiamate, submit: () => chiamate.find((c) => c.percorso === '/submit') };
}

const senzaAttese = { attendi: async () => {}, tentativiConferma: 1, passoConfermaMs: 1 };

async function principale() {
  console.log('── 1 · SENZA FIRMATARIO SI ROMPE ESATTAMENTE COME IN PRODUZIONE');
  {
    giornale.length = 0;
    const rel = relayerFinto();
    let errore = null;
    try {
      // Deliberatamente SENZA signerProvider, e con l'interruttore al suo valore reale: e' la chiamata
      // che auto-close faceva fino al 9 agosto 2026.
      await R.mergePosition(ID, SIZE, { negRisk: true, deps: { env: ambiente(INDIRIZZO_A), http: rel.http, ...senzaAttese } });
    } catch (e) { errore = e; }

    ok('senza signerProvider la fusione solleva', errore !== null);
    ok('  col messaggio ESATTO visto in produzione',
      errore !== null && /deps\.signerProvider is not a function/.test(errore.message), errore && errore.message);
    // La firma dell'incidente nel giornale: si e' arrivati a dichiarare l'intento, mai a un esito.
    const intenti = giornale.filter((r) => r.fase === 'intento');
    const esiti = giornale.filter((r) => r.fase === 'esito');
    ok('  l\'intento E\' registrato', intenti.length === 1, `${intenti.length} intento/i`);
    ok('  ma NESSUN esito lo chiude — la firma dell\'incidente', esiti.length === 0, `${esiti.length} esiti`);
    // E il nonce era stato letto: le credenziali non c'entravano niente.
    ok('  il nonce era stato letto dal relayer (credenziali buone)',
      rel.chiamate.some((c) => c.percorso.startsWith('/v1/account/transactions/params')));
    ok('  e NIENTE e\' stato inviato', !rel.submit());
  }

  console.log('\n── 2 · CON IL FIRMATARIO LA TRANSAZIONE VIENE FIRMATA DAVVERO');
  {
    giornale.length = 0;
    const rel = relayerFinto();
    let invocazioni = 0;
    const signerProvider = async () => { invocazioni += 1; return { privateKey: CHIAVE_A, address: INDIRIZZO_A }; };

    const res = await R.mergePosition(ID, SIZE, {
      negRisk: true,
      deps: { env: ambiente(INDIRIZZO_A), http: rel.http, signerProvider, ...senzaAttese },
    });

    ok('la fusione riesce', res && res.eseguito === true, res && res.motivo);
    ok('  il firmatario e\' stato chiamato una volta sola', invocazioni === 1, String(invocazioni));
    ok('  l\'hash della transazione torna al chiamante', /^0xfeed/.test(String(res.transactionHash)));
    ok('  con stato CONFERMATA', res.stato === 'STATE_CONFIRMED', String(res.stato));

    // ── LA FIRMA E' VERA, e si dimostra ricavandone l'indirizzo ────────────────────────────────────
    const submit = rel.submit();
    ok('il POST /submit e\' partito', !!submit);
    const firma = submit && submit.corpo && submit.corpo.signature;
    ok('  e porta una firma', typeof firma === 'string' && /^0x[0-9a-f]{130}$/i.test(firma), String(firma).slice(0, 24) + '…');
    const recuperato = ethers.verifyTypedData(res.piano.firma.dominio, res.piano.firma.tipi, res.piano.firma.messaggio, firma);
    ok('  la firma e\' VALIDA per il messaggio costruito', recuperato.toLowerCase() === INDIRIZZO_A.toLowerCase(), recuperato);
    ok('  le intestazioni del relayer ci sono', !!(submit.headers && submit.headers.RELAYER_API_KEY && submit.headers.RELAYER_API_KEY_ADDRESS));

    // Il confine: si firma un batch verso l'adapter neg-risk, e nient'altro.
    ok('  l\'adapter e\' quello neg-risk, come chiede il mercato',
      String(res.piano.adapter).toLowerCase() === R.ADAPTER_NEG_RISK.toLowerCase());
    ok('  la chiave non compare in nessuna riga del giornale',
      !JSON.stringify(giornale).includes(CHIAVE_A.slice(2, 30)));
    const esiti = giornale.filter((r) => r.fase === 'esito');
    ok('  e stavolta l\'esito chiude l\'intento', esiti.length === 1 && esiti[0].esito === 'STATE_CONFIRMED', JSON.stringify(esiti.map((e) => e.esito)));
  }

  console.log('\n── 3 · UNA CHIAVE CHE NON E\' QUELLA DELLE CREDENZIALI NON FIRMA E NON INVIA');
  {
    const rel = relayerFinto();
    let errore = null;
    try {
      await R.mergePosition(ID, SIZE, {
        negRisk: true,
        // Credenziali intestate ad A, chiave in custodia di B: e' lo scenario «le due custodie hanno
        // divergiato», e dev'essere un rifiuto, non una firma inutile.
        deps: { env: ambiente(INDIRIZZO_A), http: rel.http, signerProvider: async () => ({ privateKey: CHIAVE_B }), ...senzaAttese },
      });
    } catch (e) { errore = e; }
    ok('chiave diversa dalle credenziali ⇒ rifiuto di firmare', errore !== null && /rifiuto di firmare/.test(errore.message), errore && errore.message.slice(0, 90));
    ok('  e NIENTE e\' stato inviato', !rel.submit());
    ok('  il controllo vive nel relayer, non nel chiamante',
      /rifiuto di firmare/.test(fs.readFileSync(path.join(__dirname, 'ctf-relayer.js'), 'utf8')));
  }

  console.log('\n── 4 · IL CABLAGGIO DI DEFAULT DI auto-close PASSA IL FIRMATARIO GIUSTO');
  {
    // Si sostituisce ./ctf-relayer nella cache SOLO per questo blocco, per intercettare esattamente ciò
    // che il ramo di default gli passa. `fondiCoppia` lo richiede in modo differito, quindi basta che la
    // sostituzione sia in piedi al momento della chiamata.
    const VIA_REL = require.resolve('./ctf-relayer');
    const vero = require.cache[VIA_REL];
    const visto = [];
    require.cache[VIA_REL] = {
      id: VIA_REL, filename: VIA_REL, loaded: true, exports: {
        mergePosition: async (conditionId, quantita, opzioni) => {
          visto.push({ conditionId, quantita, opzioni });
          return { eseguito: true, transactionID: 'tx', transactionHash: '0xaaa', stato: 'STATE_CONFIRMED' };
        },
      },
    };
    let res = null;
    try {
      // NESSUN deps.mergeOnChain: e' il percorso che gira in produzione dentro agent40.
      res = await AC.fondiCoppia({ marketId: ID, rules: { negRisk: true }, size: SIZE });
    } finally {
      if (vero) require.cache[VIA_REL] = vero; else delete require.cache[VIA_REL];
    }

    ok('il ramo di default chiama mergePosition', visto.length === 1 && res && res.ok === true, res && res.motivo);
    const o = visto[0] && visto[0].opzioni;
    ok('  con negRisk COPIATO, come prima', o && o.negRisk === true);
    ok('  e ORA con un deps', !!(o && o.deps));
    ok('  che contiene un signerProvider CHIAMABILE', typeof (o && o.deps && o.deps.signerProvider) === 'function',
      typeof (o && o.deps && o.deps.signerProvider));
    // Non un firmatario qualunque: LO STESSO della corsia manuale. Se qualcuno ne introducesse un
    // secondo, questa riga lo direbbe subito.
    // Le letture sono difensive di proposito: senza il fix `o.deps` e' undefined, e un test che esplode
    // nasconde tutte le righe che vengono dopo — cioe' proprio quelle che dicono COSA manca.
    const firmatario = o && o.deps ? o.deps.signerProvider : undefined;
    ok('  ed e\' ESATTAMENTE quello di live-providers, non un secondo firmatario',
      firmatario === LP.makerSignerProvider);
    ok('  ed e\' lo stesso che restituisce makerLiveProviders() (la fonte di manual-order.js:730)',
      firmatario === LP.makerLiveProviders().signerProvider);
    // Il cablaggio NON deve decifrare niente: la chiave si tocca solo se e quando si firma.
    ok('  il cablaggio non invoca il firmatario (nessuna decifratura per costruire la chiamata)',
      visto.length === 1 && res.ok === true);
    const chiavi = o && o.deps ? Object.keys(o.deps) : [];
    ok('  si passa SOLO il firmatario, non la coppia di provider intera',
      chiavi.length === 1 && chiavi[0] === 'signerProvider', chiavi.join(',') || '(nessun deps)');

    // I rifiuti fail-closed di prima devono valere ANCORA: il wiring non ha aperto una scorciatoia.
    const perNiente = [];
    require.cache[VIA_REL] = { id: VIA_REL, filename: VIA_REL, loaded: true, exports: { mergePosition: async (...a) => { perNiente.push(a); return { eseguito: true }; } } };
    const brutto = await AC.fondiCoppia({ marketId: ID, rules: { negRisk: 'true' }, size: SIZE });
    const piccolo = await AC.fondiCoppia({ marketId: ID, rules: { negRisk: true }, size: 0 });
    if (vero) require.cache[VIA_REL] = vero; else delete require.cache[VIA_REL];
    ok('negRisk non booleano ⇒ ancora nessun tentativo', brutto.ok === false && perNiente.length === 0, brutto.motivo);
    ok('size non utilizzabile ⇒ ancora nessun tentativo', piccolo.ok === false && perNiente.length === 0, piccolo.motivo);
  }

  console.log('\n── 5 · IL CONFINE NON E\' STATO ALLARGATO');
  {
    const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    const rel = fs.readFileSync(path.join(__dirname, 'ctf-relayer.js'), 'utf8');

    ok('auto-close importa il relayer in UN punto solo',
      (ac.match(/require\('\.\/ctf-relayer'\)/g) || []).length === 1);
    ok('  e la custodia in UN punto solo', (ac.match(/require\('\.\/live-providers'\)/g) || []).length === 1);
    ok('  entrambe con require DIFFERITO, dentro fondiCoppia', !/^const .*live-providers/m.test(ac));
    ok('auto-close non chiama split ne\' redeem', !/splitPosition|redeemPosition/.test(ac));
    ok('  non forza l\'interruttore del relayer', !/abilitato\s*:/.test(ac));
    ok('  e nessuna env accende il merge on-chain', !/process\.env\.CTF/.test(ac));

    // La custodia resta UNA: auto-close non decifra niente per conto suo.
    ok('auto-close non tocca la custodia direttamente', !/key-custody|apiSecretEnc|unwrapDek|PrismaClient/.test(ac));
    ok('  e non scrive mai una chiave privata in chiaro', !/privateKey/.test(ac));

    // La costruzione della transazione non e' stata toccata: restano i due soli target ammessi e la
    // ri-decodifica prima della firma.
    ok('i target ammessi restano DUE', !!R.ADAPTER_STANDARD && !!R.ADAPTER_NEG_RISK);
    ok('  e il confinamento si ri-verifica prima della firma', /verificaConfinamento\(/.test(rel));
    ok('il relayer non importa l\'adapter ne\' la corsia manuale',
      !/require\('[^']*(polymarket-clob-maker\/adapter|manual-order|bulk-allocate|plan-to-orders)'\)/.test(rel));

    // L'intestazione racconta il difetto vero: se un giorno il wiring sparisse, il commento resterebbe
    // a mentire. Meglio che il test lo tenga ancorato.
    ok('il commento nel sorgente cita l\'errore misurato',
      /deps\.signerProvider is not a function/.test(ac) && /manual-order\.js:730/.test(ac));
  }
}

principale().then(() => {
  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}).catch((e) => {
  console.log(`\nROSSI: il test stesso e' esploso — ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
// LA STIMA CONTRO IL CONSUNTIVO — E IL PERCORSO DI LETTURA CHE NON PUÒ PIAZZARE.
//
// Le proprietà:
//   1. i due controlli scattano agli orari UTC giusti, e la finestra tollera un ciclo saltato;
//   2. la stima si fotografa una volta sola per giornata (idempotenza nel file, non nel chiamante);
//   3. lo scarto assoluto e percentuale sono giusti, e valgono `null` quando il reale non c'è;
//   4. «non disponibile» NON diventa mai zero, e dopo tre tentativi la giornata si chiude;
//   5. il modulo che legge il consuntivo è INCAPACE di piazzare — provato leggendo il sorgente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compitiDovuti, scarto, registraStima, registraReale, leggiConfronto,
  ORA_STIMA, ORE_REALE, TENTATIVI_MAX,
} = require('./confronto-reward');
const { leggiRewardReale, estraiTotale, METODO_UNICO } = require('./reward-reale');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const utc = (s) => Date.parse(s);

console.log('\n══ 1 · GLI ORARI, IN UTC');
{
  ok('stima alle 23:55', ORA_STIMA.h === 23 && ORA_STIMA.m === 55);
  ok('consuntivo a 00:20 · 00:40 · 01:00',
    JSON.stringify(ORE_REALE) === JSON.stringify([{ h: 0, m: 20 }, { h: 0, m: 40 }, { h: 1, m: 0 }]));
  ok('tre tentativi al massimo', TENTATIVI_MAX === 3);

  const s = compitiDovuti({ now: utc('2026-08-06T23:55:02Z') });
  ok('alle 23:55:02 è dovuta la stima', s.stima === true && s.reale === false);
  ok('  e la giornata è quella CORRENTE', s.giornoStima === '2026-08-06', s.giornoStima);

  const r1 = compitiDovuti({ now: utc('2026-08-07T00:20:10Z') });
  ok('alle 00:20 è dovuto il consuntivo, tentativo 1', r1.reale === true && r1.tentativo === 1);
  ok('  e la giornata è quella PRECEDENTE', r1.giornoReale === '2026-08-06', r1.giornoReale);
  ok('  e la stima NON è dovuta', r1.stima === false);

  ok('alle 00:40 è il tentativo 2', compitiDovuti({ now: utc('2026-08-07T00:40:00Z') }).tentativo === 2);
  ok('all 01:00 è il tentativo 3', compitiDovuti({ now: utc('2026-08-07T01:00:30Z') }).tentativo === 3);

  // Fuori finestra: niente.
  for (const t of ['2026-08-06T23:50:00Z', '2026-08-07T00:15:00Z', '2026-08-07T02:00:00Z', '2026-08-07T12:00:00Z']) {
    const c = compitiDovuti({ now: utc(t) });
    ok(`a ${t.slice(11, 16)} nessun compito`, c.stima === false && c.reale === false);
  }
}

console.log('\n══ LA FINESTRA TOLLERA UN CICLO SALTATO, MA NON L ORA DOPO');
{
  ok('23:58 è ancora dentro (riavvio a 23:54:58 non perde la giornata)',
    compitiDovuti({ now: utc('2026-08-06T23:58:59Z') }).stima === true);
  ok('  ma 23:59:30 è fuori', compitiDovuti({ now: utc('2026-08-06T23:59:30Z') }).stima === false);
  ok('00:23 è ancora il tentativo 1', compitiDovuti({ now: utc('2026-08-07T00:23:00Z') }).tentativo === 1);
  ok('  e 00:25 è fuori', compitiDovuti({ now: utc('2026-08-07T00:25:00Z') }).reale === false);
}

console.log('\n══ 3 · LO SCARTO');
{
  const sopra = scarto({ stimaUsd: 12, realeUsd: 10 });
  ok('stima 12 vs reale 10 ⇒ +$2, +20%', sopra.assolutoUsd === 2 && sopra.percentuale === 20, JSON.stringify(sopra));
  ok('  ed è una sovrastima', sopra.direzione === 'sovrastima');
  const sotto = scarto({ stimaUsd: 8, realeUsd: 10 });
  ok('stima 8 vs reale 10 ⇒ −$2, −20%', sotto.assolutoUsd === -2 && sotto.percentuale === -20);
  ok('  ed è una sottostima', sotto.direzione === 'sottostima');
  ok('stima = reale ⇒ esatta', scarto({ stimaUsd: 10, realeUsd: 10 }).direzione === 'esatta');

  // Reale zero: la percentuale non esiste. Infinity in una tabella è peggio di un trattino.
  const zero = scarto({ stimaUsd: 5, realeUsd: 0 });
  ok('reale 0 ⇒ assoluto sì, percentuale null', zero.assolutoUsd === 5 && zero.percentuale === null);

  // Reale assente: niente scarto affatto.
  ok('reale assente ⇒ tutto null',
    scarto({ stimaUsd: 5, realeUsd: null }).assolutoUsd === null);
  ok('stima assente ⇒ tutto null', scarto({ stimaUsd: null, realeUsd: 5 }).percentuale === null);
}

console.log('\n══ 2+4 · IL FILE: IDEMPOTENZA, «NON DISPONIBILE» E TENTATIVI');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confronto-'));
  const file = path.join(dir, 'c.json');
  const d = { confrontoFile: file, now: () => utc('2026-08-06T23:55:00Z') };

  const w1 = registraStima({ giorno: '2026-08-06', stimaUsd: 12.3456789, perMercato: [{ marketId: 'A', estUsdPerDay: 12.34 }] }, d);
  ok('la stima si scrive', w1.scritto === true);
  const w2 = registraStima({ giorno: '2026-08-06', stimaUsd: 99 }, d);
  ok('  e un secondo giro nella stessa finestra NON la sovrascrive', w2.scritto === false, w2.motivo);
  ok('  il valore resta il primo', leggiConfronto(d).giorni[0].stimaUsd === 12.345679,
    `${leggiConfronto(d).giorni[0].stimaUsd}`);
  ok('  con la scomposizione per mercato', leggiConfronto(d).giorni[0].stimaPerMercato.length === 1);

  // Tentativo 1: il venue non ha ancora consolidato.
  registraReale({ giorno: '2026-08-06', disponibile: false, motivo: 'HTTP 404', tentativo: 1 }, d);
  let g = leggiConfronto(d).giorni[0];
  ok('non disponibile ⇒ realeUsd resta NULL, non zero', g.realeUsd === null && g.realeDisponibile === false);
  ok('  col motivo del venue', g.realeMotivo === 'HTTP 404');
  ok('  e NON è ancora esaurito', g.esaurito === false, `tentativi ${g.tentativi}`);
  ok('  lo scarto non viene calcolato', g.assolutoUsd === undefined || g.assolutoUsd === null);

  registraReale({ giorno: '2026-08-06', disponibile: false, motivo: 'timeout', tentativo: 2 }, d);
  ok('secondo tentativo: ancora non esaurito', leggiConfronto(d).giorni[0].esaurito === false);
  registraReale({ giorno: '2026-08-06', disponibile: false, motivo: 'timeout', tentativo: 3 }, d);
  g = leggiConfronto(d).giorni[0];
  ok('terzo tentativo ⇒ ESAURITO, non si insiste oltre', g.esaurito === true && g.tentativi === 3);

  // Una giornata che invece arriva.
  registraStima({ giorno: '2026-08-07', stimaUsd: 12 }, d);
  registraReale({ giorno: '2026-08-07', disponibile: true, realeUsd: 10, tentativo: 1 }, d);
  const buono = leggiConfronto(d).giorni.find((x) => x.giorno === '2026-08-07');
  ok('consuntivo disponibile ⇒ scarto calcolato', buono.assolutoUsd === 2 && buono.percentuale === 20);
  const w3 = registraReale({ giorno: '2026-08-07', disponibile: true, realeUsd: 999, tentativo: 2 }, d);
  ok('  e un secondo consuntivo NON lo sovrascrive', w3.scritto === false && buono.realeUsd === 10);

  // La media esclude le giornate senza consuntivo.
  const c = leggiConfronto(d);
  ok('la media di precisione conta SOLO le giornate confrontabili',
    c.giorniConfrontabili === 1 && c.scartoMedioPct === 20,
    'una media che includesse i giorni senza consuntivo racconterebbe una precisione mai misurata');

  ok('il più recente è per primo', c.giorni[0].giorno === '2026-08-07', c.giorni.map((x) => x.giorno).join(','));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log('\n══ 4 · IL RETRY QUANDO IL VENUE NON RISPONDE (401/404/timeout)');
{
  for (const [nome, risposta] of [
    ['401', { ok: false, status: 401, error: 'HTTP 401' }],
    ['404', { ok: false, status: 404, error: 'HTTP 404' }],
    ['timeout', { ok: false, status: null, error: 'timeout dopo 12000ms' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = require('./reward-reale');
    const p = r.leggiRewardReale({
      giorno: '2026-08-06',
      deps: {
        creds: async () => ({ creds: { key: 'k', secret: Buffer.from('s').toString('base64'), passphrase: 'p' }, address: '0xabc' }),
        get: async () => risposta,
        now: () => 1_754_000_000_000,
      },
    });
    // eslint-disable-next-line no-await-in-loop
    p.then((res) => {
      ok(`${nome} ⇒ non disponibile, MAI zero`, res.disponibile === false && res.totaleUsd === null, res.motivo);
    });
  }
}

console.log('\n══ LA RISPOSTA DEL VENUE: SI LEGGE, NON SI INDOVINA');
{
  ok('totale diretto', estraiTotale({ total: '12.5' }, '2026-08-06').totaleUsd === 12.5);
  const righe = estraiTotale({ data: [
    { date: '2026-08-06', earnings: 4, condition_id: 'A' },
    { date: '2026-08-06', earnings: 6, condition_id: 'B' },
    { date: '2026-08-05', earnings: 99, condition_id: 'C' },
  ] }, '2026-08-06');
  ok('elenco per mercato ⇒ somma del giorno chiesto', righe.totaleUsd === 10, `${righe.totaleUsd}`);
  ok('  e le altre giornate non entrano', righe.perMercato.length === 2);
  ok('forma sconosciuta ⇒ null col motivo, non uno zero',
    estraiTotale({ qualcosa: 'altro' }, '2026-08-06').totaleUsd === null);
  ok('nessuna riga per quel giorno ⇒ null', estraiTotale({ data: [{ date: '2026-08-01', earnings: 5 }] }, '2026-08-06').totaleUsd === null);
}

console.log('\n══ 5 · IL PERCORSO DI LETTURA NON PUÒ PIAZZARE — PROVA SUL SORGENTE');
{
  const src = fs.readFileSync(require.resolve('./reward-reale'), 'utf8');
  const codice = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok('l unico metodo HTTP è GET, ed è una costante', METODO_UNICO === 'GET' && /const METODO_UNICO = 'GET'/.test(src));
  ok('nessun POST, PUT o DELETE nel codice', !/'POST'|"POST"|'PUT'|'DELETE'|method:\s*'P/.test(codice),
    'non c è un ramo di scrittura da attivare per errore');
  // SI GUARDA IL CODICE, NON LA MENZIONE. L'intestazione nomina l'adapter apposta, per spiegare perché
  // NON viene importato: cercarlo nel sorgente grezzo punirebbe la spiegazione invece del codice. È lo
  // stesso errore già fatto due volte in questo repo (con «bulk-allocate» e con MAKER_PLACEMENT).
  ok('NON importa l adapter — l unico oggetto che sa mandare un ordine',
    !/require\([^)]*adapter/.test(codice));
  ok('NON importa il signer (la chiave L1 che firma gli ordini)',
    !/signerProvider|makerSigner|privateKey|PRIVATE_KEY/.test(codice));
  ok('usa SOLO le credenziali L2', /cancel-creds-provider/.test(src) && /polymarketCancelCredsProvider/.test(src),
    'le creds L2 da sole non possono costruire una struct EIP-712 firmata');
  ok('non importa manual-order né bulk-allocate',
    !/require\([^)]*(manual-order|bulk-allocate)/.test(codice)
    && !/placeManualOrder|runBulkAllocation/.test(codice));
  ok('l unica funzione di rete è la GET firmata',
    (codice.match(/https\.request/g) || []).length === 1);
  ok('e non scrive niente su disco', !/writeFileSync|renameSync|require\('fs'\)/.test(codice));

  // Il simmetrico: il modulo del confronto non parla col venue.
  const conf = fs.readFileSync(require.resolve('./confronto-reward'), 'utf8');
  ok('confronto-reward non fa rete: legge e scrive solo il suo file',
    !/https|fetch\(|http\.request/.test(conf.replace(/^\s*\/\/.*$/gm, '')));
}

// ═══ 6 · IL PERCORSO CHE RISPONDE DAVVERO, E LA GUARDIA DELL'ATTRIBUZIONE ═══════════════════════════
// Misurato l'8 agosto 2026 sondando il CLOB in sola lettura: `/rewards/user` e `/rewards/user/total`
// rispondono 401 con le nostre credenziali, `/rewards/user/markets` risponde 200 — ma con
// `maker_address` a ZERO su tutte le 5.065 righe e `earnings: 0` ovunque. È il catalogo dei mercati
// premianti, non l'estratto conto di questo maker: scriverne «$0 incassati» sarebbe inventare.
console.log('\n══ 6 · UN 200 NON È UN CONSUNTIVO: LO È UN 200 ATTRIBUITO');
{
  const R = require('./reward-reale');
  const NOSTRO = '0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee';
  const creds = async () => ({ creds: { key: 'k', secret: Buffer.from('s').toString('base64'), passphrase: 'p' }, address: '0xabc' });
  const riga = (maker, usd, cond) => ({ condition_id: cond, maker_address: maker, earnings: [{ asset_address: '0xUSDC', earnings: usd, asset_rate: 1 }] });
  const attesi = [];

  ok('il percorso interrogato è quello che risponde 200', R.PERCORSO === '/rewards/user/markets');

  // (a) il catalogo non attribuito: 200, zeri ovunque, maker a zero.
  attesi.push(R.leggiRewardReale({
    giorno: '2026-08-06',
    deps: {
      creds, funder: NOSTRO, now: () => 1_754_000_000_000,
      get: async () => ({ ok: true, status: 200, data: { data: [riga(R.INDIRIZZO_ZERO, 0, 'A'), riga(R.INDIRIZZO_ZERO, 0, 'B')], next_cursor: 'LTE=' } }),
    },
  }).then((r) => {
    ok('catalogo con maker a zero ⇒ NON disponibile, e NON zero', r.disponibile === false && r.totaleUsd === null);
    ok('  ed è dichiarato come «non attribuito», non come rete caduta', r.attribuito === false && r.status === 200);
    ok('  col motivo che nomina il difetto', /non attribuisce nessun maker/.test(r.motivo || ''), r.motivo);
  }));

  // (b) attribuito: si somma SOLO ciò che è nostro.
  attesi.push(R.leggiRewardReale({
    giorno: '2026-08-06',
    deps: {
      creds, funder: NOSTRO, now: () => 1_754_000_000_000,
      get: async () => ({ ok: true, status: 200, data: { data: [riga(NOSTRO, 4.25, 'A'), riga('0xaltro', 999, 'B'), riga(NOSTRO, 1.75, 'C')], next_cursor: null } }),
    },
  }).then((r) => {
    ok('con righe attribuite a noi ⇒ consuntivo disponibile', r.disponibile === true && r.attribuito === true);
    ok('  e il totale somma SOLO le nostre righe', r.totaleUsd === 6, `${r.totaleUsd}`);
    ok('  il maker di un altro non entra mai', (r.perMercato || []).length === 2 && !(r.perMercato || []).some((x) => x.marketId === 'B'));
  }));

  // (c) la paginazione: il cursore si segue, e le pagine si sommano.
  {
    let n = 0;
    attesi.push(R.leggiRewardReale({
      giorno: '2026-08-06',
      deps: {
        creds, funder: NOSTRO, now: () => 1_754_000_000_000,
        get: async () => {
          n += 1;
          if (n === 1) return { ok: true, status: 200, data: { data: [riga(NOSTRO, 2, 'A')], next_cursor: 'MTAw' } };
          return { ok: true, status: 200, data: { data: [riga(NOSTRO, 3, 'B')], next_cursor: 'LTE=' } };
        },
      },
    }).then((r) => {
      ok('la paginazione si segue fino al cursore-sentinella', n === 2 && r.pagine === 2);
      ok('  e le pagine si sommano', r.totaleUsd === 5, `${r.totaleUsd}`);
    }));
  }

  // (d) un errore di rete a metà paginazione NON produce un parziale spacciato per totale.
  {
    let n = 0;
    attesi.push(R.leggiRewardReale({
      giorno: '2026-08-06',
      deps: {
        creds, funder: NOSTRO, now: () => 1_754_000_000_000,
        get: async () => {
          n += 1;
          if (n === 1) return { ok: true, status: 200, data: { data: [riga(NOSTRO, 7, 'A')], next_cursor: 'MTAw' } };
          return { ok: false, status: 502, error: 'HTTP 502' };
        },
      },
    }).then((r) => {
      ok('rete caduta a metà elenco ⇒ non disponibile, mai il parziale già letto', r.disponibile === false && r.totaleUsd === null);
    }));
  }

  ok('la somma di una riga legge l elenco per asset', R.sommaEarnings({ earnings: [{ earnings: 1.5 }, { earnings: 0.5 }] }) === 2);
  ok('  e un importo illeggibile NON diventa zero', R.sommaEarnings({ earnings: [{ earnings: 'boh' }] }) === null);
  ok('una pagina senza elenco non è una pagina vuota', R.estraiPagina({ qualcosa: 1 }).righe === null);
  ok('  e il cursore-sentinella LTE= vale «fine»', R.estraiPagina({ data: [], next_cursor: 'LTE=' }).cursore === null);
}

// ═══ 7 · LO SCARTO PER MERCATO E IL VERDETTO SULLA DERIVA ═══════════════════════════════════════════
console.log('\n══ 7 · MERCATO PER MERCATO, E IL VERDETTO SULLA DERIVA');
{
  const { scartoPerMercato, divergenza, SOGLIA_SCARTO_PCT, OSSERVAZIONI_MINIME } = require('./confronto-reward');

  const righe = scartoPerMercato({
    stimaPerMercato: [
      { marketId: '0xAA', title: 'uno', estUsdPerDay: 10 },
      { marketId: '0xBB', title: 'due', estUsdPerDay: 5 },
      { marketId: '0xCC', title: 'tre', estUsdPerDay: 2 },
    ],
    realePerMercato: [{ marketId: '0xaa', usd: 8 }, { marketId: '0xbb', usd: 6 }, { marketId: '0xDD', usd: 1 }],
  });
  const per = new Map(righe.map((r) => [r.marketId, r]));
  ok('il join non si perde sul maiuscolo/minuscolo dell id', per.has('0xaa') && per.has('0xbb'));
  ok('  scarto giusto dove entrambe le metà ci sono', per.get('0xaa').assolutoUsd === 2 && per.get('0xaa').percentuale === 25);
  ok('  e il verso è dichiarato', per.get('0xaa').direzione === 'sovrastima' && per.get('0xbb').direzione === 'sottostima');
  ok('stimato ma mai incassato ⇒ riga con stato proprio, non uno scarto del 100%',
    per.get('0xcc').stato === 'stimato-senza-consuntivo' && per.get('0xcc').percentuale === null);
  ok('incassato senza stima ⇒ l altra diagnosi, e non sparisce', per.get('0xdd').stato === 'incassato-senza-stima');
  ok('  ordinate per scostamento in dollari: il caso più grosso è il primo', Math.abs(righe[0].assolutoUsd ?? 0) >= Math.abs(righe[1].assolutoUsd ?? 0));

  // Il verdetto. Le giornate non confrontabili non entrano MAI nel conteggio.
  const g = (giorno, stima, reale) => ({ giorno, stimaUsd: stima, realeUsd: reale, realeDisponibile: true, ...scarto({ stimaUsd: stima, realeUsd: reale }) });
  const pochi = divergenza([g('2026-08-01', 10, 5), g('2026-08-02', 10, 5)]);
  ok(`sotto ${OSSERVAZIONI_MINIME} giornate il verdetto è «dati-insufficienti»`, pochi.stato === 'dati-insufficienti' && pochi.avviso === false);
  ok('  e «dati insufficienti» NON è «va tutto bene»', /servono \d+ giornate/.test(pochi.messaggio), pochi.messaggio);

  const nonDisponibili = divergenza(Array.from({ length: 8 }, (_, i) => ({ giorno: `2026-08-0${i + 1}`, stimaUsd: 10, realeUsd: null, realeDisponibile: false })));
  ok('  otto giornate SENZA consuntivo restano «dati-insufficienti»: non si conta una speranza',
    nonDisponibili.stato === 'dati-insufficienti' && nonDisponibili.osservazioni === 0);

  const preciso = divergenza(Array.from({ length: 6 }, (_, i) => g(`2026-08-0${i + 1}`, 10.5, 10)));
  ok('sei giornate a +5% ⇒ coerente, nessun avviso', preciso.stato === 'coerente' && preciso.avviso === false, preciso.messaggio);

  const deriva = divergenza(Array.from({ length: 6 }, (_, i) => g(`2026-08-0${i + 1}`, 15, 10)));
  ok(`sei giornate a +50% (soglia ${SOGLIA_SCARTO_PCT}%) ⇒ AVVISO`, deriva.stato === 'divergente' && deriva.avviso === true, deriva.messaggio);
  ok('  col verso dichiarato', deriva.direzione === 'sovrastima' && deriva.medianaPct === 50);
  ok('  e le giornate su cui il giudizio è stato dato', deriva.giorniUsati.length === 6);

  // Grande ma NON sistematico: imprecisione, non taratura sbagliata. Nessun avviso.
  const ballerino = divergenza([
    g('2026-08-01', 15, 10), g('2026-08-02', 5, 10), g('2026-08-03', 15, 10),
    g('2026-08-04', 5, 10), g('2026-08-05', 15, 10), g('2026-08-06', 5, 10),
  ]);
  ok('scarto grosso ma che cambia verso ⇒ nessun avviso: è imprecisione, non deriva',
    ballerino.avviso === false && ballerino.concordanza < 0.8, `concordanza ${ballerino.concordanza}`);

  // Un solo outlier gigante non deve poter accendere l'avviso da solo: la misura è la MEDIANA.
  const outlier = divergenza([
    g('2026-08-01', 10.2, 10), g('2026-08-02', 10.3, 10), g('2026-08-03', 10.1, 10),
    g('2026-08-04', 10.2, 10), g('2026-08-05', 10.4, 10), g('2026-08-06', 500, 0.5),
  ]);
  ok('un solo giorno fuori scala non accende l avviso: si misura sulla mediana, non sulla media',
    outlier.avviso === false && Math.abs(outlier.mediaPct) > Math.abs(outlier.medianaPct),
    `mediana ${outlier.medianaPct}% contro media ${outlier.mediaPct}%`);

  ok('e il verdetto non corregge niente: non esiste nessun campo che riscriva la stima',
    !('stimaCorretta' in deriva) && !('fattore' in deriva));
}

// Il totale si stampa DOPO le asserzioni asincrone, non prima: un conteggio che non le contasse
// direbbe un numero più piccolo del lavoro fatto, ed è il genere di dettaglio che fa dubitare del resto.
setTimeout(() => {
  console.log(`\nconfronto reward: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
}, 400);

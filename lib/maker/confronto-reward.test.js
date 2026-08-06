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

console.log(`\nconfronto reward: ${pass} passati, ${fail} falliti`);
setTimeout(() => process.exit(fail ? 1 : 0), 200);

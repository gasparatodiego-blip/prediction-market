'use strict';
// lib/maker/stima-integrata.test.js — LA STIMA È UNA QUANTITÀ, E LA SUA COPERTURA VIAGGIA CON LEI.
//
// Difende le tre regole che rendono onesto l'integrale (vedi l'intestazione del modulo) e il fatto che
// il confronto col bonifico usi la grandezza giusta. Non tocca `data/`: il registro dei campioni e
// quello del confronto sono iniettati in una cartella temporanea.
//
// Run: node lib/maker/stima-integrata.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const SI = require('./stima-integrata');
const CR = require('./confronto-reward');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) <= eps;

const G = '2026-08-08';
const t0 = Date.parse(`${G}T00:00:00.000Z`);
const ORA = 3_600_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stima-int-'));

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · L\'INTEGRALE: Σ(tasso × durata), non la fotografia');
{
  // Un tasso di $24/giorno tenuto per un'ora vale $1. È il conto che rende le due grandezze
  // confrontabili: il bonifico è una quantità, e adesso lo è anche la stima.
  const campioni = [{ t: t0 + 10 * ORA, r: 24 }, { t: t0 + 11 * ORA, r: 0 }];
  const r = SI.integra({ giorno: G, campioni, now: t0 + 24 * ORA, env: { MAKER_STIMA_PASSO_MS: String(30 * 60_000) } });
  // passo 30 min ⇒ estensione 60 min: il campione copre l'ora intera fino al successivo.
  ok('24 $/g per un\'ora = $1,00', vicino(r.usd, 1, 1e-3), `$${r.usd}`);

  // IL CASO DELL'8 AGOSTO, con i numeri veri della diagnosi: $49,17/g vivi per 2,28 ore.
  const passo = 5 * 60_000;
  const c2 = [];
  for (let t = t0 + 21.7 * ORA; t < t0 + 24 * ORA; t += passo) c2.push({ t, r: 49.17 });
  const r2 = SI.integra({ giorno: G, campioni: c2, now: t0 + 24 * ORA });
  ok('l\'8 agosto: $49,17/g × 2,3 h ≈ $4,7 invece di $49,17',
    r2.usd > 4 && r2.usd < 5.2, `$${r2.usd} contro i $49,17 della fotografia`);
  ok('  e la copertura dichiara che è una giornata quasi vuota', r2.coperturaFrazione < 0.12,
    `${(r2.coperturaFrazione * 100).toFixed(1)}%`);
  ok('  quindi la giornata NON è dichiarata completa', r2.completo === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · REGOLA 1 — un campione non si porta dietro un buco che nessuno ha osservato');
{
  const passo = 5 * 60_000;
  // Un solo campione all'inizio della giornata, poi silenzio per 24 ore.
  const r = SI.integra({ giorno: G, campioni: [{ t: t0, r: 240 }], now: t0 + 24 * ORA });
  const attesa = 240 * ((2 * passo) / 86_400_000);
  ok('vale al più DUE passi, non l\'intera giornata', vicino(r.usd, attesa, 1e-3),
    `$${r.usd} (due passi) invece di $240 (tutto il giorno)`);
  ok('  e il resto risulta scoperto', r.coperturaFrazione < 0.02, `${(r.coperturaFrazione * 100).toFixed(2)}%`);
  ok('  con `completo` falso', r.completo === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · REGOLA 2 — uno scoperto sottostima, e lo dice');
{
  const passo = 5 * 60_000;
  const c = [];
  for (let t = t0; t < t0 + 12 * ORA; t += passo) c.push({ t, r: 24 });   // mezza giornata campionata
  const r = SI.integra({ giorno: G, campioni: c, now: t0 + 24 * ORA });
  ok('mezza giornata a 24 $/g dà ~$12, non $24', r.usd > 11.9 && r.usd < 12.1, `$${r.usd}`);
  ok('  e la copertura dice che è mezza', r.coperturaFrazione > 0.49 && r.coperturaFrazione < 0.51,
    `${(r.coperturaFrazione * 100).toFixed(1)}%`);
  ok('  il verso dell\'errore è la SOTTOstima', r.usd < 24, 'mai si credita un intervallo non osservato');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · REGOLA 3 — un tasso non misurabile non è uno zero');
{
  const file = path.join(dir, 'campioni.json');
  const scritti = [];
  const deps = { file, leggi: () => ({ v: 1, giorni: {} }), scrivi: (f, d) => scritti.push(d) };
  for (const cattivo of [null, undefined, NaN, Infinity, 'x', -3]) {
    const w = SI.registraCampione({ tMs: t0, tassoUsdPerDay: cattivo }, deps);
    ok(`  tasso ${String(cattivo)} non viene registrato`, w.scritto === false);
  }
  const w = SI.registraCampione({ tMs: t0, tassoUsdPerDay: 0 }, deps);
  ok('uno ZERO VERO invece si registra', w.scritto === true, 'sapere che non maturavi è un\'informazione');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · persistenza: si scrive, si rilegge, si pota');
{
  const file = path.join(dir, 'reg.json');
  for (let i = 0; i < 5; i++) SI.registraCampione({ tMs: t0 + i * 60_000, tassoUsdPerDay: 10 + i }, { file });
  const c = SI.campioniDi(G, { file });
  ok('i campioni tornano ordinati e completi', c.length === 5 && c[0].r === 10 && c[4].r === 14);
  const r = SI.integra({ giorno: G, campioni: c, now: t0 + 24 * ORA });
  ok('  e sono integrabili', Number.isFinite(r.usd) && r.usd > 0, `$${r.usd}`);

  // La potatura tiene GIORNI_TENUTI chiavi, e non cancella un giorno appena scritto a ritroso.
  for (const g of ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']) {
    SI.registraCampione({ tMs: Date.parse(`${g}T12:00:00Z`), tassoUsdPerDay: 5 }, { file });
  }
  const dati = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(`restano ${SI.GIORNI_TENUTI} giorni`, Object.keys(dati.giorni).length === SI.GIORNI_TENUTI,
    Object.keys(dati.giorni).join(', '));
  ok('  e sono i più recenti', Object.keys(dati.giorni).includes(G));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6 · il passo, e il rifiuto dei valori assurdi');
{
  ok('difetto 5 minuti', SI.passoMs({}) === 5 * 60_000);
  ok('  configurabile', SI.passoMs({ MAKER_STIMA_PASSO_MS: String(10 * 60_000) }) === 10 * 60_000);
  for (const v of ['0', '1', String(60 * 60_000), 'pippo', '-5']) {
    ok(`  «${v}» viene scartato in favore del difetto`, SI.passoMs({ MAKER_STIMA_PASSO_MS: v }) === 5 * 60_000);
  }
  ok('l\'estensione è due passi', SI.estensioneMaxMs({}) === 2 * SI.passoMs({}));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7 · il confronto col bonifico usa la QUANTITÀ, non il tasso');
{
  const file = path.join(dir, 'confronto.json');
  fs.writeFileSync(file, JSON.stringify({ giorni: [] }));
  const deps = { confrontoFile: file };

  CR.registraStima({ giorno: G, stimaUsd: 49.17, perMercato: null }, deps);
  CR.registraReale({ giorno: G, disponibile: true, realeUsd: 3.6792 }, deps);
  let riga = JSON.parse(fs.readFileSync(file, 'utf8')).giorni[0];
  ok('con la sola fotografia lo scarto è quello storico', Math.round(riga.percentuale) === 1236,
    `${riga.percentuale}%`);
  ok('  e la base è dichiarata «istantanea»', riga.scartoBase === 'istantanea');

  CR.registraStimaIntegrata({ giorno: G, integrataUsd: 4.67, coperturaFrazione: 0.095, campioni: 27, completo: false }, deps);
  riga = JSON.parse(fs.readFileSync(file, 'utf8')).giorni[0];
  ok('scritta l\'integrata, lo scarto si RICALCOLA da solo', Math.round(riga.percentuale) === 27,
    `${riga.percentuale}%, da +1236%`);
  ok('  e la base diventa «integrata»', riga.scartoBase === 'integrata');
  ok('  la fotografia NON viene buttata', riga.stimaUsd === 49.17,
    'è la serie con cui è stato misurato il +465%: toglierla renderebbe prima e dopo non confrontabili');
  ok('  la copertura viaggia col numero', riga.stimaCopertura === 0.095 && riga.stimaCampioni === 27);
  ok('  e «completa» è falso', riga.stimaCompleta === false);

  // baseStima: la preferenza è una funzione sola, e la si può interrogare.
  ok('baseStima preferisce l\'integrata', CR.baseStima({ stimaUsd: 10, stimaIntegrataUsd: 2 }).base === 'integrata');
  ok('  e ripiega sulla fotografia se manca', CR.baseStima({ stimaUsd: 10 }).base === 'istantanea');
  ok('  e su niente non inventa', CR.baseStima({}).usd === null);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n8 · il 10 agosto: la stessa causa a segno invertito');
{
  // Alle 23:55 non c'erano ordini vivi, ma le prime sei ore ne avevano avuti: la fotografia vede zero,
  // l'integrale no. È il caso che il registro dichiarava come sottostima del 100%.
  const g = '2026-08-10';
  const s0 = Date.parse(`${g}T00:00:00.000Z`);
  const passo = 5 * 60_000;
  const c = [];
  for (let t = s0; t < s0 + 6 * ORA; t += passo) c.push({ t, r: 33 });
  for (let t = s0 + 6 * ORA; t < s0 + 24 * ORA; t += passo) c.push({ t, r: 0 });
  const r = SI.integra({ giorno: g, campioni: c, now: s0 + 24 * ORA });
  ok('la fotografia delle 23:55 avrebbe visto ZERO', c[c.length - 1].r === 0);
  ok('  l\'integrale invece vede le prime sei ore', r.usd > 8 && r.usd < 8.5, `$${r.usd}`);
  ok('  con copertura piena, perché lo zero è misurato e non ignoto', r.coperturaFrazione > 0.99,
    `${(r.coperturaFrazione * 100).toFixed(0)}%`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n===== stima-integrata: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// scripts/registra-mercati-orfani.js — I MERCATI IN GESTIONE CHE HANNO PERSO LE REGOLE.
//
// ═══ IL PROBLEMA CHE SANA ════════════════════════════════════════════════════════════════════════════
// Un mercato aperto da agent41 vive sulle regole del board reward. Il board ruota ogni 15 minuti e tiene
// i primi 120 per montepremi: quando un mercato ne esce mentre la posizione e' ancora aperta,
// `resolveMarketRules` non trova piu' tick, banda, minSize e negRisk e risponde `rules-unreadable`. Da
// li' si fermano INSIEME chiusura automatica, riprezzatura, tracking e qualunque ordine — la posizione
// resta senza via d'uscita.
//
// Dal 9 agosto 2026 agent41 copia le regole nel catalogo di ripiego quando apre un mercato, quindi il
// problema non si ripresenta. Questo script serve ai mercati aperti PRIMA di quella correzione, che una
// copia non ce l'hanno e non possono piu' prenderla dal board: il board non li ha piu'.
//
// ═══ DA DOVE PRENDE I DATI, E PERCHE' DA LI' ═════════════════════════════════════════════════════════
// Da `fetchMarketByConditionId` — la STESSA funzione che usa il pannello operatore quando aggiunge un
// mercato a mano (app/api/maker/markets/enable/route.ts). Quindi i numeri sono quelli del venue, letti
// adesso, non ricostruiti da una cache nostra: tick, negRisk e i due token id non si possono dedurre,
// e indovinarli produrrebbe ordini fuori banda invece di un rifiuto leggibile.
// Gamma e' un endpoint pubblico di sola lettura: nessuna credenziale, nessuna firma.
//
// ═══ COSA PUO' E COSA NON PUO' FARE ══════════════════════════════════════════════════════════════════
// Scrive UNA cosa sola: `data/maker-manual-markets.json`, cioe' metadati. Non piazza, non cancella, non
// arma, non tocca la allowlist ne' la gestione manuale ne' l'uscita automatica. Come dice l'intestazione
// di market-catalog.js, essere nel catalogo NON rende un mercato piazzabile: puo' solo rendere un ordine
// RIFIUTABILE con un motivo leggibile invece che per un dato mancante. E l'effetto pratico su una
// posizione orfana e' che l'uscita automatica torna a poter agire.
//
// ═══ USO ═════════════════════════════════════════════════════════════════════════════════════════════
//   node scripts/registra-mercati-orfani.js            anteprima: dice cosa farebbe, NON scrive
//   node scripts/registra-mercati-orfani.js --esegui    scrive
// L'anteprima e' il difetto, non l'opzione: un comando che modifica stato al primo invio e' un comando
// che viene lanciato per sbaglio esattamente una volta.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

for (const envFile of ['.env.local', '.env']) {
  try {
    for (const l of fs.readFileSync(path.join(ROOT, envFile), 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* assente: si prosegue, Gamma non chiede credenziali */ }
}

const { readAutoCloseConfig } = require(path.join(ROOT, 'lib/maker/auto-close-config'));
const { readAutoRepriceConfig } = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
const { readMarketCatalog, upsertMarket, missingFields } = require(path.join(ROOT, 'lib/maker/market-catalog'));
const { fetchMarketByConditionId } = require(path.join(ROOT, 'lib/maker/market-search'));

const BOARD = '/tmp/liquidity-rewards.json';
const ESEGUI = process.argv.includes('--esegui');
const BY = 'script una tantum · sanatoria mercati orfani (9 agosto 2026)';
const REASON = 'il mercato e\' uscito dal board mentre era in gestione: senza copia delle regole si fermano uscita, riprezzatura e tracking';

function idsSulBoard() {
  try {
    const raw = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    return new Set((raw.markets || []).map((m) => String((m && m.marketId) || '').toLowerCase()).filter(Boolean));
  } catch { return null; }
}

(async () => {
  console.log('\n' + '═'.repeat(100));
  console.log(`MERCATI ORFANI — ${ESEGUI ? 'ESECUZIONE (scrive il catalogo)' : 'ANTEPRIMA (non scrive niente)'}`);
  console.log('═'.repeat(100) + '\n');

  const board = idsSulBoard();
  if (!board) {
    console.log('board normalizzato illeggibile: senza sapere chi C\'E\' sul board non si puo\' sapere chi ne e\' fuori.');
    process.exit(1);
  }
  const cat = readMarketCatalog({});
  if (!cat.readable) {
    console.log(`catalogo illeggibile (${cat.error}): non si scrive su un file che non si e' potuto leggere.`);
    process.exit(1);
  }
  const inCat = new Set(Object.keys(cat.markets || {}).map((x) => x.toLowerCase()));

  const gestiti = [...new Set([
    ...(readAutoCloseConfig({}).enabledMarketIds || []),
    ...(readAutoRepriceConfig({}).enabledMarketIds || []),
  ].map((x) => String(x).trim().toLowerCase()))].filter((x) => /^0x[0-9a-f]{64}$/.test(x));

  const orfani = gestiti.filter((id) => !board.has(id) && !inCat.has(id));
  console.log(`in gestione: ${gestiti.length} · sul board: ${gestiti.filter((i) => board.has(i)).length}`
    + ` · gia' nel catalogo: ${gestiti.filter((i) => inCat.has(i)).length} · ORFANI: ${orfani.length}\n`);
  if (!orfani.length) { console.log('niente da fare.'); return; }

  let sanati = 0; let saltati = 0;
  for (const id of orfani) {
    process.stdout.write(`${id.slice(0, 12)}… `);
    let r;
    try { r = await fetchMarketByConditionId(id, {}); }
    catch (e) { console.log(`✗ lettura dal venue fallita: ${e.message}`); saltati += 1; continue; }
    if (!r || !r.ok || !r.market) { console.log(`✗ non leggibile dal venue: ${(r && r.error) || 'risposta vuota'}`); saltati += 1; continue; }

    const m = r.market;
    const miss = missingFields(m);
    if (miss.length) {
      // Fail-closed: un record incompleto non si registra. Meglio restare orfani con un motivo che
      // avere un ripiego con un tick indovinato — il primo si vede nei log, il secondo produce ordini.
      console.log(`✗ metadati incompleti dal venue (mancano: ${miss.join(', ')}) — non registrato`);
      saltati += 1; continue;
    }
    const et = `tick ${m.tick} · negRisk ${m.negRisk} · banda ${m.rewardsMaxSpreadCents ?? '—'} · minSize ${m.rewardsMinSize ?? '—'}`;
    if (!ESEGUI) { console.log(`→ REGISTREREBBE: ${et} · «${String(m.question || '').slice(0, 45)}»`); sanati += 1; continue; }
    const w = upsertMarket(m, { by: BY, reason: REASON }, {});
    if (!w.ok) { console.log(`✗ scrittura rifiutata: ${w.error}`); saltati += 1; continue; }
    console.log(`✓ registrato: ${et}`);
    sanati += 1;
  }

  console.log(`\n${ESEGUI ? 'registrati' : 'registrabili'}: ${sanati} · saltati: ${saltati}`);
  if (!ESEGUI) console.log('\nnessun file e\' stato scritto. Per scrivere: node scripts/registra-mercati-orfani.js --esegui');
})().catch((e) => { console.error('errore:', e && e.message ? e.message : e); process.exit(1); });

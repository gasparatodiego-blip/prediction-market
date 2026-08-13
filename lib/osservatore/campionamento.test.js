'use strict';

/**
 * L'OSSERVATORE — le proprietà che non devono mai cambiare.
 *
 *   ① una fonte che non risponde produce `null` e il campione si scrive lo stesso;
 *   ② un campione saltato si VEDE (non è indistinguibile da «non è successo niente»);
 *   ③ ogni grandezza dichiara la propria provenienza, e `null` non è mai zero;
 *   ④ il processo è STRUTTURALMENTE incapace di toccare capitale — provato camminando l'albero
 *      dei `require`, come per agent42 e agent44.
 */

const fs = require('fs');
const path = require('path');
const OSS = require('./campionamento');

let passati = 0; let falliti = 0;
const ok = (nome, cond, extra = '') => {
  if (cond) { passati++; console.log(`  ✓ ${nome}`); }
  else { falliti++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

const T = 1_800_000_000_000;
const POS_OK = {
  leggibile: true, readable: true, ageMs: 30_000,
  positions: [
    { conditionId: '0xaaa', tokenId: '1', size: 10, curPrice: 0.5, avgPrice: 0.45, title: 'A' },
    { conditionId: '0xaaa', tokenId: '2', size: 10, curPrice: 0.5, avgPrice: 0.45, title: 'A' },
    { conditionId: '0xbbb', tokenId: '3', size: 20, curPrice: 0.25, avgPrice: 0.30, title: 'B' },
  ],
};
const SALDO_OK = { usd: 500, affidabile: true, motivo: null };

// ══ ① LA FONTE CHE NON RISPONDE ════════════════════════════════════════════════════════════════
console.log('\n── una fonte che tace produce null, e il campione si scrive lo stesso');
{
  const c = OSS.costruisciCampione({ ora: T, saldo: null, posizioni: null, baseline: null,
    ordini: null, nozionaleABook: null, reward: null, statoBot: null, kill: null, latch: null });
  ok('il campione esiste comunque', c && c.atIso === new Date(T).toISOString());
  ok('saldo null, non zero', c.saldoUsd === null);
  ok('posizioni null, non zero', c.posizioniAperte === null && c.posizioniValoreUsd === null);
  ok('ordini null, non zero', c.ordiniAperti === null);
  ok('totale null quando manca un addendo', c.totalePortafoglioUsd === null);
  ok('e la provenienza è null, non «diretta»', c.saldoFonte === null && c.posizioniFonte === null);
  ok('il motivo del saldo mancante è dichiarato', typeof c.saldoMotivo === 'string' && c.saldoMotivo.length > 0);

  // Il caso insidioso: la fonte risponde ma dichiara di non essere affidabile.
  const c2 = OSS.costruisciCampione({ ora: T, saldo: { usd: 0, affidabile: false, motivo: 'RPC muto' } });
  ok('un saldo NON affidabile non diventa 0', c2.saldoUsd === null && /RPC muto/.test(c2.saldoMotivo));
  // E il caso opposto: uno zero LETTO è un fatto, e va tenuto.
  const c3 = OSS.costruisciCampione({ ora: T, saldo: { usd: 0, affidabile: true, motivo: null }, posizioni: POS_OK });
  ok('uno zero LETTO resta zero (funder vuoto è un fatto)', c3.saldoUsd === 0 && c3.saldoFonte === 'diretta');
}

console.log('\n── una posizione senza prezzo non inventa un valore');
{
  const rotte = { leggibile: true, readable: true, ageMs: 10, positions: [
    { conditionId: '0xccc', tokenId: '9', size: 10, curPrice: null, title: 'C' }] };
  const c = OSS.costruisciCampione({ ora: T, posizioni: rotte });
  ok('il mercato si conta', c.mercatiConPosizione === 1);
  ok('ma il valore resta null', c.posizioniValoreUsd === null);
  ok('e il totale non si calcola su un addendo mancante',
    OSS.costruisciCampione({ ora: T, saldo: SALDO_OK, posizioni: rotte }).totalePortafoglioUsd === null);
}

// ══ ② IL CAMPIONE SALTATO SI VEDE ══════════════════════════════════════════════════════════════
console.log('\n── un campione saltato risulta come salto, non come silenzio');
{
  const regolare = OSS.costruisciCampione({ ora: T, precedenteAt: T - OSS.CADENZA_MS });
  ok('a cadenza regolare non ci sono salti', regolare.saltati === 0 && regolare.ritardoMs === 0);
  ok('  e l\'intervallo è comunque dichiarato', regolare.intervalloMs === OSS.CADENZA_MS);

  const jitter = OSS.costruisciCampione({ ora: T, precedenteAt: T - (OSS.TOLLERANZA_SALTO_MS - 1000) });
  ok('il jitter sotto tolleranza NON è un salto', jitter.saltati === 0);

  const buco = OSS.costruisciCampione({ ora: T, precedenteAt: T - 5 * OSS.CADENZA_MS });
  ok('cinque minuti di buco = 4 campioni saltati', buco.saltati === 4, String(buco.saltati));
  ok('  e il ritardo è dichiarato', buco.ritardoMs === 4 * OSS.CADENZA_MS);

  const primo = OSS.costruisciCampione({ ora: T, precedenteAt: null });
  ok('il primo campione non inventa un salto', primo.saltati === 0 && primo.intervalloMs === null);

  ok('e il salto ha una riga di giornale che lo dice',
    /saltato/.test(OSS.rigaEvento({ tipo: 'salto', at: T, saltati: 4, ritardoMs: 240_000 })));
}

// ══ ③ PROVENIENZA E RAGGRUPPAMENTO ═════════════════════════════════════════════════════════════
console.log('\n── le posizioni si raggruppano per mercato, e la provenienza è dichiarata');
{
  const c = OSS.costruisciCampione({ ora: T, saldo: SALDO_OK, posizioni: POS_OK });
  ok('due mercati, uno con entrambe le gambe e uno nudo',
    c.mercatiConPosizione === 2 && c.mercatiEntrambeGambe === 1 && c.mercatiUnaGamba === 1);
  ok('tre posizioni per $15', c.posizioniAperte === 3 && Math.abs(c.posizioniValoreUsd - 15) < 1e-9);
  ok('totale = saldo + posizioni', Math.abs(c.totalePortafoglioUsd - 515) < 1e-9);
  ok('le posizioni sono osservazione DIRETTA', c.posizioniFonte === 'diretta' && c.mercatiFonte === 'diretta');

  const conOrdini = OSS.costruisciCampione({ ora: T, ordini: { totale: 12, etaMs: 4000 } });
  ok('gli ordini sono dichiarati RICOSTRUITI, mai diretti', conOrdini.ordiniFonte === 'ricostruita');
  ok('  con l\'età della ricostruzione', conOrdini.ordiniEtaMs === 4000);
  ok('gli ordini PER MERCATO restano null, e il motivo è scritto',
    conOrdini.ordiniPerMercato === null && /redatto/.test(conOrdini.ordiniPerMercatoMotivo));
}

console.log('\n── il latch assente è «disarmato», non «sconosciuto»');
{
  const c = OSS.costruisciCampione({ ora: T, latch: null });
  ok('nessun file di latch ⇒ disarmato', c.latchGuardiano === false);
  const s = OSS.costruisciCampione({ ora: T, latch: { scattato: true, atIso: 'x' } });
  ok('latch presente ⇒ scattato', s.latchGuardiano === true && s.latchAtIso === 'x');
}

// ══ LE TRANSIZIONI DI COPERTURA ════════════════════════════════════════════════════════════════
console.log('\n── le transizioni coperta ⇄ scoperta, con la durata');
{
  const nudo = { perMercato: [{ conditionId: '0xaaa', coppiaCompleta: false }] };
  const coperto = { perMercato: [{ conditionId: '0xaaa', coppiaCompleta: true }] };

  const t1 = OSS.transizioniCopertura({ precedente: coperto, corrente: nudo, scoperteDa: new Map(), ora: T });
  ok('coperta → scoperta emette l\'evento', t1.eventi.length === 1 && t1.eventi[0].tipo === 'scoperta');
  ok('  e l\'orologio parte', t1.scoperteDa.get('0xaaa') === T);

  // Restando scoperta NON si riemette l'evento a ogni giro: il giornale resterebbe illeggibile.
  const t2 = OSS.transizioniCopertura({ precedente: nudo, corrente: nudo, scoperteDa: t1.scoperteDa, ora: T + 60_000 });
  ok('restare scoperta non riemette niente', t2.eventi.length === 0);

  const t3 = OSS.transizioniCopertura({ precedente: nudo, corrente: coperto, scoperteDa: t2.scoperteDa, ora: T + 600_000 });
  ok('scoperta → coperta emette la chiusura con la DURATA',
    t3.eventi.length === 1 && t3.eventi[0].tipo === 'coperta' && t3.eventi[0].durataMin === 10);
  ok('  e l\'orologio si azzera', t3.scoperteDa.size === 0);

  // La posizione che sparisce del tutto chiude comunque la scopertura.
  const t4 = OSS.transizioniCopertura({ precedente: nudo, corrente: { perMercato: [] }, scoperteDa: t1.scoperteDa, ora: T + 300_000 });
  ok('la posizione chiusa chiude anche la scopertura',
    t4.eventi.length === 1 && t4.eventi[0].tipo === 'chiusa' && t4.eventi[0].durataMin === 5);

  const t5 = OSS.transizioniCopertura({ precedente: null, corrente: nudo, scoperteDa: new Map(), ora: T });
  ok('un mercato che compare già scoperto è distinto da una transizione', t5.eventi[0].tipo === 'scoperta-nuova');
}

// ══ IL GIORNALE LEGGIBILE DA TELEFONO ══════════════════════════════════════════════════════════
console.log('\n── il giornale sta su uno schermo di telefono');
{
  const eventi = [
    { tipo: 'pre-allarme', at: T, conferme: 1, pnlUsd: -36.15 },
    { tipo: 'scatto', at: T, pnlUsd: -36.15, pnlPct: -5.47 },
    { tipo: 'collasso', at: T, ordini: 2, massimo: 23, caloPct: 91.3 },
    { tipo: 'scoperta', at: T, conditionId: '0xcd126ec4303c96' },
    { tipo: 'coperta', at: T, conditionId: '0xcd126ec4303c96', durataMin: 12.5 },
    { tipo: 'chiusa', at: T, conditionId: '0xcd126ec4303c96', durataMin: 492 },
    { tipo: 'merge', at: T, esito: 'ok', conditionId: '0xcb034071d5' },
    { tipo: 'cancellazione', at: T, quanti: 23, source: 'auto-reprice-band-exit' },
    { tipo: 'errore', at: T, messaggio: 'la fonte non risponde e il giro prosegue lo stesso' },
    { tipo: 'salto', at: T, saltati: 2, ritardoMs: 120_000 },
  ];
  const lunghe = eventi.map(OSS.rigaEvento).filter((r) => r.length > OSS.LARGHEZZA_MAX);
  ok(`nessuna riga di evento supera ${OSS.LARGHEZZA_MAX} caratteri`, lunghe.length === 0, lunghe[0] || '');
  ok('ogni riga porta l\'ora', eventi.map(OSS.rigaEvento).every((r) => /^\d{2}:\d{2}/.test(r)));

  const sintesi = OSS.bloccoSintesi({
    campioni: [OSS.costruisciCampione({ ora: T, saldo: SALDO_OK, posizioni: POS_OK, ordini: { totale: 12, etaMs: 100 } })],
    oraEtichetta: '2026-08-13 14:00 UTC',
  });
  const largheSintesi = sintesi.split('\n').filter((r) => r.length > OSS.LARGHEZZA_MAX);
  ok('nemmeno la sintesi supera la larghezza', largheSintesi.length === 0, largheSintesi[0] || '');
  ok('la sintesi dichiara che gli ordini sono ricostruiti', /ricostruito/.test(sintesi));
  ok('una sintesi senza campioni lo dice invece di fingere',
    /nessun campione/.test(OSS.bloccoSintesi({ campioni: [], oraEtichetta: 'x' })));
}

// ══ LA RETENZIONE NON PUÒ CANCELLARE FILE ALTRUI ═══════════════════════════════════════════════
console.log('\n── la pulizia tocca solo i propri file, e solo quelli scaduti');
{
  const nomi = ['campioni-2026-07-01.jsonl', 'giornale-2026-07-01.md',
    'campioni-2026-08-13.jsonl', 'giornale-2026-08-13.md',
    'guardian-state.json', '.env', 'campioni-di-qualcunaltro.jsonl', 'campioni-2026-08-12.jsonl'];
  const via = OSS.fileDaCancellare({ nomi, oggiIso: '2026-08-13' });
  ok('i file di 43 giorni fa si cancellano', via.includes('campioni-2026-07-01.jsonl') && via.includes('giornale-2026-07-01.md'));
  ok('quelli di ieri e di oggi restano',
    !via.includes('campioni-2026-08-13.jsonl') && !via.includes('campioni-2026-08-12.jsonl'));
  ok('NESSUN file che non abbia scritto lui viene toccato',
    !via.includes('guardian-state.json') && !via.includes('.env') && !via.includes('campioni-di-qualcunaltro.jsonl'));
  ok('una data illeggibile non cancella niente', OSS.fileDaCancellare({ nomi, oggiIso: null }).length === 0);
}

// ══ ④ STRUTTURALMENTE INCAPACE DI TOCCARE CAPITALE ═════════════════════════════════════════════
console.log('\n── l\'osservatore non può piazzare, cancellare o cambiare stato');
{
  const RADICE = path.join(__dirname, '..', '..');
  const visti = new Set();
  const coda = [path.join(RADICE, 'agents', 'agent45-osservatore.js')];
  // Le superfici che NON devono comparire da nessun ramo dell'albero.
  const VIETATI = [
    'venues/polymarket-clob-maker/adapter', 'venues/polymarket-clob-maker/signer',
    'maker/manual-order', 'maker/cancel-all', 'maker/bulk-allocate', 'maker/auto-close',
    'maker/bot-enabled', 'safety/kill-switch', 'maker/ctf-relayer',
  ];
  const trovati = [];
  while (coda.length) {
    const f = coda.pop();
    if (visti.has(f) || !fs.existsSync(f)) continue;
    visti.add(f);
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    // I `require` dentro le STRINGHE non contano (§5.3): si tolgono i commenti e si guarda la forma vera.
    const nudo = src.replace(/^\s*\/\/.*$/gm, '');
    for (const m of nudo.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      const rel = m[1];
      for (const v of VIETATI) if (rel.includes(v.split('/').pop()) && rel.includes(v.split('/')[0])) trovati.push({ in: path.relative(RADICE, f), rel });
      let dest = path.resolve(path.dirname(f), rel);
      if (!dest.endsWith('.js')) dest += '.js';
      coda.push(dest);
    }
  }
  ok(`l'albero dei require non raggiunge nessuna superficie proibita (${visti.size} file)`,
    trovati.length === 0, JSON.stringify(trovati.slice(0, 3)));

  // E il sorgente non nomina nemmeno le azioni: nessuna scrittura fuori da data/osservatore/.
  const src = fs.readFileSync(path.join(RADICE, 'agents', 'agent45-osservatore.js'), 'utf8');
  const scritture = [...src.matchAll(/fs\.(appendFileSync|writeFileSync|unlinkSync|renameSync)\(/g)].length;
  ok('le scritture su disco sono poche e circoscritte', scritture > 0 && scritture <= 6, String(scritture));
  ok('non esiste nessuna chiamata a impostaBot o al kill switch',
    !/impostaBot|killStatus\(|scriviKill/.test(src));
}

console.log(`\nosservatore: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

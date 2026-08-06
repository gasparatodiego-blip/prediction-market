#!/usr/bin/env node
'use strict';
// LA VELOCITÀ DI UN MERCATO SI MISURA, NON SI IMMAGINA — E NON DECIDE NIENTE.
//
// ═══ DA DOVE VIENE ══════════════════════════════════════════════════════════════════════════════════
// La diagnosi del feed fermo del 6 agosto 2026 ha misurato che i mercati su cui stava il capitale erano
// da 5 a 13 volte più silenziosi della media del board (TX-15 26% di campioni senza eventi websocket in
// 75s, Ed Markey 18%, MI-10 16%, Rhode Island 10%, contro il 2% del resto). Il pannello di allocazione
// non aveva modo di dirlo: mostrava montepremi, quota modellata, concorrenza in banda, banda e
// scadenza, e niente sulla vivacità del mercato.
//
// ═══ COSA VERIFICA QUESTO FILE ══════════════════════════════════════════════════════════════════════
//   1 · l'aggregazione è corretta su righe costruite a mano (silenzio, movimento, passi)
//   2 · «non misurato» non diventa mai «immobile»
//   3 · sul GIORNALE VERO i numeri sono plausibili e ritrovano la firma dei mercati lenti
//   4 · la memoria resta O(mercati): il giornale non viene mai caricato intero
//   5 · NESSUN parametro operativo è legato alla misura — verificato sul codice
//
// NESSUN ORDINE REALE, nessuna rete: si legge un file già scritto e si aggregano numeri.

const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('./velocita-mercato');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const T0 = Date.parse('2026-08-06T00:00:00Z');
const riga = (min, marketId, adjMid, src) => JSON.stringify({
  ts: new Date(T0 + min * 60_000).toISOString(), marketId, adjMid, src,
});

console.log('\n══ 1 · L AGGREGAZIONE, SU RIGHE COSTRUITE A MANO');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vel-'));
  const f = path.join(dir, 'mid-history-2026-08-06.jsonl');
  // FERMO: dieci campioni, quattro senza eventi, mid che non si muove mai.
  // MOSSO: dieci campioni, tutti con eventi, mid che sale di 1¢ ogni volta.
  const righe = [];
  for (let i = 0; i < 10; i++) {
    righe.push(riga(i * 1.25, 'FERMO', 0.63, i % 5 < 2 ? 'stale' : 'ws'));
    righe.push(riga(i * 1.25, 'MOSSO', 0.50 + i * 0.01, 'ws'));
  }
  fs.writeFileSync(f, righe.join('\n') + '\n');

  const r = V.leggiVelocita({ dir, now: T0 + 20 * 60_000, windowHours: 6, noCache: true });
  const fermo = r.per.get('FERMO');
  const mosso = r.per.get('MOSSO');

  ok('due mercati misurati', r.mercati === 2, String(r.mercati));
  ok('FERMO: 4 campioni su 10 senza eventi ⇒ 40% di silenzio', fermo.silenzioPct === 40, String(fermo.silenzioPct));
  ok('  e nessun movimento del mid', fermo.movimentoCentsOra === 0 && fermo.passiOra === 0,
    `${fermo.movimentoCentsOra}¢/h · ${fermo.passiOra} passi/h`);
  ok('  con i centesimi-per-passo NULL, non zero: senza passi non c è media',
    fermo.centsPerPasso === null, String(fermo.centsPerPasso));
  ok('MOSSO: nessun silenzio', mosso.silenzioPct === 0, String(mosso.silenzioPct));
  // 9 passi da 1¢ su 11.25 minuti di copertura = 9¢ in 0.1875h = 48¢/h
  ok('  9 passi da 1¢ su 11,25 min ⇒ 48¢/h', Math.abs(mosso.movimentoCentsOra - 48) < 0.5, String(mosso.movimentoCentsOra));
  ok('  e 48 cambi/h', Math.abs(mosso.passiOra - 48) < 0.5, String(mosso.passiOra));
  ok('  a 1¢ per cambio', Math.abs(mosso.centsPerPasso - 1) < 0.01, String(mosso.centsPerPasso));
  ok('la copertura è dichiarata insieme ai campioni',
    fermo.campioni === 10 && Math.abs(fermo.coperturaOre - 0.1875) < 0.01, `${fermo.campioni} campioni, ${fermo.coperturaOre}h`);
}

console.log('\n══ 2 · «NON MISURATO» NON DIVENTA MAI «IMMOBILE»');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vel2-'));
  const r = V.leggiVelocita({ dir, now: T0, windowHours: 6, noCache: true });
  ok('cartella senza giornale ⇒ nessun mercato, nessun numero inventato', r.mercati === 0, String(r.mercati));
  ok('  un mercato assente dalla mappa resta assente', r.per.get('QUALUNQUE') === undefined);
  const et = V.etichettaVelocita(null);
  ok('  e l etichetta dice «non misurato», non «viva»', et.chiave === 'ignota' && /non misurato/.test(et.testo), et.testo);
}
{
  // Un solo campione: c'è il silenzio (è una quota su un campione) ma NON il movimento, che avrebbe
  // bisogno di due punti. Le due assenze sono diverse e restano diverse.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vel3-'));
  fs.writeFileSync(path.join(dir, 'mid-history-2026-08-06.jsonl'), riga(0, 'UNO', 0.5, 'ws') + '\n');
  const r = V.leggiVelocita({ dir, now: T0 + 60_000, windowHours: 6, noCache: true });
  const u = r.per.get('UNO');
  ok('un solo campione: il silenzio si può dire', u.silenzioPct === 0, String(u.silenzioPct));
  ok('  ma il movimento NO — resta null, non zero', u.movimentoCentsOra === null && u.passiOra === null,
    `${u.movimentoCentsOra} / ${u.passiOra}`);
}

console.log('\n══ 3 · SUL GIORNALE VERO DI agent34');
{
  const r = V.leggiVelocita({ windowHours: 6, noCache: true });
  if (r.mercati === 0) {
    ok('giornale reale disponibile', false, 'nessun mid-history in data/ — verifica NON eseguita');
  } else {
    ok(`misurati ${r.mercati} mercati reali`, r.mercati >= 50, `${r.mercati} mercati`);
    const v = [...r.per.values()];
    ok('  ogni silenzio è una percentuale sensata', v.every((x) => x.silenzioPct >= 0 && x.silenzioPct <= 100));
    ok('  ogni movimento è non negativo o null', v.every((x) => x.movimentoCentsOra == null || x.movimentoCentsOra >= 0));
    ok('  la finestra è dichiarata insieme ai numeri', r.finestraOre === 6 && r.passoCampioneSec === 75);
    // LA FIRMA CHE HA PRODOTTO QUESTO LAVORO: la distribuzione deve essere larga, cioè devono esistere
    // sia mercati praticamente sempre osservati sia mercati silenziosi per un quarto del tempo. Se
    // fossero tutti uguali la misura non servirebbe a scegliere niente.
    const ordinati = v.filter((x) => x.campioni >= 100).map((x) => x.silenzioPct).sort((a, b) => a - b);
    if (ordinati.length >= 10) {
      const mediana = ordinati[Math.floor(ordinati.length / 2)];
      const peggiore = ordinati[ordinati.length - 1];
      ok(`  la mediana del board è bassa (${mediana}%)`, mediana <= 10, `${mediana}%`);
      ok(`  ma esistono mercati molto più silenziosi (max ${peggiore}%)`, peggiore >= mediana * 2,
        `mediana ${mediana}% · peggiore ${peggiore}%`);
      ok('  cioè la misura DISTINGUE i mercati invece di dire la stessa cosa su tutti',
        peggiore - mediana >= 5, `scarto ${(peggiore - mediana).toFixed(1)} punti`);
    } else {
      ok('  campioni sufficienti per la distribuzione', false, `solo ${ordinati.length} mercati con ≥100 campioni`);
    }
  }
}

console.log('\n══ 4 · LA MEMORIA RESTA O(MERCATI) — il giornale non si carica mai intero');
{
  const src = fs.readFileSync(path.join(__dirname, 'velocita-mercato.js'), 'utf8');
  ok('nessun readFileSync sul giornale', !/readFileSync\([^)]*mid-history/.test(src));
  ok('  si legge a blocchi con un tetto dichiarato', /BLOCCO/.test(src) && /TETTO_BYTE/.test(src));
  ok('  e si tengono solo aggregati, mai le righe', /nuovoAcc/.test(src) && !/righe\.push/.test(src));
  // La prova sul campo: leggere 6 ore di giornale vero non deve far crescere l'heap in modo sensibile.
  const prima = process.memoryUsage().heapUsed;
  V.leggiVelocita({ windowHours: 6, noCache: true });
  const dopo = process.memoryUsage().heapUsed;
  const cresciutoMB = (dopo - prima) / 1048576;
  ok(`  leggere 6h di giornale vero costa poco heap (${cresciutoMB.toFixed(0)} MB)`, cresciutoMB < 60,
    `${cresciutoMB.toFixed(0)} MB su un file di decine di MB`);
}

console.log('\n══ 5 · NESSUN PARAMETRO OPERATIVO È LEGATO A QUESTA MISURA');
{
  const alloc = fs.readFileSync(path.join(__dirname, 'allocator.js'), 'utf8');
  // Il knapsack non deve nemmeno vedere la velocità: si attacca DOPO, sui candidati già formati.
  const posPlan = alloc.indexOf('function planAllocation');
  const posFrom = alloc.indexOf('function planFromCollection');
  const posVel = alloc.indexOf("require('./velocita-mercato')");
  ok('la velocità entra solo in planFromCollection, non nel knapsack', posVel > posFrom && posFrom > posPlan,
    `planAllocation@${posPlan} · planFromCollection@${posFrom} · velocità@${posVel}`);
  ok('  e non compare in nessuna espressione di scelta o di ordinamento',
    !/velocita[^\n]*(sort|filter\(|status =|capital =|score)/i.test(alloc));

  // Nessun modulo del motore la legge: né il riprezzo, né il tracking, né la soglia di movimento.
  const motori = ['../maker/auto-reprice.js', '../maker/mm-tracking.js', '../maker/offset-config.js', '../maker/prezzo-in-coda.js'];
  const colpevoli = motori.filter((m) => {
    try { return /velocita-mercato/.test(fs.readFileSync(path.join(__dirname, m), 'utf8')); } catch { return false; }
  });
  ok('nessun modulo operativo importa la misura', colpevoli.length === 0, colpevoli.join(', ') || 'nessuno');
}

console.log(`\nvelocità di mercato: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

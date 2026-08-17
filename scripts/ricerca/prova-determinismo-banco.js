#!/usr/bin/env node
'use strict';
/**
 * IL BANCO DEVE DARE LO STESSO RISULTATO DIECI VOLTE — sola misura.
 *
 * ═══ PERCHE' (richiesta dell'operatore, 17 agosto 2026) ══════════════════════════════════════════════
 * «Due corse su cinque si fermano al passo 6 a seconda dell'ora vera di partenza. Il banco non deve
 * dipendere dall'orologio: orologio finto e controllato, scadenze GTD relative all'istante zero della
 * simulazione, seme fisso. Poi provalo: dieci corse di fila, stesso risultato dieci volte.»
 *
 * Un banco non deterministico non e' un banco: due esiti sullo stesso codice significano che l'esito non
 * descrive il codice. E soprattutto rende inutile il confronto che serve davvero — «dopo questa modifica
 * qualcosa che scattava ha smesso?» — perche' la differenza puo' venire dal caso.
 *
 * ═══ LA FIRMA, E COSA NON CONTIENE ══════════════════════════════════════════════════════════════════
 * Si confronta: i titoli dei passi con il loro esito, l'elenco delle regole scattate, le forme dinamiche
 * concretizzate e il punto di blocco. NON si confrontano i TIMESTAMP: l'istante zero e' l'ora vera
 * arrotondata al minuto (vedi il blocco sull'orologio in `banco-ciclo-completo`), quindi due corse in due
 * minuti diversi hanno orari diversi e lo STESSO esito — ed e' l'esito che deve essere stabile.
 *
 * Uso:  node scripts/ricerca/prova-determinismo-banco.js [quante]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCEN = path.join(__dirname, 'banco-scenari.js');
const REFERTO = path.join(ROOT, 'data', 'ricerca', 'banco-ciclo-completo.json');
const OUT = path.join(ROOT, 'data', 'ricerca', 'prova-determinismo-banco.json');
const QUANTE = Number(process.argv[2] || 10);

function firma() {
  const r = JSON.parse(fs.readFileSync(REFERTO, 'utf8'));
  const f = {
    passi: r.passi.map((p) => `${p.titolo}|${p.ok === undefined ? '-' : p.ok}`),
    scattate: r.scattate.map((x) => x.regola),
    dinamiche: (r.dinamicheScattate || []).slice().sort(),
    bloccato: r.bloccato ? r.bloccato.dove : null,
  };
  // ⚠ `bloccato` si RIPORTA IN CIMA: la prima stesura leggeva `f.bloccato` sull'oggetto esterno, dove non
  // esiste, e stampava «completo» a ogni corsa — comprese quelle bloccate al passo 6. La firma era giusta
  // (contiene il blocco), la RIGA mentiva. Un banco che dichiara «completo» un giro incompleto e' il
  // difetto peggiore che questo file possa avere.
  return { sha: crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 16), f,
    bloccato: f.bloccato, conteggi: `${r.regoleScattate}+${r.dinamicheConcretizzate}` };
}

(async () => {
  const corse = [];
  console.log(`\n${QUANTE} corse di fila. La firma non contiene i timestamp: contiene l'ESITO.\n`);
  for (let i = 1; i <= QUANTE; i += 1) {
    // Lo storico dei mid si semina a ogni corsa: senza toglierlo si accumulerebbe, e la corsa N+1
    // partirebbe con piu' storia della N — un altro modo di non essere la stessa corsa.
    for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
      if (/^mid-history-.*\.jsonl$/.test(f)) fs.unlinkSync(path.join(ROOT, 'data', f));
    }
    try { execFileSync('node', [SCEN], { cwd: ROOT, stdio: 'pipe', timeout: 900_000 }); }
    catch (e) { /* il banco esce 1 quando il giro e' incompleto: e' un esito, non un errore */ void e; }
    const f = firma();
    corse.push(f);
    console.log(`  ${String(i).padStart(2)}  ${f.sha}  ${f.conteggi.padStart(5)} regole  ${f.bloccato || 'completo'}`);
  }

  const distinte = new Map();
  for (const c of corse) distinte.set(c.sha, (distinte.get(c.sha) || 0) + 1);
  const ok = distinte.size === 1;
  fs.writeFileSync(OUT, JSON.stringify({ generatoIl: new Date().toISOString(), corse: QUANTE,
    firmeDistinte: distinte.size, deterministico: ok,
    dettaglio: [...distinte].map(([sha, n]) => ({ sha, volte: n })),
    firma: corse[0] ? corse[0].f : null }, null, 1));

  console.log(`\nfirme distinte: ${distinte.size} su ${QUANTE} corse`);
  if (ok) console.log(`✅ DETERMINISTICO: ${QUANTE} corse, un solo esito (${corse[0].sha})`);
  else {
    console.log('🔴 NON DETERMINISTICO — le firme:');
    for (const [sha, n] of distinte) console.log(`   ${sha}  ${n} volte`);
    process.exitCode = 1;
  }
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

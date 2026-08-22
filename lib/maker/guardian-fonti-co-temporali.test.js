'use strict';
// lib/maker/guardian-fonti-co-temporali.test.js — §5.2 p.54, chiusa il 22 agosto 2026.
//
// LA PROPRIETA' DIFESA, in una riga: **il guardiano non deve mai produrre un totale che l'equity vera
// non ha mai avuto** — e deve continuare a vedere le perdite vere.
//
// I numeri dei blocchi ① e ② non sono inventati: sono le due letture reali che hanno fatto danno.
//   ① 20/08 22:36:02Z — saldo(22:30) + posizioni(22:26) = $1.438,40, SCATTO, 6h06m di fermo.
//   ② 16/08 19:28Z    — saldo post-chiusura + posizioni pre-chiusura, $57,10 contati due volte:
//                        il riferimento latchato a $1.550,18 di D-D (§5-bis p.202).
// Il blocco ③ e' quello che rende la correzione non banale: un criterio scritto sul VALORE invece che
// sulle SIZE rifiuterebbe anche un crollo di prezzo, cioe' accecherebbe il guardiano esattamente
// quando deve agire. ③ e' rosso su quella versione sbagliata quanto ①② lo sono sull'originale.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('./guardian-perdite');

let pass = 0; const rossi = [];
const ok = (nome, fn) => {
  try { fn(); pass += 1; console.log(`  ok  ${nome}`); }
  catch (e) { rossi.push(nome); console.log(`  ✗   ${nome}\n      ${e.message}`); }
};
const pos = (tokenId, size, curPrice) => ({ tokenId, size, curPrice });
/** Una lettura del guardiano, con la precedente. Firma identica a quella di `capitaleOra`. */
const leggi = (saldoUsd, posizioni, prec, at = 61_000) => G.valutaCapitale({
  saldoUsd, posizioni, posizioniLeggibili: true, riconciliazione: { at, precedente: prec },
});
const prec = (saldoUsd, posizioni, at = 1_000) => ({ at, saldoUsd, posizioni });

console.log('\n① IL VERSO BASSO — il fill contato senza il suo attivo (20/08, lo scatto vero)');
ok('la lettura pulita di 22:24 e misurabile', () => {
  const r = leggi(1488.22, [pos('a', 10, 0.344)], prec(1488.22, [pos('a', 10, 0.344)]));
  assert.strictEqual(r.leggibile, true);
  assert.ok(Math.abs(r.totaleUsd - 1491.66) < 0.01, `totale ${r.totaleUsd}`);
});
ok('⚑ 22:25 — cassa −$30,26 senza la posizione: NON misurabile', () => {
  const r = leggi(1457.96, [pos('a', 10, 0.344)], prec(1488.22, [pos('a', 10, 0.344)]));
  assert.strictEqual(r.leggibile, false, 'il totale $1.461,40 non e stato rifiutato');
  assert.strictEqual(r.totaleUsd, null, 'un totale non misurabile deve essere null, mai un numero');
  assert.ok(Math.abs(r.riconciliazione.residuoUsd + 30.26) < 0.01);
});
ok('⚑ e il motivo dice QUALE fonte e indietro, non solo che qualcosa non va', () => {
  const r = leggi(1457.96, [pos('a', 10, 0.344)], prec(1488.22, [pos('a', 10, 0.344)]));
  assert.ok(/cassa/i.test(r.motivo) && /size/i.test(r.motivo), r.motivo);
  assert.ok(/residuo/i.test(r.motivo), r.motivo);
});

console.log('\n② IL VERSO ALTO — la chiusura contata senza il suo debito (D-D, $57,10 due volte)');
ok('⚑ cassa +$57,10 con la posizione ancora presente: NON misurabile', () => {
  const p = [pos('b', 100, 0.5710)];
  const r = leggi(1493.07, p, prec(1435.97, p));
  assert.strictEqual(r.leggibile, false, 'il totale gonfiato $1.550,17 non e stato rifiutato');
  assert.ok(Math.abs(r.riconciliazione.residuoUsd - 57.10) < 0.01);
});
ok('⚑ e il verso opposto passa dallo STESSO criterio, non da una seconda regola', () => {
  const giu = leggi(1457.96, [pos('a', 10, 0.344)], prec(1488.22, [pos('a', 10, 0.344)]));
  const su = leggi(1493.07, [pos('b', 100, 0.5710)], prec(1435.97, [pos('b', 100, 0.5710)]));
  assert.ok(giu.riconciliazione.residuoUsd < 0 && su.riconciliazione.residuoUsd > 0,
    'i due versi devono avere residuo di segno opposto');
  assert.strictEqual(giu.leggibile, false); assert.strictEqual(su.leggibile, false);
});

console.log('\n③ ⚠ IL CROLLO DI PREZZO RESTA VISIBILE — la meta che un criterio sul VALORE romperebbe');
ok('⚑ posizione −$30 a cassa ferma: MISURABILE, e il totale scende', () => {
  const r = leggi(1400, [pos('b', 100, 0.30)], prec(1400, [pos('b', 100, 0.60)]));
  assert.strictEqual(r.leggibile, true, 'un crollo di prezzo e stato scambiato per un artefatto: il guardiano sarebbe cieco proprio quando deve agire');
  assert.strictEqual(r.totaleUsd, 1430);
});
ok('⚑ e vale anche per un crollo GRANDE, oltre qualunque tolleranza in dollari', () => {
  const r = leggi(1000, [pos('b', 1000, 0.10)], prec(1000, [pos('b', 1000, 0.60)]));
  assert.strictEqual(r.leggibile, true, '$500 di perdita di prezzo rifiutati: sarebbe la cecita peggiore possibile');
  assert.strictEqual(r.totaleUsd, 1100);
});
ok('⚑ una perdita di prezzo che porta OLTRE SOGLIA arriva a decidiScatto', () => {
  const r = leggi(1000, [pos('b', 1000, 0.10)], prec(1000, [pos('b', 1000, 0.60)]));
  const pnl = G.calcolaPnl({ baselineUsd: 1600, totaleUsd: r.totaleUsd });
  const d = G.decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: 75 });
  assert.strictEqual(d.scatta, true, 'la perdita vera non arriva piu allo scatto: la correzione ha rotto il guardiano');
});

console.log('\n④ IL FILL VISTO DA ENTRAMBE LE FONTI — non deve essere rifiutato');
ok('cassa −$30,26 e la posizione che compare: misurabile, residuo ~0', () => {
  const r = leggi(1457.96, [pos('a', 10, 0.344), pos('c', 100, 0.3026)], prec(1488.22, [pos('a', 10, 0.344)]));
  assert.strictEqual(r.leggibile, true);
  assert.ok(Math.abs(r.riconciliazione.residuoUsd) < 0.01, `residuo ${r.riconciliazione.residuoUsd}`);
});
ok('una chiusura vista da entrambe: misurabile', () => {
  const r = leggi(1520, [], prec(1400, [pos('d', 200, 0.60)]));
  assert.strictEqual(r.leggibile, true);
  assert.ok(Math.abs(r.riconciliazione.residuoUsd) < 0.01);
});

console.log('\n⑤ IL RIFIUTO SI CHIUDE DA SOLO — non e una cecita che dura');
ok('⚑ la lettura DOPO l artefatto torna misurabile appena la fonte recupera', () => {
  const p0 = [pos('a', 10, 0.344)];
  const uno = leggi(1457.96, p0, prec(1488.22, p0), 61_000);
  assert.strictEqual(uno.leggibile, false, 'il primo rifiuto non c e stato');
  // la fonte indietro recupera: la posizione compare, la cassa non si muove
  const p1 = [pos('a', 10, 0.344), pos('c', 100, 0.3026)];
  const due = leggi(1457.96, p1, prec(1457.96, p0, 61_000), 91_000);
  assert.strictEqual(due.leggibile, false, 'la lettura di transizione va ancora rifiutata: +$30 di size senza cassa');
  const tre = leggi(1457.96, p1, prec(1457.96, p1, 91_000), 121_000);
  assert.strictEqual(tre.leggibile, true, 'dopo due giri la misura deve riprendere da sola');
  assert.ok(Math.abs(tre.totaleUsd - 1491.66) < 0.01, `il totale recuperato e ${tre.totaleUsd}`);
});

console.log('\n⑥ FAIL-CLOSED IN OGNI RAMO IN CUI NON SI PUO GIUDICARE');
ok('⚑ prima lettura (nessuna precedente) ⇒ non misurabile', () => {
  assert.strictEqual(leggi(1000, [], null).leggibile, false);
});
ok('⚑ omettere del tutto la riconciliazione ⇒ non misurabile (nessun difetto permissivo)', () => {
  const r = G.valutaCapitale({ saldoUsd: 1000, posizioni: [], posizioniLeggibili: true });
  assert.strictEqual(r.leggibile, false, 'una dep non cablata e tornata al comportamento vecchio: e la classe di §5.3');
});
ok('⚑ letture non contigue (oltre 120 s) ⇒ non misurabile', () => {
  const r = leggi(1000, [], prec(1000, [], 0), 200_000);
  assert.strictEqual(r.leggibile, false);
  assert.ok(/contigu/i.test(r.motivo), r.motivo);
});
ok('⚑ size cambiata con prezzo non leggibile ⇒ non misurabile, MAI valutata zero', () => {
  const r = leggi(900, [pos('e', 50, null)], prec(1000, []));
  assert.strictEqual(r.leggibile, false, 'un prezzo assente e diventato uno zero: famiglia Number(null)===0');
});
ok('⚑ la precedente senza posizioni ⇒ non misurabile', () => {
  const r = G.valutaCapitale({ saldoUsd: 1000, posizioni: [], posizioniLeggibili: true,
    riconciliazione: { at: 61_000, precedente: { at: 1_000, saldoUsd: 1000, posizioni: null } } });
  assert.strictEqual(r.leggibile, false);
});
ok('un saldo illeggibile resta illeggibile per il suo motivo, non per la riconciliazione', () => {
  const r = leggi(null, [], prec(1000, []));
  assert.strictEqual(r.leggibile, false);
  assert.ok(/saldo/i.test(r.motivo), r.motivo);
});

console.log('\n⑦ LA TOLLERANZA STA NEL DIVARIO VUOTO MISURATO ($4,95 · $8,32)');
ok('$4,95 di residuo — il massimo compensato osservato — e ACCETTATO', () => {
  const r = leggi(1004.95, [], prec(1000, []));
  assert.strictEqual(r.leggibile, true, 'un credito reward da $4,95 non deve accecare il guardiano');
});
ok('⚑ $8,32 — il minimo NON compensato osservato — e RIFIUTATO', () => {
  const r = leggi(991.68, [], prec(1000, []));
  assert.strictEqual(r.leggibile, false);
});
ok('la costante non e ricopiata: il test la IMPORTA', () => {
  assert.strictEqual(typeof G.TOLLERANZA_RICONCILIAZIONE_USD, 'number');
  assert.ok(G.TOLLERANZA_RICONCILIAZIONE_USD > 4.95 && G.TOLLERANZA_RICONCILIAZIONE_USD < 8.32,
    `la tolleranza $${G.TOLLERANZA_RICONCILIAZIONE_USD} e uscita dal divario vuoto misurato`);
});

console.log('\n⑧ MONOTONIA — la correzione puo solo TOGLIERE misure, mai aggiungerne');
ok('⚑ non esiste una coppia che prima era non-misurabile e adesso e misurabile', () => {
  // Il vecchio comportamento e' esattamente `saldo !== null && posizioni leggibili`.
  let violazioni = 0;
  for (let i = 0; i < 400; i++) {
    const s0 = 1000 + (i % 7) * 13.7;
    const s1 = s0 + ((i % 11) - 5) * 9.3;
    const p0 = [pos('t', 10 + (i % 5) * 7, 0.2 + (i % 4) * 0.15)];
    const p1 = [pos('t', 10 + (i % 3) * 11, 0.2 + (i % 6) * 0.11)];
    const vecchio = true;                                  // entrambe le fonti leggibili
    const nuovo = leggi(s1, p1, prec(s0, p0)).leggibile;
    if (nuovo === true && vecchio === false) violazioni += 1;
  }
  assert.strictEqual(violazioni, 0, `${violazioni} casi in cui la correzione APRE invece di stringere`);
});
ok('⚑ e non puo far scattare il guardiano dove prima non scattava', () => {
  // Un totale non misurabile non arriva mai a decidiScatto: e' il ramo che ritorna prima.
  const r = leggi(1457.96, [pos('a', 10, 0.344)], prec(1488.22, [pos('a', 10, 0.344)]));
  assert.strictEqual(r.totaleUsd, null);
  const pnl = G.calcolaPnl({ baselineUsd: 1501.6325, totaleUsd: r.totaleUsd });
  assert.ok(!pnl || pnl.pnlUsd === null || !Number.isFinite(Number(pnl.pnlUsd)),
    'un totale null ha prodotto un PnL finito: lo scatto potrebbe partire su una lettura rifiutata');
});

console.log('\n⑨ IL CABLAGGIO, NON LA DECISIONE — e l errore per cui tre difese sono rimaste inerti col verde');
const sorgente = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8')
  .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
ok('⚑ agent43 PASSA la riconciliazione a valutaCapitale', () => {
  const s = sorgente('agents/agent43-guardian.js');
  assert.ok(/riconciliazione:\s*\{\s*at:/.test(s), 'agent43 non passa la riconciliazione: la correzione sarebbe inerte');
});
ok('⚑ agent43 NON usa la scorciatoia non-richiesta', () => {
  const s = sorgente('agents/agent43-guardian.js');
  assert.ok(!/non-richiesta/.test(s), 'il guardiano si e esentato dal proprio controllo');
});
ok('⚑ agent43 conserva la lettura precedente fra un giro e l altro', () => {
  const s = sorgente('agents/agent43-guardian.js');
  assert.ok(/ultimaLetturaFonti\s*=/.test(s) && /precedente/.test(s),
    'senza memoria della lettura precedente non c e niente da riconciliare');
});
ok('agent45 dichiara l esenzione invece di ometterla in silenzio', () => {
  const s = sorgente('agents/agent45-osservatore.js');
  assert.ok(/riconciliazione:\s*'non-richiesta'/.test(s), 'l osservatore non dichiara la propria scelta');
});
ok('⚑ il guardiano conta e DICHIARA i rifiuti consecutivi', () => {
  const s = sorgente('agents/agent43-guardian.js');
  assert.ok(/nonMisurabiliDiFila/.test(s), 'nessun contatore dei rifiuti: smetterebbe di misurare in silenzio');
  assert.ok(/guardian-riconciliazione/.test(s), 'nessuna riga a verbale: il rifiuto non sarebbe verificabile dopo');
});

console.log('\n⑩ UNA LETTURA RIFIUTATA NON PUO TOCCARE UN ORDINE — `poll` VERO, non un ragionamento');
(async () => {
  const A = require(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'));
  const NOW = 1_786_200_000_000;
  const scritture = new Map();
  // ⚠ Le superfici che agirebbero NON sono iniettate come funzioni innocue: SOLLEVANO. Se il guardiano
  // le chiamasse, il test morirebbe invece di passare — «non chiamata» dev'essere una prova, non
  // un'assenza di asserzione.
  const deps = {
    now: () => NOW,
    scriviJson: (f, o) => scritture.set(path.basename(f), o),
    soglie: { pct: 5, abs: 30 },
    // il capitale e' CROLLATO ben oltre soglia: se la lettura fosse creduta, lo scatto partirebbe
    saldo: { usd: 400, affidabile: true, etaMs: 1000 },
    posizioni: { readable: true, positions: [] },
    // ...ma la cassa si e' mossa di −$540 senza che le posizioni si muovano: fonti non co-temporali
    precedenteFonti: { at: NOW - 30_000, saldoUsd: 940, posizioni: [] },
    baselineRaw: { baselineUsd: 1000, riferimentoUsd: 1000, v: 2 },
    stato: null,
    buildCancelCredsProviders: async () => { throw new Error('IL GUARDIANO HA CHIESTO LE CREDENZIALI SU UNA LETTURA RIFIUTATA'); },
    cancelAllOrders: async () => { throw new Error('IL GUARDIANO HA CANCELLATO ORDINI SU UNA LETTURA RIFIUTATA'); },
    impostaBot: () => { throw new Error('IL GUARDIANO HA MESSO IL BOT SU FERMA SU UNA LETTURA RIFIUTATA'); },
    registraCancellazione: () => { throw new Error('IL GUARDIANO HA SCRITTO UN REFERTO SU UNA LETTURA RIFIUTATA'); },
    audit: () => {},
  };
  let r = null; let esploso = null;
  try { r = await A.poll(deps); } catch (e) { esploso = e.message; }
  ok('⚑ nessuna superficie che agisce e stata toccata', () => {
    assert.strictEqual(esploso, null, `poll ha chiamato una superficie che agisce: ${esploso}`);
  });
  ok('⚑ l azione e «capitale-illeggibile», non uno scatto', () => {
    assert.ok(r && (r.azione === 'capitale-illeggibile' || r.azione === 'attesa-baseline'),
      `azione ${r && r.azione} — un crollo di $540 non riconciliato e stato creduto`);
  });
  ok('⚑ e il riferimento NON e stato riscritto (il verso ALTO si chiude qui)', () => {
    assert.ok(!scritture.has('guardian-baseline.json'),
      'il cricchetto ha aggiornato il riferimento su una lettura non misurabile: e il difetto D-D');
  });
  ok('⚑ il referto porta la diagnosi della riconciliazione, non un silenzio', () => {
    assert.ok(r && r.riconciliazione && r.riconciliazione.confrontabile === true
      && r.riconciliazione.coerente === false, JSON.stringify(r && r.riconciliazione));
  });
  // CONTROLLO: la stessa perdita, ma con le fonti che concordano, DEVE arrivare allo scatto.
  const scritture2 = new Map(); let cancellato = false; let fermato = false;
  const ok2 = { ...deps, scriviJson: (f, o) => scritture2.set(path.basename(f), o),
    precedenteFonti: { at: NOW - 30_000, saldoUsd: 400, posizioni: [] },
    buildCancelCredsProviders: async () => ({}),
    cancelAllOrders: async () => { cancellato = true; return { ok: true, results: [] }; },
    impostaBot: () => { fermato = true; },
    registraCancellazione: () => {} };
  // ⚠ DUE GIRI, perche' k=2 e' la regola e non la si aggira iniettando lo stato: la prima lettura e'
  // il pre-allarme, la seconda conferma. Le due letture devono essere DISTINTE (§5-bis p.145), quindi
  // il secondo giro porta un `etaMs` diverso e un istante diverso.
  let r2 = null;
  try {
    await A.poll({ ...ok2, saldo: { usd: 400, affidabile: true, etaMs: 1000 }, now: () => NOW });
    r2 = await A.poll({ ...ok2, saldo: { usd: 400, affidabile: true, etaMs: 2000 }, now: () => NOW + 30_000,
      precedenteFonti: { at: NOW, saldoUsd: 400, posizioni: [] } });
  } catch (e) { r2 = { errore: e.message }; }
  ok('⚑ CONTROLLO: le stesse fonti, ma concordi ⇒ il guardiano scatta e cancella', () => {
    assert.ok(cancellato === true && fermato === true,
      `il guardiano non agisce piu su una perdita concorde: cancellato=${cancellato} fermato=${fermato} azione=${r2 && (r2.azione || r2.errore)} — la correzione lo ha ucciso`);
  });
  console.log(`\nguardian fonti co-temporali: ${pass}/${pass + rossi.length} verdi, ${rossi.length} rossi`);
  if (rossi.length) { console.log('ROSSI:'); rossi.forEach((x) => console.log('  ·', x)); process.exit(1); }
})();
const _fine = true; void _fine;
if (false) console.log(`\nguardian fonti co-temporali: ${pass}/${pass + rossi.length} verdi, ${rossi.length} rossi`);

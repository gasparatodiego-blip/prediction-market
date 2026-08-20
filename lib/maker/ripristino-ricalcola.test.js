#!/usr/bin/env node
'use strict';
// ⚠ IL DIFETTO CHE QUESTO TEST DIFENDE — 20 agosto 2026.
// `ripristinaGamba` pretendeva una riga nel piano SALVATO e, non trovandola, si fermava con
// «nessuna riga nel piano salvato per questo mercato: si dichiara e NON si ricalcola». Il piano su
// disco lo scrive SOLO il ciclo pesante (ogni 6 h) mentre la selezione gira a ogni giro — misurato,
// 24 selezioni in 48 minuti contro un piano vecchio di 1.257 minuti. Risultato: `0xaede8a0b` e
// `0x39b1401a20`, SELEZIONATI e giudicati «quotabili adesso», restavano senza un solo ordine.
//
// SI PROVA IL CABLAGGIO, non la decisione: si chiama la `ripristinaGamba` VERA con tutte le dep
// iniettate. Nessun ordine reale, nessuna rete — `piazza` e' un finto che registra e basta.
const A41 = require('../../agents/agent41-realloc-scheduler');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const ID = '0xaede8a0b3e455d32402fd5c47c97375f0a39414be034a35cd207434549c50856';
const YES = 'tok_yes', NO = 'tok_no';

// Una riga di piano con la FORMA VERA (i campi che `gambeDiUnaRiga` legge), copiata dallo shape di
// `data/realloc-ultimo-piano.json` — non inventata.
const RIGA = {
  marketId: ID, name: 'test', shortId: 'aede', capital: 49, mid: 0.5, tick: 0.01,
  maxSpreadCents: 4.5, sizePerSideShares: 50, pairCostUsd: 0.98,
  computedDefaultOffsetTicks: 1, minSizeShares: 20, grossPerDay: 65, netPerDay: 60,
};

// ⚠ `mancanti` e' un array di TOKEN ID (stringhe), non di oggetti: `gambeDaMandare` fa `map(norm)`.
const V = { stato: 'da-coprire', mancanti: [YES, NO], tokenIdYes: YES, tokenIdNo: NO };

function deps(extra = {}) {
  return {
    ordiniVivi: [],
    piazza: async () => ({ ok: true, risultati: [{ status: 'placed', notionalUsd: 24 }, { status: 'placed', notionalUsd: 24 }] }),
    ...extra,
  };
}

(async () => {
  console.log('\n══ 1 · SENZA RIGA E SENZA RICALCOLO: si dichiara (comportamento di prima, conservato)');
  {
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(), pianoFresco: null });
    t('senza `pianoFresco` il percorso si ferma e lo dice', r.tentato === false && /nessun ricalcolo disponibile/.test(r.motivo || ''), r.motivo);
  }

  console.log('\n══ 2 · LA CURA: manca la riga ⇒ si RICALCOLA e si procede');
  {
    let chiamate = 0;
    const fresco = async () => { chiamate++; return { rows: [RIGA], candidates: [] }; };
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(), pianoFresco: fresco });
    t('il piano fresco viene interrogato', chiamate === 1, { chiamate });
    t('NON si ferma piu\' con «manca dal piano salvato»', !/NON si ricalcola/.test(r.motivo || ''), r.motivo);
    t('la riga usata viene dal ricalcolo, ed e\' dichiarato', r.ricalcolata === true, { ricalcolata: r.ricalcolata });
    t('  e il percorso arriva al piazzamento', r.tentato === true, { tentato: r.tentato, motivo: r.motivo });
  }

  console.log('\n══ 3 · LA RIGA SALVATA HA LA PRECEDENZA: nessun ricalcolo inutile');
  {
    let chiamate = 0;
    const fresco = async () => { chiamate++; return { rows: [RIGA], candidates: [] }; };
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: RIGA, ora: Date.now(), deps: deps(), pianoFresco: fresco });
    t('con la riga nel piano salvato il ricalcolo NON viene chiesto', chiamate === 0, { chiamate });
    t('  e non si dichiara ricalcolata', r.ricalcolata === false, { ricalcolata: r.ricalcolata });
  }

  console.log('\n══ 4 · IL RIFIUTO DICE LA CAUSA VERA, non «manca dal piano» (classe D7)');
  {
    const fresco = async () => ({ rows: [], candidates: [
      { marketId: ID, status: 'scartato', reasonCode: 'quota-coda-lunga',
        reason: 'scade fra 132.6 g, oltre i 7 del P90 misurato: la coda lunga del piano e\' gia\' al 12% del capitale' },
    ] });
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(), pianoFresco: fresco });
    t('il motivo NON dice piu\' «manca dal piano»', !/NON si ricalcola/.test(r.motivo || ''), r.motivo);
    t('  e riporta il reasonCode DELL\'ALLOCATORE', /quota-coda-lunga/.test(r.motivo || ''));
    t('  e il testo del motivo vero', /oltre i 7 del P90/.test(r.motivo || ''));
    t('  e dichiara di aver ricalcolato', r.ricalcolato === true);
  }
  {
    // Il mercato non compare nemmeno fra i candidati: e' un fatto DIVERSO da «scartato», e va detto.
    const fresco = async () => ({ rows: [], candidates: [{ marketId: '0xaltro', status: 'scelto' }] });
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(), pianoFresco: fresco });
    t('assente dai candidati ⇒ «non e\' stato nemmeno valutato», non «scartato»',
      /non compare fra i candidati/.test(r.motivo || ''), r.motivo);
  }

  console.log('\n══ 5 · FAIL-CLOSED: un ricalcolo che non riesce non inventa una riga');
  {
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(),
      pianoFresco: async () => ({ errore: 'saldo non leggibile (motivo ignoto)' }) });
    t('saldo illeggibile ⇒ non si tenta, e il motivo lo dice', r.tentato === false && /saldo non leggibile/.test(r.motivo || ''), r.motivo);
  }
  {
    const r = await A41.ripristinaGamba({ id: ID, v: V, riga: null, ora: Date.now(), deps: deps(),
      pianoFresco: async () => null });
    t('nessun piano prodotto ⇒ non si tenta', r.tentato === false && /non ha prodotto nessun piano/.test(r.motivo || ''), r.motivo);
  }

  console.log('\n══ 6 · IL CONTENIMENTO: la scala DECIDE SE tentare, e il ricalcolo sta dietro di lei');
  {
    // ⚠ E' L'ASSERZIONE CHE RENDE SICURO IL RIBALTAMENTO. Il 16 agosto il piano fu ricostruito 799
    // volte (§5-bis p.171): fu per quello che il 17 si scrisse «mercato assente dal piano ⇒ si
    // dichiara e si passa oltre». Cio' che mancava allora e che c'e' adesso e' la SCALA di
    // raffreddamento di `ripristino-gambe` (0 · 5 · 10 · 20 · 30 min sui fallimenti consecutivi).
    // Il ricalcolo sta DIETRO di lei: se la scala dice «non tentare», il processo figlio non parte.
    // Caso peggiore un tentativo ogni 30 min = 48/giorno contro 720 cicli, e i mercati senza riga
    // dello stesso giro ne condividono UNO solo grazie al memo.
    let chiamate = 0;
    const fresco = async () => { chiamate++; return { rows: [RIGA], candidates: [] }; };
    // `coperto` non e' `da-coprire`: la scala risponde «non si tenta» prima di qualunque altra cosa.
    const r = await A41.ripristinaGamba({ id: ID, v: { ...V, stato: 'coperto' }, riga: null,
      ora: Date.now(), deps: deps(), pianoFresco: fresco });
    t('se la scala dice di NON tentare, il piano fresco non viene nemmeno chiesto', chiamate === 0, { chiamate });
    t('  e non si e\' tentato niente', r.tentato === false, { motivo: r.motivo });
  }
  {
    // Stessa cosa sullo stato `non-quotabile`: il motore ha gia' detto che non esiste un prezzo
    // conforme, e ricalcolare un piano non cambierebbe quel verdetto.
    let chiamate = 0;
    const r = await A41.ripristinaGamba({ id: ID, v: { ...V, stato: 'non-quotabile' }, riga: null,
      ora: Date.now(), deps: deps(), pianoFresco: async () => { chiamate++; return { rows: [RIGA] }; } });
    t('su «non-quotabile» non si ricalcola: sarebbe sbattere contro una regola di rischio', chiamate === 0 && r.tentato === false);
  }

  console.log('\n══ 6-bis · LA SCALA DEVE SALIRE SUL RICALCOLO A VUOTO — la proprieta\' che mancava');
  {
    // ⚠ LE DUE ASSERZIONI DI ⑥ ERANO VERDI SU UNA PROPRIETA' FALSA, e questo blocco e' la loro
    // riscrittura. Provavano che su `coperto` e `non-quotabile` il ricalcolo non parte — vero, ma
    // irrilevante: il caso che conta e' un `da-coprire` che FALLISCE RIPETUTAMENTE, ed e' proprio
    // quello che non era contenuto. Misurato sul bot vivo: 15 ricalcoli in 30 minuti = 720/giorno,
    // la stessa cifra dell'incidente del 16 agosto, contro i ~48 sostenuti.
    const RIP = require('./ripristino-gambe');
    // ① RICALCOLO NON ESEGUITO ⇒ memoria invariata, la scala non sale.
    const m0 = { ultimoTentativo: 1000, fallimenti: 2 };
    const a = RIP.memoriaDopo({ stato: 'da-coprire', memoria: m0, tentato: false, riuscito: false, ora: 9000 });
    t('① ne\' piazzato ne\' ricalcolato ⇒ memoria INVARIATA', a === m0, { fallimenti: a && a.fallimenti });

    // ② RICALCOLO ESEGUITO CON ESITO NEGATIVO ⇒ e' un tentativo avvenuto: i fallimenti salgono.
    const b = RIP.memoriaDopo({ stato: 'da-coprire', memoria: m0, tentato: false, riuscito: false,
      ricalcoloEseguito: true, ora: 9000 });
    t('② ricalcolo eseguito con esito NEGATIVO ⇒ i fallimenti INCREMENTANO',
      !!b && b.fallimenti === 3, { fallimenti: b && b.fallimenti });
    t('  e l\'orologio del tentativo si timbra', !!b && b.ultimoTentativo === 9000);

    // ③ RICALCOLO ESEGUITO CON SUCCESSO ⇒ si prosegue al piazzamento, decide `riuscito` come sempre.
    const c = RIP.memoriaDopo({ stato: 'da-coprire', memoria: m0, tentato: true, riuscito: true,
      ricalcoloEseguito: true, ora: 9000 });
    t('③ ricalcolo eseguito e piazzamento RIUSCITO ⇒ i fallimenti non salgono',
      !!c && c.fallimenti === 2, { fallimenti: c && c.fallimenti });

    // LA SCALA SALE DAVVERO, e si legge dai minuti che concede: 0 · 5 · 10 · 20 · 30.
    let mem = null; const gradini = [];
    for (let i = 0; i < 6; i++) {
      gradini.push(RIP.attesaMs((mem && mem.fallimenti) || 0) / 60000);
      mem = RIP.memoriaDopo({ stato: 'da-coprire', memoria: mem, tentato: false, riuscito: false,
        ricalcoloEseguito: true, ora: 1000 * (i + 1) });
    }
    t('la scala SALE su ricalcoli a vuoto ripetuti: 0·5·10·20·30 min',
      JSON.stringify(gradini) === JSON.stringify([0, 5, 10, 20, 30, 30]), { gradini });

    // ⚠ IL NUMERO CHE GOVERNA IL DISEGNO: 720 cicli al giorno (uno ogni 120 s). Col tetto a 30 min
    // il caso peggiore e' un tentativo ogni 30 min = 48/giorno. E' L'ASSERZIONE che il ribaltamento
    // del 17 agosto pretendeva e che non era mai stata scritta.
    const CICLO_S = 120, GIORNO_S = 86400;
    const tettoMin = RIP.SCALA_MIN[RIP.SCALA_MIN.length - 1];
    const alGiorno = GIORNO_S / (tettoMin * 60);
    t(`a regime il tetto e' ${tettoMin} min ⇒ ${alGiorno}/giorno, contro ${GIORNO_S / CICLO_S} cicli`,
      alGiorno <= 48, { alGiorno, cicli: GIORNO_S / CICLO_S });

    // E l'azzeramento vero non e' stato toccato.
    const z = RIP.memoriaDopo({ stato: 'coperto', memoria: { fallimenti: 4 }, ricalcoloEseguito: true, ora: 9000 });
    t('`coperto` osservato azzera la memoria anche dopo un ricalcolo', z === null);
  }

  console.log('\n══ 7 · NON E\' UNA SCORCIATOIA: il ricalcolo passa da `pianoLeggero`');
  {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
    const codice = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
    t('il piano fresco si costruisce con `pianoLeggero`, non con una via propria',
      /deps\.pianoLeggero \|\| pianoLeggero\)\(\{ capital/.test(codice));
    t('  e il tetto per mercato viene da `capPerMarketUsd`, non da una costante scritta qui',
      /maxPerMarketUsd: capPerMarketUsd\(cap\)/.test(codice));
    // ⚠ La DICHIARAZIONE della funzione (`function scriviUltimoPiano(piano) {`) non e' una chiamata:
    // contarla insieme alle invocazioni faceva fallire un'asserzione su un codice corretto. Si contano
    // le sole INVOCAZIONI (`…(piano);` col punto e virgola), e devono restare UNA — quella del ciclo
    // pesante. Se il ricalcolo salvasse il suo piano, sovrascriverebbe la memoria delle 48 h con una
    // costruita su 6, che e' esattamente cio' che il commento di `pianoLeggero` esclude.
    const invocazioni = (codice.match(/scriviUltimoPiano\(piano\);/g) || []).length;
    t('  e il piano fresco NON viene salvato: una sola invocazione di `scriviUltimoPiano`, quella del ciclo pesante',
      invocazioni === 1, { invocazioni });
    t('il memo e\' per GIRO: `_fresco` si valuta una volta e si riusa',
      /if \(_fresco !== undefined\) return _fresco;/.test(codice));
    // ⚠ IL CABLAGGIO, non solo la funzione pura. La correzione di `memoriaDopo` e' INERTE se il
    // chiamante non le passa il flag: e' la classe «dep dichiarata e mai iniettata», che in questo
    // repo ha gia' colpito cinque volte — due volte oggi. Si guarda il CODICE, non i commenti.
    t('`ricalcoloEseguito` viene PASSATO da agent41 a memoriaDopo, non solo letto',
      /ricalcoloEseguito: r\.ricalcolato === true \|\| r\.ricalcolata === true/.test(codice));
  }

  console.log(`\n${ok} verdi, ${ko} rossi`);
  process.exit(ko === 0 ? 0 : 1);
})();

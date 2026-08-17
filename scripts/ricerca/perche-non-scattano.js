#!/usr/bin/env node
'use strict';
/**
 * LE REGOLE CHE NON SCATTANO, DIVISE PER CAUSA — e le due cause sono diverse. Sola lettura.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════════
 * «Delle 78 che non scattano, quante non scattano perche' il giro si ferma al passo 7 e quante perche' il
 * pezzo non esiste. Sono due categorie diverse e voglio i due numeri separati.»
 *
 * ═══ IL CRITERIO, E DOV'E' MECCANICO E DOVE NO ══════════════════════════════════════════════════════
 * La distinzione vera non e' una parola chiave: e' se quel ramo POTREBBE scattare su questo bot.
 *
 *   B · «IL PEZZO NON PUO' SCATTARE» — tre sotto-casi, e il primo e' MISURATO, non ipotizzato:
 *       B1 NESSUN CHIAMANTE: la funzione che contiene l'esito non viene chiamata da nessuna riga di
 *          `lib/` o `agents/`. E' il caso letterale di «il pezzo non esiste»: e' scritto e nessuno ci
 *          passa. Si misura camminando i sorgenti, non si deduce;
 *       B2 RILEVATORE DI UN DIFETTO NOSTRO: il ramo scatta solo se una dep non e' cablata o se un
 *          obbligo di esito resta aperto. Se scattasse sarebbe un difetto NOSTRO, quindi deve restare
 *          rosso — contarlo fra i «mancanti» sarebbe contare una difesa come un buco;
 *       B3 MODALITA' CHE QUESTO BOT NON ESEGUE: il ramo del dry-run, mentre il banco invia sempre.
 *
 *   A · «IL GIRO NON CI E' ARRIVATO» — tutto il resto: il pezzo c'e', ha un chiamante, e servirebbe un
 *       evento o uno stato che i sette passi eseguiti non producono. Si divide in due, perche' anche qui
 *       ci sono due destini diversi: i passi 8-17 (raggiungibili con uno scenario) e gli eventi che il
 *       venue simulato non sa ancora fare (429, riconnessioni, mercati che si risolvono).
 *
 * ⚠ LA PARTE DEBOLE E' DICHIARATA: A1 vs A2 e' una classificazione per FAMIGLIA DI PAROLE, come la
 * vecchia `classifica-regole-rosse.js`, e non e' una misura. B1 invece e' misurato. Quindi i due numeri
 * che l'operatore ha chiesto — A e B — sono solidi; la spartizione DENTRO A e' un'ipotesi da leggere a
 * mano, e per questo ogni voce porta `file:riga`.
 *
 * Uso:  node scripts/ricerca/perche-non-scattano.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERTO = path.join(ROOT, 'data', 'ricerca', 'banco-ciclo-completo.json');
const OUT = path.join(ROOT, 'data', 'ricerca', 'perche-non-scattano.json');

// ── I SORGENTI VIVI: tutto `lib/` e `agents/`, senza test e senza il museo ────────────────────────
function sorgentiVivi() {
  const out = [];
  const cammina = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '_archivio' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) cammina(p);
      else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['lib', 'agents']) cammina(path.join(ROOT, d));
  return out.map((p) => ({ p, src: fs.readFileSync(p, 'utf8') }));
}
const VIVI = sorgentiVivi();

const senzaCommenti = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** La funzione che CONTIENE una riga: la piu' vicina dichiarazione sopra di lei. */
// ⚠ QUESTO ESTRATTORE HA SBAGLIATO DUE VOLTE, e le due volte nella direzione che gonfia il numero
// peggiore. Vale la pena raccontarle, perche' e' la stessa classe del difetto 5 del banco:
//   ① `(?:const|let)\s+NAME\s*=\s*\(` matcha anche `const motivo = (e && e.message)`, cioe' una
//      VARIABILE. `chiamateDi('motivo')` non trova chiamate — ovvio — e la regola finiva in «nessun
//      chiamante»: OTTO pezzi dichiarati morti che non lo erano;
//   ② cercando «la dichiarazione piu' vicina sopra» in una funzione da 2.000 righe si trova un HELPER
//      LOCALE, non la funzione che la contiene: tutti gli esiti di `auto-reprice` risultavano dentro
//      `ordiniVivi`, e VENTUNO regole finivano fra i pezzi morti.
// Adesso si contano le PARENTESI: si tiene lo stack delle funzioni dichiarate a profondita' ZERO e si
// chiede quale contiene la riga. Un'euristica sulle colonne non basta su questo codice.
function funzioniDiPrimoLivello(src) {
  const righe = src.split('\n');
  const out = [];
  let depth = 0; let apertaDa = null; let dentro = null;
  for (let i = 0; i < righe.length; i += 1) {
    const l = righe[i];
    if (depth === 0 && !apertaDa) {
      const m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
        || l.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/);
      if (m) apertaDa = { nome: m[1], da: i };
    }
    // Si contano solo le graffe, e si ignorano quelle dentro stringhe o commenti di riga: basta a questo
    // scopo (i file sono JS normale) e un parser vero qui sarebbe sproporzionato.
    let riga = l.replace(/\/\/.*$/, '');
    riga = riga.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, '``');
    for (const c of riga) { if (c === '{') depth += 1; else if (c === '}') depth -= 1; }
    if (apertaDa && depth === 0 && i > apertaDa.da) { out.push({ ...apertaDa, a: i }); apertaDa = null; }
    void dentro;
  }
  return out;
}
const FUNZIONI = new Map();
function funzioneContenente(file, righe, indice) {
  if (!FUNZIONI.has(file)) FUNZIONI.set(file, funzioniDiPrimoLivello(righe.join('\n')));
  const f = FUNZIONI.get(file).find((x) => indice >= x.da && indice <= x.a);
  return f ? f.nome : null;
}

/** Quante volte quella funzione e' CHIAMATA nei sorgenti vivi (escluse le sue dichiarazioni). */
function chiamateDi(nome) {
  if (!nome) return null;
  let n = 0;
  const chiamata = new RegExp(`(?<![\\w$.])${nome}\\s*\\(`, 'g');
  const dichiarazione = new RegExp(`(?:function\\s+${nome}\\s*\\(|(?:const|let)\\s+${nome}\\s*=)`);
  for (const { src } of VIVI) {
    for (const riga of senzaCommenti(src).split('\n')) {
      if (dichiarazione.test(riga)) continue;
      const m = riga.match(chiamata);
      if (m) n += m.length;
    }
  }
  return n;
}

const FAMIGLIE_8_17 = [
  { passo: 8, re: /rimpiazz|slot|ripianificare|rotazione/i },
  { passo: 9, re: /residu|parziale|sotto-minimo|deroga|accumulo/i },
  { passo: 10, re: /urgenz|scoperto|attraversa|uscita|abbassare|peggiorativa/i },
  { passo: 11, re: /profitto|take-?profit|coppia-battuta|coppia-bloccata/i },
  { passo: 12, re: /merge/i },
  { passo: 13, re: /ripristino|copertura|gamba/i },
  { passo: 14, re: /spariz|valutat|sorveglianz/i },
  { passo: 15, re: /stantio|cecit|feed|avg-?price|post-?only|carico-di-ripiego|mid-stale/i },
  { passo: 16, re: /scad|chius|closed|end-of-(scale|life)|risolt|pre-scadenza|forzata/i },
  { passo: 17, re: /kill|ferma|perdita|guardian|daily-loss|cap|tetto|quota|esposizion/i },
];

(async () => {
  const r = JSON.parse(fs.readFileSync(REFERTO, 'utf8'));
  const dinamicheOk = new Set(r.dinamicheScattate || []);
  const rosse = (r.mai || []).filter((x) => !dinamicheOk.has(x.regola));

  const cat = { A1: [], A2: [], B1: [], B2: [], B3: [] };

  for (const m of rosse) {
    const f = (m.file || [])[0];
    if (!f) { cat.A2.push({ ...m, perche: 'file non noto' }); continue; }
    const righe = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    let i = -1;
    for (let k = 0; k < righe.length; k += 1) {
      if (righe[k].includes(`'${m.regola}'`) && (/outcome/.test(righe[k]) || /outcome/.test(righe[k - 1] || ''))) { i = k; break; }
    }
    if (i < 0) { cat.B1.push({ regola: m.regola, file: f, riga: null, perche: 'esito non ritrovato nel sorgente: costruito a runtime' }); continue; }

    const fn = funzioneContenente(f, righe, i);
    const chiam = chiamateDi(fn);
    // ⚠ QUATTRO RIGHE, NON VENTI: con venti `cancelled-top-of-book` e `reject-cancel-failed` (riga 1845)
    // finivano fra i rilevatori di difetti nostri perche' QUINDICI RIGHE SOPRA c'e' il guard di
    // `skip-cancel-non-collegato` (`typeof deps.cancelOrder !== 'function'`). Sono due condizioni di
    // MERCATO — una decisione di cancellazione col gate top-of-book, e una cancellazione rifiutata dal
    // venue — quindi appartengono ad A. La prossimita' non e' appartenenza.
    const contesto = senzaCommenti(righe.slice(Math.max(0, i - 4), i + 1).join('\n'));
    const voce = { regola: m.regola, file: f, riga: i + 1, funzione: fn, chiamate: chiam };

    // B1 · nessun chiamante: MISURATO
    if (fn && chiam === 0) { cat.B1.push({ ...voce, perche: `la funzione \`${fn}\` non e' chiamata da nessuna riga viva` }); continue; }
    // ⚠ B2 E B3 SONO STATE STRETTE DOPO IL PRIMO GIRO, e la ragione e' che stavano CONTANDO DIFESE COME
    // BUCHI. La prima stesura guardava 20 righe di contesto:
    //   · `exit-cancel-failed` e `merge-saltato-senza-ingressi` finivano fra i «rilevatori di un difetto
    //     nostro» — e non lo sono: la prima e' una cancellazione RIFIUTATA DAL VENUE, la seconda uno stato
    //     legittimo (manca un ingresso). Sono raggiungibili, quindi appartengono ad A;
    //   · `noop` e `reject-venue` di `cancelManualOrder` finivano fra i rami dry-run perche' entro venti
    //     righe compare `res.dryRun === true`. Sono gli esiti «l'ordine era gia' via» e «il venue ha
    //     rifiutato la cancellazione»: raggiungibilissimi.
    // Ora il criterio e' letterale e non contestuale: B2 solo se il ramo scatta perche' una DEP NOSTRA non
    // e' una funzione (cioe' il cablaggio e' rotto) o se e' il rilevatore di un obbligo di esito rimasto
    // aperto; B3 solo se il NOME dell'esito dice dry-run. Tutto il resto e' A.
    if (/typeof deps\.\w+ !== 'function'/.test(contesto) || /esito-mancante|non-collegato/.test(m.regola)) {
      cat.B2.push({ ...voce, perche: 'rilevatore di un difetto NOSTRO: scatta solo se il cablaggio e\' rotto o un obbligo di esito resta aperto' }); continue;
    }
    if (/dry-?run/i.test(m.regola)) {
      cat.B3.push({ ...voce, perche: 'ramo di una modalita\' che questo bot non esegue (dry-run)' }); continue;
    }
    // A · il pezzo c'e' e ha un chiamante: serve un evento che il giro non ha prodotto
    const fam = FAMIGLIE_8_17.find((x) => x.re.test(m.regola));
    if (fam) cat.A1.push({ ...voce, passo: fam.passo });
    else cat.A2.push({ ...voce, passo: null });
  }

  const A = cat.A1.length + cat.A2.length;
  const B = cat.B1.length + cat.B2.length + cat.B3.length;
  const referto = { generatoIl: new Date().toISOString(),
    inventarioStatico: r.regoleInventariate, scattate: r.regoleScattate,
    dinamicheConcretizzate: (r.dinamicheScattate || []).length,
    rosseEsaminate: rosse.length,
    A_ilGiroNonCiEArrivato: A, B_nonPuoScattare: B,
    dettaglio: {
      A1_passi_8_17: cat.A1.length, A2_eventiCheIlVenueSimulatoNonFa: cat.A2.length,
      B1_nessunChiamante: cat.B1.length, B2_rilevatoriDiDifettiNostri: cat.B2.length, B3_modalitaNonEseguita: cat.B3.length,
    },
    A1: cat.A1, A2: cat.A2, B1: cat.B1, B2: cat.B2, B3: cat.B3 };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\ninventario statico ${r.regoleInventariate} · scattate ${r.regoleScattate} · dinamiche concrete ${(r.dinamicheScattate || []).length}`);
  console.log(`rosse esaminate: ${rosse.length}\n`);
  console.log(`A · IL GIRO NON CI E' ARRIVATO  : ${A}`);
  console.log(`     ${String(cat.A1.length).padStart(3)}  dei passi 8-17 (raggiungibili con uno scenario)`);
  const perPasso = new Map();
  for (const v of cat.A1) perPasso.set(v.passo, (perPasso.get(v.passo) || 0) + 1);
  for (const [p, n] of [...perPasso].sort((a, b) => a[0] - b[0])) console.log(`          passo ${String(p).padStart(2)}: ${n}`);
  console.log(`     ${String(cat.A2.length).padStart(3)}  eventi che il venue simulato non sa fare (429, riconnessioni, dati malformati)`);
  console.log(`\nB · NON PUO' SCATTARE          : ${B}`);
  console.log(`     ${String(cat.B1.length).padStart(3)}  NESSUN CHIAMANTE — il pezzo e' scritto e nessuno ci passa (misurato)`);
  for (const v of cat.B1) console.log(`          ${v.regola.padEnd(38)} ${v.file}:${v.riga || '?'}  ${v.funzione ? `[${v.funzione}]` : ''}`);
  console.log(`     ${String(cat.B2.length).padStart(3)}  rilevatori di un difetto NOSTRO (devono restare rossi)`);
  for (const v of cat.B2) console.log(`          ${v.regola.padEnd(38)} ${v.file}:${v.riga}`);
  console.log(`     ${String(cat.B3.length).padStart(3)}  ramo di una modalita' che questo bot non esegue`);
  for (const v of cat.B3) console.log(`          ${v.regola.padEnd(38)} ${v.file}:${v.riga}`);
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

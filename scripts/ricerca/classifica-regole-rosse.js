#!/usr/bin/env node
'use strict';
/**
 * LE REGOLE CHE NON SCATTANO, DIVISE IN DUE GRUPPI — sola lettura.
 *
 * La domanda dell'operatore: «dividile in due gruppi — quelle davvero IRRAGGIUNGIBILI nel ciclo
 * normale (e allora sono codice morto o difetti veri) e quelle che il banco NON SA ancora produrre
 * (e allora manca lo scenario, non la regola)».
 *
 * ═══ COME SI DISTINGUONO, SENZA INDOVINARE ══════════════════════════════════════════════════════════
 * La differenza non e' nell'outcome: e' nella CONDIZIONE che lo precede. Si legge il sorgente attorno
 * a ogni `outcome` e si guarda cosa deve accadere perche' quel ramo venga preso:
 *
 *   · se dipende da un evento ESTERNO che il venue simulato non produce — un 429, una riconnessione
 *     del websocket, un mercato che si risolve, un errore di rete, un kill premuto — allora manca lo
 *     SCENARIO. La regola e' viva, il banco non sa ancora metterla alla prova.
 *   · se dipende solo da stato NOSTRO che il ciclo normale attraversa — un tetto, un contatore, un
 *     registro, una decisione del motore — allora avrebbe dovuto scattare. Quella e' la lista corta,
 *     e va guardata a mano una per una.
 *
 * ⚠ LA CLASSIFICAZIONE E' UN'IPOTESI DICHIARATA, NON UNA MISURA. Le parole chiave dicono da cosa
 * DIPENDE un ramo, non se sia raggiungibile: due regole con la stessa parola possono avere destini
 * diversi. Per questo il gruppo «sospette» e' pensato per essere corto e letto a mano — e il referto
 * riporta per ognuna la riga di codice, cosi' la verifica costa una lettura e non una ricerca.
 *
 * Uso:  node scripts/ricerca/classifica-regole-rosse.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const REFERTO = path.join(ROOT, 'data', 'ricerca', 'banco-ciclo-completo.json');
const OUT = path.join(ROOT, 'data', 'ricerca', 'classifica-regole-rosse.json');

// Le famiglie di eventi ESTERNI che il venue simulato non sa (ancora) produrre. Ognuna e' una cosa che
// succede al mondo, non a noi: nessuna di queste e' raggiungibile «continuando a girare».
const ESTERNE = [
  { nome: 'rete e rate limit', re: /429|retry|backoff|rate.?limit|timeout|http|network|econn|fetch|ambigu/i },
  { nome: 'feed e riconnessioni', re: /reconnect|disconnect|websocket|socket|feed|stale|stantio|cecit/i },
  { nome: 'ciclo di vita del mercato', re: /closed|risolt|scadenz|expiry|end-of-life|end-of-scale|pre-scadenza|mercato-chiuso|non-valid/i },
  { nome: 'interruttori e emergenze', re: /kill|ferma|emergenz|panic|guardian|disarm/i },
  { nome: 'errori e casi degeneri', re: /error|throw|exception|illeggibil|unreadable|non-letto|fallit|malform/i },
  { nome: 'concorrenza e corse', re: /lock|corsa|doppion|duplicate|idempot|concorren/i },
  { nome: 'limiti di capitale saturi', re: /cap|tetto|quota|saturo|oltre|esposizion|budget|rimandato/i },
];

const fileDi = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n'); } catch { return []; } };

/** Il contesto di un outcome: la riga in cui compare e le 25 righe di codice sopra. */
function contesto(f, regola) {
  const righe = fileDi(f);
  for (let i = 0; i < righe.length; i++) {
    if (!righe[i].includes(`'${regola}'`)) continue;
    if (!/outcome/.test(righe[i]) && !/outcome/.test(righe[i - 1] || '')) continue;
    const da = Math.max(0, i - 25);
    return { riga: i + 1, testo: righe.slice(da, i + 1).join('\n') };
  }
  return null;
}

(async () => {
  const r = JSON.parse(fs.readFileSync(REFERTO, 'utf8'));
  const gruppi = { mancaScenario: [], sospette: [], nonTrovate: [] };

  // ⚠ SI TOLGONO LE REGOLE CHE SCATTANO COME FORMA DINAMICA. L'inventario statico e quello dinamico
  // sono due elenchi, e una regola puo' comparire nel primo come «mai scattata» mentre nel secondo
  // risulta concretizzata: e' lo stesso outcome visto da due estrattori diversi. Classificarla come
  // rossa sarebbe un falso allarme, e un falso allarme in una lista da leggere a mano la svuota di
  // senso — che e' esattamente il difetto che ho gia' fatto due volte oggi.
  const gia = new Set(r.dinamicheScattate || []);
  for (const m of r.mai.filter((x) => !gia.has(x.regola))) {
    const f = (m.file || [])[0];
    const c = f ? contesto(f, m.regola) : null;
    if (!c) { gruppi.nonTrovate.push({ ...m, nota: 'outcome non ritrovato nel sorgente: probabilmente costruito a runtime' }); continue; }
    // Si cerca nel CODICE del contesto, non nei commenti: un commento che nomina «kill» non rende
    // quel ramo dipendente dal kill.
    const codice = c.testo.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    const causa = ESTERNE.find((e) => e.re.test(codice) || e.re.test(m.regola));
    const voce = { regola: m.regola, file: f, riga: c.riga };
    if (causa) gruppi.mancaScenario.push({ ...voce, famiglia: causa.nome });
    else gruppi.sospette.push(voce);
  }

  const perFamiglia = new Map();
  for (const v of gruppi.mancaScenario) perFamiglia.set(v.famiglia, (perFamiglia.get(v.famiglia) || 0) + 1);

  const referto = {
    generatoIl: new Date().toISOString(),
    totaleRosse: r.mai.length,
    gruppo1_sospette: gruppi.sospette.length,
    gruppo2_mancaScenario: gruppi.mancaScenario.length,
    nonTrovate: gruppi.nonTrovate.length,
    perFamiglia: [...perFamiglia].sort((a, b) => b[1] - a[1]).map(([famiglia, n]) => ({ famiglia, n })),
    sospette: gruppi.sospette,
    mancaScenario: gruppi.mancaScenario,
    nonTrovateElenco: gruppi.nonTrovate.map((x) => x.regola),
  };
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  const rosseVere = gruppi.sospette.length + gruppi.mancaScenario.length + gruppi.nonTrovate.length;
  console.log(`\n════ LE ${rosseVere} REGOLE CHE NON SCATTANO, DIVISE ════`);
  console.log(`   (${r.mai.length - rosseVere} tolte perche' scattano come forma dinamica)\n`);
  console.log(`GRUPPO 1 · SOSPETTE (dipendono solo da stato nostro): ${gruppi.sospette.length}`);
  for (const v of gruppi.sospette) console.log(`   ${v.regola.padEnd(42)} ${v.file}:${v.riga}`);
  console.log(`\nGRUPPO 2 · MANCA LO SCENARIO (dipendono da un evento esterno): ${gruppi.mancaScenario.length}`);
  for (const [fam, n] of perFamiglia) console.log(`   ${String(n).padStart(3)}  ${fam}`);
  if (gruppi.nonTrovate.length) console.log(`\nnon ritrovate nel sorgente: ${gruppi.nonTrovate.length}`);
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

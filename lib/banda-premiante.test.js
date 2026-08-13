'use strict';
// lib/banda-premiante.test.js — FISSA LA DEFINIZIONE DI `v` E FALLISCE SE UN MODULO TORNA A DIVERGERE.
//
// Due mestieri distinti, e servono entrambi:
//   ① la DEFINIZIONE: `v = maxSpread`, ancorata all'esempio ufficiale del venue, che è l'unico
//      riferimento numerico esterno che possiamo verificare senza credenziali;
//   ② la NON-DIVERGENZA: nessun modulo del repo può ricalcolarsi il raggio di banda da sé. Il difetto
//      non era solo il valore sbagliato — era che sessanta punti se lo calcolavano ciascuno per conto
//      proprio, ed è per questo che due letture hanno potuto convivere per giorni (reperto D1).
//
// ⚠ Il controllo ② difende una PROPRIETÀ, non un conteggio: non asserisce «ci sono N occorrenze», che
// sarebbe verde in lavorazione e rosso dopo il commit (§5.3). Asserisce «nessun file, tolta la SSOT,
// divide un maxSpread per due». E filtra i commenti, o un commento che RACCONTA la regola giusta
// basterebbe a far passare il test (§5.3, quarta occorrenza).

const fs = require('fs');
const path = require('path');
const { raggioBandaCents, raggioBandaPrezzo, dentroBanda, punteggio } = require('./banda-premiante');

let passati = 0, falliti = 0;
const ok = (n, c) => { if (c) { passati += 1; console.log(`  ✓ ${n}`); } else { falliti += 1; console.log(`  ✗ ${n}`); } };
const vicino = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\n════ ① la definizione di v, ancorata all\'esempio ufficiale del venue ════');

// docs.polymarket.com/market-makers/liquidity-rewards — esempio ufficiale:
// mid aggiustato 0.50, max spread 3 centesimi.
//   bid 0.49  (1,0¢ dal mid), size 100 ⇒ ((3−1)/3)²   · 100 = 44,44
//   bid 0.48  (2,0¢ dal mid), size 200 ⇒ ((3−2)/3)²   · 200 = 22,22
//   bid 0.485 (1,5¢ dal mid), size 100 ⇒ ((3−1,5)/3)² · 100 = 25,00
// ⚠ È IL BID A 0.48 CHE DECIDE LA QUESTIONE: sta a 2 centesimi dal mid, cioè OLTRE maxSpread/2 = 1,5.
// Con la lettura dimezzata varrebbe ZERO; il venue gli assegna 22,22. Le due letture non sono
// entrambe difendibili, e l'esempio ufficiale esclude quella dimezzata.
const V_ESEMPIO = 3;
ok('bid a 1,0¢ con max spread 3¢ ⇒ S = (2/3)²', vicino(punteggio(1.0, V_ESEMPIO), (2 / 3) ** 2));
ok('bid a 1,5¢ ⇒ S = 0,25 (e NON zero, che è ciò che darebbe v = maxSpread/2)',
  vicino(punteggio(1.5, V_ESEMPIO), 0.25));
ok('bid a 2,0¢ ⇒ S = (1/3)² ≈ 0,1111 — il caso che esclude la lettura dimezzata',
  vicino(punteggio(2.0, V_ESEMPIO), (1 / 3) ** 2));
ok('  e con la lettura dimezzata quello stesso ordine varrebbe 0: le letture NON coincidono',
  punteggio(2.0, V_ESEMPIO) > 0 && ((V_ESEMPIO / 2 - 2.0) <= 0));
ok('S · size riproduce i 22,22 dell\'esempio', vicino(+(punteggio(2.0, V_ESEMPIO) * 200).toFixed(2), 22.22));
ok('S · size riproduce i 44,44 dell\'esempio', vicino(+(punteggio(1.0, V_ESEMPIO) * 100).toFixed(2), 44.44));

ok('il raggio È maxSpread, non la sua metà', raggioBandaCents(4.5) === 4.5);
ok('il raggio in prezzo è il raggio/100', raggioBandaPrezzo(4.5) === 0.045);
ok('al bordo esatto S = 0 (la formula si annulla, per costruzione)', punteggio(4.5, 4.5) === 0);
ok('oltre il bordo S = 0, mai negativo', punteggio(6, 4.5) === 0);
ok('la banda è SIMMETRICA: la distanza è un valore assoluto',
  punteggio(-2, 4.5) === punteggio(2, 4.5) && dentroBanda(-4, 4.5) === true);

console.log('\n════ una banda non leggibile non diventa zero ════');
// §5.3: `Number(null) === 0` è il difetto più ricorrente di questo repo. Zero significherebbe
// «banda inesistente», che è un'affermazione; qui la risposta deve essere «non l'ho letta».
for (const [nome, x] of [['null', null], ['undefined', undefined], ['NaN', NaN], ['zero', 0], ['negativo', -3], ['stringa', '4.5']]) {
  ok(`raggio con maxSpread ${nome} ⇒ null, non un numero`, raggioBandaCents(x) === null);
}
ok('  e il raggio in prezzo si comporta allo stesso modo', raggioBandaPrezzo(null) === null);
ok('dentroBanda con banda illeggibile ⇒ false (chi chiede «matura?» riceve un no)',
  dentroBanda(1, null) === false);
ok('punteggio con banda illeggibile ⇒ 0', punteggio(1, null) === 0);
ok('punteggio con distanza illeggibile ⇒ 0', punteggio(null, 4.5) === 0);

console.log('\n════ ② nessun modulo si ricalcola la banda per conto proprio ════');

const ROOT = path.join(__dirname, '..');
const SALTA = new Set(['node_modules', '.next', '.git', 'data', 'public']);
// La SSOT è l'unico posto dove il raggio può essere DEFINITO. Il proprio test è esente perché il suo
// mestiere è nominare la forma sbagliata per provare che non esiste altrove.
const ESENTI = new Set([
  path.join('lib', 'banda-premiante.js'),
  path.join('lib', 'banda-premiante.test.js'),
]);

const file = [];
(function cammina(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SALTA.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) cammina(p);
    else if (/\.(js|ts|tsx|jsx)$/.test(e.name)) file.push(p);
  }
})(ROOT);

// Un identificatore che finisce con un nome di max-spread, diviso per 2 (o per 200, che è «/2» più la
// conversione in prezzo). È esattamente la forma che il codemod ha eliminato.
const ID = String.raw`(?:[A-Za-z_$][\w$]*\.)*(?:rewardsMaxSpread|maxSpreadCents|maxSpreadC|maxSpread|max_spread)`;
const DIVISIONE = new RegExp(String.raw`${ID}\s*\/\s*(?:2(?![\d.])|200)`);

const colpevoli = [];
for (const f of file) {
  const rel = path.relative(ROOT, f);
  if (ESENTI.has(rel)) continue;
  const righe = fs.readFileSync(f, 'utf8').split('\n');
  righe.forEach((l, i) => {
    const t = l.trim();
    // I commenti si filtrano: un commento che descrive la forma sbagliata non la ESEGUE, e un test che
    // non li filtrasse verrebbe soddisfatto da una frase invece che dal codice.
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    // E si tolgono anche i LETTERALI DI STRINGA: un'etichetta di stampa che NOMINA la lettura
    // sbagliata — gli script di ricerca che confrontano le due letture lo fanno per mestiere — non è
    // un modulo che la calcola. Qui si cerca aritmetica, non prosa, ovunque essa sia scritta.
    const codice = l.split('//')[0]
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    if (DIVISIONE.test(codice)) colpevoli.push(`${rel}:${i + 1}  ${t.slice(0, 96)}`);
  });
}
if (colpevoli.length) {
  console.log('    moduli che ricalcolano la banda invece di importarla:');
  for (const c of colpevoli) console.log(`      ${c}`);
}
ok(`nessun modulo divide un maxSpread per due (trovati ${colpevoli.length})`, colpevoli.length === 0);

// E il verso opposto: chi la banda la USA deve prenderla dalla SSOT. Si controllano i moduli che
// decidono davvero — non tutto il repo — perché è lì che una divergenza costa capitale.
const CHIAVE = [
  path.join('lib', 'rewards-live-band.js'),
  path.join('lib', 'rewardScore.js'),
  path.join('lib', 'rewards', 'quotabilita.js'),
  path.join('lib', 'rewards', 'realistic-estimate.js'),
  path.join('lib', 'maker', 'venue-rules.js'),
  path.join('lib', 'maker', 'auto-reprice.js'),
  path.join('lib', 'maker', 'auto-close.js'),
];
for (const rel of CHIAVE) {
  const s = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  ok(`${rel} prende la banda dalla SSOT`, /banda-premiante/.test(s));
}

console.log(`\nbanda-premiante: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

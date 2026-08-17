'use strict';

/**
 * LE DUE CORREZIONI DEL 13 AGOSTO 2026 — §5.2 p.17 e p.18.
 *
 *   ① l'esenzione dal tetto per ordine vale su TUTTI i percorsi che riducono, riposizionamento
 *      compreso — ma **solo in riduzione**: una SELL oltre il posseduto resta rifiutata;
 *   ② il registro dei residui viene riletto e ritentato, e un fallimento NON cancella la voce.
 */

const fs = require('fs');
const path = require('path');
const { provaChiusura } = require('./esenzione-chiusura');
const RITENTA = require('./ritenta-residui');

let passati = 0; let falliti = 0;
const ok = (nome, cond, extra = '') => {
  if (cond) { passati++; console.log(`  ✓ ${nome}`); }
  else { falliti++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

// ══ ① L'ESENZIONE VALE SOLO IN RIDUZIONE ═══════════════════════════════════════════════════════
console.log('\n── l\'esenzione non copre MAI un ordine che non riduce');
{
  // Il caso reale sbloccato: 52,6 share possedute, SELL di 52,6.
  const giusta = provaChiusura({ side: 'SELL', size: 52.6, chiudePosizione: true, heldSize: 52.6 });
  ok('SELL pari alle share possedute ⇒ esente', giusta.esente === true);
  ok('SELL di meno delle possedute ⇒ esente',
    provaChiusura({ side: 'SELL', size: 10, chiudePosizione: true, heldSize: 52.6 }).esente === true);

  // ⚠ IL TEST CHE IL PROMPT CHIEDE: oltre il posseduto NON si esenta, nemmeno di un'inezia.
  const troppa = provaChiusura({ side: 'SELL', size: 52.7, chiudePosizione: true, heldSize: 52.6 });
  ok('SELL SUPERIORE alle share possedute ⇒ NON esente', troppa.esente === false);
  ok('  e il motivo dice che non è provata come riduzione', /non provata come riduzione/.test(troppa.motivo));
  for (const s of [53, 100, 1e6]) {
    ok(`SELL di ${s} su 52,6 possedute ⇒ NON esente`,
      provaChiusura({ side: 'SELL', size: s, chiudePosizione: true, heldSize: 52.6 }).esente === false);
  }
  // Possesso non leggibile ⇒ nessuna esenzione: il capitale resta fermo, che è il verso giusto.
  ok('possesso non leggibile ⇒ NON esente',
    provaChiusura({ side: 'SELL', size: 10, chiudePosizione: true, heldSize: null }).esente === false);

  // La BUY di chiusura non può superare il residuo scoperto.
  ok('BUY entro `manca` ⇒ esente',
    provaChiusura({ side: 'BUY', size: 20, chiudePosizione: true, heldSize: 0, heldSizeOpposto: 52.6 }).esente === true);
  ok('BUY OLTRE `manca` ⇒ NON esente',
    provaChiusura({ side: 'BUY', size: 53, chiudePosizione: true, heldSize: 0, heldSizeOpposto: 52.6 }).esente === false);
  ok('BUY senza posizione opposta (cioè un\'APERTURA) ⇒ NON esente',
    provaChiusura({ side: 'BUY', size: 20, chiudePosizione: true, heldSize: null, heldSizeOpposto: null }).esente === false);
  ok('BUY su coppia già completa ⇒ NON esente',
    provaChiusura({ side: 'BUY', size: 5, chiudePosizione: true, heldSize: 60, heldSizeOpposto: 52.6 }).esente === false);

  // La dichiarazione da sola non basta, e non è truthy: deve essere `true`.
  for (const v of [undefined, false, 'si', 1, {}]) {
    ok(`chiudePosizione «${JSON.stringify(v)}» non esenta`,
      provaChiusura({ side: 'SELL', size: 10, chiudePosizione: v, heldSize: 100 }).esente === false);
  }
}

console.log('\n── il ramo del riposizionamento dichiara la chiusura, e nessun ramo di APERTURA lo fa');
{
  const src = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const nudo = src.replace(/^\s*\/\/.*$/gm, '');   // i commenti non contano (§5.3)

  // La proprietà: il ramo del riposizionamento passa `chiudePosizione` nella stessa chiamata in cui
  // decide `side`. Si cerca la vicinanza fra il `deps.placeOrder` del riposizionamento e il campo.
  const rip = /vende \? 'SELL' : 'BUY'[\s\S]{0,400}chiudePosizione: true/.test(nudo);
  ok('il ramo `riposizionamento-scoperto` dichiara chiudePosizione: true', rip);

  // E il conteggio dei percorsi che lo dichiarano è quello atteso: otto, tutti di chiusura.
  // ⚠ 7 → 8 IL 17 AGOSTO 2026. L'ottavo è l'uscita ordinaria quando la scala concede di attraversare:
  // un SELL della posizione detenuta, cioè esattamente il caso che `provaChiusura` prova contro lo
  // snapshot del venue. Ammesso dopo averlo verificato sul sorgente, non allargando il pattern — che
  // resta `chiudePosizione: true` esatto, e continua a non comparire da nessuna parte in `bulk-allocate`.
  const quanti = (nudo.match(/chiudePosizione: true/g) || []).length;
  ok('i percorsi che dichiarano la chiusura sono otto', quanti === 8, String(quanti));

  // ⚠ LA PROPRIETÀ CHE CONTA: `bulk-allocate` — la corsia che APRE — non lo dichiara da nessuna parte.
  const bulk = fs.readFileSync(path.join(__dirname, 'bulk-allocate.js'), 'utf8');
  ok('la corsia di APERTURA (bulk-allocate) non dichiara mai chiudePosizione',
    !/chiudePosizione/.test(bulk));
}

// ══ ② IL REGISTRO VIENE RILETTO, E UN FALLIMENTO NON CANCELLA ══════════════════════════════════
console.log('\n── un residuo pronto viene ritentato');
{
  const T = 1_000_000_000;
  const reg = {
    '0x791c61d4:no': { marketId: '0x791c61d4', book: 'no', size: 52.6, minSize: 20, pronto: true, notionalUsd: 26.15 },
    '0xe9b3e28d:yes': { marketId: '0xe9b3e28d', book: 'yes', size: 6, minSize: 20, pronto: false, notionalUsd: 3 },
  };
  const r = RITENTA.residuiDaRitentare({ registro: reg, stato: null, ora: T });
  ok('il residuo pronto viene proposto', r.daRitentare.length === 1 && r.daRitentare[0].marketId === '0x791c61d4');
  ok('quello sotto il minimo NO', !r.daRitentare.some((x) => x.book === 'yes'));

  // ⚠ IL TEST CHE IL PROMPT CHIEDE: un fallimento non toglie la voce dal registro.
  const stato = RITENTA.registraEsito({ stato: r.stato, chiave: '0x791c61d4:no', riuscito: false, motivo: 'no-target', ora: T });
  ok('dopo un fallimento la voce È ANCORA nel registro',
    reg['0x791c61d4:no'] !== undefined && reg['0x791c61d4:no'].pronto === true);
  ok('  e il registro non è stato modificato affatto', Object.keys(reg).length === 2);
  ok('  il fallimento è contato per il backoff', stato.get('0x791c61d4:no').fallimenti === 1);

  // E si ritenta ancora, più tardi.
  const dopo = RITENTA.residuiDaRitentare({ registro: reg, stato,
    ora: T + RITENTA.INTERVALLO_RITENTATIVO_MS * RITENTA.BACKOFF_MULT + 1000 });
  ok('dopo il backoff il residuo viene ritentato di nuovo', dopo.daRitentare.length === 1);

  // Il backoff non cresce all'infinito.
  let s = new Map();
  for (let i = 0; i < 40; i++) s = RITENTA.registraEsito({ stato: s, chiave: 'k', riuscito: false, motivo: 'x', ora: T });
  const lungo = RITENTA.residuiDaRitentare({
    registro: { k: { marketId: '0xk', book: 'no', size: 20, minSize: 20, pronto: true, notionalUsd: 1 } },
    stato: s, ora: T + RITENTA.BACKOFF_MAX_MS + 1000 });
  ok('il backoff è limitato: oltre il tetto si torna a provare', lungo.daRitentare.length === 1);
}

console.log('\n── il modulo non scrive e non piazza: non può, per costruzione');
{
  const src = fs.readFileSync(path.join(__dirname, 'ritenta-residui.js'), 'utf8');
  ok('nessun require di disco, rete o venue', !/require\(/.test(src.replace(/^\s*\/\/.*$/gm, '')));
  ok('non nomina nessuna scrittura di file', !/writeFileSync|appendFileSync|scriviRegistro/.test(src));
  const r = RITENTA.residuiDaRitentare({
    registro: { 'a:no': { marketId: '0xa', book: 'no', size: 20, minSize: 20, pronto: true, notionalUsd: 5 } },
    ora: 1 });
  const vietati = ['price', 'prezzo', 'side', 'ordine'];
  const trovati = vietati.filter((k) => r.daRitentare.some((x) => Object.prototype.hasOwnProperty.call(x, k)));
  ok('il verdetto non porta prezzo né lato: dice solo QUALE mercato rivisitare',
    trovati.length === 0, trovati.join(','));
}

console.log(`\nesenzione e ritentativo: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

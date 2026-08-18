'use strict';
// lib/maker/chiusura-di-emergenza.js — COSA SI FA DI OGNI POSIZIONE QUANDO IL KILL A −$100 SCATTA.
// Aritmetica e classificazione, e NIENT'ALTRO: nessun `fs`, nessuna rete, nessun venue, nessun
// `require`. Un modulo puro si puo' provare in tutti i suoi rami senza toccare capitale reale, ed e'
// la sola forma in cui una decisione di emergenza dovrebbe essere scritta.
//
// ═══ LA REGOLA DELL'OPERATORE (R10, 18 agosto 2026) ══════════════════════════════════════════════════
// «a −$100 nella giornata cancella tutti gli ordini E chiude le posizioni. Coppie a merge, gambe
//  scoperte vendute a mercato, gambe sotto il minimo restano fino alla risoluzione. Non riapre fino al
//  giorno dopo.»
//
// Fino a oggi il kill faceva **meta'** del lavoro: `spazzaEFerma` cancellava gli ordini a riposo e
// metteva il bot su FERMA, e le posizioni restavano dov'erano. Cioe' il capitale smetteva di lavorare
// ma continuava a essere esposto — la direzione peggiore, perche' e' la parte che puo' ancora perdere.
//
// ═══ TRE DESTINI, E OGNUNO HA UNA RAGIONE DIVERSA ════════════════════════════════════════════════════
//   · **coppia completa ⇒ `da-fondere`.** YES e NO in parti uguali sullo stesso mercato valgono
//     $1/share alla risoluzione qualunque cosa faccia il prezzo: venderle attraverserebbe DUE spread
//     per recuperare qualcosa che gia' si ha. Il merge rende $1/share subito, senza slippage. ⚠ Questo
//     modulo NON fonde: dichiara che c'e' da fondere. Il merge ha gia' il suo unico percorso
//     (`auto-close.fondiCoppia`, §4.9), e una seconda strada verso il relayer sarebbe una seconda
//     verita' su quale batch si firma.
//   · **gamba scoperta sopra il minimo ⇒ `da-vendere`.** E' esposizione direzionale pura, ed e' esatta-
//     mente cio' che il kill esiste per togliere. Si vende ATTRAVERSANDO — il prezzo eseguibile, non
//     quello bello — perche' in emergenza un ordine che non si esegue non e' un'uscita.
//   · **gamba sotto `min_incentive_size` ⇒ `lasciata`, e DICHIARATA.** Il venue non accetta un ordine
//     di quella size sul percorso ordinario, e forzarlo qui vorrebbe dire aprire una via nuova nel
//     momento peggiore. Resta fino alla risoluzione, dove vale 0 o 1 per share.
//
// ⚠ QUI R10 E R6 DICONO COSE DIVERSE, ED E' VOLUTO. R6 («il residuo sotto il minimo si chiude sempre»)
// governa il percorso ORDINARIO, dove c'e' tempo per un'uscita attraversata e il capitale bloccato
// costa piu' della perdita. R10 governa l'EMERGENZA, dove la priorita' e' togliere l'esposizione grande
// in fretta e non aprire percorsi nuovi. Le due regole non si contraddicono: si applicano a due momenti
// diversi, e questo commento esiste perche' chi legge non deve dedurlo.
//
// ⚠ E LA DIFFERENZA E' MENO GRANDE DI QUANTO SEMBRI: dopo il kill il bot e' su FERMA, non su KILL, e
// il presidio dei 60 minuti continua a girare — quindi una gamba sotto il minimo lasciata qui verra'
// comunque chiusa da R6 al giro dopo la sua soglia. Questo modulo non la chiude SUBITO, che e' un'altra
// cosa dal non chiuderla mai.
//
// ⚠ FAIL-CLOSED: posizioni non leggibili ⇒ NESSUNA classificazione e nessuna azione. In emergenza la
// tentazione e' agire comunque; ma «non ho letto» non e' «non c'e' niente», e una lista vuota dedotta
// da una lettura fallita direbbe «tutto a posto» proprio quando non lo e'.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => { const n = Number(x); return fin(n) ? n : null; };
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

/**
 * COSA FARE DI OGNI POSIZIONE APERTA, AL MOMENTO DEL KILL.
 *
 * @param {object}   a
 * @param {Array?}   a.posizioni          lo snapshot del venue: `{asset|tokenId, conditionId, size, avgPrice, curPrice}`
 * @param {object?}  a.minSizePerMercato  `conditionId → min_incentive_size`; una voce mancante vale «non so»
 * @returns {{ok:boolean, daFondere:Array, daVendere:Array, lasciate:Array, motivo:string|null,
 *            esposizioneDirezionaleUsd:number|null, bloccataUsd:number|null}}
 */
function classifica({ posizioni = null, minSizePerMercato = null } = {}) {
  const vuoto = (motivo) => ({ ok: false, daFondere: [], daVendere: [], lasciate: [], motivo,
    esposizioneDirezionaleUsd: null, bloccataUsd: null });
  if (!Array.isArray(posizioni)) {
    return vuoto('posizioni non leggibili: nessuna classificazione, e nessuna azione — in emergenza si agisce sui dati letti, non su quelli assenti');
  }

  const perMercato = new Map();
  for (const p of posizioni) {
    const asset = norm(p && (p.asset || p.tokenId));
    const size = num(p && p.size);
    if (!asset || size === null || size <= 0) continue;
    const cid = norm(p && p.conditionId);
    if (!perMercato.has(cid)) perMercato.set(cid, []);
    perMercato.get(cid).push({ asset, conditionId: cid, size,
      avgPrice: num(p && p.avgPrice), curPrice: num(p && p.curPrice) });
  }

  const daFondere = []; const daVendere = []; const lasciate = [];
  for (const [cid, lista] of perMercato) {
    // ── LA COPPIA COMPLETA, con la STESSA tolleranza del presidio dei 60 minuti ──────────────────
    // ⚠ La tolleranza non e' ricopiata a caso: i fill parziali lasciano decimali, e due gambe che
    // differiscono di un millesimo sono una coppia. `max(0.01 share, 0,1%)` e' la stessa forma usata
    // in `presidio-posizioni-vecchie`. Se un giorno una delle due cambia, devono cambiare insieme.
    const coppia = lista.length === 2
      && Math.abs(lista[0].size - lista[1].size) <= Math.max(0.01, lista[0].size * 0.001);
    if (coppia) {
      daFondere.push({ conditionId: cid, size: Math.min(lista[0].size, lista[1].size),
        assets: [lista[0].asset, lista[1].asset],
        motivo: 'coppia completa: vale $1/share alla risoluzione, il merge la incassa subito senza slippage'
          + ' — venderla attraverserebbe due spread per recuperare quello che gia\' si ha' });
      continue;
    }
    // ⚠ IL MINIMO E' DEL VENUE E PER MERCATO (20/50/100/200), non una costante nostra. Una voce che
    // manca NON diventa zero (§5.3, `Number(null) === 0`): «non so quale sia il minimo» si tratta come
    // «potrebbe essere sotto», cioe' si LASCIA e lo si dichiara. In emergenza l'errore che costa meno
    // e' non vendere una gamba che si poteva vendere.
    // ⚠ LA CHIAVE SI NORMALIZZA DA ENTRAMBE LE PARTI. `cid` arriva gia' minuscolo da `norm`, ma la
    // mappa la costruisce il chiamante e puo' avere le chiavi come gliele ha date il venue. Un
    // confronto sensibile al maiuscolo faceva rispondere «minimo non leggibile» su OGNI mercato, cioe'
    // LASCIAVA tutto invece di vendere: fail-closed, quindi non pericoloso, ma sbagliato — e il
    // selfcheck del modulo non lo vedeva perche' usava chiavi gia' minuscole. L'ha preso il test del
    // CABLAGGIO, che e' il motivo per cui esiste (§5-bis p.181).
    const minSize = (() => {
      if (!minSizePerMercato || typeof minSizePerMercato !== 'object') return null;
      const diretto = num(minSizePerMercato[cid]);
      if (diretto !== null) return diretto;
      for (const k of Object.keys(minSizePerMercato)) {
        if (norm(k) === cid) return num(minSizePerMercato[k]);
      }
      return null;
    })();
    for (const x of lista) {
      const valoreUsd = fin(x.curPrice) && x.curPrice > 0 ? +(x.curPrice * x.size).toFixed(4) : null;
      if (minSize === null) {
        lasciate.push({ ...x, valoreUsd, sottoMinimo: null, minSizeMercato: null,
          motivo: 'minimo del venue non leggibile per questo mercato: non si vende al buio, la gamba resta e si dichiara' });
        continue;
      }
      if (x.size < minSize) {
        lasciate.push({ ...x, valoreUsd, sottoMinimo: true, minSizeMercato: minSize,
          motivo: `${x.size} share sotto il minimo del venue (${minSize}): resta fino alla risoluzione, dove vale 0 o 1 per share`
            + ' — l\'emergenza non e\' il momento di aprire un percorso nuovo (R10)' });
        continue;
      }
      daVendere.push({ ...x, valoreUsd, minSizeMercato: minSize,
        motivo: `gamba SCOPERTA di ${x.size} share: esposizione direzionale pura, si vende attraversando il book`
          + ' — in emergenza un ordine che non si esegue non e\' un\'uscita' });
    }
  }

  // I due numeri che servono a giudicare se il kill ha fatto il suo mestiere. `null` se nemmeno una
  // posizione aveva un prezzo corrente leggibile: una somma di zeri non e' una misura.
  const somma = (arr) => {
    const v = arr.map((x) => x.valoreUsd).filter((x) => fin(x));
    return v.length ? +v.reduce((a, b) => a + b, 0).toFixed(4) : null;
  };

  return {
    ok: true, daFondere, daVendere, lasciate, motivo: null,
    esposizioneDirezionaleUsd: somma(daVendere),
    bloccataUsd: somma(lasciate),
  };
}

/** Prove interne. Girano con `node lib/maker/chiusura-di-emergenza.js`. */
function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (nome, cond, extra) => {
    if (cond) { pass += 1; console.log(`  ok  ${nome}`); }
    else { fail += 1; console.log(`FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
  };
  const P = (asset, cid, size, cur = 0.5) => ({ asset, conditionId: cid, size, avgPrice: 0.5, curPrice: cur });

  // ── FAIL-CLOSED ────────────────────────────────────────────────────────────────────────────────
  ok('posizioni non leggibili ⇒ nessuna classificazione', classifica({ posizioni: null }).ok === false);
  ok('  e nessuna delle tre liste contiene niente', (() => {
    const r = classifica({ posizioni: null });
    return r.daFondere.length === 0 && r.daVendere.length === 0 && r.lasciate.length === 0;
  })());
  ok('nessuna posizione ⇒ ok, ma tutto vuoto', (() => {
    const r = classifica({ posizioni: [] });
    return r.ok === true && r.daFondere.length === 0 && r.daVendere.length === 0 && r.lasciate.length === 0;
  })());

  // ── I TRE DESTINI ──────────────────────────────────────────────────────────────────────────────
  const c = classifica({ posizioni: [P('y', 'm1', 60), P('n', 'm1', 60)], minSizePerMercato: { m1: 20 } });
  ok('coppia completa ⇒ da FONDERE, non da vendere', c.daFondere.length === 1 && c.daVendere.length === 0);
  ok('  con la size della gamba piu\' piccola', c.daFondere[0].size === 60);
  ok('  e i due asset dichiarati', c.daFondere[0].assets.length === 2);

  const s = classifica({ posizioni: [P('y', 'm2', 60)], minSizePerMercato: { m2: 20 } });
  ok('gamba scoperta sopra il minimo ⇒ da VENDERE', s.daVendere.length === 1 && s.lasciate.length === 0);
  ok('  col valore misurato', s.daVendere[0].valoreUsd === 30);

  const b = classifica({ posizioni: [P('h', 'm3', 6)], minSizePerMercato: { m3: 20 } });
  ok('gamba sotto il minimo ⇒ LASCIATA e dichiarata', b.lasciate.length === 1 && b.daVendere.length === 0);
  ok('  marcata sottoMinimo col minimo del mercato', b.lasciate[0].sottoMinimo === true && b.lasciate[0].minSizeMercato === 20);
  ok('  e il motivo dice fino a quando resta', /risoluzione/.test(b.lasciate[0].motivo));

  // ── IL MINIMO NON LEGGIBILE NON DIVENTA ZERO ───────────────────────────────────────────────────
  // ⚠ E' §5.3 `Number(null) === 0`: se il minimo mancante valesse 0 ogni gamba sarebbe «sopra il
  // minimo» e verrebbe venduta al buio. La direzione prudente qui e' l'opposta.
  const senza = classifica({ posizioni: [P('y', 'm4', 60)], minSizePerMercato: {} });
  ok('minimo non leggibile ⇒ la gamba si LASCIA, non si vende', senza.lasciate.length === 1 && senza.daVendere.length === 0);
  ok('  e sottoMinimo e\' null (non so), non true (so che lo e\')', senza.lasciate[0].sottoMinimo === null);
  ok('minSizePerMercato assente del tutto ⇒ stessa risposta',
    classifica({ posizioni: [P('y', 'm4', 60)] }).lasciate.length === 1);
  // ⚠ MA UNA CHIAVE IN MAIUSCOLO NON E' UNA CHIAVE ASSENTE. Il primo giro di questo modulo confrontava
  // il `conditionId` normalizzato con le chiavi COSI' COME ARRIVANO: su una mappa `{ mB: 20 }` ogni
  // mercato rispondeva «minimo non leggibile» e finiva fra le lasciate. Fail-closed, quindi non
  // pericoloso, ma sbagliato — e questo selfcheck non lo vedeva perche' usava solo chiavi minuscole.
  ok('chiave della mappa in MAIUSCOLO: si trova lo stesso',
    classifica({ posizioni: [{ asset: 'y', conditionId: '0xAB', size: 60, curPrice: 0.5 }],
      minSizePerMercato: { '0xab': 20 } }).daVendere.length === 1);
  ok('  e nel verso opposto', (() => {
    const r = classifica({ posizioni: [{ asset: 'y', conditionId: '0xab', size: 60, curPrice: 0.5 }],
      minSizePerMercato: { '0xAB': 20 } });
    return r.daVendere.length === 1;
  })());

  // ── COPPIA SBILANCIATA: NON E' UNA COPPIA ──────────────────────────────────────────────────────
  const sb = classifica({ posizioni: [P('y', 'm5', 60), P('n', 'm5', 30)], minSizePerMercato: { m5: 20 } });
  ok('due gambe di size DIVERSA non sono una coppia: due vendite', sb.daFondere.length === 0 && sb.daVendere.length === 2);
  // La tolleranza sui decimali del fill parziale.
  const tol = classifica({ posizioni: [P('y', 'm6', 60), P('n', 'm6', 60.005)], minSizePerMercato: { m6: 20 } });
  ok('  ma 5 millesimi di scarto restano una coppia (fill parziale)', tol.daFondere.length === 1);

  // ── UNA COPPIA COMPLETA SOTTO IL MINIMO SI FONDE LO STESSO ─────────────────────────────────────
  // Il merge on-chain non ha minimi di size (§5-bis p.187): il minimo e' del LIBRO, e il merge non
  // passa dal libro. Sbagliare qui vorrebbe dire lasciare bloccata una coppia che si poteva incassare.
  const cs = classifica({ posizioni: [P('y', 'm7', 6), P('n', 'm7', 6)], minSizePerMercato: { m7: 20 } });
  ok('coppia completa SOTTO il minimo ⇒ si fonde comunque (il merge non passa dal libro)',
    cs.daFondere.length === 1 && cs.lasciate.length === 0);

  // ── I DUE TOTALI ───────────────────────────────────────────────────────────────────────────────
  const t = classifica({ posizioni: [P('y', 'm8', 60, 0.4), P('h', 'm9', 6, 0.5)],
    minSizePerMercato: { m8: 20, m9: 20 } });
  ok('esposizione direzionale = somma delle gambe da vendere', t.esposizioneDirezionaleUsd === 24);
  ok('bloccata = somma delle gambe lasciate', t.bloccataUsd === 3);
  // ⚠ «non misurabile» non e' zero: senza nemmeno un prezzo corrente il totale e' `null`.
  const np = classifica({ posizioni: [{ asset: 'y', conditionId: 'm10', size: 60, curPrice: null }],
    minSizePerMercato: { m10: 20 } });
  ok('nessun prezzo corrente ⇒ totale null, non 0', np.esposizioneDirezionaleUsd === null && np.daVendere.length === 1);

  // ── SIZE ILLEGGIBILE O ZERO: IGNORATA ──────────────────────────────────────────────────────────
  ok('size zero o illeggibile non entra in nessuna lista', (() => {
    const r = classifica({ posizioni: [{ asset: 'y', conditionId: 'm11', size: 0 },
      { asset: 'z', conditionId: 'm11', size: 'boh' }], minSizePerMercato: { m11: 20 } });
    return r.ok === true && r.daFondere.length === 0 && r.daVendere.length === 0 && r.lasciate.length === 0;
  })());

  // ── LA PROPRIETA' STRUTTURALE: NESSUN `require` ────────────────────────────────────────────────
  // Un modulo che decide in emergenza non deve poter toccare niente. Lo si prova sul TESTO, perche'
  // e' l'unico modo di provarlo senza eseguire ogni ramo.
  {
    const src = require('fs').readFileSync(__filename, 'utf8');
    const righe = src.split('\n').filter((l) => /\brequire\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    // L'unico ammesso e' quello di `fs` dentro questo stesso selfcheck.
    const fuori = righe.filter((l) => !/readFileSync\(__filename/.test(l));
    ok('il modulo non ha nessun `require` fuori dal selfcheck', fuori.length === 0,
      fuori.join(' | ').slice(0, 160));
  }

  console.log(`\nchiusura di emergenza: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { classifica };

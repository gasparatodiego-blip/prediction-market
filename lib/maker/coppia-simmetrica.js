'use strict';
// lib/maker/coppia-simmetrica.js — UNA SOLA FUNZIONE DIMENSIONA LE DUE GAMBE, NELLO STESSO ISTANTE. PURO.
//
// ═══ IL DIFETTO CHE CHIUDE, MISURATO DAL BANCO (passo 13, 17 agosto 2026) ════════════════════════════
// Il ripristino della gamba morta veniva rifiutato da `nozionale-mercato-oltre-tetto`:
//
//     gamba YES superstite   87,5 share × $0,32 = $28,00
//     gamba NO da rimettere  62,2 share × $0,63 = $39,17
//     totale                                      $67,17   contro un tetto di $61,25  ⇒  sforo $5,92
//
// ⚠ E LA PRIMA DIAGNOSI DI QUELLO SFORO ERA SBAGLIATA, va detto perche' cambia la cura. Avevo scritto
// «il riprezzo ricalcola la size della gamba viva»: NON e' vero — `auto-reprice` passa `size: order.size`
// a `replaceManualOrder` (undici punti, verificato), quindi il riprezzo la size non la tocca mai.
//
// LA CAUSA VERA E' PIU' SEMPLICE E PIU' GENERALE: `gambeDiUnaRiga` calcola `Q = capitale / (p_yes + p_no)`,
// cioe' due gambe SIMMETRICHE — ma simmetriche NELL'ISTANTE in cui le costruisce. La gamba superstite
// porta addosso la size dell'istante in cui fu piazzata; quando il mid si muove, `p_yes + p_no` cambia e
// la stessa funzione, chiamata oggi, produce un'altra size. 87,5 e 62,2 sono la STESSA formula a due
// istanti diversi: la coppia costava $0,675 allora e $0,95 adesso.
//
//     ⇒ una coppia SIMMETRICA non puo' sfondare il tetto (per costruzione `Q·(p_yes+p_no) = capitale`),
//       quindi lo sforo NON e' un tetto troppo stretto: e' l'asimmetria. Alzare il tetto autorizzerebbe
//       la size che l'asimmetria ha prodotto invece di correggerla.
//
// ═══ LA REGOLA, DECISA DALL'OPERATORE (17 agosto 2026) ═══════════════════════════════════════════════
// «Una sola funzione deve decidere la size di ENTRAMBE le gambe nello stesso istante, dallo stesso mid e
// dallo stesso piano. Se la coppia non ci sta sotto il tetto, si ridimensionano tutte e due insieme, non
// si allarga il tetto.»
//
// Questo modulo e' quella funzione. Riceve le due gambe appena costruite (stesso istante, stesso mid,
// stesso piano) e le gambe VIVE osservate al venue, e restituisce UNA size per tutte e due.
//
// ═══ IL VINCOLO CHE VINCE E' IL PIU' STRETTO DEI TRE, e nessuno dei tre puo' far CRESCERE niente ══════
//     Q = min( Q_piano , Q_tetto , Q_viva )
//
//   · **Q_piano**  la size che il piano compra oggi: `capitale / (p_yes + p_no)`. E' `gambeDiUnaRiga`.
//   · **Q_tetto**  `tetto / (p_yes_effettivo + p_no_effettivo)`, e «effettivo» vuol dire: per la gamba che
//                  SOPRAVVIVE si usa il prezzo che ha DAVVERO a libro, non quello del piano. Se si usasse
//                  il prezzo di piano per entrambe, un ordine vivo piu' caro del piano farebbe passare un
//                  totale che poi il gate rifiuterebbe — cioe' si tornerebbe a proporre l'impossibile.
//   · **Q_viva**   la size della gamba viva. E' il vincolo che rende questo modulo MONOTONO: la gamba
//                  viva si puo' solo RIMPICCIOLIRE. Far crescere un ordine a riposo per «pareggiare» la
//                  coppia sarebbe aggiungere esposizione per ragioni di simmetria, e la simmetria si
//                  ottiene anche scendendo. Chi scende non ha bisogno di essere autorizzato.
//
// ⚠ E SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE. Se la coppia simmetrica che sta sotto il tetto
// starebbe sotto `min_incentive_size`, il reward e' ZERO su entrambi i lati (non «piu' basso»): si
// dichiara e non si agisce. E' l'unico esito in cui questo modulo dice «no» invece di dire «piu' piccolo».
//
// ⚠ L'ORDINE DELLE DUE AZIONI NON E' UN DETTAGLIO: PRIMA SI RIMPICCIOLISCE, POI SI PIAZZA. Il gate
// `nozionale-mercato-oltre-tetto` somma il nozionale a riposo, quindi piazzare prima di ridurre incontra
// ancora il tetto vecchio. E se la riduzione fallisce, chi la esegue NON deve piazzare: due gambe
// asimmetriche sono peggio di una gamba sola, perche' la seconda non e' ne' premiante ne' chiudibile.
// L'ordine e' dichiarato qui e verificato dal test dello scatto — non affidato a chi cabla.
//
// ⚠ IL PREZZO DELLA GAMBA VIVA NON SI TOCCA. Il ridimensionamento riscrive la size e ricopia il prezzo
// che l'ordine ha adesso: decidere il prezzo e' mestiere del motore (banda, «mai primo sul libro», con il
// libro vivo sotto gli occhi), e questo modulo non ha il libro. Chi esegue passa da `replaceManualOrder`,
// che quei gate li rifa' tutti e rifiuta con `oldCancelled:false` se il prezzo non e' piu' conforme.
//
// ⚠ ZERO `require`: la stessa disciplina di `copertura-gambe`, `ripristino-gambe`, `presa-di-profitto`.
// Il tetto arriva iniettato da chi lo IMPORTA da `lib/rewards/concentration` (una fonte, §4.2): ricopiarlo
// qui sarebbe il reperto D1, e una divergenza allargherebbe un limite di rischio.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
// Le share si troncano a due decimali, come `troncaShare` del pianificatore: arrotondare per eccesso
// puo' rimettere sopra il tetto la coppia che si e' appena portata sotto.
const troncaShare = (x) => Math.floor(x * 100) / 100;

/**
 * @param a.gambe          le righe di `gambeDiUnaRiga` (book 'yes'|'no', price, size) — stesso istante
 * @param a.ordiniVivi     gli ordini a riposo di QUESTO mercato (orderId, tokenId, price, size)
 * @param a.tokenIdYes / a.tokenIdNo   la tabella token → book
 * @param a.tettoUsd       il tetto per mercato, IMPORTATO da chi cabla (mai ricopiato qui)
 * @param a.minSizeShares  `min_incentive_size` del venue per questo mercato
 * @returns {{ok:boolean, size:number|null, motivo:string, vincolo:string|null,
 *            ridimensionamenti:Array, daPiazzare:Array, totaleUsd:number|null, sommaPrezzi:number|null}}
 */
function dimensionaCoppia(a = {}) {
  const no = (motivo, extra) => ({ ok: false, size: null, motivo, vincolo: null,
    ridimensionamenti: [], daPiazzare: [], totaleUsd: null, sommaPrezzi: null, ...(extra || {}) });

  const gambe = Array.isArray(a.gambe) ? a.gambe.filter((g) => g && (norm(g.book) === 'yes' || norm(g.book) === 'no')) : [];
  const perBook = new Map();
  for (const g of gambe) perBook.set(norm(g.book), g);
  if (perBook.size !== 2) {
    return no('la riga di piano non produce due gambe (una per lato): non si dimensiona una coppia che non esiste');
  }
  const gY = perBook.get('yes'); const gN = perBook.get('no');
  if (!fin(gY.price) || !fin(gN.price) || gY.price <= 0 || gN.price <= 0) {
    return no('prezzi di piano non leggibili su almeno un lato: fail-closed');
  }
  // ⚠ LE DUE GAMBE COSTRUITE DEVONO GIA' ESSERE SIMMETRICHE. Se non lo sono, chi le ha costruite non e'
  // `gambeDiUnaRiga` — o `gambeDiUnaRiga` e' cambiata — e questo modulo non deve indovinare quale delle
  // due size sia quella giusta. E' la guardia che impedisce di ereditare un'asimmetria dal monte.
  if (!fin(gY.size) || !fin(gN.size) || gY.size <= 0 || Math.abs(gY.size - gN.size) > 0.011) {
    return no(`le due gambe costruite non sono simmetriche (${gY.size} vs ${gN.size}): non si dimensiona sopra un'asimmetria che arriva da monte`);
  }
  const tetto = fin(a.tettoUsd) && a.tettoUsd > 0 ? a.tettoUsd : null;
  if (tetto == null) return no('tetto per mercato non iniettato: senza il tetto non si dichiara che la coppia ci sta');
  const minSize = fin(a.minSizeShares) && a.minSizeShares > 0 ? a.minSizeShares : null;

  // ── LE GAMBE VIVE, tradotte token → book ───────────────────────────────────────────────────────
  const y = norm(a.tokenIdYes); const n = norm(a.tokenIdNo);
  if (!y || !n || y === n) {
    return no('i due token del mercato non sono leggibili o coincidono: non si traduce token → book');
  }
  const vive = new Map();
  for (const o of (Array.isArray(a.ordiniVivi) ? a.ordiniVivi : [])) {
    const t = norm(o && (o.tokenId || o.asset_id || o.assetId));
    const book = t === y ? 'yes' : (t === n ? 'no' : null);
    if (!book) continue;
    if (!fin(Number(o.price)) || !fin(Number(o.size))) {
      return no(`un ordine vivo sul lato ${book.toUpperCase()} non ha prezzo o size leggibili: non si dimensiona una coppia di cui non si sa cosa c'e' a libro`);
    }
    // ⚠ DUE ORDINI SULLO STESSO LATO ⇒ NON SI DIMENSIONA. La riconciliazione toglie i doppioni PRIMA di
    // arrivare qui (`trovaDoppioni`, passo ① di `riconciliaCopertura`): se ne restano due, o la
    // cancellazione e' fallita o sono due ordini diversi voluti, e in entrambi i casi «quale
    // ridimensiono» non e' una domanda a cui questo modulo puo' rispondere da solo.
    if (vive.has(book)) {
      return no(`due ordini vivi sullo stesso lato ${book.toUpperCase()}: si dichiara e non si ridimensiona al buio (i doppioni si togliono prima)`);
    }
    vive.set(book, { orderId: o.orderId || o.id || null, book, price: Number(o.price), size: Number(o.size) });
  }

  // ── I TRE VINCOLI, e il piu' stretto vince ─────────────────────────────────────────────────────
  // I prezzi EFFETTIVI: chi sopravvive tiene il suo, chi nasce prende quello del piano.
  const prezzoEff = (book) => (vive.has(book) ? vive.get(book).price : perBook.get(book).price);
  const sommaPrezzi = +(prezzoEff('yes') + prezzoEff('no')).toFixed(6);
  const qPiano = gY.size;
  const qTetto = troncaShare(tetto / sommaPrezzi);
  const qViva = vive.size ? Math.min(...[...vive.values()].map((v) => v.size)) : null;

  let size = Math.min(qPiano, qTetto);
  let vincolo = qTetto < qPiano ? 'tetto' : 'piano';
  if (qViva != null && qViva < size) { size = qViva; vincolo = 'gamba-viva'; }
  size = troncaShare(size);

  if (!(size > 0)) return no(`la coppia simmetrica sarebbe di ${size} share: non c'e' niente da piazzare`);
  if (minSize != null && size < minSize) {
    return no(`la coppia simmetrica che sta sotto il tetto sarebbe di ${size} share per lato, sotto il minimo premiante del venue (${minSize}):`
      + ' sotto quella soglia il reward e\' ZERO su entrambi i lati, quindi non si ricostruisce — e il tetto NON si allarga',
    { vincolo, sommaPrezzi, size });
  }

  // ── COSA VA FATTO, IN QUEST'ORDINE ─────────────────────────────────────────────────────────────
  const ridimensionamenti = [];
  for (const v of vive.values()) {
    // La tolleranza e' mezzo centesimo di share: sotto quella soglia «ridimensionare» vorrebbe dire
    // cancellare e ripiazzare un ordine identico, cioe' aprire una finestra di scoperto per niente.
    if (v.size - size > 0.005) {
      ridimensionamenti.push({ orderId: v.orderId, book: v.book, price: v.price, daSize: v.size, aSize: size,
        risparmioUsd: +((v.size - size) * v.price).toFixed(4) });
    }
  }
  const daPiazzare = [];
  for (const book of ['yes', 'no']) {
    if (vive.has(book)) continue;
    daPiazzare.push({ ...perBook.get(book), size });
  }
  const totaleUsd = +(size * sommaPrezzi).toFixed(4);

  return { ok: true, size, sommaPrezzi, totaleUsd, vincolo,
    qPiano, qTetto, qViva,
    ridimensionamenti, daPiazzare,
    // L'ordine e' parte della risposta, non una convenzione fra chiamanti.
    ordineDelleAzioni: ridimensionamenti.length ? 'prima-ridimensiona-poi-piazza' : 'solo-piazza',
    motivo: `coppia simmetrica a ${size} share per lato (vincolo: ${vincolo}) — $${totaleUsd.toFixed(2)} sul tetto di $${tetto.toFixed(2)}`
      + `${ridimensionamenti.length ? `, dopo aver ridotto ${ridimensionamenti.length} gamba/e viva/e` : ''}` };
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ coppia-simmetrica ════');

  const tok = { tokenIdYes: 'tokY', tokenIdNo: 'tokN' };
  const gambe = (size, pY = 0.32, pN = 0.63) => ([
    { book: 'yes', price: pY, size, side: 'BUY', marketId: '0xAA', inCoda: true },
    { book: 'no', price: pN, size, side: 'BUY', marketId: '0xAA', inCoda: true },
  ]);

  // ── IL CASO MISURATO DAL BANCO, alla lettera ──────────────────────────────────────────────────
  {
    const r = dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: 87.5 }] });
    ok('il caso del passo 13 si risolve', r.ok === true, r.motivo);
    ok('  la coppia e SIMMETRICA', r.ridimensionamenti[0] && r.ridimensionamenti[0].aSize === r.daPiazzare[0].size,
      `viva → ${r.ridimensionamenti[0] && r.ridimensionamenti[0].aSize}, nuova ${r.daPiazzare[0] && r.daPiazzare[0].size}`);
    ok('  e sta SOTTO il tetto', r.totaleUsd <= 61.25, `$${r.totaleUsd} ≤ $61,25`);
    ok('  il vincolo che morde e il PIANO, non il tetto', r.vincolo === 'piano', `qPiano ${r.qPiano} · qTetto ${r.qTetto} · qViva ${r.qViva}`);
    ok('  la gamba viva SCENDE da 87,5 a 62,2', r.ridimensionamenti.length === 1 && r.ridimensionamenti[0].daSize === 87.5 && r.ridimensionamenti[0].aSize === 62.2);
    ok('  e prima si riduce, poi si piazza', r.ordineDelleAzioni === 'prima-ridimensiona-poi-piazza');
    ok('  il prezzo della gamba viva NON viene toccato', r.ridimensionamenti[0].price === 0.32);
  }

  // ── IL TETTO MORDE: si scende, non si allarga ─────────────────────────────────────────────────
  {
    const r = dimensionaCoppia({ gambe: gambe(200), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: 200 }] });
    ok('piano troppo grande ⇒ vince il TETTO', r.ok === true && r.vincolo === 'tetto', r.motivo);
    ok('  e il totale non lo sfonda', r.totaleUsd <= 61.25, `$${r.totaleUsd}`);
    ok('  ENTRAMBE scendono alla stessa size',
      r.ridimensionamenti[0].aSize === r.daPiazzare[0].size && r.daPiazzare[0].size === r.size);
  }

  // ── LA GAMBA VIVA PUO' SOLO RIMPICCIOLIRE ─────────────────────────────────────────────────────
  {
    const r = dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: 40 }] });
    ok('gamba viva PIU PICCOLA del piano ⇒ vince lei', r.ok === true && r.vincolo === 'gamba-viva' && r.size === 40, r.motivo);
    ok('  e non si ridimensiona NIENTE (non si fa crescere un ordine a riposo)', r.ridimensionamenti.length === 0);
    ok('  la gamba nuova nasce alla size della viva', r.daPiazzare[0].size === 40);
  }
  {
    // Monotonia, provata su cento size: la coppia decisa non e' MAI piu' grande della gamba viva.
    let mai = true;
    for (let s = 1; s <= 100; s += 1) {
      const r = dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 1,
        ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: s }] });
      if (r.ok && r.size > s + 1e-9) mai = false;
    }
    ok('MONOTONO su 100 size: la coppia non supera mai la gamba viva', mai);
  }

  // ── SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE ─────────────────────────────────────────────
  {
    const r = dimensionaCoppia({ gambe: gambe(15), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: 15 }] });
    ok('sotto il minimo premiante ⇒ NON si ricostruisce', r.ok === false && /minimo premiante/.test(r.motivo), r.motivo);
    ok('  e il tetto non c entra: e dichiarato', /NON si allarga/.test(r.motivo));
  }
  {
    // Il tetto stringe FIN SOTTO il minimo: e' il caso in cui «ridimensionare entrambe» non basta, e la
    // risposta giusta e' non agire — non un tetto piu' largo.
    const r = dimensionaCoppia({ gambe: gambe(200, 0.9, 0.9), ...tok, tettoUsd: 10, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.9, size: 200 }] });
    ok('tetto che stringe sotto il minimo ⇒ nessuna azione', r.ok === false && /minimo premiante/.test(r.motivo), r.motivo);
  }

  // ── IL PREZZO EFFETTIVO E' QUELLO DELL'ORDINE VIVO, NON QUELLO DEL PIANO ──────────────────────
  {
    // La gamba viva sta a 0,50 mentre il piano la prezzerebbe 0,32: se si usasse il prezzo di piano il
    // totale sembrerebbe $61,15 e il gate rifiuterebbe. Con i prezzi veri si scende.
    const r = dimensionaCoppia({ gambe: gambe(54), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.50, size: 54 }] });
    ok('il tetto si calcola sui prezzi VERI di cio che restera a libro', r.ok === true && r.sommaPrezzi === 1.13, `somma ${r.sommaPrezzi}`);
    ok('  quindi la coppia scende sotto il tetto davvero', r.totaleUsd <= 61.25, `$${r.totaleUsd} con ${r.size} share`);
  }

  // ── DUE GAMBE MANCANTI: si piazzano entrambe, simmetriche ─────────────────────────────────────
  {
    const r = dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20, ordiniVivi: [] });
    ok('zero gambe vive ⇒ se ne piazzano DUE, uguali', r.ok === true && r.daPiazzare.length === 2
      && r.daPiazzare[0].size === r.daPiazzare[1].size);
    ok('  e non c e niente da ridimensionare', r.ordineDelleAzioni === 'solo-piazza');
  }

  // ── I FAIL-CLOSED ─────────────────────────────────────────────────────────────────────────────
  ok('una gamba sola in ingresso ⇒ non si dimensiona',
    dimensionaCoppia({ gambe: [gambe(62.2)[0]], ...tok, tettoUsd: 61.25 }).ok === false);
  ok('gambe costruite ASIMMETRICHE ⇒ rifiuto (non si eredita l asimmetria da monte)',
    dimensionaCoppia({ gambe: [{ book: 'yes', price: 0.32, size: 80 }, { book: 'no', price: 0.63, size: 60 }],
      ...tok, tettoUsd: 61.25 }).ok === false);
  ok('tetto non iniettato ⇒ rifiuto (non si ricopia)',
    dimensionaCoppia({ gambe: gambe(62.2), ...tok }).ok === false);
  ok('token del mercato mancanti ⇒ rifiuto',
    dimensionaCoppia({ gambe: gambe(62.2), tettoUsd: 61.25 }).ok === false);
  ok('token coincidenti ⇒ rifiuto',
    dimensionaCoppia({ gambe: gambe(62.2), tokenIdYes: 'x', tokenIdNo: 'x', tettoUsd: 61.25 }).ok === false);
  ok('ordine vivo senza prezzo ⇒ rifiuto (non si conta cio che non si legge)',
    dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', size: 87.5 }] }).ok === false);
  ok('due ordini sullo stesso lato ⇒ rifiuto',
    dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x1', tokenId: 'tokY', price: 0.32, size: 87.5 },
        { orderId: '0x2', tokenId: 'tokY', price: 0.31, size: 20 }] }).ok === false);
  ok('un token estraneo al mercato viene IGNORATO, non fa fallire',
    dimensionaCoppia({ gambe: gambe(62.2), ...tok, tettoUsd: 61.25, minSizeShares: 20,
      ordiniVivi: [{ orderId: '0x9', tokenId: 'tokZ', price: 0.5, size: 10 }] }).ok === true);

  // ── L'INVARIANTE CHE CONTA: qualunque risposta `ok` sta sotto il tetto ─────────────────────────
  {
    let sempre = true; let casi = 0;
    for (let pY = 0.05; pY <= 0.9; pY += 0.05) {
      for (const s of [20, 40, 62.2, 100, 250]) {
        for (const sv of [null, 20, 45, 87.5, 300]) {
          const r = dimensionaCoppia({ gambe: gambe(s, +pY.toFixed(2), +(0.98 - pY).toFixed(2)), ...tok,
            tettoUsd: 61.25, minSizeShares: 20,
            ordiniVivi: sv == null ? [] : [{ orderId: '0x1', tokenId: 'tokY', price: +pY.toFixed(2), size: sv }] });
          casi += 1;
          if (r.ok && r.totaleUsd > 61.25 + 1e-6) sempre = false;
        }
      }
    }
    ok('su tutti i casi provati, una risposta `ok` sta SEMPRE sotto il tetto', sempre, `${casi} combinazioni`);
  }

  console.log(`\n  ${p} ok, ${f} NO`);
  return f === 0;
}

module.exports = { dimensionaCoppia, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

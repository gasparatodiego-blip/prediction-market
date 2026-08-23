'use strict';
// lib/maker/rinnovo-sotto-il-pavimento.test.js — IL RINNOVO NON E' UN INGRESSO. 23 agosto 2026.
//
// ═══ LA PROPRIETA' DIFESA, IN UNA FRASE ══════════════════════════════════════════════════════════
// **Un ordine gia' a libro, rinnovato a prezzo e size IDENTICI su un mercato la cui profondita' e'
// scesa sotto la soglia d'ingresso, DEVE essere rinnovato e non rifiutato.**
//
// Non e' una fotografia del sorgente: nessuna asserzione qui dentro guarda una stringa, un conteggio
// di occorrenze o la forma di una chiamata. Si costruisce un book vero, lo si mette sotto il
// pavimento, e si guarda il VERDETTO — che e' quello che decide se un ordine da 56 share resta a
// libro o muore per GTD.
//
// ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════
// L'esenzione (`esenzione-rinnovo.provaRinnovo` + il ramo di `trovaLivello`) esisteva dal 16 agosto e
// aveva 21 prove interne tutte verdi. Era INERTE lo stesso: `valutaMercato` — l'unico ponte fra il
// chiamante che costruiva la prova e la funzione che la consuma — non destrutturava `rinnovo` e non
// lo inoltrava. Le prove del mittente e quelle del ricevitore erano verdi entrambe, e in mezzo il
// filo era tagliato. Le 21 prove interne non potevano accorgersene perche' chiamano `provaRinnovo`
// direttamente; questo file entra da `valutaMercato`, cioe' dalla porta da cui entra il bot.
//
// ⚠ ROSSO SUL SORGENTE NON CORRETTO, verificato mutazione per mutazione (vedi in fondo).
//
// ═══ COSA MISURA, COL BOOK VERO DEL CASO REALE ═══════════════════════════════════════════════════
// Il caso e' quello misurato: pavimento $175, profondita' altrui davanti $118 su 3 livelli — un libro
// che NON e' illiquido (il ripiego per un mercato senza storico e' $15), solo piu' sottile della
// propria media recente.

const { valutaMercato, DEPTH_FLOOR_PCT_OF_AVG } = require('./motore-unico');
const { provaRinnovo } = require('./esenzione-rinnovo');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra = '') {
  if (cond) { passati += 1; console.log(`  ok    ${nome}`); }
  else { falliti += 1; console.log(`  FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
}
const prof = (v) => (v.bocciature || []).find((b) => b.regola === 'profondita-insufficiente') || null;

// ── IL MERCATO, COSTRUITO UNA VOLTA ─────────────────────────────────────────────────────────────
// Banda ±4,5¢ intorno a 0,50, tick 1¢. Tre livelli altrui in banda, per $118,34 complessivi: sotto un
// pavimento di $175,07, che e' il 10% di una media recente di $1.750 — cioe' esattamente la forma del
// caso reale, dove il libro si e' assottigliato rispetto a SE STESSO.
const MEDIA_ALTRUI_USD = 1750.7;          // la media in banda di QUEL mercato
const PAVIMENTO = MEDIA_ALTRUI_USD * DEPTH_FLOOR_PCT_OF_AVG;   // derivato, non ricopiato: $175,07
const NOSTRO = { orderId: '0xvecchio', marketId: '0xM', tokenId: 'tokYES', side: 'BUY', price: 0.47, size: 56.5 };
const mercato = (extra = {}) => ({
  marketId: '0xM', side: 'BUY',
  bookLevels: [
    { price: 0.49, size: 120 },   // il primo livello e' della Regola 1: la ricerca parte dal secondo
    { price: 0.48, size: 100 },
    { price: 0.47, size: 56.5 },  // il NOSTRO, che `othersLadder` sottrae
    { price: 0.46, size: 90 },
  ],
  bandBounds: { lo: 0.455, hi: 0.545 },
  bandRadiusCents: 4.5, tick: 0.01, scoringMid: 0.50,
  ownOrders: [{ orderId: '0xvecchio', price: 0.47, size: 56.5 }],
  proposedSize: 56.5, proposedPrice: 0.47,
  saldoUsd: 1400, esposizioneMercatoUsd: 0,
  liquiditaMediaUsd: MEDIA_ALTRUI_USD, liquiditaCampioniAltrui: 40,
  ...extra,
});

// ── ① IL FATTO DI PARTENZA: SENZA PROVA DI RINNOVO IL PAVIMENTO MORDE ───────────────────────────
console.log('\n① il pavimento morde su un INGRESSO — e deve continuare a mordere');
const apertura = valutaMercato(mercato());
ok('senza prova di rinnovo il mercato e\' rifiutato per profondita-insufficiente',
  apertura.ok === false && !!prof(apertura), JSON.stringify(apertura.bocciature));
ok('  e il motivo dice che la banda finisce prima del pavimento',
  !!prof(apertura) && /banda finisce prima del pavimento/.test(prof(apertura).motivo));
ok('  il pavimento e\' il 10% della media ALTRUI di QUEL mercato, non un dollaro fisso',
  Math.abs(apertura.controlli.pavimento.usd - PAVIMENTO) < 0.01,
  `${apertura.controlli.pavimento.usd} vs ${PAVIMENTO}`);
ok('  e il libro NON e\' illiquido: c\'e\' piu\' profondita\' altrui del ripiego da $15',
  apertura.controlli.livello.depthAheadUsd > 15,
  String(apertura.controlli.livello.depthAheadUsd));

// ── ② LA PROPRIETA': STESSO PREZZO, STESSA SIZE, ORDINE GIA' A LIBRO ⇒ SI RINNOVA ───────────────
console.log('\n② stesso prezzo e stessa size su un ordine gia\' a libro ⇒ IL RINNOVO PASSA');
const prova = provaRinnovo({ conditionId: '0xM', tokenId: 'tokYES', side: 'BUY',
  size: 56.5, price: 0.47, ordiniVivi: [NOSTRO] });
ok('la prova di rinnovo e\' concessa (e non e\' una dichiarazione: e\' aritmetica sugli ordini vivi)',
  prova.esente === true, prova.motivo);
const rinnovo = valutaMercato(mercato({ rinnovo: prova }));
// ⚠ QUESTA E' L'ASSERZIONE CHE MORDE. Rossa su ogni sorgente in cui il filo fra `valutaMercato` e
// `trovaLivello` e' tagliato — cioe' su tutto cio' che esisteva fino al 23 agosto 2026.
ok('IL RINNOVO NON E\' PIU\' RIFIUTATO PER PROFONDITA\'',
  prof(rinnovo) === null, prof(rinnovo) && prof(rinnovo).motivo);
ok('  il mercato e\' conforme',
  rinnovo.ok === true, rinnovo.motivo);
ok('  e l\'esenzione e\' DICHIARATA, non solo applicata',
  rinnovo.controlli.rinnovo && rinnovo.controlli.rinnovo.esente === true
  && rinnovo.controlli.rinnovo.applicata === true
  && rinnovo.controlli.rinnovo.sostituisce === '0xvecchio');

// ── ②-bis IL CASO IN CUI NESSUN LIVELLO ALTRUI COSTA QUANTO IL NOSTRO ──────────────────────────
// Il nostro ordine sta in fondo alla banda: OGNI livello altrui costa piu' del suo. Il confronto col
// prezzo di riferimento dentro `trovaLivello` scarta tutto, e senza il ramo «il rinnovo tiene il
// prezzo che ha gia'» l'esenzione qui non servirebbe a niente — che e' esattamente il caso su cui la
// prima stesura di questa correzione e' stata misurata a secco e bocciata (`0x3492e56341`, YES BUY
// 0,14: pavimento $165,58, un solo livello altrui oltre il primo, tutti sopra 0,14).
console.log('\n②-bis nessun livello altrui costa quanto il nostro ⇒ il rinnovo tiene il SUO prezzo');
const inFondo = {
  marketId: '0xM', side: 'BUY',
  bookLevels: [{ price: 0.52, size: 120 }, { price: 0.51, size: 100 }, { price: 0.50, size: 80 }, { price: 0.47, size: 56.5 }],
  bandBounds: { lo: 0.455, hi: 0.545 }, bandRadiusCents: 4.5, tick: 0.01, scoringMid: 0.50,
  ownOrders: [{ orderId: '0xvecchio', price: 0.47, size: 56.5 }],
  proposedSize: 56.5, proposedPrice: 0.47, saldoUsd: 1400, esposizioneMercatoUsd: 0,
  liquiditaMediaUsd: MEDIA_ALTRUI_USD, liquiditaCampioniAltrui: 40,
};
ok('senza prova e\' rifiutato dal pavimento', !!prof(valutaMercato({ ...inFondo, rinnovo: null })));
const tieneIlSuo = valutaMercato({ ...inFondo, rinnovo: prova });
ok('con la prova PASSA, e il prezzo restituito e\' quello dell\'ordine sostituito',
  tieneIlSuo.ok === true && Math.abs(tieneIlSuo.price - 0.47) < 1e-9, JSON.stringify(tieneIlSuo.bocciature) + ' price=' + tieneIlSuo.price);
ok('  e lo dichiara: non e\' un livello del book',
  tieneIlSuo.controlli.livello.prezzoDiRiferimento === true && tieneIlSuo.level === null);
ok('  il prezzo non e\' MAI uno dei livelli altrui, che qui costano tutti di piu\'',
  tieneIlSuo.price < 0.50);

// ── ③ MONOTONIA: L'ESENZIONE PUO' SOLO AGGIUNGERE ACCETTAZIONI ──────────────────────────────────
// E' la proprieta' che la prima stesura di questa correzione VIOLAVA, misurata a secco: recuperava 1
// rifiuto e ne creava 4, perche' il confronto col prezzo di riferimento dentro `trovaLivello`
// scartava livelli che il pavimento pieno accettava. Si prova per ESAUSTIONE su una griglia di casi,
// non su un esempio: per ogni configurazione, se passava senza prova deve passare anche con la prova.
console.log('\n③ monotonia per costruzione: nessuna configurazione passa PRIMA e fallisce DOPO');
let coppie = 0; let rotte = 0;
for (const mediaU of [0, 12, 50, 200, 900, 1750.7, 9000]) {
  for (const nostroPrezzo of [0.46, 0.47, 0.48, 0.49, 0.50, 0.53]) {
    for (const size of [10, 56.5, 200]) {
      for (const lato of ['BUY', 'SELL']) {
        const vivo = { orderId: '0xv', marketId: '0xM', tokenId: 'tokYES', side: lato, price: nostroPrezzo, size };
        const base = mercato({
          liquiditaMediaUsd: mediaU, liquiditaCampioniAltrui: mediaU ? 40 : 0,
          ownOrders: [{ orderId: '0xv', price: nostroPrezzo, size }],
          proposedPrice: nostroPrezzo, proposedSize: size,
        });
        const p = provaRinnovo({ conditionId: '0xM', tokenId: 'tokYES', side: lato,
          size, price: nostroPrezzo, ordiniVivi: [vivo] });
        const senza = valutaMercato({ ...base, rinnovo: null });
        const con = valutaMercato({ ...base, rinnovo: p });
        coppie += 1;
        if (!prof(senza) && prof(con)) rotte += 1;
      }
    }
  }
}
ok(`su ${coppie} configurazioni nessuna regressione (passava prima, rifiutata dopo)`, rotte === 0, `${rotte} regressioni`);

// ── ④ CIO' CHE L'ESENZIONE NON TOCCA ────────────────────────────────────────────────────────────
console.log('\n④ l\'esenzione riguarda IL PAVIMENTO e nient\'altro');
const primo = valutaMercato(mercato({
  // Il nostro ordine e' il migliore del lato: «mai primo sul libro» deve rifiutare lo stesso.
  bookLevels: [{ price: 0.49, size: 56.5 }, { price: 0.46, size: 90 }],
  ownOrders: [{ orderId: '0xvecchio', price: 0.49, size: 56.5 }],
  proposedPrice: 0.49,
  rinnovo: provaRinnovo({ conditionId: '0xM', tokenId: 'tokYES', side: 'BUY', size: 56.5, price: 0.49,
    ordiniVivi: [{ ...NOSTRO, price: 0.49 }] }),
}));
ok('«mai primo sul libro» resta assoluto anche su un rinnovo provato',
  primo.ok === false && /mai-primo/.test(primo.motivo), primo.motivo);
const tetto = valutaMercato(mercato({
  saldoUsd: 1400, esposizioneMercatoUsd: 61.25, proposedSize: 56.5, proposedPrice: 0.47,
  rinnovo: prova,
}));
ok('il tetto per MERCATO resta applicato: l\'esenzione non lo tocca',
  (tetto.bocciature || []).some((b) => b.regola === 'tetto-mercato'), JSON.stringify(tetto.bocciature));

// ── ⑤ E CIO' CHE NON E' UN RINNOVO NON OTTIENE NIENTE ───────────────────────────────────────────
console.log('\n⑤ chi non sta rinnovando resta un ingresso, e il pavimento lo giudica per intero');
for (const [nome, arg] of [
  ['size in aumento', { size: 60, price: 0.47 }],
  ['prezzo in aumento a parita\' di size (piu\' nozionale a riposo)', { size: 56.5, price: 0.49 }],
  ['nessun ordine vivo da sostituire', { size: 56.5, price: 0.47, vuoto: true }],
  ['ordini vivi non letti (null)', { size: 56.5, price: 0.47, nulli: true }],
]) {
  const p = provaRinnovo({ conditionId: '0xM', tokenId: 'tokYES', side: 'BUY', size: arg.size, price: arg.price,
    ordiniVivi: arg.nulli ? null : (arg.vuoto ? [] : [NOSTRO]) });
  const v = valutaMercato(mercato({ rinnovo: p, proposedPrice: arg.price, proposedSize: arg.size }));
  ok(`${nome} ⇒ pavimento applicato per intero`, p.esente === false && !!prof(v), p.motivo);
}

// ── ⑥ IL CASO CHE RESTA RIFIUTATO, E DEVE RESTARLO ──────────────────────────────────────────────
// Un solo livello altrui in banda: la ricerca parte dal secondo e non c'e'. Quella guardia sta PRIMA
// del pavimento e non e' toccata — e' una delle due sottocause (2 morti su 49) che questa correzione
// dichiara di NON coprire.
console.log('\n⑥ meno di due livelli altrui in banda: rifiutato prima e dopo');
const magro = mercato({
  bookLevels: [{ price: 0.49, size: 120 }, { price: 0.47, size: 56.5 }],
  ownOrders: [{ orderId: '0xvecchio', price: 0.47, size: 56.5 }],
});
ok('rifiutato senza prova', !!prof(valutaMercato({ ...magro, rinnovo: null })));
ok('rifiutato anche con la prova, e il motivo e\' lo stesso',
  !!prof(valutaMercato({ ...magro, rinnovo: prova }))
  && /la ricerca parte dal secondo/.test(prof(valutaMercato({ ...magro, rinnovo: prova })).motivo));

// ── ⑦ IL PREZZO CHE L'ESENZIONE RESTITUISCE NON E' MAI PIU' CARO DI QUELLO SOSTITUITO ───────────
// L'esenzione toglie il pavimento; non deve poter proporre un livello che costa piu' dell'ordine che
// sostituisce, o rinnovare diventerebbe un modo di aumentare il nozionale a riposo.
console.log('\n⑦ il prezzo proposto non supera mai quello dell\'ordine sostituito');
let violazioni = 0; let provati = 0;
for (const mediaU of [0, 50, 400, 1750.7, 9000]) {
  for (const nostroPrezzo of [0.455, 0.46, 0.47, 0.48]) {
    const vivo = { orderId: '0xv', marketId: '0xM', tokenId: 'tokYES', side: 'BUY', price: nostroPrezzo, size: 56.5 };
    const p = provaRinnovo({ conditionId: '0xM', tokenId: 'tokYES', side: 'BUY', size: 56.5, price: nostroPrezzo, ordiniVivi: [vivo] });
    const v = valutaMercato(mercato({
      liquiditaMediaUsd: mediaU, liquiditaCampioniAltrui: mediaU ? 40 : 0,
      ownOrders: [{ orderId: '0xv', price: nostroPrezzo, size: 56.5 }],
      proposedPrice: nostroPrezzo, rinnovo: p,
    }));
    if (v.ok !== true || v.controlli.rinnovo.applicata !== true) continue;
    provati += 1;
    if (v.price > nostroPrezzo + 1e-9) violazioni += 1;
  }
}
ok(`su ${provati} rinnovi esentati il prezzo restituito non supera mai il riferimento`, violazioni === 0, `${violazioni} violazioni`);

console.log(`\nrinnovo-sotto-il-pavimento: ${passati} passati, ${falliti} falliti`);
// ⚠ MUTAZIONI PROVATE UNA PER UNA, e dichiarate per come sono andate DAVVERO:
//   · `esente` forzata a false (il filo tagliato, cioe' il sorgente fino al 23 agosto)
//         ⇒ ROSSO, 3 asserzioni del blocco ②
//   · `rinnovo` non inoltrato a `trovaLivello`                    ⇒ ROSSO, stesse 3
//   · il ramo del prezzo di riferimento disattivato               ⇒ ROSSO, 3 asserzioni del blocco ②-bis
//
// ⚠ E UNA CHE NESSUNA ASSERZIONE PRENDE, detta invece che taciuta: spostare l'esenzione da «si
// ritenta solo se il pavimento pieno ha gia' rifiutato» a «si applica sempre» NON rende rosso niente,
// e non e' una lacuna del test — e' che, col ramo del prezzo di riferimento al suo posto, le due
// forme accettano esattamente le stesse configurazioni (con pavimento 0 il livello i=1 e' sempre
// ammesso dal pavimento: o passa il confronto sul prezzo, o innesca il ramo di riferimento).
// La forma «prima senza, poi con» resta perche' rende la monotonia una proprieta' STRUTTURALE —
// vera qualunque cosa faccia `trovaLivello` al suo interno, oggi e dopo la prossima modifica — invece
// che una conseguenza da ricontrollare. Il blocco ③ misura la proprieta', non la struttura.
process.exit(falliti === 0 ? 0 : 1);

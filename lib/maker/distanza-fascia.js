'use strict';
// lib/maker/distanza-fascia.js — LA DISTANZA DAL MID PER FASCIA DI SCADENZA. UN POSTO SOLO.
//
// ═══ LA REGOLA DELL'OPERATORE — 22 agosto 2026 ═══════════════════════════════════════════════════
// «Distanze diverse per fascia: i sotto-48h piu' lontani dal mid, gli altri invariati.»
// I lunghi restano a `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` (0,456 · v = **2,05¢** su banda 4,5¢), che
// questo modulo NON tocca in nessun ramo. I corti prendono una distanza in CENTESIMI.
//
// ═══ PERCHE' IN CENTESIMI E NON IN FRAZIONE DI BANDA ════════════════════════════════════════════
// Perche' l'operatore l'ha chiesta in centesimi, e perche' la ragione e' il RISCHIO DI FILL, non la
// forma della banda: un mercato che scade fra 30 ore si muove per notizie, e la distanza che protegge
// dall'essere riempiti e' un numero di centesimi, non una frazione di una banda che il venue sceglie
// per conto suo. Una frazione avrebbe dato 3,0¢ su banda 4,5¢ e 1,5¢ su banda 2,25¢ — cioe' meno
// protezione proprio dove la banda e' stretta.
//
// ═══⚠ IL TICK: 3,5¢ NON ESISTE SU 87 CORTI SU 91, E IL NUMERO E' 3,0 ═══════════════════════════
// Misurato sul board vivo del 22 agosto: dei sei corti ammissibili **cinque hanno tick 1¢**, e su una
// griglia da 1¢ il valore 3,5 non e' rappresentabile — atterra a 3 o a 4, mai a 3,5. Le due scelte
// reali sono state messe davanti all'operatore col loro costo, che e' il punteggio del venue
// `S = ((v − s)/v)²` sulla banda modale di 4,5¢:
//       3,0¢ → S = 0,111        4,0¢ → S = 0,0123        (nove volte)
// Decisione dell'operatore: **3,0¢**, il valido piu' interno. Il mercato con tick 0,001 (l'unico dei
// sei) ci atterra esatto come tutti gli altri: 3,0 sta sulla griglia da 0,1¢.
//
// ⚠ NON E' UN'APPROSSIMAZIONE SILENZIOSA: `distanzaCortiCents` restituisce il valore CHIESTO e chi lo
// applica (`planBehindBest` via `distanzaObiettivoFrazione`) lo snappa alla griglia con la stessa
// funzione di sempre. Qui si dichiara `atterraggio`, cioe' dove il valore chiesto cade davvero su
// QUESTA griglia, perche' il referto possa dirlo mercato per mercato invece di prometterlo.
//
// ═══ ⚠ RESTA DENTRO LA BANDA, SEMPRE, E FALLISCE CHIUSO ═════════════════════════════════════════
// Una distanza oltre il raggio della banda e' un ordine che non paga NIENTE (il punteggio e' zero
// fuori banda, non «meno»). Quindi il valore si CLAMPA al raggio e lo si dichiara. Banda illeggibile
// ⇒ **nessuna distanza di fascia**, cioe' il comportamento di prima: non si sposta un ordine reale
// piu' lontano dal mid sulla base di una banda che non si e' potuta leggere.
//
// ═══ ⚠ E NON PUO' MAI AVVICINARE AL MID ═════════════════════════════════════════════════════════
// Questo modulo produce un numero piu' GRANDE della distanza dei lunghi (3,0 > 2,05). Se un domani
// qualcuno scrivesse un valore piu' piccolo, l'effetto sarebbe portare i corti PIU' VICINI al mid —
// cioe' verso la cima del libro, che e' la posizione che «mai primo sul libro» esiste per vietare.
// Quel vincolo resta davanti e non passa di qui (`planBehindBest` applica la distanza-obiettivo con
// un `Math.min` sul prezzo che «mai primo» ha gia' scelto, §4.1), ma il pavimento si scrive lo stesso:
// una distanza di fascia SOTTO quella dei lunghi non e' una distanza di fascia, e si rifiuta.
//
// ═══ ⚠ COME ARRIVA AD AGENT40 SENZA RIAVVIARLO ═════════════════════════════════════════════════
// agent40 NON si riavvia (renderebbe PRE-ESISTENTI gli ordini veri, §4.14/CLAUDE.md). Quindi la
// distanza di fascia NON viaggia in un env di agent40 e NON viaggia nel suo codice: agent41 la
// materializza per-mercato in `data/maker-offsets.json` (`setMarketOffset`), che `resolveOffsetFor`
// rilegge **da disco a ogni ciclo**. Il TRIGGER 3 di `auto-reprice` trova `source:'configured'` e
// tiene l'ordine a 3,0¢ senza sapere niente delle fasce. E' lo stesso canale che il pannello usa da
// sempre — non un secondo meccanismo.

const SOGLIA_CORTI_ORE = 48;
const ENV_DISTANZA_CORTI = 'MAKER_DISTANZA_CORTI_CENTS';
// ⚠ IL DIFETTO E' `null`, CIOE' REGOLA SPENTA — non 3,0. Un modulo nuovo che entra in servizio non
// deve cambiare da solo il prezzo di un ordine reale: ad accendere la fascia e' una riga
// nell'ecosystem piu' un riavvio DAL FILE, e finche' non c'e' i corti sono quotati come i lunghi.
const DISTANZA_CORTI_DI_DIFETTO = null;
// Il tetto: oltre, il numero non e' una distanza, e' un errore di battitura che porterebbe l'ordine
// al bordo di qualunque banda. Il clamp sul raggio VERO lo fa `distanzaCortiCents`; questo ferma
// il caso «qualcuno ha scritto 350 intendendo 3,50».
const DISTANZA_CORTI_MASSIMA_CENTS = 20;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** La distanza di fascia chiesta dall'ambiente, senza ancora conoscere il mercato.
 *  @returns {{cents:(number|null), fonte:'ambiente'|'difetto', grezzo:(string|null), motivo:string}} */
function leggiDistanzaCorti(env = process.env) {
  const grezzoRaw = env ? env[ENV_DISTANZA_CORTI] : undefined;
  const grezzo = (grezzoRaw === undefined || grezzoRaw === null) ? null : String(grezzoRaw).trim();
  if (grezzo === null || grezzo === '') {
    return { cents: DISTANZA_CORTI_DI_DIFETTO, fonte: 'difetto', grezzo: null,
      motivo: `${ENV_DISTANZA_CORTI} non dichiarata: i corti sono quotati alla distanza dei lunghi, come prima` };
  }
  const n = Number(grezzo);
  if (!fin(n) || n <= 0 || n > DISTANZA_CORTI_MASSIMA_CENTS) {
    return { cents: DISTANZA_CORTI_DI_DIFETTO, fonte: 'difetto', grezzo,
      motivo: `${ENV_DISTANZA_CORTI}="${grezzo}" non e' un numero fra 0 (escluso) e ${DISTANZA_CORTI_MASSIMA_CENTS}¢:`
        + ' regola SPENTA — una distanza che non si capisce non puo\' spostare un ordine reale' };
  }
  return { cents: n, fonte: 'ambiente', grezzo,
    motivo: `${ENV_DISTANZA_CORTI}=${n}¢ sui mercati che scadono entro ${SOGLIA_CORTI_ORE} h` };
}

/**
 * LA DISTANZA DA APPLICARE A QUESTO MERCATO, in centesimi, e dove atterra sulla sua griglia.
 *
 * @param a.oreAllaScadenza  ore che mancano; `null` ⇒ fascia ignota ⇒ NESSUNA distanza di fascia
 * @param a.bandRadiusCents  il raggio `v` della banda premiante di questo mercato
 * @param a.tick             il tick del venue, per dire dove il valore atterra davvero
 * @param a.distanzaLunghiCents  la distanza dei lunghi, per il pavimento «mai piu' vicina al mid»
 * @returns {{applica:boolean, cents:(number|null), frazioneV:(number|null), atterraggio:(number|null),
 *            atterraEsatto:(boolean|null), clampataAllaBanda:boolean, motivo:string}}
 */
function distanzaPerMercato({ oreAllaScadenza = null, bandRadiusCents = null, tick = null,
  distanzaLunghiCents = null, env = process.env } = {}) {
  const no = (motivo) => ({ applica: false, cents: null, frazioneV: null, atterraggio: null,
    atterraEsatto: null, clampataAllaBanda: false, motivo });

  const cfg = leggiDistanzaCorti(env);
  if (cfg.cents === null) return no(cfg.motivo);
  // ⚠ FASCIA IGNOTA ⇒ NIENTE. «Non ho letto la scadenza» non e' «e' lunga» e non e' «e' corta».
  if (!fin(oreAllaScadenza)) return no('scadenza non determinabile: nessuna distanza di fascia (non si sposta un ordine su una fascia che non si sa)');
  if (oreAllaScadenza > SOGLIA_CORTI_ORE) return no(`scade fra ${oreAllaScadenza.toFixed(1)} h, oltre le ${SOGLIA_CORTI_ORE}: fascia lunga, distanza invariata`);
  // ⚠ BANDA ILLEGGIBILE ⇒ NIENTE, mai un ripiego: senza raggio non si puo' garantire «dentro banda».
  if (!fin(bandRadiusCents) || bandRadiusCents <= 0) return no('raggio della banda non leggibile: nessuna distanza di fascia');

  // ⚠ NON PUO' MAI AVVICINARE AL MID. Vedi l'intestazione: una distanza di fascia piu' stretta di
  // quella dei lunghi porterebbe i corti verso la cima del libro, ed e' l'unico verso in cui questo
  // modulo potrebbe fare danno. Si rifiuta invece di applicarla.
  if (fin(distanzaLunghiCents) && cfg.cents < distanzaLunghiCents) {
    return no(`${cfg.cents}¢ sarebbe PIU' VICINA al mid della distanza dei lunghi (${distanzaLunghiCents}¢):`
      + ' non applicata — la fascia corta esiste per stare piu' + "'" + ' lontano, non piu' + "'" + ' vicino');
  }

  // ⚠ IL CLAMP AL RAGGIO: oltre la banda il punteggio e' ZERO, non «meno». Si dichiara.
  const clampata = cfg.cents > bandRadiusCents;
  const cents = clampata ? bandRadiusCents : cfg.cents;
  // ⚠⚠ E IL CLAMP VA RICONTROLLATO CONTRO IL PAVIMENTO, o la protezione di sopra si scavalca da sola.
  // TROVATO DAL BLOCCO ④ DEL TEST, non dalla rilettura: su una banda piu' stretta della distanza dei
  // lunghi (v = 0,5¢ contro 2,05¢) il clamp riporta la distanza di fascia a 0,5¢, che e' PIU' VICINA
  // al mid di quella dei lunghi — cioe' esattamente il verso che il controllo qui sopra esiste per
  // vietare, ottenuto passando dal ramo che lo segue. E' la classe «protezione presente su un
  // percorso e assente sul gemello», la piu' ricorrente di questo repo.
  // La risposta e' non applicare: su una banda cosi' stretta la fascia non ha niente da aggiungere, e
  // il mercato torna alla strada di sempre, che quella banda la sa gia' gestire.
  if (fin(distanzaLunghiCents) && cents < distanzaLunghiCents) {
    return no(`la banda (raggio ${bandRadiusCents}¢) e' piu' stretta della distanza dei lunghi`
      + ` (${distanzaLunghiCents}¢): clampare ${cfg.cents}¢ a ${cents}¢ porterebbe il corto PIU' VICINO`
      + ' al mid dei lunghi — non applicata, il mercato resta sulla strada di sempre');
  }
  // Dove atterra davvero su QUESTA griglia. Non si arrotonda qui — lo fa `planBehindBest` con la sua
  // `snap` di sempre — si DICHIARA, perche' il referto possa dirlo invece di prometterlo.
  const tickC = fin(tick) && tick > 0 ? tick * 100 : null;
  const atterraggio = tickC ? +(Math.round(cents / tickC) * tickC).toFixed(4) : null;
  const atterraEsatto = atterraggio === null ? null : Math.abs(atterraggio - cents) < 1e-9;
  return {
    applica: true, cents, frazioneV: +(cents / bandRadiusCents).toFixed(6),
    atterraggio, atterraEsatto, clampataAllaBanda: clampata,
    motivo: `fascia corta (${oreAllaScadenza.toFixed(1)} h ≤ ${SOGLIA_CORTI_ORE}): ${cents}¢ dal mid`
      + (clampata ? ` — CLAMPATA al raggio della banda (${bandRadiusCents}¢): oltre, il punteggio e' zero` : '')
      + (atterraggio !== null && !atterraEsatto
        ? ` · ⚠ su tick ${tickC}¢ atterra a ${atterraggio}¢, non a ${cents}¢` : ''),
  };
}

/** Prove interne. Girano con `node lib/maker/distanza-fascia.js`. */
function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
  const E3 = { [ENV_DISTANZA_CORTI]: '3.0' };

  ok('env assente ⇒ regola SPENTA, non 3', leggiDistanzaCorti({}).cents === null);
  ok('  "3.0" ⇒ 3', leggiDistanzaCorti(E3).cents === 3);
  for (const v of ['0', '-1', '350', 'tre', '', 'NaN', 'Infinity']) {
    ok(`  "${v}" ⇒ SPENTA`, leggiDistanzaCorti({ [ENV_DISTANZA_CORTI]: v }).cents === null);
  }
  ok('  null ⇒ SPENTA, non zero', leggiDistanzaCorti({ [ENV_DISTANZA_CORTI]: null }).cents === null);

  const corto = { oreAllaScadenza: 33.3, bandRadiusCents: 4.5, tick: 0.01, distanzaLunghiCents: 2.052, env: E3 };
  ok('un corto a 33 h ⇒ 3¢', distanzaPerMercato(corto).applica === true && distanzaPerMercato(corto).cents === 3);
  ok('  e su tick 1¢ atterra ESATTO a 3', distanzaPerMercato(corto).atterraEsatto === true
    && distanzaPerMercato(corto).atterraggio === 3);
  ok('  la frazione di banda e\' derivata, non scritta', distanzaPerMercato(corto).frazioneV === +(3 / 4.5).toFixed(6));
  ok('un LUNGO non e\' toccato', distanzaPerMercato({ ...corto, oreAllaScadenza: 49 }).applica === false);
  ok('  esattamente a 48 h e\' ancora corto', distanzaPerMercato({ ...corto, oreAllaScadenza: 48 }).applica === true);
  ok('scadenza null ⇒ NIENTE (non e\' «corto»)', distanzaPerMercato({ ...corto, oreAllaScadenza: null }).applica === false);
  ok('banda illeggibile ⇒ NIENTE', distanzaPerMercato({ ...corto, bandRadiusCents: null }).applica === false);
  ok('env spento ⇒ NIENTE anche su un corto', distanzaPerMercato({ ...corto, env: {} }).applica === false);

  // ⚠ IL CLAMP ALLA BANDA, e si dichiara.
  const stretto = distanzaPerMercato({ ...corto, bandRadiusCents: 2.25 });
  ok('banda 2,25¢ ⇒ clampata a 2,25 e DICHIARATA',
    stretto.cents === 2.25 && stretto.clampataAllaBanda === true);
  ok('  e non esce mai dalla banda, per nessun raggio', [0.5, 1, 2.25, 3, 4.5, 10]
    .every((v) => { const r = distanzaPerMercato({ ...corto, bandRadiusCents: v }); return !r.applica || r.cents <= v + 1e-9; }));

  // ⚠ NON PUO' MAI AVVICINARE AL MID.
  ok('una distanza SOTTO quella dei lunghi si RIFIUTA',
    distanzaPerMercato({ ...corto, env: { [ENV_DISTANZA_CORTI]: '1.0' } }).applica === false);
  ok('  e a parita\' passa', distanzaPerMercato({ ...corto, env: { [ENV_DISTANZA_CORTI]: '2.052' } }).applica === true);

  // ⚠ L'ATTERRAGGIO SI DICHIARA, non si promette: 3,5 su tick 1¢ NON atterra a 3,5.
  const r35 = distanzaPerMercato({ ...corto, env: { [ENV_DISTANZA_CORTI]: '3.5' } });
  ok('3,5¢ su tick 1¢ ⇒ atterra a 4 e lo DICHIARA',
    r35.atterraEsatto === false && r35.atterraggio === 4, JSON.stringify(r35));
  ok('  3,5¢ su tick 0,1¢ ⇒ atterra ESATTO',
    distanzaPerMercato({ ...corto, tick: 0.001, env: { [ENV_DISTANZA_CORTI]: '3.5' } }).atterraEsatto === true);

  console.log(`\ndistanza per fascia: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { SOGLIA_CORTI_ORE, ENV_DISTANZA_CORTI, DISTANZA_CORTI_DI_DIFETTO,
  DISTANZA_CORTI_MASSIMA_CENTS, leggiDistanzaCorti, distanzaPerMercato, selfcheck };

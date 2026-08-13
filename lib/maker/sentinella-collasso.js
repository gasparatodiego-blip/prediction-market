'use strict';

/**
 * LA SENTINELLA SUL COLLASSO DELLA COPERTURA — CLAUDE.md §5.2 punto 9.
 *
 * ═══ IL BUCO CHE CHIUDE ═════════════════════════════════════════════════════════════════════════
 * `sentinella-vuoto` guarda il caso ESTREMO: zero ordini a riposo. Il suo ramo ③ dice
 * «`ordiniARiposo > 0` ⇒ il libro non è vuoto» e azzera l'orologio — quindi un calo da **23 ordini a
 * 2**, cioè il **91%**, è invisibile. È tarata sul livello, non sulla derivata.
 *
 * ═══ LA FORMA, E PERCHÉ NON È LA DIFFERENZA FRA CAMPIONI CONSECUTIVI ════════════════════════════
 * Si misura il **calo percentuale rispetto al MASSIMO delle ultime 10 minuti**. Due ragioni misurate:
 *   · la cadenza del campionamento è IRREGOLARE — mediana 60,0 s, q99 65,3 s, massimo 77,2 s su 7.859
 *     intervalli — quindi la differenza fra due campioni consecutivi mescola «quanto è cambiato» con
 *     «quanto tempo è passato», e la stessa variazione significa cose diverse;
 *   · un crollo che arriva in due campioni verrebbe **spezzato in due pezzi** ciascuno sotto soglia.
 * Il calo dal massimo recente è invariante rispetto al campionamento e non si lascia spezzare.
 *
 * ═══ PERCHÉ 85, CON LA TABELLA CHE L'HA DECISO ═════════════════════════════════════════════════
 * Sensibilità misurata su 4,1 giorni e 7.860 campioni (veri positivi = l'episodio contiene uno scatto
 * del guardiano ±15 min, oppure il livello resta ≤ 2 ordini per ≥ 30 min):
 *
 *     soglia   episodi   veri   FALSI   precisione
 *       30%      188       5     183       3%
 *       40%       74       5      69       7%
 *       50%       25       5      20      20%     ← la soglia "a occhio" costerebbe 5 falsi al giorno
 *       60%        9       5       4      56%
 *       70%        7       5       2      71%
 *       80%        5       5       0     100%
 *
 * **Si sceglie 85 e non 80 perché il divario fra le due popolazioni è VUOTO**: il calo fisiologico più
 * grande misurato è **75%** (30 → 8 il 13/08 08:31, rientrato da solo in 9,5 minuti; e 28 → 7 il 13/08
 * 00:48), il calo patologico più piccolo è **92,9%** (28 → 2, lo scatto del guardiano). Fra 75% e 92,9%
 * **non cade nessun episodio**, quindi 85 è il punto medio del vuoto — la scelta più robusta a piccole
 * variazioni future. A 80 la precisione è già 100%, ma il margine verso il fisiologico è di 5 punti.
 *
 * ⚠ LIMITE DICHIARATO: **5 soli eventi positivi in 4,1 giorni**. La soglia è difendibile sui dati che
 * ci sono, ma il campione è piccolo. È anche il motivo per cui questo presidio, in questa fase, **SOLO
 * OSSERVA**: non ferma il bot, non cancella niente, non tocca AVVIA/FERMA.
 *
 * ═══ LA PARTE DELICATA: NON DEVE INGANNARE SE STESSO ═══════════════════════════════════════════
 * Il collasso più grande che i dati contengono — 23 → 2 il 13 agosto — **l'ha prodotto il guardiano**,
 * cancellando 23 ordini su 12 mercati. Un presidio che gridasse su quello starebbe segnalando come
 * anomalia l'azione di un'altra difesa che ha funzionato: rumore, non informazione.
 * La distinzione si fa in modo VERIFICABILE, non per indizi: si guarda il timestamp dello scatto nel
 * latch del guardiano (`data/guardian-state.json`, campo `at`), che è il guardiano stesso a scrivere.
 * Se lo scatto cade nei **15 minuti** precedenti, il calo è SPIEGATO e non si arma.
 * ⚠ E se il timestamp non si legge, **non si arma lo stesso**: un calo che non si sa spiegare non
 * diventa un'anomalia solo perché manca il dato che lo spiegherebbe. È la direzione prudente per un
 * presidio che oggi non agisce — meglio muto che bugiardo.
 *
 * Modulo PURO: nessun `require` di rete, di venue o di disco. Riceve i fatti, restituisce un verdetto.
 */

const fin = (v) => Number.isFinite(v);

/** Il calo, in percentuale del massimo recente, oltre il quale si grida. Vedi la tabella sopra. */
const SOGLIA_CALO_PCT = 85;

/** La finestra su cui si prende il massimo. Dieci minuti: dieci volte la cadenza tipica di 60 s. */
const FINESTRA_MASSIMO_MS = 10 * 60_000;

/** Quanto a lungo uno scatto del guardiano SPIEGA un calo. */
const GRAZIA_GUARDIANO_MS = 15 * 60_000;

/**
 * Sotto questo livello di partenza il calo percentuale non significa niente: da 2 ordini a 0 è un
 * −100% che descrive due cancellazioni ordinarie. La soglia non è una taratura fine — la tabella di
 * sensibilità mostra che il livello minimo NON è la dimensione che discrimina (precisione 20-22% per
 * ogni valore fra 3 e 12 a calo 50%) — serve solo a togliere l'aritmetica degenere dei numeri piccoli.
 */
const LIVELLO_MINIMO = 5;

/**
 * Aggiorna lo storico e valuta il collasso.
 *
 * @param a.storico            campioni `{ts, n}` dei giri precedenti (li tiene il chiamante)
 * @param a.ordiniARiposo      il conteggio di ADESSO; `null` ⇒ non leggibile
 * @param a.guardianScattatoAt timestamp dello scatto del guardiano, o `null` se non è scattato
 * @param a.botAvviato         `false` ⇒ il calo è atteso
 * @param a.killAttivo         `true`  ⇒ il calo è atteso
 * @returns {{storico:Array, anomalia:boolean, caloPct:number|null, massimo:number|null,
 *            sospeso:boolean, motivo:string}}
 */
function valutaCollasso({
  storico = null, ordiniARiposo = null, now = Date.now(), guardianScattatoAt = null,
  botAvviato = false, killAttivo = false,
  sogliaCaloPct = SOGLIA_CALO_PCT, finestraMs = FINESTRA_MASSIMO_MS,
  graziaGuardianoMs = GRAZIA_GUARDIANO_MS, livelloMinimo = LIVELLO_MINIMO,
} = {}) {
  const prec = Array.isArray(storico) ? storico : [];
  const fermo = (motivo, extra = {}) => ({
    storico: prec.filter((s) => s && fin(s.ts) && now - s.ts <= finestraMs),
    anomalia: false, caloPct: null, massimo: null, sospeso: false, motivo, ...extra,
  });

  // ① Conteggio illeggibile ⇒ non si aggiunge un campione inventato e non si giudica. Uno zero di
  //    ripiego qui sarebbe un −100% istantaneo, cioè l'allarme più forte possibile prodotto da un 429.
  if (!fin(ordiniARiposo) || ordiniARiposo < 0) {
    return fermo('conteggio degli ordini non leggibile: non si campiona e non si giudica');
  }

  // Lo storico si aggiorna SEMPRE, anche quando non si giudica: serve a tenere il massimo mobile.
  const st = [...prec.filter((s) => s && fin(s.ts) && now - s.ts <= finestraMs), { ts: now, n: ordiniARiposo }];
  const dopo = (motivo, extra = {}) => ({ storico: st, anomalia: false, caloPct: null, massimo: null, sospeso: false, motivo, ...extra });

  // ② Il bot non deve lavorare ⇒ il calo è lo stato giusto.
  if (killAttivo === true || botAvviato !== true) {
    return dopo(killAttivo === true ? 'KILL attivo: il calo della copertura è atteso' : 'bot su FERMA: il calo della copertura è atteso');
  }

  // ③ Il massimo delle ultime 10 minuti, ESCLUSO il campione di adesso (che è il livello dopo il calo).
  const passati = st.filter((s) => s.ts < now);
  if (!passati.length) return dopo('primo campione della finestra: non c\'è ancora un massimo con cui confrontarsi');
  const massimo = Math.max(...passati.map((s) => s.n));
  if (massimo < livelloMinimo) {
    return dopo(`massimo recente ${massimo} sotto il livello minimo ${livelloMinimo}: il calo percentuale non è significativo`, { massimo });
  }

  const caloPct = +(((massimo - ordiniARiposo) / massimo) * 100).toFixed(2);
  if (caloPct < sogliaCaloPct) {
    return dopo(`copertura ${ordiniARiposo} contro un massimo recente di ${massimo}: calo ${caloPct}%, sotto la soglia del ${sogliaCaloPct}%`,
      { caloPct, massimo });
  }

  // ④ IL CALO C'È. È SPIEGATO DAL GUARDIANO? Il timestamp lo scrive il guardiano stesso.
  const gAt = Number(guardianScattatoAt);
  if (fin(gAt) && now - gAt >= 0 && now - gAt <= graziaGuardianoMs) {
    return {
      storico: st, anomalia: false, caloPct, massimo, sospeso: true,
      motivo: `calo del ${caloPct}% (da ${massimo} a ${ordiniARiposo}) SPIEGATO dallo scatto del guardiano di `
        + `${((now - gAt) / 60000).toFixed(1)} minuti fa: non è un'anomalia, è un'altra difesa che ha agito`,
    };
  }

  return {
    storico: st, anomalia: true, caloPct, massimo, sospeso: false,
    motivo: `COLLASSO DELLA COPERTURA: da ${massimo} a ${ordiniARiposo} ordini a riposo in meno di `
      + `${finestraMs / 60000} minuti, cioè −${caloPct}% (soglia ${sogliaCaloPct}%), con KILL spento e bot AVVIATO`
      + ' — e nessuno scatto del guardiano a spiegarlo',
  };
}

/** Prove interne. `node lib/maker/sentinella-collasso.js` */
function selfcheck() {
  const esiti = [];
  const A = (nome, cond) => esiti.push({ nome, ok: !!cond });
  const T = 1_000_000_000;
  const base = { botAvviato: true, killAttivo: false, guardianScattatoAt: null };
  // Costruisce uno storico stabile a `n` per `quanti` campioni a 60 s.
  const storicoA = (n, quanti, fineTs) => Array.from({ length: quanti },
    (_, i) => ({ ts: fineTs - (quanti - i) * 60_000, n }));

  // ── IL CASO REALE: 23 → 2 è il 91,3%, sopra soglia ────────────────────────────────────────────
  const r = valutaCollasso({ ...base, storico: storicoA(23, 5, T), ordiniARiposo: 2, now: T });
  A('23 → 2 è un collasso', r.anomalia === true && r.caloPct > 85);

  // ── IL CASO FISIOLOGICO PIÙ GRANDE MISURATO: 30 → 8 è il 73,3%, sotto soglia ──────────────────
  const f = valutaCollasso({ ...base, storico: storicoA(30, 5, T), ordiniARiposo: 8, now: T });
  A('30 → 8 (il più grande calo fisiologico misurato) NON è un collasso', f.anomalia === false);
  const f2 = valutaCollasso({ ...base, storico: storicoA(28, 5, T), ordiniARiposo: 7, now: T });
  A('28 → 7 NON è un collasso', f2.anomalia === false);

  // ── IL VUOTO FRA LE DUE POPOLAZIONI: la soglia sta in mezzo e non tocca né l'uno né l'altro ────
  A('il calo fisiologico massimo (75%) resta sotto la soglia', 75 < SOGLIA_CALO_PCT);
  A('il calo patologico minimo (92,9%) resta sopra la soglia', 92.9 > SOGLIA_CALO_PCT);

  // ── LO SCATTO DEL GUARDIANO SOSPENDE, NON ARMA ────────────────────────────────────────────────
  const g = valutaCollasso({ ...base, storico: storicoA(23, 5, T), ordiniARiposo: 2, now: T,
    guardianScattatoAt: T - 60_000 });
  A('un calo spiegato dal guardiano NON è un\'anomalia', g.anomalia === false && g.sospeso === true);
  A('  ma il calo viene comunque misurato e dichiarato', g.caloPct > 85);
  const g2 = valutaCollasso({ ...base, storico: storicoA(23, 5, T), ordiniARiposo: 2, now: T,
    guardianScattatoAt: T - 20 * 60_000 });
  A('uno scatto di 20 minuti fa NON spiega più il calo', g2.anomalia === true);

  // ── IL DATO CHE NON SI LEGGE NON GRIDA ────────────────────────────────────────────────────────
  for (const v of [null, undefined, NaN, -3, 'sei']) {
    const x = valutaCollasso({ ...base, storico: storicoA(23, 5, T), ordiniARiposo: v, now: T });
    A(`conteggio «${String(v)}» non arma`, x.anomalia === false);
  }

  // ── BOT FERMO O KILL ATTIVO: il calo è atteso ─────────────────────────────────────────────────
  A('bot su FERMA non arma', valutaCollasso({ storico: storicoA(23, 5, T), ordiniARiposo: 0, now: T,
    botAvviato: false, killAttivo: false }).anomalia === false);
  A('KILL attivo non arma', valutaCollasso({ storico: storicoA(23, 5, T), ordiniARiposo: 0, now: T,
    botAvviato: true, killAttivo: true }).anomalia === false);

  // ── NUMERI PICCOLI: 2 → 0 è un −100% che non significa niente ─────────────────────────────────
  A('da 2 a 0 non è un collasso', valutaCollasso({ ...base, storico: storicoA(2, 5, T), ordiniARiposo: 0, now: T }).anomalia === false);

  // ── LA FINESTRA SI SVUOTA: campioni più vecchi di 10 minuti non fanno più massimo ─────────────
  const vecchio = valutaCollasso({ ...base, storico: [{ ts: T - 20 * 60_000, n: 30 }], ordiniARiposo: 2, now: T });
  A('un massimo di 20 minuti fa è fuori finestra e non arma', vecchio.anomalia === false);

  // ── IL CROLLO IN DUE CAMPIONI NON SI LASCIA SPEZZARE ──────────────────────────────────────────
  // 28 → 15 → 2: nessuno dei due passi è −85%, ma il calo dal massimo sì. È il motivo della forma.
  let s = storicoA(28, 5, T - 120_000);
  const p1 = valutaCollasso({ ...base, storico: s, ordiniARiposo: 15, now: T - 60_000 });
  const p2 = valutaCollasso({ ...base, storico: p1.storico, ordiniARiposo: 2, now: T });
  A('un crollo in due campioni viene comunque visto', p1.anomalia === false && p2.anomalia === true);

  const rossi = esiti.filter((e) => !e.ok);
  for (const e of esiti) console.log(`${e.ok ? '  ok' : 'FAIL'}  ${e.nome}`);
  console.log(`\n${esiti.length - rossi.length}/${esiti.length} verdi`);
  return rossi.length === 0;
}

module.exports = {
  valutaCollasso, selfcheck,
  SOGLIA_CALO_PCT, FINESTRA_MASSIMO_MS, GRAZIA_GUARDIANO_MS, LIVELLO_MINIMO,
};

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

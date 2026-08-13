'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  LA SENTINELLA SUL VUOTO — zero ordini a riposo è un'ANOMALIA, non uno stato
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL FATTO CHE L'HA MOTIVATA, con i numeri. Il 13 agosto 2026, fra le 02:53 e le 05:56, il bot ha
 * avuto **zero ordini a riposo per 180 minuti** con KILL spento, AVVIA acceso, freno disinserito e
 * $609,10 completamente liquidi. Nessun processo era caduto, nessun log riportava un errore, e il
 * mini-ciclo girava regolarmente ogni dieci minuti dichiarando «nessuna azione». Il sistema aveva
 * tutte le informazioni per sapere di essere fermo e **nessun meccanismo il cui mestiere fosse
 * accorgersene**: ogni componente rispondeva correttamente alla propria domanda, e la domanda «da
 * quanto tempo non abbiamo un solo ordine sul libro?» non era di nessuno.
 *
 * ═══ COSA FA, E COSA NON FA ════════════════════════════════════════════════════════════════════════
 * FA: tiene l'istante in cui il libro si è svuotato, e quando il vuoto supera `SOGLIA_MS` **mentre il
 * bot dovrebbe lavorare** dichiara un'anomalia, ne scrive la ripartizione in dollari e chiede una
 * ricostruzione del piano.
 * NON FA: non piazza, non cancella, non tocca nessun tetto e non allenta nessun cancello. La sua unica
 * azione è **chiedere a chi piazza di riprovare adesso invece che fra dieci minuti**. Un modulo che
 * reagisce a un'emergenza allentando una regola trasformerebbe un capitale fermo in una perdita.
 *
 * ═══ PERCHÉ 5 MINUTI ═══════════════════════════════════════════════════════════════════════════════
 * Il vuoto non è mai legittimo a lungo: gli ordini vivono in finestre GTD da ~23 minuti e vengono
 * rinnovati a 180 s dalla scadenza, quindi un libro sano non è mai completamente vuoto se non per i
 * pochi secondi fra una cancellazione e il suo rimpiazzo. Cinque minuti sono **oltre dieci volte**
 * quella finestra fisiologica e restano ben sotto una singola finestra GTD: un vuoto di cinque minuti
 * non è un ricambio, è un blocco. La rilevazione gira sulla cadenza da 120 s del trigger, quindi il
 * ritardo massimo di scoperta è 5 + 2 = **7 minuti** contro i 180 di stanotte.
 *
 * ⚠ ZERO NON È «NON HO LETTO». Un conteggio non leggibile **non arma la sentinella e non la disarma**:
 * congela lo stato e lo dichiara. Trattare una lettura fallita come «zero ordini» produrrebbe un
 * allarme grave ogni volta che il venue singhiozza — e un allarme che grida al primo 429 smette di
 * essere letto, che è il modo in cui un presidio muore.
 *
 * ⚠ E IL VUOTO A BOT FERMO NON È UN'ANOMALIA. Con KILL attivo o AVVIA spento zero ordini è lo stato
 * CORRETTO: la sentinella si disarma e dichiara perché. Altrimenti ogni notte in cui l'operatore ferma
 * il bot produrrebbe un allarme grave, cioè rumore su una riga che deve significare una cosa sola.
 *
 * Modulo PURO: nessun `require` di rete, di venue o di disco. Riceve i fatti e restituisce un verdetto;
 * chi lo chiama decide cosa farci. È la stessa forma di `utilizzo-capitale` e `capitale-al-lavoro`,
 * e per la stessa ragione: un presidio si prova senza allestire un mondo.
 */

const fin = (v) => Number.isFinite(v);

/** Cinque minuti. Si cambia con `MAKER_SENTINELLA_VUOTO_MS`; fuori da [60 s, 60 min] è scartato in
 *  favore del difetto — un valore assurdo non deve poter spegnere un presidio. */
const SOGLIA_MS = (() => {
  const v = Number(process.env.MAKER_SENTINELLA_VUOTO_MS);
  if (Number.isFinite(v) && v >= 60_000 && v <= 3_600_000) return Math.floor(v);
  return 5 * 60_000;
})();

/**
 * Valuta il vuoto.
 *
 * @param stato            lo stato precedente (`null` al primo giro): `{ vuotoDa, allarmato }`
 * @param ordiniARiposo    quanti ordini a riposo ci sono adesso; `null` ⇒ non leggibile
 * @param killAttivo       `true` ⇒ il vuoto è corretto
 * @param botAvviato       `false` ⇒ il vuoto è corretto
 * @param sogliaMs         override, per i test
 * @param now              istante, iniettabile
 * @returns {{stato:object, anomalia:boolean, nuova:boolean, vuotoMs:number|null, motivo:string,
 *            deveRicostruire:boolean}}
 */
function valutaVuoto({
  stato = null, ordiniARiposo = null, killAttivo = false, botAvviato = false,
  sogliaMs = SOGLIA_MS, now = Date.now(),
} = {}) {
  const prec = stato && typeof stato === 'object' ? stato : { vuotoDa: null, allarmato: false };
  const fermo = (dec, motivo) => ({ stato: dec, anomalia: false, nuova: false, vuotoMs: null, motivo, deveRicostruire: false });

  // ① Il conteggio non si legge ⇒ si congela. Non si arma su un'incognita e non si disarma su
  //    un'incognita: la lettura di adesso non dice niente, quindi non cambia niente.
  if (!fin(ordiniARiposo) || ordiniARiposo < 0) {
    return fermo(prec, 'ordini a riposo non leggibili: la sentinella non si arma e non si disarma su un dato che non c\'è');
  }

  // ② Il bot non deve lavorare ⇒ il vuoto è lo stato giusto e l'orologio si azzera.
  if (killAttivo === true || botAvviato !== true) {
    return fermo({ vuotoDa: null, allarmato: false },
      killAttivo === true ? 'KILL attivo: zero ordini a riposo è lo stato corretto' : 'bot su FERMA: zero ordini a riposo è lo stato corretto');
  }

  // ③ C'è almeno un ordine ⇒ non c'è vuoto. L'orologio si azzera, e se era scattato lo si dice.
  if (ordiniARiposo > 0) {
    return { stato: { vuotoDa: null, allarmato: false }, anomalia: false, nuova: false, vuotoMs: null,
      motivo: `${ordiniARiposo} ordine/i a riposo: il libro non è vuoto`, deveRicostruire: false,
      rientrato: prec.allarmato === true };
  }

  // ④ Vuoto, e il bot dovrebbe lavorare. Da quanto?
  const vuotoDa = fin(prec.vuotoDa) ? prec.vuotoDa : now;
  const vuotoMs = now - vuotoDa;
  if (vuotoMs < sogliaMs) {
    return { stato: { vuotoDa, allarmato: false }, anomalia: false, nuova: false, vuotoMs,
      motivo: `libro vuoto da ${Math.round(vuotoMs / 1000)}s, sotto la soglia di ${Math.round(sogliaMs / 1000)}s`,
      deveRicostruire: false };
  }

  // ⑤ Oltre soglia. `nuova` distingue il primo scatto dai successivi: l'allarme si SCRIVE una volta per
  //    episodio (altrimenti tre ore di vuoto sono 90 righe identiche e nessuno le legge), ma la
  //    RICOSTRUZIONE si chiede a ogni giro finché il vuoto dura — perché è l'azione che lo risolve, e
  //    smettere di provarla dopo il primo tentativo fallito riprodurrebbe esattamente il blocco.
  return {
    stato: { vuotoDa, allarmato: true },
    anomalia: true,
    nuova: prec.allarmato !== true,
    vuotoMs,
    motivo: `ZERO ordini a riposo da ${Math.round(vuotoMs / 60000)} minuti con KILL spento e bot AVVIATO`,
    deveRicostruire: true,
  };
}

/**
 * LA RIGA D'ALLARME, con la ripartizione in dollari.
 *
 * «Il bot è fermo» non è azionabile; «$609,10 fermi, di cui $X perché nessuna riga del piano ha spazio»
 * lo è. La ripartizione la produce `capitale-al-lavoro`, che è già la funzione che risponde a questa
 * domanda: qui non si ricalcola niente, si formatta. Se manca, si dice che manca invece di inventare
 * uno zero — la stessa regola del `coperturaFrazione` della stima.
 */
function rigaAllarme({ vuotoMs = null, capitale = null, ripartizione = null } = {}) {
  const min = fin(vuotoMs) ? Math.round(vuotoMs / 60000) : '?';
  const testa = `🔴 VUOTO: ZERO ordini a riposo da ${min} minuti — KILL spento, bot AVVIATO`;
  if (!capitale || capitale.leggibile !== true) {
    return `${testa} · ripartizione del fermo NON disponibile (${(capitale && capitale.motivo) || 'nessuna misura del capitale al lavoro'})`;
  }
  // La ripartizione NON viene riformattata qui: `ripartizioneFermo` produce già la sua riga, e
  // riscriverla vorrebbe dire due formati per lo stesso numero — cioè due verità da tenere allineate.
  const dett = ripartizione && typeof ripartizione.riga === 'string' && ripartizione.riga
    ? ripartizione.riga
    : 'ripartizione non calcolata';
  return `${testa} · al lavoro $${Number(capitale.alLavoroUsd || 0).toFixed(2)} su $${Number(capitale.totaleUsd || 0).toFixed(2)}`
    + ` (${capitale.pct}%, obiettivo ${capitale.obiettivoPct}%) · ${dett}`;
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (nome, cond) => { if (cond) p += 1; else { f += 1; console.error('  ✗', nome); } };
  const T0 = 1_000_000_000_000;

  // Il caso vero del 13 agosto: vuoto che cresce oltre soglia con bot attivo.
  let s = valutaVuoto({ stato: null, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T0 });
  ok('primo giro di vuoto: arma senza allarmare', s.anomalia === false && s.stato.vuotoDa === T0);
  s = valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T0 + 4 * 60_000 });
  ok('a 4 minuti non è ancora anomalia', s.anomalia === false && s.deveRicostruire === false);
  s = valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T0 + 6 * 60_000 });
  ok('a 6 minuti è anomalia NUOVA e chiede la ricostruzione', s.anomalia === true && s.nuova === true && s.deveRicostruire === true);
  const s2 = valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T0 + 8 * 60_000 });
  ok('al giro dopo l\'allarme non è più nuovo ma la ricostruzione si richiede', s2.anomalia === true && s2.nuova === false && s2.deveRicostruire === true);

  // I tre modi di NON essere un'anomalia.
  ok('kill attivo: nessuna anomalia e orologio azzerato',
    valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: true, botAvviato: true, now: T0 + 9 * 60_000 }).anomalia === false);
  ok('bot fermo: nessuna anomalia',
    valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: false, botAvviato: false, now: T0 + 9 * 60_000 }).anomalia === false);
  const rientro = valutaVuoto({ stato: s.stato, ordiniARiposo: 3, killAttivo: false, botAvviato: true, now: T0 + 9 * 60_000 });
  ok('ordini presenti: nessuna anomalia, e il rientro è dichiarato', rientro.anomalia === false && rientro.rientrato === true);

  // Il dato mancante non arma e non disarma.
  const congelato = valutaVuoto({ stato: s.stato, ordiniARiposo: null, killAttivo: false, botAvviato: true, now: T0 + 20 * 60_000 });
  ok('conteggio illeggibile: stato congelato, nessuna anomalia', congelato.anomalia === false && congelato.stato === s.stato);
  ok('conteggio negativo trattato come illeggibile',
    valutaVuoto({ stato: s.stato, ordiniARiposo: -1, killAttivo: false, botAvviato: true, now: T0 }).anomalia === false);

  // La soglia è quella dichiarata e si può stringere per i test.
  ok('soglia di difetto 5 minuti', SOGLIA_MS === 5 * 60_000);
  const stretta = valutaVuoto({ stato: { vuotoDa: T0, allarmato: false }, ordiniARiposo: 0, killAttivo: false, botAvviato: true, sogliaMs: 60_000, now: T0 + 90_000 });
  ok('soglia iniettabile', stretta.anomalia === true);

  // La riga d'allarme dice i dollari, e quando non li sa lo dice.
  const riga = rigaAllarme({
    vuotoMs: 6 * 60_000,
    capitale: { leggibile: true, alLavoroUsd: 55.5, totaleUsd: 664.6, pct: 8.4, obiettivoPct: 95 },
    ripartizione: { riga: 'fermo $609.10: piano senza righe utilizzabili $609.10 (100%)' },
  });
  ok('la riga porta la ripartizione in dollari', /609\.10/.test(riga) && /piano senza righe/.test(riga) && /8\.4%/.test(riga));
  ok('senza misura lo dichiara invece di inventare zero',
    /NON disponibile/.test(rigaAllarme({ vuotoMs: 6 * 60_000, capitale: { leggibile: false, motivo: 'saldo non leggibile' } })));

  console.log(`sentinella-vuoto selfcheck: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { valutaVuoto, rigaAllarme, selfcheck, SOGLIA_MS };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

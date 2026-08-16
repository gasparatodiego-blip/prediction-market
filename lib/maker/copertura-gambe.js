'use strict';
// lib/maker/copertura-gambe.js — UN MERCATO ATTIVO HA DUE GAMBE VIVE, SEMPRE. PURO.
//
// ═══ IL BUCO, OSSERVATO ══════════════════════════════════════════════════════════════════════════════
// 16 agosto 2026: `0x776841ce…` e' rimasto a **ZERO ordini** dopo che il timeout del mid stantio li
// aveva cancellati entrambi, e nessuno lo ha ripopolato. Il motivo e' una divisione dei compiti che
// nessuno aveva mai messo alla prova con un mercato SVUOTATO:
//   · `agent40` RIPREZZA gli ordini che esistono — non ne crea di nuovi. Su zero ordini non ha niente
//     su cui iterare, quindi non fa niente e non lo dice;
//   · `agent41` PIAZZA, ma solo quando il trigger a capitale fermo scatta e il piano assegna capitale a
//     quel mercato. Un mercato gia' «nel piano» e senza ordini non e' capitale fermo che chiede casa:
//     e' un buco che nessuna delle due meta' guarda.
// Uno slot occupato e vuoto e' il peggiore dei due mondi: consuma un posto dei tre e non matura niente.
//
// ═══ COSA DECIDE QUESTO MODULO ═══════════════════════════════════════════════════════════════════════
// Per ogni mercato attivo: quante gambe vive ci sono, quali mancano, e se il mercato e' quotabile
// ADESSO. Non piazza e non cancella: restituisce intenzioni. Il cablaggio le esegue passando dalle
// stesse funzioni di sempre.
//
// ═══ LA TERZA RISPOSTA, CHE E' QUELLA CHE MANCAVA ════════════════════════════════════════════════════
// «Ripiazza» e «non fare niente» non bastano. Un mercato puo' essere NON QUOTABILE per costruzione, e
// insistere sarebbe sbattere contro una regola di rischio a ogni ciclo:
//   · **profondita-insufficiente** — misurato 202 volte in 4 minuti: dentro la banda premiante il libro
//     ha UN SOLO livello popolato, e la Regola 1 («mai primo sul libro») cerca dal SECONDO in giu'. Su
//     un book cosi' sottile non esiste un prezzo conforme, e non esistera' finche' non arriva un altro
//     maker. Il mercato e' non quotabile PER COSTRUZIONE, non per un momento sfortunato.
//   · mid stantio, book illeggibile, fuori banda — transitori, di solito.
// Quindi il terzo esito e' **DA SOSTITUIRE**: si dichiara il motivo, si lascia stare il venue, e dopo
// una soglia di tempo lo slot viene restituito alla riclassificazione, che ci mette il miglior
// candidato per netto.
//
// ⚠ NON SI ALLARGA «MAI PRIMO SUL LIBRO». Era l'altra via: cercare anche il primo livello, cioe'
// affiancare il miglior prezzo altrui invece di stargli dietro. E' una REGOLA DI RISCHIO (§4.1,
// Regola 1) e cambiarla per riempire uno slot significherebbe pagare il problema con la moneta
// sbagliata: si otterrebbero tre mercati pieni di ordini piu' esposti al fill. Si cambia mercato, non
// la regola.
//
// ⚠ LA SOGLIA E' 10 MINUTI, e i tre numeri che la circondano dicono perche':
//   · sopra i **~2 min** del ciclo di selezione, cosi' un singolo giro sfortunato non sposta niente;
//   · **5 osservazioni consecutive** di non quotabilita' — un mercato che non si puo' quotare per dieci
//     minuti di fila non e' un buco del feed, e' una proprieta' del libro;
//   · sotto i **23 min** della scadenza GTD: si agisce PRIMA che il mercato si spenga da solo, che e'
//     l'unico modo perche' la sostituzione serva a qualcosa invece di certificare un funerale.

const SOSTITUISCI_DOPO_MS = 10 * 60_000;

const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Le gambe vive di un mercato, per token. Una gamba = un token con almeno un ordine a riposo. */
function gambeVive(ordini, conditionId) {
  const c = norm(conditionId);
  const tok = new Set();
  for (const o of (ordini || [])) {
    if (norm(o && (o.marketId || o.conditionId)) !== c) continue;
    const t = norm(o && (o.tokenId || o.asset_id || o.assetId));
    if (t) tok.add(t);
  }
  return tok;
}

/**
 * LA DECISIONE, per un mercato.
 *
 * @param a.conditionId
 * @param a.tokenIdYes / a.tokenIdNo   i due token del mercato; mancanti ⇒ non si giudica
 * @param a.ordini                      TUTTI gli ordini vivi (di ogni mercato): si filtra qui
 * @param a.quotabile                   {ok:boolean, motivo:string} — l'esito del motore su questo mercato
 * @param a.nonQuotabileDal             epoch ms della prima osservazione consecutiva, o null
 * @param a.ora
 * @param a.sogliaMs
 * @returns {{stato:'coperto'|'da-coprire'|'non-quotabile'|'da-sostituire'|'ignoto',
 *            gambeVive:number, mancanti:string[], motivo:string, nonQuotabileDal:number|null}}
 */
function valutaCopertura(a = {}) {
  const { conditionId, tokenIdYes, tokenIdNo, ordini, quotabile, ora } = a;
  const soglia = fin(a.sogliaMs) && a.sogliaMs > 0 ? a.sogliaMs : SOSTITUISCI_DOPO_MS;
  const y = norm(tokenIdYes), n = norm(tokenIdNo);
  if (!norm(conditionId) || !y || !n) {
    return { stato: 'ignoto', gambeVive: 0, mancanti: [], nonQuotabileDal: a.nonQuotabileDal ?? null,
      motivo: 'mercato senza conditionId o senza i due token: non si giudica la copertura di cio\' che non si sa identificare' };
  }
  // ⚠ ORDINI NON LEGGIBILI ⇒ NON SI GIUDICA. Trattare «non ho letto» come «zero gambe» farebbe
  // ripiazzare sopra ordini che esistono gia': e' il modo di produrre i doppioni che stiamo togliendo.
  if (!Array.isArray(ordini)) {
    return { stato: 'ignoto', gambeVive: 0, mancanti: [], nonQuotabileDal: a.nonQuotabileDal ?? null,
      motivo: 'lista degli ordini vivi non leggibile: nessuna gamba viene ripiazzata al buio' };
  }

  const vive = gambeVive(ordini, conditionId);
  const mancanti = [y, n].filter((t) => !vive.has(t));
  if (!mancanti.length) {
    // Coperto: l'orologio della non quotabilita' si AZZERA, perche' un mercato che quota non e' un
    // mercato da sostituire — anche se cinque minuti fa non si poteva quotare.
    return { stato: 'coperto', gambeVive: vive.size, mancanti: [], nonQuotabileDal: null,
      motivo: `due gambe vive (${vive.size} token con ordini a riposo)` };
  }

  const q = quotabile && typeof quotabile === 'object' ? quotabile : null;
  if (!q) {
    return { stato: 'ignoto', gambeVive: vive.size, mancanti, nonQuotabileDal: a.nonQuotabileDal ?? null,
      motivo: 'quotabilita\' non valutata: non si ripiazza senza sapere se esiste un prezzo conforme' };
  }
  if (q.ok === true) {
    return { stato: 'da-coprire', gambeVive: vive.size, mancanti, nonQuotabileDal: null,
      motivo: `mancano ${mancanti.length} gamba/e e il mercato e' quotabile adesso: si ripiazza` };
  }

  // Non quotabile: parte (o continua) l'orologio.
  const dal = fin(a.nonQuotabileDal) ? a.nonQuotabileDal : (fin(ora) ? ora : null);
  const da = fin(dal) && fin(ora) ? ora - dal : 0;
  if (da >= soglia) {
    return { stato: 'da-sostituire', gambeVive: vive.size, mancanti, nonQuotabileDal: dal,
      motivo: `non quotabile da ${Math.round(da / 60000)} min (${q.motivo || 'motivo non dichiarato'}):`
        + ` oltre la soglia di ${Math.round(soglia / 60000)} min lo slot torna alla riclassificazione`
        + ' — uno slot occupato e vuoto consuma un posto dei tre e non matura niente' };
  }
  return { stato: 'non-quotabile', gambeVive: vive.size, mancanti, nonQuotabileDal: dal,
    motivo: `non quotabile (${q.motivo || 'motivo non dichiarato'}): si dichiara e NON si forza l'ordine.`
      + ` Sostituzione fra ${Math.max(0, Math.round((soglia - da) / 60000))} min se non torna quotabile` };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ copertura-gambe ════');
  const base = { conditionId: '0xAA', tokenIdYes: 'tokY', tokenIdNo: 'tokN', ora: 1_000_000 };
  const ord = (tok) => ({ marketId: '0xAA', tokenId: tok, side: 'BUY', orderId: '0x1' + tok });

  ok('due gambe ⇒ coperto',
    valutaCopertura({ ...base, ordini: [ord('tokY'), ord('tokN')], quotabile: { ok: true } }).stato === 'coperto');
  const una = valutaCopertura({ ...base, ordini: [ord('tokY')], quotabile: { ok: true } });
  ok('una gamba e mercato quotabile ⇒ da-coprire', una.stato === 'da-coprire' && una.mancanti[0] === 'tokn');
  ok('zero gambe e quotabile ⇒ da-coprire con DUE mancanti — il caso di 0x776841ce',
    valutaCopertura({ ...base, ordini: [], quotabile: { ok: true } }).mancanti.length === 2);

  const nq = valutaCopertura({ ...base, ordini: [], quotabile: { ok: false, motivo: 'profondita-insufficiente' } });
  ok('non quotabile ⇒ NON si forza, si dichiara', nq.stato === 'non-quotabile' && /NON si forza/.test(nq.motivo));
  ok('  e parte l\'orologio', nq.nonQuotabileDal === base.ora);

  const tardi = valutaCopertura({ ...base, ora: base.ora + SOSTITUISCI_DOPO_MS, nonQuotabileDal: base.ora,
    ordini: [], quotabile: { ok: false, motivo: 'profondita-insufficiente' } });
  ok('oltre la soglia ⇒ da-sostituire', tardi.stato === 'da-sostituire');
  const quasi = valutaCopertura({ ...base, ora: base.ora + SOSTITUISCI_DOPO_MS - 1, nonQuotabileDal: base.ora,
    ordini: [], quotabile: { ok: false, motivo: 'x' } });
  ok('  un millisecondo prima NO', quasi.stato === 'non-quotabile');

  const tornato = valutaCopertura({ ...base, nonQuotabileDal: base.ora - 9 * 60_000,
    ordini: [ord('tokY'), ord('tokN')], quotabile: { ok: false, motivo: 'x' } });
  ok('se torna COPERTO l\'orologio si azzera', tornato.stato === 'coperto' && tornato.nonQuotabileDal === null);

  ok('ordini non leggibili ⇒ ignoto, nessun ripiazzamento al buio',
    valutaCopertura({ ...base, ordini: null, quotabile: { ok: true } }).stato === 'ignoto');
  ok('quotabilita\' non valutata ⇒ ignoto',
    valutaCopertura({ ...base, ordini: [], quotabile: null }).stato === 'ignoto');
  ok('token mancanti ⇒ ignoto',
    valutaCopertura({ ...base, tokenIdNo: null, ordini: [], quotabile: { ok: true } }).stato === 'ignoto');
  ok('gli ordini di un ALTRO mercato non contano come copertura',
    valutaCopertura({ ...base, ordini: [{ marketId: '0xBB', tokenId: 'tokY' }, { marketId: '0xBB', tokenId: 'tokN' }],
      quotabile: { ok: true } }).mancanti.length === 2);
  ok('la soglia sta sotto la scadenza GTD (23 min) e sopra il ciclo di selezione (2 min)',
    SOSTITUISCI_DOPO_MS < 23 * 60_000 && SOSTITUISCI_DOPO_MS > 2 * 60_000);

  console.log(`\ncopertura-gambe: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { valutaCopertura, gambeVive, SOSTITUISCI_DOPO_MS, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

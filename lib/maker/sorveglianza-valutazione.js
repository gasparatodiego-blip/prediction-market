'use strict';
// lib/maker/sorveglianza-valutazione.js — UNA POSIZIONE APERTA VA VALUTATA A OGNI CICLO. PURO.
//
// ═══ IL FATTO CHE LO GIUSTIFICA ══════════════════════════════════════════════════════════════════════
// Il 16 agosto una posizione su `0xde0b0b24…` è rimasta aperta **cinque ore**. L'orologio della
// modalità chiusura era corretto (`da: 15:20:41Z` per tutte e cinque le ore) e la dep era cablata: il
// difetto era che **la scala non veniva quasi mai VALUTATA** — `urgenzaLivello` compare **una volta
// sola in cinque ore** nel giornale. Il ramo `already-covered` ritornava prima di ricalcolare il
// prezzo, ed è stato corretto (§5-bis p.138). Ma la correzione è dentro il ramo: se il CICLO non
// gira, non c'è ramo che tenga.
//
// ═══ PERCHE' NON BASTA AVER CORRETTO IL RAMO ═════════════════════════════════════════════════════════
// `agent40.closeTask()` — che è l'unico posto in cui la scala e il take-profit vengono valutati — è
// raggiungibile solo attraverso una catena che può interrompersi in silenzio:
//   · gira **solo `if (riconciliato)`**, cioè al più una volta ogni `RECONCILE_EVERY_MS` (60 s);
//   · un'eccezione dentro `closeTask` produce **una riga di log e basta** — nessun record a giornale;
//   · `runAutoCloseCycle` itera solo i mercati in `visitare` (allowlist ∪ posizioni): un mercato che
//     esce da entrambi gli insiemi smette di essere guardato, e nessuno lo dice.
// Nessuno di questi tre casi lascia una traccia che si possa cercare dopo. Questo modulo osserva il
// **fatto** — «questa posizione è aperta e non è stata valutata» — invece delle sue tre cause, ed è il
// motivo per cui vive fuori dal percorso che sorveglia.
//
// ⚠ NON AGISCE. Non chiude, non cancella, non piazza, non tocca gli interruttori. Restituisce un
// elenco di anomalie; chi lo cabla le scrive a verbale. È la stessa scelta della sentinella sul
// collasso (§5 p.142): un presidio nuovo entra in servizio prima come osservatore.
//
// ⚠ E NON SI AUTO-INGANNA: si arma **una volta per episodio**. Una posizione che resta non valutata
// per un'ora produce UNA anomalia, non sessanta — altrimenti il giornale del giorno dopo direbbe
// «3.600 anomalie» e nessuno saprebbe che erano un problema solo.

// Due cicli di chiusura. Il ciclo vale 60 s (`RECONCILE_EVERY_MS`), quindi la soglia è 120 s.
// ⚠ IL NUMERO SI PASSA, NON SI CABLA: chi chiama conosce la propria cadenza, e una soglia scritta qui
// dentro diventerebbe una seconda verità sulla cadenza del ciclo (reperto D1).
const CICLI_DI_TOLLERANZA = 2;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

/** La chiave di una posizione: mercato + token. Due lati dello stesso mercato sono due posizioni. */
function chiaveDi(marketId, tokenId) {
  const m = norm(marketId); const t = norm(tokenId);
  return m && t ? `${m}:${t}` : null;
}

/**
 * TIMBRA UNA VALUTAZIONE. Da chiamare quando `decideClose` è stato eseguito per quella posizione —
 * **non** quando il ciclo è partito: un ciclo che parte e salta il mercato non lo ha valutato.
 */
function registraValutazione(stato, { chiave, ora } = {}) {
  const s = stato && typeof stato === 'object' ? stato : {};
  if (!chiave || !fin(ora)) return s;
  const v = s[chiave] || {};
  // L'anomalia si DISARMA quando la valutazione riprende: il prossimo silenzio è un episodio nuovo.
  return { ...s, [chiave]: { ...v, ultimaValutazione: ora, segnalata: false } };
}

/** Timbra la prima osservazione di una posizione, così una appena nata ha un ciclo di grazia. */
function registraPosizione(stato, { chiave, ora } = {}) {
  const s = stato && typeof stato === 'object' ? stato : {};
  if (!chiave || !fin(ora)) return s;
  const v = s[chiave];
  if (v && fin(v.primaVista)) return s;
  return { ...s, [chiave]: { ...(v || {}), primaVista: ora, ultimaValutazione: (v && v.ultimaValutazione) || null, segnalata: false } };
}

/**
 * LE ANOMALIE ADESSO.
 *
 * @param a.stato        il registro (da `registraValutazione` / `registraPosizione`)
 * @param a.posizioni    [{marketId, tokenId, size}] — le posizioni APERTE, dallo snapshot del venue
 * @param a.ora
 * @param a.cicloMs      la durata di un ciclo di chiusura, dal chiamante
 * @param a.cicli        quanti cicli di silenzio sono un'anomalia (difetto 2)
 * @returns {{anomalie:[], stato:object, sogliaMs:number, motivo:string}}
 */
function anomalie(a = {}) {
  const s = a.stato && typeof a.stato === 'object' ? a.stato : {};
  const ora = fin(a.ora) ? a.ora : null;
  const cicli = fin(a.cicli) && a.cicli > 0 ? a.cicli : CICLI_DI_TOLLERANZA;
  const cicloMs = fin(a.cicloMs) && a.cicloMs > 0 ? a.cicloMs : null;
  const sogliaMs = cicloMs != null ? cicloMs * cicli : null;

  // ⚠ FAIL-CLOSED VERSO IL SILENZIO, NON VERSO L'ALLARME. Senza orologio o senza cadenza non si può
  // dire che siano passati due cicli, e un allarme su un conto che non si sa fare è peggio di nessun
  // allarme: insegna a ignorarlo. `Number(null) === 0` darebbe soglia zero, cioè anomalia sempre.
  if (ora == null || sogliaMs == null) {
    return { anomalie: [], stato: s, sogliaMs,
      motivo: 'orologio o cadenza non leggibili: non si giudica (una soglia derivata da un dato assente varrebbe zero, cioè allarme sempre)' };
  }
  // ⚠ POSIZIONI NON LEGGIBILI ⇒ NON SI GIUDICA, e non si azzera niente. «Non ho letto le posizioni»
  // non è «non ci sono posizioni»: trattarlo come tale spegnerebbe il presidio proprio quando lo
  // snapshot è rotto, cioè quando serve di più.
  if (!Array.isArray(a.posizioni)) {
    return { anomalie: [], stato: s, sogliaMs,
      motivo: 'posizioni non leggibili: nessun giudizio, e nessuna anomalia archiviata' };
  }

  let stato = { ...s };
  const out = [];
  const vive = new Set();
  for (const p of a.posizioni) {
    const size = Number(p && p.size);
    if (!fin(size) || Math.abs(size) <= 0) continue;         // una posizione chiusa non si sorveglia
    const chiave = chiaveDi(p && p.marketId, p && p.tokenId);
    if (!chiave) continue;                                   // non identificabile ⇒ non giudicabile
    vive.add(chiave);
    stato = registraPosizione(stato, { chiave, ora });
    const v = stato[chiave];
    // Il riferimento è l'ultima valutazione; se non c'è MAI stata, è la prima volta che l'abbiamo
    // vista — così una posizione appena nata ha i suoi due cicli prima di essere un'anomalia.
    const da = fin(v.ultimaValutazione) ? v.ultimaValutazione : v.primaVista;
    const silenzio = ora - da;
    // ⚠ Un timbro nel FUTURO (orologio spostato indietro) dà `silenzio < 0`: il confronto è falso e
    // non si segnala. È il verso prudente.
    if (silenzio < sogliaMs) continue;
    if (v.segnalata === true) continue;                      // già segnalata: un episodio, un allarme
    stato = { ...stato, [chiave]: { ...v, segnalata: true } };
    out.push({
      chiave, marketId: norm(p.marketId), tokenId: norm(p.tokenId), size,
      silenzioMs: silenzio, silenzioMin: +(silenzio / 60_000).toFixed(1),
      maiValutata: !fin(v.ultimaValutazione),
      motivo: fin(v.ultimaValutazione)
        ? `posizione aperta di ${size} share non valutata da ${Math.round(silenzio / 1000)} s`
          + ` (oltre ${cicli} cicli da ${Math.round(cicloMs / 1000)} s): la scala d'uscita e il take-profit`
          + ' non sono stati ricalcolati, ed è il meccanismo che il 16 agosto ha tenuto una posizione aperta cinque ore'
        : `posizione aperta di ${size} share osservata da ${Math.round(silenzio / 1000)} s e MAI valutata:`
          + ' il ciclo di chiusura non l\'ha mai vista — mercato fuori da `visitare`, oppure il ciclo non è partito',
    });
  }
  // Le posizioni chiuse escono dal registro, o crescerebbe senza fine e una riapertura si troverebbe
  // addosso il «già segnalata» di ieri.
  for (const k of Object.keys(stato)) if (!vive.has(k)) delete stato[k];
  return { anomalie: out, stato, sogliaMs,
    motivo: out.length ? `${out.length} posizione/i non valutata/e da oltre ${cicli} cicli` : 'tutte le posizioni aperte sono state valutate nei tempi' };
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ sorveglianza-valutazione ════');

  const CICLO = 60_000; const T = 1_000_000_000;
  const pos = [{ marketId: '0xMKT', tokenId: 'TOK', size: 60 }];
  const base = { posizioni: pos, cicloMs: CICLO, cicli: 2 };

  // Prima osservazione: nessuna anomalia, e il registro nasce.
  const r0 = anomalie({ ...base, stato: {}, ora: T });
  ok('una posizione appena vista non è un\'anomalia', r0.anomalie.length === 0);
  ok('  ma entra nel registro', !!r0.stato['0xmkt:tok']);

  // Un ciclo di silenzio: ancora niente.
  const r1 = anomalie({ ...base, stato: r0.stato, ora: T + CICLO });
  ok('dopo UN ciclo di silenzio ancora niente', r1.anomalie.length === 0);

  // Due cicli: scatta.
  const r2 = anomalie({ ...base, stato: r1.stato, ora: T + 2 * CICLO });
  ok('dopo DUE cicli scatta', r2.anomalie.length === 1, r2.anomalie[0] && r2.anomalie[0].motivo.slice(0, 60));
  ok('  e dichiara che non è MAI stata valutata', r2.anomalie[0].maiValutata === true);

  // Non si ripete.
  const r3 = anomalie({ ...base, stato: r2.stato, ora: T + 3 * CICLO });
  ok('non si ripete al ciclo dopo: un episodio, un allarme', r3.anomalie.length === 0);

  // Una valutazione disarma, e il silenzio successivo riarma.
  const dopoVal = registraValutazione(r3.stato, { chiave: '0xmkt:tok', ora: T + 3 * CICLO });
  const r4 = anomalie({ ...base, stato: dopoVal, ora: T + 4 * CICLO });
  ok('una valutazione disarma l\'allarme', r4.anomalie.length === 0);
  const r5 = anomalie({ ...base, stato: r4.stato, ora: T + 5 * CICLO + 1 });
  ok('  e un silenzio NUOVO lo riarma', r5.anomalie.length === 1, r5.anomalie[0] && `${r5.anomalie[0].silenzioMin} min`);
  ok('  e stavolta NON dice «mai valutata»', r5.anomalie[0].maiValutata === false);

  // Fail-closed.
  ok('senza cadenza non si giudica', anomalie({ posizioni: pos, stato: {}, ora: T }).anomalie.length === 0);
  ok('senza orologio non si giudica', anomalie({ ...base, stato: {}, ora: null }).anomalie.length === 0);
  ok('posizioni non leggibili ⇒ nessun giudizio e registro intatto', (() => {
    const r = anomalie({ stato: r2.stato, posizioni: null, cicloMs: CICLO, ora: T + 9 * CICLO });
    return r.anomalie.length === 0 && !!r.stato['0xmkt:tok'];
  })());
  ok('una posizione a size ZERO non si sorveglia',
    anomalie({ ...base, posizioni: [{ marketId: '0xMKT', tokenId: 'TOK', size: 0 }], stato: r1.stato, ora: T + 9 * CICLO }).anomalie.length === 0);
  ok('  e sparisce dal registro quando si chiude',
    anomalie({ ...base, posizioni: [], stato: r2.stato, ora: T + 9 * CICLO }).stato['0xmkt:tok'] === undefined);
  ok('un timbro nel FUTURO non produce un allarme', (() => {
    const s = registraValutazione({}, { chiave: '0xmkt:tok', ora: T + 10 * CICLO });
    return anomalie({ ...base, stato: s, ora: T }).anomalie.length === 0;
  })());
  ok('due lati dello stesso mercato sono due posizioni distinte', (() => {
    const due = [{ marketId: '0xMKT', tokenId: 'A', size: 10 }, { marketId: '0xMKT', tokenId: 'B', size: 10 }];
    const x = anomalie({ posizioni: due, cicloMs: CICLO, cicli: 2, stato: {}, ora: T });
    const y = anomalie({ posizioni: due, cicloMs: CICLO, cicli: 2, stato: x.stato, ora: T + 2 * CICLO });
    return y.anomalie.length === 2;
  })());

  console.log(`\nsorveglianza-valutazione selfcheck: ${p} verdi, ${f} rossi`);
  return f === 0;
}

module.exports = { anomalie, registraValutazione, registraPosizione, chiaveDi, CICLI_DI_TOLLERANZA, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

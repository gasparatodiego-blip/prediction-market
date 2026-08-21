'use strict';
// lib/maker/guardian-riferimento.js — IL PUNTO DA CUI SI MISURA LA PERDITA, CHE NON INVECCHIA PIÙ.
//
// ═══ IL GUASTO CHE QUESTO MODULO CHIUDE (§5.2 p.14) ═══════════════════════════════════════════════
// `data/guardian-baseline.json` era una FOTOGRAFIA fissata al 2026-08-07T21:27:31Z e mai più toccata.
// Il guardiano confrontava il capitale di adesso con quella fotografia, quindi il suo «PnL» non era un
// drawdown: era la variazione cumulata dal 7 agosto, che mescola trading, reward incassati e movimenti
// di cassa. Sbagliava in DUE direzioni opposte — i reward gonfiavano il totale e ritardavano lo scatto,
// una perdita realizzata non rientrava mai e col tempo faceva scattare sulla storia invece che sul calo.
//
// ⚠ E CON UN DEPOSITO DIVENTAVA ATTIVAMENTE PERICOLOSO, misurato il 13 agosto 2026: baseline $660,56
// contro un totale di $2.149,88 dopo un versamento di $1.500 ⇒ il guardiano leggeva **+$1.489 di
// guadagno** e non sarebbe scattato finché non avessimo perso **$1.519**. Falliva APERTO: nessuna
// protezione, e nessun segnale che non ce ne fosse.
//
// ═══ LA SCELTA: DRAWDOWN DA MASSIMO MOBILE, NON BASELINE CORRETTA A POSTERIORI ════════════════════
// Le due strade sul tavolo erano «massimo mobile del totale» e «baseline fissa meno reward incassati e
// movimenti di cassa». La seconda è stata scartata, e il motivo è che dipende da dati che possono
// MANCARE: il registro reward si recupera a ritroso fino a 30 giorni (§4.12) e una giornata assente
// sposterebbe la baseline in silenzio; i movimenti di cassa andrebbero letti da una fonte che oggi
// nessuno interroga. Una correzione che poggia su un dato assente sbaglia senza dirlo, ed è esattamente
// il modo in cui il difetto attuale è nato.
//
// Il massimo mobile invece usa SOLO quello che il guardiano già legge ogni 30 secondi — cassa e
// posizioni — e misura la cosa giusta: **quanto siamo scesi dal punto più alto**, non quanto è cambiato
// il conto dal 7 agosto. E un deposito si assorbe da sé: alza il massimo, e da un versamento non si può
// guadagnare.
//
// ═══ QUELLO CHE IL MASSIMO MOBILE DA SOLO SBAGLIA: IL PRELIEVO ═══════════════════════════════════
// Un prelievo abbassa il totale e somiglia a una perdita. Qui entra il rilevatore di movimenti esterni,
// e il criterio è aritmetico, non euristico:
//
//     fra due letture, il totale può muoversi SENZA che le posizioni si muovano solo se è entrata o
//     uscita cassa. Un fill sposta cassa E posizioni in versi opposti; un movimento di prezzo sposta le
//     posizioni; un riscatto sposta entrambe. **A posizioni ferme non esiste un modo di perdere soldi.**
//
// Quindi: `|Δposizioni| ≈ 0` **e** `|Δtotale|` grande ⇒ è cassa entrata o uscita, e il riferimento si
// SPOSTA di quell'importo invece di registrarlo come utile o perdita.
//
// ⚠ QUANDO NON SI PUÒ CONCLUDERE, SI FALLISCE CHIUSO. Lettura precedente assente o troppo vecchia
// (riavvio, processo fermo) ⇒ **nessun movimento viene dedotto**: si aggiorna solo il massimo. Un
// deposito resta assorbito correttamente (il massimo sale); un prelievo viene letto come perdita, cioè
// il guardiano scatta PRIMA. È il verso giusto in cui sbagliare, ed è dichiarato.

// ⚠ LA COSTANTE SI IMPORTA, NON SI RICOPIA. «Contigue nel tempo» qui significa esattamente quello che
// significa per lo scatto — il giro e' lo stesso, 30 s — e due numeri per lo stesso concetto sono il
// reperto D1 in attesa. `guardian-perdite` e' puro e non importa questo modulo: nessun ciclo.
const { ETA_MASSIMA_FRA_LETTURE_MS } = require('./guardian-perdite');

const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const fin = (x) => Number.isFinite(x);

// Oltre questo, la lettura precedente non fa più da confronto: fra le due può essere successo di tutto.
const ETA_MASSIMA_LETTURA_PRECEDENTE_MS = 10 * 60_000;
// Un movimento esterno è GRANDE per definizione: sotto queste soglie si resta nel rumore del
// mark-to-market e si preferisce trattarlo come PnL, che è il verso prudente.
const MOVIMENTO_MIN_USD = 50;
const MOVIMENTO_MIN_FRAZIONE = 0.02;
// Quanto le posizioni possono muoversi e contare ancora come «ferme».
const POSIZIONI_FERME_USD = 5;
const POSIZIONI_FERME_FRAZIONE = 0.02;

/** La soglia ASSOLUTA, derivata invece che fissa. Vedi il commento in `agent43-guardian`. */
const FRAZIONE_SOGLIA_ASSOLUTA = 0.05;

/**
 * C'è stata cassa entrata o uscita fra le due letture?
 *
 * @returns `{esterno:boolean, movimentoUsd:number|null, motivo:string}` — `esterno:false` con
 *          `movimentoUsd:null` quando non si è potuto concludere, che NON è «non è successo niente».
 */
function rilevaMovimentoEsterno({ precedente = null, corrente = null, now = Date.now() } = {}) {
  const p = precedente; const c = corrente;
  if (!p || !c) return { esterno: false, movimentoUsd: null, motivo: 'nessuna lettura precedente con cui confrontare' };
  const tPrev = num(p.totaleUsd); const tOra = num(c.totaleUsd);
  const posPrev = num(p.valorePosizioniUsd); const posOra = num(c.valorePosizioniUsd);
  if (![tPrev, tOra, posPrev, posOra].every(fin)) {
    return { esterno: false, movimentoUsd: null, motivo: 'una delle due letture non è completa: non si deduce un movimento' };
  }
  const at = num(p.at);
  if (!fin(at)) return { esterno: false, movimentoUsd: null, motivo: 'la lettura precedente non porta un istante' };
  const eta = now - at;
  if (!(eta >= 0) || eta > ETA_MASSIMA_LETTURA_PRECEDENTE_MS) {
    return { esterno: false, movimentoUsd: null,
      motivo: `la lettura precedente ha ${Math.round(eta / 1000)}s: troppo vecchia per dedurre un movimento — si aggiorna solo il massimo` };
  }

  const dTot = +(tOra - tPrev).toFixed(6);
  const dPos = +(posOra - posPrev).toFixed(6);
  const sogliaMov = Math.max(MOVIMENTO_MIN_USD, MOVIMENTO_MIN_FRAZIONE * Math.max(tPrev, tOra));
  const sogliaPos = Math.max(POSIZIONI_FERME_USD, POSIZIONI_FERME_FRAZIONE * Math.max(posPrev, posOra));

  if (Math.abs(dTot) < sogliaMov) {
    return { esterno: false, movimentoUsd: 0, motivo: `variazione $${dTot.toFixed(2)} sotto la soglia di movimento $${sogliaMov.toFixed(2)}: è PnL` };
  }
  if (Math.abs(dPos) > sogliaPos) {
    return { esterno: false, movimentoUsd: 0,
      motivo: `le posizioni si sono mosse di $${dPos.toFixed(2)} (oltre $${sogliaPos.toFixed(2)}): la variazione è spiegata dal mercato, non da cassa esterna` };
  }
  return { esterno: true, movimentoUsd: dTot,
    motivo: `posizioni ferme ($${dPos.toFixed(2)}) e totale mosso di $${dTot.toFixed(2)}: è cassa ${dTot > 0 ? 'ENTRATA' : 'USCITA'}, non ${dTot > 0 ? 'un guadagno' : 'una perdita'}` };
}

/**
 * Il riferimento aggiornato: massimo mobile, spostato dai movimenti esterni.
 *
 * @param a.stato   il record persistito precedente (o `null` al primo giro)
 * @param a.capitale l'esito di `valutaCapitale` — deve essere `leggibile`
 * @returns `{stato, riferimentoUsd, cambiato, movimento, motivo}`
 */
function aggiornaRiferimento({ stato = null, capitale = null, now = Date.now(), motivo = null, osservazione = null } = {}) {
  if (!capitale || capitale.leggibile !== true) {
    // ⚠ Un capitale illeggibile non aggiorna NIENTE: né il massimo né i movimenti. Un massimo nato da
    // una lettura fallita sarebbe un punto zero inventato, e ogni misura successiva lo erediterebbe.
    return { stato, riferimentoUsd: stato ? num(stato.riferimentoUsd) : null, cambiato: false,
      movimento: null, motivo: `capitale non leggibile (${(capitale && capitale.motivo) || 'assente'}): il riferimento resta dov'è` };
  }
  const tot = num(capitale.totaleUsd);
  if (!fin(tot)) {
    return { stato, riferimentoUsd: stato ? num(stato.riferimentoUsd) : null, cambiato: false,
      movimento: null, motivo: 'totale non numerico: il riferimento resta dov\'è' };
  }

  const letturaOra = {
    at: now,
    totaleUsd: tot,
    saldoUsd: num(capitale.saldoUsd),
    valorePosizioniUsd: num(capitale.valorePosizioniUsd),
  };

  // ── MIGRAZIONE DAL FORMATO v1: si ADOTTA il valore che c'era, non lo si butta.
  // Il record vecchio porta solo `baselineUsd`. Adottarlo come riferimento di partenza e poi lasciare
  // che il massimo mobile faccia il suo mestiere dà lo stesso risultato che ricrearlo da zero — sul
  // deposito del 13 agosto entrambe le strade danno $2.149,88 — ma non SCARTA un valore memorizzato,
  // e la differenza conta il giorno in cui il totale corrente è più BASSO del riferimento vecchio:
  // lì ricreare da zero cancellerebbe un drawdown in corso, cioè spegnerebbe il guardiano.
  if (stato && !fin(num(stato.riferimentoUsd)) && fin(num(stato.baselineUsd))) {
    const adottato = num(stato.baselineUsd);
    const rifAdottato = Math.max(adottato, tot);
    return {
      stato: {
        ...stato, v: 2, riferimentoUsd: +rifAdottato.toFixed(6), baselineUsd: +rifAdottato.toFixed(6),
        at: now, atIso: new Date(now).toISOString(),
        motivo: `migrato dal formato v1: riferimento adottato $${adottato.toFixed(2)}`
          + (rifAdottato > adottato ? `, poi alzato al totale corrente $${tot.toFixed(2)}` : ''),
        movimentiEsterniUsd: fin(num(stato.movimentiEsterniUsd)) ? num(stato.movimentiEsterniUsd) : 0,
        ultimaLettura: letturaOra,
      },
      riferimentoUsd: +rifAdottato.toFixed(6), cambiato: true, movimento: null, migrato: true,
      motivo: `migrazione v1→v2: da $${adottato.toFixed(2)} a $${rifAdottato.toFixed(2)}`,
    };
  }

  // ── PRIMO GIRO ASSOLUTO: nessun record. Il riferimento nasce dal totale letto adesso.
  if (!stato || !fin(num(stato.riferimentoUsd))) {
    return {
      stato: {
        v: 2, riferimentoUsd: tot, at: now, atIso: new Date(now).toISOString(),
        motivo: motivo || 'riferimento creato dal totale corrente',
        // Compatibilità all'indietro: il codice vecchio legge `baselineUsd` e continua a funzionare
        // con il valore giusto anche prima di essere riavviato.
        baselineUsd: tot,
        movimentiEsterniUsd: 0, ultimaLettura: letturaOra,
      },
      riferimentoUsd: tot, cambiato: true, movimento: null, creato: true,
      motivo: `riferimento creato a $${tot.toFixed(2)}`,
    };
  }

  let rif = num(stato.riferimentoUsd);
  const mov = rilevaMovimentoEsterno({ precedente: stato.ultimaLettura || null, corrente: letturaOra, now });
  let movimentiTot = fin(num(stato.movimentiEsterniUsd)) ? num(stato.movimentiEsterniUsd) : 0;
  const note = [];

  // ── IL RIFERIMENTO SCENDE SUBITO, SALE SOLO SU CONFERMA ────────────────────────────────────────
  // Un movimento di cassa NEGATIVO (prelievo) abbassa il riferimento all'istante: e' la direzione
  // prudente, perche' un prelievo non riconosciuto varrebbe come perdita e farebbe scattare PRIMA.
  // Un movimento POSITIVO (deposito) non passa piu' di qui: alza il TOTALE, quindi viene assorbito
  // dal massimo mobile — che da oggi pretende una conferma, come qualunque altra salita.
  if (mov.esterno && fin(mov.movimentoUsd) && mov.movimentoUsd < 0) {
    rif = +(rif + mov.movimentoUsd).toFixed(6);
    movimentiTot = +(movimentiTot + mov.movimentoUsd).toFixed(6);
    note.push(`riferimento sceso di $${Math.abs(mov.movimentoUsd).toFixed(2)} — ${mov.motivo}`);
  }

  // ══ IL MASSIMO MOBILE NON SALE PIU' SU UNA LETTURA SOLA — 21 agosto 2026 (D-D) ═══════════════════
  //
  // ⚠ IL FATTO, con i numeri e l'ora. Il 16 agosto 2026 alle 19:28:00.990Z questo cricchetto ha fissato
  // il riferimento a **$1.550,18** e da allora non e' piu' sceso. Quel totale non e' mai esistito:
  //
  //     osservatore 19:27:17  saldo $1.439,94 + posizioni $57,103 (3)  = $1.497,05
  //     GUARDIANO   19:28:00  saldo $1.493,07 + posizioni $57,103      = $1.550,18   ← il massimo
  //     osservatore 19:28:18  saldo $1.493,07 + posizioni  $0,003 (1)  = $1.493,08
  //
  // Il saldo e' quello DOPO la chiusura delle posizioni, le posizioni sono quelle PRIMA: **gli stessi
  // $57,10 contati due volte**. Lo scarto fra il massimo e il totale vero e' $57,10 esatti, cioe' il
  // valore delle posizioni — non e' una deduzione, e' un'identita' aritmetica.
  //
  // ⚠ LA CAUSA NON E' LA SOGLIA, E' L'ASIMMETRIA FRA LE DUE META' DEL GUARDIANO. Lo SCATTO pretende due
  // letture DISTINTE e contigue (`confermaScatto`, k=2) perche' il segnale e' piu' rumoroso della
  // soglia — l'intestazione di `guardian-perdite` misura salti fino a **$74,47** fra letture a 30 s che
  // rientrano al campione dopo. Il CRICCHETTO accettava lo stesso segnale con **k=1**: una meta'
  // scettica e una credulona sullo stesso rumore. E l'errore non e' simmetrico nel tempo — un
  // transitorio verso il basso rientra e sparisce, uno verso l'alto **resta per sempre**, perche' un
  // massimo mobile non scende.
  //
  // ⚠ LE DUE STRADE ERANO DUE, e chiuderne una sola non bastava: a posizioni FERME (cioe' anche quando
  // sono ferme perche' lo snapshot non e' stato riletto) un salto del solo saldo soddisfa pure il
  // rilevatore di cassa esterna, che spostava il riferimento verso l'alto per conto suo. Per questo
  // adesso **qualunque salita** — nuovo massimo o cassa entrata — passa dalla stessa conferma.
  //
  // ⚠ IL COSTO MISURATO. Il riferimento fantasma si e' mangiato **3,5-3,8% dei 5%** di budget di
  // drawdown in permanenza: dal 17/08 al 21/08 il PnL «a riposo» oscillava fra −$54,92 e −$59,41 senza
  // che nulla fosse andato storto. Ne sono seguiti **4 pre-allarmi e 1 SCATTO** (20/08 22:36:02, PnL
  // −$111,77), che ha cancellato gli ordini e messo il bot su FERMA per **6h06m** — riacceso a mano
  // alle 04:42:39Z del 21/08. Replay sulle 10.695 letture VERE del guardiano (log di agent43, 4,00
  // giorni): **4 pre-allarmi e 1 scatto col riferimento fantasma, 0 e 0 con quello confermato**.
  //
  // ═══ LA REGOLA ═══════════════════════════════════════════════════════════════════════════════════
  // Un totale sopra il riferimento diventa un CANDIDATO. Il riferimento sale solo quando una seconda
  // lettura DISTINTA e CONTIGUA sta anch'essa sopra il riferimento, e sale al **minimo delle due** — il
  // livello che entrambe sostengono, non la punta. Un totale che rientra sotto il riferimento azzera il
  // candidato: non e' persistito, quindi non era capitale.
  //
  // ⚠ «DISTINTA» E' LA STESSA DOMANDA DI `confermaScatto`, e per la stessa ragione: `SALDO_CACHE_TTL_MS`
  // (45 s) e' piu' lungo del giro (30 s), quindi due giri consecutivi possono leggere la STESSA voce di
  // cache — e una copia non e' una conferma. Qui basta che i due TOTALI differiscano (due letture con
  // posizioni marcate a mercato non danno lo stesso numero per caso); a parita' di totale si pretende
  // un istante di lettura del saldo diverso. Se nemmeno quello e' leggibile, non si conferma.
  //
  // ⚠ NON PUO' FAR SCATTARE PRIMA, PER COSTRUZIONE. Si scatta quando `tot <= 0,95 · rif`: un
  // riferimento che sale piu' lentamente puo' solo ABBASSARE il punto di scatto. La correzione toglie
  // scatti, non ne aggiunge — e va detto per intero, perche' significa che ALLENTA la difesa di $46,12
  // sul punto di scatto ($1.472,67 → $1.426,55). E' il verso voluto: quei $46,12 erano un fantasma.
  //
  // ⚠ E IL VERSO OPPOSTO RESTA APERTO, DICHIARATO E NON CORRETTO. Lo stesso disallineamento fra le due
  // fonti produce anche il transitorio verso il BASSO — posizioni gia' sparite e saldo non ancora
  // accreditato, durante un merge on-chain. Misurato il 20/08 alle 22:36: il guardiano leggeva
  // $1.438,41 mentre l'osservatore, nello stesso minuto, leggeva $1.492,81 — **$54,40 di divario**.
  // Quel difetto vive nella LETTURA (`valutaCapitale` somma due fonti con freschezze diverse), non nel
  // riferimento, e curarlo e' un secondo lavoro sull'unica difesa viva: sta in §5.2, non corretto qui.
  let nuovoMassimo = false;
  let candidato = stato.candidato && fin(num(stato.candidato.valoreUsd)) ? stato.candidato : null;
  const letturaAt = osservazione && fin(num(osservazione.saldoLetturaAt)) ? num(osservazione.saldoLetturaAt) : null;
  const movEntrata = mov.esterno && fin(mov.movimentoUsd) && mov.movimentoUsd > 0 ? mov.movimentoUsd : 0;

  if (tot > rif) {
    const etaCand = candidato && fin(num(candidato.at)) ? now - num(candidato.at) : null;
    const contiguo = etaCand !== null && etaCand >= 0 && etaCand <= ETA_MASSIMA_FRA_LETTURE_MS;
    const attesoAt = candidato && fin(num(candidato.saldoLetturaAt)) ? num(candidato.saldoLetturaAt) : null;
    // Distinta per VALORE, oppure — a parita' di totale — per istante di lettura del saldo.
    // Fail-closed: due letture identiche senza istante leggibile NON confermano.
    const distinta = !!candidato && (tot !== num(candidato.valoreUsd) || (letturaAt !== null && letturaAt !== attesoAt));
    if (contiguo && distinta) {
      const confermato = Math.min(num(candidato.valoreUsd), tot);
      if (confermato > rif) {
        rif = +confermato.toFixed(6);
        nuovoMassimo = true;
        const entrata = fin(num(candidato.movimentoUsd)) ? num(candidato.movimentoUsd) : 0;
        if (entrata > 0) {
          movimentiTot = +(movimentiTot + entrata).toFixed(6);
          note.push(`cassa ENTRATA $${entrata.toFixed(2)}, confermata: il riferimento la assorbe e da un versamento non si guadagna`);
        }
        note.push(`nuovo massimo CONFERMATO $${rif.toFixed(2)}`
          + ` (due letture distinte: $${num(candidato.valoreUsd).toFixed(2)} e $${tot.toFixed(2)}, si prende la minore)`);
      }
      candidato = null;
    } else {
      const perche = etaCand !== null && !contiguo
        ? ` (il candidato precedente ha ${Math.round(etaCand / 1000)}s: troppo lontano per fare da conferma)`
        : (candidato && !distinta ? " (la lettura non e' distinta dalla precedente: e' una copia, non una conferma)" : '');
      candidato = { valoreUsd: tot, at: now, atIso: new Date(now).toISOString(),
        saldoLetturaAt: letturaAt, movimentoUsd: movEntrata || undefined };
      note.push(`massimo CANDIDATO $${tot.toFixed(2)}: sopra il riferimento $${rif.toFixed(2)},`
        + ` si aspetta una seconda lettura distinta prima di alzarlo${perche}`);
    }
  } else if (candidato) {
    // Rientrato: il candidato non era capitale, era un transitorio. E' il ramo che il 16 agosto avrebbe
    // cancellato il fantasma da $1.550,18 al campione successivo.
    note.push(`candidato $${num(candidato.valoreUsd).toFixed(2)} scartato: il totale e' rientrato a $${tot.toFixed(2)}`);
    candidato = null;
  }

  const cambiato = rif !== num(stato.riferimentoUsd) || nuovoMassimo;
  return {
    stato: {
      ...stato, v: 2, riferimentoUsd: +rif.toFixed(6), baselineUsd: +rif.toFixed(6),
      at: cambiato ? now : (num(stato.at) || now),
      atIso: cambiato ? new Date(now).toISOString() : (stato.atIso || null),
      motivo: cambiato ? note.join(' · ') : (stato.motivo || null),
      movimentiEsterniUsd: movimentiTot,
      candidato,
      ultimaLettura: letturaOra,
    },
    riferimentoUsd: +rif.toFixed(6),
    cambiato,
    candidato,
    movimento: mov,
    motivo: note.length ? note.join(' · ') : `riferimento invariato a $${rif.toFixed(2)} (${mov.motivo})`,
  };
}

/**
 * LA SOGLIA ASSOLUTA, DERIVATA DAL RIFERIMENTO INVECE CHE FISSA.
 *
 * ⚠ PERCHÉ DERIVATA, e il numero che lo decide: $30 fissi valevano il 4,5% su $661 — coerenti con la
 * soglia percentuale del 5% — e valgono l'**1,4%** su $2.150. Su un conto cresciuto una soglia fissa
 * smette di essere una protezione e diventa un generatore di falsi positivi: il guardiano scatterebbe
 * su un movimento di mercato ordinario. Legandola al riferimento la protezione resta la stessa
 * QUALUNQUE sia il capitale, che è ciò che una soglia di rischio deve fare.
 *
 * ⚠ IL DENOMINATORE È IL RIFERIMENTO, NON IL TOTALE DI ADESSO. Col totale corrente la soglia si
 * stringerebbe mentre si perde — un cricchetto che accelera lo scatto proprio nel momento peggiore.
 * Il riferimento è fermo, quindi la soglia è ferma.
 *
 * ⚠ IL VALORE DA `.env` RESTA, COME PAVIMENTO IN DOLLARI. Non viene ignorato — ignorare in silenzio una
 * variabile che qualcuno ha scritto è il modo in cui nascono i due interruttori per una decisione sola.
 * Su conti piccoli il pavimento morde e il guardiano scatta PRIMA; su conti grandi morde la frazione.
 */
function sogliaAssoluta({ riferimentoUsd = null, pavimentoUsd = null, frazione = FRAZIONE_SOGLIA_ASSOLUTA } = {}) {
  const rif = num(riferimentoUsd);
  const pav = num(pavimentoUsd);
  const fr = num(frazione);
  const pavimento = fin(pav) && pav > 0 ? pav : null;
  if (!fin(rif) || rif <= 0 || !fin(fr) || fr <= 0) {
    // Riferimento illeggibile ⇒ resta il pavimento, che è la protezione più STRETTA. Mai `null`, che a
    // valle varrebbe «nessuna soglia».
    return { sogliaUsd: pavimento, derivata: false, pavimentoUsd: pavimento, frazione: fin(fr) ? fr : null,
      motivo: 'riferimento non leggibile: resta il pavimento in dollari, che è la protezione più stretta' };
  }
  const derivata = +(rif * fr).toFixed(2);
  const sogliaUsd = pavimento != null ? Math.max(pavimento, derivata) : derivata;
  return {
    sogliaUsd, derivata: sogliaUsd === derivata, pavimentoUsd: pavimento, frazione: fr,
    motivo: pavimento != null && pavimento > derivata
      ? `pavimento $${pavimento.toFixed(2)} sopra il ${(fr * 100).toFixed(1)}% del riferimento ($${derivata.toFixed(2)}): morde il pavimento`
      : `${(fr * 100).toFixed(1)}% del riferimento $${rif.toFixed(2)} = $${derivata.toFixed(2)}`,
  };
}

module.exports = {
  rilevaMovimentoEsterno, aggiornaRiferimento, sogliaAssoluta,
  FRAZIONE_SOGLIA_ASSOLUTA, ETA_MASSIMA_LETTURA_PRECEDENTE_MS,
  MOVIMENTO_MIN_USD, MOVIMENTO_MIN_FRAZIONE, POSIZIONI_FERME_USD, POSIZIONI_FERME_FRAZIONE,
};

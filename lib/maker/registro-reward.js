'use strict';
// lib/maker/registro-reward.js — QUANTO ABBIAMO DAVVERO INCASSATO, E QUANTO CI ERAVAMO DETTI.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Fino a oggi esistevano solo STIME IN AVANTI: `estGrossUsdPerDay`, il lordo del piano, il realistico.
// Tutte previsioni. Non c'era modo di rispondere alla domanda più semplice che esista su questo bot —
// **abbiamo incassato più di quanto abbiamo perso?** — perché il denominatore era una speranza.
//
// ═══ COSA C'ERA GIÀ, E PERCHÉ NON BASTAVA ═══════════════════════════════════════════════════════════
// `confronto-reward.json` esiste e tiene, per giorno, la stima e il consuntivo. È la fonte giusta e NON
// viene duplicata: questo modulo la LEGGE e ne costruisce una vista. Quello che mancava era il resto —
// il cumulato, lo scarto percentuale per giorno, il totale davvero incassato — e un posto dove leggerlo
// senza aprire un file JSON.
//
// ═══ ⚠ IL LIMITE, MISURATO E DICHIARATO: IL REALE NON HA IL MERCATO ═════════════════════════════════
// Il requisito chiede «per giorno e per mercato». **Per giorno si può, per mercato no**, e non è una
// scelta: la fonte reale è `data-api /activity?type=REWARD`, e su quelle righe `conditionId`, `title` e
// `slug` sono **stringhe vuote** — verificato oggi su tutti e quattro i pagamenti del funder. Il venue
// paga un bonifico aggregato al giorno, non uno per mercato.
//
// Quindi la scomposizione per mercato esiste **solo sul lato stima**, e questo modulo la riporta
// dichiarando che è tale. **Non si divide il totale reale fra i mercati in proporzione alla stima**:
// sarebbe un numero inventato che sembra una misura, ed è esattamente il modo in cui un consuntivo
// smette di essere un consuntivo. Se un giorno il venue popolasse `conditionId`, il lato reale per
// mercato arriverebbe da sé: `realePerMercato` è già nel formato del registro.
//
// ═══ NASCE CIECO? NO ════════════════════════════════════════════════════════════════════════════════
// Il requisito prevedeva che potesse nascere cieco se la riconciliazione fosse rimasta rotta. Non lo è:
// il recupero a ritroso ha completato tutte e sei le giornate, quindi il registro nasce **con i dati
// veri dal 6 agosto 2026**.

const { leggiConfronto, scarto, baseStima } = require('./confronto-reward');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * LA VISTA COMPLETA. Pura rispetto al disco solo nel senso che legge e non scrive: la persistenza è di
 * `confronto-reward.json`, che è già il registro. Costruirne un secondo vorrebbe dire tenerne allineati
 * due, e due registri della stessa cosa divergono sempre.
 *
 * @returns {{giorni:Array, totali:object, perMercatoStima:Array, limiti:object}}
 */
function costruisciRegistro({ conf = null, maxGiorni = 60 } = {}) {
  const c = conf || leggiConfronto();
  const righe = Array.isArray(c && c.giorni) ? c.giorni : [];

  const giorni = righe
    .filter((r) => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.giorno || '')))
    .sort((a, b) => (a.giorno < b.giorno ? 1 : -1))     // più recente in cima
    .slice(0, maxGiorni)
    .map((r) => {
      // LA STIMA CONFRONTABILE E' LA QUANTITA' INTEGRATA — Sigma(tasso x durata) — non la fotografia
      // delle 23:55, che e' un TASSO. `baseStima` e' l'unico punto che decide, e dichiara quale ha
      // usato: uno scarto calcolato su basi diverse in giornate diverse non e' una serie storica.
      const b = baseStima(r);
      const s = fin(b.usd) ? b.usd : null;
      const re = fin(r.realeUsd) ? r.realeUsd : null;
      const sc = scarto({ stimaUsd: s, realeUsd: re });
      return {
        giorno: r.giorno,
        stimaUsd: s,
        // La fotografia resta accanto: e' la serie con cui e' stato misurato il +465%, e toglierla
        // renderebbe il prima e il dopo non confrontabili.
        stimaFotoUsd: fin(r.stimaUsd) ? r.stimaUsd : null,
        stimaBase: b.base,
        copertura: fin(r.stimaCopertura) ? r.stimaCopertura : null,
        campioni: Number.isFinite(r.stimaCampioni) ? r.stimaCampioni : null,
        completa: r.stimaCompleta === true,
        realeUsd: re,
        // `consuntivato` è diverso da `realeUsd > 0`: uno ZERO letto è un consuntivo, e va distinto da
        // «non lo sappiamo ancora». Confonderli farebbe sembrare incassato-zero uguale a non-misurato.
        consuntivato: re != null,
        scartoUsd: sc.assolutoUsd,
        scartoPct: sc.percentuale,
        direzione: sc.direzione,
        pagamenti: Array.isArray(r.realePagamenti) ? r.realePagamenti.length : 0,
        // Il `transactionHash` viaggia con la riga: un consuntivo senza provenienza non è verificabile.
        tx: Array.isArray(r.realePagamenti) ? r.realePagamenti.map((p) => p.tx).filter(Boolean) : [],
        motivo: re == null ? (r.realeMotivo || null) : null,
      };
    });

  const consuntivate = giorni.filter((g) => g.consuntivato);
  const conEntrambi = giorni.filter((g) => g.consuntivato && g.stimaUsd != null);
  const somma = (arr, k) => arr.reduce((a, x) => a + (fin(x[k]) ? x[k] : 0), 0);

  const realeTot = somma(consuntivate, 'realeUsd');
  const stimaTot = somma(conEntrambi, 'stimaUsd');
  const realeSuStessiGiorni = somma(conEntrambi, 'realeUsd');

  return {
    giorni,
    totali: {
      giornateTotali: giorni.length,
      giornateConsuntivate: consuntivate.length,
      giornateConEntrambi: conEntrambi.length,
      // ⚠ IL TOTALE INCASSATO È SU TUTTE le giornate consuntivate; lo SCARTO solo su quelle che hanno
      // anche la stima. Sommare due insiemi diversi e poi confrontarli darebbe uno scarto falso.
      realeUsd: +realeTot.toFixed(4),
      stimaUsd: +stimaTot.toFixed(4),
      realeSuGiorniConfrontabili: +realeSuStessiGiorni.toFixed(4),
      ...(() => {
        const sc = scarto({ stimaUsd: stimaTot, realeUsd: realeSuStessiGiorni });
        return { scartoUsd: sc.assolutoUsd, scartoPct: sc.percentuale, direzione: sc.direzione };
      })(),
      mediaGiornalieraUsd: consuntivate.length ? +(realeTot / consuntivate.length).toFixed(4) : null,
      primoGiorno: giorni.length ? giorni[giorni.length - 1].giorno : null,
      ultimoGiorno: giorni.length ? giorni[0].giorno : null,
    },
    // La scomposizione per mercato dell'ULTIMA giornata che ce l'ha — lato stima soltanto.
    perMercatoStima: (() => {
      const r = righe.find((x) => Array.isArray(x && x.stimaPerMercato) && x.stimaPerMercato.length);
      if (!r) return [];
      return r.stimaPerMercato.slice(0, 20).map((m) => ({
        giorno: r.giorno,
        marketId: m.marketId || m.conditionId || null,
        titolo: m.question || m.title || null,
        stimaUsd: fin(Number(m.estUsdPerDay ?? m.stimaUsd)) ? Number(m.estUsdPerDay ?? m.stimaUsd) : null,
      }));
    })(),
    limiti: {
      realePerMercato: false,
      // Il motivo, per esteso e nel referto: chi legge il pannello deve sapere PERCHÉ manca una colonna,
      // altrimenti la assenza sembra un guasto.
      realePerMercatoMotivo: 'il venue paga un bonifico aggregato al giorno: sulle righe REWARD del'
        + ' registro attività `conditionId` è vuoto (verificato su tutti i pagamenti). La scomposizione'
        + ' per mercato esiste solo sul lato STIMA, e il totale reale NON viene diviso fra i mercati in'
        + ' proporzione: sarebbe un numero inventato con l\'aspetto di una misura.',
    },
  };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ registro-reward ════');

  const conf = { giorni: [
    { giorno: '2026-08-06', stimaUsd: 3.09, realeUsd: 1.3042, realePagamenti: [{ tx: '0xabc' }] },
    { giorno: '2026-08-07', stimaUsd: 0, realeUsd: 0 },
    { giorno: '2026-08-08', stimaUsd: 49.17, realeUsd: 3.6792 },
    { giorno: '2026-08-09', stimaUsd: null, realeUsd: 8.3524 },
    { giorno: '2026-08-10', stimaUsd: 0, realeUsd: null, realeMotivo: 'finestra non chiusa' },
  ] };
  const r = costruisciRegistro({ conf });

  ok('le giornate sono ordinate dalla più recente', r.giorni[0].giorno === '2026-08-10');
  ok('lo ZERO letto è un consuntivo', r.giorni.find((g) => g.giorno === '2026-08-07').consuntivato === true);
  ok('  e «non lo sappiamo» non lo è', r.giorni.find((g) => g.giorno === '2026-08-10').consuntivato === false);
  ok('  con il motivo accanto', /finestra/.test(r.giorni.find((g) => g.giorno === '2026-08-10').motivo));
  ok('il totale incassato somma TUTTE le giornate consuntivate',
    Math.abs(r.totali.realeUsd - (1.3042 + 0 + 3.6792 + 8.3524)) < 1e-6, String(r.totali.realeUsd));
  ok('lo scarto si calcola SOLO sulle giornate con entrambi i numeri', r.totali.giornateConEntrambi === 3);
  ok('  cioè escludendo quella senza stima', r.totali.stimaUsd === +(3.09 + 0 + 49.17).toFixed(4));
  ok('lo scarto percentuale c\'è ed è una sovrastima', r.totali.scartoPct > 0 && r.totali.direzione === 'sovrastima');
  ok('per giorno lo scarto è per giorno', r.giorni.find((g) => g.giorno === '2026-08-08').scartoPct > 1000);
  ok('  e con reale ZERO la percentuale è `null`, non Infinity',
    r.giorni.find((g) => g.giorno === '2026-08-07').scartoPct === null);
  ok('la media giornaliera è sulle consuntivate', r.totali.giornateConsuntivate === 4);
  ok('il transactionHash viaggia con la riga', r.giorni.find((g) => g.giorno === '2026-08-06').tx[0] === '0xabc');

  // ⚠ IL LIMITE VA DICHIARATO, NON NASCOSTO.
  ok('il reale per mercato è dichiarato NON disponibile', r.limiti.realePerMercato === false);
  ok('  con il motivo per esteso', /conditionId/.test(r.limiti.realePerMercatoMotivo));
  // L'asserzione precedente cercava una stringa nel proprio sorgente ed era auto-referenziale: la
  // stringa c'era perche' la scriveva l'asserzione stessa. Si verifica la PROPRIETA': nessuna riga per
  // mercato porta un valore reale, quindi non c'e' niente da dividere.
  ok('  e nessuna riga per mercato porta un valore REALE: non c\'è niente da dividere',
    costruisciRegistro({ conf: { giorni: [{ giorno: '2026-08-08', stimaUsd: 10, realeUsd: 4,
      stimaPerMercato: [{ marketId: '0xa', estUsdPerDay: 6 }, { marketId: '0xb', estUsdPerDay: 4 }] }] } })
      .perMercatoStima.every((m) => m.realeUsd === undefined && Object.keys(m).join(',') === 'giorno,marketId,titolo,stimaUsd'));

  const vuoto = costruisciRegistro({ conf: { giorni: [] } });
  ok('registro vuoto ⇒ totali a zero, nessuna eccezione', vuoto.totali.realeUsd === 0 && vuoto.giorni.length === 0);
  ok('  e nessuna percentuale inventata', vuoto.totali.scartoPct === null);

  console.log(`\nregistro-reward: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = { costruisciRegistro, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

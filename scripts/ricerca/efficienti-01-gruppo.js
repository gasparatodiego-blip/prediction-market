'use strict';
// scripts/ricerca/efficienti-01-gruppo.js — IL GRUPPO «EFFICIENTI» DENTRO I 65. Sola lettura, zero rete.
//
//   node scripts/ricerca/efficienti-01-gruppo.js
//
// ═══ COSA FA ═════════════════════════════════════════════════════════════════════════════════════
// Ricompone i 65 sopravvissuti di `screening-04-referto.json` con i campi che il referto NON aveva
// portato con sé (capitale, P&L 7g, mediana giornaliera vivono in 02 e 03) e applica il filtro
// dell'operatore. Nessuna chiamata di rete: tutto viene dai tre file già su disco, quindi il
// risultato è riproducibile e confrontabile con lo screening da cui nasce.
//
// ═══ ⚠ IL FILTRO CHE MORDE NON È IL CAPITALE ═════════════════════════════════════════════════════
// L'operatore ha chiesto: «se ne restano meno di 8, allarga il capitale fino a $15.000». Misurato:
// allargare il capitale NON cambia il numero — nemmeno togliendo del tutto il vincolo di capitale.
// Il filtro che decide è `|P&L 7g| ≤ $100`. Lo script quindi calcola l'allargamento chiesto, misura
// che è inerte, e lo DICHIARA invece di consegnare un gruppo allargato che non è più largo.
//
// Per non lasciare le misure a valle su n=4 si calcola anche un **gruppo di sensibilità** con la
// sola soglia che morde rilassata (|P&L| ≤ $250, capitale fino a $15.000). Non sostituisce il
// gruppo stretto: gli sta accanto, ed è etichettato, perché la domanda dell'operatore era il primo.

const path = require('path');
const fs = require('fs');
const { leggi, scrivi, mediana } = require('./screening-lib');

// ── LE SOGLIE CHIESTE ────────────────────────────────────────────────────────────────────────────
const CAP_MIN = 500;
const CAP_MAX = 6000;
const CAP_MAX_ALLARGATO = 15_000;
const PNL_MAX = 100;
const REWARDS_MIN = 300;
const DUE_LATI_MIN = 0.40;
const MINIMO_UTILE = 8;

/** Sensibilità: la sola soglia che morde, rilassata. Serve a dare un `n` alle misure, non a decidere. */
const PNL_MAX_SENS = 250;

/** Inclusi per istruzione esplicita dell'operatore, «anche se sfiorano i filtri». */
const FORZATI = [
  '0x6d7f75befd422de6225ad7b4e256622a7b4d1d58',
  '0x52870486f74fcd2fe707821b9aa8da0f6d8c3a16',
];

function main() {
  const referto = leggi('screening-04-referto.json');
  const posiz = leggi('screening-03-posizioni.json');
  const storico = leggi('screening-02-storico.json');
  const P = new Map(posiz.righe.map((r) => [r.wallet, r]));
  const S = new Map(storico.righe.map((r) => [r.wallet, r]));

  // ⚠ `capitaleStimato === null` è NON MISURATO, non «zero»: non passa nessun filtro di capitale, e
  // viene contato a parte. È la regola di §5.3 (`Number(null) === 0`) applicata a un filtro.
  const tutti = referto.passatiWallet.map((w) => {
    const p = P.get(w.wallet);
    const s = S.get(w.wallet);
    return {
      wallet: w.wallet,
      rewards14g: s.rewards14g,
      medianaGiornaliera: s.medianaGiornaliera,
      giorniAttivi: s.giorniAttivi,
      capitaleStimato: p.capitaleStimato,
      contanteUsd: p.contanteUsd,
      valorePosizioni: p.valorePosizioni,
      pnl7g: p.pnl7g,
      quotaDueLati: p.quotaDueLati,
      mercatiScambiati: p.mercatiScambiati,
      mercatiConPosizione: p.mercatiConPosizione,
      // rewards/capitale: la domanda dell'operatore. Si dichiara `null` se il capitale non è
      // misurato — un rapporto con un denominatore inventato è peggio di un campo vuoto.
      rendimentoPct: (p.capitaleStimato === null || p.capitaleStimato <= 0)
        ? null : (s.rewards14g / p.capitaleStimato) * 100,
    };
  });

  const passaCap = (r, max) => r.capitaleStimato !== null && r.capitaleStimato >= CAP_MIN && r.capitaleStimato <= max;
  const passaPnl = (r, soglia) => r.pnl7g !== null && Math.abs(r.pnl7g) <= soglia;
  const passaRew = (r) => r.rewards14g >= REWARDS_MIN;
  const passaDue = (r) => r.quotaDueLati >= DUE_LATI_MIN;

  const stretto = tutti.filter((r) => passaCap(r, CAP_MAX) && passaPnl(r, PNL_MAX) && passaRew(r) && passaDue(r));
  const allargato = tutti.filter((r) => passaCap(r, CAP_MAX_ALLARGATO) && passaPnl(r, PNL_MAX) && passaRew(r) && passaDue(r));
  const senzaCap = tutti.filter((r) => passaPnl(r, PNL_MAX) && passaRew(r) && passaDue(r));
  const sensibilita = tutti.filter((r) => passaCap(r, CAP_MAX_ALLARGATO) && passaPnl(r, PNL_MAX_SENS) && passaRew(r) && passaDue(r));

  // ── L'IMBUTO, un filtro alla volta ─────────────────────────────────────────────────────────────
  // Serve a rispondere «quale soglia morde», che è la domanda vera quando il gruppo esce piccolo.
  const imbuto = {
    dei65: tutti.length,
    soloCapitale6k: tutti.filter((r) => passaCap(r, CAP_MAX)).length,
    soloCapitale15k: tutti.filter((r) => passaCap(r, CAP_MAX_ALLARGATO)).length,
    soloPnl: tutti.filter((r) => passaPnl(r, PNL_MAX)).length,
    soloRewards: tutti.filter((r) => passaRew(r)).length,
    soloDueLati: tutti.filter((r) => passaDue(r)).length,
    tuttiEQuattro: stretto.length,
    // Quanti sopravvivono TOGLIENDO un filtro alla volta: il filtro la cui rimozione non cambia
    // niente non stava mordendo, quello la cui rimozione triplica il gruppo era il collo.
    senzaVincoloCapitale: senzaCap.length,
    senzaVincoloPnl: tutti.filter((r) => passaCap(r, CAP_MAX) && passaRew(r) && passaDue(r)).length,
    senzaVincoloRewards: tutti.filter((r) => passaCap(r, CAP_MAX) && passaPnl(r, PNL_MAX) && passaDue(r)).length,
    senzaVincoloDueLati: tutti.filter((r) => passaCap(r, CAP_MAX) && passaPnl(r, PNL_MAX) && passaRew(r)).length,
    capitaleNonMisurato: tutti.filter((r) => r.capitaleStimato === null).length,
    pnlNonMisurato: tutti.filter((r) => r.pnl7g === null).length,
  };

  // L'allargamento chiesto è INERTE se non aggiunge nessuno.
  const allargamentoUtile = allargato.length > stretto.length;

  // I forzati: si dichiara se sarebbero passati da soli, o se entrano solo per istruzione.
  const insieme = new Map(stretto.map((r) => [r.wallet, r]));
  const forzatiEsito = FORZATI.map((w) => {
    const r = tutti.find((x) => x.wallet === w) || null;
    const giaDentro = insieme.has(w);
    if (r && !giaDentro) insieme.set(w, { ...r, aggiuntoPerIstruzione: true });
    return {
      wallet: w,
      neiSessantacinque: r !== null,
      giaDentroDaSolo: giaDentro,
      perche: r === null ? 'non è fra i 65' : (giaDentro ? 'passa tutti e quattro i filtri da solo' : 'aggiunto per istruzione'),
    };
  });

  const gruppo = [...insieme.values()].sort((a, b) => b.rewards14g - a.rewards14g);
  const top5 = [...tutti].sort((a, b) => b.rewards14g - a.rewards14g).slice(0, 5);

  const out = {
    generatoIl: new Date().toISOString(),
    fonte: ['screening-02-storico.json', 'screening-03-posizioni.json', 'screening-04-referto.json'],
    soglie: {
      capitaleUsd: [CAP_MIN, CAP_MAX],
      capitaleUsdAllargato: [CAP_MIN, CAP_MAX_ALLARGATO],
      pnl7gAssolutoMax: PNL_MAX,
      rewards14gMin: REWARDS_MIN,
      dueLatiMin: DUE_LATI_MIN,
      minimoUtile: MINIMO_UTILE,
      pnl7gSensibilita: PNL_MAX_SENS,
    },
    imbuto,
    allargamentoChiesto: {
      applicato: true,
      da: CAP_MAX,
      a: CAP_MAX_ALLARGATO,
      utile: allargamentoUtile,
      walletAggiunti: allargato.filter((r) => !stretto.some((s) => s.wallet === r.wallet)).map((r) => r.wallet),
      nota: allargamentoUtile
        ? 'l\'allargamento del capitale aggiunge wallet'
        : 'INERTE: il vincolo che decide è |P&L 7g|, non il capitale — vedi `imbuto.senzaVincoloCapitale`',
    },
    forzati: forzatiEsito,
    gruppo,
    gruppoSensibilita: sensibilita.sort((a, b) => b.rewards14g - a.rewards14g),
    top5,
    riepilogoGruppo: {
      n: gruppo.length,
      rewards14gMediana: mediana(gruppo.map((r) => r.rewards14g)),
      capitaleMediano: mediana(gruppo.map((r) => r.capitaleStimato).filter((v) => v !== null)),
      rendimentoPctMediano: mediana(gruppo.map((r) => r.rendimentoPct).filter((v) => v !== null)),
      dueLatiMediana: mediana(gruppo.map((r) => r.quotaDueLati)),
    },
  };

  const f = scrivi('efficienti-01-gruppo.json', out);

  // ── STAMPA ─────────────────────────────────────────────────────────────────────────────────────
  const usd = (v, d = 2) => (v === null || v === undefined ? 'n/d' : '$' + Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }));
  console.log(`\nIMBUTO sui ${imbuto.dei65} sopravvissuti dello screening`);
  for (const [k, v] of Object.entries(imbuto)) console.log(`  ${k.padEnd(24)} ${String(v).padStart(4)}`);
  console.log(`\nGRUPPO EFFICIENTI — ${gruppo.length} wallet${gruppo.length < MINIMO_UTILE ? `  ⚠ sotto il minimo utile di ${MINIMO_UTILE}` : ''}`);
  console.log('wallet                                     | rewards 14g |  mediana/g |    capitale |   P&L 7g | 2 lati | rew/cap');
  for (const r of gruppo) {
    console.log([
      r.wallet,
      usd(r.rewards14g).padStart(11),
      usd(r.medianaGiornaliera).padStart(10),
      usd(r.capitaleStimato, 0).padStart(11),
      usd(r.pnl7g, 0).padStart(8),
      ((r.quotaDueLati * 100).toFixed(0) + '%').padStart(6),
      (r.rendimentoPct === null ? 'n/d' : r.rendimentoPct.toFixed(1) + '%').padStart(7),
      r.aggiuntoPerIstruzione ? ' (per istruzione)' : '',
    ].join(' | '));
  }
  console.log(`\nallargamento capitale a ${usd(CAP_MAX_ALLARGATO, 0)}: ${allargamentoUtile ? 'UTILE' : 'INERTE'} — ${out.allargamentoChiesto.nota}`);
  console.log(`gruppo di sensibilità (|P&L| ≤ ${usd(PNL_MAX_SENS, 0)}, cap ≤ ${usd(CAP_MAX_ALLARGATO, 0)}): ${sensibilita.length} wallet`);
  console.log(`\nscritto ${f}`);
  // Elenco secco per gli stadi a valle.
  fs.writeFileSync(path.join(path.dirname(f), 'efficienti-01-gruppo.txt'),
    gruppo.map((r) => r.wallet).join('\n') + '\n');
}

main();

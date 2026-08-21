'use strict';
// lib/rewards/size-da-capitale.js — QUANTE SHARE COMPRA UN CAPITALE. UNA FORMULA SOLA.
//
// ═══ IL DIFETTO CHE CHIUDE ═════════════════════════════════════════════════════════════════════════
// Nel repo convivevano DUE formule per la stessa domanda, e non coincidevano:
//
//   · `plan-to-orders` — QUELLO CHE PIAZZA DAVVERO:   Q = C / (p_yes + p_no)
//     Corretta. Comprare Q share di YES a p e Q di NO a 1−p è comprare una coppia che vale $1: le due
//     gambe insieme costano Q·(p_yes+p_no) = C, e il mid non c'entra.
//
//   · `minSizeVerdict` (reward-operator-estimate) e `net.js`:   perLato = (C/2) / mid
//     Assume che ENTRAMBI i lati costino `mid`. Vero solo a mid = 0,50.
//
// LA DIVERGENZA È GRANDE E VA IN TUTTE E DUE LE DIREZIONI:
//   mid 0,055 · minSize 20 → il secondo dice che bastano $2,20; ne servono ~$20. **Nove volte meno.**
//   mid 0,744 · minSize 100 → dice $148,90; ne bastano ~$98. **1,5 volte più.**
// Il primo verso è il pericoloso: un mercato risultava qualificato quando il capitale non compra il
// minimo premiante, e sotto `min_incentive_size` il reward non è più basso — è ZERO.
//
// `plan-to-orders` lo dichiarava già in un commento («il piano promette più share di quante il capitale
// ne compri… la correzione del MODELLO è una decisione separata»). Questa è quella decisione.
//
// ═══ LA REGOLA, E IL SUO RIPIEGO ═══════════════════════════════════════════════════════════════════
// Si usa SEMPRE il costo della coppia. Quando il costo della coppia non è leggibile si ripiega su una
// stima — `1 − 2·offset` non è ricostruibile senza i prezzi — e **lo si dichiara** invece di far
// sembrare misurato ciò che è assunto: chi legge `modello: 'ripiego-mid'` sa che sta guardando una
// stima. Non si ripiega MAI sulla vecchia formula `(C/2)/mid`: era sbagliata, non meno precisa.

const COSTO_COPPIA_TIPICO = 0.98;   // misurato sui piani veri (§5 punto 48): 1 − 2·offset

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * IL COSTO DI UNA COPPIA DI SHARE per una posa BILATERALE SIMMETRICA a `distanzaCents` dal mid.
 *
 * ═══ PERCHE' STA QUI, E NON IN TRE POSTI ═══════════════════════════════════════════════════════════
 * `1 − 2d` era scritto a mano in `scripts/rewards-replay/lib/allocate.js:387` (`pairCostForMarket`) e in
 * `lib/rewardScore.js` (`pairCostAtDistance`), e stava per esserlo una terza volta in
 * `realistic-estimate`. Tre copie della stessa aritmetica sono il reperto D1 — e su QUESTO numero una
 * divergenza fa mostrare al piano una size diversa da quella con cui e' stato classificato.
 *
 * ═══ LA DERIVAZIONE, DALLA FORMULA DEL VENUE ═══════════════════════════════════════════════════════
 * Il venue scora SHARE, non capitale. Quotare due lati partendo da solo collaterale significa comprare
 * YES a `mid − d` e NO a `1 − mid − d`: la coppia costa `(mid − d) + (1 − mid − d) = 1 − 2d`,
 * **indipendentemente dal mid**, che si cancella. Con share UGUALI sui due lati — che e' anche cio' che
 * massimizza `min(Q_bids, Q_asks)` a parita' di capitale — il conto e' una divisione sola.
 *
 * ⚠ `null` quando la posa non e' esprimibile: distanza non leggibile, negativa, o ≥ 50¢, dove la coppia
 * si azzera o si inverte. Mai uno zero e mai un ripiego: chi non sa la distanza non deve ricevere una
 * size, deve ricevere «non misurabile». E' la stessa guardia di `allocate.js:391`.
 */
function costoCoppiaAllaDistanza(distanzaCents) {
  if (!fin(distanzaCents) || distanzaCents < 0) return null;
  const d = distanzaCents / 100;
  if (d >= 0.5) return null;
  return +(1 - 2 * d).toFixed(9);
}

/**
 * Le share per LATO che `capitaleUsd` compra su questo mercato.
 *
 * @param {number}  capitaleUsd    il capitale della riga, YES+NO sommati
 * @param {number} [pairCostUsd]   `p_yes + p_no` misurato sulla riga; assente ⇒ ripiego dichiarato
 * @returns {{shares:number|null, costoCoppia:number, modello:'coppia'|'ripiego-tipico', motivo:string|null}}
 */
function sharePerLato({ capitaleUsd, pairCostUsd = null } = {}) {
  if (!fin(capitaleUsd) || capitaleUsd <= 0) {
    return { shares: null, costoCoppia: null, modello: null, motivo: 'capitale non leggibile o non positivo' };
  }
  if (fin(pairCostUsd) && pairCostUsd > 0) {
    return { shares: capitaleUsd / pairCostUsd, costoCoppia: pairCostUsd, modello: 'coppia', motivo: null };
  }
  return {
    shares: capitaleUsd / COSTO_COPPIA_TIPICO,
    costoCoppia: COSTO_COPPIA_TIPICO,
    modello: 'ripiego-tipico',
    motivo: `costo della coppia non leggibile: si usa il tipico ${COSTO_COPPIA_TIPICO} (1 − 2·offset misurato sui piani veri)`,
  };
}

/**
 * Il capitale che serve per stare sopra il minimo premiante su ENTRAMBI i lati.
 *
 * È l'inverso esatto di `sharePerLato`, e sostituisce `capitalToQualifyUsd = 2·mid·minSize`, che
 * dipendeva dal mid e per questo sbagliava.
 */
function capitalePerQualificare({ minSize, pairCostUsd = null } = {}) {
  if (!fin(minSize) || minSize <= 0) return null;
  const costo = (fin(pairCostUsd) && pairCostUsd > 0) ? pairCostUsd : COSTO_COPPIA_TIPICO;
  return +(minSize * costo).toFixed(4);
}

/** Il capitale basta a qualificare su questo mercato? `null` quando il minimo non è leggibile. */
function qualifica({ capitaleUsd, minSize, pairCostUsd = null } = {}) {
  if (!fin(minSize) || minSize <= 0) {
    return { qualifica: null, shares: null, servono: null, motivo: 'minimo premiante non leggibile — non si indovina' };
  }
  const s = sharePerLato({ capitaleUsd, pairCostUsd });
  const servono = capitalePerQualificare({ minSize, pairCostUsd });
  if (s.shares == null) return { qualifica: false, shares: null, servono, motivo: s.motivo };
  return {
    qualifica: s.shares >= minSize,
    shares: s.shares, servono, modello: s.modello,
    motivo: s.shares >= minSize ? null
      : `${s.shares.toFixed(1)} share per lato contro un minimo di ${minSize}: sotto min_incentive_size il`
        + ` venue non assegna punteggio e il reward è ZERO. Servono $${servono.toFixed(2)}.`,
  };
}

module.exports = {
  costoCoppiaAllaDistanza, sharePerLato, capitalePerQualificare, qualifica, COSTO_COPPIA_TIPICO };

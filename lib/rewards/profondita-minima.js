'use strict';
// lib/rewards/profondita-minima.js — IL CANCELLO SULLA PROFONDITÀ DEL BOOK, PRIMA DEL KNAPSACK.
//
// ═══ IL FATTO DA CUI NASCE (9 agosto 2026) ═══════════════════════════════════════════════════════════
// Il piano vero del 9 agosto copriva il 99,0% del capitale libero — $588 su $594 — e lo faceva con NOVE
// mercati di cui SETTE avevano la quota tagliata da `maxCredibleShare` e DUE stavano su un book vuoto
// verificato. Sette righe su nove erano meteo asiatico misurato all'una-due di notte locale, cioè
// mercati in cui nessun altro stava quotando. Il piano dichiarava $697/giorno di lordo — il 67%
// dell'INTERO montepremi di quei mercati — e $259/giorno di «realistico» su $588 di capitale, cioè il
// 44% al giorno. Nessun maker incassa il 44% al giorno.
//
// Il board non conteneva qualche mercato sottile: il board ERA in maggioranza sottile. Misurato sulle
// 108 righe di quel giorno: 73 (68%) con quota modellata oltre il 60% a $500 di capitale, 98 con
// `thinBookFlag` già alzato dal venue-scanner, 99 con `sane500 === false`.
//
// ═══ PERCHÉ UN CANCELLO E NON (SOLO) UN'ATTENUAZIONE ════════════════════════════════════════════════
// `credibleShareFactor` esisteva già e faceva la cosa giusta a metà: taglia la quota a 0,60 ma lascia
// il mercato NEL SET dei candidati. Il knapsack MASSIMIZZA, quindi un mercato tagliato a 0,60 resta
// comunque più attraente di uno onesto al 5% — l'attenuazione riduce il numero senza togliere il
// mercato, e il mercato vince lo stesso. Il punto di applicazione era sbagliato, non la misura.
//
// La misura NON CAMBIA di una riga: è la stessa `ceilingShare(size, competitorQ)` di
// `realistic-estimate`, con la stessa soglia `maxCredibleShare`. Cambia solo QUANDO si guarda: prima
// della scelta invece che dentro l'obiettivo.
//
// ═══ COSA È STATO MISURATO PRIMA DI SCRIVERLO ═══════════════════════════════════════════════════════
// Quattro piani appaiati sullo stesso board e sullo stesso capitale ($594,10 liberi, tetto 20%):
//
//     scenario                          esclusi   allocato   copertura   quote capate   book vuoti
//     nessuna esclusione (com'era)            0    $588,00       99,0%           5/7            8
//     senza meteo notturno                   46    $588,00       99,0%           2/6            1
//     senza sottili (quota > 0,60)           73    $588,00       99,0%           0/5            0
//     senza notturni E sottili               78    $588,00       99,0%           0/5            0
//
// Togliendo il 72% del board la copertura resta IDENTICA AL CENTESIMO. La ragione è aritmetica: col
// tetto di concentrazione al 20% servono al minimo CINQUE mercati per coprire il capitale, e il pool
// superstite ne aveva TRENTA — sei volte il necessario. Questo cancello non può affamare il piano
// finché quel rapporto regge, e il referto lo pubblica a ogni ciclo perché smetta di essere un'ipotesi.
//
// ═══ LA SOGLIA NON È UN NUMERO NUOVO ════════════════════════════════════════════════════════════════
// È `realistic-estimate.DEFAULTS.maxCredibleShare` — la STESSA che l'attenuazione usa. Importata, non
// ridichiarata: due costanti per lo stesso concetto sono il difetto che il rilevatore D1 dell'audit
// cerca, e qui sarebbe particolarmente insidioso perché cancello e attenuazione devono per costruzione
// parlare dello stesso confine. Se un giorno si vorranno due soglie diverse — un cancello più largo
// dell'attenuazione — quella sarà una decisione da scrivere qui con la sua misura, non un default.
//
// ═══ E L'ATTENUAZIONE RESTA ═════════════════════════════════════════════════════════════════════════
// Chi supera il cancello continua a passare da `credibleShareFactor` esattamente come prima. Il cancello
// toglie i mercati la cui quota è INCREDIBILE al capitale di riferimento; l'attenuazione continua a
// correggere, livello per livello, chi diventa sottile solo alle size più grandi. Sono due domande
// diverse: «questo mercato è un book vero?» e «quanta di questa quota è credibile a QUESTA size?».

const { ceilingShare, DEFAULTS } = require('./realistic-estimate');

/** La soglia. NON è dichiarata qui: è la stessa dell'attenuazione, importata. */
const MAX_QUOTA_CREDIBILE = DEFAULTS.maxCredibleShare;

/** IL CAPITALE DI RIFERIMENTO SU CUI SI GIUDICA — $500, e il numero non è arbitrario.
 *
 *  È il livello su cui agent24 pubblica già `levels["500"].share` per ogni riga del board, cioè la
 *  grandezza con cui la diagnosi del 9 agosto ha contato i 73 mercati sottili. Giudicare a un capitale
 *  diverso da quello misurato vorrebbe dire che il filtro esclude un insieme che nessuno ha guardato.
 *
 *  PERCHÉ NON IL CAPITALE VERO DELLA RIGA. Le curve del knapsack si fermano al tetto di concentrazione
 *  (oggi ~$134): giudicare «alla size che riceverebbe» renderebbe la soglia dipendente dal capitale del
 *  conto, quindi lo STESSO mercato sarebbe sottile o no a seconda di quanto denaro c'è in cassa. La
 *  sottigliezza è una proprietà del BOOK, non del nostro conto, e va misurata a un metro fisso.
 *
 *  Si cambia con `MAKER_PROFONDITA_CAPITALE_RIF`; un valore illeggibile o ≤ 0 viene SCARTATO in favore
 *  del difetto — la stessa regola di fine scala e dell'orizzonte: un `.env` sbagliato non deve poter
 *  spostare in silenzio un cancello che decide dove va il capitale. */
const CAPITALE_RIFERIMENTO_USD_DEFAULT = 500;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

function capitaleRiferimento(env = process.env) {
  const raw = env && typeof env.MAKER_PROFONDITA_CAPITALE_RIF === 'string' ? env.MAKER_PROFONDITA_CAPITALE_RIF.trim() : '';
  if (!raw) return CAPITALE_RIFERIMENTO_USD_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return CAPITALE_RIFERIMENTO_USD_DEFAULT;
  return v;
}

/**
 * Il verdetto sulla profondità di UN mercato.
 *
 * @param {object} a
 *   sharePerUsd   share per dollaro di capitale su questo mercato (dalla curva: sizePerSideShares/capital)
 *   depthShares   la concorrenza in banda MISURATA, in share (marketMeta().depthShares)
 *   capitaleRiferimentoUsd  di difetto `capitaleRiferimento()`
 *   maxQuota      di difetto `MAX_QUOTA_CREDIBILE`
 * @returns {{stato:'ok'|'sottile'|'ignota', quota:number|null, soglia:number, capitaleRif:number, motivo:string}}
 *
 *   'sottile' ⇒ ESCLUDE dal set passato al knapsack
 *   'ok'      ⇒ passa il cancello, e l'attenuazione continua ad agire su di lui come prima
 *   'ignota'  ⇒ NON ESCLUDE MAI. Un dato mancante non è un book vuoto: è la stessa regola che
 *               `horizonVerdict` applica a una scadenza illeggibile e che `marketValidity` applica a
 *               un montepremi non letto. L'assenza di un fatto non indossa i panni del fatto.
 */
function verdettoProfondita(a = {}) {
  const { sharePerUsd, depthShares } = a;
  const soglia = fin(a.maxQuota) && a.maxQuota > 0 && a.maxQuota < 1 ? a.maxQuota : MAX_QUOTA_CREDIBILE;
  const capitaleRif = fin(a.capitaleRiferimentoUsd) && a.capitaleRiferimentoUsd > 0
    ? a.capitaleRiferimentoUsd : capitaleRiferimento(a.env || process.env);

  if (!fin(sharePerUsd) || sharePerUsd <= 0) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'size per dollaro non calcolabile (costo della coppia o mid non leggibili) — non si conclude che il book sia sottile' };
  }
  if (!fin(depthShares) || depthShares < 0) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'profondità in banda non misurata — non si conclude che il book sia sottile' };
  }
  const quota = ceilingShare(sharePerUsd * capitaleRif, depthShares);
  if (quota == null) {
    return { stato: 'ignota', quota: null, soglia, capitaleRif, motivo: 'quota non calcolabile dagli ingressi letti' };
  }
  if (quota > soglia) {
    return {
      stato: 'sottile', quota, soglia, capitaleRif,
      motivo: `a $${capitaleRif} di capitale il modello attribuirebbe il ${(quota * 100).toFixed(1)}% del montepremi `
        + `(concorrenza in banda ${depthShares.toFixed(0)} share): oltre la quota massima credibile del ${(soglia * 100).toFixed(0)}%. `
        + 'Una quota così alta non è un\'opportunità — è un book in cui non c\'è nessun altro, e comprime appena arriva chiunque',
    };
  }
  return { stato: 'ok', quota, soglia, capitaleRif, motivo: `quota ${(quota * 100).toFixed(1)}% a $${capitaleRif}, sotto la soglia del ${(soglia * 100).toFixed(0)}%` };
}

/** Vero solo per un verdetto che ESCLUDE. Esiste perché chi chiama non debba confrontare stringhe. */
function esclude(v) { return !!v && v.stato === 'sottile'; }

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/profondita-minima').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── la soglia è IMPORTATA, non ridichiarata
  ok('la soglia è la stessa dell\'attenuazione (nessuna seconda costante)',
    MAX_QUOTA_CREDIBILE === require('./realistic-estimate').DEFAULTS.maxCredibleShare);
  ok('  e vale 0,60 come il tetto di credibilità', Math.abs(MAX_QUOTA_CREDIBILE - 0.60) < 1e-9);
  ok('il capitale di riferimento di difetto è $500', capitaleRiferimento({}) === 500);

  // ── il caso che ha motivato il filtro: book deserto
  const deserto = verdettoProfondita({ sharePerUsd: 2, depthShares: 0 });
  ok('concorrenza ZERO → quota 100% → sottile', deserto.stato === 'sottile' && deserto.quota === 1);
  const quasiDeserto = verdettoProfondita({ sharePerUsd: 2, depthShares: 20 });
  ok('concorrenza 20 share contro 1000 nostre → sottile', quasiDeserto.stato === 'sottile');

  // ── il caso che deve passare: book vero
  const vero = verdettoProfondita({ sharePerUsd: 2, depthShares: 100_000 });
  ok('book profondo → ok, e la quota è piccola', vero.stato === 'ok' && vero.quota < 0.02);

  // ── il confine, e si comporta come gli altri confini del repo: si passa ALLA soglia
  const alConfine = verdettoProfondita({ sharePerUsd: 1, depthShares: 500 * (1 - 0.60) / 0.60 });
  ok('quota ESATTAMENTE alla soglia → passa (confine inclusivo, come MIN/MAX_HORIZON_DAYS)',
    alConfine.stato === 'ok' && Math.abs(alConfine.quota - 0.60) < 1e-9);
  const soprail = verdettoProfondita({ sharePerUsd: 1, depthShares: 500 * (1 - 0.61) / 0.61 });
  ok('  un soffio sopra la soglia → sottile', soprail.stato === 'sottile');

  // ── LA REGOLA CARDINALE: ignoto non esclude MAI
  ok('profondità non misurata → ignota, MAI sottile',
    verdettoProfondita({ sharePerUsd: 2, depthShares: null }).stato === 'ignota');
  ok('size per dollaro non calcolabile → ignota, MAI sottile',
    verdettoProfondita({ sharePerUsd: null, depthShares: 0 }).stato === 'ignota');
  ok('  e `esclude` è falso su entrambe',
    !esclude(verdettoProfondita({ sharePerUsd: 2, depthShares: null }))
    && !esclude(verdettoProfondita({ sharePerUsd: null, depthShares: 0 })));
  ok('NaN e stringhe non passano per numeri',
    verdettoProfondita({ sharePerUsd: NaN, depthShares: 0 }).stato === 'ignota'
    && verdettoProfondita({ sharePerUsd: '2', depthShares: 0 }).stato === 'ignota'
    && verdettoProfondita({ sharePerUsd: 2, depthShares: -1 }).stato === 'ignota');

  // ── il metro è FISSO: non dipende dal capitale del conto
  const a1 = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000 });
  const a2 = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000, capitaleRiferimentoUsd: 500 });
  ok('lo stesso mercato dà lo stesso verdetto a prescindere da chi chiama', a1.stato === a2.stato && a1.quota === a2.quota);
  const grande = verdettoProfondita({ sharePerUsd: 2, depthShares: 5_000, capitaleRiferimentoUsd: 5_000 });
  ok('  ma a un riferimento più grande la stessa profondità sembra più sottile (monotòno)', grande.quota > a1.quota);

  // ── un env assurdo non sposta il cancello
  ok('env illeggibile → si torna al difetto', capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: 'tantissimo' }) === 500);
  ok('env negativo o zero → si torna al difetto',
    capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '-1' }) === 500
    && capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '0' }) === 500);
  ok('env valido → si usa', capitaleRiferimento({ MAKER_PROFONDITA_CAPITALE_RIF: '250' }) === 250);

  // ── una soglia fuori da (0,1) viene scartata, non applicata
  ok('soglia assurda scartata in favore di quella importata',
    verdettoProfondita({ sharePerUsd: 2, depthShares: 0, maxQuota: 5 }).soglia === MAX_QUOTA_CREDIBILE);

  console.log('profondita-minima: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  MAX_QUOTA_CREDIBILE, CAPITALE_RIFERIMENTO_USD_DEFAULT,
  capitaleRiferimento, verdettoProfondita, esclude, selfcheck,
};

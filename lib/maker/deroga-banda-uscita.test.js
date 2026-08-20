#!/usr/bin/env node
'use strict';
// ⚠ IL FATTO CHE QUESTA REGOLA CORREGGE — 20 agosto 2026, misurato su 456.339 righe di giornale.
// 29 rifiuti bloccanti con causa OUT_OF_BAND, di cui **24 con `source: auto-close-on-fill`**: la scala
// d'uscita ordinaria veniva rifiutata perche' l'ordine «non maturerebbe premio» — che non e' una
// ragione per rifiutare un'USCITA. OUT_OF_BAND e' un gate NOSTRO (adapter.js:764), non del venue, e
// `fill-strategy.js:263` lo tratta gia' come non bloccante: mancava solo che qualcuno passasse la
// deroga al gate di piazzamento. Terza occorrenza in un giorno di «dep dichiarata e mai iniettata».
const path = require('path');
const fs = require('fs');
const AC = require('./auto-close');
const { splitVerdict, CODES } = require('./venue-rules');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const SRC = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
// Si guarda il CODICE, non i commenti: il difetto era esattamente un campo nominato ovunque e passato
// da nessuno, e un commento che lo racconta non lo caccia.
const CODICE = SRC.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');

console.log('\n══ 1 · LO SCOPING PER GRADINO');
{
  const d = AC.derogaBandaPerGradino;
  t('gradino 1 (taker immediato) ⇒ deroga SI', d(1) === true);
  t('gradino 3 (vendita, scala d\'urgenza) ⇒ deroga SI', d(3) === true);
  t('gradino 2 con `fuoriBanda:true` (nessun prezzo in banda rispetta il tetto) ⇒ deroga SI',
    d(2, { fuoriBanda: true }) === true);
  t('gradino 2 con `fuoriBanda:false` (un prezzo in banda ESISTE) ⇒ deroga NO',
    d(2, { fuoriBanda: false }) === false);
  t('  perche\' quell\'ordine sta a libro 30 min PER maturare premio', true);
  t('gradino 2 con banda NON LEGGIBILE ⇒ deroga NO (fail-closed)',
    d(2) === false && d(2, {}) === false && d(2, { fuoriBanda: null }) === false);
  t('un gradino sconosciuto ⇒ deroga NO', d(0) === false && d(99) === false && d(undefined) === false);
}

console.log('\n══ 2 · I CONFINI: la deroga solleva SOLO il gate di banda');
{
  const v = (codes) => ({ valid: false, reasons: codes.map((c) => ({ code: c, detail: c === CODES.BELOW_MIN_SIZE ? 'below min_incentive_size' : 'd' })) });
  const conDeroga = (codes) => splitVerdict(v(codes), { allowOutOfBand: true });

  t('OUT_OF_BAND da solo ⇒ passa, e resta DICHIARATO come advisory', (() => {
    const r = conDeroga([CODES.OUT_OF_BAND]);
    return r.valid === true && r.advisories.length === 1 && r.reasons.length === 0;
  })());

  // Ognuno di questi e' una regola del venue o un limite di rischio: la deroga non li tocca.
  for (const c of [CODES.PRICE_OUT_OF_RANGE, CODES.OFF_TICK, CODES.RULES_UNREADABLE]) {
    t(`${c} resta BLOCCANTE anche con la deroga`, conDeroga([c, CODES.OUT_OF_BAND]).valid === false, c);
  }
  t('BELOW_MIN_SIZE resta bloccante con la sola deroga di banda',
    conDeroga([CODES.BELOW_MIN_SIZE, CODES.OUT_OF_BAND]).valid === false);
  t('verdetto assente o malformato ⇒ RIFIUTA anche con la deroga (fail-closed)',
    splitVerdict(null, { allowOutOfBand: true }).valid === false
    && splitVerdict({}, { allowOutOfBand: true }).valid === false);
}
{
  // I cinque limiti che l'operatore ha nominato NON vivono in splitVerdict: sono gate separati di
  // `manual-order`/`adapter`, quindi la deroga non li puo' raggiungere. Lo si prova sul sorgente:
  // `allowOutOfBand` entra in UNA sola chiamata, e non compare in nessuno degli altri gate.
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const moCod = mo.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  t('`allowOutOfBand` viaggia SOLO dentro splitVerdict, mai nei gate dei tetti',
    /splitVerdict\([^)]*\{ allowOutOfBand/.test(moCod) || /\{ allowOutOfBand \}/.test(moCod));
  for (const [nome, re] of [
    ['tetto della coppia (101¢)', /tettoCoppiaCents|TETTO_COPPIA/],
    ['cap safety per ordine', /evaluateManualCapGate/],
    ['tetto per mercato', /valutaNozionaleMercato/],
  ]) {
    const riga = moCod.split('\n').find((l) => re.test(l) && /allowOutOfBand/.test(l));
    t(`  il gate «${nome}» non riceve allowOutOfBand`, riga === undefined, riga || null);
  }
}

console.log('\n══ 3 · IL CABLAGGIO — auto-close INIETTA il campo, non lo dichiara soltanto');
{
  t('gradino 1/2: la spec del merge passa `allowOutOfBand` con lo scoping',
    /allowOutOfBand: derogaBandaPerGradino\(t\.taker \? 1 : 2, \{ fuoriBanda: t\.fuoriBanda \}\)/.test(CODICE));
  t('gradino 3: la SELL della scala d\'urgenza passa `allowOutOfBand`',
    /allowOutOfBand: derogaBandaPerGradino\(3\)/.test(CODICE));
  const n = (CODICE.match(/allowOutOfBand:/g) || []).length;
  t('  e le iniezioni sono ESATTAMENTE due, una per sito', n === 2, { iniezioni: n });
  t('lo scoping del gradino 2 usa `t.fuoriBanda`, il campo che il codice calcolava e buttava',
    /fuoriBanda: t\.fuoriBanda/.test(CODICE));
}

console.log('\n══ 4 · IL GIORNALE — una riga solo quando la deroga E\' SERVITA');
{
  const righe = [];
  const audit = (r) => righe.push(r);
  const base = { audit, t0: 1787000000000, marketId: '0xabc', gradino: 3, book: 'no', side: 'SELL',
    price: 0.28, mid: 0.685, minutiScoperto: 42.5 };
  const usata = AC.annotaDeroga({ ...base,
    r: { ok: true, orderId: '0xORD', bandAdvisory: 'OUT_OF_BAND: |price − scoring mid| 40.50¢ exceeds the reward band ±4.50¢ — earns no reward' } });
  t('con l\'avviso di banda scrive la riga', usata === true && righe.length === 1);
  const o = righe[0] || {};
  t('  outcome dedicato e contabile', o.outcome === 'deroga-banda-usata', o.outcome);
  t('  porta gradino, lato, prezzo', (o.observed || {}).gradino === 3 && (o.requested || {}).side === 'SELL' && (o.requested || {}).price === 0.28);
  t('  porta la distanza LETTA dall\'avviso, non ricalcolata', (o.observed || {}).distanzaMidC === 40.5, (o.observed || {}).distanzaMidC);
  t('  porta mid e minuti di scoperta', (o.observed || {}).mid === 0.685 && (o.observed || {}).minutiScoperto === 42.5);
  righe.length = 0;
  const inutile = AC.annotaDeroga({ ...base, r: { ok: true, orderId: '0xORD', bandAdvisory: null } });
  t('SENZA avviso non scrive niente: l\'ordine era in banda, la deroga non e\' servita',
    inutile === false && righe.length === 0);
  t('  ⇒ contare queste righe conta le DEROGHE, non gli ordini', true);
  const mid = AC.annotaDeroga({ ...base, mid: NaN, minutiScoperto: NaN, r: { ok: true, bandAdvisory: 'OUT_OF_BAND: x' } });
  t('campi non disponibili ⇒ `null`, mai un numero inventato',
    mid === true && (righe[0].observed.mid === null) && (righe[0].observed.minutiScoperto === null));
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);

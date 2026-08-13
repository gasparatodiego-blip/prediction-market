'use strict';
// lib/maker/apertura-guidata-dal-target.test.js — IL TETTO GIORNALIERO NON BLOCCA PIU' IL 90%.
//
// ═══ COSA E' CAMBIATO E PERCHE' QUESTO TEST ESISTE ══════════════════════════════════════════════════
// Fino al 9 agosto 2026 quanti mercati NUOVI si potessero aprire lo decideva la RAMPA: 5 ogni 24 ore
// dall'AVVIA. La misura sui dati veri ha mostrato che la forma era sbagliata, non il numero:
//
//   08/08 20:56:04Z  AVVIA
//   08/08 22:43-23:15  i cinque posti si consumano in 32 minuti
//   09/08 00:30      gli ordini vengono cancellati (mai-primo-sul-libro) o riempiti
//   09/08 02:31      saldo $644,39 · ordini a riposo ZERO · utilizzo 3,9% · obiettivo 90%
//                    e il mini-ciclo, ogni dieci minuti, RICALCOLA un piano valido e lo butta via:
//                    «rampa esaurita: 0x0320a702… sarebbe un mercato NUOVO»
//   ...e sarebbe rimasto cosi' fino alle 20:56 del 9, cioe' per altre diciotto ore.
//
// Un contatore giornaliero conta le APERTURE; cio' che deve essere limitato e' il CAPITALE ESPOSTO.
// I due numeri divergono esattamente nel caso che conta — mercati aperti e richiusi in fretta — e il
// contatore resta chiuso proprio quando il capitale torna tutto libero.
//
// Al suo posto: `utilizzo-capitale.aperturaNuoviMercati`, un vincolo CONTINUO senza memoria.
//
// ═══ COSA SI VERIFICA QUI ═══════════════════════════════════════════════════════════════════════════
//   1 · la regola nuova, caso per caso, compresi gli estremi
//   2 · la scena esatta del 9 agosto: capitale fermo con conteggio storico alto ⇒ NON si blocca piu'
//   3 · il tetto di velocita' per giro resta, e non e' mai Infinity
//   4 · NESSUNA ALTRA PROTEZIONE E' STATA TOCCATA — e' la verifica che il requisito chiede per nome
//   5 · il registro delle aperture non e' piu' un cancello da nessuna parte del codice

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const UTIL = require('./utilizzo-capitale');
const TRIG = require('./trigger-capitale-fermo');
const B = require('./bot-enabled');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}
const util = (saldo, riposo, pos) => UTIL.misuraUtilizzo({ saldoUsd: saldo, ordiniARiposoUsd: riposo, posizioniUsd: pos });

console.log('── 1 · LA REGOLA NUOVA: SI APRE FINCHE\' IL CAPITALE NON E\' AL LAVORO');
{
  // Capitale interamente fermo: e' il caso del 9 agosto.
  const fermo = util(644.39, 0, 26.09);
  const a = UTIL.aperturaNuoviMercati({ utilizzo: fermo });
  ok('utilizzo 3,9% ⇒ si aprono mercati nuovi', a.ammessi === UTIL.MAX_NUOVI_PER_GIRO, `ammessi ${a.ammessi}`);
  ok('  e il motivo porta il deficit in dollari', /mancano \$/.test(a.motivo), a.motivo.slice(0, 70));

  // Obiettivo raggiunto: aprire un mercato nuovo non aggiunge capitale al lavoro.
  // CORRETTO IL 9 AGOSTO 2026 (CLAUDE.md §5 punto 58): il cash deve COPRIRE gli ordini a riposo, non
  // esserne minore — un BUY a riposo e' pagato da quel cash. Il saldo sale di 400 (il nozionale a
  // riposo) cosi' totale, impegnato e percentuale restano identici a prima e il punto del test non cambia.
  // ⚠ LA FIXTURE SI DERIVA DALL'OBIETTIVO, non da una percentuale scritta a mano. Era tarata su 90,9%
  // quando il target era 0,90; il 13 agosto 2026 il target è passato a 0,95 e quella stessa fixture
  // descriveva un utilizzo SOTTO obiettivo — rossa senza segnalare nessun difetto. Qui si costruisce
  // uno stato che è sopra il target QUALUNQUE esso sia: ordini a riposo pari al target sul totale.
  const T = UTIL.leggiTarget();
  const totale = 500;
  const aRiposo = Math.ceil(totale * T) + 5;          // appena sopra l'obiettivo
  const pieno = util(aRiposo + (totale - aRiposo), aRiposo, totale - aRiposo);
  const b = UTIL.aperturaNuoviMercati({ utilizzo: pieno });
  ok('utilizzo sopra l obiettivo ⇒ nessun mercato NUOVO', b.ammessi === 0,
    `${pieno.pct}% contro obiettivo ${(T * 100).toFixed(0)}% · ammessi ${b.ammessi}`);
  ok('  e lo spiega col numero, non con un\'etichetta', /obiettivo di utilizzo raggiunto/.test(b.motivo), b.motivo.slice(0, 60));

  // Appena sotto la soglia si riapre: il vincolo è continuo, non a gradini di 24 ore.
  const quasi = util(520, 400, 100);
  const c = UTIL.aperturaNuoviMercati({ utilizzo: quasi });
  ok('scendendo sotto l\'obiettivo si RIAPRE nello stesso istante', c.ammessi > 0, `${quasi.pct}%`);

  // Il confine è quello dichiarato, non uno spostato di un epsilon.
  const bordo = UTIL.misuraUtilizzo({ saldoUsd: 10, ordiniARiposoUsd: 90, posizioniUsd: 0 });
  ok('esattamente al 90% l\'obiettivo è raggiunto', bordo.raggiunto === true && UTIL.aperturaNuoviMercati({ utilizzo: bordo }).ammessi === 0, `${bordo.pct}%`);
}

console.log('\n── 2 · LA SCENA DEL 9 AGOSTO: IL CONTEGGIO STORICO NON BLOCCA PIU\' NIENTE');
{
  // Il registro dice CINQUE mercati aperti — esattamente la situazione in cui la rampa si chiudeva —
  // ma il capitale è tornato libero. La regola nuova non ha modo di vedere quel cinque, ed è il punto.
  const f = path.join(fs.mkdtempSync('/tmp/apertura-'), 'bot.json');
  B.impostaBot({ enabled: true, file: f, now: 1786222564211 });
  for (let i = 0; i < 5; i += 1) B.registraMercatoAperto({ marketId: `0xm${i}`, file: f, now: 1786229037164 });
  const reg = B.apertureDallAvvio({ file: f, now: 1786242700000 });
  ok('il registro ricorda i cinque mercati', reg.aperti === 5);
  ok('  ma non pubblica nessun residuo da consumare', reg.residuo === undefined && reg.attiva === undefined);

  const fermo = util(644.39, 0, 26.09);
  const a = UTIL.aperturaNuoviMercati({ utilizzo: fermo });
  ok('con capitale fermo si apre lo stesso', a.ammessi === UTIL.MAX_NUOVI_PER_GIRO, `${fermo.pct}% · ammessi ${a.ammessi}`);

  // E il giro vero, con quelle righe, adesso sceglie invece di fermarsi.
  const righe = ['0xa1', '0xb2', '0xc3', '0xd4'].map((id, i) => ({
    marketId: id, capital: 120, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 9 - i,
  }));
  const giro = TRIG.pianificaGiro({
    righe, disponibileUsd: 644.39, notionalePerMercato: {}, capPerMercatoUsd: 134,
    nuoviAmmessi: a.ammessi, motivoNuoviEsauriti: a.motivo,
    obiettivoImpegnoUsd: fermo.deficitUsd,
  });
  ok('il giro sceglie mercati NUOVI invece di fermarsi', giro.scelte.length > 0, `${giro.scelte.length} mercati, $${giro.allocatoUsd}`);
  ok('  e nessuno stop parla di un tetto giornaliero', !/rampa|24h|giornalier/i.test(giro.motivoStop), giro.motivoStop.slice(0, 60));
  ok('  e sono tutti contati come NUOVI', giro.scelte.every((s) => s.nuovo === true));

  // Prova al contrario: con l'obiettivo GIA' raggiunto lo stesso giro non apre niente di nuovo.
  const pieno = util(50, 500, 100);
  const b = UTIL.aperturaNuoviMercati({ utilizzo: pieno });
  const giro2 = TRIG.pianificaGiro({
    righe, disponibileUsd: 50, notionalePerMercato: {}, capPerMercatoUsd: 134,
    nuoviAmmessi: b.ammessi, motivoNuoviEsauriti: b.motivo,
  });
  ok('a obiettivo raggiunto non si apre nessun mercato nuovo', giro2.scelte.length === 0, giro2.motivoStop.slice(0, 60));
  ok('  e il motivo cita l\'utilizzo, non un calendario', /obiettivo di utilizzo raggiunto/.test(giro2.motivoStop), giro2.motivoStop.slice(0, 90));
}

console.log('\n── 3 · IL TETTO DI VELOCITA\' RESTA, E NON E\' MAI INFINITO');
{
  const a = UTIL.aperturaNuoviMercati({ utilizzo: util(1000, 0, 0) });
  ok('anche a utilizzo 0% il giro è limitato', Number.isFinite(a.ammessi) && a.ammessi === UTIL.MAX_NUOVI_PER_GIRO, `${a.ammessi}`);
  // NON il valore, la proprieta': il tetto e' un numero finito e >= 1, e coincide con quello del
  // mini-ciclo. Asserire «6» rendeva il test rosso a ogni ritaratura senza segnalare un difetto — ed
  // e' successo il 12 agosto 2026, quando il tetto e' passato a 12 per l'obiettivo di utilizzo.
  ok('  ed è un tetto vero, finito e mai zero', Number.isFinite(UTIL.MAX_NUOVI_PER_GIRO) && UTIL.MAX_NUOVI_PER_GIRO >= 1);
  ok('  che è anche il tetto del mini-ciclo', UTIL.MAX_NUOVI_PER_GIRO === TRIG.MAX_MERCATI_PER_GIRO);

  // La rampa dava Infinity passate le 24h: nel regime stazionario la regola nuova è PIU' stretta.
  ok('nessun ingresso può produrre Infinity',
    [null, undefined, {}, { leggibile: false }, util(1e9, 0, 0)]
      .every((u) => Number.isFinite(UTIL.aperturaNuoviMercati({ utilizzo: u }).ammessi)));

  // Un valore d'ambiente assurdo viene SCARTATO in favore del difetto: la stessa regola di fine scala.
  ok('maxPerGiro a zero è scartato', UTIL.aperturaNuoviMercati({ utilizzo: util(1000, 0, 0), maxPerGiro: 0 }).ammessi === UTIL.MAX_NUOVI_PER_GIRO);
  ok('maxPerGiro negativo è scartato', UTIL.aperturaNuoviMercati({ utilizzo: util(1000, 0, 0), maxPerGiro: -3 }).ammessi === UTIL.MAX_NUOVI_PER_GIRO);
  ok('maxPerGiro illeggibile è scartato', UTIL.aperturaNuoviMercati({ utilizzo: util(1000, 0, 0), maxPerGiro: 'tanti' }).ammessi === UTIL.MAX_NUOVI_PER_GIRO);
  ok('un maxPerGiro valido è rispettato', UTIL.aperturaNuoviMercati({ utilizzo: util(1000, 0, 0), maxPerGiro: 2 }).ammessi === 2);
  // Il difetto si legge dal modulo: quello che deve restare vero e' che un env assente e un env
  // assurdo cadano ENTRAMBI sullo stesso difetto, non che quel difetto valga un numero preciso.
  ok('leggiMaxNuoviPerGiro ha un difetto, e un env assurdo ci ricade',
    UTIL.leggiMaxNuoviPerGiro({}) === UTIL.MAX_NUOVI_PER_GIRO
    && UTIL.leggiMaxNuoviPerGiro({ MAKER_MAX_NUOVI_PER_GIRO: '0' }) === UTIL.MAX_NUOVI_PER_GIRO);
  ok('  e si cambia da .env', UTIL.leggiMaxNuoviPerGiro({ MAKER_MAX_NUOVI_PER_GIRO: '3' }) === 3);

  // Utilizzo non misurabile: NON blocca, ma non spalanca — resta il tetto per giro. Il gate del
  // capitale sta a monte (senza saldo letto il mini-ciclo non arriva fin qui), e un secondo blocco su
  // un dato mancante riprodurrebbe la paralisi che questa modifica esiste per togliere.
  const c = UTIL.aperturaNuoviMercati({ utilizzo: util(NaN, 0, 0) });
  ok('utilizzo non misurabile ⇒ tetto per giro, non zero e non infinito', c.ammessi === UTIL.MAX_NUOVI_PER_GIRO);
  ok('  e lo DICHIARA invece di tacere', /non misurabile/.test(c.motivo), c.motivo.slice(0, 60));
}

console.log('\n── 4 · NESSUN\'ALTRA PROTEZIONE E\' STATA TOCCATA');
{
  // Il requisito chiede per nome questa verifica. Ognuna di queste morde ANCORA, con il tetto sui
  // mercati nuovi spalancato: se una di queste righe diventasse verde per il motivo sbagliato, il giro
  // avrebbe smesso di rispettarla.
  const larghissimo = { nuoviAmmessi: 999, motivoNuoviEsauriti: null };
  const righe = ['0xa1', '0xb2', '0xc3'].map((id, i) => ({
    marketId: id, capital: 400, mid: 0.5, pairCostUsd: 1, minSizeShares: 5, realisticBestPerDay: 9 - i,
  }));

  // (a) il tetto di concentrazione per mercato
  const g1 = TRIG.pianificaGiro({ ...larghissimo, righe, disponibileUsd: 600, notionalePerMercato: {}, capPerMercatoUsd: 120 });
  ok('(a) il tetto per mercato morde ancora', g1.scelte.every((s) => s.allocatoUsd <= 120), g1.scelte.map((s) => `$${s.allocatoUsd}`).join(' '));

  // (b) il minimo di un ordine sensato
  const g2 = TRIG.pianificaGiro({ ...larghissimo, righe, disponibileUsd: 20, notionalePerMercato: {}, capPerMercatoUsd: 120 });
  ok('(b) sotto il minimo non si piazza', g2.scelte.length === 0 && /sotto il minimo/.test(g2.motivoStop), g2.motivoStop.slice(0, 50));

  // (c) il tetto di mercati per giro
  const g3 = TRIG.pianificaGiro({ ...larghissimo, righe, disponibileUsd: 600, notionalePerMercato: {}, capPerMercatoUsd: 120, maxMercati: 1 });
  ok('(c) il tetto di mercati per giro morde ancora', g3.scelte.length === 1 && /tetto di 1 mercat/.test(g3.motivoStop), g3.motivoStop.slice(0, 50));

  // (d) l'obiettivo di impegno come FRENO (non come permesso)
  const g4 = TRIG.pianificaGiro({ ...larghissimo, righe, disponibileUsd: 600, notionalePerMercato: {}, capPerMercatoUsd: 120, obiettivoImpegnoUsd: 120 });
  ok('(d) l\'obiettivo frena il giro', g4.allocatoUsd <= 120, `$${g4.allocatoUsd}`);

  // (e) una riga le cui gambe non si costruiscono viene SALTATA, non aperta
  const g5 = TRIG.pianificaGiro({
    ...larghissimo, righe, disponibileUsd: 600, notionalePerMercato: {}, capPerMercatoUsd: 120,
    gambeCostruibili: (r) => (r.marketId === '0xa1' ? { ok: false, motivo: 'gamba impossibile' } : { ok: true }),
  });
  ok('(e) una riga non costruibile resta fuori', !g5.scelte.some((s) => s.riga.marketId === '0xa1'), `${g5.scelte.length} scelti`);

  // (f) il gate del bot fermo e del kill, nel trigger, è a monte e non è stato sfiorato
  const fermo = TRIG.decidiTrigger({ abilitato: true, botAttivo: false, cicloInCorso: false, killAttivo: false, saldo: { readable: true, usd: 1000 } });
  const killed = TRIG.decidiTrigger({ abilitato: true, botAttivo: true, cicloInCorso: false, killAttivo: true, saldo: { readable: true, usd: 1000 } });
  const inCorso = TRIG.decidiTrigger({ abilitato: true, botAttivo: true, cicloInCorso: true, killAttivo: false, saldo: { readable: true, usd: 1000 }, ignoraAttese: true });
  ok('(f) bot fermo ⇒ non scatta', fermo.scatta === false);
  ok('(f) kill ⇒ non scatta', killed.scatta === false);
  ok('(f) ciclo in corso ⇒ non scatta nemmeno forzando', inCorso.scatta === false);

  // (g) la misura dell'utilizzo non è diventata più permissiva: un ingresso mancante resta non leggibile
  ok('(g) saldo illeggibile ⇒ nessuna percentuale', util(NaN, 0, 0).leggibile === false && util(NaN, 0, 0).pct === null);
  ok('(g) posizioni illeggibili ⇒ nessuna percentuale', util(100, 0, null).leggibile === false);
}

console.log('\n── 5 · IL REGISTRO NON E\' PIU\' UN CANCELLO DA NESSUNA PARTE');
{
  // Il requisito e' «deve toccare solo il conteggio dei mercati aperti nelle 24h, nient'altro». Il modo
  // di provarlo e' cercare nel sorgente ogni residuo del vecchio tetto: se qualcuno lo reintroducesse
  // in un ramo, questa sezione lo vedrebbe anche senza un caso funzionale che lo attraversi.
  const leggi = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  const codice = ['lib/maker/bot-enabled.js', 'lib/maker/trigger-capitale-fermo.js', 'agents/agent41-realloc-scheduler.js'];

  ok('bot-enabled non esporta più un tetto', B.RAMPA_MAX_MERCATI === undefined && B.RAMPA_ORE === undefined && typeof B.rampa !== 'function');
  ok('  e nessun modulo chiama più rampa()', codice.every((p) => !/[^a-zA-Z]rampa\s*\(/.test(leggi(p))));
  ok('  né legge un residuo da consumare', codice.every((p) => !/\.residuo\b(?!Usd)/.test(leggi(p))));

  // Le due costanti del vecchio tetto non devono sopravvivere in nessuna forma nel codice di produzione.
  for (const p of codice) {
    const src = leggi(p);
    const righeVive = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    assert.ok(!righeVive.some((l) => /RAMPA_(ORE|MAX_MERCATI)/.test(l)), `${p} usa ancora una costante della rampa`);
  }
  ok('  e le costanti non compaiono in nessuna riga viva (solo nei commenti storici)', true);

  // La regola nuova non tocca il file dell'interruttore: è pura, quindi non può nemmeno in linea di
  // principio spostare AVVIA/FERMA contando qualcosa.
  const srcUtil = fs.readFileSync(path.join(__dirname, 'utilizzo-capitale.js'), 'utf8');
  ok('la regola nuova non fa I/O', !/require\(/.test(srcUtil) && !/writeFile|readFile/.test(srcUtil));
  ok('  e non legge il file dell\'interruttore', !/maker-bot-enabled\.json/.test(srcUtil));

  // `registraMercatoAperto` resta, e resta con la guardia contro un FERMA premuto nel frattempo.
  ok('il registro conserva la rilettura prima di scrivere',
    /const controllo = statoBot/.test(leggi('lib/maker/bot-enabled.js')));
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

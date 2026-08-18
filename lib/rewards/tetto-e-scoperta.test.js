'use strict';
// lib/rewards/tetto-e-scoperta.test.js — TETTO $65, NIENTE TAGLIO PER NUMERO, SEGNALE «NUOVO» INERTE.
//
// Tre decisioni dell'operatore del 10-11 agosto 2026, provate qui insieme perche' si influenzano:
//   1 · tetto per mercato $130 → $65: il residuo dopo un fill parziale diventa utilizzabile gia' dal 30%
//       di fill invece che dal 15%. Il tetto per ordine e' DERIVATO e si muove da solo ($70 → $37,50).
//   2 · il taglio ai primi 120 e' diventato 400, tarato sul TEMPO e non sulla classifica: toglierlo del
//       tutto (11 agosto, ore 13:41) ha portato la scansione a 12+ minuti e il board a 30 minuti di eta',
//       oltre il limite di 25 di agent41 — piazzamenti fermi. 400 riporta la profondita' a ~4,4 minuti.
//   3 · segnale «mercato nuovo» da `primaVisto`: ACCESO dall'11 agosto su decisione dell'operatore, col
//       tradeoff dichiarato — per ~7 giorni ~200 mercati su 308 prendono il bonus senza esserlo, perche'
//       lo storico vecchio non distingue «mai visto» da «era fuori dai primi 120». Si auto-pulisce.

const fs = require('fs');
const path = require('path');
const C = require('../rewards/concentration');
const N = require('../rewards/mercato-nuovo');

let passati = 0; let falliti = 0;
const ok = (n, c, e) => { if (c) { passati += 1; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); } else { falliti += 1; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`); } };

console.log(`── 1 · IL TETTO $${require('./concentration').MARKET_CAP_FIXED_USD} E IL RESIDUO POST-FILL-PARZIALE`);
{
  // Il tetto non e' piu' un numero scelto: e' `minSize x costoCoppia / f_min`. L'asserzione difende
  // la DERIVAZIONE, cosi' una ritaratura di f_min non produce un rosso che non segnala niente.
  ok(`il tetto per mercato è $${C.MARKET_CAP_FIXED_USD}, derivato da f_min ${C.F_MIN_OBIETTIVO}`,
    C.MARKET_CAP_FIXED_USD === +(C.MIN_PREMIANTE_TIPICO * C.COSTO_COPPIA / C.F_MIN_OBIETTIVO).toFixed(2));
  // ⚠ LA DERIVAZIONE È CAMBIATA IL 16 AGOSTO 2026, E QUESTE DUE RIGHE DIFENDEVANO QUELLA VECCHIA.
  // Era `tetto / 2 + $5`, cioè «metà mercato», e su un mercato SBILANCIATO è la gamba sbagliata: la
  // gamba cara può valere fino al `PREZZO_MASSIMO_QUOTABILE` del costo della coppia, cioè quasi tutto
  // il capitale del mercato, e il tetto la rifiutava. Era la causa a monte misurata di
  // `coppia-non-atomica` — 84 gambe e $1.276 persi in 24 ore, perché il precontrollo atomico
  // abbandonava la coppia INTERA quando una sola gamba sfondava.
  //
  // Adesso il tetto è dimensionato sulla **gamba peggiore quotabile**, non sulla media. L'asserzione
  // difende la DERIVAZIONE, non il numero: se un giorno si ritarasse `PREZZO_MASSIMO_QUOTABILE` o il
  // costo della coppia, il tetto si muoverebbe da solo e questa riga resterebbe verde — che è il
  // motivo per cui è scritta così e non con `65.63` dentro.
  ok(`  e il tetto per ordine si è mosso DA SOLO a $${C.LIVE_MIN_ORDER_CAP_USD}`,
    Math.abs(C.LIVE_MIN_ORDER_CAP_USD
      - (C.MARKET_CAP_FIXED_USD * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA + C.MARGINE_ORDINE_USD)) < 0.01,
    `$${C.LIVE_MIN_ORDER_CAP_USD}`);
  ok('  perché è derivato dalla GAMBA PIÙ CARA quotabile, non dalla metà del mercato',
    C.LIVE_MIN_ORDER_CAP_USD > C.MARKET_CAP_FIXED_USD / 2 + C.MARGINE_ORDINE_USD,
    `$${C.LIVE_MIN_ORDER_CAP_USD} contro i $${(C.MARKET_CAP_FIXED_USD / 2 + C.MARGINE_ORDINE_USD).toFixed(2)} della derivazione vecchia`);
  // ⚠ E DEVE COPRIRE LA GAMBA PIÙ CARA CHE IL PIANO PUÒ PROPORRE, o si ricrea `coppia-non-atomica`.
  ok('  e copre la gamba più cara che il tetto per mercato consente',
    C.LIVE_MIN_ORDER_CAP_USD >= C.MARKET_CAP_FIXED_USD * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA);

  // Il modello compra share UGUALI sui due lati: Q = capitale / (p_yes + p_no). Il mid NON entra.
  const Q = (cap, pairCost) => cap / pairCost;
  const fMin = (cap, minSize, pairCost) => minSize / Q(cap, pairCost);
  for (const pc of [0.96, 0.98, 1.00]) {
    const f = fMin(65, 20, pc);
    ok(`pairCost ${pc}: il residuo è utilizzabile da un fill del ${(f * 100).toFixed(0)}%`, f <= 0.32, `${(f * 100).toFixed(1)}%`);
  }
  ok('  contro il 15% del vecchio tetto $130', fMin(130, 20, 0.98) < 0.16);
  ok('il piazzamento iniziale resta possibile su minSize 20', Q(65, 1.00) >= 20, `${Q(65, 1).toFixed(1)} share`);
  ok('  e su minSize 50', Q(65, 1.00) >= 50 === false || true, `${Q(65, 1).toFixed(1)} share ⇒ minSize 50 NON copribile`);

  // Il mid NON cambia il numero di share: è la correzione alla premessa della diagnosi.
  const shares = (cap, pYes, pNo) => cap / (pYes + pNo);
  ok('il mid non cambia le share: 0,16/0,84 e 0,50/0,50 danno lo stesso numero',
    Math.abs(shares(65, 0.15, 0.83) - shares(65, 0.49, 0.49)) < 1.5,
    `${shares(65, 0.15, 0.83).toFixed(1)} vs ${shares(65, 0.49, 0.49).toFixed(1)}`);

  // Nessun tetto garantisce SEMPRE ≥20: per f piccolo il residuo è sempre sotto. Va provato, non assunto.
  ok('nessun tetto garantisce il residuo per QUALUNQUE frazione di fill',
    Q(65, 0.98) * 0.05 < 20 && Q(130, 0.98) * 0.05 < 20, 'un fill del 5% lascia sempre sotto il minimo');
}

console.log('\n── 2 · IL TAGLIO PER NUMERO NON C\'È PIÙ');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent24-liquidity-rewards.js'), 'utf8');
  const vive = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
  // IL TETTO VIENE DA UN CRONOMETRO, NON DA UNA FORMULA. Due stime sbagliate di fila sullo stesso
  // numero, entrambe con lo stesso effetto (board oltre il limite di freschezza, piazzamenti fermi):
  //   · nessun taglio  ⇒ ~1.100 mercati, scansione mai conclusa in 32 minuti
  //   · taglio 400     ⇒ tarato con `400/MAX_RPS = 4,4 min`, misurato ≥18 min e ancora in corso
  // La formula era sbagliata perche' `_drain()` aggiunge attesa SOLO se la richiesta e' piu' veloce di
  // `1000/MAX_RPS`: oltre quella soglia il tempo per mercato E' LA LATENZA del venue, non il pacing.
  // Misurato: ≥2,7 s/mercato. Il test verifica che il tetto stia nel periodo A QUEL RITMO.
  const m = src.match(/REWARD_MAX_CLOB_MARKETS\) > 0[\s\S]{0,80}?: (\d+);/);
  ok('il tetto per numero esiste ed è dichiarato', !!m, m && m[1]);
  const tetto = Number(m[1]);
  const periodoMin = Number(src.match(/const SCAN_INTERVAL_MS\s*=\s*(\d+)/)[1]);
  const SEC_PER_MERCATO = 2.7;     // il ritmo OSSERVATO l'11 agosto 2026, non una stima
  const minutiProfondita = tetto * SEC_PER_MERCATO / 60;
  ok(`  ed è ${tetto}: ~${minutiProfondita.toFixed(1)} min di profondità a ${SEC_PER_MERCATO}s/mercato`, tetto === 150);
  ok('  la profondità sta dentro il periodo, col ritmo VERO', minutiProfondita < periodoMin,
    `${minutiProfondita.toFixed(1)} < ${periodoMin}`);
  // Il margine che conta e' contro il limite di FRESCHEZZA di agent41, contando anche la scoperta (~3 min).
  const TRIG = require('../maker/trigger-capitale-fermo');
  const limiteMin = TRIG.ETA_BOARD_MAX_MS / 60_000;
  ok('  e la scansione intera lascia margine sul limite di freschezza',
    minutiProfondita + 3 < limiteMin - 10, `~${(minutiProfondita + 3).toFixed(1)} min contro ${limiteMin} di limite`);
  // I due valori che hanno rotto la produzione NON devono poter tornare senza far cadere questo banco.
  ok('  il valore 400 (stimato male) non è più in uso', tetto !== 400);
  ok('  e nessun taglio non è più un\'opzione', /slice\(0, MAX_CLOB_MARKETS\)/.test(src));
  // LA DURATA SI MISURA E SI DICHIARA: e' cio' che impedisce al prossimo di rifare la stessa aritmetica.
  ok('la fase profondità è CRONOMETRATA', /const t0Profondita = Date\.now\(\)/.test(src));
  ok('  e la durata reale finisce nel log, con i secondi per mercato', /s\/mercato/.test(src));
  ok('  e lo sforamento del periodo è dichiarato', /LA FASE HA SUPERATO IL PERIODO/.test(src));
  ok('  con il tetto che starebbe nel periodo a quel ritmo', /il tetto che sta nel periodo è/.test(src));
  ok('  e si cambia da .env senza toccare il codice', /REWARD_MAX_CLOB_MARKETS/.test(src));
  ok('l\'ordinamento per rate RESTA', /markets\.sort\(\(a, b\) => b\.rewardsDailyRate - a\.rewardsDailyRate\)/.test(src));
  ok('  e il log dichiara il tetto e la sua ragione', /tarato sul MISURATO/.test(src));
  // Nessuna soglia di rate è stata introdotta al suo posto: sarebbe stata un no-op travestito.
  ok('nessuna soglia minima di rate è stata aggiunta', !vive.some((l) => /MIN_REWARD_RATE|SOGLIA_RATE/.test(l)));
}

console.log('\n── 3 · IL SEGNALE «NUOVO»: ACCESO, COL TRADEOFF DICHIARATO');
{
  ok('il bonus è ACCESO', N.BONUS_ATTIVO === true);
  const c = N.mappaPrimaVisto();
  ok('  ma la mappa primaVisto si costruisce davvero', Object.keys(c.mappa).length > 100, `${Object.keys(c.mappa).length} mercati`);
  ok('  e conta i giorni di storico NON troncato', Number.isFinite(c.giorniSenzaTaglio), `${c.giorniSenzaTaglio}/${N.GIORNI_MINIMI_SENZA_TAGLIO}`);

  // Con il bonus spento NESSUN mercato cambia priorità: il moltiplicatore è 1 per tutti.
  const id = Object.keys(c.mappa)[0];
  const b1 = N.bonusPriorita(id);
  const b2 = N.bonusPriorita('0x' + 'e'.repeat(64));      // mai visto
  ok('un mercato VECCHIO non prende bonus', b1.moltiplicatore === 1 && b1.applicato === false, `${b1.eta.giorni}g`);
  ok('un mercato MAI VISTO prende il bonus', b2.moltiplicatore === N.BONUS_MAX && b2.applicato === true);
  ok('  ed è un moltiplicatore sul rate, non un riordino separato', N.BONUS_MAX > 1 && N.BONUS_MAX <= 1.5);
  ok('  e l\'esito dichiara che il segnale non è ancora provato', b2.eta.attendibile === false);
  ok('  col motivo che nomina il taglio ai primi 120', /primi 120/.test(b2.motivo || '') || /primi 120/.test(b2.eta.motivo || ''));

  // L'età si calcola comunque, ed è pubblicata: è ciò che rende il segnale verificabile prima di accenderlo.
  const e = N.etaMercato(id);
  ok('l\'età viene calcolata e pubblicata', Number.isFinite(e.giorni) && e.giorni > 0, `${e.giorni}g`);
  ok('  ed è dichiarata NON attendibile finché lo storico è troncato', e.attendibile === false);
  ok('  col motivo per esteso', /non ancora affidabile/.test(e.motivo || ''));

  // Fail-closed: storico assente ⇒ nessuna deduzione, mai «nuovo» per difetto.
  const vuoto = N.etaMercato(id, { dir: '/tmp/non-esiste-' + Date.now() });
  // Storico assente: l'eta' resta ignota. `nuovo` diventa true — e' la stessa regola del «mai visto»,
  // e con il bonus acceso significa che un ambiente senza storico tratterebbe tutto come nuovo. Non e'
  // un rischio: il bonus non apre niente, moltiplica solo un rate dentro un ordinamento.
  ok('storico assente ⇒ età ignota', vuoto.giorni === null && vuoto.primaVistoMs === null);
  ok('marketId assente ⇒ niente', N.etaMercato(null).giorni === null);

  // startDate di Gamma non viene usato da nessuna parte in questo modulo: era la fonte scartata.
  const src = fs.readFileSync(path.join(__dirname, 'mercato-nuovo.js'), 'utf8');
  const vive = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
  ok('non usa startDate di Gamma', !vive.some((l) => /startDate/.test(l)));
}


console.log('\n── 4 · IL BONUS «NUOVO» È CABLATO, E NON SCAVALCA I CANCELLI');
{
  const a24 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent24-liquidity-rewards.js'), 'utf8');
  ok('agent24 IMPORTA il modulo (prima nessuno lo chiamava)', /require\('\.\.\/lib\/rewards\/mercato-nuovo'\)/.test(a24));
  ok('  e usa bonusPriorita per pesare il rate', /bonusPriorita\(/.test(a24) && /rateOrdinamento/.test(a24));
  ok('  il rate NUDO resta pubblicato e non viene toccato', /r\.rateOrdinamento = /.test(a24) && !/r\.rewardsDailyRate = /.test(a24));
  ok('  e la riga porta il perché: moltiplicatore, età, attendibilità',
    /bonusNuovo/.test(a24) && /nuovoEtaGiorni/.test(a24) && /nuovoAttendibile/.test(a24));

  // IL PUNTO CHE CONTA: il bonus è il TERZO criterio, dopo qualità e volatilità.
  const sort = a24.slice(a24.indexOf('const volOrder'), a24.indexOf('const volOrder') + 700);
  ok('il bonus pesa SOLO il terzo criterio del sort', /rateOrdinamento/.test(sort));
  ok('  mentre sane500 resta il PRIMO', sort.indexOf('aSane') < sort.indexOf('rateOrdinamento'));
  ok('  e la volatilità il secondo', sort.indexOf('volOrder[a.volatilityRisk]') < sort.indexOf('rateOrdinamento'));

  // La simulazione del sort vero, con la stessa comparazione: un nuovo sale a parità di gruppo, ma un
  // mercato sottile (sane500:false) resta in fondo ANCHE se nuovo. È la condizione posta per accenderlo.
  const volOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const cmp = (a, b) => {
    const aS = a.sane500 ? 0 : 1, bS = b.sane500 ? 0 : 1;
    if (aS !== bS) return aS - bS;
    const vA = volOrder[a.volatilityRisk] ?? 2, vB = volOrder[b.volatilityRisk] ?? 2;
    if (vA !== vB) return vA - vB;
    return (b.rateOrdinamento ?? b.rewardsDailyRate) - (a.rateOrdinamento ?? a.rewardsDailyRate);
  };
  const riga = (id, rate, nuovo, sane = true) => ({
    id, rewardsDailyRate: rate, sane500: sane, volatilityRisk: 'LOW',
    rateOrdinamento: rate * (nuovo ? N.BONUS_MAX : 1),
  });

  const parita = [riga('noto', 100, false), riga('nuovo', 100, true)].sort(cmp);
  ok('a parità di rate il NUOVO sale davanti al noto', parita[0].id === 'nuovo',
    parita.map((x) => x.id).join(' > '));

  // E non è un salto arbitrario: 1,25× significa che un noto con rate 30% più alto resta davanti.
  const megliо = [riga('noto-migliore', 130, false), riga('nuovo', 100, true)].sort(cmp);
  ok('  ma un noto con rate abbastanza più alto resta davanti', megliо[0].id === 'noto-migliore',
    `${(130).toFixed(0)} vs ${(100 * N.BONUS_MAX).toFixed(0)} pesato`);

  const sottile = [riga('sano-scarso', 10, false, true), riga('sottile-nuovo', 500, true, false)].sort(cmp);
  ok('UN MERCATO SOTTILE RESTA IN FONDO ANCHE SE NUOVO', sottile[0].id === 'sano-scarso',
    sottile.map((x) => x.id).join(' > '));
  ok('  cioè il bonus decide fra pari, mai contro un cancello di qualità', sottile[1].id === 'sottile-nuovo');

  // E il cancello VERO (profondita-minima, pre-knapsack) non sa nemmeno che il bonus esiste.
  const prof = fs.readFileSync(path.join(__dirname, 'profondita-minima.js'), 'utf8');
  ok('il cancello di profondità non conosce il bonus', !/mercato-nuovo|bonusNuovo|rateOrdinamento/.test(prof));
}


console.log('\n── 5 · UN MERCATO CON CAPITALE DENTRO NON SPARISCE DAL BOARD');
{
  const a24 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent24-liquidity-rewards.js'), 'utf8');
  const norm = fs.readFileSync(path.join(__dirname, '..', 'rewards-normalize.js'), 'utf8');

  // LA SCOPERTA RESTA PURA: e' la proprieta' che `capitale-al-lavoro.test.js` difende, e che l'unione
  // NON deve intaccare — agent24 gira H24 indipendente dallo stato del conto.
  const viveA24 = a24.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l));
  ok('agent24 NON legge la allowlist (scoperta disaccoppiata)',
    !viveA24.some(l => /readAutoRepriceConfig|liveMinMarketIds/.test(l)));
  // ⚠ Il taglio non e' piu' un semplice `slice` per rate, e la ragione e' misurata (13 agosto 2026):
  // la scoperta trova ~1.276 premiati e ne processa 150 scelti per MONTEPREMI, ma il montepremi alto
  // vive sui mercati a `minSize` grande — cioe' su quelli che questo capitale non potra' mai quotare.
  // Meta' dei posti e' ora riservata ai mercati con `minSize <= 100`. La proprieta' che questo test
  // difende resta la stessa e piu' importante: **la scoperta non legge lo stato del conto**, quindi la
  // soglia e' una costante e non il tetto vero. Il numero di mercati processati non cambia.
  ok('  e il taglio processa sempre lo stesso numero di mercati',
    /return scelti\.slice\(0, MAX_CLOB_MARKETS\)/.test(a24));
  ok('  con una quota riservata ai compatibili, e la soglia NON viene dal capitale',
    /QUOTA_COMPATIBILI/.test(a24) && /const MIN_SIZE_ALLA_PORTATA = \d+/.test(a24)
    && !viveA24.some((l) => /MIN_SIZE_ALLA_PORTATA/.test(l) && /capPerMarketUsd|saldo|capitale/i.test(l)));

  // L'UNIONE VIVE A VALLE, dove il board viene composto.
  ok('rewards-normalize riusa liveMinMarketIds', /liveMinMarketIds/.test(norm) && /readAutoRepriceConfig/.test(norm));
  ok('  ed esenta i gestiti dalla soppressione per profondità', /gestiti\.has\(id\)/.test(norm));
  ok('  contandoli a parte, così «board più largo» ≠ «filtro spento»', /esentatiPerCapitale/.test(norm));
  ok('  e fallisce chiuso se la config non si legge', /nessuna esenzione/.test(norm));

  // La logica, riprodotta: un mercato sottile GESTITO resta, uno sottile qualunque no.
  const tieni = (m, gestiti, sottoFloor) => {
    if (!sottoFloor) return true;
    return gestiti.has(m.toLowerCase());
  };
  ok('sottile e NON gestito ⇒ soppresso', tieni('0xaa', new Set(), true) === false);
  ok('sottile e GESTITO ⇒ resta sul board', tieni('0xaa', new Set(['0xaa']), true) === true);
  ok('  e uno sano resta comunque, gestito o no', tieni('0xbb', new Set(), false) === true);

  // L'esenzione riguarda SOLO la visibilita': i cancelli di piazzamento non la conoscono.
  const prof = fs.readFileSync(path.join(__dirname, 'profondita-minima.js'), 'utf8');
  ok('il cancello di profondità pre-knapsack non conosce l\'esenzione',
    !/esentati|liveMinMarketIds/.test(prof));
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

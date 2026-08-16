#!/usr/bin/env node
'use strict';
// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROVA DI COMPORTAMENTO per agent42-watch-makers.
//
// Non è un test di unità sulle funzioncine: fa girare l'agente VERO — le sue `giroWallet`,
// `convergenza`, `cercaRitiri`, `statistiche` — contro un venue finto e una directory usa-e-getta,
// e verifica i quattro comportamenti che l'agente esiste per avere:
//
//   1. PRIMO FILL   un fill su un mercato già nello storico non è un ingresso; su uno mai visto sì,
//                   e porta con sé montepremi, scadenza, età del mercato e affollamento.
//   2. CONVERGENZA  due dei 21 sullo stesso mercato entro due ore = evento; un terzo dentro la
//                   finestra = evento nuovo; un quarto fuori finestra = nessun doppione.
//   3. RITIRO       a mercato risolto, la distanza fra l'ultimo fill e la risoluzione.
//   4. RIAVVIO/BUCO un riavvio non rispara ingressi già emessi; un'assenza recuperabile si recupera
//                   ripaginando; un'assenza oltre il tetto si DICHIARA come evento `buco`.
//
// Le fasi 1-3 e la 4 girano in PROCESSI SEPARATI sulla stessa directory: è l'unico modo di provare
// davvero che lo stato su disco basta a sopravvivere a un riavvio. Un test che riusa il processo
// proverebbe la cache di `require`, non la persistenza.
//
// SOLA LETTURA sul mondo vero: nessuna chiamata di rete esce da qui, `fetch` è sostituito.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ORA = Math.floor(Date.now() / 1000);
const W1 = '0x1111111111111111111111111111111111111111';
const W2 = '0x2222222222222222222222222222222222222222';
const W3 = '0x3333333333333333333333333333333333333333';
const W4 = '0x4444444444444444444444444444444444444444';
const W5 = '0x5555555555555555555555555555555555555555';
const ESTRANEO = '0x9999999999999999999999999999999999999999';  // non è dei 21: serve all'affollamento
const CID_VECCHIO = '0x' + 'a'.repeat(64);   // già nello storico di W1
const CID_NUOVO   = '0x' + 'b'.repeat(64);   // mai visto: il mercato della convergenza
const CID_ALTRO   = '0x' + 'c'.repeat(64);   // mai visto, un solo entrante
const CID_RISOLTO = '0x' + 'd'.repeat(64);   // scaduto: alimenta il ritiro

// ── il venue finto ──────────────────────────────────────────────────────────────────────────────
// `trades` è la verità del venue: ogni fase la riscrive e l'agente la scopre paginando come farebbe
// con quello vero (offset, limit, ordine dal più recente al più vecchio).
let VENUE = { trades: [], mercati: {} };

function rispondi(url) {
  const u = new URL(url);
  if (u.pathname === '/trades') {
    const user = (u.searchParams.get('user') || '').toLowerCase();
    const market = u.searchParams.get('market');
    const limit = Number(u.searchParams.get('limit') || 100);
    const offset = Number(u.searchParams.get('offset') || 0);
    let t = VENUE.trades.filter(x =>
      (!user || x.proxyWallet.toLowerCase() === user) && (!market || x.conditionId === market));
    t = t.sort((a, b) => b.timestamp - a.timestamp);      // il venue restituisce dal più recente
    return t.slice(offset, offset + limit);
  }
  if (u.pathname === '/markets') {
    const cid = u.searchParams.get('condition_ids');
    const chiusi = u.searchParams.get('closed') === 'true';
    const m = VENUE.mercati[cid];
    if (!m) return [];
    // Gamma nasconde i chiusi finché non glieli chiedi: la doppia chiamata dell'agente esiste per questo.
    if (m.closed && !chiusi) return [];
    return [m];
  }
  return null;
}

global.fetch = async (url) => {
  const body = rispondi(String(url));
  return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
};

// premio: null ⇒ il mercato NON è nel programma premi (Gamma manda `clobRewards: null`, il caso di
// gran lunga più frequente sui mercati sportivi, verificato dal vivo il 7 agosto 2026).
function mercato(cid, { question, premio, creatoOre, scadeOre, closed = false }) {
  return {
    conditionId: cid, question, slug: question.toLowerCase().replace(/\W+/g, '-'),
    clobRewards: premio == null ? null : [{ rewardsDailyRate: premio }],
    rewardsMaxSpread: 4.5, closed,
    createdAt: new Date((ORA - creatoOre * 3600) * 1000).toISOString(),
    endDate:   new Date((ORA + scadeOre * 3600) * 1000).toISOString(),
    closedTime: closed ? new Date((ORA + scadeOre * 3600) * 1000).toISOString() : null,
    volumeNum: 12345,
  };
}
function fill(wallet, cid, ts, extra = {}) {
  return { proxyWallet: wallet, conditionId: cid, timestamp: ts, side: 'BUY', price: 0.42, size: 80,
           title: VENUE.mercati[cid]?.question || null, slug: null, eventSlug: null, ...extra };
}

// ── impalcatura ─────────────────────────────────────────────────────────────────────────────────
const DIR = process.env.WATCH21_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'watch21-'));
let ok = 0, ko = 0;
function prova(nome, cond, dettaglio = '') {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { ko++; console.log(`  ✗ ${nome}${dettaglio ? ` — ${dettaglio}` : ''}`); }
}
function eventi() {
  try {
    return fs.readFileSync(path.join(DIR, 'maker-21-eventi.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(r => JSON.parse(r));
  } catch { return []; }
}

function scriviRoster() {
  const w = (nome, addr) => ({ nome, indirizzo: addr, v2: { oreUltimoFillPrimaRisoluzione: 10.65, nuoviMercatiGiorno: 9, scadenzaMedianaGg: 0.44, premioMediano: 47 } });
  fs.writeFileSync(path.join(DIR, 'maker-21-roster.json'), JSON.stringify({
    meta: { wallet: 5 },
    wallet: [w('Uno', W1), w('Due', W2), w('Tre', W3), w('Quattro', W4), w('Cinque', W5)],
  }));
  fs.writeFileSync(path.join(DIR, 'maker-21-storico.json'), JSON.stringify({
    meta: { mercatiDistinti: 1 },
    perWallet: { [W1]: [CID_VECCHIO], [W2]: [], [W3]: [], [W4]: [], [W5]: [] },
  }));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FASE A — primo fill, convergenza, ritiro
// ════════════════════════════════════════════════════════════════════════════════════════════════
async function faseA() {
  scriviRoster();
  VENUE.mercati[CID_VECCHIO] = mercato(CID_VECCHIO, { question: 'Mercato gia noto',   premio: 20,  creatoOre: 30, scadeOre: 6 });
  VENUE.mercati[CID_NUOVO]   = mercato(CID_NUOVO,   { question: 'Mercato mai toccato', premio: 300, creatoOre: 5,  scadeOre: 11 });
  VENUE.mercati[CID_ALTRO]   = mercato(CID_ALTRO,   { question: 'Mercato solitario',   premio: 40,  creatoOre: 2,  scadeOre: 20 });
  VENUE.mercati[CID_RISOLTO] = mercato(CID_RISOLTO, { question: 'Mercato risolto',     premio: 90,  creatoOre: 48, scadeOre: -1, closed: true });

  const A = require(path.join(__dirname, '..', 'agents', 'agent42-watch-makers.js'));
  const { WALLET, stato } = A._interni;

  // ── A0. avvio: il cursore si prende, non si spara un evento per ogni fill di ieri ──────────────
  // Ogni wallet ha già un fill di ieri: è la situazione reale a ogni primo avvio, ed è precisamente
  // quella in cui l'agente NON deve dire niente. ESTRANEO non è dei 21: sta lì solo per provare che
  // l'affollamento conta tutti i wallet del mercato, non solo quelli che sorvegliamo.
  const IERI = ORA - 86400;
  VENUE.trades = [
    ...[W1, W2, W3, W4, W5].map(w => fill(w, CID_VECCHIO, IERI)),
    fill(ESTRANEO, CID_NUOVO, IERI),
  ];
  for (const w of WALLET) await A.giroWallet(w, true);
  prova('l\'avvio inizializza i cursori senza emettere eventi', eventi().length === 0,
        `emessi ${eventi().length}`);
  prova('il cursore parte dal trade più recente del wallet',
        stato.perWallet[W1].ultimoTs === IERI, `ultimoTs=${stato.perWallet[W1].ultimoTs}`);

  // ── A1. fill su un mercato GIÀ nello storico ⇒ nessun ingresso ─────────────────────────────────
  VENUE.trades.push(fill(W1, CID_VECCHIO, ORA - 3600));
  await A.giroWallet(WALLET[0], false);
  prova('un fill su un mercato già nello storico NON è un ingresso',
        eventi().filter(e => e.tipo === 'ingresso').length === 0);

  // ── A2. primo fill su un mercato MAI toccato ⇒ ingresso arricchito ─────────────────────────────
  VENUE.trades.push(fill(W1, CID_NUOVO, ORA - 3000));
  await A.giroWallet(WALLET[0], false);
  const ing = eventi().filter(e => e.tipo === 'ingresso');
  prova('il primo fill su un mercato mai toccato emette un ingresso', ing.length === 1, `n=${ing.length}`);
  const e0 = ing[0] || {};
  prova('l\'ingresso porta il montepremi del mercato', e0.montepremiGiorno === 300, `${e0.montepremiGiorno}`);
  prova('l\'ingresso porta la scadenza e le ore che mancano',
        e0.scadenzaTs > ORA && Math.abs(e0.oreAScadenza - 11.8) < 0.5, `oreAScadenza=${e0.oreAScadenza}`);
  prova('l\'ingresso porta l\'età del mercato al momento dell\'ingresso',
        Math.abs(e0.etaMercatoOre - 4.2) < 0.5, `etaMercatoOre=${e0.etaMercatoOre}`);
  prova('l\'affollamento conta tutti i wallet del mercato, non solo i 21',
        e0.affollamento === 2, `affollamento=${e0.affollamento}`);
  prova('l\'affollamento dichiara di essere un limite superiore',
        /limite superiore/.test(e0.affollamentoNota || ''));
  prova('l\'ingresso porta la banda del mercato', e0.banda === 4.5, `${e0.banda}`);
  prova('un mercato con montepremi dichiarato è marcato dentro il programma premi',
        e0.nelProgrammaPremi === true, `${e0.nelProgrammaPremi}`);

  // ── A3. lo stesso wallet che rientra sullo stesso mercato non è un secondo ingresso ────────────
  VENUE.trades.push(fill(W1, CID_NUOVO, ORA - 2900));
  await A.giroWallet(WALLET[0], false);
  prova('un secondo fill sullo stesso mercato non riemette un ingresso',
        eventi().filter(e => e.tipo === 'ingresso').length === 1);

  // ── A4. CONVERGENZA: il secondo dei 21 entra entro due ore ─────────────────────────────────────
  VENUE.trades.push(fill(W2, CID_NUOVO, ORA - 1800));
  await A.giroWallet(WALLET[1], false);
  let conv = eventi().filter(e => e.tipo === 'convergenza');
  prova('due dei 21 sullo stesso mercato entro due ore ⇒ convergenza', conv.length === 1, `n=${conv.length}`);
  prova('la convergenza nomina entrambi i wallet',
        (conv[0]?.wallet || []).length === 2 && conv[0].n === 2);
  prova('la convergenza porta montepremi e ore a scadenza',
        conv[0]?.montepremiGiorno === 300 && conv[0]?.oreAScadenza > 0);
  prova('la convergenza misura la distanza fra i due ingressi in minuti',
        Math.abs((conv[0]?.spanMin ?? 0) - 20) < 1, `spanMin=${conv[0]?.spanMin}`);

  // ── A5. il terzo dentro la finestra è un segnale NUOVO ─────────────────────────────────────────
  VENUE.trades.push(fill(W3, CID_NUOVO, ORA - 1200));
  await A.giroWallet(WALLET[2], false);
  conv = eventi().filter(e => e.tipo === 'convergenza');
  prova('un terzo wallet dentro la finestra emette una convergenza n=3',
        conv.length === 2 && conv[1].n === 3, `${conv.map(c => c.n).join(',')}`);

  // ── A6. un quarto FUORI finestra rispetto al primo non gonfia il conteggio ─────────────────────
  // Entra 2h05 dopo il primo: dentro la finestra restano il 2°, il 3° e lui — n=3, già emesso.
  VENUE.trades.push(fill(W4, CID_NUOVO, ORA + 4500));
  await A.giroWallet(WALLET[3], false);
  conv = eventi().filter(e => e.tipo === 'convergenza');
  prova('un entrante fuori finestra non riemette una convergenza già segnalata',
        conv.length === 2, `n=${conv.length}`);

  // ── A7. un mercato con UN solo entrante non è una convergenza ──────────────────────────────────
  VENUE.trades.push(fill(W2, CID_ALTRO, ORA - 600));
  await A.giroWallet(WALLET[1], false);
  prova('un mercato con un solo entrante non produce convergenze',
        eventi().filter(e => e.tipo === 'convergenza').length === 2);
  prova('…ma produce comunque il suo ingresso',
        eventi().filter(e => e.tipo === 'ingresso' && e.conditionId === CID_ALTRO).length === 1);

  // ── A8. RITIRO: mercato risolto, distanza fra l'ultimo fill e la risoluzione ───────────────────
  // Il quinto wallet non ha ancora mosso niente: il suo cursore è ancora a ieri, quindi un fill di
  // sei ore fa gli arriva davvero (per gli altri sarebbe già passato sotto il cursore).
  VENUE.trades.push(fill(W5, CID_RISOLTO, ORA - 6 * 3600));
  await A.giroWallet(WALLET[4], false);
  await A.cercaRitiri();
  const rit = eventi().filter(e => e.tipo === 'ritiro');
  prova('un mercato risolto produce un evento di ritiro', rit.length === 1, `n=${rit.length}`);
  prova('il ritiro misura le ore fra l\'ultimo fill e la risoluzione',
        Math.abs((rit[0]?.orePrimaDellaRisoluzione ?? 0) - 5) < 0.3,
        `ore=${rit[0]?.orePrimaDellaRisoluzione}`);
  prova('il ritiro affianca la mediana del wallet nel v2, per confronto',
        rit[0]?.v2MedianaWalletOre === 10.65);
  await A.cercaRitiri();
  prova('il ritiro non si riemette al giro dopo',
        eventi().filter(e => e.tipo === 'ritiro').length === 1);

  // ── A8b. SCADENZA NON ATTENDIBILE ──────────────────────────────────────────────────────────────
  // Il caso che i dati veri hanno mostrato il 7 agosto 2026: sui mercati ricorrenti Gamma pubblica una
  // `endDate` ANTERIORE ai fill (limite n.2 del manuale v2). Ne esce un «ritiro a −1,5 ore», che non è
  // un ritiro: è una data sbagliata. Deve finire nel giornale con la bandierina, ed essere ESCLUSO
  // dalle mediane — con il conteggio degli scartati pubblicato, non nascosto.
  const CID_RICORRENTE = '0x' + 'f'.repeat(64);
  VENUE.mercati[CID_RICORRENTE] = mercato(CID_RICORRENTE, {
    question: 'Mercato ricorrente con endDate nominale', premio: 30, creatoOre: 300, scadeOre: -3, closed: true });
  VENUE.trades.push(fill(W5, CID_RICORRENTE, ORA - 3600));    // fill DOPO la endDate dichiarata
  await A.giroWallet(WALLET[4], false);
  await A.cercaRitiri();
  const ricEv = eventi().find(e => e.tipo === 'ingresso' && e.conditionId === CID_RICORRENTE);
  const ricRit = eventi().find(e => e.tipo === 'ritiro' && e.conditionId === CID_RICORRENTE);
  prova('un fill dopo la endDate marca l\'ingresso come scadenza NON attendibile',
        ricEv?.scadenzaAttendibile === false, `${ricEv?.scadenzaAttendibile}`);
  prova('il ritiro corrispondente è negativo ed è marcato non attendibile',
        ricRit?.orePrimaDellaRisoluzione < 0 && ricRit?.scadenzaAttendibile === false,
        `ore=${ricRit?.orePrimaDellaRisoluzione} att=${ricRit?.scadenzaAttendibile}`);

  // ── A8c. FUORI DAL PROGRAMMA PREMI ≠ MONTEPREMI ZERO ───────────────────────────────────────────
  // Il caso di gran lunga più frequente sui dati veri: Gamma manda `clobRewards: null`. Collassarlo a
  // «$0/g» renderebbe la fascia più bassa la più affollata per un motivo che coi premi non c'entra, e
  // trascinerebbe a zero la mediana del montepremi.
  const CID_SENZA_PREMI = '0x' + '1a'.repeat(32);
  VENUE.mercati[CID_SENZA_PREMI] = mercato(CID_SENZA_PREMI, {
    question: 'Mercato fuori dal programma premi', premio: null, creatoOre: 8, scadeOre: 30 });
  VENUE.trades.push(fill(W3, CID_SENZA_PREMI, ORA + 200));
  await A.giroWallet(WALLET[2], false);
  const senza = eventi().find(e => e.tipo === 'ingresso' && e.conditionId === CID_SENZA_PREMI);
  prova('un mercato senza clobRewards è marcato FUORI dal programma premi',
        senza?.nelProgrammaPremi === false, `${senza?.nelProgrammaPremi}`);

  // ── A9. la statistica si ricalcola dal giornale ────────────────────────────────────────────────
  // Ingressi attesi: W1·W2·W3·W4 su CID_NUOVO, W2 su CID_ALTRO, W5 su CID_RISOLTO, W5 su
  // CID_RICORRENTE = 7. Due di questi (l'ingresso e il ritiro su CID_RICORRENTE) sono da scartare.
  const s = A.statistiche();
  prova("la statistica conta gli ingressi", s.totali.ingressi === 8, `${s.totali.ingressi}`);
  prova('la statistica conta le convergenze', s.totali.convergenze === 2, `${s.totali.convergenze}`);
  prova('la statistica DICHIARA quanti eventi ha scartato per scadenza non attendibile',
        s.totali.scartatiScadenzaNonAttendibile.ingressi === 1 &&
        s.totali.scartatiScadenzaNonAttendibile.ritiri === 1,
        JSON.stringify(s.totali.scartatiScadenzaNonAttendibile));
  prova('lo scarto dichiara il suo motivo',
        /endDate/.test(s.totali.scartatiScadenzaNonAttendibile.motivo || ''));
  prova('la mediana del ritiro NON è avvelenata dal valore negativo',
        s.consenso.ritiroOreMediana > 0 && s.consenso.ritiroSuNEventi === 1,
        `mediana=${s.consenso.ritiroOreMediana} su n=${s.consenso.ritiroSuNEventi}`);
  prova('la mediana delle ore a scadenza esclude gli ingressi non attendibili',
        s.consenso.oreAScadenzaMediana > 0 && s.consenso.oreAScadenzaSuNEventi === 7,
        `mediana=${s.consenso.oreAScadenzaMediana} su n=${s.consenso.oreAScadenzaSuNEventi}`);
  prova('la statistica riporta l\'età mediana dei mercati all\'ingresso',
        s.consenso.etaMercatoOreMediana != null);
  prova('la statistica raggruppa i montepremi in fasce',
        Object.keys(s.consenso.fasceMontepremi).length >= 2,
        JSON.stringify(s.consenso.fasceMontepremi));
  prova('«fuori dal programma premi» è una fascia a sé, non la fascia più bassa',
        s.consenso.fasceMontepremi['fuori dal programma premi'] === 1 &&
        !('$0–10/g' in s.consenso.fasceMontepremi),
        JSON.stringify(s.consenso.fasceMontepremi));
  prova('la mediana del montepremi non è trascinata a zero dai mercati senza programma',
        s.consenso.montepremiMediano > 0 && s.consenso.fuoriDalProgrammaPremi === 1,
        `mediana=${s.consenso.montepremiMediano} fuori=${s.consenso.fuoriDalProgrammaPremi}`);
  prova('la statistica affianca i valori del v2 come riferimento',
        s.consenso.v2RitiroOreMediana === 10.65 && s.consenso.v2MontepremiMediano === 47);
  prova('la statistica dà a ogni wallet i suoi ingressi al giorno',
        s.perWallet.length === 5 && s.perWallet.some(w => w.ingressiAlGiorno > 0));

  // Lo stato deve essere su disco prima che la fase B lo rilegga.
  fs.writeFileSync(path.join(DIR, 'maker-21-stato.json'), JSON.stringify(stato));
  fs.writeFileSync(path.join(DIR, 'maker-21-gamma-cache.json'), JSON.stringify(A._interni.gammaCache));
  fs.writeFileSync(path.join(DIR, 'venue.json'), JSON.stringify(VENUE));
  return { ok, ko };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FASE B — riavvio, recupero del buco, buco dichiarato
// ════════════════════════════════════════════════════════════════════════════════════════════════
async function faseB() {
  VENUE = JSON.parse(fs.readFileSync(path.join(DIR, 'venue.json'), 'utf8'));
  const primaEventi = eventi().length;

  const A = require(path.join(__dirname, '..', 'agents', 'agent42-watch-makers.js'));
  const { WALLET, stato, VISTI } = A._interni;

  // ── B1. il riavvio ricostruisce la memoria dei mercati già visti ───────────────────────────────
  prova('dopo il riavvio i mercati nuovi visti dal vivo sono ancora «visti»',
        VISTI.get(W1).has(CID_NUOVO), 'CID_NUOVO perso');
  prova('dopo il riavvio i cursori sono ancora al loro posto', stato.perWallet[W1].ultimoTs > 0);

  for (const w of WALLET) await A.giroWallet(w, false);
  prova('un riavvio non rispara nessun evento già emesso', eventi().length === primaEventi,
        `${primaEventi} → ${eventi().length}`);

  // ── B2. RECUPERO DEL BUCO: processo fermo due ore, il feed si rilegge ──────────────────────────
  // Si arretra il cursore di W1 e si mettono nel venue più trade di una pagina: l'agente deve
  // ripaginare e ritrovarli tutti, ingressi compresi.
  const CID_BUCO = '0x' + 'e'.repeat(64);
  VENUE.mercati[CID_BUCO] = mercato(CID_BUCO, { question: 'Mercato del buco', premio: 60, creatoOre: 3, scadeOre: 9 });
  const base = ORA + 5000;
  for (let i = 0; i < 140; i++) VENUE.trades.push(fill(W1, i === 70 ? CID_BUCO : CID_VECCHIO, base + i));
  stato.perWallet[W1].ultimoTs = base - 7200;

  const r = await A.giroWallet(WALLET[0], false);
  prova('un\'assenza recuperabile si recupera ripaginando (>1 pagina)', r.nuovi >= 140, `nuovi=${r.nuovi}`);
  prova('gli ingressi persi durante l\'assenza vengono emessi al ritorno',
        eventi().some(e => e.tipo === 'ingresso' && e.conditionId === CID_BUCO));
  prova('il recupero non genera un evento «buco» (era dentro il tetto)',
        eventi().filter(e => e.tipo === 'buco').length === 0);
  prova('dopo il recupero il cursore è al trade più recente',
        stato.perWallet[W1].ultimoTs === base + 139, `${stato.perWallet[W1].ultimoTs}`);

  // ── B3. BUCO DICHIARATO: assenza oltre il tetto ⇒ evento, non silenzio ─────────────────────────
  stato.perWallet[W2].ultimoTs = ORA - 30 * 86400;
  await A.giroWallet(WALLET[1], false);
  const buchi = eventi().filter(e => e.tipo === 'buco');
  prova('un\'assenza oltre il tetto viene DICHIARATA come evento «buco»', buchi.length === 1,
        `n=${buchi.length}`);
  prova('il buco dice quale wallet e quante ore non sono state rilette',
        buchi[0]?.wallet === W2 && buchi[0]?.oreScoperte > 500, JSON.stringify(buchi[0]?.oreScoperte));
  prova('il buco dice come recuperarlo a mano', /trades\?user=/.test(buchi[0]?.nota || ''));

  return { ok, ko };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
async function main() {
  const fase = process.argv[2];
  if (fase === 'A') { await faseA(); }
  else if (fase === 'B') { await faseB(); }
  else {
    // Il runner: due processi, una sola directory.
    console.log('PROVA DI COMPORTAMENTO · agent42-watch-makers');
    console.log(`directory usa-e-getta: ${DIR}\n`);
    const env = { ...process.env, WATCH21_DATA_DIR: DIR, WATCH21_PAUSA_MS: '0', WATCH21_POLL_MS: '30000' };
    let esito = 0;
    for (const [nome, arg] of [['A · primo fill, convergenza, ritiro, statistica', 'A'],
                               ['B · riavvio, recupero del buco, buco dichiarato', 'B']]) {
      console.log(`── FASE ${nome} ───────────────────────────────────────`);
      try { console.log(execFileSync(process.execPath, [__filename, arg], { env, encoding: 'utf8' })); }
      catch (e) { console.log(e.stdout || ''); console.error(e.stderr || e.message); esito = 1; }
    }
    const righe = eventi();
    console.log(`giornale finale: ${righe.length} eventi — ` +
      Object.entries(righe.reduce((a, e) => (a[e.tipo] = (a[e.tipo] || 0) + 1, a), {}))
        .map(([k, v]) => `${k} ${v}`).join(', '));
    console.log(esito ? '\nESITO: FALLITA' : '\nESITO: SUPERATA');
    process.exit(esito);
  }
  console.log(`\n  ${ok} superate, ${ko} fallite`);
  if (ko) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });

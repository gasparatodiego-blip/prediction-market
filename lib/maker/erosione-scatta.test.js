'use strict';
// lib/maker/erosione-scatta.test.js — R4 · L'EROSIONE TOGLIE L'ORDINE DAL LIBRO, E LO RIMETTE.
//
// ═══ COSA PROVA, E PERCHÉ SERVONO DUE METÀ ═══════════════════════════════════════════════════════════
// `book-erosion` ha già i suoi test sulla DECISIONE, e `sospensione-erosione` ha 32 asserzioni sul
// registro. Nessuna delle due dice se la regola è raggiungibile: è la classe di §5-bis p.181, dove tre
// difese erano inerti con i test verdi perché provavano la decisione e non il cablaggio.
//
// Qui:
//   ① lo SCATTO, attraverso `decideReprice` VERA — l'ordine viene cancellato, e per il motivo giusto;
//   ② il CABLAGGIO dei due processi — agent40 inietta la dep, agent41 rispetta la sospensione;
//   ③ le QUATTRO cose decise dall'operatore, una per una, per NOME;
//   ④ i rami che NON devono agire, che sono la metà che tiene.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const sez = (t) => console.log(`\n── ${t} ──`);

const RADICE = path.resolve(__dirname, '..', '..');
const AR = require('./auto-reprice');
const EROS = require('./book-erosion');
const SOSP = require('./sospensione-erosione');

// ── LA SCENA: un ordine in banda, il mid fermo, il book davanti che si svuota ────────────────────
const TICK = 0.01;
const MID = 0.50;
const BANDA = 4.5;                 // ±4,5¢, la banda modale
const PREZZO = 0.46;               // il bordo con margine, dove il motore lo mette davvero
const SIZE = 62.5;

// ⚠ `readable: true` e `midSource: 'live-book'` NON sono decorazione: `decideReprice` ha due gate a
// monte — regole illeggibili e mid di seconda mano — e senza di loro ogni asserzione qui sotto
// risponderebbe `skip`, cioe' il test sarebbe verde su un percorso mai raggiunto.
// ⚠ E il mid si legge da `rules.books.<lato>.scoringMid`, non da un argomento: ogni lato e' giudicato
// nello spazio del PROPRIO book (un NO a q E' un YES a 1-q). Passarlo fuori da li' dava
// `band-unreadable`, cioe' un test verde su un percorso mai raggiunto.
const regole = { marketId: '0xerode', tick: TICK, maxSpreadCents: BANDA, minSize: 20,
  readable: true, midSource: 'live-book', midAgeSec: 1, feedVitality: null,
  books: { yes: { scoringMid: MID }, no: { scoringMid: +(1 - MID).toFixed(6) } } };
const ordine = { orderId: 'O1', book: 'yes', side: 'BUY', price: PREZZO, size: SIZE, marketId: '0xerode' };

// ⚠ `deps` E' IL SECONDO ARGOMENTO POSIZIONALE, non un campo del primo, e la manopola si chiama
// `config` e non `cfg`. Sbagliare uno dei due fa arrivare `deps.erosione` come `undefined`: il
// TRIGGER 4 viene saltato in silenzio e il test resta verde su un percorso mai raggiunto — la stessa
// classe di §5.3 «dep col nome sbagliato ⇒ valore di difetto che nessuno ha chiesto».
function decidi({ erosione = undefined, side = 'BUY', now = 1_000_000 } = {}) {
  return AR.decideReprice({
    order: { ...ordine, side },
    rules: regole,
    config: { minMoveCents: 1, hysteresisTicks: 1, confirmSamples: 2, minIntervalMs: 30_000 },
    now,
  }, erosione === undefined ? {} : { erosione });
}

// ══ ① LO SCATTO ════════════════════════════════════════════════════════════════════════════════════
sez('① lo scatto: l\'ordine esce dal libro, e per il motivo giusto');
{
  // ⚠ SI PARTE PROVANDO CHE SENZA EROSIONE NON SUCCEDE NIENTE. Senza questo controllo, un `cancel`
  // ottenuto per un'altra ragione (banda, scadenza) sembrerebbe la prova che R4 funziona.
  const fermo = decidi({ erosione: () => ({ fired: false, reason: 'profondità normale' }) });
  ok('profondità normale ⇒ l\'ordine NON si tocca', fermo.action === 'hold', `${fermo.action}/${fermo.gate}`);

  const acceso = decidi({ erosione: () => ({ fired: true, reason: 'EROSIONE CONFERMATA: 80 share contro 900 (8.9%)',
    baseline: 900, ratioPct: 8.9, finoA: 1_300_000, tettoMs: 5 * 60_000 }) });
  ok('erosione confermata ⇒ CANCEL', acceso.action === 'cancel', `${acceso.action}`);
  ok('  col gate `erosione-profondita`', acceso.gate === 'erosione-profondita', String(acceso.gate));
  ok('  e NON un riprezzo: questo trigger non produce mai un prezzo', acceso.targetPrice == null);
  ok('  il testo dice che il mid non si è mosso', /mid non si è mosso/.test(acceso.reason || ''));
  ok('  e dichiara il tetto in minuti', /5 minuti/.test(acceso.reason || ''));
  ok('  i numeri viaggiano nel verdetto', acceso.erosione && acceso.erosione.baseline === 900 && acceso.erosione.ratioPct === 8.9);
}

// ══ ② LE QUATTRO COSE DECISE DALL'OPERATORE ════════════════════════════════════════════════════════
sez('② le quattro cose decise, una per una');
{
  // ③ della lista: I SELL SONO ESCLUSI, come il TRIGGER 3.
  let chiamata = 0;
  const spia = () => { chiamata += 1; return { fired: true, reason: 'x', tettoMs: 300_000 }; };
  const sell = decidi({ erosione: spia, side: 'SELL' });
  ok('un SELL non viene nemmeno valutato per erosione', chiamata === 0 && sell.action !== 'cancel',
    `chiamate ${chiamata}, azione ${sell.action}`);
  const buy = decidi({ erosione: spia, side: 'BUY' });
  ok('  mentre un BUY sì', chiamata === 1 && buy.action === 'cancel');

  // ② della lista: IL FRENO È 60 s, e vive in un posto solo.
  ok('il freno è 60 s, non i 30 di difetto di `book-erosion`', SOSP.FRENO_MS === 60_000);
  ok('  ed è più largo del difetto del modulo, non più stretto', SOSP.FRENO_MS > EROS.REPRICE_MIN_INTERVAL_MS);
  ok('  e `erosionConfig` lo accetta iniettato', EROS.erosionConfig({ minIntervalMs: SOSP.FRENO_MS }).minIntervalMs === 60_000);

  // ④ della lista: IL TETTO È 5 MINUTI.
  ok('il tetto è 5 minuti, come deciso (non 3)', SOSP.TETTO_FUORI_MS === 5 * 60_000);

  // ① della lista: SOLO EROSIONE RELATIVA — «è sparito un livello» NON deve esistere nel percorso.
  // ⚠ Si prova per ASSENZA sul sorgente: il criterio buttato non deve poter rientrare di soppiatto.
  const srcAR = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  const codice = srcAR.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('nessun criterio «è sparito un livello» nel codice di auto-reprice',
    !/livelloSparito|livelliPrec|levels\s*<\s*.*Prec/.test(codice));
  ok('  e il TRIGGER 4 chiama SOLO `deps.erosione`', /deps\.erosione\b/.test(codice));
}

// ══ ③ IL CABLAGGIO DEI DUE PROCESSI ════════════════════════════════════════════════════════════════
sez('③ il cablaggio: chi cancella e chi rimette sono due processi diversi');
{
  const a40 = fs.readFileSync(path.join(RADICE, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const a41 = fs.readFileSync(path.join(RADICE, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');

  ok('agent40 INIETTA la dep `erosione` (senza, il TRIGGER 4 è saltato in silenzio)',
    /erosione:\s*\(arg\)\s*=>\s*valutaErosione\(arg\)/.test(a40));
  ok('  e `valutaErosione` esiste ed è esportata', typeof require(path.join(RADICE, 'agents', 'agent40-manual-reprice.js')).valutaErosione === 'function');
  ok('agent40 importa la macchina dell\'erosione e il registro',
    /require\('\.\.\/lib\/maker\/book-erosion'\)/.test(a40) && /require\('\.\.\/lib\/maker\/sospensione-erosione'\)/.test(a40));

  ok('agent41 legge le sospensioni prima di rimettere una gamba a libro',
    /leggiSospensioni\s*\|\|\s*SOSPE\.leggiStato/.test(a41));
  // ⚠ L'ORDINE È LA REGOLA: il controllo deve stare PRIMA della chiamata a `ripristinaGamba`, o la
  // gamba tornerebbe a libro e la sospensione verrebbe letta dopo, a cose fatte.
  const iSosp = a41.indexOf('const sospensioni = (deps.leggiSospensioni');
  const iRip = a41.indexOf('r = await ripristinaGamba({');
  ok('  e lo fa PRIMA di chiamarlo', iSosp > 0 && iRip > 0 && iSosp < iRip, `sosp@${iSosp} rip@${iRip}`);
  ok('agent41 dichiara il rientro per TETTO, distinto dal recupero',
    /rientro-per-tetto/.test(a41));
  ok('agent40 dichiara il rientro per RECUPERO', /causa: 'recupero'/.test(a40));
}

// ══ ④ LO SCATTO VERO DI `valutaErosione`, CONTRO UN REGISTRO IN UNA DIRECTORY TEMPORANEA ═══════════
sez('④ la serie, il freno e la sospensione, sul percorso vero');
{
  // ⚠ NON si guida `valutaErosione` di agent40 (leggerebbe il book vivo e il registro VERO: sarebbe
  // un test che sporca la produzione, la classe del 7 agosto 2026). Si rigioca la STESSA sequenza con
  // le stesse funzioni, e si prova che la macchina e il registro si comportano come il cablaggio
  // pretende. Il cablaggio in sé è provato dal blocco ③, sul testo.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-'));
  const file = path.join(tmp, 'sospensioni.json');
  const cfg = EROS.erosionConfig({ minIntervalMs: SOSP.FRENO_MS });
  const st = EROS.emptyErosionState();
  let T = 1_000_000;

  // Il riscaldamento: 6 letture su un book stabile da 900 share, distanziate 30 s (span 150 s > 120).
  let fired = null;
  for (let i = 0; i < 6; i += 1) { EROS.updateErosion(st, { depth: 900, now: T, cfg }); T += 30_000; }
  ok('dopo il riscaldamento la baseline è stabilita',
    EROS.updateErosion(st, { depth: 900, now: T, cfg }).established === true);
  T += 30_000;

  // Il crollo: due letture consecutive sotto il 40%.
  const u1 = EROS.updateErosion(st, { depth: 80, now: T, cfg }); T += 30_000;
  ok('la prima lettura sotto soglia NON fa scattare niente', u1.fired === false && u1.belowStreak === 1);
  const u2 = EROS.updateErosion(st, { depth: 80, now: T, cfg });
  ok('la seconda consecutiva CONFERMA', u2.fired === true);
  fired = u2;
  ok('  e il rapporto è sotto il 40%', fired.ratioPct < 40, `${fired.ratioPct}%`);

  // La sospensione si scrive.
  const s0 = SOSP.leggiStato(file);
  ok('registro assente ⇒ nessuna sospensione (fail-APERTO)', s0.leggibile === false && Object.keys(s0.stato.sospesi).length === 0);
  const s1 = SOSP.sospendi(s0.stato, { marketId: '0xerode', book: 'yes', now: T, baseline: fired.baseline, ratioPct: fired.ratioPct });
  ok('la sospensione si applica', s1.applicata === true);
  ok('  e si scrive su disco', SOSP.scriviStato(s1.stato, file).ok === true);
  const riletto = SOSP.leggiStato(file);
  ok('  e si rilegge identica', SOSP.attiva(riletto.stato, { marketId: '0xerode', book: 'yes', now: T + 1000 }).sospeso === true);

  // Il freno: una seconda uscita entro 60 s è vietata.
  ok('una seconda uscita entro 60 s è FRENATA',
    EROS.repriceAllowed({ trigger: 'erosione', lastRepriceAt: T, now: T + 59_000, cfg }).allowed === false);
  ok('  e dopo 60 s è di nuovo permessa',
    EROS.repriceAllowed({ trigger: 'erosione', lastRepriceAt: T, now: T + 61_000, cfg }).allowed === true);

  // Il rientro per RECUPERO: sopra il 60% della baseline congelata.
  T += 60_000;
  const rec = EROS.updateErosion(st, { depth: 900 * 0.7, now: T, cfg });
  ok('sopra il 60% la macchina dichiara il RECUPERO', rec.recovered === true, `${rec.ratioPct}%`);
  const rel = SOSP.rilascia(riletto.stato, { marketId: '0xerode', book: 'yes', causa: 'recupero' });
  ok('  e la sospensione si rilascia', rel.rilasciata === true);

  // Il rientro per TETTO: la profondità NON torna.
  const s2 = SOSP.sospendi(SOSP.statoVuoto(), { marketId: '0xerode', book: 'no', now: T });
  const dopoTetto = SOSP.attiva(s2.stato, { marketId: '0xerode', book: 'no', now: T + SOSP.TETTO_FUORI_MS });
  ok('al minuto 5 la sospensione è scaduta anche senza recupero', dopoTetto.sospeso === false);
  const relT = SOSP.rilascia(s2.stato, { marketId: '0xerode', book: 'no', causa: 'tetto' });
  ok('  e il rilascio per TETTO lo DICHIARA', /RIENTRO PER TETTO/.test(relT.motivo));

  // ── I RAMI CHE NON DEVONO AGIRE ──────────────────────────────────────────────────────────────
  ok('profondità non leggibile ⇒ la serie non avanza e nessun verdetto cambia',
    EROS.updateErosion(EROS.emptyErosionState(), { depth: null, now: T, cfg }).readable === false);
  ok('baseline zero (ordine sul tocco) ⇒ non si arma mai', (() => {
    const z = EROS.emptyErosionState(); let t = T;
    for (let i = 0; i < 10; i += 1) { EROS.updateErosion(z, { depth: 0, now: t, cfg }); t += 30_000; }
    return EROS.updateErosion(z, { depth: 0, now: t, cfg }).fired === false;
  })());

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* niente */ }
}

// ══ ⑤ IL REGISTRO VERO NON DEVE ESSERE STATO TOCCATO ═══════════════════════════════════════════════
sez('⑤ questo test non ha sporcato la produzione');
{
  // ⚠ È l'asserzione che il 7 agosto 2026 sarebbe servita, e che il 18 agosto è servita davvero
  // (§5-bis: il test del kill giornaliero aveva depositato una richiesta finta in `data/`).
  const vero = path.join(RADICE, 'data', 'sospensioni-erosione.json');
  if (!fs.existsSync(vero)) ok('il registro di produzione non esiste, e va bene così', true);
  else {
    let sporco = false;
    try { sporco = JSON.stringify(JSON.parse(fs.readFileSync(vero, 'utf8'))).includes('0xerode'); } catch { sporco = false; }
    ok('il registro di produzione non contiene il mercato finto di questo test', sporco === false);
  }
}

console.log(`\nR4 · l'erosione toglie e rimette: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

'use strict';
// lib/maker/rotazione-giornale.js — IL GIORNALE SMETTE DI CRESCERE SENZA FINE, E NESSUN LETTORE SE NE ACCORGE.
//
// ═══ IL FATTO ════════════════════════════════════════════════════════════════════════════════════════
// `data/polymarket-maker-audit.jsonl` era a 731 MB il 9 agosto 2026 e a **763 MB l'11 agosto**: cresce di
// **67-82 MB al giorno** (misurato sui timestamp a offset diversi dello stesso file, non stimato). Il 9
// agosto ha superato il muro dei 512 MB di V8 e ha fermato il bot per intero — §5 punto 71. La lettura
// incrementale ha tolto quel muro a chi legge; il file però continua a crescere, e l'intestazione di
// `giornale-incrementale.js` dichiarava la rotazione come «la risposta strutturale», non fatta perché
// «cambia cosa significa il giornale per OGNI lettore». Questo modulo la fa, e affronta quel problema
// invece di ignorarlo.
//
// ═══ PERCHÉ SI PORTA DIETRO UNA CODA, E NON È UN VEZZO ══════════════════════════════════════════════
// Una rotazione secca lascia il giornale VUOTO, e i tre lettori vivi ne soffrirebbero subito:
//   · `origine-ordine.mappaOrigini()` → ogni ordine ancora sul libro diventa di origine «ignota», e il
//     reset di agent41 cancella SOLO ciò che è provatamente `auto`. Con tutto ignoto il reset non
//     cancella più niente e il piano nuovo si piazza SOPRA gli ordini vecchi: esposizione doppia.
//     Non è un'ipotesi — è esattamente il guasto del 9 agosto, con un'altra causa.
//   · `manual-reset.cancelledOrderIds()` → nessuna cancellazione riconoscibile, quindi invii non
//     riconciliati contati a pieno nozionale (il secondo guasto dello stesso giorno).
//   · `attribuzione-ordini.manualIdempotencyKeys()` → un ordine del pannello diventa `unknown`.
// Tutti e tre hanno bisogno del PASSATO RECENTE, non di tutta la storia: gli ordini vivono al più una
// finestra GTD (23 minuti), le cancellazioni interessano per qualche ora. Si portano quindi nel file
// nuovo gli ultimi `codaByte` — 64 MB, cioè **~20 ore** al ritmo misurato — allineati a un a capo.
//
// La duplicazione che ne segue è INNOCUA per costruzione: i tre accumulatori sono `Set.add` e `Map.set`
// sulle stesse chiavi con gli stessi valori. Lo si dice qui perché è la condizione che rende lecita la
// coda, e un quarto lettore che un domani CONTASSE le righe dovrà saperlo.
//
// ═══ ORDINE DELLE OPERAZIONI: MAI PERDERE UNA RIGA ══════════════════════════════════════════════════
// Più processi appendono allo stesso file (agent40, agent41, il dashboard), ognuno con `appendFileSync`
// che riapre il percorso a ogni chiamata. La sequenza è:
//   1. lucchetto esclusivo (`wx`), così due processi non ruotano insieme;
//   2. ri-`stat`: se un altro ha già ruotato, si esce senza fare niente;
//   3. `rename` del giornale in archivio — atomico, stesso filesystem;
//   4. `appendFileSync` della coda sul percorso nuovo.
// Fra il 3 e il 4 passa qualche decimo di secondo: una riga appesa in quella finestra finisce nel file
// nuovo PRIMA della coda. Fuori ordine, mai persa — ed è la scelta giusta fra le due, perché l'ordine
// delle righe non è semanticamente rilevante per nessuno dei tre lettori (chiavi, non sequenze) mentre
// una riga di audit persa non si recupera. La variante «scrivi la coda e poi rinomina» avrebbe una
// finestra più stretta ma CLOBBERA quella riga: scartata.
//
// ═══ GLI ARCHIVI NON SI CANCELLANO ══════════════════════════════════════════════════════════════════
// Questo modulo ruota e basta. Non pota, non comprime, non scade. «Cancellare un audit non è pulizia»
// è già la regola di questo repo (§5 punto 63, dove `maker-arming-audit.jsonl` è stato lasciato al suo
// posto). Al ritmo misurato un archivio nasce ogni ~5 giorni e pesa ~400 MB: su 54 GB liberi è una
// decisione che si può prendere con calma, e va presa da una persona.
//
// ═══ NON PUÒ FAR FALLIRE UNA CHIAMATA VIVA ══════════════════════════════════════════════════════════
// `appendMakerAudit` non solleva mai nel chiamante — «un fallimento di scrittura dell'audit non deve
// diventare un fallimento della chiamata live». Questo modulo mantiene la stessa promessa: ogni errore
// è catturato e restituito come esito, mai propagato.

const fs = require('fs');
const path = require('path');

/** Sopra questa dimensione si ruota. 400 MB è ben sotto il muro dei 512 MB di V8, con margine per una
 *  scansione che parta mentre il file è già oltre soglia ma non ancora ruotato. */
const SOGLIA_BYTE = 400 * 1024 * 1024;
/** Quanto passato si porta nel file nuovo: ~20 ore al ritmo misurato di 67-82 MB/giorno. */
const CODA_BYTE = 64 * 1024 * 1024;
/** Si chiama `statSync` solo ogni tanto: una syscall per riga di audit sarebbe un costo per niente. */
const CONTROLLO_OGNI_BYTE = 8 * 1024 * 1024;
/** Un lucchetto più vecchio di così è di un processo morto: si toglie e si riprova una volta sola. */
const LOCK_STALE_MS = 5 * 60_000;

/** Byte appesi da ciascun file dall'ultimo controllo. `null` = mai controllato in questo processo. */
const _daControllare = new Map();

function timbro(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
}

/** Il percorso d'archivio per una rotazione a questo istante. Puro. */
function nomeArchivio(file, ms) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const punto = base.lastIndexOf('.');
  const radice = punto > 0 ? base.slice(0, punto) : base;
  const est = punto > 0 ? base.slice(punto) : '';
  return path.join(dir, `${radice}-${timbro(ms)}${est}`);
}

/** Gli ultimi `codaByte` del file, tagliati al primo a capo per non consegnare mezza riga. */
function leggiCoda(file, dimensione, codaByte) {
  if (!(codaByte > 0) || !(dimensione > 0)) return Buffer.alloc(0);
  const quanti = Math.min(codaByte, dimensione);
  const da = dimensione - quanti;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.allocUnsafe(quanti);
    const n = fs.readSync(fd, b, 0, quanti, da);
    const letto = b.subarray(0, Math.max(0, n));
    if (da === 0) return letto;                       // si è preso il file intero: nessun taglio da fare
    const i = letto.indexOf(0x0a);                    // '\n'
    return i < 0 ? Buffer.alloc(0) : letto.subarray(i + 1);
  } catch {
    return null;                                      // non si è potuto leggere: NON si ruota
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignora */ } }
  }
}

/**
 * Ruota il giornale se ha superato la soglia. Non solleva mai.
 *
 * @returns {{ruotato:boolean, motivo:string, archivio:(string|null), codaByte:number, dimensionePrima:(number|null)}}
 */
function ruotaSeServe({ file, sogliaByte = SOGLIA_BYTE, codaByte = CODA_BYTE, ora = Date.now() } = {}) {
  const no = (motivo, extra = {}) => ({ ruotato: false, motivo, archivio: null, codaByte: 0, dimensionePrima: null, ...extra });
  if (typeof file !== 'string' || !file) return no('nessun file');

  let st;
  try { st = fs.statSync(file); }
  catch { return no('giornale assente'); }
  if (!(st.size > sogliaByte)) return no('sotto soglia', { dimensionePrima: st.size });

  const lock = `${file}.rotazione.lock`;
  let fdLock;
  const apriLock = () => {
    try { return fs.openSync(lock, 'wx'); } catch { return null; }
  };
  fdLock = apriLock();
  if (fdLock === null) {
    // Occupato: o un altro processo sta ruotando adesso, o è morto tenendolo. Solo nel secondo caso si
    // interviene, e una volta sola — un lucchetto tolto troppo presto è due rotazioni insieme.
    let vecchio = false;
    try { vecchio = (ora - fs.statSync(lock).mtimeMs) > LOCK_STALE_MS; } catch { vecchio = false; }
    if (!vecchio) return no('rotazione già in corso in un altro processo', { dimensionePrima: st.size });
    try { fs.unlinkSync(lock); } catch { /* qualcun altro l'ha già tolto */ }
    fdLock = apriLock();
    if (fdLock === null) return no('lucchetto non acquisito', { dimensionePrima: st.size });
  }

  try {
    // Ri-stat SOTTO lucchetto: fra il primo controllo e adesso un altro processo può aver già ruotato,
    // e ruotare due volte produrrebbe un archivio da pochi byte e la perdita della coda appena scritta.
    let st2;
    try { st2 = fs.statSync(file); }
    catch { return no('giornale sparito fra il controllo e il lucchetto'); }
    if (!(st2.size > sogliaByte)) return no('già ruotato da un altro processo', { dimensionePrima: st2.size });

    const coda = leggiCoda(file, st2.size, codaByte);
    if (coda === null) return no('coda non leggibile: non si ruota', { dimensionePrima: st2.size });

    const archivio = nomeArchivio(file, ora);
    try { fs.renameSync(file, archivio); }
    catch (e) { return no(`rinomina fallita: ${e && e.message ? e.message : String(e)}`, { dimensionePrima: st2.size }); }

    // Da qui in poi il giornale non esiste per un istante: `appendFileSync` lo ricrea, e una riga
    // appesa da un altro processo nel frattempo ci finisce dentro — prima della coda, mai persa.
    try { if (coda.length) fs.appendFileSync(file, coda); }
    catch { /* la coda è un di più: senza, i lettori ricostruiscono da zero e il bot resta corretto */ }

    return { ruotato: true, motivo: 'oltre soglia', archivio, codaByte: coda.length, dimensionePrima: st2.size };
  } finally {
    try { fs.closeSync(fdLock); } catch { /* ignora */ }
    try { fs.unlinkSync(lock); } catch { /* ignora */ }
  }
}

/**
 * Da chiamare DOPO ogni append. Conta i byte scritti e chiama `ruotaSeServe` solo ogni tanto — la
 * prima volta in assoluto sempre, così un processo che parte su un file già oltre soglia lo ruota
 * subito invece di aspettare 8 MB di traffico.
 */
function forseRuota(file, byteAppesi = 0, opzioni = {}) {
  try {
    // ── UN TEST NON RUOTA IL GIORNALE VERO ────────────────────────────────────────────────────────
    // `appendMakerAudit` scrive sempre sul file di produzione, quindi qualunque suite che lo chiami
    // passa anche di qui. È successo davvero, al primo giro: la suite ha ruotato i 763 MB veri prima
    // che il codice fosse deployato. L'esito era corretto — archivio integro, coda riportata, zero
    // righe rotte — ma è la stessa classe di trappola del §5 punto 53, e una rotazione innescata da
    // un test è un'azione sullo stato di produzione che nessuno ha chiesto.
    //
    // Si guarda `argv[1]`, non una variabile d'ambiente: è il file che sta girando, non una
    // configurazione che qualcuno può dimenticare. Chi vuole PROVARE la rotazione chiama
    // `ruotaSeServe` direttamente — che resta senza guardia — su un file suo, come fa il selfcheck.
    if (/\.test\.js$/.test(String(process.argv[1] || ''))) {
      return { ruotato: false, motivo: 'sotto test: la rotazione del giornale vero non si innesca' };
    }
    const visto = _daControllare.get(file);
    const acc = (visto == null ? Infinity : visto + (Number(byteAppesi) || 0));
    if (acc < CONTROLLO_OGNI_BYTE) { _daControllare.set(file, acc); return { ruotato: false, motivo: 'controllo rimandato' }; }
    _daControllare.set(file, 0);
    return ruotaSeServe({ file, ...opzioni });
  } catch (e) {
    return { ruotato: false, motivo: `errore: ${e && e.message ? e.message : String(e)}` };
  }
}

/** Solo per i test: dimentica i contatori. */
function azzeraContatori() { _daControllare.clear(); }

function selfcheck() {
  const os = require('os');
  let pass = 0, fail = 0;
  const ok = (n, c) => { c ? pass++ : (fail++, console.log('  selfcheck FALLITO: ' + n)); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotazione-'));
  const f = path.join(dir, 'g.jsonl');
  const riga = (i) => JSON.stringify({ i, x: 'z'.repeat(80) }) + '\n';

  // ── sotto soglia: non si tocca niente
  fs.writeFileSync(f, riga(1) + riga(2));
  const prima = fs.readFileSync(f, 'utf8');
  const r1 = ruotaSeServe({ file: f, sogliaByte: 10 * 1024 * 1024 });
  ok('sotto soglia non si ruota', r1.ruotato === false && fs.readFileSync(f, 'utf8') === prima);

  // ── sopra soglia: si ruota, e la coda arriva nel file nuovo
  let testo = '';
  for (let i = 0; i < 2000; i++) testo += riga(i);
  fs.writeFileSync(f, testo);
  const dimensione = fs.statSync(f).size;
  const r2 = ruotaSeServe({ file: f, sogliaByte: Math.floor(dimensione / 2), codaByte: Math.floor(dimensione / 4), ora: 1_760_000_000_000 });
  ok('sopra soglia si ruota', r2.ruotato === true && !!r2.archivio);
  ok('  l\'archivio contiene il file INTERO di prima', fs.statSync(r2.archivio).size === dimensione);
  ok('  il giornale nuovo esiste ed è più piccolo della soglia', fs.statSync(f).size < dimensione);
  ok('  la coda non comincia a metà riga', (() => {
    const righe = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return righe.length > 0 && righe.every((l) => { try { JSON.parse(l); return true; } catch { return false; } });
  })());
  ok('  e la coda è la FINE del vecchio: l\'ultima riga coincide', (() => {
    const a = fs.readFileSync(r2.archivio, 'utf8').trimEnd().split('\n').pop();
    const b = fs.readFileSync(f, 'utf8').trimEnd().split('\n').pop();
    return a === b;
  })());
  ok('  il nome dell\'archivio porta l\'istante e non collide col giornale',
    /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jsonl$/.test(r2.archivio) && r2.archivio !== f);

  // ── il lettore incrementale sopravvive: rilegge il file nuovo da zero, senza spazzatura
  const { scansiona, azzera } = require('./giornale-incrementale');
  const CH = 'rotazione-selfcheck';
  azzera(CH);
  fs.writeFileSync(f, riga(9001) + riga(9002));
  const leggi = () => scansiona({ file: f, chiave: CH, crea: () => new Set(), ingest: (l, a) => { if (l.trim()) a.add(l.trim()); } });
  ok('il lettore vede le due righe', leggi().size === 2);
  let grosso = '';
  for (let i = 0; i < 2000; i++) grosso += riga(i);
  fs.appendFileSync(f, grosso);
  leggi();
  const dim2 = fs.statSync(f).size;
  const r3 = ruotaSeServe({ file: f, sogliaByte: Math.floor(dim2 / 2), codaByte: 4096 });
  ok('seconda rotazione riuscita', r3.ruotato === true);
  const dopo = leggi();
  ok('il lettore RICOSTRUISCE da zero dopo la rotazione (nessuna riga fantasma)',
    dopo.size > 0 && dopo.size <= 60 && !dopo.has(JSON.stringify({ i: 9001, x: 'z'.repeat(80) })));
  ok('  e ogni riga letta è JSON valido (l\'offset non punta a metà riga)',
    Array.from(dopo).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));

  // ── il lucchetto: una rotazione in corso non ne fa partire una seconda
  fs.writeFileSync(f, grosso);
  const lock = `${f}.rotazione.lock`;
  fs.writeFileSync(lock, '');
  const r4 = ruotaSeServe({ file: f, sogliaByte: 1024 });
  ok('lucchetto presente e fresco ⇒ non si ruota', r4.ruotato === false && /già in corso/.test(r4.motivo));
  const r5 = ruotaSeServe({ file: f, sogliaByte: 1024, ora: Date.now() + LOCK_STALE_MS + 1000 });
  ok('  lucchetto STANTIO ⇒ si toglie e si ruota', r5.ruotato === true);
  ok('  e il lucchetto non resta appeso dopo una rotazione riuscita', !fs.existsSync(lock));

  // ── file assente: nessun errore, nessuna rotazione
  ok('giornale assente ⇒ esito negativo senza eccezioni',
    ruotaSeServe({ file: path.join(dir, 'non-esiste.jsonl') }).ruotato === false);

  // ── la guardia: sotto un `*.test.js` `forseRuota` non innesca mai
  azzeraContatori();
  fs.writeFileSync(f, grosso);
  const argvPrima = process.argv[1];
  process.argv[1] = '/qualunque/percorso/suite.test.js';
  ok('sotto test `forseRuota` NON ruota', (() => {
    const r = forseRuota(f, 10, { sogliaByte: 1024 });
    return r.ruotato === false && /sotto test/.test(r.motivo);
  })());
  ok('  ma `ruotaSeServe` diretto resta disponibile (il selfcheck deve poter provare)',
    ruotaSeServe({ file: f, sogliaByte: 1024 }).ruotato === true);
  process.argv[1] = argvPrima;

  // ── il contatore: la PRIMA chiamata controlla sempre, le successive no finché non si accumula
  azzeraContatori();
  fs.writeFileSync(f, grosso);
  ok('il primo `forseRuota` controlla davvero', forseRuota(f, 10, { sogliaByte: 1024 }).ruotato === true);
  fs.writeFileSync(f, grosso);
  ok('  e subito dopo il controllo è rimandato', forseRuota(f, 10, { sogliaByte: 1024 }).ruotato === false);
  ok('  finché non si accumulano abbastanza byte',
    forseRuota(f, CONTROLLO_OGNI_BYTE, { sogliaByte: 1024 }).ruotato === true);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignora */ }
  console.log(`rotazione-giornale selfcheck: ${pass} passati, ${fail} falliti`);
  return { pass, fail };
}

module.exports = {
  ruotaSeServe, forseRuota, nomeArchivio, leggiCoda, azzeraContatori, selfcheck,
  SOGLIA_BYTE, CODA_BYTE, CONTROLLO_OGNI_BYTE, LOCK_STALE_MS,
};

if (require.main === module) { const r = selfcheck(); process.exit(r.fail ? 1 : 0); }

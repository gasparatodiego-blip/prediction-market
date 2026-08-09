'use strict';
// lib/maker/giornale-incrementale.js — LEGGERE UN GIORNALE PIÙ GRANDE DI QUANTO V8 SAPPIA TENERE.
//
// ═══ IL MURO, E PERCHÉ NON È UN PROBLEMA DI PRESTAZIONI ══════════════════════════════════════════════
// `fs.readFileSync(file, 'utf8')` costruisce UNA stringa. V8 ne ammette al più `0x1fffffe8` caratteri
// (~512 MB): oltre, solleva `Cannot create a string longer than 0x1fffffe8 characters`. Non è lentezza,
// è un tetto secco — e quando lo si supera la funzione non rallenta, **smette di funzionare**.
//
// Misurato il 9 agosto 2026: `data/polymarket-maker-audit.jsonl` era a **731 MB** e ogni lettore
// dell'intero file falliva. Le due funzioni rotte fallivano CHIUSO, cioè restituivano un insieme vuoto —
// che è la direzione giusta ma ha una conseguenza che nessuno aveva previsto:
//
//   · `origine-ordine.mappaOrigini()` → mappa vuota ⇒ ogni ordine è di origine «ignota» ⇒ il reset di
//     agent41 non cancella NIENTE (cancella solo ciò che è provatamente `auto`);
//   · `manual-reset.cancelledOrderIds()` → insieme vuoto ⇒ nessun ordine può essere dichiarato
//     «cancellato da noi» ⇒ gli invii non riconciliati restano contati a PIENO NOZIONALE
//     nell'esposizione aperta.
//
// Il secondo ha bloccato il bot per intero: **$2.406 di esposizione fantasma** contro un tetto di $600 e
// una realtà di ~$127, quindi ogni piazzamento rifiutato per `limit-max-open-notional` e il mini-ciclo
// che calcolava «liberi $0,00» su un conto con $548 liquidi. Un fallimento silenzioso e fail-closed che
// si presenta come «il capitale è già tutto al lavoro».
//
// ═══ LA CURA, E NON È NUOVA ═════════════════════════════════════════════════════════════════════════
// `lib/maker/attribuzione-ordini.js` aveva lo stesso identico difetto ed era già stato corretto: si
// tiene l'offset già consumato e si legge SOLO ciò che è stato appeso, a blocchi da 1 MiB, con un
// `StringDecoder` che non spezza un carattere multi-byte a cavallo fra due blocchi. Questo modulo
// ESTRAE quel pattern perché smetta di essere una copia per chiamante: era in un posto, adesso servirebbe
// in tre, e tre copie della stessa lettura sono esattamente il reperto che il rilevatore D1 dell'audit
// cerca. Il comportamento è quello già in servizio, non una riscrittura.
//
// ═══ LE TRE COSE CHE RENDONO L'OFFSET SICURO ════════════════════════════════════════════════════════
//   · ROTAZIONE o TRONCAMENTO invalidano l'offset, e si rilevano da due segnali indipendenti: l'inode
//     cambiato, o un file più CORTO del nostro offset. In entrambi i casi l'accumulatore si RICOSTRUISCE
//     da zero invece di leggere spazzatura a partire da una posizione che non significa più niente.
//   · La CODA PARZIALE (`tail`) non viene mai passata a `JSON.parse`: l'ultima riga di un blocco può
//     essere tagliata a metà, e si tiene da parte finché il resto non arriva.
//   · Un errore di lettura lascia la cache ESATTAMENTE com'era, offset compreso, così la chiamata dopo
//     riprova dallo stesso punto invece di dichiarare vuoto ciò che non ha potuto leggere.
//
// ═══ COSA QUESTO MODULO NON FA, E VA DETTO ══════════════════════════════════════════════════════════
// Non ROTA il registro. La lettura incrementale toglie il muro dei 512 MB a chi legge, ma il file
// continua a crescere: la prima scansione di un processo appena avviato deve comunque attraversare 731 MB
// (misurato: ~4 s, memoria costante), e ogni nuovo lettore che qualcuno scriva domani deve ricordarsi di
// usare questo modulo. La risposta strutturale è la rotazione, che però cambia cosa significa «il
// giornale» per OGNI lettore — un lettore che deve conoscere la storia dovrà attraversare anche gli
// archivi — ed è quindi una decisione per file e per chiamante, non una riga in più qui. Vedi §5 punto 71.
//
// PURO RISPETTO ALLA DECISIONE: qui non si interpreta nessuna riga. Chi chiama passa `ingest`, e questo
// modulo si occupa soltanto di consegnargli ogni riga nuova una volta sola.

const fs = require('fs');

const CHUNK = 1 << 20;   // 1 MiB per volta — limitato, qualunque dimensione raggiunga il file

/** Le cache vive, una per (chiamante, file). */
const _cache = new Map();

function statoPer(chiave) {
  let s = _cache.get(chiave);
  if (!s) { s = { acc: null, offset: 0, ino: null, tail: '', decoder: null, testa: null }; _cache.set(chiave, s); }
  return s;
}

/**
 * Scansiona ciò che è stato APPESO al giornale dall'ultima chiamata, consegnando ogni riga completa a
 * `ingest`. L'accumulatore appartiene al chiamante ed è tenuto vivo fra una chiamata e l'altra; viene
 * ricreato con `crea()` la prima volta e ogni volta che il file risulta ruotato o troncato.
 *
 * @param {object}   a
 * @param {string}   a.file      percorso del giornale
 * @param {string}   a.chiave    identità del chiamante (due lettori dello stesso file hanno cache distinte)
 * @param {Function} a.crea      () => accumulatore vuoto (Set, Map, oggetto…)
 * @param {Function} a.ingest    (riga, accumulatore) => void — chiamata una volta per riga NUOVA
 * @returns {*} l'accumulatore, sempre lo stesso oggetto finché il file non ruota
 */
function scansiona({ file, chiave, crea, ingest } = {}) {
  const k = `${chiave}::${file}`;
  const s = statoPer(k);
  if (s.acc === null) s.acc = crea();

  let st;
  try { st = fs.statSync(file); }
  catch { return s.acc; }   // assente o illeggibile ⇒ si tiene quel che si sa, non si dimentica mai

  // ── LA TESTA DEL FILE, TERZO SEGNALE ─────────────────────────────────────────────────────────
  // Inode e dimensione non bastano: un file RISCRITTO in place, con lo stesso inode e una dimensione
  // maggiore, passerebbe entrambi i controlli e ci farebbe tenere righe che non esistono più. Su un
  // giornale append-only non accade — ma «non accade» non è una garanzia, e il costo di accorgersene è
  // una lettura di 64 byte. Se i primi byte cambiano, il file non è più quello: si ricostruisce.
  let testa = null;
  if (st.size > 0) {
    let fdT;
    try {
      fdT = fs.openSync(file, 'r');
      const b = Buffer.allocUnsafe(Math.min(64, st.size));
      const n = fs.readSync(fdT, b, 0, b.length, 0);
      testa = b.subarray(0, Math.max(0, n)).toString('latin1');
    } catch { testa = null; }
    finally { if (fdT !== undefined) { try { fs.closeSync(fdT); } catch { /* ignora */ } } }
  }

  // Rotazione, troncamento o riscrittura: l'offset non significa più niente, si riparte da zero.
  if (s.ino !== st.ino || st.size < s.offset || (s.testa !== null && testa !== null && testa !== s.testa)) {
    s.acc = crea();
    s.offset = 0;
    s.tail = '';
    s.ino = st.ino;
    s.decoder = null;
    s.testa = null;
  }
  if (s.testa === null && testa !== null) s.testa = testa;
  if (st.size === s.offset) return s.acc;   // niente di nuovo — il caso comune

  const { StringDecoder } = require('string_decoder');
  if (!s.decoder) s.decoder = new StringDecoder('utf8');

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = s.offset;
    let carry = s.tail;
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const testo = carry + s.decoder.write(buf.subarray(0, n));
      const righe = testo.split('\n');
      carry = righe.pop();          // può essere una riga a metà: non si parsa mai qui
      for (const riga of righe) ingest(riga, s.acc);
    }
    s.offset = pos;
    s.tail = carry;
    // ── L'ULTIMA RIGA SENZA `\n` FINALE — cioè il record PIÙ RECENTE ──────────────────────────
    // Un giornale scritto con `appendFileSync(riga + '\n')` finisce sempre con un a capo, ma non è
    // garantito: un file troncato a mano, un ultimo append interrotto, o semplicemente un fixture
    // scritto con `join('\n')` lasciano l'ultima riga senza terminatore. Tenendola solo nella coda,
    // il record più recente resterebbe INVISIBILE finché non ne arriva un altro — e per
    // `cancelledOrderIds` significherebbe non vedere proprio la cancellazione appena avvenuta.
    //
    // Si consegna quindi anche la coda, SENZA consumarla: resta in `tail`, così quando il resto della
    // riga arriva viene riprocessata intera e il pezzo monco non si incolla al successivo. Questo
    // richiede che `ingest` sia IDEMPOTENTE — vero per costruzione qui, dove gli accumulatori sono
    // `Set.add` e `Map.set` — e una riga davvero tagliata a metà non passa `JSON.parse`, quindi viene
    // scartata da sé.
    if (carry) { try { ingest(carry, s.acc); } catch { /* una riga monca non deve far cadere la lettura */ } }
  } catch {
    /* una lettura fallita lascia la cache com'era, offset compreso: la prossima riprova da lì */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignora */ } }
  }
  return s.acc;
}

/**
 * Dimentica una cache (o tutte). Serve ai test, che riscrivono lo stesso percorso con contenuti diversi:
 * su un file append-only vero questo non accade mai, e infatti in produzione non lo chiama nessuno.
 */
function azzera(chiave = null, file = null) {
  if (chiave === null) { _cache.clear(); return; }
  if (file === null) {
    for (const k of Array.from(_cache.keys())) if (k.startsWith(`${chiave}::`)) _cache.delete(k);
    return;
  }
  _cache.delete(`${chiave}::${file}`);
}

/** Quanto abbiamo già consumato, per file — solo diagnostica. */
function statoCache() {
  const out = {};
  for (const [k, v] of _cache) out[k] = { offset: v.offset, ino: v.ino, codaByte: v.tail.length };
  return out;
}

function selfcheck() {
  const os = require('os');
  const path = require('path');
  let pass = 0, fail = 0;
  const ok = (n, c) => { c ? pass++ : (fail++, console.log('  selfcheck FALLITO: ' + n)); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giornale-'));
  const f = path.join(dir, 'g.jsonl');
  const CH = 'selfcheck';

  const leggi = () => scansiona({
    file: f, chiave: CH,
    crea: () => new Set(),
    ingest: (riga, acc) => { if (riga.trim()) acc.add(riga.trim()); },
  });

  azzera(CH);
  fs.writeFileSync(f, 'a\nb\n');
  ok('legge le righe presenti', leggi().size === 2);

  fs.appendFileSync(f, 'c\n');
  ok('una riga appesa viene aggiunta senza rileggere tutto', leggi().size === 3);

  const acc1 = leggi();
  ok('senza nuove righe torna lo STESSO accumulatore', leggi() === acc1);

  // Troncamento ⇒ ricostruzione da zero.
  fs.writeFileSync(f, 'z\n');
  ok('un file più corto dell\'offset fa ricostruire da zero', (() => {
    const r = leggi();
    return r.size === 1 && r.has('z');
  })());

  // ── LA CODA: CONSEGNATA IN ANTICIPO, MA MAI IN MODO CORROMPENTE ─────────────────────────────
  // La regola NON è «una riga parziale non viene mai consegnata» — sarebbe incompatibile con il vedere
  // l'ultima riga di un file senza a capo, che è il caso che conta di più (il record più recente).
  // La regola è: la coda viene consegnata SENZA essere consumata, quindi quando il resto arriva la riga
  // vale INTERA e non si incolla mai alla successiva. `ingest` deve essere idempotente, e lo è.
  azzera(CH);
  fs.writeFileSync(f, 'completa\nparzi');
  ok('la riga completa c\'è', (() => { const r = leggi(); return r.has('completa'); })());
  fs.appendFileSync(f, 'ale\n');
  ok('la riga spezzata vale INTERA quando il resto arriva', (() => { const r = leggi(); return r.has('parziale'); })());
  ok('  e il pezzo monco non si è incollato alla riga successiva', (() => {
    fs.appendFileSync(f, 'successiva\n');
    const r = leggi();
    return r.has('successiva') && !Array.from(r).some((x) => x !== 'parziale' && x.indexOf('parzi') === 0 && x !== 'parziale');
  })());

  // Ultima riga senza `\n`: dev'essere vista comunque.
  azzera(CH);
  fs.writeFileSync(f, 'prima\nultima-senza-acapo');
  ok('l\'ultima riga senza a capo viene comunque consegnata', (() => {
    const r = leggi();
    return r.size === 2 && r.has('ultima-senza-acapo');
  })());
  fs.appendFileSync(f, '-completata\n');
  ok('  e quando il resto arriva la riga vale INTERA, senza incollarsi alla successiva', (() => {
    const r = leggi();
    return r.has('ultima-senza-acapo-completata');
  })());

  // Riscrittura in place con contenuto DIVERSO e file più lungo: inode e dimensione non se ne
  // accorgerebbero, la testa sì.
  azzera(CH);
  fs.writeFileSync(f, 'vecchia\n');
  leggi();
  fs.writeFileSync(f, 'nuova-uno\nnuova-due\n');
  ok('una riscrittura in place fa ricostruire (la testa è cambiata)', (() => {
    const r = leggi();
    return r.size === 2 && !r.has('vecchia') && r.has('nuova-uno');
  })());

  // File assente ⇒ accumulatore invariato, mai svuotato.
  azzera(CH);
  fs.writeFileSync(f, 'completa\nparziale\n');
  leggi();
  const acc2 = leggi();
  fs.unlinkSync(f);
  ok('file sparito ⇒ si tiene quel che si sa (non si dimentica)', leggi() === acc2 && leggi().size === 2);

  // Due chiamanti sullo stesso file non si disturbano.
  fs.writeFileSync(f, 'x\ny\n');
  azzera(CH);
  const uno = scansiona({ file: f, chiave: 'uno', crea: () => new Set(), ingest: (r, a) => r && a.add(r) });
  const due = scansiona({ file: f, chiave: 'due', crea: () => [], ingest: (r, a) => r && a.push(r) });
  ok('due chiamanti hanno accumulatori indipendenti', uno.size === 2 && due.length === 2 && uno !== due);

  // Un carattere multi-byte a cavallo di due blocchi non viene spezzato: si forza il caso scrivendo
  // abbastanza da superare un blocco.
  azzera('utf8');
  const f2 = path.join(dir, 'g2.jsonl');
  const riempi = 'à'.repeat(700_000);   // ~1,4 MB in UTF-8: attraversa il confine del blocco da 1 MiB
  fs.writeFileSync(f2, riempi + '\n');
  const r2 = scansiona({ file: f2, chiave: 'utf8', crea: () => [], ingest: (r, a) => { if (r) a.push(r); } });
  ok('un carattere multi-byte a cavallo di due blocchi resta intero',
    r2.length === 1 && r2[0].length === 700_000 && r2[0] === riempi);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignora */ }
  console.log(`giornale-incrementale selfcheck: ${pass} passati, ${fail} falliti`);
  return { pass, fail };
}

module.exports = { scansiona, azzera, statoCache, CHUNK, selfcheck };

if (require.main === module) { const r = selfcheck(); process.exit(r.fail ? 1 : 0); }

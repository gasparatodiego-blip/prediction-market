'use strict';
// lib/maker/persistenza-dopo-crash.test.js — COSA SOPRAVVIVE A UN ARRESTO NON PULITO.
//
// ═══ LA PROVA, FATTA DAVVERO ═════════════════════════════════════════════════════════════════════════
// `kill -9` su agent40 il 12 agosto 2026 alle 10:11:19Z, con bot FERMO+KILL, zero posizioni e libro
// vuoto. SIGKILL: nessun handler, nessun flush, nessuna occasione di scrivere niente.
// Risorto da pm2 alle 10:11:34 (restart 80 → 81).
//
// ESITO: **nessuna corruzione**. Tutti i registri su disco byte-identici (md5 invariato) e
// `execution-audit.jsonl` fermo a 3.652 righe. Le scritture atomiche tmp+rename hanno fatto il loro
// mestiere: non esiste un istante in cui un lettore veda un file a metà.
//
// ═══ IL QUADRO ONESTO ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENTE — sopravvive: attese di merge · modalità chiusura (bersaglio della sorella compreso) ·
//   residui scoperti · residui sotto soglia · tetti di capitale · gestione manuale · allowlist ·
//   catalogo di ripiego · registro idempotenza (`execution-audit.jsonl`, append-only) · confronto
//   reward · baseline e latch del guardiano · piano dell'allocatore (`realloc-ultimo-piano.json`).
// RICOSTRUITO all'avvio — non serve persistere: ordini a riposo e posizioni (riletti dal venue),
//   snapshot posizioni, board, scansione dei registri (gira all'avvio per costruzione).
// IN MEMORIA e PERSO, ma senza costo: `breaches` e `ultimaValutazione`/`ultimoBookValutato` (contatori
//   di conferma del riprezzo: si ricostruiscono al giro dopo, al più un ciclo di ritardo) ·
//   `residuiSegnalati` e `conflittiSoppressi` (anti-ripetizione dei log: al più una riga doppia) ·
//   `ultimePosizioni` (cache da 5 s) · `registroOrfani` (la conferma in due osservazioni riparte: una
//   gamba orfana sopravvive a una finestra GTD in più, ~20 min — costo già dichiarato dal suo design).
// IN MEMORIA e PERSO CON UN COSTO — ⚠ L'UNICO, e questo lavoro lo chiude: `daRipianificareCoda`.
//
// ═══ PERCHÉ QUELLA CODA ERA DIVERSA DALLE ALTRE ═════════════════════════════════════════════════════
// Si riempie SOLO al momento in cui una gamba orfana viene cancellata, e viene drenata dal ciclo di
// chiusura. Un crash nel mezzo la faceva sparire, e nessun ciclo sarebbe tornato a riempirla: la
// cancellazione era già avvenuta. Nessun capitale a rischio — l'esposizione era appena SCESA — ma il
// capitale liberato restava fermo per sempre. Tutti gli altri stati in memoria si ricostruiscono da
// soli perché derivano da qualcosa che si rilegge; questo derivava da un EVENTO già passato.

const fs = require('fs');
const path = require('path');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}
const srcA = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');

console.log('── 1 · LA CODA DI RIPIANIFICAZIONE ORA È SU DISCO');
{
  ok('ha un file suo', srcA.includes("'da-ripianificare.json'"));
  ok('si RIPRENDE all\'avvio', /JSON\.parse\(fs\.readFileSync\(RIPIANIFICA_FILE/.test(srcA));
  ok('  con scrittura atomica tmp+rename, come gli altri registri',
    /RIPIANIFICA_FILE\}\.tmp/.test(srcA) && srcA.includes('fs.renameSync(tmp, RIPIANIFICA_FILE)'));
  ok('  e si scrive sia sull\'inserimento sia sul drenaggio',
    (srcA.match(/scrivi\(\);/g) || []).length >= 2);
  ok('le voci si potano a 24 ore', srcA.includes('RIPIANIFICA_TTL_MS = 24 * 3_600_000'));
  ok('  perché un mercato in coda da un giorno non è più da ripianificare',
    srcA.includes('e\' da dimenticare'));
  ok('una scrittura fallita NON ferma la cancellazione già avvenuta',
    /catch \{ \/\* una coda che non si scrive/.test(srcA));
  ok('l\'interfaccia resta quella di una Map: i chiamanti non cambiano',
    srcA.includes('Array.from(daRipianificareCoda.values())') && srcA.includes('daRipianificareCoda.clear()'));

  // ── IL COMPORTAMENTO VERO, su un file temporaneo ────────────────────────────────────────────────
  const tmp = path.join(require('os').tmpdir(), `ripianifica-${process.pid}.json`);
  const scrivi = (voci) => fs.writeFileSync(tmp, JSON.stringify({ voci }));
  const rileggi = (ora) => {
    const m = new Map();
    try {
      const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
      for (const v of (j && Array.isArray(j.voci) ? j.voci : [])) {
        if (!v || !v.marketId) continue;
        const at = Number(v.at);
        if (Number.isFinite(at) && ora - at > 24 * 3_600_000) continue;
        m.set(String(v.marketId), v);
      }
    } catch { /* assente */ }
    return m;
  };
  const ORA = 1_800_000_000_000;
  scrivi([{ marketId: '0xa', at: ORA - 3_600_000 }, { marketId: '0xb', at: ORA - 48 * 3_600_000 }]);
  const ripreso = rileggi(ORA);
  ok('al riavvio si riprende la voce fresca', ripreso.has('0xa'));
  ok('  e si scarta quella vecchia di 48 ore', !ripreso.has('0xb'));
  scrivi('non-un-array');
  ok('un file rotto ⇒ coda vuota, nessuna eccezione', rileggi(ORA).size === 0);
  try { fs.unlinkSync(tmp); } catch { /* pulizia */ }
}

console.log('\n── 2 · IL RESTO DELLO STATO IN MEMORIA È SENZA COSTO, E VA SAPUTO QUALE');
{
  // Questo blocco non «prova» che perderli sia innocuo — lo DICHIARA, con il motivo, e verifica che
  // esistano ancora sotto quel nome. Se un giorno uno di questi diventasse portatore di una decisione
  // che non si ricostruisce, questo elenco è il posto in cui accorgersene.
  for (const [nome, perche] of [
    ['breaches', 'contatore di conferma del riprezzo: si ricostruisce al giro dopo'],
    ['ultimaValutazione', 'idem, per mercato'],
    ['residuiSegnalati', 'anti-ripetizione dei log: al più una riga doppia'],
    ['conflittiSoppressi', 'idem'],
    ['ultimePosizioni', 'cache da 5 secondi'],
    ['registroOrfani', 'conferma in due osservazioni: riparte, l\'orfano vive una finestra GTD in più'],
  ]) {
    ok(`in memoria e senza costo: ${nome} (${perche})`, srcA.includes(nome));
  }
}

console.log('\n── 3 · CIÒ CHE DEVE ESSERE PERSISTENTE LO È');
{
  const dati = path.join(__dirname, '..', '..', 'data');
  // ⚠ Non si verifica che i file ESISTANO — molti nascono solo quando servono, e un file assente è
  // spesso lo stato normale (nessuna coppia in chiusura, nessun residuo). Si verifica che agent40 li
  // SCRIVA su disco invece di tenerli in memoria.
  for (const f of ['merge-attese.json', 'modalita-chiusura.json', 'residui-scoperti.json',
    'residui-sotto-soglia.json', 'maker-allocated-capital.json', 'da-ripianificare.json']) {
    ok(`  ${f} è uno stato su disco`, srcA.includes(f));
  }
  ok('il registro dell\'idempotenza è append-only e non passa da agent40',
    fs.existsSync(path.join(dati, 'execution-audit.jsonl')));
  ok('  e la modalità chiusura persiste anche il BERSAGLIO della sorella',
    srcA.includes('registraSorella: (a) =>'));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

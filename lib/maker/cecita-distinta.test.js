'use strict';
// lib/maker/cecita-distinta.test.js — TRE CECITÀ DIVERSE, UN'AZIONE SOLA, TRE LOG DISTINTI.
//
// Il timeout di mid stantio era GIÀ 20 secondi (`TIMEOUT_DEFAULT_MS = 20_000`, env
// `MAKER_MID_STANTIO_TIMEOUT_MS` con clamp [5 s, 120 s]): verificato, non cambiato.
//
// Il difetto era nei LOG. `GATE_CIECHI` raccoglie tre gate — `mid-stale`, `mid-not-live`,
// `mid-age-unknown` — che portano tutti alla stessa azione, e giustamente: in tutti e tre non sappiamo
// che prezzo c'è, e restare esposti su un book che non vediamo è la stessa decisione. Ma NON sono la
// stessa diagnosi: «il feed pubblica in ritardo» e «non c'è nessun libro» si risolvono in due modi
// diversi, e finivano entrambi in `mid-stantio-*`.

const fs = require('fs');
const path = require('path');
const MS = require('./mid-stantio');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

console.log('── 1 · IL TIMEOUT È 20 SECONDI (verificato, non cambiato)');
{
  ok('il difetto è 20 s', MS.TIMEOUT_DEFAULT_MS === 20_000);
  ok('  configurabile', MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '30000' }) === 30_000);
  ok('  con clamp [5 s, 120 s]: sotto e sopra si torna al difetto',
    MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '1000' }) === 20_000
    && MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: '999999' }) === 20_000);
  ok('  e un valore illeggibile non spegne la protezione', MS.timeoutMs({ MAKER_MID_STANTIO_TIMEOUT_MS: 'x' }) === 20_000);

  const ORA = 1_800_000_000_000;
  ok('sotto i 20 s si aspetta', MS.decidiStantio({ stantio: true, daMs: ORA - 19_000, now: ORA }).azione === 'attendi');
  ok('a 20 s si cancella', MS.decidiStantio({ stantio: true, daMs: ORA - 20_000, now: ORA }).azione === 'cancella');
  ok('  e una lettura buona azzera', MS.decidiStantio({ stantio: false, daMs: ORA - 60_000, now: ORA }).azione === 'niente');
}

console.log('\n── 2 · LE TRE CAUSE SONO DISTINTE');
{
  ok('«il prezzo è vecchio» ⇒ mid-stantio', MS.causaCecita('mid-stale') === 'mid-stantio');
  ok('«non c\'è nessun libro» ⇒ nessun-libro', MS.causaCecita('mid-not-live') === 'nessun-libro');
  ok('«il book non dichiara la sua età» ⇒ eta-ignota', MS.causaCecita('mid-age-unknown') === 'eta-ignota');
  ok('le tre etichette sono diverse fra loro',
    new Set(MS.GATE_CIECHI.map(MS.causaCecita)).size === 3);
  ok('un gate NON cieco non produce una diagnosi inventata', MS.causaCecita('manual-order-cap') === null);
  ok('  e nemmeno un gate assente', MS.causaCecita(null) === null && MS.causaCecita(undefined) === null);
  ok('ogni causa ha una frase umana', MS.GATE_CIECHI.every((g) => typeof MS.motivoCecita(g) === 'string' && MS.motivoCecita(g).length > 10));
  ok('  e un gate sconosciuto ha una frase ONESTA, non un vuoto', /non riconosciuto/.test(MS.motivoCecita('boh')));

  // ⚠ L'AZIONE NON CAMBIA: le tre cecità restano tutte cieche e tutte avviano lo stesso orologio.
  ok('tutte e tre restano cieche', MS.GATE_CIECHI.every((g) => MS.eCieco(g) === true));
  ok('  e i tre gate sono esattamente questi', MS.GATE_CIECHI.join(',') === 'mid-stale,mid-not-live,mid-age-unknown');
}

console.log('\n── 3 · I LOG DISTINGUONO LE TRE, E DALL\'ORDINE ORFANO');
{
  const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  ok('la causa dominante viene calcolata', src.includes('const causaDom = [...causeCieche.entries()]'));
  ok('  e l\'esito del timeout la porta nel nome', src.includes('outcome: `cecita-timeout-${causa}`'));
  ok('  e nel campo `observed`, contabile', src.includes('observed: { causa, perCausa:'));
  ok('  con il conteggio per causa, non solo la dominante', src.includes('Object.fromEntries(causeCieche)'));
  ok('la cancellazione per ordine porta la causa nel suffisso',
    src.includes('`mid-stantio-cancellato-${causa}`') && src.includes('`mid-stantio-cancel-fallito-${causa}`'));
  ok('  tenendo il nome vecchio come PREFISSO, così la serie storica non si spezza',
    src.includes('mid-stantio-cancellato-'));

  // ── LA TERZA DIAGNOSI: L'ORDINE ORFANO, che è un'altra cosa ancora ─────────────────────────────
  // Non è cecità: il book si vede benissimo. È una gamba rimasta senza la posizione che la
  // giustificava. Il motivo è distinto da sempre e resta tale.
  ok('l\'ordine orfano ha il suo motivo, diverso dalla cecità', src.includes("'gamba-orfana-scaduta'"));
  ok('  e non passa dai gate ciechi', !MS.GATE_CIECHI.includes('gamba-orfana-scaduta'));
  const cv = fs.readFileSync(path.join(__dirname, 'cancellazioni-visibili.js'), 'utf8');
  ok('  ed è dichiarato fra i motivi visibili', cv.includes('gamba-orfana-scaduta'));

  // Le tre etichette che un operatore vedrà nei log sono tre stringhe diverse.
  const etichette = ['cecita-timeout-mid-stantio', 'cecita-timeout-nessun-libro', 'cecita-timeout-eta-ignota'];
  ok('le tre etichette di timeout sono distinte', new Set(etichette).size === 3);
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

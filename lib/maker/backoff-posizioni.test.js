'use strict';
// lib/maker/backoff-posizioni.test.js — UN 429 SU /positions NON DEVE POTER FERMARE IL BOT.
//
// Sopra i 180 s di età dello snapshot OGNI piazzamento viene rifiutato. Fino al 12 agosto 2026
// `fetchVenuePositions` faceva UN tentativo: un rate-limit prolungato lasciava lo snapshot fermo e il
// bot smetteva di piazzare senza che nulla fosse rotto.
//
// ⚠ LA SOGLIA DEI 180 SECONDI NON È STATA TOCCATA, ed è la parte che conta: non è un fastidio, è la
// protezione che impedisce di piazzare su una fotografia vecchia delle posizioni. Il rifiuto resta —
// arriva solo dopo che i tentativi sono esauriti.

const fs = require('fs');
const path = require('path');
const MR = require('../maker/manual-reset');
const VP = require('../safety/venue-positions-snapshot');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

console.log('── 1 · LA PROGRESSIONE: 1s → 30s, CON JITTER');
{
  const senzaJitter = (n) => MR.attesaPosizioni(n, () => 0.5);
  ok('parte da 1 secondo', senzaJitter(1) === 1000);
  ok('  e raddoppia', senzaJitter(2) === 2000 && senzaJitter(3) === 4000 && senzaJitter(4) === 8000);
  ok('il tetto è 30 secondi e non si sfora mai',
    [1, 2, 3, 5, 8, 20, 100].every((n) => senzaJitter(n) <= 30_000));
  ok('  anche col jitter al massimo',
    [1, 2, 3, 5, 8, 20, 100].every((n) => MR.attesaPosizioni(n, () => 1) <= 30_000));
  // ⚠ IL JITTER NON È UN VEZZO: senza, ogni lettore riparte dallo stesso istante dopo lo stesso 429 e
  // riproverebbero tutti insieme — il modo di trasformare un rate-limit in un rate-limit permanente.
  const basso = MR.attesaPosizioni(3, () => 0);
  const alto = MR.attesaPosizioni(3, () => 1);
  ok('il jitter è ±25% e sposta davvero l\'istante', basso === 3000 && alto === 5000, `${basso} vs ${alto}`);
  ok('  e non produce mai un\'attesa negativa', [0, 0.5, 1].every((r) => MR.attesaPosizioni(1, () => r) >= 0));
  ok('i tentativi sono cinque', MR.POSIZIONI_TENTATIVI === 5);
}

console.log('\n── 2 · 429 E ERRORE GENERICO NON SI CONFONDONO');
{
  ok('429 è riconosciuto per quello che è', MR.classificaPositions({ status: 429 }).tipo === '429');
  ok('  e un 500 è un\'altra cosa', MR.classificaPositions({ status: 503 }).tipo === '5xx');
  ok('  un timeout è «rete»', MR.classificaPositions(null, new Error('ETIMEDOUT')).tipo === 'rete');
  ok('  e il resto è «errore»', MR.classificaPositions({ status: 404 }).tipo === 'errore');
  ok('i quattro tipi sono distinti', new Set([
    MR.classificaPositions({ status: 429 }).tipo,
    MR.classificaPositions({ status: 500 }).tipo,
    MR.classificaPositions(null, new Error('ECONNRESET')).tipo,
    MR.classificaPositions({ status: 404 }).tipo,
  ]).size === 4);
}

console.log('\n── 3 · IL COMPORTAMENTO, SENZA RETE E SENZA ATTESE VERE');
(async () => {
  const attese = [];
  const attendi = async (ms) => { attese.push(ms); };

  // Due 429 e poi la risposta buona: si arriva in fondo invece di arrendersi al primo.
  let n = 0;
  const r1 = await MR.fetchVenuePositions({
    address: '0xabc', attendi, rnd: () => 0.5,
    httpGet: async () => { n += 1; return n <= 2 ? { status: 429, data: null } : { status: 200, data: [{ size: 1 }] }; },
  });
  ok('due 429 e poi ok ⇒ la lettura riesce', r1.ok === true && r1.tentativi === 3);
  ok('  e ha atteso due volte, in progressione', attese.length === 2 && attese[0] === 1000 && attese[1] === 2000);
  ok('  il referto dice a quale tentativo è riuscita', /al tentativo 3 di 5/.test(r1.reason));

  // 429 per sempre: si arrende dopo cinque, e lo dice col tipo giusto.
  attese.length = 0;
  const r2 = await MR.fetchVenuePositions({
    address: '0xabc', attendi, rnd: () => 0.5, httpGet: async () => ({ status: 429, data: null }),
  });
  ok('429 continuo ⇒ cinque tentativi e poi si dichiara', r2.ok === false && r2.tentativi === 5);
  ok('  con quattro attese fra i cinque tentativi', attese.length === 4);
  ok('  e il motivo NOMINA il 429, non un generico errore', r2.tipo === '429' && /429/.test(r2.reason));

  const r3 = await MR.fetchVenuePositions({
    address: '0xabc', attendi, rnd: () => 0.5, httpGet: async () => { throw new Error('ETIMEDOUT'); },
  });
  ok('un timeout continuo si distingue da un 429', r3.tipo === 'rete' && !/429/.test(r3.reason));

  // ── UN 200 CON UN CORPO STRANO NON SI RITENTA ─────────────────────────────────────────────────
  attese.length = 0;
  const r4 = await MR.fetchVenuePositions({
    address: '0xabc', attendi, rnd: () => 0.5, httpGet: async () => ({ status: 200, data: { non: 'una lista' } }),
  });
  ok('200 con corpo non-lista ⇒ NON si ritenta (la risposta sarebbe la stessa)',
    r4.ok === false && r4.tentativi === 1 && attese.length === 0);
  ok('  e lo dice invece di sembrare un errore di rete', r4.tipo === 'formato');

  ok('indirizzo assente ⇒ nessuna richiesta',
    (await MR.fetchVenuePositions({ address: null })).ok === false);

  console.log('\n── 4 · L\'ULTIMO TENTATIVO PRIMA DI RIFIUTARE, E LA SOGLIA CHE NON SI TOCCA');
  const tmp = path.join(require('os').tmpdir(), `snap-test-${process.pid}.json`);
  const scrivi = (at, positions) => fs.writeFileSync(tmp, JSON.stringify({ at, positions }));
  const ORA = 1_800_000_000_000;

  scrivi(ORA - 10_000, [{ tokenId: 'T', size: 5 }]);
  const fresco = await VP.readVenuePositionsConRefresh({ snapshotFile: tmp, now: () => ORA, refresh: async () => { throw new Error('non deve essere chiamato'); } });
  ok('snapshot fresco ⇒ NESSUN refresh (non si paga una richiesta per niente)',
    fresco.readable === true && fresco.rinfrescato === false);

  scrivi(ORA - 200_000, []);
  let rinfrescato = 0;
  const recuperato = await VP.readVenuePositionsConRefresh({
    snapshotFile: tmp, now: () => ORA,
    refresh: async () => { rinfrescato += 1; scrivi(ORA - 1_000, [{ tokenId: 'T', size: 9 }]); },
  });
  ok('snapshot vecchio ⇒ si prova a RIFARE la fotografia', rinfrescato === 1 && recuperato.rinfrescato === true);
  ok('  e se riesce il rifiuto non arriva', recuperato.readable === true && recuperato.positions.length === 1);
  ok('  con il motivo dichiarato', /rinfrescato con successo/.test(recuperato.motivoRefresh));

  scrivi(ORA - 200_000, []);
  const arreso = await VP.readVenuePositionsConRefresh({ snapshotFile: tmp, now: () => ORA, refresh: async () => { /* non riesce a rinfrescare */ } });
  ok('refresh che non risolve ⇒ IL RIFIUTO RESTA', arreso.readable === false);
  ok('  ma «rifiutato senza provare» e «rifiutato dopo aver provato» restano distinguibili',
    arreso.rinfrescato === true && /ancora inutilizzabile/.test(arreso.motivoRefresh));
  const esplode = await VP.readVenuePositionsConRefresh({ snapshotFile: tmp, now: () => ORA, refresh: async () => { throw new Error('429'); } });
  ok('  e un refresh che esplode non propaga l\'eccezione', esplode.readable === false && /fallito: 429/.test(esplode.motivoRefresh));

  scrivi(ORA - 200_000, []);
  const senza = await VP.readVenuePositionsConRefresh({ snapshotFile: tmp, now: () => ORA });
  ok('senza rinfrescatore iniettato il comportamento è ESATTAMENTE quello di prima',
    senza.readable === false && senza.rinfrescato === false);
  try { fs.unlinkSync(tmp); } catch { /* pulizia best-effort */ }

  // ⚠ LA SOGLIA. Se un giorno qualcuno la allarga «per far passare gli ordini», questo test lo dice.
  ok('LA SOGLIA DEI 180 SECONDI NON È STATA TOCCATA', VP.MAX_AGE_MS === 180_000);

  console.log('\n── 5 · IL CABLAGGIO');
  const srcA = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('agent40 usa l\'ultimo tentativo dove serve', srcA.includes('posizioniFrescheOFallisci'));
  ok('  e il refresh SALTA la cache dei 5 secondi (che sarebbe il dato stantio)',
    srcA.includes('ultimePosizioni = { at: 0, res: null }; await leggiPosizioniVenue();'));
  ok('  il tipo di errore finisce nel log invece di essere schiacciato',
    srcA.includes('p.tipo ?') && srcA.includes('tentativi con backoff'));
  ok('la funzione sincrona resta invariata per chi non può aspettare',
    typeof VP.readVenuePositions === 'function' && VP.readVenuePositions.length <= 1);

  console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})();

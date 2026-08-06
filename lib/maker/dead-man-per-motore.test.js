#!/usr/bin/env node
'use strict';
// UN MOTORE CHE MUORE NON DEVE PORTARSI VIA IL LIBRO DELL'ALTRO.
//
// ═══ LA NOTTE CHE HA PRODOTTO QUESTO FILE (5-6 agosto 2026) ══════════════════════════════════════════
// 00:14:02.338  agent35-maker completa un ciclo, scrive il battito, e poi si blocca 129 secondi.
// 00:14:02→00:16:11  agent40-manual-reprice fa undici chiamate al venue OGNI CINQUE SECONDI, senza
//               saltarne una. È vivo, cicla, e sta applicando correttamente il suo guard sul mid vecchio
//               (216 skip consecutivi su TX-15, 73 su Ed Markey).
// 00:16:03.029  agent37 vede il battito di agent35 fermo da 121s (soglia 120s) e cancella TUTTO: nove
//               ordini reali su cinque mercati, $663 tornati fermi.
//
// E i nove ordini erano di agent40. Il battito di agent35 di quella notte dichiara `resolvedMarketIds`
// con cinque mercati; i nove cancellati stavano su cinque mercati DIVERSI. Per tutta la notte agent35
// aveva scritto, tre volte al minuto, «manual mode active, skip — the operator holds this market by
// hand»: non li aveva piazzati e non li avrebbe mai toccati.
//
// ═══ COSA VERIFICA QUESTO FILE ══════════════════════════════════════════════════════════════════════
//   1 · la decisione è pura e si legge da sola: chi è morto → cosa si cancella
//   2 · LA NOTTE DEL 6 AGOSTO, rigiocata: zero ordini cancellati invece di nove
//   3 · il guardiano NON è stato indebolito: motore morto davvero ⇒ i SUOI ordini spariscono lo stesso
//   4 · morti entrambi ⇒ spazzata totale, identica a prima
//   5 · un ordine non attribuibile non viene toccato da una cancellazione mirata
//   6 · la latch è PER MOTORE: la morte di uno non zittisce lo scatto sull'altro
//   7 · la garanzia strutturale regge: nessun modulo di PIAZZAMENTO nell'albero del guardiano
//
// NESSUN ORDINE REALE: adapter finti, orologio iniettato, file temporanei, nessuna rete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const BM = require('./battito-motori');
const CA = require('./cancel-all');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const SOGLIA = 120;
const NOW = Date.parse('2026-08-06T00:16:03.029Z');
const HB35 = Date.parse('2026-08-06T00:14:02.338Z');   // l'ultimo battito vero di agent35 quella notte

// Lo stato dei motori come lo costruisce `statoMotori`, ma con i battiti iniettati: nessun file, nessun
// orologio. `deps.readJson` è la sola porta da cui entrano i dati.
const stati = ({ ts35 = HB35, ts40 = null } = {}) => BM.statoMotori(NOW, SOGLIA, {
  readJson: (f) => (/manual-reprice-heartbeat/.test(f)
    ? (ts40 === null ? null : { ts: ts40 })
    : (ts35 === null ? null : { ts: ts35 })),
});

console.log('\n══ 1 · LA DECISIONE È PURA: CHI È MORTO → COSA SI CANCELLA');
{
  // agent35 morto (121s), agent40 vivo (battito di 2s fa): è la notte del 6 agosto.
  const s = stati({ ts35: HB35, ts40: NOW - 2_000 });
  const a35 = s.find((x) => x.id === 'agent35');
  const a40 = s.find((x) => x.id === 'agent40');
  ok('agent35 risulta MORTO', a35.stato === 'morto' && a35.stalenessSec === 121, `${a35.stato}/${a35.stalenessSec}s`);
  ok('agent40 risulta VIVO', a40.stato === 'vivo' && a40.stalenessSec === 2, `${a40.stato}/${a40.stalenessSec}s`);

  const d = BM.decidiAmbito(s);
  ok('l ambito è MIRATO, non totale', d.ambito === 'corsie', d.ambito);
  ok('  e la corsia è quella di agent35', d.corsie.join(',') === 'agent35', d.corsie.join(','));
  ok('  la corsia MANUALE non è nell elenco', !d.corsie.includes('manuale'));
}
{
  const d = BM.decidiAmbito(stati({ ts35: NOW - 3_000, ts40: NOW - 2_000 }));
  ok('nessuno morto ⇒ non si cancella niente', d.ambito === 'niente' && d.corsie.length === 0, d.ambito);
}
{
  const d = BM.decidiAmbito(stati({ ts35: HB35, ts40: NOW - 400_000 }));
  ok('morti ENTRAMBI ⇒ spazzata totale, come prima', d.ambito === 'tutto', d.ambito);
}
{
  // Il battito di agent40 non esiste ancora (primo deploy). Non è morto: non è mai nato.
  const s = stati({ ts35: NOW - 3_000, ts40: null });
  ok('battito assente = MAI AVVIATO, non morto', s.find((x) => x.id === 'agent40').stato === 'mai-avviato');
  ok('  e non fa scattare niente', BM.decidiAmbito(s).ambito === 'niente');
  // …e non deve nemmeno poter IMPEDIRE per sempre la spazzata totale: un motore mai nato non entra nel
  // denominatore, quindi agent35 morto da solo resta «tutti i motori nati sono morti».
  const s2 = stati({ ts35: HB35, ts40: null });
  ok('un motore mai nato non spegne il guardiano: 35 morto da solo ⇒ TOTALE',
    BM.decidiAmbito(s2).ambito === 'tutto', BM.decidiAmbito(s2).ambito);
}

console.log('\n══ 2 · LA NOTTE DEL 6 AGOSTO, RIGIOCATA');
{
  // I nove ordini com'erano: cinque mercati, tutti della corsia manuale (attribuiti dal registro).
  const MERCATI = [['0x4808488e', 1], ['0x576df075', 2], ['0xc16fade4', 2], ['0x9d54f82c', 2], ['0xd1f23e2b', 2]];
  const NOVE = MERCATI.flatMap(([m, n]) => Array.from({ length: n }, (_, i) => ({
    id: `${m}-manual-${i}`, market: m, price: 0.61, original_size: 61.2, size_matched: 0,
  })));
  // Il registro conosce tutti e nove: sono del pannello.
  const manualKeys = () => new Set(NOVE.map((o) => o.id));

  const cancellati = [];
  const adapterFinto = () => ({
    listOpenOrders: async () => ({ ok: true, count: NOVE.length, orders: NOVE }),
    cancelOrder: async (id) => { cancellati.push(id); return { ok: true, sent: true, orderId: id }; },
    cancelMarketOrders: async () => { throw new Error('una cancellazione MIRATA non deve mai usare cancelMarketOrders'); },
  });

  CA.cancelLaneOrders('agent35', { buildAdapter: adapterFinto, manualKeys }).then((r) => {
    ok('agent35 muore ⇒ ZERO ordini cancellati (erano tutti di agent40)', r.cancelled === 0, String(r.cancelled));
    ok('  nessuna chiamata di cancellazione è partita', cancellati.length === 0, String(cancellati.length));
    ok('  e i nove ordini risultano LASCIATI, con il loro proprietario',
      r.skipped.length === 9 && r.skipped.every((s) => s.corsia === 'manuale'), `${r.skipped.length} lasciati`);
    ok('  il venue era stato letto davvero: nove aperti prima', r.venueOpenBefore === 9, String(r.venueOpenBefore));

    console.log('\n══ 3 · IL GUARDIANO NON È STATO INDEBOLITO: SE MUORE IL PROPRIETARIO, SPARISCONO');
    cancellati.length = 0;
    CA.cancelLaneOrders('manuale', { buildAdapter: adapterFinto, manualKeys }).then((r2) => {
      ok('agent40 muore ⇒ i suoi nove ordini vengono cancellati', r2.cancelled === 9, String(r2.cancelled));
      ok('  uno per uno, per ID', cancellati.length === 9, String(cancellati.length));
      ok('  su cinque mercati', r2.markets.length === 5, String(r2.markets.length));
      ok('  col capitale che torna libero', Math.abs(r2.notionalUsd - 9 * 0.61 * 61.2) < 0.05, String(r2.notionalUsd));
      ok('  e nulla di estraneo viene lasciato indietro', r2.skipped.length === 0, String(r2.skipped.length));

      console.log('\n══ 4 · MORTI ENTRAMBI ⇒ LA SPAZZATA TOTALE È QUELLA DI SEMPRE');
      const spazzati = [];
      const adapterTotale = () => ({
        listOpenOrders: async () => ({ ok: true, count: NOVE.length, orders: NOVE }),
        cancelMarketOrders: async (m) => { spazzati.push(m); return { ok: true, canceled: NOVE.filter((o) => o.market === m).map((o) => o.id) }; },
      });
      CA.cancelVenueOrders('polymarket', { buildAdapter: adapterTotale }).then((r3) => {
        ok('nove cancellati', r3.cancelled === 9, String(r3.cancelled));
        ok('  per MERCATO, come ha sempre fatto', spazzati.length === 5, String(spazzati.length));
        ok('  e senza chiedere a nessuno di chi fossero: è proprio l intento',
          r3.skipped === undefined, JSON.stringify(r3.skipped));

        console.log('\n══ 5 · UN ORDINE NON ATTRIBUIBILE NON VIENE TOCCATO DA UNA MIRATA');
        const tolti = [];
        const misto = () => ({
          listOpenOrders: async () => ({ ok: true, count: 3, orders: [
            { id: 'A', market: '0xaa', price: 0.5, original_size: 100 },   // del pannello
            { id: 'B', market: '0xbb', price: 0.5, original_size: 100 },   // di agent35
            { id: 'C', market: '0xcc', price: 0.5, original_size: 100 },   // ignoto
          ] }),
          cancelOrder: async (id) => { tolti.push(id); return { ok: true, sent: true, orderId: id }; },
        });
        // Il registro conosce solo A. B e C non sono suoi: B diventa 'agent35' (c'è evidenza per A,
        // quindi il registro è leggibile), e non esiste nessun caso in cui C sia 'manuale'.
        CA.cancelLaneOrders('manuale', { buildAdapter: misto, manualKeys: () => new Set(['A']) }).then((r4) => {
          ok('viene tolto solo l ordine del pannello', tolti.join(',') === 'A', tolti.join(','));
          ok('  gli altri due restano, classificati', r4.skipped.length === 2 && r4.skipped.every((s) => s.corsia !== 'manuale'),
            JSON.stringify(r4.skipped));

          // E con un registro VUOTO nessun ordine è attribuibile: una mirata non tocca niente, mai.
          tolti.length = 0;
          CA.cancelLaneOrders('agent35', { buildAdapter: misto, manualKeys: () => new Set() }).then((r5) => {
            ok('registro vuoto ⇒ tutto è «sconosciuto» ⇒ una mirata non cancella NIENTE',
              r5.cancelled === 0 && tolti.length === 0, `${r5.cancelled} cancellati`);
            ok('  e lo dice: tre ordini lasciati, nessuno attribuito',
              r5.skipped.length === 3 && r5.skipped.every((s) => s.corsia === 'sconosciuto'), JSON.stringify(r5.skipped));

            console.log('\n══ 6 · LA LATCH È PER MOTORE');
            {
              const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent37-maker-watchdog.js'), 'utf8');
              ok('lo stato tiene una voce per motore', /state\.motori\[s\.id\]/.test(src));
              ok('  e la latch si riarma sul battito DI QUEL motore',
                /if \(prev\.lastHeartbeatTs != null && s\.ts > prev\.lastHeartbeatTs\) prev\.triggeredForEpisode = false;/.test(src));
              ok('  la spazzata totale passa ancora da cancelAllOrders', /results = await doCancelAll\(\{ credsProviders \}\)/.test(src));
              ok('  e quella mirata da una corsia per volta', /doCancelLane\(s\.corsia, \{ credsProviders \}\)/.test(src));
            }

            console.log('\n══ 6bis · IL GUARDIANO VERO, GUIDATO PER INTERO DA FUORI');
            {
              // `poll()` di agent37, con orologio, battiti, cancellazioni, Telegram e file di stato tutti
              // iniettati: nessun venue, nessun orologio di sistema, e soprattutto nessuna scrittura sullo
              // stato del guardiano in esecuzione. È la decisione VERA, non una sua imitazione.
              const WD = require('../../agents/agent37-maker-watchdog.js');
              const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
              const stateFile = path.join(dir, 'stato.json');
              const chiamate = { totale: 0, corsie: [] };
              const base = {
                now: () => NOW,
                stateFile,
                transport: async () => 200,
                buildCancelCredsProviders: async () => ({}),
                registraCancellazione: () => ({ ok: true, written: true, count: 1, reason: null }),
                cancelAllOrders: async () => { chiamate.totale++; return [{ venue: 'polymarket', ok: true, cancelled: 9, venueOpenBefore: 9, simulated: false, markets: [], notionalUsd: 336 }]; },
                cancelLaneOrdersAllVenues: async (corsia) => { chiamate.corsie.push(corsia); return [{ venue: 'polymarket', corsia, ok: true, cancelled: 0, venueOpenBefore: 9, simulated: false, markets: [], skipped: new Array(9).fill({ corsia: 'manuale' }), notionalUsd: 0 }]; },
              };

              // LA NOTTE DEL 6 AGOSTO, dentro il guardiano vero.
              WD.poll({ ...base, stati: stati({ ts35: HB35, ts40: NOW - 2_000 }) }).then((r) => {
                ok('scatta', r.action === 'triggered', r.action);
                ok('  in modo MIRATO', r.ambito === 'corsie', String(r.ambito));
                ok('  sulla sola corsia di agent35', r.corsie.join(',') === 'agent35', r.corsie.join(','));
                ok('  la spazzata totale NON viene chiamata', chiamate.totale === 0, String(chiamate.totale));
                ok('  e il referto dichiara chi era morto e chi vivo',
                  r.evento.motoriMorti[0].id === 'agent35' && r.evento.motoriVivi[0].id === 'agent40',
                  JSON.stringify({ m: r.evento.motoriMorti.map((x) => x.id), v: r.evento.motoriVivi.map((x) => x.id) }));
                ok('  col conteggio di cosa è stato LASCIATO in piedi', r.evento.ordiniLasciati === 9, String(r.evento.ordiniLasciati));

                // Secondo giro identico: la latch di agent35 ha già scattato → silenzio.
                WD.poll({ ...base, stati: stati({ ts35: HB35, ts40: NOW - 2_000 }) }).then((r2) => {
                  ok('un secondo giro non ri-cancella', r2.action === 'already-triggered', r2.action);
                  ok('  e non chiama niente', chiamate.corsie.length === 1, String(chiamate.corsie.length));

                  // Ora muore ANCHE agent40, mentre agent35 è ancora fermo: la latch di agent35 è tirata,
                  // ma quella di agent40 no — la morte del primo non deve poter zittire il secondo.
                  WD.poll({ ...base, stati: stati({ ts35: HB35, ts40: NOW - 400_000 }) }).then((r3) => {
                    ok('muore anche agent40 ⇒ si scatta di nuovo', r3.action === 'triggered', r3.action);
                    ok('  e adesso è la SPAZZATA TOTALE', r3.ambito === 'tutto' && chiamate.totale === 1,
                      `${r3.ambito} · totale=${chiamate.totale}`);

                    // agent35 torna a battere: la sua latch si riarma da sola.
                    WD.poll({ ...base, stati: stati({ ts35: NOW - 1_000, ts40: NOW - 1_000 }) }).then((r4) => {
                      ok('tornano a battere entrambi ⇒ silenzio', r4.action === 'quiet-fresh', r4.action);
                      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                      ok('  e le latch si sono riarmate',
                        st.motori.agent35.triggeredForEpisode === false && st.motori.agent40.triggeredForEpisode === false);
                      fine();
                    });
                  });
                });
              });
            }

            function fine() {
            console.log('\n══ 7 · LA GARANZIA STRUTTURALE REGGE: IL GUARDIANO NON PUÒ PIAZZARE');
            {
              // La sola cosa che rende accettabile dare al guardiano una decisione più fine: il suo
              // albero di require non deve poter toccare il modulo che FIRMA ordini. Si verifica
              // caricando davvero i moduli nuovi e guardando la cache.
              for (const k of Object.keys(require.cache)) delete require.cache[k];
              require('./battito-motori');
              require('./attribuzione-ordini');
              require('./cancel-all');
              const piazzamento = Object.keys(require.cache).filter((p) => /polymarket-clob-maker/.test(p));
              ok('nessun modulo di PIAZZAMENTO nell albero del guardiano', piazzamento.length === 0, piazzamento.join(', '));
              const manual = Object.keys(require.cache).filter((p) => /maker\/manual-order/.test(p));
              ok('  e nemmeno manual-order, che quel modulo se lo tira dietro', manual.length === 0, manual.join(', '));
            }

            console.log(`\ndead-man per motore: ${pass} passati, ${fail} falliti`);
            process.exit(fail ? 1 : 0);
            }
          });
        });
      });
    });
  });
}

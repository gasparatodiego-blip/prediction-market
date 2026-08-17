#!/usr/bin/env node
'use strict';
// scripts/cli/stato.js — TUTTO LO STATO CHE CONTA, IN UNA SCHERMATA.
//
//   node scripts/cli/stato.js
//
// ═══ COSA MOSTRA, E CON QUALE FIDUCIA ════════════════════════════════════════════════════════════
// Ogni riga dichiara da dove viene, perché non sono tutte della stessa qualità:
//   · le cinque cinture d'armamento           ← `/proc/<pid>/environ` dei PROCESSI VIVI, non il `.env`
//   · KILL, AVVIA/FERMA, mercati, manopola    ← i file sotto `data/` e `ecosystem.config.js`,
//                                               attraverso gli STESSI moduli degli agent
//   · ordini a riposo                         ← RICOSTRUITI dal giornale, e l'età è dichiarata
//
// ⚠ GLI ORDINI A RIPOSO SONO UNA RICOSTRUZIONE, NON UNA LETTURA. Chiederli al venue richiede una
// chiamata autenticata che passa dall'adapter, cioè dalla stessa superficie che sa PIAZZARE — e questo
// comando non deve poterlo fare. Si legge quindi l'ultima riga `manual-list` senza filtro di mercato
// che agent40 ha già scritto nel giornale, esattamente come fa l'osservatore (§5-bis p.144), e si
// stampa l'ETÀ accanto al numero: una ricostruzione di trenta secondi fa e una di mezz'ora fa non
// sono la stessa informazione, e chi legge deve poterlo vedere.
//
// ⚠ QUESTO COMANDO NON CAMBIA NIENTE. È sola lettura, e §PERIMETRO in fondo lo verifica camminando
// `require.cache`: se un giorno importasse `lib/venues/`, la schermata lo direbbe in rosso.

const fs = require('fs');
const path = require('path');
const C = require('./_comune');

C.caricaEnv();

const KS = require('../../lib/safety/kill-switch');
const BE = require('../../lib/maker/bot-enabled');
const ARC = require('../../lib/maker/auto-reprice-config');
const D = require('../../lib/maker/distanza-obiettivo');
const RL = require('../../lib/safety/risk-limits');
const VP = require('../../lib/safety/venue-positions-snapshot');
// Le cinture: puro, e per questo importabile senza violare il §PERIMETRO in fondo.
const CIN = require('../../lib/maker/cinture-armamento');

const riga = (etichetta, valore, nota) =>
  console.log('  ' + String(etichetta).padEnd(26) + valore + (nota ? '  ' + C.col.spento(nota) : ''));

// ── 1 · LE CINQUE CINTURE, LETTE DAI PROCESSI VIVI ──────────────────────────────────────────────
// ⚠ QUI SI LEGGEVA IL `.env`, E MI HA MENTITO UNA VOLTA (17 agosto 2026). Il file diceva
// `MAKER_PLACEMENT` vuota mentre `/proc/<pid>/environ` dei processi vivi diceva `send`: pm2 tiene la
// propria copia dell'ambiente, e i due divergono a ogni riavvio fatto senza ripartire dal file (§5.1,
// §5.2 p.2). **Il file dice cosa e' stato scritto; il processo dice cosa sta usando** — e prima di armare
// conta solo il secondo.
//
// L'aritmetica sta in `lib/maker/cinture-armamento` (puro, importabile senza violare il §PERIMETRO qui
// sotto), dove `MANUAL_ORDER_PLACEMENT` e il freno di agent41 sono la FONTE e le altre tre sono uno
// specchio dell'adapter provato da `cinture-armamento.test.js`.
//
// ⚠ IL `.env` SI MOSTRA ANCORA, ma dichiarato per quello che e': cosa entrerebbe al PROSSIMO riavvio dal
// file. Toglierlo del tutto renderebbe invisibile una divergenza che e' proprio quella da sorvegliare.
C.titolo('CINTURE — dai processi vivi (/proc), non dal .env');
{
  const env0 = C.leggiEnvFile();
  if (!env0.presente) console.log('  ' + C.col.rosso('.env ASSENTE') + C.col.spento('  — nessuna credenziale, nessun database: la catena non parte'));
  const flotta = C.flottaViva();
  const piazzano = C.processiCheDecidonoUnPrezzo().map((a) => a.name);
  if (!flotta.leggibile) {
    console.log('  ' + C.col.giallo(`pm2 non leggibile (${flotta.error})`) + C.col.spento('  ⇒ non so cosa stiano usando i processi, e «non lo so» non e\' «disarmato»'));
  }
  const letture = [];
  for (const nome of piazzano) {
    const v = flotta.per.get(nome);
    const amb = v && v.pid ? C.envDiProcesso(v.pid) : null;
    if (!amb) {
      console.log('  ' + C.col.giallo('?') + ' ' + nome + C.col.spento(`  ambiente non leggibile${v ? ` (pid ${v.pid || '—'}, ${v.stato})` : ' (non in pm2)'} ⇒ non lo so`));
      continue;
    }
    const st = CIN.statoCinture(amb);
    letture.push({ nome, pid: v.pid, st });
    const testa = st.puoPiazzare
      ? C.col.rosso(`${nome} (pid ${v.pid}): TUTTE E CINQUE APERTE`)
      : C.col.verde(`${nome} (pid ${v.pid}): ${st.inserite}/5 inserite`);
    console.log('\n  ' + C.col.grassetto(testa));
    for (const c of st.cinture) {
      const val = c.valore === null ? '(assente)' : (c.valore === '' ? '(vuota)' : c.valore);
      console.log('    ' + (c.inserita ? C.col.verde('▪ inserita') : C.col.rosso('▫ APERTA  '))
        + '  ' + String(c.nome).padEnd(26) + C.col.spento(String(val).slice(0, 22).padEnd(22))
        + C.col.spento(c.cosaGoverna));
    }
    if (st.attestazioneFinanziamento.attestata) {
      console.log('    ' + C.col.giallo('▫ APERTA  ') + '  ' + 'MAKER_FUNDING_APPROVED'.padEnd(26)
        + C.col.spento('true'.padEnd(22)) + C.col.spento('attestazione, NON una delle cinque: il gate non rifiuta piu\' per questo'));
    }
  }
  // ⚠ DUE PROCESSI CHE DECIDONO UN PREZZO CON CINTURE DIVERSE SONO DUE BOT DIVERSI. Va detto, non
  // lasciato dedurre confrontando due elenchi a occhio — e' la classe di §5.1 (riavvio scoordinato).
  if (letture.length > 1) {
    const impronta = (x) => x.st.cinture.map((c) => `${c.nome}=${c.inserita ? 'I' : 'A'}`).join(',');
    const distinte = new Set(letture.map(impronta));
    if (distinte.size > 1) {
      console.log('\n  ' + C.col.rosso('⚠ LE CINTURE DIVERGONO fra i processi che decidono un prezzo: si riavviano DAL FILE e INSIEME (§5.1).'));
    } else {
      console.log('\n  ' + C.col.spento(`i ${letture.length} processi che decidono un prezzo portano le STESSE cinture.`));
    }
  }
  // ── E COSA ENTREREBBE AL PROSSIMO RIAVVIO DAL FILE ────────────────────────────────────────────
  {
    const dalFile = CIN.statoCinture(env0.valori || {});
    const diverse = [];
    for (const l of letture) {
      for (let k = 0; k < dalFile.cinture.length; k += 1) {
        if (dalFile.cinture[k].inserita !== l.st.cinture[k].inserita) diverse.push(`${l.nome}:${dalFile.cinture[k].nome}`);
      }
    }
    console.log('\n  ' + C.col.spento(`.env (cosa entrerebbe al prossimo riavvio DAL FILE): ${dalFile.inserite}/5 inserite`)
      + (diverse.length ? '  ' + C.col.giallo(`⚠ DIVERGE dai processi su: ${[...new Set(diverse)].join(', ')}`) : C.col.spento('  — coerente con i processi vivi')));
  }
}

// ── 2 · I DUE INTERRUTTORI ──────────────────────────────────────────────────────────────────────
C.titolo('INTERRUTTORI');
{
  const k = KS.checkKill({});
  riga('KILL', k.killed ? C.col.rosso('ATTIVO') : C.col.verde('spento'),
    k.killed ? `${k.gate} — ${String(k.reason).slice(0, 70)}` : 'emergenza assoluta, ferma anche l\'uscita automatica');

  const b = BE.statoBot();
  const testo = b.enabled ? C.col.verde('AVVIA') : C.col.giallo('FERMA');
  riga('AVVIA / FERMA', testo, b.leggibile
    ? (b.at ? `da ${new Date(b.at).toISOString().replace('T', ' ').slice(0, 19)}Z · ${b.by || 'ignoto'}` : '')
    : C.col.rosso(`illeggibile — fermo per prudenza (${b.motivo})`));
  if (b.reason) console.log('  ' + ' '.repeat(26) + C.col.spento(b.reason));
  if (!b.enabled) console.log('  ' + ' '.repeat(26) + C.col.spento('il bot non apre posizioni nuove; le posizioni aperte restano gestite'));
}

// ── 3 · I MERCATI ───────────────────────────────────────────────────────────────────────────────
C.titolo('MERCATI');
{
  const cfg = ARC.readAutoRepriceConfig();
  if (!cfg.readable) {
    riga('configurazione', C.col.rosso('ILLEGGIBILE'), `${cfg.error} — nessun mercato è attivo (fail-closed)`);
  } else {
    riga('interruttore riprezzo', cfg.globalEnabled ? C.col.verde('acceso') : C.col.giallo('spento'),
      cfg.globalEnabled ? '' : 'con questo spento nessun opt-in di mercato ha effetto');
    const attivi = cfg.enabledMarketIds || [];
    riga('mercati attivi', attivi.length ? C.col.ciano(String(attivi.length)) : C.col.spento('0'),
      attivi.length ? '' : 'in live-min l\'adapter rifiuterebbe: live-min-market-unset');
    for (const id of attivi) console.log('    ' + C.col.verde('●') + ' ' + id);
    // ⚠ IL PERNO SI LEGGE DAI PROCESSI, come le cinture: dal `.env` diceva un'altra cosa. Il perimetro
    // vero, con l'unione di §4.8 applicata, lo stampa `node scripts/cli/mercati.js`.
    for (const nome of C.processiCheDecidonoUnPrezzo().map((a) => a.name)) {
      const v = C.flottaViva().per.get(nome);
      const amb = v && v.pid ? C.envDiProcesso(v.pid) : null;
      const perno = amb ? (CIN.statoCinture(amb).perno) : null;
      if (perno) console.log('    ' + C.col.ciano('⚲') + ' ' + perno + C.col.spento(`   (perno di ${nome}, da /proc — RESTRINGE il perimetro a uno solo)`));
    }
  }
}

// ── 4 · ORDINI A RIPOSO E POSIZIONI ─────────────────────────────────────────────────────────────
C.titolo('A LIBRO — ricostruito, non letto dal venue');
{
  const giornale = path.join(C.ROOT, 'data', 'polymarket-maker-audit.jsonl');
  const coda = C.codaFile(giornale);
  let ultimo = null;
  if (coda) {
    for (const l of coda.split('\n')) {
      if (l.indexOf('"manual-list"') < 0) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.op !== 'manual-list') continue;
      const mid = j.requested ? j.requested.marketId : undefined;
      const n = j.response ? Number(j.response.count) : NaN;
      // ⚠ SOLO le righe SENZA filtro di mercato: una riga filtrata conta gli ordini di UN mercato, e
      // scambiarla per il totale direbbe «2 ordini» mentre a libro ce ne sono venti.
      if ((mid === null || mid === undefined) && Number.isFinite(n)) ultimo = { n, at: j.ts };
    }
  }
  if (!fs.existsSync(giornale)) {
    riga('ordini a riposo', C.col.spento('—'), 'il giornale non esiste ancora: agent40 non ha mai girato su questa macchina');
  } else if (!ultimo) {
    riga('ordini a riposo', C.col.spento('—'), 'nessuna riga `manual-list` senza filtro nella coda del giornale: non lo so, e non lo invento');
  } else {
    riga('ordini a riposo', C.col.ciano(String(ultimo.n)), `osservati ${C.eta(Date.now() - ultimo.at)} da agent40`);
  }

  const p = VP.readVenuePositions();
  if (!p.readable) {
    riga('posizioni al venue', C.col.giallo('non leggibili'), p.reason);
    console.log('  ' + ' '.repeat(26) + C.col.spento('⚠ finché è così, il gate `venue-positions-unreadable` rifiuta ogni apertura di esposizione nuova'));
  } else {
    const n = (p.positions || []).length;
    const val = (p.positions || []).reduce((a, x) => a + (Number(x.size) * Number(x.curPrice) || 0), 0);
    riga('posizioni al venue', C.col.ciano(`${n}`), `valore $${val.toFixed(2)} · snapshot di ${C.eta(p.ageMs)}`);
  }
}

// ── 5 · I TETTI E LA MANOPOLA ───────────────────────────────────────────────────────────────────
C.titolo('LIMITI');
{
  const r = RL.resolveLimits({ userId: 'op' });
  if (!r.ok) riga('limiti di rischio', C.col.rosso('ILLEGGIBILI'), 'ogni piazzamento fallisce chiuso');
  else {
    const L = r.limits;
    riga('per ordine', `$${L.maxOrderNotionalUsd}`, 'nessun singolo ordine può superarlo');
    riga('esposizione aperta', `$${L.maxOpenNotionalUsd}`, 'conta i fill RICONCILIATI, non gli ordini a riposo');
    riga('invii per finestra', `${L.maxOrdersPerWindow} / ${Math.round(L.windowMs / 1000)}s`, '');
    riga('perdita giornaliera', `$${L.maxDailyLossUsd}`, 'oltre, scatta un kill per utente');
  }
  // ⚠ LA MANOPOLA SI LEGGE DAL PROCESSO VIVO, NON DAL FILE. `--update-env` non rilegge
  // `ecosystem.config.js` (§5.1), quindi il file puo' dire una cosa e il processo usarne un'altra —
  // e quella che decide il prezzo di un ordine e' la seconda. Si mostrano entrambe quando divergono:
  // «il file dice 0,444 e agent40 sta usando 0,95» e' un'informazione, «0,444» da solo e' una bugia.
  const flotta = C.flottaViva();
  const decisori = C.processiCheDecidonoUnPrezzo();
  const letture = decisori.map((a) => {
    const vivo = flotta.per.get(a.name);
    const env = vivo && vivo.pid ? C.envDiProcesso(vivo.pid) : null;
    return {
      nome: a.name,
      nelFile: a.env ? a.env[D.ENV_FRAZIONE] : undefined,
      nelProcesso: env ? env[D.ENV_FRAZIONE] : undefined,
      leggibile: !!env,
    };
  });
  const effettivi = letture.map((l) => (l.leggibile ? l.nelProcesso : l.nelFile));
  const uguali = new Set(effettivi).size === 1;
  const f = D.leggiFrazione({ [D.ENV_FRAZIONE]: effettivi[0] });
  riga('distanza dal mid', uguali ? (f == null ? C.col.spento('manopola spenta') : C.col.ciano(`${f}·v`)) : C.col.rosso('DIVERGENTE'),
    uguali ? `su ${decisori.length} processi che decidono un prezzo` : `⚠ classe D1: ${letture.map((l) => l.nome + '=' + effettivi[letture.indexOf(l)]).join(', ')}`);
  for (const l of letture) {
    if (!l.leggibile) {
      console.log('  ' + ' '.repeat(26) + C.col.giallo(`${l.nome}: processo non leggibile — mostrato il valore del FILE (${l.nelFile ?? 'assente'})`));
    } else if (String(l.nelProcesso) !== String(l.nelFile)) {
      console.log('  ' + ' '.repeat(26) + C.col.rosso(`⚠ ${l.nome}: il file dice ${l.nelFile ?? 'assente'}, il processo sta usando ${l.nelProcesso ?? 'assente'} — serve un riavvio DAL FILE`));
    }
  }
}

// ── 5-bis · LA SELEZIONE AUTOMATICA DEI MERCATI ─────────────────────────────────────────────────
C.titolo('SELEZIONE DEI MERCATI');
{
  const SELM = require('../../lib/maker/selezione-mercati');
  const SELS = require('../../lib/maker/selezione-stato');
  const s = SELS.leggiStato();
  if (!s.leggibile) {
    riga('automatica', C.col.rosso('ILLEGGIBILE ⇒ SPENTA'), `${s.error} — la lista resta quella scritta a mano`);
  } else {
    riga('automatica', s.attiva ? C.col.verde('ACCESA') : C.col.giallo('spenta'),
      s.attiva ? `agent41 sceglie fino a ${SELM.MAX_MERCATI_CONTEMPORANEI} mercati a ogni ciclo`
        : 'la lista si scrive a mano con `mercati.js`');
    riga('vincoli', C.col.spento(`minSize ≤ ${SELM.MIN_SIZE_MASSIMA} · scadenza ≥ ${SELM.ORIZZONTE_MINIMO_ORE} h · niente meteo`), '');
    const voci = Object.entries(s.stato.selezionati || {});
    riga('slot occupati', C.col.ciano(`${voci.length} / ${SELM.MAX_MERCATI_CONTEMPORANEI}`),
      voci.length ? '' : 'nessun mercato scelto');
    for (const [id, v] of voci) {
      const uscente = v.uscenteDal != null;
      console.log('    ' + (uscente ? C.col.giallo('◐') : C.col.verde('●')) + ' ' + id.slice(0, 12) + '… ' + String(v.question || '').slice(0, 46)
        + (uscente ? C.col.giallo(`  [IN USCITA: ${v.motivoUscita} — lo slot si libera a posizione chiusa]`) : ''));
    }
    console.log('  ' + ' '.repeat(26) + C.col.spento('dettaglio e prova a vuoto: node scripts/cli/selezione.js prova'));
  }
}

// ── 6 · LA FLOTTA ───────────────────────────────────────────────────────────────────────────────
C.titolo('FLOTTA');
{
  delete require.cache[require.resolve(C.ECOSYSTEM)];
  const cfg = require(C.ECOSYSTEM);
  const definiti = (cfg.apps || []).map((a) => a.name);
  riga('processi definiti', C.col.ciano(String(definiti.length)), 'in agents/ecosystem.config.js');

  // ⚠ DEFINITO NON E' VIVO, ed e' la distinzione che questa schermata non faceva. Fino al 15 agosto
  // 2026 qui c'era solo la riga sopra: diceva «11» a flotta accesa e avrebbe detto «11» a flotta
  // spenta. Nel frattempo CLAUDE.md §5.1 affermava che la flotta «non e' mai stata avviata» — ed era
  // vero quando fu scritto e falso da quando qualcuno l'ha avviata, senza che nulla lo dicesse.
  // Adesso lo stato viene dal RUNTIME, e le due liste si confrontano nei due versi.
  const flotta = C.flottaViva();
  if (!flotta.leggibile) {
    riga('processi vivi', C.col.giallo('NON LEGGIBILI'), `${flotta.error} — non lo so, e non lo invento`);
  } else {
    const vivi = [...flotta.per.entries()].filter(([, v]) => v.stato === 'online').map(([n]) => n);
    const attesa = [...flotta.per.entries()].filter(([, v]) => v.stato !== 'online').map(([n, v]) => `${n} (${v.stato})`);
    const definitiSpenti = definiti.filter((n) => !flotta.per.has(n));
    const viviNonDefiniti = [...flotta.per.keys()].filter((n) => !definiti.includes(n));
    riga('processi ONLINE', vivi.length ? C.col.verde(String(vivi.length)) : C.col.rosso('0'),
      vivi.length ? vivi.join(', ') : 'la flotta non sta girando: nessun ciclo, nessuna scoperta, nessun guardiano');
    if (attesa.length) riga('non online', C.col.giallo(String(attesa.length)), attesa.join(', '));
    if (definitiSpenti.length) riga('definiti ma assenti', C.col.giallo(String(definitiSpenti.length)),
      `${definitiSpenti.join(', ')} — mai avviati, o rimossi da pm2`);
    if (viviNonDefiniti.length) riga('vivi ma NON definiti', C.col.rosso(String(viviNonDefiniti.length)),
      `${viviNonDefiniti.join(', ')} — girano con codice che ecosystem.config.js non descrive piu'`);
  }
  riga('dashboard', definiti.some((n) => n === 'dashboard') ? C.col.rosso('NELLA FLOTTA') : C.col.verde('assente'),
    'le decisioni si prendono da qui, non da un pannello');
}

// ── PERIMETRO ───────────────────────────────────────────────────────────────────────────────────
// La proprietà da difendere non è «zero file sotto lib/venues/»: è «nessuna superficie che sappia
// PIAZZARE o CANCELLARE». Sono due cose diverse, e il primo controllo scritto qui le confondeva —
// si accendeva su `lib/venues/polymarket-clob/redact.js`, che `lib/safety/kill-switch` importa per
// oscurare i segreti nel proprio giornale. Quel file non firma, non chiama la rete e non conosce un
// ordine: è un sostitutore di stringhe, e chiamarlo «superficie di piazzamento» avrebbe insegnato a
// ignorare l'allarme — che è il modo in cui un presidio smette di servire.
// Quindi: si nominano le superfici VERE, e tutto il resto sotto lib/venues/ viene ELENCATO, così una
// dipendenza nuova non passa in silenzio nemmeno quando è innocua.
{
  const SA_AGIRE = /adapter|signer|credential|funder|proxy-wallet|ctf-relayer/i;
  const sottoVenues = Object.keys(require.cache).filter((p) => p.includes(`${path.sep}lib${path.sep}venues${path.sep}`));
  const pericolosi = sottoVenues.filter((p) => SA_AGIRE.test(path.basename(p)));
  const inerti = sottoVenues.filter((p) => !SA_AGIRE.test(path.basename(p)));
  console.log('');
  if (pericolosi.length) {
    console.log(C.col.rosso(`⚠ PERIMETRO VIOLATO: caricate ${pericolosi.length} superfici che sanno agire sul venue — ${pericolosi.map((p) => path.basename(p)).join(', ')}`));
  } else {
    console.log(C.col.spento('perimetro: nessuna superficie di piazzamento o cancellazione caricata (adapter, signer, credenziali, relayer CTF).'));
    if (inerti.length) {
      console.log(C.col.spento(`  sotto lib/venues/ è entrato solo: ${inerti.map((p) => path.basename(p)).join(', ')} — dichiarato, non ignorato.`));
    }
  }
}

console.log('');

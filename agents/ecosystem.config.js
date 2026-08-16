// Minimal .env loader (dotenv is not installed) — same pattern as scripts/maker-live-test-order.js.
// Fills only MISSING keys, so a value already exported in the shell still wins. This exists so that
// secrets referenced below (ADMIN_ACCESS_SECRET) resolve from .env, which is gitignored, instead of
// being inlined into this file, which is tracked. Values are never printed.
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  for (const f of ['.env', '.env.local']) {
    try {
      const txt = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2].replace(/\r$/, '');
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch { /* file absent → fine */ }
  }
})();

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// RIDUZIONE ALL'INSIEME MINIMO — 6 agosto 2026
//
// MOTIVO. Questo sistema serve a UNA cosa sola: i liquidity rewards su Polymarket. I rami scanner,
// arbitraggio multi-venue, copy trading, leaderboard e trader feed — il prodotto originale del vendor —
// sono stati abbandonati per decisione dell'operatore, che accetta consapevolmente di perderne le
// funzioni. Trenta processi sono stati fermati con `pm2 stop` (mai `pm2 delete`: le definizioni restano
// qui e tutto si riaccende con `pm2 start <nome>`).
//
// I NUMERI CHE L'HANNO DECISA. La box è un 4 GB con 3814 MB utilizzabili. Prima: 37 processi pm2,
// 2742 MB di RSS più 1303 MB in swap, Committed_AS al 105% del CommitLimit, dieci OOM kill in otto
// giorni. Il percorso critico dei rewards — feed, motore, watchdog, riprezzo, scheduler, dashboard,
// agent24 — pesa 444 MB. Il resto serviva rotte che in due giorni di log nginx hanno ricevuto ZERO
// richieste: /api/mm, /api/marketmaker, /api/poly-hft, /api/poly-whales, /api/leaderboard,
// /api/traders, /api/carry, /api/ticker, /api/copy, /api/prediction, /api/markets.
//
// ── PERCHÉ `autostart: false` E NON `autorestart: false` ──────────────────────────────────────────
// QUESTA È LA PARTE CHE NEL LUGLIO SCORSO È ANDATA STORTA, e vale la pena scriverla per esteso perché
// non è ovvia e ci è già costata una resurrezione silenziosa.
//
// Il 25 luglio agent-marketmaker fu fermato e marcato `autorestart: false`. Il 28 luglio, al reboot,
// era di nuovo online. Non per colpa di agent-monitor (non è nella sua lista) e non perché mancasse un
// `pm2 save`: il motivo sta nel codice di pm2.
//
// Al boot systemd esegue `pm2 resurrect` (unit pm2-root.service). Guardando lib/API/Startup.js, la
// resurrezione NON legge lo `status` salvato: costruisce `tostart` come «ogni nome nel dump che non è
// già in esecuzione» — e al reboot non è in esecuzione NIENTE — poi chiama `prepare` su ciascuno.
// L'unico campo che ferma davvero il lancio è in lib/God.js riga 223:
//
//     if (env_copy['autostart'] === false) { ...registra e basta... return cb(null, clu); }
//
// `autorestart` governa tutt'altro: cosa fare quando un processo GIÀ AVVIATO esce. Non ha voce sul
// lancio iniziale. E `autostart` assente non basta: la riga 180 mette lo status a STOPPED ma il
// confronto della 223 è `=== false`, quindi `undefined` prosegue e il processo parte lo stesso.
//
// Quindi: ogni app disabilitata qui sotto porta `autostart: false` ESPLICITO, e lo stesso valore è
// stato applicato allo stato vivo di pm2 prima di `pm2 save`, perché è il dump — non questo file — che
// il boot legge. Questo file protegge l'altro percorso, `pm2 start ecosystem.config.js`.
//
// RIACCENDERE UNO: `pm2 start ecosystem.config.js --only <nome>` dopo aver tolto il suo
// `autostart: false`, oppure `pm2 start <nome>` per una riaccensione temporanea. Poi `pm2 save`.
//
// ── IL DIFETTO DEL NEWS-GUARD: TROVATO IL 6 AGOSTO, CORRETTO LO STESSO GIORNO ─────────────────────
// ⚠ REGISTRO STORICO. Il consumatore descritto qui sotto — agent35-maker — È STATO RIMOSSO dalla
// flotta e dal repo il 9 agosto 2026, insieme ad agent37-maker-watchdog e all'intero meccanismo di
// ARMING. Quello che segue resta come memoria del difetto e del criterio, non come descrizione dello
// stato attuale: oggi la severità di agent27 raggiunge /api/rewards-unified e nessun rail di motore.
// agent27-news-guard era stato fermato con gli altri. È RIENTRATO poche ore dopo, perché la
// correzione al suo consumatore lo ha reso di nuovo utile: prima non lo era, e il motivo merita di
// restare scritto.
//
// COS'ERA. agent27 produce DUE file: /tmp/news-guard.json, che contiene i mercati con la loro
// severità, e /tmp/news-guard-state.json, che contiene solo la sua contabilità interna (alerted,
// bookHist, regimeState, actionCooldown, actionHourly, providerHealth) e NESSUN campo `markets`.
// agent35-maker leggeva il SECONDO e vi cercava `.markets`. Quel campo lì non è mai esistito, quindi
// `newsByMarket` era SEMPRE VUOTA: `newsForceClose` sempre falso e il rail `news-high` di
// lib/maker/risk-rails.js senza un solo input in tutta la vita del sistema. La severità di agent27
// raggiungeva solo /api/rewards-unified, che ha zero richieste.
//
// PERCHÉ È SOPRAVVISSUTO TANTO. Da fuori un rail SENZA input e un rail con input tranquillo producono
// lo stesso silenzio. Non c'era modo di distinguerli guardando lo stato del motore.
//
// COSA È STATO FATTO. agent35 ora legge /tmp/news-guard.json e ne adatta la forma (lì `markets` è un
// ARRAY di righe con `marketId` e `newsRisk` — la severità effettiva del regime, con isteresi —
// accanto a `severity`), filtrando per venue polymarket. Aggiunto un limite di età di 30 minuti: oltre
// quello la severità NON viene usata e la mappa resta vuota di proposito, perché un freno che si
// aziona su una notizia di ieri è peggio di un freno che non c'è, e uno bloccato su un 'high' stantio
// congelerebbe il mercato per sempre. E soprattutto: lo stato del motore pubblica ora `newsFeed`
// (file, età, se è fresco, quanti mercati portano severità, e PERCHÉ sono zero quando lo sono) più
// `newsSeverity` su ogni mercato — così la cecità che ha nascosto il difetto non può ripetersi.
//
// VERIFICATO il 6 agosto: 118 mercati con severità, file fresco, entrambi i mercati dell'universo di
// agent35 con `newsSeverity:'low'`, e il rail `news-high` che scatta su 'high' e su nient'altro.
//
// agent27 è quindi TENUTO ACCESO e sorvegliato da agent-monitor: se muore, il suo file invecchia,
// agent35 lo scarta dopo 30 minuti — correttamente — e il freno torna cieco.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name:          'agent27-news-guard',
      script:        './agents/agent27-news-guard.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      max_memory_restart: '150M',   // small: RSS text + a per-market news cache
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent24-liquidity-rewards',
      script:        './agents/agent24-liquidity-rewards.js',
      cwd:           '/root/prediction-market',
      restart_delay: 60000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent-monitor',
      script:        './agents/agent-monitor.js',
      cwd:           '/root/prediction-market',
      restart_delay: 10000,
      max_restarts:  20,
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent34-clob-ws',
      script:        './agents/agent34-clob-ws.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // Small + bounded: one WS connection, ≤120 subscribed assets, in-memory books
      // only (measured ~a few KB/subscription — see /tmp/clob-live-books.json memory{}).
      // Own process for FAILURE ISOLATION: a dead socket must never stall agent27 or
      // the dashboard. autorestart so a hard socket death self-heals.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent40-manual-reprice',
      script:        './agents/agent40-manual-reprice.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // The BAND-EXIT WATCHER for HAND-PLACED orders. Replaces the fixed ~180s GTD expiry on manual
      // orders with a price-driven rule: on a market whose auto-reprice switch is ON, a hand order rests
      // as GTC (no venue expiry) and is cancelled+re-placed ONLY when the live mid has moved enough to
      // push it out of the reward band. If the mid stays put, the order is never touched.
      //
      // INERT UNTIL SWITCHED ON. Both the global master switch and the per-market opt-in live in
      // data/maker-auto-reprice.json and default OFF, so this process running changes nothing on its own;
      // it logs "idle: disabled-global" and does no venue I/O at all. It also does nothing while the
      // global kill switch is set, or on a market that is not in manual mode.
      //
      // It owns no adapter, no credentials and no signing key: its only reachable venue surface is
      // lib/maker/manual-order.replaceManualOrder — the same function the panel's "Riprezza" button
      // calls — so MANUAL_ORDER_PLACEMENT, the caps, venue-rules and validateOrder() all still apply.
      // FOOTPRINT, measured rather than guessed: ~107 MB steady. Most of it is the CLOB read path's
      // ethers dependency, loaded once. Per cycle it does two small JSON reads, a getOpenOrders per
      // enabled market, and an INCREMENTAL tail of the append-only audit trail.
      //
      // WHY THE CEILING IS 350M AND NOT 200M. On a cold start the attribution cache has to catch up on
      // the whole audit trail (80 MB / 268k lines today, and it grows), which transiently peaks around
      // 158 MB before settling back to ~107 MB. At 200M pm2 killed the process mid-catch-up roughly twice
      // a minute — a restart loop with an EMPTY error log and exit code 0, because nothing crashed: pm2
      // was enforcing the ceiling. 350M leaves room for that one-off catch-up and for the trail to keep
      // growing, while still being a real ceiling at ~3x the steady state.
      // (Named 40: slots 36-39 erano book-velocity, maker-watchdog, tape-watchdog, net-rerun. Il 37 è
      // libero dal 9 agosto 2026 — il dead-man dei motori è stato rimosso con agent35 — e resta tale:
      // riusare un numero renderebbe illeggibili i log storici.)
      max_memory_restart: '350M',
      watch:         false,
      autorestart:   true,
      // ── MAKER_FUNDING_APPROVED — ESPLICITA, NON PIU' SOLO IMPLICITA (4 agosto 2026) ───────────────
      // ATTENZIONE A COSA QUESTA RIGA E' E A COSA NON E'. Non corregge un difetto: agent40 aveva GIA'
      // l'attestazione a runtime, perche' in testa al file c'e' un caricatore di .env scritto a mano
      // («pm2 does not auto-load project env files») che la legge da li' all'avvio.
      //
      // L'errore che ha prodotto questa riga vale piu' della riga stessa: /proc/<pid>/environ mostra
      // l'ambiente al momento dell'EXEC, non quello che il processo si costruisce dopo. Un processo che
      // scrive process.env all'avvio e' invisibile a /proc, e leggere /proc «invece di pm2» sembrava piu'
      // rigoroso mentre rispondeva a una domanda diversa da quella posta.
      //
      // Perche' tenerla comunque: due fonti che dicono la stessa cosa sono meglio di una che dipende dal
      // fatto che .env esista e sia leggibile dal processo, e cosi' la variabile diventa ispezionabile
      // dall'esterno (pm2 env, /proc) invece che solo dall'interno.
      //
      // NON accende niente: e' un'attestazione umana (il wallet e' finanziato e le approvazioni on-chain
      // ci sono). L'interruttore di invio resta MANUAL_ORDER_PLACEMENT, e restano kill-switch, cap,
      // venue-rules e validateOrder.
      //
      // ── LA MANOPOLA DELLA DISTANZA — QUI È IL RINNOVO CHE LA USA (13 agosto 2026) ────────────────
      // Questo processo RIPREZZA: `mm-tracking` chiama `planBehindBest` e `auto-reprice` chiama
      // `prezzoInCoda`, cioè le stesse due funzioni con cui agent41 apre. Senza la variabile qui, ogni
      // rinnovo riporterebbe l'ordine alla distanza di prima e cancellerebbe il test un ordine per
      // volta — il valore deve essere lo stesso sui tre processi che decidono un prezzo. Vedi il
      // blocco di agent41 per la decisione e per il costo misurato.
      //
      // ══ IL RIPREZZO SU EVENTO, CON 1s DI PAVIMENTO — richiesta dell'operatore, 15 agosto 2026 ═══
      // «event-driven sul tick del websocket se fattibile, altrimenti polling a 1 secondo». È
      // fattibile, ed è GIÀ COSÌ: `cadenza-adattiva.decidiCadenza` risponde «valuta ADESSO» appena il
      // feed di agent34 pubblica per quel mercato un book più recente di quello su cui si è deciso
      // l'ultima volta (`bookAggiornatoMs > bookValutatoMs`, agent40 riga 1485). La cadenza non è più
      // un tetto alla reattività: è il PAVIMENTO DI RIPOSO, cioè quanto si aspetta quando il feed tace.
      // Questa riga porta quel pavimento da 5s a 1s, che è anche il pavimento di sicurezza `MIN_MS` del
      // modulo: sotto il secondo non si scende comunque, e il feed non pubblica più in fretta.
      //
      // ⚠ NON ABBASSA NESSUNA SOGLIA, ed è la distinzione che questo file ha già scritto una volta:
      // guardare più spesso NON riprezza di più. `hysteresisTicks` (1) e `confirmSamples` (2) restano
      // esattamente dov'erano — l'operatore ha chiesto di tenerli — e con loro `minIntervalMs` (30s per
      // gamba) e `maxPerHour` (20 per mercato). Con 3 mercati e 2 gambe l'anello vale 6 valutazioni al
      // secondo su dati già in memoria: nessuna chiamata al venue nasce da una valutazione che dice no.
      //
      // ══ LE TRE CINTURE DI ARMAMENTO — SCRITTE IL 16 AGOSTO 2026, NON ANCORA IN SERVIZIO ═══════════
      // ⚠ QUESTE TRE RIGHE ARMANO IL PIAZZAMENTO DI ORDINI VERI CON CAPITALE REALE. Sono inerti finche'
      // il processo non viene riavviato DAL FILE (`pm2 restart agents/ecosystem.config.js --only …`):
      // pm2 tiene la propria copia dell'ambiente, un `pm2 restart <nome>` non rilegge questo file, e
      // l'autorestart da crash riusa l'ambiente in memoria. Al 16/08 i processi vivi portano ancora
      // MAKER_MODE=off, MAKER_PLACEMENT vuota e MAKER_ADAPTER_DRYRUN=true.
      //
      // PERCHE' STANNO QUI E NON NEL `.env`. Il `.env` le contiene gia' (`MAKER_MODE=live-min`), ed e'
      // INERTE: il caricatore `.env` di questi agent scrive solo le chiavi ASSENTI da `process.env`, e
      // pm2 ne inietta gia' una versione — quindi `off` vince su `live-min` per sempre. Un armamento che
      // dipende da quale delle due fonti ha parlato per prima non e' un armamento, e' un caso.
      //
      // ⚠ VANNO MESSE E TOLTE INSIEME SU agent40 E agent41. Sono i due processi che decidono un prezzo:
      // armarne uno solo produce un bot che apre e non rinnova (o viceversa), cioe' gambe che muoiono
      // per GTD in 23 minuti mentre le sorelle restano a libro. Vedi §5.1 di CLAUDE.md.
      //
      // COME SI DISARMA: si CANCELLANO queste righe e si riavvia dal file. Le assenze sono fail-closed
      // per costruzione — MAKER_MODE assente non e' in LIVE_MODES ⇒ rifiuto; MAKER_PLACEMENT assente ⇒
      // placement='dry-run'. Togliere e' piu' sicuro che scrivere, ed e' voluto.
      env:           { NODE_ENV: 'production', HOME: '/root', MAKER_FUNDING_APPROVED: 'true',
        // ⚠ 1000 → 5000 ms IL 16 AGOSTO 2026, DOPO AVER MISURATO IL DANNO. Il pavimento a 1 s era stato
        // chiesto per il riprezzo «event-driven»; con il lock per mercato in servizio ha prodotto
        // **789 `riprezzo-in-corso` e ZERO `manual-replace` in 22 minuti**, piu' 3 ordini morti di GTD
        // senza rinnovo. A 1 s i cicli di agent40 si sovrappongono quasi sempre — un giro dura piu' di
        // un secondo — quindi il lock, che e' corretto, blocca anche il percorso di RINNOVO invece
        // della sola corsa cancel+place.
        // ⚠ NON SI PERDE L'EVENT-DRIVEN: `cadenza-adattiva` valuta ADESSO appena il feed di agent34
        // pubblica un book piu' recente. Questo numero e' il PAVIMENTO DI RIPOSO, cioe' quanto si
        // aspetta quando il feed tace — non il tetto alla reattivita'.
        MAKER_AUTO_REPRICE_POLL_MS: '5000',
        // ══ IL TIMEOUT DEL MID STANTIO: 20 s → 120 s — 16 agosto 2026 ═══════════════════════════════
        // ⚠ LA RAGIONE NON E' «era scomodo», e' UN'INCOERENZA MISURATA. `decideReprice` rifiuta di
        // MUOVERE un ordine quando il mid supera i **60 s** in regime «vivo» (letto dal giornale:
        // «il mid e' vecchio di 63s, oltre i 60s ammessi»), mentre `mid-stantio` lo CANCELLAVA a 20 s:
        // il bot cancellava ordini che non era nemmeno disposto a riprezzare. La soglia di ritiro non
        // puo' essere piu' stretta di quella di riprezzo, o il ritiro arriva sempre per primo.
        // MISURATO il 16/08: 5 cancellazioni per mid stantio in 4 minuti su ordini CONFORMI — banda,
        // tick, minSize e tetti tutti verdi — cioe' capitale che stava maturando premi, tolto dal libro
        // perche' un mercato elections a 37 ore con 320 share di profondita' sta fermo venti secondi.
        // 120 s = il massimo del clamp `[5 s, 120 s]` e il doppio della tolleranza del regime vivo,
        // e resta ben sotto i 23 minuti della scadenza GTD: un feed davvero morto viene comunque
        // scoperto molto prima che gli ordini invecchino.
        MAKER_MID_STANTIO_TIMEOUT_MS: '120000',
        MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V: '0.95',
        // MAKER_MODE — TOLTA A FINE SESSIONE 16/08/2026: assente ⇒ non e' in LIVE_MODES ⇒ rifiuto.
        // MAKER_ADAPTER_DRYRUN — TOLTA: assente ⇒ il .env impone true ⇒ canWrite false.
        // MAKER_PLACEMENT — TOLTA: assente ⇒ placement 'dry-run'.
        // ⚠ LA QUINTA CINTURA, E NON E' UN DOPPIONE DI `MAKER_PLACEMENT` — 16 agosto 2026.
        // `MAKER_PLACEMENT` governa l'ADAPTER; questa governa la CORSIA MANUALE
        // (`lib/maker/manual-order.js:250`, «Deliberately NOT MAKER_PLACEMENT»), che e' la strada da cui
        // il bot piazza davvero: i suoi record portano `source: manual-ui`.
        // MISURATO il 16/08 alle 10:32:53 con le altre quattro cinture gia' tolte: due `postOrder` con
        // `outcome: dry-run-validated`, cioe' ordini costruiti, passati da TUTTI i gate e fermati
        // nell'istante prima della POST — `execution-audit.jsonl` a 0 byte, zero ordini al venue.
        // Qualunque valore diverso dalla stringa esatta `send` resta dry-run.
      },
    },
    {
      name:          'agent38-tape-watchdog',
      script:        './agents/agent38-tape-watchdog.js',
      cwd:           '/root/prediction-market',
      restart_delay: 15000,
      max_restarts:  20,
      // Continuity watchdog for the rewards TRADE-TAPE + MID-HISTORY journals (Jul-25 45h collection).
      // SEPARATE process by design — a watchdog inside agent34 dies with it. Reads only the two newest
      // daily journals (trailing-window tailRows, never the whole day), so a tiny footprint. It does NOT
      // duplicate agent34's socket self-heal (PING/35s watchdog/backoff); it catches the case those miss —
      // the process WEDGED-but-online with the files not growing — by restarting agent34 ONCE (by name,
      // never pkill) and, only if that fails, sending ONE Telegram alert per fault episode. Places nothing.
      max_memory_restart: '150M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent41-realloc-scheduler',
      script:        './agents/agent41-realloc-scheduler.js',
      cwd:           '/root/prediction-market',
      restart_delay: 30000,
      max_restarts:  20,
      // IL RIALLOCATORE PERIODICO. Ogni 6 ore chiede al VENUE (non alla cache locale) se i mercati in
      // gestione sono ancora quelli su cui il piano fu deciso — risolto, non più negoziabile, senza
      // banda, in scadenza, o con il montepremi crollato sotto metà — e se anche uno solo non lo è più
      // rifà il piano al saldo libero attuale (tetto 30% per mercato) e lo mette in opera con
      // lib/maker/allocation-reset.js. Se sono tutti ancora buoni non fa niente: niente churn.
      //
      // Il reset scatta per DUE motivi indipendenti, registrati separatamente: la VALIDITÀ (sopra) e il
      // VALORE — ogni ciclo ricalcola anche il piano ristretto ai mercati già in gestione e, se il piano
      // libero vale più del 20% in più, rialloca anche con tutti i mercati ancora validi.
      //
      // È L'UNICO PROCESSO CHE PUÒ CANCELLARE E PIAZZARE ORDINI VERI SENZA UNA CONFERMA UMANA, per
      // eccezione esplicita dell'operatore (3 agosto 2026). Perciò la riga qui sotto NON basta ad
      // accenderlo: senza REALLOC_SCHEDULER_ENABLED=1 il processo resta vivo e completamente inerte —
      // nessuna lettura del venue, nessun piano, nessun ordine.
      //
      // STATO ATTUALE — 7 agosto 2026: ACCESO, E FERMO PERCHÉ NESSUNO HA ANCORA PREMUTO AVVIA. Gira il
      // ciclo intero ogni 6 ore, entrambi i trigger, e scrive nel registro cosa AVREBBE fatto; non
      // cancella e non piazza niente.
      //
      // QUI NON C'È PIÙ NESSUN INTERRUTTORE FRA «RACCONTA» E «FA». C'era, era REALLOC_SCHEDULER_DRY_RUN,
      // ed è stata rimossa il 7 agosto 2026 insieme al codice che la leggeva. Adesso decide un flag
      // solo, `data/maker-bot-enabled.json`, che l'operatore commuta col tasto AVVIA/FERMA nella tab
      // Mercati e che agent41 rilegge A OGNI GIRO: non serve toccare questo file e non serve un
      // riavvio. Non rimettere qui una variabile per la stessa decisione — due interruttori per una
      // cosa sola significano che spegnerne uno non la spegne.
      //
      // Non apre nessuna strada nuova verso il venue: passa dalle stesse funzioni del bottone del
      // pannello (listManualOrders / cancelManualOrder in corsia cancel-only / runBulkAllocation), quindi
      // kill switch, cap di esposizione, rate limit 20/60s e gate per riga valgono identici. Ogni ciclo
      // finisce in data/realloc-scheduler.jsonl, un passo per riga.
      max_memory_restart: '400M',
      watch:         false,
      autorestart:   true,
      env:           {
        NODE_ENV: 'production', HOME: '/root',
        REALLOC_SCHEDULER_ENABLED: '1',   // ← fa esistere il processo; NON gli fa piazzare niente (vedi sopra).
        // ── DICHIARATA, NON PIÙ SOLO EREDITATA (4 agosto 2026) ────────────────────────────────────
        // Qui la fragilità è REALE, a differenza del caso di agent40: agent41 NON ha il caricatore di
        // .env scritto a mano che agent40 ha in testa al file (verificato: `grep -c "Load .env"` → 0).
        // Girava con MAKER_FUNDING_APPROVED=true solo perché la ereditava dall'ambiente del demone pm2
        // — cercandola in questo file non c'era, e nessuna riga di configurazione la garantiva.
        //
        // Perché conta proprio su questo processo: agent41 è l'UNICO che apre posizioni da solo. Se un
        // giorno il demone pm2 ripartisse da una shell pulita, agent41 perderebbe l'attestazione senza
        // che niente lo dica, e OGNI piazzamento verrebbe rifiutato con gate `funding-approval` —
        // silenziosamente, dentro un ciclo automatico che nessuno sta guardando. È lo stesso difetto
        // appena corretto su agent40, sul processo dove farebbe più danno.
        //
        // NON arma niente: è un'attestazione umana. L'interruttore fra «racconta» e «fa» resta la riga
        // qui sopra, e resta a 1.
        MAKER_FUNDING_APPROVED: 'true',

        // ══ IL GRADINO 6 DELLA SCALA DI SBLOCCO: DISARMATO — DECISIONE DELL'OPERATORE, 13/08/2026 ══
        // Il gradino «fermati-in-sicurezza» è stato cablato oggi (`53b80d8`): prima chiamava
        // `impostaBot` senza importarlo e moriva con un ReferenceError catturato, quindi la scala
        // dichiarava di aver fermato il bot mentre il bot restava su AVVIA. Falliva CHIUSO.
        //
        // Al primo riavvio quel gradino diventerebbe VERO, e FERMA **non ha riarmo automatico**: il
        // primo scatto richiederebbe una mano umana per far ripartire il bot. Con la causa a monte
        // ancora aperta (§5.2 p.21) è verosimile che scatti entro ore. L'operatore vuole il bot
        // autonomo, quindi il gradino resta disarmato finché non ci sono righe che dicano quanto
        // spesso sarebbe intervenuto.
        //
        // ⚠ DISARMATO NON VUOL DIRE ASSENTE. La scala sale fino a 6 e il gradino REGISTRA che sarebbe
        // scattato e perché — `data/realloc-scheduler.jsonl` (`tipo:'sblocco-progressivo'`,
        // `disarmato:true`) e l'audit maker (`outcome:'gradino-6-disarmato'`). È il dato che serve per
        // decidere se armarlo. Conta EPISODI, non tick: la scala non riesegue l'ultimo gradino finché
        // non torna sana.
        //
        // ⚠ NON TOCCA NESSUNA DIFESA VERA. Guardiano delle perdite (agent43), sentinella del collasso
        // e KILL non passano da questa scala e restano attivi.
        //
        // PER RIARMARLO DOMANI: si cancella questa riga (o si mette qualunque valore diverso da '0') e
        // si riavvia agent41. Il difetto in assenza della variabile è ARMATO — un env che sparisce non
        // può spegnere una difesa. La semantica vive in `lib/maker/sblocco-progressivo.gradinoSeiArmato`.
        SBLOCCO_GRADINO6_ARMATO: '0',

        // ══ LA MANOPOLA DELLA DISTANZA NELLA BANDA: 0,444 — TEST DELL'OPERATORE, 13/08/2026 ════════
        // Frazione della SEMIAMPIEZZA `v` della banda premiante (`lib/maker/distanza-obiettivo.js`).
        // Sulla banda modale v = 4,5¢ ⇒ pavimento di **2,0¢** dal mid, contro la posizione mediana
        // misurata di 1,0¢. NON è un bersaglio: è un pavimento, e il prezzo può solo ALLONTANARSI dal
        // mid — quindi «mai primo sul libro» è preservato per costruzione, e il bordo premiante resta
        // il paletto (oltre il bordo l'ordine si ferma AL BORDO, mai fuori).
        //
        // VALORE PRECEDENTE: **nessuno** — la manopola era committata e SPENTA (default `null`), cioè
        // la posizione la decideva `planBehindBest` da sola. Lo 0,222 con cui questo test è stato
        // descritto è la MEDIANA MISURATA di oggi, non una configurazione: non c'è nessun `0.222` da
        // nessuna parte, e per tornare indietro si CANCELLA questa riga (non si scrive 0.222).
        //
        // IL PREZZO, che l'operatore conosce e ha accettato: S(v,s) = ((v−s)/v)² è quadratica, quindi
        // 1,0¢ → 2,0¢ porta S da 0,6049 a 0,3086, cioè **−49% di punteggio per ordine**. Il ricavo
        // atteso non è il reward: è il TASSO DI FILL, che scende perché il prezzo è più lontano dal mid.
        //
        // ══ 15 AGOSTO 2026 — 0,95 RESTA, MA NON È PIÙ LEI A DECIDERE DOVE FINISCE L'ORDINE ═════════
        // L'operatore ha chiesto «gli ordini stanno al bordo esterno della banda premiante», ed è quello
        // che 0,95 chiede: il più lontano possibile dal mid. A decidere il punto d'arrivo è però ora il
        // MARGINE DAL BORDO (`distanza-obiettivo.bordiConMargine`, difetto **1 tick**), che ferma
        // l'ordine un tick PRIMA del limite premiante. Sulla banda modale v = 4,5¢ con tick 1¢:
        // 0,95 × 4,5 = 4,27¢ ⇒ arrotondato in fuori sarebbe 4,0¢ dal mid, il margine lo ferma a 3,0¢.
        //
        // Perché non è un tradimento della richiesta ma la sua unica forma sensata: al bordo nudo
        // S = ((4,5−4)/4,5)² = **0,0123**, un tick più dentro S = **0,1111** — nove volte tanto — e
        // soprattutto il bordo nudo dista dal limite meno di un tick, quindi l'ordine oscilla
        // dentro/fuori banda a ogni respiro del mid consumando un cancel+place per volta. Il margine è
        // la metà asimmetrica del trigger: si esce a `v + isteresi`, si rientra a `v − margine`.
        //
        // ⚠ IL MARGINE VIVE NEL CODICE, NON QUI, ed è voluto: `MAKER_DISTANZA_MARGINE_BORDO_TICK` non è
        // dichiarata in nessun blocco di questo file, quindi i due processi che decidono un prezzo
        // leggono lo stesso difetto e non possono divergere per un riavvio scoordinato — che è
        // esattamente il rischio che la manopola qui sotto porta con sé.
        MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V: '0.95',

        // ══ LE QUATTRO CINTURE DI ARMAMENTO — SCRITTE IL 16 AGOSTO 2026, NON ANCORA IN SERVIZIO ═════
        // ⚠ QUESTE RIGHE ARMANO IL PIAZZAMENTO DI ORDINI VERI CON CAPITALE REALE, e questo e' il
        // processo che APRE le posizioni: e' qui che fanno piu' danno se entrano per sbaglio.
        // Sono inerti finche' agent41 non viene riavviato DAL FILE
        // (`pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler`): pm2 tiene la
        // propria copia dell'ambiente, `pm2 restart <nome>` non rilegge questo file, e l'autorestart da
        // crash riusa l'ambiente in memoria. Al 16/08 il processo vivo porta ancora MAKER_MODE=off,
        // MAKER_PLACEMENT vuota, MAKER_ADAPTER_DRYRUN=true e il freno INSERITO.
        //
        // ⚠ VANNO ARMATE INSIEME A QUELLE DI agent40. Sono i due processi che decidono un prezzo:
        // armare solo questo produce un bot che apre e non rinnova — le gambe muoiono per GTD in 23
        // minuti mentre le sorelle restano a libro. Vedi §5.1 di CLAUDE.md.
        //
        // ⚠ `REALLOC_SCHEDULER_DRY_RUN: '0'` E' LA QUARTA CINTURA, ED E' SOLO DI QUESTO PROCESSO.
        // Il freno di prova (`lib/maker/freno-prova`) e' FAIL-CLOSED: assente ⇒ INSERITO. Scrivere '0'
        // e' l'unico modo di disinserirlo, e per questo non basta cancellare una riga per disarmarlo —
        // basta cancellarla per RIARMARLO. La direzione e' voluta: dimenticarsi di una riga rende il
        // bot piu' sicuro, mai meno.
        //
        // COME SI DISARMA TUTTO: si cancellano queste quattro righe (e le tre di agent40) e si riavvia
        // dal file. Ogni assenza e' fail-closed per costruzione.
        // MAKER_MODE — TOLTA A FINE SESSIONE 16/08/2026.
        // MAKER_ADAPTER_DRYRUN — TOLTA.
        // MAKER_PLACEMENT — TOLTA.
        // REALLOC_SCHEDULER_DRY_RUN — TOLTA: assente ⇒ freno di prova INSERITO (fail-closed).
        // ⚠ LA QUINTA CINTURA — vedi il blocco gemello di agent40. E' QUESTO il processo che apre, e
        // quindi e' questa la riga che fa partire gli ordini veri: `bulk-allocate` di agent41 passa da
        // `lib/maker/manual-order`, non dall'adapter, e legge `MANUAL_ORDER_PLACEMENT` e non
        // `MAKER_PLACEMENT`. Con le altre quattro gia' tolte, era l'unica cosa fra il piano e il venue.
        // MANUAL_ORDER_PLACEMENT — TOLTA: assente ⇒ la corsia manuale resta dry-run.
      },
    },
    {
      name:          'agent42-watch-makers',
      script:        './agents/agent42-watch-makers.js',
      cwd:           '/root/prediction-market',
      restart_delay: 20000,
      max_restarts:  20,
      // IL MONITOR DEI 21 MAKER DI RIFERIMENTO. Segue l'attività pubblica dei 21 wallet del manuale v2
      // (data/manuale-operativo-maker-v2.md) e ne ricava tre segnali: ingressi su mercati mai toccati,
      // convergenze (≥2 dei 21 sullo stesso mercato entro due ore) e ritiri pre-risoluzione. Scrive
      // data/maker-21-{eventi.jsonl,stato,statistiche,gamma-cache}.json e niente altro.
      //
      // È L'UNICO PROCESSO DELLA FLOTTA CHE NON PUÒ, NEMMENO IN LINEA DI PRINCIPIO, TOCCARE CAPITALE.
      // Non importa nulla da lib/maker/, non legge nessuno dei file che decidono il piazzamento, non
      // ha credenziali e non ne riceve dall'ambiente qui sotto: l'env dichiarato è il minimo che serve
      // a un processo node, senza una sola chiave. I file che scrive non hanno nessun lettore fra i
      // processi che piazzano — li legge solo /api/maker/watch-21, che a sua volta è di sola lettura.
      // Il segnale è informativo per COSTRUZIONE, non per disciplina: perché diventi un criterio di
      // selezione servirebbe una modifica esplicita all'allocatore, che non esiste.
      //
      // Perché un processo separato e non un ramo di agent34: agent34 parla col socket CLOB, che NON
      // porta l'identità di chi esegue (`last_trade_price` è {asset_id, price, side} — vedi
      // lib/clob-ws/live-book.js:125). L'attribuzione di un fill a un wallet esiste solo sulla
      // data-api, quindi questa è una fonte diversa con una cadenza diversa, e appenderla al processo
      // che tiene vivo il book significherebbe far dipendere il book da un polling che non gli serve.
      //
      // Cadenza 30 s + ~7 s di giro dei 21 wallet ⇒ un battito ogni ~37 s (agent-monitor lo sorveglia
      // con soglia 5 min). Un'assenza si recupera ripaginando la data-api; oltre 7 giorni diventa un
      // evento `buco` nel giornale, mai un silenzio.
      max_memory_restart: '250M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent43-guardian',
      script:        './agents/agent43-guardian.js',
      cwd:           '/root/prediction-market',
      restart_delay: 20000,
      max_restarts:  20,
      // IL GUARDIANO DELLE PERDITE ECONOMICHE. Sorveglia il CAPITALE, non i processi.
      //
      // NOME: era `agent42-guardian`, e condivideva il 42 con agent42-watch-makers qui sopra. pm2
      // distingue per nome intero e i due non collidevano, ma rompeva la convenzione «un numero, un
      // processo» che il resto della flotta rispetta (era la stessa regola del vecchio agent37,
      // «Named 37, not 36», rimosso il 9 agosto 2026). Rinominato
      // l'8 agosto 2026 in `agent43-guardian`, che era il candidato gia' indicato qui.
      //
      // COSA NON INSTRADA. La chiave di battito e' cambiata insieme al nome, ma NESSUNO la legge:
      // agent-monitor non sorveglia questo processo (non e' in WATCHED_AGENTS_RAW), e il dead-man dei
      // motori che guardava i battiti non esiste piu'. Il campo `by` del referto passa a `agent43-guardian` per i
      // referti NUOVI; quelli storici restano col nome vecchio, ed e' giusto — dicono chi li ha scritti.
      //
      // COSA FA CHE UN DEAD-MAN NON PUÒ FARE. Un dead-man chiede «il motore è vivo?» e guarda i battiti:
      // un motore che batte regolare e intanto perde soldi è, per lui, sano. Questo
      // guarda l'unica cosa che quella domanda non copre — il capitale scende? Ogni 30 s confronta
      // (saldo pUSD + posizioni al prezzo corrente) con il baseline in data/guardian-baseline.json, e
      // oltre GUARDIAN_LOSS_PCT o GUARDIAN_LOSS_ABS cancella tutti gli ordini a riposo, deposita un
      // referto reason='guardian-auto-kill' e mette il bot su FERMA. Sono due guasti indipendenti,
      // quindi due processi: un doppio scatto simultaneo è innocuo (la seconda cancellazione trova il
      // libro già vuoto e riporta 0, non un errore) e i due referti restano distinguibili per `id`.
      //
      // LE SOGLIE SI RILEGGONO A OGNI GIRO dal file .env, non da questo env: `process.env` in pm2 è una
      // fotografia dell'avvio, e una soglia che per cambiare pretende un riavvio è una soglia che
      // durante il riavvio non protegge. Qui NON si dichiarano quindi GUARDIAN_LOSS_*: metterle qui
      // creerebbe un secondo posto dove sono definite, e due posti per un numero solo significano che
      // cambiarne uno non lo cambia.
      //
      // NON PUÒ PIAZZARE, per costruzione: la sua unica superficie verso il venue è lib/maker/cancel-all
      // (adapter di sola cancellazione, signer che non sa firmare). lib/maker/guardian-perdite.test.js
      // cammina il suo albero di require e fallisce se qualcuno ci trascina dentro un modulo di
      // piazzamento, oltre a vietare signTypedData/postOrder/placeManualOrder nel sorgente.
      //
      // NON FERMA LE USCITE. Usa FERMA (data/maker-bot-enabled.json) e NON il kill-switch, perché il
      // kill blocca anche lib/maker/auto-close («una chiusura è comunque un ordine nuovo»): killare
      // lascerebbe senza uscita proprio le posizioni che c'era da proteggere. Vedi il blocco in testa
      // ad agents/agent43-guardian.js per il ragionamento completo, incluso ciò che FERMA NON copre.
      //
      // Footprint atteso da processo leggero (due letture JSON e una lettura di saldo in cache per giro),
      // con l'aggiunta del path ethers di saldo-cache: 200M lascia margine abbondante.
      max_memory_restart: '200M',
      watch:         false,
      autorestart:   true,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent44-audit-scoperta',
      script:        './agents/agent44-audit-scoperta.js',
      cwd:           '/root/prediction-market',
      // ── L'AUDIT DI SCOPERTA. TROVA, ARCHIVIA, ESCE. ──────────────────────────────────────────────
      // Legge il codice del bot una volta al giorno cercando i pattern di rischio che in questo
      // progetto hanno già prodotto guasti veri (costanti dello stesso concetto con valori diversi,
      // protezioni presenti su un percorso e assenti su un altro, flag che nessuno legge più, commenti
      // fermi a un valore vecchio, test rossi nuovi, collisioni di numerazione) e scrive
      // data/audit-coda.{json,md}. NON corregge niente e non tocca ordini né capitale — un test
      // cammina il suo albero dei require e fallisce se qualcuno ce li trascina dentro.
      //
      // ── PERCHÉ NON È SEMPRE VIVO, ED È LA COSA PIÙ IMPORTANTE DI QUESTO BLOCCO ───────────────────
      // Questo box ha DUE vCPU e dodici processi che gestiscono capitale reale, con load average già
      // intorno a 2. Un tredicesimo processo sempre in ascolto costerebbe RAM tutto il giorno per
      // lavorare due minuti. Quindi `cron_restart` + `autorestart: false`: pm2 lo avvia all'ora
      // giusta, lui gira, esce, e resta `stopped` fino al giorno dopo. Fra una scansione e l'altra
      // consuma ESATTAMENTE zero — si vede in `pm2 list`, dove sta a 0% e 0b.
      //
      // Perché pm2 e non una riga di crontab: la flotta di questo progetto è descritta in QUESTO file
      // e si ispeziona con `pm2 list`. Un job in crontab sarebbe l'unico pezzo invisibile a quella
      // convenzione — e la prima cosa che nessuno ricorderebbe di guardare. In più `pm2 save` lo porta
      // nel dump, quindi sopravvive a un riavvio della macchina senza un secondo posto da ricordare.
      //
      // ── L'ORA, SCELTA SUI DATI E NON A INTUITO ───────────────────────────────────────────────────
      // `sar` su nove giorni: le ore più quiete in UTC sono 02 (28,5% CPU), 03 (28,6%) e 04 (29,2%);
      // la peggiore è 08 (40,7%), poi 20 (39,0%) e 19 (38,7%). Fra le tre quiete si sceglie le 03
      // perché è l'unica che sta DOPO la finestra della riconciliazione notturna di agent40
      // (23:55 · 00:20 · 00:40 · 01:00) — così l'audit legge il confronto stima/consuntivo della notte
      // appena chiusa invece di quello del giorno prima — e prima della salita delle 06-08.
      // Il minuto 7 e non 0: in cima all'ora scattano i cron di sistema, e accodarsi a quelli sarebbe
      // il modo più semplice di rendere inutile tutto il resto di questo blocco.
      cron_restart: '7 3 * * *',
      autorestart:  false,
      // ── I TETTI DI RISORSA ──────────────────────────────────────────────────────────────────────
      // 150M è il taglio che questo repo usa già per i processi leggeri (agent38): non
      // introduce una scala nuova. La fotografia del codice sta in decine di MB, quindi c'è margine.
      // NB: con `autorestart:false` questo tetto è la seconda linea — la prima è il vigile interno
      // dell'agente, che si ferma da solo e SCRIVE PERCHÉ invece di essere ucciso in silenzio.
      max_memory_restart: '150M',
      watch:         false,
      // Se una scansione fallisce, il posto giusto per accorgersene è la coda del giorno dopo, non un
      // riavvio a raffica: `max_restarts` basso e `restart_delay` lungo perché anche il caso peggiore
      // (crash immediato in loop) non possa diventare un consumo di CPU.
      max_restarts:  3,
      restart_delay: 60000,
      // La priorità CPU/I/O NON si imposta qui: pm2 esegue lo script direttamente e non c'è modo di
      // anteporgli `nice`/`ionice`. È l'agente ad abbassarsi da solo alla prima riga di lavoro
      // (`os.setPriority` + `ionice -c 3` sul proprio pid), il che è anche più robusto — vale comunque
      // lo si lanci, anche a mano.
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
    {
      name:          'agent45-osservatore',
      script:        './agents/agent45-osservatore.js',
      cwd:           '/root/prediction-market',
      // ── L'OSSERVATORE MUTO. CAMPIONA, SCRIVE, NIENT'ALTRO. ──────────────────────────────────────
      // Un campione ogni 60 s in data/osservatore/: ordini a riposo, mercati coperti, posizioni,
      // saldo, PnL del guardiano, stato degli interruttori. Piu' un giornale in italiano con gli
      // eventi (pre-allarme, scatto, collasso, transizioni di copertura, merge, cancellazioni).
      //
      // ── PERCHE' E' SEMPRE VIVO, a differenza di agent44 ─────────────────────────────────────────
      // agent44 fotografa il CODICE, che fra una notte e l'altra non cambia da solo: puo' girare una
      // volta al giorno e uscire. Questo fotografa lo STATO, che cambia di minuto in minuto, e una
      // serie temporale con dei buchi non e' una serie temporale. Il costo e' quello di un processo
      // che dorme 59 secondi su 60 e legge qualche file: misurabile in pm2, non in percentuale di CPU.
      //
      // ── PERCHE' PUO' RIAVVIARSI DA SOLO SENZA CHIEDERE (§2 regola 2) ────────────────────────────
      // La regola 2 chiede conferma perche' un riavvio puo' cambiare cosa il bot FA. Questo processo
      // non fa niente: non piazza, non cancella, non tocca AVVIA/FERMA/KILL, e scrive esclusivamente
      // sotto data/osservatore/. Un test (`lib/osservatore/campionamento.test.js`) cammina il suo
      // albero dei `require` e fallisce se qualcuno ci trascina dentro l'adapter, il signer,
      // manual-order, cancel-all, bot-enabled o il kill switch. Riavviarlo puo' al piu' produrre un
      // buco nella serie — che il campione successivo DICHIARA come salto invece di nasconderlo.
      autorestart:   true,
      // 150M e' il taglio dei processi leggeri di questo repo (agent38, agent44): non introduce una
      // scala nuova. L'osservatore tiene in memoria l'ultima ora di campioni e poco altro; la coda del
      // giornale maker la legge in modo incrementale, con un tetto di 8 MB per giro.
      max_memory_restart: '150M',
      watch:         false,
      env:           { NODE_ENV: 'production', HOME: '/root' },
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LA POLITICA DI RIAVVIO DEI PROCESSI CRITICI — 12 agosto 2026
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL BUCO, MISURATO SUI PROCESSI VIVI e non dedotto dal file: tutti e dieci i processi critici girano
// con `max_restarts: 20` e `min_uptime` NON impostato, cioe' il difetto di pm2 di **1 secondo**.
// La semantica di pm2 e' questa: un'uscita prima di `min_uptime` conta come riavvio *instabile*, e al
// ventesimo instabile consecutivo pm2 marca l'app `errored` e **SMETTE DI RIPROVARE**.
//
//   oggi:  20 tentativi x 15 s di `restart_delay` = **5 minuti**, poi giu' per sempre.
//
// Cinque minuti e' quanto basta a un 429 prolungato del venue in fase di boot, o a un disco pieno che
// si libera da solo. E chi resta giu' non e' un processo qualsiasi: `agent43-guardian` e' l'unica cosa
// che sorveglia le perdite, e `agent40-manual-reprice` l'unica che gestisce le posizioni aperte.
// Dal 9 agosto 2026 (§5 punto 63, rimozione di agent37) **nessuno guarda piu' il loro battito**: un
// `errored` silenzioso non verrebbe notato da nessun meccanismo automatico.
//
// LA CORREZIONE, e le due cifre che la compongono:
//   · `min_uptime: 30_000` — un processo che sta su 30 s e' partito davvero, e il contatore degli
//     instabili si AZZERA. Il boot piu' lento della flotta e' agent40 (~5 s per agganciare il feed in
//     push), quindi 30 s sta comodamente sopra a tutti: un'uscita dentro quella finestra e' davvero
//     «non e' riuscito a partire», non «e' partito e poi e' successo qualcosa».
//   · `max_restarts: 500` — con i `restart_delay` gia' presenti (5-60 s, DELIBERATI e NON toccati qui)
//     diventano da ~42 minuti (dashboard, 5 s) a ~8 ore (agent24, 60 s) di tentativi prima di
//     arrendersi, contro i 5 minuti di adesso. E per esaurirli serve un crash loop VERO: qualunque
//     avvio che regga 30 s riporta il contatore a zero.
//
// PERCHE' QUI E NON IN DIECI BLOCCHI. La stessa decisione scritta dieci volte e' il reperto che il
// rilevatore D1 dell'audit cerca, e la divergenza qui vorrebbe dire «un processo critico ha una
// politica di riavvio diversa dagli altri e nessuno se n'e' accorto». Un punto solo, e un test
// (`lib/safety/riavvio-robusto.test.js`) che lo verifica leggendo il modulo.
//
// COSA NON TOCCA: `restart_delay` (per-agente, deciso caso per caso — agent24 ha 60 s per non
// martellare Gamma), `max_memory_restart`, `autostart`, e i processi FUORI dall'elenco. In
// particolare **agent44-audit-scoperta resta com'e'**: `autorestart:false` + `max_restarts:3` +
// `cron_restart` sono la sua politica giusta (§3), e applicargli questa lo trasformerebbe in un
// processo sempre vivo, che e' l'opposto di cio' che e'.
//
// ⚠ QUANDO DIVENTA EFFETTIVA. pm2 tiene la propria copia in memoria della descrizione del processo:
// un `pm2 restart <nome>` NON rilegge questo file. Serve `pm2 restart agents/ecosystem.config.js
// --only <nome>`. Finche' non lo si fa per un processo, quel processo gira con la politica vecchia.
const RIAVVIO_ROBUSTO = Object.freeze({
  autorestart: true,     // gia' il difetto di pm2, ma dichiarato: un difetto non e' una decisione
  min_uptime:  30_000,
  max_restarts: 500,
});

// I processi il cui `errored` silenzioso ha una conseguenza. `agent44-audit-scoperta` non c'e' per
// costruzione (vedi sopra), e nemmeno i trenta fermati dalla riduzione all'insieme minimo.
const PROCESSI_CRITICI = Object.freeze([
  'agent24-liquidity-rewards',   // il board: senza, il piano invecchia e il trigger smette di piazzare
  'agent27-news-guard',
  'agent34-clob-ws',             // i book: senza, ogni mercato diventa cieco e gli ordini si ritirano
  'agent38-tape-watchdog',
  'agent40-manual-reprice',      // riprezzo, uscita, merge: l'unico che gestisce le posizioni aperte
  'agent41-realloc-scheduler',   // l'unico che puo' piazzare da solo
  'agent42-watch-makers',
  'agent43-guardian',            // l'unico che sorveglia le perdite
  'agent-monitor',
  // ⚠ `dashboard` E' STATO TOLTO DA QUI E DALLE APP il 15 agosto 2026, su decisione dell'operatore:
  // le decisioni si prendono da terminale (scripts/cli/), e il pannello non deve MAI girare. Non e'
  // una riduzione di sorveglianza — il dashboard non sorvegliava niente, serviva pagine.
  // ⚠ I SORGENTI SOTTO app/ RESTANO SUL DISCO e non vanno archiviati: 32 test strutturali li leggono
  // come TESTO per verificare che la stessa protezione esista sui percorsi gemelli (§4.8). Un file che
  // nessun processo serve non e' un file che nessuno legge.
  // ⚠ E CON LUI SE N'E' ANDATO UN LETTORE DELLA MANOPOLA DELLA DISTANZA: restano due processi a
  // decidere un prezzo (agent41, agent40), e devono continuare a dichiarare lo STESSO valore.
  // `lib/maker/distanza-2c.test.js` difende quella proprieta' sull'insieme dei processi che esistono
  // davvero, non su un elenco di tre nomi scritto a mano.
]);

for (const app of module.exports.apps) {
  if (PROCESSI_CRITICI.includes(app.name)) Object.assign(app, RIAVVIO_ROBUSTO);
}

module.exports.RIAVVIO_ROBUSTO = RIAVVIO_ROBUSTO;
module.exports.PROCESSI_CRITICI = PROCESSI_CRITICI;

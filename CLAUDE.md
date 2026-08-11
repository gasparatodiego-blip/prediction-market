# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt**: non serve più reincollarlo ogni volta.

Ultima verifica contro codice/stato reali: **9 agosto 2026**, ~20:15 UTC.

> ## 🧮 UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO — §5 punto 72
> `planReconcile` confrontava **grandezze su scale diverse**: `totalFilled` è il volume dei trade del
> venue su un token+lato (per TOKEN), `already` è quanto risulta registrato per UNA `idempotencyKey`. Il
> ciclo di riprezzo sostituisce la stessa gamba ogni ~60 s e ogni sostituzione porta una chiave nuova:
> ognuna ritrovava lo stesso volume e lo registrava **intero** come fill proprio.
> **Misurato su Chengdu 37°C**: 136 righe di fill, 136 chiavi, `filledSize` sempre lo stesso valore reale
> (21,69 · 14 · 7,69) ⇒ **2.790,32 share di netto FIFO contro ZERO al venue**. `openNotionalUsd` $2.406
> contro un tetto di $600 ⇒ `limit-max-open-notional` rifiutava **ogni** piazzamento con AVVIA attivo e
> kill revocato. **Il bot si è fermato per una somma sbagliata, non per una regola.**
> **Corretto** (confronto omogeneo per token+lato, e per id-ordine-venue nel ramo `size_matched`) e
> **stato riparato**: 152 duplicati esatti rimossi, `openNotionalUsd` **$2.406,06 → $207,87**.
> **Effetto immediato e misurato: 951 ordini piazzati nelle 7 ore successive**, da zero. Capitale
> $689,80 contro il baseline $660,56 ⇒ **P&L +$29,24**. Il ledger **non si è rigonfiato**: 16 righe
> fill, zero nuove. agent40 (72) e agent41 (52) riavviati.

> ## 📖 IL GIORNALE DA 731 MB SI LEGGE, MA NON ERA LUI A BLOCCARE — §5 punto 71
> `readFileSync(file,'utf8')` costruisce UNA stringa e V8 si ferma a ~512 MB. A 731 MB i due lettori
> superstiti fallivano **chiuso**: `origine-ordine.mappaOrigini()` (⇒ ogni ordine «ignoto», il reset non
> cancella più niente) e `manual-reset.cancelledOrderIds()`. **Corretti** riusando il pattern già in
> servizio in `attribuzione-ordini`, ora **estratto** in `lib/maker/giornale-incrementale.js` invece di
> restare in tre copie. Misurato sul registro vero: **1307 chiavi in 3,2 s con 60 MB di RSS**.
> **⚠ MA NON SBLOCCA I PIAZZAMENTI, e la diagnosi precedente era sbagliata su questo punto.** Misurato
> DOPO il fix: ordini irrisolti **ZERO**; l'esposizione di **$2.405,91** viene per **$2.303,58** da
> posizioni **CONFERMATE** nel ledger dei fill — 8 posizioni, di cui **una da $1.925,32** — contro **6
> posizioni vere al venue per $126,45**. È un secondo difetto, diverso: il ledger dei fill non ha mai
> nettato posizioni chiuse. **Il bot resta bloccato dal tetto $600 finché non si affronta quello.**

> ## 🔓 IL GATE live-min LEGGEVA LA LISTA STRETTA — §5 punto 69
> §5 punto 62 aveva stabilito che la allowlist del gate live-min è «abilitati ∪ mercati con posizione
> aperta». L'unione **veniva calcolata e non la leggeva nessun percorso di piazzamento**: i due soli
> consumatori stavano nell'oggetto di STATO del pannello, e `buildPlacementAdapter` non inietta nessuna
> lista — quindi l'adapter cadeva sul proprio provider di difetto, `cfg.enabledMarketIds`.
> **Costo misurato su Ankara**: mercato tolto dal piano alle ~21:40, gamba NO fillata alle 21:46:47 (101
> share), e da lì **tutti e tre** i tentativi di comprare la gamba opposta (merge L2, chiusura rapida
> taker, controparte del riposizionamento) rifiutati con `live-min-market-mismatch`. Passava **solo il
> SELL**, per l'eccezione di riduzione. **Corretto**: il provider di difetto legge `liveMinMarketIds`.
> Non allarga il perimetro — aggiunge solo mercati dove il capitale è **già** esposto.
> **⚠ LO SCOPE DEL RINNOVO RESTA LA LISTA STRETTA** (`auto-reprice.js:1054`), ed è una decisione
> documentata: un mercato fuori dal piano non viene visitato, quindi i suoi ordini muoiono per GTD in 23
> minuti. Il fix **non** cambia questo. **Riavviati agent40 (70), agent41 (50), dashboard (175).**

> ## 🧟 LA GAMBA ORFANA NON VIENE PIÙ RINNOVATA — §5 punto 68
> Una coppia nasce con due gambe a riposo. Se una viene fillata e la posizione che ne nasce sparisce per
> una **causa esterna al ciclo** (Diego la chiude a mano), la gamba superstite restava sul libro e veniva
> **attivamente rinnovata** a ogni finestra GTD — `auto-close` itera le POSIZIONI e con zero posizioni non
> gira, `auto-reprice` itera gli ORDINI e la teneva viva, e la Regola 4 la teneva apposta. Un ordine
> mantenuto premiante che, se fillato, apre esposizione **direzionale non coperta**.
> **Misurato**: `0xd25c820d…` teneva 135,4 share, il giornale si interrompe alle 12:22:43 senza una riga
> di chiusura, e `merge-attese.json` portava ancora l'attesa di quel completamento (**$60,93**) nove ore
> dopo. Zero merge on-chain e zero SELL nostre: sparita, e nessuno se n'è accorto.
> **Adesso** al rinnovo GTD si chiede «la posizione che giustificava quest'ordine esiste ancora?». Una
> gamba sola + zero posizioni ⇒ si **cancella** invece di rinnovare, e il mercato torna da ripianificare
> per la **stessa strada del Lavoro B**. **Conferma in due osservazioni**: la prima arma soltanto, così la
> corsa del fill non può produrre una cancellazione. **ASPETTA IL RIAVVIO di agent40.**

> ## 💸 IL TETTO PER ORDINE ERA $25 CONTRO $130 PER MERCATO — CORRETTO E VIVO, §5 punto 67
> Il quinto punto del tetto, e l'unico rimasto fuori dall'unificazione del punto 65: non un tetto di
> allocazione ma un tetto **per ordine**, in **due** costanti indipendenti (`adapter.js:66` e la gemella
> `manual-order.js:94`). Con il bot su AVVIA ogni gamba moriva a `manual-order-cap`, utilizzo **16,4%**
> contro il 90%. Adesso è **uno solo e derivato**: `LIVE_MIN_ORDER_CAP_USD = MARKET_CAP_FIXED_USD/2 + 5`
> = **$70**, importato da entrambi.
> **⚠ $70 sblocca 2 mercati su 4:** il costo di una gamba è proporzionale al prezzo, quindi la finestra
> di mid ammessa è **[0,43 · 0,57]** — a mid 0,05 la gamba cara vale $113,83. Ammettere qualunque mid
> richiederebbe un tetto per ordine ≈ **$130**: decisione aperta per l'operatore.
> **⚠ E il «ripiego» non è più un ripiego:** `/tmp/maker-state.json` lo scriveva agent35, rimosso — quel
> file non sarà mai più fresco, quindi quella costante è l'**unico** percorso.
> **TRE RIAVVII ESEGUITI il 9 agosto, 21:04-21:06Z** (agent41 49, agent40 68, dashboard 174). Effetto al
> primo mini-ciclo: **2 ordini piazzati, 0 rifiutati** — la coppia di Ankara 32°C a $56,96 e $60,60,
> entrambe sopra il vecchio $25. Posizioni preesistenti **invariate**, impronta `5af077ed3e3359e4`
> identica, zero cancellazioni. **Nessun riavvio pendente per questo lavoro.**

> ## 🩹 LA RISPOSTA AL FILL È COMPLETA E CABLATA — §5 punto 66
> Quattro correzioni: **(a)** parziale vs completo è ora un ramo esplicito (`classificaFill`); **(b)** il
> rimasuglio sotto il minimo non finisce più solo a registro — si piazza anche un ordine «rimanenza» in
> banda; **(c)** contestualmente si apre la gamba contraria stessa size, **seconda e ultima** eccezione a
> «mai primo sul libro»; **(d)** il riposizionamento post-fill usa il **tetto in vigore** ($130) col
> ripiego `min(tetto, capitale libero)`, e parte da **entrambi** i percorsi terminali, non solo dal merge.
> **Le due letture sono ora CABLATE in agent40** (`tettoMercato`, `capitaleLibero`): senza di esse il
> punto (d) rispondeva `azione: 'niente'`. Provato sul ciclo vero: **$130 pieni** a capitale abbondante,
> **$80** a capitale ridotto, `accumula` sotto il minimo, `niente` se una delle due letture manca.
> **agent40 riavviato** — vedi §5 punto 66.

> ## 📏 IL TETTO PER MERCATO È $130 FISSI, E NON C'È PIÙ UN LIMITE DI POSIZIONI — §5 punto 65
> Era il **20% del capitale**: cresceva in dollari col saldo, quindi a capitale doppio il bot metteva il
> doppio su OGNI mercato invece di usarne di più. Adesso è **$130 fissi** su YES+NO sommati (~$65 per
> lato), scritto in `lib/rewards/concentration.js` e **importato da tutti e quattro** i consumatori —
> pianificatore, **motore di piazzamento (Regola 5)**, rimpiazzo gamba, punteggio di rischio.
> **`MAX_POSIZIONI = 10` è stato rimosso**: quanti mercati si usano è ora `capitale ÷ 130`, limitato solo
> dal pool qualificato reale.
> **Il rischio critico è chiuso e verificato**: il motore ACCETTA una riga da $130 sul saldo vero
> ($594,10) — col vecchio 20% avrebbe verificato contro $118,82 e rifiutato ogni riga del piano.
> **Copertura invariata: $588,00 e 99,0%.** A $1.000 usa 9 mercati invece di 6.
> **Aspetta il riavvio di agent41 e del dashboard** (§5 punto 65).

> ## 🕳️ IL BOOK SOTTILE ORA È UN CANCELLO, NON SOLO UN'ATTENUAZIONE — §5 punto 64
> Il tetto di credibilità (`maxCredibleShare = 0,60`) tagliava la quota di un book deserto ma **lasciava
> il mercato nel set**, e il knapsack massimizza: lo sceglieva lo stesso. Il piano del 9 agosto aveva
> **7 righe capate su 9** e dichiarava il 44%/giorno di rendimento. Ora `filtroProfondita` toglie quei
> mercati **prima** della scelta, con la **stessa misura e la stessa soglia** (importata, non
> ridichiarata), valutata a un metro fisso di **$500**.
> **La copertura del capitale non cambia:** $588,00 e **99,0%** con e senza, misurato sul board vero —
> col tetto al 20% bastano 5 mercati e ne restano 62. Righe capate **3/6 → 0/5**.
> **Il cancello è attivo** su ogni piano (nasce in un processo figlio). **agent41 è stato riavviato alle
> 18:19:20Z** su autorizzazione di Diego (restart 46 → 47, 102/102 variabili, 9/9 critiche, zero errori
> nuovi): serviva solo per la riga di rendiconto per ciclo, che comparirà al primo piano calcolato —
> col KILL attivo, il prossimo ciclo fisso. **Nessun riavvio pendente per questo lavoro.**

> ## 🧹 MAKER ARMING, agent35 E agent37 SONO STATI RIMOSSI — §5 punto 63
> Decisione dell'operatore, eseguita il 9 agosto 2026. Non esistono più: il **motore automatico**
> (`agent35-maker`), il suo **dead-man** (`agent37-maker-watchdog`) e l'intero meccanismo di
> **ARMING** (modulo, preflight, cinque route, pannello, `data/maker-arming.json`). I comandi
> dell'operatore sono ora **due**: **AVVIA/FERMA** e **KILL**.
> **Il KILL è invariato e verificato** — 25/25 nel suo selfcheck, 13/13 in `kill-blocca-avvia`, e la
> rotta continua a non importare nessuna superficie di piazzamento. L'unica riga tolta dalla rotta era
> il ritiro dell'arming, che era un **parametro opzionale**.
> **Il ciclo automatico non è stato toccato**: agent41 (riallocazione + mini-ciclo) e agent40
> (riprezzo, uscita, merge) sono identici — 59/59, 72/72, 36/36.
> **DUE `pm2 delete` E UN `pm2 restart` SONO IN ATTESA DELLA TUA AUTORIZZAZIONE** (§5 punto 63):
> finché non li esegui, i due processi rimossi dal repo **continuano a girare** col codice che avevano
> in memoria, e il dashboard serve ancora il build vecchio.

> ## ⛓️ LA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA — §5 punto 55
> `MAX_CATENA` era 64 e cresce di **un anello al minuto** su una gamba ripiazzata a ogni giro: l'uscita
> su Dallas era murata a 64/64. Alzato a **20.000** (~2 settimane). La protezione anti-doppio-invio non
> è il tetto — è la verifica che l'ordine precedente sia morto, e resta intatta a ogni anello.
> **Il merge on-chain HA funzionato:** tx `0x0711b86f…414e`, `STATE_CONFIRMED`, 36,3 share fuse alle
> 07:59:19. La posizione Dallas YES che il portfolio mostra ancora **non esiste più** sul venue.

> ## 🧩 LA REGOLA GENERALE DEL LATO SCOPERTO — §5 punto 54
> Qualunque lato posseduto senza controparte, **da qualunque causa** (fill, residuo di merge parziale,
> chiusura rapida incompleta), segue sempre le stesse tre regole: riposiziona a **+1% dal carico** dentro
> banda e mai sotto il carico, apri **contestualmente** il limit contrario, e se la quantità è sotto il
> minimo del venue **accumulala** in `data/residui-scoperti.json` per mercato/lato invece di lasciarla
> muta. Un solo punto di convergenza (`auto-close.js`, esito `rinuncia`), non tre toppe. Il minimo è del
> venue e **per mercato** — 20/50/100/200 sui 108 mercati del board, non una costante nostra.

> ## 📐 I TETTI DI CAPITALE ERANO FERMI A $600 SU UN CAPITALE DI $850,82 — CORRETTO, §5 punto 53
> `maker-allocated-capital.json` lo scriveva solo il ciclo da 6h; il mini-ciclo ricalcolava un piano ogni
> dieci minuti e non lo scriveva mai. I dodici tetti delle 03:42 sommavano **esattamente $600**, quindi
> l'utilizzo massimo teorico era **70,5%** contro un obiettivo del 90%: il deficit era reale e **nessun
> piano poteva colmarlo**. Stessa causa dietro `saltato-tetto-non-leggibile` su Dallas. Adesso il
> mini-ciclo aggiorna i tetti — in **unione** (non cancella chi ha del denaro nostro) e **solo quando
> cambia qualcosa davvero**, non a ogni giro. **Aspetta il riavvio: `pm2 restart agent41-realloc-scheduler`.**

> ## ✍️ IL MERGE ON-CHAIN NON HA MAI FIRMATO: MANCAVA IL FIRMATARIO — CORRETTO, §5 punto 52
> `CTF_RELAYER_ENABLED` è `true` **e vive nel processo dal riavvio delle 05:06** (agent40 restart 60):
> l'interruttore non è mai stato il problema, e il punto 49 che diceva il contrario è stato corretto.
> Il problema era che `auto-close.js` chiamava `mergePosition(id, size, { negRisk })` **senza `deps`**,
> quindi `ctf-relayer` moriva alla firma con `deps.signerProvider is not a function`. Misurato su Dallas
> (`cid_a7245f90…`): **21 tentativi in 21 minuti**, 21 righe `fase:'intento'` e **zero** righe
> `fase:'esito'`, con il nonce letto dal relayer ogni volta. Ora si passa il firmatario di
> `live-providers` — **lo stesso wallet** della corsia manuale, verificato on-chain.
> **Aspetta il riavvio: `pm2 restart agent40-manual-reprice`.**

> ## 🚦 IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO — 9 agosto 2026, §5 punto 43
> La **rampa** (5 mercati nuovi ogni 24h dall'AVVIA) non esiste più. Al suo posto un vincolo **continuo**
> guidato dall'obiettivo di utilizzo: si aprono mercati nuovi finché il capitale non è al lavoro, **mai
> più di 6 per giro**. Diagnosi che l'ha motivato, misurata sui dati veri alle 02:31 del 9 agosto:
> saldo **$644,39**, ordini a riposo **ZERO**, utilizzo **3,9%** contro l'obiettivo 90%, e il mini-ciclo
> che ogni dieci minuti ricalcolava un piano valido per poi buttarlo via con «rampa esaurita» — e sarebbe
> rimasto così fino alle 20:56. **Aspetta il riavvio di agent41 e del dashboard.**

> ## 🔧 UN SECONDO RIAVVIO PENDENTE, E SERVE UNA NUOVA CONFERMA DI DIEGO IN CHAT
> Il mini-ciclo sceglieva mercati che poi non poteva toccare: non faceva le tre scritture che il reset
> fa su ogni mercato del piano, e ogni gamba moriva al gate 1 di `placeManualOrder`. È la ragione per
> cui alle 20:56 dell'8 agosto il piano da $600 ha prodotto **0 ordini piazzati e 5 rifiutati** con il
> bot su AVVIA. **Non era l'arming**, che con agent41 non c'entra.
>
> Il riavvio delle **21:35** ha attivato una versione a **due** scritture, e la misura sui dati vivi ha
> mostrato che non bastava: `manual-mode-inactive` è sparito e il rifiuto si è spostato su
> `live-min-market-mismatch`, perché la corsia manuale chiede `mode: 'live-min'` **cablato**
> (`manual-order.js:733`) a prescindere dal `MAKER_MODE` del processo. La terza scrittura è entrata col
> riavvio delle **21:47** (restart 39) — **§5 punto 41** — e i due gate sono spariti dall'audit.
>
> **Resta un terzo difetto, ed è quello che tiene fermi i $608 adesso — §5 punto 42.** Il registro di
> idempotenza non sapeva cosa fosse una cancellazione, quindi una gamba cancellata dal mid stantio non
> era più ripiazzabile: `idempotent-duplicate` a ogni giro. Correzione in `main`, test e build verdi,
> **aspetta il riavvio**: `pm2 restart agent41-realloc-scheduler`.
>
> **Stato reale verificato alle ~21:10 UTC**, e smentisce il banner qui sotto: il KILL è stato
> **revocato** alle 20:55:50Z (`data/safety-kill-switch.json` → `killed:false`,
> `clearedReason:"ripristino dal pannello operatore"`) e l'interruttore è su **AVVIA** dalle 20:56:04Z.
> *(La riga sull'arming che stava qui è decaduta il 9 agosto 2026: l'arming non esiste più — §5 punto 63.)*

> ## 🔴 KILL ATTIVO DALLE 17:20:17 UTC DELL'8 AGOSTO 2026 — CONTO PIATTO
> `data/safety-kill-switch.json` dice `killed:true`, `by:"operator · liquidity-rewards tab"`. Verificato
> sul venue alle 17:37: **zero posizioni aperte, zero ordini a riposo**, saldo pUSD **$668,25** —
> capitale interamente liquido, **utilizzo 0%**. `maker-bot-enabled.json` dice ancora `enabled:true`, ma
> il KILL vince su tutto e lo leggono tutti i percorsi, auto-close compreso.
>
> **Il lavoro del «capitale al lavoro» (8 agosto, sera) È NEI PROCESSI** dai tre riavvii eseguiti
> dall'operatore alle **18:30:52-18:31:16 UTC** (§5 punto 34): obiettivo di utilizzo 90%, mini-ciclo
> multi-mercato, ricalcolo leggero, sorveglianza dell'AVVIA e kill come cancello del trigger.
> **Nessun riavvio pendente.**

> ## 🟢 IL MERGE È VIVO NEL PROCESSO — E HA GIÀ COMPRATO IL SECONDO LATO
> `MERGE_STRATEGY_ENABLED = true` (costante di sorgente, **non** una env). Il riavvio che lo armava
> **è stato eseguito dall'operatore alle 16:49:18Z** (`agent40-manual-reprice`, restart 53 → 54, dopo
> il commit `f4bf022` delle 16:41): da lì l'eccezione di riduzione, i quattro fix del punto 27 e il
> ramo che **esegue** i Livelli 1-2 sono in servizio. Non resta nessun riavvio pendente.
>
> **Primo completamento di coppia mai piazzato da questo stack: 17:06:25Z.** Matt Little `0x822409`
> — BUY **NO 32,27 @ 0,19**, nozionale **$6,13**, ordine `0x83de2c71…`, `status: live`. È il Livello 2
> (l'ask di NO a 21¢ sta sopra il tetto di 19¢), e l'attesa di 60 minuti è su disco in
> `data/merge-attese.json`. **$6,13 di capitale nuovo impegnato**, che non torna liquido prima della
> risoluzione: senza merge on-chain la coppia paga $1 alla scadenza, non adesso.
>
> **La allowlist è tornata a 5 mercati** (§5 punto 31): i due con posizione aperta sono stati
> riabilitati alle 17:05:30Z. **Il prossimo reset di agent41 li rispegne** se non entrano nel piano.
>
> **Schwartzel `0xc16fade4` NON completa la coppia, e non per la allowlist** — §5 punto 32: la
> chiusura forzata a mercato (uscita a riposo da 24,5h) intercetta prima del ramo del merge, e fallisce
> sulla cancellazione perché `closeTask` **non inietta `cancelOrder`**. Il suo Livello 1 è calcolato e
> conveniente (coppia a **98,8¢**) e resta irraggiungibile.
>
> **Il Livello 1 (taker) comunque non può eseguire**: `manual-order` consente di attraversare lo
> spread **solo in vendita**. Degrada al Livello 2 nello stesso ciclo. §5 punto 29.

> ## ⚠ IL BOT È SU AVVIA DALLE 12:07:55 UTC DELL'8 AGOSTO 2026
> Non è più un'anteprima: **il prossimo ciclo di agent41 piazza ordini veri con capitale reale.**
> Rampa a `0/5` mercati nelle prime 24h, tetto 20% per mercato, guardiano attivo, kill spento.
> Il ciclo forzato dall'operatore è girato alle **13:01:33Z**: 3 mercati abilitati, **5 gambe piazzate**,
> 0 cancellazioni. Prossimo ciclo automatico **19:01:33Z**.
>
> **NESSUN RIAVVIO PENDENTE — eseguiti entrambi dall'operatore l'8 agosto.** `agent24-liquidity-rewards`
> alle **15:10:28Z** (restart 3 → 4) e `agent41-realloc-scheduler` alle **15:19:15Z** (34 → 35, con la
> ricostruzione dell'ambiente da `/proc`: 60 variabili prima, 60 dopo, tutte e nove le critiche presenti).
> Effetti misurati in §5 punti 21 e 23.
>
> **L'orizzonte non è più un cancello:** muro a 150 g in `horizon.js`, quota del 12% sulla coda oltre 7 g
> nell'allocatore (§4). Non serve riavviare — il piano nasce in un processo figlio a ogni ciclo.
>
> **Il rischio del 10 agosto è rientrato.** Con il muro a 150 g e il board nuovo il piano non esce più
> vuoto, quindi il reset del 10 agosto all'01:01Z non può più cancellare tutto senza ripiazzare.
> §5 punto 24 resta come registro di com'era.

> **Il codice della sera del 7 agosto è in `main` E nei processi vivi** (riavvii autorizzati alle
> ~23:52–23:57 UTC): fine scala su quattro percorsi, cadenza adattiva, pannello del mid vivo, timbro
> `origine` e ordini propri sottratti dalla coda sono **attivi**.
>
> **Anche il codice della mattina dell'8 agosto è in `main` E nei processi vivi.** agent41, agent40,
> agent34 e il `dashboard` sono stati riavviati alle ~07:21–07:22 UTC con l'autorizzazione esplicita
> dell'utente in chat: graduatoria della corsia calda con K/N rimisurati, punteggio di posizione nella
> selezione e confronto stima/consuntivo sono **attivi**. Vedi §5 punto 9 per la verifica.
>
> **Anche il codice della SERA dell'8 agosto è vivo — e quasi tutto senza riavvii.** Il tetto di
> credibilità della quota, la distinzione fra deserto misurato e buco e il tetto di categoria sui book
> vuoti sono **già in servizio**: entrambi i percorsi che calcolano un piano lo fanno in un processo
> node NUOVO che rilegge il codice da disco — `/api/rewards/allocate` per il pannello «Ottimizza» e
> `RUNNER_PIANO` per agent41 (`agents/agent41-realloc-scheduler.js:225`). Verificato eseguendo **quel
> comando esatto**: risponde `tettoCredibilita: true`. Vedi §5 punto 14.
>
> **E le due cose che aspettavano sono state fatte dall'operatore alle 09:15-09:16 UTC** (dal log del
> demone pm2, non dedotto): `agent42-guardian` eliminato e `agent43-guardian` avviato al suo posto
> (pm_id 44, script `agents/agent43-guardian.js`), e `agent40-manual-reprice` riavviato (51 → 52).
> Verificato: 89 e 95 variabili d'ambiente, **tutte e quattro le critiche presenti** in entrambi, e il
> guardiano legge il capitale — «PnL +8,47 USD · baseline $660,56 → $669,03». §5 punto 15 è chiuso.
>
> **Nuovo in flotta: `agent44-audit-scoperta`**, l'audit di sola scoperta. Non è sempre vivo: gira alle
> 03:07 UTC, scansiona, scrive la coda ed esce. Vedi §3 e §5 punto 16.
>
> **Il trigger a capitale fermo è vivo** dalle ~11:24 UTC (agent41 riavviato dall'operatore, restart
> 33 → 34; il log dice «trigger capitale fermo ACCESO — soglia $50, controllo ogni 120s»). §5 punto 17
> è chiuso.
>
> **Resta pendente UN riavvio, ed è quello che conta:** `agent40-manual-reprice` gira ancora col codice
> che lo teneva al **110% di un core**. La correzione è in `main` — vedi §5 punto 18 — e il comando è
> il più semplice possibile, `pm2 restart agent40-manual-reprice`, perché agent40 **ha** il proprio
> caricatore di `.env` (righe 56-62) a differenza di agent41.
>
> **A parte quello, sui riavvii non resta altro.** `REALLOC_SCHEDULER_DRY_RUN` è ancora nell'ambiente di
> agent41 e ci **resta per decisione dell'operatore** (8 agosto 2026): è inerte, e un `restart` non può
> toglierla in nessuna forma — vive nella descrizione in memoria di pm2, e `--update-env` fonde invece
> di sostituire. Il punto 3 di §5 è stato riscritto con la misura, con la tecnica giusta per riavviare
> agent41 senza perdere l'ambiente, e con l'avvertenza che il comando documentato prima ne avrebbe
> perse 63.

---

## 1 · STACK E INFRASTRUTTURA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità del venue. I reward si pagano sugli ordini **a riposo**, non sui fill —
per un maker l'esecuzione è il costo, non il ricavo.

| | |
|---|---|
| Runtime | Next.js 14.2 (App Router) · Node v20.20.2 · TypeScript |
| DB | Prisma 5 → **PostgreSQL** (`DATABASE_URL` in `.env`) |
| Processi | **pm2**, **40** processi definiti in `agents/ecosystem.config.js` (erano 42: `agent35-maker` e `agent37-maker-watchdog` sono stati rimossi il 9 agosto 2026 — §5 punto 63); **10 online** una volta eseguiti i due `pm2 delete` in attesa, uno (`agent44-audit-scoperta`) schedulato e a riposo, gli altri deliberatamente fermi (commit `47ff87e`: «riduzione all'insieme minimo») |
| Server | Hetzner Helsinki, Ubuntu, `62.238.52.227` (verificato) |
| Path | Repo in `/root/rewards-bot`. **`/root/prediction-market` è un symlink allo stesso path** ed è il `cwd` dichiarato in pm2: i due nomi sono la stessa directory |
| Repo | GitHub privato `git@github.com:gasparatodiego-blip/prediction-market.git`, branch `main` |

**Capitale reale connesso.** Funder on-chain `0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee` (è un
*contratto* deposit-wallet ERC-1271, `MAKER_SIGNATURE_TYPE=3`; l'EOA firma e non detiene nulla).
Alla verifica del 7 agosto 2026: **pUSD $590,26 + 1 posizione ~$70,30 ≈ $660 totali**.

Il numero invecchia: **non citarlo a memoria, rileggilo** (lettura on-chain, sola lettura):

```bash
node -e "
const fs=require('fs');
for(const l of fs.readFileSync('.env','utf8').split('\n')){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*\"?([^\"#]*?)\"?\s*\$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}
(async()=>{
  const {leggiSaldoUsd}=require('./lib/maker/saldo-cache');
  const {readVenuePositions}=require('./lib/safety/venue-positions-snapshot');
  const s=await leggiSaldoUsd(); const p=readVenuePositions();
  const v=(p&&p.positions||[]).reduce((a,x)=>a+(Number(x.size)*Number(x.curPrice)||0),0);
  console.log('saldo',s.usd,'affidabile',s.affidabile,'| posizioni',(p&&p.positions||[]).length,'valore',v.toFixed(2));
})();"
```

---

## 2 · REGOLE DI SICUREZZA FISSE

**Invariabili. Non si riscrivono senza istruzione esplicita dell'utente in chat.**

1. **Mai toccare lo schema Prisma né modificare il database di produzione.** Niente `migrate`,
   niente `db push`, niente `UPDATE`/`DELETE` su Postgres.
2. **Mai fermare o riavviare un processo pm2 senza conferma esplicita dell'utente in chat, ogni
   volta.** Un'autorizzazione vale **solo per quel riavvio specifico**: non si estende al successivo,
   né a un altro processo, né al giorno dopo. Vale per `restart`, `stop`, `delete`, `reload`.
   *(Questa regola sostituisce la precedente «restart senza go-ahead». La allowlist dei permessi
   decide cosa non apre un prompt tecnico; questo file decide cosa devo comunque chiedere.)*
3. **Mai piazzare ordini reali senza conferma esplicita dell'utente in chat.** Due sole eccezioni,
   e sono le uniche azioni su capitale reale che procedono in autonomia:
   - **(a) agent41** — riallocazione periodica, quando è fuori dry-run *e* il bot è su AVVIA;
   - **(b) agent43-guardian** — cancellazioni automatiche in caso di perdita oltre soglia.
4. **`npm run build` in autonomia; il restart no** (vedi regola 2).
5. **Ogni modifica di codice va deployata subito sul bot live** — build + attivazione — non solo
   committata. Il deploy che richiede un restart pm2 si chiede (regola 2) e si esegue subito dopo.
6. **Commit e push su `main` per ogni modifica significativa**, salvo istruzione contraria.
7. **Verifica sempre a fondo prima di dichiarare concluso un lavoro.** Non fermarsi alla prima
   lettura superficiale: leggere il codice che decide davvero, non il commento che lo descrive, e
   controllare lo stato runtime (`pm2 env`, i file in `data/`) e non solo la configurazione.

### I due interruttori, e chi decide cosa

Erano tre. **ARM / DISARM è stato rimosso il 9 agosto 2026** (§5 punto 63) insieme al motore che lo
consultava: era un'autorizzazione di sessione con TTL e cap di collaterale, e l'unico processo che la
leggeva era `agent35-maker`. Restano i due che decidono davvero.

| Interruttore | File / flag | Semantica |
|---|---|---|
| **AVVIA / FERMA** | `data/maker-bot-enabled.json` via `lib/maker/bot-enabled.js`, bottone in cima alla tab **Mercati ottimizzati** | Decide se il bot apre posizioni da solo. `agent41` lo rilegge **a ogni ciclo**: FERMA vale dal ciclo dopo, senza restart. File mancante/illeggibile/malformato ⇒ **fermo**. Ferma i piazzamenti *nuovi*, lascia gestite le posizioni aperte (auto-close, riprezzatura, rinnovi). |
| **KILL** | `data/safety-kill-switch.json`, `lib/safety/kill-switch`, `/api/maker/kill` | Emergenza assoluta. Lo leggono tutti i percorsi **compreso `auto-close`**: killare lascia le posizioni aperte *senza uscita*. Non è l'interruttore operativo. **Invariato dalla rimozione dell'arming**: la rotta faceva due cose e ora ne fa due — interruttore durevole + spazzata di cancellazione — perché il ritiro dell'arming era un parametro **opzionale**. |

`REALLOC_SCHEDULER_DRY_RUN` **è stato rimosso** il 7 agosto 2026 da `ecosystem.config.js` e da ogni
riga di `agent41`. Non reintrodurlo e non aggiungere un env di fallback accanto ad AVVIA/FERMA: due
interruttori per una decisione sola significano che spegnerne uno non la spegne. Un test
(`lib/maker/gestione-manuale-nel-flusso.test.js`) fallisce se ricompare.
`REALLOC_SCHEDULER_ENABLED` **non** è un secondo interruttore: decide se il processo fa qualcosa,
non se può piazzare.

### Permessi della sessione (stato al 7 agosto 2026, ~23:05 UTC)

`.claude/settings.json` (progetto) e `~/.claude/settings.json` (utente) portano una **copia identica**
della stessa policy: `allow` ampio + **164 regole `ask`**. `ask` batte `allow` da qualunque file arrivi,
e le regole si **fondono** fra i file. `.claude/settings.local.json` deve restare privo di regole `ask`.
Le due copie vanno tenute in sync: se ne modifichi una, modifica l'altra — e
`lib/safety/policy-permessi.test.js` fallisce se divergono.

> **NOTA DEL 9 AGOSTO 2026 — la policy NON è stata toccata dalla rimozione dell'arming.** Le regole che
> nominano `agent35-maker`, `/api/maker/{arm,disarm}` e `maker-arming` sono rimaste tutte al loro posto,
> e da oggi non possono più corrispondere a niente. Sono state lasciate **di proposito**: toglierle è
> l'unica operazione di questa pulizia che *allenta* un presidio, e §2 regola 2 dice che §2 non si
> riscrive senza istruzione esplicita. Restano anche i segnali dell'hook e `policy-permessi.test.js`
> (che le conta): il test è verde, e il costo di tenerle è zero prompt in più su comandi che non esistono.

Le regole `ask` si dividono in **tre famiglie, con criteri diversi**, e la differenza è voluta:

1. **Capitale reale — `ask` anche in lettura.** Ordini manuali (`/api/maker/manual/*`), script di
   piazzamento, `node agent40-manual-reprice` (e `agent35-maker`, che non esiste più), armamento
   (`/api/maker/{arm,disarm}`, rimosso) e gli env che abilitano il piazzamento (`MAKER_PLACEMENT`,
   `MANUAL_ORDER_PLACEMENT`, `MAKER_MODE=live|on`, `MAKER_FUNDING_APPROVED`). Qui basta *nominare* la
   cosa per far scattare il prompt: massima cautela, anche a costo di chiedere su un `grep`.
   **Questa famiglia non si allarga.**
2. **pm2 — `ask` anche solo se nominato** (dal 7 agosto 2026): `restart`, `stop`, `delete`, `reload`,
   `kill`, `startOrRestart`. Prima non c'era **nessuna** regola su pm2: la regola 2 di §2 viveva solo
   in questo file, e un riavvio poteva partire muto. `pm2 list/describe/env/logs` passano.
3. **Flag di stato/sicurezza — `ask` solo in scrittura** (dal 7 agosto 2026). AVVIA/FERMA
   (`bot-enabled`, `impostaBot`, `api/maker/bot`), KILL (`safety-kill`, `kill-maker`,
   `/api/maker/kill`), il guardiano delle perdite (`guardian-baseline`, `guardian-state`), la gestione
   manuale per mercato (`maker-manual-mode`) e il file di armamento (`maker-arming`, oggi inesistente)
   non hanno una regola-ombrello sul nome. Al suo posto c'è, per **ognuno** di questi sei flag, la stessa famiglia di
   **19 forme di scrittura**: redirezione (`*> *T*` e `*>*T*.json`), `tee`, `sed`, `rm`, `mv`, `cp`,
   `touch`, `truncate`, `dd of=`, esecuzione via `node`/`python`/`perl`/`bash`/`sh -c`/`./`, e
   `git checkout` / `git restore` / `git reset` (che possono rimettere indietro il flag); più
   `curl`/`wget` sulle route e la regola `Edit(...)` sul file. La lettura — `cat`, `grep`, `ls`,
   `find`, `wc`, `head`, `git log`, `git diff`, `git check-ignore` — passa in autonomia.
   Motivo: la regola-ombrello interrompeva l'auto mode su ispezioni che non cambiano nulla.

Due dettagli di forma che contano, e sono verificati dal test:
- la redirezione è `*> *T*` **con lo spazio** più `*>*T*.json` **ancorato in fondo**, non `*>*T*`:
  quest'ultima scattava su letture come `ls data/*.json 2>/dev/null | grep bot-enabled`, dove il `>`
  è quello di `/dev/null`;
- **eseguire** un file che nomina il flag chiede *anche quando è il suo stesso test*
  (`node lib/maker/bot-enabled.test.js`). Non è una lettura, ed è la parte prudente: il 7 agosto 2026
  una versione del test del guardiano ha lasciato residui sullo stato **vero** (§5 punto 1).

### L'hook che guarda dentro gli script (dal 7 agosto 2026)

> **Un riavvio pm2 non passa da qui.** I segnali sugli agent chiedono una *forma di esecuzione*
> (`node`, `bash`, `sh`, `npx`, `./`) davanti al nome: `node agents/agent35-maker.js` è bloccato,
> `pm2 restart agent35-maker` no. Non è un allentamento — pm2 ha già il presidio migliore, cioè le
> regole `ask` che fermano il comando e lo mettono davanti a te. Un `deny` non lascerebbe quella
> possibilità, e l'unico modo di procedere diventerebbe aggirare l'hook.

`.claude/hooks/blocca-piazzamento.js`, registrato in entrambe le copie di `settings.json` sotto
`PreToolUse` / matcher `Bash`, timeout 15s. Chiude il limite che le regole `ask` dichiarano da sempre:
`node /tmp/x.js`, dove `x.js` importa la funzione che piazza, non nomina niente e nessuna regola lo vede.
L'hook **apre il file e cammina il grafo dei `require`** fino a profondità 3 cercando la superficie di
piazzamento vera (la POST /order dell'adapter, `placeManualOrder`, `replaceManualOrder`,
`runBulkAllocation`, `createOrder`, la firma EIP-712, le tre rotte manuali, gli agent che piazzano, gli
env che armano). **Cancellare non è in elenco**: può solo ridurre l'esposizione, e il guardiano deve
poterlo fare.

Tre esenzioni, tutte dichiarate e tutte trovate dai test facendo fallire l'hook su se stesso:
- le **letture** si valutano per prime e **segmento per segmento** (`cat x | curl -X POST …/order` non è
  una lettura solo perché comincia con `cat`);
- i file **`*.test.js`** del repo sono esenti dall'analisi del *contenuto* — è il loro mestiere nominare
  quelle funzioni per provare che rifiutano — ma non da quella del comando che li lancia;
- il **corpo di un heredoc** è un dato, non una riga di comando: un messaggio di commit che *spiega* il
  piazzamento non è un piazzamento. Se però l'heredoc va in pasto a `node`, torna a contare.
- i separatori **dentro le virgolette** non separano (`grep -rn "a\|b"` è un comando solo).

**Limite dichiarato della famiglia 3:** la copertura è per *forme note* di scrittura, non per
costruzione. `install`, `sponge`, `awk` con redirezione indiretta, `git reset --hard` che non nomina il
path, o una redirezione senza spazio seguita da altro (`printf x >data/f.json && ls`) non incontrano
nessun `ask`. Il presidio vero resta la **regola 3 di §2**: sul capitale e sugli interruttori si chiede
in chat, la policy dei permessi è la seconda linea, non l'unica. Se aggiungi un flag di stato nuovo,
aggiungi le 19 forme di scrittura — non un pattern sul solo nome — e mettilo nell'elenco `FLAG` di
`lib/safety/policy-permessi.test.js`, che conta la famiglia completa flag per flag.

Le sessioni si aprono da `/root/rewards-bot` (il file di progetto si carica solo se quella è la cwd):

```bash
cd /root/rewards-bot && claude --permission-mode auto
```

### Guardrail auto-resume

Se il turno corrente è stato aperto da un risveglio automatico (ScheduleWakeup o simile) e **non** da
un messaggio umano: build, test, edit, commit locali restano autorizzati; **`git push` e qualunque
deploy o restart pm2 no**, anche se il prompt che ha programmato il risveglio diceva «senza gate».
Si completa tutto il resto, si dice cosa è pronto, e si aspetta il messaggio umano successivo.

---

## 3 · AGENTI CHIAVE

**Online al 7 agosto 2026** (`pm2 list` — verificato, non assunto), **meno i due rimossi il 9 agosto
2026**: `agent35-maker` (il motore automatico) e `agent37-maker-watchdog` (il suo dead-man) non sono
più nel repo né in `ecosystem.config.js`. Finché non vengono eseguiti i due `pm2 delete` in attesa
(§5 punto 63) i processi restano vivi in memoria con il codice vecchio, e `pm2 list` li mostra ancora.

| pm2 | Cosa fa | File |
|---|---|---|
| `agent34-clob-ws` | Feed **websocket** dei book CLOB Polymarket. Sola lettura, canale pubblico e senza chiavi: non può firmare, piazzare o cancellare nulla. Alimenta tape e mid-history. | `agents/agent34-clob-ws.js` |
| `agent38-tape-watchdog` | Watchdog di **continuità** dei giornali (trade tape + mid-history): copre il buco che l'auto-heal del socket di agent34 non vede. | `agents/agent38-tape-watchdog.js` |
| `agent40-manual-reprice` | **Riprezzatura / uscita dalla banda** per gli ordini piazzati a mano: l'asse giusto non è la scadenza a 180 s ma «l'ordine è ancora dentro la banda che paga?». Scrive lo snapshot posizioni. | `agents/agent40-manual-reprice.js` |
| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h) + **trigger a capitale fermo** (ogni 2 min, dall'8 agosto 2026). Il ciclo fisso ha due trigger indipendenti: *validità* e *valore*. Il trigger event-driven ne ha uno solo: c'è collaterale libero sopra **$50**. **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore (3 agosto 2026). | `agents/agent41-realloc-scheduler.js` |
| `agent42-watch-makers` | Monitor dei **21 maker di riferimento**: ingressi, convergenze, ritiri pre-risoluzione. L'unico processo della flotta che **non può toccare capitale nemmeno in linea di principio** (nessun import da `lib/maker/`, nessuna credenziale). | `agents/agent42-watch-makers.js` |
| `agent24-liquidity-rewards` | Scanner dei mercati con reward: ogni 15 min legge Gamma + book e assegna il punteggio con la formula quadratica esatta del venue. | `agents/agent24-liquidity-rewards.js` |
| `agent27-news-guard` | Guardia notizie/volatilità: segnala che il prezzo sta per muoversi, così le quote si ritirano prima del fill avverso. | `agents/agent27-news-guard.js` |
| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. In servizio dalle 21:27:31 del 7 agosto 2026 (allora col nome `agent42-guardian`), baseline **$660,56**, nessuno scatto. **Rinominato l'8 agosto 2026: il processo pm2 vivo porta ancora il nome vecchio finché non lo si ricrea — §5 punto 15.** | `agents/agent43-guardian.js` |
| `agent-monitor` | Sorveglia la flotta via heartbeat e riavvia gli agenti fermi, con circuit breaker per agente. | `agents/agent-monitor.js` |
| `dashboard` | Il Next.js che serve pannello e `/api/*` sulla porta 3000. Il **pannello ordini manuali gira dentro questo processo**. | `npm start -- --port 3000` |

**Non sempre vivo, e apposta — `agent44-audit-scoperta`** (8 agosto 2026). L'**audit di scoperta**:
legge il codice del bot, cerca i pattern di rischio che in questo progetto hanno già prodotto guasti
veri, scrive la coda ed **esce**. Non corregge niente, non tocca ordini né capitale, non scrive nessun
file che non sia la propria coda — provato da un test che cammina il suo albero dei `require`.

| | |
|---|---|
| **quando** | `cron_restart: '7 3 * * *'` + `autorestart: false`. Fra una scansione e l'altra sta in `waiting restart` con **CPU 0% e RAM 0 MB**: costa zero. Le 03 UTC perché `sar` su nove giorni dà 02-04 come le ore più quiete (28,5-29,2% contro il 40,7% delle 08) ed è l'unica **dopo** la riconciliazione notturna di agent40, quindi legge il confronto della notte appena chiusa. Il minuto 7 per non accodarsi ai cron di sistema. |
| **quanto costa** | misurato: **63-68 s**, **99-107 MB** di picco, 889 file letti, 126 test eseguiti. Gira a **nice 19** e **ionice classe idle** (se li applica da sé sul proprio pid: pm2 non permette di anteporre `nice`), con deadline 12 min e un vigile interno che si ferma da solo oltre 150 MB. |
| **cosa cerca** | sette rilevatori, ognuno nato da un guasto vero: costanti dello stesso concetto con valori diversi · protezioni presenti su un percorso e assenti su un altro · la stima che diverge dal consuntivo · flag che nessuno legge più · test rossi (nuovi vs già noti) · collisioni di numerazione · **commenti fermi a un valore che non è più quello**. |
| **il report** | `data/audit-coda.json` (la memoria) e `data/audit-coda.md` (la vista). **Come si guarda:** `node scripts/vedi-audit.js` — oppure `--tutti` per i risolti, `--storia` per l'andamento, o semplicemente `cat data/audit-coda.md`. |
| **la memoria** | niente sparisce: un reperto che non si ritrova diventa **risolto** con la data, uno che torna è **riaperto**, e `primaVisto` non viene mai sovrascritto — «aperto da nove giorni» resta distinguibile da «aperto da stanotte». |
| **file** | `agents/agent44-audit-scoperta.js` · `lib/audit/{rilevatori,coda}.js` · `scripts/vedi-audit.js` |

**La scheda del guardiano:**

| | |
|---|---|
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il baseline in `data/guardian-baseline.json`; oltre `GUARDIAN_LOSS_PCT` (default 5%) o `GUARDIAN_LOSS_ABS` (default $30) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

Distinzione che era da tenere ferma, e che il 9 agosto 2026 ha perso una delle due metà: **agent37
guardava i processi, agent43-guardian guarda il capitale** — due guasti indipendenti (un motore può
battere regolare e perdere soldi), quindi due processi. Con la rimozione di agent37 **resta solo il
secondo**, e va detto per intero: **oggi nessun processo sorveglia il battito di agent40**. Se agent40
si blocca con ordini a riposo, ciò che li toglie è la scadenza **GTD nativa** del venue
(`lib/maker/order-ttl.js`) e, per la parte economica, agent43-guardian se la perdita supera la soglia.
Era la copertura dichiarata anche prima per la morte dell'host; da oggi vale anche per la morte del
solo processo. **È una conseguenza voluta della rimozione, non un difetto scoperto dopo** (§5 punto 63).

**Fuori da pm2, a richiesta — il monitor delle «Reti dei 21»** (7 agosto 2026). Non è un agent e non va
messo in pm2: si lancia in un terminale dedicato quando serve guardare.

```bash
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js            # una fotografia
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --watch    # rilegge ogni 60s
cd /root/rewards-bot && node scripts/monitor-reti-dei-21.js --json     # una riga JSON
```

Confronta il board reward corrente con il **Setting Consensus** misurato sui 21 wallet vincenti
(`data/manuale-operativo-maker-v2.md`): scadenza mediana 0,44 g (Q1–Q3 0,18–0,80), nozionale ~$34
($16–74), size 77 share, un tick dal mid, chiusura via redeem (94%). **Non filtra sul montepremi** —
il campione dice che la banda non è un criterio — e un mercato con scadenza non leggibile **non** entra
fra i coerenti. Sola lettura dimostrata: un test cammina l'albero dei `require` (5 file raggiungibili,
nessuna superficie di piazzamento o cancellazione). Prima lettura reale: 314 mercati, **1** coerente.

---

## 4 · STATO ATTUALE DEL SISTEMA

Tutto ciò che segue è stato letto dal codice/config/stato reali il 7 agosto 2026.

**Motore di piazzamento — unificato.** `lib/maker/motore-unico.js` ha sostituito i due profili
Safe/Risk il 6 agosto 2026: niente più due pavimenti, due finestre di volatilità, due tetti. La
formula del venue (`lib/rewardScore.js`) è una curva continua e non conosce «safe» o «rischioso»;
i due bucket ci mettevano sopra una scalinata che il venue non paga. Nessun `if (profilo)` nel repo.

**Le cinque regole vive, nell'ordine in cui si applicano** (`motore-unico.js`):

1. **Mai primo sul book** — vincolo assoluto, slegato dal punteggio. Se «un tick dietro il migliore»
   e «dentro la banda» si contraddicono, **vince la banda**: ci si ferma al suo bordo e il verdetto
   porta `onTop:true` perché il caso sia visibile. `top-of-book.js` sottrae i nostri ordini dal book,
   altrimenti il motore inseguirebbe se stesso fino al bordo della banda.
2. **Depth floor adattivo** — `DEPTH_FLOOR_PCT_OF_AVG = 0.10`, cioè il **10% della liquidità altrui
   media in banda di quel mercato specifico**, non un dollaro fisso. Fallback `$15` per i mercati
   senza storico.
3. **Poi ci si ferma** — conseguenza del quadratico: soddisfatte 1 e 2 il livello trovato è già
   quello col punteggio più alto. Non esiste più un controllo separato di volatilità o spread.
4. **Lato singolo deciso dalla formula, non da un timer** — dentro `[0.10, 0.90]` un lato solo matura
   comunque un terzo e si tiene; fuori da quel range matura **zero** e si cancella subito. Il mid si
   rilegge a ogni ciclo. (Ha sostituito la tolleranza a 10 minuti del 6 agosto.)
5. **Tetto di capitale per mercato — $130 FISSI dal 9 agosto 2026** (`lib/rewards/concentration.js`,
   `MARKET_CAP_FIXED_USD = 130`). È gestione del rischio di risoluzione, deliberatamente fuori dal
   calcolo del punteggio, e si applica al **mercato intero: YES+NO sommati**, quindi vale ~$65 per lato
   (`allocate.perMarketNetAtSize` restituisce `capital: 2 * sizeUsd` — misurato, non assunto).
   **Era una PERCENTUALE (20% del capitale) fino al 9 agosto.** Cresceva in dollari col saldo: su $670
   valeva $134, su $2.000 sarebbe valso $400, cioè dodici volte il nozionale mediano dei 21 maker
   (~$34). La decisione dell'operatore è l'opposto — **quando il capitale cresce si spalma su PIÙ
   mercati, non si ingrossa la size su ciascuno** — ed è la stessa filosofia del resto del sistema.
   Con un tetto fisso il **numero di mercati è una conseguenza** (`capitale ÷ 130`), non un parametro.
   **UN NUMERO SOLO, IMPORTATO DA QUATTRO CONSUMATORI**, ed è la parte che conta perché il rischio è
   che divergano: (1) il pianificatore/knapsack via `realloc-cycle` e agent41, (2) il **motore di
   piazzamento** — `motore-unico.tettoMercato`, Regola 5, che prima aveva la sua costante
   `MARKET_CAP_PCT`, (3) `decideRimpiazzo`, che legge il tetto per mercato da
   `data/maker-allocated-capital.json` scritto da agent41 e quindi lo segue da sé, (4) il punteggio di
   rischio (`rischio-beneficio.js`), la cui normalizzazione è ancorata al tetto. `netto-centralizzato.test.js`
   verifica che tutti e quattro lo **importino** invece di ridichiararlo.
   **Il clamp**: `capPerMarketUsd` si abbassa al capitale quando questo è più piccolo del tetto — può
   solo stringere — e **non restituisce mai `null`**, perché a valle `null` varrebbe «nessun tetto»
   (era un fail-**open** della versione a percentuale).
   **Effetto misurato il 9 agosto**: sul capitale di oggi il piano è identico a quello col tetto
   percentuale ($588,00 allocati, 99,0% di copertura); a $1.000 usa **9 mercati** invece di 6; a $2.000
   si ferma all'88% perché il pool qualificato si esaurisce, non per il tetto.

**L'orizzonte: un MURO e una QUOTA, e fanno due lavori diversi** (8 agosto 2026 sera — in `main`; il
piano nasce in un processo figlio a ogni ciclo, quindi **non serve riavviare**). Per mezza giornata il
tetto è stato un cancello secco a 1,5 g: giusto come direzione, sbagliato come forma. I **307 ingressi
veri** dei 21 maker dicono mediana 0,212 g · Q3 0,504 · **P90 7,00** · max **145,7**, cioè il **10,4%
(32 su 307) va oltre i 7 giorni** — un comportamento che i vincitori hanno davvero, e che un cancello
cancellava invece di rappresentare. Adesso:
- **Il muro**, in `lib/rewards/horizon.js`: `MAX_HORIZON_DAYS = 150`, sopra il massimo mai osservato.
  Oltre, `too-far`, senza appello. Tutto ciò che sta sotto torna **ammissibile**.
- **La quota**, in `lib/rewards/allocator.js`: il capitale oltre `LONG_TAIL_DAYS = 7` (il P90) non può
  superare **`LONG_TAIL_CAP_FRAC = 0,12`** del piano. 12% e non il 10,4% misurato perché un tetto messo
  sulla stima puntuale boccia una composizione che finisce al 10,5% per rumore campionario.
- **La divisione non è organizzativa, è logica**: «questo mercato è ammissibile?» è una proprietà del
  mercato e si risponde in `horizonVerdict`; «quanto del capitale può starci?» è una proprietà del
  **portafoglio**, e un verdetto per-mercato non ha modo di conoscerla.
- **DUE PASSATE, non una potatura.** Il primo tentativo lasciava scegliere il knapsack, guardava se la
  coda sforava e potava rigirando il DP: **non converge**, misurato sull'universo vero — tolti due
  mercati lunghi il DP ne pesca altri due, e dopo tre giri la composizione era ancora al **26,5%**
  contro il 12%. Ora la fascia corta gira per prima con **tutto** il budget (quindi la sua allocazione
  è, per costruzione, quella di prima), e la coda riceve solo `S·q/(1−q)` — non `S·q`, che sbaglierebbe
  in difetto, perché la quota è sul totale e il totale contiene la coda.
- **Fascia corta vuota ⇒ la coda non ottiene niente.** Severo e voluto: «al più il 12% del piano» su un
  piano di sola coda vale 100%. Fallisce nella direzione sicura e il piano lo dichiara
  (`codaLungaBudgetUsd`, `codaLungaFrazione`, `codaLungaOltreLaQuota`).
- **Misurato sull'universo vero l'8 agosto**: piano a **90,0% fascia corta / 10,0% coda lunga**, budget
  concesso $63,82, usato $52 — sotto quota senza che la quota abbia dovuto mordere; 4 mercati lunghi
  restano fuori con motivo `quota-coda-lunga`, che è distinto da un rifiuto per orizzonte.

**~~L'orizzonte ha DUE estremi: `[0,25 · 1,5]` giorni~~** *(il pavimento è 0,75 g dall'8 agosto sera — §5 punto 38 fase 1)* (superato dal blocco qui sopra) (`lib/rewards/horizon.js`, 8 agosto
2026 sera — in `main`; il pianificatore nasce in un processo figlio a ogni ciclo, quindi **non serve
riavviare niente**). Il pavimento c'era dal principio; il tetto no, e la sua assenza non era benigna:
il knapsack massimizza un **tasso al giorno**, e un tasso al giorno non contiene la durata. Un mercato
che rende $3/g per due giorni e uno che rende $3/g per centoquarantaquattro avevano lo stesso identico
punteggio. Misurato: il piano in produzione aveva mediana **144,4 g** contro lo **0,44** dei 21 maker
di riferimento — **328 volte** — mentre il manuale v1 si era già dato «< 24 ore» come obiettivo.
- **1,5 giorni**, e il numero viene dai fill: i **299 ingressi veri** che `agent42-watch-makers` ha
  osservato sui 21 wallet (`data/maker-21-eventi.jsonl`) danno mediana **0,221 g**, Q1 0,046, Q3 0,504.
  Copertura per tetto: 1,0 → 78,9% · **1,5 → 81,6%** · 2,0 → 83,6% · 3,0 → 84,9% · 5,0 → 84,9%. Il
  ginocchio è a 1,5: oltre si comprano 3,3 punti triplicando l'orizzonte ammesso.
- **Quinto verdetto, `too-far`**, deciso PRIMA del payback e indipendente da quanto il mercato renda:
  è un fatto di calendario. Entra in `horizonRejects` (`allocator.js`) accanto a `resolved` e `short` —
  **un solo punto di applicazione**, quindi ogni percorso che consulta `horizonVerdict` lo eredita.
- Confine **inclusivo da entrambi i lati**: `days === MIN` passa e `days === MAX` passa. La finestra si
  legge come `[MIN, MAX]` e non c'è un'estremità che si comporta diversamente dall'altra.
- Si cambia con `MAKER_MAX_HORIZON_DAYS`; un valore illeggibile o ≤ MIN **viene scartato in favore del
  difetto** (stessa regola di fine scala: un `.env` sbagliato non spegne una protezione). Nota
  operativa: agent41 non carica `.env`, quindi per cambiarlo davvero sul bot serve metterlo
  nell'ambiente pm2, non solo nel file.
- `MIN_HORIZON_DAYS` **non è stato toccato**: resta 0,25.

**Fine scala — la regola sta su tutti e quattro i percorsi** (dal 7 agosto 2026). Sotto i 3¢ o sopra i
97¢ un mercato non fa più mercato: sta risolvendo, e un ordine a riposo lì è una scommessa asimmetrica.
`lib/maker/end-of-scale.js` resta l'unica definizione, ma ora la chiamano **quattro** moduli e non due:
`auto-reprice` (agent40), `mm-tracking`, la rotaia `end-of-scale` di `risk-rails` (che copriva
**agent35**, azione `halt-market`; il motore è stato rimosso il 9 agosto 2026 e la rotaia resta nel
modulo) e il gate 2-ter di `placeManualOrder` (che copre pannello manuale, `bulk-allocate`
e quindi **agent41**). Le soglie si rileggono da `.env` a ogni chiamata — `MID_EXTREME_LOW=0.03`,
`MID_EXTREME_HIGH=0.97`, in prezzo e non in centesimi — e un valore che non si capisce viene **scartato**
in favore del difetto: un `.env` sbagliato non può spegnere la protezione.

**Cadenza di reprice adattiva per mercato** (`lib/maker/cadenza-adattiva.js`, 7 agosto 2026). I due cicli
di agent40 non guardano più ogni mercato con lo stesso orologio: l'escursione del mid su 15 minuti
(`velocita-mercato.leggiFinestraMercato`, la stessa misura del filtro «⚡ Veloci») si traduce in tick/ora
e da lì in tre classi — veloce 1s, media = cadenza di prima, lenta 10s. Misurato sul giornale vero: 162
mercati → 102 lenti, 49 non misurabili, 6 medi, 5 veloci; chiamate al venue **−37,9%**. Non abbassa
nessuna soglia: `minMoveCents` e `hysteresisTicks` restano dov'erano, e guardare più spesso non riprezza
di più. Misura assente ⇒ cadenza di difetto, cioè il comportamento di prima.

**Il giornale si legge una volta per ciclo, e solo per la finestra chiesta** (`velocita-mercato.js`,
8 agosto 2026 — in servizio dal riavvio delle 12:07:06Z, §5 punto 18). La cadenza adattiva qui sopra
aveva un costo che nessuno aveva misurato: `leggiFinestraMercato` veniva chiamata **una volta per
mercato per ciclo**, e ogni chiamata rileggeva il giornale del giorno **dall'inizio** — perché il seek
era `size − TETTO_BYTE` (128 MB, tarato su una finestra da sei ore) invece che sulla finestra da 15
minuti effettivamente richiesta. Con il giornale a 77 MB: 524 ms a chiamata, 61.746 righe parsate per
estrarne 12, ×13 mercati = **6,8 s di CPU dentro un ciclo da 5 s**, in crescita durante la giornata e
con azzeramento a mezzanotte. Ora: **una** lettura per ciclo (`leggiFinestraTutti`, di cui la variante
per un mercato solo è una proiezione) e un budget di byte dimensionato sulla finestra, con un controllo
di copertura che allarga e rilegge se la stima del tasso non basta — così la finestra non può
accorciarsi in silenzio. **6.812 ms → 29-36 ms per ciclo**, risultato identico (firma SHA-256 uguale su
169 righe). Il test `lib/rewards/una-lettura-per-ciclo.test.js` conta le aperture del file, non i
millisecondi: è un difetto che nessun test funzionale vede, perché il risultato era già corretto.

**Origine degli ordini — una mano o un ciclo** (`lib/maker/origine-ordine.js`, 7 agosto 2026). Campo
`origine` **accanto** a `source`, non al posto suo: `source` dice quale corsia piazza (ed è quello che
agent40 legge — fino al 9 agosto 2026 anche agent35), `origine` dice se dietro c'era una persona. Serve perché `bulk-allocate` timbra
`manual-ui` sia per il bottone del pannello sia per agent41. Il reset di agent41 ora cancella **solo** ciò
che è provatamente `auto`: manuale e **ignoto** restano sul libro, e gli ordini piazzati prima di questa
modifica sono ignoti per costruzione. Il pannello non cambia: la mano `leggiOrigini` è iniettata solo da
agent41.

**La SELEZIONE sente il tick vero** (`usePlacementScore`, 8 agosto 2026 — in `main` e in servizio: il
piano si calcola sempre in un processo figlio, vedi §5 punto 14). Il 5 agosto `offsetTicks` aveva corretto *dove* il motore si mette (un tick dal
concorrente); restava scoperto *quanto vale starci*. Il lordo dell'obiettivo del knapsack è il ceiling
a **S=1** — un ordine appoggiato sul mid — e non contiene nessun termine di offset: in selezione ogni
mercato era pesato uguale, cioè l'equivalente esatto di una distanza fissa per tutti. Il venue paga
`S(v,s)=((v−s)/v)²`, e su banda 4,5¢ **un tick vale 0,309 su tick 0,01 e 0,913 su tick 0,001 — 2,96
volte**; 48 dei 113 mercati valutabili sono a tick fine. Ora l'obiettivo pesa il lordo col punteggio
alla distanza reale (`placementWeightForMarket`, in `scripts/rewards-replay/lib/allocate.js`; il tick
viene da `marketTick`, la stessa fonte del piazzamento; `placementScore` è importata, non riscritta).
- **Acceso solo nel pianificatore**: `allocateBudget` lo lascia spento, quindi i backtest sono
  invariati numero per numero.
- **Non tocca l'esecuzione**: `grossPerDay` e `netPerDay5m` restano il ceiling e il netto misurato —
  `computedDefaultOffset` e `realisticEstimate` pesano già il punteggio per conto loro. Misurato: zero
  offset di piazzamento cambiati.
- **Effetto misurato** ($660, 8 agosto mattina): un mercato a tick grosso esce, nessuno entra, e il
  capitale si sposta di **+$91 verso i tick fini** (−$39 e −$52 dai grossi).
- Banda o tick illeggibili ⇒ nessun peso, e il mercato finisce in `pesoNonApplicato` che viaggia col
  piano. Sull'universo reale l'elenco è vuoto: tutti i mercati con montepremi pubblicano la banda.
- **Corretto la sera dell'8 agosto: il fattore NON è `S`.** L'obiettivo faceva `lordo × S`, cioè
  `pot·shareCeiling·S`, mentre la quota vera di un ordine a S<1 è `pot·S·size/(S·size + cQ)` — sempre
  più grande, perché S sta *anche al denominatore*. Penalizzava troppo, e di più proprio i tick grossi
  (S piccolo), cioè gonfiava il vantaggio del tick fine. Ora usa `placementShareFactor`, la stessa
  algebra esatta della stima realistica: il vantaggio del tick fine sul fixture di prova vale **2,79×**
  invece di 2,96×, ed è quello vero.

**E la selezione sente anche quanto di quella quota è credibile** (`useCredibleShareCap`, 8 agosto
2026 sera — in `main` e **già in servizio**: il piano si calcola sempre in un processo figlio, vedi §5
punto 14). `share = size/(size+cQ)` tende a **1** quando la concorrenza in banda tende a 0, e il knapsack *massimizza*: un book vuoto gli sembrava
l'occasione migliore che esista. La correzione **thin-book** della stima realistica lo tagliava già a
`maxCredibleShare = 0,60`, ma **solo dopo** che la scelta era stata fatta — il knapsack sceglieva su
un'informazione più ottimistica di quella con cui il piano veniva poi giudicato.
- **Una fonte sola.** `ceilingShare`, `placementShareFactor` e `credibleShareFactor` sono state
  **estratte** da `lib/rewards/realistic-estimate.js` e sono chiamate da entrambe le parti — la stima
  realistica continua a usarle, l'obiettivo del knapsack le riusa. L'estrazione è stata **provata
  neutra**: firma SHA-256 identica su 4.320 combinazioni di ingressi, prima e dopo.
- **Il taglio si applica per LIVELLO della curva**, non per mercato: aggiungere capitale a un mercato
  sottile smette di aiutare oltre il tetto. È la concavità che alla selezione mancava.
- **Le due correzioni non si sovrappongono**, ed è algebra: la posizione agisce sul *numeratore* della
  quota (`S·size` invece di `size`), il tetto sul suo *valore massimo*. Un test lo verifica livello per
  livello — `lordo pesato = lordo × fattorePosizione × fattoreCredibilità`, senza termini in più.
- **Nessuna sovra-penalizzazione dei book normali**: sotto la soglia il fattore è **esattamente 1**,
  non «quasi 1». Sul piano reale i mercati capati sono **3-5 su ~110 valutati**.
- **L'effetto che si cercava: obiettivo e stima realistica convergono.** Misurato su due finestre con
  la stessa metrica (l'obiettivo letto dalle righe, cioè quello che quel knapsack ha massimizzato):

  | finestra | divario obiettivo↔realistico | | | obiettivo B→C |
  |---|---|---|---|---|
  | | A · ceiling | B · +posizione | **C · +tetto** | |
  | 2026-08-07 20:14 UTC | −62,8% | −51,0% | **−31,2%** | $50,94 → $36,31/g (−28,7%) |
  | 2026-08-08 02:15 UTC | −96,6% | −94,7% | **−90,9%** | $75,26 → $48,76/g (−35,2%) |

  Il divario si stringe in entrambe, e si stringe perché **cade l'ottimismo dell'obiettivo**, non
  perché peggiori la stima.
- **E la lista dei mercati cambia dove doveva.** Alla finestra delle 02:15 esce dal piano
  `0xfad21673` — «Will Trump meet with Changpeng Zhao in 2026?», **quota 100%, capata**, $52 di
  capitale, e con la stima realistica che **si rifiutava di stimarlo** (regola `empty-book`). I suoi
  $52 vanno su mercati con book vero: **realistico $4,00 → $4,45/g (+11,3%)**. Su sei finestre
  campionate la stima realistica del piano non peggiora **mai**.
- **Non tocca l'esecuzione**: zero offset di piazzamento cambiati, e un test verifica che nessun modulo
  di `lib/maker/` nomini il tetto (158 file controllati).

**IL TETTO DI CREDIBILITÀ È DIVENTATO ANCHE UN CANCELLO** (`filtroProfondita`, 9 agosto 2026 — in
`main`; il piano nasce in un processo figlio a ogni ciclo, quindi **non serve riavviare per il pannello
«Ottimizza»**, ma agent41 va riavviato perché il log del rendiconto vive nel suo processo). Il tetto qui
sopra ATTENUA la quota di un book sottile e lascia il mercato nel set. Il knapsack **massimizza**: un
mercato tagliato a 0,60 batte comunque uno onesto al 5%, e viene scelto lo stesso. Il punto di
applicazione era sbagliato, non la misura.
- **La misura non cambia di una riga**: stessa `ceilingShare(size, competitorQ)` di
  `realistic-estimate`, stessa soglia `maxCredibleShare = 0,60` **importata e non ridichiarata**
  (`lib/rewards/profondita-minima.js`). Cambia solo QUANDO si guarda: prima della scelta.
- **Il metro è FISSO**: la quota si valuta a **$500 di capitale di riferimento** — lo stesso livello su
  cui agent24 pubblica già `levels["500"].share` — e non alla size che la riga riceverebbe. La
  sottigliezza è una proprietà del *book*, non del nostro conto: a metro variabile lo stesso mercato
  sarebbe sottile o no a seconda di quanto denaro c'è in cassa. Si cambia con
  `MAKER_PROFONDITA_CAPITALE_RIF`; un valore illeggibile viene scartato in favore del difetto.
- **`ignota` non esclude MAI.** Profondità non misurata o size per dollaro non calcolabile ⇒ il mercato
  resta, come per una scadenza illeggibile in `horizonVerdict`.
- **L'attenuazione resta viva** per chi supera il cancello: il cancello toglie i book che non esistono,
  il tetto continua a correggere chi diventa sottile alle size grandi. Due domande diverse.
- **La copertura del capitale NON ne risente, ed è misurato**: quattro piani appaiati sullo stesso board
  danno **$588,00 e 99,0%** in tutti e quattro gli scenari, anche togliendo il 72% del board. Col tetto
  di concentrazione al 20% bastano **cinque** mercati per coprire il capitale e ne restano **62**.
- **Effetto misurato sul piano vero** (9 agosto, $594,10 liberi): **42 mercati esclusi**, righe capate da
  **3/6 a 0/5**, quota mediana delle righe scelte da 60-95% a **21-57%**, lordo dichiarato $274 → $120/g
  e realistico $122,66 → $35,09/g. **Non è capitale perso: è ottimismo che non viene più contabilizzato.**
- **`capVuotiFrac` diventa in pratica irraggiungibile**: un book vuoto verificato ha quota 1, quindi il
  cancello lo prende sempre per primo. Resta come seconda linea e i suoi test lo coprono ancora.

**E il caso degenere: concorrenza misurata ZERO** (8 agosto 2026 sera — in `main`, già in servizio).
`share = size/(size+cQ)` vale **1** quando la concorrenza in banda vale 0, e il knapsack massimizza: un
book vuoto era l'occasione migliore che potesse leggere, mentre `realisticEstimate` su quel caso si
**rifiuta** di stimare (`empty-book`). Due meccanismi, con lo stesso interruttore:
- **Lo zero è un fatto o un buco?** Si può sapere: `agent34` scrive la profondità in banda come `null`
  quando banda, mid o book mancano, e come **numero solo dopo aver camminato ogni ordine** dentro la
  banda. Uno **0** è «ho guardato e non c'era nessuno»; un dato mancante è `null` e non diventa mai
  zero. `profonditaVerificata(rows)` classifica `misurata` / `vuota-verificata` (mediana zero con ≥10
  campioni misurati e ≥1 zero su book **fresco**, `src:'ws'`) / `non-verificata`. Sul terzo caso
  **l'obiettivo si astiene** — niente punteggio, e neanche un fattore più basso inventato.
- **Quanto piano può reggere un deserto verificato?** `capVuotiFrac = 0,30`: i mercati con book vuoto
  verificato possono valere insieme al più il 30% del lordo pesato del piano; oltre, si tengono i
  migliori e gli altri restano fuori col motivo, e il DP rigira (lo stesso idioma del filtro orizzonte).
  Serve perché **un tetto di capitale non basterebbe**: con `cQ = 0` la quota vale 1 a qualunque size,
  quindi il lordo è piatto e il knapsack dà già il minimo — l'unica leva è quanti ne entrano.
  0,30 e non altro: il tetto per *mercato* è 0,20 sul *capitale*, e questo vincola il *lordo modellato*
  di una *categoria*, quindi è deliberatamente più largo — ma resta sotto la metà.
- **Misurato**: su cinque finestre (dal vivo a −36h) i mercati a profondità mediana zero sono 0-2 e
  sono **tutti verificati** — lo zero non verificato non si presenta mai, quindi il primo meccanismo è
  protettivo e non correttivo. Sul piano vero ($660): 1 mercato su 6 è un deserto verificato e pesa il
  **25,9%** del lordo pesato, sotto il tetto ⇒ **il piano non cambia**. I due meccanismi sono tarati
  perché la situazione di oggi passi e quella delle 20:00 (73% su un mercato solo) no.

**La corsia calda si ordina sull'obiettivo del knapsack** (`collector-priority.js`, 8 agosto 2026 —
in `main`, non ancora nei processi). L'unione mobile con isteresi c'era; la **graduatoria** dei
quasi-vincitori no: era ordinata per `bestNetPerDay`, che `calcNetPerDay` annulla quando nessun fill è
stato osservato. Giusto per un numero da leggere, sbagliato per una graduatoria — escludeva i mercati
*silenziosi*, cioè quelli su cui un maker vuole stare. Misurato: **412 delle 755 righe future
esaminate erano fuori graduatoria**, quindi irraggiungibili da qualunque K. Ora si ordina su
`bestObiettivoPerDay` e scendono a 142/666 (storico) e **0/214** (vivo). I tre numeri, rimisurati:
**TOP_K 30 → 15** (vivo: K=10 copre 214/214 righe, profondità massima 9; storico: K=15 copre il 98,5%
delle coperibili e oltre non guadagna nulla fino a 50+), **RETENTION 12h confermato** (ritorni
osservati a 3,01h · 6,01h · 8,01h), **MAX_MARKETS 40 → 30** (righe 7-9 + K 15 = 24, restano 6 slot;
il feed sta a **112 mercati su 125** di `TOTAL_MARKET_CAP`, quindi ogni slot chiesto è un mercato del
board in meno). Misura riproducibile: `node scripts/misura-ricambio-candidati.js` (sola lettura).

**IL CAPITALE DEVE STARE AL LAVORO: obiettivo 90%, e adesso è un numero** (`lib/maker/utilizzo-capitale.js`,
8 agosto 2026 sera — in `main`, **serve il riavvio di agent41 e del dashboard**, §5 punto 34). Il bot ha
sempre avuto tetti — 20% per mercato, 12% sulla coda lunga, un muro a 150 giorni — cioè regole che dicono
*dove non* mettere il capitale. Non aveva la regola simmetrica, e quindi non sbagliava mai per eccesso e
sbagliava sistematicamente per difetto senza che nessun numero lo dichiarasse.
- **Cosa conta come impegnato**: ordini a riposo (al nozionale) + posizioni aperte (al prezzo corrente).
  Il **totale** è quello più il saldo pUSD, e non c'è doppio conteggio: su questo venue un BUY a riposo
  immobilizza il collaterale, quindi ciò che è impegnato *non* sta nel saldo.
- **90% e non 100%**: il 10% di respiro è ~$67 su questo conto, cioè due ordini del nozionale mediano dei
  21 maker (~$34). Serve perché il trigger abbia sempre di che lavorare senza dover prima disfare.
  Si cambia con `MAKER_TARGET_UTILIZZO` (frazione); un valore illeggibile o fuori da `(0,1]` viene
  **scartato** in favore del difetto — la stessa regola di fine scala e dell'orizzonte.
- **NON è un permesso.** Non alza un tetto, non salta un controllo, non rende ammissibile un mercato che
  non lo era. Se i mercati validi non bastano, il verdetto giusto è «non raggiunto perché non c'era dove
  metterlo», e il modulo lo dichiara invece di forzare un ordine. `misuraUtilizzo` non decide niente:
  misura, e chi legge decide.
- **Non misurabile non è zero.** Un saldo illeggibile trattato come 0 direbbe «utilizzo 100%» proprio
  quando il capitale è fermo: è il difetto peggiore possibile qui, e per questo qualunque ingresso
  mancante produce `leggibile:false` senza percentuale, col motivo che dice *quale* ingresso manca.
- **Dove si vede**: `GET /api/maker/utilizzo-capitale` (sola lettura, tre fonti dichiarate una per una) e
  il referto di ogni mini-ciclo (`utilizzo`, `utilizzoStimatoDopo`) più la riga di audit
  `capital-idle-trigger`. Le fonti sono le **stesse** su cui il bot decide, non una seconda lettura.

**Il piano LEGGERO: «qual è il miglior uso del capitale libero adesso»** (`agent41`, 8 agosto 2026 sera —
in `main`, **serve il riavvio di agent41**). Il mini-ciclo sceglieva solo dal piano già salvato: se quel
piano non c'era, era vecchio, o i suoi mercati non avevano più spazio, rispondeva «nessuna azione» e il
capitale restava fermo **pur essendoci mercati validi che nessuno guardava**. Adesso ricalcola — con una
finestra di storico più corta, e il numero viene dalla misura:

| finestra | tempo | RSS di picco | righe scelte |
|---|---|---|---|
| 48h (il ciclo pesante) | 20,9-24,4 s | **1074-1086 MB** | 7 |
| 12h | 15,9 s | 464 MB | 7 |
| **6h — SCELTA** | **12,3-13,1 s** | **208-254 MB** | 7 |
| 3h | 12,2-12,6 s | 151-348 MB | 7 |
| 1h | 12,4 s | 322 MB | 7, ma la **composizione cambia** |

A sei ore il piano è **lo stesso** del pesante — stessi sette mercati, stesso capitale per mercato, in
entrambe le esecuzioni — a un quarto della memoria. A un'ora due righe si spostano ($24→$36, $96→$84):
è lì che la finestra diventa troppo corta. Sei ore stanno a fattore sei da quel punto.
- **Quando ricalcola**: piano assente · piano più vecchio di **1 ora** · piano fresco ma **senza spazio**
  per il capitale libero. Il caso comune — piano di venti minuti fa con un mercato svuotato — **non** paga
  i tredici secondi: si parte dal salvato.
- **Non sovrascrive la memoria del ciclo pesante**: chiama `calcolaPianoFuoriProcesso` e non
  `calcolaPiano`, quindi né `realloc-ultimo-piano.json` né le priorità del raccoglitore vengono toccate.
- **«Leggero» vuol dire meno storico, non meno regole**: muro dell'orizzonte, quota della coda lunga,
  tetto di categoria sui book vuoti e tetto di credibilità restano tutti.
- Si cambia con `REALLOC_PIANO_LEGGERO_ORE`; sotto le 2 o sopra le 48 il valore è scartato.

**Il mini-ciclo tocca PIÙ mercati in un giro** (`pianificaGiro`, stesso lavoro). Con un tetto al 20% un
solo mercato assorbe al più un quinto del capitale: da un conto interamente liquido servivano **cinque**
mini-cicli, e fra uno e l'altro c'è il cooldown di dieci minuti — quasi un'ora per rimettere al lavoro
capitale già tutto disponibile al primo giro. Ora `scegliMercato` viene chiamata in sequenza su un libro
mastro che si aggiorna: **nessuna seconda logica di selezione**, la stessa funzione con gli stessi
cancelli, applicata più volte. Si ferma al primo fra: capitale sotto il minimo di un ordine sensato ·
obiettivo di impegno raggiunto · **6 mercati per giro** (`TRIGGER_CAPITALE_MAX_MERCATI`) · **posti per
mercati NUOVI esauriti** · nessuna riga più utilizzabile — e il motivo dello stop viaggia nel referto.

**AVVIA piazza in minuti, non in ore** (`sorvegliaAvvio` in agent41, 8 agosto 2026 sera — in `main`,
**serve il riavvio di agent41**). Premere AVVIA non anticipava niente: il ciclo fisso conta dalle sei ore
dell'ultimo `lastRunAt`, quindi l'8 agosto un AVVIA alle 12:07 aveva il primo ciclo utile alle 16:16.
Adesso un poller da **15 s** guarda l'*istante* dell'interruttore e, quando cambia in accensione, lancia
**un mini-ciclo forzato**.
- **Non tocca il timer delle sei ore** e non sposta `lastRunAt`: il ciclo pesante ribilancia e cancella, e
  farlo partire da un bottone sarebbe un'azione molto più grande di quella che il bottone promette.
- **La forzatura salta le due ATTESE e nient'altro**: quiete e cooldown esistono contro il polling, non
  contro una persona. Bot FERMO, kill e lucchetto del ciclo restano davanti — provato da cinque asserzioni.
- **L'istante e non un booleano**: con un booleano un AVVIA premuto mentre il processo era giù sarebbe
  letto come «acceso da sempre» al riavvio. All'avvio si parte dall'istante corrente, proprio perché un
  `pm2 restart` non è un bottone premuto da una persona.
- **Il conto dei due minuti, misurato**: rilevazione ≤15 s + saldo ~1 s + ordini ~1-3 s + ricalcolo
  **15,3 s** (misurato col piano vero) + piazzamento ~2-6 s = **~35 s**, con il margine tutto davanti.

**Il KILL è diventato un cancello del trigger, non solo un rifiuto a valle.** Fermava già ogni ordine, ma
molto più giù: il mini-ciclo arrivava a leggere saldo e ordini — e da oggi a calcolare un piano — per poi
vedersi rifiutare ogni gamba. Con il ricalcolo quel lavoro sprecato costa tredici secondi e centinaia di
megabyte per giro. Il kill si legge in un microsecondo: va davanti.

**Il capitale fermo non aspetta sei ore** (`lib/maker/trigger-capitale-fermo.js`, 8 agosto 2026 — in
`main`, **non ancora nel processo**: serve un riavvio di agent41, §5 punto 17). Il ciclo fisso resta
identico e continua a girare ogni 6 h; accanto c'è un **mini-ciclo** che ogni **120 s** guarda una cosa
sola: quanto collaterale è libero.
- **La misura**: il saldo pUSD. Su questo venue un ordine BUY a riposo *immobilizza* il collaterale,
  quindi il saldo libero **è** per costruzione il capitale non allocato — dedurlo sottraendo gli ordini
  sarebbe una seconda lettura che può divergere dalla prima.
- **Soglia $50** (decisa dall'operatore): con quella cifra c'è spazio per un ordine intero, dato che il
  nozionale mediano dei 21 maker di riferimento è ~$34.
- **Cadenza 120 s**: la cache del saldo ha TTL 45 s, quindi sotto i 45 s si rileggerebbe lo stesso
  valore. 120 s sono 2,7 TTL e costano una chiamata al dashboard locale. La lettura del **venue** non
  avviene a ogni giro, solo quando la soglia è già superata.
- **Non ricalcola il piano** — è tutto il punto: quel calcolo costa ~52 s e 687 MB. Legge l'**ultimo
  piano salvato** (`data/realloc-ultimo-piano.json`, scritto dal ciclo fisso, ridotto ai soli campi che
  servono a costruire le due gambe).
- **Dove manda il capitale**: sul mercato dove il piano aveva messo capitale e adesso ne ha meno del
  previsto — la definizione operativa di «capitale liberato». Riporta il portafoglio *verso* il piano
  invece di inventarne uno nuovo.
- **Le sei cose che non può fare**, strutturali: non cancella niente (ed è la risposta completa a «e gli
  ordini manuali?» — non tocca **nessun** ordine esistente); non piazza a bot FERMO; non si sovrappone
  al ciclo fisso (`inCorso` condiviso, rilasciato in `finally`); non piazza su saldo illeggibile né su
  board più vecchio di 20 min; non forza (spazio sotto $34 o size sotto il minimo del venue ⇒ il
  capitale resta liquido).
- **Audit distinto**: `reason: 'capital-idle-trigger'`, per contare nel tempo quanto spesso scatta e
  quanto capitale rimette al lavoro senza confonderlo coi cicli fissi.
- **Si guarda lavorare senza toccare capitale**: `node scripts/simula-trigger-capitale.js 120` esegue la
  funzione vera con la sola corsia di piazzamento sostituita da un registratore.
- **Una riga malformata non ferma più la ricerca** (8 agosto 2026, sera — in `main`, **serve il riavvio
  di agent41**, §5 punto 21). `scegliMercato` accetta un predicato iniettato `gambeCostruibili`: una
  riga le cui due gambe non si costruiscono viene **saltata** con il motivo a verbale in `esaminate`,
  e la scelta passa alla successiva della graduatoria — esattamente come già faceva per lo spazio
  insufficiente o le share sotto il minimo. Il predicato è iniettato e non importato, così il modulo
  resta puro e la costruzione delle gambe continua a vivere in un posto solo; un predicato che
  **esplode** vale «non costruibile», mai un via libera. Chi non lo passa ha il comportamento di prima.

**La truthiness di `find` non è un test di esistenza** (`lib/rewards/plan-to-orders.js`, 8 agosto 2026
sera). `gambeDiUnaRiga` proteggeva la gamba nulla così:

```js
const impossibile = gambe.find((g) => !g || g.placeable !== true);   // ← restituisce l'ELEMENTO
if (impossibile) { … }                                               // ← e l'elemento È null
```

`planQuotes` torna con `yes:null, no:null` quando mid, offset o **tick** non sono leggibili
(`mm-quote-math.js:32-34`). In quel caso `find` trovava la gamba nulla, restituiva `null`, e la guardia
**non scattava** — ingannata esattamente dal caso per cui era stata scritta. Due righe sotto,
`g.inBand` esplodeva. Ora è `findIndex` con la sentinella `-1`, che non può collidere con un elemento
legittimo. **Regola generale**: in un array che può contenere valori falsy, «esiste un elemento che…»
si scrive con `findIndex` o `some`, mai con la truthiness di `find`.

**Il pannello non si accoda più a se stesso.** `placeManualOrder`, quando il chiamante non passa
`ownOrders`, li **legge** dal venue e tiene solo il lato che sta quotando (per token id). Prima solo
agent40 li passava: tutti gli altri percorsi con `inCoda:true` mandavano una lista vuota, e dal secondo
ordine in poi il «concorrente» da battere eravamo noi — un tick per ogni nostro ordine davanti.

**LA GERARCHIA DEL MERGE NON HA PIÙ SCORCIATOIE** (`lib/maker/auto-close.js`, 8 agosto 2026 sera — in
`main`, **serve il riavvio di agent40**, §5 punto 34). Fino a oggi il tentativo di completare la coppia
viveva in **un ramo solo** del ciclo, quello appena prima dell'uscita ordinaria. Gli altri due arrivavano
prima e facevano `continue`:
- `already-covered` (c'è già un'uscita a riposo) → il merge non veniva **nemmeno valutato**;
- `close-at-market` (l'attesa ha superato le 24h) → idem, e per costruzione.

Cioè «prima si completa la coppia, poi si vende» era vero su un percorso su tre, e i due che la saltavano
erano proprio quelli in cui una posizione stava ferma **da più tempo**. Su Schwartzel FL-19 il Livello 1
era calcolato, conveniente (coppia a **98,8¢**) e irraggiungibile per ventiquattro ore di fila.

Adesso c'è **una funzione sola** (`completaCoppia`) chiamata da **tutti e tre** i rami: la precedenza è una
proprietà del codice, non una promessa in un commento.
- **La disciplina non cambia**: le uscite a riposo si **tolgono prima**, e se anche una sola cancellazione
  non riesce non si compra niente — stessa regola della chiusura a mercato, stessa lista, stesso verso di
  fallimento. `!c` e non `c && c.ok === false`: un cancellatore assente non è una cancellazione riuscita.
- **Se il merge rinuncia dopo aver cancellato**, la posizione è scoperta *adesso*: si ridecide con la lista
  vera degli ordini rimasti e **l'uscita torna sul libro nello stesso ciclo**, non al prossimo.
- **Il merge non è un rinvio infinito**: se il completamento va a riposo parte l'orologio dei 60 minuti, e
  alla scadenza `decidiLivello` risponde 3 — si torna alla chiusura forzata e si vende davvero.
- **Più aggressivo verso il completamento**: un'attesa aperta non congela più la decisione. Se mentre il
  Livello 2 riposa l'ask dell'altro lato scende dentro il tetto, si **cancella il completamento a riposo e
  si prende l'ask** (Livello 1). Prima si aspettavano i 60 minuti a prescindere.
- **Cosa passa ancora prima, e giustamente**: mercato chiuso e mercato che non accetta ordini. Lì non si
  piazza niente di niente, quindi non c'è gerarchia da rispettare.
- **La gamba riempita non viene messa in uscita per il solo fatto di essere sbilanciata**: resta viva e
  matura premi finché la coppia non si completa o la gerarchia non arriva al Livello 3.

**Merge — I LIVELLI 1 E 2 SONO VIVI NEL PROCESSO (dal riavvio di agent40 delle 16:49:18Z dell'8 agosto 2026).** Strategia a livelli in
`lib/maker/strategia-merge.js`: L1 taker immediato se la coppia YES+NO costa ≤ 99¢, L2 maker con skew
(attesa 60 min), L3 ripiego sull'uscita classica. Il **ciclo split→merge è stato provato davvero** il
7 agosto 2026 su Schwartzel FL-19 (`negRisk=true`, il caso più difficile): split $2 → merge $2, saldo
tornato alla cifra esatta di partenza, gas pagato dal relayer gasless.

`MERGE_STRATEGY_ENABLED = true` dall'8 agosto 2026, su decisione esplicita dell'operatore in chat, e
`auto-close.js` **esegue** i due livelli: al posto dell'uscita ordinaria piazza il completamento della
coppia sul secondo lato. Tre cose da tenere ferme:
- **il merge on-chain resta impossibile** (`CTF_RELAYER_ENABLED = false`, sotto): la coppia completata
  paga $1 **alla risoluzione**, non subito. Il profitto è matematico, la liquidità è differita;
- **il Livello 1 oggi non passa** — l'anti-incrocio consente di attraversare lo spread solo in vendita
  (§5 punto 29) — e degrada al Livello 2 nello stesso ciclo;
- il Livello 2 è prezzato a `min(tetto, migliorAsk − tick)` per **riposare** invece di incrociare, e la
  sua attesa vive in `data/merge-attese.json`, su disco, perché sopravviva ai riavvii.

Restano `false` le due costanti che governano il merge **on-chain**, e accendere la prima non accende
la seconda:
- `CTF_RELAYER_ENABLED = false` — costante nel sorgente di `lib/maker/ctf-relayer.js:94`, **non** una
  env. Sotto di essa ogni operazione si ferma *prima* della firma.
- `MERGE_STRATEGY_ENABLED = false` — `lib/maker/strategia-merge.js`. Accendere la prima non accende la
  seconda. Nessun agent, route o scheduler importa `ctf-relayer`.
Motivo per cui il merge on-chain resta spento: non è una scelta, è il blocco tecnico delle quattro
ragioni nell'intestazione di `strategia-merge.js` (nessun percorso di scrittura on-chain, token nel
funder-contratto, funder senza MATIC, deposit wallet ERC-1271). La conseguenza — completare la coppia
**immobilizza** capitale invece di liberarlo — è stata accettata esplicitamente dall'operatore l'8
agosto 2026 accendendo i Livelli 1 e 2.
Trappola operativa registrata: il relayer rifiuta le deadline corte (`400 deadline too soon`);
`DEADLINE_SEC` è ora **900 s**.

**`CTF_RELAYER_ENABLED`: `false`** (verificato: `lib/maker/ctf-relayer.js:94`).

**agent41 dry-run: la variabile non esiste più.** `REALLOC_SCHEDULER_DRY_RUN` non è letta da nessuna
riga di codice (verificato con `grep`: restano solo commenti storici e i test che ne vietano il
ritorno). La decisione «racconta / fa» è passata interamente ad AVVIA/FERMA.

**STATO OPERATIVO ALL'8 AGOSTO 2026, 12:07:55 UTC: IL BOT È SU AVVIA.** L'operatore ha premuto il
bottone dalla tab «Mercati ottimizzati»: `data/maker-bot-enabled.json` esiste e dice `enabled:true`,
`by:"operatore · tab Mercati"`, `reason:"AVVIA dalla dashboard"`. **Da questo momento il prossimo ciclo
di agent41 piazza ordini VERI** — non è più un'anteprima. *(All'epoca la rampa era a `0/5 mercati aperti
nelle prime 24h`: quel tetto è stato rimosso il 9 agosto 2026 — §5 punto 43.)*

**Ma alle 12:45 UTC non era ancora stato piazzato niente, e la ragione è strutturale.** L'ultimo ciclo
completo è delle `2026-08-08T10:16:26Z` — *prima* dell'AVVIA e prima che agent41 ripartisse (11:24) col
codice del trigger. Premere AVVIA **non anticipa il ciclo**: `prossimoRitardo()` conta dalle sei ore
dell'ultimo `lastRunAt` su disco, quindi il prossimo giro è alle **16:16:26Z**. E il trigger a capitale
fermo, che esiste proprio per non aspettare, **non può coprire il primo avvio**: scatta regolarmente
(`saldo $646,26 ≥ soglia $50`, ogni 10 min per il cooldown) ma esce al passo 1 con «nessun piano
salvato finora: il primo ciclo completo lo scrive» — `data/realloc-ultimo-piano.json` non esiste ancora.
Vedi §5 punto 19.

**Guardiano delle perdite: attivo.** Il processo gira dalle 21:27:31 del 7 agosto 2026 con
baseline **$660,56** in `data/guardian-baseline.json` (sopravvive ai riavvii, si azzera solo
cancellando il file). Soglie lette da `.env` a ogni giro: `GUARDIAN_LOSS_PCT=5`,
`GUARDIAN_LOSS_ABS=30`. Nessuno scatto: `data/guardian-state.json` non esiste.

**Confronto stima / consuntivo del venue: infrastruttura pronta, dato ancora assente.**
`lib/maker/confronto-reward.js` (agent40, 23:55 e 00:20/00:40/01:00 UTC) più
`lib/maker/reward-reale.js`, rotta `/api/maker/confronto-reward`. L'8 agosto 2026 il percorso
interrogato è stato **corretto**: `/rewards/user` e `/rewards/user/total` rispondono **401** con le
nostre credenziali L2, **`/rewards/user/markets?date=…` risponde 200** e dà anche la scomposizione per
mercato (paginato, `next_cursor`; la firma HMAC va sul percorso *completo*, query inclusa).
**Ma quel 200 non è un consuntivo**: nella lettura reale portava `maker_address` a **zero su tutte e
5.065 le righe** e `earnings: 0` ovunque — è il catalogo dei mercati premianti, non l'estratto conto
di questo maker. Una lettura vale quindi solo se **almeno una riga è attribuita** a un nostro
indirizzo (EOA o funder); altrimenti `disponibile:false`, `attribuito:false`, motivo per esteso.
Il verdetto sulla deriva (`divergenza`) è **mediana ≥30% su ≥5 giornate confrontabili e ≥80% nello
stesso verso**, viaggia nel file, nella rotta e nel log di agent40 quando *cambia*; `dati-insufficienti`
è un terzo esito e non vuol dire «va bene». **Non corregge niente** per scelta.

**LA FONTE CHE ATTRIBUISCE DAVVERO, trovata l'8 agosto sera.** Il CLOB non attribuisce nulla, e la
ragione non era l'endpoint: era l'**identità**. Le credenziali L2 sono dell'EOA che firma, ma su un
deposit-wallet ERC-1271 il maker è il **funder**. Il registro attività **pubblico** è keyed sul funder:

```
GET https://data-api.polymarket.com/activity?user=<funder>&type=REWARD
```

Sul conto di questa macchina c'è **un** pagamento: **$1,3042** alle 00:00:03 del 7 agosto,
tx `0x4333636f…3be` — il reward della giornata del **6 agosto**, per cui la stima diceva **$3,09**.
**Primo confronto stima↔consuntivo mai riuscito: sovrastima del 136,93%.** Il 401 lo teneva invisibile.
- La fonte è **senza credenziali** — rafforza la proprietà del modulo: non ha nemmeno le chiavi L2.
- **Non porta il mercato** (`conditionId` vuoto): la scomposizione resta non disponibile e viene
  dichiarata, non inventata dividendo il totale.
- Un pagamento appartiene alla giornata UTC appena chiusa (`giornoDiCompetenza`, 6 ore di margine
  dichiarate — assunzione su una sola osservazione).
- **Uno zero vale zero solo se** il registro contiene almeno un nostro pagamento *e* la finestra di
  quella giornata è chiusa. Altrimenti resta «non lo so».
Il percorso CLOB è diventato `leggiRewardDaMercati`, fonte **secondaria e spenta** (≈51 richieste a
notte per un catalogo non attribuito), riaccendibile con `conScomposizione`.

**Altri stati letti:** kill-switch **non attivo** (`killed:false`); `MANUAL_ORDER_PLACEMENT=send`;
`MAKER_FUNDING_APPROVED=true` su agent40/41 (attestazione umana, non un armamento — e dal 9 agosto 2026
non esiste più nemmeno l'armamento a cui contrapporla: §5 punto 63). *(La riga sull'arming disarmato
che stava qui è decaduta con la rimozione del meccanismo.)*

---

## 5 · QUESTIONI APERTE

Lista viva. Solo voci con evidenza reale nel codice, nei commit o nei file di stato.

1. **~~Il bot non è mai stato avviato~~ — CHIUSO alle 12:07:55 UTC dell'8 agosto 2026.** L'operatore ha
   premuto AVVIA dalla dashboard. `statoBot()` risponde `enabled:true`, `by:"operatore · tab Mercati"`.
   Vedi §4 per lo stato completo e §5 punto 19 per il motivo per cui questo, da solo, non ha ancora
   prodotto ordini. (Era già chiuso il resto del punto: il codice del guardiano è in git dal 7 agosto
   — `dbba34e` — e i residui che un suo test aveva lasciato sullo stato vero sono stati cancellati la
   sera stessa; la versione attuale del test inietta `impostaBot` e `registraCancellazione`.)
2. **~~La copertura dichiarata di FERMA non corrisponde al runtime di agent35~~ — CHIUSO il 9 agosto
   2026 rimuovendo il processo (§5 punto 63).** Il difetto era una divergenza fra un commento
   (`agent43-guardian.js`: «agent35 è fermato a monte da `MAKER_MODE=off`») e il runtime vero
   (`MAKER_MODE=live-min`, `MAKER_PLACEMENT=send` letti da `/proc/<pid>/environ`). Non è stato chiuso
   correggendo il commento: è stato chiuso togliendo il processo di cui parlava.
   **Il limite residuo resta, ed è più stretto di prima:** FERMA copre agent41; il pannello manuale e
   agent40 restano fuori, e continua a non esistere un punto in cui bloccare i piazzamenti nuovi senza
   bloccare anche le uscite. Con agent35 rimosso, però, ogni strada verso il venue passa ora
   dall'imbuto manuale — `lib/maker/percorsi-di-invio.test.js` lo asserisce, e l'asserzione è passata
   da «esattamente UN percorso sfugge» a «NESSUN percorso sfugge».
3. **`REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41 — PER DECISIONE
   DELL'OPERATORE (8 agosto 2026), e un riavvio non può toglierla.** Inerte: nessuna riga di codice la
   legge, e `lib/maker/gestione-manuale-nel-flusso.test.js` fallisce se ricompare nel codice.

   **DOVE VIVE DAVVERO — misurato l'8 agosto 2026, ~07:30 UTC, e smentisce quello che questo punto
   diceva prima.** Non è nel demone pm2 (`/proc/<pid-demone>/environ`: assente), non è in
   `~/.pm2/dump.pm2` (nessuna delle 41 app la porta), non è in `.env` né in `ecosystem.config.js` —
   in questi due compare solo dentro commenti storici. Vive nella **descrizione in memoria che pm2
   tiene del processo** (`pm2_env.REALLOC_SCHEDULER_DRY_RUN = 1`), fissata al primo avvio da una shell
   che ce l'aveva. Da lì un `resurrect` non la rimetterebbe: il dump è pulito.

   **PERCHÉ NESSUN `restart` LA TOGLIE, in nessuna forma.** `--update-env` **fonde**, non sostituisce:
   aggiunge e aggiorna le chiavi che trova, e non cancella mai quelle che non ci sono più. Una chiave
   entrata una volta nella descrizione sopravvive a ogni riavvio. Provato: riavvio eseguito da una
   shell in cui la variabile era dimostrabilmente assente, e dopo il riavvio era ancora lì.

   **IL COMANDO CHE QUESTO PUNTO DOCUMENTAVA ERA SBAGLIATO E PERICOLOSO.** Era
   `env -u REALLOC_SCHEDULER_DRY_RUN pm2 restart … --update-env`. Non solo non funziona: su questa
   macchina avrebbe **perso 63 variabili**, fra cui `DATABASE_URL`, `ADMIN_ACCESS_SECRET`,
   `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`, `MAKER_SIGNATURE_TYPE`, `MANUAL_ORDER_PLACEMENT` — tutte
   ereditate e **nessuna presente nel demone**. agent41 **non ha il caricatore di `.env`** (lo dice il
   blocco `env` in `ecosystem.config.js`), quindi le avrebbe perse davvero.

   **LA TECNICA GIUSTA PER RIAVVIARE agent41 SENZA PERDERE L'AMBIENTE** (usata l'8 agosto, verificata:
   102 → 102 variabili, zero chiavi perse). Si ricostruisce l'ambiente VERO dal processo vivo:
   ```bash
   PID=$(pm2 jlist | node -e "…")           # mai da pgrep — vedi il punto 8
   while IFS= read -r -d '' kv; do
     k=${kv%%=*}
     case "$k" in
       NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue ;;
     esac
     case "$k" in [A-Z]*) export "$kv" ;; esac   # solo MAIUSCOLE: scarta la contabilità interna di pm2
   done < /proc/$PID/environ
   pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler --update-env && pm2 save
   ```
   I due filtri non sono cosmetici: `NODE_CHANNEL_FD` è il canale IPC del processo **vecchio** ed
   ereditarlo è l'unico modo di rompere davvero il riavvio; il filtro sulle maiuscole toglie le chiavi
   di servizio di pm2 (`pm_id`, `exec_mode`, `name`, `status`, `cwd`, `script`…) finite nell'ambiente.

   **L'unica rimozione possibile sarebbe `pm2 delete` + `pm2 start`** (dalla shell qui sopra, perché
   il demone non ha le variabili critiche). L'operatore ha deciso l'8 agosto 2026 di **non farlo**: la
   variabile è inerte, il dump è pulito, e un `delete` azzera il contatore dei riavvii e lascia agent41
   giù se lo `start` fallisce. Questo punto resta aperto come **nota**, non come lavoro da fare.
4. **L'header di `lib/maker/strategia-merge.js` è invecchiato.** Elenca ancora quattro ragioni per cui
   il merge «NON è eseguibile dallo stack attuale»; il relayer gasless ne ha tolte tre e
   `ctf-relayer.js` la quarta, e il ciclo è stato eseguito davvero il 7 agosto 2026 (commit `95aa634`
   e `d21669d`). Il manuale operativo v2 è già stato corretto; questo file no.
5. **~~Arming disarmato da un kill ormai revocato~~ — CHIUSO il 9 agosto 2026: l'arming non esiste
   più** (§5 punto 63). La domanda aperta era «è voluto che nessuno l'abbia più riarmato dal 6
   agosto?». La risposta, data dai fatti prima che dalla decisione: per tre giorni il bot ha lavorato
   con capitale reale e l'arming è rimasto `armed:false` senza che nulla ne risentisse — perché
   l'unico processo che lo leggeva era agent35, che in quei tre giorni non ha piazzato niente. Un
   interruttore che nessuno accende e che niente richiede non è un presidio: è un pezzo di stato che
   può solo ingannare chi lo legge. Rimosso insieme al suo lettore.
6. **`data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da
   `.gitignore`.** **Non è più teorico: dalle 12:07:55 dell'8 agosto `data/maker-bot-enabled.json`
   esiste e compare come `??` in `git status`** — esattamente come questo punto prevedeva. Va aggiunto
   all'ignore *prima* che qualcuno lo committi: versionato, un `git checkout` può spostare
   l'interruttore del capitale. Tutti gli altri
   file dello stesso tipo — comprese baseline e latch del guardiano — sono ignorati per una ragione
   esplicita: descrivono *questa* macchina in *questo* momento, e versionare l'interruttore
   AVVIA/FERMA significa che un `git checkout` può spostarlo. Da aggiungere all'ignore.
7. **~~Il codice della sera del 7 agosto non è attivo~~ — CHIUSO alle 23:57 UTC del 7 agosto 2026.**
   Il tetto di concentrazione al 20% era stato deployato alle ~22:30–22:41; le fasi 1–8 sono state
   attivate con un secondo giro di riavvii autorizzati esplicitamente in chat («Riavvia agent35,
   agent40, agent41 e dashboard»):

   | Processo | restart | Cosa è entrato in servizio | Verifica |
   |---|---|---|---|
   | `agent35-maker` | 24 → 25 | rotaia `end-of-scale` in `risk-rails` | env intatto (`MAKER_MODE=live-min`, `MAKER_PLACEMENT=send`, funding approvato), log puliti |
   | `agent40-manual-reprice` | 49 → 50 | cadenza adattiva, ordini propri in coda, fine scala | soglie invariate all'avvio (`hysteresis 1 tick`, `confirm 2 samples`) — la cadenza non le tocca |
   | `agent41-realloc-scheduler` | 29 → 30 | timbro `origine: 'auto'`, `leggiOrigini` nel reset | «tetto per mercato 20% · il bot è FERMO» |
   | `dashboard` | 167 → 168 | pannello «Mid vivo», rotta SSE `/api/maker/live-mid` | http 200; la rotta risponde 401 come `board` e `status` (stesso gate operatore); «Mid vivo» nel chunk servito |

   Log di errore vuoti su tutti e tre gli agent; le righe rosse del dashboard sono le vecchie delle
   22:39 e il contatore dei riavvii non sale.
   Nota operativa registrata: **verificare `.next/prerender-manifest.json` prima di riavviare il
   dashboard**. Una build incompleta ne produce solo la variante `.js`, e il processo entra in crash
   loop con `ENOENT` (successo il 7 agosto: 19 riavvii automatici prima che una build nuova lo
   risolvesse). Verificato prima di questo riavvio, ed è andato liscio.

8. **`pgrep -f <nome-processo>` non è affidabile in questa sessione.** Il comando che lo esegue contiene
   il nome cercato, quindi `pgrep` trova anche la propria shell e `head -1` può restituire quella: il
   7 agosto è costato due riavvii inutili di agent41 e una diagnosi sbagliata («l'ambiente è andato
   perso», mentre erano 102 variabili tutte al loro posto). Per l'ambiente di un processo pm2 si prende
   il pid da `pm2 jlist` e si legge `/proc/<pid>/environ`.

9. **~~Il codice dell'8 agosto non è nei processi~~ — CHIUSO alle 07:22 UTC dell'8 agosto 2026.**
   Riavvii autorizzati esplicitamente in chat («Riavvia agent41, agent40, dashboard e agent34»).

   | Processo | restart | Cosa è entrato in servizio | Verifica |
   |---|---|---|---|
   | `agent41-realloc-scheduler` | 31 → 33 (due riavvii: uno col resto della flotta, uno per il tentativo di togliere `REALLOC_SCHEDULER_DRY_RUN` — vedi punto 3) | punteggio di posizione nella selezione + graduatoria e K/N della corsia calda (è chi *scrive* `collector-priority.json`) | env intatto: 102 variabili, `MAKER_FUNDING_APPROVED=true`, `MAKER_MODE=off`; «tetto per mercato 20% · il bot è FERMO» |
   | `agent40-manual-reprice` | 50 → 51 | percorso corretto del consuntivo, guardia di attribuzione, scomposizione per mercato, avviso di deriva | cadenza adattiva regolare, log di errore vuoto |
   | `agent34-clob-ws` | 15 → 16 | `MAX_MARKETS=30` in `readCollectorPriority` | risottoscrizione pulita, 107 mercati / 214 asset |
   | `dashboard` | 168 → 169 | `divergenza` e `soglie` su `/api/maker/confronto-reward` | http 200 sulla root; la rotta risponde 401 come `board` e `status` (stesso gate operatore); «divergenza» nel chunk servito |

   Log di errore vuoti su tutti e tre gli agent; le righe rosse del `dashboard` sono le vecchie delle
   03:36 e nessun contatore sale da solo (verificato a +3 minuti: 169/16/51/32, tutti +1 rispetto al
   prima; agent41 è poi passato a 33 per il secondo riavvio, voluto, del punto 3).
   `.next/prerender-manifest.json` verificato PRIMA del riavvio del dashboard (nota del punto 7).

   **Effetto immediato, misurato:** `collector-priority.json` è ancora quello scritto alle 04:16 dal
   codice vecchio (**40 mercati**), ma agent34 adesso ne legge **30** — il tetto nuovo morde già in
   lettura. Il file tornerà nativamente a ≤30 al prossimo ciclo di agent41, **fra ~175 minuti**
   (~10:15 UTC): fino ad allora K=15 vive solo in lettura, non ancora in scrittura.

   Già vivo anche senza riavvio, e resta un fatto utile: il pannello «Ottimizza». `/api/rewards/allocate`
   non importa l'allocatore nel bundle — esegue `planFromCollection` in un processo node NUOVO a ogni
   chiamata, quindi legge sempre il codice su disco.

10. **~~L'obiettivo non sente il tetto di credibilità~~ — CHIUSO l'8 agosto 2026, sera.**
    `maxCredibleShare` è dentro l'obiettivo del knapsack (`useCredibleShareCap`), riusando le funzioni
    **estratte** da `realistic-estimate.js` invece di riscriverle; l'estrazione è provata neutra sulla
    stima realistica (hash identico su 4.320 combinazioni). Nel farlo è emerso e si è corretto un
    secondo difetto: il fattore di posizione non è `S` ma `S·size/(S·size+cQ)` diviso la quota-ceiling.
    Vedi §4. Misurato su sei finestre: il realistico non peggiora mai e migliora fino a **+11,2%**.

11. **~~Il confronto non ha ancora un dato~~ — CHIUSO l'8 agosto 2026, sera.** La fonte che attribuisce
    è il registro attività pubblico, keyed sul **funder** (le credenziali L2 sono dell'EOA: era un
    problema di identità, non di endpoint). Prima misura reale: stima $3,09 contro consuntivo
    **$1,3042** per il 6 agosto, **sovrastima del 136,93%**, con il `transactionHash` nel registro.
    Restano **4 giornate** prima che `divergenza` possa pronunciarsi (ne servono 5 confrontabili).
    Vedi §4.

12. **I cinque test rossi: diagnosi fatta, correzione da decidere.** Il report è in
    `docs/indagine-cinque-test-rossi.md` (8 agosto 2026). **Nessuno dei cinque segnala un bug di
    produzione**, e in particolare **il sospetto bug di unità di misura su `MIN_HORIZON_DAYS` non
    esiste**: la conversione giorni→minuti è corretta, è cambiato il *valore* (2 → 0,25 g) con il
    commit `0a0a845` e con la motivazione misurata (i 21 maker entrano su mercati con vita mediana
    0,44 g; il pavimento a 2 giorni escludeva l'archetipo). Tutti e cinque sono `(a)`: test o
    rilevatori rimasti indietro, o fixture che non allestiscono il caso che vogliono provare —
    `risk-classifier` e `scadenza-ereditata` hanno la **stessa** causa, `cancellazione-riconosciuta`
    interroga la produzione e trova un campione vuoto (0 `cancelOrder` su 22.602 righe di polling),
    `dipendenze-collegate` è un falso positivo su un ternario andato a capo, `scaduto-senza-rinnovo` ha
    una fixture il cui ordine viene riprezzato al primo giro.
    **Una cosa da correggere c'è, ed è un commento:** `lib/maker/risk-classifier.js:26` dichiara
    `MIN_HORIZON_DAYS = 2` mentre il valore importato è 0,25 — su un modulo la cui intestazione promette
    che «la soglia usata e la soglia scritta non possano raccontare due numeri diversi». Non corretto:
    va deciso insieme al test, e scritto in modo che non possa invecchiare di nuovo.

13. **~~Il caso degenere della concorrenza misurata ZERO~~ — CHIUSO l'8 agosto 2026, sera.** Vedi §4:
    la distinzione fra deserto misurato e buco è ricostruibile e implementata, e un tetto di categoria
    al 30% impedisce che un deserto verificato sia la maggioranza del piano. Misurato: lo zero non
    verificato non si presenta mai su cinque finestre, e sul piano di adesso la categoria pesa il 25,9%
    — sotto il tetto, quindi il piano non cambia.

14. **Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte.**
    Nessuno dei tre file toccati (`lib/rewards/allocator.js`, `lib/rewards/realistic-estimate.js`,
    `scripts/rewards-replay/lib/allocate.js`) vive dentro un processo pm2 di lunga durata: **entrambi**
    i percorsi che calcolano un piano lo fanno in un processo node nuovo che rilegge il codice da disco.
    - `/api/rewards/allocate` → `execFile('node', ['-e', RUNNER])` (pannello «Ottimizza»);
    - `agent41-realloc-scheduler` → `RUNNER_PIANO`, riga 225, un figlio per ciclo. Non è per il codice
      caldo: è la correzione del 4 agosto 2026, perché il piano porta il processo da 41 MB a 687 MB
      contro un tetto pm2 di 400 MB, e pm2 lo fermava **nel mezzo del ciclo**.
    Verificato empiricamente eseguendo il runner esatto di agent41: risponde `tettoCredibilita: true`,
    `mercatiCapati: 4`. Quindi il lavoro è in servizio senza toccare niente.

    **TRAPPOLA REGISTRATA, e ci sono cascato:** un walker del grafo dei `require` che cerchi
    `require('...')` con una regex trova anche i `require` **dentro le stringhe** — e `RUNNER_PIANO` è
    esattamente una stringa che contiene `require(".../lib/rewards/allocator")`. Il walker mi ha
    dichiarato che agent41 importa l'allocatore in-process, e non è vero: c'è solo quella stringa. Chi
    scrive un test che cammina i `require` (ce ne sono già tre in questo repo) tenga conto che una
    stringa non è un import — e che qui la differenza è fra «serve un riavvio» e «non serve».

15. **~~La rinomina non è ancora in pm2~~ — CHIUSO alle 09:15:41 UTC dell'8 agosto 2026.** Eseguito
    dall'operatore: `agent42-guardian` (pm_id 43) fermato, `agent43-guardian` (pm_id 44) avviato al suo
    posto. Verificato: **89 variabili d'ambiente, tutte e quattro le critiche presenti**
    (`DATABASE_URL`, `KEY_CUSTODY_MASTER`, `POLYGON_RPC_URL`, `MAKER_FUNDER_ADDRESS`), contatore dei
    riavvii a 0 come previsto, e soprattutto **il guardiano legge il capitale**: «ok — PnL +8,47 USD
    (+1,282%) · baseline $660,56 → $669,03 · soglie −30 USD / −5%». Era il rischio del punto: un
    guardiano senza quelle variabili non scatta mai, e il log dimostra che non è il caso.
    Alle 09:16:08 è stato riavviato anche `agent40-manual-reprice` (51 → 52, 95 variabili, 4/4
    critiche), quindi da stanotte il consuntivo reward usa la fonte nuova in automatico.

    *(Il comando che era documentato qui, con la ricostruzione dell'ambiente dal processo vivo, resta
    valido e riutilizzabile: è nel punto 3.)*

16. **`agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata.** Prima
    scansione: **17 reperti aperti, nessuno ad alta severità**. Vale la pena sapere cosa ha trovato al
    primo colpo, perché due cose non le sapevamo:
    - il commento di `lib/maker/risk-classifier.js:26` fermo a `MIN_HORIZON_DAYS = 2` — lo stesso che
      §5 punto 12 registra come «da correggere»: il rilevatore lo trova da solo;
    - **tre flag di `.env` che nessuna riga legge più**: `CAPITAL_USD`, `OFFSET_TICKS`, `MAX_MARKETS`
      (verificati a mano: zero occorrenze di `process.env.<nome>` in tutto il repo);
    - **tre test che `node` non riesce nemmeno ad avviare** — `lib/leg-order.test.js` e i due in
      `lib/venues/__tests__/`: sono test in JS per moduli **TypeScript**, quindi `require('./leg-order')`
      non si risolve. Non sono rossi: non sono mai partiti, ed è una copertura che si credeva di avere.
      Sono in aggiunta ai cinque rossi noti del punto 12, che restano cinque.
    Si guarda con **`node scripts/vedi-audit.js`** (o `cat data/audit-coda.md`). La coda è ignorata da
    git: descrive questo albero di lavoro su questa macchina, e versionarla farebbe ripartire da zero
    l'età dei problemi aperti.

    **Il comando, e i due motivi per cui non è quello ovvio:**
    ```bash
    # 1 · l'ambiente VERO del processo vivo (95 variabili), meno le chiavi di servizio di pm2.
    #     Senza questo passo il guardiano perde DATABASE_URL, KEY_CUSTODY_MASTER, POLYGON_RPC_URL e
    #     MAKER_FUNDER_ADDRESS — nessuna delle quali sta nel suo blocco `env` e nessuna nel demone —
    #     e un guardiano che non sa leggere il capitale è un guardiano che non scatta mai.
    PID=$(pm2 jlist | node -e "…")          # mai da pgrep, vedi il punto 8
    while IFS= read -r -d '' kv; do
      k=${kv%%=*}
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue ;; esac
      case "$k" in [A-Z]*) export "$kv" ;; esac
    done < /proc/$PID/environ
    # 2 · e solo adesso
    pm2 delete agent42-guardian && pm2 start agents/ecosystem.config.js --only agent43-guardian && pm2 save
    ```
    **Cosa NON si perde:** la memoria del guardiano è nei file, non nel nome —
    `data/guardian-baseline.json` (il punto zero, $660,56) e `data/guardian-state.json` (la latch)
    sopravvivono, quindi il guardiano riparte dallo stesso baseline e non si «riarma» da solo.
    **Cosa si perde:** il contatore dei riavvii riparte da zero, e fra il `delete` e lo `start` il
    capitale resta per qualche secondo senza guardiano. Oggi l'esposizione è nulla — il bot è FERMO e
    l'ultimo ciclo di agent41 ha piazzato 0 ordini — ma va detto prima, non dopo.
    **Cosa non instrada nulla:** la chiave di battito è cambiata insieme al nome, e nessuno la legge —
    `agent-monitor` non sorveglia questo processo (non è in `WATCHED_AGENTS_RAW`) e agent37 guarda i
    battiti dei motori. Il campo `by` dei referti passa al nome nuovo solo per i referti futuri: quelli
    storici restano col vecchio, ed è giusto, dicono chi li ha scritti.

17. **~~Il trigger a capitale fermo non è nel processo~~ — CHIUSO alle ~11:24 UTC dell'8 agosto 2026.**
    agent41 riavviato dall'operatore (restart 33 → 34); il log all'avvio dice «trigger capitale fermo
    ACCESO — soglia $50, controllo ogni 120s · non cancella niente, non ricalcola il piano».
    Il primo giro ha risposto come previsto: `data/realloc-ultimo-piano.json` lo scrive il primo ciclo
    completo, e fino ad allora il mini-ciclo non piazza. E comunque il bot è FERMO (punto 1).
    **Una riga di quel file è cambiata DOPO il riavvio** e aspetta il prossimo: `controlloCapitaleFermo`
    guardava il saldo *prima* di guardare se il bot è avviato — una HTTP più una lettura on-chain ogni
    120 s per una decisione già presa, ~720 al giorno a vuoto. Adesso i due cancelli gratuiti vengono
    prima. **Non urgente**: costa chiamate, non correttezza.

18. **~~La correzione del consumo di agent40 è in `main` ma non nel processo~~ — CHIUSO alle 12:07:06
    UTC dell'8 agosto 2026.** Riavvio eseguito dall'operatore (restart 52 → 53), dopo il commit `8f23d65`
    delle 12:02:15. **Misura di conferma:** agent40 sta ora fra **7,8% e 12,9%** di CPU, contro il 110%
    di prima. Il resto di questo punto resta come registro di cosa è stato corretto.

    Due difetti nello stesso percorso, entrambi corretti e misurati:
    - il **seek** in `lib/rewards/velocita-mercato.leggiCoda` partiva da `size − 128 MB` (tetto
      dimensionato per sei ore) invece che dalla finestra chiesta: con il giornale a 77 MB quel conto
      dà zero, quindi si leggeva tutto dall'inizio anche per quindici minuti. **524 ms → 32 ms**;
    - `cadenzaPer` chiamava `leggiFinestraMercato` **una volta per mercato**, e ogni chiamata costruisce
      la mappa di *tutti* i mercati per proiettarne uno. Ora c'è `leggiFinestraTutti`: una lettura per
      ciclo. **Il gate cadenza di un ciclo intero: 6.812 ms → 29-36 ms**, cioè da **136% a 0,6%** di un
      core, con 3,75 MB letti invece di 77.
    - e il test anti-regressione ha trovato un terzo punto che la diagnosi non aveva visto:
      `liquiditaMedia` è un'altra lettura per mercato, con finestra da **240 minuti**, sul percorso di
      riprezzo. Adesso passa da una mappa **pigra** — costa zero nei giri in cui nessuno riprezza.

    **Il risultato non cambia**, ed è provato: firma SHA-256 identica prima e dopo su 169 righe (13
    mercati × finestre 15/60/240 min, più `leggiVelocita` a 6 h su 130 mercati), calcolata su una copia
    congelata del giornale vero.

    **Il comando, ed è quello semplice:**
    ```bash
    pm2 restart agent40-manual-reprice
    ```
    Niente ricostruzione dell'ambiente come per agent41: agent40 **ha** il proprio caricatore di `.env`
    (righe 56-62), e un `restart` per nome non tocca la descrizione in memoria di pm2 — verificato dal
    riavvio delle 09:16, dopo il quale il processo aveva 95 variabili e tutte e quattro le critiche.

    **Perché contava anche a bot FERMO:** finché non si riavviava, un core su due restava occupato e il
    costo **cresceva durante la giornata** (il giornale cresce ~6,7 MB/h e si azzera a mezzanotte).
    Verso le 19:00 il file supera i 128 MB e il ciclo da 5 s avrebbe cominciato a slittare — cioè il
    motore che tiene gli ordini dentro la banda sarebbe arrivato tardi. Con il bot ora su AVVIA il
    riavvio è arrivato appena in tempo.

19. **IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre** (trovato l'8 agosto 2026,
    ~12:30 UTC, a bot già su AVVIA e con capitale reale collegato). Non è un guasto: è un buco fra due
    meccanismi che funzionano entrambi.
    - **Il ciclo fisso non si sposta.** `prossimoRitardo()` legge `lastRunAt` da disco: premere AVVIA
      non lo azzera e non anticipa niente. AVVIA alle 12:07, ultimo ciclo alle 10:16 ⇒ primo ciclo utile
      alle **16:16:26Z**, cioè **quattro ore dopo l'avvio**, con il capitale fermo nel frattempo.
    - **Il trigger a capitale fermo non può sostituirlo.** Scatta correttamente ($646,26 ≥ $50) ma il
      passo 1 di `miniCiclo` legge `data/realloc-ultimo-piano.json`, che **solo un ciclo completo
      scrive** (`agent41-realloc-scheduler.js:296`). Quel codice è nato alle 11:01 di oggi; l'ultimo
      ciclo completo è delle 10:16. Quindi il file non è mai esistito e il mini-ciclo esce con
      «nessun piano salvato finora» — registrato alle 12:09, 12:19, 12:31, 12:43.
    - **Si autorisolve** al primo ciclo completo e non si ripresenterà su questa macchina. Ma si
      ripresenta **identico** su un deploy pulito, dopo una cancellazione di `data/`, o ogni volta che
      il trigger venga usato per la prima volta. Il costo è una finestra fino a **6 ore** di capitale
      fermo dopo un AVVIA.
    - **Correzione non fatta e da decidere** (nessuna scritta: il turno era di sola diagnosi, poi di
      sola esecuzione). Le due candidate ovvie: far sì che `impostaBot({enabled:true})` azzeri
      `lastRunAt` — così AVVIA *è* l'innesco; oppure far scrivere l'ultimo piano anche al ciclo in
      anteprima a bot fermo, che è già ciò che il codice fa (`calcolaPiano` lo scrive sempre) e che
      quindi coprirebbe il caso da solo alla prima esecuzione post-11:01.

20. **L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano — ed è corretto, ma va
    saputo prima.** `.claude/hooks/blocca-piazzamento.js:71` blocca
    `(node|nodemon|npx|bash|sh|./)\s*\S*agent41-realloc-scheduler`. Quindi **una sessione Claude Code
    non può forzare un ciclo**, nemmeno con l'autorizzazione esplicita dell'utente in chat: l'hook non
    legge la chat. L'8 agosto 2026 è successo davvero, con l'operatore che aveva autorizzato in anticipo.
    **Non si aggira** (lo dice l'hook stesso). Il comando lo esegue l'operatore in un terminale, o con
    il prefisso `!` nel prompt:
    ```bash
    cd /root/rewards-bot && PID=$(pm2 pid agent41-realloc-scheduler) && \
    while IFS= read -r -d '' kv; do k=${kv%%=*}; \
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue;; esac; \
      case "$k" in [A-Z]*) export "$kv";; esac; \
    done < /proc/$PID/environ && node agents/agent41-realloc-scheduler.js --once
    ```
    La ricostruzione dell'ambiente **non è opzionale**: agent41 non ha il caricatore di `.env` (§5
    punto 3), e senza quel passo il ciclo parte senza `MANUAL_ORDER_PLACEMENT`, `MAKER_FUNDER_ADDRESS`,
    `KEY_CUSTODY_MASTER` e `DATABASE_URL`.
    **Va lanciato subito dopo uno scatto del trigger**, non a caso: il mini-ciclo del demone gira nello
    stesso capitale e il lucchetto `inCorso` è in-process, quindi non protegge da un secondo processo.
    Dopo uno scatto ci sono **10 minuti** di cooldown, che bastano con margine (il ciclo costa ~52 s di
    piano più il piazzamento). Gli scatti si leggono con
    `grep -a '"tipo":"mini-ciclo"' data/realloc-scheduler.jsonl | tail -1`.

21. **Il trigger a $50 non ha MAI funzionato — corretto in `main`, ASPETTA IL RIAVVIO DI agent41.**
    Dal momento in cui è nato, il mini-ciclo andava in `TypeError` a **ogni** scatto (ogni ~10 min per
    il cooldown): `Cannot read properties of null (reading 'inBand')`, `plan-to-orders.js:151`. Causa:
    la guardia con la truthiness di `find` descritta in §4, e la riga in testa al piano dell'8 agosto —
    «Will Matt Klein be the Democratic nominee for MN-02?» — che ha **`tick: null`**. Falliva **chiuso**
    (eccezione ⇒ nessun ordine, capitale fermo), quindi non ha mai messo a rischio capitale: ha solo
    reso la funzione inutile al 100%.

    Due correzioni, entrambe necessarie e nessuna delle due sufficiente da sola:
    - la **guardia** (`findIndex`), che trasforma l'esplosione in uno scarto dichiarato;
    - lo **scavalcamento della riga rotta** in `scegliMercato`, senza il quale il mini-ciclo si sarebbe
      limitato a rispondere «nessuna azione» per sempre, perché sceglie **un** mercato e non prova il
      successivo.

    Provato in isolamento su dati finti (`lib/maker/gamba-nulla-non-esplode.test.js`, 25/25) e in sola
    computazione sul **piano vero** salvato su disco: zero eccezioni sulle 6 righe, Matt Klein scartato
    con `gamba-impossibile`, le altre 5 costruiscono due gambe ciascuna.

    **ESEGUITO alle 15:19:15Z dell'8 agosto 2026** (restart 34 → 35, ambiente ricostruito da `/proc`:
    60 variabili prima e dopo, tutte e nove le critiche presenti). **Il trigger non esplode più**, e al
    primo scatto — 15:25:22Z, saldo $620,45, $237,91 già a riposo — ha fatto esattamente quello che deve:

    > `mini-ciclo: $120 rimessi al lavoro su 0xd15f77a9… (0 ordini piazzati, 1 rifiutati)`

    Ha scelto il morbillo, ha costruito le gambe, e la gamba YES è stata **rifiutata dalla rotaia
    `mai-primo-sul-libro`**: «un tick dietro il miglior bid altrui (24¢) darebbe 23¢, fuori dalla banda
    premiante [24¢–27¢]». **Nessun ordine piazzato, nessun capitale mosso** — il percorso che per un
    giorno intero andava in `TypeError` adesso arriva fino in fondo e si ferma dove deve. Gli ultimi
    `MINI-CICLO FERMATO` nel log di errore sono delle 15:19:15, cioè del processo vecchio.

    **Il comando usato (agent41 non ha il caricatore di `.env` — vedi punto 3):**
    ```bash
    cd /root/rewards-bot && PID=$(pm2 pid agent41-realloc-scheduler) && \
    while IFS= read -r -d '' kv; do k=${kv%%=*}; \
      case "$k" in NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|PM2_JSON_PROCESSING|PM2_USAGE|NODE_APP_INSTANCE) continue;; esac; \
      case "$k" in [A-Z]*) export "$kv";; esac; \
    done < /proc/$PID/environ && \
    pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler --update-env && pm2 save
    ```
    **Dopo il riavvio il trigger piazza davvero.** Simulato col saldo vero ($646,26) e con la mappa
    degli ordini a riposo VUOTA (ipotesi peggiore — interrogare il venue non era ammesso): il primo
    scatto utile allocherebbe **$120 sul mercato del morbillo** (`0xd15f77a921`), non i $28,15 liberati
    dalla gamba scaduta. Nella corsa vera `notionalePerMercato` sottrae gli ordini vivi, quindi la cifra
    sarà minore — ma **l'ordine di grandezza da aspettarsi è ~$100, non ~$30**.

22. **Tre cose che il fix ha scoperto — le prime due CHIUSE l'8 agosto sera, la terza no.**
    - **~~La rampa non conta niente~~ — CHIUSA.** `registraMercatoAperto` era esportata e non la chiamava
      nessuna riga del repo, quindi `mercatiDallAvvio` restava `[]` per sempre e `rampa()` rispondeva
      sempre «0/5, ne restano 5». Adesso il mini-ciclo la chiama per **ogni mercato aperto con successo**,
      e non è un dettaglio: da oggi quel giro può aprirne più d'uno in una volta, quindi contarli è la
      differenza fra una rampa e una decorazione.
      **E la chiamata ha aperto una finestra che andava chiusa nello stesso gesto:** il file è uno solo,
      quindi per aggiungere un mercato al contatore si riscrive anche `enabled` — e fra la lettura e la
      scrittura l'operatore può aver premuto FERMA, che verrebbe **annullata da un contatore**. Ora
      `registraMercatoAperto` rilegge prima di scrivere e rinuncia se l'istante dell'interruttore è
      cambiato: si perde un conteggio (recuperabile al giro dopo), non un FERMA (che non si recupera).
    - **~~Il mini-ciclo non guarda la rampa affatto~~ — CHIUSA.** `pianificaGiro` riceve `nuoviAmmessi`
      dal residuo della rampa e `mercatiGiaAperti`: un mercato già aperto non consuma un posto, uno nuovo
      sì, e quando i posti finiscono il giro **si ferma e lo dichiara** (`rampa esaurita: … sarebbe un
      mercato NUOVO`) invece di allentarsi per arrivare al 90%. È il Requisito 1.3 applicato: le
      protezioni esistenti vincono sul target di utilizzo.
    - **La premessa del saldo non regge alla misura.** L'header di `trigger-capitale-fermo.js` dice che
      un BUY a riposo immobilizza il collaterale, quindi «il saldo pUSD libero **è** il capitale non
      allocato». Misurato: alle 12:28 il saldo era `646,262868`; dopo aver piazzato ~$236 di gambe alle
      13:02, alle 13:49 era **ancora `646,262868`** (lettura fresca, `etaMs: 0`, `affidabile: true`).
      O il collaterale non viene immobilizzato come si crede, o la lettura non misura quel pool. Finché
      non si sa, il trigger sovrastima il capitale libero.

23. **~~Il tetto di orizzonte non basta: l'universo eleggibile è zero~~ — RISOLTO l'8 agosto 2026 sera,
    ASPETTA IL RIAVVIO DI agent24.** La causa non era un filtro: era la **paginazione**. Gamma tronca
    **qualunque** query a ~2.100 record (misurato: offset 2100 risponde vuoto sia sul listino intero sia
    su una finestra di tre giorni) e il listino `active=true&closed=false` è ordinato per `id`
    crescente, cioè **dal mercato più vecchio**. I mercati a scadenza rapida sono i più recenti: cadevano
    oltre il taglio e **non venivano mai chiesti**. Nessuna categoria era esclusa; nessuna era interrogata.

    **La correzione, e il tentativo sbagliato che l'ha preceduta.** La prima idea — una camminata unica
    `order=endDate&ascending=true` da adesso in avanti — è caduta nello STESSO tetto: i 2.100 posti si
    consumano tutti sui mercati più imminenti (sport e crypto senza montepremi) e la camminata non
    arriva mai alle ore utili. Misurato: 0 mercati premiati fra 6h e 36h. La finestra va **partizionata**,
    non percorsa: ogni fetta di 6 ore è una query con i **suoi** 2.100 posti. Le stesse ore, a fette,
    ne trovano 70.

    **ESEGUITO alle 15:10:28Z dell'8 agosto** (restart 3 → 4; agent24 non ha bisogno della
    ricostruzione dell'ambiente — usa solo API pubbliche, 31 variabili prima e dopo). Primo board nuovo
    scritto alle **15:18:53Z**. **Misurato sul board vero, prima → dopo:**

    | | prima | dopo |
    |---|---|---|
    | mercati sul board | 115 | 100 |
    | il più corto | **2,37 g** | **0,36 g** (8,6 ore) |
    | entro 1,5 g | **0** | **12** |
    | entro 7 g | 0 | 20 |

    La riga di scoperta: `21p listino (+636) · 120p in 7/8 fette da 6h (+100 nuovi entro 2g) · 5 fette
    al tetto dei 2.100: copertura PARZIALE · BUDGET ESAURITO a 120p → 736 mercati premiati`. Il board
    scende da 115 a 100 perché `MAX_CLOB_MARKETS` ne tiene 120 per montepremi: sono entrati i corti e
    usciti i lunghi meno ricchi.

    **Risultato in simulazione prima del riavvio (15:00Z): 66 mercati eleggibili** nella finestra `[0,25 · 1,5]`, contro
    zero. I più ricchi: `$87/g` e `$60/g` sui transiti di Bab el-Mandeb a 33,4h, `$53/g` sul box office
    di «The Odyssey», **`$51/g` e `$50/g` sui due HI-01 a 9,4 ore** — banda 4,5¢, esattamente l'archetipo
    dei 21. Il board vecchio ne aveva **115 con il più corto a 2,41 giorni**.

    **Il costo, misurato e da sapere:** la scansione passa da **21 pagine / ~14s** a **141 pagine / ~97s**,
    ogni 15 minuti — circa l'11% di ciclo utile contro il 2% di prima. Il budget di pagine
    (`REWARD_FAST_MAX_PAGES`, difetto 120) tiene il costo limitato; con la finestra a 2 giorni copre
    7 fette su 8, cioè fino a +42h, che è oltre il tetto di 1,5 g. **5 fette su 7 toccano comunque i
    2.100**: la copertura resta parziale e il log lo **dichiara** a ogni scansione invece di lasciarlo
    dedurre.

    **Cosa NON entra — e la ragione NON è il pavimento, misurato l'8 agosto sera.** Questo punto diceva
    che i crypto «Up or Down» a 5 minuti (fino a **$833/giorno**) restano fuori perché scadono sotto le
    6 ore e cadono sotto `MIN_HORIZON_DAYS`. La misura dice qualcosa di più semplice: **nell'universo
    premiante delle prossime 48 ore i mercati crypto sono ZERO**, e nel campione dei 21 maker solo
    **3 ingressi su 44** su crypto erano su un mercato che paga davvero — gli altri 35 `btc-updown-5m`
    hanno `montepremi 0`. Abbassare il pavimento non produrrebbe niente da prendere.
    I tre premianti riportano `rewardsDailyRate: 10000` **senza banda pubblicata**
    (`rewardsMaxSpread: 0`): la formula del venue `S(v,s)=((v−s)/v)²` è indefinita con `v=0`, e
    `agent24-liquidity-rewards.js:190` li scarta correttamente. Il pavimento resta una decisione
    dichiarata, ma non è lui a tenere fuori il crypto. Vedi `data/ricerca-categorie-21-wallet.md` §4.3.

24. **IL 10 AGOSTO ALLE 01:01:33Z IL RESET CANCELLA TUTTO, se il board non è aggiornato per allora.**
    Non è un'ipotesi: è aritmetica su due costanti e un calendario.
    - `HORIZON_MIN_HOURS = 24` (`lib/maker/market-validity.js:28`): un mercato in gestione a meno di 24
      ore dalla risoluzione diventa `in-scadenza`, cioè **non valido**, e il trigger di **validità**
      scatta.
    - «Will Matt Little be the Democratic nominee for MN-02?» ha `endDate 2026-08-11T00:00:00Z`. Diventa
      `in-scadenza` alle **2026-08-10T00:00:00Z**.
    - I cicli cadono ogni 6h da 13:01:33Z: il primo dopo quella soglia è **2026-08-10T01:01:33Z**.

    A quel giro il reset gira. Se il board è ancora quello vecchio il piano fresco ha **zero righe**, e
    `runAllocationReset` con `rows: []` **cancella i tre mercati in gestione e non piazza niente**. La
    guardia «universo vuoto» non protegge: `universe.evaluated` si conta PRIMA del filtro orizzonte,
    quindi il ciclo legge un piano magro e non cieco.

    **Il riavvio di agent24 disinnesca lo scenario** — con 66 mercati eleggibili il piano non è più
    vuoto. È la ragione per cui quel riavvio è la cosa più urgente in questo file.

25. **La misura che ha fatto scattare tutto, tenuta come riferimento.** Prima dell'allargamento, l'8
    agosto 2026: board di **115 mercati, il più corto a 2,41 giorni**, e il pianificatore vero
    sull'universo vero rispondeva `evaluated 114 · chosen 0` — 114 candidati scartati per scadenza.
    Serve a poter dire fra un mese se il canale delle scadenze vicine è ancora aperto: se il board
    torna ad avere il minimo sopra i due giorni, la seconda passata ha smesso di funzionare.

26. **~~DUE POSIZIONI APERTE SENZA VIA D'USCITA~~ — CHIUSO alle 16:49:18Z dell'8 agosto 2026** (riavvio
    di agent40 eseguito dall'operatore, restart 53 → 54). **Verificato sui dati vivi, non per test:**
    alle **16:49:27Z**, trentanove secondi dopo il riavvio, l'uscita di Matt Little è passata — SELL
    YES 32,27 @ 0,81, ordine `0x23277f14…`, `status: live`, nozionale $26,14. Il rifiuto
    `reject-live-min-market-mismatch` che si ripeteva ogni 60 s è sparito dal registro. È la conferma
    sui dati vivi che §5 punto 30 diceva sarebbe arrivata dai log del primo ciclo.
    La correzione era l'**eccezione di riduzione**
    (`evaluateReductionProof`, `lib/venues/polymarket-clob-maker/adapter.js`): un ordine che *toglie*
    esposizione non è più vincolato alla allowlist live-min, che governa dove si può *aprire*.
    - **La prova è positiva, mai per difetto**: serve lato `SELL`, size detenuta **letta** dallo
      snapshot del venue (fresco, `MAX_AGE_MS`) e `size ≤ detenuto`. Possesso illeggibile, zero o
      snapshot scaduto ⇒ nessuna eccezione e il gate si comporta come prima. Un errore di lettura non
      può allargare niente.
    - **I BUY restano vincolati**, e per scelta: comprare il secondo lato riduce il *rischio* ma
      aumenta il *capitale impegnato*, che è esattamente ciò che la allowlist esiste per impedire su un
      mercato che nessun umano ha abilitato. Un fill su un mercato uscito dalla allowlist si gestisce
      **uscendo**, non impegnando altri soldi. Il merge resta vivo dove l'operatore ha abilitato.
    - **Non è stato allargato niente**: 15 asserzioni coprono la non-regressione, fra cui «ingresso su
      mercato fuori allowlist: ancora bloccato» e «SELL più grande del posseduto: bloccato».
    - L'eccezione **lascia traccia**: `outcome: 'allow-live-min-reduction'` nell'audit dell'adapter, così
      «era in allowlist» e «siamo passati perché stavamo riducendo» restano contabili separatamente.
    *(Il testo originale del punto resta qui sotto come registro di com'era.)*

    Due registri distinti governano la stessa posizione, e uno solo dei due ruota:
    - `data/maker-auto-close.json` dice **se** una posizione ha diritto all'uscita automatica — 22
      mercati abilitati, fra cui entrambi quelli qui sotto;
    - `data/maker-auto-reprice.json` (`enabledMarketIds`, letto da `lib/maker/config.js:45-51`) è la
      **allowlist live-min** che `placeManualOrder` applica come restrizione dura a **ogni** ordine,
      uscite comprese. Il **reset di agent41 la riscrive** a ogni riallocazione.

    Le posizioni però **sopravvivono alla riallocazione**. Quando il reset ruota i mercati, ogni
    posizione lasciata indietro conserva il diritto di uscire e perde il permesso di piazzare:

    | | posizione | uscita rifiutata da |
    |---|---|---|
    | Matt Little MN-02 `0x822409` | 32,27 YES @ 0,80 (**$25,82**) | **15:57:18Z**, dopo il reset delle 15:41 |
    | Schwartzel FL-19 `0xc16fade4` | 22,20 NO @ 0,5177 (**$11,49**) | **15:36:27Z**, già prima del reset |

    Il rifiuto è testuale e si ripete **ogni 60 s**: `reject-live-min-market-mismatch` — «this order is
    for market 0x…, which is NOT on the enabled list (4 market(s): …). Enable it deliberately from the
    allocation panel first. Refusing.» La allowlist di adesso è
    `0xd25c820d…, 0x9cb9e4b0…, 0xc3999e22…` più il pin `0x12dc2b61…`: **nessuno dei due mercati con
    posizione aperta**.

    **Che l'uscita non sia sul libro non è dedotto**: `runAutoCloseCycle` esce con `already-covered`
    quando un ordine di copertura esiste (`auto-close.js:365`), e invece **ritriggera a ogni giro** —
    16:02:32 l'ultimo visto. Su Matt Little le due uscite riuscite sono delle **14:50:54Z** e
    **15:14:09Z** (a `0,81` = carico 0,80 +1%, l'`82¢` osservato dall'operatore); dopo il reset non ne
    passa più una.

    **Fallisce nella direzione sbagliata.** Il commento di `auto-close.js:98-101` dichiara il criterio
    giusto — «questa funzione non apre esposizione, la chiude: rifiutarsi di chiudere per un dato
    mancante lascerebbe capitale bloccato» — ma il gate live-min sta **a valle**, in `placeManualOrder`,
    dove quella distinzione non esiste: tratta un'uscita come un ingresso. **Nessuna correzione è stata
    scritta** (turno di sola diagnosi). La direzione: esentare dalla allowlist gli ordini di **riduzione**
    su una posizione realmente detenuta — non allargare la allowlist, che riaprirebbe anche gli ingressi.

27. **~~I Livelli 1 e 2 non sono mai stati raggiunti~~ — CHIUSO alle 16:49:18Z dell'8 agosto 2026.**
    Il riavvio ha armato tutti e quattro i fix, e il registro lo dimostra riga per riga: dal primo
    ciclo Matt Little scrive `merge-livello-2` con `askLetta: true` e `attesaMin` popolabile — cioè la
    scala ask **viene letta davvero** (`readDepth` iniettato) e il motivo in audit non è più una
    conclusione non misurata. Alle **17:06:23Z**, appena la allowlist ha smesso di rifiutare, l'esito è
    diventato `merge-livello-2-piazzato`. Cosa era stato scritto, oltre ai quattro fix elencati sotto:
    - **il ramo che ESEGUE i Livelli 1 e 2 non esisteva e ora esiste** (`auto-close.js`). Era il difetto
      che nascondeva gli altri: accendere `MERGE_STRATEGY_ENABLED` da solo avrebbe cambiato **solo la
      stringa nell'audit**, facendogli dichiarare eseguito ciò che non accadeva;
    - il ramo si innesta **dove auto-close stava per piazzare l'uscita ordinaria**, cioè al posto del
      Livello 3, e **non** sui percorsi urgenti: mercato chiuso, mercato che non accetta ordini,
      posizione già coperta e chiusura forzata a mercato passano prima e restano intatti;
    - **non si fanno le due cose insieme**: o si piazza il completamento e si salta l'uscita, o si
      rinuncia e si lascia proseguire il Livello 3. E se al timeout la cancellazione del completamento
      fallisce, **non si vende** — comprare e vendere insieme è il guasto peggiore dei due;
    - `readDepth` iniettato in `closeTask`, `attesaDaMs` passato con un registro **su disco**
      (`data/merge-attese.json`: un'attesa di 60 minuti che si azzera a ogni riavvio non è un timeout),
      e `askLetta` che distingue in audit «non l'ho letta» da «l'ha letta ed è cara»;
    - **senza registro il merge non parte affatto** (fail-closed esplicito): senza orologio il Livello 2
      non avrebbe scadenza e ripiazzerebbe il completamento a ogni ciclo.
    *(La diagnosi originale resta qui sotto: è il registro di come ci si è arrivati.)*
    - **Niente viene eseguito, a nessun livello.** `MERGE_STRATEGY_ENABLED = false`: `auto-close.js:341-353`
      **calcola** il livello e lo scrive in audit come `merge-livello-N-osservato`, poi prosegue con
      l'uscita classica. Entrambe le posizioni sono a **Livello 2 osservato**, riscritto ogni 60 s. La
      vendita d'uscita non è quindi «il Livello 3 dopo che 1 e 2 hanno fallito»: è **l'unico percorso
      vivo**, e sarebbe partita identica in ogni caso.
    - **Il Livello 1 non è nemmeno valutabile.** `auto-close.js:339` legge la scala ask da
      `deps.readDepth`, che **il chiamante non inietta**: nel blocco deps di `closeTask`
      (`agent40-manual-reprice.js:440-502`) `readDepth` non c'è — è iniettato solo nel ciclo
      *mm-tracking* (riga 858). Quindi `asksAltroLato` è **sempre `null`**, `quantoAlVolo` restituisce
      `size: 0` per «array assente» esattamente come per «tutti gli ask sopra il tetto», e si cade al
      Livello 2 **a prescindere dal prezzo vero**. Non è staleness: **il dato non viene proprio chiesto.**
    - **E l'audit afferma una cosa che non ha misurato.** Il motivo registrato — «l ask di NO e' sopra
      il tetto di 19.0¢» — è una **conclusione non misurata**: `quantoAlVolo` non distingue i due casi e
      `decidiLivello` emette lo stesso testo per entrambi. È il difetto più insidioso dei tre, perché
      rende invisibile in audit proprio il dato mancante. Il fix minimo è distinguere
      `asksAltroLato == null` (→ «scala ask non disponibile») da «letta e tutta sopra il tetto».
    - **Il timeout di 60 minuti non può scattare.** `attesaDaMs` non è mai passato da `auto-close.js`,
      quindi `attesaMin` resta `null` e il ramo di `strategia-merge.js:218-224` non è raggiungibile.
      Coerente con l'osservato: `"attesaMin": null` su tutte le righe.
    - **La gestione manuale NON è esclusa dalla gerarchia — è il suo prerequisito.** `auto-close.js:273-276`
      salta il mercato quando **non** è in gestione manuale («la chiusura automatica agisce solo dove il
      mercato è in gestione manuale»). Entrambi i mercati sono `manual: true`, ed è per questo che
      vengono valutati. La risposta alla domanda su Schwartzel è quindi: **è sempre stato dentro la
      gerarchia**, con lo stesso esito di Matt Little.
    - **Ordine di correzione**, se si vorrà: prima il punto 26 (capitale esposto), poi il messaggio
      d'audit (fa credere misurato ciò che non lo è), poi `readDepth`. Accendere
      `MERGE_STRATEGY_ENABLED` resta una **decisione dell'operatore** e non è implicata da nulla di
      quanto sopra: senza merge on-chain, completare la coppia immobilizza capitale invece di liberarlo.

28. **~~IL RIAVVIO DI agent40 ARMA UN COMPORTAMENTO NUOVO SU CAPITALE REALE~~ — ESEGUITO alle
    16:49:18Z dell'8 agosto 2026** (restart 53 → 54). Il comportamento nuovo si è manifestato entro
    diciassette minuti e con la cifra prevista: **$6,13** di capitale nuovo su Matt Little (§5 punto 31).
    Il testo resta come registro di cosa è stato armato — e di cosa vale ancora.
    `pm2 restart agent40-manual-reprice` (forma semplice: agent40 **ha** il proprio caricatore di `.env`,
    righe 56-62, a differenza di agent41 — §5 punto 3). Da quel momento e senza altre conferme:
    - **un fill su un lato solo fa COMPRARE il secondo lato**, su qualunque mercato in gestione manuale
      *e* dentro la allowlist live-min. È il primo BUY autonomo di questo stack: auto-close finora
      piazzava solo SELL. La spesa è limitata per costruzione (size ≤ posizione detenuta, prezzo ≤ tetto
      della coppia, quindi al più ~`(1 − carico) × size`), ma è capitale nuovo;
    - **il capitale così impegnato NON torna subito.** `CTF_RELAYER_ENABLED` è ancora `false`: senza
      merge on-chain la coppia paga $1 **alla risoluzione**, non adesso. Il profitto è matematico e
      indipendente da chi vince; la liquidità no. È la premessa su cui la decisione è stata presa;
    - contemporaneamente si attivano l'eccezione di riduzione (punto 26) e i quattro fix del punto 27.
    **Spegnere:** rimettere `false` a `lib/maker/strategia-merge.js` e riavviare. Non esiste una env che
    lo governi, deliberatamente — due interruttori per una decisione sola vogliono dire che spegnerne
    uno non la spegne.

29. **IL LIVELLO 1 (TAKER) NON PUÒ ESEGUIRE, ed è una protezione che NON è stata toccata.**
    `manual-order.js:1017` — `const attraversaApposta = lato === 'SELL' && spec.attraversaApposta === true`:
    l'eccezione all'anti-incrocio vale **solo in vendita**, perché «un acquisto aggressivo APRE
    esposizione: per il BUY la regola resta assoluta» (riga 1008). Il Livello 1 è un BUY aggressivo,
    quindi il gate lo rifiuta.
    - **Non è stato allentato**: allargare l'eccezione ai BUY è una decisione dell'operatore su una
      protezione esplicita, non un dettaglio implementativo.
    - **La gerarchia regge lo stesso**: il Livello 1 si tenta, e quando viene rifiutato si degrada al
      **Livello 2 nello stesso ciclo** — non precipita al Livello 3. La coppia resta completabile, solo
      più lentamente e da maker.
    - **Il Livello 2 è prezzato per RIPOSARE**: `min(tetto, migliorAsk − tick)`, arrotondato giù al tick.
      Prezzare al tetto secco lo avrebbe fatto incrociare e rifiutare esattamente come il Livello 1 —
      trovato in simulazione, non in produzione.
    - **Da decidere:** se si vuole il Livello 1 vero (prendere l'ask conveniente prima che sparisca),
      la riga da discutere è quell'eccezione, non il codice del merge.

30. **Verifica del gate fatta per test unitario, non sui dati vivi — e per una ragione buona.**
    L'hook `.claude/hooks/blocca-piazzamento.js` blocca qualunque comando che faccia `require`
    dell'adapter, anche in sola lettura: non può sapere che quella valutazione non piazzava niente.
    Non è stato aggirato. La copertura è quindi: **verdetti dei livelli** calcolati sui dati veri
    (posizioni dal venue + book live di agent34), **decisione del gate** provata da 15 asserzioni sui
    casi esatti di queste due posizioni. **La conferma sui dati vivi è arrivata** alle 16:49:27Z e alle
    17:06:25Z — vedi i punti 26 e 31: il gate si comporta esattamente come le 15 asserzioni dicevano.

31. **I DUE MERCATI CON POSIZIONE APERTA SONO TORNATI NELLA ALLOWLIST — 17:05:30Z dell'8 agosto 2026,
    su richiesta esplicita dell'operatore.** Scritti con `setAutoReprice` (lo stesso meccanismo del
    pannello e del riallocatore, nessun formato inventato) in `data/maker-auto-reprice.json`, con audit
    in `data/maker-auto-reprice-audit.jsonl`. La allowlist passa da **3 a 5** mercati:
    `0xc16fade4…` (Schwartzel FL-19) e `0x822409…` (Matt Little MN-02).
    - **Nessun riavvio è servito, e non è una fortuna:** il gate legge la lista **una volta per
      piazzamento** da disco (`adapter.js:405-419`, «un controllo che ha bisogno di un riavvio non è un
      controllo»). Misurato: scrittura alle 17:05:30, primo effetto alle **17:06:23**, cioè al ciclo di
      60 s successivo.
    - **Effetto misurato, con la cifra esatta.** Matt Little è passato in un solo ciclo da
      `merge-livello-2-reject-live-min-market-mismatch` a **`merge-livello-2-piazzato`**: BUY **NO 32,27
      @ 0,19**, nozionale **$6,1313**, ordine `0x83de2c71e01f…`, `status: live` alle 17:06:25.334Z.
      Il prezzo è il tetto della coppia (100 − 80 − 1 = 19¢) e non l'ask meno un tick (20¢), perché il
      minimo dei due è il tetto. `data/merge-attese.json` ha registrato l'attesa: al ciclo dopo l'esito
      è `merge-in-attesa` e **non** un secondo ordine.
    - **Il capitale nuovo impegnato è $6,13, e non torna liquido prima della risoluzione** (11 agosto
      per MN-02): senza merge on-chain la coppia paga $1 alla scadenza. È la premessa del punto 28.
    - **NON È DUREVOLE.** Il reset di agent41 rispegne ogni mercato abilitato che il piano non contiene
      (`allocation-reset.js:258`). Ultimo ciclo completo **15:41:31Z**, quindi il prossimo cade attorno
      alle **21:41:31Z**: se a quel giro i due mercati non sono nel piano — e non lo saranno, non hanno
      montepremi interessante — tornano fuori allowlist. L'uscita automatica invece **resta accesa**
      perché il reset la spegne solo su mercati senza posizione. Se la riabilitazione deve sopravvivere
      al reset, la riga da cambiare è quella, non questo file.

32. **~~SCHWARTZEL NON COMPLETA LA COPPIA: `closeTask` NON INIETTA `cancelOrder`~~ — CORRETTO in `main`
    l'8 agosto 2026 sera, ASPETTA IL RIAVVIO DI agent40** (§5 punto 34). Due correzioni, entrambe
    necessarie e nessuna sufficiente da sola:
    - **il bug tecnico**: `closeTask` ora inietta `cancelOrder` (la stessa funzione degli altri due cicli
      di agent40, con la sua etichetta di origine). Tre percorsi lo aspettavano — chiusura forzata,
      timeout del Livello 2 e, da oggi, il completamento della coppia — e tutti e tre ricevevano
      `undefined`, che diventava `null`, che diventava «ignoto»;
    - **la priorità logica**: la chiusura forzata non salta più il merge. Dopo che le cancellazioni sono
      confermate — quindi con la posizione già scoperta, senza incrociare niente — si tenta il
      completamento come **ultimo tentativo**, e solo se rinuncia si vende al bid. Non è un rinvio senza
      fine: se il completamento va a riposo parte l'orologio dei 60 minuti e alla scadenza si vende.
    - Il caso di Schwartzel non è più riproducibile sui dati vivi (posizione chiusa dall'operatore alle
      ~17:20 col KILL), quindi la verifica è per test: `capitale-al-lavoro.test.js` allestisce
      esattamente quella situazione — uscita a riposo da 25 ore, ask del secondo lato dentro il tetto —
      e verifica che si compri invece di vendere, e che senza cancellatore non si faccia **né** l'uno
      **né** l'altro.
    *(La diagnosi originale resta qui sotto: è il registro di come ci si è arrivati.)*

    Il Livello 1 su `0xc16fade4` era
    calcolato **e conveniente** — «l ask di YES sta entro il tetto: 22,2 share a 47,0¢ medi su 1
    livello · la coppia costa **98,8¢**» — e non viene mai tentato.
    - **Perché.** Il ramo del merge sta in `auto-close.js:467`, **dopo** la chiusura forzata a mercato
      (`d.action === 'close-at-market'`, riga 400), che fa `continue`. Su Schwartzel il trigger
      `max-wait` è scattato (uscita a riposo da 24,5h, tetto 24h), quindi la chiusura forzata vince —
      ed è per costruzione, non per errore: «una chiusura che deve eseguire adesso non viene mai
      rimandata da un merge».
    - **E lì si ferma.** La chiusura forzata cancella le uscite a riposo prima di vendere, e
      `deps.cancelOrder` **è `undefined`** in `closeTask` (`agent40-manual-reprice.js:479-556`: inietta
      `killStatus`, `isManual`, `resolveRules`, `readDepth`, `attesaMerge`, `listOrders`,
      `readPositions`, `placeOrder`, `rimpiazzaGamba`, `audit` — non `cancelOrder`). Le righe 797 e 919
      lo iniettano, ma sono il ciclo di riprezzo e quello di mm-tracking. Esito: `exit-cancel-failed`
      con motivo `ignoto`, ogni 60 s, **da 24,5 ore**.
    - **Falliva nella direzione sicura** — non vendeva — ma la posizione restava ferma senza che nessuno
      dei due percorsi la chiudesse. All'epoca non era stato corretto perché iniettare `cancelOrder` da
      solo avrebbe armato una **vendita a mercato** di 22,20 NO al bid, cioè l'opposto di completare la
      coppia. La correzione dell'8 agosto sera risolve proprio quel dilemma: si inietta il cancellatore
      **e** si mette il merge davanti alla vendita, quindi il ramo arriva in fondo *completando*.

33. **La stessa guardia, un ramo più in là: `null` non è una cancellazione riuscita** — corretto in
    `main` l'8 agosto 2026, **aspetta il prossimo riavvio di agent40**. Al timeout del Livello 2
    (`auto-close.js:572`) il codice cancella il completamento e solo allora vende, e lo dichiara in tre
    righe di commento. La guardia era `if (c && c.ok === false)`: con `cancelOrder` non iniettato
    `c` vale **`null`**, che è falsy, quindi si scendeva a **vendere il primo lato con il BUY di
    completamento ancora sul libro** — il «comprare e vendere insieme» che quel commento dice di voler
    impedire. Il ramo gemello della chiusura a mercato (riga 408) tratta `null` come fallimento da
    sempre: le due guardie ora sono allineate (`if (!c || c.ok === false)`), e l'attesa non viene
    ripulita, così non se ne apre una seconda al giro dopo.
    - **Era il 100% della produzione, non un caso di laboratorio** (punto 32).
    - **Diventava raggiungibile alle ~18:06Z di oggi**, sessanta minuti dopo il completamento delle
      17:06 su Matt Little. Con il processo ancora sul codice vecchio la vendita d'uscita, a quel giro,
      viene comunque rifiutata da `idempotent-duplicate` — è una coincidenza fortunata, non una
      protezione, ed è la ragione per cui la correzione è stata scritta subito.
    - Coperto da `lib/maker/merge-livelli-vivi.test.js` (64/64), caso `5f-bis`.
    - **Riavvio non chiesto e non eseguito** allora; adesso rientra nei tre del punto 34.
    - **L'8 agosto sera la stessa guardia è stata portata dentro `completaCoppia`**, che è l'unico posto
      da cui i tre rami cancellano: la regola «`null` non è una cancellazione riuscita» vive ora in una
      funzione sola invece che ripetuta in tre punti che potevano divergere.

34. **~~TRE RIAVVII PENDENTI~~ — ESEGUITI DALL'OPERATORE alle 18:30:52 / 18:31:02 / 18:31:16 UTC
    dell'8 agosto 2026** (agent40 54 → 55, dashboard 169 → 170, agent41 35 → 36), circa venti minuti dopo
    il commit `2cb8f39`. **Il lavoro del «capitale al lavoro» è nei processi.** Verificato dal log
    d'avvio di agent41, che dice esattamente cosa è entrato in servizio:

    > `trigger capitale fermo ACCESO — soglia $50, controllo ogni 120s · non cancella niente, rilegge
    > AVVIA/FERMA e il kill a ogni controllo · obiettivo di utilizzo 90%, fino a 6 mercati per giro · se
    > il piano salvato manca, è vecchio (> 60 min) o non ha spazio, RICALCOLA (piano leggero a 6h)`
    > `sorveglianza dell'interruttore ACCESA — controllo ogni 15s: un AVVIA fa partire un mini-ciclo
    > forzato entro ~2 minuti`

    **E il cancello del kill si vede lavorare sui dati veri.** Prima del riavvio il log ripeteva
    `TRIGGER capitale fermo — capitale liquido fermo $668.25 ≥ soglia $50.00` seguito da
    `mini-ciclo: $84 rimessi al lavoro … (0 ordini piazzati, 0 rifiutati)`: il giro arrivava in fondo e
    ogni gamba veniva poi rifiutata a valle dal kill. **Dopo il riavvio: zero mini-cicli**, perché il
    kill è letto prima del saldo. È la conferma sui dati vivi di ciò che il test provava in isolamento.

    *(La tabella qui sotto resta come registro di cosa è stato deployato.)*

    | processo | cosa entra in servizio | comando |
    |---|---|---|
    | `agent40-manual-reprice` | `cancelOrder` iniettato in `closeTask`; la gerarchia del merge senza scorciatoie (`already-covered` e `close-at-market` tentano la coppia); il Livello 1 preso anche durante l'attesa | `pm2 restart agent40-manual-reprice` |
    | `agent41-realloc-scheduler` | ricalcolo leggero; mini-ciclo multi-mercato; obiettivo di utilizzo; rampa contata; kill come cancello; sorveglianza dell'AVVIA | ricostruire l'ambiente da `/proc` — **§5 punto 3** |
    | `dashboard` | la rotta `GET /api/maker/utilizzo-capitale` | `pm2 restart dashboard` (verificare PRIMA `.next/prerender-manifest.json` — §5 punto 7) |

    **agent40 e dashboard prendono la forma semplice**; **agent41 no**: non ha il caricatore di `.env` e
    un `restart` per nome gli farebbe perdere 63 variabili fra cui `DATABASE_URL` e
    `MAKER_FUNDER_ADDRESS`. Il comando completo, già usato due volte con successo, è nel punto 3.

    **Cosa cambia il giorno in cui il KILL viene tolto e il bot torna su AVVIA**, e va saputo prima:
    entro ~35 secondi dal click il mini-ciclo forzato ricalcola e piazza su **più mercati insieme** —
    misurato in simulazione, $507 su 6 mercati con l'universo vero di stasera, cioè utilizzo **0% →
    75,9%** in un giro solo. Prima era «un mercato ogni dieci minuti, e solo se il piano salvato lo
    conteneva». È il comportamento che i sei requisiti chiedono, ma è un raggio d'azione più largo di
    quello di ieri e la prima volta va guardato.

35. **Il 75,9% e non il 90%: il target non si raggiunge sempre, ed è il punto.** Misurato in simulazione
    sull'universo vero dell'8 agosto sera con $668,25 liberi: il ricalcolo leggero trova 6 mercati
    ammissibili e il giro si ferma a **$507 (75,9%)**, non perché una protezione abbia morso ma perché
    il tetto di 6 mercati per giro e i tetti per mercato non lasciano altro spazio *in quel giro*. Il
    giro successivo riparte dal residuo. Su un piano finto con più righe lo stesso codice arriva a
    **90,0% esatti** lasciando $66,82 liquidi. Le due misure insieme sono la prova che il target è un
    metro e non una forzatura: quando i mercati bastano ci arriva, quando non bastano si ferma e lo
    dichiara (`utilizzo 19,5% sotto l'obiettivo 90%: mancano $471,43 …`).

36. **`REALLOC_PIANO_LEGGERO_ORE` è il primo parametro che governa quanta memoria consuma un figlio.**
    A 6h il piano di prova costa 208-254 MB; a 48h ne costa 1074-1086. Il figlio non è soggetto al tetto
    pm2 di agent41 (400 MB) perché è un processo suo — è la correzione del 4 agosto — ma su una macchina
    con 2 vCPU e altri undici processi vivi la differenza è reale. Se un giorno il ricalcolo leggero
    diventasse frequente (oggi è protetto dal cooldown di 10 minuti), è il numero da guardare per primo.

37. **LA RICERCA SULLE CATEGORIE È FATTA, E RIBALTA LA LETTURA OVVIA** (8 agosto 2026 sera — report
    completo in `data/ricerca-categorie-21-wallet.md`, rifacibile con
    `node scripts/ricerca-categorie-21.js --universo`, sola lettura).

    **Il campione**: 450 ingressi dei 21 maker in 31 ore (erano 299), 20 wallet, 441 mercati, 133
    famiglie. Classificatore in `lib/rewards/categoria-mercato.js` — **puro, e nessun modulo di `lib/`,
    `agents/` o `app/` lo importa**: è uno strumento di misura, non una regola del motore, e un test lo
    verifica camminando l'albero dei sorgenti. Copertura: **0 non classificati su 450 e su 112**;
    accordo con il campo `category` di Gamma sul board: **95/95 = 100%**.

    **Il fatto che riorienta tutto: solo 40 ingressi su 450 (8,9%) sono su mercati che pagano premi.**
    I 21 entrano per il **77% su sport**, ma di quei 345 ingressi ne pagano **6 (1,7%)**. Il resto è un
    mestiere diverso da quello di questo bot. Il confronto giusto col board è con i **40 premianti**:

    | categoria | 21 · tutti | 21 · premianti | board | universo premiante 0-48h |
    |---|---|---|---|---|
    | sport | 77,0% | 15,0% | 8,9% | 3,2% |
    | crypto | 9,8% | 7,5% | — | **zero** |
    | finanza-aziende | 6,7% | **27,5%** | 6,3% | 0,5% |
    | cronaca-eventi | 3,8% | **25,0%** | 12,5% | 18,9% |
    | meteo | 2,0% | 17,5% | **39,3%** | **73,3%** |
    | politica (elez. + locali) | 0,7% | 7,5% | 33,0% | 1,4% |

    **Il pattern più importante è di ORIZZONTE, e tocca una costante viva:** gli ingressi **premianti**
    hanno un orizzonte mediano di **21,4 ore**, i non premianti di **2,2 ore**. `MIN_HORIZON_DAYS = 0,25`
    (6 ore) è tarato sulla mediana 0,22 g dell'insieme COMPLETO, cioè su una popolazione che per il 91%
    non paga premi. **Non è stato cambiato niente** — tocca l'allocazione di capitale reale, quindi è
    una decisione dell'operatore (R1 del report). Da guardare con più dati: oggi n=40.

    **La ripetizione è forte ma nel posto sbagliato:** 20 famiglie coprono il **60,3%** degli ingressi
    (441 mercati distinti su 133 famiglie — tornano sulla *serie*, mai sullo stesso mercato). Ma nel
    sottoinsieme premiante quasi tutte le famiglie hanno un solo ingresso: una watchlist aiuterebbe
    l'attività NON premiante molto più di quella premiante.

    **Le tre cose da sapere sul board, e due sono assoluzioni:**
    - **meteo non è sovra-pesato**: sembra +21,8 contro i 21, ma è **−34** contro ciò che esiste
      (39,3% board vs 73,3% universo). Il board sta già selezionando. Nessuna azione.
    - **finanza-aziende (−21,3) è strutturale, con un dettaglio azionabile**: nell'universo 0-48h esiste
      UN solo mercato di finanza premiante. Ma gli 11 ingressi premianti dei 21 sono la famiglia
      `<ticker>-up-or-down-on-<data>` ($20-200/g, affollamento mediano **3**, il più basso del campione)
      — che esiste **solo nei giorni di borsa e per poche ore**, e scade fra **2,6 e 8,0 ore**, cioè a
      cavallo del pavimento. Il bot non l'ha mai vista. R2 del report: una watchlist di famiglie
      interrogate per slug, additiva alla scoperta. **Non implementata**, perché è in tensione con R1:
      scoprirla senza decidere il pavimento vorrebbe dire pescare mercati che il filtro dopo scarta.
    - **cronaca-eventi (−12,5) è l'unico scarto dove i tre numeri concordano**: offerta 18,9%, i 21 al
      25,0%, board al 12,5%. È la candidata più pulita per un peso maggiore. Tocca il punteggio di
      selezione ⇒ decisione dell'operatore.

    **Nessun peso, filtro o soglia è stato modificato in questa sessione.** L'unica correzione applicata
    è al testo del punto 23 qui sopra, che attribuiva al pavimento un'assenza che è strutturale.

38. **LE OTTO FASI DELL'8 AGOSTO SERA — IN `main`, E ASPETTANO QUATTRO RIAVVII.** Il bot è su KILL con
    conto piatto, quindi nessuna di queste modifiche può muovere capitale finché il kill resta. Ogni
    fase ha il suo commit.

    | # | cosa | dove |
    |---|---|---|
    | 1 | pavimento orizzonte **0,25 → 0,75 g** (18 h) | `lib/rewards/horizon.js` |
    | 2 | punteggio **rischio/beneficio** ordinabile | `lib/rewards/rischio-beneficio.js` (nuovo) |
    | 3 | decisione di riprezzo **guidata dal feed** anche sui lenti | `lib/maker/cadenza-adattiva.js` |
    | 4 | **mid stantio**: 20 s, poi l'ordine si ritira | `lib/maker/mid-stantio.js` (nuovo) |
    | 5 | fill: riequilibrio e merge **senza conflitti** | `lib/maker/auto-close.js` |
    | 6 | cadenza operativa del trigger **10 min**, invariante contro la scoperta | `lib/maker/trigger-capitale-fermo.js` |
    | 7 | **caricatore `.env`** su tutti e quattro i processi critici | `agents/agent35,41,43` *(agent35 rimosso il 9 agosto 2026 — §5 punto 63)* |
    | 8 | **backoff** distinto per 429 e **verifica dopo l'ambiguo** | `lib/maker/backoff-venue.js` (nuovo) |

    **Fase 1 — il pavimento era tarato sulla popolazione sbagliata.** 0,25 g veniva dalla mediana di
    0,22 g di TUTTI gli ingressi dei 21; la ricerca del punto 37 ha mostrato che il 91% di quelli non
    paga premi. Sui soli premianti la mediana è **22,7 h**. 18 e non 21 perché **fra 12,4 h e 19,6 h il
    campione è vuoto**: la scelta è insensibile a ±5 h, che è la forma di argomento usata anche per il
    tetto di orizzonte e per la finestra del piano leggero. **Effetto misurato: ZERO, oggi** — il board
    ha 111 mercati con minimo 1,17 g, e nell'universo premiante 0-48 h non esiste un solo mercato fra 6
    e 18 ore. È una correzione di taratura che morderà quando i premianti a scadenza breve torneranno.
    **Il prezzo, detto prima:** esclude 9 dei 38 ingressi premianti misurati, cioè la famiglia
    `<ticker>-up-or-down` (2,6-8 h) che il report segnalava come la più interessante per affollamento.
    *Chiuso di conseguenza uno dei quattro test rossi noti:* `risk-classifier` dichiarava
    `MIN_HORIZON_DAYS = 2` in un commento e 2880 minuti in un `.d.ts` mentre il valore era 0,25 — la
    classe di difetto che il rilevatore D7 cerca. Ora 0,75 e 1080, e il test passa 52/52.

    **Fase 2 — il rischio diventa un asse, non solo un cancello.**
    `punteggio = beneficio / (fVolatilità · fProfondità · fOrizzonte · fConcentrazione)`, ogni fattore
    fra 1 e 2, prodotto fra 1 e 16, punteggio in **$/giorno** come il numeratore. Nessuna soglia è
    nuova: `VELOCE_TICK_ORA` dalla cadenza adattiva, `maxCredibleShare 0,60` più il nozionale mediano
    dei 21 per la profondità di riferimento ($25), `MIN_HORIZON_DAYS`/`LONG_TAIL_DAYS` per le **due
    code** dell'orizzonte, `CONCENTRATION_CAP_FRAC` per la concentrazione. Si vede sulle righe e sui
    candidati di `/api/rewards/allocate` (punteggio intero) e su `/api/maker/board` (solo il fattore di
    rischio: quella rotta non pubblica $/giorno per scelta, e la console divide il proprio).
    **La proprietà che lo rende sicuro:** l'annotazione avviene DOPO il knapsack, e un test lo verifica
    per posizione nel sorgente più camminando gli import. Sul piano vero riordina: il mercato col
    beneficio più alto ($16,72/g) scende al terzo posto per rischio 3,05.

    **Fase 3 — il dato era live, la decisione no.** Un mercato «lento» aspettava dieci secondi anche col
    book appena cambiato. Ora `decidiCadenza` riceve l'istante dell'ultimo book e valuta subito se è più
    recente di quello su cui ha già deciso. **Il compromesso, dichiarato:** non è una riscrittura
    event-driven di agent40 — il ciclo esterno resta a 5 s, quindi si toglie l'attesa *artificiale* dei
    dieci secondi, non il ciclo. Il freno sui veloci è intatto: `MIN_MS` (1 s) vale anche per gli
    eventi, e `hysteresisTicks`/`confirmSamples`/`minIntervalMs` non sono stati sfiorati.
    **Difetto vero trovato per strada:** `cadenzaPer` leggeva `r.tickSize`, che `resolveMarketRules` non
    restituisce — `tickCents` restava **1 per ogni mercato**, quindi la misura era in centesimi/ora
    invece che in tick/ora. Su un mercato a tick 0,1¢ risultava dieci volte più lento del vero. Nessun
    test funzionale poteva vederlo: il risultato era plausibile, solo sbagliato di un fattore.

    **Fase 4 — venti secondi di cecità, poi ci si ritira.** Il rifiuto `mid-stale` era giusto e senza
    fine: si ripeteva per sempre e il capitale restava esposto su un book che non vedevamo. Ora il primo
    ciclo cieco fa partire un orologio; sotto i 20 s non cambia niente, sopra **si cancella**. Venti
    secondi = ~7 pubblicazioni mancate di agent34. `MAKER_MID_STANTIO_TIMEOUT_MS`, fuori da [5 s, 120 s]
    scartato. L'orologio si azzera **solo su una lettura buona**, e una cancellazione fallita NON lo
    azzera. L'unica azione del percorso è la cancellazione; il capitale liberato lo rimette al lavoro il
    trigger. L'orologio non sopravvive al riavvio, e non deve.

    **Fase 5 — un conflitto vero, trovato dal test che il requisito chiedeva.** La chiusura forzata
    vendeva **con il completamento del Livello 2 ancora sul libro**: `d.cancelOrderIds` porta le uscite
    sul lato riempito, il completamento sta sull'altro, quindi non ci finiva mai. Adesso entra nella
    stessa lista ed eredita la stessa regola (se una cancellazione fallisce, non si vende), e l'attesa
    viene chiusa. **E una cosa che non si può fare, scoperta provandola:** «posizionamento più
    aggressivo» non può alzare il prezzo del Livello 2 — è già `min(tetto, ask − tick)`, cioè il massimo
    dei due soli vincoli, e qualunque alzata sarebbe limitata dagli stessi termini. Il primo tentativo
    era codice morto; al suo posto resta la sola cosa vera: si **dichiara** se il prezzo cade in banda.

    **Fase 6 — due orologi con nomi che dicono cosa fanno.** `CADENZA_MS` (120 s) è ogni quanto si
    GUARDA il saldo; `CADENZA_OPERATIVA_MS` (600 s = **10 min**) è ogni quanto il trigger può AGIRE, ed
    è il numero che il requisito chiede. **La rilevazione resta a 2 minuti**, ed è una decisione:
    portarla a dieci renderebbe il trigger più lento ad accorgersi del capitale libero. L'invariante
    `10 min < 15 min` è ora un test che legge `SCAN_INTERVAL_MS` dal sorgente di agent24, non una
    costante copiata. La cadenza della scoperta non è stata toccata.

    **Fase 7 — un crash notturno non lascia più processi senza ambiente.** Lo scenario pericoloso non
    era il crash del processo (pm2 lo rilancia con la descrizione in memoria) ma il riavvio del
    **demone**: pm2 risorge dal dump su disco, che qui è pulito. agent41, agent35 e agent43 non avevano
    un caricatore di `.env`; ora ce l'hanno, **lo stesso blocco di agent40**. Misurato eseguendolo su un
    ambiente vuoto: **19 variabili dal file e 4/4 critiche su tutti e quattro**.
    `REALLOC_SCHEDULER_ENABLED` sta nel blocco `env` di ecosystem, versionato. **Non può rompere un
    avvio che funziona:** la condizione è `process.env[k] === undefined`, quindi pm2 vince sul file — ed
    è per questo che `REALLOC_SCHEDULER_DRY_RUN` resta dov'è e inerte.

    **Fase 8 — un 429 non è un 5xx.** Il backoff era 250/500/1000 ms per tutto. Ora il 429 parte da un
    secondo e raddoppia (1 → 2 → 4), e **`Retry-After` vince** su qualunque progressione (secondi o data
    HTTP), limitato a 30 s. E dopo un esito **ambiguo** — la POST era partita — non si ritenta alla
    cieca: si interroga il venue, e se l'ordine c'è l'esito viene dichiarato **riuscito**. Una verifica
    che non riesce vale «non ritentare»: fra due ordini e zero ordini, il secondo errore costa meno.
    La POST resta deliberatamente non avvolta in `withRetry`, come prima.

39. **QUATTRO RIAVVII PENDENTI per le otto fasi.** Nessuno eseguito: §2 regola 2.

    | processo | cosa entra in servizio | comando |
    |---|---|---|
    | `agent40-manual-reprice` | fasi 3, 4, 5 (decisione per evento, mid stantio, conflitto della chiusura forzata) + il fix del tick | `pm2 restart agent40-manual-reprice` |
    | `agent41-realloc-scheduler` | fasi 1, 6, 7 (pavimento nel piano leggero, cadenza operativa, caricatore `.env`) | `pm2 restart agent41-realloc-scheduler` — **e da ora basta questo**: il caricatore rende inutile la ricostruzione da `/proc` del punto 3 |
    | ~~`agent35-maker`~~ | fase 7 (caricatore `.env`) — **decaduto: il processo è stato RIMOSSO il 9 agosto 2026** (§5 punto 63). Non riavviarlo: al suo posto c'è un `pm2 delete` | ~~`pm2 restart agent35-maker`~~ |
    | `agent43-guardian` | fase 7 (caricatore `.env`) | `pm2 restart agent43-guardian` |
    | `dashboard` | fase 2 (fattore di rischio su `/api/maker/board`) | `pm2 restart dashboard` (verificare PRIMA `.next/prerender-manifest.json` — §5 punto 7) |

    **La nota del punto 3 è superata dalla fase 7 per agent41:** con il caricatore di `.env` un
    `pm2 restart agent41-realloc-scheduler` non perde più le 63 variabili, perché tornano dal file. La
    ricostruzione da `/proc` resta valida ma non è più necessaria.

40. **I ROSSI NOTI SONO SCESI DA QUATTRO A TRE.** `risk-classifier` è verde dalla fase 1 (era il
    commento fermo a `MIN_HORIZON_DAYS = 2`). Restano `dipendenze-collegate` (falso positivo su un
    ternario andato a capo), `scaduto-senza-rinnovo` (fixture il cui ordine viene riprezzato al primo
    giro) e `scadenza-ereditata`, più i tre test JS su moduli TypeScript che `node` non avvia
    (`lib/leg-order.test.js` e i due in `lib/venues/__tests__/`). Nessun rosso nuovo dalle otto fasi.

41. **IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE — CORRETTO in `main` l'8 agosto 2026,
    ~21:30 UTC. ASPETTA IL RIAVVIO DI agent41, DA CONFERMARE DA DIEGO IN CHAT.**

    **Come si è presentato.** 20:56 UTC: bot su AVVIA, kill spento, $668 liquidi, piano da $600 su
    8 mercati visibile nella tab «Mercati ottimizzati». L'operatore preme AVVIA, il mini-ciclo forzato
    parte, e il log dice `mini-ciclo FORZATO: $377 rimessi al lavoro su 5 mercato/i (0 ordini piazzati,
    5 rifiutati)`. Nell'audit, cinque volte lo stesso gate: `reject-manual-mode-inactive`.

    **La causa, e non era l'arming.** `data/maker-arming.json` è `armed:false` (§5 punto 5) ma non
    c'entra: `lib/maker/arming.js` è importato solo da agent35 e dalle route API, mai da
    `placeManualOrder` né da agent41. Il blocco vero era il **gate 1** di `placeManualOrder`
    (`evaluateManualGate`, `lib/maker/manual-order.js:546`), che esige la gestione manuale PRIMA degli
    ordini. La fase 3 del reset la prende su ogni mercato del piano
    (`allocation-reset.js:323`, cablata da `agent41-realloc-scheduler.js:506`); il **mini-ciclo non la
    prendeva mai** — zero occorrenze di `setManual` nella funzione. Finché sceglieva dal piano salvato
    il difetto era invisibile, perché quei mercati il reset li aveva già preparati (e infatti quei
    mini-cicli piazzavano: `2 ordini piazzati, 0 rifiutati`). Dal momento in cui può **RICALCOLARE**
    (piano oltre `PIANO_FRESCO_MAX_MS`, 60 min) sceglie mercati **nuovi** che nessuno ha preparato.

    **Il fix, e cosa NON tocca.** `agents/agent41-realloc-scheduler.js`: nuova `preparaMercatoNuovo`
    (le **tre** precondizioni della fase 3 del reset, nello stesso ordine) e passo **5-bis** dentro
    `miniCiclo`, più le tre deps iniettabili e `nonPreparati` nel referto. **Nessun gate è stato toccato
    di una virgola** — né `evaluateManualGate` né `evaluateLiveMinMarketGate`: restano
    identico per chiunque altro e continua a impedire due scrittori sullo stesso libro. Qui se ne
    soddisfa la **precondizione**, che è il rapporto che il reset ha col gate da sempre.
    - **Solo i mercati `nuovo`** (nessun nostro ordine a riposo, `trigger-capitale-fermo.js:358`):
      `setManualMode` riscrive il record e appende un audit a ogni chiamata, non è idempotente, e il
      mini-ciclo può girare ogni dieci minuti.
    - **Anche `setAutoClose`, e non è extra-scopo**: `runAutoCloseCycle` visita SOLO i mercati con
      l'opt-in acceso (`agent40-manual-reprice.js:485` gli passa `readAutoCloseConfig().enabledMarketIds`),
      quindi il solo `setManual` avrebbe aperto mercati con due gambe vive e **nessuna via d'uscita** —
      esattamente ciò che la fase 3 del reset tratta come fermo duro. Entrambe sono fermi duri: se una
      scrittura fallisce quel mercato esce dal giro e gli altri proseguono.
    - **`setEnabled` c'è, ed è stato aggiunto DOPO una misura sui dati vivi.** La prima stesura lo
      ometteva di proposito, con questo ragionamento: la allowlist di auto-reprice governa
      `MAKER_MODE=live-min`, e il processo di agent41 ha `MAKER_MODE=off` (verificato su `/proc`),
      quindi quel gate non lo tocca. **Il ragionamento guardava la variabile sbagliata.** La corsia
      manuale costruisce l'adapter con `mode: 'live-min'` **cablato**
      (`lib/maker/manual-order.js:733`), qualunque cosa dica l'ambiente: `evaluateLiveMinMarketGate`
      si applica **sempre** a chi passa di lì, agent41 compreso. Misurato dopo il riavvio delle 21:35:
      `manual-mode-inactive` era **sparito** — le due scritture funzionavano — e ogni gamba moriva un
      gradino più in là, su `live-min-market-mismatch`. **Lezione: l'ambiente di un processo non dice
      quale modalità una corsia CHIEDE.** Il permesso resta stretto dove conta: è `manual: true` a
      tenere agent35 fuori dal libro, non la allowlist.
    - **Asimmetria**: il mini-ciclo può ABILITARE un mercato, PRENDERLO in gestione e ACCENDERGLI
      l'uscita, mai il contrario — disabilitare, rilasciare e spegnere restano del ciclo delle sei ore.

    **Verifica.** Nuovo `lib/maker/miniciclo-prende-il-mercato.test.js` (**28/28**), che esegue
    `miniCiclo` vero con la corsia di piazzamento sostituita da un registratore. **Provato che fallisce
    senza il fix**: ripristinando il file pre-fix cadono 12 asserzioni, fra cui «setManual fallito ⇒
    nessun ordine parte — 2 gambe», cioè il vecchio codice piazzava su un mercato mai preparato.
    Le sezioni 5 e 6 passano anche pre-fix, ed è giusto: il gate non è mai stato il problema.
    `lib/maker/trigger-capitale-fermo.test.js` **aggiornato** (54 → 58/58): l'asserzione «non cambia la
    modalità manuale, non tocca l auto-close» era diventata la descrizione del difetto ed è stata
    **ristretta**, non rimossa — ora verifica che tracking e allowlist auto-reprice restino intoccati e
    che le due nuove scritture siano di sola acquisizione (`manual:true`/`enabled:true`, mai `false`).
    Suite: **115 verdi / 6 rossi**, gli stessi sei del punto 40. `npm run build` verde, `BUILD_ID`
    presente.

    **Primo riavvio eseguito alle ~21:35 UTC** su autorizzazione esplicita di Diego in chat (restart
    37 → 38, pid 1179999, **102 → 102 variabili, 9/9 critiche**). È quello che ha prodotto la misura
    del punto sopra: il fix a due scritture era vivo, `manual-mode-inactive` era sparito, e il rifiuto
    si era spostato su `live-min-market-mismatch`. La terza scrittura è stata aggiunta dopo.

    **SECONDO RIAVVIO PENDENTE — NON eseguito, serve una NUOVA conferma di Diego in chat** (§2 regola 2:
    un'autorizzazione vale solo per quel riavvio specifico). Il processo vivo ha ancora il fix a due
    scritture, quindi continua a farsi rifiutare ogni gamba per allowlist. Comando:
    ```bash
    pm2 restart agent41-realloc-scheduler
    ```
    Fallisce **chiuso** — nessun capitale a rischio — ma il piano non viene eseguito.

42. **UNA GAMBA CANCELLATA BRUCIAVA LA SUA CHIAVE PER SEMPRE — CORRETTO in `main` l'8 agosto 2026,
    ~22:20 UTC. ASPETTA IL RIAVVIO, DA CONFERMARE DA DIEGO IN CHAT.**

    **Come si è presentato.** Col fix del punto 41 vivo, i due gate che bloccavano il piano erano
    spariti dall'audit — e il mini-ciclo continuava a dire `0 ordini piazzati, 1 rifiutati`, otto volte
    di fila, con `$608` fermi contro un obiettivo del 90%. Unico gate residuo: `idempotent-duplicate`.

    **La causa, e NON è `notionalePerMercato`.** Quel mercato era davvero vuoto, e riportare $0 era la
    risposta giusta: l'ordine era stato **cancellato**. La catena, verificata sui dati:
    1. **21:42:18** — il ciclo da 6h piazza BUY YES 61,2 @ $0,34 su `0x4e89a330` (HIMS earnings).
       Intent `idem_c12152a1…`, ordine `0xd88822e0…` vivo.
    2. **21:44:00** — agent40 lo cancella: `outcome: "mid-stantio-cancellato"`, «mid stantio da 30,0s,
       oltre il limite di 20s… **il capitale liberato torna al trigger, che lo rimette al lavoro**».
       È la fase 4 (§5 punto 38), deployata lo stesso giorno.
    3. Il trigger fa esattamente quello che quella frase promette. Il piano dice $0,35, ma la regola
       «mai primi» risnappa a **$0,34** ⇒ stessa identità economica ⇒ **stessa chiave** ⇒ rifiutato.
    4. Prova aritmetica che il mercato era vuoto: piazzati $115,43, `aRiposoUsd` $94,62, differenza
       **$20,81 esatti** — l'ordine cancellato. E i quattro superstiti sommano 94,622, cifra per cifra.

    La chiave è deterministica sull'identità economica (`sha256(userId|venue|tokenId|side|price|size)`,
    **nessuna componente temporale**) e **il registro non sapeva cosa fosse una cancellazione**: zero
    occorrenze di `cancel` in `lib/safety/execution-audit.js`. Due meccanismi ciascuno corretto e
    reciprocamente contraddittori. **Non è il punto 22**: lì il problema è il saldo che non cala; qui la
    contabilità torna ($668,25 liberi + $94,62 al lavoro = $762,87). È un difetto nuovo, nato
    dall'incontro fra la fase 4 e il registro preesistente.

    **Il fix, e la forma non è nuova.** È quella che `lib/maker/manual-order.js:1475-1484` applica già ai
    **rimpiazzi**: un piazzamento che supera un ordine MORTO è un ordine diverso e merita una chiave
    diversa, derivata dall'id di quello che supera.
    - `lib/safety/execution-audit.js`: nuove `risolviDuplicato` e `chiaveDopoOrdineMorto` (+ `leggiRighe`).
      **La regola sta nel registro, il fatto no**: il chiamante passa `vivi`, l'insieme degli ordini che
      il venue dice aperti adesso. Così la regola si prova senza rete e il registro non impara a
      conoscere il venue. Percorre la **catena** delle sostituzioni (max 64 anelli).
    - `lib/venues/polymarket-clob-maker/adapter.js`: nel ramo del duplicato, legge gli ordini aperti e
      chiede al registro. `idempotencyKey` diventa `let`, così esito, latch e audit parlano della chiave
      nuova. Nuovo esito d'audit `supera-duplicato-cancellato`, e il motivo del mancato superamento
      finisce nel testo del rifiuto.
    - **Costa solo nel caso rotto**: la lettura parte unicamente dopo che il duplicato è già scattato.
    - **FALLISCE CHIUSO ovunque**: nessun insieme (lettura fallita, modalità senza rete, `safety`
      parziale) ⇒ nessun superamento; esito senza `orderId` (invio ambiguo) ⇒ nessun superamento; ordine
      ancora vivo ⇒ **rifiuto**, che è la ragione per cui la guardia esiste.
    - **Copre entrambe le corsie**: né `bulk-allocate.js` né `plan-to-orders.js` né agent41 passano una
      chiave esplicita, quindi mini-ciclo **e** ciclo fisso da 6h cadono sullo stesso
      `adapter.js:686` e beneficiano entrambi. Logica di cancellazione e schema Prisma **non toccati**.

    **Verifica.** Nuovo `lib/safety/idempotenza-dopo-cancellazione.test.js` (**32/32**): piazza →
    cancella → ripiazza identico **passa**; doppio invio senza cancellazione **resta bloccato**; due
    superamenti dello stesso ordine morto collidono fra loro; invio ambiguo e lettura fallita falliscono
    chiuso. Il fixture deriva la chiave **vera** dell'8 agosto (`idem_c12152a1e1ccd0a5c899adad`), quindi
    riproduce l'incidente e non una sua imitazione. Provato che fallisce senza il fix. Suite **116 verdi
    / 6 rossi** (i soliti sei del punto 40), `npm run build` verde.

    **Scoperto scrivendo il test, e non corretto** (fuori perimetro, nessun effetto in produzione):
    `recordIntent` deriva la chiave da `intent.tokenId`, ma la riga di intent registra `intent.market`.
    Un chiamante che passasse solo `market` **senza** chiave esplicita deriverebbe su `undefined`.
    Oggi non succede: l'adapter passa sempre la chiave già derivata.

    **Riavvio: NON eseguito, serve conferma esplicita di Diego in chat** (§2 regola 2). Il fix vive
    nell'adapter, quindi tocca **ogni** processo che piazza — `agent41-realloc-scheduler` per il caso
    misurato, e `agent40-manual-reprice`/`dashboard` per le loro corsie:
    ```bash
    pm2 restart agent41-realloc-scheduler
    ```
    Finché non riparte, il loop continua: fallisce **chiuso**, nessun capitale a rischio, ma i $608
    restano fermi.

43. **IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO — 9 agosto 2026, ~02:40 UTC. ASPETTA IL RIAVVIO
    DI agent41 E DEL DASHBOARD, DA CONFERMARE DA DIEGO IN CHAT.**

    **La diagnosi, misurata sui dati vivi e non dedotta.** Alle 02:31 del 9 agosto: bot su AVVIA, kill
    spento, saldo **$644,39**, **zero** ordini a riposo (`listOpenOrders → count: 0`), due sole posizioni
    per $26,09 ⇒ utilizzo **3,9%** contro l'obiettivo del 90%, deficit **$577,34**. Il mini-ciclo girava
    regolarmente ogni dieci minuti, **ricalcolava davvero** il piano leggero (11,9 s, 12 righe) e poi lo
    buttava via: `mini-ciclo: nessuna azione — rampa esaurita: 0x0320a702… sarebbe un mercato NUOVO`.
    I cinque posti erano stati consumati fra le 22:43 e le 23:15 dell'8 (trentadue minuti), e sarebbero
    tornati disponibili solo alle **20:56:04Z del 9**. Diciotto ore di capitale fermo con mercati validi
    sul tavolo, senza che nessun processo fosse rotto.

    **Il difetto non era il numero, era la FORMA.** Un contatore giornaliero misura il tempo passato
    dall'AVVIA, che non è una proprietà del rischio; e conta le **aperture** invece del **capitale
    esposto**. I due numeri divergono esattamente nel caso che interessa — mercati aperti e richiusi in
    fretta — quindi il tetto restava chiuso proprio quando il capitale tornava tutto libero. Sul percorso
    del reset era anche incoerente: il ciclo da 6h cancella e ripiazza, quindi ogni riga si ripresenta
    come «nuova» a ogni giro.

    **Cosa c'è adesso: un vincolo CONTINUO, senza memoria e senza calendario.**
    `utilizzo-capitale.aperturaNuoviMercati({ utilizzo })` — si aprono mercati nuovi finché l'utilizzo sta
    sotto l'obiettivo, **mai più di `MAX_NUOVI_PER_GIRO = 6` per giro** (`MAKER_MAX_NUOVI_PER_GIRO`; un
    valore assurdo viene scartato in favore del difetto, come per fine scala e orizzonte). Si chiude da sé
    quando il capitale è al lavoro e **si riapre da sé nello stesso istante** in cui torna libero.
    - **Perché un tetto per giro e non zero limiti** (era una scelta lasciata a me): i due limiti
      rispondono a domande diverse — il target dice *quanto* capitale impegnare, il tetto per giro dice
      *quanto in fretta*. Senza il secondo, un solo giro potrebbe aprire tutte le righe del piano insieme:
      non violerebbe nessuna regola di rischio, ma trasformerebbe un errore di piano (un board vecchio,
      una stima gonfia) in un errore su tutto il conto **prima che qualcuno abbia un giro per accorgersene**.
    - **Nel regime stazionario è PIÙ STRETTO di prima**, e vale la pena dirlo: la rampa dava `Infinity`
      — nessun limite di alcun tipo — passate le 24h dall'AVVIA. La regola nuova non restituisce mai
      `Infinity`, dal primo minuto e per sempre.
    - **Utilizzo non misurabile ⇒ NON blocca**, resta il solo tetto per giro, e lo dichiara. È l'unico
      punto in cui non si fallisce nella direzione stretta, ed è deliberato: il cancello del capitale sta
      già a monte (senza saldo letto il mini-ciclo non arriva fin qui), e un secondo blocco su un dato
      mancante riprodurrebbe esattamente la paralisi che questa modifica esiste per togliere.
    - **Il registro resta, il cancello no.** `mercatiDallAvvio` e `registraMercatoAperto` sopravvivono
      come **memoria** di cosa ha aperto il bot dall'accensione (utile a leggere l'audit), con la
      rilettura-prima-di-scrivere che protegge un FERMA premuto nel frattempo. `rampa()`, `RAMPA_ORE` e
      `RAMPA_MAX_MERCATI` **non esistono più**; al loro posto `apertureDallAvvio()`, che non pubblica
      nessun `residuo` né `attiva` — non c'è niente che un chiamante possa scambiare per una quota.
    - **Sul ciclo da 6h la rampa è stata tolta e basta**: lì la protezione vera è `MAX_POSIZIONI = 10`,
      che vincola l'esposizione e non l'anzianità della sessione, ed è rimasta intatta.

    **Nessun'altra protezione è stata toccata, ed è verificato per nome** (sezione 4 del test nuovo, con
    il tetto sui mercati nuovi spalancato a 999): tetto di concentrazione del 20% per mercato · minimo di
    $34 per un ordine sensato · tetto di mercati per giro · l'obiettivo di impegno come *freno* · righe
    con gambe non costruibili saltate · bot fermo / kill / ciclo in corso che continuano a non far
    scattare il trigger · la misura dell'utilizzo che non è diventata più permissiva. Restano ovviamente
    intatte, perché stanno tutte a valle e non sono state sfiorate, le regole per-ordine: mai primo sul
    libro, banda premiante, gate anti-duplicato, fine scala, soglia di perdita del guardiano.

    **Verifica.** Nuovo `lib/maker/apertura-guidata-dal-target.test.js` (**43/43**), che riproduce la
    scena del 9 agosto con i numeri veri: registro a 5 mercati aperti + capitale fermo ⇒ il giro **sceglie**
    invece di fermarsi, e con l'obiettivo già raggiunto **non apre** nulla di nuovo citando l'utilizzo e
    non un calendario. `bot-enabled.test.js` riscritto (36/36): la sezione «rampa» è diventata «registro»
    e asserisce che 8 aperture vengano registrate **senza limitare**. `capitale-al-lavoro.test.js` 71/71,
    `trigger-capitale-fermo.test.js` 59/59, `miniciclo-prende-il-mercato.test.js` 36/36. Suite completa:
    **144 eseguiti, 138 verdi**, e i 6 rossi sono esattamente i preesistenti del punto 40 — zero nuovi.
    `npm run build` verde. La simulazione (`scripts/simula-capitale-al-lavoro.js`) ora esegue la regola
    **vera** invece di sostituirla e resta a 0% → 90%.

    **Riavvio: NON eseguito, serve conferma esplicita di Diego in chat** (§2 regola 2).
    ```bash
    pm2 restart agent41-realloc-scheduler     # la regola nuova nel mini-ciclo e nel ciclo da 6h
    pm2 restart dashboard                     # /api/maker/bot pubblica `aperture` al posto di `rampa`
                                              # (verificare PRIMA .next/prerender-manifest.json — §5 punto 7)
    ```
    Il riavvio di agent41 porta con sé anche il punto 42 (idempotenza), che era già pendente.

44. **UN MERCATO CHE ESCE DAL BOARD PERDEVA LA GESTIONE — CORRETTO in `main` il 9 agosto 2026, ~03:50 UTC.
    GLI 11 ORFANI SONO GIÀ SANATI E VERIFICATI SUI DATI VIVI. IL FIX PREVENTIVO ASPETTA IL RIAVVIO DI
    agent41, DA CONFERMARE DA DIEGO IN CHAT.**

    **La causa.** Un mercato aperto da agent41 vive sulle regole del board reward. agent24 lo riscrive
    ogni 15 minuti tenendo i primi 120 per montepremi: quando un mercato ne esce **mentre la posizione è
    ancora aperta**, `resolveMarketRules` (`lib/maker/manual-order.js:276`) non trova più tick, banda,
    minSize e negRisk. Il book live di agent34 non li ha e non può averli — porta il prezzo, non il
    regolamento. Da lì si fermano **insieme** quattro percorsi: `auto-close.js:78` e `:464` (nessuna
    chiusura), `auto-reprice.js:219` (nessuna riprezzatura), `mm-tracking.js:217` (nessun tracking) e il
    **gate 2** di `placeManualOrder` (`manual-order.js:835`, qualunque ordine rifiutato, uscite comprese).
    Cioè **una posizione senza via d'uscita, per un motivo che con la posizione non c'entra**.

    **Il ripiego era già progettato, mancava chi lo riempisse.** `resolveMarketRules` consulta
    `data/maker-manual-markets.json` quando il board non conosce il mercato (righe 283-299), ma quel
    catalogo lo scriveva **solo** il pannello operatore (`upsertMarket` in
    `app/api/maker/markets/enable/route.ts`): agent41 non lo chiamava mai.

    **Misura che l'ha fatto scattare** (9 agosto, 03:40): **10 mercati su 39** in gestione erano orfani,
    fra cui quattro aperti la sera prima. Primo `rules-unreadable` su London 18°C: **02:09:42Z**, il giro
    di board subito dopo l'ultimo ciclo di auto-close riuscito (02:08:57Z). Da lì, 967 righe di rifiuto.

    **Il fix, in due pezzi.**
    - `lib/maker/market-catalog.js` — nuova `recordDaRigaBoard(row)`: mapper **puro** riga-di-board →
      record di catalogo. Sta qui e non nello scheduler perché è una proprietà del formato del catalogo;
      un mapper nello scheduler sarebbe la seconda definizione dello stesso record. Non inventa: un campo
      assente resta assente e `upsertMarket` **rifiuta** il record se mancano i quattro obbligatori —
      meglio nessun ripiego che un tick indovinato, che produrrebbe ordini fuori banda invece di un
      rifiuto leggibile.
    - `agents/agent41-realloc-scheduler.js` — **quarta scrittura** nel passo 5-bis (`preparaMercatoNuovo`),
      che copia le regole **mentre il board ce le ha ancora**: dopo la rotazione non esisterebbe più
      nessuna fonte locale. La fonte è `BOARD_NORMALIZZATO = '/tmp/liquidity-rewards.json'`, cioè lo
      **stesso file** che `resolveMarketRules` legge come prima scelta — così il ripiego non può contenere
      numeri diversi da quelli su cui il mercato è stato scelto, e un test confronta i due percorsi
      leggendo entrambi i sorgenti.

    **NON è un fermo duro, e la distinzione è il punto.** Le prime tre scritture decidono se il mercato è
    operabile *adesso*: senza, ogni gamba muore a un gate, quindi non ha senso proseguire. La quarta
    decide se sarà gestibile *dopo*. Rinunciare al piazzamento per una copia di sicurezza mancata
    scambierebbe un danno certo (capitale fermo adesso) con uno possibile (gestione persa se e quando il
    board ruota). Si annota in `senzaRipiego` — che viaggia nel referto e in una riga di log — e si va
    avanti. **Il board resta la prima scelta**: se il mercato ci torna, vince il board.

    **GLI 11 ORFANI SONO STATI SANATI, ed è una scrittura di stato che ho eseguito** —
    `node scripts/registra-mercati-orfani.js --esegui`, 03:45:24Z, 11 registrati / 0 saltati. La scelta:
    lo script scrive **solo metadati**, che come dice l'intestazione di `market-catalog.js` non rendono
    piazzabile un mercato — possono solo rendere un ordine *rifiutabile con un motivo leggibile* invece
    che per un dato mancante. L'effetto pratico è che **torna la via d'uscita** a posizioni che non ne
    avevano, che è la direzione sicura. I dati vengono da `fetchMarketByConditionId`, la **stessa**
    funzione del pannello operatore: tick, negRisk e i token id non si possono dedurre, e indovinarli
    sarebbe il difetto peggiore. Lo script è in **anteprima di difetto** (`--esegui` per scrivere).
    - **Verificato sui dati vivi, senza riavvio:** alle **03:47:19Z**, due minuti dopo la scrittura,
      London 18°C è passato da `rules-unreadable` a valutazione completa (`merge-livello-2` +
      `skip-no-target`). `resolveMarketRules` risponde `readable: true` con tutti e quattro i campi. Il
      catalogo si legge a ogni chiamata da disco, quindi non serviva riavviare niente.
    - Restano **9 mercati sul board** (che non hanno bisogno del ripiego) e **26 nel catalogo**.

    **Verifica.** Nuovo `lib/maker/catalogo-di-ripiego.test.js` (**43/43**): riproduce la scena completa
    — sul board → aperto → board che ruota → regole ancora leggibili — e verifica che senza ripiego
    manchino *esattamente* i quattro campi visti in produzione. Più: ogni obbligatorio mancante fa
    rifiutare il record, `negRisk:"true"` stringa non diventa `true`, le prime tre scritture restano fermi
    duri, la quarta non lo è (anche se **esplode**), il flusso del pannello è invariato, e i due percorsi
    del board coincidono. Suite: **145 eseguiti, 139 verdi**, i 6 rossi sono i preesistenti del punto 40.
    `npm run build` verde.

    **Riavvio: NON eseguito, serve conferma esplicita di Diego in chat** (§2 regola 2). Serve solo per il
    fix **preventivo** — la sanatoria è già attiva perché il catalogo si rilegge da disco:
    ```bash
    pm2 restart agent41-realloc-scheduler
    ```

45. **IL MERGE ON-CHAIN È COLLEGATO AL FLUSSO — `CTF_RELAYER_ENABLED` RESTA `false`, IN ATTESA DI
    AUTORIZZAZIONE ESPLICITA DI DIEGO IN CHAT.** In `main` dal 9 agosto 2026, ~04:10 UTC.

    **Cosa mancava.** `lib/maker/ctf-relayer.js` esiste dal 7 agosto — split/merge/redeem via relayer
    gasless, **provato on-chain** (split $2 `0x96072ab7…` · merge $2 `0x792b31e5…`, saldo tornato alla
    cifra esatta, gas pagato dal relayer) — ma **nessun modulo di produzione lo importava**: era
    un'attrezzatura senza chiamante. Verificato di nuovo il 9 agosto: gli unici `require` erano i suoi
    stessi test.

    **Il punto d'aggancio esisteva già, e non è stato inventato.** `decidiLivello` risponde
    `azione: 'merge'` quando `mancaAllaCoppia <= 0` (`strategia-merge.js:218`), cioè quando YES e NO sono
    in parti uguali. Fino a oggi **quel caso cadeva nel vuoto**: `liv.prezzo` è `null` e `manca` è 0,
    quindi entrambi i tentativi di `completaCoppia` venivano scartati e si ripiegava sulla **vendita**.

    **Perché non c'è un confronto di convenienza, ed è stato scritto e poi buttato.** Il primo istinto era
    «fondi se conviene più che vendere». Scartato: il merge rende **esattamente $1 per coppia, subito,
    senza slippage e senza gas**; la vendita rende `bid × size` su **un lato solo**, lascia l'altro in
    portafoglio (quindi non chiude la posizione, la rende direzionale) e attraversa lo spread. Il
    confronto avrebbe due termini di cui uno è sempre maggiore: potrebbe solo sbagliare. **Coppia
    completa ⇒ merge**; la vendita resta il ripiego.

    **Il wiring** (`lib/maker/auto-close.js`): nuova `fondiCoppia`, chiamata da `completaCoppia` **dopo**
    le cancellazioni e **prima** dei due tentativi di completamento. Nuovo esito `fuso`, che
    `registraCoppia` riconosce e che chiude il caso — dopo un merge la coppia non esiste più, non c'è
    niente da vendere e niente da attendere. `mergeOnChain` è **iniettabile**, così i test guidano la
    fusione senza rete e il relayer resta importato in **un punto solo**.
    - **Il confine non si allarga**: `ctf-relayer` continua a costruire **una** chiamata sola, a
      ri-decodificarla prima di firmare (`verificaConfinamento`) e a rifiutare qualunque target che non
      sia uno dei due adapter CTF. Il wiring aggiunge un **chiamante**, non una capacità. Non si chiamano
      `splitPosition` né `redeemPosition`.
    - **Fail-closed in ogni direzione**: `negRisk` non booleano ⇒ non si tenta (decide *quale* adapter, e
      con quello sbagliato la transazione reverte senza dire perché) · size non finita o ≤ 0 ⇒ non si
      tenta · flag spento ⇒ `esegui` non firma e non invia, restituisce il piano con `eseguito:false` ·
      qualunque eccezione ⇒ `ok:false` col motivo. **Mai un'azione a metà**: o la coppia è fusa on-chain,
      o non è successo niente — e in entrambi i casi il ramo prosegue col comportamento di prima.
    - **Audit completo** per ogni tentativo, con tre esiti distinti: `merge-onchain-eseguito` (con size,
      `transactionID` e `transactionHash`), `merge-onchain-non-eseguito`, `merge-onchain-fallito`. Un
      merge che non parte e non lascia traccia sarebbe indistinguibile da un merge mai tentato.
    - **Nessun secondo interruttore**: la costante nel sorgente resta l'unica, e un test verifica che
      `auto-close` non legga nessuna env né forzi `abilitato`.

    **Stato del relayer, verificato il 9 agosto.** Modulo integro (482 righe, 3 commit, ultimo `d21669d`).
    `POLYMARKET_RELAYER_API_KEY` e `POLYMARKET_RELAYER_API_KEY_ADDRESS` **sono in `.env`** —
    ma **NON nell'ambiente del processo agent40**, che è chi eseguirebbe la fusione. Con il caricatore
    `.env` della fase 7 rientrano al prossimo riavvio; senza, `credenziali()` solleverebbe e la fusione
    ripiegherebbe pulita sulla vendita. Da sapere prima di accendere il flag.

    **Cosa succederebbe accendendo il flag OGGI: niente.** Nessuna delle due posizioni London ha una
    coppia completa — 23,15 NO e 21,18 NO, `sizeAltroLato: 0` su entrambe, verdetto `livello 2`,
    `azione: maker-con-tetto`. La prima fusione reale avverrà sulla **prima coppia che si completa**, e
    sarà di `mancaAllaCoppia` share per un controvalore di **$1 × size**.

    **Per accendere servono TRE cose, non una:** (1) `CTF_RELAYER_ENABLED = true` in
    `lib/maker/ctf-relayer.js:94`; (2) un **riavvio di agent40** — è una costante di sorgente, non una
    env; (3) le due credenziali del relayer **nell'ambiente di agent40**, che il riavvio porta con sé
    grazie al caricatore `.env`. **Nessuna delle tre è stata fatta.**

    **Verifica.** Nuovo `lib/maker/merge-onchain-collegato.test.js` (**51/51**): coppia completa ⇒
    `mergePosition` chiamata una volta con id, size e `negRisk` **copiato**; neg-risk e non-neg-risk
    entrambi, con l'adapter giusto per ciascuno; cinque forme di `negRisk` non leggibile e cinque di size
    invalida che **non tentano**; tre modi di fallire che valgono tutti «non è successo niente»; il flag
    spento che non tocca la rete ma costruisce il piano; e l'isolamento del relayer invariato. Suite:
    **146 eseguiti, 140 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde.

46. **IL PERIODO DEL BOARD ERA 22,5 MINUTI, NON 15 — CORRETTO in `main` il 9 agosto 2026, ~04:40 UTC.
    ASPETTA IL RIAVVIO DI agent24 E agent41, DA CONFERMARE DA DIEGO IN CHAT.**

    **La causa, e non era un ritardo.** `agents/agent24-liquidity-rewards.js` faceva
    `await scan(); await sleep(SCAN_INTERVAL_MS)`, cioè un periodo **reale** di
    `durata della scansione + 15 minuti`. Finché la scansione costava 14 secondi la differenza non si
    vedeva; dall'allargamento della scoperta dell'8 agosto (§5 punto 23: 21 pagine → 141) costa **~7,5
    minuti**, quindi il board si riscriveva ogni **22,5 minuti** mentre due costanti, un commento e un
    test dicevano quindici. agent41 rifiutava di quotare oltre i 20 ⇒ una fascia strutturalmente morta.

    **La prova è nei numeri, non nel ragionamento:** le età che hanno bloccato un mini-ciclo sono
    **21,0 · 22,0 · 22,2 minuti** — tutte sopra il limite di 20 e tutte sotto il periodo di 22,5. È la
    firma esatta di un periodo cresciuto in silenzio. **3 mini-cicli su 22** persi il 9 agosto (14%, non
    la metà: la stima «metà» veniva da un campione di tre cicli e va corretta).

    **Due interventi, e fanno lavori diversi — li ho fatti entrambi.**
    - **La causa**, in agent24: si dorme il **resto** del periodo (`SCAN_INTERVAL_MS − durata`), con un
      **pavimento** di 60 s perché una scansione più lunga del periodo non faccia girare le scansioni
      schiena a schiena martellando Gamma. Lo sforamento si **dichiara** con una riga di log che indica
      l'età massima che i lettori devono aspettarsi: è precisamente il modo in cui questo difetto è
      rimasto invisibile per un giorno.
    - **Il margine**, in `trigger-capitale-fermo.js`: `ETA_BOARD_MAX_MS` **20 → 25 minuti**. Non basta
      correggere la causa: la cadenza della scoperta è già cresciuta **due volte** (14 s → 97 s → 7,5 min)
      e crescerà ancora; un limite a cinque minuti dal periodo si romperà di nuovo, e in silenzio. 25 dà
      **dieci minuti** di margine sopra il periodo di 15, cioè assorbe una scansione che sfora fino al
      doppio. **E non di più**: il limite deve restare capace di vedere agent24 **morto**, e a 30 si
      tollererebbe una scansione saltata per intero — proprio l'evento che il controllo esiste per
      cogliere. Un'età **ignota** continua a non passare.

47. **IL RIPIEGO DELLE REGOLE COPRIVA UN PERCORSO SU DUE — ESTESO il 9 agosto 2026.** Il punto 44 aveva
    collegato la copia di sicurezza al **mini-ciclo**; la **fase 3 del reset delle sei ore** —
    `lib/maker/allocation-reset.js`, che accende **tutto il piano in una volta** — non la scriveva.
    Cioè la maggioranza dei mercati nasceva ancora senza copia.

    **E il caso che conta di più non è la rotazione: è la scadenza.** Un mercato esce dal board per due
    motivi — rotazione (i primi 120 per montepremi) o **avvicinamento alla risoluzione**. Il secondo è
    quello su cui una posizione va gestita *fino alla fine*, ed è massivo: il **9 agosto alle 03:41:31**
    il reset ne ha lasciati **dieci in una volta**, tutti `in-scadenza`. Il ripiego è indifferente al
    motivo perché è keyed sul mercato — ma va **scritto**, e da entrambi i percorsi.
    - **Una funzione sola** (`copiaRegoleNelRipiego` in agent41) per i due chiamanti: due traduzioni
      della stessa riga di board divergerebbero, e qui la divergenza costerebbe di più.
    - **Non è un fermo duro**, a differenza di `setEnabled`/`setManual`/`setAutoClose`: quelle decidono
      se il mercato è operabile *adesso*, questa se sarà gestibile *dopo*. Copia fallita, dep non
      cablata o eccezione ⇒ il mercato si accende lo stesso e il fallimento viaggia nel referto
      (`ripiegoRegole`, `ripiegoMotivo`).
    - **Il reset non rimuove mai** un record dal catalogo, e non nomina nemmeno il modulo: la scrittura
      è iniettata. Quindi una posizione su un mercato che sta per risolvere resta gestibile fino alla
      risoluzione vera.

    **Verifica.** Nuovo `lib/maker/cadenza-board.test.js` (**45/45**): l'aritmetica del periodo prima e
    dopo · le tre età osservate che ora passano e tre davvero stantie che no · l'invariante
    `ETA_BOARD_MAX_MS > SCAN_INTERVAL_MS` letto **dal sorgente** di agent24, non da una copia · le
    protezioni non toccate (soglia $50, minimo $34, 6 mercati/giro, cadenze) · l'uscita per **scadenza**
    coperta dal ripiego · la fase 3 che chiama la copia una volta per mercato, e i tre modi di fallire.
    *(Una nota di metodo: la prima stesura provava il reset in `dryRunOnly:true` — che esce alla fase 0 —
    e l'asserzione passava a vuoto su un array vuoto. Corretta.)* Suite: **147 eseguiti, 141 verdi**, i 6
    rossi sono i preesistenti del punto 40. `npm run build` verde.

    **Riavvii: NON eseguiti, serve conferma esplicita di Diego in chat** (§2 regola 2).
    ```bash
    pm2 restart agent24-liquidity-rewards     # il periodo torna a 15 minuti esatti
    pm2 restart agent41-realloc-scheduler     # limite 25 min + la copia nel reset da 6h
    ```

48. **LO SPLIT NON VA COLLEGATO, E LA MISURA È NETTA — deciso il 9 agosto 2026, nessun codice scritto.**
    `splitPosition` è pronto e provato on-chain, ma **non conviene mai in questa strategia**, e la
    ragione non è marginale.

    **Il confronto, sui dati veri.** Lo split rende esattamente 1 YES + 1 NO per **$1,00** depositato,
    senza spread. Comprare le due gambe sul book costa quanto la coppia costa davvero, e su **37 coppie
    realmente piazzate** (`data/execution-audit.jsonl`, 8-9 agosto): **min 0,93 · mediana 0,97 · max
    0,999**. *(Una 38ª riga a 1,13 è un falso accoppiamento della mia euristica — due gambe di mercati
    diversi cadute nella stessa finestra di 3 s — e non un pagamento sopra la pari.)* Il piano salvato
    dichiara la stessa cosa per costruzione: `pairCostUsd` **0,98 su tutte e 12 le righe**.

    **Non è un caso: è la strategia.** Il bot posa le due gambe *dentro la banda premiante*, un tick
    dietro il tocco su ciascun lato, quindi la coppia costa `1 − 2 × offset` **per costruzione**. Il
    3% di sconto mediano **è il margine**. Lo split lo pagherebbe pieno: ~3¢ peggio per dollaro.

    **E c'è un secondo argomento che da solo chiude la questione: lo split non mette niente sul libro.**
    Questo bot non guadagna dai fill — guadagna dai premi di liquidità sugli ordini **a riposo**. Una
    posizione creata per split è due token fermi nel portafoglio che non maturano **nulla**. Quindi lo
    split non costa solo 3¢ in più: rinuncia all'intero ricavo.

    **L'ipotesi «conviene quando il book non offre la coppia a sconto» non si verifica**, ed è per una
    ragione strutturale: se la coppia costasse più di $1 il bot **non aprirebbe quella posizione**, non
    la aprirebbe in un altro modo — lo sconto della coppia *è* la condizione di ingresso. Anche il
    Livello 1 del merge, che è l'unico acquisto aggressivo del sistema, ha un tetto che tiene la coppia
    **≤ 99¢**. Non esiste percorso in cui il bot paga una coppia $1 o più.

    **Conclusione: nessun collegamento scritto.** Il modulo resta con `splitPosition` esportata e senza
    chiamanti, ed è lo stato giusto. Se un giorno nascesse una strategia direzionale — che tiene un solo
    lato e non cerca premi — la domanda andrebbe rifatta da capo: lì lo split competerebbe con
    l'attraversare lo spread su un lato solo, che è un confronto diverso da questo.

    *(Aggiornamento: `CTF_RELAYER_ENABLED` è stato acceso poche ore dopo, su istruzione dell'operatore —
    punto 49. Non cambia nulla di questa analisi: il flag governa merge, split e redeem, ma **solo il
    merge ha un chiamante**. Lo split resta esportato e mai invocato, ed è lo stato giusto.)*

49. **`CTF_RELAYER_ENABLED = true` — ACCESO il 9 agosto 2026, ~04:30 UTC, su istruzione esplicita di
    Diego in chat. IN `main` E NEI PROCESSI.**

    > **CORREZIONE del 9 agosto, ~07:10 UTC.** Questo punto diceva «NON ANCORA NEI PROCESSI: serve un
    > riavvio di agent40 CHE NON HO FATTO» e citava «agent40 restart **58**, avviato alle ~04:22». Era
    > vero quando è stato scritto e non lo è più: **agent40 è stato riavviato alle 05:06:13 UTC** (restart
    > **60**), cioè *dopo* il commit `d8b8303` delle 04:30. Il flag è compilato dentro il processo vivo, e
    > l'audit lo conferma dall'esterno (`observed.eseguito: true` su ogni riga `merge-livello-*`).
    >
    > **E la prima coppia completa È arrivata** — Dallas 98-99°F, 36,3 share — contraddicendo il «cosa
    > succederebbe adesso: niente» più sotto. Non è stata fusa lo stesso, per una ragione diversa da tutte
    > quelle elencate in questo punto: **il firmatario non era cablato**. Vedi **§5 punto 52**. Il resto di
    > questo punto — cosa accende il flag, il confine, le credenziali, i test — resta valido.

    **Cosa accende, esattamente.** Solo il **merge on-chain di una coppia già completa**. Il flag governa
    tre funzioni ma **una sola ha un chiamante**: `auto-close.fondiCoppia` → `mergePosition`, raggiunta
    quando `decidiLivello` risponde `azione:'merge'`, cioè quando YES e NO sono in parti uguali sullo
    stesso mercato. `splitPosition` e `redeemPosition` **restano senza chiamanti** — nessun percorso
    automatico le raggiunge (§5 punto 48 spiega perché lo split non conviene mai in questa strategia).

    **Cosa succederebbe adesso: niente.** Nessuna coppia è completa. Le due posizioni London hanno un
    lato solo — 23,15 NO e 21,18 NO, `sizeAltroLato: 0`, verdetto `livello 2 · maker-con-tetto`. La prima
    fusione reale avverrà sulla **prima coppia che si completa**, per `size` share e un controvalore di
    **$1 × size** che tornano **liquidi subito** invece che alla risoluzione.

    **La spesa è zero, e va detto perché non è un dettaglio.** `mergePositions` converte token **già
    nostri** in collaterale: non compra, non vende, non tocca il book, non ha slippage. Il gas lo paga il
    relayer di Polymarket. È l'unica operazione del sistema che *libera* capitale invece di impegnarlo —
    l'opposto dello split, che è la ragione per cui uno è collegato e l'altro no.

    **Il confine non è stato allargato di una riga.** `calls` non è mai un parametro, `verificaConfinamento()`
    ri-decodifica il batch prima della firma e rifiuta qualunque target che non sia uno dei due adapter
    CTF, nessun ramo chiama `approve`/`transfer`. L'interruttore decide **quando** si firma, non **cosa**.

    **Le credenziali ci sono, e la verifica precedente era misurata male.** Avevo scritto che
    `POLYMARKET_RELAYER_API_KEY` non era «nell'ambiente di agent40» leggendo `/proc/<pid>/environ`:
    quella è l'ambiente con cui il processo è **partito**, e agent40 ha il proprio caricatore `.env`
    (righe 56-62) che riempie `process.env` **a runtime**. Le quattro variabili che servono
    (`POLYMARKET_RELAYER_API_KEY`, `..._ADDRESS`, `MAKER_FUNDER_ADDRESS`, `KEY_CUSTODY_MASTER`) sono tutte
    in `.env`, quindi arrivano. Se mancassero, `credenziali()` solleverebbe e `fondiCoppia` ripiegherebbe
    pulita sulla vendita — fail-closed, non un guasto.

    **I due test che pretendevano `false` sono stati aggiornati, non rimossi.** Difendevano una proprietà
    («un flip silenzioso deve far cadere il test»), non un valore. Ora pretendono che **la costante e
    l'intestazione che la racconta dicano la stessa cosa**: un flip in qualunque direzione senza
    aggiornare il testo continua a far cadere il blocco. E il ramo *spento* resta provato passando
    `abilitato:false` esplicito, che è più forte di provarlo perché era il difetto di default.

    **Verifica.** `merge-onchain-collegato` **53/53** · `strategia-merge` **39/39** · `ctf-relayer`
    **95/95**. Suite: **147 eseguiti, 141 verdi**, i 6 rossi sono i preesistenti del punto 40.
    `npm run build` verde.

    **RIAVVIO NON ESEGUITO — serve una conferma NUOVA di Diego in chat** (§2 regola 2: un'autorizzazione
    vale solo per quel riavvio specifico, e quella delle 04:22 riguardava il codice di prima). Il processo
    vivo — agent40 restart **58**, avviato alle ~04:22 — ha ancora `false` compilato dentro, quindi al
    momento **non può firmare niente**. Comando:
    ```bash
    pm2 restart agent40-manual-reprice
    ```
    Da quel riavvio in poi, la prima coppia completa viene **fusa on-chain in autonomia**, senza altre
    conferme. È la prima operazione on-chain automatica di questo stack.

51. **LA SEQUENZA COMPLETA DEL LATO SCOPERTO — in `main` il 9 agosto 2026, ~05:45 UTC. ASPETTA IL
    RIAVVIO DI agent40.** Un fill che lascia un lato scoperto passa ora per **quattro** stadi, in ordine:

    | # | chi | cosa | tetto |
    |---|---|---|---|
    | 1 | Livello 1 del merge | taker sull'altro lato | coppia ≤ **99¢** |
    | 2 | Livello 2 del merge | maker a riposo sull'altro lato, attesa 60 min | coppia ≤ **99¢** |
    | 3 | **chiusura rapida** | taker fin dove il book copre + limit per il resto | coppia ≤ **110¢** |
    | 4 | **riposizionamento scoperto** *(nuovo)* | SELL sul lato posseduto a +1% dentro banda **+** BUY a limit sulla controparte | coppia ≤ 110¢ |

    Lo stadio 4 si raggiunge solo se **nessuno** dei tre precedenti ha completato — se il taker scatta si
    torna prima, quindi non c'è conflitto e non c'è doppio ordine.

    **Il buco che chiude.** Quando la banda premiante scende sotto il prezzo di carico, `planExit`
    (`exit-plan.js:146`) rifiuta di piazzare un'uscita — giustamente, sarebbe in perdita — e nessun altro
    percorso proponeva niente: **zero ordini, zero premi, posizione direzionale ferma**. Era lo stato di
    entrambe le posizioni London il 9 agosto (18°C: banda fino a 63¢ su carico 65¢; 19°C: 51¢ su 59¢).

    **VA DETTO, PERCHÉ È IL LIMITE DELLA REGOLA STESSA.** Il requisito chiede «+1% dal carico, sempre
    dentro banda, mai sotto il carico». Nel caso che l'ha motivato — banda **interamente** sotto il
    carico — quei tre vincoli sono **incompatibili fra loro**: non esiste un prezzo che li soddisfi.
    `pianificaRiposizionamentoScoperto` non ne inventa uno: restituisce `latoPosseduto: null` col motivo,
    e propone comunque la **controparte**, che è sempre prezzabile. **Il silenzio si riduce, non
    sparisce** — e farlo sparire vorrebbe dire vendere sotto il carico, cioè rompere il vincolo che il
    requisito stesso dichiara duro. Nelle due London il risultato pratico è: nessun SELL (corretto), ma
    **un BUY di completamento a limit** dove prima non c'era niente.

    **Dove +1% è satisfacibile** la regola fa quel che dice: prezzo `carico × 1,01` arrotondato **in su**,
    e se supera il tetto della banda si scende **al tetto della banda** — il prezzo più vicino a +1% che
    resta premiante, mai oltre. Sweep su 90 combinazioni (5 carichi × 6 bande × 3 tick): **zero** prezzi
    sotto il carico o fuori banda.

    **`skip-no-target` non è stato toccato** per gli altri casi che gestisce: vive in `decideClose`, nasce
    da `planExit`, e continua a decidere l'uscita ordinaria come sempre. Il riposizionamento agisce prima,
    in `completaCoppia`, e solo sul lato scoperto.

    **File:** `lib/maker/chiusura-rapida.js` (nuova `pianificaRiposizionamentoScoperto`) ·
    `lib/maker/auto-close.js` (stadio 4 in fondo a `completaCoppia`, con audit
    `riposizionamento-scoperto-{lato-posseduto,controparte}-{piazzato,reject-*}`).

    **Verifica.** `chiusura-rapida.test.js` **72/72**. Suite **149 eseguiti, 143 verdi**, i 6 rossi sono i
    preesistenti del punto 40. `npm run build` verde.

    **Riavvio: NON eseguito** (§2 regola 2) — `pm2 restart agent40-manual-reprice`.

52. **IL MERGE ON-CHAIN NON HA MAI FIRMATO: `deps.signerProvider` NON ERA CABLATO — CORRETTO in `main`
    il 9 agosto 2026, ~07:05 UTC. ASPETTA IL RIAVVIO DI agent40.**

    **La causa, in una riga.** `auto-close.js:326-327` costruiva la chiamata al relayer così:

    ```js
    ((a) => require('./ctf-relayer').mergePosition(a.marketId, a.size, { negRisk: a.negRisk }))
    ```

    Nessun `deps`. `mergePosition` inoltra `opzioni.deps || {}` (`ctf-relayer.js:473`), quindi `esegui`
    arrivava a `await deps.signerProvider()` (`ctf-relayer.js:411`) con un **oggetto vuoto** e sollevava
    `TypeError: deps.signerProvider is not a function`.

    **Misurato, non dedotto.** Sul mercato Dallas 98-99°F (`cid_a7245f90…`, coppia completa per 36,3
    share) fra le **06:11:05 e le 06:32:00 UTC**: **21 tentativi**, uno ogni ~65 secondi, tutti falliti
    con quel messaggio. La forma dell'incidente nel giornale è la cosa da riconoscere:

    | riga | quante |
    |---|---|
    | `fase:'intento'` (canale `ctf-relayer`) | una per tentativo |
    | `fase:'esito'` | **zero** |
    | `merge-livello-1` con `azione:'merge'`, `eseguito:true` | una per tentativo |

    Il nonce **veniva letto davvero** dal relayer prima di ogni fallimento — quindi le credenziali erano
    buone e l'interruttore era acceso. La decisione era giusta, il cablaggio no.

    **PERCHÉ RIUSARE IL FIRMATARIO DELLA CORSIA MANUALE È SICURO** — verificato on-chain, sola lettura,
    con `scripts/maker-wallet-preflight.ts`:

    | | |
    |---|---|
    | SIGNER in custodia (`live-providers.makerSignerProvider`) | `0x7bd09f34…85d3` |
    | `POLYMARKET_RELAYER_API_KEY_ADDRESS` in `.env` | `0x7bd09f34…85d3` ← **lo stesso** |
    | PROXY/funder che tiene i token da fondere | `0x4C81F1…bdee` (owner: il signer) |

    Stesso wallet, stesso scopo. Il proxy portava **pUSD 606,283753** e tutte le approvazioni CTF a
    `PASS`. **Non è stato aggiunto un controllo di coerenza** in `auto-close`: ce n'è già uno in
    `ctf-relayer.js:415-417`, che ricava l'indirizzo dalla chiave e rifiuta di firmare se non coincide
    con quello delle credenziali. Un secondo controllo sarebbe una seconda verità da tenere allineata.

    **Il fix.** Solo il wiring — `negRisk` e la costruzione della transazione non sono stati toccati:

    ```js
    ((a) => require('./ctf-relayer').mergePosition(a.marketId, a.size, {
      negRisk: a.negRisk,
      deps: { signerProvider: require('./live-providers').makerLiveProviders().signerProvider },
    }))
    ```

    Si passa **solo** `signerProvider`: è l'unica dep che `esegui` chiede per firmare — le intestazioni
    del relayer se le prende da `.env` con `credenziali()` — e `credsProvider` è della corsia ordini.
    `require` **differito**, come quello del relayer: chi non fonde non carica nemmeno la custodia.

    **File:** `lib/maker/auto-close.js:326-352` (solo il ramo di default di `fondiCoppia`).

    **Verifica.** Nuovo `lib/maker/merge-firma-cablata.test.js` **42/42**, e prova che **senza** il fix
    fallisce (7 rosse). Non è un test di forma: con `http` iniettato e le chiavi pubbliche di Hardhat
    produce una **firma EIP-712 vera**, la rimanda a `ethers.verifyTypedData` e verifica che l'indirizzo
    ricavato sia quello atteso — cioè che il relayer riceva un firmatario **funzionante**, non solo
    presente. Copre anche: il rifiuto quando la chiave non corrisponde alle credenziali (e che in quel
    caso **niente** viene inviato), che il cablaggio **non invoca** il firmatario (nessuna decifratura per
    costruire la chiamata), e che quello passato è **identicamente** `live-providers.makerSignerProvider`
    — non un secondo firmatario. Il giornale di produzione **non viene toccato**: il modulo di audit è
    sostituito nella `require.cache`, il che permette anche di asserire le righe.

    Suite: **150 eseguiti, 144 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde,
    `BUILD_ID` nuovo alle 07:07.

    **Riavvio: NON eseguito** (§2 regola 2) — `pm2 restart agent40-manual-reprice`. Da quel riavvio la
    coppia Dallas viene fusa al primo giro utile: **36,3 share → $36,30 di collaterale liquido subito**,
    a costo zero (il gas lo paga il relayer). Sarà la **prima operazione on-chain automatica** di questo
    stack.

    **RESTA APERTO, e non è coperto da questo fix.** Le size della coppia Dallas sono **diverse**: NO
    39,7 contro YES 36,3. Il merge fonde il minimo e lascia **3,4 share di NO scoperte**; il Livello 2
    vorrebbe comprare le 3,4 mancanti ma è **sotto il minimo del venue (20)**, quindi
    `merge-saltato-rinuncia` a ogni giro. Quel residuo non si chiude da solo.

53. **I TETTI DI CAPITALE ERANO FERMI AL CAPITALE DI TRE ORE PRIMA, E IL 90% ERA IRRAGGIUNGIBILE PER
    COSTRUZIONE — CORRETTO in `main` il 9 agosto 2026, ~07:35 UTC. ASPETTA IL RIAVVIO DI agent41.**

    **L'aritmetica che nessuno aveva fatto.** `data/maker-allocated-capital.json` la scriveva **solo** il
    ciclo fisso da 6h, dopo un reset riuscito (`realloc-cycle.js:479`). Il mini-ciclo ricalcola un piano
    fresco ogni ~10 minuti e non l'ha **mai** scritta. Alle 06:37 la fotografia era ancora quella delle
    **03:42**: dodici mercati, `capital: 600`, tetti che sommavano **esattamente $600**. Nel frattempo il
    capitale era **$850,82**.

    ```
    utilizzo massimo teorico = 600 / 850,82 = 70,5%      obiettivo = 90%
    ```

    Il riallocatore dichiarava «utilizzo 28,7%, mancano $521,20» e si fermava con «nessun mercato del
    piano ha spazio sufficiente adesso» — **27 giri su 259**. Il deficit era vero, ma **nessun piano
    poteva colmarlo**: lo spazio veniva misurato contro i tetti di un capitale che non esisteva più.

    **Il secondo effetto, sullo stesso file.** Un mercato che il piano fresco sceglieva e la fotografia
    vecchia non conosceva restava **senza tetto**, e a valle un tetto assente vale «nessuna esposizione
    nuova». È l'origine di `saltato-tetto-non-leggibile`, **dieci volte su Dallas** — il mercato su cui
    tenevamo una coppia completa (§5 punto 52).

    **Il fix, e le tre scelte che porta.** La regola sta in `TRIG.decidiTetti` (puro, non tocca il
    disco); il cablaggio è in `miniCiclo` al passo **4-bis**, prima che le gambe partano.

    | scelta | perché |
    |---|---|
    | **unione, non sostituzione** | `writeAllocatedCapital` sostituisce tutta la mappa, ed è giusto per chi parla a nome dell'intero piano — il ciclo da 6h, che prima cancella e poi ripiazza. Il mini-ciclo non è quello: se scrivesse le sue sole righe, ogni mercato fuori dal ricalcolo di quel giro perderebbe il tetto **ogni dieci minuti**. Stessa disciplina «solo acquisire» del punto 41. |
    | **si pota solo il vuoto** | Un mercato fuori dal piano e **senza denaro nostro** (nessun ordine a riposo, nessuna posizione) esce. Uno dove c'è del nostro denaro non esce **mai**. Se le posizioni non si leggono, **non si pota niente**. |
    | **non si riscrive a ogni giro** | `ageSec` viaggia insieme al tetto in ogni verdetto a valle: un file che cambia di continuo rende impossibile sapere quando un tetto è stato deciso davvero. Si scrive solo per un mercato in più, un tetto oltre **5% e $1** insieme, un capitale totale oltre le stesse soglie, o una fotografia più vecchia di **12 h** (sotto le 24 h in cui `readAllocatedCapital` la dichiara scaduta — così un ciclo da 6h fermo non fa scadere tutto, e il motivo `rinfresco` lo rende visibile). |

    Le righe di un piano **salvato** vengono clampate al tetto di concentrazione del capitale di adesso
    (20%): furono decise contro un capitale di allora, che può essere stato più grande. Il verso è sempre
    verso il basso.

    **Il ciclo da 6h non è stato toccato** — resta l'unico a sostituzione piena — e `allocated-capital.js`
    resta con **una** semantica sola: l'unione la costruisce chi ne ha bisogno.

    **File:** `lib/maker/trigger-capitale-fermo.js` (nuova `decidiTetti` + `TETTI_DELTA_FRAC` 0,05 ·
    `TETTI_DELTA_USD` 1 · `TETTI_ETA_MAX_MS` 12 h) · `agents/agent41-realloc-scheduler.js:95` (import) e
    passo 4-bis in `miniCiclo`, con `deps.leggiTetti` / `deps.scriviTetti` iniettabili.

    **⚠ UNA TRAPPOLA APERTA DA QUESTO CAMBIO, e chiusa.** Da adesso `miniCiclo` **scrive** i tetti, quindi
    ogni test che lo guida senza iniettare `scriviTetti` riscrive il file **VERO**. È successo davvero
    mentre si scriveva il fix: una suite ha lasciato `data/maker-allocated-capital.json` con i mercati
    finti `0xaa/0xbb/0xcc` e `capital: 600` — cioè **nessun tetto per nessun mercato reale**, che a valle
    vale «nessuna esposizione nuova» ovunque. Il file è stato **ripristinato** dal backup
    (`by: allocation-plan`, 12 mercati, 03:42:31) e ri-verificato identico dopo una suite intera.
    `miniciclo-prende-il-mercato.test.js` e `passate-mini-ciclo.test.js` ora iniettano entrambe le
    dipendenze, e `tetti-dal-miniciclo.test.js` **asserisce che lo facciano**.

    **Verifica.** Nuovo `lib/maker/tetti-dal-miniciclo.test.js` **65/65**: il caso vero $600 → $850,82
    (i tetti risalgono a $906, sopra i $765,74 che il 90% richiede), Dallas che passa da «non compare nel
    piano» a un tetto leggibile **end-to-end su un file vero**, la stabilità fra giri, l'unione e la
    potatura, il clamp, i rifiuti fail-closed, e il mini-ciclo **vero** guidato dal vivo. Suite: **151
    eseguiti, 145 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde.

    **Riavvio: NON eseguito** (§2 regola 2) — `pm2 restart agent41-realloc-scheduler`.

54. **LA REGOLA GENERALE DEL LATO SCOPERTO — decisa da Diego il 9 agosto 2026, in `main` alle ~08:05 UTC.**

    Non è una correzione per Dallas: è il principio con cui il bot tratta **qualunque** lato posseduto
    senza controparte, **a prescindere dalla causa** — un fill originale, il residuo di un merge parziale,
    ciò che la chiusura rapida non ha coperto, o una causa che ancora non esiste.

    | # | regola | dove vive |
    |---|---|---|
    | 1 | riposiziona il lato posseduto a **+1% dal carico**, sempre dentro la banda premiante, **mai sotto il carico** | `chiusura-rapida.pianificaRiposizionamentoScoperto` |
    | 2 | apri **contestualmente** il limit uguale e contrario sulla controparte mancante | idem |
    | 3 | se la quantità è **sotto il minimo piazzabile**, accumulala in un registro per mercato/lato invece di lasciarla bloccata e silenziosa | **`lib/maker/accumulo-residui.js`** (nuovo) |

    **UN SOLO PUNTO DI CONVERGENZA, ed è ciò che lo rende un principio.** Tutti i modi di *non* aver
    coperto un lato finiscono già in fondo a `completaCoppia`, all'esito `rinuncia`
    (`auto-close.js:765`): i Livelli 1 e 2 del merge, la chiusura rapida, il riposizionamento scoperto.
    Il residuo di un merge **parziale** non ha bisogno di un percorso suo — vive sull'altro lato, dove
    `manca > 0`, e il giro successivo lo porta esattamente lì. Quindi la registrazione sta in **una**
    funzione (`segnalaScoperto`) chiamata da due esiti terminali, non in tre punti che possono divergere.

    **IL MINIMO È DEL VENUE, ED È PER MERCATO — non 20, e non nostro.** Misurato sul board vivo (108
    mercati): `min_incentive_size` vale **20** su 65, **50** su 26, **100** su 4, **200** su 13. Arriva
    dal catalogo premi (`rewardsMinSize` → `manual-order.js:316` → `rules.minSize`). Nel senso stretto di
    Polymarket significa «sotto questa size non maturi reward» (`venue-rules.js:86`: *earns nothing*),
    ma nel **nostro** stack `BELOW_MIN_SIZE` è **bloccante**: `splitVerdict` declassa ad avviso soltanto
    `OUT_OF_BAND`. Scelta deliberata e **non toccata** — un ordine sotto il minimo immobilizzerebbe
    capitale per un premio che vale zero. Il registro risolve il problema che quel vincolo lascia aperto:
    dove finisce la quantità che non si può piazzare.

    **PERCHÉ NON SI SOMMANO LE OSSERVAZIONI, ed è la scelta meno ovvia.** «Accumulare» non è addizionare
    una riga a ogni giro. Ogni osservazione misura l'**intera** quantità scoperta di quel mercato/lato in
    quel momento (`sizePosseduta − sizeAltroLato`), non un incremento: sommarne due conterebbe due volte
    la stessa cosa e il registro direbbe che siamo scoperti del doppio. Si tiene quindi l'**ultima**
    osservazione come verità corrente, con la storia delle `voci` accanto — è lì che si legge che il
    residuo è cresciuto da 3,4 a 21,6 share, con quali cause e quando. La somma di residui diversi sullo
    stesso mercato/lato **avviene già nel mondo**: la posizione li contiene entrambi, e arrivano qui come
    una singola osservazione più grande. Fra mercati diversi non si somma, e non si potrebbe: un ordine
    vive su un mercato solo.

    **Il rilascio non ha un percorso speciale.** Quando la quantità raggiunge il minimo la voce diventa
    `pronto`, e da lì il meccanismo generale smette da solo di rifiutarla — il rifiuto *era* `size <
    minSize`. Il registro **non piazza e non cancella niente**: tiene il conto e lo rende visibile, ed è
    proprio il fatto che non piazzi a renderlo sicuro (nessuna seconda politica di quando si compra).

    **Non è `residui-sotto-soglia.js`**, che esiste e serve ad altro: quello registra **ordini** in
    scadenza col residuo sotto il minimo, chiave `orderId`, finestra di visibilità 30 minuti, per la
    dashboard. Qui la chiave è **`mercato:lato`**, non c'è finestra, e l'oggetto è una **posizione**
    scoperta che aspetta di poter essere coperta. Due domande diverse, due registri.

    **File:** `lib/maker/accumulo-residui.js` (nuovo) · `lib/maker/auto-close.js` (`segnalaScoperto` in
    `completaCoppia`, chiamato da `rinuncia` e da `coppia fusa`) · `agents/agent40-manual-reprice.js`
    (l'unica scrittura su disco; `auto-close` resta puro e non sa che esiste un file). Registro in
    `data/residui-scoperti.json`, voci potate dopo **48 h** senza conferme.

    **Vincoli duri non toccati, e il test lo verifica:** `mai-primo-sul-libro`, la banda premiante, il
    «mai sotto il carico». Senza `deps.registraResiduo` cablato il comportamento è **identico** a prima:
    il registro è un'osservazione, non un gate.

    **Verifica.** Nuovo `lib/maker/lato-scoperto-principio.test.js` **57/57**: il caso Dallas (3,4 share
    dopo il merge parziale ⇒ accumulate con `manca: 16.6` e $1,80 di capitale fermo quantificato), due
    residui sullo stesso mercato/lato che salgono a 21,6 e diventano piazzabili, lo **stesso** codice su
    un fill scoperto normale con soglia 50 invece di 20, e `completaCoppia` **vero** che segnala invece di
    tacere. Suite: **152 eseguiti, 146 verdi**, i 6 rossi sono i preesistenti del punto 40.
    `npm run build` verde.

55. **IL TETTO DELLA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA — corretto in `main` il 9 agosto 2026,
    ~08:35 UTC. ASPETTA IL RIAVVIO di agent40 e agent41.**

    Il fix del punto 42 fa sì che una gamba cancellata non bruci la sua chiave: la sostituzione ne riceve
    una nuova, derivata dall'id dell'ordine morto. Le sostituzioni formano una **catena**, e la catena
    aveva un tetto di **64 anelli**. Alle 08:10 la gamba di uscita su Dallas (SELL 39,7 @ 0,54) aveva una
    catena di **esattamente 64** — misurata sul giornale vero — cioè murata:

    ```
    AUTO-CLOSE FALLITA · NO SELL 39.7 @ 0.54 su carico 0.53 (+1c/share)
    gate=idempotent-duplicate … (catena di sostituzioni oltre 64 anelli)
    ```

    **Perché cresce così in fretta, e non è un difetto:** un'uscita a riposo viene ricancellata e
    ripiazzata a ogni giro di auto-close (~65 s) quando il mid si muove. **Un anello al minuto**: 64
    anelli sono poco più di un'ora, quindi qualunque posizione che duri mezza giornata li esaurisce.

    **Fix: `MAX_CATENA` 64 → 20.000** (`lib/safety/execution-audit.js`), circa **due settimane** di
    ricambio continuo. Il tetto non protegge dal costo — 20.000 anelli si percorrono in **~80 ms**,
    misurato dal test — ma da un giornale corrotto. **Il confine utile è 19.999**: il ciclo spende
    un'iterazione per anello trovato e gliene serve una in più per accertare che la coda sia libera.

    **LA PROTEZIONE ANTI-DOPPIO-INVIO NON È IL TETTO** ed è intatta: è la verifica che l'ordine
    precedente sia MORTO sul venue, e vale a **ogni singolo anello**. Alzare il tetto non rende
    ripiazzabile nulla che prima non lo fosse — rende raggiungibile la fine di una catena troppo lunga.
    Il test lo prova a profondità 1, 64, 500 e 5000: con l'ultimo ordine **vivo** si rifiuta sempre.

    **La risposta durevole non è un numero più grande**, e va detto: è la **rotazione del giornale** (o
    un indice della coda per chiave economica). Non fatta qui perché tocca il formato del giornale, che è
    la fonte di verità dell'idempotenza.

56. **IL LIVELLO 3 USCIVA IN SILENZIO — corretto il 9 agosto 2026, stesso commit.** Il principio del
    punto 54 dice «qualunque lato scoperto, qualunque causa», ma `completaCoppia` restituisce
    `non-applicabile` **prima** di `segnalaScoperto` quando il livello non è 1 o 2. Misurato su London
    19°C (`cid_cf92c777`): Livello 2 scaduto da **546 minuti** contro un limite di 60, completamento
    cancellato, e 21,18 share NO restavano scoperte **senza** che il registro ne sapesse niente. Un
    timeout è una causa come le altre: ora quel ramo registra prima di uscire.

57. **CINQUE MERCATI FINTI NEI DATI VIVI — rimossi il 9 agosto 2026.** `0xaaa`…`0xeee`, scritti alle
    02:57:51 da `riallocatore · trigger capitale fermo` (residuo di una suite che guidava il mini-ciclo
    senza iniettare le scritture di stato — la stessa classe di trappola del punto 53). Erano in **tre**
    file, non uno: `maker-auto-close.json` (48→43), `maker-manual-mode.json` (63→58),
    `maker-auto-reprice.json` (65→60). Producevano cinque `rules-unreadable` per giro senza altro
    effetto. Rimossi con scrittura atomica, backup preso prima; `global`/`updatedAt` intatti. Verificato
    che non fossero referenziati da `maker-manual-markets.json` né da `maker-allocated-capital.json`.

    **Come riconoscerli:** un `conditionId` vero è `0x` + **64** esadecimali. Qualunque chiave più corta
    in questi file è un residuo di test.

58. **🔴 IL CAPITALE ERA CONTATO DUE VOLTE — BUG DI SICUREZZA OPERATIVA, non estetico. Corretto in
    `main` il 9 agosto 2026, ~10:00 UTC. ASPETTA IL RIAVVIO di agent40 e agent41.**

    `misuraUtilizzo` sommava tre fonti come indipendenti — `saldo + ordiniARiposo + posizioni` — ma non
    lo sono e non lo sono mai:

    - un **BUY** a riposo è coperto dal **cash**. Su Polymarket l'ordine è firmato off-chain e il
      collaterale **resta nel wallet fino al match**: il saldo pUSD **non scende** quando lo si mette.
    - un **SELL** a riposo è coperto dai **token**, cioè dalla posizione: già dentro `posizioniUsd`.

    `ordiniARiposoUsd` è quindi un **sottoinsieme** di `saldo + posizioni`, mai un addendo.

    **Misurato con lettura on-chain del funder il 9 agosto 2026:**

    ```
    cash $633,90 + posizioni $35,19 = $669,09   ← esattamente il Portfolio dell'app Polymarket
    il sistema dichiarava            $776,65    ← +$107,46, cioè +16,1%
    ```

    **PERCHÉ NON ERA ESTETICO — due conseguenze operative.**
    1. `liberoUsd` riportava il **saldo pieno** come impegnabile, mentre $107,46 erano già promessi a
       ordini sul libro. Il trigger a capitale fermo decide **su quel numero** quanto piazzare
       (`obiettivoUsd`, `disponibileUsd`): poteva puntare a impegnare capitale già impegnato altrove.
    2. Il tetto di concentrazione è il **20% del totale**: gonfiare il totale **allarga un limite di
       rischio**. Il 9 agosto valeva **$155,33** invece di **$133,82** — il 16% più permissivo del
       dichiarato, sullo stesso vincolo che `concentration.js` esiste per non far divergere.

    **Il fix.**
    - `utilizzo-capitale.js`: `totale = saldo + posizioni`; `libero = max(0, saldo − ordiniARiposo)`;
      `impegnato = totale − libero`, **derivato** e non sommato a parte, così le due misure non possono
      divergere. `saldoUsd` e `ordiniARiposoUsd` restano esposti accanto: «quanto ho in cassa» e «quanto
      posso impegnare» sono due domande diverse, e confonderle **era** il difetto.
    - **Deliberatamente conservativo:** si sottrae l'intero nozionale a riposo dal cash anche se la parte
      SELL è coperta dai token. Senza la scomposizione per lato non si possono separare, e sbagliare in
      difetto qui vuol dire piazzare **meno** — il verso sicuro.
    - `agent41`: `obiettivoUsd` e `disponibileUsd` (in **tutti e tre** i punti di pianificazione) usano
      ora `liberoUsd`, non il saldo grezzo. Il ripiego per il capitale totale non somma più gli ordini.
    - `trigger-capitale-fermo.js`: **corretto il commento falso** che aveva originato tutto («un ordine
      BUY a riposo immobilizza il collaterale: quei dollari non sono nel saldo»). È marcato come
      affermazione smentita, non cancellato, perché è la radice dell'errore.

    **L'utilizzo vero è PIÙ ALTO di quello che si leggeva** — il denominatore era gonfiato più del
    numeratore: 21,3% invece di 18,4% sui numeri del 9 agosto.

    **I tetti si riscrivono da soli.** Quelli scritti stamattina portano `capital: 776,65`; il salto al
    valore vero (~$669) è **−13,8%**, oltre la soglia del 5% di `decidiTetti`, quindi il primo mini-ciclo
    dopo il riavvio li rifà. Nessuna forzatura necessaria.

    **Due test preesistenti sono stati corretti, non silenziati:** `capitale-al-lavoro` e
    `apertura-guidata-dal-target` avevano fixture con `ordiniARiposo > saldo`, uno stato **impossibile**
    per la parte BUY. Il cash è stato alzato del nozionale a riposo, così totale, impegnato e percentuali
    restano identici e il punto dei test non cambia.

    **Verifica.** Nuovo `lib/maker/capitale-senza-doppio-conteggio.test.js` **31/31**. Suite: **154
    eseguiti, 148 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde.

    **Riavvio: NON eseguito** — `pm2 restart agent40-manual-reprice agent41-realloc-scheduler`.

59. **⚠️ L'UNICA ECCEZIONE A «MAI PRIMI SUL LIBRO» — mirata, circoscritta, decisa da Diego il 9 agosto
    2026. In `main` alle ~10:30 UTC. ASPETTA IL RIAVVIO di agent40.**

    **Il problema.** Quando la banda premiante scende sotto il prezzo di carico, il lato posseduto non si
    può quotare — «mai sotto il carico» è duro — e la posizione resta **direzionale, senza premi, a tempo
    indeterminato**. Il 9 agosto era lo stato di **tre** posizioni su cinque: Houston (banda 50¢ / carico
    55¢), London 18°C (63¢ / 65¢), London 19°C (48¢ / 59¢), tutte con `skip-no-target`.

    **La regola.** In quel caso — e **solo** in quel caso — la controparte mancante smette di essere una
    quota che aspetta e diventa **lo strumento che chiude la coppia**. Quindi:
    1. size **esattamente uguale e contraria** al lato posseduto (è `manca`, uguale per costruzione);
    2. **primo assoluto** sul libro dentro la banda — il prezzo più vicino al mid disponibile in banda,
       anche scavalcando chi è già in coda.

    **Il compromesso, accettato esplicitamente:** qualche centesimo per azione per stare in cima alla
    coda invece che in fondo, in cambio di una chiusura rapida invece di un blocco indefinito.

    **PERCHÉ RESTA CIRCOSCRITTA, ed è la parte che conta.** «Mai primi sul libro» è `spec.inCoda`, ed è
    **opt-in per chiamante** (`manual-order.js:879`): la regola si applica solo a chi la dichiara, e il
    rifiuto `mai-primo-sul-libro` vive **dentro** quel ramo. La deroga è quindi l'omissione di un flag su
    **una gamba sola**, non una modifica alla regola — che non è stata toccata di una riga e continua a
    valere ovunque altro, incluse tutte le altre gambe di `auto-close`.

    Il gancio è `primoAssoluto`, che `pianificaRiposizionamentoScoperto` marca **solo** quando il lato
    posseduto tace **per banda-sotto-carico**. Un silenzio per qualunque altro motivo (size sotto il
    minimo, carico illeggibile, banda assente) **non** apre la deroga, e senza la banda della controparte
    non si apre comunque: si torna al prezzo da tetto, cioè al comportamento di prima.

    **Cosa non cambia:** il lato **posseduto** resta protetto dal «mai sotto il carico» — la deroga è
    legata a `!vende`, quindi non può raggiungerlo nemmeno per errore — e il **tetto della coppia (110¢)**
    resta duro: si prende il **più basso** fra bordo banda e tetto, mai il più alto.

    **L'aggancio al merge è automatico e non ha percorso nuovo:** se la controparte viene fillata, al giro
    dopo `decidiLivello` risponde `azione:'merge'` (`mancaAllaCoppia <= 0`) e cade nel ramo già collegato
    al relayer. Verificato nel test.

    **File:** `lib/maker/chiusura-rapida.js` (`bandaHiControparte`, `bandaSottoCarico`, `primoAssoluto`
    sulla controparte) · `lib/maker/auto-close.js` (banda dell'altro libro + `inCoda` omesso su quella
    sola gamba, con la nota nell'ordine e `primoAssoluto` nell'audit).

    **Verifica.** Nuovo `lib/maker/controparte-primo-assoluto.test.js` **27/27**: prezzo al bordo banda,
    size uguale e contraria, il tetto che vince sul bordo, e **quattro** casi in cui l'eccezione NON si
    apre. Sweep su 60 combinazioni: **zero** prezzi del lato posseduto sotto il carico o fuori banda.
    Un'asserzione di `chiusura-rapida.test.js` è stata **aggiornata, non allentata**: pretendeva la
    stringa letterale `inCoda: true` su entrambe le gambe; ora verifica l'intento vero («mai taker») e la
    nuova semantica. Suite: **155 eseguiti, 149 verdi**, i 6 rossi sono i preesistenti del punto 40.
    `npm run build` verde.

60. **«PRIMO ASSOLUTO» SI MISURA SUL LIBRO, NON SULLA BANDA — corretto il 9 agosto 2026, ~11:00 UTC.
    ASPETTA IL RIAVVIO di agent40.**

    Il punto 59 prezzava la controparte al **bordo della banda**, e in produzione non ha piazzato
    niente. Misurato alle **10:25**, subito dopo il riavvio:

    ```
    riposizionamento-scoperto-controparte-reject-would-cross          x4
    riposizionamento-scoperto-controparte-reject-mai-primo-sul-libro  x1
    ```

    Il bordo banda non ha nessuna relazione con dove sono gli altri: su Chengdu il prezzo da tetto era
    **48¢** e stava **oltre il miglior ask**, quindi l'ordine avrebbe attraversato lo spread e
    `manual-order` lo rifiuta (non dichiara `attraversaApposta`).

    **La correzione.** Essere primi in coda su un BUY vuol dire stare **un tick sopra il miglior bid
    altrui**, e per restare maker bisogna stare **sotto il miglior ask**. Il prezzo è il più **basso**
    fra tre limiti, ognuno per una ragione diversa: `bestBid + tick` (scavalca la coda, è lo scopo) ·
    `bestAsk − tick` (non attraversa) · `massimo` (tetto 110¢, resta **duro**). La profondità è
    `dpMerge[altroBook]`, già in scope per il Livello 1: **nessuna lettura nuova del venue**.

    **La banda non è fra i limiti**, ed è deliberato: restarci è preferibile ma non è un divieto —
    `OUT_OF_BAND` è l'unico codice che il sistema declassa ad avviso — e la priorità dichiarata
    dall'operatore è scavalcare la coda. Il piano riporta `fuoriBanda` quando succede.

    **ESTESO ANCHE AL PERCORSO NORMALE, ed è una decisione mia.** Su Chengdu `primoAssoluto` era
    **falso** — la banda stava sopra il carico — eppure l'ordine incrociava lo stesso: il difetto non era
    solo del caso nuovo. Il clamp `bestAsk − tick` si applica quindi **sempre** a questa gamba, che è un
    limit che aspetta e non deve mai diventare taker. Il clamp può solo **abbassare** il prezzo, quindi
    non apre niente e non tocca il tetto.

    **Verifica sui numeri VERI dei mercati bloccati** (`controparte-primo-assoluto.test.js` **41/41**):

    | mercato | carico | prima | adesso | esito |
    |---|---|---|---|---|
    | Chengdu | 61,64¢ | 48¢ → `would-cross` | **46¢** | limit maker, eccezione non aperta |
    | Houston | 55¢ | muto | **43¢** (bid 42¢ +1 tick) | primo assoluto, in banda |
    | London 18°C | 65¢ | muto | **34¢** (bid 33¢ +1 tick) | coppia 99¢ ≤ 110¢ |
    | London 19°C | 59¢ | muto | **40¢** (bid 39¢ +1 tick) | coppia 99¢ ≤ 110¢ |

    Nessuno dei quattro attraversa più lo spread. Suite: **155 eseguiti, 149 verdi**, i 6 rossi sono i
    preesistenti del punto 40. `npm run build` verde.

61. **IL BOT NON VEDEVA IL LIBRO DEI MERCATI IN CUI AVEVA DEI SOLDI — corretto il 9 agosto 2026,
    ~12:00 UTC. ASPETTA IL RIAVVIO di agent34.**

    `agent34-clob-ws` aveva **quattro** corsie di sottoscrizione — board premi, tracking, piano, permessi
    temporanei — e **nessuna guardava le posizioni**. Misurato alle 11:32, dopo un riavvio **pulito**
    (quindi non è staleness: lo snapshot era fresco, 97 mercati):

    | mercato | posizione | perché era cieco |
    |---|---|---|
    | London 18°C | 23,15 share | **fuori dal board**: uscito dal tabellone, il libro se n'è andato con lui |
    | Chengdu | 21,69 share | **sul board ma tagliato**: `SUBSCRIPTION_CAP = 90` contro 105 mercati |

    **Due cause diverse, stesso effetto, una sola cura:** entrambi avevano una posizione aperta, quindi
    una corsia «posizioni» li recupera **senza toccare nessun tetto** — che è la ragione per cui ho
    scelto questa strada invece di alzare `SUBSCRIPTION_CAP`.

    **A valle non era teorico:** senza libro dell'altro lato `pianificaRiposizionamentoScoperto` non può
    sapere davanti a chi mettersi, e il completamento della coppia veniva rifiutato con `would-cross` a
    ogni giro (§5 punto 60). Il fix del prezzo era corretto e **inerte** per mancanza di dati.

    **Fonte riusata, non inventata:** `readVenuePositions`, lo stesso snapshot che agent40, agent41 e
    agent43 già leggono. Priorità pari al tracking, **sopra** piano e permessi temporanei: se serve
    spazio si cede un mercato del **board** (il più povero), mai uno dove c'è capitale nostro. Le
    posizioni sono poche per costruzione (5 il 9 agosto contro un budget di 125 mercati). Fail-closed:
    snapshot illeggibile ⇒ corsia **vuota**, non «nessuna posizione»; size ≤ 0 non sottoscrive.

    **SUBSCRIPTION_CAP NON è stato alzato, ed è una scelta.** 90 su 105 taglia 15 mercati del board, ma
    `TOTAL_MARKET_CAP` (125) deriva da `FEED_ASSET_BUDGET` = 250 asset su una connessione — che il file
    stesso dichiara **budget nostro, non limite del venue** (ri-verificato 2026-07-31: il venue non
    documenta un massimo). Alzarlo è possibile ma cambia il carico di una connessione sola, e non ho un
    modo di validarlo qui. **Resta aperto**, e i 15 mercati tagliati sono i più poveri del board.

    **File:** `agents/agent34-clob-ws.js` (`unionPositionMarkets`, chiamata prima di piano e permessi).

    **Verifica.** Nuovo `lib/maker/sottoscrizione-posizioni.test.js` **21/21**, con i `conditionId`
    **veri** dei mercati ciechi. Suite: **156 eseguiti, 150 verdi**, i 6 rossi sono i preesistenti del
    punto 40. `npm run build` verde.

62. **VISTI MA INTOCCABILI — la TERZA volta della stessa lacuna, il 9 agosto 2026, ~12:20 UTC.
    ASPETTA IL RIAVVIO di agent40 e agent41.**

    Tre volte nello stesso giorno una lista ha seguito il **tabellone** invece di «tabellone ∪ mercati
    con posizione aperta»: prima il catalogo dei metadati, poi la sottoscrizione del book (punto 61),
    infine la **allowlist che il gate `live-min` legge**. Misurato alle 11:48, subito dopo aver reso
    London 18°C e Chengdu di nuovo visibili nel book:

    ```
    riposizionamento-scoperto-controparte-reject-live-min-market-mismatch  x4
    {"book":"yes","side":"BUY","price":0.38,"size":21.69}   ← prezzo giusto, mercato non consentito
    ```

    **Non allarga il perimetro di rischio, e va detto con precisione:** aggiunge solo mercati dove il
    capitale è **già esposto**. Non apre un mercato nuovo — apre la *gestione* di una posizione che
    esiste. È lo stesso verso per cui `evaluateReductionProof` lascia passare fuori allowlist un ordine
    che riduce. Fail-closed come le altre due volte: snapshot illeggibile ⇒ **nessuna** aggiunta; e resta
    subordinata all'interruttore generale (`globalEnabled` spento ⇒ lista vuota, posizioni o no).

    **⚠ UN ACCOPPIAMENTO NASCOSTO, trovato da un test e non da me.** La prima versione univa le posizioni
    dentro `enabledMarketIds` di `readAutoRepriceConfig` — che però legge anche il **watcher di
    riprezzo**. `end-of-scale-cycle.test.js` è diventato rosso vedendo tre mercati in più e **sei rinnovi
    invece di uno**: non un test fragile, un allargamento che non avevo previsto. L'unione vive ora in un
    campo separato, `liveMinMarketIds`, che consuma **solo** `manual-order` per costruire l'adapter;
    `enabledMarketIds` è invariato. Le due componenti restano leggibili separatamente
    (`enabledDaOperatore` / `enabledDaPosizione`): «l'operatore l'ha abilitato» e «ci abbiamo dentro dei
    soldi» sono due risposte diverse e il pannello deve poterle distinguere.

    **File:** `lib/maker/auto-reprice-config.js` (`liveMinMarketIds`) · `lib/maker/manual-order.js` (due
    punti che passano la allowlist all'adapter).

    **Verifica.** Nuovo `lib/maker/allowlist-con-posizioni.test.js` **17/17** con i `conditionId` veri.
    Suite: **157 eseguiti, 151 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde.

63. **🧹 MAKER ARMING, agent35-maker E agent37-maker-watchdog SONO STATI RIMOSSI — 9 agosto 2026,
    ~14:00 UTC, su decisione esplicita di Diego. In `main`. DUE `pm2 delete` E UN `pm2 restart`
    ASPETTANO LA SUA AUTORIZZAZIONE.**

    **Perché era possibile farlo senza perdere niente.** Le tre funzioni per cui si tiene un motore e il
    suo dead-man erano già coperte altrove, e da processi che non dipendevano da agent35:
    cancellazione d'emergenza (`/api/maker/kill` → `lib/maker/cancel-all`, percorso di sola
    cancellazione, e `agent43-guardian` sulla perdita), snapshot posizioni (agent40), gestione delle
    posizioni aperte e riallocazione (agent40 e agent41). agent35 non piazzava da giorni: quando il
    capitale è tornato al lavoro l'8-9 agosto, a piazzare erano il ciclo e il mini-ciclo di agent41.

    **Cosa è stato rimosso, per intero.**

    | | |
    |---|---|
    | processi | `agents/agent35-maker.js` · `agents/agent37-maker-watchdog.js` (+ le due `apps[]` in `ecosystem.config.js`: 42 → **40**) |
    | moduli | `lib/maker/arming.js` · `lib/maker/arm-preview.js` · `lib/maker/preflight.js` (il preflight **è** il gate di arming: la sua intestazione lo dichiara, e senza arming non aveva più chiamanti) |
    | route | `/api/maker/{arm, arm-preview, disarm, renew, gates, preflight, status}` — sette. `gates` e `status` non erano «di arming» per nome ma **lo erano per contenuto**: leggevano `/tmp/maker-state.json` (scritto da agent35), `data/maker-heartbeat.json` e `data/maker-watchdog-state.json` (di agent37) più il record di arming, quindi da oggi avrebbero risposto `null` per sempre |
    | UI | `app/components/MakerArmingPanel.tsx` · la sezione «Esecuzione» di `MarketTerminal` (passi 2-3-4: gate del motore, preflight, ARM in due tempi) · il pannello «Live status» di `MakerKillClient` |
    | stato | `data/maker-arming.json` (era `armed:false`). **`data/maker-arming-audit.jsonl` è stato lasciato**: è un registro storico, e cancellare un audit non è pulizia |
    | script | `scripts/maker-arming-selfcheck.js` · `scripts/maker-cap-dryrun.js` e `scripts/maker-seed-test-leg.ts` (esistevano per provare/alimentare il motore) |
    | test | `lib/maker/dead-man-per-motore.test.js` (il suo soggetto era agent37) |

    **IL KILL È LA PARTE CHE CONTA, ED È INVARIATO — verificato, non affermato.** Dalla rotta è sparita
    **una** riga: `disarmArming`, che era un **parametro opzionale** di `killMaker` (`disarmArming = null`,
    invocato solo `if (typeof … === 'function')`). Il KILL faceva due cose e ne fa due: interruttore
    durevole + spazzata di cancellazione.
    - `scripts/maker-kill-selfcheck.js` **25/25**, compresa l'asserzione strutturale «la rotta non importa
      nessuna superficie di piazzamento/firma: può FERMARE, non può far PARTIRE un ordine»;
    - `lib/maker/kill-blocca-avvia.test.js` **13/13** (il kill come cancello dell'AVVIA);
    - il KILL **non è stato eseguito** contro il venue: sarebbe un'azione su capitale reale. La prova è per
      test e per lettura del codice, com'è giusto — la prova sul campo la fa Diego a costo zero.

    **AVVIA/FERMA e il ciclo automatico non sono stati sfiorati:** `bot-enabled` **36/36**,
    `trigger-capitale-fermo` **59/59**, `capitale-al-lavoro` **72/72**, `miniciclo-prende-il-mercato`
    **36/36**. Nessun file di agent40 o agent41 è nel diff.

    **DUE CONSEGUENZE DA SAPERE, entrambe volute e nessuna delle due un difetto scoperto dopo.**
    1. **Nessuno sorveglia più il battito di agent40.** Era il mestiere di agent37. Se agent40 si blocca
       con ordini a riposo, a toglierli resta la **scadenza GTD nativa** del venue (`order-ttl.js`) e,
       sul lato economico, `agent43-guardian` oltre la soglia di perdita. Era già l'unica copertura per
       la morte dell'host; da oggi vale anche per la morte del solo processo.
    2. **Il KILL è tornato fuori dalle schede.** Il pannello di arming stava sopra le schede e portava
       con sé il KILL; togliendolo, il KILL sarebbe rimasto in fondo alla sola scheda «Riepilogo». La
       barra KILL/Ripristina è stata quindi **spostata fuori** dalle sezioni di `LiquidityRewardsConsole`
       — stessi due handler, stesso endpoint, nessun comportamento nuovo — che è esattamente ciò che il
       suo commento dichiarava già di voler garantire («raggiungibili qualunque cosa si stia guardando»).

    **La policy dei permessi e l'hook NON sono stati toccati** (§2 regola 2). Le regole `ask` che
    nominano `agent35-maker`, `/api/maker/{arm,disarm}` e `maker-arming` restano: sono ormai regole che
    non possono corrispondere a niente, e toglierle sarebbe l'unica parte di questa pulizia che
    *allenta* un presidio. `policy-permessi.test.js` e `hook-piazzamento.test.js` restano verdi.

    **Un artefatto di build ha dovuto essere spostato:** `.next-verifica/` (build del 5 agosto,
    gitignored ma **incluso da `tsconfig.json`**) conteneva i tipi generati delle route rimosse e faceva
    fallire `tsc` con «Cannot find module …/arm-preview/route.js». Spostato nello scratchpad di sessione,
    non cancellato. Se un domani serve, si rigenera con la sua build.

    **Verifica.** Suite: **156 eseguiti, 150 verdi** (un file in meno: il test del dead-man), e i **6
    rossi sono esattamente i preesistenti del punto 40** — zero nuovi. `npm run build` verde,
    `BUILD_ID` nuovo e `prerender-manifest.json` presente (la nota del punto 7, che va verificata prima
    di riavviare il dashboard). Scansione finale: **zero** `require`/`import`/`fetch` verso i file
    rimossi in tutto il repo.

    **AZIONI pm2 IN ATTESA — NON ESEGUITE** (§2 regola 2). Finché non le esegui, i due processi
    rimossi dal repo **continuano a girare** con il codice che hanno già in memoria, e il dashboard
    serve il build vecchio (quindi il pannello di arming è ancora visibile e le sue route rispondono
    404 solo dopo il riavvio):
    ```bash
    pm2 delete agent35-maker
    pm2 delete agent37-maker-watchdog
    pm2 restart dashboard      # verificare PRIMA .next/prerender-manifest.json — §5 punto 7 (fatto: presente)
    pm2 save                   # altrimenti un resurrect li rimette entrambi
    ```
    `pm2 save` non è un extra: senza, il dump su disco continua a contenere i due processi e un riavvio
    del demone li resusciterebbe puntando a script che non esistono più.

64. **IL TETTO DI CREDIBILITÀ ERA UN'ATTENUAZIONE E ORA È ANCHE UN CANCELLO — in `main` il 9 agosto
    2026, ~17:45 UTC. ASPETTA IL RIAVVIO di agent41, DA CONFERMARE DA DIEGO IN CHAT.**

    **La diagnosi che l'ha motivato, misurata sui dati vivi.** Il piano vero del 9 agosto copriva il
    **99,0%** del capitale libero ($588 su $594,10) e lo faceva con **sette righe su nove capate** da
    `maxCredibleShare` e **due su book vuoto verificato**. Sette erano meteo asiatico misurato all'una-due
    di notte locale. Il piano dichiarava **$697/g di lordo — il 67% dell'INTERO montepremi di quei
    mercati** — e $259/g di «realistico» su $588, cioè il **44% al giorno**. Il board non conteneva
    qualche mercato sottile: **73 righe su 108 (68%)** avevano quota oltre il 60% a $500, 98 su 108
    avevano `thinBookFlag`, 99 su 108 erano `sane500:false`.

    **Perché un cancello e non (solo) un'attenuazione.** `credibleShareFactor` faceva la cosa giusta a
    metà: taglia la quota a 0,60 ma lascia il mercato NEL SET. Il knapsack massimizza, quindi il mercato
    tagliato vince lo stesso. **Provato dal test, e più forte di come lo avevo ipotizzato:** a cancello
    spento un mercato deserto non si limita a entrare — si prende **tutto** il budget e lascia a zero
    quello con il book vero.

    **Il fix, e le tre scelte che porta.**

    | scelta | perché |
    |---|---|
    | **la soglia è IMPORTATA, non ridichiarata** | `MAX_QUOTA_CREDIBILE = realistic-estimate.DEFAULTS.maxCredibleShare`. Due costanti per lo stesso concetto sono il difetto che il rilevatore **D1** dell'audit cerca, e qui sarebbe peggio del solito: cancello e attenuazione devono per costruzione parlare dello stesso confine. Un test lo asserisce. |
    | **il metro è FISSO a $500** | Non alla size che la riga riceverebbe: le curve si fermano al tetto di concentrazione (~$134), quindi un metro variabile renderebbe la sottigliezza dipendente dal capitale del conto. $500 è il livello che agent24 già pubblica come `levels["500"].share`, cioè la grandezza con cui la diagnosi ha contato i 73 sottili. |
    | **una sola passata di DP** | Il cancello si applica nella STESSA passata del filtro orizzonte: i due insiemi di scarti si uniscono e il knapsack rigira **una** volta invece di due. Restano due liste distinte perché i candidati devono poter dire QUALE dei due li ha tolti. |

    **`ignota` non esclude mai** — profondità non misurata o size per dollaro non calcolabile lasciano il
    mercato dov'è, la stessa regola di `horizonVerdict` su una scadenza illeggibile.

    **VERIFICA DI COPERTURA, ed era la condizione per considerare il lavoro finito.** Stesso
    `planFromCollection` del ciclo vero, stesso `RUNNER_PIANO`, finestra 6h, capitale reale $594,10,
    tetto 20%:

    | | cancello SPENTO | cancello ACCESO |
    |---|---|---|
    | allocato | $588,00 su 6 mercati | **$588,00 su 5 mercati** |
    | **copertura** | 99,0% | **99,0%** ✓ |
    | righe capate dal tetto | 3/6 | **0/5** |
    | quota delle righe scelte | 60,2% – 94,5% | **21,0% – 57,1%** |
    | lordo dichiarato | $274,06/g | $120,03/g |
    | realistico | $122,66/g | $35,09/g |
    | esclusi dal cancello | 0 | **42** (lordo apparente $1.642,49 · montepremi $3.187 · quota mediana 71,0%) |
    | superstiti / minimi per coprire | 102 / 5 | **62 / 5 = 12,4x** |

    Il crollo del lordo **non è capitale perso**: è la cifra con cui quei mercati avrebbero vinto il
    knapsack, e che non viene più contabilizzata.

    **Il rendiconto per ciclo** (requisito esplicito): `annunciaCancelloProfondita` in agent41 scrive una
    riga per ogni piano — ciclo da 6h, piano ristretto e piano leggero — con esclusi, **lordo apparente
    lasciato fuori**, montepremi, quota mediana e il rapporto **superstiti/minimi**. Sotto 1 quel rapporto
    stampa `⚠ IL CANCELLO STA AFFAMANDO IL PIANO`: è il numero che rende il cancello sicuro, e va visto
    subito invece di essere dedotto da una copertura bassa.

    **Cosa NON è stato toccato**, verificato per nome dal test: tetto di concentrazione al 20% ·
    `useCredibleShareCap` ancora acceso di difetto · `usaProfonditaVerificata` ancora acceso ·
    `horizonFilter` ancora spento di difetto · **`allocateBudget` non lo vede**, quindi i backtest restano
    invariati numero per numero · nessun modulo di `lib/maker/` nomina il cancello, cioè il piazzamento
    non è sfiorato.

    **UNA CONSEGUENZA DA SAPERE: `capVuotiFrac` diventa in pratica irraggiungibile.** Un book vuoto
    verificato ha quota 1, quindi il cancello lo prende sempre per primo e la quota di categoria non ha
    più occasione di pronunciarsi. Il meccanismo resta come seconda linea — vale ancora se il cancello
    venisse spento — e i suoi test lo coprono ancora, ma a cancello spento nel fixture.

    **Due test preesistenti sono stati AGGIORNATI, non allentati.** `punteggio-in-selezione.test.js`
    provava l'attenuazione e la quota di categoria su fixture costruite apposta con book deserti: quei
    mercati ora non arrivano più al knapsack, e tenere il cancello acceso lì non avrebbe reso il test più
    severo — lo avrebbe reso **vuoto**. I due fixture passano `filtroProfondita: false` con la ragione
    scritta accanto; il cancello ha il suo test, che verifica proprio che quei mercati NON entrino.

    **File:** `lib/rewards/profondita-minima.js` (nuovo) · `lib/rewards/allocator.js` (import, opzione
    `filtroProfondita`, la passata unica di scarti, il ramo dei candidati, il rendiconto in `selezione`) ·
    `agents/agent41-realloc-scheduler.js` (`annunciaCancelloProfondita`, chiamata dai due percorsi).

    **Verifica.** `profondita-minima.selfcheck()` **18/18** · nuovo `lib/rewards/cancello-profondita.test.js`
    **32/32** · `punteggio-in-selezione` **88/88**. Suite: **155 eseguiti, 149 verdi**, e i **6 rossi sono
    esattamente i preesistenti del punto 40** — zero nuovi. `npm run build` verde, `BUILD_ID`
    `BPaTKaN3OqPq9PvAugqRf`, `prerender-manifest.json` presente.

    **RIAVVIO ESEGUITO alle 18:19:20Z del 9 agosto 2026**, su autorizzazione esplicita di Diego in chat
    (restart **46 → 47**, pid 1301819). Verificato:
    - **ambiente intatto**: 102 variabili prima, **102 dopo**, tutte e nove le critiche presenti — il
      caricatore `.env` della fase 7 rende superflua la ricostruzione da `/proc` del punto 3;
    - **il processo gira sul codice nuovo**: commit `573b616` delle 17:45:25Z, processo avviato alle
      18:19:20Z;
    - **zero errori nuovi**: `agent41-realloc-scheduler-error.log` non viene scritto dal **2026-08-08
      15:19:15**, cioè le 13 righe `MINI-CICLO FERMATO` sono quelle storiche che il punto 21 già
      registra come «del processo vecchio»;
    - **silenzio atteso dal trigger**: con il KILL attivo il mini-ciclo esce al cancello prima di leggere
      il saldo, quindi non calcola nessun piano e non stampa niente.

    **La riga di rendiconto non è ancora comparsa, ed è corretto così:** la scrive `calcolaPiano` o
    `pianoLeggero`, e nessuno dei due gira sotto KILL. Comparirà al **prossimo ciclo fisso** (202 minuti
    dall'avvio, ~21:41Z), che calcola il piano anche a bot FERMO, oppure al primo mini-ciclo dopo che il
    KILL è stato revocato. Il contenuto del rendiconto è comunque già verificato: i campi che legge
    (`selezione.profonditaSottili`, `…LordoApparenteUsd`, `…Superstiti`) sono popolati dai piani veri
    misurati prima del riavvio.

    Il cancello era comunque **già attivo** sul pannello «Ottimizza» e su ogni piano calcolato anche
    prima del riavvio, perché il piano nasce sempre in un processo figlio che rilegge il codice da disco
    (§5 punto 14): il riavvio serviva solo per la riga di log.

65. **TETTO PER MERCATO FISSO A $130 E NESSUN LIMITE DI POSIZIONI — decisioni di Diego, in `main` il
    9 agosto 2026, ~18:50 UTC. ASPETTA IL RIAVVIO di agent41 e del dashboard.**

    **Le due decisioni, e perché stanno insieme.** Il tetto per mercato era il **20% del capitale**:
    cresceva in dollari col saldo, quindi a capitale doppio il bot metteva il doppio su OGNI mercato
    invece di usarne di più. Su $2.000 sarebbe valso $400 — dodici volte il nozionale mediano dei 21
    maker (~$34). Adesso è **$130 fissi** su YES+NO sommati, e **il numero di mercati è una conseguenza**
    (`capitale ÷ 130`) invece di un parametro. `MAX_POSIZIONI = 10` è stato rimosso perché con un tetto
    fisso quel numero smetteva di limitare il rischio e cominciava a limitare la COPERTURA — misurato:

    | capitale | righe scelte | dopo il troncamento a 10 | copertura |
    |---|---|---|---|
    | $1.200 | 10 | $1.200 | 100% |
    | $1.400 | 13 | $1.120 | **80%** |
    | $1.800 | 15 | $1.044 | **58%** |
    | $2.000 | 15 | $1.200 | **60%** |

    **IL RISCHIO CRITICO ERA LA DIVERGENZA FRA I QUATTRO PUNTI, ED È CHIUSO.** Il tetto vive in
    `lib/rewards/concentration.js` (`MARKET_CAP_FIXED_USD = 130`) e viene **importato**, mai
    ridichiarato, da tutti e quattro i consumatori:

    | # | consumatore | prima | adesso |
    |---|---|---|---|
    | a | pianificatore / knapsack (`realloc-cycle`, agent41, route del pannello) | `capitale × 0,20` | `capPerMarketUsd()` |
    | b | **motore di piazzamento**, `motore-unico.tettoMercato` (Regola 5) | costante propria `MARKET_CAP_PCT = 0.20` sul **saldo** | importa il modulo condiviso |
    | c | `decideRimpiazzo` | legge `data/maker-allocated-capital.json` scritto da agent41 | **invariato**: segue da sé, verificato |
    | d | `rischio-beneficio.js` | `1 + quota / CONCENTRATION_CAP_FRAC` | `1 + capitaleSulMercato / MARKET_CAP_FIXED_USD` |

    Il punto (b) era quello che avrebbe rotto tutto in silenzio: il pianificatore avrebbe proposto $130
    e la Regola 5 avrebbe verificato contro il **20% del saldo — $118,82** — rifiutando **ogni riga del
    piano** al momento di quotare. È lo stesso difetto che l'unificazione del 7 agosto aveva chiuso.

    **Il test critico, eseguito sui numeri veri:**
    ```
    tetto del pianificatore : $130,00
    Regola 5 su   $65,00 → ACCETTATO   cap $130,00
    Regola 5 su  $130,00 → ACCETTATO   cap $130,00     ← col vecchio 20% sarebbe stato RIFIUTATO
    Regola 5 su  $130,01 → RIFIUTATO   cap $130,00
    TUTTE le 6 righe del piano di oggi passano la Regola 5 ✓
    ```

    **Due miglioramenti che il passaggio ha portato con sé**, entrambi nella direzione sicura:
    - `capPerMarketUsd` **non restituisce più `null`**. Prima lo faceva su un capitale illeggibile, e a
      valle `null` vale «nessun tetto» (l'allocatore ripiega su `budgetUsd`): era un fail-**open** su un
      vincolo di rischio. Con un tetto fisso il numero è sempre noto.
    - **Si clampa al capitale**: con $50 in cassa il tetto scende a $50. Può solo stringere.
    - Il punteggio di rischio diventa misurabile con **un ingresso invece di due**: non serve più il
      capitale totale, che ora serve solo a riportare la percentuale nel referto.

    **Copertura verificata a capitale odierno e in proiezione** (stesso `planFromCollection` del ciclo
    vero, board filtrato dal cancello di profondità, `horizonFilter` attivo):

    | scenario | tetto | allocato | copertura | mercati | necessari | battuti |
    |---|---|---|---|---|---|---|
    | **oggi, $594,10 liberi** | $130 | **$588,00** | **99,0%** | 6 | 5 | 9 |
    | $1.000 ipotetico | $130 | $1.000,00 | 100,0% | **9** | 8 | 7 |
    | $2.000 ipotetico | $130 | $1.760,00 | 88,0% | 15 | 16 | 2 |

    A $2.000 si ferma all'88% perché **il pool qualificato si esaurisce** (2 candidati battuti su 17
    utili), non per il tetto. È noto, atteso e accettato: la risposta è più scoperta (§ soglia $10-25/g),
    non un tetto più largo.

    **Il tetto è sul MERCATO INTERO, YES+NO sommati** — misurato, non assunto: ogni riga del piano ha
    `sizePerSideUsd = capital / 2` esatto. $130 valgono quindi ~$65 per lato.

    **Cosa NON è cambiato:** il tetto TOTALE resta dinamico e segue il capitale reale
    (`utilizzo-capitale`, obiettivo 90%) — sono due domande diverse; il tetto di apertura per giro del
    mini-ciclo (`MAX_NUOVI_PER_GIRO = 6`) limita la velocità e resta; il guardiano delle perdite, la
    banda premiante, «mai primo sul libro», fine scala e il cancello di profondità non sono stati
    sfiorati.

    **File:** `lib/rewards/concentration.js` (riscritto) + `.d.ts` · `lib/maker/motore-unico.js`
    (Regola 5) · `lib/maker/realloc-cycle.js` · `agents/agent41-realloc-scheduler.js` (import, log,
    rimozione di `MAX_POSIZIONI` e del troncamento in `applicaPolitiche`) · `lib/rewards/rischio-beneficio.js` ·
    `app/api/rewards/allocate/route.ts` · `lib/audit/rilevatori.js` (il rilevatore **D1** ora sorveglia
    `MARKET_CAP_FIXED_USD` e tiene in elenco i due nomi vecchi, così una loro reintroduzione verrebbe
    vista) · 4 script diagnostici.

    **Cinque test aggiornati, non allentati** — difendevano «le due costanti coincidono», una proprietà
    che ora è strutturale, e sono stati riscritti per difendere quella nuova, più forte: «di costante ce
    n'è **una**, e i quattro consumatori la importano». `netto-centralizzato.test.js` verifica per nome
    tutti e quattro gli import; `realloc-cycle.test.js` e `motore-unico.test.js` contengono ora il test
    critico (una riga al tetto passa la Regola 5 sul saldo vero); `ingressi-del-motore.test.js` è stato
    **ritarato**: la sua fixture bloccava con $100 di saldo perché il 20% dava $20, e ora con il clamp
    il tetto è $100 e un ordine da $39 passa — cioè il comportamento voluto, non una protezione persa.

    **Verifica.** `concentration.selfcheck()` **13/13** · `motore-unico` 58/58 · `realloc-cycle` 141/141 ·
    `netto-centralizzato` 54/54 · `rischio-beneficio` 42/42 · `capitale-senza-doppio-conteggio` 30/30 ·
    `ingressi-del-motore` 46/46. `npm run build` verde.

    **Riavvii: NON eseguiti** (§2 regola 2).
    ```bash
    pm2 restart agent41-realloc-scheduler   # il tetto nel ciclo 6h e nel mini-ciclo, e la rimozione del limite
    pm2 restart dashboard                   # la route «Ottimizza» pubblica `fissoUsd` al posto di `frac`
                                            # (verificare PRIMA .next/prerender-manifest.json — §5 punto 7)
    ```
    **agent40 NON va riavviato per questo lavoro**: `decideRimpiazzo` legge il tetto da
    `data/maker-allocated-capital.json`, che lo scrive agent41 — quindi segue da sé al primo mini-ciclo
    dopo il riavvio di agent41. La Regola 5 vive invece nel processo di agent40 (`valutaMercato`), e
    finché non lo si riavvia continua a usare il codice vecchio: **con il bot su FERMA + KILL nessuna
    delle due corsie piazza**, quindi non c'è divergenza in atto — ma se un domani si riparte senza aver
    riavviato agent40, il suo percorso di riprezzo applicherebbe ancora il 20% del saldo. Da fare
    insieme agli altri due quando si decide di ripartire.

66. **LA RISPOSTA AL FILL: QUATTRO CORREZIONI, E IL CABLAGGIO CHE LE RENDE EFFETTIVE — 9 agosto 2026,
    ~20:15 UTC. agent40 RIAVVIATO su autorizzazione di Diego.**

    Il modulo puro è `lib/maker/risposta-al-fill.js`; il cablaggio vive in `auto-close.js` e in agent40.
    Nulla di ciò che esisteva è stato ricostruito: `TETTO_COPPIA_CENTS` (110¢), i livelli 1/2 del merge,
    il registro `accumulo-residui` e `completaCoppia` come punto di convergenza sono riusati intatti.

    | | cosa | dove |
    |---|---|---|
    | **(a)** | `classificaFill` — `fill-completo` (nessuna copertura) · `fill-parziale` (copertura insufficiente) · `coppia-completa` · **`ignoto`, che non fa scattare niente** | `risposta-al-fill.js`, cablato in `completaCoppia` |
    | **(b)** | ordine «rimanenza» in banda per la size residua, **in aggiunta** al registro | `pianificaRimasuglio` |
    | **(c)** | gamba contraria stessa size, esente da «mai primo» | idem, `primoAssoluto: true` |
    | **(d)** | `min(tetto in vigore, capitale libero)`, da **entrambi** i percorsi terminali | `capitalePerRiposizionamento` + il loop dei riposizionamenti |

    **IL CABLAGGIO, che è ciò che rende (d) effettivo.** `tettoMercato` (da `readAllocatedCapital`, la
    stessa fonte del rimpiazzo di gamba) e `capitaleLibero` (dal saldo del giro, passato **solo se
    affidabile** — stantio ⇒ `null`, mai zero) sono iniettati nel blocco deps di `closeTask`. Senza,
    il riposizionamento rispondeva `azione: 'niente'`: era lo stato in cui il modulo era stato
    consegnato, di proposito.

    **Provato sul ciclo VERO** (`riposizionamento-cablato.test.js`, 23/23): senza le deps → `niente`;
    con tetto $130 e libero $500 → **$130 per riposizionamento**, due gambe BUY YES/BUY NO, entrambe con
    `inCoda: true`; con libero $80 → **$80**, non si blocca e non forza $130; con $6 → `accumula`; con
    capitale illeggibile → `niente`, e `null` **non** viene contato come zero.

    **LE ECCEZIONI A «MAI PRIMO SUL LIBRO» SONO DUE, E UN TEST LE CONTA.** La regola non è stata toccata:
    è `spec.inCoda`, opt-in per chiamante. Le eccezioni sono omissioni puntuali di un flag su UNA gamba —
    `primoAssoluto` di `chiusura-rapida` (banda sotto il carico) e quella nuova (rimasuglio da chiudere).
    `risposta-al-fill.test.js` conta le omissioni nel sorgente e ne pretende **esattamente due, entrambe
    condizionate**, con `inCoda: true` ancora su 8 gambe del file.

    **DUE DIFETTI VERI TROVATI DAL SELFCHECK MENTRE LO SCRIVEVO**, stessa famiglia: `Number(null)` vale 0,
    quindi un `sizeAltroLato` non letto diventava «zero copertura» ⇒ **fill completo**, un ramo che apre
    ordini dedotto da un dato assente; e un capitale libero non letto diventava «zero capitale». Ora si
    guarda il valore grezzo, e sul capitale illeggibile si fallisce chiuso.

    **⚠ UN LIMITE DICHIARATO, che il requisito non può superare su questo venue.** Con `manca < minSize`
    il venue rifiuta **entrambe** le gambe: `BELOW_MIN_SIZE` è bloccante e resta tale. Il guadagno del
    punto (b) non è quindi «l'ordine passa» — è che il tentativo diventa **visibile e a verbale** invece
    di essere silenzio, e che quando il registro accumula fino al minimo lo stesso ordine passa da sé.
    La size **non** viene mai arrotondata al minimo: comprerebbe più di quanto serve.

    **⚠ E UN EFFETTO COLLATERALE DEL TETTO FISSO, misurato qui.** Con $130 fissi il pianificatore riempie
    molte righe ESATTAMENTE al tetto, e il fattore concentrazione del punteggio di rischio
    (`1 + capitale/130`) satura a **2,000 identico**: sul piano del 9 agosto 4 righe su 6 erano al tetto e
    le graduatorie per beneficio e per punteggio **coincidevano**. `rischio-beneficio.test.js` asseriva
    «riordina davvero» ed è stato reso condizionato ai dati, **con la misura scritta come osservazione**
    invece che indebolito in silenzio. Non è un guasto: è che su quell'asse il punteggio oggi dice poco.

    **File:** `lib/maker/risposta-al-fill.js` (nuovo) · `lib/maker/auto-close.js` · `agents/agent40-manual-reprice.js`
    (le due deps + `saldoGiro`) · test nuovi `risposta-al-fill.test.js` e `riposizionamento-cablato.test.js`.

    **Verifica.** `risposta-al-fill.selfcheck` 28/28 · `risposta-al-fill.test` 27/27 ·
    `riposizionamento-cablato` 23/23 · `chiusura-rapida` 76/76 · `rischio-beneficio` 44/44.
    Suite: **157 eseguiti, 151 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde.

67. **IL QUARTO PUNTO DEL TETTO: $25 PER ORDINE CONTRO $130 PER MERCATO — corretto e DEPLOYATO il
    9 agosto 2026, ~21:04 UTC. TRE RIAVVII ESEGUITI su autorizzazione esplicita di Diego.**

    **Il guasto.** Il punto 65 ha portato il tetto per MERCATO a $130 (~$65 per lato) e ha unificato i
    quattro consumatori. Ne esisteva un **quinto**, che quella diagnosi non aveva toccato perché non è un
    tetto di allocazione ma un tetto **per ordine**: `LIVE_MIN_DEFAULT_CAP_USD = 25`. Con il bot su AVVIA
    e $561,37 liberi, **ogni** gamba moriva così:

    ```
    gate: manual-order-cap — controvalore $99.14 oltre il tetto per ordine $25.00
      (il più stretto fra safety-risk-limits $1000 e il cap live-min dell'adapter $25)
    ```

    Utilizzo del capitale **16,4%** contro l'obiettivo del 90%, e **zero ordini in due mini-cicli di fila**.

    **Il 25 viveva in DUE costanti, non una** — `adapter.js:66` e la gemella `manual-order.js:94`
    (`FALLBACK_LIVE_MIN_CAP_USD`), nessuna configurabile da `.env`. Adesso è **una sola e derivata**, in
    `lib/rewards/concentration.js` accanto al tetto per mercato:

    ```js
    const MARGINE_ORDINE_USD = 5;
    const LIVE_MIN_ORDER_CAP_USD = MARKET_CAP_FIXED_USD / 2 + MARGINE_ORDINE_USD;   // 130/2 + 5 = 70
    ```

    I due consumatori la **importano**: un cambio del tetto per mercato la muove da sé, e la quinta
    divergenza non può nascere. `concentration.js` non importa nulla, quindi nessun ciclo e nessun
    caricamento pesante al `require` dell'adapter.

    **⚠ IL RIPIEGO NON È PIÙ UN RIPIEGO, ED È LA SCOPERTA CHE CAMBIA IL PESO DEL NUMERO.**
    `readEngineState()` legge `/tmp/maker-state.json`, che alla misura era vecchio di **407 minuti**
    contro `STATE_STALE_MS = 60_000`. Lo scriveva **agent35, rimosso il 9 agosto** (punto 63): non sarà
    mai più fresco, `liveMinCapUsd` resta `null` per sempre, e quella costante **è l'unico percorso**.

    **⚠ $70 SBLOCCA 2 MERCATI SU 4, e va detto perché non è un dettaglio.** Il modello di size è
    `coppia-in-collaterale`: si comprano le **stesse share** sui due lati, quindi il costo in dollari di
    una gamba è **proporzionale al prezzo**. Le due gambe valgono $65 e $65 **solo a mid 0,50**. Sulle
    quattro coppie rifiutate alle 20:37:

    | mercato | mid | gambe | con $70 |
    |---|---|---|---|
    | Istanbul 28°C | 0,54 | $65,45 / $55,75 | **passa** |
    | Ankara 32°C | 0,48 | $58,18 / $63,02 | **passa** |
    | Jay Schroeder | 0,16 | $19,58 / **$100,37** | ancora bloccata |
    | David Crowley | 0,05 | $6,12 / **$113,83** | ancora bloccata |

    **Finestra di mid ammessa: [0,43 · 0,57]**; fuori da lì la gamba cara sfonda, e una coppia si piazza
    solo se passano **entrambe**. Per ammettere qualunque mid servirebbe un tetto per ordine ≈ al tetto
    per **mercato** ($130): a mid 0,99 una gamba sola vale $121,22. **Non adottato** — è una decisione
    sul perimetro di rischio, non un dettaglio implementativo — ma il numero è scritto nel test.

    **Cosa NON è stato toccato**, verificato per nome e con `git diff`: il limite di safety ($1000, e il
    gate resta il **minimo** dei due) · la cintura indipendente dell'adapter in `live-min` ·
    `missing ≠ unlimited` (un cap illeggibile continua a rifiutare tutto) · il **ritiro della gamba
    orfana** in `bulk-allocate.js` e la costruzione delle due gambe in `plan-to-orders.js`, nessuno dei
    due nel diff.

    **File:** `lib/rewards/concentration.js` (+ `.d.ts`) · `lib/venues/polymarket-clob-maker/adapter.js:66` ·
    `lib/maker/manual-order.js:94` · nuovo `lib/maker/tetto-per-ordine.test.js`.

    **Verifica.** `tetto-per-ordine` **34/34** · `concentration.selfcheck` **19/19**. Suite: **158
    eseguiti, 152 verdi**, i 6 rossi sono i preesistenti del punto 40. `npm run build` verde. Commit
    `05d9207`.

    **TRE RIAVVII ESEGUITI il 9 agosto 2026, 21:04-21:06 UTC**, su autorizzazione esplicita di Diego in
    chat, nell'ordine e con verifica dopo ciascuno:

    | processo | restart | verifica |
    |---|---|---|
    | `agent41-realloc-scheduler` | 48 → **49** | 9/9 variabili critiche · error log fermo al **2026-08-08 15:19:15** (righe storiche del punto 21), zero errori nuovi · log d'avvio «tetto per mercato $130 FISSO · nessun limite al numero di mercati» |
    | `agent40-manual-reprice` | 67 → **68** | error log **vuoto** dal 31 luglio · feed in PUSH agganciato |
    | `dashboard` | 173 → **174** | `.next/prerender-manifest.json` verificato PRIMA (build `UfIXVyEDbvCoM2CZkSdGL`) · root **200**, `/api/maker/board` 401 come sempre (gate operatore) |

    **L'EFFETTO SUI DATI VIVI, al primo mini-ciclo dopo il riavvio — 21:09:18Z:**

    > `mini-ciclo: $456 rimessi al lavoro su 4 mercato/i (2 ordini piazzati, 0 rifiutati)`

    **Zero rifiuti** — non era mai successo con questo tetto. Le due gambe sono la coppia completa di
    **Ankara 32°C**, uno dei due mercati che la previsione indicava:

    | ora | gamba | controvalore | col vecchio $25 | esito |
    |---|---|---|---|---|
    | 21:09:18 | BUY 121,2 @ 0,47 | **$56,96** | rifiutata | `0x96683251…` live |
    | 21:09:18 | BUY 121,2 @ 0,50 | **$60,60** | rifiutata | `0x1dc6e0ff…` live |
    | 21:07:04 | BUY 66,3 @ 0,43 (agent40, Houston) | **$28,51** | rifiutata | `0x46a1eee2…` live |

    **Nessun ordine o posizione preesistente è stato toccato**, verificato con l'impronta prima/dopo: 6
    posizioni, SHA-256 `5af077ed3e3359e4` **identico**, zero righe mutate, zero sparite, e **zero
    cancellazioni** su 1.491 righe d'audit dopo il riavvio (il mini-ciclo non cancella per costruzione;
    il ciclo da 6h, che invece cancella, non era ancora caduto). Contatori pm2 stabili a +5 minuti:
    nessun riavvio automatico, nessun crash loop.

68. **LA GAMBA ORFANA VENIVA RINNOVATA ALL'INFINITO — corretto in `main` il 9 agosto 2026, ~22:10 UTC.
    ASPETTA IL RIAVVIO di agent40, DA CONFERMARE DA DIEGO IN CHAT.**

    **Lo scenario.** BUY YES @0,40 e BUY NO @0,60. La YES viene fillata e apre una posizione. La posizione
    sparisce per una causa **esterna** al ciclo — chiusura manuale, o un ordine dell'operatore che la
    vende. La gamba NO resta sul libro senza più niente con cui accoppiarsi.

    **Perché nessuno se ne accorgeva, ed è strutturale — le tre difese guardavano tutte altrove:**
    - `auto-close` itera le **posizioni** (`for (const pos of mine)`, `auto-close.js:982`) e lo snapshot
      scarta le size a zero: con zero posizioni il corpo del ciclo **non gira nemmeno una volta**. Niente
      merge, niente `decidiLivello`, nessuna riga di audit — il mercato smette di comparire nel giornale;
    - `auto-reprice` itera gli **ordini**, quindi la gamba la vede — e la **rinnova**, tenendola dentro la
      banda premiante a ogni finestra GTD (23 minuti);
    - la **Regola 4** (`motore-unico.js:76`) dentro `[0,10 · 0,90]` dice «un lato solo matura comunque un
      terzo: tenerlo è meglio che chiuderlo», quindi la tiene **apposta**.

    L'unica cosa che la toglieva era la scadenza GTD limitata dalla chiusura del **mercato**: giorni.

    **MISURATO IN PRODUZIONE, non ipotizzato.** `0xd25c820d…` teneva **135,4 share**; il giornale del
    mercato si interrompe di colpo alle **12:22:43** senza una riga di chiusura, e `data/merge-attese.json`
    portava ancora l'attesa aperta di quel completamento — BUY 135,4 @ 0,45 = **$60,93** — **nove ore dopo**.
    Zero righe `merge-onchain-*` in tutta la storia del giornale e zero SELL nostre da 135,4: la posizione
    non è stata né venduta da noi né fusa.

    **PERCHÉ NON SERVE DISTINGUERE LE CAUSE.** La domanda non è «perché la posizione non c'è più» ma «c'è
    ancora?». Fortuna, perché ricostruire il fill dallo storico **non è possibile**: `execution-audit.jsonl`
    registra solo le NOSTRE azioni (807 intent + 807 esiti, stati `live`/400/403) e **non contiene nessun
    evento di fill** — le 301 occorrenze di «fill» sono l'etichetta della corsia `auto-close-on-fill`. E nel
    giornale grande il `marketId` sotto `requested` viene **oscurato** dalla cintura 64-hex di `redact.js`
    (11.593 occorrenze di `redacted` negli ultimi 5 MB), quindi la conta degli ordini a riposo non è
    nemmeno attribuibile a un mercato. *(È la stessa classe di difetto che l'intestazione di `redact.js`
    documenta già tre volte — `orderId`, `canceled`, `transactionHash` — alla quarta occorrenza. `marketRef`
    sopravvive solo perché è scritto come `cid_<hex>`, e quel prefisso rompe la cintura.)*

    **IL DISCRIMINANTE È L'ASIMMETRIA, non lo zero.** Zero posizioni da solo è anche lo stato **sano** di
    una coppia appena piazzata:

    | posizioni | gambe a riposo | verdetto |
    |---|---|---|
    | 0 | **2** | SANO — coppia intatta, nessun fill |
    | 0 | **1** | ORFANO — l'altra è stata fillata e la posizione non c'è |
    | > 0 | qualunque | SANO — c'è cosa gestire, se ne occupa `auto-close` |

    **LA CONFERMA IN DUE OSSERVAZIONI, ed è la parte che rende sicura la cancellazione.** C'è un istante in
    cui il caso sano SEMBRA orfano: la gemella è stata fillata pochi secondi fa (gambe = 1) e l'API delle
    posizioni non ha ancora pubblicato la posizione appena nata (posizioni = 0). Cancellare lì toglierebbe
    la gamba superstite **proprio mentre il Lavoro B sta per gestire il fill**. La finestra non si chiude
    con una lettura più fresca: si chiude **aspettando**. La prima osservazione **arma soltanto** e
    l'ordine viene rinnovato; solo una seconda oltre `CONFERMA_MS = 60s` cancella, e una posizione
    ricomparsa **disarma**. Prezzo dichiarato: l'orfano vive una finestra GTD in più (~20 min) — contro
    «per sempre», che è il comportamento di oggi.

    **DOVE È AGGANCIATO.** In `auto-reprice.decideReprice`, sul ramo `expiring` — cioè **solo** quando
    `d.action === 'reprice' && d.gate === 'expiry-refresh'`. Un riprezzo che INSEGUE il mid non passa di
    qui. È l'istante in cui il sistema tocca comunque quella gamba per darle altri 23 minuti di vita.
    - **La lettura delle posizioni è pigra e memoizzata per mercato**: `auto-reprice`, a differenza di
      `auto-close`, non le legge — metterla in cima al ciclo sarebbe una chiamata ogni pochi secondi.
      Così scatta al più ~3 volte l'ora per mercato. È la **stessa** `leggiPosizioniVenue` della chiusura
      automatica (cache 5s condivisa), non un secondo percorso: due letture potrebbero divergere, e qui
      la divergenza deciderebbe una cancellazione.
    - **Il riposizionamento NON si fa lì.** Il ciclo di riprezzo non ha mai aperto esposizione e non
      comincia adesso: dichiara il mercato «da ripianificare» e lo raccoglie `auto-close`, che lo mette
      nella **stessa lista `riposizionamenti`** del merge riuscito — quindi eredita senza modifiche
      `capitalePerRiposizionamento`, il tetto in vigore ($130) e il ripiego sul capitale libero.
    - Il referto visibile usa `gamba-orfana-scaduta`, il motivo che `cancellazioni-visibili.MOTIVI`
      **dichiarava già e che non aveva nessun produttore**.

    **FAIL-CLOSED OVUNQUE:** posizioni illeggibili, ordini illeggibili, token non risolti, `readPositions`
    non iniettato, eccezione ⇒ verdetto `ignoto` e **si rinnova esattamente come prima**.

    **DUE DIFETTI VERI TROVATI DAI TEST E CORRETTI PRIMA DEL COMMIT** — nessuno dei due sarebbe stato
    visibile in produzione se non come un silenzio:
    - `deps.resolveRules` in `auto-close` è **posizionale** (`resolveRules(marketId)`, riga 941) e la prima
      stesura passava `{marketId}`: il riposizionamento sarebbe fallito ogni volta con «regole non
      leggibili»;
    - `runAutoCloseCycle` **esce subito** se `marketIds` è vuoto, e un mercato orfano ha zero posizioni per
      definizione — quindi può benissimo non essere in quella lista. La coda non sarebbe **mai** stata
      drenata. Adesso si legge in cima, una volta sola, e la sua presenza basta a far girare il ciclo.

    E il selfcheck del modulo ha trovato per la **terza volta** in questo stack la famiglia `Number(null) === 0`:
    un `armatoDa` mai armato diventava «armato dal 1970» ⇒ ORFANO alla **prima** osservazione, cioè
    esattamente la corsa che la conferma esiste per evitare.

    **File:** `lib/maker/ordine-orfano.js` (nuovo, puro + selfcheck) · `lib/maker/auto-reprice.js` (il
    controllo sul ramo `expiring`, `daRipianificare` nel referto) · `lib/maker/auto-close.js` (la coda letta
    in cima e versata in `riposizionamenti`) · `agents/agent40-manual-reprice.js` (`readPositions`,
    `registroOrfani` in memoria, la coda drenata alla lettura) · nuovo `lib/maker/ordine-orfano.test.js`.

    **Verifica.** `ordine-orfano.selfcheck` **17/17** · `ordine-orfano.test` **42/42** (caso sano invariato,
    caso orfano cancellato e ripianificato al tetto pieno, corsa del fill innocua, ogni dato mancante che
    rinnova, e il riposizionamento provato sul ciclo di chiusura VERO) · `riposizionamento-cablato` 23/23 ·
    `risposta-al-fill` 27/27 · `mid-stantio` 46/46 · `chiusura-rapida` 76/76 · `controparte-primo-assoluto`
    41/41. Suite: **159 eseguiti, 153 verdi**, i 6 rossi sono i preesistenti del punto 40 — zero nuovi.
    `npm run build` verde, `BUILD_ID` `zMNV-tOBzL3e7MsbiV-7N`. Commit `eceb907`.

    **NESSUN CONFLITTO CON IL LAVORO B, e le due condizioni sono mutuamente esclusive per costruzione:**
    il Lavoro B agisce **sul fill**, quando la posizione ESISTE; questo agisce **al rinnovo GTD**, quando la
    posizione NON esiste. `posizioni > 0` ⇒ verdetto `sano`, sempre. I due moduli non si importano a
    vicenda e non condividono stato.

    **Riavvio: NON eseguito** (§2 regola 2) — `pm2 restart agent40-manual-reprice`.

    **⚠ RESTA UN ORFANO VIVO IN PRODUZIONE**, ed è quello che ha fatto scoprire il difetto:
    `0xd25c820d…`, attesa di merge da $60,93 registrata alle 11:59:08 del 9 agosto. Il riavvio di agent40
    lo intercetta ai primi due rinnovi utili (~20 min l'uno dall'altro) **se quell'ordine è ancora sul
    libro**; se nel frattempo è scaduto, resta solo la voce stantia in `data/merge-attese.json`, che questo
    lavoro **non** ripulisce — la pulizia di quel registro è un intervento a parte.

69. **IL GATE live-min LEGGEVA LA LISTA STRETTA: L'UNIONE DEL PUNTO 62 NON ARRIVAVA AL PIAZZAMENTO —
    corretto in `main` il 9 agosto 2026, ~22:15 UTC. TRE PROCESSI RIAVVIATI.**

    **La causa radice, localizzata.** `buildPlacementAdapter` (`manual-order.js:735-755`) **non passa**
    né `allowedMarketIds` né `allowedMarketIdsProvider`, quindi l'adapter usa il proprio provider di
    difetto, che leggeva `cfg.enabledMarketIds`. I due consumatori di `liveMinMarketIds` in
    `manual-order` (righe 631 e 658) stanno **entrambi dentro l'oggetto di stato del pannello** — una
    superficie di sola lettura. **L'unione era calcolata e nessun percorso di piazzamento la leggeva.**
    Il commento in `auto-reprice-config.js` che diceva «la legge `manual-order` per costruire l'adapter»
    era **falso**, ed è la ragione per cui la lacuna è rimasta invisibile: è stato corretto.

    **Cercato sistematicamente lo stesso pattern**, e il punto effettivo è **uno solo**:
    `lib/maker/config.js:45-51` legge anch'esso `enabledMarketIds`, ma **nessun modulo lo importa** — è
    codice morto per questo scopo, e la nota di §5 punto 26 che lo indicava come la allowlist live-min è
    invecchiata. `auto-reprice.js:1054` usa la lista stretta come **scope del watcher**, ed è una scelta
    dichiarata (vedi sotto), non lo stesso difetto.

    **Il costo, misurato su Ankara (`0x2be0b367`) il 9 agosto**: 21:09:18 le due gambe · ~21:40 il ciclo
    da 6h toglie il mercato dal piano · 21:46:47 la gamba NO viene fillata per 101 share · da lì, ogni
    ~60s, `merge-livello-2`, `chiusura-rapida-taker` e `riposizionamento-scoperto-controparte` tutti
    `reject-live-min-market-mismatch`, e passa solo il SELL per l'eccezione di riduzione (§5 punto 26).
    Il merge — coppia a ≤99¢ che vale $1 subito — irraggiungibile proprio dove serviva.

    **⚠ LO SCOPE DEL RINNOVO NON È STATO TOCCATO, ed è deliberato.** `auto-reprice.js:1054` itera
    `cfgState.enabledMarketIds`: un mercato fuori dal piano **non viene visitato**, quindi non viene
    rinnovato e i suoi ordini muoiono per scadenza GTD entro 23 minuti. Allargare quello scope non era
    l'intenzione del punto 62 — `end-of-scale-cycle.test.js` lo scoprì come accoppiamento nascosto (tre
    mercati in più, sei rinnovi invece di uno). **Conseguenza da conoscere**: una rotazione di piano
    lascia morire per GTD gli ordini dei mercati usciti, ed è il comportamento voluto (il piano non
    vuole più capitale lì); ma è anche il motivo per cui il controllo della **gamba orfana** (§5 punto
    68) non si esercita su quei mercati — lì l'ordine muore da solo.

    **Verifica.** Nuovo `lib/maker/allowlist-piazzamento.test.js` **20/20**: lo scenario Ankara prima e
    dopo sulla **stessa** funzione di gate (cambia solo quale lista riceve) · un mercato in nessuna delle
    due liste resta rifiutato · Ankara **senza** posizione aperta torna rifiutato (l'unione aggiunge solo
    dove il capitale è già esposto) · lista vuota, lista `null` e config assente rifiutano tutto · il pin
    continua a valere da solo · l'eccezione di riduzione non è stata sfiorata. Suite: **160 eseguiti, 153
    verdi**; i rossi sono i 6 preesistenti **più `guardian-perdite`**, che è rosso perché
    `data/guardian-state.json` **esiste** dalle 21:46:38 (il guardiano è scattato davvero) e il test
    legge il latch vero — non è una regressione, e il file non è stato toccato perché cancellarlo
    riarmerebbe il guardiano. `npm run build` verde, `BUILD_ID` `2FhmblFNKbey1q_NzWTjP`. Commit `ddd3401`.

    **Riavviati** su autorizzazione: `agent40-manual-reprice` (69 → **70**), `agent41-realloc-scheduler`
    (49 → **50**), `dashboard` (174 → **175**, `prerender-manifest.json` verificato prima, root 200).
    Tutti e tre raggiungono l'adapter via `manual-order`.

70. **IL GUARDIANO DELLE PERDITE È SCATTATO — 9 agosto 2026, 21:46:38 UTC. PRIMO SCATTO REALE.**

    `agent43-guardian` ha messo il bot su **FERMA** e cancellato gli ordini a riposo:

    > `perdita oltre soglia: superate: percentuale (-6,051312% ≤ -5%) e assoluta (-39,972693 USD ≤ -30 USD)`

    Ha superato **entrambe** le soglie, non una. `data/maker-bot-enabled.json` porta `enabled:false`,
    `by:"agent43-guardian"`. È la ragione per cui gli ordini a riposo sono andati a zero — **non un
    difetto di piazzamento**. Non c'è riarmo automatico: si riparte cancellando
    `data/guardian-state.json` a mano, ed è una decisione dell'operatore.

    **E il KILL è stato attivato a mano alle 22:20:09 UTC** (`by: "operator · liquidity-rewards tab"`).
    **Zero righe in `execution-audit.jsonl` dopo quell'istante** — nessun ordine è partito.

    **Il kill è verificato su OGNI percorso di piazzamento**, e i controlli stanno tutti **prima** del
    lavoro: `manual-order.js:585` (l'imbuto obbligatorio di ogni ordine) · `auto-close.js:934-935` (prima
    del giro sui mercati) · `auto-reprice.js:1014-1015` (prima del loop di riga 1054, quindi copre anche
    il controllo della gamba orfana) · nell'adapter il kill è il **primo** dei gate di sicurezza.
    `percorsi-di-invio.test.js` **18/18** asserisce che **nessun** percorso sfugga all'imbuto,
    `maker-kill-selfcheck` **25/25**, `kill-blocca-avvia` **13/13**.

    **Le modifiche di oggi non hanno introdotto nessun percorso di piazzamento nuovo.** Il Lavoro B è un
    modulo puro senza rete; la gamba orfana **cancella** (azione sempre consentita, è ciò che il
    guardiano deve poter fare) e delega il riposizionamento ad `auto-close`, che ha il proprio gate del
    kill; il fix dell'adapter ha cambiato **quale lista** viene letta, non l'ordine dei gate.

71. **IL REGISTRO DA 731 MB: LETTURA INCREMENTALE SU TUTTI I PUNTI NOTI — in `main` il 9 agosto 2026,
    ~23:00 UTC. agent40 (71) e agent41 (51) RIAVVIATI.**

    **Il muro.** `fs.readFileSync(file, 'utf8')` costruisce UNA stringa, e V8 ne ammette al più
    `0x1fffffe8` caratteri (~512 MB). Riprodotto: il file era a **767.271.276 byte (731 MB)** e la
    lettura sollevava `Cannot create a string longer than 0x1fffffe8 characters`. Non è lentezza: è un
    tetto secco, e oltre quello la funzione **smette di funzionare**.

    **I due lettori rotti, e cosa produceva il loro fallire chiuso:**
    - `origine-ordine.mappaOrigini()` ⇒ mappa vuota ⇒ ogni ordine di origine «ignota» ⇒ **il reset di
      agent41 non cancella più niente** (cancella solo ciò che è provatamente `auto`);
    - `manual-reset.cancelledOrderIds()` ⇒ insieme vuoto ⇒ nessun ordine dichiarabile «cancellato da noi».

    **La cura è quella già in servizio, ed è stata ESTRATTA invece che ricopiata.**
    `lib/maker/giornale-incrementale.js` (nuovo) porta il pattern di `attribuzione-ordini`: offset già
    consumato, blocchi da **1 MiB**, `StringDecoder` per non spezzare un carattere multi-byte a cavallo,
    ricostruzione da zero su rotazione o troncamento. Tre copie della stessa lettura sarebbero il reperto
    che il rilevatore **D1** cerca.

    **Due miglioramenti sull'originale, entrambi trovati dal selfcheck:**
    - **la TESTA del file come terzo segnale**: inode e dimensione non bastano — un file riscritto in
      place con lo stesso inode e dimensione maggiore passerebbe entrambi i controlli. 64 byte letti
      dall'inizio lo scoprono;
    - **l'ultima riga senza `\n` finale** — cioè il record **più recente** — ora viene consegnata, senza
      essere consumata: quando il resto arriva la riga vale intera e il pezzo monco non si incolla alla
      successiva. Prima il record più nuovo restava invisibile finché non ne arrivava un altro, e per
      `cancelledOrderIds` avrebbe significato non vedere proprio la cancellazione appena avvenuta.

    **Misurato sul registro vero:** `mappaOrigini()` recupera **1307 chiavi in 3,2 s con 60 MB di RSS**,
    dove prima sollevava. Nessun terzo lettore in produzione: gli altri due (`barlow-riprezzi-replay`,
    `analyze-shadow-logs`) sono script diagnostici offline, e `polymarket-clob-maker/audit.js` è lo
    **scrittore**.

    **⚠ E QUI LA DIAGNOSI PRECEDENTE ERA SBAGLIATA, VA DETTO.** Si era concluso che i $2.406 di
    esposizione fossero ordini inviati e mai riconciliati, contati a pieno nozionale. **Misurato dopo il
    fix, con `diagnoseExposure` che ora legge davvero:**

    | | |
    |---|---|
    | `openNotionalUsd` (quello confrontato col tetto $600) | **$2.405,91** |
    | da **posizioni confermate** dal ledger dei fill | **$2.303,58** (8 posizioni) |
    | da **ordini non risolti** | **$0** — **zero** ordini |
    | posizioni **vere** al venue | **6, per $126,45** |

    Una sola voce del ledger vale **$1.925,32**. Quindi il blocco non è contabilità di ordini fantasma:
    è il **ledger dei fill che non ha mai nettato le posizioni chiuse**. È un secondo difetto, diverso, e
    questo lavoro non lo tocca. **Il bot resta bloccato finché non lo si affronta** — verificato dopo il
    riavvio: il mini-ciclo continua a dire `utilizzo 100% · liberi $0.00 · 0 ordini piazzati, 0 rifiutati`.

    **LA ROTAZIONE NON È STATA IMPLEMENTATA, ed è una scelta.** Toglie il muro per QUALUNQUE lettore
    futuro, ma cambia cosa significa «il giornale»: un lettore che deve conoscere la storia dovrà
    attraversare anche gli archivi, e quella è una decisione **per lettore**, non una riga nello
    scrittore. Farla nella stessa sessione in cui si corregge la lettura vorrebbe dire cambiare due
    variabili insieme su un sistema già bloccato. Resta come lavoro successivo, con il costo residuo
    dichiarato: la prima scansione di ogni processo attraversa comunque 731 MB (~3-4 s, memoria costante).

    **File:** `lib/maker/giornale-incrementale.js` (nuovo, 13/13 nel selfcheck) ·
    `lib/maker/origine-ordine.js` · `lib/maker/manual-reset.js`.

    **Verifica.** `giornale-incrementale.selfcheck` **13/13** · `origine-ordine` **29/29** (era 27/2
    subito dopo il cablaggio: le due rosse hanno scoperto il caso dell'ultima riga senza a capo) ·
    `allowlist-piazzamento` **21/21**. Suite: **160 eseguiti, 152 verdi**; gli 8 rossi sono i 6
    preesistenti più `guardian-perdite` (latch vero presente dalle 21:46:37) e uno mio, corretto:
    `allowlist-piazzamento` aveva un'asserzione che leggeva `git diff HEAD` — verde durante la
    lavorazione, rossa un minuto dopo il commit. Sostituita con la proprietà letta dal sorgente, che vale
    in entrambi gli stati. `npm run build` verde. Commit `70631f5`.

    **Riavvii eseguiti** su autorizzazione: `agent41-realloc-scheduler` (50 → **51**),
    `agent40-manual-reprice` (70 → **71**). Error log invariati (31 luglio e 8 agosto). Posizioni
    preesistenti **invariate**: impronta `4dfb43eddc67e7ee` identica prima e dopo, zero righe mutate.

72. **UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO — corretto in `main` il 9 agosto 2026, ~23:25 UTC.
    agent40 (72) e agent41 (52) RIAVVIATI.**

    **Il meccanismo, esatto.** `planReconcile` (`lib/safety/reconcile-fills.js`) risolve un ordine sparito
    dagli ordini aperti guardando i trade del venue:

    ```js
    const totalFilled = matchedFills.reduce(...);   // volume del venue su QUESTO token+lato
    const delta = totalFilled - already;            // `already` = registrato per QUESTA idempotencyKey
    ```

    Le due grandezze sono su **scale diverse**: una per TOKEN, l'altra per CHIAVE. Il ciclo di riprezzo
    sostituisce la stessa gamba ogni ~60 s e ogni sostituzione porta una chiave **nuova**: appena
    l'ordine sostituito lascia gli ordini aperti cade in quel ramo, ritrova lo stesso identico volume, e
    siccome il suo `already` vale 0 lo registra **intero** come fill proprio.

    **Non è «ogni ordine inviato conta come un fill»** — la diagnosi iniziale diceva così ed era
    imprecisa. Il ledger conta solo righe `kind:'fill'`, e quelle le scrive solo la riconciliazione dopo
    una conferma del venue. Il difetto è che la **stessa** conferma veniva attribuita N volte.

    **Misurato su Chengdu 37°C (`0x2be0b367`, token `8830816894…`):**

    | | |
    |---|---|
    | righe di fill | **136** |
    | `idempotencyKey` distinte | **136** |
    | valori distinti di `filledSize` | **21,69 · 14 · 7,69** — lo stesso fill vero, riscritto |
    | share registrate / netto FIFO | 2.892,46 / **2.790,32** |
    | posizione VERA al venue | **ZERO** |

    **Il danno era operativo, non contabile:** `openNotionalUsd` **$2.405,40** contro un tetto di **$600**
    ⇒ `limit-max-open-notional` rifiutava OGNI piazzamento, e a monte `libero = max(0, saldo −
    esposizione)` andava a zero, quindi il mini-ciclo non tentava nemmeno una gamba
    (`0 piazzati, 0 rifiutati`). Con AVVIA attivo e kill revocato.

    **La correzione: confronti fra grandezze OMOGENEE.**
    - ramo `/trades`: `totalFilled` (per token+lato) contro **quanto è già registrato per lo stesso
      token+lato** su TUTTE le chiavi (`recordedFilledByTokenSide`), aggiornato **dentro la stessa
      passata** perché due ordini dello stesso token non rivendichino due volte lo stesso delta;
    - ramo `size_matched`: **il test ha trovato una seconda faccia dello stesso difetto** — due nostri
      invii possono mappare sullo **stesso** ordine del venue (`findVenueOrder` riconosce anche per
      token+lato+prezzo+size) e il confronto per chiave li contava due volte. Corretto confrontando per
      **id dell'ordine del venue** (`recordedFilledByOrderId`), che è la grandezza omogenea a
      `vo.size_matched`.
    - **Nessun fail-closed toccato**: venue irraggiungibile ⇒ niente registrato; senza la lettura delle
      posizioni non si dichiara «mai fillato»; un lato non leggibile non produce chiave.

    **Lo stato già scritto è stato riparato**, con `scripts/ripulisci-fill-duplicati.js` — anteprima di
    difetto, backup con timestamp, e stampa riga per riga di cosa toglierebbe. Criterio: si tiene UNA
    riga per `(userId, venue, tokenId, side, filledSize, filledPrice)`, la più vecchia. **152 duplicati
    esatti rimossi**, di cui **130 su Chengdu SELL (2.819,70 share fantasma)**. Limite dichiarato: due
    fill genuinamente identici collasserebbero in uno — è il verso che sottostima, e per questo lo script
    non gira mai da solo.

    **Effetto misurato:**

    | | prima | dopo |
    |---|---|---|
    | `openNotionalUsd` | **$2.406,06** | **$207,87** |
    | voci del ledger | 8 (6 fantasma) | 7, tutte fra $10 e $25 |
    | tetto $600 | **SATURO** | **LIBERO** |

    **E la prova finale, sui dati vivi:** dalle **23:28:31** — l'istante della pulizia — il bot ha
    ripreso a piazzare. **951 ordini in sette ore** (74/136/152/198/147/87/154 per ora), da zero.
    Capitale a fine finestra: **$486,89 liquidi + $202,91 di posizioni = $689,80** contro il baseline del
    guardiano di $660,56 ⇒ **P&L +$29,24**, cioè la perdita di −$39,97 che aveva fatto scattare il
    guardiano è stata recuperata.

    **Il ledger NON si è rigonfiato**: 16 righe di fill, **zero** nuove nelle sette ore — la correzione
    regge sul traffico vero, non solo sul fixture.

    **Verifica.** Nuovo `lib/safety/riconciliazione-per-token.test.js` **15/15**: dieci ripiazzamenti su
    un solo fill vero ⇒ 21,69 share contabilizzate una volta (con il confronto per chiave davano 216,90,
    misurato nel test stesso) · un fill nuovo registrato per il solo delta · tre ripiazzamenti su volume
    già registrato ⇒ zero righe · il ramo `size_matched` invariato e non sommabile col ramo `/trades` ·
    i fail-closed. Suite: **161 eseguiti, 154 verdi**; i 7 rossi sono i 6 preesistenti più
    `guardian-perdite`, rosso perché il latch vero esiste dal 21:46:37 e non va toccato.
    `npm run build` verde, `BUILD_ID` `JScwCE2dJtMXUg2fbgZSA`. Commit `4c97d9e`.

    **Riavvii eseguiti** su autorizzazione: agent41 (51 → **52**), agent40 (71 → **72**). Impronta delle
    posizioni **stabile** a cavallo del riavvio (`6961390d08cfce40`, 10 posizioni, invariata a 65 s di
    distanza) e **zero** righe di audit dopo il riavvio — il KILL, riattivato dall'operatore alle
    06:20:43, blocca tutto come deve.

    **⚠ DUE COSE APERTE, nessuna delle due di questo lavoro.**
    1. **Il volume dei ripiazzamenti**: 951 ordini in 7 ore sono ~136 all'ora. È il ciclo che ricancella
       e ripiazza la stessa gamba ogni ~60 s. Non è più un problema di contabilità — adesso il conteggio
       è giusto — ma resta un costo: ogni ripiazzamento azzera la priorità di coda, e per un maker il
       tempo a riposo *è* il ricavo.
    2. **Il ciclo da 6h si è fermato alle 03:42:31** con `dopo 3 ricalcoli il piano contiene ancora
       mercati che il venue rifiuta (1 all'ultimo giro): la fotografia da cui nasce il piano non è
       affidabile — nessun ordine viene toccato`. È un fail-closed che ha funzionato, ma dice che un
       mercato del piano viene rifiutato dal venue e il ricalcolo non se ne libera. Da diagnosticare.

52. **TETTO $65, TAGLIO PER NUMERO RIMOSSO, SEGNALE «MERCATO NUOVO» ACCESO — decisioni di Diego, in
    `main` l'11 agosto 2026.**

    **① Il tetto per mercato: $130 → $65** (`lib/rewards/concentration.js:49`). Il tetto per ordine si è
    mosso **da solo** a **$37,50**, perché è derivato (`MARKET_CAP_FIXED_USD / 2 + 5`) e undici
    consumatori lo importano invece di ridichiararlo.
    - **Perché**: il modello compra share UGUALI sui due lati (`Q = capitale / (p_yes + p_no)`,
      `plan-to-orders.js:242`), quindi **il mid non c'entra** — a 0,16/0,84 e a 0,50/0,50 lo stesso
      capitale compra le stesse share. Il numero che conta è la frazione di fill oltre la quale il
      residuo scoperto è ancora piazzabile: `f_min = minSize × pairCost / capitale`. Su `minSize 20`:
      **$130 → 15% · $65 → 30% · $40 → 49% · $25 → 78%**.
    - **UNA GARANZIA PIENA NON ESISTE, e va detto**: il residuo è `Q × f`, quindi per `f` abbastanza
      piccolo sta sotto il minimo con **qualunque** tetto. $65 non elimina il caso, sposta la soglia dal
      15% al 30% — rende «residuo bloccato» un evento di coda invece dell'esito di un fill ordinario.
    - **Il costo, misurato**: a $65 le share per lato scendono a 66,3, quindi i mercati con `minSize 100`
      escono dal perimetro — **6 mercati**.

    **② Il taglio ai primi 120 è stato rimosso** (`agent24`, righe 44 e 549). Non era una soglia di
    qualità: era una **posizione in classifica**. Il 120° rendeva **$53/g** e il 200° **$42/g** — i
    tagliati non erano scarsi, erano 121esimi.
    - **NON è stato sostituito da una soglia di rate**, che era l'ipotesi di partenza: **tutti e 309** i
      mercati del board superano già $25/g, quindi una soglia $10-25 non filtrerebbe niente. Sostituire
      un taglio che morde con una soglia che non morde è un cambio di nome, non di comportamento.
    - **L'ordinamento per rate resta**; a filtrare restano i controlli che guardano il MERCATO — banda,
      orizzonte, `minSize`, profondità.
    - **Costo dichiarato**: la profondità CLOB si legge per ogni mercato processato, quindi da 120 a ~309
      le chiamate di quella fase ×2,6. La cadenza è già protetta dal periodo fisso (§5 punto 46).

    **③ Il segnale «mercato nuovo» — ACCESO SUBITO, col tradeoff accettato** (`lib/rewards/mercato-nuovo.js`,
    nuovo). «Meno concorrenza» non è misurabile; il proxy onesto è l'**età**, e la fonte affidabile è
    **nostra**: `data/history/rewards-poly/`, 31 giorni, 1.090 snapshot, **1.222 mercati distinti**.
    `startDate` di Gamma resta scartato (riscritto quasi ogni giorno, 82% di falsi positivi).
    - **⚠ IL TRADEOFF, DICHIARATO E ACCETTATO DA DIEGO**: gli snapshot storici li ha scritti agent24 **col
      taglio già applicato**, quindi «assente dallo storico» oggi significa «non è mai stato nei primi
      120», non «nuovo». Misurato: **200 dei 308 mercati del board** risultano mai visti — il 65%. E le
      due cause **non si separano**: 200 su 200 hanno rate sopra il minimo mai registrato ($5/g).
    - **Perché è accettabile**: il bonus è un **moltiplicatore sul rate (1,25×)**, non un riordino — un
      mercato scarso promosso per errore resta scarso; non salta nessun cancello; e **si auto-pulisce**,
      perché ogni giorno di storico scritto senza taglio registra i mercati che sembravano nuovi. Dopo
      `GIORNI_MINIMI_SENZA_TAGLIO = 7` il segnale è quello vero senza che nessuno tocchi niente.
    - `attendibile:false` continua a viaggiare nell'esito: il bonus si applica, ma l'audit dice che in
      questa finestra il segnale non è ancora provato.

    **Impatto combinato, misurato sul board dell'11 agosto**: mercati piazzabili **45 → 81 (+36)**. Il
    taglio valeva **+45**, il tetto più basso ne costa 6. Mercati per coprire $594: da 5 a **10**.

    **Verifica.** Nuovo `lib/rewards/tetto-e-scoperta.test.js` **31/31** · `concentration.selfcheck()`
    **19/19**. Suite: **164 eseguiti, 155 verdi**; i 9 rossi sono i 6 preesistenti del punto 40 più i 3
    fuori perimetro (`guardian-perdite` — latch vero presente; `categoria-mercato` — 5,4% non
    classificati su campione cresciuto; `tetto-orizzonte`). `npm run build` verde.
    - **Cinque fixture ritarate, non indebolite**: `tetto-per-ordine`, `motore-unico`, `realloc-cycle`,
      `netto-centralizzato`, `ingressi-del-motore`, `rischio-beneficio` e `miniciclo-prende-il-mercato`
      asserivano i vecchi $130/$70. Ognuna è stata riscritta per **derivare** i valori dal tetto invece di
      ripeterli, così al prossimo cambio non vanno ritoccate e continuano a difendere la stessa proprietà.
      In `miniciclo` è stato abbassato l'ORDINE preesistente della fixture (da $60 a $20 a riposo), non
      l'asserzione: con $65 di tetto un mercato con $60 dentro non ha più i $34 di spazio minimo, e il
      caso avrebbe smesso di provare ciò per cui esiste.
    - **Un difetto vero trovato dal test nuovo**: la cache di `mappaPrimaVisto` ignorava `dir`, quindi un
      chiamante con directory diversa riceveva la mappa sbagliata. Corretto con cache per directory.

---

## 6 · COME L'UTENTE VUOLE ESSERE SERVITO

- **Risposte finali sempre in italiano.**
- **Nessuna domanda a metà lavoro.** Se manca una decisione, scegli **l'opzione più prudente per il
  capitale reale** e segnalala nel riepilogo finale, invece di fermarti. «Più prudente» significa: non
  piazzare, non riarmare, non riavviare, non cancellare stato — e dirlo.
- **Riepilogo finale sempre con quattro voci:**
  1. cosa è stato fatto;
  2. file toccati;
  3. esito dei test (`npm run build` e i test mirati, con l'output vero — se qualcosa fallisce, si dice);
  4. stato di `git status` e `pm2 list`.
- Lavora fino allo STOP: se una parte è bloccata, completa tutto il resto e dichiara esplicitamente
  cosa è rimasto fuori e perché.

---

## 7 · MANUTENZIONE DI QUESTO FILE

**Istruzione permanente.** Ogni volta che una sessione Claude Code completa un lavoro che **cambia lo
stato del sistema** — nuovo agente, agente rimosso, regola cambiata, bug risolto, dry-run tolto, flag
commutato, interruttore premuto — **deve aggiornare le sezioni 3, 4 e 5 di questo file come parte
dello STOP finale**, prima del riepilogo. Così `CLAUDE.md` resta sincronizzato senza intervento manuale.

Regole di manutenzione:

- **§3 e §4 si scrivono solo dopo aver verificato** contro `pm2 list`, `/proc/<pid>/environ`, il
  sorgente e i file in `data/`. Mai per assunzione, mai copiando un commento: i commenti in questo
  repo sono ricchi ma possono invecchiare (vedi §5 punti 2 e 4).
- **§5 è una lista viva.** Quando l'utente chiude un punto in chat, va **tolto** in una sessione
  successiva; quando se ne apre uno nuovo, va **aggiunto**. Non inventare voci: solo evidenza reale.
- **§2 non si tocca** senza istruzione esplicita dell'utente in chat.
- Aggiorna la data di «ultima verifica» in cima quando rivedi §3/§4.
- Il file va **committato e pushato** insieme al lavoro che lo ha reso obsoleto, non dopo.

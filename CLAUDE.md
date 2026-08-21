# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **18 agosto 2026 — dopo la migrazione in `/home/bot/bot` (utente `bot`), con la flotta RIACCESA** (§4.14, §5.1, §5.3, §5-bis p.188-191). Le cinture si leggono da `/proc/<pid>/environ` degli 11 processi vivi. Il quadro del giro è in `APERTI.md`.

> ⚠️ **QUESTO FILE È STATO COMPATTATO IL 13 AGOSTO 2026** (494k → ~110k) su istruzione dell'operatore.
> Non è stata tolta nessuna regola, nessuna costante, nessuna trappola operativa e nessuna questione
> aperta: è stata tolta la **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi
> sono semplicemente vere. Ogni voce chiusa sopravvive come **una riga** nel registro di §5-bis, con il
> numero originale, così un riferimento del tipo «§5 punto 72» resta risolvibile. La storia integrale
> resta in `git log` e nei commit citati. **Chi aggiunge una voce nuova scriva già compatto.**

---

> ## ✂️ DOVE VIVE IL BOT, E COM'È ARMATO — 18 agosto 2026
> **⚠⚠ IL REPO È IN `/home/bot/bot` E L'UTENTE È `bot`.** `/root` non è leggibile e
> **`/root/prediction-market` non esiste più**: ogni percorso assoluto di questo file che dica
> `/root/...` è **storia, non stato** (§5-bis p.188). pm2 **7.0.3** sotto `/home/bot/.pm2`, PostgreSQL
> **16**, database e utente `rewardsbot`, **14 tabelle**; `.env` gitignored, `chmod 600`.
> **⚠ I FILE DI SERVIZIO NON SONO IN `/tmp` NUDO** ma in `/tmp/rewards-bot-<utente>` (0700), definizione
> unica in `lib/percorsi-runtime.js`: `/tmp` è condiviso e ha lo sticky bit, e i file di `root` erano
> diventati né riscrivibili né cancellabili (§5-bis p.189).
> ## 🔴🔴 IL BOT È ARMATO E OPERA CON CAPITALE VERO — dalle 16:21Z del 18 agosto 2026
> **STATO AL 18 AGOSTO 2026, SERA, LETTO DAI PROCESSI VIVI**: flotta a 11 processi ONLINE (§5.1) ·
> `MAKER_MODE=live-min` · `MAKER_ADAPTER_DRYRUN=false` · **`MANUAL_ORDER_PLACEMENT=send`** su agent40
> **e** agent41 · freno di agent41 `=0` ⇒ **ZERO CINTURE INSERITE, 0/4** (§4.14) ·
> `MAKER_MERCATI_CONTEMPORANEI=5` su agent41 (R1) · `SLOT_STERILE_ARMATO=0` · KILL spento ·
> selezione automatica **ACCESA** · perno **vuoto**.
> ⚠ **QUANTI ORDINI CI SIANO A LIBRO NON SI SCRIVE QUI: SI LEGGE.** Alle 22:57Z erano **1 mercato e 2
> ordini** (~$52,55), ma il numero cambia ogni pochi minuti. **Si legge da
> `data/venue-orders.json`**, che agent40 scrive da letture VERE del venue — **non** ricostruendolo dal
> giornale sommando i `sent` e togliendo le scadenze registrate: il 18 agosto sera l'ho fatto e ho
> dichiarato «4 mercati, 8 ordini, $209,08» mentre al venue ce n'erano 2, perche' sei scadenze erano
> gia' avvenute e agent40 non le aveva ancora scritte. Una ricostruzione non e' una lettura.
> **⚠ CIÒ CHE RESTA DAVANTI NON SONO PIÙ CINTURE, È STATO DEL SISTEMA**: il KILL, il tetto per ordine
> ($65,63), il tetto per mercato ($61,25), l'esposizione cumulativa (**$650**, §4.2), il rate limit,
> la perdita giornaliera a **−$100**, «mai primo sul libro» e la banda premiante. **Il freno vero è il
> kill a −$100**, non il tetto di esposizione — quello serve solo a non murare la gestione.
> **⚠ `MAKER_MODE` NEL `.env` DICE ANCORA `off`, ED È INERTE**: pm2 tiene la propria copia
> dell'ambiente e i caricatori `.env` scrivono solo le chiavi **assenti**. Quello che conta è
> `agents/ecosystem.config.js` + riavvio **dal file**. ⚠ `scripts/cli/stato.js` stampa una riga «`.env`
> (cosa entrerebbe al prossimo riavvio DAL FILE)» che è **sbagliata e rassicura**: legge il solo `.env`,
> mentre un riavvio dal file applica l'ecosystem. Da correggere.
> **⚠ OGNI RIAVVIO DI agent40 ABBANDONA GLI ORDINI GIÀ A LIBRO**: al suo avvio diventano
> **PRE-ESISTENTI**, cioè «invisibili al motore — non riprezzati, non rinnovati, non cancellati»
> (`lib/maker/ordini-preesistenti.js`, regola voluta). Con `send` aperto significa che **un deploy
> condanna il libro esistente alla morte per GTD**. Misurato il 18 agosto: due ordini veri morti così.
> **LA RIDUZIONE (15/08)**: 568 file su 1.267 **spostati** — mai cancellati — in `_archivio`, che
> conserva i percorsi (`mv _archivio/<p> <p>` riporta indietro; `INDICE-SPOSTATI.json` è l'elenco). La
> catena serve **486 file**. **⚠ `_archivio` è ESCLUSO dai sei test strutturali che camminano l'albero.**
> **LA FLOTTA È DI 11 PROCESSI, E IL `dashboard` NON C'È PIÙ**: le decisioni si prendono da
> `scripts/cli/`. **⚠ I sorgenti sotto `app/` RESTANO SUL DISCO**: 32 test strutturali li leggono come
> TESTO — un file che nessun processo serve non è un file che nessuno legge.
> **I COMANDI CHE SOSTITUISCONO IL PANNELLO** (`scripts/cli/`, ognuno dichiara cosa sta per cambiare e
> cosa ha cambiato): `mercati.js` · `distanza.js` · **`stato.js`** · `avvia.js` · `ferma.js` ·
> `selezione.js`. Passano dagli **stessi moduli** degli agent. **Nessuno può accendere la modalità
> viva.** `avvia.js` **LEGGE il KILL e si rifiuta di partire mentre è attivo, senza spegnerlo**.
> `stato.js` verifica su di sé, camminando `require.cache`, di non aver caricato nessuna superficie che
> sappia agire sul venue, e legge cinture e numero di mercati da `/proc/<pid>/environ` (§5-bis p.184).
> **LE VERIFICHE, in ordine di quanto provano**: **il banco del ciclo completo**
> (`node scripts/ricerca/banco-scenari.js`: **26 passi su 26** — le dieci regole concordate tutte
> provate, §0 — 20+15 regole, deterministico, e **identico su due snapshot diversi di `data/`**) ·
> **le quattro cinture una alla volta** (`node scripts/ricerca/prova-cinture.js`, 10/0, col controllo) ·
> la suite `lib/` (`node scripts/ricerca/suite-rossi.js <nome>`, che confronta i **NOMI** e non il
> conteggio, §5.2 p.11) · i 5 selfcheck di `scripts/` · `node scripts/verifica-catena-rewards.js`.

---

> ## ⚖️ LE DIECI REGOLE CONCORDATE — 18 agosto 2026, decise dall'operatore
> **Sono la SPECIFICA del bot, e il testo integrale con `file:riga` e il passo del banco che le prova
> sta in `APERTI.md` §0.** Qui resta il riferimento, perché chi cambia una di queste cambia il bot.
> **1** quanti mercati (`MAKER_MERCATI_CONTEMPORANEI`, agent41, un posto solo, letto da `/proc`) ·
> **2** scelta (pavimento ≤ $61,25 · ≥ 24 h · no meteo · ordina per netto) ·
> **3** ingresso (due gambe, stessa size decisa insieme, bordo esterno) ·
> **4** riprezzo sul **book** e non solo sul mid (§4.1-bis) ·
> **5** fill parziale (copre l'esatto, cancella sempre il residuo, poi merge) ·
> **6** residuo sotto il minimo (si chiude sempre) ·
> **7** fill totale (taker < 101¢, poi 30 min maker, poi la scala fino al **5%**) ·
> **8** merge (coppia completa ⇒ subito, sempre, **senza limiti di prezzo**) ·
> **9** rotazione (+$0,50/g o +25%; mai con posizione, coppia incompleta o ordini vivi) ·
> **10** kill a −$100 (cancella **E** chiude le posizioni).
> **⚠ CHI CAMBIA UNA REGOLA DEVE CAMBIARE ANCHE IL SUO PASSO DEL BANCO** (18-23), o la prova resterebbe
> a difendere la regola vecchia — che è esattamente come tre difese sono rimaste inerti col verde (p.181).
> **⚠ DUE DIVERGENZE CONFERMATE, dove il codice è PIÙ PRUDENTE della regola e resta com'è**: il margine
> dal bordo è `max(1 tick, 0,22·banda)` e non un tick; il kill **non ha auto-riarmo affatto**.

---

## 🟢 STATO OPERATIVO — vedi i due riquadri qui sopra (18 agosto 2026, letto dai processi vivi)

Capitale all'ultima lettura di agent41: **$1.497,04**. Guardiano perdite in servizio,
`data/guardian-state.json` assente (l'assenza *è* lo stato sano). Una sola posizione residua: Hong Kong
`0xe9b3e28d`, 6 share a carico 0,50, **non chiudibile** (sotto il `min_incentive_size` di 20, §5.2 p.1).

> ## 🔻 IL GRADINO 6 È DISARMATO — decisione dell'operatore, §5-bis p.153/159
> `SBLOCCO_GRADINO6_ARMATO='0'` nell'`env` di agent41. Non è un difetto: armarlo metterebbe il bot su
> **FERMA senza riarmo automatico** — una mano umana per ripartire, con la causa a monte ancora aperta.
> **⚠ DISARMATO NON VUOL DIRE ASSENTE**: la scala sale ancora fino a 6 e il gradino **registra che
> sarebbe scattato e perché** (`data/realloc-scheduler.jsonl`, `disarmato:true`; giornale maker,
> `outcome:'gradino-6-disarmato'`). Conta **episodi**, non tick.
> **⚠ NESSUNA DIFESA VERA È TOCCATA**: guardiano delle perdite, sentinella del collasso e KILL non
> passano da questa scala, e un test lo verifica per assenza.
> **PER RIARMARLO**: si cancella quella riga da `agents/ecosystem.config.js` e si riavvia agent41. Il
> difetto **in assenza della variabile è ARMATO** — un env che sparisce non può spegnere una difesa.
> ## 🕳️ IL VUOTO DI TRE ORE, E COSA NE RESTA — §5-bis p.120-122
> Il 13 agosto, **zero ordini a riposo per 180 minuti** con KILL spento e $609,10 liquidi: non un
> processo caduto, ma **tre numeri in tre moduli che non si parlavano** — righe di piano a $24,00 contro
> un pavimento di $24,50 ⇒ 114 rifiuti identici. La regola che lo impedisce vive in **§4.3** (griglia
> limitata anche dal tetto, 8 livelli minimi). ⚠ Era un **dente di sega**: peggiorava crescendo il
> capitale. ⚠ E le modifiche a `lib/rewards/allocator.js` entrano in servizio **SENZA RIAVVIO** (§5.3).
> Dallo stesso episodio: la **sentinella sul vuoto** (5 min ⇒ ricostruzione) e il **recupero della
> scadenza a tre fonti** (5 posizioni su 7 erano senza scadenza, quindi la chiusura forzata a 3 ore non
> poteva scattare).
> ## 🤖 IL BOT SI SBLOCCA DA SOLO — §5-bis p.124-127
> **Principio: ogni difesa AGISCE, non segnala soltanto** — qui non c'è nessuno a leggere i log. E la
> metà opposta: **quando l'unica via d'uscita violerebbe una regola di rischio, il bot non agisce e lo
> dichiara.**
> **① RIFIUTI RIPETUTI** (`sblocco-progressivo.js`): **5** rifiuti identici di fila sulla stessa coppia
> (mercato, gate) sono un blocco strutturale — il 13 agosto furono **114**. Le 37 famiglie in tre classi:
> **`rischio`** (56% dei 43.299 rifiuti) ⇒ nessuna azione, si cambia mercato e si dichiara perché;
> **`stato-bot`** ⇒ via alternativa vera; **`transitorio`** ⇒ non è un blocco. **Famiglia sconosciuta ⇒
> trattata come rischio.**
> **② COERENZA FRA I MODULI** (`coerenza-soglie.js`): prima di proporre righe si verifica che chi le
> riceve le accetti, e il capitale **può solo SCENDERE**.
> **③ SCALA DI SBLOCCO**, un gradino ogni **5 minuti**: `ricostruisci-piano` → `ricarica-configurazione`
> → `riconcilia-esposizione` → `ripara-precondizioni` → `risveglia-feed` → **`fermati-in-sicurezza`**.
> Caso peggiore: FERMA in **~30 minuti**. **Nessun gradino tocca una regola di rischio**, per struttura.
> **④ AUTODIAGNOSI ogni 120 s**: ordini vivi > 0 · capitale al lavoro ≥ **50% per 15 minuti** · un ciclo
> negli ultimi **20 min** · rinnovi dovuti non fermati oltre l'**80%**. Tutto illeggibile ⇒ **non si
> giudica** e la scala non parte.
> ## 💵 IL «CAPITALE AL LAVORO» DICEVA L'INTENZIONE, NON IL FATTO — §5-bis p.124
> `impegnatoOra` era `giro.allocatoUsd`, cioè **il piano del giro**. Misurato: il giro aveva allocato
> $284, ma di 17 gambe ne sono passate **8** — nozionale reale **$127,79**. La riga dichiarava
> **$578,40 = 87%** contro un valore onesto di ~63%, e sbagliava **sempre nella direzione che
> rassicura** — su un numero da cui l'autodiagnosi decide se il bot lavora. Adesso si sommano i
> nozionali delle sole gambe non rifiutate né saltate; una riga senza `notionalUsd` vale **zero**.
> ⚠ **Pannello Polymarket e bot misurano cose diverse e possono essere entrambi giusti**: «disponibile
> per il trading» **è il cash** e non sottrae i BUY a riposo; il bot conta **posizioni + ordini a riposo**.
> ## 🩸 DOVE MUOIONO LE GAMBE: `coppia-non-atomica` È LA PRIMA CAUSA — §5-bis p.129-130
> **24 ore, 33 giri: 284 gambe pianificate · 260 inviate · 155 accettate · 105 rifiutate · 24 saltate ⇒
> accettazione 54,6%.** **84 gambe perse per $1.276,13 sono `coppia-non-atomica`** (difetto, corretto) ·
> 20 cap cumulativo · 11 per $268,95 `manual-order-cap` (stessa causa) · 9 per $121,23
> `mai-primo-sul-libro` (regola di rischio, perdita voluta) · 4 per $129,95 cap di esposizione.
> **65% delle gambe perse sono coppie abbandonate INTERE perché UNA gamba sfondava il tetto per ordine**
> — il precontrollo atomico fa il suo mestiere, ma la causa a monte era che il pianificatore non
> conosceva il tetto per ordine (corretta in §4.2).
> **⚠ E LA PRIMA CORREZIONE ERA INERTE**: `adattaRighe` girava sul piano **salvato**, e la ricostruzione
> sovrascriveva `righeCandidate` con righe mai passate di lì. Ora è chiamata da **entrambe** le fonti.
> ## 💰 IL RISCATTO AUTOMATICO DOPO LA RISOLUZIONE — §5-bis p.131
> `redeemPosition` esisteva, era provata on-chain e **non aveva chiamanti**. Ora
> `lib/maker/riscatto-automatico.js` lo chiama, agganciato alla scansione dei registri di agent40.
> **⚠ IL SEGNALE È `payoutDenominator(conditionId) > 0` LETTO ON-CHAIN, non «il mercato è chiuso»**:
> `closed`/`acceptingOrders` diventano veri **ore prima** che l'oracolo riporti l'esito, e un tentativo
> prima è un revert che costa gas. **Non letto ⇒ non si riscatta.** **Idempotente** con registro su
> disco (`data/riscatti.json`). **3 tentativi**, poi **10 minuti** di backoff per mercato; al più **3
> mercati per giro** (ogni transazione costa gas al relayer). `negRisk` non booleano ⇒ non si tenta.
> ## 🔭 IL BOT VEDE ~111 MERCATI SU 1.276 PREMIATI — E NON È LUI IL COLLO — §5 punto 132
> `REWARD_MAX_CLOB_MARKETS = 150` ⇒ board ~111 righe: l'88% non viene mai guardato. **⚠ Il tetto NON si
> può alzare** (2,81-3,41 s/mercato: i 1.276 costerebbero ~60 min contro 25 di freschezza). **Il collo era
> l'ORDINAMENTO** — i 150 si sceglievano per montepremi, che vive sui `minSize` grandi, seppellendo i
> mercati alla nostra portata. Correzione: metà dei posti riservata ai `minSize ≤ 100`.
> **⚠⚠ MA VEDERNE DI PIÙ NON ALZA I MERCATI QUOTATI**: il vincolo che morde è il tasso di accettazione
> (§5 p.129) e il tetto per giro. La quota di scansione è **assicurazione**, non la cura di adesso.
> ## 🩹 LE DIFESE DI STAMATTINA AVEVANO DUE DIFETTI, ED ERANO MIEI — §5-bis p.135-136
> **① `ultimoCicloOk` non veniva mai aggiornato**: l'autodiagnosi dichiarava «nessun ciclo da N minuti»
> mentre il bot piazzava 12 gambe su 14. Ora si timbra in **tre** punti — a fine giro e nei due rami
> «nessuna azione», perché **anche un giro che non trova niente HA girato**. Non all'inizio, o si
> timbrerebbe un giro che poi esplode. **② `coppia-non-atomica` non era nella mappa delle famiglie**:
> prima causa di perdita di gambe, finiva in «sconosciuta ⇒ rischio ⇒ non si aggira». Ora 37 famiglie.
> ## 🧹 IL CICLO PESANTE SI FERMAVA PERCHÉ LA FONTE È SPORCA — §5-bis p.137
> «Dopo 3 ricalcoli il piano contiene ancora mercati che il venue rifiuta»: l'esclusione **veniva
> passata**, ma il ricalcolo ripesca dallo **stesso board**, e il board è sporco per una **CLASSE** di
> mercati (`premio-crollato`). **Tre passate contro N mercati sporchi non convergono, e N > 3.**
> Si pulisce la fonte, non si allenta il controllo: la verifica al venue è intatta, ma il suo esito ora
> **sopravvive al ciclo** (`quarantena-venue.js`, 20 minuti). **Non è un cancello**: un mercato in
> quarantena che arrivasse al piazzamento sarebbe giudicato da tutti i gate come prima.
> ## 🛡 IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA — §5-bis p.141
> **k = 2 letture CONSECUTIVE oltre soglia**, e consecutive vuol dire anche **contigue**: oltre **120 s**
> fra una lettura e l'altra il contatore riparte. Una lettura **rientrata** azzera; una **non
> calcolabile** azzera anche lei — «non ho letto» non può confermare che la perdita persisteva.
> **Le soglie NON sono state toccate** (−5% e −$30): si chiede solo che la perdita sia ancora lì trenta
> secondi dopo. Costo: **un giro di ritardo** su uno scatto vero.
> **⚠ VERIFICA RETROATTIVA su 7.213 letture / 5 giorni: con k=2 gli scatti passano da 2 a ZERO, ed
> entrambi erano falsi positivi**, con evidenza indipendente (la lettura precedente diceva +$10,85 e la
> successiva +$2,54, contro i −$39,97 dello scatto). ⚠ Il replay **da solo** non basterebbe — dopo il
> latch il guardiano smette di misurare — sono le letture *intorno* a chiudere la questione.
> Il pre-allarme si vede (`PRE-ALLARME (1/2)`). Lo stato vive **nel processo**: un riavvio lo azzera, ed
> è giusto — un guardiano appena nato non ha visto il campione precedente.
> ## 📉 LA SENTINELLA SUL COLLASSO DELLA COPERTURA — §5-bis p.142, **SOLO OSSERVA**
> **Calo ≥ 85% dal MASSIMO delle ultime 10 minuti**, non differenza fra campioni consecutivi: la cadenza
> è irregolare (mediana 60,0 s, q99 65,3, max 77,2 su 7.859 intervalli) e un crollo che arriva in due
> campioni verrebbe **spezzato in due pezzi** ciascuno sotto soglia.
> **La soglia viene dalla tabella, non dall'intuito** (4,1 giorni, 7.860 campioni): 30% ⇒ 5 veri/183
> falsi · 50% ⇒ 5/20 · 70% ⇒ 5/2 · **80% ⇒ 5/0**. Si sceglie **85 e non 80 perché il divario è VUOTO**:
> fisiologico massimo **75%**, patologico minimo **92,9%**.
> **⚠ NON SI AUTO-INGANNA**: il collasso più grande nei dati **l'ha prodotto il guardiano**. Se il latch
> porta uno scatto nei **15 minuti** precedenti il calo è **SPIEGATO** e non si arma; latch illeggibile
> ⇒ **non si arma**. **⚠ IN QUESTA FASE SOLO OSSERVA**: log + giornale, non ferma il bot e non tocca
> AVVIA/FERMA — un test lo verifica **per assenza** dei campi che agirebbero. **⚠ Limite: 5 soli eventi
> positivi in 4,1 giorni.**
> ## 🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA — §5-bis p.143
> Il Livello 2 prezzava il completamento **sempre al tetto della coppia**, e `fuoriBanda` era calcolato
> e solo **dichiarato**. Quando il tetto cade **sopra** il bordo alto della banda premiante si può
> **abbassare** fino al bordo, e conviene **due volte**: la controparte **costa meno** (il margine della
> coppia cresce) e l'ordine **matura reward mentre aspetta** invece di essere capitale fermo. L'unico
> prezzo è il **tempo di fill**, ed è lo scambio che l'operatore ha scelto esplicitamente.
> **⚠ NON ALLENTA NIENTE, per costruzione**: è un `Math.min`, quindi il prezzo può solo **scendere**.
> Tetto della coppia intatto, «mai primo sul libro» intatto, size intatta. Banda non leggibile, o bordo
> **sopra** il tetto ⇒ prezzo **identico a prima**.
> ## ⏱ LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — §5-bis p.138
> **Il fatto**: una posizione NO di 58,8 share è rimasta scoperta **8,2 ore**. Nessuna singola regola
> aveva sbagliato: sbagliava il **sistema** in un punto solo — **nessuno guardava da quanto tempo la
> posizione era scoperta**.
> **Le soglie vengono dai dati, e la distribuzione è BIMODALE** (24 episodi, 48 h): **7 chiusi**, mediana
> **10,5 min** — contro **17 aperti**, mediana **126,5 min**, massimo 553,7. Una scopertura sana si chiude
> in dieci minuti; oltre l'ora non si chiude quasi più da sola. La scala e i suoi gradini stanno in §4.6.
> **⚠ NESSUNA REGOLA DI RISCHIO È TOCCATA**: il modulo non produce prezzi, produce un **pavimento**; il
> prezzo lo sceglie il motore, che applica «mai primo» come sempre. La concessione **non esce dalla
> banda**. **⚠ OROLOGIO NON LEGGIBILE ⇒ GRADINO 0.**
> ## 🧱 I RESIDUI SOTTO IL MINIMO: LA VIA D'USCITA C'È, E NON PASSA DAL LIBRO — §5-bis p.187
> Un residuo sotto `min_incentive_size` non è ripiazzabile né completabile: il venue rifiuta. **Ma non è
> capitale perso** — il **riscatto on-chain** non ha minimi di size ed è cablato (§5 p.131). Il costo non
> è il capitale: è il **tempo** fino alla risoluzione, più il rischio direzionale su una gamba nuda.
> Caso peggiore su un mercato che il bot può davvero aprire: **$45,24** (minSize 50). Bloccato adesso:
> **$3,00** (i 6 share di Hong Kong). ⚠ Resta aperto solo **che il residuo nasca**: le leve sono la size
> e la profondità, non un meccanismo nuovo.
---

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
| `agent45-osservatore` | **L'osservatore muto** (13 agosto 2026). Un campione ogni **60 s** in `data/osservatore/`: ordini a riposo, mercati con posizione (coppie vs gambe nude), posizioni e valore, saldo, totale, PnL del guardiano, stato degli interruttori, reward di giornata. Più un **giornale in italiano** con gli eventi: pre-allarme, scatto, collasso, transizioni coperta⇄scoperta **con la durata**, merge, cancellazioni. **Non decide, non agisce, non avvisa.** Rotazione giornaliera, 30 giorni. Strutturalmente incapace di toccare capitale — un test cammina il suo albero dei `require`. **Read-only ⇒ riavviabile senza conferma.** | `agents/agent45-osservatore.js` + `lib/osservatore/campionamento.js` |
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

**Il controllo dei percorsi, in tutti e nove gli agent che scrivono.** `lib/safety/percorsi-critici.js`,
chiamato all'avvio: radice del package, `data/` scrivibile, directory di servizio creabile, e ogni file di
servizio **già esistente** scrivibile da noi. Su guasto: stderr + `exit 1` ⇒ sotto pm2 riavvio e poi
`errored` in rosso. ⚠ Un file **assente** non è mai un errore (è il primo avvio, o lo stato sano); non si
controlla il **contenuto** (la freschezza ha già i suoi presidi). Test 15/0, che costruisce ogni guasto
vero e poi lo rimette a posto — un controllo sempre rosso non distingue niente (§5-bis p.189).

**La scheda del guardiano:**

| | |
|---|---|
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il **riferimento a massimo mobile** in `data/guardian-baseline.json` (§5-bis p.157: depositi e prelievi sono riconosciuti come cassa esterna, non come P&L). **⚠ IL RIFERIMENTO SCENDE SUBITO E SALE SOLO SU CONFERMA** (D-D, 21/08, §5-bis p.202): un totale sopra il riferimento e' un **candidato** finche' una seconda lettura **distinta e contigua** non lo sostiene, e allora sale al **minimo delle due**; un rientro lo scarta. Il cricchetto accettava **k=1** dove lo scatto pretende **k=2**, e il 16/08 ha latchato per sempre $1.550,18 = saldo post-chiusura + posizioni pre-chiusura, cioe' **$57,10 contati due volte**. **⚠ NESSUN RIARMO AUTOMATICO DI AVVIA, per decisione**: sarebbe una **terza** strada autonoma verso il capitale reale (§2 r.3 ne nomina due) dentro il modulo il cui mestiere e' fermare. Dopo uno scatto il bot riparte a mano — misurato: **6h06m** di fermo dopo il falso scatto del 20/08 22:36, costate non perche' il riarmo e' manuale ma perche' **nessuno sapeva**. Da qui l'**AVVISO** (`lib/maker/allarme-guardiano.js`), cablato come **ULTIMO** passo di `spazzaEFerma`: non puo' ritardare la spazzata (gira dopo cancellazione, FERMA, referto e latch), non puo' farla fallire (non solleva mai, e il chiamante ha un secondo `catch`), non aggiunge **nessuna** chiamata nei giri normali — un test lo verifica **per ordine** nel sorgente e **per assenza** dentro `poll`. **⚠ E' INERTE FINCHE' `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` non sono nel `.env`** (le stesse due chiavi di `agent27:101`): senza, dichiara nel log che non e' partito e perche'; oltre `GUARDIAN_LOSS_PCT` (5%) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` resta il pavimento in dollari) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. **⚠ IL SECONDO INGRESSO — la perdita giornaliera realizzata a −$100 — DA R10 CHIUDE ANCHE LE POSIZIONI** (18/08): `chiusura-di-emergenza.js` (puro, **zero `require`**) classifica in **coppie a merge · gambe scoperte vendute attraversando · gambe sotto il minimo LASCIATE e dichiarate**, e agent43 **deposita** `data/chiusura-emergenza-richiesta.json` senza eseguire — la sua unica superficie al venue resta la spazzata, ed è una proprietà strutturale provata. A eseguire è **agent41**, che gira **prima** del cancello su AVVIA: il presidio dei 60 minuti sta dietro `botAttivo()`, cioè non gira a bot FERMO, che è lo stato che il kill produce. Il drawdown continua a NON toccare le posizioni, ed è una decisione: misura un **prezzo**, che può rientrare. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

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

---

## 4 · STATO ATTUALE DEL SISTEMA

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità. **I reward si pagano sugli ordini a riposo, non sui fill** — per un maker
l'esecuzione è il costo, non il ricavo. Ogni numero qui sotto è letto dal codice/stato reali.

### 4.1 · Il motore di piazzamento — `lib/maker/motore-unico.js`

Un profilo solo dal 6 agosto 2026 (Safe/Risk aboliti: la formula del venue è una curva continua e non
conosce bucket; nessun `if (profilo)` nel repo). **Le cinque regole, nell'ordine in cui si applicano:**

1. **Mai primo sul book** — vincolo assoluto, slegato dal punteggio. Se «un tick dietro il migliore» e
   «dentro la banda» si contraddicono, **vince la banda**: ci si ferma al suo bordo e il verdetto porta
   `onTop:true` perché il caso sia visibile. `top-of-book.othersLadder` sottrae i nostri ordini, o il
   motore inseguirebbe se stesso fino al bordo.
   **Due sole eccezioni**, entrambe omissioni puntuali del flag `inCoda` su UNA gamba, entrambe
   condizionate, e un test ne conta **esattamente due**: la controparte quando la banda sta **sotto il
   carico** (§5 p.59-60) e la gamba contraria del rimasuglio da chiudere (§5 p.66).
2. **Depth floor adattivo** — `DEPTH_FLOOR_PCT_OF_AVG = 0,10` della liquidità altrui media in banda di
   quel mercato specifico, non un dollaro fisso. Ripiego $15 per i mercati senza storico.
3. **Poi ci si ferma** — conseguenza del quadratico: soddisfatte 1 e 2 il livello trovato è già quello
   col punteggio più alto. Non esiste un controllo separato di volatilità o spread.
4. **Lato singolo deciso dalla formula, non da un timer** — dentro `[0,10 · 0,90]` un lato solo matura
   comunque un terzo e si tiene; fuori matura **zero** e si cancella subito. Il mid si rilegge a ogni ciclo.
5. **Tetto di capitale per mercato** — vedi 4.2. È gestione del rischio, deliberatamente fuori dal
   calcolo del punteggio.

**Soli sul lato ⇒ bordo ESTERNO della banda** (modo `fallback-alone-bordo-esterno`): senza concorrenti
si è primi per forza, quindi l'obiettivo è stare al prezzo **peggiore che resta premiante** — il fill è
improbabile e il reward matura comunque. Banda senza prezzi validi ⇒ **non si quota**. Appena compare
un concorrente si torna a un tick dietro.

**⚠ IL BORDO NUDO NON SI USA PIÙ: c'è un MARGINE, ed è adattivo** (16 agosto 2026, §5-bis p.164).
`distanza-obiettivo.bordiConMargine` rientra il bersaglio di **`max(1 tick, 0,22 × v)`** dal bordo —
0,22 è **esattamente un tick sulla banda modale** (1,0¢ su 4,5¢), quindi il margine vale lo stesso
numero di centesimi su qualunque griglia. Un margine misurato in **tick** sarebbe adattivo alla griglia
e non al mercato: su un mercato a tick 0,1¢ un tick è il **2,2%** della banda, cioè il bordo nudo.
**Due ragioni, e la seconda è quella che conta**: ① al bordo il punteggio è ~zero per costruzione
(`S = ((v−s)/v)²`) — misurato **S 0,0123 al bordo contro 0,1111 un tick dentro, 9×**; ② il margine è la
**soglia bassa di uno Schmitt trigger**: si esce dalla banda a `v + hysteresisTicks` e si **rientra** a
`v − margine`, così non esiste più uno stato in cui un solo tick di mid rimette l'ordine fuori.
**⚠ Il margine non può mai avvicinare al mid oltre il prezzo di coda**: è applicato come `Math.min` col
prezzo che «mai primo sul libro» ha già scelto, e quando cede il fatto è dichiarato (`margineCeduto`).
Bordi che si incrociano (banda più stretta del doppio margine) ⇒ margine **non applicato** e dichiarato.
**⚠ E IL MARGINE SI FERMA A METÀ BANDA** (`FRAZIONE_MASSIMA_DEL_RAGGIO = 0,5`, costante di sorgente,
**nessun env**): oltre `v/2` l'ordine starebbe nella metà **interna** della banda, cioè più vicino al
mid che al bordo — chi ha chiesto il bordo esterno otterrebbe il contrario. Il tetto può portare il
margine a **zero** su una banda più stretta di due tick, e allora il bordo torna nudo: è la risposta
onesta, non se ne inventa uno. **Trovato dal selfcheck del riprezzo**, non dal ragionamento: su banda
±1,5¢ con tick 1,0¢ un tick di margine portava il bersaglio **esattamente sul mid**.

**Fine scala**: sotto 3¢ o sopra 97¢ un mercato sta risolvendo e non si quota (`end-of-scale.js`,
soglie da `.env` rilette a ogni chiamata; un valore che non si capisce viene **scartato** in favore del
difetto — un `.env` sbagliato non può spegnere una protezione). La chiamano quattro moduli.

**Mid stantio**: oltre **120 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, env con clamp
`[5 s, 120 s]`; **20 → 120 il 16 agosto 2026** — cancellava a 20 s ciò che `decideReprice` non era
disposto a riprezzare prima di 60 s, cioè distruggeva ordini che nessuno stava per correggere).
L'orologio si azzera **solo su una lettura buona**, e una cancellazione fallita NON lo azzera. Tre cause distinte in audit — `cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}` — perché
l'azione è la stessa ma la diagnosi no.

**Cadenza di reprice adattiva per mercato** (`cadenza-adattiva.js`): l'escursione del mid su 15 minuti
si traduce in tick/ora e da lì in tre classi — veloce 1 s, media 5 s, lenta 10 s. Chiamate al venue
−37,9%. **Non abbassa nessuna soglia**: `minMoveCents`, `hysteresisTicks`, `confirmSamples` e
`minIntervalMs` restano dov'erano, e guardare più spesso non riprezza di più. Misura assente ⇒ cadenza
di difetto. La decisione è guidata anche dall'**istante dell'ultimo book**, così un mercato «lento» col
book appena cambiato non aspetta dieci secondi.

### 4.1-bis · Il riprezzo guarda il BOOK, non solo il mid — R4, 18 agosto 2026

> **⚠ IL TRIGGER 3 VEDEVA SOLO IL CASO ESTREMO.** «Siamo diventati i primi del nostro lato»
> (`auto-reprice.js:626`) scatta col mid fermo, e cancella o si rimette un tick dietro. Ma la
> degradazione **PARZIALE** — un taker mangia tre livelli su cinque, il mid non si muove, davanti resta
> qualcuno ma molto meno — non la vedeva nessuno. È il momento in cui il rischio di essere riempiti sale
> proprio mentre il prezzo sta per muoversi contro.
>
> **IL TRIGGER 4** (`auto-reprice.js:681`) chiama `book-erosion` — che esisteva, era testato, ed era
> cablato **solo** in `mm-tracking`, motore senza nemmeno un mercato configurato. Un presidio intero che
> non poteva girare: la forma di «una cintura senza chiamanti».
>
> | cosa | valore | dove |
> |---|---|---|
> | criterio | **solo erosione RELATIVA**: < 40% della baseline, 2 letture, isteresi 40/60 sulla baseline **congelata** | `book-erosion.updateErosion` |
> | buttato | **«è sparito un livello»** — 1.690 scatti su 1.775 misurati venivano da lì, e su un feed troncato a **3 livelli** quel conteggio è rumore | — |
> | freno | **60 s** (non i 30 di difetto): è il rail del venue, 40 invii/60 s | `sospensione-erosione.FRENO_MS`, **iniettato** |
> | lato | **SELL esclusi**, come il TRIGGER 3 | `o.side !== 'SELL'` |
> | azione | **cancella e resta fuori**, tetto **5 minuti**, poi rientra e lo **dichiara** | `sospensione-erosione.js` |
>
> **⚠ NON PRODUCE MAI UN PREZZO**: può solo cancellare. Banda, «mai primo», tetti e scala d'urgenza
> restano identici — monotono, si aggiunge una cancellazione e mai un ordine.
> **⚠ SENZA IL REGISTRO SU DISCO LA REGOLA NON ESISTEREBBE**: a cancellare è agent40, a rimettere la
> gamba è agent41 (`ripristinaGamba`), e la sua scala parte **subito** — avrebbe rimesso a libro entro
> 120 s la gamba appena tolta. «Fuori 5 minuti» sarebbe durato due.
> **⚠ SE LA SOSPENSIONE NON SI SCRIVE, NON SI CANCELLA**: meglio non uscire che uscire e rientrare
> subito — la seconda cosa paga il costo (l'ordine perde la priorità di coda) senza comprare la
> protezione.
> **⚠ FAIL-APERTO, contro la regola generale del repo**: registro illeggibile ⇒ nessuna sospensione ⇒ la
> gamba torna a libro. Una sospensione è un'**astensione dal premio**, e un file che non si legge non
> deve poter tenere il bot fuori dal libro per sempre.
> **LA MISURA (17 agosto, 50 mercati, 34.478 campioni)**: 97 episodi · mediana **5,44 min/giorno** per
> mercato sui 30 osservati ≥ 12 h, peggiore 30,87 · premio perso **$0,025/giorno sui tre attivi** ·
> **66 episodi su 97 finiscono per TETTO**, cioè il libro **non si ricostruisce in 5 minuti**.
> ⚠ Il feed campiona ogni ~115 s e agent40 ogni 5-10 s: **i 97 sono un limite inferiore**.

### 4.2 · I tetti di capitale — `lib/rewards/concentration.js`, UNA fonte, importata

**Nessun numero cablato: il tetto DERIVA da `f_min`.**

```
tetto per mercato = pavimentoPremiante(SCAGLIONE_FINANZIABILE) = 50 × 0,98 × 1,25   = $61,25
                    ⇒ f_min NON è più l'ingresso: è la conseguenza, e vale 0,32
tetto per ordine  = tetto × 0,97 / 0,98 + $5                                         = $65,63
pavimento premiante(minSize) = minSize × 0,98 × 1,25   ⇒ 20/50/100/200 = $24,50/$61,25/$122,50/$245
tetto EFFETTIVO per ordine = min(safety.maxOrderNotionalUsd $80, $65,63)             = $65,63
```

**⚠ IL TETTO PER ORDINE NON È PIÙ «METÀ DEL MERCATO»** (16 agosto 2026, §5-bis p.164). `tetto/2 + $5`
è la gamba giusta **solo a mid 0,49**: su un mercato sbilanciato la gamba cara vale fino al
`PREZZO_MASSIMO_QUOTABILE = 0,97` del costo della coppia, cioè il **99%** del capitale del mercato, e il
tetto la rifiutava. **Era la causa a monte misurata di `coppia-non-atomica`** — la prima causa di
perdita di gambe (84 gambe, $1.276,13 in 24 h, §5 p.129-130): il precontrollo atomico faceva il suo
mestiere e abbandonava la coppia **intera** perché una gamba sfondava. Adesso il tetto è dimensionato
sulla **gamba peggiore quotabile**, non sulla media. Conseguenza derivata e non ricopiata: la
**finestra di mid** passa da `[0,43 · 0,57]` a `[0,01 · 0,99]`, cioè smette di essere un cancello
(`finestraMid` ricalcolava la derivazione vecchia — era una copia D1, ora importa `liveMinOrderCapUsd`).

- **Il numero di mercati è una CONSEGUENZA** (`capitale ÷ tetto`), non un parametro: quando il capitale
  cresce si spalma su **più mercati**, non si ingrossa la size su ciascuno. Una frazione pura
  (`tetto = C×k`) fa esattamente l'opposto ed è stata scritta e buttata (§5 p.107).
- `capPerMarketUsd(capitale)` **non restituisce mai `null`** (a valle varrebbe «nessun tetto», il
  fail-open della vecchia versione a percentuale) e può solo **stringere**: si clampa al capitale.
- **Undici consumatori lo IMPORTANO**, nessuno lo ridichiara: pianificatore/knapsack, motore (Regola 5),
  `decideRimpiazzo`, punteggio di rischio, adapter, corsia manuale, … `netto-centralizzato.test.js`
  verifica gli import **per nome**, e il rilevatore **D1** dell'audit sorveglia `MARKET_CAP_FIXED_USD`.
- **Un mercato sotto il pavimento premiante NON si quota**: sotto `min_incentive_size` il reward è
  **ZERO**, non più basso. Meglio meno mercati sopra soglia che tanti sotto.
- **⚠ Il tetto NON si può alzare per diversificare** (§5 p.117): dei 323 mercati del board solo **50**
  hanno `minSize 20` (l'unico scaglione sotto $32,67) e **49 sono meteo**; i 196 a `minSize 1000`
  chiedono $1.225 per mercato. A `f_min` 0,32 i mercati passabili **CALANO** da 21 a 18, perché `Q`
  cresce col tetto mentre il margine di $5 sul tetto per ordine resta fisso e la **finestra di mid si
  stringe**. La leva è più capitale, non una manopola.

> **🔓 IL TETTO DI ESPOSIZIONE NON PUÒ PIÙ MURARE UNA GAMBA NUDA — 16 agosto 2026, §5-bis p.168.**
> `evaluateLimits` limite 2 confrontava `openNotionalUsd + notional > cap` **su qualunque ordine**, che è
> l'aritmetica di uno che APRE. Su uno che CHIUDE è sbagliata **di segno**, e al tetto produceva una
> trappola **nei due versi**: la gamba riempita è già dentro `openNotionalUsd`, quindi veniva rifiutato
> sia il **BUY** che completa la coppia sia la **SELL** che liquiderebbe la gamba nuda — anche la sua
> size veniva sommata invece che sottratta. Verificato sul codice di ieri: **entrambi `allow:false`,
> gate `max-open-notional`.** Terza occorrenza della classe «regola nata per limitare l'APERTURA
> applicata a un'azione che non apre» (§5-bis p.133, p.147).
> **⚠ NON È UNA DICHIARAZIONE DI CUI FIDARSI**: l'esenzione arriva già **provata** da
> `esenzione-chiusura.provaChiusura`, la **stessa** funzione del tetto per ordine — importata, non
> ricopiata, e calcolata **una volta sola** per ordine (memoizzata in `adapter.js`). SELL entro il
> posseduto, BUY entro `manca`, letti dallo snapshot del venue; qualunque lettura mancante lascia il
> tetto applicato. Si guarda `=== true`, mai la truthiness.
> **⚠ ESENTA QUESTO TETTO E BASTA**: tetto per ordine, rate limit, perdita giornaliera, posizioni
> illeggibili, esposizione non misurabile, allowlist e KILL restano davanti e **identici** — sei
> asserzioni lo verificano una per una. L'esenzione **si dichiara** nell'audit
> (`outcome: 'esenzione-esposizione-chiusura'`) e **non** si dichiara quando il tetto non stava
> mordendo, o il conteggio di domani sarebbe sporco.

**Tetto di ordini per finestra** (`data/safety-risk-limits.json`): **40 invii / 60 s**, con **quota
60/40** — al più 24 posti alle aperture, **16 riservati a rinnovi e chiusure protettive**. Invariante
difesa da un test: `rateCap ≥ 2 × mercatiPerGiro` con almeno 8 posti di margine. Un'apertura rimandata
è un **rinvio dichiarato** (`rimandato-per-quota`), non un errore. Cap per ordine di safety **$80**
(era $1000 — 16 agosto 2026, decisione dell'operatore) e cap cumulativo di esposizione aperta **$650**
(era $600 → $150 il 16 agosto → **$650 il 18 agosto sera**, decisione dell'operatore, per reggere i
**5 mercati** di §4.13: conta i **fill riconciliati**, non gli ordini a riposo).
**Perdita giornaliera massima $100** (era $25) — **è questo il freno vero**, non il tetto di
esposizione, che serve solo a non murare la gestione.

> **⚠ PERCHÉ $650 E NON $320 — 18 agosto 2026.** 5 × $61,25 = $306,25 di ordini a riposo, quindi «poco
> sopra $310» sembrerebbe bastare. **Non basta**: il gate confronta `openNotionalUsd + notional`
> **anche sugli ordini di APERTURA**, quindi a $320 si smetterebbe di piazzare a metà strada —
> esattamente ciò che è successo a $150 il 16 agosto, quando la gamba più cara del piano smetteva di
> essere piazzabile oltre ~$95 di fill. Caso peggiore calcolato: $306 a riposo + $310 di fill ≈ **$616**.
> **⚠ E `data/safety-risk-limits.json` NON È PIÙ GITIGNORED** (18 agosto 2026): i cinque numeri che
> governano l'esposizione vivevano solo sul disco di una macchina, e un ripristino da git li avrebbe
> riportati a valori diversi **in silenzio** — è lo stesso file che faceva fallire il banco al passo 3
> perché nel worktree non c'era. Scelta **una fonte sola versionata**, non default-nel-repo +
> override-locale: due file sono il modo in cui il valore locale diverge senza che nessuno lo veda.
> `limiti-versionati.test.js` (19/0) fallisce se il file manca, se torna in `.gitignore`, se manca uno
> dei cinque limiti, se un valore supera il tetto duro, e — l'asserzione che conta — **se il disco non
> coincide con il versionato**. ⚠ Il lettore già falliva chiuso e non è stato toccato: `clampNum` marca
> `missing`, `HARD_CEILINGS` taglia solo dall'alto, `manual-order` rifiuta con `cap-missing`.
**Mercati per giro: 10** (era 12 — 13 agosto 2026), dichiarati in
**un posto solo** (`utilizzo-capitale.leggiMaxNuoviPerGiro`) e importati dal trigger.

**⚠ La quota 60/40 sui volumi di oggi non morde mai** e va saputo: 141 intent in 48 h, picco 18/min
aperture contro 24 posti. Il gate del rate limit del **venue** ha morso **una volta in 48 ore**. E
`skip-rate-limited` in `auto-reprice` **non è** il rate limit del venue: è `minIntervalMs`, l'intervallo
anti-churn **locale** di 30 s, che per costruzione non può costare un ordine (margine di rinnovo 180 s).
La causa vera per cui un rinnovo muore è `motore-non-conforme` — il rimpiazzo non sarebbe stato un
ordine valido, e il motore ha ragione a non piazzarlo.

### 4.3 · La griglia del piano — `lib/rewards/allocator.js`

`unitUsd` (granularità in dollari del knapsack) è il **minimo** fra `round(budget/50)` e
`floor(tetto_per_mercato / LIVELLI_MINIMI_PER_MERCATO)`, con **8 livelli minimi per mercato**. Può solo
**infittire** la griglia, mai diradarla (è un `Math.min`), e vale **solo per il pianificatore**: chi
passa `cfg.unitUsd` esplicito — ogni driver di backtest — non è toccato, quindi le serie storiche
restano confrontabili numero per numero.

**⚠ Senza questo limite il tetto è IRRAGGIUNGIBILE e il piano si autoblocca.** È il deadlock del
13 agosto: con `unitUsd` legato solo al budget, `floor(32,67/12) = 2` livelli ⇒ massimo allocabile
**$24,00** contro un pavimento di $24,50 ⇒ **ogni riga di ogni piano rifiutata, per sempre**. Vedi
§5 punto 120: era un **dente di sega**, cioè peggiorava crescendo il capitale.

### 4.4 · Selezione e filtri del piano

| filtro | dove | regola |
|---|---|---|
| **orizzonte** | `horizon.js` | `[MIN_HORIZON_DAYS **0,50** · MAX_HORIZON_DAYS 150]`, confini **inclusivi da entrambi i lati**. Il pavimento in ore (**12 h**) è **derivato** in `market-validity` e in `risk-classifier`, non ripetuto. **0,75 → 0,50 il 13 agosto 2026**: il confine di rischio misurato è a **6 ore** (sotto, il 35,1% delle uscite arriva dopo la risoluzione; fra 6-12 h è 0/36, fra 12-18 h 0/15), quindi a 12 h restano **due volte** il margine. **0,25 g è sconsigliato.** Sul board vivo: utilizzabili **13 → 50**, coperti **13 → 35**, capitale impiegato **$796 → $2.144**, reward modellato **5,14×**. **Scadenza non determinabile ⇒ ESCLUDE**. ⚠ **È il filtro che taglia di più**: 78 mercati su 102 valutati il 13/8 alle 20:17, e il gradino è tutto fra 12 h e 18 h — vedi §5 punto 129 prima di toccarlo o di lasciarlo com'è |
| **quota coda lunga** | `allocator.js` | il capitale oltre `LONG_TAIL_DAYS 7` non supera il **12%** del piano. **Due passate**, non una potatura: la fascia corta gira col budget pieno, la coda riceve `S·q/(1−q)` — non `S·q`, che sbaglierebbe in difetto perché la quota è sul totale e il totale contiene la coda. Fascia corta vuota ⇒ la coda non ottiene niente |
| **profondità** | `profondita-minima.js` | **scala la size**, non toglie il mercato: `S_max = cQ · q/(1−q)` a `q = 0,60`, cioè `1,5 · cQ`. Esclude solo dove **nessuna size piazzabile** regge, con due motivi distinti (`escluso-troppo-sottile` / `escluso-sotto-minimo`). ⚠ **VINCOLO ASSOLUTO: mai forzare la size al minimo del venue oltre la quota sicura** — è strutturale (i due rami di esclusione restituiscono `tenuti` senza toccarlo), non promesso |
| **quotabilità** | `allocator.js` | chiama `planBehindBest`, **la stessa funzione del piazzamento**, su **entrambi** i lati (una riga con una gamba sola è esposizione direzionale). Fail-open: dati mancanti ⇒ `ignota`, il mercato resta. «Nessun concorrente» **non** è un dato mancante: è il ramo «soli», quotabilissimo |
| **tetto di credibilità** | `realistic-estimate` | `maxCredibleShare = 0,60`, applicato per **LIVELLO** della curva: aggiungere capitale a un mercato sottile smette di aiutare oltre il tetto. È la concavità che alla selezione mancava. Una definizione sola, importata da entrambe le parti |
| **book vuoto verificato** | `allocator.js` | `capVuotiFrac = 0,30` del lordo pesato. Uno **0 misurato** (≥10 campioni ws su book fresco) non è un buco: un dato mancante è `null` e **non diventa mai zero**; sul non verificato l'obiettivo **si astiene** |
| **peso di posizione** | `allocator.js` | il lordo è pesato col punteggio alla distanza **reale**, non al ceiling: su banda 4,5¢ un tick vale 2,79× fra tick grosso e fine. Acceso **solo** nel pianificatore |

**`ignota` non esclude mai** — vale per profondità, quotabilità e (fino al filtro d'orizzonte) scadenza.

**Una sola formula capitale→share**: `lib/rewards/size-da-capitale.js`, `Q = C/(p_yes+p_no)`. **Il mid
non decide più chi qualifica**: `capitalToQualifyUsd(0, 20)` e `capitalToQualifyUsd(0.9, 20)` danno lo
stesso numero. Il ripiego senza costo della coppia usa il tipico **0,98** e lo **dichiara**
(`modello: 'ripiego-tipico'`), mai la vecchia `(C/2)/mid` — che a mid 0,055 sbagliava di nove volte.

**⚠ Il tetto è un SOFFITTO, non l'allocazione**: la griglia può fermarsi sotto, e allora il `f_min`
reale del piano è più alto dell'obiettivo. Con la griglia di 4.3 le righe arrivano al tetto e `f_min`
torna ≈ 0,61.

### 4.5 · Il capitale al lavoro — `utilizzo-capitale.js` + `capitale-al-lavoro.js`

```
totale   = saldo + posizioni          ← e NIENTE altro
libero   = max(0, saldo − ordiniARiposo)
alLavoro = totale − libero            ← DERIVATO per differenza, mai risommato
obiettivo = 0,95      (leggiTarget, unica fonte)
```

Un BUY a riposo **non abbassa il saldo** su questo venue: l'ordine è firmato off-chain e il collaterale
resta nel wallet fino al match. Quindi `ordiniARiposo` è un **sottoinsieme** di `saldo + posizioni`, mai
un addendo — sommarlo è il doppio conteggio del 9 agosto (+16,1%, §5 p.58), che oltre a mentire
**allargava un limite di rischio** (il tetto è una frazione del totale).

`misuraDopo` **non accetta più il saldo come parametro**: l'errore non è più esprimibile.
`riconcilia()` ferma il giro (`fermato-capitale-incoerente`) se due letture del saldo divergono oltre
**max(2%, $5)** — relativa perché su conti grandi $2 non sono niente, assoluta perché su conti piccoli
il 2% è rumore. **Una lettura mancante non è una lettura concorde**, ma nemmeno una divergenza: se la
misura non è leggibile non si confronta e si prosegue col saldo del trigger.

**Non misurabile non è zero**, mai: un saldo illeggibile trattato come 0 direbbe «utilizzo 100%» proprio
quando il capitale è fermo. Sotto l'**80% per 30 minuti** si scrive la **ripartizione del fermo in
dollari**, attribuita **da monte a valle** (piano senza righe → non quotabili → tetto pieno → quota →
rifiuti del venue) così lo stesso dollaro non è contato due volte, e ciò che nessuno ha misurato resta
**`non attribuito`: una voce, non un arrotondamento nascosto**. Si vede su
`GET /api/maker/utilizzo-capitale`, nel giornale (`op: capitale-al-lavoro`) e a ogni ciclo di agent41.

### 4.6 · Il ciclo di vita di una posizione

**Fill ⇒ modalità chiusura** (`modalita-chiusura.js`): timestamp scritto una volta sola e persistito, le
share non fillate **spariscono in ogni caso**, poi **PIANO A** — il taker immediato, che è il Livello 1
e non un secondo meccanismo — e **solo se fallisce** le regole di chiusura. Parziale e totale sono lo
**stesso percorso**: la ramificazione è nei dati (`residuiDaCancellare` guarda il libro), non in un `if`.

**⚠ FILL PARZIALE: IL RESIDUO SI CANCELLA SEMPRE E SUBITO** (17 agosto 2026, decisione dell'operatore —
sostituisce la regola opposta del 16 agosto). Il residuo dell'ordine che ha prodotto il fill esce dal
libro **a ogni giro** finché è là, non solo al primo e non solo quando la coppia si completa. **Tre cose
che la correzione ha scoperto**: ① la condizione precedente (`resid.fillOrdine === PARZIALE`) era una
**tautologia** — `fillOrdine` è *derivato* dalla presenza del residuo, quindi i due rami erano lo stesso
ramo; ② la guardia vera era `statoChiusura.nuova`, cioè **solo il primo giro**: un secondo fill parziale a
ciclo già aperto lasciava il residuo a libro; ③ la guardia non può essere `statoChiusura.attiva` — a coppia
già completa la modalità chiusura non viene nemmeno aperta, ed è il caso per cui esisteva il PASSO 2-bis.
La guardia è **«il registro della modalità chiusura è cablato»**: senza `deps.chiusura` il comportamento
resta quello di prima. **Il PASSO 2-bis è stato rimosso** (era diventato irraggiungibile) e con lui gli
esiti `coppia-completa-residuo-*`: da oggi c'è `modalita-chiusura-residuo-non-fillato-cancellato`, con
`alPrimoGiro` a dire quando. **⚠ Si perde** che il residuo si riempia da solo completando la coppia senza
pagare lo spread; si evita una posizione direzionale che cresce mentre la scala d'uscita la riduce.
**Le liste non sono ricopiate**: filtrano l'unica di `modalita-chiusura.residuiDaCancellare`.

**La gerarchia del merge, senza scorciatoie.** `completaCoppia` è chiamata da **tutti** i rami di
`runAutoCloseCycle` — `already-covered`, `close-at-market`, uscita ordinaria e **`skip`** (§5 p.110) —
tranne i tre in cui manca un ingresso (`no-position`, `no-entry-price`, `rules-unreadable`), che lo
**dichiarano** (`merge-saltato-senza-ingressi`) invece di tacere.

| # | stadio | tetto |
|---|---|---|
| 0 | **merge on-chain** se la coppia è già completa | rende **$1/share subito**, gas del relayer, zero slippage |
| 1 | Livello 1 — taker sull'altro lato | coppia ≤ **101¢** |
| 2 | Livello 2 — maker a riposo, attesa **30 min**, **bersaglio su disco**; ai cicli dopo si **aggiunge** la differenza, mai si sostituisce l'ordine vivo (aprirebbe una finestra di scoperto totale) | coppia ≤ 101¢ |
| 3 | chiusura rapida: taker fin dove il book copre + limit per il resto | coppia ≤ **101¢** |
| 4 | riposizionamento scoperto: SELL a **+1% dal carico**, dentro banda e **mai sotto il carico**, + BUY sulla controparte | coppia ≤ 101¢ |

**⚠ IL LIVELLO 0 SI VALUTA PRIMA DI QUALUNQUE GUARDIA SUL PREZZO** (R8, 18 agosto 2026). Le due guardie
che aprivano `decidiLivello` — carico non leggibile, tetto non calcolabile — parlano entrambe del prezzo
a cui si comprerebbe il **secondo lato**, e stavano **sopra** il conto di `manca`: quindi rispondevano
anche a una coppia **già completa**, dove nessun secondo lato va comprato, e la risposta era `auto-close`
— vendere una gamba sul libro invece di incassare $1/share senza slippage. Adesso il conto di `manca`
sale sopra le due guardie; chi **compra** pretende ancora carico e tetto, identici. Monotono: si tolgono
due rifiuti, non si aggiunge un acquisto.

**Un obbligo di esito** si apre nella stessa istruzione che scrive la decisione e va chiuso: due punti di
flush che nessun `continue` può saltare, e `merge-esito-mancante` per chi sfugge. **Ogni** esito di
`registraCoppia` scrive una riga, `non-applicabile` e `in-attesa` compresi.

**Tetto della coppia 101¢, e adesso è UNO SOLO** (16 agosto 2026, decisione dell'operatore, §5-bis
p.165). Prima erano due — 99¢ per il merge («è *profittevole*?») e 120¢ per la chiusura rapida («è
*accettabile*?»). La misura di §5-bis p.162 sui 65 maker veri li ha allineati: il costo mediano di una
coppia completata è **100,00¢** e solo il **41,2%** chiude entro 99¢, quindi il tetto a 99¢ rifiutava la
maggioranza delle uscite che il mercato offre davvero; la valvola 110-120¢ la usa il **2,7%** e nessuno
dei due gruppi misurati ci arriva. `MERGE_MIN_MARGIN_CENTS` è **derivato** (`100 − 101 = −1`), non
ricopiato; `MAKER_TETTO_COPPIA_CENTS` resta un env con clamp `[100 · 200]`. Il valore si asserisce in
**un punto solo**; gli altri test lo **derivano**. ⚠ Costo massimo dell'1¢ in più sulla posizione più
grande del piano di prova (62,5 share): **$0,63**.

> **💰 LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — §5-bis p.169, 17 agosto 2026.**
> `lib/maker/presa-di-profitto.js` (puro), chiamata da `decideClose` **dopo** le guardie su mercato
> chiuso e **prima** di `already-covered`. **La misura**: sui due fill del 16 agosto, **283 campioni
> di book su 354 minuti, ZERO istanti offrivano un'uscita realizzabile in guadagno** — sotto
> l'ipotesi più generosa (tutta la size al miglior prezzo). Il guadagno visto sul pannello era la
> **differenza fra il mid e il bid**; il tape conferma che il prezzo è sceso *attraverso* il nostro
> bid (0,23 → 0,22 → 0,21 prima del fill a 0,20, 0,17 dopo).
> **⚠ UN TAKE-PROFIT ESISTEVA GIÀ E NON HA MAI INCASSATO NIENTE**: il ramo `marketAhead` di
> `planExit` (3 agosto, con cricchetto) è ancorato a `scoringMid` e mette l'uscita a `mid × 1,01`,
> cioè sopra un mid che la misura dichiara non consumabile. Il buco non era «manca la regola».
> **Il criterio non ha costanti arbitrarie**: incassare al bid batte completare la coppia esattamente
> quando `bid + ask > 1`. Due rami — **`coppia-battuta`** (la coppia è disponibile: si scatta se
> `bid + ask > 1 + m`) e **`coppia-bloccata`** (la coppia sfonda il tetto di 101¢: si scatta se
> `bid > carico + m`, perché l'unica alternativa è la scala d'urgenza, che sa solo scendere).
> `MARGINE_CENTS = 1`, **centesimi per share e non tick** (§5-bis p.164), copre col doppio del
> margine il caso peggiore modellato dei premi persi (~0,5¢/share sui 28,6 min mediani).
> **SI ATTRAVERSA, NON SI INSEGUE**: il prezzo è il bid camminato — restare sopra il bid ricrea il
> difetto. **TUTTA LA SIZE O NIENTE**: una copertura parziale non vende una parte, perché un residuo
> sotto il minimo è capitale senza via d'uscita (§5.2 p.1). `TETTO_COPPIA_CENTS` **importato**.
> **⚠ Fail-closed**: ask illeggibile, scala che non copre la size, carico illeggibile ⇒ non scatta.
> **⚠ Il ramo `close-at-market` NON chiama più `provaCoppia` quando il trigger è la presa di
> profitto** — sarebbe la strada appena misurata come peggiore, con un confronto più debole — e
> l'obbligo di esito viene scaricato a mano, o `flushObblighi` segnalerebbe un difetto inesistente.
> Test: `presa-di-profitto-scatta.test.js`, 33 asserzioni **sullo SCATTO**, attraverso il
> `decideClose` vero, con la prova di **disgiunzione** dalla scala d'urgenza su 241 scatti.

**⚠ E LA SCALA DEVE ARRIVARE AL PREZZO, non al permesso** (§5-bis p.138, corretto il 16 agosto 2026 con
la misura: **una sola occorrenza di `urgenzaLivello` in cinque ore** su una posizione aperta). Due cause,
entrambe corrette: ① il ramo **`already-covered`** di `decideClose` **ritornava prima di ricalcolare il
prezzo** — l'uscita si piazzava una volta, al gradino di quel momento, e non scendeva mai più; ② **
`planExit` produce un PAVIMENTO, non un prezzo**: al gradino 2 concedeva 19¢ e l'uscita restava a 20¢
sopra un book 16/18. Adesso `already-covered` ricalcola e, dal gradino 1 in su, l'uscita **insegue il
miglior ask** fermandosi al pavimento — la scala dice quanto si può perdere, il book dove si viene presi,
**vince il più stretto**. Riduce e basta (solo se il prezzo nuovo è più basso di un tick).

**La resa dopo 60 minuti** (`urgenza-scoperto.js`): gradino 1 a **30 min** (uscita fino al carico),
gradino 2 a **60 min** ⇒ chiusura **peggiorativa**, gradino 3 a 240 min ⇒ anomalia grave.
**⚠ LA CONCESSIONE È IL 5% DEL CARICO, E BASTA** (R7, 18 agosto 2026, decisione dell'operatore). Era
`max(daTick, daFrazione)`, cioè il **più stretto** fra un tick e il 5%: su un token da 50¢ con tick 1¢
un tick è il 2%, quindi il 5% non veniva mai raggiunto e il gradino 2 concedeva **meno della metà** di
quello che la regola dichiara. **⚠ ALLARGA UN LIMITE DI RISCHIO**: caso peggiore **$3,06** (5% della
gamba più grande apribile, $61,25) contro $0,63 di un tick su 62,5 share.
**⚠ `concessioneTick` è ora il CANCELLO, non la quantità**: dice se il gradino 2 è stato raggiunto, e
`Infinity` resta fail-closed. **⚠ Sui token economici non cambia niente**: a 9,5¢ il 5% resta più
stretto di un tick e sulla griglia la concessione si azzera — la gamba resta in attesa invece di essere
svenduta, ed è il comportamento prudente.

**La regola generale del lato scoperto** vale da **qualunque causa** (fill, residuo di merge parziale,
chiusura rapida incompleta) e converge in **un punto solo** — l'esito `rinuncia` di `completaCoppia`.
Sotto il minimo del venue la quantità si **accumula** in `data/residui-scoperti.json` per mercato/lato:
**ultima osservazione + storia, MAI somma aritmetica** — la size che arriva è `sizePosseduta`, cioè la
posizione al venue, **già cumulativa**: sommare tre fill darebbe 120 invece di 65. *(Il registro della
**sorella** somma invece, ed è giusto: lì ogni voce è un ordine NOSTRO, cioè un incremento vero. Le due
regole sono opposte perché le due fonti lo sono.)* **Il minimo è del venue e per MERCATO** (20/50/100/200),
non una costante nostra.

**Chiusura forzata a 3 ore** dalla risoluzione: il verdetto si calcola **prima** della guardia sui
livelli (il livello 3 è l'esito più comune) e l'esecuzione resta **dopo** le cancellazioni. La scadenza
si legge da **board ∪ catalogo di ripiego ∪ venue** (§5 p.122). Una coppia **completa** non si forza:
alla risoluzione vale $1 comunque.

**Le chiusure sono esenti dal tetto per ordine**, e l'esenzione è una **prova rifatta sull'ordine
esatto** contro lo snapshot posizioni: SELL ≤ share possedute, BUY ≤ `manca`. Un BUY così può solo
**appaiare** — nel caso limite porta i due lati in parti uguali, cioè esposizione direzionale **zero**.
Qualunque lettura mancante lascia il tetto applicato, e **il tetto di safety non è mai esentato**.
**Una sola aritmetica per due cinture** (`prova-riduzione.js`, importato dal GATE 4 e dall'adapter):
ricopiarla sarebbe il reperto D1, e qui una divergenza allargherebbe un limite di rischio.

**I percorsi taker non mirano ai propri ordini**: passano da `othersLadder`, la stessa funzione di «mai
primo sul libro». La self-trade prevention del CLOB non è documentata, quindi non ci si conta.

**Gamba orfana**: al rinnovo GTD si chiede «la posizione che giustificava quest'ordine esiste ancora?».
Una gamba sola + zero posizioni ⇒ si **cancella** invece di rinnovare, e il mercato torna da
ripianificare. **Conferma in due osservazioni** (60 s): la prima **arma soltanto**, così la corsa del
fill non può produrre una cancellazione sbagliata. Il discriminante è l'**asimmetria**, non lo zero:
zero posizioni + **due** gambe è lo stato SANO di una coppia appena piazzata.

**Riprezzo atomico**: `replaceManualOrder` (cancella→ripiazza) ha **cinque** precontrolli prima
della cancellazione — kill, orologio del mercato, guard condiviso sul prezzo, **tetto per ordine**,
**chiave di idempotenza** — tutti con `oldCancelled:false`, così si lascia l'ordine dov'è e il ciclo
dopo riprova. **Nessuna costante nuova**: tetto e chiave vengono dalle stesse funzioni del GATE 4 del
piazzamento. I tre percorsi di cancellazione **voluta** (mai-primo, mid stantio, fine vita) non passano
di qui e sono intatti.

**Piazzamento di coppia atomico in PRECONTROLLO**: si valutano **entrambe** le gambe con
`evaluateManualCapGate` — la stessa funzione che poi rifiuterebbe, e lo stesso `caps` — prima di
inviarne una. Una fuori ⇒ **zero invii**, `gate: coppia-non-atomica`. **Si precontrolla ciò che si può
sapere prima, si ripristina ciò che si scopre dopo**: banda, mai-primo e minimo premiante dipendono dal
libro all'istante del piazzamento, e leggerlo qui vorrebbe dire due letture che possono divergere.
Le **chiusure sono esenti per costruzione**: il precontrollo vive dentro `if (accoppiato)` e una riga di
uscita è un gruppo di una.

### 4.7 · Scoperta e feed

**agent24** ogni **15 minuti esatti**: dorme il *resto* del periodo (`SCAN_INTERVAL_MS − durata`, con un
pavimento di 60 s) e **cronometra** la fase di profondità, dichiarando a ogni scansione il tetto che
starebbe nel periodo a quel ritmo. `REWARD_MAX_CLOB_MARKETS = 150` — **è già il massimo**: 2,74-3,91
s/mercato misurati, e il vincolo è `tempo_scansione < periodo`; al ritmo peggiore il valore corretto
sarebbe più **basso**. `ETA_BOARD_MAX_MS = 25 min` sta sopra il periodo ma sotto il doppio, così una
scansione saltata per intero resta visibile.

**⚠ Il costo di una scansione si stima sugli elementi che PROCESSA, non su quelli che sopravvivono ai
filtri a valle**: fra i due numeri c'era un fattore **3,5** e bastò a fermare il capitale (§5 p.53).
E quando un numero governa una finestra temporale si tara su un **cronometro**, non su un'aritmetica.

**La scadenza ha una fonte sola: il venue**, col board come riscontro. Il CLOB **tronca a mezzanotte
UTC**, quindi è per costruzione mai più tardi di Gamma — la più prudente, e il registro di chi smette
davvero di accettare ordini. Divergenza > 24 h, o Gamma prima del CLOB > 1 h ⇒ mercato **escluso a
monte** (`scadenza-discorde`); una lettura **mancante** invece non esclude — le due direzioni di
fallimento sono opposte apposta. **Quando il troncamento è DIMOSTRABILE**
(`troncaAMezzanotteUTC(gamma) === clob`) si usa l'ora vera di Gamma
(`gamma-ora-vera-su-clob-troncato`): è una **prova**, non tre indizi, e distingue da sola il caso delle
24 h esatte, che nessuna clausola scritta a mano coglierebbe.

**Il feed di agent34 non è più un anello chiuso** (§5 p.119): `allocator` scarta i mercati a profondità
`non-verificata`, e la verifica accetta **solo** campioni websocket — ma il websocket sottoscriveva
`collector-priority.json`, che agent41 scriveva **dal proprio piano**. Adesso il feed si semina anche
con i **CANDIDATI** (minSize compatibile col tetto *di adesso*, letto dal capitale vero, + orizzonte
≥ 18 h) e con i mercati con **posizione aperta**. Tetto della corsia **60**. Ordine di sacrificio:
righe del piano → quasi-vincitori → trattenuti → **candidati per primi** (un candidato è un'ipotesi, una
riga del piano è capitale deciso). Board illeggibile ⇒ zero candidati.

### 4.8 · La regola di copertura, applicata in SEI punti

«**Board ∪ mercati dove il capitale è già esposto**, mai solo il board.» **Una** definizione
(`auto-reprice-config.liveMinMarketIds`), sei consumatori: gate live-min · sottoscrizione del book ·
composizione del board (`rewards-normalize`) · lista dell'uscita automatica · scope del rinnovo ·
catalogo di ripiego. **Non allarga il perimetro di rischio**: aggiunge solo mercati dove il capitale è
**già** dentro — non apre un mercato nuovo, apre la *gestione* di una posizione che esiste.
Fail-closed ovunque, e subordinata all'interruttore generale.

> **🔒 LA METÀ SCOPERTA È STATA CHIUSA — 18 agosto 2026, `0f3ba6e` + `a0f5e0f`.**
> Qui c'era scritto che l'unione è `abilitati ∪ posizioni` e che la metà «ordine a riposo» restava
> scoperta, «coperta indirettamente» dal fatto che un ordine su un mercato disabilitato muore per GTD
> entro 23 minuti. Era vero, ed **era accettabile solo in dry-run**: il 18 agosto, col bot armato, il
> mercato `0x1f1c6390` è uscito dal board dieci minuti dopo aver ricevuto due ordini veri ($56,36), la
> selezione l'ha rilasciato, e alle 16:55:08 la GTD è scaduta **senza che nessuno rinnovasse**. Bot
> armato e fuori dal libro per 52 minuti. Costo $0 solo perché a 35 tick non si era riempito niente.
> **L'unione è ora `abilitati ∪ posizioni ∪ mercati con ORDINI A RIPOSO`**, terza componente da
> `lib/safety/venue-orders-snapshot.js` (`enabledDaOrdini`), e la stessa componente entra nello
> `scopeRinnovo` di `auto-reprice`.
> **⚠ QUESTO SNAPSHOT FONDE PER MERCATO, NON SI SOVRASCRIVE**, ed è lì che sta la correzione: le
> posizioni arrivano da una chiamata che elenca tutto, quindi «assente» è una **prova**; gli ordini si
> leggono **un mercato per volta e solo per i mercati in scope**, quindi «assente da questo giro» quasi
> sempre significa «non ho guardato». Lo scrittore riceve `guardati` **e** `conOrdini`: non guardato ⇒
> la voce resta, guardato e vuoto ⇒ la voce esce.
> **⚠ E LA DIFESA CHE ESISTEVA ERA UNA CORSA**: `auto-reprice` aveva già `deps.mercatiConOrdiniVivi`,
> iniettata da agent40 — ma quella memoria si sovrascrive intera a ogni giro e si popola solo dopo
> quattro cancelli, e **`cadenza-adattiva` fa `continue` prima del conteggio**. Un giro saltato per
> cadenza cancellava il mercato; senza memoria non tornava nello scope, quindi non veniva più guardato,
> quindi non tornava mai in memoria.
> **⚠ LA VALVOLA PER-VOCE È UN BACKSTOP A 6 ORE, NON UN MECCANISMO**: la via d'uscita normale è
> l'osservazione. La prima stesura la metteva a 30 minuti «perché sopra la GTD» e **riproduceva il
> guasto con un'ora di ritardo** — l'ha trovata il replay della serata, non il test, perché
> l'asserzione (`> GTD`) era vera anche col valore sbagliato.

> **⚲ IL PERNO `MAKER_LIVE_MIN_MARKET` RESTRINGE, NON AGGIUNGE — 17 agosto 2026, decisione dell'operatore.**
> `perno impostato ⇒ il perimetro live-min È il perno, e nient'altro`; perno assente ⇒ è la lista
> dell'operatore, come prima. **Perché**: «un mercato solo» non era esprimibile — il gate riceve
> `liveMinMarketIds`, cioè l'unione qui sopra, e **l'unione non si può svuotare finché una posizione
> esiste**. Misurato: svuotando la allowlist il perimetro restava **2**, non 1 né 0.
> **⚠ È MONOTONO PER COSTRUZIONE** (`{perno} ⊆ {perno} ∪ lista`): non esiste configurazione in cui
> faccia passare un ordine che prima passava. Provato **esaustivamente su 80 combinazioni**.
> **⚠ CIÒ CHE SOSPENDE, e va saputo prima di armare**: con un perno attivo un mercato con posizione
> **non riceve più il BUY di completamento coppia** — cioè §5 p.62 vale solo per il perno. Può ancora
> essere **USCITO**: l'eccezione di riduzione è valutata *prima* dei rifiuti e passa dal token, non dal
> mercato. Chi vuole quel BUY toglie il perno; non c'è una terza via.
> **⚠ UNA SOLA ARITMETICA**: `adapter.perimetroLiveMin`, importata dal gate, dal pannello
> (`manual-order`) e da `scripts/cli/mercati.js`. Erano **tre copie** e divergevano già: il pannello
> contava il piano mentre mostrava l'unione, e la CLI stampava gli abilitati — cioè un perimetro **più
> stretto di quello vero**, sbagliando nella direzione che rassicura.
> **⚠ IL PERNO VIVE NEL PROCESSO**: `node scripts/cli/mercati.js` risponde a «quanti mercati il codice
> può toccare» leggendolo da `/proc/<pid>/environ`, non dal `.env`, e dichiara la divergenza fra i due
> processi che decidono un prezzo. Cambiarlo richiede il riavvio **dal file** e **insieme** (§5.1).

**⚠ E due filtri con lo STESSO predicato in fila sono una trappola** (§5 p.55): la soppressione per
profondità viveva in agent24 *e* in `buildCombined`, e l'eccezione «un mercato con capitale dentro non
sparisce» era scritta solo sulla seconda — la riga non arrivava mai fin lì. **Quando si esenta qualcosa
da un filtro, la domanda non è «l'eccezione è scritta?» ma «la riga arriva fin qui?».**
`punti-di-filtro.test.js` tiene la tabella dei sedici punti di filtro sui mercati.

### 4.9 · Merge on-chain e relayer

`CTF_RELAYER_ENABLED = **true**` (costante di sorgente, **non** una env: due interruttori per una
decisione sola significano che spegnerne uno non la spegne). **Solo `mergePosition` ha un chiamante**:
`auto-close.fondiCoppia`, raggiunta quando `decidiLivello` risponde `azione:'merge'` (`mancaAllaCoppia
<= 0`). `splitPosition` e `redeemPosition` restano **esportate e mai invocate**.

Il confine non si allarga: `verificaConfinamento()` ri-decodifica il batch prima della firma e rifiuta
qualunque target che non sia uno dei due adapter CTF. Il firmatario è **lo stesso wallet** della corsia
manuale (`live-providers.makerSignerProvider`), e il controllo di coerenza chiave↔credenziali vive **in
un punto solo**, dentro il relayer. Fail-closed: `negRisk` non booleano, size non finita, flag spento o
qualunque eccezione ⇒ **non è successo niente**, e si prosegue col comportamento di prima.

**Perché lo split non conviene MAI in questa strategia** (§5 p.48): lo split rende 1 YES + 1 NO per
**$1,00** esatti; comprare le due gambe in banda costa **0,93-0,999** (mediana 0,97 su 37 coppie reali,
`pairCostUsd` 0,98 sul piano) — e quel 3% di sconto **è** il margine, perché il bot posa le gambe un
tick dietro il tocco su ciascun lato e la coppia costa `1 − 2·offset` **per costruzione**. E soprattutto
**lo split non mette niente sul libro**: due token fermi non maturano nulla, cioè non costa 3¢ in più,
**rinuncia all'intero ricavo**. L'ipotesi «conviene quando il book non offre la coppia a sconto» non si
verifica: se la coppia costasse ≥ $1 il bot **non aprirebbe** quella posizione — lo sconto *è* la
condizione d'ingresso, e perfino il Livello 1 ha un tetto a 99¢.

**Nessun confronto di convenienza fra merge e vendita**, ed è stato scritto e buttato: il merge rende
$1/coppia **subito**, senza slippage e senza gas; la vendita rende `bid × size` su **un lato solo**,
lascia l'altro in portafoglio (quindi non chiude la posizione, la rende direzionale) e attraversa lo
spread. Un confronto con un termine sempre maggiore può solo sbagliare. **Coppia completa ⇒ merge.**

Trappola operativa: il relayer rifiuta le deadline corte (`400 deadline too soon`) — `DEADLINE_SEC = 900`.

### 4.10 · Registri, giornali, persistenza

`data/polymarket-maker-audit.jsonl` cresce di **67-82 MB/giorno** e **ruota sopra i 400 MB**,
portandosi nel file nuovo gli ultimi **64 MB** allineati a un a capo (~20 h): senza passato recente
`origine-ordine` dichiarerebbe ogni ordine «ignoto» e il reset si piazzerebbe **sopra i propri ordini**.
Ordine: lucchetto → ri-`stat` → `rename` → append della coda; fra rename e append una riga può finire
fuori ordine, **mai persa**. **Gli archivi non si cancellano, non si potano, non scadono.**
⚠ La rotazione **non si innesca sotto un `*.test.js`** (guardia su `argv[1]`): `appendMakerAudit` scrive
sempre sul file vero, e una rotazione innescata da un test è un'azione di produzione che nessuno ha chiesto.

I giornali si leggono in modo **incrementale** (`giornale-incrementale.js`): `readFileSync(…,'utf8')`
costruisce UNA stringa e V8 si ferma a ~512 MB, e a 731 MB i lettori fallivano **chiuso**. Rileva la
rotazione da **inode + dimensione + testa** (un file riscritto in place passerebbe i primi due) e
consegna anche l'ultima riga senza `\n` — cioè il record **più recente** — senza consumarla.

**Persistono su disco** (provato con `kill -9` su nove processi): attese di merge · modalità chiusura
col bersaglio della sorella · residui scoperti e sotto soglia · tetti · gestione manuale · allowlist ·
catalogo di ripiego · idempotenza · confronto reward · baseline e latch del guardiano · piano
dell'allocatore · `da-ripianificare.json`. **Nessun buco strutturale.** In memoria e perso *senza costo*:
contatori di conferma del riprezzo, insiemi anti-ripetizione dei log, cache posizioni 5 s, registro orfani.

**Origine di un ordine**: campo `origine` **accanto** a `source` (`source` dice quale corsia piazza,
`origine` dice se dietro c'era una persona). Il reset di agent41 cancella **solo** ciò che è
provatamente `auto`; manuale e **ignoto** restano sul libro. Terza origine **`auto-chiusura`**, che il
reset non tocca **per decisione**: si spazzano gli ordini automatici *di piano*, non chi sta chiudendo
una posizione. Le costanti sono **importate**, non ricopiate — era una stringa ricopiata a produrre il
difetto delle 4.686 righe etichettate male.

**Idempotenza**: chiave deterministica sull'identità economica
(`sha256(userId|venue|tokenId|side|price|size)`), **nessuna componente temporale**. Un piazzamento che
supera un ordine **morto** riceve una chiave derivata dall'id di quello che supera; la **catena** di
sostituzioni arriva a **20.000** anelli (~due settimane, ~80 ms a percorrerla). **La protezione
anti-doppio-invio non è il tetto**: è la verifica che l'ordine precedente sia morto sul venue, e vale a
**ogni singolo anello**.

**La riconciliazione dei fill confronta grandezze OMOGENEE**: il volume del venue per **token+lato**
contro quanto è già registrato per **token+lato** su tutte le chiavi (e per **id-ordine-venue** nel ramo
`size_matched`), mai contro una singola `idempotencyKey`. Altrimenti ogni ripiazzamento — uno ogni ~60 s
sulla stessa gamba — ritrova lo stesso volume e lo registra **intero** come fill proprio: §5 p.72,
2.790 share fantasma contro **zero** al venue, bot bloccato dal tetto $600 per un errore di somma.

**Il ledger si netta contro il venue**: uno snapshot `readable` che non elenca un token è **prova** che
quella posizione è chiusa (oltre `MAX_AGE_MS` `readable` è già `false`, quindi `true` significa già
«lettura fresca», e su questo venue la risposta è l'elenco completo). Assente, vecchio o illeggibile ⇒
**non si netta niente**. **Nessuna riga viene cancellata**: il ledger resta append-only e la posizione
resta marcata `chiusaAlVenue` con la sua `esposizionePrimaUsd`.

**`skipped` non sparisce dal referto**: non entra né in `placed` né in `refused`, quindi «0 piazzati, 0
rifiutati» descriveva un **blocco totale** con la stessa riga con cui descriverebbe l'inazione. Il
referto porta `saltati` e `motiviSaltati`.

### 4.11 · Backoff, rate limit, resilienza

429 ≠ 5xx: il 429 parte da 1 s e raddoppia (1→2→4), e **`Retry-After` vince** su qualunque progressione
(secondi o data HTTP, max 30 s). Dopo un esito **ambiguo** — la POST era partita — non si ritenta alla
cieca: si interroga il venue, e se l'ordine c'è l'esito è **riuscito**; una verifica che non riesce vale
«non ritentare», perché fra due ordini e zero ordini il secondo errore costa meno.

`/positions` ha **5 tentativi, 1 s → 30 s, con jitter ±25%**: senza jitter ogni lettore riparte dallo
stesso istante dopo lo stesso 429 ed è il modo di trasformare un rate-limit in un rate-limit permanente.
Un 200 con un corpo che non è una lista **non si ritenta**. **⚠ La soglia dei 180 s sullo snapshot NON è
toccata**: è la protezione che impedisce di piazzare su una fotografia vecchia delle posizioni; il
rifiuto arriva dopo i tentativi invece che al primo singhiozzo.

I **sei piazzamenti di chiusura** riprovano fino a **3 volte** (`piazzaChiudendo`), ma **solo** se a
rifiutare è il venue — un `gate` nostro non cambia fra un tentativo e l'altro, e ritentarlo sarebbe
martellare il proprio codice — e **mai su un esito ambiguo**. Il KILL si rilegge **prima di ogni
ritentativo**, non solo a inizio ciclo. **La quotazione ordinaria non riprova**: un ordine di liquidità
può aspettare il ciclo dopo, una posizione scoperta no.

**pm2**: `min_uptime: 30 s` + `max_restarts: 500` su tutti i processi critici, in **un punto solo** del
config (`RIAVVIO_ROBUSTO` + `PROCESSI_CRITICI`). `restart_delay` resta **per-agente** (6 valori
distinti: appiattirli sarebbe una regressione travestita da uniformità). ⚠ La politica diventa effettiva
solo con `pm2 restart agents/ecosystem.config.js --only <nome>`: pm2 tiene la propria copia in memoria.

### 4.12 · Stima e consuntivo

**La stima è una QUANTITÀ, non un tasso fotografato**: `Σ(tasso × durata)`, campionata ogni **5 minuti**
da agent40 con **orologio e lucchetto propri** (un confronto lento non deve far saltare campioni).
Tre regole: un campione vale al più **due passi**, uno scoperto **sottostima e lo dichiara**
(`coperturaFrazione`), un tasso non finito **non si registra**. Ricalcolo a ritroso: **+466% → +118%**.

**Il consuntivo è per GIORNO, non per mercato**: sulle righe REWARD `conditionId`, `title` e `slug` sono
vuoti (il venue paga un bonifico aggregato), e il totale **non viene diviso in proporzione** — sarebbe
un numero inventato con l'aspetto di una misura. Fonte: registro attività **pubblico** keyed sul
**funder** — le credenziali L2 sono dell'EOA, quindi era un problema di **identità**, non di endpoint.
Recupero **a ritroso** fino a 30 giorni, perché i tre tentativi notturni cadono prima che il pagamento
arrivi. Registro visibile su `GET /api/maker/registro-reward` e nella scheda «alloca».

### 4.13 · La selezione automatica dei mercati — `lib/maker/selezione-mercati.js` (15 agosto 2026)

Fino a qui la lista dei mercati quotabili si riempiva **a mano** (`scripts/cli/mercati.js aggiungi`).
Adesso la riempie il bot, dentro i vincoli dell'operatore. **La decisione è PURA** (zero `require`, un
test lo asserisce); il cablaggio sta in `agent41` e passa dalle **stesse** funzioni di prima —
`preparaMercatoNuovo` per chi entra, `rilasciaDallaSelezione` → `setAutoReprice` per chi esce.

| | |
|---|---|
| **vincoli** | `rewardsMinSize ≤ 50` · **scadenza ≥ 24 h** e **≤ `MAX_HORIZON_DAYS`** · **niente famiglia meteo** · **max N ATTIVI dove N = `MAKER_MERCATI_CONTEMPORANEI`** (R1, 18/08: ambiente di agent41, un posto solo, letto da `/proc`; difetto 3, **soffitto 5 dal 18/08 sera**) · **book UTILIZZABILE** (18/08 sera: `needsResnapshot === false` e un book esiste — v. il riquadro qui sotto) · **composizione DERIVATA da N** (`quotaScaglioni`): N≥2 ⇒ 1 «basso» (≤20) + (N−1) «alto» (≤50); N=1 ⇒ un secchio solo, che ammette tutto — con la regola stretta un unico slot potrebbe ospitare solo un minSize ≤ 20 e restare vuoto. ⚠ **168 → 24 h**: fra 48 e 168 h il board è VUOTO (168/96/48 danno piano identico e vuoto, 24 h sblocca 27 ammissibili). ⚠ **Il vincolo delle 3 CATEGORIE è stato TOLTO**: 23 dei 26 ammissibili sono `elections`, quindi la diversificazione teneva due slot sui mercati **peggiori** — netto −$0,111/g e +$0,026/g contro +$10,64/g escluso |
| **interruttore** | `data/selezione-mercati.json`, `scripts/cli/selezione.js {stato\|prova\|accendi\|spegni}`. Difetto **SPENTA**; file illeggibile ⇒ **spenta**. **ACCESA dal 15/08** |
| **quando gira** | a ogni ciclo 6 h **e** a ogni controllo del capitale fermo (120 s), **prima** del piano — e prima di `decidiTrigger`, così un mercato che scade esce anche nei giri in cui il trigger non scatta |
| **classifica** | `levels[<capitale minimo>].grossRewardDay`, cioè la stima che **il board ha già calcolato** con la formula del venue → ripiego `rateOrdinamento` → `rewardsDailyRate`. **Non** il montepremi (§5 p.132). Pareggio rotto sul `conditionId`: due giri sullo stesso board danno la stessa risposta |
| **il piano si restringe** | `restringiAllaSelezione` in `calcolaPianoFuoriProcesso`, cioè il punto per cui **entrambi** i percorsi (6 h e mini-ciclo) sono coperti da una regola sola. **Interseca, non sostituisce**; intersezione vuota ⇒ vincolo **impossibile**, mai vincolo **assente** |

> **📖 IL BOOK DEV'ESSERE UTILIZZABILE — 18 agosto 2026 sera, e la prima stesura era SBAGLIATA.**
> Il cancello chiede «il book memorizzato è utilizzabile?», **non** «ha avuto eventi di recente».
> Escluso solo chi ha **`needsResnapshot === true`** o non ha proprio un book (assente dalla mappa, o
> senza tocco). **Nessuna soglia di età, di nessun tipo.**
> **⚠ LA PRIMA STESURA ESCLUDEVA `live !== true`, E BUTTAVA FUORI I MERCATI TRANQUILLI.** `live` in
> agent34 significa «è arrivato un evento su QUEL asset negli ultimi 30 s» (`live-book.freshness`),
> non «siamo abbonati»: su un libro fermo l'età cresce **mentre il quadro memorizzato resta perfetto**
> — misurato il 5 agosto, al picco di 35 s il book coincideva **esattamente** con la lettura REST. E i
> mercati tranquilli sono quelli che un maker di rewards vuole: senza selezione avversa gli ordini
> restano a libro e maturano. Misurato: **19% degli asset è silenzioso in un istante qualunque**, e il
> mercato che sembrava «caduto» è tornato `live` da solo al primo evento. Col criterio vecchio erano
> esclusi **14 book su 125**; col nuovo **1**.
> **⚠ LA DOMANDA «SIAMO CIECHI?» NON APPARTIENE ALLA SELEZIONE**: la risolve `mid-stantio` (§4.1),
> che decide se TOGLIERE un ordine già a libro. Due soglie sullo stesso fatto sarebbero due opinioni.
> **⚠ E UNO SLOT VUOTO PER SCARSITÀ SI DICHIARA** (`slotVuotiPerScarsita`, più `postiNonAssegnati` e
> `scartatiPerComposizione`, che erano calcolati e **mai copiati nel giornale**): il record ora dice
> «il board non offre abbastanza mercati ammissibili: N su 142 valutati». Il 18 agosto sera gli
> ammissibili oscillavano fra **4 e 7 su ~142**, cioè intorno al numero di posti: uno slot vuoto è
> spesso povertà del board, non un difetto, e le due cose devono restare distinguibili.

> **🧊 «SLOT STERILE» — LA REGOLA C'È MA È DISARMATA** (`SLOT_STERILE_ARMATO=0`, 18 agosto 2026).
> Libera uno slot che per **due osservazioni consecutive** non produce ordini, perché un altro mercato
> ci provi. **⚠ È STATA DISARMATA LA SERA STESSA IN CUI È NATA**: presumeva che la causa stesse nel
> MERCATO, mentre quella sera stava nel FEED — e ha buttato fuori **cinque volte** un mercato che
> andava benissimo (`0x17dfedcac2`, 20:49:54 · 20:55:54 · 21:03:24 · 21:05:24 · 21:06:40).
> **⚠ LA CORREZIONE C'È E NON È MAI GIRATA ARMATA**: «nessun ordine a libro» ha **due cause opposte** —
> *sterile* (non ci abbiamo mai messo capitale, o non ce lo possiamo mettere) e *svuotato da noi* (il
> repricer ha cancellato per mid stantio, l'erosione ha sospeso). Un'osservazione non conta come
> sterile se in quel mercato ci sono state **cancellazioni nostre** nella finestra, e il contatore si
> **azzera a ogni piazzamento riuscito**. Margine e cooldown non sono stati aggiunti al posto di
> questo: rallenterebbero la regola senza correggerla.
> **⚠ DISARMATA NON VUOL DIRE ASSENTE**: continua a misurare e a scrivere cosa *avrebbe* fatto.
> **PER RIARMARLA**: si cancella `SLOT_STERILE_ARMATO` da `ecosystem.config.js` e si riavvia agent41
> dal file. Assente ⇒ **ARMATA**, come `SBLOCCO_GRADINO6_ARMATO`.

> **🔄 LA ROTAZIONE ROVESCIA LA REGOLA DELLO SLOT — decisione dell'operatore, 16 agosto 2026.**
> Un mercato che riceve un fill — **totale o parziale** — **esce dal conteggio dei 3 attivi** e **resta in
> gestione** fino a coppia chiusa o mollata; contemporaneamente ne entra uno nuovo, al pavimento premiante,
> rispettando composizione e scaglioni. Lo stato porta `inGestione` + `inGestioneDal`; ingressi e rilasci
> sono due liste nel giornale (`entratiInGestione`, `liberati`). *(Qui c'era scritto il contrario, e la
> ragione di allora era buona: il tetto è sull'esposizione, e l'esposizione finisce con la posizione.)*
> **⚠ LA CONSEGUENZA VA DETTA PER INTERO: L'ESPOSIZIONE TOTALE NON È PIÙ LIMITATA A TRE MERCATI.** Tre
> quotano mentre N completano. Ciò che la limita ora è, in ordine: il **tetto per mercato** ($61,25), il cap
> cumulativo di esposizione aperta (**$150**) e il **kill a $100** di perdita giornaliera. Chi rialza uno di
> quei tre alza il rischio di questa regola, non di quella.
> **⚠ IL CASO PEGGIORE ACCETTATO DALL'OPERATORE È ~$294** (16 agosto, in chat): 3 attivi a $147 di ordini a
> riposo più una rotazione piena. **Non era il caso peggiore vero**: `inGestione` non ha tetto, e
> `maxOpenNotionalUsd` conta i **fill riconciliati** e **ignora i $147 a riposo** ⇒ il soffitto era
> `$600 + $147 ≈ $747`. Per questo il cap è sceso a **$150**: `$147 + $150 ≈ $297`, la cifra chiesta.
> **⚠ MA IL TETTO SI APPLICA ANCHE AGLI ORDINI DI APERTURA, CHE POI NON CI ENTRANO**: il gate confronta
> `openNotionalUsd + notional`, quindi con quel cap la gamba più cara del piano ($54,38) smetteva di
> essere piazzabile quando i fill riconciliati superavano ~$95 — **la rotazione si fermava da sola lì,
> non a $150**. È l'osservazione che poi ha portato al cap di $650 e all'invariante di §5.2 p.37.
> **⚠ IL CAP È $650 DAL 18 AGOSTO, E L'INVARIANTE CHE LO GIUDICA È CAMBIATA IL 19** (§5.2 p.37, chiusa):
> non `cap ≤ N × tetto per mercato` ma **`cap ≥ esposizione massima raggiungibile`**, cioè N coppie a
> riposo **più il loro completamento** ($612,50 a N=5). I tre test avevano ragione sulla relazione e
> torto sulla grandezza; il $150 di questo riquadro è storia.
> **⚠ UN MERCATO IN GESTIONE DEVE RESTARE ABILITATO AL RIPREZZO**: `restringiAllaSelezione` usa `idsAttivi`
> (solo i non-in-gestione) per il **piano**, ma la lista del riprezzo tiene **tutti** gli id. Toglierlo
> farebbe morire la gamba sorella per GTD in ≤ 23 min, cioè **prima** dei 30 che la scala le concede.
> **⚠ USCIRE DALLA LISTA SPEGNE L'INGRESSO, NON L'USCITA**: `rilasciaDallaSelezione` tocca `setAutoReprice`
> e **niente altro** — la posizione resta gestita da §4.8. Due test lo verificano per assenza.
> **⚠ FAIL-CLOSED NEI DUE VERSI**: board o posizioni illeggibili ⇒ nessuna decisione e **nessuno esce**; ma
> una **singola** scadenza non determinabile **esclude quel mercato**, come in §4.4.
> **⚠ NON ACCENDE NIENTE**: servono ancora, indipendentemente, l'interruttore del riprezzo, AVVIA, il KILL
> spento e `MANUAL_ORDER_PLACEMENT` (§4.14). Decide **su quali** mercati, mai **se**.
> **⚠ IL FILTRO METEO ADESSO TOGLIE RIGHE DAVVERO**: col vincolo a 168 h ne toglieva zero — le aveva già
> tolte la scadenza — e con 24 h ne toglie **17**. È il caso per cui una regola che vale «per conseguenza»
> va scritta esplicitamente: la conseguenza è cambiata, e la regola no.
> **⚠ La selezione ordina e spodesta col NETTO del knapsack** (iniettato), con **isteresi
> `max($0,50/g, 25%)`**: non spodesta chi ha ordini vivi o una gamba in attesa.
> **⚠ UNO SCAGLIONE VUOTO NON SI RIEMPIE COL VICINO**: se manca un candidato «basso» il posto resta **non
> assegnato e dichiarato** (`postiNonAssegnati`, `scartatiPerComposizione`) invece di essere preso da un
> «alto» — sostituire porterebbe il capitale da $147 a $183,75, cioè cambierebbe in silenzio la cifra che
> l'operatore ha deciso.

> **🔁 LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO — §5-bis p.171, 17 agosto 2026.**
> `copertura-gambe` decideva correttamente da giorni e `riconciliaCopertura` **dichiarava e basta**:
> in tutto il 16 agosto non ha rimesso a libro nemmeno una gamba. **Costo misurato**
> (`data/ricerca/gambe-16-agosto.md`): due gambe vive solo il **50,0 %** del tempo, **17 delle 22
> cadute lunghe mai tornate**. Nessun percorso le rimetteva — il trigger a capitale fermo apre
> MERCATI, agent40 riprezza ciò che esiste e su zero ordini non ha niente su cui iterare.
> **⚠ IL NUMERO CHE GOVERNA IL DISEGNO È 720**: il ciclo che ospita la decisione gira ogni **120 s**.
> Senza raffreddamento un mercato che rifiuta sempre verrebbe ritentato 720 volte al giorno — la
> forma esatta delle 799 ricostruzioni. `lib/maker/ripristino-gambe.js` (puro) è una scala sui
> fallimenti **consecutivi**: subito · 5 · 10 · 20 · **30 min di tetto**, azzerata quando il mercato
> torna `coperto`. Il primo tentativo è immediato perché la GTD è 23 min; il tetto sta **sopra** la
> GTD perché oltre quella soglia il problema non è più «manca la gamba» ma «questo mercato non si
> riesce a quotare», e la risposta è `da-sostituire`. **Contenimento provato con i numeri: 50
> tentativi su 720 cicli, fattore 14,4×** — è un'asserzione del test, non una frase in un commento.
> **⚠ Si azzera su `coperto` OSSERVATO, non su un invio accettato**: un ordine può essere accettato e
> cancellato subito dopo.
> **LE TRE COSE CHE NON FA, e sono le tre che hanno fatto danno il 16 agosto**: ① non è una seconda
> strada verso il venue — riga dal piano **già salvato** → `gambeDiUnaRiga` → `piazzaCoppia`, cioè lo
> stesso `runBulkAllocation` con lo stesso freno e gli stessi gate; ② **non ricostruisce il piano**:
> mercato assente dal piano ⇒ si dichiara e si passa oltre; ③ **non abilita niente** — itera
> `idsAttivi`, nessuna scrittura su allowlist, gestione manuale, uscita o catalogo.
> **E UNA CHE FA**: scrive **sempre** a verbale (`tipo: 'ripristino-gamba'`), anche quando non tenta.
> Il giornale del 16 agosto porta **zero** record di copertura, ed è il motivo per cui non si è
> potuto dire *quali* gambe fossero mancanti. Un presidio che non lascia traccia non è verificabile.
> **⚠ SI PIAZZA UNA GAMBA SOLA DI PROPOSITO, e non contraddice §4.6**: il precontrollo atomico esiste
> perché «meglio zero invii che una gamba orfana», ma qui l'altra gamba **è già a libro** — è la
> definizione di `da-coprire`. `runBulkAllocation` applica il precontrollo dentro `if (accoppiato)`, e
> un gruppo di una riga non è accoppiato: non lo si aggira, non lo si incontra.
> **⚠ Trappola per chi ci lavora**: `gambeDiUnaRiga` produce righe con `book`, **senza `tokenId`** (lo
> risolve `placeManualOrder` a valle), mentre `valutaCopertura` risponde in **token**. Le due metà
> parlano lingue diverse e serve una traduzione esplicita, fail-closed se i due token non si leggono.
> E `LOCK.stato()` restituisce **`id`**, non `conditionId`. Entrambi i difetti li ha presi il test
> dello **scatto**, non la rilettura.

> **⚖ E IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA — 17 agosto 2026 sera, decisione dell'operatore.**
> Il passo 13 del banco si fermava qui: `$28,00` a riposo (87,5 share) + `$39,17` di gamba nuova (62,2) =
> **$67,17 contro $61,25**. **La causa era l'ASIMMETRIA, non il tetto** — una coppia simmetrica costa per
> costruzione il capitale della riga e non lo può sfondare.
> **⚠ E LA DIAGNOSI SCRITTA QUI PRIMA ERA SBAGLIATA**: «il riprezzo ricalcola la size». **Non lo fa** —
> `auto-reprice` passa `size: order.size`, in undici punti. Il difetto era più generale: `gambeDiUnaRiga`
> calcola `Q = capitale/(p_yes+p_no)`, cioè simmetrica **nell'istante in cui costruisce**, e la gamba
> superstite porta la size dell'istante in cui *fu piazzata* — 87,5 e 62,2 sono la stessa formula a due
> istanti diversi (la coppia costava $0,675 allora, $0,95 adesso). **Nessuno riportava la viva a oggi.**
> **La cura** (`lib/maker/coppia-simmetrica.js`, puro, zero `require`): una size per **entrambe**,
> `Q = min(Q_piano, Q_tetto, Q_gamba_viva)`, e nessuno dei tre può far CRESCERE niente.
> **⚠ `Q_gamba_viva` LA RENDE MONOTONA**: la gamba viva si può solo rimpicciolire — far crescere un ordine a
> riposo per «pareggiare» sarebbe aggiungere esposizione per ragioni di simmetria, e la simmetria si
> ottiene anche scendendo. **⚠ `Q_tetto` usa i prezzi VERI di ciò che resterà a libro** (dell'ordine vivo
> per chi sopravvive, del piano per chi nasce): col prezzo di piano per entrambe si proporrebbe un totale
> che il gate poi rifiuterebbe. **⚠ Il tetto iniettato è `MARKET_CAP_FIXED_USD`, non `capPerMarketUsd`**:
> qui non si pianifica, si dimostra che il gate non rifiuterà — e il gate confronta la costante.
> **⚠ SOTTO IL MINIMO PREMIANTE NON SI RICOSTRUISCE, e il tetto NON si allarga**: è l'unico esito in cui il
> modulo dice «no» invece di «più piccolo». Il tetto che sarebbe servito è misurato ($83,13 per quella
> coppia, fino a **$641,36 = 10,47×** nel caso peggiore sul board) e resta a verbale come costo del *non*
> curare, non come proposta.
> **⚠ L'ORDINE DELLE DUE AZIONI È PARTE DELLA CURA**: `nozionale-mercato-oltre-tetto` somma il nozionale a
> riposo ⇒ **prima si riduce, poi si piazza**; e se la riduzione fallisce **non si piazza**, perché due
> gambe asimmetriche sono peggio di una sola (la seconda non è né premiante né chiudibile). Il lucchetto
> copre entrambe le azioni. **Il prezzo della gamba viva non si tocca**: si ricopia il suo, e
> `replaceManualOrder` rifà banda e «mai primo» rifiutando con `oldCancelled:false`.
> **⚠ LE DUE LETTURE DEVONO CONCORDARE**: `gambeDaMandare` parte da `v.mancanti`, `dimensionaCoppia` guarda
> gli ordini vivi; lati diversi ⇒ una delle due è vecchia ⇒ **nessuna azione**. E gli ordini vivi si
> **passano** (gli stessi su cui `valutaCopertura` ha giudicato), non si rileggono.
> A verbale finiscono `coppia` (size, vincolo, totale, i tre `Q`) e `ridotte`: senza, «rimessa» non dice a
> che size e la simmetria non è verificabile sul giornale.
> **Prove**: selfcheck **30** (monotonia su 100 size, invariante del tetto su 425 combinazioni) ·
> `coppia-simmetrica-scatta.test.js` **21** sul CABLAGGIO attraverso `ripristinaGamba` vera, con la
> **sequenza** delle chiamate misurata · banco passo 13 verde, **18 passi su 18**, 10 corse su 10.

**Il terzo meccanismo che può spegnere un mercato.** Gli altri due sono `setTracking` (ciclo 6 h) e
`impostaBot` (fermo di sicurezza). `trigger-capitale-fermo.test.js` pretende che **ogni `enabled: false`
del file appartenga a un meccanismo dichiarato**, ed è caduto sul terzo prima che girasse una volta:
è stato ammesso **dopo** aver provato sul sorgente che spegne solo l'ingresso. Il pattern **non** è
stato allargato a un `setAutoReprice(` generico — sarebbe un varco largo quanto il file.

**Trappola incontrata scrivendo questo codice, e vale per il prossimo che ci lavora:** `\brain\b`
senza ancore classifica come meteo **«Ukraine signs peace deal with Russia before 2027?»** («rain»
sta dentro «Ukraine»). Due mercati geopolitici sparivano dall'universo **in silenzio**.
E `Number(riga.rewardsMinSize)` su un campo assente vale **0**, cioè `0 ≤ 20`: un mercato di cui non
si sa il pavimento premiante veniva dichiarato **il più finanziabile di tutti** — **ottava** occorrenza
di §5.3, di nuovo trovata da una prova e non dal ragionamento.

### 4.14 · Le QUATTRO cinture, e mordono tutte e quattro (17 agosto 2026, sera)

> **🟢 ERANO CINQUE E NE MORDEVA UNA. ADESSO SONO QUATTRO E MORDONO TUTTE**, sulla strada da cui il bot
> piazza davvero. Decisione dell'operatore; misura e prova in §5-bis p.191.
>
> **LA QUINTA È STATA TOLTA, NON DISARMATA.** `MAKER_PLACEMENT` era il ripiego sull'ambiente di
> `adapter.js` per il campo `placement`, e **non aveva chiamanti**: l'unico costruttore dell'adapter
> (`manual-order.buildPlacementAdapter`) passa sempre `placement` esplicito, ricavato da
> `MANUAL_ORDER_PLACEMENT`. Non decideva niente e veniva contata. *«Una cintura senza chiamanti è peggio
> di nessuna, perché me la fa contare»* (l'operatore). ⚠ **Toglierla STRINGE**: senza ripiego, un
> chiamante che non passa `placement` ottiene `dry-run`, che è la posizione chiusa.
>
> **LE DUE CHE ERANO INERTI ORA ARRIVANO AL GATE.** `buildPlacementAdapter` cablava `mode: 'live-min'` e
> **non passava `dryRun`** — e l'adapter fa `dryRun = opts.dryRun === true`, senza ripiego sull'ambiente
> per quel campo. Quindi `MAKER_MODE` non gate la corsia manuale e `MAKER_ADAPTER_DRYRUN` **non veniva
> letta** su nessun percorso di piazzamento esistente. Adesso vengono da `lib/maker/cinture-armamento`,
> cioè dallo **stesso modulo da cui `stato.js` le racconta**: non più uno specchio da confrontare, ma
> **la** lettura, usata per dire lo stato e per deciderlo. Il reperto D1 qui non è più esprimibile.
>
> | cintura | dove morde | gate |
> |---|---|---|
> | `MAKER_MODE` | `evaluatePlacementGate`, via `buildPlacementAdapter` | `maker-mode` |
> | `MAKER_ADAPTER_DRYRUN` | idem | `dry-run` |
> | `MANUAL_ORDER_PLACEMENT` | l'ultimo `if` prima della POST (`adapter.js:923`) | nessuno: `dry-run-validated` |
> | freno di agent41 | `giro()` e `controlloCapitaleFermo` ⇒ `dryRunOnly` alla corsia in blocco | nessuno: non si invia |
>
> **⚠ MONOTONO PER COSTRUZIONE**: modo non vivo ⇒ `off`, ombra ⇒ rifiuto. Nessuna configurazione che
> prima rifiutava ora passa — si aggiungono rifiuti, mai permessi. Ambiente illeggibile ⇒ entrambe scattano.
> **⚠ NON TOCCA LETTURE NÉ CANCELLAZIONI**: `buildPlacementAdapter` ha **un solo chiamante**, e leggere e
> cancellare passano dall'adapter cancel-only, che non ha né modo né `dryRun`. Il guardiano cancella.
> **⚠ `puoPiazzare` resta «le quattro sono aperte», non «l'ordine passerebbe»**: `evaluatePlacementGate`
> ha anche `kill`, `venue-allowlist`, `limit-*`, `v2-sdk-*`, `funding-approval`, che non sono cinture
> dell'operatore ma stato del sistema.
>
> **LA PROVA**: `node scripts/ricerca/prova-cinture.js` — **10 verdi, 0 rossi**. Ognuna inserita **da
> sola** con le altre tre aperte ⇒ zero ordini al venue simulato, col gate atteso; più il **CONTROLLO**
> (quattro aperte ⇒ l'ordine parte), senza il quale quattro rifiuti non proverebbero niente.
> ⚠ E la prima corsa le dava tutte e tre rosse **per colpa del banco**, non della produzione: il suo
> adapter simulato cablava modo/`dryRun`/`placement` ignorando gli `opts` e applicava un solo gate —
> **più permissivo del venue proprio sulle cinture**. Corretto: il seam è solo la rete.

---

## 5 · QUESTIONI APERTE

Solo voci con evidenza reale nel codice, nei commit o nei file di stato. Chiuso ⇒ si toglie di qui e
resta una riga nel registro di §5-bis.

### 5.1 · Riavvii pendenti — SUL BOT VIVO, non su questa copia

> **⚠ CORRETTO IL 15 AGOSTO 2026: LA FLOTTA DI `/root/bot` È ACCESA, E QUESTA RIGA DICEVA IL CONTRARIO.**
> Qui c'era scritto «pm2 è installato ma la flotta non è mai stata avviata»: era vero quando fu
> scritto e falso da quando qualcuno l'ha avviata, **senza che niente lo dicesse**. Verificato con
> `pm2 jlist`: **10 processi online** (`agent24` · `agent27` · `agent34` · `agent38` · `agent40` ·
> `agent41` · `agent42` · `agent43` · `agent45` · `agent-monitor`) più `agent44` in `waiting restart`,
> che è il suo stato **corretto** (è un cron delle 03:07, non un processo caduto).
> **⚠ LA CAUSA NON ERA `stato.js`, ED È LA PARTE CHE VALE**: `stato.js` non ha mai affermato che la
> flotta fosse spenta — semplicemente **non guardava il runtime**. Leggeva `ecosystem.config.js` e
> stampava «processi definiti 11», una riga che dice *11* a flotta accesa e *11* a flotta spenta.
> Un pannello che non distingue acceso da spento non descrive nulla. **Corretto**: `stato.js` ora
> legge `pm2 jlist` e confronta i due elenchi **nei due versi** — definiti-ma-assenti e
> vivi-ma-non-definiti (`scripts/cli/_comune.flottaViva`). Nessuna riga di questo file va creduta su
> uno stato che un comando può leggere.

> **🟢 LA FLOTTA È ACCESA: 11 PROCESSI — 17 agosto 2026, sera, su autorizzazione dell'operatore.**
> `pm2 start agents/ecosystem.config.js` dall'utente `bot`, poi `pm2 save`: dump con 11 app, un solo
> `cwd` (`/home/bot/bot`). Verificato da `/proc/<pid>/environ`: **4/4 cinture inserite** su agent40 e
> agent41, identiche fra loro e coerenti col `.env`; perno vuoto; perimetro live-min **1**; KILL spento;
> AVVIA su **FERMA**; allowlist vuota; selezione spenta; **zero ordini a libro**.
> **⚠ E LO SNAPSHOT DELLE POSIZIONI È TORNATO FRESCO** (< 180 s contro i 703 s di prima): il gate
> `venue-positions-unreadable` non rifiuta più. A flotta spenta il bot era fermo **anche** per
> fail-closed, e quel presidio adesso non è più quello che lo tiene fermo — lo tengono le cinture.
> **⚠ `pm2 startup` NON È STATO FATTO: richiede root e `sudo` chiede la password.** Al suo posto c'è una
> riga `@reboot` nella crontab di `bot` che chiama `pm2 resurrect` (cron è `active`). Funziona, ma è il
> ripiego: il modo giusto resta
> `sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u bot --hp /home/bot`,
> e fatto quello **la riga di cron va tolta** — due meccanismi che riaccendono la stessa flotta sono
> peggio di uno. ⚠ `pm2 resurrect` rilegge il **dump**, non l'ecosystem: dopo ogni cambio alla flotta va
> rifatto `pm2 save`, o il riavvio riporterebbe su la flotta di ieri.
> **⚠ I `cwd` E gli `HOME` DELL'ECOSYSTEM NON SONO PIÙ LETTERALI** (§5-bis p.188): `cwd` è `__dirname/..`
> e `HOME` è `os.homedir()`, quindi il config non può più puntare a un repo diverso da quello da cui è
> stato letto.
> **⚠ Le tre variabili del banco** (`MAKER_FEED_BOOKS_FILE`, `MAKER_FEED_BOARD_FILE`, `POLY_CLOB_BASE`)
> **non sono dichiarate** né nell'ecosystem né nel `.env`: i processi vivi leggono la directory di
> servizio di §5-bis p.189, non i file del banco.

**⚠ DUE REGOLE CHE VALGONO ANCORA, e il resto era storia di `/root/rewards-bot`:**

> **⚠ I PROCESSI CHE DECIDONO UN PREZZO SI RIAVVIANO INSIEME, O I PREZZI DIVERGONO.**
> `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` è un **env**, quindi vive nel processo: se agent41 riparte e
> agent40 no, agent41 apre a una distanza e il rinnovo di agent40 riporta l'ordine a un'altra — non è
> pericoloso (la manopola può solo allontanare dal mid), ma rende **illeggibili** i dati che il test
> esiste per raccogliere. Lo strumento che le tiene allineate è `node scripts/cli/distanza.js`.
> **⚠ E `pm2 restart <nome> --update-env` NON RILEGGE `ecosystem.config.js`**: `--update-env` prende
> l'ambiente della **shell**. Per una variabile NUOVA serve il riavvio **dal file**:
> `pm2 restart agents/ecosystem.config.js --only <nome>`. Vale per `MAKER_MERCATI_CONTEMPORANEI` (R1).

> **⚠ LE MODIFICHE A `lib/rewards/allocator.js` ENTRANO IN SERVIZIO SENZA RIAVVIO**: il piano nasce in
> un processo figlio che rilegge il file da disco a ogni giro (§5.3). Quello che vive nel processo di
> agent41 sono le righe di log e il cablaggio.

### 5.2 · Aperte

> **Chiuse oggi, e scese a una riga** (diagnosi integrale in §5-bis e in `git log`):
> **p.15/16 guardiano k=2 + letture distinte** → §5-bis p.141 e p.145 · **p.17 registro residui senza
> consumatore** → p.148 · **p.18 tetto per ordine sul riposizionamento scoperto** → p.147 ·
> **p.21 «cancellazioni continue» = ciclo di riprezzo** → NO, misurato: vita mediana di un ordine
> **18,2 min**, `band-exit` è una VALUTAZIONE (3.622 giudizi «fuori banda», **zero** cancellazioni) e
> 3.898 dei 4.874 eventi sono macchina di CHIUSURA ·
> **p.39 il residuo su fill parziale** → CHIUSO il 17/08: si cancella SEMPRE e subito (§4.6), la
> condizione precedente era una tautologia e la guardia vera era «solo il primo giro» ·
> **p.28 i due commenti a 110¢ in `auto-close.js`** → corretti il 16/08 nello stesso commit che porta
> il tetto unico a 101¢ (§5-bis p.165), il reperto D7 non esiste più.

49. **✅ CHIUSA IL 21 AGOSTO — E LA DIAGNOSI DI STAMATTINA ERA SBAGLIATA, VA DETTO PER INTERO.**
   Avevo scritto che da `realistic-estimate.js:269` «passa il netto, cioe' il numero che ordina i
   candidati e decide gli spodestamenti». **Non e' vero, e chi riapre non rifaccia quel ragionamento.**
   `placementShareFactor` e `credibleShareFactor` sono **esportate** e ricevono `sizeShares` come
   PARAMETRO: `allocate.js:149-151` passa la PROPRIA size, che viene da
   `curve.shareForCapital(..., pairCostUsd)` — gia' corretta, e con `usePairCost` acceso per difetto
   nel piano di produzione (`allocator.js:1495`, `opts.usePairCost !== false`). La `sizeShares` della
   riga 269 e' **locale a `realisticEstimate`** e non raggiunge mai l'obiettivo.
   **LA CATENA VERA, misurata**: obiettivo `allocate.js:455` → `net.js:80 shareForCapital` →
   `level.net5m` → `allocator.js:970 bestNetPerDay` → `agent41:1357 nettoPerMercato` → selezione.
   Stima `allocator.js:841 realisticEstimate` → `realisticByTick` → `realisticBestPerDay`.
   **Prova**: l'impronta delle cinque funzioni esportate e' **identica prima e dopo**
   (`8cfcada9dcc566b6`), e le due size coincidono ora al bit (divario 0 o 7,11·10⁻¹⁵).
   ⚠ **MA :269 NON ERA SOLO DISPLAY**, ed e' l'altra meta' della correzione: `realisticBestPerDay`
   ordina le righe in **`trigger-capitale-fermo.scegliMercato:317`** (quale mercato riceve la prossima
   tranche a capitale fermo, ogni 120 s) e `totals.realisticPerDay` alimenta il **trigger di VALORE**
   del ciclo 6 h (`realloc-cycle.confrontoDiValore`). Due decisioni, non due numeri da mostrare.
   **Quanto si sposta, misurato sul board vivo (29 ammissibili)**: **uno scambio adiacente su 29**
   (posizioni 6-7, righe distanti $0,0001/g) e **la prima scelta NON cambia**. Il motivo e' che i due
   fattori sono RAPPORTI di quote: con una concorrenza di migliaia di share contro le nostre ~64 sono
   quasi insensibili alla size. Dove morde davvero e' il regime a concorrenza sottile (§5-bis p.167:
   168 share), e su questo board non c'e' nessun ammissibile li'.

54. **🔴 IL TOTALE DEL GUARDIANO NON E' ATOMICO: LE DUE FONTI HANNO FRESCHEZZE DIVERSE — 21 agosto.**
   `valutaCapitale` somma **saldo** (cache 45 s) e **posizioni** (snapshot di agent40, tollerato fino a
   180 s). Durante una chiusura/merge il capitale e' «in volo» e le due fonti raccontano due istanti
   diversi, in **entrambe** le direzioni: verso l'ALTO il 16/08 19:28 (saldo nuovo + posizioni vecchie ⇒
   +$57,10, ed e' D-D, §5-bis p.202, ora chiuso dal lato del riferimento); verso il BASSO il **20/08
   22:36**, dove il guardiano leggeva **$1.438,41** mentre l'osservatore nello stesso minuto leggeva
   **$1.492,81** — **$54,40 di divario**, con un merge on-chain in corso su `c7dee846`. ⚠ Il verso basso
   **puo' ancora produrre uno scatto falso**: k=2 non lo ferma se il transitorio dura due letture, e il
   20/08 e' successo. Col riferimento corretto quel minimo resta a **$11,86** dal punto di scatto: la
   protezione regge, ma di poco. **NON CORRETTO**: la cura e' pretendere la **co-temporalita' delle due
   letture** (o non misurare quando divergono), cioe' cambiare come si legge il capitale nell'unica difesa
   viva — e va deciso, non fatto di passaggio. ⚠ Su 8.812 campioni i picchi a **una sola lettura** sono 4:
   e' raro, ma cade proprio negli istanti in cui il capitale si muove.
53. **🟡 IL CICLO NON DISTINGUE «FIGLIO MORTO» DA «NIENTE DA FARE» NELL'ESITO — 21 agosto 2026.**
   `lib/maker/realloc-cycle.js:255-261`: se il piano fallisce e `triggerValidita` e' FALSO si esce con
   `mancato(...)` ⇒ **`referto('nessuna')`**, lo stesso esito di «non c'era niente da fare». Nel record
   la differenza c'e' (`valore.misurabile === false`, traccia `piano/fallito`) ma **nessuna difesa
   reagisce**. ⚠ E il ramo contiene un **fail-open**: il commento dice «non stava per succedere
   niente», ma dopo `mancato()` il ciclo ritorna e `confrontoDiValore` — il SECONDO trigger — non gira
   mai, quindi «non stava per succedere niente» e' proprio cio' che il figlio morto ha impedito di
   sapere. Un trigger **non misurato** trattato come **non scattato**: la famiglia `Number(null) === 0`
   di §5.3 in forma di flusso di controllo. **Non corretto**: cambiare la tassonomia degli esiti del
   ciclo e' un secondo lavoro, e chiuso l'OOM il caso diventa raro.
51. **🟡 LO `scaglione` SALVATO NELLO STATO PUO' DIVERGERE DA QUELLO CALCOLATO — 21 agosto 2026.**
   `selezione-mercati` rifiuta lo scambio quando `v.scaglione !== occ.voce.scaglione`: il primo e'
   **ricalcolato** dal `rewardsMinSize` corrente, il secondo e' **congelato** in
   `data/selezione-mercati.json` all'ingresso. Se il venue cambia `rewardsMinSize`, o se cambia
   `MAKER_MERCATI_CONTEMPORANEI` (a N=1 i secchi diventano UNO e si chiama `alto`), un occupante resta
   con un secchio che non esiste piu' e **diventa non spodestabile in silenzio**. Trovato dal test di
   p.200 che falliva, non dalla rilettura. **Non corretto**: cambia il comportamento della rotazione.
52. **🟡 `lib/maker/quantita-davanti.js` NON HA CHIAMANTI — 19 agosto 2026, non tracciato da git.**
   E' la forma che §4.14 chiama «una cintura senza chiamanti e' peggio di nessuna, perche' me la fa
   contare». **Non toccato.**
50. **🟡 `1 − 2d` HA ANCORA UNA TERZA COPIA, NELLA CORSIA DEL BACKTEST — 21 agosto 2026.**
   `scripts/rewards-replay/lib/allocate.js:387` (`pairCostForMarket`) riscrive `1 − 2d` invece di
   importare `size-da-capitale.costoCoppiaAllaDistanza`. Oggi i due numeri **coincidono** (verificato:
   stessa guardia `d >= 0.5`, stesso arrotondamento a 9 cifre), quindi non c'e' divergenza da misurare —
   ma sono due copie, cioe' il reperto D1 in attesa. **Non corretta di proposito**: quel file e' la
   corsia del backtest e ogni driver storico ci passa; toccarlo puo' muovere serie storiche che esistono
   per essere confrontate, e la decisione e' dell'operatore, non della patch.

48. **🟡 `flatUserShare` (KALSHI) HA LO STESSO DENOMINATORE E NON E' STATA TOCCATA — 21 agosto 2026.**
   `lib/rewardScore.js` `flatUserShare` divide ancora per il mid. Kalshi **non pubblica ne' banda ne'
   formula**: quella funzione rispecchia il modello OSSERVATO di agent25, e cambiarne il denominatore
   senza una formula del venue a cui ancorarsi sarebbe speculativo. Il confine e' **fissato da
   un'asserzione** (blocco ⑧ di `rewardScore-denominatore.test.js`), cosi' l'omissione resta una scelta
   leggibile e non una svista.
47. **🟡 `reward-layered.js:188` PASSA UN BUDGET PER LATO A UNO SCORER CHE ORA VUOLE IL TOTALE — 21/08.**
   `perSideSizeUsd` e' per lato **e** ogni gamba viene dimensionata al proprio prezzo
   (`sizeUsd/bidPrice`, `sizeUsd/askPrice`), quindi quel modello produce **share DIVERSE sui due lati**:
   `quadraticUserShare`, che assume la posa simmetrica, non e' mai stato lo scorer giusto per lui —
   disallineamento **preesistente**, non introdotto qui. Nessun chiamante di produzione
   (`perSideSizeUsd` compare solo nel `.d.ts`), e il `dashboard` non e' nella flotta. Non corretto: la
   scelta fra «passare il totale» e «cambiare modello» ha bisogno di una decisione, non di una patch.
46. **🟡 `reward-gating.ts:59` LEGGE UN CAMPO CHE NESSUNO SCRIVE — 21 agosto 2026.**
   `!!m.levels[capitalKey]?.aboveMin`, ma `agent24.computeLevels:553` **non copia mai `aboveMin` dentro
   `levels[C]`** (lo calcola `estimateCapitalLevelRange` e lo lascia al livello superiore). Il gate vale
   quindi **sempre `false`**. Difetto preesistente, indipendente da D1; superficie del pannello.
45. **🟡 IL RILEVATORE «STATO TOCCATO» DELLA SUITE NON DISTINGUE CHI HA SCRITTO — 21 agosto 2026.**
   `suite-rossi.js` ha segnalato `data/selezione-mercati.json` come toccato, ma quel file lo riscrive
   **agent41 ogni 120 s** per mestiere: il rilevatore guarda l'mtime e non l'autore, quindi su flotta
   accesa e' **sempre** positivo e non puo' piu' segnalare il caso vero (un test che scrive nello stato
   di produzione, §5 punto 1). Verificato che lo stato e' sano: `by: agent41 · selezione automatica`.

44. **🟡 LA META' DI R6 CHE MORDEREBBE DAVVERO NON E' IMPLEMENTATA — 18 agosto 2026.** «Anche oltre
   101¢» vale per **comprare l'altro lato** e sbloccare un residuo col merge. Non esiste un percorso che
   compri sopra il tetto della coppia, e inventarlo sarebbe un meccanismo nuovo su capitale reale. La
   metà implementata — vendere attraversando, anche sotto il minimo — copre il caso comune. **Serve una
   decisione**: quanto sopra 101¢ si può spendere, e con quale tetto in dollari.
43. **🟡 R4: SUL LATO MISURABILE NESSUN CROLLO, SUL LATO CHE SI È RIEMPITO NON SI SA — 19 agosto.**
   Replay sui book del 18 (`data/ricerca/erosione-18-agosto.md`, modulo VERO): sulle **vite reali** dei
   47 ordini misurabili, a **40% ZERO scatti e ZERO letture singole sotto soglia**; il minimo di tutta
   la giornata è **58,9%** della baseline. La soglia non è tarata male, è lontana dai dati. **Il fill
   del 23:17:21 è venuto dal MID**: profondità davanti piatta a 260 share fino a **−2 s**, poi il mid
   salta **+8¢ in un solo intervallo**; il crollo (−72%) arriva **dopo**. Prima soglia che produce
   qualcosa: **60%, 1 scatto in tutta la giornata**; a 80% sono 3.
   **⚠ MA IL FILL ERA SULLA GAMBA NO, E `mid-history` REGISTRAVA UN SOLO BOOK PER MERCATO**: la
   conclusione «nessun crollo» è provata sul **lato sbagliato**, e per le **20 gambe NO su 67** non
   esiste una riga su disco. Cercate le altre fonti: tape (prezzi, non profondità), `auto-reprice`
   (mid NO e miglior bid altrui a 5 s, ma `depthAheadUsd` è `null` in tutta la finestra), clob-audit,
   osservatore — **nessuna ha la profondità**. Ciò che si ricava: alle 23:17:11 il nostro bid NO era a
   72¢ col **miglior bid altrui a 63¢**, cioè **davanti a noi non c'era nessuno** ⇒ lì R4 non avrebbe
   potuto scattare a nessuna soglia (`zoneDepth` su zona vuota non riscalda mai, «è voluto»). **Resta
   aperto COME siamo rimasti soli**: fra 23:02 e 23:17 nessun record, e se la coda si è assottigliata
   lì, quella era l'erosione.
   **⚠ IL DATO C'ERA E LO SCRITTORE LO BUTTAVA**: `reconcileSubscriptions` sottoscrive il token NO da
   sempre (agent34:705, `side:'no'`); era `sampleMidHistory` a guardare solo `meta.tokenId`.
   **Corretto il 19 agosto** e **in servizio dal riavvio di agent34** (verificato sulle righe vive: 244
   righe col campo `no`, 190 coi livelli su entrambi i lati): ogni riga porta `no: {…}` col book
   completo, e i campi di primo livello restano intatti per i cinque lettori esistenti
   (`lib/mid-history-due-book.test.js`, 33/33, rosso sul sorgente di ieri). **⚠ Il 18 agosto non si
   recupera.**
   **⚠ E «MIGLIOR BID ALTRUI» NON DIVENTA UNA SERIE**: `mid-history` registra il book **grezzo**, che
   include i NOSTRI ordini. Per R4 non serve — `zoneDepth` salta per costruzione il proprio livello e
   tutto ciò che sta sotto, quindi la profondità davanti è già «altrui». Restano non rispondibili
   *quanto del libro era nostro* e il caso di **due nostri ordini vivi sullo stesso lato** (durante un
   ripristino di gamba), dove il più lontano dal mid verrebbe contato come altrui — cioè l'errore cade
   nella direzione che rassicura. Chiuderlo vorrebbe dire scrivere i nostri ordini nella riga, e
   agent34 è il processo **senza credenziali**: è una scelta di superficie. Dettaglio in `APERTI.md` §7. ⚠ Costo: la riga quasi raddoppia (~148 →
   ~285 MB/g su 90 mercati, ~4 GB sui 14 giorni di ritenzione, 9,2 GB liberi). La leva è
   `MID_HISTORY_RETENTION_DAYS`, **non** l'intervallo: 75 s è già ciò che limita la misura.
   **⚠ ALTRI DUE LIMITI**: il feed campiona ogni **75,0 s** (non ~115) contro i 5-10 s di agent40,
   quindi un crollo più breve di **150 s** è invisibile e i numeri sono un **limite inferiore** ·
   **18 vite su 47 non riscaldano nemmeno la baseline**. **Nessuna soglia toccata.**
42. **🟡 `tre-fix-sicurezza.test.js` SCADE, NON FALLISCE — 17 agosto 2026.** 48-50 s contro il limite di
   60 s di `suite-rossi.js:25`: entra ed esce dai rossi col carico della macchina (49,98 → 48,42 s prima e
   dopo le modifiche del 17, quindi non è una regressione). **Un test che scade è indistinguibile da un test
   che fallisce**: o si accorcia o si alza il limite, ed è una decisione.
40. **🟡 IL PERIMETRO È UNA CONSEGUENZA, NON UNA DICHIARAZIONE — 17 agosto 2026.** Selezione spenta,
   allowlist vuota, perno vuoto: il perimetro live-min **non è deciso, è dedotto** dall'unione di §4.8. Ieri
   valeva **1** (Hong Kong `0xe9b3e28d`, 6 share sotto il minimo del venue ⇒ quotabile **zero**); oggi, a
   flotta spenta e snapshot posizioni scaduto, vale **0**. **⚠ Non è stabile per costruzione**: cambia con
   le posizioni. Il perno è ciò che lo rende **stabile e nominato**, vive nel processo, e scriverlo richiede
   `ecosystem.config.js` + riavvio **dal file e insieme** (§2 r.2). **Non impostato**: è un atto di armamento.
31. **🟡 LA MANOPOLA DELLA DISTANZA RESTA A 0,95 — SCELTA, NON DERIVA (16 agosto 2026).**
   `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V: '0.95'`. Da sola costerebbe il 99,6% del punteggio, ma **non decide
   più il punto d'arrivo**: il margine dal bordo di §4.1 riporta l'ordine a 3,4-3,5¢ dal mid, S ≈ 0,05, venti
   volte il bordo nudo. 0,95 è il modo di chiedere il **bordo esterno**. **⚠ Cambiarla richiede il riavvio
   COORDINATO dei due processi** (§5.1): `node scripts/cli/distanza.js`.
34. **🟡 IL MARGINE DAL BORDO NON È DICHIARATO NELL'ECOSYSTEM, ED È VOLUTO (16 agosto 2026).**
   `MAKER_DISTANZA_MARGINE_BORDO_TICK` e `…_FRAZIONE_V` sono env ma **non** stanno in
   `ecosystem.config.js`: entrambi i processi prendono lo stesso difetto dal codice, quindi un riavvio
   scoordinato **non può** farli divergere. Il prezzo: per cambiarlo si tocca `distanza-obiettivo.js` e si
   riavviano **entrambi**. Volendolo per-processo, va aggiunto **a tutti e due insieme**.
35. **🟡 LA ROTAZIONE TOGLIE IL TETTO SUL NUMERO DI MERCATI ESPOSTI (16 agosto 2026, per decisione).**
   §4.13: tre quotano, N completano. Restano il tetto per mercato ($61,25), `maxOpenNotionalUsd`
   (**$650** dal 18 agosto, era $150) e il kill a $100/giorno. **Non è misurato quanti mercati possano stare in gestione insieme** su book veri:
   §5-bis p.162 dà il 32,1% dei fill chiusi in 28,6 min mediani, ma su altri wallet. **Da guardare al primo
   giro vivo prima di alzare il cap.**
36. **🟡 `npm run build` FALLISCE: manca `lucide-react`, causa preesistente (16 agosto 2026).**
   `app/components/ui/Redacted.tsx` lo importa e non è in `package.json`: caduto con la riduzione. Il build
   stampa `✓ Compiled successfully` e muore **dopo**, nel type-check — tutto il JS compila. **Non
   installato**: è una decisione, e il `dashboard` non è nella flotta. Al suo posto: suite e selfcheck.
37. **✅ CHIUSA IL 19 AGOSTO — I TRE TEST AVEVANO RAGIONE SULLA RELAZIONE E TORTO SULLA GRANDEZZA.**
   Difendevano `maxOpenNotionalUsd ≤ N × tetto per mercato`, «o non morderebbe mai». Ma il gate somma
   `openNotionalUsd + notional` **anche sugli ordini di apertura**, e `openNotionalUsd` conta i **fill
   riconciliati**: lo stato peggiore che il bot attraversa lavorando non è «N mercati pieni», è **N
   coppie a riposo PIÙ il loro completamento**. A N=5: $306,25 + $306,25 = **$612,50**, contro un cap
   di **$650**. Invariante riscritta su quella grandezza; **il cap resta $650** (decisione
   dell'operatore).
   **⚠ NON SI SCENDE A $306**: sarebbe l'errore del 16 agosto rifatto — allora il cap fu portato a $150
   contro 3 × $61,25 «per farlo mordere», e il tetto **murò la gestione a metà strada**, rifiutando il
   BUY che completa la coppia e la SELL che liquida la gamba nuda (§5-bis p.168). Un tetto che impedisce
   di CHIUDERE non è un limite di rischio, è un rischio. **Il freno resta il kill a −$100.**
   **⚠ UNA SOLA DEFINIZIONE**: `concentration.esposizioneMassimaRaggiungibileUsd(N)`, importata dai
   quattro chiamanti. `null` su N non leggibile — mai uno zero, che renderebbe l'invariante vera per
   qualunque cap. Verificato che morda: verde a $650 e $612,50, **rossa a $612,49, $400 e $306,25**, e
   rossa se N non si legge.
   **⚠ E `limiti-versionati` ⑥ CONTAVA SOLO IL RIPOSO**: relazione giusta, metà della grandezza.
   **⚠ `sette-punti` NON fotografa più il valore**: quel mestiere ce l'ha `limiti-versionati.test.js`,
   che confronta il versionato col disco chiave per chiave — una difesa che non vive nella memoria di
   chi ha scritto il numero. Due copie significavano solo che una sarebbe invecchiata, ed era
   invecchiata a $150 per un giorno.
22. **🟡 IL PIANO SI SVUOTA, E LA CAUSA NON È IL FILTRO DI PROFONDITÀ** (13 agosto 2026). Il cancello che
   decide è `pavimentoPremiante(minSize) > tetto per mercato`: 56 mercati su 102 contro i 5 della
   profondità. ⚠ Rimisurato il 17/08 a $147 (`cancello-a-capitale-piccolo.js`): **40 righe candidabili** su
   147, e a togliere di più è la **SELEZIONE** (−86: ≥24 h, meteo) contro il pavimento premiante (−21); il
   tetto per ordine e la quota del 60% tolgono **zero**. La leva è più capitale, non un tetto più alto.
2. **`REALLOC_SCHEDULER_DRY_RUN` viveva nella descrizione in memoria di pm2**, non nel dump né in `.env`.
   ⚠ **Con la migrazione quella memoria è sparita** (pm2 nuovo, nessun dump): oggi la variabile è **assente
   ⇒ freno INSERITO**, fail-closed. Resta la regola: `--update-env` **fonde**, non sostituisce, e l'unica
   rimozione è `pm2 delete` + `pm2 start`.
3. **Nota minore**: l'header di `strategia-merge.js` elenca quattro ragioni per cui il merge «non è
   eseguibile» e il relayer ne ha tolte tre (solo un commento).
4. **Nessun processo sorveglia il battito di agent40** (agent37 rimosso il 9 agosto, voluto). A togliere
   gli ordini restano la **GTD nativa** del venue e, sul lato economico, `agent43-guardian`.
5. **La ricostruzione del piano non conosce lo scope del rinnovo**: `auto-reprice` itera
   `cfgState.enabledMarketIds`, quindi un mercato fuori dal piano non viene visitato e i suoi ordini muoiono
   per GTD in 23 min. **Decisione documentata**, ed è perché la gamba orfana non si controlla là.
7. **La ricostruzione sotto soglia scatta quasi a ogni giro** (6 righe contro una soglia di 12): ~13 s di
   figlio ogni 10 min. È corretto, ma se il board si allargasse stabilmente vale la pena rimisurare.
13. **La soglia sulla derivata per la sentinella è misurabile: 85%** (§5-bis p.140). Non implementata.
19. **🟡 LA CADENZA ADATTATIVA È SOTTO-RISOLTA — sola misura.** agent40 classifica il **99,6%** delle
   osservazioni «lenta» (10.000 ms) mentre `leggiFinestraTutti` su 15 min vede `rangeMid = 0` sul **48,8%**:
   il conto non torna, il divario non è spiegato. Non è la leva.
9. **🔴 LA SENTINELLA VEDE IL VUOTO, NON IL COLLASSO — buco aperto, 13 agosto 2026.** Il ramo ③ di
   `sentinella-vuoto.js` dice «`ordiniARiposo > 0` ⇒ il libro non è vuoto» e azzera l'orologio: un calo da
   **23 ordini a 2** — il 91% — è invisibile. È tarata sul caso ESTREMO, non sulla derivata. **Non
   implementata**: la cura è un secondo criterio (calo relativo su finestra) e va tarato su quanto oscilla
   normalmente il numero di ordini, misura che oggi non esiste. Non si aggiunge una soglia a occhio a un
   presidio. (L'85% di §5-bis p.140 è per la COPERTURA, non per il conteggio: due grandezze diverse.)
10. **Il costo di `profondita-non-verificata` NON è misurabile dallo stato salvato.** L'esclusione vive in
   `allocator.js:1104`, che gira in un **processo figlio**; `realloc-ultimo-piano.json` persiste **solo
   `righe`** (i vincitori) e **nessun file conserva gli scartati**. Zero occorrenze in 4 giorni perché quel
   giornale non è dove finiscono: **non è che nessuno l'abbia guardato, è che nessuno lo scrive.** La cura è
   l'istogramma dei `reasonCode` scartati accanto a `righe`; senza, non si tocca agent34.
11. **I ROSSI NOTI RUOTANO NEI NOMI, NON NEL CONTEGGIO.** Chi confronta confronti i **NOMI** (§5-bis
   p.134): cambiano da soli col board, e un membro nuovo non è una regressione — ma va verificato che il
   rosso non tocchi il codice modificato. **Non parte**: `leg-order` (test JS su moduli TypeScript).
   ⚠ **IL CONTEGGIO DEL 19/08 ERA INVECCHIATO: il 21/08 la suite dà 240 test · 231 verdi · 8 ROSSI ·
   1 non parte.** Gli 8 sono stati verificati **uno per uno anche sul sorgente PRE-correzione D-A**
   (agent41 riportato a HEAD e rieseguiti): **rossi anche prima, stessi nomi, nessuno introdotto**.
   Sono `dipendenze-mai-iniettate` · `distanza-2c` · `end-of-scale-cycle` · `tetti-per-giro-e-scope` ·
   `tre-fix-sicurezza` (timeout, §5.2 p.42) · `categoria-mercato` · `tetto-derivato-dallo-scaglione` ·
   `tetto-e-scoperta`. **Chi confronta confronti i NOMI, e li rilegga: il numero qui sotto è storia.**
   **Rossi: 2 su 229, verificati il 19/08 su albero COMMITTATO** (erano 12 la mattina del 19, e 10 il
   17/08 su 209 test — l'elenco di allora non vale piu': `dipendenze-collegate`, `scaduto-senza-rinnovo`,
   `scadenza-ereditata`, `end-of-scale-cycle`, `tetto-e-scoperta`, `cancellazione-riconosciuta` sono
   verdi). Restano **i due che dipendono dai DATI VIVI**, non dal codice:
   `categoria-mercato` (12,0% non classificato contro un limite del 2%) e `velocita-mercato` (mediana
   del board 15,2%) — **ruotano col board**, e vanno riletti come misura, non come regressione.
   ⚠ **I tre del tetto di esposizione sono CHIUSI il 19/08** (§5.2 p.37): l'invariante è stata riscritta
   sulla grandezza giusta — `cap ≥ riposo + completamento` — non ammorbidita, e il cap resta $650.
   ⚠ **Gli 8 rossi di `c919981` sono stati RISCRITTI, non ammorbiditi** (19/08): le loro fixture non
   portavano l'età del book, quindi ricevevano `skip/book-non-databile` e non arrivavano al codice che
   provavano. Fixture con book **databile** + un blocco per file che **difende il gate sul proprio
   percorso**, ognuno col suo **CONTROLLO**. Prova esaustiva in un posto solo:
   `lib/maker/bid-databile.test.js` (34/34), che include l'eccezione R6 e verifica **per assenza** che
   il merge non sia toccato (`decidiLivello` non riceve affatto `rules`, quindi R8 regge).
   ⚠ **`hook-piazzamento` e `policy-permessi` sono USCITI dai rossi** (70/0 e 84/0): erano rossi per due
   percorsi `/root` morti, non per un difetto — §5-bis p.188. ⚠ `tre-fix-sicurezza` compare fra i rossi
   della suite ed è un **timeout**: eseguito da solo fa **42/0** (§5.2 p.42).
   ⚠ **E due rossi nuovi del 17/08 sera erano MIEI, difendevano la proprietà vecchia, e sono stati
   RISCRITTI non ammorbiditi**: `miniciclo-prende-il-mercato` asseriva «la corsia manuale chiede live-min
   a prescindere da `MAKER_MODE`» — vero fino a ieri, falso apposta da oggi (§4.14) — e
   `cablaggio-di-produzione` fotografava i due letterali `/tmp/...` invece della proprietà «non li
   ridichiara». **Lo strumento**: `node scripts/ricerca/suite-rossi.js <nome>`.

### 5.3 · Trappole operative — da rileggere prima di lavorare

- **Un percorso assoluto è un difetto che aspetta**, e il 17 agosto ne sono maturati **dodici** in una
  volta sola (§5-bis p.188). La forma pericolosa non è che il file manchi: è che **ogni lettore ha già un
  ramo per «non l'ho letto»**, e quel ramo si prende la scena — `readJson` → `null` ⇒ board **vuoto**;
  `codaNuova` → `''` ⇒ «il guardiano non ha detto niente»; `diff` che esce **2** ⇒ **zero differenze**, cioè
  un cancello che si apre. Si ancora al package root (`lib/safety/store.DATA_DIR`, che salta le directory
  di build), a `__dirname/..`, a `os.homedir()`, o si chiede a git — mai a una stringa. **E si cerca il
  GEMELLO**: `agent24` scriveva il board dove `rewards-normalize` lo legge, e correggere solo il lettore
  avrebbe fatto divergere due percorsi per lo stesso file, in silenzio (il reperto D1).
- **Una directory CONDIVISA fra utenti è la stessa trappola dei percorsi assoluti, in peggio.** I file di
  servizio stavano in `/tmp` nudo: `/tmp` ha lo sticky bit, quindi dopo il cambio di utente i file di
  `root` non erano né riscrivibili né **cancellabili**. Gli scrittori prendevano EACCES **e i lettori
  continuavano a leggere la copia vecchia, che da quel momento non invecchiava più** — cioè un prezzo di
  quaranta minuti prima presentato come di adesso. Direzione di guasto peggiore di «il file manca».
  Adesso la directory è **per utente** (`lib/percorsi-runtime.js`, `/tmp/rewards-bot-<utente>`, 0700) e
  il controllo all'avvio (`lib/safety/percorsi-critici.js`) si ferma **rumorosamente** se un file di
  servizio esiste e non è scrivibile. ⚠ Il controllo NON pretende che i file esistano: assente è il primo
  avvio, ed è sano.
- **`pgrep -f <nome>` non è affidabile qui**: il comando che lo esegue contiene il nome cercato, quindi
  `pgrep` trova la propria shell. Per l'ambiente di un processo pm2: pid da `pm2 jlist`, poi
  `/proc/<pid>/environ`.
- **Due `npm run build` insieme si distruggono a vicenda**: il secondo rimuove `.next/static/<BUILD_ID>`
  che il primo stava riempiendo. Sintomo: il BUILD_ID nell'errore **non** è quello in `.next/BUILD_ID`.
  Un `.next` incompleto manda il **dashboard** in crash loop al riavvio — **verificare
  `.next/prerender-manifest.json` PRIMA** di riavviarlo.
- **Un `.d.ts` scritto a mano può ROMPERE il build**: un'interfaccia con index signature
  (`[k: string]: unknown`) è più **stretta**, non più larga, e TypeScript rifiuta il tipo vero. Si
  importa il tipo esistente, non se ne scrive un gemello. E un modulo JS nuovo importato da una rotta
  TS senza `.d.ts` fa inferire i parametri dai valori di difetto (`= null` ⇒ `null | undefined`).
- **Un test che guida `miniCiclo` deve iniettare `scriviTetti` E `pianoLeggero`**, o riscrive i tetti
  VERI e fa partire il pianificatore vero sul board vivo (nondeterministico e lento).
- **Una dep col nome sbagliato non è un errore: è un valore di difetto che nessuno ha chiesto.** Quattro
  occorrenze in questo repo (`readDepth` non iniettato, `signerProvider` non cablato, `{file}` invece di
  `{auditFile}`, `deps.stato` con `||` invece di `!== undefined`). Un test che inietta una dep dovrebbe
  **misurare** che la dep sia stata usata.
- **`Number(null) === 0`**: **sei** occorrenze in questo repo, tutte trovate da una prova e mai dal
  ragionamento. «Non ho letto» che diventa «non c'è» è il difetto più ricorrente qui dentro.
- **La truthiness di `find` non è un test di esistenza**: in un array che può contenere valori falsy,
  «esiste un elemento che…» si scrive con `findIndex` o `some`.
- **Un walker dei `require` per regex trova anche i `require` dentro le STRINGHE** — e `RUNNER_PIANO` è
  esattamente una stringa che contiene `require(".../allocator")`. Qui la differenza è fra «serve un
  riavvio» e «non serve».
- **I test strutturali devono filtrare i commenti**: un commento che *racconta* la riga corretta ha già
  fatto passare un test che cercava la stringa nel sorgente.
- **Non asserire su `git diff` né contare occorrenze**: un test che fotografa il working tree è verde
  durante la lavorazione e rosso un minuto dopo il commit. Si difende la **proprietà**, non il conteggio.
  (Successo tre volte: §5-bis p.71, p.115, e il 13 agosto su `capitale-senza-doppio-conteggio`.)
- **Il piano nasce in un PROCESSO FIGLIO** (`RUNNER_PIANO`, `/api/rewards/allocate`) che rilegge il
  codice da disco: le modifiche a `lib/rewards/allocator.js` sono in servizio **senza riavvio**. Quello
  che vive nel processo di agent41 sono le righe di log e il cablaggio.
- **L'hook di piazzamento blocca anche un ciclo di agent41 lanciato a mano**, e anche un heredoc di
  documentazione che *nomini* una funzione di piazzamento. **Non si aggira**: il comando lo esegue
  l'operatore, o si usa lo strumento di scrittura file invece di `cat <<EOF`.

---

## 5-bis · REGISTRO DELLE VOCI CHIUSE

**A cosa serve.** Le decisioni vive stanno in §4; qui resta la **mappa**, perché un riferimento come
«§5 punto 72» sparso nei commenti del codice deve restare risolvibile, e perché sapere *che* un
problema è già stato incontrato vale più del racconto di come. Il dettaglio integrale è in `git log`
e nei commit citati nei sorgenti.

**153** · IL GRADINO 6 NON ESISTEVA: `impostaBot` NON ERA IMPORTATO

**202** · D-D · IL RIFERIMENTO DEL GUARDIANO NON NASCEVA DA UN CAPITALE MAI ESISTITO — 21 agosto.
`riferimentoUsd: 1550.17633` fissato il 16/08 19:28:00.990Z da **una lettura sola**: saldo $1.493,07
(DOPO la chiusura delle posizioni) + posizioni $57,103 (PRIMA) — l'osservatore misura $1.497,05 un minuto
prima e $1.493,08 un minuto dopo, e lo scarto e' **$57,10 esatti**, cioe' il valore delle posizioni.
**LA CAUSA E' UN'ASIMMETRIA, NON UNA SOGLIA**: lo SCATTO pretende due letture distinte e contigue (k=2,
perche' il segnale ha salti fino a $74,47 che rientrano al campione dopo), il CRICCHETTO accettava **k=1**
— e un transitorio verso il basso rientra, uno verso l'alto **resta per sempre**. ⚠ **ERANO DUE STRADE**:
a posizioni «ferme» (anche perche' lo snapshot non e' stato riletto) il salto del solo saldo soddisfa pure
`rilevaMovimentoEsterno`, che alzava il riferimento per conto suo; chiuderne una non bastava. **LA REGOLA:
il riferimento SCENDE SUBITO, SALE SOLO SU CONFERMA** — candidato → seconda lettura distinta (stessa
costante dello scatto, **importata**) → sale al **minimo delle due**; rientro ⇒ scartato; deposito
assorbito dal massimo mobile invece che dal rilevatore. Unica eccezione dichiarata: la **prima** lettura
in assoluto crea il riferimento senza conferma.
**IL COSTO**: 3,5-3,8% dei 5% di budget mangiati **in permanenza** (PnL a riposo fra −$54,92 e −$59,41 dal
17 al 21/08) · **4 pre-allarmi e 1 SCATTO** (20/08 22:36:02, −$111,77) · ordini cancellati e bot su FERMA
per **6h06m**. **LA MISURA**: la funzione VERA su **8.812 campioni reali** alza il riferimento 3 volte in
6,2 giorni e finisce a **$1.501,63** — lo stesso numero del calcolo indipendente «massimo sostenuto da due
letture». Riferimento $1.550,18 → $1.501,63 · drawdown −$55,39 → **−$6,85** · margine $22,12 → **$68,23** ·
punto di scatto $1.472,67 → $1.426,55. **Replay su 10.711 letture vere (4,01 giorni, non 7: il log parte
dal riavvio del 17/08): 4 pre-allarmi + 1 scatto col vecchio, 0 e 0 col nuovo**, e lo scatto del 20/08 non
avverrebbe (−$63,22 contro −$75,08, margine $11,86).
⚠ **LA SOGLIA NON E' STATA TOCCATA** (5%): il difetto era il riferimento. Le escursioni giornaliere
«misurate a $38» erano in parte lo stesso artefatto — il 19/08 scende da **$38,70 a $1,92** togliendo il
picco a un campione; le vere sono $32,05 e $38,12, contro un margine di $68,23.
⚠ **ALLENTA IL PUNTO DI SCATTO DI $46,12, ED E' IL VERSO VOLUTO**: `tot <= 0,95·rif`, quindi un
riferimento che sale piu' piano puo' solo abbassarlo. Non puo' far scattare PRIMA, per costruzione.
⚠ **RESTA APERTO IL VERSO OPPOSTO, DICHIARATO E NON CORRETTO** (§5.2): lo stesso disallineamento fra le due
fonti produce il transitorio verso il BASSO — il 20/08 22:36 il guardiano leggeva $1.438,41 mentre
l'osservatore, nello stesso minuto, leggeva $1.492,81: **$54,40 di divario**. Vive in `valutaCapitale`, non
nel riferimento.
Prove: `guardian-riferimento-non-supera-il-confermato.test.js` **26/0**, **11 rosse sul sorgente vecchio**,
dove riproduce il valore di produzione ($1.550,17933) dai numeri veri; `guardian-riferimento.test.js`
**32/0** con due blocchi **riscritti non ammorbiditi**. Referto: `data/ricerca/d-d-riparazione-21-agosto.md`.

**201** · D-C · IL FIGLIO DEL PIANO ANDAVA IN OOM: IL LETTORE DEL GIORNALE LEGGEVA TUTTO, DUE VOLTE,
E TENEVA CIO' CHE NESSUNO LEGGE — 21 agosto. `loadJournal` moriva a **924 MB**, 4 cicli su 4 al
giorno **dal 19 agosto**, con ~430 MB liberi. Tre cause MISURATE
(`data/ricerca/d-c-dove-va-la-memoria.json`): ① leggeva **tutti e 7** i file (1.295 MB) e filtrava la
finestra **dopo** aver parsato; ② `readFileSync` + `split('\n')` ⇒ stringa intera **e** array delle
righe in heap insieme, ~566 MB di transitorio sul file da 283 MB; ③ `{ ...r, tsMs }` copiava la riga
INTERA — **887 B/riga** ritenuti. **`no` (45,2%) e `levels` (40,1%) sono l'85,3% del testo e nessun
consumatore di righe di giornale li legge** (le occorrenze di `.levels` nel piano sono tutte su
oggetti CURVA del knapsack). ⚠ **La data non e' un caso**: il 19 agosto `no` entra in servizio (§5.2
p.43) e il file giornaliero passa da ~148 a ~283 MB; l'ultimo piano pesante riuscito e' del **19/08
15:25**. ⚠ **Il repo aveva gia' preso meta' della decisione nel posto sbagliato**: `allocator.js:1407`
fa `r.levels = undefined` — ma DOPO `loadJournal`, cioe' dopo il picco.
**LA CURA, senza alzare nessuna soglia** (alzare `--max-old-space-size` qui sposterebbe l'OOM killer
su agent40/agent41): filtro dei file **per nome** con un giorno di margine · **streaming a chunk da
4 MB** (`StringDecoder`, o un multi-byte a cavallo di due chunk diventa `malformed`, cioe' un dato
perso in silenzio) · **`scartaCampi` OPT-IN**, che COSTRUISCE la copia magra invece di sfoltire
quella grassa. **MISURATO sulla finestra vera di 48 h: 7 file → 4, picco 924 MB → 302 MB, riuscito in
29-33 s su 251.904 righe / 657 mercati.** ⚠ **Nessuno dei due cambi basta da solo**: col solo filtro
sui file va **ancora in OOM** a 650 MB. ⚠ **La corsia del backtest non cambia**: `scartaCampi` assente
⇒ comportamento identico, provato con **145.470 confronti campo-per-campo, 0 divergenze** (§5.2 p.50).
**⚠ NESSUN RIAVVIO, e non per prudenza**: `journal.js` ha un solo importatore, `allocator.js:1380`,
**dentro `planFromCollection`**, cioe' nel FIGLIO che rilegge da disco a ogni giro (§5.3); agent41 non
ha nessun `require` reale dei due moduli — l'unica occorrenza (`:518`) e' **un commento**.
**IL COSTO in 47 ore**: 8 cicli pesanti su 8 falliti · **48,7 h** su un piano vecchio ·
`confrontoDiValore` **mai** misurato · `collector-priority` sceso da **60 a 40** mercati (39 scaduti,
2 freschi), tenuto in vita solo dal **gradino 5 `risveglia-feed`** che lo riscriveva dal piano di due
giorni prima · **il gradino 6 avrebbe messo il bot su FERMA 10 volte in 48 h**. ⚠ Attribuzione
onesta: la scala parte per **capitale al lavoro 17,9%**, che e' strutturale (5 × $61,25 su $1.494); il
contributo dell'OOM e' che il **gradino 1 non puo' riuscire**, quindi la scala arriva ogni volta a 6.
⚠ **Spodestamenti mancati: NON misurabili** — il netto della selezione viene da un figlio diverso e
piccolo che non va in OOM, e la rotazione infatti ha continuato.
Prove: `scripts/rewards-replay/lib/journal-memoria.test.js` **11/0**, che misura il picco REALE
(`VmHWM`) di un figlio con l'heap capato e **cade sul sorgente vecchio** (5/2, il figlio non
sopravvive). Referto: `data/ricerca/d-c-riparazione-21-agosto.md`.

**200** · D-A · LA SELEZIONE ORDINAVA CON UNA CIFRA DA MOSTRARE — 21 agosto. `agent41:1357` costruiva
la mappa dei netti da `bestNetPerDay`, che `net-per-day.js:80` **annulla** senza fill osservati
(`nessun-fill-osservato`): un mercato mai quotato non ha fill, quindi non ha netto, e
`spodestaAbbastanza` rifiuta un netto `null`. **Non una soglia: una maschera di visualizzazione usata
come ingresso di una decisione.** Ora si usa `bestObiettivoPerDay` con ripiego su `bestNetPerDay` —
la forma IDENTICA gia' adottata l'8 agosto in `collector-priority.js:185`, non una seconda forma.
**MISURATO col runner VERO sul board del 21/08**: classificabili **9 → 22** su 22 ammissibili; i 13 che
si sbloccano hanno tutti `nessun-fill-osservato`; sui 9 in comune il divario e' **0 su 9** — non cambia
un valore, toglie una maschera. **⚠ IL FILL OSSERVATO NON SI PERDE**: `bestObiettivoPerDay` E'
`best.net5m`, cioe' lordo meno il costo di adverse selection misurato (`net.js:93`: zero fill ⇒ costo
zero KNOWN), e quattro occupanti su cinque stanno infatti a netto NEGATIVO. **⚠ LA SIMULAZIONE A SECCO DAVA ZERO SPODESTAMENTI, E IN
PRODUZIONE NE E' AVVENUTO UNO IN CINQUE MINUTI — con 2 ordini veri cancellati.** Non un errore di
metodo: **il board si e' mosso** (24 ammissibili alle 15:0x, 35 alle 15:33) e lo sfidante vincente
non esisteva al momento della simulazione. **Una simulazione a secco su un board vivo scade col
board.** Lo scambio e' quello voluto — occupante a **−$0,0627/g** sostituito da uno a **+$3,6558/g** —
e la regola che cancella e' preesistente (`selezione-mercati.js:992`: si spodesta un occupante con
ordini vivi SOLO se il suo netto e' negativo e quello dello sfidante positivo). Posizioni zero ⇒
nessuna gamba nuda. Verificato che la correzione sia la causa: lo sfidante aveva
`bestNetPerDay: null` / `nessun-fill-osservato`, quindi prima era invisibile.
**Stato dopo: 10 ordini su 5 mercati, 5 coppie su 5 SIMMETRICHE, posizioni 0, equity invariata.**
⚠ La selezione NON era ferma del tutto: 12 spodestamenti nelle 24 h precedenti, fra i mercati CON
storico. Congelata era la **candidatura di chi non ne ha**, oggi 13 su 22.
Prove: `lib/maker/selezione-ordina-a-priori.test.js` **15/0**, che fa girare `decidiSelezione` VERA e
**fallisce sul criterio vecchio** (asserzione ②) e sul **sorgente** vecchio (blocco ⑥, commenti
filtrati). Referto: `data/ricerca/d-a-riparazione-21-agosto.md`.
⚠ Scrivendo il test sono cadute due trappole, entrambe prese dal test e non dalla rilettura: con
`max: 1` lo `slotCorti` vale 0 ⇒ la coda lunga ha budget 0 e ogni candidato oltre 7 giorni finisce in
`scartatiPerCodaLungaSottoPavimento`; e a `max: 1` il secchio unico si chiama **`alto`**, quindi uno
`scaglione` stantio nello stato blocca lo scambio in silenzio (§5.2 p.51).

**199** · D1 · L'ULTIMA COPIA: LA STIMA REALISTICA DIVIDEVA PER IL MID — 21 agosto.
`realistic-estimate.js:269` faceva `(C/2)/mid`, la forma che l'intestazione di `size-da-capitale`
dichiara SBAGLIATA da 1'12 agosto. Corretta in `C / (1 − 2d)`.
**⚠ IL `/2` NON ERA UNA CONVENZIONE DEL CHIAMANTE**, ed e' la differenza col gemello di stamattina: in
`reward-price-row` era il CHIAMANTE a dimezzare e la correzione andava fatta li'; qui `capitalUsd` e'
gia' il TOTALE (`allocate.js:167`, `capital: 2 * sizeUsd`) e il `/2` era interno alla formula sbagliata,
quindi sparisce con lei. **Nessun chiamante toccato**, e un blocco del test lo verifica invece di
prometterlo.
**LE DUE META' DELLA CATENA ORA CONCORDANO AL BIT**: obiettivo `curve.shareForCapital(..., pairCostUsd)`
e stima `sharePerLato(capitale, pairCost)` danno la stessa size, divario 0 o 7,11·10⁻¹⁵.
**⚠ `1 − 2d` VIVE ADESSO IN UN POSTO SOLO**: `size-da-capitale.costoCoppiaAllaDistanza`, importata da
`realistic-estimate` e da `rewardScore` (che ci ha rinunciato alla propria copia scritta ieri). Restava
una terza copia in `allocate.js:387` (`pairCostForMarket`): **non toccata**, e' la corsia del backtest,
dichiarata in §5.2 p.50.
**⚠ NESSUN RIAVVIO, E NON PER PRUDENZA**: il piano nasce in un **processo figlio** che rilegge il codice
da disco (§5.3), quindi la correzione e' entrata in servizio da sola. I quattro agent vivi caricano
`rewardScore` e `size-da-capitale` in memoria, ma la modifica al primo e' numericamente identica
(delega alla SSOT) e al secondo e' **solo additiva**: comportamento in-process invariato. **Nessun
ordine e' diventato PRE-ESISTENTE.**
Prove: `stima-realistica-denominatore.test.js` **20/20**, rosso sul sorgente di ieri sull'asserzione ①.
Suite **231 verdi / 7 rossi**, gli **stessi 7** di prima e non otto. `rewards-realistic-estimate-selfcheck`
47/47.

**198** · D1 · IL PUNTEGGIO DIVIDEVA IL CAPITALE PER IL MID, NON PER IL COSTO DELLA COPPIA — 21 agosto.
`lib/rewardScore.js` convertiva capitale→share con `capital/mid` mentre il piazzamento usa
`size-da-capitale.sharePerLato` (`capital/pairCost`): due formule per la stessa domanda, ultima copia
sopravvissuta della famiglia che §5-bis aveva gia' chiuso in `minSizeVerdict` e in `net.js`.
**Il denominatore giusto viene dal VENUE, non dalla simmetria col piazzamento**: il venue scora SHARE,
e una posa bilaterale simmetrica a `s` centesimi costa `(mid − s/100) + (1 − mid − s/100) = 1 − 2s/100`
per share — **il mid si cancella**. `capital/mid` e' la size di una posa UNILATERALE: finanzia un lato
e ne scora due, e su un mid fuori da [0,10 · 0,90] quella posa varrebbe ZERO — cioe' l'errore era
massimo (**9,56×** misurato su «1 Fed rate cut», mid 0,095) esattamente dove la posa non prenderebbe
niente. Fattori sui 4 mercati a libro: **9,56× · 8,10× · 1,92× · 1,10×**; la stima viva passava da
**$1,3389/g** a un valore coerente con la formula del venue sul book vero (**$0,0907/g**).
**TRE RIGHE, UNA CATENA SOLA, E VANNO INSIEME**: `estimateCapitalLevelRange` (produce `levels`),
`recoverCompetitorQ` (ne e' l'**inversa algebrica** — correggerne una sola falserebbe `competitorQ` in
silenzio) e `quadraticUserShare` (produce `refShare`, cioe' il «$/giorno» del pannello, via
`rewards-normalize:137`). ⚠ **`competitorQ` era ed e' rimasto CORRETTO**: l'errore si cancella nel giro
andata-ritorno, e infatti coincideva con la misura indipendente sul book (0-4%).
⚠ **`capital` ORA E' IL TOTALE delle due gambe, non un budget per lato**: con la coppia «per lato» non
e' esprimibile (le due gambe devono portare la stessa size). Corretto l'unico chiamante che dimezzava,
`reward-price-row.js` — continuare a dimezzare avrebbe sottostimato di **esattamente 2×**.
⚠ **LA CLASSIFICA NON CAMBIA, E NON PERCHE' I NUMERI SIANO UGUALI**: la selezione ordina col
**netto-knapsack iniettato** e usa `punteggio()` (il numero corretto qui) solo come **ripiego
dichiarato** per i candidati senza netto, che `ordinaCandidati` mette comunque **dopo** tutti quelli
col netto. Misurato con la funzione vera: ordine **identico** col netto, **diverso** senza.
⚠⚠ **E LO SPODESTAMENTO NON LEGGE AFFATTO QUESTO NUMERO**: il blocco 3-bis e' dentro
`if (nettoPerMercato && ordiniLeggibili)` e passa solo da `nettoDi()`. **Quindi la correzione non puo'
cancellare nessun ordine gia' a libro** — l'unica superficie che cancella e' lo spodestamento.
Prove: `lib/rewardScore-denominatore.test.js` **17/17**, rosso sul sorgente di ieri sull'asserzione ①
(«a parita' di tutto il resto il mid non cambia il punteggio»: 0,3333 contro 0,0476). Suite **230
verdi / 7 rossi**, e i 7 sono rossi **anche prima** della modifica, verificato uno per uno.

**197** · IL BANCO VERIFICA TUTTE E DIECI LE REGOLE CONCORDATE — 18 agosto, `176c5a5`. Sei passi nuovi
(18-23), uno per ogni regola che non aveva prova o che era coperta di sponda: **26 passi su 26**, 0
annotati. ⚠ Il passo 23 e' caduto alla prima corsa e il codice era GIUSTO: il predicato guardava
`uscenti`, ma un occupante spodestato finisce in `spodestati`/`liberati` — `uscenti` sono quelli che
escono da soli, gli spodestati sono cacciati. L'errore cadeva nella direzione giusta.

**196** · R4 · L'EROSIONE DELLA PROFONDITA' DAVANTI TOGLIE L'ORDINE DAL LIBRO — 18 agosto, `1b8b34c`.
Regola per intero in **§4.1-bis**. `book-erosion` era cablato solo in `mm-tracking`, motore senza un
mercato configurato. ⚠ Senza il registro su disco (`sospensione-erosione.js`) la regola non esisterebbe:
`ripristinaGamba` parte SUBITO e avrebbe rimesso a libro entro 120 s. ⚠ Scrivendo il test ho sbagliato
DUE volte la firma di `decideReprice` (`deps` e' il secondo argomento posizionale, la manopola si chiama
`config`) e in entrambi i casi il trigger veniva saltato **in silenzio col test verde**: §5.3.
Prove: `sospensione-erosione` 32/0, `erosione-scatta` 39/0 (cade 7 volte senza il TRIGGER 4).

**195** · R1 · QUANTI MERCATI VIENE DALL'AMBIENTE, E LA COMPOSIZIONE LO DERIVA — 18 agosto, `0ac9bd1`.
Regola in §4.13. Il 3 era cablato **due volte** — `MAX_MERCATI_CONTEMPORANEI` e i tre posti di
`QUOTA_SCAGLIONI` — e agent41 non passava nemmeno `max`. ⚠ E il soffitto era ACCIDENTALE: `max: 10`
faceva entrare 3 solo perche' la tabella aveva tre posti; ora il clamp e' esplicito, e `quanti-mercati`
**importa** la costante invece di riscriverla. Prove: `quanti-mercati` 20/0, `selezione-mercati` 104/0.

**194** · R10 · IL KILL A −$100 CHIUDE ANCHE LE POSIZIONI — 18 agosto, `5d86bd1` + `bb6d19c`. Regola in
§3. Chi decide (agent43) non esegue, chi esegue (agent41) non decide. ⚠ IL DIFETTO TROVATO COLLEGANDOLA:
il presidio dei 60 minuti — «l'ultima rete» — sta dietro `botAttivo()`, cioe' **non gira a bot FERMO**,
che e' lo stato che il kill produce. ⚠ E il test del cablaggio ha preso un difetto che il selfcheck non
vedeva (chiave della mappa dei minimi sensibile al maiuscolo). ⚠ E `kill-perdita-giornaliera.test.js`
scriveva nel `data/` di **produzione**: percorso reso iniettabile, e ora c'e' l'asserzione su *dove non*
ha scritto. Prove: `chiusura-di-emergenza` 24/0, `kill-chiude-le-posizioni` 27/0.

**193** · R6 · IL RESIDUO SOTTO IL MINIMO SI CHIUDE — 18 agosto, `1131841`. Il presidio dei 60 minuti lo
TENEVA con un motivo vero fino al 17 e falso dal 18: reperto **D7** nella forma peggiore, un commento
invecchiato che tiene fermo capitale. Il limite «non spendere per uscire piu' di quanto valga» su una
VENDITA equivale a `ricavo >= 0`, quindi morde in un caso solo — ricavo NULLO — e quel caso ora si
rifiuta. ⚠ NON implementata la meta' che morderebbe davvero (comprare oltre 101¢ per sbloccare col
merge): non esiste un percorso che compri sopra il tetto, e inventarlo sarebbe un meccanismo nuovo.

**192** · R7 e R8 · LA CONCESSIONE E' IL 5%, E LA COPPIA COMPLETA SI FONDE PRIMA DELLE GUARDIE SUL
PREZZO — 18 agosto, `93fa78b` + `759c09f`. Regole in §4.6. R7 **allarga un limite di rischio** ($3,06
contro $0,63) ed e' una decisione dell'operatore. R8 e' monotono: si tolgono due rifiuti, non si aggiunge
un acquisto. Prove: `urgenza-scoperto` 27/27, `scoperto-oltre-soglia` 38/0, `uscita-arriva-a-esecuzione`
23/0 (dove si vede la differenza: il pavimento passa da 53¢ a 51,3¢ e l'uscita ARRIVA al bid),
`strategia-merge` 52/0 (cade 5 volte sul sorgente di ieri).

**191** · LE CINTURE DA CINQUE A QUATTRO, E LE QUATTRO MORDONO — 17 agosto, decisione dell'operatore.
Regola per intero in **§4.14**. `MAKER_PLACEMENT` tolta (nessun chiamante); `MAKER_MODE` e
`MAKER_ADAPTER_DRYRUN` passate a `buildPlacementAdapter` e lette da `cinture-armamento` — non piu' uno
specchio da confrontare ma **la** lettura, usata per raccontare lo stato e per deciderlo. Prova:
`prova-cinture.js` **10/0**, ognuna inserita DA SOLA col CONTROLLO che parte. ⚠ E il banco era piu'
permissivo del venue: il suo adapter cablava modo/dryRun/placement ignorando gli `opts`.

**190** · IL PASSO 13 SCEGLIEVA IL SOGGETTO DALLO STATO — 17 agosto, `adc57a5`. Ora se lo COSTRUISCE e lo
apre da `giro()` + `controlloCapitaleFermo()`: servono entrambi, perche' `ripristinaGamba` pretende una
riga nel piano SALVATO e quel file lo scrive solo il ciclo pesante. Determinismo 10/10, e **identico su
due snapshot diversi di `data/`** dopo aver aggiunto `maker-allocated-capital.json` ai file azzerati dal
passo 1 — l'unica memoria di un piano precedente a sopravvivere all'«accensione da zero».

**189** · I FILE DI SERVIZIO IN `/tmp` ERANO DI `root`, E I LETTORI NON SE NE ACCORGEVANO — 17 agosto.
`/tmp` e' condiviso e ha lo sticky bit: dopo la migrazione l'utente nuovo non poteva ne' riscrivere ne'
cancellare i nove file di ieri. Gli scrittori prendevano EACCES **e i lettori continuavano a leggere la
copia vecchia, che da quel momento non invecchiava piu'** — un prezzo di quaranta minuti prima
presentato come di adesso. Cura: `lib/percorsi-runtime.js`, directory **per utente**, una definizione al
posto di ~40 letterali in 23 file. Il guasto non e' riparato: e' reso **inesprimibile**. Piu'
`lib/safety/percorsi-critici.js`, chiamato dai nove agent che scrivono: su percorso inutilizzabile
stderr + exit 1 invece di degradare in silenzio (test 15/0, che costruisce ogni guasto e lo rimette a posto).

**188** · LA MIGRAZIONE DA `root` A `bot`: DODICI PERCORSI CABLATI, E NESSUNO FALLIVA RUMOROSAMENTE —
17 agosto 2026, `57de3e8` + `abed26d`. Il repo e' in `/home/bot/bot`, l'utente e' `bot`, `/root` non e'
leggibile. I dodici: **11 `cwd` + 11 `HOME`** in `ecosystem.config.js` · `rewards-normalize` e il suo
**gemello scrittore** `agent24.OUTPUT_FILE` · `agent34` watchlist/mid-history/trade-tape · `agent45` ·
il RUNNER dell'allocatore · `rewards-selfcheck` · e il **`VIVO` del banco**, dove il guasto era peggiore:
`diff` su una directory illeggibile esce **2**, il `catch` prendeva `e.stdout` vuoto e leggeva zero
differenze — **il cancello dell'identita' del codice si APRIVA**. La regola generale e' in §5.3.
**E LA POLICY DEI PERMESSI ERA LA PARTE PEGGIORE**: l'hook `PreToolUse` puntava a `/root/...` ⇒ **non
girava piu'**; le 7 regole `Edit(//root/...)` non corrispondevano a niente, cioe' `.env`,
`ecosystem.config.js` e i sei flag di stato erano modificabili **senza `ask`**. Rimessi: hook su
`$CLAUDE_PROJECT_DIR`, 164 `ask` in entrambe le copie. **Due rossi noti diventano verdi** e nessuno dei
due era un difetto del codice (`hook-piazzamento` 70/0, `policy-permessi` 84/0).

**187** · I RESIDUI SOTTO IL MINIMO: LA VIA D'USCITA ESISTE GIA' — 17 agosto. Caso peggiore **$46,79**
su un mercato, **bloccato adesso $3,00**. Si conta su UN LATO SOLO: un residuo su entrambi i lati e' una
coppia parziale, e il **merge on-chain non ha minimi di size**. L'uscita non passa dal libro — il
**riscatto on-chain** (p.131, cablato) — quindi il costo non e' il capitale ma il **tempo** fino alla
risoluzione. ⚠ Da R6 (18 agosto) il residuo si **chiude** anche dal libro: v. §4.6.

**186** · OLTRE 7 GIORNI NON C'E' NIENTE DA QUOTARE A $147 — sola misura, 17 agosto. 5 candidabili su
145, tutti a lordo **$0,00/g** contro 3.846-147.564 share altrui ⇒ netto negativo. Il valore sta a **~1,3
giorni**: 11 dei 31 ammissibili in positivo, il migliore **$60/g** con concorrenza zero. ⚠ Il primo conto
filtrava su `candidate.horizon`, `undefined` per 31 righe: un `Number(null)` travestito da misura.

**185** · DELLE CINQUE CINTURE NE MORDE UNA — 17 agosto 2026, sera tardi. Regola per intero in **§4.14**;
la sequenza di armamento che ne consegue e' in `APERTI.md`. Trovata preparando quella sequenza, non da un
guasto: `createMakerAdapter` ha un solo chiamante, che cabla `mode:'live-min'` e non passa `dryRun`.

**184** · `stato.js` LEGGE LE CINTURE DAI PROCESSI VIVI, E LO SPECCHIO E' PROVATO — 17 agosto sera.
`lib/maker/cinture-armamento.js` (puro) risponde per un ambiente qualunque; `stato.js` gli passa
`/proc/<pid>/environ`. Due delle cinque sono **importate**, le altre tre sono uno specchio dell'adapter — e
il test (24 asserzioni, adapter VERO) ha trovato **due divergenze mie nella direzione che costa**:
normalizzavo `MAKER_MODE`/`MAKER_ADAPTER_DRYRUN`, mentre `config` confronta i valori **esatti**. Uno
specchio deve essere esatto, non ragionevole. ⚠ `puoPiazzare` dice che le cinque sono aperte, non che
l'ordine passerebbe (`evaluatePlacementGate` ha anche gate che non sono cinture).

**183** · IL CARICO DI RIPIEGO ARRIVA AL SECONDO LIVELLO — 17 agosto. `deps.ultimoNostroPrezzo` non era
cablata: **settima** occorrenza di §5.3. Ora il prezzo viene dal **giornale** e non dalla memoria di
processo; contano solo gli invii accettati e solo i BUY (`manual-replace` ha ricevuto `side`).

**182** · IL PASSO 13: DUE FUNZIONI DIMENSIONAVANO LA STESSA COPPIA IN DUE ISTANTI DIVERSI — 17 agosto
sera. Regola per intero in §4.13; `coppia-simmetrica.js` puro, 30 asserzioni + 21 sul cablaggio.
⚠ **La diagnosi precedente («il riprezzo ricalcola la size») era sbagliata**: chi riapre non la rifaccia.
⚠ Il conteggio del banco scende da 22+17 a **21+16**: meno rifiuti da esercitare, non meno copertura.

**181** · TRE DIFESE ERANO INERTI, E LE HA TROVATE IL BANCO — 17 agosto, `e3dcfb0`. Il kill a −$100 leggeva
`lim.maxDailyLossUsd` invece di `{ok, limits:{…}}`; il rilascio per scadenza leggeva `p.ids` invece di
`conditionIds`; `BOARD_NORMALIZZATO` era l'ultimo letterale su cinque lettori. **Tutte e tre coperte da
test verdi**, perche' iniettavano fixture di forma INVENTATA: provavano la decisione, non il cablaggio.

**180** · IL GIRO COMPLETO, DETERMINISTICO — 17 agosto, `1b7a4e7`+`e3dcfb0`. Le fonti di caso erano quattro
(`Date.now`, `new Date()` argless, `Math.random`, lo stato del riprezzo fra le corse).

**179** · IL BANCO CHIAMA `closeTask()` E `giro()`: IL «37 SU 91» ERA UNA COPIA — 17 agosto, `226471b`.

**178** · IL KILL A −$100 CANCELLA: SECONDO INGRESSO DEL GUARDIANO — 17 agosto, `e838c82`. Una sola azione
(`spazzaEFerma`), due ingressi; fail-closed al contrario (perdita non leggibile ⇒ NON si cancella).

**177** · IL PIANO SALVATO NON SOPRAVVIVE A UN CAMBIO DI SELEZIONE, E LA SCADENZA TOGLIE DAL PERIMETRO —
17 agosto, `3e9b549`. `righeAmmesse` (una funzione per entrambe le fonti) e `scadenzeFuoriPerimetro`.

**176** · IL RESIDUO SU FILL PARZIALE SI CANCELLA SEMPRE E SUBITO — 17 agosto, `3eccec2`. Regola in §4.6;
la condizione precedente era una tautologia e la guardia vera era «solo il primo giro».

**175** · IL PERNO `MAKER_LIVE_MIN_MARKET` RESTRINGE INVECE DI AGGIUNGERE — 17 agosto. Regola in §4.8; tre
copie della stessa aritmetica ridotte a `adapter.perimetroLiveMin`. Monotonia esaustiva su 80 combinazioni.

**174** · I DUE PRESIDI DI agent40 NON DIPENDONO PIU' DAGLI AVANZI — 17 agosto. `VENUE.azzera()` + ricarica
da `require.cache`: la memoria di modulo era il terzo avanzo, e `nostriInvii` di una fase precedente
SPEGNEVA l'allarme. Le tre verifiche sanno cadere, provato su copie.

**173** · LE SEI FIXTURE DEL BANCO, PROVATE PER SOTTRAZIONE — 17 agosto. **18 delle 20 regole statiche** si
spegnevano per UNA sola fixture, e tutte e 17 le dinamiche. Nessuna delle 60 rosse ne era vittima.

**172** · COSA E' SUCCESSO ALLE GAMBE IL 16 AGOSTO — sola misura. 377 ordini, 8 mercati, 133 cadute da due
gambe a una, **copertura piena 50,0 %**. ⚠ 111 cadute durano 3,4 s (il riprezzo); le **22 lunghe valgono il
97,8 % dei minuti** e 17 non sono mai tornate. Referto `data/ricerca/gambe-16-agosto.md`.

**171** · LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO, CON UN RAFFREDDAMENTO — 17 agosto. Regola in
§4.13; `riconciliaCopertura` dichiarava e non agiva. Il numero che governa il disegno e' **720** (i cicli
al giorno): contenimento provato, 50 tentativi su 720, fattore 14,4x.

**170** · I SETTE TEST ROSSI, PIU' UNO, PIU' TRE SELFCHECK — 17 agosto (da 19 rossi a 12)

**169** · LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — 17 agosto. Regola in §4.6. 283
campioni su 354 minuti: ZERO istanti offrivano un'uscita in guadagno; il «guadagno» era la differenza fra
mid e bid. Un take-profit esisteva gia' (`marketAhead`) e non ha mai incassato niente.

**24 · 23 · 22 · 20** · le quattro misure chiuse del 13 agosto — diagnosi in `git log` e `data/ricerca/`.

**27** · I 5 SELFCHECK DI `scripts/` RIMESSI IN SCALA — 15 agosto (rifatto il 17: v. p.170)

**21** · IL PAVIMENTO DI PROFONDITÀ NON SI APPLICA PIÙ AI RINNOVI — 16 agosto, `63c10a0`. ⚠ Misura del
17: **2.100 blocchi**, tutti fra le 11:00 e le 15:59 e **zero dopo le 16:00**, cioè dopo il commit.
Costo: **65,0 minuti** di gamba singola.

**168** · IL TETTO DI ESPOSIZIONE ESENTA LE CHIUSURE PROVATE, E SCENDE A $150 — 16 agosto 2026

**167** · SELEZIONE A TRE, PER COMPOSIZIONE, CON ROTAZIONE — decisione dell'operatore, 16 agosto 2026

**166** · FILL PARZIALE: IL RESIDUO NON SI CANCELLA ALL'INGRESSO, MA ALLA COPPIA — 16 agosto 2026

**165** · UN SOLO TETTO DI COPPIA, 101¢, E LA RESA A 60 MINUTI — decisione dell'operatore, 16 agosto 2026

**164** · IL TETTO PER ORDINE ERA «METÀ MERCATO» E RIFIUTAVA LA GAMBA CARA ($35,63 → $65,63, causa a
monte di `coppia-non-atomica`); IL BORDO DELLA BANDA ERA NUDO (`bordiConMargine`, `max(1 tick, 0,22·v)`,
Schmitt trigger, tetto a metà banda) — 16 agosto 2026. **Le due regole per intero in §4.2 e §4.1**;
`distanza-obiettivo.test.js` blocco ③-bis, 58 asserzioni.

**163** · GLI «EFFICIENTI» DENTRO I 65: CAPITALE PICCOLO E TRADING IN PARI — ricerca, 15 agosto

**162** · COME ESCONO I 65 DOPO UN FILL — ricerca, 15 agosto

**161** · CHI FA DAVVERO LIQUIDITY REWARDS, E DOVE QUOTA — ricerca, 15 agosto

**160** · LA MANOPOLA DELLA DISTANZA ACCESA A 0,444 — TEST DELL'OPERATORE, 13 agosto 2026, sera

**159** · IL GRADINO 6 DISARMATO PER CONFIGURAZIONE — decisione dell'operatore, 13 agosto 2026, sera

**158** · LA MANOPOLA DELLA POSIZIONE, INSTALLATA E SPENTA

**157** · IL RIFERIMENTO DEL GUARDIANO: DRAWDOWN DA MASSIMO MOBILE

**156** · IL TETTO PER MERCATO PASSA A $61,25, E SMETTE DI DERIVARE DA `f_min`

**155** · LA BANDA PREMIANTE ERA LARGA LA METÀ — `v = max_spread`, NON `max_spread/2`

**154** · IL FILTRO DI PROFONDITÀ NON STA AFFAMANDO IL PIANO — misura, niente toccato

### Le tre voci del 13 agosto 2026

**120** · IL DEADLOCK ARITMETICO CHE HA FERMATO IL BOT PER TRE ORE

**121** · LA SENTINELLA SUL VUOTO

**122** · UNA POSIZIONE SENZA SCADENZA È UNA POSIZIONE CHE NESSUNO CHIUDERÀ

**123** · I RESIDUI SOTTO IL MINIMO — chiuso da §5-bis p.187 e da R6

**138** · LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — ⚠ **la diagnosi era sbagliata**, corretta il 16
agosto: l'orologio NON si azzerava. Le due cause vere sono in §4.6: chi riapre non rifaccia la diagnosi.

**152** · IL BORDO DELLA BANDA NON CONVIENE — ⚠ numeri corretti da p.155

**151** · IL REDEEM È UNA VIEW, NON GESTIONE DEL RESIDUO — corregge §150

**150** · COSA FANNO GLI ALTRI DOPO UN FILL — sola ricerca

**149** · CHI INCASSA DAVVERO I REWARD — ricerca, 30 giorni on-chain

**147** · L'ESENZIONE DAL TETTO PER ORDINE VALE SU TUTTI I PERCORSI CHE RIDUCONO

**148** · IL REGISTRO DEI RESIDUI HA FINALMENTE UN CONSUMATORE

**145** · LE DUE CONFERME DEVONO ESSERE DUE OSSERVAZIONI, NON DUE COPIE

**146** · I RESIDUI BLOCCATI, MISURATI — diagnosi

**144** · L'OSSERVATORE MUTO (agent45)

**141** · IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA (k=2)

**142** · LA SENTINELLA SUL COLLASSO DELLA COPERTURA (85%), SOLO OSSERVA

**143** · LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA

**140** · LA SOGLIA SULLA DERIVATA È 85%, E IL DIVARIO FRA LE DUE POPOLAZIONI È VUOTO — sola misura

**139** · IL SECONDO SCATTO DEL GUARDIANO — 13 agosto 2026, 09:08:33Z

### Le voci del 13 agosto 2026, sera

**124** · IL CAPITALE AL LAVORO DICEVA L'INTENZIONE

**125** · RIFIUTI RIPETUTI: RICONOSCERE E REAGIRE

**126** · COERENZA FRA I MODULI

**127** · SCALA DI SBLOCCO E AUTODIAGNOSI

**128** · RESIDUI SOTTO SOGLIA: NON SI PUÒ IMPEDIRE CHE NASCANO — con i numeri

**129** · IL FILTRO ORIZZONTE COSTA 5,4× E NON PROTEGGE DA CIÒ CHE DICHIARA — misurato

### Le classi di difetto che si ripetono — leggerle prima di scrivere codice qui

| classe | quante volte | forma |
|---|---|---|
| `Number(null) === 0` | **6** | «non ho letto» diventa «non c'è», e il ramo sbagliato parte |
| costante ricopiata invece che importata (rilevatore **D1**) | 5+ | due numeri per lo stesso concetto che divergono in silenzio |
| protezione presente su un percorso e assente su un gemello | 5+ | `already-covered`/`close-at-market`/`skip`, i quattro punti della copertura |
| dep non cablata ⇒ valore di difetto che nessuno ha chiesto | 4 | `readDepth`, `signerProvider`, `{file}`, `deps.stato` con `\|\|` |
| commento che descrive un comportamento inesistente (**D7**) | 4+ | il commento è ciò che si legge, il codice ciò che accade |
| test che fotografa il codice invece della proprietà | 3 | verde in lavorazione, rosso dopo il commit, senza nessun difetto |
| filtro a monte che svuota l'eccezione scritta a valle | 2 | «l'eccezione è scritta?» ≠ «la riga arriva fin qui?» |

### Registro completo delle voci 1-119

Solo numero e titolo: serve a risolvere «§5 punto N», il resto è in `git log`.

**1** Il bot non è mai stato avviato  
**2** La copertura dichiarata di FERMA non corrisponde al runtime di agent35  
**3** `REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41  
**4** L'header di `lib/maker/strategia-merge.js` è invecchiato  
**5** Arming disarmato da un kill ormai revocato  
**6** `data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da `.gitignore`  
**7** Il codice della sera del 7 agosto non è attivo  
**8** `pgrep -f <nome-processo>` non è affidabile in questa sessione  
**9** Il codice dell'8 agosto non è nei processi  
**10** L'obiettivo non sente il tetto di credibilità  
**11** Il confronto non ha ancora un dato  
**12** I cinque test rossi: diagnosi fatta, correzione da decidere  
**13** Il caso degenere della concorrenza misurata ZERO  
**14** Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte  
**15** La rinomina non è ancora in pm2  
**16** `agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata  
**17** Il trigger a capitale fermo non è nel processo  
**18** La correzione del consumo di agent40 è in `main` ma non nel processo  
**19** IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre  
**20** L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano  
**21** Il trigger a $50 non ha MAI funzionato  
**22** Tre cose che il fix ha scoperto  
**23** Il tetto di orizzonte non basta: l'universo eleggibile è zero  
**24** IL 10 AGOSTO ALLE 01:01:33Z IL RESET CANCELLA TUTTO, se il board non è aggiornato per allora  
**25** La misura che ha fatto scattare tutto, tenuta come riferimento  
**26** DUE POSIZIONI APERTE SENZA VIA D'USCITA  
**27** I Livelli 1 e 2 non sono mai stati raggiunti  
**28** IL RIAVVIO DI agent40 ARMA UN COMPORTAMENTO NUOVO SU CAPITALE REALE  
**29** IL LIVELLO 1 (TAKER) NON PUÒ ESEGUIRE, ed è una protezione che NON è stata toccata  
**30** Verifica del gate fatta per test unitario, non sui dati vivi  
**31** I DUE MERCATI CON POSIZIONE APERTA SONO TORNATI NELLA ALLOWLIST  
**32** SCHWARTZEL NON COMPLETA LA COPPIA: `closeTask` NON INIETTA `cancelOrder`  
**33** La stessa guardia, un ramo più in là: `null` non è una cancellazione riuscita  
**34** TRE RIAVVII PENDENTI  
**35** Il 75,9% e non il 90%: il target non si raggiunge sempre, ed è il punto  
**36** `REALLOC_PIANO_LEGGERO_ORE` è il primo parametro che governa quanta memoria consuma un figlio  
**37** LA RICERCA SULLE CATEGORIE È FATTA, E RIBALTA LA LETTURA OVVIA  
**38** LE OTTO FASI DELL'8 AGOSTO SERA  
**39** QUATTRO RIAVVII PENDENTI per le otto fasi  
**40** I ROSSI NOTI SONO SCESI DA QUATTRO A TRE  
**41** IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE  
**42** UNA GAMBA CANCELLATA BRUCIAVA LA SUA CHIAVE PER SEMPRE  
**43** IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO  
**44** UN MERCATO CHE ESCE DAL BOARD PERDEVA LA GESTIONE  
**45** IL MERGE ON-CHAIN È COLLEGATO AL FLUSSO  
**46** IL PERIODO DEL BOARD ERA 22,5 MINUTI, NON 15  
**47** IL RIPIEGO DELLE REGOLE COPRIVA UN PERCORSO SU DUE  
**48** LO SPLIT NON VA COLLEGATO, E LA MISURA È NETTA  
**49** `CTF_RELAYER_ENABLED = true`  
**51** LA SEQUENZA COMPLETA DEL LATO SCOPERTO  
**52** IL MERGE ON-CHAIN NON HA MAI FIRMATO: `deps.signerProvider` NON ERA CABLATO  
**53** I TETTI DI CAPITALE ERANO FERMI AL CAPITALE DI TRE ORE PRIMA, E IL 90% ERA IRRAGGIUNGIBILE PER COSTRUZIONE  
**54** LA REGOLA GENERALE DEL LATO SCOPERTO  
**55** IL TETTO DELLA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA  
**56** IL LIVELLO 3 USCIVA IN SILENZIO  
**57** CINQUE MERCATI FINTI NEI DATI VIVI  
**58** 🔴 IL CAPITALE ERA CONTATO DUE VOLTE  
**59** ⚠️ L'UNICA ECCEZIONE A «MAI PRIMI SUL LIBRO»  
**60** «PRIMO ASSOLUTO» SI MISURA SUL LIBRO, NON SULLA BANDA  
**61** IL BOT NON VEDEVA IL LIBRO DEI MERCATI IN CUI AVEVA DEI SOLDI  
**62** VISTI MA INTOCCABILI  
**63** 🧹 MAKER ARMING, agent35-maker E agent37-maker-watchdog SONO STATI RIMOSSI  
**64** IL TETTO DI CREDIBILITÀ ERA UN'ATTENUAZIONE E ORA È ANCHE UN CANCELLO  
**65** TETTO PER MERCATO FISSO A $130 E NESSUN LIMITE DI POSIZIONI  
**66** LA RISPOSTA AL FILL: QUATTRO CORREZIONI, E IL CABLAGGIO CHE LE RENDE EFFETTIVE  
**67** IL QUARTO PUNTO DEL TETTO: $25 PER ORDINE CONTRO $130 PER MERCATO  
**68** LA GAMBA ORFANA VENIVA RINNOVATA ALL'INFINITO  
**69** IL GATE live-min LEGGEVA LA LISTA STRETTA: L'UNIONE DEL PUNTO 62 NON ARRIVAVA AL PIAZZAMENTO  
**70** IL GUARDIANO DELLE PERDITE È SCATTATO  
**71** IL REGISTRO DA 731 MB: LETTURA INCREMENTALE SU TUTTI I PUNTI NOTI  
**72** UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO  
**73** IL RIPREZZO È DIVENTATO ATOMICO NEL SENSO CHE CONTA: NON CANCELLA CIÒ CHE NON PUÒ RIPIAZZARE  
**74** VERIFICA COMPLETA E RIAVVIO PULITO DELLA FLOTTA  
**75** I DUE LAVORI DELL'11 AGOSTO SERA, MAI DOCUMENTATI FIN QUI  
**76** IL TETTO PER ORDINE NON RIGUARDA CHI CHIUDE, E UN TAKER NON MIRA AI PROPRI ORDINI  
**77** LA CHIUSURA RIPROVA, LA SORELLA CRESCE, E UN MERCATO MORTO NON RESTA IN SEI REGISTRI  
**78** IL PANNELLO NON DICHIARAVA I PROPRI ORDINI, E LA SELEZIONE ERA SCRITTA A MANO IN DUE PUNTI  
**79** `clobRewards` ASSENTE NON È `clobRewards` A ZERO  
**80** `inCoda` E `priceAdjusted` ARRIVANO IN `execution-audit` E SUL PANNELLO  
**81** IL LATCH DEL GUARDIANO SCADE, E NON SI FIDA PIÙ DI SE STESSO  
**82** LA PULIZIA DEI REGISTRI NON DIPENDE PIÙ DA CHI ITERA COSA  
**83** UN 429 SU `/positions` NON FERMA PIÙ IL BOT  
**84** LA BASELINE DEI TEST È CAMBIATA: 7 ROSSI, NON PIÙ 8  
**85** LA CHIUSURA FORZATA A 3 ORE ESISTEVA E NON POTEVA SCATTARE  
**86** IL CONSUNTIVO REWARD SI RECUPERA A RITROSO  
**87** IL REGISTRO DEI REWARD INCASSATI  
**88** PERSISTENZA DOPO CRASH, PROVATA CON UN `kill -9`  
**89** SOLI SUL LATO: AL BORDO ESTERNO DELLA BANDA  
**90** LA QUOTABILITÀ È UN FILTRO A MONTE, E IL CAPITALE LIBERATO SI RIDISTRIBUISCE  
**91** ⚠ LA SCANSIONE DEI REGISTRI AVEVA ROTTO UN'INVARIANTE, e un test l'ha preso  
**92** VOCE 1 · LA SOVRASTIMA DEL 465% È UN TASSO LETTO COME QUANTITÀ  
**93** VOCE 3 · LE DUE CADENZE ERANO GIÀ A TERRA: VERIFICATE E BLOCCATE  
**94** VOCE 4 · TRE CECITÀ DIVERSE SOTTO LO STESSO OROLOGIO  
**95** VOCE 5 · VERIFICA DI TENUTA DEI BLOCCHI A+B: TRE PUNTI REGGONO, IL QUARTO AVEVA UNA LACUNA  
**96** VOCE 6 · IL RESET DISTINGUE PER ORIGINE  
**97** VOCE 2 · RIAVVII AUTOMATICI ROBUSTI, E IL DASHBOARD CHE NON SI RIALZAVA  
**98** IL ROSSO CHE LA SUITE HA TROVATO, E CHE NON VENIVA DA OGGI  
**99** IL CARICATORE `.env` SUI TRE AGENT RESTANTI, MA RISTRETTO  
**100** OPZIONE A: LA STIMA DIVENTA UNA QUANTITÀ INTEGRATA  
**101** LA COSTANTE SBAGLIATA, E PERCHÉ CORREGGERLA DA SOLA SAREBBE STATO UN DANNO  
**102** UNA SOLA MISURA DI ORIZZONTE, E LO SCARTO A MONTE  
**103** IL FRENO DI PROVA, CHE PRIMA NON ESISTEVA  
**104** UNA SOLA VERITÀ SUL CAPITALE  
**105** PERCHÉ IL MINI-CICLO NON PIAZZA  
**106** IL LEDGER NETTATO, E `skipped` CHE NON SPARISCE PIÙ  
**107** IL TETTO DERIVATO  
**108** UNA SOLA FORMULA CAPITALE→SHARE  
**109** LA COERENZA A VALLE, E UNA MISURA CHE CORREGGE UNA STIMA DI OGGI  
**110** IL RAMO `skip` INGHIOTTIVA LA GERARCHIA, E LA DECISIONE USCIVA MUTA  
**111** PERCHÉ L'UTILIZZO ERA AL 7,5%  
**112** OPZIONE B: IL TRONCAMENTO PROVATO RESTITUISCE L'ORA VERA  
**113** LA «FINESTRA DI MID» NON È UN CANCELLO  
**114** I TETTI PER GIRO ALZATI, E IL TETTO ANTI-RUNAWAY CHE AFFAMAVA IL RINNOVO  
**115** IL PIAZZAMENTO DELLA COPPIA È ATOMICO IN PRECONTROLLO  
**116** LA QUOTA 60/40 SULLA FINESTRA  
**117** `REWARD_MAX_CLOB_MARKETS` È GIÀ AL MASSIMO: 150  
**118** IL CAPITALE AL LAVORO: UN NUMERO, UN OBIETTIVO, E IL FERMO RIPARTITO IN DOLLARI  
**119** L'ANELLO DEL FEED APERTO, E IL TURNOVER CHE NON SI CORREGGE DA LÌ  

# CLAUDE.md — contesto permanente del progetto

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **17 agosto 2026** (§4.6, §4.13, §5.1, §5.2, §5-bis p.169-171).

> ⚠️ **QUESTO FILE È STATO COMPATTATO IL 13 AGOSTO 2026** (494k → ~110k) su istruzione dell'operatore.
> Non è stata tolta nessuna regola, nessuna costante, nessuna trappola operativa e nessuna questione
> aperta: è stata tolta la **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi
> sono semplicemente vere. Ogni voce chiusa sopravvive come **una riga** nel registro di §5-bis, con il
> numero originale, così un riferimento del tipo «§5 punto 72» resta risolvibile. La storia integrale
> resta in `git log` e nei commit citati. **Chi aggiunge una voce nuova scriva già compatto.**

---

> ## ✂️ COPIA RIDOTTA + INSTALLATA — 15 agosto 2026, e le decisioni si prendono DA TERMINALE
> **`/root/bot` non è il bot che gira sul server di produzione**: è la copia di lavoro, ora
> autosufficiente. `/root/prediction-market` è un **symlink** a questa directory (serve: `agent41`
> riga 448 cabla quel path nel processo figlio del piano — verificato che `require` risolve e che
> `planFromCollection` è una funzione). pm2 **7.0.3** installato; PostgreSQL **16** con database e
> utente `rewardsbot`, **14 tabelle** applicate da `prisma migrate deploy`; `.env` creato (gitignored,
> `chmod 600`) con i segreti generati a caso e **cinque TODO vuoti** che li deve fornire l'operatore.
> **STATO AL 16 AGOSTO 2026 ore 09:0xZ, LETTO DAI PROCESSI VIVI** (`/proc/<pid>/environ`) e non dai file:
> **`MAKER_MODE=off`** · `MAKER_ADAPTER_DRYRUN=true` · **`MAKER_PLACEMENT` vuota** · freno di agent41
> **inserito** ⇒ **quattro cinture indipendenti, nessun ordine può partire** · KILL spento ·
> AVVIA **ACCESO** (15/08 12:54, `by: cli/avvia`) · interruttore riprezzo **ACCESO** (16/08 08:52:23Z,
> `by: operatore · chat`) · selezione automatica **accesa** con **3 mercati** scelti alle 08:38:56Z.
> **⚠ `MAKER_MODE` NEL `.env` DICE `live-min` ED È INERTE**: pm2 tiene la propria copia dell'ambiente e i
> caricatori `.env` degli agent scrivono solo le chiavi **assenti**, quindi `off` vince. Per armare non
> basta il `.env`: serve dichiararlo in `agents/ecosystem.config.js` e riavviare **dal file**.
> **Il giro di prova è CONFIGURATO e NON ARMATO.**
> **LA RIDUZIONE**: 568 file su 1.267 **spostati** — mai cancellati — in `/root/bot/_archivio`, che
> conserva i percorsi (`mv _archivio/<p> <p>` riporta indietro; `INDICE-SPOSTATI.json` è l'elenco).
> La catena è stata decisa camminando il grafo dei `require`/`import`: **486 file**.
> **⚠ `_archivio` È ORA ESCLUSO DAI SEI TEST STRUTTURALI CHE CAMMINANO L'ALBERO**: senza, uno script
> di ricerca archiviato che cabla di proposito il valore che studiava faceva dichiarare «costante
> ricopiata nel repo» una costante ricopiata in un museo.
> **LA FLOTTA È DI 11 PROCESSI, E IL `dashboard` NON C'È PIÙ** (né fra le app né fra i critici):
> decisione dell'operatore, le decisioni si prendono da `scripts/cli/`. **⚠ I sorgenti sotto `app/`
> RESTANO SUL DISCO**: 32 test strutturali li leggono come TESTO. Un file che nessun processo serve
> non è un file che nessuno legge. **⚠ E con lui è sparito un lettore della manopola della distanza**:
> `distanza-2c.test.js` §6 non elenca più tre nomi a mano — DERIVA i processi che decidono un prezzo
> dalla flotta vera, così un processo nuovo che non la dichiarasse non passerebbe inosservato.
> **I COMANDI CHE SOSTITUISCONO IL PANNELLO** (`scripts/cli/`, ognuno dichiara cosa sta per cambiare
> e cosa ha cambiato): `mercati.js` · `distanza.js` · `stato.js` · `avvia.js` · `ferma.js` ·
> **`selezione.js`** (15/08: la scelta automatica dei mercati, §4.13 — `prova` mostra cosa sceglierebbe
> senza scrivere niente).
> Passano dagli **stessi moduli** degli agent, non riscrivono nessun file a mano. **Nessuno può
> accendere la modalità viva**: `MAKER_MODE` si cambia solo a mano nel `.env`. **`avvia.js` LEGGE il
> KILL e si rifiuta di partire mentre è attivo, senza spegnerlo** — verificato armando il kill davvero
> (rifiuto, `exit 1`, bot rimasto FERMA). `stato.js` verifica su di sé, camminando `require.cache`, di
> non aver caricato nessuna superficie che sappia agire sul venue.
> **I 5 SELFCHECK SONO STATI RIMESSI IN SCALA** e sono verdi: 224 + 113 + 39 + 33 + 58 asserzioni.
> Tre erano deriva di **banda** (`maxSpread` dimezzato, §5-bis p.155), due di **contratto**: vedi §5.2 p.27.
> **Suite `lib/`: 185 test, 167 verdi, 18 rossi — dai 26 della baseline, zero regressioni.** I 18
> restanti chiedono dati vivi che questa macchina non ha (board, book websocket, giornali con
> attività) o sono i rossi noti di §5.2 p.11.
> **Banco di prova**: `node scripts/verifica-catena-rewards.js` — 67 asserzioni, A/B/C in simulazione.

---

## 🟢 STATO OPERATIVO — 13 agosto 2026, 22:08 UTC (verificato sui file, non assunto)

| | |
|---|---|
| **KILL** | **spento** (`killed:false`) |
| **AVVIA/FERMA** | 🟢 **AVVIA** dal 13/08 **12:29:11Z**, `by: operatore · tab Mercati` |
| **Guardiano perdite** | **in servizio, mai scattato dal riavvio**: `data/guardian-state.json` **assente** (l'assenza *è* lo stato sano). Riferimento **v2 a massimo mobile** $2.169,77 (22:02:45Z) |
| Capitale | **$2.169,77** = saldo $2.004,34 + posizioni $165,43 |
| **Riavviati alle 21:41Z** | `agent43` (9) · `agent24` (19) · `agent34` (28) · `agent40` (100) · `dashboard` (14) ⇒ in servizio orizzonte 0,50, tetto $61,25, banda corretta, riferimento a massimo mobile + soglia assoluta derivata al 5% |
| **NON riavviato** | `agent41-realloc-scheduler` — fermo al **restart 78** delle 12:09:01Z. Vedi §5.1 |

> ## 🔻 IL GRADINO 6 È DISARMATO — decisione dell'operatore, 13 agosto 2026, 22:0x UTC
> `SBLOCCO_GRADINO6_ARMATO='0'` nell'`env` di agent41. **Non è un difetto e non è una svista**: il
> gradino «fermati-in-sicurezza» è stato cablato oggi (`53b80d8`, §5-bis p.153) dopo essere stato rotto
> per tutta la vita del bot, e armarlo al riavvio metterebbe il bot su **FERMA senza riarmo
> automatico** — una mano umana per ripartire, con la causa a monte (§5.2 p.21) ancora aperta.
> L'operatore vuole il bot **autonomo**, e ha scelto di raccogliere prima i dati.
> **⚠ DISARMATO NON VUOL DIRE ASSENTE**: la scala sale ancora fino a 6 e il gradino **registra che
> sarebbe scattato e perché** — `data/realloc-scheduler.jsonl` (`tipo:'sblocco-progressivo'`,
> **`disarmato:true`**) e giornale maker (`outcome:'gradino-6-disarmato'`). Conta **episodi**, non tick.
> **⚠ NESSUNA DIFESA VERA È TOCCATA**: guardiano delle perdite, sentinella del collasso e KILL non
> passano da questa scala. Un test lo verifica per assenza.
> **PER RIARMARLO**: si cancella quella riga da `agents/ecosystem.config.js` e si riavvia agent41. Il
> difetto **in assenza della variabile è ARMATO** — un env che sparisce non può spegnere una difesa.

> ## 🕳️ IL VUOTO DI TRE ORE, E COSA NE RESTA — §5-bis p.120-122
> Il 13 agosto, fra le 02:53 e le 05:56, **zero ordini a riposo per 180 minuti** con KILL spento,
> AVVIA acceso e $609,10 liquidi: non un processo caduto, ma **tre numeri in tre moduli che non si
> parlavano** — righe di piano a $24,00 contro un pavimento di $24,50 ⇒ 114 rifiuti identici. La
> regola che lo impedisce vive in **§4.3** (la griglia limitata anche dal tetto, 8 livelli minimi), la
> diagnosi per intero in §5-bis p.120. **⚠ Era un dente di sega: peggiorava crescendo il capitale.**
> **⚠ E le modifiche a `lib/rewards/allocator.js` entrano in servizio SENZA RIAVVIO** — il piano nasce
> in un processo figlio che rilegge il file da disco a ogni ciclo (§5.3). Vale la pena saperlo prima.
> Dallo stesso episodio: la **sentinella sul vuoto** (§5-bis p.121, 5 min ⇒ ricostruzione immediata) e
> il **recupero della scadenza a tre fonti** (p.122: `recordDaRigaBoard` non mappava `endDate`, e 5
> posizioni su 7 erano senza scadenza, quindi la chiusura forzata a 3 ore non poteva scattare).

> ## 🤖 IL BOT SI SBLOCCA DA SOLO: RIFIUTI RIPETUTI, COERENZA, SCALA, AUTODIAGNOSI — §5 punti 124-127
> **Principio: ogni difesa AGISCE, non segnala soltanto** — qui non c'è nessuno a leggere i log. E la
> metà opposta: **quando l'unica via d'uscita violerebbe una regola di rischio, il bot non agisce e lo
> dichiara.**
> **① RIFIUTI RIPETUTI** (`sblocco-progressivo.js`): **5** rifiuti identici di fila sulla stessa coppia
> (mercato, gate) sono un blocco strutturale — il 13 agosto sono stati **114**. Le 37 famiglie sono in
> tre classi: **`rischio`** (56% dei 43.299 rifiuti) ⇒ **nessuna azione, si cambia mercato e si dichiara
> perché**; **`stato-bot`** ⇒ via alternativa vera; **`transitorio`** ⇒ non è un blocco. **Una famiglia
> sconosciuta è trattata come rischio.**
> **② COERENZA FRA I MODULI** (`coerenza-soglie.js`): prima di proporre righe si verifica che chi le
> riceve le accetti, e il capitale **può solo SCENDERE**. Due divergenze misurate: il deadlock $24,00
> contro $24,50, e **il pianificatore non conosce il tetto per ORDINE** (**243 mercati su 321 lo
> sfonderebbero al tetto pieno**, e il giornale porta 631 `manual-order-cap` in tre giorni).
> **③ SCALA DI SBLOCCO**, un gradino ogni **5 minuti**: `ricostruisci-piano` → `ricarica-configurazione`
> → `riconcilia-esposizione` → `ripara-precondizioni` → `risveglia-feed` → **`fermati-in-sicurezza`**
> (FERMA + allarme grave). Caso peggiore: FERMA in **~30 minuti**. **Nessun gradino tocca una regola di
> rischio**, ed è provato per struttura.
> **④ AUTODIAGNOSI ogni 120 s**: ordini vivi > 0 · capitale al lavoro ≥ **50% per 15 minuti** · un ciclo
> negli ultimi **20 min** · rinnovi dovuti non fermati oltre l'**80%**. Tutto illeggibile ⇒ **non si
> giudica** e la scala non parte.

> ## 💵 IL «CAPITALE AL LAVORO» DICEVA L'INTENZIONE, NON IL FATTO — §5 punto 124
> `impegnatoOra = giro.allocatoUsd`, cioè **il piano del giro**. Misurato il 13 agosto 06:47:52: il giro
> aveva allocato **$284**, ma di 17 gambe ne sono passate **8** — nozionale reale **$127,79**. La riga
> «CAPITALE AL LAVORO» dichiarava **$578,40 = 87%** contro un valore onesto di ~63%, e la misura vera
> del giro dopo diceva **44,3%**. Sbagliava **sempre nella direzione che rassicura**, ed è il numero su
> cui l'autodiagnosi decide se il bot lavora. Adesso si sommano i nozionali delle sole gambe non
> rifiutate né saltate, **passate precedenti comprese**; una riga senza `notionalUsd` vale **zero**.
> ⚠ **Il pannello Polymarket e il bot misurano cose diverse e possono essere entrambi giusti**:
> «disponibile per il trading» **è il cash** e non sottrae i BUY a riposo, quindi gli «impegnati» del
> pannello sono le **sole posizioni**; il bot conta **posizioni + ordini a riposo**.

> ## 🩸 DOVE MUOIONO LE GAMBE: `coppia-non-atomica` È LA PRIMA CAUSA — §5 punti 129-130
> **Conto esatto sulle 24 ore (33 giri): 284 gambe pianificate · 260 inviate · 155 accettate · 105
> rifiutate · 24 saltate ⇒ tasso di accettazione 54,6%.**
> **84 gambe perse per $1.276,13 sono `coppia-non-atomica`** (difetto, corretto) · 20 per cap cumulativo
> · 11 per $268,95 `manual-order-cap` (stessa causa) · 9 per $121,23 `mai-primo-sul-libro` (regola di
> rischio, perdita voluta) · 4 per $129,95 cap di esposizione.
> **65% delle gambe perse sono coppie abbandonate INTERE perché UNA gamba sfondava il tetto per
> ordine** — il precontrollo atomico di §5 p.115 fa il suo mestiere (meglio zero invii che una gamba
> orfana), ma la causa a monte è che **il pianificatore non conosce il tetto per ordine**.
> **⚠ E LA CORREZIONE DI STAMATTINA ERA INERTE**: `adattaRighe` girava sul piano **salvato**, e la
> ricostruzione sovrascriveva `righeCandidate` con righe mai passate di lì. Adesso è una funzione
> (`adattaAlleSoglie`) chiamata da **entrambe** le fonti, e un test lo asserisce per nome.

> ## 💰 IL RISCATTO AUTOMATICO DOPO LA RISOLUZIONE — §5 punto 131
> `redeemPosition` esisteva, era provata on-chain e **non aveva chiamanti**. Adesso
> `lib/maker/riscatto-automatico.js` lo chiama, agganciato alla scansione dei registri di agent40.
> **⚠ IL SEGNALE È `payoutDenominator(conditionId) > 0` LETTO ON-CHAIN, non «il mercato è chiuso»**:
> `closed`/`acceptingOrders` diventano veri **ore prima** che l'oracolo riporti l'esito, e un tentativo
> prima è un revert che costa gas e non dice niente. **Non letto ⇒ non si riscatta.**
> **Idempotente** con registro su disco (`data/riscatti.json`): fra l'invio e la sparizione del token
> passano secondi, e in quella finestra un secondo giro riproverebbe. **3 tentativi**, poi **10 minuti**
> di backoff per mercato. Al più **3 mercati per giro**: è manutenzione, e ogni transazione costa gas al
> relayer di terzi. `negRisk` non booleano ⇒ non si tenta.

> ## 🔭 IL BOT VEDE ~111 MERCATI SU 1.276 PREMIATI — E NON È LUI IL COLLO — §5 punto 132
> Scoperta 1.276 → `REWARD_MAX_CLOB_MARKETS = 150` → board ~111 righe: **l'88% non viene mai guardato**.
> **⚠ Il tetto NON si può alzare** (2,81-3,41 s/mercato: i 1.276 costerebbero ~60 min contro 25 di
> freschezza). **Il collo era l'ORDINAMENTO** — i 150 si sceglievano per montepremi, che vive sui
> `minSize` grandi (1.000 share ⇒ $1.225/mercato), seppellendo i meteo a `minSize 20`, gli unici alla
> nostra portata. **Correzione: metà dei posti riservata ai mercati con `minSize ≤ 100`.**
> **⚠⚠ MA VEDERNE DI PIÙ NON ALZA I MERCATI QUOTATI**: il vincolo che morde è il tasso di accettazione
> (§5 p.129) e il tetto per giro. La quota di scansione è **assicurazione**, non la cura di adesso.

> ## 🩹 LE DIFESE DI STAMATTINA AVEVANO DUE DIFETTI, ED ERANO MIEI — §5 punti 135-136
> **① `ultimoCicloOk` non veniva mai aggiornato.** Inizializzato al riavvio e mai timbrato: l'autodiagnosi
> dichiarava «nessun ciclo da N minuti» **mentre il bot piazzava 12 gambe su 14**, salendo la scala fino al
> **gradino 5 ogni mezz'ora**. Adesso si timbra in **tre** punti — quando il giro arriva in fondo con delle
> scelte, e nei due rami che escono con «nessuna azione», perché **anche un giro che non trova niente HA
> girato**. Non si timbra all'inizio, o si timbrerebbe un giro che poi esplode.
> **② `coppia-non-atomica` non era nella mappa delle famiglie.** È **la prima causa di perdita di gambe** e
> finiva in «sconosciuta ⇒ rischio ⇒ non si aggira». Censimento dei tre giorni: **30 gate osservati, 10
> mancavano**. Aggiunte tutte (37 famiglie).

> ## 🧹 IL CICLO PESANTE SI FERMAVA PERCHÉ LA FONTE È SPORCA, NON PERCHÉ IL CONTROLLO È STRETTO — §5 p.137
> «Dopo 3 ricalcoli il piano contiene ancora mercati che il venue rifiuta»: il ciclo da 6 ore non girava
> da 03:42. L'esclusione **veniva passata**, ma il ricalcolo ripesca dallo **stesso board**, e il board è
> sporco per una **CLASSE** di mercati — il motivo misurato è `premio-crollato` («da $100/g a $5/g»).
> **Tre passate contro N mercati sporchi non convergono, e N > 3.**
> **Si pulisce la fonte, non si allenta il controllo**: la verifica al venue è intatta, ma il suo esito ora
> **sopravvive al ciclo** (`lib/maker/quarantena-venue.js`). Un mercato bocciato resta fuori dal piano per
> **20 minuti** — poco più del periodo con cui agent24 riscrive il board. **Non è un cancello**: se un
> mercato in quarantena arrivasse al piazzamento, tutti i gate lo giudicherebbero come prima.

> ## 🛡 IL GUARDIANO NON SCATTA PIÙ SULLA PRIMA LETTURA — §5 punto 141
> **k = 2 letture CONSECUTIVE oltre soglia**, e consecutive vuol dire anche **contigue**: oltre
> **120 s** fra una lettura e l'altra il contatore riparte da capo, perché una lettura persa non può
> fare da ponte. Una lettura **rientrata** azzera; una lettura **non calcolabile** azzera anche lei —
> «non ho letto» non può confermare che la perdita persisteva.
> **Le soglie NON sono state toccate**: restano −5% e −$30. Si chiede solo che la perdita **sia ancora
> lì trenta secondi dopo**. Costo: **un solo giro di ritardo** su uno scatto vero.
> **⚠ VERIFICA RETROATTIVA su 7.213 letture / 5 giorni, rigiocate con le funzioni VERE: con k=2 gli
> scatti passano da 2 a ZERO.** Ed **entrambi erano falsi positivi**, con evidenza indipendente:
> il 09/08 la lettura precedente diceva **+$10,85** e quella successiva alla ripresa della misura
> (12/08) **+$2,54**, contro i −$39,97 dello scatto; il 13/08 la lettura on-chain 37 minuti dopo dava
> **−$6,77** contro i −$36,15. ⚠ Il replay **da solo** non potrebbe dirlo — dopo il latch il guardiano
> smette di misurare, quindi «0 scatti» è un limite inferiore: sono le letture *intorno* a chiudere la
> questione.
> **Il pre-allarme si vede**: ogni prima lettura oltre soglia finisce nel log come
> `PRE-ALLARME (1/2)`, o la modifica sembrerebbe «il guardiano non vede più niente».
> Lo stato vive **nel processo e non su disco**: un riavvio lo azzera, ed è giusto — un guardiano
> appena rinato non ha visto il campione precedente e non può affermare che la perdita persisteva.

> ## 📉 LA SENTINELLA SUL COLLASSO DELLA COPERTURA — §5 punto 142, SOLO OSSERVA
> Chiude §5.2 p.9. **Calo ≥ 85% dal MASSIMO delle ultime 10 minuti**, non differenza fra campioni
> consecutivi: la cadenza è irregolare (mediana 60,0 s, q99 65,3, max 77,2 su 7.859 intervalli) e un
> crollo che arriva in due campioni verrebbe **spezzato in due pezzi** ciascuno sotto soglia.
> **La soglia viene dalla tabella, non dall'intuito** (4,1 giorni, 7.860 campioni): 30% ⇒ 5 veri/183
> falsi · 40% ⇒ 5/69 · **50% ⇒ 5/20** · 60% ⇒ 5/4 · 70% ⇒ 5/2 · **80% ⇒ 5/0**. Si sceglie **85 e non
> 80 perché il divario è VUOTO**: fisiologico massimo **75%** (30 → 8, rientrato da solo in 9,5 min),
> patologico minimo **92,9%** (28 → 2), e fra i due non cade nessun episodio. 85 è il punto medio.
> **⚠ NON SI AUTO-INGANNA**: il collasso più grande nei dati **l'ha prodotto il guardiano**. Se il
> latch (`data/guardian-state.json`, campo `at` — lo scrive il guardiano stesso) porta uno scatto nei
> **15 minuti** precedenti, il calo è **SPIEGATO** e non si arma: si logga `SOSPESO` con il calo
> comunque misurato. Latch illeggibile ⇒ **non si arma**: meglio muto che bugiardo.
> **⚠ IN QUESTA FASE SOLO OSSERVA**: log + giornale (`op: sentinella-collasso`,
> `outcome: collasso-oltre-soglia`, `soloOsservazione: true`). **Non ferma il bot, non cancella
> ordini, non tocca AVVIA/FERMA** — un test lo verifica **per assenza** dei campi che agirebbero.
> La promozione ad azione è una decisione dell'operatore. **⚠ Limite: 5 soli eventi positivi in 4,1
> giorni** — soglia difendibile sui dati che ci sono, campione piccolo.

> ## 🪙 LA GAMBA SORELLA SI ABBASSA DENTRO LA BANDA — §5 punto 143
> Il Livello 2 prezzava il completamento **sempre al tetto della coppia**, e `fuoriBanda` era calcolato
> e solo **dichiarato**. Quando il tetto cade **sopra** il bordo alto della banda premiante si può
> **abbassare** fino al bordo, e conviene **due volte**: la controparte **costa meno** (il margine
> della coppia cresce) e l'ordine **matura reward mentre aspetta** invece di essere capitale fermo.
> L'unico prezzo è il **tempo di fill**, ed è lo scambio che l'operatore ha scelto esplicitamente: «a
> parità di condizioni, il prezzo dentro la banda invece di quello che chiude prima».
> **⚠ NON ALLENTA NIENTE, per costruzione**: è un `Math.min`, quindi il prezzo può solo **scendere**.
> Tetto della coppia intatto, «mai primo sul libro» intatto (l'esenzione è quella già esistente e non
> si allarga), size intatta. Banda non leggibile, o bordo **sopra** il tetto ⇒ prezzo **identico a
> prima**. Il ritardo di fill è coperto dalla scala di urgenza (§138) e dalla chiusura forzata a 3 ore.

> ## ⏱ LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — §5 punto 138
> **Il fatto**: una posizione NO di 58,8 share è rimasta scoperta **8,2 ore**. Nessuna singola regola
> aveva sbagliato, e il bot **adattava anche il prezzo** (11 prezzi su 17 mid distinti). Sbagliava il
> **sistema** in un punto solo: **nessuno guardava da quanto tempo la posizione era scoperta** — la
> gerarchia di §4.6 ha **un solo orologio**, i 60 min del Livello 2.
> **Le soglie vengono dai dati, e la distribuzione è BIMODALE** (24 episodi, 48 h): **7 chiusi**, mediana
> **10,5 min** — contro **17 aperti**, mediana **126,5 min**, massimo 553,7. Una scopertura sana si
> chiude in dieci minuti; oltre l'ora non si chiude quasi più da sola.
> **La scala** (`lib/maker/urgenza-scoperto.js`, puro): **0** (<30 min) niente · **1** (≥30) l'uscita può
> scendere **fino al carico** (`profitPct: 0`) · **2** (≥120) **chiusura peggiorativa** entro il tetto ·
> **3** (≥240) **anomalia grave** nel log, che **non apre una quarta via**: al gradino 2 sono già tutte
> aperte, e il bot dichiara di non farcela invece di tacere.
> **⚠ IL TETTO DI PERDITA È DOPPIO E IL PIÙ STRETTO VINCE**: **2 tick** e **mai oltre il 5% del carico**
> (su un token da 10¢ due tick sarebbero il 20%). Misurato: **$0,59 su 58,8 share** contro un'esposizione
> direzionale di **$25,28**, cioè **43×**.
> **⚠ NESSUNA REGOLA DI RISCHIO È TOCCATA**: il modulo non produce prezzi, produce un **pavimento**; il
> prezzo lo sceglie il motore, che applica «mai primo» come sempre. E la concessione **non esce dalla
> banda**. **⚠ OROLOGIO NON LEGGIBILE ⇒ GRADINO 0.** **⚠ L'orologio si azzera a ogni nuovo ingresso in
> modalità chiusura**: sul caso reale diceva 168 min contro 492 veri — **sbaglia per difetto**.

> ## 🧱 I RESIDUI SOTTO IL MINIMO NON HANNO UNA VIA D'USCITA — §5.2 p.1, §5-bis p.123, BUCO APERTO
> **$26,30** in cinque residui che il registro raccoglie correttamente e che **niente può chiudere**:
> `manca` è sotto `min_incentive_size`, quindi né un ripiazzamento né il completamento della coppia
> sono ordini validi. Non è capitale perso: è **capitale irraggiungibile fino alla risoluzione**.
> La proposta — riscattarli via `redeemPositions` — è scritta e **non implementata**: è capitale, e la
> decisione è dell'operatore.

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

**La scheda del guardiano:**

| | |
|---|---|
| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il **riferimento a massimo mobile** in `data/guardian-baseline.json` (§5-bis p.157: depositi e prelievi sono riconosciuti come cassa esterna, non come P&L); oltre `GUARDIAN_LOSS_PCT` (5%) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` resta il pavimento in dollari) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

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

**Mid stantio**: oltre **20 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, env con clamp
`[5 s, 120 s]`). L'orologio si azzera **solo su una lettura buona**, e una cancellazione fallita NON lo
azzera. Tre cause distinte in audit — `cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}` — perché
l'azione è la stessa ma la diagnosi no.

**Cadenza di reprice adattiva per mercato** (`cadenza-adattiva.js`): l'escursione del mid su 15 minuti
si traduce in tick/ora e da lì in tre classi — veloce 1 s, media 5 s, lenta 10 s. Chiamate al venue
−37,9%. **Non abbassa nessuna soglia**: `minMoveCents`, `hysteresisTicks`, `confirmSamples` e
`minIntervalMs` restano dov'erano, e guardare più spesso non riprezza di più. Misura assente ⇒ cadenza
di difetto. La decisione è guidata anche dall'**istante dell'ultimo book**, così un mercato «lento» col
book appena cambiato non aspetta dieci secondi.

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
(era $1000 — 16 agosto 2026, decisione dell'operatore) e cap cumulativo di esposizione aperta **$150**
(era $600 — 16 agosto 2026, decisione dell'operatore: è la cintura scelta per limitare la rotazione di
§4.13, e conta i **fill riconciliati**, non gli ordini a riposo)
(invariato). **Perdita giornaliera massima $100** (era $25), che è il kill switch chiesto per il giro di
prova. ⚠ `data/safety-risk-limits.json` è **gitignored**: è stato dedotto sul disco, non nel commit.
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

**⚠ FILL PARZIALE: IL RESIDUO DELL'ORDINE ORIGINALE SOPRAVVIVE ALL'INGRESSO E MUORE ALLA COPPIA**
(16 agosto 2026, §5-bis p.166). Le cancellazioni d'ingresso di `runAutoCloseCycle` ora **escludono**
`residuo-non-fillato`, cioè la parte non riempita dell'ordine che ha prodotto il fill: cancellarla
subito rinuncerebbe alla parte di coppia che il mercato stava già completando da solo. Un **PASSO
2-bis** la cancella quando `manca <= 0`, cioè quando la gamba opposta è arrivata e il residuo
diventerebbe una **gamba scoperta nuova**. Il passo **non è condizionato a `statoChiusura.nuova`** — un
fill parziale arriva a ciclo già aperto — ed è idempotente per costruzione: se il residuo non c'è più,
`residuiDaCancellare` non lo elenca. Esiti in audit: `coppia-completa-residuo-cancellato` /
`…-cancellazione-fallita`. **Nessuna delle due liste è ricopiata**: entrambe filtrano l'unica lista di
`modalita-chiusura.residuiDaCancellare`, che resta la sola fonte.

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

**La resa dopo 60 minuti** (`urgenza-scoperto.js`): gradino 1 a **30 min** (uscita fino al carico),
gradino 2 a **60 min** (era 120) ⇒ chiusura **peggiorativa** entro il tetto, gradino 3 a 240 min ⇒
anomalia grave. La concessione massima è **1 tick** (era 2) **e mai oltre il 5% del carico**, il più
stretto dei due. **⚠ La cintura del 5% NON è stata toccata, e su un token da 9,5¢ azzera la
concessione**: un tick intero sarebbe il 10,5% del carico, quindi il gradino 2 lì non concede nulla e
la gamba resta in attesa invece di essere svenduta. È il comportamento prudente e va saputo.

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

**⚠ Resta scoperta una metà, ed è dichiarata**: l'unione è `abilitati ∪ posizioni` perché **non esiste
uno snapshot locale degli ordini a riposo** (esiste solo per le posizioni). La metà «ordine a riposo» è
coperta indirettamente: un ordine su un mercato disabilitato muore per GTD entro 23 minuti o si riempie,
e allora la posizione entra nell'unione entro un giro di snapshot (≤ 60 s). Coprirla direttamente
richiede uno snapshot degli ordini, cioè un file, uno scrittore e una regola di freschezza.

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
| **vincoli** (16/08) | `rewardsMinSize ≤ 50` · **scadenza ≥ 168 h** (7 g) e **≤ `MAX_HORIZON_DAYS`** · **niente famiglia meteo** · **max 3 ATTIVI** · **3 categorie diverse** · **composizione 1 scaglione «basso» (minSize ≤ 20) + 2 «alto» (≤ 50)** |
| **interruttore** | `data/selezione-mercati.json`, `scripts/cli/selezione.js {stato\|prova\|accendi\|spegni}`. Difetto **SPENTA**; file illeggibile ⇒ **spenta**. **ACCESA dal 15/08** |
| **quando gira** | a ogni ciclo 6 h **e** a ogni controllo del capitale fermo (120 s), **prima** del piano — e prima di `decidiTrigger`, così un mercato che scade esce anche nei giri in cui il trigger non scatta |
| **classifica** | `levels[<capitale minimo>].grossRewardDay`, cioè la stima che **il board ha già calcolato** con la formula del venue → ripiego `rateOrdinamento` → `rewardsDailyRate`. **Non** il montepremi (§5 p.132). Pareggio rotto sul `conditionId`: due giri sullo stesso board danno la stessa risposta |
| **il piano si restringe** | `restringiAllaSelezione` in `calcolaPianoFuoriProcesso`, cioè il punto per cui **entrambi** i percorsi (6 h e mini-ciclo) sono coperti da una regola sola. **Interseca, non sostituisce**; intersezione vuota ⇒ vincolo **impossibile**, mai vincolo **assente** |

> **🔄 LA ROTAZIONE ROVESCIA LA REGOLA DELLO SLOT — decisione dell'operatore, 16 agosto 2026.**
> **Qui c'era scritto il contrario** («lo slot non si libera alla scadenza, ma alla chiusura»), e la
> ragione di allora era buona: il tetto è sull'esposizione, e l'esposizione finisce con la posizione.
> **L'operatore ha scelto l'altro lato dello scambio**: un mercato che riceve un fill — **totale o
> parziale** — **esce dal conteggio dei 3 attivi** e **resta in gestione** fino a coppia chiusa o
> mollata; contemporaneamente ne entra uno nuovo, al pavimento premiante, rispettando categorie e
> scaglioni. Lo stato porta `inGestione` + `inGestioneDal`; gli ingressi in gestione e i rilasci sono
> due liste dichiarate nel giornale (`entratiInGestione`, `liberati`).
> **⚠ LA CONSEGUENZA VA DETTA PER INTERO: L'ESPOSIZIONE TOTALE NON È PIÙ LIMITATA A TRE MERCATI.**
> Tre quotano mentre N completano. Ciò che la limita ora sono, in ordine: il **tetto per mercato**
> ($61,25), il cap cumulativo di esposizione aperta (**$150** dal 16/08) e il **kill a $100** di perdita
> giornaliera. Chi rialza uno di quei tre alza il rischio di questa regola, non di quella.
> **⚠ IL CASO PEGGIORE ACCETTATO DALL'OPERATORE È ~$294** (16 agosto 2026, decisione in chat): 3 attivi
> a $147 di ordini a riposo più una rotazione piena. **Non era il caso peggiore vero**: `inGestione` non
> ha tetto, e l'unica cintura che morde è `maxOpenNotionalUsd`, che conta i **fill riconciliati** e
> **ignora i $147 a riposo** ⇒ il soffitto era `$600 + $147 ≈ $747`. Per questo il cap è stato portato a
> **$150**: `$147 a riposo + $150 riconciliati ≈ $297`, cioè la cifra chiesta.
> **⚠ MA IL TETTO SI APPLICA ANCHE AGLI ORDINI DI APERTURA, CHE POI NON CI ENTRANO**: il gate confronta
> `openNotionalUsd + notional`, quindi la gamba più cara del piano ($54,38) smette di essere piazzabile
> quando i fill riconciliati superano ~$95. **La rotazione si ferma da sola lì, non a $150** — è la
> conseguenza voluta di un tetto stretto, e va saputa prima di leggerla come un guasto.
> **⚠ E $150 STA SOTTO `3 × tetto per mercato` ($183,75)**: tre test lo dicono e sono **rossi apposta**,
> vedi §5.2 p.37. Non sono stati ammorbiditi.
> **⚠ UN MERCATO IN GESTIONE DEVE RESTARE ABILITATO AL RIPREZZO**: `restringiAllaSelezione` usa
> `idsAttivi` (solo i non-in-gestione) per il **piano**, così il pianificatore non apre gambe nuove lì,
> ma la lista del riprezzo tiene **tutti** gli id. Toglierlo farebbe morire la gamba sorella per GTD in
> ≤ 23 minuti, cioè **prima** dei 30 che la scala d'uscita le concede.
> **⚠ USCIRE DALLA LISTA SPEGNE L'INGRESSO, NON L'USCITA**: `rilasciaDallaSelezione` tocca
> `setAutoReprice` e **niente altro** — non `setAutoClose`, non il tracking, nessuna cancellazione —
> quindi la posizione resta gestita dalla regola di copertura di §4.8. Un rilascio che spegnesse anche
> la via d'uscita ripeterebbe §5-bis p.44, e **due test lo verificano per assenza**.
> **⚠ FAIL-CLOSED NEI DUE VERSI**: board illeggibile o posizioni non leggibili ⇒ **nessuna decisione**,
> e soprattutto **nessuno esce** (un board che non si legge farebbe sembrare scaduto il mondo intero).
> Ma una **singola** scadenza non determinabile **esclude quel mercato**, come in §4.4: lì l'ignoranza
> riguarda l'insieme e la risposta è non agire, qui riguarda un mercato e è già una ragione per starne fuori.
> **⚠ NON ACCENDE NIENTE**: servono ancora, indipendentemente, l'interruttore generale del riprezzo,
> AVVIA, il KILL spento e `MAKER_MODE` a mano nel `.env`. Decide **su quali** mercati, mai **se**.
> **⚠ E IL FILTRO METEO OGGI TOGLIE ZERO RIGHE** (misurato sul board del 15/08): il vincolo delle 48 h
> le aveva già tolte tutte. Resta esplicito perché un meteo settimanale passerebbe le 48 h, e una regola
> che vale «per conseguenza» smette di valere il giorno in cui la conseguenza cambia.
> **⚠ 168 h NON È UN NUMERO SCELTO A OCCHIO**: sul board vivo le scadenze ammissibili sono **50 h** e
> poi **1.826 h**, e fra le due non cade niente — la soglia sta nel **vuoto**, come in §5-bis p.140.
> **⚠ UNO SCAGLIONE VUOTO NON SI RIEMPIE COL VICINO**: se manca un candidato «basso» il posto resta
> **non assegnato e dichiarato** (`postiNonAssegnati`, `scartatiPerComposizione`) invece di essere
> preso da un «alto» — sostituire porterebbe il capitale da $147 a $183,75, cioè cambierebbe in
> silenzio la cifra che l'operatore ha deciso.

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

> **🟢 ESEGUITI IL 17 AGOSTO 2026 alle 04:59Z** (`pm2 restart agents/ecosystem.config.js --only
> agent40-manual-reprice,agent41-realloc-scheduler`), su istruzione dell'operatore in chat. Verificato
> **prima** che `ecosystem.config.js` non dichiarasse nessuna cintura per quei due processi, e **dopo**
> su `/proc/174332` e `/proc/174326`: `MAKER_MODE=off`, `MAKER_PLACEMENT` vuota, dryrun `true`,
> `MANUAL_ORDER_PLACEMENT` assente, freno **inserito**. Portano la presa di profitto (§5-bis p.169) e
> l'esenzione di profondità sui rinnovi.
> **🔴 PENDENTE DAL 17 AGOSTO: `agent41` di nuovo**, per il ripristino delle gambe (§4.13, §5-bis
> p.171). Il bot è FERMO e `riconciliaCopertura` è comunque a valle del cancello `botAttivo()`, quindi
> non è urgente. **Testo storico del riavvio precedente, per il comando:** Portano la configurazione del giro di prova: `MAKER_AUTO_REPRICE_POLL_MS: '1000'` (nuova su
> agent40) e il commento riscritto della manopola su agent41. **Comando**:
> `pm2 restart agents/ecosystem.config.js --only agent40-manual-reprice` e idem per
> `agent41-realloc-scheduler` — **`--update-env` non basta**, non rilegge l'ecosystem (§5.2 p.2).
> **Non eseguiti**: §2 regola 2 chiede la conferma in chat, ogni volta. **⚠ Sono i due processi che
> decidono un prezzo: si riavviano insieme o i prezzi divergono** (vedi il riquadro sotto).
> **⚠ Le modifiche a `lib/` sono già in servizio senza riavvio** solo per `allocator.js` (processo
> figlio); tutto il resto — banda, tetti, uscita a 101¢, margine dal bordo, fill parziale, rotazione —
> **vive nei processi** e aspetta il riavvio. Finché non si riavvia, il bot in memoria è quello di ieri.

**⚠ Il resto di questa sezione riguarda `/root/rewards-bot`.** Il `dashboard` non esiste più in
nessuna delle due copie.

**Eseguiti il 13/08 alle 21:41Z**: `agent43` · `agent24` · `agent34` · `agent40` · `dashboard` —
portano orizzonte 0,50, tetto $61,25, banda premiante corretta, riferimento a massimo mobile.
**Pendenti**: `agent41` (gradino 6 **disarmato** per configurazione, log del gradino 5 leggibile,
banda corretta nel cablaggio, 10 mercati per giro) e la **manopola distanza a 0,444** su agent41 +
agent40 (+ il dashboard, finché è nella flotta di quella copia).

> **⚠ I PROCESSI CHE DECIDONO UN PREZZO SI RIAVVIANO INSIEME, O I PREZZI DIVERGONO.**
> `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` è un **env**, quindi vive nel processo: se agent41 riparte e
> agent40 no, agent41 apre a 2,0¢ e il rinnovo di agent40 riporta l'ordine a 1,0¢ — non è pericoloso
> (la manopola può solo allontanare dal mid), ma rende **illeggibili** le 24 ore di dati che il test
> esiste per raccogliere. Su questa copia lo strumento che le tiene allineate è
> `node scripts/cli/distanza.js`, che le scrive tutte insieme o nessuna.
>
> **⚠ E `pm2 restart <nome> --update-env` NON RILEGGE `ecosystem.config.js`** (§5.2 p.2):
> `--update-env` prende l'ambiente della **shell**. Per una variabile NUOVA serve il riavvio **dal
> file**: `pm2 restart agents/ecosystem.config.js --only <nome>`.

> **⚠ LE MODIFICHE A `lib/rewards/allocator.js` ENTRANO IN SERVIZIO SENZA RIAVVIO**: il piano nasce in
> un processo figlio che rilegge il file da disco a ogni giro (§5.3). Quello che vive nel processo di
> agent41 sono le righe di log e il cablaggio. Allargare la banda è **monotono** — il piano nuovo è un
> soprainsieme del vecchio — quindi finché i due lati non sono coerenti il bot lavora
> sull'intersezione, cioè come prima, al costo di rifiuti in più.

### 5.2 · Aperte

> **Chiuse oggi, e scese a una riga** (diagnosi integrale in §5-bis e in `git log`):
> **p.15/16 guardiano k=2 + letture distinte** → §5-bis p.141 e p.145 · **p.17 registro residui senza
> consumatore** → p.148 · **p.18 tetto per ordine sul riposizionamento scoperto** → p.147 ·
> **p.28 i due commenti a 110¢ in `auto-close.js`** → corretti il 16/08 nello stesso commit che porta
> il tetto unico a 101¢ (§5-bis p.165), il reperto D7 non esiste più.

38. **🔴 IL RIPREZZO CANCELLA E NON RIPIAZZA: 197 MINUTI DI GAMBA SINGOLA IL 16 AGOSTO — APERTO.**
   È il **capofila misurato** (`data/ricerca/gambe-16-agosto.md`): **il 68,1 % dei minuti di gamba
   singola** della giornata — 160,8 da `nozionale-mercato-oltre-tetto` e 36,2 da `doppione-identico`,
   su 289,3 totali. `replaceManualOrder` ha **cinque precontrolli prima di cancellare**, tutti con
   `oldCancelled:false`, esattamente perché una cancellazione senza ripiazzo lascia la gamba scoperta
   (`manual-order.js:1716-1806`). **I due gate aggiunti il 16 agosto non sono in quell'elenco**:
   vivono dentro `placeManualOrder` (`:1291` e `:1316`), cioè **dopo** la cancellazione. Il riprezzo
   passa i cinque, cancella, il sesto rifiuta, la gamba è persa. Classe «protezione presente su un
   percorso e assente sul suo gemello».
   **⚠ E UN SECONDO DIFETTO DENTRO IL PRIMO, DI SEGNO**: il gate somma `ordini a riposo + questo
   ordine`, l'aritmetica di chi **apre**. Su un riprezzo l'ordine da sostituire **è già dentro** gli
   ordini a riposo ⇒ contato due volte. Evidenza, 12:14:42 su FL-27: «$53.67 di ordini a riposo (2) e
   questo ne aggiungerebbe $11.42» — e $11,42 **era** quell'ordine. Il sottraendo esiste già
   (`:1311`) ma vale solo per la gemella dentro `place`. **Terza occorrenza** di «regola nata per
   limitare l'APERTURA applicata a un'azione che non apre» (§5-bis p.133, p.147, p.168).
   **La cura, e le due condizioni che il difetto insegna**: ① la **stessa funzione**, non una copia
   (`:1782` lo dice già, ed è il reperto D1); ② il nozionale a riposo deve **escludere l'ordine che si
   sta sostituendo**. **Non corretta**: tocca il percorso che piazza, e va fatta con la sua misura.
39. **🟡 IL RESIDUO SU FILL PARZIALE MUORE NELLO STATO MENO ESPOSTO — 17 agosto 2026, per decisione.**
   In `classificaFill` «parziale» e «completo» descrivono la **COPERTURA**, non l'ordine: 40 possedute
   / 0 coperte è `fill-completo`. Il ramo d'ingresso di `auto-close` cancella il residuo **solo** su
   `fill-parziale`, quindi oggi il residuo **sopravvive** nello stato totalmente scoperto e **muore**
   in quello parzialmente coperto — l'opposto dell'argomento scritto in `43523d9`. ⚠ E l'evidenza che
   motivò quel commit (i due `BUY 14¢` che ingrossavano la gamba posseduta) la misura del 17 agosto
   la attribuisce a `rimpiazzo-gamba` / `auto-close-on-fill`, **non** a un residuo sopravvissuto.
   `modalita-chiusura.test.js` asserisce ora il comportamento vero e lo dichiara. **Non toccato**: è
   una decisione di rischio dell'operatore.
31. **🟡 LA MANOPOLA DELLA DISTANZA RESTA A 0,95 — ORA È UNA SCELTA, NON UNA DERIVA (16 agosto 2026).**
   `agents/ecosystem.config.js` porta `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V: '0.95'` su **entrambi** i
   processi che decidono un prezzo (agent40, agent41). Era arrivata lì da una sessione non committata
   e costava **il 99,6% del punteggio** (0,95 ⇒ 4,27¢ su banda 4,5¢ ⇒ S 0,0025 contro 0,605 a 1,0¢).
   **Oggi la manopola non decide più il punto d'arrivo**: il **margine dal bordo** di §4.1 riporta
   l'ordine a `max(1 tick, 0,22 × v)` dentro la banda, e sul piano di prova misurato l'ordine cade a
   **3,4-3,5¢ dal mid con S ≈ 0,05**, cioè venti volte il bordo nudo. L'operatore ha chiesto
   esplicitamente il **bordo esterno**: 0,95 è il modo di chiederlo, il margine è il modo di renderlo
   sostenibile. **La metà «test» di questa voce è chiusa**: `distanza-2c.test.js` distingue ora
   `VALORE = '0.444'` (l'aritmetica) da `VALORE_IN_SERVIZIO = '0.95'` (ciò che l'ecosystem dichiara), e
   il rosso è sparito. **⚠ Resta vero che cambiarla richiede il riavvio COORDINATO dei due processi**
   (§5.1): si usa `node scripts/cli/distanza.js`, che li scrive tutti insieme o nessuno.
34. **🟡 IL MARGINE DAL BORDO NON È DICHIARATO NELL'ECOSYSTEM, ED È VOLUTO (16 agosto 2026).**
   `MAKER_DISTANZA_MARGINE_BORDO_TICK` e `…_FRAZIONE_V` esistono come env ma **non sono scritte in
   `agents/ecosystem.config.js`**: entrambi i processi prendono lo stesso difetto dal codice, quindi un
   riavvio scoordinato **non può** farli divergere. Il prezzo di questa scelta è che per cambiare il
   margine si tocca il sorgente (`lib/maker/distanza-obiettivo.js`) e si riavviano **entrambi**.
   Se un giorno lo si vuole per-processo, va aggiunto **a tutti e due insieme**, come la manopola.
35. **🟡 LA ROTAZIONE TOGLIE IL TETTO SUL NUMERO DI MERCATI ESPOSTI (16 agosto 2026, per decisione).**
   Vedi §4.13: tre quotano, N completano. Le cinture che restano sono il tetto per mercato ($61,25),
   `maxOpenNotionalUsd` ($600) e il kill a $100/giorno. **Non è misurato quanti mercati possano stare
   in gestione contemporaneamente** su book veri — la misura di §5-bis p.162 dice che il **32,1%** dei
   fill si chiude completando la coppia in **28,6 min** mediani, ma su un campione di altri wallet e
   con la nostra size ancora da osservare. **Va guardato al primo giro vivo, prima di alzare il $600.**
36. **🟡 `npm run build` FALLISCE, E LA CAUSA È PREESISTENTE: MANCA `lucide-react` (16 agosto 2026).**
   `app/components/ui/Redacted.tsx` importa `lucide-react`, che **non è in `package.json` né in
   `node_modules`** — è caduto con la riduzione della copia. Il build stampa
   `✓ Compiled successfully` e muore dopo, nel **type-check**: tutto il JS compila, e nessuna delle
   modifiche di oggi è coinvolta. **Non installato**: aggiungere una dipendenza a un repo ridotto è una
   decisione dell'operatore, e su questa copia il `dashboard` non è più nella flotta (§banner in testa),
   quindi il build di Next non serve a nessun processo vivo. Verifica usata al suo posto: la suite
   (`node scripts/ricerca/suite-rossi.js <nome>`) e i 5 selfcheck.
37. **🟡 TRE TEST SONO ROSSI PERCHÉ $150 STA SOTTO `3 × TETTO PER MERCATO` — voluto, 16 agosto 2026.**
   `maxOpenNotionalUsd` a $150 contro `3 × $61,25 = $183,75` rende **false** un'invariante che tre test
   difendevano: `lib/maker/sette-punti.test.js` («il tetto di esposizione totale è 600» — è una
   **fotografia del valore**, §5.3, e va riscritta per leggere il file), `lib/maker/tetti-per-giro-e-scope.test.js`
   («il tetto regge la selezione intera al tetto per mercato — $150 contro $183,75») e
   `lib/rewards/tetto-derivato-dallo-scaglione.test.js` («4 mercati pieni $245 vs $150»).
   Gli ultimi due difendono una **proprietà vera**, che l'operatore ha deciso di non volere più.
   **NON ammorbiditi**: cambiarli richiede decidere quale invariante è ora quella giusta, ed è una
   decisione di rischio. **Il piano di prova gira lo stesso** — $147,00 su tre mercati, sotto il tetto.
   ⚠ **E c'è $3 di esposizione preesistente** (una posizione meteo residua, `data/venue-positions.json`),
   quindi il margine reale è $147 e non $150.
32. **🟡 LE DUE COPIE DELLA POLICY DEI PERMESSI DIVERGONO — 15 agosto 2026.**
   `.claude/settings.json` (progetto) ha la policy completa; `~/.claude/settings.json` è di **22 byte**
   e non ha nessun blocco `permissions`. `lib/safety/policy-permessi.test.js` muore con un
   `TypeError: Cannot read properties of undefined (reading 'ask')` — non è un rosso «dei dati vivi»,
   è la divergenza che quel test esiste per prendere (§2). **Le regole `ask` del progetto continuano a
   valere** (si fondono fra i file e `ask` batte `allow` da qualunque file arrivi), quindi il presidio
   non è caduto — ma la copia utente non porta più niente. **Non corretta qui**: §2 non si riscrive
   senza istruzione esplicita in chat.
33. **🟡 `preparaMercatoNuovo` È CHIAMATA COL PRIMO ARGOMENTO SBAGLIATO NEL GRADINO 4 — 15 agosto 2026.**
   `agents/agent41-realloc-scheduler.js`, gradino `ripara-precondizioni`:
   `await preparaMercatoNuovo({ marketId: id })` passa un **oggetto** dove la firma vuole una
   **stringa**, e **non passa nessuno dei quattro iniettori**. La funzione rifiuta subito
   (`nessuna funzione setEnabled cablata`), quindi `n` resta 0 e il gradino riporta sempre
   «precondizioni riscritte su 0/N». **Quinta occorrenza della classe «dep non cablata»** di §5.3, e
   la stessa forma di §5-bis p.153. **Falliva chiuso** (non scrive niente) e la scala è comunque
   **disarmata al gradino 6**, quindi non ha prodotto danno. **Non corretta**: sta dentro la scala di
   sblocco, che è fuori dal perimetro chiesto in questa sessione, e va corretta con la sua misura.
26. **🟡 `end-of-scale` NON è stata stretta a [0,10 · 0,90] — misurato, 13 agosto 2026.**
   La proposta era allineare la nostra soglia ([0,03 · 0,97]) al punto dove il venue rompe `Q_min`.
   **⚠ MA QUELLA PROTEZIONE ESISTE GIÀ ED È PIÙ PRECISA**: `motore-unico.latoSingolo` deriva la
   frazione da `qMin` (`MID_MIN_UN_LATO = 0,10`, `MID_MAX_UN_LATO = 0,90`) e **cancella** un lato solo
   fuori banda — 48 volte in produzione. Stringere `end-of-scale` impedirebbe di quotare a DUE lati
   dove il venue paga normalmente: toglierebbe reward senza aggiungere protezione.
   **Costo misurato**: 11 mercati nella fascia contesa, 5 utilizzabili per **$666/g** di montepremi;
   nel piano dei migliori sono 4 mercati per **$62,33/g (17,8%)**, e i rimpiazzi valgono $4,28/g.
   `data/ricerca/fine-scala-1090.json`. **Non applicata**, anche perché l'orizzonte si è appena mosso
   e due leve insieme rendono illeggibili le 24 ore di dati che l'operatore ha chiesto.

22. **🟡 IL PIANO SI SVUOTA, E LA CAUSA MISURATA NON È IL FILTRO DI PROFONDITÀ** (13 agosto 2026;
   `data/ricerca/sintesi-profondita.md`, script `scripts/ricerca/taratura-profondita.js`).
   **Il cancello che decide è `pavimentoPremiante(minSize) > tetto per mercato`**, non la profondità:
   sul board delle 20:17 toglieva **56 mercati su 102** contro i 5 della profondità.
   **⚠ CONFERMATO SUL BOARD DELLE 22:0x, a capitale $2.149,88 e tetto $61,25**
   (`data/ricerca/piano-con-distanza-2c.json`): dei **131 candidati, 57 escono per `min-size`** —
   orizzonte 18, profondità 12, `netto-negativo` 8 — e il piano impiega **$1,34-1,39k su $2,15k**, cioè
   **il 35-38% resta fermo**. La leva è **più capitale o un tetto più alto** (§4.2, §5-bis p.117/p.132),
   e alzare il tetto **taglia** i mercati raggiungibili: è la tensione già scritta in §4.2.
   ⚠ Il «superstiti 2 contro 16 minimi» del log di agent41 è reale ma riguarda il **piano ristretto**
   (ramo `onlyMarketIds`), calcolato sui soli mercati già in gestione — non sul board. **Perché il
   ristretto scenda a 2 NON è misurabile dallo stato salvato**: è la lacuna di §5.2 p.10.
1. **I RESIDUI SOTTO IL MINIMO NON HANNO UNA VIA D'USCITA — buco strutturale, §5-bis p.123.**
   **$26,30** in cinque residui che nessun percorso può chiudere. Proposta scritta, **non implementata**
   perché è capitale: è una decisione dell'operatore.
2. **`REALLOC_SCHEDULER_DRY_RUN` vive nella descrizione in memoria di pm2**, non nel dump né in `.env`.
   Oggi vale `0` (freno disinserito) ed è **letta davvero**. `--update-env` **fonde**, non sostituisce:
   una chiave entrata una volta sopravvive a ogni riavvio. L'unica rimozione possibile è
   `pm2 delete` + `pm2 start`. **Non farlo** senza istruzione: azzera i contatori e lascia agent41 giù
   se lo `start` fallisce.
3. **L'header di `lib/maker/strategia-merge.js` è invecchiato**: elenca quattro ragioni per cui il merge
   «non è eseguibile», e il relayer ne ha tolte tre, `ctf-relayer` la quarta. Solo un commento.
4. **Nessun processo sorveglia il battito di agent40** (agent37 rimosso il 9 agosto, conseguenza voluta).
   Se agent40 si blocca con ordini a riposo, a toglierli restano la **scadenza GTD nativa** del venue e,
   sul lato economico, `agent43-guardian` oltre la soglia di perdita.
5. **La ricostruzione del piano non conosce lo scope del rinnovo**: `auto-reprice` itera
   `cfgState.enabledMarketIds`, quindi un mercato fuori dal piano non viene visitato e i suoi ordini
   muoiono per GTD in 23 minuti. **È una decisione documentata**, non un difetto — ma è anche il motivo
   per cui il controllo della gamba orfana non si esercita su quei mercati.
6. **`controlloCapitaleFermo({forzatoDa})` ha di nuovo un chiamante**: la sentinella sul vuoto. Il
   parametro era rimasto senza consumatori dopo §5-bis p.105.
7. **La ricostruzione sotto soglia scatta quasi a ogni giro sul board di oggi** (6 righe utili contro
   una soglia di 12): costa ~13 s di processo figlio ogni 10 minuti. È il comportamento corretto — il
   piano *è* sotto soglia — ma se un domani il board si allargasse stabilmente vale la pena rimisurare.

13. **La soglia sulla derivata per la sentinella È misurabile, ed è l'85%** (§5-bis p.140). Non
   implementata: questa era una sessione di sola diagnosi.
21. **⚑ LE «CANCELLAZIONI CONTINUE» NON SONO UN CICLO DI RIPREZZO — chiusa il 13 agosto 2026.** Vita degli
   ordini n=995: mediana **18,2 min**, sotto i 60 s solo l'1,0% ⇒ un ordine mediano è campionato ~18 volte.
   Dei 4.874 eventi di cancellazione solo 979 portano un `orderId` (1,06 per ordine); gli altri 3.898 sono
   macchina di **chiusura**. `band-exit` è una VALUTAZIONE: su 3.622 giudizi «fuori banda» **ZERO**
   cancellazioni (§5-bis p.155).
19. **🟡 LA CADENZA ADATTATIVA È SOTTO-RISOLTA — sola misura, costo piccolo.** agent40 classifica
   **99,6%** delle osservazioni come «lenta» con escursione 0,00 tick/ora ⇒ polling a 10.000 ms.
   `leggiFinestraTutti` su 15 min vede `rangeMid = 0` sul **48,8%** dei mercati (`mid-history` campiona
   a 75 s); a 240 min i fermi scendono al 13,8%. **⚠ Il conto non torna: 48,8% contro 99,6%, divario
   non spiegato.** ⚠ **Ma non è la leva** — vedi p.20.
9. **🔴 LA SENTINELLA VEDE IL VUOTO, NON IL COLLASSO — buco aperto, misurato il 13 agosto 2026.**
   Il ramo ③ di `lib/maker/sentinella-vuoto.js` dice «`ordiniARiposo > 0` ⇒ il libro non è vuoto» e
   **azzera l'orologio**. Quindi un calo da **23 ordini a 2** — il **91%** — è invisibile: la
   sentinella è tarata sul **caso estremo**, non sulla derivata. Osservato alle 09:08 (lì la causa era
   il guardiano, quindi lo stato era corretto: FERMA ⇒ vuoto giusto). **Ma la lacuna resta per il caso
   in cui il bot è su AVVIA**, ed è proprio il collasso progressivo che nessuno vedrebbe.
   **Non implementato**: la cura è un secondo criterio (calo relativo su una finestra) accanto al
   conteggio assoluto, e va tarato su una misura di quanto oscilla normalmente il numero di ordini —
   misura che oggi non esiste. Non si aggiunge una soglia a occhio a un presidio.
10. **Il costo di `profondita-non-verificata` NON è misurabile dallo stato salvato.** L'esclusione vive
   in `lib/rewards/allocator.js:1104` (`reasonCode: 'profondita-non-verificata'`), che gira in un
   **processo figlio**; `data/realloc-ultimo-piano.json` persiste **solo `righe`**, cioè i vincitori, e
   **nessun file conserva i candidati scartati**. Zero occorrenze in 4 giorni di giornale perché quel
   giornale non è dove finiscono. **Per questo il numero «non è mai stato misurato»: non è che nessuno
   l'abbia guardato, è che nessuno lo scrive.** La cura è una riga — l'istogramma dei `reasonCode`
   scartati accanto a `righe` — e senza quella non si tocca agent34, perché non c'è evidenza di costo.
11. **I rossi noti della suite sono NOVE = 6 rossi + 3 che non partono**, e l'INSIEME dei nomi ruota —
   il conteggio no. **Non partono**: `leg-order` e i due in `lib/venues/__tests__/` (test JS su moduli
   TypeScript). **Rossi**: `dipendenze-collegate` (ternario andato a capo) · `scaduto-senza-rinnovo`
   (fixture riprezzata al primo giro) · `scadenza-ereditata` · `categoria-mercato`,
   `end-of-scale-cycle`, `tetto-orizzonte` (**dipendono dai dati vivi**).
   **Chi confronta la baseline confronti i NOMI** (§5-bis p.134): qui cambiano da soli col board, e un
   membro nuovo non è una regressione — ma va verificato che il rosso non tocchi il codice modificato.
   **Lo strumento c'è**: `node scripts/ricerca/suite-rossi.js <nome>` scrive l'elenco in
   `data/ricerca/suite-rossi-<nome>.json` con la stessa sanificazione d'ambiente di agent44 e la
   cintura sulle impronte di stato. **Verificato il 13/08 22:0xZ: 210 test, 6+3, nomi identici prima e
   dopo le modifiche di stasera, nessuno stato sensibile toccato.**

### 5.3 · Trappole operative — da rileggere prima di lavorare

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


**171** · LA COPERTURA CONTINUA RIMETTE LA GAMBA A LIBRO, CON UN RAFFREDDAMENTO — 17 agosto 2026


**170** · I SETTE TEST ROSSI, PIÙ UNO, PIÙ TRE SELFCHECK — 17 agosto 2026 (da 19 rossi a 12)


**169** · LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — 17 agosto 2026


**172** · COSA È SUCCESSO ALLE GAMBE IL 16 AGOSTO — sola misura, 17 agosto 2026.
Ricostruito dagli eventi di nascita e morte degli ordini (**non** dai referti del maker): 377 ordini,
8 mercati, 133 cadute da due gambe a una. **Copertura piena 50,0 %** (14,70 h contro 7,15 h a gamba
singola e 7,54 h a zero). ⚠ 111 delle 133 cadute durano **3,4 s in mediana** — la finestra fisiologica
del riprezzo; le **22 lunghe valgono il 97,8 % dei minuti** e 17 non sono mai tornate. Riscontro
indipendente sui 75.077 `listOpenOrders` del venue: **31,0 %** di tempo a gamba singola contro il
32,7 % ricostruito. Referto `data/ricerca/gambe-16-agosto.md`, script
`scripts/ricerca/cronologia-gambe-16-agosto.js` (rieseguibile con `GIORNO=`). Da qui vengono §5.2
p.38 e p.39, e la conferma di §5-bis p.21.


**24 · 23 · 22 · 20** · le quattro misure chiuse del 13 agosto (calibrazione agli estremi · quanto
renderebbe più capitale · i mercati sbilanciati · i fill arrivano sul mid fermo) — diagnosi integrale
in `git log` e in `data/ricerca/`.


**27** · I 5 SELFCHECK DI `scripts/` RIMESSI IN SCALA — 15 agosto 2026 (rifatto il 17: vedi p.170)


**21** · IL PAVIMENTO DI PROFONDITÀ NON SI APPLICA PIÙ AI RINNOVI — 16 agosto 2026, `63c10a0`,
`esenzione-rinnovo.provaRinnovo`. ⚠ Confermato dalla misura del 17: **2.100 blocchi** in giornata
(308 `anomalia-rinnovo-fermato` + 1.792 `skip-motore-non-conforme`), tutti fra le 11:00 e le 15:59 e
**zero dopo le 16:00**, cioè dopo il commit. Costo: **65,0 minuti** di gamba singola.


**168** · IL TETTO DI ESPOSIZIONE ESENTA LE CHIUSURE PROVATE, E SCENDE A $150 — 16 agosto 2026


**167** · SELEZIONE A TRE, PER COMPOSIZIONE, CON ROTAZIONE — decisione dell'operatore, 16 agosto 2026


**166** · FILL PARZIALE: IL RESIDUO NON SI CANCELLA ALL'INGRESSO, MA ALLA COPPIA — 16 agosto 2026


**165** · UN SOLO TETTO DI COPPIA, 101¢, E LA RESA A 60 MINUTI — decisione dell'operatore, 16 agosto 2026


**164 · IL TETTO PER ORDINE ERA «METÀ MERCATO» E RIFIUTAVA LA GAMBA CARA; IL BORDO DELLA BANDA ERA
NUDO — 16 agosto 2026.** Due correzioni che nascono dalla stessa domanda dell'operatore («$147 al
pavimento premiante, ordini al bordo esterno») e che senza misura sarebbero passate per configurazione.
**① IL TETTO.** `LIVE_MIN_ORDER_CAP_USD = tetto/2 + $5 = $35,63` è la gamba giusta **solo a mid 0,49**.
A mid 0,90 la gamba cara vale il 92% del capitale del mercato: il precontrollo atomico di §5 p.115
vedeva una gamba oltre il tetto e abbandonava la coppia **intera** — `coppia-non-atomica`, **prima
causa di perdita di gambe**, 84 gambe e $1.276,13 in 24 h (§5 p.129-130). Adesso il tetto è
`tetto × PREZZO_MASSIMO_QUOTABILE / COSTO_COPPIA + $5 = $65,63`, cioè dimensionato sulla **gamba
peggiore quotabile**. `finestraMid` ricalcolava la derivazione vecchia (copia D1) e ora **importa**:
la finestra passa da `[0,43 · 0,57]` a `[0,01 · 0,99]`, cioè smette di essere un cancello.
**⚠ La premessa dell'operatore era inesatta e va detto**: `data/safety-risk-limits.json` **c'era**, con
`maxOrderNotionalUsd: 1000`; scriverci $80 da solo non avrebbe cambiato niente, perché la cintura che
mordeva era la derivata. Scritto $80 come chiesto ⇒ **tetto effettivo `min($80, $65,63) = $65,63`**.
**② IL BORDO.** `bordiConMargine` in `distanza-obiettivo.js`: `max(1 tick, 0,22 × v)` dentro il bordo.
**Il difetto l'ha trovato l'anteprima, non il ragionamento**: un margine in **tick** è adattivo alla
griglia, non al mercato — su un mercato a tick 0,1¢ (Ballon d'Or) un tick è il 2,2% della banda e
l'ordine restava a 4,4¢ dal mid con **S = 0,0011**. 0,22 è esattamente un tick sulla banda modale
(1,0¢ / 4,5¢), quindi il margine vale gli stessi centesimi su qualunque griglia.
**È anche la risposta all'oscillazione che l'operatore ha chiesto di risolvere**: uscita a
`v + hysteresisTicks`, **rientro a `v − margine`** — uno Schmitt trigger. `hysteresisTicks` e
`confirmSamples` **non sono stati toccati**, come chiesto: cambia *dove* si rientra, non *quando* si
esce. Misurato sulla formula del venue: **S 0,0123 al bordo nudo contro 0,1111 un tick dentro, 9×**.
**⚠ Il margine non può mai superare il prezzo di coda** (`Math.min` col prezzo che «mai primo sul
libro» ha già scelto, con `margineCeduto` dichiarato) e bordi incrociati ⇒ margine non applicato.
**⚠ E UN SECONDO DIFETTO, trovato dal selfcheck del riprezzo e non dal ragionamento**: su banda ±1,5¢
con tick 1,0¢ il margine portava il bersaglio da 0,52 a **0,53, che È il mid** — il margine difendeva
il bordo sostituendolo col centro. Cura: `FRAZIONE_MASSIMA_DEL_RAGGIO = 0,5`, costante di sorgente e
**senza env** (un margine che può diventare il mid è un rischio di fill, e i rischi non si aprono con
una variabile d'ambiente). Su una banda più stretta di due tick il margine vale **zero**, e il bordo
torna nudo.
Test: `distanza-obiettivo.test.js` blocco ③-bis (58 asserzioni, con la proprietà «margine ≤ metà
banda» provata su sei griglie), più i tre che passavano `bordiConMargine` senza banda.

**163** · GLI «EFFICIENTI» DENTRO I 65: CAPITALE PICCOLO E TRADING IN PARI — sola ricerca, 15 agosto 2026


**162** · COME ESCONO I 65 DOPO UN FILL — sola ricerca, 15 agosto 2026


**161** · CHI FA DAVVERO LIQUIDITY REWARDS, E DOVE QUOTA — sola ricerca, 15 agosto 2026


**160** · LA MANOPOLA DELLA DISTANZA ACCESA A 0,444 — TEST DELL'OPERATORE, 13 agosto 2026, sera


**159** · IL GRADINO 6 DISARMATO PER CONFIGURAZIONE — decisione dell'operatore, 13 agosto 2026, sera


**158** · LA MANOPOLA DELLA POSIZIONE, INSTALLATA E SPENTA


**157** · IL RIFERIMENTO DEL GUARDIANO: DRAWDOWN DA MASSIMO MOBILE


**156** · IL TETTO PER MERCATO PASSA A $61,25, E SMETTE DI DERIVARE DA `f_min`


**155** · LA BANDA PREMIANTE ERA LARGA LA METÀ — `v = max_spread`, NON `max_spread/2`


**154** · IL FILTRO DI PROFONDITÀ NON STA AFFAMANDO IL PIANO — sola misura, niente toccato


### Le tre voci del 13 agosto 2026

**120** · IL DEADLOCK ARITMETICO CHE HA FERMATO IL BOT PER TRE ORE


**121** · LA SENTINELLA SUL VUOTO


**122** · UNA POSIZIONE SENZA SCADENZA È UNA POSIZIONE CHE NESSUNO CHIUDERÀ


**123** · I RESIDUI SOTTO IL MINIMO — BUCO STRUTTURALE APERTO, non implementato


**138 · LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA — ⚠ LA DIAGNOSI DI QUESTA VOCE ERA SBAGLIATA,
corretta il 16 agosto 2026 con la misura.** Qui c'era scritto che «l'orologio si azzera a ogni nuovo
ingresso in modalità chiusura». **NON È VERO, e chi riapre non deve rifare quella diagnosi**: il
16 agosto una posizione su FL-27 è rimasta aperta **cinque ore**, e `data/modalita-chiusura.json`
portava `da: 15:20:41Z` — l'istante esatto del fill — per tutte e cinque, con la dep `chiusura`
cablata correttamente in agent40. L'ancora non si era mai mossa.
**LE DUE CAUSE VERE**, trovate contando `urgenzaLivello` nel giornale (**una sola occorrenza in
cinque ore**): ① il ramo **`already-covered`** di `decideClose` **ritorna prima di ricalcolare il
prezzo** — l'uscita si piazza una volta, al gradino di quel momento, e non scende mai più; ② **
`planExit` produce un PAVIMENTO, non un prezzo**: al gradino 2 concedeva 19¢ e l'uscita restava a
20¢ sopra un book 16/18. Il permesso c'era, il prezzo no, e nessuno consumava il pavimento.
**Corretto**: `already-covered` ricalcola e, dal gradino 1 in su, l'uscita **insegue il miglior ask**
fermandosi al pavimento — la scala dice quanto si può perdere, il book dove si viene presi, vince il
più stretto. Riduce e basta (solo se il prezzo nuovo è più basso di un tick), e `peggiorativa` segue
il prezzo finale. Test `uscita-scende-con-la-scala.test.js`: 16 asserzioni che esercitano ogni
gradino **fino allo scatto sul prezzo**, non fino alla condizione.


**152** · IL BORDO DELLA BANDA NON CONVIENE — ⚠ NUMERI CORRETTI DA §5-bis p.155


**151** · IL REDEEM È UNA VIEW, NON GESTIONE DEL RESIDUO — corregge §150


**150** · COSA FANNO GLI ALTRI DOPO UN FILL — sola ricerca


**149** · CHI INCASSA DAVVERO I REWARD — sola ricerca, 30 giorni on-chain


**147** · L'ESENZIONE DAL TETTO PER ORDINE VALE SU TUTTI I PERCORSI CHE RIDUCONO


**148** · IL REGISTRO DEI RESIDUI HA FINALMENTE UN CONSUMATORE


**145** · LE DUE CONFERME DEVONO ESSERE DUE OSSERVAZIONI, NON DUE COPIE


**146** · I RESIDUI BLOCCATI, MISURATI — sola diagnosi


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


**128** · RESIDUI SOTTO SOGLIA: NON SI PUÒ IMPEDIRE CHE NASCANO — non implementato, con i numeri


**129** · IL FILTRO ORIZZONTE COSTA 5,4× E NON PROTEGGE DA CIÒ CHE DICHIARA — misurato, NON implementato


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

| # | voce |
|---|---|
| 1 | Il bot non è mai stato avviato —  alle 12:07:55 UTC dell'8 agosto 2026 |
| 2 | La copertura dichiarata di FERMA non corrisponde al runtime di agent35 —  il 9 agosto 2026 rimuovendo il processo (§5 punto 63) |
| 3 | `REALLOC_SCHEDULER_DRY_RUN=1` resta nell'ambiente del processo agent41 — PER DECISIONE DELL'OPERATORE (8 agosto 2026), e un riavvio non può toglierla |
| 4 | L'header di `lib/maker/strategia-merge.js` è invecchiato |
| 5 | Arming disarmato da un kill ormai revocato —  il 9 agosto 2026: l'arming non esiste più |
| 6 | `data/maker-bot-enabled.json` e `data/cancellazioni-di-emergenza.json` non sono coperti da `.gitignore` |
| 7 | Il codice della sera del 7 agosto non è attivo —  alle 23:57 UTC del 7 agosto 2026 |
| 8 | `pgrep -f <nome-processo>` non è affidabile in questa sessione |
| 9 | Il codice dell'8 agosto non è nei processi —  alle 07:22 UTC dell'8 agosto 2026 |
| 10 | L'obiettivo non sente il tetto di credibilità —  l'8 agosto 2026, sera |
| 11 | Il confronto non ha ancora un dato —  l'8 agosto 2026, sera |
| 12 | I cinque test rossi: diagnosi fatta, correzione da decidere |
| 13 | Il caso degenere della concorrenza misurata ZERO —  l'8 agosto 2026, sera |
| 14 | Il lavoro sull'allocatore NON richiede riavvii, e vale la pena saperlo una volta per tutte |
| 15 | La rinomina non è ancora in pm2 —  alle 09:15:41 UTC dell'8 agosto 2026 |
| 16 | `agent44-audit-scoperta` esiste, gira alle 03:07 UTC, e la sua coda va guardata |
| 17 | Il trigger a capitale fermo non è nel processo —  alle ~11:24 UTC dell'8 agosto 2026 |
| 18 | La correzione del consumo di agent40 è in `main` ma non nel processo —  alle 12:07:06 UTC dell'8 agosto 2026 |
| 19 | IL PRIMO AVVIO NON HA UN INNESCO, e nessuno dei due percorsi lo copre |
| 20 | L'hook di piazzamento blocca anche il ciclo di agent41 lanciato a mano — ed è — , ma va saputo prima |
| 21 | Il trigger a $50 non ha MAI funzionato —  in `main`, ASPETTA IL RIAVVIO DI agent41 |
| 22 | Tre cose che il fix ha scoperto — le prime due CHIUSE l'8 agosto sera, la terza no |
| 23 | Il tetto di orizzonte non basta: l'universo eleggibile è zero —  l'8 agosto 2026 sera, ASPETTA IL RIAVVIO DI agent24 |
| 24 | IL 10 AGOSTO ALLE 01:01:33Z IL RESET CANCELLA TUTTO, se il board non è aggiornato per allora |
| 25 | La misura che ha fatto scattare tutto, tenuta come riferimento |
| 26 | DUE POSIZIONI APERTE SENZA VIA D'USCITA —  alle 16:49:18Z dell'8 agosto 2026 |
| 27 | I Livelli 1 e 2 non sono mai stati raggiunti —  alle 16:49:18Z dell'8 agosto 2026 |
| 28 | IL RIAVVIO DI agent40 ARMA UN COMPORTAMENTO NUOVO SU CAPITALE REALE — ESEGUITO alle 16:49:18Z dell'8 agosto 2026 |
| 29 | IL LIVELLO 1 (TAKER) NON PUÒ ESEGUIRE, ed è una protezione che NON è stata toccata |
| 30 | Verifica del gate fatta per test unitario, non sui dati vivi — e per una ragione buona |
| 31 | I DUE MERCATI CON POSIZIONE APERTA SONO TORNATI NELLA ALLOWLIST — 17:05:30Z dell'8 agosto 2026, su richiesta esplicita dell'operatore |
| 32 | SCHWARTZEL NON COMPLETA LA COPPIA: `closeTask` NON INIETTA `cancelOrder` —  in `main` l'8 agosto 2026 sera, ASPETTA IL RIAVVIO DI agent40 |
| 33 | La stessa guardia, un ramo più in là: `null` non è una cancellazione riuscita |
| 34 | TRE RIAVVII PENDENTI — ESEGUITI DALL'OPERATORE alle 18:30:52 / 18:31:02 / 18:31:16 UTC dell'8 agosto 2026 |
| 35 | Il 75,9% e non il 90%: il target non si raggiunge sempre, ed è il punto |
| 36 | `REALLOC_PIANO_LEGGERO_ORE` è il primo parametro che governa quanta memoria consuma un figlio |
| 37 | LA RICERCA SULLE CATEGORIE È FATTA, E RIBALTA LA LETTURA OVVIA |
| 38 | LE OTTO FASI DELL'8 AGOSTO SERA — IN `main`, E ASPETTANO QUATTRO RIAVVII |
| 39 | QUATTRO RIAVVII PENDENTI per le otto fasi |
| 40 | I ROSSI NOTI SONO SCESI DA QUATTRO A TRE |
| 41 | IL MINI-CICLO SCEGLIEVA MERCATI CHE POI NON POTEVA TOCCARE —  in `main` l'8 agosto 2026, ~21:30 UTC. ASPETTA IL RIAVVIO DI agent41, DA CONFERM |
| 42 | UNA GAMBA CANCELLATA BRUCIAVA LA SUA CHIAVE PER SEMPRE —  in `main` l'8 agosto 2026, ~22:20 UTC. ASPETTA IL RIAVVIO, DA CONFERMARE DA DIEGO IN |
| 43 | IL TETTO GIORNALIERO DI APERTURE È STATO RIMOSSO — 9 agosto 2026, ~02:40 UTC. ASPETTA IL RIAVVIO DI agent41 E DEL DASHBOARD, DA CONFERMARE DA DIEGO IN |
| 44 | UN MERCATO CHE ESCE DAL BOARD PERDEVA LA GESTIONE —  in `main` il 9 agosto 2026, ~03:50 UTC. GLI 11 ORFANI SONO GIÀ SANATI E VERIFICATI SUI DA |
| 45 | IL MERGE ON-CHAIN È COLLEGATO AL FLUSSO — `CTF_RELAYER_ENABLED` RESTA `false`, IN ATTESA DI AUTORIZZAZIONE ESPLICITA DI DIEGO IN CHAT |
| 46 | IL PERIODO DEL BOARD ERA 22,5 MINUTI, NON 15 —  in `main` il 9 agosto 2026, ~04:40 UTC. ASPETTA IL RIAVVIO DI agent24 E agent41, DA CONFERMARE |
| 47 | IL RIPIEGO DELLE REGOLE COPRIVA UN PERCORSO SU DUE — ESTESO il 9 agosto 2026 |
| 48 | LO SPLIT NON VA COLLEGATO, E LA MISURA È NETTA — deciso il 9 agosto 2026, nessun codice scritto |
| 49 | `CTF_RELAYER_ENABLED = true` — ACCESO il 9 agosto 2026, ~04:30 UTC, su istruzione esplicita di Diego in chat. IN `main` E NEI PROCESSI |
| 51 | LA SEQUENZA COMPLETA DEL LATO SCOPERTO — in `main` il 9 agosto 2026, ~05:45 UTC. ASPETTA IL RIAVVIO DI agent40 |
| 52 | IL MERGE ON-CHAIN NON HA MAI FIRMATO: `deps.signerProvider` NON ERA CABLATO —  in `main` il 9 agosto 2026, ~07:05 UTC. ASPETTA IL RIAVVIO DI a |
| 53 | I TETTI DI CAPITALE ERANO FERMI AL CAPITALE DI TRE ORE PRIMA, E IL 90% ERA IRRAGGIUNGIBILE PER COSTRUZIONE —  in `main` il 9 agosto 2026, ~07: |
| 54 | LA REGOLA GENERALE DEL LATO SCOPERTO — decisa da Diego il 9 agosto 2026, in `main` alle ~08:05 UTC |
| 55 | IL TETTO DELLA CATENA DI SOSTITUZIONI MURAVA UNA GAMBA VIVA —  in `main` il 9 agosto 2026, ~08:35 UTC. ASPETTA IL RIAVVIO di agent40 e agent41 |
| 56 | IL LIVELLO 3 USCIVA IN SILENZIO —  il 9 agosto 2026, stesso commit |
| 57 | CINQUE MERCATI FINTI NEI DATI VIVI — rimossi il 9 agosto 2026 |
| 58 | 🔴 IL CAPITALE ERA CONTATO DUE VOLTE — BUG DI SICUREZZA OPERATIVA, non estetico. Corretto in `main` il 9 agosto 2026, ~10:00 UTC. ASPETTA IL RIAVVIO d |
| 59 | ⚠️ L'UNICA ECCEZIONE A «MAI PRIMI SUL LIBRO» — mirata, circoscritta, decisa da Diego il 9 agosto 2026. In `main` alle ~10:30 UTC. ASPETTA IL RIAVVIO d |
| 60 | «PRIMO ASSOLUTO» SI MISURA SUL LIBRO, NON SULLA BANDA —  il 9 agosto 2026, ~11:00 UTC. ASPETTA IL RIAVVIO di agent40 |
| 61 | IL BOT NON VEDEVA IL LIBRO DEI MERCATI IN CUI AVEVA DEI SOLDI —  il 9 agosto 2026, ~12:00 UTC. ASPETTA IL RIAVVIO di agent34 |
| 62 | VISTI MA INTOCCABILI — la TERZA volta della stessa lacuna, il 9 agosto 2026, ~12:20 UTC. ASPETTA IL RIAVVIO di agent40 e agent41 |
| 63 | 🧹 MAKER ARMING, agent35-maker E agent37-maker-watchdog SONO STATI RIMOSSI — 9 agosto 2026, ~14:00 UTC, su decisione esplicita di Diego. In `main`. DU |
| 64 | IL TETTO DI CREDIBILITÀ ERA UN'ATTENUAZIONE E ORA È ANCHE UN CANCELLO — in `main` il 9 agosto 2026, ~17:45 UTC. ASPETTA IL RIAVVIO di agent41, DA CONF |
| 65 | TETTO PER MERCATO FISSO A $130 E NESSUN LIMITE DI POSIZIONI — decisioni di Diego, in `main` il 9 agosto 2026, ~18:50 UTC. ASPETTA IL RIAVVIO di agent4 |
| 66 | LA RISPOSTA AL FILL: QUATTRO CORREZIONI, E IL CABLAGGIO CHE LE RENDE EFFETTIVE — 9 agosto 2026, ~20:15 UTC. agent40 RIAVVIATO su autorizzazione di Die |
| 67 | IL QUARTO PUNTO DEL TETTO: $25 PER ORDINE CONTRO $130 PER MERCATO —  e DEPLOYATO il 9 agosto 2026, ~21:04 UTC. TRE RIAVVII ESEGUITI su autoriz |
| 68 | LA GAMBA ORFANA VENIVA RINNOVATA ALL'INFINITO —  in `main` il 9 agosto 2026, ~22:10 UTC. ASPETTA IL RIAVVIO di agent40, DA CONFERMARE DA DIEGO |
| 69 | IL GATE live-min LEGGEVA LA LISTA STRETTA: L'UNIONE DEL PUNTO 62 NON ARRIVAVA AL PIAZZAMENTO —  in `main` il 9 agosto 2026, ~22:15 UTC. TRE PR |
| 70 | IL GUARDIANO DELLE PERDITE È SCATTATO — 9 agosto 2026, 21:46:38 UTC. PRIMO SCATTO REALE |
| 71 | IL REGISTRO DA 731 MB: LETTURA INCREMENTALE SU TUTTI I PUNTI NOTI — in `main` il 9 agosto 2026, ~23:00 UTC. agent40 (71) e agent41 (51) RIAVVIATI |
| 72 | UN FILL VALEVA UNA VOLTA PER RIPIAZZAMENTO —  in `main` il 9 agosto 2026, ~23:25 UTC. agent40 (72) e agent41 (52) RIAVVIATI |
| 73 | IL RIPREZZO È DIVENTATO ATOMICO NEL SENSO CHE CONTA: NON CANCELLA CIÒ CHE NON PUÒ RIPIAZZARE — in `main` l'11 agosto 2026, ~19:20 UTC. agent40 RIAVVIA |
| 74 | VERIFICA COMPLETA E RIAVVIO PULITO DELLA FLOTTA — 11 agosto 2026, 20:21-20:50 UTC, su autorizzazione esplicita di Diego. Nessuna modifica di codice: s |
| 75 | I DUE LAVORI DELL'11 AGOSTO SERA, MAI DOCUMENTATI FIN QUI |
| 76 | IL TETTO PER ORDINE NON RIGUARDA CHI CHIUDE, E UN TAKER NON MIRA AI PROPRI ORDINI — in `main` il 12 agosto 2026, ~09:00 UTC. agent40 e dashboard RIAVV |
| 77 | LA CHIUSURA RIPROVA, LA SORELLA CRESCE, E UN MERCATO MORTO NON RESTA IN SEI REGISTRI — in `main` il 12 agosto 2026, ~09:30 UTC. agent40 RIAVVIATO |
| 78 | IL PANNELLO NON DICHIARAVA I PROPRI ORDINI, E LA SELEZIONE ERA SCRITTA A MANO IN DUE PUNTI —  il 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 79 | `clobRewards` ASSENTE NON È `clobRewards` A ZERO — 12 agosto 2026. NESSUN RIAVVIO NECESSARIO per la ricerca; il dashboard serve il gate, quindi il suo |
| 80 | `inCoda` E `priceAdjusted` ARRIVANO IN `execution-audit` E SUL PANNELLO — 12 agosto 2026. ASPETTA IL RIAVVIO del dashboard e di agent40 |
| 81 | IL LATCH DEL GUARDIANO SCADE, E NON SI FIDA PIÙ DI SE STESSO — 12 agosto 2026. ASPETTA IL RIAVVIO di agent43 |
| 82 | LA PULIZIA DEI REGISTRI NON DIPENDE PIÙ DA CHI ITERA COSA — 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 83 | UN 429 SU `/positions` NON FERMA PIÙ IL BOT — 12 agosto 2026. ASPETTA IL RIAVVIO di agent40 |
| 84 | LA BASELINE DEI TEST È CAMBIATA: 7 ROSSI, NON PIÙ 8 |
| 85 | LA CHIUSURA FORZATA A 3 ORE ESISTEVA E NON POTEVA SCATTARE — 12 agosto 2026 |
| 86 | IL CONSUNTIVO REWARD SI RECUPERA A RITROSO — 12 agosto 2026 |
| 87 | IL REGISTRO DEI REWARD INCASSATI — 12 agosto 2026 |
| 88 | PERSISTENZA DOPO CRASH, PROVATA CON UN `kill -9` — 12 agosto 2026 |
| 89 | SOLI SUL LATO: AL BORDO ESTERNO DELLA BANDA — 12 agosto 2026 |
| 90 | LA QUOTABILITÀ È UN FILTRO A MONTE, E IL CAPITALE LIBERATO SI RIDISTRIBUISCE — 12 agosto 2026 |
| 91 | ⚠ LA SCANSIONE DEI REGISTRI AVEVA ROTTO UN'INVARIANTE, e un test l'ha preso |
| 92 | VOCE 1 · LA SOVRASTIMA DEL 465% È UN TASSO LETTO COME QUANTITÀ — sola diagnosi |
| 93 | VOCE 3 · LE DUE CADENZE ERANO GIÀ A TERRA: VERIFICATE E BLOCCATE |
| 94 | VOCE 4 · TRE CECITÀ DIVERSE SOTTO LO STESSO OROLOGIO |
| 95 | VOCE 5 · VERIFICA DI TENUTA DEI BLOCCHI A+B: TRE PUNTI REGGONO, IL QUARTO AVEVA UNA LACUNA |
| 96 | VOCE 6 · IL RESET DISTINGUE PER ORIGINE — MA UNA SORGENTE SU TRE HA IL NOME SBAGLIATO |
| 97 | VOCE 2 · RIAVVII AUTOMATICI ROBUSTI, E IL DASHBOARD CHE NON SI RIALZAVA |
| 98 | IL ROSSO CHE LA SUITE HA TROVATO, E CHE NON VENIVA DA OGGI |
| 99 | IL CARICATORE `.env` SUI TRE AGENT RESTANTI, MA RISTRETTO |
| 100 | OPZIONE A: LA STIMA DIVENTA UNA QUANTITÀ INTEGRATA |
| 101 | LA COSTANTE SBAGLIATA, E PERCHÉ CORREGGERLA DA SOLA SAREBBE STATO UN DANNO |
| 102 | UNA SOLA MISURA DI ORIZZONTE, E LO SCARTO A MONTE |
| 103 | IL FRENO DI PROVA, CHE PRIMA NON ESISTEVA |
| 104 | UNA SOLA VERITÀ SUL CAPITALE |
| 105 | PERCHÉ IL MINI-CICLO NON PIAZZA — DIAGNOSI, NON —  |
| 106 | IL LEDGER NETTATO, E `skipped` CHE NON SPARISCE PIÙ |
| 107 | IL TETTO DERIVATO |
| 108 | UNA SOLA FORMULA CAPITALE→SHARE |
| 109 | LA COERENZA A VALLE, E UNA MISURA CHE CORREGGE UNA STIMA DI OGGI |
| 110 | IL RAMO `skip` INGHIOTTIVA LA GERARCHIA, E LA DECISIONE USCIVA MUTA —  il 12 agosto 2026, ~19:00 UTC. agent40 RIAVVIATO |
| 111 | PERCHÉ L'UTILIZZO ERA AL 7,5% — E NON È IL TETTO DERIVATO. Sola diagnosi, nessun codice |
| 112 | OPZIONE B: IL TRONCAMENTO PROVATO RESTITUISCE L'ORA VERA — 12 agosto 2026, ~19:40 UTC. agent24 RIAVVIATO |
| 113 | LA «FINESTRA DI MID» NON È UN CANCELLO — sola diagnosi, nessuna correzione |
| 114 | I TETTI PER GIRO ALZATI, E IL TETTO ANTI-RUNAWAY CHE AFFAMAVA IL RINNOVO — 12 agosto 2026, ~21:40 UTC. Decisione dell'operatore: il capitale deve lavo |
| 115 | IL PIAZZAMENTO DELLA COPPIA È ATOMICO IN PRECONTROLLO — 12 agosto 2026, ~21:55 UTC |
| 116 | LA QUOTA 60/40 SULLA FINESTRA — implementata, ma la premessa era sbagliata (12 agosto 2026) |
| 117 | `REWARD_MAX_CLOB_MARKETS` È GIÀ AL MASSIMO: 150 — sola diagnosi, nessuna modifica |
| 118 | IL CAPITALE AL LAVORO: UN NUMERO, UN OBIETTIVO, E IL FERMO RIPARTITO IN DOLLARI |
| 119 | L'ANELLO DEL FEED APERTO, E IL TURNOVER CHE NON SI CORREGGE DA LÌ — 13 agosto 2026, ~00:45 UTC |

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
- **SI SCRIVE GIÀ COMPATTO.** Questo file ha raggiunto **494k caratteri** ed è stato compattato a
  ~86k il 13 agosto 2026: la causa era che ogni voce veniva scritta come un *racconto* invece che come
  una *regola*. La regola d'oro: **§4 dice cosa è vero adesso, §5 cosa è ancora aperto, §5-bis è la
  mappa.** Una voce chiusa scende a una riga nel registro, mantenendo il suo numero originale — i
  commenti nei sorgenti citano «§5 punto N» e quel riferimento deve restare risolvibile. La storia
  integrale non va copiata qui: sta in `git log` e nei commit citati nei sorgenti.
- **⚠ AL 17 AGOSTO 2026 IL FILE È A ~148k SU 150k: il margine è ~1,8k, cioè una voce.** Chi aggiunge
  qualcosa comprima **prima** — i candidati sono le voci di §5.2 già marcate 🟢 o «⚑ misura chiusa»,
  che per regola scendono a una riga in §5-bis.
- **Il tetto è 150k caratteri.** Superarlo significa che il file non entra più nel contesto di una
  sessione, cioè che smette di fare il proprio mestiere. Se lo si supera, si compatta **nella stessa
  sessione** — non si rimanda.
- **§2 non si tocca** senza istruzione esplicita dell'utente in chat.
- Aggiorna la data di «ultima verifica» in cima quando rivedi §3/§4.
- Il file va **committato e pushato** insieme al lavoro che lo ha reso obsoleto, non dopo.> ## 🔁 IL GIRO DI PROVA È ARMATO, E LA PRIMA GIORNATA HA INSEGNATO TRE COSE — 16 agosto 2026
> **ARMATO**: `MAKER_MODE=live-min` · `MAKER_PLACEMENT=send` · `MAKER_ADAPTER_DRYRUN` vuota · freno di
> agent41 disinserito · **`MANUAL_ORDER_PLACEMENT=send`** — ed è **la quinta cintura, non un doppione**:
> governa la CORSIA MANUALE (`manual-order.js:250`, «Deliberately NOT MAKER_PLACEMENT»), che è la strada
> da cui il bot piazza davvero (`source: manual-ui`). Con le altre quattro già tolte, i `postOrder`
> uscivano `dry-run-validated` — costruiti, passati da tutti i gate, fermati prima della POST.
> **PRIMI ORDINI VERI alle 10:46:42Z**, due gambe su FL-27, `status:"live"`.
> **⚠ TRE DIFETTI TROVATI IN PRODUZIONE, TUTTI MIEI, E VALE PIÙ LA CLASSE DEL SINGOLO CASO:**
> **① LA CORSA DEL RIPREZZO** — due `manual-replace` a 3 s sullo stesso `orderId` ⇒ due ordini identici
> a libro, due volte in un'ora. L'anti-churn **era già ancorato al mercato**: non ha protetto perché
> `readAutoRepriceState` legge a inizio ciclo e scrive alla fine. Corsa lettura/scrittura, non di chiave.
> Cura: `lib/maker/lock-mercato.js`, lock per `conditionId` sull'intera sequenza cancel+place, rilasciato
> in un `finally` (il giro esce da venti `continue`), TTL **20 s** che dichiara lo stato **incoerente**.
> **② UN RICONCILIATORE CHE AGISCE SULL'ANELLO CHE OSSERVA NON SI FERMA PIÙ.** Avevo fatto chiamare
> `controlloCapitaleFermo` a ogni giro scoperto: **799 ricostruzioni del piano consecutive**, agent41 da
> 9 a 14 riavvii, e — peggio — un **quarto mercato** aggiunto alla allowlist, perché quel trigger abilita
> ciò che il PIANO sceglie e il piano non conosce i tre slot. Ora dichiara e basta.
> **③ UN LOCK CORRETTO PUÒ ESSERE PEGGIO DEL DIFETTO SE LA CADENZA È SBAGLIATA.** Con `POLL_MS=1000` i
> cicli si sovrappongono quasi sempre: **789 `riprezzo-in-corso` e ZERO `manual-replace` in 22 minuti**,
> 3 ordini morti di GTD senza rinnovo. Riportato a **5000 ms** — l'event-driven resta (`cadenza-adattiva`
> valuta appena il feed pubblica); 5000 è il PAVIMENTO DI RIPOSO, non il tetto alla reattività.
> **LE ALTRE DECISIONI DELLA GIORNATA**: orizzonte minimo **168 → 24 h** (fra 48 e 168 h il board è
> vuoto: 168/96/48 danno piano identico e VUOTO, 24 h sblocca 27 ammissibili) · **vincolo delle tre
> categorie TOLTO** (23 dei 26 ammissibili sono `elections`: la diversificazione teneva due slot sui
> mercati **peggiori**, netto −$0,111/g e +$0,026/g contro +$10,64/g escluso) · **selezione ordinata per
> NETTO del knapsack** iniettato, non per lordo a $500 · **riclassificazione** con isteresi
> `max($0,50/g, 25%)`, che non spodesta chi ha ordini vivi o una gamba in attesa · **tetto per mercato
> anche sul nozionale A RIPOSO** (`nozionale-mercato-oltre-tetto`) e **divieto di doppioni** al
> piazzamento · `maxOpenNotionalUsd` **600 → 150** con le chiusure esentate per prova ·
> **mid stantio 20 → 120 s**: cancellava a 20 s ciò che `decideReprice` non era disposto a riprezzare
> prima di 60 s.
> **⚠ APERTO**: la allowlist ha **4 mercati** contro i 3 della selezione — il trigger a capitale fermo
> abilita fuori dagli slot. `0x776841ce` è stato sostituito da `0xf2b0c93903a1` ma è rimasto abilitato.




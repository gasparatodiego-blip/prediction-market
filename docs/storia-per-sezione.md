# Storia per sezione — archivio delle parti storiche di CLAUDE.md

> Estratto da `CLAUDE.md` il 22 agosto 2026 nella potatura sotto i 120k.
> Ogni blocco è **VERBATIM** e porta il nome della sezione da cui viene.
> In CLAUDE.md è rimasta la REGOLA VIVA; qui c'è il racconto di come ci si è arrivati.

---

## §5.1 · Riavvii pendenti — testo integrale prima della potatura del 22 agosto 2026

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


---

## §4.13 · Selezione automatica dei mercati — testo integrale prima della potatura del 22 agosto 2026

### 4.13 · La selezione automatica dei mercati — `lib/maker/selezione-mercati.js` (15 agosto 2026)

Fino a qui la lista dei mercati quotabili si riempiva **a mano** (`scripts/cli/mercati.js aggiungi`).
Adesso la riempie il bot, dentro i vincoli dell'operatore. **La decisione è PURA** (zero `require`, un
test lo asserisce); il cablaggio sta in `agent41` e passa dalle **stesse** funzioni di prima —
`preparaMercatoNuovo` per chi entra, `rilasciaDallaSelezione` → `setAutoReprice` per chi esce.

| | |
|---|---|
| **vincoli** | `rewardsMinSize ≤ 50` · **scadenza ≥ 24 h** e **≤ `MAX_HORIZON_DAYS`** · **niente famiglia meteo** · **max N ATTIVI dove N = `MAKER_MERCATI_CONTEMPORANEI`** (R1: ambiente di agent41, un posto solo, letto da `/proc`; **soffitto e difetto 10 dal 22/08**, era 5 dal 18/08 e 3 prima — il difetto E' il soffitto, `quanti-mercati.js` lo importa) · **book UTILIZZABILE** (18/08 sera: `needsResnapshot === false` e un book esiste — v. il riquadro qui sotto) · **composizione DERIVATA da N** (`quotaScaglioni`): N≥2 ⇒ 1 «basso» (≤20) + (N−1) «alto» (≤50); N=1 ⇒ un secchio solo, che ammette tutto — con la regola stretta un unico slot potrebbe ospitare solo un minSize ≤ 20 e restare vuoto. ⚠ **168 → 24 h**: fra 48 e 168 h il board è VUOTO (168/96/48 danno piano identico e vuoto, 24 h sblocca 27 ammissibili). ⚠ **Il vincolo delle 3 CATEGORIE è stato TOLTO**: 23 dei 26 ammissibili sono `elections`, quindi la diversificazione teneva due slot sui mercati **peggiori** — netto −$0,111/g e +$0,026/g contro +$10,64/g escluso |
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


---

## §4.6 · Ciclo di vita di una posizione — testo integrale prima della potatura del 22 agosto 2026

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


---

## §3 · Scheda del guardiano `agent43` — riga di tabella integrale prima della potatura del 22 agosto 2026

| `agent43-guardian` | **Il guardiano delle perdite economiche.** Ogni 30 s confronta (saldo pUSD + posizioni al prezzo corrente) con il **riferimento a massimo mobile** in `data/guardian-baseline.json` **⚠ E LE DUE FONTI DEVONO DESCRIVERE LO STESSO ISTANTE** (§5.2 p.54 chiusa, §5-bis p.204, 22/08): il saldo ha una cache da 45 s e lo snapshot posizioni e' tollerato fino a 180 s, quindi durante un fill il totale contava il DEBITO senza il suo ATTIVO — e' cosi' che il 20/08 e' nato uno scatto falso da $1.438,41 costato 6h06m. `riconciliaFonti` (pura) pretende che un movimento di **cassa** sia compensato da uno OPPOSTO delle **size** (`Δcassa + Δsize ≈ 0`, tolleranza **$6,00**, presa dal divario VUOTO fra $4,95 e $8,32 misurato su 29 movimenti veri); se non lo e', **il totale non e' misurabile** e il giro finisce li'. **⚠ SI RICONCILIA LA PARTE DOVUTA ALLE SIZE, NON IL VALORE**: un movimento di solo PREZZO e' P&L vero (fino a **$12,93** misurato) e il guardiano lo deve VEDERE — un criterio sul valore totale lo accecherebbe durante un crollo. **⚠ Chiude entrambi i versi con una regola sola** perche' scatto e cricchetto stanno tutti e due dietro `capitale.leggibile`: una lettura rifiutata non scatta **e** non alza il riferimento. **⚠ NON E' PIU' INERTE E NON E' MENO SVEGLIO**: disponibilita' **99,74%** su 9.338 letture vere, artefatto massimo **$33,12 → $6,74**, e un controllo positivo prova che su una perdita vera scatta ancora a k=2. **⚠ Costa un giro (30 s) dopo un riavvio** — la prima lettura non ha una precedente con cui riconciliare — e non smette mai di misurare in silenzio: contatore dei rifiuti consecutivi, riga a ogni giro e `op:'guardian-riconciliazione'` a verbale. (§5-bis p.157: depositi e prelievi sono riconosciuti come cassa esterna, non come P&L). **⚠ IL RIFERIMENTO SCENDE SUBITO E SALE SOLO SU CONFERMA** (D-D, 21/08, §5-bis p.202): un totale sopra il riferimento e' un **candidato** finche' una seconda lettura **distinta e contigua** non lo sostiene, e allora sale al **minimo delle due**; un rientro lo scarta. Il cricchetto accettava **k=1** dove lo scatto pretende **k=2**, e il 16/08 ha latchato per sempre $1.550,18 = saldo post-chiusura + posizioni pre-chiusura, cioe' **$57,10 contati due volte**. **⚠ NESSUN RIARMO AUTOMATICO DI AVVIA, per decisione**: sarebbe una **terza** strada autonoma verso il capitale reale (§2 r.3 ne nomina due) dentro il modulo il cui mestiere e' fermare. Dopo uno scatto il bot riparte a mano — misurato: **6h06m** di fermo dopo il falso scatto del 20/08 22:36, costate non perche' il riarmo e' manuale ma perche' **nessuno sapeva**. Da qui l'**AVVISO** (`lib/maker/allarme-guardiano.js`), cablato come **ULTIMO** passo di `spazzaEFerma`: non puo' ritardare la spazzata (gira dopo cancellazione, FERMA, referto e latch), non puo' farla fallire (non solleva mai, e il chiamante ha un secondo `catch`), non aggiunge **nessuna** chiamata nei giri normali — un test lo verifica **per ordine** nel sorgente e **per assenza** dentro `poll`. **⚠ E' INERTE FINCHE' `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` non sono nel `.env`** (le stesse due chiavi di `agent27:101`): senza, dichiara nel log che non e' partito e perche'; oltre `GUARDIAN_LOSS_PCT` (5%) o la **soglia assoluta DERIVATA** (5% del riferimento; `GUARDIAN_LOSS_ABS` resta il pavimento in dollari) cancella **tutti gli ordini a riposo**, deposita un referto `reason='guardian-auto-kill'` e mette il bot su **FERMA**. Non tocca le posizioni aperte e non ferma l'uscita automatica. **⚠ IL SECONDO INGRESSO — la perdita giornaliera realizzata a −$100 — DA R10 CHIUDE ANCHE LE POSIZIONI** (18/08): `chiusura-di-emergenza.js` (puro, **zero `require`**) classifica in **coppie a merge · gambe scoperte vendute attraversando · gambe sotto il minimo LASCIATE e dichiarate**, e agent43 **deposita** `data/chiusura-emergenza-richiesta.json` senza eseguire — la sua unica superficie al venue resta la spazzata, ed è una proprietà strutturale provata. A eseguire è **agent41**, che gira **prima** del cancello su AVVIA: il presidio dei 60 minuti sta dietro `botAttivo()`, cioè non gira a bot FERMO, che è lo stato che il kill produce. Il drawdown continua a NON toccare le posizioni, ed è una decisione: misura un **prezzo**, che può rientrare. Nessun auto-riarmo: si riparte cancellando `data/guardian-state.json` a mano. Le soglie si rileggono da `.env` **a ogni giro**, senza restart. Strutturalmente incapace di piazzare (unica superficie: `lib/maker/cancel-all`), verificato da un test che cammina l'albero dei `require` (65/65 verdi). File: `agents/agent43-guardian.js` + `lib/maker/guardian-perdite.js`. Codice e blocco pm2 sono in git dal 7 agosto (`dbba34e`). |

---

## §3 · Intestazione della tabella agenti — testo integrale prima della potatura

**Online al 7 agosto 2026** (`pm2 list` — verificato, non assunto), **meno i due rimossi il 9 agosto
2026**: `agent35-maker` (il motore automatico) e `agent37-maker-watchdog` (il suo dead-man) non sono
più nel repo né in `ecosystem.config.js`. Finché non vengono eseguiti i due `pm2 delete` in attesa
(§5 punto 63) i processi restano vivi in memoria con il codice vecchio, e `pm2 list` li mostra ancora.


---

## §3 · Scheda agent44-audit-scoperta — testo integrale prima della potatura

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


---

## §4.2 · I tetti di capitale — testo integrale prima della potatura del 22 agosto 2026

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
(era $1000 — 16 agosto 2026, decisione dell'operatore) e cap cumulativo di esposizione aperta **$1.300**
(era $600 → $150 il 16 agosto → $650 il 18 agosto sera → **$1.300 il 22 agosto 2026**, decisione
dell'operatore, per reggere i **10 mercati** di §4.13: conta i **fill riconciliati**, non gli ordini a
riposo). **⚠⚠ IL CAP NON È UN PERMESSO, È UN BUDGET**: `realloc-cycle.js:242` fa
`capitale = min(saldo, maxOpenNotionalUsd)` **prima** del knapsack, quindi alzarlo è un **ordine di
allocare di più**, non l'autorizzazione a farlo se capita. A $1.494,78 di saldo il cap passa dal **43%
all'87%** del capitale: da limite che morde a limite quasi inerte, e la difesa effettiva sull'esposizione
si riduce al **kill R10** (−$100 realizzati) e al **guardiano** (−5% dal riferimento).
**⚠ E il presupposto è §5.2 p.54 CHIUSA**: col guardiano vecchio l'artefatto di co-temporalità a 10
mercati a size piena valeva **$72,46** contro un margine di $75,08 e la coppia di letture del 20/08
**avrebbe fatto scattare** il guardiano; col nuovo vale **$14,74**, cioè **5,1× di franco**
(`data/ricerca/p54-legge-di-scala.json`, 9.400 letture reali). Chi riporta indietro il guardiano deve
riportare indietro anche questo numero.
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


---

## Riquadri di testa (DOVE VIVE / IL BOT È ARMATO) — testo integrale prima della potatura

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
> **`MAKER_MERCATI_CONTEMPORANEI=10`** su agent41 (R1, dal 22 agosto 2026) · `SLOT_STERILE_ARMATO=0` · KILL spento ·
> selezione automatica **ACCESA** · perno **vuoto**.
> ⚠ **QUANTI ORDINI CI SIANO A LIBRO NON SI SCRIVE QUI: SI LEGGE.** Alle 22:57Z erano **1 mercato e 2
> ordini** (~$52,55), ma il numero cambia ogni pochi minuti. **Si legge da
> `data/venue-orders.json`**, che agent40 scrive da letture VERE del venue — **non** ricostruendolo dal
> giornale sommando i `sent` e togliendo le scadenze registrate: il 18 agosto sera l'ho fatto e ho
> dichiarato «4 mercati, 8 ordini, $209,08» mentre al venue ce n'erano 2, perche' sei scadenze erano
> gia' avvenute e agent40 non le aveva ancora scritte. Una ricostruzione non e' una lettura.
> **⚠ CIÒ CHE RESTA DAVANTI NON SONO PIÙ CINTURE, È STATO DEL SISTEMA**: il KILL, il tetto per ordine
> ($65,63), il tetto per mercato ($61,25), l'esposizione cumulativa (**$1.300**, §4.2), il rate limit,
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

## §4.8 · Regola di copertura — testo integrale prima della potatura

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


---

## §4.9 · Perché lo split non conviene — testo integrale prima della potatura

**Perché lo split non conviene MAI in questa strategia** (§5 p.48): lo split rende 1 YES + 1 NO per
**$1,00** esatti; comprare le due gambe in banda costa **0,93-0,999** (mediana 0,97 su 37 coppie reali,
`pairCostUsd` 0,98 sul piano) — e quel 3% di sconto **è** il margine, perché il bot posa le gambe un
tick dietro il tocco su ciascun lato e la coppia costa `1 − 2·offset` **per costruzione**. E soprattutto
**lo split non mette niente sul libro**: due token fermi non maturano nulla, cioè non costa 3¢ in più,
**rinuncia all'intero ricavo**. L'ipotesi «conviene quando il book non offre la coppia a sconto» non si
verifica: se la coppia costasse ≥ $1 il bot **non aprirebbe** quella posizione — lo sconto *è* la
condizione d'ingresso, e perfino il Livello 1 ha un tetto a 99¢.


---

## §4.1 · Il margine dal bordo — testo integrale prima della potatura

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


---

## §4.1-bis · R4 erosione del book — testo integrale prima della potatura

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


---

## §1 · Stack e infrastruttura — testo integrale prima della potatura

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


---

## §4.7 · Scoperta e feed — testo integrale prima della potatura

### 4.7 · Scoperta e feed

**agent24** ogni **15 minuti esatti**: dorme il *resto* del periodo (`SCAN_INTERVAL_MS − durata`, con un
pavimento di 60 s) e **cronometra** la fase di profondità, dichiarando a ogni scansione il tetto che
starebbe nel periodo a quel ritmo. **`REWARD_MAX_CLOB_MARKETS = 300` dal 21 agosto 2026** (era 150), e il
numero viene dal cronometro: i libri si prendono in **blocco** (`POST /books`, `lib/rewards/libri-batch`),
che toglie **due delle ~4,1 chiamate accodate per mercato** e porta il costo da 2,74-3,80 a **1,40-2,47
s/mercato** ⇒ 300 mercati in **7,0-12,4 min**, dentro il periodo anche al ritmo peggiore. **400 sforerebbe**
(9,3-16,5 min) e 1.556 e' fuori scala (36-64 min). ⚠ **IL COLLO NON SONO I LIBRI, E' `MAX_RPS = 1.5`**: la
coda `httpGet` e' SERIALIZZATA, quindi le sei chiamate per mercato che sembrano parallele scorrono a 667 ms
l'una, mentre un `GET /book` misurato costa **24-152 ms** e i **3.112 libri dell'intero universo censito
costano 2,4 s e 64 MB**. Chi vuole andare oltre 300 deve guardare `MAX_RPS` e le altre quattro chiamate per
mercato (`prices-history` ×2, `tick-size`, `markets/<cid>`), non il batch. ⚠ **UN LIBRO CHE MANCA ESCLUDE IL
MERCATO, RUMOROSAMENTE**: prima un `status !== 200` restituiva `emptyBook:true, Qmin:0`, cioe' **concorrenza
zero**, cioe' la quota stimata MASSIMA — un mercato non letto si presentava come il **migliore del board**.
Adesso `analizzaLibro` distingue `assente` da `emptyBook` e il ciclo salta il mercato dichiarandolo. `ETA_BOARD_MAX_MS = 25 min` sta sopra il periodo ma sotto il doppio, così una
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


---

## §3 · Coda della sezione (agent37/agent40, monitor «Reti dei 21») — testo integrale prima della potatura

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


---

## §4.10 · Registri e persistenza — testo integrale prima della potatura

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


---

## §4.14 · Le quattro cinture — testo integrale prima della potatura

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


---

## §4.4 · Cella «orizzonte» — testo integrale prima della potatura

| **orizzonte** | `horizon.js` | `[MIN_HORIZON_DAYS **0,50** · MAX_HORIZON_DAYS 150]`, confini **inclusivi da entrambi i lati**. Il pavimento in ore (**12 h**) è **derivato** in `market-validity` e in `risk-classifier`, non ripetuto. **0,75 → 0,50 il 13 agosto 2026**: il confine di rischio misurato è a **6 ore** (sotto, il 35,1% delle uscite arriva dopo la risoluzione; fra 6-12 h è 0/36, fra 12-18 h 0/15), quindi a 12 h restano **due volte** il margine. **0,25 g è sconsigliato.** Sul board vivo: utilizzabili **13 → 50**, coperti **13 → 35**, capitale impiegato **$796 → $2.144**, reward modellato **5,14×**. **Scadenza non determinabile ⇒ ESCLUDE**. ⚠ **È il filtro che taglia di più**: 78 mercati su 102 valutati il 13/8 alle 20:17, e il gradino è tutto fra 12 h e 18 h — vedi §5 punto 129 prima di toccarlo o di lasciarlo com'è |

---

## §3 · Riga agent45-osservatore — testo integrale prima della potatura

| `agent45-osservatore` | **L'osservatore muto** (13 agosto 2026). Un campione ogni **60 s** in `data/osservatore/`: ordini a riposo, mercati con posizione (coppie vs gambe nude), posizioni e valore, saldo, totale, PnL del guardiano, stato degli interruttori, reward di giornata. Più un **giornale in italiano** con gli eventi: pre-allarme, scatto, collasso, transizioni coperta⇄scoperta **con la durata**, merge, cancellazioni. **Non decide, non agisce, non avvisa.** Rotazione giornaliera, 30 giorni. Strutturalmente incapace di toccare capitale — un test cammina il suo albero dei `require`. **Read-only ⇒ riavviabile senza conferma.** | `agents/agent45-osservatore.js` + `lib/osservatore/campionamento.js` |

---

## §3 · Riga breve agent43 — testo integrale prima della potatura

| `agent43-guardian` | **Guardiano delle perdite economiche** — vedi la scheda sotto. In servizio dalle 21:27:31 del 7 agosto 2026 (allora col nome `agent42-guardian`), baseline **$660,56**, nessuno scatto. **Rinominato l'8 agosto 2026: il processo pm2 vivo porta ancora il nome vecchio finché non lo si ricrea — §5 punto 15.** | `agents/agent43-guardian.js` |

---

## §3 · Riga agent41 — testo integrale prima della potatura

| `agent41-realloc-scheduler` | **Riallocazione periodica** (ogni 6 h) + **trigger a capitale fermo** (ogni 2 min, dall'8 agosto 2026). Il ciclo fisso ha due trigger indipendenti: *validità* e *valore*. Il trigger event-driven ne ha uno solo: c'è collaterale libero sopra **$50**. **È l'unico processo che può cancellare e piazzare ordini veri senza conferma umana**, per eccezione esplicita dell'operatore (3 agosto 2026). | `agents/agent41-realloc-scheduler.js` |

---

## §3 · Riga dashboard — testo integrale prima della potatura

| `dashboard` | Il Next.js che serve pannello e `/api/*` sulla porta 3000. Il **pannello ordini manuali gira dentro questo processo**. | `npm start -- --port 3000` |

---

## §2 · Introduzione «Erano tre» — testo integrale prima della potatura

Erano tre. **ARM / DISARM è stato rimosso il 9 agosto 2026** (§5 punto 63) insieme al motore che lo
consultava: era un'autorizzazione di sessione con TTL e cap di collaterale, e l'unico processo che la
leggeva era `agent35-maker`. Restano i due che decidono davvero.


---

## §5.3 · Le due trappole dei percorsi — testo integrale prima della potatura

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

---



## Blocchi RISCRITTI in forma compatta il 22 agosto 2026 — testo originale integrale

> Qui non c'è nulla di nuovo rispetto a CLAUDE.md: sono i blocchi che nella potatura sono stati
> **riformulati più corti**. Si conservano verbatim perché la regola della potatura era «sposta, non
> cancellare», e una riformulazione è pur sempre una riscrittura.

### §3 · Il controllo dei percorsi (testo originale)

**Il controllo dei percorsi, in tutti e nove gli agent che scrivono.** `lib/safety/percorsi-critici.js`,
chiamato all'avvio: radice del package, `data/` scrivibile, directory di servizio creabile, e ogni file di
servizio **già esistente** scrivibile da noi. Su guasto: stderr + `exit 1` ⇒ sotto pm2 riavvio e poi
`errored` in rosso. ⚠ Un file **assente** non è mai un errore (è il primo avvio, o lo stato sano); non si
controlla il **contenuto** (la freschezza ha già i suoi presidi). Test 15/0, che costruisce ogni guasto
vero e poi lo rimette a posto — un controllo sempre rosso non distingue niente (§5-bis p.189).


### §4.1 · Preambolo (testo originale)

### 4.1 · Il motore di piazzamento — `lib/maker/motore-unico.js`

Un profilo solo dal 6 agosto 2026 (Safe/Risk aboliti: la formula del venue è una curva continua e non
conosce bucket; nessun `if (profilo)` nel repo). **Le cinque regole, nell'ordine in cui si applicano:**


### §4.1 · Mid stantio (testo originale)

**Mid stantio**: oltre **120 s** di cecità l'ordine si **cancella** (`mid-stantio.js`, env con clamp
`[5 s, 120 s]`; **20 → 120 il 16 agosto 2026** — cancellava a 20 s ciò che `decideReprice` non era
disposto a riprezzare prima di 60 s, cioè distruggeva ordini che nessuno stava per correggere).
L'orologio si azzera **solo su una lettura buona**, e una cancellazione fallita NON lo azzera. Tre cause distinte in audit — `cecita-timeout-{mid-stantio|nessun-libro|eta-ignota}` — perché
l'azione è la stessa ma la diagnosi no.


### §4.5 · Capitale al lavoro (testo originale)

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


### §4.9 · Merge on-chain e relayer (testo originale)

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


### §4.11 e §4.12 (testo originale)

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


### §2 · I due interruttori (testo originale)

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


### §4.6 · Ciclo di vita (testo originale, seconda copia integrale)

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


### §5.3 · Trappole operative (testo originale)

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


### Intestazione di CLAUDE.md prima della potatura del 22 agosto 2026 (testo originale)

Questo file viene letto automaticamente all'avvio di ogni sessione Claude Code aperta da
`/root/rewards-bot`. **Il contesto vive qui, non nel prompt.**

Ultima verifica contro codice/stato reali: **18 agosto 2026 — dopo la migrazione in `/home/bot/bot` (utente `bot`), con la flotta RIACCESA** (§4.14, §5.1, §5.3, §5-bis p.188-191). Le cinture si leggono da `/proc/<pid>/environ` degli 11 processi vivi. Il quadro del giro è in `APERTI.md`.

> ⚠️ **QUESTO FILE È STATO COMPATTATO IL 13 AGOSTO 2026** (494k → ~110k) su istruzione dell'operatore.
> Non è stata tolta nessuna regola, nessuna costante, nessuna trappola operativa e nessuna questione
> aperta: è stata tolta la **cronologia**, cioè il racconto di come si è arrivati a decisioni che oggi
> sono semplicemente vere. Ogni voce chiusa sopravvive come **una riga** nel registro di §5-bis, con il
> numero originale, così un riferimento del tipo «§5 punto 72» resta risolvibile. La storia integrale
> resta in `git log` e nei commit citati. **Chi aggiunge una voce nuova scriva già compatto.**


### §4 · Intestazione della sezione (testo originale, era una copia dell'apertura di §1)

Bot di **liquidity rewards su Polymarket**: piazza ordini maker *fermi* dentro la banda premiante e
incassa i premi di liquidità. **I reward si pagano sugli ordini a riposo, non sui fill** — per un maker
l'esecuzione è il costo, non il ricavo. Ogni numero qui sotto è letto dal codice/stato reali.

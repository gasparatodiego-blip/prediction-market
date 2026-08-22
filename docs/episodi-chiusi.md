# Episodi chiusi — i riquadri di testa di CLAUDE.md

> Estratto da `CLAUDE.md` il 22 agosto 2026 nella potatura sotto i 120k.
> I quattordici riquadri narrativi che stavano in cima a CLAUDE.md: il fatto, la misura e la diagnosi di episodi già corretti. Le REGOLE VIVE che ne derivano restano in CLAUDE.md (§3, §4).
> **Il testo qui sotto è VERBATIM: niente è stato riscritto né cancellato.**

---

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

# Misure e tarature — il perché dei numeri che oggi sono in servizio

**A cosa serve.** In `CLAUDE.md` restano la **regola viva** e il **valore corrente**; qui sta la
**misura** che ha portato a quel valore: campioni, board, date, alternative provate e scartate.
Ogni blocco è **verbatim** dal `CLAUDE.md` prima della potatura del **23 agosto 2026** e porta la
sezione di provenienza. **Niente è stato cancellato: è stato spostato.**

⚠ Le misure invecchiano. Un numero letto qui è quello che era vero **alla data del blocco**; lo stato
di adesso si legge dal codice, da `/proc/<pid>/environ` e da `node scripts/cli/stato.js`.

### §5.2 p.31-bis — la storia della distanza obiettivo: da 0,456 a 3,5¢ e il conto del margine (16-23 agosto 2026)

   `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` da **0,456 (2,052¢)** a **`3.5/4.5` = 0,7778 (3,500¢)** sulla
   banda modale. **⚠ UN SOLO PUNTO**: `const DISTANZA_LUNGHI_FRAZIONE_V` in `agents/ecosystem.config.js`,
   referenziato dai blocchi `env` di agent40 **e** agent41 — prima erano **due letterali** `'0.456'`,
   cioè il reperto D1 su un **prezzo di ordini veri**. **IL CONTO DEL MARGINE**, misurato su 88 mercati
   lunghi del board: banda ±4,5¢ tick 1,0¢ (70) ⇒ margine **1,000¢ = 1,00 tick** · ±4,5¢ tick 0,1¢ (10)
   ⇒ 10,00 tick · ±5,5¢ tick 0,1¢ (8) ⇒ 12,22 tick — **88 su 88 tengono almeno un tick, zero sotto**.
   ⚠ **3,5¢ è il tetto che il codice già imponeva**: il margine dal bordo di §4.1 vale
   `max(1 tick, 0,22·v)` = 1,0¢, quindi il punto più esterno raggiungibile è `4,5 − 1,0 = 3,5¢`;
   0,95 darebbe 4,275¢, cioè **0,22 tick** dal bordo. ⚠ **Costa premio e va saputo**: `S = ((4,5−s)/4,5)²`
   passa da **0,2959 (2,05¢) a 0,0494 (3,5¢)**, cioè **un sesto** del punteggio a parità di size. Il ripristino è in `APERTI.md`. ⚠ Si riavviano **entrambi** i processi (§5.1).

### §5.2 p.64 — la distanza dei corti: perché 4,0¢ non passa la regola del tick (23 agosto 2026, SUPERATA)

64. **🟡 LA DISTANZA DEI CORTI RESTA A 3,0¢: I 4,0¢ CHIESTI NON PASSANO LA REGOLA DEL TICK — 23
   agosto 2026, NON applicati.**
   **⚠ SUPERATA IL 23/08 (v. §5.2 p.31-bis): i corti sono a `MAKER_DISTANZA_CORTI_CENTS='3.5'`**
   (`ecosystem.config.js:676`, confermato in `/proc` di agent41 e dal referto di selezione,
   `distanzaCorti.cents 3.5 · fonte ambiente`). Il testo sotto è la misura che portò a 3,0¢, non lo stato. L'operatore ha chiesto di portare i corti da 3,0¢ a 4,0¢ **con la
   condizione «almeno un tick di margine dal bordo», e con la ricaduta esplicita «se non ci sta,
   ferma a 4,0¢ meno un tick»**. Misurato sul board vivo: **121 corti su 121 hanno tick 1,0¢** e
   **119 su 121 banda ±4,5¢**, quindi a 4,0¢ il margine è **0,50¢ = mezzo tick** ⇒ la condizione
   **non è soddisfatta**, e la ricaduta dice `4,0 − 1,0 = 3,0¢`, cioè il valore già in servizio.
   **Il punto è stato applicato per intero e il risultato è: nessun cambiamento.**
   ⚠ **E il costo era grosso comunque**, misurato a size $61,25 con la concorrenza del board di
   adesso (`recoverCompetitorQ` + `quadraticUserShare`, mediana su 121 mercati): premio atteso
   **$2,5923/g a 3,0¢ · $1,2282/g a 3,5¢ · $0,3216/g a 4,0¢** — 4,0¢ costa **−87,6%**, cioè
   $10,37/g contro $1,29/g sui quattro slot corti. Il punteggio lo dice da solo:
   `S = ((4,5−s)/4,5)²` vale 0,1111 · 0,0494 · **0,0123**.
   ⚠ **3,5¢ È L'UNICO VALORE SOPRA 3,0 CHE SODDISFA LA REGOLA** (margine 1,00¢ = esattamente un
   tick), a **−52,6%** di premio e con la probabilità di uscire di banda in un'ora che sale dal
   **9,8% al 15,9%** (volatilità oraria misurata: mediana |Δmid| **0,50¢**, p90 2,50¢, su 529 passi
   orari di 25 corti). **Non applicato**: la regola dell'operatore dice 3,0¢, e 3,5¢ sarebbe una
   scelta diversa da quella scritta. **Serve una decisione**, non una patch.

### §4.13 — la deroga di secchio e la distanza di piano: il fatto misurato alle 10:20Z del 23 agosto 2026

> **⚖️ SELEZIONE E PIANO GIUDICANO CON LO STESSO NETTO — 23 agosto 2026.**
> **IL FATTO, misurato alle 10:20Z**: 12 slot pieni, ma il piano ne finanziava **3**. Quattro
> occupanti «alto» avevano netto **NEGATIVO** (−0,04 · −0,17 · −2,27 · **−7,86** $/g) e fuori c'era
> `0xddcb215d8c` (PA-08 House seat) a **+22,73 $/g**, ammissibile e non in quarantena. **Non compariva
> in nessuna lista di scarto**: non lo scartava niente, non poteva essere considerato. Con gli slot a
> 12/12 l'unica porta era lo spodestamento, e lo spodestamento chiedeva lo **stesso secchio** — lui è
> «basso», i quattro in perdita sono «alto».
> **LA DEROGA, con quattro condizioni**: si attraversa il secchio solo se ① l'occupante ha netto
> **negativo**, ② lo sfidante **positivo**, ③ il secchio dell'occupante è **sopra** la sua quota e
> ④ quello dello sfidante **sotto**. ③+④ sono la ragione per cui non viola §4.13: lo scambio muove la
> composizione **verso** la cifra decisa dall'operatore (1+11 → 2+10 contro una quota 4+8), mai lontano.
> **⚠ NON CAMBIA IL CAPITALE**: `MARKET_CAP_FIXED_USD` vale $61,25 per mercato in **entrambi** i
> secchi, quindi `N × 2 × tetto` non contiene la quota. È perché il secchio non governa la size che
> attraversarlo è ammissibile. **⚠ Fail-closed su ogni ingresso**: netto non finito, quota non
> leggibile, conteggio non calcolabile ⇒ nessuna deroga. **Misurato a secco: un solo scambio,
> +$22,90/giorno.**
> **⚠ E LA DISTANZA A CUI IL PIANO GIUDICA ORA È QUELLA VERA**: `conDistanzaDiPiano` (un punto solo,
> usato da **entrambi** i piani — quello operativo e quello dei netti che ordinano la selezione) passa
> `offsetTicks: null` + `offsetCents` da `distanzaObiettivoCents`, cioè **3,0¢ su ogni griglia**.
> `offsetTicks` da solo non bastava: conta i tick **del mercato**, e 3 tick valgono 3,0¢ su griglia 1¢
> ma **0,3¢** su griglia 0,1¢. **⚠⚠ E VA DETTO CHE NON MUOVE I NETTI**: misurato, i tre modi danno gli
> stessi numeri a meno della seconda cifra, e i netti negativi restano 4 su 11. `offsetTicks` governa
> il **costo** di selezione avversa, non il punteggio del venue: **il lordo nasce da `levels[]` del
> board, che agent24 calcola con la propria posa tipica, e QUELLA resta disallineata.** La correzione
> si applica perché il parametro deve dire il vero, non perché curi il capitale fermo.

### §4.13 — «slot sterile»: la storia del disarmo del 15 agosto e della riarmatura del 20 agosto 2026

> **🧊 «SLOT STERILE» — RIARMATA IL 20 AGOSTO 2026** (`52c33f4`: soglia 22 min, quarantena **180 min**,
> tetto **5 rilasci/ora**). ⚠ **`SLOT_STERILE_ARMATO` NON compare più in `ecosystem.config.js` né in
> `/proc/<pid>/environ` di agent41, e ASSENTE ⇒ ARMATA**: è il fail-safe voluto, non una svista. Chi legge
> `/proc` e non trova la variabile ha trovato la regola ACCESA. Il giornale lo conferma senza ambiguità —
> `esito:'in-attesa'`/`'rilascia'` quando è armata, `esito:'disarmato'` quando non lo è.
> ⚠ **LA QUARANTENA VIVE IN MEMORIA** (`statoLibroVuoto` in agent41, zero `require`, nessuna scrittura su
> disco): **un riavvio di agent41 la azzera**, e con essa il contatore `zeroDa`. Non è un disarmo — dopo il
> riavvio nessuno può essere rilasciato per almeno i 22 minuti della soglia — ma è una **perdita del freno
> anti-churn**, e va dichiarata da chi riavvia.
> ⚠ **E I MERCATI IN QUARANTENA NON COMPAIONO IN NESSUNA LISTA DI SCARTO DELLA SELEZIONE**: entrano in
> `escludi` (agent41 §2479) e cadono a `selezione-mercati.js:787`, cioè **prima** del cancello di
> composizione. `slotVuotiPerScarsita` dice «la ragione è nella composizione o negli scarti dichiarati qui
> accanto», e per quei posti non è vero. **Difetto di osservabilità dichiarato, non corretto.**
>
> **La storia**: libererebbe uno slot
> che per **due osservazioni consecutive** non produce ordini. **⚠ Fu disarmata la sera stessa in cui
> nacque**: presumeva che la causa stesse nel MERCATO mentre stava nel FEED, e ha buttato fuori **cinque
> volte** un mercato che andava benissimo. **⚠ La correzione c'è**: «nessun
> ordine a libro» ha **due cause opposte** — *sterile* e *svuotato da noi* (mid stantio, erosione) —
> quindi un'osservazione non conta come sterile se in quel mercato ci sono state **cancellazioni
> nostre** nella finestra, e il contatore si **azzera a ogni piazzamento riuscito**. **Per disarmarla di nuovo**: si rimette
> `SLOT_STERILE_ARMATO: '0'` in `ecosystem.config.js` e si riavvia agent41 **dal file** — solo il valore
> ESATTO `'0'` disarma, come per `SBLOCCO_GRADINO6_ARMATO`.

### §4.13 — il filtro meteo: il referto integrale del 23 agosto 2026 (interruttore inesistente, costo misurato sul board vivo)

> **🌦️🔴 IL FILTRO METEO NON È UN INTERRUTTORE: È INCONDIZIONATO, E IL DISARMO NON È MAI ESISTITO —
> misurato il 23 agosto 2026 alle 15:35Z (§5.2 p.69).**
> **⚠⚠ QUESTO RIQUADRO HA DESCRITTO PER MEZZA GIORNATA UN MECCANISMO CHE NON C'È.** I fatti, verificati
> con `grep` su tutto il repo (`node_modules` e `_archivio` esclusi):
> · **`filtroMeteoArmato` non esiste** — zero occorrenze in `lib/`, `agents/`, `scripts/`; l'unica in
>   tutto il repo era questa riga di `CLAUDE.md`, cioè il documento citava se stesso;
> · **`MAKER_FILTRO_METEO` non compare in nessun sorgente**, né in `agents/ecosystem.config.js`, né in
>   `.env`, né in `/proc/<pid>/environ` di agent41;
> · `selezione-mercati.js` esporta `eMeteo` e **non** un `filtroMeteoArmato`, e il cancello a
>   **`selezione-mercati.js:469`** è nudo: `if (eMeteo(riga)) return { ammissibile:false, motivo:
>   'famiglia-meteo' }`. **Nessun env lo condiziona in nessun ramo.**
> **⇒ IL FILTRO È ARMATO E NON SI PUÒ SPEGNERE DA CONFIGURAZIONE.** Scrivere `MAKER_FILTRO_METEO: '0'`
> in `ecosystem.config.js` e riavviare **non cambierebbe niente**, e questo è il modo peggiore in cui
> una manopola può fallire: si crede di aver disarmato e non si è disarmato nulla. **Disarmarlo davvero
> richiede di scrivere il codice dell'interruttore** — è un lavoro, non un env.
> **IL COSTO, MISURATO SUL BOARD VIVO DEL 23/08 ALLE 15:35Z** (`data/ricerca/slot-corto-vuoto-1540.json`,
> col classificatore `selezione-mercati.eMeteo`, non con uno riscritto): 283 righe di board, **75 mercati
> fra 24 e 48 h**, di cui **72 METEO** e **73 con `rewardsMinSize ≤ 20`**. Restano **3 non-meteo**, e due
> hanno `minSize 50` (secchio «alto», quindi non idonei al posto «basso» libero): **UN solo candidato
> vero** per lo slot corto. Lo slot corto/basso era infatti **vuoto** in quel momento, con i 3 scartati
> per `quota-scaglione-piena` tutti «alto». **Il filtro meteo È la causa dello slot corto vuoto**, e
> resterà tale finché l'interruttore non viene scritto.
> **LA MISURA CHE GIUSTIFICAVA IL DISARMO RESTA VALIDA** (board vivo del 23/08 alle 07:09Z): 234 righe, **160 meteo**, **119
> fra 24 e 48 h**. Passati per tutti gli altri cancelli — 24 h, pavimento premiante, scadenza
> determinabile e concorde, quarantena, già selezionati — ne restano **119 su 119**: nessuno cadeva
> altrove. Il meteo **era l'unico cancello che mordesse sulla fascia corta**, e i 3 slot corti vuoti su
> 5 erano vuoti per causa sua. **⚠ Zero falsi positivi**: 105 «highest temperature in ⟨città⟩» + 14
> «lowest temperature in ⟨città⟩», tutti categoria `Weather` al venue, tutti in scadenza allo stesso
> istante. Le ancore `\b` fanno il loro lavoro — il filtro è **corretto**, è la decisione di escludere
> che è cambiata.
> **⚠⚠ DA SOLO NON APRE NIENTE, E VA SAPUTO**: i meteo sono **tutti `rewardsMinSize` 20**, cioè tutti
> nel secchio «basso». Quanti ne entrano lo decide `quotaScaglioni`, non questo flag. Misurato sullo
> stato del 23/08: con la quota vecchia (1 «basso», già occupato) i posti liberi erano **0** ⇒ **zero
> entranti**; con la quota nuova (4) sono **3** ⇒ **3 entranti**. I due lavori sono complementari, e
> nessuno dei due basta.
> **⚠ NON È UN PERMESSO, È UN CANCELLO IN MENO**: cambia **chi** è candidato, mai **quanti** slot né
> **quanto** capitale — `MARKET_CAP_FIXED_USD` resta $61,25 per mercato e l'invariante
> `12 × 2 × $61,25 = $1.470 ≤ cap $1.470` è **intatta**. Davanti restano identici tutti gli altri
> cancelli, i quattro gate di piazzamento e le quattro cinture.
> **⚠ IL PREMIO DEI METEO NON È STATO MISURATO SUL LUNGO**: sono mercati a 24 h per costruzione, cioè
> la famiglia che §4.13 escludeva per **natura dell'esposizione**, non per rendimento. Il payback di
> §5.2 p.58 li giudicherà uno per uno, e potrebbe rifiutarli come rifiuta gli altri corti.

### §4.6 — il GTD della corsia di chiusura a 33 minuti: l'inversione misurata e il perché la quotazione resta a 23 (23 agosto 2026)

> **⏳ IL GTD DELLA CORSIA DI CHIUSURA È 33 MINUTI, QUELLO DELLA QUOTAZIONE RESTA 23 — 23 agosto 2026.**
> **IL VENUE NON SA ESTENDERE UN ORDINE**: l'`expiration` sta **dentro la struct EIP-712 firmata** e
> nessuno dei due SDK installati espone `modify`/`amend`/`extend` (**88 metodi** in
> `@polymarket/clob-client-v2`, **zero** corrispondenze). Prolungare senza perdere la coda **non è
> possibile**: è un fatto verificato sul pacchetto installato, non una supposizione.
> **L'INVERSIONE MISURATA**: `MERGE_WAIT_TIMEOUT_MIN` concede **30 min** all'ordine di completamento del
> Livello 2, ma quell'ordine portava i **23 min** della quotazione — il venue lo ritirava **prima** che
> la regola smettesse di aspettarlo (`merge-in-attesa … 29,8 min` su un ordine morto a 23).
> `GTD_CHIUSURA_SECONDS = MERGE_WAIT_TIMEOUT_MIN × 60 + REFRESH_MARGIN_SECONDS = **1.980 s**`, entrambe
> **importate**: chi cambia l'attesa del Livello 2 muove anche questo.
> **⚠ LA QUOTAZIONE NON SI TOCCA, E IL PERCHÉ È UNA MISURA**: **il premio non conosce la coda** —
> `quadraticUserShare` prende concorrenza, mid, banda, minSize, capitale e distanza, e la posizione in
> coda non è uno di quei sei; `scoreOrder = ((v−d)/v)²`. Un ordine di quotazione che va in fondo alla
> coda matura **esattamente lo stesso premio**. Il churn residuo misurato: 43 rinnovi/h con un buco
> cancel→place di **12,47 s medi** = **0,53% del tempo-libro** ≈ **$0,03/giorno**. Allungare lì non
> compra niente e costerebbe esposizione non presidiata.
> **⚠ E LA CALIBRAZIONE DI `ripristino-gambe` RESTA VALIDA**: il suo tetto di 30 min sta sopra la GTD
> *della quotazione*, che non è cambiata. Un GTD globale l'avrebbe invertita in silenzio.
> **⚠ COSA COSTA**: se l'host muore, un ordine di **chiusura** resta a libro fino a 33 min invece di 23.
> È l'unica direzione accettabile: un ordine di chiusura può solo **ridurre** l'esposizione (un SELL
> vende ciò che possediamo, un BUY di completamento chiude una coppia che rende $1/share). **Nessun
> ordine di APERTURA è toccato**, e `riposizionaDopoChiusura` — che riapre due gambe — è dichiarato ed
> escluso. Il tetto dell'orologio del mercato (`tooClose`) resta davanti.
> **⚠ IL PUNTO UNICO È `chiudendo(spec)`, NON `piazzaChiudendo`**: in `auto-close.js` ci sono **cinque**
> chiamate a `deps.placeOrder` e **una sola** passa da `piazzaChiudendo`. Crederlo era l'errore.

### §4.6 — l'abbandono: la derivazione della soglia $3,0625 e le cinque posizioni del 23 agosto 2026

> **🏳️ L'ABBANDONO — R6 LETTA COME CANCELLO, 23 agosto 2026, decisione dell'operatore.**
> `lib/maker/abbandono-posizione.js` (puro, due `require` di sole costanti). Una posizione **scoperta**
> è dichiarata **ABBANDONATA** quando `valoreResiduo < SOGLIA` **E** `costoUscita ≥ valoreResiduo`:
> esce dal ciclo di uscita, **libera lo slot**, e **non si cancella nulla al venue e non si vende** —
> si smette solo di provare.
> · `valoreResiduo` = il **bid CAMMINATO** per l'INTERA size, mai `size × mid` (la misura del 16
> agosto: 283 campioni, **zero** uscite in guadagno al mid).
> · `costoUscita` = il minimo fra `size × (carico − bidCamm)` (vendita) e `size × (carico + askAltro − 1)`
> (coppia). **⚠⚠ SUL CLOB LE DUE VIE COSTANO IDENTICO, ED È STRUTTURALE**: i due token condividono un
> libro solo, quindi `askAltroLato = 1 − bidMioLato` — misurato **5 righe su 5** alla quarta cifra. Il
> `min` resta scritto perché è l'unico punto che se ne accorgerebbe se il venue disaccoppiasse i libri.
> **LA SOGLIA È DERIVATA**: `PERDITA_MAX_FRAZIONE × MARKET_CAP_FIXED_USD = 0,05 × $61,25 =` **$3,0625**,
> entrambe **importate**. Il conto: `PERDITA_MAX_FRAZIONE` è quanto R7 autorizza a **bruciare** per
> liberare una gamba, `MARKET_CAP_FIXED_USD` è la gamba più grande apribile ⇒ il prodotto è il massimo
> spendibile per uscire da una posizione qualsiasi. Sotto quella cifra R6 si contraddice.
> ⚠ L'operatore aveva suggerito «ordine di grandezza $5»: sulle cinque posizioni vive del 23/08 **$3,06
> e $5,00 danno lo stesso verdetto**, e si tiene il derivato perché è il più stretto (abbandonare è
> smettere di provare, quindi il verso prudente è abbandonare di MENO).
> **⚠ NON SPARISCE DAI CONTI**: la posizione resta al venue ⇒ resta in `readVenuePositions`, nel totale
> del guardiano, in `capitale-al-lavoro` e nel P&L. Abbandonare è smettere di **AGIRE**, non di **CONTARE**.
> **⚠ NON SPEGNE L'ANOMALIA DELLE QUATTRO ORE**: il blocco dell'abbandono sta **DOPO** quello di
> `scoperto-oltre-soglia-grave`, e l'ordine è un requisito — un test lo verifica e diventa rosso se
> qualcuno lo inverte. Una riga `posizione-abbandonata` si scrive **a ogni giro**, non solo al primo.
> **⚠ LA COPPIA BATTE SEMPRE L'ABBANDONO**: `sizeAltroLato > 0` ⇒ mai abbandonata (il merge rende
> $1/share). `sizeAltroLato` non letta ⇒ **non giudicabile** ⇒ non si abbandona.
> **⚠ ASIMMETRICO**: si ENTRA con **2 osservazioni contigue** (≤ 5 min l'una dall'altra), si ESCE con
> **una**. Un giudizio `non-giudicabile` **non fa rientrare**: lascia la voce com'è.
> **⚠ LO SLOT SI LIBERA SOLO SE OGNI POSIZIONE DEL MERCATO È ABBANDONATA** — la sottrazione avviene in
> `agent41.posizioniPerSelezione`, cioè l'unico ingresso da cui la selezione deriva `inGestione`: il
> mercato ricade nel ramo già esistente e già provato, nessun ramo nuovo nella rotazione. **§4.8 non è
> toccata**: il perimetro live-min continua a includerlo finché ha posizioni o ordini a riposo.
> **⚠ REGISTRO SU DISCO** (`data/posizioni-abbandonate.json`): lo scrive **agent40** (che ha il libro e
> giudica), lo legge **agent41** (che libera lo slot) — due processi, quindi una memoria di processo
> sarebbe la corsa già misurata su `mercatiConOrdiniVivi`. Fail-closed in entrambi i versi.
> **AL VARO (23/08 13:30Z)**: abbandonate **`0xc5cd9325` MrBeast** (valore $0,45, costo $2,38) e
> **`0xd947c421` Don't Say Good Luck** (valore $1,52, costo $2,12); restano Democratic House ($21,88,
> sopra soglia), Trump 180-199 ($3,85, sopra soglia) e Iran ($2,33 ma uscita conveniente a $0,14).

### §4.6 — la presa di profitto: i 283 campioni su 354 minuti e lo zero istanti in guadagno

> **💰 LA PRESA DI PROFITTO DECIDE SUL BID CAMMINATO, MAI SUL MID — §5-bis p.169.**
> `lib/maker/presa-di-profitto.js` (puro), chiamata da `decideClose` **dopo** le guardie su mercato
> chiuso e **prima** di `already-covered`. **Il criterio non ha costanti arbitrarie**: incassare al bid
> batte completare la coppia esattamente quando `bid + ask > 1`. Due rami — **`coppia-battuta`** (coppia
> disponibile: scatta se `bid + ask > 1 + m`) e **`coppia-bloccata`** (coppia oltre il tetto di 101¢:
> scatta se `bid > carico + m`, perché l'unica alternativa è la scala d'urgenza, che sa solo scendere).
> `MARGINE_CENTS = 1`, **centesimi per share e non tick**.
> **SI ATTRAVERSA, NON SI INSEGUE**: il prezzo è il bid camminato — restare sopra il bid ricrea il
> difetto misurato (283 campioni su 354 minuti, **ZERO istanti offrivano un'uscita in guadagno**: il
> «guadagno» del pannello era la differenza fra il mid e il bid, e un take-profit ancorato al mid
> esisteva già e non ha mai incassato niente). **TUTTA LA SIZE O NIENTE**: una copertura parziale
> lascerebbe un residuo sotto il minimo, cioè capitale senza via d'uscita. `TETTO_COPPIA_CENTS`
> **importato**. **⚠ Fail-closed**: ask illeggibile, scala che non copre la size, carico illeggibile ⇒
> non scatta. **⚠ Il ramo `close-at-market` NON chiama `provaCoppia` quando il trigger è la presa di
> profitto**, e l'obbligo di esito viene scaricato a mano.

### §4.6 — il tetto della coppia a 101¢: la misura sui 65 maker veri

**Tetto della coppia 101¢, e adesso è UNO SOLO** (decisione dell'operatore; prima erano 99¢ per il merge
e 120¢ per la chiusura rapida). La misura sui 65 maker veri: costo mediano di una coppia completata
**100,00¢**, solo il **41,2%** chiude entro 99¢, e la valvola 110-120¢ la usa il **2,7%** — a 99¢ si
rifiutava la maggioranza delle uscite che il mercato offre davvero. `MERGE_MIN_MARGIN_CENTS` è
**derivato** (`100 − 101 = −1`), non ricopiato; `MAKER_TETTO_COPPIA_CENTS` è un env con clamp
`[100 · 200]`. Il valore si asserisce in **un punto solo**; gli altri test lo **derivano**.

### §4.6 — l'uscita fuori banda: il caso MrBeast 0x4757745c e le sette condizioni (22 agosto 2026)

> **🚪 L'USCITA PUÒ GUARDARE FUORI BANDA QUANDO LA COPPIA È IMPOSSIBILE — 22 agosto 2026,
> decisione dell'operatore.** `exit-plan.planExit` sapeva produrre **solo** prezzi dentro la banda
> premiante: il clamp porta il prezzo a `b.hi`, e se `b.hi` sta sotto il pavimento della scala il
> verdetto è `no-target`, cioè **nessuna uscita** — il miglior bid del libro non veniva nemmeno
> guardato. Misurato su MrBeast `0x4757745c`: bordo alto banda **0,55**, pavimento concesso **0,646**,
> miglior bid **0,64** — fuori banda ma **9¢ meglio** di qualunque prezzo in banda.
> **LA REGOLA**: gamba scoperta **e** coppia economicamente impossibile (`carico + ask sorella` oltre
> il tetto di **101¢**) ⇒ l'uscita considera anche prezzi **FUORI** dalla banda. Prezzo =
> `max(pavimento del gradino, min(obiettivo, miglior bid))` — la **stessa** aritmetica di
> `inseguiIlBid`, non una seconda. Si rinuncia al premio su quella gamba per non restare direzionali.
> **⚠ IL MERGE VIENE PRIMA, SEMPRE, ED È SCRITTO**: `sizeAltroLato > 0` ⇒ si fonde e non si vende. La
> precedenza esisteva per struttura (`provaCoppia` gira prima in ogni ramo); adesso è **una
> condizione**, e `sizeAltroLato` **non letta** chiude la deroga.
> **⚠ IL TAPPO DEL 5% (R7) E LA SCALA DI §7 NON SI TOCCANO**: il pavimento è un `Math.max`, quindi
> questo ramo può solo scegliere un prezzo che la scala **già consentiva**. Se il pavimento resta sopra
> il bid, l'ordine sta a riposo fuori banda e non si riempie — **è la risposta voluta**.
> **⚠ IL PAVIMENTO SI ARROTONDA IN SU SULLA GRIGLIA, e la direzione è obbligata**: `pavimentoConcesso`
> è una frazione del carico (0,68 × 0,95 = **0,646**) e non cade su un tick. In giù concederebbe **più**
> perdita; in su ne concede **meno**. Il pavimento che esce dal piano è quello arrotondato, o
> `inseguiIlBid` a valle lo riporterebbe fuori griglia.
> **⚠ IL TRIGGER DI BANDA NON GIUDICA UN'USCITA FUORI BANDA VOLUTA**: `band-exit` chiude **a mercato**,
> cioè vende al bid, che starebbe **sotto** il pavimento — sarebbe un modo di aggirare il pavimento del
> rischio. `decideExit({fuoriBandaVoluta:true})` non valuta il trigger 1 e lo dichiara; **il tetto di
> attesa (24 h) resta intatto**, ed è l'unica via d'uscita che non passa dal pavimento.
> **⚠ E NON DICHIARA `inCoda`**: `manual-order` **riassegna** `price = q.price` dopo `prezzo-in-coda`,
> e quel ricalcolo riporterebbe l'uscita **dentro** banda, annullando in silenzio il prezzo scelto. È la
> **quarta** omissione condizionata di `inCoda` in `auto-close`, contata per nome da
> `risposta-al-fill.test.js`. «Mai primo sul libro» non è toccata: su un SELL non rifiuta mai.
> **⚠ IL PREMIO PERSO È ZERO PER COSTRUZIONE**, non per misura: un'uscita fuori banda **resta a
> riposo** solo dove `b.hi < pavimento`, cioè dove **nessuna uscita in banda era ammessa** e quindi non
> c'era nessun ordine da cui maturare. Quando il bid arriva al prezzo scelto l'ordine **attraversa** e
> si riempie: non riposa. Asserito su 7.000+ stati in `uscita-fuori-banda.test.js` ⑥.
> **⚠ MONOTONO E OPT-IN**: senza `uscitaFuoriBanda: true` `planExit` è la funzione di prima riga per
> riga (asserito su 273 combinazioni); la deroga non abbassa mai un'uscita né la fa sparire.
> **Fail-closed** su ogni ingresso: bid illeggibile, ask dell'altro lato illeggibile, coppia non
> misurabile, `sizeAltroLato` non letta ⇒ nessuna deroga.

# Referto — 23 agosto 2026, 13:5xZ

## Due difetti chiusi: le posizioni senza via d'uscita, e il rinnovo GTD che azzera la coda

**PRIMA la misura, POI l'applicazione, nello stesso giro.** Tutto ciò che segue è letto dal libro
vivo, dal giornale e dal pacchetto installato: nessun numero è ricordato.

---

## 0 · Stato dichiarato PRIMA di toccare (punto 7)

Fotografia del venue alle **13:22:56Z**, letta con l'adapter *cancel-only* (nessuna superficie di
piazzamento caricata):

| | |
|---|---|
| ordini a riposo | **30** su **15** mercati |
| coppie simmetriche | **13** |
| gambe sole a libro | **2** |
| posizioni aperte | **5**, tutte **scoperte** (zero coppie) |
| nozionale a riposo | **$770,38** |
| cassa (pUSD, on-chain) | **$1.452,20** |
| età degli ordini | media **8,1 min** · max **22,6 min** · min 0,6 min |

**Processi riavviati: due, e solo due — `agent40-manual-reprice` e `agent41-realloc-scheduler`.**
Sono i soli che caricano il codice toccato: agent40 giudica e scrive il registro degli abbandoni e
timbra il GTD della corsia di chiusura; agent41 lo legge per liberare lo slot.
**Ordini toccati dal riavvio: ZERO.** Nessuna cancellazione, nessun piazzamento, nessuna modifica di
prezzo fa parte di questo lavoro. ⚠ Ma va detta la conseguenza nota (§CLAUDE.md, riquadro in cima):
**ogni riavvio di agent40 rende PRE-ESISTENTI gli ordini già a libro** — invisibili al motore, quindi
non riprezzati e non rinnovati — e con `MANUAL_ORDER_PLACEMENT=send` quelli muoiono per GTD entro
≤ 23 minuti e vengono ripiazzati dal ciclo normale. **Il riavvio di agent41 azzera anche la quarantena
in memoria della regola «slot sterile»** (`statoLibroVuoto`), che è una perdita del freno anti-churn,
non un disarmo: per 22 minuti nessuno può essere rilasciato.

---

## 1 · La soglia di abbandono — il conto, non il gusto

**La regola** (`lib/maker/abbandono-posizione.js`, puro):

```
ABBANDONO  ⟺  valoreResiduo < SOGLIA   E   costoUscita ≥ valoreResiduo
```

* `valoreResiduo` = il **bid CAMMINATO** per l'**intera** size — i dollari che il libro paga *adesso*.
  Mai `size × mid`: la misura del 16 agosto (283 campioni, **zero** istanti con un'uscita in guadagno)
  dice che il mid non è consumabile, ed è lo stesso motivo per cui `presa-di-profitto` cammina la scala.
* `costoUscita` = la perdita realizzata che si accetta, presa dalla via più economica fra le due:
  * **vendita** `size × (carico − bidCamminato)`
  * **coppia** `size × (carico + askAltroCamminato − 1)`

> ### ⚠ Le due vie costano identico, ed è strutturale — non un caso del giorno
> I due token di un mercato binario condividono **un solo libro**: un BUY di NO a `p` *è* un SELL di
> YES a `1 − p`, quindi `askAltroLato = 1 − bidMioLato` per costruzione. Sostituendo:
> `costoCoppia = size × (carico + (1 − bid) − 1) = size × (carico − bid) = costoVendita`.
> **Misurato sulle cinque posizioni vive: identiche alla quarta cifra, 5 su 5.** Il `min` resta scritto
> lo stesso, e non è ridondanza difensiva: è l'unico punto che se ne accorgerebbe se il venue
> disaccoppiasse i due libri. Un'asserzione lo verifica.

### Il conto della soglia

```
SOGLIA_ABBANDONO_USD = PERDITA_MAX_FRAZIONE × MARKET_CAP_FIXED_USD = 0,05 × $61,25 = $3,0625
```

Entrambe le grandezze sono **importate** dai moduli dove già vivono (`urgenza-scoperto`,
`concentration`): ricopiarne una sarebbe il reperto **D1** su un limite di rischio.

**Perché proprio quel prodotto.** `PERDITA_MAX_FRAZIONE` è quanto **R7 autorizza la scala d'urgenza a
bruciare** per liberare una gamba; `MARKET_CAP_FIXED_USD` è **la gamba più grande che questa
configurazione possa aprire**. Il prodotto è quindi *il massimo che il bot possa legittimamente
spendere per uscire da una posizione qualsiasi*. Una posizione che vale meno di quella cifra è, per
costruzione, una posizione su cui la scala è autorizzata a spendere **più di quanto la posizione
valga** — cioè esattamente lo stato che R6 vieta. **La soglia non è un gusto: è il punto in cui R6 si
contraddice.**

⚠ **L'operatore aveva suggerito «ordine di grandezza $5».** Sul board di oggi **$3,06 e $5,00 danno lo
stesso verdetto su tutte e cinque le posizioni** (abbandonano le stesse due, salvano le stesse tre).
Si tiene il **derivato**, che è anche il più stretto: abbandonare è smettere di provare, quindi il
verso prudente è abbandonare di **meno**.

### Quali posizioni ricadono nella regola — dichiarato a secco, col modulo vero

| verdetto | mercato | size @ carico | valore residuo | costo d'uscita | causa |
|---|---|---|---|---|---|
| **ABBANDONATA** | `0xc5cd9325` MrBeast 37-39M | 56,5 @ 0,05 | **$0,45** | **$2,38** | costa più di quanto vale |
| **ABBANDONATA** | `0xd947c421` Don't Say Good Luck | 56,1 @ 0,065 | **$1,52** | **$2,12** | costa più di quanto vale |
| resta | `0x4d79d306` Democratic House | 56,1 @ 0,494 | $21,88 | $5,83 | sopra soglia |
| resta | `0x790474c0` Trump 180-199 | 52,8 @ 0,099 | $3,85 | $1,37 | sopra soglia |
| resta | `0xb3c7f543` Iran sanctions | 2,8461 @ 0,87 | $2,33 | $0,14 | **sotto soglia ma uscita conveniente** |

L'ultima riga è la prova che la **doppia** condizione serve: Iran vale $2,33, cioè sotto la soglia, ma
uscire costa $0,14 — la regola a una condizione sola l'avrebbe abbandonata per sbaglio.

---

## 2 · Il limite resta — cosa l'abbandono NON fa

* **Non cancella nulla al venue e non vende.** Il modulo è puro: due `require` di sole costanti, zero
  I/O, nessuna superficie di piazzamento o cancellazione raggiungibile.
* **Non sparisce dai conti.** La posizione resta al venue ⇒ resta dentro `readVenuePositions`, dentro
  il totale del guardiano, dentro `capitale-al-lavoro` e dentro il P&L. **Abbandonare è smettere di
  AGIRE, non di CONTARE.**
* **Resta visibile nel giornale**: una riga `posizione-abbandonata` **a ogni giro**, con valore
  residuo, costo d'uscita, soglia, bid camminato, gradino e minuti di scopertura. Più
  `posizione-abbandonata-dichiarata` all'ingresso e `posizione-abbandonata-rientrata` all'uscita.
* **La coppia batte sempre l'abbandono**: `sizeAltroLato > 0` ⇒ mai abbandonata (il merge rende
  $1/share, e nessuna soglia vale più di così). `sizeAltroLato` non letta ⇒ **non giudicabile**.
* **Asimmetrico apposta**: si **entra** con 2 osservazioni contigue (≤ 5 min), si **esce** con una.
  Un giudizio `non-giudicabile` non fa rientrare: lascia la voce com'è, o un buco di feed rimetterebbe
  in gioco una posizione abbandonata e ricomincerebbe a bruciare tentativi.
* **Fail-closed su ogni ingresso**: carico, size, `sizeAltroLato` non finiti, o una delle due scale che
  non copre l'intera size ⇒ non si abbandona.
* **Lo slot si libera solo se OGNI posizione di quel mercato è abbandonata.** La sottrazione avviene in
  `agent41.posizioniPerSelezione`, l'unico ingresso da cui la selezione deriva `inGestione`: il mercato
  ricade nel ramo **già esistente e già provato** («era in gestione e al venue non c'è più niente»).
  Nessun ramo nuovo nella macchina della rotazione. **§4.8 non è toccata.**

---

## 3 · L'anomalia dei 240 minuti — **NON era muta**

**Dichiarazione richiesta: la riga è stata scritta, e molte volte.** Misurato sul giornale della
finestra 06:13Z → 13:18Z:

| mercato | righe `scoperto-oltre-soglia-grave` | scopertura coperta |
|---|---|---|
| `0x4d79d306` Democratic House | **394** | da 249,3 a **673,3 min** |
| `0xd947c421` Don't Say Good Luck | **101** | da 240,4 a 349,0 min |

Il presidio ha un chiamante (`auto-close.js`, subito dopo `decideClose`) e non è mai stato silenzioso.
**Non c'era niente da riparare, e non è stato riparato.**

⚠ **Ma il lavoro di oggi poteva renderlo muto, ed è il rischio che ho dovuto disinnescare.** Il blocco
dell'abbandono fa `continue` sulla posizione: messo *sopra* l'anomalia, avrebbe spento una difesa
mentre dichiarava di non toccarne nessuna — la classe «filtro a monte che svuota l'eccezione scritta a
valle», applicata a sé stessi. Il blocco sta **dopo**, e un'asserzione lo difende: spostandolo, il test
diventa rosso (verificato per mutazione).

---

## 4 · Il rinnovo GTD

**Durata in uso.** `RESTING_GTD_SECONDS = 1380` s (**23 min effettivi**) con
`REFRESH_MARGIN_SECONDS = 180`: ogni ordine viene **cancellato e ripiazzato dopo 1.200 s = 20 min**.
Coerente con la misura: età massima osservata **22,6 min**.

**Chi rinnova.** `agent40-manual-reprice`, tramite `auto-reprice.decideReprice` → gate
`expiry-refresh` → `replaceManualOrder` (cancel + place). Misurati **305 rinnovi** in 7,1 h.

**Perché cancella e ripiazza invece di prolungare — verificato, non supposto.** L'`expiration` di un
ordine sta **dentro la struct EIP-712 firmata**, e **nessuno dei due SDK installati espone
`modify`/`amend`/`extend`**: 88 metodi in `@polymarket/clob-client-v2`, **zero** corrispondenze su
`modif|amend|updat|replac|edit|extend|renew` (il solo match è `updateBalanceAllowance`). Cambiare la
scadenza significa una firma nuova ⇒ un ordine nuovo ⇒ **in fondo alla coda**.
**Il venue NON permette di estendere.**

---

## 5 · Quanto vale la coda — la misura che ha deciso cosa toccare

> ### Il premio non conosce la coda. Zero, per costruzione.
> `quadraticUserShare(competitorQ, mid, maxSpreadCents, minSize, capital, distanceCents)` prende **sei**
> parametri e **la posizione in coda non è uno di quelli**; il punteggio è `scoreOrder(d,v) = ((v−d)/v)²`.
> Zero occorrenze di *queue*/*coda*/*priorità* in `lib/rewardScore.js`. **Un ordine di quotazione che va
> in fondo alla coda matura esattamente lo stesso premio.**

**Il churn residuo sulla quotazione, misurato:** 43 rinnovi/h con un buco `cancel→place` di **12,47 s
medi** (mediana 1,55 s · p90 37,3 s · p99 184,5 s) ⇒ **0,53% del tempo-libro** ⇒ al ritmo di premio di
oggi ≈ **$0,03/giorno**. **Allungare lì non compra niente** — e costerebbe esposizione non presidiata,
oltre a invertire in silenzio la calibrazione di `ripristino-gambe` (il cui tetto di 30 min sta *sopra*
la GTD della quotazione). **`RESTING_GTD_SECONDS` non è stato toccato: resta 1380.**

**Dove la coda conta davvero: la corsia di CHIUSURA.** Lì il fill è ciò che si vuole. Misurato: il SELL
d'uscita di `0x4d79d306` è stato piazzato **24 volte** in 673 minuti; quello di `0xd947c421` **18**.
E c'era un'**inversione**: `MERGE_WAIT_TIMEOUT_MIN` concede **30 minuti** all'ordine di completamento
del Livello 2, ma quell'ordine portava i **23 minuti** della quotazione — il venue lo ritirava *prima*
che la regola smettesse di aspettarlo (a giornale: `merge-in-attesa … 29,8 min` su un ordine morto a 23).

**La correzione, derivata:**

```
GTD_CHIUSURA_SECONDS = MERGE_WAIT_TIMEOUT_MIN × 60 + REFRESH_MARGIN_SECONDS = 1800 + 180 = 1980 s (33 min)
```

Entrambe **importate**: chi cambia l'attesa del Livello 2 muove anche questo, e non può dimenticarsene.

⚠ **Cosa costa, detto per intero**: se l'host muore, un ordine **di chiusura** resta a libro fino a 33
minuti invece di 23. È l'unica direzione accettabile, perché un ordine di chiusura può solo **ridurre**
l'esposizione. **Nessun ordine di apertura è toccato**, e `riposizionaDopoChiusura` — che *riapre* due
gambe — è dichiarato ed escluso.

⚠ **Il punto unico è `chiudendo(spec)`, non `piazzaChiudendo`, e crederlo era l'errore**: in
`auto-close.js` ci sono **cinque** chiamate a `deps.placeOrder` e **una sola** passa da
`piazzaChiudendo`. Le altre quattro sono l'uscita ordinaria, il riposizionamento scoperto, il rimasuglio
sotto il minimo, e — l'unica che non è una chiusura — il riposizionamento dopo la fusione.

---

## 6 · Un difetto vero, misurato e NON corretto (punto 12)

> ### 🔴 63 ordini morti per GTD senza rinnovo in 7 ore, $862,58 di nozionale fuori dal libro
> `scaduto-senza-rinnovo`, finestra 06:13Z → 13:18Z. **Causa dominante: `motore-non-conforme`, 49 su 63**
> (`close-sell-floor` 5, `rate-limited` 4, non dichiarata 5). Cioè: **il 20,7% dei rinnovi finisce con
> l'ordine morto**, perché un rinnovo *allo stesso prezzo* deve ripassare dal motore, e se il motore in
> quell'istante dice no (tipicamente `profondita-insufficiente`) l'ordine muore invece di essere
> prolungato. Il caso di Bad Bunny delle 12:49:01 è esattamente questo.
> **NON corretto di proposito**: allungare il GTD ne riduce solo la *frequenza*, non lo aggiusta; e
> sollevare il motore su un rinnovo è una decisione di rischio, non una patch.

Altri due, dichiarati e non toccati:
* **`allowlist-con-posizioni.test.js` lampeggia, e non è mio**: rosso nella prima passata, **verde nella
  seconda**, e rosso anche con le mie modifiche messe da parte (`git stash`). Causa misurata: il test
  inietta `posizioni` ma non neutralizza `enabledDaOrdini`, e nell'istante rosso c'era **1 mercato con
  ordini vivi fuori dalla lista dell'operatore** (`liveMin 18` contro `operatore 17`). È la classe
  «rossi che dipendono dai DATI VIVI» di §5.2 p.11 — ruota col libro, non è una regressione. La cura
  sarebbe iniettare anche gli ordini; **non fatta**, è un secondo lavoro.
* **`chiusura-senza-tetto.test.js` fotografava il sorgente** (`res = await deps.placeOrder({`, graffa
  compresa) invece della proprietà. **Questo l'ho corretto**, perché era rosso per causa mia: adesso
  cerca la chiamata e non la forma dell'argomento. Terza occorrenza della classe (§5.3).

---

## 7 · Asserzioni — e falliscono davvero sul sorgente non corretto

`lib/maker/abbandono-e-anomalia.test.js` — **30/30 verdi**. Le tre mutazioni provate:

| mutazione | asserzione che diventa rossa |
|---|---|
| l'anomalia dei 240 min resa muta | ② «posizione ABBANDONATA e scoperta da 649 min: l'anomalia grave è comunque a verbale» |
| il GTD di chiusura non timbrato | ⑥ «ogni ordine di CHIUSURA parte col GTD della corsia di chiusura» |
| l'abbandono non ferma i tentativi | ① «la posizione confermata abbandonata produce la riga `posizione-abbandonata`» |

Più: `lib/maker/abbandono-posizione.js` ha **21 prove interne** (`node lib/maker/abbandono-posizione.js`).

---

## In sei righe

1. **La soglia è $3,0625**, e non è scelta: è `PERDITA_MAX_FRAZIONE × MARKET_CAP_FIXED_USD` = il 5% che
   R7 autorizza a bruciare, applicato alla gamba più grande apribile — cioè il massimo spendibile per
   uscire da una posizione qualsiasi. Sotto quella cifra R6 si contraddice. Sul board di oggi $3,06 e i
   $5 suggeriti danno **lo stesso verdetto**, e si tiene il derivato perché è il più stretto.
2. **Diventano abbandonate due**: `0xc5cd9325` MrBeast (vale $0,45, uscire costa $2,38) e `0xd947c421`
   Don't Say Good Luck (vale $1,52, costa $2,12). Restano Democratic House ($21,88), Trump 180-199
   ($3,85) e Iran — quest'ultima sotto soglia ma con un'uscita che costa $0,14, cioè la prova che la
   doppia condizione serve.
3. **L'anomalia dei 240 minuti NON era muta**: 394 righe su Democratic House (fino a 673,3 min) e 101 su
   Don't Say Good Luck. Non c'era un presidio senza chiamanti, e non è stato riparato niente — ma il
   `continue` dell'abbandono poteva renderlo muto, quindi sta **dopo**, e un'asserzione lo difende.
4. **Del GTD ho cambiato solo la corsia di chiusura**, da 23 a **33 minuti**
   (`MERGE_WAIT_TIMEOUT_MIN × 60 + REFRESH_MARGIN_SECONDS`), perché il venue **non sa estendere** (88
   metodi SDK, zero `amend`) e perché l'ordine di completamento moriva a 23 minuti su un'attesa di 30.
   **La quotazione resta a 23**: il premio non conosce la coda — `quadraticUserShare` ha sei parametri e
   nessuno è la posizione in coda — e il churn residuo vale **$0,03/giorno**.
5. **La coda vale $0 in premio e molto in fill**: 24 ripiazzamenti del SELL d'uscita di Democratic House
   in 673 minuti, 18 di Don't Say Good Luck. È lì che l'ho comprata, non sulla quotazione.
6. **La suite: 255 test · 247 verdi · 7 ROSSI · 1 non parte** — i sette noti e nient'altro
   (`dipendenze-mai-iniettate`, `distanza-2c`, `end-of-scale-cycle`, `tetti-per-giro-e-scope`,
   `categoria-mercato`, `tetto-derivato-dallo-scaglione`, `tetto-e-scoperta`). Il capitale al lavoro
   dopo due cicli è in coda a questo file (§ *Dopo due cicli*).

---

## Dopo due cicli — 14:01Z, misurato

Riavviati **solo** `agent40-manual-reprice` (pid **911306**) e `agent41-realloc-scheduler`
(pid **911312**), insieme e **dal file**. Ambiente confermato da `/proc/<pid>/environ`: cinture
invariate (`MAKER_MODE=live-min`, `MAKER_ADAPTER_DRYRUN=false`, `MANUAL_ORDER_PLACEMENT=send`,
`REALLOC_SCHEDULER_DRY_RUN=0`), `MAKER_MERCATI_CONTEMPORANEI=18`, `MAKER_SLOT_CORTI=2`,
`MAKER_QUOTA_CODA_LUNGA=0.5`, `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V=0.6666666666666666`.

| | |
|---|---|
| ordini a riposo | **26** su **13** mercati |
| età degli ordini | media **8,0 min** · max **22,3 min** · min 1,6 min |
| coppie simmetriche a libro | **11** · gambe sole a libro **2** |
| posizioni | **6 righe su 5 mercati** — 1 coppia (MrBeast), **4 gambe nude** |
| nozionale a riposo | **$690,08** |
| cassa · posizioni · totale | $1.434,01 · $55,94 · **$1.489,95** |
| **capitale al lavoro** | **$746,02 = 50,1%** |
| PnL guardiano | −$11,67 |

### Le posizioni scoperte e il loro gradino

| mercato | gradino | scoperta da | verdetto |
|---|---|---|---|
| `0x4d79d306` Democratic House | **3** | 717,0 min | resta (vale $21,32, uscire costa $6,40) |
| `0xd947c421` Don't Say Good Luck | **3** | 392,8 min | **ABBANDONATA** (vale $1,52, costa $2,12) |
| `0xc5cd9325` MrBeast | **2** | 88,7 min | resta — **coppia completa** |
| `0xb3c7f543` Iran | **2** | 61,1 min | resta (vale $2,13, ma uscire costa $0,34) |
| `0x790474c0` Trump 180-199 | **1** | 49,2 min | resta (vale $3,83, sopra soglia) |

### Le tre prove che la regola è viva, e non solo compilata

1. **La prima osservazione ha armato soltanto** — registro alle 13:57:31 con `osservazioni: 1` e
   `abbandonataDal: null` su entrambe; l'abbandono è scattato al **secondo** giro, alle **13:58:36**.
2. **L'anomalia dei 240 minuti continua a essere scritta su una posizione ABBANDONATA**: alle
   **13:59:11** `scoperto-oltre-soglia-grave` su `d947c421` (gradino 3, 390,3 min), e dieci secondi
   dopo `posizione-abbandonata` sullo stesso mercato. **L'ordine dei due blocchi regge in produzione,
   non solo nel test.**
3. **Il rientro ha funzionato da solo, su un caso vero, in 49 secondi.** Alle 13:58:36 MrBeast era
   abbandonata; poi la sua **gamba sorella ha ricevuto un fill (20,1 share @ 0,90)** e alle 13:59:25 il
   giornale porta `posizione-abbandonata-rientrata` — *«vale $2,38 ma uscire costa solo $0,44, meno di
   quanto si incassa: si continua a provare»*. E lo **slot NON è stato liberato** per MrBeast, proprio
   perché una delle sue due gambe è viva: `slot-liberato-per-abbandono` alle **14:00:27** elenca il solo
   `0xd947c421`. La condizione «solo se OGNI posizione del mercato è abbandonata» ha morso su un caso
   reale entro cinque minuti dal varo.

---

## Difetto trovato nel riavvio, dichiarato e NON corretto

> ### 🔴 `MAKER_FILTRO_METEO` non è in `agents/ecosystem.config.js`, e il filtro meteo è ARMATO
> Il CLAUDE.md dichiara in cima «`MAKER_FILTRO_METEO=0` ⇒ **FILTRO METEO DISARMATO** (dal 23 agosto
> 2026)». Ma la variabile **non compare**: né in `/proc/911312/environ`, né nel `.env`, né in
> `agents/ecosystem.config.js` — e `git log -S` dice che **non c'è mai stata** in quel file (compare solo
> dentro la ricetta di ripristino in `APERTI.md`, che presuppone una riga `MAKER_FILTRO_METEO: '0',`
> inesistente). Per la regola di §4.13 — *«assente ⇒ ARMATO, solo il valore esatto `'0'` disarma»* — il
> filtro **è armato**, cioè l'opposto di quanto il documento dichiara. È la trappola di §5.1: una
> variabile messa con `--update-env` vive solo nel processo e **il primo riavvio dal file la perde**.
> ⚠ **NON è stato il mio riavvio a cambiarla**, ed è misurato: `ammissibili` vale **20 alle 13:39 e 20
> alle 13:43**, sullo stesso board (281 valutati) — nessuno scalino attraverso il riavvio delle 13:41.
> Era già persa prima, con ogni probabilità al riavvio dal file delle 11:14.
> **Non corretto**: riarmare o disarmare il filtro meteo è una decisione dell'operatore, non una patch,
> e §6 di questo giro dice esplicitamente di non toccarlo.

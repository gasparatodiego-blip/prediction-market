# Cosa resta aperto — aggiornato il 19 agosto 2026

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto costa
se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

> ## 🔴🔴 FINESTRA DI OSSERVAZIONE — 24 ORE DALLE 15:22Z DEL 19 AGOSTO 2026
> **Il bot è VIVO con capitale vero, `send` su entrambi i processi, e in questa finestra NON SI TOCCA.**
> Nessun deploy, nessun riavvio, nessuna modifica. Un difetto trovato **si scrive qui e non si corregge**.
> **Unica eccezione che ferma tutto**: un `reject-venue` su `cancelOrder` o `cancelMarketOrders`.
> Il perché e cosa si sta registrando stanno in **§15**.

---

## IL QUADRO — dove siamo, letto dai processi vivi il 19 agosto alle 15:20Z

| | |
|---|---|
| **flotta pm2** | **11 processi ONLINE**, utente `bot`, `cwd` `/home/bot/bot` · agent34 pid 465022 · agent40 pid 470362 · agent41 pid 470902 |
| **cinture** | **0/4 inserite**, da `/proc/<pid>/environ`: `MAKER_MODE=live-min` · `MAKER_ADAPTER_DRYRUN=false` · **`MANUAL_ORDER_PLACEMENT=send` su agent40 E agent41** · freno di agent41 `REALLOC_SCHEDULER_DRY_RUN=0` |
| **ultimo commit** | `153fac2` «anche agent41 torna a send: il bot puo' riaprire posizioni» |
| **a libro** | **3 mercati · 5 ordini · $136,59** — Kane, Yamal, «no Fed rate cuts». Letto dal venue (`data/venue-orders.json`) **e** ricostruito dal giornale: **i due concordano** |
| **posizioni** | **ZERO**. Nessun fill da quando è armato: il residuo Hong Kong non c'è più nello snapshot |
| **selezione** | **ACCESA**, 4 selezionati su un tetto di **5** (`MAKER_MERCATI_CONTEMPORANEI=5`) · perno vuoto · 1 slot vuoto, causa dichiarata: «il board non offre abbastanza mercati ammissibili: **4 su 135 valutati**» |
| **interruttori** | KILL **spento** · AVVIA su **acceso** · `guardian-state.json` **assente** (= sano) · `chiusura-emergenza-richiesta.json` assente · `sospensioni-erosione.json` assente |
| **capitale** | saldo **$1.491,36** · PnL guardiano **−$58,82 (−3,79%)** contro una baseline del 16/08 — **sotto la soglia del 5%**, nessun latch |
| **premio** | stima integrata: **$1,94 il 18 agosto** (copertura 98,0%), **$0,79 oggi** fino alle 15:20 (copertura 94,0%). Incasso vero: ancora non pagato dal venue |
| **regole concordate** | **10 su 10 in servizio** (§0), **10 su 10 verificate dal banco** |
| **passi del giro completo** | **26 su 26**, 0 rossi — identico al controllo su HEAD nello stesso worktree |
| **suite** | **229 test · 226 verdi · 2 ROSSI · 1 non parte** (19/08, albero committato, misurato; erano 12 la mattina). I 2 dipendono dai **dati vivi** (board), non dal codice. Gli 8 di `c919981` sono stati riscritti sul gate `book-non-databile`; i 3 del tetto di esposizione sull'invariante giusta — **`cap ≥ riposo + completamento`**, cap fermo a $650 |
| **regole che scattano** | **20 statiche + 15 dinamiche su 91**, col cablaggio di produzione |
| **stop condition** | `reject-venue` su cancellazioni nelle ultime 24 h: **ZERO**. I 14 `reject-venue` del giornale sono tutti su `postOrder`/`manual-place`, cioè piazzamenti, non cancellazioni |

---

## 0 · ⚖️ REGOLE CONCORDATE — decise dall'operatore il 18 agosto 2026

**Sono la specifica del bot.** Il codice le rispetta tutte e dieci; il banco le verifica tutte e dieci.
Chi le cambia cambia il bot, non un dettaglio di implementazione — e deve cambiare **anche** il passo
del banco che le prova, o la prova resterebbe a difendere la regola vecchia.

| # | regola | dove vive | passo del banco |
|---|---|---|---|
| **1** | **QUANTI MERCATI** — il numero lo decide l'operatore prima di ogni sessione (uno, due, tre); i mercati li sceglie il bot. **Un solo posto** dove scriverlo, **letto dai processi vivi** | `MAKER_MERCATI_CONTEMPORANEI` in `agents/ecosystem.config.js` (solo agent41) → `lib/maker/quanti-mercati.js` → `selezione-mercati.quotaScaglioni(max)` | **18** |
| **2** | **SCELTA** — scarta pavimento premiante oltre $61,25, scadenza sotto 24 h, famiglia meteo. Ordina per **netto**, tenendo conto della concorrenza già in banda | `selezione-mercati.valutaAmmissibilita` (`:81`, `:110`, `:265`, `:282`, `:297`) · `valoreCandidato`/`ordinaCandidati` | **22** |
| **3** | **INGRESSO** — due gambe, SI e NO, **stessa size decisa insieme**. La più esterna possibile restando premiati: manopola **0,95**, un tick di margine dal bordo. ~$60 per mercato, ~61 share per lato | `size-da-capitale.sharePerLato` · `allocator:565` (`sizePerSideShares`) · `distanza-obiettivo.bordiConMargine` | **3**, **13** |
| **4** | **RIPREZZO** — guarda il **book**, non solo il mid. Riprezza se il mid esce dalla banda; **e anche** se la profondità davanti si erode: **cancella e resta fuori**, tetto **5 minuti**, poi rientra e lo **dichiara**. Freno **60 s**. Profondità non leggibile: tiene e lo dichiara | `auto-reprice.js:681` (TRIGGER 4) · `book-erosion.js` · `sospensione-erosione.js` · rientro in `agent41.riconciliaCopertura` | **19** |
| **5** | **FILL PARZIALE** — copre la quantità riempita comprando l'altro lato **per quella quantità esatta**. Cancella **sempre** il residuo, anche sotto il minimo. Poi merge | `strategia-merge.js:249` (`manca`) · `auto-close.js:1006`, `:1136` | **9** |
| **6** | **RESIDUO SOTTO IL MINIMO** — si chiude **sempre**, anche da taker. Limite: non spendere per uscire più di quanto la posizione valga | `presidio-posizioni-vecchie.js` (deroga) · `agent41.prezzoUscitaAttraversata` (il limite, sul ricavo nullo) | **20** |
| **7** | **FILL TOTALE** — taker se la coppia resta sotto **101¢**; altrimenti a riposo al massimo prezzo sotto il tetto, che matura premio, per **30 minuti**. Poi la scala: fino al carico, **dopo 60 minuti fino al 5%** | `strategia-merge.decidiLivello` · `urgenza-scoperto.js:72`, `:104`, `pavimentoConcesso` | **6**, **10**, **11** |
| **8** | **MERGE** — coppia completa: merge **subito, sempre, senza limiti di prezzo**. Il tetto di 101¢ vale **solo** per l'acquisto della gamba mancante | `strategia-merge.js:234-268` (il conto di `manca` sta **sopra** le guardie sul prezzo) | **7**, **12** |
| **9** | **ROTAZIONE** — sostituisce il peggiore solo se il nuovo rende **+$0,50/g oppure +25%**. Mai un mercato con posizione aperta o coppia incompleta (esce dai tre attivi ma resta gestito fino a coppia chiusa). Mai uno con ordini a riposo. Netto non misurabile: non spodesta e non si fa spodestare | `selezione-mercati.spodestaAbbastanza:157` · le quattro condizioni `:614-624` · `inGestione` `:433`, `:510`, `:527` | **8**, **23** |
| **10** | **KILL** — a −$100 nella giornata cancella tutti gli ordini **E chiude le posizioni**: coppie a merge, gambe scoperte vendute a mercato, gambe sotto il minimo **restano e vengono dichiarate**. Non riapre fino al giorno dopo | `kill-perdita-giornaliera.js` · `chiusura-di-emergenza.js` · agent43 **deposita**, agent41 **esegue** | **17**, **21** |

### Le tre cose che vanno sapute prima di toccarle

**⚠ R1 · ridurre il numero non chiude niente da solo.** La selezione non spodesta chi ha ordini vivi o
una posizione (R9), quindi il numero governa quanti mercati si **aprono**; il rientro avviene per
consumo. È la direzione prudente, ma non è un freno d'emergenza.

**⚠ R4 · senza il registro su disco la regola non esisterebbe.** A cancellare è agent40, a rimettere la
gamba a libro è agent41, e la sua scala di raffreddamento parte **subito**: avrebbe rimesso a libro
entro 120 s la gamba appena tolta. «Fuori 5 minuti» sarebbe durato due, e il giornale avrebbe mostrato
una cancellazione e un ripristino — cioè quello che il bot fa già.

**⚠ R6 e R10 dicono cose diverse sul sotto-minimo, ed è voluto.** R6 governa il percorso **ordinario**,
dove c'è tempo per un'uscita attraversata e il capitale bloccato costa più della perdita. R10 governa
l'**emergenza**, dove la priorità è togliere l'esposizione grande in fretta e non aprire percorsi nuovi.

### Le due divergenze confermate dall'operatore, dove il codice è **più prudente** della regola

| | regola | codice | decisione |
|---|---|---|---|
| **R3** | «un tick di margine dal bordo» | `max(1 tick, 0,22 × banda)`, col tetto a metà banda | **confermato il codice**: su banda modale coincide, su banda larga tiene di più |
| **R10** | «non riapre fino al giorno dopo» | **nessun auto-riarmo affatto**: resta fermo finché una mano non cancella il latch | **confermato il codice** |

---

## 1 · 🚚 LA MIGRAZIONE — chiusa, e cosa ha lasciato

**Il repo è `/home/bot/bot`, utente `bot`.** `/root` non è leggibile (`sudo` chiede la password), quindi
`/root/bot` e `/root/prediction-market` **non sono stati né letti né cancellati**: se ci sono, nessuno li
ha toccati.

**Dodici percorsi assoluti** erano diventati puntatori a niente (`57de3e8`, `abed26d`) e **nove file di
servizio in `/tmp`** non erano più scrivibili (`8636282`). La forma del guasto è sempre la stessa e per
questo nessuno se n'era accorto: *ogni lettore ha già un ramo per «non l'ho letto», e quel ramo si prende
la scena.*

| dove | come falliva |
|---|---|
| `ecosystem.config.js` — 11 `cwd` + 11 `HOME` | pm2 non trovava gli agent |
| `rewards-normalize` **+ `agent24.OUTPUT_FILE`** (gemello scrittore) | `readJson` → `null` ⇒ board **vuoto**, non illeggibile |
| `agent34` watchlist/mid-history/tape · `agent45` log guardiano | zero sottoscrizioni, «il guardiano non ha detto niente» |
| `route.ts` allocate · `rewards-selfcheck` | figlio morto ⇒ «output not JSON»; 3 asserzioni saltate |
| **`banco-ciclo-completo.VIVO`** | **il cancello si APRIVA**: `diff` esce 2, il `catch` legge stdout vuoto = zero differenze |
| **i 9 file di `/tmp`** | di `root`, sticky bit ⇒ né riscrivibili né cancellabili: gli scrittori in EACCES e **i lettori sulla copia vecchia, che non invecchia più** |

**La policy dei permessi era la parte peggiore**: l'hook `PreToolUse` puntava a `/root/rewards-bot/…` e
**non girava più**; le 7 regole `Edit(//root/rewards-bot/…)` non corrispondevano a niente, cioè `.env`,
`ecosystem.config.js` e i sei flag di stato erano modificabili **senza `ask`**; `~/.claude/settings.json`
aveva perso la copia. Rimessi: hook su `$CLAUDE_PROJECT_DIR`, **164 `ask`** in entrambe le copie.

**Due difese nuove nate da qui:**
- `lib/percorsi-runtime.js` — directory di servizio **per utente** (`/tmp/rewards-bot-<utente>`, 0700),
  una definizione al posto di ~40 letterali in 23 file. Il guasto non è riparato: è **inesprimibile**.
- `lib/safety/percorsi-critici.js` — controllo all'avvio nei **nove agent** che scrivono. Su percorso
  inutilizzabile: stderr + `exit 1`. ⚠ Un file **assente** non è mai un errore (è il primo avvio); non si
  controlla il **contenuto** (la freschezza ha già i suoi presidi). Test **15/0**, che costruisce ogni
  guasto vero e poi **lo rimette a posto** — un controllo sempre rosso non distingue niente.

---

## 2 · 🔒 LE QUATTRO CINTURE — e adesso mordono tutte

Regola per intero in **CLAUDE.md §4.14**. Erano cinque e ne mordeva **una**.

| cintura | dove morde | gate | valore vivo |
|---|---|---|---|
| `MAKER_MODE` | `evaluatePlacementGate`, via `buildPlacementAdapter` | `maker-mode` | `off` ⇒ **inserita** |
| `MAKER_ADAPTER_DRYRUN` | idem | `dry-run` | `true` ⇒ **inserita** |
| `MANUAL_ORDER_PLACEMENT` | l'ultimo `if` prima della POST | — (`dry-run-validated`) | `dry-run` su agent40 ⇒ **inserita** |
| freno di agent41 | `giro()` + `controlloCapitaleFermo` | — (non si invia) | **assente ⇒ inserita**, fail-closed |

**`MAKER_PLACEMENT` è stata TOLTA** (decisione dell'operatore): non era pericolosa, era **finta**. Il
ripiego sull'ambiente in `adapter.js` non aveva chiamanti, perché l'unico costruttore passa sempre
`placement` esplicito. ⚠ **Toglierla stringe**: senza ripiego, un chiamante che non passa `placement`
ottiene `dry-run`.

**La prova**: `node scripts/ricerca/prova-cinture.js` — **10 verdi, 0 rossi**. Ognuna inserita **da sola**
con le altre tre aperte ⇒ zero ordini al venue, col gate atteso; più il **CONTROLLO** (quattro aperte ⇒
l'ordine parte), senza il quale quattro rifiuti non proverebbero niente.

⚠ **La prima corsa le dava tutte e tre rosse per colpa del BANCO**, non della produzione: il suo adapter
simulato cablava modo/`dryRun`/`placement` ignorando gli `opts` — **più permissivo del venue proprio
sulle cinture**, cioè non le avrebbe mai potute smascherare. Corretto: il seam è solo la rete.

---

## 3 · 🧪 IL BANCO — **26/26**, deterministico, e indipendente da `data/`

```bash
cd /home/bot/bot-banco && node scripts/ricerca/banco-scenari.js
cd /home/bot/bot-banco && node scripts/ricerca/prova-determinismo-banco.js
```

Il worktree è **`/home/bot/bot-banco`**, allo stesso commit, `data/` copiato, `node_modules` collegato.
Il banco **chiede a `git worktree list`** dove sia il repo vivo invece di cablarlo, e un'uscita di `diff`
diversa da 1 è un **errore**, non uno zero.

**Il passo 13 prendeva `candidati13[0]`** — il primo mercato coperto sui due lati trovato iterando gli
ordini vivi, cioè un ordine che dipende da `data/`. Ora **si costruisce il proprio mercato** e lo apre dal
percorso di produzione. ⚠ **Filtrare i candidati non bastava**: restava comunque solo il mercato del passo
12. ⚠ **E servono `giro()` + `controlloCapitaleFermo()` in quest'ordine**: `ripristinaGamba` pretende una
riga nel piano **salvato**, e quel file lo scrive solo il ciclo pesante.

**Su due snapshot diversi di `data/`**: 18/18 entrambi, **20+15 identiche**. ⚠ Alla prima misura erano 16
contro 15, e la causa era `maker-allocated-capital.json` — l'unica memoria di un piano precedente a
sopravvivere all'«accensione da zero». Aggiunta ai file azzerati: **22+17 → 20+15**, e ora è una misura.

---

## 4 · 📉 I CINQUE MERCATI CORTI (24-72 h) — sola misura

`node scripts/ricerca/mercati-corti-24-72h.js` · board 141 righe · capitale $147 · tetto $61,25.
**Imbuto**: 141 → −49 pavimento oltre il tetto → −61 selezione → −5 fuori finestra → −4 netto non
calcolabile ⇒ **22 candidabili**.

| # | mercato | netto/g | lordo/g | quota | concorrenza | prof. altrui | minSize | pavimento |
|---|---|---|---|---|---|---|---|---|
| 1 | Eric Yonce FL-06 D | **$5,14** | $10,07 | 9,24% | 601 share | $951 | 50 | $61,25 |
| 2 | Fishback 10–15% | $3,66 | $6,82 | 9,09% | 613 | $1.246 | 50 | $61,25 |
| 3 | Keith Gross FL-02 R | $2,12 | $3,88 | 4,04% | 1.454 | $1.546 | 50 | $61,25 |
| 4 | Cory Mills FL-07 R | $1,18 | $2,68 | 2,68% | 2.221 | $1.053 | 50 | $61,25 |
| 5 | Joe Strada FL-11 R | $1,07 | $1,75 | 1,70% | 3.532 | $5.969 | 50 | $61,25 |

Tutti `minSize 50` ⇒ pavimento **$61,25 = esattamente il tetto**; al tetto **62,5 share/lato**, minimo
superato con 12,5 di margine.
⚠ **Scadono tutti e cinque nello stesso istante** (2026-08-18T23:59Z, primarie della Florida). Su un
mercato corto conta il **totale prima della scadenza**: **$6,01 · $4,29 · $2,48 · $1,38 · $1,25**.

**Cosa succede alla scadenza con una coppia aperta** — letto dai moduli, non scritto a mano:

| quando | cosa | con una coppia aperta |
|---|---|---|
| **−24 h** | la **selezione rilascia lo slot** | spegne **l'ingresso, non l'uscita**: la posizione resta gestita da §4.8 |
| −12 h | esce dall'universo del **piano** | niente righe nuove; ciò che è a libro non viene toccato |
| −3 h | **chiusura forzata** | una coppia **completa non si forza** ($1 comunque); una gamba **nuda** viene spinta all'uscita |
| −3 min | `market-too-close-to-close` | nessun ordine nuovo, **nemmeno un rinnovo** |
| 0 | chiusura | gli ordini non rinnovati muoiono per **GTD entro 23 min** |
| ore dopo | **risoluzione** (≠ chiusura) | riscatto su `payoutDenominator > 0` **on-chain**, mai su `closed` |

⚠ Su questi cinque **la prima tappa è fra ~4 ore**, non fra 16: è la selezione a 24 h.

---

## 5 · 💰 IL CAPITALE FERMO — le tre vie, coi numeri. **Nessuna applicata.**

`node scripts/ricerca/tre-vie-capitale-fermo.js` · capitale $147 · tetto oggi **$61,25** (scaglione
finanziabile 50) · tetto per ordine $65,63.

> **⚠ LA PREMESSA DELLA DOMANDA È VERA SOLO SE SI FORZA UN MERCATO SOLO.** Lasciato libero al tetto di
> oggi, **il pianificatore impiega tutti i $147 su TRE mercati, con 0% fermo**. Gli $85,75 fermi sono la
> conseguenza del vincolo «un mercato», non del tetto.

**(a) UN mercato** — impiegato **$61,25**, fermo **$85,75 = 58,3%**. Residuo irraggiungibile peggiore
**$45,24** (minSize 50, lato caro). ⚠ Non è una configurazione che il bot produca da solo: la selezione
apre tre slot.

**(b) ALZARE IL TETTO — la scala è DISCRETA.** Il tetto è `pavimentoPremiante(minSize)` dello scaglione
finanziabile, e i `minSize` del venue sono 20 · 50 · 100 · 200 · 1000. Quindi vale **$24,50 · $61,25 ·
$122,50 · $245 · $1.225 e nient'altro**: «alzarlo a $147» **non è esprimibile** (servirebbe un `minSize`
120, che non esiste).

| scaglione | tetto | Δ vs oggi | mercati | impiegato | fermo | candidabili | residuo peggiore |
|---|---|---|---|---|---|---|---|
| 20 | $24,50 | −$36,75 | 6 | $144,00 | $3,00 | 37 | $19,07 |
| **50 (oggi)** | **$61,25** | — | 3 | $147,00 | $0,00 | 93 | $45,24 |
| 100 | $122,50 | +$61,25 | 3 | $147,00 | $0,00 | 131 | $45,24 |
| 200 | $245,00 | +$183,75 | 3 | $147,00 | $0,00 | 142 | $45,24 |
| 1000 | $1.225 | +$1.163,75 | 3 | $147,00 | $0,00 | 142 | $45,24 |

⚠ **Il capitale impiegato NON è la leva**: da $61,25 in su è già tutto, e restano tre mercati. Quello che
cambia davvero è **quanti mercati diventano candidabili** (37 → 93 → 131 → 142) e il **residuo peggiore**,
che salta da **$19,07 a $45,24** fra lo scaglione 20 e il 50 e poi non cresce più (lo limitano i due tetti).
⚠ **Alzare il tetto per mercato alza anche il tetto per ordine** (`liveMinOrderCapUsd`), e con esso
l'esposizione di un singolo invio.

> **⚠ LA COLONNA «realistico $/g» NON È CONFRONTABILE FRA LE RIGHE, E LA MISURA LO DICHIARA DA SOLA.**
> Le cinque righe sono cinque corse del pianificatore, ~2 minuti ciascuna. Il tetto di oggi girato
> **prima** della scala dà **$57,17/g**, girato **dopo** **$102,84/g**: **fattore 1,8× in dieci minuti**.
> **Non è rumore fra corse** — tre corse consecutive stanno entro l'**1%** ($57,63 · $57,17 · $57,63) — è
> **DERIVA**: il board si riscrive ogni 15 minuti e lo storico di agent34 si sta ancora riempiendo dopo il
> riavvio della flotta. Le colonne **strutturali** (mercati, impiegato, fermo, candidabili, residuo) sono
> solide; il $/giorno si legge come ordine di grandezza, e **solo confrontando corse ravvicinate**.

**(c) DUE mercati** — impiegato **$122,50**, fermo **$24,50 = 16,7%**. Residuo irraggiungibile peggiore
**TOTALE $90,48**: è per-mercato per costruzione, quindi due mercati aperti sono **due** residui
possibili. ⚠ **Il tetto sull'esposizione aperta era $150 quando questa misura è stata scritta; dal 18
agosto è $650** (conta i fill riconciliati, non gli ordini a riposo). Il margine che questa riga
calcolava — $27,50 con due mercati pieni — è storia: a $650 il tetto non morde in questo scenario.

---

## 6 · LA SEQUENZA DI ARMAMENTO — scritta, **NON eseguita**

### Le precondizioni — nessuna è una cintura, e tutte vanno vere PRIMA

| # | cosa | come si verifica |
|---|---|---|
| P1 | il mercato del giro è scelto e la sua riga di piano esiste | `node scripts/cli/mercati.js` · `data/realloc-ultimo-piano.json` |
| P2 | **il perno** `MAKER_LIVE_MIN_MARKET=<conditionId>` in `agents/ecosystem.config.js` | riavvio **dal file e insieme**, poi `mercati.js` deve dire **1 mercato ed è quello** su ENTRAMBI |
| P3 | KILL spento · **AVVIA** (oggi è FERMA) · interruttore riprezzo acceso | `node scripts/cli/stato.js` |
| P4 | i limiti sono quelli decisi | per ordine $80 · esposizione $150 · perdita giornaliera $100 · 40 invii/60 s |
| P5 | il saldo copre il piano | il tetto si clampa al capitale: sotto $61,25 il piano si stringe da sé |

⚠ **P2 è la più importante**: senza perno il perimetro è *una conseguenza* dell'unione di §4.8 e **cambia
da sé** quando la posizione si chiude. E il perno **restringe**: un mercato con posizione non riceve più
il BUY di completamento coppia — chi lo vuole toglie il perno, non c'è una terza via.

### I passi che armano, in questo ordine

| ordine | cintura | dove | perché qui | cosa si verifica DOPO |
|---|---|---|---|---|
| **1°** | freno di agent41 · `REALLOC_SCHEDULER_DRY_RUN: '0'` | ecosystem, blocco agent41 | agent41 **tenta** e attraversa tutti i gate; con le altre tre inserite **nessun ordine raggiunge il venue**. Si osserva la pipeline a costo zero, ed è il passo che si disfa senza conseguenze | `stato.js` → 3/4 inserite, `puoPiazzare=false`; nel giornale `manual-place` con `dry-run-validated`, **zero** `sent`. Se compaiono `reject-*`, si legge il gate e **ci si ferma**: quello è il difetto da capire, non da aggirare |
| **2°** | `MAKER_MODE: 'live-min'` | ecosystem, **agent40 E agent41** | da oggi **gate anche la corsia manuale** (§4.14): finché è `off` nessun ordine passa, qualunque cosa dicano le altre | `stato.js` → 2/4; il gate `maker-mode` sparisce dai rifiuti |
| **3°** | `MAKER_ADAPTER_DRYRUN: 'false'` | ecosystem, **entrambi** | l'ombra forzata, che ora arriva davvero all'adapter | `stato.js` → 1/4; il gate `dry-run` sparisce dai rifiuti |
| **4°** | `MANUAL_ORDER_PLACEMENT: 'send'` | ecosystem, **entrambi** | **è l'ultima cosa fra il piano e il libro.** Va per ultima, da sola, con un solo mercato nel perimetro | entro **due minuti**: `stato.js` → `ordini a riposo` **2** e non più; `mercati.js` → perimetro ancora **1**; nel giornale `sent` **esattamente due volte**. **Se compare un terzo ordine, o su un mercato diverso, si preme FERMA** |

⚠ **I processi che decidono un prezzo si riavviano INSIEME e DAL FILE** (`--update-env` non rilegge
l'ecosystem): armarne uno solo produce un bot che apre e non rinnova.
⚠ **E dopo ogni cambio va rifatto `pm2 save`**, o il `@reboot` riporterebbe su la flotta di prima.

### Cosa guardare nella prima ora

| quando | cosa | rosso se |
|---|---|---|
| +2 min | `stato.js` · ordini a riposo | ≠ 2, o su un mercato che non è il perno |
| +5 min | giornale `ripristino-gamba` | `esito: rifiutata` con un gate che non sia una regola di rischio |
| +20 min | i due ordini sono ancora vivi (GTD 23 min ⇒ rinnovo) | zero ordini e nessun `manual-replace` |
| +30 min | `agent43-guardian` | un `PRE-ALLARME (1/2)` è normale; due letture consecutive fanno scattare il guardiano ed è **giusto** |
| a ogni fill | `carico-di-ripiego` con la sua `fonte` | `skip-no-entry-price`: il carico non è arrivato, e l'uscita non parte |

### Come si disarma

**Immediato, senza riavvio**: `node scripts/cli/ferma.js`. Il **KILL** cancella tutto ma ⚠ ferma **anche
l'uscita automatica**: è l'emergenza, non l'interruttore operativo. **Definitivo**: rimettere le cinture
nell'ecosystem e riavviare dal file.

---

## 7 · CIÒ CHE RESTA APERTO, col motivo

### Aperto per una decisione dell'operatore

| # | cosa | perché è ancora aperto | cosa serve da te |
|---|---|---|---|
| 1 | ~~**la metà di R6 che morderebbe davvero**~~ — **CHIUSA**: si compra l'altro lato anche oltre 101¢, coi due tetti **in dollari** decisi dall'operatore — mai più del valore della posizione, e mai più di $5. Se nessuno dei due basta, si dichiara e si aspetta la risoluzione | — | — |
| 2 | ~~**`tre-fix-sicurezza` scade**~~ — **CHIUSO**: limite alzato a 120 s per decisione dell'operatore. Misura 75,75 s e sotto carico concorrente può ancora scadere | — | — |
| 3 | ~~**i tre rossi voluti di §5.2 p.37**~~ — **CHIUSI il 19 agosto, e la chiusura del 18 era sbagliata**: l'invariante scritta allora (`capitale impegnato ≤ N × $61,25`) aveva la relazione giusta e la **grandezza sbagliata**, e infatti i tre sono tornati rossi col cap a $650. La grandezza vera è l'**esposizione massima raggiungibile** — N coppie a riposo **più il loro completamento**, $612,50 a N=5 — perché il gate somma `openNotionalUsd + notional` anche sugli ordini di apertura. Una definizione sola: `concentration.esposizioneMassimaRaggiungibileUsd`. **Cap fermo a $650**: scendere a $306 rifarebbe l'errore del 16 agosto | — | — |
| 4 | **`pm2 startup` non fatto** | richiede root, `sudo` chiede la password. Al suo posto una riga `@reboot … pm2 resurrect` nella crontab di `bot` | esegui il comando in CLAUDE.md §5.1, poi **togli la riga di cron** — due meccanismi che riaccendono la stessa flotta sono peggio di uno |
| 5 | **`git push` bloccato — 105 commit locali** | remote HTTPS, nessuna credenziale. I comandi per la chiave SSH sono stati dati; `~/.ssh` non esiste ancora | esegui i sei passi della chiave SSH |

### Aperto perché manca una misura

| # | cosa | perché è ancora aperto |
|---|---|---|
| 6 | **la sentinella vede il vuoto, non il collasso** | il ramo ③ azzera l'orologio se `ordiniARiposo > 0`: un calo da 23 ordini a 2 è invisibile. La cura è un secondo criterio (calo relativo su finestra) e va tarato su quanto oscilla normalmente il numero di ordini — misura che oggi non esiste |
| 7 | **R4: sul lato misurabile nessun crollo, sul lato che si è riempito NON SI SA** — misurato il 19 agosto sui book del 18 (`data/ricerca/erosione-18-agosto.md`) | Sulle **vite reali** dei 47 ordini misurabili: a **40% zero scatti e zero letture sotto soglia**, minimo di giornata **58,9%** della baseline. Il fill del 23:17:21 è venuto **dal mid** (profondità piatta a 260 share fino a −2 s, poi +8¢ in un intervallo). ⚠ Il feed campiona ogni **75,0 s** contro i 5-10 s di agent40 ⇒ un crollo più breve di **150 s** è invisibile, i numeri sono un **limite inferiore**; e le **20 gambe sul book NO non hanno dati**, compresa quella riempita. **Soglia non toccata** |
| 7-bis | **⚠ NON SAPPIAMO SE LA CODA DAVANTI ALLA GAMBA NO SI È ASSOTTIGLIATA FRA LE 23:02 E LE 23:17 del 18 agosto** — ed è la domanda che deciderebbe se R4 serve | Alle 23:17:11 il nostro bid NO era a **72¢ col miglior bid altrui a 63¢**: davanti a noi non c'era **nessuno**, quindi lì R4 non poteva scattare a nessuna soglia (`zoneDepth` su zona vuota non riscalda mai la baseline — «è voluto»). Ma **come** ci siamo ritrovati soli non si sa: fra le 23:02 e le 23:17 **non esiste un solo record col bid altrui**, e se la coda si è assottigliata in quei quindici minuti **quella era esattamente l'erosione che R4 esiste per cogliere**. Non è recuperabile: `mid-history` allora registrava un book solo. **Rifacibile al prossimo fill, non su questo** |
| 8 | **il book è troncato a 3 livelli** | la profondità davanti è una sottostima, e la baseline pure. Il *rapporto* fra le due — che è ciò che decide — è meno distorto, ma non esente. È anche la ragione per cui «è sparito un livello» è stato buttato |
| 9 | **la rotazione toglie il tetto sul numero di mercati esposti** | tre quotano, N completano. Non è misurato quanti possano stare in gestione insieme su book veri |
| 10 | **la cadenza adattativa è sotto-risolta** | agent40 classifica il 99,6% «lenta» mentre `leggiFinestraTutti` vede `rangeMid = 0` sul 48,8%: il conto non torna. Non è la leva |
| 11 | **che il residuo NASCA** | la via d'uscita esiste (riscatto on-chain, nessun minimo). Resta a monte: le leve sono size e profondità, non un meccanismo nuovo |
| 12 | **`npm run build` fallisce** | manca `lucide-react`, causa preesistente. Il JS compila, muore nel type-check. Il `dashboard` non è nella flotta ⇒ non serve a nessun processo vivo |

> ### 🔭 DA QUI IN AVANTI QUELLA FINESTRA SAREBBE COPERTA? — sì per R4, no per «il bid altrui»
> Risposta al 19 agosto, dopo il riavvio di agent34 (verificato sulle righe vive: 244 righe col campo
> `no`, **190 con i livelli su entrambi i lati**).
>
> **✅ COPERTO — la serie che serve a R4.** Ogni riga porta ora il book NO completo, livelli compresi,
> quindi `book-erosion.zoneDepth` è calcolabile sulla gamba NO esattamente come sulla YES. La misura
> del 18 agosto, rifatta su una giornata futura, **non avrebbe più il buco che ha adesso**.
>
> **❌ NON COPERTO — «miglior bid altrui» NON è una serie separata, e non lo diventa.** `mid-history`
> registra il book **grezzo del venue**, che **include i nostri ordini**: per separare «altrui» da
> «nostro» servirebbe sapere quali ordini erano nostri a quell'istante, e la riga non lo dice. Oggi
> quel numero si trova solo nei record `auto-reprice`, e solo quando il gate «mai primo» lo cita
> **dentro il testo del motivo** — cioè per caso, non per costruzione.
>
> **⚠ MA PER R4 NON SERVE, ed è la parte che va capita per non aggiungere un dato inutile:**
> `zoneDepth` salta per costruzione il proprio livello e tutto ciò che sta sotto
> (`if (price <= orderPrice + EPS) continue`), quindi **la profondità davanti è già «altrui»** senza
> bisogno di sottrarre niente. Il «miglior bid altrui» servirebbe a una domanda diversa — *eravamo noi
> in cima?* — che si ricava lo stesso confrontando `bestBid` della riga col nostro prezzo, preso dal
> giornale.
>
> **⚠ DUE COSE RESTANO NON RISPONDIBILI, e vanno sapute prima di fidarsi della prossima misura:**
> ① **quanto del libro era nostro** — non separabile dalla sola riga;
> ② **due nostri ordini vivi sullo stesso lato a prezzi diversi** (può capitare durante un ripristino
> di gamba): quello più lontano dal mid verrebbe contato come profondità **altrui**, cioè la misura
> sbaglierebbe nella direzione che rassicura. Chiuderlo vorrebbe dire scrivere i nostri ordini nella
> riga, e agent34 è il processo che **non ha credenziali**: è una scelta di superficie, non un dettaglio.
>
> **⚠ E LA CADENZA NON È CAMBIATA: 75,0 s.** La finestra 23:02–23:17 sono 15 minuti, cioè ~12 campioni:
> abbastanza per vedere un assottigliamento **graduale**, non uno più breve di **150 s** (la conferma a
> due letture). La leva sarebbe `MID_HISTORY_INTERVAL_MS`, e costa disco — che il secondo book ha già
> quasi raddoppiato (~148 → ~285 MB/giorno).

---

## 8 · 🧪 I ROSSI DELLA SUITE, CLASSIFICATI UNO PER UNO

Il 18 agosto la suite aveva **12 rossi**. Nessuno era nuovo: cinque non erano nemmeno nell'elenco noto
di CLAUDE.md, che era **vecchio**. Classificati tutti e dodici, **chiusi undici**. Ne resta **uno**, ed
è rosso **per decisione**: `categoria-mercato` misura un classificatore che nessuno importa — costo
zero, e la ragione è scritta nella sua intestazione perché nessuno la debba ricostruire.

### Chiusi

| test | era | cosa si è scoperto |
|---|---|---|
| `sette-punti` · `tetti-per-giro-e-scope` · `tetto-derivato-dallo-scaglione` | decisione | l'invariante giusta è **`capitale impegnato ≤ N × $61,25`**, con **N letto dall'ambiente**. Le asserzioni erano **rovesciate**: chiedevano che il tetto di esposizione fosse più LARGO del massimo impegnabile, cioè che non mordesse mai |
| `miniciclo-prende-il-mercato` · `passate-mini-ciclo` · `tetti-dal-miniciclo` | test vecchio | **non era il piano**: quei tre lo iniettavano già. A leggere da disco era la **selezione**, che filtrava via tutte le righe perché i mercati finti non erano quelli scelti dal bot quel giorno |
| `cancellazione-riconosciuta` | test vecchio | pretendeva cancellazioni nella coda del registro **vivo**: a bot disarmato non ce ne sono |
| `tetto-orizzonte` | test vecchio | asseriva sul piano dell'8 agosto letto da disco, che ora contiene l'ultimo piano vero (vuoto) |
| `dipendenze-collegate` | **difetto vero** | `resolveOwnOrders` dichiarata e mai iniettata — vedi sotto |
| `end-of-scale-cycle` | test vecchio | lo scope del ciclo è «abilitati ∪ mercati con posizione», e la posizione **viva** di Hong Kong gli faceva visitare due mercati: lo stesso ordine rinnovato due volte |
| `scaduto-senza-rinnovo` | test vecchio | il primo ciclo **rinnovava** l'ordine (nasce a 20 s dalla scadenza, il margine è 180 s), quindi l'id cercato dopo non esisteva **per costruzione** |

### Aperti, e perché

| test | classe | perché resta |
|---|---|---|
| `attraversamento-scatta` · `scadenza-ereditata` · `tetto-e-scoperta` | **CHIUSI** | riscritti sulle regole nuove, non ammorbiditi. ⚠ In `scadenza-ereditata` il blocco sull'ignoto è stato **INVERTITO**: difendeva «l'ignoto entra», mentre dal 13 agosto il filtro è fail-closed. C'erano **due test che si contraddicevano** — `tetto-orizzonte` diceva il contrario ed era verde. E la stessa derivazione vecchia del tetto per ordine era scritta **anche nel selfcheck di `concentration.js`**, che non gira e quindi non l'aveva detto a nessuno: il reperto D1 dentro il modulo che esiste per impedirlo |
| `categoria-mercato` | **costo zero** | misura un classificatore che **nessuno importa**. Il suo unico «importatore» è un nome di file dentro una allowlist. Quello in servizio legge il campo `category` e su 129 mercati del board vivo restituisce `null` **zero volte** — e anche se lo facesse, escluderebbe **quel** mercato con un motivo dichiarato, senza bloccare nient'altro |
| `leg-order` | non parte | test JS su moduli TypeScript |

### La lezione che vale più dei sette test

**Cinque rossi su dodici avevano la stessa causa**: guidavano codice vero contro lo **stato vivo** —
piano, selezione, posizioni, registro. Non erano cinque problemi, era uno. E sarebbero tornati verdi
**da soli** il giorno in cui il bot avesse per caso scelto quei mercati: la peggiore forma di prova,
perché il verde non avrebbe significato niente.

Ogni seam che serviva **esisteva già** (`deps.selezione`, `deps.posizioni`, `leggiPiano`,
`pianoLeggero`): nessuno la iniettava. È la stessa classe del difetto vero trovato lo stesso giorno.

---

## 9 · 🔌 LE DIPENDENZE DICHIARATE E MAI INIETTATE — un inventario, non un caso

`resolveOwnOrders` era **letta** dalla corsia di piazzamento e **nessuno la passava**: il blocco che la
usa non entrava mai. **Non era un guasto** — il ripiego rilegge dal venue, che è corretto — ma costava
una chiamata di rete **per gamba** e, più serio, una **seconda fotografia** degli ordini: chi ripristina
una gamba legge la lista, la usa per giudicare la copertura *e* per scegliere la size, poi il
piazzamento ne rileggeva un'altra. Decidere la size su una fotografia e piazzare su un'altra è il modo
in cui due letture divergenti diventano un prezzo sbagliato. **Quinta occorrenza** di questa classe.

Ora è cablata dove serve. E soprattutto: lo scanner classificava già tutte le **187** dipendenze di
`lib/`, ma il test falliva solo su due categorie e lasciava fuori la più numerosa — **con ripiego e mai
iniettata da nessuno: 44**. Nessun test le nominava.

`dipendenze-mai-iniettate.test.js` pretende che **ogni** dep mai iniettata sia o iniettata, o
**dichiarata** con una ragione. Sei famiglie: percorso di file · primitiva di sistema · sacca di
sotto-dipendenze · funzione pura sostituibile · manopola del relayer · superficie on-chain. E
l'inventario non può invecchiare: il test cade anche se una voce descrive una dep che non esiste più,
o una che **invece** è iniettata.

⚠ La famiglia più delicata è **superficie on-chain**: `mergeOnChain` ha come difetto il relayer vero.
La sua gemella `signerProvider` è già stata la **seconda** occorrenza di questa classe, e il merge
on-chain non ha firmato per giorni.

---

## 10 · 🎯 L'ARMAMENTO A UN MERCATO — i tre punti sono chiusi

L'operatore ha chiesto di armare **un mercato solo**, una cintura alla volta, con una fermata dopo
ognuna. L'ordine dei passi è stato deciso da lui: **3 → 2 → 1**. Tutti e tre sono fatti.

### ✅ Fatto: il numero a 1

`MAKER_MERCATI_CONTEMPORANEI: '1'` in `agents/ecosystem.config.js`, letto da `/proc` su agent41.

**⚠ MA IL PERIMETRO NON È 1: È 2** (era 4), e non lo diventerà da solo: la selezione non caccia gli
occupanti quando il tetto scende — R1 governa quanti mercati si **aprono**, non quanti restano.

| mercato | esce fra | perché |
|---|---|---|
| `0x1f1c6390…` Thomas | **~5,4 giorni** | scadenza sotto il pavimento di 24 h |
| `0xd4e77ba6…` Fed rate cuts | **~133,4 giorni** | idem |
| ~~`0x12dc2b61…` Ballon d'Or~~ | **uscito** | spodestato dalla selezione |
| ~~`0xe9b3e28d…` Hong Kong~~ | **uscito il 18/08 alle 14:54** | ⚠ **non per scadenza**: la posizione è stata **riscattata on-chain**. Vedi il riquadro rosso in fondo a questa sezione |

⚠ E l'operatore ha deciso: **niente perno**. «Il bot deve scegliere.» Il perimetro si consuma da sé.

### ✅ Fatto: punto 3 — il giornale muto — commit `7eb5710`

Il presidio scriveva a verbale solo con un prezzo in mano. **Misurato: ZERO righe su 400 record**,
mentre girava ogni due minuti su una posizione reale. Adesso scrive **sempre**, con tre esiti distinti
(`rinunciata-prezzo-non-calcolabile` · `rinunciata-ricavo-nullo` · `rinunciata-sblocco-oltre-tetto`),
la causa in chiaro e il flag **`sulBoard`**. Rese iniettabili `fileAncore` e `scrivi`.
Prova: `presidio-scrive-sempre` **20/0**.

**⚠ EFFETTO COLLATERALE, DICHIARATO E NON RIPARATO A MANO.** La **prima** corsa di quel test — prima
che `scrivi` diventasse iniettabile — ha scritto nella produzione:

1. **quattro record finti** in `data/realloc-scheduler.jsonl`, con `marketId` `0xaa…`/`0xbb…`/`0xcc…`/
   `0xdd…`. Il registro è **append-only** (§4.10): non si cancellano. Accanto c'è una riga
   `rettifica-registro` che li dichiara per nome. Il test ora misura **prima e dopo**, non in assoluto.
2. **l'ancora di Hong Kong azzerata** in `data/presidio-posizioni.json`: era a 64,6 min, è tornata a 0
   (ri-ancorata alle `13:24:53Z`). Conseguenza: il presidio riprende a giudicarla dopo **60 minuti da
   lì**. Nessun capitale mosso — le cinture bloccano ogni invio e su quella posizione il prezzo non è
   comunque calcolabile. **Non l'ho rimessa indietro**: scrivere in uno stato di produzione un valore
   che nessuna osservazione giustifica è esattamente l'errore che l'ha causata.

**⚠ Terza occorrenza in un giorno** della classe «un test che guida una funzione che scrive deve
poterle dire dove» — dopo `kill-perdita-giornaliera` e la prima stesura di R10.

### ✅ Fatto: punto 2 — il sotto-minimo fuori dal board — commit `c17c740`

**Il difetto.** `sottoMinimo` decide se R6 può valutare lo sblocco (`if (c.sottoMinimo === true)`), e il
minimo veniva dal **solo board**. Un mercato uscito dal board non ha minimo ⇒ non è mai sotto il minimo
⇒ **quel ramo non si raggiungeva mai** — e uscire dal board è lo stato NORMALE di una posizione vecchia,
cioè esattamente il caso per cui il presidio esiste. Non era un'assenza dichiarata: era un'assenza
**travestita da risposta**. Il presidio non diceva «non so», diceva «non è sotto il minimo».

**La misura, su Hong Kong `0xe9b3e28d` (6 share):**

| fonte | risposta |
|---|---|
| board (120 righe) | **assente** |
| catalogo di ripiego (23 mercati) | **assente** |
| Gamma | **assente** — «mercato non trovato per questo conditionId», **12 fallimenti oggi** nei log di agent40 |
| **CLOB** | **`rewards.min_size` = 20** ⇒ 6 < 20, sotto il minimo da giorni |

**La cura** — `lib/maker/min-size-mercato.js`, decisione pura (zero `require`): **board → catalogo di
ripiego → CLOB**. Il minimo dev'essere finito e **positivo** o non è una risposta (`Number(null)` è `0`,
e un minimo di 0 significa «niente è sotto il minimo»: era proprio la bugia da impedire, e il ciclo
vecchio la conteneva alla lettera). La terza fonte si chiede solo quando le prime due tacciono, al più
5 per giro, 30 min di raffreddamento sui falliti, e **sopra** la decisione — il presidio è già
asincrono, quindi il valore letto adesso serve **già a questo giro**.

**⚠ Si salva il record INTERO, non il solo minimo.** `upsertMarket` rifiuta i record parziali
(`REQUIRED_FIELDS`: tokenIdYes, tokenIdNo, tick, negRisk), **anche quando il record esiste già** —
verificato. È il difetto **latente** del gemello in agent40: `recuperaScadenze` salva
`{marketId, endDate}`, quindi **non può salvare mai**, e da lì i 12 «scadenza NON recuperabile» al
giorno su una posizione reale. `recordDaLetturaVenue` sta accanto a `recordDaRigaBoard` — due mapper in
due file sarebbero il reperto D1.

**⚠ Il fail-closed non è stato tolto, si è spostato dove appartiene**: «nessuna delle tre fonti
risponde» ⇒ non si marca e non si compra. E le tre superfici verso l'esterno (`leggiVenue`,
`salvaCatalogo`, `leggiCatalogo`) sono **iniettabili**, perché un test che non può dire dove leggere e
scrivere legge e scrive la produzione — quarta occorrenza in un giorno.

**In produzione ha già girato:** `minimo premiante recuperato dal venue: 0xe9b3e28d9c… ⇒ 20 share ·
salvato nel catalogo di ripiego`.

Prove: `min-size-mercato` 28/0 · `presidio-riconosce-sotto-minimo` **30/0** (cade sul sorgente di ieri)
· `sblocco-residuo-scatta` 24/0 — **riscritto, non ammorbidito**: il suo §④ asseriva la proprietà
opposta («senza board il minimo è ignoto ⇒ nessun acquisto»), vera al 17 e falsa apposta dal 18. E le
sue ancore finivano in `data/presidio-posizioni.json` di **produzione**.

### ✅ Fatto: punto 1 — i due gradini — commit `c4ff438` e `83fe112`

| gradino | cintura | dove si vede |
|---|---|---|
| **1** | `MAKER_MODE` → `live-min`, su **entrambi** i processi che decidono un prezzo | modo adapter **`off:dryrun` → `live-min:dryrun`**; 2 ordini costruiti, fermati con `shadow` |
| **2** | `MAKER_ADAPTER_DRYRUN` → `false`, stesso riavvio dal file | modo adapter **`live-min`**; per la prima volta `dry-run-validated` **sul percorso dell'adapter** |

**⚠ IL FATTO CHE IL GRADINO 2 HA SCOPERTO, ed è il motivo per cui il gradino esiste.**
`canWrite = LIVE_MODES.includes(mode) && !dryRun` (`adapter.js:589`). Finché è `false` la scrittura esce
a **`adapter.js:776`** con `outcome:'shadow'` — cioè **prima** della chiamata dell'SDK che costruisce e
firma (`adapter.js:894`). Misurato sul giornale **prima** del gradino 2, ultimi 20 MB:

| | |
|---|---|
| `shadow`, percorso **adapter** | **983** |
| `dry-run-validated`, percorso **adapter** | **0** |
| `dry-run-validated`, percorso **`manual-place`** | **968** |

**Nessun ordine era mai stato FIRMATO in tutta la vita di questo bot.** I 968 che si vedevano sono la
contabilità della corsia manuale, scritta **dopo** che l'adapter aveva già rifiutato. Due righe che si
somigliano e dicono cose opposte: «costruito» e «costruito, firmato, fermato un istante prima».

**Gli ordini veri — 14:57:58Z, mercato `0x1f1c6390…`**, coppia simmetrica, 56,1 share per lato:

| lato | prezzo | nozionale | dal mid | in coda |
|---|---|---|---|---|
| **YES BUY** | 0,905 | $50,77 | 3,45¢ | un tick dietro il miglior bid altrui (93,7¢) |
| **NO BUY** | 0,026 | $1,46 | 3,45¢ | un tick dietro il miglior bid altrui (5,8¢) |

Coppia **93,1¢** (sotto 101¢) · totale **$52,23** (sotto il tetto di $61,25) · GTD 1380 s ·
`postOnly:true` · **`signatureBytes: 317`** · `validateOrder: ACCEPTED (eth_call — nothing submitted)` ·
`dryRun:true`, `sent:false`. **Zero ordini al venue.** Il bersaglio è fermato a 3,45¢ dal mid invece dei
4,28¢ chiesti dalla manopola 0,95: bordo premiante meno i 10 tick di margine (§4.1).

**⚠ RESTA UNA CINTURA SOLA**, ed è `MANUAL_ORDER_PLACEMENT` — **non toccata**, per istruzione. Su
agent40 è `dry-run` **dichiarata**; su agent41 è **assente**, cioè regge per il difetto fail-closed e
non per una riga che qualcuno ha scritto apposta. **È la cintura più sottile della sequenza.**
**⚠ E da qui letture e cancellazioni sono VERE**: con `canWrite` a `true` non escono più da `shadowOk`
nemmeno `listOpenOrders`, `getPositions` e le cancellazioni. Zero ordini a libro, quindi niente da
cancellare — ma la capacità c'è.

---

> ## 🔴 IL RISCATTO È RIUSCITO TRE VOLTE E IL CODICE HA DETTO CHE ERA FALLITO — 18 agosto, 14:54
>
> **È una conseguenza diretta del punto 2 — prevista e dichiarata nel commit — ma con dentro due difetti
> che nessuno conosceva.** Riempito il catalogo dal CLOB, `negRisk` è diventato leggibile e il riscatto
> automatico di agent40, che falliva da tutto il giorno con «negRisk non leggibile», è partito.
>
> **I fatti, dal giornale:** **tre** transazioni `redeemPositions`, nonce 46/47/48, alle 14:54:29 ·
> 14:54:41 · 14:54:52, **tutte e tre `STATE_CONFIRMED`** con hash (`0x2133b0c9…`, `0xcb4e364b…`,
> `0x982d5c7c…`). Il codice ha registrato **`riscatto-fallito`, motivo «il relayer non ha confermato»,
> `tentativi: 3`**.
>
> **① IL SUCCESSO NON VIENE RICONOSCIUTO.** Il chiamante non legge `esito: STATE_CONFIRMED`, quindi ha
> ritentato tre volte: la **prima** transazione aveva già svuotato la posizione, la seconda e la terza
> hanno riscattato **zero** e sono costate solo gas. E `data/riscatti.json` porta ancora `fallito` su un
> riscatto **riuscito** — l'idempotenza del registro (§5 p.131) sta difendendo il fatto sbagliato.
>
> **② E LA SPARIZIONE HA FATTO SCATTARE UN ALLARME DI SICUREZZA FALSO.** `auto-close-on-fill` ha scritto
> `sparizione-non-nostra`: «*6.00 share uscite senza nessun nostro ordine che le spieghi … Qualcuno con
> la chiave di questo wallet ha venduto da fuori dal nostro sistema.*» Non è vero: le ha tolte il
> **nostro** riscatto. Quel rilevatore guarda i nostri SELL e il merge, e **non conosce il riscatto
> on-chain**. Un allarme che grida al furto quando il bot fa il suo mestiere è un allarme che si impara
> a ignorare.
>
> **QUANTO È COSTATO: $0 di capitale.** Le 6 share erano il lato **PERDENTE** (il CLOB dà `No` vincente
> su quel mercato, il nostro token a `winner:false`, `price:0`), quindi il riscatto valeva zero per
> costruzione. Saldo **$1.495,26 prima → $1.495,26 dopo**. Il costo è **gas per tre transazioni invece
> di una**.
> **⚠ E LA CIFRA DI `CLAUDE.md` ERA SBAGLIATA**: «$3,00 bloccati». Erano **$0,00** — il carico a 0,50
> non è il valore di un token risolto a zero. Anche §5-bis p.187 va corretto di conseguenza.
>
> **NON È STATO CORRETTO**: sono due difetti sul percorso on-chain, fuori dallo scopo dato, e la
> correzione va decisa. **Non sta spendendo altro gas**: zero transazioni dalle 14:54:52, perché senza
> posizione non c'è più niente da riscattare.

---

## 13 · 🔒 LA SERA DEL 18 AGOSTO — IL PERIMETRO, IL DEADLOCK, E QUATTRO SILENZI

Il bot è stato armato alle 16:21Z (l'ultima cintura aperta su entrambi i processi). Quello che è
successo dopo ha trovato più difetti di una giornata di lettura del codice.

### ⓵ Il buco di §4.8: un mercato con ordini a libro usciva dal perimetro — `0f3ba6e`, `a0f5e0f`

**Il fatto.** 16:32:08 due ordini veri su `0x1f1c6390` ($56,36). ~16:42 il mercato **esce dal board**
(`riga-assente`), la selezione lo rilascia, `setAutoReprice` lo spegne, agent40 smette di visitarlo.
16:55:08 la GTD scade e **nessuno rinnova**. Bot armato e fuori dal libro per **52 minuti**. Costo di
capitale **$0**, solo perché a 35 tick dal mid non si era riempito niente.

**Due difese esistevano ed erano entrambe inerti.**
- §4.8 dichiarava il buco: l'unione è `abilitati ∪ POSIZIONI`, e la metà «ordine a riposo» non era
  coperta. La mitigazione scritta — «muore per GTD in 23 minuti o si riempie» — era accettabile in
  dry-run e non con l'ultima cintura aperta.
- `auto-reprice.scopeRinnovo` aveva **già** la terza componente `deps.mercatiConOrdiniVivi`, ed era
  pure iniettata da agent40. Ma è una **corsa**: si sovrascrive intera a ogni giro e si popola solo
  nei giri che superano quattro cancelli — e `cadenza-adattiva` fa `continue` **prima** che gli ordini
  vengano contati. Un giro saltato per cadenza cancella il mercato; senza memoria non torna nello
  scope, quindi non viene più guardato, quindi non torna mai in memoria.

**La cura**: `lib/safety/venue-orders-snapshot.js`, gemello di quello delle posizioni con **una
differenza di sostanza — fonde per mercato, non sovrascrive**. Le posizioni arrivano da una chiamata
che elenca tutto, quindi «assente» è una prova; gli ordini si leggono un mercato per volta e solo per
i mercati in scope, quindi «assente da questo giro» quasi sempre vuol dire «non ho guardato». Lo
scrittore riceve `guardati` **e** `conOrdini`.

**⚠ E la valvola per-voce era un difetto mio, trovato dal replay e non dal test.** Stava a 30 minuti
«perché sopra la GTD di 23», e faceva uscire dal perimetro un mercato con ordini vivi che nessuno
aveva guardato per un'ora — cioè riproduceva il guasto con un'ora di ritardo. La via d'uscita normale
di una voce è l'**osservazione**, non il tempo. Ora è a **6 ore**, backstop e non meccanismo, e
l'asserzione chiede un **ordine di grandezza** sopra la GTD: quella vecchia (`> GTD`) era vera anche
col valore sbagliato, cioè non difendeva niente.

### ⓶ LA PROVA SUL VIVO — 19:55:25Z, e il bot ha fatto più del previsto

Lo stesso identico scenario, col codice nuovo. Il mercato Walmart `0x59ddbb62…` esce dal board **e dal
piano** mentre ha due ordini a libro:

```
19:55:25  ✅ è USCITO DAL BOARD e dal piano, ha ordini a libro, e IL PERIMETRO LO TIENE (daOrdini)
```

E non è stata solo appartenenza a un insieme: **agent40 ha continuato a gestirlo**, 47 record in
cinque minuti — tentativi di rinnovo col conto alla rovescia (`RINNOVO DOVUTO E FERMATO … 45s … 21s`),
rifiutati da una regola di rischio vera (`profondita-insufficiente`) e ogni volta **dichiarati**; poi,
uscito il mercato dal board, `skip-mid-not-live` («il mid viene da manual-catalog, non dal book vivo di
agent34: non si muove un ordine vero su un mid che non è vivo»); infine alle **19:57:56**
`cecita-timeout-nessun-libro` ⇒ **`manual-cancel ok`**.

**Il bot ha cancellato i propri ordini di proposito quando il libro è andato al buio.** La sera prima
li aveva lasciati morire in silenzio. È la differenza fra un perimetro e una lista.

### ⓷ Il deadlock che teneva il piano fermo da 196 minuti — `9fc3d19`, `3924b34`

L'allocatore finanzia la coda lunga (oltre `LONG_TAIL_DAYS` = 7) con una seconda passata derivata dal
budget della **fascia corta**: §4.4, «fascia corta vuota ⇒ la coda non ottiene niente». La selezione
non conosceva quella regola. Con un solo slot l'unico posto è finito su un mercato a **134,2 giorni**
⇒ fascia corta del piano **vuota** ⇒ **zero righe, per sempre**. Sul board c'erano **79** mercati in
fascia corta che il piano non poteva vedere.

Stessa forma del deadlock del 13 agosto (§5-bis p.120): due regole giuste in due moduli che non si
parlano.

**⚠ E la prima stesura della cura non bastava**: filtravo solo i candidati, e sul bot vivo il giornale
diceva «2 scartati per coda lunga» col piano ancora a zero righe — perché **lo slot era già
occupato**. Ora si libera anche l'occupante, con gli **stessi** guardiani dello spodestamento: chi ha
ordini a riposo è intoccabile, lista non leggibile ⇒ non si libera nessuno.
**⚠ E la mia asserzione di «monotonia» era falsa**, l'ha presa il test: il vincolo restringe i
**candidati**, non la **selezione** — con uno slot solo, escludere il lungo fa entrare un corto che
prima non entrava.

### ⓸ I QUATTRO SILENZI, che sono la vera lezione della serata

| # | chi taceva | cosa diceva invece |
|---|---|---|
| 1 | il presidio d'uscita (`7eb5710`) | rinunciava senza scrivere niente |
| 2 | il mercato uscito dal perimetro | nessuna riga: si smetteva di guardarlo e basta |
| 3 | `eseguiGradino('ricostruisci-piano')` | `return fatto(true, …)` **incondizionato**, risultato buttato via. La scala è salita al gradino 6 **sette volte** oggi mentre il gradino il cui mestiere era rifare il piano dichiarava ogni volta di averlo fatto |
| 4 | `agent40` e `res.scope.perche` | la ragione per cui un mercato è nello scope era **calcolata e mai letta**: zero occorrenze in tutto il giornale |

Il numero 3 non poteva nemmeno controllare: `controlloCapitaleFermo` **non restituiva niente**. Il
gemello due righe sotto (`ripara-precondizioni`) fa `fatto(n > 0, …)` da sempre.

**La forma comune: una funzione che dichiara l'INTENZIONE invece del FATTO.** Non è un difetto di
logica — è un difetto di onestà del codice verso chi lo legge dopo.

### Le prove

`venue-orders-snapshot` **33/0** (col blocco E che rigioca la serata e porta la **controprova**:
senza snapshot il mercato esce) · `selezione-coda-lunga` **32/0** · `selezione-mercati` **104/0** ·
`dipendenze-mai-iniettate` **23/0** (ha preso subito `entryMaxAgeMs` non dichiarata) ·
**suite intera 218 test, 214 verdi**, in un worktree isolato con `DATA_DIR` e `BOT_RUNTIME_DIR`
verificati **empiricamente** — e le impronte dei 9 file di stato di produzione **immutate**.
I tre rossi: `categoria-mercato` (voluto) · `policy-permessi` e `snapshot-posizioni`, **entrambi
artefatti del worktree** (percorsi assoluti della policy; snapshot congelato) — **nel repo vero 84/0 e
41/0**.

---

## 14 · 🌙 LA NOTTE DEL 18 AGOSTO — LA CATENA DELLA FRESCHEZZA, E IL SILENZIO CHE NON È CECITÀ

Diciassette commit dopo l'armamento. Il filo che li tiene insieme è uno solo: **il bot confondeva un
mercato tranquillo con un feed rotto**, e ogni presidio costruito su quella confusione faceva danno.

### La catena della freschezza, in tre punti che non si parlavano

| chi | soglia | cosa faceva |
|---|---|---|
| **repricer** (`auto-reprice`) | 120 s | rifiutava di muovere un ordine su un mid vecchio |
| **piazzatore** (`manual-order`) | — | **nessun controllo**: il gate era opt-in e nessuno lo chiedeva |
| **uscita** (`auto-close`) | — | **nessun controllo**: vendeva sul bid camminato di un libro qualunque |

Il piazzatore apriva coppie su un book fermo e tre minuti dopo il repricer le cancellava. Adesso tutti
e tre prendono la soglia da **`regimeFeed`**, la stessa funzione, importata: il piazzatore non può
essere più permissivo di chi mantiene, **per costruzione**. Le soglie restano diverse (60 s per
selezione e piazzatore, 120 s per il repricer) e va bene: la direzione è prudente.

### E poi la scoperta che ribalta tutto: `live:false` non vuol dire «caduto»

`live-book.freshness` dichiara `live:false` dopo **30 s senza eventi su quell'asset**. Su un mercato a
134 giorni con volume minimo è lo stato normale, e il quadro memorizzato **resta perfetto** — misurato
il 5 agosto: al picco di 35 s il book coincideva esattamente con la lettura REST. Misurato stanotte:
**19% degli asset è silenzioso in un istante qualunque**, e il mercato che sembrava caduto è tornato
`live` da solo al primo evento.

Quindi:
- **gate di selezione** — la domanda è «il book è utilizzabile?» (`needsResnapshot === false`), non «ha
  avuto eventi». Esclusi **1 book su 125** invece di 14.
- **`mid-stantio`** — il presidio resta ma scatta per «siamo ciechi», non per «il mercato tace».
  `mid-not-live` e `mid-age-unknown` restano cecità sempre (è assenza, non silenzio); `mid-stale` lo è
  solo se il **feed nel suo insieme** non è vivo o il book chiede resnapshot. Fail-closed se la
  vitalità non è nota, e a verbale si scrive **quale condizione ha deciso**.

### Il deadlock, e una quota che era diventata un divieto

Il piano è rimasto fermo **196 minuti**. L'allocatore finanzia la coda lunga con una passata derivata
dal budget della fascia corta — e con un solo slot su un mercato a 134 giorni la fascia corta era
**vuota**, quindi la coda otteneva zero. **Una quota è una proporzione: senza fascia corta diventava un
divieto**, e rispondere «niente» non protegge da nulla. ⚠ Allarga un limite di rischio: il 100% del
piano può ora stare oltre i 7 giorni. Restano tetto per mercato, slot, esposizione e kill.

### Cinque mercati, e i tre blocchi che non erano uno

`MAKER_MERCATI_CONTEMPORANEI` **non** era l'unico punto: chiedere 5 veniva **rifiutato in silenzio**
(«non è un intero fra 1 e 3»). Soffitto **3 → 5**, `quotaScaglioni` lo eredita (stessa costante),
esposizione cumulativa **$150 → $650** — e $650 e non $320 perché il gate conta
`openNotionalUsd + notional` **anche sulle aperture**, quindi a $320 si smetterebbe a metà strada.

### I limiti di rischio ora sono versionati

`data/safety-risk-limits.json` era **gitignored**: i cinque numeri che governano l'esposizione vivevano
solo sul disco di una macchina. Scelta **una fonte sola versionata**, non default+override — due file
sono il modo in cui il valore locale diverge in silenzio. `limiti-versionati.test.js` fallisce se il
file manca, se torna ignorato, se manca un limite, se supera il tetto duro, e **se il disco non
coincide con il versionato**.

### ⚠ I DIFETTI CHE HO INTRODOTTO IO, STANOTTE

| # | difetto | chi l'ha preso |
|---|---|---|
| 1 | valvola per-voce a 30 min: faceva uscire dal perimetro un mercato con ordini vivi | il **replay**, non il test |
| 2 | snapshot alimentato da `owned`, che **esclude i pre-esistenti**: ogni riavvio azzerava il perimetro | la lettura del venue (`count 2` contro `{}`) |
| 3 | `Number(rules.midAgeSec)` in `auto-close`: **settima** occorrenza di `Number(null) === 0` | il test nuovo |
| 4 | `cfg` invece di `config` in `auto-reprice` — **terza volta oggi** sullo stesso file | `mid-stantio.test.js` |
| 5 | gate di selezione su `live !== true`: escludeva i mercati tranquilli | la misura sul feed |
| 6 | regola dello slot sterile: ha rilasciato **5 volte** un mercato che andava bene | il registro `maker-auto-reprice-audit` |
| 7 | «4 mercati, 8 ordini, $209,08» **ricostruito dal giornale** invece che letto dal venue: erano 2 | **l'operatore, guardando la UI** |

Il numero 7 è il peggiore, perché non è un difetto di codice ma di metodo: avevo lo strumento giusto
(`venue-orders.json`, scritto da letture vere) e ho preferito una ricostruzione. **Una ricostruzione
non è una lettura**, ed è la stessa frase che avevo scritto due volte nei commenti quella sera.

### ⚠ E IL DIFETTO CHE RESTA APERTO: ogni riavvio di agent40 uccide il libro

All'avvio, gli ordini già a riposo diventano **PRE-ESISTENTI**: «invisibili al motore — non riprezzati,
non rinnovati, non cancellati». Con `send` aperto significa che **un deploy condanna il libro alla
morte per GTD**. Misurato: riavvio alle 22:44:45, sei ordini scaduti alle 22:50 senza rinnovo, finestra
vuota di ~8 minuti su tre mercati. Il rinnovo proattivo parte 180 s prima della scadenza, e il riavvio
è caduto tre minuti prima di quella finestra.
**La decisione su come chiuderlo è dell'operatore** — le due vie sono in fondo a questa sezione.

---

## 11 · 🔬 IL GIRO DI PROVA A UN MERCATO — 24 ore, dalle 15:12Z del 18 agosto

Istruzione dell'operatore: **un mercato solo per 24 ore, poi domani se ne aggiunge**. La allowlist è
stata **svuotata** e lo stato della selezione **azzerato** (lasciandola accesa) con la sua funzione vera
`selezione-stato.scriviStato`; il posto l'ha riempito **la selezione**, non io.

⚠ **Perché non bastava svuotare la allowlist.** Gli slot occupati si contano da `stato.selezionati`, non
dalla lista: con 2 selezionati e `max 1` la selezione **non caccia nessuno** (R1 governa quanti mercati
si APRONO, non quanti restano) e non avrebbe riempito niente. Verificato con `selezione.js prova` prima
di toccare: «RESTANO» entrambi, «slot occupati dopo 2/1». Svuotare la sola lista avrebbe dato
perimetro **0**, cioè il bot fermo per rifiuto `live-min-market-unset`.

### Il mercato che ha scelto

| | |
|---|---|
| `conditionId` | `0x1f1c63908f6c1e3b49559fa80ddef36baa9c5482d52e6a7852c90303807ee22e` |
| domanda | *Will N'Kiyla "Jasmine" Thomas be the Democratic nominee for Senate in Oklahoma?* · `Elections` |
| scadenza | **2026-08-25T00:00:00Z** — fra **6,4 giorni**, fonte `clob` |
| banda premiante | **4,50¢** · tick **0,1¢** · `min_incentive_size` **20 share** · montepremi **$100/g** |
| book | mid **0,942** · bid 0,937 · ask 0,947 |

⚠ **Non è il mercato che prevedeva la simulazione a stato vuoto** (dava `0x59ddbb62…` Walmart): la
`prova` della CLI **non inietta il netto**, agent41 sì. Chi rilegge non deduca la scelta dalla `prova`.

### Le due gambe, misurate — 15:12:36Z e 15:12:37Z

| lato | prezzo | size | nozionale | dal mid | in coda |
|---|---|---|---|---|---|
| **YES BUY** | 0,908 | 56,1 | **$50,94** | 3,5¢ | un tick dietro il miglior bid altrui (93,9¢) |
| **NO BUY** | 0,022 | 56,1 | **$1,23** | 3,5¢ | un tick dietro il miglior bid altrui (5,3¢) |

Coppia **93,0¢** (tetto 101¢) · **capitale impegnato $52,17** (tetto per mercato $61,25) · GTD 1380 s ·
`postOnly` · firma **317 byte** · `validateOrder: ACCEPTED (eth_call — nothing submitted)` · **`sent:false`**.
Il margine dal bordo morde: 10 tick per lato, bordi `[0,908 · 0,978]` invece di `[0,898 · 0,988]`.

### 🔴 IL PREMIO STIMATO, E IL NUMERO CHE NON SI VEDE DAL PIANO

Il piano dice **lordo $1,53/g · netto $0,86/g** (quota modellata 1,5% su $100/g, concorrenza in banda
**3.612 share**). **Ma il piano modella l'ordine a 0,1¢ dal mid, e l'ordine sta a 3,5¢.** Sulla
quadratica del venue (`placementScore`, la funzione del repo):

| | punteggio S | Qu | quota | lordo/g |
|---|---|---|---|---|
| dove il **piano** lo modella (0,1¢) | 0,9560 | 53,65 | 1,4635% | **$1,46** |
| dove l'ordine **sta davvero** (3,5¢) | **0,0494** | 2,77 | **0,0767%** | **$0,08** |

**Diciannove volte più basso.** A capitale $52 su questo mercato, al bordo esterno della banda, il
premio lordo modellato è **otto centesimi al giorno** — netto praticamente zero. Non è un difetto: è
il prezzo del bordo esterno (§4.1, manopola 0,95), scelto per non essere riempiti. **Ma è il numero da
avere in mano prima di dire `send`**, e il piano da solo non lo mostra.

### Il residuo peggiore, se resta scoperto

| caso | quantità | valore |
|---|---|---|
| residuo **sotto** il minimo del venue, gamba YES | 19,99 share | **$18,15** |
| residuo sotto il minimo, gamba NO | 19,99 share | $0,44 |
| **gamba intera scoperta** (fill totale di un lato) | 56,1 share | **$50,95** YES · $1,23 NO |

Il residuo sotto il minimo **non resta bloccato**: R6 lo vende attraversando (deroga `BELOW_MIN_SIZE`
sulle chiusure), e se il bid non è leggibile prova lo sblocco comprando l'altro lato entro
`min(valore, $5)`. Altrimenti aspetta la risoluzione — **6,4 giorni**. La gamba intera è sopra il
minimo, quindi vendibile a libro, e la scala d'urgenza la governa a 30/60/240 minuti.

### Il perimetro, letto da `/proc` — **1**

Entrambi i processi che decidono un prezzo vedono **un mercato solo**, ed è lo stesso:
agent40 (pid 374883) **1** · agent41 (pid 374889) **1**. Perno `MAKER_LIVE_MIN_MARKET` **vuoto**: il
perimetro è l'unione di §4.8, e regge a 1 perché le posizioni al venue sono **zero**.
⚠ **Non è stabile per costruzione**: al primo fill il mercato entra in gestione, esce dal conteggio
degli attivi e la selezione ne apre un altro (rotazione, §4.13). Con `send` ancora chiuso non può
succedere.

---

## 12 · 👁 COSA GUARDARE NELLE PROSSIME ORE

> ## 🔴 IL BOT È ARMATO — 18 agosto 2026, 16:21Z, capitale vero
> **`MANUAL_ORDER_PLACEMENT=send` su entrambi i processi. Zero cintura d'armamento inserita.** I primi
> due ordini veri della vita di questo bot sono a libro dalle **16:32:08Z**. Quello che resta davanti
> non sono cinture ma stato del sistema: KILL, tetto per ordine, tetto per mercato, esposizione
> cumulativa $150, rate limit, perdita giornaliera −$100, «mai primo sul libro», banda premiante.
>
> **⚠ MA IL PREMIO SARÀ QUASI ZERO LO STESSO, E NON È UN GUASTO.** A 35 tick dal mid il punteggio del
> venue è 0,0494 invece di 0,956: **lordo modellato ~$0,08/giorno**, netto ~$0,06. Chi cerca un premio
> visibile non troverà un difetto, troverà il prezzo del bordo esterno.
>
> **⚠ E I FILL SARANNO QUASI CERTAMENTE ZERO, il che vuol dire che R5/R6/R7 NON verranno provate.**
> Misurato sul tape delle 24 h precedenti, separando i due libri: sul **YES** un solo trade sotto il
> mid, a **9 tick**; sul **NO** 22 trade, mediana **11 tick**, massimo **28**. A 35 tick **nessuna
> delle due gambe sarebbe stata toccata nemmeno una volta**. La distanza a cui un fill diventa
> probabile è **~10 tick (1,0¢)**, cioè `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V ≈ 0,22` invece di 0,95.
> ⚠ E i due libri non sono simmetrici: 22 dei 23 trade sotto il mid sono sul **NO**, cioè sulla gamba
> da $1,27 — non su quella da $55,09.

### I quattro comandi, in ordine di quanto rispondono

| comando | risponde a |
|---|---|
| `node scripts/cli/stato.js` | **il primo da lanciare.** Cinture da `/proc`, interruttori, mercati attivi, ordini a riposo, posizioni, limiti, flotta |
| `node scripts/cli/mercati.js` | il **perimetro vero**, letto da `/proc` per ogni processo che decide un prezzo. È qui che si vede se è ancora **1** |
| `node scripts/cli/selezione.js` | chi occupa lo slot; `selezione.js prova` dice cosa sceglierebbe **adesso** senza scrivere niente |
| `node scripts/cli/distanza.js` | che i due processi siano d'accordo sulla distanza dal mid — se divergono i prezzi non sono confrontabili |

### I file, e cosa dicono

| file | cosa |
|---|---|
| `data/polymarket-maker-audit.jsonl` | **il giornale che conta.** Ogni ordine costruito, il suo gate, la firma, la distanza dal mid. Ruota sopra i 400 MB |
| `data/realloc-scheduler.jsonl` | il giornale di agent41: selezione, copertura, presidio, sblocco, recupero del minimo |
| `data/osservatore/giornale-<data>.md` | il racconto in italiano di agent45, un campione ogni 60 s — **il posto da cui partire se qualcosa è andato storto e non si sa cosa** |
| `data/osservatore/campioni-<data>.jsonl` | gli stessi campioni in forma misurabile |
| `~/.pm2/logs/agent4{0,1}-*-out.log` | il flusso, in chiaro |
| `data/guardian-state.json` | **l'assenza È lo stato sano.** Se compare, il guardiano è scattato e il bot è su FERMA |
| `data/sospensioni-erosione.json` | assente = nessuna gamba tolta per erosione (R4) |
| `data/chiusura-emergenza-richiesta.json` | assente = il kill a −$100 non è mai scattato (R10) |

### ✅ Normale — è così che si vede che funziona

- **ogni ~10 minuti** un mini-ciclo: `mini-ciclo FORZATO: $5x rimessi al lavoro su 1 mercato/i
  (2 ordini piazzati, 0 rifiutati)`. **Due** ordini, non uno: la coppia è simmetrica per costruzione;
- nel giornale, per ciclo: `outcome: **sent**` con un **`orderId` vero** (`0x…`), `placement: send`,
  **`gate: nessuno`**. `dry-run-validated` da qui in poi **non deve più comparire**: se ricompare, una
  cintura si è richiusa;
- **modo adapter `live-min`** — senza `:dryrun`;
- **perimetro 1** su entrambi i pid, e **lo stesso** conditionId;
- **2 ordini a riposo · 0 posizioni al venue** — due, non uno: la coppia è simmetrica per costruzione;
- gli ordini **cambiano `orderId` ogni ~23 minuti**: è la GTD nativa che scade e il rinnovo che
  ripiazza, non un errore. Il nozionale resta ~$56 e la coppia ~93¢;
- `capitale al lavoro ~3,8%` con `obiettivo 95%` e la riga «sotto-obiettivo»: **è corretto** — un solo
  mercato su $1.495 di capitale, il resto è cassa per scelta;
- `copertura … da-coprire (0/2 gambe) … si ripiazza` e `ripristino …: nessuna riga nel piano salvato`:
  rumore atteso a libro vuoto, non un errore;
- `⚠ LA SCALA STA AFFAMANDO IL PIANO`: è un avviso di misura, non un guasto — con un mercato solo su
  $1.495 di capitale è aritmeticamente inevitabile.

### 🔴 Non normale — qui si guarda subito

| segnale | dove | cosa vuol dire |
|---|---|---|
| **perimetro ≠ 1**, o diverso fra i due pid | `mercati.js` | la selezione ha ruotato, o un riavvio è stato scoordinato (§5.1) |
| **il mercato è cambiato** | `selezione.js` | spodestamento: legittimo solo con +$0,50/g o +25% di netto (R9). Se succede senza, è da capire |
| **ordini a riposo ≠ 2** | `stato.js` | **0** = nessuno sta piazzando (guardare `gate:` nel giornale); **1** = una gamba è morta e l'altra no, cioè esposizione direzionale — R5/copertura devono rimetterla entro ~2 min; **>2** = si sta accumulando, e il tetto per mercato dovrebbe averlo impedito |
| **posizioni > 0** | `stato.js` | **un fill è avvenuto.** Non è un guasto — è l'evento che stiamo aspettando — ma da lì partono R5/R6/R7: seguire `modalita-chiusura`, `completaCoppia`, `urgenza-scoperto` nel giornale, e controllare che il residuo non resti sotto le 20 share |
| **nozionale a libro > $61,25** su un mercato | `stato.js` / giornale | il tetto per mercato non ha morso: è un difetto, non una scelta |
| `outcome: dry-run-validated` ricompare | giornale | una cintura si è richiusa (riavvio non dal file, o `.env` che ha vinto): verificare `/proc` |
| `gate:` diverso da `nessuno` | giornale | l'ordine viene rifiutato prima dell'invio. `maker-mode`/`dry-run` = una cintura si è richiusa; `limit-*` = un tetto morde; `live-min-market-unset` = perimetro vuoto |
| **zero cicli per > 20 min** | log agent41 | l'autodiagnosi sale la **scala di sblocco** (un gradino ogni 5 min). Il gradino 6 è disarmato, quindi non arriverà a FERMA — ma i gradini 1-5 si vedono nel giornale |
| `data/guardian-state.json` **compare** | disco | guardiano scattato: ordini cancellati e bot su FERMA. Nessun riarmo automatico |
| `sparizione-non-nostra` | giornale | ⚠ **attenzione al falso positivo noto**: non conosce il riscatto on-chain (§10, riquadro rosso). Prima di allarmarsi, cercare `redeemPositions` nello stesso minuto |
| `riscatto fallito` con `STATE_CONFIRMED` accanto | giornale | è il difetto di §10: il riscatto è **riuscito**. Non ritentare a mano |
| `minimo premiante NON recuperabile` | log agent41 | il CLOB non risponde per un mercato con posizione: R6 non può riconoscere un sotto-minimo |

### Il numero da guardare più di tutti

**La distanza dal mid: 3,5¢ su una banda di 4,5¢.** È lì che si decide il premio, e a quella distanza
il punteggio del venue è **0,0494 invece di 0,956** — diciannove volte meno (§11). Se domani si
aggiunge un mercato, la domanda che conta non è «quanti mercati» ma **se il bordo esterno valga il suo
prezzo**: la manopola è `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` (§5.2 p.31) e cambiarla richiede il
riavvio **coordinato** dei due processi.

---

## Stato del sistema — 18 agosto 2026

**Bot con UNA CINTURA SOLA**, letto da `/proc/<pid>/environ` dei processi vivi (pid 374883 e 374889):

| | agent40 | agent41 |
|---|---|---|
| `MAKER_MODE` | `live-min` ⇒ **APERTA** | `live-min` ⇒ **APERTA** |
| `MAKER_ADAPTER_DRYRUN` | `false` ⇒ **APERTA** | `false` ⇒ **APERTA** |
| `MANUAL_ORDER_PLACEMENT` | `dry-run` ⇒ **inserita** | **assente** ⇒ inserita *(regge per il difetto)* |
| `REALLOC_SCHEDULER_DRY_RUN` | — | `0` ⇒ **aperta** |
| `MAKER_LIVE_MIN_MARKET` | **vuota** | **vuota** |
| `MAKER_MERCATI_CONTEMPORANEI` | — | **`1`** (R1, armamento a un mercato) |

⇒ **due cinture sono state aperte su istruzione dell'operatore (§10), e ne resta UNA.** Gli ordini si
costruiscono, passano tutti i gate, si **firmano** e si fermano all'ultimo `if` prima dell'invio.
KILL spento · bot su **AVVIA** (dalle 21:23:33Z del 17/08, `cli/avvia`) · selezione automatica
**accesa** · allowlist gestita da lei · **zero ordini a libro** · **zero posizioni al venue** (l'ultima
è stata riscattata alle 14:54, v. il riquadro rosso di §10) · **zero sospensioni per erosione**
(`data/sospensioni-erosione.json` assente, ed è lo stato sano) · `data/chiusura-emergenza-richiesta.json`
assente.

I file di servizio stanno in **`/tmp/rewards-bot-bot/`** (0700), non in `/tmp` nudo.

### Cosa è cambiato oggi, in ordine di commit

| commit | regola | cosa |
|---|---|---|
| `759c09f` | **R8** | la coppia completa si fonde **prima** delle guardie sul prezzo |
| `93fa78b` | **R7** | la concessione del gradino 2 è il **5% del carico**, non `min(1 tick, 5%)` — ⚠ **allarga un limite di rischio**: $3,06 contro $0,63 sulla gamba più grande |
| `1131841` | **R6** | il residuo sotto il minimo **si chiude**; il commento che lo teneva era un **D7** |
| `5d86bd1` `bb6d19c` | **R10** | il kill **chiude anche le posizioni**; agent43 deposita, agent41 esegue |
| `0ac9bd1` | **R1** | il numero di mercati vive nell'**ambiente**, e la composizione lo **deriva** |
| `b29f429` `c0fc111` | **R4** | le due misure, prima di decidere |
| `1b8b34c` | **R4** | `book-erosion` collegato ad `auto-reprice` |
| `176c5a5` | **E** | sei passi nuovi nel banco: **26/26** |
| `cd53c82` | **2+3** | l'invariante di esposizione è `≤ N × $61,25`; timeout della suite a 120 s |
| `b1fdec9` | **difetto** | **il presidio d'uscita gira anche a bot fermo** |
| `ab2bca0` | **R6** | comprare l'altro lato per sbloccare un residuo, coi due tetti in dollari |
| `8dccac9` | **1** | il freno di agent41 può stare nell'ecosystem, e il divieto resta scritto |
| `21aac7c` | **manuale** | `MANUALE.md`: il comportamento per intero, senza riferimenti al codice |
| `8ff2185` | **2-bis** | il terzo rosso voluto esisteva, in `lib/rewards/` |
| `a01144a` | **difetto** | `resolveOwnOrders` cablata, e l'inventario di tutte le dep mai iniettate |
| `7bdc0db` `6108b78` | **test** | i cinque che dipendevano dallo stato del bot: iniettato, non letto |
| `1c555f7` | **test** | il 4 e il 7 erano test vecchi, non difetti |

### I cinque difetti trovati oggi che nessun test vedeva

1. **il presidio dei 60 minuti non gira a bot FERMO** — sta dietro `if (!TRIGGER_ATTIVO || !botAttivo())`,
   e FERMA è esattamente lo stato che il kill produce: «l'ultima rete» non c'era nel momento per cui
   esiste. Trovato collegando R10, non da un guasto.
2. **la mappa dei minimi si cercava con chiave sensibile al maiuscolo** — su `{mB: 20}` ogni mercato
   rispondeva «minimo non leggibile» e finiva fra le *lasciate*. Fail-closed, quindi non pericoloso, ma
   sbagliato: l'ha presa il test del **cablaggio**, non il selfcheck.
3. **il test del kill giornaliero scriveva nel `data/` di produzione** — `spazzaEFerma` vera depositava
   una richiesta finta che agent41 avrebbe eseguito. Residuo rimosso, percorso reso iniettabile, e ora
   c'è l'asserzione su *dove non* ha scritto.
4. **il presidio d'uscita non girava a bot FERMO** — stava dietro `botAttivo()`, e FERMA è lo stato che
   il kill produce: la «ultima rete» non c'era nel momento per cui esiste. Nominato dall'operatore.
5. **`resolveOwnOrders` dichiarata e mai iniettata** — quinta occorrenza della classe. Non un guasto,
   ma una lettura del venue sprecata per gamba e una seconda fotografia degli ordini.

---

## Come ripartire

```bash
claude --permission-mode auto
```

Poi, come primo messaggio:

> Riprendi da APERTI.md §10: il punto 3 è chiuso (`7eb5710`). Fai il **punto 2** — il presidio deve
> riconoscere il sotto-minimo anche quando il mercato è uscito dal board, prendendo la size minima dal
> catalogo di ripiego o dal venue. Poi il **punto 1**: apri `MAKER_MODE`, fermati, poi
> `MAKER_ADAPTER_DRYRUN`, e mostrami gli ordini costruiti e firmati che si fermano prima dell'invio.
> `MANUAL_ORDER_PLACEMENT` non si tocca. Bot disarmato.



```bash
cd /home/bot/bot && claude --permission-mode auto
```

```bash
# 1 · LO STATO VERO, dai processi vivi
node scripts/cli/stato.js              # le quattro cinture da /proc/<pid>/environ
node scripts/cli/mercati.js            # perimetro live-min, stessa fonte

# 2 · LE PROVE, in ordine di quanto provano
cd /home/bot/bot-banco && node scripts/ricerca/banco-scenari.js            # 26/26, tutte e 10 le regole
cd /home/bot/bot-banco && node scripts/ricerca/prova-cinture.js            # 10/0, col controllo
cd /home/bot/bot-banco && node scripts/ricerca/prova-determinismo-banco.js # 10 corse, una firma
node scripts/ricerca/suite-rossi.js <nome-sessione>                        # si confrontano i NOMI
node lib/safety/percorsi-critici.test.js                                   # 15/0

# 3 · LE MISURE SUL CAPITALE
node scripts/ricerca/mercati-corti-24-72h.js       # i candidabili fra 24 e 72 h
node scripts/ricerca/tre-vie-capitale-fermo.js     # le tre vie (lento: 7 corse del pianificatore)
node scripts/ricerca/residui-sotto-il-minimo.js    # il residuo peggiore, e perché l'uscita è il riscatto
node scripts/ricerca/r4-fuori-dal-libro.js         # R4: minuti/giorno fuori dal libro e premio perso
node scripts/ricerca/r4-erosione-su-giornata-vera.js  # R4: quante volte scatterebbe
```

⚠ **Riavviare i due processi che decidono un prezzo si fa DAL FILE e INSIEME**, e si chiede in chat ogni
volta (§2 regola 2):

```bash
pm2 restart agents/ecosystem.config.js --only agent40-manual-reprice,agent41-realloc-scheduler
pm2 save     # o il @reboot riporterebbe su la flotta di prima
```

**Le due regole che valgono più di tutte, imparate oggi:**
1. *Un test che inietta una fixture deve COPIARE la forma vera, non inventarla.* Tre difese scritte ieri
   erano inerti e i loro test erano verdi.
2. *Un presidio simulato più permissivo dell'originale non è un presidio.* Il banco cablava le cinture e
   quindi non avrebbe mai potuto smascherarle — lo stesso difetto, un piano più su.

---

## 15 · 👁 LA FINESTRA DI 24 ORE — cosa si registra, cosa mancava, e la sola cosa che è stata aggiunta

**19 agosto 2026, 15:22Z — decisione dell'operatore.** Il bot è vivo con capitale vero su tre mercati.
Per 24 ore non si tocca niente: nessun deploy, nessun riavvio, nessuna modifica. Un difetto trovato si
scrive qui e **non si corregge**. L'unica cosa che ferma tutto è un `reject-venue` su `cancelOrder` o
`cancelMarketOrders` — quello vorrebbe dire che la severità nuova dell'adapter (19 agosto, `risposta-venue`)
sta rifiutando cancellazioni buone, ed è l'unico difetto che costa capitale mentre si guarda.

### Le tre domande a cui la finestra deve rispondere

① quanti mercati ha tenuto in media · ② quanto tempo il capitale è stato fermo senza ordini a libro ·
③ quanto premio ha incassato. Un comando solo: **`node scripts/osserva/rispondi-24h.js`**.

### Cos'era già registrato — sei grandezze su sette

| grandezza | dove, e in che forma |
|---|---|
| **mercati nel piano** | `data/realloc-scheduler.jsonl`, `tipo:'mini-ciclo'` → `mercati[]` con `allocatoUsd`, più `ricalcolo.righe` e `motivoStop`. ~100 record ogni 6 h |
| **ammissibili su valutati, e la causa di uno slot vuoto** | idem, `tipo:'selezione-mercati'` → `ammissibili`/`valutati`, `slotVuotiPerScarsita.motivo` («il board non offre abbastanza mercati ammissibili: 4 su 135 valutati»), `postiNonAssegnati`, `scartatiPerComposizione` |
| **ingressi e uscite, con la causa** | idem → `entrati`/`usciti`/`liberati`/`spodestati`/`entratiInGestione`, **ognuno con `motivo` e `dettaglio`** (`riga-assente` · `nessuna riga di board per questo mercato`) |
| **ogni fill** | `data/safety-fills.jsonl`, `kind:'fill'` → `side`, `filledPrice`, `filledSize`, `orderId`, `source`. ⚠ **`market` è il tokenId, non il conditionId**: il mercato si risolve dal board, non si legge dalla riga |
| **ogni scadenza GTD** | `data/polymarket-maker-audit.jsonl`, `auto-reprice/scaduto-senza-rinnovo` (con `book`, `side`, `price`, `size`, `expiresAt` e il **gate che ha fermato il rinnovo**) e `order-vanished/expired` |
| **premio maturato** | `data/stima-campioni.json`, un campione ogni 5 min da agent40; l'integrale è `lib/maker/stima-integrata.integra({giorno})` |

**Il tempo fino al ripiazzamento non è un campo: è una sottrazione**, fra la scadenza e il
`manual-place/sent` successivo sullo stesso mercato e libro. **Verificato derivabile su dati veri**:
sulle ultime 8 scadenze, 6 hanno un ripiazzamento (54-59 s, e uno a 2.313 s) e 2 non ce l'hanno affatto
— cioè i due «MAI» sono un fatto, non un dato mancante.

### La settima mancava, e la ragione era strutturale

**Quali mercati hanno ordini a libro, istante per istante, non era registrato da nessuna parte.**

- `data/venue-orders.json` è l'unica fonte **autorevole** — agent40 la scrive da letture vere del venue —
  ma **si sovrascrive**: è uno stato, non una serie. Domani non dice niente su ieri. E non porta
  conteggi né nozionale, perché chi la scrive riceve *insiemi di mercati*, non ordini.
- `agent45` dichiara `ordiniPerMercato: null` **con il motivo**, ed è un null **strutturale**: il
  giornale REDIGE `requested.marketId` sulle righe `manual-list`, quindi il conteggio per mercato non è
  ricostruibile da lì. Verificato sul file grezzo, non sull'output: il valore su disco è la stringa
  `0x[redacted-64hex]`, 18 caratteri.
- il suo `nozionaleABookUsd` è una **ricostruzione**, e la si è vista corta: alle 15:15 dichiarava
  `mercatiVisti: 2` mentre al venue i mercati con ordini erano **3**.

### ⚠ E LA CORREZIONE NON POTEVA VIVERE DENTRO UN AGENT

La finestra vieta i riavvii, e il codice di un processo pm2 sta nella sua memoria: una riga aggiunta a
`lib/osservatore/campionamento.js` o ad agent40 sarebbe stata **inerte per 24 ore**. Sarebbe stata la
forma più pura di «una regola scritta non è una regola in servizio». Quindi l'osservatore è **esterno**.

### L'unica modifica: `scripts/osserva/registro-24h.js`

Una riga al minuto in `data/osservazione-24h.jsonl`. **Non è nella flotta, non sta in pm2, non tocca
nessun processo vivo.**

- **⚠ STRUTTURALMENTE INCAPACE DI TOCCARE CAPITALE, e non per promessa**: `registro-24h.test.js`
  (**30/30**) cammina i `require` e pretende **zero require oltre `fs` e `path`** — nessuno relativo,
  quindi nessun adapter e nessuna credenziale raggiungibili. Più: nessun `unlink`/`rm`/`rename`/`truncate`
  (un osservatore non rimuove prove) e le sole due scritture ammesse sono `appendFileSync→USCITA` e
  `writeFileSync→PIDFILE`, verificate **per nome della destinazione**.
- **⚠ IL LIBRO SI SCRIVE DUE VOLTE, E LA `divergenza` È IL CAMPO CHE CONTA.** `libroAutorevole` è
  l'insieme letto dal venue; `libro` è la ricostruzione dal giornale, che ha conteggi, prezzi, size e
  nozionale. Non si sceglie fra le due e non si mediano: si misura **di quanto non vanno d'accordo**,
  così domani si sa quanto vale il numero che si sta usando. È la cintura contro il difetto del 18
  agosto sera, quando una ricostruzione dichiarò «4 mercati, 8 ordini, $209,08» contro i **2** veri.
- **⚠ LA SCADENZA GTD SI APPLICA ANCHE SENZA UN RECORD CHE LA DICHIARI.** Un ordine più vecchio della
  sua `ttlSeconds` è morto al venue, che il giornale l'abbia notato o no. Sommare gli `sent` e togliere
  le sole scadenze **registrate** è esattamente l'errore del 18 agosto, e il test lo prova costruendolo.
  ⚠ `ttl` ignoto ⇒ **non si pota a indovinare**: l'ordine resta e il conteggio lo dirà.
- **⚠ «NON HO LETTO» NON DIVENTA MAI «NON C'È»**: `venue-orders.json` oltre **180 s** è
  `leggibile:false` col motivo, mai «nessun ordine»; un ordine senza nozionale non vale zero, si conta
  in `ordiniSenzaNozionale` — o il totale mentirebbe in difetto **in silenzio**.
- **prima riga scritta, e le due fonti concordano**: 3 mercati per entrambe, 5 ordini, **$136,59**.
  ⚠ Riscontro indipendente: `capitaleInBandaUsd` che agent40 campiona per conto suo dice **$136,59**.

### Il guard, e il difetto che ha evitato

Se l'osservatore muore a metà finestra la misura non è rifacibile — la finestra è passata. Quindi cron
lo rilancia ogni minuto. **⚠ La prima stesura del guard usava `pgrep -f 'osserva/registro-24h'`, ed era
rotta nel modo che §5.3 descrive da giorni**: il comando che lo esegue contiene la stringa cercata,
quindi `pgrep` trova la propria shell, conclude «gira già» e **non riavvia mai, senza dirlo**. L'unicità
la impone ora lo script stesso, con un **pidfile** letto contro `/proc/<pid>` *e* contro `cmdline` (i pid
si riciclano): lanciato mentre uno gira, il secondo esce subito. Cron quindi lo lancia e basta.
**⚠ La riga di cron va tolta a finestra chiusa**: un guard che sopravvive alla ragione per cui esiste
diventa un secondo meccanismo che nessuno ricorda.

### Cosa NON è stato toccato, ed è deliberato

- **`lib/maker/quantita-davanti.js` resta non committato e senza chiamanti.** È la regola «non stiamo
  mai primi in coda», scritta ma non cablata: la scelta fra estendere `depthMultiple` e sostituirlo è
  ancora dell'operatore, e non si tocca un gate del capitale dentro una finestra di osservazione.
  Verificato che nessun file la importi, quindi è inerte.
- **Nessun numero di rischio è stato cambiato**: cap $650, tetto per mercato $61,25, tetto per ordine
  $65,63, perdita giornaliera −$100, rate limit 40/60 s. Tutti dove erano.

### ⚠ Il difetto che questa lettura ha trovato, e che NON viene corretto

**`data/venue-orders.json` è autorevole e non conserva niente.** È l'unica lettura vera del libro, e
ogni cinque secondi cancella la precedente. L'osservatore esterno di oggi lo campiona al minuto, ma è
un cerotto fuori dal processo: la correzione vera è che **lo scrittore appenda**, o che l'osservatore
riceva anche i conteggi che già ha in mano al momento della lettura. Non si fa adesso — richiede di
toccare agent40 e quindi un riavvio. **Da fare a finestra chiusa.**

**E il gemello:** `requested.marketId` redatto sulle righe `manual-list` rende il conteggio per mercato
non ricostruibile dal giornale. La redazione protegge un id che nella stessa riga di `manual-place`
compare **in chiaro** come `marketRef` — cioè non protegge niente e costa una misura. Anche questa a
finestra chiusa.

---

## 16 · ✅ VERIFICA DI CONFORMITÀ ALLE DIECI REGOLE — sull'intera finestra di osservazione

**Sola lettura, 20 agosto 2026.** Finestra `2026-08-19T15:21:42Z → 2026-08-20T04:09:37Z` (**12,80 h**),
**776 campioni** del registro esterno (gap mediano 60,1 s, massimo 70,7 s) + **72.154 righe** del
giornale maker + 385 record di selezione. Nessuna modifica, nessun riavvio, nessun ordine.

**Ciò che rende metà di questa verifica priva di soggetto: ZERO FILL.** 330 righe in
`safety-fills.jsonl`, tutte `nofill`; **zero posizioni** in tutti i 776 campioni; `residui-scoperti.json`
vuoto. Le regole 5, 6, 7 e il Livello 0 della 8 non hanno avuto un solo caso da giudicare — non sono
state rispettate né violate, **non sono state esercitate**.

### I due difetti veri, entrambi registrati e NON corretti

**① IL FRENO DEI 30 SECONDI NON ESISTE SUL TRIGGER 3.** `minIntervalMs` è controllato
in tre punti — `lib/maker/auto-reprice.js:349` (inseguimento del mid), `:567` (rinnovo proattivo),
`:765` (uscita dalla banda) — e **non nel blocco del TRIGGER 3** (`:626-680`, «siamo diventati i primi
sul libro»), che ritorna `reprice` senza consultarlo. Misurato: **18 spostamenti sotto i 30 s sulla
stessa gamba, minimo 4,8 s**. La sequenza che lo mostra, su `0xf816a089…`, gamba YES:

```
18:01:03.302  auto-reprice/trigger  inseguimento del mid: … → da 0.912 a 0.919
18:01:08.273  auto-reprice/trigger  il libro si è mosso e questo ordine è ora il migliore del suo lato:
                                     … spostandosi da 0.919 a 0.918
```
Cinque secondi. Nei minuti intorno il freno **funziona** e lo dichiara (`skip-rate-limited`, «questa
gamba e' stata mossa 28s fa — si attende il minimo di 30s»): non è rotto, è **assente su un ramo solo**.
⚠ Costo: due cancel+place invece di uno, cioè due finestre scoperte e due posti di rate limit. Non
allarga nessun limite di rischio — «mai primo sul libro», banda e tetti restano davanti.

**② IL TETTO PER MERCATO È STATO SFONDATO PER ~2 MINUTI, DA UN DOPPIO RIPREZZO SULLO STESSO `orderId`.**
Il 19 agosto alle **17:46:10** su `0xa34edb6c…` lo stesso ordine a riposo (`0xc257068f…`) è stato
sostituito **due volte nello stesso giro** — una volta per `manual-cancel`+`manual-place` @0.807, una
per `manual-replace` @0.808 — lasciando **due gambe NO** a libro: **$97,33 contro il tetto di $61,25**
(3 ordini sul mercato, `{"yes":1,"no":2}`). Visto da entrambe le fonti del registro. Si è risolto da
solo alle **17:48:10** (`manual-cancel/ok` su `0x635412…`), ma nel frattempo il motore ha **fermato 12
rinnovi dovuti** dichiarando `tetto-mercato: il mercato arriverebbe a $97.33`.
⚠ **È la stessa classe del difetto del 16 agosto documentato a `auto-reprice.js:1229-1240`** (due
`manual-replace` sullo stesso `orderId`), che il LOCK di mercato doveva chiudere. Il LOCK **c'è e ha
retto** — le due sostituzioni stanno dentro lo stesso `bulk-allocate` — quindi il varco non è la
concorrenza fra cicli: è che **dentro un solo giro due percorsi diversi hanno agito sullo stesso ordine**.
⚠ Il tetto ha fatto il suo mestiere **a valle** (ha rifiutato i rinnovi) e **non** a monte: nessuno ha
impedito il secondo piazzamento. Episodio unico in 12,8 ore: 1 su 326 piazzamenti.

### I tre reperti minori

**③ `lib/maker/cancel-all.js` intestazione — D7.** Dice «DISARMED BUILD: no real cancel credentials are
wired here … calling cancelAllOrders() right now is safe». **Non è più vero**:
`agents/agent43-guardian.js:495-496` costruisce i `credsProviders` veri e li passa. Il commento
descrive una versione disarmata che non esiste, sulla superficie di cancellazione del kill.

**④ `auto-reprice/cancelled-top-of-book` porta una causa che non è il top-of-book.** Tutte e 3 le
occorrenze della finestra hanno `reason`: «rinnovo NON dovuto: una gamba sola a riposo e ZERO posizioni
su entrambi i token, confermato dopo 2389s» — cioè la **gamba orfana**. Nome dell'esito e causa
scritta descrivono due meccanismi diversi: chi conta gli esiti conta la cosa sbagliata.

**⑤ Tre famiglie di esito di rifiuto senza `reason`**: `manual-cancel/noop` (31),
`manual-replace/reject-doppione-identico` (28), `postOrder/reject-idempotent` (9). Il nome dell'esito è
autodescrittivo, quindi non sono «non ha funzionato senza motivo» — ma sono le sole righe della
finestra in cui la causa vive nel nome e non nel campo.

### Cinture mai invocate nella finestra — l'inventario

| cintura | stato | perché |
|---|---|---|
| **TRIGGER 4 · erosione della profondità** | **0 scatti** | soglia 40% lontana dai dati (§5.2 p.43); `sospensioni-erosione.json` assente |
| **profondità davanti (`depthMultiple`)** | **spenta su TUTTI i mercati** | nessun mercato ha `depthMultiple` configurato ⇒ `depthMultipleN = null` ⇒ `prezzoInCoda` senza protezione. 0 righe «ARRETRATO PER PROFONDITÀ» |
| `lib/maker/quantita-davanti.js` | **zero chiamanti**, nel repo intero | non committato, nessun `require` lo nomina |
| scala d'urgenza sullo scoperto | 0 | zero posizioni: nessun soggetto |
| presa di profitto | 0 | idem |
| merge Livello 0 · riscatto on-chain | 0 | idem |
| sblocco progressivo / gradino 6 | 0 | nessun blocco strutturale rilevato |
| slot sterile | 379 misure, **0 azioni** | disarmata per configurazione (§4.13) |
| guardiano perdite | **vivo, misura ogni 30 s** | PnL −$58,82 (−3,79%) contro soglia −5% / −$77,51 |

### Ciò che è NON VERIFICABILE, e quale registro manca

- **Quanti ordini ci fossero al venue** — `data/venue-orders.json` contiene solo `{marketId: {at}}`:
  **nessun conteggio, nessun prezzo, nessuna size**. La lettura autorevole può confermare *quali
  mercati* hanno ordini, mai *quanti*. Il difetto ② è stato visto dalla ricostruzione; la lettura vera
  non avrebbe potuto vederlo. Già registrato in §15, resta aperto.
- **Quale TRIGGER ha prodotto ogni `auto-reprice/sent`** — le righe `sent` non portano il campo
  `trigger` (che esiste e vive solo in `data/maker-auto-reprice-state.json`, sovrascritto). La
  classificazione qui sopra è stata ricostruita accoppiando `sent` con il `trigger` immediatamente
  precedente sullo stesso millisecondo: funziona, ma è una giunzione, non un dato.
- **Il cooldown di 10 minuti e la quiete di 180 secondi sulla rotazione NON ESISTONO** in
  `lib/maker/selezione-mercati.js`: le sole guardie sono l'isteresi `max($0,50/g, 25%)`
  (`SPODESTA_MARGINE_USD_GIORNO`/`_FRAZIONE`, righe 184-185) e le tre condizioni ①②③④ di riga 828-834.
  Non è una violazione: è una regola che il codice non ha mai avuto.

---

## 20 · 📋 REFERTO DEL TEST A 2,55¢ — chiuso in anticipo, 20 agosto 2026

**Finestra `06:35:19Z → 10:12Z`, 3,6 h, 218 campioni dell'osservatore + 20.364 righe di giornale.**
Escluse **22** righe di fixture di `agent44` (i `cid` a byte ripetuti fra 06:35:19 e 06:37:30 — non le
sei che avevo contato: la scansione ne ha scritte 22 su cinque `cid` finti, non su uno).

### ⓵ Il tasso di premio — **il confronto 4,7× era sbagliato, e la correzione lo rovescia**

Il premio di `data/osservazione-24h.jsonl` è **cumulativo per GIORNO e azzera a 00:00Z**. La finestra a
3,45¢ scavalca la mezzanotte: chi la misura come differenza fra primo e ultimo campione ottiene un
numero senza senso. Si somma per segmenti di giorno.

| | **A · 3,45¢** (manopola 0.95) | **B · 2,55¢** (manopola 0.556) |
|---|---|---|
| finestra | 19T15:21:42 → 20T06:34:34 · **15,215 h** | 20T06:35:34 → 20T10:09:41 · **3,568 h** |
| segmenti | 19/08 $0,7894→$7,2844 = **+$6,4950**<br>20/08 $0→$1,8748 = **+$1,8748** | 20/08 $1,8805→$3,1460 = **+$1,2655** |
| premio totale | **$8,3698** | **$1,2655** |
| capitale in banda (integrale/durata) | medio **$129,84** (min 45,92 · max 209,71) | medio **$116,97** (min 53,15 · max 159,63) |
| tasso grezzo | $13,203/giorno | $8,511/giorno |
| **normalizzato** | **$10,169 /g per $100 in banda** | **$7,277 /g per $100 in banda** |

**Rapporto B/A = 0,72×.** Non 4,7×. Il 4,7× nasceva dal confronto fra un tasso grezzo di due ore e un
`$3,12/g` di provenienza non verificata, calcolato con un altro metodo su una finestra che scavalcava
la mezzanotte. **Era un numero non confrontabile, e l'ho presentato come un confronto.**

**⚠ MA NEMMENO LO 0,72× MISURA LA MANOPOLA, e questa è la conclusione vera.** Il tasso è governato da
**quali mercati stanno a libro**, non dalla distanza. Dentro la sola finestra B:

| mercati a libro | `tassoUltimoUsdGiorno` |
|---|---|
| con `0xe798f9e4` | **$30,75 – $35,89/g** |
| con `0xbb86d7eb` (inizio finestra) | $8,01 – $8,12/g |
| senza nessuno dei due | **$0,04 – $0,76/g** |

**Un fattore ~900 fra i mercati, contro un fattore 3,45× che la manopola potrebbe al massimo produrre**
(`S = ((v−s)/v)²`: 0,0544 a 3,45¢ contro 0,1878 a 2,55¢). L'effetto della manopola è sommerso dal
rumore della composizione del portafoglio di un fattore ~260. **Con questi dati la domanda non è
rispondibile**, e nessuna delle due finestre la può rendere tale.

**⚠ Il dato che servirebbe NON ESISTE**: `data/stima-campioni.json` registra `{t, r, c}` — istante,
tasso, copertura — **aggregati**, senza scomposizione per mercato. Una misura pulita richiede il premio
**per mercato**, o due gambe sullo stesso mercato alle due distanze. Non è raccolto da nessuno.

### ⓶ Il pavimento di profondità — **non è peggiorato: −12%**

Righe `profondita-insufficiente`, tutti i mercati, confronto a parità di durata (3,61 h):

| | righe | /ora | di cui `0xd4e77ba6` |
|---|---|---|---|
| **PRE** (3,61 h prima del riavvio) | 758 | **209,9** | 642 (84,7%) |
| **POST** (dal riavvio a adesso) | 669 | **185,3** | 549 (82,1%) |
| differenza | | **−24,6/ora (−12%)** | |

Sulle 91,65 h di copertura precedenti la media è 77,3/ora, ma quelle ore hanno mercati diversi: il
confronto che vale è quello a parità di durata e di mercati. **La manopola non ha aumentato i rifiuti
del cancello di profondità.** Il gate è dominato da un mercato solo, `0xd4e77ba6`, che da solo fa
**3.695 righe su 5.334** dal 19 agosto.

### ⓷ Fill, posizioni, tetti, conteggi

| | |
|---|---|
| **fill** (anche parziali) | **ZERO.** `data/safety-fills.jsonl`: tutte le righe `nofill`. Giornale maker: nessuna riga a tema fill |
| **posizioni aperte** | **0 in tutti i 218 campioni** (`posizioni.leggibile: true`, `n: 0`) |
| **coppie incomplete da posizione** | **nessuna**, per conseguenza |
| **sfondamenti del tetto $61,25** | **ZERO.** Massimi: `0xe798f9e4` $53,67 · `0xd4e77ba6` $53,14 · `0x12dc2b61` $52,92 · `0xbb86d7eb` $52,55. Totale massimo **$159,63** (07:34:38) |
| **`reject-venue`** | **0** |
| **`onTop:true`** | **0** |
| **TRIGGER 3 (`top-of-book`)** | **0 scatti** — quindi 0 spostamenti sotto 30 s da lì |
| **spostamenti sotto 30 s sulla stessa gamba** | **0** su 53 piazzamenti accettati. Intervallo minimo **109,9 s** |
| **campioni-mercato asimmetrici** | **35** — `0x12dc2b61` 26, `0xd4e77ba6` 9 |

**⚠ Il conteggio degli spostamenti sotto 30 s va fatto sulla chiave `(marketRef, requested.book)`.**
Chiave sbagliata due volte: senza `marketRef` (le righe `manual-replace` non ce l'hanno) si fondono
mercati diversi; senza `requested.book` si fondono le **due gambe della stessa coppia**, che vengono
piazzate a 0,4-0,7 s di distanza per costruzione — e allora si contano 22 falsi positivi. Con la chiave
giusta: **zero**.

### ⓸ 🔴 `doppione-identico` — il difetto TOGLIE GAMBE DAL LIBRO, due volte, e una non è tornata

È il «doppio percorso cancel+place / manual-replace sullo stesso `orderId`» già noto. **La conseguenza
misurata è nuova.** Due episodi, identici nella forma:

```
07:07:47.095  auto-reprice  trigger  book=yes  0xd4e77ba6
   proactive renewal: 180s of venue-side life left → re-place at the SAME price 0.831
07:07:48.705  manual-cancel   ok                          ← il vecchio ordine È CANCELLATO
07:07:48.778  manual-place    reject-doppione-identico    ← il nuovo è RIFIUTATO
   esiste gia' un ordine IDENTICO su questo token e lato (0x8928eaa634…, 0.831×56)
07:07:57.563  order-vanished  cancelled-by-system  0x8928eaa634…   ← ed era proprio quello
```

`0x8928eaa634…` **è l'ordine appena cancellato**: il cancello del doppione ha confrontato il rimpiazzo
con il proprio predecessore. Esito `{ok:false, oldCancelled:true, replaced:false, newOrderId:null}`, e
il bot lo dichiara per intero — *«al momento non c'è nessun ordine a riposo per questa gamba»*.

**La collisione è STRUTTURALE, non accidentale**: `expiry-refresh` ripiazza **allo stesso prezzo** per
resettare la GTD (`fromPrice 0.831 → toPrice 0.831`), quindi il nuovo ordine è *identico per
definizione*. Ogni volta che la vista degli ordini propri non è ancora aggiornata fra il `cancel` e il
`place`, il gate del doppione rifiuta. E la vista **non è letta dal venue**:
`ownOrders: {origine: "passati dal chiamante", venueLetto: false, autorevole: true}`.

| quando | mercato | gamba | conseguenza |
|---|---|---|---|
| 07:07:48 | `0xd4e77ba6` | yes | gamba fuori, rientrata al ciclo successivo |
| **09:16:59** | `0x12dc2b61` | **no** | **gamba fuori e MAI PIÙ RIENTRATA** |

Dal 09:17:44 `0x12dc2b61` risulta `yes=1 no=0` per **26 campioni consecutivi**; poi cade anche la YES e
il mercato esce dal libro. **`data/venue-orders.json` alle 10:13:53 elenca un mercato solo**,
`0xd4e77ba6`. È questa la causa del decadimento del libro da 6 ordini/3 mercati a 2 ordini/1 mercato, e
quindi del crollo del premio a $0,04/giorno nell'ultima ora e mezza.

**⚠ Non corretto in questo giro, per istruzione dell'operatore.** Ma va detto che non è cosmetico: è la
prima causa misurata di gambe perse in questa finestra.

### ⓹ La classifica dell'ultima selezione — **il bot è ancorato ai tre mercati peggiori**

Ricalcolata con `valutaAmmissibilita` del modulo vero sul board di `data/liquidity-rewards.json`
(132 righe), perché **`data/selezione-mercati-audit.jsonl` NON registra la scomposizione**: scrive
`valutati: 132` e `ammissibili: 7`, e dei 125 scartati non conserva né il cancello né il premio.

| cancello della regola 2 | mercati |
|---|---|
| `minsize-oltre-soglia` (> 50) | **59** |
| `famiglia-meteo` | **37** |
| `scadenza-troppo-vicina` (< 24 h) | **26** |
| `scadenza-oltre-orizzonte-piano` | 1 |
| `scadenza-non-determinabile` | 1 |
| **AMMISSIBILI** | **8** |

**I primi 10 non ammessi valgono $2.457,08/giorno di premio lordo**; tutti i 124 non ammessi sommano
**$8.607,54/giorno**. I primi cinque sono tutti `scadenza-troppo-vicina` a **1,8 ore** — mercati orari
che il pavimento delle 24 h esclude per costruzione (regola 2, voluta).

**Ma il problema non sono gli esclusi: sono gli ammissibili che il bot non prende.**

| ammissibile | lordo/giorno | minSize | ore | tenuto? |
|---|---|---|---|---|
| `0x1cf96ff2` | **$90,94** | 20 | 445,8 | ❌ |
| `0xaede8a0b` | **$65,02** | 20 | 37,7 | ✅ (appena entrato) |
| `0xb5b33b8c` | **$51,59** | 20 | 29,8 | ❌ |
| `0x7fd71c48` | $16,44 | 20 | 1813,8 | ❌ |
| `0xb98ab55a` | $10,26 | 20 | 277,8 | ❌ |
| `0x5e082f0b` | $2,86 | 50 | 3181,8 | ✅ |
| `0x12dc2b61` | $2,57 | 50 | 1717,8 | ✅ |
| `0xd4e77ba6` | **$0,21** | 50 | 3181,8 | ✅ |

**Tre dei quattro slot sono occupati dai mercati numero 6, 7 e 8 su 8**, mentre il primo ($90,94/g) e il
terzo ($51,59/g) restano liberi. La causa è l'isteresi di spodestamento (`max($0,50/g, 25%)`) unita alla
regola «non si spodesta chi ha ordini vivi»: gli occupanti hanno sempre ordini vivi, quindi **non
vengono mai spodestati**, e il bot resta ancorato a $0,21/giorno con $90,94/giorno a disposizione. È un
lucchetto, non una scelta: chi è dentro ci resta perché è dentro.

**⚠ La classifica vera usa il NETTO del knapsack, non il lordo** — e il netto sottrae la concorrenza. Il
divario di 400× sul lordo è comunque troppo grande perché il netto lo possa spiegare, ma il netto per
mercato **non è persistito da nessuna parte** (`nettiIniettati: 5` è un conteggio, non i valori). Questa
è una misura da fare, non una conclusione da trarre.

---

## 21 · 🔧 `0x5e082f0b` SELEZIONATO E MAI NEL PIANO — diagnosi e riparazione, 20 agosto 2026

### La traccia: dove nasce il piano, con quale chiave, e dove il mercato si perde

| | |
|---|---|
| **chi scrive** | `agents/agent41-realloc-scheduler.js:773` `scriviUltimoPiano()`, chiamato **da un punto solo**, riga **699**, dentro il ciclo pesante da 6 h |
| **dove** | `data/realloc-ultimo-piano.json` |
| **con quale chiave** | **`marketId`** (`CAMPI_RIGA[0]`, riga 767), confrontato normalizzato (`trim`+`toLowerCase`) a riga **1611-1612** da `rigaDi(id)` |
| **chi NON scrive** | il **mini-ciclo da 120 s**: decisione esplicita e commentata alle righe **736-739** — «un piano calcolato su sei ore di storico non deve poter sostituire la memoria di uno calcolato su quarantotto» |
| **stato del file** | scritto **`2026-08-19T15:25:00Z`**, cioè **19 ore fa**, 2 righe: `0xd4e77ba6` e `0xa34edb6c` — e il secondo **non è più selezionato da ieri** |

### 🔴 **NON è un campo mancante. È la stessa regola scritta due volte, in due unità, con due semantiche**

Il mercato **arriva** a `calcolaPianoFuoriProcesso`: `restringiAllaSelezione` (riga 554) lo include,
perché è in `idsAttivi`. Si perde **dentro l'allocatore**, a `lib/rewards/allocator.js:1126`,
`reasonCode: 'quota-coda-lunga'`.

**L'aritmetica, che è il cuore della cosa.** `budgetCodaLungaUsd` (`allocator.js:264-270`) concede alla
coda lunga `capitaleCorto × f/(1−f)` con `f = LONG_TAIL_CAP_FRAC = 0,12`, cioè **13,64 centesimi per
ogni dollaro di fascia corta**. Perché `0x5e082f0b` (`minSize 50`, pavimento premiante **$61,25**)
riceva un solo dollaro servirebbe una fascia corta da **$449,17**. Il capitale libero del mini-ciclo è
**$56**. La quota vale **$7,64**.

**E le due regole si contraddicono esattamente:**

| | la SELEZIONE (`selezione-mercati.js:728`, blocco 2-bis) | l'ALLOCATORE (`allocator.js:712`) |
|---|---|---|
| domanda | **esiste** un mercato attivo in fascia corta? (qualitativa) | quanto capitale ha la fascia corta? (quantitativa) |
| corto assente | ⇒ **esclude** il lungo | ⇒ quota **spenta** (riga 740), il lungo prenderebbe tutto |
| corto presente | ⇒ **ammette** il lungo | ⇒ quota **applicata**, e lo affama |

**Quando una dice sì, l'altra dice no.** Il mercato è ammesso solo nella configurazione in cui non può
essere finanziato — e infatti nel giornale maker, in 3,6 ore di perimetro, **non esiste una sola riga
che lo nomini**: non è stato rifiutato, non è mai stato proposto. Ha tenuto uno slot su quattro per
79 minuti (e oltre) senza poterlo riempire.

**⚠ Ed è un ciclo, non uno stato**: `0x5e082f0b` è uscito per `coda-lunga-senza-fascia-corta` alle
07:14:52 ed è **rientrato alle 07:16:21**, 89 s dopo; uscito alle 09:16:47, rientrato alle 09:18:20.
Esce quando la fascia corta sparisce, rientra appena ne compare un'altra — e in mezzo non riceve mai
capitale. Stessa forma del deadlock del 13 agosto (§5-bis p.120) e di quello del 18 (2-bis): **due
regole che non si parlano**, e nessuno dei due moduli sbagliato da solo.

### Gli altri mercati nella stessa condizione

Ricalcolato sul board vivo (132 righe) con `valutaAmmissibilita` e `pavimentoPremiante` veri:

| mercato | lordo/g | minSize | ore | coda lunga? | finanziabile? |
|---|---|---|---|---|---|
| `0x5e082f0b` | $2,86 | 50 | 3.181 | sì | **NO** |
| `0x12dc2b61` | $2,57 | 50 | 1.717 | sì | **NO** |
| `0xd4e77ba6` | $0,21 | 50 | 3.181 | sì | **NO** |
| `0xaede8a0b` | $65,02 | 20 | 37,7 | no (fascia corta) | sì |

**Tre slot su quattro erano occupati da mercati che l'allocatore non può finanziare in nessuna
configurazione.** `0xd4e77ba6` e `0x12dc2b61` avevano ordini a libro solo perché ce li avevano da
prima e vivevano di **rinnovi** — e un rinnovo non passa dall'allocatore. Il piano non li ha mai
ripianificati: nei 3,6 h di finestra le uniche righe allocate sono `0xbb86d7eb` e `0xe798f9e4`,
**entrambe di fascia corta**.

### 🔩 La riparazione — cancello **2-ter**, `lib/maker/selezione-mercati.js`

Alla selezione mancava la **capienza** della quota, non la sua esistenza. Il cancello nuovo esclude un
candidato di coda lunga quando il suo pavimento premiante è **provabilmente** irraggiungibile:

```
budget massimo della coda = (slot − 1) × tetto per mercato × f/(1−f)
                          = 3 × $61,25 × 0,12/0,88 = $25,06
minSize 20 ⇒ pavimento $24,50 ≤ $25,06  ⇒ passa
minSize 50 ⇒ pavimento $61,25 >  $25,06  ⇒ ESCLUSO
```

**⚠ È un limite SUPERIORE e provabile, non una stima**: il knapsack non alloca a un mercato più del
tetto, e almeno uno slot lo occupa il lungo di cui si sta decidendo. Se nemmeno quel massimo raggiunge
il pavimento, il mercato non è finanziabile in **nessuna** configurazione — non «difficilmente».

**⚠ Tutto INIETTATO, e assente ⇒ regola non applicata.** Il modulo è puro (zero `require`, un test lo
asserisce): `codaLungaFrazione` da `horizon.LONG_TAIL_CAP_FRAC`, `tettoPerMercatoUsd` da
`concentration.MARKET_CAP_FIXED_USD`, `pavimentoPremiante` da `concentration` — ognuno dalla sua
**unica** fonte, nessuno ricopiato (il reperto D1 non è esprimibile).
**⚠ E il pavimento non calcolabile NON esclude**, al contrario del resto della selezione: qui
l'esclusione toglie capitale dal libro, e non si toglie capitale su un numero che non si è letto.

**⚠ GLI STESSI GUARDIANI DI 2-bis, nessuno nuovo**: chi ha **ordini a riposo è intoccabile**; lista
degli ordini **non leggibile ⇒ non si libera nessuno**; i mercati **in gestione** non sono in `attivi`
e non vengono nemmeno guardati. Verificato sul board vivo: `0xd4e77ba6` — il peggiore di tutti,
$0,21/g — **NON viene liberato**, perché ha ordini a libro. Il guardiano funziona.

**Prova, prima e dopo, sullo stato vero:**

| | tenuti | liberati |
|---|---|---|
| prima | `0xd4e77ba6` `0x12dc2b61` `0xaede8a0b` `0x5e082f0b` | — |
| dopo | `0xd4e77ba6` `0xaede8a0b` | `0x12dc2b61`, `0x5e082f0b` (`coda-lunga-sotto-il-pavimento`) |

Lo scarto va a verbale in una lista **separata** (`scartatiPerCodaLungaSottoPavimento`, nel giornale di
selezione): 2-bis guarda l'**esistenza** di una fascia corta, 2-ter la sua **capienza**, e fonderle
renderebbe illeggibile quale delle due ha deciso.

### ⚠ La conseguenza va detta per intero: **i due slot liberati NON si riempiono**

`postiNonAssegnati: [{scaglione: "alto", posti: 2}]`. La composizione a 4 slot è **1 «basso» (≤20) +
3 «alto» (≤50)**; il posto «basso» è occupato da `0xaede8a0b`, e i quattro candidati migliori del board
— **`0x1cf96ff2` a $90,94/g**, `0xb5b33b8c` a $51,59/g, `0x7fd71c48`, `0xb98ab55a` — sono **tutti
`minSize 20`**, quindi tutti scartati con `quota-scaglione-piena` sullo scaglione «basso». I 3 posti
«alto» possono ospitare solo `minSize ≤ 50`, e ogni candidato «alto» del board è coda lunga.

**Non è una regressione introdotta da 2-ter**: quei due slot producevano $0,00 dal piano anche prima.
Ma il vincolo che morde adesso è **la quota degli scaglioni**, ed è una decisione esplicita
dell'operatore (§4.13: «uno scaglione vuoto non si riempie col vicino», perché sostituire porterebbe il
capitale da $147 a $183,75). **Non l'ho toccata.** Con la selezione ancorata a $0,21/g e $90,94/g in
attesa dietro un vincolo di composizione, è la prossima decisione da prendere.

### 🧬 Il gemello — **dichiarato, NON corretto in questo giro**

**`agent41:1610` + `:1452` — `ripristinaGamba` legge il piano SALVATO e non applica nessun controllo di
coda lunga.** Gli basta che esista una riga con quel `marketId`: se il mercato sta nel piano di 19 ore
fa, la gamba torna a libro; se è stato selezionato adesso, no. È il motivo per cui `0xd4e77ba6` continua
a essere rifornito e `0x5e082f0b` non lo è mai stato.

**`agent41:3367` — il gradino 4 della scala di sblocco (`ripara-precondizioni`)** chiama
`preparaMercatoNuovo` su **ogni** `marketId` del piano salvato, **senza nessun controllo di selezione**:
un piano vecchio può riabilitare un mercato che la selezione ha già rilasciato.

Entrambi lasciati come sono, per istruzione.

---

## 22 · 📏 LA DISTANZA DA 2,55¢ A 2,05¢ — 20 agosto 2026, decisione dell'operatore

| | |
|---|---|
| **formula** | `distanzaC = frazione × v` — `lib/maker/distanza-obiettivo.js:227`, funzione `distanzaObiettivoCents` |
| **banda** | `v = 4,5¢` (banda premiante modale, **non toccata**) |
| **valore vecchio** | **`0.556`** ⇒ 0,556 × 4,5 = **2,50¢** |
| **valore nuovo** | **`0.456`** ⇒ 0,456 × 4,5 = **2,052¢** |
| **dove** | `agents/ecosystem.config.js:346` (agent40) e **`:617`** (agent41) — *entrambi*, o i due processi che decidono un prezzo divergono (§5.1) |
| **punteggio** | `S = ((v−s)/v)²` passa da **0,1975** a **0,2959**, cioè **+49,8%** a parità di capitale |

`MAKER_MERCATI_CONTEMPORANEI` **resta `'4'`** (riga 521), non toccato.
Il pavimento di profondità e ogni parametro della regola 4 **non sono stati toccati**: se il cancello
rifiuta un mercato è atteso, si dichiara e non si aggira.

**⚠ La frazione è un PAVIMENTO, non un bersaglio**: il prezzo può solo allontanarsi dal mid, quindi
«mai primo sul libro» resta intatto per costruzione. `FRAZIONE_MASSIMA = 0,95` continua a valere come
tetto (0,456 è ben sotto).
**⚠ `distanza-2c.test.js` resta rosso con le STESSE 3 asserzioni letterali su `0.95`** (45 verdi, 3
rossi, identico a prima della modifica). L'asserzione che conta — *«e TUTTI i valori COINCIDONO (una
divergenza qui è la classe D1)»* — è **VERDE**: i due processi dichiarano lo stesso `0.456`. Le tre
rosse fotografano un valore invece di difendere una proprietà (§5.3), e vanno **riscritte sulla
proprietà, non ammorbidite**: è una modifica autorizzata a parte, non fatta in questo giro.

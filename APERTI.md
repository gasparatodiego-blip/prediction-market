# Cosa resta aperto — 18 agosto 2026

Scritto perché una sessione nuova possa riprendere **senza rileggere tutto**. In ordine di quanto costa
se non si ripara. Lo stato del sistema al momento della chiusura è in fondo.

---

## IL QUADRO — dove siamo

| | |
|---|---|
| **flotta pm2** | **11 processi ONLINE**, utente `bot`, `cwd` `/home/bot/bot` |
| **cinture** | **1/4 inserite** su agent41, **2/4** su agent40 — lette da `/proc/<pid>/environ` (§10) |
| **regole concordate** | **10 su 10 in servizio** (§0), **10 su 10 verificate dal banco** |
| **passi del giro completo** | **26 su 26**, 0 rossi — identico al controllo su HEAD nello stesso worktree |
| **suite** | **229 test · 226 verdi · 2 ROSSI · 1 non parte** (19/08, albero committato, misurato; erano 12 la mattina). I 2 dipendono dai **dati vivi** (board), non dal codice. Gli 8 di `c919981` sono stati riscritti sul gate `book-non-databile`; i 3 del tetto di esposizione sull'invariante giusta — **`cap ≥ riposo + completamento`**, cap fermo a $650 |
| **regole che scattano** | **20 statiche + 15 dinamiche su 91**, col cablaggio di produzione |
| **quanti mercati** | **1**, da `MAKER_MERCATI_CONTEMPORANEI` nell'ambiente di agent41 — ⚠ ma il **perimetro è 2** e si consuma da solo (§10) |
| **bot** | **UNA CINTURA SOLA**: le due di armamento sono APERTE su istruzione dell'operatore, resta `MANUAL_ORDER_PLACEMENT` (`dry-run` su agent40, **assente** su agent41) · perno vuoto · **zero ordini a libro** · gli ordini si costruiscono, si **firmano** e si fermano un istante prima dell'invio (§10) |

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

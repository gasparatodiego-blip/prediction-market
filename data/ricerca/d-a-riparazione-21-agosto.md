# D-A · la selezione congelata di `agent41:1357` — simulazione a secco e riparazione

21 agosto 2026. Causa accertata in `data/ricerca/frontiera-5-dollari-21-agosto.md` §4/§13, non ridiscussa.

## 1 · `bestObiettivoPerDay` È DAVVERO A PRIORI — verificato, non assunto

Catena, letta sul sorgente e poi **eseguita**:

```
allocate.js:437  pairCostForMarket ──────────────► pc = 1 − 2d
allocate.js:455  perMarketNetCurve(… pairCostUsd: pc)
allocate.js:213  net5m := netScoredPerDay ?? netPerDay5m
net.js:73        share = shareForCapital(limDepth, mid, capitalTotal, minSize, pairCostUsd)
net.js:93        if (mos.length === 0) adverse = 0;   // «no fills → zero realised cost (KNOWN, not unknown)»
allocator.js:995 bestObiettivoPerDay = best.net5m
```

Gli ingressi del **lordo** sono tutti osservabili PRIMA di quotare: `pot` (il montepremi pubblicato),
`limDepth` (la concorrenza in banda **letta dal book**), `mid`, `minSize`, `pairCostUsd`. Il **costo**
viene dai fill osservati, e `net.js:93` lo dichiara **zero conosciuto** — non ignoto — quando i fill
sono zero. È per questo che il campo esiste anche per un mercato mai quotato.

**Prova per esecuzione** (`scripts/ricerca/d-a-simulazione-a-secco.js`, che chiama lo **stesso**
`RUNNER_PIANO` di `agent41:1332` con lo stesso payload e lo stesso tetto derivato dal capitale):

| | |
|---|---|
| candidati nel piano | 114 |
| ammissibili ai cancelli (stessa `SELM.valutaAmmissibilita`) | 24 |
| classificabili con **`bestNetPerDay`** (oggi) | **9** |
| classificabili con **`bestObiettivoPerDay`** | **22** |
| motivo dell'assenza sui 13 che si sbloccano | `nessun-fill-osservato` × 13 |
| candidati con solo il vecchio e non il nuovo | **0** |

**⇒ Non è un numero cieco sostituito con un altro numero cieco: è lo stesso numero senza la maschera.**

## 2 · IL DENOMINATORE — è il costo della coppia, e la catena lo eredita

`curve.shareForCapital:85-87` → `size = capitalTotal / pairCostUsd` (la forma di `ef6be4d`), con
ripiego `(C/2)/mid` **non preso** sul nostro percorso: `planFromCollection:1495` passa
`usePairCost: opts.usePairCost !== false` e agent41 non imposta l'opzione ⇒ **true**.
`net.js:82` usa `size-da-capitale.sharePerLato`, la SSOT. `realistic-estimate.js:269` **è corretto**
(`1a8e89a`) ma **non è in questa catena**: la stima realistica è un ramo parallelo, l'obiettivo del
knapsack passa da `net.js`. Dichiarato per non far credere a un'eredità che non c'è.
⚠ La terza copia di `1 − 2d` in `allocate.js:387` resta, già dichiarata in `CLAUDE.md` §5.2 p.50.

## 3 · IL FILL OSSERVATO NON VIENE BUTTATO

`bestNetPerDay = calcNetPerDay({fills, netPerDay: net5m})` restituisce **`net5m` stesso** quando i
fill ci sono, e `null` quando non ci sono. `bestObiettivoPerDay = net5m` sempre.
**Misurato: sui 9 candidati che hanno entrambi i campi, il divario è 0 su 9.**

- **occupanti con storico** → continuano a pagare il costo di adverse selection misurato. Quattro dei
  cinque occupanti stanno a netto **negativo** (`0 bps` −$0,0627, `Democratic Party` −$0,0434,
  `Lamine Yamal` −$0,2039, `Marco Rubio` −$0,2399): il dato osservato **morde**, e resta.
- **candidati nuovi** → ricevono la stima a priori (costo modellato 0) invece di `null`.

⚠ **L'asimmetria va detta**: un candidato nuovo non ha ancora pagato il suo costo, quindi il suo
numero è sistematicamente **più ottimista** di quello di un occupante con storico. È la stessa
asimmetria che `collector-priority` accetta dall'8 agosto. Chi la contiene sono i freni del §4 —
non è gratis, è **contenuta**.

## 4 · I FRENI REGGONO, E LEGGONO LA GRANDEZZA NUOVA

| freno | dove | legge cosa | esito |
|---|---|---|---|
| isteresi **+$0,50/g oppure +25%** | `selezione-mercati.js:184-185, :198` | `nettoDi()` **su entrambi i lati** (`:954` occupante, `:974` sfidante) | ✅ nuova grandezza, coerente |
| **cooldown 10 min** del trigger | `trigger-capitale-fermo.js:94-96` (`COOLDOWN_MS = 600_000`) | tempo | ✅ non legge netti |
| **quiete 180 s** dopo un ciclo | `trigger-capitale-fermo.js:103` (`QUIETE_DOPO_CICLO_MS = 180_000`) | tempo | ✅ non legge netti |
| **TTL 10 min** della classifica | `agent41:1317` (`NETTI_TTL_MS`) | la mappa intera | ✅ nuova grandezza |

**Nessun freno legge ancora `bestNetPerDay`: la correzione non è a metà.**
⚠ `allocator.js:1585` ordina l'array `candidates` per `bestNetPerDay`, ma agent41 ne costruisce una
**mappa per marketId**: l'ordine dell'array non entra nella decisione. Dichiarato, non toccato (§9).

## 5 · SIMULAZIONE A SECCO — `decidiSelezione` VERA, due volte, stessi ingressi

`scripts/ricerca/d-a-selezione-prima-dopo.js`. ⚠ **Le manopole si leggono da `/proc/<pid>/environ` di
agent41, non dal `.env`**: `MAKER_QUOTA_CODA_LUNGA=0.5` NON è nel `.env`, e la prima corsa — che lo
leggeva da lì — ha usato **0,12**, cioè ha simulato un bot che non esiste. Corretto e rifatto.

### Classifica dei 22 visti, prima e dopo (● = occupante)

| # | PRIMA — `bestNetPerDay` | DOPO — `bestObiettivoPerDay` |
|---|---|---|
| 1 | · $2,2592 24–27 Democratic House | · $2,2592 24–27 Democratic House |
| 2 | · $0,0416 J.D. Vance | · **$0,2238 Spider-Man** ← invisibile prima |
| 3 | ● $0,0264 1 Fed rate cut | · **$0,1248 Bad Bunny** ← invisibile prima |
| 4 | ● $0,0035 Republican Party | · **$0,0588 Avengers** ← invisibile prima |
| 5 | ● −$0,0434 Democratic Party | · **$0,0450 Swedish SocDem** ← invisibile prima |
| 6 | · −$0,0504 Harry Kane | · **$0,0434 Mike Rogers** ← invisibile prima |
| 7 | ● −$0,0627 0 bps no Fed cuts | · $0,0416 J.D. Vance |
| 8 | · −$0,2039 Lamine Yamal | ● $0,0362 LCK |
| 9 | · −$0,2399 Marco Rubio | · **$0,0321 LPL** ← invisibile prima |
| 10–22 | *(non classificabili)* | ● 1 Fed cut, poi 12 altri |

### Chi verrebbe spodestato, e da chi

**NESSUNO.** Prima 0, dopo **0**.
Il gate che tiene: `selezione-mercati.js:992` — `haOrdini && !(occ.netto < 0 && sfidante > 0)`.
I due occupanti a netto negativo sono nello scaglione **alto**; il solo sfidante che supera
l'isteresi di **$0,50/g** è `24–27 Democratic House` (**$2,2592**), che è **basso**. Scaglione
diverso ⇒ `return false`. Gli sfidanti dello scaglione alto (Spider-Man $0,2238) **non arrivano a
+$0,50** sopra un occupante a −$0,0627. **È l'isteresi a tenere, esattamente come previsto.**

### Sostituzioni attese

| finestra | prima | dopo |
|---|---|---|
| **prima ora** | 0 | **0** |
| 24 h, a slot invariati | 0 | **0** |

Ben sotto la soglia di 2-3 dichiarata. ⚠ Per confronto, il **turnover naturale** misurato nelle 24 h
precedenti è di **12 spodestamenti e 37 rilasci** su 527 cicli — la correzione non lo aumenta.

### Il guadagno si vede quando uno slot si libera (controprova, slot rimosso in memoria)

| slot liberato da | PRIMA entra | DOPO entra |
|---|---|---|
| 1 Fed rate cut ($0,0264) | **se stesso** ($0,0264) | **Spider-Man ($0,2238)** — 8,5× |
| Republican Party ($0,0035) | **se stesso** ($0,0035) | **Spider-Man ($0,2238)** — 64× |
| 0 bps no Fed cuts (−$0,0627) | **Harry Kane (−$0,0504)** | **Spider-Man ($0,2238)** — da negativo a positivo |
| Democratic Party (−$0,0434) | **se stesso** (−$0,0434) | **Spider-Man ($0,2238)** — da negativo a positivo |
| LCK ($0,0362) | 24–27 Democratic House | 24–27 Democratic House (invariato) |

**Il difetto in una riga: senza la correzione, uno slot che si libera viene ripreso dal mercato che
lo ha appena lasciato, o da uno a netto negativo, perché le alternative sono invisibili.**

## 6 · GLI INTOCCABILI — reggono, e sono provati per assenza

| protezione | esito | dove |
|---|---|---|
| occupante con **ordini a riposo** e netto ≥ 0 | **non spodestabile** | `selezione-mercati.js:992` |
| occupante con **posizione aperta** | **non spodestabile** | blocco ③, provato dal test |
| **coppia incompleta / in gestione** | fuori dal conteggio slot, `inGestione` | §4.13 |
| ordini leggibili? | `leggibile:false` ⇒ **nessuno spodestato** | fail-closed |
| mappa netti assente | ⇒ **nessuno spodestato** | `agent41` catch → `null` |

**Nessun ordine a libro viene toccato: con 0 spodestamenti non c'è nessuna cancellazione.**
Alle 15:07 il libro portava **10 ordini su 5 mercati**, tutti conservati in entrambe le corse.

## 7 · RIAVVII — solo agent41, e nessun ordine diventa PRE-ESISTENTE

- File toccati: **`agents/agent41-realloc-scheduler.js`** e il test nuovo. Nient'altro.
- **`agent41` non è importato da nessun processo** (solo da file `*.test.js`): raggio zero.
- **`lib/maker/ordini-preesistenti` è richiesto da `agents/agent40-manual-reprice.js:207`** — e da
  `operator-board.js`. **agent40 NON viene riavviato**, quindi la regola dei pre-esistenti non si arma
  e i 10 ordini a libro restano gestiti, riprezzati e rinnovati.
- **Nessuna variabile d'ambiente nuova** ⇒ basta `pm2 restart`, non serve `delete + start`.
- ⚠ Al riavvio la cache `_netti` si azzera: la prima classifica dopo il riavvio è ricalcolata, non
  ereditata. È il comportamento voluto.

## 8 · QUANTIFICAZIONE DELLA DIFESA CHE TORNA ATTIVA

La selezione **non** falliva chiusa: rotava già fra i mercati con storico (12 spodestamenti nelle 24 h
precedenti). Ciò che era spento è la **candidatura dei mercati senza storico**, oggi 13 su 22.
Con i dati di adesso, nelle prossime 24 h la correzione **non produce alcuno spodestamento in più**;
produce una scelta diversa **solo quando uno slot si libera**, cosa che nelle 24 h precedenti è
accaduta **37 volte**. Nessun riarmo umano è richiesto in nessun caso: la selezione non ha latch.

## 9 · ALTRI DIFETTI TROVATI — dichiarati, NON corretti

**D-G · `lib/maker/quantita-davanti.js` non ha chiamanti** (19 agosto, non tracciato da git). È la
forma che `CLAUDE.md` §4.14 chiama «una cintura senza chiamanti è peggio di nessuna, perché me la fa
contare». Non toccato: non è mio e non rientra nell'incarico.

**D-H · lo `scaglione` salvato nello stato può divergere da quello calcolato dal board.**
`selezione-mercati` rifiuta lo scambio quando `v.scaglione !== occ.voce.scaglione`, ma il primo è
ricalcolato dal `rewardsMinSize` corrente e il secondo è **congelato** in
`data/selezione-mercati.json` all'ingresso. Se il venue cambia `rewardsMinSize`, o se cambia
`MAKER_MERCATI_CONTEMPORANEI` (che cambia i secchi: a N=1 il secchio unico si chiama `alto`), un
occupante resta con un secchio che non esiste più e **diventa non spodestabile in silenzio**.
Trovato dal test che falliva, non dalla rilettura. Non corretto: cambia il comportamento della
rotazione e va deciso.

---

## 10 · COSA È SUCCESSO DAVVERO DOPO IL RIAVVIO — e la mia previsione era sbagliata

Riavvio di **agent41 soltanto** alle **15:28:37** (pid 667820). agent40 non toccato (su dalle 04:28):
**nessun ordine è diventato PRE-ESISTENTE.** Manopole da `/proc` invariate.

**Primo ciclo di selezione, 15:33:41** — `nettiIniettati: 29` (erano 8-13): la correzione è in servizio.

> ### ⚠ AVEVO SCRITTO «ZERO SPODESTAMENTI, NESSUN ORDINE TOCCATO». È SUCCESSO IL CONTRARIO.
> Cinque minuti dopo il riavvio la selezione ha **spodestato** `0xd4e77ba6` («no Fed rate cuts»,
> netto **−$0,0627/g**) a favore di `0x9a59e167` («Trump meet Lukashenko», netto **+$3,6558/g**), e
> ha **cancellato 2 ordini veri** (`cancellati: {chiesti: 2, riusciti: 2, falliti: []}`).
>
> **Perché la simulazione a secco diceva 0 e non era un errore di metodo: il board si è mosso.**
> Alle 15:0x gli ammissibili erano **24** e nessuno sfidante superava l'isteresi nello scaglione
> giusto. Alle 15:33 erano **35**, e `0x9a59e167` — che alle 15:0x **non era sul board** — li
> superava. La simulazione era corretta *per il suo istante*; l'istante è durato meno di mezz'ora.
> **Una simulazione a secco su un board vivo ha la data di scadenza del board.** Va detto qui perché
> è la lezione, non la scusa.
>
> **La correzione È la causa, verificato e non dedotto:** rieseguito il probe alle 15:35,
> `0x9a59e167` ha `bestNetPerDay: null` con motivo `nessun-fill-osservato` e
> `bestObiettivoPerDay: 3,6558`. **Senza la correzione era invisibile e non avrebbe potuto
> spodestare.**
>
> **La regola che ha cancellato NON è nuova ed è quella giusta**: `selezione-mercati.js:992` permette
> lo scambio su un occupante con ordini vivi **solo** se il suo netto è negativo e quello dello
> sfidante positivo — e il giornale lo dichiara: «l'occupante e' in PERDITA e ha ordini a riposo:
> vanno cancellati esplicitamente». Nessuna protezione è stata aggirata: **posizione aperta zero**,
> quindi la cancellazione non ha lasciato nessuna gamba nuda.

### Stato finale, letto (non ricostruito)

| | |
|---|---|
| ordini a riposo | **10** su **5 mercati** (erano 9 prima del riavvio) |
| coppie | **5 su 5 simmetriche** — nessun allarme di asimmetria |
| posizioni al venue | **0** |
| saldo / equity | **$1.494,78**, invariato |
| guardiano | drawdown **−3,573%**, margine **$22,12**, latch **assente** |
| scambio netto della giornata | netto **−$0,0627/g → +$3,6558/g** sullo slot |

| mercato | gambe | size | costo coppia |
|---|---|---|---|
| `0x5e082f0b` 1 Fed rate cut | 2 | 56,5 | 0,950 |
| `0x4e4f77e7` Republican House | 2 | 56,5 | 0,950 |
| `0xbfc776a7` LCK LoL Worlds | 2 | 56,5 | 0,950 |
| `0xd5d9fc47` Democratic House | 2 | 56,5 | 0,950 |
| `0x9a59e167` Trump–Lukashenko **(nuovo)** | 2 | 57,1 | 0,930 |

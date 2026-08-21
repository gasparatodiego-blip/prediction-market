# Referto — LA DISTANZA DAL MID · 21 agosto 2026, 09:30-10:00Z · SOLA LETTURA

Nessun ordine piazzato o cancellato, nessun riavvio, nessuna configurazione toccata, nessun commit.
Scritture solo in `scripts/ricerca/` e `data/ricerca/`.

**Script (non committati, su disco):** `_leggi-ordini-vivi.js` · `distanza-referto-21-agosto.js` ·
`divario-manopola-21-agosto.js` · `fill-24h-21-agosto.js` · `costo-dopo-il-fill-21-agosto.js` ·
`costo-scopertura-21-agosto.js` · `_tape-distanza.js` · `_reward-incassati.js`

---

## 0 · LA PREMESSA — quattro affermazioni su sei sono false

| affermato | misurato | fonte |
|---|---|---|
| 5 slot su 5 | **4 su 5** — il 5º è vuoto per la **quota di composizione** (1 posto riservato a `minSize ≤ 20`, nessun ammissibile), con **6 ammissibili su 124** | `realloc-scheduler.jsonl` 09:48:37Z, `slotVuotiPerScarsita` |
| 10 gambe | **8** | lettura del venue |
| 56,5 share | 56,5 su tre mercati, **56** sul quarto | lettura del venue |
| $268,38 a libro | **$214,62** | 8 ordini veri |
| `…FRAZIONE_V=0.456` | ✅ confermato su **entrambi** i processi da `/proc/<pid>/environ` | agent40 pid 624894, agent41 pid 632415 |
| distanza reale 2,50¢ | ✅ 2,50¢ su tre mercati, **2,15¢** sul quarto (tick 0,001) | book vivo |
| **«premio reale incassato $0,07 in 3 ore»** | **NON ESISTE.** L'ultimo pagamento REWARD è **$4,9455** il 21/08 00:00:07Z (competenza 20/08). Per oggi non c'è consuntivo e non ci sarà fino al 22/08 00:00 — il venue paga la giornata UTC chiusa. Il numero vicino a $0,07 è la **stima integrata del bot**: $0,1854 sulle ultime 3 ore, $0,4084 da mezzanotte | `/activity?type=REWARD`, `data/stima-campioni.json` |

Nove pagamenti REWARD in tutto: $4,9455 · $2,183 · $6,9782 · $17,702 · $1,6628 · $4,2525 · $8,3524 · $3,6792 · $1,3042.

**Il libro di adesso** (v = 4,5¢ su tutti e quattro, `minSize` 50):

| mercato | tick | mid YES | nostre gambe (spazio YES) | dist. | pool/g | Q altrui |
|---|---|---|---|---|---|---|
| 1 Fed rate cut 2026 | 0,01 | 0,0950 ⚠ fuori [0,10·0,90] | bid 0,07 / ask 0,12 | 2,50¢ | $66 | 23.988 |
| Fed rate hike 2026 | 0,01 | 0,4950 | bid 0,47 / ask 0,52 | 2,50¢ | $50 | 43.578 |
| Republican House 2026 | 0,01 | 0,1150 | bid 0,09 / ask 0,14 | 2,50¢ | $50 | 38.880 |
| No Fed rate cuts 2026 | 0,001 | 0,8645 | bid 0,843 / ask 0,886 | 2,15¢ | $116 | 53.870 |

⚠ **Il book YES è già il book FUSO, ed è misurato non assunto**: su tutti e quattro i mercati
`NO.bids[i].size == YES.asks[i].size` **esattamente** e `NO.bid = 1 − YES.ask`. Quindi le nostre due
gambe BUY sono, nello spazio YES, **un bid E un ask**: siamo bilaterali e `qMin` non ci applica la
penalità del lato singolo — che sul primo mercato (mid 0,095, fuori range) azzererebbe il premio.

---

## 1 · LA FORMULA VERA

**Del venue** (docs.polymarket.com/market-makers/liquidity-rewards):

```
S(v,s) = ((v − s)/v)²        b = 1
Q_bids = Σ S(v, |p_i − mid|·100) · size_i        Q_asks = idem sugli ask
mid ∈ [0,10 · 0,90] :  Q_min = max( min(Qb,Qa), max(Qb/3, Qa/3) )      c = 3
mid fuori           :  Q_min = min(Qb,Qa)          ← bilaterale OBBLIGATORIO
v = rewardsMaxSpread (SEMIampiezza, in centesimi)   mid = ricalcolato sui soli ordini ≥ minSize
```

**Dove il bot la implementa** — e **coincide, esattamente**:

- `lib/banda-premiante.js:78` → `punteggio()` = `((v−s)/v)²`; `raggioBandaCents():62` → `v = maxSpread`
- `lib/rewardScore.js:60` → `scoreOrder()`; `:88` `scoreSide()`; `:96` `qMin()` con `C_FACTOR = 3`; `:105` `scoreBook()`

Nessuna euristica nel **punteggio**. Verifica indipendente: il mio `Qcomp` calcolato da zero sul book
vivo coincide con il `competitorQ` che agent24 pubblica entro **0-4%** su tre mercati (23.988 vs
23.952 · 43.578 vs 43.868 · 38.880 vs 37.327) e 34% sul quarto (book più mobile).

### ⚠ MA IL PREZZO NON LO DECIDE LA FORMULA — questo sì è un'euristica

`planBehindBest` (`lib/maker/top-of-book.js:225`), attraverso `prezzoInCoda`
(`lib/maker/prezzo-in-coda.js:72`), sceglie il prezzo con: **un tick dietro il migliore altrui** →
clamp di banda → pavimento di profondità → manopola (`distanza-obiettivo.js`) → **arrotondamento sulla
griglia ALLONTANANDOSI dal mid**. `S` non viene mai valutata né massimizzata: `motore-unico.js:253`
calcola `punteggioDiUnLivello` **solo per il referto**. La giustificazione è scritta
(`motore-unico.js:29`) ed è corretta *a manopola spenta* — «il livello più vicino al mid che rispetta
le regole 1 e 2 è già quello col punteggio più alto». Con la manopola accesa il bot si allontana
deliberatamente dall'ottimo, e l'arrotondamento lo allontana **di più di quanto chiesto**: §5.

### ⚠ DIFETTO — DUE FORMULE CAPITALE→SHARE, E LA STIMA VIVA USA QUELLA SBAGLIATA

`lib/rewardScore.js:135` (`estimateCapitalLevelRange`) fa **`size = capital / mid`**.
`lib/rewards/size-da-capitale.js:45` (`sharePerLato`, la funzione del **piazzamento**) fa
**`size = capital / pairCost`**. Reperto **D1** sul numero che governa l'intera stima.

Fattore d'errore = `pairCost / mid`, per mercato: **10,0× · 1,92× · 8,26× · 1,11×**. A $1.000 sul
primo mercato l'estimatore assume **10.526 share** dove la coppia vera ne compra **1.053**.

Catena viva: `agent24.computeLevels:545` → `refShare` → `reward-operator-estimate.estimateAtCapital`
→ `operator-board.buildSummary` → `stima-integrata`. **Riprodotto esattamente**: la stima del bot
sui $214,62 di adesso è **$1,3389/giorno**, identica al campione vivo `r: 1.34`. Il mio calcolo dalla
formula pubblicata sul book vero dà **$0,0907/giorno**. È anche la causa strutturale del
`sovrastima 171,51%` già registrato in `confronto-reward.json` per il 20/08.

---

## 2 · LA TABELLA

Assunzioni dichiarate: **i concorrenti non reagiscono** (ottimistica) · size 56,5 (56 sul quarto) ·
`Qcomp` = `qMin` del book aggregato **al netto dei nostri ordini**. Quest'ultima **sovrastima** il
concorrente (il venue calcola il `Qmin` di ogni maker e poi normalizza, e Σ dei `Qmin` individuali
≤ `Qmin` dell'aggregato): i dollari sono un **limite inferiore**.

**IDEALE** = se il prezzo potesse stare esattamente a quella distanza.
**REALE** = quello che `prezzoInCoda`, la funzione di produzione, produce davvero su quella griglia.

| chiesta | 1 Fed cut | Fed hike | Rep. House | No Fed cuts | **TOT ideale** | **TOT reale** | **× vs oggi** |
|---|---|---|---|---|---|---|---|
| **0,63¢** | $0,1148 → **0,069** | $0,0479 → **0,0288** | $0,0537 → **0,0323** | $0,0891 → **0,0882** | $0,3055 | **$0,2183** | **×2,41** |
| **1,00¢** | $0,0939 → **0,069** | $0,0392 → **0,0288** | $0,0439 → **0,0323** | $0,0729 → **0,0708** | $0,2499 | **$0,2009** | **×2,21** |
| **1,50¢** | $0,069 → **0,069** | $0,0288 → **0,0288** | $0,0323 → **0,0323** | $0,0536 → **0,0518** | $0,1837 | **$0,1819** | **×2,01** |
| **2,05¢** | $0,046 → **0,0307** | $0,0192 → **0,0128** | $0,0215 → **0,0143** | $0,0357 → **0,0357** | $0,1224 | **$0,0935** | **×1,03** |
| **2,50¢** | $0,0307 → **0,0307** | $0,0128 → **0,0128** | $0,0143 → **0,0143** | $0,0238 → **0,0226** | $0,0816 | **$0,0804** | ×0,89 |

**Oggi: $0,0907/giorno.** Quote diluite di adesso: 0,0465% · 0,0256% · 0,0287% · 0,0283%.

⚠ **Il moltiplicatore è robusto, i dollari no.** `Qu` (11–42) è **tre ordini di grandezza** sotto
`Qcomp` (24.000–72.000), quindi `quota ≈ Qu/Qcomp ∝ S(d)`: il rapporto fra due distanze è il rapporto
di `S`, **qualunque sia `Qcomp`**. L'incertezza sull'assoluto non tocca il moltiplicatore.

⚠ **0,63¢ e 1,00¢ non esistono sui tre mercati a tick 1¢**: «mai primo sul libro» ci ferma a un tick
dietro il tocco, cioè **1,5¢**. Tutta la differenza fra la riga 0,63¢ e la riga 1,5¢ viene dal solo
mercato a tick 0,001.

---

## 3 · IL PREZZO DEL RISCHIO — dai dati veri, niente probabilità inventate

**Finestra 6 giorni** (15→21 agosto): **1.162 stampe di tape**, **21.485 campioni di book**,
**2 stampe non giudicabili**. La finestra di 24 h da sola dà n=227, sotto le 200 per fascia: si è
aggregato a 6 giorni invece di stringere le fasce.

`raggiunto` = il livello è stato toccato (**necessaria**). `sfondato` = la stampa era più grande di
**tutta** la profondità davanti (**sufficiente**). Il vero sta in mezzo: **la nostra posizione DENTRO
il livello non è misurabile** — il book pubblico non dice chi c'è davanti allo stesso prezzo. Non si
sceglie un punto a caso.

| distanza | raggiunto | sfondato | fill/giorno (8 gambe) |
|---|---|---|---|
| 0,63¢ | 47 | **3** | 0,5 – 7,8 |
| 1,00¢ | 47 | **3** | 0,5 – 7,8 |
| 1,50¢ | 46 | **2** | 0,33 – 7,7 |
| **2,05¢** | 13 | **0** | **0 – 2,2** |
| **2,50¢** | 13 | **0** | **0 – 2,2** |

Per mercato, `raggiunto`/`sfondato` in 6 giorni: 1 Fed cut **5/0** · Fed hike **41/2** ·
Rep. House **0/0** · No Fed cuts (tick fine) **0/0 da 0,5¢ in su**, 5/2 a 0,3¢, 58/18 a 0,15¢.

**Nelle 24 h della premessa: ZERO a ogni distanza testata.** Nessuna stampa, in tutte le 24 ore sui
quattro mercati, è mai caduta a più di **0,50¢** dal mid contemporaneo (n=227, max 0,50¢).
La soglia sotto cui i fill cominciano è **0,30¢**.

### Costo di quelle chiusure, col tetto coppia a 101¢

Misurato sul book **DOPO** la stampa, non su quello di prima — un bid due tick sotto il tocco si
riempie *solo* quando il mercato è sceso attraverso due livelli, cioè quando la gamba sorella è già
più cara. (Sul book fermo di adesso lo stesso conto dà **+$1,13 per gamba**: vero, e inutile.)

| distanza | eventi | coppia ≤ 101¢ | coppia p50 | coppia p90 | PnL p10 | **PnL totale 6 g** |
|---|---|---|---|---|---|---|
| 0,63¢ / 1,00¢ | 47 | **47/47** | 100,00¢ | 101,00¢ | −$0,57 | **−$6,84** |
| 1,50¢ | 46 | **46/46** | 100,00¢ | 101,00¢ | −$0,57 | **−$6,84** |
| 2,05¢ / 2,50¢ | 13 | **13/13** | 100,00¢ | 100,00¢ | $0,00 | **$0,00** |

**Il tetto di 101¢ non è mai stato sfondato in 46 eventi su 6 giorni.** Quindi la scala d'urgenza del
§4.6 (gradino 1 a 30 min, gradino 2 a 60 min col 5% del carico) **non sarebbe mai stata raggiunta**:
la coppia si completa sempre, e una coppia completa si fonde on-chain a $1/share (§4.9 livello 0),
quindi il capitale rientra subito e non resta immobilizzato fino alla risoluzione.

**−$6,84/6 giorni = −$1,14/giorno è il limite SUPERIORE** e assume di essere primi in coda in livelli
che tengono 19.000–43.000 share. Il limite inferiore (soli fill certi, 2/46) è **−$0,05/giorno**.

⚠ **Limiti**: il feed campiona ogni ~75 s, quindi un crollo più breve di 150 s non si vede e i numeri
sono un **limite inferiore**; il book *fra* la stampa e il campione successivo non è osservato.

---

## 4 · IL VINCOLO — il ledger cieco, verificato

**Confermato, e peggio di come è stato posto.** `data/safety-fills.jsonl`, 1.347 righe:
**1.342 `nofill` + 5 `fill`, tutti `BUY`. Zero righe `SELL`.**

`runFifo` (`lib/safety/fills.js:139`) realizza un P&L solo quando un fill chiude un lotto opposto.
Con zero SELL non chiude mai nulla. Eseguito sui moduli vivi:

```
computeRealisedDailyPnl → { ok:true, realisedPnlUsd: 0, closedEvents: [] }
runFifo(tutto il ledger) → 0 eventi realizzati
```

⇒ **il kill a −$100 è strutturalmente irraggiungibile.** Un merge non è un ordine e non entra mai nel
ledger; una SELL della scala d'urgenza non ci è mai entrata.

**Ma il cap $650 NON legge un numero sbagliato.** `computeExposure` (`fills.js:245-300`) **fonde le
posizioni vere del venue sopra il ledger** e netta a `chiusa-al-venue` ciò che il venue non elenca —
è la regola «il ledger si netta contro il venue» di §4.10. Letto adesso: snapshot `readable`,
0 posizioni, **`openNotionalUsd = 0`**, corretto. Ciò che il cap non conta sono gli **ordini a riposo**
($214,62), e quello è deliberato e documentato (§4.13). Il cap **fallisce chiuso** (snapshot
illeggibile ⇒ si torna al ledger, che sovrastima); il kill **fallisce aperto**.

### ⚠ LA DIFESA CHE FUNZIONA È GIÀ AL 71% DEL SUO SCATTO

`agent43-guardian` misura mark-to-market e **non passa dal ledger**. Letto dai log vivi:

```
PnL -55.39 USD (-3.573%) · baseline $1550.18 → $1494.78 · soglie −77.51 USD / −5%
```

**Restano $22,12 di margine**, non $100. Scattando cancella tutti gli ordini e mette FERMA — ma
**non chiude le posizioni**: chiuderle è il mestiere di R10, cioè proprio del kill cieco.

**Conseguenza sulla distanza.** Con il ledger cieco è accettabile solo una distanza dove il conteggio
di fill **misurato** è **zero**, così nessun percorso dipende dalla macchina delle perdite:
**≥ 2,05¢** (13 eventi, 0 sfondati, coppia 100,00¢ in tutti e 13). A **1,5¢ e sotto** la macchina
verrebbe esercitata (2 fill certi e 46 tocchi in 6 giorni) e il suo costo, per quanto piccolo
(−$0,05…−$1,14/g), viene registrato da una sola difesa su due — quella con $22,12 di margine.
Non raccomando 1,5¢ prima della riparazione.

---

## 5 · IL DIVARIO 2,05¢ → 2,50¢

### ⚠ LA CAUSA SCRITTA NELLA DOMANDA È SBAGLIATA

Non è «un tick dietro il miglior bid altrui cade più lontano del pavimento». È
**l'ARROTONDAMENTO SULLA GRIGLIA**, che `applicaObiettivo` fa **allontanandosi dal mid**
(`distanza-obiettivo.js:270`, `Math.floor` nello spazio bid, per non finire davanti a qualcuno per
un errore di griglia). Ricostruito su tutti e quattro i mercati:

| mercato | mid | obiettivo `0,456 × 4,5 = 2,052¢` | griglia | prezzo | distanza |
|---|---|---|---|---|---|
| 1 Fed cut | 0,0950 | 0,07448 | ↓ 0,01 | 0,07 | **2,50¢** |
| Fed hike | 0,4950 | 0,47448 | ↓ 0,01 | 0,47 | **2,50¢** |
| Rep. House | 0,1150 | 0,09448 | ↓ 0,01 | 0,09 | **2,50¢** |
| No Fed cuts | 0,8645 | 0,84398 | ↓ 0,001 | 0,843 | **2,15¢** |

Coincide con gli otto prezzi veri a libro. **La prova che è l'arrotondamento e non la coda**: sul
mercato a tick 0,001 lo stesso identico obiettivo produce un divario di **0,098¢** invece di 0,448¢ —
dieci volte meno, con lo stesso `0.456` e la stessa regola di coda. La regola della coda morde solo
**sotto 1,5¢**, dove è lei a fermarci.

### Quanto costa

| | ideale a 2,05¢ | reale | perso |
|---|---|---|---|
| tre mercati a tick 1¢ | $0,0867/g | $0,0578/g | **−$0,0289/g** |
| mercato a tick 0,001 | $0,0357/g | $0,0329/g | −$0,0028/g |
| **totale** | **$0,1224/g** | **$0,0907/g** | **−$0,0317/g (−25,9%)** |

### Abbassando la manopola: **né si mantiene né si allarga — è a DENTI DI SEGA, e a 1,5¢ SPARISCE**

Scansione da 0,10¢ a 4,45¢ a passi di 0,05¢ con la funzione di produzione. Sui tre mercati a tick 1¢
il mid siede su un **mezzo tick** (0,0950 · 0,4950 · 0,1150), quindi ogni distanza esprimibile è un
multiplo dispari di mezzo tick, e «mai primo» toglie il primo:

> **le uniche distanze RAGGIUNGIBILI sono 1,5¢ · 2,5¢ · 3,5¢.** Divario min −0,95¢, max +1,40¢,
> mediano +0,40¢. Zero esatto **solo** a 1,5¢, 2,5¢ e 3,5¢.

Sul mercato a tick 0,001 le distanze raggiungibili sono 34, da 0,15¢ a 3,45¢, e il divario oscilla
fra 0 e 0,05¢ — con un caso istruttivo: chiedere **2,05¢** dà 2,05¢, ma chiedere **0,456** (= 2,052¢)
dà **2,15¢**. Due millesimi di centesimo oltre una linea di griglia costano un tick intero, il 4,9%
del punteggio.

⇒ **Il divario di 0,45¢ non si corregge abbassando la manopola: si corregge scegliendo un bersaglio
raggiungibile.** Ogni valore fra 1,5¢ e 2,5¢ atterra a 2,5¢, in silenzio.

---

## 6 · ALTRI DIFETTI TROVATI — dichiarati, NON corretti

1. **D1 · due formule capitale→share** — `rewardScore.js:135` `capital/mid` contro
   `size-da-capitale.js:45` `capital/pairCost`. Sovrastima fino a **10,0×** per mercato; è la stima
   che l'operatore legge e quella che alimenta `stima-integrata`. §1.
2. **Il ledger non registra né SELL né merge** — 0 righe SELL su 1.347; `runFifo` produce 0 eventi
   realizzati su tutta la storia; il kill a −$100 non può scattare. §4.
3. **`CLAUDE.md` dice `SLOT_STERILE_ARMATO=0`, ma la variabile è ASSENTE** da
   `agents/ecosystem.config.js` e dall'`environ` vivo di agent41 ⇒ **ARMATA** (assente = armata, per
   regola). I commit `52c33f4` e `870c6ec` mostrano che il riarmo è voluto: è il riquadro di stato a
   essere invecchiato, non il codice.
4. **Il 5º slot è vuoto da ore per la quota di composizione**, non per scarsità: 6 ammissibili su 124,
   ma il posto è riservato a `minSize ≤ 20` e nessun ammissibile lo è. Comportamento voluto (§4.13),
   ma «5 slot su 5» non è lo stato e non lo diventerà da solo.
5. **`data/fills.jsonl` è un file orfano di 0 byte** dal 15 agosto: il ledger vero è
   `data/safety-fills.jsonl`. Nessuno scrittore di produzione lo nomina — solo quattro test e
   selfcheck che ci scrivono i propri temporanei. Un nome che invita a leggere la cosa sbagliata.
6. **Churn di riprezzo alto**: il giornale dell'osservatore registra `auto-reprice-band-exit` ogni
   pochi minuti (fino a **10 ordini cancellati** alle 09:32). La copertura resta buona (mediana 8
   ordini a riposo, min 6), ma non ho misurato quanto costi in priorità di coda — e la priorità di
   coda è esattamente ciò che decide se un tocco diventa un fill (§3).

---

## 7 · COSA NON SONO RIUSCITO A MISURARE

- **La nostra posizione dentro un livello di prezzo.** Il book pubblico non identifica gli ordini.
  È il motivo per cui §3 dà una forbice (`raggiunto`/`sfondato`) e non un numero.
- **La decomposizione di `Qcomp` per maker.** Il venue calcola il `Qmin` di ogni maker e poi
  normalizza; io posso calcolare solo il `Qmin` dell'aggregato, che è ≥ della somma degli individuali.
  I dollari della §2 sono un **limite inferiore**; i moltiplicatori no.
- **La riconciliazione fra il mio modello ($0,0907/g) e il pagamento vero del 20/08 ($4,9455).**
  Quel giorno il bot ha toccato **40 mercati** con distanze e size che non sono ricostruibili dallo
  stato salvato: `realloc-ultimo-piano.json` conserva solo le righe vincenti, gli scartati nessuno li
  scrive (§5.2 p.10), e nel giornale il `tokenId` è **redatto**. Stavo per concludere che il modello
  sovrastima; non posso concluderlo né escluderlo, e lo dico invece di scegliere.
- **Il book fra una stampa e il campione successivo** (~75 s di cadenza): §3 è un limite inferiore.

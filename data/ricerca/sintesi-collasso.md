# Diagnosi del collasso della copertura — 13 agosto 2026

Sola misura. Nessuna modifica al comportamento del bot. Fonti e granularità dichiarate per serie.

## 1 · Le serie, e da dove vengono

| serie | fonte | tipo | copertura | cadenza |
|---|---|---|---|---|
| **A · ordini aperti** | `polymarket-maker-audit.jsonl`, `manual-list` con `requested.marketId = null` → `response.count` | **osservazione diretta** | 09/08 07:19 → 13/08 09:45 (**4,1 giorni**), 7.860 campioni | mediana **60,0 s**, q99 65,3 s |
| **B · mercati coperti** | stesso giornale, `auto-reprice` → `observed.esposizioneOrdiniUsd` per mercato | ricostruzione per mercato | 09/08 → 13/08, **225 finestre** da 5 min | 5 min, copertura **19%** delle finestre |
| **C · nozionale a book** | come B, somma delle esposizioni | ricostruzione per mercato | come B | come B |
| **D · PnL** | log pm2 `agent43-guardian`, riga «ok — PnL …» | **osservazione diretta** | 08/08 09:15 → 13/08 09:08 (**5,0 giorni**), 7.213 campioni | **30 s** |
| E · nascite ordini | `execution-audit.jsonl`, `kind=intent` | solo nascite | 26/07 → 13/08 (**18 giorni**), 3.479 | evento |

**Non ricostruibile, e non l'ho inventato.** Il ciclo di vita ordine-per-ordine su tutti i 18 giorni:
**651 righe `manual-cancel/ok` non portano `orderId`** (solo `order-vanished` lo porta). Sommare nascite
e sottrarre le morti note produrrebbe una serie che deriva verso l'alto in modo sistematico. Per questo
la serie A è un'osservazione diretta del totale, non una somma. **B e C coprono solo il 19% delle
finestre**: `esposizioneOrdiniUsd` compare solo quando il motore viene interrogato con un'esposizione
leggibile. Sono indicative, non complete, e non vanno usate per fissare soglie.

## 2 · Distribuzione delle variazioni

**A · ordini aperti** (7.859 variazioni)

| | mediana | q75 | q90 | q95 | q99 | max |
|---|---|---|---|---|---|---|
| assoluta | 0 | 0 | 0 | 1 | 3 | **22** |
| percentuale | 0 | 0 | 14,3% | 28,6% | 100% | 340% |
| %/minuto | 0 | 0 | 17,6 | 46,4 | 175,1 | 18.462 |

**B · mercati coperti**: assoluta mediana 0 · q90 2 · max 6. **C · nozionale**: assoluta mediana $11,37 ·
q90 $47,37 · max $110,44; percentuale mediana 14,4% · q90 94,6% · max 282,8%.

**Il criterio di separazione fisiologico/anomalo**, ricostruibile dai dati e non a occhio: un episodio è
**vero positivo** se contiene uno scatto del guardiano (±15 min) **oppure** se il livello resta ≤ 2
ordini per ≥ 30 minuti. Tutto il resto è falso positivo. Entrambe le condizioni sono leggibili dai
giornali senza giudizio umano.

## 3 · Episodi di collasso (calo > 50% dal massimo delle ultime 10 min)

**25 episodi in 4,1 giorni.** I cinque che il criterio classifica come veri:

| istante | prima → dopo | calo | durata vuoto | causa |
|---|---|---|---|---|
| 09/08 12:23:08 | 7 → 0 | −100% | 527 min | vuoto prolungato |
| **09/08 21:46:41** | **9 → 0** | **−100%** | 152 min | **primo scatto guardiano** (−$39,97 / −6,05%) |
| 10/08 06:01:18 | 7 → 0 | −100% | 3.590 min | vuoto prolungato (2,5 giorni) |
| 13/08 04:43:24 | 5 → 0 | −100% | — | vuoto |
| **13/08 09:09:16** | **28 → 2** | **−92,9%** | 35,8 min (aperto) | **secondo scatto guardiano** (−$36,15 / −5,47%) |

**I due scatti hanno la STESSA firma**: caduta in **un solo campione**, senza decadimento precedente,
prodotta da una cancellazione esterna al processo che osserva. Differiscono solo nel residuo — 0 contro
2 — perché il 13 agosto agent40 ha ripiazzato subito due ordini di chiusura, che FERMA non blocca.

## 4 · La soglia sulla derivata

**Forma scelta: calo percentuale rispetto al massimo delle ultime 10 minuti**, non variazione fra
campioni consecutivi. Motivo misurato: la cadenza è irregolare (60,0 s mediani ma fino a 77 s), quindi
la differenza campione-a-campione mescola «quanto è cambiato» con «quanto tempo è passato»; il calo dal
massimo recente è invariante rispetto al campionamento e non si spezza quando il crollo arriva in due
campioni.

| soglia di calo | episodi | veri positivi | falsi positivi | precisione |
|---|---|---|---|---|
| 30% | 188 | 5 | 183 | 3% |
| 40% | 74 | 5 | 69 | 7% |
| **50%** | **25** | **5** | **20** | **20%** |
| 60% | 9 | 5 | 4 | 56% |
| 70% | 7 | 5 | 2 | 71% |
| **80%** | **5** | **5** | **0** | **100%** |

Il livello minimo richiesto **non è la dimensione che discrimina** (a calo 50% la precisione resta
20-22% per ogni livello fra 3 e 12).

**La soglia proposta è 85%**, e non 80%, perché **il divario fra le due popolazioni è VUOTO**:
il calo fisiologico più grande misurato è **75%** (30 → 8 il 13/08 08:31, rientrato da solo in 9,5 min;
e 28 → 7 il 13/08 00:48), il calo patologico più piccolo è **92,9%**. Fra 75% e 92,9% non cade nessun
episodio, quindi **85% è il punto medio del vuoto** ed è la scelta più robusta a piccole variazioni
future. A 80% la precisione è già 100%, ma il margine verso il fisiologico è di soli 5 punti.

**⚠ Il limite di confidenza, dichiarato: 5 soli eventi positivi in 4,1 giorni.** La soglia è difendibile
sui dati esistenti ma poggia su un campione piccolo. Serve una finestra più lunga per stringerla.

## 5 · La causa del collasso 23 → 2

**Attribuzione, non conteggio.** Il livello di ordini è **stabile fra 21 e 28 fino alle 09:08:12**
(ultimo campione prima dello scatto: **23**), poi **2 alle 09:09:16**. Il crollo cade interamente nei
64 secondi che contengono l'azione del guardiano delle 09:08:33,816.

| finestra | cancellazioni | famiglia dominante |
|---|---|---|
| 09:00:00 → 09:08:33 (**prima**) | 121 | **99 `order-vanished/cancelled-by-system`** — il ciclo cancella-e-ripiazza di agent40, ogni cancellazione seguita da un rimpiazzo: **il livello non scende** |
| 09:08:33 → 09:12:00 (**dopo**) | 36 | **21 `order-vanished/cancelled-externally`** — «sparito senza che lo cancellassi io», che è la firma del `cancel-all` del guardiano; il referto ne dichiara **23** |

**Risposta: il calo NON era in corso prima. Il collasso è stato prodotto interamente dal guardiano.**
Nota di metodo: il campo `source` di quelle righe vale `auto-reprice-band-exit` perché nomina il
processo che **osserva**, non chi agisce; l'attore si legge dall'`outcome` — `cancelled-externally`
significa esattamente «non l'ho cancellato io».

## 6 · Copertura e PnL — nessuna relazione

Serie A e serie D allineate su griglia di 5 minuti, **460 punti**:

- variazione di PnL per ora **quando coperto** (ordini ≥ mediana): **−$0,255/h** (246 campioni)
- variazione di PnL per ora **quando scoperto** (ordini ≤ q25): **+$0,208/h** (212 campioni)
- **correlazione di Pearson fra livello di copertura e variazione di PnL successiva: −0,048**

**Le perdite non maturano perché il book è scoperto.** La correlazione è nulla e il segno è
leggermente opposto all'ipotesi. Incrociato con le scoperture della sessione precedente (oltre 30 min:
13 episodi, 62,6 h, $130,40), la scopertura è **una conseguenza dello stato del libro, non la causa
della perdita**.

## 7 · Il fatto nuovo: su quale misura ha deciso il guardiano

Distribuzione dei salti di PnL a 30 secondi (**7.211 campioni, 5 giorni**):

| | mediana | q75 | q90 | q95 | q99 | max |
|---|---|---|---|---|---|---|
| \|ΔPnL\| in 30 s | $0,00 | $0,00 | $0,02 | $0,12 | $1,18 | **$74,47** |

**32 salti oltre $10, 12 oltre $20, 7 oltre $30** — contro una soglia assoluta del guardiano di **$30**.
I più grandi arrivano **in coppie che si annullano**: +$74,47 alle 09/08 11:59:11 e −$73,12 trenta
secondi dopo; +$74,47 alle 14:42:30 e −$72,32 trenta secondi dopo.

**Il minuto e mezzo che ha fatto scattare il latch:**

```
09:04:32   −$1,66
09:05:03  −$26,46   ← salto di −$24,80 in 30 s
09:05:33   −$1,37   ← rientrato per intero, +$25,09, e il guardiano NON scatta (sotto i $30)
09:06:33   −$1,89
09:07:33   +$8,06
09:08:03   −$4,70
09:08:33  −$36,15   ← SCATTO
```

**Lettura on-chain di controllo, 37 minuti dopo lo scatto**: saldo $518,39 + 16 posizioni per $135,40 =
**$653,79** contro baseline $660,56, cioè **−$6,77 (−1,02%)**. Il latch è stato preso su −$36,15.

**Conclusione: circa $29 dei $36 erano transitori.** Un transitorio della stessa famiglia era rientrato
da solo tre minuti e mezzo prima; quello successivo ha superato $30 di poco e ha latchato.

Il confronto in `lib/maker/guardian-perdite.js:121-128` è **istantaneo**: una sola lettura oltre soglia
fa scattare il latch. Non esiste nessuna richiesta di **persistenza** (N letture consecutive) né alcun
filtro sulla variazione fra letture. Con un segnale il cui rumore a 30 s tocca ±$74, una soglia
single-sample a $30 è destinata a scattare su rumore.

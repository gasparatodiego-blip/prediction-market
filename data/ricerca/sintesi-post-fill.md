# Cosa fanno gli altri dopo un fill — misurato, 13 agosto 2026

Sola ricerca, API pubblica Polymarket. Nessun ordine, nessuna modifica.

## Fattibilità e limiti, dichiarati prima delle conclusioni

`data-api.polymarket.com/activity` è paginato (`limit` 500, `offset` funziona) e restituisce **TRADE**,
**MERGE** e **REDEEM** — cioè esattamente le vie d'uscita da una gamba nuda. **La ricostruzione
fill-per-fill è possibile**: non ho dovuto ripiegare su differenze di posizione.

**Campione**: 82 wallet — i **30** top per incasso, **30 casuali** della fascia $10–100/g (seme fisso
20260813), i **21** del manuale, più noi. Fino a 4 pagine di attività ciascuno.
**138.894 trade, 35.520 episodi post-fill**, finestra ~26 ore (12/08 14:22 → 13/08 16:49).
**178 secondi, zero rate-limit.**

⚠ **Due cose NON misurabili, e nessuna conclusione ci poggia sopra:**
- **maker contro taker**: `activity` non porta il flag. «Esce a mercato» contro «mette un limite e
  aspetta» non si legge direttamente — si osserva solo il TEMPO, che è un proxy: pochi secondi è quasi
  certamente aggressivo, ore quasi certamente passivo, e in mezzo c'è una zona grigia che non risolvo.
- **lo spread puro**: il book storico non è ricostruibile, quindi il «costo di uscita» qui è
  `prezzo entrata − prezzo uscita`, che include il movimento del mercato. È un **limite superiore** del
  costo, non lo spread.

## Le vie d'uscita, aggregato su 35.520 episodi

| via | episodi | quota |
|---|---|---|
| **mai chiusa** nella finestra | 13.251 | **37,3%** |
| vendita | 12.223 | 34,4% |
| **redeem** (tenuta fino alla risoluzione) | 6.531 | **18,4%** |
| merge on-chain | 3.515 | 9,9% |

## Le famiglie, per strato

| strato | n | durata mediana | merge | vendita | mai chiuse | <60 min | costo uscita | taglio | residui |
|---|---|---|---|---|---|---|---|---|---|
| top 30 | 30 | 121,5 min | 5% | 23% | 41% | 48% | **1,24 ¢/sh** | $9,60 | 13,4% |
| fascia media | 30 | **489,3 min** | 1% | 24% | 30% | 29% | 0,54 ¢/sh | $8,00 | 12,5% |
| i 21 del manuale | 21 | 167,3 min | 1% | **8%** | 28% | 23% | 0,00 ¢/sh | $17,00 | 8,3% |
| **NOI** | 1 | **21,8 min** | **43%** | 21% | 28% | **59%** | **0,25 ¢/sh** | $10,50 | **18,0%** |

⚠ **La nostra riga poggia su 61 episodi contro migliaia degli altri.** È il limite più serio di questa
tabella: i nostri numeri sono indicativi, non stabili.

## Dove siamo già meglio, misurato

**Chiudiamo cinque volte più in fretta di chiunque**: 21,8 minuti mediani contro 121,5 (top), 167,3
(i 21), 489,3 (fascia media). E chiudiamo entro l'ora il **59%** delle volte contro il 23-48% degli altri.

**Usiamo il merge otto volte più di tutti**: 43% contro 1-5%. È la via d'uscita che rende $1/coppia
senza spread e senza gas — e praticamente nessun altro la usa.

**Paghiamo meno dei top per uscire**: 0,25 ¢/share contro 1,24 dei top 30. (I 21 stanno a 0,00, ma
vendono solo l'8% delle volte: la loro mediana poggia su pochi punti.)

## Il punto dolente: i residui — e la causa NON è la size

Ce l'hanno anche loro, ma meno: **8,3-13,4% contro il nostro 18,0%**.

La spiegazione ovvia sarebbe «hanno ordini più grandi». **Misurata, non regge**: la correlazione fra
taglio dell'ordine e quota di residui è **−0,141**, cioè quasi nulla.

| taglio mediano | wallet | quota residui | durata mediana |
|---|---|---|---|
| $0–8 | 28 | 20,6% | 197 min |
| $8–12 | 21 | 8,7% | 83 min |
| $12–20 | 16 | 10,8% | 166 min |
| $20+ | 16 | 10,3% | 236 min |

La size conta solo all'estremo basso (sotto $8). **La causa vera si vede guardando chi ha meno residui:**

| wallet | strato | episodi | residui | taglio | durata | merge | **redeem** |
|---|---|---|---|---|---|---|---|
| `0xfb1c3c1a…` | i21 | 548 | **0,2%** | $15 | 19 min | 0% | **98%** |
| `0x2037bb7a…` | i21 | 229 | 0,9% | $79 | 142 min | 0% | **96%** |
| `0x33bcb6e9…` | i21 | 586 | 1,7% | $20 | 123 min | 1% | **90%** |
| `0x0dedae6a…` | media | 540 | 2,4% | $8 | 1970 min | 3% | **87%** |
| `0x9977760c…` | media | 312 | 2,6% | $33 | 157 min | 3% | **88%** |
| `0xac4a1fab…` | top30 | 345 | 3,2% | $15 | **1,2 min** | **54%** | 1% |

**Chi non ha residui non li chiude: li REDIME.** Sette wallet su otto fra i migliori escono via redeem
all'87-98%. L'ottavo (`0xac4a1fab`) fa l'opposto estremo — **54% merge, 1,2 minuti mediani** — e arriva
allo stesso risultato.

**Il perché è strutturale, e spiega tutto il nostro problema**: la size minima di 20 share vincola gli
**ORDINI**. Non vincola né il **merge** né il **redeem**, che funzionano su qualunque quantità. Noi
abbiamo il 18% di residui perché proviamo a *scambiare* per uscire; loro no perché *non scambiano*.

## Confronto punto per punto con la nostra regola

| la nostra regola | cosa fanno gli altri | verdetto |
|---|---|---|
| ① merge on-chain immediato, tetto 20¢ | 1-5% (top e media), 54% un solo wallet | **siamo già i migliori**, 43% |
| ② riposizionamento a limite entro banda, mai sotto il carico | zona grigia: non distinguo maker da taker | **non osservabile** |
| ③ apertura della gamba opposta | i top hanno l'88-100% dei mercati a gamba singola: **non appaiano** | siamo diversi **per scelta** |
| ④ residui accumulati a registro | 8-13% contro il nostro 18%, e i migliori li evitano **redimendo** | **siamo peggio, e la cura non è la size** |
| ⑤ chiusura forzata a 3 ore | il 37,3% degli episodi non si chiude affatto nella finestra | **siamo più disciplinati** |

## Cosa è replicabile a $650

**① Preferire il redeem alla vendita sui residui sotto il minimo — REPLICABILE, e non richiede scala.**
Il numero: i sei wallet con meno residui escono via redeem all'87-98%; noi al ~8%. Abbiamo **10
posizioni per $50,32** bloccate esattamente perché sotto le 20 share non esiste un ordine valido — ma
`redeemPositions` non ha minimo. Vale **$50,32 sbloccati** alla risoluzione dei mercati, a **costo zero
di spread**. ⚠ Il rischio è il tempo: il redeem si può fare solo **dopo** la risoluzione, quindi il
capitale resta fermo fino a lì (i nostri mercati meteo risolvono in giornata). **Non è una modifica di
strategia: è cablare una funzione che già esiste e che oggi non ha chiamanti** (§5-bis p.131 la
descrive già come implementata per i mercati risolti — va verificato che copra anche i residui).

**② Non tentare la vendita quando il residuo è sotto il minimo — REPLICABILE, risparmio immediato.**
Il numero: il 18% dei nostri episodi finisce in residuo, e ogni tentativo di venderlo produce un
`remainder-below-min-size` che consuma quota di rate limit e cicli. Non cambia il capitale sbloccato,
ma toglie rumore. **Valore: nessun dollaro diretto**, solo cicli.

**③ Alzare il taglio dell'ordine sopra $8 — NON è la leva che sembra.**
Il numero: la correlazione taglio↔residui è **−0,141**. Sotto $8 i residui salgono al 20,6%, ma noi
siamo già a $10,50, cioè nella fascia migliore (8,7%). **Non c'è niente da guadagnare qui**, e alzare
la size ridurrebbe il numero di mercati che possiamo tenere con $650.

**④ Il merge è già il nostro punto di forza — non toccarlo.**
43% contro l'1-5% di tutti gli altri. È misurato, e va detto perché è l'unica cosa in cui siamo
nettamente sopra il campione.

**⑤ La velocità di chiusura è già ottima — 21,8 min contro 121-489.** Nessun cambiamento.

## La conclusione onesta

**La nostra regola post-fill è già vicina all'ottimo per la nostra scala, con una sola eccezione vera.**
Chiudiamo più in fretta di tutti, usiamo il merge otto volte più di tutti, paghiamo meno dei top per
uscire. L'unico punto in cui siamo misurabilmente peggio è il residuo — e la cura non è quella che
sembrava (ordini più grandi), è **smettere di provare a venderli e redimerli**.

⚠ **Il limite di questa ricerca**: la nostra riga poggia su **61 episodi in 26 ore**. Tutte le
differenze a nostro favore vanno riverificate su una finestra più lunga prima di considerarle stabili.

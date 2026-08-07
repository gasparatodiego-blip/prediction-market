# Indagine: `offsetCents` contro `computedDefaultOffsetTicks`

Seguito della [indagine sui mercati ricchi](indagine-mercati-ricchi.md), la cui proposta n° 2 era
«guardare il disallineamento fra `offsetCents` e `computedDefaultOffsetTicks`». Sola lettura sul
codice e sui piani calcolati dal vivo. **Nessun ordine.**

---

## 1 · Il disallineamento non esiste. Avevo letto male io.

`allocator.js:310`, sopra il calcolo di `defaultOffsetTicks`, dice testualmente:

> **NON è l'offset con cui si piazza: quello è `computedDefaultOffsetTicks`, calcolato più sotto.**

Il campo `offsetCents` di una riga è l'offset con cui il **knapsack l'ha classificata**
(`defaultOffsetTicks * scoringTick * 100`), non quello a cui si quota. E il percorso di piazzamento
usa l'altro:

```
lib/rewards/plan-to-orders.js:292   const c = rowAt(r, r.computedDefaultOffsetTicks);
lib/rewards/plan-to-orders.js:310   const g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks);
```

Lo stesso campo che il totale legge (`allocator.js:429`). **Totale e piazzamento sono allineati.** La
proposta n° 2 dell'indagine precedente era sbagliata: nasceva dall'aver preso `offsetCents` per
l'offset operativo.

---

## 2 · Il problema vero: due ottimizzatori in disaccordo, e piazza quello cieco

Questo il codice lo sa già, e lo scrive (`allocator.js:357`):

> `computedDefaultOffsetTicks` is chosen against the S=1 CEILING gross, which is flat inside the band —
> so the optimiser can push the quote outward to dodge fills at zero modelled reward cost. Under the
> real quadratic that is not free at all.

### La meccanica, in quattro righe

`computedDefaultOffset` (`allocator.js:124`) sceglie così:

```
net(tick)  = grossInBand − costPerDay(tick)      // grossInBand è COSTANTE dentro la banda
maxNet     = max(net)
eps        = max($0.02, 2% di grossInBand)        // «plateau» del netto
scelto     = il tick più PICCOLO con net ≥ maxNet − eps
```

Poiché `grossInBand` non dipende dal tick, **massimizzare il netto equivale a minimizzare il costo di
adverse selection**, cioè a prendere meno fill possibile. Il costo scende monotonicamente allontanandosi
dal mid, quindi l'ottimo sta sempre verso l'esterno. Il crollo del punteggio di posizione non entra nel
conto: per questa funzione spostarsi in fuori è **gratis**.

Il modello realistico applica invece la formula pubblicata S = ((v−s)/v)². Su banda 4,5¢ (v = 2,25):

| offset | S | quota del punteggio |
|---|---|---|
| 1¢ | 0,309 | 31% |
| 2¢ | **0,012** | **1,2%** |

### Le due righe divergenti, per intero

Piano da $60.000 (capitale finto, solo per avere molte righe).

**Riga A — capitale $4.800, tick 0,01, banda 4,5¢, lordo in banda $22,33/g**

| tick | offset | fill | costPerDay | netto = lordo − costo | **realistico** |
|---|---|---|---|---|---|
| 0 | 0,00¢ | 178 | $20,18 | $2,15 | $0,00 |
| **1** | 1,00¢ | 39 | $0,97 | $21,36 | **$6,16** |
| **2** ← scelto | 2,00¢ | 1 | $0,00 | $22,33 | **$0,30** |
| 3 | 3,00¢ | 0 | $0,00 | $22,33 | $0,00 |

`eps` = 2% × 22,33 = **$0,45**. La soglia del plateau è 22,33 − 0,45 = **$21,88**, e il tick 1 sta a
**$21,36**: lo manca per **52 centesimi**. Viene escluso, e la scelta cade sul tick 2.

**Per risparmiare $0,97/giorno di costo misurato, il piano rinuncia a $5,86/giorno di punteggio.**

**Riga B — capitale $1.200, tick 0,01, banda 4,5¢, lordo $16,06/g**

| tick | offset | fill | costPerDay | netto | **realistico** |
|---|---|---|---|---|---|
| 0 | 0,00¢ | 4 | $1,26 | $14,80 | $12,16 |
| **1** | 1,00¢ | 4 | $1,26 | $14,80 | **$6,97** |
| **2** ← scelto | 2,00¢ | 0 | $0,00 | $16,06 | **$0,43** |

**Rinuncia a $6,54/giorno per risparmiarne $1,26.**

### Quanto pesa, e dove

Misurato sulle 18 righe del piano da $60.000:

| | |
|---|---|
| righe divergenti | **2 su 18** (3 senza confronto possibile) |
| realistico perso | **$12,39/giorno** |
| totale del piano | $106,93/g → **$119,32/g** se piazzasse al tick migliore (**+12%**) |

**Tutta la divergenza è su mercati con tick 0,01**, e sempre con lo stesso schema **2,0¢ scelto contro
1,0¢ migliore**:

| tick del mercato | righe | divergenti | realistico perso |
|---|---|---|---|
| 0,001 | 3 | **0** | $0,00 |
| **0,01** | 13 | **2** | **$12,39** |
| non leggibile | 2 | 0 | $0,00 |

La ragione è aritmetica: su tick 0,001 un passo vale 0,1¢ e servono venti passi per uscire dal cuore
della banda, quindi l'ottimizzatore può spostarsi senza far danni. Su tick 0,01 **un solo passo vale
1¢**, e il secondo passo porta a 2¢ su una semibanda di 2,25¢ — cioè quasi al bordo, dove il punteggio
è l'1,2% del massimo. **Il difetto non è nella scelta del tick: è che la stessa scelta ha conseguenze
trenta volte diverse a seconda della grana del mercato, e l'ottimizzatore non la vede.**

Sul piano reale da $620 di oggi (7 righe) le divergenze sono **zero**: le righe scelte hanno quasi tutte
tick 0,001 o pochi fill. Il problema si manifesta quando entrano mercati a tick 0,01 con fill osservati
— che è esattamente ciò che il pavimento sul montepremi aveva selezionato la settimana scorsa, e il
motivo per cui allora il totale usciva $0,00.

---

## 3 · Correzione a margine: `maxCount` non limita il piano

Indagando ho verificato una cosa che avevo riportato male io stesso nella ricalibratura.

`rows` nasce da `alloc.allocation` (`allocator.js:287`), non dalla frontiera. `maxCount` entra solo in
`frontierByCount`, e il suo risultato finisce in `plan.frontier`, che è **una curva da mostrare**: il
pannello la cita, nessuno la usa per selezionare. Prova: il piano da $60.000 restituisce **18 righe**
con `maxCount` a 10.

Quindi la modifica «`maxCount` 25 → 10» del commit `0a0a845` **non limita i mercati contemporanei**:
accorcia soltanto la curva mostrata nel pannello da 25 a 10 punti. **L'ho ripristinata a 25** — non fa
quello che avevo scritto, e lasciarla toglieva informazione al grafico senza dare niente in cambio.

Il numero di mercati del piano è governato da `allocateBudget` (griglia delle size, `unitUsd`, tetto di
concentrazione), non da qui. Se si vuole davvero un tetto sui mercati contemporanei, va messo lì — ed è
una decisione separata.

---

## APPLICATO — proposta 1, e un secondo fattore che è emerso applicandola

*(aggiunto il 7 agosto 2026, su richiesta esplicita. Le proposte 2–4 restano non applicate.)*

`computedDefaultOffset` ora confronta **`S(t) × lordo − costo(t)`**. `placementScore` è importata da
`realistic-estimate.js`, non riscritta: due implementazioni della stessa formula sarebbero due opinioni
su dove conviene stare.

**Applicando la correzione è saltato fuori un secondo fattore, e senza quello la correzione era
peggio di niente su alcune righe.** Il costo di adverse selection si sottrae in **dollari**, il
punteggio **moltiplica**: se il lordo è stantio, il confronto fra i due è fuori scala. Su una riga
reale il montepremi era crollato da $36/g a $6/g (`pool-trend` ×0,165):

| tick | offset | S | lordo pieno − costo | lordo **scontato** − costo | realistico |
|---|---|---|---|---|---|
| 1 | 0,1¢ | 0,913 | $2,27 − $0,33 = **$1,94** | $0,375 − $0,33 = **$0,04** | $0,00 |
| 8 | 0,8¢ | 0,415 | $1,03 − $0,02 = $1,01 | $0,171 − $0,02 = **$0,15** | **$0,16** |

Col lordo pieno la funzione sceglieva il tick stretto **proprio dove il montepremi non c'è più**. Ora
applica anche lo sconto del trend — tick-indipendente, quindi non cambia la forma della curva, cambia
il peso relativo del costo. Il motivo della riga lo dichiara: `«lordo pesato dal punteggio e scontato
dal trend (×0.165) − markout misurato»`.

**Cosa NON è incluso**: il cap `thin-book` del modello realistico (scatta oltre il 60% di quota
modellata). È anch'esso tick-indipendente e moltiplicativo, quindi in linea di principio può spostare
la scelta allo stesso modo del trend; non l'ho aggiunto perché richiederebbe di duplicare qui l'algebra
delle share e la costante `maxCredibleShare`. Sulle righe dove morde, il pannello mostra già la
bandiera «mercato molto sottile».

**Esito misurato**, subito dopo la modifica:

| piano | righe | realistico | divergenze con `realisticBest` | tick scelti |
|---|---|---|---|---|
| $620 | 8 | $9,44/g | **0** (era 0) | 1×7, **8×1** |
| $60.000 | 20 | $161,06/g | **0** (erano 2, −$12,39/g) | 1×20 |

I totali assoluti non sono confrontabili fra i giri — il board si aggiorna ogni 15 minuti e in un'ora
è passato da $4,85 a $161 a capitali diversi. **Quello che è confrontabile è il numero di divergenze:
zero su entrambi i piani.** E la riga a 8 tick nel piano da $620 è la prova che la correzione non
degenera in «sempre il tick più stretto»: dove il montepremi è crollato, allarga.

30 assertion in `selfcheckOffset`, incluse le due righe reali di questa indagine e i quattro casi del
trend. `agent41` e `dashboard` riavviati.

---

## Proposte — le restanti, non applicate

**1 · ~~Far pagare a `computedDefaultOffset` il punteggio che sta buttando via.~~ FATTO, sopra.** Oggi confronta
`gross − costo` con un gross piatto. Il confronto onesto è `S(tick) × gross − costo(tick)`: la stessa
funzione, con il lordo pesato dal punteggio pubblicato. Sulle due righe qui sopra sceglierebbe il tick 1
in entrambi i casi. È la correzione più piccola possibile e usa una formula che il repo già implementa
(`realistic-estimate.placementScore`).

**Attenzione al verso del rischio**: il tick 1 prende **39 fill** contro 1 sulla riga A. Più punteggio
significa più esecuzioni, quindi più adverse selection *reale* — non solo quella misurata. Il modello
dice che conviene ($6,16 contro $0,30 già al netto del costo misurato), ma il costo misurato viene da un
nastro di 48 ore e non è una garanzia.

**2 · In alternativa, e a costo zero: usare `realisticBestTick` dove esiste.** Il campo è già calcolato
per ogni riga proprio per «esporre il disaccordo invece di ereditare un offset scelto da un modello che
non lo sente» (parole del codice). Oggi nessuno lo legge. Farlo leggere a `plan-to-orders` sarebbe una
riga, ma cambierebbe dove si piazza davvero: è una decisione operativa, non una pulizia.

**3 · Non toccare la regola `eps`.** La riga A manca il plateau per 52 centesimi: allargare `eps`
farebbe scegliere il tick 1 su quel caso e nasconderebbe la causa vera, che è il lordo piatto. Sarebbe
la cura giusta per il sintomo sbagliato.

**4 · Se si tocca qualcosa, misurarlo su uno snapshot congelato.** Il board si aggiorna ogni 15 minuti
e i totali si spostano fra un giro e l'altro ($4,85 → $7,01 → $106,93 a capitali diversi in un'ora). È
lo stesso errore in cui sono caduto con il pavimento sul montepremi.

---

## Limiti di metodo

1. **Due righe divergenti su 18.** Il campione è piccolo; il $12,39/g e il +12% valgono per quel piano
   in quell'istante, non sono una costante.
2. **Il capitale da $60.000 è finto**, serviva solo a far entrare più righe. Con $620 le righe sono 7 e
   le divergenze zero: il problema è latente oggi, non attivo.
3. **`costPerDay` viene dal nastro di 48 ore.** Dove i fill osservati sono pochi (1 fill al tick 2 della
   riga A) il costo misurato è quasi un'assenza di dati travestita da zero.
4. **Il confronto «realistico al tick scelto contro al tick migliore» usa il nostro stesso modello di
   realismo** su entrambi i lati. Se quel modello sbaglia, sbaglia in modo correlato e il $12,39 non è
   un guadagno che si incassa: è una discrepanza interna fra due nostre stime.
5. **Non ho verificato** se il pannello permetta all'operatore di sovrascrivere l'offset a mano prima di
   piazzare. Se lo permette, la gravità cambia: sarebbe un default sbagliato, non una scelta imposta.

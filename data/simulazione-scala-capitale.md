# Simulazione della scala di capitale — la curva rendimento/capitale del pianificatore

**Data della fotografia: 8 agosto 2026, 20:10–20:45 UTC.**
**SOLA SIMULAZIONE.** Nessun ordine inviato, nessun contatto col venue per piazzare, nessuna scrittura
sullo stato operativo del bot, nessuna modifica a codice, a schema Prisma o al database. L'unico file
creato da questo lavoro è questo report. Il KILL dell'8 agosto (17:20:17Z) è rimasto attivo per tutta la
durata del lavoro e non è stato toccato.

---

## 1 · Che cosa è stato calcolato, e con che cosa

Il piano è stato calcolato **con la stessa funzione che gira in produzione**, non con una copia:

```
require('/root/prediction-market/lib/rewards/allocator').planFromCollection({
  capital, maxPerMarketUsd: capital * 0.20, horizonFilter: true
})
```

È letteralmente il `RUNNER_PIANO` di `agents/agent41-realloc-scheduler.js:225` — la stessa riga che il
riallocatore periodico esegue in un processo figlio a ogni ciclo, e la stessa strada che il pannello
«Ottimizza» percorre via `/api/rewards/allocate`. Ogni livello di capitale è girato in un processo node
nuovo che nasce, calcola, stampa e muore (il piano porta il processo a ~690 MB: il figlio evita che
restino in memoria).

**Le regole erano tutte quelle vere, nessuna disattivata:**

| regola | valore in questa simulazione | dove vive |
|---|---|---|
| tetto di concentrazione per mercato | **20% del capitale** (`CONCENTRATION_CAP_FRAC`) | `lib/rewards/concentration.js` |
| muro dell'orizzonte | **150 giorni**, rifiuto secco | `lib/rewards/horizon.js:131` |
| quota coda lunga (oltre 7 giorni) | **12% del capitale** | `lib/rewards/horizon.js:148` |
| tetto di credibilità della quota | **`maxCredibleShare = 0,60`**, dentro l'obiettivo del knapsack | `lib/rewards/realistic-estimate.js:73` |
| tetto sui book vuoti verificati | **30% del lordo pesato** | `lib/rewards/allocator.js:457` |
| punteggio di posizione nella selezione | attivo | `usePlacementScore: true` |
| profondità verificata | attiva | `usaProfonditaVerificata: true` |
| pavimento sul montepremi | **spento** (`PAVIMENTO_ATTIVO = false`) — com'è in produzione | `lib/rewards/montepremi-minimo.js:64` |

**La cifra riportata come «reward» è sempre la stima REALISTICA**, cioè `totals.realisticPerDay`: il
lordo già corretto per punteggio di posizione reale, thin-book/`maxCredibleShare`, adverse selection al
25% e finestre fuori dal book. Il lordo è riportato **accanto**, mai al posto — su questa scala il
rapporto realistico/lordo sta stabilmente fra **0,375 e 0,42**.

**Il board di partenza**: `data/liquidity-rewards.json` scritto da agent24 alle **20:10:20Z**, 111 mercati
con montepremi, montepremi complessivo del board **$5.821/giorno**. Di questi, **101 sono valutabili**
(hanno storico prezzi sufficiente) e **8 vengono respinti dal muro dei 150 giorni**. Finestra di storico:
**47,97 ore** di journal + tape. Saldo reale letto on-chain nello stesso momento, in sola lettura:
**$668,25** — il livello «$660» della serie è quindi a tutti gli effetti il capitale attuale.

---

## 2 · La tabella: capitale → reward → mercati → rendimento marginale

`marginale` = dollari di reward realistico al giorno guadagnati per **ogni dollaro aggiuntivo** di
capitale rispetto al livello precedente. È la colonna che risponde alla domanda.

| capitale | tetto/mercato | impiegato | fermo | % impiegata | mercati | lordo $/g | **realistico $/g** | APY realistico | **marginale $/g per $** | variazione del marginale |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| $50 | $10 | $0 | **$50** | **0%** | **0** | 0,0 | **0,00** | — | — | — |
| $60 | $12 | $0 | **$60** | **0%** | **0** | 0,0 | **0,00** | — | 0,00000 | — |
| $75 | $15 | $0 | **$75** | **0%** | **0** | 0,0 | **0,00** | — | 0,00000 | — |
| $100 | $20 | $100 | $0 | 100% | 5 | 49,8 | **14,44** | >200%/anno | 0,57751 | — |
| $150 | $30 | $150 | $0 | 100% | 6 | 71,2 | **24,01** | >200%/anno | 0,19137 | −66,9% |
| $190 | $38 | $188 | $2 | 98,9% | 6 | 80,0 | **28,16** | >200%/anno | 0,10385 | −45,7% |
| $200 | $40 | $200 | $0 | 100% | 6 | 86,0 | **31,89** | >200%/anno | 0,37326 | +259% ⚠︎ |
| $250 | $50 | $250 | $0 | 100% | 7 | 114,0 | **42,80** | >200%/anno | 0,21810 | −41,6% |
| $350 | $70 | $350 | $0 | 100% | 9 | 181,0 | **50,85** | >200%/anno | 0,08052 | −63,1% |
| $500 | $100 | $500 | $0 | 100% | 8 | 208,8 | **64,44** | >200%/anno | 0,09062 | +12,6% ⚠︎ |
| **$660** (attuale) | $132 | $650 | $10 | 98,5% | 8 | 231,5 | **74,52** | >200%/anno | 0,06301 | −30,5% |
| $1.000 | $200 | $1.000 | $0 | 100% | 11 | 290,3 | **100,01** | >200%/anno | 0,07496 | +19,0% ⚠︎ |
| $1.500 | $300 | $1.500 | $0 | 100% | 13 | 369,4 | **125,80** | >200%/anno | 0,05158 | −31,2% |
| **$2.000** | $400 | $2.000 | $0 | 100% | 18 | 415,8 | **141,44** | >200%/anno | **0,03127** | **−39,4%** ← calo più marcato |
| $3.000 | $600 | $3.000 | $0 | 100% | 21 | 500,8 | **171,34** | >200%/anno | 0,02990 | −4,4% |
| $5.000 | $1.000 | $5.000 | $0 | 100% | 25 | 629,0 | **219,70** | >200%/anno | 0,02418 | −19,1% |
| $7.500 | $1.500 | $7.500 | $0 | 100% | 32 | 757,3 | **270,59** | >200%/anno | 0,02036 | −15,8% |
| $10.000 | $2.000 | $10.000 | $0 | 100% | 34 | 866,1 | **320,02** | >200%/anno | 0,01977 | −2,9% |
| $15.000 | $3.000 | $15.000 | $0 | 100% | 40 | 1.040,3 | **402,07** | >200%/anno | 0,01641 | −17,0% |
| $20.000 | $4.000 | $20.000 | $0 | 100% | 43 | 1.164,4 | **455,27** | >200%/anno | **0,01064** | **−35,1%** ← secondo calo |
| $30.000 | $6.000 | $30.000 | $0 | 100% | 49 | 1.389,1 | **545,09** | >200%/anno | 0,00898 | −15,6% |

**La colonna APY è volutamente cappata a «>200%/anno · run-rate, non garantito»**, come fa il
pianificatore stesso (`APY_CAP = 200` in `lib/rewards/allocator.js:963`, che restituisce
`annualisedRealistic.capped: true` a ogni livello di questa tabella). Il $/giorno è la metrica
primaria; l'annualizzato non è una previsione. **Il calo del rendimento con la scala non si legge
sull'APY ma sulla colonna del marginale e sull'elasticità di §4** — che sono relativi e quindi immuni
sia al cap sia all'assurdità della cifra annualizzata.

⚠︎ **I tre rimbalzi positivi del marginale ($200, $500, $1.000) sono un artefatto noto, non un segnale.**
La griglia delle size del knapsack ha passo `unitUsd = max(2, round(capitale/50))`: cambia con il
capitale, quindi due livelli vicini non hanno la stessa granularità e il marginale punto-a-punto ne
risente. Per questo la sezione 4 legge la curva con l'**elasticità**, che di quell'artefatto non
risente. La forma complessiva è monotona decrescente; i rimbalzi sono rumore di quantizzazione.

**Il marginale crolla di 64 volte** lungo la scala: da **$0,578** di reward al giorno per dollaro a $100,
a **$0,0090** a $30.000.

---

## 3 · Il capitale resta fermo? No — sopra $100 viene impiegato tutto

Questa è la risposta più netta della simulazione, e non è quella che ci si aspettava:

> **Fino a $30.000 il pianificatore NON lascia mai capitale forzatamente fermo per mancanza di
> mercati validi. La percentuale impiegata è 100% a ogni livello sopra i $100** — le uniche eccezioni
> sono briciole di quantizzazione ($10 su $660, $2 su $190: il residuo che non riempie una unità della
> griglia).

Il board **assorbe** il capitale. Quello che non fa è **remunerarlo allo stesso tasso**.

**Ma sotto c'è un pavimento vero, e taglia netto:**

| capitale | esito |
|---|---|
| $50 · $60 · $75 | **piano VUOTO. Zero mercati, 100% del capitale fermo.** 93-94 mercati esclusi perché la size che quel capitale compra sta **sotto la `min_incentive_size` del venue** — sotto quella soglia il venue non assegna punteggio, quindi il rendimento di quella riga è zero per costruzione. |
| $100 | primo piano non vuoto: 5 mercati, 22 mercati ancora sotto la size minima |
| $1.000 | **zero** mercati esclusi per size minima: da qui in poi il vincolo sparisce |

**Il capitale minimo utile su questo board sta fra $75 e $100.** Sotto, il sistema non è «poco
efficiente»: è **fermo**, e sarebbe fermo anche senza kill.

---

## 4 · Dove comincia il rendimento decrescente — l'elasticità

Il marginale punto-a-punto è rumoroso per l'artefatto della griglia. La misura pulita è l'**elasticità**
del reward al capitale, `b = ln(R₂/R₁) / ln(C₂/C₁)`:

* **b = 1** → rendimento proporzionale (raddoppio il capitale, raddoppio il reward)
* **b = 0,5** → legge di radice quadrata (raddoppio il capitale, il reward cresce del 41%)
* **b < 1** → rendimenti decrescenti

| segmento | elasticità b | lettura |
|---|---:|---|
| **$100 → $660** | **0,870** | quasi proporzionale — il capitale entra su mercati non ancora saturi |
| **$660 → $2.000** | **0,578** | **il ginocchio: qui la curva si piega** |
| **$2.000 → $10.000** | **0,507** | radice quadrata pura |
| **$10.000 → $30.000** | **0,485** | radice quadrata, leggermente peggio |
| $100 → $30.000 (globale) | 0,637 | |

**Il ginocchio è fra $660 e $2.000, e il passo peggiore è $1.500 → $2.000** (elasticità 0,407, marginale
−39,4%). Sotto $660 il sistema è ancora in regime quasi proporzionale; sopra $2.000 è stabilmente in
regime di radice quadrata e non peggiora più molto — **non c'è un secondo crollo, c'è un altopiano
inclinato.** Il secondo calo visibile del marginale ($15.000 → $20.000, −35,1%) non cambia il regime:
l'elasticità resta intorno a 0,44.

**Il capitale attuale ($660-668) si trova esattamente all'imbocco del ginocchio.** È il punto in cui
ogni dollaro aggiuntivo comincia a rendere sensibilmente meno del precedente.

### Perché la curva si piega: non è la scarsità di mercati, è la saturazione dentro ciascuno

Il meccanismo è misurabile riga per riga, e non è «finiscono i mercati»:

| capitale | mercati nel piano | mercati con **quota capata** al tetto di credibilità | rendimento della riga **migliore** | rendimento della riga **peggiore** |
|---:|---:|---:|---:|---:|
| $250 | 7 | 4 | 28,03%/g | 9,99%/g |
| $660 | 8 | 7 | 24,44%/g | 8,82%/g |
| $2.000 | 18 | 20 | 13,98%/g | 3,38%/g |
| $10.000 | 34 | 65 | 9,24%/g | 1,75%/g |
| $30.000 | 49 | 72 | 3,63%/g | **0,96%/g** |

Tre cose si vedono insieme:

1. **Il numero di mercati cresce, ma molto più lentamente del capitale**: ×120 di capitale ($250 →
   $30.000) contro ×7 di mercati (7 → 49). E il board ne aveva 101 valutabili: **a $30.000 il piano ne
   usa meno della metà.** I mercati non sono finiti.
2. **La quota satura dentro ogni mercato.** `share = size/(size + competitorQ)` è concava: raddoppiare
   la size non raddoppia la quota del montepremi. Il tetto di credibilità al 60% (`maxCredibleShare`)
   è la controparte esplicita: a $250 sono 4 i mercati che ci sbattono contro, a $30.000 sono **72**.
   Questo — non la mancanza di righe — è ciò che produce l'esponente 0,5.
3. **Le righe che si aggiungono sono sempre peggiori.** La riga peggiore del piano rende **9,99%/g**
   del suo capitale a $250 e **0,96%/g** a $30.000: dieci volte meno. A $30.000, **$6.000 di capitale
   (il 20% del totale) stanno nelle 10 righe peggiori**, e **$1.200 stanno in due righe che la stima
   realistica si rifiuta di accreditare** (book vuoto verificato: contributo 0,00).

C'è anche un limite di plausibilità che vale la pena scrivere: a $30.000 il piano pretende il **23,9%
del montepremi lordo dell'intero board** ($1.389 su $5.821/giorno). Non è impossibile per costruzione,
ma è una quota che presuppone di diventare il maker dominante su mezzo programma premi
contemporaneamente — e la reazione dei concorrenti a una presenza del genere **non è nel modello**.

**Nota tecnica**: `MAX_MERCATI_PIANO = 25` **non** è un tetto sul numero di mercati del piano — governa
solo la lunghezza della curva `frontier` mostrata dal pannello (`lib/rewards/allocator.js:964-975`).
Infatti i piani sopra i $5.000 contengono legittimamente 32, 34, 40, 43 e 49 righe.

---

## 5 · La domanda dei $30/giorno

> **$30/giorno di reward realistico stimato è raggiungibile con il board di oggi, e la soglia sta
> intorno a $195 di capitale.**

I punti misurati che la circondano:

| capitale | realistico $/g |
|---:|---:|
| $150 | $24,01 |
| **$190** | **$28,16** |
| **$200** | **$31,89** |
| $250 | $42,80 |

Interpolando fra $190 e $200, i $30/giorno si toccano a **~$195**.

**Il capitale attuale ($668,25) è ~3,4 volte quello che il modello richiede per $30/giorno, e il piano
a $660 stima $74,52/giorno — cioè 2,5 volte l'obiettivo.**

### E qui va detta la cosa più importante di tutto il report

**Il modello dice $74/giorno. Il venue, l'unico giorno finora confrontabile, ne ha pagati $1,30.**

`data/confronto-reward.json`, aggiornato l'8 agosto alle 08:39Z:

| giorno | stima del piano | reward realmente attribuito dal venue |
|---|---:|---:|
| 2026-08-06 | $3,09 | **$1,30** (42% della stima) |
| 2026-08-07 | $0,00 | $0,00 |

Il modulo di confronto dichiara `stato: "dati-insufficienti"` — **servono 5 giornate confrontabili per
un primo giudizio e ce n'è una sola**, e quella giornata aveva in banda $42 di capitale, non $660. Non
si può quindi concludere «il modello sbaglia di 57 volte»: si può concludere che **la sola misura
esistente sta al 42% della stima**, e che questa curva **non è mai stata validata contro consuntivi
veri a nessun livello di capitale**.

L'APY di questo piano è ben oltre il cap del 200%/anno a **ogni** livello della tabella, ed è
esattamente il tipo di cifra che va segnalata prima e non dopo: descrive un board di premi molto
generoso rispetto al capitale in gioco, **non** una previsione di cassa. La stima
«realistica» corregge sei cose dichiarate (posizione, thin-book, adverse selection al 25%, campionamento,
tempo fuori banda, quote-ceiling), e resta ottimista su tutto ciò che non modella: la **reazione della
concorrenza** al nostro ingresso, i mercati che scadono, le riprezzature, e — la voce che pesa di più —
l'adverse selection **effettiva** invece del 25% assunto.

**La lettura difendibile della sezione 5 è quindi relativa, non assoluta:** i $30/giorno sono
raggiungibili *nel modello* a ~$195, e il capitale attuale ha già margine abbondante *nel modello*. Se
il rapporto misurato del 6 agosto (42%) fosse rappresentativo — e con una sola giornata **non lo si può
affermare** — la soglia dei $30/giorno reali si sposterebbe intorno ai **$550-700**, cioè proprio dove
si è adesso. Questo è uno scenario, non una misura.

---

## 6 · Il punto in cui il board non assorbe più efficientemente

Mettendo insieme le tre risposte:

| domanda | risposta dalla simulazione |
|---|---|
| **Dove il capitale resta forzatamente fermo?** | **Solo sotto ~$100** (min size del venue). Fra $100 e $30.000 l'impiego è 100%. |
| **Dove il rendimento inizia a crescere meno che proporzionalmente?** | **Subito, ma dolcemente**: b=0,87 già fra $100 e $660. |
| **Dove il rendimento marginale crolla di più?** | **$1.500 → $2.000**: marginale da $0,0516 a $0,0313 per dollaro (−39,4%), elasticità 0,407. Il ginocchio della curva è la banda **$660 → $2.000**. |
| **Dove il sistema comincia a scegliere mercati marginali?** | **Da ~$2.000 in su**: la riga peggiore del piano scende sotto il 3,4%/giorno e il numero di mercati capati al tetto di credibilità supera quello dei mercati nel piano. |
| **Esiste un muro, un capitale oltre il quale il board non prende più niente?** | **Non entro $30.000.** Non c'è un punto di rottura: c'è una legge di radice quadrata stabile (b≈0,49) che rende ogni raddoppio di capitale sempre meno interessante senza mai rifiutarlo. |

**In pratica**, se si dovesse indicare un intervallo di capitale «efficiente» su questo board:

* **sotto $100**: inutilizzabile, piano vuoto;
* **$100 – $700**: regime quasi proporzionale, la zona migliore per dollaro;
* **$700 – $2.000**: il ginocchio, ogni dollaro rende progressivamente meno ma la crescita è ancora consistente;
* **oltre $2.000**: radice quadrata — servono ×4 di capitale per ×2 di reward. Non è irrazionale, ma **il capitale extra andrebbe giudicato contro un'alternativa**, non contro lo zero.

---

## 7 · Limiti dichiarati — leggere prima di usare questi numeri

1. **È una fotografia del board disponibile ORA** (8 agosto 2026, 20:10 UTC, 111 mercati con montepremi,
   101 valutabili). **Il numero e la qualità dei mercati candidati cambiano in continuazione**: mercati
   nuovi si aprono, altri scadono, i montepremi vengono tagliati o alzati dal venue, e la concorrenza
   in banda si sposta di ora in ora. **Questa curva è indicativa delle condizioni attuali, non una
   promessa fissa né una proprietà stabile del sistema.** Rifatta domani darebbe numeri diversi — la
   *forma* (quasi-proporzionale → ginocchio → radice quadrata) è la parte più robusta; i livelli in
   dollari sono la parte più volatile.
2. **Il reward è stimato, mai misurato.** Vale tutto quanto scritto in §5: una sola giornata di
   consuntivo esiste, ed è al 42% della stima.
3. **La reazione della concorrenza non è modellata.** `competitorQ` è la profondità in banda misurata
   *prima* del nostro ingresso. Ai livelli alti della tabella si assume implicitamente che nessuno
   reagisca a un maker che occupa un quarto del programma premi. È l'assunzione più ottimista di tutta
   la simulazione, e non è correggibile con questi dati.
4. **La finestra di storico è 48 ore** (47,97 misurate). Ogni giudizio di profondità, mid e velocità
   nasce da lì.
5. **Artefatto di quantizzazione**: `unitUsd = max(2, round(capitale/50))` rende i marginali
   punto-a-punto non perfettamente confrontabili fra livelli vicini. Usare l'elasticità (§4).
6. **Nessun costo di esecuzione è nella curva**: gas, riprezzature, capitale immobilizzato nelle coppie
   non risolte (come i $6,13 del completamento del 17:06Z) e le finestre di kill non compaiono.
   Tutti spingono il numero **verso il basso**, nessuno verso l'alto.

---

## Appendice — riproducibilità

I dati grezzi di questa simulazione (piano completo per ogni livello, riga per riga) sono in
`/tmp/claude-0/-root/ee048219-7799-4b10-8e12-daf063de1c78/scratchpad/`:
`scala-capitale-principale.json`, `scala-capitale-bassi.json`, `scala-capitale-pavimento.json`,
`tabella.json`, più il driver `scala-capitale.js`. Sono in scratchpad e **non** nel repo, di proposito:
non sono stato di produzione. Il driver non fa altro che chiamare `planFromCollection` con i parametri
della tabella di §1, un processo figlio per livello.

Ogni livello costa ~22 secondi e ~690 MB di picco nel figlio; vanno eseguiti **in sequenza** — il VPS
ha 3,8 GB e ~40 processi.

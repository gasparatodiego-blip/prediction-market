# Indagine: perché il nostro realismo crolla sui mercati ricchi

Indagine pura sui dati già raccolti per il [manuale v2](manuale-operativo-maker-v2.md) — 21 wallet,
~40.000 fill, 28.134 mercati con metadati Gamma — più la decomposizione del nostro modello di realismo
su mercati concreti del board. **Nessuna modifica al motore, nessun parametro toccato, nessun ordine.**

---

## La risposta breve

**La domanda era mal posta, e la colpa è del manuale v2.** Il «montepremi mediano $47/g» su cui poggia
tutto — il pavimento a $25, il ρ +0,34, l'idea stessa che i 21 lavorino su mercati ricchi — è calcolato
su un campione **sopravvissuto al 2%**.

Gamma **azzera `rewardsDailyRate` quando un mercato si chiude**:

| | mercati | con montepremi > 0 |
|---|---|---|
| ancora aperti | 3.947 | **63,2%** |
| chiusi | 24.187 | **2,0%** |

I 21 lavorano su mercati che si risolvono entro un giorno, quindi al momento della query sono quasi
tutti chiusi. Il montepremi che ho misurato per loro proviene dal 2% di chiusi che per qualche motivo
conserva il campo. **Il 95% della loro attività ha montepremi non misurabile, e nel manuale v2 è
entrato come «mediana $47» perché gli zeri erano esclusi dal calcolo con un filtro `if truthy`.**

Sui soli mercati **ancora aperti** — dove il montepremi si legge davvero — il quadro si rovescia:

| fascia | fill | quota | mercati | wallet | nozionale mediano |
|---|---|---|---|---|---|
| **$0 (nessun premio)** | 778 | **34,3%** | 330 | 17 | $15,2 |
| **< $10/g** | 920 | **40,5%** | 460 | 11 | $17,6 |
| $10–50/g | 422 | 18,6% | 160 | 14 | $25,9 |
| $50–150/g | 113 | 5,0% | 48 | 10 | $14,8 |
| $150–500/g | 9 | 0,4% | 6 | 4 | $21,9 |
| **$500+/g** | 28 | 1,2% | 5 | 3 | **$1.508** |

**Il 75% della loro attività misurabile sta sotto i $10/giorno di montepremi, e un terzo su mercati che
non pagano affatto.** Un pavimento a $25 li avrebbe esclusi dal 93% di quello che fanno.

E dove i mercati sono davvero ricchi ($500+), **si presentano con ordini da $1.508 di nozionale
mediano** — cinquanta volte i nostri. Lì il nostro modello ha ragione: non è un mercato per noi.

---

## Fase 1 · Le distribuzioni

### Sul campione completo — da NON usare, e perché è qui

| fascia | fill | quota | mercati | noz med | size med | prezzo | ¢ dal mid | wallet |
|---|---|---|---|---|---|---|---|---|
| < $10 | 63.465 | 97,2% | 21.106 | $21,7 | 54,0 | 0,490 | 0,55 | 21 |
| $10–50 | 611 | 0,9% | 222 | $28,2 | 64,8 | 0,480 | 1,27 | 17 |
| $50–150 | 175 | 0,3% | 82 | $15,7 | 40,0 | 0,480 | 1,50 | 16 |
| $150–500 | 95 | 0,1% | 41 | $34,8 | 94,3 | 0,425 | 1,00 | 15 |
| $500+ | 962 | 1,5% | 154 | $55,8 | 161,9 | 0,460 | 1,50 | 16 |

Il «97,2% sotto i $10» **non è un risultato**: è quasi interamente l'effetto dei mercati chiusi letti
come zero. La riporto perché è esattamente la tabella che avrei pubblicato senza il controllo, ed è
il modo in cui l'errore si ripresenterebbe.

### Cosa sopravvive alla chiusura, e cosa no

Solo il montepremi viene azzerato. Gli altri campi reggono, quindi le conclusioni del manuale v2 che
ne dipendono restano valide:

| campo | presente sugli aperti | presente sui chiusi |
|---|---|---|
| `maxSpread` (banda) | 3.947/3.947 — mediana 4,5¢ | 24.187/24.187 — mediana 4,5¢ |
| `minSize` | 3.947/3.947 | 24.187/24.187 |
| `tick` | 3.947/3.947 | 24.187/24.187 |
| **`rewardsDailyRate`** | **63,2%** | **2,0%** |

La scadenza breve (mediana 0,44 g) era già stata verificata contro il `closedTime` vero, non contro
`endDate`: **quella conclusione non è toccata da questa scoperta.**

---

## Fase 2 · Le cinque ipotesi

Tutte valutate, dove possibile, sul campione pulito dei mercati ancora aperti. Dove ho dovuto usare
quello contaminato, lo dico.

### A · TIMING — entrano appena il mercato apre? **SMENTITA**

Frazione della vita del mercato già trascorsa al primo fill:

| | n | Q1 | mediana | Q3 |
|---|---|---|---|---|
| mercati ricchi | 89 | 0,79 | **0,85** | 0,96 |
| mercati poveri | 3.241 | 0,30 | **0,70** | 0,93 |

Entrano **tardi**, non presto — e sui ricchi ancora più tardi che sui poveri. L'ipotesi che l'anzianità
nel book li favorisca non regge: arrivano quando l'85% della vita del mercato è passata. *(Campione
contaminato: la fascia «ricco» viene dal 2% sopravvissuto.)*

### B · SIZE — sui ricchi alzano la size? **DEBOLE, e dipende da chi**

Sul campione contaminato sembrava netta: 16 wallet su 18 con nozionale maggiore sui ricchi, rapporto
mediano ×2,10. **Sul campione pulito si sgonfia:** $18,1 mediani sui poveri contro $25,1 sui ricchi, e
per wallet è 6 in su contro 4 in giù.

| wallet | poveri | ricchi (≥$50/g) | rapporto |
|---|---|---|---|
| Gurupolimarket | $0,1 | $2,6 | ×25,8 |
| **lmtscapt** | $180,4 | **$1.769,8** | **×9,8** |
| cedrocoffee | $14,0 | $29,3 | ×2,1 |
| 0xF0e02A54 | $16,0 | $31,0 | ×1,9 |
| 7zhfr68… | $3,9 | $7,2 | ×1,9 |
| Flashwhisky | $9,4 | $10,4 | ×1,1 |
| superstonksbro | $26,3 | $25,9 | ×1,0 |
| Nopants | $19,1 | $15,7 | ×0,8 |
| jjjjjsda | $14,5 | $1,7 | ×0,1 |
| alvaro25011 | $33,4 | $3,0 | ×0,1 |

**Non è una regola del gruppo: è il comportamento di pochi.** Ma dove si vede, si vede enorme —
lmtscapt mette $1.770 per ordine sui mercati ricchi. È coerente con la fascia $500+ della tabella
pulita ($1.508 mediani, 3 wallet, 5 mercati): **sui mercati davvero ricchi entra solo chi può mettere
migliaia di dollari per ordine.**

### C · SELEZIONE FRA I RICCHI — vanno sui meno affollati? **NON VERIFICABILE**

Il campione di affollamento che ho (dal manuale v1) copre 118 mercati, di cui **solo 2 ricchi**. I due
mostrano 48 wallet distinti mediani contro 110 dei poveri, ma su due punti non si conclude niente.
Servirebbe un campionamento nuovo mirato ai mercati ricchi — non l'ho fatto, è fuori dallo scope di
sola lettura sui dati esistenti.

### D · VELOCITÀ / ORE VUOTE — coprono le ore in cui la concorrenza dorme? **INDIZIO DEBOLE A FAVORE**

Quota dei fill nelle ore 02–07 UTC: **18,4% sui ricchi contro 13,4% sui poveri**. La direzione è
quella dell'ipotesi, l'ampiezza è modesta e il campione dei ricchi è quello contaminato.

### E · NESSUN SEGRETO / CONFONDENTE — **il ρ non è spiegato dalla scadenza, ma poggia sul nulla**

Correlazioni di rango su n=15 (i wallet con capitale ricostruibile):

```
rho(premio, resa)      = +0,336
rho(premio, scadenza)  = −0,293
rho(resa, scadenza)    = +0,068
correlazione PARZIALE premio↔resa controllando la scadenza = +0,373
```

Quindi **no, non è la scadenza a confondere**: controllando per essa la correlazione sale leggermente.

Ma è fragile in due modi. Togliendo un wallet alla volta oscilla fra **+0,182** (senza LondonBridge) e
**+0,499** (senza 0xA19df895…): un singolo punto la muove di un terzo. E soprattutto il `premioMediano`
di ciascun wallet è calcolato sul 2% sopravvissuto — **la variabile indipendente non misura quello che
dice di misurare.** Il ρ +0,34 non va usato per nessuna decisione.

---

## Fase 3 · Da dove nasce davvero il nostro $0,00

Ho decomposto il piano da $620 con il pavimento acceso, riga per riga. **Il $0,00 non è un verdetto
economico sui mercati ricchi: sono tre cose diverse, e due sono meccaniche.**

### La causa principale: il totale legge un offset diverso da quello a cui il piano piazza

`allocator.js` costruisce la stima realistica per OGNI tick, poi il totale prende
`realisticByTick.find(x => x.tick === r.computedDefaultOffsetTicks)`. Ma il piano piazza a
`offsetCents`, che può essere un altro tick.

| riga | mid | piazza a | totale legge tick | realistico a tick 0 / 1 / 2 |
|---|---|---|---|---|
| $108 | 0,830 | **1¢** | **2** | $2,99 / **$0,20** / **$0,00** |
| $132 | 0,645 | **1¢** | **2** | $5,13 / **$1,06** / **$0,00** |
| $372 | 0,942 | 0,1¢ | 1 | $0,00 / $0,00 / $0,00 |

Le prime due righe valgono **$1,26/g** all'offset a cui il piano davvero piazza, e **$8,12/g** al mid.
Il totale le conta **zero** perché legge il tick 2, dove la stima è effettivamente nulla. `unknown` non
scatta, perché `hit.realisticPerDay == null` è falso per uno zero: **uno zero calcolato su un offset
che non useremo entra nel totale come se fosse un fatto.**

### Il crollo per tick è reale, ed è la cosa da sapere

Su una banda di 4,5¢ la semiampiezza è v = 2,25¢ e il punteggio pubblicato è S = ((v−s)/v)²:

| offset | S | quota del lordo che sopravvive |
|---|---|---|
| 0¢ (sul mid) | 1,000 | 56–81% |
| **1¢** | **0,309** | **4–17%** |
| 2¢ | 0,012 | 0% |

**A due tick dal mid il nostro modello dice zero, e non è un'esagerazione: è l'algebra della formula
pubblicata.** La sensibilità all'offset è il fatto più importante emerso da questa indagine, e vale
indipendentemente dal montepremi.

### La terza riga: $372 (il 61% del capitale) su un mercato senza dati

`tick: null`, `defaultReason: 'fallback: dati insufficienti'`, **0 fill osservati**, lordo $0,00 a ogni
tick — eppure il knapsack le assegna la fetta più grossa sulla base di un `grossPerDay` di $12,01
calcolato altrove. Qui il modello di realismo ha ragione a non attribuire niente; il problema è a
monte, in chi alloca.

---

## La risposta alla domanda

**(c) dipende — ma non dalle condizioni che immaginavamo.**

1. **Il crollo a $0,00 è in larga parte un artefatto di aggregazione**, non un giudizio sui mercati
   ricchi. Alle stesse righe, all'offset che useremmo davvero, il modello attribuisce $1,26/g.
2. **Dove i mercati sono davvero ricchi il modello ha ragione.** Nella fascia $500+ chi ci lavora mette
   $1.508 di nozionale mediano per ordine. Con $620 totali non è una gara che possiamo fare, e il
   modello che ce lo dice non è pessimista: è informato.
3. **La premessa «loro guadagnano sui ricchi» non regge.** Il 75% della loro attività misurabile sta
   sotto i $10/giorno, un terzo su mercati che non pagano nulla. Il ρ +0,34 poggia su una variabile
   misurata sul 2% dei casi.

Il pavimento a $25 non ci escludeva dai mercati sbagliati: ci escludeva dalla fascia in cui i maker che
guadagnano passano quasi tutto il loro tempo.

---

## Proposte — decisione tua, motore intatto

Nessuna di queste è stata applicata.

**1 · Lasciare spento il pavimento sul montepremi, e togliere $25 come numero di riferimento.** Non è
sostenuto: la misura che lo generava è viziata. Se un pavimento serve, va ricavato dai mercati *aperti*
e sarà molto più basso — la mediana pulita del loro lavoro sta sotto i $10.

**2 · Guardare il disallineamento fra `offsetCents` e `computedDefaultOffsetTicks`.** È l'unica cosa in
questa indagine che sembra un difetto vero e non una scelta: il totale che governa il trigger di
riallocazione descrive un offset a cui non piazziamo. Prima di cambiarlo servirebbe capire perché i due
divergono — `defaultReason: 'net-derived'` suggerisce che il default venga da un'ottimizzazione sul
netto misurato, quindi potrebbe essere il totale a essere giusto e il piano a piazzare male.

**3 · Guardare l'allocazione da $372 a un mercato con zero dati.** Il 61% del capitale su una riga con
`fallback: dati insufficienti` è il rischio più concreto emerso oggi, e non c'entra col montepremi.

**4 · Se si vuole misurare davvero il montepremi dei loro mercati**, serve catturarlo **mentre sono
aperti**: un raccoglitore che campiona `rewardsDailyRate` dei mercati vivi e lo archivia. Retroattivamente
quel dato non esiste più.

**5 · Rivedere il manuale v2** dove usa il montepremi (la riga «$47/g mediano», il ρ +0,34, la voce
«filtro montepremi» della lista priorità). Il resto — scadenza, size, distanza dal mid, banda, chiusura
a redeem — non dipende dal campo azzerato e resta in piedi.

---

## Limiti di metodo

1. **Il montepremi storico non è recuperabile.** Tutte le analisi per fascia sui mercati chiusi sono
   inutilizzabili; quelle sui mercati aperti poggiano su 2.270 fill dei ~65.000 totali (3,5%).
2. **Il campione «aperto» non è casuale**: sono i mercati che i 21 hanno toccato e che *non si sono
   ancora risolti*, cioè i più lunghi del loro repertorio. Rappresentano male chi lavora a 5 minuti.
3. **L'affollamento sui ricchi non è misurato** (2 mercati su 118). L'ipotesi C resta aperta.
4. **Le correlazioni sono su n=15**, senza test di significatività, e con la variabile indipendente
   viziata. Sono indizi ordinati, non prove.
5. **La decomposizione della Fase 3 è su 3 righe** di un piano da $620 in un istante. Con il pavimento
   spento le righe erano 7 e il totale $4,85/g: non ho ripetuto la decomposizione su quelle.
6. **Il confronto «loro $1.508 contro noi»** mette a fianco due cose non identiche: il loro è nozionale
   per fill eseguito, il nostro è capitale allocato per mercato. La profondità a riposo — quella che i
   reward pagano davvero — resta invisibile da entrambe le parti (limite già dichiarato nel manuale v2).
7. **`closed` viene dallo stesso Gamma** che azzera il montepremi. Se il campo fosse a sua volta
   inaffidabile, la partizione aperti/chiusi lo sarebbe. Non l'ho verificato contro una seconda fonte.

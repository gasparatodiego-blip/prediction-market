# Perché le stime sovrastimano del 465% — diagnosi, 12 agosto 2026

**Solo diagnosi. Nessuna formula è stata modificata**: la causa è un'assunzione strutturale del modello,
e la decisione su come tararla è dell'operatore.

---

## 1 · Il fatto

Il registro reward (blocco B) dà il primo confronto vero:

| giorno | stima | reale | scarto |
|---|---|---|---|
| 2026-08-06 | $3,09 | $1,3042 | +137% |
| 2026-08-07 | $0 | $0 | — |
| **2026-08-08** | **$49,17** | **$3,6792** | **+1236%** |
| 2026-08-09 | *(non registrata)* | $8,3524 | — |
| 2026-08-10 | $0 | $4,2525 | −100% |
| 2026-08-11 | $0 | $0 | — |
| **totale confrontabile** | **$52,26** | **$9,2359** | **+465,84%** |

**L'8 agosto è il 94% dell'intera stima confrontabile** ($49,17 su $52,26). Qualunque cosa spieghi
quel giorno spiega lo scarto aggregato.

---

## 2 · La causa dominante: la stima è un TASSO ISTANTANEO letto come QUANTITÀ GIORNALIERA

`estimatedOperatorSharePerDay` (`lib/reward-operator-estimate.js`) calcola

```
estUsdPerDay = poolGiornaliero × quota
```

dove `quota` è la frazione del pool che il nostro capitale **in banda in quel momento** si prenderebbe.
È un **tasso**: «se le cose restassero così, in 24 ore incasseresti tanto».

`buildSummary` lo fotografa **una volta**, alle 23:55, sugli ordini vivi **in quell'istante**
(`agent40`, `compitiDovuti.stima`), e `confronto-reward` lo confronta con il bonifico della giornata —
cioè con una **quantità realizzata su 24 ore**.

**Le due grandezze non sono confrontabili se l'ordine non è rimasto vivo tutto il giorno.**

### La misura, sui tre mercati dell'8 agosto

La stima delle 23:55:01 elenca esattamente tre mercati:

| mercato | capitale in banda | `estUsdPerDay` |
|---|---|---|
| Paris 19°C | $32,16 | $11,76 |
| London 19°C | $27,67 | $12,22 |
| Tokyo 25°C | $37,28 | $25,20 |
| | **$97,11** | **$49,17** |

Cercati nel giornale maker, i loro ordini **non esistono prima delle 21:42:16 di quel giorno**: il primo
`sent` sui tre mercati è alle `2026-08-08T21:42:16.686Z`, e prima di quell'ora ci sono solo rifiuti
(`reject-manual-mode-inactive` dalle 20:56, poi `reject-live-min-market-mismatch`).

```
finestra reale dei tre mercati l'8 agosto:  21:42:16 → 23:59:22  =  2,28 ore
frazione di giornata:                        2,28 / 24            =  9,5%
```

### Il conto corretto

```
$49,17/giorno × 9,5%  =  $4,67 attesi   contro   $3,68 incassati   ⇒  +27%
```

**Da +1236% a +27%.** La sola assunzione di durata spiega **$44,50 dei $45,49** di scarto dell'8 agosto,
cioè il **97,8%**. E poiché l'8 agosto è il 94% della stima totale, spiega la gran parte del 465%
aggregato.

**Sì: una sola causa spiega la gran parte dello scarto.**

---

## 3 · Le altre ipotesi, verificate e scartate

Ognuna è stata controllata sul codice e sui dati, non assunta.

**(a) La formula ignora i concorrenti reali in banda? NO.**
`quota` viene da `rewardScore.refShare`, che è la quota calcolata con la formula quadratica del venue
`S(v,s)=((v−s)/v)²` contro la concorrenza misurata. E c'è già una seconda correzione: se la profondità
in banda misurata è minore del capitale di riferimento, la quota viene **riscalata esattamente**
(`r·share / (r·share + (1−share))`), perché a quella size «saresti tu il book». I concorrenti sono
contati due volte, non zero.

**(b) Gli ordini fuori banda vengono contati come premianti? NO.**
`buildSummary` somma solo `o.inBand === true`. Un ordine non giudicabile (`inBand === null`) finisce in
`unjudgeableUsd` e non entra mai nella stima. Il commento del modulo lo dichiara: *«out-of-band capital
contributes exactly zero»*.

**(c) Il pool viene diviso su un numero di partecipanti sbagliato? NON RILEVANTE QUI.**
Il pool è quello pubblicato dal venue e la quota è quella scorata; l'errore, se c'è, sarebbe di secondo
ordine rispetto a un fattore 10,5× di durata.

**(d) La stima si basa su mercati poi non quotati per «mai primo» o non quotabilità? NO, per costruzione.**
La stima si calcola sugli **ordini a riposo veri** letti dal venue (`buildOrderBoard`), non sui candidati
del piano. Un mercato mai quotato non ha ordini e non contribuisce. *(Il filtro di quotabilità del blocco
B agisce sul PIANO, che è un'altra grandezza: quello riguarda il capitale che resta fermo, non lo scarto
stima↔consuntivo.)*

**(e) Il minimo del venue viene ignorato? NO.** `minSizeVerdict` restituisce zero — non «ignoto» — sotto
`min_incentive_size`, prima di qualunque riscalatura.

---

## 4 · ⚠ È un'assunzione STRUTTURALE, non un parametro da ritoccare

Non esiste una costante sbagliata da correggere. Il modello risponde correttamente a **«a che tasso sto
maturando adesso?»**; la domanda del confronto è **«quanto ho maturato ieri?»**. Sono due domande
diverse, e nessuna taratura della quota le riconcilia.

Per questo mi fermo qui, come da istruzione.

### Le opzioni, con i numeri

**Opzione A — integrare il tasso nel tempo (la più corretta).**
Invece di una fotografia alle 23:55, si campiona il tasso durante la giornata e si integra:
`Σ (tasso_i × durata_i)`. La materia prima esiste già: `buildSummary` gira a ogni ciclo di agent40, e il
giornale maker registra ogni piazzamento e ogni cancellazione.
*Costo*: un registro nuovo (un campione ogni N minuti per giornata) e la sua persistenza.
*Effetto sull'8 agosto*: $49,17 → ~$4,67, cioè lo scarto scende da +1236% a +27%.

**Opzione B — pesare la fotografia per la copertura della giornata.**
Si tiene la fotografia unica e la si moltiplica per la frazione di giornata in cui c'erano ordini vivi,
ricavabile dal giornale. Molto più economica di A.
*Limite dichiarato*: assume che il tasso dell'istante 23:55 valga per tutte le ore coperte — falso se il
book cambia. Sull'8 agosto darebbe lo stesso $4,67 perché la finestra è contigua; su una giornata a
finestre sparse sarebbe peggiore di A.

**Opzione C — non confrontare le due grandezze, e dirlo.**
Si smette di chiamare «stima» ciò che è un tasso: il registro mostrerebbe `$/giorno al momento X` accanto
all'incassato, senza calcolare uno scarto percentuale che confronta mele con arance.
*Costo*: zero codice di modello. *Prezzo*: si rinuncia a sapere se la stima è tarata bene.

**Opzione D — lasciare tutto e annotare il fattore.**
Sui dati attuali il fattore di conversione è la copertura di giornata. Non è un numero stabile: dipende
da quanto il bot resta acceso.

### Il residuo del 27%

Anche corretta la durata, resta un +27% sull'8 agosto. Su un solo giorno e $1 di differenza assoluta non
è distinguibile dal rumore (arrotondamenti del venue, il confine di mezzanotte, la quota che cambia
durante le 2,28 ore). **Serve più di una giornata confrontabile per dire se esiste un secondo difetto**,
ed è la ragione per cui non propongo di inseguirlo adesso.

---

## 5 · Una nota sul 10 agosto, che va nella direzione opposta

Il 10 agosto la stima è **$0** e l'incassato **$4,25**: una **sotto**stima del 100%. La causa è
speculare: alle 23:55 di quel giorno non c'erano ordini vivi (il bot era stato fermato in mattinata, la
finestra di attività è 00:00→06:00), quindi la fotografia ha visto zero — mentre le prime sei ore avevano
prodotto reward veri.

**È la stessa causa, con il segno invertito**, e conferma la diagnosi: il problema non è la quota, è che
si fotografa un istante e lo si legge come una giornata.
